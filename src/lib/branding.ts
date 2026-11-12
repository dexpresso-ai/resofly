// Huisstijl van de beeldmaker op klantgerichte pagina's (galerij in het portaal
// en de publieke deellink). De instellingen komen uit company_settings; hier
// staat hoe ze naar CSS worden vertaald.
//
// Belangrijk: het lettertype wordt bewaard als SLEUTEL, niet als font-family.
// We zoeken die sleutel op in de lijst hieronder en gebruiken alleen ónze eigen
// waarden in CSS. Een onbekende sleutel valt terug op de standaard, dus er kan
// nooit willekeurige CSS via een databasewaarde de pagina in.

// De kleurwiskunde zelf (contrast, helderheid, kleurtoon) staat in brandColor.ts:
// dezelfde regel als de PDF en de mails. Hier alleen wat de klantpagina's ermee doen.
import { blendColors, contrastRatio, hexChannels, hexToHsl, hslToHex, readableShade, relativeLuminance, textOnColor } from './brandColor.ts';

export type BrandingPayload = {
  logoDataUrl: string | null;
  accentColor: string;
  footerText: string | null;
  hidePoweredBy: boolean;
  companyName: string | null;
  headingFont?: string | null;
  bodyFont?: string | null;
  galleryBg?: string | null;
  /** Sfeer van de klantgerichte pagina's: 'dark' (standaard) of 'light'. */
  clientTheme?: string | null;
  /** Kleur van de kop van het portaal en de publieke pagina's; leeg =
   *  automatisch, afgeleid uit de merkkleur (zie `headerTheme()`). */
  headerColor?: string | null;
  /** Lichte versie van het logo voor op een donkere kop. */
  logoDarkDataUrl?: string | null;
  /** De kleuren van het inlogscherm; leeg = automatisch (zie `loginTheme()`):
   *  de achtergrond volgt de kop, de kaart het werkvlak, de knop de merkkleur. */
  loginBackground?: string | null;
  loginCard?: string | null;
  loginButton?: string | null;
  /** Effen achtergrond op het inlogscherm, zonder verloop, gloed en ringen. */
  loginPlain?: boolean;
};

/** Achtergronden die het vaakst gekozen worden; de kleurkiezer kan alles. */
export const GALLERY_BACKGROUNDS: Array<{ value: string; label: string }> = [
  { value: '#0B0B0B', label: 'Nachtzwart' },
  { value: '#171717', label: 'Antraciet' },
  { value: '#1C1A18', label: 'Warm donker' },
  { value: '#F6F4F1', label: 'Gebroken wit' },
  { value: '#FFFFFF', label: 'Zuiver wit' },
];

/**
 * Leidt een leesbaar palet af uit één achtergrondkleur. De gebruiker kiest dus
 * alleen de achtergrond; tekst, randen en tegelvlakken volgen automatisch en
 * blijven contrastrijk — ook bij een lichte galerij.
 */
function galleryPalette(background: string): Record<string, string> {
  const light = relativeLuminance(background) > 0.5;
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
    // Sinds de Cockpit-laag (2026-10-05) staat ook de werkruimte weer helemaal
    // in Poppins (index.html laadt hem); dit laden op aanvraag blijft voor de
    // pagina's die de klant ziet, en kost niets dubbel (zelfde bestanden).
    google: 'Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400;1,600',
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
    // Wat óp de merkkleur staat (de knop "Opslaan", een vinkje, de diashow-
    // knop) en de hovertint: die stonden alleen op :root, in de tinten van
    // ResoFly-goud. Op een donkerblauw merk was de knoptekst dan bijna zwart
    // op blauw, en de knop werd bij hover goud.
    const accent = branding.accentColor.toUpperCase();
    const hsl = hexToHsl(accent);
    style['--accent-rgb'] = rgbTriplet(accent);
    style['--on-accent'] = inkOnAccent(accent);
    style['--accent-hover'] = hslToHex({ h: hsl.h, s: hsl.s, l: hsl.l > 0.85 ? hsl.l - 0.08 : hsl.l + 0.08 });
  }
  if (branding.headingFont && branding.headingFont !== DEFAULT_BRAND_FONT) {
    style['--brand-heading'] = brandFont(branding.headingFont).stack;
  }
  if (branding.bodyFont && branding.bodyFont !== DEFAULT_BRAND_FONT) {
    style['--brand-body'] = brandFont(branding.bodyFont).stack;
  }
  if (branding.galleryBg && /^#[0-9A-Fa-f]{6}$/.test(branding.galleryBg)) {
    Object.assign(style, galleryPalette(branding.galleryBg));
    // De merkkleur als tekst (de gekozen categorie, een like) staat op de
    // galerij-achtergrond, niet op het vlak van de pagina eromheen. Die
    // erfde tot nu toe de accenttekst van de werkruimte: diep amber op een
    // zwarte galerij, 2,3 : 1. Hier dezelfde afleiding als op de klantpagina's,
    // maar dan tegen de galerij zelf gemeten.
    const accent = /^#[0-9A-Fa-f]{6}$/.test(branding.accentColor || '') ? branding.accentColor : '#FFD966';
    const bg = branding.galleryBg;
    const light = relativeLuminance(bg) > 0.5;
    style['--gal-accent-ink'] = readableInk(accent, [
      bg,
      blendColors(light ? '#141414' : '#FFFFFF', bg, 0.09),
      blendColors(accent, bg, 0.12),
    ], light);
  }
  return Object.keys(style).length > 0 ? (style as React.CSSProperties) : undefined;
}

// ── Huisstijl op alles wat de klant ziet ────────────────────────────────────
//
// De galerij hierboven krijgt alleen een achtergrond en een accent. Het
// klantportaal en de publieke offerte-, factuur- en contractpagina zijn
// complete schermen: kaarten, randen, tekst, statuskleuren. Die schrijven we
// niet met de hand vol kleuren, maar leiden we af uit de merkkleur die de
// gebruiker instelt.
//
// Waarom dat kan: globals.css is in drie lagen opgezet (kanalen → semantiek →
// compat). Zet je laag 1 en 2 opnieuw, dan volgt de rest vanzelf. Eén valkuil,
// dezelfde als bij `.public-quote-page` in globals.css: een aangepaste
// eigenschap wordt uitgerekend op het element waar hij STÁÁT. `--bg2:var(--surface)`
// staat op `:root` en is daar al uitgerekend; hem verderop overschrijven doet
// niets meer. Daarom geeft `brandThemeVars()` de compat-laag óók kant-en-klaar
// terug — dan werkt dezelfde set zowel op `:root` als op een los voorbeeldkaartje.

/** "255,217,102" — het formaat waarin globals.css kleuren met alfa opbouwt. */
function rgbTriplet(hex: string): string {
  return hexChannels(hex).join(',');
}

/**
 * De merkkleur als TEKST. Merkgoud op wit haalt geen 4.5:1 en donkerblauw op
 * zwart evenmin, dus schuiven we de helderheid op tot het contrast met álle
 * vlakken waar de kleur op belandt AA haalt. De tint blijft staan, zodat het
 * herkenbaar dezelfde kleur blijft. Precies de reden dat het lichte thema
 * `--accent-ink:#7A5A0C` heeft naast `--accent:#FFD966`.
 */
/**
 * Het doel ligt bewust iets boven de 4,5 van de norm. De vlakken hieronder zijn
 * een model van de echte opeenstapeling (kaart + glanslaag + tint); mikken we
 * precies op de grens, dan valt een paneel dat in werkelijkheid 2% lichter is
 * er alsnog doorheen. Gemeten over 24 merk/sfeer-combinaties × 50 tekstvlakken
 * is 4,75 genoeg marge en blijft de kleur herkenbaar die van het merk.
 */
const INK_TARGET = 4.75;

function readableInk(accent: string, backgrounds: string[], darker: boolean, target = INK_TARGET): string {
  // Alleen de helderheid schuift; tint én verzadiging blijven staan. Anders
  // krijgt een ingetogen merk (denk aan taupe #8A7F70) opeens een oranje
  // accenttekst — leesbaar, maar niet meer zijn kleur. Zie readableShade().
  return readableShade(accent, backgrounds, { direction: darker ? 'darker' : 'lighter', target });
}

/**
 * Tekst óp een merkkleurig vlak: bijna-zwart of bijna-wit, wat beter leest. Een
 * merkkleur in het midden van de grijstrap (denk aan #7A7A7A) haalt met een
 * getinte variant net geen 4.5:1; dan gaat het door naar puur zwart of wit,
 * want dat is het maximum dat zo'n kleur überhaupt toelaat.
 */
function inkOnAccent(accent: string): string {
  const { h, s } = hexToHsl(accent);
  return textOnColor(accent, hslToHex({ h, s: Math.min(s, 0.3), l: 0.08 }), hslToHex({ h, s: Math.min(s, 0.12), l: 0.97 }));
}

// ── De kop ──────────────────────────────────────────────────────────────────
//
// Het portaal en de publieke offerte-, factuur- en contractpagina hebben
// bovenaan een kop: het commandovlak van de werkruimte (cockpit.css), maar in
// het merk van de leverancier. Zonder eigen kopkleur is dat het grafiet van de
// cockpit (#0B0B0D → #1E1E23) in de tint van de merkkleur; met een kopkleur is
// het die kleur, met hetzelfde verloop eroverheen. Alles wat erop staat —
// tekst, glazen tegels, de merkkleur zelf — rekenen we hier uit, tegen élk vlak
// van dat verloop én de gloed van de merkkleur linksboven.

export type HeaderTheme = {
  /** Verloop van linksboven naar rechtsonder; `mid` is de kopkleur zelf. */
  top: string;
  mid: string;
  bottom: string;
  /** Donkere kop: lichte tekst. */
  dark: boolean;
  /** Eigen kopkleur (true) of automatisch (false). */
  custom: boolean;
  ink: string;
  /** Gedempte tekst (onderschriften, tabbladen die niet gekozen zijn). */
  ink2: string;
  /** De merkkleur als tekst en lijn op de kop. */
  accent: string;
  /** Is `accent` in helderheid opgeschoven om af te steken? */
  accentAdjusted: boolean;
  /** Is de eigen kopkleur in helderheid opgeschoven omdat er niets op leesde? */
  headerAdjusted: boolean;
  /** Alfa van de gloed linksboven; laag als merkkleur en kop op elkaar lijken. */
  glowAlpha: number;
  /** Alle vlakken waar tekst op de kop kan belanden (voor het nameten). */
  surfaces: string[];
};

/** Glas op de kop: een tegel is een laagje wit (of zwart op een lichte kop). */
const HEADER_GLASS = { dark: 0.065, light: 0.05 };
/** De koele tegenlamp rechtsboven, zoals in de cockpit. */
const HEADER_COUNTER = { dark: '#A0A0B9', darkAlpha: 0.12, light: '#FFFFFF', lightAlpha: 0.22 };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function headerTheme(branding: BrandingPayload | null | undefined): HeaderTheme {
  const accent = /^#[0-9A-Fa-f]{6}$/.test(branding?.accentColor || '')
    ? branding!.accentColor.toUpperCase()
    : '#FFD966';
  const custom = /^#[0-9A-Fa-f]{6}$/.test(branding?.headerColor || '');
  const a = hexToHsl(accent);
  const tint = Math.min(1, a.s / 0.35);
  const lightInk = hslToHex({ h: a.h, s: 0.25 * tint, l: 0.965 });
  const darkInk = hslToHex({ h: a.h, s: 0.3 * tint, l: 0.08 });

  /** Het verloop rond één helderheid: linksboven donkerder, rechtsonder lichter.
   *  Zolang er niets is opgeschoven, is het midden letterlijk de gekozen kleur
   *  (heen en terug via HSL kan een afrondingsverschil van één stap geven). */
  const stops = (l: number, exact: boolean) => {
    if (!custom) {
      // Dezelfde helderheid als het verloop van de cockpit, in de tint van het
      // merk; een grijs merk krijgt dus gewoon grafiet.
      return {
        top: hslToHex({ h: a.h, s: 0.16 * tint, l: 0.043 }),
        mid: hslToHex({ h: a.h, s: 0.13 * tint, l: 0.078 }),
        bottom: hslToHex({ h: a.h, s: 0.11 * tint, l: 0.125 }),
      };
    }
    const k = hexToHsl(branding!.headerColor!);
    return {
      top: hslToHex({ h: k.h, s: k.s, l: clamp01(l - 0.045) }),
      mid: exact ? branding!.headerColor!.toUpperCase() : hslToHex({ h: k.h, s: k.s, l: clamp01(l) }),
      bottom: hslToHex({ h: k.h, s: k.s, l: clamp01(l + 0.06) }),
    };
  };

  /** Alle vlakken waar tekst op de kop kan belanden. */
  const surfacesOf = (top: string, mid: string, bottom: string, dark: boolean, glowAlpha: number) => {
    const glass = dark ? '#FFFFFF' : '#000000';
    const glassAlpha = dark ? HEADER_GLASS.dark : HEADER_GLASS.light;
    return [
      top, mid, bottom,
      // Een glazen tegel op de lichtste en de donkerste plek van het verloop.
      blendColors(glass, top, glassAlpha),
      blendColors(glass, bottom, glassAlpha),
      // De gloed van de merkkleur en de tegenlamp, waar de groet en de knoppen staan.
      blendColors(accent, top, glowAlpha),
      dark
        ? blendColors(HEADER_COUNTER.dark, top, HEADER_COUNTER.darkAlpha)
        : blendColors(HEADER_COUNTER.light, top, HEADER_COUNTER.lightAlpha),
    ];
  };
  const passes = (ink: string, surfaces: string[]) => surfaces.every(bg => contrastRatio(ink, bg) >= INK_TARGET);
  const strongest = (dark: boolean) => (dark ? [lightInk, '#FFFFFF'] : [darkInk, '#000000']);

  // Licht of donker kiezen we niet op een drempel maar op wat het beste leest.
  // Een kopkleur precies in het midden van de grijstrap (#808080) laat geen van
  // beide tot de norm komen; dan schuift de helderheid van de kop zelf een
  // stukje op, van het midden af. De tint blijft die van de gebruiker.
  let l = custom ? hexToHsl(branding!.headerColor!).l : 0;
  let { top, mid, bottom } = stops(l, true);
  let dark = true;
  let glowAlpha = 0.2;
  let surfaces: string[] = [];
  for (let step = 0; step <= 40; step++) {
    ({ top, mid, bottom } = stops(l, step === 0));
    const plain = [top, mid, bottom];
    const worst = (ink: string) => Math.min(...plain.map(bg => contrastRatio(ink, bg)));
    dark = worst('#FFFFFF') >= worst('#000000');
    glowAlpha = contrastRatio(accent, mid) < 1.8 ? 0.1 : dark ? 0.2 : 0.16;
    surfaces = surfacesOf(top, mid, bottom, dark, glowAlpha);
    if (!custom || strongest(dark).some(ink => passes(ink, surfaces))) break;
    l = clamp01(l + (dark ? -0.02 : 0.02));
  }

  const candidates = strongest(dark);
  const ink = candidates.find(c => passes(c, surfaces)) ?? candidates[candidates.length - 1];
  // Gedempt: de inkt een stuk naar de kop toe gemengd, maar nooit onder de norm.
  let ink2 = ink;
  for (let w = 0.62; w <= 1.0001; w += 0.04) {
    const candidate = blendColors(ink, mid, w);
    if (passes(candidate, surfaces)) { ink2 = candidate; break; }
  }
  const headerAccent = readableInk(accent, surfaces, !dark);

  return {
    top, mid, bottom, dark, custom, ink, ink2,
    accent: headerAccent,
    accentAdjusted: headerAccent.toUpperCase() !== accent,
    headerAdjusted: custom && mid.toUpperCase() !== branding!.headerColor!.toUpperCase(),
    glowAlpha,
    surfaces,
  };
}

/**
 * Het vlak van de hoofdknop en het merkteken: de merkkleur met een verloop van
 * licht (linksboven) naar donker, zoals `--gold-face` in de werkruimte. Het
 * verloop wordt smaller tot de tekst erop overal leesbaar blijft.
 */
export function accentFace(accentColor: string, onAccent: string): string {
  const a = hexToHsl(accentColor);
  for (const spread of [0.07, 0.05, 0.03]) {
    const lighter = hslToHex({ h: a.h, s: a.s, l: clamp01(a.l + spread) });
    const darker = hslToHex({ h: a.h, s: a.s, l: clamp01(a.l - spread) });
    if (contrastRatio(onAccent, lighter) >= 4.5 && contrastRatio(onAccent, darker) >= 4.5) {
      return `linear-gradient(150deg,${lighter} 0%,${accentColor} 50%,${darker} 100%)`;
    }
  }
  return accentColor;
}

/**
 * Resonantieringen, de textuur van het commandovlak (zie `--rings` in
 * cockpit.css): wit op een donkere kop, inkt op een lichte.
 */
function ringsImage(dark: boolean): string {
  const circles = Array.from({ length: 13 }, (_, i) => `%3Ccircle cx='600' cy='600' r='${44 * (i + 1)}'/%3E`).join('');
  const stroke = dark ? '%23fff' : '%23000';
  const opacity = dark ? 0.085 : 0.07;
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='1200' viewBox='0 0 1200 1200'%3E%3Cg fill='none' stroke='${stroke}' stroke-opacity='${opacity}'%3E${circles}%3C/g%3E%3C/svg%3E")`;
}

/**
 * Moet een logo op een licht plaatje? De meeste logo's zijn donker op
 * transparant; op een donkere kop vallen ze weg. `ink` is de gemiddelde kleur
 * van het logo (zie `summarizeLogoPixels()` in logoColors.ts). 2,6 : 1 is
 * strenger dan de 3 : 1 voor iconen niet, maar een logo is groter en vetter
 * dan een icoon: bij 2,6 is een merkteken nog goed te zien.
 */
export function logoNeedsPlate(ink: string | null | undefined, backgrounds: string[], luminance: number[] = []): boolean {
  if (!ink || !/^#[0-9A-Fa-f]{6}$/.test(ink)) return false;
  if (backgrounds.some(bg => contrastRatio(ink, bg) < 2.6)) return true;
  // Gemiddeld goed, maar valt een flink deel weg? Donkere letters naast een fel
  // beeldmerk zijn gemiddeld middelgrijs; op de donkere kop bleef zo'n logo
  // zonder plaatje, en stond er alleen nog het beeldmerk (2026-11-12).
  return backgrounds.some(bg => logoLostShare(luminance, bg) >= LOGO_LOST_SHARE);
}

/**
 * Onder deze verhouding valt een stuk logo weg: je ziet op een scherm nog net
 * dat er iets staat, maar geen letter.
 */
const LOGO_LOST_CONTRAST = 1.6;
/** Zoveel van een logo mag wegvallen voor het een plaatje krijgt. */
const LOGO_LOST_SHARE = 0.3;

/**
 * Welk deel van een logo (0–1) valt weg op dit vlak? `luminance` is de
 * helderheid van het logo in gelijke delen, van donker naar licht
 * (`summarizeLogoPixels()` in logoColors.ts). Zonder telling: 0.
 */
export function logoLostShare(luminance: number[], background: string): number {
  if (!luminance.length || !/^#[0-9A-Fa-f]{6}$/.test(background)) return 0;
  const bg = relativeLuminance(background);
  const lost = luminance.filter(l => (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05) < LOGO_LOST_CONTRAST);
  return lost.length / luminance.length;
}

/**
 * Welk plaatje een logo nodig heeft op deze vlakken: geen, een licht (voor een
 * donker logo) of een donker (voor een wit logo op een lichte kaart). Met de
 * telling van `luminance` het plaatje waarop het minst wegvalt.
 */
export function logoPlate(ink: string | null | undefined, backgrounds: string[], luminance: number[] = []): 'light' | 'dark' | null {
  if (!logoNeedsPlate(ink, backgrounds, luminance)) return null;
  const byInk = contrastRatio(ink!, '#FFFFFF') >= contrastRatio(ink!, PLATE_DARK) ? 'light' : 'dark';
  if (!luminance.length) return byInk;
  const onLight = logoLostShare(luminance, '#FFFFFF');
  const onDark = logoLostShare(luminance, PLATE_DARK);
  // Kwam het plaatje alleen door wat er wegvalt (de gemiddelde kleur was goed),
  // dan moet het plaatje ook echt helpen. Een witte naam naast een donkerblauw
  // beeldmerk: op de kop valt het beeldmerk weg, op een wit plaatje de naam.
  // Dan liever geen plaatje.
  if (backgrounds.every(bg => contrastRatio(ink!, bg) >= 2.6)) {
    const bare = Math.max(...backgrounds.map(bg => logoLostShare(luminance, bg)));
    if (Math.min(onLight, onDark) >= bare) return null;
  }
  if (onLight === onDark) return byInk;
  return onLight < onDark ? 'light' : 'dark';
}

/** Het donkere plaatje: het grafiet van de cockpit. */
export const PLATE_DARK = '#17171A';

/** Leest lichte tekst hier beter dan donkere? */
export function isDarkSurface(hex: string): boolean {
  return contrastRatio('#FFFFFF', hex) >= contrastRatio('#000000', hex);
}

/** Voor de instellingen en de tests: dezelfde formule als de PDF en de mails (brandColor.ts). */
export { contrastRatio };

/**
 * Een eerste voorstel als iemand een eigen kopkleur kiest: de merkkleur, diep
 * en wat rustiger. Zo verandert er meteen iets zichtbaars (de automatische kop
 * is al grafiet) en past het voorstel bij het merk.
 */
export function suggestHeaderColor(accentColor: string): string {
  const accent = /^#[0-9A-Fa-f]{6}$/.test(accentColor) ? accentColor : '#FFD966';
  const { h, s } = hexToHsl(accent);
  return hslToHex({ h, s: Math.min(s, 0.65), l: 0.18 });
}

/** Is `color` lichter dan `reference`? Voor de uitleg bij een bijgestelde kleur. */
export function isLighterThan(color: string, reference: string): boolean {
  return relativeLuminance(color) > relativeLuminance(reference);
}

/**
 * De neutrale trap van het thema, maar in de tint van het merk. Verzadiging en
 * helderheid komen letterlijk uit het THEMA-TOKENS-blok in globals.css; alleen
 * de tint verschuift mee. Zo blijft elk contrast dat daar is afgewogen precies
 * staan, terwijl een blauw merk geen warmbruine panelen meer krijgt.
 */
type NeutralRamp = Record<'bg' | 'bgDeep' | 'surface' | 'surface2' | 'surface3' | 'sidebar' | 'line' | 'line2' | 'ink' | 'ink2' | 'ink3', { s: number; l: number }>;

const DARK_RAMP: NeutralRamp = {
  bg: { s: .125, l: .0627 },        // #12110E
  bgDeep: { s: .176, l: .0333 },    // #0A0907
  surface: { s: .125, l: .0941 },   // #1B1915
  surface2: { s: .1525, l: .1157 }, // #221F19
  surface3: { s: .135, l: .1451 },  // #2A2620
  sidebar: { s: .122, l: .0804 },   // #171512
  line: { s: .108, l: .1627 },      // #2E2B25
  line2: { s: .119, l: .2137 },     // #3D3930
  ink: { s: .28, l: .951 },         // #F6F4EF
  ink2: { s: .143, l: .753 },       // #C9C3B7
  ink3: { s: .0875, l: .5745 },     // #9C9589
};

const LIGHT_RAMP: NeutralRamp = {
  bg: { s: .282, l: .9235 },        // #F1EEE6
  bgDeep: { s: .233, l: .8824 },    // #E8E4DA
  surface: { s: 0, l: 1 },          // #FFFFFF
  surface2: { s: .474, l: .9627 },  // #FAF7F1
  surface3: { s: .351, l: .9275 },  // #F3EFE6
  sidebar: { s: .467, l: .9706 },   // #FBF9F4
  line: { s: .235, l: .8412 },      // #E0DACD
  line2: { s: .185, l: .7451 },     // #CAC3B2
  ink: { s: .238, l: .0824 },       // #1A1710
  ink2: { s: .148, l: .2118 },      // #3E392E
  ink3: { s: .108, l: .3824 },      // #6C6557
};

/** Statuskleuren horen bij de status, niet bij het merk: rood blijft rood. */
const DARK_STATUS = {
  ok: '#4FCB92', warn: '#EDB25A', danger: '#FF7B7B', note: '#BBA2FF', info: '#7CC2FF', two: '#9AAE7B',
  okRgb: '79,203,146', warnRgb: '237,178,90', dangerRgb: '255,123,123',
  noteRgb: '187,162,255', infoRgb: '124,194,255', twoRgb: '154,174,123',
};
const LIGHT_STATUS = {
  ok: '#0F6344', warn: '#77500A', danger: '#A32A30', note: '#5B3FA8', info: '#245C99', two: '#4A5A34',
  okRgb: '15,99,68', warnRgb: '119,80,10', dangerRgb: '163,42,48',
  noteRgb: '91,63,168', infoRgb: '36,92,153', twoRgb: '74,90,52',
};

export type ClientTheme = 'dark' | 'light';

export const CLIENT_THEMES: Array<{ value: ClientTheme; label: string; hint: string }> = [
  { value: 'dark', label: 'Donker', hint: 'Rustig en ingetogen; foto\'s en video springen eruit.' },
  { value: 'light', label: 'Licht', hint: 'Open en zakelijk; leest als papier op het scherm.' },
];

export function clientTheme(value: string | null | undefined): ClientTheme {
  return value === 'light' ? 'light' : 'dark';
}

/**
 * Huisstijl die van buiten de app komt — nu alleen localStorage, waar het
 * portaal onthoudt hoe de vorige sessie eruitzag. Die waarde is door de
 * DB-CHECKs heen gegaan toen hij binnenkwam, maar op de schijf van de bezoeker
 * staat niets dat dat garandeert: wie daar één keer kan schrijven, zou het
 * inlogscherm anders van een vreemd merk kunnen voorzien en met een externe
 * logo-URL bovendien elk bezoek kunnen aftikken. Daarom hier dezelfde eisen als
 * in de database, en tekst afkappen op wat de instellingen toelaten.
 */
export function sanitizeStoredBranding(raw: unknown): BrandingPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
  const logo = typeof row.logoDataUrl === 'string' ? row.logoDataUrl : null;
  const accent = typeof row.accentColor === 'string' ? row.accentColor : '';
  return {
    // Exact de CHECK van company_settings_brand_logo_check: alleen een
    // ingesloten png/jpeg/webp, nooit een URL naar buiten en nooit svg.
    logoDataUrl:
      logo && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo) && logo.length <= 400_000
        ? logo
        : null,
    accentColor: /^#[0-9A-Fa-f]{6}$/.test(accent) ? accent : '#FFD966',
    footerText: text(row.footerText, 160),
    hidePoweredBy: row.hidePoweredBy === true,
    companyName: text(row.companyName, 120),
    headingFont: brandFont(typeof row.headingFont === 'string' ? row.headingFont : null).key,
    bodyFont: brandFont(typeof row.bodyFont === 'string' ? row.bodyFont : null).key,
    clientTheme: clientTheme(typeof row.clientTheme === 'string' ? row.clientTheme : null),
    headerColor: typeof row.headerColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(row.headerColor)
      ? row.headerColor
      : null,
    // Dezelfde eis als het logo hierboven (company_settings_brand_logo_dark_check).
    logoDarkDataUrl:
      typeof row.logoDarkDataUrl === 'string'
        && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(row.logoDarkDataUrl)
        && row.logoDarkDataUrl.length <= 400_000
        ? row.logoDarkDataUrl
        : null,
    // De CHECKs van 20261106080000: alleen hexkleuren, en een echte boolean.
    loginBackground: storedHex(row.loginBackground),
    loginCard: storedHex(row.loginCard),
    loginButton: storedHex(row.loginButton),
    loginPlain: row.loginPlain === true,
  };
}

function storedHex(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toUpperCase() : null;
}

/**
 * Vertaalt de huisstijl naar het complete tokenpakket van een klantpagina:
 * laag 1 (kanalen), laag 2 (semantiek) én de compat-laag, allemaal uitgerekend.
 * Uitsluitend CSS-variabelen, zodat dezelfde map zowel via `style.setProperty()`
 * als als React-`style`-object gebruikt kan worden.
 */
export function brandThemeVars(branding: BrandingPayload | null | undefined): Record<string, string> {
  const accent = /^#[0-9A-Fa-f]{6}$/.test(branding?.accentColor || '')
    ? branding!.accentColor.toUpperCase()
    : '#FFD966';
  const theme = clientTheme(branding?.clientTheme);
  const light = theme === 'light';
  const ramp = light ? LIGHT_RAMP : DARK_RAMP;
  const status = light ? LIGHT_STATUS : DARK_STATUS;

  const { h, s: accentSaturation } = hexToHsl(accent);
  // Een zwart-witmerk hoort een zwart-witportaal te krijgen: hoe grijzer de
  // merkkleur, hoe neutraler de vlakken. Vanaf ~35% verzadiging draagt de tint
  // volledig door — precies zoals het merkgoud dat vandaag doet.
  const tint = Math.min(1, accentSaturation / 0.35);
  const shade = (key: keyof NeutralRamp) => hslToHex({ h, s: ramp[key].s * tint, l: ramp[key].l });

  const bg = shade('bg');
  const bgDeep = shade('bgDeep');
  const surface = shade('surface');
  const surface2 = shade('surface2');
  const surface3 = shade('surface3');
  const line = shade('line');
  const line2 = shade('line2');
  const ink = shade('ink');
  const ink2 = shade('ink2');
  const ink3 = shade('ink3');

  const sheenRgb = light ? '26,23,16' : '255,255,255';
  const shadeRgb = light ? '26,23,16' : '0,0,0';
  const sheenK = light ? 0.55 : 1;
  const shadeK = light ? 0.3 : 1;
  const sheen = (alpha: number) => `rgba(${sheenRgb},${+(alpha * sheenK).toFixed(4)})`;

  const accentRgb = rgbTriplet(accent);
  // Accenttekst landt op de pagina, op de kaarten die erop liggen, én op de
  // statuschips — en die hebben zelf een vulling van 16% merkkleur (zie
  // `.portal-status.sent` en `.portal-task-status.status-doing` in globals.css).
  // Zonder die twee erbij zakt "Verstuurd" bij een verzadigd merk naar 3,8:1.
  // De inlogkaart van het portaal is doorzichtig: glans over een half-
  // doorzichtig vlak over --bg-deep. Op dat samenstel staat de eyebrow, en daar
  // zakte een verzadigd donker merk (bijv. #00084D) naar 4,2:1.
  const sheenHex = light ? '#1A1710' : '#FFFFFF';
  const loginCard = blendColors(sheenHex, blendColors(surface, bgDeep, 0.9), 0.075 * sheenK);
  // Het merktegeltje legt een laag van 24% merkkleur over --surface en zet daar
  // de initiaal in accentinkt op.
  const brandIcon = blendColors(accent, surface, 0.24);
  const accentInk = readableInk(accent, [
    bg, surface, surface2, surface3,
    blendColors(accent, surface3, 0.16),
    blendColors(accent, bg, 0.16),
    loginCard,
    brandIcon,
  ], light);
  // De merkkleur wordt ook als LIJN gebruikt — de rand van de primaire knop, de
  // focusring, de rand van een nieuw ticket. WCAG 1.4.11 vraagt daar 3:1, en
  // een licht merk op een licht vlak haalt dat niet: #FFD966 op wit is 1,37.
  // Dan tekenen we de lijn in een bijgestelde tint; de vulling blijft de
  // merkkleur zelf, conform de conventie dat goud een vlak is en geen streep.
  const accentEdge = contrastRatio(accent, surface) >= 3 && contrastRatio(accent, bg) >= 3
    ? accent
    : readableInk(accent, [surface, bg], light, 3);
  const accentEdgeRgb = rgbTriplet(accentEdge);

  // Statuschips ("Betaald", "Vervallen") zetten de statuskleur als tekst óp een
  // vulling van diezelfde kleur, op een kaart die zelf al een glanslaag heeft.
  // Zo gestapeld haalt #FF7B7B op zijn eigen 16% net geen 4,5:1. Deze inkt is
  // dezelfde kleur, alleen ver genoeg opgeschoven om leesbaar te zijn.
  // .065 is de glans op een portaalkaart; de publieke kaart legt er nog een
  // tweede verloopstop van .018 overheen. Model de dikste van de twee, anders
  // klopt de uitkomst voor het portaal wel en voor de factuurpagina net niet.
  const panel = blendColors(light ? '#1A1710' : '#FFFFFF', surface, 0.09 * sheenK);
  const statusInk = (color: string) =>
    readableInk(color, [panel, surface, blendColors(color, panel, 0.16)], light);
  // `.btn-primary:hover` stond op een hardgecodeerde #ffe08f: merkgoud, acht
  // punten lichter. Diezelfde stap, maar dan vanuit de merkkleur zelf.
  const accentHi = hexToHsl(accent);
  const accentHover = hslToHex({
    h: accentHi.h,
    s: accentHi.s,
    l: accentHi.l > 0.85 ? accentHi.l - 0.08 : accentHi.l + 0.08,
  });
  const onAccent = inkOnAccent(accent);
  const header = headerTheme(branding);
  const counter = header.dark
    ? `rgba(${rgbTriplet(HEADER_COUNTER.dark)},${HEADER_COUNTER.darkAlpha})`
    : `rgba(${rgbTriplet(HEADER_COUNTER.light)},${HEADER_COUNTER.lightAlpha})`;

  return {
    // ── 1. Kanalen ──
    '--sheen-rgb': sheenRgb,
    '--shade-rgb': shadeRgb,
    '--sheen-k': String(sheenK),
    '--shade-k': String(shadeK),
    '--ink-rgb': rgbTriplet(ink),
    '--bg-rgb': rgbTriplet(bg),
    '--bg-deep-rgb': rgbTriplet(bgDeep),
    '--surface-rgb': rgbTriplet(surface),
    '--surface2-rgb': rgbTriplet(surface2),
    '--surface3-rgb': rgbTriplet(surface3),
    '--accent-rgb': accentRgb,
    '--two-rgb': status.twoRgb,
    '--ok-rgb': status.okRgb,
    '--warn-rgb': status.warnRgb,
    '--danger-rgb': status.dangerRgb,
    '--note-rgb': status.noteRgb,
    '--info-rgb': status.infoRgb,

    // ── 2. Semantiek ──
    '--accent': accent,
    '--accent-ink': accentInk,
    '--accent-edge': accentEdge,
    '--accent-hover': accentHover,
    '--on-accent': onAccent,
    '--accent-face': accentFace(accent, onAccent),
    '--two': status.two,
    '--two-ink': status.two,
    '--ok': status.ok,
    '--warn': status.warn,
    '--danger': status.danger,
    '--note': status.note,
    '--info': status.info,
    '--ok-ink': statusInk(status.ok),
    '--warn-ink': statusInk(status.warn),
    '--danger-ink': statusInk(status.danger),
    '--note-ink': statusInk(status.note),
    '--bg': bg,
    '--bg-deep': bgDeep,
    '--surface': surface,
    '--surface-2': surface2,
    '--surface-3': surface3,
    '--sidebar-bg': shade('sidebar'),
    '--line': line,
    '--line-2': line2,
    '--line-accent': `rgba(${accentEdgeRgb},.42)`,
    '--ink': ink,
    '--ink-2': ink2,
    '--ink-3': ink3,
    '--ring': `0 0 0 3px rgba(${accentEdgeRgb},.34)`,

    // ── 3. Compat (moet mee; zie de toelichting bovenaan dit blok) ──
    '--bg2': surface,
    '--bg3': sheen(.055),
    '--bg4': sheen(.085),
    '--bg5': sheen(.12),
    '--panel': surface,
    '--panel-strong': surface2,
    '--border': line,
    '--border2': line2,
    '--border-strong': `rgba(${accentEdgeRgb},.42)`,
    '--text': ink,
    '--muted': ink3,
    '--muted2': ink2,
    '--accent-soft': `rgba(${accentRgb},.14)`,
    '--accent-glow': `rgba(${accentRgb},.28)`,
    '--accent-g': status.ok,
    '--accent-o': status.warn,
    '--accent-r': status.danger,
    '--accent-v': status.note,
    '--accent-b': status.info,

    // De lettertypen; de galerij gebruikt dezelfde twee tokens.
    '--brand-heading': brandFont(branding?.headingFont).stack,
    '--brand-body': brandFont(branding?.bodyFont).stack,

    // ── 4. De kop (portal-cockpit.css) ──
    '--hdr-top': header.top,
    '--hdr-mid': header.mid,
    '--hdr-bottom': header.bottom,
    '--hdr-ink': header.ink,
    '--hdr-ink-2': header.ink2,
    '--hdr-accent': header.accent,
    '--hdr-scheme': header.dark ? 'dark' : 'light',
    '--hdr-glass': header.dark ? `rgba(255,255,255,${HEADER_GLASS.dark})` : `rgba(0,0,0,${HEADER_GLASS.light})`,
    '--hdr-glass-2': header.dark ? 'rgba(255,255,255,.11)' : 'rgba(0,0,0,.08)',
    '--hdr-glass-line': header.dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.09)',
    '--hdr-hi': header.dark ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.4)',
    '--hdr-glow': `rgba(${accentRgb},${header.glowAlpha})`,
    // Het lijntje boven een tegel met iets dat te laat is: rood, maar zichtbaar
    // op deze kop (3 : 1, de norm voor een lijn).
    '--hdr-danger': readableInk(header.dark ? '#FF6B72' : '#A32A30', header.surfaces, !header.dark, 3),
    '--hdr-counter': counter,
    '--hdr-rings': ringsImage(header.dark),
  };
}

/**
 * Zet de huisstijl op `:root` zolang een klantpagina in beeld is. Bewust op de
 * documentroot en niet op de pagina zelf: de dropdown van `Select` wordt naar
 * `document.body` geportald en zou anders in het ResoFly-palet achterblijven —
 * en de compat-laag hierboven wordt sowieso alleen op `:root` opnieuw berekend.
 * `pageName` komt vóór de merknaam in de titel van het tabblad te staan.
 * Geeft een opruimfunctie terug die alles weer weghaalt.
 */
export function applyBrandTheme(
  branding: BrandingPayload | null | undefined,
  pageName = 'Klantportaal',
): () => void {
  if (typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  const vars = brandThemeVars(branding);
  const themeColor = document.querySelector('meta[name="theme-color"]');

  // Het bootstrap-script in index.html zet op ELKE route `data-theme` én een
  // inline `background` op <html>, afgeleid uit de voorkeur van wie hier ooit
  // als beheerder inlogde. Op het portaal telt die voorkeur niet: daar bepaalt
  // de huisstijl van de leverancier het beeld. Alles wat dat script aanraakt
  // zetten we dus zelf, en bij het verlaten weer precies terug.
  const before = {
    style: root.getAttribute('style'),
    theme: root.getAttribute('data-theme'),
    color: themeColor?.getAttribute('content') ?? null,
    title: document.title,
  };

  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  const theme = clientTheme(branding?.clientTheme);
  root.style.background = vars['--bg-deep'];
  root.style.colorScheme = theme;
  root.setAttribute('data-theme', theme);
  // Merker voor CSS die alleen mag gelden zolang er GEEN huisstijl staat, zoals
  // de noodrem die de publieke pagina's donker houdt (zie globals.css).
  root.dataset.brandTheme = theme;
  themeColor?.setAttribute('content', vars['--bg']);
  // Ook het tabblad: "ResoFly Werkruimte" hoort niet boven het portaal van een
  // ander te staan.
  document.title = branding?.companyName ? `${pageName} · ${branding.companyName}` : pageName;
  ensureBrandFontsLoaded([branding?.headingFont, branding?.bodyFont]);

  return () => {
    if (before.style === null) root.removeAttribute('style');
    else root.setAttribute('style', before.style);
    if (before.theme === null) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', before.theme);
    if (before.color !== null) themeColor?.setAttribute('content', before.color);
    document.title = before.title;
    delete root.dataset.brandTheme;
  };
}

// ── Het inlogscherm van het portaal ─────────────────────────────────────────
//
// De eerste indruk van het portaal: een vlak met één kaart erop. Zonder eigen
// keuzes is dat het vlak in de kopkleur (met de gloed van de merkkleur en de
// ringen) en een kaart in het werkvlak. De leverancier kan drie kleuren zelf
// kiezen (achtergrond, kaart, knop) en de achtergrond effen maken. Tekst,
// randen en de focusrand rekenen we hier uit, net als bij de kop: wat je ook
// kiest, het leest.
//
// Waarom een eigen set variabelen op het inlogscherm en niet op :root: het
// portaal daarna (de kop, het werkvlak, de kaarten) moet blijven zoals het is.
// En omdat een aangepaste eigenschap wordt uitgerekend op het element waar hij
// staat (zie de toelichting bij brandThemeVars), geeft loginTheme() bij een
// eigen kaart ook de compat-laag opnieuw mee: anders bleef bijvoorbeeld de
// rand van het invoerveld (--border) die van het werkvlak.

export type LoginTheme = {
  /** De achtergrond: hetzelfde verloop als de kop, rond de eigen kleur. */
  background: HeaderTheme;
  /** Eigen achtergrondkleur (true) of de kopkleur (false). */
  backgroundCustom: boolean;
  /** Effen: geen verloop, gloed en ringen. */
  plain: boolean;
  /** De kaart zoals hij getekend wordt. */
  card: string;
  /** Eigen kaartkleur (true) of het werkvlak (false). */
  cardCustom: boolean;
  /** Is de eigen kaartkleur in helderheid opgeschoven omdat er geen tekst op las? */
  cardAdjusted: boolean;
  /** Donkere kaart: lichte tekst. */
  cardDark: boolean;
  ink: string;
  ink2: string;
  ink3: string;
  /** De voorbeeldtekst in het lege invulveld; 4,5 : 1 op het veld, ook met focus. */
  placeholder: string;
  /** De knop (en de focusrand, het stipje en de regel boven de titel). */
  button: string;
  buttonCustom: boolean;
  onButton: string;
  /** De knopkleur als tekst op de kaart (de regel boven de titel). */
  accentInk: string;
  accentAdjusted: boolean;
  /** Een rand om de knop als die zelf te weinig afsteekt tegen de kaart; null = niet nodig. */
  buttonEdge: string | null;
  /** Alle vlakken op de kaart waar tekst op kan staan (voor het nameten). */
  cardSurfaces: string[];
  /** De CSS-variabelen voor `main.portal.login` (en het laadscherm ervoor). */
  vars: Record<string, string>;
};

const HEX6 = /^#[0-9A-Fa-f]{6}$/;

/** Glans op de kaart (verhoogde vlakken), zoals de thema's hem opbouwen. */
function sheenOn(card: string, dark: boolean, alpha: number): string {
  return blendColors(dark ? '#FFFFFF' : '#1A1710', card, alpha * (dark ? 1 : 0.55));
}

/**
 * Het invulveld (`--field`, globals.css laag 4). Het werkvlak heeft er een vaste
 * kleur voor: #0C0C0E in Donker, wit in Licht (een dieper vlak op een donkere
 * kaart, een wit vlak op een lichte). Op een eigen kaart dezelfde verhouding.
 */
function fieldOn(card: string, dark: boolean): string {
  return dark ? blendColors('#000000', card, 0.3) : blendColors('#FFFFFF', card, 0.7);
}

/** De tekstvlakken op een kaart: de kaart zelf en het invulveld. */
function cardTextSurfaces(card: string, field: string): string[] {
  return [card, field];
}

export function loginTheme(branding: BrandingPayload | null | undefined): LoginTheme {
  const base = brandThemeVars(branding);
  const light = clientTheme(branding?.clientTheme) === 'light';
  const accent = base['--accent'];

  const buttonCustom = HEX6.test(branding?.loginButton ?? '');
  const button = buttonCustom ? branding!.loginButton!.toUpperCase() : accent;
  const backgroundCustom = HEX6.test(branding?.loginBackground ?? '');
  const plain = branding?.loginPlain === true;

  // De achtergrond rekent precies als de kop: dezelfde gloed, ringen en
  // tegenlamp, maar rond de eigen kleur en met de knopkleur als gloed. Ook
  // hier kan er tekst op staan (het laadscherm), dus ook hier schuift een
  // kleur waar niets op leest een stukje op, en dat zegt de instellingenpagina.
  const background = headerTheme({
    logoDataUrl: null,
    footerText: null,
    hidePoweredBy: false,
    companyName: null,
    ...branding,
    accentColor: button,
    headerColor: backgroundCustom ? branding!.loginBackground! : (branding?.headerColor ?? null),
  });

  // ── De kaart ──
  const cardCustom = HEX6.test(branding?.loginCard ?? '');
  let card = base['--surface'];
  let cardDark = !light;
  let ink = base['--ink'];
  let ink2 = base['--ink-2'];
  let ink3 = base['--ink-3'];
  let cardAdjusted = false;
  if (cardCustom) {
    const chosen = branding!.loginCard!.toUpperCase();
    const { h, s } = hexToHsl(chosen);
    const tint = Math.min(1, s / 0.35);
    let l = hexToHsl(chosen).l;
    let candidates: string[] = [];
    let surfaces: string[] = [];
    // Licht of donker op wat het best leest. Een kaart midden in de grijstrap
    // laat geen van beide tot de norm komen; dan schuift de kaart een stukje van
    // het midden af, net als de kop. De tint blijft die van de gebruiker.
    for (let step = 0; step <= 40; step++) {
      card = step === 0 ? chosen : hslToHex({ h, s, l });
      cardDark = isDarkSurface(card);
      surfaces = cardTextSurfaces(card, fieldOn(card, cardDark));
      candidates = cardDark
        ? [hslToHex({ h, s: 0.25 * tint, l: 0.965 }), '#FFFFFF']
        : [hslToHex({ h, s: 0.3 * tint, l: 0.08 }), '#000000'];
      if (candidates.some(c => surfaces.every(bg => contrastRatio(c, bg) >= INK_TARGET))) break;
      l = clamp01(l + (cardDark ? -0.02 : 0.02));
    }
    cardAdjusted = card.toUpperCase() !== chosen;
    const passes = (c: string, target: number) => surfaces.every(bg => contrastRatio(c, bg) >= target);
    ink = candidates.find(c => passes(c, INK_TARGET)) ?? candidates[candidates.length - 1];
    // Gedempt: de inkt een stuk naar de kaart toe gemengd, nooit onder de norm.
    // ink-2 (de uitleg onder de titel) haalt dezelfde marge als de inkt, ink-3
    // (de tekst in het lege invoerveld, de afsluiting) de 4,5 van de norm.
    const muted = (target: number, from: number) => {
      for (let w = from; w <= 1.0001; w += 0.02) {
        const candidate = blendColors(ink, card, w);
        if (passes(candidate, target)) return candidate;
      }
      return ink;
    };
    ink2 = muted(INK_TARGET, 0.72);
    ink3 = muted(4.5, 0.58);
  }
  // Het werkvlak heeft een vaste veldkleur (zie fieldOn); een eigen kaart een
  // afgeleide, die hieronder als --field meegaat.
  const field = cardCustom ? fieldOn(card, cardDark) : (light ? '#FFFFFF' : '#0C0C0E');
  const cardSurfaces = cardTextSurfaces(card, field);
  // De voorbeeldtekst in het invulveld (jij@bedrijf.nl). De zachtste tint van
  // het werkvlak (--ink-3) haalt op het veld met focus niet bij elk merk 4,5
  // (een diep marineblauw merk: 4,41). Dan een stap naar de inkt toe.
  const placeholder = (() => {
    const passes = (c: string) => cardSurfaces.every(bg => contrastRatio(c, bg) >= 4.5);
    if (passes(ink3)) return ink3;
    for (let w = 0.02; w <= 1.0001; w += 0.02) {
      const candidate = blendColors(ink, ink3, w);
      if (passes(candidate)) return candidate;
    }
    return ink;
  })();

  // ── De knop en zijn kleur als tekst en lijn op de kaart ──
  const custom = cardCustom || buttonCustom;
  const accentInk = custom
    ? readableInk(button, [...cardSurfaces, blendColors(button, card, 0.16)], !cardDark)
    : base['--accent-ink'];
  const onButton = buttonCustom ? inkOnAccent(button) : base['--on-accent'];
  // WCAG 1.4.11: een knop moet als knop te zien zijn, 3 : 1 tegen wat eromheen
  // ligt. Een witte knop op een witte kaart is dat niet; dan krijgt hij een rand
  // in dezelfde tint, ver genoeg opgeschoven. De vulling blijft de gekozen kleur.
  const edgeOk = contrastRatio(button, card) >= 3;
  const accentEdge = edgeOk ? button : readableInk(button, [card], !cardDark, 3);
  const buttonEdge = edgeOk ? null : accentEdge;

  // ── De variabelen ──
  const counter = background.dark
    ? `rgba(${rgbTriplet(HEADER_COUNTER.dark)},${HEADER_COUNTER.darkAlpha})`
    : `rgba(${rgbTriplet(HEADER_COUNTER.light)},${HEADER_COUNTER.lightAlpha})`;
  const vars: Record<string, string> = {
    '--hdr-top': plain ? background.mid : background.top,
    '--hdr-mid': background.mid,
    '--hdr-bottom': plain ? background.mid : background.bottom,
    '--hdr-ink': background.ink,
    '--hdr-ink-2': background.ink2,
    '--hdr-accent': background.accent,
    '--hdr-scheme': background.dark ? 'dark' : 'light',
    '--hdr-glow': plain ? 'transparent' : `rgba(${rgbTriplet(button)},${background.glowAlpha})`,
    '--hdr-counter': plain ? 'transparent' : counter,
    '--hdr-rings': plain ? 'none' : ringsImage(background.dark),
    // Het invoerveld en de knop op de kaart horen bij de kaart, niet bij de
    // achtergrond: anders tekent de browser een donker invulveld op een lichte kaart.
    '--login-card-scheme': cardDark ? 'dark' : 'light',
    '--login-placeholder': placeholder,
  };
  if (buttonEdge) vars['--login-btn-edge'] = buttonEdge;

  if (custom) {
    const buttonRgb = rgbTriplet(button);
    const edgeRgb = rgbTriplet(accentEdge);
    const b = hexToHsl(button);
    Object.assign(vars, {
      '--accent': button,
      '--accent-rgb': buttonRgb,
      '--accent-ink': accentInk,
      '--accent-edge': accentEdge,
      '--accent-hover': hslToHex({ h: b.h, s: b.s, l: b.l > 0.85 ? b.l - 0.08 : b.l + 0.08 }),
      '--on-accent': onButton,
      '--accent-face': accentFace(button, onButton),
      '--line-accent': `rgba(${edgeRgb},.42)`,
      '--border-strong': `rgba(${edgeRgb},.42)`,
      // De rand van een veld met focus (globals.css laag 4).
      '--focus-line': `rgba(${edgeRgb},.62)`,
      '--ring': `0 0 0 3px rgba(${edgeRgb},.34)`,
      '--accent-soft': `rgba(${buttonRgb},.14)`,
      '--accent-glow': `rgba(${buttonRgb},.28)`,
    });
  }

  if (cardCustom) {
    const status = cardDark ? DARK_STATUS : LIGHT_STATUS;
    // "We hebben je een link gestuurd" en een foutmelding: statuskleur als tekst
    // op een vulling van 10% van die kleur, op de kaart.
    const statusInk = (color: string) => readableInk(color, [card, blendColors(color, card, 0.1), blendColors(color, card, 0.16)], !cardDark);
    const okInk = statusInk(status.ok);
    const dangerInk = statusInk(status.danger);
    const sheenRgb = cardDark ? '255,255,255' : '26,23,16';
    const sheenK = cardDark ? 1 : 0.55;
    const sheen = (alpha: number) => `rgba(${sheenRgb},${+(alpha * sheenK).toFixed(4)})`;
    const surface2 = sheenOn(card, cardDark, 0.04);
    const surface3 = sheenOn(card, cardDark, 0.07);
    const line = blendColors(ink, card, 0.14);
    const line2 = blendColors(ink, card, 0.24);
    Object.assign(vars, {
      '--sheen-rgb': sheenRgb,
      '--shade-rgb': cardDark ? '0,0,0' : '26,23,16',
      '--sheen-k': String(sheenK),
      '--shade-k': String(cardDark ? 1 : 0.3),
      '--ink-rgb': rgbTriplet(ink),
      '--surface-rgb': rgbTriplet(card),
      '--surface2-rgb': rgbTriplet(surface2),
      '--surface3-rgb': rgbTriplet(surface3),
      '--surface': card,
      '--surface-2': surface2,
      '--surface-3': surface3,
      '--line': line,
      '--line-2': line2,
      '--line-3': blendColors(ink, card, 0.34),
      // Het invulveld en het licht op de bovenrand van de kaart, uit de
      // Cockpit-laag: die staan op :root per sfeer vast en kleuren anders niet mee.
      '--field': field,
      '--hi': cardDark ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.7)',
      '--ink': ink,
      '--ink-2': ink2,
      '--ink-3': ink3,
      '--ok': status.ok,
      '--ok-rgb': status.okRgb,
      '--ok-ink': okInk,
      '--danger': status.danger,
      '--danger-rgb': status.dangerRgb,
      '--danger-ink': dangerInk,
      '--bg2': card,
      '--bg3': sheen(0.055),
      '--bg4': sheen(0.085),
      '--bg5': sheen(0.12),
      '--panel': card,
      '--panel-strong': surface2,
      '--border': line,
      '--border2': line2,
      '--text': ink,
      '--muted': ink3,
      '--muted2': ink2,
      '--accent-g': okInk,
      '--accent-r': dangerInk,
    });
  }

  return {
    background, backgroundCustom, plain,
    card, cardCustom, cardAdjusted, cardDark, ink, ink2, ink3, placeholder,
    button, buttonCustom, onButton,
    accentInk, accentAdjusted: accentInk.toUpperCase() !== button.toUpperCase(),
    buttonEdge, cardSurfaces, vars,
  };
}

export function loginThemeVars(branding: BrandingPayload | null | undefined): Record<string, string> {
  return loginTheme(branding).vars;
}
