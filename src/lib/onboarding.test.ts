/**
 * Tests voor de inrichtingsstappen: de volgorde, het onthouden van waar je was,
 * de uitleg per rechtsvorm en de controles op de bedrijfsgegevens.
 * Draaien met: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookkeepingStartSuggestions, checkCompanyDraft, defaultYearResultAccount, finishCheck, fiscalYearMustBeCalendarYear, formatIban, isDutchPostcode, isEmailAddress, isIsoDate, isKvkNumber, isPhoneNumber, isValidIban, LEGAL_FORM_GROUPS, LEGAL_FORM_INFO, mollieKeyMode, mollieKeyProblem, needsBusinessModule, normalizeCompanyDraft, normalizeDutchPostcode, normalizeWebsite, onboardingProgressKey, onboardingSteps, ONBOARDING_PROGRESS_PREFIX, ONBOARDING_STEPS, organizationDisplayName, parseHourlyRateCents, parseOnboardingProgress, paymentTermsText, reachableSteps, resumeStep, serializeOnboardingProgress, type CompanyDraft, type OnboardingStepKey,
} from './onboarding.ts';
import { BUSINESS_LEGAL_FORMS, LEGAL_FORM_LABELS, type LegalForm } from '../types.ts';

const draft = (overrides: Partial<CompanyDraft> = {}): CompanyDraft => ({
  company_name: 'Studio Jansen B.V.',
  trade_name: 'Studio Jansen',
  address_line1: 'Kerkstraat 12',
  address_line2: '',
  postal_code: '3411ab',
  city: 'Lopik',
  country: 'Nederland',
  email: 'Info@StudioJansen.nl',
  phone: '0348-123456',
  website: 'studiojansen.nl',
  kvk_number: '1234 5678',
  vat_number: 'nl 123456789 b01',
  iban: 'nl91abna0417164300',
  ...overrides,
});

// ── Stappen ──────────────────────────────────────────────────────────────────

test('de stappen beginnen bij Welkom en eindigen bij Klaar, met het abonnement direct na de rechtsvorm', () => {
  const keys = ONBOARDING_STEPS.map(step => step.key);
  assert.equal(keys[0], 'welkom');
  assert.equal(keys[keys.length - 1], 'klaar');
  assert.equal(keys.indexOf('abonnement'), keys.indexOf('rechtsvorm') + 1, 'een BV heeft de module nodig voordat de rest erop voortbouwt');
  assert.ok(keys.indexOf('facturen') < keys.indexOf('mollie'), 'eerst kiezen hoe je verstuurt, dan pas Mollie');
  assert.equal(new Set(keys).size, keys.length, 'geen dubbele stappen');
});

test('een administratie onder een holding slaat het abonnement over', () => {
  assert.ok(onboardingSteps({ isChild: false }).some(step => step.key === 'abonnement'));
  assert.ok(!onboardingSteps({ isChild: true }).some(step => step.key === 'abonnement'));
  assert.equal(onboardingSteps({ isChild: true }).length, ONBOARDING_STEPS.length - 1);
});

test('vooruit springen kan tot de eerste stap die nog open staat', () => {
  const steps = onboardingSteps({ isChild: false });
  assert.deepEqual([...reachableSteps(steps, new Set())], ['welkom']);
  assert.deepEqual([...reachableSteps(steps, new Set(['welkom', 'rechtsvorm']))], ['welkom', 'rechtsvorm', 'abonnement']);
  // Een overgeslagen stap ertussen houdt de rest niet tegen als die al af was.
  const reach = reachableSteps(steps, new Set(['welkom', 'bedrijf']));
  assert.ok(reach.has('rechtsvorm'));
  assert.ok(reach.has('bedrijf'));
  assert.ok(!reach.has('btw'));
});

test('de voortgang komt terug zoals hij is opgeslagen', () => {
  const saved = serializeOnboardingProgress({ step: 'abonnement', completed: ['welkom', 'rechtsvorm', 'welkom'], pendingLegalForm: 'bv' });
  assert.deepEqual(parseOnboardingProgress(saved), { step: 'abonnement', completed: ['welkom', 'rechtsvorm'], pendingLegalForm: 'bv' });
});

test('onzin in de opslag wordt genegeerd', () => {
  assert.equal(parseOnboardingProgress(null), null);
  assert.equal(parseOnboardingProgress(''), null);
  assert.equal(parseOnboardingProgress('{niet json'), null);
  assert.equal(parseOnboardingProgress('"welkom"'), null);
  assert.equal(parseOnboardingProgress(JSON.stringify({ step: 'betalen' })), null, 'onbekende stap');
  assert.deepEqual(
    parseOnboardingProgress(JSON.stringify({ step: 'btw', completed: ['welkom', 'hack', 7], pendingLegalForm: 'plc' })),
    { step: 'btw', completed: ['welkom'], pendingLegalForm: null },
  );
});

test('de voortgang valt onder wat uitloggen opruimt', async () => {
  assert.ok(onboardingProgressKey('org-1').startsWith(ONBOARDING_PROGRESS_PREFIX));
  const { readFileSync } = await import('node:fs');
  const signOut = readFileSync(new URL('./signOut.ts', import.meta.url), 'utf8');
  assert.ok(signOut.includes(`'${ONBOARDING_PROGRESS_PREFIX}'`), 'signOut.ts ruimt het voorvoegsel op');
});

// ── Rechtsvormen ─────────────────────────────────────────────────────────────

test('elke rechtsvorm heeft uitleg, en staat in precies één groep', () => {
  const all = Object.keys(LEGAL_FORM_LABELS) as LegalForm[];
  for (const form of all) {
    const info = LEGAL_FORM_INFO[form];
    assert.equal(info.form, form);
    assert.ok(info.tagline.length > 10, `${form}: tagline`);
    assert.ok(info.inResoFly.length > 0, `${form}: wat het in ResoFly betekent`);
    assert.equal(LEGAL_FORM_GROUPS.filter(group => group.forms.includes(form)).length, 1, `${form}: één groep`);
  }
});

test('de zakelijke module hoort bij precies de rechtsvormen die de database bewaakt', () => {
  for (const form of Object.keys(LEGAL_FORM_LABELS) as LegalForm[]) {
    assert.equal(needsBusinessModule(form), BUSINESS_LEGAL_FORMS.includes(form), form);
    assert.equal(LEGAL_FORM_INFO[form].needsBusinessModule, BUSINESS_LEGAL_FORMS.includes(form), form);
  }
});

test('het jaarresultaat: eigen vermogen bij een eenmanszaak, anders onverdeeld resultaat', () => {
  assert.equal(defaultYearResultAccount('eenmanszaak'), '0500');
  assert.equal(defaultYearResultAccount('bv'), '0510');
  assert.equal(defaultYearResultAccount('vof'), '0510');
  assert.equal(defaultYearResultAccount('stichting'), '0510');
});

test('alleen een rechtspersoon kan een gebroken boekjaar hebben', () => {
  assert.equal(fiscalYearMustBeCalendarYear('eenmanszaak'), true);
  assert.equal(fiscalYearMustBeCalendarYear('vof'), true);
  assert.equal(fiscalYearMustBeCalendarYear('bv'), false);
  assert.equal(fiscalYearMustBeCalendarYear('stichting'), false);
});

// ── Losse controles ──────────────────────────────────────────────────────────

test('KvK-nummer: 8 cijfers, spaties en punten mogen', () => {
  assert.equal(isKvkNumber('12345678'), true);
  assert.equal(isKvkNumber('1234 5678'), true);
  assert.equal(isKvkNumber('12.34.56.78'), true);
  assert.equal(isKvkNumber('1234567'), false);
  assert.equal(isKvkNumber('123456789'), false);
  assert.equal(isKvkNumber('KVK12345678'), false);
});

test('postcode: 4 cijfers en 2 letters, netjes geschreven', () => {
  assert.equal(isDutchPostcode('3411 AB'), true);
  assert.equal(isDutchPostcode('3411ab'), true);
  assert.equal(isDutchPostcode('0411 AB'), false, 'begint nooit met 0');
  assert.equal(isDutchPostcode('341 AB'), false);
  assert.equal(normalizeDutchPostcode(' 3411ab '), '3411 AB');
  assert.equal(normalizeDutchPostcode('B-1000'), 'B-1000', 'een buitenlandse postcode blijft staan');
});

test('IBAN: controlegetal, lengte per land en de schrijfwijze op een factuur', () => {
  assert.equal(isValidIban('NL91ABNA0417164300'), true);
  assert.equal(isValidIban('nl91 abna 0417 1643 00'), true);
  assert.equal(isValidIban('NL91ABNA0417164301'), false, 'één cijfer anders');
  assert.equal(isValidIban('NL91ABNA041716430'), false, 'te kort voor NL');
  assert.equal(isValidIban('BE68539007547034'), true);
  assert.equal(isValidIban('DE89370400440532013000'), true);
  assert.equal(isValidIban('GB82WEST12345698765432'), true);
  assert.equal(isValidIban(''), false);
  assert.equal(isValidIban('ABNA0417164300'), false);
  assert.equal(formatIban('nl91abna0417164300'), 'NL91 ABNA 0417 1643 00');
});

test('e-mail, telefoon en website', () => {
  assert.equal(isEmailAddress('info@studiojansen.nl'), true);
  assert.equal(isEmailAddress('info@studiojansen'), false);
  assert.equal(isEmailAddress('info studio@x.nl'), false);
  assert.equal(isPhoneNumber('0348-123456'), true);
  assert.equal(isPhoneNumber('+31 (0)6 1234 5678'), true);
  assert.equal(isPhoneNumber('12345'), false);
  assert.equal(isPhoneNumber('bel me'), false);
  assert.equal(normalizeWebsite('studiojansen.nl'), 'https://studiojansen.nl');
  assert.equal(normalizeWebsite('http://www.studiojansen.nl/contact'), 'http://www.studiojansen.nl/contact');
  assert.equal(normalizeWebsite('https://studiojansen.nl/'), 'https://studiojansen.nl');
});

test('een website wordt nooit een script- of data-adres', () => {
  assert.equal(normalizeWebsite('javascript:alert(1)'), null);
  assert.equal(normalizeWebsite('JaVaScRiPt:alert(1)'), null);
  assert.equal(normalizeWebsite('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(normalizeWebsite('vbscript:msgbox'), null);
  assert.equal(normalizeWebsite('https://user:pass@studiojansen.nl'), null, 'geen inloggegevens in een adres');
  assert.equal(normalizeWebsite('localhost'), null);
  assert.equal(normalizeWebsite('studio jansen.nl'), null);
  assert.equal(normalizeWebsite(''), null);
});

// ── Bedrijfsgegevens als geheel ──────────────────────────────────────────────

test('volledige gegevens gaan door, en worden netjes opgeslagen', () => {
  const check = checkCompanyDraft(draft(), 'bv');
  assert.deepEqual(check.errors, {});
  assert.deepEqual(normalizeCompanyDraft(draft()), {
    company_name: 'Studio Jansen B.V.',
    trade_name: 'Studio Jansen',
    address_line1: 'Kerkstraat 12',
    address_line2: null,
    postal_code: '3411 AB',
    city: 'Lopik',
    country: 'Nederland',
    email: 'info@studiojansen.nl',
    phone: '0348-123456',
    website: 'https://studiojansen.nl',
    kvk_number: '12345678',
    vat_number: 'NL123456789B01',
    iban: 'NL91 ABNA 0417 1643 00',
  });
});

test('naam, adres en e-mail zijn verplicht', () => {
  const check = checkCompanyDraft(draft({ company_name: ' ', address_line1: '', postal_code: '', city: '', email: '' }), 'eenmanszaak');
  assert.ok(check.errors.company_name);
  assert.ok(check.errors.address_line1);
  assert.ok(check.errors.postal_code);
  assert.ok(check.errors.city);
  assert.ok(check.errors.email);
});

test('KvK, btw-id en IBAN mogen nog ontbreken, maar niet verkeerd zijn', () => {
  const empty = checkCompanyDraft(draft({ kvk_number: '', vat_number: '', iban: '' }), 'bv');
  assert.deepEqual(empty.errors, {});
  assert.ok(empty.notes.some(note => note.includes('KvK')));
  assert.ok(empty.notes.some(note => note.includes('btw-id')));
  assert.ok(empty.notes.some(note => note.includes('IBAN')));

  const wrong = checkCompanyDraft(draft({ kvk_number: '1234', vat_number: 'NL12345678B01', iban: 'NL91ABNA0417164301' }), 'bv');
  assert.ok(wrong.errors.kvk_number);
  assert.ok(wrong.errors.vat_number);
  assert.ok(wrong.errors.iban);
});

test('het omzetbelastingnummer zonder NL wordt herkend', () => {
  const check = checkCompanyDraft(draft({ vat_number: '123456789B01' }), 'eenmanszaak');
  assert.match(check.errors.vat_number ?? '', /Zet NL/);
  assert.ok(check.notes.some(note => note.includes('BSN')), 'een eenmanszaak krijgt de uitleg over het btw-id');
});

test('met de KOR is een btw-id niet nodig', () => {
  const check = checkCompanyDraft(draft({ vat_number: '' }), 'eenmanszaak', { korEnabled: true });
  assert.ok(!check.notes.some(note => note.startsWith('Zonder btw-id')));
});

test('een btw-id uit een ander EU-land mag', () => {
  assert.equal(checkCompanyDraft(draft({ vat_number: 'BE0123456789', country: 'België', postal_code: '1000' }), 'bv').errors.vat_number, undefined);
  assert.ok(checkCompanyDraft(draft({ vat_number: 'XX123' }), 'bv').errors.vat_number);
});

test('buiten Nederland gelden de Nederlandse vormen niet', () => {
  const check = checkCompanyDraft(draft({ country: 'België', postal_code: '1000', kvk_number: '0123.456.789' }), 'bv');
  assert.equal(check.errors.postal_code, undefined);
  assert.equal(check.errors.kvk_number, undefined);
});

test('te lange invoer wordt geweigerd', () => {
  const check = checkCompanyDraft(draft({ company_name: 'x'.repeat(201) }), 'bv');
  assert.match(check.errors.company_name ?? '', /te lang/);
});

test('stuurtekens verdwijnen uit wat wordt opgeslagen', () => {
  const saved = normalizeCompanyDraft(draft({ company_name: 'Studio\nJansen\u0000 B.V.' }));
  assert.equal(saved.company_name, 'Studio Jansen B.V.');
});

// ── Btw, facturen en Mollie ──────────────────────────────────────────────────

test('startdatums: 1 januari en het begin van het kwartaal, zonder dubbele', () => {
  assert.deepEqual(bookkeepingStartSuggestions(new Date(2026, 10, 7)).map(o => o.value), ['2026-01-01', '2026-10-01']);
  assert.deepEqual(bookkeepingStartSuggestions(new Date(2026, 1, 10)).map(o => o.value), ['2026-01-01']);
});

test('een datum moet echt bestaan', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('26-02-2026'), false);
  assert.equal(isIsoDate('1890-01-01'), false);
});

test('uurtarief in euro naar centen', () => {
  assert.equal(parseHourlyRateCents(''), null);
  assert.equal(parseHourlyRateCents('85'), 8500);
  assert.equal(parseHourlyRateCents('85,50'), 8550);
  assert.equal(parseHourlyRateCents('€ 95'), 9500);
  assert.equal(parseHourlyRateCents('-5'), undefined);
  assert.equal(parseHourlyRateCents('veel'), undefined);
  assert.equal(parseHourlyRateCents('99999999'), undefined);
});

test('de betaaltekst noemt de termijn, en de betaallink alleen via Mollie', () => {
  assert.match(paymentTermsText(14, 'email'), /binnen 14 dagen/);
  assert.doesNotMatch(paymentTermsText(14, 'email'), /betaallink/);
  assert.match(paymentTermsText(30, 'mollie'), /betaallink/);
});

test('Mollie-key: de bekende vergissingen krijgen een eigen melding', () => {
  assert.equal(mollieKeyProblem('live_abcdefghijklmnopqrstuvwxyz123456'), null);
  assert.equal(mollieKeyProblem('test_abcdefghijklmnopqrstuvwxyz123456'), null);
  assert.match(mollieKeyProblem('') ?? '', /Plak/);
  assert.match(mollieKeyProblem('access_abcdefghijklmnopqrstuvwxyz') ?? '', /access token/);
  assert.match(mollieKeyProblem('pfl_abcdef123') ?? '', /profiel/);
  assert.match(mollieKeyProblem('live_abc def') ?? '', /spatie/);
  assert.match(mollieKeyProblem('sk_live_123') ?? '', /begint met live_/);
  assert.match(mollieKeyProblem('live_kort') ?? '', /letters en cijfers/);
  assert.equal(mollieKeyMode(' live_abc'), 'live');
  assert.equal(mollieKeyMode('test_abc'), 'test');
  assert.equal(mollieKeyMode('abc'), null);
});

// ── Afronden ────────────────────────────────────────────────────────────────

test('de naam in ResoFly: handelsnaam, anders bedrijfsnaam', () => {
  assert.equal(organizationDisplayName('Studio Jansen B.V.', 'Studio Jansen'), 'Studio Jansen');
  assert.equal(organizationDisplayName('Studio Jansen B.V.', '  '), 'Studio Jansen B.V.');
  assert.equal(organizationDisplayName(null, null), '');
  assert.equal(organizationDisplayName('x'.repeat(200), null).length, 120);
});

test('afronden kan pas met een naam, een adres en een vastgelegde rechtsvorm', () => {
  assert.deepEqual(finishCheck({ companyName: 'Studio', addressLine1: 'Kerkstraat 1', savedLegalForm: 'bv', pendingLegalForm: null }).blocking, []);
  assert.deepEqual(finishCheck({ companyName: 'Studio', addressLine1: 'Kerkstraat 1', savedLegalForm: 'bv', pendingLegalForm: 'bv' }).blocking, []);
  const pending = finishCheck({ companyName: 'Studio', addressLine1: 'Kerkstraat 1', savedLegalForm: 'eenmanszaak', pendingLegalForm: 'bv' });
  assert.equal(pending.blocking.length, 1);
  assert.equal(pending.blocking[0].step, 'rechtsvorm');
  const empty = finishCheck({ companyName: '', addressLine1: null, savedLegalForm: 'eenmanszaak', pendingLegalForm: null });
  assert.deepEqual(empty.blocking.map(item => item.step), ['bedrijf', 'bedrijf']);
});

test('afronden kan pas met een webadres, als bekend is dat het er niet is', () => {
  const base = { companyName: 'Studio', addressLine1: 'Kerkstraat 1', savedLegalForm: 'eenmanszaak' as const, pendingLegalForm: null };
  assert.deepEqual(finishCheck({ ...base, clientSubdomain: 'studio' }).blocking, []);
  assert.deepEqual(finishCheck({ ...base, clientSubdomain: null }).blocking.map(item => item.step), ['webadres']);
  // Nog niet geladen (undefined): niet tegenhouden; de database controleert het bij het afronden.
  assert.deepEqual(finishCheck(base).blocking, []);
  // De stap staat direct na de bedrijfsgegevens.
  const keys = ONBOARDING_STEPS.map(step => step.key);
  assert.equal(keys.indexOf('webadres'), keys.indexOf('bedrijf') + 1);
});

test('een nieuwe stap staat vanzelf voor wie al verder was', () => {
  const steps = onboardingSteps({ isChild: false });
  const before = new Set<OnboardingStepKey>(['welkom', 'rechtsvorm', 'abonnement', 'bedrijf', 'btw', 'huisstijl', 'facturen']);
  assert.equal(resumeStep(steps, before, 'mollie'), 'webadres', 'wie bij Mollie zat, kiest eerst het webadres');
  assert.equal(resumeStep(steps, new Set<OnboardingStepKey>([...before, 'webadres']), 'mollie'), 'mollie');
  assert.equal(resumeStep(steps, new Set<OnboardingStepKey>(), 'mollie'), 'welkom');
  assert.equal(resumeStep(steps, new Set<OnboardingStepKey>(['welkom']), 'klaar'), 'rechtsvorm');
  assert.equal(resumeStep(steps, new Set<OnboardingStepKey>(['welkom']), 'rechtsvorm'), 'rechtsvorm');
});
