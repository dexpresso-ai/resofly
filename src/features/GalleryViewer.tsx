// Gedeelde galerij-weergave: hero, categoriechips, fotogrid, Netflix-achtige
// videorijen en lightbox. Wordt gebruikt door de beheer-tab in het project
// (app), de Galerijen-tab in het klantportaal en de publieke deellinkpagina.
// De component is puur presentationeel: media-URL's komen uit het meegegeven
// tokenbundel, favorieten en downloads lopen via callbacks van de host.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  category_id?: string | null;
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

export type GalleryViewerCategory = { id: string; name: string };

/** Opening van de galerij; `itemId` is de gekozen coverfoto (mag ontbreken). */
export type GalleryViewerHero = {
  template: string;
  title: string;
  description?: string | null;
  itemId?: string | null;
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

type GallerySection = {
  key: string;
  title: string | null;
  videos: GalleryViewerItem[];
  photos: GalleryViewerItem[];
};

export function GalleryViewer({
  items,
  bundle,
  allowDownload,
  format = 'hybrid',
  categories,
  hero,
  favorites,
  favoriteCounts,
  canFavorite,
  selectable = false,
  selected,
  onToggleSelect,
  onToggleFavorite,
  onDownloadItem,
  renderItemActions,
  emptyText = 'Nog geen media in deze galerij.',
}: {
  items: GalleryViewerItem[];
  bundle: GalleryTokenBundle | null;
  allowDownload: boolean;
  /** 'photo' = raster, 'video' = filmische tegels, 'hybrid' = video's boven de foto's. */
  format?: string;
  /** Categorieën in weergavevolgorde; leeg/afwezig = één doorlopende reeks. */
  categories?: GalleryViewerCategory[];
  /** Opening van de galerij; afwezig = meteen de media. */
  hero?: GalleryViewerHero | null;
  /** Item-id's die de huidige kijker als favoriet heeft gemarkeerd. */
  favorites?: Set<string>;
  /** Favoriet-tellingen per item (beheerweergave in de app). */
  favoriteCounts?: Map<string, number>;
  canFavorite: boolean;
  /** Selectiestand voor bulkacties in de beheerweergave. */
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (item: GalleryViewerItem) => void;
  onToggleFavorite?: (item: GalleryViewerItem, on: boolean) => void;
  onDownloadItem?: (item: GalleryViewerItem) => void;
  /** Extra beheer-acties per item (app: cover kiezen / verwijderen). */
  renderItemActions?: (item: GalleryViewerItem) => React.ReactNode;
  emptyText?: string;
}) {
  const videoOnly = format === 'video';
  const [lightbox, setLightbox] = useState<{ index: number } | null>(null);
  const [playing, setPlaying] = useState<GalleryViewerItem | null>(null);
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  // Items groeperen per categorie; wat geen (bestaande) categorie heeft valt
  // onderaan in "Overig". Zonder categorieën blijft het één doorlopende reeks.
  const sections = useMemo<GallerySection[]>(() => {
    const split = (list: GalleryViewerItem[]) => ({
      videos: list.filter(i => i.media_type === 'video'),
      photos: list.filter(i => i.media_type === 'photo'),
    });
    const cats = categories ?? [];
    if (cats.length === 0) return [{ key: 'all', title: null, ...split(items) }];

    const known = new Set(cats.map(c => c.id));
    const byCategory = new Map<string, GalleryViewerItem[]>();
    const loose: GalleryViewerItem[] = [];
    for (const item of items) {
      const id = item.category_id;
      if (id && known.has(id)) {
        const list = byCategory.get(id);
        if (list) list.push(item); else byCategory.set(id, [item]);
      } else {
        loose.push(item);
      }
    }
    const result: GallerySection[] = cats
      .filter(c => (byCategory.get(c.id)?.length ?? 0) > 0)
      .map(c => ({ key: c.id, title: c.name, ...split(byCategory.get(c.id) ?? []) }));
    if (loose.length > 0) {
      result.push({ key: 'overig', title: result.length > 0 ? 'Overig' : null, ...split(loose) });
    }
    return result;
  }, [items, categories]);

  // Eén doorlopende fotolijst in de volgorde waarin de kijker ze ziet, zodat
  // de pijltjes in de lightbox door de secties heen blijven kloppen.
  const orderedPhotos = useMemo(() => sections.flatMap(s => s.photos), [sections]);
  const photoIndexById = useMemo(() => {
    const map = new Map<string, number>();
    orderedPhotos.forEach((photo, index) => map.set(photo.id, index));
    return map;
  }, [orderedPhotos]);

  const chipSections = sections.filter(s => s.title);

  const closeOverlays = useCallback(() => { setLightbox(null); setPlaying(null); }, []);

  const stepLightbox = useCallback((delta: number) => {
    setLightbox(prev => {
      if (!prev || orderedPhotos.length === 0) return prev;
      return { index: (prev.index + delta + orderedPhotos.length) % orderedPhotos.length };
    });
  }, [orderedPhotos.length]);

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

  // Chip markeren op basis van welke sectie in beeld is.
  useEffect(() => {
    if (chipSections.length < 2) return;
    const nodes = chipSections.map(s => sectionRefs.current.get(s.key)).filter(Boolean) as HTMLElement[];
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActiveChip(visible.target.getAttribute('data-section') ?? null);
      },
      { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
    );
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [chipSections]);

  const openPhoto = (item: GalleryViewerItem) => {
    const index = photoIndexById.get(item.id);
    if (index != null) setLightbox({ index });
  };

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

  const tools = (item: GalleryViewerItem) => (
    <span className="galv-tile-tools">
      {heart(item)}
      {downloadBtn(item)}
      {renderItemActions?.(item)}
    </span>
  );

  const renderVideos = (list: GalleryViewerItem[]) => (
    <div className={videoOnly ? 'galv-video-grid' : 'galv-video-row'}>
      {list.map(item => {
        const thumb = itemThumbUrl(item, bundle);
        const playable = videoIsPlayable(item);
        const processing = item.stream_uid && item.stream_status !== 'ready' && item.stream_status !== 'error';
        const isSelected = selected?.has(item.id) ?? false;
        return (
          // Bewust een <div> met een aparte afspeelknop erin: als de kaart
          // zélf een (disabled) <button> is, ontvangen de knoppen erbinnen
          // geen clicks meer — en dan is juist een mislukte of nog
          // verwerkende video niet meer te verwijderen.
          <div
            key={item.id}
            className={`galv-video-card${playable ? '' : ' is-idle'}${isSelected ? ' is-selected' : ''}`}
            title={item.file_name}
          >
            {thumb
              ? <img className="galv-video-thumb" src={thumb} alt={item.file_name} loading="lazy" />
              : <div className="galv-video-thumb galv-video-thumb-empty"><Film size={26} /></div>}
            <span className="galv-video-shade" aria-hidden="true" />
            {selectable
              ? (
                <button
                  type="button"
                  className="galv-video-hit"
                  onClick={() => onToggleSelect?.(item)}
                  aria-label={`${item.file_name} selecteren`}
                  aria-pressed={isSelected}
                />
              )
              : playable && (
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
            {selectable && <span className={`galv-check${isSelected ? ' is-on' : ''}`} aria-hidden="true" />}
            {tools(item)}
          </div>
        );
      })}
    </div>
  );

  const renderPhotos = (list: GalleryViewerItem[]) => (
    <div className="galv-grid">
      {list.map(item => {
        const thumb = itemThumbUrl(item, bundle);
        const isSelected = selected?.has(item.id) ?? false;
        return (
          <figure
            key={item.id}
            className={`galv-tile${isSelected ? ' is-selected' : ''}`}
            onClick={() => (selectable ? onToggleSelect?.(item) : openPhoto(item))}
          >
            {thumb
              ? <img src={thumb} alt={item.file_name} loading="lazy" />
              : <div className="galv-tile-fallback">{item.file_name}</div>}
            {selectable && <span className={`galv-check${isSelected ? ' is-on' : ''}`} aria-hidden="true" />}
            {tools(item)}
          </figure>
        );
      })}
    </div>
  );

  return (
    <div className="galv">
      {hero && hero.template !== 'minimal' && (
        <GalleryHero hero={hero} items={items} bundle={bundle} onOpenPhoto={openPhoto} />
      )}
      {hero && hero.template === 'minimal' && (
        <header className="galv-hero galv-hero-minimal">
          <h2>{hero.title}</h2>
          {hero.description && <p>{hero.description}</p>}
        </header>
      )}

      {/* ── Categoriechips: springen naar de sectie ── */}
      {chipSections.length > 1 && (
        <nav className="galv-chips" aria-label="Categorieën">
          {chipSections.map(section => (
            <button
              key={section.key}
              type="button"
              className={`galv-chip${activeChip === section.key ? ' is-active' : ''}`}
              onClick={() => {
                const node = sectionRefs.current.get(section.key);
                node?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                setActiveChip(section.key);
              }}
            >
              {section.title}
              <span className="galv-chip-count">{section.videos.length + section.photos.length}</span>
            </button>
          ))}
        </nav>
      )}

      {sections.map(section => (
        <section
          key={section.key}
          className="galv-section"
          data-section={section.key}
          ref={(node) => {
            if (node) sectionRefs.current.set(section.key, node);
            else sectionRefs.current.delete(section.key);
          }}
        >
          {section.title && <h4 className="galv-section-title">{section.title}</h4>}
          {/* Zonder categorieën houden we de oude kopjes per mediasoort aan. */}
          {section.videos.length > 0 && (
            <>
              {!section.title && section.photos.length > 0 && (
                <h4 className="galv-section-title"><Film size={15} /> Video&apos;s</h4>
              )}
              {renderVideos(section.videos)}
            </>
          )}
          {section.photos.length > 0 && (
            <>
              {!section.title && section.videos.length > 0 && <h4 className="galv-section-title">Foto&apos;s</h4>}
              {renderPhotos(section.photos)}
            </>
          )}
        </section>
      ))}

      {/* ── Lightbox (foto's) ── */}
      {lightbox && orderedPhotos[lightbox.index] && (
        <div className="galv-lightbox" role="dialog" aria-modal="true" onClick={closeOverlays}>
          <button type="button" className="galv-lightbox-close" onClick={closeOverlays} aria-label="Sluiten"><X size={20} /></button>
          {orderedPhotos.length > 1 && (
            <button type="button" className="galv-lightbox-nav galv-prev" onClick={(e) => { e.stopPropagation(); stepLightbox(-1); }} aria-label="Vorige"><ChevronLeft size={26} /></button>
          )}
          <div className="galv-lightbox-stage" onClick={(e) => e.stopPropagation()}>
            <img src={itemPreviewUrl(orderedPhotos[lightbox.index], bundle) ?? undefined} alt={orderedPhotos[lightbox.index].file_name} />
            <div className="galv-lightbox-bar">
              <span className="galv-lightbox-name">{orderedPhotos[lightbox.index].file_name}</span>
              <span className="galv-lightbox-tools">
                {heart(orderedPhotos[lightbox.index])}
                {downloadBtn(orderedPhotos[lightbox.index])}
                <span className="galv-lightbox-count">{lightbox.index + 1} / {orderedPhotos.length}</span>
              </span>
            </div>
          </div>
          {orderedPhotos.length > 1 && (
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

/**
 * De opening van de galerij. `full` vult het beeld met de coverfoto, `split`
 * zet beeld en tekst naast elkaar, `collage` toont drie beelden. Ontbreekt er
 * een bruikbare foto, dan valt de hero terug op de ingetogen tekstvariant —
 * beter een rustige titel dan een gat.
 */
function GalleryHero({ hero, items, bundle, onOpenPhoto }: {
  hero: GalleryViewerHero;
  items: GalleryViewerItem[];
  bundle: GalleryTokenBundle;
  onOpenPhoto: (item: GalleryViewerItem) => void;
}) {
  const photos = items.filter(i => i.media_type === 'photo');
  const cover = (hero.itemId ? items.find(i => i.id === hero.itemId) : null) ?? photos[0] ?? items[0] ?? null;
  const coverUrl = cover ? itemPreviewUrl(cover, bundle) : null;

  if (!cover || !coverUrl) {
    return (
      <header className="galv-hero galv-hero-minimal">
        <h2>{hero.title}</h2>
        {hero.description && <p>{hero.description}</p>}
      </header>
    );
  }

  const openCover = () => { if (cover.media_type === 'photo') onOpenPhoto(cover); };

  if (hero.template === 'split') {
    return (
      <header className="galv-hero galv-hero-split">
        <div className="galv-hero-media" onClick={openCover}>
          <img src={coverUrl} alt={hero.title} />
        </div>
        <div className="galv-hero-text">
          <h2>{hero.title}</h2>
          {hero.description && <p>{hero.description}</p>}
        </div>
      </header>
    );
  }

  if (hero.template === 'collage') {
    const extras = photos.filter(p => p.id !== cover.id).slice(0, 2);
    return (
      <header className="galv-hero galv-hero-collage">
        <div className="galv-hero-collage-grid">
          <div className="galv-hero-media galv-hero-lead" onClick={openCover}>
            <img src={coverUrl} alt={hero.title} />
          </div>
          {extras.map(extra => {
            const url = itemPreviewUrl(extra, bundle);
            return url ? (
              <div key={extra.id} className="galv-hero-media" onClick={() => onOpenPhoto(extra)}>
                <img src={url} alt={extra.file_name} loading="lazy" />
              </div>
            ) : null;
          })}
        </div>
        <div className="galv-hero-text">
          <h2>{hero.title}</h2>
          {hero.description && <p>{hero.description}</p>}
        </div>
      </header>
    );
  }

  // 'full' — schermvullend beeld met de titel eroverheen.
  return (
    <header className="galv-hero galv-hero-full" onClick={openCover}>
      <img className="galv-hero-bg" src={coverUrl} alt={hero.title} />
      <span className="galv-hero-veil" aria-hidden="true" />
      <div className="galv-hero-text">
        <h2>{hero.title}</h2>
        {hero.description && <p>{hero.description}</p>}
      </div>
    </header>
  );
}
