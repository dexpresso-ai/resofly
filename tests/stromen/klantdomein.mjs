// Het webadres voor klanten (migratie 20261108230000, plan
// docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md), end-to-end tegen de echte
// database (PostgREST met RLS, GoTrue) en de echte edge functions.
//
// Waarom een eigen scenario: een klantadres raakt alles wat een klant opent.
// Een link die naar het verkeerde adres gaat, of een adres dat de factuur van
// een ander toont, is erger dan geen eigen adres. Hier gaat het om:
//   1. het webadres kiezen: vrij, bestaat al, gereserveerd, van wie, wijzigen
//      (de oude naam stuurt door), terugnemen, de rem op wisselen;
//   2. een eigen domein via een nagebootste Cloudflare for SaaS (Custom
//      Hostnames-API) en DNS: koppelen, nalopen tot actief, haperen,
//      ontkoppelen, overnemen na zeven dagen; wie mag wat, alleen betalend;
//   3. de opzoeking van de Worker: alleen met het geheim, alleen openbare gegevens;
//   4. links in mails: met CLIENT_DOMAINS_LIVE op het klantadres;
//   5. de publieke functies vanaf een klantadres: CORS, en een token van een
//      andere organisatie op dat adres bestaat niet;
//   6. inloggen op het portaal met de eigen inlogmail: link met het geheim van
//      de browser, de code, verlopen, hergebruik, en GoTrue zelf;
//   7. de inlog per gebruiker (migratie 20261109020000): vastleggen bij de
//      aanvraag, het bereik (één organisatie of alles), een wachtwoord geeft
//      niets, en een inlog hoort bij de nieuwste aanvraag;
//   8. het portaal op het eigen domein: aan- en uitzetten, wie mag, links,
//      de Worker, inloggen daar met een code van ResoFly en een sleutel (nooit
//      een inlog bij Supabase), en wat die sleutel wel en niet ziet;
//   9. de nachtelijke ronde (cron) met zijn geheim;
//  10. een adres dat ResoFly uitzette.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { API_URL, ANON_KEY, CLIENT_DOMAINS_CRON_GEHEIM, CLIENT_DOMAINS_WERKER_GEHEIM, CLOUDFLARE_TOKEN, CLOUDFLARE_ZONE, ORIGIN, PUBLIEK, SERVICE_KEY } from './omgeving.mjs';
import { roep } from './functies.mjs';
import { mailsAan, post, registreerDienst } from './nepdiensten.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, nietsVeranderd, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS, webadresNaam } from './wereld.mjs';
import { clearClientOriginCache } from '../../supabase/functions/_shared/clientLinks.ts';

const BASE = 'resofly.com';
const CNAME_DOEL = `domeinen.${BASE}`;
// De database wordt tussen rondes niet leeggemaakt: elke ronde eigen hostnamen,
// en eigen afzenders (de remmen van portal-login tellen per IP-adres).
const RONDE = Date.now().toString(36);
const IP_BLOK = 1 + Math.floor(Math.random() * 250);
const ip = (n) => `198.51.${IP_BLOK}.${n}`;

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** jsonb zet de sleutels in zijn eigen volgorde; vergelijk zonder op de volgorde te letten. */
function geordend(waarde) {
  if (Array.isArray(waarde)) return waarde.map(geordend);
  if (waarde && typeof waarde === 'object') return Object.fromEntries(Object.keys(waarde).sort().map((k) => [k, geordend(waarde[k])]));
  return waarde;
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null || waarde === '') throw new Error(`${wat} ontbreekt`);
  return waarde;
}

// ── Nagebootste Cloudflare (Custom Hostnames) en DNS ─────────────────────────

const cf = {
  /** id → custom hostname zoals de API hem teruggeeft. */
  hostnames: new Map(),
  verzoeken: [],
};

function cfJson(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function nepCloudflare(request, url) {
  cf.verzoeken.push({ methode: request.method, pad: url.pathname, zoek: url.search });
  if (request.headers.get('authorization') !== `Bearer ${CLOUDFLARE_TOKEN}`) {
    return cfJson(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null });
  }
  const m = url.pathname.match(/^\/client\/v4\/zones\/([^/]+)\/custom_hostnames(?:\/([^/]+))?$/);
  if (!m || decodeURIComponent(m[1]) !== CLOUDFLARE_ZONE) {
    return cfJson(404, { success: false, errors: [{ code: 7003, message: 'Could not route to this zone' }], result: null });
  }
  const id = m[2] ? decodeURIComponent(m[2]) : null;
  if (!id && request.method === 'POST') {
    const body = await request.json();
    const hostname = String(body.hostname ?? '').toLowerCase();
    if ([...cf.hostnames.values()].some((h) => h.hostname === hostname)) {
      return cfJson(409, { success: false, errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }], result: null });
    }
    const nieuw = {
      id: randomUUID(), hostname, status: 'pending',
      ssl: { status: 'pending_validation', method: body.ssl?.method, type: body.ssl?.type, settings: body.ssl?.settings },
      ownership_verification: { type: 'txt', name: `_cf-custom-hostname.${hostname}`, value: randomUUID() },
      verification_errors: [], created_at: new Date().toISOString(),
    };
    cf.hostnames.set(nieuw.id, nieuw);
    return cfJson(200, { success: true, errors: [], result: structuredClone(nieuw) });
  }
  if (!id && request.method === 'GET') {
    const naam = url.searchParams.get('hostname');
    const lijst = [...cf.hostnames.values()].filter((h) => !naam || h.hostname === naam);
    return cfJson(200, { success: true, errors: [], result: structuredClone(lijst) });
  }
  const host = id ? cf.hostnames.get(id) : null;
  if (!host) return cfJson(404, { success: false, errors: [{ code: 1436, message: 'The custom hostname was not found.' }], result: null });
  if (request.method === 'GET') return cfJson(200, { success: true, errors: [], result: structuredClone(host) });
  if (request.method === 'DELETE') {
    cf.hostnames.delete(id);
    return cfJson(200, { success: true, errors: [], result: { id } });
  }
  return cfJson(405, { success: false, errors: [{ code: 10405, message: 'Method not allowed' }], result: null });
}

/** Waar een hostnaam volgens de DNS naartoe wijst (CNAME), en de TXT-records. */
const dns = new Map();
const txt = new Map();

function nepDns(_request, url) {
  const naam = String(url.searchParams.get('name') ?? '').toLowerCase();
  const soort = String(url.searchParams.get('type') ?? 'A').toUpperCase();
  const antwoorden = soort === 'TXT'
    ? (txt.get(naam) ?? []).map((waarde) => ({ name: `${naam}.`, type: 16, TTL: 300, data: `"${waarde}"` }))
    : soort === 'CNAME'
      ? (dns.get(naam) ?? []).map((doel) => ({ name: `${naam}.`, type: 5, TTL: 300, data: `${doel}.` }))
      : [];
  return new Response(JSON.stringify({ Status: antwoorden.length ? 0 : 3, Answer: antwoorden }), { status: 200, headers: { 'content-type': 'application/dns-json' } });
}

/** Zet het TXT-record van een koppeling, zoals de klant dat bij zijn domeinbeheerder doet. */
function zetTxt(hostname) {
  const host = [...cf.hostnames.values()].find((h) => h.hostname === hostname);
  if (!host) throw new Error(`nep-Cloudflare kent ${hostname} niet`);
  txt.set(host.ownership_verification.name, [host.ownership_verification.value]);
  return host.ownership_verification;
}

/** Zet de stand van een hostnaam bij Cloudflare, zoals Cloudflare dat na een controle doet. */
function zetCf(hostname, { status, ssl, fout } = {}) {
  const host = [...cf.hostnames.values()].find((h) => h.hostname === hostname);
  if (!host) throw new Error(`nep-Cloudflare kent ${hostname} niet`);
  if (status) host.status = status;
  if (ssl) host.ssl.status = ssl;
  host.verification_errors = fout ? [fout] : [];
  return host;
}

// ── Hulpjes ─────────────────────────────────────────────────────────────────

function domeinen(gebruiker, orgId, action, extra = {}, opties = {}) {
  return roep('client-domains', { token: gebruiker?.token, body: { action, organizationId: orgId, ...extra }, ...opties });
}

function opzoeken(host, { geheim = CLIENT_DOMAINS_WERKER_GEHEIM, method = 'POST' } = {}) {
  return roep('client-domains', {
    method, origin: null, headers: { 'x-client-domains-secret': geheim },
    ...(method === 'POST' ? { body: { host } } : {}),
  });
}

function nalopen(geheim = CLIENT_DOMAINS_CRON_GEHEIM) {
  return roep('client-domains', { query: 'cron=recheck', origin: null, headers: geheim === null ? {} : { 'x-cron-secret': geheim }, body: {} });
}

function check(gebruiker, naam, orgId = null) {
  return rpc('client_subdomain_check', { p_name: naam, p_organization_id: orgId }, gebruiker?.token);
}

function claim(gebruiker, orgId, naam) {
  return rpc('client_subdomain_claim', { p_organization_id: orgId, p_name: naam }, gebruiker?.token);
}

function namen(orgId) {
  return sqlRijen(`select name, status, redirect_until from public.client_subdomains where organization_id = ${q(orgId)} order by created_at`);
}

function actieveNaam(orgId) {
  return sqlRij(`select name from public.client_subdomains where organization_id = ${q(orgId)} and status = 'active'`)?.name ?? null;
}

function domeinRij(hostname) {
  return sqlRij(`select * from public.client_domains where hostname = ${q(hostname)} and status <> 'removed' order by created_at desc limit 1`);
}

/** De logboekregels van een soort: de handeling, of bij een eigen domein de gebeurtenis. */
function auditActies(orgId, soort) {
  return sqlRijen(`select coalesce(metadata->>'event', action) as wat from public.audit_logs where organization_id = ${q(orgId)} and entity_type = ${q(soort)} order by created_at`).map((r) => r.wat);
}

/** Over ongeveer twaalf maanden (tussen 11,9 en 12,1). */
function overEenJaar(iso) {
  const maanden = (Date.parse(iso) - Date.now()) / (30.44 * 86_400_000);
  return maanden > 11.8 && maanden < 12.2;
}

const verifier = () => randomBytes(32).toString('base64url');
const sha256 = (tekst) => createHash('sha256').update(tekst).digest('hex');

function aanvraagUitMail(mail) {
  const m = `${mail?.text ?? ''} ${mail?.html ?? ''}`.match(/aanvraag=([A-Za-z0-9_-]{30,100})/);
  return m ? m[1] : null;
}

function codeUitMail(mail) {
  const m = String(mail?.text ?? '').match(/Vul deze code in op het inlogscherm(?: van [a-z0-9.-]+)?: (\d{6,10})/);
  return m ? m[1] : null;
}

/** Een verse inlog vastleggen, zoals de app na het inwisselen (portal-login, bindSession). */
function vastleggen(token, { origin, ip: adres, request = null, verifiers = [] }) {
  return roep('portal-login', { origin, ip: adres, token, body: { action: 'bindSession', ...(request ? { request } : {}), verifiers } });
}

/** Kent GoTrue deze sessie nog? (Na een mislukt vastleggen maakt de server hem ongeldig.) */
async function sessieLeeft(token) {
  const res = await fetch(`${API_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` } });
  return res.status === 200;
}

/**
 * Een sessie met een wachtwoord: zoals iemand die met een uitgelekt token een
 * wachtwoord instelde en daarmee inlogde.
 */
async function wachtwoordSessie(userId, email) {
  const wachtwoord = `Uitgelekt-${randomUUID()}!9`;
  const zet = await fetch(`${API_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT', headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password: wachtwoord }),
  });
  if (!zet.ok) throw new Error(`wachtwoord zetten: ${zet.status} ${await zet.text()}`);
  const login = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: wachtwoord }),
  });
  const json = await login.json();
  if (!login.ok) throw new Error(`inloggen met wachtwoord: ${JSON.stringify(json)}`);
  return json.access_token;
}

/** Een klant met een eigen adres (de rem op inlogmails telt per adres). */
async function nieuweKlant(w, label, email = `${label}.${RONDE}.${randomBytes(3).toString('hex')}@klant.test`) {
  const res = await rest('clients?select=id,name,email', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, name: `Klant ${label} ${RONDE}`, email: email.toLowerCase(), contact_name: `Contact ${label}`,
      address_line1: 'Dorpsstraat 2', postal_code: '1234 AB', city: 'Utrecht', country: 'Nederland',
      client_kind: 'business', vat_number: 'NL009876543B01',
    },
  });
  if (res.status !== 201) throw new Error(`klant ${label}: ${res.status} ${res.tekst}`);
  return res.json[0];
}

/** Inloggen zoals de app: aanvragen, de link inwisselen, bij GoTrue inloggen en vastleggen. */
async function inloggenMetLink(email, { origin, ipAanvraag, ipInwisselen }) {
  const browser = verifier();
  const voor = mailsAan(email).length;
  gelukt(await roep('portal-login', { origin, ip: ipAanvraag, body: { action: 'requestLogin', email, verifierHash: sha256(browser) } }), 'aanvragen');
  const mail = mailsAan(email).slice(voor)[0];
  const aanvraag = nodig(aanvraagUitMail(mail), 'aanvraagnummer in de mail');
  const uit = gelukt(await roep('portal-login', { origin, ip: ipInwisselen, body: { action: 'redeemLogin', request: aanvraag, verifiers: [browser] } }), 'inwisselen');
  const login = await gotrueVerify({ type: 'magiclink', token_hash: nodig(uit.tokenHash, 'inlogtoken') });
  gelijk(login.status, 200, `GoTrue: ${login.tekst.slice(0, 200)}`);
  const token = nodig(login.json?.access_token, 'sessie');
  gelukt(await vastleggen(token, { origin, ip: ipInwisselen, request: aanvraag, verifiers: [browser] }), 'vastleggen');
  return { token, mail, aanvraag, userId: login.json?.user?.id };
}

/** Wat een inlog in het portaal ziet: de id's van de klantdossiers. */
async function dossiers(token, origin) {
  const uit = gelukt(await roep('client-portal', { origin, token, body: { action: 'getPortalData' } }), 'portaal');
  return (uit.accounts ?? []).map((account) => account?.id).filter(Boolean).sort();
}

/** Het portaal met de sleutel van een eigen domein (kop x-portal-token, geen inlog bij Supabase). */
function metSleutel(sleutel, origin, body) {
  return roep('client-portal', { origin, headers: { 'x-portal-token': sleutel }, body });
}

async function dossiersMetSleutel(sleutel, origin) {
  const uit = gelukt(await metSleutel(sleutel, origin, { action: 'getPortalData' }), 'portaal met sleutel');
  return (uit.accounts ?? []).map((account) => account?.id).filter(Boolean).sort();
}

/** Inloggen op een eigen domein zoals de app: aanvragen en de link inwisselen. Dat geeft een sleutel, geen inlog bij Supabase. */
async function inloggenOpDomein(email, { origin, ipAanvraag, ipInwisselen }) {
  const browser = verifier();
  const voor = mailsAan(email).length;
  gelukt(await roep('portal-login', { origin, ip: ipAanvraag, body: { action: 'requestLogin', email, verifierHash: sha256(browser) } }), 'aanvragen');
  const mail = mailsAan(email).slice(voor)[0];
  const aanvraag = nodig(aanvraagUitMail(mail), 'aanvraagnummer in de mail');
  const uit = gelukt(await roep('portal-login', { origin, ip: ipInwisselen, body: { action: 'redeemLogin', request: aanvraag, verifiers: [browser] } }), 'inwisselen');
  verwacht(!uit.tokenHash, 'een token van Supabase op een eigen domein');
  return { sleutel: nodig(uit.portalToken, 'sleutel'), mail, aanvraag, code: codeUitMail(mail) };
}

/** Een account bij een klantadres: zoals na een inlogaanvraag (die maakt het account aan). */
async function accountVoor(email, origin, adres) {
  gelukt(await roep('portal-login', { origin, ip: adres, body: { action: 'requestLogin', email, verifierHash: sha256(verifier()) } }), 'aanvragen');
  return sqlRij(`select id from auth.users where email = ${q(email)}`)?.id ?? null;
}

/** Zoals supabase.auth.verifyOtp in de browser. */
async function gotrueVerify(body) {
  const res = await fetch(`${API_URL}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const tekst = await res.text();
  let json = null;
  try { json = JSON.parse(tekst); } catch { /* geen json */ }
  return { status: res.status, json, tekst };
}

/** Een factuur opslaan en versturen zoals de app (facturen.mjs). */
async function verstuurFactuur(w) {
  const jaar = new Date().toISOString().slice(0, 4);
  const nummer = `FAC-${jaar}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const res = gelukt(await rest('invoices?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, project_id: null, number: nummer,
      date: new Date().toISOString().slice(0, 10), due_date: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
      status: 'draft', notes: null, lines: REGELS.map((regel) => ({ id: randomUUID(), ...regel })),
    },
  }), 'concept opslaan');
  const factuur = res[0];
  const voor = mailsAan(w.klantA.email).length;
  gelukt(await roep('invoice-workflow', {
    token: w.medewerker.token,
    body: { action: 'sendInvoiceEmail', organizationId: w.orgId, invoiceId: factuur.id, recipientEmail: w.klantA.email, recipientName: `Contact ${w.klantA.name}`, includePaymentLink: false },
  }), 'versturen');
  const mails = mailsAan(w.klantA.email).slice(voor);
  verwacht(mails.length === 1, `verwacht één factuurmail, kreeg ${mails.length}`);
  const tekst = `${mails[0].html ?? ''} ${mails[0].text ?? ''}`;
  const link = tekst.match(/https?:\/\/[^\s"'<>]+\/invoice\/([A-Za-z0-9_-]{20,})/);
  verwacht(link, `geen factuurlink in de mail: ${tekst.slice(0, 300)}`);
  return { factuur, link: link[0], token: link[1] };
}

// ── Het scenario ────────────────────────────────────────────────────────────

export default async function klantdomein() {
  registreerDienst('https://api.cloudflare.com', nepCloudflare);
  registreerDienst('https://cloudflare-dns.com', nepDns);
  const vroegerLive = process.env.CLIENT_DOMAINS_LIVE;
  delete process.env.CLIENT_DOMAINS_LIVE;
  clearClientOriginCache();

  groep('Klantdomein: de werelden');
  const w = await stap('een organisatie met een webadres (zoals na de stap Je webadres)', () => maakWereld('klantdomein'));
  const w2 = await stap('en een tweede organisatie', () => maakWereld('klantdomein-b'));
  if (!w || !w2) return;
  const vreemde = w2.eigenaar;
  const adresA = () => `${actieveNaam(w.orgId)}.${BASE}`;
  const herkomstA = () => `https://${adresA()}`;
  const herkomstB = () => `https://${actieveNaam(w2.orgId)}.${BASE}`;

  try {
    // ── 1. Het webadres ─────────────────────────────────────────────────────
    groep('Klantdomein: het webadres kiezen');

    await stap('het overzicht: het adres, nog niet live, links nog naar het algemene adres', async () => {
      const uit = gelukt(await domeinen(w.medewerker, w.orgId, 'overview'), 'overzicht');
      gelijk(uit.config.base, BASE, 'basisdomein');
      gelijk(uit.config.live, false, 'live');
      gelijk(uit.config.cnameTarget, CNAME_DOEL, 'CNAME-doel');
      gelijk(uit.subdomain, { name: w.subdomein, host: `${w.subdomein}.${BASE}` }, 'webadres');
      gelijk(uit.clientUrl, PUBLIEK, 'links');
      gelijk(uit.onClientHost, false, 'klantadres');
      gelijk(uit.customDomainAllowed, false, 'eigen domein zonder abonnement');
    });

    await stap('iemand van buiten krijgt het overzicht niet', async () => {
      geweigerd(await domeinen(vreemde, w.orgId, 'overview'), 'vreemde', [403, 404]);
      geweigerd(await domeinen(null, w.orgId, 'overview'), 'zonder sessie', [401]);
    });

    await stap('de controle: eigen naam, van een ander, vrij', async () => {
      gelijk(gelukt(await check(w.eigenaar, w.subdomein, w.orgId), 'eigen').status, 'own', 'eigen naam');
      gelijk(gelukt(await check(w.eigenaar, w2.subdomein, w.orgId), 'ander').status, 'taken', 'naam van een ander');
      gelijk(gelukt(await check(w.eigenaar, webadresNaam('vrij'), w.orgId), 'vrij').status, 'available', 'vrije naam');
    });

    await stap('de controle verklapt niet van wie een naam is', async () => {
      const uit = gelukt(await check(w.eigenaar, w2.subdomein, w2.orgId), 'naam van een ander, met diens organisatie');
      gelijk(uit.status, 'taken', 'status');
      verwacht(!JSON.stringify(uit).includes(w2.orgId), 'het antwoord noemt de organisatie');
      gelijk(Object.keys(uit).sort(), ['message', 'name', 'status'], 'velden');
    });

    await stap('gereserveerd en verkeerd gevormd', async () => {
      for (const naam of ['www', 'portaal', 'staging', 'rabobank-hulp', 'mijn-resofly', 'digid']) {
        gelijk(gelukt(await check(w.eigenaar, naam), naam).status, 'reserved', naam);
      }
      const kort = gelukt(await check(w.eigenaar, 'ab'), 'kort');
      gelijk([kort.status, kort.reason], ['invalid', 'te_kort'], 'te kort');
      verwacht(/minstens 3/.test(kort.message), `melding: ${kort.message}`);
      for (const [naam, reden] of [['jan--sen', 'streepje'], ['-jansen', 'streepje'], ['jan_sen', 'tekens'], ['12345', 'alleen_cijfers'], ['x'.repeat(41), 'te_lang'], ['xn--80ak6aa92e', 'streepje']]) {
        const uit = gelukt(await check(w.eigenaar, naam), naam);
        gelijk([uit.status, uit.reason], ['invalid', reden], naam);
      }
      gelijk(gelukt(await check(w.eigenaar, '  JanSen  '), 'hoofdletters').name, 'jansen', 'de controle maakt er kleine letters van');
    });

    await stap('zonder sessie geen controle', async () => {
      geweigerd(await check(null, 'jansen'), 'anon');
    });

    for (const [wie, gebruiker] of [['een teamlid', 'medewerker'], ['een kijker', 'kijker'], ['de boekhouder', 'boekhouder']]) {
      await stap(`${wie} kan het webadres niet kiezen`, async () => {
        geweigerd(await claim(w[gebruiker], w.orgId, webadresNaam('poging')), wie);
        gelijk(actieveNaam(w.orgId), w.subdomein, 'webadres');
      });
    }

    await stap('iemand van buiten kan het webadres niet kiezen, en anon niet', async () => {
      geweigerd(await claim(vreemde, w.orgId, webadresNaam('kaping')), 'vreemde');
      geweigerd(await claim(null, w.orgId, webadresNaam('kaping')), 'anon');
      gelijk(actieveNaam(w.orgId), w.subdomein, 'webadres');
    });

    await stap('de naam van een ander kun je niet nemen', async () => {
      const res = geweigerd(await claim(w.eigenaar, w.orgId, w2.subdomein), 'naam van een ander', [409]);
      verwacht(/bestaat al/.test(JSON.stringify(res)), `melding: ${JSON.stringify(res)}`);
      gelijk(actieveNaam(w2.orgId), w2.subdomein, 'de ander houdt zijn naam');
    });

    await stap('een gereserveerde of verkeerde naam wordt geweigerd', async () => {
      geweigerd(await claim(w.eigenaar, w.orgId, 'www'), 'www');
      geweigerd(await claim(w.eigenaar, w.orgId, 'Jan Sen'), 'spatie');
      geweigerd(await claim(w.eigenaar, w.orgId, 'xn--80ak6aa92e'), 'punycode');
      gelijk(actieveNaam(w.orgId), w.subdomein, 'webadres');
    });

    await stap('rechtstreeks schrijven in client_subdomains kan niet', async () => {
      nietsVeranderd(await rest('client_subdomains', {
        method: 'POST', token: w.eigenaar.token, prefer: 'return=representation',
        body: { organization_id: w.orgId, name: webadresNaam('direct'), status: 'active' },
      }), 'invoegen');
      nietsVeranderd(await rest(`client_subdomains?organization_id=eq.${w2.orgId}`, {
        method: 'PATCH', token: w.eigenaar.token, prefer: 'return=representation', body: { organization_id: w.orgId },
      }), 'een naam van een ander overnemen');
      nietsVeranderd(await rest(`client_subdomains?organization_id=eq.${w.orgId}`, {
        method: 'DELETE', token: w.eigenaar.token, prefer: 'return=representation',
      }), 'verwijderen');
      gelijk(actieveNaam(w.orgId), w.subdomein, 'webadres');
      gelijk(actieveNaam(w2.orgId), w2.subdomein, 'webadres van de ander');
    });

    await stap('lezen: het team ziet het eigen webadres, de boekhouder en buitenstaanders niet', async () => {
      const team = gelukt(await rest(`client_subdomains?select=name,status&organization_id=eq.${w.orgId}`, { token: w.medewerker.token }), 'teamlid');
      gelijk(team, [{ name: w.subdomein, status: 'active' }], 'teamlid');
      gelijk(gelukt(await rest(`client_subdomains?select=name&organization_id=eq.${w.orgId}`, { token: w.boekhouder.token }), 'boekhouder'), [], 'boekhouder');
      gelijk(gelukt(await rest(`client_subdomains?select=name&organization_id=eq.${w.orgId}`, { token: vreemde.token }), 'vreemde'), [], 'vreemde');
    });

    const nieuweNaam = webadresNaam('klantdomein-nieuw');
    await stap('de beheerder wijzigt het webadres; de oude naam stuurt twaalf maanden door', async () => {
      const uit = gelukt(await claim(w.beheerder, w.orgId, nieuweNaam), 'wijzigen');
      gelijk(geordend(uit), geordend({ name: nieuweNaam, previous: w.subdomein, changed: true }), 'antwoord');
      const oud = namen(w.orgId).find((r) => r.name === w.subdomein);
      gelijk(oud?.status, 'redirect', 'de oude naam');
      verwacht(overEenJaar(oud.redirect_until), `doorsturen tot ${oud.redirect_until}`);
      gelijk(actieveNaam(w.orgId), nieuweNaam, 'nieuwe naam');
    });

    await stap('de oude naam: van ons (terug te nemen), voor een ander bezet', async () => {
      gelijk(gelukt(await check(w.eigenaar, w.subdomein, w.orgId), 'eigen oude naam').status, 'own_previous', 'eigen oude naam');
      gelijk(gelukt(await check(vreemde, w.subdomein, w2.orgId), 'voor een ander').status, 'taken', 'voor een ander');
      geweigerd(await claim(vreemde, w2.orgId, w.subdomein), 'een ander neemt de oude naam', [409]);
    });

    await stap('terugnemen kan; nog eens dezelfde naam verandert niets', async () => {
      gelijk(geordend(gelukt(await claim(w.eigenaar, w.orgId, w.subdomein), 'terugnemen')), geordend({ name: w.subdomein, previous: nieuweNaam, changed: true }), 'terugnemen');
      gelijk(geordend(gelukt(await claim(w.eigenaar, w.orgId, w.subdomein), 'nog eens')), geordend({ name: w.subdomein, previous: null, changed: false }), 'nog eens');
      gelijk(actieveNaam(w.orgId), w.subdomein, 'webadres');
      gelijk(namen(w.orgId).find((r) => r.name === nieuweNaam)?.status, 'redirect', 'de tussenliggende naam stuurt door');
    });

    await stap('het logboek: alleen eigenaar en beheerder lezen de regels over het webadres', async () => {
      verwacht(auditActies(w.orgId, 'client_subdomain').length >= 3, `regels: ${auditActies(w.orgId, 'client_subdomain')}`);
      const eigenaar = gelukt(await rest(`audit_logs?select=action&organization_id=eq.${w.orgId}&entity_type=eq.client_subdomain`, { token: w.eigenaar.token }), 'eigenaar');
      verwacht(eigenaar.length >= 3, `eigenaar ziet ${eigenaar.length} regels`);
      gelijk(gelukt(await rest(`audit_logs?select=action&organization_id=eq.${w.orgId}&entity_type=eq.client_subdomain`, { token: w.medewerker.token }), 'teamlid'), [], 'teamlid');
    });

    const wisselNamen = [1, 2, 3, 4, 5].map((i) => webadresNaam(`wissel-${i}`));
    await stap('steeds wisselen wordt afgeremd: hooguit vijf oude namen per jaar', async () => {
      // De tweede organisatie: die van de eerste blijft voor de links hieronder staan.
      for (const naam of wisselNamen) gelukt(await claim(w2.eigenaar, w2.orgId, naam), naam);
      const res = geweigerd(await claim(w2.eigenaar, w2.orgId, webadresNaam('wissel-6')), 'de zesde', [400]);
      verwacht(/vaak gewijzigd/.test(JSON.stringify(res)), `melding: ${JSON.stringify(res)}`);
      // Een eigen oude naam terugnemen blijft kunnen.
      gelukt(await claim(w2.eigenaar, w2.orgId, w2.subdomein), 'de eerste naam terugnemen');
      gelijk(actieveNaam(w2.orgId), w2.subdomein, 'webadres');
    });

    // ── 2. Een eigen domein ─────────────────────────────────────────────────
    groep('Klantdomein: een eigen domein');
    const domein = `portaal.kd-${RONDE}.nl`;

    await stap('zonder betaald abonnement geen eigen domein, en Cloudflare hoort niets', async () => {
      const res = geweigerd(await domeinen(w.eigenaar, w.orgId, 'addDomain', { hostname: domein }), 'zonder abonnement', [403]);
      verwacht(/betaald abonnement/.test(JSON.stringify(res)), `melding: ${JSON.stringify(res)}`);
      gelijk(cf.verzoeken.length, 0, 'aanroepen bij Cloudflare');
    });

    // Betalend: een lopend Mollie-abonnement; de tweede organisatie is vrijgesteld.
    // create_organization maakt geen billingprofiel; de billingkoppeling doet
    // dat bij het eerste abonnement. Hier dezelfde rij, met genoeg licenties.
    const profiel = (orgId, velden) => sql(`insert into public.organization_billing_profiles
        (organization_id, plan_key, included_seats, purchased_seats, licensed_seats, subscription_status, mollie_subscription_id, billing_exempt)
      values (${q(orgId)}, 'starter', 1, 49, 50, 'active', ${velden.abonnement ? q(velden.abonnement) : 'null'}, ${velden.vrijgesteld ? 'true' : 'false'})
      on conflict (organization_id) do update set subscription_status = 'active',
        mollie_subscription_id = excluded.mollie_subscription_id, billing_exempt = excluded.billing_exempt`);
    profiel(w.orgId, { abonnement: 'sub_stromen_klantdomein' });
    profiel(w2.orgId, { vrijgesteld: true });

    await stap('met abonnement mag het; het overzicht zegt het ook', async () => {
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht').customDomainAllowed, true, 'met abonnement');
      gelijk(gelukt(await domeinen(w2.eigenaar, w2.orgId, 'overview'), 'overzicht').customDomainAllowed, true, 'vrijgesteld');
    });

    for (const [wie, gebruiker] of [['een teamlid', w.medewerker], ['een kijker', w.kijker], ['de boekhouder', w.boekhouder], ['iemand van buiten', vreemde]]) {
      await stap(`${wie} kan geen domein koppelen`, async () => {
        geweigerd(await domeinen(gebruiker, w.orgId, 'addDomain', { hostname: domein }), wie, [403, 404]);
        gelijk(cf.verzoeken.length, 0, 'aanroepen bij Cloudflare');
      });
    }

    await stap('hoofddomeinen, IP-adressen, testdomeinen en adressen van ResoFly worden geweigerd', async () => {
      for (const [invoer, patroon] of [
        [`kd-${RONDE}.nl`, /subdomein/],
        ['192.168.1.20', /IP-adres/],
        ['portaal.klantdomein.test', /bestaat niet op internet/],
        [`klanten.${w.subdomein}.${BASE}`, /ResoFly/],
        [CNAME_DOEL, /ResoFly/],
        ['', /Vul een domein in/],
      ]) {
        const res = geweigerd(await domeinen(w.eigenaar, w.orgId, 'addDomain', { hostname: invoer }), invoer || '(leeg)', [422]);
        verwacht(patroon.test(JSON.stringify(res)), `${invoer}: ${JSON.stringify(res)}`);
      }
      gelijk(cf.verzoeken.length, 0, 'aanroepen bij Cloudflare');
    });

    let domeinId = null;
    await stap('koppelen: Cloudflare krijgt de hostnaam, het scherm het record en wat er nog mist', async () => {
      const uit = gelukt(await domeinen(w.beheerder, w.orgId, 'addDomain', { hostname: ` https://Portaal.KD-${RONDE.toUpperCase()}.nl/inloggen ` }), 'koppelen');
      domeinId = uit.domain.id;
      gelijk(uit.domain.hostname, domein, 'hostnaam');
      gelijk(uit.domain.status, 'pending_dns', 'status');
      gelijk(uit.domain.records[0], { type: 'CNAME', name: domein, value: CNAME_DOEL }, 'CNAME-record');
      const bijCfTxt = [...cf.hostnames.values()].find((h) => h.hostname === domein)?.ownership_verification;
      gelijk(uit.domain.records[1], { type: 'TXT', name: bijCfTxt?.name, value: bijCfTxt?.value }, 'TXT-record van deze koppeling');
      verwacht(/nog geen CNAME-record/.test(uit.domain.problem ?? ''), `melding: ${uit.domain.problem}`);
      const bijCf = [...cf.hostnames.values()].find((h) => h.hostname === domein);
      verwacht(bijCf, 'niet bij Cloudflare');
      gelijk([bijCf.ssl.method, bijCf.ssl.type, bijCf.ssl.settings?.min_tls_version], ['http', 'dv', '1.2'], 'certificaat');
      gelijk(domeinRij(domein)?.cf_custom_hostname_id, bijCf.id, 'id bij Cloudflare');
      verwacht(auditActies(w.orgId, 'client_domain').includes('added'), 'geen logboekregel');
    });

    await stap('een tweede domein tegelijk kan niet', async () => {
      geweigerd(await domeinen(w.eigenaar, w.orgId, 'addDomain', { hostname: `web.kd-${RONDE}.nl` }), 'tweede domein', [409]);
    });

    await stap('een andere organisatie kan hetzelfde domein niet koppelen', async () => {
      const voor = cf.hostnames.size;
      const res = geweigerd(await domeinen(w2.eigenaar, w2.orgId, 'addDomain', { hostname: domein }), 'ander', [409]);
      verwacht(/andere organisatie/.test(JSON.stringify(res)), `melding: ${JSON.stringify(res)}`);
      gelijk(cf.hostnames.size, voor, 'hostnamen bij Cloudflare');
    });

    await stap('een domein van een ander nalopen of verwijderen kan niet', async () => {
      geweigerd(await domeinen(w2.eigenaar, w2.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen', [404]);
      geweigerd(await domeinen(w2.eigenaar, w2.orgId, 'removeDomain', { domainId: domeinId }), 'verwijderen', [404]);
      geweigerd(await domeinen(w.medewerker, w.orgId, 'removeDomain', { domainId: domeinId }), 'teamlid verwijdert', [403]);
      gelijk(domeinRij(domein)?.status, 'pending_dns', 'status');
    });

    await stap('het record wijst ergens anders heen: dat zegt het scherm', async () => {
      dns.set(domein, ['elders.voorbeeld.net']);
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen');
      gelijk(uit.domain.status, 'pending_dns', 'status');
      verwacht((uit.domain.problem ?? '').includes('elders.voorbeeld.net') && (uit.domain.problem ?? '').includes(CNAME_DOEL), `melding: ${uit.domain.problem}`);
    });

    await stap('CNAME goed, maar zonder het TXT-record van deze koppeling geen stap verder', async () => {
      dns.set(domein, [CNAME_DOEL]);
      zetCf(domein, { status: 'active', ssl: 'pending_issuance' });
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen');
      gelijk(uit.domain.status, 'pending_dns', 'status');
      verwacht((uit.domain.problem ?? '').includes(`TXT-record op _cf-custom-hostname.${domein}`), `melding: ${uit.domain.problem}`);
    });

    await stap('met het TXT-record: record goed, certificaat nog onderweg', async () => {
      zetTxt(domein);
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen');
      gelijk([uit.domain.status, uit.domain.problem], ['pending_certificate', null], 'status');
    });

    await stap('de opzoeking van de Worker: een wachtend domein toont nog niets', async () => {
      gelijk(gelukt(await opzoeken(domein), 'opzoeken'), { ok: true, status: 'pending' }, 'antwoord');
    });

    await stap('actief: eigenaar en beheerder krijgen een mail, het logboek een regel', async () => {
      zetCf(domein, { status: 'active', ssl: 'active' });
      const voor = post.mails.length;
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen');
      gelijk([uit.domain.status, uit.domain.problem], ['active', null], 'status');
      verwacht(uit.domain.verifiedAt, 'geen verifiedAt');
      const nieuw = post.mails.slice(voor);
      gelijk(nieuw.length, 1, 'mails');
      gelijk([...nieuw[0].to].sort(), [w.beheerder.email, w.eigenaar.email].sort(), 'aan');
      verwacht(nieuw[0].subject.includes(`${domein} is actief`), `onderwerp: ${nieuw[0].subject}`);
      verwacht(auditActies(w.orgId, 'client_domain').includes('active'), 'geen logboekregel');
    });

    await stap('nog eens nalopen: geen tweede mail', async () => {
      const voor = post.mails.length;
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen').domain.status, 'active', 'status');
      gelijk(post.mails.length, voor, 'mails');
    });

    await stap('zolang de klantadressen niet live zijn, gaan links naar het algemene adres', async () => {
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht');
      gelijk([uit.clientUrl, uit.onClientHost], [PUBLIEK, false], 'links');
      const { link } = await verstuurFactuur(w);
      verwacht(link.startsWith(`${PUBLIEK}/invoice/`), `link: ${link}`);
    });

    process.env.CLIENT_DOMAINS_LIVE = 'true';

    await stap('live: links gaan naar het eigen domein, in het overzicht en in de mail', async () => {
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht');
      gelijk([uit.clientUrl, uit.onClientHost], [`https://${domein}`, true], 'links');
      const { link } = await verstuurFactuur(w);
      verwacht(link.startsWith(`https://${domein}/invoice/`), `link: ${link}`);
    });

    await stap('het record hapert: failing, een mail, en links terug naar de naam bij ResoFly', async () => {
      zetCf(domein, { status: 'moved' });
      const voor = post.mails.length;
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen');
      gelijk(uit.domain.status, 'failing', 'status');
      const nieuw = post.mails.slice(voor);
      verwacht(nieuw.length === 1 && nieuw[0].subject.includes('werkt niet meer'), `mails: ${nieuw.map((m) => m.subject)}`);
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht').clientUrl, herkomstA(), 'links');
      const { link } = await verstuurFactuur(w);
      verwacht(link.startsWith(`${herkomstA()}/invoice/`), `link: ${link}`);
    });

    await stap('weer in orde: actief, en links weer naar het eigen domein', async () => {
      zetCf(domein, { status: 'active', ssl: 'active' });
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'refreshDomain', { domainId: domeinId }), 'nalopen').domain.status, 'active', 'status');
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht').clientUrl, `https://${domein}`, 'links');
    });

    // ── 3. De Worker ────────────────────────────────────────────────────────
    groep('Klantdomein: de opzoeking van de Worker');

    await stap('zonder geheim, met een leeg of fout geheim: geen toegang', async () => {
      geweigerd(await opzoeken(adresA(), { geheim: '' }), 'leeg geheim', [401]);
      geweigerd(await opzoeken(adresA(), { geheim: 'fout-geheim' }), 'fout geheim', [401]);
      geweigerd(await opzoeken(adresA(), { geheim: `${CLIENT_DOMAINS_WERKER_GEHEIM}x` }), 'bijna goed', [401]);
      geweigerd(await roep('client-domains', { origin: null, body: { host: adresA() } }), 'zonder kop', [401, 403]);
    });

    await stap('alleen POST', async () => {
      geweigerd(await opzoeken(adresA(), { method: 'GET' }), 'GET', [405]);
    });

    await stap('de naam bij ResoFly: inlogsleutel en merk, zonder het id van de organisatie', async () => {
      const uit = gelukt(await opzoeken(adresA()), 'opzoeken');
      const sleutel = sqlRij(`select key from public.portal_login_addresses where organization_id = ${q(w.orgId)}`)?.key;
      gelijk([uit.status, uit.kind, uit.host, uit.portalKey], ['active', 'subdomain', adresA(), nodig(sleutel, 'inlogsleutel')], 'antwoord');
      verwacht(uit.brand?.name, `geen merknaam: ${JSON.stringify(uit.brand)}`);
      verwacht(!JSON.stringify(uit).includes(w.orgId), 'het antwoord noemt de organisatie');
    });

    await stap('het eigen domein: actief, ook met hoofdletters en een punt aan het eind', async () => {
      const uit = gelukt(await opzoeken(`${domein.toUpperCase()}.`), 'opzoeken');
      gelijk([uit.status, uit.kind, uit.host], ['active', 'custom', domein], 'antwoord');
    });

    await stap('een oude naam stuurt door naar het huidige adres (het eigen domein)', async () => {
      gelijk(gelukt(await opzoeken(`${nieuweNaam}.${BASE}`), 'opzoeken'), { ok: true, status: 'redirect', redirectHost: domein }, 'antwoord');
    });

    await stap('onbekend, het basisdomein zelf en een gereserveerde naam: onbekend', async () => {
      for (const host of [`bestaat-niet-${Date.now()}.${BASE}`, BASE, `www.${BASE}`, `a.b.${BASE}`, 'localhost', '']) {
        gelijk(gelukt(await opzoeken(host), host || '(leeg)').status, 'unknown', host || '(leeg)');
      }
    });

    // ── 4 en 5. Links en de publieke functies vanaf een klantadres ──────────
    groep('Klantdomein: links en de publieke pagina\'s vanaf een klantadres');

    let factuur = null;
    await stap('documenten op het eigen domein, het portaal op de naam bij ResoFly', async () => {
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht');
      gelijk([uit.clientUrl, uit.onClientHost], [`https://${domein}`, true], 'documenten');
      gelijk([uit.portalUrl, uit.portalOnClientHost], [herkomstA(), true], 'portaal');
      gelijk(gelukt(await opzoeken(domein), 'opzoeken').portalHost, adresA(), 'de Worker weet waar het portaal woont');
    });

    await stap('de welkomstmail van het portaal linkt naar de naam bij ResoFly, zonder inlogsleutel', async () => {
      // Nooit het eigen domein: daar beheert de organisatie de DNS, en de sessie
      // van een klant geldt ook bij andere leveranciers (clientPortalBaseUrl).
      const basis = herkomstA();
      const voor = mailsAan(w.klantA.email).length;
      gelukt(await roep('mail', { token: w.medewerker.token, body: { action: 'sendClientPortalWelcome', organizationId: w.orgId, clientId: w.klantA.id } }), 'welkomstmail');
      const mail = mailsAan(w.klantA.email).slice(voor)[0];
      const tekst = `${mail?.html ?? ''} ${mail?.text ?? ''}`;
      verwacht(tekst.includes(`${basis}/portal`), `geen portaallink op het klantadres: ${(mail?.text ?? '').slice(0, 400)}`);
      verwacht(!/\/portal\/[a-z0-9-]+-[a-z0-9]{10}/i.test(tekst), 'de mail noemt nog het inlogadres met sleutel');
    });

    await stap('een factuur op het eigen domein openen: CORS voor dat adres', async () => {
      factuur = await verstuurFactuur(w);
      const herkomst = `https://${domein}`;
      const res = await roep('invoice-public', { origin: herkomst, body: { action: 'getInvoice', token: factuur.token } });
      gelukt(res, 'factuur openen');
      gelijk(res.headers.get('access-control-allow-origin'), herkomst, 'CORS');
      const voorvlucht = await roep('invoice-public', { method: 'OPTIONS', origin: herkomst });
      gelijk(voorvlucht.headers.get('access-control-allow-origin'), herkomst, 'CORS bij de voorvlucht');
    });

    await stap('dezelfde factuur via de naam bij ResoFly: ook goed', async () => {
      const res = gelukt(await roep('invoice-public', { origin: herkomstA(), body: { action: 'getInvoice', token: factuur.token } }), 'via de naam');
      verwacht(res, 'geen factuur');
    });

    await stap('een factuur van een ander op dit adres bestaat niet (zelfde melding als een onbekende link)', async () => {
      const ander = await verstuurFactuur(w2);
      const res = await roep('invoice-public', { origin: herkomstA(), body: { action: 'getInvoice', token: ander.token } });
      const onbekend = await roep('invoice-public', { origin: herkomstA(), body: { action: 'getInvoice', token: 'x'.repeat(43) } });
      geweigerd(res, 'factuur van een ander', [404]);
      geweigerd(onbekend, 'onbekende link', [404]);
      gelijk(res.json?.error, onbekend.json?.error, 'melding');
      // Op het eigen adres van de ander, en op het algemene adres, werkt hij wel.
      gelukt(await roep('invoice-public', { origin: herkomstB(), body: { action: 'getInvoice', token: ander.token } }), 'op het adres van de ander');
      gelukt(await roep('invoice-public', { origin: ORIGIN, body: { action: 'getInvoice', token: ander.token } }), 'op het algemene adres');
    });

    await stap('een onbekend of verkeerd gevormd klantadres krijgt geen CORS', async () => {
      clearClientOriginCache();
      for (const herkomst of [`https://bestaat-niet-${Date.now()}.${BASE}`, `http://${adresA()}`, `https://${adresA()}:8443`, 'https://kwaadwillend.test', `https://${adresA()}.kwaadwillend.test`]) {
        const res = await roep('invoice-public', { origin: herkomst, body: { action: 'getInvoice', token: factuur.token } });
        geweigerd(res, herkomst, [403]);
        verwacht(res.headers.get('access-control-allow-origin') !== herkomst, `${herkomst} kreeg CORS`);
      }
    });

    await stap('een oude naam (doorsturen) is geen klantadres meer voor CORS', async () => {
      clearClientOriginCache();
      const res = await roep('invoice-public', { origin: `https://${nieuweNaam}.${BASE}`, body: { action: 'getInvoice', token: factuur.token } });
      geweigerd(res, 'oude naam', [403]);
    });

    // ── 6. Inloggen op het portaal ──────────────────────────────────────────
    groep('Klantdomein: inloggen op het portaal met de eigen inlogmail');
    const browser1 = verifier();
    let aanvraag1 = null;

    await stap('een klant vraagt op het klantadres een inlogmail aan', async () => {
      const voor = mailsAan(w.klantA.email).length;
      const uit = gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(11), body: { action: 'requestLogin', email: w.klantA.email, verifierHash: sha256(browser1) } }), 'aanvragen');
      gelijk(uit, { ok: true, known: true, flow: 'mail' }, 'antwoord');
      const mail = mailsAan(w.klantA.email).slice(voor)[0];
      verwacht(mail, 'geen inlogmail');
      aanvraag1 = nodig(aanvraagUitMail(mail), 'aanvraagnummer in de mail');
      verwacht(`${mail.html} ${mail.text}`.includes(`${herkomstA()}/portal/inloggen?aanvraag=${aanvraag1}`), `link: ${mail.text}`);
      verwacht(!`${mail.html} ${mail.text}`.includes(domein), 'de inlogmail noemt het eigen domein');
      verwacht(/^Inloggen bij /.test(mail.subject), `onderwerp: ${mail.subject}`);
      verwacht(codeUitMail(mail), 'geen code in de mail');
      verwacht(mail.text.includes(`Vul de code alleen in op ${adresA()}.`), `de mail zegt niet waar de code hoort: ${mail.text}`);
      verwacht(!`${mail.html} ${mail.text}`.includes(browser1), 'het geheim van de browser staat in de mail');
      const rij = sqlRij(`select organization_id, scope_organization_id, host, email, verifier_hash, used_at, bound_session_id from public.portal_login_requests where request_hash = ${q(sha256(aanvraag1))}`);
      gelijk([rij?.organization_id, rij?.scope_organization_id, rij?.host, rij?.email, rij?.verifier_hash, rij?.used_at, rij?.bound_session_id],
        [w.orgId, w.orgId, adresA(), w.klantA.email, sha256(browser1), null, null], 'aanvraag: bereik en adres van het klantadres');
      // Het moment van het token van Supabase, precies zoals in auth.users (voor het vastleggen).
      const tijden = sqlRij(`select r.token_sent_at = u.recovery_sent_at as gelijk, r.token_sent_at is not null as gevuld
        from public.portal_login_requests r join auth.users u on lower(u.email) = r.email where r.request_hash = ${q(sha256(aanvraag1))}`);
      gelijk([tijden?.gevuld, tijden?.gelijk], [true, true], 'token_sent_at');
    });

    await stap('een onbekend adres en een klant van een ander: hetzelfde antwoord, geen mail', async () => {
      const voor = post.mails.length;
      const onbekend = gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(12), body: { action: 'requestLogin', email: `niemand.${Date.now()}@klant.test`, verifierHash: sha256(verifier()) } }), 'onbekend');
      const vanAnder = gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(12), body: { action: 'requestLogin', email: w2.klantA.email, verifierHash: sha256(verifier()) } }), 'klant van een ander');
      gelijk(onbekend, { ok: true, known: true, flow: 'mail' }, 'onbekend');
      gelijk(vanAnder, { ok: true, known: true, flow: 'mail' }, 'klant van een ander');
      gelijk(post.mails.length, voor, 'mails');
    });

    await stap('de link in een andere browser: geweigerd, en de poging telt', async () => {
      const res = await roep('portal-login', { origin: herkomstA(), ip: ip(13), body: { action: 'redeemLogin', request: aanvraag1, verifiers: [verifier()] } });
      geweigerd(res, 'andere browser', [403]);
      verwacht(/andere browser/.test(res.json?.error ?? ''), `melding: ${res.json?.error}`);
      gelijk(Number(sqlRij(`select attempts from public.portal_login_requests where request_hash = ${q(sha256(aanvraag1))}`)?.attempts), 1, 'pogingen');
    });

    await stap('de link op het adres van een andere organisatie of op het algemene adres: alsof hij niet bestaat', async () => {
      geweigerd(await roep('portal-login', { origin: herkomstB(), ip: ip(13), body: { action: 'redeemLogin', request: aanvraag1, verifiers: [browser1] } }), 'ander adres', [410]);
      geweigerd(await roep('portal-login', { origin: ORIGIN, ip: ip(13), body: { action: 'redeemLogin', request: aanvraag1, verifiers: [browser1] } }), 'algemeen adres', [410]);
      gelijk(sqlRij(`select used_at from public.portal_login_requests where request_hash = ${q(sha256(aanvraag1))}`)?.used_at, null, 'niet gebruikt');
    });

    let sessie1 = null;
    await stap('in de eigen browser: het inlogtoken, en GoTrue logt de klant in', async () => {
      const uit = gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(13), body: { action: 'redeemLogin', request: aanvraag1, verifiers: [verifier(), browser1] } }), 'inwisselen');
      gelijk(uit.email, w.klantA.email, 'e-mailadres');
      gelijk(uit.portalKey, sqlRij(`select key from public.portal_login_addresses where organization_id = ${q(w.orgId)}`)?.key, 'inlogsleutel');
      const login = await gotrueVerify({ type: 'magiclink', token_hash: nodig(uit.tokenHash, 'inlogtoken') });
      gelijk(login.status, 200, `GoTrue: ${login.tekst.slice(0, 200)}`);
      gelijk(login.json?.user?.email, w.klantA.email, 'ingelogd als');
      sessie1 = login.json?.access_token;
      verwacht(sessie1, 'geen sessie');
    });

    // ── 7. De inlog per gebruiker (migratie 20261109020000) ───────────────
    await stap('nog niet vastgelegd: het portaal geeft niets', async () => {
      const res = geweigerd(await roep('client-portal', { origin: herkomstA(), token: sessie1, body: { action: 'getPortalData' } }), 'niet vastgelegd', [401]);
      gelijk(res?.code, 'session_unbound', 'code');
    });

    await stap('vastleggen bij de aanvraag: één inlog, voor alleen deze organisatie', async () => {
      gelijk(gelukt(await vastleggen(sessie1, { origin: herkomstA(), ip: ip(13), request: aanvraag1, verifiers: [verifier(), browser1] }), 'vastleggen'),
        { ok: true, bound: true }, 'antwoord');
      const rij = sqlRij(`select ps.organization_id, ps.host, r.bound_session_id = ps.session_id as gekoppeld
        from public.portal_sessions ps join public.portal_login_requests r on r.request_hash = ${q(sha256(aanvraag1))}
        where ps.session_id = r.bound_session_id`);
      gelijk([rij?.organization_id, rij?.host, rij?.gekoppeld], [w.orgId, adresA(), true], 'vastgelegd');
    });

    await stap('nog een keer vastleggen (een haperende verbinding): hetzelfde antwoord', async () => {
      gelukt(await vastleggen(sessie1, { origin: herkomstA(), ip: ip(13), request: aanvraag1, verifiers: [browser1] }), 'nog eens');
    });

    await stap('een vastgelegde inlog aan een andere aanvraag hangen kan niet, en hij blijft werken', async () => {
      geweigerd(await vastleggen(sessie1, { origin: herkomstA(), ip: ip(13), verifiers: [verifier()] }), 'andere aanvraag', [403]);
      verwacht(await sessieLeeft(sessie1), 'de inlog is weg');
    });

    // Dezelfde klant (hetzelfde adres) bij de tweede organisatie: wat de inlog
    // ziet, hangt af van waar hij ontstond.
    let gedeeldA = null;
    let gedeeldB = null;
    await stap('een klant van beide organisaties (hetzelfde adres)', async () => {
      const email = `gedeeld.${RONDE}@klant.test`;
      gedeeldA = await nieuweKlant(w, 'gedeeld-a', email);
      gedeeldB = await nieuweKlant(w2, 'gedeeld-b', email);
    });

    await stap('met die inlog opent het portaal alleen de gegevens van deze organisatie', async () => {
      const uit = gelukt(await roep('client-portal', { origin: herkomstA(), token: sessie1, body: { action: 'getPortalData' } }), 'portaal');
      verwacht(JSON.stringify(uit).includes(w.klantA.id), 'de klant staat er niet in');
      verwacht(!JSON.stringify(uit).includes(w2.klantA.id), 'een klant van een ander staat erin');
    });

    await stap('dezelfde inlog op het adres van de andere organisatie: niets', async () => {
      const res = geweigerd(await roep('client-portal', { origin: herkomstB(), token: sessie1, body: { action: 'getPortalData' } }), 'ander adres', [401]);
      gelijk(res?.code, 'session_unbound', 'code');
      verwacht(await sessieLeeft(sessie1), 'de inlog is weg');
    });

    let algemeen = null;
    await stap('inloggen op het algemene portaal: een inlog die alles ziet', async () => {
      algemeen = await inloggenMetLink(gedeeldA.email, { origin: ORIGIN, ipAanvraag: ip(21), ipInwisselen: ip(22) });
      verwacht(algemeen.mail.text.includes(`${PUBLIEK}/portal/inloggen?aanvraag=`), `de link gaat niet naar het algemene adres: ${algemeen.mail.text}`);
      verwacht(algemeen.mail.text.includes(`Vul de code alleen in op ${new URL(PUBLIEK).hostname}.`), 'de mail zegt niet waar de code hoort');
      // Twee leveranciers: geen naam van één van beiden in de mail.
      verwacht(!/^Inloggen bij /.test(algemeen.mail.subject), `onderwerp: ${algemeen.mail.subject}`);
      const rij = sqlRij(`select organization_id, host from public.portal_sessions where user_id = ${q(algemeen.userId)} order by created_at desc limit 1`);
      gelijk(rij?.organization_id ?? null, null, 'bereik: alles');
      gelijk(await dossiers(algemeen.token, ORIGIN), [gedeeldA.id, gedeeldB.id].sort(), 'beide dossiers');
    });

    await stap('de code uit de mail werkt op een ander apparaat, met het geheim van de browser die hem aanvroeg', async () => {
      const goed = verifier();
      const voor = mailsAan(w.klantB.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(14), body: { action: 'requestLogin', email: w.klantB.email, verifierHash: sha256(goed) } }), 'aanvragen');
      const mail = mailsAan(w.klantB.email).slice(voor)[0];
      const code = nodig(codeUitMail(mail), 'code');
      const fout = await gotrueVerify({ type: 'email', email: w.klantB.email, token: code === '000000' ? '111111' : '000000' });
      verwacht(fout.status >= 400, `een verkeerde code werd aangenomen: ${fout.status}`);
      const login = await gotrueVerify({ type: 'email', email: w.klantB.email, token: code });
      gelijk(login.status, 200, `GoTrue: ${login.tekst.slice(0, 200)}`);
      gelijk(login.json?.user?.email, w.klantB.email, 'ingelogd als');
      gelukt(await vastleggen(login.json.access_token, { origin: herkomstA(), ip: ip(14), verifiers: [verifier(), goed] }), 'vastleggen met de code');
      const ids = await dossiers(login.json.access_token, herkomstA());
      gelijk(ids, [w.klantB.id], 'het eigen dossier');
    });

    await stap('de code met het geheim van een andere browser: geweigerd, en de inlog is weg', async () => {
      const goed = verifier();
      const voor = mailsAan(w.klantB.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(14), body: { action: 'requestLogin', email: w.klantB.email, verifierHash: sha256(goed) } }), 'aanvragen');
      const code = nodig(codeUitMail(mailsAan(w.klantB.email).slice(voor)[0]), 'code');
      const login = await gotrueVerify({ type: 'email', email: w.klantB.email, token: code });
      gelijk(login.status, 200, `GoTrue: ${login.tekst.slice(0, 200)}`);
      const res = geweigerd(await vastleggen(login.json.access_token, { origin: herkomstA(), ip: ip(14), verifiers: [verifier()] }), 'ander geheim', [403]);
      verwacht(/andere aanvraag/.test(res?.error ?? ''), `melding: ${res?.error}`);
      verwacht(!(await sessieLeeft(login.json.access_token)), 'de inlog leeft nog');
      geweigerd(await roep('client-portal', { origin: herkomstA(), token: login.json.access_token, body: { action: 'getPortalData' } }), 'portaal', [401]);
    });

    await stap('een inlog hoort bij de nieuwste aanvraag: een oudere aanvraag op het algemene portaal helpt niet', async () => {
      // Een leverancier die de pagina op zijn eigen adres beheert, zet eerst
      // (vanaf zijn server) een aanvraag op het algemene portaal klaar, met
      // een eigen geheim. Daarna vraagt de klant zelf in, op het adres van A.
      const doelwit = await nieuweKlant(w, 'doelwit');
      const aanvaller = verifier();
      const voor = mailsAan(doelwit.email).length;
      gelukt(await roep('portal-login', { origin: ORIGIN, ip: ip(30), body: { action: 'requestLogin', email: doelwit.email, verifierHash: sha256(aanvaller) } }), 'aanvraag van de aanvaller');
      const aanvraagAanvaller = nodig(aanvraagUitMail(mailsAan(doelwit.email).slice(voor)[0]), 'aanvraagnummer');
      const klant = verifier();
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(31), body: { action: 'requestLogin', email: doelwit.email, verifierHash: sha256(klant) } }), 'aanvraag van de klant');
      const code = nodig(codeUitMail(mailsAan(doelwit.email).slice(voor)[1]), 'code van de klant');
      // De link van de oudere aanvraag werkt niet meer: Supabase kent per account één inlogtoken.
      const oud = gelukt(await roep('portal-login', { origin: ORIGIN, ip: ip(30), body: { action: 'redeemLogin', request: aanvraagAanvaller, verifiers: [aanvaller] } }), 'oude link inwisselen');
      verwacht((await gotrueVerify({ type: 'magiclink', token_hash: oud.tokenHash })).status >= 400, 'de oude link logt nog in');
      // De klant vult zijn code in op de pagina van de leverancier; die wisselt hem in ...
      const login = await gotrueVerify({ type: 'email', email: doelwit.email, token: code });
      gelijk(login.status, 200, `GoTrue: ${login.tekst.slice(0, 200)}`);
      // ... en hangt de inlog aan zijn eigen aanvraag op het algemene portaal: geweigerd.
      const res = geweigerd(await vastleggen(login.json.access_token, { origin: ORIGIN, ip: ip(30), verifiers: [aanvaller] }), 'aan de oudere aanvraag', [403]);
      verwacht(/andere aanvraag/.test(res?.error ?? ''), `melding: ${res?.error}`);
      verwacht(!(await sessieLeeft(login.json.access_token)), 'de inlog leeft nog');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_sessions where user_id = ${q(login.json.user.id)}`)?.n, 0, 'vastgelegde inloggen');
    });

    await stap('een onderschepte inlog hangt niet aan een aanvraag die daarna kwam', async () => {
      // De klant logt in op het adres van A. Wie die verse inlog onderschept,
      // vraagt meteen daarna zelf een inlog aan op het algemene portaal, met
      // een eigen geheim, en hangt de inlog van de klant daaraan. Met een
      // minuut speling op de tijden lukte dat.
      const klant = await nieuweKlant(w, 'onderschept');
      const voor = mailsAan(klant.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(41), body: { action: 'requestLogin', email: klant.email, verifierHash: sha256(verifier()) } }), 'aanvraag van de klant');
      const code = nodig(codeUitMail(mailsAan(klant.email).slice(voor)[0]), 'code');
      const login = await gotrueVerify({ type: 'email', email: klant.email, token: code });
      gelijk(login.status, 200, `GoTrue: ${login.tekst.slice(0, 200)}`);
      const aanvaller = verifier();
      gelukt(await roep('portal-login', { origin: ORIGIN, ip: ip(42), body: { action: 'requestLogin', email: klant.email, verifierHash: sha256(aanvaller) } }), 'aanvraag van de aanvaller');
      // Geweigerd omdat de inlog ouder is dan het token van die aanvraag (de rest klopt: nieuwste aanvraag, geheim, adres).
      const res = geweigerd(await vastleggen(login.json.access_token, { origin: ORIGIN, ip: ip(42), verifiers: [aanvaller] }), 'aan de latere aanvraag', [403]);
      verwacht(/Inloggen is niet gelukt/.test(res?.error ?? ''), `melding: ${res?.error}`);
      verwacht(!(await sessieLeeft(login.json.access_token)), 'de inlog leeft nog');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_sessions where user_id = ${q(login.json.user.id)}`)?.n, 0, 'vastgelegde inloggen');
    });

    await stap('wie ook een werkruimte heeft, krijgt alleen de link, geen code van Supabase', async () => {
      // Een teamlid van de tweede organisatie is klant bij de eerste. Een inlog
      // bij Supabase opent voor hem ook de werkruimte: geen code die een
      // andere website kan vragen.
      const teamlid = w2.medewerker;
      await nieuweKlant(w, 'teamlid', teamlid.email);
      const voor = mailsAan(teamlid.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(44), body: { action: 'requestLogin', email: teamlid.email, verifierHash: sha256(verifier()) } }), 'aanvragen');
      const mail = mailsAan(teamlid.email).slice(voor)[0];
      verwacht(mail && aanvraagUitMail(mail), 'geen inlogmail met link');
      gelijk(codeUitMail(mail), null, 'een code in de mail');
      verwacht(!/ander apparaat/.test(`${mail.html} ${mail.text}`), 'de mail noemt een code');
    });

    await stap('een wachtwoord geeft geen portaalinlog, ook niet met een geldige aanvraag', async () => {
      // Zoals iemand die met een uitgelekt token een wachtwoord instelde.
      const klant = await nieuweKlant(w, 'wachtwoord');
      const geheim = verifier();
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(32), body: { action: 'requestLogin', email: klant.email, verifierHash: sha256(geheim) } }), 'aanvragen');
      const userId = nodig(sqlRij(`select id from auth.users where email = ${q(klant.email)}`)?.id, 'account');
      const token = await wachtwoordSessie(userId, klant.email);
      const res = geweigerd(await roep('client-portal', { origin: herkomstA(), token, body: { action: 'getPortalData' } }), 'met een wachtwoord', [401]);
      gelijk(res?.code, 'session_unbound', 'code');
      geweigerd(await vastleggen(token, { origin: herkomstA(), ip: ip(32), verifiers: [geheim] }), 'een wachtwoord vastleggen', [403]);
      verwacht(!(await sessieLeeft(token)), 'de inlog met het wachtwoord leeft nog');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_sessions where user_id = ${q(userId)}`)?.n, 0, 'vastgelegde inloggen');
    });

    await stap('vastleggen zonder (geldig) token of met een rommelig aanvraagnummer: netjes geweigerd', async () => {
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(33), body: { action: 'bindSession', verifiers: [browser1] } }), 'zonder token', [401]);
      geweigerd(await vastleggen('geen.echt.token', { origin: herkomstA(), ip: ip(33), verifiers: [browser1] }), 'onzin', [401]);
      geweigerd(await vastleggen(sessie1, { origin: herkomstA(), ip: ip(33), request: '../x', verifiers: [browser1] }), 'aanvraagnummer', [400]);
      verwacht(await sessieLeeft(sessie1), 'de inlog is weg');
    });

    await stap('inloggen en het portaal vanaf het eigen domein: geen CORS zolang het portaal daar niet aan staat', async () => {
      clearClientOriginCache();
      const herkomst = `https://${domein}`;
      const voor = post.mails.length;
      const aanvraag = await roep('portal-login', { origin: herkomst, ip: ip(20), body: { action: 'requestLogin', email: w.klantA.email, verifierHash: sha256(verifier()) } });
      geweigerd(aanvraag, 'inloggen vanaf het eigen domein', [403]);
      verwacht(aanvraag.headers.get('access-control-allow-origin') !== herkomst, 'CORS voor het eigen domein');
      gelijk(post.mails.length, voor, 'mails');
      const portaal = await roep('client-portal', { origin: herkomst, token: sessie1, body: { action: 'getPortalData' } });
      geweigerd(portaal, 'het portaal vanaf het eigen domein', [403]);
      // Documenten op het eigen domein blijven gewoon werken.
      gelukt(await roep('invoice-public', { origin: herkomst, body: { action: 'getInvoice', token: factuur.token } }), 'factuur op het eigen domein');
    });

    await stap('dezelfde link nog eens: verlopen of al gebruikt', async () => {
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(13), body: { action: 'redeemLogin', request: aanvraag1, verifiers: [browser1] } }), 'nog eens', [410]);
    });

    await stap('na vijf verkeerde browsers is de link op', async () => {
      const browser = verifier();
      const voor = mailsAan(w.klantB.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(15), body: { action: 'requestLogin', email: w.klantB.email, verifierHash: sha256(browser) } }), 'aanvragen');
      const aanvraag = nodig(aanvraagUitMail(mailsAan(w.klantB.email).slice(voor)[0]), 'aanvraagnummer');
      for (let i = 0; i < 5; i += 1) {
        geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(15), body: { action: 'redeemLogin', request: aanvraag, verifiers: [verifier()] } }), `poging ${i + 1}`, [403]);
      }
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(15), body: { action: 'redeemLogin', request: aanvraag, verifiers: [browser] } }), 'daarna de goede', [410]);
    });

    await stap('een verlopen link werkt niet', async () => {
      const browser = verifier();
      const voor = mailsAan(w.klantA.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(16), body: { action: 'requestLogin', email: w.klantA.email, verifierHash: sha256(browser) } }), 'aanvragen');
      const aanvraag = nodig(aanvraagUitMail(mailsAan(w.klantA.email).slice(voor)[0]), 'aanvraagnummer');
      sql(`update public.portal_login_requests set expires_at = now() - interval '1 minute' where request_hash = ${q(sha256(aanvraag))}`);
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(16), body: { action: 'redeemLogin', request: aanvraag, verifiers: [browser] } }), 'verlopen', [410]);
    });

    await stap('een ongeldig aanvraagnummer: netjes geweigerd', async () => {
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(17), body: { action: 'redeemLogin', request: 'kort', verifiers: [browser1] } }), 'kort', [400]);
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(17), body: { action: 'redeemLogin', request: randomBytes(32).toString('base64url'), verifiers: [browser1] } }), 'onbekend', [410]);
    });

    await stap('een oude app zonder geheim: vernieuwen, en wij mailen niet', async () => {
      const voor = post.mails.length;
      const res = geweigerd(await roep('portal-login', { origin: ORIGIN, ip: ip(18), body: { action: 'requestLogin', email: w.klantA.email } }), 'zonder geheim', [400]);
      verwacht(/Vernieuw de pagina/.test(res?.error ?? ''), `melding: ${res?.error}`);
      gelijk(post.mails.length, voor, 'mails');
    });

    await stap('de huisstijl van het inlogscherm volgt het klantadres', async () => {
      const uit = gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(19), body: { action: 'getBranding' } }), 'huisstijl');
      verwacht(uit.branding?.companyName, `geen naam: ${JSON.stringify(uit.branding)?.slice(0, 200)}`);
      const algemeen = gelukt(await roep('portal-login', { origin: ORIGIN, ip: ip(19), body: { action: 'getBranding' } }), 'algemeen');
      gelijk(algemeen.branding, null, 'op het algemene adres zonder sleutel');
    });

    // ── 8. Het portaal op het eigen domein ──────────────────────────────────
    groep('Klantdomein: het klantportaal op het eigen domein');
    const herkomstDomein = `https://${domein}`;

    await stap('standaard uit: het overzicht, de Worker en de links zeggen het', async () => {
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht');
      gelijk([uit.domain?.portalEnabled, uit.portalUrl], [false, herkomstA()], 'overzicht');
      const opgezocht = gelukt(await opzoeken(domein), 'opzoeken');
      gelijk([opgezocht.portalEnabled, opgezocht.portalHost], [false, adresA()], 'Worker');
    });

    await stap('alleen de eigenaar of een beheerder zet het aan; een ander en een fout antwoord niet', async () => {
      geweigerd(await domeinen(w.medewerker, w.orgId, 'setPortal', { domainId: domeinId, enabled: true }), 'medewerker', [403]);
      geweigerd(await domeinen(w.kijker, w.orgId, 'setPortal', { domainId: domeinId, enabled: true }), 'kijker', [403]);
      geweigerd(await domeinen(vreemde, w.orgId, 'setPortal', { domainId: domeinId, enabled: true }), 'iemand van buiten', [403]);
      geweigerd(await domeinen(vreemde, w2.orgId, 'setPortal', { domainId: domeinId, enabled: true }), 'het domein van een ander', [404]);
      geweigerd(await domeinen(w.beheerder, w.orgId, 'setPortal', { domainId: domeinId, enabled: 'ja' }), 'geen ja of nee', [400]);
      gelijk(domeinRij(domein)?.portal_enabled, false, 'nog uit');
    });

    await stap('de beheerder zet het aan: links, de Worker en het logboek', async () => {
      const uit = gelukt(await domeinen(w.beheerder, w.orgId, 'setPortal', { domainId: domeinId, enabled: true }), 'aanzetten');
      gelijk(uit.domain?.portalEnabled, true, 'aan');
      const overzicht = gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht');
      gelijk([overzicht.portalUrl, overzicht.portalOnClientHost], [herkomstDomein, true], 'portaal');
      const opgezocht = gelukt(await opzoeken(domein), 'opzoeken');
      gelijk([opgezocht.portalEnabled, opgezocht.portalHost], [true, null], 'Worker');
      verwacht(auditActies(w.orgId, 'client_domain').includes('portal_enabled'), `logboek: ${auditActies(w.orgId, 'client_domain')}`);
      const voor = mailsAan(w.klantA.email).length;
      gelukt(await roep('mail', { token: w.medewerker.token, body: { action: 'sendClientPortalWelcome', organizationId: w.orgId, clientId: w.klantA.id } }), 'welkomstmail');
      const mail = mailsAan(w.klantA.email).slice(voor)[0];
      verwacht(`${mail?.html ?? ''} ${mail?.text ?? ''}`.includes(`${herkomstDomein}/portal`), `de welkomstmail linkt niet naar het eigen domein: ${(mail?.text ?? '').slice(0, 300)}`);
    });

    let sleutelDomein = null;
    await stap('inloggen op het eigen domein: een code van ResoFly, de link gaat daarheen, en een sleutel in plaats van een inlog bij Supabase', async () => {
      clearClientOriginCache();
      const userId = nodig(sqlRij(`select id from auth.users where email = ${q(gedeeldA.email)}`)?.id, 'account');
      const voorAuth = sqlRij(`select recovery_sent_at, (select count(*)::int from auth.sessions s where s.user_id = u.id) as sessies from auth.users u where u.id = ${q(userId)}`);
      const login = await inloggenOpDomein(gedeeldA.email, { origin: herkomstDomein, ipAanvraag: ip(23), ipInwisselen: ip(24) });
      verwacht(login.mail.text.includes(`${herkomstDomein}/portal/inloggen?aanvraag=${login.aanvraag}`), `link: ${login.mail.text}`);
      verwacht(login.mail.text.includes(`Vul de code alleen in op ${domein}.`), 'de mail zegt niet waar de code hoort');
      verwacht(/^\d{8}$/.test(login.code ?? ''), `code: ${login.code}`);
      const rij = sqlRij(`select token_hash, code_hash, token_sent_at, scope_organization_id, host from public.portal_login_requests where request_hash = ${q(sha256(login.aanvraag))}`);
      gelijk([rij?.token_hash, rij?.code_hash ? 'code' : null, rij?.token_sent_at, rij?.scope_organization_id, rij?.host],
        [null, 'code', null, w.orgId, domein], 'een code van ResoFly, geen token van Supabase');
      // Supabase Auth gaf geen token uit en maakte geen inlog.
      const naAuth = sqlRij(`select recovery_sent_at, (select count(*)::int from auth.sessions s where s.user_id = u.id) as sessies from auth.users u where u.id = ${q(userId)}`);
      gelijk([naAuth?.recovery_sent_at, naAuth?.sessies], [voorAuth?.recovery_sent_at, voorAuth?.sessies], 'Supabase Auth');
      verwacht((await gotrueVerify({ type: 'email', email: gedeeldA.email, token: login.code })).status >= 400, 'de code logt in bij Supabase');
      const sleutel = sqlRij(`select user_id, organization_id, host, expires_at > now() + interval '29 days' as maand from public.portal_tokens where token_hash = ${q(sha256(login.sleutel))}`);
      gelijk([sleutel?.user_id, sleutel?.organization_id, sleutel?.host, sleutel?.maand], [userId, w.orgId, domein, true], 'de sleutel');
      gelijk(await dossiersMetSleutel(login.sleutel, herkomstDomein), [gedeeldA.id], 'alleen het dossier bij deze organisatie');
      sleutelDomein = login.sleutel;
    });

    await stap('de sleutel werkt alleen vanaf zijn eigen domein', async () => {
      for (const herkomst of [herkomstA(), herkomstB(), ORIGIN]) {
        const res = geweigerd(await metSleutel(sleutelDomein, herkomst, { action: 'getPortalData' }), herkomst, [401]);
        gelijk(res?.code, 'session_unbound', `${herkomst}: code`);
      }
      geweigerd(await metSleutel('x'.repeat(43), herkomstDomein, { action: 'getPortalData' }), 'een verzonnen sleutel', [401]);
      geweigerd(await metSleutel('kort', herkomstDomein, { action: 'getPortalData' }), 'een rare sleutel', [401]);
      // En hij werkt nog, op zijn eigen domein.
      gelijk(await dossiersMetSleutel(sleutelDomein, herkomstDomein), [gedeeldA.id], 'het dossier');
    });

    await stap('de code uit de mail op een ander apparaat: een sleutel; een verkeerde code niet', async () => {
      const klant = await nieuweKlant(w, 'code-domein');
      const voor = mailsAan(klant.email).length;
      gelukt(await roep('portal-login', { origin: herkomstDomein, ip: ip(34), body: { action: 'requestLogin', email: klant.email, verifierHash: sha256(verifier()) } }), 'aanvragen');
      const code = nodig(codeUitMail(mailsAan(klant.email).slice(voor)[0]), 'code');
      const fout = code === '00000000' ? '11111111' : '00000000';
      const res = geweigerd(await roep('portal-login', { origin: herkomstDomein, ip: ip(34), body: { action: 'redeemCode', email: klant.email, code: fout } }), 'verkeerde code', [403]);
      verwacht(/klopt niet/.test(res?.error ?? ''), `melding: ${res?.error}`);
      // Niet op een ander adres: daar gaat inloggen anders.
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(34), body: { action: 'redeemCode', email: klant.email, code } }), 'op de naam bij ResoFly', [400]);
      const uit = gelukt(await roep('portal-login', { origin: herkomstDomein, ip: ip(34), body: { action: 'redeemCode', email: klant.email, code } }), 'goede code');
      gelijk(await dossiersMetSleutel(nodig(uit.portalToken, 'sleutel'), herkomstDomein), [klant.id], 'het dossier');
      geweigerd(await roep('portal-login', { origin: herkomstDomein, ip: ip(34), body: { action: 'redeemCode', email: klant.email, code } }), 'dezelfde code nog eens', [403]);
    });

    await stap('vijf verkeerde codes en de code is op; een onbekend adres krijgt hetzelfde antwoord', async () => {
      const klant = await nieuweKlant(w, 'code-raden');
      const voor = mailsAan(klant.email).length;
      gelukt(await roep('portal-login', { origin: herkomstDomein, ip: ip(35), body: { action: 'requestLogin', email: klant.email, verifierHash: sha256(verifier()) } }), 'aanvragen');
      const code = nodig(codeUitMail(mailsAan(klant.email).slice(voor)[0]), 'code');
      const fout = code === '00000000' ? '11111111' : '00000000';
      for (let i = 0; i < 5; i += 1) {
        geweigerd(await roep('portal-login', { origin: herkomstDomein, ip: ip(35), body: { action: 'redeemCode', email: klant.email, code: fout } }), `poging ${i + 1}`, [403]);
      }
      const daarna = geweigerd(await roep('portal-login', { origin: herkomstDomein, ip: ip(35), body: { action: 'redeemCode', email: klant.email, code } }), 'daarna de goede', [403]);
      const onbekend = geweigerd(await roep('portal-login', { origin: herkomstDomein, ip: ip(35), body: { action: 'redeemCode', email: `niemand.${RONDE}@klant.test`, code } }), 'onbekend adres', [403]);
      gelijk(daarna?.error, onbekend?.error, 'dezelfde melding');
    });

    await stap('veel verkeerde codes tegelijk: elke poging telt, en na vijf is de code op', async () => {
      const klant = await nieuweKlant(w, 'code-tegelijk');
      const voor = mailsAan(klant.email).length;
      gelukt(await roep('portal-login', { origin: herkomstDomein, ip: ip(43), body: { action: 'requestLogin', email: klant.email, verifierHash: sha256(verifier()) } }), 'aanvragen');
      const code = nodig(codeUitMail(mailsAan(klant.email).slice(voor)[0]), 'code');
      const fout = (n) => String((Number(code) + n) % 100_000_000).padStart(8, '0');
      const pogingen = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        roep('portal-login', { origin: herkomstDomein, ip: ip(43), body: { action: 'redeemCode', email: klant.email, code: fout(i + 1) } })));
      verwacht(pogingen.every((res) => res.status === 403), `antwoorden: ${pogingen.map((res) => res.status)}`);
      const rij = sqlRij(`select attempts, used_at is not null as op from public.portal_login_requests where email = ${q(klant.email)} order by created_at desc limit 1`);
      gelijk([rij?.attempts, rij?.op], [5, true], 'pogingen geteld');
      geweigerd(await roep('portal-login', { origin: herkomstDomein, ip: ip(43), body: { action: 'redeemCode', email: klant.email, code } }), 'daarna de goede', [403]);
    });

    await stap('een sleutel van het eigen domein ziet geen gedeelde bestanden van de andere organisatie', async () => {
      const doc = gelukt(await rest('documents?select=id', { method: 'POST', token: w2.medewerker.token, prefer: 'return=representation', body: {
        organization_id: w2.orgId, created_by: w2.medewerker.id, client_id: gedeeldB.id, title: `Contract ${RONDE}`, content: '<p>Alleen voor B</p>', document_type: 'procedure',
      } }), 'document bij B')[0];
      const gedeeld = gelukt(await roep('file-share', { token: w2.medewerker.token, body: {
        action: 'share', organizationId: w2.orgId, itemType: 'document', itemId: doc.id, recipients: [{ kind: 'client' }], canDownload: true,
      } }), 'delen').results?.[0]?.share;
      verwacht(gedeeld?.id, 'geen deling');
      const opAlgemeen = gelukt(await roep('client-portal', { origin: ORIGIN, token: algemeen.token, body: { action: 'getSharedFiles' } }), 'algemeen');
      verwacht(JSON.stringify(opAlgemeen).includes(gedeeld.id), 'de inlog op het algemene portaal ziet de deling niet');
      const opDomein = gelukt(await metSleutel(sleutelDomein, herkomstDomein, { action: 'getSharedFiles' }), 'eigen domein');
      verwacht(!JSON.stringify(opDomein).includes(gedeeld.id), 'de sleutel van het eigen domein ziet de deling van een ander');
      geweigerd(await metSleutel(sleutelDomein, herkomstDomein, { action: 'downloadSharedFile', shareId: gedeeld.id, itemType: 'document', itemId: doc.id }), 'openen', [403]);
    });

    await stap('op het eigen domein nooit een inlog bij Supabase: vastleggen, het portaal en de link van een andere aanvraag weigeren', async () => {
      // Een vastgelegde inlog van de naam bij ResoFly, die (hoe dan ook) op het eigen domein opduikt: daar is hij blootgesteld, dus weg ermee.
      const klant = await nieuweKlant(w, 'blootgesteld');
      const login = await inloggenMetLink(klant.email, { origin: herkomstA(), ipAanvraag: ip(36), ipInwisselen: ip(37) });
      geweigerd(await roep('client-portal', { origin: herkomstDomein, token: login.token, body: { action: 'getPortalData' } }), 'het portaal', [401]);
      verwacht(!(await sessieLeeft(login.token)), 'de inlog leeft nog');
      // Vastleggen vanaf het eigen domein: geweigerd, en de inlog is weg.
      const tweede = await nieuweKlant(w, 'vastleggen-domein');
      const token = await wachtwoordSessie(nodig(await accountVoor(tweede.email, herkomstA(), ip(38)), 'account'), tweede.email);
      geweigerd(await vastleggen(token, { origin: herkomstDomein, ip: ip(38), verifiers: [verifier()] }), 'vastleggen', [400]);
      verwacht(!(await sessieLeeft(token)), 'de inlog leeft nog');
      // De link van een aanvraag op de naam bij ResoFly (een token van Supabase) opent niet op het eigen domein.
      const derde = await nieuweKlant(w, 'link-elders');
      const geheim = verifier();
      const voor = mailsAan(derde.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(39), body: { action: 'requestLogin', email: derde.email, verifierHash: sha256(geheim) } }), 'aanvragen');
      const aanvraag = nodig(aanvraagUitMail(mailsAan(derde.email).slice(voor)[0]), 'aanvraagnummer');
      geweigerd(await roep('portal-login', { origin: herkomstDomein, ip: ip(39), body: { action: 'redeemLogin', request: aanvraag, verifiers: [geheim] } }), 'op het eigen domein', [410]);
      // En andersom: de link van het eigen domein opent niet op de naam bij ResoFly.
      const vierde = await nieuweKlant(w, 'link-domein');
      const geheim2 = verifier();
      const voor2 = mailsAan(vierde.email).length;
      gelukt(await roep('portal-login', { origin: herkomstDomein, ip: ip(40), body: { action: 'requestLogin', email: vierde.email, verifierHash: sha256(geheim2) } }), 'aanvragen');
      const aanvraag2 = nodig(aanvraagUitMail(mailsAan(vierde.email).slice(voor2)[0]), 'aanvraagnummer');
      geweigerd(await roep('portal-login', { origin: herkomstA(), ip: ip(40), body: { action: 'redeemLogin', request: aanvraag2, verifiers: [geheim2] } }), 'op de naam bij ResoFly', [410]);
    });

    await stap('uitzetten: de sleutel geeft niets meer en is weg', async () => {
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'setPortal', { domainId: domeinId, enabled: false }), 'uitzetten');
      gelijk(uit.domain?.portalEnabled, false, 'uit');
      verwacht(auditActies(w.orgId, 'client_domain').includes('portal_disabled'), 'geen logboekregel');
      clearClientOriginCache();
      // Een browser op het domein krijgt nu geen CORS meer; zonder Origin (niet uit een browser) komt hij bij de sleutel.
      geweigerd(await metSleutel(sleutelDomein, herkomstDomein, { action: 'getPortalData' }), 'vanaf het domein', [403]);
      const res = geweigerd(await metSleutel(sleutelDomein, null, { action: 'getPortalData' }), 'zonder Origin', [401]);
      gelijk(res?.code, 'session_unbound', 'code');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_tokens where token_hash = ${q(sha256(sleutelDomein))}`)?.n, 0, 'de sleutel is weg');
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht').portalUrl, herkomstA(), 'links weer naar de naam bij ResoFly');
      gelijk(gelukt(await opzoeken(domein), 'opzoeken').portalHost, adresA(), 'de Worker stuurt het portaal weer door');
      // De inloggen op de naam bij ResoFly en op het algemene portaal werken gewoon.
      gelukt(await roep('client-portal', { origin: herkomstA(), token: sessie1, body: { action: 'getPortalData' } }), 'naam bij ResoFly');
      gelukt(await roep('client-portal', { origin: ORIGIN, token: algemeen.token, body: { action: 'getPortalData' } }), 'algemeen');
    });

    await stap('weer aan, opnieuw inloggen, en uitloggen gooit de sleutel weg', async () => {
      gelukt(await domeinen(w.eigenaar, w.orgId, 'setPortal', { domainId: domeinId, enabled: true }), 'aanzetten');
      clearClientOriginCache();
      const eerst = (await inloggenOpDomein(gedeeldA.email, { origin: herkomstDomein, ipAanvraag: ip(25), ipInwisselen: ip(26) })).sleutel;
      gelijk(await dossiersMetSleutel(eerst, herkomstDomein), [gedeeldA.id], 'het dossier');
      gelukt(await roep('portal-login', { origin: herkomstDomein, ip: ip(26), headers: { 'x-portal-token': eerst }, body: { action: 'endPortalToken' } }), 'uitloggen');
      geweigerd(await metSleutel(eerst, herkomstDomein, { action: 'getPortalData' }), 'na uitloggen', [401]);
      sleutelDomein = (await inloggenOpDomein(gedeeldA.email, { origin: herkomstDomein, ipAanvraag: ip(27), ipInwisselen: ip(28) })).sleutel;
    });

    // ── Ontkoppelen en overnemen ────────────────────────────────────────────
    groep('Klantdomein: ontkoppelen en overnemen');

    await stap('ontkoppelen: twaalf maanden doorsturen; Cloudflare houdt het certificaat', async () => {
      const uit = gelukt(await domeinen(w.eigenaar, w.orgId, 'removeDomain', { domainId: domeinId }), 'ontkoppelen');
      gelijk(uit.removed, false, 'nog niet weg');
      verwacht(overEenJaar(uit.redirectUntil), `doorsturen tot ${uit.redirectUntil}`);
      gelijk(uit.clientUrl, herkomstA(), 'links weer naar de naam bij ResoFly');
      gelijk(domeinRij(domein)?.status, 'moved', 'status');
      verwacht([...cf.hostnames.values()].some((h) => h.hostname === domein), 'Cloudflare is het domein al kwijt');
      const overzicht = gelukt(await domeinen(w.eigenaar, w.orgId, 'overview'), 'overzicht');
      gelijk(overzicht.domain, null, 'geen eigen domein meer');
      gelijk(overzicht.moved.map((m) => m.hostname), [domein], 'verhuisd');
      gelijk(overzicht.portalUrl, herkomstA(), 'het portaal weer op de naam bij ResoFly');
    });

    await stap('na ontkoppelen geeft de sleutel van het eigen domein niets meer; de inlog op de naam bij ResoFly wel', async () => {
      clearClientOriginCache();
      geweigerd(await metSleutel(sleutelDomein, null, { action: 'getPortalData' }), 'sleutel van het eigen domein', [401]);
      gelijk(sqlRij(`select count(*)::int as n from public.portal_tokens where token_hash = ${q(sha256(sleutelDomein))}`)?.n, 0, 'de sleutel is weg');
      gelukt(await roep('client-portal', { origin: herkomstA(), token: sessie1, body: { action: 'getPortalData' } }), 'inlog van de naam bij ResoFly');
    });

    await stap('de Worker stuurt het oude domein door naar de naam bij ResoFly', async () => {
      gelijk(gelukt(await opzoeken(domein), 'opzoeken'), { ok: true, status: 'redirect', redirectHost: adresA() }, 'antwoord');
    });

    await stap('Cloudflare is het TXT-record vergeten zodra het domein actief is: het bewijs blijft bewaard', async () => {
      // Het echte Cloudflare stuurt ownership_verification niet meer mee bij een actieve hostnaam.
      const bijCf = [...cf.hostnames.values()].find((h) => h.hostname === domein);
      verwacht(bijCf, 'niet bij Cloudflare');
      const bewaard = domeinRij(domein)?.cf_state?.ownership;
      gelijk([bewaard?.name, bewaard?.value], [bijCf.ownership_verification.name, bijCf.ownership_verification.value], 'bewaard TXT-record');
    });

    await stap('doorsturen stoppen: ook bij Cloudflare weg, en de Worker kent het niet meer', async () => {
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'removeDomain', { domainId: domeinId }), 'stoppen').removed, true, 'weg');
      verwacht(![...cf.hostnames.values()].some((h) => h.hostname === domein), 'nog bij Cloudflare');
      gelijk(sqlRij(`select status from public.client_domains where id = ${q(domeinId)}`)?.status, 'removed', 'status');
      gelijk(gelukt(await opzoeken(domein), 'opzoeken').status, 'unknown', 'Worker');
      verwacht(auditActies(w.orgId, 'client_domain').includes('moved') && auditActies(w.orgId, 'client_domain').includes('removed'), `logboek: ${auditActies(w.orgId, 'client_domain')}`);
    });

    await stap('een vergeten record: een andere organisatie kan het domein koppelen, maar nooit activeren', async () => {
      // De eerste organisatie haalde het domein weg; het CNAME-record (en haar oude
      // TXT-record) staan nog bij haar domeinbeheerder en wijzen naar ResoFly.
      verwacht((dns.get(domein) ?? []).includes(CNAME_DOEL), 'het CNAME-record staat er niet meer');
      const uit = gelukt(await domeinen(w2.eigenaar, w2.orgId, 'addDomain', { hostname: domein }), 'koppelen door een ander');
      // Cloudflare ziet het CNAME-record en keurt de hostnaam en het certificaat goed.
      zetCf(domein, { status: 'active', ssl: 'active' });
      const na = gelukt(await domeinen(w2.eigenaar, w2.orgId, 'refreshDomain', { domainId: uit.domain.id }), 'nalopen');
      gelijk(na.domain.status, 'pending_dns', 'niet actief zonder het TXT-record van deze koppeling');
      verwacht((na.domain.problem ?? '').includes('TXT-record'), `melding: ${na.domain.problem}`);
      gelijk(gelukt(await opzoeken(domein), 'opzoeken').status, 'pending', 'de Worker toont niets');
      clearClientOriginCache();
      geweigerd(await roep('invoice-public', { origin: `https://${domein}`, body: { action: 'getInvoice', token: factuur.token } }), 'CORS voor het overgenomen adres', [403]);
      gelijk(gelukt(await domeinen(w2.eigenaar, w2.orgId, 'overview'), 'overzicht').clientUrl, herkomstB(), 'links van de ander niet naar dat domein');
      // Ook de cron maakt hem niet actief.
      gelukt(await nalopen(), 'nalopen');
      gelijk(sqlRij(`select status from public.client_domains where id = ${q(uit.domain.id)}`)?.status, 'pending_dns', 'na de nachtelijke ronde');
      gelukt(await domeinen(w2.eigenaar, w2.orgId, 'removeDomain', { domainId: uit.domain.id }), 'opruimen');
    });

    const overname = `klant.overname-${RONDE}.nl`;
    await stap('een koppeling die zeven dagen nooit actief werd, mag een ander overnemen', async () => {
      const eerst = gelukt(await domeinen(w2.eigenaar, w2.orgId, 'addDomain', { hostname: overname }), 'koppelen door de eerste');
      geweigerd(await domeinen(w.eigenaar, w.orgId, 'addDomain', { hostname: overname }), 'meteen overnemen', [409]);
      sql(`update public.client_domains set created_at = now() - interval '8 days' where id = ${q(eerst.domain.id)}`);
      const oudId = [...cf.hostnames.values()].find((h) => h.hostname === overname)?.id;
      const tweede = gelukt(await domeinen(w.eigenaar, w.orgId, 'addDomain', { hostname: overname }), 'overnemen');
      gelijk(sqlRij(`select status from public.client_domains where id = ${q(eerst.domain.id)}`)?.status, 'removed', 'de oude koppeling');
      verwacht(!cf.hostnames.has(oudId), 'de oude hostnaam staat nog bij Cloudflare');
      verwacht(auditActies(w2.orgId, 'client_domain').includes('taken_over'), 'geen logboekregel bij de eerste');
      gelijk(gelukt(await domeinen(w.eigenaar, w.orgId, 'removeDomain', { domainId: tweede.domain.id }), 'opruimen').removed, true, 'nooit actief: meteen weg');
    });

    await stap('een domein dat ResoFly uitzette, kan de organisatie niet weghalen of aanzetten', async () => {
      const blok = `blok.uit-${RONDE}.nl`;
      const uit = gelukt(await domeinen(w2.eigenaar, w2.orgId, 'addDomain', { hostname: blok }), 'koppelen');
      sql(`update public.client_domains set status = 'blocked' where id = ${q(uit.domain.id)}`);
      zetCf(blok, { status: 'active', ssl: 'active' });
      geweigerd(await domeinen(w2.eigenaar, w2.orgId, 'removeDomain', { domainId: uit.domain.id }), 'weghalen', [409]);
      gelijk(gelukt(await domeinen(w2.eigenaar, w2.orgId, 'refreshDomain', { domainId: uit.domain.id }), 'nalopen').domain.status, 'blocked', 'blijft uit');
      gelijk(gelukt(await opzoeken(blok), 'opzoeken').status, 'blocked', 'Worker');
    });

    // ── 9. De nachtelijke ronde ─────────────────────────────────────────────
    groep('Klantdomein: de nachtelijke ronde');

    await stap('zonder of met een fout geheim: geen toegang', async () => {
      geweigerd(await nalopen(null), 'zonder geheim', [401]);
      geweigerd(await nalopen('fout'), 'fout geheim', [401]);
    });

    await stap('ruimt oude namen, oude inlogaanvragen en inloggen die Supabase niet meer kent op', async () => {
      const oud = wisselNamen[0];
      sql(`update public.client_subdomains set redirect_until = now() - interval '1 day' where name = ${q(oud)}`);
      sql(`update public.portal_login_requests set expires_at = now() - interval '2 days' where request_hash = ${q(sha256(aanvraag1))}`);
      // Een inlog van eergisteren die bij Supabase al weg is, en een die er nog is.
      const weg = randomUUID();
      sql(`insert into public.portal_sessions (session_id, user_id, organization_id, host, created_at)
           values (${q(weg)}, ${q(w.portaalA.id)}, ${q(w.orgId)}, ${q(adresA())}, now() - interval '2 days')`);
      const levend = sqlRij(`select bound_session_id from public.portal_login_requests where request_hash = ${q(sha256(aanvraag1))}`)?.bound_session_id;
      sql(`update public.portal_sessions set created_at = now() - interval '2 days' where session_id = ${q(nodig(levend, 'vastgelegde inlog'))}`);
      // En een verlopen sleutel van een eigen domein.
      const oudeSleutel = sha256(`oud-${RONDE}`);
      sql(`insert into public.portal_tokens (token_hash, user_id, organization_id, host, expires_at, last_used_at)
           values (${q(oudeSleutel)}, ${q(w.portaalA.id)}, ${q(w.orgId)}, ${q(domein)}, now() - interval '2 days', now() - interval '32 days')`);
      const uit = gelukt(await nalopen(), 'nalopen');
      verwacht(uit.names >= 1 && uit.logins >= 1 && uit.sessions >= 2, `resultaat: ${JSON.stringify(uit)}`);
      gelijk(sqlRij(`select count(*)::int as n from public.portal_tokens where token_hash = ${q(oudeSleutel)}`)?.n, 0, 'de verlopen sleutel');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_sessions where session_id = ${q(weg)}`)?.n, 0, 'de inlog die weg is');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_sessions where session_id = ${q(levend)}`)?.n, 1, 'de inlog die er nog is');
      gelukt(await roep('client-portal', { origin: herkomstA(), token: sessie1, body: { action: 'getPortalData' } }), 'die werkt nog');
      gelijk(sqlRij(`select count(*)::int as n from public.client_subdomains where name = ${q(oud)}`)?.n, 0, 'oude naam');
      gelijk(gelukt(await check(w.eigenaar, oud), 'controle').status, 'available', 'weer vrij');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_login_requests where request_hash = ${q(sha256(aanvraag1))}`)?.n, 0, 'oude aanvraag');
    });

    // ── 10. Een adres dat ResoFly uitzette ──────────────────────────────────
    groep('Klantdomein: een uitgezet webadres');

    await stap('een uitgezette organisatie kan geen nieuwe naam kiezen; de Worker toont niets', async () => {
      const naam = actieveNaam(w2.orgId);
      sql(`update public.client_subdomains set status = 'blocked' where organization_id = ${q(w2.orgId)} and status = 'active'`);
      const res = geweigerd(await claim(w2.eigenaar, w2.orgId, webadresNaam('na-blokkade')), 'nieuwe naam');
      verwacht(/uitgezet/.test(JSON.stringify(res)), `melding: ${JSON.stringify(res)}`);
      gelijk(gelukt(await opzoeken(`${naam}.${BASE}`), 'opzoeken').status, 'blocked', 'Worker');
      gelijk(gelukt(await domeinen(w2.eigenaar, w2.orgId, 'overview'), 'overzicht').blocked, true, 'overzicht');
      gelijk(gelukt(await check(w.eigenaar, naam), 'controle').status, 'taken', 'een ander kan hem niet nemen');
    });
  } finally {
    if (vroegerLive === undefined) delete process.env.CLIENT_DOMAINS_LIVE;
    else process.env.CLIENT_DOMAINS_LIVE = vroegerLive;
    clearClientOriginCache();
  }
}
