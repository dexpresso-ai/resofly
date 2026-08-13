/**
 * Tests voor de client-side spiegeling van `reorder_task_planning`. Draaien met:  npm test
 *
 * Deze logica bestaat alleen omdat een versleepte taak meteen op zijn nieuwe plek
 * moet staan, vóór de server antwoordt. Wijkt hij af van de RPC, dan springt de
 * kaart een fractie later alsnog terug — precies het gedrag dat we kwijt wilden.
 * De verwachtingen hieronder komen daarom uit de SQL van migratie
 * 20260528000001_weekplanner_planning_fields.sql, niet uit de TypeScript.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarExternalEvent, Task } from '../types.ts';
import {
  applyPeriodLocally,
  applyPlanningLocally,
  comparePlannedTasks,
  edgeScrollDelta,
  EDGE_SCROLL_MAX_PX,
  EDGE_SCROLL_ZONE_PX,
  isSpanningTask,
  groupEventMinutesByDay,
  layoutWeekBars,
  mergeTaskRows,
  PANE_EDGE_SCROLL_ZONE_PX,
  shiftDateKey,
  PLANNING_ORDER_STEP,
} from './planning.ts';

function task(id: string, plannedDate: string | null, plannedOrder: number | null, createdAt = '2026-08-01T09:00:00Z'): Task {
  return {
    id,
    organization_id: 'org-1',
    created_by: null,
    project_id: null,
    client_id: null,
    title: `Taak ${id}`,
    description: null,
    status: 'todo',
    priority: 'med',
    tags: [],
    start_date: null,
    end_date: null,
    planned_date: plannedDate,
    planned_end_date: null,
    planned_order: plannedOrder,
    estimated_minutes: 60,
    subtasks: [],
    comments: [],
    created_at: createdAt,
    updated_at: createdAt,
  };
}

/** Ids van één plandag, in de volgorde waarin de planner ze toont. */
function orderOn(tasks: Task[], date: string | null): string[] {
  return tasks
    .filter(t => (t.planned_date ?? null) === date)
    .sort(comparePlannedTasks)
    .map(t => t.id);
}

test('taak uit de lade naar een lege dag krijgt de eerste volgordestap', () => {
  const tasks = [task('a', null, null)];
  const next = applyPlanningLocally(tasks, 'a', '2026-08-11', null);
  const moved = next.find(t => t.id === 'a')!;
  assert.equal(moved.planned_date, '2026-08-11');
  assert.equal(moved.planned_order, PLANNING_ORDER_STEP);
});

test('zonder doeltaak belandt de taak onderaan de dag', () => {
  const tasks = [
    task('a', '2026-08-11', 1000),
    task('b', '2026-08-11', 2000),
    task('c', null, null),
  ];
  const next = applyPlanningLocally(tasks, 'c', '2026-08-11', null);
  assert.deepEqual(orderOn(next, '2026-08-11'), ['a', 'b', 'c']);
});

test('met een doeltaak schuift de taak er precies vóór', () => {
  const tasks = [
    task('a', '2026-08-11', 1000),
    task('b', '2026-08-11', 2000),
    task('c', '2026-08-11', 3000),
    task('d', null, null),
  ];
  const next = applyPlanningLocally(tasks, 'd', '2026-08-11', 'b');
  assert.deepEqual(orderOn(next, '2026-08-11'), ['a', 'd', 'b', 'c']);
});

test('herordenen binnen dezelfde dag telt de taak maar één keer mee', () => {
  const tasks = [
    task('a', '2026-08-11', 1000),
    task('b', '2026-08-11', 2000),
    task('c', '2026-08-11', 3000),
  ];
  const next = applyPlanningLocally(tasks, 'c', '2026-08-11', 'a');
  assert.deepEqual(orderOn(next, '2026-08-11'), ['c', 'a', 'b']);
  // De hele dag is hernummerd met ruime stappen, net als in de database.
  assert.deepEqual(
    next.filter(t => t.planned_date === '2026-08-11').sort(comparePlannedTasks).map(t => t.planned_order),
    [1000, 2000, 3000],
  );
});

test('de dag waar de taak vandaan komt houdt geen gat', () => {
  const tasks = [
    task('a', '2026-08-11', 1000),
    task('b', '2026-08-11', 2000),
    task('c', '2026-08-11', 3000),
  ];
  const next = applyPlanningLocally(tasks, 'b', '2026-08-12', null);
  assert.deepEqual(orderOn(next, '2026-08-11'), ['a', 'c']);
  assert.deepEqual(
    next.filter(t => t.planned_date === '2026-08-11').sort(comparePlannedTasks).map(t => t.planned_order),
    [1000, 2000],
  );
  assert.equal(next.find(t => t.id === 'b')!.planned_order, 1000);
});

test('terug naar de lade wist datum én volgorde', () => {
  const tasks = [
    task('a', '2026-08-11', 1000),
    task('b', '2026-08-11', 2000),
  ];
  const next = applyPlanningLocally(tasks, 'a', null, null);
  const moved = next.find(t => t.id === 'a')!;
  assert.equal(moved.planned_date, null);
  assert.equal(moved.planned_order, null);
  // En de achterblijvende dag is opnieuw genummerd vanaf de eerste stap.
  assert.equal(next.find(t => t.id === 'b')!.planned_order, 1000);
});

test('taken zonder volgorde sorteren op aanmaakmoment, zoals de database doet', () => {
  const tasks = [
    task('laat', '2026-08-11', null, '2026-08-05T12:00:00Z'),
    task('vroeg', '2026-08-11', null, '2026-08-02T12:00:00Z'),
    task('eerste', '2026-08-11', 1000),
  ];
  assert.deepEqual(orderOn(tasks, '2026-08-11'), ['eerste', 'vroeg', 'laat']);
});

test('een onbekende taak laat de lijst ongemoeid', () => {
  const tasks = [task('a', '2026-08-11', 1000)];
  assert.equal(applyPlanningLocally(tasks, 'weg', '2026-08-12', null), tasks);
});

// ── Weekstroken ─────────────────────────────────────────────────────────────
// De week van maandag 10 t/m zondag 16 augustus 2026.
const WEEK = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'];

function bar(id: string, start: string, end: string | null): Task {
  return { ...task(id, start, 1000), planned_end_date: end };
}

test('alleen werk over meer dan één dag is een weekstrook', () => {
  assert.equal(isSpanningTask(bar('a', '2026-08-10', '2026-08-12')), true);
  assert.equal(isSpanningTask(bar('b', '2026-08-10', '2026-08-10')), false, 'begin en einde op dezelfde dag is een dagtaak');
  assert.equal(isSpanningTask(bar('c', '2026-08-10', null)), false);
  assert.equal(isSpanningTask({ ...task('d', null, null), planned_end_date: '2026-08-12' }), false, 'zonder startdag geen strook');
});

test('shiftDateKey stapt over een maandgrens heen', () => {
  assert.equal(shiftDateKey('2026-08-31', 1), '2026-09-01');
  assert.equal(shiftDateKey('2026-09-01', -1), '2026-08-31');
  assert.equal(shiftDateKey('2026-08-10', 0), '2026-08-10');
});

test('stroken krijgen de juiste kolom en breedte', () => {
  const { bars } = layoutWeekBars(WEEK, [bar('a', '2026-08-11', '2026-08-14')]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].startIdx, 1);
  assert.equal(bars[0].span, 4);
  assert.equal(bars[0].continuesLeft, false);
  assert.equal(bars[0].continuesRight, false);
});

test('een strook die buiten de week doorloopt wordt afgekapt en gemarkeerd', () => {
  const { bars } = layoutWeekBars(WEEK, [bar('a', '2026-08-05', '2026-08-20')]);
  assert.equal(bars[0].startIdx, 0);
  assert.equal(bars[0].span, 7);
  assert.equal(bars[0].continuesLeft, true);
  assert.equal(bars[0].continuesRight, true);
});

test('stroken buiten de week vallen weg', () => {
  const { bars, laneCount } = layoutWeekBars(WEEK, [
    bar('voor', '2026-08-01', '2026-08-09'),
    bar('na', '2026-08-17', '2026-08-20'),
  ]);
  assert.equal(bars.length, 0);
  assert.equal(laneCount, 0);
});

test('de langste strook claimt de bovenste rij en kortere vullen de gaten', () => {
  // Dezelfde inpaklogica als de hele-dag-rij van de agenda: sorteren op
  // startdag, dan op lengte aflopend, en per rij de eerste vrije plek pakken.
  const { bars, laneCount } = layoutWeekBars(WEEK, [
    bar('heleweek', '2026-08-10', '2026-08-16'),
    bar('maWo', '2026-08-10', '2026-08-12'),
    bar('diVr', '2026-08-11', '2026-08-14'),
    bar('doVr', '2026-08-13', '2026-08-14'),
  ]);
  const lanes = Object.fromEntries(bars.map(b => [b.task.id, b.lane]));
  assert.equal(lanes.heleweek, 0, 'de langste balk op de startdag pakt de bovenste rij');
  assert.equal(lanes.maWo, 1);
  assert.equal(lanes.diVr, 2);
  assert.equal(lanes.doVr, 1, 'past achter maWo in rij 1, want die eindigt op index 3');
  assert.equal(laneCount, 3);
});

test('tijdens het herschalen mag een strook even één dag breed zijn', () => {
  const { bars } = layoutWeekBars(WEEK, [bar('a', '2026-08-12', '2026-08-12')]);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].span, 1);
});

test('applyPeriodLocally zet begin en einde van een strook', () => {
  const tasks = [bar('a', '2026-08-10', '2026-08-12')];
  const next = applyPeriodLocally(tasks, 'a', '2026-08-11', '2026-08-15');
  const moved = next.find(t => t.id === 'a')!;
  assert.equal(moved.planned_date, '2026-08-11');
  assert.equal(moved.planned_end_date, '2026-08-15');
});

test('een strook terugbrengen tot één dag maakt er weer een dagtaak van', () => {
  const tasks = [
    task('bestaand', '2026-08-12', 1000),
    bar('strook', '2026-08-10', '2026-08-14'),
  ];
  const next = applyPeriodLocally(tasks, 'strook', '2026-08-12', '2026-08-12');
  const moved = next.find(t => t.id === 'strook')!;
  assert.equal(moved.planned_end_date, null, 'einde gelijk aan begin telt niet als strook');
  assert.equal(moved.planned_date, '2026-08-12');
  // En hij krijgt een plek achteraan de volgorde van die dag.
  assert.deepEqual(orderOn(next, '2026-08-12'), ['bestaand', 'strook']);
});

test('een einddatum vóór de begindatum wordt genegeerd', () => {
  const tasks = [bar('a', '2026-08-10', '2026-08-14')];
  const next = applyPeriodLocally(tasks, 'a', '2026-08-12', '2026-08-11');
  assert.equal(next.find(t => t.id === 'a')!.planned_end_date, null);
});

test('een strook in een dagkolom laten vallen wist zijn looptijd', () => {
  const tasks = [bar('strook', '2026-08-10', '2026-08-14'), task('ander', '2026-08-13', 1000)];
  const next = applyPlanningLocally(tasks, 'strook', '2026-08-13', null);
  assert.equal(next.find(t => t.id === 'strook')!.planned_end_date, null);
  // De andere taken op die dag houden hun eigen looptijd.
  assert.equal(next.find(t => t.id === 'ander')!.planned_end_date, null);
});

// ── Agenda-uren per dag ─────────────────────────────────────────────────────

function event(startsAt: string, endsAt: string, allDay = false): CalendarExternalEvent {
  return {
    id: `${startsAt}-${endsAt}`, provider: 'native', source_id: 'src', source_name: 'Agenda',
    provider_event_id: 'p', title: 'Afspraak', description: null, location: null,
    starts_at: startsAt, ends_at: endsAt, all_day: allDay, html_link: null, visibility: 'organization',
  } as CalendarExternalEvent;
}

test('een afspraak telt zijn minuten op de dag waarop hij valt', () => {
  const byDay = groupEventMinutesByDay(WEEK, [event('2026-08-11T09:30:00', '2026-08-11T11:00:00')]);
  assert.equal(byDay.get('2026-08-11')!.minutes, 90);
  assert.equal(byDay.get('2026-08-11')!.items.length, 1);
  assert.equal(byDay.get('2026-08-10')!.minutes, 0);
});

test('een afspraak over middernacht wordt per kalenderdag geknipt', () => {
  const byDay = groupEventMinutesByDay(WEEK, [event('2026-08-11T23:00:00', '2026-08-12T01:30:00')]);
  assert.equal(byDay.get('2026-08-11')!.minutes, 60, 'het uur vóór middernacht hoort bij dinsdag');
  assert.equal(byDay.get('2026-08-12')!.minutes, 90, 'de anderhalf uur erna bij woensdag');
});

test('hele-dag-items claimen geen uren', () => {
  const byDay = groupEventMinutesByDay(WEEK, [event('2026-08-11T00:00:00', '2026-08-12T00:00:00', true)]);
  assert.equal(byDay.get('2026-08-11')!.minutes, 0);
  assert.equal(byDay.get('2026-08-11')!.items.length, 0);
});

test('afspraken buiten de week en lege afspraken tellen niet mee', () => {
  const byDay = groupEventMinutesByDay(WEEK, [
    event('2026-07-01T09:00:00', '2026-07-01T10:00:00'),
    event('2026-08-11T09:00:00', '2026-08-11T09:00:00'),
    event('2026-08-11T12:00:00', '2026-08-11T11:00:00'),
  ]);
  assert.equal([...byDay.values()].reduce((sum, bucket) => sum + bucket.minutes, 0), 0);
});

test('afspraken op dezelfde dag staan op tijd gesorteerd', () => {
  const byDay = groupEventMinutesByDay(WEEK, [
    event('2026-08-11T15:00:00', '2026-08-11T16:00:00'),
    event('2026-08-11T09:00:00', '2026-08-11T10:00:00'),
  ]);
  const items = byDay.get('2026-08-11')!.items;
  assert.deepEqual(items.map(i => i.starts_at), ['2026-08-11T09:00:00', '2026-08-11T15:00:00']);
  assert.equal(byDay.get('2026-08-11')!.minutes, 120);
});

// ── Meescrollen bij de randen ───────────────────────────────────────────────
// Op een telefoon staan de zeven dagen onder elkaar; zonder dit kun je een taak
// nooit van maandag naar zondag slepen.

test('midden in het scrollgebied wordt er niet gescrold', () => {
  assert.equal(edgeScrollDelta(400, 0, 800), 0);
});

test('bij de onderrand scrolt het vooruit, bij de bovenrand terug', () => {
  assert.ok(edgeScrollDelta(790, 0, 800) > 0, 'onderrand schuift vooruit');
  assert.ok(edgeScrollDelta(10, 0, 800) < 0, 'bovenrand schuift terug');
});

test('hoe dichter bij de rand, hoe sneller — met het volle tempo aan de rand', () => {
  const dichtbij = edgeScrollDelta(795, 0, 800);
  const verderweg = edgeScrollDelta(730, 0, 800);
  assert.ok(dichtbij > verderweg, 'dichter bij de rand gaat sneller');
  assert.equal(edgeScrollDelta(800, 0, 800), EDGE_SCROLL_MAX_PX);
  assert.equal(edgeScrollDelta(0, 0, 800), -EDGE_SCROLL_MAX_PX);
});

test('net buiten de randzone gebeurt er niets', () => {
  assert.equal(edgeScrollDelta(EDGE_SCROLL_ZONE_PX, 0, 800), 0);
  assert.equal(edgeScrollDelta(800 - EDGE_SCROLL_ZONE_PX, 0, 800), 0);
});

test('een gebied dat kleiner is dan twee randzones scrolt nooit vanzelf', () => {
  // Anders zou élke positie in een randzone vallen en het gebied blijven schuiven.
  const klein = EDGE_SCROLL_ZONE_PX * 2 - 1;
  assert.equal(edgeScrollDelta(0, 0, klein), 0);
  assert.equal(edgeScrollDelta(klein, 0, klein), 0);
  assert.equal(edgeScrollDelta(klein / 2, 0, klein), 0);
});

test('de randzone rekent met de positie van het gebied, niet met nul', () => {
  // Een scrollgebied dat lager op de pagina begint: 200 is dan de bovenrand.
  assert.ok(edgeScrollDelta(210, 200, 1000) < 0);
  assert.equal(edgeScrollDelta(400, 200, 1000), 0);
});

test('een vak binnen de pagina krijgt een smallere randzone', () => {
  // Een dagkolom van 300px hoog: met de volle randzone (84) zou er nauwelijks
  // neutraal midden overblijven. Met de vakzone (30) wel.
  const hoogte = 300;
  assert.equal(edgeScrollDelta(150, 0, hoogte, PANE_EDGE_SCROLL_ZONE_PX), 0, 'het midden ligt stil');
  assert.ok(edgeScrollDelta(hoogte - 5, 0, hoogte, PANE_EDGE_SCROLL_ZONE_PX) > 0, 'onderin schuift het vak vooruit');
  assert.ok(edgeScrollDelta(5, 0, hoogte, PANE_EDGE_SCROLL_ZONE_PX) < 0, 'bovenin schuift het terug');
  // Een vak dat kleiner is dan twee vakzones blijft ook hier stilstaan.
  assert.equal(edgeScrollDelta(30, 0, PANE_EDGE_SCROLL_ZONE_PX * 2 - 1, PANE_EDGE_SCROLL_ZONE_PX), 0);
});

test('mergeTaskRows overschrijft op id en voegt onbekende rijen toe', () => {
  const tasks = [task('a', '2026-08-11', 1000), task('b', '2026-08-11', 2000)];
  const merged = mergeTaskRows(tasks, [task('a', '2026-08-12', 5000), task('c', null, null)]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(t => t.id === 'a')!.planned_date, '2026-08-12');
  assert.equal(merged.find(t => t.id === 'b')!.planned_order, 2000);
  assert.ok(merged.some(t => t.id === 'c'));
});
