import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalDocumentDecision, portalDocumentScopeFilter, portalTicketsOpen } from './portalAccess.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const P = '33333333-3333-4333-8333-333333333333';

test('een document van een andere klant: nooit via het project (dit ging mis)', () => {
  // Klant B logt in; de offerte is voor klant A maar hangt aan een project dat nu van B is.
  assert.equal(portalDocumentDecision({ client_id: A, project_id: P }, new Set([B])), 'deny');
});

test('eigen document: toegestaan, ook zonder project', () => {
  assert.equal(portalDocumentDecision({ client_id: B, project_id: null }, new Set([B])), 'allow');
  assert.equal(portalDocumentDecision({ client_id: B, project_id: P }, new Set([A, B])), 'allow');
});

test('document zonder klant: alleen via het project, en zonder project niets', () => {
  assert.equal(portalDocumentDecision({ client_id: null, project_id: P }, new Set([B])), 'check_project');
  assert.equal(portalDocumentDecision({ client_id: null, project_id: null }, new Set([B])), 'deny');
});

test('lijstfilter: projectdocumenten alleen als ze geen klant hebben', () => {
  assert.equal(
    portalDocumentScopeFilter(B, [P]),
    `client_id.eq.${B},and(client_id.is.null,project_id.in.(${P}))`,
  );
  assert.equal(portalDocumentScopeFilter(B, []), null);
  // Iets wat geen uuid is, komt niet in de filter (en een ongeldige klant weigert).
  assert.equal(portalDocumentScopeFilter(B, ['x),or(id.neq.0']), null);
  assert.throws(() => portalDocumentScopeFilter('x', [P]));
});

test('tickets: dicht voor een klant op inactief, open voor actief en prospect', () => {
  assert.equal(portalTicketsOpen({ status: 'inactive' }), false);
  assert.equal(portalTicketsOpen({ status: ' Inactive ' }), false);
  assert.equal(portalTicketsOpen({ status: 'active' }), true);
  assert.equal(portalTicketsOpen({ status: 'prospect' }), true);
  // Zonder status (een oudere rij of een server zonder de kolom): open, zoals het was.
  assert.equal(portalTicketsOpen({ status: null }), true);
  assert.equal(portalTicketsOpen({}), true);
  assert.equal(portalTicketsOpen(null), true);
});
