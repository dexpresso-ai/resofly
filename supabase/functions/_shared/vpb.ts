/**
 * Vennootschapsbelasting — rekenhart.
 *
 * Puur rekenwerk: geen database, geen netwerk, geen datums-van-nu. Alles gaat
 * erin als argument en komt eruit als resultaat, zodat het te testen is
 * (vpb.test.ts) en zowel de edge function als een RPC-wrapper hem kan gebruiken.
 * Zelfde vorm als dunning.ts: bedragen in hele centen (integer), percentages in
 * basispunten (1900 = 19,00%), zodat er nergens een float in een geldbedrag komt.
 *
 * WETTELIJKE GRONDSLAG
 * ────────────────────
 * Tarief — art. 22 Wet Vpb 1969. Let op: dat is GEEN paar van twee tarieven maar
 * een tabel met vier kolommen (ondergrens, bovengrens, basisbedrag, percentage),
 * en hij is uitdrukkelijk CUMULATIEF: "de belasting [is] het in kolom III
 * vermelde bedrag, vermeerderd met het bedrag dat wordt berekend door het in
 * kolom IV vermelde percentage te nemen van het gedeelte van het belastbare
 * bedrag dat het in kolom I vermelde bedrag te boven gaat". Wie dit als een
 * cliff bouwt (heel bedrag tegen het hoge tarief zodra de grens is gepasseerd)
 * rekent op € 300.000 in 2026 € 13.600 te veel.
 *
 * Verliesverrekening — art. 20 Wet Vpb 1969, tekst zoals die geldt sinds
 * 1-1-2022: één jaar achterwaarts, onbeperkt voorwaarts, maar per jaar hooguit
 * een drempelbedrag plus een percentage van de winst dáárboven.
 *
 * Afronding — het belastbare bedrag wordt naar beneden afgerond op hele
 * veelvouden van € 5. Voor de berekende belasting zelf is geen afrondingsregel
 * gevonden; die laten we op de cent staan.
 *
 * WAT DIT BESTAND BEWUST NIET DOET
 * ────────────────────────────────
 * - Geen innovatiebox. Dat is geen tarief maar een grondslagvermindering
 *   (art. 12b: het voordeel telt voor 9/H mee, waarbij H het hoogste
 *   art. 22-percentage is). Wie 9% als tarief hardcodeert zit er in de lage
 *   schijf naast. Komt terug als er een aparte grondslagpost voor is.
 * - Geen fiscale eenheid, geen deelnemingsvrijstelling, geen buitenlandse
 *   winst. Die horen bij het consolidatietraject.
 * - Geen art. 20a (verliesverdamping bij belangenwijziging): dat is een
 *   beoordeling van feiten, geen som.
 *
 * Dit is een hulpmiddel, geen aangifte en geen advies.
 */

/** Eén regel uit de tarieftabel van art. 22 Wet Vpb 1969. */
export interface VpbBracket {
  /** Kolom I — bedrag waarboven deze regel geldt, in centen. De eerste regel heeft 0. */
  lowerBoundCents: number;
  /** Kolom III — vast basisbedrag in centen dat al over de schijven eronder is berekend. */
  baseAmountCents: number;
  /** Kolom IV — percentage in basispunten over het deel bóven lowerBoundCents. */
  rateBasisPoints: number;
}

/** De regels die voor één boekjaar gelden. */
export interface VpbYearRules {
  year: number;
  /** Oplopend op lowerBoundCents; minimaal één regel die op 0 begint. */
  brackets: VpbBracket[];
  /** Art. 20 lid 2: bedrag dat altijd volledig verrekend mag worden, in centen. */
  lossReliefThresholdCents: number;
  /** Art. 20 lid 2: percentage (basispunten) van de winst bóven de drempel. */
  lossReliefRateBasisPoints: number;
}

/** Een nog te verrekenen verlies uit een eerder jaar. */
export interface LossCarryForward {
  year: number;
  /** Positief bedrag in centen: wat er nog openstaat. */
  remainingCents: number;
}

export interface VpbCorrection {
  code: string;
  label: string;
  /** Positief verhoogt de fiscale winst (niet-aftrekbare kosten), negatief verlaagt hem. */
  amountCents: number;
}

export interface VpbInput {
  rules: VpbYearRules;
  /** Commercieel resultaat vóór belasting, in centen. Verlies is negatief. */
  commercialResultCents: number;
  corrections: VpbCorrection[];
  /** Openstaande verliezen uit eerdere jaren. Volgorde maakt niet uit; oudste wordt eerst gebruikt. */
  lossesCarriedForward: LossCarryForward[];
  /** Al betaalde voorlopige aanslagen over dit jaar, in centen. */
  prepaidCents?: number;
}

export interface VpbLossUsage {
  year: number;
  usedCents: number;
}

export interface VpbResult {
  commercialResultCents: number;
  totalCorrectionsCents: number;
  /** Commercieel resultaat + correcties: de winst vóór verliesverrekening. */
  fiscalProfitCents: number;
  /** Hoeveel verlies dit jaar hoogstens verrekend mocht worden (art. 20 lid 2). */
  lossReliefCapCents: number;
  lossesUsed: VpbLossUsage[];
  totalLossUsedCents: number;
  /** Fiscale winst minus het verrekende verlies, vóór afronding. Nooit negatief. */
  taxableBeforeRoundingCents: number;
  /** Belastbaar bedrag, naar beneden afgerond op hele veelvouden van € 5. */
  taxableAmountCents: number;
  taxCents: number;
  prepaidCents: number;
  /** Positief = nog te betalen, negatief = terug te ontvangen. */
  balanceDueCents: number;
  /** Wat er ná dit jaar nog aan verlies openstaat, inclusief een verlies van dit jaar zelf. */
  lossesRemaining: LossCarryForward[];
  /** Gemiddeld tarief in basispunten over het belastbare bedrag; 0 bij een belastbaar bedrag van 0. */
  effectiveRateBasisPoints: number;
}

/** Deelt af en rondt rekenkundig af, zodat er geen halve centen ontstaan. */
function applyRate(amountCents: number, basisPoints: number): number {
  return Math.round((amountCents * basisPoints) / 10000);
}

/**
 * Belasting over een belastbaar bedrag volgens de cumulatieve tabel van
 * art. 22. Pakt de hoogste regel waarvan de ondergrens is gepasseerd.
 */
export function taxForAmount(taxableAmountCents: number, brackets: VpbBracket[]): number {
  if (taxableAmountCents <= 0) return 0;
  if (brackets.length === 0) {
    throw new Error('Geen tariefschijven bekend voor dit boekjaar.');
  }

  const ordered = [...brackets].sort((a, b) => a.lowerBoundCents - b.lowerBoundCents);
  if (ordered[0].lowerBoundCents !== 0) {
    throw new Error('De tarieftabel begint niet bij 0; de eerste schijf is onvolledig.');
  }

  let row = ordered[0];
  for (const candidate of ordered) {
    if (taxableAmountCents > candidate.lowerBoundCents) row = candidate;
  }

  return row.baseAmountCents + applyRate(taxableAmountCents - row.lowerBoundCents, row.rateBasisPoints);
}

/**
 * Het belastbare bedrag wordt naar beneden afgerond op hele veelvouden van € 5
 * (500 cent). Naar beneden ook bij een negatief bedrag zou verkeerd zijn — daar
 * komen we niet, want het belastbare bedrag is nooit negatief.
 */
export function roundTaxableAmount(amountCents: number): number {
  if (amountCents <= 0) return 0;
  return Math.floor(amountCents / 500) * 500;
}

/**
 * Hoeveel verlies mag er dit jaar hoogstens verrekend worden?
 * Art. 20 lid 2: het drempelbedrag volledig, plus een percentage van de winst
 * die daar bovenuit komt. Bij een winst onder de drempel is de winst zelf de
 * bovengrens — je kunt nooit meer verrekenen dan er winst is.
 */
export function lossReliefCap(fiscalProfitCents: number, rules: VpbYearRules): number {
  if (fiscalProfitCents <= 0) return 0;
  if (fiscalProfitCents <= rules.lossReliefThresholdCents) return fiscalProfitCents;
  const above = fiscalProfitCents - rules.lossReliefThresholdCents;
  return rules.lossReliefThresholdCents + applyRate(above, rules.lossReliefRateBasisPoints);
}

/**
 * De volledige som: commercieel resultaat → fiscale correcties →
 * verliesverrekening → belastbaar bedrag → belasting → nog te betalen.
 */
export function computeVpb(input: VpbInput): VpbResult {
  const { rules } = input;
  const prepaidCents = input.prepaidCents ?? 0;

  const totalCorrectionsCents = input.corrections.reduce((sum, c) => sum + c.amountCents, 0);
  const fiscalProfitCents = input.commercialResultCents + totalCorrectionsCents;

  // Oudste verlies eerst: dat is de volgorde die de wet aanhoudt en het is ook
  // in het voordeel van de belastingplichtige, want een ouder verlies is
  // kwetsbaarder voor latere beperkingen.
  const openLosses = input.lossesCarriedForward
    .filter((l) => l.remainingCents > 0)
    .sort((a, b) => a.year - b.year)
    .map((l) => ({ ...l }));

  const lossReliefCapCents = lossReliefCap(fiscalProfitCents, rules);

  const lossesUsed: VpbLossUsage[] = [];
  let budget = lossReliefCapCents;
  for (const loss of openLosses) {
    if (budget <= 0) break;
    const used = Math.min(budget, loss.remainingCents);
    if (used > 0) {
      lossesUsed.push({ year: loss.year, usedCents: used });
      loss.remainingCents -= used;
      budget -= used;
    }
  }
  const totalLossUsedCents = lossesUsed.reduce((sum, l) => sum + l.usedCents, 0);

  const taxableBeforeRoundingCents = Math.max(0, fiscalProfitCents - totalLossUsedCents);
  const taxableAmountCents = roundTaxableAmount(taxableBeforeRoundingCents);
  const taxCents = taxForAmount(taxableAmountCents, rules.brackets);

  // Een verlies van dít jaar schuift door naar volgend jaar. Verliezen die nog
  // openstonden en niet gebruikt zijn, blijven onbeperkt staan.
  const lossesRemaining = openLosses.filter((l) => l.remainingCents > 0);
  if (fiscalProfitCents < 0) {
    lossesRemaining.push({ year: rules.year, remainingCents: -fiscalProfitCents });
  }
  lossesRemaining.sort((a, b) => a.year - b.year);

  return {
    commercialResultCents: input.commercialResultCents,
    totalCorrectionsCents,
    fiscalProfitCents,
    lossReliefCapCents,
    lossesUsed,
    totalLossUsedCents,
    taxableBeforeRoundingCents,
    taxableAmountCents,
    taxCents,
    prepaidCents,
    balanceDueCents: taxCents - prepaidCents,
    lossesRemaining,
    effectiveRateBasisPoints:
      taxableAmountCents > 0 ? Math.round((taxCents * 10000) / taxableAmountCents) : 0,
  };
}
