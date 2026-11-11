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

/**
 * Een bedrag als "-1234.56" wordt "-1234,56": met ; als scheidingsteken leest
 * Nederlandse Excel een punt als tekst of als datum ("12.05" → 12 mei). De
 * W&V-export deed dit al; de ICP-opgaaf en de rapportbouwer niet. Alleen
 * cellen die precies een bedrag met twee decimalen zijn.
 */
export function csvAmountCell(v: string | number): string {
  const text = typeof v === 'number' ? String(v) : v;
  return /^-?\d+\.\d{2}$/.test(text) ? text.replace('.', ',') : text;
}

/** Regels met ; als scheidingsteken, zonder BOM (die zet downloadCsv of de export ervoor). */
export function buildCsvLines(rows: (string | number)[][]): string {
  const escape = (v: string | number) => `"${csvSafeText(csvAmountCell(v)).replace(/"/g, '""')}"`;
  return rows.map(r => r.map(escape).join(';')).join('\r\n');
}

/** Een heel CSV-bestand met kopregel en BOM, zoals Excel (NL) het verwacht. */
export function buildCsv(header: string[], rows: (string | number)[][]): string {
  return `\uFEFF${buildCsvLines([header, ...rows])}`;
}

export function downloadCsv(filename: string, header: string[], rows: (string | number)[][]): void {
  const url = URL.createObjectURL(new Blob([buildCsv(header, rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
