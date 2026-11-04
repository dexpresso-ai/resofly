/**
 * Tests voor de prognose van het urencriterium. Draaien met: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HOUR_CRITERION_MINUTES, projectHourCriterion } from './hourCriterion.ts';

const H = (hours: number) => hours * 60;

test('1225 uur per kalenderjaar', () => {
  assert.equal(HOUR_CRITERION_MINUTES, H(1225));
});

test('een starter per 1 juli wordt niet afgerekend op de maanden vóór de start', () => {
  // 1 juli t/m 30 september: 92 dagen, 600 uur. Nog 92 dagen te gaan (1 okt t/m 31 dec).
  const p = projectHourCriterion({ totalMinutes: H(600), firstEntryDate: '2026-07-01', today: '2026-09-30', year: 2026 });
  assert.equal(p.daysRemaining, 92);
  assert.equal(p.projectedMinutes, H(1200));
  // De oude rekenwijze (tempo vanaf 1 januari) kwam op ± 802 uur uit.
  assert.ok(p.projectedMinutes > H(1100));
  assert.equal(p.remainingMinutes, H(625));
});

test('wie het hele jaar werkt, krijgt dezelfde prognose als vanaf 1 januari', () => {
  // 2 januari t/m 2 juli: 182 dagen, 600 uur; nog 182 dagen.
  const p = projectHourCriterion({ totalMinutes: H(600), firstEntryDate: '2026-01-02', today: '2026-07-02', year: 2026 });
  assert.equal(p.projectedMinutes, H(1200));
});

test('zonder uren geen prognose en het hele criterium nog te gaan', () => {
  const p = projectHourCriterion({ totalMinutes: 0, firstEntryDate: null, today: '2026-03-01', year: 2026 });
  assert.equal(p.projectedMinutes, 0);
  assert.equal(p.remainingMinutes, H(1225));
  assert.ok(p.neededPerWeekMinutes > 0);
});

test('op 31 december blijft de stand staan en is de weeknorm het resterende tekort', () => {
  const p = projectHourCriterion({ totalMinutes: H(1000), firstEntryDate: '2026-01-05', today: '2026-12-31', year: 2026 });
  assert.equal(p.daysRemaining, 0);
  assert.equal(p.projectedMinutes, H(1000));
  assert.equal(p.neededPerWeekMinutes, H(225));
});

test('gehaald is gehaald: geen tekort meer', () => {
  const p = projectHourCriterion({ totalMinutes: H(1300), firstEntryDate: '2026-01-05', today: '2026-11-01', year: 2026 });
  assert.equal(p.remainingMinutes, 0);
  assert.equal(p.neededPerWeekMinutes, 0);
});
