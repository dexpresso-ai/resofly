// Krijgt de klant bij "Downloaden" echt het volledige bestand?
//
// Aanleiding: de vraag of de bestanden in de download wel de full-res
// originelen zijn. Deze test draait de echte worker (index.ts) met een
// nagebootste R2-bucket en Supabase, en vergelijkt byte voor byte wat er de
// deur uitgaat met wat er bij het uploaden in R2 is gezet. Gelijke bytes
// betekent: zelfde resolutie, zelfde kwaliteit, zelfde EXIF.
//
// De tokens komen langs dezelfde weg als op de deellinkpagina: de edge
// function gallery-public vraagt ze op bij /internal/gallery/tokens, en de
// worker leest downloadrecht en -kwaliteit uit de galerij zelf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import worker from './index.ts';
import { galleryObjectKey } from './galleryKeys.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const GAL = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const VIDEO = '44444444-4444-4444-8444-444444444444';
const INTERNAL = 'intern-geheim';

type Stored = { bytes: Uint8Array; type: string; name: string };

/** Willekeurige bytes met een JPEG-kop: de inhoud doet er niet toe, de gelijkheid wel. */
function fakeFile(size: number, head: number[]): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  bytes.set(head, 0);
  return bytes;
}

function key(item: string, variant: string, name: string): string {
  return galleryObjectKey({ organizationId: ORG, galleryId: GAL, itemId: item, variant, uuid: crypto.randomUUID(), fileName: name });
}

function setup(gallery: { allow_downloads: boolean; download_quality: 'original' | 'web' }) {
  // Een foto van 6000×4000 is al gauw 10 MB; 3 MB is genoeg om meerdere chunks
  // door de zip te laten lopen.
  const original = fakeFile(3 * 1024 * 1024 + 17, [0xff, 0xd8, 0xff, 0xe1]);
  const preview = fakeFile(400 * 1024, [0xff, 0xd8, 0xff, 0xe0]);
  const thumb = fakeFile(90 * 1024, [0xff, 0xd8, 0xff, 0xe0]);
  const master = fakeFile(2 * 1024 * 1024 + 5, [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);

  const keys = {
    original: key(PHOTO, 'original', 'DSC_0001.jpg'),
    preview: key(PHOTO, 'preview', 'preview-DSC_0001.jpg'),
    thumb: key(PHOTO, 'thumb', 'thumb-DSC_0001.jpg'),
    master: key(VIDEO, 'master', 'film.mp4'),
  };
  const objects = new Map<string, Stored>([
    [keys.original, { bytes: original, type: 'image/jpeg', name: 'DSC_0001.jpg' }],
    [keys.preview, { bytes: preview, type: 'image/jpeg', name: 'preview-DSC_0001.jpg' }],
    [keys.thumb, { bytes: thumb, type: 'image/jpeg', name: 'thumb-DSC_0001.jpg' }],
    [keys.master, { bytes: master, type: 'video/mp4', name: 'film.mp4' }],
  ]);

  const meta = (k: string, o: Stored) => ({
    key: k,
    size: o.bytes.length,
    httpEtag: `"${k.length}"`,
    httpMetadata: { contentType: o.type },
    customMetadata: { name: o.name },
    writeHttpMetadata: (h: Headers) => h.set('content-type', o.type),
  });
  const bucket = {
    async head(k: string) {
      const o = objects.get(k);
      return o ? meta(k, o) : null;
    },
    async get(k: string, opts?: { range?: { offset: number; length: number } }) {
      const o = objects.get(k);
      if (!o) return null;
      const bytes = opts?.range ? o.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length) : o.bytes;
      return { ...meta(k, o), body: new Blob([bytes]).stream() };
    },
  };

  const rows = [
    { id: PHOTO, file_name: 'DSC_0001.jpg', media_type: 'photo', size_bytes: original.length, storage_key: keys.original, preview_key: keys.preview, stream_uid: null },
    { id: VIDEO, file_name: 'film.mp4', media_type: 'video', size_bytes: master.length, storage_key: keys.master, preview_key: null, stream_uid: null },
  ];
  const galleryRow = { id: GAL, organization_id: ORG, title: 'Bruiloft', status: 'published', ...gallery };

  const env = {
    MEDIA_BUCKET: bucket,
    APP_ENV: 'staging',
    ALLOWED_ORIGINS: 'https://app.test',
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    INTERNAL_UPLOAD_SECRET: INTERNAL,
    MEDIA_SIGNING_SECRET: 'teken-geheim',
  };

  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined };

  async function call(path: string, init?: RequestInit): Promise<Response> {
    const realFetch = globalThis.fetch;
    // Alleen de PostgREST-vragen van de worker; verder gaat er niets het net op.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === '/rest/v1/galleries') return Response.json([galleryRow]);
      if (url.pathname === '/rest/v1/gallery_items') {
        return Response.json(url.searchParams.get('stream_uid') === 'not.is.null' ? [] : rows);
      }
      throw new Error(`Onverwachte fetch: ${url.href}`);
    }) as typeof fetch;
    try {
      const response = await worker.fetch(new Request(`https://media.test${path}`, init), env as any, ctx as any);
      // De body binnenhalen terwijl de nep-fetch nog staat: de zip leest R2 pas tijdens het streamen.
      const body = new Uint8Array(await response.arrayBuffer());
      await Promise.all(pending);
      return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  async function shareToken(): Promise<string> {
    // Precies de aanroep van gallery-public (fetchGalleryTokens).
    const res = await call('/internal/gallery/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: ORG, galleryId: GAL, allowDownload: true, ttlSeconds: 21600 }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as { mediaToken: string }).mediaToken;
  }

  const fileUrl = (k: string, token: string, download: boolean) =>
    `/gallery/file/${encodeURIComponent(k)}?token=${encodeURIComponent(token)}${download ? '&dl=1' : ''}`;
  const zipUrl = (token: string, media?: 'photos' | 'videos') =>
    `/gallery/zip/${GAL}?token=${encodeURIComponent(token)}${media ? `&media=${media}` : ''}`;

  return { call, shareToken, fileUrl, zipUrl, keys, original, preview, master };
}

/** Leest een zip zoals de worker hem schrijft (store, data descriptor, eventueel zip64). */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, 'zip zonder einde');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(p, true), 0x02014b50, 'centrale map kapot');
    assert.equal(view.getUint16(p + 10, true), 0, 'een bestand is gecomprimeerd of bewerkt');
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    assert.equal(crc32(data), crc, `CRC van ${name} klopt niet`);
    files.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function sameBytes(actual: Uint8Array, expected: Uint8Array, label: string) {
  assert.equal(actual.length, expected.length, `${label}: andere grootte (${actual.length} i.p.v. ${expected.length} bytes)`);
  assert.ok(Buffer.from(actual).equals(Buffer.from(expected)), `${label}: andere inhoud`);
}

test('downloaden op originele kwaliteit: de knop bij een foto geeft byte voor byte het origineel', async () => {
  const s = setup({ allow_downloads: true, download_quality: 'original' });
  const token = await s.shareToken();
  const res = await s.call(s.fileUrl(s.keys.original, token, true));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /^attachment; filename\*=UTF-8''DSC_0001\.jpg$/);
  sameBytes(new Uint8Array(await res.arrayBuffer()), s.original, 'foto');
});

test('downloaden op originele kwaliteit: de zip bevat de originelen en de video-master, onbewerkt', async () => {
  const s = setup({ allow_downloads: true, download_quality: 'original' });
  const token = await s.shareToken();
  const res = await s.call(s.zipUrl(token));
  assert.equal(res.status, 200);
  const files = readZip(new Uint8Array(await res.arrayBuffer()));
  assert.deepEqual([...files.keys()], ['DSC_0001.jpg', 'film.mp4']);
  sameBytes(files.get('DSC_0001.jpg')!, s.original, 'foto in de zip');
  sameBytes(files.get('film.mp4')!, s.master, 'video in de zip');

  const photos = readZip(new Uint8Array(await (await s.call(s.zipUrl(token, 'photos'))).arrayBuffer()));
  sameBytes(photos.get('DSC_0001.jpg')!, s.original, 'foto in de fotozip');
});

test('webkwaliteit: de zip geeft de webversie, en het origineel blijft dicht', async () => {
  const s = setup({ allow_downloads: true, download_quality: 'web' });
  const token = await s.shareToken();
  const files = readZip(new Uint8Array(await (await s.call(s.zipUrl(token))).arrayBuffer()));
  sameBytes(files.get('DSC_0001.jpg')!, s.preview, 'foto in de zip');
  // Video kent geen webversie: die gaat altijd als master mee.
  sameBytes(files.get('film.mp4')!, s.master, 'video in de zip');
  assert.equal((await s.call(s.fileUrl(s.keys.original, token, true))).status, 403);
});

test('downloaden uit: geen origineel en geen zip, ook niet met de sleutel uit de pagina', async () => {
  const s = setup({ allow_downloads: false, download_quality: 'original' });
  const token = await s.shareToken();
  assert.equal((await s.call(s.fileUrl(s.keys.original, token, true))).status, 403);
  assert.equal((await s.call(s.fileUrl(s.keys.original, token, false))).status, 403);
  assert.equal((await s.call(s.zipUrl(token))).status, 403);
  // Kijken blijft gewoon werken.
  assert.equal((await s.call(s.fileUrl(s.keys.preview, token, false))).status, 200);
});
