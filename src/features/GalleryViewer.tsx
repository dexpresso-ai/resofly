// Gedeelde galerij-weergave: hero, categoriechips, fotogrid, Netflix-achtige
// videorijen en lightbox. Wordt gebruikt door de beheer-tab in het project
// (app), de Galerijen-tab in het klantportaal en de publieke deellinkpagina.
// De component is puur presentationeel: media-URL's komen uit het meegegeven
// tokenbundel, favorieten en downloads lopen via callbacks van de host.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Film, Heart, Maximize2, Menu, Minimize2, Pause, Play, Repeat, Shuffle, SlidersHorizontal, ThumbsUp, X } from 'lucide-react';
import {
  galleryFileUrl,
  streamIframeUrl,
  streamThumbnailUrl,
  type GalleryTokenBundle,
} from '../lib/gallery';
import { currentFullscreenElement, enterFullscreen, leaveFullscreen, onFullscreenChange } from '../lib/fullscreen';

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

/**
 * Opening van de galerij. Het coverbeeld komt uit één van twee bronnen:
 * `coverPreviewKey` — een eigen beeld dat niet in de galerij zit — of anders
 * `itemId`, een beeld uit de galerij zelf. Ontbreken ze allebei, dan pakt de
 * opening het eerste bruikbare item.
 */
export type GalleryViewerHero = {
  template: string;
  title: string;
  description?: string | null;
  itemId?: string | null;
  /** Eigen coverbeeld (R2-key onder de galerij-prefix); wint van `itemId`. */
  coverPreviewKey?: string | null;
  /** Focuspunt van de uitsnede in procenten (0–100); standaard het midden. */
  focusX?: number | null;
  focusY?: number | null;
};

/**
 * De uitsnede van het coverbeeld. Elke opening snijdt bij — 21:9, 2:1, een
 * boog — en zonder focuspunt valt een hoofd net buiten beeld.
 */
function coverPosition(hero: GalleryViewerHero): string {
  const clamp = (value: number | null | undefined) =>
    Math.min(100, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 50));
  return `${clamp(hero.focusX)}% ${clamp(hero.focusY)}%`;
}

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

// ── Diavoorstelling: instellingen ───────────────────────────────────────────
//
// De kijker bladerde alleen handmatig. Een galerij op een tv of tijdens een
// nabespreking wil je juist lóspelen: beeld na beeld, zonder pijltje. Deze
// voorkeuren zijn van de kijker (niet van de galerij) en blijven daarom in zijn
// eigen browser staan — de fotograaf bepaalt de inhoud, de kijker de vertoning.

export type SlideshowTransition = 'none' | 'fade' | 'slide' | 'zoom';
export type SlideshowFit = 'contain' | 'cover';

export type SlideshowSettings = {
  /** Seconden per beeld. */
  interval: number;
  /** Aan het eind opnieuw beginnen; uit = stoppen op de laatste foto. */
  loop: boolean;
  /** Willekeurige volgorde (elke foto één keer per ronde). */
  shuffle: boolean;
  transition: SlideshowTransition;
  /** 'contain' = hele foto in beeld, 'cover' = beeldvullend bijgesneden. */
  fit: SlideshowFit;
  /** Bestandsnaam en teller onder de foto tonen. */
  showCaption: boolean;
};

export const SLIDESHOW_INTERVALS = [2, 3, 5, 8, 12, 20] as const;

const SLIDESHOW_DEFAULTS: SlideshowSettings = {
  interval: 5,
  loop: true,
  shuffle: false,
  transition: 'fade',
  fit: 'contain',
  showCaption: true,
};

const SLIDESHOW_STORAGE_KEY = 'resofly.gallery.slideshow';

/** Leest de bewaarde voorkeuren; elke onbekende of kapotte waarde valt terug op de standaard. */
export function loadSlideshowSettings(): SlideshowSettings {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SLIDESHOW_STORAGE_KEY);
    if (!raw) return SLIDESHOW_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<SlideshowSettings>;
    const interval = Number(parsed.interval);
    return {
      interval: SLIDESHOW_INTERVALS.includes(interval as typeof SLIDESHOW_INTERVALS[number]) ? interval : SLIDESHOW_DEFAULTS.interval,
      loop: typeof parsed.loop === 'boolean' ? parsed.loop : SLIDESHOW_DEFAULTS.loop,
      shuffle: typeof parsed.shuffle === 'boolean' ? parsed.shuffle : SLIDESHOW_DEFAULTS.shuffle,
      transition: (['none', 'fade', 'slide', 'zoom'] as string[]).includes(String(parsed.transition))
        ? parsed.transition as SlideshowTransition
        : SLIDESHOW_DEFAULTS.transition,
      fit: parsed.fit === 'cover' ? 'cover' : 'contain',
      showCaption: typeof parsed.showCaption === 'boolean' ? parsed.showCaption : SLIDESHOW_DEFAULTS.showCaption,
    };
  } catch {
    return SLIDESHOW_DEFAULTS;
  }
}

function saveSlideshowSettings(settings: SlideshowSettings): void {
  try {
    localStorage.setItem(SLIDESHOW_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / storage geweigerd — dan simpelweg niet onthouden */
  }
}

/** Een willekeurige volgorde van 0…n-1 (Fisher-Yates). */
function shuffledIndexes(count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Het element dat de galerij daadwerkelijk scrolt. Dat verschilt per plek waar
 * de kijker staat: `.content` in de app, `.portal-content` in het klantportaal,
 * en het venster zelf op de publieke deellinkpagina.
 */
function scrollableAncestor(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return null;
}

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
  /**
   * Grootbeeld: de galerij zonder browserrand, met bediening die op drie meter
   * afstand nog werkt. Bedoeld voor wie zijn scherm naar een tv spiegelt.
   *
   * Bewust een knop en geen automatische herkenning: er is vanuit de browser
   * geen enkel signaal waarmee je een tv van een monitor onderscheidt —
   * `hover:none` vangt tv's niet en een breedtegrens vangt elke brede monitor.
   */
  const [bigScreen, setBigScreen] = useState(false);
  /** Diavoorstelling: speelt hij, met welke voorkeuren, en staat het paneel open. */
  const [slideshow, setSlideshow] = useState(false);
  const [slideSettings, setSlideSettings] = useState<SlideshowSettings>(loadSlideshowSettings);
  const [slideOptions, setSlideOptions] = useState(false);
  const [shuffleOrder, setShuffleOrder] = useState<number[]>([]);
  /** Muis/vinger al even stil: dan verdwijnt de bediening tijdens het spelen. */
  const [idle, setIdle] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
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

  const closeOverlays = useCallback(() => { setLightbox(null); setPlaying(null); setSlideshow(false); }, []);

  const patchSlideSettings = useCallback((patch: Partial<SlideshowSettings>) => {
    setSlideSettings(prev => ({ ...prev, ...patch }));
  }, []);

  // Bewaren als los effect en niet in de updater hierboven: die mag React
  // meerdere keren aanroepen, en dan schrijft hij ook meerdere keren weg.
  useEffect(() => { saveSlideshowSettings(slideSettings); }, [slideSettings]);

  // De willekeurige volgorde wordt één keer per ronde getrokken, niet per stap:
  // anders zie je dezelfde foto drie keer voordat een andere aan de beurt is.
  useEffect(() => {
    if (!slideSettings.shuffle) { setShuffleOrder([]); return; }
    setShuffleOrder(shuffledIndexes(orderedPhotos.length));
  }, [slideSettings.shuffle, orderedPhotos.length]);

  /**
   * De volgende foto vanaf `from`. `wrap` = doorlopen voorbij het einde; zonder
   * dat geeft hij `null` terug en is de reeks uit. Bij willekeurige volgorde
   * telt de positie in `shuffleOrder`, niet de positie in de galerij.
   */
  const advanceIndex = useCallback((from: number, delta: number, wrap: boolean): number | null => {
    const count = orderedPhotos.length;
    if (count === 0) return null;
    const sequence = slideSettings.shuffle && shuffleOrder.length === count ? shuffleOrder : null;
    if (!sequence) {
      const next = from + delta;
      if (next < 0 || next >= count) return wrap ? (next + count) % count : null;
      return next;
    }
    const position = sequence.indexOf(from);
    const nextPosition = (position < 0 ? 0 : position) + delta;
    if (nextPosition < 0 || nextPosition >= count) return wrap ? sequence[(nextPosition + count) % count] : null;
    return sequence[nextPosition];
  }, [orderedPhotos.length, slideSettings.shuffle, shuffleOrder]);

  const stepLightbox = useCallback((delta: number) => {
    setLightbox(prev => {
      if (!prev) return prev;
      const next = advanceIndex(prev.index, delta, true);
      return next == null ? prev : { index: next };
    });
  }, [advanceIndex]);

  /**
   * Start bij de foto die openstaat, of — vanuit het raster — bij het begin van
   * de (eventueel geschudde) reeks. Pauzeren laat de foto gewoon staan.
   */
  const toggleSlideshow = useCallback(() => {
    if (slideshow) { setSlideshow(false); return; }
    if (orderedPhotos.length === 0) return;
    if (!lightbox) {
      const order = slideSettings.shuffle && shuffleOrder.length === orderedPhotos.length ? shuffleOrder : null;
      setLightbox({ index: order ? order[0] : 0 });
    }
    setSlideshow(true);
  }, [slideshow, lightbox, orderedPhotos.length, slideSettings.shuffle, shuffleOrder]);

  /**
   * De klok van de diavoorstelling. Bewust een timeout per beeld en geen
   * CSS-animatie die zichzelf doortelt: onder `prefers-reduced-motion` zet de
   * app álle animaties uit (globals.css), en dan zou de voorstelling in één
   * klap door de hele galerij razen.
   *
   * Staat er een video open, dan wacht de voorstelling — die video kijk je uit.
   */
  useEffect(() => {
    if (!slideshow || !lightbox || playing) return;
    const timer = window.setTimeout(() => {
      const next = advanceIndex(lightbox.index, 1, slideSettings.loop);
      if (next == null) { setSlideshow(false); return; }
      setLightbox({ index: next });
    }, Math.max(1000, slideSettings.interval * 1000));
    return () => window.clearTimeout(timer);
  }, [slideshow, lightbox, playing, slideSettings.interval, slideSettings.loop, advanceIndex]);

  // Zonder open foto valt er niets te spelen (foto verwijderd, filter aan).
  useEffect(() => {
    if (slideshow && !lightbox) setSlideshow(false);
  }, [slideshow, lightbox]);

  // In de selectie- en sleepstand van de fotograaf opent een tegelklik geen
  // foto meer; een voorstelling die dan nog doorloopt hoort daar niet.
  useEffect(() => {
    if (selectable || reorderable) setSlideshow(false);
  }, [selectable, reorderable]);

  /**
   * Tijdens het spelen verdwijnt de bediening als je niets doet — anders staan
   * er drie knoppen over elke foto heen, en juist bij het lospelen kijk je naar
   * het beeld en niet naar de knoppen. Elke beweging haalt ze terug.
   */
  useEffect(() => {
    if (!slideshow || slideOptions) { setIdle(false); return; }
    let timer = window.setTimeout(() => setIdle(true), 2600);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2600);
    };
    window.addEventListener('mousemove', wake, { passive: true });
    window.addEventListener('touchstart', wake, { passive: true });
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('touchstart', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [slideshow, slideOptions]);

  /**
   * Eén toetsenafhandeling voor de hele kijker.
   *
   * Bewust in de CAPTURE-fase op window: de app heeft meerdere handlers op
   * hetzelfde window liggen (de presenteerstand van de fotograaf, de zijbalk, en
   * de agenda die ArrowLeft/Right afvangt óók als hij op een achtergrondtabblad
   * staat). `stopPropagation` in de bubble-fase schakelt die níét uit — ze
   * luisteren op hetzelfde doel, en dan bepaalt registratievolgorde de winnaar.
   * In capture zijn we er eerder bij en bereikt het event ze nooit.
   *
   * En preventDefault, dat hier eerder ontbrak: zonder dat scrolt de pagina
   * achter de open foto gewoon mee met de pijltjes.
   */
  useEffect(() => {
    if (!lightbox && !playing && !bigScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

      // Spatie speelt en pauzeert de diavoorstelling — de toets die elke speler
      // daarvoor heeft. Zonder preventDefault scrolt hij ook de pagina eronder.
      if (e.key === ' ' || e.key === 'Spacebar') {
        if (!lightbox && !bigScreen) return;
        if (playing) return; // de videospeler krijgt zijn eigen spatie
        e.preventDefault();
        e.stopPropagation();
        toggleSlideshow();
        return;
      }

      if (e.key === 'Escape') {
        // Alleen de bovenste laag sluiten. Staat het optiepaneel open, dan gaat
        // dat als eerste dicht.
        if (slideOptions) {
          e.preventDefault();
          e.stopPropagation();
          setSlideOptions(false);
          return;
        }
        // Staat er een foto open binnen de presenteerstand van de fotograaf,
        // dan hoort de eerste Escape de foto te sluiten en pas de tweede die
        // stand te verlaten.
        if (lightbox || playing) {
          e.preventDefault();
          e.stopPropagation();
          closeOverlays();
          return;
        }
        // Zonder overlay verlaat Escape de grootbeeldstand — en niets anders.
        // Bewust ook stoppen wanneer de browser zélf al uit volledig scherm
        // stapt: anders bereikt dezelfde toets óók de presenteerstand van de
        // fotograaf, en klappen er twee standen tegelijk dicht.
        //
        // Prijs hiervan: een openstaand downloadmenu blijft staan (dat luistert
        // zelf op Escape en komt hier niet meer aan). Dat sluit bij de volgende
        // klik; twee standen tegelijk verliezen is erger.
        if (bigScreen) {
          e.preventDefault();
          e.stopPropagation();
          void leaveFullscreen();
          setBigScreen(false);
        }
        return;
      }

      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      if (lightbox) {
        e.preventDefault();
        e.stopPropagation();
        stepLightbox(delta);
        return;
      }
      // In grootbeeld zonder open foto: begin bij de eerste (of de laatste, bij
      // een pijltje naar links). Zo is de hele galerij met alleen de pijltjes te
      // doorlopen — op een afstandsbediening is dat de enige bediening die er is.
      if (bigScreen && !playing && orderedPhotos.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        setLightbox({ index: delta > 0 ? 0 : orderedPhotos.length - 1 });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [lightbox, playing, bigScreen, closeOverlays, stepLightbox, orderedPhotos.length, slideOptions, toggleSlideshow]);

  /**
   * De browser kan volledig scherm buiten ons om verlaten (Escape, F11, of de
   * eigen knop van de videospeler). Zonder deze synchronisatie blijft de
   * grootbeeldstand aan terwijl het scherm er niet meer naar is.
   */
  useEffect(() => {
    if (!bigScreen) return;
    return onFullscreenChange(() => {
      // Er is nog iets schermvullend: de Stream-speler pakt zíjn eigen iframe.
      // Dat is een laag erbovenop, niet ons vertrek.
      if (currentFullscreenElement()) return;
      // En als die speler zijn volledig scherm teruggeeft, hoort de
      // grootbeeldstand eronder gewoon te blijven staan.
      if (playing) return;
      setBigScreen(false);
    });
  }, [bigScreen, playing]);

  const toggleBigScreen = useCallback(() => {
    if (bigScreen) {
      void leaveFullscreen();
      setBigScreen(false);
      return;
    }
    // De CSS-stand is leidend, niet de API: lukt echte fullscreen niet (iPhone
    // kent geen element-fullscreen), dan werkt grootbeeld nog steeds — alleen
    // met de browserbalk er nog omheen.
    //
    // Bewust het hele document en niet dit ene element: alles búiten het
    // schermvullende element verdwijnt achter de zwarte ::backdrop van de
    // browser, en de vensters van de gastheerpagina staan daar (de naamvraag op
    // de deellinkpagina, de vensters in de app). Die zouden dan onzichtbaar
    // openen terwijl ze wél de focus pakken. Met het document als doel blijft de
    // stapeling gewoon werken en haalt de API alleen de browserbalk weg.
    void enterFullscreen(document.documentElement);
    setBigScreen(true);
  }, [bigScreen]);

  /**
   * De gastheerpagina scrollt niet mee: in deze stand staat de galerij op
   * `fixed` en is ze dus uit de flow, waardoor de pagina eronder dichtklapt en
   * haar scrollpositie kwijtraakt. Zonder dit kom je na het verlaten van
   * grootbeeld bovenaan terug in plaats van bij de foto waar je was.
   */
  useEffect(() => {
    if (!bigScreen) return;
    const host = scrollableAncestor(rootRef.current);
    const top = host ? host.scrollTop : window.scrollY;
    return () => {
      // Ook het vertrek langs de achterdeur afdekken: bij unmount (tabblad weg,
      // galerij gesloten) zou de browser anders schermvullend blijven staan.
      void leaveFullscreen();
      requestAnimationFrame(() => {
        if (host) host.scrollTop = top;
        else window.scrollTo(0, top);
      });
    };
  }, [bigScreen]);

  /**
   * Grootbeeld mag nooit blijven hangen zonder uitweg. Raakt de galerij leeg
   * (laatste foto verwijderd, favorietenfilter aan) dan rendert de kijker alleen
   * nog een lege regel — zonder knop om de stand te verlaten, terwijl de
   * toetsenafhandeling wél actief blijft. Datzelfde geldt voor de selectie- en
   * sleepstand, waar de knop bewust verdwijnt.
   */
  useEffect(() => {
    if (!bigScreen) return;
    if (items.length > 0 && !selectable && !reorderable) return;
    void leaveFullscreen();
    setBigScreen(false);
  }, [bigScreen, items.length, selectable, reorderable]);

  /**
   * Een lightbox-index die buiten de lijst valt toont niets (de render valt
   * terug op null), maar houdt de toetsen wél bezet: je bladert dan door een
   * onzichtbare overlay. Gebeurt zodra de lijst krimpt terwijl er een foto open
   * staat — een verwijderd item, of het favorietenfilter dat aangaat.
   */
  useEffect(() => {
    if (lightbox && !orderedPhotos[lightbox.index]) setLightbox(null);
  }, [lightbox, orderedPhotos]);

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
      rowScale={bigScreen ? 1.35 : 1}
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
    <div className={`galv${bigScreen ? ' is-tv' : ''}`} ref={rootRef}>
      {/* De zwevende bediening. De grootbeeldknop staat bewust búiten
          GalleryDownloadMenu: dat menu sluit zichzelf op elke muisklik erbuiten,
          dus een knop binnen zijn kader zou het menu blokkeren en een knop
          erbuiten zou het bij elke klik dichtslaan. */}
      <div className="galv-actions">
        {/* In de sleep- en selectiestand opent een tegelklik geen foto, dus
            heeft bladeren met de pijltjes daar geen betekenis. */}
        {!selectable && !reorderable && orderedPhotos.length > 1 && (
          <button
            type="button"
            className="galv-menu-btn"
            onClick={toggleSlideshow}
            aria-pressed={slideshow}
            aria-label={slideshow ? 'Diavoorstelling pauzeren' : 'Diavoorstelling afspelen'}
            title={slideshow ? 'Diavoorstelling pauzeren (spatie)' : 'Diavoorstelling — speelt de foto’s vanzelf af (spatie)'}
          >
            {slideshow ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
        )}
        {!selectable && !reorderable && (
          <button
            type="button"
            className="galv-menu-btn"
            onClick={toggleBigScreen}
            aria-pressed={bigScreen}
            aria-label={bigScreen ? 'Grootbeeld verlaten' : 'Grootbeeld voor tv of beamer'}
            title={bigScreen ? 'Grootbeeld verlaten (Escape)' : 'Grootbeeld — voor op een tv of beamer, blader met de pijltjes'}
          >
            {bigScreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
        )}
        {allowDownload && zipUrl && (hasZippableItems(items) || items.some(i => i.media_type === 'video')) && (
          <GalleryDownloadMenu
            zipUrl={zipUrl}
            zippable={hasZippableItems(items)}
            videoCount={items.filter(i => i.media_type === 'video').length}
          />
        )}
      </div>
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

      {/* ── Lightbox (foto's) + diavoorstelling ── */}
      {lightbox && orderedPhotos[lightbox.index] && (
        <div
          className={[
            'galv-lightbox',
            slideshow ? 'is-slideshow' : '',
            slideshow && idle ? 'is-idle' : '',
            slideSettings.fit === 'cover' ? 'is-fill' : '',
            slideSettings.showCaption ? '' : 'is-uncaptioned',
          ].filter(Boolean).join(' ')}
          role="dialog"
          aria-modal="true"
          onClick={closeOverlays}
        >
          {/* Voortgang van het huidige beeld. Puur sier: de klok is de timeout
              hierboven. Remonteert bij elke wissel (key), zodat de balk telkens
              opnieuw begint — ook als je met de pijltjes vooruit springt. */}
          {slideshow && (
            <span
              key={lightbox.index}
              className="galv-ss-progress"
              style={{ animationDuration: `${Math.max(1, slideSettings.interval)}s` }}
              aria-hidden="true"
            />
          )}
          <button type="button" className="galv-lightbox-close" onClick={closeOverlays} aria-label="Sluiten"><X size={20} /></button>
          {orderedPhotos.length > 1 && (
            <button type="button" className="galv-lightbox-nav galv-prev" onClick={(e) => { e.stopPropagation(); stepLightbox(-1); }} aria-label="Vorige"><ChevronLeft size={26} /></button>
          )}
          <div className="galv-lightbox-stage" onClick={(e) => e.stopPropagation()}>
            {/* Het kader knipt de langzame zoom af; zonder dit groeit de foto
                buiten haar vak en schuift ze over de balk eronder. */}
            <div className="galv-ss-frame">
              <img
                // De key remonteert het beeld, zodat de overgangsanimatie bij elke
                // foto opnieuw afspeelt in plaats van één keer bij het openen.
                key={orderedPhotos[lightbox.index].id}
                className={`galv-ss-img galv-tr-${slideSettings.transition}`}
                style={slideSettings.transition === 'zoom'
                  ? { animationDuration: `${Math.max(1, slideSettings.interval)}s` }
                  : undefined}
                src={itemPreviewUrl(orderedPhotos[lightbox.index], bundle) ?? undefined}
                alt={orderedPhotos[lightbox.index].file_name}
              />
            </div>
            <div className="galv-lightbox-bar">
              <span className="galv-lightbox-name">{orderedPhotos[lightbox.index].file_name}</span>
              <span className="galv-lightbox-tools">
                {orderedPhotos.length > 1 && (
                  <button
                    type="button"
                    className={`galv-ss-btn${slideshow ? ' is-on' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleSlideshow(); }}
                    aria-pressed={slideshow}
                    title={slideshow ? 'Diavoorstelling pauzeren (spatie)' : 'Diavoorstelling afspelen (spatie)'}
                    aria-label={slideshow ? 'Diavoorstelling pauzeren' : 'Diavoorstelling afspelen'}
                  >
                    {slideshow ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
                  </button>
                )}
                {orderedPhotos.length > 1 && (
                  <SlideshowOptions
                    open={slideOptions}
                    settings={slideSettings}
                    onToggle={() => setSlideOptions(v => !v)}
                    onChange={patchSlideSettings}
                  />
                )}
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

// ── Instellingen van de diavoorstelling ─────────────────────────────────────
//
// Eén paneel onder een tandwiel in de balk van de open foto. Bewust dáár en
// niet in de galerij-instellingen van de fotograaf: dit gaat over hoe jíj kijkt,
// niet over hoe de galerij is samengesteld. De keuzes blijven in je eigen
// browser staan, dus de volgende galerij opent zoals je hem gewend bent.

const SLIDESHOW_TRANSITION_LABELS: Array<{ value: SlideshowTransition; label: string; hint: string }> = [
  { value: 'none', label: 'Geen', hint: 'Direct het volgende beeld' },
  { value: 'fade', label: 'Vervagen', hint: 'Zacht in beeld' },
  { value: 'slide', label: 'Schuiven', hint: 'Van rechts in beeld' },
  { value: 'zoom', label: 'Inzoomen', hint: 'Langzame zoom over het hele beeld' },
];

function SlideshowOptions({ open, settings, onToggle, onChange }: {
  open: boolean;
  settings: SlideshowSettings;
  onToggle: () => void;
  onChange: (patch: Partial<SlideshowSettings>) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // mousedown i.p.v. click: anders sluit het paneel pas ná de klik en vangt
    // een element eronder die klik alsnog op.
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) onToggle();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open, onToggle]);

  return (
    <div className="galv-ss-menu" ref={boxRef}>
      <button
        type="button"
        className={`galv-ss-btn${open ? ' is-on' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Instellingen diavoorstelling"
        title="Instellingen diavoorstelling"
      >
        <SlidersHorizontal size={15} />
      </button>
      {open && (
        <div className="galv-ss-panel" role="dialog" aria-label="Instellingen diavoorstelling" onClick={(e) => e.stopPropagation()}>
          <span className="galv-menu-title">Diavoorstelling</span>

          <div className="galv-ss-row">
            <span className="galv-ss-label">Seconden per foto</span>
            <div className="galv-ss-seg" role="group" aria-label="Seconden per foto">
              {SLIDESHOW_INTERVALS.map(seconds => (
                <button
                  key={seconds}
                  type="button"
                  className={`galv-ss-chip${settings.interval === seconds ? ' is-on' : ''}`}
                  aria-pressed={settings.interval === seconds}
                  onClick={() => onChange({ interval: seconds })}
                >
                  {seconds}s
                </button>
              ))}
            </div>
          </div>

          <div className="galv-ss-row">
            <span className="galv-ss-label">Overgang</span>
            <div className="galv-ss-seg" role="group" aria-label="Overgang">
              {SLIDESHOW_TRANSITION_LABELS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  className={`galv-ss-chip${settings.transition === option.value ? ' is-on' : ''}`}
                  aria-pressed={settings.transition === option.value}
                  title={option.hint}
                  onClick={() => onChange({ transition: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="galv-ss-row">
            <span className="galv-ss-label">Beeldvulling</span>
            <div className="galv-ss-seg" role="group" aria-label="Beeldvulling">
              <button
                type="button"
                className={`galv-ss-chip${settings.fit === 'contain' ? ' is-on' : ''}`}
                aria-pressed={settings.fit === 'contain'}
                title="De hele foto past in beeld"
                onClick={() => onChange({ fit: 'contain' })}
              >
                Passend
              </button>
              <button
                type="button"
                className={`galv-ss-chip${settings.fit === 'cover' ? ' is-on' : ''}`}
                aria-pressed={settings.fit === 'cover'}
                title="Beeldvullend — de randen worden bijgesneden"
                onClick={() => onChange({ fit: 'cover' })}
              >
                Vullend
              </button>
            </div>
          </div>

          <div className="galv-ss-toggles">
            <button
              type="button"
              className={`galv-ss-toggle${settings.loop ? ' is-on' : ''}`}
              aria-pressed={settings.loop}
              title={settings.loop ? 'Begint na de laatste foto opnieuw' : 'Stopt op de laatste foto'}
              onClick={() => onChange({ loop: !settings.loop })}
            >
              <Repeat size={14} /> Herhalen
            </button>
            <button
              type="button"
              className={`galv-ss-toggle${settings.shuffle ? ' is-on' : ''}`}
              aria-pressed={settings.shuffle}
              title="Willekeurige volgorde — elke foto één keer per ronde"
              onClick={() => onChange({ shuffle: !settings.shuffle })}
            >
              <Shuffle size={14} /> Willekeurig
            </button>
            <button
              type="button"
              className={`galv-ss-toggle${settings.showCaption ? ' is-on' : ''}`}
              aria-pressed={settings.showCaption}
              title="Bestandsnaam en teller onder de foto"
              onClick={() => onChange({ showCaption: !settings.showCaption })}
            >
              Bijschrift
            </button>
          </div>
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
        {poster && (
          <img className="galv-bb-poster" src={poster} alt="" style={{ objectPosition: coverPosition(hero) }} />
        )}
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

function buildPhotoRows(photos: GalleryViewerItem[], width: number, scale = 1): PhotoRow[] {
  if (photos.length === 0 || width <= 0) return [];
  const target = targetRowHeight(width) * scale;
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

function JustifiedPhotos({ photos, renderTile, rowScale = 1 }: {
  photos: GalleryViewerItem[];
  /** `displayWidth` is de werkelijke breedte in CSS-pixels, voor een kloppende `sizes`. */
  renderTile: (item: GalleryViewerItem, style: React.CSSProperties, displayWidth: number) => React.ReactNode;
  /**
   * Vermenigvuldiger op de streefhoogte van een rij. Alleen grootbeeld gebruikt
   * dit: de rijhoogte komt uit de code en niet uit CSS, dus zonder deze weg
   * blijven de foto's op een tv net zo klein als op een laptop. Bewust géén
   * extra breedtetrede in `targetRowHeight`, want dat zou ook elke brede
   * monitor van indeling laten veranderen.
   */
  rowScale?: number;
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

  const rows = useMemo(() => buildPhotoRows(photos, width, rowScale), [photos, width, rowScale]);

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

/** Hoe lang één beeld blijft staan in de wisselende opening. */
const HERO_SLIDE_MS = 5200;

/**
 * De opening van de galerij. Zestien varianten, van een kale titel tot een
 * beeld dat door de letters heen te zien is. Ontbreekt er een bruikbaar beeld,
 * dan valt de hero terug op de ingetogen tekstvariant — beter een rustige titel
 * dan een gat.
 *
 * Het coverbeeld komt uit één van twee bronnen. Heeft de beeldmaker een eigen
 * cover geüpload, dan wint die: hij is bewust gekozen en zit niet in de reeks,
 * dus hij is ook niet aan te klikken. Anders is het een item uit de galerij, en
 * opent een klik het gewoon in de lightbox.
 */
function GalleryHero({ hero, items, bundle, onOpenPhoto }: {
  hero: GalleryViewerHero;
  items: GalleryViewerItem[];
  bundle: GalleryTokenBundle;
  onOpenPhoto: (item: GalleryViewerItem) => void;
}) {
  const photos = useMemo(() => items.filter(i => i.media_type === 'photo'), [items]);
  const coverItem = (hero.itemId ? items.find(i => i.id === hero.itemId) : null) ?? photos[0] ?? items[0] ?? null;
  const customCoverUrl = hero.coverPreviewKey ? galleryFileUrl(hero.coverPreviewKey, bundle.mediaToken) : null;
  const coverUrl = customCoverUrl ?? (coverItem ? itemPreviewUrl(coverItem, bundle) : null);
  const position = coverPosition(hero);

  /**
   * De beelden náást de cover, voor de openingen die er meerdere tonen. Bij een
   * eigen cover doet de hele galerij mee; anders slaan we het coverbeeld over,
   * want dat staat al vooraan.
   */
  const extras = useMemo(
    () => (customCoverUrl ? photos : photos.filter(p => p.id !== coverItem?.id)),
    [customCoverUrl, photos, coverItem?.id],
  );

  /** De reeks van de wisselende opening: de cover voorop, dan de rest. */
  const slides = useMemo(() => {
    const urls = coverUrl ? [coverUrl] : [];
    for (const photo of extras) {
      if (urls.length >= 5) break;
      const url = itemPreviewUrl(photo, bundle);
      if (url) urls.push(url);
    }
    return urls;
  }, [coverUrl, extras, bundle]);

  const [slide, setSlide] = useState(0);
  const rotating = hero.template === 'slideshow' && slides.length > 1;

  useEffect(() => {
    // Terug naar de cover zodra de reeks verandert: een oude index kan buiten
    // de nieuwe lijst vallen, en dan staat er even helemaal geen beeld.
    setSlide(0);
    if (!rotating) return;
    // Wie "minder beweging" heeft aangezet krijgt gewoon de cover; een
    // CSS-overgang stilzetten helpt niet als de bron zelf blijft wisselen.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setSlide(i => (i + 1) % slides.length), HERO_SLIDE_MS);
    return () => window.clearInterval(timer);
  }, [rotating, slides.length]);

  if (!coverUrl) {
    return (
      <header className="galv-hero galv-hero-minimal">
        <h2>{hero.title}</h2>
        {hero.description && <p>{hero.description}</p>}
      </header>
    );
  }

  // Een eigen cover zit niet in de galerij; daar valt niets op te openen.
  const zoomable = !customCoverUrl && coverItem?.media_type === 'photo';
  const openCover = () => { if (zoomable && coverItem) onOpenPhoto(coverItem); };
  const shell = (name: string) => `galv-hero galv-hero-${name}${zoomable ? '' : ' is-static'}`;
  const text = (
    <div className="galv-hero-text">
      <h2>{hero.title}</h2>
      {hero.description && <p>{hero.description}</p>}
    </div>
  );
  const coverImage = (className?: string) => (
    <img className={className} src={coverUrl} alt={hero.title} style={{ objectPosition: position }} />
  );

  // ── Basis: het beeld lost onderaan op in de achtergrond, titel eronder ──
  if (hero.template === 'fade') {
    return (
      <header className={shell('fade')}>
        <div className="galv-hero-media" onClick={openCover}>
          {coverImage()}
        </div>
        {text}
      </header>
    );
  }

  // ── Modern: asymmetrisch, de titel valt over het beeld heen ──
  if (hero.template === 'editorial') {
    return (
      <header className={shell('editorial')}>
        <div className="galv-hero-media" onClick={openCover}>
          {coverImage()}
        </div>
        {text}
      </header>
    );
  }

  // ── Modern: beeld in een ruim kader, titel eronder in kapitalen ──
  if (hero.template === 'frame') {
    return (
      <header className={shell('frame')}>
        <div className="galv-hero-media" onClick={openCover}>
          {coverImage()}
        </div>
        {text}
      </header>
    );
  }

  // ── Modern: het beeld is te zien dóór de letters van de titel heen ──
  if (hero.template === 'cutout') {
    return (
      <header className={shell('cutout')}>
        {/* De titel blijft echte tekst: alleen de vulling is het beeld, dus
            selecteren en voorlezen werken gewoon. Browsers zonder
            background-clip krijgen via @supports de gewone tekstkleur. */}
        <h2
          className="galv-hero-cut"
          style={{ backgroundImage: `url("${coverUrl}")`, backgroundPosition: position }}
        >
          {hero.title}
        </h2>
        <div className="galv-hero-media galv-hero-band" onClick={openCover}>
          {coverImage()}
        </div>
        {hero.description && <p className="galv-hero-cut-sub">{hero.description}</p>}
      </header>
    );
  }

  // ── Modern: het beeld in de accentkleur van de beeldmaker ──
  if (hero.template === 'duotone') {
    return (
      <header className={shell('duotone')} onClick={openCover}>
        {coverImage('galv-hero-bg')}
        <span className="galv-hero-tint" aria-hidden="true" />
        <span className="galv-hero-veil" aria-hidden="true" />
        {text}
      </header>
    );
  }

  // ── Klassiek: gecentreerde titel tussen dunne lijnen, beeld eronder ──
  if (hero.template === 'classic') {
    return (
      <header className={shell('classic')}>
        {text}
        <div className="galv-hero-media" onClick={openCover}>
          {coverImage()}
        </div>
      </header>
    );
  }

  // ── Klassiek: het beeld in een staande boog, titel eronder ──
  if (hero.template === 'arch') {
    return (
      <header className={shell('arch')}>
        <div className="galv-hero-media" onClick={openCover}>
          {coverImage()}
        </div>
        {text}
      </header>
    );
  }

  // ── Klassiek: drie afdrukken schuin over elkaar, als op tafel ──
  if (hero.template === 'stack') {
    const prints = extras.slice(0, 2);
    return (
      <header className={shell('stack')}>
        <div className="galv-hero-stack-pile">
          {/* Achterste eerst, zodat de cover er bovenop komt te liggen. */}
          {prints.slice().reverse().map((print, index) => {
            const url = itemPreviewUrl(print, bundle);
            return url ? (
              <div
                key={print.id}
                className={`galv-hero-print galv-hero-print-${prints.length - index}`}
                onClick={() => onOpenPhoto(print)}
              >
                <img src={url} alt={print.file_name} loading="lazy" />
              </div>
            ) : null;
          })}
          <div className="galv-hero-print galv-hero-print-0" onClick={openCover}>
            {coverImage()}
          </div>
        </div>
        {text}
      </header>
    );
  }

  // ── Spectaculair: langzame zoom op het beeld, titel zweeft in ──
  if (hero.template === 'cinematic') {
    return (
      <header className={shell('cinematic')} onClick={openCover}>
        {coverImage('galv-hero-bg')}
        <span className="galv-hero-veil" aria-hidden="true" />
        {text}
      </header>
    );
  }

  // ── Spectaculair: de cover wisselt langzaam met de volgende beelden ──
  if (hero.template === 'slideshow') {
    return (
      <header className={shell('slideshow')} onClick={openCover}>
        {slides.map((url, index) => (
          <img
            key={url}
            className={`galv-hero-bg galv-hero-slide${index === slide ? ' is-active' : ''}`}
            src={url}
            alt={index === 0 ? hero.title : ''}
            aria-hidden={index === 0 ? undefined : true}
            style={{ objectPosition: index === 0 ? position : undefined }}
          />
        ))}
        <span className="galv-hero-veil" aria-hidden="true" />
        {text}
      </header>
    );
  }

  // ── Spectaculair: mozaïek van meerdere beelden achter de titel ──
  if (hero.template === 'mosaic') {
    const tiles = [coverUrl, ...extras.map(p => itemPreviewUrl(p, bundle))]
      .filter((url): url is string => Boolean(url))
      .slice(0, 9);
    return (
      // Het mozaïek is een achtergrond, geen bladerbare tegels; er valt hier
      // niets te openen, ook niet als de cover een gewone foto is.
      <header className="galv-hero galv-hero-mosaic is-static">
        <div className="galv-hero-mosaic-grid" aria-hidden="true">
          {tiles.map((url, index) => (
            // Elke tegel drijft met een eigen vertraging; bij "minder beweging"
            // zet de globale reduced-motion-regel dit stil.
            <span key={url} className="galv-hero-mosaic-cell" style={{ animationDelay: `${index * 0.35}s` }}>
              <img src={url} alt="" loading="lazy" />
            </span>
          ))}
        </div>
        <span className="galv-hero-veil" aria-hidden="true" />
        {text}
      </header>
    );
  }

  if (hero.template === 'split') {
    return (
      <header className={shell('split')}>
        <div className="galv-hero-media" onClick={openCover}>
          {coverImage()}
        </div>
        {text}
      </header>
    );
  }

  if (hero.template === 'collage') {
    const side = extras.slice(0, 2);
    return (
      <header className={shell('collage')}>
        <div className="galv-hero-collage-grid">
          <div className="galv-hero-media galv-hero-lead" onClick={openCover}>
            {coverImage()}
          </div>
          {side.map(extra => {
            const url = itemPreviewUrl(extra, bundle);
            return url ? (
              <div key={extra.id} className="galv-hero-media" onClick={() => onOpenPhoto(extra)}>
                <img src={url} alt={extra.file_name} loading="lazy" />
              </div>
            ) : null;
          })}
        </div>
        {text}
      </header>
    );
  }

  // 'full' — schermvullend beeld met de titel eroverheen.
  return (
    <header className={shell('full')} onClick={openCover}>
      {coverImage('galv-hero-bg')}
      <span className="galv-hero-veil" aria-hidden="true" />
      {text}
    </header>
  );
}
