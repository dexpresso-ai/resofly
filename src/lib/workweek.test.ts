/**
 * Tests voor de gedeelde rekenmodule. Draaien met:  npm test
 *
 * Deze functies bestonden eerder in drie varianten — startscherm, weekplanner en
 * projectscherm — die stilletjes uiteenliepen: dezelfde taak was op het ene
 * scherm gepland en op het andere ongepland. Wat hier vastligt is de definitie
 * die overal geldt; wijkt een scherm daarvan af, dan is dát de fout.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../types.ts';
import {
  coversDay,
  inWeek,
  isOverdue,
  scopeTasks,
  groupAssigneesByTask,
  taskDayKey,
  taskLastDayKey,
} from './workweek.ts';

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    id: patch.id,
    organization_id: 'org',
    project_id: null,
    client_id: null,
    ticket_id: null,
    title: patch.id,
    description: null,
    status: 'todo',
    priority: 'med',
    tags: [],
    start_date: null,
    end_date: null,
    planned_date: null,
    planned_end_date: null,
    planned_order: null,
    estimated_minutes: null,
    subtasks: [],
    comments: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...patch,
  } as Task;
}

test('taskDayKey: de plandatum wint, anders de deadline', () => {
  assert.equal(taskDayKey(task({ id: 'a', planned_date: '2026-08-19', end_date: '2026-08-25' })), '2026-08-19');
  assert.equal(taskDayKey(task({ id: 'b', end_date: '2026-08-25' })), '2026-08-25');
  assert.equal(taskDayKey(task({ id: 'c' })), null);
});

test('taskLastDayKey: bij een weekstrook telt de einddag', () => {
  assert.equal(taskLastDayKey(task({ id: 'a', planned_date: '2026-08-17', planned_end_date: '2026-08-19' })), '2026-08-19');
  // Een einddatum die niet ná de start ligt is geen strook.
  assert.equal(taskLastDayKey(task({ id: 'b', planned_date: '2026-08-17', planned_end_date: '2026-08-17' })), '2026-08-17');
  assert.equal(taskLastDayKey(task({ id: 'c', end_date: '2026-08-30' })), '2026-08-30');
});

test('coversDay: een strook loopt over al zijn dagen, een deadline nergens', () => {
  const strook = task({ id: 'a', planned_date: '2026-08-17', planned_end_date: '2026-08-19' });
  assert.equal(coversDay(strook, '2026-08-16'), false);
  assert.equal(coversDay(strook, '2026-08-17'), true);
  assert.equal(coversDay(strook, '2026-08-18'), true);
  assert.equal(coversDay(strook, '2026-08-19'), true);
  assert.equal(coversDay(strook, '2026-08-20'), false);
  // Alleen een deadline is geen planning: die dekt geen enkele dag.
  assert.equal(coversDay(task({ id: 'b', end_date: '2026-08-18' }), '2026-08-18'), false);
});

test('isOverdue kijkt naar de laatste dag, niet naar de startdag', () => {
  const today = '2026-08-19';
  assert.equal(isOverdue(task({ id: 'a', planned_date: '2026-08-17', planned_end_date: '2026-08-20' }), today), false);
  assert.equal(isOverdue(task({ id: 'b', planned_date: '2026-08-17', planned_end_date: '2026-08-18' }), today), true);
  assert.equal(isOverdue(task({ id: 'c', planned_date: today }), today), false);
  assert.equal(isOverdue(task({ id: 'd' }), today), false);
});

test('inWeek: een strook die de week binnenloopt telt mee', () => {
  const first = '2026-08-17';
  const last = '2026-08-23';
  // Begint vóór de week en loopt erin door.
  assert.equal(inWeek(task({ id: 'a', planned_date: '2026-08-14', planned_end_date: '2026-08-18' }), first, last), true);
  // Begint ín de week en loopt erna door.
  assert.equal(inWeek(task({ id: 'b', planned_date: '2026-08-22', planned_end_date: '2026-08-28' }), first, last), true);
  // Volledig ervoor.
  assert.equal(inWeek(task({ id: 'c', planned_date: '2026-08-10', planned_end_date: '2026-08-12' }), first, last), false);
  // Zonder planning telt de deadline.
  assert.equal(inWeek(task({ id: 'd', end_date: '2026-08-20' }), first, last), true);
  assert.equal(inWeek(task({ id: 'e', end_date: '2026-09-01' }), first, last), false);
});

test('scopeTasks: van mij, plus wat nog aan niemand hangt', () => {
  const tasks = [task({ id: 'mijn' }), task({ id: 'vanSanne' }), task({ id: 'losse' })];
  const assignees = groupAssigneesByTask([
    { task_id: 'mijn', user_id: 'ik' },
    { task_id: 'vanSanne', user_id: 'sanne' },
  ]);

  const mine = scopeTasks(tasks, 'mine', 'ik', assignees).map(t => t.id);
  // De losse taak blijft staan: anders verdwijnt hij meteen na het aanmaken.
  assert.deepEqual(mine, ['mijn', 'losse']);

  assert.equal(scopeTasks(tasks, 'team', 'ik', assignees).length, 3);
  // Zonder ingelogde gebruiker valt er niets te filteren.
  assert.equal(scopeTasks(tasks, 'mine', null, assignees).length, 3);
});

test('scopeTasks houdt een taak die óók aan mij hangt', () => {
  const tasks = [task({ id: 'samen' })];
  const assignees = groupAssigneesByTask([
    { task_id: 'samen', user_id: 'sanne' },
    { task_id: 'samen', user_id: 'ik' },
  ]);
  assert.equal(scopeTasks(tasks, 'mine', 'ik', assignees).length, 1);
});
