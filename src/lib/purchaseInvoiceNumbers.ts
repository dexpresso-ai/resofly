/**
 * Het volgende interne nummer en de totalen van een inkoopfactuur.
 *
 * Stond tot november 2026 in features/Bookkeeping.tsx. main.tsx (een bon
 * omzetten in een inkoopfactuur) en de handelingen van Gerrie
 * (lib/actions/bookkeeping.ts) importeerden het daarvandaan, en trokken zo de
 * hele boekhoudpagina in de bundel die bij elke start laadt.
 */
import type { AppData, PurchaseInvoiceLine, UUID } from '../types';

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
 *  zodat een blanco regel en een expliciete 4500-regel in dezelfde groep vallen. */
export function purchaseTotals(lines: PurchaseInvoiceLine[], fallbackAccountId: UUID | null = null) {
  const groups = new Map<string, { base: number; rate: number }>();
  let subtotal = 0;
  for (const l of lines) {
    const base = Number(l.amount_cents) || 0;
    subtotal += base;
    const rate = l.vat_rate || 0;
    // Groepeer zoals de backend: op (account_id, vat_code, tarief). Een lege
    // rekening valt (net als server-side coalesce) op de vangnetrekening 4500.
    const account = l.account_id || fallbackAccountId || '';
    const key = `${account}|${(l.vat_code ?? '').trim()}|${rate}`;
    const g = groups.get(key);
    if (g) g.base += base;
    else groups.set(key, { base, rate });
  }
  let vat = 0;
  groups.forEach(g => { vat += Math.round((g.base * g.rate) / 100); });
  return { subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
}
