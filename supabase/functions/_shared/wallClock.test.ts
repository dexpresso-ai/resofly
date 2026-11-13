import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recurrenceStarts, utcOffsetMs, vtimezoneLines, wallClock, wallClockToUtcMs, type RecurrenceRule } from './wallClock.ts';

/**
 * Herhalende afspraken op de wandklok. "Elke maandag 9.00 uur" hoort na de
 * klokwissel 9.00 uur te blijven, in de app, bij de boekingslinks en op de
 * telefoon. Tot november 2026 telde ResoFly in UTC door en stond zo'n reeks in
 * de zomer om 10.00 uur.
 */

const AMS = 'Europe/Amsterdam';
const iso = (ms: number) => new Date(ms).toISOString();
const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({ freq: 'WEEKLY', interval: 1, until: null, count: null, ...over });
const HOUR = 3_600_000;

function local(ms: number, tz = AMS): string {
  const w = wallClock(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
}

test('elke maandag 9.00 uur: voor en na de zomertijd 9.00 uur', () => {
  const start = Date.parse('2026-03-16T08:00:00Z'); // 9.00 uur wintertijd
  const starts = recurrenceStarts(start, HOUR, rule(), AMS, start, Date.parse('2026-04-14T00:00:00Z'));
  assert.deepEqual(starts.map(ms => local(ms)), ['2026-03-16 09:00', '2026-03-23 09:00', '2026-03-30 09:00', '2026-04-06 09:00', '2026-04-13 09:00']);
  assert.equal(iso(starts[2]), '2026-03-30T07:00:00.000Z', 'in de zomer is 9.00 uur 7.00 UTC');
});

test('en terug naar de wintertijd', () => {
  const start = Date.parse('2026-10-19T07:00:00Z'); // maandag 9.00 uur zomertijd
  const starts = recurrenceStarts(start, HOUR, rule(), AMS, start, Date.parse('2026-11-03T00:00:00Z'));
  assert.deepEqual(starts.map(ms => local(ms)), ['2026-10-19 09:00', '2026-10-26 09:00', '2026-11-02 09:00']);
  assert.equal(iso(starts[1]), '2026-10-26T08:00:00.000Z');
});

test('een weggehaalde keer in de zomer valt echt weg', () => {
  // De telefoon schrijft EXDATE;TZID=Europe/Amsterdam:20260406T090000 = 07:00 UTC.
  // Met UTC-optellen kwam de reeks op 08:00 UTC uit, en bleef die keer staan.
  const start = Date.parse('2026-03-16T08:00:00Z');
  const exdate = new Set([Date.parse('2026-04-06T07:00:00Z')]);
  const starts = recurrenceStarts(start, HOUR, rule(), AMS, start, Date.parse('2026-04-14T00:00:00Z'), exdate);
  assert.ok(!starts.map(ms => local(ms)).includes('2026-04-06 09:00'));
  assert.equal(starts.length, 4);
});

test('een kloktijd die niet bestaat of twee keer voorkomt, zoals RFC 5545 het wil', () => {
  // 29 maart 2.30 uur bestaat niet: met de verschuiving van ervoor, dus 3.30 uur zomertijd.
  assert.equal(iso(wallClockToUtcMs({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0, millisecond: 0 }, AMS)), '2026-03-29T01:30:00.000Z');
  // 25 oktober 2.30 uur komt twee keer voor: de eerste (nog zomertijd).
  assert.equal(iso(wallClockToUtcMs({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0, millisecond: 0 }, AMS)), '2026-10-25T00:30:00.000Z');
  assert.equal(utcOffsetMs(Date.parse('2026-07-01T12:00:00Z'), AMS), 2 * HOUR);
  assert.equal(utcOffsetMs(Date.parse('2026-01-01T12:00:00Z'), AMS), HOUR);
});

test('een dagelijkse reeks rond 2.30 uur blijft daarna op 2.30 uur', () => {
  const start = Date.parse('2026-03-27T01:30:00Z'); // vrijdag 2.30 uur
  const starts = recurrenceStarts(start, 30 * 60_000, rule({ freq: 'DAILY' }), AMS, start, Date.parse('2026-04-01T00:00:00Z'));
  assert.deepEqual(starts.map(ms => local(ms)), ['2026-03-27 02:30', '2026-03-28 02:30', '2026-03-29 03:30', '2026-03-30 02:30', '2026-03-31 02:30']);
});

test('elke maand op de 31e: maanden zonder 31e vallen weg, zoals op de telefoon', () => {
  const start = Date.parse('2026-01-31T09:00:00Z');
  const starts = recurrenceStarts(start, HOUR, rule({ freq: 'MONTHLY' }), AMS, start, Date.parse('2026-08-01T00:00:00Z'));
  assert.deepEqual(starts.map(ms => local(ms).slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  // Met COUNT tellen de overgeslagen maanden niet mee.
  const vier = recurrenceStarts(start, HOUR, rule({ freq: 'MONTHLY', count: 4 }), AMS, start, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(vier.length, 4);
  assert.equal(local(vier[3]).slice(0, 10), '2026-07-31');
});

test('UNTIL en COUNT', () => {
  const start = Date.parse('2026-11-02T08:00:00Z');
  const tot = recurrenceStarts(start, HOUR, rule({ until: '2026-11-16T23:59:59.000Z' }), AMS, start, Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(tot.length, 3, 'tot en met 16 november');
  const drie = recurrenceStarts(start, HOUR, rule({ count: 3 }), AMS, start, Date.parse('2027-01-01T00:00:00Z'));
  assert.deepEqual(drie.map(ms => local(ms).slice(0, 10)), ['2026-11-02', '2026-11-09', '2026-11-16']);
  const om = recurrenceStarts(start, HOUR, rule({ interval: 2 }), AMS, start, Date.parse('2026-12-01T00:00:00Z'));
  assert.deepEqual(om.map(ms => local(ms).slice(0, 10)), ['2026-11-02', '2026-11-16', '2026-11-30']);
});

test('een oude dagelijkse reeks staat nog in de agenda (eerst hield het na 800 keer op)', () => {
  const start = Date.parse('2022-01-03T08:00:00Z'); // ruim 1700 dagen eerder
  const week = recurrenceStarts(start, HOUR, rule({ freq: 'DAILY' }), AMS, Date.parse('2026-11-16T00:00:00Z'), Date.parse('2026-11-23T00:00:00Z'));
  assert.deepEqual(week.map(ms => local(ms)), ['2026-11-16 09:00', '2026-11-17 09:00', '2026-11-18 09:00', '2026-11-19 09:00', '2026-11-20 09:00', '2026-11-21 09:00', '2026-11-22 09:00']);
  // Met COUNT: ver na het einde niets meer, ook al springen we vooruit.
  assert.deepEqual(recurrenceStarts(start, HOUR, rule({ freq: 'DAILY', count: 10 }), AMS, Date.parse('2026-11-16T00:00:00Z'), Date.parse('2026-11-23T00:00:00Z')), []);
  const tiende = recurrenceStarts(start, HOUR, rule({ freq: 'DAILY', count: 10 }), AMS, Date.parse('2022-01-12T00:00:00Z'), Date.parse('2022-01-20T00:00:00Z'));
  assert.deepEqual(tiende.map(ms => local(ms).slice(0, 10)), ['2022-01-12'], 'de tiende keer is de laatste');
});

test('een afspraak die al bezig is bij het begin van het venster telt mee', () => {
  const start = Date.parse('2026-11-02T08:00:00Z');
  const starts = recurrenceStarts(start, 2 * HOUR, rule(), AMS, Date.parse('2026-11-09T09:00:00Z'), Date.parse('2026-11-09T12:00:00Z'));
  assert.deepEqual(starts.map(iso), ['2026-11-09T08:00:00.000Z']);
});

test('een hele dag herhaalt op datum (UTC), een onbekende zone valt op Amsterdam', () => {
  const start = Date.parse('2026-03-27T00:00:00Z');
  const dagen = recurrenceStarts(start, 86_400_000, rule({ freq: 'DAILY' }), 'UTC', start, Date.parse('2026-03-31T00:00:00Z'));
  assert.deepEqual(dagen.map(iso), ['2026-03-27T00:00:00.000Z', '2026-03-28T00:00:00.000Z', '2026-03-29T00:00:00.000Z', '2026-03-30T00:00:00.000Z', '2026-03-31T00:00:00.000Z']);
  const start2 = Date.parse('2026-03-16T08:00:00Z');
  assert.deepEqual(recurrenceStarts(start2, HOUR, rule(), 'Mars/Olympus', start2, Date.parse('2026-03-31T00:00:00Z')).map(ms => local(ms)).at(-1), '2026-03-30 09:00');
});

test('andere zones: New York wisselt op een andere dag', () => {
  const start = Date.parse('2026-03-02T14:00:00Z'); // maandag 9.00 uur EST
  const starts = recurrenceStarts(start, HOUR, rule(), 'America/New_York', start, Date.parse('2026-03-17T00:00:00Z'));
  assert.deepEqual(starts.map(ms => local(ms, 'America/New_York')), ['2026-03-02 09:00', '2026-03-09 09:00', '2026-03-16 09:00']);
});

test('VTIMEZONE: Amsterdam met de Europese regel, New York met de Amerikaanse, Tokio zonder wissel', () => {
  const ams = vtimezoneLines(AMS, 2025);
  assert.deepEqual(ams, [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'DTSTART:20250330T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZNAME:CEST', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'DTSTART:20251026T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZNAME:CET', 'END:STANDARD',
    'END:VTIMEZONE',
  ]);
  const ny = vtimezoneLines('America/New_York', 2025);
  assert.ok(ny.includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU') && ny.includes('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'));
  const tokio = vtimezoneLines('Asia/Tokyo', 2025);
  assert.ok(tokio.includes('TZOFFSETFROM:+0900') && tokio.includes('TZOFFSETTO:+0900') && !tokio.some(l => l.startsWith('RRULE')));
  assert.deepEqual(vtimezoneLines('Mars/Olympus', 2025), []);
});

test('de app en de agendaserver gebruiken deze regels, niet een eigen versie', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('./calendarAvailability.ts'), /recurrenceStarts\(/);
  assert.doesNotMatch(read('./calendarCore.ts'), /setUTCDate\(next\.getUTCDate\(\) \+ 7 \* interval\)/, 'het oude optellen in UTC is weg');
  assert.match(read('../../../workers/caldav/src/logic.ts'), /from '\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/wallClock\.ts'/);
});
