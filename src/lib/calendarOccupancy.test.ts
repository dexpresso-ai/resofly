import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dayOccupancy, formatOccupancy } from './calendarOccupancy.ts';

/**
 * Het bezettingsbalkje in de maandweergave (calendarOccupancy.ts), en de
 * schaal voor de letters van de agenda in globals.css.
 */

const day = new Date(2026, 10, 11); // woensdag 11 november 2026
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const ev = (start: string, end: string, color: string, allDay = false) => ({ starts_at: start, ends_at: end, all_day: allDay, color });
const colorOf = (e: { color: string }) => e.color;

test('telt de bezette minuten per agendakleur, in de volgorde van de dag', () => {
  const result = dayOccupancy(day, [
    ev(at(11, 13), at(11, 15), 'blauw'),
    ev(at(11, 9), at(11, 10, 30), 'geel'),
    ev(at(11, 16), at(11, 16, 30), 'geel'),
  ], colorOf);
  assert.equal(result.minutes, 240);
  assert.deepEqual(result.segments, [{ color: 'geel', minutes: 120 }, { color: 'blauw', minutes: 120 }]);
});

test('overlap telt één keer, voor de afspraak die het eerst begon', () => {
  // Twee gesprekken tegelijk: eerst telde de dag hier drie uur.
  const result = dayOccupancy(day, [
    ev(at(11, 10), at(11, 12), 'geel'),
    ev(at(11, 11), at(11, 12), 'blauw'),
    ev(at(11, 11, 30), at(11, 13), 'blauw'),
  ], colorOf);
  assert.equal(result.minutes, 180);
  assert.deepEqual(result.segments, [{ color: 'geel', minutes: 120 }, { color: 'blauw', minutes: 60 }]);
});

test('hele-dag-afspraken maken je niet bezet', () => {
  const result = dayOccupancy(day, [ev(at(11, 0), at(12, 0), 'geel', true)], colorOf);
  assert.deepEqual(result, { minutes: 0, segments: [] });
});

test('een afspraak over middernacht telt alleen het deel op deze dag', () => {
  const result = dayOccupancy(day, [
    ev(at(10, 22), at(11, 2), 'geel'),
    ev(at(11, 23), at(12, 1), 'blauw'),
  ], colorOf);
  assert.equal(result.minutes, 180);
});

test('afspraken op andere dagen en kapotte tijden tellen niet', () => {
  const result = dayOccupancy(day, [
    ev(at(12, 9), at(12, 10), 'geel'),
    ev('geen datum', at(11, 10), 'geel'),
    ev(at(11, 10), at(11, 9), 'geel'),
  ], colorOf);
  assert.deepEqual(result, { minutes: 0, segments: [] });
});

test('formatOccupancy schrijft uren en minuten kort uit', () => {
  assert.equal(formatOccupancy(45), '45m');
  assert.equal(formatOccupancy(180), '3u');
  assert.equal(formatOccupancy(330), '5u 30m');
});

/**
 * De letters van de agenda schalen mee met één knop: `--cal-fs` op
 * `.calendar-agenda-page` (2026-11-12). Een nieuwe regel met een vaste
 * `font-size` in px schaalt niet mee en valt dan uit de toon. Het
 * zijpaneel, de weergaveknoppen en de knop "+" horen bij het scherm eromheen.
 */
test('elke lettergrootte in de agendaregels schaalt mee met --cal-fs', () => {
  const css = readFileSync(fileURLToPath(new URL('../styles/globals.css', import.meta.url)), 'utf8');
  const calendar = /\.(tb-(?!vbtn|view-tog|panel|fab)|cm-|cal-daystrip|cds-|calendar-day\b|calendar-day-|calendar-item|calendar-no-items|calendar-list-grid)/;
  const fixed: string[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const clean = selector.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!calendar.test(clean)) continue;
    if (/font-size:\s*[0-9.]+px/.test(body)) fixed.push(clean.slice(0, 80));
  }
  assert.deepEqual(fixed, [], 'gebruik font-size:calc(<n>px * var(--cal-fs,1)) in de agenda');
  assert.match(css, /\.calendar-agenda-page\{--cal-fs:/, 'de schaal zelf staat op .calendar-agenda-page');
});
