import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import { insertColumns, pageEditorExtensions, withoutUnknownMentions } from './pageEditorExtensions.ts';
import { PAGE_MARK_TYPES, PAGE_NODE_TYPES } from './pageSchema.ts';

// De database weigert een pagina met een blok of opmaak die niet in
// page_body_allowed staat. Kan de editor zoiets maken, dan mislukt opslaan.
test('de editor maakt alleen blokken en opmaak die de database aanneemt', () => {
  const schema = getSchema(pageEditorExtensions());
  for (const name of Object.keys(schema.nodes)) {
    assert.ok((PAGE_NODE_TYPES as readonly string[]).includes(name), `blok ${name} staat niet in pageSchema.ts`);
  }
  for (const name of Object.keys(schema.marks)) {
    assert.ok((PAGE_MARK_TYPES as readonly string[]).includes(name), `opmaak ${name} staat niet in pageSchema.ts`);
  }
});

test('een lege pagina uit de editor past in het schema', () => {
  const schema = getSchema(pageEditorExtensions());
  const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph' }] });
  assert.equal(doc.childCount, 1);
});

// Stap 1A-4a: tabel, callout, uitklapper en inhoudsopgave. Elk blok moet in
// de editor passen met de namen die de database kent; anders opende de
// pagina leeg (pageBodyCheck.ts) of weigerde de database het opslaan.
test('een pagina met elk nieuw blok past in het schema', () => {
  const schema = getSchema(pageEditorExtensions());
  for (const name of ['table', 'tableRow', 'tableHeader', 'tableCell', 'callout', 'details', 'detailsSummary', 'detailsContent', 'tableOfContents', 'subpage', 'image', 'fileBlock', 'columns', 'column', 'mention']) {
    assert.ok(schema.nodes[name], `blok ${name} ontbreekt in de editor`);
  }
  assert.equal(schema.marks.textStyle, undefined, 'textStyle hoort niet in de editor: de database kent die opmaak niet');
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'tableOfContents' },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Kop' }] },
      { type: 'table', content: [
        { type: 'tableRow', content: [{ type: 'tableHeader', content: [p('Naam')] }, { type: 'tableHeader', attrs: { align: 'right' }, content: [p('Bedrag')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [140] }, content: [p('Koffie')] }, { type: 'tableCell', content: [p('2,50')] }] },
      ] },
      { type: 'callout', attrs: { variant: 'let-op' }, content: [p('Let hierop.'), { type: 'bulletList', content: [{ type: 'listItem', content: [p('punt')] }] }] },
      { type: 'details', content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: 'Meer weten?' }] },
        { type: 'detailsContent', content: [p('Hier staat meer.')] },
      ] },
    ],
  });
  doc.check();
  assert.equal(doc.childCount, 5);
});

// Stap 2-0: kolommen. Twee of drie, met gewone blokken; geen tabel of
// kolommen in een kolom (COLUMN_CONTENT). De database kende ze al.
test('kolommen: twee of drie, met gewone blokken erin', () => {
  const schema = getSchema(pageEditorExtensions());
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const column = (...content: unknown[]) => ({ type: 'column', content });
  for (const count of [2, 3]) {
    const doc = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'columns', content: Array.from({ length: count }, (_, i) => column(p(`kolom ${i + 1}`))) }] });
    doc.check();
  }
  // Eén of vier kolommen, of een tabel of kolommen in een kolom: dat maakt de editor niet.
  const wrong = [
    { type: 'columns', content: [column(p('alleen'))] },
    { type: 'columns', content: [1, 2, 3, 4].map(i => column(p(String(i)))) },
    { type: 'columns', content: [column({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('x')] }] }] }), column(p('b'))] },
    { type: 'columns', content: [column({ type: 'columns', content: [column(p('a')), column(p('b'))] }), column(p('c'))] },
  ];
  for (const node of wrong) {
    assert.throws(() => schema.nodeFromJSON({ type: 'doc', content: [node] }).check(), JSON.stringify(node).slice(0, 60));
  }
  // Een kolom met een afbeelding, een lijst en een callout kan wel.
  schema.nodeFromJSON({ type: 'doc', content: [{ type: 'columns', content: [
    column({ type: 'image', attrs: { attachmentId: '00000000-0000-4000-8000-000000000001' } }, { type: 'bulletList', content: [{ type: 'listItem', content: [p('punt')] }] }),
    column({ type: 'callout', attrs: { variant: 'tip' }, content: [p('tip')] }),
  ] }] }).check();
});

test('kolommen invoegen: een lege regel wordt de kolommen, met de cursor in de eerste en een regel eronder', () => {
  const schema = getSchema(pageEditorExtensions());
  const p = (text?: string) => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) });
  const run = (content: unknown[], cursor: number, count: 2 | 3) => {
    const doc = schema.nodeFromJSON({ type: 'doc', content });
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, cursor) });
    const tr = state.tr;
    const ok = insertColumns(count)({ tr, dispatch: true });
    state = state.apply(tr);
    return { ok, state };
  };
  // Een lege regel onderaan: die wordt de kolommen, en er komt een regel onder.
  const empty = run([p('boven'), p()], 8, 2);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.state.doc.toJSON().content.map((node: { type: string }) => node.type), ['paragraph', 'columns', 'paragraph']);
  assert.equal(empty.state.doc.child(1).childCount, 2);
  assert.equal(empty.state.selection.$from.node(empty.state.selection.$from.depth - 1).type.name, 'column');
  assert.equal(empty.state.selection.$from.index(1), 0, 'de cursor staat in de eerste kolom');
  // In een regel met tekst: de kolommen komen eronder, de tekst blijft staan.
  const full = run([p('tekst'), p('verder')], 3, 3);
  assert.deepEqual(full.state.doc.toJSON().content.map((node: { type: string }) => node.type), ['paragraph', 'columns', 'paragraph']);
  assert.equal(full.state.doc.child(0).textContent, 'tekst');
  assert.equal(full.state.doc.child(1).childCount, 3);
  assert.equal(full.state.doc.child(2).textContent, 'verder');
  // Niet in een lijst: alleen op het hoogste niveau.
  const list = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p('punt')] }] }] });
  const listState = EditorState.create({ schema, doc: list, selection: TextSelection.create(list, 4) });
  assert.equal(insertColumns(2)({ tr: listState.tr, dispatch: undefined }), false);
});

// Stap 2-1a: een @-vermelding is een knoop in de tekst, met alleen de soort en
// het id. Bij plakken valt een vermelding weg die de editor niet kent: uit
// een andere organisatie weigert de database hem, en dan mislukte elke opslag.
test('een @-vermelding past in de tekst; plakken houdt alleen wat de editor kent', () => {
  const schema = getSchema(pageEditorExtensions());
  const id = '11111111-2222-4333-8444-555555555555';
  const vreemd = '99999999-2222-4333-8444-555555555555';
  const mention = (kind: string, ref: string) => ({ type: 'mention', attrs: { kind, id: ref } });
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Bel ' }, mention('client', id), { type: 'text', text: ' en ' }, mention('member', vreemd)] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [mention('client', vreemd)] }] }] },
  ] });
  doc.check();
  assert.deepEqual({ ...doc.firstChild?.child(1).attrs }, { kind: 'client', id });
  const kept = withoutUnknownMentions(doc.content, node => node.attrs.id === id);
  const json = JSON.stringify(Fragment.from(kept).toJSON());
  assert.ok(json.includes(id) && !json.includes(vreemd), json);
  // Niets weg te halen: hetzelfde fragment, zodat plakken verder niets verandert.
  assert.equal(withoutUnknownMentions(doc.content, () => true), doc.content);
});
