// ============================================================
// Gedeelde bouwstenen voor uitgaande webhooks: welke gebeurtenissen er zijn,
// hoe een bericht ondertekend wordt, welke adressen er mogen, en hoe vaak we
// het opnieuw proberen.
//
// BEWUST PUUR, net als mcpAuth.ts en publicApi.ts: geen Deno, geen Supabase,
// geen netwerk — alleen Web Crypto. Daardoor draait `npm test` er rechtstreeks
// overheen (webhooks.test.ts). En hier staan de dingen waar een fout niet
// opvalt: een handtekening die ook zonder het juiste geheim klopt, een adres
// dat ongemerkt naar binnen wijst, een herhaalschema dat nooit ophoudt.
//
// HOE HET LOOPT
//   1. Een databasetrigger (webhook_capture, migratie 20261003010000) ziet een
//      klant, factuur of ticket veranderen en zet een gebeurtenis klaar — alleen
//      als er in die organisatie een eindpunt is dat hem wil horen.
//   2. De functie `webhooks` (cron, elke minuut) bezorgt hem, ondertekend met het
//      geheim van dat eindpunt, en probeert het met tussenpozen opnieuw als het
//      eindpunt niet antwoordt.
//   3. Een eindpunt dat dagenlang niets dan fouten geeft, zet zichzelf uit.
// ============================================================

import { base64Url, randomBytes } from './mcpAuth.ts';

// ── De gebeurtenissen ────────────────────────────────────────────────────────
//
// Elke gebeurtenis hoort bij precies één module. Dat is geen versiering: een
// eindpunt dat via een API-sleutel is aangemaakt, krijgt alleen gebeurtenissen
// uit modules die die sleutel mag lezen — hetzelfde antwoord als hij via de API
// zelf zou krijgen.
//
// De lijst moet kloppen met de triggers in de migratie (welke tabel welk
// onderwerp oplevert) en met webhook_status_event (welke statusovergang welke
// afgeleide gebeurtenis geeft). webhooks.test.ts legt die naast elkaar.

export interface WebhookEventType {
  type: string;
  module: string;
  label: string;
}

export const WEBHOOK_EVENTS: readonly WebhookEventType[] = [
  { type: 'client.created', module: 'clients', label: 'Nieuwe klant' },
  { type: 'client.updated', module: 'clients', label: 'Klant gewijzigd' },
  { type: 'client.deleted', module: 'clients', label: 'Klant verwijderd' },
  { type: 'contact.created', module: 'clients', label: 'Nieuwe contactpersoon' },
  { type: 'contact.updated', module: 'clients', label: 'Contactpersoon gewijzigd' },
  { type: 'contact.deleted', module: 'clients', label: 'Contactpersoon verwijderd' },

  { type: 'project.created', module: 'projects', label: 'Nieuw project' },
  { type: 'project.updated', module: 'projects', label: 'Project gewijzigd' },
  { type: 'project.deleted', module: 'projects', label: 'Project verwijderd' },
  { type: 'task.created', module: 'projects', label: 'Nieuwe taak' },
  { type: 'task.updated', module: 'projects', label: 'Taak gewijzigd' },
  { type: 'task.completed', module: 'projects', label: 'Taak afgerond' },
  { type: 'task.deleted', module: 'projects', label: 'Taak verwijderd' },

  { type: 'ticket.created', module: 'tickets', label: 'Nieuw ticket' },
  { type: 'ticket.updated', module: 'tickets', label: 'Ticket gewijzigd' },
  { type: 'ticket.deleted', module: 'tickets', label: 'Ticket verwijderd' },
  { type: 'ticket_note.created', module: 'tickets', label: 'Nieuwe reactie op een ticket' },

  { type: 'time_entry.created', module: 'time', label: 'Uren geboekt' },
  { type: 'time_entry.updated', module: 'time', label: 'Urenpost gewijzigd' },
  { type: 'time_entry.deleted', module: 'time', label: 'Urenpost verwijderd' },

  { type: 'quote.created', module: 'finance', label: 'Nieuwe offerte' },
  { type: 'quote.updated', module: 'finance', label: 'Offerte gewijzigd' },
  { type: 'quote.sent', module: 'finance', label: 'Offerte verstuurd' },
  { type: 'quote.accepted', module: 'finance', label: 'Offerte geaccepteerd' },
  { type: 'quote.rejected', module: 'finance', label: 'Offerte afgewezen' },
  { type: 'quote.deleted', module: 'finance', label: 'Offerte verwijderd' },
  { type: 'invoice.created', module: 'finance', label: 'Nieuwe factuur' },
  { type: 'invoice.updated', module: 'finance', label: 'Factuur gewijzigd' },
  { type: 'invoice.sent', module: 'finance', label: 'Factuur verstuurd' },
  { type: 'invoice.paid', module: 'finance', label: 'Factuur betaald' },
  { type: 'invoice.deleted', module: 'finance', label: 'Factuur verwijderd' },
  { type: 'contract.created', module: 'finance', label: 'Nieuw contract' },
  { type: 'contract.updated', module: 'finance', label: 'Contract gewijzigd' },
  { type: 'contract.signed', module: 'finance', label: 'Contract getekend' },
  { type: 'contract.declined', module: 'finance', label: 'Contract geweigerd' },
  { type: 'contract.deleted', module: 'finance', label: 'Contract verwijderd' },

  { type: 'booking.created', module: 'calendar', label: 'Nieuwe afspraak geboekt' },
  { type: 'booking.updated', module: 'calendar', label: 'Boeking gewijzigd' },
  { type: 'booking.cancelled', module: 'calendar', label: 'Boeking geannuleerd' },
];

/** Het testbericht dat de knop "Testen" stuurt. Is geen abonnement: hij komt altijd. */
export const PING_EVENT = 'ping';

const BY_TYPE = new Map(WEBHOOK_EVENTS.map((e) => [e.type, e]));

export function webhookEvent(type: string): WebhookEventType | undefined {
  return BY_TYPE.get(type);
}

/** De onderwerpen (`client`, `invoice`, …) waar een `onderwerp.*` op mag. */
export const WEBHOOK_ENTITIES: readonly string[] = [...new Set(WEBHOOK_EVENTS.map((e) => e.type.split('.')[0]))];

/**
 * Valt dit type onder dit abonnement? Exact, `onderwerp.*` of `*` — dezelfde drie
 * vormen als webhook_event_matches in de database, en die twee moeten gelijk
 * blijven (webhooks.test.ts draait ze naast elkaar op dezelfde voorbeelden).
 */
export function eventMatches(subscribed: readonly string[], type: string): boolean {
  return subscribed.some((pattern) => pattern === '*'
    || pattern === type
    || (pattern.endsWith('.*') && type.split('.')[0] === pattern.slice(0, -2)));
}

/**
 * Een lijst abonnementen zoals een aanroeper hem opgeeft, opgeschoond. Een type
 * dat niet bestaat is een FOUT en geen stil genegeerde regel: wie
 * "invoice.payed" typt, hoort dat te horen in plaats van nooit een bericht te
 * krijgen en niet te weten waarom.
 */
export function normalizeEventList(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Kies minstens één gebeurtenis, bijvoorbeeld ["invoice.paid"], ["invoice.*"] of ["*"].');
  }
  const out = new Set<string>();
  for (const item of raw) {
    const value = String(item ?? '').trim();
    if (value === '*') { out.add('*'); continue; }
    if (value.endsWith('.*') && WEBHOOK_ENTITIES.includes(value.slice(0, -2))) { out.add(value); continue; }
    if (BY_TYPE.has(value)) { out.add(value); continue; }
    throw new Error(`Onbekende gebeurtenis "${value}". De lijst staat op GET /v1/events.`);
  }
  if (out.size > 100) throw new Error('Hooguit 100 gebeurtenissen per eindpunt.');
  // `*` maakt de rest overbodig; zo staat er niet iets in de lijst wat niets doet.
  return out.has('*') ? ['*'] : [...out].sort();
}

/** De modules waar een abonnementenlijst gebeurtenissen uit kan krijgen. */
export function modulesOf(subscribed: readonly string[]): string[] {
  const modules = new Set<string>();
  for (const event of WEBHOOK_EVENTS) if (eventMatches(subscribed, event.type)) modules.add(event.module);
  return [...modules].sort();
}

// ── Het geheim en de handtekening ────────────────────────────────────────────
//
// Elk eindpunt heeft een eigen geheim (`whsec_…`). Elk bericht draagt
//
//   ResoFly-Signature: t=<unix-tijd>,v1=<hex HMAC-SHA256 van "<t>.<body>">
//
// De ontvanger rekent hetzelfde na met zijn kopie van het geheim, en weigert
// een bericht waarvan de tijd te ver weg ligt. De tijd zit IN de handtekening:
// zo is een onderschept bericht niet maanden later opnieuw af te spelen.

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function createWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${base64Url(randomBytes(32))}`;
}

export async function signPayload(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function signatureHeader(timestamp: number, signature: string): string {
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Wat een ONTVANGER doet. Staat hier zodat de handleiding en de tests precies
 * dezelfde controle beschrijven als die we zelf toepassen — en zodat we hem
 * kunnen testen tegen wat we versturen.
 */
export async function verifySignature(
  secret: string, header: string, body: string,
  { toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS, now = Math.floor(Date.now() / 1000) } = {},
): Promise<boolean> {
  const parts = new Map(String(header || '').split(',').map((part) => {
    const at = part.indexOf('=');
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as [string, string];
  }));
  const timestamp = Number(parts.get('t'));
  const given = parts.get('v1') || '';
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(given)) return false;
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  const expected = await signPayload(secret, timestamp, body);
  // Constante tijd: het antwoord mag niets verraden via de duur van de vergelijking.
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ── Het geheim in de database ────────────────────────────────────────────────
//
// Anders dan een API-sleutel kunnen we het webhookgeheim niet alleen gehasht
// bewaren: wíj moeten ermee ondertekenen. Dus versleuteld, met AES-GCM en een
// sleutel die alleen in de Edge Function secrets staat
// (WEBHOOK_SECRET_ENCRYPTION_KEY) — hetzelfde patroon als de agenda-tokens.
// Wie alleen de database heeft, heeft het geheim niet.

async function aesKey(encryptionKey: string): Promise<CryptoKey> {
  if (!encryptionKey) throw new Error('WEBHOOK_SECRET_ENCRYPTION_KEY ontbreekt in de Edge Function secrets.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encryptionKey));
  return await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, encryptionKey: string): Promise<string> {
  // Een eigen ArrayBuffer en geen randomBytes(): onder TS 6 telt alleen een
  // Uint8Array<ArrayBuffer> als BufferSource (zie frontend-checks.yml).
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(encryptionKey), new TextEncoder().encode(plain));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(data))}`;
}

export async function decryptSecret(stored: string, encryptionKey: string): Promise<string> {
  const [version, iv, data] = String(stored || '').split('.');
  if (version !== 'v1' || !iv || !data) throw new Error('Het webhookgeheim heeft een onbekende vorm.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv) }, await aesKey(encryptionKey), fromBase64Url(data));
  return new TextDecoder().decode(plain);
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Welke adressen er mogen ──────────────────────────────────────────────────
//
// Een webhook is een verzoek dat WIJ versturen, vanaf onze servers, naar een
// adres dat een klant opgeeft. Wijst dat adres naar binnen — localhost, het
// interne netwerk, het metadata-adres van een cloud — dan is het een manier om
// onze servers iets te laten opvragen wat van buiten niet bereikbaar is. Dus:
// alleen https, alleen een openbare naam of een openbaar IP-adres.
//
// Bij het bezorgen kijken we nog een keer, op de IP-adressen waar de naam dan
// naar wijst (zie webhookDelivery.ts): een naam die vandaag naar buiten wijst,
// kan morgen naar binnen wijzen.

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

/** Geeft een leesbare reden waarom dit adres niet mag, of null als het goed is. */
export function webhookUrlProblem(raw: string): string | null {
  const value = String(raw || '').trim();
  if (!value) return 'Vul het adres van je eindpunt in.';
  if (value.length > 2000) return 'Dit adres is te lang.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Dit is geen geldig adres.';
  }
  if (url.protocol !== 'https:') return 'Een webhook-adres moet met https:// beginnen: het bericht reist anders onversleuteld.';
  if (url.username || url.password) return 'Zet geen gebruikersnaam of wachtwoord in het adres; gebruik de handtekening om berichten te controleren.';
  // Een punt aan het eind ("localhost.", "foo.internal.") is dezelfde naam in
  // DNS, maar zou anders langs de controles hieronder glippen.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return 'Dit adres heeft geen servernaam.';
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return 'Dit adres wijst naar een intern netwerk. Gebruik een adres dat vanaf internet bereikbaar is.';
  }
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) return 'Dit IP-adres is niet openbaar. Gebruik een adres dat vanaf internet bereikbaar is.';
  } else if (!host.includes('.')) {
    return 'Gebruik een volledige servernaam, zoals hooks.jouwdomein.nl.';
  }
  return null;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Ligt dit IP-adres in een privé-, lokaal of gereserveerd blok? Voor IPv4 en
 * IPv6, inclusief een IPv4-adres verpakt in IPv6 — ook in de hexvorm waarin de
 * URL-parser het herschrijft (`[::ffff:10.0.0.1]` wordt `::ffff:a00:1`).
 */
export function isPrivateAddress(ip: string): boolean {
  const value = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = parseIpv4(value);
  if (v4) return isPrivateIpv4(v4);
  if (value.includes(':')) {
    const groups = parseIpv6(value);
    // Geen herkenbaar adres: liever weigeren dan gokken.
    if (!groups) return true;
    return isPrivateIpv6(groups);
  }
  return true;
}

function parseIpv4(value: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : [256, 0, 0, 0];
}

function isPrivateIpv4([a, b, c]: number[]): boolean {
  return a > 255                                  // geen geldig adres
    || a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)         // carrier-grade NAT
    || (a === 169 && b === 254)                   // link-local, cloud-metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))      // benchmarknetwerk
    || a >= 224;                                  // multicast en gereserveerd
}

/** Acht groepen van 16 bits, of null als dit geen IPv6-adres is. */
function parseIpv6(value: string): number[] | null {
  let text = value;
  // Een IPv4-staart (::ffff:1.2.3.4) wordt eerst twee gewone groepen.
  const tail = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = parseIpv4(tail[2]);
    if (!v4 || v4[0] > 255) return null;
    text = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return all.map((group) => parseInt(group, 16));
}

function isPrivateIpv6(g: number[]): boolean {
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (g.every((x) => x === 0)) return true;                                    // ::
  if (zeroUpTo(7) && g[7] === 1) return true;                                  // ::1
  // Een IPv4-adres erin verpakt: dan telt dat adres.
  const embedded = () => isPrivateIpv4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  if (zeroUpTo(5) && g[5] === 0xffff) return embedded();                       // ::ffff:0:0/96
  if (zeroUpTo(6)) return embedded();                                          // ::/96 (oud)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeroUpTo(0) && g.slice(2, 6).every((x) => x === 0)) return embedded(); // NAT64
  return (g[0] & 0xfe00) === 0xfc00                                            // unique local fc00::/7
    || (g[0] & 0xffc0) === 0xfe80                                              // link-local fe80::/10
    || (g[0] & 0xff00) === 0xff00                                              // multicast
    || (g[0] === 0x2001 && g[1] === 0x0db8)                                    // documentatie
    || (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0));               // discard 100::/64
}

/**
 * Het antwoord van DNS-over-HTTPS (het JSON-formaat van Cloudflare en Google)
 * als lijst adressen van het gevraagde type. Status 3 is "bestaat niet": geen
 * adressen. Elke andere status, of een antwoord dat niet klopt, is een fout —
 * dan weten we het niet, en dat is iets anders dan "geen adressen".
 */
export function parseDohAnswer(body: unknown, type: 'A' | 'AAAA'): string[] {
  const answer = body as { Status?: unknown; Answer?: unknown } | null;
  if (!answer || typeof answer !== 'object' || typeof answer.Status !== 'number') {
    throw new Error('Onleesbaar DNS-antwoord.');
  }
  if (answer.Status === 3) return [];
  if (answer.Status !== 0) throw new Error(`DNS-status ${answer.Status}.`);
  const wanted = type === 'A' ? 1 : 28;
  return (Array.isArray(answer.Answer) ? answer.Answer : [])
    .filter((record: { type?: unknown; data?: unknown }) => record?.type === wanted && typeof record.data === 'string')
    .map((record: { data: string }) => record.data);
}

// ── Opnieuw proberen ─────────────────────────────────────────────────────────
//
// Een eindpunt dat even plat ligt, verliest niets: we proberen het na 1, 5 en
// 30 minuten, na 2, 6 en 12 uur, en daarna nog twee keer na een dag — negen
// pogingen in bijna drie dagen, genoeg om een lang weekend plat te liggen.
// Daarna geven we het op voor dit bericht. Lukt het een
// eindpunt een hele dag lang bij geen enkel bericht, dan zetten we het uit (zie
// finish_webhook_delivery): een adres dat niet meer bestaat, hoort niet eeuwig
// door te zoemen.

export const RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 1800, 7200, 21600, 43200, 86400, 86400];
export const MAX_DELIVERY_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** Na hoeveel seconden de volgende poging, of null als dit de laatste was. */
export function nextRetryDelay(attemptsSoFar: number): number | null {
  if (attemptsSoFar >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_DELAYS_SECONDS[Math.max(0, attemptsSoFar - 1)] ?? null;
}

// ── Het bericht ──────────────────────────────────────────────────────────────

export interface WebhookMessage {
  id: string;
  type: string;
  created_at: string;
  organization_id: string;
  data: Record<string, unknown>;
}

/**
 * Wat een eindpunt ontvangt. `id` is de gebeurtenis en blijft gelijk bij elke
 * nieuwe poging: zo kan de ontvanger een dubbel bericht herkennen.
 */
export function webhookBody(message: WebhookMessage): string {
  return JSON.stringify({
    id: message.id,
    type: message.type,
    created_at: message.created_at,
    organization_id: message.organization_id,
    data: message.data,
  });
}
