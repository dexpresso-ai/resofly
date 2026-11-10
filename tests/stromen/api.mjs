// De openbare API (`api`) en de MCP-koppeling (`mcp-oauth`, `mcp`), van begin
// tot eind: een sleutel aanmaken zoals Instellingen → API & webhooks dat doet,
// ermee lezen, schrijven, klaarzetten en uitvoeren, en een eigen AI koppelen
// langs de echte OAuth-route. Daarnaast vooral wat er níet mag: een andere
// organisatie, een gesloten module, een ingetrokken of verlopen sleutel, een
// teamlid dat geen lid meer is, een gestolen of hergebruikte code.
//
// Waarom dit scenario er is: de unittests (publicApi*.test.ts, mcp*.test.ts)
// toetsen de bouwstenen, maar niet of de deur in zijn geheel dicht zit. Tot
// 10 november 2026 draaide geen enkele stromentest de functie `api` of
// `mcp-oauth`. Zie docs/rapporten/CONTROLE_API_LAAG_2026-11-10.md.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { API_URL, PUBLIEK } from './omgeving.mjs';
import { roep, roepRequest } from './functies.mjs';
import { rest, sql, sqlRij } from './supabase.mjs';
import { geweigerd, gelijk, gelukt, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

// WEBHOOK_SECRET_ENCRYPTION_KEY en MCP_STATE_SECRET staan in omgeving.mjs: de
// functies lezen ze bij het laden, en dat kan in een eerder scenario zijn.

const BASIS = `${API_URL}/functions/v1/api`;

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** Een aanroep van de openbare API, zoals een koppeling hem doet: geen Origin, wel een sleutel. */
async function api(pad, { sleutel, method = 'GET', body, headers = {}, ip } = {}) {
  const kop = { ...headers };
  if (sleutel) kop.authorization = `Bearer ${sleutel}`;
  if (ip) kop['x-forwarded-for'] = ip;
  const init = { method, headers: kop };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    kop['content-type'] ||= 'application/json';
  }
  const res = await roepRequest('api', new Request(`${BASIS}${pad}`, init));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst, headers: res.headers };
}

/** Een sleutel zoals het scherm hem aanmaakt (api-admin, createKey). */
async function maakSleutel(gebruiker, orgId, { naam = 'Stromen-koppeling', access = 'execute', moduleAccess, expiresInDays } = {}) {
  const res = await roep('api-admin', {
    token: gebruiker.token,
    body: { action: 'createKey', organizationId: orgId, name: naam, access, moduleAccess, expiresInDays },
  });
  return res;
}

/** Een aanroep van de MCP-server (JSON-RPC over HTTP). */
async function mcp(token, bericht) {
  const res = await roepRequest('mcp', new Request(`${API_URL}/functions/v1/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(bericht),
  }));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst, headers: res.headers };
}

/** De autorisatieserver: een pad onder mcp-oauth, met een formulier of JSON. */
async function oauth(pad, { method = 'GET', query = '', form, json: body, token, origin } = {}) {
  const headers = {};
  let inhoud;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; inhoud = new URLSearchParams(form).toString(); }
  if (body) { headers['content-type'] = 'application/json'; inhoud = JSON.stringify(body); }
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const res = await roepRequest('mcp-oauth', new Request(`${API_URL}/functions/v1/mcp-oauth/${pad}${query}`, {
    method, headers, body: inhoud, redirect: 'manual',
  }));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst, headers: res.headers };
}

/** Een inkomende mail zoals de email-worker hem aflevert: met het geheim en een handtekening over tijd en inhoud. */
async function inkomend(payload) {
  const geheim = process.env.MAIL_INBOUND_WEBHOOK_SECRET;
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const handtekening = createHmac('sha256', geheim).update(`${ts}.${raw}`).digest('hex');
  const res = await roepRequest('mail-inbound', new Request(`${API_URL}/functions/v1/mail-inbound`, {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-inbound-secret': geheim, 'x-inbound-timestamp': ts, 'x-inbound-signature': handtekening },
  }));
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst };
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export default async function apiScenario() {
  groep('Openbare API: sleutels en wie ze mag maken');
  const a = await stap('wereld A maken', () => maakWereld('api-a'));
  const b = await stap('wereld B maken (de buren)', () => maakWereld('api-b'));
  if (!a || !b) return;

  await stap('een teamlid, kijker of boekhouder maakt geen sleutel', async () => {
    for (const [wie, gebruiker] of [['lid', a.medewerker], ['kijker', a.kijker], ['boekhouder', a.boekhouder]]) {
      geweigerd(await maakSleutel(gebruiker, a.orgId), `${wie} maakt een sleutel`, [403]);
    }
  });
  await stap('een beheerder van B maakt geen sleutel voor A', async () => {
    geweigerd(await maakSleutel(b.beheerder, a.orgId), 'sleutel voor een andere organisatie', [403]);
  });
  await stap('zonder sessie geen sleutel', async () => {
    geweigerd(await roep('api-admin', { body: { action: 'createKey', organizationId: a.orgId, name: 'x' } }), 'anon', [401]);
  });

  const uitvoeren = await stap('de beheerder maakt een sleutel die mag uitvoeren', async () => {
    const res = await maakSleutel(a.beheerder, a.orgId, { naam: 'Webshop', access: 'execute' });
    const body = gelukt(res, 'sleutel aanmaken');
    verwacht(/^rsfapi\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body.secret), `sleutel heeft niet de vorm rsfapi.…: ${body.secret}`);
    // Het geheim staat nergens leesbaar: alleen de selector en een gezouten hash.
    const opslag = sqlRij(`select s.verifier_hash, s.salt from public.api_key_secrets s where s.api_key_id = ${q(body.key.id)}`);
    verwacht(opslag && !body.secret.includes(opslag.verifier_hash), 'het geheim staat leesbaar in de database');
    return { id: body.key.id, geheim: body.secret };
  });
  const lezen = await stap('en een sleutel die alleen mag lezen', async () => {
    const body = gelukt(await maakSleutel(a.beheerder, a.orgId, { naam: 'Rapportage', access: 'read' }), 'leessleutel');
    return { id: body.key.id, geheim: body.secret };
  });
  const klaarzetten = await stap('en een die alleen mag klaarzetten', async () => {
    const body = gelukt(await maakSleutel(a.beheerder, a.orgId, { naam: 'Voorstellen', access: 'propose' }), 'voorstelsleutel');
    return { id: body.key.id, geheim: body.secret };
  });
  const zonderKlanten = await stap('en een zonder de module Klanten', async () => {
    const body = gelukt(await maakSleutel(a.beheerder, a.orgId, { naam: 'Alleen uren', access: 'execute', moduleAccess: { clients: 'none' } }), 'beperkte sleutel');
    return { id: body.key.id, geheim: body.secret };
  });
  if (!uitvoeren || !lezen || !klaarzetten || !zonderKlanten) return;

  groep('Openbare API: aanmelden');
  await stap('het OpenAPI-document en de ingang zijn open, zonder gegevens', async () => {
    const doc = await api('/v1/openapi.json');
    gelijk(doc.status, 200, 'openapi.json');
    verwacht(doc.json?.openapi?.startsWith('3.'), 'geen OpenAPI 3-document');
    verwacht(doc.json?.paths?.['/v1/clients'], '/v1/clients ontbreekt in het document');
    verwacht(!doc.tekst.includes(a.orgId), 'het open document noemt een organisatie');
    gelijk((await api('/v1')).status, 200, 'GET /v1');
  });
  await stap('zonder sleutel, met een kapotte of geraden sleutel: 401', async () => {
    gelijk((await api('/v1/me')).status, 401, 'zonder sleutel');
    gelijk((await api('/v1/me', { sleutel: 'rsfapi.kapot' })).status, 401, 'kapotte vorm');
    const [, selector] = uitvoeren.geheim.split('.');
    const geraden = await api('/v1/me', { sleutel: `rsfapi.${selector}.${randomBytes(32).toString('base64url')}` });
    gelijk(geraden.status, 401, 'echte selector, verkeerde verifier');
    const onbekend = await api('/v1/me', { sleutel: `rsfapi.${randomBytes(16).toString('base64url')}.${randomBytes(32).toString('base64url')}` });
    gelijk(onbekend.status, 401, 'onbekende selector');
    // Eén zin voor allebei: het antwoord verraadt niet of een selector bestaat.
    gelijk(geraden.json?.error?.message, onbekend.json?.error?.message, 'foutmelding verschilt tussen bestaand en onbekend');
    // Een MCP-token is geen API-sleutel.
    gelijk((await api('/v1/me', { sleutel: `rsfmcp.${selector}.${randomBytes(32).toString('base64url')}` })).status, 401, 'MCP-vorm');
  });
  await stap('GET /v1/me: de organisatie uit de sleutel, met wat hij mag', async () => {
    const me = await api('/v1/me', { sleutel: uitvoeren.geheim });
    gelijk(me.status, 200, '/v1/me');
    gelijk(me.json.organization.id, a.orgId, 'organisatie');
    gelijk(me.json.key.access, 'execute', 'toegangsniveau');
    gelijk(me.json.acting_as.user_id, a.beheerder.id, 'namens wie');
    verwacht(me.headers.get('ratelimit-limit'), 'RateLimit-Limit ontbreekt');
    gelijk(me.headers.get('cache-control'), 'no-store', 'Cache-Control');
    gelijk((await api('/v1/me', { sleutel: zonderKlanten.geheim })).json.modules.clients, 'none', 'modulebeperking in /v1/me');
  });
  await stap('X-Api-Key werkt naast een vreemde Authorization (zoals een Supabase-client hem zet)', async () => {
    const res = await api('/v1/me', { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x', 'x-api-key': lezen.geheim } });
    gelijk(res.status, 200, 'X-Api-Key');
  });

  groep('Openbare API: lezen, alleen in de eigen organisatie');
  await stap('GET /v1/clients geeft de klanten van A en niet die van B', async () => {
    const res = await api('/v1/clients?limit=100', { sleutel: lezen.geheim });
    gelijk(res.status, 200, 'lijst');
    const ids = res.json.data.map((klant) => klant.id);
    verwacht(ids.includes(a.klantA.id) && ids.includes(a.klantB.id), 'klanten van A ontbreken');
    verwacht(!ids.includes(b.klantA.id) && !ids.includes(b.klantB.id), 'klant van B in de lijst van A');
  });
  await stap('een klant van B op id: 404, ook voor een sleutel van de owner', async () => {
    gelijk((await api(`/v1/clients/${b.klantA.id}`, { sleutel: uitvoeren.geheim })).status, 404, 'klant van B');
    gelijk((await api(`/v1/clients/${a.klantA.id}`, { sleutel: uitvoeren.geheim })).status, 200, 'klant van A');
  });
  await stap('zoeken via een handeling blijft binnen A', async () => {
    const res = await api('/v1/actions/search_clients', { sleutel: lezen.geheim, method: 'POST', body: { query: 'Klant' } });
    gelijk(res.status, 200, 'search_clients');
    const tekst = JSON.stringify(res.json);
    verwacht(tekst.includes(a.klantA.id), 'klant A van A niet gevonden');
    verwacht(!tekst.includes(b.klantA.id), 'klant van B gevonden via search_clients');
  });
  await stap('een filter met PostgREST-tekens is een zoekterm, geen filter', async () => {
    const res = await api(`/v1/clients?q=${encodeURIComponent('x,organization_id.neq.0')}`, { sleutel: lezen.geheim });
    verwacht(res.status === 200 || res.status === 400, `onverwachte status ${res.status}`);
    if (res.status === 200) gelijk(res.json.data.length, 0, 'q met filtertekens gaf rijen');
  });
  await stap('een sleutel zonder Klanten leest geen klanten, ook niet via een handeling', async () => {
    gelijk((await api('/v1/clients', { sleutel: zonderKlanten.geheim })).status, 403, 'REST');
    geweigerd(await api('/v1/actions/search_clients', { sleutel: zonderKlanten.geheim, method: 'POST', body: { query: 'Klant' } }), 'handeling', [403]);
    const lijst = await api('/v1/actions?module=clients', { sleutel: zonderKlanten.geheim });
    gelijk(lijst.json.total, 0, 'handelingen uit Klanten in de catalogus');
  });
  await stap('onbekende parameters en kapotte invoer: 400, geen 500', async () => {
    gelijk((await api('/v1/clients?bestaatniet=1', { sleutel: lezen.geheim })).status, 400, 'onbekende parameter');
    gelijk((await api('/v1/clients?limit=abc', { sleutel: lezen.geheim })).status, 400, 'limit=abc');
    gelijk((await api('/v1/actions/search_clients', { sleutel: lezen.geheim, method: 'POST', body: '{kapot' })).status, 400, 'kapotte JSON');
    gelijk((await api('/v1/actions/search_clients', { sleutel: lezen.geheim, method: 'POST', body: '[1,2]' })).status, 400, 'array als invoer');
    gelijk((await api('/v1/actions/bestaat.niet', { sleutel: lezen.geheim, method: 'POST', body: {} })).status, 404, 'onbekende handeling');
  });

  groep('Openbare API: schrijven');
  const nieuweKlant = await stap('POST /v1/clients maakt een klant in A, met Idempotency-Key', async () => {
    const sleutel = `stromen-${randomBytes(6).toString('hex')}`;
    const body = { name: 'Webshopklant BV', email: `webshop.${Date.now()}@klant.test`, city: 'Utrecht' };
    const eerste = await api('/v1/clients', { sleutel: uitvoeren.geheim, method: 'POST', body, headers: { 'idempotency-key': sleutel } });
    gelijk(eerste.status, 201, 'aanmaken');
    const rij = sqlRij(`select organization_id, created_by from public.clients where id = ${q(eerste.json.id)}`);
    gelijk(rij?.organization_id, a.orgId, 'organisatie van de nieuwe klant');
    gelijk(rij?.created_by, a.beheerder.id, 'gemaakt door');
    const herhaling = await api('/v1/clients', { sleutel: uitvoeren.geheim, method: 'POST', body, headers: { 'idempotency-key': sleutel } });
    gelijk(herhaling.status, 201, 'herhaling');
    gelijk(herhaling.json.id, eerste.json.id, 'herhaling maakte een tweede klant');
    gelijk(herhaling.headers.get('idempotent-replayed'), 'true', 'Idempotent-Replayed');
    const ander = await api('/v1/clients', { sleutel: uitvoeren.geheim, method: 'POST', body: { ...body, name: 'Anders' }, headers: { 'idempotency-key': sleutel } });
    gelijk(ander.status, 422, 'zelfde sleutel, andere inhoud');
    gelijk(Number(sql(`select count(*) from public.clients where organization_id = ${q(a.orgId)} and name = 'Webshopklant BV'`)), 1, 'aantal klanten');
    return eerste.json;
  });
  await stap('organization_id of een onbekend veld meesturen is een fout, geen verhuizing', async () => {
    const res = await api('/v1/clients', { sleutel: uitvoeren.geheim, method: 'POST', body: { name: 'Verhuisd', organization_id: b.orgId } });
    gelijk(res.status, 422, 'organization_id in de invoer');
    gelijk(Number(sql(`select count(*) from public.clients where name = 'Verhuisd'`)), 0, 'klant toch aangemaakt');
    if (nieuweKlant) {
      const patch = await api(`/v1/clients/${nieuweKlant.id}`, { sleutel: uitvoeren.geheim, method: 'PATCH', body: { organization_id: b.orgId } });
      gelijk(patch.status, 422, 'organization_id in een PATCH');
      gelijk(sqlRij(`select organization_id from public.clients where id = ${q(nieuweKlant.id)}`)?.organization_id, a.orgId, 'klant verhuisd');
    }
  });
  await stap('een klant van B wijzigen kan niet', async () => {
    const res = await api(`/v1/clients/${b.klantA.id}`, { sleutel: uitvoeren.geheim, method: 'PATCH', body: { city: 'Gehackt' } });
    gelijk(res.status, 404, 'PATCH op klant van B');
    verwacht(sqlRij(`select city from public.clients where id = ${q(b.klantA.id)}`)?.city !== 'Gehackt', 'klant van B gewijzigd');
  });
  await stap('een leessleutel en een voorstelsleutel schrijven niet rechtstreeks', async () => {
    gelijk((await api('/v1/clients', { sleutel: lezen.geheim, method: 'POST', body: { name: 'Niet' } })).status, 403, 'leessleutel');
    gelijk((await api('/v1/clients', { sleutel: klaarzetten.geheim, method: 'POST', body: { name: 'Niet' } })).status, 403, 'voorstelsleutel');
    gelijk((await api('/v1/actions/client.update_details', { sleutel: lezen.geheim, method: 'POST', body: { client_id: a.klantA.id, city: 'Niet' } })).status, 403, 'handeling met leessleutel');
  });
  const voorstel = await stap('een voorstelsleutel zet een wijziging klaar (202), en er verandert nog niets', async () => {
    const res = await api('/v1/actions/client.update_details', { sleutel: klaarzetten.geheim, method: 'POST', body: { client_id: a.klantA.id, city: 'Zwolle' } });
    gelijk(res.status, 202, 'klaarzetten');
    gelijk(res.json.status, 'queued', 'status');
    verwacht(sqlRij(`select city from public.clients where id = ${q(a.klantA.id)}`)?.city !== 'Zwolle', 'al uitgevoerd terwijl hij alleen klaar mocht zetten');
    const opvolgen = await api(`/v1/proposals/${res.json.proposal.id}`, { sleutel: klaarzetten.geheim });
    gelijk(opvolgen.json.status, 'pending', 'voorstel opvolgen');
    // Een voorstel van een andere sleutel bestaat voor deze sleutel niet.
    gelijk((await api(`/v1/proposals/${res.json.proposal.id}`, { sleutel: uitvoeren.geheim })).status, 404, 'voorstel van een andere sleutel');
    return res.json.proposal;
  });
  await stap('een uitvoersleutel voert een omkeerbare wijziging meteen uit, als het teamlid', async () => {
    const res = await api('/v1/actions/client.update_details', { sleutel: uitvoeren.geheim, method: 'POST', body: { client_id: a.klantA.id, city: 'Deventer' } });
    gelijk(res.status, 200, 'uitvoeren');
    gelijk(res.json.status, 'executed', 'status');
    gelijk(sqlRij(`select city from public.clients where id = ${q(a.klantA.id)}`)?.city, 'Deventer', 'stad niet bijgewerkt');
    const audit = sqlRij(`select status, api_key_id from public.ai_action_audit where id = ${q(res.json.audit_id)}`);
    gelijk(audit?.status, 'auto_executed', 'auditregel');
    gelijk(audit?.api_key_id, uitvoeren.id, 'auditregel zonder sleutel');
  });
  await stap('een handeling op een klant van B: nee, met een zin en zonder wijziging', async () => {
    const res = await api('/v1/actions/client.update_details', { sleutel: uitvoeren.geheim, method: 'POST', body: { client_id: b.klantA.id, city: 'Gehackt' } });
    geweigerd(res, 'klant van B via een handeling', [404, 422]);
    verwacht(sqlRij(`select city from public.clients where id = ${q(b.klantA.id)}`)?.city !== 'Gehackt', 'klant van B gewijzigd');
  });
  await stap('een webhook naar een intern adres wordt geweigerd', async () => {
    for (const url of ['http://example.com/hook', 'https://127.0.0.1/hook', 'https://10.0.0.8/hook', 'https://169.254.169.254/latest', 'https://[::1]/hook', 'https://localhost/hook']) {
      const res = await api('/v1/webhooks', { sleutel: lezen.geheim, method: 'POST', body: { url, events: ['client.*'] } });
      gelijk(res.status, 422, `webhook naar ${url}`);
    }
    gelijk(Number(sql(`select count(*) from public.webhook_endpoints where organization_id = ${q(a.orgId)}`)), 0, 'eindpunt toch aangemaakt');
  });
  await stap('een webhook voor een module die de sleutel niet mag lezen: 422', async () => {
    const res = await api('/v1/webhooks', { sleutel: zonderKlanten.geheim, method: 'POST', body: { url: 'https://203.0.113.10/hook', events: ['client.created'] } });
    gelijk(res.status, 422, 'gebeurtenis uit een gesloten module');
  });

  groep('Openbare API: als de sleutel of het teamlid verandert');
  await stap('een teamlid dat viewer wordt: zijn sleutel leest nog, maar schrijft niet meer', async () => {
    sql(`update public.organization_members set role = 'viewer' where organization_id = ${q(a.orgId)} and user_id = ${q(a.beheerder.id)}`);
    try {
      gelijk((await api('/v1/me', { sleutel: uitvoeren.geheim })).status, 200, 'lezen als viewer');
      gelijk((await api('/v1/clients', { sleutel: uitvoeren.geheim, method: 'POST', body: { name: 'Als viewer' } })).status, 403, 'schrijven als viewer');
    } finally {
      sql(`update public.organization_members set role = 'admin' where organization_id = ${q(a.orgId)} and user_id = ${q(a.beheerder.id)}`);
    }
  });
  await stap('een verlopen sleutel: 401, en de organisatie ziet de poging terug', async () => {
    sql(`update public.api_keys set expires_at = now() - interval '1 minute' where id = ${q(lezen.id)}`);
    const res = await api('/v1/me', { sleutel: lezen.geheim });
    gelijk(res.status, 401, 'verlopen sleutel');
    const log = sqlRij(`select status from public.api_request_log where api_key_id = ${q(lezen.id)} order by created_at desc limit 1`);
    gelijk(log?.status, 401, 'poging niet in het verzoeklog');
  });
  await stap('intrekken in de app: daarna 401, en de wachtrij van die sleutel vervalt', async () => {
    const res = await rest(`api_keys?id=eq.${klaarzetten.id}&revoked_at=is.null&select=id`, {
      method: 'PATCH', token: a.beheerder.token, prefer: 'return=representation', body: { revoked_at: new Date().toISOString() },
    });
    gelukt(res, 'intrekken');
    gelijk(res.json.length, 1, 'ingetrokken rijen');
    gelijk((await api('/v1/me', { sleutel: klaarzetten.geheim })).status, 401, 'ingetrokken sleutel');
    if (voorstel) {
      gelijk(sqlRij(`select status from public.ai_action_audit where id = ${q(voorstel.id)}`)?.status, 'cancelled', 'voorstel van een ingetrokken sleutel');
    }
    // Een ingetrokken sleutel gaat niet weer aan.
    const terug = await rest(`api_keys?id=eq.${klaarzetten.id}&select=id`, {
      method: 'PATCH', token: a.beheerder.token, prefer: 'return=representation', body: { revoked_at: null },
    });
    verwacht(terug.status >= 400 || (Array.isArray(terug.json) && terug.json.length === 0), `ingetrokken sleutel weer aangezet: ${terug.status} ${terug.tekst}`);
  });
  await stap('een sleutel ruimer maken kan niet vanuit de app', async () => {
    const res = await rest(`api_keys?id=eq.${zonderKlanten.id}&select=id`, {
      method: 'PATCH', token: a.beheerder.token, prefer: 'return=representation', body: { scope: 'read propose execute execute_high', module_access: {} },
    });
    verwacht(res.status >= 400 || (Array.isArray(res.json) && res.json.length === 0), `sleutel verruimd: ${res.status} ${res.tekst}`);
    gelijk((await api('/v1/me', { sleutel: zonderKlanten.geheim })).json.key.access, 'execute', 'toegangsniveau veranderd');
  });
  await stap('wie de organisatie verlaat, neemt zijn sleutels niet mee (ook niet als hij terugkomt)', async () => {
    sql(`update public.organization_members set status = 'disabled' where organization_id = ${q(a.orgId)} and user_id = ${q(a.beheerder.id)}`);
    try {
      gelijk((await api('/v1/me', { sleutel: uitvoeren.geheim })).status, 401, 'sleutel van een vertrokken teamlid');
      verwacht(sqlRij(`select revoked_at from public.api_keys where id = ${q(uitvoeren.id)}`)?.revoked_at, 'sleutel niet ingetrokken bij vertrek');
    } finally {
      sql(`update public.organization_members set status = 'active' where organization_id = ${q(a.orgId)} and user_id = ${q(a.beheerder.id)}`);
    }
    gelijk((await api('/v1/me', { sleutel: uitvoeren.geheim })).status, 401, 'sleutel werkt weer na terugkeer');
  });

  groep('Database en bestanden: wat de controle van 10 november dichtzette');
  await stap('een bijlage van een ticket delen kan niet, ook niet met schrijfrecht op Inhoud', async () => {
    const ticket = { id: sql(`insert into public.tickets (organization_id, title) values (${q(a.orgId)}, 'Intern ticket') returning id`) };
    const bijlage = { id: sql(`insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
      values (${q(a.orgId)}, 'ticket', ${q(ticket.id)}, 'geheim.pdf', 'application/pdf', 10, ${q(`${a.orgId}/ticket/${ticket.id}/geheim.pdf`)}) returning id`) };
    // Een lid zonder Tickets, wel met schrijfrecht op Inhoud.
    sql(`update public.organization_members set module_access = '{"tickets":"none"}'::jsonb where organization_id = ${q(a.orgId)} and user_id = ${q(a.medewerker.id)}`);
    try {
      const res = await roep('file-share', { token: a.medewerker.token, body: {
        action: 'share', organizationId: a.orgId, itemType: 'attachment', itemId: bijlage.id,
        recipients: [{ kind: 'link', email: 'mijzelf@buiten.test' }],
      } });
      geweigerd(res, 'bijlage van een ticket delen via file-share', [403]);
      // Ook rechtstreeks in de database (zoals PostgREST het toelaat met Inhoud).
      const direct = await rest('drive_shares?select=id', { method: 'POST', token: a.medewerker.token, prefer: 'return=representation', body: {
        organization_id: a.orgId, item_type: 'attachment', item_id: bijlage.id, recipient_kind: 'link',
        recipient_email: 'mijzelf@buiten.test', token_hash: 'a'.repeat(64), created_by: a.medewerker.id,
      } });
      verwacht(direct.status >= 400, `deling rechtstreeks aangemaakt: ${direct.status} ${direct.tekst}`);
      gelijk(Number(sql(`select count(*) from public.drive_shares where item_id = ${q(bijlage.id)}`)), 0, 'delingen van de ticketbijlage');
    } finally {
      sql(`update public.organization_members set module_access = null where organization_id = ${q(a.orgId)} and user_id = ${q(a.medewerker.id)}`);
    }
  });
  await stap('een document dat naar een factuur-PDF wijst, wist die PDF niet bij het opruimen', async () => {
    const sleutel = `${a.orgId}/invoice-pdfs/${randomBytes(8).toString('hex')}/factuur.pdf`;
    const doc = gelukt(await rest('documents?select=id', { method: 'POST', token: a.medewerker.token, prefer: 'return=representation', body: {
      organization_id: a.orgId, created_by: a.medewerker.id, title: 'Lokaas', storage_key: sleutel,
    } }), 'document met de sleutel van een factuur-PDF')[0];
    gelukt(await rest(`documents?id=eq.${doc.id}`, { method: 'DELETE', token: a.medewerker.token, prefer: 'return=representation' }), 'document verwijderen');
    gelijk(Number(sql(`select count(*) from public.storage_purge_queue where storage_key = ${q(sleutel)}`)), 0, 'factuur-PDF in de opruimwachtrij');
    // En een eigen Word-bestand gaat er wel in, zoals bedoeld.
    const eigen = `${a.orgId}/document/${randomBytes(8).toString('hex')}/brief.docx`;
    const brief = gelukt(await rest('documents?select=id', { method: 'POST', token: a.medewerker.token, prefer: 'return=representation', body: {
      organization_id: a.orgId, created_by: a.medewerker.id, title: 'Brief', storage_key: eigen,
    } }), 'eigen document')[0];
    gelukt(await rest(`documents?id=eq.${brief.id}`, { method: 'DELETE', token: a.medewerker.token, prefer: 'return=representation' }), 'eigen document verwijderen');
    gelijk(Number(sql(`select count(*) from public.storage_purge_queue where storage_key = ${q(eigen)}`)), 1, 'eigen bestand in de opruimwachtrij');
  });
  await stap('een losse journaalpost van een systeemsoort (desinvestering) boekt niemand rechtstreeks', async () => {
    const res = await rest('rpc/post_journal_entry', { method: 'POST', token: a.eigenaar.token, body: {
      p_organization_id: a.orgId, p_date: new Date().toISOString().slice(0, 10), p_description: 'Desinvestering?',
      p_source_type: 'asset_disposal', p_source_id: a.klantA.id,
      p_lines: [{ account_code: '4900', debit_cents: 1 }, { account_code: '4900', credit_cents: 1 }],
    } });
    verwacht(res.status >= 400 && /alleen de bijbehorende functie/.test(res.tekst), `systeemboeking rechtstreeks: ${res.status} ${res.tekst.slice(0, 200)}`);
  });
  await stap('wie geen lid is, leert niets over een andere organisatie', async () => {
    const tellen = await rest('rpc/organization_reserved_license_count', { method: 'POST', token: a.portaalA.token, body: { p_organization_id: a.orgId } });
    gelijk(tellen.json, 0, 'aantal leden van A voor een portaalgebruiker');
    const eigen = await rest('rpc/organization_reserved_license_count', { method: 'POST', token: a.eigenaar.token, body: { p_organization_id: a.orgId } });
    verwacht(Number(eigen.json) >= 6, `de eigenaar telt zijn eigen leden niet meer: ${eigen.tekst}`);
    gelijk((await rest('rpc/org_has_creative', { method: 'POST', token: b.eigenaar.token, body: { p_organization_id: a.orgId } })).json, false, 'creatieve module van A voor B');
  });
  await stap('het volgende klantnummer alleen met schrijfrecht op Klanten', async () => {
    geweigerd(await rest('rpc/preview_next_client_code', { method: 'POST', token: a.boekhouder.token, body: { p_organization_id: a.orgId } }), 'boekhouder');
    geweigerd(await rest('rpc/preview_next_client_code', { method: 'POST', token: a.kijker.token, body: { p_organization_id: a.orgId } }), 'kijker');
    gelukt(await rest('rpc/preview_next_client_code', { method: 'POST', token: a.medewerker.token, body: { p_organization_id: a.orgId } }), 'lid met Klanten');
  });

  await stap('een webhook van de organisatie gaat uit als zijn maker geen beheerder meer is', async () => {
    const eindpunt = sql(`insert into public.webhook_endpoints (organization_id, url, events, created_by)
      values (${q(a.orgId)}, 'https://203.0.113.20/hook', array['*'], ${q(a.beheerder.id)}) returning id`);
    sql(`update public.organization_members set role = 'member' where organization_id = ${q(a.orgId)} and user_id = ${q(a.beheerder.id)}`);
    try {
      const rij = sqlRij(`select active, disabled_reason from public.webhook_endpoints where id = ${q(eindpunt)}`);
      gelijk(rij?.active, false, 'eindpunt na degradatie van de maker');
      verwacht(/geen owner of admin meer/.test(rij?.disabled_reason ?? ''), `reden ontbreekt: ${rij?.disabled_reason}`);
    } finally {
      sql(`update public.organization_members set role = 'admin' where organization_id = ${q(a.orgId)} and user_id = ${q(a.beheerder.id)}`);
      sql(`delete from public.webhook_endpoints where id = ${q(eindpunt)}`);
    }
  });

  groep('Inkomende mail: een rem op een golf antwoorden');
  await stap('na de grens per gesprek wordt een antwoord geparkeerd, zonder melding aan het team', async () => {
    const thread = sql(`insert into public.client_email_threads (organization_id, client_id) values (${q(a.orgId)}, ${q(a.klantA.id)}) returning id`);
    const uit = sql(`insert into public.client_emails (organization_id, thread_id, client_id, direction, from_email, to_email, subject, status)
      values (${q(a.orgId)}, ${q(thread)}, ${q(a.klantA.id)}, 'outbound', 'team@api-a.test', ${q(a.klantA.email)}, 'Offerte', 'sent') returning id`);
    const run = randomBytes(4).toString('hex');
    const uitkomsten = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await inkomend({
        to: `reply+${uit}@inbound.test`, toHeader: `reply+${uit}@inbound.test`,
        envelopeFrom: a.klantA.email, headerFrom: a.klantA.email, headerFromName: 'Klant A',
        subject: `Re: Offerte ${i}`, text: `Bedankt, verder niets nodig (${i}).`,
        messageId: `<golf-${run}-${i}@klant.test>`, rawHash: `golf-${run}-${i}`, receivedAt: new Date().toISOString(),
      });
      gelijk(res.status, 200, `inkomende mail ${i + 1}`);
      uitkomsten.push(res.json?.outcome === 'parked' ? `parked:${res.json?.reason}` : res.json?.outcome);
    }
    // MAIL_INBOUND_THREAD_LIMIT_PER_HOUR staat in omgeving.mjs op 5.
    gelijk(uitkomsten, ['linked', 'linked', 'linked', 'linked', 'linked', 'parked:rate_limited', 'parked:rate_limited'], 'uitkomsten');
    gelijk(Number(sql(`select count(*) from public.client_emails where thread_id is not null and organization_id = ${q(a.orgId)} and direction = 'inbound' and subject like 'Re: Offerte %'`)), 5, 'gekoppelde berichten');
  });
  await stap('zonder geldig geheim of met een vervalste handtekening: 401', async () => {
    const body = JSON.stringify({ to: 'x@inbound.test' });
    const kaal = await roepRequest('mail-inbound', new Request(`${API_URL}/functions/v1/mail-inbound`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
    gelijk(kaal.status, 401, 'zonder geheim');
    const ts = String(Math.floor(Date.now() / 1000));
    const vervalst = await roepRequest('mail-inbound', new Request(`${API_URL}/functions/v1/mail-inbound`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-inbound-secret': process.env.MAIL_INBOUND_WEBHOOK_SECRET, 'x-inbound-timestamp': ts, 'x-inbound-signature': 'f'.repeat(64) },
    }));
    gelijk(vervalst.status, 401, 'vervalste handtekening');
  });

  groep('MCP-koppeling: de OAuth-route');
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const client = await stap('een AI-client registreert zich', async () => {
    const res = await oauth('register', { method: 'POST', json: { client_name: 'Stromen-AI', redirect_uris: [redirect] } });
    gelijk(res.status, 201, 'registreren');
    return res.json;
  });
  await stap('registreren heeft een rem per afzender (429 met Retry-After)', async () => {
    // Een eigen adres per run: de teller staat in de database en loopt een uur.
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}, 10.0.0.1`;
    const registreer = () => roepRequest('mcp-oauth', new Request(`${API_URL}/functions/v1/mcp-oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ client_name: 'Lus', redirect_uris: ['https://lus.test/cb'] }),
    }));
    // De grens (MCP_REGISTER_LIMIT_PER_HOUR, standaard 60) mag hier al deels
    // op zijn als het scenario binnen het uur opnieuw draait; daarom tot de
    // eerste weigering, en hooguit één keer meer dan de grens.
    let geweigerd = null;
    for (let i = 0; i <= 61 && !geweigerd; i += 1) {
      const res = await registreer();
      if (res.status === 429) geweigerd = res;
      else gelijk(res.status, 201, `registratie ${i + 1}`);
    }
    verwacht(geweigerd, 'geen 429 na 61 registraties vanaf één adres');
    verwacht(Number(geweigerd.headers.get('retry-after')) > 0, 'Retry-After ontbreekt');
    sql(`delete from public.mcp_clients where client_name = 'Lus' and redirect_uris = array['https://lus.test/cb']`);
  });
  await stap('registreren met een onveilige of kapotte redirect kan niet', async () => {
    for (const uri of ['http://evil.test/cb', 'javascript:alert(1)', 'https://evil.test/cb#frag', '']) {
      geweigerd(await oauth('register', { method: 'POST', json: { client_name: 'x', redirect_uris: [uri] } }), `redirect ${uri}`, [400]);
    }
    geweigerd(await oauth('register', { method: 'POST', json: { client_name: 'x', redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_basic' } }), 'met client secret', [400]);
  });
  if (!client) return;
  const p = pkce();
  const verzoek = await stap('authorize stuurt door naar het toestemmingsscherm, en niet naar een vreemd adres', async () => {
    const vreemd = await oauth('authorize', { query: `?${new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://evil.test/cb', response_type: 'code', code_challenge: p.challenge, code_challenge_method: 'S256' })}` });
    gelijk(vreemd.status, 400, 'onbekende redirect');
    verwacht(!vreemd.headers.get('location'), 'doorgestuurd naar een onbekende redirect');
    const zonderPkce = await oauth('authorize', { query: `?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code' })}` });
    verwacht(!String(zonderPkce.headers.get('location') || '').startsWith(PUBLIEK), 'doorgestuurd zonder PKCE');
    const res = await oauth('authorize', { query: `?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: p.challenge, code_challenge_method: 'S256', state: 'st-1', scope: 'read propose' })}` });
    gelijk(res.status, 302, 'authorize');
    const naar = new URL(res.headers.get('location'));
    gelijk(`${naar.origin}${naar.pathname}`, `${PUBLIEK}/mcp/authorize`, 'toestemmingsscherm');
    return naar.searchParams.get('request');
  });
  if (!verzoek) return;
  await stap('het toestemmingsscherm ziet wie het vraagt', async () => {
    const res = await oauth('consent', { query: `?request=${encodeURIComponent(verzoek)}` });
    gelijk(res.status, 200, 'consent');
    gelijk(res.json.client_name, 'Stromen-AI', 'naam');
    gelijk(res.json.verified, true, 'claude.ai is een bekende bestemming');
    const kapot = await oauth('consent', { query: `?request=${encodeURIComponent(`${verzoek.split('.')[0]}.AAAA`)}` });
    gelijk(kapot.status, 400, 'vervalst verzoek');
  });
  await stap('akkoord geven kan alleen een lid van de gekozen organisatie, met een sessie', async () => {
    geweigerd(await oauth('approve', { method: 'POST', origin: PUBLIEK, json: { request: verzoek, organizationId: a.orgId } }), 'zonder sessie', [401]);
    geweigerd(await oauth('approve', { method: 'POST', origin: PUBLIEK, token: b.medewerker.token, json: { request: verzoek, organizationId: a.orgId } }), 'lid van B voor A', [403]);
    geweigerd(await oauth('approve', { method: 'POST', origin: 'https://evil.test', token: a.medewerker.token, json: { request: verzoek, organizationId: a.orgId } }), 'vreemde origin', [403]);
    geweigerd(await oauth('approve', { method: 'POST', origin: PUBLIEK, token: a.boekhouder.token, json: { request: verzoek, organizationId: a.orgId } }), 'boekhouder (geen Gerrie)', [403]);
  });
  const code = await stap('de medewerker geeft akkoord; execute is daar niet te kiezen', async () => {
    const res = await oauth('approve', { method: 'POST', origin: PUBLIEK, token: a.medewerker.token, json: { request: verzoek, organizationId: a.orgId, scope: 'read propose execute execute_high' } });
    gelijk(res.status, 200, 'akkoord');
    const terug = new URL(res.json.redirect);
    gelijk(`${terug.origin}${terug.pathname}`, redirect, 'terug naar de client');
    gelijk(terug.searchParams.get('state'), 'st-1', 'state');
    const grant = sqlRij(`select scope from public.mcp_grants where client_id = ${q(client.client_id)} and user_id = ${q(a.medewerker.id)} and revoked_at is null`);
    gelijk(grant?.scope, 'read propose', 'scope van de koppeling');
    return terug.searchParams.get('code');
  });
  if (!code) return;
  const tokens = await stap('de code inruilen kan alleen met de juiste PKCE en client', async () => {
    const fout = await oauth('token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: client.client_id, redirect_uri: redirect } });
    gelijk(fout.json?.error, 'invalid_grant', 'verkeerde code_verifier');
    const res = await oauth('token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: client.client_id, redirect_uri: redirect } });
    gelijk(res.status, 200, 'token');
    verwacht(/^rsfmcp\./.test(res.json.access_token) && /^rsfmcp\./.test(res.json.refresh_token), 'tokens hebben niet de vorm rsfmcp.…');
    return res.json;
  });
  if (!tokens) return;
  await stap('dezelfde code nog eens: geweigerd, en de koppeling gaat op slot', async () => {
    const res = await oauth('token', { method: 'POST', form: { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: client.client_id } });
    gelijk(res.json?.error, 'invalid_grant', 'hergebruikte code');
    gelijk((await mcp(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401, 'token na hergebruikte code');
  });

  // Een tweede, schone koppeling voor de rest van het scenario.
  const p2 = pkce();
  const koppeling = await stap('opnieuw koppelen en tokens halen', async () => {
    const auth = await oauth('authorize', { query: `?${new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', code_challenge: p2.challenge, code_challenge_method: 'S256', state: 'st-2' })}` });
    const request = new URL(auth.headers.get('location')).searchParams.get('request');
    const akkoord = await oauth('approve', { method: 'POST', origin: PUBLIEK, token: a.medewerker.token, json: { request, organizationId: a.orgId, scope: 'read propose' } });
    const nieuweCode = new URL(akkoord.json.redirect).searchParams.get('code');
    const res = await oauth('token', { method: 'POST', form: { grant_type: 'authorization_code', code: nieuweCode, code_verifier: p2.verifier, client_id: client.client_id } });
    gelijk(res.status, 200, 'token');
    return res.json;
  });
  if (!koppeling) return;
  await stap('MCP: zonder token 401 met de weg naar de autorisatieserver', async () => {
    const res = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    gelijk(res.status, 401, 'zonder token');
    verwacht(/resource_metadata=/.test(res.headers.get('www-authenticate') || ''), 'WWW-Authenticate zonder resource_metadata');
  });
  await stap('MCP: initialize, tools/list en lezen binnen A', async () => {
    const init = await mcp(koppeling.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stromen', version: '1' } } });
    gelijk(init.status, 200, 'initialize');
    const tools = await mcp(koppeling.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const namen = (tools.json?.result?.tools ?? []).map((tool) => tool.name);
    verwacht(namen.includes('run_action') && namen.includes('propose_action'), `tools: ${namen.join(', ')}`);
    verwacht(!namen.includes('execute_action'), 'execute_action zichtbaar zonder execute-scope');
    const lees = await mcp(koppeling.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_action', arguments: { action_id: 'search_clients', input: { query: 'Klant' } } } });
    const tekst = JSON.stringify(lees.json);
    verwacht(tekst.includes(a.klantA.id), 'klant van A niet gevonden via MCP');
    verwacht(!tekst.includes(b.klantA.id), 'klant van B gevonden via MCP');
  });
  await stap('MCP: uitvoeren zonder execute-scope wordt hooguit een voorstel', async () => {
    const res = await mcp(koppeling.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'execute_action', arguments: { action_id: 'client.update_details', input: { client_id: a.klantB.id, city: 'Via-MCP' } } } });
    verwacht(sqlRij(`select city from public.clients where id = ${q(a.klantB.id)}`)?.city !== 'Via-MCP', `uitgevoerd zonder execute-scope: ${res.tekst.slice(0, 200)}`);
  });
  await stap('MCP: refresh roteert, en een oud refresh token werkt niet meer', async () => {
    const vers = await oauth('token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: koppeling.refresh_token, client_id: client.client_id } });
    gelijk(vers.status, 200, 'verversen');
    const opnieuw = await oauth('token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: koppeling.refresh_token, client_id: client.client_id } });
    gelijk(opnieuw.json?.error, 'invalid_grant', 'oud refresh token');
    const andereClient = await oauth('token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: vers.json.refresh_token, client_id: 'mcp_iemand_anders' } });
    gelijk(andereClient.json?.error, 'invalid_grant', 'refresh door een andere client');
    koppeling.access_token = vers.json.access_token;
    koppeling.refresh_token = vers.json.refresh_token;
  });
  await stap('MCP: wie Gerrie kwijtraakt, kan niet meer verder via de koppeling', async () => {
    sql(`update public.organization_members set module_access = '{"gerrie":"none"}'::jsonb where organization_id = ${q(a.orgId)} and user_id = ${q(a.medewerker.id)}`);
    try {
      gelijk((await mcp(koppeling.access_token, { jsonrpc: '2.0', id: 5, method: 'ping' })).status, 401, 'zonder Gerrie');
    } finally {
      sql(`update public.organization_members set module_access = null where organization_id = ${q(a.orgId)} and user_id = ${q(a.medewerker.id)}`);
    }
    gelijk((await mcp(koppeling.access_token, { jsonrpc: '2.0', id: 6, method: 'ping' })).status, 200, 'weer met Gerrie');
  });
  await stap('MCP: inleveren trekt de hele koppeling in', async () => {
    const res = await oauth('revoke', { method: 'POST', form: { token: koppeling.refresh_token } });
    gelijk(res.status, 200, 'revoke');
    gelijk((await mcp(koppeling.access_token, { jsonrpc: '2.0', id: 7, method: 'ping' })).status, 401, 'access token na inleveren');
  });
}
