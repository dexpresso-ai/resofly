/**
 * Tests voor het verplaatsen in de verkenner. Draaien met:  npm test
 *
 * De gevaarlijke gevallen staan bovenaan: een map in zichzelf of in zijn eigen
 * submap laten vallen maakt een lus in de mappenboom, en daar komt de verkenner
 * nooit meer uit. Daarna de regels voor verhuizen tussen klanten en projecten.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  driveItemLocation, itemCountLabel, planDriveMove, sameLocation,
  type DriveDragItem, type DriveLocation, type DriveLocationSource, type DriveMoveContext,
} from './driveDnd.ts';

const map = (id: string, name = id): DriveDragItem => ({ kind: 'folder', id, name });
const notitie = (id: string, name = id): DriveDragItem => ({ kind: 'note', id, name });
const document = (id: string, name = id): DriveDragItem => ({ kind: 'document', id, name });
const bestand = (id: string, name = id): DriveDragItem => ({ kind: 'attachment', id, name });

const plek = (clientId: string | null, projectId: string | null = null, folderId: string | null = null): DriveLocation =>
  ({ clientId, projectId, folderId });

/** Boom bij klant X: a → a1 → a11, en b los ernaast. Alles ligt in de klantwortel tenzij anders gezegd. */
function ctx(over: Partial<DriveMoveContext> = {}): DriveMoveContext {
  const kinderen: Record<string, string[]> = { a: ['a1', 'a11'], a1: ['a11'], a11: [], b: [] };
  return {
    locationOf: () => plek('X'),
    descendantIds: (id) => kinderen[id] ?? [],
    ...over,
  };
}

test('een map kan niet in zichzelf', () => {
  const plan = planDriveMove([map('a')], plek('X', null, 'a'), ctx());
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0].reason, /niet in zichzelf/);
});

test('een map kan niet in zijn eigen submap — ook niet twee niveaus diep', () => {
  assert.equal(planDriveMove([map('a')], plek('X', null, 'a1'), ctx()).blocked.length, 1);
  assert.equal(planDriveMove([map('a')], plek('X', null, 'a11'), ctx()).blocked.length, 1);
  // Andersom mag wél: een submap naar buiten of naar een andere tak.
  assert.equal(planDriveMove([map('a11')], plek('X', null, 'b'), ctx()).moves.length, 1);
});

test('een geüpload bestand moet in een map blijven staan — ook bij een andere klant', () => {
  const inMapA = ctx({ locationOf: () => plek('X', null, 'a') });
  const naarKlantwortel = planDriveMove([bestand('f1', 'Offerte.pdf')], plek('X'), inMapA);
  assert.equal(naarKlantwortel.moves.length, 0);
  assert.match(naarKlantwortel.blocked[0].reason, /Offerte\.pdf/);
  assert.equal(planDriveMove([bestand('f1')], plek('Y', 'p'), inMapA).blocked.length, 1);
  // In een map mag het gewoon, ook een map van een andere klant.
  assert.equal(planDriveMove([bestand('f1')], plek('X', null, 'b'), inMapA).moves.length, 1);
  assert.equal(planDriveMove([bestand('f1')], plek('Y', 'p', 'q1'), inMapA).moves.length, 1);
});

test('een map hoort bij een klant: "Geen klant" is geen doel voor mappen', () => {
  const plan = planDriveMove([map('a', 'Archief')], plek(null), ctx());
  assert.equal(plan.moves.length, 0);
  assert.match(plan.blocked[0].reason, /bij een klant blijven/);
  // Een notitie mag daar wél heen: losmaken van de klant is een besluit dat je mag nemen.
  assert.equal(planDriveMove([notitie('n1')], plek(null), ctx()).moves.length, 1);
});

test('verhuizen naar een andere klant of een ander project is gewoon een verplaatsing', () => {
  const plan = planDriveMove([map('a'), notitie('n1'), document('d1')], plek('Y', 'p2'), ctx());
  assert.deepEqual(plan.moves.map(i => i.id), ['a', 'n1', 'd1']);
  assert.equal(plan.blocked.length, 0);
  // En binnen dezelfde klant van de klantwortel naar een projectmap ook.
  assert.equal(planDriveMove([notitie('n1')], plek('X', 'p1'), ctx()).moves.length, 1);
});

test('een notitie mag wél naar het niveau boven de mappen', () => {
  const plan = planDriveMove([notitie('n1')], plek('X'), ctx({ locationOf: () => plek('X', null, 'a') }));
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.blocked.length, 0);
});

test('iets laten vallen waar het al ligt is geen fout, maar ook geen actie', () => {
  const plan = planDriveMove([notitie('n1'), bestand('f1')], plek('X', null, 'a'), ctx({ locationOf: () => plek('X', null, 'a') }));
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.unchanged.length, 2);
  // Dezelfde map, maar via een andere klant: dat kan niet voorkomen, dus dat telt als verhuizing.
  assert.equal(planDriveMove([notitie('n1')], plek('Y', null, 'a'), ctx({ locationOf: () => plek('X', null, 'a') })).moves.length, 1);
});

test('een gemengde selectie splitst zich netjes: wat kan gaat mee, wat niet kan wordt gemeld', () => {
  const plan = planDriveMove(
    [notitie('n1', 'Verslag'), bestand('f1', 'Tekening.pdf'), map('a', 'Archief')],
    plek('X'),
    ctx({ locationOf: () => plek('X', null, 'a1') }),
  );
  assert.deepEqual(plan.moves.map(i => i.id), ['n1', 'a']);
  assert.deepEqual(plan.blocked.map(i => i.item.id), ['f1']);
});

test('een onbekend item (niet meer in beeld) wordt niet stilletjes als "ligt hier al" weggeschreven', () => {
  const plan = planDriveMove([notitie('weg')], plek('X'), ctx({ locationOf: () => null }));
  assert.equal(plan.moves.length, 1);
});

test('sameLocation leest null en ontbrekend als hetzelfde', () => {
  assert.ok(sameLocation({ clientId: 'X', projectId: null, folderId: null }, { clientId: 'X', projectId: null, folderId: null }));
  assert.ok(!sameLocation(plek('X'), plek('X', 'p')));
  assert.ok(!sameLocation(plek('X', null, 'a'), plek('X', null, 'b')));
});

// ── Waar ligt een item nu? ──────────────────────────────────────────────────

/** Klant X met project p1 (en map q in dat project), klantmap a met submap a1; klant Y. */
const bron: DriveLocationSource = {
  folders: [
    { id: 'a', client_id: 'X', project_id: null, parent_id: null },
    { id: 'a1', client_id: 'X', project_id: null, parent_id: 'a' },
    { id: 'q', client_id: 'X', project_id: 'p1', parent_id: null },
  ],
  projects: [{ id: 'p1', client_id: 'X' }, { id: 'los', client_id: null }],
  notes: [
    { id: 'n-map', client_id: 'X', project_id: null, folder_id: 'a1' },
    { id: 'n-project', client_id: null, project_id: 'p1', folder_id: null },
    { id: 'n-klant', client_id: 'Y', project_id: null, folder_id: null },
    { id: 'n-niemand', client_id: null, project_id: null, folder_id: null },
    { id: 'n-losproject', client_id: null, project_id: 'los', folder_id: null },
  ],
  documents: [{ id: 'd-projectmap', client_id: 'X', project_id: 'p1', folder_id: 'q' }],
  attachments: [
    { id: 'f-in-a', entity_type: 'folder', entity_id: 'a' },
    { id: 'f-ticket', entity_type: 'ticket', entity_id: 't1' },
  ],
};

test('een map ligt in zijn bovenliggende map, binnen zijn eigen scope', () => {
  assert.deepEqual(driveItemLocation(bron, map('a1')), plek('X', null, 'a'));
  assert.deepEqual(driveItemLocation(bron, map('q')), plek('X', 'p1', null));
});

test('een bestand ligt in de map waar het aan hangt; een ticketbijlage is geen drive-item', () => {
  assert.deepEqual(driveItemLocation(bron, bestand('f-in-a')), plek('X', null, 'a'));
  assert.equal(driveItemLocation(bron, bestand('f-ticket')), null);
});

test('een notitie ligt in zijn map, anders bij zijn project (en dus bij de klant van dat project), anders bij zijn klant', () => {
  assert.deepEqual(driveItemLocation(bron, notitie('n-map')), plek('X', null, 'a1'));
  assert.deepEqual(driveItemLocation(bron, notitie('n-project')), plek('X', 'p1'));
  assert.deepEqual(driveItemLocation(bron, notitie('n-klant')), plek('Y'));
  assert.deepEqual(driveItemLocation(bron, notitie('n-niemand')), plek(null));
  // Een project zonder klant: de notitie hoort bij dat project, onder "Geen klant".
  assert.deepEqual(driveItemLocation(bron, notitie('n-losproject')), plek(null, 'los'));
  assert.deepEqual(driveItemLocation(bron, document('d-projectmap')), plek('X', 'p1', 'q'));
  assert.equal(driveItemLocation(bron, notitie('bestaat-niet')), null);
});

test('de teller schrijft enkelvoud en meervoud uit', () => {
  assert.equal(itemCountLabel(1), '1 item');
  assert.equal(itemCountLabel(3), '3 items');
});
