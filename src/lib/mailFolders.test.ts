import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClientEmailFolder } from '../types';
import {
  MAX_FOLDER_DEPTH, buildFolderRows, canCreateFolderIn, cleanFolderName, deleteFolderSummary, descendantFolderIds,
  folderCounts, folderDepth, folderNameProblem, folderOptions, folderPathLabel, foldersOfClient, moveFolderProblem,
  subtreeHeight,
} from './mailFolders.ts';

const CLIENT = 'c1';
let seq = 0;
function folder(name: string, parent: string | null = null, client = CLIENT): ClientEmailFolder {
  seq += 1;
  return {
    id: `f${seq}`, organization_id: 'org', client_id: client, parent_id: parent, name,
    created_by: null, created_at: '2026-11-11T10:00:00Z', updated_at: '2026-11-11T10:00:00Z',
  };
}

/** Offertes, Project › Feedback › Ronde 2, 10 Nazorg, 2 Oplevering — en één map van een andere klant. */
function tree() {
  seq = 0;
  const offertes = folder('Offertes');
  const project = folder('Project website');
  const feedback = folder('Feedback', project.id);
  const ronde = folder('Ronde 2', feedback.id);
  const nazorg = folder('10 Nazorg');
  const oplevering = folder('2 Oplevering');
  const ander = folder('Offertes', null, 'c2');
  return { offertes, project, feedback, ronde, nazorg, oplevering, ander, all: [offertes, project, feedback, ronde, nazorg, oplevering, ander] };
}

test('een naam wordt opgeschoond zoals de database dat doet', () => {
  assert.equal(cleanFolderName('  Project   website \n'), 'Project website');
  assert.equal(cleanFolderName(null), '');
});

test('alleen de mappen van de gekozen klant', () => {
  const t = tree();
  assert.equal(foldersOfClient(t.all, CLIENT).length, 6);
  assert.deepEqual(foldersOfClient(t.all, 'c2').map(f => f.id), [t.ander.id]);
  assert.deepEqual(foldersOfClient(t.all, null), []);
});

test('pad, diepte en submappen', () => {
  const t = tree();
  assert.equal(folderPathLabel(t.all, t.ronde.id), 'Project website / Feedback / Ronde 2');
  assert.equal(folderDepth(t.all, t.ronde.id), 3);
  assert.equal(folderDepth(t.all, t.offertes.id), 1);
  assert.deepEqual([...descendantFolderIds(t.all, t.project.id)].sort(), [t.feedback.id, t.ronde.id].sort());
  assert.equal(subtreeHeight(t.all, t.project.id), 3);
  assert.equal(subtreeHeight(t.all, t.offertes.id), 1);
  assert.equal(folderPathLabel(t.all, 'bestaat-niet'), '');
});

test('een naam: leeg, te lang, of al bezet op dezelfde plek (zonder op hoofdletters te letten)', () => {
  const t = tree();
  const top = t.all.filter(f => f.client_id === CLIENT && f.parent_id === null);
  assert.equal(folderNameProblem('   ', top), 'Geef de map een naam.');
  assert.equal(folderNameProblem('x'.repeat(81), top), 'Een mapnaam is hooguit 80 tekens.');
  assert.equal(folderNameProblem('offertes', top), 'Er staat al een map "offertes" op deze plek.');
  assert.equal(folderNameProblem('Offertes', top, t.offertes.id), null, 'hernoemen naar de eigen naam mag');
  assert.equal(folderNameProblem('Facturen', top), null);
});

test('niet dieper dan vijf lagen', () => {
  seq = 0;
  const levels: ClientEmailFolder[] = [];
  let parent: string | null = null;
  for (let i = 1; i <= MAX_FOLDER_DEPTH; i += 1) {
    const f = folder(`Laag ${i}`, parent);
    levels.push(f);
    parent = f.id;
  }
  assert.equal(canCreateFolderIn(levels, null), true);
  assert.equal(canCreateFolderIn(levels, levels[3].id), true, 'onder laag 4 komt laag 5');
  assert.equal(canCreateFolderIn(levels, levels[4].id), false, 'onder laag 5 kan niets meer');
});

test('een map verplaatsen: niet in zichzelf, niet in een submap, niet te diep, geen dubbele naam', () => {
  const t = tree();
  assert.equal(moveFolderProblem(t.all, t.project.id, t.project.id), 'Een map kan niet in zichzelf.');
  assert.equal(moveFolderProblem(t.all, t.project.id, t.ronde.id), 'Een map kan niet in een van zijn eigen submappen.');
  assert.equal(moveFolderProblem(t.all, t.feedback.id, t.project.id), 'De map staat hier al.');
  assert.equal(moveFolderProblem(t.all, t.feedback.id, null), null, 'naar boven mag');
  assert.equal(moveFolderProblem(t.all, t.offertes.id, t.ander.id), 'Een map blijft bij dezelfde klant.');
  // Project (3 lagen) onder Ronde 2 (laag 3) van een andere tak: kan niet, maar
  // dat is al een submap. Neem Offertes met drie lagen eronder:
  const deep = [...t.all, folder('A', t.offertes.id)];
  const a = deep[deep.length - 1];
  deep.push(folder('B', a.id));
  assert.equal(moveFolderProblem(deep, t.offertes.id, t.ronde.id), 'Dan wordt het dieper dan 5 lagen.');
  const clash = [...t.all, folder('Feedback')];
  assert.equal(moveFolderProblem(clash, t.feedback.id, null), 'Daar staat al een map "Feedback".');
});

test('tellers tellen alles eronder mee, ook ongelezen', () => {
  const t = tree();
  const mine = foldersOfClient(t.all, CLIENT);
  const { byFolder, unfiled } = folderCounts(mine, [
    { folderId: t.ronde.id, unread: 2 },
    { folderId: t.feedback.id, unread: 0 },
    { folderId: t.offertes.id, unread: 1 },
    { folderId: null, unread: 0 },
    { folderId: 'verwijderde-map', unread: 3 },
  ]);
  assert.deepEqual(byFolder.get(t.project.id), { total: 2, unread: 2 });
  assert.deepEqual(byFolder.get(t.feedback.id), { total: 2, unread: 2 });
  assert.deepEqual(byFolder.get(t.ronde.id), { total: 1, unread: 2 });
  assert.deepEqual(byFolder.get(t.offertes.id), { total: 1, unread: 1 });
  assert.deepEqual(byFolder.get(t.nazorg.id), { total: 0, unread: 0 });
  assert.deepEqual(unfiled, { total: 2, unread: 3 }, 'een onbekende map telt als Zonder map');
});

test('de boom: mappen op naam met getallen als getallen, dan de gesprekken, zonder map onderaan', () => {
  const t = tree();
  const mine = foldersOfClient(t.all, CLIENT);
  const items = [
    { id: 'g1', folderId: null, unread: 0 },
    { id: 'g2', folderId: t.feedback.id, unread: 1 },
    { id: 'g3', folderId: t.project.id, unread: 0 },
  ];
  const closed = buildFolderRows(mine, items, { expanded: new Set(), filtering: false });
  assert.deepEqual(closed.map(r => (r.kind === 'folder' ? r.folder.name : r.item.id)), [
    '2 Oplevering', '10 Nazorg', 'Offertes', 'Project website', 'g1',
  ]);
  const project = closed.find(r => r.kind === 'folder' && r.folder.id === t.project.id);
  assert.ok(project && project.kind === 'folder');
  assert.deepEqual(project.count, { total: 2, unread: 1 });
  assert.equal(project.hasChildren, true);

  const open = buildFolderRows(mine, items, { expanded: new Set([t.project.id, t.feedback.id]), filtering: false });
  assert.deepEqual(open.map(r => `${r.depth}:${r.kind === 'folder' ? r.folder.name : r.item.id}`), [
    '0:2 Oplevering', '0:10 Nazorg', '0:Offertes', '0:Project website', '1:Feedback', '2:Ronde 2', '2:g2', '1:g3', '0:g1',
  ]);
});

test('tijdens zoeken: lege mappen weg, mappen met treffers open', () => {
  const t = tree();
  const mine = foldersOfClient(t.all, CLIENT);
  const rows = buildFolderRows(mine, [{ id: 'g2', folderId: t.ronde.id, unread: 0 }], { expanded: new Set(), filtering: true });
  assert.deepEqual(rows.map(r => (r.kind === 'folder' ? r.folder.name : r.item.id)), ['Project website', 'Feedback', 'Ronde 2', 'g2']);
  assert.ok(rows.every(r => r.kind !== 'folder' || r.expanded));
});

test('keuzelijst voor verplaatsen: de hele boom, met wat niet kan uitgegrijsd', () => {
  const t = tree();
  const mine = foldersOfClient(t.all, CLIENT);
  const blocked = descendantFolderIds(mine, t.project.id);
  const options = folderOptions(mine, f => (f.id === t.project.id || blocked.has(f.id) ? 'Dit is de map zelf of een submap ervan.' : null));
  assert.deepEqual(options.map(o => `${o.depth}:${o.name}:${o.disabledReason ? 'x' : 'ok'}`), [
    '0:2 Oplevering:ok', '0:10 Nazorg:ok', '0:Offertes:ok', '0:Project website:x', '1:Feedback:x', '2:Ronde 2:x',
  ]);
});

test('het bevestigingsvenster zegt waar de inhoud heen gaat', () => {
  const t = tree();
  const mine = foldersOfClient(t.all, CLIENT);
  assert.equal(deleteFolderSummary(mine, t.nazorg.id, 0), 'De map is leeg. Er verdwijnt alleen de map zelf.');
  assert.equal(deleteFolderSummary(mine, t.offertes.id, 1), '1 gesprek gaat naar "Zonder map". Er gaat geen mail verloren.');
  assert.equal(deleteFolderSummary(mine, t.feedback.id, 3), '3 gesprekken en 1 submap gaan naar de map "Project website". Er gaat geen mail verloren.');
});
