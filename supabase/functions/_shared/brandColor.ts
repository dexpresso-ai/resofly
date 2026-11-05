// ============================================================
// De merkkleur leesbaar houden — KOPIE van src/lib/brandColor.ts voor de edge
// functions: de PDF (documentLayout.ts) en de mails (emailTemplates/layout.ts)
// rekenen hiermee, net als de klantpagina's in de app. De uitleg staat
// bovenin het origineel.
//
// Pas de twee altijd samen aan: src/lib/brandColor.test.ts vergelijkt ze vanaf
// de markering hieronder teken voor teken. Puur: geen imports, geen Deno-API's.
// ============================================================

// ---- Vanaf hier is dit bestand gelijk aan zijn spiegel (zie de test). ----

export type Hsl = { h: number; s: number; l: number };

/** "#RRGGBB" → [rood, groen, blauw], elk 0–255. */
export function hexChannels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

/** [rood, groen, blauw] → "#RRGGBB", afgerond en binnen 0–255. */
export function channelsHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** Waargenomen helderheid (0–1): de sRGB-luminantie uit WCAG 2. */
export function relativeLuminance(hex: string): number {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexChannels(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG-contrastverhouding tussen twee kleuren, van 1 (gelijk) tot 21 (zwart op wit). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function hexToHsl(hex: string): Hsl {
  const [r, g, b] = hexChannels(hex).map(c => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h: h < 0 ? h + 360 : h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return channelsHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** Een halfdoorzichtige kleur plat op een ondergrond, zoals een browser of PDF-lezer hem tekent. */
export function blendColors(front: string, back: string, alpha: number): string {
  const f = hexChannels(front);
  const k = hexChannels(back);
  return channelsHex(f[0] * alpha + k[0] * (1 - alpha), f[1] * alpha + k[1] * (1 - alpha), f[2] * alpha + k[2] * (1 - alpha));
}

/**
 * De merkkleur als tekst of lijn op één of meer vlakken. Alleen de helderheid
 * schuift, in stappen van 2%; tint en verzadiging blijven staan, zodat het
 * herkenbaar dezelfde kleur blijft (een ingetogen taupe wordt geen oranje).
 * Haalt de kleur het doel al op elk vlak, dan blijft hij precies zichzelf.
 * Lukt het niet, dan zwart (donkerder) of wit (lichter).
 */
export function readableShade(color: string, backgrounds: string[], options: { direction: 'darker' | 'lighter'; target?: number }): string {
  const target = options.target ?? 4.5;
  const passes = (candidate: string) => backgrounds.every(background => contrastRatio(candidate, background) >= target);
  if (passes(color)) return color;
  const { h, s, l } = hexToHsl(color);
  const step = options.direction === 'darker' ? -0.02 : 0.02;
  for (let i = 0, next = l; i <= 50 && next >= 0 && next <= 1; i += 1, next += step) {
    const candidate = hslToHex({ h, s, l: next });
    if (passes(candidate)) return candidate;
  }
  return options.direction === 'darker' ? '#000000' : '#FFFFFF';
}

/**
 * Tekst óp een vlak in deze kleur (een knop): de donkere of de lichte
 * kandidaat, wat het best leest. Haalt geen van beide 4,5 : 1 — een kleur
 * midden in de grijstrap — dan puur zwart of wit: meer laat zo'n kleur niet toe.
 */
export function textOnColor(color: string, dark = '#111111', light = '#FFFFFF'): string {
  const best = contrastRatio(color, dark) >= contrastRatio(color, light) ? dark : light;
  if (contrastRatio(color, best) >= 4.5) return best;
  return contrastRatio(color, '#000000') >= contrastRatio(color, '#FFFFFF') ? '#000000' : '#FFFFFF';
}
