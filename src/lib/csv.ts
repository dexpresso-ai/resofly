// Gedeelde CSV-download. Schrijft een UTF-8 BOM zodat Excel (NL) de ; -scheiding
// en accenttekens correct interpreteert. Zelfde gedrag als de oude private kopie
// in ProfitLoss, nu herbruikbaar voor de rapportbouwer en toekomstige modules.
export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]): void {
  const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(r => r.map(escape).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
