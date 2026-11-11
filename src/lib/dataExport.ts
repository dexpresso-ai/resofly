/**
 * Alles exporteren (Instellingen → Gegevens): één zip met alle gegevens van de
 * organisatie, ook zonder ResoFly te lezen. Zie
 * docs/plannen/GEGEVENS_MEENEMEN_BOUWPLAN_2026-11-11.md, hoofdstuk 4.
 *
 * Wat meegaat, beslist src/lib/exportManifest.ts. Hier alleen de opbouw:
 *  - data/<tabel>.jsonl   per tabel, in pagina's gelezen en meteen gecomprimeerd;
 *  - lijsten/<naam>.csv   de belangrijkste tabellen voor Excel;
 *  - bestanden/…          de originele bestanden, via de media-worker;
 *  - boekhouding/…xaf     een auditfile per boekjaar (src/lib/xaf.ts);
 *  - manifest.json en LEESMIJ.txt.
 *
 * Gelezen wordt met de rechten van wie exporteert (de bron is de gewone
 * Supabase-client). Daarbovenop controleert elke pagina dat elke rij bij deze
 * organisatie hoort (CLAUDE.md, regel 1): een rij van een ander laat de hele
 * tabel uit de zip, met een melding, in plaats van stilletjes mee te gaan.
 *
 * Puur: Supabase en de worker zitten achter ExportSource, zodat `npm test` de
 * hele opbouw met een nep-bron kan nalopen.
 */
import type { AppData } from '../types';
import { buildCsvLines } from './csv.ts';
import {
  cleanRow, EXPORT_FORMAT_VERSION, EXPORT_SCHEMA_VERSION, exportTables, fileKeysOf, skippedTables,
  TABLE_KIND_LABEL, zipPathForKey, type ExportTable, type TableKind,
} from './exportManifest.ts';
import { buildXaf } from './xaf.ts';
import { ZipBuilder } from './zipWriter.ts';

export type ExportRow = Record<string, unknown>;

export interface ExportPageRequest {
  table: string;
  /** Kolommen voor de select: '*' of een lijst met komma's. */
  select: string;
  orgColumn: string;
  organizationId: string;
  orderBy: readonly string[];
  limit: number;
  /**
   * Bladeren op de sorteerkolom (bij één sorteerkolom): de waarde van de
   * laatste rij van de vorige pagina, of undefined voor de eerste pagina.
   * Sneller dan een offset bij grote tabellen, en stabiel als er tijdens het
   * exporteren rijen bijkomen.
   */
  after?: unknown;
  /** Bladeren op positie, bij meer sorteerkolommen. */
  offset?: number;
}

export interface ExportSource {
  fetchRows(request: ExportPageRequest): Promise<ExportRow[]>;
  /** Het opgeslagen bestand, of null als het er niet (meer) is. */
  fetchFile(storageKey: string): Promise<Blob | null>;
}

export type ExportPhase = 'tabellen' | 'bestanden' | 'boekhouding' | 'inpakken';

export interface ExportProgress {
  phase: ExportPhase;
  done: number;
  total: number;
  label?: string;
}

export interface ExportSummary {
  tables: number;
  rows: number;
  files: number;
  fileBytes: number;
  auditfiles: string[];
  missingFiles: Array<{ key: string; message: string }>;
  tableErrors: Array<{ table: string; message: string }>;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  summary: ExportSummary;
}

export interface ExportOptions {
  source: ExportSource;
  organizationId: string;
  organizationName: string;
  exportedBy: { id: string; email?: string | null };
  now?: Date;
  pageSize?: number;
  /** Hoeveel bestanden tegelijk worden opgehaald. */
  fileConcurrency?: number;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
}

export class ExportAbortedError extends Error {
  constructor() {
    super('De export is gestopt.');
    this.name = 'ExportAbortedError';
  }
}

/** Wat de auditfiles nodig hebben; alleen deze tabellen blijven in het geheugen. */
const XAF_TABLES: ReadonlySet<string> = new Set([
  'company_settings', 'ledger_accounts', 'vat_codes', 'journal_entries', 'journal_lines', 'clients', 'suppliers', 'fiscal_years',
]);

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportAbortedError();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; details?: unknown; code?: unknown };
    const parts = [e.message, e.details].filter(v => typeof v === 'string' && v) as string[];
    if (parts.length) return parts.join(' — ');
  }
  return String(error);
}

async function* pages(source: ExportSource, table: ExportTable, organizationId: string, pageSize: number, signal?: AbortSignal): AsyncGenerator<ExportRow[]> {
  const select = table.select ? table.select.join(',') : '*';
  const keyset = table.orderBy.length === 1;
  let after: unknown;
  let offset = 0;
  for (;;) {
    checkAbort(signal);
    const page = await source.fetchRows({
      table: table.table, select, orgColumn: table.orgColumn, organizationId, orderBy: table.orderBy, limit: pageSize,
      ...(keyset ? { after } : { offset }),
    });
    for (const row of page) {
      if (row[table.orgColumn] !== organizationId) {
        throw new Error(`${table.table}: er kwam een rij van een andere organisatie mee. Deze tabel is daarom niet geëxporteerd.`);
      }
    }
    if (page.length) yield page;
    if (page.length < pageSize) return;
    if (keyset) after = page[page.length - 1][table.orderBy[0]];
    else offset += page.length;
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** Kolomkop in de lijst: bedragen in centen worden euro's. */
export function csvHeaderLabel(column: string): string {
  return column.endsWith('_cents') ? `${column.slice(0, -'_cents'.length)}_eur` : column;
}

/** Eén cel: leeg voor null, euro's voor centen, ja/nee, JSON voor lijsten en objecten, een komma voor decimalen. */
export function csvCell(column: string, value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (column.endsWith('_cents') && typeof value === 'number') return (value / 100).toFixed(2);
  if (typeof value === 'boolean') return value ? 'ja' : 'nee';
  if (typeof value === 'number') return Number.isInteger(value) ? value : String(value).replace('.', ',');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ── Bestanden ────────────────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Boekjaren voor de auditfiles ─────────────────────────────────────────────

interface XafPeriod { label: string; start: string; end: string }

export function auditfilePeriods(fiscalYears: ExportRow[], journalEntries: ExportRow[]): XafPeriod[] {
  const posted = journalEntries.filter(e => e.status === 'posted' && typeof e.date === 'string');
  if (!posted.length) return [];
  const inPeriod = (p: XafPeriod) => posted.some(e => String(e.date) >= p.start && String(e.date) <= p.end);
  const fromTable = fiscalYears
    .filter(fy => typeof fy.period_start === 'string' && typeof fy.period_end === 'string')
    .map(fy => ({ label: String(fy.label ?? String(fy.period_start).slice(0, 4)), start: String(fy.period_start), end: String(fy.period_end) }))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (fromTable.length) return fromTable.filter(inPeriod);
  // Geen boekjaren vastgelegd: dan per kalenderjaar, van de eerste tot de laatste boeking.
  const years = posted.map(e => Number(String(e.date).slice(0, 4))).filter(Number.isFinite);
  const out: XafPeriod[] = [];
  for (let year = Math.min(...years); year <= Math.max(...years); year += 1) {
    out.push({ label: String(year), start: `${year}-01-01`, end: `${year}-12-31` });
  }
  return out.filter(inPeriod);
}

// ── De export ────────────────────────────────────────────────────────────────

export function exportFileName(organizationName: string, now: Date): string {
  const slug = organizationName.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'organisatie';
  return `resofly-export-${slug}-${now.toISOString().slice(0, 10)}.zip`;
}

export async function buildDataExport(options: ExportOptions): Promise<ExportResult> {
  const { source, organizationId, organizationName, onProgress, signal } = options;
  const now = options.now ?? new Date();
  const pageSize = options.pageSize ?? 1000;
  const concurrency = Math.max(1, options.fileConcurrency ?? 4);
  const zip = new ZipBuilder();
  const tables = exportTables();

  const summary: ExportSummary = { tables: 0, rows: 0, files: 0, fileBytes: 0, auditfiles: [], missingFiles: [], tableErrors: [] };
  const tableReport: Array<{ tabel: string; bestand: string; rijen: number; lijst?: string }> = [];
  const kept = new Map<string, ExportRow[]>();
  const fileOwners = new Map<string, string>();

  // 1. Tabellen
  for (const [index, table] of tables.entries()) {
    checkAbort(signal);
    onProgress?.({ phase: 'tabellen', done: index, total: tables.length, label: table.table });
    // In een object, omdat de pagina's in een callback binnenkomen: TypeScript
    // ziet een `let` die daar verandert anders als nog steeds leeg.
    const state = { rows: 0, columns: null as string[] | null };
    const csvChunks: string[] = [];
    const keep: ExportRow[] | null = XAF_TABLES.has(table.table) ? [] : null;
    const tableFiles: string[] = [];
    try {
      await zip.addStream(`data/${table.table}.jsonl`, async write => {
        for await (const page of pages(source, table, organizationId, pageSize, signal)) {
          const cleaned = page.map(row => cleanRow(table, row));
          await write(cleaned.map(row => `${JSON.stringify(row)}\n`).join(''));
          state.rows += cleaned.length;
          for (const row of page) tableFiles.push(...fileKeysOf(table, row));
          if (keep) keep.push(...cleaned);
          if (table.list) {
            const columns = state.columns ?? Object.keys(cleaned[0] ?? {});
            state.columns = columns;
            csvChunks.push(buildCsvLines(cleaned.map(row => columns.map(column => csvCell(column, row[column])))));
          }
        }
      }, { compress: true });
    } catch (error) {
      if (error instanceof ExportAbortedError) throw error;
      summary.tableErrors.push({ table: table.table, message: errorMessage(error) });
      continue;
    }
    // Pas na een gelukte tabel: van een mislukte tabel horen ook de bestanden er niet in.
    for (const key of tableFiles) if (!fileOwners.has(key)) fileOwners.set(key, table.table);
    if (keep) kept.set(table.table, keep);
    summary.tables += 1;
    summary.rows += state.rows;
    const report: { tabel: string; bestand: string; rijen: number; lijst?: string } = { tabel: table.table, bestand: `data/${table.table}.jsonl`, rijen: state.rows };
    if (table.list && state.columns) {
      const header = buildCsvLines([state.columns.map(csvHeaderLabel)]);
      const body = csvChunks.filter(Boolean).join('\r\n');
      await zip.add(`lijsten/${table.list}.csv`, `﻿${header}${body ? `\r\n${body}` : ''}\r\n`, { compress: true });
      report.lijst = `lijsten/${table.list}.csv`;
    }
    tableReport.push(report);
  }
  onProgress?.({ phase: 'tabellen', done: tables.length, total: tables.length });

  // 2. Bestanden
  const fileReport: Array<{ sleutel: string; pad: string; bytes: number; sha256: string; tabel: string }> = [];
  let skippedFiles = 0;
  const wanted = [...fileOwners.entries()]
    .map(([key, table]) => ({ key, table, path: zipPathForKey(key, organizationId) }))
    .filter(file => {
      if (file.path) return true;
      skippedFiles += 1;
      return false;
    }) as Array<{ key: string; table: string; path: string }>;
  for (let i = 0; i < wanted.length; i += concurrency) {
    checkAbort(signal);
    onProgress?.({ phase: 'bestanden', done: i, total: wanted.length });
    const batch = await Promise.all(wanted.slice(i, i + concurrency).map(async file => {
      try {
        return { ...file, blob: await source.fetchFile(file.key), error: null as string | null };
      } catch (error) {
        return { ...file, blob: null, error: errorMessage(error) };
      }
    }));
    for (const file of batch) {
      if (!file.blob) {
        summary.missingFiles.push({ key: file.key, message: file.error ?? 'Het bestand staat niet (meer) in de opslag.' });
        continue;
      }
      // Twee sleutels die op hetzelfde pad uitkomen kan in theorie (document en
      // map delen de map documenten); dan krijgt de tweede de sleutel erbij.
      const path = zip.has(file.path) ? `bestanden/dubbel/${file.key.split('/').slice(1).join('/')}` : file.path;
      let sha256 = '';
      await zip.add(path, file.blob, { inspect: async bytes => { sha256 = await sha256Hex(bytes); } });
      fileReport.push({ sleutel: file.key, pad: path, bytes: file.blob.size, sha256, tabel: file.table });
      summary.files += 1;
      summary.fileBytes += file.blob.size;
    }
  }
  onProgress?.({ phase: 'bestanden', done: wanted.length, total: wanted.length });

  // 3. De boekhouding als auditfile per boekjaar
  checkAbort(signal);
  const periods = auditfilePeriods(kept.get('fiscal_years') ?? [], kept.get('journal_entries') ?? []);
  const auditReport: Array<{ boekjaar: string; bestand: string; van: string; tot: string }> = [];
  if (periods.length && !summary.tableErrors.some(e => XAF_TABLES.has(e.table))) {
    const xafData = {
      companySettings: (kept.get('company_settings') ?? [])[0] ?? null,
      ledgerAccounts: kept.get('ledger_accounts') ?? [],
      vatCodes: kept.get('vat_codes') ?? [],
      journalEntries: kept.get('journal_entries') ?? [],
      journalLines: kept.get('journal_lines') ?? [],
      clients: kept.get('clients') ?? [],
      suppliers: kept.get('suppliers') ?? [],
    } as unknown as AppData;
    for (const [index, period] of periods.entries()) {
      checkAbort(signal);
      onProgress?.({ phase: 'boekhouding', done: index, total: periods.length, label: period.label });
      const path = `boekhouding/auditfile-${period.label.replace(/[^0-9A-Za-z-]+/g, '-')}.xaf`;
      if (zip.has(path)) continue;
      await zip.add(path, buildXaf({ data: xafData, fiscalYearLabel: period.label, startDate: period.start, endDate: period.end }), { compress: true });
      auditReport.push({ boekjaar: period.label, bestand: path, van: period.start, tot: period.end });
      summary.auditfiles.push(path);
    }
  }

  // 4. Manifest en uitleg
  onProgress?.({ phase: 'inpakken', done: 0, total: 1 });
  const omittedColumns = exportTables().flatMap(table => Object.entries(table.omit ?? {}).map(([kolom, reden]) => ({ tabel: table.table, kolom, reden })));
  const manifest = {
    formaat: 'resofly-export',
    formaat_versie: EXPORT_FORMAT_VERSION,
    schema_versie: EXPORT_SCHEMA_VERSION,
    gemaakt_op: now.toISOString(),
    organisatie: { id: organizationId, naam: organizationName },
    gemaakt_door: { id: options.exportedBy.id, email: options.exportedBy.email ?? null },
    uitleg: 'Zie LEESMIJ.txt. Bedragen op _cents in centen, tijden in ISO 8601, id\'s zoals in ResoFly.',
    tabellen: tableReport,
    niet_in_de_export: skippedTables().map(t => ({ tabel: t.table, soort: t.kind, reden: t.reason })),
    weggelaten_kolommen: omittedColumns,
    bestanden: fileReport,
    overgeslagen_bestanden: skippedFiles,
    ontbrekende_bestanden: summary.missingFiles.map(f => ({ sleutel: f.key, melding: f.message })),
    boekhouding: auditReport,
    fouten: summary.tableErrors.map(e => ({ tabel: e.table, melding: e.message })),
  };
  await zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, { compress: true });
  await zip.add('LEESMIJ.txt', readme({ organizationName, now, exportedBy: options.exportedBy.email ?? null, summary }), { compress: true });
  onProgress?.({ phase: 'inpakken', done: 1, total: 1 });

  return { blob: zip.finish(), fileName: exportFileName(organizationName, now), summary };
}

// ── LEESMIJ.txt ──────────────────────────────────────────────────────────────

function readme({ organizationName, now, exportedBy, summary }: { organizationName: string; now: Date; exportedBy: string | null; summary: ExportSummary }): string {
  const lists = exportTables().filter(t => t.list).map(t => t.list).join(', ');
  const byKind = new Map<Exclude<TableKind, 'export'>, Array<{ table: string; reason: string }>>();
  for (const t of skippedTables()) byKind.set(t.kind, [...(byKind.get(t.kind) ?? []), { table: t.table, reason: t.reason }]);
  const skipped = [...byKind.entries()].map(([kind, list]) => {
    const reasons = [...new Set(list.map(t => t.reason))];
    return [
      `${TABLE_KIND_LABEL[kind]}:`,
      ...reasons.map(reason => `  ${reason}`),
      `  Tabellen: ${list.map(t => t.table).join(', ')}.`,
    ].join('\n');
  }).join('\n\n');
  const date = now.toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });
  const problems = [
    summary.missingFiles.length ? `- ${summary.missingFiles.length} bestand(en) stonden niet meer in de opslag. Zie "ontbrekende_bestanden" in manifest.json.` : '',
    summary.tableErrors.length ? `- ${summary.tableErrors.length} tabel(len) konden niet worden gelezen: ${summary.tableErrors.map(e => e.table).join(', ')}. Zie "fouten" in manifest.json.` : '',
  ].filter(Boolean);
  return [
    `Export van ${organizationName} uit ResoFly`,
    `Gemaakt op ${date}${exportedBy ? ` door ${exportedBy}` : ''}.`,
    '',
    'Deze zip bevat alle gegevens van je organisatie in ResoFly, behalve de galerijen.',
    'Je kunt hem openen zonder ResoFly: de gegevens staan in gangbare formaten.',
    '',
    'WAT ER IN STAAT',
    '',
    'data/<tabel>.jsonl',
    '  Alle gegevens, per tabel. Elke regel is één rij als JSON-object, met alle kolommen.',
    '  De id\'s zijn die van ResoFly, dus verwijzingen kloppen: client_id in invoices.jsonl',
    '  wijst naar id in clients.jsonl.',
    '  Bedragen op _cents staan in centen: 12100 is 121,00 euro.',
    '  Tijden staan in ISO 8601 met tijdzone, datums als JJJJ-MM-DD.',
    '',
    'lijsten/<naam>.csv',
    `  De belangrijkste tabellen voor Excel: ${lists}.`,
    '  Scheidingsteken ; en bedragen in euro met een komma (de kolommen op _eur).',
    '',
    'boekhouding/auditfile-<boekjaar>.xaf',
    '  De boekhouding per boekjaar als XML Auditfile Financieel 3.2. Dat is het standaardformaat',
    '  dat accountants en andere boekhoudpakketten inlezen.',
    '',
    'bestanden/',
    '  De originele bestanden: bijlagen, documenten, opnames, inkoopfacturen zoals ze binnenkwamen,',
    '  en de PDF\'s van offertes, facturen, creditnota\'s, contracten en jaarrekeningen zoals ze',
    '  verstuurd of vastgelegd zijn. In manifest.json staat per bestand de opslagsleutel (die staat',
    '  ook in de rij, bijvoorbeeld storage_key of pdf_storage_key), de grootte en een SHA-256.',
    '',
    'manifest.json',
    '  Voor software: het formaat, de schemaversie, het aantal rijen per tabel, de bestanden,',
    '  en wat er bewust niet in zit.',
    '',
    'WAT ER NIET IN ZIT, EN WAAROM',
    '',
    'De export leest met jouw rechten. Wat jij in ResoFly niet kunt zien, zit er dus ook niet in,',
    'zoals de privé-agenda\'s en privégesprekken van collega\'s.',
    '',
    'Kolommen die als sleutel werken, zoals de sleutels van openbare links, zijn weggelaten.',
    'Zie "weggelaten_kolommen" in manifest.json.',
    '',
    skipped,
    '',
    'GALERIJEN',
    '',
    'Galerijen zitten niet in deze export. Download een galerij als zip bij het project.',
    '',
    'CONTROLE',
    '',
    `${summary.tables} tabellen, ${summary.rows} rijen, ${summary.files} bestanden en ${summary.auditfiles.length} auditfile(s).`,
    ...(problems.length ? ['', 'Let op:', ...problems] : []),
    '',
  ].join('\n');
}
