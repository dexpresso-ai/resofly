/**
 * Agendakleuren zoals ze in het rooster staan.
 *
 * Een gekoppelde Google-agenda geeft via `calendarList` zijn kleur door als
 * `backgroundColor`, en dat is nog altijd Google's oude palet van 24 kleuren,
 * waarvan een groot deel pastel: #9fe1e7, #fad165, #c2c2c2… In ResoFly stonden afspraken daardoor
 * in flets pastel, en dat las als "mat" naast de rest van de app (november
 * 2026). Google Agenda zelf toont dezelfde agenda in een vollere tint uit
 * hetzelfde kleurvak; die nemen we hier over.
 *
 * Niets hiervan wordt opgeslagen: de database houdt de kleur die de bron gaf,
 * zodat een volgende synchronisatie niets "terugzet". Het is alleen weergave.
 *
 * Bewust zonder React, zodat `npm test` het kan nalopen.
 */

/**
 * De bleke kleuren uit Google's oude agendapalet (calendarList.backgroundColor)
 * → de volle tint van hetzelfde kleurvak. Alleen de pastels: voor bosbes,
 * lavendel, blauweregen en amethist is Google's nieuwere tint juist zachter,
 * en dat is het omgekeerde van waar dit voor is. Die vallen onder de algemene
 * regel hieronder (of blijven, als ze al vol zijn). `calendarColors.test.ts`
 * bewaakt dat elke vertaling voller is.
 */
export const GOOGLE_LEGACY_CALENDAR_COLORS: Readonly<Record<string, string>> = {
  '#9fe1e7': '#039BE5', // pauw
  '#9fc6e7': '#4285F4', // kobalt
  '#92e1c0': '#33B679', // salie
  '#b3dc6c': '#C0CA33', // avocado
  '#fbe983': '#E4C441', // citroen
  '#fad165': '#F6BF26', // banaan
  '#f691b2': '#D81B60', // kersenbloesem
  '#cca6ac': '#AD1457', // radicchio
  '#cabdbf': '#A79B8E', // berk
  '#c2c2c2': '#616161', // grafiet: grijs blijft grijs, maar met contrast
};

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;

function expand(hex: string): string | null {
  const value = hex.trim();
  if (HEX6.test(value)) return value.toLowerCase();
  const short = HEX3.exec(value);
  if (short) return `#${[...short[1]].map((c) => c + c).join('')}`.toLowerCase();
  return null;
}

function toHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number): string {
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

/**
 * Wanneer een kleur "bleek" is: licht én weinig kleur. Op lichtheid alleen
 * ging het mis: lavendel uit de eigen projectkleuren (#A78BFA) is licht, maar
 * vol, en werd dan ten onrechte donkerder. Het merkgoud (#FFD966) en de andere
 * projectkleuren vallen er allemaal buiten; de test noemt ze.
 */
const PALE_LIGHTNESS = 0.72;
const PALE_CHROMA = 0.42;
/** Grijs (bijna geen verzadiging) blijft grijs; dat is een keuze, geen vergissing. */
const GREY_SATURATION = 0.15;

function chromaOf(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return Math.max(...v) - Math.min(...v);
}

/**
 * De kleur waarin een agenda in het rooster staat. Google's oude palet krijgt
 * zijn volle tint; een andere heel bleke kleur (Microsoft geeft ook pastel
 * door) wordt donkerder en voller in dezelfde tint. Al het andere blijft
 * precies zoals het was. Een onbruikbare waarde geeft `fallback` terug.
 */
export function vividCalendarColor(color: string | null | undefined, fallback = '#FFD966'): string {
  const hex = color ? expand(color) : null;
  if (!hex) return fallback;
  const mapped = GOOGLE_LEGACY_CALENDAR_COLORS[hex];
  if (mapped) return mapped;
  const { h, s, l } = toHsl(hex);
  if (l < PALE_LIGHTNESS || chromaOf(hex) >= PALE_CHROMA || s < GREY_SATURATION) return hex.toUpperCase();
  // Van pastel naar een volle, nog lichte tint (lichtheid ~0,6–0,68, meer
  // verzadiging). Dezelfde tint, zodat een agenda herkenbaar zijn eigen kleur
  // houdt; een eerste versie met lichtheid 0,56 maakte van lichtlavendel diep
  // violet.
  return fromHsl(h, Math.min(0.85, s + 0.25), 0.6 + (l - PALE_LIGHTNESS) * 0.3);
}
