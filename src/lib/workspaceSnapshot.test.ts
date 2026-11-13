import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AppData, OrganizationContext } from '../types.ts';
import { DATA_GROUPS, emptyGroupData, GROUP_FIELDS } from './dataGroups.ts';
import {
  coreOf, groupOf, recordUsable, restoreWorkspace, SNAPSHOT_MAX_AGE_MS,
  type CoreRecord, type GroupRecord, type SnapshotKey,
} from './workspaceSnapshot.ts';

/**
 * De vorige stand van de werkruimte (workspaceSnapshot.ts). Wat hier bewaakt
 * wordt: een bewaarde stand komt alleen in beeld bij dezelfde gebruiker,
 * dezelfde organisatie en dezelfde versie van de app, en een groep is heel of
 * hij is er niet.
 */

const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);
const KEY: SnapshotKey = { userId: 'user-a', organizationId: 'org-1', build: 'build-7', now: NOW };

const BASE = {
  ...emptyGroupData(),
  clients: [], projects: [], tasks: [], invoices: [], companySettings: null,
  bankTransactionsToReconcile: 0, vatReturnsToFile: 0,
} as unknown as AppData;

function context(organizationId: string): OrganizationContext {
  const organization = { id: organizationId, name: 'Bureau' };
  return {
    memberships: [], organizations: [organization], activeOrganization: organization,
    activeMembership: { organization_id: organizationId, user_id: 'user-a', role: 'owner', organization },
    teamMembers: [], pendingInvitations: [], organizationInvitations: [], licenseUsage: null, auditLogs: [],
    billingOverview: null, creativeStatus: null, businessStatus: null, aiConsent: null, aiConsents: [],
  } as unknown as OrganizationContext;
}

function coreRecord(overrides: Partial<CoreRecord> = {}): CoreRecord {
  return {
    kind: 'kern', build: 'build-7', userId: 'user-a', organizationId: 'org-1', access: 'owner|alles', savedAt: NOW - 60_000,
    context: context('org-1'),
    core: { clients: [{ id: 'c1' }], projects: [{ id: 'p1' }], bankTransactionsToReconcile: 3 } as unknown as Partial<AppData>,
    ...overrides,
  };
}

function timeRecord(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    kind: 'groep', group: 'time', build: 'build-7', userId: 'user-a', organizationId: 'org-1', access: 'owner|alles', savedAt: NOW - 60_000,
    data: { timeEntries: [{ id: 't1', minutes: 30 }] } as unknown as Partial<AppData>,
    ...overrides,
  };
}

test('een stand mag alleen in beeld voor dezelfde gebruiker, organisatie en versie', () => {
  const record = coreRecord();
  assert.equal(recordUsable(record, KEY), true);
  assert.equal(recordUsable(record, { ...KEY, userId: 'user-b' }), false, 'een andere gebruiker');
  assert.equal(recordUsable(record, { ...KEY, organizationId: 'org-2' }), false, 'een andere organisatie');
  assert.equal(recordUsable(record, { ...KEY, build: 'build-8' }), false, 'een nieuwere versie van de app');
  assert.equal(recordUsable(null, KEY), false);
});

test('een stand van meer dan twee weken, of uit de toekomst, telt niet', () => {
  assert.equal(recordUsable(coreRecord({ savedAt: NOW - SNAPSHOT_MAX_AGE_MS }), KEY), true);
  assert.equal(recordUsable(coreRecord({ savedAt: NOW - SNAPSHOT_MAX_AGE_MS - 1 }), KEY), false);
  assert.equal(recordUsable(coreRecord({ savedAt: NOW + 60_000 }), KEY), false);
});

test('de werkruimte komt terug met de kern en de groepen die passen', () => {
  const restored = restoreWorkspace(coreRecord(), [timeRecord()], KEY, BASE);
  assert.ok(restored);
  assert.deepEqual(restored.groups, ['time']);
  assert.deepEqual(restored.data.clients, [{ id: 'c1' }]);
  assert.deepEqual(restored.data.timeEntries, [{ id: 't1', minutes: 30 }]);
  assert.equal(restored.data.bankTransactionsToReconcile, 3);
  // Wat de kern niet had, komt uit de basis: nooit undefined waar een lijst hoort.
  assert.deepEqual(restored.data.tasks, []);
  assert.deepEqual(restored.data.journalLines, []);
  assert.equal(restored.context.activeOrganization?.id, 'org-1');
});

test('zonder bruikbare kern geen werkruimte, ook niet met groepen', () => {
  assert.equal(restoreWorkspace(null, [timeRecord()], KEY, BASE), null);
  assert.equal(restoreWorkspace(coreRecord({ build: 'build-6' }), [timeRecord()], KEY, BASE), null);
  assert.equal(restoreWorkspace(coreRecord({ userId: 'user-b' }), [timeRecord()], KEY, BASE), null);
});

test('een kern waarvan de context een andere organisatie opent, telt niet', () => {
  // De sleutel klopt, maar de inhoud hoort bij een andere organisatie: nooit tonen.
  assert.equal(restoreWorkspace(coreRecord({ context: context('org-2') }), [], KEY, BASE), null);
});

test('een groep van een andere organisatie, gebruiker of versie blijft weg', () => {
  for (const record of [
    timeRecord({ organizationId: 'org-2' }),
    timeRecord({ userId: 'user-b' }),
    timeRecord({ build: 'build-6' }),
    timeRecord({ savedAt: NOW - SNAPSHOT_MAX_AGE_MS - 1 }),
  ]) {
    const restored = restoreWorkspace(coreRecord(), [record], KEY, BASE);
    assert.ok(restored);
    assert.deepEqual(restored.groups, []);
    assert.deepEqual(restored.data.timeEntries, []);
  }
});

test('een groep die met andere rechten is opgehaald dan de kern, blijft weg', () => {
  // Financiën dichtgezet sinds de groep werd bewaard: de nieuwe kern heeft
  // andere rechten, en de oude groep mag dan niet terugkomen.
  for (const access of ['member|finance-dicht', undefined]) {
    const restored = restoreWorkspace(coreRecord({ access: 'member|finance-dicht' }), [timeRecord({ access: access === undefined ? undefined : 'owner|alles' } as Partial<GroupRecord>)], KEY, BASE);
    assert.ok(restored);
    assert.deepEqual(restored.groups, [], `groep met ${access ?? 'geen'} rechten`);
  }
  const same = restoreWorkspace(coreRecord({ access: 'member|finance-dicht' }), [timeRecord({ access: 'member|finance-dicht' })], KEY, BASE);
  assert.deepEqual(same?.groups, ['time']);
});

test('een halve groep blijft weg: een pagina zou anders een lege lijst tonen', () => {
  const half: GroupRecord = {
    kind: 'groep', group: 'communication', build: 'build-7', userId: 'user-a', organizationId: 'org-1', access: 'owner|alles', savedAt: NOW,
    data: { ticketNotes: [{ id: 'n1' }] } as unknown as Partial<AppData>,
  };
  const restored = restoreWorkspace(coreRecord(), [half], KEY, BASE);
  assert.ok(restored);
  assert.deepEqual(restored.groups, []);
  assert.deepEqual(restored.data.ticketNotes, []);
});

test('groepsvelden in de kern worden genegeerd: die komen alleen uit hun eigen record', () => {
  const core = coreRecord({ core: { clients: [], timeEntries: [{ id: 'oud' }] } as unknown as Partial<AppData> });
  const restored = restoreWorkspace(core, [], KEY, BASE);
  assert.ok(restored);
  assert.deepEqual(restored.data.timeEntries, []);
  assert.deepEqual(restored.groups, []);
});

test('kern en groepen samen zijn precies de hele werkruimte', () => {
  const data = { ...BASE, clients: [{ id: 'c1' }], timeEntries: [{ id: 't1' }] } as unknown as AppData;
  const core = coreOf(data);
  for (const group of DATA_GROUPS) for (const field of GROUP_FIELDS[group]) assert.ok(!(field in core), `${field} hoort niet in de kern`);
  const rebuilt = { ...core, ...Object.assign({}, ...DATA_GROUPS.map(group => groupOf(data, group))) };
  assert.deepEqual(Object.keys(rebuilt).sort(), Object.keys(data).sort());
  assert.deepEqual(groupOf(data, 'time'), { timeEntries: [{ id: 't1' }] });
});

test('uitloggen wist de bewaarde stand vóór de sessie weg is', () => {
  const signOut = readFileSync(new URL('./signOut.ts', import.meta.url), 'utf8');
  const clear = signOut.indexOf('await Promise.race([clearSnapshots(), ');
  const end = signOut.indexOf('await supabaseAuth.signOut()');
  assert.ok(clear > 0 && clear < end, 'clearSnapshots moet vóór supabaseAuth.signOut staan, met een grens');
});

test('de app toont de bewaarde stand alleen na de sessie, en wist hem als de sessie eindigt', () => {
  const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
  const apply = main.slice(main.indexOf('async function applySession'), main.indexOf('supabaseAuth.getSession().then'));
  assert.match(apply, /readSnapshot\(userId, storedOrganizationId, emptyData\)/);
  assert.match(apply, /void clearSnapshots\(userId\);/);
  // Alleen bij de start van een sessie: niet midden in je werk na een tokenverversing.
  assert.match(apply, /if \(snapshot && !workspaceStartedRef\.current\) showSnapshot\(snapshot\);/);
  // De tak zonder gebruiker (uitgelogd, verlopen) wist alles.
  assert.match(apply.slice(apply.indexOf('} else if (!userId) {')), /void clearSnapshots\(\);/);
  // Bewaren gebeurt alleen met een kern die deze sessie zelf ophaalde.
  assert.match(main, /if \(freshOrgRef\.current !== organizationId \|\| dataOrgRef\.current !== organizationId\) return;/);
});
