/**
 * Tests voor de kop van de weekplanner (src/lib/weekView.ts). Draaien met: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countActiveFilters, pickerWeeks, relativeWeekLabel, weekMeter, weekRangeLabel } from './weekView.ts';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

test('relativeWeekLabel: zegt waar je staat, ook rond de zomertijd', () => {
  const today = d(2026, 11, 15); // zondag: hoort bij de week van maandag 9 november
  assert.equal(relativeWeekLabel(d(2026, 11, 9), today), 'Deze week');
  assert.equal(relativeWeekLabel(d(2026, 11, 16), today), 'Volgende week');
  assert.equal(relativeWeekLabel(d(2026, 11, 2), today), 'Vorige week');
  assert.equal(relativeWeekLabel(d(2026, 11, 30), today), 'Over 3 weken');
  assert.equal(relativeWeekLabel(d(2026, 10, 19), today), '3 weken geleden');
  // Over de wissel naar wintertijd (25 oktober) heen: geen uur verschil, gewoon een week.
  assert.equal(relativeWeekLabel(d(2026, 10, 26), d(2026, 10, 21)), 'Volgende week');
});

test('weekRangeLabel: één maand, twee maanden, twee jaren', () => {
  assert.equal(weekRangeLabel(d(2026, 11, 9)), '9 – 15 nov 2026');
  assert.equal(weekRangeLabel(d(2026, 11, 30)), '30 nov – 6 dec 2026');
  assert.equal(weekRangeLabel(d(2025, 12, 29)), '29 dec 2025 – 4 jan 2026');
  // Alleen de werkweek in beeld: dan eindigt hij op vrijdag.
  assert.equal(weekRangeLabel(d(2026, 11, 9), 5), '9 – 13 nov 2026');
  // Een dag midden in de week rekent vanaf zijn maandag.
  assert.equal(weekRangeLabel(d(2026, 11, 12)), '9 – 15 nov 2026');
});

test('pickerWeeks: altijd zes maandagen, beginnend bij de week van de eerste', () => {
  const weeks = pickerWeeks(2026, 10); // november 2026; 1 november is een zondag
  assert.equal(weeks.length, 6);
  assert.deepEqual(weeks.map(w => [w.getMonth() + 1, w.getDate(), w.getDay()]), [
    [10, 26, 1], [11, 2, 1], [11, 9, 1], [11, 16, 1], [11, 23, 1], [11, 30, 1],
  ]);
});

test('weekMeter: met een streep is de streep de maat', () => {
  const meter = weekMeter(570, 1095, 40 * 60);
  assert.equal(meter.freeMinutes, 2400 - 1665);
  assert.equal(meter.overMinutes, 0);
  assert.ok(Math.abs(meter.agendaPct - (570 / 2400) * 100) < 1e-9);
  assert.ok(Math.abs(meter.taskPct - (1095 / 2400) * 100) < 1e-9);
});

test('weekMeter: boven de streep loopt de balk vol en zegt hoeveel erover is', () => {
  const meter = weekMeter(600, 2100, 2400);
  assert.equal(meter.freeMinutes, 0);
  assert.equal(meter.overMinutes, 300);
  assert.ok(Math.abs(meter.agendaPct + meter.taskPct - 100) < 1e-9);
});

test('weekMeter: zonder streep alleen de verhouding, en een lege week is leeg', () => {
  assert.deepEqual(weekMeter(0, 0, null), { agendaPct: 0, taskPct: 0, freeMinutes: null, overMinutes: 0 });
  const meter = weekMeter(60, 180, null);
  assert.equal(meter.freeMinutes, null);
  assert.equal(meter.agendaPct, 25);
  assert.equal(meter.taskPct, 75);
});

test('countActiveFilters: de standaardkeuze is geen filter', () => {
  const rest = { clientId: '', projectId: '', priority: 'all', status: 'open' };
  assert.equal(countActiveFilters({ clientId: '', projectId: '', priority: 'all', status: 'open' }, rest), 0);
  assert.equal(countActiveFilters({ clientId: 'c1', projectId: '', priority: 'high', status: 'open' }, rest), 2);
  assert.equal(countActiveFilters({ clientId: '', projectId: '', priority: 'all', status: 'all' }, rest), 1);
  assert.equal(countActiveFilters({ query: '  ' }, { query: '' }), 0);
  assert.equal(countActiveFilters({ query: 'logo' }, { query: '' }), 1);
});
