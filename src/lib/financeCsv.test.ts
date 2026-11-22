/**
 * De CSV van de btw-aangifte per tijdvak en van de kapitaalvergelijking. Tot
 * november 2026 waren die alleen van het scherm over te nemen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { OwnersEquityOverview, VatReturnRubrieken } from '../types';
import { equityCsvRows, incomeTaxSummaryCsvRows, vatReturnCsvRows } from './financeCsv.ts';
import { buildCsv } from './csv.ts';

const BOXES = [
  { box: '1a', label: 'Leveringen/diensten belast met hoog tarief', hasVat: true, alwaysShow: true },
  { box: '1b', label: 'Leveringen/diensten belast met laag tarief', hasVat: true, alwaysShow: true },
  { box: '1c', label: 'Leveringen/diensten belast met overige tarieven', hasVat: true, alwaysShow: false },
  { box: '1e', label: 'Leveringen/diensten belast met 0% of niet bij u belast', hasVat: false, alwaysShow: true },
  { box: '3b', label: 'Leveringen naar/diensten in landen binnen de EU', hasVat: false, alwaysShow: false },
];

test('btw-aangifte: de rubrieken met grondslag, btw en wat je invult in hele euro’s', () => {
  const r = {
    omzet_hoog_base: 0, omzet_hoog_btw: 0, omzet_laag_base: 0, omzet_laag_btw: 0, omzet_nul_base: 0, verlegd_btw: 0,
    verschuldigd_total: 21945, voorbelasting: 1050, saldo: 20895, saldo_afgerond: 20900,
    boxes: { '1a': { base: 100050, vat: 21011 }, '1b': { base: 10000, vat: 900 }, '1c': { base: 0, vat: 0 }, '1e': { base: 0 }, '3b': { base: 50000 } },
    form: { '1a': { base: 1001, vat: 210 }, '1b': { base: 100, vat: 9 }, '1e': { base: 0 }, '3b': { base: 500 }, '5a': 219, '5b': 10, '5c': 209 },
  } as unknown as VatReturnRubrieken;
  const rows = vatReturnCsvRows(r, BOXES);
  assert.deepEqual(rows.map(row => row[0]), ['1a', '1b', '1e', '3b', '5a', '5b', '5c', '5g'], 'een lege 1c valt weg, net als op het scherm');
  assert.deepEqual(rows[0], ['1a', BOXES[0].label, '1000.50', '210.11', '1001', '210']);
  assert.deepEqual(rows[3], ['3b', BOXES[4].label, '500.00', '', '500', '']);
  assert.deepEqual(rows.at(-1), ['5g', 'Totaal te betalen', '', '209.00', '', '']);
  // In de download een komma als decimaalteken, voor Excel (NL).
  assert.match(buildCsv(['a'], rows), /"1000,50";"210,11"/);
});

test('btw-aangifte van vóór de rubriekverdeling: de vaste regels van toen', () => {
  const r = { omzet_hoog_base: 10000, omzet_hoog_btw: 2100, omzet_laag_base: 0, omzet_laag_btw: 0, omzet_nul_base: 0, verlegd_btw: 0, verschuldigd_total: 2100, voorbelasting: 2500, saldo: -400 } as VatReturnRubrieken;
  const rows = vatReturnCsvRows(r, BOXES);
  assert.deepEqual(rows[0], ['1a', 'Leveringen/diensten 21%', '100.00', '21.00', '', '']);
  assert.deepEqual(rows.at(-1), ['5g', 'Totaal terug te vragen', '', '4.00', '', '']);
});

test('kapitaalvergelijking: per vennoot, het deel zonder vennoot en het totaal', () => {
  const overview = {
    fiscalYear: { id: 'f', label: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31', status: 'closed' },
    isPartnership: true, resultCents: 300000,
    owners: [
      { partnerId: 'a', name: 'Anna', isActive: true, shareBasisPoints: 6000, beginCents: 100000, resultShareCents: 180000, contributionsCents: 0, withdrawalsCents: 50000, otherMovementsCents: 0, endCents: 230000 },
      { partnerId: 'b', name: 'Bram', isActive: false, shareBasisPoints: 4000, beginCents: 50000, resultShareCents: 120000, contributionsCents: 10000, withdrawalsCents: 0, otherMovementsCents: 0, endCents: 180000 },
    ],
    unassigned: { beginCents: 2000, movementsCents: 0, endCents: 2000 },
  } as unknown as OwnersEquityOverview;
  const rows = equityCsvRows(overview);
  assert.deepEqual(rows[0], ['Anna', '60%', '1000.00', '1800.00', '0.00', '-500.00', '0.00', '2300.00']);
  assert.deepEqual(rows[1], ['Bram (uitgetreden)', '40%', '500.00', '1200.00', '100.00', '0.00', '0.00', '1800.00']);
  assert.deepEqual(rows[2], ['Nog niet aan een vennoot toegewezen', '', '20.00', '', '', '', '0.00', '20.00']);
  assert.deepEqual(rows[3], ['Totaal', '', '1520.00', '3000.00', '100.00', '-500.00', '0.00', '4120.00']);
  assert.deepEqual(rows[4], ['Boekjaar 2025', 'afgesloten', '', '3000.00', '', '', '', '']);
});

test('het overzicht voor de aangifte IB, regel voor regel', () => {
  assert.deepEqual(incomeTaxSummaryCsvRows([
    { label: 'Winst volgens je boekhouding', cents: 4500000 },
    { label: 'Zelfstandigenaftrek', cents: 239400, sign: '−' },
    { label: 'Belastbare winst uit onderneming', cents: 3638402, sign: '=' },
  ]), [
    ['Winst volgens je boekhouding', '45000.00'],
    ['Zelfstandigenaftrek', '-2394.00'],
    ['Belastbare winst uit onderneming', '36384.02'],
  ]);
});
