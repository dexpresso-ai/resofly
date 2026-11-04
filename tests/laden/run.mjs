#!/usr/bin/env node
/*
 * Laden per module — `npm run test:loading`
 *
 * De werkruimte laadt bij het opstarten alleen de kern; vijf groepen zware
 * tabellen komen pas als een pagina ze nodig heeft (src/lib/dataGroups.ts).
 * Deze test kijkt in Chromium, tegen de nagebootste backend van de mobiele
 * test (tests/mobile/mock), naar het netwerkverkeer en naar het scherm:
 *
 *   1. elke pagina haalt precies de groepen op die PAGE_DATA_GROUPS noemt, en
 *      niets meer; het dashboard dus niets, op de twee tellingen na;
 *   2. elke pagina toont daarna zichzelf: geen laadmelding, geen foutmelding,
 *      geen JavaScript-fout;
 *   3. een geladen groep wordt bewaard: terug en weer heen haalt hem niet opnieuw;
 *   4. na Verversen is een geladen groep verouderd: de pagina toont meteen wat
 *      er was (geen laadmelding) en haalt de groep op de achtergrond opnieuw op;
 *   5. het ticketvenster laadt zelf de tijdlijn, ook vanaf een pagina zonder;
 *   6. mislukt een groep, dan zegt de pagina dat, en "Opnieuw proberen" laadt
 *      hem alsnog.
 *   7. mislukt het verversen van een groep die al in beeld staat, dan blijft de
 *      pagina staan en zegt een balk het;
 *   8. bij een stroom verversingen lopen de rondes na elkaar, en komt alles binnen.
 *
 * Opties: --url=http://… gebruik een draaiende dev-server.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { installMock, storageScript, seed, SUPABASE_URL } from '../mobile/mock/backend.mjs';
import { DATA_GROUPS, GROUP_FIELDS, PAGE_DATA_GROUPS } from '../../src/lib/dataGroups.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** De tabellen achter elke groep, in de volgorde van GROUP_FIELDS. */
const GROUP_TABLES = {
  time: ['time_entries'],
  communication: ['ticket_notes', 'client_calls'],
  financeHistory: [
    'quote_approval_events', 'quote_email_deliveries', 'quote_versions',
    'invoice_workflow_events', 'invoice_email_deliveries', 'invoice_payment_records', 'invoice_versions',
    'invoice_refunds', 'credit_notes', 'invoice_chargebacks', 'invoice_dunning_notices',
  ],
  bookkeeping: ['journal_entries', 'journal_lines', 'closed_periods', 'fiscal_years', 'fixed_assets', 'asset_depreciations', 'vat_returns'],
  bank: ['bank_accounts', 'bank_statements', 'bank_transactions', 'bank_rules', 'bank_requisitions'],
};
const ALL_GROUP_TABLES = Object.values(GROUP_TABLES).flat();

/** Elke pagina met een eigen behoefte, plus een paar die genoeg hebben aan de kern. */
const PAGES = {
  dashboard: 'dashboard', tickets: 'tickets', clients: 'clients', projects: 'projects', content: 'content',
  time: 'time', calendar: 'calendar', weekplanner: 'weekplanner',
  client: { page: 'client', clientId: seed.clients[0].id },
  project: { page: 'project', projectId: seed.projects[0].id },
  communication: 'communication', quotes: 'quotes', invoices: 'invoices',
  ledger: 'ledger', bank: 'bank', 'vat-returns': 'vat-returns', assets: 'assets', pnl: 'pnl',
};

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));

process.env.VITE_SUPABASE_URL ??= SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY ??= 'mock-anon-key-for-layout-test';
process.env.VITE_R2_WORKER_URL ??= 'https://media.example.test';
let server = null;
let baseUrl = args.url;
if (!baseUrl) {
  server = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'silent', server: { port: 5197, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
}

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? ' ok ' : 'FAIL'} ${label}${!ok && detail ? `  ← ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const sorted = (list) => [...new Set(list)].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Een pagina met een logboek van de groepstabellen die hij opvraagt (GET; tellingen zijn HEAD). */
async function openPage(context, spec, storage = {}) {
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.origin !== SUPABASE_URL || !url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/rest/v1/rpc/')) return;
    const table = url.pathname.slice('/rest/v1/'.length);
    if (ALL_GROUP_TABLES.includes(table)) requests.push({ table, method: req.method() });
  });
  await page.addInitScript(storageScript(spec, storage));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app', { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  // Elke verschijning van de laadmelding in het zichtbare tabblad vastleggen.
  await page.evaluate(() => {
    window.__laadmelding = 0;
    const seen = () => { if (document.querySelector('.content:not([hidden]) .empty[role="status"]')) window.__laadmelding += 1; };
    new MutationObserver(seen).observe(document.body, { childList: true, subtree: true });
  });
  const gets = (table) => requests.filter(r => r.method === 'GET' && (!table || r.table === table));
  return { page, requests, errors, gets };
}

async function screenState(page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content:not([hidden])');
    return {
      loading: Boolean(content?.querySelector('.empty[role="status"]')),
      failed: Boolean(content?.querySelector('.empty[role="alert"]')),
      text: (content?.innerText ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
}

async function idle(page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

/** De knop Ververs in de titelbalk (op desktop staat hij daar, niet in de zijbalk). Tijdens het laden heet hij "Laden…". */
const refreshButton = (page) => page.locator('.topbar .topbar-actions button').first();

/** Navigeren zoals een gebruiker: via het menu. */
async function nav(page, label) {
  await page.locator('.sidebar-nav .nav-item', { hasText: label }).first().click();
  await idle(page);
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESOFLY_CHROMIUM || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  await installMock(context);

  // De tabellenlijst hierboven moet bij de groepen blijven passen.
  for (const group of DATA_GROUPS) {
    check(`groep ${group}: ${GROUP_TABLES[group].length} tabellen voor ${GROUP_FIELDS[group].length} velden`, GROUP_TABLES[group]?.length === GROUP_FIELDS[group].length);
  }

  // ── 1 en 2: per pagina precies de eigen groepen, en daarna de pagina zelf ──
  for (const [key, spec] of Object.entries(PAGES)) {
    const { page, requests, errors, gets } = await openPage(context, spec);
    await idle(page);
    const pageName = typeof spec === 'string' ? spec : spec.page;
    const expected = (PAGE_DATA_GROUPS[pageName] ?? []).flatMap(group => GROUP_TABLES[group]);
    const fetched = gets().map(r => r.table);
    check(`${key}: haalt precies ${expected.length ? (PAGE_DATA_GROUPS[pageName] ?? []).join(' + ') : 'geen groep'} op`, same(fetched, expected),
      `verwacht [${sorted(expected).join(', ')}], kreeg [${sorted(fetched).join(', ')}]`);
    const twice = sorted(fetched.filter((table, i) => fetched.indexOf(table) !== i));
    check(`${key}: elke tabel één keer`, twice.length === 0, `dubbel: ${twice.join(', ')}`);
    if (key === 'dashboard') {
      const heads = requests.filter(r => r.method === 'HEAD').map(r => r.table);
      check('dashboard: telt banktransacties en btw-aangiftes zonder ze te laden', same(heads, ['bank_transactions', 'vat_returns']), `HEAD: [${sorted(heads).join(', ')}]`);
    }
    const state = await screenState(page);
    check(`${key}: toont de pagina (geen laadmelding, geen fout)`, !state.loading && !state.failed && state.text.length > 40, state.loading ? 'nog aan het laden' : state.failed ? 'foutmelding' : `te weinig inhoud: "${state.text.slice(0, 60)}"`);
    check(`${key}: geen JavaScript-fout`, errors.length === 0, errors[0]);
    await page.close();
  }

  // ── 3 en 4: bewaren, verouderen, op de achtergrond verversen ─────────────
  {
    const { page, errors, gets } = await openPage(context, 'dashboard', { 'brandcore.sidebarPinned': '1' });
    await nav(page, 'Uren');
    check('Uren na het dashboard: uren één keer opgehaald', gets('time_entries').length === 1, `${gets('time_entries').length} keer`);
    check('Uren: de pagina staat er', (await screenState(page)).text.includes('Urenregistratie'));
    await nav(page, 'Dashboard');
    await nav(page, 'Uren');
    check('terug naar Uren: niet opnieuw opgehaald (bewaard)', gets('time_entries').length === 1, `${gets('time_entries').length} keer`);
    await nav(page, 'Dashboard');
    const laadmeldingVoor = await page.evaluate(() => window.__laadmelding);
    await refreshButton(page).click();
    await idle(page);
    check('verversen op het dashboard haalt de uren niet op', gets('time_entries').length === 1, `${gets('time_entries').length} keer`);
    await nav(page, 'Uren');
    check('daarna naar Uren: meteen de oude gegevens, geen laadmelding', (await page.evaluate(() => window.__laadmelding)) === laadmeldingVoor);
    check('daarna naar Uren: verouderd, dus op de achtergrond opnieuw opgehaald', gets('time_entries').length === 2, `${gets('time_entries').length} keer`);
    await nav(page, 'Dashboard');
    await nav(page, 'Uren');
    check('en nog eens terug: weer vers, niet opnieuw', gets('time_entries').length === 2, `${gets('time_entries').length} keer`);
    // Verversen óp een pagina met een groep: die groep komt meteen mee.
    await refreshButton(page).click();
    await idle(page);
    check('verversen op Uren: de uren meteen opnieuw', gets('time_entries').length === 3, `${gets('time_entries').length} keer`);
    check('navigeren en verversen: geen JavaScript-fout', errors.length === 0, errors[0]);
    await page.close();
  }

  // ── 5: het ticketvenster laadt zelf de tijdlijn ───────────────────────────
  {
    const { page, errors, gets } = await openPage(context, 'tickets');
    check('Tickets: nog geen tijdlijn opgehaald', gets('ticket_notes').length === 0);
    await page.locator('.content:not([hidden]) .ticket-item').first().click();
    await idle(page);
    check('ticket open: de tijdlijn is opgehaald', gets('ticket_notes').length === 1, `${gets('ticket_notes').length} keer`);
    const timeline = await page.evaluate(() => ({
      shown: Boolean(document.querySelector('.modal .ticket-timeline')),
      waiting: [...document.querySelectorAll('.modal .ticket-timeline-hint')].some(el => el.textContent?.includes('laden')),
    }));
    check('ticket open: de tijdlijn staat er, geen "laden" meer', timeline.shown && !timeline.waiting, JSON.stringify(timeline));
    check('ticketvenster: geen JavaScript-fout', errors.length === 0, errors[0]);
    await page.close();
  }

  // ── 6: een mislukte groep, en opnieuw proberen ────────────────────────────
  {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    let attempts = 0;
    await page.route(`${SUPABASE_URL}/rest/v1/journal_lines**`, async (route) => {
      attempts += 1;
      if (attempts === 1) {
        // 500, geen 503: die herhaalt postgrest-js zelf (schema cache nog niet
        // geladen). Dit is een fout die blijft tot iemand het opnieuw probeert.
        await route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ message: 'Tijdelijke storing (test)' }) });
      } else {
        await route.fallback();
      }
    });
    await page.addInitScript(storageScript('ledger'));
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('.app', { timeout: 20000 });
    await idle(page);
    const failedState = await screenState(page);
    check('mislukte groep: de pagina zegt het, met de melding', failedState.failed && failedState.text.includes('Tijdelijke storing (test)'), failedState.text.slice(0, 80));
    await idle(page);
    check('mislukte groep: niet vanzelf opnieuw geprobeerd', attempts === 1, `${attempts} pogingen`);
    await page.locator('.content:not([hidden]) .empty[role="alert"] button', { hasText: 'Opnieuw proberen' }).click();
    await idle(page);
    const retried = await screenState(page);
    check('Opnieuw proberen: de pagina staat er alsnog', attempts === 2 && !retried.failed && !retried.loading && retried.text.length > 40, `${attempts} pogingen, ${retried.failed ? 'nog steeds fout' : retried.loading ? 'laadt nog' : 'ok'}`);
    check('mislukte groep: geen JavaScript-fout', errors.length === 0, errors[0]);
    await page.close();
  }

  // ── 7: verversen mislukt bij een groep die al in beeld staat ─────────────
  {
    const { page, errors } = await openPage(context, 'ledger');
    await idle(page);
    let failing = true;
    await page.route(`${SUPABASE_URL}/rest/v1/journal_lines**`, async (route) => {
      if (failing) await route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ message: 'Tijdelijke storing (test)' }) });
      else await route.fallback();
    });
    await refreshButton(page).click();
    await idle(page);
    const banner = await page.evaluate(() => document.querySelector('.content:not([hidden]) .error')?.textContent ?? '');
    const shown = await screenState(page);
    check('verversen mislukt: de pagina blijft staan met wat er was', !shown.loading && !shown.failed && shown.text.length > 40);
    check('verversen mislukt: een balk zegt het', banner.includes('Bijwerken lukte niet') && banner.includes('Tijdelijke storing (test)'), banner.slice(0, 90));
    failing = false;
    await refreshButton(page).click();
    await idle(page);
    const after = await page.evaluate(() => document.querySelector('.content:not([hidden]) .error')?.textContent ?? '');
    check('daarna Ververs: gelukt, de balk is weg', after === '', after.slice(0, 90));
    check('verversen mislukt: geen JavaScript-fout', errors.length === 0, errors[0]);
    await page.close();
  }

  // ── 8: een stroom verversingen terwijl een groep traag is ─────────────────
  // Rondes die elkaar inhalen en wegstrepen, lieten bij een stroom verversingen
  // (meldingen, Gerrie, afvinklijsten) niets meer binnenkomen. Nu loopt er één
  // ronde tegelijk, met hooguit één erachteraan.
  {
    const { page, errors, gets } = await openPage(context, 'ledger');
    await idle(page);
    await page.route(`${SUPABASE_URL}/rest/v1/journal_lines**`, async (route) => {
      await new Promise(resolve => setTimeout(resolve, 1200));
      await route.fallback();
    });
    const before = gets('journal_lines').length;
    const laadmeldingVoor = await page.evaluate(() => window.__laadmelding);
    for (let i = 0; i < 20; i += 1) {
      await refreshButton(page).click();
      await page.waitForTimeout(250);
    }
    const during = gets('journal_lines').length - before;
    await page.waitForTimeout(3000);
    await idle(page);
    const shown = await screenState(page);
    const label = (await refreshButton(page).textContent()) ?? '';
    check('twintig keer verversen in vijf seconden: rondes lopen na elkaar, niet door elkaar', during >= 2 && during <= 8, `${during} keer journaalregels opgehaald`);
    check('twintig keer verversen: nooit een laadmelding (wat er was, blijft staan)', (await page.evaluate(() => window.__laadmelding)) === laadmeldingVoor);
    check('twintig keer verversen: daarna is alles binnen', !shown.loading && !shown.failed && label.includes('Ververs'), `knop: "${label}"`);
    check('twintig keer verversen: geen JavaScript-fout', errors.length === 0, errors[0]);
    await page.close();
  }

  await context.close();
} finally {
  await browser.close();
  if (server) await server.close();
}

console.log(`\n${failures.length ? `${failures.length} controle(s) mislukt.` : 'Alle controles geslaagd.'}`);
process.exit(failures.length ? 1 : 0);
