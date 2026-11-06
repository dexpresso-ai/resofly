// ============================================================
// De regels van het koppelen van een Google- of Microsoft-agenda (OAuth).
//
// Puur, zonder imports, zodat calendarOAuth.test.ts ze onder node kan
// vastleggen; calendar-integrations en calendarCore gebruiken ze onder Deno.
//
// De rondgang:
//   1. De app vraagt een toestemmingslink (oauthStart). Daarin zit een door
//      ons ondertekende `state`: wie, welke organisatie, waar terug naartoe.
//   2. Google of Microsoft stuurt de browser terug naar de edge function
//      (handleOAuthCallback). Die wisselt de code NIET zelf in, maar stuurt hem
//      door naar de app: de callback heeft geen sessie.
//   3. De app rondt af met de sessie van wie er is ingelogd (oauthComplete);
//      dat moet dezelfde gebruiker zijn als in de state.
// ============================================================

export type CalendarOAuthProvider = 'google' | 'microsoft';

export type OAuthState = {
  provider: CalendarOAuthProvider;
  userId: string;
  organizationId: string;
  returnTo: string;
  nonce: string;
  iat: number;
  exp: number;
};

/**
 * Zo lang mag de hele rondgang duren, van de klik op "koppelen" tot het
 * afronden in de app. Was tien minuten; wie bij Google of Microsoft eerst nog
 * moest inloggen en zijn telefoon zocht voor de tweestapscode, kwam terug op
 * een JSON-foutpagina ("Ongeldige of verlopen OAuth state") en moest opnieuw
 * beginnen. Langer is hier geen risico: de state hoort bij één gebruiker (de
 * app rondt alleen af voor wie startte) en de code zelf is eenmalig.
 */
export const OAUTH_STATE_TTL_SECONDS = 30 * 60;
export const OAUTH_STATE_MAX_LENGTH = 4096;
export const OAUTH_STATE_CLOCK_SKEW_SECONDS = 60;

/**
 * Wat de callback in het terugkeeradres van de app zet. Bij een fout alleen
 * een van deze vaste codes, nooit de tekst van de provider: die kwam eerst
 * ongefilterd mee (calendar_error=<error_description>), en zo kon iedereen een
 * link naar de app maken met een eigen "foutmelding" erin.
 */
export const CALENDAR_OAUTH_ERROR_CODES = ['geweigerd', 'beheerder', 'verlopen', 'ongeldig', 'storing', 'mislukt'] as const;
export type CalendarOAuthErrorCode = typeof CALENDAR_OAUTH_ERROR_CODES[number];

/** De parameters die de callback aan het terugkeeradres hangt. */
export const CALENDAR_RETURN_PARAMS = ['calendar_code', 'calendar_state', 'calendar_error', 'calendar_provider'] as const;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Scopes ──────────────────────────────────────────────────────────────────

export function googleScopes(): string[] {
  return [
    'openid', 'email', 'profile',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    // Contacten opzoeken bij het uitnodigen van genodigden.
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/contacts.other.readonly',
  ];
}

export function microsoftScopes(): string[] {
  // People.Read = relevantie-gerangschikt adresboek (contacten + directory), Contacts.Read = opgeslagen contacten.
  return ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite', 'Contacts.Read', 'People.Read'];
}

export type CalendarCapability = 'agendalijst' | 'afspraken';

const GOOGLE = 'https://www.googleapis.com/auth/';
/** Elk van deze scopes geeft het recht; de bredere oude scope `calendar` geeft alles. */
const GOOGLE_NEEDS: Record<CalendarCapability, string[]> = {
  agendalijst: ['calendar.calendarlist.readonly', 'calendar.calendarlist', 'calendar.readonly', 'calendar'].map(s => GOOGLE + s),
  afspraken: ['calendar.events', 'calendar'].map(s => GOOGLE + s),
};

/**
 * Welke rechten ontbreken voor de agenda? Google laat iemand op het
 * toestemmingsscherm losse vinkjes uitzetten. Zette iemand "agenda" uit, dan
 * kwam de koppeling er toch, en faalde daarna elke keer het ophalen met het
 * Engelse "Request had insufficient authentication scopes". Contacten zijn
 * optioneel (alleen voor het zoeken naar genodigden) en tellen hier niet mee.
 */
export function missingCalendarCapabilities(provider: CalendarOAuthProvider, granted: string[]): CalendarCapability[] {
  if (provider === 'google') {
    const have = new Set(granted.map(s => s.trim()));
    return (Object.keys(GOOGLE_NEEDS) as CalendarCapability[]).filter(cap => !GOOGLE_NEEDS[cap].some(s => have.has(s)));
  }
  // Microsoft geeft scopes soms als volledige URI (https://graph.microsoft.com/Calendars.ReadWrite).
  const have = new Set(granted.map(s => s.trim().split('/').pop()!.toLowerCase()));
  return have.has('calendars.readwrite') || have.has('calendars.readwrite.shared') ? [] : ['agendalijst', 'afspraken'];
}

// ── De toestemmingslink ─────────────────────────────────────────────────────

/**
 * De link naar het toestemmingsscherm van Google of Microsoft.
 *
 * Accountkeuze: zonder `select_account` koppelde wie in zijn browser bij een
 * ander Google- of Microsoft-account was ingelogd (privé in plaats van werk)
 * ongemerkt dat andere account. Bij opnieuw koppelen geven we het bekende
 * adres mee (`loginHint`), dan staat het juiste account meteen klaar.
 * Google geeft alleen met `consent` een vernieuwtoken; zonder dat token
 * verloopt de koppeling na een uur.
 */
export function buildAuthorizeUrl(input: {
  provider: CalendarOAuthProvider;
  clientId: string;
  redirectUri: string;
  state: string;
  microsoftTenant: string;
  loginHint?: unknown;
}): string {
  const hint = typeof input.loginHint === 'string' && input.loginHint.length <= 254 && EMAIL_RE.test(input.loginHint.trim())
    ? input.loginHint.trim()
    : null;
  if (input.provider === 'google') {
    const params = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: hint ? 'consent' : 'select_account consent',
      include_granted_scopes: 'true',
      scope: googleScopes().join(' '),
      state: input.state,
    });
    if (hint) params.set('login_hint', hint);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: microsoftScopes().join(' '),
    state: input.state,
  });
  if (hint) params.set('login_hint', hint);
  else params.set('prompt', 'select_account');
  return `https://login.microsoftonline.com/${encodeURIComponent(input.microsoftTenant || 'common')}/oauth2/v2.0/authorize?${params}`;
}

// ── Fouten van de provider ──────────────────────────────────────────────────

/**
 * Vertaalt de fout waarmee Google of Microsoft terugstuurt naar een vaste code.
 * De app kent bij elke code een eigen, Nederlandse uitleg.
 */
export function classifyProviderError(error: unknown, description?: unknown, subcode?: unknown): CalendarOAuthErrorCode {
  const code = String(error ?? '').trim().toLowerCase();
  const text = String(description ?? '');
  // Microsoft: "Need admin approval" en verwante AADSTS-codes.
  if (/AADSTS(65001|90094|90095|90008|50105)\b/i.test(text) || code === 'consent_required' || code === 'admin_policy_enforced' || code === 'org_internal') {
    return 'beheerder';
  }
  if (code === 'access_denied' || String(subcode ?? '').toLowerCase() === 'cancel' || /AADSTS65004\b/i.test(text)) return 'geweigerd';
  if (code === 'temporarily_unavailable' || code === 'server_error') return 'storing';
  return 'mislukt';
}

/**
 * Wat een mislukte vernieuwing van het toegangstoken betekent.
 *   ingetrokken: de gebruiker trok de toegang in, veranderde zijn wachtwoord,
 *     of het token verliep (bij Google in "Testing" al na zeven dagen). Alleen
 *     opnieuw koppelen helpt.
 *   instelling: de app-registratie klopt niet (client secret verlopen, verkeerde
 *     client). De beheerder van ResoFly moet iets doen.
 *   tijdelijk: storing of netwerk. Niets aan de koppeling veranderen.
 * Eerst zette elke mislukte poging de koppeling op "expired", ook een storing
 * van een minuut, en daarna op "error" met alleen "Bad Request" erbij.
 */
export type TokenFailure = 'ingetrokken' | 'instelling' | 'tijdelijk';

export function classifyTokenFailure(status: number, payload: unknown): TokenFailure {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const code = String(body.error ?? '').trim().toLowerCase();
  if (code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required') return 'ingetrokken';
  if (code === 'invalid_client' || code === 'unauthorized_client' || code === 'invalid_scope' || code === 'invalid_request') return 'instelling';
  if (status === 0 || status === 429 || status >= 500) return 'tijdelijk';
  if (status === 400 || status === 401) return 'ingetrokken';
  return 'tijdelijk';
}

export function providerLabel(provider: string): string {
  return provider === 'google' ? 'Google' : provider === 'microsoft' ? 'Microsoft' : 'De agenda-aanbieder';
}

export function tokenFailureMessage(provider: string, failure: TokenFailure, detail?: string): string {
  const label = providerLabel(provider);
  if (failure === 'ingetrokken') return `${label} geeft ResoFly geen toegang meer tot deze agenda (ingetrokken of verlopen). Koppel het account opnieuw.`;
  if (failure === 'instelling') return `De koppeling met ${label} is niet goed ingesteld${detail ? ` (${detail})` : ''}. Laat de beheerder van ResoFly dit nakijken.`;
  return `${label} was even niet bereikbaar. ResoFly probeert het straks opnieuw.`;
}

// ── Het terugkeeradres ──────────────────────────────────────────────────────

/** `https://App.ResoFly.nl/pad/` → `https://app.resofly.nl`; al het andere telt niet. */
export function parseReturnOrigins(value: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const part of String(value || '').split(',')) {
    const trimmed = part.trim();
    if (!/^https?:\/\//i.test(trimmed)) continue;
    try {
      const origin = new URL(trimmed).origin;
      if (origin !== 'null') out.add(origin);
    } catch { /* geen adres */ }
  }
  return [...out];
}

function isLocalDevOrigin(origin: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/**
 * Het adres van de app waar de browser na het koppelen naartoe gaat, en waar
 * de code dus terechtkomt. Dat moet altijd een adres van onszelf zijn: kon je
 * hier een eigen site opgeven, dan startte je een koppeling (de state hoort dan
 * bij jou), stuurde je de toestemmingslink naar een ander, en kwam na diens
 * "toestaan" zijn code bij jou binnen, waarmee jij zijn agenda koppelde.
 *
 * Toegestaan: de ingestelde origins (CALENDAR_ALLOWED_RETURN_ORIGINS) en de
 * Cloudflare-previews van ResoFly. Zonder ingestelde origins alleen de lokale
 * ontwikkelserver. Eerst was dat andersom: zonder instelling mocht elk adres.
 */
export function sanitizeReturnTo(raw: unknown, allowedOrigins: string[]): string {
  const candidate = String(raw ?? '').trim() || allowedOrigins[0] || 'http://localhost:5173';
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('Ongeldig terugkeeradres.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Ongeldig terugkeeradres.');
  url.username = '';
  url.password = '';
  const isConfigured = allowedOrigins.includes(url.origin);
  const isPreview = url.protocol === 'https:' && (url.hostname === 'resofly.pages.dev' || url.hostname.endsWith('.resofly.pages.dev'));
  const isLocal = allowedOrigins.length === 0 && isLocalDevOrigin(url.origin);
  if (!isConfigured && !isPreview && !isLocal) throw new Error(`Terugkeeradres niet toegestaan: ${url.origin}`);
  for (const key of CALENDAR_RETURN_PARAMS) url.searchParams.delete(key);
  return url.toString();
}

/** Waarheen bij een state die niet van ons is: de eerste ingestelde origin, of nergens. */
export function fallbackReturnTo(allowedOrigins: string[]): string | null {
  return allowedOrigins[0] ? `${allowedOrigins[0]}/` : null;
}

export function withReturnParams(returnTo: string, params: Record<string, string>): string {
  const target = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

// ── De state: HMAC-ondertekend, kort geldig ─────────────────────────────────

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function signOAuthState(state: OAuthState, secret: string): Promise<string> {
  if (!secret) throw new Error('CALENDAR_OAUTH_STATE_SECRET ontbreekt.');
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(state)));
  return `${payload}.${await hmac(payload, secret)}`;
}

export type OAuthStateCheck =
  | { ok: true; state: OAuthState }
  | { ok: false; reason: 'ongeldig' }
  | { ok: false; reason: 'verlopen'; state: OAuthState };

/**
 * Controleert een state. Een verlopen state met een geldige handtekening komt
 * mét inhoud terug: die is van ons, dus de callback mag de gebruiker naar het
 * terugkeeradres erin sturen met "duurde te lang". Was eerst een kale
 * JSON-pagina op het adres van Supabase.
 */
export async function checkOAuthState(
  raw: unknown, secret: string, allowedOrigins: string[], now = Math.floor(Date.now() / 1000),
): Promise<OAuthStateCheck> {
  const invalid = { ok: false as const, reason: 'ongeldig' as const };
  if (!secret || typeof raw !== 'string' || !raw || raw.length > OAUTH_STATE_MAX_LENGTH) return invalid;
  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return invalid;
  const [payload, signature] = parts;
  if (!timingSafeEqual(signature, await hmac(payload, secret))) return invalid;

  let candidate: Partial<OAuthState>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
    if (!parsed || typeof parsed !== 'object') return invalid;
    candidate = parsed as Partial<OAuthState>;
  } catch {
    return invalid;
  }

  const provider = candidate.provider;
  if (provider !== 'google' && provider !== 'microsoft') return invalid;
  const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);
  const isStamp = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
  if (!isUuid(candidate.userId) || !isUuid(candidate.organizationId) || !isUuid(candidate.nonce)) return invalid;
  if (!isStamp(candidate.iat) || !isStamp(candidate.exp)) return invalid;
  let returnTo: string;
  try {
    returnTo = sanitizeReturnTo(candidate.returnTo, allowedOrigins);
  } catch {
    return invalid;
  }
  const { iat, exp } = candidate;
  if (iat > now + OAUTH_STATE_CLOCK_SKEW_SECONDS) return invalid;
  if (exp <= iat || exp - iat > OAUTH_STATE_TTL_SECONDS + OAUTH_STATE_CLOCK_SKEW_SECONDS) return invalid;

  const state: OAuthState = {
    provider, userId: candidate.userId, organizationId: candidate.organizationId, returnTo, nonce: candidate.nonce, iat, exp,
  };
  if (exp < now) return { ok: false, reason: 'verlopen', state };
  return { ok: true, state };
}
