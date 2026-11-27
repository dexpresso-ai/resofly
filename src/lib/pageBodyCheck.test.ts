import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { pageEditorExtensions } from './pageEditorExtensions.ts';
import { pageBodyFit } from './pageBodyCheck.ts';

const schema = getSchema(pageEditorExtensions());
const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

test('een gewone pagina past', () => {
  assert.deepEqual(pageBodyFit(schema, doc(p('Hallo'))), { ok: true });
});

// Tiptap maakte hier een lege pagina van; de editor mag zo'n pagina nooit
// bewerkbaar openen.
test('een blok dat deze editor niet kent, past niet, met de naam erbij', () => {
  const fit = pageBodyFit(schema, doc(p('voor'), { type: 'columns', content: [{ type: 'column', content: [p('a')] }] }));
  assert.equal(fit.ok, false);
  assert.ok(!fit.ok && fit.unknown.includes('columns'), JSON.stringify(fit));
});

test('opmaak die deze editor niet kent, past niet', () => {
  const fit = pageBodyFit(schema, doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'sparkle' }] }] }));
  assert.equal(fit.ok, false);
  assert.ok(!fit.ok && fit.unknown.includes('opmaak sparkle'));
});

test('een blok op een plek waar het niet mag, past niet', () => {
  const fit = pageBodyFit(schema, doc({ type: 'listItem', content: [p('los')] }));
  assert.equal(fit.ok, false);
});

test('geen object of geen document, past niet', () => {
  assert.equal(pageBodyFit(schema, null).ok, false);
  assert.equal(pageBodyFit(schema, 'tekst').ok, false);
  assert.equal(pageBodyFit(schema, { type: 'paragraph' }).ok, false);
});

const table = (cellAttrs: Record<string, unknown>) => doc({
  type: 'table',
  content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: cellAttrs, content: [p('a')] }] }],
});

test('een tabel met hele getallen als maat past', () => {
  assert.deepEqual(pageBodyFit(schema, table({ colspan: 1, rowspan: 1, colwidth: [120] })), { ok: true });
  assert.deepEqual(pageBodyFit(schema, table({ colwidth: null })), { ok: true });
});

// Tiptap zet colwidth zonder controle in een style-attribuut; zo kwam er een
// plaatje van buiten (een volgpixel) in de pagina.
test('een tabelcel met tekst of een stijl als maat past niet', () => {
  assert.equal(pageBodyFit(schema, table({ colwidth: ['1px; background-image: url(https://example.com/x.png)'] })).ok, false);
  assert.equal(pageBodyFit(schema, table({ colspan: '2' })).ok, false);
  assert.equal(pageBodyFit(schema, table({ rowspan: 1.5 })).ok, false);
  assert.equal(pageBodyFit(schema, table({ colwidth: 120 })).ok, false);
});
