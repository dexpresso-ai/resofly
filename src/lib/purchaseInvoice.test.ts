import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanLineVat, computedLineVat, draftRemoval, invoiceDateConcern, isPurchaseVatCode, lineVatEditable, purchaseLineTotals,
  purchaseTotalsOptions, purchaseVatChoices, withLineVat, DEDUCTIBLE_VAT_KINDS, PURCHASE_VAT_KINDS, SELF_ASSESSED_VAT_KINDS,
} from './purchaseInvoice.ts';
import * as server from '../../supabase/functions/_shared/invoiceInboxRules.ts';

/**
 * Inkoopfacturen in het scherm (controle eenmanszaak, 2026-11-19): alleen
 * inkoopcodes in de keuzelijst, verlegde btw buiten het totaal, het btw-bedrag
 * van de leverancier, een onwaarschijnlijke datum en het weggooien van een
 * concept. De rekenregels staan ook in de edge functions
 * (_shared/invoiceInboxRules.ts, de AI-route): de eerste tests houden de twee
 * gelijk. Lopen ze uiteen, dan toont het formulier een ander totaal dan het
 * concept dat Gerrie klaarzette.
 */

const CODES = [
  { id: '1', code: 'EU_VERW', label: 'Verwerving EU (verlegd)', rate: 21, kind: 'eu_acquisition', sales_box: '4b', is_active: true },
  { id: '2', code: 'EXPORT', label: 'Export buiten EU (0%)', rate: 0, kind: 'zero', sales_box: '3a', is_active: true },
  { id: '3', code: 'HOOG', label: 'BTW 21%', rate: 21, kind: 'standard', sales_box: '1a', is_active: true },
  { id: '4', code: 'ICP_DIENST', label: 'ICP diensten', rate: 0, kind: 'icp_services', sales_box: '3b', is_active: true },
  { id: '5', code: 'ICP_GOED', label: 'ICP goederen', rate: 0, kind: 'icp_goods', sales_box: '3b', is_active: true },
  { id: '6', code: 'IMPORT', label: 'Invoer buiten EU (verlegd, art. 23)', rate: 21, kind: 'import_non_eu', sales_box: '4a', is_active: true },
  { id: '7', code: 'KOR', label: 'KOR (vrijgesteld, geen aftrek)', rate: 0, kind: 'kor', sales_box: null, is_active: true },
  { id: '8', code: 'LAAG', label: 'BTW 9%', rate: 9, kind: 'reduced', sales_box: '1b', is_active: true },
  { id: '9', code: 'NUL', label: 'BTW 0%', rate: 0, kind: 'zero', sales_box: '1e', is_active: true },
  { id: '10', code: 'VERL_INK', label: 'BTW verlegd (inkoop)', rate: 21, kind: 'reverse_charge_purchase', sales_box: '2a', is_active: true },
  { id: '11', code: 'VERL_VERK', label: 'BTW verlegd (verkoop)', rate: 0, kind: 'reverse_charge_sales', sales_box: '1e', is_active: true },
  { id: '12', code: 'VRIJ', label: 'Vrijgesteld', rate: 0, kind: 'exempt', sales_box: null, is_active: true },
] as const;
type Code = (typeof CODES)[number];
const codes = CODES as unknown as Array<{ id: string; code: string; label: string; rate: number; kind: Code['kind']; sales_box: string | null; is_active: boolean }>;

const regel = (amount_cents: number, vat_code = 'HOOG', vat_rate = 21, extra: Record<string, unknown> = {}) =>
  ({ id: `r-${amount_cents}-${vat_code}`, description: 'regel', amount_cents, vat_code, vat_rate, account_id: null as string | null, ...extra });

// ── Gelijk aan de edge functions ────────────────────────────────────────────

test('de soorten btw-code zijn gelijk aan die van de edge functions', () => {
  assert.deepEqual(PURCHASE_VAT_KINDS, server.PURCHASE_VAT_KINDS);
  assert.deepEqual(SELF_ASSESSED_VAT_KINDS, server.SELF_ASSESSED_VAT_KINDS);
  assert.deepEqual(DEDUCTIBLE_VAT_KINDS, server.DEDUCTIBLE_VAT_KINDS);
  for (const code of codes) assert.equal(isPurchaseVatCode(code), server.isPurchaseVatCode(code), code.code);
});

test('de totalen zijn gelijk aan die van de edge functions, voor elke code en met de KOR', () => {
  const sets = [
    [regel(10000)],
    [regel(103), regel(103), regel(826, 'HOOG', 21, { vat_cents: 174 })],
    [regel(103, 'HOOG', 21, { account_id: 'a' }), regel(103, 'HOOG', 21, { account_id: 'b' }), regel(4999, 'LAAG', 9)],
    [regel(-1050), regel(-333, 'LAAG', 9)],
    ...codes.map(c => [regel(12345, c.code, c.rate, { vat_cents: 7 }), regel(5000)]),
  ];
  for (const kor of [false, true]) {
    const options = purchaseTotalsOptions(codes, { kor, fallbackAccountId: 'acc-4500' });
    for (const lines of sets) {
      assert.deepEqual(purchaseLineTotals(lines, options), server.purchaseLineTotals(lines, options), JSON.stringify({ kor, lines }));
    }
  }
  assert.deepEqual(purchaseLineTotals([regel(10000, 'EU_VERW', 21)]), server.purchaseLineTotals([regel(10000, 'EU_VERW', 21)]));
});

test('de datumregel is gelijk aan die van de edge functions', () => {
  const dates = ['2026-11-16', '2026-11-19', '2026-11-20', '2062-11-16', '2025-12-31', '2025-11-18', '2025-11-19', '2019-01-01', '', 'x'];
  for (const options of [{ today: '2026-11-19', bookkeepingStart: '2026-01-01' }, { today: '2026-11-19', bookkeepingStart: null }, { today: '2026-11-19' }]) {
    for (const date of dates) assert.deepEqual(invoiceDateConcern(date, options), server.invoiceDateConcern(date, options), `${date} ${JSON.stringify(options)}`);
  }
});

// ── De keuzelijst ───────────────────────────────────────────────────────────

test('de keuzelijst van een inkoopregel toont alleen inkoopcodes', () => {
  assert.deepEqual(purchaseVatChoices(codes, 'HOOG').map(c => c.code.code), ['EU_VERW', 'HOOG', 'IMPORT', 'KOR', 'LAAG', 'NUL', 'VERL_INK', 'VRIJ']);
  assert.ok(purchaseVatChoices(codes, 'HOOG').every(c => !c.misplaced));
});

test('een bestaand concept met een verkoopcode toont die code nog, met een waarschuwing', () => {
  const choices = purchaseVatChoices(codes, 'ICP_DIENST');
  assert.deepEqual(choices.at(-1), { code: codes[3], misplaced: true });
  assert.equal(choices.filter(c => c.misplaced).length, 1);
  // Export is soort zero, maar omzet: ook die staat er alleen nog als hij al gekozen was.
  assert.equal(purchaseVatChoices(codes, 'EXPORT').at(-1)?.misplaced, true);
  // Een inkoopcode die intussen is uitgezet blijft zichtbaar, zonder waarschuwing.
  const uit = codes.map(c => (c.code === 'LAAG' ? { ...c, is_active: false } : c));
  assert.equal(purchaseVatChoices(uit, 'HOOG').some(c => c.code.code === 'LAAG'), false);
  assert.deepEqual(purchaseVatChoices(uit, 'LAAG').at(-1), { code: uit[7], misplaced: false });
  // Een code die niet (meer) bestaat komt er niet stil bij.
  assert.equal(purchaseVatChoices(codes, 'WEG').length, 8);
});

// ── Het btw-bedrag van de leverancier ───────────────────────────────────────

test('het btw-bedrag is alleen in te vullen bij gewone btw', () => {
  assert.equal(lineVatEditable('standard', 21), true);
  assert.equal(lineVatEditable('reduced', 9), true);
  assert.equal(lineVatEditable(undefined, 21), true); // onbekende code telt als gewone btw, net als in de database
  for (const kind of ['zero', 'exempt', 'kor', 'reverse_charge_purchase', 'eu_acquisition', 'import_non_eu', 'icp_services']) {
    assert.equal(lineVatEditable(kind, 21), false, kind);
  }
  assert.equal(lineVatEditable('standard', 0), false);
});

test('het btw-bedrag wordt alleen bewaard als het afwijkt van het berekende', () => {
  const bon = regel(826);
  assert.equal(computedLineVat(bon), 173);
  assert.equal(withLineVat(bon, 174).vat_cents, 174);
  assert.equal('vat_cents' in withLineVat(bon, 173), false);
  assert.equal('vat_cents' in withLineVat({ ...bon, vat_cents: 174 }, null), false);
  assert.equal('vat_cents' in withLineVat({ ...bon, vat_cents: 174 }, 173), false);
  // De invoer blijft ongemoeid, en de rest van de regel blijft staan.
  const met = withLineVat(bon, 174);
  assert.equal('vat_cents' in bon, false);
  assert.deepEqual({ ...met, vat_cents: undefined }, { ...bon, vat_cents: undefined });
});

test('het totaal van het formulier rekent met het ingevulde btw-bedrag', () => {
  const options = purchaseTotalsOptions(codes, { fallbackAccountId: 'acc-4500' });
  assert.equal(purchaseLineTotals([regel(826)], options).total_cents, 999);
  assert.equal(purchaseLineTotals([withLineVat(regel(826), 174)], options).total_cents, 1000);
});

test('bij opslaan blijft een btw-bedrag alleen staan waar de boeking het gebruikt', () => {
  const options = purchaseTotalsOptions(codes, {});
  const stored = cleanLineVat([
    regel(826, 'HOOG', 21, { vat_cents: 174 }),
    regel(826, 'HOOG', 21, { vat_cents: 173 }), // gelijk aan het berekende: weg
    regel(10000, 'EU_VERW', 21, { vat_cents: 5 }), // verlegd: de boeking negeert het
    regel(10000, 'NUL', 0, { vat_cents: 5 }), // 0%: de database weigert een btw-bedrag hier
    regel(500, 'LAAG', 9),
  ], options);
  assert.deepEqual(stored.map(l => ('vat_cents' in l ? l.vat_cents : 'geen')), [174, 'geen', 'geen', 'geen', 'geen']);
});

test('verlegde btw staat apart: € 100 blijft € 100, met € 21 om zelf aan te geven', () => {
  const options = purchaseTotalsOptions(codes, {});
  const totals = purchaseLineTotals([regel(10000, 'VERL_INK', 21)], options);
  assert.deepEqual([totals.vat_cents, totals.total_cents, totals.self_assessed_vat_cents], [0, 10000, 2100]);
});

// ── Een concept verwijderen ─────────────────────────────────────────────────

const facts = (over: Record<string, unknown> = {}) => ({ status: 'draft', entryNumbers: [] as string[], inboxItem: null, attachments: 0, ...over });

test('een kaal concept mag weg, na een vraag', () => {
  const plan = draftRemoval(facts());
  assert.equal(plan.kind, 'delete');
});

test('een geboekte factuur ligt vast', () => {
  const plan = draftRemoval(facts({ status: 'booked' }));
  assert.equal(plan.kind, 'blocked');
  assert.match((plan as { message: string }).message, /tegen bij Grootboek/);
});

test('een concept dat ooit geboekt was, blijft bewaard met zijn boekstukken', () => {
  const plan = draftRemoval(facts({ entryNumbers: ['JP-2026-00012', 'JP-2026-00019'], inboxItem: { id: 'i', channel: 'receipt' }, attachments: 1 }));
  assert.equal(plan.kind, 'blocked');
  assert.match((plan as { message: string }).message, /JP-2026-00012, JP-2026-00019/);
});

test('een declaratie wijs je af op de werklijst, met een reden', () => {
  const plan = draftRemoval(facts({ inboxItem: { id: 'i', channel: 'declaration' }, attachments: 1 }));
  assert.equal(plan.kind, 'blocked');
  assert.match((plan as { message: string }).message, /Afwijzen/);
});

test('een bon of mail van de werklijst: het concept gaat weg via Negeren, de foto blijft', () => {
  const bon = draftRemoval(facts({ inboxItem: { id: 'item-1', channel: 'receipt' }, attachments: 1 }));
  assert.deepEqual([bon.kind, (bon as { inboxId: string }).inboxId], ['discard_inbox_item', 'item-1']);
  assert.match((bon as { confirm: string }).confirm, /De bon blijft bewaard/);
  const mail = draftRemoval(facts({ inboxItem: { id: 'item-2', channel: 'email' }, attachments: 2 }));
  assert.match((mail as { confirm: string }).confirm, /De mail met de factuur blijft bewaard/);
});

test('een los bewijsstuk haal je eerst zelf weg', () => {
  const plan = draftRemoval(facts({ attachments: 1 }));
  assert.equal(plan.kind, 'blocked');
  assert.match((plan as { message: string }).message, /bewijsstuk/);
});
