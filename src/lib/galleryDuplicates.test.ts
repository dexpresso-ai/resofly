/**
 * Tests voor het herkennen van dubbele bestanden in een galerij-album. Draaien
 * met:  npm test
 *
 * Het gevaarlijke geval staat bij planGalleryUpload: een nieuwe naam mag nooit
 * de naam pakken van een bestand dat verderop in dezelfde upload zit. Dan
 * weigerde de database dat latere bestand, nadat het al helemaal naar
 * Cloudflare was geüpload.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_NAME_TAKEN_HINT,
  cleanGalleryFileName,
  findGalleryDuplicates,
  freeGalleryFileName,
  galleryFileNameKey,
  isGalleryNameTaken,
  planGalleryUpload,
  type GalleryDuplicateChoice,
} from './galleryDuplicates.ts';

const file = (name: string, size = 100) => ({ name, size });
const row = (file_name: string, size_bytes = 100) => ({ file_name, size_bytes });

test('hoofdletters, spaties en Unicode-vorm tellen niet mee', () => {
  assert.equal(galleryFileNameKey('IMG_0001.JPG'), galleryFileNameKey('img_0001.jpg'));
  assert.equal(galleryFileNameKey('  taart.jpg '), 'taart.jpg');
  // "é" als één teken (NFC, Windows) en als e + accent (NFD, oudere Macs).
  assert.equal(galleryFileNameKey('Café.jpg'), galleryFileNameKey('Café.jpg'));
  assert.equal(cleanGalleryFileName('Café.jpg'), 'Café.jpg');
});

test('een vrije naam krijgt een volgnummer met een streepje', () => {
  assert.equal(freeGalleryFileName('IMG_0001.jpg', new Set(['img_0001.jpg'])), 'IMG_0001-2.jpg');
  assert.equal(
    freeGalleryFileName('IMG_0001.jpg', new Set(['img_0001.jpg', 'img_0001-2.jpg', 'img_0001-3.jpg'])),
    'IMG_0001-4.jpg',
  );
  // De extensie blijft zoals hij was, ook in hoofdletters.
  assert.equal(freeGalleryFileName('DSC_1.JPG', new Set(['dsc_1.jpg'])), 'DSC_1-2.JPG');
  // Alleen de laatste punt is de extensie.
  assert.equal(freeGalleryFileName('feest.2026.mp4', new Set()), 'feest.2026-2.mp4');
  // Geen extensie, of alleen een punt vooraan.
  assert.equal(freeGalleryFileName('scan', new Set()), 'scan-2');
  assert.equal(freeGalleryFileName('.jpg', new Set()), '.jpg-2');
});

test('dubbel in het album, met of zonder dezelfde grootte', () => {
  const duplicates = findGalleryDuplicates(
    [file('taart.jpg', 100), file('Dans.JPG', 999), file('nieuw.jpg')],
    [row('taart.jpg', 100), row('dans.jpg', 100)],
  );
  assert.deepEqual(duplicates, [
    { index: 0, name: 'taart.jpg', kind: 'album', sameSize: true },
    { index: 1, name: 'Dans.JPG', kind: 'album', sameSize: false },
  ]);
});

test('dubbel binnen dezelfde upload: pas het tweede bestand', () => {
  // Een gesleepte map met submappen: "Selectie/a.jpg" en "Alles/a.jpg".
  const duplicates = findGalleryDuplicates([file('a.jpg', 1), file('b.jpg'), file('A.jpg', 1), file('a.jpg', 2)], []);
  assert.deepEqual(duplicates, [
    { index: 2, name: 'A.jpg', kind: 'batch', sameSize: true },
    { index: 3, name: 'a.jpg', kind: 'batch', sameSize: false },
  ]);
});

test('een leeg album en unieke namen: niets dubbel', () => {
  assert.deepEqual(findGalleryDuplicates([file('a.jpg'), file('b.jpg')], []), []);
});

test('het plan volgt de keuzes en laat een open keuze niet mee', () => {
  const files = [file('a.jpg'), file('b.jpg'), file('c.jpg'), file('d.jpg')];
  const existing = [row('a.jpg'), row('b.jpg'), row('c.jpg')];
  const duplicates = findGalleryDuplicates(files, existing);
  const choices = new Map<number, GalleryDuplicateChoice>([[0, 'skip'], [1, 'rename']]);
  const plan = planGalleryUpload(files, existing, duplicates, choices);
  assert.deepEqual(plan.entries, [
    { index: 1, name: 'b-2.jpg', renamed: true },
    { index: 3, name: 'd.jpg', renamed: false },
  ]);
  assert.equal(plan.skipped, 1);
  assert.equal(plan.renamed, 1);
  assert.equal(plan.undecided, 1, 'c.jpg heeft nog geen keuze');
});

test('een nieuwe naam ontwijkt bestanden verderop in dezelfde upload', () => {
  // a.jpg staat al in het album; a-2.jpg zit verderop in deze upload.
  const files = [file('a.jpg'), file('a-2.jpg')];
  const existing = [row('a.jpg')];
  const duplicates = findGalleryDuplicates(files, existing);
  const plan = planGalleryUpload(files, existing, duplicates, new Map([[0, 'rename']]));
  assert.deepEqual(plan.entries.map(e => e.name), ['a-3.jpg', 'a-2.jpg']);
});

test('twee keer hetzelfde, allebei hernoemd: elk een eigen nummer', () => {
  const files = [file('a.jpg'), file('A.JPG')];
  const existing = [row('a.jpg')];
  const duplicates = findGalleryDuplicates(files, existing);
  assert.equal(duplicates.length, 2);
  const plan = planGalleryUpload(files, existing, duplicates, new Map([[0, 'rename'], [1, 'rename']]));
  assert.deepEqual(plan.entries.map(e => e.name), ['a-2.jpg', 'A-3.JPG']);
  const keys = new Set([...existing.map(r => galleryFileNameKey(r.file_name)), ...plan.entries.map(e => galleryFileNameKey(e.name))]);
  assert.equal(keys.size, 3, 'geen enkele naam komt twee keer voor');
});

test('het eerste bestand van een dubbel paar houdt zijn naam', () => {
  const files = [file('a.jpg'), file('a.jpg')];
  const duplicates = findGalleryDuplicates(files, []);
  const plan = planGalleryUpload(files, [], duplicates, new Map([[1, 'rename']]));
  assert.deepEqual(plan.entries, [
    { index: 0, name: 'a.jpg', renamed: false },
    { index: 1, name: 'a-2.jpg', renamed: true },
  ]);
});

test('alles overslaan laat alleen de niet-dubbele bestanden over', () => {
  const files = [file('a.jpg'), file('b.jpg')];
  const existing = [row('a.jpg'), row('b.jpg')];
  const duplicates = findGalleryDuplicates(files, existing);
  const plan = planGalleryUpload(files, existing, duplicates, new Map(duplicates.map(d => [d.index, 'skip' as const])));
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.skipped, 2);
});

test('alleen de eigen fout van de trigger telt als "naam bezet"', () => {
  assert.equal(isGalleryNameTaken({ code: '23505', hint: GALLERY_NAME_TAKEN_HINT, message: 'x' }), true);
  assert.equal(isGalleryNameTaken({ code: '23505', hint: null, message: 'duplicate key value' }), false);
  assert.equal(isGalleryNameTaken({ code: '42501', hint: GALLERY_NAME_TAKEN_HINT }), false);
  assert.equal(isGalleryNameTaken(null), false);
  assert.equal(isGalleryNameTaken(new Error('netwerk')), false);
});
