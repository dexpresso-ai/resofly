/**
 * Tests voor de boom van het dossier naast een pagina. Draaien met:  npm test
 *
 * Bovenaan het gevaarlijke geval: een pagina die nergens in de boom terechtkomt,
 * is in het scherm onvindbaar. Dat mag niet, ook niet als haar ouder ontbreekt of
 * de lijst een kring bevat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ancestorIds, buildPageTree, comparePages, dossierClientOf, folderPath, type TreeFolder, type TreeNode, type TreePage } from './pageTree.ts';

const page = (id: string, over: Partial<TreePage> = {}): TreePage => ({
  id, title: id, parent_id: null, folder_id: null, client_id: 'X', project_id: null, position: 0, ...over,
});
const noPlaces = { folders: new Map<string, TreeFolder>(), projects: new Map<string, string>() };

/** De boom als tekst: "a(a1(a11),a2)". */
function shape(nodes: TreeNode[]): string {
  return nodes.map(node => (node.children.length ? `${node.page.id}(${shape(node.children)})` : node.page.id)).join(',');
}

function allIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap(node => [node.page.id, ...allIds(node.children)]);
}

test('elke pagina staat in de boom, ook zonder zichtbare ouder of in een kring', () => {
  const pages = [
    page('a'), page('a1', { parent_id: 'a' }), page('a11', { parent_id: 'a1' }),
    page('wees', { parent_id: 'niet-te-zien' }),
    page('k1', { parent_id: 'k2' }), page('k2', { parent_id: 'k1' }),
    page('zelf', { parent_id: 'zelf' }),
  ];
  const groups = buildPageTree(pages, noPlaces);
  const ids = groups.flatMap(group => allIds(group.roots));
  assert.deepEqual([...ids].sort(), pages.map(p => p.id).sort());
  assert.equal(new Set(ids).size, ids.length, 'geen pagina twee keer');
  assert.equal(shape(groups[0].roots), 'a(a1(a11)),wees,zelf,k1(k2)');
});

test('bovenste pagina\'s per plek: los, dan mappen, dan projecten', () => {
  const folders = new Map<string, TreeFolder>([
    ['m1', { id: 'm1', name: 'Handboek', parent_id: null }],
    ['m2', { id: 'm2', name: 'Archief', parent_id: 'm1' }],
    ['m3', { id: 'm3', name: 'Contracten', parent_id: null }],
  ]);
  const projects = new Map([['p1', 'Website'], ['p2', 'Actie']]);
  const groups = buildPageTree([
    page('los'),
    page('in-archief', { folder_id: 'm2' }),
    page('in-contracten', { folder_id: 'm3' }),
    page('in-project', { project_id: 'p1' }),
    page('in-projectmap', { project_id: 'p2', folder_id: 'm3' }),
    page('sub', { parent_id: 'in-archief', project_id: null }),
  ], { folders, projects });
  assert.deepEqual(groups.map(group => [group.label, shape(group.roots)]), [
    [null, 'los'],
    ['Contracten', 'in-contracten'],
    ['Handboek / Archief', 'in-archief(sub)'],
    ['Actie / Contracten', 'in-projectmap'],
    ['Website', 'in-project'],
  ]);
});

test('sorteren zoals de drive: position, dan de titel met getallen op volgorde', () => {
  const pages = [
    page('c', { title: 'Hoofdstuk 10' }), page('b', { title: 'Hoofdstuk 2' }),
    page('a', { title: 'Zomer', position: -1 }), page('d', { title: 'hoofdstuk 2' }),
  ];
  assert.deepEqual([...pages].sort(comparePages).map(p => p.title), ['Zomer', 'hoofdstuk 2', 'Hoofdstuk 2', 'Hoofdstuk 10']);
  const tree = buildPageTree([page('ouder'), ...pages.map(p => ({ ...p, parent_id: 'ouder' }))], noPlaces);
  assert.deepEqual(tree[0].roots[0].children.map(node => node.page.title), ['Zomer', 'hoofdstuk 2', 'Hoofdstuk 2', 'Hoofdstuk 10']);
});

test('de voorouders van de open pagina, van dichtbij naar ver', () => {
  const pages = [page('a'), page('a1', { parent_id: 'a' }), page('a11', { parent_id: 'a1' }), page('k1', { parent_id: 'k2' }), page('k2', { parent_id: 'k1' })];
  assert.deepEqual(ancestorIds(pages, 'a11'), ['a1', 'a']);
  assert.deepEqual(ancestorIds(pages, 'a'), []);
  assert.deepEqual(ancestorIds(pages, 'onbekend'), []);
  // Een kring loopt niet eindeloos door.
  assert.deepEqual(ancestorIds(pages, 'k1'), ['k2']);
});

test('het dossier: de klant van het project wint, anders de eigen klant', () => {
  const projectClient = new Map<string, string | null>([['p1', 'X'], ['los', null]]);
  assert.equal(dossierClientOf('Y', 'p1', projectClient), 'X');
  assert.equal(dossierClientOf(null, 'p1', projectClient), 'X');
  assert.equal(dossierClientOf('Y', 'los', projectClient), 'Y');
  assert.equal(dossierClientOf(null, 'los', projectClient), null);
  assert.equal(dossierClientOf('Y', null, projectClient), 'Y');
  assert.equal(dossierClientOf('Y', 'onbekend', projectClient), 'Y');
});

test('een mappad stopt bij een kring of een map die je niet ziet', () => {
  const folders = new Map<string, TreeFolder>([
    ['a', { id: 'a', name: 'A', parent_id: 'b' }],
    ['b', { id: 'b', name: ' ', parent_id: 'a' }],
    ['c', { id: 'c', name: 'C', parent_id: 'weg' }],
  ]);
  assert.equal(folderPath(folders, 'a'), 'Naamloze map / A');
  assert.equal(folderPath(folders, 'c'), 'C');
  assert.equal(folderPath(folders, 'weg'), 'Map');
});
