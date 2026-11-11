/**
 * Tests voor de woorden, tijden en weken van de boekingslinks (bookingLinks.ts).
 * Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKING_STATUS_LABELS,
  LINK_STATE_LABELS,
  MAX_GENERATED_SLOTS,
  VIDEO_INFO,
  buildIcs,
  fmtDayParts,
  fmtMonthLabel,
  generatePatternSlots,
  icsText,
  linkVideoKind,
  monthGrid,
  safeMeetingLink,
  shiftMonth,
  splitIntoSlots,
  videoKindOf,
  weekdaysLabel,
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

test('een getekend blok wordt momenten van de gekozen duur, met pauze ertussen', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 17, h, m)).toISOString();
  // Zoals getekend.
  assert.deepEqual(splitIntoSlots(at(9), at(12), 0), [{ startsAt: at(9), endsAt: at(12) }]);
  // Drie uur in halve uren: zes momenten.
  const halves = splitIntoSlots(at(9), at(12), 30);
  assert.equal(halves.length, 6);
  assert.deepEqual(halves[5], { startsAt: at(11, 30), endsAt: at(12) });
  // Met tien minuten pauze: 9.00, 9.40, 10.20, 11.00 (11.40 past niet meer).
  assert.deepEqual(splitIntoSlots(at(9), at(12), 30, 10).map(s => s.startsAt), [at(9), at(9, 40), at(10, 20), at(11)]);
  // Een klik (korter dan de duur) is één moment van de gekozen duur.
  assert.deepEqual(splitIntoSlots(at(10), at(10, 15), 45), [{ startsAt: at(10), endsAt: at(10, 45) }]);
  // Onzin geeft niets.
  assert.deepEqual(splitIntoSlots(at(12), at(9), 30), []);
  assert.deepEqual(splitIntoSlots('nooit', at(9), 30), []);
});

test('weekpatroon: de gekozen dagen, alleen in de toekomst, hooguit 500', () => {
  // Maandag 16 november 2026, in de tijd van dit apparaat.
  const now = new Date(2026, 10, 16, 10, 0).getTime();
  const slots = generatePatternSlots({ weekdays: [1, 3], from: '09:00', to: '11:00', durationMin: 60, bufferMin: 0, weeks: 2, startDate: '2026-11-16' }, now);
  const local = slots.map(s => { const d = new Date(s.startsAt); return `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; });
  // Het is maandag 10.00 uur: de momenten van 9.00 en 10.00 zijn al begonnen.
  assert.deepEqual(local, ['18 9:00', '18 10:00', '23 9:00', '23 10:00', '25 9:00', '25 10:00']);
  assert.deepEqual(generatePatternSlots({ weekdays: [], from: '09:00', to: '11:00', durationMin: 30, bufferMin: 0, weeks: 1, startDate: '2026-11-16' }, now), []);
  assert.deepEqual(generatePatternSlots({ weekdays: [1], from: '12:00', to: '09:00', durationMin: 30, bufferMin: 0, weeks: 1, startDate: '2026-11-16' }, now), []);
  const many = generatePatternSlots({ weekdays: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '23:45', durationMin: 15, bufferMin: 0, weeks: 12, startDate: '2026-11-17' }, now);
  assert.equal(many.length, MAX_GENERATED_SLOTS);
  assert.equal(weekdaysLabel([1, 2, 3, 4, 5]), 'ma t/m vr');
  assert.equal(weekdaysLabel([5, 1, 3]), 'ma, wo, vr');
  assert.equal(weekdaysLabel([1, 2, 3, 4, 5, 6, 7]), 'elke dag');
});

test('de maandkalender begint op maandag', () => {
  const grid = monthGrid('2026-11');
  // 1 november 2026 is een zondag: zes lege vakjes ervoor.
  assert.deepEqual(grid[0], [null, null, null, null, null, null, '2026-11-01']);
  assert.equal(grid[grid.length - 1].filter(Boolean).pop(), '2026-11-30');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(fmtMonthLabel('2026-11'), 'november 2026');
  assert.deepEqual(fmtDayParts('2026-11-17'), { weekday: 'di', day: '17', month: 'nov' });
});

test('welk videogesprek: de sleutel van de server, of afgeleid uit de oude zin', () => {
  assert.equal(videoKindOf({ video_service: 'teams', video: 'Videogesprek via Jitsi Meet' }), 'teams');
  assert.equal(videoKindOf({ video_service: null, video: null }), null);
  assert.equal(videoKindOf({ video: 'Videogesprek via Microsoft Teams' }), 'teams');
  assert.equal(videoKindOf({ video: 'Videogesprek via Google Meet' }), 'google_meet');
  assert.equal(videoKindOf({ video: 'Videogesprek — de link staat in je bevestiging' }), 'link');
  assert.equal(videoKindOf({ video: null }), null);
  assert.equal(VIDEO_INFO.teams.name, 'Microsoft Teams');
});

test('agenda-bestand: velden ontsnapt, alleen een echte link', () => {
  const ics = buildIcs({ uid: 'b1/../x', title: 'Gesprek; met, ons\nDTSTART:19990101T000000Z', startsAt: '2026-11-17T09:00:00Z', endsAt: '2026-11-17T09:30:00Z', url: 'https://meet.jit.si/ResoFly-abc' }, Date.UTC(2026, 10, 11));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nDTSTART:20261117T090000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20261117T093000Z\r\n/);
  // De nieuwe regel in de titel wordt \n, geen eigen DTSTART.
  assert.equal(ics.match(/\r\nDTSTART/g)?.length, 1);
  assert.match(ics, /SUMMARY:Gesprek\; met\\, ons\\nDTSTART:19990101T000000Z/);
  assert.match(ics, /UID:b1\.\.x@resofly/);
  assert.match(ics, /URL:https:\/\/meet\.jit\.si\/ResoFly-abc/);
  assert.doesNotMatch(buildIcs({ uid: 'x', title: 'X', startsAt: '2026-11-17T09:00:00Z', endsAt: '2026-11-17T09:30:00Z', url: 'javascript:alert(1)' }), /URL:/);
  assert.equal(buildIcs({ uid: 'x', title: 'X', startsAt: '2026-11-17T09:30:00Z', endsAt: '2026-11-17T09:00:00Z' }), '');
  assert.equal(safeMeetingLink('https://x.nl/a b'), null);
  assert.equal(icsText('a\\b'), 'a\\\\b');
});

test('de dienst van een link in het beheer, zoals de server hem ziet', () => {
  assert.equal(linkVideoKind({ meeting_url: null, auto_conference: true, conference_provider: 'teams' }, 'native'), 'teams');
  assert.equal(linkVideoKind({ meeting_url: null, auto_conference: true, conference_provider: 'calendar' }, 'google'), 'google_meet');
  assert.equal(linkVideoKind({ meeting_url: null, auto_conference: true, conference_provider: 'calendar' }, 'native'), null);
  assert.equal(linkVideoKind({ meeting_url: null, auto_conference: false, conference_provider: 'jitsi' }, 'native'), null);
  assert.equal(linkVideoKind({ meeting_url: 'https://us02web.zoom.us/j/1', auto_conference: true, conference_provider: 'jitsi' }, 'native'), 'zoom');
  assert.equal(linkVideoKind({ meeting_url: 'https://whereby.com/x', auto_conference: true, conference_provider: 'jitsi' }, 'native'), 'link');
});
