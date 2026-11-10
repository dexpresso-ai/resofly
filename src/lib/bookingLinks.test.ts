/**
 * Tests voor de woorden, tijden en weken van de boekingslinks (bookingLinks.ts).
 * Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKING_STATUS_LABELS,
  LINK_STATE_LABELS,
  amsterdamDateKey,
  amsterdamWeekKey,
  choiceRule,
  commonDuration,
  durationLabel,
  expiryLabel,
  fmtTime,
  fmtWeekLabel,
  groupByDay,
  linkStateExplanation,
} from './bookingLinks.ts';

test('de week telt in Nederlandse tijd, zoals de weeklimiet in de database', () => {
  // Zondag 15 november 23.30 uur in Nederland is in UTC nog zondag 22.30 uur;
  // maandag 16 november 00.30 uur in Nederland is in UTC zondag 23.30 uur.
  assert.equal(amsterdamWeekKey('2026-11-15T22:30:00Z'), '2026-11-09');
  assert.equal(amsterdamWeekKey('2026-11-15T23:30:00Z'), '2026-11-16');
  assert.equal(amsterdamDateKey('2026-11-15T23:30:00Z'), '2026-11-16');
  // Rond de wintertijd (25 oktober 2026): zondag blijft in de oude week.
  assert.equal(amsterdamWeekKey('2026-10-25T10:00:00Z'), '2026-10-19');
  assert.equal(amsterdamWeekKey('2026-10-26T08:00:00Z'), '2026-10-26');
});

test('momenten per dag, op volgorde', () => {
  const groups = groupByDay([
    { starts_at: '2026-11-17T09:00:00Z' },
    { starts_at: '2026-11-16T14:00:00Z' },
    { starts_at: '2026-11-16T09:00:00Z' },
  ]);
  assert.deepEqual(groups.map(g => g.day), ['2026-11-16', '2026-11-17']);
  assert.deepEqual(groups[0].slots.map(s => s.starts_at), ['2026-11-16T09:00:00Z', '2026-11-16T14:00:00Z']);
});

test('duur in gewone woorden', () => {
  assert.equal(durationLabel('2026-11-16T09:00:00Z', '2026-11-16T09:30:00Z'), '30 min');
  assert.equal(durationLabel('2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z'), '1 uur');
  assert.equal(durationLabel('2026-11-16T09:00:00Z', '2026-11-16T10:30:00Z'), '1 u 30 min');
  assert.equal(durationLabel('2026-11-16T09:00:00Z', '2026-11-16T09:00:00Z'), '');
  assert.equal(commonDuration([
    { starts_at: '2026-11-16T09:00:00Z', ends_at: '2026-11-16T09:30:00Z' },
    { starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-11-17T13:30:00Z' },
  ]), '30 min');
  assert.equal(commonDuration([
    { starts_at: '2026-11-16T09:00:00Z', ends_at: '2026-11-16T09:30:00Z' },
    { starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-11-17T14:00:00Z' },
  ]), null);
});

test('tijden staan in Nederlandse tijd, ook in een andere tijdzone', () => {
  assert.equal(fmtTime('2026-11-16T09:00:00Z'), '10:00');
  assert.equal(fmtWeekLabel('2026-11-16'), 'Week van 16 nov – 22 nov');
});

test('geldigheid: verlopen, binnenkort, of tot een datum', () => {
  const now = Date.parse('2026-11-10T09:00:00Z');
  assert.equal(expiryLabel(null, now).tone, 'none');
  assert.equal(expiryLabel('2026-11-01T00:00:00Z', now).tone, 'expired');
  assert.match(expiryLabel('2026-11-01T00:00:00Z', now).text, /^Verlopen op 1 nov/);
  assert.equal(expiryLabel('2026-11-15T09:00:00Z', now).tone, 'soon');
  assert.match(expiryLabel('2026-11-15T09:00:00Z', now).text, /over 5 dagen/);
  assert.equal(expiryLabel('2027-03-10T09:00:00Z', now).tone, 'ok');
  assert.match(expiryLabel('2027-03-10T09:00:00Z', now).text, /^Geldig tot 10 mrt 2027/);
});

test('wat de klant mag kiezen', () => {
  assert.equal(choiceRule(1, 1), 'Je kiest één moment');
  assert.equal(choiceRule(3, 3), 'Je kiest maximaal 3 momenten');
  assert.equal(choiceRule(3, 1), 'Je kiest maximaal 3 momenten, hooguit 1 per week');
  assert.equal(choiceRule(3, 1, 2), 'Je kiest één moment');
});

test('alle standen en statussen hebben Nederlandse woorden', () => {
  // Eerst stond de status van een boeking in het beheer in het Engels ("confirmed").
  for (const value of Object.values(BOOKING_STATUS_LABELS)) assert.doesNotMatch(value, /pending|confirmed|cancelled|failed/);
  for (const state of ['open', 'full', 'closed', 'expired', 'unavailable'] as const) {
    assert.ok(LINK_STATE_LABELS[state].label);
    assert.ok(linkStateExplanation(state, 2).length > 10);
  }
  assert.match(linkStateExplanation('open', 0), /lege pagina/);
});
