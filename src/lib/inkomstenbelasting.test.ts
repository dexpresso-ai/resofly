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
  euroText, formatRate, incomeTaxRulesFor, kiaForInvestments, mixedCostsAddBack, phaseOutCredit, premiumMonths, projectYearResult,
  projectMinutesFromFirstEntry, splitByShares, splitWithPrior, tableCredit, type IbPersonInput, type IncomeTaxInputs,
} from './inkomstenbelasting.ts';
import { projectHourCriterion } from './hourCriterion.ts';
import * as server from '../../supabase/functions/_shared/inkomstenbelasting.ts';
import * as aangifte from './incomeTax.ts';

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

test('aftrekbeperking: over de aftrekposten, tot waar het inkomen mét die posten boven de grens uitkomt', () => {
  // Art. 2.10 lid 2: de aftrekposten tellen als het bovenste deel van het
  // inkomen. Bij € 90.000 winst is het belastbare inkomen € 77.522,40, net
  // onder de grens van € 78.426. Zonder de aftrekposten was het € 90.000:
  // € 11.574 daarvan zat in de hoogste schijf, en over dat deel leveren ze
  // 37,56% op in plaats van 49,50%. De verhoging is € 11.574 × 11,94%.
  // Eerder stond hier het inkomen ná aftrek tegenover de grens: € 0.
  const cap = (winst: number, rules = R26) => estimatePerson(rules, person({ profitShareCents: E(winst) })).deductionCapCents;
  assert.equal(cap(78_000), 0, 'onder de grens: geen beperking');
  assert.equal(cap(80_000), 18_794);
  assert.equal(cap(90_000), 138_194);
  assert.equal(cap(92_000), 152_015, 'boven € 90.626 zit het belastbare inkomen zelf ook boven de grens');
  // Ver boven de grens: alle aftrekposten vallen in de hoogste schijf.
  const hoog = estimatePerson(R26, person({ profitShareCents: E(130_000) }));
  assert.equal(hoog.deductionCapCents, applyRate(hoog.entrepreneurDeductionCents + hoog.mkbExemptionCents, 49_500 - 37_560));
  assert.equal(cap(100_000), 164_146);
  // 2025: grens € 76.817, 49,50% tegenover 37,48%.
  assert.equal(cap(80_000, R25), 38_260);
  assert.equal(cap(90_000, R25), 158_460);
  assert.equal(cap(100_000, R25), 178_573);
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
  assert.equal(e.generalCreditCents, E(3115), 'de volle korting: het verzamelinkomen blijft onder de afbouwgrens');
  assert.equal(e.labourCreditCents, 534_592, 'maar niet het arbeidsinkomen');
  assert.equal(e.incomeTaxCents, 0);
  assert.equal(e.zvwBaseCents, 2_128_112, 'en ook niet de grondslag van de Zvw');
  assert.equal(e.zvwCents, 103_213);
});

test('een oud verlies verlaagt de belasting, niet het verzamelinkomen voor de kortingen', () => {
  // Het verzamelinkomen is het inkomen vóór verliesverrekening (art. 2.18).
  // De afbouw van de algemene heffingskorting en van de ouderenkorting kijkt
  // daarnaar. Eerder rekende de raming met het inkomen ná verrekening, en
  // kreeg wie een oud verlies verrekende te veel korting.
  const zonder = estimatePerson(R26, person({ profitShareCents: E(60_000), aowStatus: 'heel_jaar' }));
  const met = estimatePerson(R26, person({ profitShareCents: E(60_000), aowStatus: 'heel_jaar', lossCarryForwardCents: E(20_000) }));
  assert.equal(met.lossOffsetCents, E(20_000));
  assert.equal(met.taxableIncomeCents, zonder.taxableIncomeCents - E(20_000));
  assert.equal(met.generalCreditCents, zonder.generalCreditCents);
  assert.equal(met.elderlyCreditCents, zonder.elderlyCreditCents);
  assert.ok(zonder.generalCreditCents < phaseOutCredit(R26.generalCreditAow, 0), 'in de afbouw, anders zegt deze test niets');
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
    resultCents: E(50_000), mixedCostsCents: 0, overlappingFiscalYears: [{ id: 'fy', label: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', status: 'open' }],
    partners: [], profiles: [], corrections: [], investments: [], myMinutes: null, ownerMinutes: null, partnerMinutes: null, ...overrides,
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
  assert.deepEqual(anna.corrections.map(c => [c.id, c.amountCents, c.shared, c.automatic]), [['c1', 60_001, true, false]]);
  assert.deepEqual(bram.corrections.map(c => [c.id, c.amountCents, c.shared, c.automatic]), [['c1', 40_000, true, false], ['c2', E(3000), false, false]]);
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

// ── Gemengde kosten en het urencriterium: gelijk aan Eigen vermogen ─────────

test('gemengde kosten: het gunstigste van 20% of de drempel van € 5.700', () => {
  assert.equal(R25.mixedCostsThresholdCents, E(5700));
  assert.equal(R26.mixedCostsThresholdCents, E(5700));
  assert.deepEqual(mixedCostsAddBack(R26, 0), { addBackCents: 0, method: 'percentage' });
  assert.deepEqual(mixedCostsAddBack(R26, E(1000)), { addBackCents: E(200), method: 'percentage' });
  assert.deepEqual(mixedCostsAddBack(R26, E(28_500)), { addBackCents: E(5700), method: 'percentage' });
  assert.deepEqual(mixedCostsAddBack(R26, E(40_000)), { addBackCents: E(5700), method: 'threshold' });
  assert.deepEqual(mixedCostsAddBack(R26, -500), { addBackCents: 0, method: 'percentage' });
});

test('dezelfde bedragen en dezelfde som als het overzicht op Eigen vermogen (incomeTax.ts)', () => {
  // Twee schermen, één belastbare winst: lopen de bedragen of de som voor de
  // gemengde kosten uiteen, dan zegt Eigen vermogen iets anders dan deze raming.
  for (const year of [2025, 2026]) {
    const theirs = aangifte.incomeTaxRules(year);
    assert.ok(theirs, `incomeTax.ts kent ${year}`);
    const ours = IB_RULES[year];
    assert.equal(theirs.selfEmployedDeductionCents, ours.zelfstandigenaftrekCents, `zelfstandigenaftrek ${year}`);
    assert.equal(theirs.starterDeductionCents, ours.startersaftrekCents, `startersaftrek ${year}`);
    assert.equal(theirs.smeExemptionBasisPoints * 10, ours.mkbExemptionRate, `mkb-winstvrijstelling ${year}`);
    assert.equal(theirs.mixedCostsThresholdCents, ours.mixedCostsThresholdCents, `drempel gemengde kosten ${year}`);
    for (const total of [0, 1, 999, 100_000, 2_849_999, 2_850_000, 2_850_001, 9_999_999]) {
      const a = aangifte.mixedCostsAddBack(total, theirs.mixedCostsThresholdCents);
      assert.deepEqual(mixedCostsAddBack(ours, total), a, `gemengde kosten ${total} in ${year}`);
    }
  }
  // De hele som tot de belastbare winst, voor een paar eenmanszaken.
  for (const [profit, mixed, hours, starter] of [[E(50_000), E(1000), true, false], [E(2000), 0, true, true], [E(800), 0, true, false], [E(-10_000), E(300), false, false], [E(90_000), E(40_000), true, false]] as const) {
    const theirs = aangifte.businessProfit({ year: 2026, profitCents: profit, mixedCostsCents: mixed, hoursCriterionMet: hours, starter });
    assert.ok(theirs);
    const overview = buildIncomeTaxOverview(inputs({
      resultCents: profit, mixedCostsCents: mixed,
      profiles: [{ ...defaultIncomeTaxProfile(null), meetsHoursCriterion: hours, starter }],
    }), { basis: 'geboekt', today: TODAY });
    assert.ok(overview);
    const e = overview.persons[0].estimate;
    assert.equal(e.profitCents, theirs.fiscalProfitCents, `winst uit onderneming bij ${profit}`);
    assert.equal(e.entrepreneurDeductionCents, theirs.entrepreneurDeductionCents, `ondernemersaftrek bij ${profit}`);
    assert.equal(e.mkbExemptionCents, theirs.smeExemptionCents, `mkb-winstvrijstelling bij ${profit}`);
    assert.equal(e.taxableProfitCents, theirs.taxableProfitCents, `belastbare winst bij ${profit}`);
  }
});

test('gemengde kosten op 4600: een automatische correctie, bij een vof naar winstaandeel', () => {
  const eenmanszaak = buildIncomeTaxOverview(inputs({ mixedCostsCents: E(1000) }), { basis: 'geboekt', today: TODAY });
  assert.ok(eenmanszaak);
  assert.deepEqual(eenmanszaak.mixedCosts, { totalCents: E(1000), addBackCents: E(200), method: 'percentage', thresholdCents: E(5700) });
  const [c] = eenmanszaak.persons[0].corrections;
  assert.deepEqual([c.id, c.code, c.amountCents, c.automatic, c.shared], ['gemengde-kosten-4600', 'gemengde_kosten', E(200), true, false]);
  assert.match(c.label, /20% van € 1\.000,00/);
  assert.equal(eenmanszaak.persons[0].estimate.profitCents, E(50_200));
  const vof = buildIncomeTaxOverview(inputs({
    legalForm: 'vof', isPartnershipForm: true, mixedCostsCents: 100_001 * 5,
    partners: [
      { id: 'p1', name: 'A', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 6000 },
      { id: 'p2', name: 'B', partnerNumber: 2, kind: 'beherend', isActive: true, shareBasisPoints: 4000 },
    ],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(vof);
  const parts = vof.persons.map(p => p.corrections.find(x => x.automatic)?.amountCents ?? 0);
  assert.deepEqual(parts, [60_001, 40_000], 'het niet-aftrekbare deel (€ 1.000,01) naar winstaandeel, tot op de cent');
  assert.equal(buildIncomeTaxOverview(inputs({ mixedCostsCents: 0 }), { basis: 'geboekt', today: TODAY })?.mixedCosts, null);
});

test('urencriterium: zonder opgeslagen keuze de uren van de eigenaar, met een keuze die keuze', () => {
  const genoeg = buildIncomeTaxOverview(inputs({ ownerMinutes: 1225 * 60 }), { basis: 'geboekt', today: TODAY });
  assert.ok(genoeg);
  assert.equal(genoeg.persons[0].hoursFromTimeTracking, true);
  assert.equal(genoeg.persons[0].profile.meetsHoursCriterion, true);
  assert.equal(genoeg.persons[0].estimate.zelfstandigenaftrekCents, E(1200));
  assert.ok(genoeg.persons[0].notes.some(n => /volgens Uren: de eigenaar heeft 1\.225 uur/.test(n)));
  const te = buildIncomeTaxOverview(inputs({ ownerMinutes: 1225 * 60 - 1 }), { basis: 'geboekt', today: TODAY });
  assert.equal(te?.persons[0].profile.meetsHoursCriterion, false);
  assert.ok(te?.persons[0].notes.some(n => /minder dan 1\.225/.test(n)));
  // Een opgeslagen ja of nee wint van de uren.
  const nee = buildIncomeTaxOverview(inputs({ ownerMinutes: 2000 * 60, profiles: [{ ...defaultIncomeTaxProfile(null), meetsHoursCriterion: false }] }), { basis: 'geboekt', today: TODAY });
  assert.equal(nee?.persons[0].hoursFromTimeTracking, false);
  assert.equal(nee?.persons[0].profile.meetsHoursCriterion, false);
  assert.equal(nee?.persons[0].estimate.zelfstandigenaftrekCents, 0);
  assert.ok(nee?.persons[0].notes.some(n => /Bij Uren staan 2\.000 uur, maar het urencriterium staat hier op nee/.test(n)), 'een "nee" dat de uren hebben ingehaald: zeg het');
  // Opgeslagen zonder eigen keuze (alleen de voorlopige aanslag ingevuld): het
  // urencriterium blijft de uren volgen. Eerder legde opslaan in maart het
  // "nee" van die dag vast, en bleef de zelfstandigenaftrek in november weg.
  const maart = { ...defaultIncomeTaxProfile(null), provisionalIncomeTaxCents: E(4000), updatedAt: '2026-03-10T09:00:00Z' };
  const gevolgd = buildIncomeTaxOverview(inputs({ ownerMinutes: 1400 * 60, profiles: [maart] }), { basis: 'geboekt', today: TODAY });
  assert.equal(gevolgd?.persons[0].profileSaved, true);
  assert.equal(gevolgd?.persons[0].hoursFromTimeTracking, true);
  assert.equal(gevolgd?.persons[0].profile.meetsHoursCriterion, true);
  assert.equal(gevolgd?.persons[0].estimate.zelfstandigenaftrekCents, E(1200));
  assert.equal(gevolgd?.persons[0].estimate.provisionalIncomeTaxCents, E(4000));
  // Zonder uren (geen leesrecht op Uren): niet ingevuld, zoals voorheen.
  const zonder = buildIncomeTaxOverview(inputs({ ownerMinutes: null }), { basis: 'geboekt', today: TODAY });
  assert.equal(zonder?.persons[0].hoursFromTimeTracking, false);
  assert.equal(zonder?.persons[0].profile.meetsHoursCriterion, null);
  // Bij een vof gaat het urencriterium per vennoot: de uren van de eigenaar tellen niet.
  const vof = buildIncomeTaxOverview(inputs({ legalForm: 'vof', isPartnershipForm: true, ownerMinutes: 2000 * 60 }), { basis: 'geboekt', today: TODAY });
  assert.equal(vof?.ownerMinutes, null);
  assert.equal(vof?.persons[0].profile.meetsHoursCriterion, null);
});

test('prognose: de uren gaan mee naar 31 december, net als de winst', () => {
  // 17 november: 321 van de 365 dagen. 1.100 uur nu is in hetzelfde tempo
  // ruim 1.250 op 31 december. Eerder trok de prognose alleen de winst door,
  // en kreeg wie op koers lag een prognose zonder zelfstandigenaftrek.
  const nu = buildIncomeTaxOverview(inputs({ ownerMinutes: 1100 * 60 }), { basis: 'geboekt', today: TODAY });
  assert.equal(nu?.persons[0].profile.meetsHoursCriterion, false);
  assert.equal(nu?.persons[0].projectedMinutes, null);
  const straks = buildIncomeTaxOverview(inputs({ ownerMinutes: 1100 * 60 }), { basis: 'prognose', today: TODAY });
  assert.equal(straks?.basis, 'prognose');
  assert.equal(straks?.persons[0].projectedMinutes, Math.round(1100 * 60 * 365 / 321));
  assert.equal(straks?.persons[0].profile.meetsHoursCriterion, true);
  assert.equal(straks?.persons[0].estimate.zelfstandigenaftrekCents, E(1200));
  assert.ok(straks?.persons[0].notes.some(n => /nu 1\.100 uur geregistreerd\. In hetzelfde tempo zijn dat er ongeveer 1\.250 op 31 december/.test(n)));
  // Niet op koers: ook in de prognose geen aftrek.
  const laag = buildIncomeTaxOverview(inputs({ ownerMinutes: 600 * 60 }), { basis: 'prognose', today: TODAY });
  assert.equal(laag?.persons[0].profile.meetsHoursCriterion, false);
  // Een eigen keuze wordt niet doorgetrokken.
  const eigen = buildIncomeTaxOverview(inputs({ ownerMinutes: 1100 * 60, profiles: [{ ...defaultIncomeTaxProfile(null), meetsHoursCriterion: false }] }), { basis: 'prognose', today: TODAY });
  assert.equal(eigen?.persons[0].projectedMinutes, null);
  assert.equal(eigen?.persons[0].profile.meetsHoursCriterion, false);
});

test('begonnen in de loop van het jaar: de winst van daarvóór zit er niet in, en dat staat erbij', () => {
  const kort = inputs({
    bookkeepingStartDate: '2026-07-01',
    overlappingFiscalYears: [{ id: 'fy', label: '2026', periodStart: '2026-07-01', periodEnd: '2026-12-31', status: 'open' }],
  });
  const overview = buildIncomeTaxOverview(kort, { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  assert.ok(overview.warnings.some(w => /begint op 1 juli 2026: deze raming telt de winst vanaf die dag/.test(w) && /Overige correctie/.test(w)));
  // Een kort eerste boekjaar valt binnen het kalenderjaar: dat is geen gebroken boekjaar.
  assert.ok(!overview.warnings.some(w => /niet gelijk met het kalenderjaar/.test(w)));
  // Begonnen op 1 januari, of in een eerder jaar: geen melding.
  for (const start of ['2026-01-01', '2024-01-01', null]) {
    const gewoon = buildIncomeTaxOverview(inputs({ bookkeepingStartDate: start }), { basis: 'geboekt', today: TODAY });
    assert.ok(!gewoon?.warnings.some(w => /begint op/.test(w)), String(start));
  }
});

test('KIA: de raming zegt erbij dat je moet nalopen wat meetelt', () => {
  const overview = buildIncomeTaxOverview(inputs({
    investments: [{ assetId: 'a1', name: 'Personenauto', assetNumber: null, acquisitionDate: '2026-03-01', costCents: E(30_000), excluded: false }],
  }), { basis: 'geboekt', today: TODAY });
  assert.equal(overview?.kiaCents, E(8400));
  assert.ok(overview?.persons[0].notes.some(n => /De KIA rekent met € 30\.000,00 aan investeringen uit Activa/.test(n) && /personenauto/.test(n)));
  const uit = buildIncomeTaxOverview(inputs({
    investments: [{ assetId: 'a1', name: 'Personenauto', assetNumber: null, acquisitionDate: '2026-03-01', costCents: E(30_000), excluded: true }],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(!uit?.persons[0].notes.some(n => /De KIA rekent/.test(n)));
});

test('vof: het urencriterium per vennoot uit de uren van zijn teamlid, zoals bij Vennoten', () => {
  const overview = buildIncomeTaxOverview(inputs({
    legalForm: 'cv', isPartnershipForm: true,
    partners: [
      { id: 'a', name: 'Anna', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 5000 },
      { id: 'b', name: 'Bram', partnerNumber: 2, kind: 'beherend', isActive: true, shareBasisPoints: 3000 },
      { id: 'c', name: 'Cas', partnerNumber: 3, kind: 'beherend', isActive: true, shareBasisPoints: 1000 },
      { id: 's', name: 'Stil', partnerNumber: 4, kind: 'commanditair', isActive: true, shareBasisPoints: 1000 },
    ],
    // Anna en Bram hangen aan een teamlid (Bram met te weinig uren), Cas niet;
    // Bram heeft zelf al "ja" opgeslagen. De stille vennoot is geen ondernemer.
    partnerMinutes: { a: 1300 * 60, b: 900 * 60, s: 2000 * 60 },
    profiles: [{ ...defaultIncomeTaxProfile('b'), meetsHoursCriterion: true }],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  const [anna, bram, cas, stil] = overview.persons;
  assert.deepEqual([anna.registeredMinutes, anna.hoursFromTimeTracking, anna.profile.meetsHoursCriterion], [1300 * 60, true, true]);
  assert.equal(anna.estimate.zelfstandigenaftrekCents, E(1200));
  assert.ok(anna.notes.some(n => /het teamlid van deze vennoot heeft 1\.300 uur/.test(n)));
  assert.deepEqual([bram.registeredMinutes, bram.hoursFromTimeTracking, bram.profile.meetsHoursCriterion], [900 * 60, false, true], 'een opgeslagen keuze wint');
  assert.deepEqual([cas.registeredMinutes, cas.hoursFromTimeTracking, cas.profile.meetsHoursCriterion], [null, false, null], 'niet gekoppeld: niet ingevuld');
  assert.deepEqual([stil.registeredMinutes, stil.hoursFromTimeTracking, stil.estimate.entrepreneurDeductionCents], [null, false, 0], 'een commanditaire vennoot telt geen uren');
  // Zonder recht op Uren (null) blijft alles zoals het was.
  const zonder = buildIncomeTaxOverview(inputs({
    legalForm: 'vof', isPartnershipForm: true, partnerMinutes: null,
    partners: [{ id: 'a', name: 'Anna', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 10000 }],
  }), { basis: 'geboekt', today: TODAY });
  assert.deepEqual([zonder?.persons[0].registeredMinutes, zonder?.persons[0].profile.meetsHoursCriterion], [null, null]);
});

// ── De verdeling van het boekjaar (20261122100000) ─────────────────────────

test('voorafgaande verdeling: eerst de arbeidsbeloning, de rest naar rato, tot op de cent', () => {
  // Winst € 100.000; Anna € 30.000 + rente € 2.000, Bram € 10.000 + € 4.000;
  // het restant € 54.000 50/50. Juist is Anna € 59.000 en Bram € 41.000.
  const shares = [
    { key: 'a', basisPoints: 5000, order: 1, priorCents: E(32_000) },
    { key: 'b', basisPoints: 5000, order: 2, priorCents: E(14_000) },
  ];
  assert.deepEqual([...splitWithPrior(E(100_000), shares)], [['a', E(59_000)], ['b', E(41_000)]]);
  // Een restcent naar de grootste rest, zoals fiscal_year_result_shares.
  assert.deepEqual([...splitWithPrior(E(100_000) + 1, shares)], [['a', E(59_000) + 1], ['b', E(41_000)]]);
  // Verlies na de voorafgaande bedragen: het restant is negatief, naar rato.
  assert.deepEqual([...splitWithPrior(E(40_000), shares)], [['a', E(29_000)], ['b', E(11_000)]]);
  // Zonder voorafgaande bedragen precies splitByShares.
  const plain = [{ key: 'a', basisPoints: 6000, order: 1, priorCents: 0 }, { key: 'b', basisPoints: 4000, order: 2, priorCents: 0 }];
  assert.deepEqual([...splitWithPrior(-30_001, plain)], [...splitByShares(-30_001, plain)]);
});

test('vof: de raming rekent met het voorafgaande bedrag uit de verdeling van het boekjaar', () => {
  const overview = buildIncomeTaxOverview(inputs({
    legalForm: 'vof', isPartnershipForm: true, resultCents: E(9_500), splitFixed: true,
    partners: [
      { id: 'a', name: 'Anna', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 6000, priorShareCents: 0 },
      { id: 'b', name: 'Bram', partnerNumber: 2, kind: 'beherend', isActive: true, shareBasisPoints: 4000, priorShareCents: E(6_000) },
    ],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  assert.deepEqual(overview.persons.map(p => p.estimate.profitShareCents), [E(2_100), E(7_400)]);
  assert.ok(overview.persons[1].notes.some(n => /eerst € 6\.000,00 vooraf/.test(n)), overview.persons[1].notes.join(' | '));
});

test('vof: een uitgetreden vennoot die in de verdeling van dat jaar staat, krijgt zijn raming', () => {
  const overview = buildIncomeTaxOverview(inputs({
    year: 2025, legalForm: 'vof', isPartnershipForm: true, resultCents: E(8_000), splitFixed: true, fiscalYearClosed: true,
    overlappingFiscalYears: [{ id: 'fy', label: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31', status: 'closed' }],
    partners: [
      { id: 'a', name: 'Anna', partnerNumber: 1, kind: 'beherend', isActive: true, currentlyActive: true, shareBasisPoints: 5000 },
      { id: 'b', name: 'Bram', partnerNumber: 2, kind: 'beherend', isActive: true, currentlyActive: false, shareBasisPoints: 5000 },
      { id: 'c', name: 'Chris', partnerNumber: 3, kind: 'beherend', isActive: false, currentlyActive: true, shareBasisPoints: 3000 },
    ],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview);
  assert.deepEqual(overview.persons.map(p => [p.name, p.estimate.profitShareCents]), [['Anna', E(4_000)], ['Bram', E(4_000)]]);
  assert.ok(!overview.warnings.some(w => /nog niet vastgelegd/.test(w)));
});

test('vof: een afgesloten jaar neemt het geboekte bedrag over, niet een herberekening', () => {
  // € 1,01 op 60/40 geboekt als € 0,61 en € 0,40; het teruggerekende
  // percentage (60,40%) gaf herrekend andere centen.
  const closed = buildIncomeTaxOverview(inputs({
    year: 2025, legalForm: 'vof', isPartnershipForm: true, resultCents: 101, splitFixed: true, fiscalYearClosed: true,
    overlappingFiscalYears: [{ id: 'fy', label: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31', status: 'closed' }],
    partners: [
      { id: 'a', name: 'Anna', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 6040, bookedShareCents: 61 },
      { id: 'b', name: 'Bram', partnerNumber: 2, kind: 'beherend', isActive: true, shareBasisPoints: 3960, bookedShareCents: 40 },
    ],
  }), { basis: 'geboekt', today: TODAY });
  assert.deepEqual(closed?.persons.map(p => p.estimate.profitShareCents), [61, 40]);
});

test('vof: een voorbij jaar zonder vastgelegde verdeling zegt dat het met de vennoten van nu rekent', () => {
  const overview = buildIncomeTaxOverview(inputs({
    year: 2025, legalForm: 'vof', isPartnershipForm: true, resultCents: E(8_000), splitFixed: false,
    overlappingFiscalYears: [{ id: 'fy', label: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31', status: 'open' }],
    partners: [{ id: 'a', name: 'Anna', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 10000 }],
  }), { basis: 'geboekt', today: TODAY });
  assert.ok(overview?.warnings.some(w => /De verdeling van 2025 is nog niet vastgelegd/.test(w)));
});

test('urencriterium in de prognose: het tempo vanaf de eerste uren, zoals de teller op Vennoten', () => {
  // Carla begon op 1 juni en heeft op 22 november 1.050 uur.
  const total = 1_050 * 60;
  const own = projectMinutesFromFirstEntry(total, '2026-06-01', '2026-11-22', 2026);
  assert.equal(own, projectHourCriterion({ totalMinutes: total, firstEntryDate: '2026-06-01', today: '2026-11-22', year: 2026 }).projectedMinutes);
  assert.ok(own >= 1_225 * 60, `${own / 60} uur`);
  const overview = buildIncomeTaxOverview(inputs({
    legalForm: 'vof', isPartnershipForm: true, resultCents: E(40_000),
    partners: [{ id: 'c', name: 'Carla', partnerNumber: 1, kind: 'beherend', isActive: true, shareBasisPoints: 10000 }],
    partnerMinutes: { c: total }, partnerFirstHourDates: { c: '2026-06-01' },
  }), { basis: 'prognose', today: '2026-11-22' });
  assert.equal(overview?.persons[0].projectedMinutes, own);
  assert.equal(overview?.persons[0].profile.meetsHoursCriterion, true);
  // Zonder uren blijft het wat er staat.
  assert.equal(projectMinutesFromFirstEntry(0, null, '2026-11-22', 2026), 0);
});
