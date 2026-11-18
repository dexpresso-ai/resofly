/**
 * De raming van de inkomstenbelasting: elke stap van de som, de randen van de
 * tabellen, de verdeling over vennoten en het overzicht. Draaien met: npm test
 *
 * De verwachte bedragen zijn niet met deze code uitgerekend maar los, met
 * Decimal en rechtstreeks uit de tabellen van de Belastingdienst (2025 en 2026).
 * Wie een bedrag hier aanpast omdat een test faalt, controleert eerst de tabel.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IB_DISCLAIMER, IB_RULES, applyRate, bracketTax, buildIncomeTaxOverview, defaultIncomeTaxProfile, estimatePerson,
  euroText, formatRate, incomeTaxRulesFor, kiaForInvestments, phaseOutCredit, premiumMonths, projectYearResult,
  splitByShares, tableCredit, type IbPersonInput, type IncomeTaxInputs,
} from './inkomstenbelasting.ts';
import * as server from '../../supabase/functions/_shared/inkomstenbelasting.ts';

const R25 = IB_RULES[2025];
const R26 = IB_RULES[2026];
const E = (euros: number) => Math.round(euros * 100);

function person(overrides: Partial<IbPersonInput> = {}): IbPersonInput {
  return {
    profitShareCents: 0, correctionsCents: 0, kiaCents: 0, isEntrepreneur: true, meetsHoursCriterion: true,
    starter: false, aowStatus: 'nee', aowMonth: null, otherEntrepreneurDeductionCents: 0, lossCarryForwardCents: 0,
    provisionalIncomeTaxCents: 0, provisionalZvwCents: 0, ...overrides,
  };
}

// ── De spiegel ──────────────────────────────────────────────────────────────

const MARK = '// ---- Vanaf hier is dit bestand gelijk aan zijn spiegel (zie de test). ----';

test('de spiegel voor de edge functions is teken voor teken gelijk', () => {
  const body = (path: string) => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const at = source.indexOf(MARK);
    assert.ok(at > 0, `markering ontbreekt in ${path}`);
    return source.slice(at);
  };
  assert.equal(body('../../supabase/functions/_shared/inkomstenbelasting.ts'), body('./inkomstenbelasting.ts'));
  // Puur: geen enkele import, zodat hij ongewijzigd in browser, node en Deno draait.
  for (const path of ['./inkomstenbelasting.ts', '../../supabase/functions/_shared/inkomstenbelasting.ts']) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /^import /m, path);
  }
  assert.equal(server.IB_DISCLAIMER, IB_DISCLAIMER);
});

test('de tabellen zijn compleet en oplopend', () => {
  for (const rules of Object.values(IB_RULES)) {
    const bounds = rules.brackets.map(b => b.upToCents);
    assert.equal(bounds[bounds.length - 1], null, `${rules.year}: de hoogste schijf heeft geen grens`);
    for (let i = 1; i < bounds.length - 1; i += 1) assert.ok((bounds[i] ?? 0) > (bounds[i - 1] ?? 0));
    for (const table of [rules.labourCredit, rules.labourCreditAow]) {
      for (let i = 1; i < table.segments.length; i += 1) assert.ok(table.segments[i].fromCents > table.segments[i - 1].fromCents);
      assert.equal(table.segments[0].fromCents, 0);
    }
    assert.ok(rules.kia.zeroUpToCents < rules.kia.percentageUpToCents && rules.kia.percentageUpToCents < rules.kia.fixedUpToCents && rules.kia.fixedUpToCents < rules.kia.maxCents);
    assert.equal(rules.kia.minAssetCents, E(450));
    assert.equal(rules.mkbExemptionRate, 12_700);
    assert.equal(rules.startersaftrekCents, E(2123));
    // De aftrekbeperking is het tarief van de tweede schijf.
    assert.equal(rules.deductionCapRate, rules.brackets[1].rate);
  }
  assert.equal(R25.zelfstandigenaftrekCents, E(2470));
  assert.equal(R26.zelfstandigenaftrekCents, E(1200));
});

test('regels per jaar: vanaf 2025, daarna het laatst bekende jaar met een waarschuwing', () => {
  assert.equal(incomeTaxRulesFor(2024), null);
  assert.equal(incomeTaxRulesFor(2025.5), null);
  assert.deepEqual(incomeTaxRulesFor(2025), { rules: R25, exact: true });
  assert.deepEqual(incomeTaxRulesFor(2026), { rules: R26, exact: true });
  assert.deepEqual(incomeTaxRulesFor(2027), { rules: R26, exact: false });
});

// ── Losse onderdelen ────────────────────────────────────────────────────────

test('afronden: een halve cent van nul af, ook bij grote bedragen', () => {
  assert.equal(applyRate(E(38883), 35_750), 1_390_067); // 13.900,6725 → 13.900,67
  assert.equal(applyRate(1, 50_000), 1); // 0,5 cent → 1
  assert.equal(applyRate(-1, 50_000), -1);
  assert.equal(applyRate(-13_230, 12_700), -1_680); // −168,021 → −168,02
  // Boven 2^53 / 100.000 rekent een float al verkeerd; BigInt niet.
  assert.equal(applyRate(9_000_000_000_000, 49_500), 4_455_000_000_000);
});

test('percentages leesbaar', () => {
  assert.equal(formatRate(35_750), '35,75%');
  assert.equal(formatRate(6_398), '6,398%');
  assert.equal(formatRate(12_700), '12,70%');
  assert.equal(formatRate(49_500), '49,50%');
  assert.equal(euroText(123_456_78), '€ 123.456,78');
  assert.equal(euroText(-5), '−€ 0,05');
});

test('KIA 2026: de grenzen van de tabel', () => {
  assert.equal(kiaForInvestments(R26, E(2900)), 0);
  assert.equal(kiaForInvestments(R26, E(2900) + 1), 81_200);
  assert.equal(kiaForInvestments(R26, E(10_000)), E(2800));
  assert.equal(kiaForInvestments(R26, E(71_683)), 2_007_124);
  assert.equal(kiaForInvestments(R26, E(71_683) + 1), E(20_072));
  assert.equal(kiaForInvestments(R26, E(132_746)), E(20_072));
  assert.equal(kiaForInvestments(R26, E(200_000)), 1_498_760);
  assert.equal(kiaForInvestments(R26, E(398_236)), 96);
  assert.equal(kiaForInvestments(R26, E(398_236) + 1), 0);
  assert.equal(kiaForInvestments(R26, 0), 0);
});

test('KIA 2025: eigen bedragen', () => {
  assert.equal(kiaForInvestments(R25, E(70_602)), applyRate(E(70_602), 28_000));
  assert.equal(kiaForInvestments(R25, E(100_000)), E(19_769));
  assert.equal(kiaForInvestments(R25, E(392_230) + 1), 0);
});

test('algemene heffingskorting en ouderenkorting: vol, afbouw, nul', () => {
  assert.equal(phaseOutCredit(R26.generalCredit, 0), E(3115));
  assert.equal(phaseOutCredit(R26.generalCredit, E(29_736)), E(3115));
  assert.equal(phaseOutCredit(R26.generalCredit, 4_260_240), 229_181);
  assert.equal(phaseOutCredit(R26.generalCredit, E(78_426)), 0);
  assert.equal(phaseOutCredit(R26.generalCreditAow, 3_439_620), 140_711);
  assert.equal(phaseOutCredit(R26.elderlyCredit, E(46_002)), E(2067));
  assert.equal(phaseOutCredit(R26.elderlyCredit, 5_133_240), 126_744);
  assert.equal(phaseOutCredit(R26.elderlyCredit, E(70_000)), 0);
});

test('arbeidskorting 2026: de knikken van de tabel', () => {
  assert.equal(tableCredit(R26.labourCredit, 0), 0);
  assert.equal(tableCredit(R26.labourCredit, E(2000)), 16_648);
  assert.equal(tableCredit(R26.labourCredit, E(11_965)), 99_597);
  assert.equal(tableCredit(R26.labourCredit, E(25_845)), 530_005);
  assert.equal(tableCredit(R26.labourCredit, E(45_592)), 568_507);
  assert.equal(tableCredit(R26.labourCredit, E(50_000)), 539_804);
  assert.equal(tableCredit(R26.labourCredit, E(132_920)), 0);
  assert.equal(tableCredit(R26.labourCredit, E(200_000)), 0);
  assert.equal(tableCredit(R26.labourCreditAow, E(40_000)), 278_487);
  assert.equal(tableCredit(R25.labourCredit, E(50_000)), 514_792);
});

test('AOW-premie: het hele jaar, in de loop van het jaar, niet', () => {
  assert.equal(premiumMonths('nee', null), 12);
  assert.equal(premiumMonths('heel_jaar', null), 0);
  assert.equal(premiumMonths('in_jaar', 1), 0);
  assert.equal(premiumMonths('in_jaar', 7), 6);
  assert.equal(premiumMonths('in_jaar', 12), 11);
  // December: 17,85% + 11/12 × 17,90% = 34,258%.
  const december = bracketTax(R26, E(10_000), 11);
  assert.equal(december.lines[0].rate, 34_258);
});

test('box 1: schijf voor schijf', () => {
  const { lines, taxCents } = bracketTax(R26, 12_990_240, 12);
  assert.deepEqual(lines.map(l => l.amountCents), [E(38_883), E(39_543), 5_147_640]);
  assert.deepEqual(lines.map(l => l.taxCents), [1_390_067, 1_485_235, 2_548_082]);
  assert.equal(taxCents, 5_423_384);
  assert.deepEqual(bracketTax(R26, 0, 12), { lines: [], taxCents: 0 });
});

// ── Eén persoon: de hele som ────────────────────────────────────────────────

test('2026, € 50.000 winst, urencriterium: de hele som', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(50_000) }));
  assert.equal(e.profitCents, E(50_000));
  assert.equal(e.zelfstandigenaftrekCents, E(1200));
  assert.equal(e.startersaftrekCents, 0);
  assert.equal(e.mkbExemptionCents, 619_760);
  assert.equal(e.taxableProfitCents, 4_260_240);
  assert.equal(e.taxableIncomeCents, 4_260_240);
  assert.equal(e.bracketTaxCents, 1_529_768);
  assert.equal(e.deductionCapCents, 0);
  assert.equal(e.labourIncomeCents, E(50_000), 'arbeidskorting over de winst vóór ondernemersaftrek en mkb-winstvrijstelling');
  assert.equal(e.generalCreditCents, 229_181);
  assert.equal(e.labourCreditCents, 539_804);
  assert.equal(e.elderlyCreditCents, 0);
  assert.equal(e.incomeTaxCents, 760_783);
  assert.equal(e.zvwBaseCents, 4_260_240);
  assert.equal(e.zvwCents, 206_622);
  assert.equal(e.totalCents, 967_405);
  assert.equal(e.balanceCents, 967_405);
  assert.equal(e.effectiveRate, 19_348); // 19,348% van de winst
});

test('2025, € 50.000 winst: de bedragen van 2025', () => {
  const e = estimatePerson(R25, person({ profitShareCents: E(50_000) }));
  assert.equal(e.zelfstandigenaftrekCents, E(2470));
  assert.equal(e.mkbExemptionCents, 603_631);
  assert.equal(e.taxableIncomeCents, 4_149_369);
  assert.equal(e.bracketTaxCents, 1_491_372);
  assert.equal(e.generalCreditCents, 223_863);
  assert.equal(e.labourCreditCents, 514_792);
  assert.equal(e.incomeTaxCents, 752_717);
  assert.equal(e.zvwCents, 218_257);
  assert.equal(e.totalCents, 970_974);
});

test('hoog inkomen: de aftrekbeperking en het maximum van de Zvw', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(150_000) }));
  assert.equal(e.taxableIncomeCents, 12_990_240);
  assert.equal(e.bracketTaxCents, 5_423_384);
  // (49,50% − 37,56%) over de ondernemersaftrek + mkb-winstvrijstelling (€ 20.097,60),
  // want die past helemaal in het deel boven € 78.426.
  assert.equal(e.deductionCapCents, 239_965);
  assert.equal(e.generalCreditCents, 0);
  assert.equal(e.labourCreditCents, 0);
  assert.equal(e.incomeTaxCents, 5_663_349);
  assert.equal(e.zvwBaseCents, E(79_409));
  assert.equal(e.zvwCents, 385_134);
  assert.equal(e.totalCents, 6_048_483);
});

test('aftrekbeperking alleen over het deel in de hoogste schijf', () => {
  // Net boven de grens: de beperking is kleiner dan de aftrekposten.
  const e = estimatePerson(R26, person({ profitShareCents: E(92_000) }));
  const above = e.taxableIncomeCents - E(78_426);
  assert.ok(above > 0 && above < e.entrepreneurDeductionCents + e.mkbExemptionCents);
  assert.equal(e.deductionCapCents, applyRate(above, 49_500 - 37_560));
});

test('starter met een kleine winst: de volle aftrek, ook als er een verlies ontstaat', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(2000), starter: true }));
  assert.equal(e.zelfstandigenaftrekCents, E(1200));
  assert.equal(e.startersaftrekCents, E(2123));
  assert.equal(e.zelfstandigenaftrekUnusedCents, 0);
  assert.equal(e.profitAfterDeductionCents, E(-1323));
  assert.equal(e.mkbExemptionCents, -16_802, 'de vrijstelling maakt het verlies kleiner');
  assert.equal(e.taxableProfitCents, -115_498);
  assert.equal(e.taxableIncomeCents, 0);
  assert.equal(e.lossThisYearCents, 115_498);
  assert.equal(e.incomeTaxCents, 0);
  assert.equal(e.zvwCents, 0);
  assert.equal(e.creditsAppliedCents, 0);
});

test('geen starter en een winst onder de zelfstandigenaftrek: aftrek tot de winst, de rest later', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(800) }));
  assert.equal(e.zelfstandigenaftrekCents, E(800));
  assert.equal(e.zelfstandigenaftrekUnusedCents, E(400));
  assert.equal(e.taxableProfitCents, 0);
  assert.equal(e.lossThisYearCents, 0);
  assert.equal(e.totalCents, 0);
});

test('verlies zonder starter: geen zelfstandigenaftrek, de mkb-winstvrijstelling verkleint het verlies', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(-10_000) }));
  assert.equal(e.zelfstandigenaftrekCents, 0);
  assert.equal(e.zelfstandigenaftrekUnusedCents, E(1200));
  assert.equal(e.mkbExemptionCents, E(-1270));
  assert.equal(e.taxableProfitCents, E(-8730));
  assert.equal(e.lossThisYearCents, E(8730));
  assert.equal(e.labourIncomeCents, 0);
  assert.equal(e.totalCents, 0);
  assert.equal(e.effectiveRate, 0);
});

test('urencriterium niet gehaald (of niet ingevuld): geen zelfstandigenaftrek, wel mkb-winstvrijstelling', () => {
  for (const meetsHoursCriterion of [false, null]) {
    const e = estimatePerson(R26, person({ profitShareCents: E(30_000), meetsHoursCriterion, starter: true }));
    assert.equal(e.zelfstandigenaftrekCents, 0);
    assert.equal(e.startersaftrekCents, 0, 'startersaftrek alleen samen met de zelfstandigenaftrek');
    assert.equal(e.mkbExemptionCents, E(3810));
    assert.equal(e.taxableIncomeCents, E(26_190));
    assert.equal(e.labourCreditCents, 538_102);
    assert.equal(e.incomeTaxCents, 86_691);
    assert.equal(e.zvwCents, 127_022);
  }
});

test('commanditaire vennoot: geen ondernemersaftrek, geen mkb-winstvrijstelling, geen arbeidskorting', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(30_000), isEntrepreneur: false, otherEntrepreneurDeductionCents: E(500) }));
  assert.equal(e.entrepreneurDeductionCents, 0);
  assert.equal(e.mkbExemptionCents, 0);
  assert.equal(e.labourIncomeCents, 0);
  assert.equal(e.labourCreditCents, 0);
  assert.equal(e.generalCreditCents, 309_811);
  assert.equal(e.incomeTaxCents, 762_689);
  assert.equal(e.zvwCents, E(1455));
  assert.equal(e.totalCents, 908_189);
});

test('AOW-leeftijd het hele jaar: halve zelfstandigenaftrek, geen AOW-premie, ouderenkorting', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(40_000), aowStatus: 'heel_jaar' }));
  assert.equal(e.zelfstandigenaftrekCents, E(600));
  assert.equal(e.taxableIncomeCents, 3_439_620);
  assert.equal(e.bracketTaxCents, 613_972);
  assert.equal(e.generalCreditCents, 140_711);
  assert.equal(e.labourCreditCents, 278_487);
  assert.equal(e.elderlyCreditCents, E(2067));
  assert.equal(e.creditsAppliedCents, 613_972, 'de kortingen zijn hoger dan de belasting');
  assert.equal(e.incomeTaxCents, 0);
  assert.equal(e.zvwCents, 166_822, 'de Zvw-bijdrage blijft');
});

test('AOW-leeftijd het hele jaar en starter (2025): ook de startersaftrek half', () => {
  const e = estimatePerson(R25, person({ profitShareCents: E(20_000), aowStatus: 'heel_jaar', starter: true }));
  assert.equal(e.zelfstandigenaftrekCents, E(1235));
  assert.equal(e.startersaftrekCents, 106_150);
  assert.equal(e.mkbExemptionCents, 224_834);
  assert.equal(e.bracketTaxCents, 276_956);
  assert.equal(e.incomeTaxCents, 0);
  assert.equal(e.zvwCents, 81_294);
});

test('AOW-leeftijd in juli: premie over zes maanden, kortingen naar rato, volle zelfstandigenaftrek', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(60_000), aowStatus: 'in_jaar', aowMonth: 7 }));
  assert.equal(e.premiumMonths, 6);
  assert.equal(e.zelfstandigenaftrekCents, E(1200));
  assert.equal(e.taxableIncomeCents, 5_133_240);
  assert.equal(e.bracketTaxCents, 1_509_664);
  assert.equal(e.generalCreditCents, 129_963);
  assert.equal(e.labourCreditCents, 355_939);
  assert.equal(e.elderlyCreditCents, 126_744);
  assert.equal(e.incomeTaxCents, 897_018);
  assert.equal(e.zvwCents, 248_962);
  assert.equal(e.totalCents, 1_145_980);
});

test('starter met KIA, correcties, overige aftrek en een oud verlies', () => {
  const e = estimatePerson(R26, person({
    profitShareCents: E(30_000), kiaCents: E(2800), correctionsCents: E(1000), starter: true,
    otherEntrepreneurDeductionCents: E(500), lossCarryForwardCents: E(5000),
  }));
  assert.equal(e.profitCents, E(28_200));
  assert.equal(e.entrepreneurDeductionCents, E(3823));
  assert.equal(e.mkbExemptionCents, 309_588);
  assert.equal(e.taxableProfitCents, 2_128_112);
  assert.equal(e.lossOffsetCents, E(5000));
  assert.equal(e.taxableIncomeCents, 1_628_112);
  assert.equal(e.bracketTaxCents, 582_050);
  assert.equal(e.generalCreditCents, E(3115), 'het verrekende verlies verlaagt het verzamelinkomen');
  assert.equal(e.labourCreditCents, 534_592, 'maar niet het arbeidsinkomen');
  assert.equal(e.incomeTaxCents, 0);
  assert.equal(e.zvwBaseCents, 2_128_112, 'en ook niet de grondslag van de Zvw');
  assert.equal(e.zvwCents, 103_213);
});

test('een oud verlies gaat nooit verder dan nul', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(10_000), lossCarryForwardCents: E(1_000_000) }));
  assert.equal(e.lossOffsetCents, e.taxableProfitCents);
  assert.equal(e.taxableIncomeCents, 0);
});

test('voorlopige aanslagen: bijbetalen of terugkrijgen', () => {
  const e = estimatePerson(R26, person({ profitShareCents: E(50_000), provisionalIncomeTaxCents: E(8000), provisionalZvwCents: E(2000) }));
  assert.equal(e.balanceIncomeTaxCents, 760_783 - E(8000));
  assert.equal(e.balanceZvwCents, 206_622 - E(2000));
  assert.equal(e.balanceCents, e.totalCents - E(10_000));
  assert.ok(e.balanceIncomeTaxCents < 0, 'te veel betaald: terug');
});

test('rommel in de invoer wordt geen NaN', () => {
  const e = estimatePerson(R26, person({
    profitShareCents: Number.NaN, kiaCents: -500, otherEntrepreneurDeductionCents: Number.POSITIVE_INFINITY,
    lossCarryForwardCents: -1, provisionalIncomeTaxCents: Number.NaN,
  }));
  for (const [key, value] of Object.entries(e)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is ${value}`);
  }
  assert.equal(e.totalCents, 0);
});

// ── Verdelen en prognose ────────────────────────────────────────────────────

const shares6040 = [{ key: 'a', basisPoints: 6000, order: 1 }, { key: 'b', basisPoints: 4000, order: 2 }];

test('verdelen zoals de database: tot op de cent sluitend, ook bij verlies', () => {
  assert.deepEqual([...splitByShares(100_001, shares6040)], [['a', 60_001], ['b', 40_000]]);
  assert.deepEqual([...splitByShares(-30_001, shares6040)], [['a', -18_001], ['b', -12_000]]);
  const thirds = [
    { key: 'x', basisPoints: 3333, order: 1 }, { key: 'y', basisPoints: 3333, order: 2 }, { key: 'z', basisPoints: 3334, order: 3 },
  ];
  assert.deepEqual([...splitByShares(100, thirds)], [['x', 33], ['y', 33], ['z', 34]]);
  // Gelijke resten: het laagste vennootnummer krijgt de cent.
  const halves = [{ key: 'p', basisPoints: 5000, order: 2 }, { key: 'q', basisPoints: 5000, order: 1 }];
  assert.deepEqual([...splitByShares(101, halves)], [['p', 50], ['q', 51]]);
  // Niet 100%: alleen de afgeronde delen, net als partnership_result_shares.
  const short = [{ key: 'a', basisPoints: 6000, order: 1 }, { key: 'b', basisPoints: 3000, order: 2 }];
  assert.deepEqual([...splitByShares(100_001, short)], [['a', 60_000], ['b', 30_000]]);
  assert.deepEqual([...splitByShares(0, shares6040)], [['a', 0], ['b', 0]]);
  for (const amount of [1, 7, 99_999, 123_456_789, -1, -987_654]) {
    const sum = [...splitByShares(amount, thirds).values()].reduce((s, v) => s + v, 0);
    assert.equal(sum, amount, `som van de delen van ${amount}`);
  }
});

test('de database verdeelt met dezelfde regel', () => {
  // Lopen de twee uiteen, dan zou de raming een ander winstaandeel tonen dan
  // de jaarafsluiting boekt.
  const sql = readFileSync(new URL('../../supabase/migrations/20261104070000_ib_prive_vennoten.sql', import.meta.url), 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function public.partnership_result_shares'), sql.indexOf('-- ── 3. Jaarafsluiting'));
  assert.match(fn, /\(abs\(p_result_cents\) \* pp\.profit_share_basis_points\) \/ 10000 as base/);
  assert.match(fn, /\(abs\(p_result_cents\) \* pp\.profit_share_basis_points\) % 10000 as rem/);
  assert.match(fn, /row_number\(\) over \(order by s\.rem desc, s\.partner_number\) as rn/);
  assert.match(fn, /case when r\.total_bp = 10000 and r\.rn <= r\.leftover then 1 else 0 end/);
});

test('prognose: in hetzelfde tempo naar 31 december', () => {
  const p = projectYearResult({ resultCents: E(50_000), year: 2026, today: '2026-07-02', startDate: null });
  assert.ok(p);
  assert.equal(p.fromDate, '2026-01-01');
  assert.equal(p.elapsedDays, 183);
  assert.equal(p.totalDays, 365);
  assert.equal(p.projectedCents, 9_972_678);
  // Begon de boekhouding later, dan telt het tempo vanaf die dag.
  const late = projectYearResult({ resultCents: E(10_000), year: 2026, today: '2026-10-31', startDate: '2026-07-01' });
  assert.ok(late);
  assert.equal(late.elapsedDays, 123);
  assert.equal(late.totalDays, 184);
  assert.equal(late.projectedCents, 1_495_935);
  // Een startdatum in een eerder jaar telt vanaf 1 januari.
  assert.equal(projectYearResult({ resultCents: 1, year: 2026, today: '2026-07-02', startDate: '2024-03-01' })?.fromDate, '2026-01-01');
});

test('prognose: niet voor een afgelopen of toekomstig jaar, en niet in de eerste maand', () => {
  assert.equal(projectYearResult({ resultCents: E(50_000), year: 2025, today: '2026-11-17', startDate: null }), null);
  assert.equal(projectYearResult({ resultCents: 0, year: 2027, today: '2026-11-17', startDate: null }), null);
  assert.equal(projectYearResult({ resultCents: E(50_000), year: 2026, today: '2026-12-31', startDate: null }), null);
  assert.equal(projectYearResult({ resultCents: E(5000), year: 2026, today: '2026-01-29', startDate: null }), null, 'na 29 dagen zegt het tempo nog niets');
  assert.ok(projectYearResult({ resultCents: E(5000), year: 2026, today: '2026-01-30', startDate: null }));
  assert.equal(projectYearResult({ resultCents: E(5000), year: 2026, today: '2026-11-17', startDate: '2027-01-01' }), null);
});

// ── Het overzicht ───────────────────────────────────────────────────────────

function inputs(overrides: Partial<IncomeTaxInputs> = {}): IncomeTaxInputs {
  return {
    year: 2026, legalForm: 'eenmanszaak', isPartnershipForm: false, companyName: 'Studio Test', bookkeepingStartDate: '2024-01-01',
    resultCents: E(50_000), overlappingFiscalYears: [{ id: 'fy', label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'open' }],
    partners: [], profiles: [], corrections: [], investments: [], myMinutes: null, ...overrides,
  };
}

const TODAY = '2026-11-17';

test('eenmanszaak: één ondernemer, met de opgeslagen gegevens', () => {
  const overview = buildIncomeTaxOverview(inputs({
    profiles: [{ ...defaultIncomeTaxProfile(null), meetsHoursCriterion: true, updatedAt: '2026-11-01T10:00:00Z' }],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  assert.equal(overview.persons.length, 1);
  const [p] = overview.persons;
  assert.equal(p.partnerId, null);
  assert.equal(p.name, 'Ondernemer (Studio Test)');
  assert.equal(p.kind, 'ondernemer');
  assert.equal(p.profileSaved, true);
  assert.equal(p.estimate.totalCents, 967_405);
  assert.equal(overview.totals.totalCents, 967_405);
  assert.equal(overview.basis, 'geboekt');
  assert.deepEqual(overview.warnings, []);
  assert.equal(overview.disclaimer, IB_DISCLAIMER);
  assert.match(IB_DISCLAIMER, /alleen het zakelijke inkomen/);
});

test('zonder opgeslagen gegevens: urencriterium onbekend, en dat staat erbij', () => {
  const overview = buildIncomeTaxOverview(inputs(), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  const [p] = overview.persons;
  assert.equal(p.profileSaved, false);
  assert.equal(p.profile.meetsHoursCriterion, null);
  assert.equal(p.estimate.zelfstandigenaftrekCents, 0);
  assert.ok(p.notes.some(n => /Urencriterium nog niet ingevuld/.test(n)));
});

test('vof 60/40: winst, KIA en gedeelde correcties verdeeld, eigen correcties per vennoot', () => {
  const overview = buildIncomeTaxOverview(inputs({
    legalForm: 'vof', isPartnershipForm: true, resultCents: 10_000_001,
    partners: [
      { id: 'p2', name: 'Bram', partnerNumber: 2, kind: 'beherend', isActive: true, shareBasisPoints: 4000 },
      { id: 'p1', name: 'Anna', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 6000 },
      { id: 'p3', name: 'Oud', partnerNumber: 3, kind: 'beherend', isActive: false, shareBasisPoints: 0 },
    ],
    profiles: [
      { ...defaultIncomeTaxProfile('p1'), meetsHoursCriterion: true, starter: true },
      { ...defaultIncomeTaxProfile('p2'), meetsHoursCriterion: false },
      { ...defaultIncomeTaxProfile(null), meetsHoursCriterion: true },
    ],
    corrections: [
      { id: 'c1', partnerId: null, code: 'gemengde_kosten', label: 'Lunches', amountCents: 100_001 },
      { id: 'c2', partnerId: 'p2', code: 'privegebruik_auto', label: 'Auto Bram', amountCents: E(3000) },
      { id: 'c3', partnerId: 'p3', code: 'overig', label: 'Van de oud-vennoot', amountCents: E(99) },
    ],
    investments: [
      { assetId: 'a1', name: 'Laptop', assetNumber: 'A-1', acquisitionDate: '2026-03-01', costCents: E(2500), excluded: false },
      { assetId: 'a2', name: 'Bureau', assetNumber: 'A-2', acquisitionDate: '2026-04-01', costCents: E(1500), excluded: false },
      { assetId: 'a3', name: 'Personenauto', assetNumber: 'A-3', acquisitionDate: '2026-05-01', costCents: E(40_000), excluded: true },
      { assetId: 'a4', name: 'Muis', assetNumber: null, acquisitionDate: '2026-06-01', costCents: E(449), excluded: false },
    ],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  assert.deepEqual(overview.persons.map(p => p.name), ['Anna', 'Bram'], 'alleen actieve vennoten, op vennootnummer');
  assert.deepEqual(overview.investments.map(i => i.counts), [true, true, false, false]);
  assert.equal(overview.investments[3].belowMinimum, true);
  assert.equal(overview.investmentTotalCents, E(4000));
  assert.equal(overview.kiaCents, E(1120));
  const [anna, bram] = overview.persons;
  assert.equal(anna.estimate.profitShareCents, 6_000_001);
  assert.equal(bram.estimate.profitShareCents, 4_000_000);
  assert.equal(anna.estimate.kiaCents + bram.estimate.kiaCents, E(1120));
  assert.equal(anna.estimate.kiaCents, E(672));
  assert.deepEqual(anna.corrections.map(c => [c.id, c.amountCents, c.shared]), [['c1', 60_001, true]]);
  assert.deepEqual(bram.corrections.map(c => [c.id, c.amountCents, c.shared]), [['c1', 40_000, true], ['c2', E(3000), false]]);
  assert.equal(anna.estimate.startersaftrekCents, E(2123));
  assert.equal(bram.estimate.zelfstandigenaftrekCents, 0);
  assert.equal(overview.totals.totalCents, anna.estimate.totalCents + bram.estimate.totalCents);
  assert.ok(overview.warnings.some(w => /Eén correctie staat op een vennoot die niet \(meer\) meedoet/.test(w)));
});

test('cv: de commanditaire vennoot is geen ondernemer, ook niet met een opgeslagen urencriterium', () => {
  const overview = buildIncomeTaxOverview(inputs({
    legalForm: 'cv', isPartnershipForm: true,
    partners: [
      { id: 'b', name: 'Beherend', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 7000 },
      { id: 'c', name: 'Stil', partnerNumber: 2, kind: 'commanditair', isActive: true, shareBasisPoints: 3000 },
    ],
    profiles: [{ ...defaultIncomeTaxProfile('c'), meetsHoursCriterion: true, starter: true }],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  const stil = overview.persons[1];
  assert.equal(stil.kind, 'commanditair');
  assert.equal(stil.estimate.entrepreneurDeductionCents, 0);
  assert.equal(stil.estimate.mkbExemptionCents, 0);
  assert.equal(stil.estimate.labourCreditCents, 0);
  assert.ok(stil.notes.some(n => /Commanditaire vennoot/.test(n)));
});

test('vof zonder vennoten, en een verdeling die niet op 100% uitkomt: waarschuwen', () => {
  const none = buildIncomeTaxOverview(inputs({ legalForm: 'vof', isPartnershipForm: true }), { basis: 'geboekt', today: TODAY });
  assert.ok(none);
  assert.equal(none.persons.length, 1);
  assert.ok(none.warnings.some(w => /nog geen vennoten vastgelegd/.test(w)));
  const short = buildIncomeTaxOverview(inputs({
    legalForm: 'vof', isPartnershipForm: true,
    partners: [
      { id: 'p1', name: 'A', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 6000 },
      { id: 'p2', name: 'B', partnerNumber: 2, kind: 'beherend', isActive: true, shareBasisPoints: 3000 },
    ],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(short);
  assert.ok(short.warnings.some(w => /telt op tot 90% in plaats van 100%/.test(w)));
});

test('prognose of geboekt, en een jaar zonder eigen tarieven', () => {
  const projected = buildIncomeTaxOverview(inputs({ resultCents: E(40_000) }), { basis: 'prognose', today: '2026-07-02' });
  assert.ok(projected);
  assert.equal(projected.basis, 'prognose');
  assert.equal(projected.usedResultCents, projected.projection?.projectedCents);
  assert.equal(projected.persons[0].estimate.profitShareCents, projected.usedResultCents);
  // Een afgelopen jaar heeft geen prognose: dan gewoon de geboekte winst.
  const past = buildIncomeTaxOverview(inputs({ year: 2025, overlappingFiscalYears: [] }), { basis: 'prognose', today: TODAY });
  assert.ok(past);
  assert.equal(past.basis, 'geboekt');
  assert.equal(past.rulesYear, 2025);
  const later = buildIncomeTaxOverview(inputs({ year: 2027, overlappingFiscalYears: [] }), { basis: 'geboekt', today: TODAY });
  assert.ok(later);
  assert.equal(later.rulesExact, false);
  assert.ok(later.warnings.some(w => /voor 2027 staan nog niet in ResoFly/.test(w)));
  assert.equal(buildIncomeTaxOverview(inputs({ year: 2024 }), { basis: 'geboekt', today: TODAY }), null);
});

test('een boekjaar dat niet gelijk loopt met het kalenderjaar: waarschuwen', () => {
  const overview = buildIncomeTaxOverview(inputs({
    overlappingFiscalYears: [{ id: 'fy', label: '2025/2026', periodStart: '2025-07-01', periodEnd: '2026-06-30', status: 'open' }],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  assert.ok(overview.warnings.some(w => /niet gelijk met het kalenderjaar/.test(w)));
});
