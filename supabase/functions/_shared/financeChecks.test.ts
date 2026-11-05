import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from './actions/index.ts';
import { BOOKKEEPING_ACTIONS } from './actions/bookkeeping.ts';
import { FINANCE_ACTIONS } from './actions/finance.ts';
import { BUSINESS_ACTIONS } from './actions/business.ts';
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
    fiscal_years: [{ label: '2025', period_start: '2025-01-01', period_end: '2025-12-31', status: 'open' }],
    company_settings: [{ year_result_account_code: '0510', legal_form: 'vof' }],
    partnership_partners: [{ name: 'Anna', profit_share_basis_points: 6000 }, { name: 'Bram', profit_share_basis_points: 3000 }],
  };
  await assert.rejects(close.plan!(ctx(rows, { list_fiscal_years: [{ id: ID, computed_result_cents: 100000 }] }), { fiscal_year_id: ID }),
    (error: unknown) => error instanceof ActionError && /90% in plaats van 100%/.test(error.message));
  const ok = { ...rows, partnership_partners: [{ name: 'Anna', profit_share_basis_points: 6000 }, { name: 'Bram', profit_share_basis_points: 4000 }] };
  const plan = await close.plan!(ctx(ok, { list_fiscal_years: [{ id: ID, computed_result_cents: 100000 }] }), { fiscal_year_id: ID });
  assert.match(plan.sub, /kapitaalrekeningen van 2 vennoten/);
});

// ── Foutmeldingen ────────────────────────────────────────────────────────

test('databasetekst gaat niet naar de browser; een eigen melding wel', () => {
  assert.equal(publicActionError('Factuur ophalen mislukt: duplicate key value violates unique constraint "x"').message,
    'Factuur ophalen mislukt: de invoer past niet bij de regels van ResoFly.');
  assert.equal(publicActionError('Databasefunctie x mislukt: relation "invoices" does not exist').message, 'Databasefunctie x mislukt.');
  assert.equal(publicActionError('Deze aanmaning is al verstuurd.').message, 'Deze aanmaning is al verstuurd.');
});
