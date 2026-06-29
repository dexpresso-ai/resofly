import { computeTotals, lineGross, lineNet, type MoneyTotals } from './money';

export const euro = (amount: number | null | undefined) =>
  new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(amount ?? 0));

function parseDateForDisplay(date: string): Date {
  // Treat Postgres DATE values (YYYY-MM-DD) as local calendar dates. `new Date('YYYY-MM-DD')`
  // is parsed as UTC and can show one day earlier in western timezones.
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(date);
}

export const dateNL = (date?: string | null) => {
  if (!date) return '—';
  const parsed = parseDateForDisplay(date);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('nl-NL');
};

export const uid = () => crypto.randomUUID();

/** Minuten → korte leesbare duur, bijv. "1u 30m", "45m", "2u". */
export const formatMinutes = (minutes: number | null | undefined): string => {
  const m = Math.max(0, Math.round(Number(minutes ?? 0)));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}u`;
  return `${h}u ${rem}m`;
};

/** Minuten → decimale uren afgerond op 2 decimalen (bijv. 90 → 1.5). */
export const minutesToHours = (minutes: number | null | undefined): number =>
  Math.round((Number(minutes ?? 0) / 60) * 100) / 100;

// `total` blijft de publieke API voor de hele app, maar rekent nu cent-exact en
// per btw-tarief via de centrale geldmodule. Subtotaal + btw sluit gegarandeerd
// aan op het totaal, en `total.total` is identiek aan wat naar Mollie gaat.
export const total = (lines: { quantity: number; unit_price: number; vat: number }[] = []): MoneyTotals =>
  computeTotals(lines);

export { lineGross, lineNet };
export const priorityLabel = (p: string) => p === 'high' ? 'Hoog' : p === 'med' ? 'Normaal' : 'Laag';
