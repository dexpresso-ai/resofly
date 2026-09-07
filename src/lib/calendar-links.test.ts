/**
 * Tests voor het rekenwerk rond afspraak ↔ taak. Draaien met:  npm test
 *
 * De dubbeltellings-correctie in de weekplanner leunt hierop: een taak van
 * vier uur met een meeting van anderhalf uur op dezelfde dag mag niet als
 * vijfenhalf uur in de dagbalk terechtkomen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarEventLink, CalendarExternalEvent } from '../types.ts';
import {
  calendarEventKey,
  calendarEventLinkMatchesEvent,
  calendarLinkKey,
  formatLinkShort,
  formatLinkWhen,
  groupLinksByTask,
  linkMinutes,
  linkedMinutesOnDay,
  localDayKey,
  remainingEstimateOnDay,
} from './calendar-links.ts';

/** Lokale tijd als ISO-string, zodat de test in elke tijdzone hetzelfde doet. */
function local(year: number, month: number, day: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

function link(id: string, startsAt: string, endsAt: string | null, extra: Partial<CalendarEventLink> = {}): CalendarEventLink {
  return {
    id,
    organization_id: 'org-1',
    created_by: null,
    provider: 'google',
    calendar_source_id: 'src-1',
    provider_calendar_id: null,
    provider_event_id: `ev-${id}`,
    event_starts_at: startsAt,
    event_ends_at: endsAt,
    event_all_day: false,
    event_title_snapshot: 'Kick-off',
    client_id: null,
    project_id: null,
    task_id: 'task-1',
    track_time: true,
    created_at: '2026-09-01T09:00:00Z',
    updated_at: '2026-09-01T09:00:00Z',
    ...extra,
  };
}

function event(id: string, startsAt: string): CalendarExternalEvent {
  return {
    id, provider: 'google', source_id: 'src-1', source_name: 'Werk', provider_event_id: `ev-${id}`,
    title: 'Kick-off', description: null, location: null, starts_at: startsAt, ends_at: startsAt, all_day: false,
    html_link: null, visibility: 'organization',
  };
}

test('koppeling en afspraak vinden elkaar op provider, agenda, event-id en starttijd', () => {
  const start = local(2026, 9, 8, 10);
  const row = link('a', start, local(2026, 9, 8, 11, 30));
  assert.equal(calendarEventLinkMatchesEvent(row, event('a', start)), true);
  assert.equal(calendarEventLinkMatchesEvent(row, event('a', local(2026, 9, 9, 10))), false, 'andere starttijd = andere instantie');
  assert.equal(calendarEventLinkMatchesEvent(row, event('b', start)), false);
  assert.equal(calendarEventKey(event('a', start)), calendarLinkKey(row), 'dezelfde sleutel vanuit beide kanten');
});

test('minuten per dag: alleen het deel dat op die dag valt', () => {
  const rows = [link('a', local(2026, 9, 8, 10), local(2026, 9, 8, 11, 30))];
  assert.equal(linkedMinutesOnDay(rows, '2026-09-08'), 90);
  assert.equal(linkedMinutesOnDay(rows, '2026-09-09'), 0);
});

test('een afspraak over middernacht wordt per kalenderdag geknipt', () => {
  const rows = [link('a', local(2026, 9, 8, 23), local(2026, 9, 9, 1))];
  assert.equal(linkedMinutesOnDay(rows, '2026-09-08'), 60);
  assert.equal(linkedMinutesOnDay(rows, '2026-09-09'), 60);
});

test('hele-dag-items en koppelingen zonder eind tellen geen minuten', () => {
  const rows = [
    link('a', local(2026, 9, 8, 0), local(2026, 9, 9, 0), { event_all_day: true }),
    link('b', local(2026, 9, 8, 14), null),
  ];
  assert.equal(linkedMinutesOnDay(rows, '2026-09-08'), 0);
  assert.equal(linkMinutes(rows[0]), 0);
  assert.equal(linkMinutes(rows[1]), 0);
});

test('resterende schatting: de meeting zit al in de agendabalk', () => {
  const rows = [link('a', local(2026, 9, 8, 10), local(2026, 9, 8, 11, 30))];
  assert.equal(remainingEstimateOnDay(240, rows, '2026-09-08'), 150);
  assert.equal(remainingEstimateOnDay(60, rows, '2026-09-08'), 0, 'nooit onder nul');
  assert.equal(remainingEstimateOnDay(240, rows, '2026-09-09'), 240, 'andere dag: niets af te trekken');
});

test('groeperen per taak, gesorteerd op starttijd; koppelingen zonder taak vallen weg', () => {
  const later = link('b', local(2026, 9, 10, 13), local(2026, 9, 10, 15));
  const earlier = link('a', local(2026, 9, 8, 10), local(2026, 9, 8, 11));
  const orphan = link('c', local(2026, 9, 9, 9), local(2026, 9, 9, 10), { task_id: null });
  const grouped = groupLinksByTask([later, orphan, earlier]);
  assert.deepEqual([...grouped.keys()], ['task-1']);
  assert.deepEqual(grouped.get('task-1')!.map(row => row.id), ['a', 'b']);
});

test('korte en volledige labels', () => {
  const row = link('a', local(2026, 9, 8, 10), local(2026, 9, 8, 11, 30));
  assert.equal(formatLinkShort(row), 'di 10:00–11:30');
  assert.equal(formatLinkWhen(row), 'di 8 sep · 10:00–11:30');
  assert.equal(formatLinkShort({ ...row, event_all_day: true }), 'di · hele dag');
  assert.equal(linkMinutes(row), 90);
  assert.equal(localDayKey(row.event_starts_at), '2026-09-08');
});
