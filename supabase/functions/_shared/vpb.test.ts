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
