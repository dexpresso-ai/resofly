import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOnBalance, monthEnd, monthEndAfter, monthLabel, prepaidSchedule, prepaidSummary, termGroups } from './prepaid.ts';
import type { PrepaidExpense, PrepaidExpenseRelease } from '../types';

/**
 * Vooruitbetaalde kosten: het schema in het formulier moet precies zijn wat de
 * database straks boekt (prepaid_build_schedule, 20261111220000). Het
 * voorbeeld uit de vraag: € 1.000 verzekering, drie jaar dekking.
 */

test('€ 1.000 over 36 maanden: 28 × € 27,78 en 8 × € 27,77, samen precies € 1.000', () => {
  const terms = prepaidSchedule(100000, 36, '2026-11-11');
  assert.equal(terms.length, 36);
  assert.deepEqual(termGroups(terms), [{ count: 28, amountCents: 2778 }, { count: 8, amountCents: 2777 }]);
  assert.equal(terms.reduce((sum, t) => sum + t.amountCents, 0), 100000);
  assert.equal(terms[0].date, '2026-11-30', 'de eerste termijn valt op het einde van de eerste maand');
  assert.equal(terms[35].date, '2029-10-31', '36 maanden vanaf november 2026 lopen tot en met oktober 2029');
  assert.equal(terms[0].remainingAfterCents, 100000 - 2778);
  assert.equal(terms[35].remainingAfterCents, 0);
});

test('het einde van de maand: schrikkeljaar, jaarwisseling, de 31e', () => {
  assert.equal(monthEnd('2028-02-10'), '2028-02-29');
  assert.equal(monthEnd('2027-02-10'), '2027-02-28');
  assert.equal(monthEndAfter('2026-11-11', 2), '2027-01-31');
  assert.equal(monthEndAfter('2026-01-31', 1), '2026-02-28', 'van de 31e naar een korte maand schuift niet door naar maart');
  assert.equal(monthEndAfter('2026-12-01', 12), '2027-12-31');
  assert.deepEqual(prepaidSchedule(9000, 3, '2028-01-15').map(t => t.date), ['2028-01-31', '2028-02-29', '2028-03-31']);
});

test('geen termijnen van nul: een paar cent over veel maanden', () => {
  const terms = prepaidSchedule(10, 36, '2026-01-01');
  assert.equal(terms.length, 10);
  assert.ok(terms.every(t => t.amountCents === 1));
  assert.equal(terms[9].remainingAfterCents, 0);
  assert.equal(terms[9].periodIndex, 10);
});

test('onzin geeft geen schema', () => {
  assert.deepEqual(prepaidSchedule(0, 12, '2026-01-01'), []);
  assert.deepEqual(prepaidSchedule(1000, 0, '2026-01-01'), []);
  assert.deepEqual(prepaidSchedule(1000, 12, ''), []);
  assert.deepEqual(prepaidSchedule(Number.NaN, 12, '2026-01-01'), []);
});

test('dezelfde verdeling en datums als de database', () => {
  // Grof maar doeltreffend: verandert de regel in de migratie, dan hoort deze
  // module mee te veranderen (en andersom).
  const sql = readFileSync(new URL('../../supabase/migrations/20261111220000_vooruitbetaalde_kosten.sql', import.meta.url), 'utf8');
  const fn = sql.slice(sql.indexOf('create or replace function public.prepaid_build_schedule'), sql.indexOf('create or replace function public.prepaid_post_item_releases'));
  assert.match(fn, /v_monthly := v_item\.amount_cents \/ v_item\.months;/);
  assert.match(fn, /v_amount := v_monthly \+ case when i <= v_remainder then 1 else 0 end;/);
  assert.match(fn, /continue when v_amount <= 0;/);
  assert.match(fn, /public\.prepaid_month_end\(\(date_trunc\('month', v_item\.start_date::timestamp\) \+ make_interval\(months => i - 1\)\)::date\)/);
});

const item = (over: Partial<PrepaidExpense> = {}): PrepaidExpense => ({
  id: 'p1', organization_id: 'o1', created_by: null, description: 'Verzekering', amount_cents: 100000,
  payment_date: '2026-11-11', start_date: '2026-11-01', months: 36, prepaid_account_id: 'a1', expense_account_id: 'a2',
  start_mode: 'book', counter_account_id: 'a3', start_journal_entry_id: 'j1', source_purchase_invoice_id: null,
  status: 'active', end_date: null, end_amount_cents: null, end_refund_cents: null, end_refund_account_id: null,
  end_journal_entry_id: null, notes: null, created_at: '', updated_at: '', ...over,
});

const releases = (posted: number): PrepaidExpenseRelease[] => prepaidSchedule(100000, 36, '2026-11-01').map(t => ({
  id: `r${t.periodIndex}`, organization_id: 'o1', prepaid_expense_id: 'p1', period_index: t.periodIndex, date: t.date,
  amount_cents: t.amountCents, remaining_after_cents: t.remainingAfterCents,
  status: t.periodIndex <= posted ? 'posted' : 'scheduled', journal_entry_id: null, posted_at: null, created_at: '',
}));

test('de stand per post: geboekt, op de balans, nu te boeken', () => {
  const summary = prepaidSummary(item(), releases(2), '2027-01-31');
  assert.equal(summary.postedCount, 2);
  assert.equal(summary.releasedCents, 2 * 2778);
  assert.equal(summary.onBalanceCents, 100000 - 2 * 2778);
  assert.equal(summary.dueCount, 1, 'januari 2027 staat klaar');
  assert.equal(summary.dueCents, 2778);
  assert.equal(summary.nextDate, '2027-01-31');
  assert.equal(summary.lastDate, '2029-10-31');
});

test('niets te boeken zolang het bedrag niet op de balans staat, of de post klaar is', () => {
  const notBooked = item({ start_journal_entry_id: null });
  assert.equal(isOnBalance(notBooked), false);
  assert.equal(prepaidSummary(notBooked, releases(0), '2027-12-31').dueCount, 0);
  assert.equal(prepaidSummary(notBooked, releases(0), '2027-12-31').onBalanceCents, 0);
  assert.equal(isOnBalance(item({ start_mode: 'existing', start_journal_entry_id: null })), true);
  assert.equal(prepaidSummary(item({ status: 'ended' }), releases(5), '2027-12-31').dueCount, 0);
  assert.equal(prepaidSummary(item({ status: 'ended' }), releases(5), '2027-12-31').onBalanceCents, 0);
});

test('maandnaam', () => {
  assert.equal(monthLabel('2026-11-30'), 'november 2026');
  assert.equal(monthLabel('2029-01-31'), 'januari 2029');
});
