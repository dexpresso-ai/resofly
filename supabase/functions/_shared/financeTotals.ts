/**
 * Bedragen van een offerte of factuur, in hele centen en met btw per tarief.
 *
 * Waarom dit bestaat: de offerte-PDF rekende met kommagetallen en btw per
 * regel, zonder afronding. De app, de publieke pagina, de factuur, Mollie en
 * het grootboek ronden de regel af op centen en de btw per tarief. Bij twee
 * tarieven scheelde dat een cent: de klant kreeg een offerte-PDF van
 * € 173,62 (€ 102,50 tegen 21% en € 45,50 tegen 9%) en daarna een factuur van
 * € 173,63.
 *
 * Kopie van src/lib/money.ts (computeTotals) voor de edge functions; die kunnen
 * niet uit src/ importeren. financeTotals.test.ts houdt de twee gelijk.
 *
 * Puur: geen database, geen Deno.
 */

export interface FinanceTotalsLine {
  quantity?: number | string | null;
  unit_price?: number | string | null;
  vat?: number | string | null;
}

export interface FinanceVatRow {
  /** Btw-percentage, bijv. 21, 9 of 0. */
  rate: number;
  /** Grondslag in euro's. */
  base: number;
  /** Btw over die grondslag in euro's, afgerond op centen. */
  vat: number;
}

export interface FinanceTotals {
  subtotal: number;
  vat: number;
  total: number;
  totalCents: number;
  vatBreakdown: FinanceVatRow[];
}

/** Lege of onleesbare waarde telt als 0, net als in de app (toNumber). */
export function financeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Euro's naar hele centen, half van nul af (zoals round() in Postgres). */
export function financeCents(euros: number): number {
  if (!Number.isFinite(euros)) return 0;
  const scaled = euros * 100;
  return scaled >= 0 ? Math.round(scaled + 1e-6) : -Math.round(Math.abs(scaled) + 1e-6);
}

export function financeTotals(lines: ReadonlyArray<FinanceTotalsLine> = []): FinanceTotals {
  const baseCentsByRate = new Map<number, number>();
  let subtotalCents = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const netCents = financeCents(financeNumber(line?.quantity) * financeNumber(line?.unit_price));
    subtotalCents += netCents;
    const rate = financeNumber(line?.vat);
    baseCentsByRate.set(rate, (baseCentsByRate.get(rate) ?? 0) + netCents);
  }
  let vatCents = 0;
  const vatBreakdown: FinanceVatRow[] = [];
  for (const [rate, baseCents] of [...baseCentsByRate.entries()].sort((a, b) => a[0] - b[0])) {
    const rateVatCents = financeCents((baseCents / 100) * (rate / 100));
    vatCents += rateVatCents;
    vatBreakdown.push({ rate, base: Math.round(baseCents) / 100, vat: Math.round(rateVatCents) / 100 });
  }
  const totalCents = subtotalCents + vatCents;
  return {
    subtotal: Math.round(subtotalCents) / 100,
    vat: Math.round(vatCents) / 100,
    total: Math.round(totalCents) / 100,
    totalCents,
    vatBreakdown,
  };
}

/** Regeltotaal inclusief btw, zoals de app het per regel toont (lineGross). */
export function financeLineGross(line: FinanceTotalsLine): number {
  const netCents = financeCents(financeNumber(line?.quantity) * financeNumber(line?.unit_price));
  const vatCents = financeCents((netCents / 100) * (financeNumber(line?.vat) / 100));
  return Math.round(netCents + vatCents) / 100;
}
