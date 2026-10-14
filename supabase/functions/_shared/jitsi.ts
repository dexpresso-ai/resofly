// ============================================================
// Jitsi Meet-links — een eigen vergaderruimte per afspraak
//
// Geen API, geen koppeling, geen account: een Jitsi-vergadering ís de link.
// Standaard op de openbare server meet.jit.si; een organisatie kan haar eigen
// Jitsi-server opgeven (company_settings.jitsi_base_url). De regels zijn gelijk
// aan die in src/lib/meeting.ts (de app) — houd ze samen gelijk.
//
// Pure functies (geen Deno, geen database): meeting-booking-public gebruikt ze
// bij het boeken, jitsi.test.ts legt ze vast.
// ============================================================

export const DEFAULT_JITSI_BASE_URL = 'https://meet.jit.si';

/**
 * `meet.example.nl` → `https://meet.example.nl`. Alleen https, geen
 * inloggegevens, query of #, hooguit één padstuk. Leeg of ongeldig → null.
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

const ROOM_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LENGTH = 14;

/** `ResoFly-` plus 14 willekeurige tekens: onraadbaar, en zonder titel of klantnaam. */
export function jitsiRoomName(): string {
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

/**
 * Is dit een Jitsi-vergaderlink? meet.jit.si en 8x8.vc, de eigen server van de
 * organisatie, of een kamernaam zoals ResoFly die maakt (op welke server ook).
 * Zelfde regel als detectMeetingKind in src/lib/meeting.ts.
 */
export function isJitsiMeetingUrl(url: unknown, configured?: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false;
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return false; }
  if (/(^|\.)(meet\.jit\.si|8x8\.vc)$/i.test(parsed.hostname)) return true;
  const own = normalizeJitsiBaseUrl(configured);
  if (own && parsed.host === new URL(own).host) return true;
  return /\/ResoFly-[A-Za-z0-9]{14}\/?$/.test(parsed.pathname);
}
