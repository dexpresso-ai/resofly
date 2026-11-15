/**
 * Tests voor de lijst "Notities & documenten" op het projectoverzicht. Draaien
 * met:  npm test
 *
 * Het gevaarlijke geval: een notitie waarin alleen met de pen is geschreven.
 * Dat opslaan raakt `notes.updated_at` niet, dus wie alleen naar die kolom
 * kijkt, zet hem onder ouder typwerk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECENT_CONTENT_LIMIT, latestMoment, recentProjectContent } from './projectOverview.ts';
import type { InternalDocument, Note } from '../types';

const note = (id: string, updated_at: string, created_at = '2026-11-01T08:00:00Z'): Note => ({
  id, organization_id: 'org', client_id: null, project_id: 'p', folder_id: null, title: id, content: '',
  note_type: 'general', tags: [], created_at, updated_at,
});
const doc = (id: string, updated_at: string, extra: Partial<InternalDocument> = {}): InternalDocument => ({
  id, organization_id: 'org', client_id: null, project_id: 'p', folder_id: null, title: id, content: '',
  document_type: 'general', created_at: '2026-11-01T08:00:00Z', updated_at, ...extra,
});

test('notities en documenten samen, het laatst bewerkte eerst', () => {
  const list = recentProjectContent(
    [note('n-oud', '2026-11-02T10:00:00Z'), note('n-nieuw', '2026-11-14T10:00:00Z')],
    [doc('d-midden', '2026-11-10T10:00:00Z')],
    [],
  );
  assert.deepEqual(list.map(item => item.id), ['n-nieuw', 'd-midden', 'n-oud']);
  assert.deepEqual(list.map(item => item.kind), ['note', 'document', 'note']);
});

test(`hooguit ${RECENT_CONTENT_LIMIT}, en de rest valt af`, () => {
  const notes = Array.from({ length: 4 }, (_, i) => note(`n${i}`, `2026-11-0${i + 1}T10:00:00Z`));
  const documents = Array.from({ length: 4 }, (_, i) => doc(`d${i}`, `2026-11-1${i}T10:00:00Z`));
  const list = recentProjectContent(notes, documents, []);
  assert.equal(list.length, RECENT_CONTENT_LIMIT);
  assert.deepEqual(list.map(item => item.id), ['d3', 'd2', 'd1', 'd0', 'n3']);
});

test('handschrift telt mee: een notitie met verse pen komt bovenaan', () => {
  const list = recentProjectContent(
    [note('getypt', '2026-11-12T10:00:00Z'), note('geschreven', '2026-11-03T10:00:00Z')],
    [],
    [{ note_id: 'geschreven', updated_at: '2026-11-14T21:30:00Z' }],
  );
  assert.deepEqual(list.map(item => item.id), ['geschreven', 'getypt']);
  const first = list[0];
  assert.equal(first.kind === 'note' && first.handwritten, true);
  assert.equal(first.modified, Date.parse('2026-11-14T21:30:00Z'));
});

test('een Office-document telt de laatste bewerking in de editor mee', () => {
  const list = recentProjectContent(
    [note('notitie', '2026-11-12T10:00:00Z')],
    [doc('word', '2026-11-05T10:00:00Z', { storage_key: 'org/doc.docx', last_edited_at: '2026-11-13T09:00:00Z' })],
    [],
  );
  assert.deepEqual(list.map(item => item.id), ['word', 'notitie']);
});

test('lege of kapotte tijden tellen niet; bij gelijke tijd een vaste volgorde', () => {
  assert.equal(latestMoment(null, undefined, '', 'geen datum'), 0);
  assert.equal(latestMoment('2026-11-01T00:00:00Z', null), Date.parse('2026-11-01T00:00:00Z'));
  const same = '2026-11-10T10:00:00Z';
  const once = recentProjectContent([note('b', same), note('a', same)], [], []).map(item => item.id);
  const again = recentProjectContent([note('a', same), note('b', same)], [], []).map(item => item.id);
  assert.deepEqual(once, ['a', 'b']);
  assert.deepEqual(again, once);
});
