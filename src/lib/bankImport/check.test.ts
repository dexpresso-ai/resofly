/**
 * De controle vóór het inlezen (check.ts): hoort het afschrift bij de gekozen
 * rekening? En de melding als het afschrift niet met zichzelf klopt.
 * Draaien met: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedBankStatement, ParsedBankTransaction } from '../../types';
import { checkStatementAccount, describeStatementDifference, sameAccount } from './check.ts';

const tx = (account: string | null, amount: number, date = '2026-11-02'): ParsedBankTransaction => ({
  booking_date: date, value_date: null, amount_cents: amount, currency: 'EUR', counterparty_name: null, counterparty_iban: null,
  description: null, structured_reference: null, end_to_end_id: null, bank_tx_id: null, account,
});
const statement = (transactions: ParsedBankTransaction[], extra: Partial<ParsedBankStatement> = {}): ParsedBankStatement => ({
  format: 'camt053', file_name: 'x', file_hash: null, period_start: '2026-11-02', period_end: '2026-11-02',
  opening_balance_cents: 100000, closing_balance_cents: 110000, warnings: [], transactions, ...extra,
});

test('dezelfde rekening, hoe de bank hem ook noemt', () => {
  const iban = 'NL69 INGB 0123 4567 89';
  assert.ok(sameAccount('NL69INGB0123456789', iban));
  assert.ok(sameAccount('NL69INGB0123456789EUR', iban), 'ING MT940 :25:');
  assert.ok(sameAccount('NL11RABO0123456789 EUR', 'NL11RABO0123456789'), 'Rabobank MT940 :25:');
  assert.ok(sameAccount('INGBNL2A/NL69INGB0123456789', iban), 'met de BIC ervoor');
  assert.ok(sameAccount('517852257', 'NL12ABNA0517852257'), 'ABN AMRO: het oude rekeningnummer');
  assert.ok(!sameAccount('NL69INGB0987654321', iban), 'de spaarrekening');
  assert.ok(!sameAccount('V12345678', iban), 'een ING-spaarrekening (V-nummer)');
  assert.ok(!sameAccount('', iban));
  assert.ok(!sameAccount('NL69INGB0123456789', ''));
});

test('een afschrift van een andere rekening: eerst vragen', () => {
  const s = statement([tx('NL69INGB0123456789', 121000)]);
  const r = checkStatementAccount(s, 'NL69INGB0987654321');
  assert.equal(r.kind, 'ask');
  assert.match(r.kind === 'ask' ? r.message : '', /NL69INGB0123456789, niet van deze rekening \(NL69INGB0987654321\)/);
});

test('twee rekeningen in één bestand: alleen de eigen regels, met het saldo van die rekening', () => {
  const s = statement([tx('NL69INGB0123456789', 121000), tx('NL69INGB0123456789', -4550), tx('NL69INGB0987654321', 500000)], {
    accounts: [
      { account: 'NL69INGB0123456789', period_start: '2026-11-02', period_end: '2026-11-02', opening_balance_cents: 100000, closing_balance_cents: 216450 },
      { account: 'NL69INGB0987654321', period_start: '2026-11-02', period_end: '2026-11-02', opening_balance_cents: 1000000, closing_balance_cents: 1500000 },
    ],
  });
  const zakelijk = checkStatementAccount(s, 'NL69INGB0123456789');
  assert.equal(zakelijk.kind, 'ok');
  if (zakelijk.kind !== 'ok') return;
  assert.deepEqual(zakelijk.statement.transactions.map(t => t.amount_cents), [121000, -4550]);
  assert.equal(zakelijk.statement.closing_balance_cents, 216450);
  assert.match(zakelijk.notes.join(' '), /1 regel\(s\) van een andere rekening \(NL69INGB0987654321\) niet ingelezen/);

  const spaar = checkStatementAccount(s, 'NL69INGB0987654321');
  assert.equal(spaar.kind, 'ok');
  if (spaar.kind !== 'ok') return;
  assert.deepEqual(spaar.statement.transactions.map(t => t.amount_cents), [500000]);
  assert.equal(spaar.statement.opening_balance_cents, 1000000, 'niet het beginsaldo van de andere rekening');
  assert.equal(spaar.statement.closing_balance_cents, 1500000);
});

test('twee rekeningen in een CSV (geen saldo per rekening): geen saldo, de periode van de eigen regels', () => {
  const s = statement([tx('NL11RABO0123456789', 121000, '2026-11-02'), tx('NL22RABO0987654321', 500000, '2026-11-05')],
    { format: 'csv', period_end: '2026-11-05', opening_balance_cents: null, closing_balance_cents: null });
  const r = checkStatementAccount(s, 'NL11RABO0123456789');
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.statement.transactions.length, 1);
  assert.equal(r.statement.period_end, '2026-11-02');
  assert.equal(r.statement.closing_balance_cents, null);
});

test('twee rekeningen en de gekozen rekening heeft geen IBAN: weigeren', () => {
  const s = statement([tx('NL11RABO0123456789', 121000), tx('NL22RABO0987654321', 500000)]);
  const r = checkStatementAccount(s, null);
  assert.equal(r.kind, 'refuse');
  assert.match(r.kind === 'refuse' ? r.message : '', /Vul bij deze bankrekening het IBAN in/);
});

test('een bestand zonder eigen rekening (de meeste CSV\'s) verandert niet', () => {
  const s = statement([tx(null, 121000)]);
  const r = checkStatementAccount(s, 'NL69INGB0123456789');
  assert.deepEqual(r, { kind: 'ok', statement: s, notes: [] });
});

test('de melding bij een afschrift dat niet klopt, wijst de goede kant op', () => {
  const euro = (c: number) => `€ ${(c / 100).toFixed(2).replace('.', ',')}`;
  // Eindsaldo hoger dan begin + mutaties: er staat een afschrijving dubbel
  // (zoals de incasso die via de koppeling én het afschrift binnenkwam), of
  // er ontbreekt een bijschrijving. Eerder: altijd "er ontbreken transacties".
  const hoger = describeStatementDifference(4550, euro);
  assert.match(hoger, /€ 45,50 lager uit dan het eindsaldo/);
  assert.match(hoger, /afschrijving dubbel/);
  assert.match(hoger, /Dubbele verwijderen/);
  const lager = describeStatementDifference(-4550, euro);
  assert.match(lager, /€ 45,50 hoger uit dan het eindsaldo/);
  assert.match(lager, /bijschrijving dubbel/);
  assert.doesNotMatch(hoger + lager, /Er ontbreken transacties/);
});
