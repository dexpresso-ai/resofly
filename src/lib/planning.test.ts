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
import type { Task } from '../types.ts';
import { applyPlanningLocally, mergeTaskRows, comparePlannedTasks, PLANNING_ORDER_STEP } from './planning.ts';

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

test('mergeTaskRows overschrijft op id en voegt onbekende rijen toe', () => {
  const tasks = [task('a', '2026-08-11', 1000), task('b', '2026-08-11', 2000)];
  const merged = mergeTaskRows(tasks, [task('a', '2026-08-12', 5000), task('c', null, null)]);
  assert.equal(merged.length, 3);
  assert.equal(merged.find(t => t.id === 'a')!.planned_date, '2026-08-12');
  assert.equal(merged.find(t => t.id === 'b')!.planned_order, 2000);
  assert.ok(merged.some(t => t.id === 'c'));
});
