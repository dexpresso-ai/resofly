import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type EventRow, type FeedEventRow,
  FEED_TOKEN_RE, ROBOTS_TXT, X_ROBOTS_TAG, buildFeed, feedTokenFromPath, foldIcsLine, icsForEvent, multigetUids, parseComponents, parseICalEvent,
  postgrestInList, sha256Hex, unfoldIcs,
} from './logic.ts';
import { FEED_TOKEN_RE as SHARED_FEED_TOKEN_RE, generateFeedToken, hashFeedToken } from '../../../supabase/functions/_shared/calendarFeed.ts';

/**
 * De agendaserver op caldav-staging.resofly.com. Twee soorten bezoekers: de
 * eigen telefoon of computer (CalDAV) ziet alles van de afspraak; wie een
 * deellink heeft, ziet alleen wat de eigenaar koos. Deze tests bewaken vooral
 * die tweede grens.
 */

const NOW = new Date('2026-11-13T10:00:00Z');

function event(over: Partial<EventRow> = {}): EventRow {
  return {
    id: '00000000-0000-4000-8000-000000000001', source_id: '00000000-0000-4000-8000-000000000002', uid: 'afspraak-1',
    icalendar_raw: null, title: 'Overleg met Bakkerij de Vries', description: 'Prijsafspraak bespreken; marge 12%',
    location: 'Keizersgracht 1, Amsterdam', meeting_url: 'https://meet.jit.si/resofly-geheim', starts_at: '2026-11-16T08:00:00.000Z',
    ends_at: '2026-11-16T09:00:00.000Z', all_day: false, rrule: null, exdate: null, sequence: 2, etag: 'e1', sync_rev: 4,
    deleted_at: null, updated_at: '2026-11-12T15:30:00.000Z', ...over,
  };
}

function lines(ics: string): string[] {
  return unfoldIcs(ics).filter(Boolean);
}

// Zoals een iPhone een afspraak stuurt: met tijdzone, een herinnering, een
// genodigde, een omschrijving en een verplaatste keer.
const IPHONE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//iPhone OS 18.1//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Amsterdam',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'DTSTART:19810329T020000',
  'TZNAME:CEST',
  'TZOFFSETTO:+0200',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'DTSTART:19961027T030000',
  'TZNAME:CET',
  'TZOFFSETTO:+0100',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:3F2A-IPHONE',
  'DTSTAMP:20261110T090000Z',
  'DTSTART;TZID=Europe/Amsterdam:20261116T090000',
  'DTEND;TZID=Europe/Amsterdam:20261116T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'EXDATE;TZID=Europe/Amsterdam:20261123T090000',
  'SUMMARY:Weekstart met het team',
  'LOCATION:Kantoor',
  'ATTENDEE;CN="Jan, de klant";PARTSTAT=ACCEPTED:mailto:jan@klant.test',
  'ORGANIZER;CN=Eigenaar:mailto:eigenaar@studio.test',
  'URL:https://meet.google.com/abc-defg-hij',
  'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Kantoor:geo:52.37,4.89',
  'SEQUENCE:3',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Herinnering',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:3F2A-IPHONE',
  'DTSTAMP:20261110T090000Z',
  'RECURRENCE-ID;TZID=Europe/Amsterdam:20261130T090000',
  'DTSTART;TZID=Europe/Amsterdam:20261130T110000',
  'DTEND;TZID=Europe/Amsterdam:20261130T120000',
  'SUMMARY:Weekstart (later)',
  'DESCRIPTION:Geheime agenda van de dag',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('een afspraak van de telefoon lezen: de herinnering is geen omschrijving', () => {
  const parsed = parseICalEvent(IPHONE);
  assert.equal(parsed.title, 'Weekstart met het team');
  assert.equal(parsed.description, null, 'DESCRIPTION:Herinnering hoort bij de VALARM, niet bij de afspraak');
  assert.equal(parsed.startsAt, '2026-11-16T08:00:00.000Z', '9.00 uur Amsterdam in november is 8.00 UTC');
  assert.equal(parsed.timezone, 'Europe/Amsterdam');
  assert.equal(parsed.rrule, 'FREQ=WEEKLY;BYDAY=MO');
  assert.deepEqual(parsed.exdate, ['2026-11-23T08:00:00.000Z']);
  assert.equal(parsed.sequence, 3);
});

test('een parameter tussen aanhalingstekens knipt de regel niet door', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261116T080000Z\r\nSUMMARY;ALTREP="https://voorbeeld.nl/a:b":Lunch\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.equal(parseICalEvent(ics).title, 'Lunch');
});

test('zonder afspraak in de tekst: een nette weigering', () => {
  assert.throws(() => parseICalEvent('BEGIN:VCALENDAR\r\nEND:VCALENDAR'), /geen VEVENT/);
});

test('de eigen telefoon krijgt alles, ook weggelaten keren en de vergaderlink', () => {
  const ics = icsForEvent(event({ rrule: 'FREQ=WEEKLY', exdate: ['2026-11-23T08:00:00.000Z', 'geen datum'] }), NOW);
  const l = lines(ics);
  assert.ok(l.includes('RRULE:FREQ=WEEKLY'));
  assert.ok(l.includes('EXDATE;TZID=Europe/Amsterdam:20261123T090000'), 'een op de telefoon weggehaalde keer blijft weg');
  assert.ok(l.includes('DESCRIPTION:Prijsafspraak bespreken\\; marge 12%'));
  assert.ok(l.includes('URL:https://meet.jit.si/resofly-geheim'));
  assert.ok(l.includes('DTSTAMP:20261112T153000Z'), 'het tijdstempel volgt de laatste wijziging, niet het moment van ophalen');
  assert.equal(icsForEvent(event(), NOW), icsForEvent(event(), new Date('2030-01-01T00:00:00Z')), 'dezelfde afspraak, dezelfde tekst');
});

test('hele dag: datums, en weggelaten keren als datum', () => {
  const l = lines(icsForEvent(event({ all_day: true, starts_at: '2026-12-24T00:00:00.000Z', ends_at: '2026-12-24T00:00:00.000Z', rrule: 'FREQ=DAILY;COUNT=3', exdate: ['2026-12-25T00:00:00.000Z'] }), NOW));
  assert.ok(l.includes('DTSTART;VALUE=DATE:20261224'));
  assert.ok(l.includes('DTEND;VALUE=DATE:20261225'), 'een eind gelijk aan het begin wordt de dag erna');
  assert.ok(l.includes('EXDATE;VALUE=DATE:20261225'));
});

test('een onveilige vergaderlink gaat niet mee', () => {
  const l = lines(icsForEvent(event({ meeting_url: 'javascript:alert(1)' }), NOW));
  assert.ok(!l.some(x => x.startsWith('URL:')));
});

test('deellink "alleen bezet": tijden, verder niets', () => {
  const feed = buildFeed('Kantoor', [event()], 'busy', NOW);
  assert.match(feed, /SUMMARY:Bezet\r\n/);
  for (const geheim of ['Bakkerij', 'Prijsafspraak', 'Keizersgracht', 'meet.jit.si', 'LOCATION', 'DESCRIPTION', 'URL:']) {
    assert.ok(!feed.includes(geheim), `${geheim} hoort niet in een link die alleen bezet toont`);
  }
  assert.ok(feed.includes('DTSTART:20261116T080000Z'));
  assert.ok(feed.includes('X-WR-CALNAME:Kantoor'));
  assert.ok(feed.startsWith('BEGIN:VCALENDAR\r\n') && feed.endsWith('END:VCALENDAR\r\n'));
});

test('deellink "titel, tijd en plaats": geen omschrijving of vergaderlink', () => {
  const feed = buildFeed('Kantoor', [event()], 'details', NOW);
  assert.ok(feed.includes('SUMMARY:Overleg met Bakkerij de Vries'));
  assert.ok(lines(feed).includes('LOCATION:Keizersgracht 1\\, Amsterdam'));
  for (const geheim of ['Prijsafspraak', 'meet.jit.si', 'DESCRIPTION', 'URL:']) assert.ok(!feed.includes(geheim), geheim);
});

test('deellink van een afspraak van de telefoon: tijden met zone, de rest eruit', () => {
  const ev: FeedEventRow = { ...event({ uid: '3F2A-IPHONE', icalendar_raw: IPHONE }) };
  const details = buildFeed('Kantoor', [ev], 'details', NOW);
  const l = lines(details);
  assert.ok(l.includes('DTSTART;TZID=Europe/Amsterdam:20261116T090000'), 'elke maandag 9.00 uur, ook na de zomertijd');
  assert.ok(l.includes('EXDATE;TZID=Europe/Amsterdam:20261123T090000'));
  assert.ok(l.includes('RECURRENCE-ID;TZID=Europe/Amsterdam:20261130T090000'), 'de verplaatste keer gaat mee');
  assert.equal(l.filter(x => x === 'BEGIN:VTIMEZONE').length, 1, 'de tijdzone gaat één keer mee');
  assert.ok(l.includes('SUMMARY:Weekstart met het team'));
  assert.ok(l.includes('SUMMARY:Weekstart (later)'));
  assert.ok(l.includes('LOCATION:Kantoor'));
  for (const geheim of ['ATTENDEE', 'jan@klant.test', 'ORGANIZER', 'meet.google.com', 'X-APPLE', 'VALARM', 'Herinnering', 'Geheime agenda', 'DESCRIPTION']) {
    assert.ok(!details.includes(geheim), `${geheim} hoort niet in een deellink`);
  }
  const busy = buildFeed('Kantoor', [ev], 'busy', NOW);
  assert.ok(!busy.includes('Weekstart') && !busy.includes('LOCATION'), 'bezet: ook bij de telefoon geen titel of plaats');
  assert.equal(lines(busy).filter(x => x === 'SUMMARY:Bezet').length, 2);
});

test('privé op de telefoon blijft "Bezet", ook bij titel en plaats', () => {
  const raw = IPHONE.replace('SUMMARY:Weekstart met het team', 'SUMMARY:Tandarts\r\nCLASS:PRIVATE');
  const feed = buildFeed('Kantoor', [{ ...event({ icalendar_raw: raw }) }], 'details', NOW);
  assert.ok(!feed.includes('Tandarts'));
  assert.ok(lines(feed).includes('SUMMARY:Bezet'));
  assert.ok(feed.includes('SUMMARY:Weekstart (later)'), 'de verplaatste keer zonder CLASS staat er gewoon');
  assert.ok(!feed.includes('CLASS'), 'CLASS zelf gaat niet mee');
});

test('lange regels worden per byte gevouwen, zonder een teken te breken', () => {
  const titel = 'Één overleg 🗓️ ' + 'ë'.repeat(80);
  const feed = buildFeed('Kantoor', [event({ title: titel })], 'details', NOW);
  for (const regel of feed.split('\r\n')) assert.ok(new TextEncoder().encode(regel).length <= 75, `te lang: ${regel}`);
  assert.ok(lines(feed).includes(`SUMMARY:${titel}`), 'na het ontvouwen weer heel');
  assert.equal(foldIcsLine('kort'), 'kort');
});

test('de vorm van een deellink is in de app en de server dezelfde', () => {
  assert.equal(String(FEED_TOKEN_RE), String(SHARED_FEED_TOKEN_RE));
  for (let i = 0; i < 20; i++) assert.match(generateFeedToken(), FEED_TOKEN_RE);
});

test('de server zoekt een link op met dezelfde hash als de app bewaart', async () => {
  const token = generateFeedToken();
  assert.equal(await sha256Hex(token), await hashFeedToken(token));
  assert.match(await sha256Hex(token), /^[0-9a-f]{64}$/);
});

test('alleen /feed/<token>.ics is een deellink', () => {
  const token = 'A'.repeat(43);
  assert.equal(feedTokenFromPath(['feed', `${token}.ics`]), token);
  assert.equal(feedTokenFromPath(['feed', token]), token);
  assert.equal(feedTokenFromPath(['feed', 'kort.ics']), null);
  assert.equal(feedTokenFromPath(['feed', `${token}.ics`, 'meer']), null);
  assert.equal(feedTokenFromPath(['calendars', `${token}.ics`]), null);
  assert.equal(feedTokenFromPath(['feed', `${'A'.repeat(42)}%.ics`]), null);
});

test('een multiget met UID\'s vol komma\'s en aanhalingstekens', () => {
  const body = '<C:calendar-multiget xmlns:D="DAV:"><D:href>/calendars/u/s/a%2Cb.ics</D:href><D:href>/calendars/u/s/x&amp;y.ics</D:href><D:href>/calendars/u/s/a%2Cb.ics</D:href></C:calendar-multiget>';
  assert.deepEqual(multigetUids(body), ['a,b', 'x&y']);
  assert.equal(postgrestInList(['a,b', 'zeg "hoi"', 'c\\d']), '("a,b","zeg \\"hoi\\"","c\\\\d")');
});

test('componenten: een VTIMEZONE blijft heel, met zijn eigen regels', () => {
  const roots = parseComponents(IPHONE);
  assert.equal(roots.length, 1);
  const tz = roots[0].children.find(c => c.name === 'VTIMEZONE');
  assert.ok(tz);
  assert.equal(tz.lines[0], 'BEGIN:VTIMEZONE');
  assert.equal(tz.lines.at(-1), 'END:VTIMEZONE');
  assert.equal(tz.children.length, 2);
});

test('een reeks uit de app staat op de kloktijd, met tijdzone: ook na de zomertijd 9.00 uur', () => {
  // Maandag 16 maart 2026, 9.00 uur wintertijd; op 29 maart gaat de klok vooruit.
  const reeks = event({ starts_at: '2026-03-16T08:00:00.000Z', ends_at: '2026-03-16T09:00:00.000Z', rrule: 'FREQ=WEEKLY;COUNT=6', timezone: 'Europe/Amsterdam', exdate: ['2026-04-06T07:00:00.000Z'] });
  const l = lines(icsForEvent(reeks, NOW));
  assert.ok(l.includes('DTSTART;TZID=Europe/Amsterdam:20260316T090000'), 'begin op de kloktijd');
  assert.ok(l.includes('DTEND;TZID=Europe/Amsterdam:20260316T100000'));
  assert.ok(l.includes('EXDATE;TZID=Europe/Amsterdam:20260406T090000'), 'een weggehaalde keer in de zomer: ook 9.00 uur');
  assert.ok(l.indexOf('BEGIN:VTIMEZONE') > 0 && l.indexOf('BEGIN:VTIMEZONE') < l.indexOf('BEGIN:VEVENT'), 'de tijdzone staat vóór de afspraak');
  assert.ok(l.includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU'), 'zomertijd: de laatste zondag van maart');
  assert.ok(l.includes('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU'), 'wintertijd: de laatste zondag van oktober');
});

test('een losse afspraak blijft in UTC; een reeks zonder bekende zone valt op Amsterdam', () => {
  const los = lines(icsForEvent(event({ timezone: 'Europe/Amsterdam' }), NOW));
  assert.ok(los.includes('DTSTART:20261116T080000Z'));
  assert.ok(!los.includes('BEGIN:VTIMEZONE'));
  const oud = lines(icsForEvent(event({ rrule: 'FREQ=DAILY', timezone: null }), NOW));
  assert.ok(oud.includes('DTSTART;TZID=Europe/Amsterdam:20261116T090000'));
  const onzin = lines(icsForEvent(event({ rrule: 'FREQ=DAILY', timezone: 'Mars/Olympus' }), NOW));
  assert.ok(onzin.includes('DTSTART;TZID=Europe/Amsterdam:20261116T090000'), 'een onbekende zone wordt Amsterdam');
  const heleDag = lines(icsForEvent(event({ all_day: true, starts_at: '2026-12-24T00:00:00.000Z', ends_at: '2026-12-25T00:00:00.000Z', rrule: 'FREQ=YEARLY' }), NOW));
  assert.ok(heleDag.includes('DTSTART;VALUE=DATE:20261224') && !heleDag.includes('BEGIN:VTIMEZONE'), 'een hele dag heeft geen zone nodig');
});

test('deellink: een reeks uit de app met één VTIMEZONE, ook bij twee reeksen', () => {
  const a = event({ uid: 'a', starts_at: '2026-03-16T08:00:00.000Z', ends_at: '2026-03-16T09:00:00.000Z', rrule: 'FREQ=WEEKLY', timezone: 'Europe/Amsterdam' });
  const b = event({ uid: 'b', starts_at: '2025-01-06T13:00:00.000Z', ends_at: '2025-01-06T14:00:00.000Z', rrule: 'FREQ=WEEKLY', timezone: 'Europe/Amsterdam' });
  const l = lines(buildFeed('Kantoor', [a, b], 'busy', NOW));
  assert.equal(l.filter(x => x === 'BEGIN:VTIMEZONE').length, 1);
  assert.ok(l.includes('DTSTART;TZID=Europe/Amsterdam:20260316T090000'));
  assert.ok(l.includes('DTSTART;TZID=Europe/Amsterdam:20250106T140000'));
  assert.ok(l.includes('DTSTART:20240331T020000'), 'de zone begint vóór de vroegste reeks (2025 → vanaf 2024)');
});

test('robots.txt: zoekmachines met hun eigen naam, zodat de Allow van Cloudflare niet wint', () => {
  // Cloudflare zet dit ervoor (de beheerde robots.txt van de zone).
  const cloudflare = 'User-agent: *\nContent-Signal: search=yes,ai-train=no\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n';
  const geheel = `${cloudflare}\n${ROBOTS_TXT}`;
  // Een zoekmachine volgt de groep met zijn eigen naam, en die zegt Disallow.
  for (const bot of ['Googlebot', 'Bingbot', 'DuckDuckBot', 'Applebot', 'YandexBot', 'Baiduspider', 'Ecosia']) {
    const groep = geheel.split(/\n\s*\n/).find(g => g.split('\n').some(l => l.toLowerCase() === `user-agent: ${bot.toLowerCase()}`));
    assert.ok(groep, `geen groep voor ${bot}`);
    assert.ok(groep.split('\n').includes('Disallow: /'), `${bot} mag kijken`);
    assert.ok(!groep.split('\n').includes('Allow: /'), `${bot} krijgt Allow`);
  }
  assert.match(X_ROBOTS_TAG, /noindex/);
  assert.match(X_ROBOTS_TAG, /nofollow/);
});

