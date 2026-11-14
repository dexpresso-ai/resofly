/**
 * Tests voor de vorm van een galerijsleutel. Draaien met:  npm test
 *
 * Het gevaarlijke geval: een origineel waarvan de variant niet als `original`
 * gelezen wordt. Dan geeft handleGalleryFile het full-res bestand aan een
 * kijk-token, en betekent "downloaden uit" niets meer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryObjectKey, galleryVariantFromKey } from './galleryKeys.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const GAL = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const UUID = '44444444-4444-4444-8444-444444444444';

const nieuw = (variant: string, fileName: string) =>
  galleryObjectKey({ organizationId: ORG, galleryId: GAL, itemId: ITEM, variant, uuid: UUID, fileName });

test('de sleutel eindigt op de naam van de telefoon', () => {
  assert.equal(nieuw('original', 'yes.jpg'), `${ORG}/gallery/${GAL}/${ITEM}/original-${UUID}/yes.jpg`);
  assert.equal(nieuw('preview', 'preview-yes.jpg'), `${ORG}/gallery/${GAL}/${ITEM}/preview-${UUID}/preview-yes.jpg`);
});

test('de variant komt uit de nieuwe sleutel', () => {
  for (const variant of ['original', 'master', 'source', 'preview', 'thumb']) {
    assert.equal(galleryVariantFromKey(nieuw(variant, 'yes.jpg')), variant);
  }
});

test('een origineel blijft een origineel, wat de naam ook zegt', () => {
  assert.equal(galleryVariantFromKey(nieuw('original', 'preview-yes.jpg')), 'original');
  assert.equal(galleryVariantFromKey(nieuw('original', 'thumb-x.jpg')), 'original');
  assert.equal(galleryVariantFromKey(nieuw('original', 'yes')), 'original');
  assert.equal(galleryVariantFromKey(nieuw('master', 'clip-final.mp4')), 'master');
});

test('oude sleutels lezen nog net zo', () => {
  assert.equal(galleryVariantFromKey(`${ORG}/gallery/${GAL}/${ITEM}/original-${UUID}-yes.jpg`), 'original');
  assert.equal(galleryVariantFromKey(`${ORG}/gallery/${GAL}/${ITEM}/preview-${UUID}-preview-yes.jpg.jpg`), 'preview');
  assert.equal(galleryVariantFromKey(`${ORG}/gallery/${GAL}/${ITEM}/master-${UUID}-clip.mp4`), 'master');
});

test('zonder variant: een lege string', () => {
  assert.equal(galleryVariantFromKey(''), '');
  assert.equal(galleryVariantFromKey(`${ORG}/gallery/${GAL}/${ITEM}/yes.jpg`), '');
});
