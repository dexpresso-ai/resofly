import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  calculateDunningClaim, calculateStatutoryInterestCents, halfYearStart, staleRate, staleRateMessage, type InterestKind, type RatePeriod,
} from './dunning.ts';

/**
 * De wettelijke rente en de handelsrente kunnen per 1 januari en per 1 juli
 * veranderen. De tabel wordt met een migratie bijgewerkt; tot 22 november 2026
 * herinnerde niets daaraan en rekende een aanmaning na de jaarwissel stil door
 * met het tarief van het vorige halfjaar. Deze tests bewaken twee dingen: het
 * voorstel zegt het als de tabel achterloopt, en de ontwikkelaar merkt het
 * doordat de laatste test faalt.
 */

const RATES: RatePeriod[] = [
  { kind: 'consumer', rateBasisPoints: 400, validFrom: '2026-01-01' },
  { kind: 'consumer', rateBasisPoints: 400, validFrom: '2026-07-01' },
  { kind: 'commercial', rateBasisPoints: 1015, validFrom: '2026-01-01' },
  { kind: 'commercial', rateBasisPoints: 1040, validFrom: '2026-07-01' },
];

test('het halfjaar begint op 1 januari of 1 juli', () => {
  assert.equal(halfYearStart('2026-06-30'), '2026-01-01');
  assert.equal(halfYearStart('2026-07-01'), '2026-07-01');
  assert.equal(halfYearStart('2026-12-31'), '2026-07-01');
  assert.equal(halfYearStart('2027-01-01'), '2027-01-01');
  assert.throws(() => halfYearStart('1 januari'));
});

test('de tabel is bij tot en met het halfjaar van de laatste regel', () => {
  assert.equal(staleRate('commercial', RATES, '2026-11-22'), null);
  assert.equal(staleRate('consumer', RATES, '2026-12-31'), null);
  assert.deepEqual(staleRate('commercial', RATES, '2027-01-01'), { kind: 'commercial', missingFrom: '2027-01-01', usedRateBasisPoints: 1040, lastValidFrom: '2026-07-01' });
  assert.deepEqual(staleRate('consumer', RATES, '2027-02-15'), { kind: 'consumer', missingFrom: '2027-01-01', usedRateBasisPoints: 400, lastValidFrom: '2026-07-01' });
  // Twee halfjaren achter: het eerste dat ontbreekt.
  assert.equal(staleRate('consumer', RATES, '2027-08-01')?.missingFrom, '2027-01-01');
  // Een regel voor het nieuwe halfjaar, ook met hetzelfde tarief, en de melding is weg.
  const bij = [...RATES, { kind: 'consumer' as InterestKind, rateBasisPoints: 400, validFrom: '2027-01-01' }];
  assert.equal(staleRate('consumer', bij, '2027-02-15'), null);
  assert.equal(staleRate('commercial', bij, '2027-02-15')?.missingFrom, '2027-01-01', 'de andere soort loopt nog achter');
  // Een tabel die een halfjaar oversloeg omdat het tarief gelijk bleef, loopt achter.
  assert.equal(staleRate('consumer', RATES.filter(r => r.validFrom === '2026-01-01'), '2026-11-22')?.missingFrom, '2026-07-01');
  assert.equal(staleRate('consumer', [], '2027-02-15'), null, 'zonder tarieven geen rente en geen melding');
});

test('de melding noemt de soort, de dag en het tarief waarmee gerekend is', () => {
  const consumer = staleRateMessage(staleRate('consumer', RATES, '2027-02-15')!);
  assert.match(consumer, /^De wettelijke rente per 1 januari 2027 staat nog niet in ResoFly\./);
  assert.match(consumer, /\(4,00%\)/);
  const commercial = staleRateMessage(staleRate('commercial', RATES, '2027-02-15')!);
  assert.match(commercial, /wettelijke handelsrente per 1 januari 2027/);
  assert.match(commercial, /\(10,40%\)/);
  assert.match(commercial, /Kijk het tarief na voordat je verstuurt/);
});

test('een aanmaning over de jaarwissel rekent door met het laatste tarief (en daarom de melding)', () => {
  // Vervallen op 30 november 2026, aangemaand op 15 februari 2027: 31 dagen in
  // 2026 en 46 in 2027, alles tegen 10,40% zolang 2027 niet in de tabel staat.
  const interest = calculateStatutoryInterestCents({ principalCents: 121_000, dueDate: '2026-11-30', calculationDate: '2027-02-15', kind: 'commercial', ratePeriods: RATES });
  assert.equal(interest.days, 77);
  assert.equal(interest.segments.length, 1);
  assert.equal(interest.interestCents, Math.round((121_000 * 77 * 0.104) / 365));
  const claim = calculateDunningClaim({ principalCents: 121_000, dueDate: '2026-11-30', calculationDate: '2027-02-15', interestKind: 'commercial', ratePeriods: RATES });
  assert.equal(claim.totalClaimCents, 121_000 + interest.interestCents + claim.collectionCostsCents);
});

// ── De tabel in de migraties ───────────────────────────────────────────────

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/** Alle tarieven die de migraties in statutory_interest_rates zetten. */
function ratesFromMigrations(): RatePeriod[] {
  const rows: RatePeriod[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => /^\d{14}_.+\.sql$/.test(name)).sort()) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    if (!sql.includes('statutory_interest_rates')) continue;
    const code = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
    for (const match of code.matchAll(/\(\s*'(consumer|commercial)'\s*,\s*(\d+)\s*,\s*'(\d{4}-\d{2}-\d{2})'/g)) {
      rows.push({ kind: match[1] as InterestKind, rateBasisPoints: Number(match[2]), validFrom: match[3] });
    }
  }
  return rows;
}

test('de migraties kennen de tarieven die er op 22 november 2026 waren', () => {
  const rows = ratesFromMigrations();
  const rate = (kind: InterestKind, from: string) => rows.find(r => r.kind === kind && r.validFrom === from)?.rateBasisPoints;
  assert.equal(rate('consumer', '2026-01-01'), 400);
  assert.equal(rate('consumer', '2026-07-01'), 400);
  assert.equal(rate('commercial', '2026-01-01'), 1015);
  assert.equal(rate('commercial', '2026-07-01'), 1040);
});

test('de tarieftabel is bijgewerkt voor het lopende halfjaar', () => {
  // Twee weken speling: de tarieven per 1 januari en 1 juli worden rond die
  // datum bekendgemaakt. In die twee weken waarschuwt het aanmaningsvoorstel
  // al wel (dat kent geen speling).
  const GRACE_DAYS = 14;
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(Date.now() - GRACE_DAYS * 86_400_000));
  const rows = ratesFromMigrations();
  for (const kind of ['consumer', 'commercial'] as const) {
    const stale = staleRate(kind, rows, day);
    assert.equal(stale, null,
      `De ${kind === 'consumer' ? 'wettelijke rente' : 'wettelijke handelsrente'} per ${stale?.missingFrom} staat niet in statutory_interest_rates. `
      + 'Zoek het tarief op (Rijksoverheid, "Hoogte wettelijke rente"; KCBR-informatieblad) en voeg het toe met een nieuwe migratie: '
      + 'één regel per soort per halfjaar, ook als het tarief gelijk blijft. Zie 20261122142000_wettelijke_rente_elk_halfjaar.sql.');
  }
});
