// ============================================================
// Gedeelde bouwstenen voor de openbare API (functies `api` en `api-admin`):
// sleutels, rechten, routes, idempotentie en het OpenAPI-document.
//
// Dit bestand is BEWUST puur, net als mcpAuth.ts: geen Deno-imports, geen
// Supabase-client, geen netwerk. Alleen Web Crypto, dat zowel Deno als node
// kent. Daardoor draait `npm test` er rechtstreeks overheen (zie
// publicApi.test.ts) — en hier staan precies de rekensommen waar de grenzen op
// rusten: wat een sleutel mag, hoe een modulebeperking doorwerkt, welk pad
// welke route is.
//
// Wat hier NIET staat: alles wat de database raakt. Dat leeft in de functies
// zelf, waar de service-role en de org-grens thuishoren.
// ============================================================

import {
  createToken, normalizeScopes, parseScopes, parseToken, sha256Hex,
  SCOPE_EXECUTE, SCOPE_EXECUTE_HIGH, SCOPE_PROPOSE, SCOPE_READ, type NewToken,
} from './mcpAuth.ts';

export const API_VERSION = '1.0.0';

// ── Sleutels ─────────────────────────────────────────────────────────────────
//
// Een API-sleutel is `rsfapi.<selector>.<verifier>` — dezelfde tweedeling als
// een MCP-token (zie mcpAuth.ts): de selector bewaren we plat om de rij te
// vinden, van de verifier alleen een gesalte SHA-256. Wie de tabel leest, heeft
// niets. Het eigen voorvoegsel zorgt dat een MCP-token hier al op de vorm
// strandt, en andersom.

export const API_KEY_PREFIX = 'rsfapi';

export async function createApiKey(): Promise<NewToken> {
  return await createToken(API_KEY_PREFIX);
}

/**
 * Een selector is 16 willekeurige bytes (22 tekens), een verifier 32 (43
 * tekens). Wat langer of korter is, kan geen sleutel van ons zijn en hoeft dus
 * ook niet in de database te worden opgezocht.
 */
const SELECTOR_LENGTH = 22;
const VERIFIER_LENGTH = 43;

export function parseApiKey(plain: string): { selector: string; verifier: string } | null {
  if (String(plain || '').length > 200) return null;
  const parsed = parseToken(plain, API_KEY_PREFIX);
  if (!parsed || parsed.selector.length !== SELECTOR_LENGTH || parsed.verifier.length !== VERIFIER_LENGTH) return null;
  return parsed;
}

/**
 * Het stukje dat het scherm toont, zodat iemand twee sleutels uit elkaar kan
 * houden ("rsfapi.Ab12Cd…"). Zes tekens van de selector: genoeg om te
 * herkennen, en de selector is sowieso geen geheim.
 */
export function apiKeyHint(selector: string): string {
  return `${API_KEY_PREFIX}.${String(selector || '').slice(0, 6)}…`;
}

/**
 * De sleutel uit een verzoek. `Authorization: Bearer …` is de standaard; een
 * aparte `X-Api-Key` staat er voor koppelplatforms die de Authorization-header
 * zelf willen vullen of hem niet laten aanpassen.
 *
 * Zet zo'n platform (of een Supabase-client) zelf een Authorization met iets
 * anders dan een API-sleutel — een anon-JWT bijvoorbeeld — dan telt de
 * `X-Api-Key`. Anders zou een geldige sleutel geweigerd worden omdat er een
 * andere header naast stond.
 */
export function presentedApiKey(headers: Headers): string {
  const authorization = (headers.get('authorization') || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1].trim() ?? '';
  const header = (headers.get('x-api-key') || '').trim();
  if (bearer.startsWith(`${API_KEY_PREFIX}.`)) return bearer;
  return header || bearer;
}

/**
 * Bevat de invoer ergens een NUL-teken (U+0000)? Postgres kan dat niet opslaan
 * (niet in text, niet in jsonb) en geeft dan een fout die anders als een 500
 * terugkomt. Beter meteen een 400 met de reden.
 */
/**
 * Dieper genest dan dit is geen invoer voor een handeling of een klant, en kan
 * een recursieve controle laten omvallen. Een eerlijke koppeling komt er nooit.
 */
export const MAX_JSON_DEPTH = 32;

export function tooDeep(value: unknown, max = MAX_JSON_DEPTH, depth = 0): boolean {
  if (!value || typeof value !== 'object') return false;
  if (depth >= max) return true;
  return Object.values(value as Record<string, unknown>).some((item) => tooDeep(item, max, depth + 1));
}

/**
 * Een foutmelding van een handeling voor buiten. Een handeling meldt "Klant
 * ophalen mislukt: <wat de database zei>"; dat tweede deel is voor ons logboek,
 * niet voor een koppeling (tabel- en kolomnamen, interne details). Wat op een
 * fout in de invoer wijst, blijft een 422 met een zin; wat op een storing wijst,
 * wordt een 500 — dan mag de koppeling het gewoon opnieuw proberen.
 */
export function publicActionError(message: string): { status: 422 | 500; message: string } {
  const text = String(message || '');
  const split = text.match(/^(.*?\bmislukte?):\s*(.+)$/s);
  const [head, tail] = split ? [split[1], split[2]] : ['Dit', text];
  if (!(split ? DATABASE_TEXT : STRONG_DATABASE_TEXT).test(tail)) return { status: 422, message: text };
  if (INPUT_PROBLEM.test(tail)) {
    return { status: 422, message: split ? `${head}: de invoer past niet bij de regels van ResoFly.` : 'De invoer past niet bij de regels van ResoFly.' };
  }
  return { status: 500, message: split ? `${head}.` : 'Er ging iets mis aan onze kant.' };
}

const DATABASE_TEXT = /violates|relation "|column "|syntax error|permission denied|duplicate key|invalid input|statement timeout|canceling statement|could not|does not exist|JWT|PGRST|schema cache|connection|fetch failed|timed? ?out/i;
const STRONG_DATABASE_TEXT = /violates|relation "|column "|duplicate key|invalid input syntax|PGRST|permission denied for|canceling statement/i;
const INPUT_PROBLEM = /violates (check|not-null|unique|foreign key)|duplicate key|invalid input/i;

export function containsNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (depth > 32 || !value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => key.includes('\u0000') || containsNul(item, depth + 1));
}

/** Een halve UTF-16-teken (\ud800 zonder zijn tweede helft): geen tekst die de database aanneemt. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Zit er ergens — ook in een veldnaam — een losse surrogaat in? Dan een 400, niet een 500 van de database. */
export function containsLoneSurrogate(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return LONE_SURROGATE.test(value);
  if (depth > 32 || !value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, item]) => LONE_SURROGATE.test(key) || containsLoneSurrogate(item, depth + 1));
}

// ── Wat een sleutel mag ──────────────────────────────────────────────────────
//
// Dezelfde vier treden als een AI-koppeling (zie mcpAuth.ts), en om dezelfde
// reden een trap en geen losse vinkjes: wie mag uitvoeren mag klaarzetten (dat
// is de terugval voor elke handeling zonder server-uitvoerder), en wie het
// onomkeerbare mag, mag het omkeerbare zeker.
//
// Eén verschil met de AI-koppeling: daar staan `execute` en `execute_high`
// alleen onder Instellingen → AI, nooit op het toestemmingsscherm. Een
// API-sleutel maakt een owner of admin met opzet aan, in dat zelfde
// instellingenscherm. Daar hoort de keuze dus ook thuis — bij het aanmaken, en
// daarna niet meer te verruimen: wie meer wil, maakt een nieuwe sleutel.

export type AccessLevel = 'read' | 'propose' | 'execute' | 'execute_high';

export const ACCESS_LEVELS: readonly AccessLevel[] = [SCOPE_READ, SCOPE_PROPOSE, SCOPE_EXECUTE, SCOPE_EXECUTE_HIGH] as AccessLevel[];

/** De scope-tekst bij een trede: `execute` wordt "read propose execute". */
export function scopeForLevel(level: AccessLevel): string {
  if (!ACCESS_LEVELS.includes(level)) throw new Error(`Onbekend toegangsniveau "${level}".`);
  return normalizeScopes([level]).join(' ');
}

/** De hoogste trede die in een scope-tekst zit. */
export function levelOfScope(scope: string): AccessLevel {
  const scopes = parseScopes(scope);
  if (scopes.includes(SCOPE_EXECUTE_HIGH) && scopes.includes(SCOPE_EXECUTE)) return 'execute_high';
  if (scopes.includes(SCOPE_EXECUTE)) return 'execute';
  if (scopes.includes(SCOPE_PROPOSE)) return 'propose';
  return 'read';
}

// ── Modules ──────────────────────────────────────────────────────────────────
//
// Twee lagen, en de strengste wint:
//
//   1. DE MAKER. Een sleutel werkt namens het teamlid dat hem aanmaakte, met de
//      rol en modulerechten die dat teamlid NU heeft — vers uit
//      organization_members bij elke aanroep. Wordt de maker viewer, of gaat
//      Financiën voor hem dicht, dan geldt dat meteen ook voor zijn sleutels.
//   2. DE SLEUTEL. Bij het aanmaken kan de owner/admin modules dichter zetten
//      dan hij zelf heeft: een webshop hoeft niet in de boekhouding te kijken.
//      Een sleutel kan nooit RUIMER zijn dan zijn maker; er valt alleen af te
//      knijpen.
//
// De eerste laag is een exacte spiegel van `public.org_module_level` en van
// `getModuleLevel` in edgeAuth.ts.

export const MODULE_KEYS = [
  'clients', 'projects', 'time', 'calendar', 'tickets', 'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie',
] as const;

export type ModuleKey = typeof MODULE_KEYS[number];
export type ModuleLevel = 'none' | 'read' | 'write';

export const MODULE_LABEL: Record<ModuleKey, string> = {
  clients: 'Klanten', projects: 'Projecten', time: 'Uren', calendar: 'Agenda',
  tickets: 'Tickets', content: 'Inhoud', stats: 'Statistieken',
  marketing: 'Marketing', finance: 'Financiën', chat: 'Teamchat', gerrie: 'Gerrie',
};

const LEVEL_RANK: Record<ModuleLevel, number> = { none: 0, read: 1, write: 2 };

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/** Wat het TEAMLID mag in deze module. Owners en admins zijn nooit beperkt. */
export function memberModuleLevel(
  role: string, moduleAccess: Record<string, unknown> | null | undefined, module: string,
): ModuleLevel {
  if (role === 'owner' || role === 'admin') return 'write';
  const raw = moduleAccess?.[module];
  const stored: ModuleLevel = raw === 'none' || raw === 'read' || raw === 'write' ? raw : 'write';
  if (role === 'viewer') return stored === 'none' ? 'none' : 'read';
  // Een rol die we niet kennen, krijgt niets. De database kent er vier; een
  // vijfde die er ooit bij komt, hoort hier bewust te worden toegevoegd.
  if (role !== 'member') return 'none';
  return stored;
}

/** Wat de SLEUTEL in deze module toestaat. Geen vermelding = geen extra beperking. */
export function keyModuleCap(keyAccess: Record<string, unknown> | null | undefined, module: string): ModuleLevel {
  const raw = keyAccess?.[module];
  return raw === 'none' || raw === 'read' ? raw : 'write';
}

/** Wat er met deze sleutel echt mag: de strengste van de twee. */
export function effectiveModuleLevel(
  role: string,
  memberAccess: Record<string, unknown> | null | undefined,
  keyAccess: Record<string, unknown> | null | undefined,
  module: string,
): ModuleLevel {
  const member = memberModuleLevel(role, memberAccess, module);
  const cap = keyModuleCap(keyAccess, module);
  return LEVEL_RANK[member] <= LEVEL_RANK[cap] ? member : cap;
}

/** Het hele raster in één keer, voor `GET /v1/me` en het scherm. */
export function effectiveModuleAccess(
  role: string,
  memberAccess: Record<string, unknown> | null | undefined,
  keyAccess: Record<string, unknown> | null | undefined,
): Record<ModuleKey, ModuleLevel> {
  const out = {} as Record<ModuleKey, ModuleLevel>;
  for (const module of MODULE_KEYS) out[module] = effectiveModuleLevel(role, memberAccess, keyAccess, module);
  return out;
}

/** Knijpt deze sleutel ergens af? */
export function hasKeyRestrictions(keyAccess: Record<string, unknown> | null | undefined): boolean {
  return MODULE_KEYS.some((module) => keyModuleCap(keyAccess, module) !== 'write');
}

/**
 * Wat er bij het aanmaken als beperking wordt opgeslagen.
 *
 * Alleen 'none' en 'read' komen in de database; 'write' is "geen beperking" en
 * valt weg. Een onbekende module of een onbekend niveau is een FOUT en geen
 * stilzwijgend weggelaten regel: wie "finanse: none" typt, hoort dat te horen in
 * plaats van een sleutel te krijgen die ongemerkt wél in de boekhouding kijkt.
 */
export function normalizeKeyModuleAccess(raw: unknown): Record<string, 'none' | 'read'> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('De modulebeperking moet een object zijn, bijvoorbeeld {"finance": "none"}.');
  const out: Record<string, 'none' | 'read'> = {};
  for (const [module, level] of Object.entries(raw as Record<string, unknown>)) {
    if (!isModuleKey(module)) throw new Error(`Onbekende module "${module}". Kies uit: ${MODULE_KEYS.join(', ')}.`);
    if (level === 'write') continue;
    if (level !== 'none' && level !== 'read') throw new Error(`Ongeldig niveau "${String(level)}" voor ${module}: gebruik none, read of write.`);
    out[module] = level;
  }
  return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────
//
// De functie draait onder `/functions/v1/api`, maar kan ook achter een eigen
// domein staan (`https://api.jouwdomein.nl/v1/...`). Daarom vergelijken we op
// de staart van het pad, net als de MCP-functies: alles tot en met de
// functienaam valt weg, en wat overblijft begint met `/v1`.

export function apiRoute(pathname: string): string {
  let path = String(pathname || '/').replace(/\/+$/, '') || '/';
  path = path.replace(/^\/functions\/v1(?=\/|$)/, '');
  path = path.replace(/^\/api(?=\/|$)/, '');
  return path || '/';
}

/**
 * `/v1/actions/:id` tegen een route. Geeft de parameters terug, of null. Een
 * parameter met een kapotte procentcodering is geen parameter maar een fout pad.
 */
export function matchRoute(route: string, pattern: string): Record<string, string> | null {
  const actual = route.split('/').filter(Boolean);
  const wanted = pattern.split('/').filter(Boolean);
  if (actual.length !== wanted.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < wanted.length; i += 1) {
    if (wanted[i].startsWith(':')) {
      try {
        params[wanted[i].slice(1)] = decodeURIComponent(actual[i]);
      } catch {
        return null;
      }
    } else if (actual[i] !== wanted[i]) {
      return null;
    }
  }
  return params;
}

// ── Lijsten ──────────────────────────────────────────────────────────────────

export function clampInt(raw: string | null | undefined, min: number, max: number, fallback: number): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Een parameter in de querystring die niet klopt: een 400, met het veld erbij. */
export class InvalidParamError extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = 'InvalidParamError';
    this.field = field;
  }
}

/**
 * `?limit=` en `?offset=`: een geheel getal, of weglaten. Te groot wordt de
 * grens (limit=5000 geeft het maximum, met has_more); "abc" of -3 is een fout —
 * net als bij de vaste adressen.
 */
export function pageParams(
  params: URLSearchParams, { defaultLimit = 25, maxLimit = 100 }: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const number = (name: string, range: string, min: number, max: number, fallback: number): number => {
    const raw = (params.get(name) ?? '').trim();
    if (!raw) return fallback;
    if (!/^\d{1,15}$/.test(raw)) throw new InvalidParamError(`"${name}" moet een geheel getal ${range} zijn.`, name);
    return Math.min(Math.max(Number(raw), min), max);
  };
  return {
    limit: number('limit', `(1 tot ${maxLimit})`, 1, maxLimit, defaultLimit),
    offset: number('offset', '(0 of meer)', 0, 1_000_000, 0),
  };
}

// ── Voorstellen ──────────────────────────────────────────────────────────────
//
// Wat een sleutel zonder uitvoerrecht wil wijzigen, komt als voorstel in de
// goedkeurwachtrij (ai_action_audit, status 'proposed') — dezelfde wachtrij als
// die van de geplande agents en de AI-koppelingen. Een koppeling wil daarna
// weten hoe het afliep. Dit is de vertaling van de interne statussen naar wat
// de API belooft.
//
// "Afgewezen" bestaat intern niet als eigen status: de wachtrij zet een
// afgewezen voorstel op 'failed' met precies deze zin (AgentApprovals.tsx).
// publicApiServer.test.ts houdt die twee plekken gelijk.

export type ProposalStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'failed' | 'cancelled';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ['pending', 'approved', 'executed', 'rejected', 'failed', 'cancelled'];

export const REJECTED_BY_USER_DETAIL = 'Afgewezen door gebruiker.';

export function proposalStatus(auditStatus: string, detail?: string | null): ProposalStatus {
  switch (auditStatus) {
    case 'proposed': return 'pending';
    case 'confirmed': return 'approved';
    case 'executed':
    case 'auto_executed': return 'executed';
    case 'cancelled': return 'cancelled';
    case 'failed': return detail === REJECTED_BY_USER_DETAIL ? 'rejected' : 'failed';
    default: return 'failed';
  }
}

/** De interne statussen die bij een API-status horen, om op te filteren. */
export function auditStatusesFor(status: ProposalStatus): string[] {
  switch (status) {
    case 'pending': return ['proposed'];
    case 'approved': return ['confirmed'];
    case 'executed': return ['executed', 'auto_executed'];
    case 'cancelled': return ['cancelled'];
    case 'rejected':
    case 'failed': return ['failed'];
  }
}

// ── Idempotentie ─────────────────────────────────────────────────────────────
//
// Een koppelplatform dat een time-out krijgt, probeert het opnieuw — en dan
// staat dezelfde klant er twee keer in. Met een `Idempotency-Key` krijgt de
// tweede poging het antwoord van de eerste terug in plaats van een tweede
// uitvoering. De sleutel hoort bij één verzoek: dezelfde sleutel met een andere
// inhoud is een fout van de aanroeper, geen herhaling.

export function isValidIdempotencyKey(value: string): boolean {
  return /^[\x21-\x7e]{1,255}$/.test(String(value || ''));
}

/**
 * Wat een verzoek uniek maakt voor een Idempotency-Key: methode, pad MET de
 * zoekparameters (`?mode=queue` is een ander verzoek dan zonder) en de inhoud.
 */
export async function requestFingerprint(method: string, route: string, body: string, search = ''): Promise<string> {
  return await sha256Hex(`${String(method).toUpperCase()} ${route}${search}\n${body}`);
}

// ── Fouten ───────────────────────────────────────────────────────────────────
//
// Elke fout heeft dezelfde vorm, met een vaste `code` voor programma's en een
// `message` voor mensen. De code verandert nooit; de zin mag beter worden.

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'insufficient_scope'
  | 'not_found'
  | 'unknown_action'
  | 'invalid_request'
  | 'invalid_input'
  | 'method_not_allowed'
  | 'conflict'
  | 'idempotency_conflict'
  | 'idempotency_in_progress'
  | 'payload_too_large'
  | 'rate_limited'
  | 'queue_full'
  | 'internal_error';

export function errorBody(
  code: ApiErrorCode, message: string, requestId: string, details?: Record<string, unknown>,
): Record<string, unknown> {
  return { error: { code, message, request_id: requestId, ...(details ? { details } : {}) } };
}

// ── De catalogus ─────────────────────────────────────────────────────────────

/** Wat de API van een handeling laat zien. Zelfde velden als ActionDef, zonder de functies. */
export interface CatalogAction {
  id: string;
  label: string;
  module: string;
  kind: 'read' | 'write';
  risk?: 'normal' | 'high';
  description: string;
  input: Record<string, unknown>;
  required?: string[];
}

/** Het invoerschema van een handeling als volwaardig JSON-schema. */
export function actionInputSchema(action: CatalogAction): Record<string, unknown> {
  return {
    type: 'object',
    properties: action.input ?? {},
    ...(action.required && action.required.length > 0 ? { required: action.required } : {}),
  };
}

/** `invoice.set_status` → `invoice_set_status`: een geldige operationId. */
export function operationIdFor(actionId: string): string {
  return `action_${String(actionId).replace(/[^A-Za-z0-9]+/g, '_')}`;
}

// ── OpenAPI ──────────────────────────────────────────────────────────────────
//
// Het document wordt GEGENEREERD uit de registry, niet met de hand bijgehouden.
// Een handeling die erbij komt, staat er bij de volgende uitrol vanzelf in —
// met zijn eigen pad, zijn eigen invoerschema en zijn eigen omschrijving. Zo kan
// het document niet achterlopen op wat de API werkelijk kan, en kan een
// koppelplatform (Postman, Make, n8n) het rechtstreeks inlezen.

export interface OpenApiOptions {
  /** De basis tot en met de functie, zonder slash: `https://…/functions/v1/api`. */
  serverUrl: string;
  actions: CatalogAction[];
  /** Uitleg voor mensen; leeg laat het veld weg. */
  docsUrl?: string;
  /** Wat er verder in hoort (de vaste adressen uit apiResources.ts). */
  extra?: { tags: Array<{ name: string; description: string }>; paths: Record<string, unknown>; schemas: Record<string, unknown> };
}

const JSON_CONTENT = 'application/json';

function ref(name: string): Record<string, string> {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schemaName: string): Record<string, unknown> {
  return { description, content: { [JSON_CONTENT]: { schema: ref(schemaName) } } };
}

const ERROR_RESPONSES: Record<string, unknown> = {
  400: jsonResponse('Het verzoek zelf klopt niet: geen geldige JSON, een onbekende parameterwaarde of een ongeldige Idempotency-Key.', 'Error'),
  401: jsonResponse('Geen of een ongeldige API-sleutel.', 'Error'),
  403: jsonResponse('De sleutel mag dit niet (scope of modulerecht).', 'Error'),
  429: jsonResponse('Te veel verzoeken; wacht het aantal seconden uit `Retry-After`.', 'Error'),
};

/** Wat er bij een verzoek MET invoer nog bij kan komen. */
const BODY_ERRORS: Record<string, unknown> = {
  413: jsonResponse('De invoer is te groot.', 'Error'),
};

/** En bij een schrijfverzoek, dat een Idempotency-Key kan dragen. */
const WRITE_ERRORS: Record<string, unknown> = {
  ...BODY_ERRORS,
  409: jsonResponse('Een verzoek met dezelfde Idempotency-Key is nog bezig; probeer het na `Retry-After` opnieuw.', 'Error'),
};

export function buildOpenApi(opts: OpenApiOptions): Record<string, unknown> {
  const modules = [...new Set(opts.actions.map((a) => a.module))].sort();
  const tags = [
    { name: 'Algemeen', description: 'Sleutel, organisatie en rechten.' },
    { name: 'Handelingen', description: 'Alles wat de app kan, als handeling met een eigen invoerschema.' },
    { name: 'Voorstellen', description: 'Wijzigingen die op goedkeuring in ResoFly wachten.' },
    { name: 'Webhooks', description: 'Laat ResoFly een ondertekend bericht sturen als er iets gebeurt.' },
    ...(opts.extra?.tags ?? []),
    ...modules.map((m) => ({
      name: `module:${m}`,
      description: `Handelingen in de module ${MODULE_LABEL[m as ModuleKey] ?? m}.`,
    })),
  ];

  const paths: Record<string, unknown> = {
    '/v1/me': {
      get: {
        tags: ['Algemeen'],
        operationId: 'getMe',
        summary: 'Wie ben ik: organisatie, sleutel en rechten',
        responses: { 200: jsonResponse('De sleutel en wat hij mag.', 'Me'), ...ERROR_RESPONSES },
      },
    },
    '/v1/actions': {
      get: {
        tags: ['Handelingen'],
        operationId: 'listActions',
        summary: 'Handelingen die deze sleutel kan gebruiken',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Zoekterm in gewone woorden, bijvoorbeeld "openstaande facturen".' },
          { name: 'module', in: 'query', schema: { type: 'string', enum: [...MODULE_KEYS] } },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['read', 'write'] } },
          // Ruimer dan de rest: de catalogus in één keer ophalen moet kunnen.
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
          { $ref: '#/components/parameters/Offset' },
        ],
        responses: { 200: jsonResponse('Een pagina uit de catalogus.', 'ActionList'), ...ERROR_RESPONSES },
      },
    },
    '/v1/actions/{action_id}': {
      parameters: [{ name: 'action_id', in: 'path', required: true, schema: { type: 'string' }, example: 'invoice.set_status' }],
      get: {
        tags: ['Handelingen'],
        operationId: 'getAction',
        summary: 'Eén handeling met zijn invoerschema',
        responses: { 200: jsonResponse('De handeling.', 'Action'), 404: jsonResponse('Onbekende handeling.', 'Error'), ...ERROR_RESPONSES },
      },
      post: {
        tags: ['Handelingen'],
        operationId: 'runAction',
        summary: 'Een handeling uitvoeren (lezen), of een wijziging uitvoeren of klaarzetten',
        description:
          'Een LEES-handeling geeft meteen de gegevens terug (200). Een SCHRIJF-handeling wordt rechtstreeks uitgevoerd (200, `status: "executed"`) '
          + 'als de sleutel dat mag en ResoFly de handeling op de server kan uitvoeren; anders komt hij als voorstel in de goedkeurwachtrij '
          + '(202, `status: "queued"`) en gebeurt hij pas als iemand in ResoFly op Uitvoeren klikt. Met `?mode=queue` zet je hem altijd klaar.',
        parameters: [
          { name: 'mode', in: 'query', schema: { type: 'string', enum: ['auto', 'queue'], default: 'auto' } },
          { $ref: '#/components/parameters/IdempotencyKey' },
        ],
        requestBody: { required: false, content: { [JSON_CONTENT]: { schema: { type: 'object', description: 'De invoervelden uit het schema van de handeling.' } } } },
        responses: {
          200: jsonResponse('Gelezen of uitgevoerd.', 'ActionResult'),
          202: jsonResponse('Klaargezet voor goedkeuring.', 'Queued'),
          404: jsonResponse('Onbekende handeling.', 'Error'),
          422: jsonResponse('De invoer klopt niet; `message` zegt wat er mis is.', 'Error'),
          ...WRITE_ERRORS,
          ...ERROR_RESPONSES,
        },
      },
    },
    '/v1/proposals': {
      get: {
        tags: ['Voorstellen'],
        operationId: 'listProposals',
        summary: 'Voorstellen die deze sleutel heeft klaargezet',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: [...PROPOSAL_STATUSES] } },
          { $ref: '#/components/parameters/Limit' },
          { $ref: '#/components/parameters/Offset' },
        ],
        responses: { 200: jsonResponse('Een pagina voorstellen.', 'ProposalList'), ...ERROR_RESPONSES },
      },
    },
    '/v1/proposals/{proposal_id}': {
      get: {
        tags: ['Voorstellen'],
        operationId: 'getProposal',
        summary: 'Hoe staat het met dit voorstel?',
        parameters: [{ name: 'proposal_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: jsonResponse('Het voorstel.', 'Proposal'), 404: jsonResponse('Niet gevonden.', 'Error'), ...ERROR_RESPONSES },
      },
    },
  };

  const webhookId = { name: 'webhook_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  Object.assign(paths, {
    '/v1/events': {
      get: {
        tags: ['Webhooks'],
        operationId: 'listEvents',
        summary: 'Gebeurtenissen waarop je een webhook kunt zetten',
        responses: { 200: jsonResponse('De catalogus, beperkt tot wat deze sleutel mag lezen.', 'EventList'), ...ERROR_RESPONSES },
      },
    },
    '/v1/webhooks': {
      get: {
        tags: ['Webhooks'],
        operationId: 'listWebhooks',
        summary: 'Webhooks die deze sleutel heeft aangemaakt',
        responses: { 200: jsonResponse('De eindpunten.', 'WebhookList'), ...ERROR_RESPONSES },
      },
      post: {
        tags: ['Webhooks'],
        operationId: 'createWebhook',
        summary: 'Een webhook aanmaken',
        description: 'Geeft het ondertekengeheim (`secret`) één keer terug. Elk bericht draagt `ResoFly-Signature: t=<tijd>,v1=<HMAC-SHA256 van "<tijd>.<body>">`.',
        requestBody: { required: true, content: { [JSON_CONTENT]: { schema: ref('WebhookInput') } } },
        responses: { 201: jsonResponse('Aangemaakt, met het geheim.', 'WebhookCreated'), 422: jsonResponse('Adres of gebeurtenissen kloppen niet.', 'Error'), ...BODY_ERRORS, ...ERROR_RESPONSES },
      },
    },
    '/v1/webhooks/{webhook_id}': {
      parameters: [webhookId],
      get: {
        tags: ['Webhooks'], operationId: 'getWebhook', summary: 'Eén webhook',
        responses: { 200: jsonResponse('Het eindpunt.', 'Webhook'), 404: jsonResponse('Niet gevonden.', 'Error'), ...ERROR_RESPONSES },
      },
      patch: {
        tags: ['Webhooks'], operationId: 'updateWebhook', summary: 'Adres, gebeurtenissen, omschrijving of aan/uit wijzigen',
        requestBody: { required: true, content: { [JSON_CONTENT]: { schema: ref('WebhookInput') } } },
        responses: { 200: jsonResponse('Gewijzigd.', 'Webhook'), 404: jsonResponse('Niet gevonden.', 'Error'), 422: jsonResponse('Klopt niet.', 'Error'), ...BODY_ERRORS, ...ERROR_RESPONSES },
      },
      delete: {
        tags: ['Webhooks'], operationId: 'deleteWebhook', summary: 'Een webhook verwijderen',
        responses: { 204: { description: 'Verwijderd.' }, 404: jsonResponse('Niet gevonden.', 'Error'), ...ERROR_RESPONSES },
      },
    },
    '/v1/webhooks/{webhook_id}/test': {
      parameters: [webhookId],
      post: {
        tags: ['Webhooks'], operationId: 'testWebhook', summary: 'Meteen een testbericht (`ping`) sturen',
        responses: { 200: jsonResponse('Hoe het eindpunt antwoordde.', 'WebhookTestResult'), 404: jsonResponse('Niet gevonden.', 'Error'), ...ERROR_RESPONSES },
      },
    },
    '/v1/webhooks/{webhook_id}/deliveries': {
      parameters: [webhookId],
      get: {
        tags: ['Webhooks'], operationId: 'listWebhookDeliveries', summary: 'De laatste bezorgingen van een webhook',
        parameters: [{ $ref: '#/components/parameters/Limit' }],
        responses: { 200: jsonResponse('Bezorgingen, nieuwste eerst.', 'DeliveryList'), 404: jsonResponse('Niet gevonden.', 'Error'), ...ERROR_RESPONSES },
      },
    },
  });

  if (opts.extra) Object.assign(paths, opts.extra.paths);

  // Elke handeling ook als eigen pad, met zijn eigen invoerschema. Dat maakt het
  // document groot, maar het is precies wat een koppelplatform nodig heeft om er
  // een formulier van te maken.
  for (const action of [...opts.actions].sort((a, b) => a.id.localeCompare(b.id))) {
    const risky = action.risk === 'high';
    paths[`/v1/actions/${action.id}`] = {
      post: {
        tags: [`module:${action.module}`],
        operationId: operationIdFor(action.id),
        summary: action.label,
        description: [
          action.description,
          action.kind === 'write'
            ? `Schrijf-handeling${risky ? ' (onomkeerbaar of naar buiten gericht: rechtstreeks uitvoeren vraagt toegangsniveau `execute_high`)' : ''}.`
            : 'Lees-handeling.',
        ].join('\n\n'),
        ...(action.kind === 'write' ? { parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }] } : {}),
        requestBody: { required: (action.required ?? []).length > 0, content: { [JSON_CONTENT]: { schema: actionInputSchema(action) } } },
        responses: action.kind === 'write'
          ? {
            200: jsonResponse('Uitgevoerd.', 'ActionResult'),
            202: jsonResponse('Klaargezet voor goedkeuring.', 'Queued'),
            422: jsonResponse('De invoer klopt niet.', 'Error'),
            ...WRITE_ERRORS,
            ...ERROR_RESPONSES,
          }
          : { 200: jsonResponse('De gegevens.', 'ActionResult'), 422: jsonResponse('De invoer klopt niet.', 'Error'), ...BODY_ERRORS, ...ERROR_RESPONSES },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ResoFly API',
      version: API_VERSION,
      description:
        'Koppel andere software aan je ResoFly-werkruimte. Maak een sleutel aan onder Instellingen → API & webhooks en stuur hem mee als '
        + '`Authorization: Bearer rsfapi.…`. Een sleutel werkt namens het teamlid dat hem aanmaakte, met diens rechten — en nooit ruimer.',
    },
    ...(opts.docsUrl ? { externalDocs: { description: 'Handleiding', url: opts.docsUrl } } : {}),
    servers: [{ url: opts.serverUrl }],
    security: [{ apiKey: [] }],
    tags,
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'rsfapi.<selector>.<verifier>' },
      },
      parameters: {
        Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
        Offset: {
          name: 'offset', in: 'query', description: 'Hoeveel er overgeslagen worden. Bij de vaste adressen hooguit 10000; verder geeft 400.',
          schema: { type: 'integer', minimum: 0, default: 0 },
        },
        IdempotencyKey: {
          name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 },
          description: 'Maakt een herhaald verzoek veilig: dezelfde sleutel binnen 24 uur geeft het eerste antwoord terug in plaats van een tweede uitvoering.',
        },
      },
      schemas: {
        ...(opts.extra?.schemas ?? {}),
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'request_id'],
              properties: {
                code: { type: 'string', description: 'Vaste foutcode, bijvoorbeeld `invalid_input` of `insufficient_scope`.' },
                message: { type: 'string', description: 'Uitleg voor mensen.' },
                request_id: { type: 'string' },
                details: { type: 'object' },
              },
            },
          },
        },
        Me: {
          type: 'object',
          properties: {
            organization: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } },
            key: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' }, name: { type: 'string' },
                access: { type: 'string', enum: [...ACCESS_LEVELS] }, scopes: { type: 'array', items: { type: 'string' } },
                module_restrictions: {
                  type: 'object', additionalProperties: { type: 'string', enum: ['none', 'read', 'write'] },
                  description: 'Modules die deze sleutel extra beperkt, bovenop de rechten van het teamlid.',
                },
                expires_at: { type: ['string', 'null'], format: 'date-time' },
                created_at: { type: 'string', format: 'date-time' },
              },
            },
            acting_as: { type: 'object', properties: { user_id: { type: 'string', format: 'uuid' }, role: { type: 'string' } } },
            modules: { type: 'object', additionalProperties: { type: 'string', enum: ['none', 'read', 'write'] } },
            today: { type: 'string', format: 'date' },
            timezone: { type: 'string' },
            rate_limit: {
              type: 'object',
              properties: { limit: { type: 'integer' }, remaining: { type: 'integer' }, window_seconds: { type: 'integer' } },
            },
            counts: {
              type: 'object',
              description: 'Hoeveel handelingen deze sleutel kan gebruiken; `direct_write_actions` voert hij zelf uit, de rest van de schrijf-handelingen wacht op een akkoord.',
              properties: { read_actions: { type: 'integer' }, write_actions: { type: 'integer' }, direct_write_actions: { type: 'integer' } },
            },
          },
        },
        Action: {
          type: 'object',
          properties: {
            id: { type: 'string' }, label: { type: 'string' }, module: { type: 'string' },
            kind: { type: 'string', enum: ['read', 'write'] }, risk: { type: 'string', enum: ['normal', 'high'] },
            description: { type: 'string' }, input_schema: { type: 'object' },
            execution: { type: 'string', enum: ['direct', 'approval'], description: 'Alleen bij schrijf-handelingen: wat er met DEZE sleutel gebeurt.' },
          },
        },
        ActionList: {
          type: 'object',
          properties: {
            data: { type: 'array', items: ref('Action') },
            total: { type: 'integer' }, has_more: { type: 'boolean' },
            query: { type: 'string', description: 'Alleen bij `?q=`: de zoekterm, en dan staan de beste treffers bovenaan.' },
          },
        },
        ActionResult: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            status: { type: 'string', enum: ['ok', 'executed'] },
            data: { description: 'Bij een lees-handeling: de gegevens.' },
            result: { type: 'string', description: 'Bij een uitvoering: wat er gebeurd is, in één zin.' },
            audit_id: { type: ['string', 'null'] },
          },
        },
        Queued: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            status: { type: 'string', enum: ['queued'] },
            proposal: ref('Proposal'),
            reason: { type: 'string', description: 'Waarom het een voorstel werd in plaats van een uitvoering.' },
          },
        },
        Proposal: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            action: { type: 'string' },
            status: { type: 'string', enum: [...PROPOSAL_STATUSES] },
            title: { type: 'string' }, details: { type: ['string', 'null'] },
            irreversible: { type: 'boolean' },
            result: { type: ['string', 'null'], description: 'Wat er na het goedkeuren gebeurde, of waarom het mislukte.' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        ProposalList: {
          type: 'object',
          properties: { data: { type: 'array', items: ref('Proposal') }, has_more: { type: 'boolean' } },
        },
        EventList: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: { type: 'object', properties: { type: { type: 'string', example: 'invoice.paid' }, module: { type: 'string' }, label: { type: 'string' } } },
            },
          },
        },
        WebhookInput: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri', description: 'Alleen https, en een adres dat vanaf internet bereikbaar is.' },
            events: { type: 'array', items: { type: 'string' }, description: 'Exacte types (`invoice.paid`), een onderwerp (`invoice.*`) of alles (`*`).' },
            description: { type: 'string', maxLength: 200 },
            active: { type: 'boolean' },
          },
        },
        Webhook: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }, url: { type: 'string' }, description: { type: 'string' },
            events: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' },
            disabled_reason: { type: ['string', 'null'] }, consecutive_failures: { type: 'integer' },
            last_success_at: { type: ['string', 'null'], format: 'date-time' },
            last_failure_at: { type: ['string', 'null'], format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        WebhookList: { type: 'object', properties: { data: { type: 'array', items: ref('Webhook') } } },
        WebhookCreated: {
          type: 'object',
          properties: { webhook: ref('Webhook'), secret: { type: 'string', description: 'Het ondertekengeheim (`whsec_…`). Alleen nu te zien.' } },
        },
        WebhookTestResult: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['delivered', 'failed', 'skipped'] },
            http_status: { type: ['integer', 'null'] }, error: { type: ['string', 'null'] }, duration_ms: { type: 'integer' },
            delivery_id: { type: 'string', format: 'uuid', description: 'Terug te vinden onder /deliveries.' },
            event_id: { type: 'string', format: 'uuid', description: 'Staat ook in het bericht zelf, als `id`.' },
          },
        },
        DeliveryList: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  status: { type: 'string', enum: ['pending', 'sending', 'delivered', 'failed', 'skipped'] },
                  attempts: { type: 'integer' }, response_status: { type: ['integer', 'null'] }, error: { type: ['string', 'null'] },
                  event_id: { type: 'string', format: 'uuid' }, event_type: { type: 'string' },
                  event_created_at: { type: ['string', 'null'], format: 'date-time', description: 'Wanneer de gebeurtenis zelf plaatsvond.' },
                  created_at: { type: 'string', format: 'date-time' }, delivered_at: { type: ['string', 'null'], format: 'date-time' },
                  last_attempt_at: { type: ['string', 'null'], format: 'date-time' },
                  next_attempt_at: { type: ['string', 'null'], format: 'date-time', description: 'Bij `pending`: wanneer de volgende poging komt.' },
                },
              },
            },
          },
        },
      },
    },
  };
}
