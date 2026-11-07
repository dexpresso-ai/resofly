// ============================================================
// Facturen versturen: per e-mail of via Mollie — de keuze van de organisatie.
//
// Instellingen → Online betalen zet company_settings.invoice_send_method op
// 'email' of 'mollie' (null = nog niet gekozen). Bij 'email' maakt ResoFly
// nergens een betaallink van Mollie (versturen, herinnering, aanmaning,
// klantportaal) en geeft Mollie geen e-factuur uit; zie mollieInvoicingAllowed
// in eInvoicing.ts.
//
// Eén plek die de keuze leest, voor invoice-workflow, het klantportaal
// (invoiceCheckout.ts) en Gerrie. Altijd per organisatie: de aanroeper geeft
// het organization_id uit de geverifieerde sessie of de factuur zelf.
// ============================================================

import { mollieInvoicingAllowed, storedInvoiceSendMethod, type InvoiceSendMethod } from './eInvoicing.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAdmin = any;

/** De kolom bestaat (nog) niet: een database van vóór 20261107100000. */
function missingSendMethodColumn(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42703') return true;
  const message = String(error.message ?? '');
  return message.includes('invoice_send_method') && /does not exist|schema cache/i.test(message);
}

/**
 * De opgeslagen keuze van deze organisatie, of null (nog niets gekozen, geen
 * rij, of een database zonder de kolom: dan zoals het was). Een andere fout
 * gooit hij door: de aanroeper beslist of hij dan stopt of de veilige kant kiest.
 */
export async function loadInvoiceSendMethod(supabaseAdmin: SupabaseAdmin, organizationId: string): Promise<InvoiceSendMethod | null> {
  const { data, error } = await supabaseAdmin
    .from('company_settings')
    .select('invoice_send_method')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    if (missingSendMethodColumn(error)) return null;
    throw new Error(`De verzendwijze van de organisatie kon niet worden gelezen: ${String(error.message ?? error)}`);
  }
  return storedInvoiceSendMethod((data as { invoice_send_method?: unknown } | null)?.invoice_send_method ?? null);
}

/** Mag Mollie meedoen bij de facturen van deze organisatie? Nee als ze "per e-mail" koos. */
export async function loadMollieInvoicingAllowed(supabaseAdmin: SupabaseAdmin, organizationId: string): Promise<boolean> {
  return mollieInvoicingAllowed(await loadInvoiceSendMethod(supabaseAdmin, organizationId));
}

/** Waarom er geen betaallink van Mollie komt: de organisatie verstuurt per e-mail. */
export const SEND_METHOD_EMAIL_NO_PAYMENT_LINK =
  'Je verstuurt facturen per e-mail (Instellingen → Online betalen). ResoFly maakt dan geen betaallink van Mollie; je klant betaalt per overboeking.';
