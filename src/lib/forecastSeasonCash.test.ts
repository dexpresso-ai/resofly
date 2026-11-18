/**
 * De prognose: het seizoenspatroon uit vorige jaren en de cashflow
 * (20261118171500). Draaien met:  npm test
 *
 * De rekenregels staan in supabase/functions/_shared/forecast.ts, voor de app
 * en voor Gerrie. De cashflow hieronder is met de hand nagerekend: elke maand
 * staat er wat er binnenkomt, uitgaat en naar de Belastingdienst gaat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEASON_RATIO_CAP, addMonths, applyForecastPatch, computeCashflow, computeForecast, computeSeasonality,
  describeAssumptions, describeCashflow, diffAssumptions, emptyCashPosition, monthsBetween, normalizeAssumptions,
  parseCashPosition, parseForecastInputs, seasonFactor, seasonText, summarizeCashflow,
} from './forecast.ts';
import { paymentTermDays } from './financeRules.ts';
import type { CashPosition, ForecastInputs, HistoryMonth } from './forecast.ts';

const TODAY = '2026-11-18';
const CURRENT = '2026-11';

function row(month: string, values: Partial<HistoryMonth> = {}): HistoryMonth {
  return {
    month, projects: 0, revenue_project_cents: 0, revenue_other_cents: 0, purchase_cents: 0,
    ledger_revenue_cents: 0, ledger_expense_cents: 0, vat_out_cents: 0, vat_in_cents: 0,
    ledger_vat_out_cents: 0, ledger_vat_in_cents: 0, ledger_depreciation_cents: 0, ...values,
  };
}

/** `count` hele maanden tot en met oktober 2026, plus november 2026 (tot nu). */
function history(count: number, per: (month: string, index: number) => Partial<HistoryMonth>, now: Partial<HistoryMonth> = {}): HistoryMonth[] {
  const first = addMonths(CURRENT, -count);
  const months = Array.from({ length: count }, (_, index) => row(addMonths(first, index), per(addMonths(first, index), index)));
  months.push(row(CURRENT, now));
  return months;
}

function inputs(months: HistoryMonth[], extra: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    from: months[0]?.month ?? CURRENT, to: CURRENT, today: TODAY, projects_visible: true, months,
    pipeline: { open_count: 0, open_cents: 0, accepted_count: 0, accepted_cents: 0, won_count: 0, lost_count: 0 },
    cash_fields: true,
    ...extra,
  };
}

/** Een patroon met gemiddeld precies 1: een rustige zomer, een drukke herfst en winter. */
const PATTERN = [0.8, 0.9, 1.0, 1.1, 1.0, 0.9, 0.6, 0.7, 1.1, 1.2, 1.3, 1.4];
const calOf = (month: string) => Number(month.slice(5, 7)) - 1;

// ── Het seizoenspatroon ─────────────────────────────────────────────────────

test('seizoen: uit drie jaar zonder groei komt precies het patroon terug', () => {
  const data = inputs(history(36, (month) => ({ revenue_other_cents: Math.round(1000000 * PATTERN[calOf(month)]) })));
  const season = computeSeasonality(data, TODAY);
  assert.equal(season.available, true);
  assert.equal(season.from, '2023-11');
  assert.equal(season.to, '2026-10');
  assert.equal(season.months, 36);
  season.index.forEach((value, cal) => assert.ok(Math.abs(value - PATTERN[cal]) < 1e-6, `maand ${cal + 1}: ${value} tegen ${PATTERN[cal]}`));
  // Drie jaar, de zes maanden aan elke kant missen: twee metingen per maand.
  assert.deepEqual(season.samples, [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  assert.match(seasonText(season), /^jan 80% · feb 90% · mrt 100% .* dec 140%$/);
});

test('seizoen: groei telt niet als seizoen (30% per jaar)', () => {
  const growth = Math.pow(1.3, 1 / 12);
  const data = inputs(history(36, (month, index) => ({
    revenue_other_cents: Math.round(1000000 * Math.pow(growth, index) * PATTERN[calOf(month)]),
  })));
  const season = computeSeasonality(data, TODAY);
  assert.equal(season.available, true);
  // Het gecentreerde gemiddelde haalt de groei eruit: hooguit anderhalve
  // procentpunt naast het echte patroon.
  season.index.forEach((value, cal) => assert.ok(Math.abs(value - PATTERN[cal]) < 0.015, `maand ${cal + 1}: ${value.toFixed(4)} tegen ${PATTERN[cal]}`));
  // Ter vergelijking de simpele manier: per kalenderjaar elke maand delen door
  // het gemiddelde van dat jaar. Daar wordt groei seizoen: januari te laag,
  // december te hoog.
  const naive = new Array(12).fill(0);
  for (const year of ['2024', '2025']) {
    const months = data.months.filter((month) => month.month.startsWith(year));
    const mean = months.reduce((total, month) => total + month.revenue_other_cents, 0) / 12;
    for (const month of months) naive[calOf(month.month)] += month.revenue_other_cents / mean / 2;
  }
  assert.ok(naive[0] - PATTERN[0] < -0.08, `januari ${naive[0]}`);
  assert.ok(naive[11] - PATTERN[11] > 0.08, `december ${naive[11]}`);
});

test('seizoen: het gemiddelde is altijd 1, en een uitschieter telt hooguit drie keer', () => {
  const data = inputs(history(24, (month, index) => ({ revenue_other_cents: index === 11 ? 20000000 : 1000000 })));
  const season = computeSeasonality(data, TODAY);
  assert.equal(season.available, true);
  const mean = season.index.reduce((total, value) => total + value, 0) / 12;
  assert.ok(Math.abs(mean - 1) < 1e-9);
  // De uitschieter (oktober 2025) is twintig keer een gewone maand. Zonder
  // grenzen kwam oktober uit op bijna vijf keer gewoon en zakten alle maanden
  // eromheen naar 62%: het gemiddelde rond de opdracht ging mee omhoog.
  const october = season.index[9];
  assert.ok(october > 1.5 && october < SEASON_RATIO_CAP, `oktober ${october}`);
  season.index.forEach((value, cal) => { if (cal !== 9) assert.ok(value > 0.8 && value < 1, `maand ${cal + 1}: ${value}`); });
});

test('seizoen: wie twee keer per jaar factureert, krijgt precies dat patroon', () => {
  const data = inputs(history(36, (month) => ({ revenue_other_cents: ['03', '09'].includes(month.slice(5, 7)) ? 6000000 : 0 })));
  const season = computeSeasonality(data, TODAY);
  assert.equal(season.available, true);
  season.index.forEach((value, cal) => assert.ok(Math.abs(value - ([2, 8].includes(cal) ? 6 : 0)) < 1e-9, `maand ${cal + 1}: ${value}`));
});

test('seizoen: minder dan twee jaar omzet is geen patroon, en het begint bij de eerste omzet', () => {
  const young = computeSeasonality(inputs(history(30, (_, index) => ({ revenue_other_cents: index < 10 ? 0 : 1000000 }))), TODAY);
  assert.equal(young.available, false);
  assert.match(young.reason ?? '', /minstens twee hele jaren .* 20 maanden \(vanaf maart 2025\)/);
  assert.deepEqual(young.index, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  const none = computeSeasonality(inputs(history(30, () => ({}))), TODAY);
  assert.equal(none.available, false);
  assert.match(none.reason ?? '', /nog geen omzet/);
});

test('seizoen in de prognose: projecten en overige omzet volgen het patroon, een eigen aantal niet', () => {
  const data = inputs(history(36, (month) => ({
    projects: 2, revenue_project_cents: Math.round(1000000 * PATTERN[calOf(month)]), revenue_other_cents: Math.round(200000 * PATTERN[calOf(month)]),
  })));
  const off = computeForecast({}, data, TODAY);
  const on = computeForecast({ seasonality_pct: 100 }, data, TODAY);
  const half = computeForecast({ seasonality_pct: 50, month_projects: { '2027-07': 1 } }, data, TODAY);
  assert.equal(off.effective.season_applied, false);
  assert.equal(on.effective.season_applied, true);
  const july = (result: typeof on) => result.months.find((month) => month.month === '2027-07')!;
  const december = (result: typeof on) => result.months.find((month) => month.month === '2026-12')!;
  // Juli is 60% van een gewone maand, december 140%.
  assert.ok(Math.abs(july(on).season_factor - 0.6) < 1e-6);
  assert.ok(Math.abs(july(on).projects - off.effective.projects_per_month * 0.6) < 1e-9);
  assert.ok(Math.abs(december(on).revenue_other_cents - Math.round(off.months[1].revenue_other_cents * 1.4)) <= 1);
  // Over een heel jaar verdeelt het seizoen de omzet alleen.
  assert.ok(Math.abs(on.totals.revenue_cents - off.totals.revenue_cents) <= 12);
  // Op 50% half zo sterk; en een eigen aantal projecten houdt zijn aantal.
  assert.ok(Math.abs(december(half).season_factor - 1.2) < 1e-6);
  assert.equal(july(half).projects, 1);
  assert.equal(july(half).projects_set, true);
  assert.equal(seasonFactor(on.season, 0, '2027-07'), 1);
});

test('seizoen: aan zonder patroon rekent gewoon, en zegt waarom in de aannames', () => {
  const data = inputs(history(12, () => ({ revenue_other_cents: 1000000 })));
  const on = computeForecast({ seasonality_pct: 100 }, data, TODAY);
  const off = computeForecast({}, data, TODAY);
  assert.equal(on.effective.season_applied, false);
  assert.equal(on.totals.revenue_cents, off.totals.revenue_cents);
  assert.ok(describeAssumptions(on).some((line) => /^Seizoenspatroon: 100% \(er is nog geen patroon: Een seizoenspatroon heeft minstens twee hele jaren/.test(line)));
  assert.ok(describeAssumptions(off).includes('Seizoenspatroon: uit'));
});

// ── Aannames ────────────────────────────────────────────────────────────────

test('aannames: een oude prognose krijgt de nieuwe velden leeg of uit', () => {
  const old = normalizeAssumptions({ months: 12, growth_pct: 5, items: [{ id: 'post-1', label: 'Huur', kind: 'cost', amount: 100, from: '2027-01' }] });
  assert.equal(old.seasonality_pct, 0);
  assert.equal(old.cash_start, null);
  assert.equal(old.collection_days, null);
  assert.equal(old.vat_sales_pct, null);
  assert.equal(old.vat_costs_pct, null);
  assert.equal(old.noncash_costs, null);
  assert.equal(old.cash_buffer, 0);
  // Een onbekende soort post wordt kosten (zoals voorheen); de nieuwe soorten blijven.
  const kinds = normalizeAssumptions({ items: [
    { label: 'A', kind: 'cash_in', amount: 1, from: '2027-01' },
    { label: 'B', kind: 'cash_out', amount: 1, from: '2027-01' },
    { label: 'C', kind: 'iets', amount: 1, from: '2027-01' },
  ] }).items.map((item) => item.kind);
  assert.deepEqual(kinds, ['cash_in', 'cash_out', 'cost']);
});

test('aannames: seizoen en geld wijzigen, met een reden als het niet kan, en in gewone woorden', () => {
  const { next, changes } = applyForecastPatch({}, {
    seasonality_pct: 100, cash_start: 12000, collection_days: 30, vat_sales_pct: 21, cash_buffer: 5000,
    add_items: [{ label: 'Lening', kind: 'cash_in', amount: 10000, from: '2027-01', to: '2027-01' }, { label: 'Privé', kind: 'cash_out', amount: 2500, from: '2027-01' }],
  });
  assert.equal(next.seasonality_pct, 100);
  assert.equal(next.cash_start, 12000);
  assert.deepEqual(changes, [
    'Seizoenspatroon: uit → 100%',
    'Banksaldo nu: automatisch → € 12.000',
    'Klanten betalen na: automatisch → 30 dagen',
    'Btw op je omzet: automatisch → 21%',
    'Ondergrens saldo: € 0 → € 5.000',
    'Post erbij: Lening: geld erbij € 10.000 per maand, in januari 2027',
    'Post erbij: Privé: geld eraf € 2.500 per maand, vanaf januari 2027',
  ]);
  assert.deepEqual(diffAssumptions(next, { ...next, cash_start: null, collection_days: 1 }), [
    'Banksaldo nu: € 12.000 → automatisch',
    'Klanten betalen na: 30 dagen → 1 dag',
  ]);
  // Rood staan mag als banksaldo; de rest heeft grenzen.
  assert.equal(applyForecastPatch({}, { cash_start: -2500 }).next.cash_start, -2500);
  const refuses = (patch: Record<string, unknown>, reason: RegExp) => assert.throws(() => applyForecastPatch({}, patch), reason);
  refuses({ seasonality_pct: 150 }, /"Seizoenspatroon" moet tussen uit en 100% liggen/);
  refuses({ seasonality_pct: null }, /"Seizoenspatroon" kan niet leeg/);
  refuses({ collection_days: 200 }, /"Klanten betalen na" moet tussen 0 dagen en 180 dagen liggen/);
  refuses({ collection_days: 2.5 }, /heel getal/);
  refuses({ vat_costs_pct: 40 }, /"Btw op je kosten" moet tussen 0% en 30% liggen/);
  refuses({ cash_buffer: -1 }, /"Ondergrens saldo" moet tussen/);
  refuses({ add_items: [{ label: 'Lening', kind: 'cash_in', amount: -5, from: '2027-01' }] }, /de andere kant op/);
});

// ── De cashflow ─────────────────────────────────────────────────────────────

/**
 * Een jaar met elke maand € 10.000 omzet (21% btw) en € 5.000 kosten, waarvan
 * € 1.000 afschrijving; € 4.000 inkoop met € 840 btw. In november tot nu:
 * € 4.000 gefactureerd en € 2.000 kosten.
 */
const STEADY = inputs(history(12, () => ({
  revenue_other_cents: 1000000, purchase_cents: 400000, ledger_expense_cents: 500000, ledger_depreciation_cents: 100000,
  vat_out_cents: 210000, ledger_vat_out_cents: 210000, vat_in_cents: 84000, ledger_vat_in_cents: 84000,
}), {
  revenue_other_cents: 400000, purchase_cents: 150000, ledger_expense_cents: 200000,
  vat_out_cents: 84000, ledger_vat_out_cents: 84000, vat_in_cents: 42000, ledger_vat_in_cents: 42000,
}));

/** € 50.000 op de bank; € 3.000 te laat en € 6.050 in december open; € 1.210 te betalen; btw per kwartaal. */
const POSITION: CashPosition = {
  ...emptyCashPosition(TODAY),
  available: true,
  bank: [{ name: 'Zakelijk', balance_cents: 5000000, method: 'statement', as_of: '2026-11-15' }],
  receivables: [{ month: '2026-10', cents: 300000, count: 1 }, { month: '2026-12', cents: 605000, count: 2 }],
  payables: [{ month: '2026-11', cents: 121000, count: 1 }],
  vat_frequency: 'quarterly',
  vat_returns: [{ period_type: 'quarter', year: 2026, index: 3, status: 'filed', saldo_cents: 400000 }],
  payment_terms_days: 30,
  collection_paid_count: 10,
  collection_days: 15,
};

test('cashflow: elke maand nagerekend (kwartaal-btw, betaaltermijn, openstaande posten)', () => {
  const result = computeForecast({}, STEADY, TODAY);
  const flow = computeCashflow(result, STEADY, POSITION, TODAY);
  assert.equal(flow.available, true);
  assert.equal(flow.effective.start_cents, 5000000);
  assert.equal(flow.effective.collection_days, 15);
  assert.equal(flow.effective.collection_source, 'history');
  assert.equal(flow.effective.vat_sales_pct, 21);
  assert.equal(flow.effective.vat_costs_pct, 21);
  assert.equal(flow.effective.noncash_cents, 100000);
  assert.equal(flow.months.length, 12);
  assert.equal(flow.months[0].month, '2026-11');
  assert.equal(flow.months[0].partial, true);

  const pick = (index: number) => {
    const m = flow.months[index];
    return [m.in_open_cents, m.in_sales_cents, m.out_open_cents, m.out_costs_cents, m.vat_cents, m.other_cents, m.end_cents];
  };
  // November: nog € 6.000 te factureren (+ btw € 7.260): de helft nu; de te
  // late € 3.000 nu; nog € 2.000 kosten zonder afschrijving (+ btw € 2.420);
  // de inkoopfactuur van € 1.210.
  assert.deepEqual(pick(0), [300000, 363000, 121000, 242000, 0, 0, 5300000]);
  // December: de andere helft van november plus de helft van december, en de € 6.050.
  assert.deepEqual(pick(1), [605000, 968000, 0, 484000, 0, 0, 6389000]);
  // Januari: de btw over Q4 2026: oktober € 1.260, november € 420 al + € 840
  // nog, december € 1.260 = € 3.780.
  assert.deepEqual(pick(2), [0, 1210000, 0, 484000, 378000, 0, 6737000]);
  assert.deepEqual(flow.months[2].vat_periods, ['Q4 2026']);
  assert.deepEqual(pick(3), [0, 1210000, 0, 484000, 0, 0, 7463000]);
  assert.equal(flow.months[5].vat_cents, 378000); // april: Q1 2027
  assert.equal(flow.months[8].vat_cents, 378000); // juli: Q2 2027
  assert.equal(flow.months[11].vat_cents, 378000); // oktober: Q3 2027
  assert.equal(flow.end_cents, 12137000);
  assert.deepEqual(flow.lowest, { month: '2026-11', cents: 5300000 });
  assert.equal(flow.below_buffer, null);
  assert.deepEqual(flow.vat_payments.map((payment) => [payment.period, payment.month, payment.cents, payment.source]), [
    ['Q4 2026', '2027-01', 378000, 'estimate'],
    ['Q1 2027', '2027-04', 378000, 'estimate'],
    ['Q2 2027', '2027-07', 378000, 'estimate'],
    ['Q3 2027', '2027-10', 378000, 'estimate'],
  ]);
  assert.deepEqual(flow.open, {
    receivables_cents: 905000, receivables_overdue_cents: 300000, receivables_later_cents: 0,
    payables_cents: 121000, payables_overdue_cents: 0, payables_later_cents: 0,
  });
  // De aangifte over Q3 2026 had in oktober betaald moeten zijn en staat nog op "ingediend".
  assert.ok(flow.notes.some((note) => /aangifte over Q3 2026 \(€ 4\.000\) staat in ResoFly nog niet als betaald/.test(note)));
  assert.ok(flow.notes.some((note) => /€ 3\.000 aan facturen is al te laat/.test(note)));
  // De winst verandert er niet door: de cashflow rekent alleen anders in de tijd.
  assert.equal(result.totals.profit_cents, 12 * 1000000 - 12 * 500000);
  assert.equal(summarizeCashflow(flow), 'Saldo nu € 50.000; laagste € 53.000 eind november 2026; eind oktober 2027 € 121.370; btw naar de Belastingdienst € 15.120.');
});

test('cashflow: zonder betaalgedrag de betaaltermijn, en een aangifte die er al is telt met haar saldo', () => {
  const position: CashPosition = {
    ...POSITION,
    collection_paid_count: 2,
    vat_frequency: 'monthly',
    vat_returns: [{ period_type: 'month', year: 2026, index: 12, status: 'finalized', saldo_cents: 99900 }],
  };
  const flow = computeCashflow(computeForecast({}, STEADY, TODAY), STEADY, position, TODAY);
  assert.equal(flow.effective.collection_source, 'terms');
  assert.equal(flow.effective.collection_days, 30);
  // 30 dagen: alles een maand later. November krijgt dus niets van de nieuwe omzet.
  assert.equal(flow.months[0].in_sales_cents, 0);
  assert.equal(flow.months[1].in_sales_cents, 726000);
  // Per maand: oktober in november (€ 1.260), december met het saldo van de aangifte in januari.
  assert.equal(flow.months[0].vat_cents, 126000);
  assert.deepEqual(flow.months[0].vat_periods, ['oktober 2026']);
  assert.equal(flow.months[2].vat_cents, 99900);
  assert.equal(flow.vat_payments.find((payment) => payment.period === 'december 2026')?.source, 'return');
});

test('cashflow: al betaalde btw gaat er niet nog eens af', () => {
  const monthly: CashPosition = { ...POSITION, vat_frequency: 'monthly', vat_returns: [] };
  const paidAtBank = computeCashflow(computeForecast({}, STEADY, TODAY), STEADY, { ...monthly, tax_payments: [{ date: '2026-11-10', cents: 126000 }] }, TODAY);
  assert.equal(paidAtBank.months[0].vat_cents, 0);
  assert.ok(paidAtBank.notes.some((note) => /btw over oktober 2026 staat er niet in/.test(note)));
  // Een betaling vóór het eind van het tijdvak is niet voor dit tijdvak.
  const earlier = computeCashflow(computeForecast({}, STEADY, TODAY), STEADY, { ...monthly, tax_payments: [{ date: '2026-10-28', cents: 50000 }] }, TODAY);
  assert.equal(earlier.months[0].vat_cents, 126000);
  const paidReturn = computeCashflow(computeForecast({}, STEADY, TODAY), STEADY, {
    ...monthly, vat_returns: [{ period_type: 'month', year: 2026, index: 10, status: 'paid', saldo_cents: 126000 }],
  }, TODAY);
  assert.equal(paidReturn.months[0].vat_cents, 0);
});

test('cashflow: met de KOR geen btw, en de btw-percentages automatisch 0', () => {
  const flow = computeCashflow(computeForecast({}, STEADY, TODAY), STEADY, { ...POSITION, kor: true }, TODAY);
  assert.equal(flow.effective.vat_sales_pct, 0);
  assert.equal(flow.effective.vat_costs_pct, 0);
  assert.equal(flow.totals.vat_cents, 0);
  assert.deepEqual(flow.vat_payments, []);
  assert.equal(flow.months[1].in_sales_cents, 300000 + 500000);
  assert.ok(flow.notes.some((note) => /KOR/.test(note)));
});

test('cashflow: geld erbij en eraf telt alleen in de cashflow; zelf ingevuld gaat voor automatisch', () => {
  const assumptions = {
    cash_start: 20000, collection_days: 0, vat_sales_pct: 0, vat_costs_pct: 0, noncash_costs: 0, cash_buffer: 10000,
    items: [
      { id: 'post-1', label: 'Investering', kind: 'cash_out', amount: 15000, from: '2027-02', to: '2027-02' },
      { id: 'post-2', label: 'Lening', kind: 'cash_in', amount: 5000, from: '2027-01', to: '2027-01' },
    ],
  };
  const result = computeForecast(assumptions, STEADY, TODAY);
  const plain = computeForecast({ ...assumptions, items: [] }, STEADY, TODAY);
  assert.equal(result.totals.profit_cents, plain.totals.profit_cents);
  const flow = computeCashflow(result, STEADY, { ...POSITION, vat_returns: [], receivables: [], payables: [] }, TODAY);
  assert.equal(flow.effective.start_cents, 2000000);
  assert.equal(flow.effective.start_auto, false);
  assert.equal(flow.effective.collection_source, 'set');
  assert.equal(flow.months[2].other_cents, 500000);
  assert.equal(flow.months[3].other_cents, -1500000);
  // Zonder btw en zonder afschrijving: november € 6.000 erin, € 3.000 kosten (€ 5.000 − € 2.000 al).
  assert.equal(flow.months[0].in_sales_cents, 600000);
  assert.equal(flow.months[0].out_costs_cents, 300000);
  // Ook met 0% voor de toekomst gaat in januari de btw over Q4 eruit die er al
  // is: oktober € 1.260 en november tot nu € 420. Die facturen hadden btw.
  assert.equal(flow.months[2].vat_cents, 168000);
  const feb = flow.months[3];
  assert.equal(feb.end_cents, 2000000 + 300000 + 500000 + (500000 - 168000 + 500000) + (500000 - 1500000));
  assert.equal(flow.below_buffer, null);
  const tight = computeCashflow(computeForecast({ ...assumptions, cash_start: 5000 }, STEADY, TODAY), STEADY, { ...POSITION, vat_returns: [], receivables: [], payables: [] }, TODAY);
  assert.equal(tight.months[0].end_cents, 800000);
  assert.equal(tight.below_buffer, '2026-11');
  assert.ok(describeCashflow(flow).includes('Ondergrens saldo: € 10.000'));
});

test('cashflow: zonder banksaldo rekent hij vanaf nul en zegt dat; onbekende rekeningen worden genoemd', () => {
  const noBank = computeCashflow(computeForecast({}, STEADY, TODAY), STEADY, { ...POSITION, bank: [] }, TODAY);
  assert.equal(noBank.effective.start_known, false);
  assert.equal(noBank.effective.start_cents, 0);
  assert.equal(noBank.below_buffer, null);
  assert.match(noBank.notes[0], /weet je banksaldo niet/);
  const partly = computeCashflow(computeForecast({}, STEADY, TODAY), STEADY, {
    ...POSITION, bank: [...POSITION.bank, { name: 'Spaar', balance_cents: null, method: null, as_of: null }], cash_accounts_cents: 2500,
  }, TODAY);
  assert.equal(partly.effective.start_cents, 5002500);
  assert.deepEqual(partly.unknown_accounts, ['Spaar']);
  assert.match(partly.notes[0], /Van Spaar weet ResoFly het saldo niet/);
});

test('cashflow: niet zonder de database, en alleen voor een prognose die nu loopt', () => {
  const result = computeForecast({}, STEADY, TODAY);
  const missing = computeCashflow(result, STEADY, emptyCashPosition(TODAY), TODAY);
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? '', /nog niet aan/);
  const later = computeCashflow(computeForecast({ start_month: '2027-03' }, STEADY, TODAY), STEADY, POSITION, TODAY);
  assert.equal(later.available, false);
  assert.match(later.reason ?? '', /begint pas in maart 2027/);
  const over = computeCashflow(computeForecast({ start_month: '2025-01', months: 6 }, STEADY, TODAY), STEADY, POSITION, TODAY);
  assert.equal(over.available, false);
  assert.match(over.reason ?? '', /al afgelopen/);
  // Begon eerder en loopt nog: vanaf nu tot het eind.
  const started = computeCashflow(computeForecast({ start_month: '2026-09', months: 6 }, STEADY, TODAY), STEADY, POSITION, TODAY);
  assert.deepEqual(started.months.map((month) => month.month), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.equal(monthsBetween(started.months[0].month, started.months[3].month), 3);
});

test('cashflow: deze maand al meer gefactureerd dan verwacht geeft geen negatieve omzet', () => {
  const busy = inputs(STEADY.months.map((month) => (month.month === CURRENT ? { ...month, revenue_other_cents: 1500000, purchase_cents: 900000, ledger_expense_cents: 900000 } : month)));
  const flow = computeCashflow(computeForecast({}, busy, TODAY), busy, POSITION, TODAY);
  assert.equal(flow.months[0].in_sales_cents, 0);
  assert.equal(flow.months[0].out_costs_cents, 0);
});

test('cashposition lezen: tekst wordt een getal, rommel valt weg, een onbekend saldo blijft onbekend', () => {
  const parsed = parseCashPosition({
    today: '2026-11-18',
    bank: [{ name: ' ING ', balance_cents: '123456', method: 'statement', as_of: '2026-11-15' }, { name: 'Oud', balance_cents: null, method: 'x', as_of: 'gisteren' }, 'onzin'],
    cash_accounts_cents: '2500',
    receivables: [{ month: '2026-12', cents: '1000', count: 1 }, { month: 'later', cents: 5 }],
    payables: [],
    vat_frequency: 'monthly', kor: false,
    vat_returns: [{ period_type: 'quarter', year: 2026, index: 3, status: 'filed', saldo_cents: '48300' }, { period_type: 'jaar' }],
    tax_payments: [{ date: '2026-11-10', cents: 100 }, { date: 'nooit', cents: 5 }],
    payment_terms_days: 400,
    collection: { paid_count: 7, days: '23.5' },
  }, TODAY);
  assert.equal(parsed.available, true);
  assert.deepEqual(parsed.bank, [
    { name: 'ING', balance_cents: 123456, method: 'statement', as_of: '2026-11-15' },
    { name: 'Oud', balance_cents: null, method: null, as_of: null },
  ]);
  assert.equal(parsed.cash_accounts_cents, 2500);
  assert.deepEqual(parsed.receivables, [{ month: '2026-12', cents: 1000, count: 1 }]);
  assert.equal(parsed.vat_frequency, 'monthly');
  assert.equal(parsed.vat_returns.length, 1);
  assert.equal(parsed.vat_returns[0].saldo_cents, 48300);
  assert.deepEqual(parsed.tax_payments, [{ date: '2026-11-10', cents: 100 }]);
  assert.equal(parsed.payment_terms_days, 120);
  assert.equal(parsed.collection_days, 23.5);
  assert.equal(parseCashPosition(null, TODAY).available, false);
});

test('historie lezen: zonder btw-velden (oude database) is de btw onbekend, niet nul', () => {
  const old = parseForecastInputs({ months: [{ month: '2026-10', revenue_other_cents: 1000000, purchase_cents: 400000 }] }, TODAY);
  assert.equal(old.cash_fields, false);
  const result = computeForecast({}, old, TODAY);
  assert.equal(result.baseline.vat_sales_pct, null);
  const flow = computeCashflow(result, old, POSITION, TODAY);
  assert.equal(flow.effective.vat_sales_pct, 21);
  assert.ok(flow.notes.some((note) => /btw van de maanden die al voorbij zijn, is nog niet bekend/.test(note)));
  const now = parseForecastInputs({ months: [{ month: '2026-10', revenue_other_cents: 1000000, vat_out_cents: 90000 }] }, TODAY);
  assert.equal(now.cash_fields, true);
  assert.equal(computeForecast({}, now, TODAY).baseline.vat_sales_pct, 9);
});

test('de betaaltermijn uit de tekst: dezelfde regel als de factuur (financeRules) en de database', () => {
  // forecast_cash_position leest "30 dagen" met dezelfde regel als
  // paymentTermDays; hier de gevallen die de databasetest niet ziet.
  assert.equal(paymentTermDays('Betalen binnen 30 dagen'), 30);
  assert.equal(paymentTermDays('14 dag'), 14);
  assert.equal(paymentTermDays('net 45 days'), 45);
  assert.equal(paymentTermDays('direct'), 14);
  assert.equal(paymentTermDays('999 dagen'), 120);
});
