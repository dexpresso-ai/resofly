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
 *   --viewports=phone,tablet    standaard phone,tablet (ook: desktop)
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
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, maxChrome: 130 },
};

/** Welke pagina's, en met welk tabblad ze openen. */
const PAGES = {
  dashboard: 'dashboard', gerrie: 'gerrie', weekplanner: 'weekplanner', calendar: 'calendar', time: 'time',
  clients: 'clients', client: { page: 'client', clientId: seed.clients[0].id },
  projects: 'projects', project: { page: 'project', projectId: seed.projects[0].id },
  'project-planning': 'project-planning', tickets: 'tickets', chat: 'chat', marketing: 'marketing',
  content: 'content', notes: 'notes', documents: 'documents', stats: 'stats',
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
 */
const FIRST_ITEM = {
  dashboard: { selector: '.dash-task', maxTop: 280 },
  clients: { selector: '.client-card', maxTop: 320 },
  projects: { selector: '.project-list-card', maxTop: 380 },
  tickets: { selector: '.ticket-item', maxTop: 320 },
  invoices: { selector: '.quote-table tbody tr', maxTop: 460 },
  quotes: { selector: '.quote-table tbody tr', maxTop: 460 },
  weekplanner: { selector: '.wp-daystrip', maxTop: 600 },
  calendar: { selector: '.tb-scroll', maxTop: 260 },
  time: { selector: '.tt-kpi', maxTop: 360 },
  client: { selector: '.client-tabs-bar', maxTop: 480 },
  project: { selector: '.client-tabs-bar', maxTop: 460 },
  'project-planning': { selector: '.ptl-board', maxTop: 460 },
  content: { selector: '.odrv-tr', maxTop: 300 },
  // Teamchat opent op de telefoon in de gesprekslijst (één venster tegelijk).
  chat: { selector: '.chat-conv', maxTop: 260 },
  suppliers: { selector: '.supplier-table tbody tr', maxTop: 320 },
  'public-quote': { selector: '.public-lines', maxTop: 560 },
  'public-invoice': { selector: '.public-lines', maxTop: 700 },
  'public-booking': { selector: '.booking-slot', maxTop: 360 },
  portal: { selector: '.portal-row', maxTop: 380 },
};

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const themes = args.theme === 'both' ? ['dark', 'light'] : [args.theme === 'light' ? 'light' : 'dark'];
const viewports = (args.viewports ?? 'phone,tablet').split(',').map(v => v.trim()).filter(v => VIEWPORTS[v]);
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
        await page.addInitScript(storageScript(spec, { 'resofly.theme': theme }));
        await page.goto(isPublic ? new URL(spec.path, baseUrl).href : baseUrl, { waitUntil: 'networkidle' });
        // Werkruimte: de shell; publieke pagina: de eigen wortel.
        const shell = await page.waitForSelector(isPublic ? '.public-quote-page, .portal, .galv, .login, .pgal' : '.app', { timeout: 20000 }).catch(() => null);
        await page.waitForTimeout(isPublic ? 1200 : 700);
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
