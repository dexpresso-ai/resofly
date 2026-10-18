import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decimalToCents, isBookedEbTransaction, mapEbTransaction, pickBookedBalance, prepareEbTransactions,
} from './enableBanking.ts';

/**
 * Wat er van Enable Banking binnenkomt, bepaalt wat er geboekt kan worden. Een
 * pending-transactie die als echte binnenkomt, of een afschrijving die als
 * ontvangst binnenkomt, valt pas op bij de jaarrekening — tenzij het saldo dat
 * de bank zelf opgeeft naast de boekhouding wordt gelegd.
 */

const tx = (overrides: Record<string, unknown> = {}) => ({
  entry_reference: 'ref-1',
  transaction_amount: { amount: '121.00', currency: 'EUR' },
  credit_debit_indicator: 'CRDT',
  status: 'BOOK',
  booking_date: '2026-10-14',
  value_date: '2026-10-15',
  debtor: { name: 'Klant BV' },
  debtor_account: { iban: 'NL02RABO0123456789' },
  creditor: { name: 'Wij BV' },
  creditor_account: { iban: 'NL91ABNA0417164300' },
  remittance_information: ['Factuur 2026-014', 'dank'],
  ...overrides,
});

test('bedragen naar centen, zonder afrondingslek', () => {
  assert.equal(decimalToCents('121.00'), 12100);
  assert.equal(decimalToCents('0.29'), 29);
  assert.equal(decimalToCents('-12.5'), -1250);
  assert.equal(decimalToCents(7), 700);
  for (const bad of ['', '  ', 'abc', null, undefined, '1,23']) assert.equal(decimalToCents(bad), null, String(bad));
});

test('ontvangst: positief, met de betaler als tegenpartij', () => {
  const m = mapEbTransaction(tx());
  assert.ok(m);
  assert.equal(m.amount_cents, 12100);
  assert.equal(m.counterparty_name, 'Klant BV');
  assert.equal(m.counterparty_iban, 'NL02RABO0123456789');
  assert.equal(m.description, 'Factuur 2026-014 dank');
  assert.equal(m.booking_date, '2026-10-14');
  assert.equal(m.value_date, '2026-10-15');
  assert.equal(m.bank_tx_id, 'ref-1');
  assert.equal('dedup_key' in m, false, 'de sleutel wordt server-side afgeleid');
});

test('afschrijving: negatief, met de ontvanger als tegenpartij', () => {
  const m = mapEbTransaction(tx({ credit_debit_indicator: 'DBIT' }));
  assert.equal(m?.amount_cents, -12100);
  assert.equal(m?.counterparty_name, 'Wij BV');
  // Ook als de bank het teken al in het bedrag zet: niet dubbel omdraaien.
  assert.equal(mapEbTransaction(tx({ credit_debit_indicator: 'DBIT', transaction_amount: { amount: '-121.00', currency: 'EUR' } }))?.amount_cents, -12100);
  assert.equal(mapEbTransaction(tx({ credit_debit_indicator: 'CRDT', transaction_amount: { amount: '-121.00', currency: 'EUR' } }))?.amount_cents, 12100);
});

test('zonder indicator volgt het teken het bedrag (was: altijd een ontvangst)', () => {
  const out = mapEbTransaction(tx({ credit_debit_indicator: undefined, transaction_amount: { amount: '-45.10', currency: 'EUR' } }));
  assert.equal(out?.amount_cents, -4510);
  assert.equal(out?.counterparty_name, 'Wij BV', 'bij een afschrijving is de crediteur de tegenpartij');
  assert.equal(mapEbTransaction(tx({ credit_debit_indicator: '', transaction_amount: { amount: '45.10', currency: 'EUR' } }))?.amount_cents, 4510);
});

test('boekdatum: booking_date, anders value_date, anders transaction_date; geen datum = niet boekbaar', () => {
  assert.equal(mapEbTransaction(tx({ booking_date: null }))?.booking_date, '2026-10-15');
  assert.equal(mapEbTransaction(tx({ booking_date: null, value_date: null, transaction_date: '2026-10-13T09:00:00Z' }))?.booking_date, '2026-10-13');
  assert.equal(mapEbTransaction(tx({ booking_date: null, value_date: null, transaction_date: null })), null);
  assert.equal(mapEbTransaction(tx({ booking_date: 'gisteren', value_date: null })), null);
});

test('€ 0,00 of geen bedrag: niet boekbaar', () => {
  assert.equal(mapEbTransaction(tx({ transaction_amount: { amount: '0.00', currency: 'EUR' } })), null);
  assert.equal(mapEbTransaction(tx({ transaction_amount: {} })), null);
});

test('alleen geboekte transacties komen binnen', () => {
  assert.equal(isBookedEbTransaction(tx()), true);
  assert.equal(isBookedEbTransaction(tx({ status: undefined })), true, 'zonder status: geboekt');
  assert.equal(isBookedEbTransaction(tx({ status: 'book' })), true);
  for (const status of ['PDNG', 'pdng', 'CNCL', 'RJCT', 'SCHD', 'HOLD', 'OTHR']) {
    assert.equal(isBookedEbTransaction(tx({ status })), false, status);
  }
});

test('een batch: pending en onbruikbare regels geteld, niet ingelezen', () => {
  const out = prepareEbTransactions([
    tx(),
    tx({ status: 'PDNG', booking_date: null }),
    tx({ status: 'PDNG' }),
    tx({ transaction_amount: { amount: '0', currency: 'EUR' } }),
    tx({ credit_debit_indicator: 'DBIT', entry_reference: 'ref-2' }),
  ]);
  assert.equal(out.transactions.length, 2);
  assert.equal(out.pending, 2);
  assert.equal(out.unusable, 1);
  assert.deepEqual(prepareEbTransactions(undefined), { transactions: [], pending: 0, unusable: 0 });
});

const bal = (balance_type: string, amount: string, extra: Record<string, unknown> = {}) =>
  ({ balance_type, balance_amount: { amount, currency: 'EUR' }, ...extra });

test('saldo: het geboekte eindsaldo op zijn peildatum', () => {
  const picked = pickBookedBalance([
    bal('CLAV', '9999.00', { reference_date: '2026-10-17' }),   // beschikbaar: incl. kredietlimiet
    bal('XPCD', '1300.00', { reference_date: '2026-10-17' }),   // verwacht: incl. pending
    bal('CLBD', '1250.40', { reference_date: '2026-10-16' }),
  ], 'EUR', '2026-10-17');
  assert.deepEqual(picked, { amount_cents: 125040, date: '2026-10-16', type: 'CLBD' });
});

test('saldo: een recenter tussensaldo gaat voor, op dezelfde dag het eindsaldo', () => {
  assert.equal(pickBookedBalance([
    bal('CLBD', '100.00', { reference_date: '2026-10-16' }),
    bal('ITBD', '150.00', { reference_date: '2026-10-17' }),
  ], 'EUR', '2026-10-17')?.type, 'ITBD');
  assert.equal(pickBookedBalance([
    bal('ITBD', '150.00', { reference_date: '2026-10-16' }),
    bal('CLBD', '100.00', { reference_date: '2026-10-16' }),
  ], 'EUR', '2026-10-17')?.type, 'CLBD');
});

test('saldo: datum ontbreekt', () => {
  // Een eindsaldo zonder datum is niet aan te sluiten.
  assert.equal(pickBookedBalance([bal('CLBD', '100.00')], 'EUR', '2026-10-17'), null);
  // Een tussensaldo zonder datum geldt nu: laatste wijziging, anders vandaag.
  assert.equal(pickBookedBalance([bal('ITBD', '100.00', { last_change_date_time: '2026-10-15T12:00:00Z' })], 'EUR', '2026-10-17')?.date, '2026-10-15');
  assert.equal(pickBookedBalance([bal('ITBD', '100.00')], 'EUR', '2026-10-17')?.date, '2026-10-17');
});

test('saldo: beginsaldo geldt als eindsaldo van de dag ervoor', () => {
  assert.deepEqual(pickBookedBalance([bal('OPBD', '-20.00', { reference_date: '2026-11-01' })], 'EUR', '2026-11-01'),
    { amount_cents: -2000, date: '2026-10-31', type: 'OPBD' });
});

test('saldo: andere valuta, alleen beschikbaar of niets bruikbaars → geen saldo', () => {
  assert.equal(pickBookedBalance([{ balance_type: 'CLBD', balance_amount: { amount: '5.00', currency: 'USD' }, reference_date: '2026-10-16' }], 'EUR', '2026-10-17'), null);
  assert.equal(pickBookedBalance([bal('CLAV', '5.00', { reference_date: '2026-10-16' }), bal('ITAV', '5.00')], 'EUR', '2026-10-17'), null);
  assert.equal(pickBookedBalance(undefined, 'EUR', '2026-10-17'), null);
  assert.equal(pickBookedBalance([bal('CLBD', 'n.v.t.', { reference_date: '2026-10-16' })], 'EUR', '2026-10-17'), null);
});

test('bank-sync gebruikt deze functies en legt het saldo vast', () => {
  const source = readFileSync(new URL('../bank-sync/index.ts', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/_shared\/enableBanking\.ts'/);
  assert.match(source, /prepareEbTransactions\(raw\)/, 'transacties lopen door het filter op geboekt');
  assert.match(source, /pickBookedBalance\(/);
  assert.match(source, /rpc\('record_bank_balance'/);
  assert.doesNotMatch(source, /function mapEbTransaction/, 'geen tweede, afwijkende mapping in de edge function');
  // Een al gekoppelde requisition wordt niet opnieuw afgerond of op 'error' gezet.
  assert.match(source, /reqRow\.status === 'linked'/);
  assert.match(source, /\.in\('status', \['created', 'error'\]\)/);
});
