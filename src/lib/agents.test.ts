/**
 * Tests voor de agents zoals de app ze toont: het ritme, van wie hij is, waar
 * hij op het scherm staat en wat er op jouw akkoord wacht.
 * Draaien met:  npm test
 *
 * De runner beslist (supabase/functions/_shared/agentAccess.ts en
 * agentSchedule.ts); deze tests leggen het scherm daarnaast. Belooft een knop
 * iets wat de server weigert, of noemt een tegel een ander tijdstip dan waarop
 * hij draait, dan faalt het hier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  agentOwner, agentPowers, approvalScope, hourlyEnd, monthStatsLine, scheduleLabel, shortSchedule, sortAgents, summarizeAgentMonth,
} from './agents.ts';
import { agentCapabilities, canCloneAgent, canManageAgent } from '../../supabase/functions/_shared/agentAccess.ts';
import { normalizeSchedule, SCHEDULE_KINDS } from '../../supabase/functions/_shared/agentSchedule.ts';

const ME = '11111111-1111-4111-8111-111111111111';
const COLLEAGUE = '22222222-2222-4222-8222-222222222222';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('het ritme in gewone taal, voor elk ritme dat de runner kent', () => {
  const base = { hour: 8, minute: 30, end_hour: null, day_of_week: null, day_of_month: null };
  assert.equal(scheduleLabel({ ...base, schedule_kind: 'daily' }), 'Elke dag om 08:30');
  assert.equal(scheduleLabel({ ...base, schedule_kind: 'weekdays' }), 'Elke werkdag om 08:30');
  assert.equal(scheduleLabel({ ...base, schedule_kind: 'weekly', day_of_week: 5 }), 'Elke vrijdag om 08:30');
  assert.equal(scheduleLabel({ ...base, schedule_kind: 'monthly', day_of_month: 15 }), 'Maandelijks op dag 15 om 08:30');
  assert.equal(scheduleLabel({ ...base, schedule_kind: 'monthly', day_of_month: 31 }), 'Maandelijks op dag 31 (of de laatste dag van de maand) om 08:30');
  assert.equal(scheduleLabel({ ...base, schedule_kind: 'hourly', hour: 9, minute: 0, end_hour: 17 }), 'Elk uur op werkdagen, van 09:00 tot en met 17:00');
  assert.equal(scheduleLabel({ ...base, schedule_kind: 'hourly', hour: 9, minute: 0, end_hour: 9 }), 'Elke werkdag om 09:00');

  assert.equal(shortSchedule({ ...base, schedule_kind: 'weekdays' }), 'Ma–vr · 08:30');
  assert.equal(shortSchedule({ ...base, schedule_kind: 'weekly', day_of_week: 1 }), 'Ma · 08:30');
  assert.equal(shortSchedule({ ...base, schedule_kind: 'weekly', day_of_week: 7 }), 'Zo · 08:30');
  assert.equal(shortSchedule({ ...base, schedule_kind: 'hourly', hour: 9, minute: 15, end_hour: 17 }), 'Elk uur · 09:15–17:15');
  // Een oude agent zonder minuut-kolom: gewoon het hele uur.
  assert.equal(shortSchedule({ schedule_kind: 'daily', hour: 7, day_of_week: null, day_of_month: null }), 'Elke dag · 07:00');
});

test('het venster van "elk uur" eindigt waar de runner het laat eindigen', () => {
  for (const hour of [0, 8, 12, 17, 23]) {
    for (const end of [null, 0, 7, 8, 17, 23]) {
      const server = normalizeSchedule({ schedule_kind: 'hourly', hour, end_hour: end }).endHour;
      assert.equal(hourlyEnd({ hour, end_hour: end }), server, `hour ${hour}, end ${end}`);
    }
  }
});

test('de app kent precies de ritmes van de runner, en de editor biedt ze allemaal aan', () => {
  const api = read('./gerrie-api.ts');
  const type = api.match(/export type RoutineScheduleKind = ([^;]+);/);
  assert.ok(type, 'RoutineScheduleKind staat in gerrie-api.ts');
  assert.deepEqual([...type[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...SCHEDULE_KINDS]);
  const editor = read('../features/GerrieCommandCenter.tsx');
  for (const kind of SCHEDULE_KINDS) {
    assert.match(editor, new RegExp(`<option value="${kind}">`), `de editor mist het ritme '${kind}'`);
  }
});

test('de knoppen beloven niets wat de runner weigert — voor elke rol', () => {
  // Alleen rollen die de Gerrie-pagina kunnen openen: wie Gerrie niet mag
  // gebruiken, ziet deze knoppen nooit (en de runner weigert hem bij de deur).
  const roles: Array<[string, Record<string, string>]> = [
    ['owner', {}], ['admin', {}], ['member', {}], ['member', { gerrie: 'read' }], ['viewer', {}],
  ];
  const agents = [
    { run_as_user_id: ME, created_by: ME, visibility: 'private' as const },
    { run_as_user_id: COLLEAGUE, created_by: COLLEAGUE, visibility: 'private' as const },
    { run_as_user_id: COLLEAGUE, created_by: COLLEAGUE, visibility: 'team' as const },
    { run_as_user_id: null, created_by: null, visibility: 'private' as const },
  ];
  for (const [role, access] of roles) {
    const caps = agentCapabilities(role, access);
    for (const agent of agents) {
      const powers = agentPowers(agent, ME, caps.canOversee);
      const label = `${role} ${JSON.stringify(access)} op ${agent.run_as_user_id ?? 'wees'}/${agent.visibility}`;
      for (const action of ['edit', 'run', 'activate', 'share', 'reply'] as const) {
        assert.equal(powers.manage, canManageAgent(agent, ME, caps, action), `${label}: ${action}`);
      }
      for (const action of ['pause', 'archive', 'restore'] as const) {
        assert.equal(powers.oversee, canManageAgent(agent, ME, caps, action), `${label}: ${action}`);
      }
      assert.equal(powers.copy, canCloneAgent(agent, ME, caps), `${label}: kopiëren`);
    }
  }
});

test('de agents op het scherm: eigen, gedeeld, van het team en het archief', () => {
  const own = { id: 'a', run_as_user_id: ME, created_by: ME, status: 'active' as const, visibility: 'private' as const };
  const ownShared = { id: 'b', run_as_user_id: ME, created_by: ME, status: 'paused' as const, visibility: 'team' as const };
  const theirsShared = { id: 'c', run_as_user_id: COLLEAGUE, created_by: COLLEAGUE, status: 'active' as const, visibility: 'team' as const };
  const theirsPrivate = { id: 'd', run_as_user_id: COLLEAGUE, created_by: COLLEAGUE, status: 'active' as const, visibility: 'private' as const };
  const ownArchived = { id: 'e', run_as_user_id: ME, created_by: ME, status: 'archived' as const, visibility: 'private' as const };
  const all = [own, ownShared, theirsShared, theirsPrivate, ownArchived];

  const member = sortAgents(all, ME, false);
  assert.deepEqual(member.mine.map((a) => a.id), ['a', 'b']);
  assert.deepEqual(member.shared.map((a) => a.id), ['c'], 'een gedeelde agent van een collega is een startpunt');
  assert.deepEqual(member.team.map((a) => a.id), [], 'zonder toezicht geen agents van collega\'s');
  assert.deepEqual(member.archived.map((a) => a.id), ['e']);

  const admin = sortAgents(all, ME, true);
  assert.deepEqual(admin.mine.map((a) => a.id), ['a', 'b']);
  assert.deepEqual(admin.team.map((a) => a.id), ['c', 'd'], 'toezicht: alle agents van collega\'s, gedeeld of niet');
  assert.deepEqual(admin.shared.map((a) => a.id), []);

  // Een agent van een vertrokken medewerker hoort bij niemand.
  assert.equal(agentOwner({ run_as_user_id: null, created_by: null }), null);
  assert.equal(agentOwner({ run_as_user_id: null, created_by: ME }), ME);
});

test('wat er op jouw akkoord wacht', () => {
  const mineAgent = { source: 'agent' as const, userId: ME };
  const theirAgent = { source: 'agent' as const, userId: COLLEAGUE };
  const mcp = { source: 'mcp' as const, userId: ME };
  const api = { source: 'api' as const, userId: null };

  assert.equal(approvalScope(mineAgent, ME, false), 'mine');
  assert.equal(approvalScope(theirAgent, ME, false), 'hidden');
  // Een gekoppelde AI of API-sleutel: daarover beslist alleen een owner/admin.
  assert.equal(approvalScope(mcp, ME, false), 'hidden');
  assert.equal(approvalScope(api, ME, false), 'hidden');

  assert.equal(approvalScope(mineAgent, ME, true), 'mine');
  assert.equal(approvalScope(theirAgent, ME, true), 'team', 'wacht op de collega; de admin kan meekijken');
  assert.equal(approvalScope(mcp, ME, true), 'mine');
  assert.equal(approvalScope(api, ME, true), 'mine');
});

test('de maand van een agent in een paar getallen', () => {
  const stats = summarizeAgentMonth(
    [
      { status: 'succeeded', cost_usd: 0.012, proposals_created: 2, result: { quiet: false } },
      { status: 'succeeded', cost_usd: '0.004', proposals_created: 0, result: { quiet: true } },
      { status: 'partial', cost_usd: 0.01, proposals_created: 1 },
      { status: 'failed', cost_usd: 0, proposals_created: 0 },
      { status: 'skipped_budget', cost_usd: 0, proposals_created: 0 },
    ],
    [
      { status: 'executed', decision: 'executed' },
      { status: 'failed', decision: 'rejected' },
      { status: 'failed', decision: 'failed' },
      { status: 'proposed' },
    ],
  );
  assert.deepEqual(stats, { runs: 4, quiet: 1, failed: 1, costUsd: 0.026, proposals: 3, approved: 1, rejected: 1, failedDecisions: 1, open: 1 });
  assert.equal(monthStatsLine(stats), '4 runs · 1 zonder nieuws · 1 mislukt · 3 voorstellen (1 goedgekeurd, 1 afgewezen, 1 open) · ± $ 0,03');
  assert.equal(monthStatsLine(summarizeAgentMonth([], [])), 'Nog niet gedraaid.');
});
