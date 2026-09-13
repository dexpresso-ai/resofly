import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysInMonth, localYmd, tzOffsetMs, wallToUtc } from './schedule.ts';

/**
 * Bewaakt de DST-rekensom die de routines én (straks) de beslislijst delen.
 *
 * Een schema dat één uur verschuift merk je niet in de test-omgeving en niet in
 * de zomer — pas in de nacht van de klokwissel, als een agent om 07:00 in plaats
 * van 08:00 draait. Dat is precies het soort fout dat je één keer per half jaar
 * ziet en dan niet meer terugvindt; vandaar vaste datums rond beide wissels.
 */

test('wandkloktijd in Amsterdam wordt de juiste UTC-tijd, zomer én winter', () => {
  assert.equal(wallToUtc('Europe/Amsterdam', 2026, 1, 15, 8).toISOString(), '2026-01-15T07:00:00.000Z');
  assert.equal(wallToUtc('Europe/Amsterdam', 2026, 7, 1, 8).toISOString(), '2026-07-01T06:00:00.000Z');
  assert.equal(wallToUtc('Europe/Amsterdam', 2026, 7, 1, 8, 30).toISOString(), '2026-07-01T06:30:00.000Z');
});

test('op de dag van de klokwissel schuift 08:00 mee met de wandklok', () => {
  // 29 maart 2026: om 02:00 springt de klok naar 03:00 — 08:00 wandklok is 06:00Z.
  assert.equal(wallToUtc('Europe/Amsterdam', 2026, 3, 29, 8).toISOString(), '2026-03-29T06:00:00.000Z');
  // 25 oktober 2026: terug naar wintertijd — 08:00 wandklok is 07:00Z.
  assert.equal(wallToUtc('Europe/Amsterdam', 2026, 10, 25, 8).toISOString(), '2026-10-25T07:00:00.000Z');
});

test('de lokale datum volgt de tijdzone, niet UTC', () => {
  assert.deepEqual(localYmd('Europe/Amsterdam', new Date('2026-03-31T22:30:00Z')), { y: 2026, m: 4, d: 1 });
  assert.deepEqual(localYmd('UTC', new Date('2026-03-31T22:30:00Z')), { y: 2026, m: 3, d: 31 });
});

test('offset en maandlengte', () => {
  assert.equal(tzOffsetMs('Europe/Amsterdam', new Date('2026-07-01T00:00:00Z')), 2 * 3600000);
  assert.equal(tzOffsetMs('Europe/Amsterdam', new Date('2026-01-01T00:00:00Z')), 3600000);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 12), 31);
});
