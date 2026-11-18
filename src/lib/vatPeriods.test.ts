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

test('met de KOR geen aangifte; zonder start hooguit vanaf vorig jaar, en alleen als je hier al aangifte deed', () => {
  assert.deepEqual(vatPeriodsToFile({ today: '2026-11-18', frequency: 'quarterly', kor: true, bookkeepingStart: null, filed: new Set() }), []);
  // Geen startdatum en geen aangifte in ResoFly: niets wijst erop dat je de btw hier doet.
  assert.deepEqual(vatPeriodsToFile({ today: '2026-01-10', frequency: 'quarterly', kor: false, bookkeepingStart: null, filed: new Set() }), []);
  const due = vatPeriodsToFile({ today: '2026-01-10', frequency: 'quarterly', kor: false, bookkeepingStart: null, filed: new Set([vatPeriodKey('quarter', 2025, 1)]) });
  assert.deepEqual(due.map(d => [d.label, d.overdue]), [['Q2 2025', true], ['Q3 2025', true], ['Q4 2025', false]]);
});

test('een organisatie die vandaag begint: geen deadlines van vóór de start in ResoFly', () => {
  // Startdatum 1 januari (een van de voorstellen bij de inrichting): Q1 t/m Q3
  // deed je elders. Zonder `since` stonden die er op dag één als verlopen.
  const vandaag = vatPeriodsToFile({ today: '2026-11-18', since: '2026-11-18', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set() });
  assert.deepEqual(vandaag, []);
  const januari = vatPeriodsToFile({ today: '2027-01-05', since: '2026-11-18', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set() });
  assert.deepEqual(januari.map(d => [d.label, d.deadline, d.overdue]), [['Q4 2026', '2027-01-31', false]]);
  // Een deadline op de startdag zelf telt mee.
  const opDeDag = vatPeriodsToFile({ today: '2026-11-18', since: '2026-10-31', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set() });
  assert.deepEqual(opDeDag.map(d => d.label), ['Q3 2026']);
});

test('per maand', () => {
  const due = vatPeriodsToFile({ today: '2026-03-05', frequency: 'monthly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set([vatPeriodKey('month', 2026, 1)]) });
  assert.deepEqual(due.map(d => [d.label, d.deadline]), [['februari 2026', '2026-03-31']]);
});

test('van kwartaal naar maand per 1 januari: vorig jaar telt in kwartalen, dit jaar in maanden', () => {
  const q = (n: number) => vatPeriodKey('quarter', 2026, n);
  // In januari staat de instelling al op per maand, en moet Q4 2026 nog.
  const januari = vatPeriodsToFile({ today: '2027-01-15', frequency: 'monthly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set([q(1), q(2), q(3)]) });
  assert.deepEqual(januari.map(d => [d.label, d.deadline, d.overdue]), [['Q4 2026', '2027-01-31', false]]);
  // Na Q4 en januari: alleen februari.
  const maart = vatPeriodsToFile({ today: '2027-03-05', frequency: 'monthly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set([q(1), q(2), q(3), q(4), vatPeriodKey('month', 2027, 1)]) });
  assert.deepEqual(maart.map(d => [d.label, d.deadline]), [['februari 2027', '2027-03-31']]);
});

test('van maand naar kwartaal per 1 januari: december gaat nog per maand', () => {
  const maanden = Array.from({ length: 11 }, (_, i) => vatPeriodKey('month', 2026, i + 1));
  const due = vatPeriodsToFile({ today: '2027-01-15', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-01-01', filed: new Set(maanden) });
  assert.deepEqual(due.map(d => [d.label, d.deadline]), [['december 2026', '2027-01-31']]);
});

test('wissel midden in het jaar: maanden die in een aangegeven kwartaal vallen, zijn gedaan', () => {
  const filed = new Set([vatPeriodKey('quarter', 2026, 1), vatPeriodKey('quarter', 2026, 2), vatPeriodKey('month', 2026, 7), vatPeriodKey('month', 2026, 8), vatPeriodKey('month', 2026, 9)]);
  const due = vatPeriodsToFile({ today: '2026-11-18', frequency: 'monthly', kor: false, bookkeepingStart: '2026-01-01', filed });
  assert.deepEqual(due.map(d => [d.label, d.overdue]), [['oktober 2026', false]]);
  // Andersom: per kwartaal ingesteld, en Q1 en Q2 per maand aangegeven.
  const maanden = new Set([1, 2, 3, 4, 5, 6].map(m => vatPeriodKey('month', 2026, m)));
  const terug = vatPeriodsToFile({ today: '2026-11-18', frequency: 'quarterly', kor: false, bookkeepingStart: '2026-01-01', filed: maanden });
  assert.deepEqual(terug.map(d => d.label), ['Q3 2026']);
});
