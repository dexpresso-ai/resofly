import test from 'node:test';
import assert from 'node:assert/strict';
import { euro } from './format.ts';

test('euro: nul is nul, ook als hij negatief uit een berekening komt', () => {
  const nul = euro(0);
  assert.equal(euro(-0), nul);
  assert.equal(euro(-1 * 0), nul);
  assert.ok(!euro(-0).includes('-'));
  assert.ok(euro(-12.5).includes('12,50') && euro(-12.5).includes('-'));
});
