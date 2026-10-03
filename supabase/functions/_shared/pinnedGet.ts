// ============================================================
// Iets OPHALEN van een adres dat iemand van buiten opgaf (een agenda-link),
// over een verbinding die vastligt op een gecontroleerd IP-adres.
//
// Dezelfde bescherming als bij webhooks (webhookTransport.ts). fetch() zou de
// naam zelf nog eens opzoeken: een DNS-server die bij onze controle een
// openbaar adres geeft en bij het ophalen 127.0.0.1 of 169.254.169.254
// (DNS-rebinding), glipt dan langs de controle — en wat daar antwoordt, komt in
// de agenda van de aanvrager terecht. Hier: één keer opzoeken, ELK adres keuren,
// en dan precies met zo'n adres verbinden. TLS controleert het certificaat nog
// steeds tegen de naam (SNI).
//
// Lukt het opzoeken niet, dan wordt er niet opgehaald: liever later opnieuw dan
// blind. Puur op de afhankelijkheden na, die worden meegegeven — zo is het los
// te testen (pinnedGet.test.ts).
// ============================================================

import { TransportError, type PinnedResponse, type WebhookTransport } from './webhookTransport.ts';

export interface PinnedGetOptions {
  headers: Record<string, string>;
  /** Hoe lang het geheel mag duren, over alle adressen samen. */
  timeoutMs: number;
  /** Zoveel bytes inhoud lezen we hooguit. */
  maxBodyBytes: number;
  /** Zoekt een naam op. Gooit als dat niet lukt (dan niet ophalen). */
  resolve: (host: string) => Promise<string[]>;
  /** Mag er met dit adres verbonden worden? (niets privé, loopback, link-local, …) */
  isAllowedAddress: (address: string) => boolean;
  transport: WebhookTransport;
}

/** Zoveel adressen van één naam proberen we, als er met de eerste geen verbinding komt. */
const MAX_ADDRESSES_TRIED = 4;

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** De adressen waarmee we voor deze URL mogen verbinden. Gooit, met een zin voor mensen, als het niet mag. */
export async function vettedAddresses(
  url: URL, options: Pick<PinnedGetOptions, 'resolve' | 'isAllowedAddress'>,
): Promise<string[]> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) throw new Error('De link mist een hostnaam.');
  if (isIpLiteral(host)) {
    if (!options.isAllowedAddress(host)) throw new Error('Deze link verwijst naar een intern of gereserveerd adres.');
    return [host];
  }
  let found: string[];
  try {
    found = await options.resolve(host);
  } catch {
    throw new Error(`${host} kon nu niet worden opgezocht. Probeer het later opnieuw.`);
  }
  const addresses = [...new Set(found.map((address) => address.trim().toLowerCase()).filter(Boolean))];
  if (addresses.length === 0) throw new Error(`${host} heeft geen IP-adres (DNS). Klopt de link?`);
  // Eén intern adres is genoeg om te weigeren: welk adres we krijgen, bepaalt de DNS-server.
  if (addresses.some((address) => !options.isAllowedAddress(address))) {
    throw new Error('Deze link verwijst (via DNS) naar een intern adres.');
  }
  // IPv4 eerst: niet elke runtime komt via IPv6 naar buiten.
  return [...addresses.filter((a) => !a.includes(':')), ...addresses.filter((a) => a.includes(':'))];
}

/**
 * Een GET naar `url`, verbonden met een gekeurd adres. Komt er met een adres
 * geen verbinding, dan het volgende; een adres dat wel antwoordde, is het
 * antwoord. Redirects volgt dit niet: dat doet de aanroeper, die elke nieuwe
 * URL eerst opnieuw keurt.
 */
export async function pinnedGet(url: URL, options: PinnedGetOptions): Promise<PinnedResponse & { address: string }> {
  const addresses = await vettedAddresses(url, options);
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown = null;
  for (const address of addresses.slice(0, MAX_ADDRESSES_TRIED)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await options.transport({
        url, address, method: 'GET', headers: options.headers, body: '', timeoutMs: remaining, maxBodyBytes: options.maxBodyBytes,
      });
      return { ...response, address };
    } catch (error) {
      lastError = error;
      if (!(error instanceof TransportError && error.kind === 'connect')) throw error;
    }
  }
  throw lastError ?? new TransportError(`Geen antwoord binnen ${Math.round(options.timeoutMs / 1000)} seconden.`, 'timeout');
}

/** Wat er na het uitpakken uitkomt, is groter dan de limiet. */
export class ContentTooLargeError extends Error {}

/**
 * Pakt een antwoord uit dat toch gecomprimeerd binnenkwam (gzip of deflate),
 * met een harde limiet op wat eruit komt: een klein gecomprimeerd bestand kan
 * anders tot gigabytes opzwellen. Zonder compressie: ongewijzigd terug.
 */
export async function decodeContentEncoding(body: Uint8Array, encoding: string | null | undefined, maxBytes: number): Promise<Uint8Array> {
  const kind = String(encoding ?? '').trim().toLowerCase();
  if (!kind || kind === 'identity') return body;
  const format = kind === 'gzip' || kind === 'x-gzip' ? 'gzip' : kind === 'deflate' ? 'deflate' : null;
  if (!format) throw new Error(`onbekende compressie "${kind.slice(0, 40)}"`);
  const reader = new Blob([body]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ContentTooLargeError(`meer dan ${maxBytes} bytes na uitpakken`);
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ContentTooLargeError) throw error;
    throw new Error('beschadigd gecomprimeerd bestand');
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { merged.set(part, offset); offset += part.byteLength; }
  return merged;
}
