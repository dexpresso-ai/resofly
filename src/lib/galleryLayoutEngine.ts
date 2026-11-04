// De rekenregels achter de weergave van een galerij.
//
// Per indeling één pure functie die, bij een gegeven breedte, de plek en maat
// van elke foto uitrekent. Geen React en geen DOM: de galerij bij de klant en
// het voorbeeld in de instellingen gebruiken precies deze code, dus wat de
// fotograaf in het voorbeeld ziet, is wat de klant krijgt. Getest in
// galleryLayoutEngine.test.ts.
//
// Waarom de posities hier worden uitgerekend en niet aan CSS worden
// overgelaten: CSS kent geen "waterval" met beelden die over twee kolommen
// lopen, geen rijen die precies de breedte vullen zonder bij te snijden, en geen
// mozaïek dat de volgorde van de fotograaf aanhoudt. En wat we zelf uitrekenen,
// kunnen we op hele pixels afronden: bij "Naadloos" (0 px) geeft een halve
// pixel anders een haarlijn tussen twee foto's.
//
// Speelsheid is DETERMINISTISCH: geen Math.random, maar een hash van het
// item-id. Elke kijker ziet dus hetzelfde album, en een tegel springt niet naar
// een andere plek zodra de pagina opnieuw tekent.
//
// Alleen type-imports: dit bestand moet in node draaien zonder bundler.
import type { GalleryLayout, GalleryLayoutStyle, GalleryTileShape } from './galleryLayout';

/** Wat de rekenregels van een foto moeten weten. */
export type LayoutPhoto = {
  id: string;
  width: number | null;
  height: number | null;
  /** Door de fotograaf uitgelicht: krijgt altijd een grote plek. */
  featured?: boolean | null;
};

export type LayoutTile = {
  id: string;
  /** Positie en maat in hele CSS-pixels, binnen de container. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Groter dan de rest: uitgelicht door de fotograaf, of door de speelsheid. */
  emphasis: boolean;
  /** Alleen bij afdrukken: de draaiing in graden. */
  rotate: number;
  /** Alleen bij afdrukken: de papierrand rondom en onderaan, in px. */
  paper: number;
  paperBottom: number;
};

export type PhotoLayoutPlan = {
  tiles: LayoutTile[];
  /** Hoogte van de container in px. */
  height: number;
  /** De tussenruimte zoals die op deze breedte uitvalt. */
  gap: number;
  /** Kolommen op deze breedte; bij rijen het aantal foto's per rij bij benadering. */
  columns: number;
  /** Dikte van een passe-partout, passend bij de tegelmaat. */
  mat: number;
};

export type LayoutContext = {
  /** Breedte van de container in CSS-pixels. */
  width: number;
  /** Vermenigvuldiger voor grootbeeld (tv/beamer); alleen bij automatische maten. */
  scale?: number;
  /** Hoogte van het venster; begrenst hoe groot één beeld mag worden. */
  viewportHeight?: number;
};

/** Onder deze containerbreedte rekenen we als op een telefoon. */
export const LAYOUT_PHONE_MAX = 560;
/** Onder deze containerbreedte als op een tablet. */
export const LAYOUT_TABLET_MAX = 980;

export type LayoutDevice = 'phone' | 'tablet' | 'desktop';

export function deviceOf(width: number): LayoutDevice {
  if (width < LAYOUT_PHONE_MAX) return 'phone';
  if (width < LAYOUT_TABLET_MAX) return 'tablet';
  return 'desktop';
}

const FALLBACK_RATIO = 3 / 2;
/** Een gemiddelde foto, om "n per rij" in een rijhoogte om te rekenen. */
const TYPICAL_RATIO = 3 / 2;

/**
 * Beeldverhouding van een foto. Extreme panorama's en stroken worden begrensd,
 * anders duwen ze een hele rij plat. Zonder maten: 3:2, de meest voorkomende.
 */
export function aspectRatioOf(photo: LayoutPhoto): number {
  if (photo.width && photo.height && photo.width > 0 && photo.height > 0) {
    return Math.min(4, Math.max(0.35, photo.width / photo.height));
  }
  return FALLBACK_RATIO;
}

/**
 * Streefhoogte van een rij bij automatische kolommen. Ongewijzigd overgenomen
 * van vóór de weergave-instellingen: dit is de standaard, en een bestaande
 * galerij moet er na de uitrol precies zo uitzien.
 */
export function targetRowHeight(width: number): number {
  if (width < 520) return 150;
  if (width < 900) return 200;
  if (width < 1400) return 250;
  return 290;
}

/**
 * De tussenruimte op deze breedte. Op een telefoon is 32 px wit tussen twee
 * foto's van 180 px breed geen lucht meer maar een gat, dus krimpt royale
 * ruimte mee. Tot 8 px blijft het (bijna) zoals het is — de standaard van 6 px
 * werd op een telefoon al 4 px, en zo blijft dat.
 */
export function effectiveGap(gap: number, width: number): number {
  if (gap <= 0) return 0;
  const device = deviceOf(width);
  if (device === 'desktop') return gap;
  if (device === 'tablet') return gap <= 8 ? gap : Math.max(8, Math.round(gap * 0.75));
  return gap <= 8 ? Math.round((gap * 2) / 3) : Math.max(6, Math.round(gap * 0.5));
}

/**
 * Het aantal kolommen dat de fotograaf heeft gekozen, vertaald naar deze
 * breedte. `null` = automatisch. Op een tablet zit het tussen telefoon en breed
 * scherm in, naar verhouding van de breedte: vier kolommen op 1200 px zijn er
 * drie op 820 px, en niet vier smalle stroken.
 */
function explicitColumns(layout: GalleryLayout, width: number): number | null {
  const device = deviceOf(width);
  if (device === 'phone') {
    if (layout.phone_columns != null) return layout.phone_columns;
    if (layout.columns != null) return Math.min(layout.columns, 2);
    return null;
  }
  if (layout.columns == null) return null;
  if (device === 'desktop') return layout.columns;
  const low = Math.min(layout.phone_columns ?? 2, layout.columns);
  return Math.min(layout.columns, Math.max(low, Math.round((layout.columns * width) / 1180)));
}

const AUTO_COLUMN_WIDTH: Record<Exclude<GalleryLayoutStyle, 'rows' | 'story'>, number> = {
  masonry: 300,
  grid: 280,
  prints: 300,
};
const AUTO_COLUMN_MAX: Record<Exclude<GalleryLayoutStyle, 'rows' | 'story'>, number> = {
  masonry: 6,
  grid: 8,
  prints: 6,
};

/** Kolommen voor waterval, raster en afdrukken. */
export function columnsFor(layout: GalleryLayout, width: number, scale = 1): number {
  const explicit = explicitColumns(layout, width);
  if (explicit != null) return Math.max(1, explicit);
  if (layout.style === 'rows' || layout.style === 'story') return 1;
  if (deviceOf(width) === 'phone') return 2;
  const target = AUTO_COLUMN_WIDTH[layout.style] * scale;
  return Math.min(AUTO_COLUMN_MAX[layout.style], Math.max(2, Math.round(width / target)));
}

/** Streefhoogte van een rij: automatisch, of afgeleid van "n foto's per rij". */
function rowBase(layout: GalleryLayout, width: number, gap: number, scale: number): number {
  const n = explicitColumns(layout, width);
  if (n == null) return targetRowHeight(width) * scale;
  return Math.max(48, (width - gap * (n - 1)) / (n * TYPICAL_RATIO));
}

/**
 * Een vast getal tussen 0 en 1 per item (FNV-1a met een eindmix). Het `salt`
 * geeft per eigenschap een eigen reeks, zodat draaiing en verschuiving van een
 * afdruk niet samen opgaan.
 */
export function hashUnit(id: string, salt: number): number {
  let h = (0x811c9dc5 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

type Draft = Omit<LayoutTile, 'rotate' | 'paper' | 'paperBottom'> & Partial<Pick<LayoutTile, 'rotate' | 'paper' | 'paperBottom'>>;

/**
 * Hele pixels, via de randen en niet via de maat: twee buren delen dan exact
 * dezelfde rand, en bij 0 px tussenruimte valt er nooit een haarlijn tussen.
 */
function snap(tile: Draft): LayoutTile {
  const x0 = Math.round(tile.x);
  const y0 = Math.round(tile.y);
  return {
    id: tile.id,
    x: x0,
    y: y0,
    w: Math.max(1, Math.round(tile.x + tile.w) - x0),
    h: Math.max(1, Math.round(tile.y + tile.h) - y0),
    emphasis: tile.emphasis,
    rotate: tile.rotate ?? 0,
    paper: tile.paper ?? 0,
    paperBottom: tile.paperBottom ?? 0,
  };
}

// ── Rijen ───────────────────────────────────────────────────────────────────
//
// Elke rij krijgt precies de containerbreedte: we tellen de beeldverhoudingen
// op en leiden daar de rijhoogte uit af, dus elke foto blijft heel. De laatste
// rij wordt óók volgemaakt; dreigt die te hoog te worden, dan schuiven er foto's
// uit de rij erboven bij.
//
// Speelsheid varieert de streefhoogte per rij. Een hogere streefhoogte sluit
// een rij eerder af, met minder en dus grotere foto's — ritme zonder dat een
// rand uit de lijn raakt.
//
// Een uitgelichte foto krijgt een eigen rij. Valt hij midden in een rij die
// daarmee te kort zou blijven (één of twee foto's die de breedte niet kunnen
// vullen), dan wacht hij tot die rij vol is en komt hij direct daarna. Zo staan
// er nooit halflege stukjes rij tussen twee grote foto's. In de documentvolgorde
// (Tab, schermlezer) blijft hij op zijn eigen plek: zie planPhotoLayout.

const ROW_RHYTHM: number[][] = [
  [1],
  [1, 1, 1, 1.6],
  [1, 0.82, 1.7, 1, 0.88, 1.35],
  [1.9, 0.74, 1.12, 0.7, 1.55, 0.86, 2.2, 0.8],
];
/** Boven deze factor maal de streefhoogte oogt een laatste rij als een uitvergroting. */
const LAST_ROW_MAX_FACTOR = 1.45;
/**
 * Een rij die niet meer in te vullen is (één staande foto op het eind, zonder
 * buren om te lenen) zou de volle breedte nemen: bij 1200 px een foto van
 * 1800 px hoog. Boven deze factor begrenzen we hem en zetten we hem in het
 * midden.
 */
const LONE_ROW_MAX_FACTOR = 2.4;
/** Hoe hoog een uitgelichte rij mag worden, ten opzichte van de streefhoogte. */
const FEATURE_ROW_FACTOR = 2.3;

type Row = { items: LayoutPhoto[]; height: number; emphasis: boolean };

function layoutRows(photos: LayoutPhoto[], width: number, gap: number, base: number, playfulness: number, maxHeight: number): Draft[] {
  const rhythm = ROW_RHYTHM[playfulness] ?? ROW_RHYTHM[0];
  const heightOf = (list: LayoutPhoto[]) => {
    const sum = list.reduce((total, photo) => total + aspectRatioOf(photo), 0);
    return sum > 0 ? (width - gap * (list.length - 1)) / sum : base;
  };
  const rows: Row[] = [];
  const target = () => base * rhythm[rows.length % rhythm.length];
  const pushFeatured = (photo: LayoutPhoto) => {
    rows.push({ items: [photo], height: Math.min(width / aspectRatioOf(photo), base * FEATURE_ROW_FACTOR, maxHeight), emphasis: true });
  };
  const waiting: LayoutPhoto[] = [];
  const releaseWaiting = () => { while (waiting.length > 0) pushFeatured(waiting.shift() as LayoutPhoto); };
  let current: LayoutPhoto[] = [];

  for (const photo of photos) {
    if (photo.featured) {
      if (current.length === 0) { pushFeatured(photo); continue; }
      // Leest wat er al ligt nog als een rij (hooguit iets hoger dan bedoeld)?
      // Dan sluiten we hem hier en komt de grote foto er meteen onder.
      const height = heightOf(current);
      if (height <= target() * LAST_ROW_MAX_FACTOR) {
        rows.push({ items: current, height, emphasis: false });
        current = [];
        pushFeatured(photo);
      } else {
        waiting.push(photo);
      }
      continue;
    }
    current.push(photo);
    if (heightOf(current) <= target()) {
      rows.push({ items: current, height: heightOf(current), emphasis: false });
      current = [];
      releaseWaiting();
    }
  }

  if (current.length > 0) {
    const goal = target();
    let height = heightOf(current);
    let guard = 0;
    // Te hoog: foto's uit de gewone rij erboven erbij halen. Nooit uit een
    // uitgelichte rij — die hoort alleen te staan.
    while (height > goal * LAST_ROW_MAX_FACTOR && guard < 20) {
      const previous = rows[rows.length - 1];
      if (!previous || previous.emphasis || previous.items.length <= 1) break;
      const moved = previous.items.pop() as LayoutPhoto;
      previous.height = heightOf(previous.items);
      current = [moved, ...current];
      height = heightOf(current);
      guard += 1;
    }
    rows.push({ items: current, height: Math.min(height, goal * LONE_ROW_MAX_FACTOR, maxHeight), emphasis: false });
  }
  releaseWaiting();

  const tiles: Draft[] = [];
  let y = 0;
  for (const row of rows) {
    const widths = row.items.map(photo => aspectRatioOf(photo) * row.height);
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * (row.items.length - 1);
    // Een begrensde rij vult de breedte niet meer; die staat in het midden.
    let x = total < width - 0.5 ? (width - total) / 2 : 0;
    row.items.forEach((photo, index) => {
      tiles.push({ id: photo.id, x, y, w: widths[index], h: row.height, emphasis: row.emphasis });
      x += widths[index] + gap;
    });
    y += row.height + gap;
  }
  return tiles;
}

// ── Waterval ────────────────────────────────────────────────────────────────
//
// Elke foto gaat in de kolom die op dat moment het kortst is, in haar eigen
// verhouding. Uitgelichte foto's (en bij speelsheid af en toe een liggende)
// lopen over twee kolommen. Bij "Speels" en "Uitbundig" beginnen de kolommen
// verspringend, zoals een prikbord.

const MASONRY_STAGGER: number[][] = [[0], [0], [0, 0.24], [0, 0.46, 0.16, 0.62]];
/** Elke zoveelste liggende foto loopt over twee kolommen; 0 = nooit. */
const MASONRY_WIDE_EVERY = [0, 13, 8, 5];

function layoutMasonry(photos: LayoutPhoto[], width: number, gap: number, columns: number, playfulness: number, maxHeight: number): Draft[] {
  const n = Math.max(1, columns);
  const columnWidth = (width - gap * (n - 1)) / n;
  const stagger = n >= 2 ? MASONRY_STAGGER[playfulness] ?? [0] : [0];
  const heights = Array.from({ length: n }, (_, c) => stagger[c % stagger.length] * columnWidth);
  const wideEvery = MASONRY_WIDE_EVERY[playfulness] ?? 0;
  const tiles: Draft[] = [];
  let landscapes = 0;

  for (const photo of photos) {
    const ratio = aspectRatioOf(photo);
    let span = 1;
    let emphasis = false;
    if (photo.featured && n >= 2) {
      span = n >= 5 ? 3 : 2;
      emphasis = true;
    } else if (n >= 3 && wideEvery > 0 && ratio >= 1.25) {
      landscapes += 1;
      if (landscapes % wideEvery === 0) { span = 2; emphasis = true; }
    }

    // De plek waar de (eventueel brede) foto het hoogst kan beginnen; bij
    // gelijkspel de meest linkse, zodat de leesvolgorde klopt.
    let column = 0;
    let top = Number.POSITIVE_INFINITY;
    for (let c = 0; c <= n - span; c += 1) {
      let start = 0;
      for (let k = 0; k < span; k += 1) start = Math.max(start, heights[c + k]);
      if (start < top - 0.5) { top = start; column = c; }
    }

    const slot = span * columnWidth + (span - 1) * gap;
    let w = slot;
    let h = slot / ratio;
    // Een staande foto over twee kolommen zou hoger worden dan het venster.
    if (h > maxHeight) { h = maxHeight; w = h * ratio; }
    tiles.push({ id: photo.id, x: column * (columnWidth + gap) + (slot - w) / 2, y: top, w, h, emphasis });
    for (let k = 0; k < span; k += 1) heights[column + k] = top + h + gap;
  }
  return tiles;
}

// ── Raster ──────────────────────────────────────────────────────────────────
//
// Gelijke tegels in één vorm. Grote (2×2) en brede (2×1) tegels worden op de
// eerste vrije plek gezet die past; kleine tegels vullen de gaten die dat
// achterlaat. Automatische grote tegels komen alleen op een plek waar ze geen
// gat maken — tegen de linker- of rechterrand, op de eerstvolgende vrije cel —
// zodat de volgorde van de fotograaf intact blijft. Bij een uitgelichte foto
// kan een kleine tegel daardoor één plek naar voren schuiven.

const GRID_BIG_EVERY = [0, 15, 9, 6];
const GRID_WIDE_EVERY = [0, 0, 11, 6];
const TILE_SHAPE_RATIO: Record<GalleryTileShape, number> = { square: 1, portrait: 4 / 5, landscape: 3 / 2 };

function layoutGrid(photos: LayoutPhoto[], width: number, gap: number, columns: number, playfulness: number, shape: GalleryTileShape): Draft[] {
  const n = Math.max(1, columns);
  const cellW = (width - gap * (n - 1)) / n;
  const cellH = cellW / TILE_SHAPE_RATIO[shape];
  const taken: boolean[][] = [];
  const free = (r: number, c: number) => !taken[r]?.[c];
  const fits = (r: number, c: number, rs: number, cs: number) => {
    if (c < 0 || c + cs > n) return false;
    for (let dr = 0; dr < rs; dr += 1) for (let dc = 0; dc < cs; dc += 1) if (!free(r + dr, c + dc)) return false;
    return true;
  };
  const take = (r: number, c: number, rs: number, cs: number) => {
    for (let dr = 0; dr < rs; dr += 1) {
      taken[r + dr] ??= new Array(n).fill(false);
      for (let dc = 0; dc < cs; dc += 1) taken[r + dr][c + dc] = true;
    }
  };
  let frontier = 0;
  const firstFree = (): [number, number] => {
    for (let r = frontier; ; r += 1) {
      for (let c = 0; c < n; c += 1) if (free(r, c)) return [r, c];
      frontier = r + 1;
    }
  };
  const firstFit = (rs: number, cs: number): [number, number] => {
    for (let r = frontier; ; r += 1) {
      for (let c = 0; c + cs <= n; c += 1) if (fits(r, c, rs, cs)) return [r, c];
    }
  };

  const bigEvery = GRID_BIG_EVERY[playfulness] ?? 0;
  const wideEvery = GRID_WIDE_EVERY[playfulness] ?? 0;
  let sinceBig = 0;
  let sinceWide = 0;
  const tiles: Draft[] = [];

  photos.forEach((photo, index) => {
    let rs = 1;
    let cs = 1;
    let emphasis = false;
    if (photo.featured && n >= 2) {
      rs = 2; cs = 2; emphasis = true; sinceBig = 0;
    } else if (n >= 2 && bigEvery > 0) {
      sinceBig += 1;
      sinceWide += 1;
      const [r, c] = firstFree();
      // ±1 op het ritme, zodat het niet als een metronoom gaat tikken.
      const due = bigEvery + Math.floor(hashUnit(photo.id, 5) * 3) - 1;
      // Vlak voor het einde geen grote tegel meer: naast hem moeten nog twee
      // rijen gevuld worden, anders eindigt het album met een halflege rij.
      const enoughLeft = photos.length - index - 1 >= 2 * (n - 2);
      if (sinceBig >= due && enoughLeft && (c === 0 || c === n - 2) && fits(r, c, 2, 2)) {
        rs = 2; cs = 2; emphasis = true; sinceBig = 0;
      } else if (n >= 3 && wideEvery > 0 && sinceWide >= wideEvery && aspectRatioOf(photo) >= 1.4 && fits(r, c, 1, 2)) {
        cs = 2; emphasis = true; sinceWide = 0;
      }
    }
    const [r, c] = rs === 1 && cs === 1 ? firstFree() : firstFit(rs, cs);
    take(r, c, rs, cs);
    tiles.push({
      id: photo.id,
      x: c * (cellW + gap),
      y: r * (cellH + gap),
      w: cs * cellW + (cs - 1) * gap,
      h: rs * cellH + (rs - 1) * gap,
      emphasis,
    });
  });
  return tiles;
}

// ── Verhaal ─────────────────────────────────────────────────────────────────
//
// Een tijdschrift in plaats van een raster: per regel één, twee of drie beelden,
// gekozen op hun vorm. Een liggende foto staat alleen en breed; staande foto's
// komen in paren. Ruim wit tussen de regels. Speelsheid laat staande foto's van
// links naar rechts wisselen, maakt liggende foto's soms smaller, zet paren licht
// verspringend en vormt af en toe een drieluik.

const STORY_LANDSCAPE: number[][] = [[1], [1], [1, 0.86], [1, 0.74, 0.9]];
const STORY_PORTRAIT = [0.56, 0.52, 0.5, 0.46];
const STORY_SQUARE = [0.7, 0.66, 0.62, 0.58];
const STORY_STAGGER = [0, 0, 0.08, 0.16];

type Orientation = 'landscape' | 'portrait' | 'square';
function orientationOf(ratio: number): Orientation {
  if (ratio >= 1.2) return 'landscape';
  if (ratio <= 0.85) return 'portrait';
  return 'square';
}

function layoutStory(photos: LayoutPhoto[], width: number, gap: number, playfulness: number, maxHeight: number, phone: boolean): { tiles: Draft[]; between: number } {
  const inner = gap === 0 ? 0 : Math.max(4, gap);
  const between = gap === 0 ? 0 : Math.max(16, Math.round(gap * 2.6));
  const tiles: Draft[] = [];
  let y = 0;
  let turn = 0;

  const solo = (photo: LayoutPhoto, factor: number, align: 'start' | 'center' | 'end', emphasis: boolean) => {
    const ratio = aspectRatioOf(photo);
    let w = width * factor;
    let h = w / ratio;
    if (h > maxHeight) { h = maxHeight; w = h * ratio; }
    const x = align === 'center' ? (width - w) / 2 : align === 'start' ? 0 : width - w;
    tiles.push({ id: photo.id, x, y, w, h, emphasis });
    y += h + between;
  };

  const group = (list: LayoutPhoto[], staggered: boolean) => {
    const ratios = list.map(aspectRatioOf);
    const sum = ratios.reduce((total, r) => total + r, 0);
    const h = Math.min(maxHeight, (width - inner * (list.length - 1)) / sum);
    const total = h * sum + inner * (list.length - 1);
    const offset = staggered ? h * (STORY_STAGGER[playfulness] ?? 0) : 0;
    let x = (width - total) / 2;
    list.forEach((photo, index) => {
      // Om en om zakt het linker of het rechter beeld een stukje.
      const dy = offset > 0 && index % 2 === turn % 2 ? offset : 0;
      tiles.push({ id: photo.id, x, y: y + dy, w: ratios[index] * h, h, emphasis: false });
      x += ratios[index] * h + inner;
    });
    y += h + offset + between;
  };

  let i = 0;
  while (i < photos.length) {
    const a = photos[i];
    const b = photos[i + 1];
    const c = photos[i + 2];
    const oa = orientationOf(aspectRatioOf(a));
    // Een uitgelichte buur hoort niet in een paar: die krijgt zijn eigen regel.
    const ob = b && !b.featured ? orientationOf(aspectRatioOf(b)) : null;
    const oc = c && !c.featured ? orientationOf(aspectRatioOf(c)) : null;
    const alternate: 'start' | 'end' | 'center' = playfulness >= 1 ? (turn % 2 === 0 ? 'start' : 'end') : 'center';

    if (a.featured) {
      solo(a, 1, 'center', true);
      i += 1;
    } else if (oa === 'landscape') {
      if (playfulness >= 2 && !phone && ob === 'portrait' && hashUnit(a.id, 7) < 0.45) {
        group([a, b], true);
        i += 2;
      } else {
        const factors = phone ? [1] : STORY_LANDSCAPE[playfulness] ?? [1];
        const factor = factors[turn % factors.length];
        solo(a, factor, factor < 1 ? alternate : 'center', false);
        i += 1;
      }
    } else if (ob && ob !== 'landscape') {
      if (playfulness >= 2 && !phone && oa === 'portrait' && ob === 'portrait' && oc === 'portrait' && hashUnit(a.id, 11) < 0.4) {
        group([a, b, c], false);
        i += 3;
      } else {
        group([a, b], playfulness >= 2 && !phone);
        i += 2;
      }
    } else if (playfulness >= 2 && !phone && ob === 'landscape' && hashUnit(a.id, 13) < 0.5) {
      // Een staande foto vóór een liggende: samen een asymmetrisch paar, in
      // plaats van een smalle foto met een vlak leegte ernaast.
      group([a, b], true);
      i += 2;
    } else {
      const factor = phone
        ? (oa === 'portrait' ? 0.86 : 0.92)
        : oa === 'portrait' ? STORY_PORTRAIT[playfulness] ?? 0.56 : STORY_SQUARE[playfulness] ?? 0.7;
      solo(a, factor, phone ? 'center' : alternate, false);
      i += 1;
    }
    turn += 1;
  }
  return { tiles, between };
}

// ── Afdrukken ───────────────────────────────────────────────────────────────
//
// Elke foto als een afdruk met een witte rand. Liggend en staand krijgen
// dezelfde lange zijde, zoals echte afdrukken van 10×15: zo blijven de rijen
// even hoog. Speelsheid draait en verschuift ze een beetje; bij "Uitbundig"
// krijgen ze een polaroidrand. Een rij die niet vol is, staat in het midden.

const PRINT_ROTATION = [0, 1.4, 2.8, 4.6];
const PRINT_SHIFT = [0, 0.015, 0.04, 0.07];

function layoutPrints(photos: LayoutPhoto[], width: number, gap: number, columns: number, playfulness: number): { tiles: Draft[]; extra: number } {
  const n = Math.max(1, columns);
  const cellW = (width - gap * (n - 1)) / n;
  const rows: Array<Array<{ photo: LayoutPhoto; span: number }>> = [];
  let current: Array<{ photo: LayoutPhoto; span: number }> = [];
  let used = 0;
  for (const photo of photos) {
    const span = photo.featured && n >= 2 ? 2 : 1;
    if (used + span > n && current.length > 0) { rows.push(current); current = []; used = 0; }
    current.push({ photo, span });
    used += span;
  }
  if (current.length > 0) rows.push(current);

  const shift = (PRINT_SHIFT[playfulness] ?? 0) * cellW;
  const rotation = PRINT_ROTATION[playfulness] ?? 0;
  const tiles: Draft[] = [];
  let y = shift;
  for (const row of rows) {
    const prints = row.map(({ photo, span }) => {
      const slot = span * cellW + (span - 1) * gap;
      // 86% van de cel: de rest is lucht voor het draaien en verschuiven.
      const long = slot * 0.86;
      const ratio = aspectRatioOf(photo);
      const side = Math.max(3, Math.round(long * 0.045));
      const bottom = playfulness >= 3 ? Math.round(side * 3.2) : side;
      const photoW = ratio >= 1 ? long : long * ratio;
      const photoH = ratio >= 1 ? long / ratio : long;
      return { photo, span, slot, side, bottom, w: photoW + side * 2, h: photoH + side + bottom };
    });
    const rowH = Math.max(...prints.map(print => print.h));
    const usedW = prints.reduce((sum, print) => sum + print.slot, 0) + gap * (prints.length - 1);
    let x = (width - usedW) / 2;
    for (const print of prints) {
      const id = print.photo.id;
      const dx = (hashUnit(id, 2) - 0.5) * 2 * shift;
      const dy = (hashUnit(id, 3) - 0.5) * 2 * shift;
      tiles.push({
        id,
        // Verschuiven mag, over de rand van het album heen niet: alleen de
        // draaiing steekt er dan nog een paar pixels buiten.
        x: Math.min(Math.max(0, x + (print.slot - print.w) / 2 + dx), width - print.w),
        y: y + (rowH - print.h) / 2 + dy,
        w: print.w,
        h: print.h,
        emphasis: print.span > 1,
        rotate: Math.round((hashUnit(id, 1) - 0.5) * 2 * rotation * 10) / 10,
        paper: print.side,
        paperBottom: print.bottom,
      });
      x += print.slot + gap;
    }
    y += rowH + gap;
  }
  return { tiles, extra: shift };
}

// ── Eén ingang ──────────────────────────────────────────────────────────────

const emptyPlan = (): PhotoLayoutPlan => ({ tiles: [], height: 0, gap: 0, columns: 0, mat: 0 });

/** Passe-partout: zo'n 4% van een gemiddelde tegel, tussen 3 en 12 px. */
function matFor(typical: number): number {
  return Math.min(12, Math.max(3, Math.round(typical * 0.04)));
}

/** Hoogte van de container: de onderkant van de laagste tegel. */
function bottomOf(tiles: LayoutTile[]): number {
  return tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0);
}

/**
 * Rekent de weergave uit voor deze foto's op deze breedte. De volgorde van
 * `tiles` is de volgorde van `photos`: de leesvolgorde (en die van Tab) blijft
 * die van de fotograaf.
 */
export function planPhotoLayout(photos: LayoutPhoto[], layout: GalleryLayout, context: LayoutContext): PhotoLayoutPlan {
  const plan = planUnordered(photos, layout, context);
  // De tegels in de volgorde van de fotograaf, ook waar een uitgelichte foto
  // (rijen) of een grote tegel (raster) een plekje opschuift. Dat is de volgorde
  // in het document — en dus die van Tab, van een schermlezer en van het
  // binnenkomen bij het scrollen.
  const order = new Map(photos.map((photo, index) => [photo.id, index]));
  plan.tiles.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return plan;
}

function planUnordered(photos: LayoutPhoto[], layout: GalleryLayout, context: LayoutContext): PhotoLayoutPlan {
  const width = Math.floor(context.width);
  if (!(width > 0) || photos.length === 0) return emptyPlan();
  const scale = context.scale && context.scale > 0 ? context.scale : 1;
  // Eén beeld mag nooit hoger worden dan het venster: dan zie je het nergens heel.
  const maxHeight = Math.max(320, (context.viewportHeight && context.viewportHeight > 0 ? context.viewportHeight : 900) * 0.88);
  const gap = effectiveGap(layout.gap, width);
  const playfulness = layout.playfulness;

  switch (layout.style) {
    case 'masonry': {
      const columns = columnsFor(layout, width, scale);
      const tiles = layoutMasonry(photos, width, gap, columns, playfulness, maxHeight).map(snap);
      return { tiles, height: bottomOf(tiles), gap, columns, mat: matFor((width - gap * (columns - 1)) / columns) };
    }
    case 'grid': {
      const columns = columnsFor(layout, width, scale);
      const tiles = layoutGrid(photos, width, gap, columns, playfulness, layout.tile_shape).map(snap);
      return { tiles, height: bottomOf(tiles), gap, columns, mat: matFor((width - gap * (columns - 1)) / columns) };
    }
    case 'story': {
      const { tiles: drafts } = layoutStory(photos, width, gap, playfulness, maxHeight, deviceOf(width) === 'phone');
      const tiles = drafts.map(snap);
      return { tiles, height: bottomOf(tiles), gap, columns: 1, mat: matFor(width * 0.25) };
    }
    case 'prints': {
      const columns = columnsFor(layout, width, scale);
      const { tiles: drafts, extra } = layoutPrints(photos, width, gap, columns, playfulness);
      const tiles = drafts.map(snap);
      return { tiles, height: Math.round(bottomOf(tiles) + extra), gap, columns, mat: 0 };
    }
    case 'rows':
    default: {
      const base = rowBase(layout, width, gap, scale);
      const tiles = layoutRows(photos, width, gap, base, playfulness, maxHeight).map(snap);
      const columns = explicitColumns(layout, width) ?? Math.max(1, Math.round(width / (base * TYPICAL_RATIO)));
      return { tiles, height: bottomOf(tiles), gap, columns, mat: matFor(base) };
    }
  }
}
