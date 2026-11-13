// Deellinks van een ResoFly-agenda: het geheim in het adres en wat ervan
// bewaard wordt. De agendaserver (workers/caldav/src/logic.ts) controleert
// dezelfde vorm; workers/caldav/src/logic.test.ts houdt de twee gelijk.

/** 32 willekeurige bytes in base64url: 43 tekens, 256 bits. */
export const FEED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Hoeveel actieve links één agenda mag hebben. Meer is geen delen meer, maar publiceren. */
export const MAX_FEED_LINKS_PER_CALENDAR = 20;

export type FeedDetail = 'busy' | 'details';

export function generateFeedToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Alleen deze hash staat in de database. Zonder zout: het token is lang en
 * willekeurig, en de agendaserver moet een link op de hash kunnen opzoeken.
 */
export async function hashFeedToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  let out = '';
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function normalizeFeedDetail(value: unknown): FeedDetail {
  return value === 'details' ? 'details' : 'busy';
}

/** Een naam voor wie de link is ("Partner", "Assistent"); leeg wordt "Deellink". */
export function normalizeFeedLabel(value: unknown): string {
  const label = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return label || 'Deellink';
}
