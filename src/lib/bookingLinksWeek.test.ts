// Eigen bestand: deze test zet de klok van het "apparaat" op Amsterdam, en
// node --test draait elk bestand in een eigen proces.
process.env.TZ = 'Europe/Amsterdam';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameTimeNextWeek } from './bookingLinks.ts';

test('Herhaal volgende week houdt de kloktijd, ook over de klokwissel', () => {
  // Maandag 23 maart 9.00 uur wintertijd → maandag 30 maart 9.00 uur zomertijd.
  assert.equal(sameTimeNextWeek('2026-03-23T08:00:00.000Z'), '2026-03-30T07:00:00.000Z');
  // Maandag 19 oktober 9.00 uur zomertijd → maandag 26 oktober 9.00 uur wintertijd.
  assert.equal(sameTimeNextWeek('2026-10-19T07:00:00.000Z'), '2026-10-26T08:00:00.000Z');
  // Zonder wissel precies een week.
  assert.equal(sameTimeNextWeek('2026-11-16T08:30:00.000Z'), '2026-11-23T08:30:00.000Z');
});
