import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './src/index.ts';

/**
 * Bewaakt de voordeur van de connector.
 *
 * Twee dingen moeten hier kloppen. Ten eerste dat elk pad bij de JUISTE functie
 * uitkomt: één verkeerde regel en een AI-client vindt het metadata-document niet
 * meer, en dan mislukt het koppelen met een melding die nergens naar wijst.
 *
 * Ten tweede, en belangrijker, dat er GEEN pad bestaat dat ergens anders
 * uitkomt. Deze Worker staat open op internet en het project erachter heeft
 * functies voor facturen, bankkoppelingen en mail. Een proxy die het
 * binnenkomende pad achter een basis-URL plakt, is daar met één `..` naartoe te
 * praten. Vandaar dat hieronder niet alleen staat wat er wél doorgaat, maar ook
 * dat de rest niet eens een verzoek naar boven stuurt.
 */

const ENV = { SUPABASE_URL: 'https://project.supabase.co' };
const HOST = 'https://connector.staging.resofly.com';

/** Doet de Worker draaien met een nep-fetch, en geeft terug wat hij zou opvragen. */
async function call(path: string, init: RequestInit = {}) {
  const calls: Array<{ url: string; method: string; redirect: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, opts?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, opts);
    calls.push({ url: req.url, method: req.method, redirect: opts?.redirect });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request(`${HOST}${path}`, init), ENV);
    return { response, calls };
  } finally {
    globalThis.fetch = original;
  }
}

// ── Wat er wél doorgaat ──────────────────────────────────────────────────────

test('de root is de MCP-server zelf', async () => {
  const { calls } = await call('/', { method: 'POST', body: '{}' });
  assert.equal(calls[0].url, 'https://project.supabase.co/functions/v1/mcp');
  assert.equal(calls[0].method, 'POST');
});

test('de twee well-known-documenten gaan naar de juiste functie', async () => {
  // Deze staan op dezelfde root maar op verschillende paden — daarom kunnen
  // issuer en resource allebei de hostnaam zelf zijn.
  const resource = await call('/.well-known/oauth-protected-resource');
  assert.equal(resource.calls[0].url, 'https://project.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource');

  const server = await call('/.well-known/oauth-authorization-server');
  assert.equal(server.calls[0].url, 'https://project.supabase.co/functions/v1/mcp-oauth/.well-known/oauth-authorization-server');

  const openid = await call('/.well-known/openid-configuration');
  assert.equal(openid.calls[0].url, 'https://project.supabase.co/functions/v1/mcp-oauth/.well-known/openid-configuration');
});

test('elk eindpunt uit het metadata-document bestaat ook echt', async () => {
  // authorizationServerMetadata belooft deze vijf op de issuer. Belooft hij er
  // een die hier niet staat, dan loopt een client vast op een 404 van ons.
  for (const endpoint of ['authorize', 'token', 'register', 'revoke', 'jwks']) {
    const { calls, response } = await call(`/${endpoint}`);
    assert.equal(response.status, 200, `/${endpoint} hoort te bestaan`);
    assert.equal(calls[0].url, `https://project.supabase.co/functions/v1/mcp-oauth/${endpoint}`);
  }
});

test('de query reist mee', async () => {
  // Zonder ?request=… komt het toestemmingsscherm er niet achter wie er vraagt.
  const { calls } = await call('/authorize?client_id=abc&state=xyz');
  assert.equal(calls[0].url, 'https://project.supabase.co/functions/v1/mcp-oauth/authorize?client_id=abc&state=xyz');
});

test('een slash aan het eind maakt niet uit', async () => {
  const { calls } = await call('/token/');
  assert.equal(calls[0].url, 'https://project.supabase.co/functions/v1/mcp-oauth/token');
});

test('de redirect van /authorize wordt niet zelf gevolgd', async () => {
  // Volgt de Worker hem wel, dan haalt hij het toestemmingsscherm op en geeft
  // dat terug op de connector-hostnaam: de gebruiker staat dan op het verkeerde
  // adres, zonder sessie en zonder koppelverzoek.
  const { calls } = await call('/authorize');
  assert.equal(calls[0].redirect, 'manual');
});

// ── Wat er niet doorgaat ─────────────────────────────────────────────────────

test('geen enkel ander pad bereikt een andere edge function', async () => {
  const pogingen = [
    '/../billing',                    // de browser/URL-parser normaliseert dit
    '/%2e%2e/billing',                // en dit blijft juist staan
    '/functions/v1/billing',
    '/mcp-oauth/token',
    '/billing',
    '/bank-sync',
    '/.well-known/openid-configuration/../../billing',
    '/token/../../gerrie-agent',
  ];
  for (const poging of pogingen) {
    const { response, calls } = await call(poging);
    assert.equal(response.status, 404, `${poging} hoort een 404 te geven`);
    assert.equal(calls.length, 0, `${poging} hoort helemaal geen verzoek naar boven te sturen`);
  }
});

test('een onbekend pad antwoordt in JSON, niet met een lege 404', async () => {
  // Een AI-client die hier per ongeluk uitkomt, moet kunnen zien wat er mis is.
  const { response } = await call('/iets-dat-niet-bestaat');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const body = await response.json() as { error: string };
  assert.equal(body.error, 'not_found');
});
