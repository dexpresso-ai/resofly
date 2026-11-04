import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mt940Counterparty, mt940EntryDate, mt940Remittance } from './bankImport/mt940Fields.ts';

test('boekdatum rond de jaarwisseling krijgt het juiste jaar', () => {
  // valuta 31-12-2025, boeking 2 januari → 2026
  assert.equal(mt940EntryDate('2025-12-31', '0102'), '2026-01-02');
  // valuta 02-01-2026, boeking 31 december → 2025
  assert.equal(mt940EntryDate('2026-01-02', '1231'), '2025-12-31');
  // gewoon geval: zelfde jaar
  assert.equal(mt940EntryDate('2026-03-15', '0316'), '2026-03-16');
  // geen of kapotte boekdatum: de valutadatum blijft
  assert.equal(mt940EntryDate('2026-03-15', '1399'), '2026-03-15');
});

test('ING-tegenpartij uit /CNTP/', () => {
  const block = '/TRTP/SEPA OVERBOEKING/IBAN/ /CNTP/NL12INGB0001234567/INGBNL2A/Studio Voorbeeld BV/Amsterdam/REMI/USTD//Factuur 2026-0007/EREF/NOTPROVIDED';
  assert.deepEqual(mt940Counterparty(block), { iban: 'NL12INGB0001234567', name: 'Studio Voorbeeld BV' });
  assert.deepEqual(mt940Counterparty('/NAME/Iemand/IBAN/NL00BANK0123456789'), { iban: null, name: null });
});

test('ING-omschrijving zonder USTD-voorvoegsel; STRD als betalingskenmerk', () => {
  assert.deepEqual(mt940Remittance('USTD//Factuur 2026-0007'), { description: 'Factuur 2026-0007', structuredReference: null });
  assert.deepEqual(mt940Remittance('STRD/CUR/1234567890123456'), { description: 'STRD/CUR/1234567890123456', structuredReference: '1234567890123456' });
  assert.deepEqual(mt940Remittance(null), { description: null, structuredReference: null });
});
