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
export const total = (lines: { quantity: number; unit_price: number; vat: number }[] = []) => {
  const subtotal = lines.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(l.unit_price || 0), 0);
  const vat = lines.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(l.unit_price || 0) * Number(l.vat || 0) / 100, 0);
  return { subtotal, vat, total: subtotal + vat };
};
export const priorityLabel = (p: string) => p === 'high' ? 'Hoog' : p === 'med' ? 'Normaal' : 'Laag';
