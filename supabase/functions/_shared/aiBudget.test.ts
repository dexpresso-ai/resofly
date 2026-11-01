import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiBudgetVerdict, budgetLimit, DEFAULT_MONTHLY_USER_COST_EUR } from './aiBudget.ts';

test('zonder env-var geldt de standaard; een expliciete 0 is geen plafond', () => {
  assert.equal(budgetLimit(undefined, DEFAULT_MONTHLY_USER_COST_EUR), DEFAULT_MONTHLY_USER_COST_EUR);
  assert.equal(budgetLimit('', 25), 25);
  assert.equal(budgetLimit('abc', 25), 25);
  assert.equal(budgetLimit('-3', 25), 25);
  assert.equal(budgetLimit('0', 25), 0);
  assert.equal(budgetLimit('40', 25), 40);
});

test('het eigen tegoed op: nee', () => {
  const v = aiBudgetVerdict(25, 25, 10, 250);
  assert.equal(v.allowed, false);
  assert.equal(v.scope, 'user');
});

test('het tegoed van de organisatie op: nee, ook als het eigen tegoed nog ruim is', () => {
  const v = aiBudgetVerdict(1, 25, 250, 250);
  assert.equal(v.allowed, false);
  assert.equal(v.scope, 'org');
});

test('ruimte: ja, en de meter volgt wat het krapst zit', () => {
  const v = aiBudgetVerdict(5, 25, 240, 250);
  assert.equal(v.allowed, true);
  assert.equal(v.limitEur, 250);
  const w = aiBudgetVerdict(20, 25, 10, 250);
  assert.equal(w.limitEur, 25);
});

test('geen plafonds: altijd ja', () => {
  assert.equal(aiBudgetVerdict(1000, 0, 1000, 0).allowed, true);
});
