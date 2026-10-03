import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MODULE_KEYS } from './publicApi.ts';

/**
 * Bewaakt de grenzen van de openbare API (functies `api` en `api-admin`).
 *
 * Net als mcpExecute.test.ts lezen we de bestanden als TEKST: de serverkant
 * leunt op Deno-imports en is niet in node te laden. Grof, maar het vangt
 * precies de fout die we willen voorkomen — en het vangt hem bij het toevoegen,
 * niet bij de eerste klant die er doorheen loopt.
 *
 * Vier grenzen, en het is de moeite ze uit elkaar te houden:
 *
 *   WIE        — de organisatie en het teamlid komen uit de SLEUTEL, nooit uit
 *                de aanroeper; de rechten vers uit organization_members.
 *   WAT MAG    — klaarzetten vraagt meer dan lezen; rechtstreeks uitvoeren vraagt
 *                `execute`, een server-uitvoerder, en voor het onomkeerbare
 *                `execute_high`.
 *   WAT BLIJFT — elke uitvoering en elk voorstel staat in het auditlog, herleidbaar
 *                tot de sleutel.
 *   WIE GEEFT  — alleen owners en admins maken sleutels aan.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const api = read('../api/index.ts');
const apiAdmin = read('../api-admin/index.ts');
const mcp = read('../mcp/index.ts');
const edgeAuth = read('./edgeAuth.ts');
const config = read('../../config.toml');
const ci = read('../../../.github/workflows/frontend-checks.yml');

/** De tekst van één functie, van zijn kop tot de eerste regel met alleen `}`. */
function fn(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `"${header}" niet gevonden`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end === -1 ? undefined : end);
}

// ── Wie ──────────────────────────────────────────────────────────────────────

test('de organisatie komt nooit uit wat de aanroeper meestuurt', () => {
  // Er bestaat geen invoerveld voor. Een handeling krijgt hem uit de Caller, en
  // die uit de sleutelrij.
  assert.doesNotMatch(api, /(input|body|args|params)\s*(\.|\[\s*['"])organization_?[iI]d/,
    'api/index.ts leest een organisatie-id uit de invoer.');
  for (const ctx of [fn(api, 'function actionContext('), fn(api, 'function gerrieContext(')]) {
    assert.match(ctx, /organizationId: caller\.organizationId/);
    assert.match(ctx, /userId: caller\.userId/);
  }
  assert.match(fn(api, 'async function authenticate('), /organizationId: String\(key\.organization_id\)/);
});

test('de sleutel wordt eerst gecontroleerd, en pas daarna telt de aanroep', () => {
  // Andersom kan een geraden sleutel de teller van een echte opmaken.
  const auth = fn(api, 'async function authenticate(');
  const verified = auth.indexOf('verifyToken(');
  assert.ok(verified > 0, 'authenticate() controleert de verifier niet');
  assert.ok(auth.indexOf('if (key.revoked_at)') > verified, 'ingetrokken sleutels worden niet geweigerd');
  assert.ok(auth.indexOf('key.expires_at') > verified, 'verlopen sleutels worden niet geweigerd');
  assert.ok(auth.indexOf('chargeRateLimit(') > auth.indexOf('if (key.revoked_at)'),
    'de aanroeplimiet wordt afgeboekt vóór de sleutel is goedgekeurd');
});

test('de rol en de modulerechten komen per aanroep vers uit organization_members', () => {
  const auth = fn(api, 'async function authenticate(');
  assert.match(auth, /from\('organization_members'\)[\s\S]{0,200}\.eq\('status', 'active'\)/,
    'zonder deze query blijft een sleutel werken nadat zijn maker uit de organisatie is gezet.');
  assert.match(auth, /role: member\.role/);
  assert.match(auth, /memberModuleAccess: member\.module_access/);
});

test('een sleutel kan nooit ruimer zijn dan zijn maker', () => {
  const level = fn(api, 'function moduleLevel(');
  assert.match(level, /effectiveModuleLevel\(caller\.role, caller\.memberModuleAccess, caller\.keyModuleAccess, module\)/);
  // In Gerrie's kerntools mogen owners/admins alles; een beperkte sleutel draait
  // daar daarom als gewoon teamlid met precies de modules die hij mag.
  const ctx = fn(api, 'function gerrieContext(');
  assert.match(ctx, /restricted && elevated \? 'member'/);
  assert.match(ctx, /effectiveModuleAccess\(caller\.role, caller\.memberModuleAccess, caller\.keyModuleAccess\)/);
});

test('een voorstel van een andere sleutel bestaat niet', () => {
  for (const name of ['async function getProposal(', 'async function listProposals(']) {
    const body = fn(api, name);
    assert.match(body, /\.eq\('organization_id', caller\.organizationId\)/, `${name} filtert niet op de organisatie`);
    assert.match(body, /\.eq\('api_key_id', caller\.keyId\)/, `${name} filtert niet op de sleutel`);
  }
});

// ── Wat mag ──────────────────────────────────────────────────────────────────

test('wijzigen vraagt meer dan lezen, en schrijfrecht in de module', () => {
  const permitted = fn(api, 'function actionPermitted(');
  assert.match(permitted, /if \(action\.kind === 'write'\) return mayPropose\(caller\) && level === 'write';/);
  assert.match(permitted, /action\.adminOnly && caller\.role !== 'owner' && caller\.role !== 'admin'/,
    'team- en instellingshandelingen horen alleen namens owners/admins te kunnen.');
});

test('rechtstreeks uitvoeren vraagt een uitvoerder én het juiste risiconiveau', () => {
  const body = fn(api, 'function directlyExecutable(');
  assert.match(body, /if \(!mayExecute\(caller\)\) return false;/);
  assert.match(body, /if \(!directApplier\(actionId\)\) return false;/);
  assert.match(body, /risk !== 'high' \|\| mayExecuteHigh\(caller\)/,
    'zonder deze regel voert `execute` ook de onomkeerbare handelingen uit.');
});

test('wat niet rechtstreeks kan, valt terug op de goedkeurwachtrij — met het risico van dit ene geval', () => {
  const body = fn(api, 'async function executeWrite(');
  assert.match(body, /if \(!directApplier\(action\.id\)\) \{\s*\n\s*return await queueWrite\(/,
    'zonder server-uitvoerder hoort het een voorstel te worden, geen weigering.');
  assert.match(body, /directlyExecutable\(caller, action\.id, proposal\.risk\)/,
    'de toets hoort op het risico van het gebouwde plan te gaan, niet op dat van de handeling in het algemeen.');
  assert.match(body, /status: 'executed'/);
  assert.match(fn(api, 'async function queueWrite('), /status: 'queued'/);
});

test('zonder uitvoerrecht wordt elke schrijf-handeling klaargezet', () => {
  assert.match(fn(api, 'async function postAction('),
    /mode === 'queue' \|\| !mayExecute\(caller\)\s*\n\s*\? queueWrite\(action, core, input, caller\)\s*\n\s*: executeWrite\(action, core, input, caller\)/);
});

test('de wachtrij krijgt een plafond per sleutel, en dat wordt vóór het plannen getoetst', () => {
  const room = fn(api, 'async function assertQueueHasRoom(');
  assert.match(room, /\.eq\('api_key_id', caller\.keyId\)/, 'het plafond hoort per sleutel te tellen, niet voor de hele organisatie');
  assert.match(room, /\.eq\('status', 'proposed'\)/);
  const body = fn(api, 'async function queueWrite(');
  assert.ok(body.indexOf('await assertQueueHasRoom(caller)') >= 0, 'queueWrite toetst het plafond niet');
  assert.ok(body.indexOf('await assertQueueHasRoom(caller)') < body.indexOf('buildApiProposal('),
    'het plafond hoort getoetst te worden voordat het plan queries draait.');
});

test('het voorstel bouwen WIJ, met dezelfde functies als Gerrie en de MCP', () => {
  const build = fn(api, 'async function buildApiProposal(');
  assert.match(build, /buildProposal\(gerrieContext\(caller\), action\.id, input\)/);
  assert.match(fn(api, 'async function buildRegistryProposal('), /action\.plan!\(actionContext\(caller\), input\)/);
  assert.match(fn(api, 'async function runRead('), /runGerrieTool\(gerrieContext\(caller\), action\.id, input\)/);
});

// ── Wat blijft ───────────────────────────────────────────────────────────────

test('elk voorstel en elke uitvoering staat in het auditlog, herleidbaar tot de sleutel', () => {
  const proposal = fn(api, 'async function insertProposal(');
  assert.match(proposal, /status: 'proposed'/);
  assert.match(proposal, /api_key_id: caller\.keyId/);
  assert.match(proposal, /action: `api:propose:\$\{action\.id\}`/);

  const execution = fn(api, 'async function recordExecution(');
  assert.match(execution, /status: 'auto_executed' \| 'failed'/);
  assert.match(execution, /api_key_id: caller\.keyId/);
  assert.match(execution, /action: `api:execute:\$\{proposal\.action_id\}`/);

  // Ook een uitvoering die mislukt.
  assert.match(fn(api, 'async function executeWrite('), /await recordExecution\(caller, proposal, 'failed', message\)/);
});

test('een ECHTE sleutel die geweigerd wordt, ziet de organisatie terug — een geraden niet', () => {
  const auth = fn(api, 'async function authenticate(');
  // Pas na de verifier hoort de sleutel bij een organisatie; daarvoor geen logregel.
  const known = auth.indexOf('const known = {');
  assert.ok(known > auth.indexOf('verifyToken('), 'een geraden sleutel zou anders het logboek van een organisatie kunnen vullen');
  assert.match(auth, /throw new AuthError\('Deze API-sleutel klopt niet\.'\);/);
  assert.match(auth, /throw new AuthError\('Deze API-sleutel is ingetrokken\.', known\);/);
  const log = fn(api, 'async function logRejectedKey(');
  assert.ok(log.indexOf("rpc('api_consume_rate_limit'") < log.indexOf("from('api_request_log')"),
    'ook een ingetrokken sleutel kan het logboek niet onbeperkt volschrijven');
});

test('invoer: een plafond ook zonder Content-Length, en niet te diep genest', () => {
  const body = fn(api, 'async function readBody(');
  assert.doesNotMatch(body, /req\.text\(\)|req\.json\(\)|arrayBuffer\(\)/, 'alles inlezen en dan pas meten laat een chunked body het geheugen vullen');
  assert.match(body, /if \(size > MAX_BODY_BYTES\) \{/);
  assert.ok(fn(api, 'function parseInput(').indexOf('tooDeep(parsed)') > 0);
  const adminBody = fn(apiAdmin, 'async function readBody(');
  assert.match(adminBody, /if \(size > MAX_BODY_BYTES\) \{/);
  assert.doesNotMatch(apiAdmin, /await req\.json\(\)/);
});

test('antwoorden met gegevens worden niet gecachet', () => {
  const json = fn(api, 'function json(');
  assert.match(json, /'Cache-Control': 'no-store',/);
  assert.ok(json.indexOf("'Cache-Control': 'no-store'") < json.indexOf('...extra'), 'alleen het open OpenAPI-document zet dit ruimer');
});

test('een Idempotency-Key: het hele verzoek telt, en een vastgelopen poging houdt hem niet vast', () => {
  const idem = fn(api, 'async function withIdempotency(');
  assert.match(idem, /requestFingerprint\(req\.method, route, rawBody, new URL\(req\.url\)\.search\)/);
  const claim = fn(api, 'async function claimIdempotencyKey(');
  assert.match(claim, /\.is\('status', null\)\s*\n\s*\.lt\('created_at', new Date\(Date\.now\(\) - IDEMPOTENCY_LEASE_MS\)/);
  // Langer dan een functie kan draaien: anders wordt een poging die nog loopt, dubbel uitgevoerd.
  assert.match(api, /const IDEMPOTENCY_LEASE_MS = 5 \* 60 \* 1000;/);
});

test('een databasefout in een handeling gaat niet letterlijk naar de koppeling', () => {
  const asApi = fn(api, 'function asApiError(');
  assert.match(asApi, /const outward = publicActionError\(error\.message\);/);
  assert.doesNotMatch(asApi, /new ApiError\(422, 'invalid_input', error\.message\)/);
});

test('elke aanroep met een geldige sleutel komt in het verzoeklog', () => {
  assert.match(api, /await logRequest\(req, route, method, caller, meta, response\.status, requestId, started\)/);
  const log = fn(api, 'async function logRequest(');
  assert.match(log, /from\('api_request_log'\)\.insert/);
  assert.match(log, /organization_id: caller\.organizationId/);
  assert.match(log, /api_key_id: caller\.keyId/);
});

// ── Wie geeft ────────────────────────────────────────────────────────────────

test('alleen owners en admins maken sleutels aan', () => {
  assert.match(apiAdmin, /case 'createKey':\s*\n\s*assertAdmin\(role\);/);
  assert.match(fn(apiAdmin, 'function assertAdmin('), /role !== 'owner' && role !== 'admin'/);
  // De organisatie komt uit het verzoek, maar pas NA de lidmaatschapscontrole.
  const serve = apiAdmin.slice(apiAdmin.indexOf('Deno.serve('));
  assert.ok(serve.indexOf('requireOrganizationAccess(admin, user.id, organizationId)') < serve.indexOf("case 'createKey'"));
});

test('wat een sleutel mag, volgt de trap en wordt bij het aanmaken vastgelegd', () => {
  const create = fn(apiAdmin, 'async function createKey(');
  assert.match(create, /scope: scopeForLevel\(access\)/);
  assert.match(create, /module_access: moduleAccess/);
  assert.match(create, /normalizeKeyModuleAccess\(body\.moduleAccess\)/);
  // Het geheim komt alleen gehasht in de database.
  assert.match(create, /verifier_hash: token\.hash/);
  assert.doesNotMatch(create, /verifier: token\.verifier/);
});

// ── Uitrol ───────────────────────────────────────────────────────────────────

test('beide functies staan in config.toml, met de reden voor verify_jwt = false', () => {
  assert.match(config, /\[functions\.api\]\nverify_jwt = false/);
  assert.match(config, /\[functions\.api-admin\]\nverify_jwt = false/);
});

test('beide functies lopen mee in de Deno-typecheck van de CI', () => {
  assert.match(ci, /supabase\/functions\/api\/index\.ts/);
  assert.match(ci, /supabase\/functions\/api-admin\/index\.ts/);
});

test('de API kent dezelfde modules als de MCP en edgeAuth', () => {
  const mcpModules = mcp.slice(mcp.indexOf('const MODULE_KEYS = ['), mcp.indexOf('] as const;', mcp.indexOf('const MODULE_KEYS = [')));
  assert.deepEqual([...mcpModules.matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...MODULE_KEYS]);
  const union = edgeAuth.slice(edgeAuth.indexOf('export type ModuleKey ='), edgeAuth.indexOf(';', edgeAuth.indexOf('export type ModuleKey =')));
  assert.deepEqual([...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort(), [...MODULE_KEYS].sort());
});
