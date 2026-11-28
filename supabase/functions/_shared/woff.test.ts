/**
 * Tests voor het terugzetten van een .woff naar TTF. Draaien met:  npm test
 *
 * Met de hand vergeleken met fonttools (28 november 2026): voor Poppins, DM Sans,
 * Playfair Display en Bebas Neue gaven beide exact dezelfde tabellen. Hier: elk
 * bestand uit public/fonts/pdf wordt een geldige TTF, met de goede naam.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { sfntChecksum, sfntFamilyName, woffToSfnt } from './woff.ts';

const FONTS = new URL('../../../public/fonts/pdf/', import.meta.url);
const files = readdirSync(FONTS).filter(name => name.endsWith('.woff')).sort();
const woffOf = (name: string) => new Uint8Array(readFileSync(new URL(name, FONTS)));

/** De familie per bestand, zoals in public/fonts/pdf/LICENTIES.md. */
const FAMILIES: Record<string, string> = {
  poppins: 'Poppins', inter: 'Inter', jost: 'Jost', 'space-grotesk': 'Space Grotesk', 'dm-sans': 'DM Sans',
  'playfair-display': 'Playfair Display', 'cormorant-garamond': 'Cormorant Garamond', lora: 'Lora', 'bebas-neue': 'Bebas Neue',
};

test('elke huisstijlletter wordt een geldige TTF: kop, tabellen en sommen kloppen', async () => {
  assert.ok(files.length >= 9, 'de letters in public/fonts/pdf');
  for (const name of files) {
    const woff = woffOf(name);
    const woffView = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    const sfnt = await woffToSfnt(woff);
    const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
    const numTables = view.getUint16(4);
    assert.equal(view.getUint32(0), woffView.getUint32(4), `${name}: het soort letter (TrueType of CFF)`);
    assert.equal(numTables, woffView.getUint16(12), `${name}: het aantal tabellen`);
    // De zoekhulp in de kop, zoals het TTF-formaat hem voorschrijft.
    const selector = Math.floor(Math.log2(numTables));
    assert.deepEqual([view.getUint16(6), view.getUint16(8), view.getUint16(10)], [2 ** selector * 16, selector, numTables * 16 - 2 ** selector * 16], name);
    // WOFF geeft de lengte van de oorspronkelijke letter mee: die komt terug.
    assert.equal(sfnt.length, woffView.getUint32(16), `${name}: de lengte`);
    for (let i = 0; i < numTables; i += 1) {
      const record = 12 + i * 16;
      const tag = String.fromCharCode(...sfnt.subarray(record, record + 4));
      const offset = view.getUint32(record + 8);
      const length = view.getUint32(record + 12);
      assert.equal(offset % 4, 0, `${name} ${tag}: op een veelvoud van vier`);
      const table = sfnt.slice(offset, offset + length);
      // De som van 'head' telt zonder zijn eigen checkSumAdjustment (bytes 8 tot 12).
      if (tag === 'head') table.fill(0, 8, 12);
      assert.equal(sfntChecksum(table), view.getUint32(record + 4), `${name} ${tag}: de som`);
    }
    const family = FAMILIES[name.replace(/-\d+\.woff$/, '')];
    assert.equal(sfntFamilyName(sfnt), family, `${name}: de naam van de familie`);
  }
});

test('het aantal tekens staat er nog in (maxp)', async () => {
  // Uit fonttools, bij het vergelijken met de hand.
  for (const [name, glyphs] of [['poppins-400.woff', 218], ['dm-sans-700.woff', 268], ['playfair-display-700.woff', 314]] as const) {
    const sfnt = await woffToSfnt(woffOf(name));
    const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
    let found = false;
    for (let i = 0; i < view.getUint16(4); i += 1) {
      const record = 12 + i * 16;
      if (String.fromCharCode(...sfnt.subarray(record, record + 4)) !== 'maxp') continue;
      assert.equal(view.getUint16(view.getUint32(record + 8) + 4), glyphs, name);
      found = true;
    }
    assert.ok(found, `${name}: geen maxp`);
  }
});

test('iets anders dan WOFF 1 wordt geweigerd, ook een afgebroken bestand', async () => {
  const ttf = await woffToSfnt(woffOf('poppins-400.woff'));
  await assert.rejects(woffToSfnt(ttf), /Geen WOFF 1/);
  await assert.rejects(woffToSfnt(new Uint8Array([0x77, 0x4f, 0x46, 0x32, ...new Array(60).fill(0)])), /Geen WOFF 1/);
  await assert.rejects(woffToSfnt(woffOf('poppins-400.woff').slice(0, 400)), /afgebroken/);
  assert.equal(sfntFamilyName(new Uint8Array(4)), null);
});

test('de som van een tabel telt in stukken van vier bytes, ook met een staart', () => {
  assert.equal(sfntChecksum(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2])), 3);
  assert.equal(sfntChecksum(new Uint8Array([1])), 0x01000000);
  assert.equal(sfntChecksum(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 2])), 1);
});
