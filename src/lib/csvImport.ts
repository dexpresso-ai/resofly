// Generieke CSV-import met VASTE kolomkoppen (sjabloon-aanpak). De gebruiker
// downloadt een voorbeeldbestand, vult dat en uploadt het terug. De kolomnamen
// uit dat sjabloon worden 1-op-1 herkend (hoofdletterongevoelig). Onbekende
// kolommen worden genegeerd; ontbrekende verplichte kolommen geven een nette
// fout, en per rij wordt de inhoud gevalideerd voordat er iets wordt opgeslagen.
//
// De regel-splitsing volgt dezelfde best-effort als de bankimport
// (lib/bankImport/csv.ts): quotes worden gerespecteerd en de scheidingsteken
// (; , of tab) wordt automatisch gedetecteerd.

export type ColumnKind = 'text' | 'email' | 'number' | 'enum' | 'tags';

export interface ImportColumn {
  /** Veldnaam in het op te slaan record. */
  key: string;
  /** Kolomkop zoals die in het CSV-sjabloon staat. */
  header: string;
  required?: boolean;
  kind?: ColumnKind;
  /** Toegestane invoer → opgeslagen waarde (sleutels lowercase) bij kind 'enum'. */
  enumValues?: Record<string, string>;
  /** Waarde wanneer de cel leeg is of de kolom ontbreekt. */
  default?: unknown;
  /** Voorbeeldwaarde voor de eerste regel van het sjabloonbestand. */
  example?: string;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export interface PreparedRow {
  /** De ruwe celwaarden, voor weergave in de preview. */
  raw: string[];
  /** Het genormaliseerde record dat opgeslagen kan worden. */
  record: Record<string, unknown>;
  /** Validatiefouten; een rij met fouten wordt overgeslagen bij import. */
  errors: string[];
}

export interface PreparedImport {
  /** Kolomkoppen van verplichte kolommen die niet in het bestand stonden. */
  missingRequired: string[];
  rows: PreparedRow[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Splitst één CSV-regel met respect voor dubbele quotes. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i += 1; }
      else inQuotes = !inQuotes;
    } else if (ch === delim && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^"|"$/g, ''));
}

function detectDelimiter(headerLine: string): string {
  const counts: Record<string, number> = {
    ';': (headerLine.match(/;/g) || []).length,
    ',': (headerLine.match(/,/g) || []).length,
    '\t': (headerLine.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}

export function parseCsv(raw: string): ParsedCsv {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error('Het bestand is leeg.');
  const delim = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delim);
  const rows = lines.slice(1).map(l => splitLine(l, delim));
  return { headers, rows };
}

/** Probeert een (Nederlands of internationaal geschreven) bedrag te lezen. */
function parseNumber(raw: string): number | null {
  const cleaned = raw.replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // Beide aanwezig: punt = duizendtal, komma = decimaal (NL-notatie).
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

const lower = (s: string) => s.trim().toLowerCase();

function emptyValue(col: ImportColumn): unknown {
  if (col.default !== undefined) return col.default;
  if (col.kind === 'tags') return [];
  return null;
}

function prepareRow(raw: string[], columns: ImportColumn[], columnIndex: Record<string, number>): PreparedRow {
  const record: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const col of columns) {
    const idx = columnIndex[col.key];
    const cell = idx >= 0 ? (raw[idx] ?? '').trim() : '';

    if (!cell) {
      if (col.required) errors.push(`"${col.header}" is verplicht`);
      record[col.key] = emptyValue(col);
      continue;
    }

    switch (col.kind) {
      case 'email': {
        const value = cell.toLowerCase();
        if (!EMAIL_RE.test(value)) errors.push(`Ongeldig e-mailadres: "${cell}"`);
        record[col.key] = value;
        break;
      }
      case 'number': {
        const n = parseNumber(cell);
        if (n === null) errors.push(`Ongeldig getal bij "${col.header}": "${cell}"`);
        record[col.key] = n ?? (col.default ?? 0);
        break;
      }
      case 'enum': {
        const matched = col.enumValues?.[lower(cell)];
        if (!matched) errors.push(`Ongeldige waarde bij "${col.header}": "${cell}"`);
        record[col.key] = matched ?? emptyValue(col);
        break;
      }
      case 'tags': {
        record[col.key] = cell.split(/[;,|]/).map(t => t.trim()).filter(Boolean);
        break;
      }
      default:
        record[col.key] = cell;
    }
  }

  return { raw, record, errors };
}

export function prepareImport(parsed: ParsedCsv, columns: ImportColumn[]): PreparedImport {
  const headerLower = parsed.headers.map(lower);
  const columnIndex: Record<string, number> = {};
  const missingRequired: string[] = [];

  for (const col of columns) {
    const idx = headerLower.indexOf(lower(col.header));
    columnIndex[col.key] = idx;
    if (idx === -1 && col.required) missingRequired.push(col.header);
  }

  const rows = missingRequired.length
    ? []
    : parsed.rows.map(raw => prepareRow(raw, columns, columnIndex));

  return { missingRequired, rows };
}
