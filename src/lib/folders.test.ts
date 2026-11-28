/**
 * Tests voor de mappen van een notitie of document. Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFolderOptions, contentPlace } from './folders.ts';
import type { ContentFolder } from '../types';

const projects = [{ id: 'p-x', client_id: 'X' }, { id: 'p-los', client_id: null }];
const clients = [{ id: 'X', name: 'Bakkerij Jansen' }];

test('zonder klant en zonder project: het eigen dossier', () => {
  assert.deepEqual(contentPlace({ client_id: '', project_id: '' }, projects, clients), { folderClientId: null, emptyLabel: 'Eigen dossier' });
  // Een project zonder klant hoort ook bij het eigen dossier.
  assert.deepEqual(contentPlace({ client_id: null, project_id: 'p-los' }, projects, clients), { folderClientId: null, emptyLabel: 'Eigen dossier' });
});

test('zonder klant maar met een project van een klant: bij die klant, niet in het eigen dossier', () => {
  assert.deepEqual(contentPlace({ client_id: '', project_id: 'p-x' }, projects, clients), { folderClientId: 'X', emptyLabel: 'Bakkerij Jansen (via het project)' });
  // Een klant die je (nog) niet ziet: geen lege naam.
  assert.equal(contentPlace({ project_id: 'p-x' }, projects, []).emptyLabel, 'Klant (via het project)');
});

test('met een gekozen klant: de mappen van die klant', () => {
  assert.equal(contentPlace({ client_id: 'Y', project_id: '' }, projects, clients).folderClientId, 'Y');
});

test('de mappen van het eigen dossier zijn die zonder klant en zonder project', () => {
  const map = (id: string, client_id: string | null, project_id: string | null, parent_id: string | null = null) =>
    ({ id, client_id, project_id, parent_id, name: id, position: 0 }) as unknown as ContentFolder;
  const folders = [map('eigen', null, null), map('eigen-sub', null, null, 'eigen'), map('klant', 'X', null), map('project', 'X', 'p-x')];
  assert.deepEqual(clientFolderOptions(folders, null, null).map(o => o.label), ['eigen', '— eigen-sub']);
  assert.deepEqual(clientFolderOptions(folders, 'X', 'p-x').map(o => o.id), ['project']);
});
