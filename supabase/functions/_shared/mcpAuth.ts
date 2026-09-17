// ============================================================
// Gedeelde bouwstenen voor de MCP-connector: tokens, PKCE, scopes, JSON-RPC.
//
// Dit bestand is BEWUST puur: geen Deno-imports, geen Supabase-client, geen
// netwerk. Alleen Web Crypto, dat zowel Deno als node kent. Daardoor draait
// `npm test` er rechtstreeks overheen (zie mcpAuth.test.ts) — en dat is precies
// wat je wil bij de rekensommen waar de beveiliging op rust. De helft van de
// fouten in een OAuth-implementatie zit in deze twintig regels, niet in de HTTP.
//
// Wat hier NIET staat: alles wat de database raakt. Dat leeft in de twee edge
// functions (mcp-oauth en mcp), waar de service-role en de org-grens thuishoren.
// ============================================================

import { timingSafeEqualHex } from './appPassword.ts';

// ── Tokens ───────────────────────────────────────────────────────────────────
//
// Een token is `rsfmcp.<selector>.<verifier>`.
//
// WAAROM TWEEDELIG. Een AI-client stuurt bij elke aanroep alleen dit token mee —
// wij hebben geen gebruikersnaam om de rij mee op te zoeken, zoals CalDAV die
// wel heeft. Zouden we alleen een gesalte hash bewaren, dan moesten we élke rij
// in de tabel langs met zijn eigen salt om te kijken welke past. Dus: de
// selector bewaren we plat en is de sleutel waarop we opzoeken, en van de
// verifier bewaren we uitsluitend een gesalte SHA-256. Wie de tabel leest, heeft
// niets: de selector alleen opent geen deur.

const TOKEN_PREFIX = 'rsfmcp';
const SELECTOR_BYTES = 16;
const VERIFIER_BYTES = 32;

export interface NewToken {
  /** Wat de client krijgt. Bestaat hierna nergens meer in leesbare vorm. */
  plain: string;
  /** Openbaar deel; hiermee zoeken we de rij op. */
  selector: string;
  /** Geheim deel; hiervan bewaren we alleen `hash`. */
  verifier: string;
  salt: string;
  hash: string;
}

export async function createToken(): Promise<NewToken> {
  const selector = base64Url(randomBytes(SELECTOR_BYTES));
  const verifier = base64Url(randomBytes(VERIFIER_BYTES));
  const salt = base64Url(randomBytes(16));
  return { plain: `${TOKEN_PREFIX}.${selector}.${verifier}`, selector, verifier, salt, hash: await hashVerifier(verifier, salt) };
}

/**
 * Splitst een aangeboden token. Geeft null bij alles wat niet klopt — een
 * ontbrekend deel, een verkeerd voorvoegsel, of een extra punt erin.
 */
export function parseToken(plain: string): { selector: string; verifier: string } | null {
  const parts = String(plain || '').trim().split('.');
  if (parts.length !== 3) return null;
  const [prefix, selector, verifier] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (!selector || !verifier) return null;
  if (!isBase64Url(selector) || !isBase64Url(verifier)) return null;
  return { selector, verifier };
}

export async function hashVerifier(verifier: string, salt: string): Promise<string> {
  return await sha256Hex(`${salt}:${verifier}`);
}

/**
 * Hoort deze verifier bij deze opgeslagen hash? Vergelijking in constante tijd,
 * zodat het antwoord niets over de hash verraadt via de duur van de controle.
 */
export async function verifyToken(verifier: string, salt: string, expectedHash: string): Promise<boolean> {
  return timingSafeEqualHex(await hashVerifier(verifier, salt), expectedHash);
}

/**
 * Autorisatiecode: leeft tien minuten, wordt één keer gebruikt. Daarom ongesalt
 * gehasht — hetzelfde patroon als een deellink, en genoeg bij deze entropie.
 */
export function createAuthCode(): string {
  return base64Url(randomBytes(32));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

// ── PKCE ─────────────────────────────────────────────────────────────────────
//
// PKCE is wat verhindert dat een onderschepte autorisatiecode iets waard is. De
// client verzint een geheim (`code_verifier`), stuurt bij /authorize alleen de
// hash mee (`code_challenge`), en bij /token het geheim zelf. Wie onderweg de
// code opvangt maar het geheim niet heeft, kan er niets mee.
//
// Alleen S256. `plain` bestaat ook in de standaard, maar dat is de challenge
// ONVERSLEUTELD meesturen — dan beschermt PKCE nergens meer tegen, en OAuth 2.1
// verbiedt het voor nieuwe implementaties.

/** De vorm die RFC 7636 voorschrijft: 43-128 tekens uit het unreserved-alfabet. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(String(verifier || ''));
}

export function isValidCodeChallenge(challenge: string): boolean {
  const value = String(challenge || '');
  return value.length >= 43 && value.length <= 128 && isBase64Url(value);
}

export async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  if (!isValidCodeVerifier(codeVerifier)) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const computed = base64Url(new Uint8Array(digest));
  // Constante tijd, via de hex-variant die we toch al hebben.
  return timingSafeEqualHex(hexOfString(computed), hexOfString(codeChallenge));
}

// ── Redirect-URI's ───────────────────────────────────────────────────────────
//
// Hier gaat het in de praktijk mis. Een autorisatieserver die redirect-URI's
// "ongeveer" vergelijkt (op voorvoegsel, of met een joker) stuurt de code van de
// gebruiker naar de eerste de beste plek die daar toevallig onder valt. Dus:
// EXACTE tekstvergelijking met wat er bij de registratie is opgegeven. Geen
// normalisatie, geen subpaden — en één uitzondering die de standaard zelf
// voorschrijft: de poort van een loopback-adres (zie hieronder).

export function redirectUriAllowed(registered: readonly string[], requested: string): boolean {
  const value = String(requested || '');
  if (!value) return false;
  return registered.some((uri) => uri === value || sameLoopbackApartFromPort(uri, value));
}

/**
 * De ene uitzondering op "exact": de POORT van een loopback-adres.
 *
 * Een programma op de computer van de gebruiker zelf (Claude Code, een
 * desktop-app) vangt de code op via een vrije poort die het per keer kiest. Bij
 * de volgende koppeling is dat een andere poort dan bij de registratie, en een
 * exacte vergelijking stuurt die gebruiker dan weg met "ongeldig
 * terugkeeradres". RFC 8252 §7.3 schrijft daarom voor dat de poort daar vrij is.
 *
 * Alleen de poort: host en pad-met-query blijven een letterlijke
 * tekstvergelijking, en het geldt uitsluitend voor http naar localhost,
 * 127.0.0.1 of [::1]. Zo'n adres komt per definitie uit op de computer van de
 * gebruiker, dus een andere poort stuurt de code nooit het huis uit.
 */
const LOOPBACK_REDIRECT = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(\/[^#]*)?$/;

function sameLoopbackApartFromPort(registered: string, requested: string): boolean {
  const known = LOOPBACK_REDIRECT.exec(registered);
  const asked = LOOPBACK_REDIRECT.exec(requested);
  if (!known || !asked) return false;
  const port = asked[2] === undefined ? null : Number(asked[2]);
  if (port !== null && (port < 1 || port > 65535)) return false;
  return known[1] === asked[1] && (known[3] ?? '') === (asked[3] ?? '');
}

/**
 * Mag deze redirect-URI bij registratie? Drie soorten clients moeten erlangs:
 * een webclient (https), een desktop-app die een lokale poort openzet
 * (http://localhost of 127.0.0.1 — de standaard voor native apps, RFC 8252), en
 * een app met een eigen schema (claude://…). Gewoon http naar buiten mag niet:
 * dan reist de autorisatiecode onversleuteld over het net.
 */
export function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(uri || ''));
  } catch {
    return false;
  }
  // Een fragment in een redirect-URI is in OAuth 2.1 niet toegestaan.
  if (parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:') return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  // Eigen schema van een native app: iets als `claude://` of `com.example.app://`.
  return /^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol) && !['file:', 'javascript:', 'data:', 'vbscript:'].includes(parsed.protocol);
}

// ── Scopes ───────────────────────────────────────────────────────────────────
//
// Twee niveaus:
//   `read`    — meelezen met wat het teamlid zelf ook mag zien.
//   `propose` — daarbovenop wijzigingen KLAARZETTEN in de goedkeurwachtrij. Niet
//               uitvoeren: dat blijft een klik van een mens in ResoFly.
//
// WIE BESLIST WAT. Een AI-client vraagt meestal geen scopes op naam — hij kent
// de onze niet. Daarom is wat de client (eventueel) meestuurt een PLAFOND, en
// kiest de gebruiker op het toestemmingsscherm daarbinnen. Zo staat de
// beslissing bij de mens die de gevolgen draagt, en niet bij het programma dat
// erom vraagt.

export const SCOPE_READ = 'read';
export const SCOPE_PROPOSE = 'propose';
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_PROPOSE] as const;
/** Wat de connector kan uitgeven. */
export const ISSUABLE_SCOPES = [SCOPE_READ, SCOPE_PROPOSE] as const;

export function parseScopes(raw: unknown): string[] {
  return [...new Set(String(raw ?? '').split(/[\s,]+/).filter(Boolean))];
}

/**
 * Het PLAFOND voor dit verzoek: wat de gebruiker straks ten hoogste kan toestaan.
 *
 * Vraagt de client niets (het normale geval), dan bieden we alles wat we kunnen
 * uitgeven aan en kiest de gebruiker. Noemt hij wél scopes, dan houden we ons
 * daaraan: een client die uitdrukkelijk alleen wil meelezen, hoort niet ineens
 * meer te krijgen omdat de gebruiker een vinkje liet staan.
 */
export function grantableScopes(requested: unknown): string[] {
  const asked = parseScopes(requested).filter((s) => (ISSUABLE_SCOPES as readonly string[]).includes(s));
  return asked.length > 0 ? asked : [...ISSUABLE_SCOPES];
}

/**
 * Wat de gebruiker koos, binnen het plafond. Nooit ruimer dan het ondertekende
 * verzoek — dat is wat verhindert dat een aangepast formulier meer opent dan de
 * client vroeg — en nooit leeg: zonder `read` is een koppeling zinloos.
 */
export function narrowScopes(offered: string, chosen: unknown): string[] {
  const ceiling = parseScopes(offered);
  const wanted = parseScopes(chosen).filter((s) => ceiling.includes(s));
  const result = wanted.includes(SCOPE_READ) ? wanted : [SCOPE_READ, ...wanted];
  return result.filter((s) => ceiling.includes(s) || s === SCOPE_READ);
}

export function scopeAllows(granted: string, need: string): boolean {
  return parseScopes(granted).includes(need);
}

// ── Discovery ────────────────────────────────────────────────────────────────
//
// Met deze documenten vindt een AI-client zelf uit hoe hij koppelt: welke
// autorisatieserver bij de MCP-server hoort, waar hij zich registreert, waar hij
// zijn token haalt. Ze staan hier en niet in de functies, want ze worden op twee
// plekken geserveerd (mcp én mcp-oauth) — en daar liepen twee kopieën al eens
// uit elkaar: de ene bood `propose` aan, de andere niet.

/** Scope die een client vraagt om een refresh token; geen recht in de werkruimte. */
export const SCOPE_OFFLINE_ACCESS = 'offline_access';

export interface McpDiscoveryUrls {
  /** De autorisatieserver (mcp-oauth), zonder slash aan het eind. */
  issuer: string;
  /** De MCP-server, letterlijk zoals de klant hem in zijn AI-app plakt. */
  resource: string;
  /** Uitleg voor mensen; leeg laat het veld weg. */
  documentation?: string;
}

/**
 * RFC 9728: welke autorisatieserver bij deze bron hoort.
 *
 * Noemt de 401 geen scope, dan vragen Claude en de officiële MCP-SDK's precies
 * wat hier in `scopes_supported` staat. Ontbreekt `propose`, dan komt die scope
 * nooit in het koppelverzoek en kan de gebruiker op het toestemmingsscherm alleen
 * nog meelezen toestaan.
 */
export function protectedResourceMetadata(urls: McpDiscoveryUrls): Record<string, unknown> {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [...ISSUABLE_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/**
 * RFC 8414 — of, met `openIdVariant`, hetzelfde in de vorm van OpenID Connect
 * Discovery.
 *
 * WAAROM TWEE VORMEN. Voor een issuer mét pad (…/functions/v1/mcp-oauth) zoekt
 * een client eerst op de root van het domein, zoals
 * `/.well-known/oauth-authorization-server/functions/v1/mcp-oauth`. Die root is
 * op supabase.co niet van ons: Supabase antwoordt daar zelf met een 401. Het
 * enige adres dat een client daarna nog probeert en dat wij wél beantwoorden, is
 * `…/mcp-oauth/.well-known/openid-configuration` — en dat leest hij als
 * OpenID-document. De officiële MCP-SDK (Claude Code, MCP Inspector) keurt het
 * zonder `jwks_uri`, `subject_types_supported` en
 * `id_token_signing_alg_values_supported` af, en dan stopt het koppelen nog vóór
 * het inloggen.
 *
 * Die drie velden zijn daar een vormvereiste, geen belofte. We geven geen
 * ID-tokens uit: `openid` staat niet in scopes_supported, dus niemand vraagt er
 * een, en de sleutelset achter jwks_uri is leeg omdat we niets ondertekenen. Met
 * een eigen domein ervoor (MCP_PUBLIC_BASE_URL) vindt een client het
 * RFC 8414-document al bij de eerste poging.
 */
export function authorizationServerMetadata(
  urls: McpDiscoveryUrls,
  { openIdVariant = false }: { openIdVariant?: boolean } = {},
): Record<string, unknown> {
  const { issuer } = urls;
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    // offline_access staat erbij omdat Claude en ChatGPT pas om een refresh token
    // vragen als het hier genoemd wordt. We geven er altijd een mee, en
    // grantableScopes laat de scope daarna weer vallen.
    scopes_supported: [...ISSUABLE_SCOPES, SCOPE_OFFLINE_ACCESS],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Alleen S256: de challenge onversleuteld meesturen ('plain') beschermt
    // nergens tegen en is in OAuth 2.1 niet meer toegestaan.
    code_challenge_methods_supported: ['S256'],
    // Onze clients zijn publieke clients: geen client_secret, wel verplicht PKCE.
    token_endpoint_auth_methods_supported: ['none'],
    ...(urls.documentation ? { service_documentation: urls.documentation } : {}),
    ...(openIdVariant
      ? {
        jwks_uri: `${issuer}/jwks`,
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      }
      : {}),
  };
}

// ── Het autorisatieverzoek onderweg ──────────────────────────────────────────
//
// Tussen "de AI-client stuurt de gebruiker naar ons toe" en "de gebruiker geeft
// akkoord" zit een omweg langs de browser: de gebruiker moet eerst inloggen en
// een organisatie kiezen. Alles wat de client meegaf (welke client, waar hij
// heen terugmoet, zijn PKCE-challenge) moet die omweg overleven.
//
// Wij zetten dat NIET in een tabel en ook niet los in de URL, maar in een
// HMAC-ondertekend pakketje met een korte houdbaarheid — hetzelfde als de
// agenda-koppeling met Google en Microsoft doet. Geen tabel betekent geen rij
// die blijft liggen als iemand halverwege wegklikt; de handtekening betekent dat
// een gebruiker zijn eigen verzoek niet kan ombouwen naar een andere
// redirect-URI of een ruimere scope.

/** Hoe lang een gebruiker de tijd heeft om akkoord te geven. */
export const AUTH_REQUEST_TTL_SECONDS = 15 * 60;
const AUTH_REQUEST_MAX_LENGTH = 4096;
const CLOCK_SKEW_SECONDS = 60;

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state: string;
  resource: string;
  iat: number;
  exp: number;
}

export async function signAuthRequest(request: AuthRequest, secret: string): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(request)));
  return `${payload}.${await hmac(payload, secret)}`;
}

/**
 * Leest een ondertekend verzoek terug. Gooit bij alles wat niet klopt — een
 * kapotte handtekening, een verlopen venster, of een houdbaarheid die langer is
 * dan wij ooit uitgeven (dat laatste vangt een pakketje dat met een gelekte
 * oude sleutel ooit voor een jaar is ondertekend).
 */
export async function verifyAuthRequest(raw: string, secret: string): Promise<AuthRequest> {
  const value = String(raw || '');
  if (!value || value.length > AUTH_REQUEST_MAX_LENGTH) throw new Error('Het autorisatieverzoek heeft een ongeldige lengte.');
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Het autorisatieverzoek heeft een ongeldige vorm.');
  const [payload, signature] = parts;

  const expected = await hmac(payload, secret);
  if (!timingSafeEqualHex(hexOfString(signature), hexOfString(expected))) {
    throw new Error('De handtekening van het autorisatieverzoek klopt niet.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    throw new Error('Het autorisatieverzoek is onleesbaar.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Het autorisatieverzoek is leeg.');
  const c = parsed as Partial<AuthRequest>;

  const text = (value: unknown, label: string, required = true): string => {
    if (typeof value !== 'string' || (required && !value)) throw new Error(`${label} ontbreekt in het autorisatieverzoek.`);
    return value as string;
  };
  const stamp = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`${label} is ongeldig.`);
    return value;
  };

  const request: AuthRequest = {
    clientId: text(c.clientId, 'De client'),
    redirectUri: text(c.redirectUri, 'De redirect-URI'),
    codeChallenge: text(c.codeChallenge, 'De PKCE-challenge'),
    scope: text(c.scope, 'De scope', false),
    state: text(c.state, 'De state', false),
    resource: text(c.resource, 'De resource', false),
    iat: stamp(c.iat, 'Het uitgiftemoment'),
    exp: stamp(c.exp, 'De vervaltijd'),
  };

  const now = Math.floor(Date.now() / 1000);
  if (request.exp < now) throw new Error('Het autorisatieverzoek is verlopen. Begin opnieuw vanuit je AI-client.');
  if (request.iat > now + CLOCK_SKEW_SECONDS) throw new Error('Het autorisatieverzoek ligt in de toekomst.');
  if (request.exp <= request.iat) throw new Error('Het tijdvenster van het autorisatieverzoek is ongeldig.');
  if (request.exp - request.iat > AUTH_REQUEST_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    throw new Error('Het autorisatieverzoek is te lang geldig.');
  }
  return request;
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── JSON-RPC 2.0 ─────────────────────────────────────────────────────────────
//
// MCP praat JSON-RPC. De foutcodes hieronder zijn die van de standaard; MCP
// voegt er geen eigen aan toe, maar verwacht wel dat een tool die stukloopt
// een geldig RESULTAAT teruggeeft met `isError: true` — en geen protocolfout.
// Dat onderscheid is belangrijk: een protocolfout stopt het gesprek, een
// tool-fout is iets waar het model zelf omheen kan werken.

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === '2.0' && typeof v.method === 'string' && v.method.length > 0;
}

/** Een notificatie heeft géén id en verwacht dus geen antwoord. */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined || req.id === null;
}

export function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Een tool die stukloopt: geldig resultaat, met de fout als tekst voor het model. */
export function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function toolText(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], isError: false };
}

// ── Kleine hulpjes ───────────────────────────────────────────────────────────

export function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(String(value || ''));
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Tekst als hex, zodat twee strings van gelijke lengte in constante tijd kunnen. */
function hexOfString(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) out += value.charCodeAt(i).toString(16).padStart(4, '0');
  return out;
}
