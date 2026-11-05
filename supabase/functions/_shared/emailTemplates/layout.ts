export type EmailLayoutInput = {
  brandName: string;
  preheader?: string;
  title: string;
  eyebrow?: string;
  introHtml: string;
  bodyHtml?: string;
  cta?: { label: string; url: string };
  footerHtml?: string;
  accentColor?: string | null;
};

/** Het vlak van de mailkaart; de merkkleur als tekst wordt hiertegen gemeten. */
export const EMAIL_CARD = '#1b1b1f';

// ── Plek voor het logo ──────────────────────────────────────────────────────
// De sjablonen zetten alleen een merkteken waar het logo van de organisatie
// hoort; _shared/emailBrand.ts vult het in vlak voor het versturen, met het
// logo als ingesloten afbeelding (cid). Het zijn HTML-commentaren: vult een
// route ze niet in, dan is de mail precies zoals vroeger, zonder logo.

/** Bovenaan een donkere kaart: de lichte versie, of het logo op een wit plaatje. */
export const EMAIL_LOGO_SLOT_DARK = '<!--merklogo:donker-->';
/** Bovenaan een lichte kaart: het gewone logo. */
export const EMAIL_LOGO_SLOT_LIGHT = '<!--merklogo:licht-->';
/** Onder een lichte kaart, als een handtekening (een persoonlijk bericht): het gewone logo. */
export const EMAIL_LOGO_SLOT_SIGNATURE = '<!--merklogo:onder-->';
/**
 * Om een bovenregel die alleen de naam van de organisatie is. Staat het logo
 * erboven, dan vervalt die regel: het logo komt in de plaats van de naam, net
 * als op de klantpagina's (BrandMark).
 */
export const EMAIL_BRAND_NAME_START = '<!--merknaam-->';
export const EMAIL_BRAND_NAME_END = '<!--/merknaam-->';

/** De naam als bovenregel, gemarkeerd zodat het logo hem kan vervangen. */
export function brandNameLine(html: string): string {
  return `${EMAIL_BRAND_NAME_START}${html}${EMAIL_BRAND_NAME_END}`;
}

export function renderEmailLayout(input: EmailLayoutInput): string {
  const accentColor = sanitizeAccentColor(input.accentColor);
  // De knop en de bovenregel in de merkkleur van de organisatie, maar wel
  // leesbaar: tot november 2026 stond de knoptekst vast op #111111 en de
  // bovenregel in de merkkleur zelf. Bij een donkerblauw merk (#00084D) was
  // allebei onzichtbaar (1,0 : 1).
  const onAccent = textOnAccent(accentColor);
  const eyebrowColor = accentOnDark(accentColor, EMAIL_CARD);
  const brandName = input.brandName || 'ResoFly';
  const escapedBrandName = escapeHtml(brandName);
  const preheader = input.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>` : '';
  const cta = input.cta
    ? `<p style="margin:28px 0 6px;"><a href="${escapeHtml(input.cta.url)}" style="display:inline-block;background:${accentColor};color:${onAccent};text-decoration:none;font-weight:700;padding:14px 20px;border-radius:14px;">${escapeHtml(input.cta.label)}</a></p>`
    : '';
  const eyebrowText = input.eyebrow || brandName;
  const eyebrow = `<p style="margin:0 0 8px;color:${eyebrowColor};font-size:13px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;">${escapeHtml(eyebrowText)}</p>`;

  return `<!doctype html>
<html lang="nl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
  </head>
  <body style="margin:0;background:#111111;font-family:Arial,Helvetica,sans-serif;color:#f5f5f5;">
    ${preheader}
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#1b1b1f;border:1px solid #303038;border-radius:24px;padding:28px;">
        ${EMAIL_LOGO_SLOT_DARK}${eyebrowText === brandName ? brandNameLine(eyebrow) : eyebrow}
        <h1 style="margin:0 0 16px;font-size:28px;line-height:1.15;color:#ffffff;">${escapeHtml(input.title)}</h1>
        <div style="margin:0;color:#d8d8df;font-size:16px;line-height:1.6;">${input.introHtml}</div>
        ${input.bodyHtml || ''}
        ${cta}
        ${input.footerHtml ? `<div style="margin-top:24px;color:#9b9ba7;font-size:13px;line-height:1.5;">${input.footerHtml}</div>` : ''}
      </div>
      <p style="margin:18px 4px 0;color:#747480;font-size:12px;line-height:1.5;">Verzonden via ${escapedBrandName}.</p>
    </div>
  </body>
</html>`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char] || char));
}

export function sanitizeAccentColor(value?: string | null): string {
  const candidate = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : '#FFD966';
}

// ── Leesbare merkkleur ──────────────────────────────────────────────────────
// Dezelfde regels als src/lib/branding.ts (klantpagina's) en de PDF-opmaak:
// de tint van het merk blijft, alleen de helderheid schuift tot de tekst de
// WCAG-norm van 4,5 : 1 haalt. Hier los, want deze map heeft geen imports.

function channels(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function emailContrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function toHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = channels(hex).map(c => c / 255);
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

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const hex = (v: number) => Math.max(0, Math.min(255, Math.round((v + m) * 255))).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

/**
 * Tekst óp de merkkleur (een knop): bijna-zwart of wit, wat het best leest.
 * Een merkkleur midden in de grijstrap (#7A7A7A) haalt met geen van beide de
 * 4,5 : 1; dan puur zwart, net als op de klantpagina's (inkOnAccent).
 */
export function textOnAccent(accent: string): string {
  const color = sanitizeAccentColor(accent);
  const best = emailContrast(color, '#111111') >= emailContrast(color, '#FFFFFF') ? '#111111' : '#FFFFFF';
  return emailContrast(color, best) >= 4.5 ? best : '#000000';
}

/** De merkkleur als tekst of streep op een donker vlak, opgehelderd tot 4,5 : 1. */
export function accentOnDark(accent: string, background: string = EMAIL_CARD): string {
  const color = sanitizeAccentColor(accent);
  if (emailContrast(color, background) >= 4.5) return color;
  const { h, s, l } = toHsl(color);
  for (let next = l; next <= 1; next += 0.02) {
    const candidate = fromHsl(h, s, Math.min(1, next));
    if (emailContrast(candidate, background) >= 4.5) return candidate;
  }
  return '#FFFFFF';
}

export function textLines(lines: Array<string | null | undefined | false>): string {
  return lines
    .filter((line): line is string => line !== null && line !== undefined && line !== false)
    .join('\n')
    .trimEnd();
}
