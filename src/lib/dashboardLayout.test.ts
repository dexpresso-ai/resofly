/**
 * De indeling van het dashboard: volgorde, inklappen en de rijen in beeld.
 * Draaien met: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeOrder,
  dashRows,
  DEFAULT_DASH_ORDER,
  isDefaultDashLayout,
  moveDashBlock,
  parseDashLayout,
  serializeDashLayout,
  stepDashBlock,
  toggleDashBlock,
  type DashBlockId,
} from './dashboardLayout.ts';

const ALL = new Set<DashBlockId>(DEFAULT_DASH_ORDER);

test('zonder bewaarde indeling: de volgorde van altijd, niets ingeklapt', () => {
  const layout = parseDashLayout(null);
  assert.deepEqual(layout.order, DEFAULT_DASH_ORDER);
  assert.deepEqual(layout.collapsed, []);
  assert.equal(isDefaultDashLayout(layout), true);
});

test('een kapotte of vreemde bewaarde indeling valt terug op de standaard', () => {
  assert.deepEqual(parseDashLayout('{kapot').order, DEFAULT_DASH_ORDER);
  const eigen = ['logboek', ...DEFAULT_DASH_ORDER.filter(id => id !== 'logboek')];
  const odd = parseDashLayout(JSON.stringify({ order: [eigen[0], 'bestaat-niet', 42, ...eigen], collapsed: ['vandaag', 'onzin', 'vandaag'] }));
  assert.equal(odd.order[0], 'logboek', 'de eigen keuze blijft vooraan');
  assert.equal(odd.order.length, DEFAULT_DASH_ORDER.length, 'elk blok precies één keer');
  assert.deepEqual(odd.collapsed, ['vandaag']);
});

test('een blok dat er later bij kwam, komt op zijn standaardplek', () => {
  // Een indeling van vóór "akkoord" en "logboek": die komen na hun standaardbuur.
  const order = completeOrder(['stand', 'beslissingen', 'aandacht', 'vandaag', 'weekacties', 'projecten', 'rapportages', 'inrichting']);
  assert.equal(order[order.indexOf('beslissingen') + 1], 'akkoord');
  assert.equal(order[order.indexOf('inrichting') + 1], 'logboek');
  assert.equal(order.indexOf('aandacht') < order.indexOf('vandaag'), true, 'de eigen volgorde blijft');
});

test('bewaren en teruglezen geeft hetzelfde', () => {
  const layout = { order: [...DEFAULT_DASH_ORDER].reverse(), collapsed: ['stand', 'projecten'] as DashBlockId[] };
  assert.deepEqual(parseDashLayout(serializeDashLayout(layout)), layout);
});

test('verplaatsen gebeurt tussen de blokken in beeld; de rest houdt zijn plek', () => {
  // Iemand zonder financiën en zonder Gerrie: geen beslislijst, akkoord, rapportages.
  const visible = new Set<DashBlockId>(['stand', 'vandaag', 'aandacht', 'weekacties', 'projecten', 'logboek']);
  const moved = moveDashBlock(DEFAULT_DASH_ORDER, 'logboek', 0, visible);
  assert.deepEqual(moved.filter(id => visible.has(id)), ['logboek', 'stand', 'vandaag', 'aandacht', 'weekacties', 'projecten']);
  assert.equal(moved.indexOf('beslissingen'), 1, 'een blok buiten beeld blijft op zijn plek');
  assert.equal(moved.indexOf('rapportages'), 7);
});

test('omhoog en omlaag stoppen aan de randen', () => {
  assert.deepEqual(stepDashBlock(DEFAULT_DASH_ORDER, 'stand', -1, ALL), DEFAULT_DASH_ORDER);
  assert.deepEqual(stepDashBlock(DEFAULT_DASH_ORDER, 'logboek', 1, ALL), DEFAULT_DASH_ORDER);
  const down = stepDashBlock(DEFAULT_DASH_ORDER, 'vandaag', 1, ALL);
  assert.deepEqual(down.slice(3, 5), ['aandacht', 'vandaag']);
});

test('inklappen en weer uitklappen', () => {
  const dicht = toggleDashBlock(parseDashLayout(null), 'weekacties');
  assert.deepEqual(dicht.collapsed, ['weekacties']);
  assert.equal(isDefaultDashLayout(dicht), false);
  assert.deepEqual(toggleDashBlock(dicht, 'weekacties').collapsed, []);
});

test('de standaardvolgorde geeft het dashboard van altijd', () => {
  assert.deepEqual(dashRows(DEFAULT_DASH_ORDER), [
    { kind: 'single', id: 'stand' },
    { kind: 'single', id: 'beslissingen' },
    { kind: 'single', id: 'akkoord' },
    { kind: 'pair', main: 'vandaag', side: ['aandacht'], sideFirst: false },
    { kind: 'single', id: 'weekacties' },
    { kind: 'single', id: 'projecten' },
    { kind: 'pair', main: 'rapportages', side: ['inrichting', 'logboek'], sideFirst: false },
  ]);
});

test('een smal blok vóór een breed staat er links naast; alleen krijgt het de volle breedte', () => {
  assert.deepEqual(dashRows(['aandacht', 'vandaag', 'weekacties']), [
    { kind: 'pair', main: 'vandaag', side: ['aandacht'], sideFirst: true },
    { kind: 'single', id: 'weekacties' },
  ]);
  // Zonder rapportages staan inrichting en logboek elk op een eigen rij, zoals
  // de staartrij dat zonder rapportages ook deed.
  assert.deepEqual(dashRows(['projecten', 'inrichting', 'logboek']), [
    { kind: 'single', id: 'projecten' },
    { kind: 'single', id: 'inrichting' },
    { kind: 'single', id: 'logboek' },
  ]);
  assert.deepEqual(dashRows(['vandaag', 'weekacties', 'aandacht']), [
    { kind: 'single', id: 'vandaag' },
    { kind: 'single', id: 'weekacties' },
    { kind: 'single', id: 'aandacht' },
  ]);
});
