/**
 * Tests voor het Vpb-rekenhart. Draaien met:  npm test
 *
 * Node 24 leest TypeScript rechtstreeks, dus er is geen bouwstap en geen
 * testframework nodig — alleen de ingebouwde runner (node:test).
 *
 * De cijfers in deze tests komen uit de wettekst en de tarieftabellen van de
 * Belastingdienst, niet uit de implementatie. Ze zijn dus een controle op de
 * code, niet een afdruk ervan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeVpb,
  lossReliefCap,
  roundTaxableAmount,
  taxForAmount,
  type VpbYearRules,
} from './vpb.ts';

const EUR = (euros: number) => Math.round(euros * 100);

/** Art. 22 Wet Vpb 1969 zoals die geldt voor 2023 t/m 2026. */
const RULES_2026: VpbYearRules = {
  year: 2026,
  brackets: [
    { lowerBoundCents: 0, baseAmountCents: 0, rateBasisPoints: 1900 },
    { lowerBoundCents: EUR(200_000), baseAmountCents: EUR(38_000), rateBasisPoints: 2580 },
  ],
  lossReliefThresholdCents: EUR(1_000_000),
  lossReliefRateBasisPoints: 5000,
};

/** 2022: lage tarief 15% tot € 395.000, daarboven € 59.250 + 25,8%. */
const RULES_2022: VpbYearRules = {
  year: 2022,
  brackets: [
    { lowerBoundCents: 0, baseAmountCents: 0, rateBasisPoints: 1500 },
    { lowerBoundCents: EUR(395_000), baseAmountCents: EUR(59_250), rateBasisPoints: 2580 },
  ],
  lossReliefThresholdCents: EUR(1_000_000),
  lossReliefRateBasisPoints: 5000,
};

// ── Tarief ─────────────────────────────────────────────────────────────────

test('tarief is cumulatief, geen cliff — het ijkpunt uit art. 22', () => {
  // € 38.000 + 25,8% × € 100.000 = € 63.800. Een cliff zou € 77.400 geven.
  assert.equal(taxForAmount(EUR(300_000), RULES_2026.brackets), EUR(63_800));
});

test('precies op de schijfgrens geldt nog het lage tarief', () => {
  // 19% × € 200.000 = € 38.000, en dat is ook exact het basisbedrag van schijf 2.
  assert.equal(taxForAmount(EUR(200_000), RULES_2026.brackets), EUR(38_000));
});

test('één cent boven de grens kost slechts één cent extra tegen het hoge tarief', () => {
  const atThreshold = taxForAmount(EUR(200_000), RULES_2026.brackets);
  const justAbove = taxForAmount(EUR(200_000) + 100, RULES_2026.brackets);
  assert.equal(justAbove - atThreshold, 26); // 25,8% van 100 cent, afgerond
});

test('winst binnen de eerste schijf', () => {
  assert.equal(taxForAmount(EUR(50_000), RULES_2026.brackets), EUR(9_500));
});

test('nul en negatief leveren geen belasting op', () => {
  assert.equal(taxForAmount(0, RULES_2026.brackets), 0);
  assert.equal(taxForAmount(-EUR(10_000), RULES_2026.brackets), 0);
});

test('2022 had een andere grens en een ander laag tarief', () => {
  assert.equal(taxForAmount(EUR(395_000), RULES_2022.brackets), EUR(59_250));
  // € 59.250 + 25,8% × € 5.000 = € 60.540
  assert.equal(taxForAmount(EUR(400_000), RULES_2022.brackets), EUR(60_540));
});

test('een tabel die niet bij 0 begint is een fout, geen stille aanname', () => {
  assert.throws(
    () => taxForAmount(EUR(1_000), [{ lowerBoundCents: EUR(100), baseAmountCents: 0, rateBasisPoints: 1900 }]),
    /begint niet bij 0/,
  );
  assert.throws(() => taxForAmount(EUR(1_000), []), /Geen tariefschijven/);
});

// ── Afronding ──────────────────────────────────────────────────────────────

test('belastbaar bedrag gaat naar beneden op veelvouden van € 5', () => {
  assert.equal(roundTaxableAmount(EUR(1_004)), EUR(1_000));
  assert.equal(roundTaxableAmount(EUR(1_005)), EUR(1_005));
  assert.equal(roundTaxableAmount(EUR(1_009.99)), EUR(1_005));
  assert.equal(roundTaxableAmount(499), 0);
  assert.equal(roundTaxableAmount(0), 0);
  assert.equal(roundTaxableAmount(-EUR(100)), 0);
});

// ── Verliesverrekening ─────────────────────────────────────────────────────

test('onder de drempel mag alle winst worden weggestreept', () => {
  assert.equal(lossReliefCap(EUR(400_000), RULES_2026), EUR(400_000));
  assert.equal(lossReliefCap(EUR(1_000_000), RULES_2026), EUR(1_000_000));
});

test('boven de drempel: € 1 mln plus de helft van de rest', () => {
  // Winst € 3 mln → € 1.000.000 + 50% × € 2.000.000 = € 2.000.000
  assert.equal(lossReliefCap(EUR(3_000_000), RULES_2026), EUR(2_000_000));
});

test('bij verlies of nul valt er niets te verrekenen', () => {
  assert.equal(lossReliefCap(0, RULES_2026), 0);
  assert.equal(lossReliefCap(-EUR(50_000), RULES_2026), 0);
});

test('het uitgewerkte voorbeeld uit de wettoelichting', () => {
  // € 5 mln aan verliezen, winst € 3 mln in 2026.
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: EUR(3_000_000),
    corrections: [],
    lossesCarriedForward: [{ year: 2023, remainingCents: EUR(5_000_000) }],
  });
  assert.equal(r.lossReliefCapCents, EUR(2_000_000));
  assert.equal(r.totalLossUsedCents, EUR(2_000_000));
  assert.equal(r.taxableAmountCents, EUR(1_000_000));
  // € 38.000 + 25,8% × € 800.000 = € 38.000 + € 206.400 = € 244.400
  assert.equal(r.taxCents, EUR(244_400));
  assert.deepEqual(r.lossesRemaining, [{ year: 2023, remainingCents: EUR(3_000_000) }]);
});

test('verliezen gaan van oud naar nieuw', () => {
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: EUR(150_000),
    corrections: [],
    lossesCarriedForward: [
      { year: 2025, remainingCents: EUR(100_000) },
      { year: 2022, remainingCents: EUR(80_000) },
    ],
  });
  // Winst € 150.000 ligt onder de drempel, dus alles mag weg: eerst 2022 (€ 80.000),
  // daarna € 70.000 van 2025.
  assert.deepEqual(r.lossesUsed, [
    { year: 2022, usedCents: EUR(80_000) },
    { year: 2025, usedCents: EUR(70_000) },
  ]);
  assert.equal(r.taxableAmountCents, 0);
  assert.equal(r.taxCents, 0);
  assert.deepEqual(r.lossesRemaining, [{ year: 2025, remainingCents: EUR(30_000) }]);
});

test('een verlies van dit jaar schuift door naar volgend jaar', () => {
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: -EUR(40_000),
    corrections: [{ code: 'boete', label: 'Boete', amountCents: EUR(5_000) }],
    lossesCarriedForward: [{ year: 2024, remainingCents: EUR(10_000) }],
  });
  assert.equal(r.fiscalProfitCents, -EUR(35_000));
  assert.equal(r.taxableAmountCents, 0);
  assert.equal(r.taxCents, 0);
  assert.equal(r.totalLossUsedCents, 0, 'bij verlies wordt er niets verrekend');
  assert.deepEqual(r.lossesRemaining, [
    { year: 2024, remainingCents: EUR(10_000) },
    { year: 2026, remainingCents: EUR(35_000) },
  ]);
});

// ── Correcties en afrekening ───────────────────────────────────────────────

test('niet-aftrekbare kosten verhogen de winst, aftrekposten verlagen hem', () => {
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: EUR(100_000),
    corrections: [
      { code: 'gemengd', label: 'Beperkt aftrekbare kosten', amountCents: EUR(1_500) },
      { code: 'kia', label: 'Kleinschaligheidsinvesteringsaftrek', amountCents: -EUR(3_000) },
    ],
    lossesCarriedForward: [],
  });
  assert.equal(r.totalCorrectionsCents, -EUR(1_500));
  assert.equal(r.fiscalProfitCents, EUR(98_500));
  assert.equal(r.taxCents, EUR(18_715)); // 19% × € 98.500
});

test('voorlopige aanslagen bepalen wat er nog te betalen of terug te krijgen is', () => {
  const base = {
    rules: RULES_2026,
    commercialResultCents: EUR(100_000),
    corrections: [],
    lossesCarriedForward: [],
  };
  const teBetalen = computeVpb({ ...base, prepaidCents: EUR(10_000) });
  assert.equal(teBetalen.taxCents, EUR(19_000));
  assert.equal(teBetalen.balanceDueCents, EUR(9_000));

  const terug = computeVpb({ ...base, prepaidCents: EUR(25_000) });
  assert.equal(terug.balanceDueCents, -EUR(6_000), 'negatief = terug te ontvangen');
});

test('het gemiddelde tarief blijft onder het toptarief door de eerste schijf', () => {
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: EUR(300_000),
    corrections: [],
    lossesCarriedForward: [],
  });
  assert.equal(r.taxCents, EUR(63_800));
  assert.equal(r.effectiveRateBasisPoints, 2127); // 21,27%
});

test('afronding van het belastbaar bedrag werkt door in de belasting', () => {
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: EUR(10_004.99),
    corrections: [],
    lossesCarriedForward: [],
  });
  assert.equal(r.taxableBeforeRoundingCents, EUR(10_004.99));
  assert.equal(r.taxableAmountCents, EUR(10_000));
  assert.equal(r.taxCents, EUR(1_900));
});

// ── Achterwaartse verliesverrekening (art. 20 lid 2) ───────────────────────

/** 2021: 15% tot € 245.000, daarboven € 36.750 + 25%; nog geen beperking van art. 20. */
const RULES_2021: VpbYearRules = {
  year: 2021,
  brackets: [
    { lowerBoundCents: 0, baseAmountCents: 0, rateBasisPoints: 1500 },
    { lowerBoundCents: EUR(245_000), baseAmountCents: EUR(36_750), rateBasisPoints: 2500 },
  ],
  lossReliefThresholdCents: EUR(1_000_000_000_000),
  lossReliefRateBasisPoints: 10000,
};

/** Een vastgestelde winstberekening over 2025, zoals die uit de database komt. */
function basis2025(fiscalProfitCents: number, lossUsedCents = 0) {
  const taxableAmountCents = roundTaxableAmount(fiscalProfitCents - lossUsedCents);
  return {
    year: 2025,
    fiscalProfitCents,
    lossUsedCents,
    taxableAmountCents,
    taxCents: taxForAmount(taxableAmountCents, RULES_2026.brackets),
    brackets: RULES_2026.brackets,
  };
}

test('carry back: het verlies gaat eerst terug naar het voorafgaande jaar', () => {
  // 2025: winst € 300.000 → belasting € 63.800. 2026: verlies € 100.000.
  // Na verrekening is 2025 € 200.000 → € 38.000. Teruggaaf € 25.800.
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: -EUR(100_000),
    corrections: [],
    lossesCarriedForward: [],
    carryBackBasis: basis2025(EUR(300_000)),
  });
  assert.ok(r.carryBack);
  assert.equal(r.carryBack.year, 2025);
  assert.equal(r.carryBack.usedCents, EUR(100_000));
  assert.equal(r.carryBack.taxBeforeCents, EUR(63_800));
  assert.equal(r.carryBack.taxableAfterCents, EUR(200_000));
  assert.equal(r.carryBack.taxAfterCents, EUR(38_000));
  assert.equal(r.carryBack.refundCents, EUR(25_800));
  assert.deepEqual(r.lossesRemaining, [], 'het hele verlies is achterwaarts verrekend');
  assert.equal(r.taxCents, 0);
});

test('carry back: wat niet past in het voorafgaande jaar schuift door', () => {
  // 2025: winst € 50.000 (belasting € 9.500). 2026: verlies € 80.000.
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: -EUR(80_000),
    corrections: [],
    lossesCarriedForward: [{ year: 2023, remainingCents: EUR(5_000) }],
    carryBackBasis: basis2025(EUR(50_000)),
  });
  assert.ok(r.carryBack);
  assert.equal(r.carryBack.usedCents, EUR(50_000));
  assert.equal(r.carryBack.taxableAfterCents, 0);
  assert.equal(r.carryBack.refundCents, EUR(9_500));
  assert.deepEqual(r.lossesRemaining, [
    { year: 2023, remainingCents: EUR(5_000) },
    { year: 2026, remainingCents: EUR(30_000) },
  ]);
});

test('carry back na voorwaartse verrekening — het voorbeeld van KG:011:2023:14', () => {
  // 2021: winst € 4.000.000; daarin is een verlies uit 2020 van € 1.300.000
  // voorwaarts verrekend (2021 kende nog geen beperking). 2022: verlies € 2.000.000.
  // De ruimte in 2021 volgt de wettekst van het verliesjaar 2022:
  // € 1.000.000 + 50% × € 3.000.000 = € 2.500.000, min de al verrekende
  // € 1.300.000 = € 1.200.000.
  const taxable2021 = roundTaxableAmount(EUR(4_000_000) - EUR(1_300_000));
  const r = computeVpb({
    rules: RULES_2022,
    commercialResultCents: -EUR(2_000_000),
    corrections: [],
    lossesCarriedForward: [],
    carryBackBasis: {
      year: 2021,
      fiscalProfitCents: EUR(4_000_000),
      lossUsedCents: EUR(1_300_000),
      taxableAmountCents: taxable2021,
      taxCents: taxForAmount(taxable2021, RULES_2021.brackets),
      brackets: RULES_2021.brackets,
    },
  });
  assert.ok(r.carryBack);
  assert.equal(r.carryBack.capCents, EUR(2_500_000));
  assert.equal(r.carryBack.roomCents, EUR(1_200_000));
  assert.equal(r.carryBack.usedCents, EUR(1_200_000));
  // 2021-tarief: € 36.750 + 25% × (€ 2.700.000 − € 245.000) = € 650.500 vóór,
  // € 36.750 + 25% × (€ 1.500.000 − € 245.000) = € 350.500 ná.
  assert.equal(r.carryBack.taxBeforeCents, EUR(650_500));
  assert.equal(r.carryBack.taxAfterCents, EUR(350_500));
  assert.equal(r.carryBack.refundCents, EUR(300_000));
  assert.deepEqual(r.lossesRemaining, [{ year: 2022, remainingCents: EUR(800_000) }]);
});

test('carry back: is de ruimte al op aan voorwaartse verrekening, dan schuift alles door', () => {
  // 2025: winst € 3.000.000, bovengrens € 2.000.000, en die is al helemaal
  // gebruikt voor oudere verliezen.
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: -EUR(100_000),
    corrections: [],
    lossesCarriedForward: [],
    carryBackBasis: basis2025(EUR(3_000_000), EUR(2_000_000)),
  });
  assert.ok(r.carryBack);
  assert.equal(r.carryBack.roomCents, 0);
  assert.equal(r.carryBack.usedCents, 0);
  assert.equal(r.carryBack.refundCents, 0);
  assert.equal(r.carryBack.taxAfterCents, r.carryBack.taxBeforeCents);
  assert.deepEqual(r.lossesRemaining, [{ year: 2026, remainingCents: EUR(100_000) }]);
});

test('carry back: het nieuwe belastbare bedrag wordt ook op € 5 afgerond', () => {
  // 2025: winst € 123.457,89 → belastbaar € 123.455 → belasting € 23.456,45.
  // 2026: verlies € 10.001,23 → € 113.456,66 → € 113.455 → € 21.556,45.
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: -EUR(10_001.23),
    corrections: [],
    lossesCarriedForward: [],
    carryBackBasis: basis2025(EUR(123_457.89)),
  });
  assert.ok(r.carryBack);
  assert.equal(r.carryBack.taxableBeforeCents, EUR(123_455));
  assert.equal(r.carryBack.taxableAfterCents, EUR(113_455));
  assert.equal(r.carryBack.taxBeforeCents, EUR(23_456.45));
  assert.equal(r.carryBack.taxAfterCents, EUR(21_556.45));
  assert.equal(r.carryBack.refundCents, EUR(1_900));
});

test('carry back alleen bij een verlies en alleen met een vastgesteld voorafgaand jaar', () => {
  const winst = computeVpb({
    rules: RULES_2026,
    commercialResultCents: EUR(10_000),
    corrections: [],
    lossesCarriedForward: [],
    carryBackBasis: basis2025(EUR(300_000)),
  });
  assert.equal(winst.carryBack, null, 'een winstjaar verrekent niets terug');

  const zonder = computeVpb({
    rules: RULES_2026,
    commercialResultCents: -EUR(10_000),
    corrections: [],
    lossesCarriedForward: [],
  });
  assert.equal(zonder.carryBack, null);
  assert.deepEqual(zonder.lossesRemaining, [{ year: 2026, remainingCents: EUR(10_000) }]);
});

test('carry back: een verliesjaar ervoor biedt geen ruimte', () => {
  const r = computeVpb({
    rules: RULES_2026,
    commercialResultCents: -EUR(10_000),
    corrections: [],
    lossesCarriedForward: [],
    carryBackBasis: { ...basis2025(-EUR(40_000)), taxableAmountCents: 0, taxCents: 0 },
  });
  assert.ok(r.carryBack);
  assert.equal(r.carryBack.capCents, 0);
  assert.equal(r.carryBack.usedCents, 0);
  assert.equal(r.carryBack.refundCents, 0);
});
