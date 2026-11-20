/**
 * Het volgende interne nummer en de totalen van een inkoopfactuur.
 *
 * Stond tot november 2026 in features/Bookkeeping.tsx. main.tsx (een bon
 * omzetten in een inkoopfactuur) en de handelingen van Gerrie
 * (lib/actions/bookkeeping.ts) importeerden het daarvandaan, en trokken zo de
 * hele boekhoudpagina in de bundel die bij elke start laadt.
 */
import type { AppData, UUID, VatCode } from '../types';
import { purchaseLineTotals, purchaseTotalsOptions, type PurchaseLine, type PurchaseTotals } from './purchaseInvoice';

export function nextPurchaseNumber(data: AppData, date = new Date()): string {
  const prefix = `INK-${date.getFullYear()}-`;
  const max = data.purchaseInvoices
    .map(p => p.internal_number || '')
    .filter(n => n.startsWith(prefix))
    .reduce((m, n) => Math.max(m, parseInt(n.slice(prefix.length), 10) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/** Header-totalen: BTW per (kostenrekening, btw-code, tarief)-groep afgerond, dan
 *  gesommeerd — identiek aan book_purchase_invoice (dat per zo'n groep boekt met
 *  round(Σbase * tarief/100)). Zo sluiten de opgeslagen totalen cent-exact aan op
 *  de crediteurenregel (1600) van de grootboekboeking, ook als twee regels met
 *  hetzelfde tarief op verschillende kostenrekeningen staan.
 *  fallbackAccountId spiegelt de server-coalesce van een lege rekening → 4500,
 *  zodat een blanco regel en een expliciete 4500-regel in dezelfde groep vallen.
 *
 *  Met `context` (de btw-codes en de KOR) telt verlegde btw niet bij het totaal
 *  en geldt het btw-bedrag van de leverancier op de regel; het rekenwerk staat
 *  in lib/purchaseInvoice.ts. Zonder `context` telt alle btw mee, zoals vóór
 *  20261119: een aanroeper die de btw-codes kent, geeft ze mee. */
export function purchaseTotals(
  lines: PurchaseLine[],
  fallbackAccountId: UUID | null = null,
  context?: { vatCodes: Array<Pick<VatCode, 'code' | 'kind'>>; kor?: boolean | null },
): PurchaseTotals {
  return purchaseLineTotals(lines, context
    ? purchaseTotalsOptions(context.vatCodes, { kor: context.kor, fallbackAccountId })
    : { fallbackAccountId });
}
