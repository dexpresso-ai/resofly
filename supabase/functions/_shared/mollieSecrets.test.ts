import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * De eigen Mollie-key van een organisatie: versleutelen, controleren bij Mollie
 * en wat er naar buiten gaat. Gevonden op 6 november 2026:
 *  - op staging ontbrak MOLLIE_TOKEN_ENCRYPTION_KEY: koppelen liep stuk, en de
 *    key die er stond was met de ingebouwde sleutel uit de code versleuteld;
 *  - een key met een regeleinde kwam via de foutmelding van fetch in de logs;
 *  - het scherm zei bij een geweigerde key alleen "non-2xx status code".
 */

const env = new Map<string, string>();
(globalThis as unknown as { Deno: unknown }).Deno = { env: { get: (name: string) => env.get(name) } };

const { decryptSecret, decryptSecretWithInfo, encryptSecret, encryptionKeyConfigured, readMollieProfile, validateMollieApiKey } =
  await import('./mollieSecrets.ts');

const ECHTE_SLEUTEL = 'een-lange-willekeurige-sleutel-voor-de-test-0123456789';
const KEY = 'live_abcdefghijklmnopqrstuvwxyz0123';
const TEST_KEY = 'test_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';

function zetOmgeving(waarden: Record<string, string | undefined>) {
  env.clear();
  for (const [naam, waarde] of Object.entries(waarden)) if (waarde !== undefined) env.set(naam, waarde);
}

/** Een versleutelde waarde zoals de oude terugval hem maakte (de ingebouwde sleutel). */
async function oudeOpslag(plain: string): Promise<string> {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: 'dev-only-token-key' });
  return await encryptSecret(plain);
}

// ── Versleutelen ────────────────────────────────────────────────────────────

test('zonder MOLLIE_TOKEN_ENCRYPTION_KEY wordt er niets opgeslagen, ook niet met MOLLIE_ALLOW_MOCK (staging)', async () => {
  zetOmgeving({ MOLLIE_ALLOW_MOCK: 'true' });
  assert.equal(encryptionKeyConfigured(), false);
  await assert.rejects(() => encryptSecret(KEY), /MOLLIE_TOKEN_ENCRYPTION_KEY ontbreekt/);
});

test('versleutelen en ontsleutelen met de echte sleutel; de key staat niet leesbaar in de opslag', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL });
  assert.equal(encryptionKeyConfigured(), true);
  const opslag = await encryptSecret(KEY);
  assert.match(opslag, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!opslag.includes(KEY.slice(5)), 'de key staat leesbaar in de opslag');
  assert.notEqual(await encryptSecret(KEY), opslag, 'elke keer een nieuwe iv');
  assert.deepEqual(await decryptSecretWithInfo(opslag), { plain: KEY, legacyKey: false });
  assert.equal(await decryptSecret(opslag), KEY);
});

test('een andere sleutel ontsleutelt niet', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL });
  const opslag = await encryptSecret(KEY);
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: 'een-heel-andere-sleutel-van-minstens-32-tekens' });
  await assert.rejects(() => decryptSecret(opslag));
});

test('oude opslag (ingebouwde sleutel): op staging leesbaar en gemarkeerd om opnieuw te versleutelen', async () => {
  const oud = await oudeOpslag(KEY);
  // Staging nu: echte sleutel gezet, MOLLIE_ALLOW_MOCK aan voor de abonnementen.
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL, MOLLIE_ALLOW_MOCK: 'true' });
  assert.deepEqual(await decryptSecretWithInfo(oud), { plain: KEY, legacyKey: true });
  // Staging vóór 6 november: geen echte sleutel, wel MOLLIE_ALLOW_MOCK.
  zetOmgeving({ MOLLIE_ALLOW_MOCK: 'true' });
  assert.deepEqual(await decryptSecretWithInfo(oud), { plain: KEY, legacyKey: true });
});

test('oude opslag zonder MOLLIE_ALLOW_MOCK (productie): de ingebouwde sleutel telt niet', async () => {
  const oud = await oudeOpslag(KEY);
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL });
  await assert.rejects(() => decryptSecretWithInfo(oud));
  zetOmgeving({});
  await assert.rejects(() => decryptSecretWithInfo(oud), /MOLLIE_TOKEN_ENCRYPTION_KEY ontbreekt/);
});

test('een opslag in een onbekende vorm wordt geweigerd', async () => {
  zetOmgeving({ MOLLIE_TOKEN_ENCRYPTION_KEY: ECHTE_SLEUTEL });
  await assert.rejects(() => decryptSecret('v2.abc.def'), /ongeldig formaat/);
  await assert.rejects(() => decryptSecret('live_abc'), /ongeldig formaat/);
});

// ── De key controleren bij Mollie ───────────────────────────────────────────

type Aanroep = { url: string; authorization: string | null };

function nepMollie(antwoorden: Record<string, () => Response | Promise<Response>>) {
  const aanroepen: Aanroep[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    aanroepen.push({ url, authorization: headers.get('authorization') });
    const antwoord = antwoorden[new URL(url).pathname];
    if (!antwoord) throw new Error(`onverwachte aanroep ${url}`);
    return await antwoord();
  }) as typeof fetch;
  return { fetchImpl, aanroepen };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROFIEL = { resource: 'profile', id: 'pfl_QkEhN94Ba', mode: 'live', name: 'Bakkerij Jansen', website: 'https://bakkerijjansen.nl', status: 'verified' };

test('een key die niet met test_ of live_ begint: geweigerd zonder Mollie te bellen', async () => {
  const { fetchImpl, aanroepen } = nepMollie({});
  // Een key van een andere dienst, een profiel-id, een organisatietoken, niets.
  for (const key of ['sk_geen_mollie_sleutel', 'pfl_QkEhN94Ba', 'access_abcdefghijklmnopqrstuvwxyz', '']) {
    const uit = await validateMollieApiKey(key, fetchImpl);
    assert.equal(uit.valid, false, key);
    if (!uit.valid) assert.match(uit.error, /begint met test_ of live_/);
  }
  assert.equal(aanroepen.length, 0);
});

test('een key met een regeleinde of vreemde tekens: geweigerd zonder Mollie te bellen, en de key staat niet in de melding', async () => {
  const { fetchImpl, aanroepen } = nepMollie({});
  for (const key of [`${KEY}\nvolgende regel`, `live_abcdef\r\nghijklmnopqrstuvwxyz`, `${KEY}\u0000`, 'live_abc def ghi jkl mno pqr', 'live_kort', `live_${'a'.repeat(129)}`]) {
    const uit = await validateMollieApiKey(key, fetchImpl);
    assert.equal(uit.valid, false, JSON.stringify(key));
    if (!uit.valid) {
      assert.match(uit.error, /alleen letters en cijfers/);
      assert.ok(!uit.error.includes('abcdef'), 'de key staat in de melding');
    }
  }
  assert.equal(aanroepen.length, 0);
});

test('een goede key: Mollie zegt bij welk profiel hij hoort', async () => {
  const { fetchImpl, aanroepen } = nepMollie({ '/v2/profiles/me': () => json(200, PROFIEL) });
  const uit = await validateMollieApiKey(KEY, fetchImpl);
  assert.deepEqual(uit, { valid: true, mode: 'live', profile: { id: 'pfl_QkEhN94Ba', name: 'Bakkerij Jansen', website: 'https://bakkerijjansen.nl', status: 'verified' } });
  assert.deepEqual(aanroepen, [{ url: 'https://api.mollie.com/v2/profiles/me', authorization: `Bearer ${KEY}` }]);
  const test_ = await validateMollieApiKey(TEST_KEY, nepMollie({ '/v2/profiles/me': () => json(200, PROFIEL) }).fetchImpl);
  assert.equal(test_.valid && test_.mode, 'test');
});

test('een key die Mollie weigert (401 of 403): ongeldig', async () => {
  for (const status of [401, 403]) {
    const { fetchImpl, aanroepen } = nepMollie({ '/v2/profiles/me': () => json(status, { status, title: 'Unauthorized Request' }) });
    const uit = await validateMollieApiKey(KEY, fetchImpl);
    assert.equal(uit.valid, false);
    if (!uit.valid) assert.match(uit.error, /Mollie weigerde deze API-key/);
    assert.equal(aanroepen.length, 1, 'na een weigering niet nog eens proberen');
  }
});

test('geeft /profiles/me iets anders, dan telt de oude controle (/methods); koppelen loopt daar niet op stuk', async () => {
  const goed = nepMollie({ '/v2/profiles/me': () => json(404, { status: 404 }), '/v2/methods': () => json(200, { count: 1 }) });
  assert.deepEqual(await validateMollieApiKey(KEY, goed.fetchImpl), { valid: true, mode: 'live', profile: null });
  assert.deepEqual(goed.aanroepen.map((a) => a.url), ['https://api.mollie.com/v2/profiles/me', 'https://api.mollie.com/v2/methods']);

  const geweigerd = nepMollie({ '/v2/profiles/me': () => json(500, {}), '/v2/methods': () => json(401, {}) });
  const uit = await validateMollieApiKey(KEY, geweigerd.fetchImpl);
  assert.equal(uit.valid, false);
  if (!uit.valid) assert.match(uit.error, /weigerde/);

  const storing = nepMollie({ '/v2/profiles/me': () => json(503, {}), '/v2/methods': () => json(503, {}) });
  const uitStoring = await validateMollieApiKey(KEY, storing.fetchImpl);
  assert.equal(uitStoring.valid, false);
  if (!uitStoring.valid) assert.match(uitStoring.error, /onverwacht antwoord \(503\)/);
});

test('Mollie onbereikbaar: een gewone zin, zonder de melding van fetch (daar kan de key in staan)', async () => {
  const fetchImpl = (async () => { throw new TypeError(`Invalid header value: "Bearer ${KEY}"`); }) as typeof fetch;
  const uit = await validateMollieApiKey(KEY, fetchImpl);
  assert.equal(uit.valid, false);
  if (!uit.valid) {
    assert.match(uit.error, /niet bereikbaar/);
    assert.ok(!uit.error.includes(KEY), 'de key staat in de melding');
  }
});

test('het profiel: alleen een echt profiel-id, ingekort en zonder stuurtekens', () => {
  assert.equal(readMollieProfile(null), null);
  assert.equal(readMollieProfile({ id: 'org_123', name: 'x' }), null);
  assert.equal(readMollieProfile({ id: 'pfl_<script>', name: 'x' }), null);
  assert.deepEqual(readMollieProfile({ id: 'pfl_abc', name: `  Naam\nmet regel\u0007 `, website: 'x'.repeat(500) }),
    { id: 'pfl_abc', name: 'Naam met regel', website: 'x'.repeat(200), status: null });
  assert.deepEqual(readMollieProfile({ id: 'pfl_abc', name: 12, website: '', status: 'blocked' }), { id: 'pfl_abc', name: null, website: null, status: 'blocked' });
});

// ── Wat er naar buiten gaat (de code zelf) ──────────────────────────────────

const workflow = readFileSync(new URL('../invoice-workflow/index.ts', import.meta.url), 'utf8');
const repository = readFileSync(new URL('../../../src/lib/repository.ts', import.meta.url), 'utf8');

function functieBody(bron: string, naam: string): string {
  const start = bron.indexOf(`async function ${naam}(`);
  assert.ok(start >= 0, `${naam} niet gevonden`);
  const einde = bron.indexOf('\n}\n', start);
  return bron.slice(start, einde);
}

test('koppelen: eerst de rol en de versleutelsleutel, dan pas Mollie; daarna een regel in het auditlog', () => {
  const opslaan = functieBody(workflow, 'saveInvoiceMollieKey');
  const rol = opslaan.indexOf("['owner', 'admin'].includes(role)");
  const sleutel = opslaan.indexOf('encryptionKeyConfigured()');
  const mollie = opslaan.indexOf('validateMollieApiKey(');
  const versleutel = opslaan.indexOf('encryptSecret(');
  const log = opslaan.indexOf('logMollieAudit(');
  assert.ok(rol >= 0 && rol < sleutel && sleutel < mollie && mollie < versleutel && versleutel < log, 'volgorde: rol, sleutel, Mollie, versleutelen, auditlog');
  assert.match(functieBody(workflow, 'deleteInvoiceMollieKey'), /logMollieAudit\(\{[\s\S]*action: 'revoked'/);
  assert.match(functieBody(workflow, 'logMollieAudit'), /entity_type: 'mollie_connection'/);
});

test('de versleutelde key gaat nooit mee naar de browser of het auditlog', () => {
  const kolommen = workflow.match(/const MOLLIE_SETTINGS_COLUMNS = '([^']+)'/);
  assert.ok(kolommen, 'MOLLIE_SETTINGS_COLUMNS niet gevonden');
  assert.ok(!kolommen[1].includes('api_key_encrypted'), 'api_key_encrypted in de kolommen voor de status');
  for (const naam of ['logMollieAudit', 'getInvoiceMollieStatus']) {
    assert.doesNotMatch(functieBody(workflow, naam), /api_key_encrypted|apiKey/, `${naam} raakt de key`);
  }
  // Alleen invoiceMollieKey.ts ontsleutelt de key van een organisatie.
  assert.doesNotMatch(workflow, /decryptSecret/);
});

test('het scherm krijgt de echte reden bij een weigering, niet "non-2xx status code"', () => {
  for (const naam of ['loadInvoiceMollieStatus', 'saveInvoiceMollieKey', 'deleteInvoiceMollieKey']) {
    const body = functieBody(repository, naam);
    assert.match(body, /if \(error\) await throwFunctionError\(error, /, `${naam} gooit de kale functiefout`);
  }
});
