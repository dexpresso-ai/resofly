import test from 'node:test';
import assert from 'node:assert/strict';
import { vatFilingDeadline, vatPeriod, vatPeriodKey, vatPeriodOf, vatPeriodsToFile } from './vatPeriods.ts';

test('deadline: de laatste dag van de maand na het tijdvak', () => {
  assert.equal(vatFilingDeadline(vatPeriod('quarter', 2026, 1).to), '2026-04-30');
  assert.equal(vatFilingDeadline(vatPeriod('quarter', 2026, 3).to), '2026-10-31');
  assert.equal(vatFilingDeadline(vatPeriod('quarter', 2026, 4).to), '2027-01-31');
  assert.equal(vatFilingDeadline(vatPeriod('month', 2026, 1).to), '2026-02-28');
  assert.equal(vatFilingDeadline(vatPeriod('month', 2028, 1).to), '2028-02-29');
});

test('tijdvak van een datum, met label', () => {
  assert.deepEqual(vatPeriodOf('2026-11-18', 'quarterly'), { type: 'quarter', year: 2026, index: 4, from: '2026-10-01', to: '2026-12-31', label: 'Q4 2026' });
  assert.equal(vatPeriodOf('2026-02-28', 'monthly').label, 'februari 2026');
});

test('nog te doen: afgelopen kwartalen zonder aangifte, oudste eerst, vanaf de start van de boekhouding', () => {
  const due = vatPeriodsToFile({
    today: '2026-11-18', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-01-01',
    filed: new Set([vatPeriodKey('quarter', 2026, 1), vatPeriodKey('quarter', 2026, 2)]),
  });
  // Q3 is af en nog niet gedaan; Q4 loopt nog.
  assert.deepEqual(due.map(d => [d.label, d.deadline, d.overdue]), [['Q3 2026', '2026-10-31', true]]);
});

test('een start midden in een kwartaal telt dat kwartaal mee; daarvóór niets', () => {
  const due = vatPeriodsToFile({ today: '2026-11-18', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-05-15', filed: new Set() });
  assert.deepEqual(due.map(d => d.label), ['Q2 2026', 'Q3 2026']);
});

test('met de KOR geen aangifte; zonder start hooguit vanaf vorig jaar', () => {
  assert.deepEqual(vatPeriodsToFile({ today: '2026-11-18', frequency: 'quarterly', kor: true, bookkeepingStart: null, filed: new Set() }), []);
  const due = vatPeriodsToFile({ today: '2026-01-10', frequency: 'quarterly', kor: false, bookkeepingStart: null, filed: new Set() });
  assert.deepEqual(due.map(d => [d.label, d.overdue]), [['Q1 2025', true], ['Q2 2025', true], ['Q3 2025', true], ['Q4 2025', false]]);
});

test('per maand', () => {
  const due = vatPeriodsToFile({ today: '2026-03-05', frequency: 'monthly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set([vatPeriodKey('month', 2026, 1)]) });
  assert.deepEqual(due.map(d => [d.label, d.deadline]), [['februari 2026', '2026-03-31']]);
});
