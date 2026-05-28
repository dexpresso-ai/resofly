// Centrale, autoritatieve geldrekenmodule voor offertes en facturen.
//
// Waarom dit bestaat:
//   JavaScript-floats kunnen geldbedragen niet exact representeren
//   (0.1 + 0.2 === 0.30000000000000004). Voor een facturatiesysteem is dat
//   onacceptabel: bedragen die naar Mollie gaan, in de PDF staan en in de
//   database belanden moeten cent-exact en onderling consistent zijn.
//
// Aanpak:
//   - Alle tussenstappen rekenen in HELE CENTEN (integers) met bankers' rounding
//     vermeden ten faveure van "round half away from zero" (NL-conventie voor btw).
//   - Btw wordt PER TARIEF berekend en afgerond (wettelijk vereist op NL-facturen),
//     en daarna gesommeerd. Hierdoor sluit subtotaal + btw exact aan op het totaal.
//   - Eén bron van waarheid: zowel de UI, de PDF als de betaal-edge-function
//     horen via deze module te rekenen zodat er nooit centverschillen ontstaan.

export interface MoneyLineInput {
  quantity: number | string | null | undefined;
  unit_price: number | string | null | undefined;
  vat: number | string | null | undefined;
}

export interface VatBreakdownRow {
  /** Btw-percentage, bijv. 21, 9 of 0. */
  rate: number;
  /** Grondslag (netto) waarover dit tarief is berekend, in euro's. */
  base: number;
  /** Btw-bedrag voor dit tarief, in euro's (al afgerond op centen). */
  vat: number;
}

export interface MoneyTotals {
  /** Netto subtotaal exclusief btw, in euro's (cent-exact). */
  subtotal: number;
  /** Totaal btw over alle tarieven, in euro's (cent-exact). */
  vat: number;
  /** Eindtotaal inclusief btw, in euro's (cent-exact). */
  total: number;
  /** Per-tarief uitsplitsing, oplopend gesorteerd op percentage. */
  vatBreakdown: VatBreakdownRow[];
  /** Eindtotaal in hele centen — gebruik dit voor betaalproviders (Mollie). */
  totalCents: number;
}

/** Veilige numerieke parse: lege/ongeldige waarden worden 0, geen NaN-besmetting. */
export function toNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const parsed = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reken een euro-bedrag om naar hele centen met "round half away from zero".
 * We schalen eerst weg van de float-onnauwkeurigheid (1e-6) voordat we afronden,
 * zodat 90.5685 niet per ongeluk als 90.56 maar correct als 90.57 eindigt.
 */
export function toCents(euros: number): number {
  if (!Number.isFinite(euros)) return 0;
  const scaled = euros * 100;
  const rounded = scaled >= 0
    ? Math.round(scaled + 1e-6)
    : -Math.round(Math.abs(scaled) + 1e-6);
  return rounded;
}

/** Centen terug naar euro's (altijd exact op 2 decimalen). */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Bereken alle bedragen voor een set regels, cent-exact en met per-tarief btw.
 *
 * Garanties:
 *   - subtotal + vat === total (geen centverschil tussen footer-regels)
 *   - totalCents is direct bruikbaar voor Mollie (geen Math.round op een float meer)
 *   - btw is per tarief afgerond conform NL-facturatie-eisen
 */
export function computeTotals(lines: MoneyLineInput[] = []): MoneyTotals {
  // Stap 1: netto per regel in centen, gegroepeerd per btw-tarief.
  const baseCentsByRate = new Map<number, number>();
  let subtotalCents = 0;

  for (const line of lines) {
    const qty = toNumber(line.quantity);
    const price = toNumber(line.unit_price);
    const rate = toNumber(line.vat);
    const lineNetCents = toCents(qty * price);
    subtotalCents += lineNetCents;
    baseCentsByRate.set(rate, (baseCentsByRate.get(rate) ?? 0) + lineNetCents);
  }

  // Stap 2: btw per tarief afronden (wettelijk: afronden gebeurt per tarief, niet per regel).
  const vatBreakdown: VatBreakdownRow[] = [];
  let vatCents = 0;
  for (const [rate, baseCents] of [...baseCentsByRate.entries()].sort((a, b) => a[0] - b[0])) {
    const rateVatCents = toCents((baseCents / 100) * (rate / 100));
    vatCents += rateVatCents;
    vatBreakdown.push({ rate, base: fromCents(baseCents), vat: fromCents(rateVatCents) });
  }

  const totalCents = subtotalCents + vatCents;

  return {
    subtotal: fromCents(subtotalCents),
    vat: fromCents(vatCents),
    total: fromCents(totalCents),
    vatBreakdown,
    totalCents,
  };
}

/** Bruto regeltotaal (incl. btw) in euro's, cent-exact — voor weergave per regel. */
export function lineGross(line: MoneyLineInput): number {
  const net = toCents(toNumber(line.quantity) * toNumber(line.unit_price));
  const vat = toCents((net / 100) * (toNumber(line.vat) / 100));
  return fromCents(net + vat);
}

/** Netto regeltotaal (excl. btw) in euro's, cent-exact. */
export function lineNet(line: MoneyLineInput): number {
  return fromCents(toCents(toNumber(line.quantity) * toNumber(line.unit_price)));
}
