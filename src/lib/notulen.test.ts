import test from 'node:test';
import assert from 'node:assert/strict';
import { contentTargetsFrom, filterContentTargets, notulenAsRichText } from './notulen.ts';
import type { InternalDocument, MeetingSummary, Note } from '../types.ts';

const summary: MeetingSummary = {
  samenvatting: 'We spraken over de livegang.',
  besproken: ['Planning', 'Budget'],
  besluiten: ['Livegang op 1 december'],
  actiepunten: ['Jan stuurt de offerte'],
  vervolgafspraken: [],
};

const note = (id: string, title: string, updated: string, client: string | null = null) =>
  ({ id, title, updated_at: updated, client_id: client }) as unknown as Note;
const doc = (id: string, title: string, updated: string, storageKey: string | null = null) =>
  ({ id, title, updated_at: updated, client_id: null, storage_key: storageKey }) as unknown as InternalDocument;

test('de notulen worden een kopje met samenvatting en lijsten; een leeg onderdeel blijft weg', () => {
  const html = notulenAsRichText({ title: 'Kick-off', date: '23 november 2026', summary });
  assert.equal(html,
    '<h3>Notulen — Kick-off (23 november 2026)</h3>'
    + '<p>We spraken over de livegang.</p>'
    + '<h4>Besproken</h4><ul><li>Planning</li><li>Budget</li></ul>'
    + '<h4>Besluiten</h4><ul><li>Livegang op 1 december</li></ul>'
    + '<h4>Actiepunten</h4><ul><li>Jan stuurt de offerte</li></ul>');
  assert.ok(!html.includes('Vervolgafspraken'));
});

test('tekst uit de opname is gegevens: HTML erin wordt tekst, geen opmaak', () => {
  const html = notulenAsRichText({
    title: '<img src=x onerror=alert(1)>',
    date: 'vandaag',
    summary: { ...summary, besproken: ['<script>alert(1)</script> & "meer"'] },
  });
  assert.ok(!/<img|<script/i.test(html), html);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;meer&quot;'));
});

test('zonder gestructureerde notulen valt het terug op de samenvattingstekst, en zonder tekst is het leeg', () => {
  assert.equal(
    notulenAsRichText({ title: 'Bel', date: 'vandaag', summary: null, fallbackText: 'Regel een\nregel twee\n\nAlinea twee' }),
    '<h3>Notulen — Bel (vandaag)</h3><p>Regel een<br>regel twee</p><p>Alinea twee</p>',
  );
  assert.equal(notulenAsRichText({ title: 'Bel', date: 'vandaag', summary: null, fallbackText: '  ' }), '');
  assert.equal(notulenAsRichText({ title: 'Bel', date: 'vandaag', summary: null }), '');
});

test('een afspraak zonder titel krijgt een nette kop', () => {
  assert.ok(notulenAsRichText({ title: '', date: 'vandaag', summary }).startsWith('<h3>Notulen — afspraak (vandaag)</h3>'));
});

test('de keuzelijst: laatst bewerkt eerst, en een Word-document staat er niet in', () => {
  const targets = contentTargetsFrom(
    [note('n1', 'Oud', '2026-01-01T00:00:00Z'), note('n2', 'Nieuw', '2026-11-01T00:00:00Z', 'c1')],
    [doc('d1', 'Beleid', '2026-06-01T00:00:00Z'), doc('d2', 'Offerte.docx', '2026-12-01T00:00:00Z', 'org/document/d2/offerte.docx')],
    id => (id === 'c1' ? 'Acme' : null),
  );
  assert.deepEqual(targets.map(t => `${t.kind}:${t.id}`), ['note:n2', 'document:d1', 'note:n1']);
  assert.equal(targets[0].hint, 'Notitie · Acme');
  assert.equal(targets[1].hint, 'Document');
});

test('een notitie zonder titel is toch te kiezen', () => {
  const [target] = contentTargetsFrom([note('n1', '   ', '2026-01-01T00:00:00Z')], []);
  assert.equal(target.title, 'Zonder titel');
});

test('zoeken kijkt naar titel en klant, zonder op hoofdletters of accenten te letten', () => {
  const targets = contentTargetsFrom(
    [note('n1', 'Café-overleg', '2026-03-01T00:00:00Z', 'c1'), note('n2', 'Budget', '2026-02-01T00:00:00Z', 'c2')],
    [],
    id => (id === 'c1' ? 'Bakker BV' : 'Smit'),
  );
  assert.deepEqual(filterContentTargets(targets, 'CAFE').map(t => t.id), ['n1']);
  assert.deepEqual(filterContentTargets(targets, 'smit budget').map(t => t.id), ['n2']);
  assert.deepEqual(filterContentTargets(targets, 'bakker nergens').map(t => t.id), []);
  assert.equal(filterContentTargets(targets, '   ').length, 2);
});
