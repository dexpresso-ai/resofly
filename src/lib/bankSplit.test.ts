import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centsToInput, checkSplit, newSplitRow, parseEuroCents, rowsFromSuggestion, splitPayload, type SplitRow } from './bankSplit.ts';

test('bedrag invoeren zoals je het typt', () => {
  const cases: Array<[string, number | null]> = [
    ['120,50', 12050], ['120', 12000], ['1.234,56', 123456], ['1234.56', 123456], ['1,234.56', 123456],
    ['€ 12,50', 1250], ['12,5', 1250], ['0,01', 1], ['.50', 50], ['12.', 1200], ['1.234', 123400], ['12.345.678', 1234567800],
    [' 7 ', 700], ['-5,00', -500],
    ['', null], ['abc', null], ['1,234', null], ['1,2,3', null], ['12,345', null], ['1.23.45', null], ['0.125', null], ['€', null], ['1e3', null],
  ];
  for (const [input, cents] of cases) assert.equal(parseEuroCents(input), cents, JSON.stringify(input));
  assert.equal(centsToInput(12050), '120,50');
  assert.equal(centsToInput(5), '0,05');
  assert.equal(parseEuroCents(centsToInput(987654321)), 987654321, 'heen en terug');
});

const labels: Record<string, string> = { a: 'factuur F-1', b: 'factuur F-2', p: 'inkoopfactuur I-1', k: '4500 Algemene kosten' };
const open: Record<string, number> = { a: 10000, b: 5000, p: 12100, credit: -3000 };
const ctx = (incoming: boolean) => ({
  incoming,
  openOf: (_kind: string, id: string) => open[id],
  labelOf: (_kind: string, id: string) => labels[id] ?? id,
});
const row = (kind: SplitRow['kind'], targetId: string, amount: string, vatCode = ''): SplitRow => ({ ...newSplitRow(kind, targetId), amount, vatCode });

test('verdelen: wat er nog te verdelen is en wanneer boeken kan', () => {
  const rows = [row('invoice', 'a', '100,00'), row('invoice', 'b', '30')];
  let c = checkSplit(rows, 15000, ctx(true));
  assert.equal(c.allocatedCents, 13000);
  assert.equal(c.remainingCents, 2000, 'nog 20 te verdelen');
  assert.equal(c.ready, false);
  rows.push(row('account', 'k', '20,00', 'HOOG'));
  c = checkSplit(rows, 15000, ctx(true));
  assert.equal(c.remainingCents, 0);
  assert.equal(c.ready, true);
  assert.equal(checkSplit([...rows, row('account', 'k', '1')], 15000, ctx(true)).remainingCents, -100, 'te veel verdeeld: negatief');
  assert.equal(checkSplit([], 15000, ctx(true)).ready, false, 'zonder regels niet');
});

test('verdelen: meldingen per regel', () => {
  const c = checkSplit([
    row('invoice', '', '10'),
    row('invoice', 'a', ''),
    row('invoice', 'a', '120'),
    row('invoice', 'b', '10'),
    row('invoice', 'b', '10'),
    row('account', '', '5'),
    row('invoice', 'credit', '10'),
  ], 50000, ctx(true));
  assert.equal(c.rowErrors.get(0), 'Kies een verkoopfactuur.');
  assert.equal(c.rowErrors.get(1), 'Vul een bedrag in, bijvoorbeeld 120,50.');
  assert.match(c.rowErrors.get(2)!, /^Op factuur F-1 staat nog €\s100,00 open\.$/);
  assert.equal(c.rowErrors.has(3), false);
  assert.match(c.rowErrors.get(4)!, /factuur F-2 staat al in de verdeling/);
  assert.equal(c.rowErrors.get(5), 'Kies een grootboekrekening.');
  assert.match(c.rowErrors.get(6)!, /staat niets meer open/, 'een ontvangst op een tegoed kan niet');
  assert.equal(c.ready, false);
});

test('verdelen: terugbetalen van een tegoed, en een batch aan een leverancier', () => {
  // Wij betalen de klant 30 terug van zijn tegoed van 30: mag; 40 niet.
  assert.equal(checkSplit([row('invoice', 'credit', '30')], 3000, ctx(false)).ready, true);
  assert.match(checkSplit([row('invoice', 'credit', '40')], 4000, ctx(false)).rowErrors.get(0)!, /Het tegoed op credit is €\s30,00/);
  // Een betaling op een verkoopfactuur waar niets te veel betaald is: nee.
  assert.match(checkSplit([row('invoice', 'a', '10')], 1000, ctx(false)).rowErrors.get(0)!, /geen tegoed/);
  // Inkoop: betalen gaat van het openstaande bedrag af.
  assert.equal(checkSplit([row('purchase', 'p', '121,00')], 12100, ctx(false)).ready, true);
  assert.match(checkSplit([row('purchase', 'p', '121,01')], 12101, ctx(false)).rowErrors.get(0)!, /nog €\s121,00 open/);
  // Openstaand bedrag onbekend (nog aan het laden): de server controleert het.
  assert.equal(checkSplit([row('invoice', 'onbekend', '10')], 1000, ctx(true)).ready, true);
});

test('verdelen: wat er naar de server gaat', () => {
  const rows = [row('invoice', 'a', '100'), row('purchase', 'p', '12,10'), row('account', 'k', '7,5', 'HOOG'), row('account', 'k', '2,40')];
  assert.deepEqual(splitPayload(rows, 'Klant BV'), {
    allocations: [{ invoice_id: 'a', amount_cents: 10000 }, { purchase_invoice_id: 'p', amount_cents: 1210 }],
    lines: [
      { account_id: 'k', amount_cents: 750, vat_code: 'HOOG', description: 'Klant BV' },
      { account_id: 'k', amount_cents: 240, vat_code: null, description: 'Klant BV' },
    ],
  });
});

test('verdelen: het voorstel van de matcher', () => {
  const rows = rowsFromSuggestion([{ invoice_id: 'a', amount_cents: 10000 }, { purchase_invoice_id: 'p', amount_cents: 500 }, { invoice_id: 'x', amount_cents: 0 }, null, 'onzin']);
  assert.deepEqual(rows.map((r) => [r.kind, r.targetId, r.amount]), [['invoice', 'a', '100,00'], ['purchase', 'p', '5,00']]);
  assert.equal(new Set(rows.map((r) => r.key)).size, 2, 'elke regel een eigen sleutel');
  assert.deepEqual(rowsFromSuggestion(null), []);
  assert.deepEqual(rowsFromSuggestion({}), []);
});
