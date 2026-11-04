import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceVatGroups, splitRefundOverVatGroups } from './creditNoteSplit.ts';

test('btw-groepen per code en tarief, btw per groep afgerond', () => {
  const groups = invoiceVatGroups([
    { quantity: 1, unit_price: 1000, vat: 21, vat_code: 'HOOG' },
    { quantity: 2, unit_price: 500, vat: 9, vat_code: 'LAAG' },
    { quantity: 1, unit_price: 300, vat: 0, vat_code: 'ICP_DIENST' },
  ]);
  assert.deepEqual(groups.map((g) => [g.vatCode, g.rate, g.baseCents, g.vatCents]), [
    ['HOOG', 21, 100000, 21000],
    ['LAAG', 9, 100000, 9000],
    ['ICP_DIENST', 0, 30000, 0],
  ]);
});

test('gedeeltelijke terugbetaling wordt naar rato over hoog en laag verdeeld (geen mengtarief)', () => {
  // € 1.000 hoog + € 1.000 laag = € 2.300 bruto; € 1.150 terug is precies de helft.
  const parts = splitRefundOverVatGroups([
    { quantity: 1, unit_price: 1000, vat: 21, vat_code: 'HOOG' },
    { quantity: 1, unit_price: 1000, vat: 9, vat_code: 'LAAG' },
  ], 115000);
  assert.deepEqual(parts.map((p) => [p.vatCode, p.rate, p.baseCents, p.vatCents]), [
    ['HOOG', 21, 50000, 10500],
    ['LAAG', 9, 50000, 4500],
  ]);
});

test('de delen tellen exact op tot het terugbetaalde bedrag', () => {
  const lines = [
    { quantity: 3, unit_price: 33.33, vat: 21, vat_code: 'HOOG' },
    { quantity: 7, unit_price: 12.49, vat: 9, vat_code: 'LAAG' },
    { quantity: 1, unit_price: 99.99, vat: 0, vat_code: 'ICP_GOED' },
  ];
  for (const amount of [1, 7, 999, 12345, 20001]) {
    const parts = splitRefundOverVatGroups(lines, amount);
    assert.equal(parts.reduce((s, p) => s + p.grossCents, 0), amount, `bedrag ${amount}`);
    for (const p of parts) assert.equal(p.baseCents + p.vatCents, p.grossCents);
  }
});

test('ICP-code blijft op de creditregel staan, zodat de ICP-opgaaf meecorrigeert', () => {
  const parts = splitRefundOverVatGroups([{ quantity: 1, unit_price: 500, vat: 0, vat_code: 'ICP_GOED' }], 20000);
  assert.deepEqual(parts, [{ rate: 0, vatCode: 'ICP_GOED', baseCents: 20000, vatCents: 0, grossCents: 20000 }]);
});

test('kortingsregels tellen niet mee in de verdeling; geen bedrag of geen positief totaal geeft niets', () => {
  const parts = splitRefundOverVatGroups([
    { quantity: 1, unit_price: 1000, vat: 21, vat_code: 'HOOG' },
    { quantity: 1, unit_price: -100, vat: 9, vat_code: 'LAAG' },
  ], 12100);
  assert.deepEqual(parts.map((p) => [p.vatCode, p.grossCents]), [['HOOG', 12100]]);
  assert.deepEqual(splitRefundOverVatGroups([{ quantity: 1, unit_price: 100, vat: 21 }], 0), []);
  assert.deepEqual(splitRefundOverVatGroups([{ quantity: 1, unit_price: -100, vat: 21 }], 500), []);
});
