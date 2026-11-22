/**
 * De tekst van een bankbestand uit de bytes (encoding.ts). Draaien met: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBankBytes } from './encoding.ts';

test('ISO-8859-1 / Windows-1252: "Café Hé Zuid" blijft leesbaar', () => {
  // Zo levert ING of Rabobank het soms: é is één byte (0xE9), geen UTF-8.
  const latin1 = Uint8Array.from([...'"Caf', 0xe9, ' H', 0xe9, ' Zuid";"8,50"'].flatMap(p => (typeof p === 'number' ? [p] : [...p].map(c => c.charCodeAt(0)))));
  const text = decodeBankBytes(latin1);
  assert.equal(text, '"Café Hé Zuid";"8,50"');
  assert.ok(!text.includes('�'));
});

test('UTF-8 blijft UTF-8, en de BOM gaat eraf', () => {
  const utf8 = new TextEncoder().encode('Café Hé Zuid – € 8,50');
  assert.equal(decodeBankBytes(utf8), 'Café Hé Zuid – € 8,50');
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('"Datum"')]);
  assert.equal(decodeBankBytes(bom), '"Datum"');
});

test('Windows-1252: het euroteken (0x80) en aanhalingstekens', () => {
  assert.equal(decodeBankBytes(Uint8Array.from([0x80, 0x20, 0x31, 0x93, 0x61, 0x94])), '€ 1“a”');
});
