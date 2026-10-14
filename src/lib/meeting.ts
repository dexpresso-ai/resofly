// Herkent het type videovergadering aan de hand van de link, zodat de UI het
// juiste label (en straks icoon) kan tonen. Puur cosmetisch — de link zelf is
// leidend; we bewaren geen aparte "provider"-kolom.
//
// Daarnaast maakt deze module Jitsi Meet-links: een eigen vergaderruimte per
// afspraak, zonder Google of Microsoft ertussen. Standaard op de openbare server
// meet.jit.si; een organisatie kan in Instellingen → Agenda haar eigen
// Jitsi-server opgeven (company_settings.jitsi_base_url). De edge-functies
// hebben dezelfde regels in supabase/functions/_shared/jitsi.ts.

export type MeetingKind = 'google_meet' | 'teams' | 'zoom' | 'jitsi' | 'other';

const HOSTS: { kind: MeetingKind; label: string; match: RegExp }[] = [
  { kind: 'google_meet', label: 'Google Meet', match: /(^|\.)meet\.google\.com$/i },
  { kind: 'teams', label: 'Microsoft Teams', match: /(^|\.)teams\.(microsoft|live)\.com$/i },
  { kind: 'zoom', label: 'Zoom', match: /(^|\.)(zoom\.us|zoom\.com|.*\.zoom\.us)$/i },
  // meet.jit.si is de openbare Jitsi-server, 8x8.vc de betaalde (JaaS) van 8x8.
  { kind: 'jitsi', label: 'Jitsi Meet', match: /(^|\.)(meet\.jit\.si|8x8\.vc)$/i },
];

const OTHER = { kind: 'other' as MeetingKind, label: 'Videocall' };
const JITSI = { kind: 'jitsi' as MeetingKind, label: 'Jitsi Meet' };

/** Kamernaam zoals ResoFly die maakt (zie jitsiRoomName) — op elke server herkenbaar. */
const RESOFLY_ROOM_RE = /\/ResoFly-[A-Za-z0-9]{14}\/?$/;

/**
 * Het soort videovergadering achter een link. `jitsiBaseUrl` is de eigen
 * Jitsi-server van de organisatie: links naar die server heten ook Jitsi Meet.
 */
export function detectMeetingKind(url: string | null | undefined, jitsiBaseUrl?: string | null): { kind: MeetingKind; label: string } {
  if (!url) return OTHER;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return OTHER; }
  for (const h of HOSTS) if (h.match.test(parsed.hostname)) return { kind: h.kind, label: h.label };
  const own = normalizeJitsiBaseUrl(jitsiBaseUrl);
  if (own && parsed.host === new URL(own).host) return JITSI;
  if (RESOFLY_ROOM_RE.test(parsed.pathname)) return JITSI;
  return OTHER;
}

/** Basisvalidatie voor een geplakte link: alleen http(s) toestaan. */
export function isValidMeetingUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try { const u = new URL(trimmed); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// ── Jitsi Meet ───────────────────────────────────────────────────────────────

export const DEFAULT_JITSI_BASE_URL = 'https://meet.jit.si';

/**
 * Maakt van wat iemand als Jitsi-server invult een nette basis-URL:
 * `meet.example.nl` → `https://meet.example.nl`. Alleen https (de browser geeft
 * camera en microfoon niet vrij op http), geen inloggegevens, query of #, en
 * hooguit één padstuk (een tenant, of de JaaS-app-id op 8x8.vc). Leeg of
 * ongeldig → null; dan geldt meet.jit.si.
 */
export function normalizeJitsiBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) return null;
  if (!url.hostname.includes('.') || url.hostname.startsWith('.') || url.hostname.endsWith('.')) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.split('/').length > 2) return null;
  const out = `${url.origin}${path}`;
  return out.length <= 200 ? out : null;
}

/** De Jitsi-server die geldt: de ingestelde, of anders meet.jit.si. */
export function jitsiBaseUrl(configured: unknown): string {
  return normalizeJitsiBaseUrl(configured) ?? DEFAULT_JITSI_BASE_URL;
}

/** De openbare server meet.jit.si: daar logt wie de vergadering opent eerst even in. */
export function usesPublicJitsi(configured: unknown): boolean {
  return new URL(jitsiBaseUrl(configured)).host === 'meet.jit.si';
}

/** Alleen de servernaam, voor in de uitleg: "meet.jit.si", "meet.example.nl". */
export function jitsiServerLabel(configured: unknown): string {
  const url = new URL(jitsiBaseUrl(configured));
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

// Zonder tekens die op elkaar lijken (l/1/I, o/0/O): de link wordt ook wel eens
// overgetypt of voorgelezen.
const ROOM_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LENGTH = 14;

/**
 * Een onraadbare kamernaam: `ResoFly-` plus 14 willekeurige tekens (ruim 80
 * bits). Een Jitsi-kamer is open voor iedereen die de naam kent; daarom geen
 * titel of klantnaam in de link — die belandt anders ook in serverlogboeken.
 */
export function jitsiRoomName(): string {
  // Bytes boven het hoogste veelvoud van de alfabetlengte vallen af, zodat
  // geen teken vaker voorkomt dan een ander.
  const limit = 256 - (256 % ROOM_ALPHABET.length);
  const out: string[] = [];
  while (out.length < ROOM_LENGTH) {
    const bytes = new Uint8Array(ROOM_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && out.length < ROOM_LENGTH) out.push(ROOM_ALPHABET[b % ROOM_ALPHABET.length]);
    }
  }
  return `ResoFly-${out.join('')}`;
}

/** Een nieuwe vergaderlink op de Jitsi-server van de organisatie. */
export function jitsiMeetingUrl(configured?: unknown): string {
  return `${jitsiBaseUrl(configured)}/${jitsiRoomName()}`;
}

// ── Videovergadering bij een boekingslink ────────────────────────────────────
// meeting_booking_links bewaart twee velden (auto_conference, conference_provider);
// in een formulier is dat één keuze. Een vaste meeting_url gaat altijd voor.

/** De videokeuze van een boekingslink, als één waarde voor in een keuzelijst. */
export type BookingVideo = 'jitsi' | 'calendar' | 'none';

/** Maakt de agenda zelf een videovergadering (Google Meet / Teams)? */
export function calendarMakesConference(sourceProvider: string | null | undefined): boolean {
  return sourceProvider === 'google' || sourceProvider === 'microsoft';
}

/**
 * Van de opgeslagen velden naar één keuze. Een ResoFly-agenda maakt zelf geen
 * vergadering: 'calendar' betekent daar in de praktijk "geen".
 */
export function bookingVideoFromLink(autoConference: boolean | undefined, conferenceProvider: string | null | undefined, sourceProvider: string | null | undefined): BookingVideo {
  if (autoConference === false) return 'none';
  if (conferenceProvider === 'jitsi') return 'jitsi';
  return calendarMakesConference(sourceProvider) ? 'calendar' : 'none';
}

/** Standaard voor een nieuwe link: wat de agenda zelf kan, en anders Jitsi. */
export function defaultBookingVideo(sourceProvider: string | null | undefined): BookingVideo {
  return calendarMakesConference(sourceProvider) ? 'calendar' : 'jitsi';
}

/**
 * De keuze die echt geldt bij deze agenda: 'calendar' op een agenda die zelf
 * niets maakt (je wisselde naar een ResoFly-agenda) wordt Jitsi — de enige
 * automatische videovergadering die daar kan.
 */
export function effectiveBookingVideo(choice: BookingVideo, sourceProvider: string | null | undefined): BookingVideo {
  return choice === 'calendar' && !calendarMakesConference(sourceProvider) ? 'jitsi' : choice;
}

/** Terug naar de velden van meeting_booking_links. */
export function bookingVideoFields(choice: BookingVideo, sourceProvider: string | null | undefined): { autoConference: boolean; conferenceProvider: 'calendar' | 'jitsi' } {
  const effective = effectiveBookingVideo(choice, sourceProvider);
  return { autoConference: effective !== 'none', conferenceProvider: effective === 'jitsi' ? 'jitsi' : 'calendar' };
}
