/**
 * Een gedeeltelijke terugbetaling verdelen over de btw-groepen van de factuur.
 *
 * Een creditnota hoort de factuur te volgen: per btw-tarief en per btw-code
 * (binnenland hoog/laag, ICP, export, verlegd) een eigen regel. Eén regel met
 * een "gemengd" tarief (bijv. 15% bij € 1.000 hoog + € 1.000 laag) bestaat
 * fiscaal niet: hij kwam dan geheel in één rubriek terecht en de ICP-opgaaf
 * werd niet gecorrigeerd.
 *
 * Puur rekenwerk in hele centen: geen database, geen Deno. Zo te testen met
 * `node --test` (creditNoteSplit.test.ts).
 */

export interface SplitLineInput {
  quantity: number;
  unit_price: number;
  vat?: number | null;
  vat_code?: string | null;
}

export interface VatGroup {
  rate: number;
  vatCode: string | null;
  baseCents: number;
  vatCents: number;
  grossCents: number;
}

/** Btw-groepen van een factuur: per (code, tarief) de grondslag en de btw, per groep afgerond. */
export function invoiceVatGroups(lines: SplitLineInput[]): VatGroup[] {
  const groups = new Map<string, VatGroup>();
  for (const line of lines ?? []) {
    const rate = Number(line.vat) || 0;
    const vatCode = String(line.vat_code ?? '').trim() || null;
    const key = `${vatCode ?? ''}|${rate}`;
    const base = Math.round((Number(line.quantity) || 0) * (Number(line.unit_price) || 0) * 100);
    const group = groups.get(key) ?? { rate, vatCode, baseCents: 0, vatCents: 0, grossCents: 0 };
    group.baseCents += base;
    groups.set(key, group);
  }
  const result: VatGroup[] = [];
  for (const group of groups.values()) {
    group.vatCents = Math.round((group.baseCents * group.rate) / 100);
    group.grossCents = group.baseCents + group.vatCents;
    if (group.grossCents !== 0) result.push(group);
  }
  return result;
}

/**
 * Verdeelt een bruto terugbetaalbedrag (centen) naar rato van het bruto bedrag
 * per btw-groep. De delen tellen exact op tot het bedrag (grootste-rest-methode)
 * en worden per groep teruggerekend naar grondslag + btw, zodat
 * grondslag + btw = het deel. Groepen met een negatief bruto bedrag (korting)
 * tellen niet mee in de verdeling.
 */
export function splitRefundOverVatGroups(lines: SplitLineInput[], amountCents: number): VatGroup[] {
  const amount = Math.round(Number(amountCents) || 0);
  const groups = invoiceVatGroups(lines).filter((group) => group.grossCents > 0);
  const total = groups.reduce((sum, group) => sum + group.grossCents, 0);
  if (amount <= 0 || total <= 0) return [];

  const exact = groups.map((group) => (amount * group.grossCents) / total);
  const shares = exact.map((value) => Math.floor(value));
  let rest = amount - shares.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; rest > 0 && order.length > 0; i += 1, rest -= 1) {
    shares[order[i % order.length].index] += 1;
  }

  return groups
    .map((group, index) => {
      const gross = shares[index];
      const base = Math.round(gross / (1 + group.rate / 100));
      return { rate: group.rate, vatCode: group.vatCode, baseCents: base, vatCents: gross - base, grossCents: gross };
    })
    .filter((part) => part.grossCents > 0);
}
