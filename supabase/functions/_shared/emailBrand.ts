// Het logo van de organisatie in elke mail die de deur uit gaat.
//
// Hoe: het logo gaat als bijlage mee met een Content-ID, en de HTML verwijst
// ernaar met <img src="cid:…">. Resend kent dat via `content_id` op een
// bijlage (https://resend.com/docs/dashboard/emails/embed-inline-images).
//
// Waarom zo en niet anders:
// - een data:-URL in de <img> tonen Gmail en Outlook niet; er staat dan een
//   leeg vlak bovenaan de factuur;
// - een afbeelding van internet houdt Outlook tegen tot de ontvanger op
//   "Afbeeldingen downloaden" klikt, en in de tussentijd staat er een kruisje;
// - een ingesloten afbeelding tonen de gangbare mailprogramma's meteen.
//
// De sjablonen zetten alleen een merkteken waar het logo hoort
// (EMAIL_LOGO_SLOT_DARK / _LIGHT in emailTemplates/layout.ts). Dit bestand vult
// het in, vlak voor het versturen: `withEmailBrand(payload, brand)`. Vergeet
// een route dat, dan blijft het commentaar staan en gaat de mail zoals vroeger
// de deur uit, zonder logo maar heel. emailBrand.test.ts bewaakt dat elke
// verzendroute het doet.
//
// Gooit nooit. Geen logo, een logo dat we niet kunnen lezen, of een migratie
// die nog moet: dan gaat de mail zonder logo, met de naam als bovenregel.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  EMAIL_BRAND_NAME_END,
  EMAIL_BRAND_NAME_START,
  EMAIL_LOGO_SLOT_DARK,
  EMAIL_LOGO_SLOT_LIGHT,
  EMAIL_LOGO_SLOT_SIGNATURE,
  escapeHtml,
} from './emailTemplates/layout.ts';

export interface EmailLogo {
  contentType: 'image/png' | 'image/jpeg';
  base64: string;
  /** Maat in de mail (px): binnen EMAIL_LOGO_MAX, in de verhouding van het beeld. */
  width: number;
  height: number;
}

export interface EmailBrand {
  /** Handelsnaam of bedrijfsnaam: de alt-tekst, voor wie afbeeldingen uit heeft. */
  name: string;
  /** Het gewone logo, voor een licht vlak. */
  logo: EmailLogo | null;
  /** De lichte versie voor een donker vlak; zonder komt het gewone logo op een wit plaatje. */
  logoOnDark: EmailLogo | null;
}

/** Een ingesloten afbeelding zoals Resend hem wil hebben. */
export interface EmailInlineAttachment {
  filename: string;
  content: string;
  content_type: string;
  content_id: string;
}

/**
 * Hoe groot het logo in de mail staat. Een liggend logo (4 : 1) wordt 200 × 50,
 * een vierkant 56 × 56. Groter oogt als reclame; kleiner is een vlekje op een
 * telefoon. Het beeld zelf is groter (tot 600 px), dus scherp op een
 * retinascherm.
 */
export const EMAIL_LOGO_MAX = { width: 200, height: 56 };

const CID_LOGO = 'merklogo';
const CID_LOGO_ON_DARK = 'merklogo-licht';

/** Dezelfde eis als de CHECK op de logokolommen, maar zonder WebP: Outlook toont dat niet. */
const LOGO_DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

export const NO_EMAIL_BRAND: EmailBrand = { name: '', logo: null, logoOnDark: null };

/** Leest een logo uit een data-URL. Null als het geen PNG of JPEG is, of als de maat niet te lezen is. */
export function emailLogoFromDataUrl(dataUrl: unknown): EmailLogo | null {
  if (typeof dataUrl !== 'string') return null;
  const match = LOGO_DATA_URL.exec(dataUrl.trim());
  if (!match) return null;
  const contentType = match[1] === 'png' ? 'image/png' : 'image/jpeg';
  const base64 = match[2];
  let bytes: string;
  try {
    bytes = atob(base64);
  } catch {
    return null;
  }
  const size = contentType === 'image/png' ? pngSize(bytes) : jpegSize(bytes);
  if (!size) return null;
  const scale = Math.min(1, EMAIL_LOGO_MAX.width / size.width, EMAIL_LOGO_MAX.height / size.height);
  return {
    contentType,
    base64,
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** Breedte en hoogte uit de IHDR van een PNG. */
function pngSize(bytes: string): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || bytes.slice(12, 16) !== 'IHDR') return null;
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Breedte en hoogte uit het eerste SOF-segment van een JPEG. */
function jpegSize(bytes: string): { width: number; height: number } | null {
  if (bytes.charCodeAt(0) !== 0xff || bytes.charCodeAt(1) !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes.charCodeAt(at) !== 0xff) return null;
    const marker = bytes.charCodeAt(at + 1);
    // Opvulling (FF FF …) en markers zonder lengte overslaan.
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = uint16(bytes, at + 2);
    if (length < 2) return null;
    // SOF0–SOF15, behalve DHT (C4), JPG (C8) en DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = uint16(bytes, at + 5);
      const width = uint16(bytes, at + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    // Begin van de beelddata zonder SOF ervoor: geen geldige JPEG.
    if (marker === 0xda || marker === 0xd9) return null;
    at += 2 + length;
  }
  return null;
}

function uint16(bytes: string, at: number): number {
  return (bytes.charCodeAt(at) << 8) | bytes.charCodeAt(at + 1);
}

function uint32(bytes: string, at: number): number {
  return ((bytes.charCodeAt(at) << 24) >>> 0) + (bytes.charCodeAt(at + 1) << 16) + (bytes.charCodeAt(at + 2) << 8) + bytes.charCodeAt(at + 3);
}

/** De mailhuisstijl uit een company_settings-rij (alleen naam en logo's). */
export function emailBrandFromRow(row: Record<string, unknown> | null | undefined): EmailBrand {
  if (!row) return { ...NO_EMAIL_BRAND };
  const name = String(row.trade_name || row.company_name || '').trim();
  return {
    name,
    logo: emailLogoFromDataUrl(row.brand_logo_data_url),
    logoOnDark: emailLogoFromDataUrl(row.brand_logo_dark_data_url),
  };
}

const EMAIL_BRAND_COLUMNS = 'company_name,trade_name,brand_logo_data_url,brand_logo_dark_data_url';

/**
 * Haalt naam en logo's van één organisatie op, gefilterd op `organizationId`
 * (de service-role ziet alles; de route heeft de organisatie al uit de sessie,
 * het token of de eigen rij gehaald). Een eigen, kleine query: de logo's zijn
 * tot 300 kB en horen niet in de bedrijfsgegevens die bij elke actie meegaan.
 */
export async function loadEmailBrand(supabaseAdmin: SupabaseClient, organizationId: string | null | undefined): Promise<EmailBrand> {
  if (!organizationId) return { ...NO_EMAIL_BRAND };
  try {
    const query = (columns: string) => supabaseAdmin
      .from('company_settings')
      .select(columns)
      .eq('organization_id', organizationId)
      .maybeSingle();
    let { data, error } = await query(EMAIL_BRAND_COLUMNS);
    if (error) {
      // De lichte versie kwam later (20261015000000); zonder die kolom kan het
      // gewone logo nog steeds mee.
      ({ data, error } = await query(EMAIL_BRAND_COLUMNS.replace(',brand_logo_dark_data_url', '')));
    }
    if (error) {
      console.warn('maillogo laden mislukt; de mail gaat zonder logo', error.message);
      return { ...NO_EMAIL_BRAND };
    }
    return emailBrandFromRow(data as Record<string, unknown> | null);
  } catch (error) {
    console.warn('maillogo laden crashte; de mail gaat zonder logo', error instanceof Error ? error.message : error);
    return { ...NO_EMAIL_BRAND };
  }
}

function logoImage(logo: EmailLogo, cid: string, alt: string): string {
  // width/height als attribuut: Outlook negeert de CSS-maat van een afbeelding.
  return `<img src="cid:${cid}" width="${logo.width}" height="${logo.height}" alt="${escapeHtml(alt)}" style="display:block;width:${logo.width}px;height:${logo.height}px;border:0;outline:none;text-decoration:none;" />`;
}

interface SlotChoice { logo: EmailLogo; cid: string; html: (image: string) => string }

const SLOTS: Array<{ marker: string; pick: (brand: EmailBrand) => SlotChoice | null }> = [
  {
    // Bovenaan de donkere kaart.
    marker: EMAIL_LOGO_SLOT_DARK,
    pick: (brand) => {
      if (brand.logoOnDark) {
        return { logo: brand.logoOnDark, cid: CID_LOGO_ON_DARK, html: (image) => `<div style="margin:0 0 20px;">${image}</div>` };
      }
      if (brand.logo) {
        // De meeste logo's zijn donker op transparant en vallen weg op de
        // donkere kaart. Een wit plaatje leest altijd; met een lichte versie
        // (Huisstijl) hoeft het niet.
        return {
          logo: brand.logo,
          cid: CID_LOGO,
          html: (image) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:separate;"><tr><td style="background:#ffffff;border-radius:12px;padding:10px 14px;">${image}</td></tr></table>`,
        };
      }
      return null;
    },
  },
  {
    // Bovenaan een lichte kaart (de notulen van een afspraak).
    marker: EMAIL_LOGO_SLOT_LIGHT,
    pick: (brand) => brand.logo
      ? { logo: brand.logo, cid: CID_LOGO, html: (image) => `<div style="margin:0 0 20px;">${image}</div>` }
      : null,
  },
  {
    // Onder een lichte kaart (de vrije klantmail): als een handtekening.
    marker: EMAIL_LOGO_SLOT_SIGNATURE,
    pick: (brand) => brand.logo
      ? { logo: brand.logo, cid: CID_LOGO, html: (image) => `<div style="margin:16px 4px 0;">${image}</div>` }
      : null,
  },
];

const BRAND_NAME_LINE = new RegExp(`${escapeRegExp(EMAIL_BRAND_NAME_START)}[\\s\\S]*?${escapeRegExp(EMAIL_BRAND_NAME_END)}`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vult de plek voor het logo in en geeft de bijlage(n) terug die erbij horen.
 * Alleen het eerste merkteken telt: dat staat in het sjabloon vóór alles wat
 * een gebruiker schreef. Zonder logo verdwijnt het merkteken en blijft de naam.
 */
export function applyEmailBrand(html: string, brand: EmailBrand | null | undefined): { html: string; attachments: EmailInlineAttachment[] } {
  const attachments: EmailInlineAttachment[] = [];
  let out = html;
  let placed = false;
  for (const slot of SLOTS) {
    const at = out.indexOf(slot.marker);
    if (at < 0) continue;
    const choice = brand ? slot.pick(brand) : null;
    let block = '';
    if (choice && brand) {
      block = choice.html(logoImage(choice.logo, choice.cid, brand.name || 'Logo'));
      if (!attachments.some((attachment) => attachment.content_id === choice.cid)) {
        attachments.push({
          filename: choice.logo.contentType === 'image/png' ? 'logo.png' : 'logo.jpg',
          content: choice.logo.base64,
          content_type: choice.logo.contentType,
          content_id: choice.cid,
        });
      }
      placed = true;
    }
    out = out.slice(0, at) + block + out.slice(at + slot.marker.length);
  }
  // Staat het logo er, dan vervalt de bovenregel die alleen de naam is; zo
  // niet, dan blijft de naam staan en gaan alleen de merktekens eruit.
  if (placed) out = out.replace(BRAND_NAME_LINE, '');
  else out = out.replace(EMAIL_BRAND_NAME_START, '').replace(EMAIL_BRAND_NAME_END, '');
  return { html: out, attachments };
}

/**
 * Een Resend-payload met het logo erin: de HTML ingevuld en de afbeelding
 * achter de bijlagen die er al waren (de PDF, de UBL, de agenda-uitnodiging).
 * Zonder HTML of zonder logo verandert er niets aan de bijlagen.
 */
export function withEmailBrand<T extends Record<string, unknown>>(payload: T, brand: EmailBrand | null | undefined): T {
  if (typeof payload.html !== 'string') return payload;
  const { html, attachments } = applyEmailBrand(payload.html, brand);
  if (!attachments.length) return { ...payload, html };
  const existing = Array.isArray(payload.attachments) ? payload.attachments : [];
  return { ...payload, html, attachments: [...existing, ...attachments] };
}
