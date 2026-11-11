/**
 * Vooruitbetaalde kosten: het schema en de stand per post.
 *
 * De database maakt het echte schema (prepaid_build_schedule, migratie
 * 20261111220000). Deze module rekent precies hetzelfde uit, zodat het
 * formulier vóór het vastleggen kan laten zien wat er gaat gebeuren: hoeveel
 * per maand, van wanneer tot wanneer. prepaid.test.ts houdt de twee gelijk.
 *
 * Puur (alleen types), zodat `npm test` er rechtstreeks overheen draait.
 */
import type { PrepaidExpense, PrepaidExpenseRelease } from '../types';

export interface PrepaidTerm {
  periodIndex: number;
  /** Laatste dag van de maand, JJJJ-MM-DD. */
  date: string;
  amountCents: number;
  remainingAfterCents: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** De laatste dag van de maand `offset` maanden na de maand van `iso`. In UTC, zodat de tijdzone niets verschuift. */
export function monthEndAfter(iso: string, offset = 0): string {
  const [y, m] = iso.split('-').map(Number);
  const index = (m - 1) + offset;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${pad(month + 1)}-${pad(last)}`;
}

/** De laatste dag van de maand waar `iso` in valt. */
export const monthEnd = (iso: string): string => monthEndAfter(iso, 0);

/**
 * Het schema: per maand een termijn op de laatste dag, het restant van de
 * deling met een cent per termijn in de eerste maanden. € 1.000 over 36
 * maanden is 28 × € 27,78 en 8 × € 27,77, samen precies € 1.000. Een termijn
 * van nul (een paar cent over veel maanden) bestaat niet.
 */
export function prepaidSchedule(amountCents: number, months: number, startDate: string): PrepaidTerm[] {
  const total = Math.round(amountCents);
  const count = Math.trunc(months);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(count) || count < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return [];
  const monthly = Math.floor(total / count);
  const remainder = total - monthly * count;
  const terms: PrepaidTerm[] = [];
  let accumulated = 0;
  for (let i = 1; i <= count; i += 1) {
    const amount = monthly + (i <= remainder ? 1 : 0);
    accumulated += amount;
    if (amount <= 0) continue;
    terms.push({ periodIndex: i, date: monthEndAfter(startDate, i - 1), amountCents: amount, remainingAfterCents: total - accumulated });
  }
  return terms;
}

/** Groepen gelijke termijnen, voor één zin: [{ count: 28, amountCents: 2778 }, { count: 8, amountCents: 2777 }]. */
export function termGroups(terms: PrepaidTerm[]): Array<{ count: number; amountCents: number }> {
  const groups: Array<{ count: number; amountCents: number }> = [];
  for (const term of terms) {
    const last = groups[groups.length - 1];
    if (last && last.amountCents === term.amountCents) last.count += 1;
    else groups.push({ count: 1, amountCents: term.amountCents });
  }
  return groups;
}

/** Staat het bedrag op de balans, zodat de termijnen naar de kosten kunnen? */
export function isOnBalance(item: Pick<PrepaidExpense, 'start_mode' | 'start_journal_entry_id'>): boolean {
  return item.start_mode === 'existing' || item.start_journal_entry_id != null;
}

export interface PrepaidSummary {
  /** Al als kosten geboekt (de geboekte termijnen). */
  releasedCents: number;
  /** Wat er nog op de balans staat: 0 als het bedrag er nog niet op staat, of als de post is afgerond of beëindigd. */
  onBalanceCents: number;
  postedCount: number;
  scheduledCount: number;
  /** Geplande termijnen t/m `throughDate`, die nu te boeken zijn. */
  dueCount: number;
  dueCents: number;
  /** De eerstvolgende geplande termijn. */
  nextDate: string | null;
  /** De laatste termijn van het schema (geboekt of gepland). */
  lastDate: string | null;
}

export function prepaidSummary(item: PrepaidExpense, releases: PrepaidExpenseRelease[], throughDate: string): PrepaidSummary {
  const own = releases.filter(r => r.prepaid_expense_id === item.id).sort((a, b) => a.period_index - b.period_index);
  const posted = own.filter(r => r.status === 'posted');
  const scheduled = own.filter(r => r.status === 'scheduled');
  const releasedCents = posted.reduce((sum, r) => sum + r.amount_cents, 0);
  const canPost = item.status === 'active' && isOnBalance(item);
  const due = canPost ? scheduled.filter(r => r.date <= throughDate) : [];
  return {
    releasedCents,
    onBalanceCents: item.status === 'active' && isOnBalance(item) ? Math.max(item.amount_cents - releasedCents, 0) : 0,
    postedCount: posted.length,
    scheduledCount: scheduled.length,
    dueCount: due.length,
    dueCents: due.reduce((sum, r) => sum + r.amount_cents, 0),
    nextDate: scheduled[0]?.date ?? null,
    lastDate: own.length ? own[own.length - 1].date : null,
  };
}

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/** "november 2026" voor een datum JJJJ-MM-DD. */
export function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${MONTHS[(m - 1 + 12) % 12]} ${y}`;
}
