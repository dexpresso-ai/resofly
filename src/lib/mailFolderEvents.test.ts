import test from 'node:test';
import assert from 'node:assert/strict';
import { mailFoldersChanged, onMailFoldersChanged } from './mailFolderEvents.ts';

/**
 * Een goedgekeurd voorstel van Gerrie (mail verplaatsen, een map maken) moet
 * een open Berichten en klantdossier laten bijwerken. Dit signaal is de draad
 * daartussen; brak hij, dan stond de mail tot je de pagina opnieuw opende op
 * zijn oude plek.
 */
test('een wijziging bereikt elke luisteraar, en na afmelden niet meer', () => {
  let a = 0;
  let b = 0;
  const offA = onMailFoldersChanged(() => { a += 1; });
  const offB = onMailFoldersChanged(() => { b += 1; });
  mailFoldersChanged();
  assert.deepEqual([a, b], [1, 1]);
  offA();
  mailFoldersChanged();
  assert.deepEqual([a, b], [1, 2]);
  offB();
});

test('een luisteraar die gooit, houdt de rest niet tegen', () => {
  let reached = false;
  const offBad = onMailFoldersChanged(() => { throw new Error('kapot'); });
  const offGood = onMailFoldersChanged(() => { reached = true; });
  assert.doesNotThrow(() => mailFoldersChanged());
  assert.equal(reached, true);
  offBad();
  offGood();
});
