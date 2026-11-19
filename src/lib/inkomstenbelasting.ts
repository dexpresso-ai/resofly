// ============================================================
// Inkomstenbelasting — een raming voor de ondernemer van een eenmanszaak en
// voor elke vennoot van een vof, maatschap of cv.
//
// Puur rekenwerk: geen database, geen netwerk, geen datum-van-nu. Alles gaat
// erin als argument, zodat het te testen is (inkomstenbelasting.test.ts) en het
// scherm en Gerrie (de leeshandeling owners.income_tax_estimate) precies
// hetzelfde uitrekenen. Bedragen in hele centen, percentages in duizendsten van
// een procent (35,75% = 35750, 6,398% = 6398): de officiële tabellen hebben drie
// decimalen, en in basispunten zou 6,398% al niet passen.
//
// SPIEGEL: supabase/functions/_shared/inkomstenbelasting.ts is een kopie van dit
// bestand voor de edge functions. src/lib/inkomstenbelasting.test.ts vergelijkt
// ze vanaf de markering hieronder teken voor teken. Pas ze altijd samen aan.
//
// DE SOM (Wet IB 2001)
// ────────────────────
//   winst(aandeel) uit de boekhouding
//   + het niet-aftrekbare deel van eten, drinken en representatie (rekening
//     4600, art. 3.15): 20% of tot de drempel, wat het gunstigst is — net als
//     het overzicht voor de aangifte op Eigen vermogen (src/lib/incomeTax.ts)
//   + fiscale correcties (bijtelling auto, niet-aftrekbare kosten, …)
//   − kleinschaligheidsinvesteringsaftrek (art. 3.41; bij een vof over de
//     investeringen van de hele vof, verdeeld naar winstaandeel — HR 1 mei 2020)
//   = winst uit onderneming
//   − ondernemersaftrek (art. 3.74): zelfstandigenaftrek, startersaftrek en wat
//     je zelf aan S&O-, meewerk- of stakingsaftrek opgeeft
//   − mkb-winstvrijstelling (art. 3.79a): 12,70% van de winst na
//     ondernemersaftrek, ook over een verlies (dat wordt dan kleiner)
//   = belastbare winst uit onderneming
//   − verlies uit eerdere jaren (art. 3.150)
//   = belastbaar inkomen uit werk en woning → tarief box 1 (art. 2.10),
//     aftrekbeperking (art. 2.10a), heffingskortingen (hoofdstuk 8)
//   + inkomensafhankelijke bijdrage Zvw over de belastbare winst (art. 43 Zvw)
//
// Waar het eerder misging of makkelijk misgaat:
// - De arbeidskorting rekent over de winst VÓÓR ondernemersaftrek en
//   mkb-winstvrijstelling (art. 8.11: "winst uit onderneming"), de algemene
//   heffingskorting over het belastbare inkomen erná. Wie beide over hetzelfde
//   bedrag rekent, zit er bij een starter honderden euro's naast.
// - De zelfstandigenaftrek is hoogstens de winst, BEHALVE voor wie recht heeft
//   op startersaftrek: die trekt hem helemaal af, ook als er dan een verlies
//   ontstaat (art. 3.76 lid 4).
// - De ondernemersaftrek en de mkb-winstvrijstelling leveren sinds 2020
//   hoogstens het tarief van de tweede schijf op (art. 2.10a): over het deel
//   van het inkomen in de hoogste schijf komt het verschil er weer bij.
// - Een commanditaire vennoot is medegerechtigde, geen ondernemer (art. 3.4):
//   geen ondernemersaftrek, geen mkb-winstvrijstelling en zijn winstaandeel
//   telt niet als arbeidsinkomen. De KIA krijgt hij wel.
// - Wie het hele jaar de AOW-leeftijd heeft, betaalt in de eerste schijf geen
//   AOW-premie, krijgt de halve zelfstandigenaftrek (ook de startersaftrek),
//   lagere heffingskortingen en de ouderenkorting. Wie hem in de loop van het
//   jaar bereikt, betaalt AOW-premie over de maanden ervoor; de premie en de
//   kortingen gaan dan naar rato.
//
// WAT DIT BESTAND BEWUST NIET DOET
// ────────────────────────────────
// Alleen het zakelijke inkomen uit deze onderneming telt mee. Ander inkomen
// (loon, uitkering, pensioen, box 2 en 3, inkomen van een partner),
// persoonlijke aftrekposten (eigen woning, giften, zorgkosten, lijfrente) en
// kortingen die van de persoonlijke situatie afhangen (inkomensafhankelijke
// combinatiekorting, alleenstaande-ouderenkorting) staan er niet in: die kent
// ResoFly niet. Ook niet: geboren vóór 1946 (een ruimere eerste schijf), de
// startersaftrek bij arbeidsongeschiktheid, de willekeurige afschrijving en
// de desinvesteringsbijtelling (die kun je als correctie opgeven).
//
// Dit is een raming, geen aangifte en geen advies.
// ============================================================

// ---- Vanaf hier is dit bestand gelijk aan zijn spiegel (zie de test). ----

/** Wat iedereen bij de raming te zien krijgt, in het scherm en via Gerrie. */
export const IB_DISCLAIMER =
  'Dit is een raming van de inkomstenbelasting en de Zvw-bijdrage over alleen het zakelijke inkomen uit deze onderneming. ' +
  'Ander inkomen (loon, uitkering, pensioen, box 2 en 3, inkomen van een partner), persoonlijke aftrekposten (zoals hypotheekrente, giften en zorgkosten) ' +
  'en kortingen die van je persoonlijke situatie afhangen, zijn niet meegenomen. De heffingskortingen zijn berekend alsof dit je enige inkomen is. ' +
  'Je werkelijke aanslag kan daardoor hoger of lager uitvallen. Geen aangifte en geen fiscaal advies.';

/** Percentages in duizendsten van een procent: 35,75% = 35750. */
const RATE_UNIT = 100_000;

/** Eén schijf van box 1. */
export interface IbBracket {
  /** Bovengrens van de schijf in centen; null voor de hoogste schijf. */
  upToCents: number | null;
  /** Tarief inclusief premie volksverzekeringen, in duizendsten van een procent. */
  rate: number;
}

/** Een korting in stukken: vanaf `fromCents` geldt `baseCents + rate × (inkomen − fromCents)`. */
export interface IbCreditSegment {
  fromCents: number;
  baseCents: number;
  /** In duizendsten van een procent; negatief in de afbouw. */
  rate: number;
}

export interface IbCreditTable {
  segments: IbCreditSegment[];
  /** Vanaf dit inkomen is de korting nul (de afbouw is dan klaar). */
  zeroFromCents: number;
}

export interface IbPhaseOutCredit {
  maxCents: number;
  /** Tot en met dit inkomen de volle korting; daarboven de afbouw. */
  phaseOutFromCents: number;
  rate: number;
  /** Vanaf dit inkomen nul; null als de afbouw zelf op nul uitkomt. */
  zeroFromCents: number | null;
}

/** De regels van één kalenderjaar. */
export interface IbYearRules {
  year: number;
  /** Schijven box 1 voor wie de AOW-leeftijd nog niet heeft, oplopend. */
  brackets: IbBracket[];
  /** Tarief van de eerste schijf bij de AOW-leeftijd het hele jaar (geboren vanaf 1946). */
  aowFirstBracketRate: number;
  /** Art. 2.10a: ondernemersaftrek en mkb-winstvrijstelling leveren hoogstens dit tarief op. */
  deductionCapRate: number;
  zelfstandigenaftrekCents: number;
  startersaftrekCents: number;
  mkbExemptionRate: number;
  kia: {
    /** Tot en met dit totaal aan investeringen geen KIA. */
    zeroUpToCents: number;
    rate: number;
    /** Tot en met dit totaal het percentage. */
    percentageUpToCents: number;
    fixedCents: number;
    /** Tot en met dit totaal het vaste bedrag; daarboven de afbouw. */
    fixedUpToCents: number;
    phaseOutRate: number;
    /** Boven dit totaal geen KIA meer. */
    maxCents: number;
    /** Een bedrijfsmiddel telt pas mee vanaf dit bedrag (art. 3.45). */
    minAssetCents: number;
  };
  generalCredit: IbPhaseOutCredit;
  generalCreditAow: IbPhaseOutCredit;
  labourCredit: IbCreditTable;
  labourCreditAow: IbCreditTable;
  elderlyCredit: IbPhaseOutCredit;
  zvwRate: number;
  zvwMaxBaseCents: number;
  /** Art. 3.15: niet aftrekbaar is 20% van de gemengde kosten, of naar keuze alles tot deze drempel. */
  mixedCostsThresholdCents: number;
}

const EURO = 100;

/**
 * Bronnen: Belastingdienst (tabellen box 1, algemene heffingskorting,
 * arbeidskorting, ouderenkorting, KIA, ondernemersaftrek en mkb-winstvrijstelling
 * 2025 en 2026; percentages bijdrage Zvw) en de Wet IB 2001 zoals die in dat
 * jaar gold. De AOW-tabel van de arbeidskorting heeft eigen afgeronde
 * basisbedragen; die staan er letterlijk in, niet herberekend.
 */
export const IB_RULES: Record<number, IbYearRules> = {
  2025: {
    year: 2025,
    brackets: [
      { upToCents: 38_441 * EURO, rate: 35_820 },
      { upToCents: 76_817 * EURO, rate: 37_480 },
      { upToCents: null, rate: 49_500 },
    ],
    aowFirstBracketRate: 17_920,
    deductionCapRate: 37_480,
    zelfstandigenaftrekCents: 2_470 * EURO,
    startersaftrekCents: 2_123 * EURO,
    mkbExemptionRate: 12_700,
    kia: {
      zeroUpToCents: 2_900 * EURO,
      rate: 28_000,
      percentageUpToCents: 70_602 * EURO,
      fixedCents: 19_769 * EURO,
      fixedUpToCents: 130_744 * EURO,
      phaseOutRate: 7_560,
      maxCents: 392_230 * EURO,
      minAssetCents: 450 * EURO,
    },
    generalCredit: { maxCents: 3_068 * EURO, phaseOutFromCents: 28_406 * EURO, rate: 6_337, zeroFromCents: 76_817 * EURO },
    generalCreditAow: { maxCents: 1_536 * EURO, phaseOutFromCents: 28_406 * EURO, rate: 3_170, zeroFromCents: 76_817 * EURO },
    labourCredit: {
      segments: [
        { fromCents: 0, baseCents: 0, rate: 8_053 },
        { fromCents: 12_169 * EURO, baseCents: 980 * EURO, rate: 30_030 },
        { fromCents: 26_288 * EURO, baseCents: 5_220 * EURO, rate: 2_258 },
        { fromCents: 43_071 * EURO, baseCents: 5_599 * EURO, rate: -6_510 },
      ],
      zeroFromCents: 129_079 * EURO,
    },
    labourCreditAow: {
      segments: [
        { fromCents: 0, baseCents: 0, rate: 4_029 },
        { fromCents: 12_169 * EURO, baseCents: 491 * EURO, rate: 15_023 },
        { fromCents: 26_288 * EURO, baseCents: 2_612 * EURO, rate: 1_130 },
        { fromCents: 43_071 * EURO, baseCents: 2_802 * EURO, rate: -3_257 },
      ],
      zeroFromCents: 129_079 * EURO,
    },
    elderlyCredit: { maxCents: 2_035 * EURO, phaseOutFromCents: 45_308 * EURO, rate: 15_000, zeroFromCents: null },
    zvwRate: 5_260,
    zvwMaxBaseCents: 75_864 * EURO,
    mixedCostsThresholdCents: 5_700 * EURO,
  },
  2026: {
    year: 2026,
    brackets: [
      { upToCents: 38_883 * EURO, rate: 35_750 },
      { upToCents: 78_426 * EURO, rate: 37_560 },
      { upToCents: null, rate: 49_500 },
    ],
    aowFirstBracketRate: 17_850,
    deductionCapRate: 37_560,
    zelfstandigenaftrekCents: 1_200 * EURO,
    startersaftrekCents: 2_123 * EURO,
    mkbExemptionRate: 12_700,
    kia: {
      zeroUpToCents: 2_900 * EURO,
      rate: 28_000,
      percentageUpToCents: 71_683 * EURO,
      fixedCents: 20_072 * EURO,
      fixedUpToCents: 132_746 * EURO,
      phaseOutRate: 7_560,
      maxCents: 398_236 * EURO,
      minAssetCents: 450 * EURO,
    },
    generalCredit: { maxCents: 3_115 * EURO, phaseOutFromCents: 29_736 * EURO, rate: 6_398, zeroFromCents: 78_426 * EURO },
    generalCreditAow: { maxCents: 1_556 * EURO, phaseOutFromCents: 29_736 * EURO, rate: 3_195, zeroFromCents: 78_426 * EURO },
    labourCredit: {
      segments: [
        { fromCents: 0, baseCents: 0, rate: 8_324 },
        { fromCents: 11_965 * EURO, baseCents: 996 * EURO, rate: 31_009 },
        { fromCents: 25_845 * EURO, baseCents: 5_300 * EURO, rate: 1_950 },
        { fromCents: 45_592 * EURO, baseCents: 5_685 * EURO, rate: -6_510 },
      ],
      zeroFromCents: 132_921 * EURO,
    },
    labourCreditAow: {
      segments: [
        { fromCents: 0, baseCents: 0, rate: 4_156 },
        { fromCents: 11_965 * EURO, baseCents: 498 * EURO, rate: 15_483 },
        { fromCents: 25_845 * EURO, baseCents: 2_647 * EURO, rate: 974 },
        { fromCents: 45_592 * EURO, baseCents: 2_840 * EURO, rate: -3_250 },
      ],
      zeroFromCents: 132_921 * EURO,
    },
    elderlyCredit: { maxCents: 2_067 * EURO, phaseOutFromCents: 46_002 * EURO, rate: 15_000, zeroFromCents: null },
    zvwRate: 4_850,
    zvwMaxBaseCents: 79_409 * EURO,
    // In 2026 niet geïndexeerd: dezelfde drempel als in 2025.
    mixedCostsThresholdCents: 5_700 * EURO,
  },
};

export const IB_FIRST_YEAR = 2025;
export const IB_LAST_YEAR = 2026;

/**
 * De regels voor een jaar. Voor een jaar na het laatst bekende rekenen we met
 * het laatst bekende (exact = false, het scherm zegt dat erbij); vóór 2025
 * niets, want daar staan de tabellen niet in.
 */
export function incomeTaxRulesFor(year: number): { rules: IbYearRules; exact: boolean } | null {
  if (!Number.isInteger(year) || year < IB_FIRST_YEAR) return null;
  if (IB_RULES[year]) return { rules: IB_RULES[year], exact: true };
  return { rules: IB_RULES[IB_LAST_YEAR], exact: false };
}

// ── Rekenen zonder afrondingsfouten ─────────────────────────────────────────

/** a × b / c, rekenkundig afgerond (een halve cent van nul af), exact met BigInt. */
function mulDiv(a: number, b: number, c: number): number {
  const n = BigInt(Math.trunc(a)) * BigInt(Math.trunc(b));
  const d = BigInt(Math.trunc(c));
  const q = n / d;
  const r = n % d;
  const twice = (r < 0n ? -r : r) * 2n;
  const absD = d < 0n ? -d : d;
  if (twice >= absD) return Number(q + ((n < 0n) !== (d < 0n) ? -1n : 1n));
  return Number(q);
}

/** Een percentage (duizendsten van een procent) van een bedrag in centen. */
export function applyRate(amountCents: number, rate: number): number {
  return mulDiv(amountCents, rate, RATE_UNIT);
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** "35,75%" uit 35750, "6,398%" uit 6398: twee decimalen, drie als dat nodig is. */
export function formatRate(rate: number): string {
  const decimals = Math.trunc(rate) % 10 === 0 ? 2 : 3;
  return `${(Math.trunc(rate) / 1000).toFixed(decimals).replace('.', ',')}%`;
}

// ── De onderdelen ───────────────────────────────────────────────────────────

/**
 * Kleinschaligheidsinvesteringsaftrek over het TOTAAL van de investeringen in
 * het jaar (art. 3.41). Bij een vof is dat het totaal van de vof.
 */
export function kiaForInvestments(rules: IbYearRules, totalInvestmentCents: number): number {
  const k = rules.kia;
  const total = Math.trunc(totalInvestmentCents);
  if (total <= k.zeroUpToCents) return 0;
  if (total <= k.percentageUpToCents) return applyRate(total, k.rate);
  if (total <= k.fixedUpToCents) return k.fixedCents;
  if (total <= k.maxCents) return Math.max(0, k.fixedCents - applyRate(total - k.fixedUpToCents, k.phaseOutRate));
  return 0;
}

/** Het deel van de gemengde kosten dat niet aftrekbaar is: 20%. */
const MIXED_COSTS_RATE = 20_000;

/**
 * Het niet-aftrekbare deel van eten, drinken en representatie (art. 3.15): de
 * ondernemer kiest per jaar de gunstigste van twee methoden, 20% van het
 * totaal of alles tot de drempel. Zelfde uitkomst als mixedCostsAddBack in
 * src/lib/incomeTax.ts (de test houdt de twee gelijk).
 */
export function mixedCostsAddBack(rules: IbYearRules, totalCents: number): { addBackCents: number; method: 'percentage' | 'threshold' } {
  const total = Math.max(0, Math.trunc(Number.isFinite(totalCents) ? totalCents : 0));
  const percentage = applyRate(total, MIXED_COSTS_RATE);
  const threshold = Math.min(total, rules.mixedCostsThresholdCents);
  return percentage <= threshold
    ? { addBackCents: percentage, method: 'percentage' }
    : { addBackCents: threshold, method: 'threshold' };
}

/** Algemene heffingskorting of ouderenkorting: vol tot de grens, daarna de afbouw. */
export function phaseOutCredit(credit: IbPhaseOutCredit, incomeCents: number): number {
  if (credit.zeroFromCents !== null && incomeCents >= credit.zeroFromCents) return 0;
  if (incomeCents <= credit.phaseOutFromCents) return credit.maxCents;
  return clamp(credit.maxCents - applyRate(incomeCents - credit.phaseOutFromCents, credit.rate), 0, credit.maxCents);
}

/** Arbeidskorting volgens de tabel van het jaar. Geen arbeidsinkomen, geen korting. */
export function tableCredit(table: IbCreditTable, incomeCents: number): number {
  if (incomeCents <= 0 || incomeCents >= table.zeroFromCents) return 0;
  let segment = table.segments[0];
  for (const candidate of table.segments) {
    if (incomeCents > candidate.fromCents) segment = candidate;
  }
  return Math.max(0, segment.baseCents + applyRate(incomeCents - segment.fromCents, segment.rate));
}

export type AowStatus = 'nee' | 'heel_jaar' | 'in_jaar';

/**
 * Over hoeveel maanden van het jaar nog AOW-premie wordt geheven (0–12). In
 * de maand waarin je de AOW-leeftijd bereikt, betaal je al geen premie meer.
 */
export function premiumMonths(aowStatus: AowStatus, aowMonth: number | null): number {
  if (aowStatus === 'heel_jaar') return 0;
  if (aowStatus === 'in_jaar') return clamp(Math.trunc(aowMonth ?? 1) - 1, 0, 11);
  return 12;
}

/** Tussen de korting met en zonder AOW-leeftijd, naar rato van de premiemaanden. */
function blend(withAow: number, withoutAow: number, months: number): number {
  if (months >= 12) return withoutAow;
  if (months <= 0) return withAow;
  return withAow + mulDiv(withoutAow - withAow, months, 12);
}

export interface IbBracketLine {
  fromCents: number;
  toCents: number | null;
  /** Het tarief dat hier gold, in duizendsten van een procent (bij AOW in de loop van het jaar: gemiddeld). */
  rate: number;
  amountCents: number;
  taxCents: number;
}

/** Box 1 over een belastbaar inkomen, schijf voor schijf. */
export function bracketTax(rules: IbYearRules, incomeCents: number, months: number): { lines: IbBracketLine[]; taxCents: number } {
  const lines: IbBracketLine[] = [];
  let lower = 0;
  let taxCents = 0;
  rules.brackets.forEach((bracket, index) => {
    const upper = bracket.upToCents;
    const amount = Math.max(0, Math.min(incomeCents, upper ?? Number.MAX_SAFE_INTEGER) - lower);
    if (amount > 0) {
      let tax: number;
      let rate = bracket.rate;
      if (index === 0 && months < 12) {
        // De AOW-premie (het verschil tussen de twee tarieven) alleen over de
        // maanden vóór de AOW-leeftijd.
        const premium = applyRate(amount, bracket.rate - rules.aowFirstBracketRate);
        tax = applyRate(amount, rules.aowFirstBracketRate) + mulDiv(premium, months, 12);
        rate = rules.aowFirstBracketRate + mulDiv(bracket.rate - rules.aowFirstBracketRate, months, 12);
      } else {
        tax = applyRate(amount, bracket.rate);
      }
      lines.push({ fromCents: lower, toCents: upper, rate, amountCents: amount, taxCents: tax });
      taxCents += tax;
    }
    if (upper !== null) lower = upper;
  });
  return { lines, taxCents };
}

// ── Eén persoon ─────────────────────────────────────────────────────────────

export interface IbPersonInput {
  /** Winst(aandeel) uit de boekhouding, in centen; verlies is negatief. */
  profitShareCents: number;
  /** Fiscale correcties voor deze persoon (al verdeeld): positief verhoogt de winst. */
  correctionsCents: number;
  /** KIA voor deze persoon, als positief bedrag; gaat van de winst af. */
  kiaCents: number;
  /** Ondernemer voor de IB; false voor een commanditaire vennoot (medegerechtigde). */
  isEntrepreneur: boolean;
  /** null = nog niet ingevuld: dan rekenen we zonder zelfstandigenaftrek. */
  meetsHoursCriterion: boolean | null;
  starter: boolean;
  aowStatus: AowStatus;
  aowMonth: number | null;
  /** S&O-, meewerk- of stakingsaftrek die de ondernemer zelf opgeeft. */
  otherEntrepreneurDeductionCents: number;
  /** Nog te verrekenen verlies uit werk en woning uit eerdere jaren. */
  lossCarryForwardCents: number;
  provisionalIncomeTaxCents: number;
  provisionalZvwCents: number;
}

export interface IbPersonEstimate {
  rulesYear: number;
  profitShareCents: number;
  correctionsCents: number;
  kiaCents: number;
  /** Winst uit onderneming: winstaandeel + correcties − KIA. */
  profitCents: number;
  zelfstandigenaftrekCents: number;
  /** Zelfstandigenaftrek die niet paste (winst te laag); de Belastingdienst verrekent die later. */
  zelfstandigenaftrekUnusedCents: number;
  startersaftrekCents: number;
  otherEntrepreneurDeductionCents: number;
  entrepreneurDeductionCents: number;
  profitAfterDeductionCents: number;
  /** Mkb-winstvrijstelling; negatief bij een verlies (het verlies wordt kleiner). */
  mkbExemptionCents: number;
  /** Belastbare winst uit onderneming. */
  taxableProfitCents: number;
  lossOffsetCents: number;
  /** Belastbaar inkomen uit werk en woning (nooit negatief). */
  taxableIncomeCents: number;
  /** Verlies uit werk en woning van dit jaar, als positief bedrag. */
  lossThisYearCents: number;
  brackets: IbBracketLine[];
  bracketTaxCents: number;
  /** Art. 2.10a: wat de aftrekposten in de hoogste schijf te veel opleveren. */
  deductionCapCents: number;
  taxBeforeCreditsCents: number;
  /** Grondslag van de arbeidskorting: winst uit onderneming vóór ondernemersaftrek en mkb-winstvrijstelling. */
  labourIncomeCents: number;
  generalCreditCents: number;
  labourCreditCents: number;
  elderlyCreditCents: number;
  creditsCents: number;
  /** Wat er van de kortingen af kan: nooit meer dan de belasting zelf. */
  creditsAppliedCents: number;
  /** Inkomstenbelasting en premie volksverzekeringen na de kortingen. */
  incomeTaxCents: number;
  zvwBaseCents: number;
  zvwCents: number;
  totalCents: number;
  provisionalIncomeTaxCents: number;
  provisionalZvwCents: number;
  /** Positief = bijbetalen, negatief = terugkrijgen. */
  balanceIncomeTaxCents: number;
  balanceZvwCents: number;
  balanceCents: number;
  /** IB + Zvw als deel van de winst uit onderneming, in duizendsten van een procent; 0 zonder winst. */
  effectiveRate: number;
  premiumMonths: number;
}

const nonNegative = (value: number) => Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
const whole = (value: number) => Math.trunc(Number.isFinite(value) ? value : 0);

export function estimatePerson(rules: IbYearRules, input: IbPersonInput): IbPersonEstimate {
  const profitShareCents = whole(input.profitShareCents);
  const correctionsCents = whole(input.correctionsCents);
  const kiaCents = nonNegative(input.kiaCents);
  const profitCents = profitShareCents + correctionsCents - kiaCents;
  const months = premiumMonths(input.aowStatus, input.aowMonth);

  // Ondernemersaftrek: alleen voor een ondernemer, de zelfstandigen- en
  // startersaftrek alleen met het urencriterium.
  let zelfstandigenaftrekCents = 0;
  let zelfstandigenaftrekUnusedCents = 0;
  let startersaftrekCents = 0;
  if (input.isEntrepreneur && input.meetsHoursCriterion === true) {
    const half = input.aowStatus === 'heel_jaar';
    const full = half ? mulDiv(rules.zelfstandigenaftrekCents, 1, 2) : rules.zelfstandigenaftrekCents;
    if (input.starter) {
      startersaftrekCents = half ? mulDiv(rules.startersaftrekCents, 1, 2) : rules.startersaftrekCents;
      zelfstandigenaftrekCents = full;
    } else {
      zelfstandigenaftrekCents = Math.min(full, Math.max(0, profitCents));
      zelfstandigenaftrekUnusedCents = full - zelfstandigenaftrekCents;
    }
  }
  const otherEntrepreneurDeductionCents = input.isEntrepreneur ? nonNegative(input.otherEntrepreneurDeductionCents) : 0;
  const entrepreneurDeductionCents = zelfstandigenaftrekCents + startersaftrekCents + otherEntrepreneurDeductionCents;
  const profitAfterDeductionCents = profitCents - entrepreneurDeductionCents;
  const mkbExemptionCents = input.isEntrepreneur ? applyRate(profitAfterDeductionCents, rules.mkbExemptionRate) : 0;
  const taxableProfitCents = profitAfterDeductionCents - mkbExemptionCents;

  // Box 1: alleen dit inkomen. Een verlies uit eerdere jaren gaat eraf, maar
  // nooit verder dan nul.
  const lossOffsetCents = Math.min(nonNegative(input.lossCarryForwardCents), Math.max(0, taxableProfitCents));
  const taxableIncomeCents = Math.max(0, taxableProfitCents - lossOffsetCents);
  const lossThisYearCents = Math.max(0, -taxableProfitCents);

  const box1 = bracketTax(rules, taxableIncomeCents, months);
  const top = rules.brackets[rules.brackets.length - 1];
  const topLowerCents = rules.brackets.length > 1 ? (rules.brackets[rules.brackets.length - 2].upToCents ?? 0) : 0;
  const cappedDeductions = entrepreneurDeductionCents + Math.max(0, mkbExemptionCents);
  // Art. 2.10 lid 2: de aftrekposten tellen als het bovenste deel van het
  // inkomen. De verhoging gaat dus over de aftrekposten, tot hoogstens het
  // bedrag waarmee het inkomen MET die aftrekposten erbij boven de grens van
  // de hoogste schijf uitkomt. Eerder stond hier het inkomen ná aftrek
  // tegenover de grens. Bij € 90.000 winst (belastbaar € 77.522, net onder
  // de grens) was de verhoging daardoor € 0 in plaats van € 1.381,94: elke
  // winst tussen ongeveer € 78.000 en € 108.000 kreeg een te lage raming.
  const deductionCapCents = applyRate(
    Math.min(cappedDeductions, Math.max(0, taxableIncomeCents + cappedDeductions - topLowerCents)),
    Math.max(0, top.rate - rules.deductionCapRate),
  );
  const taxBeforeCreditsCents = box1.taxCents + deductionCapCents;

  // Heffingskortingen: de algemene en de ouderenkorting over het
  // verzamelinkomen, de arbeidskorting over de winst vóór aftrek. Het
  // verzamelinkomen is het inkomen vóór verliesverrekening (art. 2.18): een
  // verlies uit een eerder jaar maakt de belasting lager, niet de afbouw van
  // de kortingen. Eerder stond hier het inkomen ná verrekening, en kreeg wie
  // een oud verlies verrekende te veel korting in de raming.
  const aggregateIncomeCents = Math.max(0, taxableProfitCents);
  const labourIncomeCents = input.isEntrepreneur ? Math.max(0, profitCents) : 0;
  const generalCreditCents = blend(
    phaseOutCredit(rules.generalCreditAow, aggregateIncomeCents),
    phaseOutCredit(rules.generalCredit, aggregateIncomeCents),
    months,
  );
  const labourCreditCents = blend(
    tableCredit(rules.labourCreditAow, labourIncomeCents),
    tableCredit(rules.labourCredit, labourIncomeCents),
    months,
  );
  const elderlyCreditCents = input.aowStatus === 'nee' ? 0 : phaseOutCredit(rules.elderlyCredit, aggregateIncomeCents);
  const creditsCents = generalCreditCents + labourCreditCents + elderlyCreditCents;
  const creditsAppliedCents = Math.min(creditsCents, taxBeforeCreditsCents);
  const incomeTaxCents = taxBeforeCreditsCents - creditsAppliedCents;

  // Zvw-bijdrage over de belastbare winst, tot het maximum; een verlies uit
  // een ander jaar verlaagt die grondslag niet.
  const zvwBaseCents = clamp(taxableProfitCents, 0, rules.zvwMaxBaseCents);
  const zvwCents = applyRate(zvwBaseCents, rules.zvwRate);

  const totalCents = incomeTaxCents + zvwCents;
  const provisionalIncomeTaxCents = nonNegative(input.provisionalIncomeTaxCents);
  const provisionalZvwCents = nonNegative(input.provisionalZvwCents);
  const balanceIncomeTaxCents = incomeTaxCents - provisionalIncomeTaxCents;
  const balanceZvwCents = zvwCents - provisionalZvwCents;

  return {
    rulesYear: rules.year,
    profitShareCents,
    correctionsCents,
    kiaCents,
    profitCents,
    zelfstandigenaftrekCents,
    zelfstandigenaftrekUnusedCents,
    startersaftrekCents,
    otherEntrepreneurDeductionCents,
    entrepreneurDeductionCents,
    profitAfterDeductionCents,
    mkbExemptionCents,
    taxableProfitCents,
    lossOffsetCents,
    taxableIncomeCents,
    lossThisYearCents,
    brackets: box1.lines,
    bracketTaxCents: box1.taxCents,
    deductionCapCents,
    taxBeforeCreditsCents,
    labourIncomeCents,
    generalCreditCents,
    labourCreditCents,
    elderlyCreditCents,
    creditsCents,
    creditsAppliedCents,
    incomeTaxCents,
    zvwBaseCents,
    zvwCents,
    totalCents,
    provisionalIncomeTaxCents,
    provisionalZvwCents,
    balanceIncomeTaxCents,
    balanceZvwCents,
    balanceCents: balanceIncomeTaxCents + balanceZvwCents,
    effectiveRate: profitCents > 0 ? mulDiv(totalCents, RATE_UNIT, profitCents) : 0,
    premiumMonths: months,
  };
}

// ── Verdelen over vennoten ──────────────────────────────────────────────────

export interface IbShare {
  key: string;
  /** Winstaandeel in basispunten (5000 = 50%). */
  basisPoints: number;
  /** Volgorde bij een gelijke rest: het vennootnummer. */
  order: number;
}

/**
 * Een bedrag verdelen naar winstaandeel, tot op de cent sluitend: zelfde regel
 * als partnership_result_shares in de database (eerst ieder het naar beneden
 * afgeronde deel, dan de resterende centen naar de grootste resten, bij een
 * gelijke rest het laagste vennootnummer). Telt de verdeling niet op tot 100%,
 * dan alleen de afgeronde delen — net als de database.
 */
export function splitByShares(amountCents: number, shares: IbShare[]): Map<string, number> {
  const out = new Map<string, number>();
  const total = BigInt(Math.abs(Math.trunc(amountCents)));
  const sign = amountCents < 0 ? -1 : 1;
  const totalBp = shares.reduce((sum, s) => sum + s.basisPoints, 0);
  const parts = shares.map(s => {
    const product = total * BigInt(Math.max(0, Math.trunc(s.basisPoints)));
    return { key: s.key, order: s.order, base: product / 10000n, rem: product % 10000n };
  });
  let leftover = total - parts.reduce((sum, p) => sum + p.base, 0n);
  const ranked = [...parts].sort((a, b) => (a.rem === b.rem ? a.order - b.order : a.rem > b.rem ? -1 : 1));
  const extra = new Set<string>();
  if (totalBp === 10000) {
    for (const p of ranked) {
      if (leftover <= 0n) break;
      extra.add(p.key);
      leftover -= 1n;
    }
  }
  for (const p of parts) {
    const cents = Number(p.base) + (extra.has(p.key) ? 1 : 0);
    out.set(p.key, cents === 0 ? 0 : sign * cents);
  }
  return out;
}

// ── Prognose voor het lopende jaar ──────────────────────────────────────────

const DAY_MS = 86_400_000;
function dayNumber(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

export interface IbProjection {
  projectedCents: number;
  /** Eerste dag die meetelt: 1 januari, of later als de boekhouding later begon. */
  fromDate: string;
  elapsedDays: number;
  totalDays: number;
}

/** Korter dan dit zegt het tempo nog niets: één grote factuur in week twee wordt anders een jaaromzet. */
export const IB_PROJECTION_MIN_DAYS = 30;

/**
 * De geboekte winst doorgetrokken naar 31 december, in hetzelfde tempo. Alleen
 * voor een jaar dat nog loopt, en pas na de eerste maand. Begon de boekhouding
 * in ResoFly later in het jaar, dan telt het tempo vanaf die dag: anders zou
 * een start per 1 juli de winst halveren.
 */
export function projectYearResult(input: { resultCents: number; year: number; today: string; startDate: string | null }): IbProjection | null {
  const yearStart = `${input.year}-01-01`;
  const yearEnd = `${input.year}-12-31`;
  const fromDate = input.startDate && input.startDate.slice(0, 10) > yearStart ? input.startDate.slice(0, 10) : yearStart;
  if (fromDate > yearEnd) return null;
  const today = input.today.slice(0, 10);
  if (today < fromDate || today >= yearEnd) return null;
  const elapsedDays = dayNumber(today) - dayNumber(fromDate) + 1;
  const totalDays = dayNumber(yearEnd) - dayNumber(fromDate) + 1;
  if (elapsedDays < IB_PROJECTION_MIN_DAYS) return null;
  return {
    projectedCents: mulDiv(Math.trunc(input.resultCents), totalDays, elapsedDays),
    fromDate,
    elapsedDays,
    totalDays,
  };
}

// ── Het overzicht: van de gegevens uit de database naar een raming per persoon ─

export type IbCorrectionCode =
  'gemengde_kosten' | 'privegebruik_auto' | 'niet_aftrekbaar' | 'desinvesteringsbijtelling' | 'investeringsaftrek' | 'overig';

export const IB_CORRECTION_LABELS: Record<IbCorrectionCode, string> = {
  gemengde_kosten: 'Gemengde kosten (eten, drinken, representatie)',
  privegebruik_auto: 'Privégebruik auto van de zaak',
  niet_aftrekbaar: 'Niet-aftrekbare kosten (zoals boetes)',
  desinvesteringsbijtelling: 'Desinvesteringsbijtelling',
  investeringsaftrek: 'Energie- of milieu-investeringsaftrek (EIA/MIA)',
  overig: 'Overige correctie',
};

export interface IncomeTaxProfile {
  /** null: de ondernemer van een eenmanszaak (of een vof zonder vastgelegde vennoten). */
  partnerId: string | null;
  meetsHoursCriterion: boolean | null;
  starter: boolean;
  aowStatus: AowStatus;
  aowMonth: number | null;
  lossCarryForwardCents: number;
  otherEntrepreneurDeductionCents: number;
  provisionalIncomeTaxCents: number;
  provisionalZvwCents: number;
  updatedAt: string | null;
}

/** Precies wat get_income_tax_inputs teruggeeft. */
export interface IncomeTaxInputs {
  year: number;
  legalForm: string;
  isPartnershipForm: boolean;
  companyName: string | null;
  bookkeepingStartDate: string | null;
  /** W&V binnen het kalenderjaar, zonder de jaarafsluiting; winst positief. */
  resultCents: number;
  /** Kosten op rekeningen voor eten, drinken en representatie (subtype mixed_costs, 4600). */
  mixedCostsCents: number;
  overlappingFiscalYears: Array<{ id: string; label: string; periodStart: string; periodEnd: string; status: string }>;
  partners: Array<{ id: string; name: string; partnerNumber: number; kind: 'beherend' | 'commanditair'; isActive: boolean; shareBasisPoints: number }>;
  profiles: IncomeTaxProfile[];
  corrections: Array<{ id: string; partnerId: string | null; code: IbCorrectionCode; label: string; amountCents: number }>;
  investments: Array<{ assetId: string; name: string; assetNumber: string | null; acquisitionDate: string; costCents: number; excluded: boolean }>;
  /** Geregistreerde minuten van de ingelogde gebruiker in dit jaar; null zonder recht op Uren. */
  myMinutes: number | null;
  /** Geregistreerde minuten van de eigenaar (eenmanszaak); null zonder recht op Uren of bij een vof. */
  ownerMinutes: number | null;
  /**
   * Bij een vof, maatschap of cv: geregistreerde minuten per vennoot die aan een
   * teamlid hangt (partner-id → minuten). Null zonder recht op Uren of zonder vof.
   */
  partnerMinutes: Record<string, number> | null;
}

export type IncomeTaxBasis = 'geboekt' | 'prognose';

export interface IncomeTaxInvestment {
  assetId: string;
  name: string;
  assetNumber: string | null;
  acquisitionDate: string;
  costCents: number;
  excluded: boolean;
  /** Onder het minimum per bedrijfsmiddel: telt nooit mee. */
  belowMinimum: boolean;
  counts: boolean;
}

export interface IncomeTaxPerson {
  key: string;
  partnerId: string | null;
  name: string;
  kind: 'ondernemer' | 'beherend' | 'commanditair';
  /** Winstaandeel in basispunten; null bij een eenmanszaak. */
  shareBasisPoints: number | null;
  profile: IncomeTaxProfile;
  /** Of er voor dit jaar al gegevens zijn opgeslagen. */
  profileSaved: boolean;
  /** `automatic`: door ResoFly zelf (gemengde kosten op 4600), niet te verwijderen. */
  corrections: Array<{ id: string; code: IbCorrectionCode; label: string; amountCents: number; shared: boolean; automatic: boolean }>;
  /** Het urencriterium komt uit de geregistreerde uren (eigenaar of vennoot), niet uit wat er is opgeslagen. */
  hoursFromTimeTracking: boolean;
  /** Geregistreerde minuten van deze persoon in het jaar; null als ResoFly ze niet kent of niet mag tonen. */
  registeredMinutes: number | null;
  /** Alleen in de prognose, als het urencriterium de uren volgt: de uren doorgetrokken naar 31 december. */
  projectedMinutes: number | null;
  estimate: IbPersonEstimate;
  notes: string[];
}

export interface IncomeTaxOverview {
  year: number;
  rulesYear: number;
  rulesExact: boolean;
  basis: IncomeTaxBasis;
  resultCents: number;
  projection: IbProjection | null;
  /** De winst waarmee gerekend is: geboekt, of de prognose. */
  usedResultCents: number;
  investments: IncomeTaxInvestment[];
  investmentTotalCents: number;
  kiaCents: number;
  /** Eten, drinken en representatie (4600): het totaal en het niet-aftrekbare deel; null zonder zulke kosten. */
  mixedCosts: { totalCents: number; addBackCents: number; method: 'percentage' | 'threshold'; thresholdCents: number } | null;
  /** Uren van de eigenaar in dit jaar (eenmanszaak), als hint en standaard voor het urencriterium. */
  ownerMinutes: number | null;
  persons: IncomeTaxPerson[];
  warnings: string[];
  totals: { incomeTaxCents: number; zvwCents: number; totalCents: number; provisionalCents: number; balanceCents: number };
  disclaimer: string;
}

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/** "€ 1.234,56" — ook in Deno, zonder Intl-verschillen in de spaties. */
export function euroText(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const euros = Math.trunc(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${negative ? '−' : ''}€ ${euros},${rest}`;
}

export function defaultIncomeTaxProfile(partnerId: string | null): IncomeTaxProfile {
  return {
    partnerId,
    meetsHoursCriterion: null,
    starter: false,
    aowStatus: 'nee',
    aowMonth: null,
    lossCarryForwardCents: 0,
    otherEntrepreneurDeductionCents: 0,
    provisionalIncomeTaxCents: 0,
    provisionalZvwCents: 0,
    updatedAt: null,
  };
}

/** Het urencriterium in minuten: 1.225 uur. */
const HOURS_CRITERION_MINUTES = 1225 * 60;

function personNotes(rules: IbYearRules, person: {
  kind: IncomeTaxPerson['kind']; profile: IncomeTaxProfile; estimate: IbPersonEstimate; hoursFromTimeTracking: boolean;
  registeredMinutes: number | null; projectedMinutes: number | null; investmentTotalCents: number;
}): string[] {
  const notes: string[] = [];
  const { profile, estimate } = person;
  const hoursText = (minutes: number) => Math.floor(minutes / 60).toLocaleString('nl-NL');
  if (person.hoursFromTimeTracking && person.registeredMinutes !== null) {
    const hours = hoursText(person.registeredMinutes);
    const who = person.kind === 'ondernemer' ? 'de eigenaar heeft' : 'het teamlid van deze vennoot heeft';
    if (person.projectedMinutes !== null) {
      // De prognose trekt de winst door naar 31 december; dan de uren ook.
      // Anders kreeg wie op koers ligt een prognose zonder zelfstandigenaftrek.
      notes.push(`Urencriterium volgens Uren: ${who} nu ${hours} uur geregistreerd. In hetzelfde tempo zijn dat er ongeveer ${hoursText(person.projectedMinutes)} op 31 december: ${profile.meetsHoursCriterion ? 'genoeg voor de 1.225 uur' : 'minder dan 1.225'}. Klopt dat niet, kies dan zelf ja of nee.`);
    } else {
      notes.push(profile.meetsHoursCriterion
        ? `Urencriterium volgens Uren: ${who} ${hours} uur geregistreerd. Gaat minder dan de helft van de werktijd naar de onderneming (en is het geen starter), zet het dan op nee.`
        : `Urencriterium volgens Uren: ${who} ${hours} uur geregistreerd, minder dan 1.225. Staan niet alle uren in ResoFly, vul het dan zelf in.`);
    }
  } else if (profile.meetsHoursCriterion === false && person.registeredMinutes !== null && person.registeredMinutes >= HOURS_CRITERION_MINUTES) {
    // Een opgeslagen "nee" dat de uren hebben ingehaald: zeg het, want zonder
    // deze regel bleef de zelfstandigenaftrek stil weg.
    notes.push(`Bij Uren staan ${hoursText(person.registeredMinutes)} uur, maar het urencriterium staat hier op nee: er is gerekend zonder zelfstandigenaftrek. Klopt dat niet meer, kies dan "Volgens Uren" of ja, en sla op.`);
  }
  if (estimate.kiaCents > 0 && person.investmentTotalCents > 0) {
    notes.push(`De KIA rekent met ${euroText(person.investmentTotalCents)} aan investeringen uit Activa. Loop bij KIA na wat meetelt: een personenauto, grond, een woning en wat je verhuurt of vooral privé gebruikt tellen niet mee. Zet die uit, anders valt de raming te laag uit.`);
  }
  if (person.kind === 'commanditair') {
    notes.push('Commanditaire vennoot: voor de inkomstenbelasting geen ondernemer. Geen ondernemersaftrek en geen mkb-winstvrijstelling, en het winstaandeel telt niet als arbeidsinkomen voor de arbeidskorting. De KIA geldt wel.');
  } else {
    if (profile.meetsHoursCriterion === null) {
      notes.push('Urencriterium nog niet ingevuld: gerekend zonder zelfstandigenaftrek. Vul in of je 1.225 uur aan de onderneming besteedt.');
    } else if (!profile.meetsHoursCriterion && profile.starter) {
      notes.push('De startersaftrek hoort bij de zelfstandigenaftrek: zonder urencriterium telt hij niet mee.');
    }
    if (estimate.zelfstandigenaftrekUnusedCents > 0) {
      notes.push(`De winst is lager dan de zelfstandigenaftrek: ${euroText(estimate.zelfstandigenaftrekUnusedCents)} kon niet worden afgetrokken. De Belastingdienst verrekent dat met de winst van de volgende 9 jaar.`);
    }
  }
  if (profile.aowStatus === 'heel_jaar') {
    notes.push(person.kind === 'commanditair'
      ? 'AOW-leeftijd het hele jaar: geen AOW-premie in de eerste schijf, lagere heffingskortingen en de ouderenkorting.'
      : 'AOW-leeftijd het hele jaar: geen AOW-premie in de eerste schijf, de helft van de zelfstandigen- en startersaftrek, lagere heffingskortingen en de ouderenkorting.');
  } else if (profile.aowStatus === 'in_jaar') {
    const month = MONTHS[clamp(Math.trunc(profile.aowMonth ?? 1), 1, 12) - 1];
    notes.push(`AOW-leeftijd in ${month}: AOW-premie over ${estimate.premiumMonths} ${estimate.premiumMonths === 1 ? 'maand' : 'maanden'}, de heffingskortingen naar rato, en de ouderenkorting.`);
  }
  if (estimate.lossOffsetCents > 0) {
    notes.push(`Verlies uit eerdere jaren verrekend: ${euroText(estimate.lossOffsetCents)}.`);
  }
  if (estimate.lossThisYearCents > 0) {
    notes.push(`Verlies uit werk en woning: ${euroText(estimate.lossThisYearCents)}. De Belastingdienst verrekent dat met je inkomen uit werk en woning van de 3 jaar ervoor, en wat overblijft met de 9 jaar erna.`);
  }
  if (estimate.creditsCents > estimate.creditsAppliedCents && estimate.taxBeforeCreditsCents > 0) {
    notes.push(`De heffingskortingen zijn hoger dan de belasting: er valt ${euroText(estimate.creditsCents - estimate.creditsAppliedCents)} weg.`);
  }
  if (estimate.deductionCapCents > 0) {
    notes.push(`Een deel van het inkomen valt in de hoogste schijf: de ondernemersaftrek en mkb-winstvrijstelling leveren daar hoogstens ${formatRate(rules.deductionCapRate)} op (aftrekbeperking).`);
  }
  return notes;
}

/**
 * Van de gegevens uit de database naar een raming per persoon. `today` en de
 * keuze geboekt/prognose komen van buiten, zodat het scherm en Gerrie
 * hetzelfde uitrekenen.
 */
export function buildIncomeTaxOverview(inputs: IncomeTaxInputs, options: { basis: IncomeTaxBasis; today: string }): IncomeTaxOverview | null {
  const found = incomeTaxRulesFor(inputs.year);
  if (!found) return null;
  const { rules, exact } = found;
  const warnings: string[] = [];
  if (!exact) {
    warnings.push(`De tarieven en bedragen voor ${inputs.year} staan nog niet in ResoFly. Deze raming rekent met die van ${rules.year}; de uitkomst is daardoor minder precies.`);
  }

  const projection = projectYearResult({
    resultCents: inputs.resultCents, year: inputs.year, today: options.today, startDate: inputs.bookkeepingStartDate,
  });
  const basis: IncomeTaxBasis = options.basis === 'prognose' && projection ? 'prognose' : 'geboekt';
  const usedResultCents = basis === 'prognose' && projection ? projection.projectedCents : Math.trunc(inputs.resultCents);

  // KIA over alle investeringen van de onderneming in het jaar.
  const investments: IncomeTaxInvestment[] = inputs.investments.map(inv => {
    const belowMinimum = inv.costCents < rules.kia.minAssetCents;
    return { ...inv, belowMinimum, counts: !belowMinimum && !inv.excluded };
  });
  const investmentTotalCents = investments.filter(i => i.counts).reduce((sum, i) => sum + i.costCents, 0);
  const kiaCents = kiaForInvestments(rules, investmentTotalCents);

  // Wie: de actieve vennoten van een vof, maatschap of cv; anders één ondernemer.
  const active = inputs.isPartnershipForm
    ? inputs.partners.filter(p => p.isActive).sort((a, b) => a.partnerNumber - b.partnerNumber)
    : [];
  const profileFor = (partnerId: string | null) => inputs.profiles.find(p => p.partnerId === partnerId) ?? null;

  type Who = { key: string; partnerId: string | null; name: string; kind: IncomeTaxPerson['kind']; shareBasisPoints: number | null };
  const people: Who[] = active.length > 0
    ? active.map(p => ({ key: p.id, partnerId: p.id, name: p.name, kind: p.kind, shareBasisPoints: p.shareBasisPoints }))
    : [{ key: 'ondernemer', partnerId: null, name: inputs.companyName?.trim() ? `Ondernemer (${inputs.companyName.trim()})` : 'Ondernemer', kind: 'ondernemer', shareBasisPoints: null }];

  if (inputs.isPartnershipForm && active.length === 0) {
    warnings.push('Er zijn nog geen vennoten vastgelegd. Deze raming rekent alsof één persoon de hele winst heeft; leg de vennoten en hun winstaandeel vast bij Vennoten.');
  }
  const shareTotal = active.reduce((sum, p) => sum + p.shareBasisPoints, 0);
  if (active.length > 0 && shareTotal !== 10000) {
    warnings.push(`De winstverdeling van de vennoten telt op tot ${(shareTotal / 100).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}% in plaats van 100%. Pas de verdeling aan bij Vennoten; tot dan klopt deze raming niet.`);
  }

  const shares: IbShare[] = people.map(p => ({ key: p.key, basisPoints: p.shareBasisPoints ?? 10000, order: active.find(a => a.id === p.partnerId)?.partnerNumber ?? 0 }));
  const split = (amount: number) => (people.length === 1 && people[0].partnerId === null)
    ? new Map([[people[0].key, Math.trunc(amount)]])
    : splitByShares(amount, shares);

  const profitShares = split(usedResultCents);
  const kiaShares = split(kiaCents);
  // Eten, drinken en representatie op 4600: het niet-aftrekbare deel telt
  // ResoFly zelf mee, voor de hele onderneming (bij een vof naar winstaandeel).
  const mixedTotal = Math.max(0, Math.trunc(inputs.mixedCostsCents ?? 0));
  const mixedCosts = mixedTotal > 0
    ? { totalCents: mixedTotal, ...mixedCostsAddBack(rules, mixedTotal), thresholdCents: rules.mixedCostsThresholdCents }
    : null;
  const automatic = mixedCosts && mixedCosts.addBackCents > 0 ? [{
    id: 'gemengde-kosten-4600', partnerId: null, code: 'gemengde_kosten' as IbCorrectionCode,
    label: mixedCosts.method === 'percentage'
      ? `Eten, drinken en representatie: 20% van ${euroText(mixedCosts.totalCents)}`
      : `Eten, drinken en representatie: tot de drempel van ${euroText(mixedCosts.thresholdCents)}`,
    amountCents: mixedCosts.addBackCents, automatic: true,
  }] : [];
  const sharedCorrections = [
    ...automatic,
    ...inputs.corrections.filter(c => c.partnerId === null).map(c => ({ ...c, automatic: false })),
  ];
  const sharedSplits = sharedCorrections.map(c => ({ correction: c, parts: split(c.amountCents) }));
  const knownKeys = new Set(people.map(p => p.partnerId).filter((id): id is string => id !== null));
  const orphaned = inputs.corrections.filter(c => c.partnerId !== null && !knownKeys.has(c.partnerId));
  if (orphaned.length > 0) {
    warnings.push(`${orphaned.length === 1 ? 'Eén correctie staat' : `${orphaned.length} correcties staan`} op een vennoot die niet (meer) meedoet in de verdeling en ${orphaned.length === 1 ? 'telt' : 'tellen'} niet mee.`);
  }

  // Zonder opgeslagen gegevens volgt het urencriterium de geregistreerde uren:
  // bij een eenmanszaak die van de eigenaar (zoals Eigen vermogen), bij een vof
  // die van het teamlid dat de vennoot is (zoals Vennoten). Zo tonen de
  // schermen hetzelfde, tot je zelf iets kiest.
  const ownerMinutes = inputs.isPartnershipForm ? null : (inputs.ownerMinutes ?? null);
  const partnerMinutes = inputs.isPartnershipForm ? (inputs.partnerMinutes ?? null) : null;
  const minutesOf = (who: Who): number | null => {
    if (who.kind === 'commanditair') return null;
    if (who.partnerId === null) return ownerMinutes;
    const minutes = partnerMinutes?.[who.partnerId];
    return typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : null;
  };

  const persons: IncomeTaxPerson[] = people.map(who => {
    const saved = profileFor(who.partnerId);
    const registeredMinutes = minutesOf(who);
    // Het urencriterium volgt de uren zolang er geen eigen keuze is opgeslagen
    // (null), ook als de rest van het profiel wel is opgeslagen. Eerder volgde
    // het de uren alleen zonder opgeslagen profiel: wie in maart alleen zijn
    // voorlopige aanslag invulde, legde daarmee "nee" vast, en hield in
    // november met 1.400 uur nog steeds geen zelfstandigenaftrek.
    const stored = saved ?? defaultIncomeTaxProfile(who.partnerId);
    const hoursFromTimeTracking = stored.meetsHoursCriterion === null && registeredMinutes !== null;
    const projectedMinutes = hoursFromTimeTracking && registeredMinutes !== null && basis === 'prognose' && projection
      ? mulDiv(Math.max(0, Math.trunc(registeredMinutes)), projection.totalDays, projection.elapsedDays)
      : null;
    const profile: IncomeTaxProfile = hoursFromTimeTracking && registeredMinutes !== null
      ? { ...stored, meetsHoursCriterion: (projectedMinutes ?? registeredMinutes) >= HOURS_CRITERION_MINUTES }
      : stored;
    const corrections: IncomeTaxPerson['corrections'] = [
      ...sharedSplits.map(({ correction, parts }) => ({
        id: correction.id, code: correction.code, label: correction.label, amountCents: parts.get(who.key) ?? 0,
        shared: people.length > 1, automatic: correction.automatic,
      })),
      ...inputs.corrections.filter(c => c.partnerId !== null && c.partnerId === who.partnerId)
        .map(c => ({ id: c.id, code: c.code, label: c.label, amountCents: c.amountCents, shared: false, automatic: false })),
    ];
    const isEntrepreneur = who.kind !== 'commanditair';
    const estimate = estimatePerson(rules, {
      profitShareCents: profitShares.get(who.key) ?? 0,
      correctionsCents: corrections.reduce((sum, c) => sum + c.amountCents, 0),
      kiaCents: kiaShares.get(who.key) ?? 0,
      isEntrepreneur,
      meetsHoursCriterion: isEntrepreneur ? profile.meetsHoursCriterion : false,
      starter: isEntrepreneur && profile.starter,
      aowStatus: profile.aowStatus,
      aowMonth: profile.aowMonth,
      otherEntrepreneurDeductionCents: profile.otherEntrepreneurDeductionCents,
      lossCarryForwardCents: profile.lossCarryForwardCents,
      provisionalIncomeTaxCents: profile.provisionalIncomeTaxCents,
      provisionalZvwCents: profile.provisionalZvwCents,
    });
    return {
      key: who.key,
      partnerId: who.partnerId,
      name: who.name,
      kind: who.kind,
      shareBasisPoints: who.shareBasisPoints,
      profile,
      profileSaved: saved !== null,
      corrections,
      hoursFromTimeTracking,
      registeredMinutes,
      projectedMinutes,
      estimate,
      notes: personNotes(rules, { kind: who.kind, profile, estimate, hoursFromTimeTracking, registeredMinutes, projectedMinutes, investmentTotalCents }),
    };
  });

  // Boekjaren: is de winst al definitief, en loopt het boekjaar gelijk met het
  // kalenderjaar? De inkomstenbelasting rekent per kalenderjaar.
  const yearStart = `${inputs.year}-01-01`;
  const yearEnd = `${inputs.year}-12-31`;
  // Alleen een boekjaar dat óver de jaargrens loopt. Een kort eerste boekjaar
  // (1 juli t/m 31 december) valt binnen het kalenderjaar en kreeg deze
  // waarschuwing ook, terwijl daar iets anders speelt: zie hieronder.
  if (inputs.overlappingFiscalYears.some(fy => fy.periodStart.slice(0, 10) < yearStart || fy.periodEnd.slice(0, 10) > yearEnd)) {
    warnings.push(`Je boekjaar loopt niet gelijk met het kalenderjaar. De inkomstenbelasting rekent met de winst per kalenderjaar; deze raming telt de boekingen van 1 januari tot en met 31 december ${inputs.year}.`);
  }
  // Begon de boekhouding in ResoFly in de loop van dit jaar, dan kent ResoFly
  // de winst van daarvóór niet (die zit hooguit in de beginbalans). Wie op
  // 1 juli overstapte, zag "Winst 2026" over een half jaar, met de kortingen
  // van een heel jaar: een raming die duizenden euro's te laag kon zijn,
  // zonder één woord erbij.
  const startDate = inputs.bookkeepingStartDate ? inputs.bookkeepingStartDate.slice(0, 10) : null;
  if (startDate && startDate > yearStart && startDate <= yearEnd) {
    const [, startMonth, startDay] = startDate.split('-').map(Number);
    warnings.push(`Je boekhouding in ResoFly begint op ${startDay} ${MONTHS[startMonth - 1]} ${inputs.year}: deze raming telt de winst vanaf die dag. Had je eerder in ${inputs.year} al winst uit deze onderneming, tel die er dan bij onder Fiscale correcties (soort "Overige correctie"). Anders valt de raming te laag uit.`);
  }

  const totals = persons.reduce((t, p) => ({
    incomeTaxCents: t.incomeTaxCents + p.estimate.incomeTaxCents,
    zvwCents: t.zvwCents + p.estimate.zvwCents,
    totalCents: t.totalCents + p.estimate.totalCents,
    provisionalCents: t.provisionalCents + p.estimate.provisionalIncomeTaxCents + p.estimate.provisionalZvwCents,
    balanceCents: t.balanceCents + p.estimate.balanceCents,
  }), { incomeTaxCents: 0, zvwCents: 0, totalCents: 0, provisionalCents: 0, balanceCents: 0 });

  return {
    year: inputs.year,
    rulesYear: rules.year,
    rulesExact: exact,
    basis,
    resultCents: Math.trunc(inputs.resultCents),
    projection,
    usedResultCents,
    investments,
    investmentTotalCents,
    kiaCents,
    mixedCosts,
    ownerMinutes,
    persons,
    warnings,
    totals,
    disclaimer: IB_DISCLAIMER,
  };
}
