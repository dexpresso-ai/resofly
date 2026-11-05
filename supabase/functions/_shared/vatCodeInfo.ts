// Soort en rubriek per btw-code van één organisatie: wat invoiceVatNotes.ts
// nodig heeft voor de verplichte btw-vermeldingen op de factuur-, creditfactuur-
// en offerte-PDF. Stond eerst letterlijk in invoice-workflow én quote-workflow.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import type { VatCodeInfo } from './invoiceVatNotes.ts';

/**
 * Gefilterd op `organizationId`: de service-role ziet alles. Bewust ook de
 * codes die inmiddels uit staan: een oudere factuur noemt ze nog, en de
 * vermelding hoort er dan bij. Een fout is niet fataal (de PDF komt er, zonder
 * vermeldingen); wel een waarschuwing in het log.
 */
export async function loadVatCodeInfo(supabaseAdmin: SupabaseClient, organizationId: string): Promise<Record<string, VatCodeInfo>> {
  const { data, error } = await supabaseAdmin
    .from('vat_codes')
    .select('code,kind,sales_box')
    .eq('organization_id', organizationId);
  if (error) {
    console.warn('vat_codes lookup voor de pdf mislukte:', error.message);
    return {};
  }
  const byCode: Record<string, VatCodeInfo> = {};
  for (const row of (data ?? []) as Array<{ code: string; kind: string; sales_box: string | null }>) {
    byCode[String(row.code)] = { kind: String(row.kind), salesBox: row.sales_box ?? null };
  }
  return byCode;
}
