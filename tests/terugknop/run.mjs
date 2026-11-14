#!/usr/bin/env node
/*
 * Terugknop — `npm run test:terugknop`
 *
 * De terugknop van Android zette de geïnstalleerde app weg in plaats van
 * terug te gaan (november 2026). Deze test opent de werkruimte op
 * telefoonformaat tegen de nagebootste backend van de mobiele test
 * (tests/mobile/mock) en drukt op terug zoals de browser dat doet
 * (page.goBack, een stap in de browsergeschiedenis). Hij faalt zodra:
 *   1. terug niet naar de vorige pagina gaat, of een venster, menu of
 *      paneel niet sluit;
 *   2. er na terug nog iets in de geschiedenis staat terwijl de app op zijn
 *      begin staat (dan zou de volgende druk niets doen), of er juist niets
 *      meer staat terwijl er nog een stap terug is (dan gaat de app weg);
 *   3. de pagina een JavaScript-fout gooit.
 *
 * Wat deze test niet kan: Chrome op een telefoon slaat items over die zonder
 * tik werden toegevoegd. page.goBack doet dat niet. Daarvoor is
 * src/lib/backButton.test.ts (npm test).
 *
 * Opties:
 *   --url=http://…   gebruik een draaiende dev-server i.p.v. er zelf een te starten
 *   --only=naam      alleen de scenario's waarvan de naam dit bevat
 *
 * Vereist Chromium van Playwright; in een cloudsessie RESOFLY_CHROMIUM=/opt/pw-browsers/chromium.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { installMock, storageScript, seed } from '../mobile/mock/backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));

process.env.VITE_SUPABASE_URL ??= 'https://example.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY ??= 'mock-anon-key-for-layout-test';
process.env.VITE_R2_WORKER_URL ??= 'https://media.example.test';
process.env.VITE_APP_ENV ??= 'staging';
let server = null;
let baseUrl = args.url;
if (!baseUrl) {
  server = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'silent', server: { port: 5197, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESOFLY_CHROMIUM || undefined });
const failures = [];
let passed = 0;

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false };

/** Een telefoon (of computer) met de werkruimte open op `spec` (zoals in tests/mobile). */
async function open(spec, device = PHONE) {
  const context = await browser.newContext({ ...device, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  await installMock(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.addInitScript(storageScript(spec, { 'resofly.theme': 'light' }));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('.app', { timeout: 20000 });
  await page.waitForTimeout(600);
  const cdp = await context.newCDPSession(page);
  const start = (await cdp.send('Page.getNavigationHistory')).currentIndex;
  return { context, page, errors, cdp, start };
}

/** Waar staan we: pagina, open vensters en de plek in de browsergeschiedenis. */
async function where(t) {
  const nav = await t.cdp.send('Page.getNavigationHistory');
  const view = await t.page.evaluate(() => ({
    page: document.querySelector('section.content:not([hidden])')?.dataset.page ?? null,
    tabs: document.querySelectorAll('section.content').length,
    modal: Boolean(document.querySelector('.modal-bg')),
    menu: Boolean(document.querySelector('.znav.is-open')),
    gerrie: Boolean(document.querySelector('.gerrie-panel')),
    commThread: Boolean(document.querySelector('.comm-shell.is-single .comm-back')),
    chatThread: Boolean(document.querySelector('.chat-single .tmc-back')),
    marker: history.state && typeof history.state === 'object' ? history.state.resoflyBack ?? null : null,
  }));
  return { ...view, steps: nav.currentIndex - t.start, url: nav.entries[nav.currentIndex]?.url ?? '' };
}

async function back(t) {
  await t.page.goBack({ waitUntil: 'commit' }).catch(() => null);
  await t.page.waitForTimeout(350);
}

async function tap(t, selector, options = {}) {
  await t.page.locator(selector, options).first().tap();
  await t.page.waitForTimeout(450);
}

/**
 * Wacht tot de stand er is, tot vier seconden, en faalt anders met wat er wél
 * stond. Niet één keer kijken na een vaste wachttijd: op een trage machine (CI)
 * is een stap terug of een nieuw item dan soms nog niet binnen.
 */
async function expectState(t, label, wanted) {
  const deadline = Date.now() + 4000;
  for (;;) {
    // Midden in een laadbeurt (na herladen laadt de app nog een keer) kan
    // meten even mislukken: dan gewoon opnieuw.
    const actual = await where(t).catch(error => ({ error: String(error.message ?? error) }));
    const wrong = Object.entries(wanted).find(([key, value]) => actual[key] !== value);
    if (!wrong) return actual;
    if (Date.now() > deadline) throw new Error(`${label}: ${wrong[0]} is ${JSON.stringify(actual[wrong[0]])}, verwacht ${JSON.stringify(wrong[1])} (${JSON.stringify(actual)})`);
    await t.page.waitForTimeout(100);
  }
}

async function scenario(name, spec, run, device = PHONE) {
  if (args.only && !name.includes(args.only)) return;
  const t = await open(spec, device);
  try {
    await run(t);
    if (t.errors.length) throw new Error(`JavaScript-fout: ${t.errors.join(' | ')}`);
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  ✗   ${name}\n      ${error.message}`);
  } finally {
    await t.context.close();
  }
}

console.log('Terugknop (telefoon, 390×844)');

await scenario('terug gaat langs de pagina’s waar je was', 'dashboard', async (t) => {
  await expectState(t, 'start', { page: 'dashboard', steps: 0, marker: 0 });
  await tap(t, '.bottomnav .bn-item', { hasText: 'Klanten' });
  await tap(t, '.client-card');
  await expectState(t, 'op de klant', { page: 'client', steps: 2 });
  await back(t);
  await expectState(t, 'terug 1', { page: 'clients', steps: 1 });
  await back(t);
  await expectState(t, 'terug 2', { page: 'dashboard', steps: 0, marker: 0 });
  // Op het dashboard is er niets meer: de volgende druk verlaat de app (hier
  // about:blank, op de telefoon het beginscherm). Niets houdt je vast.
  await back(t);
  const left = await t.cdp.send('Page.getNavigationHistory');
  if (left.currentIndex !== t.start - 1) throw new Error(`de app liet niet los: plek ${left.currentIndex}, begin ${t.start}`);
});

await scenario('meerdere keren terug zonder tik ertussen', 'dashboard', async (t) => {
  await tap(t, '.bottomnav .bn-item', { hasText: 'Projecten' });
  await tap(t, '.project-list-card');
  await tap(t, '.bottomnav .bn-item', { hasText: 'Agenda' });
  const before = await t.cdp.send('Page.getNavigationHistory');
  await expectState(t, 'na drie pagina’s', { page: 'calendar', steps: 3 });
  await back(t); await back(t); await back(t);
  await expectState(t, 'drie keer terug', { page: 'dashboard', steps: 0 });
  const after = await t.cdp.send('Page.getNavigationHistory');
  if (after.entries.length !== before.entries.length) throw new Error(`terug zette items neer: ${before.entries.length} → ${after.entries.length}`);
});

await scenario('terug sluit een bewerkvenster, en daarna pas de pagina', 'tickets', async (t) => {
  // Op de titel: midden op de kaart zit de knop "Project maken".
  await tap(t, '.ticket-item .tk-title');
  await expectState(t, 'venster open', { page: 'tickets', modal: true, steps: 2 });
  await back(t);
  await expectState(t, 'venster dicht', { page: 'tickets', modal: false, steps: 1 });
  // Geen geschiedenis, dus omhoog langs het kruimelpad: naar het dashboard.
  await back(t);
  await expectState(t, 'omhoog', { page: 'dashboard', steps: 0 });
});

await scenario('een venster dicht met het kruisje haalt zijn stap weg', 'tickets', async (t) => {
  await tap(t, '.ticket-item .tk-title');
  await tap(t, '.modal-close');
  await expectState(t, 'dicht met het kruisje', { page: 'tickets', modal: false, steps: 1 });
  await back(t);
  await expectState(t, 'terug gaat meteen naar het dashboard', { page: 'dashboard', modal: false, steps: 0 });
});

await scenario('terug sluit het menu; kies je erin, dan gaat terug naar de pagina ervoor', 'dashboard', async (t) => {
  await tap(t, '.mobile-nav-toggle');
  await expectState(t, 'menu open', { menu: true, steps: 1 });
  await back(t);
  await expectState(t, 'menu dicht', { menu: false, page: 'dashboard', steps: 0 });
  await tap(t, '.mobile-nav-toggle');
  await tap(t, '.znav.is-open .zpnav-item', { hasText: seed.projects[0].name });
  await expectState(t, 'project via het menu', { menu: false, page: 'project', steps: 1 });
  await back(t);
  await expectState(t, 'terug', { page: 'dashboard', steps: 0 });
});

await scenario('terug sluit het chatpaneel van Gerrie', 'dashboard', async (t) => {
  await tap(t, '.gerrie-fab');
  await expectState(t, 'Gerrie open', { gerrie: true, steps: 1 });
  await back(t);
  await expectState(t, 'Gerrie dicht', { gerrie: false, page: 'dashboard', steps: 0 });
});

await scenario('na opstarten op een project gaat terug omhoog: Projecten, dan het dashboard', { page: 'project', projectId: seed.projects[0].id }, async (t) => {
  // Nog niet getikt: Chrome zou een item zonder tik overslaan, dus er staat er nog geen.
  await expectState(t, 'opgestart', { page: 'project', steps: 0 });
  // Een tik die niets verandert: op het tabblad dat al openstaat.
  await tap(t, '.tab.active');
  await expectState(t, 'na een tik', { page: 'project', steps: 2 });
  await back(t);
  await expectState(t, 'omhoog 1', { page: 'projects', steps: 1 });
  await back(t);
  await expectState(t, 'omhoog 2', { page: 'dashboard', steps: 0 });
});

await scenario('een nieuw tabblad gaat met terug dicht, en terug gaat daarna verder in het tabblad ervoor', 'clients', async (t) => {
  await tap(t, '.client-card');
  await expectState(t, 'op de klant', { page: 'client', steps: 2 });
  await tap(t, '.tab-new');
  // Het nieuwe tabblad: één stap terug naar het eerste, plus de twee daar.
  await expectState(t, 'nieuw tabblad', { tabs: 2, page: 'dashboard', steps: 3 });
  await back(t);
  await expectState(t, 'tabblad dicht', { tabs: 1, page: 'client', steps: 2 });
  // Zonder tik ertussen: de stappen van het eerste tabblad stonden er al.
  await back(t);
  await expectState(t, 'terug in het eerste tabblad', { tabs: 1, page: 'clients', steps: 1 });
  await back(t);
  await expectState(t, 'en omhoog', { tabs: 1, page: 'dashboard', steps: 0 });
});

await scenario('Berichten: terug gaat van een gesprek naar de lijst', 'communication', async (t) => {
  await tap(t, '.comm-row');
  await expectState(t, 'gesprek open', { page: 'communication', commThread: true, steps: 2 });
  await back(t);
  await expectState(t, 'lijst', { page: 'communication', commThread: false, steps: 1 });
});

await scenario('teamchat: terug gaat van een gesprek naar de lijst', 'chat', async (t) => {
  await tap(t, 'button.tmc-row');
  await expectState(t, 'gesprek open', { page: 'chat', chatThread: true, steps: 2 });
  await back(t);
  await expectState(t, 'lijst', { page: 'chat', chatThread: false, steps: 1 });
});

await scenario('herladen midden in de app: daarna klopt terug weer', 'dashboard', async (t) => {
  await tap(t, '.bottomnav .bn-item', { hasText: 'Klanten' });
  await tap(t, '.client-card');
  await expectState(t, 'op de klant', { steps: 2 });
  await t.page.reload({ waitUntil: 'networkidle' });
  await t.page.waitForSelector('.app', { timeout: 20000 });
  await t.page.waitForTimeout(1200);
  // De items van vóór het herladen horen bij een document dat er niet meer is:
  // de app gaat meteen terug naar het begin (en laadt daarbij één keer extra).
  await expectState(t, 'na herladen', { steps: 0, marker: 0 });
  await tap(t, '.bottomnav .bn-item', { hasText: 'Projecten' });
  await expectState(t, 'verder', { page: 'projects', steps: 1 });
  await back(t);
  await expectState(t, 'terug', { page: 'dashboard', steps: 0 });
});

// Op een computer is de terugknop die van de browser (of de muis). Een menu
// dat sluit bij het indrukken van de muis en een klik die daarna een pagina
// opent: één stap, en terug gaat naar de pagina ervoor.
await scenario('computer: menu dicht bij indrukken, klik opent een pagina', 'dashboard', async (t) => {
  await t.page.locator('.zrail-btn[aria-label="Weergave"]').click({ delay: 120 });
  await t.page.waitForTimeout(400);
  await expectState(t, 'Weergave open', { page: 'dashboard', steps: 1 });
  await t.page.locator('.zrail-btn[aria-label="Instellingen"]').click({ delay: 120 });
  await t.page.waitForTimeout(500);
  await expectState(t, 'Instellingen', { page: 'settings', steps: 1 });
  await back(t);
  await expectState(t, 'terug', { page: 'dashboard', steps: 0 });
}, DESKTOP);

await browser.close();
if (server) await server.close();

console.log(`\n${passed} gelukt, ${failures.length} mislukt`);
if (failures.length) {
  console.log('\nMislukt:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
