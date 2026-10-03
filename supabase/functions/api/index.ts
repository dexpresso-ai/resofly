// ============================================================
// api — de openbare API van ResoFly. Hier praat andere software.
//
// De MCP-connector (functie `mcp`) is de deur voor de eigen AI van een klant.
// Deze functie is de deur voor al het andere: een webshop die klanten aanmaakt,
// een urenapp die uren boekt, een koppelplatform (Zapier, Make, n8n) dat
// gegevens ophaalt of iets in gang zet. Gewone HTTP en JSON, met een
// API-sleutel die een owner of admin aanmaakt onder Instellingen → API &
// webhooks.
//
// ÉÉN WEG NAAR DE GEGEVENS
// De API bouwt niets na. Wat hij kan, is de handelingenregistry
// (_shared/actions/) plus Gerrie's kerntools — precies wat Gerrie en de MCP
// ook kunnen, langs precies dezelfde `read()`, `plan()`, `runGerrieTool` en
// `buildProposal`. Er komt dus geen tweede implementatie bij die stil uit de
// pas kan lopen; er komt een tweede manier bij om die ene weg aan te roepen.
//
// DE VIER HARDE REGELS GELDEN OOK HIER — juist hier, want dit is een deur naar
// buiten:
//  1. organization_id komt uit de SLEUTEL, nooit uit wat de aanroeper meestuurt.
//     Er bestaat geen invoerveld voor; actionTenancy.test.ts bewaakt dat geen
//     handeling hem uit de invoer leest.
//  2. Elke query is org-scoped; de service-role slaat RLS over, dus dat filter
//     is de enige grens.
//  3. SCHRIJVEN GAAT LANGS EEN MENS — tenzij de owner/admin bij het aanmaken van
//     de sleutel anders koos. Standaard zet een sleutel een wijziging KLAAR in de
//     goedkeurwachtrij. Met toegangsniveau `execute` voert hij rechtstreeks uit,
//     maar alleen handelingen met een server-uitvoerder in apply.ts, en het
//     onomkeerbare alleen met `execute_high`. Al het andere valt terug op een
//     voorstel, met de reden erbij.
//  4. Gegevens uit de database zijn DATA. De payload van een wijziging komt uit
//     ONS `plan()` of `buildProposal`, niet uit de aanroeper: die levert invoer,
//     wij bepalen wat er precies gebeurt.
//
// VASTE ADRESSEN
// Naast /v1/actions staan klanten, contactpersonen, projecten, taken, tickets
// (met reacties) en uren als gewone REST-resources: /v1/clients, /v1/tasks
// enzovoort (apiResourceSpecs.ts). Lezen met de service-role en het org-filter;
// aanmaken en wijzigen RECHTSTREEKS met toegangsniveau `execute`, en dan niet
// met de service-role maar als het teamlid achter de sleutel (api_rest_write in
// de database): met de RLS, triggers en het auditlog van de app zelf.
//
// WIE ER AAN DE ANDERE KANT ZIT
// Een sleutel werkt namens het teamlid dat hem aanmaakte, met de rol en de
// modulerechten die dat teamlid NU heeft (vers uit organization_members, bij
// elke aanroep). Daarbovenop kan de sleutel modules dichter zetten. Nooit
// ruimer: zie effectiveModuleLevel in publicApi.ts.
//
// Waarom verify_jwt = false (supabase/config.toml): de aanroeper heeft geen
// Supabase-sessie. Hij authenticeert met zijn API-sleutel, en die wordt
// hieronder bij elke aanroep gecontroleerd en teruggeleid naar een teamlid, een
// organisatie en diens rechten.
// ============================================================

import { createAdminClient, requiredEnv } from '../_shared/edgeAuth.ts';
import { localYmd } from '../_shared/schedule.ts';
import { ACTIONS } from '../_shared/actions/index.ts';
import { getAction, searchActions } from '../_shared/actions/registry.ts';
import { ActionError, type ActionCtx, type ActionDef } from '../_shared/actions/types.ts';
import { directApplier } from '../_shared/actions/apply.ts';
import {
  GERRIE_CORE_ACTIONS, getGerrieCoreAction, runGerrieTool, buildProposal, describeProposal,
  type GerrieContext, type OrganizationRole, type Proposal,
} from '../_shared/gerrieCore.ts';
import { severityForProposal } from '../_shared/signalRules.ts';
import {
  parseScopes, scopeAllows, verifyToken, SCOPE_EXECUTE, SCOPE_EXECUTE_HIGH, SCOPE_PROPOSE, SCOPE_READ,
} from '../_shared/mcpAuth.ts';
import {
  createEndpoint, deleteEndpoint, getEndpoint, listDeliveries, listEndpoints, testEndpoint, updateEndpoint,
  visibleEvents, WebhookInputError, type EndpointOwner,
} from '../_shared/webhookAdmin.ts';
import {
  normalizeInput, parseListParams, resourceOpenApi, ResourceInputError, type ResourceSpec,
} from '../_shared/apiResources.ts';
import { matchResource, RESOURCE_LIST, RESOURCES } from '../_shared/apiResourceSpecs.ts';
import { createRow, getRow, listRows, ResourceStoreError, updateRow, type StoreCtx } from '../_shared/apiResourceStore.ts';
import {
  actionInputSchema, apiRoute, API_VERSION, auditStatusesFor, buildOpenApi, containsNul, effectiveModuleAccess,
  effectiveModuleLevel, errorBody, hasKeyRestrictions, isModuleKey, isValidIdempotencyKey, levelOfScope,
  matchRoute, MODULE_LABEL, pageParams, parseApiKey, presentedApiKey, proposalStatus, PROPOSAL_STATUSES,
  REJECTED_BY_USER_DETAIL, requestFingerprint,
  type ApiErrorCode, type CatalogAction, type ModuleKey, type ModuleLevel, type ProposalStatus,
} from '../_shared/publicApi.ts';

const admin = createAdminClient();

/** De basis tot en met de functie, zoals een klant hem aanroept. Achter een eigen domein: API_PUBLIC_URL. */
const PUBLIC_BASE = (Deno.env.get('API_PUBLIC_URL') || `${requiredEnv('SUPABASE_URL')}/functions/v1/api`).replace(/\/+$/, '');
const DOCS_URL = (Deno.env.get('API_DOCS_URL') || '').trim();
const WEBHOOK_ENCRYPTION_KEY = Deno.env.get('WEBHOOK_SECRET_ENCRYPTION_KEY') || '';

const TZ = 'Europe/Amsterdam';

// Verzoeksnelheid per sleutel. Ruimer dan de 120 van de MCP: een koppeling die
// een paar honderd klanten synchroniseert, is geen doorgedraaide agent. Krap
// genoeg dat een sleutel in een kapotte lus de database niet leegtrekt.
const RATE_WINDOW_SECONDS = 60;
const RATE_MAX_CALLS = envInt('API_RATE_LIMIT_PER_MINUTE', 300, 10, 6000);

/**
 * Hoeveel voorstellen één sleutel tegelijk mag laten OPENSTAAN. Zelfde reden als
 * bij de MCP: een wachtrij waar niemand meer doorheen komt, is een wachtrij
 * waarin iemand op Uitvoeren klikt zonder te lezen. Ruimer dan daar (25), omdat
 * een koppeling in één keer een stapel kan aanleveren — maar er is een plafond.
 */
const MAX_OPEN_PROPOSALS = 50;

/** Groter dan dit is geen invoer voor een handeling meer. */
const MAX_BODY_BYTES = 1_000_000;

/** Hoe lang een Idempotency-Key geldt. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  const url = new URL(req.url);
  const route = apiRoute(url.pathname);
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

  // Open paden: wat dit is en het OpenAPI-document. Daar staat geen enkel
  // gegeven van een organisatie in — alleen wat de API kan.
  if (method === 'GET' && (route === '/' || route === '/v1')) return json(serviceInfo(), 200, requestId);
  if (method === 'GET' && route === '/v1/openapi.json') {
    return json(openApiDocument(), 200, requestId, { 'Cache-Control': 'public, max-age=300' });
  }

  let caller: Caller;
  try {
    caller = await authenticate(req);
  } catch (error) {
    // Niet in api_request_log: daar hoort een organisatie bij, en die is er nu
    // juist niet. De functielogs hebben hem wel.
    return failure(error, requestId).response;
  }

  const meta: RequestMeta = { actionId: null, errorCode: null };
  let response: Response;
  try {
    response = await handle(req, url, route, method, caller, requestId, meta);
  } catch (error) {
    const failed = failure(error, requestId);
    meta.errorCode = failed.code;
    response = failed.response;
  }

  response.headers.set('RateLimit-Limit', String(RATE_MAX_CALLS));
  response.headers.set('RateLimit-Remaining', String(Math.max(0, caller.rateRemaining)));
  await logRequest(req, route, method, caller, meta, response.status, requestId, started);
  return response;
});

// ── Wie klopt hier aan? ──────────────────────────────────────────────────────

interface Caller {
  keyId: string;
  keyName: string;
  scope: string;
  /** De beperking die de sleutel zelf oplegt; leeg = geen. */
  keyModuleAccess: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
  userId: string;
  organizationId: string;
  organizationName: string;
  role: string;
  /** De modulerechten van het teamlid zelf, vers uit organization_members. */
  memberModuleAccess: Record<string, unknown>;
  rateRemaining: number;
}

interface RequestMeta {
  actionId: string | null;
  errorCode: ApiErrorCode | null;
}

/**
 * Leidt uit de sleutel het teamlid, de organisatie en de rechten af. Dit is de
 * enige plek waar dat gebeurt: alles verderop werkt met de Caller en kan er
 * niet omheen.
 */
async function authenticate(req: Request): Promise<Caller> {
  const presented = presentedApiKey(req.headers);
  if (!presented) {
    throw new ApiError(401, 'unauthorized',
      'Er ontbreekt een API-sleutel. Stuur hem mee als "Authorization: Bearer rsfapi.…". Een sleutel maak je aan onder Instellingen → API & webhooks.');
  }
  const parsed = parseApiKey(presented);
  if (!parsed) throw new ApiError(401, 'unauthorized', 'Deze API-sleutel heeft niet de juiste vorm. Een sleutel begint met "rsfapi.".');

  const { data: secrets, error: secretError } = await admin.from('api_key_secrets')
    .select('api_key_id, verifier_hash, salt').eq('selector', parsed.selector).limit(1);
  if (secretError) throw new Error(`Sleutel opzoeken mislukt: ${secretError.message}`);
  const secret = secrets?.[0] as { api_key_id: string; verifier_hash: string; salt: string } | undefined;
  if (!secret) throw new ApiError(401, 'unauthorized', 'Deze API-sleutel is niet bekend.');
  if (!await verifyToken(parsed.verifier, String(secret.salt), String(secret.verifier_hash))) {
    throw new ApiError(401, 'unauthorized', 'Deze API-sleutel klopt niet.');
  }

  const { data: keys, error: keyError } = await admin.from('api_keys')
    .select('id, organization_id, user_id, name, scope, module_access, expires_at, revoked_at, created_at, organizations(name)')
    .eq('id', secret.api_key_id).limit(1);
  if (keyError) throw new Error(`Sleutel opzoeken mislukt: ${keyError.message}`);
  const key = keys?.[0] as Record<string, unknown> | undefined;
  if (!key) throw new ApiError(401, 'unauthorized', 'Deze API-sleutel bestaat niet meer.');
  if (key.revoked_at) throw new ApiError(401, 'unauthorized', 'Deze API-sleutel is ingetrokken.');
  if (key.expires_at && new Date(String(key.expires_at)).getTime() < Date.now()) {
    throw new ApiError(401, 'unauthorized', 'Deze API-sleutel is verlopen. Maak onder Instellingen → API & webhooks een nieuwe aan.');
  }

  // De rol en de modulerechten komen VERS uit organization_members. Zet een
  // owner de maker van deze sleutel vandaag op 'viewer', of doet hij Financiën
  // voor hem dicht, dan geldt dat meteen ook hier.
  const { data: members, error: memberError } = await admin.from('organization_members')
    .select('role, module_access').eq('organization_id', key.organization_id)
    .eq('user_id', key.user_id).eq('status', 'active').limit(1);
  if (memberError) throw new Error(`Lidmaatschap opzoeken mislukt: ${memberError.message}`);
  const member = members?.[0] as { role?: string; module_access?: Record<string, unknown> } | undefined;
  if (!member?.role) {
    throw new ApiError(401, 'unauthorized',
      'Het teamlid namens wie deze sleutel werkt, is geen actief lid meer van de organisatie. Laat een owner of admin een nieuwe sleutel aanmaken.');
  }

  // Elke aanroep telt, en wel hier: ná de controle dat de sleutel deugt, zodat
  // een geraden sleutel geen teller van een echte kan opmaken.
  const used = await chargeRateLimit(String(key.id));

  return {
    keyId: String(key.id),
    keyName: String(key.name || 'API-sleutel'),
    scope: String(key.scope || SCOPE_READ),
    keyModuleAccess: (key.module_access && typeof key.module_access === 'object' ? key.module_access : {}) as Record<string, unknown>,
    expiresAt: key.expires_at ? String(key.expires_at) : null,
    createdAt: String(key.created_at),
    userId: String(key.user_id),
    organizationId: String(key.organization_id),
    organizationName: String((key.organizations as { name?: string } | null)?.name || 'je organisatie'),
    role: member.role,
    memberModuleAccess: member.module_access ?? {},
    rateRemaining: RATE_MAX_CALLS - used,
  };
}

/**
 * Boekt één aanroep af op de sleutel, in de database (api_consume_rate_limit):
 * één statement met een rijvergrendeling, zodat parallelle verzoeken niet
 * allemaal dezelfde lege teller lezen. Geeft het nieuwe aantal terug.
 */
async function chargeRateLimit(keyId: string): Promise<number> {
  const { data, error } = await admin.rpc('api_consume_rate_limit', {
    p_key_id: keyId,
    p_cost: 1,
    p_window_seconds: RATE_WINDOW_SECONDS,
    p_max_calls: RATE_MAX_CALLS,
  });
  if (error) throw new Error(`Aanroeplimiet bijwerken mislukt: ${error.message}`);
  if (data === null || Number(data) < 0) {
    // Te snel is iets anders dan niet welkom: een 401 zou de koppeling laten
    // denken dat zijn sleutel niet deugt, terwijl hij alleen even moet wachten.
    throw new ApiError(429, 'rate_limited',
      `Te veel verzoeken: maximaal ${RATE_MAX_CALLS} per minuut per sleutel. Probeer het over een minuut opnieuw.`,
      undefined, { 'Retry-After': String(RATE_WINDOW_SECONDS) });
  }
  return Number(data);
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function handle(
  req: Request, url: URL, route: string, method: string, caller: Caller, requestId: string, meta: RequestMeta,
): Promise<Response> {
  if (route === '/v1/me') {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return json(me(caller), 200, requestId);
  }

  if (route === '/v1/actions') {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return json(listActions(url, caller), 200, requestId);
  }

  const action = matchRoute(route, '/v1/actions/:id');
  if (action) {
    meta.actionId = action.id.slice(0, 120);
    if (method === 'GET') return json(actionDetail(action.id, caller), 200, requestId);
    if (method === 'POST') return await postAction(req, url, route, action.id, caller, requestId);
    throw methodNotAllowed('GET, POST');
  }

  if (route === '/v1/proposals') {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return json(await listProposals(url, caller), 200, requestId);
  }

  const proposal = matchRoute(route, '/v1/proposals/:id');
  if (proposal) {
    if (method !== 'GET') throw methodNotAllowed('GET');
    return json(await getProposal(proposal.id, caller), 200, requestId);
  }

  if (route === '/v1/events' || route === '/v1/webhooks' || route.startsWith('/v1/webhooks/')) {
    return await handleWebhooks(req, url, route, method, caller, requestId);
  }

  const resource = matchResource(route);
  if (resource) return await handleResource(req, url, route, method, caller, requestId, meta, resource);

  throw new ApiError(404, 'not_found', `Onbekend adres "${route}". Wat er bestaat, staat in ${PUBLIC_BASE}/v1/openapi.json.`);
}

// ── Open: wat dit is ─────────────────────────────────────────────────────────

function serviceInfo(): Record<string, unknown> {
  return {
    name: 'ResoFly API',
    version: API_VERSION,
    openapi: `${PUBLIC_BASE}/v1/openapi.json`,
    documentation: DOCS_URL || null,
    authentication: 'Stuur je API-sleutel mee als "Authorization: Bearer rsfapi.…" (of als "X-Api-Key: rsfapi.…" als je platform de Authorization-header zelf vult). Een sleutel maak je aan onder Instellingen → API & webhooks.',
    // Wat er is, zonder eerst het hele OpenAPI-document te hoeven lezen.
    endpoints: {
      me: `${PUBLIC_BASE}/v1/me`,
      actions: `${PUBLIC_BASE}/v1/actions`,
      proposals: `${PUBLIC_BASE}/v1/proposals`,
      events: `${PUBLIC_BASE}/v1/events`,
      webhooks: `${PUBLIC_BASE}/v1/webhooks`,
      ...Object.fromEntries(RESOURCE_LIST.map((spec) => [spec.name, `${PUBLIC_BASE}/v1/${spec.path}`])),
    },
  };
}

/** Eén keer per proces opgebouwd: de registry verandert pas bij een nieuwe uitrol. */
let openApiCache: Record<string, unknown> | null = null;

function openApiDocument(): Record<string, unknown> {
  if (!openApiCache) {
    openApiCache = buildOpenApi({
      serverUrl: PUBLIC_BASE,
      actions: [...ACTIONS, ...GERRIE_CORE_ACTIONS].map(toCatalogAction),
      docsUrl: DOCS_URL || undefined,
      extra: resourceOpenApi(RESOURCE_LIST),
    });
  }
  return openApiCache;
}

function toCatalogAction(action: ActionDef): CatalogAction {
  return {
    id: action.id,
    label: action.label,
    module: action.module,
    kind: action.kind,
    risk: action.risk === 'high' ? 'high' : 'normal',
    description: action.description,
    input: action.input,
    required: action.required ?? [],
  };
}

// ── Wie ben ik? ──────────────────────────────────────────────────────────────

function me(caller: Caller): Record<string, unknown> {
  return {
    organization: { id: caller.organizationId, name: caller.organizationName },
    key: {
      id: caller.keyId,
      name: caller.keyName,
      access: levelOfScope(caller.scope),
      scopes: parseScopes(caller.scope),
      module_restrictions: caller.keyModuleAccess,
      expires_at: caller.expiresAt,
      created_at: caller.createdAt,
    },
    acting_as: { user_id: caller.userId, role: caller.role },
    modules: effectiveModuleAccess(caller.role, caller.memberModuleAccess, caller.keyModuleAccess),
    today: today(),
    timezone: TZ,
    rate_limit: { limit: RATE_MAX_CALLS, remaining: Math.max(0, caller.rateRemaining), window_seconds: RATE_WINDOW_SECONDS },
    counts: {
      read_actions: allActions().filter((a) => a.kind === 'read' && actionPermitted(caller, a)).length,
      write_actions: allActions().filter((a) => a.kind === 'write' && actionPermitted(caller, a)).length,
      // Wat deze sleutel écht zelf kan afmaken. Het verschil met de regel
      // hierboven wacht op een akkoord in ResoFly — goed om vooraf te weten.
      direct_write_actions: allActions().filter((a) => a.kind === 'write' && actionPermitted(caller, a)
        && directlyExecutable(caller, a.id, a.risk === 'high' ? 'high' : 'normal')).length,
    },
  };
}

// ── De catalogus ─────────────────────────────────────────────────────────────

/** Registry plus Gerrie's kerntools: alles wat de API kan. */
function allActions(): ActionDef[] {
  return [...ACTIONS, ...GERRIE_CORE_ACTIONS];
}

/** Hoe de API een handeling laat zien — met wat er met DEZE sleutel gebeurt. */
function presentAction(action: ActionDef, caller: Caller): Record<string, unknown> {
  const risk = action.risk === 'high' ? 'high' : 'normal';
  return {
    id: action.id,
    label: action.label,
    module: action.module,
    kind: action.kind,
    risk,
    description: action.description,
    input_schema: actionInputSchema(toCatalogAction(action)),
    ...(action.kind === 'write'
      ? { execution: directlyExecutable(caller, action.id, risk) ? 'direct' : 'approval' }
      : {}),
  };
}

/**
 * GET /v1/actions — wat deze sleutel kan gebruiken.
 *
 * Alleen wat hij mag: een module die voor dit teamlid of deze sleutel dicht
 * staat, bestaat hier niet. Met `?q=` zoekt hij zoals `find_actions` dat doet,
 * op dezelfde woordscore; zonder `?q=` is het de hele lijst, op id.
 */
function listActions(url: URL, caller: Caller): Record<string, unknown> {
  const params = url.searchParams;
  const query = (params.get('q') || '').trim();
  const module = (params.get('module') || '').trim();
  const kind = (params.get('kind') || '').trim();
  if (module && !isModuleKey(module)) throw new ApiError(400, 'invalid_request', `Onbekende module "${module}".`);
  if (kind && kind !== 'read' && kind !== 'write') throw new ApiError(400, 'invalid_request', 'kind moet "read" of "write" zijn.');
  const { limit, offset } = pageParams(params, { defaultLimit: 100, maxLimit: 500 });

  const fits = (action: ActionDef) => actionPermitted(caller, action)
    && (!module || action.module === module)
    && (!kind || action.kind === kind);

  let list: ActionDef[];
  if (query) {
    // De zoekfunctie weegt zelf; wij zeven daarna nog eens op alles wat hij niet
    // kent (adminOnly, de modulebeperking van de sleutel).
    list = searchActions(query, {
      modules: (m, k) => actionPermitted(caller, { module: m, kind: k }),
      limit: 25,
      extra: GERRIE_CORE_ACTIONS,
    }).map((summary) => resolveAction(summary.id)?.action).filter((a): a is ActionDef => Boolean(a) && fits(a!));
  } else {
    list = allActions().filter(fits).sort((a, b) => a.id.localeCompare(b.id));
  }

  const page = list.slice(offset, offset + limit);
  return {
    data: page.map((action) => presentAction(action, caller)),
    total: list.length,
    has_more: offset + page.length < list.length,
    ...(query ? { query } : {}),
  };
}

function actionDetail(actionId: string, caller: Caller): Record<string, unknown> {
  const { action } = permittedAction(actionId, caller);
  return presentAction(action, caller);
}

/** De handeling achter een id, en of deze sleutel er überhaupt bij mag. */
function permittedAction(actionId: string, caller: Caller): { action: ActionDef; core: boolean } {
  const resolved = resolveAction(actionId);
  if (!resolved) {
    throw new ApiError(404, 'unknown_action', `Onbekende handeling "${actionId}". De lijst staat op GET /v1/actions.`);
  }
  const { action } = resolved;
  if (action.kind === 'write' && !mayPropose(caller)) {
    throw new ApiError(403, 'insufficient_scope',
      `"${action.label}" wijzigt iets, en deze sleutel mag alleen lezen. Laat een owner of admin een sleutel aanmaken die mag klaarzetten of uitvoeren.`);
  }
  if (!actionPermitted(caller, action)) {
    if (action.adminOnly && caller.role !== 'owner' && caller.role !== 'admin') {
      throw new ApiError(403, 'forbidden', `"${action.label}" is alleen voor owners en admins.`);
    }
    const label = MODULE_LABEL[action.module as ModuleKey] ?? action.module;
    throw new ApiError(403, 'forbidden', action.kind === 'write'
      ? `Deze sleutel mag niets wijzigen in de module ${label}.`
      : `Deze sleutel heeft geen toegang tot de module ${label}.`);
  }
  return resolved;
}

// ── Een handeling aanroepen ──────────────────────────────────────────────────

/** Wat een schrijfweg teruggeeft: genoeg voor het antwoord én voor de idempotentie. */
interface Outcome {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * POST /v1/actions/{id}
 *
 * Een lees-handeling geeft meteen de gegevens. Een schrijf-handeling wordt
 * rechtstreeks uitgevoerd als de sleutel dat mag én er een server-uitvoerder is
 * — anders komt hij als voorstel in de goedkeurwachtrij (202). `?mode=queue`
 * zet hem altijd klaar, ook met uitvoerrecht: voor een koppeling die wil dat
 * een mens meekijkt.
 */
async function postAction(
  req: Request, url: URL, route: string, actionId: string, caller: Caller, requestId: string,
): Promise<Response> {
  const mode = (url.searchParams.get('mode') || 'auto').trim();
  if (mode !== 'auto' && mode !== 'queue') throw new ApiError(400, 'invalid_request', 'mode moet "auto" of "queue" zijn.');

  const { action, core } = permittedAction(actionId, caller);
  const rawBody = await readBody(req);
  const input = parseInput(rawBody);

  if (action.kind === 'read') {
    const data = await runRead(action, core, input, caller);
    return json({ action: action.id, status: 'ok', data }, 200, requestId);
  }

  return await withIdempotency(req, caller, route, rawBody, requestId, () => (
    mode === 'queue' || !mayExecute(caller)
      ? queueWrite(action, core, input, caller)
      : executeWrite(action, core, input, caller)
  ));
}

/**
 * Een lees-handeling. Een kerntool draait langs `runGerrieTool` — precies de weg
 * die de chat ook neemt, mét de modulecontrole die daarin zit. Een handeling uit
 * de registry langs zijn eigen `read()`.
 */
async function runRead(action: ActionDef, core: boolean, input: Record<string, unknown>, caller: Caller): Promise<unknown> {
  try {
    return core
      ? await runGerrieTool(gerrieContext(caller), action.id, input)
      : await action.read!(actionContext(caller), input);
  } catch (error) {
    throw asApiError(error);
  }
}

/**
 * Zet een schrijf-handeling klaar. De sleutel raakt de gegevens niet aan.
 *
 * Precies wat de MCP doet bij `propose_action`: het voorstel wordt door ONS
 * gebouwd (plan() of buildProposal, met de organisatie uit de sleutel), gaat als
 * 'proposed' het auditlog in, en de goedkeurwachtrij voert het uit nadat een
 * mens erop klikt — in de browser, onder diens sessie, met RLS.
 */
async function queueWrite(
  action: ActionDef, core: boolean, input: Record<string, unknown>, caller: Caller,
  reason?: string, planned?: Proposal,
): Promise<Outcome> {
  // Vóór het werk: een plan bouwen kost queries, en die hoeven niet gedraaid te
  // worden voor een voorstel dat toch niet geplaatst wordt.
  await assertQueueHasRoom(caller);
  const proposal = planned ?? await buildApiProposal(action, core, input, caller);
  const queued = await insertProposal(action, proposal, caller);
  return {
    status: 202,
    body: { action: action.id, status: 'queued', proposal: queued, ...(reason ? { reason } : {}) },
    headers: { Location: `${PUBLIC_BASE}/v1/proposals/${queued.id}` },
  };
}

/**
 * Voert een schrijf-handeling RECHTSTREEKS uit — de enige weg zonder mens.
 *
 * Alles wat een voorstel veilig maakte, geldt onverkort: plan() draait met de
 * organisatie uit de sleutel en de payload komt uit ons plan. Wat wegvalt is de
 * klik, en dus de tweede grens die het uitvoeren onder een menselijke sessie
 * legde (RLS). Daarom alleen handelingen met een server-uitvoerder in apply.ts
 * — een korte, met de hand nagelopen lijst van enkelvoudige org-scoped queries —
 * en het onomkeerbare alleen met `execute_high`. De rest wordt een voorstel, met
 * de reden erbij: dat is de terugval, geen fout.
 */
async function executeWrite(action: ActionDef, core: boolean, input: Record<string, unknown>, caller: Caller): Promise<Outcome> {
  // Gerrie's kerntools komen hier altijd langs: een uitvoerder hoort bij een
  // handeling uit de registry (`invoice.set_status`, altijd met een punt), een
  // kerntool heet `propose_client` en nooit zo. Een factuur, een mail aan een
  // klant of een reactie op een ticket voert de browser uit — ook hier.
  if (!directApplier(action.id)) {
    return await queueWrite(action, core, input, caller,
      `ResoFly kan "${action.label}" niet rechtstreeks uitvoeren: daarvoor is de app zelf nodig. Het staat klaar in de goedkeurwachtrij.`);
  }

  const proposal = await buildRegistryProposal(action, input, caller);

  // Het risico van DIT geval, niet van de handeling in het algemeen: een plan()
  // mag het omhoog zetten voor de ene aanroep en niet voor de andere.
  if (!directlyExecutable(caller, action.id, proposal.risk)) {
    return await queueWrite(action, core, input, caller,
      `"${action.label}" is onomkeerbaar of gaat naar buiten, en deze sleutel mag dat niet rechtstreeks doen. Het staat klaar in de goedkeurwachtrij.`,
      proposal);
  }

  let confirmation: string;
  try {
    confirmation = await directApplier(action.id)!(actionContext(caller), proposal.payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Onbekende fout.';
    await recordExecution(caller, proposal, 'failed', message);
    throw asApiError(error);
  }

  const auditId = await recordExecution(caller, proposal, 'auto_executed', confirmation);
  return {
    status: 200,
    body: {
      action: action.id,
      status: 'executed',
      title: proposal.title,
      details: proposal.sub || null,
      result: confirmation,
      audit_id: auditId,
    },
  };
}

/** Een voorstel in de vorm van de registry — de enige vorm die rechtstreeks wordt uitgevoerd. */
type RegistryProposal = Extract<Proposal, { type: 'action' }>;

/** Bouwt het voorstel, uit welke van de twee lijsten de handeling ook komt. */
async function buildApiProposal(action: ActionDef, core: boolean, input: Record<string, unknown>, caller: Caller): Promise<Proposal> {
  if (!core) return await buildRegistryProposal(action, input, caller);
  // Hier wordt niets nagebouwd: `buildProposal` is dezelfde functie die de chat,
  // de geplande agents en de MCP gebruiken, met zijn eigen rol- en modulecontrole.
  let built: Awaited<ReturnType<typeof buildProposal>>;
  try {
    built = await buildProposal(gerrieContext(caller), action.id, input);
  } catch (error) {
    throw asApiError(error);
  }
  if (!built.ok) throw new ApiError(422, 'invalid_input', built.error);
  return built.proposal;
}

/**
 * Een voorstel uit de REGISTRY, gebouwd met zijn eigen `plan()` — zelfde vorm als
 * Gerrie's en de MCP's, want de wachtrij en de uitvoerder in de browser zijn
 * dezelfde. De waarschuwing komt vooraan in het onderschrift.
 */
async function buildRegistryProposal(action: ActionDef, input: Record<string, unknown>, caller: Caller): Promise<RegistryProposal> {
  let plan: Awaited<ReturnType<NonNullable<ActionDef['plan']>>>;
  try {
    plan = await action.plan!(actionContext(caller), input);
  } catch (error) {
    throw asApiError(error);
  }
  return {
    type: 'action',
    action_id: action.id,
    title: plan.title,
    sub: plan.warning ? `⚠️ ${plan.warning}${plan.sub ? ` — ${plan.sub}` : ''}` : plan.sub,
    kind: plan.kind,
    risk: (plan.risk ?? action.risk) === 'high' ? 'high' : 'normal',
    payload: plan.payload,
  };
}

/** De wachtrij loopt niet vol met dingen die niemand meer naloopt. */
async function assertQueueHasRoom(caller: Caller): Promise<void> {
  const { count, error } = await admin.from('ai_action_audit')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', caller.organizationId)
    .eq('api_key_id', caller.keyId)
    .eq('status', 'proposed');
  if (error) throw new Error(`Openstaande voorstellen tellen mislukt: ${error.message}`);
  if ((count ?? 0) >= MAX_OPEN_PROPOSALS) {
    throw new ApiError(429, 'queue_full',
      `Er staan al ${count} voorstellen van deze sleutel te wachten op goedkeuring. Laat iemand de wachtrij in ResoFly eerst afhandelen.`);
  }
}

/** Zet het voorstel in het auditlog, waar de goedkeurwachtrij het oppikt. */
async function insertProposal(action: ActionDef, proposal: Proposal, caller: Caller): Promise<Record<string, unknown>> {
  const title = proposalTitle(proposal);
  const { data, error } = await admin.from('ai_action_audit').insert({
    organization_id: caller.organizationId,
    user_id: caller.userId,
    action: `api:propose:${action.id}`,
    params: proposal,
    status: 'proposed',
    api_key_id: caller.keyId,
    // De naam van de sleutel staat in de rij zelf: de wachtrij is van het hele
    // team, en zo staat er ook bij het voorstel van een collega een afzender.
    result: { via: caller.keyName, api_key_id: caller.keyId, title },
  }).select('id, status, created_at').single();
  if (error) throw new Error(`Het voorstel kon niet worden klaargezet: ${error.message}`);

  return {
    id: String(data.id),
    action: action.id,
    status: 'pending' satisfies ProposalStatus,
    title,
    details: proposal.type === 'action' ? (proposal.sub || null) : action.label,
    irreversible: isIrreversible(proposal),
    result: null,
    created_at: String(data.created_at),
  };
}

/**
 * Een rechtstreekse uitvoering in het auditlog: zelfde tabel, zelfde vorm en
 * dezelfde `params` als een voorstel — alleen de status verschilt. Zo staan een
 * "gedaan" en een "wacht nog" in hetzelfde overzicht.
 */
async function recordExecution(
  caller: Caller, proposal: RegistryProposal, status: 'auto_executed' | 'failed', detail: string,
): Promise<string | null> {
  const { data, error } = await admin.from('ai_action_audit').insert({
    organization_id: caller.organizationId,
    user_id: caller.userId,
    action: `api:execute:${proposal.action_id}`,
    params: proposal,
    status,
    api_key_id: caller.keyId,
    result: { ok: status === 'auto_executed', detail, via: caller.keyName, api_key_id: caller.keyId },
  }).select('id').single();
  // Een audit die niet wegkomt mag een geslaagde uitvoering niet alsnog laten
  // klappen — dan meldt de koppeling een fout terwijl het gebeurd is, en probeert
  // hij het nog eens.
  if (error) { console.error('[api] uitvoering vastleggen mislukt:', error.message); return null; }
  return String(data.id);
}

// ── Voorstellen opvolgen ─────────────────────────────────────────────────────

const PROPOSAL_COLUMNS = 'id, action, params, status, result, created_at';

/** GET /v1/proposals — wat DEZE sleutel heeft klaargezet, nieuwste eerst. */
async function listProposals(url: URL, caller: Caller): Promise<Record<string, unknown>> {
  const status = (url.searchParams.get('status') || '').trim();
  if (status && !(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, 'invalid_request', `status moet een van deze zijn: ${PROPOSAL_STATUSES.join(', ')}.`);
  }
  const { limit, offset } = pageParams(url.searchParams);

  let query = admin.from('ai_action_audit').select(PROPOSAL_COLUMNS)
    .eq('organization_id', caller.organizationId)
    .eq('api_key_id', caller.keyId)
    .like('action', 'api:propose:%');
  if (status) {
    query = query.in('status', auditStatusesFor(status as ProposalStatus));
    // "Afgewezen" en "mislukt" delen intern één status; de zin maakt het verschil.
    if (status === 'rejected') query = query.eq('result->>detail', REJECTED_BY_USER_DETAIL);
    if (status === 'failed') query = query.or(`result->>detail.is.null,result->>detail.neq."${REJECTED_BY_USER_DETAIL}"`);
  }
  // Eén rij extra ophalen zegt of er nog een pagina is, zonder te tellen.
  const { data, error } = await query.order('created_at', { ascending: false }).range(offset, offset + limit);
  if (error) throw new Error(`Voorstellen ophalen mislukt: ${error.message}`);
  const rows = (data ?? []) as AuditRow[];
  return { data: rows.slice(0, limit).map(presentProposal), has_more: rows.length > limit };
}

async function getProposal(proposalId: string, caller: Caller): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proposalId)) {
    throw new ApiError(404, 'not_found', 'Dit voorstel bestaat niet.');
  }
  const { data, error } = await admin.from('ai_action_audit').select(PROPOSAL_COLUMNS)
    .eq('organization_id', caller.organizationId)
    .eq('api_key_id', caller.keyId)
    .like('action', 'api:propose:%')
    .eq('id', proposalId)
    .maybeSingle();
  if (error) throw new Error(`Voorstel ophalen mislukt: ${error.message}`);
  // Een voorstel van een andere sleutel bestaat voor deze sleutel niet — ook niet
  // als het in dezelfde organisatie staat.
  if (!data) throw new ApiError(404, 'not_found', 'Dit voorstel bestaat niet, of is niet door deze sleutel klaargezet.');
  return presentProposal(data as AuditRow);
}

interface AuditRow {
  id: string;
  action: string;
  params: Proposal | null;
  status: string;
  result: { detail?: string; title?: string } | null;
  created_at: string;
}

function presentProposal(row: AuditRow): Record<string, unknown> {
  const detail = typeof row.result?.detail === 'string' ? row.result.detail : null;
  const status = proposalStatus(row.status, detail);
  const proposal = row.params;
  return {
    id: row.id,
    action: String(row.action).replace(/^api:propose:/, ''),
    status,
    // Na het goedkeuren schrijft de wachtrij `result` opnieuw; de titel komt
    // daarom uit het voorstel zelf, niet uit wat we er bij het klaarzetten bij
    // zetten.
    title: proposal ? proposalTitle(proposal) : (row.result?.title ?? null),
    details: proposal && proposal.type === 'action' ? (proposal.sub || null) : null,
    irreversible: proposal ? isIrreversible(proposal) : false,
    result: status === 'pending' ? null : detail,
    created_at: row.created_at,
  };
}

/** Wat de gebruiker op de kaart leest. */
function proposalTitle(proposal: Proposal): string {
  if (proposal.type === 'action') return proposal.title;
  const text = describeProposal(proposal);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Voorstel';
}

function isIrreversible(proposal: Proposal): boolean {
  return severityForProposal(proposal.type, proposal.type === 'action' ? proposal.risk : null) === 'high';
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
//
// Het "REST hooks"-patroon van Zapier en Make: een koppeling meldt zelf een
// adres aan, en ResoFly stuurt daar een ondertekend bericht naartoe als er iets
// gebeurt. Een eindpunt dat zo ontstaat, hoort bij DEZE sleutel: de koppeling
// ziet en beheert alleen haar eigen eindpunten, krijgt alleen gebeurtenissen uit
// modules die de sleutel mag lezen (ook dat weegt de bezorger elke keer
// opnieuw), en het eindpunt verdwijnt als de sleutel wordt ingetrokken.
//
// Lezen is genoeg om een webhook aan te maken: hij levert niets af wat de
// sleutel niet ook zelf had kunnen opvragen — alleen sneller.

async function handleWebhooks(
  req: Request, url: URL, route: string, method: string, caller: Caller, requestId: string,
): Promise<Response> {
  const owner = webhookOwner(caller);
  try {
    if (route === '/v1/events') {
      if (method !== 'GET') throw methodNotAllowed('GET');
      return json({ data: visibleEvents(owner) }, 200, requestId);
    }

    if (route === '/v1/webhooks') {
      if (method === 'GET') return json({ data: (await listEndpoints(admin, owner)).map(presentEndpoint) }, 200, requestId);
      if (method === 'POST') {
        const input = parseInput(await readBody(req));
        const created = await createEndpoint(admin, owner, input, webhookEncryptionKey());
        return json({ webhook: presentEndpoint(created.endpoint), secret: created.secret }, 201, requestId,
          { Location: `${PUBLIC_BASE}/v1/webhooks/${created.endpoint.id}` });
      }
      throw methodNotAllowed('GET, POST');
    }

    const test = matchRoute(route, '/v1/webhooks/:id/test');
    if (test) {
      if (method !== 'POST') throw methodNotAllowed('POST');
      const result = await testEndpoint(admin, owner, test.id, { encryptionKey: webhookEncryptionKey(), sentBy: `API-sleutel "${caller.keyName}"` });
      return json({
        status: result.status, http_status: result.httpStatus, error: result.error, duration_ms: result.durationMs,
        delivery_id: result.deliveryId, event_id: result.eventId,
      }, 200, requestId);
    }

    const deliveries = matchRoute(route, '/v1/webhooks/:id/deliveries');
    if (deliveries) {
      if (method !== 'GET') throw methodNotAllowed('GET');
      const { limit } = pageParams(url.searchParams);
      return json({ data: await listDeliveries(admin, owner, deliveries.id, limit) }, 200, requestId);
    }

    const one = matchRoute(route, '/v1/webhooks/:id');
    if (one) {
      if (method === 'GET') return json(presentEndpoint(await getEndpoint(admin, owner, one.id)), 200, requestId);
      if (method === 'PATCH') {
        const input = parseInput(await readBody(req));
        return json(presentEndpoint(await updateEndpoint(admin, owner, one.id, input)), 200, requestId);
      }
      if (method === 'DELETE') {
        await deleteEndpoint(admin, owner, one.id);
        return new Response(null, { status: 204, headers: { ...corsHeaders(), 'X-Request-Id': requestId } });
      }
      throw methodNotAllowed('GET, PATCH, DELETE');
    }
  } catch (error) {
    if (error instanceof WebhookInputError) {
      const code: ApiErrorCode = error.status === 404 ? 'not_found' : error.status === 409 ? 'conflict'
        : error.status === 400 ? 'invalid_request' : 'invalid_input';
      throw new ApiError(error.status, code, error.message);
    }
    throw error;
  }

  throw new ApiError(404, 'not_found', `Onbekend adres "${route}".`);
}

/** Van wie een eindpunt is als een sleutel hem aanmaakt: van die sleutel, met diens leesrechten. */
function webhookOwner(caller: Caller): EndpointOwner {
  return {
    organizationId: caller.organizationId,
    userId: caller.userId,
    apiKeyId: caller.keyId,
    canRead: (module: string) => moduleLevel(caller, module) !== 'none',
  };
}

/** Wat een koppeling van een eindpunt ziet. Nooit het geheim. */
function presentEndpoint(endpoint: Record<string, unknown>): Record<string, unknown> {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    events: endpoint.events,
    active: endpoint.active,
    disabled_reason: endpoint.disabled_reason ?? null,
    consecutive_failures: endpoint.consecutive_failures ?? 0,
    last_success_at: endpoint.last_success_at ?? null,
    last_failure_at: endpoint.last_failure_at ?? null,
    created_at: endpoint.created_at,
  };
}

function webhookEncryptionKey(): string {
  if (!WEBHOOK_ENCRYPTION_KEY) {
    throw new ApiError(503, 'internal_error', 'Webhooks staan in deze omgeving nog niet aan. Neem contact op met ResoFly.');
  }
  return WEBHOOK_ENCRYPTION_KEY;
}

// ── Vaste adressen: klanten, contactpersonen, projecten, taken, tickets, uren ─
//
// GET /v1/clients, POST /v1/clients, GET|PATCH /v1/clients/{id} — en zo voor
// elke resource in apiResourceSpecs.ts; reacties op een ticket onder
// /v1/tickets/{ticket_id}/notes. Lezen vraagt leesrecht in de module.
//
// Aanmaken en wijzigen gebeurt hier RECHTSTREEKS (201/200): een vast adres dat
// soms 202 "klaargezet" antwoordt, is geen vast adres meer. Het vraagt daarom
// toegangsniveau `execute` plus schrijfrecht in de module. Een sleutel die
// alleen mag klaarzetten, hoort waar dat wél kan: POST /v1/actions/{id}.
//
// Het wegschrijven gebeurt als het teamlid achter de sleutel (api_rest_write in
// de database): dezelfde RLS, dezelfde triggers en hetzelfde auditlog als een
// wijziging in de app — de app-regels gelden, ze worden hier niet nagebouwd.

async function handleResource(
  req: Request, url: URL, route: string, method: string, caller: Caller, requestId: string, meta: RequestMeta,
  match: { spec: ResourceSpec; id: string | null; parentId: string | null },
): Promise<Response> {
  const { spec, id, parentId } = match;
  meta.actionId = `rest:${spec.name}`;
  const level = moduleLevel(caller, spec.module);
  if (level === 'none') {
    throw new ApiError(403, 'forbidden',
      `Deze sleutel mag geen ${spec.labelPlural.toLowerCase()} lezen: de module ${MODULE_LABEL[spec.module]} staat dicht voor de sleutel of voor het teamlid erachter.`);
  }
  const ctx = storeContext(caller);

  return await resourceErrors(async () => {
    // Een reactie bestaat alleen onder een ticket van DEZE organisatie.
    if (spec.parent && parentId !== null) await getRow(ctx, RESOURCES[spec.parent.resource], parentId);

    if (id === null) {
      if (method === 'GET') {
        let params: ReturnType<typeof parseListParams>;
        try {
          params = parseListParams(spec, url.searchParams);
        } catch (error) {
          if (error instanceof ResourceInputError) {
            throw new ApiError(400, 'invalid_request', error.message, error.field ? { field: error.field } : undefined);
          }
          throw error;
        }
        return json(await listRows(ctx, spec, params, parentId ?? undefined), 200, requestId);
      }
      if (method === 'POST' && spec.create) {
        assertMayWrite(caller, spec, level);
        const rawBody = await readBody(req);
        const input = parseInput(rawBody);
        return await withIdempotency(req, caller, route, rawBody, requestId, () => resourceErrors(async () => {
          const values = normalizeResourceInput(spec, input, 'create');
          if (spec.parent && parentId !== null) values[spec.parent.column] = parentId;
          const row = await createRow(ctx, spec, values);
          await recordResourceWrite(caller, spec, 'create', row, values);
          return { status: 201, body: row, headers: { Location: `${PUBLIC_BASE}${route}/${String(row.id)}` } };
        }));
      }
      throw methodNotAllowed(spec.create ? 'GET, POST' : 'GET');
    }

    if (method === 'GET') return json(await getRow(ctx, spec, id, parentId ?? undefined), 200, requestId);
    if (method === 'PATCH' && spec.update) {
      assertMayWrite(caller, spec, level);
      const rawBody = await readBody(req);
      const input = parseInput(rawBody);
      return await withIdempotency(req, caller, route, rawBody, requestId, () => resourceErrors(async () => {
        const values = normalizeResourceInput(spec, input, 'update');
        const row = await updateRow(ctx, spec, id, values, parentId ?? undefined);
        await recordResourceWrite(caller, spec, 'update', row, values);
        return { status: 200, body: row };
      }));
    }
    throw methodNotAllowed(spec.update ? 'GET, PATCH' : 'GET');
  });
}

/**
 * Wijzigen via een vast adres: alleen met `execute`, en alleen met schrijfrecht
 * in de module (van de sleutel én van het teamlid erachter).
 */
function assertMayWrite(caller: Caller, spec: ResourceSpec, level: ModuleLevel): void {
  if (!mayExecute(caller)) {
    throw new ApiError(403, 'insufficient_scope', mayPropose(caller)
      ? `Rechtstreeks wijzigen via /v1/${spec.path} vraagt toegangsniveau "execute". Deze sleutel mag wijzigingen alleen klaarzetten; dat kan via POST /v1/actions/{id}.`
      : `Deze sleutel mag alleen lezen. ${spec.labelPlural} aanmaken of wijzigen vraagt toegangsniveau "execute".`);
  }
  if (level !== 'write') {
    throw new ApiError(403, 'forbidden',
      `Deze sleutel mag ${spec.labelPlural.toLowerCase()} lezen, maar niet wijzigen: in de module ${MODULE_LABEL[spec.module]} is er alleen leesrecht.`);
  }
}

/** De invoer volgens de spec; wat niet klopt, wordt een 422 met het veld erbij. */
function normalizeResourceInput(spec: ResourceSpec, input: Record<string, unknown>, mode: 'create' | 'update'): Record<string, unknown> {
  try {
    return normalizeInput(spec, input, mode);
  } catch (error) {
    if (error instanceof ResourceInputError) {
      throw new ApiError(422, 'invalid_input', error.message, error.field ? { field: error.field } : undefined);
    }
    throw error;
  }
}

/** Fouten van de store als ApiError, met de juiste code — ook binnen withIdempotency. */
async function resourceErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ResourceStoreError) {
      const code: ApiErrorCode = error.status === 403 ? 'forbidden'
        : error.status === 404 ? 'not_found'
        : error.status === 409 ? 'conflict'
        : 'invalid_input';
      throw new ApiError(error.status, code, error.message, error.field ? { field: error.field } : undefined);
    }
    throw error;
  }
}

/** Lezen met de service-role, schrijven als het teamlid — beide met de organisatie uit de sleutel. */
function storeContext(caller: Caller): StoreCtx {
  return { db: admin, organizationId: caller.organizationId, userId: caller.userId };
}

/**
 * Een wijziging via een vast adres in het auditlog, naast de uitvoeringen van
 * handelingen: herleidbaar tot de sleutel, met wat er werd gezet. De rij zelf
 * staat bovendien in audit_logs, op naam van het teamlid (dat doet de database).
 */
async function recordResourceWrite(
  caller: Caller, spec: ResourceSpec, op: 'create' | 'update', row: Record<string, unknown>, values: Record<string, unknown>,
): Promise<void> {
  const what = String(row.name ?? row.title ?? row.subject ?? '').trim()
    || String(row.description ?? row.body ?? '').trim().slice(0, 60)
    || String(row.id);
  const title = `${spec.label} ${op === 'create' ? 'aangemaakt' : 'gewijzigd'}: ${what}`;
  const { error } = await admin.from('ai_action_audit').insert({
    organization_id: caller.organizationId,
    user_id: caller.userId,
    action: `api:rest:${spec.name}.${op}`,
    params: {
      type: 'action', action_id: `rest:${spec.name}.${op}`, title, sub: Object.keys(values).join(', '),
      kind: op, risk: 'normal', payload: { id: row.id, values },
    },
    status: 'auto_executed',
    api_key_id: caller.keyId,
    result: { ok: true, detail: title, via: caller.keyName, api_key_id: caller.keyId },
  });
  // Net als bij een handeling: een audit die niet wegkomt, maakt een gelukte
  // wijziging niet alsnog ongedaan.
  if (error) console.error('[api] wijziging vastleggen mislukt:', error.message);
}

// ── Idempotentie ─────────────────────────────────────────────────────────────

/**
 * Voert `run` hooguit één keer uit per (sleutel, Idempotency-Key).
 *
 * De eerste poging zet een rij neer zonder status; een tweede die binnenkomt
 * terwijl de eerste nog loopt, krijgt een 409 in plaats van een dubbele
 * uitvoering. Is de eerste klaar, dan krijgt elke herhaling hetzelfde antwoord
 * terug, met `Idempotent-Replayed: true`. Dezelfde sleutel met een ANDERE
 * inhoud is een fout van de aanroeper.
 *
 * Een fout aan onze kant (5xx) laat de sleutel weer vrij: dan mag een herhaling
 * het opnieuw proberen. Een fout in de invoer (4xx) blijft staan — die wordt
 * bij een herhaling niet ineens goed.
 */
async function withIdempotency(
  req: Request, caller: Caller, route: string, rawBody: string, requestId: string, run: () => Promise<Outcome>,
): Promise<Response> {
  const key = (req.headers.get('idempotency-key') || '').trim();
  if (!key) {
    const outcome = await run();
    return json(outcome.body, outcome.status, requestId, outcome.headers);
  }
  if (!isValidIdempotencyKey(key)) {
    throw new ApiError(400, 'invalid_request', 'Een Idempotency-Key bestaat uit 1 tot 255 zichtbare tekens zonder spaties.');
  }
  const hash = await requestFingerprint(req.method, route, rawBody);

  const claimed = await claimIdempotencyKey(caller.keyId, key, hash);
  if (!claimed) {
    const { data, error } = await admin.from('api_idempotency_keys')
      .select('request_hash, status, response').eq('api_key_id', caller.keyId).eq('idempotency_key', key).maybeSingle();
    if (error) throw new Error(`Idempotency-Key opzoeken mislukt: ${error.message}`);
    if (!data || data.status === null) {
      throw new ApiError(409, 'idempotency_in_progress', 'Een verzoek met deze Idempotency-Key is nog bezig. Probeer het zo opnieuw.');
    }
    if (data.request_hash !== hash) {
      throw new ApiError(422, 'idempotency_conflict', 'Deze Idempotency-Key is al gebruikt voor een ander verzoek. Gebruik per verzoek een eigen sleutel.');
    }
    return json(data.response as Record<string, unknown>, Number(data.status), requestId, { 'Idempotent-Replayed': 'true' });
  }

  try {
    const outcome = await run();
    await storeIdempotentResponse(caller.keyId, key, outcome.status, outcome.body);
    return json(outcome.body, outcome.status, requestId, outcome.headers);
  } catch (error) {
    const apiError = asApiError(error);
    if (apiError.status < 500 && apiError.status !== 409 && apiError.status !== 429) {
      await storeIdempotentResponse(caller.keyId, key, apiError.status,
        errorBody(apiError.code, apiError.message, requestId, apiError.details));
    } else {
      await admin.from('api_idempotency_keys').delete().eq('api_key_id', caller.keyId).eq('idempotency_key', key);
    }
    throw apiError;
  }
}

/**
 * Probeert de sleutel te claimen. Een verlopen rij (ouder dan 24 uur) die het
 * opruimen nog niet heeft gehaald, telt niet meer: die gaat eerst weg.
 */
async function claimIdempotencyKey(keyId: string, key: string, hash: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await admin.from('api_idempotency_keys').insert({ api_key_id: keyId, idempotency_key: key, request_hash: hash });
    if (!error) return true;
    if (error.code !== '23505') throw new Error(`Idempotency-Key vastleggen mislukt: ${error.message}`);
    const { data: stale } = await admin.from('api_idempotency_keys')
      .delete()
      .eq('api_key_id', keyId).eq('idempotency_key', key)
      .lt('created_at', new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString())
      .select('api_key_id');
    if (!stale || stale.length === 0) return false;
  }
  return false;
}

async function storeIdempotentResponse(keyId: string, key: string, status: number, body: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from('api_idempotency_keys')
    .update({ status, response: body }).eq('api_key_id', keyId).eq('idempotency_key', key);
  if (error) console.error('[api] idempotent antwoord bewaren mislukt:', error.message);
}

// ── Rechten ──────────────────────────────────────────────────────────────────
//
// Dezelfde twee sloten als de MCP (zie actionPermitted daar), met één laag
// erbij: de modulebeperking van de sleutel zelf (effectiveModuleLevel).

function moduleLevel(caller: Caller, module: string): ModuleLevel {
  return effectiveModuleLevel(caller.role, caller.memberModuleAccess, caller.keyModuleAccess, module);
}

/**
 * Mag deze sleutel deze handeling? Lezen vraagt leesrecht, wijzigen vraagt
 * SCHRIJFrecht én een scope die verder gaat dan lezen — hetzelfde antwoord als
 * het teamlid in het scherm zou krijgen.
 */
function actionPermitted(caller: Caller, action: { module: string; kind: 'read' | 'write'; adminOnly?: boolean }): boolean {
  // Team- en instellingshandelingen: alleen als het teamlid achter deze sleutel
  // zelf owner/admin is. Anders zou een lid ze klaarzetten voor een owner die ze
  // met zijn eigen rechten uitvoert.
  if (action.adminOnly && caller.role !== 'owner' && caller.role !== 'admin') return false;
  const level = moduleLevel(caller, action.module);
  if (action.kind === 'write') return mayPropose(caller) && level === 'write';
  return level !== 'none';
}

/** Mag deze sleutel wijzigingen klaarzetten? `execute` telt mee: wat niet rechtstreeks kan, wordt een voorstel. */
function mayPropose(caller: Caller): boolean {
  return scopeAllows(caller.scope, SCOPE_PROPOSE) || mayExecute(caller);
}

/** Mag deze sleutel omkeerbare handelingen rechtstreeks uitvoeren? */
function mayExecute(caller: Caller): boolean {
  return scopeAllows(caller.scope, SCOPE_EXECUTE);
}

/** ...en ook de onomkeerbare? */
function mayExecuteHigh(caller: Caller): boolean {
  return mayExecute(caller) && scopeAllows(caller.scope, SCOPE_EXECUTE_HIGH);
}

/**
 * Kan én mag deze handeling rechtstreeks? De sleutel moet het mogen (`execute`),
 * er moet een server-uitvoerder zijn, en bij risico 'high' moet `execute_high`
 * erbij. Valt er één weg, dan wordt het een voorstel.
 */
function directlyExecutable(caller: Caller, actionId: string, risk: 'normal' | 'high'): boolean {
  if (!mayExecute(caller)) return false;
  if (!directApplier(actionId)) return false;
  return risk !== 'high' || mayExecuteHigh(caller);
}

/** Alles wat een handeling uit de registry van zijn omgeving nodig heeft — nooit uit de aanroeper. */
function actionContext(caller: Caller): ActionCtx {
  return {
    organizationId: caller.organizationId,
    userId: caller.userId,
    role: caller.role,
    today: today(),
    db: admin,
  };
}

/**
 * De omgeving waarin een kerntool van Gerrie draait.
 *
 * Een kerntool weegt de modulerechten zelf, maar voor een owner of admin kijkt
 * hij er niet naar: die mogen alles. Een sleutel MET modulebeperking moet daar
 * wel aan gehouden worden — anders kijkt een webshopsleutel via een kerntool
 * alsnog in de boekhouding. Zo'n sleutel draait daarom als gewoon teamlid met
 * precies de modules die hij mag. Zonder beperking verandert er niets.
 */
function gerrieContext(caller: Caller): GerrieContext {
  const restricted = hasKeyRestrictions(caller.keyModuleAccess);
  const elevated = caller.role === 'owner' || caller.role === 'admin';
  return {
    organizationId: caller.organizationId,
    role: (restricted && elevated ? 'member' : caller.role) as OrganizationRole,
    userId: caller.userId,
    userLabel: `API-sleutel "${caller.keyName}"`,
    orgName: caller.organizationName,
    today: today(),
    moduleAccess: restricted
      ? effectiveModuleAccess(caller.role, caller.memberModuleAccess, caller.keyModuleAccess)
      : caller.memberModuleAccess as Record<string, string>,
  };
}

/**
 * De handeling achter een id, uit welke van de twee lijsten hij ook komt. De
 * id's kunnen niet botsen: een handeling uit de registry heeft altijd een punt,
 * een kerntool nooit.
 */
function resolveAction(actionId: string): { action: ActionDef; core: boolean } | null {
  const core = getGerrieCoreAction(actionId);
  if (core) return { action: core, core: true };
  const action = getAction(actionId);
  return action ? { action, core: false } : null;
}

// ── Invoer ───────────────────────────────────────────────────────────────────

async function readBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('content-length') || '0');
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw tooLarge();
  return text;
}

function tooLarge(): ApiError {
  return new ApiError(413, 'payload_too_large', `De invoer is groter dan ${Math.round(MAX_BODY_BYTES / 1000)} kB.`);
}

/** De invoer van een handeling: een JSON-object, of niets. */
function parseInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'invalid_request', 'De inhoud van dit verzoek is geen geldige JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'invalid_request', 'Stuur de invoer als JSON-object met de velden uit het schema, bijvoorbeeld {"invoice_id": "…"}.');
  }
  if (containsNul(parsed)) {
    throw new ApiError(400, 'invalid_request', 'De invoer bevat een NUL-teken (\\u0000); dat kan ResoFly niet opslaan.');
  }
  return parsed as Record<string, unknown>;
}

// ── Fouten en antwoorden ─────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public details?: Record<string, unknown>,
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function methodNotAllowed(allowed: string): ApiError {
  return new ApiError(405, 'method_not_allowed', `Deze methode kan hier niet. Toegestaan: ${allowed}.`, undefined, { Allow: allowed });
}

/**
 * Elke fout als ApiError. Een ActionError is invoer die niet klopt (of een rij
 * die niet in deze organisatie bestaat): de zin gaat terug zodat de aanroeper
 * zijn verzoek kan verbeteren. Een fout met een HTTP-status uit gerrieCore houdt
 * die status. Al het andere is aan onze kant misgegaan.
 */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ActionError) return new ApiError(422, 'invalid_input', error.message);
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = error instanceof Error ? error.message : 'Dit verzoek kan niet.';
    if (status === 403) return new ApiError(403, 'forbidden', message);
    if (status === 404) return new ApiError(404, 'not_found', message);
    return new ApiError(422, 'invalid_input', message);
  }
  console.error('[api] onverwachte fout:', error instanceof Error ? error.message : error);
  return new ApiError(500, 'internal_error',
    'Er ging iets mis aan onze kant. Probeer het opnieuw; blijft het misgaan, geef dan het request_id door aan ResoFly.');
}

function failure(error: unknown, requestId: string): { response: Response; code: ApiErrorCode } {
  const apiError = asApiError(error);
  return {
    code: apiError.code,
    response: json(errorBody(apiError.code, apiError.message, requestId, apiError.details), apiError.status, requestId, apiError.headers),
  };
}

function corsHeaders(): Record<string, string> {
  // Open voor elke origin: de API authenticeert met een sleutel in een header,
  // niet met een cookie, dus een andere website kan er niets mee wat hij niet
  // zelf al kon. Of een sleutel in een browser thuishoort, is aan wie hem bezit.
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type, idempotency-key, x-client-info, apikey',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'x-request-id, ratelimit-limit, ratelimit-remaining, retry-after, idempotent-replayed, location',
    'Access-Control-Max-Age': '86400',
  };
}

function json(payload: unknown, status: number, requestId: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': requestId, ...extra },
  });
}

/**
 * Elke aanroep in api_request_log: wanneer, welk pad, welke handeling, welke
 * uitkomst. Niet de invoer en niet het antwoord — wel genoeg om terug te zien
 * wat er langs deze deur is gegaan. Een log dat niet wegkomt, mag het antwoord
 * niet omgooien.
 */
async function logRequest(
  req: Request, route: string, method: string, caller: Caller, meta: RequestMeta,
  status: number, requestId: string, started: number,
): Promise<void> {
  const forwarded = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '';
  const { error } = await admin.from('api_request_log').insert({
    organization_id: caller.organizationId,
    api_key_id: caller.keyId,
    request_id: requestId,
    method,
    path: route.slice(0, 300),
    action_id: meta.actionId,
    status,
    error_code: meta.errorCode,
    duration_ms: Date.now() - started,
    ip: forwarded.split(',')[0].trim().slice(0, 64) || null,
    user_agent: (req.headers.get('user-agent') || '').slice(0, 200) || null,
  });
  if (error) console.error('[api] verzoek loggen mislukt:', error.message);
}

// ── Kleine hulpjes ───────────────────────────────────────────────────────────

/** Vandaag in Europe/Amsterdam, als JJJJ-MM-DD. */
function today(): string {
  const { y, m, d } = localYmd(TZ, new Date());
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(Deno.env.get(name));
  return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.trunc(value), min), max) : fallback;
}
