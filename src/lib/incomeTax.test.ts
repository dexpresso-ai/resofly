import test from 'node:test';
import assert from 'node:assert/strict';
import { businessProfit, incomeTaxRules, mixedCostsAddBack } from './incomeTax.ts';

test('bedragen per jaar: 2025 en 2026, andere jaren niet', () => {
  assert.equal(incomeTaxRules(2025)?.selfEmployedDeductionCents, 247_000);
  assert.equal(incomeTaxRules(2026)?.selfEmployedDeductionCents, 120_000);
  assert.equal(incomeTaxRules(2026)?.starterDeductionCents, 212_300);
  assert.equal(incomeTaxRules(2026)?.smeExemptionBasisPoints, 1270);
  assert.equal(incomeTaxRules(2024), null);
  assert.equal(businessProfit({ year: 2024, profitCents: 1, mixedCostsCents: 0, hoursCriterionMet: true, starter: false }), null);
});

test('gemengde kosten: de gunstigste van 20% en de drempel van € 5.700', () => {
  // € 2.000: 20% is € 400, de drempel zou alles (€ 2.000) kosten.
  assert.deepEqual(mixedCostsAddBack(200_000, 570_000), { addBackCents: 40_000, method: 'percentage' });
  // € 40.000: 20% is € 8.000, de drempel maar € 5.700.
  assert.deepEqual(mixedCostsAddBack(4_000_000, 570_000), { addBackCents: 570_000, method: 'threshold' });
  assert.deepEqual(mixedCostsAddBack(0, 570_000), { addBackCents: 0, method: 'percentage' });
});

test('2026: winst € 40.000, € 1.000 representatie, urencriterium gehaald, geen starter', () => {
  const r = businessProfit({ year: 2026, profitCents: 4_000_000, mixedCostsCents: 100_000, hoursCriterionMet: true, starter: false })!;
  assert.equal(r.mixedCosts.addBackCents, 20_000);
  assert.equal(r.fiscalProfitCents, 4_020_000);
  assert.equal(r.selfEmployedDeductionCents, 120_000);
  assert.equal(r.starterDeductionCents, 0);
  // (40.200 − 1.200) × 12,70% = 4.953.
  assert.equal(r.smeExemptionCents, 495_300);
  assert.equal(r.taxableProfitCents, 4_020_000 - 120_000 - 495_300);
});

test('starter in 2025: zelfstandigen- plus startersaftrek, ook boven de winst', () => {
  const r = businessProfit({ year: 2025, profitCents: 300_000, mixedCostsCents: 0, hoursCriterionMet: true, starter: true })!;
  assert.equal(r.entrepreneurDeductionCents, 247_000 + 212_300);
  assert.equal(r.selfEmployedCapped, false);
  // € 3.000 − € 4.593 = −€ 1.593; de vrijstelling maakt het verlies kleiner.
  assert.equal(r.smeExemptionCents, Math.round(-159_300 * 0.127));
  assert.equal(r.taxableProfitCents, -159_300 - Math.round(-159_300 * 0.127));
});

test('geen starter met een lage winst: zelfstandigenaftrek tot de winst', () => {
  const r = businessProfit({ year: 2026, profitCents: 80_000, mixedCostsCents: 0, hoursCriterionMet: true, starter: false })!;
  assert.equal(r.selfEmployedDeductionCents, 80_000);
  assert.equal(r.selfEmployedCapped, true);
  assert.equal(r.taxableProfitCents, 0);
});

test('zonder urencriterium: geen ondernemersaftrek, wel de mkb-winstvrijstelling', () => {
  const r = businessProfit({ year: 2026, profitCents: 1_000_000, mixedCostsCents: 0, hoursCriterionMet: false, starter: true })!;
  assert.equal(r.entrepreneurDeductionCents, 0);
  assert.equal(r.smeExemptionCents, 127_000);
  assert.equal(r.taxableProfitCents, 873_000);
});
