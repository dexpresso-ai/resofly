// ============================================================
// De eigen Mollie-key van een organisatie ophalen, voor de betaallink, de
// webhook, terugbetalingen en e-facturen via Mollie. Eén plek voor
// invoice-workflow en invoiceCheckout.ts (portaal en publieke factuurpagina),
// zodat ze alle drie hetzelfde doen, ook met het herstel hieronder.
//
// Draait met de service-role: filter altijd op organization_id (CLAUDE.md,
// regel 1). De ontsleutelde key gaat nooit terug naar de browser of in een log.
// ============================================================

import { decryptSecretWithInfo, encryptionKeyConfigured, encryptSecret, type MollieKeyMode } from './mollieSecrets.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAdmin = any;

export type InvoiceMollieKey = { apiKey: string; mode: MollieKeyMode | null };

/**
 * `connected` zegt of er een key hoort te zijn. Zonder key en zonder koppeling is
 * er niets mis; zonder key mét koppeling (database, ontsleutelen) wel: dan staat
 * de reden in `reason`, voor het logboek.
 */
export type InvoiceMollieKeyLookup =
  | { key: InvoiceMollieKey; connected: true; reason: null }
  | { key: null; connected: boolean; reason: string };

export async function loadInvoiceMollieKey(supabaseAdmin: SupabaseAdmin, organizationId: string): Promise<InvoiceMollieKeyLookup> {
  const { data, error } = await supabaseAdmin
    .from('organization_invoice_mollie_settings')
    .select('status,api_key_encrypted,mode')
    .eq('organization_id', organizationId)
    .maybeSingle();
  // Bij een storing weten we het niet: tel het als gekoppeld, zodat de aanroeper
  // het als fout behandelt (de webhook geeft dan 503 en Mollie probeert opnieuw).
  if (error) return { key: null, connected: true, reason: `instellingen niet te laden: ${errorText(error)}` };
  const row = (data ?? null) as { status?: string; api_key_encrypted?: string | null; mode?: MollieKeyMode | null } | null;
  if (!row || row.status !== 'connected' || !row.api_key_encrypted) {
    return { key: null, connected: false, reason: 'geen gekoppelde Mollie-sleutel (meer)' };
  }
  let decrypted: { plain: string; legacyKey: boolean };
  try {
    decrypted = await decryptSecretWithInfo(row.api_key_encrypted);
  } catch (decryptError) {
    return { key: null, connected: true, reason: `ontsleutelen mislukt: ${errorText(decryptError)}` };
  }
  if (!decrypted.plain) return { key: null, connected: true, reason: 'sleutel leeg na ontsleutelen' };
  if (decrypted.legacyKey) await reencryptLegacyKey(supabaseAdmin, organizationId, row.api_key_encrypted, decrypted.plain);
  return { key: { apiKey: decrypted.plain, mode: row.mode ?? null }, connected: true, reason: null };
}

/**
 * Een key die alleen met de oude ingebouwde sleutel te ontsleutelen was, stond in
 * feite leesbaar in de database: die sleutel staat in de code. Dat kan alleen
 * met MOLLIE_ALLOW_MOCK aan, dus op staging, waar MOLLIE_TOKEN_ENCRYPTION_KEY
 * ontbrak (gezien op 6 november 2026). Is de echte sleutel er nu, dan slaan we de
 * key meteen opnieuw op, zonder dat iemand hem opnieuw hoeft in te voeren.
 *
 * Alleen als de rij nog precies de oude waarde heeft: koppelt een beheerder op
 * hetzelfde moment een andere key, dan blijft die staan. Een fout hier is geen
 * reden om de betaling te laten mislukken; de volgende keer volgt een nieuwe poging.
 */
async function reencryptLegacyKey(supabaseAdmin: SupabaseAdmin, organizationId: string, oldCipher: string, plain: string): Promise<void> {
  if (!encryptionKeyConfigured()) return;
  try {
    const fresh = await encryptSecret(plain);
    const { error } = await supabaseAdmin
      .from('organization_invoice_mollie_settings')
      .update({ api_key_encrypted: fresh })
      .eq('organization_id', organizationId)
      .eq('api_key_encrypted', oldCipher);
    if (error) console.warn('Mollie-sleutel opnieuw versleutelen mislukte', { organizationId, error: errorText(error) });
    else console.info('Mollie-sleutel opnieuw versleuteld met MOLLIE_TOKEN_ENCRYPTION_KEY', { organizationId });
  } catch (reencryptError) {
    console.warn('Mollie-sleutel opnieuw versleutelen mislukte', { organizationId, error: errorText(reencryptError) });
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message?: unknown }).message ?? '');
  return String(error);
}
