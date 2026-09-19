#!/usr/bin/env node
/*
 * Mobiele lay-outtest — `npm run test:mobile`
 *
 * Opent elke pagina van de werkruimte op telefoon- en tabletformaat tegen een
 * nagebootste backend (tests/mobile/mock) en faalt zodra:
 *   1. de pagina een JavaScript-fout gooit;
 *   2. de inhoud horizontaal uit beeld loopt (de pagina of `.content` scrolt zijwaarts);
 *   3. de vaste chrome (titelbalk + werktabs + onderbalk) meer ruimte pakt dan
 *      afgesproken — op de telefoon 112px, op de tablet 100px;
 *   4. het eerste échte item van een pagina (de eerste klant, taak, ticket…)
 *      lager begint dan de grens in FIRST_ITEM. Dat is de meting waar deze
 *      test om bestaat: koppen, knoppenbalken en filters mogen niet weer
 *      langzaam het scherm opeten.
 *
 * Opties:
 *   --theme=dark|light|both     standaard dark
 *   --viewports=phone,tablet    standaard phone,tablet,landscape (ook: desktop)
 *   --pages=dashboard,clients   standaard alle pagina's
 *   --shots=<map>               schrijf per pagina een screenshot weg
 *   --url=http://…              gebruik een draaiende dev-server i.p.v. er zelf een te starten
 *
 * Vereist Chromium van Playwright: `npx playwright install chromium`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { installMock, storageScript, seed } from './mock/backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, maxChrome: 112 },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, maxChrome: 100 },
  // Dezelfde telefoon, gekanteld. Een laag scherm is een ander probleem dan
  // een smal scherm: hier gaat de hoogte op aan koppen en balken, en wat
  // eronder valt is niet te bereiken als de pagina zelf niet mag scrollen.
  landscape: { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, maxChrome: 112 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, maxChrome: 130 },
};

/** Welke pagina's, en met welk tabblad ze openen. */
const PAGES = {
  dashboard: 'dashboard', gerrie: 'gerrie', weekplanner: 'weekplanner', calendar: 'calendar', time: 'time',
  clients: 'clients', client: { page: 'client', clientId: seed.clients[0].id },
  projects: 'projects', project: { page: 'project', projectId: seed.projects[0].id },
  'project-planning': 'project-planning', tickets: 'tickets', chat: 'chat', marketing: 'marketing',
  // Berichten opent mét de filters uitgeklapt. Dat is de stand waarin de balk
  // het hoogst is, en precies daar ging het liggend mis: de lijst werd tot
  // nul samengedrukt achter een rand waar je niet langs kon scrollen.
  communication: { page: 'communication', prepare: '.comm-filter-toggle' },
  content: 'content', notes: 'notes', documents: 'documents', stats: 'stats',
  'clients-table': { page: 'clients', storage: { 'resofly.clients.viewMode': 'table' } },
  'projects-table': { page: 'projects', storage: { 'resofly.projects.viewMode': 'table' } },
  quotes: 'quotes', invoices: 'invoices', contracts: 'contracts', ledger: 'ledger', bank: 'bank', pnl: 'pnl',
  'vat-returns': 'vat-returns', suppliers: 'suppliers', settings: 'settings', 'meeting-booking': 'meeting-booking', archive: 'archive',
  // Wat een klánt op zijn telefoon opent: geen werkruimte-shell, dus geen
  // chrome-grens; wel dezelfde fout- en overloopcontrole.
  'public-quote': { path: '/quote/demo-token' },
  'public-invoice': { path: '/invoice/demo-token' },
  'public-contract': { path: '/contract/demo-token' },
  'public-booking': { path: '/booking/demo-token' },
  'public-share': { path: '/gedeeld/demo-token' },
  'public-gallery': { path: '/gallerij/demo-token' },
  'portal-login': { path: '/portal' },
  portal: { path: '/portal', portal: true },
  login: { path: '/', login: true },
};

/**
 * Het eerste échte item per pagina en hoe laag het hooguit mag beginnen
 * (px vanaf de bovenrand van het scherm). De grenzen liggen zo'n 20% boven
 * de meting van 2026-09-13; een nieuwe kop of knoppenrij erboven trekt de
 * test rood. Alleen voor de telefoon: daar is de ruimte het schaarst.
 *
 * 2026-09-19 — het kruimelpad staat sindsdien boven elke pagina-inhoud en kost
 * op de telefoon 36px (regel van 28px + 8px marge). De grenzen hieronder gingen
 * daarom met datzelfde bedrag omhoog, zodat de speling tegen ongemerkte groei
 * blijft wat hij was. Niet opgehoogd: het dashboard (staat bovenaan het pad en
 * heeft er dus geen), de schermvullende pagina's zonder kruimelpad (agenda,
 * weekplanner, teamchat, Berichten) en alles buiten de werkruimte.
 */
const FIRST_ITEM = {
  dashboard: { selector: '.dash-task', maxTop: 280 },
  // De klantenlijst toont boven de kaarten de tabstrook "Klanten | Niet
  // gekoppeld" zodra er post in de opvangbak ligt — en dat ligt er in de seed
  // (twee berichten). Die strook telde tot 2026-09-17 nooit mee: de mock gaf
  // de teller niet door (content-range viel weg door CORS), dus de strook bleef
  // verborgen. Gemeten mét strook: kaarten 274px, tabel 303px.
  clients: { selector: '.client-card', maxTop: 366 },
  'clients-table': { selector: '.clients-table tbody tr', maxTop: 401 },
  projects: { selector: '.project-list-card', maxTop: 321 },
  'projects-table': { selector: '.projects-table tbody tr', maxTop: 346 },
  marketing: { selector: '.mk-campaign-table tbody tr', maxTop: 366 },
  tickets: { selector: '.ticket-item', maxTop: 356 },
  invoices: { selector: '.quote-table tbody tr', maxTop: 496 },
  quotes: { selector: '.quote-table tbody tr', maxTop: 496 },
  weekplanner: { selector: '.wp-daystrip', maxTop: 600 },
  calendar: { selector: '.tb-scroll', maxTop: 260 },
  time: { selector: '.tt-kpi', maxTop: 396 },
  client: { selector: '.client-tabs-bar', maxTop: 516 },
  project: { selector: '.client-tabs-bar', maxTop: 496 },
  'project-planning': { selector: '.ptl-board', maxTop: 496 },
  content: { selector: '.odrv-tr', maxTop: 336 },
  // Teamchat opent op de telefoon in de gesprekslijst (één venster tegelijk).
  chat: { selector: '.chat-conv', maxTop: 260 },
  // Berichten: idem. De balk met zoeken, filters en tabbladen is in twee
  // stappen gekrompen — eerst door hem bovenaan te zetten en de werkbalk van
  // de app hier weg te laten (206px), daarna door de titel aan de tabstrook
  // over te laten en de filters als paneel te laten zweven (151px). De grens
  // volgt mee, anders meet deze test niets meer.
  communication: { selector: '.comm-row', maxTop: 185 },
  suppliers: { selector: '.supplier-table tbody tr', maxTop: 356 },
  'public-quote': { selector: '.public-lines', maxTop: 560 },
  'public-invoice': { selector: '.public-lines', maxTop: 700 },
  'public-booking': { selector: '.booking-slot', maxTop: 360 },
  portal: { selector: '.portal-row', maxTop: 380 },
};

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const themes = args.theme === 'both' ? ['dark', 'light'] : [args.theme === 'light' ? 'light' : 'dark'];
// Liggend hoort in de standaardronde. De fix van 18 september op Berichten
// voegde het formaat toe aan VIEWPORTS en beschreef het als "in de
// standaardronde", maar deze regel bleef op 'phone,tablet' staan — dus werd de
// band 761-900px nooit gemeten, en dat is precies waar een gekantelde telefoon
// zit: geen smal scherm maar een laag scherm, een heel ander probleem.
const viewports = (args.viewports ?? 'phone,tablet,landscape').split(',').map(v => v.trim()).filter(v => VIEWPORTS[v]);
const pages = args.pages ? args.pages.split(',').map(p => p.trim()).filter(p => PAGES[p]) : Object.keys(PAGES);
const shotsDir = args.shots ? path.resolve(args.shots) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

// ── Dev-server ────────────────────────────────────────────────────────────
process.env.VITE_SUPABASE_URL ??= 'https://example.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY ??= 'mock-anon-key-for-layout-test';
process.env.VITE_R2_WORKER_URL ??= 'https://media.example.test';
let server = null;
let baseUrl = args.url;
if (!baseUrl) {
  server = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'silent', server: { port: 5199, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
}

// ── Meten ─────────────────────────────────────────────────────────────────
const failures = [];
const rows = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.RESOFLY_CHROMIUM || undefined });
try {
  for (const theme of themes) {
    for (const vpName of viewports) {
      const vp = VIEWPORTS[vpName];
      const context = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', colorScheme: theme, reducedMotion: 'reduce' });
      await installMock(context);
      for (const key of pages) {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e.message)));
        const spec = PAGES[key];
        const isPublic = typeof spec === 'object' && spec.path;
        await page.addInitScript(storageScript(spec, { 'resofly.theme': theme, ...(spec.storage ?? {}) }));
        await page.goto(isPublic ? new URL(spec.path, baseUrl).href : baseUrl, { waitUntil: 'networkidle' });
        // Werkruimte: de shell; publieke pagina: de eigen wortel.
        const shell = await page.waitForSelector(isPublic ? '.public-quote-page, .portal, .galv, .login, .pgal' : '.app', { timeout: 20000 }).catch(() => null);
        await page.waitForTimeout(isPublic ? 1200 : 700);
        // Een pagina die pas in een bepaalde stand krap wordt (een uitgeklapt
        // filterpaneel) zet die stand hier zelf aan. Staat de knop er niet op
        // dit formaat, dan gebeurt er niets.
        if (spec.prepare) {
          const knop = page.locator(spec.prepare).first();
          if (await knop.isVisible().catch(() => false)) { await knop.click(); await page.waitForTimeout(250); }
        }
        const m = await page.evaluate((firstSel) => {
          const box = (sel) => { const el = document.querySelector(sel); if (!el) return 0; const cs = getComputedStyle(el); if (cs.display === 'none') return 0; return Math.round(el.getBoundingClientRect().height); };
          const content = document.querySelector('.content:not([hidden])');
          const first = firstSel ? document.querySelector(`.content:not([hidden]) ${firstSel}`) : null;
          return {
            chrome: box('.topbar') + box('.tabbar') + box('.bottomnav'),
            firstTopDoc: (firstSel && document.querySelector(firstSel)) ? Math.round(document.querySelector(firstSel).getBoundingClientRect().top) : null,
            pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
            contentOverflow: content ? content.scrollWidth - content.clientWidth : 0,
            firstTop: first ? Math.round(first.getBoundingClientRect().top) : null,
            // Is het eerste item ook écht te zién? Een kop of filterbalk die
            // te hoog wordt, kan de lijst tot nul samendrukken terwijl er
            // verder niets opvalt: geen fout, geen zijwaartse overloop, en de
            // chrome-meting telt alleen de vaste balken. We scrollen het item
            // dus eerst in beeld (ook binnen een eigen scrollgebied) en
            // knippen zijn rechthoek daarna bij op élke voorouder die
            // afkapt. Blijft er niets over, dan is het item onbereikbaar.
            firstVisible: first ? (() => {
              first.scrollIntoView({ block: 'center', inline: 'nearest' });
              const r = first.getBoundingClientRect();
              let top = r.top;
              let bottom = r.bottom;
              for (let p = first.parentElement; p; p = p.parentElement) {
                const cs = getComputedStyle(p);
                if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
                const pr = p.getBoundingClientRect();
                top = Math.max(top, pr.top);
                bottom = Math.min(bottom, pr.bottom);
              }
              return Math.round(Math.max(0, Math.min(bottom, window.innerHeight) - Math.max(top, 0)));
            })() : null,
          };
        }, FIRST_ITEM[key]?.selector ?? null);
        // Publieke pagina's hebben geen .content-wikkel: meet daar op het document.
        if (isPublic && m.firstTop == null) m.firstTop = m.firstTopDoc;
        const label = `${theme}/${vpName}/${key}`;
        const problems = [];
        if (!shell) problems.push(isPublic ? 'pagina niet gerenderd' : 'app-shell niet gerenderd');
        if (errors.length) problems.push(`js-fout: ${errors[0].slice(0, 90)}`);
        if (m.pageOverflow > 1 || m.contentOverflow > 1) problems.push(`horizontale overloop (${Math.max(m.pageOverflow, m.contentOverflow)}px)`);
        if (m.chrome > vp.maxChrome) problems.push(`chrome ${m.chrome}px > ${vp.maxChrome}px`);
        // Bereikbaarheid geldt op élk formaat — juist liggend, waar de hoogte
        // schaars is, gaat dit mis. 12px is ruim onder een normale regel en
        // ruim boven het gerommel van een afrondingsfout.
        if (FIRST_ITEM[key] && m.firstVisible != null && m.firstVisible < 12) {
          problems.push(`eerste item (${FIRST_ITEM[key].selector}) is weggedrukt: ${m.firstVisible}px zichtbaar`);
        }
        const rule = vpName === 'phone' ? FIRST_ITEM[key] : null;
        if (rule) {
          if (m.firstTop == null) problems.push(`eerste item (${rule.selector}) niet gevonden`);
          else if (m.firstTop > rule.maxTop) problems.push(`eerste item op ${m.firstTop}px > ${rule.maxTop}px`);
        }
        rows.push({ label, chrome: m.chrome, firstTop: m.firstTop, max: rule?.maxTop ?? null, problems });
        if (problems.length) failures.push({ label, problems });
        if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${theme}-${vpName}-${key}.png`) });
        await page.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  if (server) await server.close();
}

// ── Verslag ───────────────────────────────────────────────────────────────
for (const r of rows) {
  const first = r.firstTop == null ? '' : `eerste item ${String(r.firstTop).padStart(4)}px${r.max ? ` (max ${r.max})` : ''}`;
  console.log(`${r.problems.length ? 'FAIL' : ' ok '} ${r.label.padEnd(30)} chrome ${String(r.chrome).padStart(3)}px  ${first}${r.problems.length ? '  ← ' + r.problems.join('; ') : ''}`);
}
console.log(`\n${rows.length} pagina's gemeten, ${failures.length} met problemen.`);
process.exit(failures.length ? 1 : 0);
