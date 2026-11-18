/**
 * Tests voor de zin na een matchronde (bankMatch.ts).
 * Draaien met:  npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMatchResult } from './bankMatch.ts';

const leeg = { suggested: 0, auto_booked: 0, auto_booked_purchase: 0, auto_book_pending: 0, merged: 0 };

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

test('samengevoegd en nog te boeken', () => {
  assert.equal(
    describeMatchResult({ ...leeg, merged: 1 }),
    '1 bankregel bevestigt een mutatie die je zelf invoerde (samengevoegd).',
  );
  assert.equal(
    describeMatchResult({ ...leeg, auto_booked: 150, auto_booked_purchase: 150, auto_book_pending: 6 }),
    '150 betalingen meteen afgeletterd tegen een inkoopfactuur. 6 zekere koppelingen zijn nog niet geboekt omdat er veel tegelijk binnenkwam. Klik nog eens op "Opnieuw matchen".',
  );
  assert.equal(
    describeMatchResult({ ...leeg, auto_book_pending: 1 }),
    '1 zekere koppeling is nog niet geboekt omdat er veel tegelijk binnenkwam. Klik nog eens op "Opnieuw matchen".',
  );
});
