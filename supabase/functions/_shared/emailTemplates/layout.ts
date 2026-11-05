// De sjablonen importeren alleen elkaar en de pure kleurregel (../brandColor.ts):
// geen Deno-API's, geen npm, zodat ze ook in de node-tests draaien.
import { contrastRatio, readableShade, textOnColor } from '../brandColor.ts';

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
// De rekenregel zelf staat in ../brandColor.ts: dezelfde als de klantpagina's
// (src/lib/branding.ts) en de PDF (documentLayout.ts). De tint van het merk
// blijft, alleen de helderheid schuift tot de tekst 4,5 : 1 haalt. Eerst
// stond hier een eigen kopie; de drie liepen al uit elkaar.

/** De WCAG-contrastverhouding (zo heette hij hier al). */
export const emailContrast = contrastRatio;

/**
 * Tekst óp de merkkleur (een knop): bijna-zwart of wit, wat het best leest.
 * Een merkkleur midden in de grijstrap (#7A7A7A) haalt met geen van beide de
 * 4,5 : 1; dan puur zwart, net als op de klantpagina's en in de PDF.
 */
export function textOnAccent(accent: string): string {
  return textOnColor(sanitizeAccentColor(accent));
}

/** De merkkleur als tekst of streep op een donker vlak, opgehelderd tot 4,5 : 1. */
export function accentOnDark(accent: string, background: string = EMAIL_CARD): string {
  return readableShade(sanitizeAccentColor(accent), [background], { direction: 'lighter' });
}

export function textLines(lines: Array<string | null | undefined | false>): string {
  return lines
    .filter((line): line is string => line !== null && line !== undefined && line !== false)
    .join('\n')
    .trimEnd();
}
