// ============================================================
// Een webhook BEZORGEN: het ene stuk dat naar buiten belt.
//
// Gedeeld door de cron-dispatcher (functie `webhooks`) en de testknop (functies
// `api-admin` en `api`), zodat een testbericht precies zo ondertekend, verstuurd
// en vastgelegd wordt als een echt bericht. Een testknop die anders werkt dan
// het echte werk, test iets anders dan wat er misgaat.
//
// De rekensommen (handtekening, adressen, herhaalschema) staan puur in
// webhooks.ts; dit bestand doet wat daar niet kan: de database, de klok en het
// netwerk.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { RESOURCE_LIST } from './apiResourceSpecs.ts';
import { effectiveModuleLevel } from './publicApi.ts';
import {
  decryptSecret, isIpLiteral, isPrivateAddress, MAX_DELIVERY_ATTEMPTS, nextRetryDelay, parseDohAnswer, PING_EVENT,
  signatureHeader, signPayload, webhookBody, webhookUrlProblem,
} from './webhooks.ts';
import { pinnedTransport, TransportError, type PinnedResponse, type WebhookTransport } from './webhookTransport.ts';

/** Hoe lang we op een eindpunt wachten. Wie langer nodig heeft, hoort eerst te antwoorden en daarna te werken. */
const TIMEOUT_MS = 10_000;

/** Hoeveel van het antwoord we bewaren (tekens), om bij een fout te kunnen zien wat het eindpunt zei. */
const RESPONSE_PREVIEW_BYTES = 1000;

/** Zoveel bytes lezen we er hooguit voor: genoeg voor 1000 tekens, ook in UTF-8. */
const RESPONSE_READ_BYTES = 4 * RESPONSE_PREVIEW_BYTES;

/** Bij "geen verbinding" proberen we hooguit zoveel adressen van dezelfde naam. */
const MAX_ADDRESSES_TRIED = 3;

const USER_AGENT = 'ResoFly-Webhooks/1.0 (+https://resofly.nl)';

/** Eén geclaimde bezorging, zoals claim_webhook_deliveries hem teruggeeft. */
export interface ClaimedDelivery {
  delivery_id: string;
  endpoint_id: string;
  organization_id: string;
  attempts: number;
  url: string;
  api_key_id: string | null;
  secret_encrypted: string | null;
  event_id: string;
  event_type: string;
  event_module: string;
  event_payload: Record<string, unknown>;
  event_created_at: string;
}

export interface DeliveryOutcome {
  status: 'delivered' | 'retrying' | 'failed' | 'skipped';
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}

/**
 * Wat een sleutel mag, onthouden binnen één ronde. Tien bezorgingen voor
 * hetzelfde eindpunt hoeven niet tien keer dezelfde sleutel op te zoeken.
 */
export type KeyAccessCache = Map<string, { ok: false; reason: string } | { ok: true; role: string; memberAccess: Record<string, unknown>; keyAccess: Record<string, unknown> }>;

export interface DeliverOptions {
  encryptionKey: string;
  keyCache?: KeyAccessCache;
  /** Een testbericht: geen nieuwe poging bij een fout, maar wel vastgelegd. */
  noRetry?: boolean;
  /** Hoe het bericht verstuurd wordt; standaard over een vastgepinde verbinding. Voor tests. */
  transport?: WebhookTransport;
  /** Hoe een naam wordt opgezocht; standaard resolveForDelivery. Voor tests. */
  resolve?: (host: string) => Promise<string[]>;
}

/**
 * Bezorgt één bericht en legt de uitkomst vast. Gooit niet: alles wat misgaat,
 * eindigt als een vastgelegde uitkomst — anders blijft een bezorging op
 * 'sending' hangen tot de volgende ronde hem na vijf minuten terugpakt.
 */
export async function deliver(admin: SupabaseClient, delivery: ClaimedDelivery, options: DeliverOptions): Promise<DeliveryOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  try {
    // 1. Mag dit eindpunt deze gebeurtenis horen? Alleen een eindpunt van een
    //    API-sleutel kan "nee" krijgen: dan gelden de rechten van die sleutel,
    //    van NU — net als bij een gewone API-aanroep.
    let payload = delivery.event_payload;
    if (delivery.api_key_id && delivery.event_type !== PING_EVENT) {
      const access = await keyAccess(admin, delivery.api_key_id, options.keyCache);
      const reason = keyRefusal(access, delivery.event_module);
      if (reason) {
        await skip(admin, delivery.delivery_id, reason);
        return { status: 'skipped', httpStatus: null, error: reason, durationMs: elapsed() };
      }
      // Een veld uit een module die de sleutel niet mag lezen (een tarief bij
      // Financiën), gaat ook hier als null mee — net als via de API. Veranderde
      // er alleen zo'n veld, dan is er voor deze sleutel niets gebeurd.
      const canRead = (module: string) => access.ok && effectiveModuleLevel(access.role, access.memberAccess, access.keyAccess, module) !== 'none';
      const redacted = redactForKey(delivery.event_type, payload, canRead);
      if (!redacted) {
        const why = 'Alleen velden veranderden die de API-sleutel van dit eindpunt niet mag lezen.';
        await skip(admin, delivery.delivery_id, why);
        return { status: 'skipped', httpStatus: null, error: why, durationMs: elapsed() };
      }
      payload = redacted;
    }

    // 2. Waar gaat het naartoe? Het adres zelf, en waar de naam NU naar wijst.
    //    Een naam die bij het aanmaken naar buiten wees, kan nu naar binnen
    //    wijzen: dan zetten we het eindpunt uit in plaats van het acht keer te
    //    proberen. De adressen die hier worden goedgekeurd, zijn ook de ENIGE
    //    waarmee we verbinden (webhookTransport.ts) — er wordt niet nog eens
    //    opgezocht, dus een naam die tussendoor omslaat, komt niet binnen.
    let target: Awaited<ReturnType<typeof deliveryTarget>>;
    try {
      target = await deliveryTarget(delivery.url, options.resolve);
    } catch (error) {
      // Het opzoeken lukte niet op tijd: niet blind versturen, maar later opnieuw.
      return await failed(admin, delivery, options, null, error instanceof Error ? error.message : String(error), null, elapsed);
    }
    if ('problem' in target) {
      if (!target.disable) return await failed(admin, delivery, options, null, target.problem, null, elapsed);
      await finish(admin, delivery.delivery_id, { ok: false, error: target.problem, retryIn: null, disable: target.problem });
      return { status: 'failed', httpStatus: null, error: target.problem, durationMs: elapsed() };
    }

    if (!delivery.secret_encrypted) {
      const error = 'Dit eindpunt heeft geen ondertekengeheim. Vernieuw het geheim in Instellingen → API & webhooks.';
      await finish(admin, delivery.delivery_id, { ok: false, error, retryIn: null });
      return { status: 'failed', httpStatus: null, error, durationMs: elapsed() };
    }
    const secret = await decryptSecret(delivery.secret_encrypted, options.encryptionKey);

    // 3. Ondertekenen en versturen. De tijd zit in de handtekening, zodat een
    //    onderschept bericht niet later opnieuw af te spelen is.
    const body = webhookBody({
      id: delivery.event_id,
      type: delivery.event_type,
      created_at: delivery.event_created_at,
      organization_id: delivery.organization_id,
      data: payload,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signatureHeader(timestamp, await signPayload(secret, timestamp, body));

    // Een doorverwijzing volgen we niet (dat doet deze verbinding ook niet):
    // dan belde ons verzoek ineens naar een adres dat niemand controleerde.
    let response: PinnedResponse;
    try {
      response = await sendPinned(options.transport ?? pinnedTransport, target, {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'ResoFly-Event': delivery.event_type,
        'ResoFly-Event-Id': delivery.event_id,
        'ResoFly-Delivery-Id': delivery.delivery_id,
        'ResoFly-Signature': signature,
      }, body);
    } catch (error) {
      const message = error instanceof TransportError && error.kind === 'timeout'
        ? `Geen antwoord binnen ${TIMEOUT_MS / 1000} seconden.`
        : `Kon het eindpunt niet bereiken: ${error instanceof Error ? error.message : String(error)}`;
      return await failed(admin, delivery, options, null, message, null, elapsed);
    }

    const preview = previewText(response.body);
    if (response.status >= 200 && response.status < 300) {
      await finish(admin, delivery.delivery_id, { ok: true, httpStatus: response.status, body: preview });
      return { status: 'delivered', httpStatus: response.status, error: null, durationMs: elapsed() };
    }

    // 410: het eindpunt zegt zelf dat het niet meer bestaat. Dan niet nog dagen
    // blijven bellen, maar uitzetten — met de reden erbij, zodat iemand het ziet.
    if (response.status === 410) {
      const reason = 'Het eindpunt antwoordde 410 Gone: dit adres bestaat niet meer. Zet het weer aan als dat niet klopt.';
      await finish(admin, delivery.delivery_id, { ok: false, httpStatus: 410, body: preview, error: 'HTTP 410', retryIn: null, disable: reason });
      return { status: 'failed', httpStatus: 410, error: reason, durationMs: elapsed() };
    }

    const error = response.status >= 300 && response.status < 400
      ? `HTTP ${response.status}: een doorverwijzing volgen we niet. Gebruik het uiteindelijke adres.`
      : `HTTP ${response.status}`;
    return await failed(admin, delivery, options, response.status, error, preview, elapsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[webhooks] bezorging mislukt:', delivery.delivery_id, message);
    return await failed(admin, delivery, options, null, `Bezorgen mislukte aan onze kant: ${message}`, null, elapsed);
  }
}

/** Een mislukte poging: nog een keer volgens het schema, of dit was de laatste. */
async function failed(
  admin: SupabaseClient, delivery: ClaimedDelivery, options: DeliverOptions,
  httpStatus: number | null, error: string, body: string | null, elapsed: () => number,
): Promise<DeliveryOutcome> {
  const retryIn = options.noRetry ? null : nextRetryDelay(delivery.attempts);
  await finish(admin, delivery.delivery_id, { ok: false, httpStatus, body, error, retryIn });
  return { status: retryIn === null ? 'failed' : 'retrying', httpStatus, error, durationMs: elapsed() };
}

async function finish(
  admin: SupabaseClient, deliveryId: string,
  outcome: { ok: boolean; httpStatus?: number | null; body?: string | null; error?: string | null; retryIn?: number | null; disable?: string },
): Promise<void> {
  const { error } = await admin.rpc('finish_webhook_delivery', {
    p_delivery_id: deliveryId,
    p_ok: outcome.ok,
    p_response_status: outcome.httpStatus ?? null,
    p_response_body: outcome.body ?? null,
    p_error: outcome.error ?? null,
    p_retry_in_seconds: outcome.retryIn ?? null,
    p_disable_reason: outcome.disable ?? null,
  });
  if (error) console.error('[webhooks] uitkomst vastleggen mislukt:', deliveryId, error.message);
}

async function skip(admin: SupabaseClient, deliveryId: string, reason: string): Promise<void> {
  const { error } = await admin.from('webhook_deliveries')
    .update({ status: 'skipped', error: reason.slice(0, 500) })
    .eq('id', deliveryId);
  if (error) console.error('[webhooks] overslaan vastleggen mislukt:', deliveryId, error.message);
}

type KeyAccess = NonNullable<ReturnType<KeyAccessCache['get']>>;

/** Wat de sleutel van dit eindpunt NU mag, één keer per ronde opgezocht. */
async function keyAccess(admin: SupabaseClient, keyId: string, cache?: KeyAccessCache): Promise<KeyAccess> {
  let access = cache?.get(keyId);
  if (!access) {
    access = await loadKeyAccess(admin, keyId);
    cache?.set(keyId, access);
  }
  return access;
}

/**
 * Waarom een eindpunt van een API-sleutel deze gebeurtenis NIET mag horen, of
 * null als het mag. Dezelfde regels als een API-aanroep: de sleutel is niet
 * ingetrokken of verlopen, de maker is nog actief lid, en de module van de
 * gebeurtenis staat voor die twee samen niet dicht.
 */
function keyRefusal(access: KeyAccess, module: string): string | null {
  if (!access.ok) return access.reason;
  const level = effectiveModuleLevel(access.role, access.memberAccess, access.keyAccess, module);
  return level === 'none' ? `De API-sleutel van dit eindpunt mag de module "${module}" niet lezen.` : null;
}

/** Per onderwerp de velden die bij een andere module horen, uit de API-specs (`module` op een veld). */
const FIELD_MODULES: Record<string, Record<string, string>> = Object.fromEntries(RESOURCE_LIST.map((spec) => [
  spec.event,
  Object.fromEntries(Object.entries(spec.fields).flatMap(([name, field]) => (field.module ? [[name, field.module]] : []))),
]));

/**
 * Het bericht zoals deze sleutel het mag zien: velden uit een module die hij
 * niet mag lezen, als null in `object`, en weg uit `changed` en `previous`.
 * Null als er daarna niets veranderd blijkt (alleen zulke velden wijzigden).
 */
export function redactForKey(
  eventType: string, payload: Record<string, unknown>, canRead: (module: string) => boolean,
): Record<string, unknown> | null {
  const fields = FIELD_MODULES[eventType.split('.')[0]] ?? {};
  const hidden = Object.keys(fields).filter((name) => !canRead(fields[name]));
  if (hidden.length === 0) return payload;
  const result: Record<string, unknown> = { ...payload };
  const object = payload.object as Record<string, unknown> | undefined;
  if (object && typeof object === 'object') {
    result.object = Object.fromEntries(Object.entries(object).map(([name, value]) => [name, hidden.includes(name) ? null : value]));
  }
  if (Array.isArray(payload.changed)) {
    const changed = (payload.changed as unknown[]).filter((name) => !hidden.includes(String(name)));
    if (changed.length === 0) return null;
    result.changed = changed;
  }
  const previous = payload.previous as Record<string, unknown> | undefined;
  if (previous && typeof previous === 'object') {
    result.previous = Object.fromEntries(Object.entries(previous).filter(([name]) => !hidden.includes(name)));
  }
  return result;
}

async function loadKeyAccess(admin: SupabaseClient, keyId: string): Promise<KeyAccess> {
  const { data: key } = await admin.from('api_keys')
    .select('organization_id, user_id, module_access, expires_at, revoked_at').eq('id', keyId).maybeSingle();
  if (!key || key.revoked_at) return { ok: false, reason: 'De API-sleutel van dit eindpunt is ingetrokken.' };
  if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'De API-sleutel van dit eindpunt is verlopen.' };
  }
  const { data: member } = await admin.from('organization_members')
    .select('role, module_access').eq('organization_id', key.organization_id).eq('user_id', key.user_id)
    .eq('status', 'active').maybeSingle();
  if (!member?.role) return { ok: false, reason: 'Het teamlid achter de API-sleutel van dit eindpunt is geen actief lid meer.' };
  return { ok: true, role: member.role, memberAccess: member.module_access ?? {}, keyAccess: key.module_access ?? {} };
}

/** Zo lang mag het opzoeken van een naam duren, per soort record. */
const DNS_TIMEOUT_MS = 3_000;

/**
 * DNS-over-HTTPS, voor een omgeving zonder eigen DNS-opvraging (Deno.resolveDns
 * bestaat niet in elke Edge-runtime). Twee aanbieders: valt er één uit, dan
 * staan de webhooks niet stil.
 */
const DOH_PROVIDERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];

class DnsTimeout extends Error {
  constructor(host: string) {
    super(`Het adres ${host} kon niet op tijd worden opgezocht (DNS). We proberen het later opnieuw.`);
    this.name = 'DnsTimeout';
  }
}

type DnsType = 'A' | 'AAAA';

/**
 * Waar wijst deze naam NU naartoe? Met de DNS van de runtime als die er is,
 * anders via DNS-over-HTTPS. Gooit DnsTimeout als het niet lukt om het te weten:
 * "geen antwoord" is iets anders dan "geen adressen".
 */
export async function resolveHostAddresses(host: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const native = (globalThis as { Deno?: { resolveDns?: (name: string, type: DnsType) => Promise<string[]> } }).Deno?.resolveDns;
  if (typeof native === 'function') {
    const addresses: string[] = [];
    for (const type of ['A', 'AAAA'] as const) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        addresses.push(...await Promise.race([
          native(host, type),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new DnsTimeout(host)), DNS_TIMEOUT_MS);
          }),
        ]));
      } catch (error) {
        if (error instanceof DnsTimeout) throw error;
        // Geen records van dit type (of de naam bestaat niet): geen adressen.
      } finally {
        clearTimeout(timer);
      }
    }
    return addresses;
  }

  for (const provider of DOH_PROVIDERS) {
    try {
      const addresses: string[] = [];
      for (const type of ['A', 'AAAA'] as const) {
        const response = await fetcher(`${provider}?name=${encodeURIComponent(host)}&type=${type}`, {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        addresses.push(...parseDohAnswer(await response.json(), type));
      }
      return addresses;
    } catch {
      // Volgende aanbieder.
    }
  }
  throw new DnsTimeout(host);
}

/**
 * Vaste antwoorden voor namen die in een testomgeving niet in de DNS staan:
 * `WEBHOOK_DNS_OVERRIDES="hooks.test.nl=203.0.113.10;andere.nl=198.51.100.7"`.
 * Alleen voor lokaal testen. Ook deze adressen gaan langs isPrivateAddress: een
 * naam vastzetten op 127.0.0.1 kan hiermee dus niet.
 */
const DNS_OVERRIDES = parseDnsOverrides(
  (globalThis as { Deno?: { env?: { get?: (name: string) => string | undefined } } }).Deno?.env?.get?.('WEBHOOK_DNS_OVERRIDES'),
);

export function parseDnsOverrides(raw: string | undefined): Map<string, string[]> {
  const overrides = new Map<string, string[]>();
  for (const entry of String(raw || '').split(';')) {
    const [name, list] = entry.split('=');
    const host = String(name || '').trim().toLowerCase().replace(/\.+$/, '');
    const addresses = String(list || '').split(',').map((part) => part.trim()).filter(Boolean);
    if (host && addresses.length > 0) overrides.set(host, addresses);
  }
  return overrides;
}

/** Waar een naam nu naartoe wijst, zoals de bezorging hem opzoekt (met de vaste antwoorden voor tests). */
export async function resolveForDelivery(host: string): Promise<string[]> {
  return DNS_OVERRIDES.get(host) ?? await resolveHostAddresses(host);
}

/**
 * Het doel van een bezorging: de URL en de adressen waarmee we mogen verbinden.
 * Of een probleem, met `disable` als het eindpunt uit moet (het wijst naar
 * binnen) en niet als het later opnieuw kan (de naam heeft nu geen adres).
 *
 * Gooit DnsTimeout als het opzoeken niet lukt: liever een poging later dan
 * versturen zonder te weten waarheen.
 */
export async function deliveryTarget(
  rawUrl: string, resolve: (host: string) => Promise<string[]> = resolveForDelivery,
): Promise<{ url: URL; addresses: string[] } | { problem: string; disable: boolean }> {
  const problem = webhookUrlProblem(rawUrl);
  if (problem) return { problem, disable: true };
  const url = new URL(String(rawUrl).trim());
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  // Een IP-adres in de URL zelf: dat keurde webhookUrlProblem al.
  if (isIpLiteral(host)) return { url, addresses: [host] };
  const addresses = [...new Set((await resolve(host)).map((address) => address.trim().toLowerCase()).filter(Boolean))];
  if (addresses.some(isPrivateAddress)) {
    return { problem: `${host} wijst naar een intern adres. Webhooks gaan alleen naar adressen die vanaf internet bereikbaar zijn.`, disable: true };
  }
  if (addresses.length === 0) {
    return { problem: `${host} heeft nu geen IP-adres (DNS). Klopt de naam? We proberen het later opnieuw.`, disable: false };
  }
  // IPv4 eerst: niet elke runtime komt via IPv6 naar buiten.
  return { url, addresses: [...addresses.filter((a) => !a.includes(':')), ...addresses.filter((a) => a.includes(':'))] };
}

/**
 * Verstuurt naar de goedgekeurde adressen, één voor één zolang er geen
 * verbinding komt. Een eindpunt dat wel opnam maar een fout gaf, krijgt geen
 * tweede bericht via een ander adres. Alles samen binnen TIMEOUT_MS.
 */
async function sendPinned(
  transport: WebhookTransport, target: { url: URL; addresses: string[] }, headers: Record<string, string>, body: string,
): Promise<PinnedResponse> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError: unknown = null;
  for (const address of target.addresses.slice(0, MAX_ADDRESSES_TRIED)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await transport({ url: target.url, address, headers, body, timeoutMs: remaining, maxBodyBytes: RESPONSE_READ_BYTES });
    } catch (error) {
      lastError = error;
      if (!(error instanceof TransportError && error.kind === 'connect')) throw error;
    }
  }
  throw lastError ?? new TransportError(`Geen antwoord binnen ${TIMEOUT_MS / 1000} seconden.`, 'timeout');
}

/**
 * Voor het aanmaken en wijzigen van een eindpunt: het adres zelf, en waar de
 * naam nu naartoe wijst. Lukt het opzoeken niet, of heeft de naam (nog) geen
 * adres, dan geen oordeel — bij elke bezorging wordt opnieuw gekeken, en dan
 * wordt er niet blind verstuurd.
 */
export async function webhookAddressProblem(
  rawUrl: string, resolve: (host: string) => Promise<string[]> = resolveForDelivery,
): Promise<string | null> {
  try {
    const target = await deliveryTarget(rawUrl, resolve);
    return 'problem' in target && target.disable ? target.problem : null;
  } catch {
    return null;
  }
}

/** Het begin van het antwoord als tekst, of null als er niets was. */
function previewText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  const text = new TextDecoder().decode(bytes).slice(0, RESPONSE_PREVIEW_BYTES);
  return text || null;
}

/**
 * Het testbericht van de knop "Testen": een `ping`, meteen bezorgd in plaats van
 * via de cron, zodat de gebruiker het antwoord van zijn eindpunt ziet terwijl hij
 * nog naar het scherm kijkt. Zelfde handtekening, zelfde log.
 */
export async function sendTestEvent(
  admin: SupabaseClient, endpoint: { id: string; organization_id: string; url: string; api_key_id: string | null },
  options: { encryptionKey: string; sentBy: string },
): Promise<DeliveryOutcome & { deliveryId: string; eventId: string }> {
  const { data: secretRow, error: secretError } = await admin.from('webhook_endpoint_secrets')
    .select('secret_encrypted').eq('endpoint_id', endpoint.id).maybeSingle();
  if (secretError) throw new Error(`Geheim ophalen mislukt: ${secretError.message}`);

  const payload = {
    message: 'Dit is een testbericht van ResoFly. Klopt de handtekening, dan is je eindpunt goed ingesteld.',
    endpoint_id: endpoint.id,
    sent_by: options.sentBy,
  };
  const { data: event, error: eventError } = await admin.from('webhook_events').insert({
    organization_id: endpoint.organization_id, type: PING_EVENT, entity: PING_EVENT, module: PING_EVENT, payload,
  }).select('id, created_at').single();
  if (eventError || !event) throw new Error(`Testbericht klaarzetten mislukt: ${eventError?.message ?? 'onbekende fout'}`);

  const { data: delivery, error: deliveryError } = await admin.from('webhook_deliveries').insert({
    organization_id: endpoint.organization_id, endpoint_id: endpoint.id, event_id: event.id,
    status: 'sending', attempts: 1, last_attempt_at: new Date().toISOString(),
  }).select('id').single();
  if (deliveryError || !delivery) throw new Error(`Testbericht klaarzetten mislukt: ${deliveryError?.message ?? 'onbekende fout'}`);

  const outcome = await deliver(admin, {
    delivery_id: delivery.id,
    endpoint_id: endpoint.id,
    organization_id: endpoint.organization_id,
    attempts: MAX_DELIVERY_ATTEMPTS,
    url: endpoint.url,
    api_key_id: endpoint.api_key_id,
    secret_encrypted: secretRow?.secret_encrypted ?? null,
    event_id: event.id,
    event_type: PING_EVENT,
    event_module: PING_EVENT,
    event_payload: payload,
    event_created_at: event.created_at,
  }, { encryptionKey: options.encryptionKey, noRetry: true });
  return { ...outcome, deliveryId: delivery.id, eventId: event.id };
}
