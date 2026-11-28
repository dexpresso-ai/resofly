import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { pageEditorExtensions } from './pageEditorExtensions.ts';
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
  for (const name of ['table', 'tableRow', 'tableHeader', 'tableCell', 'callout', 'details', 'detailsSummary', 'detailsContent', 'tableOfContents', 'subpage', 'image', 'fileBlock']) {
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
