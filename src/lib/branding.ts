// Huisstijl van de beeldmaker op klantgerichte pagina's (galerij in het portaal
// en de publieke deellink). De instellingen komen uit company_settings; hier
// staat hoe ze naar CSS worden vertaald.
//
// Belangrijk: het lettertype wordt bewaard als SLEUTEL, niet als font-family.
// We zoeken die sleutel op in de lijst hieronder en gebruiken alleen ónze eigen
// waarden in CSS. Een onbekende sleutel valt terug op de standaard, dus er kan
// nooit willekeurige CSS via een databasewaarde de pagina in.

export type BrandingPayload = {
  logoDataUrl: string | null;
  accentColor: string;
  footerText: string | null;
  hidePoweredBy: boolean;
  companyName: string | null;
  headingFont?: string | null;
  bodyFont?: string | null;
  galleryBg?: string | null;
};

/** Achtergronden die het vaakst gekozen worden; de kleurkiezer kan alles. */
export const GALLERY_BACKGROUNDS: Array<{ value: string; label: string }> = [
  { value: '#0B0B0B', label: 'Nachtzwart' },
  { value: '#171717', label: 'Antraciet' },
  { value: '#1C1A18', label: 'Warm donker' },
  { value: '#F6F4F1', label: 'Gebroken wit' },
  { value: '#FFFFFF', label: 'Zuiver wit' },
];

/** Waargenomen helderheid (0–1) volgens de sRGB-luminantieformule. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (index: number) => parseInt(value.slice(index * 2, index * 2 + 2), 16) / 255;
  const linear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(channel(0)) + 0.7152 * linear(channel(1)) + 0.0722 * linear(channel(2));
}

/**
 * Leidt een leesbaar palet af uit één achtergrondkleur. De gebruiker kiest dus
 * alleen de achtergrond; tekst, randen en tegelvlakken volgen automatisch en
 * blijven contrastrijk — ook bij een lichte galerij.
 */
function galleryPalette(background: string): Record<string, string> {
  const light = luminance(background) > 0.5;
  return {
    '--gal-bg': background,
    '--gal-text': light ? '#141414' : '#f4f4f4',
    '--gal-muted': light ? 'rgba(20,20,20,.62)' : 'rgba(244,244,244,.62)',
    '--gal-border': light ? 'rgba(20,20,20,.14)' : 'rgba(255,255,255,.10)',
    '--gal-surface': light ? 'rgba(20,20,20,.05)' : 'rgba(255,255,255,.05)',
    '--gal-surface-strong': light ? 'rgba(20,20,20,.09)' : 'rgba(255,255,255,.09)',
  };
}

type BrandFont = {
  key: string;
  label: string;
  /** Korte typering voor de keuzelijst. */
  hint: string;
  stack: string;
  /** Google-Fonts-specificatie; leeg = al geladen of systeemfont. */
  google: string | null;
  /** Display-lettertypen zijn ongeschikt voor lopende tekst. */
  headingOnly?: boolean;
};

export const DEFAULT_BRAND_FONT = 'system';

export const BRAND_FONTS: BrandFont[] = [
  {
    key: 'system',
    label: 'Poppins (standaard)',
    hint: 'De huisstijl van ResoFly — vriendelijk en neutraal.',
    stack: "'Poppins', system-ui, -apple-system, 'Segoe UI', sans-serif",
    google: null, // staat al in index.html
  },
  {
    key: 'inter',
    label: 'Inter',
    hint: 'Helder en zakelijk; leest rustig op elk formaat.',
    stack: "'Inter', system-ui, sans-serif",
    google: 'Inter:wght@300;400;500;600;700;800',
  },
  {
    key: 'jost',
    label: 'Jost',
    hint: 'Geometrisch en modern, met een Bauhaus-inslag.',
    stack: "'Jost', system-ui, sans-serif",
    google: 'Jost:wght@300;400;500;600;700',
  },
  {
    key: 'space-grotesk',
    label: 'Space Grotesk',
    hint: 'Eigenzinnig modern; valt op zonder te schreeuwen.',
    stack: "'Space Grotesk', system-ui, sans-serif",
    google: 'Space+Grotesk:wght@300;400;500;600;700',
  },
  {
    key: 'dm-sans',
    label: 'DM Sans',
    hint: 'Zacht en open; prettig voor langere teksten.',
    stack: "'DM Sans', system-ui, sans-serif",
    google: 'DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,700',
  },
  {
    key: 'playfair',
    label: 'Playfair Display',
    hint: 'Klassiek en elegant; sterke koppen met contrast.',
    stack: "'Playfair Display', Georgia, serif",
    google: 'Playfair+Display:wght@400;500;600;700;800',
  },
  {
    key: 'cormorant',
    label: 'Cormorant Garamond',
    hint: 'Verfijnd en licht; heel geschikt voor bruiloften.',
    stack: "'Cormorant Garamond', Georgia, serif",
    google: 'Cormorant+Garamond:wght@300;400;500;600;700',
  },
  {
    key: 'lora',
    label: 'Lora',
    hint: 'Warme serif die ook in lopende tekst goed leest.',
    stack: "'Lora', Georgia, serif",
    google: 'Lora:wght@400;500;600;700',
  },
  {
    key: 'bebas',
    label: 'Bebas Neue',
    hint: 'Uitgesproken display in kapitalen — alleen voor koppen.',
    stack: "'Bebas Neue', Impact, sans-serif",
    google: 'Bebas+Neue',
    headingOnly: true,
  },
];

export const BRAND_BODY_FONTS = BRAND_FONTS.filter(font => !font.headingOnly);

export function brandFont(key: string | null | undefined): BrandFont {
  return BRAND_FONTS.find(font => font.key === key) ?? BRAND_FONTS[0];
}

/**
 * Laadt de Google-Fonts-stylesheet voor deze lettertypen, één keer per familie.
 * De CSP staat fonts.googleapis.com/fonts.gstatic.com toe (zie public/_headers).
 */
export function ensureBrandFontsLoaded(keys: Array<string | null | undefined>): void {
  if (typeof document === 'undefined') return;
  for (const key of keys) {
    const font = brandFont(key);
    if (!font.google) continue;
    const id = `brand-font-${font.key}`;
    if (document.getElementById(id)) continue;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
    document.head.appendChild(link);
  }
}

/**
 * Vertaalt de huisstijl naar CSS-variabelen voor de galerij. Levert `undefined`
 * wanneer er niets ingesteld is, zodat de standaardstijl ongemoeid blijft.
 */
export function brandStyle(branding: BrandingPayload | null | undefined): React.CSSProperties | undefined {
  if (!branding) return undefined;
  const style: Record<string, string> = {};
  if (/^#[0-9A-Fa-f]{6}$/.test(branding.accentColor || '')) {
    style['--accent'] = branding.accentColor;
  }
  if (branding.headingFont && branding.headingFont !== DEFAULT_BRAND_FONT) {
    style['--brand-heading'] = brandFont(branding.headingFont).stack;
  }
  if (branding.bodyFont && branding.bodyFont !== DEFAULT_BRAND_FONT) {
    style['--brand-body'] = brandFont(branding.bodyFont).stack;
  }
  if (branding.galleryBg && /^#[0-9A-Fa-f]{6}$/.test(branding.galleryBg)) {
    Object.assign(style, galleryPalette(branding.galleryBg));
  }
  return Object.keys(style).length > 0 ? (style as React.CSSProperties) : undefined;
}
