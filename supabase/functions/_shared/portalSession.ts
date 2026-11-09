// ============================================================
// Een inlog in het klantportaal, en wat hij mag zien (migratie
// 20261109020000).
//
// Waarom dit bestaat: het portaal kan op het eigen domein van een gebruiker
// staan (portaal.fotostudiojansen.nl). De DNS daarvan beheert die gebruiker
// zelf. De inlog van een klant staat in zijn browser, bij het adres waar hij
// inlogde, en gold tot nu toe bij elke gebruiker bij wie hij klant is. Wie het
// domein naar een eigen server laat wijzen, kon die inlog daar uitlezen en
// zien wat de klant bij een ander heeft.
//
// Daarom legt de server elke inlog vast (portal_sessions), met wat hij mag
// zien: één organisatie (ingelogd op haar adres) of alles (het algemene
// portaal). client-portal weigert een inlog die er niet staat.
//
// Op een eigen domein komt geen inlog van Supabase: die geldt voor het hele
// account, en is de klant ook teamlid bij een andere gebruiker, dan opent hij
// ook diens werkruimte. Daar logt de klant in met een code van ResoFly zelf,
// en krijgt hij een sleutel (portal_tokens) voor alleen het portaal van die
// gebruiker, alleen op dat domein. Die sleutel gaat mee in de kop
// x-portal-token.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wat een onbekende of verlopen inlog als code meekrijgt; de app logt dan uit. */
export const SESSION_UNBOUND_CODE = 'session_unbound';

/** De kop met de sleutel van het portaal op een eigen domein. */
export const PORTAL_TOKEN_HEADER = 'x-portal-token';

/** Zo lang geldt een sleutel na het laatste gebruik (ook in portal_token_scope). */
export const PORTAL_TOKEN_DAYS = 30;

/** Een aanvraagnummer, geheim of sleutel: 32 willekeurige bytes als base64url. */
export function isPortalSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{30,100}$/.test(value);
}

/**
 * De code van ResoFly voor een eigen domein: acht cijfers, gelijk verdeeld.
 * 2^32 is geen veelvoud van 10^8; de te hoge waarden slaan we over, anders
 * kwamen lage codes vaker voor.
 */
export function randomPortalCode(random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]): string {
  const limit = Math.floor(0x1_0000_0000 / 100_000_000) * 100_000_000;
  for (;;) {
    const value = random();
    if (value < limit) return String(value % 100_000_000).padStart(8, '0');
  }
}

export type PortalTokenScope =
  | { ok: true; userId: string; organizationId: string; host: string }
  | { ok: false; reason: 'unbound' | 'host' };

/**
 * Wat een sleutel van een eigen domein mag: één organisatie, op dat domein.
 * Niets als hij onbekend of verlopen is, of als het portaal daar niet meer
 * staat (dan gooit de database hem weg).
 */
export async function portalTokenScope(admin: SupabaseClient, tokenHash: string): Promise<PortalTokenScope> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return { ok: false, reason: 'unbound' };
  const { data, error } = await admin.rpc('portal_token_scope', { p_token_hash: tokenHash });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: unknown; userId?: unknown; organizationId?: unknown; host?: unknown; reason?: unknown };
  if (result.ok === true && typeof result.userId === 'string' && UUID.test(result.userId)
    && typeof result.organizationId === 'string' && UUID.test(result.organizationId)
    && typeof result.host === 'string' && result.host) {
    return { ok: true, userId: result.userId, organizationId: result.organizationId, host: result.host };
  }
  return { ok: false, reason: result.reason === 'host' ? 'host' : 'unbound' };
}

/**
 * De sessie bij Supabase Auth uit een token (de claim session_id). Alleen
 * aanroepen nadat auth.getUser het token heeft goedgekeurd: dit leest het
 * token, het controleert de handtekening niet.
 */
export function sessionIdFromToken(token: string): string | null {
  const part = String(token ?? '').split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { session_id?: unknown };
    const id = typeof claims.session_id === 'string' ? claims.session_id : '';
    return UUID.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type PortalScope =
  | { ok: true; organizationId: string | null }
  | { ok: false; reason: 'unbound' | 'host' };

/**
 * Wat deze inlog mag zien: één organisatie, alles (null), of niets. Ook "niets"
 * als het opzoeken mislukt: liever een klant die opnieuw inlogt dan een
 * portaal dat alles toont.
 */
export async function portalSessionScope(
  admin: SupabaseClient,
  sessionId: string | null,
  userId: string,
  base: string,
): Promise<PortalScope> {
  if (!sessionId) return { ok: false, reason: 'unbound' };
  const { data, error } = await admin.rpc('portal_session_scope', { p_session_id: sessionId, p_user_id: userId, p_base: base });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: unknown; organizationId?: unknown; reason?: unknown };
  if (result.ok === true) {
    const organizationId = typeof result.organizationId === 'string' && UUID.test(result.organizationId) ? result.organizationId : null;
    return { ok: true, organizationId };
  }
  return { ok: false, reason: result.reason === 'host' ? 'host' : 'unbound' };
}

export type BindFailure = 'session' | 'bound' | 'request' | 'expired' | 'verifier' | 'origin' | 'method';

export type BindResult = { ok: true; organizationId: string | null } | { ok: false; reason: BindFailure };

const BIND_FAILURES: readonly BindFailure[] = ['session', 'bound', 'request', 'expired', 'verifier', 'origin', 'method'];

/** Een verse inlog vastleggen bij de aanvraag waar hij uit kwam (zie de migratie). */
export async function bindPortalSession(
  admin: SupabaseClient,
  args: {
    sessionId: string;
    userId: string;
    requestHash: string | null;
    verifierHashes: string[];
    originOrganizationId: string | null;
  },
): Promise<BindResult> {
  const { data, error } = await admin.rpc('portal_session_bind', {
    p_session_id: args.sessionId,
    p_user_id: args.userId,
    p_request_hash: args.requestHash,
    p_verifier_hashes: args.verifierHashes,
    p_origin_organization_id: args.originOrganizationId,
  });
  if (error) throw error;
  const result = (data ?? {}) as { ok?: unknown; organizationId?: unknown; reason?: unknown };
  if (result.ok === true) {
    const organizationId = typeof result.organizationId === 'string' && UUID.test(result.organizationId) ? result.organizationId : null;
    return { ok: true, organizationId };
  }
  const reason = BIND_FAILURES.includes(result.reason as BindFailure) ? result.reason as BindFailure : 'session';
  return { ok: false, reason };
}

/**
 * Een verse inlog die niet vast te leggen is, kan nergens meer voor dienen:
 * client-portal weigert hem toch. Weg ermee, dan blijft hij ook niet geldig bij
 * Supabase Auth. Een inlog die al ergens vastligt, laten we staan.
 */
export function bindFailureEndsSession(reason: BindFailure): boolean {
  return reason !== 'bound';
}

/**
 * De zin voor de klant. Gewone woorden; nooit wat er technisch mis is.
 * Vastleggen gebeurt alleen na de link (migratie 20261109150000): een code van
 * Supabase staat niet meer in de mail.
 */
export function bindFailureMessage(reason: BindFailure): string {
  switch (reason) {
    case 'expired':
      return 'Deze inloglink is verlopen. Vraag een nieuwe aan.';
    case 'request':
    case 'verifier':
    case 'origin':
      return 'Deze inloglink hoort bij een andere aanvraag. Gebruik de nieuwste mail, in de browser waar je hem aanvroeg.';
    default:
      return 'Inloggen is niet gelukt. Vraag een nieuwe inloglink aan.';
  }
}

export function bindFailureStatus(reason: BindFailure): number {
  return reason === 'expired' ? 410 : 403;
}
