/**
 * Verplichte btw-vermeldingen op een factuur (art. 35a Wet OB 1968).
 *
 * Bij 0% of geen btw moet de factuur zeggen waaróm: "btw verlegd" bij een
 * verleggingsregeling, "intracommunautaire levering" bij een ICP-levering, een
 * verwijzing naar de vrijstelling. Bij verlegging en ICP hoort ook het
 * btw-identificatienummer van de afnemer op de factuur. Zonder die vermelding is
 * de factuur onvolledig en staat het 0%-tarief bij een controle ter discussie.
 *
 * Kopie van supabase/functions/_shared/invoiceVatNotes.ts voor de pdf-export in
 * de app; src/lib/invoiceVatNotes.test.ts houdt de twee gelijk.
 */

export interface VatCodeInfo {
  kind: string;
  salesBox?: string | null;
}

export interface InvoiceVatNotes {
  /** Regels voor onder de totalen. */
  notes: string[];
  /** Verlegd of ICP: het btw-nummer van de afnemer moet op de factuur. */
  needsCustomerVatNumber: boolean;
  /** Korte omschrijving voor een foutmelding als dat nummer ontbreekt. */
  reasons: string[];
}

export function invoiceVatNotes(
  lines: Array<{ vat_code?: string | null }>,
  codes: Record<string, VatCodeInfo>,
): InvoiceVatNotes {
  const kinds = new Set<string>();
  let export3a = false;
  for (const line of lines ?? []) {
    const code = String(line.vat_code ?? '').trim();
    const info = code ? codes[code] : undefined;
    if (!info) continue;
    kinds.add(info.kind);
    if (info.kind === 'zero' && info.salesBox === '3a') export3a = true;
  }

  const notes: string[] = [];
  const reasons: string[] = [];
  if (kinds.has('reverse_charge_sales')) {
    notes.push('Btw verlegd (art. 12 lid 2 en 3 Wet OB 1968): de afnemer draagt de btw af.');
    reasons.push('btw verlegd');
  }
  if (kinds.has('icp_goods')) {
    notes.push('Intracommunautaire levering, 0% (art. 9 lid 2 onder b Wet OB 1968).');
    reasons.push('een intracommunautaire levering');
  }
  if (kinds.has('icp_services')) {
    notes.push('Btw verlegd: dienst aan een ondernemer in een andere EU-lidstaat (art. 44 en 196 Btw-richtlijn).');
    reasons.push('een verlegde dienst binnen de EU');
  }
  if (export3a) {
    notes.push('Uitvoer naar een land buiten de EU, 0% (art. 9 lid 2 onder b Wet OB 1968).');
  }
  if (kinds.has('exempt')) {
    notes.push('Vrijgesteld van btw (art. 11 Wet OB 1968).');
  }
  if (kinds.has('kor')) {
    notes.push('Vrijgesteld van btw: kleineondernemersregeling (art. 25 Wet OB 1968).');
  }
  return { notes, needsCustomerVatNumber: reasons.length > 0, reasons };
}
