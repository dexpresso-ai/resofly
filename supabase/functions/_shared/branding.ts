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
}

/** De huisstijlkolommen, plus de twee naamvelden waar `companyName` uit komt. */
export const BRANDING_COLUMNS =
  'company_name,trade_name,brand_logo_data_url,brand_accent_color,brand_footer_text,' +
  'brand_hide_powered_by,brand_heading_font,brand_body_font,brand_gallery_bg,brand_client_theme';

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
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

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
    const { data, error } = await supabaseAdmin
      .from('company_settings')
      .select(BRANDING_COLUMNS)
      .eq('organization_id', organizationId)
      .maybeSingle();
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
