import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from './actions/index.ts';
import { BOOKKEEPING_ACTIONS } from './actions/bookkeeping.ts';
import { FINANCE_ACTIONS } from './actions/finance.ts';
import { BUSINESS_ACTIONS } from './actions/business.ts';
import { CLIENT_ACTIONS } from './actions/clients.ts';
import { MARKETING_ACTIONS } from './actions/marketing.ts';
import { ActionError, bool, num, optNum, type ActionCtx, type ActionDef } from './actions/types.ts';
import { renderInvoiceReminderEmail } from './emailTemplates/invoiceReminder.ts';
import { publicActionError } from './publicError.ts';

/**
 * De controle van de financiële functies (november 2026): strikte invoer,
 * verplichte velden, het risico van wijzigingen die automatische boekingen
 * sturen, "altijd langs een mens" voor een ander IBAN, de herinnering na een
 * deelbetaling en foutmeldingen zonder databasetekst.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const ID = 'c0000000-0000-4000-8000-000000000001';

/** Een database die per tabel vaste rijen teruggeeft, en per rpc een vaste waarde. */
function fakeDb(rows: Record<string, Array<Record<string, unknown>>>, rpcs: Record<string, unknown> = {}) {
  return {
    from(table: string) {
      const list = rows[table] ?? [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const name of ['select', 'eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'neq', 'not', 'or', 'ilike']) chain[name] = self;
      chain.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
      chain.single = async () => ({ data: list[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: list, error: null });
      return chain;
    },
    async rpc(name: string) {
      if (!(name in rpcs)) throw new Error(`onverwachte rpc ${name}`);
      return { data: rpcs[name], error: null };
    },
  };
}

function ctx(rows: Record<string, Array<Record<string, unknown>>>, rpcs: Record<string, unknown> = {}, role = 'owner'): ActionCtx {
  return {
    organizationId: ORG, userId: '00000000-0000-0000-0000-0000000000a1', role, today: '2026-11-05',
    db: fakeDb(rows, rpcs) as unknown as ActionCtx['db'],
    canRead: () => true,
    canWrite: () => true,
  };
}

function action(list: ActionDef[], id: string): ActionDef {
  const found = list.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

// ── Invoer ────────────────────────────────────────────────────────────────

test('num() maakt van null, leeg of een vlag geen 0 of 1', () => {
  assert.throws(() => num({ x: null }, 'x'), ActionError);
  assert.throws(() => num({ x: '' }, 'x'), ActionError);
  assert.throws(() => num({ x: false }, 'x'), ActionError);
  assert.throws(() => num({ x: true }, 'x'), ActionError);
  assert.throws(() => num({}, 'x'), ActionError);
  assert.equal(num({ x: 0 }, 'x'), 0);
  assert.equal(num({ x: '12' }, 'x'), 12);
});

test('optNum() laat ontbreken toe, maar een vlag is geen getal', () => {
  assert.equal(optNum({}, 'x'), null);
  assert.equal(optNum({ x: null }, 'x'), null);
  assert.equal(optNum({ x: '' }, 'x'), null);
  assert.throws(() => optNum({ x: true }, 'x'), ActionError);
  assert.equal(optNum({ x: 2.5 }, 'x'), 2.5);
});

test('bool() leest "false" als nee in plaats van terug te vallen op de standaard', () => {
  assert.equal(bool({ signed: 'false' }, 'signed', true), false);
  assert.equal(bool({ signed: 'true' }, 'signed', false), true);
  assert.equal(bool({ signed: 'nee' }, 'signed', true), false);
  assert.equal(bool({}, 'signed', true), true);
  assert.equal(bool({ signed: null }, 'signed', true), true);
  assert.throws(() => bool({ signed: 'misschien' }, 'signed', true), ActionError);
});

test('een verplicht veld dat ontbreekt, weigert vóór het plan', async () => {
  const setStatus = action(ACTIONS, 'invoice.set_status');
  await assert.rejects(setStatus.plan!(ctx({}), { invoice_id: ID }),
    (error: unknown) => error instanceof ActionError && /Verplicht en niet ingevuld: "status"/.test(error.message));
  await assert.rejects(setStatus.plan!(ctx({}), { invoice_id: '  ', status: 'paid' }),
    (error: unknown) => error instanceof ActionError && /"invoice_id"/.test(error.message));
});

// ── Bankregels ───────────────────────────────────────────────────────────

const AUTO_RULE = {
  name: 'Huur', auto_book: true, is_active: true, target_account_id: ID,
  match_counterparty_iban: null, match_counterparty_name_contains: null, match_description_contains: 'huur', match_amount_cents: null,
};

test('een bankregel kan niet al zijn voorwaarden kwijtraken', async () => {
  const update = action(BOOKKEEPING_ACTIONS, 'bank_rule.update');
  await assert.rejects(update.plan!(ctx({ bank_rules: [AUTO_RULE] }), { rule_id: ID, match_description_contains: '' }),
    (error: unknown) => error instanceof ActionError && /minstens één voorwaarde/.test(error.message));
});

test('wat een automatisch boekende regel boekt veranderen is hoog risico; de naam niet', async () => {
  const update = action(BOOKKEEPING_ACTIONS, 'bank_rule.update');
  const rows = { bank_rules: [AUTO_RULE] };
  const condition = await update.plan!(ctx(rows), { rule_id: ID, match_description_contains: 'h' });
  assert.equal(condition.risk, 'high');
  const name = await update.plan!(ctx(rows), { rule_id: ID, name: 'Kantoorhuur' });
  assert.equal(name.risk, 'normal');
  // Weer aanzetten van een uitgezette automatische regel: ook hoog.
  const off = { bank_rules: [{ ...AUTO_RULE, is_active: false }] };
  const reactivate = await update.plan!(ctx(off), { rule_id: ID, is_active: true });
  assert.equal(reactivate.risk, 'high');
  // Uitzetten is altijd veilig.
  const disable = await update.plan!(ctx(rows), { rule_id: ID, auto_book: false });
  assert.equal(disable.risk, 'normal');
});

// ── Waar het geld heen gaat ──────────────────────────────────────────────

test('een ander IBAN van een leverancier gaat altijd langs een mens, met oud → nieuw', async () => {
  const update = action(BOOKKEEPING_ACTIONS, 'supplier.update');
  const rows = { suppliers: [{ name: 'Drukkerij', iban: 'NL01BANK0000000001', email: 'f@drukkerij.nl', default_expense_account_id: null, default_vat_code: null }] };
  const plan = await update.plan!(ctx(rows), { supplier_id: ID, iban: 'NL02BANK0000000002' });
  assert.equal(plan.humanOnly, true);
  assert.equal(plan.risk, 'high');
  assert.match(plan.sub, /NL01BANK0000000001 → NL02BANK0000000002/);
  const phone = await update.plan!(ctx(rows), { supplier_id: ID, phone: '0612345678' });
  assert.equal(phone.humanOnly, undefined);
});

test('het IBAN op de eigen facturen gaat altijd langs een mens', async () => {
  const setDetails = action(FINANCE_ACTIONS, 'finance.set_invoice_company_details');
  const rows = { company_settings: [{ company_name: 'Studio', iban: 'NL01BANK0000000001', email: 'info@studio.nl' }] };
  const plan = await setDetails.plan!(ctx(rows), { iban: 'NL09FRAU0000000009' });
  assert.equal(plan.humanOnly, true);
  assert.match(plan.sub, /NL01BANK0000000001 → NL09FRAU0000000009/);
});

// ── Facturen ─────────────────────────────────────────────────────────────

test('"betaald" voor een geboekte factuur met een openstaand bedrag verwijst naar de bank', async () => {
  const setStatus = action(FINANCE_ACTIONS, 'invoice.set_status');
  const rows = { invoices: [{ number: 'F-1', status: 'sent', client_id: null, due_date: null, lines: [], total_amount: 121, journal_entry_id: ID }] };
  await assert.rejects(setStatus.plan!(ctx(rows, { invoice_open_receivable_cents: 12100 }), { invoice_id: ID, status: 'paid' }),
    (error: unknown) => error instanceof ActionError && /invoice\.reconcile_bank_transaction/.test(error.message));
  // Staat er niets meer open, dan is "betaald" alleen nog de status bijwerken.
  const plan = await setStatus.plan!(ctx(rows, { invoice_open_receivable_cents: 0 }), { invoice_id: ID, status: 'paid' });
  assert.equal(plan.payload.was, 'sent');
});

test('de herinnering vraagt wat er nog openstaat', () => {
  const base = {
    level: 1 as const,
    invoice: { number: 'F-7', due_date: '2026-10-01', lines: [{ quantity: 10, unit_price: 100, vat: 21 }] },
    client: { name: 'Klant BV' },
    publicUrl: 'https://example.com/invoice/x',
  };
  const partial = renderInvoiceReminderEmail({ ...base, openAmountCents: 71000 } as Parameters<typeof renderInvoiceReminderEmail>[0]);
  // Intl zet een harde spatie tussen € en het bedrag; \s vangt die.
  assert.match(partial.text, /Factuurbedrag: €\s1\.210,00/);
  assert.match(partial.text, /Openstaand bedrag: €\s710,00/);
  const full = renderInvoiceReminderEmail(base as Parameters<typeof renderInvoiceReminderEmail>[0]);
  assert.match(full.text, /Openstaand bedrag: €\s1\.210,00/);
  assert.doesNotMatch(full.text, /Factuurbedrag/);
});

// ── Rechtsvorm ───────────────────────────────────────────────────────────

test('aandeelhouders en Vpb weigeren bij een eenmanszaak vóór er een kaart komt', async () => {
  const create = action(BUSINESS_ACTIONS, 'shareholder.create');
  await assert.rejects(create.plan!(ctx({ company_settings: [{ legal_form: 'eenmanszaak' }] }), { name: 'A', kind: 'natural_person' }),
    (error: unknown) => error instanceof ActionError && /hoort bij een BV of NV/.test(error.message));
  const correction = action(BUSINESS_ACTIONS, 'corporate_tax.add_correction');
  await assert.rejects(correction.plan!(ctx({ company_settings: [{ legal_form: 'vof' }] }), { fiscal_year_id: ID, code: 'overig', label: 'x', amount_eur: 1 }),
    (error: unknown) => error instanceof ActionError && /Vennootschapsbelasting hoort bij een BV, NV of Coöperatie/i.test(error.message));
});

test('terugdraaien van bestemming, dividend, DGA-rente, Vpb en jaarrekening is alleen voor eigenaar of beheerder', () => {
  for (const id of ['result_appropriation.reverse', 'dividend.reverse', 'dga.reverse_interest', 'corporate_tax.reverse', 'annual_accounts.reverse', 'business.set_legal_form']) {
    assert.equal(action(BUSINESS_ACTIONS, id).adminOnly, true, `${id} hoort adminOnly te zijn`);
  }
});

test('afsluiten weigert vooraf als de winstverdeling van de vennoten niet op 100% uitkomt', async () => {
  const close = action(BOOKKEEPING_ACTIONS, 'fiscal_year.close');
  const rows = {
    fiscal_years: [{ label: '2025', period_start: '2025-01-01', period_end: '2025-12-31', status: 'open', legal_form: 'vof' }],
    company_settings: [{ year_result_account_code: '0510', legal_form: 'vof' }],
  };
  // Sinds 20261122100000 komt de verdeling van dít boekjaar uit
  // owners_equity_overview, met de bedragen per vennoot.
  const verdeling = (extra: Record<string, unknown> = {}) => ({
    list_fiscal_years: [{ id: ID, computed_result_cents: 100000 }],
    owners_equity_overview: {
      isPartnership: true, shareTotalBasisPoints: 10000, splitFixed: false, splitChangedAfterYearEnd: [], generalPrivateCents: 0, partnersDefined: true,
      owners: [
        { name: 'Anna', inSplit: true, shareBasisPoints: 6000, priorShareCents: 0, resultShareCents: 60000 },
        { name: 'Bram', inSplit: true, shareBasisPoints: 4000, priorShareCents: 0, resultShareCents: 40000 },
      ],
      ...extra,
    },
  });
  await assert.rejects(close.plan!(ctx(rows, verdeling({ shareTotalBasisPoints: 9000 })), { fiscal_year_id: ID }),
    (error: unknown) => error instanceof ActionError && /90% in plaats van 100%/.test(error.message));
  const plan = await close.plan!(ctx(rows, verdeling()), { fiscal_year_id: ID });
  assert.match(plan.sub, /naar de vennoten \(Anna €\s600,00; Bram €\s400,00\)/);
  assert.match(plan.sub, /de verdeling is die van de vennoten nu/);
  // Een vennoot die na het einde van het jaar is gewijzigd: eerst de verdeling van dat jaar.
  await assert.rejects(close.plan!(ctx(rows, verdeling({ splitChangedAfterYearEnd: ['Bram'] })), { fiscal_year_id: ID }),
    (error: unknown) => error instanceof ActionError && /na het einde van 2025 gewijzigd \(Bram\)/.test(error.message) && /fiscal_year\.set_partner_shares/.test(error.message));
  // Een bedrag vooraf, en privé zonder vennoot, staan op de kaart.
  const vooraf = await close.plan!(ctx(rows, verdeling({
    splitFixed: true, generalPrivateCents: 30000,
    owners: [
      { name: 'Anna', inSplit: true, shareBasisPoints: 6000, priorShareCents: 0, resultShareCents: 30000 },
      { name: 'Bram', inSplit: true, shareBasisPoints: 4000, priorShareCents: 50000, resultShareCents: 70000 },
    ],
  })), { fiscal_year_id: ID });
  assert.match(vooraf.sub, /Bram €\s700,00, waarvan €\s500,00 vooraf/);
  assert.match(vooraf.sub, /de verdeling van 2025 is vastgelegd/);
  assert.match(vooraf.sub, /0550\/0560 \(privé, geen vennoot\)/);
  // Na de overstap naar een eenmanszaak sluit 2025 nog af als vof.
  const overstap = await close.plan!(ctx({ ...rows, company_settings: [{ year_result_account_code: '0500', legal_form: 'eenmanszaak' }] }, verdeling()), { fiscal_year_id: ID });
  assert.match(overstap.sub, /2025 sluit af als vof, de rechtsvorm in dat jaar; nu is het een eenmanszaak/);
  assert.match(overstap.sub, /naar de vennoten/);
});

// ── Vennoten: privé en uren (17 november 2026) ───────────────────────────

test('zonder actieve vennoot of na de overstap naar een eenmanszaak: privé van de vennoten naar hun eigen kapitaal', async () => {
  const close = action(BOOKKEEPING_ACTIONS, 'fiscal_year.close');
  const zonderVerdeling = (partnersDefined: boolean) => ({
    list_fiscal_years: [{ id: ID, computed_result_cents: 100000 }],
    owners_equity_overview: { isPartnership: false, shareTotalBasisPoints: 0, splitFixed: false, splitChangedAfterYearEnd: [], generalPrivateCents: 0, partnersDefined, owners: [] },
  });
  const jaar = (legal_form: string) => [{ label: '2025', period_start: '2025-01-01', period_end: '2025-12-31', status: 'open', legal_form }];

  // Een vof waarvan iedereen is uitgetreden: geen weigering om 0%, het resultaat naar 0510.
  const vof = await close.plan!(ctx({ fiscal_years: jaar('vof'), company_settings: [{ year_result_account_code: '0510', legal_form: 'vof' }] }, zonderVerdeling(true)), { fiscal_year_id: ID });
  assert.match(vof.sub, /naar 0510 \(geen vennoten in de verdeling: niet verdeeld\); privé \(0550\/0560\) naar 0500 Eigen vermogen; het privé van de vennoten naar hun eigen kapitaal/);

  // Een eenmanszaak die eerst een vof was.
  const eenmanszaak = await close.plan!(ctx({ fiscal_years: jaar('eenmanszaak'), company_settings: [{ year_result_account_code: '0500', legal_form: 'eenmanszaak' }] }, zonderVerdeling(true)), { fiscal_year_id: ID });
  assert.match(eenmanszaak.sub, /naar 0500; privé \(0550\/0560\) naar 0500 Eigen vermogen; het privé van de vennoten naar hun eigen kapitaal/);

  // Een gewone eenmanszaak: geen woord over vennoten.
  const gewoon = await close.plan!(ctx({ fiscal_years: jaar('eenmanszaak'), company_settings: [{ year_result_account_code: '0500', legal_form: 'eenmanszaak' }] }, zonderVerdeling(false)), { fiscal_year_id: ID });
  assert.doesNotMatch(gewoon.sub, /vennoten/);
});

test('de kapitaalvergelijking geeft de uren per vennoot alleen aan wie Uren mag lezen', async () => {
  const overview = action(BUSINESS_ACTIONS, 'owners.equity_overview');
  const rows = {
    partnership_partners: [{ id: ID, partner_number: 1, name: 'Anna', profit_share_basis_points: 10000, kind: 'beherend', is_active: true, user_id: '00000000-0000-0000-0000-0000000000a1' }],
  };
  const overzicht = { fiscalYear: { id: ID, label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'open' } };
  const uren = [{ partner_id: ID, user_id: '00000000-0000-0000-0000-0000000000a1', direct_minutes: 600, indirect_minutes: 120, first_entry_date: '2026-02-01' }];

  // Zonder Uren: geen aanroep van partnership_partner_hours (de nep-database
  // gooit bij een onverwachte rpc), en hours is null.
  const boekjaren = [{ id: ID, label: '2026', period_start: '2026-01-01', period_end: '2026-12-31', status: 'open' }];
  const zonder = { ...ctx(rows, { list_fiscal_years: boekjaren, owners_equity_overview: overzicht }), canRead: (module: string) => module !== 'time' };
  const a = await overview.read!(zonder, { fiscal_year_id: ID }) as { hours: unknown; partners: Array<{ user_id: string }> };
  assert.equal(a.hours, null);
  assert.equal(a.partners[0].user_id, '00000000-0000-0000-0000-0000000000a1');

  const met = ctx(rows, { list_fiscal_years: boekjaren, owners_equity_overview: overzicht, partnership_partner_hours: uren });
  const b = await overview.read!(met, { fiscal_year_id: ID }) as { hours: { year: number; criterionMinutes: number; partners: unknown[] } };
  assert.equal(b.hours.year, 2026);
  assert.equal(b.hours.criterionMinutes, 1225 * 60);
  assert.deepEqual(b.hours.partners, uren);
});

test('privé betaald via Gerrie: alleen bij IB, en bij een vof met vennoten de vennoot kiezen', async () => {
  const pay = action(BOOKKEEPING_ACTIONS, 'purchase_invoice.pay_privately');
  const invoice = { internal_number: 'INK-1', supplier_invoice_number: 'VD-1077', supplier_id: null, date: '2025-10-10', status: 'booked', payment_status: 'unpaid', total_cents: 12100, journal_entry_id: ID };
  const bram = { id: ID, name: 'Bram', is_active: true };
  const open = (cents: number) => ({ purchase_invoice_open_payable_cents: cents });
  await assert.rejects(pay.plan!(ctx({ purchase_invoices: [invoice], company_settings: [{ legal_form: 'bv' }] }, open(12100)), { purchase_invoice_id: ID }),
    (error: unknown) => error instanceof ActionError && /alleen bij een eenmanszaak, vof/.test(error.message));
  await assert.rejects(pay.plan!(ctx({ purchase_invoices: [invoice], company_settings: [{ legal_form: 'vof' }], partnership_partners: [bram] }, open(12100)), { purchase_invoice_id: ID }),
    (error: unknown) => error instanceof ActionError && /Kies de vennoot/.test(error.message));
  const plan = await pay.plan!(ctx({ purchase_invoices: [invoice], company_settings: [{ legal_form: 'vof' }], partnership_partners: [bram] }, open(12100)), { purchase_invoice_id: ID, partner_id: ID });
  assert.match(plan.sub, /betaald door Bram/);
  assert.equal(plan.payload.date, '2025-10-10', 'standaard de factuurdatum');
  // Het open bedrag, niet het factuurtotaal (20261122100000): na € 50 via de bank.
  const rest = await pay.plan!(ctx({ purchase_invoices: [invoice], company_settings: [{ legal_form: 'vof' }], partnership_partners: [bram] }, open(7100)), { purchase_invoice_id: ID, partner_id: ID });
  assert.match(rest.sub, /€\s71,00 openstaand \(factuur €\s121,00\) betaald door Bram/);
  // De factuurdatum in een afgesloten boekjaar: de eerste dag daarna.
  const dicht = await pay.plan!(ctx({ purchase_invoices: [invoice], company_settings: [{ legal_form: 'vof' }], partnership_partners: [bram], closed_periods: [{ period_start: '2025-01-01', period_end: '2025-12-31' }] }, open(12100)), { purchase_invoice_id: ID, partner_id: ID });
  assert.equal(dicht.payload.date, '2026-01-01');
  // Twee afgesloten jaren op rij: door tot na het tweede.
  const tweeDicht = await pay.plan!(ctx({ purchase_invoices: [invoice], company_settings: [{ legal_form: 'vof' }], partnership_partners: [bram], closed_periods: [
    { period_start: '2025-01-01', period_end: '2025-12-31' }, { period_start: '2026-01-01', period_end: '2026-12-31' },
  ] }, open(12100)), { purchase_invoice_id: ID, partner_id: ID });
  assert.equal(tweeDicht.payload.date, '2027-01-01');
  assert.match(dicht.sub, /valt in een afgesloten boekjaar/);
  // Een creditnota die op de rekening van Bram terugkwam: privé ontvangen.
  const credit = await pay.plan!(ctx({ purchase_invoices: [{ ...invoice, total_cents: -12100 }], company_settings: [{ legal_form: 'vof' }], partnership_partners: [bram] }, open(-12100)), { purchase_invoice_id: ID, partner_id: ID });
  assert.match(credit.title, /Creditnota INK-1 als privé ontvangen vastleggen/);
  assert.match(credit.sub, /€\s121,00 terugontvangen door Bram \(privé-opnamen van de vennoot\)/);
  assert.equal(credit.payload.refund, true);
  await assert.rejects(pay.plan!(ctx({ purchase_invoices: [invoice], company_settings: [{ legal_form: 'vof' }], partnership_partners: [bram] }, open(0)), { purchase_invoice_id: ID, partner_id: ID }),
    (error: unknown) => error instanceof ActionError && /niets meer open/.test(error.message));
  await assert.rejects(pay.plan!(ctx({ purchase_invoices: [{ ...invoice, payment_status: 'paid' }], company_settings: [{ legal_form: 'vof' }] }), { purchase_invoice_id: ID }),
    (error: unknown) => error instanceof ActionError && /al betaald/.test(error.message));
  await assert.rejects(pay.plan!(ctx({ purchase_invoices: [{ ...invoice, status: 'draft', journal_entry_id: null }], company_settings: [{ legal_form: 'eenmanszaak' }] }), { purchase_invoice_id: ID }),
    (error: unknown) => error instanceof ActionError && /Boek de inkoopfactuur eerst/.test(error.message));
});

test('vennoot vastleggen via Gerrie: alleen bij een vof, met de verdeling op de kaart', async () => {
  const save = action(BUSINESS_ACTIONS, 'owners.save_partner');
  await assert.rejects(save.plan!(ctx({ company_settings: [{ legal_form: 'eenmanszaak' }] }), { name: 'Anna', profit_share_percent: 60 }),
    (error: unknown) => error instanceof ActionError && /horen bij een vof/.test(error.message));
  const rows = {
    company_settings: [{ legal_form: 'vof' }],
    partnership_partners: [{ id: 'c0000000-0000-4000-8000-000000000002', name: 'Bram', profit_share_basis_points: 4000, kind: 'beherend', is_active: true, user_id: null }],
  };
  const plan = await save.plan!(ctx(rows), { name: 'Anna', profit_share_percent: 60 });
  assert.match(plan.title, /Vennoot Anna vastleggen/);
  assert.match(plan.sub, /verdeling actieve vennoten daarna 100%/);
  assert.equal(plan.payload.profit_share_basis_points, 6000);
  // Een vorig jaar dat nog open staat: de kaart zegt dat de wijziging vanaf nu geldt.
  const metOpenJaar = await save.plan!(ctx({ ...rows, fiscal_years: [{ id: ID, label: '2025', period_end: '2025-12-31', status: 'open' }] }), { name: 'Anna', profit_share_percent: 60 });
  assert.match(metOpenJaar.sub, /geldt vanaf nu; 2025 staat nog open/);
  // Na de overstap van cv naar vof: een commanditaire vennoot laten uittreden
  // gaf een 422; nu wordt hij beherend.
  const vroegerCv = { ...rows, partnership_partners: [{ ...rows.partnership_partners[0], kind: 'commanditair' }] };
  const uit = await save.plan!(ctx(vroegerCv), { partner_id: 'c0000000-0000-4000-8000-000000000002', is_active: false });
  assert.equal(uit.payload.kind, 'beherend');
  const krap = await save.plan!(ctx(rows), { name: 'Anna', profit_share_percent: 50 });
  assert.match(krap.sub, /daarna 90% \(bij het afsluiten moet dat 100% zijn\)/);
  await assert.rejects(save.plan!(ctx(rows), { name: 'Anna', profit_share_percent: 60, kind: 'commanditair' }),
    (error: unknown) => error instanceof ActionError && /alleen bij een cv/.test(error.message));
  const metBoekhouder = { ...rows, organization_members: [{ email: 'boekhouder@kantoor.test', role: 'accountant', status: 'active' }] };
  await assert.rejects(save.plan!(ctx(metBoekhouder), { name: 'Anna', profit_share_percent: 60, user_id: '00000000-0000-0000-0000-0000000000b1' }),
    (error: unknown) => error instanceof ActionError && /boekhouder/.test(error.message));
});

// ── Foutmeldingen ────────────────────────────────────────────────────────

test('databasetekst gaat niet naar de browser; een eigen melding wel', () => {
  assert.equal(publicActionError('Factuur ophalen mislukt: duplicate key value violates unique constraint "x"').message,
    'Factuur ophalen mislukt: de invoer past niet bij de regels van ResoFly.');
  assert.equal(publicActionError('Databasefunctie x mislukt: relation "invoices" does not exist').message, 'Databasefunctie x mislukt.');
  assert.equal(publicActionError('Deze aanmaning is al verstuurd.').message, 'Deze aanmaning is al verstuurd.');
});

// ── Contract-, offerte- en factuurcontrole (5 november 2026) ─────────────

test('geen herinnering of aanmaning voor een concept, en geen aanmaning vóór de vervaldatum', async () => {
  const draft = { number: 'FAC-1', status: 'draft', client_id: null, due_date: '2026-10-01', reminder_level: 0, reminders_paused: false, lines: [], total_amount: 100 };
  const remind = action(FINANCE_ACTIONS, 'invoice.send_reminder');
  await assert.rejects(remind.plan!(ctx({ invoices: [draft] }), { invoice_id: ID }), /concept/);
  const dunning = action(FINANCE_ACTIONS, 'invoice.propose_dunning');
  await assert.rejects(dunning.plan!(ctx({ invoices: [draft] }), { invoice_id: ID }), /concept/);
  const notYetDue = { ...draft, status: 'sent', due_date: '2026-11-20' };
  await assert.rejects(dunning.plan!(ctx({ invoices: [notYetDue], invoice_dunning_notices: [] }), { invoice_id: ID }), /nog niet vervallen/);
});

test('"betaald" voor een ongeboekte factuur: alleen als hij in de beginbalans zit', async () => {
  const setStatus = action(FINANCE_ACTIONS, 'invoice.set_status');
  const invoice = { number: 'F-2', status: 'sent', client_id: null, date: '2026-10-01', due_date: null, lines: [{ quantity: 1, unit_price: 100, vat: 21 }], total_amount: 121, journal_entry_id: null };
  // Zonder startdatum, of met een startdatum ervóór, boekt de database de
  // factuur bij "betaald" meteen, maar de betaling niet.
  await assert.rejects(setStatus.plan!(ctx({ invoices: [invoice] }), { invoice_id: ID, status: 'paid' }),
    (error: unknown) => error instanceof ActionError && /invoice\.reconcile_bank_transaction/.test(error.message));
  await assert.rejects(setStatus.plan!(ctx({ invoices: [invoice], company_settings: [{ bookkeeping_start_date: '2026-01-01' }] }), { invoice_id: ID, status: 'paid' }), ActionError);
  const plan = await setStatus.plan!(ctx({ invoices: [invoice], company_settings: [{ bookkeeping_start_date: '2026-11-01' }] }), { invoice_id: ID, status: 'paid' });
  assert.equal(plan.payload.status, 'paid');
});

test('een ander e-factuuradres gaat altijd langs een mens, met oud → nieuw', async () => {
  const update = action(CLIENT_ACTIONS, 'client.update_details');
  const rows = { clients: [{ name: 'Jansen BV', e_invoicing_enabled: true, e_invoice_email: 'facturen@jansen.nl', e_invoice_channel: 'email' }] };
  const plan = await update.plan!(ctx(rows), { client_id: ID, e_invoice_email: 'Boekhouding@Elders.nl' });
  assert.equal(plan.humanOnly, true);
  assert.equal(plan.risk, 'high');
  assert.match(plan.sub, /facturen@jansen\.nl → boekhouding@elders\.nl/);
  // Hetzelfde adres opnieuw: de facturen gaan nergens anders heen.
  const same = await update.plan!(ctx(rows), { client_id: ID, e_invoice_email: 'facturen@jansen.nl' });
  assert.equal(same.humanOnly, undefined);
  const channel = await update.plan!(ctx(rows), { client_id: ID, e_invoice_channel: 'mollie' });
  assert.equal(channel.humanOnly, true);
  const city = await update.plan!(ctx(rows), { client_id: ID, city: 'Zwolle' });
  assert.equal(city.humanOnly, undefined);
  assert.equal(city.risk, undefined);
});

test('een creditnota gaat naar het adres dat de server kiest: bij e-facturatie het e-factuuradres', async () => {
  const send = action(FINANCE_ACTIONS, 'credit_note.send');
  const client = { name: 'Jansen BV', email: 'info@jansen.nl', e_invoicing_enabled: true, e_invoice_email: 'facturen@jansen.nl', e_invoice_channel: 'email' };
  const rows = {
    credit_notes: [{ number: 'CN-1', invoice_id: ID, total_amount: -121, status: 'issued', date: '2026-11-01', reason: 'Fout' }],
    invoices: [{ number: 'F-1', client_id: ID }],
    clients: [client],
  };
  const eInvoice = await send.plan!(ctx(rows), { credit_note_id: ID });
  assert.equal(eInvoice.payload.email, 'facturen@jansen.nl');
  assert.match(eInvoice.sub, /facturen@jansen\.nl/);
  const plain = await send.plan!(ctx({ ...rows, clients: [{ ...client, e_invoicing_enabled: false }] }), { credit_note_id: ID });
  assert.equal(plain.payload.email, 'info@jansen.nl');
});

test('contract ter ondertekening: de ontvanger vooraan, een ander adres met waarschuwing', async () => {
  const send = action(MARKETING_ACTIONS, 'contract.send_for_signature');
  const contract = {
    number: 'C-12', title: 'Onderhoudsovereenkomst '.repeat(8), status: 'draft', client_id: ID,
    body: '<p>Inhoud</p>', editor_mode: 'rich', body_storage_key: null, valid_until: null, amount_cents: 100000,
  };
  const rows = { contracts: [contract], clients: [{ name: 'Jansen BV', email: 'info@jansen.nl', contact_name: 'Kees' }], contract_signers: [] };
  const normal = await send.plan!(ctx(rows), { contract_id: ID });
  assert.match(normal.title, /info@jansen\.nl/);
  assert.equal(normal.warning, undefined);
  const other = await send.plan!(ctx(rows), { contract_id: ID, recipient_email: 'ops@elders.example' });
  assert.match(other.title, /ops@elders\.example/, 'het adres staat in de titel, niet achter een lange contracttitel');
  assert.match(other.warning ?? '', /niet het adres van Jansen BV/);
  // Een herinnering gaat naar wie de vorige link kreeg, niet stil naar info@.
  const resend = await send.plan!(ctx({
    ...rows,
    contracts: [{ ...contract, status: 'sent' }],
    contract_signers: [{ name: 'Directeur', email: 'directeur@jansen.nl' }],
  }), { contract_id: ID });
  assert.equal(resend.payload.recipient_email, 'directeur@jansen.nl');
  assert.equal(resend.payload.recipient_name, 'Directeur');
  assert.equal(resend.warning, undefined);
});
