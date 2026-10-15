// Gedeelde helper: de huisstijl van een organisatie voor alles wat de klant
// ziet — het klantportaal, de galerij, en de publieke offerte-, factuur- en
// contractpagina's.
//
// Waarom gedeeld: dezelfde sanitizer stond eerst drie keer los in de edge
// functions, en elke nieuwe huisstijlkolom moest dan op drie plekken worden
// bijgeschreven. Eén bron, één kolomlijst.
//
// Gooit nooit. Zonder company_settings-rij, zonder rechten of met een migratie
// die nog niet is toegepast valt alles terug op de ResoFly-stijl; een pagina
// mag niet omvallen op een sierlaag.
//
// Alles wat hier naar buiten gaat is BEWUST een expliciete allowlist en nooit
// een spread van de rij: company_settings bevat ook het rauwe briefpapier,
// interne uurtarieven en fiscale instellingen.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export interface Branding {
  logoDataUrl: string | null;
  accentColor: string;
  footerText: string | null;
  hidePoweredBy: boolean;
  companyName: string | null;
  headingFont: string;
  bodyFont: string;
  galleryBg: string;
  /** Sfeer van de klantgerichte pagina's: 'dark' of 'light'. */
  clientTheme: 'dark' | 'light';
  /** Kleur van de kop (portaal, publieke pagina's); null = automatisch, afgeleid
   *  uit de merkkleur. Sinds migratie 20261015000000. */
  headerColor: string | null;
  /** Lichte versie van het logo voor op een donkere kop; null = het gewone logo
   *  (op een licht plaatje als het wegvalt). Sinds migratie 20261015000000. */
  logoDarkDataUrl: string | null;
}

/** De huisstijlkolommen, plus de twee naamvelden waar `companyName` uit komt. */
export const BRANDING_COLUMNS =
  'company_name,trade_name,brand_logo_data_url,brand_accent_color,brand_footer_text,' +
  'brand_hide_powered_by,brand_heading_font,brand_body_font,brand_gallery_bg,brand_client_theme,' +
  'brand_header_color,brand_logo_dark_data_url';

/**
 * De kolommen die de nieuwste huisstijlmigratie (20261015000000) toevoegt. Draait
 * een functie al terwijl `db push` nog moet, dan faalt een opvraag met deze
 * kolommen erin; vraag dan opnieuw zonder. De kop valt dan terug op automatisch
 * en het gewone logo, wat precies is wat de pagina vóór die migratie toonde.
 */
export const NEWEST_BRANDING_COLUMNS = ['brand_header_color', 'brand_logo_dark_data_url'];

/** Een kolomlijst zonder de kolommen van de nieuwste huisstijlmigratie. */
export function withoutNewestBrandingColumns(columns: string): string {
  return columns
    .split(',')
    .filter((column) => !NEWEST_BRANDING_COLUMNS.includes(column.trim()))
    .join(',');
}

export const DEFAULT_BRANDING: Branding = {
  logoDataUrl: null,
  accentColor: '#FFD966',
  footerText: null,
  hidePoweredBy: false,
  companyName: null,
  headingFont: 'system',
  bodyFont: 'system',
  galleryBg: '#0B0B0B',
  clientTheme: 'dark',
  headerColor: null,
  logoDarkDataUrl: null,
};

const HEX = /^#[0-9A-Fa-f]{6}$/;
/** Dezelfde eis als de CHECK op de logokolommen: alleen een ingesloten raster. */
const LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/**
 * Zet een company_settings-rij om in de huisstijl die naar de klant mag. De
 * lettertypen zijn SLEUTELS uit een vaste lijst in de frontend (nooit rauwe
 * CSS) en de sfeer is een van twee vaste waarden, dus er kan langs deze weg
 * geen willekeurige CSS de pagina in.
 */
export function sanitizeBranding(row: Record<string, unknown> | null | undefined): Branding {
  if (!row) return { ...DEFAULT_BRANDING };
  const accent = String(row.brand_accent_color ?? '');
  const galleryBg = String(row.brand_gallery_bg ?? '');
  const header = String(row.brand_header_color ?? '');
  const logoDark = typeof row.brand_logo_dark_data_url === 'string' ? row.brand_logo_dark_data_url : '';
  return {
    logoDataUrl: (row.brand_logo_data_url as string | null) ?? null,
    accentColor: HEX.test(accent) ? accent : DEFAULT_BRANDING.accentColor,
    footerText: (row.brand_footer_text as string | null) ?? null,
    hidePoweredBy: row.brand_hide_powered_by === true,
    companyName: (row.trade_name as string | null) || (row.company_name as string | null) || null,
    headingFont: String(row.brand_heading_font ?? 'system'),
    bodyFont: String(row.brand_body_font ?? 'system'),
    galleryBg: HEX.test(galleryBg) ? galleryBg : DEFAULT_BRANDING.galleryBg,
    clientTheme: row.brand_client_theme === 'light' ? 'light' : 'dark',
    headerColor: HEX.test(header) ? header.toUpperCase() : null,
    logoDarkDataUrl: LOGO.test(logoDark) ? logoDark : null,
  };
}

/**
 * Haalt de huisstijl van één organisatie op. Gebruik dit alleen waar de rij nog
 * niet in de hand is; heb je hem al (bijvoorbeeld voor de bedrijfsgegevens),
 * roep dan `sanitizeBranding(row)` aan en bespaar de query.
 */
export async function loadBranding(
  supabaseAdmin: SupabaseClient,
  organizationId: string,
): Promise<Branding> {
  try {
    const query = (columns: string) => supabaseAdmin
      .from('company_settings')
      .select(columns)
      .eq('organization_id', organizationId)
      .maybeSingle();
    let { data, error } = await query(BRANDING_COLUMNS);
    if (error) {
      // Eerst opnieuw zonder de kolommen van de nieuwste migratie: dan klopt de
      // rest van de huisstijl alvast wel.
      ({ data, error } = await query(withoutNewestBrandingColumns(BRANDING_COLUMNS)));
    }
    if (error) {
      // Meestal: de migratie met een nieuwe huisstijlkolom is nog niet
      // toegepast, waardoor de hele select faalt. Dan liever de ResoFly-stijl
      // dan een pagina zonder inhoud.
      console.warn('branding lookup mislukt', error.message);
      return { ...DEFAULT_BRANDING };
    }
    return sanitizeBranding(data as Record<string, unknown> | null);
  } catch (error) {
    console.warn('branding lookup crashte', error instanceof Error ? error.message : error);
    return { ...DEFAULT_BRANDING };
  }
}
