import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvSafeText } from './csv.ts';

test('een formule wordt tekst', () => {
  assert.equal(csvSafeText('=HYPERLINK("https://evil.example","klik")'), `'=HYPERLINK("https://evil.example","klik")`);
  assert.equal(csvSafeText('+31 6 1234'), `'+31 6 1234`);
  assert.equal(csvSafeText('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(csvSafeText('-dit is tekst'), `'-dit is tekst`);
});

test('getallen en gewone tekst blijven zoals ze zijn', () => {
  assert.equal(csvSafeText(-12.5), '-12.5');
  assert.equal(csvSafeText('-1234,56'), '-1234,56');
  assert.equal(csvSafeText('-1234.56'), '-1234.56');
  assert.equal(csvSafeText('Bakkerij Jansen'), 'Bakkerij Jansen');
  assert.equal(csvSafeText(''), '');
});
