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
