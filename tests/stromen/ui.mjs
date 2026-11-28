#!/usr/bin/env node
/*
 * UI-test — de knoppen en formulieren van offertes, facturen, herinneringen en
 * contracten in Chromium, tegen de echte backend.
 *
 *   node --enable-source-maps --import ./tests/stromen/register.mjs tests/stromen/ui.mjs [offerte] [factuur] [intrekken] [contract] [rollen] [agenda] [mollie] [documenten] [paginas] [paginadrive] [paginadelen] [paginaexport] [bank] [inrichten] [opname] [klantdomein] [rapportage] [tickets] [vooruitbetaald] [galerij] [prognose]
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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { crc32, deflateSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { API_URL, ANON_KEY, CLIENT_DOMAINS_WERKER_GEHEIM, CRON_SECRET, ORIGIN, SERVICE_KEY } from './omgeving.mjs';
import { installeer, mailsAan, post } from './nepdiensten.mjs';
import { roep, roepRequest } from './functies.mjs';
import { maakGebruiker, rest, rpc, sql, sqlRij, sqlRijen } from './supabase.mjs';
import { gelijk, gelukt, groep, samenvatting, stap, verwacht } from './toets.mjs';
import { maakWereld, REGELS } from './wereld.mjs';
import { startUiServer } from './ui-server.mjs';
import { GOOGLE_ALLES, account, geefCode } from './nep-agenda.mjs';
import { ai, gesprek, NOTULEN } from './nep-ai.mjs';
import { claude, installeerClaude, OMZET_DATASETS, OMZET_HTML, JAAR, regel, zetFacturen } from './rapportages.mjs';
import { clearClientOriginCache } from '../../supabase/functions/_shared/clientLinks.ts';
import {
  clientHostMeta, escapeAttr, faviconSvg, isPortalPath, neutralPage, pageTitle, parseLookup, portalRedirectUrl, routeFor, sameUrlOn,
} from '../../workers/client-domains/src/logic.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argumenten = process.argv.slice(2);
const opties = Object.fromEntries(argumenten.filter((a) => a.startsWith('--')).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return [m[1], m[2] ?? 'true'];
}));
const ALLE = ['offerte', 'factuur', 'intrekken', 'contract', 'rollen', 'agenda', 'mollie', 'documenten', 'paginas', 'paginadrive', 'paginadelen', 'paginaexport', 'bank', 'inrichten', 'opname', 'klantdomein', 'rapportage', 'tickets', 'vooruitbetaald', 'galerij', 'prognose'];
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

/** De delen van een zip (zoals een .docx): naam en inhoud. Alleen opgeslagen of met deflate ingepakt. */
function leesZip(buffer) {
  const einde = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (einde < 0) throw new Error('geen zip: geen einde van de centrale map');
  const aantal = buffer.readUInt16LE(einde + 10);
  let pos = buffer.readUInt32LE(einde + 16);
  const delen = [];
  for (let i = 0; i < aantal; i += 1) {
    const methode = buffer.readUInt16LE(pos + 10);
    const ingepakt = buffer.readUInt32LE(pos + 20);
    const naamLengte = buffer.readUInt16LE(pos + 28);
    const plek = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + naamLengte).toString('utf8');
    const start = plek + 30 + buffer.readUInt16LE(plek + 26) + buffer.readUInt16LE(plek + 28);
    const ruw = buffer.subarray(start, start + ingepakt);
    delen.push({ name, data: methode === 8 ? inflateRawSync(ruw) : Buffer.from(ruw) });
    pos += 46 + naamLengte + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return delen;
}
const regexVan = (woorden) => new RegExp(`^${String(woorden).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
const slaap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** De datum van vandaag in Nederland (JJJJ-MM-DD), plus `dagen`. */
/** Een PNG van één kleur, voor een afbeelding die de nep-media-worker "levert". */
function pngVlak(breedte, hoogte, [r, g, b]) {
  const blok = (soort, data) => {
    const lengte = Buffer.alloc(4); lengte.writeUInt32BE(data.length);
    const som = Buffer.alloc(4); som.writeUInt32BE(crc32(Buffer.concat([Buffer.from(soort), data])) >>> 0);
    return Buffer.concat([lengte, Buffer.from(soort), data, som]);
  };
  const kop = Buffer.alloc(13);
  kop.writeUInt32BE(breedte, 0); kop.writeUInt32BE(hoogte, 4); kop[8] = 8; kop[9] = 2;
  const regel = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: breedte }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: hoogte }, () => regel)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), blok('IHDR', kop), blok('IDAT', pixels), blok('IEND', Buffer.alloc(0))]);
}

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

// De echte fetch, voor wat de test zelf bij Vite ophaalt (de nagebootste Worker
// van scenario klantdomein). installeer() blokkeert daarna elk onbekend adres.
const testFetch = globalThis.fetch;
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
  // Een nep-microfoon (een pieptoon), zonder toestemmingsvraag: zo kan het
  // scenario opname echt opnemen met MediaRecorder.
  const basis = { headless: !opties.zichtbaar, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] };
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
async function openWerkruimte(gebruiker, naam, organisatieId, { tijdelijk = false, tabblad = null, voor = null } = {}) {
  const sessie = await sessieVan(gebruiker);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  // Het werkblad begint op Offertes: daar beginnen de meeste stromen van deze
  // test. (calendar-integrations laadt hier sinds 6 november ook; zie loader.mjs.)
  const items = {
    [SESSIESLEUTEL]: JSON.stringify(sessie),
    'brandcore.activeOrganizationId': organisatieId,
    [`brandcore.tabs.${organisatieId}`]: JSON.stringify({ tabs: [tabblad ?? { page: 'quotes', projectId: null, clientId: null, statsReportId: null, galleryId: null }], activeIndex: 0 }),
    'brandcore.sidebarPinned': '1',
    // De stromen klikken door de zijbalk van Cockpit, waarin elke pagina op één
    // niveau staat. Baken, de standaard, heeft sinds 2026-11-13 de rail met het
    // uitklappaneel; daar ligt een pagina pas in beeld als je in zijn module
    // bent. Deze test gaat over offertes, facturen en rechten, niet over het
    // menu: dat menu toetsen test:loading (klikken) en test:mobile (opbouw).
    'resofly.look': 'cockpit',
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
  // Iets wat er al moet zijn als de app laadt, zoals een nagebootste worker.
  if (voor) await voor(context);
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
      // Ook de JavaScript-fouten van deze stap: een stap die op iets wacht dat
      // nooit kwam, meldde anders alleen de wachttijd, terwijl de app was
      // vastgelopen (een zwart scherm, en geen woord over waarom).
      const fouten = betrokken().flatMap((s) => {
        const b = begin.get(s) ?? { fouten: 0, console: 0 };
        return [
          ...s.fouten.slice(b.fouten).map((f) => `JavaScript-fout bij ${s.naam}: ${f.split('\n').slice(0, 3).join(' | ')}`),
          ...s.console.slice(b.console).filter((c) => !RUIS_CONSOLE.some((r) => r.test(c.tekst))).map((c) => `console.error bij ${s.naam}: ${c.tekst.slice(0, 300)}`),
        ];
      });
      if (fouten.length) {
        error.message = `${error.message}\n${fouten.join('\n')}`;
        // toets.mjs drukt de eerste regels van de stack af: de fouten daar vooraan.
        const stack = String(error.stack || error.message).split('\n');
        error.stack = [stack[0], ...fouten.slice(0, 3), ...stack.slice(1)].join('\n');
      }
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

/**
 * Crediteren via het venster van de factuur. Sinds 19 november is dat een eigen
 * venster (wat er betaald is, wat er openstaat, het bedrag, de reden, en of de
 * klant de creditfactuur krijgt) in plaats van één prompt voor het hele bedrag:
 * een deels betaalde factuur liep daar dood. De stappen hieronder verwachtten
 * die prompt; ze vullen nu het venster in. Geeft het venster terug, nog open
 * tot de server klaar is.
 */
async function crediteerInVenster(scherm, m, nummer, reden) {
  await klik(m, 'Crediteren');
  // Het venster staat in het factuurvenster; .last() is het binnenste.
  const venster = modal(scherm.page, `Crediteren — factuur ${nummer}`).last();
  await venster.waitFor({ timeout: 10000 });
  // Het openstaande bedrag komt van de server (het grootboek).
  await venster.locator('.refund-summary').waitFor({ timeout: 10000 });
  const stand = tekst(await venster.locator('.refund-summary').innerText());
  await venster.locator('textarea').fill(reden);
  await venster.locator('.modal-foot').getByRole('button', { name: /^Crediteren$/ }).click();
  return { venster, stand };
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

  const link = await uiStap('"Verstuur per e-mail" als medewerker: mail met link en PDF naar klant A', async () => {
    const lid = t.lid;
    await sluitAlles(lid);
    await ververs(lid);
    const mailsVoor = mailsAan(w.klantA.email).length;
    const sinds = server.verkeer.length;
    const m = await openDocument(lid, nieuw.nummer, 'Offerte');
    const dialogenVoor = lid.dialogen.length;
    await klik(m, 'Verstuur per e-mail');
    await rustig(lid);
    const vragen = lid.dialogen.slice(dialogenVoor);
    gelijk(vragen.map((v) => v.type), ['prompt', 'prompt'], 'vragen bij versturen');
    gelijk(vragen[0].standaard, w.klantA.email, 'voorgesteld adres (het adres van klant A)');
    verwachtAanroep(sinds, { functie: 'quote-workflow', actie: 'sendQuoteEmail' }, 'Verstuur per e-mail');
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
      // heeft geen realtime). Zonder herladen vond "Verstuur per e-mail" het
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

  const link = await uiStap('"Verstuur per e-mail": factuur naar klant A met link', async () => {
    const lid = await medewerker();
    await sluitAlles(lid);
    await naarFinancien(lid, 'Facturen');
    const mailsVoor = mailsAan(w.klantA.email).length;
    const sinds = server.verkeer.length;
    const m = await openDocument(lid, f1.nummer, 'Factuur');
    const dialogenVoor = lid.dialogen.length;
    await klik(m, 'Verstuur per e-mail');
    await rustig(lid);
    const vragen = lid.dialogen.slice(dialogenVoor);
    gelijk(vragen.map((v) => v.type), ['prompt', 'prompt'], 'vragen bij versturen');
    gelijk(vragen[0].standaard, w.klantA.email, 'voorgesteld adres');
    verwachtAanroep(sinds, { functie: 'invoice-workflow', actie: 'sendInvoiceEmail' }, 'Verstuur per e-mail');
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
      await crediteerInVenster(lid, m, f1.nummer, 'Factuur vervalt (UI-test)');
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
    // Geen prompt meer: het venster Crediteren toont wat er openstaat (hier het
    // hele bedrag, er is niets betaald) en vraagt het bedrag en de reden.
    const { stand } = await crediteerInVenster(lid, m, f3.number, 'Dubbel gefactureerd (UI-test)');
    // De kopjes staan in hoofdletters in beeld (CSS); vergelijk zonder hoofdletters.
    const standKlein = stand.toLowerCase();
    verwacht(standKlein.includes(`staat nog open ${TOTAAL}`) && standKlein.includes('betaald € 0,00'), `de stand in het venster Crediteren: ${stand}`);
    await rustig(lid);
    verwachtAanroep(sinds, { functie: 'invoice-workflow', actie: 'previewInvoiceCredit' }, 'het openstaande bedrag ophalen');
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
    verwacht(!lijst.some((k) => /^(Intrekken|Verstuur per e-mail)$/.test(k)), `na intrekken nog knoppen: ${lijst.join(', ')}`);
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
  offerte: [/^Ter goedkeuring$/, /^Goedkeuren$/, /^Afwijzen$/, /^Verstuur per e-mail$/, /^Maak factuur van offerte$/, /^Intrekken$/],
  factuur: [/^Verstuur per e-mail$/, /^Verstuur e-factuur$/, /^Verstuur via Mollie$/, /^Stuur herinnering/, /^Crediteren$/, /^Terugbetaling$/, /^Boek naar grootboek$/, /^(Pauzeer|Hervat) herinneringen$/, /^Stel aanmaning op$/],
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
        { nummer: qGoed.number, verwachtLid: ['Verstuur per e-mail', 'Intrekken'] },
        { nummer: qVerstuurd.number, verwachtLid: ['Intrekken'] },
      ],
      facturen: [
        { nummer: fVerstuurd.number, verwachtLid: ['Verstuur per e-mail', 'Stuur herinnering (niveau 1)', 'Crediteren'] },
        { nummer: fConcept.number, verwachtLid: ['Verstuur per e-mail'], bewerk: true },
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
  // Sinds 23 november heet de verkenner in het menu "Alle inhoud", onder het
  // kopje Documenten. Daarvoor "Inhoud"; toen liep deze hulp daarop vast.
  await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Alle inhoud/ }).first().click();
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

/**
 * Exporteren → Word downloaden in de pagina-editor (stap 1B-3). Geeft de
 * download; het venster gaat daarna dicht.
 */
async function exporteerWord(page) {
  const onderweg = page.waitForEvent('download', { timeout: 30000 });
  onderweg.catch(() => {});
  await page.locator('.page-editor-export').click();
  await page.locator('.page-export-word').click();
  const download = await onderweg;
  await page.locator('.page-export').waitFor({ state: 'detached', timeout: 10000 });
  return download;
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

  // Een gedeelde map vult zich niet meer vanzelf (20261127120000): wat er later
  // in komt, toont de drive als "Niet gedeeld", met een balk boven de map.
  await uiStap('een gedeelde map: wat er later in komt, staat als "Niet gedeeld" met een balk, en "Ook delen" deelt het', async () => {
    const mapNaam = `Oplevering ${Date.now().toString(36)}`;
    const notitie = (titelNotitie, folderId) => ({
      organization_id: w.orgId, created_by: w.medewerker.id, client_id: w.klantA.id, folder_id: folderId, title: titelNotitie, content: '<p>Tekst.</p>',
    });
    const map = gelukt(await rest('content_folders', { method: 'POST', token: w.medewerker.token, prefer: 'return=representation', body: { organization_id: w.orgId, client_id: w.klantA.id, name: mapNaam } }), 'map')[0];
    gelukt(await rest('notes', { method: 'POST', token: w.medewerker.token, prefer: 'return=representation', body: notitie('Eerste versie', map.id) }), 'eerste notitie');
    const deel = gelukt(await roep('file-share', { token: w.medewerker.token, body: { action: 'share', organizationId: w.orgId, itemType: 'folder', itemId: map.id, recipients: [{ kind: 'client' }] } }), 'map delen').results?.[0];
    verwacht(deel && !deel.error, `delen mislukt: ${JSON.stringify(deel).slice(0, 200)}`);
    const later = gelukt(await rest('notes', { method: 'POST', token: w.medewerker.token, prefer: 'return=representation', body: notitie('Tweede versie', map.id) }), 'tweede notitie')[0];

    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.odrv-row').filter({ hasText: mapNaam }).first().click();
    const balk = inhoud(page).locator('.odrv-share-gap');
    await balk.waitFor({ timeout: 15000 });
    const zin = tekst(await balk.innerText());
    gelijk(await balk.getByLabel('Melding sturen').isChecked(), true, 'melding staat standaard aan');
    verwacht(zin.includes('1 notitie in deze map is nog niet gedeeld met'), `balk: ${zin}`);
    gelijk(await inhoud(page).locator('.odrv-row').filter({ hasText: 'Tweede versie' }).first().locator('.odrv-unshared').count(), 1, 'label bij de nieuwe notitie');
    gelijk(await inhoud(page).locator('.odrv-row').filter({ hasText: 'Eerste versie' }).first().locator('.odrv-unshared').count(), 0, 'geen label bij wat al gedeeld is');
    // Op een telefoon past de balk: de zin breekt af en de knop blijft in beeld.
    const breed = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await rustig(lid);
    const vak = await balk.boundingBox();
    const knop = await balk.getByRole('button', { name: 'Ook delen' }).boundingBox();
    verwacht(vak && knop && vak.x >= 0 && vak.x + vak.width <= 390 && knop.x + knop.width <= 390, `balk past niet op een telefoon: ${JSON.stringify({ vak, knop })}`);
    // En het label valt niet weg achter een afgekapte naam: het staat binnen de cel.
    const nieuweRij = inhoud(page).locator('.odrv-row').filter({ hasText: 'Tweede versie' }).first();
    const cel = await nieuweRij.locator('.odrv-td-name').boundingBox();
    const label = await nieuweRij.locator('.odrv-unshared').boundingBox();
    verwacht(cel && label && label.x + label.width <= cel.x + cel.width + 1, `label valt weg op een telefoon: ${JSON.stringify({ cel, label })}`);
    await page.screenshot({ path: path.join(os.tmpdir(), 'stromen-ui-balk-telefoon.png') });
    if (breed) await page.setViewportSize(breed);
    await rustig(lid);
    await balk.getByRole('button', { name: 'Ook delen' }).click();
    await balk.waitFor({ state: 'detached', timeout: 15000 });
    gelijk(await inhoud(page).locator('.odrv-unshared').count(), 0, 'geen label meer');
    verwacht(mailsAan(w.klantA.email).some((mail) => String(mail.text ?? '').includes('Tweede versie')), 'geen melding aan de klant over de nieuwe notitie');
    const regel = sqlRij(`select added_by from public.drive_share_entries where share_id = ${q(deel.share.id)} and item_id = ${q(later.id)}`);
    gelijk(regel?.added_by, w.medewerker.id, 'gedeeld, op naam van wie klikte');
  });

  // Stap 1A-2: de tekst van documenten zit niet meer in wat de app laadt.
  // Zoeken op een woord dat alleen diep in de tekst staat, gaat via de
  // database; openen haalt de hele tekst op (anders opende de editor leeg).
  await uiStap('zoeken vindt een document op een woord uit de tekst, en openen toont de hele tekst', async () => {
    const woord = `kwartel${Date.now().toString(36)}`;
    const vulsel = 'Dit is een lange inleiding over de werkwijze. '.repeat(10);
    gelukt(await rest('documents', { method: 'POST', token: w.medewerker.token, prefer: 'return=representation', body: {
      organization_id: w.orgId, created_by: w.medewerker.id, title: 'Zoekproef', content: `<p>${vulsel}</p><p>Hier staat ${woord} in de tekst.</p>`,
    } }), 'document');
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    let zoekvragen = 0;
    page.on('request', (verzoek) => { if (verzoek.url().includes('/rest/v1/rpc/search_documents')) zoekvragen += 1; });
    const zoekveld = page.locator('.gs-input').first();
    await zoekveld.click();
    await zoekveld.fill(woord);
    const treffer = page.locator('.gs-result').filter({ hasText: 'Zoekproef' }).first();
    await treffer.waitFor({ timeout: 15000 });
    // Eén zoekvraag per woord, ook als de app intussen opnieuw tekent.
    await page.waitForTimeout(1500);
    gelijk(zoekvragen, 1, 'zoekvragen aan de database voor één woord');
    await treffer.click();
    const venster = documentVenster(page);
    await venster.waitFor({ timeout: 10000 });
    const editor = venster.locator('[contenteditable="true"]').first();
    await wachtTot(async () => (await editor.innerText().catch(() => '')).includes(woord), { melding: 'de hele tekst staat niet in de editor' });
  });

}

/**
 * Pagina's: de editor en zijn blokken (stap 1A-3 en 1A-4). Een eigen scenario,
 * los van "documenten": samen duurden ze langer dan de tien minuten die een
 * begrensde Docker-run in een cloudsessie heeft.
 */
async function scenarioPaginas() {
  groep('UI: pagina\'s');
  const { w } = t;
  // ── Pagina's (stap 1A-3a) ──────────────────────────────────────────────────
  const paginaTitel = `Werkwijze ${Date.now().toString(36)}`;
  const paginaStatus = (page) => page.locator('.page-editor .page-editor-status');
  const paginaRij = (page) => inhoud(page).locator('.odrv-row').filter({ hasText: paginaTitel }).first();

  const pagina = await uiStap('Nieuw → Pagina: typen, het slaat vanzelf op, en het staat als pagina in de database', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.drive-new').click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Pagina', exact: true }).click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtTot(async () => tekst(await paginaStatus(page).innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de editor kwam niet in bewerken' });
    await page.locator('.page-editor-title').fill(paginaTitel);
    await page.locator('.page-editor .tiptap').click();
    await page.keyboard.type('Koffie is gratis.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- eerste punt');
    await wachtTot(async () => tekst(await paginaStatus(page).innerText().catch(() => '')) === 'Opgeslagen', { melding: 'niet opgeslagen', timeout: 15000 });
    const rij = sqlRij(`select id, format, content, edit_version, client_id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(paginaTitel)}`);
    verwacht(rij, 'pagina niet in de database');
    gelijk(rij.format, 'page', 'soort');
    gelijk(rij.client_id, w.klantA.id, 'bij klant A');
    verwacht(rij.content.includes('Koffie is gratis.') && rij.content.includes('eerste punt'), `tekst niet opgeslagen: ${rij.content}`);
    const lijst = sqlRij(`select count(*)::int as n from public.documents d, jsonb_path_query(d.body, 'strict $.** ? (@.type == "bulletList")') x where d.id = ${q(rij.id)}`);
    gelijk(lijst.n, 1, 'de opsomming staat als blok in body');
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
    await paginaRij(page).waitFor({ timeout: 10000 });
    verwacht(tekst(await paginaRij(page).innerText()).includes('Pagina'), 'de rij heet geen Pagina');
    const versies = sqlRij(`select count(*)::int as n from public.document_versions where document_id = ${q(rij.id)}`);
    gelijk(versies.n, 1, 'bij sluiten een versie van deze sessie');
    const claims = sqlRij(`select count(*)::int as n from public.document_edit_claims where document_id = ${q(rij.id)}`);
    gelijk(claims.n, 0, 'bij sluiten is de claim los');
    return rij;
  });

  await uiStap('opnieuw openen toont de tekst, en openen zonder te typen verandert niets', async () => {
    if (!pagina) throw new Error('geen pagina');
    const voor = sqlRij(`select edit_version, updated_at::text as gewijzigd from public.documents where id = ${q(pagina.id)}`);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await paginaRij(page).click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtTot(async () => (await page.locator('.page-editor .tiptap').innerText().catch(() => '')).includes('Koffie is gratis.'), { melding: 'de tekst staat niet in de editor' });
    await wachtTot(async () => tekst(await paginaStatus(page).innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de editor kwam niet in bewerken' });
    // Ongedaan maken gaat niet terug tot vóór het laden: anders maakte Ctrl+Z de pagina leeg.
    gelijk(await page.getByRole('button', { name: 'Ongedaan maken', exact: true }).isDisabled(), true, 'ongedaan maken direct na openen');
    await page.locator('.page-editor .tiptap').click();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(2500);
    verwacht((await page.locator('.page-editor .tiptap').innerText()).includes('Koffie is gratis.'), 'Ctrl+Z na openen haalde de tekst weg');
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
    const na = sqlRij(`select edit_version, updated_at::text as gewijzigd from public.documents where id = ${q(pagina.id)}`);
    gelijk([na.edit_version, na.gewijzigd], [voor.edit_version, voor.gewijzigd], 'edit_version en "laatst gewijzigd" na alleen openen');
  });

  await uiStap('een tweede collega ziet wie de pagina bewerkt, en kan niet typen', async () => {
    if (!pagina) throw new Error('geen pagina');
    const lidA = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    await naarKlantdossier(lidA, w.klantA.name);
    await paginaRij(lidA.page).click();
    await wachtTot(async () => tekst(await paginaStatus(lidA.page).innerText().catch(() => '')) === 'Opgeslagen', { melding: 'A kwam niet in bewerken' });
    const lidB = await openWerkruimte(w.beheerder, 'beheerder', w.orgId, { tijdelijk: true });
    await naarKlantdossier(lidB, w.klantA.name);
    await paginaRij(lidB.page).click();
    const banner = lidB.page.locator('.page-editor-banner');
    await banner.waitFor({ timeout: 20000 });
    verwacht(tekst(await banner.innerText()).includes('bewerkt deze pagina'), `banner: ${await banner.innerText()}`);
    gelijk(await lidB.page.locator('.page-editor .tiptap').getAttribute('contenteditable'), 'false', 'B kan niet typen');
    gelijk(await lidB.page.locator('.page-editor-toolbar').count(), 0, 'B heeft geen werkbalk');
    await lidB.page.locator('.page-editor-close').click();
    await lidA.page.locator('.page-editor-close').click();
    await lidA.page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
  });

  await uiStap('een pagina deel je (stap 1C), maar versturen kan nog niet; op een telefoon past de werkbalk', async () => {
    if (!pagina) throw new Error('geen pagina');
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await paginaRij(page).locator('.odrv-td-act button').first().click();
    const menu = page.locator('.drive-pop');
    await menu.getByRole('menuitem', { name: 'Openen', exact: true }).waitFor({ timeout: 10000 });
    // Delen is vrijgeven (scenario paginadelen); versturen wacht op de export naar PDF.
    gelijk(await menu.getByRole('menuitem', { name: 'Delen…', exact: true }).count(), 1, 'Delen bij een pagina');
    gelijk(await menu.getByRole('menuitem', { name: 'Versturen…', exact: true }).count(), 0, 'Versturen bij een pagina');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await rustig(lid);
    await paginaRij(page).click();
    const balk = page.locator('.page-editor-toolbar');
    await balk.waitFor({ timeout: 20000 });
    await page.waitForTimeout(600);
    gelijk(tekst(await paginaStatus(page).innerText()), 'Opgeslagen', 'status direct na openen, zonder te typen');
    const vak = await balk.boundingBox();
    verwacht(vak && vak.x >= 0 && vak.x + vak.width <= 391, `werkbalk past niet: ${JSON.stringify(vak)}`);
    const schuift = await balk.evaluate((el) => el.scrollWidth > el.clientWidth);
    verwacht(schuift, 'de werkbalk schuift niet opzij op een telefoon');
    await page.screenshot({ path: path.join(os.tmpdir(), 'stromen-ui-pagina-telefoon.png') });
    await page.locator('.page-editor-close').click();
  });

  // ── Versies en een eigen adres (stap 1A-3b) ───────────────────────────────
  await uiStap('versies: een oude versie bekijken en terugzetten, en wat er stond blijft bewaard', async () => {
    if (!pagina) throw new Error('geen pagina');
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await paginaRij(page).click();
    await wachtTot(async () => tekst(await paginaStatus(page).innerText().catch(() => '')) === 'Opgeslagen', { melding: 'niet in bewerken' });
    await page.locator('.page-editor .tiptap').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Tweede alinea.');
    await wachtTot(async () => tekst(await paginaStatus(page).innerText().catch(() => '')) === 'Opgeslagen', { melding: 'niet opgeslagen', timeout: 15000 });
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });

    await paginaRij(page).click();
    await wachtTot(async () => tekst(await paginaStatus(page).innerText().catch(() => '')) === 'Opgeslagen', { melding: 'niet in bewerken' });
    await page.locator('.page-editor-action').filter({ hasText: 'Versies' }).click();
    const items = page.locator('.page-versions-item');
    await items.first().waitFor({ timeout: 10000 });
    verwacht((await items.count()) >= 2, `te weinig versies: ${await items.count()}`);
    await items.filter({ hasText: 'Versie 1' }).first().click();
    const voorbeeld = page.locator('.page-versions-sheet');
    await wachtTot(async () => (await voorbeeld.innerText().catch(() => '')).includes('Koffie is gratis.'), { melding: 'geen voorvertoning' });
    verwacht(!(await voorbeeld.innerText()).includes('Tweede alinea.'), 'de voorvertoning toont de nieuwe tekst');
    // De testomgeving accepteert het bevestigingsvenster zelf.
    await page.getByRole('button', { name: 'Deze versie terugzetten', exact: true }).click();
    await wachtTot(async () => !(await page.locator('.page-editor .tiptap').innerText().catch(() => 'Tweede alinea.')).includes('Tweede alinea.'), { melding: 'niet teruggezet' });
    const rij = sqlRij(`select content from public.documents where id = ${q(pagina.id)}`);
    verwacht(!rij.content.includes('Tweede alinea.'), `de database heeft nog de nieuwe tekst: ${rij.content}`);
    gelijk(await page.getByRole('button', { name: 'Ongedaan maken', exact: true }).isDisabled(), true, 'ongedaan maken na terugzetten');
    const laatste = sqlRij(`select reason from public.document_versions where document_id = ${q(pagina.id)} order by version desc limit 1`);
    gelijk(laatste.reason, 'teruggezet', 'de laatste versie');
    const bewaard = sqlRij(`select count(*)::int as n from public.document_versions where document_id = ${q(pagina.id)} and body::text like '%Tweede alinea.%'`);
    verwacht(bewaard.n >= 1, 'de tekst van vóór het terugzetten is niet als versie bewaard');
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
  });

  await uiStap('een eigen adres: de link opent de pagina, en na sluiten is het adres weg', async () => {
    if (!pagina) throw new Error('geen pagina');
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await paginaRij(page).click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtTot(async () => page.url().includes(`pagina=${pagina.id}`), { melding: `geen adres: ${page.url()}` });
    const adres = page.url();
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
    await wachtTot(async () => !page.url().includes('pagina='), { melding: `adres blijft staan: ${page.url()}` });
    await page.goto(adres);
    await page.locator('.page-editor').waitFor({ timeout: 30000 });
    await wachtTot(async () => (await page.locator('.page-editor-title').inputValue().catch(() => '')) === paginaTitel, { melding: 'de link opende een andere pagina' });
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
  });

  // ── Blokken en het blokmenu (stap 1A-4a) ───────────────────────────────────
  const blokTitel = `Blokken ${Date.now().toString(36)}`;
  const blokRij = (page) => inhoud(page).locator('.odrv-row').filter({ hasText: blokTitel }).first();
  const editorVak = (page) => page.locator('.page-editor .tiptap');
  const wachtOpgeslagen = (page, melding = 'niet opgeslagen') =>
    wachtTot(async () => tekst(await paginaStatus(page).innerText().catch(() => '')) === 'Opgeslagen', { melding, timeout: 20000 });
  const blokRijInDb = () => sqlRij(`select id, body, content, edit_version, updated_at::text as gewijzigd from public.documents where organization_id = ${q(w.orgId)} and title = ${q(blokTitel)}`);
  const telBlok = (id, filter) => sqlRij(`select count(*)::int as n from public.documents d, jsonb_path_query(d.body, ${q(`strict $.** ? (${filter})`)}) x where d.id = ${q(id)}`).n;
  /** Typ `/zoekwoord`; het genoemde blok staat bovenaan, en Enter kiest het. */
  const kiesBlok = async (page, zoekwoord, naam) => {
    await page.keyboard.type(`/${zoekwoord}`);
    const menu = page.locator('.page-block-menu');
    await menu.waitFor({ timeout: 10000 });
    await wachtTot(async () => tekst(await menu.locator('.page-block-item.is-active .page-block-label').innerText().catch(() => '')) === naam,
      { melding: `bovenaan staat niet ${naam}: ${tekst(await menu.innerText().catch(() => ''))}` });
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'detached', timeout: 10000 });
  };
  const openBlokPagina = async (gebruiker, naam) => {
    const lid = await openWerkruimte(gebruiker, naam, w.orgId, { tijdelijk: true });
    await naarKlantdossier(lid, w.klantA.name);
    await blokRij(lid.page).click();
    await lid.page.locator('.page-editor').waitFor({ timeout: 20000 });
    return lid;
  };
  const sluitPagina = async (page) => {
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
  };

  const blokPagina = await uiStap('het blokmenu: /tab maakt een tabel met kopregel; typen, een rij erbij, uitlijnen en een kolom breder slepen', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.drive-new').click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Pagina', exact: true }).click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtOpgeslagen(page, 'de editor kwam niet in bewerken');
    await page.locator('.page-editor-title').fill(blokTitel);
    await editorVak(page).click();
    await page.keyboard.type('Intro');
    await page.keyboard.press('Enter');
    await kiesBlok(page, 'tab', 'Tabel');
    const tabel = editorVak(page).locator('table').first();
    await tabel.waitFor({ timeout: 10000 });
    gelijk(await tabel.locator('th').count(), 3, 'een kopregel met drie kolommen');
    await page.keyboard.type('Naam');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Bedrag');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Koffie');
    await page.keyboard.press('Tab');
    await page.keyboard.type('2,50');
    const tabelBalk = page.locator('.page-editor-subbar[aria-label="Tabel"]');
    await tabelBalk.waitFor({ timeout: 5000 });
    await tabelBalk.getByRole('button', { name: 'Rechts uitlijnen', exact: true }).click();
    await tabelBalk.getByRole('button', { name: 'Rij eronder', exact: true }).click();
    gelijk(await tabel.locator('tr').count(), 4, 'rijen na Rij eronder');
    // Een kolom breder slepen, aan de rechterrand van de eerste kop. Tiptap zette
    // dat alleen aan als de editor bij het maken al bewerkbaar was.
    const kop = await tabel.locator('th').first().boundingBox();
    await page.mouse.move(kop.x + kop.width - 2, kop.y + kop.height / 2);
    await page.mouse.down();
    await page.mouse.move(kop.x + kop.width + 80, kop.y + kop.height / 2, { steps: 8 });
    await page.mouse.up();
    await wachtTot(async () => ((await tabel.locator('th').first().boundingBox())?.width ?? 0) > kop.width + 40, { melding: 'de kolom werd niet breder' });
    await wachtOpgeslagen(page);
    const rij = blokRijInDb();
    verwacht(rij, 'pagina niet in de database');
    verwacht(rij.content.includes('Naam Bedrag') && rij.content.includes('Koffie 2,50'), `tekst uit de tabel: ${rij.content}`);
    gelijk(telBlok(rij.id, '@.type == "tableHeader"'), 3, 'kopcellen in body');
    gelijk(telBlok(rij.id, '@.type == "tableRow"'), 4, 'rijen in body');
    gelijk(telBlok(rij.id, '@.type == "tableCell" && @.attrs.align == "right"'), 1, 'de cel met 2,50 rechts uitgelijnd');
    gelijk(telBlok(rij.id, '@.type == "tableHeader" && @.attrs.colwidth.type() == "array"'), 1, 'de gesleepte breedte staat in body');
    await sluitPagina(page);
    return rij;
  });

  await uiStap('callout, uitklapper en inhoudsopgave via het menu; uitklappen slaat niets op', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    const { page } = await openBlokPagina(w.medewerker, 'medewerker');
    await wachtOpgeslagen(page, 'de editor kwam niet in bewerken');
    await editorVak(page).locator('p').filter({ hasText: 'Intro' }).first().click();
    await page.keyboard.press('Control+End');
    await kiesBlok(page, 'callout', 'Callout');
    await page.keyboard.type('Let op de deadline.');
    const calloutBalk = page.locator('.page-editor-subbar[aria-label="Callout"]');
    await calloutBalk.waitFor({ timeout: 5000 });
    await calloutBalk.getByRole('button', { name: 'Waarschuwing', exact: true }).click();
    await editorVak(page).locator('.page-callout[data-variant="waarschuwing"]').waitFor({ timeout: 5000 });
    // In een callout geen kop: het menu toont alleen wat daar kan. Escape
    // sluit het menu, niet de pagina.
    await page.keyboard.press('Enter');
    await page.keyboard.type('/kop');
    const menu = page.locator('.page-block-menu');
    await menu.waitFor({ timeout: 10000 });
    verwacht(tekst(await menu.innerText()).includes('Geen blok gevonden'), `koppen in een callout: ${tekst(await menu.innerText())}`);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached', timeout: 5000 });
    verwacht(await page.locator('.page-editor').isVisible(), 'Escape sloot de pagina');
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Backspace');
    await page.keyboard.press('Control+End');
    await kiesBlok(page, 'uitklapper', 'Uitklapper');
    await page.keyboard.type('Meer weten?');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Uitleg hier.');
    await page.keyboard.press('Control+End');
    await kiesBlok(page, 'kop2', 'Kop 2');
    await page.keyboard.type('Planning');
    // De inhoudsopgave bovenaan, op een nieuwe lege regel.
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowUp');
    await kiesBlok(page, 'inh', 'Inhoudsopgave');
    const toc = editorVak(page).locator('.page-toc');
    await toc.waitFor({ timeout: 5000 });
    // Na het invoegen staat de cursor op tekst, niet op de inhoudsopgave: typen
    // overschreef die anders.
    await page.keyboard.type('Welkom. ');
    await wachtTot(async () => tekst(await editorVak(page).locator('p').filter({ hasText: 'Intro' }).first().innerText().catch(() => '')) === 'Welkom. Intro',
      { melding: 'de tekst kwam niet voor Intro' });
    gelijk(await toc.count(), 1, 'de inhoudsopgave staat er nog na typen');
    await wachtTot(async () => tekst(await toc.innerText().catch(() => '')).includes('Planning'), { melding: `de kop staat niet in de inhoudsopgave: ${tekst(await toc.innerText().catch(() => ''))}` });
    await wachtOpgeslagen(page);
    // Open of dicht is weergave: in- en uitklappen slaat niets op.
    const voor = blokRijInDb();
    await editorVak(page).locator('.page-details > button').first().click();
    await page.waitForTimeout(2500);
    gelijk(tekst(await paginaStatus(page).innerText()), 'Opgeslagen', 'status na inklappen');
    gelijk(blokRijInDb().edit_version, voor.edit_version, 'edit_version na inklappen');
    const rij = blokRijInDb();
    gelijk(telBlok(rij.id, '@.type == "callout" && @.attrs.variant == "waarschuwing"'), 1, 'de callout als waarschuwing');
    gelijk(telBlok(rij.id, '@.type == "details"'), 1, 'de uitklapper');
    gelijk(telBlok(rij.id, '@.type == "detailsContent" && @.content[0].content[0].text == "Uitleg hier."'), 1, 'de uitleg staat ín de uitklapper');
    gelijk(telBlok(rij.id, '@.type == "tableOfContents"'), 1, 'de inhoudsopgave');
    gelijk(telBlok(rij.id, '@.type == "heading" && @.attrs.level == 2'), 1, 'de kop');
    verwacht(rij.content.includes('Let op de deadline.') && rij.content.includes('Meer weten? Uitleg hier.') && rij.content.includes('Planning'),
      `de platte tekst: ${rij.content}`);
    await sluitPagina(page);
  });

  await uiStap('plakken uit Excel of Word wordt een tabel, zonder de stijl van buiten', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    const { page } = await openBlokPagina(w.medewerker, 'medewerker');
    await wachtOpgeslagen(page, 'de editor kwam niet in bewerken');
    // Eerst buiten de tabel: in een tabel plakt prosemirror-tables de cellen
    // over de bestaande heen (zo hoort het daar), en Ctrl+End verlaat een cel niet.
    await editorVak(page).locator('h2').filter({ hasText: 'Planning' }).click();
    await page.keyboard.press('Control+End');
    const bijlagenVoor = sqlRij(`select count(*)::int as n from public.attachments where entity_id = ${q(blokPagina.id)}`).n;
    await page.evaluate((png) => {
      const html = '<meta charset="utf-8"><table border=0 cellpadding=0 cellspacing=0 width=200 style="border-collapse:collapse;width:150pt">'
        + '<col width=100 style="width:75pt"><col width=100>'
        + '<tr height=20><td class=xl65 style="background:url(https://volg.test/pixel.gif);text-align:center">Product</td><td>Prijs</td></tr>'
        + '<tr><td>Thee</td><td align=right>1,80</td></tr></table>';
      const data = new DataTransfer();
      data.setData('text/html', html);
      data.setData('text/plain', 'Product\tPrijs\nThee\t1,80');
      // Excel zet er ook een plaatje van de cellen bij: dat hoort geen
      // afbeelding te worden.
      data.items.add(new File([Uint8Array.from(atob(png), (teken) => teken.charCodeAt(0))], 'cellen.png', { type: 'image/png' }));
      document.querySelector('.page-editor .tiptap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG.toString('base64'));
    await wachtTot(async () => (await editorVak(page).locator('table').count()) === 2, { melding: 'geen tweede tabel na plakken' });
    await wachtOpgeslagen(page);
    const rij = blokRijInDb();
    verwacht(rij.content.includes('Product Prijs Thee 1,80'), `tekst uit de geplakte tabel: ${rij.content}`);
    verwacht(!JSON.stringify(rij.body).includes('volg.test'), 'een adres van buiten staat in body');
    gelijk(telBlok(rij.id, '@.type == "tableCell" && @.attrs.align == "center"'), 1, 'uitlijnen uit de stijl van de geplakte cel');
    gelijk(telBlok(rij.id, '@.type == "image"'), 0, 'het plaatje van Excel werd een afbeelding');
    gelijk(sqlRij(`select count(*)::int as n from public.attachments where entity_id = ${q(blokPagina.id)}`).n, bijlagenVoor, 'bijlagen na plakken uit Excel');
    await sluitPagina(page);
  });

  await uiStap('opnieuw openen met elk nieuw blok verandert niets, en ongedaan maken staat uit', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    const voor = blokRijInDb();
    const { page } = await openBlokPagina(w.medewerker, 'medewerker');
    await wachtOpgeslagen(page, 'de editor kwam niet in bewerken');
    await editorVak(page).locator('.page-toc').waitFor({ timeout: 10000 });
    gelijk(await editorVak(page).locator('table').count(), 2, 'twee tabellen');
    gelijk(await editorVak(page).locator('.page-callout').count(), 1, 'de callout');
    gelijk(await editorVak(page).locator('.page-details').count(), 1, 'de uitklapper');
    gelijk(await page.getByRole('button', { name: 'Ongedaan maken', exact: true }).isDisabled(), true, 'ongedaan maken direct na openen');
    await page.waitForTimeout(2500);
    gelijk(tekst(await paginaStatus(page).innerText()), 'Opgeslagen', 'status na alleen openen');
    await sluitPagina(page);
    const na = blokRijInDb();
    gelijk([na.edit_version, na.gewijzigd], [voor.edit_version, voor.gewijzigd], 'edit_version en "laatst gewijzigd" na alleen openen');
  });

  await uiStap('een pagina met een blok dat deze app niet kent, gaat alleen open om te lezen en blijft zoals hij was', async () => {
    // Tiptap maakte van zo'n pagina stilletjes een lege; de eerste toets
    // schreef die dan over de echte heen.
    const body = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Boven de kolommen.' }] },
      { type: 'columns', content: [{ type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Links' }] }] }] },
    ] };
    const titel = `Uit de toekomst ${Date.now().toString(36)}`;
    sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id)
      values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', ${q(JSON.stringify(body))}::jsonb, ${q(w.klantA.id)})`);
    const nieuw = sqlRij(`select id, edit_version, updated_at::text as gewijzigd, body::text as body from public.documents
      where organization_id = ${q(w.orgId)} and title = ${q(titel)}`);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    const adres = new URL(page.url());
    adres.searchParams.set('pagina', nieuw.id);
    await page.goto(adres.toString());
    await page.locator('.page-editor').waitFor({ timeout: 30000 });
    const banner = page.locator('.page-editor-banner');
    await wachtTot(async () => tekst(await banner.innerText().catch(() => '')).includes('Ververs de app'), { melding: 'geen melding over een onbekend blok' });
    gelijk(tekst(await paginaStatus(page).innerText()), 'Alleen lezen', 'status');
    gelijk(await editorVak(page).getAttribute('contenteditable'), 'false', 'niet bewerkbaar');
    gelijk(await page.locator('.page-editor-toolbar').count(), 0, 'geen werkbalk');
    gelijk(await page.getByRole('button', { name: 'App verversen', exact: true }).count(), 1, 'een knop om te verversen');
    gelijk(sqlRij(`select count(*)::int as n from public.document_edit_claims where document_id = ${q(nieuw.id)}`).n, 0, 'geen claim');
    await editorVak(page).click();
    await page.keyboard.type('xyz');
    await page.waitForTimeout(2500);
    await sluitPagina(page);
    const na = sqlRij(`select edit_version, updated_at::text as gewijzigd, body::text as body from public.documents where id = ${q(nieuw.id)}`);
    gelijk([na.edit_version, na.gewijzigd, na.body], [nieuw.edit_version, nieuw.gewijzigd, nieuw.body], 'de pagina is onveranderd');
    gelijk(sqlRij(`select count(*)::int as n from public.document_versions where document_id = ${q(nieuw.id)}`).n, 0, 'geen versie');
  });

  await uiStap('op een telefoon: de +-knop opent het blokmenu als paneel, terug sluit het menu, en een brede tabel schuift binnen de pagina', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    // Eerst naar het dossier: op een telefoon zit het menu achter een knop.
    await naarKlantdossier(lid, w.klantA.name);
    await page.setViewportSize({ width: 390, height: 844 });
    await rustig(lid);
    await blokRij(page).click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtOpgeslagen(page, 'de editor kwam niet in bewerken');
    await editorVak(page).locator('td').filter({ hasText: 'Koffie' }).first().click();
    const tabelBalk = page.locator('.page-editor-subbar[aria-label="Tabel"]');
    await tabelBalk.waitFor({ timeout: 5000 });
    for (let i = 0; i < 4; i += 1) await tabelBalk.getByRole('button', { name: 'Kolom rechts', exact: true }).click();
    await wachtOpgeslagen(page);
    const maat = async (el) => el.evaluate((node) => ({ sw: node.scrollWidth, cw: node.clientWidth }));
    const pagina = await maat(page.locator('.page-editor-scroll'));
    verwacht(pagina.sw <= pagina.cw + 1, `de pagina schuift opzij: ${JSON.stringify(pagina)}`);
    const omhulsel = await maat(editorVak(page).locator('.tableWrapper').first());
    verwacht(omhulsel.sw > omhulsel.cw, `de tabel schuift niet binnen de pagina: ${JSON.stringify(omhulsel)}`);
    await editorVak(page).locator('p').filter({ hasText: 'Intro' }).first().click();
    const plus = page.getByRole('button', { name: 'Blok invoegen', exact: true });
    await plus.click();
    const paneel = page.locator('.page-block-menu.is-sheet');
    await paneel.waitFor({ timeout: 5000 });
    const vak = await paneel.boundingBox();
    verwacht(vak && vak.x >= 0 && vak.x + vak.width <= 391 && vak.y + vak.height <= 845, `het paneel past niet: ${JSON.stringify(vak)}`);
    await page.goBack();
    await paneel.waitFor({ state: 'detached', timeout: 5000 });
    verwacht(await page.locator('.page-editor').isVisible(), 'terug sloot de pagina in plaats van het menu');
    await plus.click();
    await paneel.getByRole('option', { name: /Scheidingslijn/ }).click();
    await paneel.waitFor({ state: 'detached', timeout: 5000 });
    await wachtTot(async () => (await editorVak(page).locator('hr').count()) === 1, { melding: 'geen scheidingslijn' });
    // Na de lijn komt de tabel. Typen hoort op een nieuwe regel te komen; de
    // tabel bleef eerst geselecteerd en werd overschreven.
    await page.keyboard.type('Na de lijn');
    await wachtTot(async () => (await editorVak(page).locator('p').filter({ hasText: 'Na de lijn' }).count()) === 1, { melding: 'de tekst na de lijn staat niet op een eigen regel' });
    verwacht(tekst(await editorVak(page).locator('table').first().innerText()).includes('Bedrag'), 'de tabel na de lijn is overschreven');
    await wachtOpgeslagen(page);
    await page.screenshot({ path: path.join(os.tmpdir(), 'stromen-ui-blokken-telefoon.png') });
    await sluitPagina(page);
    // Alleen lezen (de kijker): de tabel schuift ook dan binnen de pagina.
    const kijker = await openWerkruimte(w.kijker, 'kijker', w.orgId, { tijdelijk: true });
    await kijker.page.setViewportSize({ width: 390, height: 844 });
    await rustig(kijker);
    const adres = new URL(kijker.page.url());
    adres.searchParams.set('pagina', blokPagina.id);
    await kijker.page.goto(adres.toString());
    await kijker.page.locator('.page-editor .tableWrapper').first().waitFor({ timeout: 30000 });
    gelijk(await editorVak(kijker.page).getAttribute('contenteditable'), 'false', 'de kijker leest alleen');
    const kijkPagina = await maat(kijker.page.locator('.page-editor-scroll'));
    verwacht(kijkPagina.sw <= kijkPagina.cw + 1, `de pagina schuift opzij bij alleen lezen: ${JSON.stringify(kijkPagina)}`);
    await kijker.page.screenshot({ path: path.join(os.tmpdir(), 'stromen-ui-blokken-lezen.png') });
    await sluitPagina(kijker.page);
  });

  await uiStap('een lijn via de werkbalk of met --- boven een tabel: typen komt op een eigen regel, de tabel blijft heel', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    const { page } = await openBlokPagina(w.medewerker, 'medewerker');
    await wachtOpgeslagen(page, 'de editor kwam niet in bewerken');
    // "Na de lijn" staat direct boven de tabel (stap hiervoor).
    await editorVak(page).locator('p').filter({ hasText: 'Na de lijn' }).first().click();
    await page.keyboard.press('End');
    await page.locator('.page-editor-toolbar').getByRole('button', { name: 'Scheidingslijn', exact: true }).click();
    await page.keyboard.type('Na de knop');
    await wachtTot(async () => (await editorVak(page).locator('p').filter({ hasText: 'Na de knop' }).count()) === 1, { melding: 'de tekst na de knop staat niet op een eigen regel' });
    verwacht(tekst(await editorVak(page).locator('table').first().innerText()).includes('Bedrag'), 'de tabel na de knop is overschreven');
    // De derde ingang: --- aan het begin van een regel.
    await page.keyboard.press('Enter');
    await page.keyboard.type('---');
    await page.keyboard.type('Na de streepjes');
    await wachtTot(async () => (await editorVak(page).locator('p').filter({ hasText: 'Na de streepjes' }).count()) === 1, { melding: 'de tekst na --- staat niet op een eigen regel' });
    verwacht(tekst(await editorVak(page).locator('table').first().innerText()).includes('Bedrag'), 'de tabel na --- is overschreven');
    gelijk(await editorVak(page).locator('hr').count(), 3, 'drie lijnen: menu, werkbalk en ---');
    await wachtOpgeslagen(page);
    // Licht thema: kaders, kopcellen en het menu ook eens zo bekeken.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await editorVak(page).locator('td').filter({ hasText: 'Koffie' }).first().click();
    await page.screenshot({ path: path.join(os.tmpdir(), 'stromen-ui-blokken-licht.png') });
    await page.keyboard.press('Control+End');
    await page.keyboard.type('/');
    await page.locator('.page-block-menu').waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'stromen-ui-blokken-licht-menu.png') });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');
    await wachtOpgeslagen(page);
    await sluitPagina(page);
  });
  // ── Subpagina's (stap 1A-4b) ──────────────────────────────────────────────
  await uiStap('subpagina via /pagina: een pagina onder deze; openen, omhoog, en de terugknop volgt de weg', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    const titelVan = async (page) => page.locator('.page-editor-title').inputValue().catch(() => '');
    const { page } = await openBlokPagina(w.medewerker, 'medewerker');
    await wachtOpgeslagen(page, 'de editor kwam niet in bewerken');
    await editorVak(page).locator('h2').filter({ hasText: 'Planning' }).click();
    await page.keyboard.press('Control+End');
    await kiesBlok(page, 'pagina', 'Subpagina');
    const blok = editorVak(page).locator('.page-subpage');
    await wachtTot(async () => tekst(await blok.innerText().catch(() => '')) === 'Naamloze pagina', { melding: `het subpagina-blok: ${tekst(await blok.innerText().catch(() => ''))}` });
    await wachtOpgeslagen(page);
    const kind = sqlRij(`select id, client_id, folder_id from public.documents where parent_id = ${q(blokPagina.id)}`);
    verwacht(kind, 'geen subpagina in de database');
    gelijk([kind.client_id, kind.folder_id], [w.klantA.id, null], 'de subpagina hoort bij klant A, zonder map');
    gelijk(telBlok(blokPagina.id, `@.type == "subpage" && @.attrs.pageId == "${kind.id}"`), 1, 'het blok wijst naar de subpagina');
    // Openen: eerst opslaan en de claim los, dan de subpagina.
    await blok.locator('button').click();
    await wachtTot(async () => (await titelVan(page)) === 'Naamloze pagina', { melding: 'de subpagina ging niet open' });
    await wachtTot(async () => page.url().includes(`pagina=${kind.id}`), { melding: `het adres volgt niet: ${page.url()}` });
    gelijk(sqlRij(`select count(*)::int as n from public.document_edit_claims where document_id = ${q(blokPagina.id)}`).n, 0, 'de claim op de bovenliggende pagina is los');
    await wachtOpgeslagen(page, 'de subpagina kwam niet in bewerken');
    await page.locator('.page-editor-title').fill('Onderpagina');
    await editorVak(page).click();
    await page.keyboard.type('Tekst op de subpagina.');
    await wachtOpgeslagen(page);
    // Omhoog met de knop in de balk; het blok toont dan de nieuwe titel.
    const omhoog = page.locator('.page-editor-parent');
    await wachtTot(async () => tekst(await omhoog.innerText().catch(() => '')).includes(blokTitel), { melding: `de knop omhoog: ${tekst(await omhoog.innerText().catch(() => ''))}` });
    await omhoog.click();
    await wachtTot(async () => (await titelVan(page)) === blokTitel, { melding: 'omhoog ging niet naar de bovenliggende pagina' });
    await wachtTot(async () => tekst(await editorVak(page).locator('.page-subpage').innerText().catch(() => '')) === 'Onderpagina', { melding: 'het blok toont de nieuwe titel niet' });
    // De terugknop volgt de weg: de subpagina, weer de bovenliggende, dan dicht.
    await page.goBack();
    await wachtTot(async () => (await titelVan(page)) === 'Onderpagina', { melding: 'terug ging niet naar de subpagina' });
    await page.goBack();
    await wachtTot(async () => (await titelVan(page)) === blokTitel, { melding: 'terug ging niet naar de bovenliggende pagina' });
    await page.goBack();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
    gelijk(sqlRij(`select content from public.documents where id = ${q(kind.id)}`).content, 'Tekst op de subpagina.', 'de tekst van de subpagina is bewaard');
    // Een subpagina die niet meer bestaat: het blok zegt het, en klikken doet niets.
    sql(`delete from public.documents where id = ${q(kind.id)}`);
    const { page: opnieuw } = await openBlokPagina(w.medewerker, 'medewerker');
    const weg = editorVak(opnieuw).locator('.page-subpage');
    await wachtTot(async () => tekst(await weg.innerText().catch(() => '')) === 'Pagina niet gevonden', { melding: 'een verdwenen subpagina toont geen melding' });
    await weg.locator('button').click();
    await opnieuw.waitForTimeout(800);
    gelijk(await titelVan(opnieuw), blokTitel, 'klikken op een verdwenen subpagina opende iets');
    await sluitPagina(opnieuw);
  });
  // ── Afbeeldingen (stap 1A-4b) ──────────────────────────────────────────────
  /** De media-worker voor dit tabblad: uploads in nep-R2, en weer ophalen met de sleutel. */
  const mediaVoor = async (page) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    await page.route(/\/__media\/(upload|file\/.+)$/, async (route) => {
      const verzoek = route.request();
      if (verzoek.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
      const url = new URL(verzoek.url());
      if (url.pathname.endsWith('/upload')) {
        const kop = verzoek.headers();
        const naam = decodeURIComponent(kop['x-file-name'] ?? 'bestand');
        const sleutel = `${kop['x-organization-id']}/${kop['x-entity-type']}/${kop['x-entity-id']}/${randomUUID()}-${naam}`;
        post.r2.set(sleutel, new Uint8Array(verzoek.postDataBuffer() ?? Buffer.alloc(0)));
        await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ ok: true, key: sleutel }) });
        return;
      }
      const bytes = post.r2.get(decodeURIComponent(url.pathname.replace(/^.*\/__media\/file\//, '')));
      if (!bytes) { await route.fulfill({ status: 404, headers: cors, body: 'niet gevonden' }); return; }
      await route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: Buffer.from(bytes) });
    });
  };
  const openMetMedia = async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    await mediaVoor(lid.page);
    await naarKlantdossier(lid, w.klantA.name);
    await blokRij(lid.page).click();
    await lid.page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtOpgeslagen(lid.page, 'de editor kwam niet in bewerken');
    return lid.page;
  };
  const geladen = (beelden) => beelden.evaluateAll((imgs) => imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0));

  await uiStap('afbeeldingen: kiezen, plakken en slepen; een plaatje van buiten wordt niets; uit een ander dossier zegt de editor waarom; een verdwenen afbeelding zegt het', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    const page = await openMetMedia();
    await editorVak(page).locator('h2').filter({ hasText: 'Planning' }).click();
    await page.keyboard.press('Control+End');
    // Eerst luisteren, dan pas Enter: Playwright vangt de bestandskiezer pas op
    // als het luisteren loopt, en dat wordt los van de toets aangezet.
    const kiezerOnderweg = page.waitForEvent('filechooser', { timeout: 30000 });
    kiezerOnderweg.catch(() => {});
    await page.keyboard.type('/afb');
    const menu = page.locator('.page-block-menu');
    await menu.waitFor({ timeout: 10000 });
    await wachtTot(async () => tekst(await menu.locator('.page-block-item.is-active .page-block-label').innerText().catch(() => '')) === 'Afbeelding', { melding: 'Afbeelding staat niet bovenaan' });
    await page.keyboard.press('Enter');
    const kiezer = await kiezerOnderweg;
    await kiezer.setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: PNG });
    const beeld = editorVak(page).locator('.page-image img');
    await wachtTot(async () => (await beeld.count()) === 1 && (await geladen(beeld)), { melding: 'de afbeelding staat niet in beeld' });
    await wachtOpgeslagen(page);
    const bijlage = sqlRij(`select id, entity_type from public.attachments where organization_id = ${q(w.orgId)} and entity_id = ${q(blokPagina.id)} and name = 'foto.png'`);
    verwacht(bijlage, 'geen bijlage bij de pagina');
    gelijk(bijlage.entity_type, 'document', 'de afbeelding is een bijlage van de pagina');
    gelijk(telBlok(blokPagina.id, `@.type == "image" && @.attrs.attachmentId == "${bijlage.id}"`), 1, 'het blok wijst naar de bijlage');
    gelijk(telBlok(blokPagina.id, '@.type == "image" && exists(@.attrs.src)'), 0, 'geen adres in body');
    // Na het invoegen staat de cursor onder de afbeelding: typen vervangt hem niet.
    await page.keyboard.type('Onder de foto');
    await wachtTot(async () => (await editorVak(page).locator('p').filter({ hasText: 'Onder de foto' }).count()) === 1, { melding: 'de tekst kwam niet onder de afbeelding' });
    gelijk(await beeld.count(), 1, 'de afbeelding staat er nog na typen');
    // Een plaatje als bestand plakken wordt een tweede afbeelding.
    await page.evaluate((png) => {
      const bytes = Uint8Array.from(atob(png), (teken) => teken.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'geplakt.png', { type: 'image/png' }));
      document.querySelector('.page-editor .tiptap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG.toString('base64'));
    await wachtTot(async () => (await beeld.count()) === 2 && (await geladen(beeld)), { melding: 'een geplakt plaatje werd geen afbeelding' });
    // Een plaatje van buiten (HTML met een adres) wordt niets; de tekst eromheen wel.
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/html', '<p>Van internet</p><img src="https://volg.test/pixel.png" alt="volg">');
      data.setData('text/plain', 'Van internet');
      document.querySelector('.page-editor .tiptap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await wachtTot(async () => (await editorVak(page).locator('p').filter({ hasText: 'Van internet' }).count()) === 1, { melding: 'de geplakte tekst kwam er niet bij' });
    gelijk(await beeld.count(), 2, 'afbeeldingen na een plaatje van buiten');
    await wachtOpgeslagen(page);
    verwacht(!JSON.stringify(blokRijInDb().body).includes('volg.test'), 'het adres van buiten staat in body');
    // Slepen: een plaatje op de regel "Onder de foto" wordt een derde afbeelding.
    const doel = await editorVak(page).locator('p').filter({ hasText: 'Onder de foto' }).first().boundingBox();
    await page.evaluate(({ png, x, y }) => {
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), (teken) => teken.charCodeAt(0))], 'gesleept.png', { type: 'image/png' }));
      document.querySelector('.page-editor .tiptap').dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, { png: PNG.toString('base64'), x: doel.x + 4, y: doel.y + doel.height / 2 });
    await wachtTot(async () => (await beeld.count()) === 3 && (await geladen(beeld)), { melding: 'een gesleept plaatje werd geen afbeelding' });
    await wachtOpgeslagen(page);
    verwacht(sqlRij(`select count(*)::int as n from public.attachments where entity_id = ${q(blokPagina.id)} and name = 'gesleept.png'`).n === 1, 'het gesleepte plaatje is geen bijlage');
    // Een afbeelding uit een ander dossier (geplakt uit een andere pagina): de
    // database weigert het opslaan, de editor zegt waarom, en zonder dat blok
    // slaat hij weer op.
    sql(`insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
      values (${q(w.orgId)}, 'client', ${q(w.klantB.id)}, 'vreemd.png', 'image/png', 10, ${q(`${w.orgId}/client/${w.klantB.id}/${randomUUID()}-vreemd.png`)})`);
    const vreemd = sqlRij(`select id from public.attachments where organization_id = ${q(w.orgId)} and name = 'vreemd.png'`);
    await page.evaluate((id) => {
      const data = new DataTransfer();
      data.setData('text/html', `<img data-attachment-id="${id}" alt="">`);
      document.querySelector('.page-editor .tiptap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, vreemd.id);
    const banner = page.locator('.page-editor-banner');
    await wachtTot(async () => tekst(await banner.innerText().catch(() => '')).includes('ander dossier'), { melding: `geen uitleg bij een geweigerde opslag: ${tekst(await banner.innerText().catch(() => ''))}` });
    await editorVak(page).locator(`.page-image[data-attachment-id="${vreemd.id}"]`).click();
    await page.keyboard.press('Backspace');
    await wachtOpgeslagen(page, 'zonder het vreemde blok slaat de pagina niet op');
    gelijk(await banner.count(), 0, 'de melding staat er nog na opslaan');
    gelijk(telBlok(blokPagina.id, `@.type == "image" && @.attrs.attachmentId == "${vreemd.id}"`), 0, 'het vreemde blok in body');
    await sluitPagina(page);
    // Opnieuw openen: de afbeeldingen komen terug van de worker, en openen verandert niets.
    const voor = blokRijInDb();
    const terug = await openMetMedia();
    const beeldTerug = editorVak(terug).locator('.page-image img');
    await wachtTot(async () => (await beeldTerug.count()) === 3 && (await geladen(beeldTerug)), { melding: 'de afbeeldingen komen niet terug' });
    await terug.waitForTimeout(1500);
    // Word: de afbeeldingen komen van de worker en gaan mee in het bestand. De
    // export slaat alleen op als er iets veranderd is, dus ook dit verandert niets.
    const docx = new Map(leesZip(readFileSync(await (await exporteerWord(terug)).path())).map((deel) => [deel.name, deel.data]));
    const media = [...docx.keys()].filter((naam) => naam.startsWith('word/media/'));
    gelijk(media.length, 3, `de afbeeldingen in het Word-bestand: ${media.join(', ')}`);
    gelijk((docx.get('word/document.xml')?.toString('utf8').match(/<w:drawing>/g) ?? []).length, 3, 'de afbeeldingen in document.xml');
    await sluitPagina(terug);
    const na = blokRijInDb();
    gelijk([na.edit_version, na.gewijzigd], [voor.edit_version, voor.gewijzigd], 'openen met afbeeldingen verandert niets');
    // Een verdwenen afbeelding: het blok zegt het.
    sql(`delete from public.attachments where id = ${q(bijlage.id)}`);
    const zonder = await openMetMedia();
    const weg = editorVak(zonder).locator('.page-image.is-missing');
    await wachtTot(async () => tekst(await weg.innerText().catch(() => '')) === 'Afbeelding niet gevonden', { melding: 'een verdwenen afbeelding toont geen melding' });
    await sluitPagina(zonder);
  // De geweigerde opslag met de vreemde afbeelding is precies wat deze stap toetst.
  }, { toegestaan: [{ tabel: 'documents', methode: 'PATCH', status: 400, antwoord: /ander dossier/ }] });
  // ── Bestanden (stap 1A-4b) ─────────────────────────────────────────────────
  await uiStap('bestanden: kiezen uit het dossier (alleen dat dossier), opslaan via een download, van de computer en slepen; een verdwenen bestand zegt het', async () => {
    if (!blokPagina) throw new Error('geen pagina');
    // Een bestand in het dossier van klant A, en een in dat van klant B (dat hoort niet in de kiezer).
    const bijlageIn = (klant, naam) => {
      sql(`insert into public.content_folders (organization_id, client_id, name) values (${q(w.orgId)}, ${q(klant)}, ${q(`Map ${naam}`)})`);
      const map = sqlRij(`select id from public.content_folders where organization_id = ${q(w.orgId)} and name = ${q(`Map ${naam}`)}`);
      const sleutel = `${w.orgId}/folder/${map.id}/${randomUUID()}-${naam}`;
      post.r2.set(sleutel, new TextEncoder().encode(`inhoud van ${naam}`));
      sql(`insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
        values (${q(w.orgId)}, 'folder', ${q(map.id)}, ${q(naam)}, 'application/pdf', 2048, ${q(sleutel)})`);
      return sqlRij(`select id from public.attachments where organization_id = ${q(w.orgId)} and name = ${q(naam)}`).id;
    };
    const offerte = bijlageIn(w.klantA.id, 'Offerte.pdf');
    bijlageIn(w.klantB.id, 'Geheim.pdf');
    const page = await openMetMedia();
    const bestanden = editorVak(page).locator('.page-file');
    await editorVak(page).locator('h2').filter({ hasText: 'Planning' }).click();
    // De laatste regel heeft tekst ("Van internet"): eerst een nieuwe regel, want
    // een / direct na een letter is geen opdracht.
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await kiesBlok(page, 'bestand', 'Bestand');
    const kiezer = page.locator('.page-file-picker');
    await kiezer.waitFor({ timeout: 10000 });
    await wachtTot(async () => (await kiezer.locator('.page-file-picker-item').filter({ hasText: 'Offerte.pdf' }).count()) === 1, { melding: `het bestand van klant A staat niet in de kiezer: ${tekst(await kiezer.innerText().catch(() => ''))}` });
    gelijk(await kiezer.locator('.page-file-picker-item').filter({ hasText: 'Geheim.pdf' }).count(), 0, 'een bestand van klant B in de kiezer');
    await kiezer.locator('.page-file-picker-item').filter({ hasText: 'Offerte.pdf' }).click();
    await kiezer.waitFor({ state: 'detached', timeout: 5000 });
    await wachtTot(async () => tekst(await bestanden.first().innerText().catch(() => '')).includes('Offerte.pdf'), { melding: 'het bestandsblok toont de naam niet' });
    verwacht(tekst(await bestanden.first().innerText()).includes('2 kB'), `de grootte: ${tekst(await bestanden.first().innerText())}`);
    // Na het invoegen typ je gewoon verder, onder het blok.
    await page.keyboard.type('Na het bestand');
    await wachtTot(async () => (await editorVak(page).locator('p').filter({ hasText: 'Na het bestand' }).count()) === 1, { melding: 'de tekst kwam niet onder het bestand' });
    gelijk(await bestanden.count(), 1, 'het bestandsblok staat er nog na typen');
    await wachtOpgeslagen(page);
    gelijk(telBlok(blokPagina.id, `@.type == "fileBlock" && @.attrs.attachmentId == "${offerte}"`), 1, 'het blok wijst naar het dossierbestand');
    // Klikken slaat het bestand op (een download), en opent niets in de app.
    const downloadOnderweg = page.waitForEvent('download', { timeout: 15000 });
    // Mislukt de stap eerder, dan mag deze wachtende belofte het proces niet laten vallen.
    downloadOnderweg.catch(() => {});
    await bestanden.first().locator('button').click();
    const download = await downloadOnderweg;
    gelijk(download.suggestedFilename(), 'Offerte.pdf', 'de naam van de download');
    gelijk(page.url().includes('blob:'), false, 'de app opende het bestand');
    // Van de computer: via de kiezer, als bijlage van de pagina.
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await kiesBlok(page, 'bestand', 'Bestand');
    await kiezer.waitFor({ timeout: 10000 });
    const kiezerOnderweg = page.waitForEvent('filechooser', { timeout: 30000 });
    kiezerOnderweg.catch(() => {});
    await page.waitForTimeout(500);
    await kiezer.getByRole('button', { name: /Van je computer/ }).click();
    const bestandskiezer = await kiezerOnderweg;
    await bestandskiezer.setFiles({ name: 'notitie.txt', mimeType: 'text/plain', buffer: Buffer.from('een notitie') });
    await wachtTot(async () => (await bestanden.filter({ hasText: 'notitie.txt' }).count()) === 1, { melding: 'het geüploade bestand staat er niet' });
    // Slepen: een PDF wordt een bestandsblok, geen afbeelding, en de browser opent hem niet.
    const doel = await editorVak(page).locator('p').filter({ hasText: 'Na het bestand' }).first().boundingBox();
    await page.evaluate(({ x, y }) => {
      const data = new DataTransfer();
      data.items.add(new File([new TextEncoder().encode('%PDF-1.4 brief')], 'brief.pdf', { type: 'application/pdf' }));
      document.querySelector('.page-editor .tiptap').dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    }, { x: doel.x + 4, y: doel.y + doel.height / 2 });
    await wachtTot(async () => (await bestanden.filter({ hasText: 'brief.pdf' }).count()) === 1, { melding: 'een gesleepte PDF werd geen bestandsblok' });
    await wachtOpgeslagen(page);
    const eigen = sqlRij(`select count(*)::int as n from public.attachments where entity_type = 'document' and entity_id = ${q(blokPagina.id)} and name in ('notitie.txt', 'brief.pdf')`);
    gelijk(eigen.n, 2, 'de geüploade en gesleepte bestanden zijn bijlagen van de pagina');
    gelijk(telBlok(blokPagina.id, '@.type == "fileBlock"'), 3, 'bestandsblokken in body');
    await sluitPagina(page);
    // Een verdwenen bestand: het blok zegt het, en klikken doet niets.
    sql(`delete from public.attachments where id = ${q(offerte)}`);
    const zonder = await openMetMedia();
    const weg = editorVak(zonder).locator(`.page-file[data-attachment-id="${offerte}"]`);
    await wachtTot(async () => tekst(await weg.innerText().catch(() => '')) === 'Bestand niet gevonden', { melding: 'een verdwenen bestand toont geen melding' });
    await sluitPagina(zonder);
  });

}

/**
 * Pagina's in de drive (stap 1A-5): de boom en de prullenbak. Een eigen
 * scenario, los van "documenten": de stappen maken hun eigen pagina's, en zo
 * draait dit in een paar minuten.
 */
async function scenarioPaginadrive() {
  groep('UI: pagina\'s in de drive');
  const { w } = t;
  const sluitPagina = async (page) => {
    await page.locator('.page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
  };
  // ── De boom in de drive (stap 1A-5) ────────────────────────────────────────
  await uiStap('de drive: subpagina\'s onder hun pagina, uitklappen, een pagina op een pagina slepen, het kruimelpad, en terug naar een map', async () => {
    const boom = Date.now().toString(36);
    const nieuwePagina = (titel, ouder = null) => {
      sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id)
        values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, ${q(w.klantA.id)}, ${ouder ? q(ouder) : 'null'})`);
      return sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).id;
    };
    const ouder = nieuwePagina(`Boom ouder ${boom}`);
    nieuwePagina(`Boom kind ${boom}`, ouder);
    const los = nieuwePagina(`Boom los ${boom}`);
    sql(`insert into public.content_folders (organization_id, client_id, name) values (${q(w.orgId)}, ${q(w.klantA.id)}, ${q(`Boommap ${boom}`)})`);
    const map = sqlRij(`select id from public.content_folders where organization_id = ${q(w.orgId)} and name = ${q(`Boommap ${boom}`)}`).id;
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    const rij = (titel) => inhoud(page).locator('.odrv-row').filter({ hasText: titel }).first();
    await rij(`Boom ouder ${boom}`).waitFor({ timeout: 15000 });
    verwacht(tekst(await rij(`Boom ouder ${boom}`).innerText()).includes('1 subpagina'), `de pagina noemt haar subpagina niet: ${tekst(await rij(`Boom ouder ${boom}`).innerText())}`);
    gelijk(await inhoud(page).locator('.odrv-row').filter({ hasText: `Boom kind ${boom}` }).count(), 0, 'de subpagina staat los in het dossier');
    // Uitklappen: de subpagina komt eronder.
    await rij(`Boom ouder ${boom}`).locator('.odrv-tree-toggle').click();
    await rij(`Boom kind ${boom}`).waitFor({ timeout: 5000 });
    // Een pagina op een pagina slepen: ze wordt een subpagina.
    await rij(`Boom los ${boom}`).dragTo(rij(`Boom ouder ${boom}`));
    await wachtTot(async () => sqlRij(`select parent_id from public.documents where id = ${q(los)}`).parent_id === ouder, { melding: 'slepen maakte geen subpagina' });
    await wachtTot(async () => tekst(await rij(`Boom ouder ${boom}`).innerText().catch(() => '')).includes("2 subpagina's"), { melding: 'de lijst toont de nieuwe subpagina niet' });
    gelijk(sqlRij(`select folder_id, client_id from public.documents where id = ${q(los)}`).client_id, w.klantA.id, 'de subpagina hoort bij klant A');
    // Het kruimelpad in de editor.
    await rij(`Boom los ${boom}`).click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtTot(async () => tekst(await page.locator('.page-editor-crumbs').innerText().catch(() => '')).includes(`Boom ouder ${boom}`), { melding: 'geen kruimelpad naar de bovenliggende pagina' });
    await sluitPagina(page);
    // Een subpagina naar een map slepen: ze komt los van haar ouder en staat in de map.
    await rij(`Boom kind ${boom}`).dragTo(rij(`Boommap ${boom}`));
    await wachtTot(async () => {
      const kind = sqlRij(`select parent_id, folder_id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(`Boom kind ${boom}`)}`);
      return kind.parent_id === null && kind.folder_id === map;
    }, { melding: 'een subpagina in een map gesleept, kwam niet los van haar ouder' });
  });
  // ── De prullenbak (stap 1A-5b) ─────────────────────────────────────────────
  await uiStap('de prullenbak: een pagina met subpagina weggooien, onzichtbaar, terugzetten, en definitief verwijderen', async () => {
    const tag = Date.now().toString(36);
    const nieuwePagina = (titel, ouder = null) => {
      sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id)
        values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, ${q(w.klantA.id)}, ${ouder ? q(ouder) : 'null'})`);
      return sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).id;
    };
    const ouder = nieuwePagina(`Weg ouder ${tag}`);
    const kind = nieuwePagina(`Weg kind ${tag}`, ouder);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    const rij = () => inhoud(page).locator('.odrv-row').filter({ hasText: `Weg ouder ${tag}` }).first();
    await rij().waitFor({ timeout: 15000 });
    // Weggooien via het menu: de pagina en haar subpagina gaan samen.
    await rij().locator('.odrv-td-act button').first().click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Verwijderen', exact: true }).click();
    await wachtTot(async () => sqlRij(`select count(*)::int as n from public.documents where id in (${q(ouder)}, ${q(kind)}) and archived_at is not null`).n === 2, { melding: 'de pagina en haar subpagina gingen niet naar de prullenbak' });
    await wachtTot(async () => (await inhoud(page).locator('.odrv-row').filter({ hasText: `Weg ouder ${tag}` }).count()) === 0, { melding: 'een weggegooide pagina staat nog in de lijst' });
    // De prullenbak toont één regel, met de subpagina erbij.
    await inhoud(page).getByRole('button', { name: /Prullenbak/ }).click();
    const bak = page.locator('.page-trash');
    await bak.waitFor({ timeout: 10000 });
    const regel = bak.locator('.page-trash-item').filter({ hasText: `Weg ouder ${tag}` });
    await regel.waitFor({ timeout: 10000 });
    verwacht(tekst(await regel.innerText()).includes('met 1 subpagina'), `de regel: ${tekst(await regel.innerText())}`);
    gelijk(await bak.locator('.page-trash-item').filter({ hasText: `Weg kind ${tag}` }).count(), 0, 'de subpagina heeft geen eigen regel');
    // Terugzetten: samen terug, en weer in de lijst.
    await regel.getByRole('button', { name: /Terugzetten/ }).click();
    await wachtTot(async () => (await regel.count()) === 0, { melding: 'na terugzetten staat de pagina nog in de prullenbak' });
    gelijk(sqlRij(`select count(*)::int as n from public.documents where id in (${q(ouder)}, ${q(kind)}) and archived_at is null`).n, 2, 'beide terug');
    await page.keyboard.press('Escape');
    await bak.locator('.modal-close').click();
    await bak.waitFor({ state: 'detached', timeout: 5000 });
    await rij().waitFor({ timeout: 15000 });
    // Nog eens weg, en nu definitief.
    await rij().locator('.odrv-td-act button').first().click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Verwijderen', exact: true }).click();
    await wachtTot(async () => sqlRij(`select count(*)::int as n from public.documents where id = ${q(ouder)} and archived_at is not null`).n === 1, { melding: 'niet opnieuw in de prullenbak' });
    await inhoud(page).getByRole('button', { name: /Prullenbak/ }).click();
    await regel.waitFor({ timeout: 10000 });
    await regel.getByRole('button', { name: /Definitief verwijderen/ }).click();
    await wachtTot(async () => sqlRij(`select count(*)::int as n from public.documents where id in (${q(ouder)}, ${q(kind)})`).n === 0, { melding: 'definitief verwijderen liet de pagina staan' });
    await wachtTot(async () => tekst(await bak.innerText().catch(() => '')).includes('De prullenbak is leeg') || (await regel.count()) === 0, { melding: 'de regel blijft staan' });
    await bak.locator('.modal-close').click();
  });
  // ── Het eigen dossier (stap 1A-5c) ─────────────────────────────────────────
  await uiStap('het eigen dossier: bovenaan in plaats van "Geen klant", met een eigen map, en een pagina en een notitie in die map', async () => {
    const tag = Date.now().toString(36);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await sluitAlles(lid);
    await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Alle inhoud/ }).first().click();
    await rustig(lid);
    const wortel = inhoud(page).locator('.odrv-crumbs button').first();
    if (await wortel.isVisible().catch(() => false)) { await wortel.click(); await rustig(lid); }
    const eerste = inhoud(page).locator('.odrv-row').first();
    await eerste.waitFor({ timeout: 15000 });
    verwacht(tekst(await eerste.innerText()).includes('Eigen dossier'), `de eerste rij is niet het eigen dossier: ${tekst(await eerste.innerText())}`);
    gelijk(await inhoud(page).locator('.odrv-row').filter({ hasText: 'Geen klant' }).count(), 0, '"Geen klant" in de lijst');
    await eerste.click();
    await rustig(lid);
    // Een eigen map, via het menu: zonder klant in de database.
    lid.plan.push({ antwoord: `Handboek ${tag}` });
    await inhoud(page).locator('.drive-new').click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Nieuwe map', exact: true }).click();
    await wachtTot(async () => sqlRij(`select count(*)::int as n from public.content_folders where organization_id = ${q(w.orgId)} and name = ${q(`Handboek ${tag}`)} and client_id is null and project_id is null`).n === 1,
      { melding: 'geen map zonder klant gemaakt' });
    const mapRij = inhoud(page).locator('.odrv-row').filter({ hasText: `Handboek ${tag}` }).first();
    await mapRij.waitFor({ timeout: 15000 });
    await mapRij.click();
    await rustig(lid);
    // Een pagina in die map.
    await inhoud(page).locator('.drive-new').click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Pagina', exact: true }).click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    const status = page.locator('.page-editor .page-editor-status');
    await wachtTot(async () => tekst(await status.innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de editor kwam niet in bewerken' });
    await page.locator('.page-editor-title').fill(`Werkwijze ${tag}`);
    await page.locator('.page-editor .tiptap').click();
    await page.keyboard.type('Zo werken wij.');
    await wachtTot(async () => tekst(await status.innerText().catch(() => '')) === 'Opgeslagen', { melding: 'niet opgeslagen' });
    const map = sqlRij(`select id from public.content_folders where organization_id = ${q(w.orgId)} and name = ${q(`Handboek ${tag}`)}`).id;
    const pagina = sqlRij(`select folder_id, client_id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(`Werkwijze ${tag}`)}`);
    gelijk([pagina.folder_id, pagina.client_id], [map, null], 'de pagina staat in de map van het eigen dossier, zonder klant');
    await sluitPagina(page);
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Werkwijze ${tag}` }).first().waitFor({ timeout: 15000 });
    // Een notitie in die map: het venster noemt het eigen dossier (niet "Geen
    // klant") en toont de map, en zo komt ze in de database.
    await inhoud(page).locator('.drive-new').click();
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Notitie', exact: true }).click();
    const venster = page.locator('section.modal').filter({ has: page.getByPlaceholder('Titel') });
    await venster.waitFor({ timeout: 10000 });
    // De keuzelijsten van de app tonen hun keuze in .select-value.
    gelijk(await venster.locator('.select-value').filter({ hasText: /^Eigen dossier$/ }).count(), 1, 'de klantkeuze in het venster van de notitie');
    gelijk(tekst(await veld(venster, 'Map').locator('.select-value').innerText()), `Handboek ${tag}`, 'de map in het venster van de notitie');
    await venster.getByPlaceholder('Titel').fill(`Notitie ${tag}`);
    await venster.locator('.modal-foot').getByRole('button', { name: 'Opslaan', exact: true }).click();
    await wachtTot(async () => {
      const notitie = sqlRij(`select folder_id, client_id from public.notes where organization_id = ${q(w.orgId)} and title = ${q(`Notitie ${tag}`)}`);
      return Boolean(notitie) && notitie.folder_id === map && notitie.client_id === null;
    }, { melding: 'de notitie staat niet in de map van het eigen dossier' });
  });
  // ── De boom van het dossier naast de pagina (§4, het pagina-scherm) ────────
  await uiStap('de boom naast de pagina: het dossier met map en subpagina\'s, wisselen, de terugknop, verbergen, en op de telefoon een lade', async () => {
    const tag = Date.now().toString(36);
    const nieuwePagina = (titel, { ouder = null, map = null } = {}) => {
      sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id, folder_id)
        values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb, ${q(w.klantA.id)}, ${ouder ? q(ouder) : 'null'}, ${map ? q(map) : 'null'})`);
      return sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).id;
    };
    sql(`insert into public.content_folders (organization_id, client_id, name) values (${q(w.orgId)}, ${q(w.klantA.id)}, ${q(`Boekenkast ${tag}`)})`);
    const map = sqlRij(`select id from public.content_folders where organization_id = ${q(w.orgId)} and name = ${q(`Boekenkast ${tag}`)}`).id;
    const handboek = nieuwePagina(`Handboek ${tag}`);
    const hoofdstuk = nieuwePagina(`Hoofdstuk ${tag}`, { ouder: handboek });
    nieuwePagina(`Paragraaf ${tag}`, { ouder: hoofdstuk });
    const los = nieuwePagina(`Los ${tag}`);
    nieuwePagina(`In de kast ${tag}`, { map });
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Handboek ${tag}` }).first().click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    const boom = page.locator('.page-tree');
    const regel = (titel) => boom.locator('.page-tree-row').filter({ hasText: titel }).first();
    const titelVan = async () => page.locator('.page-editor-title').inputValue().catch(() => '');
    const huidig = async () => tekst(await boom.locator('[aria-current="page"]').innerText().catch(() => ''));
    const knop = page.locator('.page-editor-tree-button');
    // Breed: de boom staat er, met de klant erboven, de map als groep, en de
    // subpagina van de open pagina eronder. Dieper is nog dichtgeklapt.
    await regel(`Hoofdstuk ${tag}`).waitFor({ timeout: 15000 });
    gelijk(tekst(await boom.locator('.page-tree-name').innerText()), w.klantA.name, 'de naam boven de boom');
    gelijk(await huidig(), `Handboek ${tag}`, 'de open pagina in de boom');
    await boom.locator('.page-tree-label').filter({ hasText: `Boekenkast ${tag}` }).waitFor({ timeout: 5000 });
    await regel(`In de kast ${tag}`).waitFor({ timeout: 5000 });
    await regel(`Los ${tag}`).waitFor({ timeout: 5000 });
    gelijk(await regel(`Paragraaf ${tag}`).count(), 0, 'een dichtgeklapte tak toont zijn subpagina');
    await regel(`Hoofdstuk ${tag}`).locator('.page-tree-toggle').click();
    await regel(`Paragraaf ${tag}`).waitFor({ timeout: 5000 });
    // Wisselen: de andere pagina gaat open, en de boom blijft zoals hij was.
    await regel(`Los ${tag}`).locator('.page-tree-page').click();
    await wachtTot(async () => (await titelVan()) === `Los ${tag}`, { melding: 'een klik in de boom opende de pagina niet' });
    await wachtTot(async () => (await huidig()) === `Los ${tag}`, { melding: 'de boom wijst de open pagina niet aan' });
    verwacht(await regel(`Paragraaf ${tag}`).isVisible(), 'de boom klapte dicht bij het wisselen');
    // Een titel die je typt, staat meteen in de boom.
    await wachtTot(async () => tekst(await page.locator('.page-editor-status').innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de editor kwam niet in bewerken' });
    await page.locator('.page-editor-title').fill(`Los hernoemd ${tag}`);
    await wachtTot(async () => (await huidig()) === `Los hernoemd ${tag}`, { melding: 'de boom volgt de titel niet' });
    // Een subpagina maken met /pagina: ze komt in de boom.
    await page.locator('.page-editor .tiptap').click();
    await page.keyboard.type('/pagina');
    const menu = page.locator('.page-block-menu');
    await menu.waitFor({ timeout: 10000 });
    await wachtTot(async () => tekst(await menu.locator('.page-block-item.is-active .page-block-label').innerText().catch(() => '')) === 'Subpagina', { melding: 'het blokmenu biedt geen subpagina' });
    await page.keyboard.press('Enter');
    await wachtTot(async () => sqlRij(`select count(*)::int as n from public.documents where parent_id = ${q(los)}`).n === 1, { melding: 'geen subpagina gemaakt' });
    await wachtTot(async () => (await boom.locator('.page-tree-row').filter({ hasText: 'Naamloze pagina' }).count()) === 1, { melding: 'de nieuwe subpagina staat niet in de boom' });
    await wachtTot(async () => tekst(await page.locator('.page-editor-status').innerText().catch(() => '')) === 'Opgeslagen', { melding: 'niet opgeslagen' });
    // De terugknop gaat naar de pagina waar je vandaan kwam.
    await page.goBack();
    await wachtTot(async () => (await titelVan()) === `Handboek ${tag}`, { melding: 'terug ging niet naar de vorige pagina' });
    // Verbergen: weg, ook bij de volgende pagina. De knop in de balk haalt hem terug.
    await boom.locator('.page-tree-close').click();
    await wachtTot(async () => (await boom.count()) === 0, { melding: 'de boom ging niet weg' });
    await sluitPagina(page);
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Los hernoemd ${tag}` }).first().click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtTot(async () => (await titelVan()) === `Los hernoemd ${tag}`, { melding: 'de pagina ging niet open' });
    gelijk(await boom.count(), 0, 'de verborgen boom kwam terug bij een andere pagina');
    await knop.click();
    await regel(`Handboek ${tag}`).waitFor({ timeout: 10000 });
    // Op de telefoon: geen kolom maar een lade, die met terug dichtgaat.
    const breed = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await wachtTot(async () => (await boom.count()) === 0, { melding: 'op de telefoon staat de boom over de pagina' });
    await knop.click();
    await page.locator('.page-tree.is-drawer').waitFor({ timeout: 5000 });
    await page.goBack();
    await wachtTot(async () => (await boom.count()) === 0, { melding: 'terug sloot de lade niet' });
    gelijk(await titelVan(), `Los hernoemd ${tag}`, 'terug sloot de pagina in plaats van de lade');
    await knop.click();
    await regel(`Handboek ${tag}`).locator('.page-tree-page').click();
    await wachtTot(async () => (await titelVan()) === `Handboek ${tag}`, { melding: 'kiezen in de lade opende de pagina niet' });
    await wachtTot(async () => (await boom.count()) === 0, { melding: 'de lade bleef open na het kiezen' });
    if (breed) await page.setViewportSize(breed);
    // Weer breed: de kolom staat er weer.
    await regel(`Handboek ${tag}`).waitFor({ timeout: 10000 });
    await sluitPagina(page);
  });
  // ── Word (stap 1B-2): de opgeslagen pagina, in de huisstijl ────────────────
  await uiStap('Word: de pagina als .docx met wat je net typte, de subpagina en de huisstijlletter (via Exporteren); de balk past op de telefoon', async () => {
    const tag = Date.now().toString(36);
    const nieuwePagina = (titel, body, ouder = null) => {
      sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id)
        values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', ${q(JSON.stringify(body))}::jsonb, ${q(w.klantA.id)}, ${ouder ? q(ouder) : 'null'})`);
      return sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).id;
    };
    const woord = (text) => ({ type: 'text', text });
    const ouder = nieuwePagina(`Exportproef ${tag}`, { type: 'doc', content: [{ type: 'paragraph' }] });
    const kind = nieuwePagina(`Hoofdstuk export ${tag}`, { type: 'doc', content: [{ type: 'paragraph' }] }, ouder);
    sql(`update public.documents set body = ${q(JSON.stringify({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [woord('Werkafspraken')] },
      { type: 'callout', attrs: { variant: 'tip' }, content: [{ type: 'paragraph', content: [woord(`Kadertekst ${tag}`)] }] },
      { type: 'subpage', attrs: { pageId: kind } },
      { type: 'paragraph' },
    ] }))}::jsonb where id = ${q(ouder)}`);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Exportproef ${tag}` }).first().click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    const status = page.locator('.page-editor .page-editor-status');
    await wachtTot(async () => tekst(await status.innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de editor kwam niet in bewerken' });
    // Net getypt, nog niet opgeslagen: de export slaat eerst op.
    await page.locator('.page-editor .tiptap p').last().click();
    await page.keyboard.type(`Net getypt ${tag}`);
    const download = await exporteerWord(page);
    gelijk(download.suggestedFilename(), `Exportproef-${tag}.docx`, 'de naam van het bestand');
    const delen = new Map(leesZip(readFileSync(await download.path())).map(deel => [deel.name, deel.data]));
    const documentXml = delen.get('word/document.xml')?.toString('utf8') ?? '';
    for (const verwacht_ of [`Exportproef ${tag}`, 'Werkafspraken', `Kadertekst ${tag}`, `→ Hoofdstuk export ${tag}`, `Net getypt ${tag}`]) {
      verwacht(documentXml.includes(verwacht_), `"${verwacht_}" staat niet in document.xml`);
    }
    // De huisstijlletter is ingesloten, en de letter van het document.
    const letters = delen.get('word/fontTable.xml')?.toString('utf8') ?? '';
    verwacht(/<w:embedRegular /.test(letters), `geen ingesloten letter: ${letters.slice(0, 200)}`);
    verwacht([...delen.keys()].some(naam => naam.endsWith('.odttf')), 'geen letterbestand in de .docx');
    const familie = letters.match(/<w:font w:name="([^"]+)"/)?.[1];
    verwacht(familie && (delen.get('word/styles.xml')?.toString('utf8') ?? '').includes(`w:ascii="${familie}"`), `de stijl gebruikt de ingesloten letter niet (${familie})`);
    gelijk(sqlRij(`select content from public.documents where id = ${q(ouder)}`).content.includes(`Net getypt ${tag}`), true, 'opgeslagen vóór de export');
    // Op de telefoon: de balk met de nieuwe knop past, zonder dat de pagina opzij schuift.
    const breed = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await wachtTot(async () => page.locator('.page-editor-export').isVisible(), { melding: 'de knop Exporteren staat niet in beeld op de telefoon' });
      const maten = await page.evaluate(() => {
        const balk = document.querySelector('.page-editor-bar');
        return { pagina: document.documentElement.scrollWidth, scherm: window.innerWidth, balk: balk ? balk.scrollWidth - balk.clientWidth : -1 };
      });
      verwacht(maten.pagina <= maten.scherm && maten.balk <= 0, `de balk loopt over op 390px: ${JSON.stringify(maten)}`);
    } finally {
      if (breed) await page.setViewportSize(breed);
    }
    await sluitPagina(page);
  });
  // ── Een trage computer (de editor mag niet al weg zijn bij zijn eerste effect) ──
  await uiStap('een nieuwe pagina op een trage computer: de editor komt in bewerken, en wat je typt wordt opgeslagen', async () => {
    const tag = Date.now().toString(36);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    // Zes keer trager rekenen: dan duurt de eerste render van de editor langer
    // dan de 1 ms waarna Tiptap een editor opruimt die nog niet in gebruik is.
    // Zonder immediatelyRender: false werd de app hier zwart.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    try {
      await inhoud(page).locator('.drive-new').click();
      await page.locator('.drive-pop').getByRole('menuitem', { name: 'Pagina', exact: true }).click();
      await page.locator('.page-editor').waitFor({ timeout: 30000 });
      const status = page.locator('.page-editor .page-editor-status');
      await wachtTot(async () => tekst(await status.innerText().catch(() => '')) === 'Opgeslagen', { timeout: 30000, melding: 'de editor kwam niet in bewerken op een trage computer' });
      await page.locator('.page-editor-title').fill(`Traag ${tag}`);
      await page.locator('.page-editor .tiptap').click();
      await page.keyboard.type(`Getypt op een trage computer ${tag}`);
      await wachtTot(async () => (sqlRij(`select content from public.documents where organization_id = ${q(w.orgId)} and title = ${q(`Traag ${tag}`)}`)?.content ?? '').includes(tag),
        { timeout: 30000, melding: 'wat je typte, is niet opgeslagen' });
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    }
    await sluitPagina(page);
  });
  // ── Gerrie vult een pagina aan (§12) ──────────────────────────────────────
  await uiStap('Gerrie vult een pagina aan: een voorstel via een gekoppelde AI, "Uitvoeren" in de wachtrij, en de alinea\'s staan onderaan met een versie', async () => {
    const tag = Date.now().toString(36);
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bestaande tekst.' }] }, { type: 'paragraph' }] };
    sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id)
      values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(`Aanvulproef ${tag}`)}, 'page', ${q(JSON.stringify(body))}::jsonb, ${q(w.klantA.id)})`);
    const pagina = sqlRij(`select id, edit_version from public.documents where organization_id = ${q(w.orgId)} and title = ${q(`Aanvulproef ${tag}`)}`);
    // Een echte MCP-koppeling van de beheerder, zoals mcp-oauth hem uitgeeft (zie videovergadering.mjs).
    const clientId = `stromen-${randomUUID()}`;
    sql(`insert into public.mcp_clients (client_id, client_name, redirect_uris) values (${q(clientId)}, 'Stromen-AI', array['https://stromen.test/cb'])`);
    const grantId = sql(`insert into public.mcp_grants (organization_id, user_id, client_id, scope, label)
                         values (${q(w.orgId)}, ${q(w.beheerder.id)}, ${q(clientId)}, 'read propose', 'stromen') returning id`);
    const selector = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    sql(`insert into public.mcp_tokens (grant_id, kind, selector, verifier_hash, salt, expires_at)
         values (${q(grantId)}, 'access', ${q(selector)}, ${q(createHash('sha256').update(`${salt}:${verifier}`).digest('hex'))}, ${q(salt)}, now() + interval '1 hour')`);
    const voorstel = async (input) => {
      const res = await roep('mcp', { token: `rsfmcp.${selector}.${verifier}`, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_action', arguments: { action_id: 'document.update', input } } } });
      return { fout: res.json?.result?.isError === true, tekst: res.json?.result?.content?.[0]?.text ?? '' };
    };
    // Vervangen weigert de server, met de reden voor de AI.
    const vervangen = await voorstel({ document_id: pagina.id, content: 'Alles nieuw' });
    verwacht(vervangen.fout && /append/.test(vervangen.tekst), `vervangen werd niet geweigerd: ${vervangen.tekst}`);
    const aanvullen = await voorstel({ document_id: pagina.id, content: `<p>Eerste regel ${tag}</p><p>Tweede regel ${tag}</p>`, content_mode: 'append' });
    verwacht(!aanvullen.fout, `aanvullen klaarzetten: ${aanvullen.tekst}`);
    const audit = sqlRij(`select id, params from public.ai_action_audit where mcp_grant_id = ${q(grantId)} and status = 'proposed' order by created_at desc limit 1`);
    verwacht(audit, 'geen voorstel in de wachtrij');
    gelijk(sqlRij(`select content from public.documents where id = ${q(pagina.id)}`).content.includes(tag), false, 'er is al iets veranderd vóór het akkoord');
    // Het akkoord: als beheerder, op het startscherm.
    const beheer = await openWerkruimte(w.beheerder, 'beheerder', w.orgId, { tijdelijk: true });
    const page = beheer.page;
    await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Dashboard/ }).first().click();
    const rij = page.locator('.ag-queue-row').filter({ hasText: `Aanvulproef ${tag}` }).first();
    await rij.waitFor({ timeout: 20000 });
    verwacht(/aanvullen/.test(tekst(await rij.innerText())), `de regel in de wachtrij: ${tekst(await rij.innerText())}`);
    const versies = Number(sqlRij(`select count(*)::int as n from public.document_versions where document_id = ${q(pagina.id)}`).n);
    await rij.locator('.ag-btn-go').click();
    await wachtTot(async () => sqlRij(`select content from public.documents where id = ${q(pagina.id)}`).content.includes(`Tweede regel ${tag}`), { melding: 'de alinea\'s kwamen niet op de pagina' });
    const na = sqlRij(`select body, edit_version from public.documents where id = ${q(pagina.id)}`);
    const teksten = na.body.content.map((blok) => (blok.content ?? []).map((t) => t.text).join(''));
    gelijk(teksten, ['Bestaande tekst.', `Eerste regel ${tag}`, `Tweede regel ${tag}`], 'de alinea\'s onderaan, zonder lege regel ertussen');
    gelijk(na.edit_version, pagina.edit_version + 1, 'edit_version');
    await wachtTot(async () => Number(sqlRij(`select count(*)::int as n from public.document_versions where document_id = ${q(pagina.id)}`).n) === versies + 1, { melding: 'geen versie na het aanvullen' });
    await wachtTot(async () => sqlRij(`select status from public.ai_action_audit where id = ${q(audit.id)}`).status !== 'proposed', { melding: 'het voorstel bleef in de wachtrij staan' });
    // De aangevulde blokken komen door de controle van de editor: de pagina gaat
    // gewoon open om te bewerken, met de nieuwe tekst erin.
    await naarKlantdossier(beheer, w.klantA.name);
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Aanvulproef ${tag}` }).first().click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    await wachtTot(async () => tekst(await page.locator('.page-editor .page-editor-status').innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de aangevulde pagina gaat niet open om te bewerken' });
    await page.locator('.page-editor .tiptap').getByText(`Tweede regel ${tag}`).waitFor({ timeout: 10000 });
    await sluitPagina(page);
  }, { toegestaan: [{ soort: 'functie', functie: 'mcp' }] });
  // ── Afdrukken (§9: "Ctrl+P blijft werken, met een nette printstijl") ───────
  await uiStap('afdrukken: alleen de pagina, over de hele lengte, met de uitklapper open', async () => {
    const tag = Date.now().toString(36);
    const tekstblok = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const body = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Printkop' }] },
      { type: 'details', content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: 'Meer lezen' }] },
        { type: 'detailsContent', content: [tekstblok(`Ingeklapte tekst ${tag}`)] },
      ] },
      ...Array.from({ length: 80 }, (_, i) => tekstblok(`Alinea ${i + 1} van de printproef, lang genoeg om een regel te vullen.`)),
      tekstblok(`Laatste regel ${tag}`),
    ] };
    sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id)
      values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(`Printproef ${tag}`)}, 'page', ${q(JSON.stringify(body))}::jsonb, ${q(w.klantA.id)})`);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Printproef ${tag}` }).first().click();
    await page.locator('.page-editor').waitFor({ timeout: 20000 });
    const vak = page.locator('.page-editor .tiptap');
    await vak.getByText(`Laatste regel ${tag}`).waitFor({ timeout: 15000 });
    gelijk(await vak.getByText(`Ingeklapte tekst ${tag}`).isVisible(), false, 'de uitklapper is op het scherm dicht');
    await page.emulateMedia({ media: 'print' });
    try {
      for (const [kiezer, wat] of [['.page-editor-bar', 'de balk van de editor'], ['.page-editor-toolbar', 'de knoppen'], ['.page-tree', 'de boom'], ['.sidebar-nav', 'de zijbalk van de app']]) {
        gelijk(await page.locator(kiezer).first().isVisible().catch(() => false), false, `${wat} op papier`);
      }
      verwacht(await vak.getByText(`Ingeklapte tekst ${tag}`).isVisible(), 'een dichte uitklapper staat op papier niet open');
      verwacht(await page.locator('.page-editor-title').isVisible(), 'de titel staat niet op papier');
      // Over de hele lengte: 80 alinea's lopen door over meer bladen, zonder lege bladen erachter.
      const pdf = await page.pdf({ format: 'A4' });
      const { PDFDocument } = await import('pdf-lib');
      const bladen = (await PDFDocument.load(pdf)).getPageCount();
      verwacht(bladen >= 2 && bladen <= 6, `de pagina op papier: ${bladen} bladen`);
    } finally {
      await page.emulateMedia({ media: 'screen' });
    }
    await sluitPagina(page);
  });
}

// ── Bank: mutaties met de hand boeken ──────────────────────────────────────

/** Een transactie in de lijst "Af te letteren", op een stuk tekst. */
const bankRij = (page, patroon) => inhoud(page).locator('.bank-tx').filter({ hasText: patroon });

/**
 * Pagina's delen (stap 1C): delen is vrijgeven. De klant ziet de versie van het
 * moment van delen, en pas na "Bijwerken bij klant" wat je daarna wijzigde.
 * De database en de functies toetst run.mjs (scenario documenten); hier gaat
 * het om wat de gebruiker doet: delen vanuit de editor, subpagina's aanvinken,
 * de melding na een wijziging, bijwerken, en "Delen…" in de drive.
 */
async function scenarioPaginadelen() {
  groep('UI: pagina\'s delen');
  const { w } = t;
  const tag = Date.now().toString(36);
  const woord = (text) => ({ type: 'text', text });
  const nieuwePagina = (titel, body, ouder = null) => {
    sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id, parent_id)
      values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', ${q(JSON.stringify(body))}::jsonb, ${q(w.klantA.id)}, ${ouder ? q(ouder) : 'null'})`);
    return sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).id;
  };
  const ouder = nieuwePagina(`Delen ouder ${tag}`, { type: 'doc', content: [{ type: 'paragraph' }] });
  const kind = nieuwePagina(`Delen kind ${tag}`, { type: 'doc', content: [{ type: 'paragraph', content: [woord('Tekst van de subpagina')] }] }, ouder);
  sql(`update public.documents set body = ${q(JSON.stringify({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [woord('Werkwijze')] },
    { type: 'subpage', attrs: { pageId: kind } },
    { type: 'paragraph' },
  ] }))}::jsonb where id = ${q(ouder)}`);
  const lezenInPortaal = async (paginaId) => {
    const deling = sqlRij(`select id from public.drive_shares where item_id = ${q(paginaId)} and revoked_at is null and recipient_kind = 'client'`);
    const res = await roep('client-portal', { token: w.portaalA.token, body: { action: 'downloadSharedFile', shareId: deling.id, itemType: 'document', itemId: paginaId } });
    verwacht(res.status === 200, `lezen in het portaal: ${res.status} ${res.tekst?.slice(0, 200)}`);
    return res.json?.text?.html ?? '';
  };
  // Licht en donker vastleggen, om te zien of het venster en de melding in beide thema's leesbaar zijn.
  const beideThemas = async (lid, naam) => {
    const voor = await lid.page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    try {
      for (const thema of ['light', 'dark']) {
        await lid.page.evaluate((waarde) => document.documentElement.setAttribute('data-theme', waarde), thema);
        await schermafdruk(`${naam}-${thema}`, lid);
      }
    } finally {
      await lid.page.evaluate((waarde) => {
        if (waarde) document.documentElement.setAttribute('data-theme', waarde); else document.documentElement.removeAttribute('data-theme');
      }, voor);
    }
  };
  const openPagina = async (lid, titel) => {
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(lid.page).locator('.odrv-row').filter({ hasText: titel }).first().click();
    await lid.page.locator('.page-editor').waitFor({ timeout: 20000 });
    const status = lid.page.locator('.page-editor .page-editor-status');
    await wachtTot(async () => tekst(await status.innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de editor kwam niet in bewerken' });
  };

  await uiStap('delen vanuit de editor: met de klant, met de subpagina, en wat je net typte gaat mee; het venster ligt boven de editor', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await openPagina(lid, `Delen ouder ${tag}`);
    await page.locator('.page-editor .tiptap p').last().click();
    await page.keyboard.type(`Net getypt ${tag}`);
    await page.locator('.page-editor-share').click();
    const venster = page.locator('.modal.share-modal-page');
    await venster.waitFor({ timeout: 15000 });
    gelijk(tekst(await venster.locator('.modal-head h3').innerText()), 'Pagina delen', 'de titel van het venster');
    const vooraan = await page.evaluate(() => {
      const modal = document.querySelector('.modal.share-modal-page');
      if (!modal) return false;
      const r = modal.getBoundingClientRect();
      const punt = document.elementFromPoint(r.left + r.width / 2, r.top + 24);
      return Boolean(punt && modal.contains(punt));
    });
    verwacht(vooraan, 'het deelvenster ligt achter de editor');
    gelijk(await venster.getByText('Downloaden toestaan').count(), 0, 'bij een pagina valt niets te downloaden');
    await venster.locator('.share-people li').filter({ hasText: w.klantA.email }).locator('input[type="checkbox"]').check();
    await venster.locator('.share-subpages').getByText('Alle subpagina\'s').click();
    verwacht(await venster.locator('.share-subpage-list input[type="checkbox"]').first().isChecked(), 'de subpagina is niet aangevinkt');
    await venster.getByRole('button', { name: /Deel met 1 persoon/ }).click();
    await venster.locator('.share-results').waitFor({ timeout: 30000 });
    await wachtTot(async () => tekst(await venster.locator('.share-page-note').innerText().catch(() => '')).includes('Ook 1 subpagina gedeeld'), { melding: 'de subpagina is niet gedeeld' });
    const delingen = sqlRijen(`select s.item_id, v.reason, v.body::text as body from public.drive_shares s join public.document_versions v on v.id = s.document_version_id
      where s.item_id in (${q(ouder)}, ${q(kind)}) and s.revoked_at is null`);
    gelijk(delingen.length, 2, 'twee delingen: de pagina en haar subpagina');
    verwacht(delingen.every(rij => rij.reason === 'vrijgave'), 'elke deling heeft een vrijgave');
    verwacht(delingen.find(rij => rij.item_id === ouder)?.body.includes(`Net getypt ${tag}`), 'wat je net typte, zit niet in de vrijgave');
    await wachtTot(async () => tekst(await venster.locator('.share-current').innerText().catch(() => '')).includes('Ziet versie'), { melding: 'de versie per ontvanger staat er niet' });
    await beideThemas(lid, 'paginadelen-venster');
    const html = await lezenInPortaal(ouder);
    verwacht(html.includes(`Net getypt ${tag}`) && html.includes(`→ Delen kind ${tag}`), `het portaal: ${html.slice(0, 300)}`);
    await venster.getByRole('button', { name: 'Sluiten', exact: true }).click();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    // Op de telefoon: de knop staat in de balk, en het venster ligt vooraan.
    const breed = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await wachtTot(async () => page.locator('.page-editor-share').isVisible(), { melding: 'de knop Delen staat niet in beeld op de telefoon' });
      const maten = await page.evaluate(() => {
        const balk = document.querySelector('.page-editor-bar');
        return { pagina: document.documentElement.scrollWidth, scherm: window.innerWidth, balk: balk ? balk.scrollWidth - balk.clientWidth : -1 };
      });
      verwacht(maten.pagina <= maten.scherm && maten.balk <= 0, `de balk loopt over op 390px: ${JSON.stringify(maten)}`);
      await page.locator('.page-editor-share').click();
      await venster.waitFor({ timeout: 15000 });
      verwacht(await venster.isVisible(), 'het venster staat niet in beeld op de telefoon');
      await beideThemas(lid, 'paginadelen-telefoon');
      await venster.locator('.modal-close').click();
      await venster.waitFor({ state: 'detached', timeout: 5000 });
    } finally {
      if (breed) await page.setViewportSize(breed);
    }
  });

  await uiStap('een subpagina die je net in de editor maakte, deel je meteen: het venster weet dat het een pagina van de klant is', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await openPagina(lid, `Delen ouder ${tag}`);
    await page.locator('.page-editor .tiptap').click();
    await page.keyboard.press('Control+End');
    // Het blokmenu opent met / aan het begin van een regel.
    await page.keyboard.press('Enter');
    await page.keyboard.type('/pagina');
    const menu = page.locator('.page-block-menu');
    await menu.waitFor({ timeout: 10000 });
    await wachtTot(async () => tekst(await menu.locator('.page-block-item.is-active .page-block-label').innerText().catch(() => '')) === 'Subpagina', { melding: 'het blokmenu biedt geen subpagina' });
    await page.keyboard.press('Enter');
    await menu.waitFor({ state: 'detached', timeout: 10000 });
    const blok = page.locator('.page-editor .tiptap .page-subpage').last();
    await wachtTot(async () => tekst(await blok.innerText().catch(() => '')) === 'Naamloze pagina', { melding: 'geen nieuw subpagina-blok' });
    await blok.locator('button').click();
    await wachtTot(async () => (await page.locator('.page-editor-title').inputValue().catch(() => '')) === 'Naamloze pagina', { melding: 'de nieuwe subpagina ging niet open' });
    const status = page.locator('.page-editor .page-editor-status');
    await wachtTot(async () => tekst(await status.innerText().catch(() => '')) === 'Opgeslagen', { melding: 'de subpagina kwam niet in bewerken' });
    await page.locator('.page-editor-title').fill(`Vers ${tag}`);
    await page.locator('.page-editor .tiptap').click();
    await page.keyboard.type(`Verse tekst ${tag}`);
    await page.locator('.page-editor-share').click();
    const venster = page.locator('.modal.share-modal-page');
    await venster.waitFor({ timeout: 15000 });
    gelijk(tekst(await venster.locator('.modal-head h3').innerText()), 'Pagina delen', 'de titel van het venster');
    verwacht(tekst(await venster.innerText()).includes('klantdossier'), `het venster weet niet dat dit een klantpagina is: ${tekst(await venster.innerText()).slice(0, 300)}`);
    gelijk(await venster.getByText('Deellink per e-mail').count(), 0, 'een deellink bij een klantpagina');
    await venster.locator('.share-people li').filter({ hasText: w.klantA.email }).locator('input[type="checkbox"]').check();
    await venster.getByRole('button', { name: /Deel met 1 persoon/ }).click();
    await venster.locator('.share-results').waitFor({ timeout: 30000 });
    verwacht(!tekst(await venster.innerText()).includes('Niet gelukt'), `delen mislukte: ${tekst(await venster.locator('.share-results').innerText())}`);
    const vers = sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(`Vers ${tag}`)}`);
    verwacht(vers, 'de titel is niet opgeslagen');
    verwacht((await lezenInPortaal(vers.id)).includes(`Verse tekst ${tag}`), 'het portaal toont de verse tekst niet');
  });

  await uiStap('na een wijziging: "De klant ziet een oudere versie", en "Bijwerken bij klant" geeft de klant de nieuwe tekst', async () => {
    // Iemand anders wijzigde de pagina intussen: bij openen staat de melding er meteen.
    sql(`update public.documents set body = jsonb_set(body, '{content,2}', ${q(JSON.stringify({ type: 'paragraph', content: [woord(`Elders gewijzigd ${tag}`)] }))}::jsonb) where id = ${q(ouder)}`);
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await openPagina(lid, `Delen ouder ${tag}`);
    const melding = page.locator('.page-share-banner');
    await wachtTot(async () => tekst(await melding.innerText().catch(() => '')).includes('De klant ziet een oudere versie'), { melding: 'geen melding dat de klant een oudere versie ziet' });
    verwacht(!(await lezenInPortaal(ouder)).includes(`Elders gewijzigd ${tag}`), 'de klant ziet de wijziging al vóór het bijwerken');
    await beideThemas(lid, 'paginadelen-oudere-versie');
    // En wat je zelf typt, gaat mee met het bijwerken.
    await page.locator('.page-editor .tiptap p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(` en hier getypt ${tag}`);
    await melding.getByRole('button', { name: 'Bijwerken bij klant' }).click();
    await wachtTot(async () => tekst(await melding.innerText().catch(() => '')).includes('Bijgewerkt'), { melding: 'geen bevestiging na bijwerken' });
    const html = await lezenInPortaal(ouder);
    verwacht(html.includes(`Elders gewijzigd ${tag}`) && html.includes(`en hier getypt ${tag}`), `het portaal na bijwerken: ${html.slice(0, 300)}`);
    gelijk(sqlRij(`select count(*)::int as n from public.audit_logs where entity_type = 'drive_share' and action = 'updated'
      and metadata->'changes' ? 'document_version_id' and entity_id in (select id from public.drive_shares where item_id = ${q(ouder)})`).n >= 1, true, 'het bijwerken staat in het logboek');
    await wachtTot(async () => (await melding.count()) === 0, { timeout: 10000, melding: 'de melding blijft staan na bijwerken' });
  });

  await uiStap('Gerrie deelt een pagina: een voorstel via een gekoppelde AI, en na "Uitvoeren" ziet de klant de versie van dat moment', async () => {
    const titel = `Gerrie deelt ${tag}`;
    const pagina = nieuwePagina(titel, { type: 'doc', content: [{ type: 'paragraph', content: [woord(`Versie van het akkoord ${tag}`)] }] });
    // Een echte MCP-koppeling van de beheerder, zoals mcp-oauth hem uitgeeft (zie paginadrive).
    const clientId = `stromen-${randomUUID()}`;
    sql(`insert into public.mcp_clients (client_id, client_name, redirect_uris) values (${q(clientId)}, 'Stromen-AI', array['https://stromen.test/cb'])`);
    const grantId = sql(`insert into public.mcp_grants (organization_id, user_id, client_id, scope, label)
                         values (${q(w.orgId)}, ${q(w.beheerder.id)}, ${q(clientId)}, 'read propose', 'stromen') returning id`);
    const selector = randomBytes(16).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    sql(`insert into public.mcp_tokens (grant_id, kind, selector, verifier_hash, salt, expires_at)
         values (${q(grantId)}, 'access', ${q(selector)}, ${q(createHash('sha256').update(`${salt}:${verifier}`).digest('hex'))}, ${q(salt)}, now() + interval '1 hour')`);
    const res = await roep('mcp', { token: `rsfmcp.${selector}.${verifier}`, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'propose_action', arguments: { action_id: 'drive.share', input: { item_type: 'document', item_id: pagina, client_portal: true, can_download: true } },
    } } });
    verwacht(res.json?.result?.isError !== true, `delen klaarzetten: ${res.json?.result?.content?.[0]?.text ?? res.tekst}`);
    gelijk(sqlRij(`select count(*)::int as n from public.drive_shares where item_id = ${q(pagina)}`).n, 0, 'er is al gedeeld vóór het akkoord');
    const beheer = await openWerkruimte(w.beheerder, 'beheerder', w.orgId, { tijdelijk: true });
    const page = beheer.page;
    await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Dashboard/ }).first().click();
    const rij = page.locator('.ag-queue-row').filter({ hasText: titel }).first();
    await rij.waitFor({ timeout: 20000 });
    verwacht(/Pagina/.test(tekst(await rij.innerText())), `de regel in de wachtrij noemt het geen pagina: ${tekst(await rij.innerText())}`);
    // Na het voorstel, vóór het akkoord, verandert de pagina nog: de klant ziet wat er bij het akkoord staat.
    sql(`update public.documents set body = ${q(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [woord(`Na het voorstel gewijzigd ${tag}`)] }] }))}::jsonb where id = ${q(pagina)}`);
    await rij.locator('.ag-btn-go').click();
    await wachtTot(async () => sqlRij(`select count(*)::int as n from public.drive_shares where item_id = ${q(pagina)} and document_version_id is not null`).n === 1, { melding: 'na het akkoord is de pagina niet gedeeld met een vrijgave' });
    const deling = sqlRij(`select s.can_download, v.reason, v.created_by from public.drive_shares s join public.document_versions v on v.id = s.document_version_id where s.item_id = ${q(pagina)}`);
    gelijk([deling.can_download, deling.reason, deling.created_by], [false, 'vrijgave', w.beheerder.id], 'een vrijgave van wie goedkeurde, en niets te downloaden');
    const html = await lezenInPortaal(pagina);
    verwacht(html.includes(`Na het voorstel gewijzigd ${tag}`) && !html.includes('Versie van het akkoord'), `het portaal: ${html.slice(0, 300)}`);
  }, { toegestaan: [{ soort: 'functie', functie: 'mcp' }] });

  await uiStap('de geheime link in de browser: de pagina met opmaak, kader, tabel, taken, uitklapper, link en afbeelding; ook een afgevinkte taak in een notitie', async () => {
    // Een pagina in het eigen dossier: die mag via een geheime link.
    const titel = `Leesproef ${tag}`;
    sql(`insert into public.documents (organization_id, created_by, title, format, body)
      values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', '{"type":"doc","content":[{"type":"paragraph"}]}'::jsonb)`);
    const pagina = sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).id;
    const foto = sql(`insert into public.attachments (organization_id, entity_type, entity_id, name, mime_type, size_bytes, storage_key)
      values (${q(w.orgId)}, 'document', ${q(pagina)}, 'plattegrond.png', 'image/png', 10, ${q(`${w.orgId}/document/${pagina}/${randomUUID()}-plattegrond.png`)}) returning id`);
    const cel = (type, text, attrs = {}) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs }, content: [{ type: 'paragraph', content: [woord(text)] }] });
    const taak = (checked, text) => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [woord(text)] }] });
    sql(`update public.documents set body = ${q(JSON.stringify({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [woord('Afspraken')] },
      { type: 'callout', attrs: { variant: 'tip' }, content: [{ type: 'paragraph', content: [woord('Bel ons gerust.')] }] },
      { type: 'table', content: [
        { type: 'tableRow', content: [cel('tableHeader', 'Brede kop', { colspan: 2 })] },
        { type: 'tableRow', content: [cel('tableCell', 'Links'), cel('tableCell', 'Midden', { align: 'center' })] },
      ] },
      { type: 'taskList', content: [taak(true, 'Klaar'), taak(false, 'Nog te doen')] },
      { type: 'details', content: [{ type: 'detailsSummary', content: [woord('Meer lezen')] }, { type: 'detailsContent', content: [{ type: 'paragraph', content: [woord('Verborgen tekst')] }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'onze site', marks: [{ type: 'link', attrs: { href: 'https://voorbeeld.nl' } }] }] },
      { type: 'image', attrs: { attachmentId: foto, alt: 'Plattegrond' } },
    ] }))}::jsonb where id = ${q(pagina)}`);
    const versie = gelukt(await rest('rpc/save_page_version', { method: 'POST', token: w.medewerker.token, body: { p_document_id: pagina, p_reason: 'vrijgave' } }), 'vrijgeven');
    const adres = `lezer.${tag}@elders.test`;
    gelukt(await roep('file-share', { token: w.medewerker.token, body: {
      action: 'share', organizationId: w.orgId, itemType: 'document', itemId: pagina, recipients: [{ kind: 'link', email: adres }], documentVersionId: versie.id,
    } }), 'pagina delen');
    // Een notitie met een afgevinkte taak, zoals de editor van notities hem opslaat.
    const notitie = sql(`insert into public.notes (organization_id, created_by, title, content)
      values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(`Takennotitie ${tag}`)}, ${q('<ul class="rf-task-list"><li data-checked="true" aria-checked="true"><span class="rf-task-checkbox" contenteditable="false" role="checkbox" aria-checked="true" tabindex="0"></span><span class="rf-task-content">Notitie klaar</span></li><li data-checked="false" aria-checked="false"><span class="rf-task-checkbox" contenteditable="false" role="checkbox" aria-checked="false" tabindex="0"></span><span class="rf-task-content">Notitie open</span></li></ul>')}) returning id`);
    const notitieAdres = `notitie.${tag}@elders.test`;
    gelukt(await roep('file-share', { token: w.medewerker.token, body: {
      action: 'share', organizationId: w.orgId, itemType: 'note', itemId: notitie, recipients: [{ kind: 'link', email: notitieAdres }],
    } }), 'notitie delen');

    const lezer = await openAlsKlant(linkUit(mailsAan(adres).at(-1), 'gedeeld'), 'lezer');
    const page = lezer.page;
    // De getekende links van de nep-media-worker wijzen naar een verzonnen
    // https-adres (nepdiensten.mjs); hier levert de browser er een echte PNG.
    const gevraagd = [];
    await lezer.context.route(/^https:\/\/media\.stromen\.test\//, (route) => {
      gevraagd.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'image/png', body: pngVlak(320, 120, [220, 38, 38]) });
    });
    gelijk(await page.getByText('De afzender heeft downloaden voor deze deling uitgezet.').count(), 0, 'bij een pagina is "downloaden staat uit" geen beperking');
    await page.locator('.share-public-row').filter({ hasText: titel }).getByRole('button', { name: 'Lezen' }).click();
    const venster = page.locator('.share-read-modal .rich-text-viewer');
    await venster.locator('.rf-page').waitFor({ timeout: 15000 });
    const dom = await venster.evaluate((root) => {
      const stijl = (el, pseudo) => (el ? getComputedStyle(el, pseudo ?? null) : null);
      const kader = root.querySelector('.rf-callout.rf-callout-tip');
      const afgevinkt = root.querySelector('li.rf-task-checked > .rf-task-checkbox[role="img"][aria-label="Afgevinkt"]');
      const open = root.querySelector('li:not(.rf-task-checked) > .rf-task-checkbox[aria-label="Niet afgevinkt"]');
      const link = root.querySelector('a[href="https://voorbeeld.nl"]');
      const img = root.querySelector('img');
      return {
        kop: root.querySelector('h2')?.textContent ?? null,
        kader: kader ? stijl(kader).backgroundColor : null,
        brede: root.querySelector('table.rf-table th[colspan="2"]')?.textContent ?? null,
        midden: root.querySelector('td.rf-align-center') ? stijl(root.querySelector('td.rf-align-center')).textAlign : null,
        vinkje: afgevinkt ? stijl(afgevinkt, '::before').content : null,
        open: open ? stijl(open, '::before').content : null,
        doorgestreept: root.querySelector('li.rf-task-checked > .rf-task-content') ? stijl(root.querySelector('li.rf-task-checked > .rf-task-content')).textDecorationLine : null,
        uitklapper: root.querySelector('details.rf-details > summary')?.textContent ?? null,
        dicht: root.querySelector('details.rf-details')?.open ?? null,
        link: link ? [link.getAttribute('target'), link.getAttribute('rel')] : null,
        img: img ? [img.getAttribute('src'), img.getAttribute('alt')] : null,
        verboden: [...root.querySelectorAll('[style],[id]')].length + [...root.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => a.name.startsWith('data-'))).length,
      };
    });
    gelijk(dom.kop, 'Afspraken', 'de kop');
    verwacht(dom.kader && dom.kader !== 'rgba(0, 0, 0, 0)', `het kader heeft geen kleur: ${dom.kader}`);
    gelijk(dom.brede, 'Brede kop', 'een kopcel over twee kolommen');
    gelijk(dom.midden, 'center', 'uitlijnen in een cel');
    gelijk([dom.vinkje, dom.open], ['"✓"', '""'], 'een afgevinkte taak toont een vinkje, een open taak niet');
    gelijk(dom.doorgestreept, 'line-through', 'een afgevinkte taak is doorgestreept');
    gelijk([dom.uitklapper, dom.dicht], ['Meer lezen', false], 'de uitklapper, dicht');
    gelijk(dom.link, ['_blank', 'noopener noreferrer nofollow'], 'een link opent in een nieuw tabblad');
    verwacht(dom.img && dom.img[0].startsWith('https://media.stromen.test/signed/') && dom.img[0].includes('inline=1') && dom.img[1] === 'Plattegrond', `de afbeelding: ${JSON.stringify(dom.img)}`);
    gelijk(dom.verboden, 0, 'geen style, id of data-* na de sanitizer');
    await wachtTot(async () => venster.locator('img').evaluate((img) => img.complete && img.naturalWidth === 320).catch(() => false), { melding: 'de afbeelding laadt niet' });
    verwacht(gevraagd.length >= 1 && gevraagd.every((url) => url.includes('inline=1')), `de afbeelding is niet inline gevraagd: ${JSON.stringify(gevraagd)}`);
    // De openbare pagina volgt het thema van de huisstijl (brand_client_theme),
    // niet dat van de app: donker is de standaard, dan licht.
    await schermafdruk('paginadelen-geheime-link-donker', lezer);
    sql(`update public.company_settings set brand_client_theme = 'light' where organization_id = ${q(w.orgId)}`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.share-public-row').filter({ hasText: titel }).getByRole('button', { name: 'Lezen' }).click();
      await venster.locator('.rf-page').waitFor({ timeout: 15000 });
      await schermafdruk('paginadelen-geheime-link-licht', lezer);
    } finally {
      sql(`update public.company_settings set brand_client_theme = 'dark' where organization_id = ${q(w.orgId)}`);
    }
    // Op de telefoon: de tabel schuift in haar eigen vak, de pagina niet opzij.
    await page.setViewportSize({ width: 390, height: 844 });
    await rustig(lezer);
    const smal = await page.evaluate(() => ({ pagina: document.documentElement.scrollWidth, scherm: window.innerWidth }));
    verwacht(smal.pagina <= smal.scherm, `het leesvenster loopt over op 390px: ${JSON.stringify(smal)}`);
    await schermafdruk('paginadelen-geheime-link-telefoon', lezer);
    await page.locator('.share-read-modal .modal-close').click();

    // De notitie: de afgevinkte taak was na de sanitizer open (data-checked weg).
    const notitieLezer = await openAlsKlant(linkUit(mailsAan(notitieAdres).at(-1), 'gedeeld'), 'notitielezer');
    await notitieLezer.page.locator('.share-public-row').filter({ hasText: `Takennotitie ${tag}` }).getByRole('button', { name: 'Lezen' }).click();
    const notitieVenster = notitieLezer.page.locator('.share-read-modal .rich-text-viewer');
    await notitieVenster.locator('.rf-task-list').waitFor({ timeout: 15000 });
    const vinkjes = await notitieVenster.evaluate((root) => [...root.querySelectorAll('.rf-task-list > li > .rf-task-checkbox')].map((el) => getComputedStyle(el, '::before').content));
    gelijk(vinkjes, ['"✓"', '""'], 'in een gedeelde notitie toont een afgevinkte taak een vinkje');
  });

  await uiStap('de drive: "Delen…" bij een pagina opent het venster voor een pagina, met wie de klant ziet', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await naarKlantdossier(lid, w.klantA.name);
    const rij = inhoud(page).locator('.odrv-row').filter({ hasText: `Delen ouder ${tag}` }).first();
    await rij.waitFor({ timeout: 15000 });
    await rij.locator('.odrv-td-act button').first().click();
    gelijk(await page.locator('.drive-pop').getByRole('menuitem', { name: 'Versturen…' }).count(), 0, 'een pagina versturen kan nog niet');
    await page.locator('.drive-pop').getByRole('menuitem', { name: 'Delen…' }).click();
    const venster = page.locator('.modal.share-modal-page');
    await venster.waitFor({ timeout: 15000 });
    await venster.locator('.share-subpages').waitFor({ timeout: 5000 });
    await wachtTot(async () => tekst(await venster.locator('.share-current').innerText().catch(() => '')).includes('Ziet versie'), { melding: 'de versie per ontvanger staat er niet' });
    gelijk(await venster.locator('.share-outdated').count(), 0, 'na bijwerken geen melding van een oudere versie');
    await venster.locator('.modal-close').click();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
  });
}

// ── Pagina's exporteren (stap 1B-3) ─────────────────────────────────────────

/**
 * Het exportvenster in de pagina-editor: Word downloaden, afdrukken, en "Maak
 * er een Word-document van". De worker en Collabora draaien hier niet: de
 * upload en de sessie zijn nagebootst (page.route), de documents-rij is echt.
 * Of Collabora dit bestand goed bewerkt en terugschrijft, toetst dit dus niet.
 */
async function scenarioPaginaexport() {
  groep('UI: pagina\'s exporteren');
  const { w } = t;
  const tag = Date.now().toString(36);
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const woord = (text) => ({ type: 'text', text });
  sql(`insert into public.content_folders (organization_id, client_id, name) values (${q(w.orgId)}, ${q(w.klantA.id)}, ${q(`Exportmap ${tag}`)})`);
  const map = sqlRij(`select id from public.content_folders where organization_id = ${q(w.orgId)} and name = ${q(`Exportmap ${tag}`)}`).id;
  const nieuwePagina = (titel, body, { ouder = null, folder = null } = {}) => {
    sql(`insert into public.documents (organization_id, created_by, title, format, body, client_id, folder_id, parent_id)
      values (${q(w.orgId)}, ${q(w.medewerker.id)}, ${q(titel)}, 'page', ${q(JSON.stringify(body))}::jsonb, ${q(w.klantA.id)}, ${folder ? q(folder) : 'null'}, ${ouder ? q(ouder) : 'null'})`);
    return sqlRij(`select id from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).id;
  };
  const ouder = nieuwePagina(`Export ouder ${tag}`, { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [woord('Afspraken')] },
    { type: 'paragraph' },
  ] }, { folder: map });
  const kind = nieuwePagina(`Export kind ${tag}`, { type: 'doc', content: [
    { type: 'paragraph', content: [woord(`Tekst van het hoofdstuk ${tag}`)] },
    { type: 'paragraph' },
  ] }, { ouder });
  verwacht(sqlRij(`select folder_id from public.documents where id = ${q(kind)}`).folder_id === null, 'een subpagina heeft zelf geen map');
  const kleinkind = nieuwePagina(`Export kleinkind ${tag}`, { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [woord('Kop in het kleinkind')] },
    { type: 'paragraph', content: [woord(`Tekst van het kleinkind ${tag}`)] },
  ] }, { ouder: kind });

  const sluitPagina = async (page) => {
    await page.locator('.page-editor-bar .page-editor-close').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 15000 });
  };
  // Via het adres: de bovenste pagina staat in een map, de subpagina onder haar.
  const openPagina = async (lid, id, { schrijven = true } = {}) => {
    const adres = new URL(lid.page.url());
    adres.searchParams.set('pagina', id);
    await lid.page.goto(adres.toString());
    await lid.page.locator('.page-editor').waitFor({ timeout: 30000 });
    const status = lid.page.locator('.page-editor .page-editor-status');
    const verwachtStatus = schrijven ? 'Opgeslagen' : 'Alleen lezen';
    await wachtTot(async () => tekst(await status.innerText().catch(() => '')) === verwachtStatus, { melding: `de editor staat niet op "${verwachtStatus}"` });
  };
  const beideThemas = async (lid, naam) => {
    const voor = await lid.page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    try {
      for (const thema of ['light', 'dark']) {
        await lid.page.evaluate((waarde) => document.documentElement.setAttribute('data-theme', waarde), thema);
        await schermafdruk(`${naam}-${thema}`, lid);
      }
    } finally {
      await lid.page.evaluate((waarde) => {
        if (waarde) document.documentElement.setAttribute('data-theme', waarde); else document.documentElement.removeAttribute('data-theme');
      }, voor);
    }
  };
  const docxDelen = (bytes) => new Map(leesZip(bytes).map(deel => [deel.name, deel.data]));

  await uiStap('Exporteren: een venster vóór de editor; terug en Escape sluiten het venster en niet de pagina; Word downloaden met wat je net typte; afdrukken', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await openPagina(lid, ouder);
    await page.locator('.page-editor .tiptap p').last().click();
    await page.keyboard.type(`Net getypt ${tag}`);
    const venster = page.locator('.page-export');
    const openVenster = async () => {
      await page.locator('.page-editor-export').click();
      await venster.waitFor({ timeout: 10000 });
    };
    await openVenster();
    const vooraan = await page.evaluate(() => {
      const el = document.querySelector('.page-export');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const punt = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
      return Boolean(punt && el.contains(punt));
    });
    verwacht(vooraan, 'het exportvenster ligt achter de editor');
    gelijk(await venster.locator('.page-export-option').count(), 5, 'Word downloaden, een Word-document maken, PDF downloaden, vastleggen en afdrukken');
    await beideThemas(lid, 'paginaexport-venster');
    await page.goBack();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    verwacht(await page.locator('.page-editor').isVisible(), 'terug sloot de pagina in plaats van het venster');
    await openVenster();
    await page.keyboard.press('Escape');
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    verwacht(await page.locator('.page-editor').isVisible(), 'Escape sloot de pagina in plaats van het venster');
    // Word downloaden slaat eerst op wat je net typte.
    const download = await exporteerWord(page);
    gelijk(download.suggestedFilename(), `Export-ouder-${tag}.docx`, 'de naam van het bestand');
    const delen = docxDelen(readFileSync(await download.path()));
    const xml = delen.get('word/document.xml')?.toString('utf8') ?? '';
    verwacht(xml.includes(`Net getypt ${tag}`), 'wat je net typte, staat niet in het Word-bestand');
    // Kop en voet in de huisstijl (stap 1B-4c): een lijn in de merkkleur, en de voettekst of de bedrijfsnaam.
    const stijl = sqlRij(`select brand_accent_color, brand_footer_text, company_name from public.company_settings where organization_id = ${q(w.orgId)}`);
    const kleur = String(stijl.brand_accent_color ?? '').replace('#', '').toUpperCase();
    verwacht(/^[0-9A-F]{6}$/.test(kleur) && (delen.get('word/header1.xml')?.toString('utf8') ?? '').includes(`w:color="${kleur}"`), `geen lijn in de merkkleur ${kleur} in de kop`);
    const voettekst = (stijl.brand_footer_text ?? '').trim() || (stijl.company_name ?? '').trim();
    verwacht(voettekst && (delen.get('word/footer1.xml')?.toString('utf8') ?? '').includes(voettekst), `de voet noemt "${voettekst}" niet`);
    // Afdrukken: het venster gaat dicht, en de browser drukt af (alleen CSS, zie CHANGELOG_PAGINAS_AFDRUKKEN).
    await page.evaluate(() => { window.__afgedrukt = 0; window.print = () => { window.__afgedrukt += 1; }; });
    await openVenster();
    await venster.locator('.page-export-afdrukken').click();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    await wachtTot(async () => (await page.evaluate(() => window.__afgedrukt)) === 1, { melding: 'er is niet afgedrukt' });
    // Op de telefoon: de balk past, en het venster komt van onderen, helemaal in beeld.
    const breed = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await wachtTot(async () => page.locator('.page-editor-export').isVisible(), { melding: 'de knop Exporteren staat niet in beeld op de telefoon' });
      const balk = await page.evaluate(() => {
        const el = document.querySelector('.page-editor-bar');
        return { pagina: document.documentElement.scrollWidth, scherm: window.innerWidth, balk: el ? el.scrollWidth - el.clientWidth : -1 };
      });
      verwacht(balk.pagina <= balk.scherm && balk.balk <= 0, `de balk loopt over op 390px: ${JSON.stringify(balk)}`);
      await openVenster();
      const vak = await venster.boundingBox();
      verwacht(vak && vak.x >= 0 && vak.x + vak.width <= 391 && vak.y >= 0 && vak.y + vak.height <= 845, `het venster past niet op de telefoon: ${JSON.stringify(vak)}`);
      await beideThemas(lid, 'paginaexport-telefoon');
      await venster.locator('.page-editor-close').click();
      await venster.waitFor({ state: 'detached', timeout: 5000 });
    } finally {
      if (breed) await page.setViewportSize(breed);
    }
    await sluitPagina(page);
  });

  await uiStap('Word met voorblad, inhoudsopgave vooraan en de subpagina\'s als hoofdstukken; de keuzes blijven bewaard', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    await openPagina(lid, ouder);
    const venster = page.locator('.page-export');
    await page.locator('.page-editor-export').click();
    await venster.waitFor({ timeout: 10000 });
    // Twee subpagina's onder de pagina: het kind en het kleinkind.
    const hoofdstukken = venster.locator('.page-export-check').filter({ hasText: "Subpagina's als hoofdstukken (2)" });
    await hoofdstukken.waitFor({ timeout: 10000 });
    for (const optie of [venster.locator('.page-export-check').filter({ hasText: 'Voorblad' }), venster.locator('.page-export-check').filter({ hasText: 'Inhoudsopgave vooraan' }), hoofdstukken]) {
      await optie.locator('input').check();
    }
    await beideThemas(lid, 'paginaexport-opties');
    // Dicht en weer open: de keuzes staan er nog.
    await page.keyboard.press('Escape');
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    const download = await exporteerWord(page);
    const delen = docxDelen(readFileSync(await download.path()));
    const xml = delen.get('word/document.xml')?.toString('utf8') ?? '';
    // Het voorblad: de eerste bladzijde zonder voet (titlePg), dan een paginagrens.
    const [voorblad, rest] = xml.split('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    verwacht(rest && xml.includes('<w:titlePg/></w:sectPr>'), 'geen voorblad op een eigen eerste bladzijde');
    for (const zin of [`Export ouder ${tag}`, `Klant: ${w.klantA.name}`, new Date().getFullYear().toString()]) {
      verwacht(voorblad.includes(zin), `"${zin}" staat niet op het voorblad`);
    }
    gelijk(xml.match(/<w:pStyle w:val="Title"\/>/g)?.length, 1, 'de titel staat één keer');
    gelijk(xml.match(/fldCharType="begin"/g)?.length, 1, 'één inhoudsopgave');
    const inhoudsopgave = rest.slice(rest.indexOf('TOCHeading'), rest.indexOf('fldCharType="end"'));
    for (const regel of ['Afspraken', `Export kind ${tag}`, `Export kleinkind ${tag}`]) verwacht(inhoudsopgave.includes(regel), `"${regel}" staat niet in de inhoudsopgave`);
    // Het kind begint op een nieuwe bladzijde als hoofdstuk; het kleinkind loopt door, een niveau lager.
    verwacht(rest.includes(`<w:pStyle w:val="Heading1"/><w:pageBreakBefore/></w:pPr><w:r><w:t xml:space="preserve">Export kind ${tag}</w:t>`), 'het kind is geen hoofdstuk');
    verwacht(rest.includes(`<w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Export kleinkind ${tag}</w:t>`), 'het kleinkind staat niet onder het kind');
    verwacht(rest.includes('<w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t xml:space="preserve">Kop in het kleinkind</w:t>'), 'de kop in het kleinkind schoof niet op');
    const volgorde = ['Afspraken', `Tekst van het hoofdstuk ${tag}`, `Tekst van het kleinkind ${tag}`].map(zin => rest.lastIndexOf(zin));
    gelijk([...volgorde].sort((a, b) => a - b), volgorde, 'de volgorde: de pagina, het kind, het kleinkind');
    // Elke stijl die het bestand gebruikt, bestaat.
    const stijlen = new Set([...(delen.get('word/styles.xml')?.toString('utf8') ?? '').matchAll(/w:styleId="([^"]+)"/g)].map(m => m[1]));
    for (const [, stijl] of xml.matchAll(/<w:pStyle w:val="([^"]+)"\/>/g)) verwacht(stijlen.has(stijl), `de stijl ${stijl} ontbreekt`);
    // De keuzes zijn bewaard: weer open, alles nog aan.
    await page.locator('.page-editor-export').click();
    await venster.waitFor({ timeout: 10000 });
    await hoofdstukken.waitFor({ timeout: 10000 });
    gelijk(await venster.locator('.page-export-check input:checked').count(), 3, 'de keuzes zijn niet bewaard');
    await venster.locator('.page-editor-close').click();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    await sluitPagina(page);
  });

  await uiStap('Maak er een Word-document van: een Word-document in de map van de bovenste pagina, met wat je net typte; de pagina gaat netjes dicht en Word opent', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    const geupload = [];
    const sessies = [];
    await page.route(/\/__media\/office\/document-upload$/, async (route) => {
      const verzoek = route.request();
      const kop = verzoek.headers();
      const naam = decodeURIComponent(kop['x-file-name'] ?? '');
      const bytes = verzoek.postDataBuffer() ?? Buffer.alloc(0);
      const key = `${w.orgId}/document/${randomUUID()}-${naam}`;
      geupload.push({ naam, org: kop['x-organization-id'], soort: kop['x-file-type'], bytes, key });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, key, size_bytes: bytes.length, mime_type: DOCX, name: naam }) });
    });
    await page.route(/\/__media\/office\/session$/, async (route) => {
      sessies.push(JSON.parse(route.request().postData() ?? '{}').documentId);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        editorUrl: `${APP}/__nep-collabora`, accessToken: 'nep', accessTokenTtl: 3600000, accessTokenExp: Date.now() + 3600000,
        fileName: `Export kind ${tag} (Word).docx`, canWrite: true,
      }) });
    });
    await page.route(/\/__nep-collabora$/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Nep-Collabora</title><p>Nep-Collabora</p>' }));
    await openPagina(lid, kind);
    await page.locator('.page-editor .tiptap p').last().click();
    await page.keyboard.type(`Laatste zin ${tag}`);
    await page.locator('.page-editor-export').click();
    await page.locator('.page-export-kopie').click();
    await page.locator('.page-editor').waitFor({ state: 'detached', timeout: 30000 });
    const word = page.getByRole('dialog', { name: `Export kind ${tag} (Word).docx` });
    await word.waitFor({ timeout: 15000 });
    const kopie = sqlRij(`select id, format, folder_id, client_id, parent_id, storage_key, mime_type, size_bytes, content, created_by
      from public.documents where organization_id = ${q(w.orgId)} and title = ${q(`Export kind ${tag} (Word)`)}`);
    verwacht(kopie, 'er is geen Word-document gemaakt');
    gelijk(geupload.length, 1, 'één upload');
    gelijk([kopie.format, kopie.folder_id, kopie.client_id, kopie.parent_id, kopie.storage_key, kopie.mime_type, Number(kopie.size_bytes), kopie.content, kopie.created_by],
      ['office', map, w.klantA.id, null, geupload[0].key, DOCX, geupload[0].bytes.length, '', w.medewerker.id], 'het Word-document: in de map van de bovenste pagina, bij de klant');
    gelijk([geupload[0].naam, geupload[0].org, geupload[0].soort], [`Export-kind-${tag}-Word.docx`, w.orgId, DOCX], 'wat de worker kreeg');
    gelijk(sessies, [kopie.id], 'Word opent de kopie');
    const xml = docxDelen(geupload[0].bytes).get('word/document.xml')?.toString('utf8') ?? '';
    for (const zin of [`Export kind ${tag}`, `Tekst van het hoofdstuk ${tag}`, `Laatste zin ${tag}`]) verwacht(xml.includes(zin), `"${zin}" staat niet in het Word-document`);
    // De pagina zelf: opgeslagen, en weer vrij voor anderen.
    verwacht(sqlRij(`select content from public.documents where id = ${q(kind)}`).content.includes(`Laatste zin ${tag}`), 'de pagina is niet opgeslagen');
    gelijk(sqlRij(`select count(*)::int as n from public.document_edit_claims where document_id = ${q(kind)}`).n, 0, 'de pagina is nog geclaimd');
    await schermafdruk('paginaexport-word-open', lid);
    // Word dicht: het document staat in de map, naast de pagina.
    await word.getByRole('button', { name: 'Editor sluiten' }).click();
    await word.waitFor({ state: 'detached', timeout: 10000 });
    await naarKlantdossier(lid, w.klantA.name);
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Exportmap ${tag}` }).first().click();
    await inhoud(page).locator('.odrv-row').filter({ hasText: `Export kind ${tag} (Word)` }).first().waitFor({ timeout: 15000 });
  });

  await uiStap('lukt het Word-document niet, dan zegt het venster het: de pagina blijft open, er komt geen document, en een al opgeslagen bestand gaat weer weg', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    let uploadFout = true;
    const geupload = [];
    const gewist = [];
    await page.route(/\/__media\/office\/document-upload$/, async (route) => {
      if (uploadFout) {
        await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: 'De opslag van je organisatie is vol.' }) });
        return;
      }
      const naam = decodeURIComponent(route.request().headers()['x-file-name'] ?? '');
      const key = `${w.orgId}/document/${randomUUID()}-${naam}`;
      geupload.push(key);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, key, size_bytes: 10, mime_type: DOCX, name: naam }) });
    });
    await page.route(/\/__media\/file\/.+$/, async (route) => {
      if (route.request().method() !== 'DELETE') return route.fallback();
      gewist.push(decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/__media\/file\//, '')));
      await route.fulfill({ status: 200, body: '' });
    });
    const titel = `Export ouder ${tag} (Word)`;
    const aantal = () => sqlRij(`select count(*)::int as n from public.documents where organization_id = ${q(w.orgId)} and title = ${q(titel)}`).n;
    await openPagina(lid, ouder);
    const venster = page.locator('.page-export');
    const fout = venster.locator('.page-export-error');
    await page.locator('.page-editor-export').click();
    await venster.locator('.page-export-kopie').click();
    await wachtTot(async () => tekst(await fout.innerText().catch(() => '')) === 'De opslag van je organisatie is vol.', { melding: 'het venster zegt niet wat er misging' });
    verwacht(await page.locator('.page-editor').isVisible(), 'de pagina ging toch dicht');
    gelijk(aantal(), 0, 'er kwam toch een document');
    // Het bestand staat in R2, maar de rij komt er niet (een trigger die
    // weigert): dan gaat het bestand weer weg, anders bleef het als wees staan.
    uploadFout = false;
    sql(`create or replace function public.stromen_weiger_wordkopie() returns trigger language plpgsql as $$ begin raise exception 'Proef: geen Word-kopie'; end $$`);
    sql(`create trigger stromen_weiger_wordkopie before insert on public.documents for each row when (new.title = ${q(titel)}) execute function public.stromen_weiger_wordkopie()`);
    try {
      await venster.locator('.page-export-kopie').click();
      await wachtTot(async () => tekst(await fout.innerText().catch(() => '')).includes('Proef: geen Word-kopie'), { melding: 'de geweigerde rij staat niet in het venster' });
      await wachtTot(async () => gewist.length === 1, { melding: 'het bestand is niet opgeruimd' });
      gelijk(gewist, geupload, 'het opgeruimde bestand is het geüploade');
    } finally {
      sql('drop trigger if exists stromen_weiger_wordkopie on public.documents');
      sql('drop function if exists public.stromen_weiger_wordkopie()');
    }
    verwacht(await page.locator('.page-editor').isVisible(), 'de pagina ging toch dicht');
    gelijk(aantal(), 0, 'er kwam toch een document');
    await venster.locator('.page-editor-close').click();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    await sluitPagina(page);
  }, { toegestaan: [{ tabel: 'documents', methode: 'POST', antwoord: /Proef: geen Word-kopie/ }] });

  await uiStap('alleen lezen (de kijker): Word downloaden en afdrukken kan, een Word-document maken niet', async () => {
    const kijker = await openWerkruimte(w.kijker, 'kijker', w.orgId, { tijdelijk: true });
    const page = kijker.page;
    await openPagina(kijker, ouder, { schrijven: false });
    await page.locator('.page-editor-export').click();
    const venster = page.locator('.page-export');
    await venster.waitFor({ timeout: 10000 });
    gelijk(await venster.locator('.page-export-kopie').count(), 0, 'een kijker kan een Word-document maken');
    gelijk(await venster.locator('.page-export-afdrukken').count(), 1, 'afdrukken staat er niet');
    await venster.locator('.page-editor-close').click();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
    const download = await exporteerWord(page);
    const xml = docxDelen(readFileSync(await download.path())).get('word/document.xml')?.toString('utf8') ?? '';
    verwacht(xml.includes(`Net getypt ${tag}`), 'de kijker kreeg niet de opgeslagen pagina');
    await sluitPagina(page);
  });

  await uiStap('PDF (stap 1B-5): downloaden met de opties, vastleggen in de map van de pagina, en een worker zonder het pad zegt dat', async () => {
    const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
    const page = lid.page;
    // De upload van "Vastleggen" gaat naar de media-worker (/upload), zoals elk bestand in de drive.
    const geupload = [];
    await page.route(/\/__media\/upload$/, async (route) => {
      const kop = route.request().headers();
      const naam = decodeURIComponent(kop['x-file-name'] ?? 'bestand');
      const sleutel = `${kop['x-organization-id']}/${kop['x-entity-type']}/${kop['x-entity-id']}/${randomUUID()}-${naam}`;
      geupload.push({ sleutel, soort: kop['x-file-type'], bytes: route.request().postDataBuffer() ?? Buffer.alloc(0) });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, key: sleutel }) });
    });
    await openPagina(lid, kind);
    const venster = page.locator('.page-export');
    const openVenster = async () => {
      await page.locator('.page-editor-export').click();
      await venster.waitFor({ timeout: 10000 });
    };
    await openVenster();
    await venster.locator('.page-export-check').filter({ hasText: 'Voorblad' }).locator('input').check();
    // PDF downloaden: de server maakt hem uit dezelfde Word-file (page-export), met het voorblad.
    const voor = post.paginaPdf.verzoeken.length;
    const onderweg = page.waitForEvent('download', { timeout: 120000 });
    onderweg.catch(() => {});
    await venster.locator('.page-export-pdf').click();
    const download = await onderweg;
    gelijk(download.suggestedFilename(), `Export-kind-${tag}.pdf`, 'de naam van de PDF');
    gelijk(readFileSync(await download.path()).subarray(0, 5).toString(), '%PDF-', 'een PDF');
    gelijk(post.paginaPdf.verzoeken.length, voor + 1, 'één keer omgezet');
    const xml = docxDelen(Buffer.from(post.paginaPdf.verzoeken.at(-1).bytes)).get('word/document.xml')?.toString('utf8') ?? '';
    verwacht(xml.includes(`Tekst van het hoofdstuk ${tag}`) && xml.includes('<w:titlePg/>'), 'de Word-file van de PDF mist de tekst of het voorblad');
    // Vastleggen: een vast bestand in de map van de bovenste pagina.
    await openVenster();
    await wachtTot(async () => tekst(await venster.locator('.page-export-vastleggen').innerText().catch(() => '')).includes(`Exportmap ${tag}`), { melding: 'het venster noemt de map niet' });
    await venster.locator('.page-export-vastleggen').click();
    await venster.waitFor({ state: 'detached', timeout: 120000 });
    await wachtTot(async () => tekst(await page.locator('.page-editor-banner').innerText().catch(() => '')).includes(`De PDF staat in de map "Exportmap ${tag}"`), { melding: 'geen melding na vastleggen' });
    const vast = sqlRij(`select name, mime_type, entity_type, entity_id, storage_key from public.attachments where organization_id = ${q(w.orgId)} and entity_type = 'folder' and entity_id = ${q(map)} and name like ${q(`Export kind ${tag} (%).pdf`)}`);
    verwacht(vast && vast.mime_type === 'application/pdf', `de PDF staat niet in de map: ${JSON.stringify(vast)}`);
    gelijk(geupload.length, 1, 'één upload');
    gelijk([geupload[0].sleutel, geupload[0].soort, geupload[0].bytes.subarray(0, 5).toString()], [vast.storage_key, 'application/pdf', '%PDF-'], 'de PDF is wat er werd geüpload');
    // Een worker zonder het pad (nog niet bijgewerkt): het venster zegt het, en Word kan wel.
    post.paginaPdf.ontbreekt = true;
    try {
      await openVenster();
      await venster.locator('.page-export-pdf').click();
      await wachtTot(async () => /media-worker/.test(tekst(await venster.locator('.page-export-error').innerText().catch(() => ''))), { melding: 'het venster zegt niet waarom er geen PDF is' });
      await venster.locator('.page-editor-close').click();
      await venster.waitFor({ state: 'detached', timeout: 5000 });
    } finally {
      post.paginaPdf.ontbreekt = false;
    }
    await sluitPagina(page);
  }, { toegestaan: [{ functie: 'page-export', status: 501 }] });

  await uiStap('briefpapier: een afbeelding achter elke bladzijde, met de marges van Documentopmaak; een briefpapier als PDF alleen onder de PDF, en het venster zegt dat', async () => {
    const papier = pngVlak(210, 297, [250, 246, 235]);
    const zet = (soort, dataUrl, mime) => sql(`update public.company_settings set invoice_template_kind = ${q(soort)},
      invoice_template_mime_type = ${mime ? q(mime) : 'null'}, invoice_template_file_name = ${soort === 'none' ? 'null' : q('briefpapier')},
      invoice_template_file_size = ${dataUrl ? dataUrl.length : 0}, invoice_template_data_url = ${dataUrl ? q(dataUrl) : 'null'},
      invoice_template_updated_at = now() where organization_id = ${q(w.orgId)}`);
    try {
      zet('image', `data:image/png;base64,${papier.toString('base64')}`, 'image/png');
      const lid = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
      const page = lid.page;
      await openPagina(lid, ouder);
      const venster = page.locator('.page-export');
      await page.locator('.page-editor-export').click();
      await venster.waitFor({ timeout: 10000 });
      // De app laadt het briefpapier niet bij het opstarten (letterhead.ts): de export haalt het op.
      await venster.locator('.page-export-check').filter({ hasText: 'Briefpapier, achter elke bladzijde' }).locator('input').check();
      await page.keyboard.press('Escape');
      await venster.waitFor({ state: 'detached', timeout: 5000 });
      const delen = docxDelen(readFileSync(await (await exporteerWord(page)).path()));
      verwacht(/<wp:anchor [^>]*behindDoc="1"/.test(delen.get('word/header1.xml')?.toString('utf8') ?? ''), 'geen briefpapier achter de tekst');
      verwacht(delen.get('word/media/briefpapier.png')?.equals(papier), 'het briefpapier in het bestand is niet dat van de instellingen');
      const xml = delen.get('word/document.xml')?.toString('utf8') ?? '';
      verwacht(xml.includes('<w:headerReference w:type="default" r:id="rId6"/>'), 'de kop met het briefpapier staat niet in de sectie');
      // Zonder eigen opmaak: de standaard van een factuur (voet vanaf 768 pt), en boven nooit minder dan de gewone marge.
      verwacht(xml.includes('<w:pgMar w:top="1418" w:right="1418" w:bottom="1478" w:left="1418" w:header="709" w:footer="1158" w:gutter="0"/>'), `de marges: ${xml.match(/<w:pgMar [^>]*>/)?.[0]}`);
      await sluitPagina(page);
      // Een briefpapier als PDF (stap 1B-5): de optie kan aan, en het venster zegt dat het alleen onder de PDF komt.
      const pdfPapier = await PDFDocument.create();
      pdfPapier.addPage([595.28, 841.89]).drawText('BRIEFPAPIER PROEF', { x: 40, y: 800, size: 16, font: await pdfPapier.embedFont(StandardFonts.Helvetica) });
      zet('pdf', `data:application/pdf;base64,${Buffer.from(await pdfPapier.save()).toString('base64')}`, 'application/pdf');
      const ander = await openWerkruimte(w.medewerker, 'medewerker', w.orgId, { tijdelijk: true });
      // Bewaard van eerder: het briefpapier aan.
      await ander.page.evaluate(() => window.localStorage.setItem('resofly.paginaExport.opties', JSON.stringify({ letterhead: true })));
      await openPagina(ander, ouder);
      await ander.page.locator('.page-editor-export').click();
      const venster2 = ander.page.locator('.page-export');
      await venster2.waitFor({ timeout: 10000 });
      const optie = venster2.locator('.page-export-check').filter({ hasText: 'Briefpapier, onder elke bladzijde van de PDF' }).locator('input');
      verwacht(!(await optie.isDisabled()) && await optie.isChecked(), 'een briefpapier als PDF kan niet aan, of de bewaarde keuze telt niet');
      verwacht(tekst(await venster2.locator('.page-export-note').innerText()).includes('Je briefpapier is een PDF: het komt onder de PDF.'), 'het venster zegt niet waar het briefpapier komt');
      // PDF downloaden: de app vraagt het briefpapier; de worker krijgt de ruimte ervoor, zonder afbeelding of kop.
      const voor = post.paginaPdf.verzoeken.length;
      const verzoek = ander.page.waitForRequest((req) => req.url().includes('/page-export') && req.method() === 'POST', { timeout: 30000 });
      const onderweg = ander.page.waitForEvent('download', { timeout: 120000 });
      onderweg.catch(() => {});
      await venster2.locator('.page-export-pdf').click();
      verwacht((await verzoek).postDataJSON()?.letterhead === true, 'de app vraagt geen briefpapier onder de PDF');
      gelijk(readFileSync(await (await onderweg).path()).subarray(0, 5).toString(), '%PDF-', 'een PDF');
      gelijk(post.paginaPdf.verzoeken.length, voor + 1, 'één keer omgezet');
      const vanPdf = docxDelen(Buffer.from(post.paginaPdf.verzoeken.at(-1).bytes));
      verwacht(!vanPdf.has('word/header1.xml') && ![...vanPdf.keys()].some(naam => naam.startsWith('word/media/briefpapier')), 'de Word-file van de PDF heeft toch een kop of een briefpapier');
      verwacht((vanPdf.get('word/document.xml')?.toString('utf8') ?? '').includes('w:bottom="1478"'), 'de Word-file van de PDF houdt geen ruimte vrij voor het briefpapier');
      await venster2.waitFor({ state: 'detached', timeout: 10000 });
      // Word downloaden, met dezelfde keuze: zonder briefpapier, want dat past er niet in.
      const zonder = docxDelen(readFileSync(await (await exporteerWord(ander.page)).path()));
      // Geen briefpapier in het bestand; de kop in de huisstijl (stap 1B-4c) staat er wel.
      verwacht(![...zonder.keys()].some(naam => naam.startsWith('word/media/briefpapier')), 'met een PDF-briefpapier toch een briefpapier');
      verwacht(!/behindDoc="1"/.test(zonder.get('word/header1.xml')?.toString('utf8') ?? ''), 'met een PDF-briefpapier toch een afbeelding achter de tekst');
      await sluitPagina(ander.page);
    } finally {
      zet('none', null, null);
    }
  });
}

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

  // Betalingen vanzelf koppelen aan inkoopfacturen (20261118190000): wat de
  // gebruiker ziet van een automatische boeking, en de instelling per rekening.
  await uiStap('een betaling van een inkoopfactuur: meteen geboekt met het label "automatisch" en de reden; automatisch boeken uit- en aanzetten, en "Opnieuw matchen" zegt wat er gebeurde', async () => {
    const lid = t.lid;
    const page = lid.page;
    const kosten = gelukt(await rest(`ledger_accounts?select=id&organization_id=eq.${w.orgId}&code=eq.4500`, { token: w.medewerker.token }), 'rekening 4500')[0];
    const leverancier = gelukt(await rest('suppliers?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, created_by: w.medewerker.id, name: 'Drukkerij UI', iban: 'NL44RABO0123456788' },
    }), 'leverancier')[0];
    const inkoop = async (nummer, netto) => {
      const pi = gelukt(await rest('purchase_invoices?select=*', {
        method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
        body: {
          organization_id: w.orgId, created_by: w.medewerker.id, supplier_id: leverancier.id, supplier_invoice_number: nummer,
          date: datum(), due_date: datum(), subtotal_cents: netto, vat_cents: Math.round(netto * 0.21), total_cents: netto + Math.round(netto * 0.21),
          currency: 'EUR', status: 'draft',
          lines: [{ id: randomUUID(), description: 'Drukwerk', amount_cents: netto, vat_code: 'HOOG', vat_rate: 21, account_id: kosten.id }],
        },
      }), `inkoopfactuur ${nummer}`)[0];
      gelukt(await rpc('book_purchase_invoice', { p_organization_id: w.orgId, p_purchase_invoice_id: pi.id }, w.medewerker.token), `${nummer} boeken`);
      return pi;
    };
    const p1 = await inkoop('DUI-1', 10000);
    const p2 = await inkoop('DUI-2', 5000);
    gelukt(await rpc('import_bank_transactions', {
      p_organization_id: w.orgId, p_bank_account_id: b.rekening.id, p_statement: { format: 'csv', file_name: 'ui-inkoop.csv' },
      p_transactions: [{ booking_date: datum(), amount_cents: -12100, counterparty_name: 'DRUKKERIJ UI', counterparty_iban: 'NL44 RABO 0123 4567 88', description: 'Overboeking' }],
    }, w.medewerker.token), 'afschrift met de betaling');
    gelijk(sqlRij(`select payment_status from public.purchase_invoices where id = ${q(p1.id)}`).payment_status, 'paid', 'meteen afgeletterd');

    await ververs(lid);
    await bankTab(lid, 'Geboekt');
    const geboekt = bankRij(page, 'DRUKKERIJ UI').first();
    await geboekt.waitFor({ timeout: 10000 });
    const tekstGeboekt = tekst(await geboekt.innerText());
    verwacht(/automatisch/i.test(tekstGeboekt), `geen label "automatisch": ${tekstGeboekt.slice(0, 300)}`);
    verwacht(tekstGeboekt.includes('Automatisch geboekt: Rekeningnummer van Drukkerij UI en het bedrag van inkoopfactuur DUI-1.'), `geen reden bij de geboekte betaling: ${tekstGeboekt.slice(0, 400)}`);
    verwacht(tekstGeboekt.includes('Inkoopfactuur DUI-1'), 'de verdeling noemt de inkoopfactuur niet');
    await schermafdruk('bank-automatisch-geboekt', lid);

    // Uitzetten in het bewerkvenster van de rekening.
    const zet = async (aan) => {
      await inhoud(page).locator('.bk-tabs button').filter({ hasText: /Rekeningen/ }).click();
      await rustig(lid);
      const kaart = inhoud(page).locator('.bank-account-card').filter({ hasText: 'Zakelijk UI' }).first();
      await kaart.getByRole('button', { name: 'Bewerk' }).click();
      const m = modal(page, 'Bankrekening bewerken');
      await m.waitFor({ timeout: 10000 });
      const vink = m.locator('label.bank-setting-auto input[type="checkbox"]');
      gelijk(await vink.isChecked(), !aan, 'de instelling staat zoals verwacht vóór het wijzigen');
      await vink.setChecked(aan);
      const sinds = server.verkeer.length;
      await klik(m, 'Opslaan');
      await m.waitFor({ state: 'detached', timeout: 10000 });
      await rustig(lid);
      verwachtAanroep(sinds, { tabel: 'bank_accounts', methode: 'PATCH' }, 'rekening opslaan');
      gelijk(sqlRij(`select auto_book_purchase_invoices from public.bank_accounts where id = ${q(b.rekening.id)}`).auto_book_purchase_invoices, aan, 'de instelling in de database');
      await wachtTot(async () => (aan ? /zeker = meteen geboekt/ : /alleen voorstellen/).test(await kaart.innerText()), { melding: 'de kaart toont de instelling niet' });
    };
    await zet(false);

    gelukt(await rpc('import_bank_transactions', {
      p_organization_id: w.orgId, p_bank_account_id: b.rekening.id, p_statement: { format: 'csv', file_name: 'ui-inkoop-2.csv' },
      p_transactions: [{ booking_date: datum(), amount_cents: -6050, counterparty_name: 'DRUKKERIJ UI', counterparty_iban: 'NL44RABO0123456788', description: 'Tweede overboeking' }],
    }, w.medewerker.token), 'afschrift met de tweede betaling');
    await ververs(lid);
    await inhoud(page).locator('.bk-tabs button').filter({ hasText: /Af te letteren/ }).click();
    await rustig(lid);
    await bankTab(lid, 'Openstaand');
    const open = bankRij(page, 'Tweede overboeking').first();
    await open.waitFor({ timeout: 10000 });
    verwacht(/Automatisch boeken staat uit voor deze rekening/.test(await open.innerText()), 'de reden zegt niet dat automatisch boeken uit staat');
    const keuze = tekst(await open.locator('.bank-alloc-line .select-control').nth(1).locator('.select-value').innerText());
    verwacht(keuze.startsWith('DUI-2'), `de voorgestelde inkoopfactuur: ${keuze}`);

    // Weer aan, en dan "Opnieuw matchen": die boekt hem en zegt het.
    await zet(true);
    await inhoud(page).locator('.bk-tabs button').filter({ hasText: /Af te letteren/ }).click();
    await rustig(lid);
    const sinds = server.verkeer.length;
    await inhoud(page).getByRole('button', { name: 'Opnieuw matchen' }).click();
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'match_bank_transactions' }, 'opnieuw matchen');
    await wachtTot(async () => /1 betaling meteen afgeletterd tegen een inkoopfactuur/.test(await inhoud(page).locator('.bank-reconcile .bk-note').first().innerText().catch(() => '')),
      { melding: 'geen melding na opnieuw matchen' });
    gelijk(sqlRij(`select payment_status from public.purchase_invoices where id = ${q(p2.id)}`).payment_status, 'paid', 'de tweede factuur is betaald');
  });
}

// ── Inrichten: een nieuwe gebruiker richt zijn organisatie in ───────────────

/**
 * De app als iemand die net een account heeft: alleen een sessie, geen
 * organisatie in de opslag. Wacht op `wachtOp` (de stappen, of het scherm met
 * een uitnodiging), niet op de werkruimte.
 */
async function openAlsNieuw(gebruiker, naam, wachtOp) {
  const sessie = await sessieVan(gebruiker);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  const items = { [SESSIESLEUTEL]: JSON.stringify(sessie) };
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
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.locator(wachtOp).first().waitFor({ timeout: 60000 });
  await rustig(scherm);
  return scherm;
}

/**
 * Waarom in de browser: run.mjs (scenario inrichten) toetst de database: wie
 * mag afronden, en dat het niet rechtstreeks kan. tests/inrichten klikt de
 * stappen door tegen een nagebootste backend. Hier dezelfde weg tegen de
 * échte: bij de eerste login ontstaat een organisatie, de stappen schrijven
 * met RLS (de eerste maakt de bedrijfsgegevens aan, want die zijn er nog
 * niet), en na afronden opent de werkruimte, ook na herladen.
 */
async function scenarioInrichten() {
  groep('UI: een nieuwe organisatie inrichten');
  const nieuw = await stap('een nieuwe gebruiker, nog zonder organisatie', () => maakGebruiker('ui-nieuw'));
  if (!nieuw) return;
  let scherm = null;
  let orgId = null;
  const kop = async () => tekst(await scherm.page.locator('.onb-title').innerText().catch(() => ''));
  const naarStap = async (patroon) => {
    await wachtTot(async () => patroon.test(await kop()), { timeout: 15000, melding: `de stap ${patroon} kwam niet in beeld (kop: "${await kop()}")` });
    await rustig(scherm);
  };
  const volgende = async (patroon) => {
    await scherm.page.locator('.onb-next').click();
    await naarStap(patroon);
    const fouten = await scherm.page.locator('.onb-notice.is-error').allInnerTexts();
    verwacht(fouten.length === 0, `foutmelding in de stappen: ${fouten.join(' | ')}`);
  };
  const instellingen = () => sqlRij(`select * from public.company_settings where organization_id = ${q(orgId)}`);

  await uiStap('de eerste login opent de inrichting, niet de werkruimte', async () => {
    scherm = await openAlsNieuw(nieuw, 'nieuw', '.onb');
    verwacht(await scherm.page.locator('.app').count() === 0, 'de werkruimte staat al open');
    const rij = sqlRij(`select o.id, o.onboarding_completed_at from public.organization_members m join public.organizations o on o.id = m.organization_id where m.user_id = ${q(nieuw.id)} and m.role = 'owner'`);
    verwacht(rij?.id, 'geen organisatie aangemaakt bij de eerste login');
    gelijk(rij.onboarding_completed_at, null, 'onboarding_completed_at');
    orgId = rij.id;
    gelijk(instellingen(), null, 'bedrijfsgegevens (die zijn er nog niet)');
  });
  if (!scherm || !orgId) return;

  await uiStap('rechtsvorm: VOF, en de bedrijfsgegevens ontstaan', async () => {
    await volgende(/rechtsvorm/);
    verwacht(await scherm.page.locator('.onb-choice.is-on').count() === 0, 'er stond al een rechtsvorm aangevinkt');
    await scherm.page.locator('.onb-choice', { has: scherm.page.locator('strong', { hasText: /^VOF$/ }) }).click();
    await volgende(/Kies je pakket/);
    const rij = instellingen();
    gelijk([rij?.legal_form, rij?.year_result_account_code, rij?.fiscal_year_start_month], ['vof', '0510', 1], 'rechtsvorm, resultaatrekening, boekjaar');
  });

  await uiStap('abonnement: later beslissen', async () => {
    verwacht(await scherm.page.locator('.onb-choice.onb-plan').count() >= 1, 'geen pakketten in beeld');
    await volgende(/bedrijfsgegevens/);
  });

  await uiStap('bedrijfsgegevens invullen; ze worden netjes opgeslagen', async () => {
    const p = scherm.page;
    await p.fill('#onb-f-company_name', 'Jansen & De Vries V.O.F.');
    await p.fill('#onb-f-trade_name', 'Studio Jansen');
    await p.fill('#onb-f-address_line1', 'Keizersgracht 1');
    await p.fill('#onb-f-postal_code', '1015aa');
    await p.fill('#onb-f-city', 'Amsterdam');
    await p.fill('#onb-f-email', 'Info@StudioJansen.test');
    await p.fill('#onb-f-kvk_number', '1234 5678');
    await p.fill('#onb-f-vat_number', 'nl001234567b01');
    await p.fill('#onb-f-iban', 'nl91abna0417164300');
    await volgende(/webadres/);
    const rij = instellingen();
    gelijk([rij?.company_name, rij?.trade_name, rij?.postal_code, rij?.email, rij?.kvk_number, rij?.vat_number, rij?.iban],
      ['Jansen & De Vries V.O.F.', 'Studio Jansen', '1015 AA', 'info@studiojansen.test', '12345678', 'NL001234567B01', 'NL91 ABNA 0417 1643 00'], 'bedrijfsgegevens');
  });

  // Het webadres voor klanten (migratie 20261108230000): verplicht, en de
  // stap zegt terwijl je typt of de naam vrij is. Een eigen naam per run: de
  // voorgestelde naam (uit de handelsnaam) is na een eerdere run al bezet.
  // Tot 9 november ontbrak deze stap hier; toen bleef de test bij
  // "Btw en boekhouding" staan.
  const webadres = `studio-jansen-${Date.now().toString(36)}`;
  await uiStap('je webadres: een vrije naam, en die wordt het adres voor klanten', async () => {
    const p = scherm.page;
    const kaart = p.locator('.onb-address');
    await kaart.waitFor({ timeout: 15000 });
    verwacht(/studio-jansen/.test(await p.locator('#onb-f-address').inputValue()), 'geen naam voorgesteld uit de handelsnaam');
    await p.locator('#onb-f-address').fill(webadres);
    await wachtTot(async () => (await kaart.innerText()).includes(`${webadres}.resofly.com is beschikbaar`), { melding: 'de naam werd niet als vrij gemeld' });
    await volgende(/Btw en boekhouding/);
    gelijk(sqlRij(`select name, status from public.client_subdomains where organization_id = ${q(orgId)}`), { name: webadres, status: 'active' }, 'het webadres');
  });

  await uiStap('btw: de kleineondernemersregeling', async () => {
    await scherm.page.locator('.onb-choice', { has: scherm.page.locator('strong', { hasText: 'Nee, ik gebruik de KOR' }) }).click();
    await volgende(/huisstijl/);
    gelijk(instellingen()?.kor_enabled, true, 'KOR');
  });

  await uiStap('huisstijl: een merkkleur, ook op de facturen', async () => {
    await scherm.page.getByRole('radio', { name: '#1C7ED6' }).click();
    await volgende(/facturen/);
    const rij = instellingen();
    gelijk([rij?.brand_accent_color, rij?.invoice_accent_color], ['#1C7ED6', '#1C7ED6'], 'merkkleur en factuurkleur');
  });

  await uiStap('facturen: per e-mail', async () => {
    await scherm.page.locator('.onb-choice', { has: scherm.page.locator('strong', { hasText: /^Per e-mail$/ }) }).click();
    await volgende(/Mollie koppelen/);
    const rij = instellingen();
    gelijk(rij?.invoice_send_method, 'email', 'verzendwijze');
    verwacht(/binnen 14 dagen/.test(rij?.invoice_payment_terms ?? ''), `betaaltekst: ${rij?.invoice_payment_terms}`);
  });

  await uiStap('Mollie: later koppelen; het overzicht klopt', async () => {
    verwacht(await scherm.page.locator('#onb-f-mollie').count() === 1, 'de eigenaar ziet geen veld voor de key');
    await volgende(/beginnen/);
    const overzicht = tekst(await scherm.page.locator('.onb-summary').innerText());
    for (const woord of ['VOF', 'Jansen & De Vries V.O.F.', `${webadres}.resofly.com`, 'KOR', 'Per e-mail', 'Niet gekoppeld']) verwacht(overzicht.includes(woord), `"${woord}" ontbreekt in het overzicht: ${overzicht.slice(0, 300)}`);
  });

  await uiStap('afronden: de werkruimte opent, met de naam van het bedrijf', async () => {
    const sinds = server.verkeer.length;
    await scherm.page.locator('.onb-next').click();
    await scherm.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 30000 });
    verwachtAanroep(sinds, { rpc: 'complete_organization_onboarding' }, 'afronden');
    const rij = sqlRij(`select name, onboarding_completed_at, onboarding_completed_by from public.organizations where id = ${q(orgId)}`);
    verwacht(rij?.onboarding_completed_at, 'niet afgerond in de database');
    gelijk([rij?.name, rij?.onboarding_completed_by], ['Studio Jansen', nieuw.id], 'naam en wie afrondde');
    verwacht(await scherm.page.locator('.onb').count() === 0, 'de stappen staan er nog');
  });

  await uiStap('na herladen: de werkruimte, niet de stappen', async () => {
    await scherm.page.reload({ waitUntil: 'domcontentloaded' });
    await scherm.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 60000 });
    verwacht(await scherm.page.locator('.onb').count() === 0, 'de stappen kwamen terug');
  });
  await sluit(scherm);

  // Een uitgenodigd teamlid: geen eigen organisatie, dus ook geen stappen.
  const genodigde = await stap('de eigenaar van de wereld nodigt een nieuw teamlid uit', async () => {
    const gebruiker = await maakGebruiker('ui-genodigde');
    gelukt(await rpc('invite_organization_member', { p_organization_id: t.w.orgId, p_email: gebruiker.email, p_role: 'member', p_module_access: {} }, t.w.eigenaar.token), 'uitnodigen');
    return gebruiker;
  });
  if (!genodigde) return;
  await uiStap('het teamlid ziet zijn uitnodiging, geen inrichting, en komt na accepteren in de werkruimte', async () => {
    const lid = await openAlsNieuw(genodigde, 'genodigde', '.login-card');
    lid.tijdelijk = true;
    verwacht(/uitgenodigd/i.test(tekst(await lid.page.locator('.login-card h1').innerText())), 'geen uitnodiging in beeld');
    verwacht(await lid.page.locator('.onb').count() === 0, 'het teamlid kreeg de inrichtingsstappen');
    gelijk(Number(sql(`select count(*) from public.organization_members where user_id = ${q(genodigde.id)}`)), 0, 'lidmaatschappen vóór accepteren');
    await lid.page.getByRole('button', { name: 'Accepteren' }).click();
    await lid.page.locator('.app .sidebar-nav').first().waitFor({ timeout: 30000 });
    gelijk(sql(`select organization_id from public.organization_members where user_id = ${q(genodigde.id)}`), t.w.orgId, 'lid van de organisatie die uitnodigde');
  });
}

// ── Opname: een telefoongesprek opnemen, uitschrijven en samenvatten ─────────

/** Naar Klanten → een klant → Communicatie, via het menu zoals een gebruiker. */
async function naarKlantCommunicatie(scherm, klantNaam) {
  const page = scherm.page;
  await sluitAlles(scherm);
  await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Klanten/ }).first().click();
  await rustig(scherm);
  const klant = inhoud(page).locator('.client-card, .clients-table-row').filter({ hasText: klantNaam }).first();
  await klant.waitFor({ timeout: 15000 });
  await klant.click();
  await rustig(scherm);
  await inhoud(page).getByRole('tab', { name: /^Communicatie/ }).click();
  await rustig(scherm);
}

/**
 * De media-worker van de browser voor opnames. In de UI-test is er geen echte
 * worker (ui-server.mjs geeft 404); hier komt de audio in nep-R2 onder
 * dezelfde sleutel als bij de echte worker (<organisatie>/<soort>/<id>/…),
 * zodat meeting-transcribe hem daar ophaalt.
 */
async function ontvangOpnames(scherm) {
  const geupload = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
  await scherm.context.grantPermissions(['microphone'], { origin: APP });
  await scherm.page.route(/\/__media\/upload$/, async (route) => {
    const verzoek = route.request();
    if (verzoek.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const kop = verzoek.headers();
    const naam = decodeURIComponent(kop['x-file-name'] ?? 'opname.webm');
    const sleutel = `${kop['x-organization-id']}/${kop['x-entity-type']}/${kop['x-entity-id']}/${randomUUID()}-${naam}`;
    const bytes = verzoek.postDataBuffer() ?? Buffer.alloc(0);
    post.r2.set(sleutel, new Uint8Array(bytes));
    geupload.push({ sleutel, grootte: bytes.length, type: kop['x-file-type'] });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ ok: true, key: sleutel }) });
  });
  return geupload;
}

/** Het open logvenster met de recorder. */
function gespreksvenster(page) {
  return page.locator('section.modal').filter({ has: page.locator('.call-recording') });
}

async function scenarioOpname() {
  groep('UI: een telefoongesprek opnemen en samenvatten');
  const { w } = t;
  const bewaard = { webhook: process.env.ELEVENLABS_WEBHOOK_SECRET, tegoed: process.env.GERRIE_MONTHLY_USER_COST_EUR };
  delete process.env.ELEVENLABS_WEBHOOK_SECRET; // synchroon, zoals op staging
  process.env.GERRIE_MONTHLY_USER_COST_EUR = '1';
  // Een kort transcript (tot 1,5 s): dan telt de duur die de browser meet.
  ai.woorden = gesprek(1.5);
  let geupload = [];

  try {
    await uiStap('Klanten → klant A → Communicatie → Gesprek loggen → Opname voorbereiden: de knop "Opname starten" staat er', async () => {
      const lid = await medewerker();
      geupload = await ontvangOpnames(lid);
      await naarKlantCommunicatie(lid, w.klantA.name);
      await inhoud(lid.page).getByRole('button', { name: 'Gesprek loggen' }).click();
      const venster = gespreksvenster(lid.page);
      await venster.waitFor({ timeout: 10000 });
      await venster.getByRole('button', { name: 'Opname voorbereiden' }).click();
      // Tot 8 november stond hier "Opnemen kan zodra de afspraak is opgeslagen", zonder knop.
      await venster.getByRole('button', { name: 'Opname starten' }).waitFor({ timeout: 15000 });
      verwacht(!(await venster.getByText('Opnemen kan zodra de afspraak is opgeslagen.').isVisible().catch(() => false)), 'de oude melding staat er nog');
    });

    const opnameId = await uiStap('opnemen met de microfoon en stoppen: transcript en notulen verschijnen, de duur van de browser klopt', async () => {
      const lid = await medewerker();
      const venster = gespreksvenster(lid.page);
      await venster.getByRole('button', { name: 'Opname starten' }).click();
      await venster.getByRole('button', { name: 'Akkoord, start opname' }).waitFor();
      await rustig(lid);
      verwacht(!(await venster.locator('.mr-budget-note').isVisible().catch(() => false)), 'een waarschuwing over het tegoed terwijl er tegoed is');
      gelijk(tekst(await venster.locator('.mr-consent p').first().innerText()),
        'Dit gesprek wordt opgenomen om er een samenvatting van te maken. Zorg dat de ander hiermee akkoord is.', 'toestemmingsvraag bij een gesprek');
      await venster.getByRole('button', { name: 'Akkoord, start opname' }).click();
      const stop = venster.getByRole('button', { name: /Stop & verwerk/ });
      await stop.waitFor();
      await slaap(3300);
      await stop.click();
      const kaart = venster.locator('.mr-card').first();
      await wachtTot(async () => /Klaar/.test(await kaart.locator('.mr-status').innerText().catch(() => '')), { timeout: 30000, melding: 'de opname werd niet klaar' });
      await kaart.getByText(NOTULEN.samenvatting).waitFor({ timeout: 5000 });
      const rij = sqlRij(`select id, status, duration_seconds, created_by, call_id from public.meeting_recordings
                            where organization_id = ${q(w.orgId)} and call_id is not null order by created_at desc limit 1`);
      gelijk([rij.status, rij.created_by], ['done', w.medewerker.id], 'opname');
      // Het transcript eindigt op 1,5 s; de browser nam ruim 3 s op. Tot 8 november stuurde hij 0 mee.
      verwacht(rij.duration_seconds >= 3 && rij.duration_seconds <= 6, `duur volgens de browser: ${rij.duration_seconds} s`);
      gelijk(geupload.length, 1, 'uploads');
      verwacht(geupload[0].grootte > 1000 && /^audio\//.test(geupload[0].type), `audio: ${JSON.stringify(geupload[0])}`);
      verwacht(geupload[0].sleutel.startsWith(`${w.orgId}/meeting_recording/${rij.id}/`), `sleutel: ${geupload[0].sleutel}`);
      const kosten = sqlRijen(`select user_id, model from public.ai_usage where transcribed_recording_id = ${q(rij.id)}`);
      gelijk(kosten, [{ user_id: w.medewerker.id, model: 'elevenlabs/scribe_v1' }], 'transcriptie in ai_usage');
      return rij.id;
    });

    if (opnameId) {
      await uiStap('tegoed op: de recorder waarschuwt, bewaart de opname, en "Opname uitschrijven" werkt zodra er weer tegoed is', async () => {
        sql(`insert into public.ai_usage (organization_id, user_id, model, cost_usd) values (${q(w.orgId)}, ${q(w.medewerker.id)}, 'claude-sonnet-5-5', 2)`);
        const lid = await medewerker();
        const venster = gespreksvenster(lid.page);
        await venster.getByRole('button', { name: 'Opname starten' }).click();
        const noot = venster.locator('.mr-budget-note');
        await noot.waitFor({ timeout: 10000 });
        verwacht(/AI-tegoed/.test(await noot.innerText()) && /Opnemen kan wel/.test(await noot.innerText()), `waarschuwing: ${await noot.innerText()}`);
        await venster.getByRole('button', { name: 'Akkoord, start opname' }).click();
        const stop = venster.getByRole('button', { name: /Stop & verwerk/ });
        await stop.waitFor();
        await slaap(2200);
        await stop.click();
        // De reden staat één keer in beeld: op de kaart van de bewaarde opname.
        const kaart = venster.locator('.mr-card').first();
        await kaart.getByText('Wacht op uitschrijven').waitFor({ timeout: 20000 });
        await kaart.locator('.mr-card-note').filter({ hasText: /AI-tegoed.*De opname is bewaard/ }).waitFor();
        verwacht(!(await venster.locator('.mr-error').isVisible().catch(() => false)), 'dezelfde melding staat ook nog bovenaan');
        const knop = kaart.getByRole('button', { name: 'Opname uitschrijven' });
        await knop.waitFor();
        // Nog steeds geen tegoed: de knop zegt waarom, met de echte reden van de
        // server en niet "Edge Function returned a non-2xx status code".
        await knop.click();
        await venster.locator('.mr-error').filter({ hasText: /AI-tegoed.*De opname is bewaard/ }).waitFor({ timeout: 20000 });
        verwacht(!/non-2xx/.test(await venster.locator('.mr-error').innerText()), 'de algemene melding van supabase-js in beeld');
        // Een beheerder geeft meer ruimte; dan kan het alsnog.
        process.env.GERRIE_MONTHLY_USER_COST_EUR = '25';
        await knop.click();
        await wachtTot(async () => /Klaar/.test(await kaart.locator('.mr-status').innerText().catch(() => '')), { timeout: 30000, melding: 'de bewaarde opname werd niet klaar' });
        verwacht(!(await venster.locator('.mr-error').isVisible().catch(() => false)), 'de oude foutmelding bleef staan');
        gelijk(geupload.length, 2, 'uploads');
      }, { toegestaan: [{ functie: 'meeting-transcribe', actie: 'start', status: 429 }] });
    }
  } finally {
    if (bewaard.webhook === undefined) delete process.env.ELEVENLABS_WEBHOOK_SECRET; else process.env.ELEVENLABS_WEBHOOK_SECRET = bewaard.webhook;
    if (bewaard.tegoed === undefined) delete process.env.GERRIE_MONTHLY_USER_COST_EUR; else process.env.GERRIE_MONTHLY_USER_COST_EUR = bewaard.tegoed;
    ai.woorden = null;
    if (t.lid) await sluitAlles(t.lid).catch(() => undefined);
  }
}

// ── Klantdomein: het portaal op een eigen domein en op <naam>.resofly.com ───
//
// Waarom in de browser: run.mjs (scenario klantdomein) toetst de functies en
// de database. Hier gaat het om wat de eigenaar en een klant doen en zien: de
// schakelaar, inloggen met de code en met de link, wat de browser bewaart (op
// een eigen domein een sleutel en nooit een inlog bij Supabase), welke dossiers
// in beeld komen, uitloggen, en wat er gebeurt als het portaal uitgaat.
//
// Een eigen domein bestaat hier niet echt. Chromium vraagt
// https://portaal.<ronde>.nl/… op, en de test antwoordt zoals de Worker van de
// klantadressen (workers/client-domains): met zijn eigen beslisregels
// (src/logic.ts) en de echte opzoeking in de functie client-domains. De app
// zelf komt van Vite. Verzoeken naar de backend gaan via de test door, met een
// eigen IP-adres per browser (de remmen van portal-login tellen per adres), en
// de test houdt bij welke kopregels de app meestuurde.

const KLANTADRES_BASIS = 'resofly.com';
// De ontwikkelpaden van Vite: modules (ook de gedeelde code uit
// supabase/functions/_shared die de app importeert) en de client. Op staging
// staat alles gebundeld onder /assets, en dat laat routeFor van de Worker zelf door.
const VITE_PADEN = /^\/(?:@vite\/|@react-refresh|@id\/|@fs\/|src\/|supabase\/|node_modules\/)/;
// src/lib/portalToken.ts
const PORTAAL_SLEUTEL = 'resofly.portal.token';
const IP_BLOK = 1 + Math.floor(Math.random() * 250);
let ipTeller = 0;

async function vanVite(route, pad) {
  const res = await testFetch(`${APP}${pad}`);
  const headers = {};
  res.headers.forEach((waarde, sleutel) => {
    if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive'].includes(sleutel)) headers[sleutel] = waarde;
  });
  await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
}

/** De HTML zoals de Worker hem met HTMLRewriter aanpast (src/index.ts, page()). */
function werkerHtml(html, lookup) {
  const eigenPortaal = lookup.kind === 'custom' && lookup.portalEnabled;
  const meta = clientHostMeta(lookup.host, lookup.portalKey, lookup.kind === 'custom' && !lookup.portalEnabled ? lookup.portalHost : null, eigenPortaal);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(pageTitle(lookup.brand.name))}</title>`)
    .replace(/<link rel="manifest"[^>]*>/, '')
    .replace(/<link rel="apple-touch-icon"[^>]*>/, '')
    .replace(/<link rel="icon"[^>]*>/, '<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>')
    .replace('</head>', `${meta}<meta name="robots" content="noindex,nofollow"></head>`);
}

/** Een verzoek aan een klantadres, beantwoord zoals de Worker (src/index.ts, fetch()). */
async function alsWerker(route, scherm) {
  const request = route.request();
  const url = new URL(request.url());
  const opzoeking = await roep('client-domains', { origin: null, headers: { 'x-client-domains-secret': CLIENT_DOMAINS_WERKER_GEHEIM }, body: { host: url.hostname } });
  const lookup = parseLookup(opzoeking.json);
  const pagina = (status, titel, uitleg) => route.fulfill({ status, contentType: 'text/html; charset=utf-8', body: neutralPage(titel, uitleg) });
  // Doorsturen: de Worker antwoordt met een 301 of 302. Chromium volgt een
  // redirect uit route.fulfill alleen buiten de route om (rechtstreeks naar het
  // netwerk), dus hier een pagina die meteen doorverwijst. Wat de Worker
  // besliste, staat in scherm.doorgestuurd.
  const doorsturen = (status, doel) => {
    scherm.doorgestuurd.push({ status, van: `${url.hostname}${url.pathname}`, naar: doel });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><script>location.replace(${JSON.stringify(doel)})</script>` });
  };
  if (lookup.status === 'redirect') return doorsturen(301, sameUrlOn(lookup.redirectHost, url.pathname, url.search));
  if (lookup.status !== 'active') return pagina(404, 'Dit adres is niet in gebruik', 'Er staat hier (nog) niets.');
  if (lookup.kind === 'custom' && !lookup.portalEnabled && isPortalPath(url.pathname)) {
    const doel = portalRedirectUrl(url.pathname, url.search, lookup.portalHost);
    return doel ? doorsturen(302, doel) : pagina(404, 'Pagina niet gevonden', 'Het klantportaal staat niet op dit adres.');
  }
  if (VITE_PADEN.test(url.pathname)) return vanVite(route, `${url.pathname}${url.search}`);
  const pad = routeFor(url.pathname, request.method(), lookup.portalKey);
  if (pad.kind === 'asset') return vanVite(route, `${url.pathname}${url.search}`);
  if (pad.kind === 'favicon') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: faviconSvg(lookup.brand.name, lookup.brand.accentColor) });
  if (pad.kind !== 'page') return pagina(404, 'Pagina niet gevonden', 'Deze pagina bestaat niet.');
  const html = await (await testFetch(`${APP}/`, { headers: { accept: 'text/html' } })).text();
  return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: werkerHtml(html, lookup) });
}

/**
 * Een verzoek van een klantadres naar de backend (ui-server): met het IP-adres
 * van deze browser, en bijgehouden met de kopregels en (bij client-portal) het
 * antwoord, zodat een stap kan nagaan wat de app meestuurde en wat hij terugkreeg.
 */
async function naarBackend(route, scherm) {
  const request = route.request();
  const kop = request.headers();
  let actie = null;
  try { actie = JSON.parse(request.postData() ?? 'null')?.action ?? null; } catch { /* geen json */ }
  const regel = { pad: new URL(request.url()).pathname, methode: request.method(), actie, kop, status: 0, antwoord: null };
  scherm.api.push(regel);
  try {
    const response = await route.fetch({ headers: { ...kop, 'x-forwarded-for': scherm.ip } });
    regel.status = response.status();
    if (regel.pad === '/functions/v1/client-portal') {
      try { regel.antwoord = JSON.parse((await response.body()).toString('utf8')); } catch { /* geen json */ }
    }
    await route.fulfill({ response });
  } catch {
    await route.abort().catch(() => undefined);
  }
}

/**
 * Een klantadres in een eigen browser zonder sessie: de pagina's zoals de
 * Worker ze geeft, de backend via naarBackend.
 */
async function openOpKlantadres(adres, naam, { tijdelijk = false, voor = null } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const scherm = volg(page, naam, context);
  ipTeller += 1;
  Object.assign(scherm, { tijdelijk, ip: `203.0.${IP_BLOK}.${ipTeller}`, api: [], doorgestuurd: [] });
  // Lettertypen van Google laten we gaan zoals in de andere schermen; elk ander https-adres is een klantadres.
  await context.route((url) => url.protocol === 'https:' && !/(^|\.)(googleapis|gstatic)\.com$/.test(url.hostname),
    (route) => alsWerker(route, scherm).catch(async (error) => {
      // Ook in de uitvoer: een pagina die niet laadt, faalt anders als "net::ERR_FAILED" zonder reden.
      console.error(`        nagebootste Worker bij ${route.request().url()}: ${String(error?.stack || error).split('\n').slice(0, 4).join(' | ')}`);
      scherm.fouten.push(`nagebootste Worker: ${String(error?.stack || error)}`);
      await route.abort().catch(() => undefined);
    }));
  await context.route((url) => url.origin === server.url, (route) => naarBackend(route, scherm));
  // De client van Vite zoekt zijn websocket op het adres van de pagina (en
  // valt terug op wss://127.0.0.1); op een klantadres bestaat die niet. Zonder
  // HMR heeft hij niets te zeggen: een stille, open verbinding is genoeg.
  await context.routeWebSocket((url) => url.searchParams.has('token') && !url.pathname.startsWith('/realtime/'), () => undefined);
  // Iets wat er al moet zijn als de pagina laadt, zoals een nagebootste media-worker.
  // Als laatste geregistreerd, dus vóór de routes hierboven.
  if (voor) await voor(context);
  await page.goto(adres, { waitUntil: 'domcontentloaded' });
  await rustig(scherm);
  return scherm;
}

/** Waar staat het portaal: het inlogscherm, de knop van de inloglink, of een dossier? */
async function portaalStand(page) {
  if (await page.locator('main.portal-app .portal-topbar').first().isVisible().catch(() => false)) return 'dossier';
  if (await page.locator('main.portal.login input[type="email"]').isVisible().catch(() => false)) return 'inloggen';
  if (await page.locator('main.portal.login').getByRole('button', { name: /^Inloggen$/ }).isVisible().catch(() => false)) return 'link';
  return null;
}

async function wachtOpPortaal(scherm, stand) {
  try {
    await wachtTot(async () => (await portaalStand(scherm.page)) === stand, { timeout: 20000, melding: `het portaal van ${scherm.naam} kwam niet op "${stand}"` });
  } catch (error) {
    // Een lege pagina zegt niets; de fouten van de browser wel.
    const fouten = [...scherm.fouten, ...scherm.console.map((c) => `${c.tekst} (${c.url})`)].slice(-6).map((f) => String(f).split('\n')[0]);
    error.message = `${error.message} (wel: ${await portaalStand(scherm.page)}; adres ${scherm.page.url()})${fouten.length ? `\n        browser: ${fouten.join('\n        browser: ')}` : ''}`;
    throw error;
  }
  if (stand === 'dossier') {
    await wachtTot(async () => !(await scherm.page.getByText(/Gegevens laden…/).first().isVisible().catch(() => false)), { melding: 'het dossier bleef laden' });
  }
  await rustig(scherm);
}

/** Alles wat de app in deze browser bewaart (localStorage van dit adres). */
function opslag(page) {
  return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
}

// Waar supabase-js een inlog bewaart: het portaal onder zijn eigen sleutel
// (src/lib/supabasePortal.ts), de werkruimte onder sb-<host>-auth-token.
const PORTAAL_INLOG = 'resofly.portal.auth';
const supabaseInlog = (bewaard) => Object.keys(bewaard).filter((k) => k === PORTAAL_INLOG || /^sb-.*-auth-token$/.test(k));

function inlogLinkUit(mail) {
  const m = `${mail?.text ?? ''} ${mail?.html ?? ''}`.match(/https?:\/\/[^\s"'<>]+\/portal\/inloggen\?aanvraag=[A-Za-z0-9_-]{30,100}/);
  return m ? m[0] : null;
}

function inlogCodeUit(mail) {
  const m = String(mail?.text ?? '').match(/Vul deze code in op het inlogscherm(?: van [^\s:]+(?::\d+)?)?: (\d{6,10})/);
  return m ? m[1] : null;
}

/** Op het inlogscherm van het portaal een inlogmail aanvragen, zoals de klant. Geeft de mail. */
async function vraagInlogAan(scherm, email) {
  const page = scherm.page;
  const voor = mailsAan(email).length;
  await page.locator('main.portal.login input[type="email"]').fill(email);
  await page.locator('main.portal.login').getByRole('button', { name: /^(Stuur inloglink|Stuur opnieuw)$/ }).click();
  await page.locator('main.portal.login .success').waitFor({ timeout: 15000 });
  return wachtTot(() => mailsAan(email).slice(voor)[0], { melding: `geen inlogmail aan ${email}` });
}

async function vulCodeIn(scherm, code) {
  const page = scherm.page;
  await page.locator('#portal-login-code').fill(code);
  await page.getByRole('button', { name: /^Inloggen met code$/ }).click();
}

/** De dossiers in het laatste antwoord van getPortalData dat deze browser kreeg (organisatie-id's). */
function dossierOrganisaties(scherm) {
  const regel = [...scherm.api].reverse().find((r) => r.actie === 'getPortalData' && r.antwoord);
  verwacht(regel, `${scherm.naam}: geen antwoord van getPortalData`);
  return (regel.antwoord.accounts ?? []).map((a) => a.organizationId).sort();
}

function nodig(waarde, wat) {
  if (waarde === undefined || waarde === null || waarde === '') throw new Error(`${wat} ontbreekt`);
  return waarde;
}

const aantalSessies = (userId) => sqlRij(`select count(*)::int as n from auth.sessions where user_id = ${q(userId)}`).n;
const auditDomein = (orgId) => sqlRijen(`select coalesce(metadata->>'event', action) as wat from public.audit_logs where organization_id = ${q(orgId)} and entity_type = 'client_domain' order by created_at`).map((r) => r.wat);

/** Naar Instellingen → Domein, via het accountmenu zoals een gebruiker. */
async function naarDomein(scherm) {
  const page = scherm.page;
  await sluitAlles(scherm);
  await page.locator('.user-trigger').click();
  await page.locator('.user-menu [role="menuitem"]').filter({ hasText: /^Domein$/ }).click();
  await inhoud(page).locator('[data-testid="custom-domain-portal"]').waitFor({ timeout: 15000 });
  await rustig(scherm);
}

async function scenarioKlantdomein() {
  groep('UI: het klantportaal op een eigen domein en op <naam>.resofly.com');
  const { w } = t;
  const ronde = Date.now().toString(36);
  const domein = `portaal.ui${ronde}.nl`;
  const naamHost = `${w.subdomein}.${KLANTADRES_BASIS}`;
  const klantA = w.portaalA;
  const emailC = `klant-c.${ronde}@klant.test`;
  const factuurNummer = `FAC-UI-KD-${ronde}`;
  let tweede = null;
  let eigenaar = null;
  let opDomein = null;
  let opNaam = null;
  let sessiesA = 0;
  const klaar = await stap('klaarzetten: een actief eigen domein (portaal uit), een factuur, en klant A en C ook bij een andere organisatie', async () => {
    // Het koppelen zelf (Cloudflare, DNS, het TXT-bewijs) toetst run.mjs; hier staat het domein meteen actief.
    sql(`insert into public.client_domains (organization_id, hostname, status, verified_at, last_checked_at, created_by)
         values (${q(w.orgId)}, ${q(domein)}, 'active', now(), now(), ${q(w.eigenaar.id)})`);
    await factuurVerstuurd(w, factuurNummer);
    const klant = async (wereld, naam, email) => gelukt(await rest('clients?select=id', {
      method: 'POST', token: wereld.medewerker.token, prefer: 'return=representation',
      body: { organization_id: wereld.orgId, name: naam, email, contact_name: `Contact ${naam}`, client_kind: 'business' },
    }), `klant ${naam}`)[0];
    await klant(w, `Klant C ${ronde}`, emailC);
    tweede = await maakWereld('ui-tweede');
    await klant(tweede, `Klant A bij de tweede ${ronde}`, klantA.email);
    await klant(tweede, `Klant C bij de tweede ${ronde}`, emailC);
    // De tegenproef: met een inlog voor alles (het algemene portaal) heeft
    // klant A twee dossiers. Anders bewijst "maar één dossier" hieronder niets.
    const alles = gelukt(await roep('client-portal', { token: klantA.token, origin: ORIGIN, body: { action: 'getPortalData' } }), 'portaal voor alles');
    gelijk((alles.accounts ?? []).map((a) => a.organizationId).sort(), [w.orgId, tweede.orgId].sort(), 'dossiers van klant A bij een inlog voor alles');
    return true;
  });
  if (!klaar) return;

  await uiStap('Instellingen → Domein: de eigenaar zet het klantportaal op het eigen domein aan', async () => {
    eigenaar = await openWerkruimte(w.eigenaar, 'eigenaar-domein', w.orgId);
    await naarDomein(eigenaar);
    const rij = inhoud(eigenaar.page).locator('[data-testid="custom-domain-portal"]');
    verwacht(tekst(await rij.innerText()).includes(`Ook het klantportaal op ${domein}`), `andere tekst bij de schakelaar: ${tekst(await rij.innerText())}`);
    const vink = rij.locator('input[type="checkbox"]');
    verwacht(!(await vink.isChecked()), 'het portaal stond al aan');
    const sinds = server.verkeer.length;
    // Geen check(): het vinkje volgt de server (een gecontroleerde invoer), pas na het antwoord staat het aan.
    await vink.click();
    await wachtTot(async () => /Het klantportaal staat nu ook op/.test(await inhoud(eigenaar.page).locator('.success').first().innerText().catch(() => '')), { melding: 'geen bevestiging in beeld' });
    verwachtAanroep(sinds, { functie: 'client-domains', actie: 'setPortal' }, 'de schakelaar');
    await wachtTot(() => vink.isChecked(), { timeout: 5000, melding: 'het vinkje staat niet aan' });
    gelijk(sqlRij(`select portal_enabled from public.client_domains where hostname = ${q(domein)}`).portal_enabled, true, 'portal_enabled in de database');
    verwacht(auditDomein(w.orgId).includes('portal_enabled'), `geen regel in het logboek: ${auditDomein(w.orgId)}`);
  });

  await uiStap('een medewerker ziet bij Domein dat het portaal aan staat, maar heeft geen schakelaar', async () => {
    const lid = await medewerker();
    await naarDomein(lid);
    const rij = inhoud(lid.page).locator('[data-testid="custom-domain-portal"]');
    gelijk(await rij.locator('input[type="checkbox"]').count(), 0, 'schakelaars voor een medewerker');
    verwacht(/\bAan\b/.test(await rij.innerText()), `de stand staat er niet: ${tekst(await rij.innerText())}`);
    // Terug naar het werkblad, voor de scenario's hierna.
    await naarFinancien(lid, 'Offertes');
  });

  await uiStap('eigen domein: de klant vraagt een inlog aan, de mail heeft een code van ResoFly en een link naar het eigen domein', async () => {
    opDomein = await openOpKlantadres(`https://${domein}/portal`, 'klant-eigen-domein');
    await wachtOpPortaal(opDomein, 'inloggen');
    const meta = await opDomein.page.locator('meta[name="resofly-client-host"]').getAttribute('content');
    gelijk(JSON.parse(meta).portalMode, 'token', 'de meta van de Worker');
    sessiesA = aantalSessies(klantA.id);
    const sinds = server.verkeer.length;
    const mail = await vraagInlogAan(opDomein, klantA.email);
    verwachtAanroep(sinds, { functie: 'portal-login', actie: 'requestLogin' }, 'aanvragen');
    verwacht(inlogLinkUit(mail)?.startsWith(`https://${domein}/portal/inloggen?aanvraag=`), `de link gaat niet naar het eigen domein: ${inlogLinkUit(mail)}`);
    verwacht(/^\d{8}$/.test(inlogCodeUit(mail) ?? ''), 'geen code van acht cijfers in de mail');
    verwacht(mailtekst(mail).includes(`Vul de code alleen in op ${domein}.`), 'de mail zegt niet waar de code hoort');
    const aanvraag = sqlRij(`select scope_organization_id, host, code_hash is not null as eigen_code, token_hash is null as zonder_supabase
                               from public.portal_login_requests where lower(email) = ${q(klantA.email)} order by created_at desc limit 1`);
    gelijk(aanvraag, { scope_organization_id: w.orgId, host: domein, eigen_code: true, zonder_supabase: true }, 'de aanvraag');
    opDomein.mail = mail;
  });

  await uiStap('eigen domein: met de code komt de klant in alleen dit portaal, met een sleutel en zonder inlog bij Supabase', async () => {
    const sinds = server.verkeer.length;
    await vulCodeIn(opDomein, inlogCodeUit(opDomein.mail));
    await wachtOpPortaal(opDomein, 'dossier');
    verwachtAanroep(sinds, { functie: 'portal-login', actie: 'redeemCode' }, 'de code');
    verwachtAanroep(sinds, { functie: 'client-portal', actie: 'getPortalData' }, 'het dossier laden');
    const bewaard = await opslag(opDomein.page);
    verwacht(/^[A-Za-z0-9_-]{30,100}$/.test(bewaard[PORTAAL_SLEUTEL] ?? ''), 'geen sleutel in de browser');
    gelijk(supabaseInlog(bewaard), [], 'een inlog bij Supabase in de browser op het eigen domein');
    gelijk(aantalSessies(klantA.id), sessiesA, 'sessies bij Supabase (er hoort er geen bij te komen)');
    gelijk(sqlRij(`select count(*)::int as n from public.portal_tokens where user_id = ${q(klantA.id)} and organization_id = ${q(w.orgId)} and host = ${q(domein)}`).n, 1, 'sleutels in de database');
    // Wat de app meestuurde: de sleutel, en geen inlog van een gebruiker.
    const laden = opDomein.api.filter((r) => r.actie === 'getPortalData');
    verwacht(laden.length > 0, 'de app laadde het dossier niet via deze browser');
    for (const r of laden) {
      gelijk(r.kop['x-portal-token'], bewaard[PORTAAL_SLEUTEL], 'kop x-portal-token');
      verwacht(!r.kop.authorization || r.kop.authorization === `Bearer ${ANON_KEY}`, `de app stuurde een inlog mee: ${String(r.kop.authorization).slice(0, 40)}…`);
      gelijk(r.kop.origin, `https://${domein}`, 'herkomst van het verzoek');
    }
    // Klant A is ook klant bij de tweede organisatie; hier bestaat die niet.
    gelijk(dossierOrganisaties(opDomein), [w.orgId], 'dossiers op het eigen domein');
    gelijk(await opDomein.page.locator('.portal-topbar-actions .select-trigger').count(), 0, 'een keuzelijst met dossiers');
    await opDomein.page.locator('.portal-tabs [role="tab"]').filter({ hasText: /^Facturen/ }).click();
    await opDomein.page.getByText(factuurNummer).first().waitFor({ timeout: 10000 });
  });

  await uiStap('eigen domein: na herladen is de klant nog binnen (de sleutel), zonder nieuwe inlog', async () => {
    await opDomein.page.reload({ waitUntil: 'domcontentloaded' });
    await wachtOpPortaal(opDomein, 'dossier');
    gelijk(aantalSessies(klantA.id), sessiesA, 'sessies bij Supabase');
    gelijk(dossierOrganisaties(opDomein), [w.orgId], 'dossiers na herladen');
  });

  await uiStap('eigen domein: uitloggen gooit de sleutel weg, in de browser en bij de server', async () => {
    const sinds = server.verkeer.length;
    await opDomein.page.locator('.portal-topbar-actions').getByRole('button', { name: /^Uitloggen$/ }).click();
    await wachtOpPortaal(opDomein, 'inloggen');
    await wachtTot(() => aanroepen(sinds, { functie: 'portal-login', actie: 'endPortalToken' }).length > 0, { melding: 'geen endPortalToken' });
    verwachtAanroep(sinds, { functie: 'portal-login', actie: 'endPortalToken' }, 'uitloggen');
    gelijk((await opslag(opDomein.page))[PORTAAL_SLEUTEL], undefined, 'sleutel in de browser na uitloggen');
    await wachtTot(() => sqlRij(`select count(*)::int as n from public.portal_tokens where user_id = ${q(klantA.id)} and host = ${q(domein)}`).n === 0, { timeout: 5000, melding: 'de sleutel staat nog in de database' });
  });

  await uiStap('eigen domein: de link uit de mail logt in dezelfde browser in, ook met een sleutel', async () => {
    const mail = await vraagInlogAan(opDomein, klantA.email);
    const link = inlogLinkUit(mail);
    verwacht(link?.startsWith(`https://${domein}/portal/inloggen?aanvraag=`), `link: ${link}`);
    await opDomein.page.goto(link, { waitUntil: 'domcontentloaded' });
    await wachtOpPortaal(opDomein, 'link');
    const sinds = server.verkeer.length;
    await opDomein.page.locator('main.portal.login').getByRole('button', { name: /^Inloggen$/ }).click();
    await wachtOpPortaal(opDomein, 'dossier');
    verwachtAanroep(sinds, { functie: 'portal-login', actie: 'redeemLogin' }, 'de link');
    gelijk(new URL(opDomein.page.url()).pathname, '/portal', 'het adres na inloggen (zonder aanvraagnummer)');
    const bewaard = await opslag(opDomein.page);
    verwacht(bewaard[PORTAAL_SLEUTEL], 'geen sleutel na de link');
    gelijk(supabaseInlog(bewaard), [], 'een inlog bij Supabase na de link');
    gelijk(aantalSessies(klantA.id), sessiesA, 'sessies bij Supabase');
    gelijk(dossierOrganisaties(opDomein), [w.orgId], 'dossiers na de link');
  });

  await uiStap('eigen domein: dezelfde soort link in een andere browser werkt niet, en zegt waarom', async () => {
    const aanvrager = await openOpKlantadres(`https://${domein}/portal`, 'aanvrager', { tijdelijk: true });
    await wachtOpPortaal(aanvrager, 'inloggen');
    const link = inlogLinkUit(await vraagInlogAan(aanvrager, klantA.email));
    const ander = await openOpKlantadres(link, 'ander-apparaat', { tijdelijk: true });
    await wachtOpPortaal(ander, 'link');
    await ander.page.locator('main.portal.login').getByRole('button', { name: /^Inloggen$/ }).click();
    await wachtTot(async () => /hoort bij een andere browser/.test(await ander.page.locator('main.portal.login .error').innerText().catch(() => '')), { melding: 'geen uitleg in beeld' });
    verwacht(!(await opslag(ander.page))[PORTAAL_SLEUTEL], 'een sleutel in de andere browser');
  }, { toegestaan: [{ functie: 'portal-login', actie: 'redeemLogin', status: 403 }], foutmelding: /hoort bij een andere browser/ });

  await uiStap('Instellingen → Domein: de eigenaar zet het portaal uit, en de klant op het eigen domein is meteen uitgelogd', async () => {
    const vink = inhoud(eigenaar.page).locator('[data-testid="custom-domain-portal"] input[type="checkbox"]');
    const sinds = server.verkeer.length;
    await vink.click();
    await wachtTot(async () => /Het klantportaal staat weer alleen op/.test(await inhoud(eigenaar.page).locator('.success').first().innerText().catch(() => '')), { melding: 'geen bevestiging in beeld' });
    verwachtAanroep(sinds, { functie: 'client-domains', actie: 'setPortal' }, 'de schakelaar');
    gelijk(sqlRij(`select portal_enabled from public.client_domains where hostname = ${q(domein)}`).portal_enabled, false, 'portal_enabled in de database');
    verwacht(auditDomein(w.orgId).includes('portal_disabled'), `geen regel in het logboek: ${auditDomein(w.orgId)}`);
    // De klant had het portaal nog open (ingelogd met de link). Binnen de minuut
    // dat de functie het adres onthoudt, krijgt hij een nette 401 en logt de app hem uit.
    await opDomein.page.locator('.portal-topbar-actions').getByRole('button', { name: /^Ververs$/ }).click();
    await wachtOpPortaal(opDomein, 'inloggen');
    await opDomein.page.getByText('Je bent uitgelogd. Log opnieuw in.').waitFor({ timeout: 10000 });
    gelijk((await opslag(opDomein.page))[PORTAAL_SLEUTEL], undefined, 'sleutel in de browser');
    gelijk(sqlRij(`select count(*)::int as n from public.portal_tokens where user_id = ${q(klantA.id)} and host = ${q(domein)}`).n, 0, 'sleutels in de database');
  }, { toegestaan: [{ functie: 'client-portal', status: 401 }] });

  await uiStap('met het portaal uit stuurt het eigen domein /portal door naar <naam>.resofly.com', async () => {
    // Na die minuut: de functie zoekt het adres opnieuw op.
    clearClientOriginCache();
    await opDomein.page.goto(`https://${domein}/portal`, { waitUntil: 'domcontentloaded' });
    await wachtOpPortaal(opDomein, 'inloggen');
    gelijk(new URL(opDomein.page.url()).host, naamHost, 'het adres na het doorsturen');
    gelijk(opDomein.doorgestuurd.at(-1), { status: 302, van: `${domein}/portal`, naar: `https://${naamHost}/portal` }, 'wat de Worker deed');
    const meta = JSON.parse(await opDomein.page.locator('meta[name="resofly-client-host"]').getAttribute('content'));
    gelijk(meta.portalMode, undefined, 'de meta op de naam bij ResoFly (geen sleutelmodus)');
  });

  await uiStap('<naam>.resofly.com: alleen een inloglink (geen code), en de app legt de inlog vast voor alleen deze organisatie', async () => {
    opNaam = await openOpKlantadres(`https://${naamHost}/portal`, 'klant-naam');
    await wachtOpPortaal(opNaam, 'inloggen');
    const mail = await vraagInlogAan(opNaam, emailC);
    // Geen code van Supabase (migratie 20261109150000), en dus ook geen veld om hem in te vullen.
    gelijk(inlogCodeUit(mail), null, 'een code in de mail');
    verwacht(mailtekst(mail).includes(`Vraag daar een nieuwe inloglink aan, op ${naamHost}.`), 'de mail zegt niet wat te doen op een ander apparaat');
    gelijk(await opNaam.page.locator('#portal-login-code').count(), 0, 'een veld voor een code');
    verwacht(/op een ander apparaat werkt hij niet/.test(await opNaam.page.locator('main.portal.login .success').innerText()), 'de uitleg na het versturen');
    const link = inlogLinkUit(mail);
    verwacht(link?.startsWith(`https://${naamHost}/portal/inloggen?aanvraag=`), `de link gaat niet naar de naam bij ResoFly: ${link}`);
    await opNaam.page.goto(link, { waitUntil: 'domcontentloaded' });
    await wachtOpPortaal(opNaam, 'link');
    const sinds = server.verkeer.length;
    await opNaam.page.locator('main.portal.login').getByRole('button', { name: /^Inloggen$/ }).click();
    await wachtOpPortaal(opNaam, 'dossier');
    verwachtAanroep(sinds, { functie: 'portal-login', actie: 'redeemLogin' }, 'de link');
    verwachtAanroep(sinds, { functie: 'portal-login', actie: 'bindSession' }, 'vastleggen');
    const bewaard = await opslag(opNaam.page);
    gelijk(supabaseInlog(bewaard), [PORTAAL_INLOG], 'de inlog bij Supabase op de naam bij ResoFly');
    gelijk(bewaard[PORTAAL_SLEUTEL], undefined, 'een sleutel van een eigen domein');
    const sessie = JSON.parse(bewaard[PORTAAL_INLOG]);
    const claims = JSON.parse(Buffer.from(sessie.access_token.split('.')[1], 'base64url').toString());
    gelijk(sqlRij(`select organization_id, host from public.portal_sessions where session_id = ${q(claims.session_id)}`), { organization_id: w.orgId, host: naamHost }, 'de vastgelegde inlog');
    gelijk(sqlRij(`select (bound_session_id = ${q(claims.session_id)}::uuid) as gebonden from public.portal_login_requests
                    where request_hash = encode(sha256(convert_to(${q(new URL(link).searchParams.get('aanvraag'))}, 'UTF8')), 'hex')`).gebonden, true, 'de inlog hoort bij de aanvraag van de link');
    opNaam.sessieId = claims.session_id;
    const laden = opNaam.api.filter((r) => r.actie === 'getPortalData');
    verwacht(laden.length > 0 && laden.every((r) => r.kop.authorization === `Bearer ${sessie.access_token}` && !r.kop['x-portal-token']), 'de app stuurde niet de inlog (of wel een sleutel)');
    // Klant C is ook klant bij de tweede organisatie; hier bestaat die niet.
    gelijk(dossierOrganisaties(opNaam), [w.orgId], 'dossiers op de naam bij ResoFly');
  });

  await uiStap('<naam>.resofly.com: uitloggen beëindigt deze inlog bij Supabase', async () => {
    await opNaam.page.locator('.portal-topbar-actions').getByRole('button', { name: /^Uitloggen$/ }).click();
    await wachtOpPortaal(opNaam, 'inloggen');
    gelijk(supabaseInlog(await opslag(opNaam.page)), [], 'inlog in de browser na uitloggen');
    await wachtTot(() => sqlRij(`select count(*)::int as n from auth.sessions where id = ${q(opNaam.sessieId)}`).n === 0, { timeout: 5000, melding: 'Supabase kent de sessie nog' });
  });

  await uiStap('<naam>.resofly.com: de link in een andere browser werkt niet, en zegt wat je dan doet', async () => {
    const link = inlogLinkUit(await vraagInlogAan(opNaam, emailC));
    const ander = await openOpKlantadres(link, 'ander-apparaat-naam', { tijdelijk: true });
    await wachtOpPortaal(ander, 'link');
    await ander.page.locator('main.portal.login').getByRole('button', { name: /^Inloggen$/ }).click();
    const fout = ander.page.locator('main.portal.login .error');
    await wachtTot(async () => /hoort bij een andere browser/.test(await fout.innerText().catch(() => '')), { melding: 'geen uitleg in beeld' });
    verwacht(/vraag hier een nieuwe aan/.test(await fout.innerText()), `geen uitweg in de melding: ${await fout.innerText()}`);
    verwacht(!/code/.test(await fout.innerText()), 'de melding noemt een code');
    gelijk(supabaseInlog(await opslag(ander.page)), [], 'een inlog in de andere browser');
  }, { toegestaan: [{ functie: 'portal-login', actie: 'redeemLogin', status: 403 }], foutmelding: /hoort bij een andere browser/ });

  await uiStap('het algemene portaal: met de link een inlog voor alles, met de dossiers van beide organisaties', async () => {
    const algemeen = await openAlsKlant(`${APP}/portal`, 'klant-algemeen');
    await wachtOpPortaal(algemeen, 'inloggen');
    const mail = await vraagInlogAan(algemeen, klantA.email);
    gelijk(inlogCodeUit(mail), null, 'een code in de mail');
    gelijk(await algemeen.page.locator('#portal-login-code').count(), 0, 'een veld voor een code');
    const link = inlogLinkUit(mail);
    verwacht(link?.startsWith(`${APP}/portal/inloggen?aanvraag=`), `link: ${link}`);
    await algemeen.page.goto(link, { waitUntil: 'domcontentloaded' });
    await wachtOpPortaal(algemeen, 'link');
    await algemeen.page.locator('main.portal.login').getByRole('button', { name: /^Inloggen$/ }).click();
    await wachtOpPortaal(algemeen, 'dossier');
    const sessie = JSON.parse((await opslag(algemeen.page))[PORTAAL_INLOG]);
    const claims = JSON.parse(Buffer.from(sessie.access_token.split('.')[1], 'base64url').toString());
    gelijk(sqlRij(`select organization_id, host from public.portal_sessions where session_id = ${q(claims.session_id)}`).organization_id, null, 'het bereik van de inlog');
    // Twee dossiers: de keuzelijst staat er, met beide organisaties.
    await algemeen.page.locator('.portal-topbar-actions .select-trigger').click();
    const opties = (await algemeen.page.locator('.select-menu [role="option"]').allInnerTexts()).map(tekst);
    gelijk(opties.length, 2, `dossiers in de keuzelijst: ${opties.join(', ')}`);
    await algemeen.page.keyboard.press('Escape');
  });

  for (const s of [opDomein, opNaam, eigenaar]) await sluit(s);
}

// ── Rapportages met Gerrie ──────────────────────────────────────────────────
// Zoals een gebruiker het doet: op Rapportages een vraag stellen, de pagina die
// dan ontstaat met de echte cijfers in het afgeschermde kader, aanpassen via de
// chat, een oude versie terugzetten en verwijderen. Claude is nep (streamend, met
// tool-aanroepen; zie rapportages.mjs), de functie en de database zijn echt.
async function scenarioRapportage() {
  groep('UI: rapportages met Gerrie');
  installeerClaude();
  // Een eigen organisatie: de cijfers moeten exact kloppen, en de andere
  // scenario's maken in de gedeelde wereld hun eigen facturen.
  const w = await maakWereld('uirapport');
  const lid = await openWerkruimte(w.medewerker, 'rapporteur', w.orgId);
  zetFacturen(w, [
    { klant: w.klantA.id, datum: `${JAAR}-01-15`, status: 'paid', regels: [regel(1, 1000)] },
    { klant: w.klantB.id, datum: `${JAAR}-03-20`, status: 'sent', regels: [regel(3, 100.1)] },
    { klant: w.klantB.id, datum: `${JAAR}-03-21`, status: 'draft', regels: [regel(1, 5000)] },
  ]);
  const kader = () => lid.page.frameLocator('.aire-frame');
  let rapportId = null;

  await uiStap('Rapportages openen: vraagveld, voorbeeldvragen en het AI-tegoed', async () => {
    await lid.page.locator('.sidebar-nav .nav-item', { hasText: 'Rapportages' }).first().click();
    await lid.page.locator('.aire-ask textarea').waitFor({ timeout: 15000 });
    verwacht(await lid.page.locator('.aire-ask .aire-suggest button').count() >= 4, 'geen voorbeeldvragen');
    verwacht(/AI-tegoed/.test(await lid.page.locator('.aire-ask-foot').innerText()), 'het tegoed staat er niet bij');
    await lid.page.getByText('Nog geen rapportages').waitFor();
  });

  await uiStap('een vraag wordt een eigen pagina met de echte cijfers', async () => {
    const sinds = server.verkeer.length;
    claude.beurten.push(
      { text: 'Ik kijk eerst naar je facturen.', tools: [{ name: 'query_records', input: OMZET_DATASETS[0].input }] },
      { text: 'Ik heb een pagina gemaakt met je omzet per maand en per klant.', tools: [{ name: 'save_report', input: { title: 'Omzet dit jaar', summary: 'Omzet per maand en per klant.', datasets: OMZET_DATASETS, html: OMZET_HTML } }] },
    );
    await lid.page.locator('.aire-ask textarea').fill('Omzet per maand dit jaar');
    await lid.page.locator('.aire-ask-send').click();
    await lid.page.locator('.aire-frame').waitFor({ timeout: 45000 });
    await kader().locator('.rf-kpi-value').first().waitFor({ timeout: 20000 });
    gelijk(tekst(await kader().locator('.rf-kpi-value').first().innerText()), '€ 1.300,30', 'omzet in het kader');
    await lid.page.locator('.aire-msg.assistant .aire-chip', { hasText: 'versie 1' }).waitFor();
    verwacht(/AI-tegoed/.test(await lid.page.locator('.aire-msg.assistant .aire-msg-meta').last().innerText()), 'wat de beurt kostte staat er niet bij');
    // Het tabblad wijst nu naar de echte rapportage (niet meer naar de tijdelijke sleutel).
    const tabs = JSON.parse(await lid.page.evaluate((org) => localStorage.getItem(`brandcore.tabs.${org}`), w.orgId));
    rapportId = tabs.tabs[tabs.activeIndex].statsReportId;
    verwacht(/^[0-9a-f-]{36}$/.test(rapportId ?? ''), `tabblad: ${rapportId}`);
    gelijk(sqlRij(`select created_by from public.ai_reports where id = ${q(rapportId)}`).created_by, w.medewerker.id, 'eigenaar');
    verwacht(await lid.page.locator('.tabbar .tab, [class*="tab"]').filter({ hasText: 'Omzet dit jaar' }).count() > 0, 'de tabtitel is niet de titel van de rapportage');
    // Gerrie bouwde in één beurt; de gegevens kwamen mee, dus geen extra report_data.
    gelijk(aanroepen(sinds, { functie: 'gerrie-agent', actie: 'report_data' }).length, 0, 'extra ophaalronde');
  });

  await uiStap('verversen haalt de cijfers opnieuw op, zonder AI', async () => {
    const sinds = server.verkeer.length;
    const verbruik = sqlRij(`select count(*)::int as n from public.ai_usage where user_id = ${q(w.medewerker.id)}`).n;
    zetFacturen(w, [{ klant: w.klantA.id, datum: `${JAAR}-02-02`, status: 'paid', regels: [regel(1, 199.7)] }]);
    await lid.page.locator('.aire-actions button', { hasText: 'Verversen' }).click();
    await wachtTot(async () => tekst(await kader().locator('.rf-kpi-value').first().innerText().catch(() => '')) === '€ 1.500,00', { melding: 'de nieuwe factuur telt niet mee na verversen' });
    gelijk(aanroepen(sinds, { functie: 'gerrie-agent', actie: 'report_data' }).length, 1, 'report_data');
    gelijk(sqlRij(`select count(*)::int as n from public.ai_usage where user_id = ${q(w.medewerker.id)}`).n, verbruik, 'nieuw verbruik door verversen');
  });

  await uiStap('aanpassen via de chat wordt versie 2', async () => {
    claude.beurten.push({ text: 'De kop heet nu "Omzet per maand".', tools: [{ name: 'save_report', input: { title: 'Omzet dit jaar', html_edits: [{ find: '<h1>Omzet</h1>', replace: '<h1>Omzet per maand</h1>' }] } }] });
    await lid.page.locator('.aire-composer textarea').fill('Noem de kop "Omzet per maand"');
    await lid.page.locator('.aire-send').click();
    await lid.page.locator('.aire-msg.assistant .aire-chip', { hasText: 'versie 2' }).waitFor({ timeout: 30000 });
    await kader().locator('h1', { hasText: 'Omzet per maand' }).waitFor({ timeout: 15000 });
    verwacht(/Versie 2/.test(await lid.page.locator('.aire-meta').innerText()), 'de kop zegt geen versie 2');
  });

  await uiStap('versie 1 bekijken en terugzetten: dat wordt versie 3', async () => {
    await lid.page.locator('.aire-versions button', { hasText: 'Versies' }).click();
    await lid.page.locator('.aire-versions-menu button', { hasText: 'Versie 1' }).click();
    await lid.page.locator('.aire-preview-bar').waitFor();
    await kader().locator('h1', { hasText: /^Omzet$/ }).waitFor({ timeout: 15000 });
    await lid.page.locator('.aire-preview-bar button', { hasText: 'Deze versie terugzetten' }).click();
    await lid.page.locator('.aire-preview-bar').waitFor({ state: 'detached' });
    await wachtTot(async () => /Versie 3/.test(await lid.page.locator('.aire-meta').innerText()), { melding: 'geen versie 3 na terugzetten' });
    gelijk(sqlRij(`select request from public.ai_report_versions where report_id = ${q(rapportId)} and version = 3`).request, 'Versie 1 teruggezet', 'de versie zegt wat er gebeurde');
  });

  await uiStap('de rapportage staat in het menu en in het overzicht; verwijderen ruimt hem op', async () => {
    verwacht(await lid.page.locator('.nav-submenu-reports button', { hasText: 'Omzet dit jaar' }).count() === 1, 'niet in het menu onder Rapportages');
    lid.plan.push({});
    await lid.page.locator('.aire-actions button', { hasText: 'Verwijderen' }).click();
    await lid.page.getByText('Nog geen rapportages').waitFor({ timeout: 15000 });
    verwacht(lid.dialogen.some((d) => /komt niet terug/.test(d.tekst)), 'de vraag vooraf noemt niet dat het tegoed niet terugkomt');
    gelijk(sqlRij(`select count(*)::int as n from public.ai_reports where id = ${q(rapportId)}`).n, 0, 'nog in de database');
  });
  await sluit(lid);
}

// ── Tickets: van het team via de mail naar de klant en terug ────────────────
// Een medewerker maakt een ticket in het venster, antwoordt in de tijdlijn (één
// interne notitie, één zichtbare) en zet de status. De mailronde (portal-notify,
// zoals pg_cron hem elke minuut aanroept) mailt de klant. De klant opent de knop
// uit die mail in een eigen browser, logt in en komt meteen bij het ticket. Zijn
// reactie staat bij het team als nieuw; afhandelen haalt het ticket van de
// werklijst. Aanleiding: de controle van het ticketsysteem op 10 november 2026.
async function ticketMailronde() {
  return gelukt(await roep('portal-notify', {
    query: 'cron=drain', origin: null, body: {}, headers: { 'x-cron-secret': CRON_SECRET },
  }), 'mailronde');
}

async function naarTickets(scherm) {
  await sluitAlles(scherm);
  await scherm.page.locator('.sidebar-nav .nav-item', { hasText: /^Tickets/ }).first().click();
  await inhoud(scherm.page).locator('.ticket-toolbar').waitFor({ timeout: 15000 });
  await rustig(scherm);
}

function ticketKaart(page, titel) {
  return inhoud(page).locator('article.ticket-item').filter({ has: page.locator('.tk-title', { hasText: regexVan(titel) }) });
}

async function scenarioTickets() {
  groep('UI: tickets — van het team via de mail naar de klant en terug');
  const w = await stap('wereld maken', () => maakWereld('uitickets'));
  if (!w) return;
  const titel = 'Inloggen lukt niet';
  const geheim = `Intern: wachtwoord ${randomUUID().slice(0, 8)}`;
  const antwoord = 'We hebben je account hersteld. Probeer het nog eens?';
  let lid = null;
  let klant = null;
  let ticketId = null;
  let link = null;

  await uiStap('een medewerker maakt een ticket voor klant A in het venster', async () => {
    lid = await openWerkruimte(w.medewerker, 'ticketlid', w.orgId);
    await naarTickets(lid);
    const sinds = server.verkeer.length;
    await inhoud(lid.page).getByRole('button', { name: '+ Nieuw ticket', exact: true }).click();
    const m = modal(lid.page, 'Nieuw ticket');
    await m.waitFor();
    await m.getByPlaceholder('Ticket titel').fill(titel);
    const keuzes = m.locator('.select-trigger');
    await keuzes.nth(0).click();
    await lid.page.locator('.select-menu [role="option"]').filter({ hasText: regexVan(w.klantA.name) }).first().click();
    await m.getByPlaceholder('Beschrijving').fill('De klant komt niet binnen in het portaal.');
    await m.locator('.modal-foot').getByRole('button', { name: 'Opslaan', exact: true }).click();
    await m.waitFor({ state: 'detached', timeout: 15000 });
    verwachtAanroep(sinds, { soort: 'rest', tabel: 'tickets', methode: 'POST' }, 'Opslaan schreef het ticket niet weg');
    await ticketKaart(lid.page, titel).waitFor({ timeout: 15000 });
    const rijDb = sqlRij(`select id, client_id, status, created_by from public.tickets where organization_id = ${q(w.orgId)} and title = ${q(titel)}`);
    gelijk([rijDb.client_id, rijDb.status, rijDb.created_by], [w.klantA.id, 'new', w.medewerker.id], 'het ticket in de database');
    ticketId = rijDb.id;
  });

  await uiStap('in de tijdlijn: een interne notitie, een zichtbaar antwoord, en de status op Review', async () => {
    nodig(ticketId, 'het ticket');
    await ticketKaart(lid.page, titel).click();
    const m = modal(lid.page, 'Ticket bewerken');
    await m.waitFor();
    const schrijfvak = m.getByPlaceholder('Schrijf een update voor de klant of een interne notitie…');
    await schrijfvak.waitFor({ timeout: 15000 });
    // Intern: het vinkje aan, dan "Plaats interne notitie".
    await schrijfvak.fill(geheim);
    await m.locator('.ticket-visibility-toggle input').check();
    await m.getByRole('button', { name: 'Plaats interne notitie', exact: true }).click();
    await m.locator('.ticket-timeline-item.is-internal .ttl-text', { hasText: geheim }).waitFor({ timeout: 15000 });
    // Zichtbaar: het vinkje uit, dan "Plaats notitie".
    await schrijfvak.fill(antwoord);
    await m.locator('.ticket-visibility-toggle input').uncheck();
    verwacht(/krijgt er ook een e-mail van/.test(await m.locator('.ticket-timeline-mailhint').first().innerText()), 'de hint zegt niet dat de klant een mail krijgt');
    await m.getByRole('button', { name: 'Plaats notitie', exact: true }).click();
    await m.locator('.ticket-timeline-item:not(.is-internal) .ttl-text', { hasText: antwoord }).waitFor({ timeout: 15000 });
    // De status: de vierde keuzelijst in het venster (klant, prioriteit, status).
    const keuzes = m.locator('.select-trigger');
    await keuzes.nth(2).click();
    await lid.page.locator('.select-menu [role="option"]').filter({ hasText: /^Review$/ }).first().click();
    await m.locator('.modal-foot').getByRole('button', { name: 'Opslaan', exact: true }).click();
    await m.waitFor({ state: 'detached', timeout: 15000 });
    gelijk(sqlRij(`select status from public.tickets where id = ${q(ticketId)}`).status, 'review', 'status in de database');
    const notities = sqlRijen(`select body, is_internal from public.ticket_notes where ticket_id = ${q(ticketId)} order by created_at`);
    gelijk(notities.map((n) => n.is_internal), [true, false], 'intern en zichtbaar');
  });

  await uiStap('de mailronde mailt klant A één keer: het antwoord en de nieuwe status, niets intern', async () => {
    const voor = mailsAan(w.klantA.email).length;
    await ticketMailronde();
    const mails = mailsAan(w.klantA.email).slice(voor);
    gelijk(mails.length, 1, 'mails aan klant A');
    const mail = mails[0];
    verwacht(mail.text.includes(antwoord), 'het antwoord staat niet in de mail');
    verwacht(mail.text.includes('In behandeling'), 'de nieuwe status staat niet in de mail');
    verwacht(!mail.text.includes(geheim) && !mail.html.includes(geheim), 'de interne notitie staat in de mail');
    link = (mail.text.match(/https?:\/\/\S+\/portal\S*ticket=[0-9a-f-]{36}/) ?? [])[0] ?? null;
    verwacht(link && link.startsWith(APP) && link.includes(`ticket=${ticketId}`), `de knop wijst niet naar het ticket in deze app: ${link}`);
  });

  await uiStap('de klant opent de knop uit de mail, logt in en komt meteen bij het ticket', async () => {
    klant = await openAlsKlant(nodig(link, 'de link uit de mail'), 'klant-ticket');
    klant.tijdelijk = false;
    await wachtOpPortaal(klant, 'inloggen');
    const inlog = inlogLinkUit(await vraagInlogAan(klant, w.klantA.email));
    await klant.page.goto(nodig(inlog, 'de inloglink'), { waitUntil: 'domcontentloaded' });
    await wachtOpPortaal(klant, 'link');
    await klant.page.locator('main.portal.login').getByRole('button', { name: /^Inloggen$/ }).click();
    await wachtOpPortaal(klant, 'dossier');
    const detail = klant.page.locator('.portal-detail');
    await detail.locator('h2', { hasText: regexVan(titel) }).waitFor({ timeout: 20000 });
    await detail.locator('.portal-thread', { hasText: antwoord }).waitFor({ timeout: 15000 });
    const gesprek = tekst(await detail.locator('.portal-thread').innerText());
    verwacht(!gesprek.includes(geheim), 'de interne notitie staat in het portaal');
    verwacht(/In behandeling/.test(tekst(await detail.innerText())), 'de status In behandeling staat er niet');
  });

  await uiStap('de klant reageert; bij het team staat het ticket als nieuw, met de reactie in de tijdlijn', async () => {
    nodig(klant, 'de klant in het portaal');
    const detail = klant.page.locator('.portal-detail');
    await detail.getByPlaceholder(/^Typ een bericht aan /).fill('Het werkt weer, dank je!');
    await detail.getByRole('button', { name: 'Bericht versturen', exact: true }).click();
    await detail.locator('.portal-thread', { hasText: 'Het werkt weer, dank je!' }).waitFor({ timeout: 15000 });
    gelijk(sqlRij(`select author_type, is_internal from public.ticket_notes where ticket_id = ${q(ticketId)} order by created_at desc limit 1`), { author_type: 'client', is_internal: false }, 'de reactie in de database');
    await ververs(lid);
    await naarTickets(lid);
    await ticketKaart(lid.page, titel).locator('.tk-new-badge').waitFor({ timeout: 15000 });
    await ticketKaart(lid.page, titel).click();
    const m = modal(lid.page, 'Ticket bewerken');
    await m.locator('.ticket-timeline-item.from-client .ttl-text', { hasText: 'Het werkt weer, dank je!' }).waitFor({ timeout: 15000 });
    await sluitModal(m);
    await wachtTot(async () => (await ticketKaart(lid.page, titel).locator('.tk-new-badge').count()) === 0, { melding: 'na openen staat het ticket nog als nieuw' });
  });

  await uiStap('afhandelen met de knop: van de werklijst naar het archief, en de klant ziet Afgehandeld', async () => {
    await ticketKaart(lid.page, titel).getByRole('button', { name: 'Afhandelen' }).click();
    await wachtTot(async () => (await ticketKaart(lid.page, titel).count()) === 0, { melding: 'het ticket bleef op de werklijst' });
    gelijk(sqlRij(`select status from public.tickets where id = ${q(ticketId)}`).status, 'resolved', 'status in de database');
    await inhoud(lid.page).locator('.ticket-toolbar button[aria-label^="Archief"]').click();
    await ticketKaart(lid.page, titel).waitFor({ timeout: 15000 });
    const voor = mailsAan(w.klantA.email).length;
    await ticketMailronde();
    const mails = mailsAan(w.klantA.email).slice(voor);
    gelijk(mails.length, 1, 'mails aan klant A');
    verwacht(mails[0].subject.startsWith(`Ticket afgehandeld: ${titel}`), `onderwerp: ${mails[0].subject}`);
    // De klant: na herladen op het overzicht (de link uit de mail is gebruikt).
    // Onder Tickets staat het in het dichte blok Afgehandeld, niet meer bij open.
    await klant.page.reload({ waitUntil: 'domcontentloaded' });
    await wachtOpPortaal(klant, 'dossier');
    await klant.page.locator('.portal-tabs [role="tab"]', { hasText: /^Tickets/ }).click();
    const blok = klant.page.locator('section.portal-resolved');
    await blok.locator('.portal-resolved-head').click();
    await blok.locator('.portal-ticket', { hasText: titel }).click();
    await klant.page.locator('.portal-detail .portal-status', { hasText: 'Afgehandeld' }).waitFor({ timeout: 20000 });
    await klant.page.locator('.portal-resolved-hint').waitFor({ timeout: 15000 });
  });

  await uiStap('een open venster zet een heropend ticket niet terug op Afgehandeld', async () => {
    // Het venster staat open op het afgehandelde ticket; intussen reageert de
    // klant (de database zet het op Review). Opslaan met alleen een memo mag de
    // status niet terugzetten, en de klant krijgt geen mail "afgehandeld".
    await ticketKaart(lid.page, titel).click();
    const m = modal(lid.page, 'Ticket bewerken');
    await m.waitFor();
    gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'addTicketNote', ticketId, body: 'Toch nog een vraag.' } }), 'reactie van de klant');
    gelijk(sqlRij(`select status from public.tickets where id = ${q(ticketId)}`).status, 'review', 'heropend door de reactie');
    await m.getByPlaceholder('Interne notities (privé, niet in de tijdlijn)').fill('Klant belt morgen terug.');
    await m.locator('.modal-foot').getByRole('button', { name: 'Opslaan', exact: true }).click();
    await m.waitFor({ state: 'detached', timeout: 15000 });
    gelijk(sqlRij(`select status, notes from public.tickets where id = ${q(ticketId)}`), { status: 'review', notes: 'Klant belt morgen terug.' }, 'status en memo in de database');
    const voor = mailsAan(w.klantA.email).length;
    await ticketMailronde();
    verwacht(mailsAan(w.klantA.email).slice(voor).every((mail) => !/afgehandeld/i.test(mail.subject)), 'de klant kreeg toch een mail "afgehandeld"');
  });

  await uiStap('een ticket aan een andere klant hangen: eerst de vraag, en weigeren laat alles staan', async () => {
    await naarTickets(lid);
    // Het ticket staat weer op de werklijst; de pagina stond nog op het archief.
    const terug = inhoud(lid.page).locator('.ticket-archive-back');
    if (await terug.isVisible().catch(() => false)) await terug.click();
    await ticketKaart(lid.page, titel).click();
    const m = modal(lid.page, 'Ticket bewerken');
    await m.waitFor();
    await m.locator('.select-trigger').nth(0).click();
    await lid.page.locator('.select-menu [role="option"]').filter({ hasText: regexVan(w.klantB.name) }).first().click();
    lid.plan.push({ weiger: true });
    const dialogen = lid.dialogen.length;
    await m.locator('.modal-foot').getByRole('button', { name: 'Opslaan', exact: true }).click();
    await wachtTot(() => lid.dialogen.length > dialogen, { melding: 'geen vraag vóór het koppelen aan een andere klant' });
    const vraag = lid.dialogen.at(-1).tekst;
    verwacht(vraag.startsWith(`${w.klantB.name} ziet dit ticket daarna in het klantportaal`) && vraag.includes(`ook wat ${w.klantA.name} schreef`), `de vraag: ${vraag}`);
    await m.waitFor({ timeout: 5000 });
    gelijk(sqlRij(`select client_id from public.tickets where id = ${q(ticketId)}`).client_id, w.klantA.id, 'de klant is niet veranderd');
    await sluitModal(m);
  });

  await uiStap('een klant op inactief: geen tickets meer in het portaal, wel facturen en berichten', async () => {
    // Keuze van de eigenaar (10 november): een klant op inactief hoeft niet meer bij de tickets.
    sql(`update public.clients set status = 'inactive' where id = ${q(w.klantA.id)}`);
    try {
      await klant.page.reload({ waitUntil: 'domcontentloaded' });
      await wachtOpPortaal(klant, 'dossier');
      const tabs = (await klant.page.locator('.portal-tabs [role="tab"]').allInnerTexts()).map(tekst);
      verwacht(!tabs.some((t) => /^Tickets/.test(t)), `een tabblad Tickets: ${tabs.join(', ')}`);
      verwacht(tabs.some((t) => /^Facturen/.test(t)) && tabs.some((t) => /^Berichten/.test(t)), `tabbladen: ${tabs.join(', ')}`);
      const kengetallen = tekst(await klant.page.locator('.portal-kpis').innerText());
      verwacht(!/Open tickets/.test(kengetallen) && /Berichten/.test(kengetallen), `kengetallen: ${kengetallen}`);
      await klant.page.locator('.portal-topbar-actions').getByRole('button', { name: /Instellingen/ }).click();
      await klant.page.locator('.portal-settings .portal-settings-note', { hasText: 'Tickets staan voor' }).waitFor({ timeout: 15000 });
      gelijk(await klant.page.locator('.portal-settings .portal-toggle-list').count(), 0, 'schakelaars voor ticketmail');
      // Het team ziet het ook, in het klantdossier (na Ververs: de status kwam hierboven via de database).
      await ververs(lid);
      await lid.page.locator('.sidebar-nav .nav-item', { hasText: /^Klanten/ }).first().click();
      await inhoud(lid.page).getByText(w.klantA.name, { exact: true }).first().click();
      await inhoud(lid.page).locator('.client-tabs-bar [role="tab"]', { hasText: /^Tickets/ }).first().click();
      await inhoud(lid.page).locator('.client-tickets-inactive').waitFor({ timeout: 15000 });
    } finally {
      sql(`update public.clients set status = 'active' where id = ${q(w.klantA.id)}`);
    }
  });

  for (const s of [klant, lid]) await sluit(s);
}

// ── Vooruitbetaalde kosten ──────────────────────────────────────────────────

/** Naar de pagina Vooruitbetaald; de kop heet "Vooruitbetaalde kosten", het menu korter. */
async function naarVooruitbetaald(scherm) {
  const page = scherm.page;
  await sluitAlles(scherm);
  const knop = page.locator('.nav-submenu-finance button').filter({ hasText: /^Vooruitbetaald$/ });
  if (!(await knop.isVisible().catch(() => false))) {
    await page.locator('.sidebar-nav .nav-item').filter({ hasText: /^Financiën/ }).first().click();
  }
  await knop.click();
  await rustig(scherm);
  await inhoud(page).locator('h2').filter({ hasText: /^Vooruitbetaalde kosten$/ }).first().waitFor({ timeout: 15000 });
}

const VERZEKERING = 'Bedrijfsaansprakelijkheidsverzekering UI';

/**
 * Waarom in de browser: de boekingen zelf toetst run.mjs (scenario
 * vooruitbetaald). Hier gaat het om de vraag zoals hij gesteld werd: € 1.000
 * verzekering met drie jaar dekking, via het formulier. Klopt het voorbeeld
 * vóór het vastleggen, roept de knop de drie functies aan, staat daarna het
 * schema in het venster en de post in de lijst, en loopt tegenboeken in het
 * Grootboek terug naar het schema?
 */
async function scenarioVooruitbetaald() {
  groep('UI: vooruitbetaalde kosten — € 1.000 verzekering over 36 maanden');
  const { w } = t;
  const klaar = await stap('rekeningschema', async () => {
    gelukt(await rpc('ensure_default_ledger_accounts', { p_organization_id: w.orgId }, w.medewerker.token), 'rekeningschema');
    return true;
  });
  if (!klaar) return;

  const post = await uiStap('het formulier toont 28 × € 27,78 en 8 × € 27,77, en boekt naar de balans en deze maand naar de kosten', async () => {
    const lid = await medewerker();
    const page = lid.page;
    // De app laadde misschien vóór het rekeningschema bestond.
    await ververs(lid);
    await naarVooruitbetaald(lid);
    await inhoud(page).getByRole('button', { name: 'Vooruitbetaling vastleggen' }).click();
    const m = modal(page, 'Vooruitbetaling vastleggen');
    await m.waitFor({ timeout: 10000 });
    await veld(m, 'Omschrijving').locator('input').fill(VERZEKERING);
    await veld(m, 'Bedrag (excl. btw)').locator('input').fill('1000');
    await veld(m, 'Looptijd (maanden)').locator('input').fill('36');
    const voorbeeld = tekst(await m.locator('.bk-prepaid-preview').innerText());
    verwacht(voorbeeld.includes('€ 27,78 per maand (28×) en € 27,77 (8×)'), `voorbeeld: ${voorbeeld}`);
    verwacht(voorbeeld.includes('Vooruitbetaalde kosten (nieuw)') && voorbeeld.includes('1100 · Bank'), `voorbeeld noemt de rekeningen niet: ${voorbeeld}`);
    gelijk(await m.locator('.bk-prepaid-schedule tbody tr').count(), 36, 'het voorbeeldschema');
    const sinds = server.verkeer.length;
    const dialogen = lid.dialogen.length;
    await klik(m.locator('.modal-foot'), 'Vastleggen en boeken');
    await wachtTot(() => lid.dialogen.length > dialogen, { melding: 'geen bevestigingsvraag vóór het boeken' });
    const vraag = tekst(lid.dialogen.at(-1).tekst);
    verwacht(vraag.includes('€ 1.000,00 naar de balans') && vraag.includes('1 termijn'), `de vraag: ${vraag}`);
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'save_prepaid_expense' }, 'vastleggen');
    verwachtAanroep(sinds, { rpc: 'book_prepaid_expense_start' }, 'naar de balans');
    verwachtAanroep(sinds, { rpc: 'post_prepaid_releases' }, 'de termijn van deze maand');
    const rijDb = sqlRij(`select id, amount_cents, months, status, start_journal_entry_id from public.prepaid_expenses
      where organization_id = ${q(w.orgId)} and description = ${q(VERZEKERING)}`);
    gelijk([rijDb?.amount_cents, rijDb?.months, rijDb?.status, Boolean(rijDb?.start_journal_entry_id)], [100000, 36, 'active', true], 'de post in de database');
    const termijnen = sqlRijen(`select status from public.prepaid_expense_releases where prepaid_expense_id = ${q(rijDb.id)} order by period_index`);
    gelijk([termijnen.length, termijnen.filter((r) => r.status === 'posted').length], [36, 1], 'het schema in de database');
    // Het venster blijft open, nu met de naam van de post als titel: de
    // kerncijfers, de balansrekening die nu bestaat, en het echte schema.
    const venster = modal(page, VERZEKERING);
    await venster.waitFor({ timeout: 10000 });
    await wachtTot(async () => (await venster.locator('.bk-prepaid-sched .status-pill', { hasText: 'Geboekt' }).count()) === 1, { melding: 'het schema in het venster toont geen geboekte termijn' });
    const kerncijfers = tekst(await venster.locator('.bk-asset-kpis').innerText());
    verwacht(kerncijfers.includes('€ 27,78') && kerncijfers.includes('€ 972,22'), `kerncijfers: ${kerncijfers}`);
    gelijk(tekst(await veld(venster, 'Balansrekening').locator('.select-value').innerText()), '1350 · Vooruitbetaalde kosten', 'de balansrekening na vastleggen');
    verwacht(await venster.locator('.bk-dispose').isVisible(), 'geen blok Eerder stoppen');
    await schermafdruk('vooruitbetaald-venster', lid);
    await sluitModal(venster);
    const lijst = tekst(await inhoud(page).locator('.bk-prepaid-list tbody tr').filter({ hasText: VERZEKERING }).first().innerText());
    verwacht(lijst.includes('€ 972,22') && lijst.includes('Loopt'), `de rij in de lijst: ${lijst}`);
    return rijDb;
  });

  await uiStap('in het Grootboek: de twee boekstukken, en Tegenboeken zet de termijn terug in het schema', async () => {
    const id = post?.id;
    verwacht(id, 'overgeslagen: de post ontbreekt');
    const lid = t.lid;
    const page = lid.page;
    await naarFinancien(lid, 'Grootboek');
    await inhoud(page).locator('.bk-entry').filter({ hasText: `Vooruitbetaald naar de balans: ${VERZEKERING}` }).first().waitFor({ timeout: 10000 });
    const termijn = inhoud(page).locator('.bk-entry').filter({ hasText: `Vooruitbetaalde kosten 1/36: ${VERZEKERING}` }).first();
    await termijn.waitFor({ timeout: 10000 });
    const sinds = server.verkeer.length;
    await termijn.getByRole('button', { name: 'Tegenboeken' }).click();
    const m = modal(page, /tegenboeken$/);
    await m.waitFor({ timeout: 10000 });
    await klik(m.locator('.modal-foot'), 'Tegenboeken');
    await m.waitFor({ state: 'detached', timeout: 10000 });
    await rustig(lid);
    verwachtAanroep(sinds, { rpc: 'reverse_journal_entry' }, 'tegenboeken');
    gelijk(sqlRij(`select status from public.prepaid_expense_releases where prepaid_expense_id = ${q(id)} and period_index = 1`).status, 'scheduled', 'de termijn staat weer gepland');
    // En weer terug naar de pagina: de termijn staat klaar om te boeken.
    await naarVooruitbetaald(lid);
    await inhoud(page).locator('.bk-prepaid-due').waitFor({ timeout: 10000 });
    const balk = tekst(await inhoud(page).locator('.bk-prepaid-due').innerText());
    verwacht(/1 termijn staat klaar/.test(balk) && balk.includes('€ 27,78'), `de balk: ${balk}`);
  });

  await uiStap('vanuit het journaal opent de knop Vooruitbetaald hetzelfde formulier', async () => {
    const lid = t.lid;
    const page = lid.page;
    await naarFinancien(lid, 'Grootboek');
    await inhoud(page).locator('.bk-subhead').getByRole('button', { name: 'Vooruitbetaald' }).click();
    const m = modal(page, 'Vooruitbetaling vastleggen');
    await m.waitFor({ timeout: 10000 });
    verwacht(await veld(m, 'Looptijd (maanden)').isVisible(), 'het formulier is niet compleet');
    await sluitModal(m);
  });

  await uiStap('de lezer ziet de post, maar kan niets vastleggen of boeken', async () => {
    const lezer = await openWerkruimte(w.lezer, 'lezer', w.orgId, { tijdelijk: true });
    const page = lezer.page;
    await naarVooruitbetaald(lezer);
    verwacht(!(await inhoud(page).getByRole('button', { name: 'Vooruitbetaling vastleggen' }).isEnabled()), 'de lezer kan een vooruitbetaling vastleggen');
    gelijk(await inhoud(page).locator('.bk-prepaid-due').count(), 0, 'de balk met Alles boeken voor de lezer');
    await inhoud(page).locator('.bk-prepaid-list tbody tr').filter({ hasText: VERZEKERING }).first().click();
    const m = modal(page, VERZEKERING);
    await m.waitFor({ timeout: 10000 });
    gelijk(await knoppen(m.locator('.modal-foot')), ['Sluiten'], 'knoppen voor de lezer');
    gelijk(await m.locator('.bk-dispose').count(), 0, 'Eerder stoppen voor de lezer');
  });
}

// ── Galerij: dubbele bestanden ──────────────────────────────────────────────

// Een echte PNG van 1×1: de browser maakt er zelf een preview en miniatuur van.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/**
 * De media-worker van de galerij. In de UI-test is er geen echte worker; hier
 * krijgt een upload een sleutel zoals de echte worker hem maakt
 * (<organisatie>/gallery/<album>/<item>/<variant>-…), zodat de database hem
 * accepteert. `geupload` houdt bij onder welke naam elk bestand binnenkwam.
 * Op de context, vóór de app laadt: die vraagt bij het openen van het album
 * meteen een kijktoken.
 */
async function nepGalerijWerker(context, geupload, opgeruimd = []) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  await context.route(/\/__media\/gallery\//, async (route) => {
    const verzoek = route.request();
    if (verzoek.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const pad = new URL(verzoek.url()).pathname.replace(/^.*\/__media/, '');
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (pad === '/gallery/view-session') return json({ mediaToken: 'nep-token', streamTokens: {}, exp: Date.now() + 3600_000 });
    if (pad === '/gallery/purge') {
      // Welk album de app liet opruimen (de echte worker veegt dan R2 en Stream).
      let body = null; try { body = verzoek.postDataJSON(); } catch { /* geen json */ }
      opgeruimd.push(body?.galleryId ?? null);
      return json({ ok: true });
    }
    if (pad === '/gallery/upload') {
      const kop = verzoek.headers();
      const naam = decodeURIComponent(kop['x-file-name'] ?? 'bestand');
      const bytes = verzoek.postDataBuffer() ?? Buffer.alloc(0);
      const sleutel = `${kop['x-organization-id']}/gallery/${kop['x-gallery-id']}/${kop['x-item-id']}/${kop['x-variant']}-${randomUUID()}-${naam.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
      geupload.push({ naam, variant: kop['x-variant'] });
      return json({ ok: true, key: sleutel, size: bytes.length });
    }
    if (pad.startsWith('/gallery/file/')) return route.fulfill({ status: 200, contentType: 'image/png', headers: cors, body: PNG });
    return route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: 'Route not found' }) });
  });
}

async function scenarioGalerij() {
  groep('UI: galerij — dubbele bestanden');
  const { w } = t;
  const klaar = await stap('een album met taart.png', async () => {
    const project = gelukt(await rest('projects?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantA.id, name: `Bruiloft ${randomUUID().slice(0, 6)}` },
    }), 'project')[0];
    const album = gelukt(await rest('galleries?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, project_id: project.id, title: 'Ceremonie', format: 'photo' },
    }), 'album')[0];
    gelukt(await rest('gallery_items', {
      method: 'POST', token: w.medewerker.token,
      body: { organization_id: w.orgId, gallery_id: album.id, media_type: 'photo', file_name: 'taart.png', content_type: 'image/png', size_bytes: PNG.length },
    }), 'taart.png');
    return { project, album };
  });
  if (!klaar) return;
  const { project, album } = klaar;
  // In JavaScript gesorteerd, niet in de database: die sorteert volgens zijn
  // collatie, en dan hing de verwachting af van de locale van de stack.
  const namen = () => sqlRijen(`select file_name from public.gallery_items where gallery_id = ${q(album.id)}`).map((r) => r.file_name).sort();
  const png = (name) => ({ name, mimeType: 'image/png', buffer: PNG });
  let lid = null;
  const geupload = [];
  const opgeruimd = [];
  const paneelInvoer = () => lid.page.locator('article.gal-detail > input[type="file"]');
  const vraag = () => lid.page.getByRole('dialog').filter({ has: lid.page.locator('#gal-dup-title') });
  const melding = () => lid.page.locator('article.gal-detail .gal-notice');

  await uiStap('één dubbel bestand: de vraag noemt de nieuwe naam; "Andere naam" uploadt als taart-2.png', async () => {
    lid = await openWerkruimte(w.medewerker, 'galerij', w.orgId, {
      tabblad: { page: 'gallery', projectId: project.id, clientId: null, statsReportId: null, galleryId: album.id },
      voor: (context) => nepGalerijWerker(context, geupload, opgeruimd),
    });
    await lid.page.locator('article.gal-detail').waitFor({ timeout: 30000 });
    await rustig(lid);
    await paneelInvoer().setInputFiles([png('taart.png'), png('nieuw.png')]);
    await vraag().waitFor({ timeout: 10000 });
    const inhoudVraag = tekst(await vraag().innerText());
    verwacht(inhoudVraag.includes('Dit bestand is dubbel'), `titel: ${inhoudVraag}`);
    verwacht(inhoudVraag.includes('Waarschijnlijk hetzelfde bestand'), `even groot: ${inhoudVraag}`);
    verwacht(inhoudVraag.includes('taart-2.png'), `nieuwe naam ontbreekt: ${inhoudVraag}`);
    verwacht(inhoudVraag.includes('Het andere bestand wordt gewoon geüpload'), `de rest: ${inhoudVraag}`);
    gelijk(geupload.length, 0, 'er is al iets geüpload vóór de keuze');
    await vraag().getByRole('button', { name: 'Andere naam en uploaden' }).click();
    await wachtTot(() => namen().length === 3, { melding: `niet geüpload: ${namen().join(', ')}` });
    gelijk(namen(), ['nieuw.png', 'taart-2.png', 'taart.png'].sort(), 'het album');
    verwacht(geupload.some((u) => u.variant === 'original' && u.naam === 'taart-2.png'), `R2 kreeg niet de nieuwe naam: ${JSON.stringify(geupload)}`);
    await wachtTot(async () => tekst(await melding().innerText().catch(() => '')).includes('1 bestand kreeg een nieuwe naam'), { melding: 'geen melding over de nieuwe naam' });
  });

  await uiStap('"Overslaan": alleen het nieuwe bestand komt erbij', async () => {
    if (!lid) throw new Error('de vorige stap opende de galerij niet');
    await paneelInvoer().setInputFiles([png('taart.png'), png('nog-een.png')]);
    await vraag().waitFor({ timeout: 10000 });
    await vraag().getByRole('button', { name: 'Overslaan', exact: true }).click();
    await wachtTot(() => namen().length === 4, { melding: `niet geüpload: ${namen().join(', ')}` });
    gelijk(namen(), ['nieuw.png', 'nog-een.png', 'taart-2.png', 'taart.png'].sort(), 'het album');
    await wachtTot(async () => tekst(await melding().innerText().catch(() => '')).includes('1 dubbel bestand overgeslagen'), { melding: 'geen melding over het overslaan' });
  });

  await uiStap('meer dubbele bestanden: eerst kiezen; Escape stopt de upload en er komt niets bij', async () => {
    if (!lid) throw new Error('de vorige stap opende de galerij niet');
    const voor = geupload.length;
    await paneelInvoer().setInputFiles([png('taart.png'), png('nieuw.png'), png('TAART.PNG')]);
    await vraag().waitFor({ timeout: 10000 });
    verwacht(tekst(await vraag().innerText()).includes('3 bestanden zijn dubbel'), 'titel bij drie');
    const knop = vraag().getByRole('button', { name: 'Nog 3 te kiezen' });
    verwacht(await knop.isDisabled(), 'uploaden kon al zonder keuze');
    await lid.page.keyboard.press('Escape');
    await vraag().waitFor({ state: 'detached', timeout: 10000 });
    await wachtTot(async () => tekst(await melding().innerText().catch(() => '')).includes('Upload gestopt'), { melding: 'geen melding na Escape' });
    gelijk(namen().length, 4, 'rijen na Escape');
    gelijk(geupload.length, voor, 'uploads na Escape');
  });

  await uiStap('per bestand kiezen: alles een andere naam, één toch overslaan', async () => {
    if (!lid) throw new Error('de vorige stap opende de galerij niet');
    await paneelInvoer().setInputFiles([png('taart.png'), png('nieuw.png'), png('TAART.PNG')]);
    await vraag().waitFor({ timeout: 10000 });
    await vraag().getByRole('button', { name: 'Alles een andere naam' }).click();
    await vraag().getByRole('radiogroup', { name: 'Wat moet er met nieuw.png gebeuren?' }).getByRole('radio', { name: 'Overslaan' }).click();
    const inhoudVraag = tekst(await vraag().innerText());
    verwacht(inhoudVraag.includes('taart-3.png') && inhoudVraag.includes('TAART-4.PNG'), `nieuwe namen: ${inhoudVraag}`);    await vraag().getByRole('button', { name: '2 bestanden uploaden' }).click();
    await wachtTot(() => namen().length === 6, { melding: `niet geüpload: ${namen().join(', ')}` });
    gelijk(namen(), ['nieuw.png', 'nog-een.png', 'taart-2.png', 'TAART-4.PNG', 'taart-3.png', 'taart.png'].sort(), 'het album');
    await wachtTot(async () => {
      const m = tekst(await melding().innerText().catch(() => ''));
      return m.includes('1 dubbel bestand overgeslagen') && m.includes('2 bestanden kregen een nieuwe naam');
    }, { melding: 'melding na per bestand kiezen' });
  });

  await uiStap('vanuit het venster "Bestanden": de vraag staat erboven, en Escape sluit alleen de vraag', async () => {
    if (!lid) throw new Error('de vorige stap opende de galerij niet');
    // Sinds 15 november onder Ordenen, in plaats van een eigen knop in de werkbalk.
    await lid.page.locator('article.gal-detail').getByRole('button', { name: /^Ordenen/ }).click();
    await lid.page.locator('article.gal-detail').getByRole('menuitem', { name: /^Categorieën en bestanden/ }).click();
    const venster = lid.page.getByRole('dialog', { name: 'Galerij-instellingen' });
    await venster.waitFor({ timeout: 10000 });
    await venster.locator('input[type="file"]').setInputFiles([png('taart.png')]);
    await vraag().waitFor({ timeout: 10000 });
    // Wat ligt er bovenop, midden in de vraag? Dat moet de vraag zelf zijn.
    const bovenop = await vraag().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return Boolean(hit && el.contains(hit));
    });
    verwacht(bovenop, 'de vraag ligt achter het venster "Bestanden"');
    // Het venster luistert zelf ook naar Escape; die toets is hier voor de vraag.
    await lid.page.keyboard.press('Escape');
    await vraag().waitFor({ state: 'detached', timeout: 10000 });
    await slaap(300);
    verwacht(await venster.isVisible(), 'het venster "Bestanden" ging mee dicht');
    gelijk(namen().length, 6, 'rijen');
    await venster.getByRole('button', { name: 'Sluiten' }).first().click();
    await venster.waitFor({ state: 'detached', timeout: 5000 });
  });

  // ── Publiceren en delen op het eigen webadres (14 november) ───────────────
  // Zoals op staging: CLIENT_DOMAINS_LIVE=albums. De deellink van een album
  // gaat dan naar het webadres van de organisatie (jansen.resofly.com), de
  // rest nog naar het adres van de app. Het overzicht van client-domains leest
  // de schakelaar bij elk verzoek; de app vraagt het pas als Delen opengaat.
  groep('UI: galerij — publiceren en delen op het eigen webadres');
  const vroegerLive = process.env.CLIENT_DOMAINS_LIVE;
  process.env.CLIENT_DOMAINS_LIVE = 'albums';
  let deellink = null;
  try {
    await uiStap('publiceren, dan Delen → "Deellink maken": de link staat op het webadres van de organisatie', async () => {
      if (!lid) throw new Error('de vorige stappen openden de galerij niet');
      const naam = sqlRij(`select name from public.client_subdomains where organization_id = ${q(w.orgId)} and status = 'active'`)?.name;
      verwacht(naam, 'de organisatie heeft geen webadres');
      const kop = lid.page.locator('article.gal-detail');
      await kop.getByRole('button', { name: 'Publiceren', exact: true }).click();
      await wachtTot(() => sqlRij(`select status from public.galleries where id = ${q(album.id)}`)?.status === 'published', { melding: 'het album werd niet gepubliceerd' });
      await kop.getByRole('button', { name: 'Delen', exact: true }).click();
      const venster = lid.page.getByRole('dialog', { name: 'Galerij delen' });
      await venster.waitFor({ timeout: 10000 });
      await venster.getByRole('button', { name: 'Deellink maken' }).click();
      const link = venster.locator('.gal-share-url code');
      deellink = await wachtTot(async () => {
        const waarde = tekst(await link.innerText().catch(() => ''));
        return /\/gallerij\/[A-Za-z0-9_-]{20,}$/.test(waarde) ? waarde : null;
      }, { melding: 'geen deellink in het venster' });
      verwacht(deellink.startsWith(`https://${naam}.${KLANTADRES_BASIS}/gallerij/`), `de link staat niet op het webadres: ${deellink}`);
      verwacht(tekst(await venster.innerText()).includes('De link staat op je eigen webadres'), 'de uitleg bij de link ontbreekt');
      // De link hoort bij dit album: in de database staat de hash van het token uit de link.
      const token = deellink.split('/gallerij/')[1];
      gelijk(sqlRij(`select share_token_hash from public.galleries where id = ${q(album.id)}`)?.share_token_hash,
        createHash('sha256').update(token).digest('hex'), 'de hash van de link');
      // Kopiëren kan pas als de link er staat; hij staat er nu.
      verwacht(await venster.getByRole('button', { name: /Kopiëren/ }).isEnabled(), 'kopiëren staat uit');
      // Twee knoppen heten Sluiten (het kruisje en die onderaan); allebei goed.
      await venster.getByRole('button', { name: 'Sluiten', exact: true }).last().click();
      await venster.waitFor({ state: 'detached', timeout: 5000 });
    });

    await uiStap('de klant opent de link op het webadres: het album, via dat adres', async () => {
      if (!deellink) throw new Error('de vorige stap maakte geen deellink');
      const klant = await openOpKlantadres(deellink, 'klant-album', { tijdelijk: true, voor: (context) => nepGalerijWerker(context, []) });
      await klant.page.locator('main.pgal').first().waitFor({ timeout: 20000 });
      await wachtTot(async () => tekst(await klant.page.locator('main.pgal').innerText()).includes('Ceremonie'), { melding: 'het album verscheen niet' });
      verwacht(new URL(klant.page.url()).hostname === new URL(deellink).hostname, `de klant kwam ergens anders uit: ${klant.page.url()}`);
      // De pagina vroeg het album op bij gallery-public, met het webadres als herkomst.
      const verzoek = klant.api.find((r) => r.pad === '/functions/v1/gallery-public' && r.actie === 'getGallery');
      verwacht(verzoek, 'de pagina vroeg het album niet op');
      gelijk([verzoek.status, verzoek.kop.origin], [200, new URL(deellink).origin], 'gallery-public');
      verwacht(klant.doorgestuurd.length === 0, `doorgestuurd: ${JSON.stringify(klant.doorgestuurd)}`);
    });
  } finally {
    if (vroegerLive === undefined) delete process.env.CLIENT_DOMAINS_LIVE;
    else process.env.CLIENT_DOMAINS_LIVE = vroegerLive;
  }

  // ── Verwijderen vanuit de lijst (15 november) ─────────────────────────────
  // Achter elk album staat een menu met Bewerken en Verwijderen. Verwijderen
  // vraagt altijd eerst, en zegt wat er verdwijnt. Na ja: het album is weg, de
  // database zette de map in de opruimwachtrij, en de app vroeg de worker om
  // R2 en Stream meteen te vegen.
  groep('UI: galerij — verwijderen vanuit de lijst');
  const albumBestaat = () => sqlRij(`select count(*)::int as n from public.galleries where id = ${q(album.id)}`)?.n === 1;
  const rij = () => lid.page.locator('.gal-list-row').filter({ hasText: 'Ceremonie' });
  const venster = () => lid.page.getByRole('alertdialog', { name: 'Album verwijderen?' });
  async function vraagVerwijderen() {
    await rij().getByRole('button', { name: 'Opties voor Ceremonie' }).click();
    await lid.page.getByRole('menuitem', { name: /^Verwijderen/ }).click();
    await venster().waitFor({ timeout: 10000 });
  }

  await uiStap('het menu achter een album: Verwijderen vraagt eerst, en Annuleren laat alles staan', async () => {
    if (!lid) throw new Error('de vorige stappen openden de galerij niet');
    await lid.page.locator('article.gal-detail .gal-crumb').click();
    await rij().waitFor({ timeout: 10000 });
    // Bewerken opent het album met de instellingen erop.
    await rij().getByRole('button', { name: 'Opties voor Ceremonie' }).click();
    await lid.page.getByRole('menuitem', { name: /^Bewerken/ }).click();
    const instellingen = lid.page.getByRole('dialog', { name: 'Galerij-instellingen' });
    await instellingen.waitFor({ timeout: 10000 });
    await instellingen.getByRole('button', { name: 'Sluiten' }).first().click();
    await instellingen.waitFor({ state: 'detached', timeout: 5000 });
    await lid.page.locator('article.gal-detail .gal-crumb').click();
    await rij().waitFor({ timeout: 10000 });

    await vraagVerwijderen();
    const inhoud = await wachtTot(async () => {
      const t = tekst(await venster().innerText());
      return t.includes('6 bestanden') ? t : null;
    }, { melding: 'het venster noemt niet hoeveel bestanden er weggaan' });
    verwacht(inhoud.includes('ook uit de opslag bij Cloudflare'), `R2: ${inhoud}`);
    verwacht(inhoud.includes('niet meer in het portaal'), `portaal: ${inhoud}`);
    verwacht(inhoud.includes('De deellink werkt niet meer'), `deellink: ${inhoud}`);
    verwacht(inhoud.includes('niet ongedaan maken'), `onomkeerbaar: ${inhoud}`);
    await venster().getByRole('button', { name: 'Annuleren' }).click();
    await venster().waitFor({ state: 'detached', timeout: 5000 });
    // Escape is ook nee.
    await vraagVerwijderen();
    await lid.page.keyboard.press('Escape');
    await venster().waitFor({ state: 'detached', timeout: 5000 });
    await slaap(300);
    verwacht(albumBestaat(), 'het album is weg na annuleren');
    gelijk(opgeruimd.length, 0, 'opruimverzoeken na annuleren');
  });

  await uiStap('"Album verwijderen": weg uit de lijst en de database, en de map gaat uit R2', async () => {
    if (!lid) throw new Error('de vorige stappen openden de galerij niet');
    await vraagVerwijderen();
    await venster().getByRole('button', { name: 'Album verwijderen' }).click();
    await venster().waitFor({ state: 'detached', timeout: 10000 });
    await wachtTot(() => !albumBestaat(), { melding: 'het album staat nog in de database' });
    await wachtTot(async () => (await rij().count()) === 0, { melding: 'het album staat nog in de lijst' });
    const map = `${w.orgId}/gallery/${album.id}/`;
    const wachtrij = sqlRijen(`select kind, target from public.gallery_purge_queue where gallery_id = ${q(album.id)}`);
    verwacht(wachtrij.some((r) => r.kind === 'folder' && r.target === map), `de map staat niet in de wachtrij: ${JSON.stringify(wachtrij)}`);
    await wachtTot(() => opgeruimd.includes(album.id), { melding: `de worker werd niet gevraagd op te ruimen: ${JSON.stringify(opgeruimd)}` });
  });
}

// ── Prognose ────────────────────────────────────────────────────────────────

/** De maand na deze, als JJJJ-MM (Europe/Amsterdam). */
function volgendeMaand() {
  const [j, m] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date()).split('-').map(Number);
  return m === 12 ? `${j + 1}-01` : `${j}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * Waarom in de browser: de database en de handelingen van de AI toetst run.mjs
 * (scenario prognose). Hier gaat het om de pagina zoals de vraag hem bedoelde:
 * een prognose maken en aanpassen, met Gerrie ernaast. Rekent een aanname
 * meteen door, bewaart de knop precies dat (met de versie als controle), staat
 * elke stand in de geschiedenis, en neemt de pagina een goedgekeurd voorstel
 * van Gerrie over na verversen?
 */
async function scenarioPrognose() {
  groep('UI: prognose — maken, aanpassen, een voorstel van Gerrie, terugzetten');
  const { w } = t;
  const winst = async (scherm) => tekst(await scherm.locator('.fc-kpi').filter({ hasText: 'Winst' }).locator('.sc-val').innerText());

  const basis = await uiStap('een aanname rekent meteen door, en "Bewaren als prognose" legt hem vast', async () => {
    const lid = await medewerker();
    await naarFinancien(lid, 'Prognose');
    const scherm = inhoud(lid.page);
    await scherm.locator('.fc-kpi').first().waitFor({ timeout: 10000 });
    verwacht(tekst(await scherm.locator('.fc-scenarios').innerText()).includes('Automatisch'), 'zonder bewaarde prognose hoort de automatische er te staan');
    const voor = await winst(scherm);
    await scherm.locator('.fc-field[data-field="other_revenue"] input').fill('2500');
    await wachtTot(() => scherm.locator('.fc-dirty').isVisible(), { melding: 'geen balk "Nog niet bewaard"' });
    const balk = tekst(await scherm.locator('.fc-dirty').innerText());
    verwacht(balk.includes('Overige omzet per maand: automatisch → € 2.500'), `de balk: ${balk}`);
    verwacht((await winst(scherm)) !== voor, 'de winst rekende niet door');
    const sinds = server.verkeer.length;
    await scherm.getByRole('button', { name: 'Bewaren als prognose' }).click();
    await rustig(lid);
    verwachtAanroep(sinds, { soort: 'rest', tabel: 'forecasts', methode: 'POST' }, 'Bewaren schreef de prognose niet weg');
    const rij = sqlRij(`select id, name, version, assumptions from public.forecasts where organization_id = ${q(w.orgId)}`);
    gelijk([rij?.name, rij?.version, Number(rij?.assumptions?.other_revenue)], ['Basis', 1, 2500], 'de prognose in de database');
    await wachtTot(async () => tekst(await scherm.locator('.fc-foot').innerText()).includes('Versie 1'), { melding: 'onder de pagina staat geen versie 1' });
    verwacht(!(await scherm.locator('.fc-dirty .fc-dirty-acts').isVisible()), 'na bewaren staat er nog een niet-bewaarde wijziging');
    return rij;
  });

  await uiStap('nog een wijziging: versie 2, en de geschiedenis zegt wat er veranderde', async () => {
    const id = basis?.id;
    verwacht(id, 'overgeslagen: de prognose ontbreekt');
    const scherm = inhoud(t.lid.page);
    await scherm.locator('.fc-field[data-field="growth_pct"] input').fill('12');
    await wachtTot(() => scherm.locator('.fc-dirty .fc-dirty-acts').isVisible(), { melding: 'geen balk "Nog niet bewaard"' });
    const sinds = server.verkeer.length;
    await scherm.locator('.fc-dirty').getByRole('button', { name: 'Bewaren', exact: true }).click();
    await rustig(t.lid);
    verwachtAanroep(sinds, { soort: 'rest', tabel: 'forecasts', methode: 'PATCH' }, 'Bewaren wijzigde de prognose niet');
    gelijk(sqlRij(`select version from public.forecasts where id = ${q(id)}`)?.version, 2, 'versie');
    gelijk(sqlRij(`select change_note from public.forecast_versions where forecast_id = ${q(id)} and version = 2`)?.change_note, 'Groei per jaar: 0% → 12%', 'de geschiedenis');
  });

  await uiStap('een goedgekeurd voorstel van Gerrie staat er na verversen, zonder niet-bewaarde wijziging', async () => {
    const id = basis?.id;
    verwacht(id, 'overgeslagen: de prognose ontbreekt');
    // Wat de uitvoerder na akkoord in de chat doet (src/lib/actions/forecast.ts):
    // dezelfde PATCH als updateForecast(), met de versie van de kaart.
    const nu = sqlRij(`select assumptions from public.forecasts where id = ${q(id)}`).assumptions;
    const post = { id: 'post-1', label: 'Nieuwe medewerker', kind: 'cost', amount: 3500, from: volgendeMaand(), to: null };
    const res = await rest(`forecasts?id=eq.${id}&organization_id=eq.${w.orgId}&version=eq.2&select=version`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation',
      body: { assumptions: { ...nu, items: [post] }, change_note: 'AI-voorstel: Post erbij: Nieuwe medewerker' },
    });
    gelijk(res.json?.[0]?.version, 3, 'het voorstel uitvoeren');
    await ververs(t.lid);
    const scherm = inhoud(t.lid.page);
    await wachtTot(async () => tekst(await scherm.locator('.fc-foot').innerText()).includes('Versie 3'), { melding: 'de pagina toont versie 3 niet' });
    gelijk(await scherm.locator('.fc-item input[aria-label="Naam van de post"]').first().inputValue(), 'Nieuwe medewerker', 'de post in de aannames');
    verwacht(!(await scherm.locator('.fc-dirty .fc-dirty-acts').isVisible()), 'het voorstel staat er als niet-bewaarde wijziging');
  });

  await uiStap('de geschiedenis: versie 1 terugzetten wordt versie 4', async () => {
    const id = basis?.id;
    verwacht(id, 'overgeslagen: de prognose ontbreekt');
    const page = t.lid.page;
    await inhoud(page).locator('.fc-foot').getByRole('button', { name: 'Geschiedenis' }).click();
    const m = modal(page, 'Geschiedenis van Basis');
    await m.waitFor({ timeout: 10000 });
    await wachtTot(async () => (await m.locator('.fc-versions li').count()) === 3, { melding: 'het venster toont geen drie versies' });
    verwacht(tekst(await m.locator('.fc-versions li').first().innerText()).includes('AI-voorstel: Post erbij: Nieuwe medewerker'), 'de nieuwste versie zegt niet dat hij van Gerrie kwam');
    const sinds = server.verkeer.length;
    await m.locator('.fc-versions li').filter({ hasText: 'Versie 1' }).getByRole('button', { name: 'Terugzetten' }).click();
    await m.waitFor({ state: 'detached', timeout: 10000 });
    await rustig(t.lid);
    verwachtAanroep(sinds, { soort: 'rest', tabel: 'forecasts', methode: 'PATCH' }, 'terugzetten');
    const rij = sqlRij(`select version, assumptions from public.forecasts where id = ${q(id)}`);
    gelijk([rij?.version, Number(rij?.assumptions?.other_revenue), Number(rij?.assumptions?.growth_pct ?? 0), (rij?.assumptions?.items ?? []).length], [4, 2500, 0, 0], 'na terugzetten');
    gelijk(sqlRij(`select change_note from public.forecast_versions where forecast_id = ${q(id)} and version = 4`)?.change_note, 'Versie 1 teruggezet', 'de geschiedenis');
  });

  await uiStap('"Pas aan met Gerrie" opent de chat met de vraag over deze prognose', async () => {
    const page = t.lid.page;
    await inhoud(page).locator('.fc-ask-suggest button').first().click();
    const paneel = page.locator('.gerrie-panel');
    await paneel.waitFor({ timeout: 10000 });
    await wachtTot(async () => (await paneel.locator('.gerrie-msg.user .gerrie-bubble').allInnerTexts()).some((regel) => regel.includes('Pas de prognose "Basis" aan: Reken met 10% groei per jaar')),
      { melding: 'de vraag staat niet in de chat' });
    // Het antwoord van Gerrie is hier niet het onderwerp (dat toetst run.mjs via de registry).
    await page.keyboard.press('Escape');
  }, { toegestaan: [{ soort: 'functie', functie: 'gerrie-agent' }], foutmelding: /./ });

  await uiStap('de cashflow: zonder bankrekening onbekend, zelf een banksaldo invullen en bewaren', async () => {
    const id = basis?.id;
    verwacht(id, 'overgeslagen: de prognose ontbreekt');
    const page = t.lid.page;
    const scherm = inhoud(page);
    // Het seizoen staat bij de aannames, ook als er nog geen patroon is (deze
    // wereld heeft maar een paar maanden omzet): dan zegt het waarom.
    verwacht(/twee hele jaren|nog geen omzet/.test(tekst(await scherm.locator('.fc-season-sub').innerText())), 'het seizoensblok zegt niet waarom er geen patroon is');
    await scherm.locator('.fc-views button', { hasText: 'Cashflow' }).click();
    await scherm.locator('.fc-kpi-cash[data-kpi="start"]').waitFor({ timeout: 10000 });
    gelijk(tekst(await scherm.locator('.fc-kpi-cash[data-kpi="start"] .sc-val').innerText()), 'Onbekend', 'banksaldo zonder bankrekening');
    verwacht(tekst(await scherm.locator('.fc-cash-notes').innerText()).includes('weet je banksaldo niet'), 'geen uitleg bij een onbekend banksaldo');
    await scherm.locator('.fc-field[data-field="cash_start"] input').fill('12500');
    await wachtTot(() => scherm.locator('.fc-dirty .fc-dirty-acts').isVisible(), { melding: 'geen balk "Nog niet bewaard"' });
    verwacht(tekst(await scherm.locator('.fc-dirty').innerText()).includes('Banksaldo nu: automatisch → € 12.500'), 'de balk noemt het banksaldo niet');
    await wachtTot(async () => tekst(await scherm.locator('.fc-kpi-cash[data-kpi="start"] .sc-val').innerText()) === '€ 12.500', { melding: 'het kerncijfer rekende niet door' });
    verwacht(await scherm.locator('.fc-cash-table tbody tr').count() >= 2, 'de tabel van de cashflow is leeg');
    const sinds = server.verkeer.length;
    await scherm.locator('.fc-dirty').getByRole('button', { name: 'Bewaren', exact: true }).click();
    await rustig(t.lid);
    verwachtAanroep(sinds, { soort: 'rest', tabel: 'forecasts', methode: 'PATCH' }, 'Bewaren wijzigde de prognose niet');
    const rij = sqlRij(`select version, assumptions from public.forecasts where id = ${q(id)}`);
    gelijk([rij?.version, Number(rij?.assumptions?.cash_start)], [5, 12500], 'het banksaldo in de database');
    // Terug naar het resultaat: de stappen hierna kijken daar.
    await scherm.locator('.fc-views button', { hasText: 'Resultaat' }).click();
  });

  await uiStap('de lezer ziet de prognose, maar kan niets wijzigen of Gerrie vragen', async () => {
    const lezer = await openWerkruimte(w.lezer, 'lezer', w.orgId, { tijdelijk: true });
    await naarFinancien(lezer, 'Prognose');
    const scherm = inhoud(lezer.page);
    await scherm.locator('.fc-kpi').first().waitFor({ timeout: 10000 });
    verwacht(tekst(await scherm.locator('.fc-scenarios').innerText()).includes('Basis'), 'de lezer ziet de prognose niet');
    verwacht(await scherm.locator('.fc-field[data-field="growth_pct"] input').isDisabled(), 'de lezer kan een aanname wijzigen');
    gelijk(await scherm.locator('.fc-ask').count(), 0, 'de lezer kan Gerrie vragen de prognose te wijzigen');
    gelijk(await scherm.getByRole('button', { name: /Nieuwe prognose|Verwijderen/ }).count(), 0, 'knoppen om te maken of te verwijderen');
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
    const scenarios = { offerte: scenarioOfferte, factuur: scenarioFactuur, intrekken: scenarioIntrekken, contract: scenarioContract, rollen: scenarioRollen, agenda: scenarioAgenda, mollie: scenarioMollie, documenten: scenarioDocumenten, paginas: scenarioPaginas, paginadrive: scenarioPaginadrive, paginadelen: scenarioPaginadelen, paginaexport: scenarioPaginaexport, bank: scenarioBank, inrichten: scenarioInrichten, opname: scenarioOpname, klantdomein: scenarioKlantdomein, rapportage: scenarioRapportage, tickets: scenarioTickets, vooruitbetaald: scenarioVooruitbetaald, galerij: scenarioGalerij, prognose: scenarioPrognose };
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
