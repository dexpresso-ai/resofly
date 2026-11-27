import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_BLOCKS, filterPageBlocks } from './pageBlocks.ts';

const keys = (query: string) => filterPageBlocks(query).map(block => block.key);

test('zonder zoekwoord: elk blok, in de vaste volgorde', () => {
  assert.deepEqual(keys(''), PAGE_BLOCKS.map(block => block.key));
  assert.deepEqual(keys('   '), PAGE_BLOCKS.map(block => block.key));
});

test('de naam gaat voor: /tab geeft eerst de tabel, /kop de drie koppen', () => {
  assert.equal(keys('tab')[0], 'tabel');
  assert.deepEqual(keys('kop'), ['kop1', 'kop2', 'kop3']);
  // Na de schuine streep typ je geen spatie: /kop2 is Kop 2.
  assert.deepEqual(keys('kop2'), ['kop2']);
  assert.equal(keys('inh')[0], 'inhoudsopgave');
  assert.equal(keys('uit')[0], 'uitklapper');
});

test('andere woorden, ook uit andere programma\'s', () => {
  assert.deepEqual(keys('h2'), ['kop2']);
  assert.equal(keys('toggle')[0], 'uitklapper');
  assert.equal(keys('let op')[0], 'callout');
  assert.equal(keys('todo')[0], 'takenlijst');
  assert.ok(keys('lijst').includes('opsomming') && keys('lijst').includes('nummering'));
});

test('hoofdletters en accenten maken niet uit', () => {
  assert.equal(keys('TABEL')[0], 'tabel');
  assert.equal(keys('tâbel')[0], 'tabel');
});

test('niets gevonden is een lege lijst', () => {
  assert.deepEqual(keys('xyzzy'), []);
});

test('elk blok heeft een eigen sleutel, een naam en uitleg', () => {
  assert.equal(new Set(PAGE_BLOCKS.map(block => block.key)).size, PAGE_BLOCKS.length);
  for (const block of PAGE_BLOCKS) assert.ok(block.label && block.hint, block.key);
});
