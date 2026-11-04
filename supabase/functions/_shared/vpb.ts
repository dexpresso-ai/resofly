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
 * Achterwaartse verliesverrekening (carry back) — art. 20 lid 2: "Het verlies
 * van een jaar wordt verrekend met de belastbare winsten van het voorafgaande
 * jaar en de volgende jaren". Eerst achterwaarts, dan pas voorwaarts; dat is de
 * volgorde van de wet en geen keuze. De ruimte in het voorafgaande jaar is de
 * bovengrens van dát jaar (€ 1.000.000 plus 50% van de winst daarboven), min
 * wat dat jaar al aan oudere verliezen voorwaarts verrekende — Kennisgroep
 * KG:011:2023:14. Het recht op verrekening volgt de wettekst van het
 * VERLIESJAAR; daarom komen drempel en percentage uit de regels van het
 * verliesjaar, ook als het voorafgaande jaar zelf (2021) nog geen beperking
 * kende. De teruggaaf is het verschil tussen de belasting van het voorafgaande
 * jaar vóór en ná de verrekening, tegen het tarief van dát jaar.
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

/**
 * De vastgestelde berekening van het voorafgaande boekjaar: daarmee wordt een
 * verlies van dit jaar als eerste verrekend (art. 20 lid 2 Wet Vpb).
 */
export interface VpbCarryBackBasis {
  /** Jaar van het voorafgaande boekjaar (het aanvangsjaar). */
  year: number;
  /** Fiscale winst van dat jaar vóór verliesverrekening, in centen. */
  fiscalProfitCents: number;
  /** Wat dat jaar al aan oudere verliezen voorwaarts verrekende, in centen. */
  lossUsedCents: number;
  /** Het vastgestelde belastbare bedrag van dat jaar, in centen. */
  taxableAmountCents: number;
  /** De vastgestelde belasting van dat jaar, in centen. */
  taxCents: number;
  /** De tarieftabel (art. 22) van dát jaar. */
  brackets: VpbBracket[];
}

/** Uitkomst van de achterwaartse verliesverrekening met het voorafgaande jaar. */
export interface VpbCarryBack {
  /** Het jaar waarmee is verrekend. */
  year: number;
  /** Bovengrens van art. 20 lid 2 over de winst van dat jaar, met de regels van het verliesjaar. */
  capCents: number;
  /** De bovengrens min wat dat jaar al voorwaarts verrekende. */
  roomCents: number;
  /** Verlies van dit jaar dat achterwaarts is verrekend. */
  usedCents: number;
  taxableBeforeCents: number;
  taxableAfterCents: number;
  taxBeforeCents: number;
  taxAfterCents: number;
  /** Terug te ontvangen vennootschapsbelasting over dat jaar. */
  refundCents: number;
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
  /**
   * De vastgestelde berekening van het voorafgaande boekjaar. Alleen gebruikt
   * bij een verlies; ontbreekt hij, dan schuift het hele verlies door.
   */
  carryBackBasis?: VpbCarryBackBasis | null;
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
  /**
   * Wat er ná dit jaar nog aan verlies openstaat, inclusief een verlies van dit
   * jaar zelf — dat laatste ná de achterwaartse verrekening.
   */
  lossesRemaining: LossCarryForward[];
  /** Gemiddeld tarief in basispunten over het belastbare bedrag; 0 bij een belastbaar bedrag van 0. */
  effectiveRateBasisPoints: number;
  /**
   * Achterwaartse verliesverrekening met het voorafgaande jaar. Alleen bij een
   * verlies én een vastgestelde berekening van het voorafgaande jaar; anders null.
   */
  carryBack: VpbCarryBack | null;
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
 * Achterwaartse verliesverrekening (art. 20 lid 2 Wet Vpb): het verlies van
 * dit jaar met de winst van het voorafgaande jaar.
 *
 * - De bovengrens is die van art. 20 lid 2 over de winst van het voorafgaande
 *   jaar, met de drempel en het percentage van het VERLIESJAAR (het recht op
 *   verrekening volgt de wettekst van het verliesjaar, KG:011:2023:14).
 * - Wat dat jaar al voorwaarts verrekende gaat van die ruimte af
 *   (KG:011:2023:14: de ruimte voor 2021 wordt beperkt door de eerdere
 *   voorwaartse verrekening).
 * - De teruggaaf rekent met de tarieftabel van het voorafgaande jaar en het
 *   naar beneden op € 5 afgeronde nieuwe belastbare bedrag.
 */
export function computeCarryBack(
  lossCents: number,
  basis: VpbCarryBackBasis,
  lossYearRules: VpbYearRules,
): VpbCarryBack {
  const capCents = lossReliefCap(basis.fiscalProfitCents, lossYearRules);
  const roomCents = Math.max(0, capCents - Math.max(0, basis.lossUsedCents));
  const usedCents = Math.max(0, Math.min(lossCents, roomCents));

  const taxableBeforeCents = basis.taxableAmountCents;
  const taxBeforeCents = basis.taxCents;
  const taxableAfterCents = usedCents > 0
    ? roundTaxableAmount(Math.max(0, basis.fiscalProfitCents - Math.max(0, basis.lossUsedCents) - usedCents))
    : taxableBeforeCents;
  const taxAfterCents = usedCents > 0 ? taxForAmount(taxableAfterCents, basis.brackets) : taxBeforeCents;

  return {
    year: basis.year,
    capCents,
    roomCents,
    usedCents,
    taxableBeforeCents,
    taxableAfterCents,
    taxBeforeCents,
    taxAfterCents,
    refundCents: Math.max(0, taxBeforeCents - taxAfterCents),
  };
}

/**
 * De volledige som: commercieel resultaat → fiscale correcties →
 * verliesverrekening → belastbaar bedrag → belasting → nog te betalen.
 * Bij een verlies eerst achterwaarts verrekenen met het voorafgaande jaar; wat
 * overblijft schuift door.
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

  // Een verlies van dít jaar gaat eerst terug naar het voorafgaande jaar (art. 20
  // lid 2); wat daar niet past schuift door naar volgende jaren. Verliezen die
  // nog openstonden en niet gebruikt zijn, blijven onbeperkt staan.
  const carryBack = fiscalProfitCents < 0 && input.carryBackBasis
    ? computeCarryBack(-fiscalProfitCents, input.carryBackBasis, rules)
    : null;
  const lossesRemaining = openLosses.filter((l) => l.remainingCents > 0);
  if (fiscalProfitCents < 0) {
    const forward = -fiscalProfitCents - (carryBack?.usedCents ?? 0);
    if (forward > 0) lossesRemaining.push({ year: rules.year, remainingCents: forward });
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
    carryBack,
  };
}
