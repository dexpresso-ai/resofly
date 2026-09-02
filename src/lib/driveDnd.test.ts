/**
 * Tests voor het slepen in de verkenner. Draaien met:  npm test
 *
 * De gevaarlijke gevallen staan bovenaan: een map in zichzelf of in zijn eigen
 * submap laten vallen maakt een lus in de mappenboom, en daar komt de verkenner
 * nooit meer uit. Die twee regels liggen hier vast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { itemCountLabel, planDriveMove, type DriveDragItem, type DriveMoveContext } from './driveDnd.ts';

const map = (id: string, name = id): DriveDragItem => ({ kind: 'folder', id, name });
const notitie = (id: string, name = id): DriveDragItem => ({ kind: 'note', id, name });
const bestand = (id: string, name = id): DriveDragItem => ({ kind: 'attachment', id, name });

/** Boom: a → a1 → a11, en b los ernaast. Alles ligt in de wortel tenzij anders gezegd. */
function ctx(over: Partial<DriveMoveContext> = {}): DriveMoveContext {
  const kinderen: Record<string, string[]> = { a: ['a1', 'a11'], a1: ['a11'], a11: [], b: [] };
  return {
    currentFolderId: () => null,
    descendantIds: (id) => kinderen[id] ?? [],
    ...over,
  };
}

test('een map kan niet in zichzelf', () => {
  const plan = planDriveMove([map('a')], 'a', ctx());
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0].reason, /niet in zichzelf/);
});

test('een map kan niet in zijn eigen submap — ook niet twee niveaus diep', () => {
  assert.equal(planDriveMove([map('a')], 'a1', ctx()).blocked.length, 1);
  assert.equal(planDriveMove([map('a')], 'a11', ctx()).blocked.length, 1);
  // Andersom mag wél: een submap naar buiten of naar een andere tak.
  assert.equal(planDriveMove([map('a11')], 'b', ctx()).moves.length, 1);
});

test('een geüpload bestand moet in een map blijven staan', () => {
  const plan = planDriveMove([bestand('f1', 'Offerte.pdf')], null, ctx({ currentFolderId: () => 'a' }));
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0].reason, /Offerte\.pdf/);
  // In een map mag het gewoon.
  assert.equal(planDriveMove([bestand('f1')], 'b', ctx({ currentFolderId: () => 'a' })).moves.length, 1);
});

test('een notitie mag wél naar het niveau boven de mappen', () => {
  const plan = planDriveMove([notitie('n1')], null, ctx({ currentFolderId: () => 'a' }));
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.blocked.length, 0);
});

test('iets in de map laten vallen waar het al ligt is geen fout, maar ook geen actie', () => {
  const plan = planDriveMove([notitie('n1'), bestand('f1')], 'a', ctx({ currentFolderId: () => 'a' }));
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.unchanged.length, 2);
});

test('een gemengde selectie splitst zich netjes: wat kan gaat mee, wat niet kan wordt gemeld', () => {
  const plan = planDriveMove(
    [notitie('n1', 'Verslag'), bestand('f1', 'Tekening.pdf'), map('a', 'Archief')],
    null,
    ctx({ currentFolderId: () => 'a1' }),
  );
  assert.deepEqual(plan.moves.map(i => i.id), ['n1', 'a']);
  assert.deepEqual(plan.blocked.map(i => i.item.id), ['f1']);
});

test('de teller schrijft enkelvoud en meervoud uit', () => {
  assert.equal(itemCountLabel(1), '1 item');
  assert.equal(itemCountLabel(3), '3 items');
});
