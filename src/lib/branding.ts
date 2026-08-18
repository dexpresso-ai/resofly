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
  /** Sfeer van de klantgerichte pagina's: 'dark' (standaard) of 'light'. */
  clientTheme?: string | null;
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

type Hsl = { h: number; s: number; l: number };

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** "255,217,102" — het formaat waarin globals.css kleuren met alfa opbouwt. */
function rgbTriplet(hex: string): string {
  return hexToRgb(hex).join(',');
}

function hexToHsl(hex: string): Hsl {
  const [r, g, b] = hexToRgb(hex).map(c => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}

function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];
  const channel = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

/** Een halftransparante kleur plat op een ondergrond, zoals de browser hem tekent. */
function blend(front: string, back: string, alpha: number): string {
  const f = hexToRgb(front);
  const b = hexToRgb(back);
  const mix = (i: number) => Math.round(f[i] * alpha + b[i] * (1 - alpha));
  return `#${[0, 1, 2].map(i => mix(i).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** WCAG-contrastverhouding (1–21) tussen twee hexkleuren. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
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
  const base = hexToHsl(accent);
  // Alleen de helderheid schuift; tint én verzadiging blijven staan. Anders
  // krijgt een ingetogen merk (denk aan taupe #8A7F70) opeens een oranje
  // accenttekst — leesbaar, maar niet meer zijn kleur.
  const step = darker ? -0.02 : 0.02;
  let l = base.l;
  for (let i = 0; i <= 50; i++) {
    const candidate = hslToHex({ h: base.h, s: base.s, l });
    if (backgrounds.every(bg => contrast(candidate, bg) >= target)) return candidate;
    l += step;
    if (l < 0 || l > 1) break;
  }
  return darker ? '#000000' : '#FFFFFF';
}

/**
 * Tekst óp een merkkleurig vlak: bijna-zwart of bijna-wit, wat beter leest. Een
 * merkkleur in het midden van de grijstrap (denk aan #7A7A7A) haalt met een
 * getinte variant net geen 4.5:1; dan gaat het door naar puur zwart of wit,
 * want dat is het maximum dat zo'n kleur überhaupt toelaat.
 */
function inkOnAccent(accent: string): string {
  const { h, s } = hexToHsl(accent);
  const candidates = [
    hslToHex({ h, s: Math.min(s, 0.3), l: 0.08 }),
    hslToHex({ h, s: Math.min(s, 0.12), l: 0.97 }),
    '#000000',
    '#FFFFFF',
  ];
  const tinted = candidates.slice(0, 2).sort((a, b) => contrast(b, accent) - contrast(a, accent))[0];
  if (contrast(tinted, accent) >= 4.5) return tinted;
  return candidates.sort((a, b) => contrast(b, accent) - contrast(a, accent))[0];
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
  };
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
  const loginCard = blend(sheenHex, blend(surface, bgDeep, 0.9), 0.075 * sheenK);
  // Het merktegeltje legt een laag van 24% merkkleur over --surface en zet daar
  // de initiaal in accentinkt op.
  const brandIcon = blend(accent, surface, 0.24);
  const accentInk = readableInk(accent, [
    bg, surface, surface2, surface3,
    blend(accent, surface3, 0.16),
    blend(accent, bg, 0.16),
    loginCard,
    brandIcon,
  ], light);
  // De merkkleur wordt ook als LIJN gebruikt — de rand van de primaire knop, de
  // focusring, de rand van een nieuw ticket. WCAG 1.4.11 vraagt daar 3:1, en
  // een licht merk op een licht vlak haalt dat niet: #FFD966 op wit is 1,37.
  // Dan tekenen we de lijn in een bijgestelde tint; de vulling blijft de
  // merkkleur zelf, conform de conventie dat goud een vlak is en geen streep.
  const accentEdge = contrast(accent, surface) >= 3 && contrast(accent, bg) >= 3
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
  const panel = blend(light ? '#1A1710' : '#FFFFFF', surface, 0.09 * sheenK);
  const statusInk = (color: string) =>
    readableInk(color, [panel, surface, blend(color, panel, 0.16)], light);
  // `.btn-primary:hover` stond op een hardgecodeerde #ffe08f: merkgoud, acht
  // punten lichter. Diezelfde stap, maar dan vanuit de merkkleur zelf.
  const accentHi = hexToHsl(accent);
  const accentHover = hslToHex({
    h: accentHi.h,
    s: accentHi.s,
    l: accentHi.l > 0.85 ? accentHi.l - 0.08 : accentHi.l + 0.08,
  });

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
    '--on-accent': inkOnAccent(accent),
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
