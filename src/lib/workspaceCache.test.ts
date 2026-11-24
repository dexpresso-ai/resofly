/**
 * Starten uit de cache (lib/workspaceCache.ts): wanneer de werkruimte van de
 * vorige keer getoond mag worden. Liever een keer te weinig dan de gegevens
 * van een ander, van een andere organisatie, of met rechten die er niet meer zijn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bruikbareCache, rechtenVan, WORKSPACE_CACHE_MAX_MS, WORKSPACE_CACHE_VERSIE, type WorkspaceCacheEntry } from './workspaceCache.ts';

const NOW = Date.parse('2026-11-24T09:00:00Z');
const membership = { id: 'm1', organization_id: 'o1', user_id: 'u1', role: 'member', status: 'active', module_access: { finance: 'none', clients: 'write' }, accountant_can_book: null } as const;

function entry(patch: Partial<WorkspaceCacheEntry> = {}): WorkspaceCacheEntry {
  return {
    v: WORKSPACE_CACHE_VERSIE, userId: 'u1', orgId: 'o1', at: NOW - 60_000,
    rechten: rechtenVan(membership as never),
    organizationContext: { activeOrganization: { id: 'o1' }, activeMembership: membership } as never,
    core: { clients: [] } as never,
    groups: {},
    ...patch,
  };
}

test('de cache van deze gebruiker en organisatie, recent, is bruikbaar', () => {
  assert.ok(bruikbareCache(entry(), { userId: 'u1', orgId: 'o1', now: NOW }));
});

test('nooit voor een andere gebruiker of organisatie', () => {
  assert.equal(bruikbareCache(entry(), { userId: 'u2', orgId: 'o1', now: NOW }), null);
  assert.equal(bruikbareCache(entry(), { userId: 'u1', orgId: 'o2', now: NOW }), null);
  // De sleutel klopt, maar de inhoud hoort bij een andere organisatie of gebruiker.
  assert.equal(bruikbareCache(entry({ organizationContext: { activeOrganization: { id: 'o2' }, activeMembership: membership } as never }), { userId: 'u1', orgId: 'o1', now: NOW }), null);
  assert.equal(bruikbareCache(entry({ organizationContext: { activeOrganization: { id: 'o1' }, activeMembership: { ...membership, user_id: 'u2' } } as never }), { userId: 'u1', orgId: 'o1', now: NOW }), null);
  assert.equal(bruikbareCache(entry({ organizationContext: { activeOrganization: { id: 'o1' }, activeMembership: null } as never }), { userId: 'u1', orgId: 'o1', now: NOW }), null);
});

test('niet ouder dan 7 dagen, niet uit de toekomst, en alleen dezelfde versie', () => {
  assert.equal(bruikbareCache(entry({ at: NOW - WORKSPACE_CACHE_MAX_MS - 1 }), { userId: 'u1', orgId: 'o1', now: NOW }), null);
  assert.equal(bruikbareCache(entry({ at: NOW + 10 * 60_000 }), { userId: 'u1', orgId: 'o1', now: NOW }), null);
  assert.equal(bruikbareCache(entry({ v: WORKSPACE_CACHE_VERSIE + 1 }), { userId: 'u1', orgId: 'o1', now: NOW }), null);
  assert.equal(bruikbareCache(null, { userId: 'u1', orgId: 'o1', now: NOW }), null);
  assert.equal(bruikbareCache('kapot', { userId: 'u1', orgId: 'o1', now: NOW }), null);
});

test('de rechten bepalen mee: rol, status, modules en boeken door de boekhouder', () => {
  const basis = rechtenVan(membership as never);
  assert.notEqual(rechtenVan({ ...membership, role: 'viewer' } as never), basis);
  assert.notEqual(rechtenVan({ ...membership, status: 'disabled' } as never), basis);
  assert.notEqual(rechtenVan({ ...membership, module_access: { finance: 'read', clients: 'write' } } as never), basis);
  assert.notEqual(rechtenVan({ ...membership, accountant_can_book: true } as never), basis);
  // De volgorde van de modules doet er niet toe.
  assert.equal(rechtenVan({ ...membership, module_access: { clients: 'write', finance: 'none' } } as never), basis);
  // Klopt de bewaarde vingerafdruk niet bij het bewaarde lidmaatschap, dan niet.
  assert.equal(bruikbareCache(entry({ rechten: 'owner||' }), { userId: 'u1', orgId: 'o1', now: NOW }), null);
});

test('de app schrijft niet vanuit de cache, toont "Bijwerken…" en wist alles bij uitloggen', () => {
  const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
  // Uit de cache: geen schrijfrecht, ook de boekhouder niet, en de knoppen zeggen waarom.
  assert.match(main, /const orgCanWrite = !cacheView && /);
  assert.match(main, /const canBook = !cacheView && permissions\.canBookPage\(page\);/);
  assert.match(main, /if \(cacheView\) \{\s*setError\('Even geduld: ResoFly haalt de nieuwste gegevens op\. Daarna kun je wijzigen\.'\);\s*return false;/);
  // Nooit oude gegevens terugschrijven als cache.
  assert.match(main, /function bewaarWerkruimte\(\) \{\s*if \(cacheViewRef\.current\) return;/);
  // Uitloggen wist de cache en de opstartverzoeken.
  const logout = main.slice(main.indexOf('} else if (!userId) {'), main.indexOf('} else if (!userId) {') + 600);
  assert.match(logout, /clearOpstartLijsten\(\);/);
  assert.match(logout, /void clearWorkspaceCache\(\);/);
  // Een andere organisatie of andere rechten: de cache vervalt.
  assert.match(main, /rechtenVan\(orgContext\.activeMembership\) !== cacheRechtenRef\.current/);
});
