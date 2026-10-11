/**
 * Tests voor de rechten zoals de app ze toont (zijbalk, pagina's, knoppen).
 * Draaien met:  npm test
 *
 * De database is de beveiliging; dit is de beleving. Maar die moet wel kloppen:
 * de boekhouder hoort alleen Financiën te zien, en nergens een knop die iets
 * wijzigt. Dezelfde regel staat in de database en de edge functions —
 * supabase/functions/_shared/roles.test.ts houdt die drie gelijk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissions, firstAllowedPage, isAccountantRole, isWriterRole, MODULE_KEYS, PAGE_MODULE } from './permissions.ts';

const accountant = buildPermissions({ role: 'accountant', module_access: { clients: 'write', finance: 'write' } });

test('de boekhouder opent alle financiële pagina’s, en verder alleen dashboard en instellingen', () => {
  for (const [page, module] of Object.entries(PAGE_MODULE)) {
    assert.equal(accountant.canOpenPage(page), module === 'finance', page);
  }
  assert.equal(accountant.canOpenPage('dashboard'), true);
  assert.equal(accountant.canOpenPage('settings'), true);
  assert.equal(firstAllowedPage(accountant), 'dashboard');
});

test('de boekhouder wijzigt nergens — ook niet op pagina’s zonder module', () => {
  for (const page of [...Object.keys(PAGE_MODULE), 'dashboard', 'settings']) {
    assert.equal(accountant.canWritePage(page), false, page);
  }
  for (const module of MODULE_KEYS) assert.equal(accountant.canWrite(module), false, module);
  assert.equal(accountant.level('finance'), 'read');
  assert.equal(accountant.isRestricted, true);
});

test('wat er in module_access staat, verruimt de boekhouder niet', () => {
  assert.equal(accountant.canRead('clients'), false);
  assert.equal(accountant.canRead('gerrie'), false);
  assert.equal(accountant.canRead('chat'), false);
});

test('de bestaande rollen houden hun gedrag', () => {
  const owner = buildPermissions({ role: 'owner', module_access: { finance: 'none' } });
  assert.equal(owner.canWritePage('invoices'), true);
  const member = buildPermissions({ role: 'member', module_access: { finance: 'none', time: 'read' } });
  assert.equal(member.canOpenPage('invoices'), false);
  assert.equal(member.canWritePage('time'), false);
  assert.equal(member.canWritePage('projects'), true);
  assert.equal(member.canWritePage('settings'), true);
  const viewer = buildPermissions({ role: 'viewer', module_access: {} });
  assert.equal(viewer.canOpenPage('clients'), true);
  assert.equal(viewer.canWritePage('clients'), false);
  assert.equal(viewer.canWritePage('settings'), false);
});

test('een rol die de app niet kent, ziet niets dan het dashboard', () => {
  // Zoals de database: een onbekende rol valt dicht in plaats van open.
  const unknown = buildPermissions({ role: 'gast' as never, module_access: {} });
  for (const module of MODULE_KEYS) assert.equal(unknown.canRead(module), false, module);
  assert.equal(unknown.canWritePage('settings'), false);
});

test('rolhulpjes', () => {
  assert.equal(isAccountantRole('accountant'), true);
  assert.equal(isAccountantRole('viewer'), false);
  assert.equal(isWriterRole('accountant'), false);
  assert.equal(isWriterRole('member'), true);
  assert.equal(isWriterRole(null), false);
});
