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

export function parseApiKey(plain: string): { selector: string; verifier: string } | null {
  return parseToken(plain, API_KEY_PREFIX);
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
 */
export function presentedApiKey(headers: Headers): string {
  const authorization = (headers.get('authorization') || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer) return bearer[1].trim();
  return (headers.get('x-api-key') || '').trim();
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

/** `?limit=` en `?offset=`, met een harde bovengrens. */
export function pageParams(
  params: URLSearchParams, { defaultLimit = 25, maxLimit = 100 }: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  return {
    limit: clampInt(params.get('limit'), 1, maxLimit, defaultLimit),
    offset: clampInt(params.get('offset'), 0, 1_000_000, 0),
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

export async function requestFingerprint(method: string, route: string, body: string): Promise<string> {
  return await sha256Hex(`${String(method).toUpperCase()} ${route}\n${body}`);
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
}

const JSON_CONTENT = 'application/json';

function ref(name: string): Record<string, string> {
  return { $ref: `#/components/schemas/${name}` };
}

function jsonResponse(description: string, schemaName: string): Record<string, unknown> {
  return { description, content: { [JSON_CONTENT]: { schema: ref(schemaName) } } };
}

const ERROR_RESPONSES: Record<string, unknown> = {
  401: jsonResponse('Geen of een ongeldige API-sleutel.', 'Error'),
  403: jsonResponse('De sleutel mag dit niet (scope of modulerecht).', 'Error'),
  429: jsonResponse('Te veel verzoeken; wacht het aantal seconden uit `Retry-After`.', 'Error'),
};

export function buildOpenApi(opts: OpenApiOptions): Record<string, unknown> {
  const modules = [...new Set(opts.actions.map((a) => a.module))].sort();
  const tags = [
    { name: 'Algemeen', description: 'Sleutel, organisatie en rechten.' },
    { name: 'Handelingen', description: 'Alles wat de app kan, als handeling met een eigen invoerschema.' },
    { name: 'Voorstellen', description: 'Wijzigingen die op goedkeuring in ResoFly wachten.' },
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
          { $ref: '#/components/parameters/Limit' },
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
            ...ERROR_RESPONSES,
          }
          : { 200: jsonResponse('De gegevens.', 'ActionResult'), 422: jsonResponse('De invoer klopt niet.', 'Error'), ...ERROR_RESPONSES },
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
        Offset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        IdempotencyKey: {
          name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 },
          description: 'Maakt een herhaald verzoek veilig: dezelfde sleutel binnen 24 uur geeft het eerste antwoord terug in plaats van een tweede uitvoering.',
        },
      },
      schemas: {
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
                expires_at: { type: ['string', 'null'], format: 'date-time' },
              },
            },
            acting_as: { type: 'object', properties: { user_id: { type: 'string', format: 'uuid' }, role: { type: 'string' } } },
            modules: { type: 'object', additionalProperties: { type: 'string', enum: ['none', 'read', 'write'] } },
            today: { type: 'string', format: 'date' },
            timezone: { type: 'string' },
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
      },
    },
  };
}
