import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomeTaxOpening, missingFiscalYear, vatOpening } from './jaarwissel.ts';
import { vatPeriodsToFile } from './vatPeriods.ts';

test('inkomstenbelasting opent tot 1 mei op het jaar van de aangifte', () => {
  const zzp = { firstYear: 2025, bookkeepingStart: '2026-01-01' };
  assert.deepEqual(incomeTaxOpening({ ...zzp, today: '2026-12-31' }), { year: 2026, filingYear: null });
  assert.deepEqual(incomeTaxOpening({ ...zzp, today: '2027-01-01' }), { year: 2026, filingYear: 2026 });
  assert.deepEqual(incomeTaxOpening({ ...zzp, today: '2027-04-30' }), { year: 2026, filingYear: 2026 });
  assert.deepEqual(incomeTaxOpening({ ...zzp, today: '2027-05-01' }), { year: 2027, filingYear: null });
});

test('inkomstenbelasting: zonder boekhouding over vorig jaar gewoon het lopende jaar', () => {
  // In januari begonnen: over vorig jaar staat er niets.
  assert.deepEqual(incomeTaxOpening({ today: '2027-01-15', firstYear: 2025, bookkeepingStart: '2027-01-01' }), { year: 2027, filingYear: null });
  // Geen startdatum vastgelegd: we weten niet of er een vorig jaar is.
  assert.deepEqual(incomeTaxOpening({ today: '2027-01-15', firstYear: 2025, bookkeepingStart: null }), { year: 2027, filingYear: null });
  // Halverwege vorig jaar begonnen: dat jaar staat er wel.
  assert.deepEqual(incomeTaxOpening({ today: '2027-02-01', firstYear: 2025, bookkeepingStart: '2026-07-01' }), { year: 2026, filingYear: 2026 });
  // Het vorige jaar ligt vóór de eerste tabel.
  assert.deepEqual(incomeTaxOpening({ today: '2025-02-01', firstYear: 2025, bookkeepingStart: '2023-01-01' }), { year: 2025, filingYear: null });
});

test('omzetbelasting opent op het tijdvak dat nog moet, anders op vandaag', () => {
  assert.deepEqual(vatOpening({ today: '2027-01-02', frequency: 'quarterly', nextDue: null }), { view: 'quarterly', year: 2027, month: 1, quarter: 1 });
  assert.deepEqual(vatOpening({ today: '2026-11-22', frequency: 'monthly', nextDue: null }), { view: 'monthly', year: 2026, month: 11, quarter: 4 });
  assert.deepEqual(vatOpening({ today: '2027-01-02', frequency: 'quarterly', nextDue: { type: 'quarter', year: 2026, index: 4 } }),
    { view: 'quarterly', year: 2026, month: 10, quarter: 4 });
  assert.deepEqual(vatOpening({ today: '2027-01-02', frequency: 'quarterly', nextDue: { type: 'month', year: 2026, index: 12 } }),
    { view: 'monthly', year: 2026, month: 12, quarter: 4 });
  // Per 1 januari naar maandaangifte: Q4 van vorig jaar gaat nog per kwartaal.
  assert.deepEqual(vatOpening({ today: '2027-01-02', frequency: 'monthly', nextDue: { type: 'quarter', year: 2026, index: 4 } }),
    { view: 'quarterly', year: 2026, month: 10, quarter: 4 });
});

test('op 2 januari 2027 is dat Q4 2026, zoals de herinnering op het dashboard zegt', () => {
  const due = vatPeriodsToFile({
    today: '2027-01-02', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-01-01', since: '2026-01-01',
    filed: new Set(['quarter:2026:1', 'quarter:2026:2', 'quarter:2026:3']),
  });
  assert.equal(due[0]?.label, 'Q4 2026');
  assert.deepEqual(vatOpening({ today: '2027-01-02', frequency: 'quarterly', nextDue: due[0] }), { view: 'quarterly', year: 2026, month: 10, quarter: 4 });
});

test('het boekjaar van het nieuwe jaar ontbreekt: alleen als het vorige er was en het boekjaar het kalenderjaar is', () => {
  const y2026 = { period_start: '2026-01-01', period_end: '2026-12-31' };
  const y2027 = { period_start: '2027-01-01', period_end: '2027-12-31' };
  assert.equal(missingFiscalYear({ today: '2026-12-31', calendarYearOnly: true, years: [y2026] }), null);
  assert.equal(missingFiscalYear({ today: '2027-01-01', calendarYearOnly: true, years: [y2026] }), 2027);
  assert.equal(missingFiscalYear({ today: '2027-01-01', calendarYearOnly: true, years: [y2027, y2026] }), null);
  // Een kort eerste boekjaar (vanaf juli) eindigt ook op 31 december.
  assert.equal(missingFiscalYear({ today: '2027-03-01', calendarYearOnly: true, years: [{ period_start: '2026-07-01', period_end: '2026-12-31' }] }), 2027);
  // Een BV kiest zelf; zonder boekjaren doet de inrichting het; een gat van een jaar vult een mens.
  assert.equal(missingFiscalYear({ today: '2027-01-01', calendarYearOnly: false, years: [y2026] }), null);
  assert.equal(missingFiscalYear({ today: '2027-01-01', calendarYearOnly: true, years: [] }), null);
  assert.equal(missingFiscalYear({ today: '2028-01-01', calendarYearOnly: true, years: [y2026] }), null);
});
