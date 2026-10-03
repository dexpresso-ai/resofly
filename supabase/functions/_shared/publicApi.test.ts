import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToken, verifyToken } from './mcpAuth.ts';
import {
  ACCESS_LEVELS, actionInputSchema, apiKeyHint, apiRoute, auditStatusesFor, buildOpenApi, containsNul, createApiKey,
  effectiveModuleAccess, effectiveModuleLevel, errorBody, hasKeyRestrictions, isValidIdempotencyKey, keyModuleCap,
  levelOfScope, matchRoute, memberModuleLevel, MODULE_KEYS, normalizeKeyModuleAccess, operationIdFor, pageParams,
  parseApiKey, presentedApiKey, proposalStatus, PROPOSAL_STATUSES, publicActionError, REJECTED_BY_USER_DETAIL,
  requestFingerprint, scopeForLevel, tooDeep, type CatalogAction,
} from './publicApi.ts';

/**
 * Bewaakt de rekensommen waar de openbare API op rust.
 *
 * Net als bij mcpAuth.test.ts: dit is het stuk waar een fout niet opvalt. Een
 * sleutel die óók zonder de juiste verifier past, een modulebeperking die een
 * viewer ineens laat schrijven, een route die een pad verkeerd leest — het
 * werkt allemaal precies zo goed in het dagelijks gebruik. Vandaar dat elke
 * controle hier ook van de verkeerde kant wordt getest.
 */

const migration = readFileSync(new URL('../../migrations/20261003000000_public_api.sql', import.meta.url), 'utf8');

// ── Sleutels ─────────────────────────────────────────────────────────────────

test('een uitgegeven API-sleutel is te splitsen en te verifiëren', async () => {
  const key = await createApiKey();
  assert.match(key.plain, /^rsfapi\./);
  const parsed = parseApiKey(key.plain);
  assert.ok(parsed, 'een net uitgegeven sleutel hoort te splitsen');
  assert.equal(parsed.selector, key.selector);
  assert.equal(await verifyToken(parsed.verifier, key.salt, key.hash), true);
});

test('een MCP-token is geen API-sleutel, en andersom', async () => {
  // Het voorvoegsel is de eerste grens: een token van de ene deur hoort bij de
  // andere al op de vorm te stranden, nog vóór er een database aan te pas komt.
  const mcp = await createToken();
  assert.equal(parseApiKey(mcp.plain), null);
  const api = await createApiKey();
  const { parseToken } = await import('./mcpAuth.ts');
  assert.equal(parseToken(api.plain), null);
});

test('een misvormde sleutel levert niets op', () => {
  for (const bad of ['', 'rsfapi', 'rsfapi.alleen', 'rsfapi.a.b.c', 'rsfapi..b', 'rsfapi.a.', 'RSFAPI.a.b', 'rsfapi.a b.c']) {
    assert.equal(parseApiKey(bad), null, `"${bad}" hoort geweigerd te worden`);
  }
});

test('een sleutel heeft precies de lengte die wij uitgeven; al het andere zoeken we niet eens op', async () => {
  const key = await createApiKey();
  const [, selector, verifier] = key.plain.split('.');
  assert.equal(selector.length, 22);
  assert.equal(verifier.length, 43);
  assert.equal(parseApiKey(`rsfapi.${selector}x.${verifier}`), null);
  assert.equal(parseApiKey(`rsfapi.${selector}.${verifier.slice(1)}`), null);
  assert.equal(parseApiKey(`rsfapi.${'a'.repeat(5000)}.${verifier}`), null);
});

test('de hint op het scherm verraadt niets van het geheim', async () => {
  const key = await createApiKey();
  const hint = apiKeyHint(key.selector);
  assert.equal(hint, `rsfapi.${key.selector.slice(0, 6)}…`);
  assert.ok(!hint.includes(key.verifier.slice(0, 6)));
});

test('de sleutel komt uit Authorization: Bearer of uit X-Api-Key', () => {
  assert.equal(presentedApiKey(new Headers({ Authorization: 'Bearer rsfapi.a.b' })), 'rsfapi.a.b');
  assert.equal(presentedApiKey(new Headers({ authorization: 'bearer   rsfapi.a.b  ' })), 'rsfapi.a.b');
  assert.equal(presentedApiKey(new Headers({ 'X-Api-Key': 'rsfapi.c.d' })), 'rsfapi.c.d');
  // Authorization wint: dat is de standaard, X-Api-Key de uitwijkmogelijkheid.
  assert.equal(presentedApiKey(new Headers({ Authorization: 'Bearer rsfapi.a.b', 'X-Api-Key': 'rsfapi.c.d' })), 'rsfapi.a.b');
  assert.equal(presentedApiKey(new Headers({ Authorization: 'Basic abc' })), '');
  assert.equal(presentedApiKey(new Headers()), '');
});

// ── Toegangsniveaus ──────────────────────────────────────────────────────────

test('elk toegangsniveau is een trede met alles eronder', () => {
  assert.equal(scopeForLevel('read'), 'read');
  assert.equal(scopeForLevel('propose'), 'read propose');
  assert.equal(scopeForLevel('execute'), 'read propose execute');
  assert.equal(scopeForLevel('execute_high'), 'read propose execute execute_high');
  for (const level of ACCESS_LEVELS) assert.equal(levelOfScope(scopeForLevel(level)), level);
});

test('een onbekend niveau is een fout, geen stille terugval', () => {
  assert.throws(() => scopeForLevel('admin' as never));
});

test('een losse trede zonder de tussenliggende telt niet als het hoogste niveau', () => {
  // Kan in de database niet bestaan (api_scope_is_valid), maar de API rekent er
  // dan nog steeds voorzichtig mee.
  assert.equal(levelOfScope('read execute_high'), 'read');
});

test('de database kent precies dezelfde vier treden en dezelfde trap', () => {
  assert.match(migration, /x not in \('read', 'propose', 'execute', 'execute_high'\)/);
  assert.match(migration, /'read' = any\(s\.v\)/);
  assert.match(migration, /\(not \('execute' = any\(s\.v\)\) or 'propose' = any\(s\.v\)\)/);
  assert.match(migration, /\(not \('execute_high' = any\(s\.v\)\) or 'execute' = any\(s\.v\)\)/);
});

// ── Modules ──────────────────────────────────────────────────────────────────

test('het teamlid: owners en admins zijn nooit beperkt, een viewer nooit meer dan lezen', () => {
  assert.equal(memberModuleLevel('owner', { finance: 'none' }, 'finance'), 'write');
  assert.equal(memberModuleLevel('admin', { finance: 'none' }, 'finance'), 'write');
  assert.equal(memberModuleLevel('member', { finance: 'read' }, 'finance'), 'read');
  assert.equal(memberModuleLevel('member', {}, 'finance'), 'write', 'ontbrekende sleutel = volledig, net als org_module_level');
  assert.equal(memberModuleLevel('viewer', {}, 'finance'), 'read');
  assert.equal(memberModuleLevel('viewer', { finance: 'write' }, 'finance'), 'read');
  assert.equal(memberModuleLevel('viewer', { finance: 'none' }, 'finance'), 'none');
  assert.equal(memberModuleLevel('gast', {}, 'finance'), 'none', 'een onbekende rol krijgt niets');
});

test('de sleutel kan alleen afknijpen, nooit verruimen', () => {
  assert.equal(effectiveModuleLevel('owner', {}, { finance: 'none' }, 'finance'), 'none');
  assert.equal(effectiveModuleLevel('owner', {}, { finance: 'read' }, 'finance'), 'read');
  assert.equal(effectiveModuleLevel('owner', {}, {}, 'finance'), 'write');
  // Een viewer wordt met een sleutel geen schrijver, wat er ook in de sleutel staat.
  assert.equal(effectiveModuleLevel('viewer', {}, { finance: 'write' }, 'finance'), 'read');
  assert.equal(effectiveModuleLevel('member', { finance: 'none' }, {}, 'finance'), 'none');
  assert.equal(effectiveModuleLevel('member', { finance: 'read' }, { finance: 'none' }, 'finance'), 'none');
});

test('alleen none en read tellen als beperking', () => {
  assert.equal(keyModuleCap({ finance: 'write' }, 'finance'), 'write');
  assert.equal(keyModuleCap({ finance: 'iets' }, 'finance'), 'write');
  assert.equal(hasKeyRestrictions({}), false);
  assert.equal(hasKeyRestrictions({ finance: 'write' }), false);
  assert.equal(hasKeyRestrictions({ finance: 'read' }), true);
});

test('het raster in één keer volgt dezelfde regels', () => {
  const grid = effectiveModuleAccess('admin', {}, { marketing: 'none', finance: 'read' });
  assert.deepEqual(Object.keys(grid), [...MODULE_KEYS]);
  assert.equal(grid.marketing, 'none');
  assert.equal(grid.finance, 'read');
  assert.equal(grid.clients, 'write');
});

test('een modulebeperking wordt genormaliseerd, en een tikfout is een fout', () => {
  assert.deepEqual(normalizeKeyModuleAccess(undefined), {});
  assert.deepEqual(normalizeKeyModuleAccess({ finance: 'none', clients: 'write', time: 'read' }), { finance: 'none', time: 'read' });
  assert.throws(() => normalizeKeyModuleAccess({ finanse: 'none' }), /Onbekende module/);
  assert.throws(() => normalizeKeyModuleAccess({ finance: 'admin' }), /Ongeldig niveau/);
  assert.throws(() => normalizeKeyModuleAccess(['finance']));
  assert.throws(() => normalizeKeyModuleAccess('finance'));
});

test('de database kent precies dezelfde modules', () => {
  const fn = migration.slice(migration.indexOf('create or replace function public.api_module_access_is_valid'));
  const list = fn.slice(fn.indexOf('e.key not in ('), fn.indexOf(')', fn.indexOf('e.key not in (')));
  const modules = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(modules, [...MODULE_KEYS]);
});

// ── Routes ───────────────────────────────────────────────────────────────────

test('een pad wordt dezelfde route, hoe de functie ook bereikt wordt', () => {
  assert.equal(apiRoute('/api/v1/me'), '/v1/me');
  assert.equal(apiRoute('/functions/v1/api/v1/me'), '/v1/me');
  assert.equal(apiRoute('/v1/me'), '/v1/me', 'achter een eigen domein');
  assert.equal(apiRoute('/api/v1/actions/invoice.set_status/'), '/v1/actions/invoice.set_status');
  assert.equal(apiRoute('/api'), '/');
  assert.equal(apiRoute('/'), '/');
  // Alleen de functienaam valt weg, niet alles wat met "api" begint.
  assert.equal(apiRoute('/apitje/v1/me'), '/apitje/v1/me');
});

test('routes met parameters', () => {
  assert.deepEqual(matchRoute('/v1/actions/invoice.set_status', '/v1/actions/:id'), { id: 'invoice.set_status' });
  assert.deepEqual(matchRoute('/v1/actions/a%20b', '/v1/actions/:id'), { id: 'a b' });
  assert.equal(matchRoute('/v1/actions', '/v1/actions/:id'), null);
  assert.equal(matchRoute('/v1/actions/a/b', '/v1/actions/:id'), null);
  assert.equal(matchRoute('/v1/proposals/x', '/v1/actions/:id'), null);
  assert.equal(matchRoute('/v1/actions/%E0%A4%A', '/v1/actions/:id'), null, 'een kapotte codering is geen parameter');
});

test('limit en offset hebben grenzen', () => {
  assert.deepEqual(pageParams(new URLSearchParams('')), { limit: 25, offset: 0 });
  assert.deepEqual(pageParams(new URLSearchParams('limit=5000&offset=-3')), { limit: 100, offset: 0 });
  assert.deepEqual(pageParams(new URLSearchParams('limit=abc&offset=10')), { limit: 25, offset: 10 });
  assert.deepEqual(pageParams(new URLSearchParams('limit=0')), { limit: 1, offset: 0 });
  assert.deepEqual(pageParams(new URLSearchParams('limit=400'), { maxLimit: 500 }), { limit: 400, offset: 0 });
});

// ── Voorstellen ──────────────────────────────────────────────────────────────

test('de interne statussen vertalen naar wat de API belooft', () => {
  assert.equal(proposalStatus('proposed'), 'pending');
  assert.equal(proposalStatus('confirmed'), 'approved');
  assert.equal(proposalStatus('executed'), 'executed');
  assert.equal(proposalStatus('auto_executed'), 'executed');
  assert.equal(proposalStatus('cancelled'), 'cancelled');
  assert.equal(proposalStatus('failed', REJECTED_BY_USER_DETAIL), 'rejected');
  assert.equal(proposalStatus('failed', 'Mailserver weigerde'), 'failed');
  assert.equal(proposalStatus('failed', null), 'failed');
  assert.equal(proposalStatus('iets nieuws'), 'failed', 'een status die we niet kennen is geen succes');
});

test('filteren op een API-status vindt precies de rijen die zo vertaald worden', () => {
  for (const status of PROPOSAL_STATUSES) {
    for (const internal of auditStatusesFor(status)) {
      const detail = status === 'rejected' ? REJECTED_BY_USER_DETAIL : 'iets anders';
      assert.equal(proposalStatus(internal, detail), status, `${internal} hoort bij ${status}`);
    }
  }
});

test('"afgewezen" is dezelfde zin als die de goedkeurwachtrij en de database schrijven', () => {
  // De app stuurt een afwijzing als deze zin (dat verstaat ook een oudere
  // server), en ai_action_decide schrijft hem in de audit. Een andere zin, en
  // de API toont een afwijzing als mislukking.
  const client = readFileSync(new URL('../../../src/lib/gerrie-api.ts', import.meta.url), 'utf8');
  assert.ok(client.includes(`const REJECTED_DETAIL = '${REJECTED_BY_USER_DETAIL}';`));
  const approvals = readFileSync(new URL('../../../src/components/AgentApprovals.tsx', import.meta.url), 'utf8');
  assert.match(approvals.slice(approvals.indexOf('async function reject('), approvals.indexOf('async function reject(') + 400),
    /await rejectGerrieAction\(organizationId, item\.auditId\);/);
  const migration = readFileSync(new URL('../../migrations/20261003040000_approvals_auth_limits.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes(`v_rejected constant text := '${REJECTED_BY_USER_DETAIL}';`));
});

// ── Idempotentie en fouten ───────────────────────────────────────────────────

test('een Idempotency-Key is 1 tot 255 zichtbare tekens', () => {
  assert.equal(isValidIdempotencyKey('abc-123_X'), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(255)), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(256)), false);
  assert.equal(isValidIdempotencyKey(''), false);
  assert.equal(isValidIdempotencyKey('met spatie'), false);
  assert.equal(isValidIdempotencyKey('regel\nbreuk'), false);
});

test('de vingerafdruk van een verzoek hangt af van methode, route én inhoud', async () => {
  const a = await requestFingerprint('POST', '/v1/actions/x', '{"a":1}');
  assert.equal(a, await requestFingerprint('post', '/v1/actions/x', '{"a":1}'));
  assert.notEqual(a, await requestFingerprint('POST', '/v1/actions/y', '{"a":1}'));
  assert.notEqual(a, await requestFingerprint('POST', '/v1/actions/x', '{"a":2}'));
  // ?mode=queue is een ander verzoek dan zonder: dezelfde sleutel mag er niet het antwoord van de ander voor krijgen.
  assert.notEqual(a, await requestFingerprint('POST', '/v1/actions/x', '{"a":1}', '?mode=queue'));
  assert.equal(a, await requestFingerprint('POST', '/v1/actions/x', '{"a":1}', ''));
});

test('te diep geneste invoer wordt herkend, zonder zelf om te vallen', () => {
  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let i = 0; i < 10_000; i += 1) { deep.a = {}; deep = deep.a as Record<string, unknown>; }
  assert.equal(tooDeep(root), true);
  assert.equal(tooDeep({ a: [{ b: { c: [1, 2, 3] } }] }), false);
  assert.equal(tooDeep('tekst'), false);
});

test('een databasefout in een handeling: de zin voor de koppeling, de details voor ons logboek', () => {
  assert.deepEqual(publicActionError('Klant ophalen mislukt: canceling statement due to statement timeout'),
    { status: 500, message: 'Klant ophalen mislukt.' });
  assert.deepEqual(publicActionError('Taak opslaan mislukt: new row for relation "tasks" violates check constraint "x"'),
    { status: 422, message: 'Taak opslaan mislukt: de invoer past niet bij de regels van ResoFly.' });
  assert.deepEqual(publicActionError('Het bericht koppelen mislukte: permission denied for table mails'),
    { status: 500, message: 'Het bericht koppelen mislukte.' });
  // Een eigen zin blijft een eigen zin.
  for (const own of ['Deze factuur is al betaald.', 'Versturen mislukt: het e-mailadres ontbreekt.', 'Ongeldige syntaxis in de zoekopdracht.']) {
    assert.deepEqual(publicActionError(own), { status: 422, message: own });
  }
  assert.equal(publicActionError('duplicate key value violates unique constraint "a"').status, 422);
  assert.doesNotMatch(publicActionError('duplicate key value violates unique constraint "a"').message, /constraint/);
});

test('een fout heeft altijd dezelfde vorm', () => {
  assert.deepEqual(errorBody('not_found', 'Weg.', 'req-1'), { error: { code: 'not_found', message: 'Weg.', request_id: 'req-1' } });
  assert.deepEqual(errorBody('invalid_input', 'Fout.', 'req-2', { field: 'x' }).error, {
    code: 'invalid_input', message: 'Fout.', request_id: 'req-2', details: { field: 'x' },
  });
});

// ── OpenAPI ──────────────────────────────────────────────────────────────────

const SAMPLE: CatalogAction[] = [
  { id: 'invoice.set_status', label: 'Factuurstatus wijzigen', module: 'finance', kind: 'write', risk: 'high', description: 'Zet de status.', input: { invoice_id: { type: 'string' }, status: { type: 'string' } }, required: ['invoice_id', 'status'] },
  { id: 'inbox.list', label: 'Postvak', module: 'clients', kind: 'read', description: 'Lijst.', input: {}, required: [] },
  { id: 'propose_client', label: 'Nieuwe klant', module: 'clients', kind: 'write', description: 'Klant.', input: { name: { type: 'string' } }, required: ['name'] },
];

test('het OpenAPI-document heeft elke handeling als eigen pad, met zijn schema', () => {
  const doc = buildOpenApi({ serverUrl: 'https://example.test/functions/v1/api', actions: SAMPLE }) as Record<string, any>;
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(doc.servers, [{ url: 'https://example.test/functions/v1/api' }]);
  for (const action of SAMPLE) {
    const op = doc.paths[`/v1/actions/${action.id}`]?.post;
    assert.ok(op, `${action.id} ontbreekt`);
    assert.deepEqual(op.requestBody.content['application/json'].schema, actionInputSchema(action));
    assert.equal(op.operationId, operationIdFor(action.id));
    // Een schrijf-handeling kan worden klaargezet; een lees-handeling niet.
    assert.equal(Boolean(op.responses[202]), action.kind === 'write');
  }
  // Elke $ref wijst naar iets dat bestaat.
  const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(schemas|parameters)\/([A-Za-z]+)"/g)];
  assert.ok(refs.length > 10);
  for (const [, kind, name] of refs) assert.ok(doc.components[kind][name], `${kind}/${name} bestaat niet`);
});

test('operationIds zijn uniek en geldig', () => {
  const doc = buildOpenApi({ serverUrl: 'https://x', actions: SAMPLE }) as Record<string, any>;
  const ids: string[] = [];
  for (const item of Object.values(doc.paths) as Array<Record<string, any>>) {
    for (const op of Object.values(item)) if (op && typeof op === 'object' && op.operationId) ids.push(op.operationId);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_]+$/);
});

test('een handeling zonder verplichte velden heeft ook geen lege required-lijst', () => {
  // Een lege `required: []` keuren sommige validators af.
  assert.equal('required' in actionInputSchema(SAMPLE[1]), false);
  assert.deepEqual(actionInputSchema(SAMPLE[0]).required, ['invoice_id', 'status']);
});

// ── Bevindingen uit de veiligheidstest (oktober 2026) ────────────────────────

test('een API-sleutel in X-Api-Key telt, ook als een platform zelf een andere Authorization zet', () => {
  const headers = (init: Record<string, string>) => new Headers(init);
  assert.equal(presentedApiKey(headers({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.anon.sig', 'x-api-key': 'rsfapi.sel.ver' })), 'rsfapi.sel.ver');
  assert.equal(presentedApiKey(headers({ authorization: 'Bearer rsfapi.a.b', 'x-api-key': 'rsfapi.c.d' })), 'rsfapi.a.b', 'Bearer gaat voor als het een API-sleutel is');
  assert.equal(presentedApiKey(headers({ authorization: 'bearer   rsfapi.a.b  ' })), 'rsfapi.a.b');
  assert.equal(presentedApiKey(headers({ authorization: 'Bearer eyJ.x.y' })), 'eyJ.x.y', 'zonder X-Api-Key: wat er staat, zodat de foutmelding klopt');
  assert.equal(presentedApiKey(headers({})), '');
});

test('een NUL-teken in de invoer wordt gevonden, hoe diep ook', () => {
  assert.equal(containsNul({ name: 'gewoon', tags: ['a', 'b'], extra: { x: 1 } }), false);
  assert.equal(containsNul({ name: 'a\u0000b' }), true);
  assert.equal(containsNul({ lines: [{ text: 'ok' }, { text: 'n\u0000' }] }), true);
  assert.equal(containsNul({ ['k\u0000']: 1 }), true, 'ook in een veldnaam');
  assert.equal(containsNul(null), false);
});
