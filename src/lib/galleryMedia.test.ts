/**
 * Tests voor de afspeel- en zipregels van de galerij. Draaien met:  npm test
 *
 * Het gevaarlijke geval staat bij videoPlaybackSource: een master mag alleen
 * 'file' worden zolang er géén speelklare kijkkopie is. Zou een master ook
 * met kijkkopie 'file' worden, dan vraagt de viewer de master op met een
 * kijk-token, en die weigert de worker (403) — de klant ziet dan een zwarte
 * speler terwijl de kijkkopie gewoon werkt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GALLERY_ZIP_MAX_BYTES,
  browserCanPlayVideo,
  formatBytesShort,
  itemZippable,
  keyVariant,
  summarizeZip,
  videoPlaybackSource,
  zipBytes,
  zipCount,
  zipTooLarge,
  zipUrlForMedia,
  type GalleryMediaItem,
} from './galleryMedia.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const GAL = '22222222-2222-4222-8222-222222222222';
const key = (variant: string, name: string) => `${ORG}/gallery/${GAL}/item-1/${variant}-abc-${name}`;

function video(over: Partial<GalleryMediaItem> = {}): GalleryMediaItem {
  return {
    media_type: 'video',
    file_name: 'aftermovie.mp4',
    content_type: 'video/mp4',
    size_bytes: 700 * 1024 * 1024,
    storage_key: key('master', 'aftermovie.mp4'),
    preview_key: null,
    stream_uid: null,
    stream_status: null,
    stream_playback_base: null,
    ...over,
  };
}

function photo(over: Partial<GalleryMediaItem> = {}): GalleryMediaItem {
  return {
    media_type: 'photo',
    file_name: 'foto.jpg',
    content_type: 'image/jpeg',
    size_bytes: 8 * 1024 * 1024,
    storage_key: key('original', 'foto.jpg'),
    preview_key: key('preview', 'foto.jpg'),
    stream_uid: null,
    stream_status: null,
    stream_playback_base: null,
    ...over,
  };
}

test('keyVariant leest de variant vooraan in de bestandsnaam', () => {
  assert.equal(keyVariant(key('master', 'a-b-c.mp4')), 'master');
  assert.equal(keyVariant(key('preview', 'x.jpg')), 'preview');
  assert.equal(keyVariant('gal/orig/1.jpg'), '');
  assert.equal(keyVariant(null), '');
});

test('browserCanPlayVideo: containers die de browser aankan', () => {
  assert.equal(browserCanPlayVideo('a.mp4', 'video/mp4'), true);
  assert.equal(browserCanPlayVideo('a.mov', 'video/quicktime'), true);
  assert.equal(browserCanPlayVideo('a.webm', 'video/webm'), true);
  assert.equal(browserCanPlayVideo('a.mkv', 'video/x-matroska'), true);
  assert.equal(browserCanPlayVideo('a.avi', 'video/x-msvideo'), false);
  // Zonder (bruikbaar) type telt de extensie.
  assert.equal(browserCanPlayVideo('clip.MP4', null), true);
  assert.equal(browserCanPlayVideo('clip.mp4', 'application/octet-stream'), true);
  assert.equal(browserCanPlayVideo('clip.mts', undefined), false);
  assert.equal(browserCanPlayVideo('zonder-extensie', null), false);
});

test('videoPlaybackSource: kijkkopie wint, master alleen zonder kijkkopie', () => {
  const tokens = { uid1: 'tok' };
  const ready = video({ stream_uid: 'uid1', stream_status: 'ready', stream_playback_base: 'https://customer-x.cloudflarestream.com' });
  assert.equal(videoPlaybackSource(ready, tokens), 'stream');
  // Kijkkopie klaar maar geen token (bundel zonder Stream-tokens): dan niet de master.
  assert.equal(videoPlaybackSource(ready, {}), 'file', 'zonder token valt hij terug op het bestand');
  // Nog in verwerking of mislukt: de master speelt uit R2.
  assert.equal(videoPlaybackSource(video({ stream_uid: 'uid1', stream_status: 'processing' }), tokens), 'file');
  assert.equal(videoPlaybackSource(video({ stream_uid: 'uid1', stream_status: 'error' }), tokens), 'file');
  // Geen Stream ingericht: master uit R2.
  assert.equal(videoPlaybackSource(video(), {}), 'file');
  // De oude R2-fallback blijft afspeelbaar.
  assert.equal(videoPlaybackSource(video({ storage_key: key('source', 'oud.mp4') }), {}), 'file');
  // Een container die geen browser aankan: niet afspeelbaar.
  assert.equal(videoPlaybackSource(video({ file_name: 'band.avi', content_type: 'video/x-msvideo', storage_key: key('master', 'band.avi') }), {}), null);
  // Alleen bij Stream, nog niet klaar: niets om te spelen.
  assert.equal(videoPlaybackSource(video({ storage_key: null, stream_uid: 'uid1', stream_status: 'processing' }), tokens), null);
  assert.equal(videoPlaybackSource(photo(), {}), null);
});

test('itemZippable: foto via preview of origineel, video via bestand in R2', () => {
  assert.equal(itemZippable(photo()), true);
  assert.equal(itemZippable(photo({ preview_key: null })), true);
  assert.equal(itemZippable(photo({ preview_key: null, storage_key: null })), false);
  assert.equal(itemZippable(video()), true);
  assert.equal(itemZippable(video({ storage_key: key('source', 'oud.mp4') })), true);
  assert.equal(itemZippable(video({ storage_key: null, stream_uid: 'uid1', stream_status: 'ready' })), false);
});

test('summarizeZip telt per soort, met bytes en Stream-only video’s', () => {
  const summary = summarizeZip([
    photo(), photo({ size_bytes: 2 * 1024 * 1024 }),
    video(), video({ storage_key: null, stream_uid: 'uid1', stream_status: 'ready' }),
  ]);
  assert.equal(summary.photos, 2);
  assert.equal(summary.photoBytes, 10 * 1024 * 1024);
  assert.equal(summary.videos, 1);
  assert.equal(summary.videoBytes, 700 * 1024 * 1024);
  assert.equal(summary.streamOnlyVideos, 1);
  assert.equal(summary.bytesKnown, true);
  assert.equal(zipCount(summary, 'all'), 3);
  assert.equal(zipCount(summary, 'photos'), 2);
  assert.equal(zipCount(summary, 'videos'), 1);
  assert.equal(zipBytes(summary, 'all'), 710 * 1024 * 1024);
});

test('zipTooLarge: alleen met bekende groottes, en per keuze', () => {
  const big = summarizeZip([photo(), video({ size_bytes: GALLERY_ZIP_MAX_BYTES })]);
  assert.equal(zipTooLarge(big, 'all'), true);
  assert.equal(zipTooLarge(big, 'photos'), false);
  assert.equal(zipTooLarge(big, 'videos'), false, 'precies op de grens mag nog');
  // Oudere payload zonder size_bytes: niet gokken, de worker beslist.
  const unknown = summarizeZip([video({ size_bytes: undefined }), video({ size_bytes: GALLERY_ZIP_MAX_BYTES })]);
  assert.equal(unknown.bytesKnown, false);
  assert.equal(zipTooLarge(unknown, 'all'), false);
});

test('zipUrlForMedia zet de media-parameter naast het token', () => {
  const base = 'https://media.example.test/gallery/zip/gal-1?token=a.b';
  assert.equal(zipUrlForMedia(base, 'all'), base);
  assert.equal(zipUrlForMedia(base, 'photos'), `${base}&media=photos`);
  assert.equal(zipUrlForMedia(`${base}&media=photos`, 'videos'), `${base}&media=videos`);
});

test('formatBytesShort', () => {
  assert.equal(formatBytesShort(734003200), '700 MB');
  assert.equal(formatBytesShort(13314398618), '12.4 GB');
  assert.equal(formatBytesShort(2048), '2 kB');
  assert.equal(formatBytesShort(12), '12 B');
});
