// Galerij: de pure regels over afspelen en downloaden — zonder React, netwerk
// of omgevingsvariabelen, zodat ze in node te testen zijn (galleryMedia.test.ts).
// De viewer en het downloadmenu leunen hierop; de media-api worker dwingt
// dezelfde regels server-side af (handleGalleryFile, handleGalleryZip).

/**
 * Wat er maximaal in één zip past. De worker streamt elk bestand door zijn
 * CRC32-lus en mag daar vijf minuten CPU aan besteden; boven deze grens
 * weigert hij met een 413. Het menu schakelt de knop daarom al uit vóórdat
 * de klant een halve zip binnenhaalt. Moet gelijk blijven aan
 * GALLERY_ZIP_MAX_BYTES in workers/media-api/src/index.ts.
 */
export const GALLERY_ZIP_MAX_BYTES = 150 * 1024 * 1024 * 1024;

/** Welke soort media de zip bevat; komt overeen met `?media=` op de zip-route. */
export type GalleryZipMedia = 'all' | 'photos' | 'videos';

/**
 * Minimale item-vorm. `content_type` en `size_bytes` zijn optioneel: het
 * portaal en de deellink kregen die pas op 2026-09-19 mee, en een oudere
 * edge function levert ze nog niet. Alles hieronder werkt ook zonder.
 */
export type GalleryMediaItem = {
  media_type: 'photo' | 'video';
  file_name: string;
  content_type?: string | null;
  size_bytes?: number | null;
  storage_key: string | null;
  preview_key: string | null;
  stream_uid: string | null;
  stream_status: string | null;
  stream_playback_base: string | null;
};

/**
 * De variant staat vooraan in de bestandsnaam van de R2-key
 * (`{variant}-{uuid}-{naam}`). `original` = full-res foto, `master` = het
 * originele videobestand, `source` = de oude R2-fallbackvideo, `preview` en
 * `thumb` = weergavebestanden.
 */
export function keyVariant(key: string | null | undefined): string {
  if (!key) return '';
  const fileName = key.slice(key.lastIndexOf('/') + 1);
  const dash = fileName.indexOf('-');
  return dash > 0 ? fileName.slice(0, dash) : '';
}

/**
 * Containers die browsers progressief kunnen afspelen via <video>. Dit gaat
 * over de verpakking, niet over de codec: een .mov met ProRes of een HEVC-mp4
 * op een Windows-Chrome komt hier doorheen en strandt pas in de speler — die
 * vangt dat op met een melding en de downloadknop. Andersom is zekerder:
 * .avi, .mts of .mxf speelt geen enkele browser, dus die krijgen meteen
 * "alleen downloaden".
 */
const PLAYABLE_VIDEO_TYPES = new Set([
  'video/mp4', 'video/x-m4v', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/matroska',
]);
const PLAYABLE_VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv']);

export function browserCanPlayVideo(fileName: string, contentType?: string | null): boolean {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/octet-stream') return PLAYABLE_VIDEO_TYPES.has(type);
  const dot = fileName.lastIndexOf('.');
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return PLAYABLE_VIDEO_EXTENSIONS.has(ext);
}

/** Heeft dit item een speelklare kijkkopie bij Stream waarvoor we een token hebben? */
export function hasStreamPlayback(item: GalleryMediaItem, streamTokens: Record<string, string>): boolean {
  return Boolean(
    item.stream_uid && item.stream_status === 'ready' && item.stream_playback_base && streamTokens[item.stream_uid],
  );
}

/**
 * Waar speelt deze video vandaan?
 * - 'stream': de kijkkopie bij Cloudflare Stream (adaptief, tot 1080p);
 * - 'file': rechtstreeks uit R2 — de oude `source`-variant, of de `master`
 *   zolang er geen kijkkopie is (Stream niet ingericht, mislukt, of nog bezig);
 * - null: niet afspeelbaar in een browser.
 *
 * De worker houdt dezelfde volgorde aan: een kijk-token krijgt de master
 * alleen inline zolang de kijkkopie er niet is.
 */
export function videoPlaybackSource(item: GalleryMediaItem, streamTokens: Record<string, string>): 'stream' | 'file' | null {
  if (item.media_type !== 'video') return null;
  if (hasStreamPlayback(item, streamTokens)) return 'stream';
  if (!item.storage_key) return null;
  const variant = keyVariant(item.storage_key);
  if (variant === 'source') return 'file';
  if (variant === 'master') return browserCanPlayVideo(item.file_name, item.content_type) ? 'file' : null;
  return null;
}

/** Kan dit item in de zip? Foto's via preview of origineel, video's via de master of source in R2. */
export function itemZippable(item: GalleryMediaItem): boolean {
  if (item.media_type === 'photo') return Boolean(item.preview_key || item.storage_key);
  return Boolean(item.storage_key);
}

export type GalleryZipSummary = {
  photos: number;
  photoBytes: number;
  videos: number;
  videoBytes: number;
  /** Video's zonder bestand in R2 (alleen bij Stream): die zitten niet in de zip. */
  streamOnlyVideos: number;
  /** Van elk geteld item is de grootte bekend; anders is een schatting onbetrouwbaar. */
  bytesKnown: boolean;
};

/**
 * Wat er in de zip zou gaan, per mediasoort. De bytes zijn die van de
 * originelen; bij webkwaliteit zijn de foto's in werkelijkheid kleiner.
 */
export function summarizeZip(items: GalleryMediaItem[]): GalleryZipSummary {
  const summary: GalleryZipSummary = { photos: 0, photoBytes: 0, videos: 0, videoBytes: 0, streamOnlyVideos: 0, bytesKnown: true };
  for (const item of items) {
    if (!itemZippable(item)) {
      if (item.media_type === 'video') summary.streamOnlyVideos += 1;
      continue;
    }
    const bytes = typeof item.size_bytes === 'number' && Number.isFinite(item.size_bytes) && item.size_bytes >= 0
      ? item.size_bytes
      : null;
    if (bytes == null) summary.bytesKnown = false;
    if (item.media_type === 'photo') {
      summary.photos += 1;
      summary.photoBytes += bytes ?? 0;
    } else {
      summary.videos += 1;
      summary.videoBytes += bytes ?? 0;
    }
  }
  return summary;
}

/** Aantal bytes in de zip voor deze keuze. */
export function zipBytes(summary: GalleryZipSummary, media: GalleryZipMedia): number {
  if (media === 'photos') return summary.photoBytes;
  if (media === 'videos') return summary.videoBytes;
  return summary.photoBytes + summary.videoBytes;
}

/** Aantal bestanden in de zip voor deze keuze. */
export function zipCount(summary: GalleryZipSummary, media: GalleryZipMedia): number {
  if (media === 'photos') return summary.photos;
  if (media === 'videos') return summary.videos;
  return summary.photos + summary.videos;
}

/** Zou de worker deze zip weigeren? Zonder bekende groottes gokken we niet en laten we hem toe. */
export function zipTooLarge(summary: GalleryZipSummary, media: GalleryZipMedia): boolean {
  return summary.bytesKnown && zipBytes(summary, media) > GALLERY_ZIP_MAX_BYTES;
}

/** De zip-URL van de hele galerij, beperkt tot één mediasoort. */
export function zipUrlForMedia(zipUrl: string, media: GalleryZipMedia): string {
  if (media === 'all') return zipUrl;
  const url = new URL(zipUrl);
  url.searchParams.set('media', media);
  return url.toString();
}

/** "12.4 GB" / "734 MB" — dezelfde weergave als de opslagmeter in de galerij. */
export function formatBytesShort(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}
