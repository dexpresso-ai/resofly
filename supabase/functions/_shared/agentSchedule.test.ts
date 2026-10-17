import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextRunAt, normalizeSchedule } from './agentSchedule.ts';

/**
 * Het ritme van een agent. Vaste datums in Europe/Amsterdam: vrijdag 16 oktober
 * 2026 (zomertijd, UTC+2), het weekend erna, en zondag 25 oktober, de nacht dat
 * de klok terug gaat. Een agent die een uur te vroeg draait, of op zaterdag een
 * "werkdag-overzicht" stuurt, merk je pas als hij het doet.
 */

const at = (iso: string) => new Date(iso);
const next = (fields: Record<string, unknown>, after: string) => computeNextRunAt(fields, at(after)).toISOString();

test('werkdagen: van vrijdagmiddag naar maandagochtend, het weekend over', () => {
  // Vrijdag 16 okt 09:00 lokaal (07:00Z) → maandag 19 okt 08:00 lokaal (06:00Z).
  assert.equal(next({ schedule_kind: 'weekdays', hour: 8 }, '2026-10-16T07:00:00Z'), '2026-10-19T06:00:00.000Z');
  // Vrijdagochtend vóór achten: dezelfde dag nog.
  assert.equal(next({ schedule_kind: 'weekdays', hour: 8 }, '2026-10-16T05:00:00Z'), '2026-10-16T06:00:00.000Z');
});

test('minuten tellen mee: 08:30 is 08:30, en precies op het moment zelf is het de volgende keer', () => {
  assert.equal(next({ schedule_kind: 'daily', hour: 8, minute: 30 }, '2026-10-16T06:00:00Z'), '2026-10-16T06:30:00.000Z');
  assert.equal(next({ schedule_kind: 'daily', hour: 8, minute: 30 }, '2026-10-16T06:30:00Z'), '2026-10-17T06:30:00.000Z');
});

test('elk uur: binnen het venster, op werkdagen, en daarna de volgende werkdag', () => {
  const hourly = { schedule_kind: 'hourly', hour: 8, end_hour: 10, minute: 15 };
  // Maandag 19 okt 08:20 lokaal → 09:15 lokaal.
  assert.equal(next(hourly, '2026-10-19T06:20:00Z'), '2026-10-19T07:15:00.000Z');
  // Na de laatste run van het venster (10:15) → dinsdag 08:15.
  assert.equal(next(hourly, '2026-10-19T08:20:00Z'), '2026-10-20T06:15:00.000Z');
  // Vrijdag na het venster → maandag, niet zaterdag.
  assert.equal(next(hourly, '2026-10-16T09:00:00Z'), '2026-10-19T06:15:00.000Z');
});

test('wekelijks en maandelijks, ook in een korte maand', () => {
  // Elke donderdag (4) 08:00, gevraagd op vrijdag → de donderdag erna.
  assert.equal(next({ schedule_kind: 'weekly', day_of_week: 4, hour: 8 }, '2026-10-16T07:00:00Z'), '2026-10-22T06:00:00.000Z');
  // De 31e in februari is de laatste dag van februari (wintertijd, UTC+1).
  assert.equal(next({ schedule_kind: 'monthly', day_of_month: 31, hour: 9 }, '2027-02-01T08:00:00Z'), '2027-02-28T08:00:00.000Z');
});

test('de nacht van de klokwissel: 08:30 blijft 08:30 wandklok', () => {
  // Zondag 25 okt 2026: terug naar wintertijd, 08:30 lokaal is 07:30Z.
  assert.equal(next({ schedule_kind: 'weekly', day_of_week: 7, hour: 8, minute: 30 }, '2026-10-24T12:00:00Z'), '2026-10-25T07:30:00.000Z');
  // Zondag 29 maart 2026: naar zomertijd, 08:00 lokaal is 06:00Z.
  assert.equal(next({ schedule_kind: 'daily', hour: 8 }, '2026-03-28T12:00:00Z'), '2026-03-29T06:00:00.000Z');
});

test('rommel in de velden wordt een geldig ritme, geen fout', () => {
  assert.deepEqual(normalizeSchedule({ schedule_kind: 'elke-dag', hour: 99, minute: -5 }), {
    kind: 'weekly', hour: 23, minute: 0, endHour: null, dayOfWeek: 1, dayOfMonth: null, timezone: 'Europe/Amsterdam',
  });
  // Een venster dat eindigt vóór het begint, is één run per dag — niet nul.
  assert.equal(normalizeSchedule({ schedule_kind: 'hourly', hour: 14, end_hour: 9 }).endHour, 14);
  // Zonder eind-uur: tot vijf uur 's middags.
  assert.equal(normalizeSchedule({ schedule_kind: 'hourly', hour: 9 }).endHour, 17);
  // Velden die bij een ander ritme horen, tellen niet mee.
  const daily = normalizeSchedule({ schedule_kind: 'daily', day_of_week: 3, day_of_month: 12, end_hour: 20 });
  assert.equal(daily.dayOfWeek, null);
  assert.equal(daily.dayOfMonth, null);
  assert.equal(daily.endHour, null);
});
