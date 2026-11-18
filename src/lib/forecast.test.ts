/**
 * De prognose: maanden, bedragen als tekst, herstellen en controleren van de
 * aannames, het leerjaar en de prognose zelf. Draaien met:  npm test
 *
 * De rekenregels staan één keer, in supabase/functions/_shared/forecast.ts:
 * de app (dit bestand importeert via src/lib/forecast.ts) en Gerrie rekenen
 * er allebei mee. De laatste test bewaakt dat dat bestand puur blijft.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as app from './forecast.ts';
import * as server from '../../supabase/functions/_shared/forecast.ts';
import type { ForecastInputs, HistoryMonth } from './forecast.ts';

const {
  DEFAULT_ASSUMPTIONS, ForecastInputError, addMonths, applyForecastPatch, changeNote, computeBaseline, computeForecast,
  describeAssumptions, diffAssumptions, euroText, historyRange, monthLabel, monthsBetween, normalizeAssumptions,
  numberText, parseForecastInputs, pctText, summarizeForecast, wholeEuroText,
} = app;

const TODAY = '2026-11-18';

/** Twaalf hele maanden vóór november 2026, elk met dezelfde cijfers tenzij `per` iets anders zegt. */
function year(row: Partial<HistoryMonth>, per: (month: string, index: number) => Partial<HistoryMonth> = () => ({})): HistoryMonth[] {
  return Array.from({ length: 12 }, (_, index) => {
    const month = addMonths('2025-11', index);
    return {
      month, projects: 0, revenue_project_cents: 0, revenue_other_cents: 0, purchase_cents: 0,
      ledger_revenue_cents: 0, ledger_expense_cents: 0, ...row, ...per(month, index),
    };
  });
}

function inputs(months: HistoryMonth[], extra: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    from: months[0]?.month ?? '2025-11', to: '2026-11', today: TODAY, projects_visible: true, months,
    pipeline: { open_count: 0, open_cents: 0, accepted_count: 0, accepted_cents: 0, won_count: 0, lost_count: 0 },
    ...extra,
  };
}

/** Een gewoon bureau: elke maand twee projecten van € 5.000, € 2.000 overige omzet en € 7.000 kosten. */
const STEADY = inputs(year({ projects: 2, revenue_project_cents: 1000000, revenue_other_cents: 200000, purchase_cents: 300000, ledger_expense_cents: 700000 }));

// ── Maanden en tekst ────────────────────────────────────────────────────────

test('maanden: optellen over de jaargrens, afstand en namen', () => {
  assert.equal(addMonths('2026-11', 2), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-05', 0), '2026-05');
  assert.equal(monthsBetween('2025-11', '2026-10'), 11);
  assert.equal(monthsBetween('2027-01', '2026-12'), -1);
  assert.equal(monthLabel('2027-03'), 'maart 2027');
  assert.equal(monthLabel('2027-03', 'short'), 'mrt 2027');
  assert.equal(monthLabel('onzin'), 'onzin');
});

test('bedragen en getallen als tekst, zonder Intl: Deno en de browser schrijven dezelfde zin', () => {
  assert.equal(euroText(0), '€ 0');
  assert.equal(euroText(125000), '€ 1.250');
  assert.equal(euroText(125050), '€ 1.250,50');
  assert.equal(euroText(125005), '€ 1.250,05');
  assert.equal(euroText(-30000), '€ -300');
  assert.equal(euroText(123456789), '€ 1.234.567,89');
  assert.equal(wholeEuroText(2018145), '€ 20.181', 'de kaart en de pagina: hele euro\'s');
  assert.equal(wholeEuroText(-1224691), '€ -12.247');
  assert.equal(numberText(2.41666, 1), '2,4');
  assert.equal(numberText(3, 1), '3');
  assert.equal(numberText(1234.5, 1), '1.234,5');
  assert.equal(numberText(-0.04, 1), '0', 'geen "-0"');
  assert.equal(pctText(10), '10%');
  assert.equal(pctText(2.5), '2,5%');
});

// ── Aannames: herstellen bij het lezen ─────────────────────────────────────

test('herstellen: onzin wordt de standaard, getallen worden afgekapt, posten krijgen een id', () => {
  for (const raw of [undefined, null, 'tekst', 12, [], {}]) assert.deepEqual(normalizeAssumptions(raw), DEFAULT_ASSUMPTIONS);
  const fixed = normalizeAssumptions({
    months: 99, growth_pct: -500, start_month: '2027-13', projects_per_month: '3', revenue_per_project: '4500,50',
    month_projects: { '2027-01': 2, onzin: 3, '2027-02': 'veel' },
    items: [
      { id: 'post-1', label: '  Huur   kantoor ', kind: 'cost', amount: 1200, from: '2027-01', to: '2026-12' },
      { id: 'post-1', label: 'Dubbele id', kind: 'revenue', amount: 5, from: '2027-01' },
      { label: '', kind: 'cost', amount: 1, from: '2027-01' },
      { label: 'Zonder begin', kind: 'cost', amount: 1 },
    ],
  });
  assert.equal(fixed.months, 36);
  assert.equal(fixed.growth_pct, -90);
  assert.equal(fixed.start_month, null);
  assert.equal(fixed.projects_per_month, 3);
  assert.equal(fixed.revenue_per_project, 4500.5);
  assert.deepEqual(fixed.month_projects, { '2027-01': 2 });
  assert.deepEqual(fixed.items, [
    { id: 'post-1', label: 'Huur kantoor', kind: 'cost', amount: 1200, from: '2027-01', to: '2027-01' },
    { id: 'post-2', label: 'Dubbele id', kind: 'revenue', amount: 5, from: '2027-01', to: null },
  ]);
});

// ── Aannames: een wijziging van Gerrie, de MCP of de API ───────────────────

test('wijzigen: wat er verandert, in gewone woorden en in een vaste volgorde', () => {
  const { next, changes } = applyForecastPatch(DEFAULT_ASSUMPTIONS, {
    growth_pct: 10,
    projects_per_month: 3,
    add_items: [{ label: 'Nieuwe medewerker', kind: 'cost', amount: 3500, from: '2027-03' }],
    month_projects: { '2027-08': 1, '2027-07': 1 },
  });
  assert.equal(next.growth_pct, 10);
  assert.equal(next.projects_per_month, 3);
  assert.deepEqual(next.items, [{ id: 'post-1', label: 'Nieuwe medewerker', kind: 'cost', amount: 3500, from: '2027-03', to: null }]);
  assert.deepEqual(changes, [
    'Nieuwe projecten per maand: automatisch → 3',
    'Groei per jaar: 0% → 10%',
    'Juli 2027: 1 nieuw project',
    'Augustus 2027: 1 nieuw project',
    'Post erbij: Nieuwe medewerker: kosten € 3.500 per maand, vanaf maart 2027',
  ]);

  const second = applyForecastPatch(next, {
    projects_per_month: null,
    month_projects: { '2027-07': null },
    update_items: [{ id: 'post-1', amount: '4000' }],
    add_items: [{ label: 'Grote opdracht', kind: 'revenue', amount: 12000, from: '2027-01', to: '2027-01' }],
  });
  assert.deepEqual(second.changes, [
    'Nieuwe projecten per maand: 3 → automatisch',
    'Juli 2027: weer volgens de verwachting',
    'Post aangepast: Nieuwe medewerker: kosten € 4.000 per maand, vanaf maart 2027',
    'Post erbij: Grote opdracht: omzet € 12.000 per maand, in januari 2027',
  ]);
  assert.equal(second.next.items[1].id, 'post-2');

  const third = applyForecastPatch(second.next, { remove_item_ids: ['post-1'], start_month: '2027-01', months: 24 });
  assert.deepEqual(third.changes, [
    'Begin: deze maand (schuift mee) → januari 2027',
    'Aantal maanden vooruit: 12 maanden → 24 maanden',
    'Post weg: Nieuwe medewerker',
  ]);
  assert.deepEqual(applyForecastPatch(third.next, { growth_pct: 10 }).changes, [], 'niets veranderd, niets te melden');
  assert.equal(applyForecastPatch(DEFAULT_ASSUMPTIONS, { projects_per_month: '2,5' }).next.projects_per_month, 2.5, 'een komma mag');
});

test('wijzigen: onzin wordt geweigerd met een reden die het model begrijpt', () => {
  const refuses = (patch: unknown, fragment: RegExp) => {
    assert.throws(() => applyForecastPatch(DEFAULT_ASSUMPTIONS, patch), (error: unknown) => {
      assert.ok(error instanceof ForecastInputError, `geen ForecastInputError voor ${JSON.stringify(patch)}`);
      assert.match((error as Error).message, fragment);
      return true;
    });
  };
  refuses('groei', /object/);
  refuses({ growth_pct: 500 }, /Groei per jaar.*tussen -90% en 300%/);
  refuses({ months: null }, /kan niet leeg/);
  refuses({ months: 2.5 }, /heel getal/);
  refuses({ revenue_per_project: 'veel' }, /moet een getal zijn/);
  refuses({ start_month: '2027-13' }, /JJJJ-MM/);
  refuses({ month_projects: { juli: 1 } }, /JJJJ-MM/);
  refuses({ month_projects: [1] }, /object/);
  refuses({ remove_item_ids: ['post-9'] }, /forecast\.list/);
  refuses({ update_items: [{ id: 'post-9', amount: 1 }] }, /forecast\.list/);
  refuses({ add_items: [{ label: '', kind: 'cost', amount: 1, from: '2027-01' }] }, /naam/);
  refuses({ add_items: [{ label: 'Huur', kind: 'uitgave', amount: 1, from: '2027-01' }] }, /revenue \(omzet\) of cost \(kosten\)/);
  refuses({ add_items: [{ label: 'Huur', kind: 'cost', amount: -5, from: '2027-01' }] }, /andere soort/);
  refuses({ add_items: [{ label: 'Huur', kind: 'cost', amount: 5, from: '2027-05', to: '2027-01' }] }, /vóór de eerste/);
  refuses({ add_items: Array.from({ length: 51 }, (_, i) => ({ label: `Post ${i}`, kind: 'cost', amount: 1, from: '2027-01' })) }, /Hooguit 50/);
});

test('verschillen tussen twee standen en de regel voor de geschiedenis', () => {
  const after = { ...DEFAULT_ASSUMPTIONS, fixed_costs: 8000, variable_cost_pct: 25 };
  assert.deepEqual(diffAssumptions(DEFAULT_ASSUMPTIONS, after), [
    'Vaste kosten per maand: automatisch → € 8.000',
    'Kosten die meegroeien met de omzet: 0% → 25%',
  ]);
  assert.deepEqual(diffAssumptions(after, after), []);
  assert.equal(changeNote(['a', 'b'], 'Via Gerrie: '), 'Via Gerrie: a; b');
  assert.equal(changeNote(['x'.repeat(600)]).length, 480);
});

// ── Het leerjaar ────────────────────────────────────────────────────────────

test('leerjaar: het gemiddelde van de twaalf hele maanden vóór deze maand', () => {
  const baseline = computeBaseline(STEADY, TODAY);
  assert.equal(baseline.from, '2025-11');
  assert.equal(baseline.to, '2026-10');
  assert.equal(baseline.months, 12);
  assert.equal(baseline.projects, 24);
  assert.equal(baseline.projects_per_month, 2);
  assert.equal(baseline.revenue_per_project_cents, 500000);
  assert.equal(baseline.other_revenue_cents, 200000);
  assert.equal(baseline.fixed_costs_cents, 700000, 'de boekhouding wint van de inkoopfacturen die erin zitten');
  assert.equal(baseline.cost_source, 'ledger');
});

test('leerjaar: een jong bedrijf deelt niet door twaalf, en zonder boekhouding tellen de inkoopfacturen', () => {
  const young = inputs(year({}, (_, index) => (index >= 8 ? { projects: 1, revenue_project_cents: 300000, purchase_cents: 100000 } : {})));
  const baseline = computeBaseline(young, TODAY);
  assert.equal(baseline.from, '2026-07');
  assert.equal(baseline.months, 4);
  assert.equal(baseline.projects_per_month, 1);
  assert.equal(baseline.revenue_per_project_cents, 300000);
  assert.equal(baseline.fixed_costs_cents, 100000);
  assert.equal(baseline.cost_source, 'purchases');

  const mixed = inputs(year({ purchase_cents: 100000 }, (_, index) => (index % 2 === 0 ? { ledger_expense_cents: 500000 } : {})));
  assert.equal(computeBaseline(mixed, TODAY).cost_source, 'mixed');
  assert.equal(computeBaseline(mixed, TODAY).fixed_costs_cents, 300000);

  const nothing = computeBaseline(inputs(year({})), TODAY);
  assert.equal(nothing.months, 0);
  assert.equal(nothing.from, null);
  assert.equal(nothing.cost_source, 'none');
});

test('leerjaar: zonder leesrecht op Projecten is alle omzet overige omzet', () => {
  const hidden = inputs(year({ projects: null, revenue_project_cents: 600000, revenue_other_cents: 100000 }), { projects_visible: false });
  const baseline = computeBaseline(hidden, TODAY);
  assert.equal(baseline.projects, null);
  assert.equal(baseline.projects_per_month, 0);
  assert.equal(baseline.other_revenue_cents, 700000);
  const result = computeForecast(DEFAULT_ASSUMPTIONS, hidden, TODAY);
  assert.equal(result.months[0].projects, 0);
  assert.equal(result.months[0].revenue_cents, 700000);
  assert.ok(!summarizeForecast(result).includes('projecten'), 'geen nul projecten noemen die je niet mag zien');
});

// ── De prognose ─────────────────────────────────────────────────────────────

test('automatisch en zonder groei: elke maand precies het gemiddelde van het afgelopen jaar', () => {
  const result = computeForecast(DEFAULT_ASSUMPTIONS, STEADY, TODAY);
  assert.equal(result.effective.start_month, '2026-11');
  assert.equal(result.effective.end_month, '2027-10');
  assert.equal(result.months.length, 12);
  for (const month of result.months) {
    assert.equal(month.projects, 2);
    assert.equal(month.revenue_cents, 1200000);
    assert.equal(month.costs_cents, 700000);
    assert.equal(month.profit_cents, 500000);
  }
  assert.deepEqual(result.totals, { projects: 24, revenue_cents: 14400000, costs_cents: 8400000, profit_cents: 6000000, margin_pct: 41.7 });
  assert.deepEqual(result.totals, result.history_totals);
  assert.equal(result.months[11].cumulative_profit_cents, 6000000);
  assert.equal(summarizeForecast(result), '12 maanden (nov 2026 t/m okt 2027): 24 nieuwe projecten, omzet € 144.000, kosten € 84.000, winst € 60.000 (41,7%).');
  assert.ok(describeAssumptions(result).includes('Nieuwe projecten per maand: 2 (automatisch, uit je cijfers)'));
});

test('groei, kostenstijging en meegroeiende kosten', () => {
  const result = computeForecast({ months: 13, growth_pct: 10, cost_increase_pct: 12, variable_cost_pct: 20 }, STEADY, TODAY);
  const first = result.months[0];
  assert.equal(first.revenue_cents, 1200000);
  assert.equal(first.costs_variable_cents, 240000);
  assert.equal(first.costs_cents, 940000);
  const afterYear = result.months[12];
  assert.equal(afterYear.revenue_projects_cents, 1100000, 'een jaar later 10% meer projecten');
  assert.equal(afterYear.revenue_other_cents, 220000, 'en 10% meer overige omzet');
  assert.equal(afterYear.costs_fixed_cents, 784000, 'vaste kosten 12% hoger');
  assert.equal(afterYear.costs_variable_cents, 264000);
  assert.ok(result.months[6].revenue_cents > first.revenue_cents && result.months[6].revenue_cents < afterYear.revenue_cents, 'geleidelijk');
});

test('omzet van een project verdeeld over maanden, een eigen aantal in een maand, extra posten', () => {
  const result = computeForecast({
    project_months: 3,
    month_projects: { '2027-01': 5 },
    items: [
      { id: 'post-1', label: 'Grote opdracht', kind: 'revenue', amount: 10000, from: '2027-01', to: '2027-01' },
      { id: 'post-2', label: 'Nieuwe medewerker', kind: 'cost', amount: 3500, from: '2027-03', to: null },
    ],
  }, STEADY, TODAY);
  const byMonth = Object.fromEntries(result.months.map((month) => [month.month, month]));
  assert.equal(byMonth['2026-11'].revenue_projects_cents, 1000000, 'geen dip aan het begin');
  assert.equal(byMonth['2027-01'].projects, 5);
  assert.equal(byMonth['2027-01'].projects_set, true);
  assert.equal(byMonth['2027-01'].revenue_projects_cents, 1500000, '(5 + 2 + 2) projecten / 3 × € 5.000');
  assert.equal(byMonth['2027-02'].revenue_projects_cents, 1500000);
  assert.equal(byMonth['2027-03'].revenue_projects_cents, 1500000);
  assert.equal(byMonth['2027-04'].revenue_projects_cents, 1000000);
  assert.equal(byMonth['2027-01'].revenue_items_cents, 1000000);
  assert.equal(byMonth['2027-02'].revenue_items_cents, 0, 'een eenmalige post telt één maand');
  assert.equal(byMonth['2027-02'].costs_items_cents, 0);
  assert.equal(byMonth['2027-03'].costs_items_cents, 350000);
  assert.equal(byMonth['2027-10'].costs_items_cents, 350000, 'zonder einde tot het eind van de prognose');
});

test('een prognose die al begon: werkelijk naast verwacht', () => {
  const months = year({ projects: 2, revenue_project_cents: 1000000, revenue_other_cents: 200000, ledger_expense_cents: 700000 }, (month) => (
    month === '2026-10' ? { revenue_project_cents: 400000 } : {}
  ));
  months.push({ month: '2026-11', projects: 1, revenue_project_cents: 100000, revenue_other_cents: 0, purchase_cents: 0, ledger_revenue_cents: 0, ledger_expense_cents: 50000 });
  const result = computeForecast({ start_month: '2026-09', months: 6 }, inputs(months), TODAY);
  assert.deepEqual(result.months.map((month) => month.month), ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(result.months[1].actual, { projects: 2, revenue_cents: 600000, costs_cents: 700000, profit_cents: -100000, complete: true });
  assert.equal(result.months[2].actual?.complete, false, 'deze maand loopt nog');
  assert.equal(result.months[3].actual, null);
  assert.equal(result.so_far?.months, 2);
  assert.equal(result.so_far?.actual.revenue_cents, 1800000);
  // Het leerjaar telt oktober mee: (11 × € 10.000 + € 4.000) / 24 projecten = € 4.750
  // per project, dus per maand 2 × € 4.750 + € 2.000 = € 11.500.
  assert.equal(result.effective.revenue_per_project_cents, 475000);
  assert.equal(result.so_far?.expected.revenue_cents, 2300000);
});

test('welke maanden de app en Gerrie opvragen: het leerjaar plus een eerder begin, nooit meer dan vier jaar', () => {
  assert.deepEqual(historyRange(TODAY, []), { from: '2025-11', to: '2026-11' });
  assert.deepEqual(historyRange(TODAY, [null, '2026-03', '2025-02']), { from: '2025-02', to: '2026-11' });
  assert.deepEqual(historyRange(TODAY, ['2010-01']), { from: '2022-11', to: '2026-11' });
});

test('het antwoord van forecast_history lezen: tekst wordt een getal, ontbrekend wordt nul', () => {
  const parsed = parseForecastInputs({
    from: '2026-09', to: '2026-10', today: '2026-11-18', projects_visible: true,
    months: [
      { month: '2026-10', projects: '1', revenue_project_cents: '120000', revenue_other_cents: null },
      { month: '2026-09', projects: 2, revenue_project_cents: 5 },
      { month: 'onzin', projects: 9 },
    ],
    pipeline: { open_count: 1, open_cents: '600000' },
  }, TODAY);
  assert.deepEqual(parsed.months.map((row) => row.month), ['2026-09', '2026-10']);
  assert.equal(parsed.months[1].projects, 1);
  assert.equal(parsed.months[1].revenue_project_cents, 120000);
  assert.equal(parsed.months[1].revenue_other_cents, 0);
  assert.equal(parsed.pipeline.open_cents, 600000);
  assert.equal(parsed.pipeline.accepted_count, 0);
  const hidden = parseForecastInputs({ projects_visible: false, months: [{ month: '2026-10', projects: 3 }] }, TODAY);
  assert.equal(hidden.months[0].projects, null, 'wie Projecten niet mag lezen, krijgt geen aantal');
  assert.deepEqual(parseForecastInputs(null, TODAY).months, []);
});

// ── Eén bestand voor de app en de server ───────────────────────────────────

test('de app rekent met precies de regels van Gerrie: hetzelfde bestand, en dat blijft puur', () => {
  assert.equal(app.computeForecast, server.computeForecast);
  assert.equal(app.applyForecastPatch, server.applyForecastPatch);
  const source = readFileSync(new URL('../../supabase/functions/_shared/forecast.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(code, /^\s*import\s/m, 'geen imports: de browserbundel moet dit bestand kunnen laden');
  assert.doesNotMatch(code, /\bimport\(/, 'ook geen dynamische imports');
  assert.doesNotMatch(code, /\bDeno\./, 'geen Deno in de app');
  assert.doesNotMatch(code, /\b(window|document|localStorage)\b/, 'geen browser op de server');
  assert.doesNotMatch(code, /\bIntl\b|toLocaleString/, 'geen Intl: dezelfde tekst in Deno, node en de browser');
});
