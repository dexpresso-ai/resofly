import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_SECONDS } from './webhooks.ts';

/**
 * Bewaakt de grenzen van de uitgaande webhooks: de bezorger (functie
 * `webhooks`), het beheer (`api`, `api-admin`, webhookAdmin.ts) en het
 * versturen zelf (webhookDelivery.ts).
 *
 * Als TEKST gelezen, net als publicApiServer.test.ts: de serverkant leunt op
 * Deno-imports. De rekensommen (handtekening, adressen, herhaalschema) staan in
 * webhooks.test.ts; hier gaat het erom dat ze op de goede plek worden toegepast.
 *
 *   WIE ROEPT   — de bezorger doet niets zonder het cron-secret, en claimt
 *                 niets zonder de sleutel om geheimen te ontsleutelen.
 *   WAARHEEN    — het adres wordt bij elke bezorging opnieuw gekeurd, een
 *                 doorverwijzing niet gevolgd, en niemand wacht eindeloos.
 *   WAT MAG     — een eindpunt van een sleutel krijgt alleen wat die sleutel NU
 *                 mag lezen, en een koppeling ziet alleen haar eigen eindpunten.
 *   WIE BEHEERT — in de app alleen owners en admins; het geheim gaat alleen
 *                 versleuteld de database in en komt er nooit leesbaar uit.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const dispatcher = read('../webhooks/index.ts');
const delivery = read('./webhookDelivery.ts');
const webhookAdmin = read('./webhookAdmin.ts');
const api = read('../api/index.ts');
const apiAdmin = read('../api-admin/index.ts');
const migration = read('../../migrations/20261003010000_webhooks.sql');
const ui = read('../../../src/components/WebhookEndpoints.tsx');
const config = read('../../config.toml');
const ci = read('../../../.github/workflows/frontend-checks.yml');

/** De tekst van één functie, van zijn kop tot de eerste regel met alleen `}`. */
function fn(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `"${header}" niet gevonden`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** De waarde van `const NAAM = 40_000;`. */
function numberConst(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+);`));
  assert.ok(match, `const ${name} niet gevonden`);
  return Number(match[1].replace(/_/g, ''));
}

/** De standaardwaarde van een parameter van een SQL-functie. */
function sqlDefault(name: string): number {
  const match = migration.match(new RegExp(`${name} integer default (\\d+)`));
  assert.ok(match, `${name} niet gevonden in de migratie`);
  return Number(match[1]);
}

// ── Wie roept ────────────────────────────────────────────────────────────────

test('de bezorger doet niets zonder het cron-secret', () => {
  const serve = dispatcher.slice(dispatcher.indexOf('Deno.serve('));
  const empty = serve.indexOf('if (!CRON_SECRET)');
  const compare = serve.indexOf("timingSafeEqual(req.headers.get('x-cron-secret') || '', CRON_SECRET)");
  const claim = serve.indexOf("admin.rpc('claim_webhook_deliveries'");
  assert.ok(empty >= 0 && compare >= 0 && claim >= 0);
  // Andersom past een lege header op een leeg secret.
  assert.ok(empty < compare, 'een ontbrekend secret hoort geweigerd te worden vóór de vergelijking');
  assert.ok(compare < claim, 'er wordt geclaimd voordat het secret is gecontroleerd');
  assert.match(config, /\[functions\.webhooks\]\nverify_jwt = false/);
});

test('zonder versleutelsleutel wordt er niets geclaimd', () => {
  // Anders gaat elke bezorging als mislukt het log in en telt hij als poging.
  const serve = dispatcher.slice(dispatcher.indexOf('Deno.serve('));
  assert.ok(serve.indexOf('if (!ENCRYPTION_KEY)') >= 0);
  assert.ok(serve.indexOf('if (!ENCRYPTION_KEY)') < serve.indexOf("admin.rpc('claim_webhook_deliveries'"));
});

test('de bezorger en de database tellen dezelfde pogingen en hetzelfde plafond', () => {
  assert.match(dispatcher, /p_max_attempts: MAX_DELIVERY_ATTEMPTS/);
  assert.equal(sqlDefault('p_max_attempts'), MAX_DELIVERY_ATTEMPTS, 'de standaard in claim_webhook_deliveries loopt achter op het schema');
  assert.equal(MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_SECONDS.length + 1);
  assert.match(dispatcher, /p_per_endpoint: PER_ENDPOINT/);
  assert.equal(sqlDefault('p_per_endpoint'), numberConst(dispatcher, 'PER_ENDPOINT'));
  assert.ok(numberConst(dispatcher, 'PER_ENDPOINT') < numberConst(dispatcher, 'CONCURRENCY'),
    'met een plafond gelijk aan het aantal bezorgers kan één eindpunt ze nog steeds allemaal bezetten.');
});

test('het plafond per eindpunt telt mee wat al onderweg is, ook uit een andere ronde', () => {
  const claim = migration.slice(migration.indexOf('create or replace function public.claim_webhook_deliveries('));
  assert.match(claim, /row_number\(\) over \(partition by due\.ep order by due\.due_at, due\.id\) \+ coalesce\(f\.n, 0\) as slot/);
  assert.match(claim, /where r\.slot <= greatest\(1, coalesce\(p_per_endpoint, 4\)\)/);
  assert.match(claim, /for update of d skip locked/);
});

test('een ronde is klaar lang voordat een hangende bezorging wordt teruggepakt', () => {
  // Wat na het budget nog onderweg of geclaimd is, wordt afgemaakt: hooguit de
  // bezorgingen die al liepen plus één claim, elk met DNS en een time-out.
  const budget = numberConst(dispatcher, 'ROUND_BUDGET_MS');
  const perDelivery = numberConst(delivery, 'TIMEOUT_MS') + 2 * numberConst(delivery, 'DNS_TIMEOUT_MS');
  const waves = 1 + Math.ceil(numberConst(dispatcher, 'CLAIM_SIZE') / numberConst(dispatcher, 'CONCURRENCY'));
  const worstCase = budget + waves * perDelivery;
  assert.match(migration, /d\.last_attempt_at < now\(\) - interval '5 minutes'/);
  assert.ok(worstCase < 5 * 60_000, `een ronde kan ${worstCase / 1000}s duren; dan pakt de volgende hem terug terwijl hij nog loopt`);
  assert.ok(worstCase < 150_000, `een ronde kan ${worstCase / 1000}s duren; de Edge-runtime stopt (gratis plan) na 150s`);
});

test('wat geclaimd is, wordt ook na het budget nog bezorgd', () => {
  const start = dispatcher.indexOf('const worker = async');
  const worker = dispatcher.slice(start, dispatcher.indexOf('await Promise.all(', start));
  assert.ok(start >= 0 && worker.length > 0);
  assert.ok(worker.indexOf('queue.shift()') < worker.indexOf('ROUND_BUDGET_MS'),
    'een geclaimde bezorging die blijft liggen, staat vijf minuten op sending en telt als poging.');
});

// ── Waarheen ─────────────────────────────────────────────────────────────────

test('elke bezorging keurt het adres opnieuw, en pas daarna gaat er iets de deur uit', () => {
  const body = fn(delivery, 'export async function deliver(');
  const send = body.indexOf('await fetch(delivery.url');
  assert.ok(send > 0);
  assert.ok(body.indexOf('webhookUrlProblem(delivery.url)') < send, 'het adres wordt niet gekeurd voor het versturen');
  assert.ok(body.indexOf('privateResolution(delivery.url)') < send, 'de naam wordt niet opgezocht voor het versturen');
  assert.match(body, /disable: problem/, 'een adres dat naar binnen wijst, hoort het eindpunt uit te zetten, niet acht keer opnieuw te proberen.');
});

test('een doorverwijzing wordt niet gevolgd, en niemand wacht eindeloos', () => {
  const body = fn(delivery, 'export async function deliver(');
  assert.match(body, /redirect: 'manual'/, 'een doorverwijzing kan naar een adres wijzen dat niemand heeft gekeurd.');
  assert.match(body, /signal: AbortSignal\.timeout\(TIMEOUT_MS\)/);
  assert.ok(numberConst(delivery, 'TIMEOUT_MS') <= 30_000);
  // Een DNS-opzoeking die te lang duurt, is geen vrijbrief om toch te versturen.
  const resolution = fn(delivery, 'async function privateResolution(');
  assert.match(resolution, /if \(error instanceof DnsTimeout\) throw error;/);
});

test('ondertekend wordt precies wat er verstuurd wordt', () => {
  const body = fn(delivery, 'export async function deliver(');
  assert.match(body, /signPayload\(secret, timestamp, body\)/);
  assert.match(body, /'ResoFly-Signature': signature/);
  assert.match(body, /'ResoFly-Event-Id': delivery\.event_id/);
  assert.match(body, /\n\s*body,\n/, 'de fetch hoort dezelfde body te versturen als die ondertekend is');
});

// ── Wat mag ──────────────────────────────────────────────────────────────────

test('een eindpunt van een sleutel krijgt alleen wat die sleutel NU mag lezen', () => {
  const body = fn(delivery, 'export async function deliver(');
  assert.ok(body.indexOf('keyRefusal(') >= 0 && body.indexOf('keyRefusal(') < body.indexOf('await fetch('),
    'de rechten van de sleutel worden niet gewogen voordat het bericht vertrekt');
  const load = fn(delivery, 'async function loadKeyAccess(');
  assert.match(load, /key\.revoked_at/);
  assert.match(load, /key\.expires_at/);
  assert.match(load, /from\('organization_members'\)[\s\S]{0,200}\.eq\('status', 'active'\)/);
  assert.match(fn(delivery, 'async function keyRefusal('),
    /effectiveModuleLevel\(access\.role, access\.memberAccess, access\.keyAccess, delivery\.event_module\)/);
});

test('een koppeling ziet en beheert alleen haar eigen eindpunten', () => {
  for (const name of ['export async function listEndpoints(', 'export async function getEndpoint(']) {
    const body = fn(webhookAdmin, name);
    assert.match(body, /\.eq\('organization_id', owner\.organizationId\)/, `${name} filtert niet op de organisatie`);
    assert.match(body, /if \(owner\.apiKeyId\) query = query\.eq\('api_key_id', owner\.apiKeyId\);/, `${name} filtert niet op de sleutel`);
  }
  // Alles wat één eindpunt raakt, kijkt eerst of het van deze kant is.
  for (const name of ['updateEndpoint(', 'rotateSecret(', 'deleteEndpoint(', 'listDeliveries(', 'testEndpoint(']) {
    const body = fn(webhookAdmin, `export async function ${name}`);
    assert.match(body, /await getEndpoint\(admin, owner, endpointId\);/, `${name} slaat de eigendomscontrole over`);
  }
  const owner = fn(api, 'function webhookOwner(');
  assert.match(owner, /organizationId: caller\.organizationId/);
  assert.match(owner, /apiKeyId: caller\.keyId/);
  assert.match(owner, /canRead: \(module: string\) => moduleLevel\(caller, module\) !== 'none'/);
});

test('webhooks via de API bestaan pas na de sleutelcontrole', () => {
  const serve = api.slice(api.indexOf('Deno.serve('));
  assert.ok(serve.indexOf('caller = await authenticate(req);') < serve.indexOf('response = await handle('));
  assert.match(fn(api, 'async function handle('), /return await handleWebhooks\(req, url, route, method, caller, requestId\);/);
});

test('wie om een gebeurtenis vraagt die hij niet mag lezen, hoort dat meteen', () => {
  const check = fn(webhookAdmin, 'function checkEvents(');
  assert.match(check, /if \(owner\.canRead && !events\.includes\('\*'\)\)/);
  assert.match(check, /, 422\);/);
});

test('een ingetrokken sleutel neemt zijn eindpunten mee', () => {
  const revoke = migration.slice(migration.indexOf('create or replace function public.api_keys_on_revoke()'));
  assert.match(revoke, /delete from public\.webhook_endpoints where api_key_id = new\.id/);
});

// ── Wie beheert ──────────────────────────────────────────────────────────────

test('in de app beheren alleen owners en admins webhooks', () => {
  for (const action of ['createWebhook', 'updateWebhook', 'rotateWebhookSecret', 'deleteWebhook', 'testWebhook']) {
    assert.match(apiAdmin, new RegExp(`case '${action}':\\s*\\n\\s*assertAdmin\\(role\\);`), `${action} slaat de admincontrole over`);
  }
  const serve = apiAdmin.slice(apiAdmin.indexOf('Deno.serve('));
  assert.ok(serve.indexOf('requireOrganizationAccess(admin, user.id, organizationId)') < serve.indexOf("case 'createWebhook'"));
  assert.match(serve, /apiKeyId: null, canRead: null/);
});

test('het geheim gaat alleen versleuteld de database in', () => {
  const create = fn(webhookAdmin, 'export async function createEndpoint(');
  assert.match(create, /const encrypted = await encryptSecret\(secret, encryptionKey\);/);
  assert.match(create, /secret_encrypted: encrypted/);
  assert.match(fn(webhookAdmin, 'export async function rotateSecret('), /secret_encrypted: await encryptSecret\(secret, encryptionKey\)/);
  assert.doesNotMatch(webhookAdmin, /secret_encrypted: secret\b/);
});

test('en komt er nooit leesbaar uit', () => {
  assert.doesNotMatch(fn(api, 'function presentEndpoint('), /secret/);
  assert.doesNotMatch(webhookAdmin.match(/ENDPOINT_COLUMNS = '([^']+)'/)?.[1] ?? 'secret', /secret/);
  // De tabel met geheimen: RLS aan, geen enkele policy, geen rechten voor de app.
  assert.match(migration, /alter table public\.webhook_endpoint_secrets enable row level security;/);
  assert.match(migration, /revoke all on public\.webhook_endpoint_secrets from anon, authenticated;/);
  assert.doesNotMatch(migration, /create policy [^;]* on public\.webhook_endpoint_secrets/);
});

test('claimen en afronden kan alleen de bezorger', () => {
  assert.match(migration, /revoke all on function public\.claim_webhook_deliveries\(integer, integer, integer\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.claim_webhook_deliveries\(integer, integer, integer\) to service_role;/);
  assert.match(migration, /revoke all on function public\.finish_webhook_delivery\([^)]*\) from public, anon, authenticated;/);
  for (const name of ['claim_webhook_deliveries', 'finish_webhook_delivery']) {
    const body = migration.slice(migration.indexOf(`create or replace function public.${name}(`));
    assert.match(body.slice(0, 2500), /if auth\.role\(\) is distinct from 'service_role' then/, `${name} controleert de rol niet zelf`);
  }
});

// ── Uitrol en uitleg ─────────────────────────────────────────────────────────

test('de bezorger loopt mee in de Deno-typecheck van de CI', () => {
  assert.match(ci, /supabase\/functions\/webhooks\/index\.ts/);
});

test('wat het scherm over herhalen zegt, klopt met het schema', () => {
  const total = RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0) / 86_400;
  assert.ok(total > 2.5 && total < 3);
  assert.match(ui, /bijna drie dagen/);
});
