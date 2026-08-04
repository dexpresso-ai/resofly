// Gedeelde galerij-weergave: hero, categoriechips, fotogrid, Netflix-achtige
// videorijen en lightbox. Wordt gebruikt door de beheer-tab in het project
// (app), de Galerijen-tab in het klantportaal en de publieke deellinkpagina.
// De component is puur presentationeel: media-URL's komen uit het meegegeven
// tokenbundel, favorieten en downloads lopen via callbacks van de host.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Film, Heart, Menu, Play, ThumbsUp, X } from 'lucide-react';
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

/**
 * Laat de browser zelf de scherpste variant kiezen. We kennen de weergavebreedte
 * exact (rijhoogte × beeldverhouding), dus met `sizes` erbij pakt hij de
 * thumbnail bij kleine tegels en de preview bij grote — ook op retina.
 */
function photoSrcSet(item: GalleryViewerItem, bundle: GalleryTokenBundle): string | undefined {
  if (item.media_type !== 'photo') return undefined;
  const parts: string[] = [];
  if (item.thumb_key) parts.push(`${galleryFileUrl(item.thumb_key, bundle.mediaToken)} 1200w`);
  if (item.preview_key) parts.push(`${galleryFileUrl(item.preview_key, bundle.mediaToken)} 2560w`);
  return parts.length > 1 ? parts.join(', ') : undefined;
}

/**
 * Kleinste bruikbare afbeelding van een item. Ook de beheerschermen (het
 * indelen van bestanden in categorieën) tonen deze miniatuur, vandaar de export:
 * één plek die weet welke variant er bestaat.
 */
export function galleryItemThumbUrl(item: GalleryViewerItem, bundle: GalleryTokenBundle): string | null {
  if (item.thumb_key) return galleryFileUrl(item.thumb_key, bundle.mediaToken);
  if (item.stream_uid && item.stream_playback_base && bundle.streamTokens[item.stream_uid]) {
    return streamThumbnailUrl(item.stream_playback_base, bundle.streamTokens[item.stream_uid], { height: 480 });
  }
  if (item.media_type === 'photo' && item.preview_key) return galleryFileUrl(item.preview_key, bundle.mediaToken);
  return null;
}

/**
 * De variant staat vooraan in de bestandsnaam van de R2-key
 * (`{variant}-{uuid}-{naam}`). `master` = het originele videobestand dat de
 * klant downloadt; dat is nadrukkelijk géén afspeelbaar bestand, en het zit ook
 * niet in de zip. Geëxporteerd omdat alle drie de weergaven ermee bepalen of er
 * iets te zippen valt.
 */
export function keyVariant(key: string | null | undefined): string {
  if (!key) return '';
  const fileName = key.slice(key.lastIndexOf('/') + 1);
  const dash = fileName.indexOf('-');
  return dash > 0 ? fileName.slice(0, dash) : '';
}

/**
 * Zit er iets in de zip? Video-masters laat de worker er bewust uit — tientallen
 * gigabytes door zijn CRC32-lus halen loopt over de CPU-limiet. Een galerij met
 * alleen video's levert dus een lege zip (en een 404), en dan hoort de knop er
 * niet te staan.
 */
export function hasZippableItems(items: Array<{ storage_key: string | null; preview_key: string | null }>): boolean {
  return items.some(item =>
    Boolean(item.preview_key) || (Boolean(item.storage_key) && keyVariant(item.storage_key) !== 'master'));
}

/**
 * Kan deze video hier afspelen? Via de Stream-kijkkopie, of — voor video's van
 * vóór die kopie — rechtstreeks uit R2 onder de variant `source`. Een `master`
 * telt niet mee: dat is het archiefbestand voor de download, tientallen
 * gigabytes in een codec die geen browser aankan.
 */
function videoPlayable(item: GalleryViewerItem, bundle: GalleryTokenBundle): boolean {
  return Boolean(
    (item.stream_uid && item.stream_status === 'ready' && item.stream_playback_base && bundle.streamTokens[item.stream_uid])
    || (!item.stream_uid && keyVariant(item.storage_key) === 'source'),
  );
}

function itemPreviewUrl(item: GalleryViewerItem, bundle: GalleryTokenBundle): string | null {
  if (item.media_type === 'photo') {
    const key = item.preview_key || item.storage_key;
    return key ? galleryFileUrl(key, bundle.mediaToken) : null;
  }
  return galleryItemThumbUrl(item, bundle);
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
  likes,
  likeCounts,
  canLike = false,
  onToggleLike,
  selectable = false,
  selected,
  onToggleSelect,
  reorderable = false,
  onReorder,
  onToggleFavorite,
  onDownloadItem,
  zipUrl,
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
  /** Likes: eigen likes, de zichtbare teller, en of deze kijker mag liken. */
  likes?: Set<string>;
  likeCounts?: Map<string, number>;
  canLike?: boolean;
  onToggleLike?: (item: GalleryViewerItem, on: boolean) => void;
  /** Selectiestand voor bulkacties in de beheerweergave. */
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (item: GalleryViewerItem) => void;
  /** Sleepstand: foto's herschikken in de beheerweergave. */
  reorderable?: boolean;
  /** `movedId` wordt vóór `targetId` geplaatst. */
  onReorder?: (movedId: string, targetId: string) => void;
  onToggleFavorite?: (item: GalleryViewerItem, on: boolean) => void;
  onDownloadItem?: (item: GalleryViewerItem) => void;
  /** Zip-download van de hele galerij; afwezig = geen hamburger. */
  zipUrl?: string;
  /** Extra beheer-acties per item (app: cover kiezen / verwijderen). */
  renderItemActions?: (item: GalleryViewerItem) => React.ReactNode;
  emptyText?: string;
}) {
  const videoOnly = format === 'video';
  const [lightbox, setLightbox] = useState<{ index: number } | null>(null);
  const [playing, setPlaying] = useState<GalleryViewerItem | null>(null);
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const dragItemId = useRef<string | null>(null);

  /** De filmische opening: één kopvideo groot in beeld, de rest in rijen eronder. */
  const billboard = hero?.template === 'netflix';

  /**
   * Het item dat de opening vult. Bij de filmische opening is dat bij voorkeur
   * een video — anders zou een fotogalerij-achtige cover de kop stil houden.
   */
  const heroItem = useMemo<GalleryViewerItem | null>(() => {
    if (!hero) return null;
    const chosen = hero.itemId ? items.find(i => i.id === hero.itemId) : null;
    if (chosen) return chosen;
    const preferred = billboard
      ? items.find(i => i.media_type === 'video')
      : items.find(i => i.media_type === 'photo');
    return preferred ?? items[0] ?? null;
  }, [hero, items, billboard]);

  /**
   * De kopvideo staat al bovenaan; hem nóg een keer in de rijen tonen leest als
   * een fout. Een foto-cover blijft wél in het raster staan — die is klein en
   * hoort bij de reeks.
   */
  const hiddenItemId = billboard && heroItem?.media_type === 'video' ? heroItem.id : null;
  const sectionSource = useMemo(
    () => (hiddenItemId ? items.filter(i => i.id !== hiddenItemId) : items),
    [items, hiddenItemId],
  );

  // Items groeperen per categorie; wat geen (bestaande) categorie heeft valt
  // onderaan in "Overig". Zonder categorieën blijft het één doorlopende reeks.
  const sections = useMemo<GallerySection[]>(() => {
    const split = (list: GalleryViewerItem[]) => ({
      videos: list.filter(i => i.media_type === 'video'),
      photos: list.filter(i => i.media_type === 'photo'),
    });
    const cats = categories ?? [];
    if (cats.length === 0) return [{ key: 'all', title: null, ...split(sectionSource) }];

    const known = new Set(cats.map(c => c.id));
    const byCategory = new Map<string, GalleryViewerItem[]>();
    const loose: GalleryViewerItem[] = [];
    for (const item of sectionSource) {
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
  }, [sectionSource, categories]);

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

  const videoIsPlayable = (item: GalleryViewerItem) => videoPlayable(item, bundle);

  /** Video met een master in R2 maar (nog) geen kijkkopie bij Stream. */
  const videoIsDownloadOnly = (item: GalleryViewerItem) =>
    item.media_type === 'video' && !item.stream_uid && keyVariant(item.storage_key) === 'master';

  /**
   * De like is de zichtbare waardering: de teller staat er altijd bij zodra
   * iemand geliket heeft, ook voor kijkers die zelf niet mogen reageren (de
   * beeldmaker ziet zo in één oogopslag wat aanslaat).
   */
  const likeBtn = (item: GalleryViewerItem) => {
    const isLiked = likes?.has(item.id) ?? false;
    const count = likeCounts?.get(item.id) ?? 0;
    if (!canLike && count === 0) return null;
    return (
      <button
        type="button"
        className={`galv-like${isLiked ? ' is-on' : ''}`}
        onClick={(e) => { e.stopPropagation(); if (canLike) onToggleLike?.(item, !isLiked); }}
        disabled={!canLike}
        title={canLike ? (isLiked ? 'Like weghalen' : 'Like deze foto') : `${count} like${count === 1 ? '' : 's'}`}
        aria-pressed={isLiked}
      >
        <ThumbsUp size={14} fill={isLiked ? 'currentColor' : 'none'} />
        {count > 0 && <span className="galv-like-count">{count}</span>}
      </button>
    );
  };

  const tools = (item: GalleryViewerItem) => (
    <span className="galv-tile-tools">
      {likeBtn(item)}
      {heart(item)}
      {downloadBtn(item)}
      {renderItemActions?.(item)}
    </span>
  );

  // Bij de filmische opening staat alles in rijen — ook een videogalerij, die
  // anders een raster zou tonen: rijen zijn juist wat die opening aankondigt.
  const videoLayout: 'row' | 'grid' = billboard ? 'row' : videoOnly ? 'grid' : 'row';

  const renderVideoCards = (list: GalleryViewerItem[]) => (
    <>
      {list.map(item => {
        const thumb = galleryItemThumbUrl(item, bundle);
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
            {videoIsDownloadOnly(item) && <span className="galv-video-processing">Alleen downloaden</span>}
            <span className="galv-video-meta">
              <span className="galv-video-name">{item.file_name.replace(/\.[A-Za-z0-9]+$/, '')}</span>
              {formatDuration(item.duration_seconds) && <span className="galv-video-dur">{formatDuration(item.duration_seconds)}</span>}
            </span>
            {selectable && <span className={`galv-check${isSelected ? ' is-on' : ''}`} aria-hidden="true" />}
            {tools(item)}
          </div>
        );
      })}
    </>
  );

  const renderVideos = (list: GalleryViewerItem[]) => (
    videoLayout === 'grid'
      ? <div className="galv-video-grid">{renderVideoCards(list)}</div>
      : <VideoRow>{renderVideoCards(list)}</VideoRow>
  );

  const renderPhotos = (list: GalleryViewerItem[]) => (
    <JustifiedPhotos
      photos={list}
      renderTile={(item, style, displayWidth) => {
        const thumb = galleryItemThumbUrl(item, bundle);
        const isSelected = selected?.has(item.id) ?? false;
        return (
          <figure
            key={item.id}
            className={`galv-tile${isSelected ? ' is-selected' : ''}${reorderable ? ' is-draggable' : ''}`}
            style={style}
            draggable={reorderable}
            onDragStart={reorderable ? () => { dragItemId.current = item.id; } : undefined}
            onDragOver={reorderable ? (e) => e.preventDefault() : undefined}
            onDrop={reorderable ? (e) => {
              e.preventDefault();
              const from = dragItemId.current;
              dragItemId.current = null;
              if (from && from !== item.id) onReorder?.(from, item.id);
            } : undefined}
            onClick={() => {
              if (reorderable) return;
              if (selectable) onToggleSelect?.(item); else openPhoto(item);
            }}
          >
            {thumb
              ? (
                <img
                  src={thumb}
                  srcSet={photoSrcSet(item, bundle)}
                  sizes={`${Math.round(displayWidth)}px`}
                  alt={item.file_name}
                  loading="lazy"
                />
              )
              : <div className="galv-tile-fallback">{item.file_name}</div>}
            {selectable && <span className={`galv-check${isSelected ? ' is-on' : ''}`} aria-hidden="true" />}
            {tools(item)}
          </figure>
        );
      }}
    />
  );

  return (
    <div className="galv">
      {allowDownload && zipUrl && (hasZippableItems(items) || items.some(i => i.media_type === 'video')) && (
        <GalleryDownloadMenu
          zipUrl={zipUrl}
          zippable={hasZippableItems(items)}
          videoCount={items.filter(i => i.media_type === 'video').length}
        />
      )}
      {billboard && heroItem && hero && (
        <GalleryBillboard
          hero={hero}
          item={heroItem}
          bundle={bundle}
          allowDownload={allowDownload && Boolean(onDownloadItem)}
          onPlay={(item) => { if (item.media_type === 'video') setPlaying(item); else openPhoto(item); }}
          onDownload={onDownloadItem}
        />
      )}
      {!billboard && hero && hero.template !== 'minimal' && (
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
          className={`galv-section${billboard ? ' galv-section-billboard' : ''}`}
          data-section={section.key}
          ref={(node) => {
            if (node) sectionRefs.current.set(section.key, node);
            else sectionRefs.current.delete(section.key);
          }}
        >
          {section.title && (
            billboard
              ? <h3 className="galv-row-title">{section.title}</h3>
              : <h4 className="galv-section-title">{section.title}</h4>
          )}
          {/* Zonder categorieën houden we de oude kopjes per mediasoort aan. */}
          {section.videos.length > 0 && (
            <>
              {/* Een rij zonder kop leest als een gat. Staat er geen categorie
                  boven, dan benoemen we hem naar wat hij is: de rest. */}
              {!section.title && billboard && (
                <h3 className="galv-row-title">
                  {hiddenItemId ? 'Overige video’s' : 'Video’s'}
                </h3>
              )}
              {!section.title && !billboard && section.photos.length > 0 && (
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
                {likeBtn(orderedPhotos[lightbox.index])}
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
              : keyVariant(playing.storage_key) === 'source' && playing.storage_key
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
                {likeBtn(playing)}
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

// ── Downloadmenu: één doorzichtige hamburger over de opening ────────────────
//
// De knop "alles als zip" stond in de kopbalk van elk van de drie weergaven en
// nam daar een hele regel in beslag. Hij zit nu onder deze hamburger, zodat de
// opening de volle breedte krijgt. Losse bestanden download je niet hier maar
// op het bestand zelf — dat schaalt, een menu met 500 regels niet.

function GalleryDownloadMenu({ zipUrl, zippable, videoCount }: {
  zipUrl: string;
  zippable: boolean;
  videoCount: number;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // mousedown i.p.v. click: anders sluit het menu pas ná de klik en vangt een
    // element eronder die klik alsnog op.
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="galv-menu" ref={boxRef}>
      <button
        type="button"
        className="galv-menu-btn"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Downloadmogelijkheden"
        title="Downloaden"
      >
        <Menu size={19} />
      </button>
      {open && (
        <div className="galv-menu-panel" role="menu">
          <span className="galv-menu-title">Downloaden</span>
          {zippable && (
            <a
              className="galv-menu-item"
              href={zipUrl}
              download
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <Download size={15} />
              {videoCount > 0 ? 'Alle foto’s als zip' : 'Alles als zip'}
            </a>
          )}
          {videoCount > 0 && (
            <p className="galv-menu-note">
              Video’s zitten niet in de zip — daar zijn ze te groot voor. Je downloadt ze per stuk,
              in de originele resolutie, met de knop op de video zelf.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── De kopvideo: filmische opening van een videogalerij ─────────────────────
//
// Eén video groot in beeld, stil meespelend, met de titel eroverheen en de
// overige video's in rijen eronder. De volgorde is bewust: eerst het
// posterbeeld (dat staat er meteen, dus geen gat terwijl Stream nog laadt), en
// pas daarna de bewegende preview. Wie om minder beweging vraagt, houdt de
// poster — de opening blijft dan gewoon kloppen.

function GalleryBillboard({ hero, item, bundle, allowDownload, onPlay, onDownload }: {
  hero: GalleryViewerHero;
  item: GalleryViewerItem;
  bundle: GalleryTokenBundle;
  allowDownload: boolean;
  onPlay: (item: GalleryViewerItem) => void;
  onDownload?: (item: GalleryViewerItem) => void;
}) {
  const poster = itemPreviewUrl(item, bundle);
  const streamToken = item.stream_uid ? bundle.streamTokens[item.stream_uid] : undefined;
  const canPreview = Boolean(
    item.media_type === 'video'
    && item.stream_status === 'ready'
    && item.stream_playback_base
    && streamToken,
  );
  const [previewOn, setPreviewOn] = useState(false);

  // `item.id` hoort in de dependencies: bij het aanwijzen van een ándere
  // kopvideo blijft `canPreview` gewoon true, en zónder die dependency zou dit
  // effect niet opnieuw draaien — de preview kwam dan nooit meer terug. Om
  // dezelfde reden staat het terugzetten naar de poster hiér en niet in een
  // eigen effect: twee effecten die elkaars vlag beheren lopen uit de pas.
  useEffect(() => {
    setPreviewOn(false);
    if (!canPreview) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // Op een telefoon blijft het bij de poster: een meespelende video kost daar
    // data die de kijker niet heeft gevraagd, en de opening werkt zonder ook.
    if (window.matchMedia?.('(max-width: 760px)').matches) return;
    const timer = window.setTimeout(() => setPreviewOn(true), 700);
    return () => window.clearTimeout(timer);
  }, [canPreview, item.id]);

  const playable = item.media_type === 'video' ? videoPlayable(item, bundle) : true;
  const downloadable = allowDownload && Boolean(onDownload) && Boolean(
    item.storage_key || item.preview_key
    || (item.stream_uid && item.stream_playback_base && bundle.streamTokens[item.stream_uid]),
  );

  return (
    <header className="galv-bb">
      <div className="galv-bb-media" aria-hidden="true">
        {poster && <img className="galv-bb-poster" src={poster} alt="" />}
        {previewOn && item.stream_playback_base && streamToken && (
          <iframe
            className="galv-bb-video"
            // Stil, herhalend en zonder bediening: dit is een voorproefje, geen
            // speler. De echte speler opent met de knop hieronder.
            src={`${streamIframeUrl(item.stream_playback_base, streamToken)}?autoplay=true&muted=true&loop=true&controls=false&preload=auto`}
            title=""
            tabIndex={-1}
            allow="autoplay; encrypted-media"
          />
        )}
      </div>
      <span className="galv-bb-scrim" aria-hidden="true" />
      <div className="galv-bb-content">
        <h2 className="galv-bb-title">{hero.title}</h2>
        {hero.description && <p className="galv-bb-desc">{hero.description}</p>}
        <div className="galv-bb-actions">
          {playable && (
            <button type="button" className="galv-bb-play" onClick={() => onPlay(item)}>
              <Play size={19} fill="currentColor" /> Afspelen
            </button>
          )}
          {downloadable && (
            <button type="button" className="galv-bb-secondary" onClick={() => onDownload?.(item)}>
              <Download size={17} /> Origineel downloaden
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

// ── Horizontale videorij met bladerknoppen ──────────────────────────────────
//
// De knoppen verschijnen alleen als er écht iets te bladeren valt en wanneer de
// muis over de rij staat; op een aanraakscherm veeg je gewoon. Ze staan buiten
// de scrollende laag zodat een geschaalde kaart er niet onderdoor schuift.

function VideoRow({ children }: { children: React.ReactNode }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const measure = useCallback(() => {
    const node = trackRef.current;
    if (!node) return;
    // Ruime speling: browsers laten een gesnapte rij op een subpixelpositie
    // rusten, en met een strakke drempel blijft de knop dan zichtbaar terwijl
    // je al aan het begin (of eind) staat.
    setAtStart(node.scrollLeft <= 4);
    setAtEnd(node.scrollLeft + node.clientWidth >= node.scrollWidth - 4);
  }, []);

  // Bewust na élke render meten: het spoor verandert niet van formaat wanneer
  // er kaarten bij komen, dus een ResizeObserver alléén zou de knoppen op een
  // verouderde stand laten staan. Twee DOM-metingen zijn goedkoop, en gelijke
  // waarden geven geen nieuwe render.
  useEffect(() => { measure(); });

  useEffect(() => {
    const node = trackRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const page = (direction: 1 | -1) => {
    const node = trackRef.current;
    if (!node) return;
    // Net iets minder dan een volle breedte: er blijft een kaart in beeld staan
    // als houvast, precies zoals streamingdiensten het doen.
    node.scrollBy({ left: direction * Math.round(node.clientWidth * 0.85), behavior: 'smooth' });
  };

  const hasOverflow = !(atStart && atEnd);

  return (
    <div className={`galv-row${hasOverflow ? ' has-overflow' : ''}`}>
      <button
        type="button"
        className="galv-row-nav galv-row-prev"
        onClick={() => page(-1)}
        disabled={atStart}
        aria-label="Eerdere video’s"
      >
        <ChevronLeft size={28} />
      </button>
      <div className="galv-row-track" ref={trackRef} onScroll={measure}>
        {children}
      </div>
      <button
        type="button"
        className="galv-row-nav galv-row-next"
        onClick={() => page(1)}
        disabled={atEnd}
        aria-label="Volgende video’s"
      >
        <ChevronRight size={28} />
      </button>
    </div>
  );
}

// ── Justified rows: vullen zonder bijsnijden ────────────────────────────────
//
// Elke rij krijgt precies de containerbreedte: we tellen de beeldverhoudingen
// van de foto's in de rij op en leiden daar de rijhoogte uit af. Zo houdt elke
// foto haar eigen verhouding (geen crop) en blijft er geen loze ruimte over.
// De laatste rij wordt óók volgemaakt; dreigt die onevenredig hoog te worden
// (bijvoorbeeld één staande foto), dan schuiven we er foto's uit de rij erboven
// bij tot het weer in verhouding is.

const PHOTO_GAP = 6;
const FALLBACK_RATIO = 3 / 2;
/** Boven deze factor maal de streefhoogte oogt een laatste rij als een uitvergroting. */
const LAST_ROW_MAX_FACTOR = 1.45;

function aspectRatio(item: GalleryViewerItem): number {
  if (item.width && item.height && item.width > 0 && item.height > 0) {
    // Extreme panorama's/stroken begrenzen, anders duwen ze een hele rij plat.
    return Math.min(4, Math.max(0.35, item.width / item.height));
  }
  return FALLBACK_RATIO;
}

/** Streefhoogte schaalt mee met de breedte: op een telefoon kleinere rijen. */
function targetRowHeight(width: number): number {
  if (width < 520) return 150;
  if (width < 900) return 200;
  if (width < 1400) return 250;
  return 290;
}

type PhotoRow = { items: GalleryViewerItem[]; height: number };

function buildPhotoRows(photos: GalleryViewerItem[], width: number): PhotoRow[] {
  if (photos.length === 0 || width <= 0) return [];
  const target = targetRowHeight(width);
  const heightOf = (list: GalleryViewerItem[]) => {
    const sum = list.reduce((total, item) => total + aspectRatio(item), 0);
    if (sum <= 0) return target;
    return (width - PHOTO_GAP * (list.length - 1)) / sum;
  };

  const rows: PhotoRow[] = [];
  let current: GalleryViewerItem[] = [];
  for (const photo of photos) {
    current.push(photo);
    if (heightOf(current) <= target) {
      rows.push({ items: current, height: heightOf(current) });
      current = [];
    }
  }

  if (current.length > 0) {
    let height = heightOf(current);
    // Laatste rij vult ook de volle breedte; te hoog = foto's uit de vorige rij
    // erbij halen tot het klopt (maximaal een paar keer, nooit oneindig).
    let guard = 0;
    while (height > target * LAST_ROW_MAX_FACTOR && rows.length > 0 && guard < 20) {
      const previous = rows[rows.length - 1];
      if (previous.items.length <= 1) break;
      const moved = previous.items.pop() as GalleryViewerItem;
      previous.height = heightOf(previous.items);
      current = [moved, ...current];
      height = heightOf(current);
      guard += 1;
    }
    rows.push({ items: current, height });
  }

  return rows;
}

function JustifiedPhotos({ photos, renderTile }: {
  photos: GalleryViewerItem[];
  /** `displayWidth` is de werkelijke breedte in CSS-pixels, voor een kloppende `sizes`. */
  renderTile: (item: GalleryViewerItem, style: React.CSSProperties, displayWidth: number) => React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Beginbreedte zodat de eerste paint al een zinnige indeling toont; de
  // ResizeObserver corrigeert 'm meteen daarna (en bij elke venstermaat).
  const [width, setWidth] = useState(1200);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const apply = (value: number) => { if (value > 0) setWidth(value); };
    apply(node.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => buildPhotoRows(photos, width), [photos, width]);

  return (
    <div className="galv-just" ref={containerRef}>
      {rows.map((row, index) => (
        <div className="galv-just-row" key={row.items[0]?.id ?? index} style={{ height: `${row.height}px` }}>
          {row.items.map(item => renderTile(
            item,
            { flexGrow: aspectRatio(item), flexBasis: 0 },
            aspectRatio(item) * row.height,
          ))}
        </div>
      ))}
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
  const text = (
    <div className="galv-hero-text">
      <h2>{hero.title}</h2>
      {hero.description && <p>{hero.description}</p>}
    </div>
  );

  // ── Modern: asymmetrisch, de titel valt over het beeld heen ──
  if (hero.template === 'editorial') {
    return (
      <header className="galv-hero galv-hero-editorial">
        <div className="galv-hero-media" onClick={openCover}>
          <img src={coverUrl} alt={hero.title} />
        </div>
        {text}
      </header>
    );
  }

  // ── Modern: beeld in een ruim kader, titel eronder in kapitalen ──
  if (hero.template === 'frame') {
    return (
      <header className="galv-hero galv-hero-frame">
        <div className="galv-hero-media" onClick={openCover}>
          <img src={coverUrl} alt={hero.title} />
        </div>
        {text}
      </header>
    );
  }

  // ── Klassiek: gecentreerde titel tussen dunne lijnen, beeld eronder ──
  if (hero.template === 'classic') {
    return (
      <header className="galv-hero galv-hero-classic">
        {text}
        <div className="galv-hero-media" onClick={openCover}>
          <img src={coverUrl} alt={hero.title} />
        </div>
      </header>
    );
  }

  // ── Spectaculair: langzame zoom op het beeld, titel zweeft in ──
  if (hero.template === 'cinematic') {
    return (
      <header className="galv-hero galv-hero-cinematic" onClick={openCover}>
        <img className="galv-hero-bg" src={coverUrl} alt={hero.title} />
        <span className="galv-hero-veil" aria-hidden="true" />
        {text}
      </header>
    );
  }

  // ── Spectaculair: mozaïek van meerdere beelden achter de titel ──
  if (hero.template === 'mosaic') {
    const tiles = [cover, ...photos.filter(p => p.id !== cover.id)].slice(0, 9);
    return (
      <header className="galv-hero galv-hero-mosaic">
        <div className="galv-hero-mosaic-grid" aria-hidden="true">
          {tiles.map((tile, index) => {
            const url = itemPreviewUrl(tile, bundle);
            return url ? (
              // Elke tegel drijft met een eigen vertraging; bij "minder beweging"
              // zet de globale reduced-motion-regel dit stil.
              <span key={tile.id} className="galv-hero-mosaic-cell" style={{ animationDelay: `${index * 0.35}s` }}>
                <img src={url} alt="" loading="lazy" />
              </span>
            ) : null;
          })}
        </div>
        <span className="galv-hero-veil" aria-hidden="true" />
        {text}
      </header>
    );
  }

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
