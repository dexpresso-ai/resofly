import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createWebhookSecret, decryptSecret, encryptSecret, eventMatches, isPrivateAddress, MAX_DELIVERY_ATTEMPTS, modulesOf,
  nextRetryDelay, normalizeEventList, PING_EVENT, RETRY_DELAYS_SECONDS, signatureHeader, signPayload, verifySignature,
  WEBHOOK_ENTITIES, WEBHOOK_EVENTS, webhookBody, webhookEvent, webhookUrlProblem,
} from './webhooks.ts';
import { MODULE_KEYS } from './publicApi.ts';

/**
 * Bewaakt de uitgaande webhooks.
 *
 * Wat hier misgaat, gaat stil mis. Een handtekening die ook zonder het juiste
 * geheim klopt, merkt niemand; een adres dat naar binnen wijst, werkt prima —
 * tot iemand het misbruikt; een gebeurtenis in de catalogus die door geen enkele
 * trigger gemaakt wordt, is een abonnement dat nooit een bericht oplevert. Dus
 * elke controle hier ook van de verkeerde kant.
 */

const migration = readFileSync(new URL('../../migrations/20261003010000_webhooks.sql', import.meta.url), 'utf8');

// ── De catalogus en de triggers ──────────────────────────────────────────────

/** Welke typen de triggers in de migratie kunnen maken, met hun module. */
function producibleEvents(): Map<string, string> {
  const block = migration.slice(migration.indexOf('select * from (values'), migration.indexOf(') as t(table_name, entity, module, ops)'));
  const specs = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z ]+)'\)/g)]
    .map(([, table, entity, module, ops]) => ({ table, entity, module, ops: ops.split(' or ') }));
  assert.ok(specs.length >= 10, `verwacht minstens 10 tabellen met een trigger, gevonden: ${specs.length}`);

  const produced = new Map<string, string>();
  for (const spec of specs) {
    if (spec.ops.includes('insert')) produced.set(`${spec.entity}.created`, spec.module);
    if (spec.ops.includes('update')) produced.set(`${spec.entity}.updated`, spec.module);
    if (spec.ops.includes('delete')) produced.set(`${spec.entity}.deleted`, spec.module);
  }
  // De afgeleide gebeurtenissen uit webhook_status_event — alleen voor een
  // onderwerp waarvan de trigger een insert of update ziet.
  const statusFn = migration.slice(migration.indexOf('function public.webhook_status_event'), migration.indexOf('function public.webhook_event_matches'));
  for (const [, entity, , type] of statusFn.matchAll(/when p_entity = '([a-z_]+)' and p_status = '([a-z_]+)' then '([a-z_.]+)'/g)) {
    const spec = specs.find((s) => s.entity === entity);
    assert.ok(spec, `webhook_status_event kent "${entity}", maar daar hangt geen trigger aan`);
    assert.ok(type.startsWith(`${entity}.`), `${type} hoort bij ${entity}`);
    produced.set(type, spec!.module);
  }
  return produced;
}

test('elke gebeurtenis in de catalogus wordt door een trigger gemaakt, en andersom', () => {
  const produced = producibleEvents();
  const catalog = new Map(WEBHOOK_EVENTS.map((e) => [e.type, e.module]));
  const unmade = [...catalog.keys()].filter((type) => !produced.has(type));
  const unlisted = [...produced.keys()].filter((type) => !catalog.has(type));
  assert.deepEqual(unmade, [], `in de catalogus maar door geen trigger gemaakt — een abonnement dat nooit iets oplevert: ${unmade.join(', ')}`);
  assert.deepEqual(unlisted, [], `door een trigger gemaakt maar niet in de catalogus — niemand kan erop abonneren: ${unlisted.join(', ')}`);
});

test('de module van een gebeurtenis is dezelfde in de catalogus en in de trigger', () => {
  // Daarop weegt de bezorger of een eindpunt van een API-sleutel hem mag horen.
  const produced = producibleEvents();
  for (const event of WEBHOOK_EVENTS) {
    assert.equal(event.module, produced.get(event.type), `${event.type}: catalogus zegt ${event.module}, trigger zegt ${produced.get(event.type)}`);
    assert.ok((MODULE_KEYS as readonly string[]).includes(event.module), `${event.type}: onbekende module ${event.module}`);
  }
});

test('de catalogus heeft geen dubbele typen en een label bij elk', () => {
  const types = WEBHOOK_EVENTS.map((e) => e.type);
  assert.equal(new Set(types).size, types.length);
  for (const event of WEBHOOK_EVENTS) {
    assert.match(event.type, /^[a-z_]+\.[a-z_]+$/);
    assert.ok(event.label.length > 3);
  }
  assert.equal(webhookEvent('invoice.paid')?.module, 'finance');
  assert.equal(webhookEvent(PING_EVENT), undefined, 'ping is geen abonnement');
});

// ── Abonneren ────────────────────────────────────────────────────────────────

test('exact, onderwerp.* en * — en verder niets', () => {
  assert.equal(eventMatches(['invoice.paid'], 'invoice.paid'), true);
  assert.equal(eventMatches(['invoice.paid'], 'invoice.sent'), false);
  assert.equal(eventMatches(['invoice.*'], 'invoice.sent'), true);
  assert.equal(eventMatches(['invoice.*'], 'invoice_line.sent'), false, 'een voorvoegsel is geen onderwerp');
  assert.equal(eventMatches(['*'], 'ticket.created'), true);
  assert.equal(eventMatches([], 'ticket.created'), false);
  assert.equal(eventMatches(['inv*'], 'invoice.paid'), false, 'alleen hele onderwerpen kunnen een wildcard krijgen');
});

test('de database rekent abonnementen op dezelfde drie manieren', () => {
  const fn = migration.slice(migration.indexOf('function public.webhook_event_matches'), migration.indexOf('-- ── 2. De eindpunten'));
  assert.match(fn, /where ev = '\*'/);
  assert.match(fn, /or ev = p_type/);
  assert.match(fn, /right\(ev, 2\) = '\.\*' and split_part\(p_type, '\.', 1\) = left\(ev, length\(ev\) - 2\)/);
});

test('een abonnementenlijst wordt opgeschoond, en een tikfout is een fout', () => {
  assert.deepEqual(normalizeEventList(['invoice.paid', 'client.*', 'invoice.paid']), ['client.*', 'invoice.paid']);
  assert.deepEqual(normalizeEventList(['invoice.paid', '*']), ['*']);
  assert.throws(() => normalizeEventList(['invoice.payed']), /Onbekende gebeurtenis/);
  assert.throws(() => normalizeEventList(['factuur.*']), /Onbekende gebeurtenis/);
  assert.throws(() => normalizeEventList([]), /minstens één/);
  assert.throws(() => normalizeEventList('invoice.paid'), /minstens één/);
  for (const entity of WEBHOOK_ENTITIES) assert.deepEqual(normalizeEventList([`${entity}.*`]), [`${entity}.*`]);
});

test('uit welke modules een abonnement berichten kan krijgen', () => {
  assert.deepEqual(modulesOf(['invoice.paid', 'client.created']), ['clients', 'finance']);
  assert.deepEqual(modulesOf(['task.*']), ['projects']);
  assert.ok(modulesOf(['*']).length >= 6);
});

// ── De handtekening ──────────────────────────────────────────────────────────

test('een ondertekend bericht klopt, en een gewijzigd bericht niet', async () => {
  const secret = createWebhookSecret();
  const body = webhookBody({ id: 'e1', type: 'invoice.paid', created_at: '2026-10-03T08:00:00Z', organization_id: 'o1', data: { object: { id: 'i1' } } });
  const now = 1_790_000_000;
  const header = signatureHeader(now, await signPayload(secret, now, body));
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(await verifySignature(secret, header, body, { now }), true);
  assert.equal(await verifySignature(secret, header, body.replace('i1', 'i2'), { now }), false, 'een andere body');
  assert.equal(await verifySignature(createWebhookSecret(), header, body, { now }), false, 'een ander geheim');
  assert.equal(await verifySignature(secret, header.replace(/t=\d+/, `t=${now + 1}`), body, { now }), false, 'een andere tijd');
});

test('een oud bericht wordt geweigerd, ook met een kloppende handtekening', async () => {
  // De tijd zit in de handtekening; zonder deze controle is een onderschept
  // bericht eeuwig opnieuw af te spelen.
  const secret = createWebhookSecret();
  const signedAt = 1_790_000_000;
  const header = signatureHeader(signedAt, await signPayload(secret, signedAt, '{}'));
  assert.equal(await verifySignature(secret, header, '{}', { now: signedAt + 299 }), true);
  assert.equal(await verifySignature(secret, header, '{}', { now: signedAt + 301 }), false);
  assert.equal(await verifySignature(secret, header, '{}', { now: signedAt - 301 }), false);
});

test('een misvormde handtekening-header levert nooit "geldig" op', async () => {
  const secret = createWebhookSecret();
  for (const bad of ['', 't=,v1=', 'v1=abc', 't=1790000000', 't=abc,v1=' + 'a'.repeat(64), 't=1790000000,v1=' + 'z'.repeat(64)]) {
    assert.equal(await verifySignature(secret, bad, '{}', { now: 1_790_000_000 }), false, `"${bad}"`);
  }
});

test('een webhookgeheim heeft een herkenbare vorm en is uniek', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 30; i += 1) {
    const secret = createWebhookSecret();
    assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    seen.add(secret);
  }
  assert.equal(seen.size, 30);
});

// ── Het geheim in de database ────────────────────────────────────────────────

test('het geheim gaat versleuteld de database in en komt er ongeschonden uit', async () => {
  const secret = createWebhookSecret();
  const stored = await encryptSecret(secret, 'sleutel-1');
  assert.ok(!stored.includes(secret.slice(6)), 'het geheim staat leesbaar in de opgeslagen waarde');
  assert.match(stored, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(await decryptSecret(stored, 'sleutel-1'), secret);
  assert.notEqual(await encryptSecret(secret, 'sleutel-1'), stored, 'twee keer versleutelen hoort een andere IV te gebruiken');
});

test('zonder de juiste sleutel komt het geheim er niet uit', async () => {
  const stored = await encryptSecret(createWebhookSecret(), 'sleutel-1');
  await assert.rejects(() => decryptSecret(stored, 'sleutel-2'));
  await assert.rejects(() => decryptSecret('v2.a.b', 'sleutel-1'), /onbekende vorm/);
  await assert.rejects(() => encryptSecret('x', ''), /WEBHOOK_SECRET_ENCRYPTION_KEY/);
});

// ── Welke adressen er mogen ──────────────────────────────────────────────────

test('een gewoon https-adres mag', () => {
  for (const ok of ['https://hooks.example.com/resofly', 'https://hooks.zapier.com/hooks/catch/1/abc/', 'https://example.com:8443/x?y=1', 'https://8.8.8.8/hook']) {
    assert.equal(webhookUrlProblem(ok), null, ok);
  }
});

test('alles wat naar binnen wijst of onversleuteld is, mag niet', () => {
  for (const bad of [
    '', 'geen adres', 'http://hooks.example.com/x', 'ftp://example.com/x',
    'https://localhost/x', 'https://api.localhost/x', 'https://printer.local/x', 'https://db.internal/x', 'https://nas.lan/x',
    'https://127.0.0.1/x', 'https://10.1.2.3/x', 'https://172.16.0.1/x', 'https://172.31.255.255/x', 'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/x', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[fd00::1]/x',
    'https://[fe80::1]/x', 'https://[::ffff:10.0.0.1]/x', 'https://intranet/x', 'https://user:pass@example.com/x',
    `https://example.com/${'x'.repeat(2000)}`,
  ]) {
    assert.notEqual(webhookUrlProblem(bad), null, `"${bad.slice(0, 60)}" hoort geweigerd te worden`);
  }
});

test('privé-adressen, ook in IPv6 en verpakt in IPv6', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.0.1', '172.20.1.1', '192.168.0.1', '100.100.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1', 'fe80::abcd', 'ff02::1', '::ffff:192.168.1.1', '::ffff:a00:1', '::ffff:7f00:1',
    '::a9fe:a9fe', '64:ff9b::a00:1', '2001:db8::1', '999.1.1.1', '1::2::3', 'onzin']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.10', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888', '2a00:1450::1', '::ffff:808:808', '64:ff9b::808:808']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

// ── Opnieuw proberen ─────────────────────────────────────────────────────────

test('het herhaalschema loopt op en houdt op', () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_SECONDS.length + 1);
  const delays: number[] = [];
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    const delay = nextRetryDelay(attempt);
    if (delay !== null) delays.push(delay);
  }
  assert.deepEqual(delays, [...RETRY_DELAYS_SECONDS]);
  assert.equal(nextRetryDelay(MAX_DELIVERY_ATTEMPTS), null, 'na de laatste poging is het klaar');
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i] >= delays[i - 1], 'geen pauze is korter dan de vorige');
  const total = delays.reduce((a, b) => a + b, 0);
  assert.ok(total > 2.5 * 86400 && total < 3 * 86400, `bijna drie dagen, niet eeuwig (nu ${Math.round(total / 3600)} uur)`);
});

// ── Wat er in een bericht staat ──────────────────────────────────────────────

test('het bericht heeft een vaste vorm met een stabiel id', () => {
  const message = { id: 'evt-1', type: 'client.created', created_at: '2026-10-03T08:00:00Z', organization_id: 'org', data: { object: {} } };
  const body = JSON.parse(webhookBody(message));
  assert.deepEqual(Object.keys(body), ['id', 'type', 'created_at', 'organization_id', 'data']);
  assert.equal(body.id, 'evt-1');
});

test('geheimen en grote bestanden gaan nooit mee in een bericht', () => {
  // webhook_public_row draait in de database; hier bewaken we dat het patroon
  // de kolommen dekt die ResoFly nu kent — en de kolommen die er nog komen.
  const fn = migration.slice(migration.indexOf('function public.webhook_is_secret_column'), migration.indexOf('function public.webhook_is_noise_column'));
  const pattern = /p_column ~ '([^']+)'/g;
  const regexes = [...fn.matchAll(pattern)].map((m) => new RegExp(m[1]));
  const literal = [...fn.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const hidden = (column: string) => regexes.some((re) => re.test(column)) || literal.includes(column);
  for (const column of ['public_token_hash', 'public_token_expires_at', 'share_token', 'share_pin_hash', 'password_hash', 'verifier_hash',
    'client_secret', 'organizer_token', 'signed_pdf_data_base64', 'signed_storage_key', 'body_storage_key', 'resend_last_email_id', 'icalendar_raw']) {
    assert.ok(hidden(column), `${column} zou in een webhookbericht terechtkomen`);
  }
  for (const column of ['id', 'name', 'status', 'email', 'total_amount', 'is_pinned', 'pinned', 'spinner']) {
    assert.ok(!hidden(column), `${column} hoort gewoon mee te gaan`);
  }
});
