/**
 * Tests voor de zin na een matchronde en het doorgaan in rondes (bankMatch.ts).
 * Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMatchResults, describeMatchProgress, describeMatchResult, runMatchRounds, type BankMatchSummaryInput } from './bankMatch.ts';

const leeg: BankMatchSummaryInput = { suggested: 0, auto_booked: 0, auto_booked_purchase: 0, merged: 0, processed: 0, remaining: 0, next_cursor: null };

test('niets gevonden', () => {
  assert.equal(describeMatchResult(leeg), 'Niets nieuws gevonden.');
  assert.equal(describeMatchResult(leeg, { nothingText: null }), null);
});

test('afgeletterd, bankregel en voorstellen apart genoemd', () => {
  assert.equal(
    describeMatchResult({ ...leeg, auto_booked: 5, auto_booked_purchase: 3, suggested: 2 }),
    '3 betalingen meteen afgeletterd tegen een inkoopfactuur, 2 transacties geboekt met een bankregel, 2 transacties hebben een voorstel.',
  );
  assert.equal(
    describeMatchResult({ ...leeg, auto_booked: 1, auto_booked_purchase: 1, suggested: 1 }),
    '1 betaling meteen afgeletterd tegen een inkoopfactuur, 1 transactie heeft een voorstel.',
  );
});

test('samengevoegd, en wat er na de laatste ronde nog ligt', () => {
  assert.equal(
    describeMatchResult({ ...leeg, merged: 1 }),
    '1 bankregel bevestigt een mutatie die je zelf invoerde (samengevoegd).',
  );
  assert.equal(
    describeMatchResult({ ...leeg, auto_booked: 150, auto_booked_purchase: 150, remaining: 7351, next_cursor: '2026-08-04|x' }),
    '150 betalingen meteen afgeletterd tegen een inkoopfactuur. Nog 7.351 transacties niet nagelopen. Klik nog eens op "Opnieuw matchen".',
  );
  // Een oudere database kent remaining niet: dan geen zin erover.
  assert.equal(describeMatchResult({ suggested: 0, auto_booked: 0, auto_booked_purchase: 0, merged: 0 }), 'Niets nieuws gevonden.');
});

test('voortgang tijdens de rondes', () => {
  assert.equal(
    describeMatchProgress({ ...leeg, processed: 12949, remaining: 7351, auto_booked: 87, auto_booked_purchase: 87 }),
    'Bezig met matchen: 12.949 van 20.300 transacties nagelopen, 87 meteen afgeletterd…',
  );
  assert.equal(describeMatchProgress({ ...leeg, processed: 10, remaining: 5 }), 'Bezig met matchen: 10 van 15 transacties nagelopen…');
});

test('rondes optellen: tellers opgeteld, rest en cursor van de laatste', () => {
  const a = { ...leeg, suggested: 18, auto_booked: 87, auto_booked_purchase: 87, processed: 12949, remaining: 7351, next_cursor: 'c1' };
  const b = { ...leeg, suggested: 37, auto_booked: 213, auto_booked_purchase: 213, processed: 7351, remaining: 0, next_cursor: null };
  assert.deepEqual(addMatchResults(a, b), {
    ...leeg, suggested: 55, auto_booked: 300, auto_booked_purchase: 300, processed: 20300, remaining: 0, next_cursor: null,
  });
});

test('doorgaan tot er geen cursor meer is, met voortgang', async () => {
  const gezien: string[] = [];
  const voortgang: number[] = [];
  const rondes: Record<string, BankMatchSummaryInput> = {
    c1: { ...leeg, processed: 100, remaining: 50, auto_booked: 2, auto_booked_purchase: 2, next_cursor: 'c2' },
    c2: { ...leeg, processed: 50, remaining: 0, auto_booked: 1, auto_booked_purchase: 1, next_cursor: null },
  };
  const totaal = await runMatchRounds(
    { ...leeg, processed: 200, remaining: 150, auto_booked: 5, auto_booked_purchase: 5, next_cursor: 'c1' },
    async (cursor) => { gezien.push(cursor); return rondes[cursor]; },
    { onProgress: (r) => voortgang.push(r.processed ?? 0) },
  );
  assert.deepEqual(gezien, ['c1', 'c2']);
  assert.deepEqual(voortgang, [200, 300]);
  assert.equal(totaal.processed, 350);
  assert.equal(totaal.auto_booked_purchase, 8);
  assert.equal(totaal.next_cursor, null);
});

test('stoppen na maxRounds, en als een ronde niet opschiet', async () => {
  let n = 0;
  const altijd = await runMatchRounds(
    { ...leeg, processed: 1, remaining: 99, next_cursor: 'c0' },
    async () => { n += 1; return { ...leeg, processed: 1, remaining: 99 - n, next_cursor: `c${n}` }; },
    { maxRounds: 3 },
  );
  assert.equal(n, 2, 'de eerste ronde telt mee');
  assert.equal(altijd.next_cursor, 'c2');
  let m = 0;
  const vast = await runMatchRounds(
    { ...leeg, processed: 1, remaining: 9, next_cursor: 'zelfde' },
    async () => { m += 1; return { ...leeg, processed: 1, remaining: 9, next_cursor: 'zelfde' }; },
  );
  assert.equal(m, 1, 'na één ronde zonder voortgang gestopt');
  assert.equal(vast.next_cursor, 'zelfde');
});
