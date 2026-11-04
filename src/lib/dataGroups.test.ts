import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyFetch, clearFailed, DATA_GROUPS, EDIT_DATA_GROUPS, emptyGroupData, EMPTY_GROUP_STATE, GROUP_FIELDS, GROUP_FILES,
  groupsFor, groupsToFetch, markStale, missingGroups, PAGE_DATA_GROUPS, type DataGroup, type GroupState,
} from './dataGroups.ts';
import { PAGE_TITLES } from './workspaceTabs.ts';

/**
 * Laden per module (dataGroups.ts). Twee soorten tests: de struikeldraad die
 * bijhoudt welke bestanden velden uit een groep lezen, en de toestand per
 * groep (geladen, verouderd, mislukt).
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const allFields = DATA_GROUPS.flatMap(group => [...GROUP_FIELDS[group]]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Per bestand: welke groepsvelden het als property leest (`data.journalLines`, `prev.timeEntries`). */
function readsByFile(): Map<string, Set<string>> {
  const pattern = new RegExp(`\\.(${allFields.join('|')})\\b`, 'g');
  const out = new Map<string, Set<string>>();
  for (const path of sourceFiles(join(root, 'src'))) {
    const file = relative(root, path).split('\\').join('/');
    // De vorm van AppData en de indeling zelf, geen lezers.
    if (file === 'src/types.ts' || file === 'src/lib/dataGroups.ts') continue;
    const fields = new Set([...readFileSync(path, 'utf8').matchAll(pattern)].map(match => match[1]));
    if (fields.size) out.set(file, fields);
  }
  return out;
}

const groupOf = (field: string): DataGroup => DATA_GROUPS.find(group => (GROUP_FIELDS[group] as readonly string[]).includes(field))!;

// ── De indeling ─────────────────────────────────────────────────────────────

test('elk groepsveld bestaat in AppData en hoort bij precies één groep', () => {
  const types = readFileSync(join(root, 'src/types.ts'), 'utf8');
  const appData = /export interface AppData \{([\s\S]*?)\n?\}/.exec(types)?.[1] ?? '';
  const keys = new Set([...appData.matchAll(/(\w+)\s*:/g)].map(match => match[1]));
  assert.ok(keys.size > 40, 'AppData niet gevonden in src/types.ts');
  for (const field of allFields) assert.ok(keys.has(field), `${field} staat niet in AppData`);
  assert.equal(new Set(allFields).size, allFields.length, 'een veld staat in twee groepen');
});

test('PAGE_DATA_GROUPS noemt alleen bestaande pagina\'s en EDIT_DATA_GROUPS alleen bewerkvensters', () => {
  for (const page of Object.keys(PAGE_DATA_GROUPS)) assert.ok(page in PAGE_TITLES, `onbekende pagina ${page}`);
  const editKinds = ['client', 'project', 'task', 'ticket', 'note', 'document', 'quote', 'invoice'];
  for (const kind of Object.keys(EDIT_DATA_GROUPS)) assert.ok(editKinds.includes(kind), `onbekend bewerkvenster ${kind}`);
});

test('het dashboard en de lijstpagina\'s hebben genoeg aan de kern', () => {
  // De pagina's waar je het vaakst opent: die mogen niet op de zware groepen wachten.
  for (const page of ['dashboard', 'clients', 'projects', 'tickets', 'content', 'gerrie', 'settings']) {
    assert.deepEqual(groupsFor(page), [], page);
  }
});

// ── De struikeldraad ────────────────────────────────────────────────────────

test('alleen de bestanden in GROUP_FILES lezen velden uit een groep', () => {
  const problems: string[] = [];
  for (const [file, fields] of readsByFile()) {
    for (const field of fields) {
      const group = groupOf(field);
      if (!GROUP_FILES[group].includes(file)) {
        problems.push(`${file} leest ${field} (groep ${group}). Zet het bestand in GROUP_FILES.${group} en de pagina die het toont in PAGE_DATA_GROUPS (src/lib/dataGroups.ts).`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('elk bestand in GROUP_FILES leest ook echt iets uit die groep', () => {
  const reads = readsByFile();
  for (const group of DATA_GROUPS) {
    for (const file of GROUP_FILES[group]) {
      const fields = reads.get(file) ?? new Set<string>();
      assert.ok([...fields].some(field => groupOf(field) === group), `${file} staat bij ${group} maar leest daar niets uit`);
    }
  }
});

test('het dashboard leest de tellingen uit de kern, niet de bank of de boekhouding', () => {
  const dashboard = readFileSync(join(root, 'src/features/Dashboard.tsx'), 'utf8');
  assert.match(dashboard, /data\.bankTransactionsToReconcile/);
  assert.match(dashboard, /data\.vatReturnsToFile/);
});

// ── Wat er op het scherm staat ──────────────────────────────────────────────

test('groupsFor: de pagina plus een open bewerkvenster, zonder dubbelen, in vaste volgorde', () => {
  assert.deepEqual(groupsFor('vat-returns'), ['bookkeeping', 'bank']);
  assert.deepEqual(groupsFor('bank'), ['bookkeeping', 'bank']);
  assert.deepEqual(groupsFor('client', 'ticket'), ['time', 'communication']);
  assert.deepEqual(groupsFor('dashboard', 'ticket'), ['communication']);
  assert.deepEqual(groupsFor('dashboard', 'invoice'), []);
  assert.deepEqual(groupsFor('', null), []);
});

test('emptyGroupData: precies de groepsvelden, allemaal lege lijsten', () => {
  const empty = emptyGroupData() as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(empty).sort(), [...allFields].sort());
  for (const value of Object.values(empty)) assert.deepEqual(value, []);
});

// ── Geladen, verouderd, mislukt ─────────────────────────────────────────────

const state = (loaded: DataGroup[], stale: DataGroup[] = [], failed: Array<[DataGroup, string]> = []): GroupState => ({
  loaded: new Set(loaded), stale: new Set(stale), failed: new Map(failed),
});

test('missingGroups: wat nog niet geladen is; verouderd telt als geladen', () => {
  assert.deepEqual(missingGroups(EMPTY_GROUP_STATE, ['time', 'bank']), ['time', 'bank']);
  assert.deepEqual(missingGroups(state(['time'], ['time']), ['time', 'bank']), ['bank']);
});

test('groupsToFetch: ontbrekend of verouderd, maar niet wat mislukte', () => {
  const current = state(['time', 'bank'], ['bank'], [['bookkeeping', 'netwerk']]);
  assert.deepEqual(groupsToFetch(current, ['time', 'bank', 'bookkeeping', 'communication']), ['bank', 'communication']);
});

test('markStale: alles wat geladen is wordt verouderd, behalve wat nu opnieuw binnenkomt', () => {
  const next = markStale(state(['time', 'bank', 'bookkeeping'], [], [['communication', 'x']]), ['bank']);
  assert.deepEqual([...next.stale].sort(), ['bookkeeping', 'time']);
  assert.deepEqual([...next.loaded].sort(), ['bank', 'bookkeeping', 'time']);
  // Een oude melding vervalt: de volgende pagina mag het opnieuw proberen.
  assert.equal(next.failed.size, 0);
});

test('applyFetch: binnen is geladen en niet meer verouderd, tenzij er intussen een ververs begon', () => {
  const before = state(['time'], ['time'], [['bank', 'oud']]);
  const fresh = applyFetch(before, { loaded: ['time', 'bank'], failed: [], outdated: false });
  assert.deepEqual([...fresh.loaded].sort(), ['bank', 'time']);
  assert.equal(fresh.stale.size, 0);
  assert.equal(fresh.failed.size, 0);
  const outdated = applyFetch(before, { loaded: ['time'], failed: [], outdated: true });
  assert.ok(outdated.stale.has('time'), 'wat begon vóór de wijziging, blijft verouderd');
});

test('applyFetch: een mislukte groep onthoudt de melding en blijft verder zoals hij was', () => {
  const next = applyFetch(state(['time']), { loaded: [], failed: [['bank', 'netwerkfout']], outdated: false });
  assert.equal(next.failed.get('bank'), 'netwerkfout');
  assert.ok(!next.loaded.has('bank'));
  assert.ok(next.loaded.has('time'));
});

test('applyFetch: mislukt verversen van een groep die al in beeld staat, maakt hem verouderd', () => {
  // Hij blijft getoond (geladen), maar wat er staat is van vóór de wijziging; en
  // omdat hij mislukte, haalt de app hem niet vanzelf steeds opnieuw op.
  const next = applyFetch(state(['bank']), { loaded: [], failed: [['bank', 'netwerkfout']], outdated: false });
  assert.ok(next.loaded.has('bank'));
  assert.ok(next.stale.has('bank'));
  assert.deepEqual(groupsToFetch(next, ['bank']), []);
});

test('applyFetch zonder resultaat (alles vervallen) geeft dezelfde toestand terug', () => {
  const current = state(['time']);
  assert.equal(applyFetch(current, { loaded: [], failed: [], outdated: false }), current);
});

test('clearFailed: opnieuw proberen wist alleen de genoemde meldingen', () => {
  const current = state([], [], [['bank', 'a'], ['time', 'b']]);
  const next = clearFailed(current, ['bank']);
  assert.ok(!next.failed.has('bank'));
  assert.equal(next.failed.get('time'), 'b');
  assert.equal(clearFailed(next, ['communication']), next);
});
