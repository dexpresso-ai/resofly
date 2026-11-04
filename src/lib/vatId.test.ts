/**
 * Tests voor de vormcontrole van het btw-identificatienummer. Draaien met: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isDutchVatIdFormat, looksLikeTaxNumberWithoutCountry, normalizeVatId } from './vatId.ts';

test('een btw-id is NL, 9 cijfers, B en 2 cijfers', () => {
  assert.equal(isDutchVatIdFormat('NL123456789B01'), true);
  assert.equal(isDutchVatIdFormat('nl 1234.56789 b01'), true, 'spaties, punten en kleine letters mogen');
  assert.equal(isDutchVatIdFormat('NL123456789B1'), false);
  assert.equal(isDutchVatIdFormat('NL12345678B01'), false);
  assert.equal(isDutchVatIdFormat('BE0123456789'), false);
  assert.equal(isDutchVatIdFormat(''), false);
});

test('zonder landcode lijkt het op het omzetbelastingnummer', () => {
  assert.equal(looksLikeTaxNumberWithoutCountry('123456789B01'), true);
  assert.equal(looksLikeTaxNumberWithoutCountry('NL123456789B01'), false);
});

test('normaliseren', () => {
  assert.equal(normalizeVatId(' nl 123.456.789 b01 '), 'NL123456789B01');
});
