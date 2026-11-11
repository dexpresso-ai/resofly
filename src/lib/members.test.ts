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
import type { OrganizationMember } from '../types.ts';
import { holderName, matchesHolder, membersWhoCanHold } from './members.ts';

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
