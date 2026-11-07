#!/usr/bin/env node
/*
 * UI-test — de knoppen en formulieren van offertes, facturen, herinneringen en
 * contracten in Chromium, tegen de echte backend.
 *
 *   node --enable-source-maps --import ./tests/stromen/register.mjs tests/stromen/ui.mjs [offerte] [factuur] [intrekken] [contract] [rollen] [agenda] [mollie] [documenten] [bank]
 *
 *   --schermafdrukken=<map>   waar schermafdrukken van mislukte stappen heen gaan
 *                             (standaard <tmp>/stromen-ui; ook STROMEN_UI_SCHERMAFDRUKKEN)
 *   --zichtbaar               Chromium met venster, om mee te kijken
 *
 * Waarom: run.mjs toetst de functies en de database rechtstreeks. Of een knop
 * in het scherm ook díe functie aanroept, met die gegevens, en of de gebruiker
 * daarna de juiste uitkomst ziet, zie je pas als een browser echt klikt. Hier
 * draait de app (Vite) tegen de lokale stack; de edge functions draaien in dit
 * proces (ui-server.mjs), met Resend, Mollie en de media-worker als nep
 * (nepdiensten.mjs). Een klant opent de link uit de vastgelegde mail in een
 * eigen browsercontext zonder sessie.
 *
 * Elke stap controleert daarnaast: geen JavaScript-fout, geen foutmelding of
 * "laden…" die blijft staan, en geen mislukte aanroep naar de backend die de
 * stap niet verwachtte. Mislukt een stap, dan komt er een schermafdruk.
 */
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { API_URL, ANON_KEY, SERVICE_KEY } from './omgeving.mjs';
import { installeer, mailsAan, post } from './nepdiensten.mjs';
import { roep, roepRequest } from './functies.mjs';
import { rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, groep, samenvatting, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS } from './wereld.mjs';
import { startUiServer } from './ui-server.mjs';
import { GOOGLE_ALLES, account, geefCode } from './nep-agenda.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argumenten = process.argv.slice(2);
const opties = Object.fromEntries(argumenten.filter((a) => a.startsWith('--')).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return [m[1], m[2] ?? 'true'];
}));
const ALLE = ['offerte', 'factuur', 'intrekken', 'contract', 'rollen', 'agenda', 'mollie', 'documenten', 'bank'];
const gekozen = argumenten.filter((a) => !a.startsWith('-'));
for (const naam of gekozen) {
  if (!ALLE.includes(naam)) throw new Error(`Onbekend scenario "${naam}". Kies uit: ${ALLE.join(', ')}`);
}
const SCENARIOS = gekozen.length ? gekozen : ALLE;
const SCHERMAFDRUKKEN = opties.schermafdrukken || process.env.STROMEN_UI_SCHERMAFDRUKKEN || path.join(os.tmpdir(), 'stromen-ui');
mkdirSync(SCHERMAFDRUKKEN, { recursive: true });

const TOTAAL = '€ 173,63';

// ── Kleine hulpjes ─────────────────────────────────────────────────────────

/** Tekst zoals een mens hem leest: elke witruimte (ook de harde spatie na €) wordt één spatie. */
const tekst = (waarde) => String(waarde ?? '').replace(/\s+/g, ' ').trim();
const q = (waarde) => `'${String(waarde).replace(/'/g, "''")}'`;
const regexVan = (woorden) => new RegExp(`^${String(woorden).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const slaap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** De datum van vandaag in Nederland (JJJJ-MM-DD), plus `dagen`. */
function datum(dagen = 0) {
  const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const d = new Date(`${vandaag}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dagen);
  return d.toISOString().slice(0, 10);
}

async function wachtTot(voorwaarde, { timeout = 15000, melding = 'het verwachte gebeurde niet' } = {}) {
  const eind = Date.now() + timeout;
  let laatste = null;
  while (Date.now() < eind) {
    try {
      const uitkomst = await voorwaarde();
      if (uitkomst) return uitkomst;
    } catch (error) {
      laatste = error;
    }
    await slaap(150);
  }
  throw new Error(`${melding} (na ${timeout} ms)${laatste ? `: ${laatste.message}` : ''}`);
}

/** De mailtekst zonder opmaak: onderwerp, platte tekst en de HTML zonder tags. */
function mailtekst(mail) {
  const html = String(mail.html ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&euro;|&#8364;/g, '€').replace(/&amp;/g, '&');
  return tekst(`${mail.subject} ${mail.text} ${html}`);
}

/** De publieke link uit een mail (offerte, factuur of contract). */
function linkUit(mail, soort) {
  const m = `${mail.html} ${mail.text}`.match(new RegExp(`https?://[^\\s"'<>]+/${soort}/[A-Za-z0-9_%-]{20,}`));
  return m ? m[0] : null;
}

// ── De omgeving: server, Vite, Chromium ─────────────────────────────────────

installeer({ functie: roepRequest });
const server = await startUiServer();

// De app leest het Supabase-adres uit import.meta.env. Bestaande process.env-
// waarden gaan in Vite vóór .env-bestanden, dus zo praat de app met ónze server.
process.env.VITE_SUPABASE_URL = server.url;
process.env.VITE_SUPABASE_ANON_KEY = ANON_KEY;
process.env.VITE_R2_WORKER_URL = `${server.url}/__media`;

const vite = await createServer({
  configFile: path.join(ROOT, 'vite.config.ts'),
  root: ROOT,
  logLevel: 'warn',
  // Een eigen cachemap: draaien andere tests tegelijk een Vite-server, dan
  // schrijven die niet door onze voorgebundelde pakketten heen.
  cacheDir: path.join(ROOT, 'node_modules', '.vite-stromen-ui'),
  // pdfFonts.ts laadt fontkit pas bij de eerste PDF-voorvertoning (import()).
  // Vindt Vite een pakket pas tijdens het draaien, dan bundelt hij opnieuw en
  // herlaadt hij de pagina; dat mag niet midden in een stap gebeuren. Om
  // dezelfde reden geen HMR: wijzigt iemand tijdens de run iets in src/, dan
  // blijft de pagina staan.
  optimizeDeps: { include: ['@pdf-lib/fontkit'] },
  server: { port: 5310, strictPort: false, host: '127.0.0.1', hmr: false },
});
await vite.listen();
const APP = new URL(vite.resolvedUrls.local[0]).origin;

// De functies controleren de herkomst van de browser en zetten het adres van de
// app in de mails. Deze test draait op een eigen poort; die komt erbij (de
// gewone ORIGIN van omgeving.mjs blijft geldig voor aanroepen vanuit Node).
// Dit moet vóór de eerste functieaanroep: de functies lezen het bij het laden.
for (const sleutel of ['QUOTE_ALLOWED_ORIGINS', 'QUOTE_PUBLIC_ALLOWED_ORIGINS', 'CONTRACT_ALLOWED_ORIGINS', 'CONTRACT_PUBLIC_ALLOWED_ORIGINS',
  'INVOICE_ALLOWED_ORIGINS', 'INVOICE_PUBLIC_ALLOWED_ORIGINS', 'CLIENT_PORTAL_ALLOWED_ORIGINS', 'MAIL_ALLOWED_ORIGINS']) {
  process.env[sleutel] = [process.env[sleutel], APP].filter(Boolean).join(',');
}
for (const sleutel of ['APP_PUBLIC_URL', 'QUOTE_PUBLIC_BASE_URL', 'INVOICE_PUBLIC_BASE_URL', 'CONTRACT_PUBLIC_BASE_URL', 'CLIENT_PORTAL_BASE_URL']) {
  process.env[sleutel] = APP;
}
// De agendakoppeling: de app mag het terugkeeradres zijn, en (nep-)Google
// stuurt de browser terug naar de callback op déze server, niet de gateway.
process.env.CALENDAR_ALLOWED_RETURN_ORIGINS = [process.env.CALENDAR_ALLOWED_RETURN_ORIGINS, APP].filter(Boolean).join(',');
process.env.CALENDAR_REDIRECT_URL = `${server.url}/functions/v1/calendar-integrations`;

async function startChromium() {
  const pad = process.env.RESOFLY_CHROMIUM;
  const basis = { headless: !opties.zichtbaar };
  try {
    return await chromium.launch({ ...basis, executablePath: pad || undefined });
  } catch (error) {
    // In een cloudsessie vindt de Playwright-versie van de repo zijn eigen browser niet (zie CLAUDE.md).
    if (!pad && existsSync('/opt/pw-browsers/chromium')) return chromium.launch({ ...basis, executablePath: '/opt/pw-browsers/chromium' });
    throw error;
  }
}
const browser = await startChromium();

// supabase-js bewaart de sessie onder sb-<eerste deel van de hostnaam>-auth-token.
const SESSIESLEUTEL = `sb-${new URL(server.url).hostname.split('.')[0]}-auth-token`;

// ── Schermen: een browsercontext per persoon ────────────────────────────────

/** Alle open schermen; een stap controleert ze allemaal op fouten. */
const schermen = new Set();
let afdrukTeller = 0;

/**
 * Een echte sessie van GoTrue, mét refresh token: een magische link zoals het
 * inlogscherm hem mailt (admin generate_link), en die inwisselen (verify).
 * Niet via een nieuw wachtwoord: GoTrue trekt bij een wachtwoordwissel alle
 * sessies in, ook het token van wereld.mjs waarmee deze test zelf functies
 * aanroept — die gaven daarna "Niet ingelogd of ongeldig sessietoken".
 */
async function sessieVan(gebruiker) {
  const link = await fetch(`${API_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email: gebruiker.email }),
  });
  const gegevens = await link.json();
  if (!link.ok || !gegevens.hashed_token) throw new Error(`inloglink voor ${gebruiker.email}: ${link.status} ${JSON.stringify(gegevens).slice(0, 300)}`);
  const verify = await fetch(`${API_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gegevens.hashed_token }),
  });
  const sessie = await verify.json();
  if (!verify.ok || !sessie.refresh_token) throw new Error(`inloggen ${gebruiker.email}: ${verify.status} ${JSON.stringify(sessie).slice(0, 300)}`);
  return sessie;
}

function volg(page, naam, context) {
  const scherm = { naam, page, context, fouten: [], console: [], dialogen: [], plan: [] };
  page.on('pageerror', (error) => scherm.fouten.push(String(error?.stack || error?.message || error)));
  page.on('console', (bericht) => {
    if (bericht.type() === 'error') scherm.console.push({ tekst: bericht.text(), url: bericht.location()?.url ?? '' });
  });
  // confirm() en prompt(): wat de stap vooraf plande (scherm.plan), anders
  // bevestigen met de voorgestelde waarde. Alles wordt bewaard, zodat een stap
  // kan nagaan wát er gevraagd werd.
  page.on('dialog', async (dialoog) => {
    const keuze = scherm.plan.shift();
    scherm.dialogen.push({ type: dialoog.type(), tekst: dialoog.message(), standaard: dialoog.defaultValue(), keuze: keuze ?? null });
    try {
      if (keuze?.weiger) await dialoog.dismiss();
      else if (dialoog.type() === 'prompt') await dialoog.accept(keuze?.antwoord ?? dialoog.defaultValue());
      else await dialoog.accept();
    } catch { /* de pagina was al weg */ }
  });
  schermen.add(scherm);
  return scherm;
}

/**
 * De werkruimte als `gebruiker`, ingelogd, met de zijbalk vast open.
 * `tijdelijk`: het scherm gaat dicht na de stap (ná een eventuele schermafdruk).
 */
async function openWerkruimte(gebruiker, naam, organisatieId, { tijdelijk = false } = {}) {
  const sessie = await sessieVan(gebruiker);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  // Het werkblad begint op Offertes: daar beginnen de meeste stromen van deze
  // test. (calendar-integrations laadt hier sinds 6 november ook; zie loader.mjs.)
  const items = {
    [SESSIESLEUTEL]: JSON.stringify(sessie),
    'brandcore.activeOrganizationId': organisatieId,
    [`brandcore.tabs.${organisatieId}`]: JSON.stringify({ tabs: [{ page: 'quotes', projectId: null, clientId: null, statsReportId: null, galleryId: null }], activeIndex: 0 }),
    'brandcore.sidebarPinned': '1',
  };
  // Alleen bij het eerste laden, en alleen in het hoofdvenster: daarna ververst
  // supabase-js het token zelf, en een herhaald init-script zou de nieuwe sessie
  // weer door de oude vervangen. In een iframe van de PDF-voorvertoning (blob:)
  // is localStorage er niet.
  await context.addInitScript(`(() => {
    try {
      if (window.top !== window || !window.localStorage) return;
      if (localStorage.getItem('stromen.ui.gezet')) return;
      const items = ${JSON.stringify(items)};
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, v);
      localStorage.setItem('stromen.ui.gezet', '1');
    } catch { /* geen opslag in dit venster */ }
  })();`);
  const page = await context.newPage();
  const scherm = volg(page, naam, context);
  scherm.tijdelijk = tijdelijk;
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.locator('.app .sidebar-nav').first().waitFor({ timeout: 60000 });
  await rustig(scherm);
  return scherm;
}

/** Een link uit een mail, als klant: een eigen browser zonder sessie. */
async function openAlsKlant(link, naam = 'klant') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const scherm = volg(page, naam, context);
  scherm.tijdelijk = true;
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await rustig(scherm);
  await wachtTot(async () => !(await page.getByText(/laden…/i).first().isVisible().catch(() => false)), { melding: 'de publieke pagina bleef laden' });
  return scherm;
}

async function sluit(scherm) {
  if (!scherm || !schermen.has(scherm)) return;
  schermen.delete(scherm);
  await scherm.context.close().catch(() => undefined);
}

/**
 * Wacht tot de app klaar is: geen verzoek meer onderweg naar de backend, geen
 * verzendvenster, de knop Ververs niet meer op "Laden…". Op de netwerkstilte
 * van Playwright kun je hier niet wachten: de app probeert telkens een realtime-
 * websocket die in de lokale stack niet draait.
 */
async function rustig(scherm, { max = 30000 } = {}) {
  const begin = Date.now();
  let stilSinds = null;
  while (Date.now() - begin < max) {
    const overlay = await scherm.page.locator('.send-overlay').isVisible().catch(() => false);
    const knop = await scherm.page.locator('.topbar .topbar-actions button', { hasText: 'Laden…' }).isVisible().catch(() => false);
    if (server.lopend() === 0 && !overlay && !knop) {
      stilSinds ??= Date.now();
      if (Date.now() - stilSinds >= 400) return;
    } else {
      stilSinds = null;
    }
    await slaap(100);
  }
  throw new Error(`het scherm van ${scherm.naam} werd niet rustig binnen ${max} ms (verzoeken onderweg: ${server.lopend()})`);
}

/** Zichtbare foutmeldingen en dingen die nog "laden" (in de app én op de publieke pagina's). */
async function schermstand(page) {
  return page.evaluate(() => {
    const zichtbaar = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden]');
    };
    const fouten = [...document.querySelectorAll('.error, .public-quote-alert, .refund-error, .document-export-error')]
      .filter(zichtbaar).map((el) => el.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const laden = [];
    const loper = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (loper.nextNode()) {
      const t = loper.currentNode.textContent.replace(/\s+/g, ' ').trim();
      if (/(laden|bezig|versturen|wordt verstuurd)(…|\.\.\.)/i.test(t) && loper.currentNode.parentElement && zichtbaar(loper.currentNode.parentElement)) laden.push(t);
    }
    for (const el of document.querySelectorAll('[aria-busy="true"], .send-overlay')) if (zichtbaar(el)) laden.push(el.getAttribute('aria-label') || 'bezig-indicator');
    return { fouten, laden };
  });
}

// Wat in deze omgeving altijd misgaat en niets met de stap te maken heeft.
// Elke regel zegt waarom.
const RUIS_CONSOLE = [
  // Realtime draait niet in de lokale stack (`supabase start -x realtime`); de
  // app probeert de websocket telkens opnieuw.
  /WebSocket connection to '[^']*\/realtime\/v1\/websocket/,
  // De browser meldt elk HTTP-antwoord ≥ 400 nog eens in de console. Die
  // antwoorden controleren we preciezer op de server (zie RUIS_VERKEER en
  // `toegestaan` per stap), met de naam van de functie of RPC erbij.
  /^Failed to load resource: the server responded with a status of \d+/,
];
const RUIS_VERKEER = [
  // De app vraagt bij elke start het abonnementsoverzicht op, ook voor wie
  // geen owner/admin is; de database weigert dat terecht met 403 en de app
  // vangt het af (console.warn). Hoort niet bij offertes of facturen.
  { rpc: 'organization_billing_overview', status: 403 },
  // De contractpagina wekt alvast de Word-editor (Collabora) via de media-
  // worker (warmupOfficeEditor, fouten bewust stil). Die draait hier niet; de
  // rich-text contracten van deze test hebben hem niet nodig.
  { soort: 'media', pad: '/__media/office/warmup' },
];

function past(regel, patroon) {
  return Object.entries(patroon).every(([sleutel, waarde]) => (waarde instanceof RegExp ? waarde.test(String(regel[sleutel] ?? '')) : regel[sleutel] === waarde));
}

function beschrijf(regel) {
  const wat = regel.functie ? `functie ${regel.functie}${regel.actie ? `/${regel.actie}` : ''}` : regel.rpc ? `rpc ${regel.rpc}` : regel.tabel ? `${regel.methode} ${regel.tabel}` : `${regel.methode} ${regel.pad}`;
  return `${wat} → ${regel.status}${regel.antwoord ? ` ${regel.antwoord.slice(0, 300)}` : ''}${regel.fout ? ` ${regel.fout.split('\n')[0]}` : ''}`;
}

async function schermafdruk(naam, scherm) {
  afdrukTeller += 1;
  const bestand = path.join(SCHERMAFDRUKKEN, `${String(afdrukTeller).padStart(2, '0')}-${naam.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}-${scherm.naam}.png`);
  await scherm.page.screenshot({ path: bestand, fullPage: false }).catch(() => undefined);
  return bestand;
}

/** Wat een stap ziet maar niet beoordeelt; komt onder de regel van die stap. */
const noten = [];

/**
 * Een stap in de browser. Naast wat `fn` zelf controleert: geen nieuwe
 * JavaScript-fout, geen foutmelding in beeld (tenzij `foutmelding` hem
 * verwacht), niets dat blijft laden, en geen mislukt antwoord van de backend
 * behalve wat `toegestaan` noemt. Mislukt de stap: schermafdrukken van alle
 * open schermen, en de tijdelijke schermen (een klant) gaan dicht.
 */
function uiStap(naam, fn, { toegestaan = [], foutmelding = null } = {}) {
  return stap(naam, async () => {
    const begin = new Map([...schermen].map((s) => [s, { fouten: s.fouten.length, console: s.console.length }]));
    const verkeerBegin = server.verkeer.length;
    const betrokken = () => [...schermen];
    try {
      const uitkomst = await fn();
      const problemen = [];
      for (const s of betrokken()) {
        await rustig(s).catch((error) => problemen.push(error.message));
        const b = begin.get(s) ?? { fouten: 0, console: 0 };
        for (const f of s.fouten.slice(b.fouten)) problemen.push(`JavaScript-fout bij ${s.naam}: ${f.split('\n').slice(0, 3).join(' | ')}`);
        for (const c of s.console.slice(b.console)) {
          if (!RUIS_CONSOLE.some((r) => r.test(c.tekst))) problemen.push(`console.error bij ${s.naam}: ${c.tekst.slice(0, 300)}`);
        }
        // Iets mag even laden (de PDF-voorvertoning bouwt de browser zelf op,
        // zonder netwerk); pas wat na 15 seconden nog laadt, blijft hangen.
        let stand = await schermstand(s.page).catch(() => ({ fouten: [], laden: [] }));
        for (const eind = Date.now() + 15000; stand.laden.length && Date.now() < eind;) {
          await slaap(250);
          stand = await schermstand(s.page).catch(() => ({ fouten: [], laden: [] }));
        }
        for (const f of stand.fouten) if (!(foutmelding && foutmelding.test(f))) problemen.push(`foutmelding in beeld bij ${s.naam}: "${f.slice(0, 300)}"`);
        for (const l of stand.laden) problemen.push(`blijft hangen bij ${s.naam}: "${l}"`);
      }
      for (const regel of server.verkeer.slice(verkeerBegin)) {
        if (regel.status < 400 || regel.soort === 'websocket') continue;
        if (RUIS_VERKEER.some((p) => past(regel, p)) || toegestaan.some((p) => past(regel, p))) continue;
        problemen.push(`mislukte aanroep: ${beschrijf(regel)}`);
      }
      if (problemen.length) throw new Error(problemen.join('\n'));
      return uitkomst;
    } catch (error) {
      const afdrukken = [];
      for (const s of betrokken()) afdrukken.push(await schermafdruk(naam, s));
      if (afdrukken.length) error.message = `${error.message}\nschermafdruk: ${afdrukken.join(', ')}`;
      throw error;
    } finally {
      for (const s of betrokken()) if (s.tijdelijk) await sluit(s);
    }
  }).then((uitkomst) => {
    for (const noot of noten.splice(0)) console.log(`        noot: ${noot}`);
    return uitkomst;
  });
}

/** Wat de server zag sinds `sinds` (een index in server.verkeer). */
function aanroepen(sinds, patroon) {
  return server.verkeer.slice(sinds).filter((regel) => past(regel, patroon));
}

function verwachtAanroep(sinds, patroon, melding) {
  const gevonden = aanroepen(sinds, patroon);
  if (gevonden.length === 0) {
    const gezien = server.verkeer.slice(sinds).filter((r) => r.soort === 'functie' || r.soort === 'rpc' || (r.soort === 'rest' && r.methode !== 'GET' && r.methode !== 'OPTIONS' && r.methode !== 'HEAD'));
    throw new Error(`${melding}: geen aanroep ${JSON.stringify(patroon)}; wel: ${gezien.map(beschrijf).join('; ') || 'niets'}`);
  }
  const mislukt = gevonden.find((r) => r.status >= 400);
  if (mislukt) throw new Error(`${melding}: ${beschrijf(mislukt)}`);
  return gevonden;
}

// ── Het scherm bedienen zoals een gebruiker ─────────────────────────────────

const inhoud = (page) => page.locator('.content:not([hidden])');

/** Een veld op zijn label (<label class="field"><span>Klant</span>…). */
function veld(container, label) {
  return container.locator('label.field, label.bk-field').filter({ has: container.page().locator(`xpath=./span[normalize-space(.)=${JSON.stringify(label)}]`) }).first();
}

/** Een keuzelijst (de eigen Select van de app) op een optie zetten. */
async function kies(veldLocator, optie) {
  const page = veldLocator.page();
  await veldLocator.locator('.select-trigger').click();
  await page.locator('.select-menu [role="option"]').filter({ hasText: regexVan(optie) }).first().click();
  await wachtTot(async () => tekst(await veldLocator.locator('.select-value').innerText()) === optie, { timeout: 5000, melding: `keuze "${optie}" bleef niet staan` });
}

/** Naar een pagina onder Financiën, via het menu (open vensters eerst dicht, zoals een gebruiker doet). */
async function naarFinancien(scherm, label) {
  const page = scherm.page;
  await sluitAlles(scherm);
  const knop = page.locator('.nav-submenu-finance button').filter({ hasText: regexVan(label) });
  if (!(await knop.isVisible().catch(() => false))) {
    await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Financiën/ }).first().click();
  }
  await knop.click();
  await rustig(scherm);
  await inhoud(page).locator('h2').filter({ hasText: regexVan(label) }).first().waitFor({ timeout: 15000 });
  await wachtTot(async () => !(await inhoud(page).getByText(/laden…/i).first().isVisible().catch(() => false)), { melding: `${label} bleef laden` });
}

async function ververs(scherm) {
  await sluitAlles(scherm);
  const knop = scherm.page.locator('.topbar .topbar-actions button').filter({ hasText: /^(Ververs|Laden…)$/ });
  await knop.click();
  await slaap(200);
  await rustig(scherm);
}

function modal(page, titel) {
  return page.locator('section.modal').filter({ has: page.locator('.modal-head h3', { hasText: titel instanceof RegExp ? titel : regexVan(titel) }) });
}

async function sluitModal(m) {
  if (!(await m.isVisible().catch(() => false))) return;
  await m.locator('.modal-head .modal-close').click();
  await m.waitFor({ state: 'detached', timeout: 5000 });
}

/** Sluit alles wat open staat (detailvensters, bewerkvensters). */
async function sluitAlles(scherm) {
  for (let i = 0; i < 4; i += 1) {
    const open = scherm.page.locator('section.modal .modal-head .modal-close');
    if (!(await open.first().isVisible().catch(() => false))) return;
    await open.last().click();
    await slaap(150);
  }
}

/** Een rij in de tabel van offertes of facturen. */
function rij(page, nummer) {
  return inhoud(page).locator('tr.quote-table-row').filter({ has: page.locator('td[data-label="Offerte"] strong, td[data-label="Factuur"] strong', { hasText: regexVan(nummer) }) });
}

/**
 * Het detailvenster van een offerte of factuur. Staat het al open, dan dat;
 * anders eerst alles dicht. Een venster dat na een mislukte stap bleef staan,
 * legt zijn achtergrond over de lijst en vangt anders de klik op de rij.
 */
async function openDocument(scherm, nummer, soort) {
  const page = scherm.page;
  const m = modal(page, `${soort} ${nummer}`);
  if (await m.isVisible().catch(() => false)) return m;
  await sluitAlles(scherm);
  await rij(page, nummer).first().click();
  await m.waitFor({ timeout: 10000 });
  return m;
}

async function rijStatus(page, nummer) {
  return tekst(await rij(page, nummer).locator('td[data-label="Status"] .fin-status').first().innerText());
}

async function detailStatus(m) {
  return tekst(await m.locator('.quote-detail-total .fin-status').first().innerText());
}

/** Zichtbare knoppen in een venster, op tekst. */
async function knoppen(container) {
  const lijst = await container.locator('button:visible').allInnerTexts();
  return lijst.map(tekst).filter(Boolean);
}

async function klik(container, naam) {
  const knop = container.getByRole('button', { name: naam instanceof RegExp ? naam : regexVan(naam) });
  await knop.first().click();
}

/** Staat de knop zichtbaar in het venster? (Uitgeschakeld telt als aanwezig.) */
async function heeftKnop(container, naam) {
  const knop = container.getByRole('button', { name: naam instanceof RegExp ? naam : regexVan(naam) });
  return (await knop.count()) > 0 && await knop.first().isVisible();
}

/** De bedragen van het formulier: Excl. btw, BTW, Totaal. */
async function formulierTotaal(m) {
  return tekst(await m.locator('.finance-editor-totals .finance-total').filter({ has: m.page().locator('xpath=./span[normalize-space(.)="Totaal"]') }).locator('strong').innerText());
}

async function publiekFeit(page, label) {
  return tekst(await page.locator('.public-hero-fact').filter({ has: page.locator(`xpath=./span[normalize-space(.)=${JSON.stringify(label)}]`) }).locator('strong').first().innerText());
}

// ── Gegevens klaarzetten zoals de app (voor wat niet de stap zelf is) ────────

async function offerteConcept(w, nummer, regels = REGELS) {
  const res = await rest('quotes?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, client_id: w.klantA.id, number: nummer, date: datum(), valid_until: datum(30), lines: regels.map((r, i) => ({ id: `regel-${i + 1}`, ...r })) },
  });
  return gelukt(res, `offerte ${nummer} opslaan`)[0];
}

async function offerteTot(w, nummer, eind) {
  const offerte = await offerteConcept(w, nummer);
  gelukt(await rpc('submit_quote_for_internal_approval', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.medewerker.token), 'indienen');
  if (eind === 'pending') return offerte;
  gelukt(await rpc('approve_quote_internal', { p_quote_id: offerte.id, p_organization_id: w.orgId }, w.beheerder.token), 'goedkeuren');
  if (eind === 'approved') return offerte;
  gelukt(await roep('quote-workflow', { token: w.medewerker.token, body: { action: 'sendQuoteEmail', organizationId: w.orgId, quoteId: offerte.id } }), 'versturen');
  return offerte;
}

async function factuurConcept(w, nummer, { vervaldatum = datum(14) } = {}) {
  const res = await rest('invoices?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, client_id: w.klantA.id, number: nummer, date: datum(), due_date: vervaldatum, lines: REGELS.map((r, i) => ({ id: `regel-${i + 1}`, ...r })), status: 'draft' },
  });
  return gelukt(res, `factuur ${nummer} opslaan`)[0];
}

async function factuurVerstuurd(w, nummer) {
  const factuur = await factuurConcept(w, nummer);
  gelukt(await roep('invoice-workflow', { token: w.medewerker.token, body: { action: 'sendInvoiceEmail', organizationId: w.orgId, invoiceId: factuur.id, includePaymentLink: false } }), `factuur ${nummer} versturen`);
  return factuur;
}

/**
 * Laat de tijd verstrijken voor één verstuurde factuur: de vervaldatum naar het
 * verleden. Een verstuurde factuur is vergrendeld (enforce_invoice_immutability);
 * alleen deze ene update, in deze ene transactie, gaat buiten de triggers om.
 */
function maakVervallen(factuurId, dagen = 10) {
  sql(`begin; set local session_replication_role = replica;
       update public.invoices set due_date = ${q(datum(-dagen))}::date where id = ${q(factuurId)};
       commit;`);
}

/** Een contract in de eenvoudige tekstverwerker, zoals ContractForm het opslaat (editor_mode blijft 'richtext'). */
async function contractConcept(w, titel, inhoudHtml) {
  const res = await rest('contracts?select=*', {
    method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, client_id: w.klantA.id, quote_id: null, title: titel, date: datum(), valid_until: null, amount_cents: 150000, currency: 'EUR', body: inhoudHtml },
  });
  return gelukt(res, `contract ${titel} opslaan`)[0];
}

async function contractVerstuurd(w, titel, inhoudHtml) {
  const contract = await contractConcept(w, titel, inhoudHtml);
  gelukt(await roep('contract-workflow', {
    token: w.medewerker.token,
    body: { action: 'sendContractForSignature', organizationId: w.orgId, contractId: contract.id, recipientEmail: w.klantA.email, recipientName: `Contact ${w.klantA.name}`, personalMessage: '' },
  }), `contract ${titel} versturen`);
  return contract;
}

// ── De scenario's ───────────────────────────────────────────────────────────

const t = { w: null, lid: null, offerte: null, factuur: null };

async function medewerker() {
  if (t.lid && schermen.has(t.lid)) return t.lid;
  t.lid = await openWerkruimte(t.w.medewerker, 'medewerker', t.w.orgId);
  return t.lid;
}

async function scenarioOfferte() {
  groep('UI: offerte van formulier tot factuur');
  const { w } = t;

  const nieuw = await uiStap('nieuwe offerte via het formulier (klant A, regels 21% en 9%) en opslaan', async () => {
    const lid = await medewerker();
    const page = lid.page;
    await naarFinancien(lid, 'Offertes');
    const sinds = server.verkeer.length;
    await inhoud(page).getByRole('button', { name: '+ Nieuw', exact: true }).click();
    const m = modal(page, 'Nieuwe offerte');
    await m.waitFor();
    const nummer = await veld(m, 'Offertenummer').locator('input').inputValue();
    verwacht(/^OFF-\d{4}-\d{4}$/.test(nummer), `voorgesteld offertenummer "${nummer}"`);
    await kies(veld(m, 'Klant'), w.klantA.name);
    await veld(m, 'Verloopdatum').locator('input').fill(datum(30));
    const regels = m.locator('.finance-line-row');
    const vul = async (i, r, btw) => {
      const regel = regels.nth(i);
      await veld(regel, 'Regelomschrijving').locator('input').fill(r.description);
      await veld(regel, 'Aantal').locator('input').fill(String(r.quantity));
      await veld(regel, 'Prijs ex. btw').locator('input').fill(String(r.unit_price));
      const btwVeld = veld(regel, 'BTW');
      if (await btwVeld.locator('.select-trigger').count()) await kies(btwVeld, btw);
      else await btwVeld.locator('input').fill(String(r.vat));
    };
    await vul(0, REGELS[0], 'BTW 21%');
    await m.getByRole('button', { name: '+ Regel', exact: true }).click();
    await vul(1, REGELS[1], 'BTW 9%');
    gelijk(await formulierTotaal(m), TOTAAL, 'totaal in het formulier');
    await m.locator('.modal-foot').getByRole('button', { name: 'Opslaan', exact: true }).click();
    await m.waitFor({ state: 'detached', timeout: 15000 });
    await rustig(lid);
    verwachtAanroep(sinds, { soort: 'rest', tabel: 'quotes', methode: 'POST' }, 'Opslaan schreef de offerte niet weg');
    await rij(page, nummer).first().waitFor({ timeout: 10000 });
    gelijk(tekst(await rij(page, nummer).locator('td[data-label="Totaal"]').innerText()), TOTAAL, 'totaal in de lijst');
    gelijk(await rijStatus(page, nummer), 'Concept', 'status in de lijst');
    const db = sqlRij(`select id, client_id, status, lines, valid_until from public.quotes where organization_id = ${q(w.orgId)} and number = ${q(nummer)}`);
    verwacht(db, 'offerte niet in de database');
    gelijk(db.client_id, w.klantA.id, 'klant van de offerte');
    gelijk(db.status, 'draft', 'status in de database');
    gelijk(db.valid_until, datum(30), 'verloopdatum');
    gelijk(db.lines.map((l) => [l.description, Number(l.quantity), Number(l.unit_price), Number(l.vat)]), REGELS.map((r) => [r.description, r.quantity, r.unit_price, r.vat]), 'regels in de database');
    return { id: db.id, nummer };
  });
  if (!nieuw) return;
  t.offerte = nieuw;

  await uiStap('ter goedkeuring indienen als medewerker', async () => {
    const lid = t.lid;
    const sinds = server.verkeer.length;
    const m = await openDocument(lid, nieuw.nummer, 'Offerte');
    verwacht(!(await heeftKnop(m, 'Goedkeuren')), 'een medewerker (geen admin) ziet de knop Goedkeuren');
    lid.plan.push({});
    await klik(m, 'Ter goedkeuring');
    await rustig(lid);
    const vraag = lid.dialogen.at(-1);
    verwacht(vraag?.type === 'confirm' && vraag.tekst.includes(nieuw.nummer), `geen bevestigingsvraag voor ${nieuw.nummer}: ${JSON.stringify(vraag)}`);
    verwachtAanroep(sinds, { rpc: 'submit_quote_for_internal_approval' }, 'Ter goedkeuring');
    await wachtTot(async () => (await detailStatus(m)) === 'Wacht op interne goedkeuring', { melding: 'status werd niet "Wacht op interne goedkeuring"' });
    gelijk(sqlRij(`select status from public.quotes where id = ${q(nieuw.id)}`).status, 'pending_internal_approval', 'status in de database');
    await sluitModal(m);
  });

  await uiStap('goedkeuren als beheerder', async () => {
    const beheer = await openWerkruimte(w.beheerder, 'beheerder', w.orgId, { tijdelijk: true });
    await naarFinancien(beheer, 'Offertes');
    const sinds = server.verkeer.length;
    const m = await openDocument(beheer, nieuw.nummer, 'Offerte');
    await klik(m, 'Goedkeuren');
    await rustig(beheer);
    verwacht(beheer.dialogen.at(-1)?.tekst.includes('intern goedkeuren'), 'geen bevestigingsvraag bij goedkeuren');
    verwachtAanroep(sinds, { rpc: 'approve_quote_internal' }, 'Goedkeuren');
    await wachtTot(async () => (await detailStatus(m)) === 'Intern goedgekeurd', { melding: 'status werd niet "Intern goedgekeurd"' });
    gelijk(sqlRij(`select status, internal_approval_status from public.quotes where id = ${q(nieuw.id)}`), { status: 'internally_approved', internal_approval_status: 'approved' }, 'database');
  });

  const link = await uiStap('"Verstuur via Resend" als medewerker: mail met link en PDF naar klant A', async () => {
    const lid = t.lid;
    await sluitAlles(lid);
    await ververs(lid);
    const mailsVoor = mailsAan(w.klantA.email).length;
    const sinds = server.verkeer.length;
    const m = await openDocument(lid, nieuw.nummer, 'Offerte');
    const dialogenVoor = lid.dialogen.length;
    await klik(m, 'Verstuur via Resend');
    await rustig(lid);
    const vragen = lid.dialogen.slice(dialogenVoor);
    gelijk(vragen.map((v) => v.type), ['prompt', 'prompt'], 'vragen bij versturen');
    gelijk(vragen[0].standaard, w.klantA.email, 'voorgesteld adres (het adres van klant A)');
    verwachtAanroep(sinds, { functie: 'quote-workflow', actie: 'sendQuoteEmail' }, 'Verstuur via Resend');
    await wachtTot(async () => (await detailStatus(m)) === 'Verzonden', { melding: 'status werd niet "Verzonden"' });
    verwacht(tekst(await m.locator('.quote-email-status').innerText()).includes(w.klantA.email), 'de ontvanger staat niet bij de verzendstatus');
    const nieuweMails = mailsAan(w.klantA.email).slice(mailsVoor);
    gelijk(nieuweMails.length, 1, 'mails aan klant A');
    verwacht(nieuweMails[0].bijlagen.some((b) => b.naam.toLowerCase().endsWith('.pdf')), 'geen PDF-bijlage');
    const url = linkUit(nieuweMails[0], 'quote');
    verwacht(url?.startsWith(`${APP}/quote/`), `geen offertelink naar de app in de mail: ${url}`);
    return url;
  });
  if (!link) return;

  await uiStap('klant opent de link: bedragen zichtbaar en akkoord geven', async () => {
    const klant = await openAlsKlant(link);
    const page = klant.page;
    const sinds = server.verkeer.length;
    await page.locator('h1').filter({ hasText: `Offerte ${nieuw.nummer}` }).waitFor({ timeout: 15000 });
    gelijk(await publiekFeit(page, 'Totaal incl. btw'), TOTAAL, 'totaal in de kop');
    gelijk(tekst(await page.locator('.public-total-row.grand strong').innerText()), TOTAAL, 'totaal onder de regels');
    gelijk(tekst(await page.locator('.public-quote-status').innerText()), 'Wacht op akkoord', 'status');
    gelijk(await page.getByPlaceholder('E-mailadres').inputValue(), w.klantA.email, 'voorgevuld e-mailadres');
    await page.getByRole('button', { name: 'Akkoord geven', exact: true }).click();
    await page.locator('.public-decision-done h3').filter({ hasText: 'Offerte geaccepteerd' }).waitFor({ timeout: 15000 });
    gelijk(tekst(await page.locator('.public-quote-status').innerText()), 'Geaccepteerd', 'status na akkoord');
    verwachtAanroep(sinds, { functie: 'quote-public', actie: 'acceptQuote' }, 'Akkoord geven');
    const db = sqlRij(`select status, client_decision_by_email from public.quotes where id = ${q(nieuw.id)}`);
    gelijk(db, { status: 'accepted', client_decision_by_email: w.klantA.email }, 'database na akkoord');
  });

  await uiStap('terug in de app: de offerte staat als geaccepteerd', async () => {
    const lid = t.lid;
    await sluitAlles(lid);
    await ververs(lid);
    const m = await openDocument(lid, nieuw.nummer, 'Offerte');
    // Functioneel: de stap "Akkoord" is gezet en omzetten kan.
    await wachtTot(async () => (await m.locator('.quote-progress .quote-step.done').count()) === 5, { melding: 'de voortgang staat niet op akkoord' });
    verwacht(await heeftKnop(m, 'Maak factuur van offerte'), 'de knop "Maak factuur van offerte" ontbreekt bij een geaccepteerde offerte');
  });

  await uiStap('het label zegt "geaccepteerd" (lijst en detail)', async () => {
    const lid = t.lid;
    const m = modal(lid.page, `Offerte ${nieuw.nummer}`);
    const detail = await detailStatus(m);
    const lijst = await rijStatus(lid.page, nieuw.nummer);
    verwacht(/geaccepteerd|akkoord/i.test(detail) && /geaccepteerd|akkoord/i.test(lijst),
      `de klant gaf akkoord (database: accepted, klantpagina: "Geaccepteerd"), maar de app toont "${detail}" in het detail en "${lijst}" in de lijst`);
  });

  const factuur = await uiStap('"Maak factuur van offerte": factuur met hetzelfde bedrag', async () => {
    const lid = t.lid;
    const page = lid.page;
    const m = modal(page, `Offerte ${nieuw.nummer}`);
    if (!(await m.isVisible().catch(() => false))) await openDocument(lid, nieuw.nummer, 'Offerte');
    const sinds = server.verkeer.length;
    await klik(modal(page, `Offerte ${nieuw.nummer}`), 'Maak factuur van offerte');
    await rustig(lid);
    verwacht(lid.dialogen.at(-1)?.tekst.includes(`Factuur maken van offerte ${nieuw.nummer}`), 'geen bevestigingsvraag bij omzetten');
    verwachtAanroep(sinds, { rpc: 'convert_accepted_quote_to_invoice' }, 'Maak factuur van offerte');
    const bewerk = modal(page, 'Factuur bewerken');
    await bewerk.waitFor({ timeout: 15000 });
    gelijk(await formulierTotaal(bewerk), TOTAAL, 'totaal van de nieuwe factuur');
    const nummer = await veld(bewerk, 'Factuurnummer').locator('input').inputValue();
    const db = sqlRij(`select id, number, status, quote_id, client_id, total_amount from public.invoices where organization_id = ${q(w.orgId)} and quote_id = ${q(nieuw.id)}`);
    verwacht(db, 'geen factuur met deze offerte in de database');
    gelijk([db.number, db.status, db.client_id, Number(db.total_amount)], [nummer, 'draft', w.klantA.id, 173.63], 'factuur in de database');
    await bewerk.locator('.modal-foot').getByRole('button', { name: /^(Annuleren|Sluiten)$/ }).click();
    await bewerk.waitFor({ state: 'detached' });
    await inhoud(page).locator('h2').filter({ hasText: /^Facturen$/ }).waitFor();
    gelijk(tekst(await rij(page, nummer).locator('td[data-label="Totaal"]').innerText()), TOTAAL, 'totaal in de factuurlijst');
    gelijk(tekst(await rij(page, nummer).locator('td[data-label="Offerte"]').innerText()), nieuw.nummer, 'gekoppelde offerte in de lijst');
    return { id: db.id, nummer };
  });
  if (factuur) t.factuur = factuur;
}

async function scenarioFactuur() {
  groep('UI: factuur versturen, publieke pagina, herinnering en crediteren');
  const { w } = t;

  // Zonder het offertescenario: een conceptfactuur zoals "Maak factuur van offerte" hem maakt.
  if (!t.factuur) {
    t.factuur = await stap('conceptfactuur klaarzetten (offertescenario niet gedraaid)', async () => {
      const f = await factuurConcept(w, 'FAC-UI-0001');
      // Het werkblad van het lid laadde al bij het begin van de run, vóór dit
      // concept in de database stond, en ververst niet vanzelf (de lokale stack
      // heeft geen realtime). Zonder herladen vond "Verstuur via Resend" het
      // concept niet ("Nog geen facturen"), en faalde ook de herinneringsstap.
      const lid = await medewerker();
      await rustig(lid);
      await lid.page.reload({ waitUntil: 'domcontentloaded' });
      await lid.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 60000 });
      return { id: f.id, nummer: f.number };
    });
    if (!t.factuur) return;
  }
  const f1 = t.factuur;

  const link = await uiStap('"Verstuur via Resend": factuur naar klant A met link', async () => {
    const lid = await medewerker();
    await sluitAlles(lid);
    await naarFinancien(lid, 'Facturen');
    const mailsVoor = mailsAan(w.klantA.email).length;
    const sinds = server.verkeer.length;
    const m = await openDocument(lid, f1.nummer, 'Factuur');
    const dialogenVoor = lid.dialogen.length;
    await klik(m, 'Verstuur via Resend');
    await rustig(lid);
    const vragen = lid.dialogen.slice(dialogenVoor);
    gelijk(vragen.map((v) => v.type), ['prompt', 'prompt'], 'vragen bij versturen');
    gelijk(vragen[0].standaard, w.klantA.email, 'voorgesteld adres');
    verwachtAanroep(sinds, { functie: 'invoice-workflow', actie: 'sendInvoiceEmail' }, 'Verstuur via Resend');
    await wachtTot(async () => (await detailStatus(m)) === 'Verzonden', { melding: 'status werd niet "Verzonden"' });
    gelijk(sqlRij(`select status from public.invoices where id = ${q(f1.id)}`).status, 'sent', 'status in de database');
    const nieuweMails = mailsAan(w.klantA.email).slice(mailsVoor);
    gelijk(nieuweMails.length, 1, 'mails aan klant A');
    verwacht(mailtekst(nieuweMails[0]).includes('173,63'), 'het bedrag staat niet in de factuurmail');
    const url = linkUit(nieuweMails[0], 'invoice');
    verwacht(url?.startsWith(`${APP}/invoice/`), `geen factuurlink naar de app in de mail: ${url}`);
    await sluitModal(m);
    return url;
  });

  if (link) {
    await uiStap('publieke factuurpagina via de mail-link: bedrag en openstaand bedrag', async () => {
      const klant = await openAlsKlant(link);
      const page = klant.page;
      await page.locator('h1').filter({ hasText: `Factuur ${f1.nummer}` }).waitFor({ timeout: 15000 });
      gelijk(await publiekFeit(page, 'Te betalen'), TOTAAL, 'te betalen in de kop');
      gelijk(tekst(await page.locator('.public-invoice-amount').innerText()), TOTAAL, 'te betalen op de betaalkaart');
      gelijk(tekst(await page.locator('.public-total-row.grand strong').innerText()), TOTAAL, 'totaal onder de regels');
      gelijk(tekst(await page.locator('.public-quote-status').innerText()), 'Open', 'status');
      // Wat de pagina als openstaand toont, komt uit het grootboek (open_amount_cents).
      const token = decodeURIComponent(new URL(link).pathname.split('/').pop());
      const data = gelukt(await roep('invoice-public', { body: { action: 'getInvoice', token } }), 'getInvoice');
      gelijk(data.invoice.open_amount_cents, 17363, 'openstaand bedrag volgens de functie');
    });
  }

  const concept = await uiStap('conceptfactuur met een vervaldatum in het verleden via "+ Nieuw"', async () => {
    const lid = t.lid;
    const page = lid.page;
    await sluitAlles(lid);
    const sinds = server.verkeer.length;
    await inhoud(page).getByRole('button', { name: '+ Nieuw', exact: true }).click();
    const m = modal(page, 'Nieuwe factuur');
    await m.waitFor();
    const nummer = await veld(m, 'Factuurnummer').locator('input').inputValue();
    await kies(veld(m, 'Klant'), w.klantA.name);
    await veld(m, 'Vervaldatum').locator('input').fill(datum(-10));
    const regel = m.locator('.finance-line-row').first();
    await veld(regel, 'Regelomschrijving').locator('input').fill('Losse klus');
    await veld(regel, 'Prijs ex. btw').locator('input').fill('50');
    await m.locator('.modal-foot').getByRole('button', { name: 'Opslaan', exact: true }).click();
    await m.waitFor({ state: 'detached', timeout: 15000 });
    await rustig(lid);
    verwachtAanroep(sinds, { soort: 'rest', tabel: 'invoices', methode: 'POST' }, 'Opslaan schreef de factuur niet weg');
    gelijk(await rijStatus(page, nummer), 'Concept', 'status van het concept');
    const db = sqlRij(`select id, status, due_date from public.invoices where organization_id = ${q(w.orgId)} and number = ${q(nummer)}`);
    gelijk([db?.status, db?.due_date], ['draft', datum(-10)], 'concept in de database');
    return { id: db.id, nummer };
  });

  const vervallen = await uiStap('vervallen factuur: "Stuur herinnering" wel bij de verstuurde, niet bij het concept', async () => {
    const lid = t.lid;
    maakVervallen(f1.id);
    await ververs(lid);
    if (concept) {
      const c = await openDocument(lid, concept.nummer, 'Factuur');
      const lijst = await knoppen(c);
      verwacht(!lijst.some((k) => /^Stuur herinnering/.test(k)), `een concept biedt "Stuur herinnering" aan: ${lijst.join(', ')}`);
      await sluitModal(c);
    }
    const m = await openDocument(lid, f1.nummer, 'Factuur');
    verwacht(await heeftKnop(m, /^Stuur herinnering \(niveau 1\)$/), `geen "Stuur herinnering (niveau 1)" bij de vervallen factuur; knoppen: ${(await knoppen(m)).join(', ')}`);
    return true;
  });

  // De melding die de app na de herinnering toont als de betaallink niet lukte.
  // Die mag de controle van de verzending zelf niet laten mislukken; de stap
  // erna beoordeelt hem apart.
  const BETAALLINK_MELDING = /^Herinnering is verstuurd, maar de Mollie-betaallink kon niet worden aangemaakt/;
  let betaallinkMelding = null;
  const herinnerd = vervallen && await uiStap('herinnering versturen: mail naar klant A met het juiste bedrag', async () => {
    const lid = t.lid;
    const m = modal(lid.page, `Factuur ${f1.nummer}`);
    const mailsVoor = mailsAan(w.klantA.email).length;
    const sinds = server.verkeer.length;
    await klik(m, /^Stuur herinnering \(niveau 1\)$/);
    await rustig(lid);
    const vraag = lid.dialogen.at(-1);
    verwacht(vraag?.type === 'confirm' && vraag.tekst.includes(f1.nummer) && vraag.tekst.includes(w.klantA.email), `bevestigingsvraag: ${JSON.stringify(vraag)}`);
    verwachtAanroep(sinds, { functie: 'invoice-workflow', actie: 'sendInvoiceReminderEmail' }, 'Stuur herinnering');
    const nieuweMails = mailsAan(w.klantA.email).slice(mailsVoor);
    gelijk(nieuweMails.length, 1, 'herinneringsmails aan klant A');
    const inhoudMail = mailtekst(nieuweMails[0]);
    verwacht(inhoudMail.includes('173,63'), `het bedrag (173,63) staat niet in de herinnering: ${inhoudMail.slice(0, 400)}`);
    verwacht(inhoudMail.includes(f1.nummer), 'het factuurnummer staat niet in de herinnering');
    await wachtTot(async () => tekst(await m.locator('.invoice-reminder-panel').first().innerText()).includes('Niveau 1 · Vriendelijke herinnering verstuurd'), { melding: 'het herinneringspaneel toont niveau 1 niet' });
    gelijk(Number(sqlRij(`select reminder_level from public.invoices where id = ${q(f1.id)}`).reminder_level), 1, 'herinneringsniveau in de database');
    betaallinkMelding = (await schermstand(lid.page)).fouten.find((f) => BETAALLINK_MELDING.test(f)) ?? null;
    await sluitModal(m);
    return true;
  }, { foutmelding: BETAALLINK_MELDING });

  if (herinnerd) {
    await uiStap('zonder Mollie-koppeling meldt de herinnering geen mislukte betaallink', async () => {
      // Versturen vraagt eerst de Mollie-status op en laat de betaallink weg als
      // er geen Mollie is gekoppeld; de herinnering hoort dat ook te doen.
      verwacht(!betaallinkMelding, `deze organisatie heeft geen Mollie gekoppeld, toch staat na "Stuur herinnering" in beeld: "${betaallinkMelding}"`);
    }, { foutmelding: BETAALLINK_MELDING });

    await uiStap('na de herinnering kan de factuur nog gecrediteerd worden (er loopt geen betaling)', async () => {
      const lid = t.lid;
      await sluitAlles(lid);
      await ververs(lid);
      const m = await openDocument(lid, f1.nummer, 'Factuur');
      if (!(await heeftKnop(m, 'Crediteren'))) {
        const betalingen = sqlRijen(`select status, provider_payment_id, checkout_expires_at from public.invoice_payment_records where invoice_id = ${q(f1.id)} order by created_at`);
        const strook = tekst(await m.locator('.invoice-status-strip').innerText());
        // Zegt de server hetzelfde? Dan kan crediteren ook buiten de app niet.
        const antwoord = await roep('invoice-workflow', { token: w.medewerker.token, body: { action: 'creditInvoice', organizationId: w.orgId, invoiceId: f1.id, reason: 'UI-test: controle na herinnering' } });
        throw new Error(`"Crediteren" ontbreekt bij ${f1.nummer} (verstuurd, onbetaald, geen Mollie gekoppeld) na de herinnering. `
          + `Betaalrecords: ${JSON.stringify(betalingen)}. Statusstrook: "${strook}". `
          + `creditInvoice rechtstreeks: ${antwoord.status} ${antwoord.json?.error ?? antwoord.tekst.slice(0, 200)}`);
      }
      const sinds = server.verkeer.length;
      lid.plan.push({ antwoord: 'Factuur vervalt (UI-test)' });
      await klik(m, 'Crediteren');
      await rustig(lid);
      verwachtAanroep(sinds, { functie: 'invoice-workflow', actie: 'creditInvoice' }, 'Crediteren na de herinnering');
      await wachtTot(async () => (await detailStatus(m)) === 'Geannuleerd', { melding: 'status werd niet "Geannuleerd"' });
      await sluitModal(m);
    });
  }

  await uiStap('"Crediteren" op een andere verstuurde factuur: creditfactuur en status geannuleerd', async () => {
    const lid = t.lid;
    const f3 = await factuurVerstuurd(w, 'FAC-UI-CRED-1');
    await ververs(lid);
    const mailsVoor = mailsAan(w.klantA.email).length;
    const sinds = server.verkeer.length;
    const m = await openDocument(lid, f3.number, 'Factuur');
    lid.plan.push({ antwoord: 'Dubbel gefactureerd (UI-test)' });
    await klik(m, 'Crediteren');
    await rustig(lid);
    const vraag = lid.dialogen.at(-1);
    verwacht(vraag?.type === 'prompt' && vraag.tekst.includes(`Factuur ${f3.number} crediteren?`), `vraag bij crediteren: ${JSON.stringify(vraag)}`);
    verwachtAanroep(sinds, { functie: 'invoice-workflow', actie: 'creditInvoice' }, 'Crediteren');
    await wachtTot(async () => (await detailStatus(m)) === 'Geannuleerd', { melding: 'status werd niet "Geannuleerd"' });
    const credit = sqlRij(`select number, total_amount, reason from public.credit_notes where invoice_id = ${q(f3.id)}`);
    verwacht(credit, 'geen creditnota in de database');
    gelijk(Math.abs(Number(credit.total_amount)), 173.63, 'bedrag van de creditnota');
    gelijk(sqlRij(`select status from public.invoices where id = ${q(f3.id)}`).status, 'cancelled', 'status in de database');
    await wachtTot(async () => tekst(await m.locator('.quote-version-pill').filter({ hasText: credit.number }).first().innerText()).includes(`- ${TOTAAL}`), { melding: 'de creditfactuur staat niet bij de factuur' });
    gelijk(await rijStatus(lid.page, f3.number), 'Geannuleerd', 'status in de lijst');
    const creditMails = mailsAan(w.klantA.email).slice(mailsVoor);
    verwacht(creditMails.length === 1 && mailtekst(creditMails[0]).includes(credit.number), `de creditfactuur ging niet (één keer) naar klant A: ${creditMails.length} mail(s)`);
    await sluitModal(m);
  });
}

async function scenarioIntrekken() {
  groep('UI: offerte intrekken');
  const { w } = t;
  const klaar = await stap('verstuurde offerte klaarzetten (zoals de knoppen hierboven)', async () => {
    const mailsVoor = mailsAan(w.klantA.email).length;
    const offerte = await offerteTot(w, 'OFF-UI-INTREK-1', 'sent');
    const mail = mailsAan(w.klantA.email).slice(mailsVoor)[0];
    const link = mail && linkUit(mail, 'quote');
    verwacht(link, 'geen offertelink in de mail');
    return { offerte, link };
  });
  if (!klaar) return;
  const reden = 'Verkeerde prijs (interne reden UI-test)';

  const ingetrokken = await uiStap('"Intrekken" met een reden in de app', async () => {
    const lid = await medewerker();
    await sluitAlles(lid);
    await naarFinancien(lid, 'Offertes');
    await ververs(lid);
    const sinds = server.verkeer.length;
    const m = await openDocument(lid, klaar.offerte.number, 'Offerte');
    lid.plan.push({ antwoord: reden });
    await klik(m, 'Intrekken');
    await rustig(lid);
    const vraag = lid.dialogen.at(-1);
    verwacht(vraag?.type === 'prompt' && vraag.tekst.includes(`Offerte ${klaar.offerte.number} intrekken?`), `vraag bij intrekken: ${JSON.stringify(vraag)}`);
    verwachtAanroep(sinds, { rpc: 'withdraw_quote' }, 'Intrekken');
    gelijk(sqlRij(`select status from public.quotes where id = ${q(klaar.offerte.id)}`).status, 'cancelled', 'status in de database');
    const status = await wachtTot(async () => { const s = await detailStatus(m); return /ingetrokken|geannuleerd/i.test(s) ? s : null; }, { melding: 'de status in de app veranderde niet' });
    noten.push(`statuslabel in de app na intrekken: "${status}"`);
    const lijst = await knoppen(m);
    verwacht(!lijst.some((k) => /^(Intrekken|Verstuur via Resend)$/.test(k)), `na intrekken nog knoppen: ${lijst.join(', ')}`);
    await sluitModal(m);
    return status;
  });
  if (!ingetrokken) return;

  await uiStap('publieke link toont "Ingetrokken" (zonder de interne reden)', async () => {
    const klant = await openAlsKlant(klaar.link);
    const page = klant.page;
    await page.locator('h1').filter({ hasText: `Offerte ${klaar.offerte.number}` }).waitFor({ timeout: 15000 });
    gelijk(tekst(await page.locator('.public-quote-status').innerText()), 'Ingetrokken', 'status op de klantpagina');
    verwacht(!tekst(await page.locator('body').innerText()).includes(reden), 'de interne reden staat op de klantpagina');
  });

  await uiStap('de klantpagina biedt bij een ingetrokken offerte geen "Akkoord geven" aan', async () => {
    const klant = await openAlsKlant(klaar.link);
    const page = klant.page;
    await page.locator('h1').filter({ hasText: `Offerte ${klaar.offerte.number}` }).waitFor({ timeout: 15000 });
    const akkoord = page.getByRole('button', { name: 'Akkoord geven', exact: true });
    const zichtbaar = (await akkoord.count()) > 0 && await akkoord.isVisible();
    verwacht(!zichtbaar, `status "Ingetrokken", maar de pagina toont het akkoordformulier met "Akkoord geven"${zichtbaar && await akkoord.isEnabled() ? ' (ingeschakeld)' : ''}`);
  });

  await uiStap('akkoord geven op een ingetrokken offerte lukt niet', async () => {
    const klant = await openAlsKlant(klaar.link);
    const page = klant.page;
    await page.locator('h1').filter({ hasText: `Offerte ${klaar.offerte.number}` }).waitFor({ timeout: 15000 });
    const akkoord = page.getByRole('button', { name: 'Akkoord geven', exact: true });
    if ((await akkoord.count()) > 0 && await akkoord.isVisible() && await akkoord.isEnabled()) {
      // De knop staat er (zie de vorige stap): dan moet de server weigeren en de pagina dat zeggen.
      const sinds = server.verkeer.length;
      await akkoord.click();
      await rustig(klant);
      const geweigerd = aanroepen(sinds, { functie: 'quote-public', actie: 'acceptQuote' });
      verwacht(geweigerd.length === 1 && geweigerd[0].status === 409, `acceptQuote: ${geweigerd.map(beschrijf).join('; ') || 'niet aangeroepen'}`);
      const melding = await wachtTot(async () => { const s = await schermstand(page); return s.fouten[0] ?? null; }, { melding: 'de pagina zegt niet dat akkoord niet kan' });
      verwacht(/niet meer/i.test(melding), `melding: "${melding}"`);
      gelijk(tekst(await page.locator('.public-quote-status').innerText()), 'Ingetrokken', 'status na de poging');
    }
    gelijk(sqlRij(`select status, client_decision_at from public.quotes where id = ${q(klaar.offerte.id)}`), { status: 'cancelled', client_decision_at: null }, 'database na de poging');
  }, { toegestaan: [{ functie: 'quote-public', actie: 'acceptQuote', status: 409 }], foutmelding: /kan niet meer worden geaccepteerd/i });
}

async function scenarioContract() {
  groep('UI: contract versturen, ondertekenen en terug naar concept');
  const { w } = t;
  const inhoudHtml = '<h2>Onderhoudsovereenkomst</h2><p>Partijen spreken af dat Studio de website van de klant onderhoudt.</p><ul><li>Looptijd: twaalf maanden</li></ul>';
  const c1 = await stap('rich-text contract klaarzetten zoals het formulier (editor_mode richtext)', async () => {
    const c = await contractConcept(w, 'Onderhoud UI-test', inhoudHtml);
    gelijk([c.status, c.editor_mode], ['draft', 'richtext'], 'nieuw contract');
    return c;
  });
  if (!c1) return;

  const link = await uiStap('"Verstuur ter ondertekening" via de knop', async () => {
    const lid = await medewerker();
    await sluitAlles(lid);
    await naarFinancien(lid, 'Contracten');
    const page = lid.page;
    const mailsVoor = mailsAan(w.klantA.email).length;
    const sinds = server.verkeer.length;
    await inhoud(page).locator('tr.bk-row').filter({ hasText: c1.number }).click();
    const m = modal(page, `Contract ${c1.number}`);
    await m.waitFor();
    await klik(m, 'Verstuur ter ondertekening');
    gelijk(await veld(m, 'E-mail ontvanger').locator('input').inputValue(), w.klantA.email, 'voorgevuld adres');
    await klik(m, 'Verstuur nu');
    await m.locator('.success').filter({ hasText: 'Contract verstuurd ter ondertekening.' }).waitFor({ timeout: 20000 });
    await rustig(lid);
    verwachtAanroep(sinds, { functie: 'contract-workflow', actie: 'sendContractForSignature' }, 'Verstuur nu');
    await wachtTot(async () => tekst(await m.locator('.contract-detail-head').innerText()).includes('Wacht op ondertekening'), { melding: 'status werd niet "Wacht op ondertekening"' });
    gelijk(sqlRij(`select status from public.contracts where id = ${q(c1.id)}`).status, 'sent', 'status in de database');
    const nieuweMails = mailsAan(w.klantA.email).slice(mailsVoor);
    gelijk(nieuweMails.length, 1, 'mails aan klant A');
    const url = linkUit(nieuweMails[0], 'contract');
    verwacht(url?.startsWith(`${APP}/contract/`), `geen contractlink naar de app in de mail: ${url}`);
    await sluitModal(m);
    return url;
  });

  if (link) {
    await uiStap('klant ondertekent met getypte naam en akkoordvinkje', async () => {
      const klant = await openAlsKlant(link);
      const page = klant.page;
      const sinds = server.verkeer.length;
      await page.locator('h1').filter({ hasText: `Contract ${c1.number}` }).waitFor({ timeout: 15000 });
      verwacht(tekst(await page.locator('.contract-body').innerText()).includes('Partijen spreken af dat Studio de website'), 'de contracttekst staat niet op de pagina');
      const teken = page.getByRole('button', { name: 'Onderteken contract', exact: true });
      verwacht(await teken.isDisabled(), 'ondertekenen kan al zonder akkoordvinkje');
      await page.getByPlaceholder('Volledige naam').fill('Anna de Klant');
      await page.locator('input[type="checkbox"]').check();
      await teken.click();
      await page.locator('.public-decision-done h3').filter({ hasText: 'Contract ondertekend' }).waitFor({ timeout: 20000 });
      gelijk(tekst(await page.locator('.public-quote-status').innerText()), 'Ondertekend', 'status op de klantpagina');
      verwachtAanroep(sinds, { functie: 'contract-public', actie: 'signContract' }, 'Onderteken contract');
      const db = sqlRij(`select c.status, s.name, s.signature_method from public.contracts c join public.contract_signers s on s.contract_id = c.id and s.role = 'client' where c.id = ${q(c1.id)}`);
      gelijk(db, { status: 'signed', name: 'Anna de Klant', signature_method: 'typed' }, 'database na ondertekenen');
    });

    await uiStap('in de app na "Ververs": status ondertekend', async () => {
      const lid = t.lid;
      await sluitAlles(lid);
      await ververs(lid);
      const status = tekst(await inhoud(lid.page).locator('tr.bk-row').filter({ hasText: c1.number }).locator('td').nth(4).innerText());
      verwacht(status === 'Ondertekend', `de klant tekende (database: signed), maar na "Ververs" toont de contractenlijst nog "${status}"`);
    });

    await uiStap('in de app na opnieuw openen van Contracten: status ondertekend', async () => {
      const lid = t.lid;
      await naarFinancien(lid, 'Offertes');
      await naarFinancien(lid, 'Contracten');
      const rijC1 = inhoud(lid.page).locator('tr.bk-row').filter({ hasText: c1.number });
      gelijk(tekst(await rijC1.locator('td').nth(4).innerText()), 'Ondertekend', 'status in de lijst');
      await rijC1.click();
      const m = modal(lid.page, `Contract ${c1.number}`);
      await m.waitFor();
      await wachtTot(async () => tekst(await m.innerText()).includes('Ondertekend door Anna de Klant'), { melding: 'het detail noemt de ondertekenaar niet' });
      await sluitModal(m);
    });
  }

  await uiStap('verstuurd contract: "Terug naar concept" en de oude link werkt niet meer', async () => {
    const lid = await medewerker();
    const mailsVoor = mailsAan(w.klantA.email).length;
    const c2 = await contractVerstuurd(w, 'Terug naar concept UI-test', inhoudHtml);
    const oudeLink = linkUit(mailsAan(w.klantA.email).slice(mailsVoor)[0] ?? { html: '', text: '' }, 'contract');
    verwacht(oudeLink, 'geen contractlink in de mail');
    await sluitAlles(lid);
    await naarFinancien(lid, 'Offertes');
    await naarFinancien(lid, 'Contracten');
    const sinds = server.verkeer.length;
    await inhoud(lid.page).locator('tr.bk-row').filter({ hasText: c2.number }).click();
    const m = modal(lid.page, `Contract ${c2.number}`);
    await m.waitFor();
    await klik(m, 'Terug naar concept');
    await m.locator('.success').filter({ hasText: 'Het contract is weer een concept.' }).waitFor({ timeout: 15000 });
    await rustig(lid);
    verwacht(lid.dialogen.at(-1)?.tekst.startsWith('Terug naar concept?'), 'geen bevestigingsvraag');
    verwachtAanroep(sinds, { rpc: 'reopen_contract' }, 'Terug naar concept');
    await wachtTot(async () => tekst(await m.locator('.contract-detail-head').innerText()).includes('Concept'), { melding: 'status werd niet "Concept"' });
    verwacht(await heeftKnop(m, 'Verstuur ter ondertekening'), 'na terug naar concept kan het niet opnieuw verstuurd worden');
    gelijk(sqlRij(`select status, public_token_hash from public.contracts where id = ${q(c2.id)}`), { status: 'draft', public_token_hash: null }, 'database');
    await sluitModal(m);
    const klant = await openAlsKlant(oudeLink);
    await klant.page.locator('h1').filter({ hasText: 'Deze link werkt niet meer' }).waitFor({ timeout: 15000 });
  }, { toegestaan: [{ functie: 'contract-public', actie: 'getContract', status: 404 }, { functie: 'contract-public', actie: 'getContract', status: 410 }] });
}

/** De knoppen die iets veranderen; wie geen schrijfrecht heeft, hoort ze niet te zien. */
const SCHRIJFKNOPPEN = {
  offerte: [/^Ter goedkeuring$/, /^Goedkeuren$/, /^Afwijzen$/, /^Verstuur via Resend$/, /^Maak factuur van offerte$/, /^Intrekken$/],
  factuur: [/^Verstuur via Resend$/, /^Verstuur e-factuur$/, /^Verstuur via Mollie$/, /^Stuur herinnering/, /^Crediteren$/, /^Terugbetaling$/, /^Boek naar grootboek$/, /^(Pauzeer|Hervat) herinneringen$/, /^Stel aanmaning op$/],
  contract: [/^Verstuur ter ondertekening$/, /^Opnieuw versturen$/, /^Terug naar concept$/, /^Intrekken$/, /^Verwijderen$/, /^Bewerken$/, /^Plaats$/, /^Nieuw project aanmaken$/],
};

async function scenarioRollen() {
  groep('UI: rollen zonder schrijfrecht (kijker, lezer, boekhouder)');
  const { w } = t;
  const docs = await stap('stukken klaarzetten in elke stand', async () => {
    const qWacht = await offerteTot(w, 'OFF-UI-ROL-WACHT', 'pending');
    const qGoed = await offerteTot(w, 'OFF-UI-ROL-GOED', 'approved');
    const qVerstuurd = await offerteTot(w, 'OFF-UI-ROL-VERSTUURD', 'sent');
    const fVerstuurd = await factuurVerstuurd(w, 'FAC-UI-ROL-1');
    maakVervallen(fVerstuurd.id);
    const fConcept = await factuurConcept(w, 'FAC-UI-ROL-2');
    const cConcept = await contractConcept(w, 'Rollen concept UI-test', '<p>Concepttekst</p>');
    const cVerstuurd = await contractVerstuurd(w, 'Rollen verstuurd UI-test', '<p>Verstuurde tekst</p>');
    return {
      offertes: [
        { nummer: qWacht.number, verwachtLid: ['Intrekken'], verwachtBeheerder: ['Goedkeuren', 'Afwijzen'] },
        { nummer: qGoed.number, verwachtLid: ['Verstuur via Resend', 'Intrekken'] },
        { nummer: qVerstuurd.number, verwachtLid: ['Intrekken'] },
      ],
      facturen: [
        { nummer: fVerstuurd.number, verwachtLid: ['Verstuur via Resend', 'Stuur herinnering (niveau 1)', 'Crediteren'] },
        { nummer: fConcept.number, verwachtLid: ['Verstuur via Resend'], bewerk: true },
      ],
      contracten: [
        { nummer: cConcept.number, verwachtLid: ['Verstuur ter ondertekening', 'Intrekken', 'Verwijderen', 'Bewerken'] },
        { nummer: cVerstuurd.number, verwachtLid: ['Opnieuw versturen', 'Terug naar concept', 'Intrekken'] },
      ],
    };
  });
  if (!docs) return;

  /** Per stuk: welke schrijfknoppen staan er in het venster. */
  async function inventaris(scherm) {
    const page = scherm.page;
    const uit = { nieuw: {}, offertes: {}, facturen: {}, contracten: {}, bewerk: {} };
    await sluitAlles(scherm);
    await naarFinancien(scherm, 'Offertes');
    uit.nieuw.offertes = await inhoud(page).getByRole('button', { name: '+ Nieuw', exact: true }).isEnabled();
    for (const d of docs.offertes) {
      const m = await openDocument(scherm, d.nummer, 'Offerte');
      uit.offertes[d.nummer] = (await knoppen(m)).filter((k) => SCHRIJFKNOPPEN.offerte.some((r) => r.test(k)));
      await sluitModal(m);
    }
    await naarFinancien(scherm, 'Facturen');
    uit.nieuw.facturen = await inhoud(page).getByRole('button', { name: '+ Nieuw', exact: true }).isEnabled();
    for (const d of docs.facturen) {
      const m = await openDocument(scherm, d.nummer, 'Factuur');
      uit.facturen[d.nummer] = (await knoppen(m)).filter((k) => SCHRIJFKNOPPEN.factuur.some((r) => r.test(k)));
      if (d.bewerk) {
        // Het bewerkvenster van een concept: opslaan of verwijderen hoort er alleen met schrijfrecht bij.
        await klik(m, 'Bewerken');
        const b = modal(page, 'Factuur bewerken');
        await b.waitFor();
        uit.bewerk[d.nummer] = (await knoppen(b.locator('.modal-foot'))).filter((k) => /^(Opslaan|Verwijderen)$/.test(k));
        await sluitModal(b);
      } else {
        await sluitModal(m);
      }
      await sluitAlles(scherm);
    }
    await naarFinancien(scherm, 'Contracten');
    uit.nieuw.contracten = await inhoud(page).getByRole('button', { name: /Nieuw contract/ }).isEnabled();
    for (const d of docs.contracten) {
      await inhoud(page).locator('tr.bk-row').filter({ hasText: d.nummer }).click();
      const m = modal(page, `Contract ${d.nummer}`);
      await m.waitFor();
      await rustig(scherm);
      uit.contracten[d.nummer] = (await knoppen(m)).filter((k) => SCHRIJFKNOPPEN.contract.some((r) => r.test(k)));
      await sluitModal(m);
    }
    return uit;
  }

  const controle = await uiStap('controle: de medewerker ziet de knoppen bij dezelfde stukken', async () => {
    const lid = await medewerker();
    await ververs(lid);
    const inv = await inventaris(lid);
    const missen = [];
    for (const soort of ['offertes', 'facturen', 'contracten']) {
      for (const d of docs[soort]) for (const k of d.verwachtLid) if (!inv[soort][d.nummer].includes(k)) missen.push(`${d.nummer}: ${k}`);
    }
    for (const d of docs.facturen.filter((x) => x.bewerk)) if (!inv.bewerk[d.nummer].includes('Opslaan')) missen.push(`${d.nummer}: Opslaan in het bewerkvenster`);
    verwacht(missen.length === 0, `de medewerker mist knoppen (dan zegt de rollencontrole niets): ${missen.join('; ')}`);
    verwacht(inv.nieuw.offertes && inv.nieuw.facturen && inv.nieuw.contracten, '"+ Nieuw" staat uit voor de medewerker');
    return true;
  });

  await uiStap('controle: de beheerder ziet "Goedkeuren" bij de offerte die wacht', async () => {
    const beheer = await openWerkruimte(w.beheerder, 'beheerder', w.orgId, { tijdelijk: true });
    await naarFinancien(beheer, 'Offertes');
    const d = docs.offertes[0];
    const m = await openDocument(beheer, d.nummer, 'Offerte');
    const gezien = await knoppen(m);
    for (const k of d.verwachtBeheerder) verwacht(gezien.includes(k), `de beheerder mist "${k}": ${gezien.join(', ')}`);
  });

  for (const [rolnaam, gebruiker] of [['kijker', w.kijker], ['lezer', w.lezer], ['boekhouder', w.boekhouder]]) {
    await uiStap(`${rolnaam}: geen Verstuur/Goedkeuren/Crediteren/Intrekken, geen "+ Nieuw"`, async () => {
      const scherm = await openWerkruimte(gebruiker, rolnaam, w.orgId, { tijdelijk: true });
      const inv = await inventaris(scherm);
      const teVeel = [];
      for (const soort of ['offertes', 'facturen', 'contracten']) {
        for (const [nummer, lijst] of Object.entries(inv[soort])) if (lijst.length) teVeel.push(`${nummer}: ${lijst.join(', ')}`);
      }
      for (const [nummer, lijst] of Object.entries(inv.bewerk)) if (lijst.length) teVeel.push(`${nummer} bewerkvenster: ${lijst.join(', ')}`);
      for (const [pagina, aan] of Object.entries(inv.nieuw)) if (aan) teVeel.push(`"+ Nieuw" aan op ${pagina}`);
      verwacht(teVeel.length === 0, `${rolnaam} ziet knoppen die iets veranderen: ${teVeel.join('; ')}`);
    });
  }
  return controle;
}

// ── Agenda: Google koppelen, opnieuw koppelen, loskoppelen ─────────────────

/** Instellingen → Agenda, via het accountmenu zoals een gebruiker. */
async function naarAgendaInstellingen(scherm) {
  const page = scherm.page;
  await sluitAlles(scherm);
  await page.locator('.user-trigger').click();
  await page.locator('.user-menu [role="menuitem"]').filter({ hasText: /^Agenda$/ }).click();
  await inhoud(page).locator('#calendar-settings h3').filter({ hasText: "Agenda's en koppelingen" }).waitFor({ timeout: 15000 });
  await rustig(scherm);
}

/**
 * Speelt Google: elke stap naar accounts.google.com krijgt meteen "toestaan"
 * (of `fout`) en gaat terug naar de callback, zoals de echte Google dat na een
 * klik doet. Geeft de opgevangen toestemmingslinks terug.
 */
async function speelGoogle(scherm, sleutel, { fout = null } = {}) {
  const gezien = [];
  await scherm.context.unroute('https://accounts.google.com/**').catch(() => undefined);
  await scherm.context.route('https://accounts.google.com/**', async (route) => {
    const url = new URL(route.request().url());
    gezien.push(url);
    const terug = new URL(url.searchParams.get('redirect_uri'));
    if (fout) terug.searchParams.set('error', fout);
    else terug.searchParams.set('code', geefCode(sleutel, GOOGLE_ALLES));
    terug.searchParams.set('state', url.searchParams.get('state'));
    await route.fulfill({ status: 302, headers: { location: terug.toString() } });
  });
  return gezien;
}

async function scenarioAgenda() {
  groep('UI: agenda koppelen');
  const { w } = t;
  const googleUi = account('google-ui', {
    provider: 'google', id: `g-ui-${Date.now()}`, email: `ui.${Date.now()}@gmail.test`, naam: 'UI Medewerker',
    agendas: [
      { id: 'ui-primair', summary: 'Werk', primary: true, accessRole: 'owner', backgroundColor: '#9fe1e7', selected: true },
      { id: 'ui-feestdagen', summary: 'Feestdagen in Nederland', accessRole: 'reader', selected: true },
    ],
  });

  await uiStap('een geweigerde koppeling: terug in Instellingen → Agenda, met uitleg', async () => {
    const lid = await medewerker();
    await lid.page.goto(`${APP}/?calendar_error=geweigerd&calendar_provider=google`, { waitUntil: 'domcontentloaded' });
    await inhoud(lid.page).locator('#calendar-settings').waitFor({ timeout: 30000 });
    await rustig(lid);
    const fout = inhoud(lid.page).locator('.calendar-settings-page .error');
    await wachtTot(async () => /geen toestemming gegeven/.test(await fout.innerText().catch(() => '')), { melding: 'geen uitleg bij de geweigerde koppeling' });
    verwacht(/Google/.test(await fout.innerText()), 'de uitleg noemt Google niet');
    verwacht(!new URL(lid.page.url()).searchParams.has('calendar_error'), `het adres is niet schoon: ${lid.page.url()}`);
  }, { foutmelding: /geen toestemming gegeven/ });

  await uiStap('Google koppelen met de knop: terug in de app, en de koppeling staat meteen in beeld', async () => {
    const lid = await medewerker();
    await naarAgendaInstellingen(lid);
    const gezien = await speelGoogle(lid, 'google-ui');
    const sinds = server.verkeer.length;
    await inhoud(lid.page).getByRole('button', { name: 'Google koppelen' }).click();
    const kaart = inhoud(lid.page).locator('.connection-card').filter({ hasText: googleUi.email });
    await wachtTot(async () => (await kaart.count()) > 0, { timeout: 45000, melding: 'de nieuwe koppeling staat niet in beeld' });
    await rustig(lid);
    gelijk(gezien.length, 1, 'naar Google');
    gelijk(gezien[0].searchParams.get('prompt'), 'select_account consent', 'accountkeuze');
    verwachtAanroep(sinds, { functie: 'calendar-integrations', actie: 'oauthComplete' }, 'afronden');
    gelijk(tekst(await kaart.locator('.connection-status').textContent()), 'Actief', 'status');
    verwacht(await kaart.locator('.source-row').filter({ hasText: 'Werk' }).count() === 1, 'de hoofdagenda staat er niet bij');
    const succes = inhoud(lid.page).locator('.calendar-settings-page .success');
    verwacht(/staat nu in je werkruimte/.test(await succes.innerText().catch(() => '')), 'geen bevestiging onder de instellingen');
    verwacht(!new URL(lid.page.url()).searchParams.has('calendar_code'), `de code staat nog in het adres: ${lid.page.url()}`);
    // De hoofdagenda is meteen schrijfbaar en getoond; feestdagen getoond maar niet schrijfbaar.
    const werk = kaart.locator('.source-row').filter({ hasText: 'Werk' });
    verwacht(await werk.getByLabel('Schrijven').isChecked(), 'hoofdagenda niet schrijfbaar');
    verwacht(!(await kaart.locator('.source-row').filter({ hasText: 'Feestdagen' }).getByLabel('Schrijven').isChecked()), 'feestdagen schrijfbaar');
  });

  await uiStap('verlopen koppeling: uitleg en "Opnieuw koppelen" met het bekende account', async () => {
    const lid = await medewerker();
    sql(`update public.calendar_connections set status = 'expired', last_error = 'Google geeft ResoFly geen toegang meer tot deze agenda (ingetrokken of verlopen). Koppel het account opnieuw.'
          where organization_id = ${q(w.orgId)} and provider_account_email = ${q(googleUi.email)}`);
    await inhoud(lid.page).getByRole('button', { name: 'Ververs' }).first().click();
    await rustig(lid);
    const kaart = inhoud(lid.page).locator('.connection-card').filter({ hasText: googleUi.email });
    await wachtTot(async () => tekst(await kaart.locator('.connection-status').textContent()) === 'Verlopen', { melding: 'status niet "Verlopen"' });
    verwacht(/Koppel het account opnieuw/.test(await kaart.locator('.connection-hint').innerText()), 'geen uitleg onder de koppeling');
    const gezien = await speelGoogle(lid, 'google-ui', { fout: 'access_denied' });
    await kaart.getByRole('button', { name: 'Opnieuw koppelen' }).click();
    const fout = inhoud(lid.page).locator('.calendar-settings-page .error');
    await wachtTot(async () => /geen toestemming gegeven/.test(await fout.innerText().catch(() => '')), { timeout: 45000, melding: 'geen uitleg na annuleren' });
    gelijk(gezien.length, 1, 'naar Google');
    gelijk([gezien[0].searchParams.get('login_hint'), gezien[0].searchParams.get('prompt')], [googleUi.email, 'consent'], 'het bekende account');
    // Annuleren verandert niets: de koppeling staat er nog, met dezelfde status.
    gelijk(sqlRij(`select status from public.calendar_connections where organization_id = ${q(w.orgId)} and provider_account_email = ${q(googleUi.email)}`).status, 'expired', 'status na annuleren');
  }, { foutmelding: /geen toestemming gegeven/ });

  await uiStap('opnieuw koppelen gelukt: weer actief, met dezelfde agenda\'s', async () => {
    const lid = await medewerker();
    const kaart = inhoud(lid.page).locator('.connection-card').filter({ hasText: googleUi.email });
    const voor = sqlRijen(`select s.id from public.calendar_sources s join public.calendar_connections c on c.id = s.connection_id
                            where c.organization_id = ${q(w.orgId)} and c.provider_account_email = ${q(googleUi.email)} order by s.id`).map((r) => r.id);
    await speelGoogle(lid, 'google-ui');
    await kaart.getByRole('button', { name: 'Opnieuw koppelen' }).click();
    await wachtTot(async () => tekst(await inhoud(lid.page).locator('.connection-card').filter({ hasText: googleUi.email }).locator('.connection-status').textContent().catch(() => '')) === 'Actief', { timeout: 45000, melding: 'niet weer actief' });
    const na = sqlRijen(`select s.id from public.calendar_sources s join public.calendar_connections c on c.id = s.connection_id
                          where c.organization_id = ${q(w.orgId)} and c.provider_account_email = ${q(googleUi.email)} order by s.id`).map((r) => r.id);
    gelijk(na, voor, 'dezelfde agenda\'s');
  });

  await uiStap('loskoppelen vraagt eerst, en zegt wat er gebeurt (uren blijven)', async () => {
    const lid = await medewerker();
    const kaart = inhoud(lid.page).locator('.connection-card').filter({ hasText: googleUi.email });
    lid.plan.push({ weiger: true });
    const dialogen = lid.dialogen.length;
    await kaart.getByRole('button', { name: 'Loskoppelen' }).click();
    await wachtTot(async () => lid.dialogen.length > dialogen, { melding: 'geen bevestiging gevraagd' });
    const vraag = lid.dialogen.at(-1).tekst;
    verwacht(/Geregistreerde uren blijven staan/.test(vraag) && /Opnieuw koppelen/.test(vraag), `bevestiging zonder uitleg: ${vraag}`);
    verwacht(vraag.includes(googleUi.email), 'het account staat niet in de vraag');
    gelijk(sqlRij(`select count(*)::int as n from public.calendar_connections where organization_id = ${q(w.orgId)} and provider_account_email = ${q(googleUi.email)}`).n, 1, 'na "annuleren" toch losgekoppeld');
  });
}

// ── Mollie koppelen: Instellingen → Online betalen ─────────────────────────

/** Naar Instellingen → Online betalen, via het accountmenu zoals een gebruiker. */
async function naarOnlineBetalen(scherm) {
  const page = scherm.page;
  await sluitAlles(scherm);
  await page.locator('.user-trigger').click();
  await page.locator('.user-menu [role="menuitem"]').filter({ hasText: /^Online betalen$/ }).click();
  await inhoud(page).locator('h3').filter({ hasText: 'Online betalen (Mollie)' }).waitFor({ timeout: 15000 });
  await rustig(scherm);
}

/** De Mollie-kaart in Instellingen. */
const mollieKaart = (page) => inhoud(page).locator('section.settings-card').filter({ has: page.locator('h3', { hasText: 'Online betalen (Mollie)' }) });

/**
 * Waarom in de browser: de functie zelf toetst run.mjs (scenario mollie). Hier
 * gaat het om wat de beheerder ziet. Tot 6 november 2026 stond bij een
 * geweigerde key alleen "Edge Function returned a non-2xx status code" in
 * beeld, en zag je niet welk Mollie-account gekoppeld was.
 */
async function scenarioMollie() {
  groep('UI: Mollie koppelen (Instellingen → Online betalen)');
  const { w } = t;
  const geweigerd = `test_uigeweigerd${Date.now()}abcdefghij`;
  const goed = `test_uigoed${Date.now()}abcdefghijklmnop`;
  post.mollie.geweigerdeSleutels.add(geweigerd);
  post.mollie.profielen.set(goed, { id: 'pfl_uistudio01', name: 'UI Studio Mollie', website: 'https://ui-studio.test', status: 'verified' });
  let eigenaar = null;
  let beheer = null;

  // Alleen de eigenaar koppelt of vervangt de key (7 november 2026); een
  // beheerder ziet de koppeling en kan ontkoppelen.
  await uiStap('als beheerder, nog niets gekoppeld: geen formulier, wel de uitleg dat alleen de eigenaar koppelt', async () => {
    beheer = await openWerkruimte(w.beheerder, 'beheerder-mollie', w.orgId);
    await naarOnlineBetalen(beheer);
    const kaart = mollieKaart(beheer.page);
    await wachtTot(async () => /Niet gekoppeld/.test(await kaart.innerText()), { melding: 'geen status "Niet gekoppeld"' });
    gelijk(await kaart.locator('input[type="password"]').count(), 0, 'invoerveld voor de key');
    gelijk(await kaart.getByRole('button', { name: 'Mollie koppelen' }).count(), 0, 'knop "Mollie koppelen"');
    verwacht(/Alleen de eigenaar van de organisatie kan Mollie koppelen/.test(await kaart.innerText()), 'geen uitleg voor de beheerder');
  });

  await uiStap('als eigenaar: niet gekoppeld, met het formulier om te koppelen', async () => {
    eigenaar = await openWerkruimte(w.eigenaar, 'eigenaar-mollie', w.orgId);
    await naarOnlineBetalen(eigenaar);
    const kaart = mollieKaart(eigenaar.page);
    await wachtTot(async () => /Niet gekoppeld/.test(await kaart.innerText()), { melding: 'geen status "Niet gekoppeld"' });
    verwacht(await kaart.getByRole('button', { name: 'Mollie koppelen' }).isVisible(), 'geen knop "Mollie koppelen"');
  });

  await uiStap('een key die Mollie weigert: de reden staat in beeld, niet "non-2xx", en er is niets gekoppeld', async () => {
    const kaart = mollieKaart(eigenaar.page);
    const sinds = server.verkeer.length;
    await kaart.locator('input[type="password"]').fill(geweigerd);
    await kaart.getByRole('button', { name: 'Mollie koppelen' }).click();
    const fout = kaart.locator('.error');
    await wachtTot(async () => /Mollie weigerde deze API-key/.test(await fout.innerText().catch(() => '')), { melding: 'de reden van de weigering staat niet in beeld' });
    verwacht(!/non-2xx/i.test(await fout.innerText()), `kale functiefout in beeld: ${await fout.innerText()}`);
    gelijk(aanroepen(sinds, { functie: 'invoice-workflow', actie: 'saveInvoiceMollieKey' }).map((r) => r.status), [422], 'antwoord van de functie');
    gelijk(sqlRij(`select count(*)::int as n from public.organization_invoice_mollie_settings where organization_id = ${q(w.orgId)} and status = 'connected'`).n, 0, 'gekoppeld');
  }, { toegestaan: [{ functie: 'invoice-workflow', actie: 'saveInvoiceMollieKey', status: 422 }], foutmelding: /Mollie weigerde deze API-key/ });

  await uiStap('een goede test-key: gekoppeld, met het Mollie-profiel en de waarschuwing voor de testmodus', async () => {
    const kaart = mollieKaart(eigenaar.page);
    const sinds = server.verkeer.length;
    await kaart.locator('input[type="password"]').fill(goed);
    await kaart.getByRole('button', { name: 'Mollie koppelen' }).click();
    await wachtTot(async () => /Gekoppeld/.test(await kaart.locator('.billing-summary').innerText().catch(() => '')), { melding: 'niet "Gekoppeld"' });
    verwachtAanroep(sinds, { functie: 'invoice-workflow', actie: 'saveInvoiceMollieKey' }, 'koppelen');
    const profiel = tekst(await kaart.locator('.mollie-profile').innerText());
    verwacht(profiel.includes('UI Studio Mollie') && profiel.includes('https://ui-studio.test'), `profiel: ${profiel}`);
    verwacht(/Testmodus: een betaling via de betaallink is niet echt/.test(await kaart.locator('.settings-warning').innerText()), 'geen waarschuwing voor de testmodus');
    verwacht(/UI Studio Mollie/.test(await kaart.locator('.success').innerText()), 'de bevestiging noemt het profiel niet');
    gelijk(await kaart.locator('input[type="password"]').inputValue(), '', 'het veld met de key is leeg');
    verwacht(await kaart.getByRole('button', { name: 'Key vervangen' }).isVisible(), 'de eigenaar ziet geen "Key vervangen"');
    verwacht(!(await eigenaar.page.content()).includes(goed.slice(5)), 'de key staat nog in de pagina');
  });

  await uiStap('na herladen: dezelfde status, het profiel en de laatste vier tekens', async () => {
    await eigenaar.page.reload({ waitUntil: 'domcontentloaded' });
    await eigenaar.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 60000 });
    await naarOnlineBetalen(eigenaar);
    const kaart = mollieKaart(eigenaar.page);
    await wachtTot(async () => /Gekoppeld/.test(await kaart.locator('.billing-summary').innerText().catch(() => '')), { melding: 'niet "Gekoppeld" na herladen' });
    const samenvatting = tekst(await kaart.locator('.billing-summary').innerText());
    verwacht(samenvatting.includes(`••••${goed.slice(-4)}`) && samenvatting.includes('UI Studio Mollie'), `samenvatting: ${samenvatting}`);
  });

  // Facturen versturen: per e-mail of via Mollie (7 november 2026). Tot dan was
  // de koppeling zelf de keuze; nu kiest de eigenaar of beheerder het hier, en
  // blijft Mollie gekoppeld. Of de functies zich eraan houden, toetst run.mjs
  // (scenario verzendwijze); hier wat er in beeld staat en wat er opgeslagen wordt.
  const verzendKaart = (page) => inhoud(page).locator('section.send-method-card');
  const keuze = (page, naam) => verzendKaart(page).getByRole('radio', { name: new RegExp(`^${naam}`) });

  await uiStap('Facturen versturen: nog niets gekozen en Mollie gekoppeld, dus "Via Mollie" staat aan', async () => {
    gelijk(sqlRij(`select invoice_send_method from public.company_settings where organization_id = ${q(w.orgId)}`)?.invoice_send_method ?? null, null, 'keuze in de database');
    await wachtTot(async () => (await keuze(eigenaar.page, 'Via Mollie').getAttribute('aria-checked')) === 'true', { melding: '"Via Mollie" staat niet aan' });
    gelijk(await keuze(eigenaar.page, 'Per e-mail').getAttribute('aria-checked'), 'false', '"Per e-mail"');
  });

  await uiStap('de eigenaar kiest "Per e-mail": opgeslagen, Mollie blijft gekoppeld, en na herladen staat het er nog', async () => {
    await keuze(eigenaar.page, 'Per e-mail').click();
    await wachtTot(async () => /per e-mail, zonder betaallink van Mollie/.test(await verzendKaart(eigenaar.page).locator('.success').innerText().catch(() => '')), { melding: 'geen bevestiging' });
    gelijk(sqlRij(`select invoice_send_method from public.company_settings where organization_id = ${q(w.orgId)}`)?.invoice_send_method, 'email', 'keuze in de database');
    gelijk(sqlRij(`select status from public.organization_invoice_mollie_settings where organization_id = ${q(w.orgId)}`)?.status, 'connected', 'Mollie-koppeling');
    verwacht(/Mollie blijft gekoppeld/.test(await verzendKaart(eigenaar.page).innerText()), 'geen uitleg dat Mollie gekoppeld blijft');
    // Na het opslaan ververst de app; eerst dat afwachten, anders breekt het
    // herladen hem af ("Failed to fetch" in de console).
    await rustig(eigenaar);
    await eigenaar.page.reload({ waitUntil: 'domcontentloaded' });
    await eigenaar.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 60000 });
    await naarOnlineBetalen(eigenaar);
    await wachtTot(async () => (await keuze(eigenaar.page, 'Per e-mail').getAttribute('aria-checked')) === 'true', { melding: '"Per e-mail" staat niet aan na herladen' });
    gelijk(await keuze(eigenaar.page, 'Via Mollie').getAttribute('aria-checked'), 'false', '"Via Mollie" na herladen');
  });

  await uiStap('een lid ziet de keuze, maar kan hem niet wijzigen', async () => {
    const lid = await medewerker();
    // Het werkblad van het lid kan uit een eerder scenario komen: eerst verversen.
    await lid.page.reload({ waitUntil: 'domcontentloaded' });
    await lid.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 60000 });
    await naarOnlineBetalen(lid);
    const kaart = verzendKaart(lid.page);
    await wachtTot(async () => /Je facturen gaan per e-mail/.test(await kaart.innerText().catch(() => '')), { melding: 'het lid ziet de keuze niet' });
    verwacht(/Alleen de eigenaar of een beheerder kan dit wijzigen/.test(await kaart.innerText()), 'geen uitleg voor een lid');
    gelijk(await kaart.getByRole('radio').count(), 0, 'keuzeknoppen voor een lid');
  });

  await uiStap('de eigenaar kiest weer "Via Mollie"', async () => {
    await keuze(eigenaar.page, 'Via Mollie').click();
    await wachtTot(async () => /via Mollie, met een betaallink/.test(await verzendKaart(eigenaar.page).locator('.success').innerText().catch(() => '')), { melding: 'geen bevestiging' });
    gelijk(sqlRij(`select invoice_send_method from public.company_settings where organization_id = ${q(w.orgId)}`)?.invoice_send_method, 'mollie', 'keuze in de database');
    await rustig(eigenaar);
  });

  await uiStap('de beheerder ziet de koppeling met het profiel, vervangt de key niet, en ontkoppelen vraagt eerst', async () => {
    await beheer.page.reload({ waitUntil: 'domcontentloaded' });
    await beheer.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 60000 });
    await naarOnlineBetalen(beheer);
    const kaart = mollieKaart(beheer.page);
    await wachtTot(async () => /Gekoppeld/.test(await kaart.locator('.billing-summary').innerText().catch(() => '')), { melding: 'de beheerder ziet niet "Gekoppeld"' });
    verwacht(tekst(await kaart.locator('.mollie-profile').innerText()).includes('UI Studio Mollie'), 'de beheerder ziet het profiel niet');
    gelijk(await kaart.locator('input[type="password"]').count(), 0, 'invoerveld voor de key');
    gelijk(await kaart.getByRole('button', { name: 'Key vervangen' }).count(), 0, 'knop "Key vervangen"');
    verwacht(/Alleen de eigenaar van de organisatie kan de key vervangen/.test(await kaart.innerText()), 'geen uitleg voor de beheerder');
    const dialogen = beheer.dialogen.length;
    beheer.plan.push({});
    await kaart.getByRole('button', { name: 'Mollie ontkoppelen' }).click();
    await wachtTot(async () => beheer.dialogen.length > dialogen, { melding: 'geen bevestiging gevraagd' });
    verwacht(/Mollie ontkoppelen voor facturen\?/.test(beheer.dialogen.at(-1).tekst), `vraag: ${beheer.dialogen.at(-1).tekst}`);
    await wachtTot(async () => /Niet gekoppeld/.test(await kaart.locator('.billing-summary').innerText().catch(() => '')), { melding: 'niet "Niet gekoppeld" na ontkoppelen' });
    gelijk(sqlRij(`select status, api_key_encrypted from public.organization_invoice_mollie_settings where organization_id = ${q(w.orgId)}`), { status: 'revoked', api_key_encrypted: null }, 'database');
    gelijk(sqlRijen(`select action, actor_user_id from public.audit_logs where organization_id = ${q(w.orgId)} and entity_type = 'mollie_connection' order by created_at, id`),
      [{ action: 'mollie_connected', actor_user_id: w.eigenaar.id }, { action: 'revoked', actor_user_id: w.beheerder.id }], 'auditlog');
  });

  await uiStap('een lid ziet Online betalen zonder formulier en zonder status', async () => {
    const lid = await medewerker();
    const sinds = server.verkeer.length;
    await naarOnlineBetalen(lid);
    const kaart = mollieKaart(lid.page);
    verwacht(/Alleen de eigenaar van de organisatie kan Mollie koppelen/.test(await kaart.innerText()), 'geen uitleg voor een lid');
    gelijk(await kaart.locator('input[type="password"]').count(), 0, 'invoerveld voor de key');
    gelijk(aanroepen(sinds, { functie: 'invoice-workflow', actie: 'getInvoiceMollieStatus' }).length, 0, 'statusaanroepen');
  });

  await sluit(beheer);
  await sluit(eigenaar);
}

// ── Documenten: maken, bewerken, veilig tonen, delen, verwijderen ───────────

/** Kwaadaardige inhoud zoals iemand hem via de API of een plakactie kan opslaan. */
const KWAAD = '<p>Gewone tekst</p><img src="x" onerror="window.__xss=(window.__xss||0)+1"><script>window.__xss=(window.__xss||0)+1</script>'
  + '<a href="javascript:window.__xss=(window.__xss||0)+1">klik hier</a><svg onload="window.__xss=(window.__xss||0)+1"></svg>'
  + '<iframe src="javascript:parent.__xss=(parent.__xss||0)+1"></iframe><p style="background:url(javascript:alert(1))" onclick="window.__xss=9">nog meer</p>';

/** Naar Inhoud → het dossier van een klant, via het menu zoals een gebruiker. */
async function naarKlantdossier(scherm, klantNaam) {
  const page = scherm.page;
  await sluitAlles(scherm);
  await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Inhoud/ }).first().click();
  await rustig(scherm);
  // Stond Inhoud al open in dit dossier, dan blijft hij daar: niets te doen.
  const huidig = inhoud(page).locator('.odrv-crumbs .odrv-crumb-current').first();
  if (tekst(await huidig.innerText().catch(() => '')) === klantNaam) return;
  // Anders terug naar de bovenste laag (de organisatie) en dan de klant openen.
  const wortel = inhoud(page).locator('.odrv-crumbs button').first();
  if (await wortel.isVisible().catch(() => false)) { await wortel.click(); await rustig(scherm); }
  const rij = inhoud(page).locator('.odrv-row').filter({ hasText: klantNaam }).first();
  await rij.waitFor({ timeout: 15000 });
  await rij.click();
  await rustig(scherm);
  await wachtTot(async () => tekst(await huidig.innerText().catch(() => '')) === klantNaam, { melding: `dossier van ${klantNaam} niet open` });
}

/** Een open venster voor een document (nieuw of bewerken). */
function documentVenster(page) {
  return page.locator('section.modal').filter({ has: page.locator('.modal-head h3', { hasText: /^(Nieuw document|Document bewerken)$/ }) });
}

async function scenarioDocumenten() {
  groep('UI: documenten');
  const { w } = t;
  const titel = `Projectplan ${Date.now().toString(36)}`;

  const nieuw = await uiStap('nieuw document via Inhoud → klant A → Nieuw → Document, en het staat meteen in de lijst', async () => {
    const lid = await medewerker();
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.drive-new').click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Document', exact: true }).click();
    const venster = documentVenster(page);
    await venster.waitFor({ timeout: 10000 });
    await venster.getByPlaceholder('Documenttitel').fill(titel);
    const editor = venster.locator('[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.type('Fase 1: ontwerp. Fase 2: bouw.');
    gelijk(tekst(await veld(venster, 'Klant').locator('.select-value').innerText()), w.klantA.name, 'klant al ingevuld vanuit het dossier');
    await venster.getByRole('button', { name: 'Opslaan' }).click();
    await venster.waitFor({ state: 'detached', timeout: 15000 });
    await rustig(lid);
    const rij = sqlRij(`select id, client_id, created_by, content from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`);
    verwacht(rij, 'document niet opgeslagen');
    gelijk([rij.client_id, rij.created_by], [w.klantA.id, w.medewerker.id], 'klant en maker');
    verwacht(rij.content.includes('Fase 1: ontwerp.'), `inhoud niet opgeslagen: ${rij.content}`);
    await inhoud(page).locator('.odrv-row').filter({ hasText: titel }).first().waitFor({ timeout: 10000 });
    return rij;
  });

  await uiStap('openen, de titel aanpassen en opslaan', async () => {
    if (!nieuw) throw new Error('geen document');
    const lid = await medewerker();
    const page = lid.page;
    await inhoud(page).locator('.odrv-row').filter({ hasText: titel }).first().click();
    const venster = documentVenster(page);
    await venster.waitFor({ timeout: 10000 });
    verwacht((await venster.locator('.rich-text-editor, [contenteditable="true"]').first().innerText()).includes('Fase 1'), 'inhoud niet in de editor');
    await venster.getByPlaceholder('Documenttitel').fill(`${titel} v2`);
    await venster.getByRole('button', { name: 'Opslaan' }).click();
    await venster.waitFor({ state: 'detached', timeout: 15000 });
    await rustig(lid);
    gelijk(sqlRij(`select title from public.documents where id = ${q(nieuw.id)}`).title, `${titel} v2`, 'titel');
    await inhoud(page).locator('.odrv-row').filter({ hasText: `${titel} v2` }).first().waitFor({ timeout: 10000 });
  });

  const kwaad = await uiStap('kwaadaardige inhoud in een document wordt in de app niet uitgevoerd', async () => {
    const res = await rest('documents?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, title: 'Lokaas in de app', content: KWAAD },
    });
    gelukt(res, 'document met kwaadaardige inhoud');
    const lid = await medewerker();
    const page = lid.page;
    await ververs(lid);
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.odrv-row').filter({ hasText: 'Lokaas in de app' }).first().click();
    const venster = documentVenster(page);
    await venster.waitFor({ timeout: 10000 });
    await slaap(800);
    const uitgevoerd = await page.evaluate(() => window.__xss ?? 0);
    gelijk(uitgevoerd, 0, 'scripts uitgevoerd in de app');
    const html = await venster.locator('[contenteditable], .rich-text-viewer').first().innerHTML();
    verwacht(!/onerror|onload|onclick|javascript:|<script|<iframe|<svg/i.test(html), `gevaarlijke inhoud staat nog in de editor: ${html.slice(0, 300)}`);
    verwacht(html.includes('Gewone tekst'), 'de gewone tekst is weg');
    await sluitModal(modal(page, 'Document bewerken'));
    return res.json[0];
  });

  await uiStap('kwaadaardige inhoud op de openbare deelpagina wordt niet uitgevoerd', async () => {
    const intern = gelukt(await rest('documents?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, title: 'Lokaas op de deelpagina', content: KWAAD },
    }), 'intern document')[0];
    const ontvanger = `deelpagina.${Date.now()}@elders.test`;
    gelukt(await roep('file-share', {
      token: w.medewerker.token, origin: APP,
      body: { action: 'share', organizationId: w.orgId, itemType: 'document', itemId: intern.id, recipients: [{ kind: 'link', email: ontvanger }] },
    }), 'delen');
    const mail = mailsAan(ontvanger).at(-1);
    const link = `${mail?.html} ${mail?.text}`.match(/https?:\/\/[^\s"'<>]+\/gedeeld\/[A-Za-z0-9_-]{20,}/)?.[0];
    verwacht(link, 'geen deellink in de mail');
    const klant = await openAlsKlant(link, 'ontvanger');
    const page = klant.page;
    await page.locator('.share-public-row').filter({ hasText: 'Lokaas op de deelpagina' }).getByRole('button', { name: 'Lezen' }).click();
    await page.locator('.rich-text-viewer').first().waitFor({ timeout: 10000 });
    await slaap(800);
    gelijk(await page.evaluate(() => window.__xss ?? 0), 0, 'scripts uitgevoerd op de deelpagina');
    const html = await page.locator('.rich-text-viewer').first().innerHTML();
    verwacht(!/onerror|onload|onclick|javascript:|<script|<iframe|<svg/i.test(html), `gevaarlijke inhoud op de deelpagina: ${html.slice(0, 300)}`);
    verwacht(html.includes('Gewone tekst'), 'de gewone tekst ontbreekt op de deelpagina');
  });

  await uiStap('verwijderen via het menu vraagt eerst, en haalt het document weg', async () => {
    if (!kwaad) throw new Error('geen document om te verwijderen');
    const lid = await medewerker();
    const page = lid.page;
    const rij = inhoud(page).locator('.odrv-row').filter({ hasText: 'Lokaas in de app' }).first();
    await rij.locator('.odrv-td-act button').first().click();
    const dialogen = lid.dialogen.length;
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Verwijderen', exact: true }).click();
    await wachtTot(async () => lid.dialogen.length > dialogen, { melding: 'geen bevestiging gevraagd' });
    await wachtTot(async () => sqlRij(`select count(*)::int as n from public.documents where id = ${q(kwaad.id)}`).n === 0, { melding: 'document niet verwijderd' });
    await rustig(lid);
    await wachtTot(async () => (await inhoud(page).locator('.odrv-row').filter({ hasText: 'Lokaas in de app' }).count()) === 0, { melding: 'document staat nog in de lijst' });
  });

  await uiStap('de kijker ziet documenten, maar geen knop om te maken en geen opslaan', async () => {
    const kijker = await openWerkruimte(w.kijker, 'kijker', w.orgId, { tijdelijk: true });
    const page = kijker.page;
    await naarKlantdossier(kijker, w.klantA.name);
    gelijk(await inhoud(page).locator('.drive-new').count(), 0, 'knop Nieuw voor de kijker');
    await inhoud(page).locator('.odrv-row').filter({ hasText: `${titel} v2` }).first().click();
    const venster = page.locator('section.modal').first();
    await venster.waitFor({ timeout: 10000 });
    gelijk(await venster.getByRole('button', { name: 'Opslaan' }).count(), 0, 'Opslaan voor de kijker');
    gelijk(await venster.getByRole('button', { name: 'Verwijderen' }).count(), 0, 'Verwijderen voor de kijker');
  });
}

// ── Bank: mutaties met de hand boeken ──────────────────────────────────────

/** Een transactie in de lijst "Af te letteren", op een stuk tekst. */
const bankRij = (page, patroon) => inhoud(page).locator('.bank-tx').filter({ hasText: patroon });

async function bankTab(scherm, naam) {
  await inhoud(scherm.page).locator('.bank-toolbar .bk-seg button').filter({ hasText: new RegExp(`^${naam}`) }).click();
  await rustig(scherm);
}

/**
 * Waarom in de browser: de database toetst run.mjs (scenario bank). Hier gaat
 * het om wat de gebruiker doet: een mutatie invoeren in het venster, de
 * voorgestelde verdeling over twee facturen aanvullen en boeken met een eigen
 * omschrijving, terugdraaien, en wat hij ziet als de bank dezelfde mutatie
 * later levert (samengevoegd, losmaken, weer samenvoegen).
 */
async function scenarioBank() {
  groep('UI: bank — mutaties met de hand boeken');
  const { w } = t;
  const jaar = datum().slice(0, 4);
  const nummers = [`FAC-${jaar}-0901`, `FAC-${jaar}-0902`];
  const omschrijving = `Betaling ${nummers[0]} en ${nummers[1]} plus meerwerk`;

  const b = await stap('rekeningschema, bankrekening en twee verzonden facturen', async () => {
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: w.orgId }, w.medewerker.token), 'rekeningschema');
    const grootboek = gelukt(await rest(`ledger_accounts?select=id&organization_id=eq.${w.orgId}&code=eq.1100`, { token: w.medewerker.token }), 'rekening 1100')[0];
    const rekening = gelukt(await rest('bank_accounts?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, name: 'Zakelijk UI', iban: 'NL91ABNA0417164300', currency: 'EUR', ledger_account_id: grootboek.id, is_active: true, source: 'import' },
    }), 'bankrekening')[0];
    const f1 = await factuurVerstuurd(w, nummers[0]);
    const f2 = await factuurVerstuurd(w, nummers[1]);
    return { rekening, f1, f2 };
  });
  if (!b) return;

  await uiStap('mutatie invoeren met de knop: het venster, opslaan, en de mutatie staat open als "handmatig"', async () => {
    const lid = await medewerker();
    const page = lid.page;
    // De app laadde vóór het rekeningschema en de bankrekening bestonden.
    await ververs(lid);
    await naarFinancien(lid, 'Bank');
    const sinds = server.verkeer.length;
    await inhoud(page).getByRole('button', { name: 'Mutatie invoeren' }).first().click();
    const m = modal(page, 'Mutatie invoeren');
    await m.waitFor({ timeout: 10000 });
    await m.getByRole('button', { name: /^Ontvangst/ }).click();
    await veld(m, 'Bedrag').locator('input').fill('397,26');
    await veld(m, 'Tegenpartij').locator('input').fill(w.klantA.name);
    await veld(m, 'Omschrijving').locator('input').fill(omschrijving);
    await klik(m, 'Opslaan');
    await m.waitFor({ state: 'detached', timeout: 10000 });
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'create_manual_bank_transaction' }, 'invoeren');
    const rij = bankRij(page, 'plus meerwerk').first();
    await rij.waitFor({ timeout: 10000 });
    verwacht(/handmatig/i.test(await rij.innerText()), 'geen label "handmatig"');
  });

  await uiStap('de verdeling staat klaar (twee facturen met hun openstaande bedrag, de rest op een grootboekregel) en boekt met een eigen omschrijving', async () => {
    const lid = t.lid;
    const page = lid.page;
    const rij = bankRij(page, 'plus meerwerk').first();
    const regels = rij.locator('.bank-alloc-line');
    await wachtTot(async () => (await regels.count()) === 3, { melding: 'geen drie regels voorgesteld' });
    const bedragen = await rij.locator('input.bank-alloc-amount').evaluateAll((els) => els.map((el) => el.value));
    gelijk(bedragen, ['173,63', '173,63', '50,00'], 'voorgestelde bedragen');
    const eerste = tekst(await regels.nth(0).locator('.select-control').nth(1).locator('.select-value').innerText());
    verwacht(eerste.startsWith(nummers[0]), `eerste regel: ${eerste}`);
    verwacht(!(await rij.getByRole('button', { name: 'Boeken' }).isEnabled()), 'Boeken kan al zonder grootboekrekening op de derde regel');
    const derde = regels.nth(2);
    await kies(derde.locator('.select-control').nth(1), '8000 · Omzet hoog (21%)');
    await kies(derde.locator('.select-control').nth(2), 'BTW 21%');
    await wachtTot(async () => /Precies verdeeld/.test(await rij.innerText()), { melding: 'niet "Precies verdeeld"' });
    await rij.getByRole('button', { name: 'Eigen omschrijving' }).click();
    await rij.locator('input.bank-alloc-booking-desc').fill('Verzamelbetaling klant A');
    await schermafdruk('bank-verdeling-klaar', lid);
    const sinds = server.verkeer.length;
    await rij.getByRole('button', { name: 'Boeken' }).click();
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'book_bank_transaction' }, 'boeken');
    for (const f of [b.f1, b.f2]) gelijk(sqlRij(`select status from public.invoices where id = ${q(f.id)}`).status, 'paid', `factuur ${f.number}`);
    const boeking = sqlRij(`select je.description from public.bank_transactions bt join public.journal_entries je on je.id = bt.journal_entry_id
      where bt.organization_id = ${q(w.orgId)} and bt.is_manual and bt.description = ${q(omschrijving)}`);
    gelijk(boeking?.description, 'Verzamelbetaling klant A', 'omschrijving van de boeking');
  });

  await uiStap('onder "Geboekt": de verdeling en de omschrijving; terugdraaien zet hem weer open', async () => {
    const lid = t.lid;
    const page = lid.page;
    await bankTab(lid, 'Geboekt');
    const rij = bankRij(page, 'plus meerwerk').first();
    await rij.waitFor({ timeout: 10000 });
    const inhoudRij = tekst(await rij.innerText());
    for (const iets of ['Verzamelbetaling klant A', `Factuur ${nummers[0]}`, `Factuur ${nummers[1]}`, '8000 · Omzet hoog (21%)']) {
      verwacht(inhoudRij.includes(iets), `"${iets}" staat niet bij de geboekte transactie: ${inhoudRij.slice(0, 300)}`);
    }
    await schermafdruk('bank-geboekt', lid);
    const sinds = server.verkeer.length;
    await rij.getByRole('button', { name: 'Terugdraaien' }).click();
    // Eerst de vraag (confirm), dan pas de aanroep.
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'unbook_bank_transaction' }, 'terugdraaien');
    gelijk(sqlRij(`select status from public.invoices where id = ${q(b.f1.id)}`).status, 'sent', 'factuur weer open');
    await bankTab(lid, 'Openstaand');
    await bankRij(page, 'plus meerwerk').first().waitFor({ timeout: 10000 });
  });

  await uiStap('dezelfde mutatie nog eens invoeren: eerst de vraag "lijkt dubbel", met de knop "Toch invoeren"', async () => {
    const lid = t.lid;
    const page = lid.page;
    await inhoud(page).getByRole('button', { name: 'Mutatie invoeren' }).first().click();
    const m = modal(page, 'Mutatie invoeren');
    await m.waitFor({ timeout: 10000 });
    await veld(m, 'Bedrag').locator('input').fill('397,26');
    await veld(m, 'Tegenpartij').locator('input').fill(w.klantA.name);
    await klik(m, 'Opslaan');
    await wachtTot(async () => /Lijkt dubbel/.test(await m.innerText()), { melding: 'geen vraag over een dubbele mutatie' });
    verwacht(await heeftKnop(m, 'Toch invoeren'), 'geen knop "Toch invoeren"');
    await klik(m, 'Annuleren');
    await m.waitFor({ state: 'detached', timeout: 10000 });
    gelijk(Number(sql(`select count(*) from public.bank_transactions where organization_id = ${q(w.orgId)} and is_manual`)), 1, 'niets ingevoerd');
  }, { toegestaan: [{ rpc: 'create_manual_bank_transaction', status: 400 }] });

  await uiStap('de bank levert dezelfde mutatie: samengevoegd en "bevestigd door bank"; losmaken en weer samenvoegen', async () => {
    const lid = t.lid;
    const page = lid.page;
    gelukt(await rpc('import_bank_transactions', {
      p_organization_id: w.orgId, p_bank_account_id: b.rekening.id, p_statement: { format: 'csv', file_name: 'ui-bank.csv' },
      p_transactions: [{ booking_date: datum(), amount_cents: 2 * 17363 + 5000, counterparty_name: w.klantA.name, description: 'SEPA OVERBOEKING KLANT A' }],
    }, w.medewerker.token), 'afschrift');
    await ververs(lid);
    const rij = bankRij(page, 'plus meerwerk').first();
    await wachtTot(async () => /bevestigd door bank/i.test(await rij.innerText()), { melding: 'niet "bevestigd door bank"' });
    gelijk(await bankRij(page, 'SEPA OVERBOEKING KLANT A').count(), 1, 'de bankregel staat alleen onder de handmatige mutatie');
    let sinds = server.verkeer.length;
    await rij.getByRole('button', { name: 'Losmaken' }).click();
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'unmerge_bank_transaction' }, 'losmaken');
    const bankregel = inhoud(page).locator('.bank-tx').filter({ has: page.locator('.bank-merge-hint') }).first();
    await bankregel.waitFor({ timeout: 10000 });
    verwacht(/Lijkt op je handmatige mutatie/.test(await bankregel.innerText()), 'geen hint bij de losse bankregel');
    await schermafdruk('bank-samenvoegen', lid);
    sinds = server.verkeer.length;
    await bankregel.getByRole('button', { name: 'Samenvoegen' }).click();
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'merge_bank_transactions' }, 'samenvoegen');
    await wachtTot(async () => /bevestigd door bank/i.test(await bankRij(page, 'plus meerwerk').first().innerText()), { melding: 'niet weer samengevoegd' });
  });

  await uiStap('telefoon, liggende telefoon en tablet, licht en donker: de verdeling past zonder zijwaarts scrollen', async () => {
    const lid = t.lid;
    const page = lid.page;
    const formaten = [['telefoon', 390, 844], ['liggend', 740, 360], ['tablet', 820, 1180]];
    const themaVoor = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    try {
      for (const thema of ['light', 'dark']) {
        await page.evaluate((waarde) => document.documentElement.setAttribute('data-theme', waarde), thema);
        for (const [naam, breedte, hoogte] of formaten) {
          await page.setViewportSize({ width: breedte, height: hoogte });
          await rustig(lid);
          const rij = bankRij(page, 'plus meerwerk').first();
          await rij.scrollIntoViewIfNeeded();
          if (naam === 'telefoon') await schermafdruk(`bank-${naam}-${thema}`, lid);
          const breed = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, raam: window.innerWidth }));
          verwacht(breed.doc <= breed.raam + 1, `${naam}/${thema}: de pagina is ${breed.doc}px breed op een scherm van ${breed.raam}px`);
          const regels = await rij.locator('.bank-alloc-line').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
          if (!regels.every((rechts) => rechts <= breedte + 1)) {
            // Welk element is te breed? Van de regel omhoog, en de kinderen van de regel.
            const keten = await rij.locator('.bank-alloc-line').first().evaluate((el) => {
              const uit = [];
              for (let e = el; e && e !== document.body; e = e.parentElement) uit.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')}=${Math.round(e.getBoundingClientRect().right)}`);
              for (const k of el.children) uit.push(`kind ${k.tagName.toLowerCase()}.${[...k.classList].join('.')}=${Math.round(k.getBoundingClientRect().width)}`);
              return uit.join(' | ');
            });
            throw new Error(`${naam}/${thema}: een regel steekt buiten beeld: ${regels.join(', ')} — ${keten}`);
          }
        }
      }
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate((waarde) => { if (waarde) document.documentElement.setAttribute('data-theme', waarde); else document.documentElement.removeAttribute('data-theme'); }, themaVoor);
    }
  });
}

// ── Draaien ─────────────────────────────────────────────────────────────────

let fouten = 1;
try {
  console.log(`UI-test: app ${APP}, backend ${server.url} (gateway ${API_URL}, functies in dit proces)`);
  console.log(`schermafdrukken bij een fout: ${SCHERMAFDRUKKEN}`);
  groep('UI: voorbereiding');
  t.w = await stap('wereld maken', () => maakWereld('ui'));
  if (t.w) {
    await uiStap('de app laadt als medewerker (sessie, organisatie, menu)', async () => {
      const lid = await medewerker();
      verwacht(await lid.page.locator('.sidebar-nav').isVisible(), 'geen menu: de app toont het inlogscherm');
      // De app praat met deze testserver, niet met een ander Supabase-adres.
      verwacht(server.verkeer.some((r) => r.soort === 'rpc' && r.status < 400), 'de app deed geen enkele aanroep via de testserver');
    });
    const scenarios = { offerte: scenarioOfferte, factuur: scenarioFactuur, intrekken: scenarioIntrekken, contract: scenarioContract, rollen: scenarioRollen, agenda: scenarioAgenda, mollie: scenarioMollie, documenten: scenarioDocumenten, bank: scenarioBank };
    for (const naam of SCENARIOS) await scenarios[naam]();
  }
  fouten = samenvatting();
} catch (error) {
  console.error(error);
} finally {
  await browser.close().catch(() => undefined);
  await vite.close().catch(() => undefined);
  await server.sluit().catch(() => undefined);
}
process.exit(fouten > 0 ? 1 : 0);
