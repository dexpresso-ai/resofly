// Gedeelde CSV-download. Schrijft een UTF-8 BOM zodat Excel (NL) de ; -scheiding
// en accenttekens correct interpreteert. Zelfde gedrag als de oude private kopie
// in ProfitLoss, nu herbruikbaar voor de rapportbouwer en toekomstige modules.
/**
 * Een cel die met = + - @ (of tab/CR) begint, voert Excel uit als formule: een
 * klantnaam als `=HYPERLINK("https://…")` wordt dan een link, en erger. Een
 * apostrof ervoor maakt er tekst van. Getallen (ook negatieve, met punt of
 * komma) blijven getallen.
 */
export function csvSafeText(v: string | number): string {
  const text = String(v);
  if (typeof v === 'number' || /^-?\d+(?:[.,]\d+)?$/.test(text)) return text;
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]): void {
  const escape = (v: string | number) => `"${csvSafeText(v).replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(r => r.map(escape).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
