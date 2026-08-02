// Gedeelde galerij-weergave: fotogrid + Netflix-achtige videorijen + lightbox.
// Wordt gebruikt door de beheer-tab in het project (app), de Galerijen-tab in
// het klantportaal en de publieke deellinkpagina. De component is puur
// presentationeel: media-URL's komen uit het meegegeven tokenbundel, favorieten
// en downloads lopen via callbacks van de host.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Film, Heart, Play, X } from 'lucide-react';
import {
  galleryFileUrl,
  streamIframeUrl,
  streamThumbnailUrl,
  type GalleryTokenBundle,
} from '../lib/gallery';

/** Minimale item-vorm — zowel de app (GalleryItem) als het portaal (gesanitiseerd) passen hierin. */
export type GalleryViewerItem = {
  id: string;
  media_type: 'photo' | 'video';
  file_name: string;
  storage_key: string | null;
  preview_key: string | null;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  stream_uid: string | null;
  stream_status: string | null;
  stream_playback_base: string | null;
};

export function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function itemThumbUrl(item: GalleryViewerItem, bundle: GalleryTokenBundle): string | null {
  if (item.thumb_key) return galleryFileUrl(item.thumb_key, bundle.mediaToken);
  if (item.stream_uid && item.stream_playback_base && bundle.streamTokens[item.stream_uid]) {
    return streamThumbnailUrl(item.stream_playback_base, bundle.streamTokens[item.stream_uid], { height: 480 });
  }
  if (item.media_type === 'photo' && item.preview_key) return galleryFileUrl(item.preview_key, bundle.mediaToken);
  return null;
}

function itemPreviewUrl(item: GalleryViewerItem, bundle: GalleryTokenBundle): string | null {
  if (item.media_type === 'photo') {
    const key = item.preview_key || item.storage_key;
    return key ? galleryFileUrl(key, bundle.mediaToken) : null;
  }
  return itemThumbUrl(item, bundle);
}

export function GalleryViewer({
  items,
  bundle,
  allowDownload,
  favorites,
  favoriteCounts,
  canFavorite,
  onToggleFavorite,
  onDownloadItem,
  renderItemActions,
  emptyText = 'Nog geen media in deze galerij.',
}: {
  items: GalleryViewerItem[];
  bundle: GalleryTokenBundle | null;
  allowDownload: boolean;
  /** Item-id's die de huidige kijker als favoriet heeft gemarkeerd. */
  favorites?: Set<string>;
  /** Favoriet-tellingen per item (beheerweergave in de app). */
  favoriteCounts?: Map<string, number>;
  canFavorite: boolean;
  onToggleFavorite?: (item: GalleryViewerItem, on: boolean) => void;
  onDownloadItem?: (item: GalleryViewerItem) => void;
  /** Extra beheer-acties per item (app: cover kiezen / verwijderen). */
  renderItemActions?: (item: GalleryViewerItem) => React.ReactNode;
  emptyText?: string;
}) {
  const photos = useMemo(() => items.filter(i => i.media_type === 'photo'), [items]);
  const videos = useMemo(() => items.filter(i => i.media_type === 'video'), [items]);
  const [lightbox, setLightbox] = useState<{ index: number } | null>(null);
  const [playing, setPlaying] = useState<GalleryViewerItem | null>(null);

  const closeOverlays = useCallback(() => { setLightbox(null); setPlaying(null); }, []);

  const stepLightbox = useCallback((delta: number) => {
    setLightbox(prev => {
      if (!prev || photos.length === 0) return prev;
      return { index: (prev.index + delta + photos.length) % photos.length };
    });
  }, [photos.length]);

  useEffect(() => {
    if (!lightbox && !playing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverlays();
      if (lightbox && e.key === 'ArrowLeft') stepLightbox(-1);
      if (lightbox && e.key === 'ArrowRight') stepLightbox(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, playing, closeOverlays, stepLightbox]);

  if (items.length === 0) {
    return <div className="galv-empty">{emptyText}</div>;
  }
  if (!bundle) {
    return <div className="galv-empty">Galerij wordt geladen…</div>;
  }

  const heart = (item: GalleryViewerItem) => {
    const isFav = favorites?.has(item.id) ?? false;
    const count = favoriteCounts?.get(item.id) ?? 0;
    if (!canFavorite && count === 0 && !isFav) return null;
    return (
      <button
        type="button"
        className={`galv-heart${isFav ? ' is-fav' : ''}`}
        onClick={(e) => { e.stopPropagation(); if (canFavorite) onToggleFavorite?.(item, !isFav); }}
        disabled={!canFavorite}
        title={canFavorite ? (isFav ? 'Favoriet verwijderen' : 'Als favoriet markeren') : `${count} favoriet${count === 1 ? '' : 'en'}`}
        aria-pressed={isFav}
      >
        <Heart size={15} fill={isFav || count > 0 ? 'currentColor' : 'none'} />
        {count > 0 && <span className="galv-heart-count">{count}</span>}
      </button>
    );
  };

  const downloadBtn = (item: GalleryViewerItem) => {
    if (!allowDownload || !onDownloadItem) return null;
    const downloadable = Boolean(item.storage_key || item.preview_key
      || (item.stream_uid && item.stream_playback_base && bundle.streamTokens[item.stream_uid]));
    if (!downloadable) return null;
    return (
      <button
        type="button"
        className="galv-dl"
        onClick={(e) => { e.stopPropagation(); onDownloadItem(item); }}
        title="Downloaden"
      >
        <Download size={15} />
      </button>
    );
  };

  const videoIsPlayable = (item: GalleryViewerItem) =>
    (item.stream_uid && item.stream_status === 'ready' && item.stream_playback_base && bundle.streamTokens[item.stream_uid])
    || (!item.stream_uid && item.storage_key);

  return (
    <div className="galv">
      {/* ── Video's: Netflix-rij ── */}
      {videos.length > 0 && (
        <section className="galv-section">
          <h4 className="galv-section-title"><Film size={15} /> Video&apos;s</h4>
          <div className="galv-video-row">
            {videos.map(item => {
              const thumb = itemThumbUrl(item, bundle);
              const playable = videoIsPlayable(item);
              const processing = item.stream_uid && item.stream_status !== 'ready' && item.stream_status !== 'error';
              return (
                // Bewust een <div> met een aparte afspeelknop erin: als de kaart
                // zélf een (disabled) <button> is, ontvangen de knoppen erbinnen
                // geen clicks meer — en dan is juist een mislukte of nog
                // verwerkende video niet meer te verwijderen.
                <div key={item.id} className={`galv-video-card${playable ? '' : ' is-idle'}`} title={item.file_name}>
                  {thumb
                    ? <img className="galv-video-thumb" src={thumb} alt={item.file_name} loading="lazy" />
                    : <div className="galv-video-thumb galv-video-thumb-empty"><Film size={26} /></div>}
                  <span className="galv-video-shade" aria-hidden="true" />
                  {playable && (
                    <button
                      type="button"
                      className="galv-video-hit"
                      onClick={() => setPlaying(item)}
                      aria-label={`${item.file_name} afspelen`}
                    >
                      <span className="galv-video-play"><Play size={22} fill="currentColor" /></span>
                    </button>
                  )}
                  {processing && <span className="galv-video-processing">Verwerken…</span>}
                  {item.stream_status === 'error' && <span className="galv-video-processing galv-video-error">Verwerkingsfout</span>}
                  <span className="galv-video-meta">
                    <span className="galv-video-name">{item.file_name.replace(/\.[A-Za-z0-9]+$/, '')}</span>
                    {formatDuration(item.duration_seconds) && <span className="galv-video-dur">{formatDuration(item.duration_seconds)}</span>}
                  </span>
                  <span className="galv-tile-tools">
                    {heart(item)}
                    {downloadBtn(item)}
                    {renderItemActions?.(item)}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Foto's: grid ── */}
      {photos.length > 0 && (
        <section className="galv-section">
          {videos.length > 0 && <h4 className="galv-section-title">Foto&apos;s</h4>}
          <div className="galv-grid">
            {photos.map((item, index) => {
              const thumb = itemThumbUrl(item, bundle);
              return (
                <figure key={item.id} className="galv-tile" onClick={() => setLightbox({ index })}>
                  {thumb
                    ? <img src={thumb} alt={item.file_name} loading="lazy" />
                    : <div className="galv-tile-fallback">{item.file_name}</div>}
                  <span className="galv-tile-tools">
                    {heart(item)}
                    {downloadBtn(item)}
                    {renderItemActions?.(item)}
                  </span>
                </figure>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Lightbox (foto's) ── */}
      {lightbox && photos[lightbox.index] && (
        <div className="galv-lightbox" role="dialog" aria-modal="true" onClick={closeOverlays}>
          <button type="button" className="galv-lightbox-close" onClick={closeOverlays} aria-label="Sluiten"><X size={20} /></button>
          {photos.length > 1 && (
            <button type="button" className="galv-lightbox-nav galv-prev" onClick={(e) => { e.stopPropagation(); stepLightbox(-1); }} aria-label="Vorige"><ChevronLeft size={26} /></button>
          )}
          <div className="galv-lightbox-stage" onClick={(e) => e.stopPropagation()}>
            <img src={itemPreviewUrl(photos[lightbox.index], bundle) ?? undefined} alt={photos[lightbox.index].file_name} />
            <div className="galv-lightbox-bar">
              <span className="galv-lightbox-name">{photos[lightbox.index].file_name}</span>
              <span className="galv-lightbox-tools">
                {heart(photos[lightbox.index])}
                {downloadBtn(photos[lightbox.index])}
                <span className="galv-lightbox-count">{lightbox.index + 1} / {photos.length}</span>
              </span>
            </div>
          </div>
          {photos.length > 1 && (
            <button type="button" className="galv-lightbox-nav galv-next" onClick={(e) => { e.stopPropagation(); stepLightbox(1); }} aria-label="Volgende"><ChevronRight size={26} /></button>
          )}
        </div>
      )}

      {/* ── Videospeler (Stream-iframe of native <video> voor R2-fallback) ── */}
      {playing && (
        <div className="galv-lightbox galv-player" role="dialog" aria-modal="true" onClick={closeOverlays}>
          <button type="button" className="galv-lightbox-close" onClick={closeOverlays} aria-label="Sluiten"><X size={20} /></button>
          <div className="galv-player-stage" onClick={(e) => e.stopPropagation()}>
            {playing.stream_uid && playing.stream_playback_base && bundle.streamTokens[playing.stream_uid]
              ? (
                <iframe
                  className="galv-player-frame"
                  src={streamIframeUrl(playing.stream_playback_base, bundle.streamTokens[playing.stream_uid])}
                  title={playing.file_name}
                  allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              )
              : playing.storage_key
                ? (
                  <video
                    className="galv-player-video"
                    src={galleryFileUrl(playing.storage_key, bundle.mediaToken)}
                    controls
                    autoPlay
                    playsInline
                  />
                )
                : <div className="galv-empty">Deze video is nog niet afspeelbaar.</div>}
            <div className="galv-lightbox-bar">
              <span className="galv-lightbox-name">{playing.file_name}</span>
              <span className="galv-lightbox-tools">
                {heart(playing)}
                {downloadBtn(playing)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
