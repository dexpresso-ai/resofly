// ResoFly — debiteurenautomaat: rekenhart voor het Nederlandse incassorecht.
//
// Twee wettelijke berekeningen, bewust als PURE functies (geen Deno/DB-afhankelijk-
// heden) zodat ze los te unit-testen zijn en zowel in de Edge Function als in een
// node/deno-testharnas draaien:
//
//   1. Buitengerechtelijke incassokosten volgens het "Besluit vergoeding voor
//      buitengerechtelijke incassokosten" (WIK-staffel). Een degressieve staffel
//      over de openstaande hoofdsom (incl. btw), met wettelijk minimum €40 en
//      maximum €6.775.
//   2. Wettelijke rente. Twee smaken: de gewone wettelijke rente (consumenten,
//      art. 6:119 BW) en de wettelijke handelsrente (B2B, art. 6:119a BW). Beide
//      wijzigen periodiek; we rekenen daarom PERIODE-ACCURAAT over een lijst
//      rentetarief-periodes (rate periods), zodat een factuur die over een
//      tariefwijziging heen loopt correct wordt berekend.
//
// Alle bedragen zijn in HELE CENTEN (integer). Rentetarieven in basispunten
// (1% = 100 bp) zodat er geen floating-point in de opslag zit.
//
// LET OP — juridische nuances die bewust in v1 zijn vereenvoudigd (zie roadmap):
//   * Rente wordt hier als ENKELVOUDIGE rente over de periode gesommeerd. Art.
//     6:119 lid 2 BW schrijft jaarlijkse bijschrijving (rente-op-rente) voor; voor
//     de gebruikelijke looptijd < 1 jaar is enkelvoudig exact. Compounding > 1 jaar
//     is een v2-verfijning.
//   * Btw over incassokosten wordt hier NIET meegerekend (calculateWikCollectionCostsCents
//     geeft het kale bedrag). Een btw-plichtige schuldeiser die de voorbelasting kan
//     verrekenen brengt normaliter geen btw over incassokosten in rekening; de
//     Edge Function beslist op basis van een org-instelling of er btw bij komt.

export type InterestKind = 'consumer' | 'commercial';

// Eén rentetarief-periode. `rateBasisPoints` geldt vanaf `validFrom` (ISO 'YYYY-MM-DD',
// inclusief) tot de `validFrom` van de eerstvolgende periode van dezelfde `kind`.
export interface RatePeriod {
  kind: InterestKind;
  rateBasisPoints: number; // 800 = 8,00%
  validFrom: string; // 'YYYY-MM-DD'
}

export interface InterestSegment {
  from: string; // 'YYYY-MM-DD' (eerste rentedag in dit segment)
  to: string; // 'YYYY-MM-DD' (laatste rentedag in dit segment)
  days: number;
  rateBasisPoints: number;
  interestCents: number; // afgerond, voor weergave
}

export interface InterestResult {
  interestCents: number; // totaal, afgerond op hele centen
  days: number; // totaal aantal rentedagen
  dailyRateCentsAtEnd: number; // rente per dag op het eindtarief (voor "loopt op met €x/dag")
  segments: InterestSegment[];
}

export interface DunningClaim {
  principalCents: number; // openstaande hoofdsom (incl. btw)
  interestCents: number; // wettelijke (handels)rente
  interest: InterestResult;
  collectionCostsCents: number; // WIK-incassokosten (kaal)
  collectionCostsVatCents: number; // btw over incassokosten (0 tenzij ingeschakeld)
  totalClaimCents: number; // principal + interest + costs + costsVat
  interestKind: InterestKind;
  calculationDate: string;
  dueDate: string;
}

// ---------------------------------------------------------------------------
// Datum-helpers — werken puur op 'YYYY-MM-DD' in UTC-dagen, dus tijdzone-vrij.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Dag-index (aantal hele dagen sinds epoch). Gooit bij een ongeldige datum.
function dayIndex(isoDate: string): number {
  if (!isIsoDate(isoDate)) throw new Error(`Ongeldige datum (verwacht YYYY-MM-DD): ${isoDate}`);
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Ongeldige datum: ${isoDate}`);
  return Math.round(ms / MS_PER_DAY);
}

function isoFromDayIndex(index: number): string {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return dayIndex(toIso) - dayIndex(fromIso);
}

// ---------------------------------------------------------------------------
// 1. WIK-incassokosten-staffel
// ---------------------------------------------------------------------------

const WIK_MIN_CENTS = 4_000; // €40
const WIK_MAX_CENTS = 677_500; // €6.775

// Degressieve staffel — grenzen in centen, tarief als fractie.
const WIK_BRACKETS: Array<{ upToCents: number; rate: number }> = [
  { upToCents: 250_000, rate: 0.15 }, // 15% over de eerste €2.500
  { upToCents: 500_000, rate: 0.10 }, // 10% over de volgende €2.500 (€2.500–€5.000)
  { upToCents: 1_000_000, rate: 0.05 }, // 5% over de volgende €5.000 (€5.000–€10.000)
  { upToCents: 20_000_000, rate: 0.01 }, // 1% over de volgende €190.000 (€10.000–€200.000)
  { upToCents: Number.POSITIVE_INFINITY, rate: 0.005 }, // 0,5% over het meerdere boven €200.000
];

// Buitengerechtelijke incassokosten over de openstaande hoofdsom (incl. btw).
// Retourneert het KALE kostenbedrag in centen (min €40, max €6.775). Bij een
// niet-positieve hoofdsom is er niets te vorderen → 0.
export function calculateWikCollectionCostsCents(principalCents: number): number {
  if (!Number.isFinite(principalCents) || principalCents <= 0) return 0;
  let previousCents = 0;
  let costs = 0;
  for (const bracket of WIK_BRACKETS) {
    if (principalCents <= previousCents) break;
    const sliceCents = Math.min(principalCents, bracket.upToCents) - previousCents;
    costs += sliceCents * bracket.rate;
    previousCents = bracket.upToCents;
  }
  const rounded = Math.round(costs);
  return Math.min(Math.max(rounded, WIK_MIN_CENTS), WIK_MAX_CENTS);
}

// ---------------------------------------------------------------------------
// 2. Wettelijke (handels)rente — periode-accuraat
// ---------------------------------------------------------------------------

// Sorteer de tarieven van één soort oplopend op validFrom en dedupliceer op datum
// (laatste wint), zodat we een schone tijdlijn hebben om overheen te lopen.
function timelineFor(kind: InterestKind, ratePeriods: RatePeriod[]): Array<{ fromDay: number; rateBasisPoints: number }> {
  const own = ratePeriods
    .filter((p) => p.kind === kind && isIsoDate(p.validFrom) && Number.isFinite(p.rateBasisPoints))
    .map((p) => ({ fromDay: dayIndex(p.validFrom), rateBasisPoints: Math.max(0, Math.round(p.rateBasisPoints)) }))
    .sort((a, b) => a.fromDay - b.fromDay);
  const deduped: Array<{ fromDay: number; rateBasisPoints: number }> = [];
  for (const period of own) {
    const last = deduped[deduped.length - 1];
    if (last && last.fromDay === period.fromDay) deduped[deduped.length - 1] = period;
    else deduped.push(period);
  }
  return deduped;
}

// Wettelijke rente over [dueDate → calculationDate]. De rente loopt vanaf de dag
// NÁ de vervaldatum (de vervaldatum zelf is nog op tijd), dus het aantal rentedagen
// = daysBetween(dueDate, calculationDate). Enkelvoudige rente, actual/365, per
// tariefsegment. Geeft 0 als de rekendatum niet ná de vervaldatum ligt of als er
// geen tarief van kracht is.
export function calculateStatutoryInterestCents(input: {
  principalCents: number;
  dueDate: string;
  calculationDate: string;
  kind: InterestKind;
  ratePeriods: RatePeriod[];
}): InterestResult {
  const empty: InterestResult = { interestCents: 0, days: 0, dailyRateCentsAtEnd: 0, segments: [] };
  const { principalCents, dueDate, calculationDate, kind, ratePeriods } = input;
  if (!Number.isFinite(principalCents) || principalCents <= 0) return empty;

  const startDay = dayIndex(dueDate); // laatste "op tijd"-dag
  const endDay = dayIndex(calculationDate);
  if (endDay <= startDay) return empty;

  const timeline = timelineFor(kind, ratePeriods);
  if (timeline.length === 0) return empty;

  // Rentedagen zijn de dag-indices d in [startDay+1 .. endDay] (inclusief).
  const firstAccrualDay = startDay + 1;
  const lastAccrualDay = endDay;

  const segments: InterestSegment[] = [];
  let totalInterest = 0;
  let totalDays = 0;

  for (let i = 0; i < timeline.length; i += 1) {
    const period = timeline[i];
    const next = timeline[i + 1];
    // Deze tariefperiode dekt dag-indices [period.fromDay .. periodEndDay].
    const periodEndDay = next ? next.fromDay - 1 : Number.POSITIVE_INFINITY;
    const lo = Math.max(firstAccrualDay, period.fromDay);
    const hi = Math.min(lastAccrualDay, periodEndDay);
    const days = hi - lo + 1;
    if (days <= 0) continue;
    const rate = period.rateBasisPoints / 10_000; // bp → fractie
    const segInterest = (principalCents * days * rate) / 365;
    totalInterest += segInterest;
    totalDays += days;
    segments.push({
      from: isoFromDayIndex(lo),
      to: isoFromDayIndex(hi),
      days,
      rateBasisPoints: period.rateBasisPoints,
      interestCents: Math.round(segInterest),
    });
  }

  if (segments.length === 0) return empty;

  // Dagrente op het eindtarief (het tarief dat op de rekendatum geldt).
  const endRatePeriod = [...timeline].reverse().find((p) => p.fromDay <= lastAccrualDay) ?? timeline[timeline.length - 1];
  const dailyRateCentsAtEnd = Math.round((principalCents * (endRatePeriod.rateBasisPoints / 10_000)) / 365);

  return {
    interestCents: Math.round(totalInterest),
    days: totalDays,
    dailyRateCentsAtEnd,
    segments,
  };
}

// ---------------------------------------------------------------------------
// Samengestelde vordering — principal + rente + incassokosten (+ evt. btw).
// ---------------------------------------------------------------------------

export function calculateDunningClaim(input: {
  principalCents: number;
  dueDate: string;
  calculationDate: string;
  interestKind: InterestKind;
  ratePeriods: RatePeriod[];
  collectionCostsVatRateBasisPoints?: number; // bv. 2100 = 21%; weglaten/0 = geen btw over kosten
}): DunningClaim {
  const principalCents = Math.max(0, Math.round(input.principalCents));
  const interest = calculateStatutoryInterestCents({
    principalCents,
    dueDate: input.dueDate,
    calculationDate: input.calculationDate,
    kind: input.interestKind,
    ratePeriods: input.ratePeriods,
  });
  const collectionCostsCents = calculateWikCollectionCostsCents(principalCents);
  const vatRate = Math.max(0, Math.round(input.collectionCostsVatRateBasisPoints ?? 0)) / 10_000;
  const collectionCostsVatCents = vatRate > 0 ? Math.round(collectionCostsCents * vatRate) : 0;
  const totalClaimCents = principalCents + interest.interestCents + collectionCostsCents + collectionCostsVatCents;
  return {
    principalCents,
    interestCents: interest.interestCents,
    interest,
    collectionCostsCents,
    collectionCostsVatCents,
    totalClaimCents,
    interestKind: input.interestKind,
    calculationDate: input.calculationDate,
    dueDate: input.dueDate,
  };
}
