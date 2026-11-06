/**
 * Date utilities. All functions treat YYYY-MM-DD as a *local* calendar date,
 * matching how Postgres DATE columns are interpreted by users (no timezone shift).
 */

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function formatISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Vandaag als JJJJ-MM-DD in de tijdzone van de gebruiker. Niet
 * `new Date().toISOString().slice(0, 10)`: dat is de UTC-datum en geeft in
 * Nederland tussen middernacht en 01:00/02:00 nog gisteren (op 1 januari: het
 * vorige boekjaar).
 */
export function todayIso(): string {
  return formatISODate(new Date());
}

/**
 * Vandaag in Nederland als JJJJ-MM-DD, waar de bezoeker ook zit. Voor een
 * datum die de afzender als kalenderdag hier bedoelt, zoals "geldig tot" op een
 * offerte. Met de UTC-datum bleef een verlopen offerte tussen middernacht en
 * 01:00/02:00 nog een uur of twee te accorderen; met de klok van de bezoeker
 * hangt het af van waar die op vakantie is.
 *
 * Via formatToParts en niet via de standaardnotatie van een taal: die
 * notatie (en-CA, sv-SE) is wel eens gewijzigd tussen browserversies.
 */
export function amsterdamTodayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Monday-aligned start of the week containing `d`. NL convention. */
export function startOfWeek(d: Date): Date {
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diff = day === 0 ? -6 : 1 - day;
  const result = new Date(d);
  result.setDate(d.getDate() + diff);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(d.getDate() + n);
  return result;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export const DAY_NAMES_NL = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'] as const;

/** ISO week number (1–53) using the standard ISO 8601 algorithm. */
export function isoWeekNumber(d: Date): number {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = target.getUTCDay() === 0 ? 7 : target.getUTCDay();
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
