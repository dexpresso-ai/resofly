/**
 * Wie een klant (accountlead) of een ticket kan krijgen, en het filter erop.
 * Draaien met:  npm test
 *
 * De keuzelijst volgt dezelfde regel als de database (public.member_can_hold).
 * Bood hij iemand aan die de database weigert, dan liep Opslaan stuk op een
 * melding die niemand begreep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OrganizationMember, ProjectMember } from '../types.ts';
import { holderName, matchesHolder, membersWhoCanHold, projectTeamAdditions, taskAssigneeChoices } from './members.ts';

const m = (user_id: string, email: string, role: string, module_access: Record<string, string> = {}, status = 'active') =>
  ({ user_id, email, role, module_access, status }) as unknown as OrganizationMember;

const team = [
  m('u-z', 'zoe@bureau.nl', 'member'),
  m('u-a', 'anna@bureau.nl', 'admin', { tickets: 'none' }),
  m('u-b', 'boekhouder@kantoor.nl', 'accountant'),
  m('u-v', 'viewer@bureau.nl', 'viewer'),
  m('u-n', 'nottickets@bureau.nl', 'member', { tickets: 'none' }),
  m('u-x', 'weg@bureau.nl', 'member', {}, 'disabled'),
];

test('alleen actieve teamleden die de module mogen zien, zonder boekhouder, op naam gesorteerd', () => {
  assert.deepEqual(membersWhoCanHold(team, 'tickets').map(x => x.user_id), ['u-a', 'u-v', 'u-z']);
  assert.deepEqual(membersWhoCanHold(team, 'clients').map(x => x.user_id), ['u-a', 'u-n', 'u-v', 'u-z']);
});

test('het filter: iedereen, ik, niemand of één teamlid', () => {
  assert.equal(matchesHolder('u-z', '', 'u-a'), true);
  assert.equal(matchesHolder(null, '', 'u-a'), true);
  assert.equal(matchesHolder('u-a', 'me', 'u-a'), true);
  assert.equal(matchesHolder('u-z', 'me', 'u-a'), false);
  // Zonder ingelogde gebruiker is "mij" niemand.
  assert.equal(matchesHolder(null, 'me', null), false);
  assert.equal(matchesHolder(null, 'none', 'u-a'), true);
  assert.equal(matchesHolder(undefined, 'none', 'u-a'), true);
  assert.equal(matchesHolder('u-z', 'none', 'u-a'), false);
  assert.equal(matchesHolder('u-z', 'u-z', null), true);
});

test('de naam: leeg wordt de lege tekst, een vertrokken collega "Oud-teamlid"', () => {
  assert.equal(holderName(null, team, 'Niet toegewezen'), 'Niet toegewezen');
  assert.equal(holderName('u-z', team, ''), 'zoe@bureau.nl');
  assert.equal(holderName('u-onbekend', team, ''), 'Oud-teamlid');
});

// ── Taak toewijzen in het taakvenster ──────────────────────────────────────
// Een projecttaak bood alleen het projectteam aan. Was dat leeg, dan kon je
// niemand kiezen, ook jezelf niet.

const pm = (project_id: string, user_id: string) => ({ id: `${project_id}-${user_id}`, project_id, user_id }) as unknown as ProjectMember;

test('projecttaak met een leeg projectteam: je kunt jezelf en ieder ander teamlid kiezen', () => {
  const choices = taskAssigneeChoices({ projectId: 'p1', assigneeIds: [], members: team, projectMembers: [], currentUserId: 'u-z' });
  assert.deepEqual(choices.chips, []);
  // Wie Projecten mag zien; de boekhouder en het uitgeschakelde lid niet.
  assert.deepEqual(choices.others.map(x => x.user_id), ['u-a', 'u-n', 'u-v', 'u-z']);
  assert.equal(choices.canAssignSelf, true);
});

test('projecttaak: het projectteam en wie er al op staat als knoppen, de rest in de keuzelijst', () => {
  const choices = taskAssigneeChoices({
    projectId: 'p1',
    assigneeIds: ['u-n'],
    members: team,
    projectMembers: [pm('p1', 'u-a'), pm('p2', 'u-v')],
    currentUserId: 'u-z',
  });
  assert.deepEqual(choices.chips, ['u-a', 'u-n']);
  assert.deepEqual(choices.others.map(x => x.user_id), ['u-v', 'u-z']);
});

test('"Aan mij toewijzen" alleen als je er nog niet op staat en Projecten mag zien', () => {
  const base = { projectId: 'p1', members: team, projectMembers: [] as ProjectMember[] };
  assert.equal(taskAssigneeChoices({ ...base, assigneeIds: ['u-z'], currentUserId: 'u-z' }).canAssignSelf, false);
  assert.equal(taskAssigneeChoices({ ...base, assigneeIds: [], currentUserId: 'u-b' }).canAssignSelf, false, 'boekhouder');
  assert.equal(taskAssigneeChoices({ ...base, assigneeIds: [], currentUserId: null }).canAssignSelf, false);
});

test('taak zonder project: iedereen die Projecten mag zien als knop', () => {
  const choices = taskAssigneeChoices({ projectId: null, assigneeIds: [], members: team, projectMembers: [pm('p1', 'u-a')], currentUserId: 'u-z' });
  assert.deepEqual(choices.chips, ['u-a', 'u-n', 'u-v', 'u-z']);
  assert.deepEqual(choices.others, []);
});

test('bij opslaan komt wie de taak heeft, maar niet in het projectteam zit, erbij', () => {
  const team1 = [pm('p1', 'u-a'), pm('p2', 'u-z')];
  assert.deepEqual(projectTeamAdditions('p1', ['u-a', 'u-z', 'u-z'], team1), ['u-z']);
  assert.deepEqual(projectTeamAdditions('p1', ['u-a'], team1), []);
  assert.deepEqual(projectTeamAdditions(null, ['u-z'], team1), [], 'zonder project is er geen team');
});
