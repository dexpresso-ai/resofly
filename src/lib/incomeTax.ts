/**
 * Van winst volgens de boekhouding naar belastbare winst uit onderneming: de
 * stappen die een eenmanszaak in de aangifte inkomstenbelasting zet.
 *
 * Waarom dit bestaat: ResoFly gaf de winst en de kapitaalvergelijking, maar
 * niet wat er tussen winst en aangifte gebeurt. Een zzp'er moest zelf weten
 * dat eten, drinken en representatie maar beperkt aftrekbaar zijn, hoe hoog de
 * zelfstandigenaftrek dit jaar is (die daalt elk jaar), en dat de
 * mkb-winstvrijstelling ná de ondernemersaftrek komt.
 *
 * Een indicatie, geen aangifte: de investeringsaftrek (KIA), de bijtelling voor
 * privégebruik van een auto, de desinvesteringsbijtelling, de meewerkaftrek en
 * de halve zelfstandigenaftrek vanaf de AOW-leeftijd rekent dit niet uit. Het
 * scherm zegt dat erbij.
 *
 * Bedragen per jaar (Belastingdienst; nagelopen op 18 november 2026 via
 * bronnen die de Belastingdienst citeren):
 * - zelfstandigenaftrek: 2025 € 2.470, 2026 € 1.200;
 * - startersaftrek: € 2.123;
 * - mkb-winstvrijstelling: 12,70% (2025 en 2026);
 * - gemengde kosten (eten, drinken, representatie, congressen), art. 3.15
 *   Wet IB 2001: niet aftrekbaar tot de drempel van € 5.700 (2025 en 2026),
 *   of naar keuze 20% van het totaal niet aftrekbaar.
 * Andere jaren staan er bewust niet in: liever geen bedrag dan een verkeerd
 * bedrag. Voeg een jaar toe zodra de bedragen vaststaan.
 */

export interface IncomeTaxYearRules {
  year: number;
  selfEmployedDeductionCents: number;
  starterDeductionCents: number;
  /** Mkb-winstvrijstelling in basispunten (1270 = 12,70%). */
  smeExemptionBasisPoints: number;
  /** Drempel voor gemengde kosten. */
  mixedCostsThresholdCents: number;
}

export const INCOME_TAX_RULES: Readonly<Record<number, IncomeTaxYearRules>> = {
  2025: { year: 2025, selfEmployedDeductionCents: 247_000, starterDeductionCents: 212_300, smeExemptionBasisPoints: 1270, mixedCostsThresholdCents: 570_000 },
  2026: { year: 2026, selfEmployedDeductionCents: 120_000, starterDeductionCents: 212_300, smeExemptionBasisPoints: 1270, mixedCostsThresholdCents: 570_000 },
};

export function incomeTaxRules(year: number): IncomeTaxYearRules | null {
  return INCOME_TAX_RULES[year] ?? null;
}

/**
 * Het niet-aftrekbare deel van de gemengde kosten: de gunstigste van de twee
 * methoden (de ondernemer kiest per jaar).
 */
export function mixedCostsAddBack(totalCents: number, thresholdCents: number): { addBackCents: number; method: 'percentage' | 'threshold' } {
  const total = Math.max(0, totalCents);
  const percentage = Math.round(total * 0.2);
  const threshold = Math.min(total, thresholdCents);
  return percentage <= threshold
    ? { addBackCents: percentage, method: 'percentage' }
    : { addBackCents: threshold, method: 'threshold' };
}

export interface BusinessProfitInput {
  year: number;
  /** Winst volgens de boekhouding (W&V), in centen; negatief is verlies. */
  profitCents: number;
  /** Kosten op rekeningen voor eten, drinken en representatie. */
  mixedCostsCents: number;
  /** Urencriterium gehaald (1225 uur en meer dan de helft van je werktijd). */
  hoursCriterionMet: boolean;
  /** Starter: in een of meer van de vijf jaren ervoor geen ondernemer, en hooguit twee keer startersaftrek gehad. */
  starter: boolean;
}

export interface BusinessProfit {
  rules: IncomeTaxYearRules;
  profitCents: number;
  mixedCosts: { totalCents: number; addBackCents: number; method: 'percentage' | 'threshold' };
  /** Winst plus het niet-aftrekbare deel van de gemengde kosten. */
  fiscalProfitCents: number;
  selfEmployedDeductionCents: number;
  /** Beperkt tot de winst (niet voor starters). */
  selfEmployedCapped: boolean;
  starterDeductionCents: number;
  entrepreneurDeductionCents: number;
  smeExemptionCents: number;
  taxableProfitCents: number;
}

/** Null als de bedragen van dat jaar er niet in staan (zie INCOME_TAX_RULES). */
export function businessProfit(input: BusinessProfitInput): BusinessProfit | null {
  const rules = incomeTaxRules(input.year);
  if (!rules) return null;
  const mixed = mixedCostsAddBack(input.mixedCostsCents, rules.mixedCostsThresholdCents);
  const fiscalProfitCents = input.profitCents + mixed.addBackCents;

  // Zelfstandigenaftrek: alleen met het urencriterium. Niet hoger dan de winst
  // (het restant schuift door naar volgende jaren), behalve voor een starter.
  let selfEmployed = input.hoursCriterionMet ? rules.selfEmployedDeductionCents : 0;
  let capped = false;
  if (selfEmployed > 0 && !input.starter && selfEmployed > Math.max(0, fiscalProfitCents)) {
    selfEmployed = Math.max(0, fiscalProfitCents);
    capped = true;
  }
  // Startersaftrek: bovenop de zelfstandigenaftrek, dus ook met het urencriterium.
  const starterDeduction = input.hoursCriterionMet && input.starter ? rules.starterDeductionCents : 0;
  const entrepreneurDeductionCents = selfEmployed + starterDeduction;

  // Mkb-winstvrijstelling: over de winst ná ondernemersaftrek; bij een verlies
  // maakt hij dat verlies kleiner (dan is hij negatief).
  const afterDeduction = fiscalProfitCents - entrepreneurDeductionCents;
  const smeExemptionCents = Math.round((afterDeduction * rules.smeExemptionBasisPoints) / 10_000);
  return {
    rules,
    profitCents: input.profitCents,
    mixedCosts: { totalCents: Math.max(0, input.mixedCostsCents), ...mixed },
    fiscalProfitCents,
    selfEmployedDeductionCents: selfEmployed,
    selfEmployedCapped: capped,
    starterDeductionCents: starterDeduction,
    entrepreneurDeductionCents,
    smeExemptionCents,
    taxableProfitCents: afterDeduction - smeExemptionCents,
  };
}
