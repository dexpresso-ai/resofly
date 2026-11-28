/**
 * Tests voor de Word-export van een pagina in de app. Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageReferences, wordFileName } from './pageExportParts.ts';

test('de verwijzingen in een pagina: subpagina\'s, bestanden en afbeeldingen, elk één keer', () => {
  const body = { type: 'doc', content: [
    { type: 'subpage', attrs: { pageId: 'p1' } },
    { type: 'callout', content: [{ type: 'image', attrs: { attachmentId: 'a1' } }, { type: 'fileBlock', attrs: { attachmentId: 'f1' } }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'image', attrs: { attachmentId: 'a1' } }] }] }] },
    { type: 'subpage', attrs: { pageId: '' } },
    { type: 'image', attrs: {} },
  ] };
  assert.deepEqual(pageReferences(body), { pages: ['p1'], files: ['f1'], images: ['a1'] });
  assert.deepEqual(pageReferences(null), { pages: [], files: [], images: [] });
  assert.deepEqual(pageReferences('kapot'), { pages: [], files: [], images: [] });
});

test('een bestandsnaam die overal kan', () => {
  assert.equal(wordFileName('Werkwijze & afspraken'), 'Werkwijze-afspraken.docx');
  assert.equal(wordFileName('Café naïef: één'), 'Cafe-naief-een.docx');
  assert.equal(wordFileName('  '), 'pagina.docx');
  assert.equal(wordFileName('../../geheim'), 'geheim.docx');
  assert.equal(wordFileName('x'.repeat(200)).length, 85);
});
