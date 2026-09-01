/**
 * Tests voor het hernoemen in de verkenner. Draaien met:  npm test
 *
 * Het gevaarlijke geval staat onderaan: wie de extensie kwijtraakt, kan zijn
 * Word-bestand niet meer openen. Die regel ligt hier vast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileExtension, fileStem, resolveRename } from './rename.ts';

test('extensie en naamstam splitsen', () => {
  assert.equal(fileExtension('Offerte 2026.docx'), '.docx');
  assert.equal(fileStem('Offerte 2026.docx'), 'Offerte 2026');
  assert.equal(fileExtension('Notulen'), '');
  assert.equal(fileStem('Notulen'), 'Notulen');
  // Een punt aan het begin hoort bij de naam, niet bij een extensie.
  assert.equal(fileExtension('.gitignore'), '');
  assert.equal(fileStem('.gitignore'), '.gitignore');
});

test('leeg of ongewijzigd raakt de database niet', () => {
  assert.deepEqual(resolveRename('Map', '   '), { changed: false });
  assert.deepEqual(resolveRename('Map', 'Map'), { changed: false });
  assert.deepEqual(resolveRename('Offerte.docx', 'Offerte.docx', true), { changed: false });
});

test('titels (map, notitie, document) hebben geen extensielogica', () => {
  assert.deepEqual(resolveRename('Map', 'Kwartaal 1.2026'), { changed: true, name: 'Kwartaal 1.2026', extensionChanged: false });
});

test('bestanden houden hun extensie als je die weglaat', () => {
  assert.deepEqual(
    resolveRename('Offerte 2026.docx', 'Offerte 2027', true),
    { changed: true, name: 'Offerte 2027.docx', extensionChanged: false },
  );
});

test('een andere extensie mag, maar wordt gemeld', () => {
  assert.deepEqual(
    resolveRename('Offerte.docx', 'Offerte.pdf', true),
    { changed: true, name: 'Offerte.pdf', extensionChanged: true },
  );
});

test('verboden tekens en losse punten worden gestript', () => {
  assert.deepEqual(
    resolveRename('Offerte.docx', 'Klant/2026: def*', true),
    { changed: true, name: 'Klant2026 def.docx', extensionChanged: false },
  );
  assert.deepEqual(resolveRename('Map', 'Archief...'), { changed: true, name: 'Archief', extensionChanged: false });
});
