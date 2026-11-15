#!/usr/bin/env node
/*
 * De inrichtingsstappen van een nieuwe organisatie — `npm run test:inrichten`
 *
 * Doorloopt in Chromium, tegen de nagebootste backend (tests/mobile/mock met
 * { onboarding: true }), de stappen zoals een nieuwe gebruiker ze doorloopt
 * (src/features/OrganizationSetup.tsx), en controleert:
 *
 *   1. een nieuwe organisatie opent de stappen, niet de werkruimte;
 *   2. de rechtsvorm staat niet vooraf aangevinkt; een BV zonder zakelijke
 *      module wordt niet opgeslagen, en na het abonnement (testbetaling) en de
 *      module vanzelf vastgelegd;
 *   3. verkeerde bedrijfsgegevens (KvK, postcode, IBAN, e-mail) houden de stap
 *      tegen zonder iets op te slaan; goede worden netjes opgeslagen;
 *   3b. het webadres (2026-11-08): een voorstel uit de handelsnaam, de app zegt
 *      of een naam al bestaat of gereserveerd is, en houdt de stap dan tegen;
 *      typen wordt een geldige naam; de naam ligt vast voor de eigen organisatie;
 *   4. btw, huisstijl (overslaan), facturen via Mollie, en Mollie: een access
 *      token wordt geweigerd vóór hij de deur uit gaat, een test-key gekoppeld,
 *      en de key staat daarna nergens in de opslag van de browser;
 *   5. afronden opent de werkruimte, en de voortgang is opgeruimd;
 *   6. elke schrijfactie gaat naar de eigen organisatie;
 *   7. herladen halverwege: je komt terug waar je was;
 *   8. zonder bedrijfsgegevens (een verse organisatie) maakt de eerste stap ze
 *      aan, met de juiste resultaatrekening;
 *   9. een teamlid ziet het wachtscherm, een beheerder kan Mollie niet koppelen;
 *  10. een database zonder de nieuwe kolom opent gewoon de werkruimte;
 *  11. zonder webadres kun je niet afronden, en "Aanpassen" brengt je erheen;
 *  12. AI (2026-11-15): niets vooraf gekozen. Op desktop "nee": de keuze ligt
 *      vast (set_ai_consent), het uitlezen van inkoopfacturen met AI gaat uit,
 *      en in de werkruimte is Gerrie nergens te zien. Op de telefoon "ja": pas
 *      verder met drie vinkjes, en daarna is Gerrie er. Zonder keuze kun je niet
 *      afronden, en wie al verder was, gaat bij de stap AI verder;
 *  13. ook later kun je kiezen: "Liever geen AI" op de pagina Gerrie haalt
 *      Gerrie overal weg, ook uit het menu; een onthouden tabblad zegt waarom;
 *      onder Instellingen → AI zet je hem weer aan.
 *
 * Opties: --url=http://… (een draaiende dev-server), --shots=<map>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { installMock, storageScript, seed, SUPABASE_URL } from '../mobile/mock/backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORG = seed.ids.ORG;
const PROGRESS_KEY = `resofly.onboarding.${ORG}`;

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const shotsDir = args.shots ? path.resolve(args.shots) : null;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });

process.env.VITE_SUPABASE_URL ??= SUPABASE_URL;
process.env.VITE_SUPABASE_ANON_KEY ??= 'mock-anon-key-for-layout-test';
process.env.VITE_R2_WORKER_URL ??= 'https://media.example.test';
let server = null;
let baseUrl = args.url;
if (!baseUrl) {
  server = await createServer({ configFile: path.join(ROOT, 'vite.config.ts'), root: ROOT, logLevel: 'silent', server: { port: 5195, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0];
}

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? ' ok ' : 'FAIL'} ${label}${!ok && detail ? `  ← ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

async function open(browser, { vp = 'desktop', mock = { onboarding: true }, storage = {}, view = 'dashboard' } = {}) {
  const context = await browser.newContext({ ...VIEWPORTS[vp], locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', reducedMotion: 'reduce' });
  const { setup } = await installMock(context, mock);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.addInitScript(storageScript(view, storage));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  return { context, page, setup, errors };
}

let shotNo = 0;
async function shot(page, name) {
  if (!shotsDir) return;
  shotNo += 1;
  await page.screenshot({ path: path.join(shotsDir, `${String(shotNo).padStart(2, '0')}-${name}.png`), fullPage: false });
}

const title = (page) => page.locator('.onb-title').innerText();
const next = (page) => page.locator('.onb-next');
const choice = (page, label) => page.locator('.onb-choice', { has: page.locator('strong', { hasText: new RegExp(`^${label}$`) }) });
const settingsWrites = (setup) => setup.writes.filter(w => w.table === 'company_settings');
async function waitForTitle(page, pattern, label) {
  try {
    await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.onb-title')?.textContent ?? ''), pattern.source, { timeout: 8000 });
    return true;
  } catch {
    check(label, false, `kop is "${await title(page).catch(() => '?')}"`);
    return false;
  }
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESOFLY_CHROMIUM || undefined });
try {
  // ── 1-6: de hele weg, op desktop en op de telefoon ─────────────────────────
  for (const vp of ['desktop', 'phone']) {
    const { context, page, setup, errors } = await open(browser, { vp });
    const L = (text) => `${vp}: ${text}`;
    await page.waitForSelector('.onb', { timeout: 20000 }).catch(() => null);
    check(L('een nieuwe organisatie opent de stappen'), await page.locator('.onb').count() === 1);
    check(L('de werkruimte staat nog dicht'), await page.locator('.app').count() === 0);
    check(L('welkom'), /Welkom bij/.test(await title(page)));
    await shot(page, `${vp}-welkom`);

    await next(page).click();
    await waitForTitle(page, /rechtsvorm/, L('naar de rechtsvorm'));
    check(L('de rechtsvorm staat niet vooraf aangevinkt'), await page.locator('.onb-choice.is-on').count() === 0);
    check(L('zonder keuze kun je niet verder'), await next(page).isDisabled());
    await choice(page, 'BV').click();
    check(L('een BV vraagt de zakelijke module'), /zakelijke module nodig/.test(await page.locator('.onb-explain').innerText()));
    await shot(page, `${vp}-rechtsvorm`);
    await next(page).click();
    await waitForTitle(page, /zakelijke module/, L('door naar het abonnement'));
    check(L('de BV is nog niet opgeslagen'), !settingsWrites(setup).some(w => w.body?.legal_form === 'bv'));
    check(L('zonder module kun je niet verder'), await next(page).isDisabled());

    await page.getByRole('button', { name: 'Abonnement starten' }).click();
    await page.getByRole('button', { name: 'Testbetaling afronden' }).click();
    await page.locator('.onb-module.is-highlight').getByRole('button', { name: 'Aanzetten' }).click();
    await shot(page, `${vp}-module-bevestigen`);
    await page.getByRole('button', { name: 'Ja, aanzetten' }).click();
    await page.locator('.onb-notice.is-ok', { hasText: 'staat nu als BV' }).waitFor({ timeout: 8000 }).catch(() => null);
    const bvWrite = settingsWrites(setup).find(w => w.body?.legal_form === 'bv');
    check(L('na abonnement en module staat de BV vast'), Boolean(bvWrite), JSON.stringify(setup.writes.map(w => w.table)));
    check(L('met de resultaatrekening van een BV'), bvWrite?.body?.year_result_account_code === '0510');
    check(L('de billing ging via de eigen organisatie'), setup.writes.filter(w => w.table.startsWith('fn/billing/')).every(w => w.body?.organizationId === ORG));
    await shot(page, `${vp}-abonnement`);
    check(L('nu kun je verder'), !(await next(page).isDisabled()));
    await next(page).click();

    await waitForTitle(page, /bedrijfsgegevens/, L('naar de bedrijfsgegevens'));
    const before = settingsWrites(setup).length;
    await page.fill('#onb-f-company_name', '');
    await page.fill('#onb-f-kvk_number', '123');
    await page.fill('#onb-f-postal_code', '34110');
    await page.fill('#onb-f-iban', 'NL91ABNA0417164301');
    await page.fill('#onb-f-email', 'info@');
    await next(page).click();
    const errorFields = await page.locator('.onb-field.has-error').count();
    check(L('verkeerde gegevens staan in het rood'), errorFields >= 5, `${errorFields} velden`);
    check(L('en er is niets opgeslagen'), settingsWrites(setup).length === before);
    await shot(page, `${vp}-bedrijf-fouten`);
    await page.fill('#onb-f-company_name', 'Studio Lopik B.V.');
    await page.fill('#onb-f-trade_name', 'Studio Lopik');
    await page.fill('#onb-f-address_line1', 'Kerkstraat 12');
    await page.fill('#onb-f-postal_code', '3411ab');
    await page.fill('#onb-f-city', 'Lopik');
    await page.fill('#onb-f-email', 'Info@StudioLopik.nl');
    await page.fill('#onb-f-kvk_number', '1234 5678');
    await page.fill('#onb-f-vat_number', 'nl123456789b01');
    await page.fill('#onb-f-iban', 'nl91abna0417164300');
    await page.fill('#onb-f-website', 'javascript:alert(1)');
    await next(page).click();
    check(L('een script-adres als website wordt geweigerd'), await page.locator('#onb-f-website[aria-invalid="true"]').count() === 1);
    await page.fill('#onb-f-website', 'studiolopik.nl');
    await next(page).click();
    await waitForTitle(page, /Je webadres/, L('naar het webadres'));
    const company = settingsWrites(setup).at(-1)?.body ?? {};
    check(L('de bedrijfsgegevens zijn netjes opgeslagen'),
      company.postal_code === '3411 AB' && company.iban === 'NL91 ABNA 0417 1643 00' && company.kvk_number === '12345678'
      && company.vat_number === 'NL123456789B01' && company.email === 'info@studiolopik.nl' && company.website === 'https://studiolopik.nl',
      JSON.stringify(company));
    check(L('alleen de velden van deze stap'), !('legal_form' in company) && !('brand_accent_color' in company) && !('organization_id' in company));

    // Het webadres: een voorstel, en meteen de vraag of het nog vrij is.
    const address = page.locator('#onb-f-address');
    const addressStatus = page.locator('.client-address-status');
    const statusSays = (pattern) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.client-address-status')?.textContent ?? ''), pattern.source, { timeout: 8000 }).then(() => true, () => false);
    check(L('een voorstel uit de handelsnaam'), await address.inputValue() === 'studio-lopik', await address.inputValue());
    check(L('de app zegt dat het voorstel vrij is'), await statusSays(/studio-lopik\.resofly\.com is beschikbaar/), await addressStatus.innerText());
    await address.fill('bestaat-al');
    check(L('een naam die al bestaat, wordt gemeld'), await statusSays(/bestaat al/), await addressStatus.innerText());
    check(L('in het rood'), await page.locator('.client-address-field.has-error').count() === 1);
    check(L('en dan kun je niet verder'), await next(page).isDisabled());
    await shot(page, `${vp}-webadres-bestaat`);
    await address.fill('www');
    check(L('een gereserveerde naam kan niet'), await statusSays(/niet beschikbaar/), await addressStatus.innerText());
    check(L('ook dan niet verder'), await next(page).isDisabled());
    await address.fill('ab');
    check(L('te kort zegt het veld meteen'), await statusSays(/minstens 3 tekens/), await addressStatus.innerText());
    await address.fill('Studio Lopik!');
    check(L('hoofdletters, spaties en tekens worden een geldige naam'), await address.inputValue() === 'studio-lopik', await address.inputValue());
    check(L('en die is vrij'), await statusSays(/is beschikbaar/), await addressStatus.innerText());
    check(L('nu kun je verder'), !(await next(page).isDisabled()));
    check(L('nog niets vastgelegd'), !setup.writes.some(w => w.table === 'rpc/client_subdomain_claim'));
    await shot(page, `${vp}-webadres`);
    await next(page).click();
    await waitForTitle(page, /Btw en boekhouding/, L('naar btw en boekhouding'));
    const claim = setup.writes.find(w => w.table === 'rpc/client_subdomain_claim');
    check(L('het webadres ligt vast voor de eigen organisatie'), setup.subdomain === 'studio-lopik' && claim?.body?.p_organization_id === ORG && claim?.body?.p_name === 'studio-lopik', JSON.stringify(claim?.body));

    await page.getByRole('button', { name: /^1 januari/ }).click();
    await page.fill('#onb-f-rate', '85,50');
    await next(page).click();
    await waitForTitle(page, /huisstijl/, L('naar de huisstijl'));
    const vat = settingsWrites(setup).at(-1)?.body ?? {};
    check(L('btw en boekhouding opgeslagen'), vat.default_hourly_rate_cents === 8550 && /^\d{4}-01-01$/.test(vat.bookkeeping_start_date ?? '') && vat.vat_return_period === 'quarterly' && vat.kor_enabled === false, JSON.stringify(vat));
    await shot(page, `${vp}-huisstijl`);
    const beforeBrand = settingsWrites(setup).length;
    await page.getByRole('button', { name: 'Overslaan' }).click();
    await waitForTitle(page, /facturen/, L('naar facturen versturen'));
    check(L('overslaan slaat niets op'), settingsWrites(setup).length === beforeBrand);

    await choice(page, 'Via Mollie').click();
    await page.getByRole('radio', { name: '30 dagen' }).click();
    await next(page).click();
    await waitForTitle(page, /Mollie koppelen/, L('naar Mollie'));
    const terms = settingsWrites(setup).at(-1)?.body ?? {};
    check(L('verzendwijze en betaaltekst opgeslagen'), setup.settings?.invoice_send_method === 'mollie' && /binnen 30 dagen/.test(terms.invoice_payment_terms ?? ''), JSON.stringify(terms));
    await shot(page, `${vp}-mollie`);

    const mollieCalls = () => setup.writes.filter(w => w.table === 'fn/saveInvoiceMollieKey').length;
    await page.fill('#onb-f-mollie', 'access_abcdefghijklmnopqrstuvwxyz1234');
    await page.getByRole('button', { name: 'Koppelen', exact: true }).click();
    check(L('een access token wordt herkend'), /access token/.test(await page.locator('.onb-notice.is-error').innerText().catch(() => '')));
    check(L('en gaat niet naar de server'), mollieCalls() === 0);
    const secret = 'test_abcdefghijklmnopqrstuvwxyz123456';
    await page.fill('#onb-f-mollie', secret);
    await page.getByRole('button', { name: 'Koppelen', exact: true }).click();
    await page.locator('.onb-notice.is-ok', { hasText: 'Mollie is gekoppeld' }).waitFor({ timeout: 8000 }).catch(() => null);
    check(L('Mollie is gekoppeld, in testmodus'), setup.mollie?.status === 'connected' && setup.mollie?.mode === 'test');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    check(L('de key staat nergens in de opslag van de browser'), !stored.includes('abcdefghijklmnopqrstuvwxyz123456'));
    check(L('en niet meer op het scherm'), !(await page.content()).includes('abcdefghijklmnopqrstuvwxyz123456'));
    await next(page).click();

    // AI: op desktop "nee", op de telefoon "ja".
    const withAi = vp === 'phone';
    await waitForTitle(page, /AI gebruiken/, L('naar de keuze voor AI'));
    check(L('AI: niets vooraf gekozen'), await page.locator('.onb-choice.is-on').count() === 0);
    check(L('AI: zonder keuze kun je niet verder'), await next(page).isDisabled());
    const consentWrites = () => setup.writes.filter(w => w.table === 'rpc/set_ai_consent');
    if (withAi) {
      await choice(page, 'Ja, met Gerrie').click();
      check(L('AI ja: de drie punten staan er'), await page.locator('.onb-ai-points .gaz-point').count() === 3);
      check(L('AI ja: zonder vinkjes niet verder'), await next(page).isDisabled());
      const boxes = page.locator('.onb-ai-points input[type="checkbox"]');
      await boxes.nth(0).check();
      await boxes.nth(1).check();
      check(L('AI ja: met twee vinkjes nog niet'), await next(page).isDisabled());
      await boxes.nth(2).check();
      check(L('AI ja: met drie wel'), !(await next(page).isDisabled()));
    } else {
      await choice(page, 'Nee, zonder AI').click();
      check(L('AI nee: de uitleg noemt het uitlezen van inkoopfacturen'), /inkoopfacturen/.test(await page.locator('.onb-body').innerText()));
      check(L('AI nee: je kunt meteen verder'), !(await next(page).isDisabled()));
    }
    check(L('AI: nog niets opgeslagen voor Volgende'), consentWrites().length === 0);
    await shot(page, `${vp}-ai`);
    await next(page).click();
    await waitForTitle(page, /beginnen/, L('naar klaar'));
    const consent = consentWrites().at(-1)?.body ?? {};
    check(L('AI: de keuze ligt vast voor de eigen organisatie'),
      consent.p_organization_id === ORG && consent.p_enabled === withAi
      && (withAi ? ['gegevens_lezen', 'kan_fouten_maken', 'geen_eigen_beslissingen'].every(k => consent.p_acknowledged?.includes(k)) : true),
      JSON.stringify(consent));
    check(L('AI: één keer opgeslagen'), consentWrites().length === 1);
    const inbox = setup.writes.find(w => w.table === 'rpc/set_purchase_invoice_inbox_settings')?.body ?? {};
    check(L(`AI: het uitlezen van inkoopfacturen ${withAi ? 'blijft aan' : 'gaat uit'}`), inbox.p_organization_id === ORG && inbox.p_patch?.ai_enabled === withAi && setup.inboxAi === withAi, JSON.stringify(inbox));

    const summary = await page.locator('.onb-summary').innerText();
    check(L('het overzicht klopt'), /BV/.test(summary) && /Studio Lopik B\.V\./.test(summary) && /studio-lopik\.resofly\.com/.test(summary) && /Via Mollie/.test(summary) && /Gekoppeld/.test(summary) && (withAi ? /Met Gerrie/ : /Zonder AI/).test(summary), summary.replace(/\s+/g, ' ').slice(0, 300));
    await shot(page, `${vp}-klaar`);
    await next(page).click();
    await page.waitForSelector('.app', { timeout: 15000 }).catch(() => null);
    check(L('afronden opent de werkruimte'), await page.locator('.app').count() === 1 && await page.locator('.onb').count() === 0);
    const done = setup.writes.find(w => w.table === 'rpc/complete_organization_onboarding');
    check(L('afgerond voor de eigen organisatie, met de handelsnaam'), done?.body?.p_organization_id === ORG && done?.body?.p_display_name === 'Studio Lopik', JSON.stringify(done?.body));
    check(L('de voortgang is opgeruimd'), await page.evaluate((key) => localStorage.getItem(key), PROGRESS_KEY) === null);
    // Gerrie: met "ja" de chat rechtsonder, met "nee" nergens, ook niet in het menu.
    await page.waitForTimeout(400);
    const appText = await page.locator('.app').innerText();
    const fab = await page.locator('.gerrie-fab').count();
    if (withAi) {
      check(L('AI ja: Gerrie is er in de werkruimte'), fab === 1, `${fab} chatknoppen`);
    } else {
      check(L('AI nee: geen chat van Gerrie'), fab === 0, `${fab} chatknoppen`);
      check(L('AI nee: Gerrie staat nergens in de werkruimte'), !/Gerrie/.test(appText), appText.match(/.{0,40}Gerrie.{0,40}/)?.[0]);
    }
    await shot(page, `${vp}-werkruimte`);
    check(L('elke schrijfactie op de bedrijfsgegevens ging naar de eigen organisatie'),
      settingsWrites(setup).every(w => (w.method === 'PATCH' ? w.query.includes(`organization_id=eq.${ORG}`) : w.body?.organization_id === ORG)));
    check(L('geen JavaScript-fouten'), errors.length === 0, errors[0]);
    await context.close();
  }

  // ── 7: herladen halverwege ──────────────────────────────────────────────────
  {
    const { context, page, setup, errors } = await open(browser);
    await page.waitForSelector('.onb', { timeout: 20000 });
    await next(page).click();
    await choice(page, 'Eenmanszaak').click();
    await next(page).click();
    await waitForTitle(page, /Kies je pakket/, 'herladen: naar het abonnement');
    check('herladen: een eenmanszaak heeft geen module nodig', !(await next(page).isDisabled()));
    const sole = settingsWrites(setup).find(w => w.body?.legal_form === 'eenmanszaak');
    check('herladen: eenmanszaak opgeslagen met eigen vermogen en kalenderjaar', sole?.body?.year_result_account_code === '0500' && sole?.body?.fiscal_year_start_month === 1, JSON.stringify(sole?.body));
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('.onb', { timeout: 20000 });
    check('herladen: je komt terug waar je was', /Kies je pakket/.test(await title(page)));
    check('herladen: de eerdere stappen staan als gedaan', await page.locator('.onb-step.is-done').count() === 2);
    check('herladen: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }

  // ── 8: een verse organisatie zonder bedrijfsgegevens ────────────────────────
  {
    const { context, page, setup, errors } = await open(browser, { mock: { onboarding: true, emptySettings: true } });
    await page.waitForSelector('.onb', { timeout: 20000 });
    await next(page).click();
    await choice(page, 'VOF').click();
    await next(page).click();
    await waitForTitle(page, /Kies je pakket/, 'vers: naar het abonnement');
    // Eerst een update (die niets raakt: er is nog geen rij), dan de insert.
    const created = settingsWrites(setup).find(w => w.method === 'POST');
    check('vers: de eerste stap maakt de bedrijfsgegevens aan', created?.body?.organization_id === ORG && created?.body?.legal_form === 'vof' && created?.body?.year_result_account_code === '0510', JSON.stringify(setup.writes));
    check('vers: met alleen de velden van de rechtsvorm', Object.keys(created?.body ?? {}).sort().join(',') === 'created_by,fiscal_year_start_month,legal_form,organization_id,year_result_account_code', JSON.stringify(created?.body));
    await next(page).click();
    await waitForTitle(page, /bedrijfsgegevens/, 'vers: naar de bedrijfsgegevens');
    await next(page).click();
    check('vers: naam, adres en e-mail zijn verplicht', await page.locator('.onb-field.has-error').count() >= 4);
    check('vers: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }

  // ── 9: een teamlid wacht, een beheerder koppelt geen Mollie ────────────────
  {
    const { context, page, errors } = await open(browser, { mock: { onboarding: true, role: 'member' } });
    await page.waitForSelector('.onb-pending', { timeout: 20000 }).catch(() => null);
    check('teamlid: ziet dat de organisatie nog wordt ingericht', await page.locator('.onb-pending').count() === 1);
    check('teamlid: geen stappen en geen werkruimte', await page.locator('.onb-rail').count() === 0 && await page.locator('.app').count() === 0);
    await shot(page, 'teamlid-wacht');
    check('teamlid: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }
  {
    const progress = JSON.stringify({ step: 'mollie', completed: ['welkom', 'rechtsvorm', 'abonnement', 'bedrijf', 'webadres', 'btw', 'huisstijl', 'facturen'], pendingLegalForm: null });
    const { context, page, setup, errors } = await open(browser, { mock: { onboarding: true, role: 'admin', subdomain: 'studio-lopik' }, storage: { [PROGRESS_KEY]: progress } });
    await page.waitForSelector('.onb', { timeout: 20000 });
    await waitForTitle(page, /Mollie koppelen/, 'beheerder: opent bij Mollie');
    check('beheerder: geen veld voor de key', await page.locator('#onb-f-mollie').count() === 0);
    check('beheerder: uitleg dat alleen de eigenaar koppelt', /Alleen de eigenaar/.test(await page.locator('.onb-body').innerText()));
    check('beheerder: niets naar de server', !setup.writes.some(w => w.table === 'fn/saveInvoiceMollieKey'));
    check('beheerder: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }

  // ── 11: zonder webadres niet afronden ─────────────────────────────────────
  {
    // Halverwege van vóór de stap Webadres: verder bij die stap, niet bij Welkom.
    const before = JSON.stringify({ step: 'mollie', completed: ['welkom', 'rechtsvorm', 'abonnement', 'bedrijf', 'btw', 'huisstijl', 'facturen'], pendingLegalForm: null });
    const { context, page, errors } = await open(browser, { storage: { [PROGRESS_KEY]: before } });
    await page.waitForSelector('.onb', { timeout: 20000 });
    await waitForTitle(page, /Je webadres/, 'halverwege van vóór de nieuwe stap: verder bij Je webadres');
    check('halverwege: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }
  {
    // Halverwege van vóór de stap AI (2026-11-15): verder bij AI, niet bij Klaar.
    const before = JSON.stringify({ step: 'klaar', completed: ['welkom', 'rechtsvorm', 'abonnement', 'bedrijf', 'webadres', 'btw', 'huisstijl', 'facturen', 'mollie'], pendingLegalForm: null });
    const { context, page, errors } = await open(browser, { mock: { onboarding: true, subdomain: 'studio-lopik' }, storage: { [PROGRESS_KEY]: before } });
    await page.waitForSelector('.onb', { timeout: 20000 });
    await waitForTitle(page, /AI gebruiken/, 'halverwege van vóór de stap AI: verder bij AI');
    check('halverwege AI: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }
  {
    // De browser denkt dat de stappen gedaan zijn, maar er ligt geen naam en geen keuze voor AI vast.
    const progress = JSON.stringify({ step: 'klaar', completed: ['welkom', 'rechtsvorm', 'abonnement', 'bedrijf', 'webadres', 'btw', 'huisstijl', 'facturen', 'mollie', 'ai'], pendingLegalForm: null });
    const { context, page, setup, errors } = await open(browser, { storage: { [PROGRESS_KEY]: progress } });
    await page.waitForSelector('.onb', { timeout: 20000 });
    await waitForTitle(page, /Nog even dit/, 'geen webadres: het laatste scherm houdt tegen');
    check('geen webadres: dat staat er', /Kies nog het webadres/.test(await page.locator('.onb-body').innerText()));
    check('geen keuze voor AI: dat staat er ook', /Kies nog of je AI wilt gebruiken/.test(await page.locator('.onb-body').innerText()));
    check('geen webadres: afronden kan niet', await next(page).isDisabled());
    check('geen webadres: niets afgerond', !setup.writes.some(w => w.table === 'rpc/complete_organization_onboarding'));
    await shot(page, 'geen-webadres');
    await page.locator('.onb-notice', { hasText: 'Kies nog het webadres' }).getByRole('button', { name: 'Aanpassen' }).click();
    await waitForTitle(page, /Je webadres/, 'geen webadres: Aanpassen opent de stap');
    check('geen webadres: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }
  {
    // Al gekozen voor geen AI (een eerder bezoek): de keuze staat er weer, en
    // nog eens Volgende schrijft hem niet opnieuw.
    const progress = JSON.stringify({ step: 'ai', completed: ['welkom', 'rechtsvorm', 'abonnement', 'bedrijf', 'webadres', 'btw', 'huisstijl', 'facturen', 'mollie'], pendingLegalForm: null });
    const { context, page, setup, errors } = await open(browser, { mock: { onboarding: true, subdomain: 'studio-lopik', ai: 'off' }, storage: { [PROGRESS_KEY]: progress } });
    await page.waitForSelector('.onb', { timeout: 20000 });
    await waitForTitle(page, /AI gebruiken/, 'al gekozen: opent bij AI');
    check('al gekozen: "nee" staat aangevinkt', await choice(page, 'Nee, zonder AI').getAttribute('aria-checked') === 'true');
    await next(page).click();
    await waitForTitle(page, /beginnen/, 'al gekozen: door naar klaar');
    check('al gekozen: niet nog eens opgeslagen', !setup.writes.some(w => w.table === 'rpc/set_ai_consent'));
    check('al gekozen: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }

  // ── 13: later kiezen, en weer aanzetten ──────────────────────────────────
  {
    // Nog niet gekozen: de pagina Gerrie vraagt het, Gerrie staat in het menu.
    const { context, page, errors } = await open(browser, { mock: { aiOff: true }, view: 'gerrie' });
    const consentCalls = [];
    page.on('request', req => { if (req.url().includes('/rpc/set_ai_consent')) consentCalls.push(req.postDataJSON()); });
    await page.waitForSelector('.gaz-page', { timeout: 20000 }).catch(() => null);
    const railGerrie = () => page.locator('.zrail-btn.is-ai').count();
    check('later: nog niet gekozen, de pagina Gerrie vraagt het', await page.locator('.gaz-page').count() === 1);
    check('later: Gerrie staat dan nog in het menu', await railGerrie() === 1);
    await page.getByRole('button', { name: 'Liever geen AI' }).click();
    await page.locator('.gaz-off-empty').waitFor({ timeout: 8000 }).catch(() => null);
    check('later: "liever geen AI" legt de keuze vast', consentCalls.length === 1 && consentCalls[0]?.p_enabled === false && consentCalls[0]?.p_organization_id === ORG, JSON.stringify(consentCalls));
    check('later: het tabblad zegt dat Gerrie uit staat, en waarom', /Je koos ervoor geen AI te gebruiken/.test(await page.locator('.gaz-off-empty').innerText().catch(() => '')));
    check('later: en niet dat beheer hem dichtzette', !/dichtgezet/.test(await page.locator('.app').innerText()));
    check('later: Gerrie is uit het menu', await railGerrie() === 0);
    check('later: geen chat van Gerrie', await page.locator('.gerrie-fab').count() === 0);
    await shot(page, 'later-gerrie-uit');
    await page.getByRole('button', { name: 'Verder zonder Gerrie' }).click();
    await page.waitForTimeout(300);
    check('later: verder zonder Gerrie opent een andere pagina', await page.locator('.gaz-off-empty').count() === 0);
    const text = await page.locator('.app').innerText();
    check('later: Gerrie staat nergens meer in de werkruimte', !/Gerrie/.test(text), text.match(/.{0,40}Gerrie.{0,40}/)?.[0]);
    check('later: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }
  {
    // Gekozen voor geen AI, met een onthouden tabblad op Gerrie: via de knop
    // naar Instellingen → AI, en daar weer aanzetten.
    const { context, page, errors } = await open(browser, { mock: { aiDeclined: true }, view: 'gerrie' });
    const consentCalls = [];
    page.on('request', req => { if (req.url().includes('/rpc/set_ai_consent')) consentCalls.push(req.postDataJSON()); });
    await page.waitForSelector('.gaz-off-empty', { timeout: 20000 }).catch(() => null);
    check('weer aan: een onthouden tabblad zegt dat Gerrie uit staat', await page.locator('.gaz-off-empty').count() === 1);
    check('weer aan: niet in het menu', await page.locator('.zrail-btn.is-ai').count() === 0);
    await page.getByRole('button', { name: 'Naar Instellingen → AI' }).click();
    await page.locator('.gaz-declined').waitFor({ timeout: 8000 }).catch(() => null);
    check('weer aan: Instellingen → AI zegt dat je koos voor geen AI', await page.locator('.gaz-declined').count() === 1);
    check('weer aan: geen tweede "liever niet"', await page.getByRole('button', { name: 'Liever geen AI' }).count() === 0);
    await shot(page, 'later-instellingen-geen-ai');
    const settings = page.locator('.gaz-settings');
    const turnOn = settings.getByRole('button', { name: 'Gerrie aanzetten' });
    check('weer aan: de knop pas met drie vinkjes', await turnOn.isDisabled());
    for (const box of await settings.locator('input[type="checkbox"]').all()) await box.check();
    await turnOn.click();
    await settings.locator('.gaz-on').waitFor({ timeout: 8000 }).catch(() => null);
    check('weer aan: aangezet met de drie punten', consentCalls.length === 1 && consentCalls[0]?.p_enabled === true && consentCalls[0]?.p_acknowledged?.length === 3, JSON.stringify(consentCalls));
    check('weer aan: de kaart zegt dat hij aanstaat', await settings.locator('.gaz-on').count() === 1);
    check('weer aan: Gerrie is terug in het menu', await page.locator('.zrail-btn.is-ai').count() === 1);
    check('weer aan: en de chat ook', await page.locator('.gerrie-fab').count() === 1);
    check('weer aan: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }

  // ── 10: een database zonder de nieuwe kolom ───────────────────────────────
  {
    const { context, page, errors } = await open(browser, { mock: {} });
    await page.waitForSelector('.app', { timeout: 20000 }).catch(() => null);
    check('oude database: de werkruimte opent zoals altijd', await page.locator('.app').count() === 1 && await page.locator('.onb').count() === 0);
    check('oude database: geen JavaScript-fouten', errors.length === 0, errors[0]);
    await context.close();
  }
} finally {
  await browser.close();
  if (server) await server.close();
}

console.log(`\n${failures.length ? `${failures.length} controle(s) mislukt.` : 'Alle controles geslaagd.'}`);
process.exit(failures.length ? 1 : 0);
