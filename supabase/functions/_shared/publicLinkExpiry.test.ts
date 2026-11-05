import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicLinkExpiresAt } from './publicLinkExpiry.ts';

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0); // 5 november 2026, 13:00 in Nederland

test('zonder geldigheidsdatum: de vaste termijn', () => {
  assert.equal(publicLinkExpiresAt(null, 30, NOW), '2026-12-05T12:00:00.000Z');
  assert.equal(publicLinkExpiresAt('', 30, NOW), '2026-12-05T12:00:00.000Z');
  assert.equal(publicLinkExpiresAt('geen datum', 30, NOW), '2026-12-05T12:00:00.000Z');
});

test('geldig tot na de termijn: de link werkt tot en met die dag (dit ging mis)', () => {
  // Offerte geldig tot 31 januari, verstuurd op 5 november: de link verliep op 5 december.
  const expires = publicLinkExpiresAt('2027-01-31', 30, NOW);
  assert.equal(expires, '2027-02-02T00:00:00.000Z');
  // 31 januari 23:59 in Nederland (22:59 UTC) valt er ruim binnen.
  assert.ok(Date.parse(expires) > Date.UTC(2027, 0, 31, 22, 59));
});

test('geldig tot vóór het einde van de termijn: de vaste termijn blijft', () => {
  assert.equal(publicLinkExpiresAt('2026-11-20', 30, NOW), '2026-12-05T12:00:00.000Z');
});

test('jaren geldig: de link staat hooguit een jaar open', () => {
  assert.equal(publicLinkExpiresAt('2031-01-01', 30, NOW), new Date(NOW + 366 * 86400000).toISOString());
});

test('een tijdstip achter de datum wordt genegeerd', () => {
  assert.equal(publicLinkExpiresAt('2027-01-31T10:00:00Z', 30, NOW), '2027-02-02T00:00:00.000Z');
});
