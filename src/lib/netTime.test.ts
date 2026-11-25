/**
 * Netto tijd in de weekplanner: werktijd − afspraken = netto, netto − taken = vrij.
 * Draaien met: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarEventLink, Task } from '../types.ts';
import {
  autoPlanWindowEnd,
  dayTaskMinutes,
  DEFAULT_WORKDAY_MINUTES,
  isWeekendKey,
  isWorkday,
  netDay,
  netWeek,
  ownCalendarEvents,
  spanShares,
  taskLoadByDay,
  workdayFrom,
  workMinutesOn,
} from './netTime.ts';
import { weekMeter } from './weekView.ts';

// Maandag 23 t/m zondag 29 november 2026.
const WEEK = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29'];

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, organization_id: 'org-1', created_by: null, project_id: null, client_id: null,
    title: `Taak ${id}`, description: null, status: 'todo', priority: 'med', tags: [],
    start_date: null, end_date: null, planned_date: null, planned_end_date: null,
    planned_start_minute: null, planned_order: null, estimated_minutes: 60, subtasks: [],
    ...patch,
  } as Task;
}

function link(taskId: string, startsAt: string, endsAt: string): CalendarEventLink {
  return {
    id: `l-${startsAt}`, organization_id: 'org-1', task_id: taskId, provider: 'native', calendar_source_id: 'src',
    provider_event_id: 'p', event_starts_at: startsAt, event_ends_at: endsAt, event_all_day: false,
  } as CalendarEventLink;
}

const noLinks = () => [] as CalendarEventLink[];

test('zonder instelling rekent de planner met acht uur op een werkdag', () => {
  const standaard = workdayFrom(null);
  assert.equal(standaard.minutes, DEFAULT_WORKDAY_MINUTES);
  assert.equal(standaard.isDefault, true);
  assert.equal(standaard.includeWeekend, false);
  // Een rij met 0 minuten was "geen streep"; zonder werktijd is er geen netto tijd.
  assert.equal(workdayFrom({ minutes: 0, include_weekend: true }).minutes, 480);
  assert.equal(workdayFrom({ minutes: 0, include_weekend: true }).includeWeekend, true);
  const eigen = workdayFrom({ minutes: 360, include_weekend: false });
  assert.deepEqual(eigen, { minutes: 360, includeWeekend: false, isDefault: false });
});

test('het weekend heeft geen werktijd, tenzij het meetelt', () => {
  assert.equal(isWeekendKey('2026-11-28'), true);
  assert.equal(isWeekendKey('2026-11-29'), true);
  assert.equal(isWeekendKey('2026-11-27'), false);
  assert.equal(workMinutesOn('2026-11-28', workdayFrom(null)), 0);
  assert.equal(workMinutesOn('2026-11-28', workdayFrom({ minutes: 300, include_weekend: true })), 300);
  assert.equal(workMinutesOn('2026-11-24', workdayFrom(null)), 480);
});

test('afspraken gaan van de werktijd af; wat overblijft is netto, en daar passen de taken in', () => {
  const day = netDay('2026-11-24', workdayFrom(null), 150, 240);
  assert.equal(day.workMinutes, 480);
  assert.equal(day.netMinutes, 330, '8u − 2u30 afspraken = 5u30 netto');
  assert.equal(day.freeMinutes, 90, '5u30 netto − 4u taken = 1u30 vrij');

  const vol = netDay('2026-11-24', workdayFrom(null), 300, 240);
  assert.equal(vol.netMinutes, 180);
  assert.equal(vol.freeMinutes, -60, 'een uur te veel');

  const meetingdag = netDay('2026-11-24', workdayFrom(null), 600, 0);
  assert.equal(meetingdag.netMinutes, 0, 'netto zakt nooit onder nul');
});

test('een dag die niet meetelt heeft geen netto tijd en geen "vrij"', () => {
  const zaterdag = netDay('2026-11-28', workdayFrom(null), 60, 120);
  assert.equal(zaterdag.counts, false);
  assert.equal(zaterdag.netMinutes, 0);
  assert.equal(zaterdag.freeMinutes, null);
});

test('de week telt alleen de werkdagen; het weekend staat apart', () => {
  const workday = workdayFrom(null);
  const meetings = [60, 180, 60, 180, 60, 120, 0];
  const tasks = [240, 120, 300, 60, 0, 90, 0];
  const week = netWeek(WEEK.map((key, i) => netDay(key, workday, meetings[i], tasks[i])));
  assert.equal(week.workMinutes, 5 * 480);
  assert.equal(week.meetingMinutes, 540, 'de zaterdagmeeting telt niet tegen je werkweek');
  assert.equal(week.netMinutes, 2400 - 540);
  assert.equal(week.taskMinutes, 720);
  assert.equal(week.freeMinutes, 2400 - 540 - 720);
  assert.equal(week.offDayMinutes, 210);
});

test('de weekbalk schaalt op de werktijd: afspraken, taken en de rest is vrij', () => {
  const week = netWeek(WEEK.map(key => netDay(key, workdayFrom(null), 120, 240)));
  const meter = weekMeter(week.meetingMinutes, week.taskMinutes, week.workMinutes);
  assert.equal(meter.agendaPct, 25);
  assert.equal(meter.taskPct, 50);
  assert.equal(meter.freeMinutes, 600);
  assert.equal(meter.overMinutes, 0);
});

test('alleen je eigen agenda telt; zonder eigen agenda of nog niet geladen: alles', () => {
  const events = [{ source_id: 'mijn-google' }, { source_id: 'studio-van-collega' }, { source_id: 'mijn-resofly' }];
  const sources = [
    { id: 'mijn-google', user_id: 'ik' },
    { id: 'mijn-resofly', user_id: 'ik' },
    { id: 'studio-van-collega', user_id: 'collega' },
  ];
  assert.deepEqual(ownCalendarEvents(events, sources, 'ik').map(e => e.source_id), ['mijn-google', 'mijn-resofly']);
  assert.equal(ownCalendarEvents(events, null, 'ik').length, 3, 'agenda\'s nog niet geladen');
  assert.equal(ownCalendarEvents(events, [{ id: 'studio-van-collega', user_id: 'collega' }], 'ik').length, 3, 'geen eigen agenda: de gedeelde is de jouwe');
  const uit = [{ id: 'mijn-google', user_id: 'ik', sync_enabled: false }, { id: 'studio-van-collega', user_id: 'collega', sync_enabled: true }];
  assert.equal(ownCalendarEvents(events, uit, 'ik').length, 3, 'je eigen agenda staat op niet tonen: dan blijft de gedeelde staan');
});

test('een blok in het rooster telt zijn blok, ook zonder schatting', () => {
  const blok = task('b', { planned_date: '2026-11-24', planned_start_minute: 600, estimated_minutes: null });
  assert.equal(dayTaskMinutes(blok, '2026-11-24', []), 60, 'een blok zonder schatting staat er een uur');
  const losse = task('l', { planned_date: '2026-11-24', estimated_minutes: null });
  assert.equal(dayTaskMinutes(losse, '2026-11-24', []), 0, 'zonder tijd en zonder schatting: geen verzonnen uur');
  const metMeeting = task('m', { planned_date: '2026-11-24', estimated_minutes: 240 });
  const links = [link('m', '2026-11-24T10:00:00', '2026-11-24T11:30:00')];
  assert.equal(dayTaskMinutes(metMeeting, '2026-11-24', links), 150, 'de gekoppelde meeting staat al bij de afspraken');
});

test('een weekstrook verdeelt zich over zijn werkdagen, ook buiten de week in beeld', () => {
  const workday = workdayFrom(null);
  // Twee weken, 20 uur: tien werkdagen, dus twee uur per werkdag.
  const strook = task('s', { planned_date: '2026-11-23', planned_end_date: '2026-12-06', estimated_minutes: 1200 });
  const shares = spanShares(strook, WEEK, workday, []);
  assert.equal(shares.get('2026-11-23'), 120);
  assert.equal(shares.get('2026-11-27'), 120);
  assert.equal(shares.has('2026-11-28'), false, 'het weekend telt niet mee, dus daar valt niets');
  assert.equal([...shares.values()].reduce((a, b) => a + b, 0), 600, 'de helft valt in deze week');

  // Een strook die alleen in het weekend ligt, verdeelt zich over het weekend.
  const weekend = task('w', { planned_date: '2026-11-28', planned_end_date: '2026-11-29', estimated_minutes: 120 });
  assert.equal(spanShares(weekend, WEEK, workday, []).get('2026-11-28'), 60);
});

test('de taaklast per dag: dagtaken, blokken en het aandeel van stroken', () => {
  const tasks = [
    task('a', { planned_date: '2026-11-24', estimated_minutes: 90 }),
    task('b', { planned_date: '2026-11-24', planned_start_minute: 540, estimated_minutes: 120 }),
    task('c', { planned_date: '2026-11-23', planned_end_date: '2026-11-27', estimated_minutes: 300 }),
    task('d', { planned_date: '2026-12-01', estimated_minutes: 60 }),
    task('e', {}),
  ];
  const load = taskLoadByDay(WEEK, tasks, workdayFrom(null), noLinks);
  assert.deepEqual(load.get('2026-11-24'), { minutes: 210, spanMinutes: 60 });
  assert.deepEqual(load.get('2026-11-23'), { minutes: 0, spanMinutes: 60 });
  assert.deepEqual(load.get('2026-11-28'), { minutes: 0, spanMinutes: 0 });
});

test('het venster van "Vul mijn week" groeit mee met een lange werkdag', () => {
  assert.equal(autoPlanWindowEnd(workdayFrom(null)), 17 * 60);
  assert.equal(autoPlanWindowEnd(workdayFrom({ minutes: 360, include_weekend: false })), 17 * 60, 'korter dan acht uur: het venster blijft, de werktijd is de grens');
  assert.equal(autoPlanWindowEnd(workdayFrom({ minutes: 600, include_weekend: false })), 19 * 60);
  assert.equal(autoPlanWindowEnd(workdayFrom({ minutes: 1200, include_weekend: false })), 23 * 60);
});

// ── Vrije dagen (2026-11-25) ────────────────────────────────────────────────

test('een vrije dag heeft geen werktijd en geen "vrij"; wat er toch staat telt als extra', () => {
  const vrij = netDay('2026-11-27', workdayFrom(null), 60, 120, true);
  assert.equal(vrij.counts, false);
  assert.equal(vrij.dayOff, true);
  assert.equal(vrij.workMinutes, 0);
  assert.equal(vrij.netMinutes, 0);
  assert.equal(vrij.freeMinutes, null);
  assert.equal(netDay('2026-11-28', workdayFrom(null), 0, 0).dayOff, false, 'een weekenddag is geen vrije dag die je zelf koos');
});

test('de week met een vrije vrijdag: 32 uur werktijd, en de vrijdag staat apart', () => {
  const workday = workdayFrom(null);
  const off = new Set(['2026-11-27']);
  const week = netWeek(WEEK.map(key => netDay(key, workday, 60, key === '2026-11-27' ? 90 : 120, off.has(key))));
  assert.equal(week.workMinutes, 4 * 480);
  assert.equal(week.workdays, 4);
  assert.equal(week.daysOff, 1);
  assert.equal(week.meetingMinutes, 4 * 60);
  assert.equal(week.taskMinutes, 4 * 120);
  assert.equal(week.offDayMinutes, 60 + 90 + 2 * (60 + 120), 'de vrijdag en het weekend');
});

test('een weekstrook slaat je vrije dag over', () => {
  // Ma t/m vr, tien uur, woensdag vrij: vier werkdagen van 2u30.
  const strook = task('s', { planned_date: '2026-11-23', planned_end_date: '2026-11-27', estimated_minutes: 600 });
  const shares = spanShares(strook, WEEK, workdayFrom(null), [], new Set(['2026-11-25']));
  assert.equal(shares.has('2026-11-25'), false);
  assert.equal(shares.get('2026-11-23'), 150);
  assert.equal([...shares.values()].reduce((a, b) => a + b, 0), 600);
  const load = taskLoadByDay(WEEK, [strook], workdayFrom(null), noLinks, new Set(['2026-11-25']));
  assert.equal(load.get('2026-11-25')?.spanMinutes, 0);
});

test('isWorkday en workMinutesOn kennen de vrije dagen', () => {
  const off = new Set(['2026-11-24']);
  assert.equal(isWorkday('2026-11-24', workdayFrom(null), off), false);
  assert.equal(workMinutesOn('2026-11-24', workdayFrom(null), off), 0);
  assert.equal(workMinutesOn('2026-11-25', workdayFrom(null), off), 480);
});
