// Weergave van een galerij: hoe de foto's en video's in het album staan.
//
// Dit staat bewust los van de OPENING (hero, coverbeeld, uitsnede): die bepaalt
// de kop van de pagina, dit bepaalt alles daaronder — de indeling, de
// witruimte, het aantal kolommen en hoe speels het album oogt.
//
// Eén object per galerij, in `galleries.layout` (jsonb). De standaardwaarden
// geven precies de weergave van vóór deze instellingen — rijen die de breedte
// vullen, 6 px tussenruimte, zacht afgeronde hoeken — zodat een bestaande
// galerij er na de uitrol exact hetzelfde uitziet.
//
// SPIEGEL: supabase/functions/_shared/galleryLayout.ts is een kopie van dit
// bestand voor de edge functions (die saneren wat er naar buiten gaat) en voor
// Gerrie (die de instellingen kan zetten). src/lib/galleryLayout.test.ts houdt
// de twee gelijk. De database bewaakt dezelfde regels met een trigger
// (migratie 20261104065000).
//
// Geen imports: dit bestand draait ongewijzigd in de browser, in node (tests)
// en in Deno.

export const GALLERY_LAYOUT_STYLES = ['rows', 'masonry', 'grid', 'story', 'prints'] as const;
export const GALLERY_LAYOUT_WIDTHS = ['full', 'wide', 'medium', 'narrow'] as const;
export const GALLERY_SECTION_SPACINGS = ['tight', 'normal', 'airy', 'grand'] as const;
export const GALLERY_TILE_SHAPES = ['square', 'portrait', 'landscape'] as const;
export const GALLERY_CORNERS = ['square', 'subtle', 'soft', 'round'] as const;
export const GALLERY_FRAMES = ['none', 'mat', 'line', 'shadow'] as const;
export const GALLERY_HOVERS = ['zoom', 'lift', 'none'] as const;
export const GALLERY_HEADINGS = ['label', 'title', 'numbered'] as const;
export const GALLERY_VIDEO_LAYOUTS = ['auto', 'rows', 'grid'] as const;
export const GALLERY_VIDEO_SIZES = ['small', 'medium', 'large'] as const;

export type GalleryLayoutStyle = typeof GALLERY_LAYOUT_STYLES[number];
export type GalleryLayoutWidth = typeof GALLERY_LAYOUT_WIDTHS[number];
export type GallerySectionSpacing = typeof GALLERY_SECTION_SPACINGS[number];
export type GalleryTileShape = typeof GALLERY_TILE_SHAPES[number];
export type GalleryCorners = typeof GALLERY_CORNERS[number];
export type GalleryFrame = typeof GALLERY_FRAMES[number];
export type GalleryHover = typeof GALLERY_HOVERS[number];
export type GalleryHeadings = typeof GALLERY_HEADINGS[number];
export type GalleryVideoLayout = typeof GALLERY_VIDEO_LAYOUTS[number];
export type GalleryVideoSize = typeof GALLERY_VIDEO_SIZES[number];
export type GalleryPlayfulness = 0 | 1 | 2 | 3;

/** Grenzen van de getallen; dezelfde als in de databasetrigger. */
export const GALLERY_LAYOUT_LIMITS = {
  columns: { min: 1, max: 8 },
  phone_columns: { min: 1, max: 3 },
  gap: { min: 0, max: 64 },
  playfulness: { min: 0, max: 3 },
} as const;

export interface GalleryLayout {
  /** De indeling van de foto's. */
  style: GalleryLayoutStyle;
  /**
   * Kolommen op een breed scherm. Bij "Rijen" is dit het aantal foto's per rij
   * (bij benadering — elke foto houdt haar eigen verhouding). `null` =
   * automatisch: de galerij kiest zelf, naar de breedte van het scherm.
   */
  columns: number | null;
  /** Kolommen op een telefoon; `null` = automatisch. */
  phone_columns: number | null;
  /** Tussenruimte tussen de beelden in px, op een breed scherm. Op een telefoon kleiner. */
  gap: number;
  /** Hoe breed het album hooguit wordt; de rest is witruimte eromheen. */
  width: GalleryLayoutWidth;
  /** Ruimte tussen de hoofdstukken (categorieën). */
  section_spacing: GallerySectionSpacing;
  /** 0 = strak, 3 = uitbundig. Wat dat betekent, verschilt per indeling. */
  playfulness: GalleryPlayfulness;
  /** Alleen bij "Raster": de vorm waarin elke foto wordt bijgesneden. */
  tile_shape: GalleryTileShape;
  corners: GalleryCorners;
  frame: GalleryFrame;
  /** Wat een tegel doet onder de muis. */
  hover: GalleryHover;
  /** Beelden schuiven zacht in beeld tijdens het scrollen. */
  reveal: boolean;
  /** Hoe de naam van een categorie boven haar beelden staat. */
  headings: GalleryHeadings;
  /** `auto` = zoals voorheen: een videogalerij als raster, anders in rijen. */
  video_layout: GalleryVideoLayout;
  video_size: GalleryVideoSize;
}

export const GALLERY_LAYOUT_DEFAULTS: GalleryLayout = Object.freeze({
  style: 'rows',
  columns: null,
  phone_columns: null,
  gap: 6,
  width: 'full',
  section_spacing: 'normal',
  playfulness: 0,
  tile_shape: 'square',
  corners: 'soft',
  frame: 'none',
  hover: 'zoom',
  reveal: false,
  headings: 'label',
  video_layout: 'auto',
  video_size: 'medium',
}) as GalleryLayout;

/** Alle sleutels, in een vaste volgorde (ook voor de databasetrigger). */
export const GALLERY_LAYOUT_KEYS = Object.keys(GALLERY_LAYOUT_DEFAULTS) as Array<keyof GalleryLayout>;

/** De sleutels die over de foto's gaan; een stijl zet alleen deze. */
const PHOTO_KEYS: Array<keyof GalleryLayout> = GALLERY_LAYOUT_KEYS.filter(key => !key.startsWith('video_'));

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

/** Een getal binnen de grenzen; daarbuiten wordt het afgekapt, onzin valt terug. */
function whole(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Leeg betekent hier "automatisch", en 0 kolommen ook: dat is wat iemand bedoelt
 * die "0" intikt. Daarboven wordt het getal afgekapt op de grenzen.
 */
function wholeOrAuto(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < min) return null;
  return Math.min(max, rounded);
}

/**
 * Maakt van wat er in de database (of een payload) staat een volledige,
 * geldige weergave. Ontbrekende of onbekende waarden vallen terug op de
 * standaard: de galerij moet altijd kunnen tekenen, ook bij een rij van vóór
 * de migratie (`layout` bestaat dan niet) of een waarde die een nieuwere
 * versie van de app heeft gezet.
 */
export function normalizeGalleryLayout(raw: unknown): GalleryLayout {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const d = GALLERY_LAYOUT_DEFAULTS;
  const L = GALLERY_LAYOUT_LIMITS;
  return {
    style: oneOf(src.style, GALLERY_LAYOUT_STYLES, d.style),
    columns: wholeOrAuto(src.columns, L.columns.min, L.columns.max),
    phone_columns: wholeOrAuto(src.phone_columns, L.phone_columns.min, L.phone_columns.max),
    gap: whole(src.gap, L.gap.min, L.gap.max, d.gap),
    width: oneOf(src.width, GALLERY_LAYOUT_WIDTHS, d.width),
    section_spacing: oneOf(src.section_spacing, GALLERY_SECTION_SPACINGS, d.section_spacing),
    playfulness: whole(src.playfulness, L.playfulness.min, L.playfulness.max, d.playfulness) as GalleryPlayfulness,
    tile_shape: oneOf(src.tile_shape, GALLERY_TILE_SHAPES, d.tile_shape),
    corners: oneOf(src.corners, GALLERY_CORNERS, d.corners),
    frame: oneOf(src.frame, GALLERY_FRAMES, d.frame),
    hover: oneOf(src.hover, GALLERY_HOVERS, d.hover),
    reveal: typeof src.reveal === 'boolean' ? src.reveal : d.reveal,
    headings: oneOf(src.headings, GALLERY_HEADINGS, d.headings),
    video_layout: oneOf(src.video_layout, GALLERY_VIDEO_LAYOUTS, d.video_layout),
    video_size: oneOf(src.video_size, GALLERY_VIDEO_SIZES, d.video_size),
  };
}

const CHOICES: Partial<Record<keyof GalleryLayout, readonly string[]>> = {
  style: GALLERY_LAYOUT_STYLES,
  width: GALLERY_LAYOUT_WIDTHS,
  section_spacing: GALLERY_SECTION_SPACINGS,
  tile_shape: GALLERY_TILE_SHAPES,
  corners: GALLERY_CORNERS,
  frame: GALLERY_FRAMES,
  hover: GALLERY_HOVERS,
  headings: GALLERY_HEADINGS,
  video_layout: GALLERY_VIDEO_LAYOUTS,
  video_size: GALLERY_VIDEO_SIZES,
};

/**
 * Strenge controle, voor invoer die van buiten komt (Gerrie, een gekoppelde
 * AI): wat klopt er níét? Leeg = in orde. Waar `normalizeGalleryLayout` stil
 * herstelt, noemt deze elke fout bij naam — zodat het model zichzelf kan
 * verbeteren in plaats van een instelling te zien verdwijnen.
 */
export function galleryLayoutIssues(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['De weergave moet een object zijn.'];
  const src = raw as Record<string, unknown>;
  const issues: string[] = [];
  const known = new Set<string>(GALLERY_LAYOUT_KEYS);
  for (const [key, value] of Object.entries(src)) {
    if (!known.has(key)) { issues.push(`Onbekende instelling "${key}".`); continue; }
    const allowed = CHOICES[key as keyof GalleryLayout];
    if (allowed) {
      if (typeof value !== 'string' || !allowed.includes(value)) issues.push(`"${key}" moet een van deze zijn: ${allowed.join(', ')}.`);
      continue;
    }
    if (key === 'reveal') {
      if (typeof value !== 'boolean') issues.push('"reveal" moet waar of onwaar zijn.');
      continue;
    }
    const limit = GALLERY_LAYOUT_LIMITS[key as keyof typeof GALLERY_LAYOUT_LIMITS];
    const auto = key === 'columns' || key === 'phone_columns';
    if (auto && value === null) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < limit.min || value > limit.max) {
      issues.push(`"${key}" moet een heel getal van ${limit.min} tot en met ${limit.max} zijn${auto ? ', of leeg voor automatisch' : ''}.`);
    }
  }
  return issues;
}

/** Twee weergaven gelijk? (Voor "nog niet opgeslagen" en het herkennen van een stijl.) */
export function sameGalleryLayout(a: GalleryLayout, b: GalleryLayout, keys: Array<keyof GalleryLayout> = GALLERY_LAYOUT_KEYS): boolean {
  return keys.every(key => a[key] === b[key]);
}

// ── Stijlen: een complete weergave in één klik ─────────────────────────────
//
// Een stijl zet alles wat over de foto's gaan, en laat de video-instellingen
// staan: die zijn een eigen keuze. Daarna kun je elke knop nog bijstellen; de
// stijl is een startpunt, geen keurslijf. "Standaard" is de weergave van vóór
// deze instellingen.

export type GalleryLayoutPreset = {
  key: string;
  label: string;
  hint: string;
  layout: Partial<GalleryLayout>;
};

export const GALLERY_LAYOUT_PRESETS: GalleryLayoutPreset[] = [
  {
    key: 'standard',
    label: 'Standaard',
    hint: 'Rijen die de volle breedte vullen, elke foto heel. Zo zag elke galerij er tot nu toe uit.',
    layout: {},
  },
  {
    key: 'seamless',
    label: 'Naadloos',
    hint: 'Beeld tegen beeld, zonder ruimte of ronde hoeken — één groot doek.',
    layout: { style: 'rows', gap: 0, corners: 'square', hover: 'none', playfulness: 1 },
  },
  {
    key: 'gallery',
    label: 'Galerie',
    hint: 'Een strak raster met passe-partout en veel wit, als aan de muur van een expositie.',
    layout: {
      style: 'grid', tile_shape: 'portrait', columns: 3, phone_columns: 1, gap: 36, width: 'medium',
      corners: 'square', frame: 'mat', hover: 'lift', headings: 'title', section_spacing: 'airy', reveal: true,
    },
  },
  {
    key: 'magazine',
    label: 'Tijdschrift',
    hint: 'Een verhaal in beelden: groot, in paren, met ruimte eromheen.',
    layout: {
      style: 'story', gap: 20, width: 'medium', playfulness: 2, corners: 'square', hover: 'none',
      headings: 'numbered', section_spacing: 'grand', reveal: true,
    },
  },
  {
    key: 'moodboard',
    label: 'Moodboard',
    hint: 'Kolommen die licht verspringen, zoals een prikbord vol inspiratie.',
    layout: { style: 'masonry', columns: 4, gap: 10, corners: 'subtle', playfulness: 2, hover: 'lift' },
  },
  {
    key: 'lighttable',
    label: 'Lichttafel',
    hint: 'Afdrukken met een witte rand, losjes op tafel gelegd.',
    layout: { style: 'prints', columns: 4, gap: 24, playfulness: 2, corners: 'square', hover: 'lift', width: 'wide', reveal: true },
  },
  {
    key: 'rhythm',
    label: 'Ritme',
    hint: 'Een vierkant raster waarin af en toe een beeld groot uitpakt.',
    layout: { style: 'grid', tile_shape: 'square', columns: 4, gap: 4, corners: 'subtle', playfulness: 2 },
  },
];

export const GALLERY_LAYOUT_PRESET_KEYS = GALLERY_LAYOUT_PRESETS.map(preset => preset.key);

/** Past een stijl toe op de huidige weergave; de video-instellingen blijven staan. */
export function applyGalleryLayoutPreset(current: GalleryLayout, key: string): GalleryLayout {
  const preset = GALLERY_LAYOUT_PRESETS.find(p => p.key === key);
  if (!preset) return current;
  return normalizeGalleryLayout({
    ...GALLERY_LAYOUT_DEFAULTS,
    ...preset.layout,
    video_layout: current.video_layout,
    video_size: current.video_size,
  });
}

/** Welke stijl is dit precies? `null` = een eigen combinatie. */
export function matchGalleryLayoutPreset(layout: GalleryLayout): string | null {
  for (const preset of GALLERY_LAYOUT_PRESETS) {
    if (sameGalleryLayout(applyGalleryLayoutPreset(layout, preset.key), layout, PHOTO_KEYS)) return preset.key;
  }
  return null;
}

// ── Woorden ─────────────────────────────────────────────────────────────────

export const GALLERY_LAYOUT_STYLE_LABELS: Record<GalleryLayoutStyle, { label: string; hint: string }> = {
  rows: { label: 'Rijen', hint: 'Elke foto heel; de rijen vullen precies de breedte.' },
  masonry: { label: 'Waterval', hint: 'Kolommen waarin elke foto haar eigen verhouding houdt.' },
  grid: { label: 'Raster', hint: 'Gelijke tegels in één vorm — rustig en strak.' },
  story: { label: 'Verhaal', hint: 'Groot en ruim, één tot drie beelden per regel — als een tijdschrift.' },
  prints: { label: 'Afdrukken', hint: 'Foto’s met een witte rand, als afdrukken op een lichttafel.' },
};

export const GALLERY_PLAYFULNESS_LABELS: Record<GalleryPlayfulness, string> = {
  0: 'Strak',
  1: 'Levendig',
  2: 'Speels',
  3: 'Uitbundig',
};

/** Wat de speelsheid bij deze indeling concreet doet. */
export function playfulnessHint(style: GalleryLayoutStyle, level: GalleryPlayfulness): string {
  const hints: Record<GalleryLayoutStyle, [string, string, string, string]> = {
    rows: [
      'Alle rijen even hoog.',
      'Af en toe een rij met grotere beelden.',
      'De rijen wisselen van hoogte; er zit ritme in.',
      'Grote contrasten: brede rijen naast smalle stroken.',
    ],
    masonry: [
      'Kolommen strak naast elkaar.',
      'Af en toe een liggende foto over twee kolommen.',
      'De kolommen beginnen verspringend, met vaker een breed beeld.',
      'Sterk verspringend, met veel brede beelden.',
    ],
    grid: [
      'Alle tegels even groot.',
      'Af en toe een tegel die twee keer zo groot is.',
      'Regelmatig een grote tegel, soms een brede.',
      'Een mozaïek: grote en brede tegels door elkaar.',
    ],
    story: [
      'Rustig en gecentreerd.',
      'Staande foto’s wisselen van links naar rechts.',
      'Afwisselende maten en licht verspringende paren.',
      'Een vrije compositie met grote verschillen in maat en plek.',
    ],
    prints: [
      'Recht en netjes in het gelid.',
      'Een tikje scheef, zoals neergelegd.',
      'Losjes neergelegd, licht verschoven.',
      'Als een stapel op tafel — met een polaroidrand.',
    ],
  };
  return hints[style][level];
}

/** Een naam voor de tussenruimte, voor naast de schuifregelaar. */
export function gapLabel(gap: number): string {
  if (gap <= 0) return 'Naadloos';
  if (gap <= 4) return 'Haarlijn';
  if (gap <= 10) return 'Smal';
  if (gap <= 20) return 'Ruim';
  if (gap <= 36) return 'Royaal';
  return 'Museaal';
}

/** Korte samenvatting, voor de goedkeurkaart van Gerrie en in lijsten. */
export function describeGalleryLayout(layout: GalleryLayout): string {
  const parts: string[] = [GALLERY_LAYOUT_STYLE_LABELS[layout.style].label.toLowerCase()];
  if (layout.style !== 'story') {
    parts.push(layout.columns == null ? 'kolommen automatisch' : `${layout.columns} ${layout.style === 'rows' ? 'per rij' : layout.columns === 1 ? 'kolom' : 'kolommen'}`);
  }
  parts.push(`${layout.gap} px tussenruimte`);
  parts.push(GALLERY_PLAYFULNESS_LABELS[layout.playfulness].toLowerCase());
  return parts.join(' · ');
}
