import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMissingMentionsTable, mentionedInPages, mentionedInPlace, type MentionedInPlaces } from './pageMentionedIn.ts';

// Stap 2-1c: "Genoemd in" maakt van de ids uit page_mentions pagina's met een
// titel en een plek. Welke ids je krijgt, bepaalt de database (de RLS); dat
// test tests/database/paginas_vermeldingen.sql.

const places: MentionedInPlaces = {
  clients: [{ id: 'k1', name: 'Bakkerij Jansen' }],
  projects: [{ id: 'p1', name: 'Verbouwing' }],
  ownDossierName: 'Studio Noord',
};

const doc = (id: string, extra: Partial<{ title: string; format: 'page' | 'html' | 'office'; client_id: string | null; project_id: string | null; updated_at: string; archived_at: string | null }> = {}) => ({
  id, title: `Pagina ${id}`, format: 'page' as const, client_id: null, project_id: null, updated_at: '2026-11-20T10:00:00Z', archived_at: null, ...extra,
});

test('de plek: het project, anders de klant, anders het eigen dossier; wat je niet ziet heet "Ander dossier"', () => {
  assert.equal(mentionedInPlace({ client_id: 'k1', project_id: 'p1' }, places), 'Project · Verbouwing');
  assert.equal(mentionedInPlace({ client_id: 'k1', project_id: null }, places), 'Klant · Bakkerij Jansen');
  assert.equal(mentionedInPlace({ client_id: null, project_id: null }, places), 'Studio Noord');
  assert.equal(mentionedInPlace({ client_id: null, project_id: null }, { ...places, ownDossierName: '  ' }), 'Eigen dossier');
  // Een project of klant die niet geladen is (geen rechten): nooit het id.
  assert.equal(mentionedInPlace({ client_id: 'k1', project_id: 'onbekend' }, places), 'Ander dossier');
  assert.equal(mentionedInPlace({ client_id: 'onbekend', project_id: null }, places), 'Ander dossier');
});

test('de pagina\'s achter de ids: het laatst bewerkt bovenaan, zonder prullenbak, zonder andere documenten, zonder wat niet geladen is', () => {
  const documents = [
    doc('a', { updated_at: '2026-11-20T10:00:00Z', project_id: 'p1', client_id: 'k1' }),
    doc('b', { updated_at: '2026-11-25T10:00:00Z', client_id: 'k1', title: '  ' }),
    doc('c', { updated_at: '2026-11-27T10:00:00Z', archived_at: '2026-11-27T11:00:00Z' }),
    doc('d', { format: 'html' }),
    doc('e', { updated_at: '2026-11-22T10:00:00Z' }),
    doc('niet-genoemd'),
  ];
  const rows = mentionedInPages(['a', 'b', 'c', 'd', 'e', 'weg'], documents, places);
  assert.deepEqual(rows.map(row => [row.doc.id, row.title, row.place]), [
    ['b', 'Zonder titel', 'Klant · Bakkerij Jansen'],
    ['e', 'Pagina e', 'Studio Noord'],
    ['a', 'Pagina a', 'Project · Verbouwing'],
  ]);
  assert.deepEqual(mentionedInPages([], documents, places), []);
});

test('bij gelijke tijd op titel', () => {
  const documents = [doc('x', { title: 'Zomer' }), doc('y', { title: 'Actie' })];
  assert.deepEqual(mentionedInPages(['x', 'y'], documents, places).map(row => row.title), ['Actie', 'Zomer']);
});

test('een ontbrekende tabel page_mentions (de app eerder live dan de migratie): alleen dan niets, elke andere fout blijft een fout', () => {
  // Zo antwoordt PostgREST (gezien tegen de lokale stack, met een tabel die niet bestaat).
  assert.equal(isMissingMentionsTable({ code: 'PGRST205', details: null, message: "Could not find the table 'public.page_mentions' in the schema cache" }), true);
  assert.equal(isMissingMentionsTable({ code: '42P01', message: 'relation "public.page_mentions" does not exist' }), true);
  // Geen rechten, een andere tabel, een tabel met een langere naam, of geen fout: niet.
  assert.equal(isMissingMentionsTable({ code: '42501', message: 'permission denied for table page_mentions' }), false);
  assert.equal(isMissingMentionsTable({ code: 'PGRST205', message: "Could not find the table 'public.documents' in the schema cache" }), false);
  assert.equal(isMissingMentionsTable({ code: 'PGRST205', message: "Could not find the table 'public.page_mentions_oud' in the schema cache" }), false);
  assert.equal(isMissingMentionsTable({ code: '42P01', message: 'relation "public.documents" does not exist' }), false);
  assert.equal(isMissingMentionsTable(null), false);
});
