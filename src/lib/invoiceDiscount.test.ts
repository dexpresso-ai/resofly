import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discountNeedsSpreading, spreadDiscountOverRates } from './invoiceDiscount.ts';
import { total } from './format.ts';
import type { FinanceLine } from '../types';

let teller = 0;
const id = () => `nieuw-${++teller}`;
const regel = (description: string, unit_price: number, vat: number, vat_code?: string, quantity = 1): FinanceLine =>
  ({ id: description, description, quantity, unit_price, vat, ...(vat_code ? { vat_code } : {}) });

test('bevinding 15: € 100 aan 9% en € 100 aan 21% met − € 20 korting geeft € 27,00 btw', () => {
  const lines = [regel('Boek', 100, 9, 'LAAG'), regel('Workshop', 100, 21, 'HOOG'), regel('10% korting op het totaal', -20, 21, 'HOOG')];
  assert.equal(total(lines).vat, 25.8, 'zoals het was: € 1,20 te weinig');
  assert.equal(discountNeedsSpreading(lines).length, 1);
  const spread = spreadDiscountOverRates(lines, id);
  assert.equal(total(spread).vat, 27);
  assert.equal(total(spread).subtotal, 180);
  assert.deepEqual(spread.slice(2).map(l => [l.description, l.unit_price, l.vat, l.vat_code]), [
    ['10% korting op het totaal (deel 9% btw)', -10, 9, 'LAAG'],
    ['10% korting op het totaal (deel 21% btw)', -10, 21, 'HOOG'],
  ]);
  assert.equal(spread[2].id, '10% korting op het totaal', 'het eerste deel houdt het id van de regel');
  // Daarna is er niets meer te verdelen.
  assert.deepEqual(discountNeedsSpreading(spread), []);
});

test('de delen tellen op de cent op tot de korting', () => {
  const lines = [regel('A', 33.33, 21), regel('B', 33.33, 9), regel('C', 33.34, 0, 'VRIJ'), regel('Korting', -10, 21)];
  const spread = spreadDiscountOverRates(lines, id);
  const kortingCenten = spread.filter(l => l.unit_price < 0).reduce((sum, l) => sum + Math.round(l.unit_price * 100), 0);
  assert.equal(kortingCenten, -1000);
  assert.equal(spread.filter(l => l.unit_price < 0).length, 3);
  assert.equal(total(spread).subtotal, total(lines).subtotal, 'het totaal excl. btw verandert niet');
});

test('aantal × prijs: een korting van 2 × − € 5 is − € 10', () => {
  const lines = [regel('A', 50, 21), regel('B', 50, 9), regel('Korting', -5, 21, undefined, 2)];
  const spread = spreadDiscountOverRates(lines, id);
  assert.deepEqual(spread.filter(l => l.unit_price < 0).map(l => [l.quantity, l.unit_price, l.vat]), [[1, -5, 21], [1, -5, 9]]);
});

test('niets te vragen: één tarief, geen korting, of al per tarief verdeeld', () => {
  assert.deepEqual(discountNeedsSpreading([regel('A', 100, 21), regel('Korting', -10, 21)]), []);
  assert.deepEqual(discountNeedsSpreading([regel('A', 100, 21), regel('B', 100, 9)]), []);
  assert.deepEqual(discountNeedsSpreading([regel('A', 100, 21), regel('B', 100, 9), regel('K1', -10, 21), regel('K2', -10, 9)]), []);
  assert.deepEqual(discountNeedsSpreading(null), []);
  // Eén tarief: splitsen laat de regels zoals ze zijn.
  const een = [regel('A', 100, 21), regel('Korting', -10, 21)];
  assert.equal(spreadDiscountOverRates(een, id), een);
});
