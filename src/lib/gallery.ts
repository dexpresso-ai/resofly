// Galerij-oplevering: frontend-client voor de media-api worker (R2 + Cloudflare
// Stream) plus client-side beeldbewerking. Full-res gaat naar R2; voor snelle
// weergave genereert de browser bij het uploaden een web-preview en een thumbnail
// (canvas), zodat de server nooit hoeft te schalen. Video's gaan bij voorkeur
// rechtstreeks naar Cloudflare Stream (basic POST ≤ ~190 MB, anders tus); zonder
// Stream-configuratie meldt de worker 'r2' en uploaden we de video als bestand.
import { getAccessToken, getWorkerBase } from './r2-api';
import type { UUID } from '../types';

export type GalleryTokenBundle = { mediaToken: string; streamTokens: Record<string, string>; exp: number };

export type GalleryStreamStatusResult = {
  ok: true;
  ready: boolean;
  state: string;
  error: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  playbackBase: string | null;
};

/** Maximale grootte van een galerij-origineel (foto of video-fallback in R2). */
export const GALLERY_ORIGINAL_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Maximale grootte van een video-master. 30 GB is wat Cloudflare Stream
 * standaard accepteert; groter kunnen we wel bewaren maar dan is er geen
 * kijkkopie, en een galerij zonder afspeelbare video is geen oplevering.
 */
export const GALLERY_MASTER_MAX_BYTES = 30 * 1024 * 1024 * 1024;

/**
 * Boven deze grootte gaat een upload in parts. Een Cloudflare Worker neemt
 * maximaal ~100 MB per request aan; daarboven krijgt de browser een
 * Cloudflare-foutpagina in plaats van onze eigen melding. Moet gelijk blijven
 * aan GALLERY_SINGLE_REQUEST_MAX_BYTES in workers/media-api/src/index.ts.
 */
export const GALLERY_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** Fototypes die de browser kan decoderen voor preview-generatie. */
export const GALLERY_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Videotypes die we accepteren (Stream transcodeert vrijwel alles). */
export const GALLERY_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']);

async function errText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { error?: string };
    if (json?.error) return json.error;
  } catch { /* geen JSON */ }
  return text || `Fout ${response.status}`;
}

async function workerPost<T>(path: string, init: { headers?: Record<string, string>; body?: BodyInit; json?: unknown }): Promise<T> {
  const base = getWorkerBase();
  const token = await getAccessToken();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers || {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body });
  if (!response.ok) throw new Error(await errText(response));
  return (await response.json()) as T;
}

/** Kort-levende kijk-/downloadtokens voor teamleden (app-weergave). */
export async function createGalleryViewSession(organizationId: UUID, galleryId: UUID): Promise<GalleryTokenBundle> {
  return workerPost<GalleryTokenBundle>('/gallery/view-session', { json: { organizationId, galleryId } });
}

/**
 * Hoeveel milliseconden tot een tokenbundel ververst moet worden. Tokens leven
 * een uur; we vernieuwen ruim daarvoor zodat lopende weergaven (lightbox, lazy
 * geladen thumbnails, video) nooit stilletjes op een 403 stuiten.
 */
export function galleryRefreshDelayMs(bundle: GalleryTokenBundle | null): number | null {
  if (!bundle || typeof bundle.exp !== 'number') return null;
  const margin = 5 * 60 * 1000;
  return Math.max(15_000, bundle.exp - Date.now() - margin);
}

/** Directe media-URL voor <img>/<video> met het galerij-token in de query. */
export function galleryFileUrl(key: string, mediaToken: string, opts?: { download?: boolean }): string {
  const base = getWorkerBase();
  const dl = opts?.download ? '&dl=1' : '';
  return `${base}/gallery/file/${encodeURIComponent(key)}?token=${encodeURIComponent(mediaToken)}${dl}`;
}

/** Zip-download van de hele galerij (vereist een token met downloadrecht). */
export function galleryZipUrl(galleryId: UUID, mediaToken: string): string {
  const base = getWorkerBase();
  return `${base}/gallery/zip/${galleryId}?token=${encodeURIComponent(mediaToken)}`;
}

/**
 * Upload één variant van een galerij-item naar R2.
 * - `original` = full-res foto; de worker serveert die alleen met een token dat
 *   downloaden op originele kwaliteit toestaat.
 * - `source` = videobestand voor de R2-fallback; moet altijd afspeelbaar zijn.
 * - `preview` / `thumb` = client-side gegenereerde weergavebestanden.
 */
export type GalleryVariant = 'original' | 'master' | 'source' | 'preview' | 'thumb';

export async function uploadGalleryFileVariant(
  blob: Blob,
  fileName: string,
  contentType: string,
  organizationId: UUID,
  galleryId: UUID,
  itemId: UUID,
  variant: GalleryVariant,
): Promise<{ key: string; size: number }> {
  const result = await workerPost<{ ok: true; key: string; size: number }>('/gallery/upload', {
    headers: {
      'x-file-name': encodeURIComponent(fileName),
      'x-file-type': contentType || 'application/octet-stream',
      'x-organization-id': organizationId,
      'x-gallery-id': galleryId,
      'x-item-id': itemId,
      'x-variant': variant,
    },
    body: blob,
  });
  return { key: result.key, size: result.size };
}

/**
 * Upload een groot bestand in parts. Elk part gaat als eigen request langs de
 * Worker — die neemt maximaal ~100 MB per request aan — met eigen pogingen per
 * part: bij een master van 20 GB zijn dat ruim 300 requests over meer dan een
 * uur, en dan is één wifi-hik zonder herkansing gegarandeerd fataal.
 *
 * Mislukt het alsnog, dan breken we de multipart-upload af. R2 ruimt een
 * onvoltooide upload na zeven dagen zelf op, maar tot die tijd tellen de
 * geüploade parts wél mee in de opslagkosten.
 */
export async function uploadGalleryFileMultipart(
  blob: Blob,
  fileName: string,
  contentType: string,
  organizationId: UUID,
  galleryId: UUID,
  itemId: UUID,
  variant: Extract<GalleryVariant, 'master' | 'original' | 'source'>,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<{ key: string; size: number }> {
  const created = await workerPost<{ ok: true; key: string; uploadId: string; partSize: number }>(
    '/gallery/multipart/create',
    { json: { organizationId, galleryId, itemId, variant, fileName, contentType, fileSize: blob.size } },
  );
  const partSize = created.partSize > 0 ? created.partSize : GALLERY_MULTIPART_THRESHOLD_BYTES;
  const total = blob.size;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const base = getWorkerBase();
  let uploaded = 0;

  try {
    for (let offset = 0, partNumber = 1; offset < total; offset += partSize, partNumber += 1) {
      // slice() leest niets van schijf; pas bij het versturen wordt de range gelezen.
      const chunk = blob.slice(offset, Math.min(offset + partSize, total));
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          // Token per poging opnieuw: bij een upload van uren verloopt het anders halverwege.
          const token = await getAccessToken();
          const response = await fetch(`${base}/gallery/multipart/part`, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${token}`,
              'x-organization-id': organizationId,
              'x-gallery-id': galleryId,
              // Headers zijn ASCII-only; de key bevat de (mogelijk niet-ASCII) bestandsnaam.
              'x-key': encodeURIComponent(created.key),
              'x-upload-id': encodeURIComponent(created.uploadId),
              'x-part-number': String(partNumber),
            },
            body: chunk,
          });
          if (!response.ok) throw new Error(await errText(response));
          const result = (await response.json()) as { partNumber: number; etag: string };
          parts.push({ partNumber: result.partNumber, etag: result.etag });
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          // Oplopend wachten (1s, 2s, 4s): een korte onderbreking is dan voorbij.
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
      if (lastError) throw lastError;
      uploaded += chunk.size;
      onProgress?.(uploaded, total);
    }

    const done = await workerPost<{ ok: true; key: string; size: number }>('/gallery/multipart/complete', {
      json: { organizationId, galleryId, key: created.key, uploadId: created.uploadId, parts },
    });
    return { key: done.key, size: done.size };
  } catch (e) {
    await workerPost('/gallery/multipart/abort', {
      json: { organizationId, galleryId, key: created.key, uploadId: created.uploadId },
    }).catch(() => undefined);
    throw e;
  }
}

/** Kiest zelf tussen één request en multipart, op basis van de bestandsgrootte. */
export async function uploadGalleryFile(
  blob: Blob,
  fileName: string,
  contentType: string,
  organizationId: UUID,
  galleryId: UUID,
  itemId: UUID,
  variant: GalleryVariant,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<{ key: string; size: number }> {
  if (blob.size <= GALLERY_MULTIPART_THRESHOLD_BYTES) {
    const result = await uploadGalleryFileVariant(blob, fileName, contentType, organizationId, galleryId, itemId, variant);
    onProgress?.(result.size, result.size);
    return result;
  }
  if (variant !== 'master' && variant !== 'original' && variant !== 'source') {
    throw new Error('Alleen originelen en video-masters kunnen in delen worden geüpload.');
  }
  return uploadGalleryFileMultipart(blob, fileName, contentType, organizationId, galleryId, itemId, variant, onProgress);
}

export type GalleryStreamCopyResult = { ok: true; mode: 'r2' } | { ok: true; mode: 'stream'; uid: string };

/**
 * Laat Cloudflare Stream de al geüploade master uit R2 ophalen en er een
 * kijkkopie van maken. Zo uploadt de gebruiker één keer: R2 houdt het origineel
 * (dat de klant downloadt), Stream verzorgt het afspelen. `mode: 'r2'` betekent
 * dat Stream niet is geconfigureerd — de master staat er dan wel, maar er is
 * niets om af te spelen.
 */
export async function requestGalleryStreamCopy(
  organizationId: UUID,
  galleryId: UUID,
  key: string,
  fileName: string,
): Promise<GalleryStreamCopyResult> {
  return workerPost<GalleryStreamCopyResult>('/gallery/stream-copy', {
    json: { organizationId, galleryId, key, fileName },
  });
}

export async function getGalleryStreamStatus(organizationId: UUID, uid: string): Promise<GalleryStreamStatusResult> {
  return workerPost<GalleryStreamStatusResult>('/gallery/stream-status', { json: { organizationId, uid } });
}

export async function deleteGalleryStreamVideo(organizationId: UUID, uid: string): Promise<void> {
  await workerPost<{ ok: true }>('/gallery/stream-delete', { json: { organizationId, uid } });
}

// ── Client-side beeldbewerking ──────────────────────────────────────────────

const PREVIEW_MAX_EDGE = 2560;
/**
 * 1200 i.p.v. 480: het fotoraster toont justified rows tot ~290px hoog, en een
 * liggende foto is daar al gauw 500px breed — op een retina-scherm dus 1000
 * echte pixels. Met 480 werd de tegel zichtbaar opgeschaald. De viewer zet
 * bovendien een srcset, zodat grotere tegels de preview pakken.
 */
const THUMB_MAX_EDGE = 1200;

async function bitmapFromFile(file: Blob): Promise<ImageBitmap> {
  // 'from-image' respecteert de EXIF-orientatie van camera-JPEG's.
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    return createImageBitmap(file);
  }
}

function scaleToBlob(bitmap: ImageBitmap, maxEdge: number, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas niet beschikbaar.'));
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Preview genereren mislukt.'))),
      'image/jpeg',
      quality,
    );
  });
}

/** Genereer web-preview + thumbnail voor een foto (JPEG, client-side). */
export async function generateImageDerivatives(file: File): Promise<{ preview: Blob; thumb: Blob; width: number; height: number }> {
  const bitmap = await bitmapFromFile(file);
  try {
    const [preview, thumb] = await Promise.all([
      scaleToBlob(bitmap, PREVIEW_MAX_EDGE, 0.85),
      scaleToBlob(bitmap, THUMB_MAX_EDGE, 0.82),
    ]);
    return { preview, thumb, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Pak een poster-frame + metadata uit een videobestand (voor de R2-fallback en de tegel). */
export function captureVideoPoster(file: File): Promise<{ thumb: Blob | null; width: number | null; height: number | null; duration: number | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const done = (result: { thumb: Blob | null; width: number | null; height: number | null; duration: number | null }) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve(result);
    };
    const timeout = window.setTimeout(() => done({ thumb: null, width: null, height: null, duration: null }), 15000);
    video.onerror = () => { window.clearTimeout(timeout); done({ thumb: null, width: null, height: null, duration: null }); };
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      video.currentTime = duration ? Math.min(1, duration / 2) : 0;
    };
    video.onseeked = () => {
      window.clearTimeout(timeout);
      const width = video.videoWidth || null;
      const height = video.videoHeight || null;
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      const canvas = document.createElement('canvas');
      // Posterframe blijft klein: hij dient alleen als tegel, niet als preview.
      const scale = width && height ? Math.min(1, 720 / Math.max(width, height)) : 1;
      canvas.width = Math.max(1, Math.round((width || 1) * scale));
      canvas.height = Math.max(1, Math.round((height || 1) * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { done({ thumb: null, width, height, duration }); return; }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => done({ thumb: blob, width, height, duration }), 'image/jpeg', 0.8);
      } catch {
        done({ thumb: null, width, height, duration });
      }
    };
    video.src = url;
  });
}

/** Stream-thumbnail-URL met signed token (voor Netflix-tegels en hover). */
export function streamThumbnailUrl(playbackBase: string, streamToken: string, opts?: { time?: string; height?: number }): string {
  const params = new URLSearchParams();
  if (opts?.time) params.set('time', opts.time);
  if (opts?.height) params.set('height', String(opts.height));
  const query = params.toString();
  return `${playbackBase}/${streamToken}/thumbnails/thumbnail.jpg${query ? `?${query}` : ''}`;
}

/** Stream iframe-player-URL met signed token. */
export function streamIframeUrl(playbackBase: string, streamToken: string): string {
  return `${playbackBase}/${streamToken}/iframe`;
}

/** Stream MP4-download-URL met signed token (vereist downloadable-claim). */
export function streamDownloadUrl(playbackBase: string, streamToken: string): string {
  return `${playbackBase}/${streamToken}/downloads/default.mp4`;
}
