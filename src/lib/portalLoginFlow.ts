// Inloggen in het klantportaal met de inlogmail van ResoFly (portal-login,
// migratie 20261108230000).
//
// Zo werkt het: deze browser maakt een geheim, bewaart het hier en stuurt
// alleen de sha256 ervan mee met de aanvraag. De mail bevat een
// aanvraagnummer. Wie op de link klikt, stuurt het nummer en de geheimen van
// deze browser terug; alleen als er één past, geeft de server het inlogtoken.
// Zo werkt de link alleen in de browser die hem aanvroeg, net als eerder met
// PKCE. Op een ander apparaat vul je de code uit dezelfde mail in.
//
// Bewust los van het scherm: portalLoginFlow.test.ts loopt het na.

/** Waar de geheimen van openstaande aanvragen staan (deze browser, dit adres). */
export const VERIFIER_STORAGE_KEY = 'resofly.portal.verifiers';
/** Zo lang bewaren we een geheim: de link zelf werkt een kwartier. */
const VERIFIER_MAX_AGE_MS = 30 * 60_000;
/** Wie vaker aanvroeg, heeft meer mails; de laatste vijf tellen. */
const VERIFIER_MAX = 5;

type StoredVerifier = { v: string; at: number };

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Een nieuw geheim: 32 willekeurige bytes. */
export function createVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** De geheimen die nog meetellen, nieuwste eerst. Wat van schijf komt, keuren we opnieuw. */
export function parseStoredVerifiers(raw: string | null, now = Date.now()): string[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return (list as StoredVerifier[])
      .filter((item) => item && typeof item.v === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(item.v)
        && typeof item.at === 'number' && now - item.at < VERIFIER_MAX_AGE_MS && item.at <= now + 60_000)
      .sort((a, b) => b.at - a.at)
      .slice(0, VERIFIER_MAX)
      .map((item) => item.v);
  } catch {
    return [];
  }
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function rememberVerifier(verifier: string, now = Date.now()): void {
  const store = storage();
  if (!store) return;
  try {
    const current = parseStoredVerifiers(store.getItem(VERIFIER_STORAGE_KEY), now).map((v, i) => ({ v, at: now - i - 1 }));
    const next = [{ v: verifier, at: now }, ...current].slice(0, VERIFIER_MAX);
    store.setItem(VERIFIER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Privémodus of vol: dan werkt alleen de code uit de mail.
  }
}

export function pendingVerifiers(now = Date.now()): string[] {
  const store = storage();
  if (!store) return [];
  try {
    return parseStoredVerifiers(store.getItem(VERIFIER_STORAGE_KEY), now);
  } catch {
    return [];
  }
}

export function forgetVerifiers(): void {
  try {
    storage()?.removeItem(VERIFIER_STORAGE_KEY);
  } catch {
    // Niets aan te doen.
  }
}

/** Het pad van de link uit de inlogmail. */
export const PORTAL_LOGIN_LANDING_PATH = '/portal/inloggen';

/** Het aanvraagnummer uit /portal/inloggen?aanvraag=…, of null. */
export function loginRequestFromLocation(location: { pathname: string; search: string }): string | null {
  if (location.pathname.replace(/\/+$/, '') !== PORTAL_LOGIN_LANDING_PATH) return null;
  const value = new URLSearchParams(location.search).get('aanvraag') ?? '';
  return /^[A-Za-z0-9_-]{30,100}$/.test(value) ? value : null;
}

/** Een code uit de mail: alleen de cijfers, 6 tot 10 lang. */
export function normalizeLoginCode(value: string): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 10 ? digits : null;
}
