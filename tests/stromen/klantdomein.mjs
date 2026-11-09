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
//   7. de nachtelijke ronde (cron) met zijn geheim;
//   8. een adres dat ResoFly uitzette.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { API_URL, ANON_KEY, CLIENT_DOMAINS_CRON_GEHEIM, CLIENT_DOMAINS_WERKER_GEHEIM, CLOUDFLARE_TOKEN, CLOUDFLARE_ZONE, ORIGIN, PUBLIEK } from './omgeving.mjs';
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
  const m = String(mail?.text ?? '').match(/Vul deze code in op het inlogscherm: (\d{6,10})/);
  return m ? m[1] : null;
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
      verwacht(!`${mail.html} ${mail.text}`.includes(browser1), 'het geheim van de browser staat in de mail');
      const rij = sqlRij(`select organization_id, email, verifier_hash, used_at from public.portal_login_requests where request_hash = ${q(sha256(aanvraag1))}`);
      gelijk([rij?.organization_id, rij?.email, rij?.verifier_hash, rij?.used_at], [w.orgId, w.klantA.email, sha256(browser1), null], 'aanvraag');
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

    await stap('de link op het adres van een andere organisatie: alsof hij niet bestaat', async () => {
      geweigerd(await roep('portal-login', { origin: herkomstB(), ip: ip(13), body: { action: 'redeemLogin', request: aanvraag1, verifiers: [browser1] } }), 'ander adres', [410]);
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

    await stap('met die sessie opent het portaal de eigen gegevens', async () => {
      const uit = gelukt(await roep('client-portal', { origin: herkomstA(), token: sessie1, body: { action: 'getPortalData' } }), 'portaal');
      verwacht(JSON.stringify(uit).includes(w.klantA.id), 'de klant staat er niet in');
      verwacht(!JSON.stringify(uit).includes(w2.klantA.id), 'een klant van een ander staat erin');
    });

    await stap('inloggen en het portaal vanaf het eigen domein: geen CORS (daar hoort geen sessie)', async () => {
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

    await stap('de code uit de mail werkt op een ander apparaat', async () => {
      const voor = mailsAan(w.klantB.email).length;
      gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(14), body: { action: 'requestLogin', email: w.klantB.email, verifierHash: sha256(verifier()) } }), 'aanvragen');
      const mail = mailsAan(w.klantB.email).slice(voor)[0];
      const code = nodig(codeUitMail(mail), 'code');
      const fout = await gotrueVerify({ type: 'email', email: w.klantB.email, token: code === '000000' ? '111111' : '000000' });
      verwacht(fout.status >= 400, `een verkeerde code werd aangenomen: ${fout.status}`);
      const login = await gotrueVerify({ type: 'email', email: w.klantB.email, token: code });
      gelijk(login.status, 200, `GoTrue: ${login.tekst.slice(0, 200)}`);
      gelijk(login.json?.user?.email, w.klantB.email, 'ingelogd als');
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

    await stap('een oude app zonder geheim: het oude gedrag (flow otp), en wij mailen niet', async () => {
      const voor = post.mails.length;
      const uit = gelukt(await roep('portal-login', { origin: ORIGIN, ip: ip(18), body: { action: 'requestLogin', email: w.klantA.email } }), 'aanvragen');
      gelijk(uit.flow, 'otp', 'flow');
      gelijk(post.mails.length, voor, 'mails');
    });

    await stap('de huisstijl van het inlogscherm volgt het klantadres', async () => {
      const uit = gelukt(await roep('portal-login', { origin: herkomstA(), ip: ip(19), body: { action: 'getBranding' } }), 'huisstijl');
      verwacht(uit.branding?.companyName, `geen naam: ${JSON.stringify(uit.branding)?.slice(0, 200)}`);
      const algemeen = gelukt(await roep('portal-login', { origin: ORIGIN, ip: ip(19), body: { action: 'getBranding' } }), 'algemeen');
      gelijk(algemeen.branding, null, 'op het algemene adres zonder sleutel');
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

    // ── 7. De nachtelijke ronde ─────────────────────────────────────────────
    groep('Klantdomein: de nachtelijke ronde');

    await stap('zonder of met een fout geheim: geen toegang', async () => {
      geweigerd(await nalopen(null), 'zonder geheim', [401]);
      geweigerd(await nalopen('fout'), 'fout geheim', [401]);
    });

    await stap('ruimt oude namen en oude inlogaanvragen op', async () => {
      const oud = wisselNamen[0];
      sql(`update public.client_subdomains set redirect_until = now() - interval '1 day' where name = ${q(oud)}`);
      sql(`update public.portal_login_requests set expires_at = now() - interval '2 days' where request_hash = ${q(sha256(aanvraag1))}`);
      const uit = gelukt(await nalopen(), 'nalopen');
      verwacht(uit.names >= 1 && uit.logins >= 1, `resultaat: ${JSON.stringify(uit)}`);
      gelijk(sqlRij(`select count(*)::int as n from public.client_subdomains where name = ${q(oud)}`)?.n, 0, 'oude naam');
      gelijk(gelukt(await check(w.eigenaar, oud), 'controle').status, 'available', 'weer vrij');
      gelijk(sqlRij(`select count(*)::int as n from public.portal_login_requests where request_hash = ${q(sha256(aanvraag1))}`)?.n, 0, 'oude aanvraag');
    });

    // ── 8. Een adres dat ResoFly uitzette ───────────────────────────────────
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
