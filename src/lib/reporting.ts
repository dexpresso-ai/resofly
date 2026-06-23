// ───────────────────────────────────────────────────────────────────────────
// Rapportbouwer — kern (fase 1).
//
// Eén generieke aggregatie-engine over de client-side AppData. Alle bron-kennis
// zit in het veldregister (REPORT_SOURCES); de engine zelf weet niets van
// specifieke entiteiten. Een rapport is een pure JSON-`ReportDefinition`, dus
// opslaanbaar en deelbaar (fase 2).
//
// Bedragen worden overal genormaliseerd naar euro's en cent-exact berekend via
// de centrale geldmodule (`total`), identiek aan Financiën/Dashboard.
// ───────────────────────────────────────────────────────────────────────────
import type { AppData } from '../types';
import { euro, total } from './format';

export type ReportSourceKey =
  | 'invoices' | 'quotes' | 'purchase_invoices' | 'clients' | 'projects' | 'tasks' | 'tickets';

export type Aggregation = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type DateGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type ChartType = 'table' | 'bar' | 'line' | 'pie' | 'kpi';
export type FieldType = 'string' | 'number' | 'money' | 'date' | 'enum';
export type DateRangePreset = 'all' | 'this_month' | 'last_month' | 'this_quarter' | 'this_year' | 'last_12m';

export interface Lookups {
  clientName: (id: string | null | undefined) => string;
  projectName: (id: string | null | undefined) => string;
  supplierName: (id: string | null | undefined) => string;
}

export interface ReportField<T = unknown> {
  key: string;
  label: string;
  type: FieldType;
  role: 'dimension' | 'measure';
  enumValues?: { value: string; label: string }[];
  get: (row: T, lk: Lookups) => unknown;
}

export interface ReportSourceDef<T = unknown> {
  key: ReportSourceKey;
  label: string;
  rows: (data: AppData) => T[];
  /** Veld (uit `fields`) waarop het periodefilter rekent. */
  dateField: string;
  fields: ReportField<T>[];
  defaultMeasure: ReportMeasure;
  defaultDimension: string | null;
}

export interface ReportMeasure { field: string; agg: Aggregation; }
export interface ReportFilter { field: string; value: string; }

export interface ReportDefinition {
  source: ReportSourceKey;
  measure: ReportMeasure;
  /** Veldsleutel om op te groeperen, of `null` voor één totaal (KPI). */
  dimension: string | null;
  /** Alleen relevant wanneer de dimensie een datumveld is. */
  granularity: DateGranularity;
  filters: ReportFilter[];
  datePreset: DateRangePreset;
  chart: ChartType;
}

export interface ReportRow { key: string; label: string; value: number; }
export interface ReportResult {
  rows: ReportRow[];
  measureLabel: string;
  measureType: FieldType;
  dimensionLabel: string | null;
  /** De meetwaarde over álle gefilterde rijen (los van de groepering). */
  total: number;
  groupCount: number;
  rowCount: number;
}

// ── Datum-helpers ───────────────────────────────────────────────────────────
const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  // Postgres DATE (YYYY-MM-DD) als lokale kalenderdatum behandelen, net als format.ts.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

function bucketOf(d: Date, g: DateGranularity): { key: string; label: string } {
  const y = d.getFullYear();
  const m = d.getMonth();
  switch (g) {
    case 'year': return { key: `${y}`, label: `${y}` };
    case 'quarter': { const q = Math.floor(m / 3) + 1; return { key: `${y}-Q${q}`, label: `Q${q} ${y}` }; }
    case 'week': { const w = isoWeek(d); return { key: `${w.year}-W${pad2(w.week)}`, label: `wk ${w.week} ${w.year}` }; }
    case 'day': return { key: `${y}-${pad2(m + 1)}-${pad2(d.getDate())}`, label: `${d.getDate()} ${MONTHS_SHORT[m]} ${y}` };
    case 'month':
    default: return { key: `${y}-${pad2(m + 1)}`, label: `${MONTHS_SHORT[m]} ${y}` };
  }
}

export function resolveRange(preset: DateRangePreset): { from: Date; to: Date } | null {
  if (preset === 'all') return null;
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = (yy: number, mm: number, dd: number) => new Date(yy, mm, dd, 0, 0, 0, 0);
  const end = (yy: number, mm: number, dd: number) => new Date(yy, mm, dd, 23, 59, 59, 999);
  switch (preset) {
    case 'this_month': return { from: start(y, m, 1), to: end(y, m + 1, 0) };
    case 'last_month': return { from: start(y, m - 1, 1), to: end(y, m, 0) };
    case 'this_quarter': { const q = Math.floor(m / 3); return { from: start(y, q * 3, 1), to: end(y, q * 3 + 3, 0) }; }
    case 'this_year': return { from: start(y, 0, 1), to: end(y, 11, 31) };
    case 'last_12m': return { from: start(y, m - 11, 1), to: end(y, m + 1, 0) };
  }
}

export const DATE_PRESET_LABELS: Record<DateRangePreset, string> = {
  all: 'Alles',
  this_month: 'Deze maand',
  last_month: 'Vorige maand',
  this_quarter: 'Dit kwartaal',
  this_year: 'Dit jaar',
  last_12m: 'Laatste 12 maanden',
};

export const GRANULARITY_LABELS: Record<DateGranularity, string> = {
  day: 'Dag', week: 'Week', month: 'Maand', quarter: 'Kwartaal', year: 'Jaar',
};

// ── Formattering ────────────────────────────────────────────────────────────
export function formatMeasure(value: number, type: FieldType): string {
  if (type === 'money') return euro(value);
  const rounded = Math.round(value * 100) / 100;
  return new Intl.NumberFormat('nl-NL', { maximumFractionDigits: Number.isInteger(rounded) ? 0 : 1 }).format(rounded);
}

function dimLabel(raw: unknown, field: ReportField): string {
  if (raw == null || raw === '') return '—';
  if (field.enumValues) return field.enumValues.find(e => e.value === String(raw))?.label ?? String(raw);
  return String(raw);
}

export function measureLabelOf(measure: ReportMeasure, source: ReportSourceDef): string {
  if (measure.agg === 'count') return 'Aantal';
  const field = source.fields.find(f => f.key === measure.field);
  const name = field?.label ?? measure.field;
  const prefix: Record<Exclude<Aggregation, 'count'>, string> = { sum: 'Som', avg: 'Gemiddelde', min: 'Minimum', max: 'Maximum' };
  return `${prefix[measure.agg]} · ${name}`;
}

function aggregate(agg: Aggregation, values: number[]): number {
  if (agg === 'count') return values.length;
  if (values.length === 0) return 0;
  switch (agg) {
    case 'sum': return values.reduce((s, v) => s + v, 0);
    case 'avg': return values.reduce((s, v) => s + v, 0) / values.length;
    case 'min': return values.reduce((s, v) => Math.min(s, v), Infinity);
    case 'max': return values.reduce((s, v) => Math.max(s, v), -Infinity);
  }
}

function buildLookups(data: AppData): Lookups {
  const clients = new Map(data.clients.map(c => [c.id, c.name]));
  const projects = new Map(data.projects.map(p => [p.id, p.name]));
  const suppliers = new Map(data.suppliers.map(s => [s.id, s.name]));
  return {
    clientName: id => (id ? clients.get(id) ?? 'Onbekende klant' : 'Geen klant'),
    projectName: id => (id ? projects.get(id) ?? 'Onbekend project' : 'Geen project'),
    supplierName: id => (id ? suppliers.get(id) ?? 'Onbekende leverancier' : 'Geen leverancier'),
  };
}

// ── De engine ───────────────────────────────────────────────────────────────
const EMPTY_RESULT: ReportResult = { rows: [], measureLabel: 'Aantal', measureType: 'number', dimensionLabel: null, total: 0, groupCount: 0, rowCount: 0 };

export function runReport(def: ReportDefinition, data: AppData): ReportResult {
  const source = (def && REPORT_SOURCES[def.source]) as ReportSourceDef | undefined;
  // Bescherm tegen een onvolledige/legacy opgeslagen definitie: nooit crashen.
  if (!source || !def.measure) return EMPTY_RESULT;
  const lk = buildLookups(data);
  let rows = source.rows(data);

  // 1 — Periodefilter.
  const range = resolveRange(def.datePreset);
  if (range) {
    const dateField = source.fields.find(f => f.key === source.dateField);
    if (dateField) {
      rows = rows.filter(r => {
        const d = toDate(dateField.get(r, lk));
        return d != null && d >= range.from && d <= range.to;
      });
    }
  }

  // 2 — Enum-filters.
  for (const filter of def.filters ?? []) {
    if (!filter.value) continue;
    const field = source.fields.find(f => f.key === filter.field);
    if (!field) continue;
    rows = rows.filter(r => String(field.get(r, lk) ?? '') === filter.value);
  }

  const measureField = def.measure.agg === 'count' ? null : source.fields.find(f => f.key === def.measure.field) ?? null;
  const measureLabel = measureLabelOf(def.measure, source);
  const measureType: FieldType = def.measure.agg === 'count' ? 'number' : (measureField?.type ?? 'number');
  const readMeasure = (row: unknown): number => {
    if (def.measure.agg === 'count' || !measureField) return 1;
    const v = measureField.get(row, lk);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  const grandTotal = aggregate(def.measure.agg, rows.map(readMeasure));
  const dimField = def.dimension ? source.fields.find(f => f.key === def.dimension) ?? null : null;

  // 3a — Geen dimensie → één totaal (KPI).
  if (!dimField) {
    return {
      rows: [{ key: 'all', label: 'Totaal', value: grandTotal }],
      measureLabel, measureType, dimensionLabel: null, total: grandTotal, groupCount: 1, rowCount: rows.length,
    };
  }

  // 3b — Groeperen + aggregeren.
  const groups = new Map<string, { label: string; values: number[] }>();
  for (const r of rows) {
    let key: string;
    let label: string;
    if (dimField.type === 'date') {
      const d = toDate(dimField.get(r, lk));
      if (!d) { key = '~onbekend'; label = 'Onbekend'; }
      else { const b = bucketOf(d, def.granularity); key = b.key; label = b.label; }
    } else {
      label = dimLabel(dimField.get(r, lk), dimField);
      key = label;
    }
    const g = groups.get(key) ?? { label, values: [] };
    g.values.push(readMeasure(r));
    groups.set(key, g);
  }

  const out: ReportRow[] = [...groups.entries()].map(([key, g]) => ({ key, label: g.label, value: aggregate(def.measure.agg, g.values) }));
  // Datumreeksen chronologisch; categorieën op meetwaarde aflopend (grootste eerst).
  if (dimField.type === 'date') out.sort((a, b) => a.key.localeCompare(b.key));
  else out.sort((a, b) => b.value - a.value);

  return { rows: out, measureLabel, measureType, dimensionLabel: dimField.label, total: grandTotal, groupCount: out.length, rowCount: rows.length };
}

// ── Veldregister ────────────────────────────────────────────────────────────
const ENUMS = {
  invoiceStatus: [
    { value: 'draft', label: 'Concept' }, { value: 'sent', label: 'Verzonden' }, { value: 'overdue', label: 'Te laat' },
    { value: 'paid', label: 'Betaald' }, { value: 'cancelled', label: 'Geannuleerd' }, { value: 'void', label: 'Vervallen' },
    { value: 'written_off', label: 'Afgeboekt' }, { value: 'refunded', label: 'Terugbetaald' },
  ],
  quoteStatus: [
    { value: 'draft', label: 'Concept' }, { value: 'pending_internal_approval', label: 'Wacht op interne goedkeuring' },
    { value: 'internally_approved', label: 'Intern goedgekeurd' }, { value: 'sent', label: 'Verzonden' },
    { value: 'accepted', label: 'Geaccepteerd' }, { value: 'rejected', label: 'Afgewezen' },
    { value: 'expired', label: 'Verlopen' }, { value: 'paid', label: 'Betaald' },
    { value: 'overdue', label: 'Te laat' }, { value: 'cancelled', label: 'Geannuleerd' },
  ],
  purchaseStatus: [
    { value: 'draft', label: 'Concept' }, { value: 'booked', label: 'Geboekt' },
    { value: 'paid', label: 'Betaald' }, { value: 'cancelled', label: 'Geannuleerd' },
  ],
  clientStatus: [
    { value: 'active', label: 'Actief' }, { value: 'prospect', label: 'Prospect' }, { value: 'inactive', label: 'Inactief' },
  ],
  projectState: [
    { value: 'active', label: 'Actief' }, { value: 'archived', label: 'Gearchiveerd' },
  ],
  taskStatus: [
    { value: 'todo', label: 'Te doen' }, { value: 'doing', label: 'Bezig' },
    { value: 'review', label: 'Review' }, { value: 'done', label: 'Klaar' },
  ],
  ticketStatus: [
    { value: 'new', label: 'Nieuw' }, { value: 'review', label: 'In behandeling' },
    { value: 'approved', label: 'Goedgekeurd' }, { value: 'rejected', label: 'Afgewezen' }, { value: 'converted', label: 'Omgezet' },
  ],
  priority: [
    { value: 'high', label: 'Hoog' }, { value: 'med', label: 'Normaal' }, { value: 'low', label: 'Laag' },
  ],
} as const;

function defineSource<T>(def: ReportSourceDef<T>): ReportSourceDef<T> { return def; }

const invoices = defineSource<AppData['invoices'][number]>({
  key: 'invoices', label: 'Facturen', rows: d => d.invoices, dateField: 'date',
  defaultMeasure: { field: 'amount', agg: 'sum' }, defaultDimension: 'client',
  fields: [
    { key: 'client', label: 'Klant', type: 'string', role: 'dimension', get: (r, lk) => lk.clientName(r.client_id) },
    { key: 'status', label: 'Status', type: 'enum', role: 'dimension', enumValues: [...ENUMS.invoiceStatus], get: r => r.status },
    { key: 'date', label: 'Factuurdatum', type: 'date', role: 'dimension', get: r => r.date },
    { key: 'amount', label: 'Bedrag (incl. btw)', type: 'money', role: 'measure', get: r => total(r.lines).total },
  ],
});

const quotes = defineSource<AppData['quotes'][number]>({
  key: 'quotes', label: 'Offertes', rows: d => d.quotes, dateField: 'date',
  defaultMeasure: { field: 'amount', agg: 'sum' }, defaultDimension: 'status',
  fields: [
    { key: 'status', label: 'Status', type: 'enum', role: 'dimension', enumValues: [...ENUMS.quoteStatus], get: r => r.status },
    { key: 'client', label: 'Klant', type: 'string', role: 'dimension', get: (r, lk) => lk.clientName(r.client_id) },
    { key: 'date', label: 'Offertedatum', type: 'date', role: 'dimension', get: r => r.date },
    { key: 'amount', label: 'Bedrag (incl. btw)', type: 'money', role: 'measure', get: r => total(r.lines).total },
  ],
});

const purchaseInvoices = defineSource<AppData['purchaseInvoices'][number]>({
  key: 'purchase_invoices', label: 'Inkoopfacturen', rows: d => d.purchaseInvoices, dateField: 'date',
  defaultMeasure: { field: 'amount', agg: 'sum' }, defaultDimension: 'supplier',
  fields: [
    { key: 'supplier', label: 'Leverancier', type: 'string', role: 'dimension', get: (r, lk) => lk.supplierName(r.supplier_id) },
    { key: 'status', label: 'Status', type: 'enum', role: 'dimension', enumValues: [...ENUMS.purchaseStatus], get: r => r.status },
    { key: 'date', label: 'Datum', type: 'date', role: 'dimension', get: r => r.date },
    { key: 'amount', label: 'Bedrag (incl. btw)', type: 'money', role: 'measure', get: r => r.total_cents / 100 },
  ],
});

const clients = defineSource<AppData['clients'][number]>({
  key: 'clients', label: 'Klanten', rows: d => d.clients, dateField: 'created',
  defaultMeasure: { field: '*', agg: 'count' }, defaultDimension: 'status',
  fields: [
    { key: 'status', label: 'Status', type: 'enum', role: 'dimension', enumValues: [...ENUMS.clientStatus], get: r => r.status },
    { key: 'created', label: 'Aangemaakt', type: 'date', role: 'dimension', get: r => r.created_at },
    { key: 'value', label: 'Klantwaarde', type: 'money', role: 'measure', get: r => r.value_eur },
  ],
});

const projects = defineSource<AppData['projects'][number]>({
  key: 'projects', label: 'Projecten', rows: d => d.projects, dateField: 'created',
  defaultMeasure: { field: '*', agg: 'count' }, defaultDimension: 'client',
  fields: [
    { key: 'client', label: 'Klant', type: 'string', role: 'dimension', get: (r, lk) => lk.clientName(r.client_id) },
    { key: 'state', label: 'Staat', type: 'enum', role: 'dimension', enumValues: [...ENUMS.projectState], get: r => (r.archived ? 'archived' : 'active') },
    { key: 'created', label: 'Aangemaakt', type: 'date', role: 'dimension', get: r => r.created_at },
  ],
});

const tasks = defineSource<AppData['tasks'][number]>({
  key: 'tasks', label: 'Taken', rows: d => d.tasks, dateField: 'created',
  defaultMeasure: { field: '*', agg: 'count' }, defaultDimension: 'status',
  fields: [
    { key: 'status', label: 'Status', type: 'enum', role: 'dimension', enumValues: [...ENUMS.taskStatus], get: r => r.status },
    { key: 'priority', label: 'Prioriteit', type: 'enum', role: 'dimension', enumValues: [...ENUMS.priority], get: r => r.priority },
    { key: 'project', label: 'Project', type: 'string', role: 'dimension', get: (r, lk) => lk.projectName(r.project_id) },
    { key: 'created', label: 'Aangemaakt', type: 'date', role: 'dimension', get: r => r.created_at },
    { key: 'deadline', label: 'Deadline', type: 'date', role: 'dimension', get: r => r.end_date ?? r.planned_date },
    { key: 'minutes', label: 'Geschatte minuten', type: 'number', role: 'measure', get: r => r.estimated_minutes },
  ],
});

const tickets = defineSource<AppData['tickets'][number]>({
  key: 'tickets', label: 'Tickets', rows: d => d.tickets, dateField: 'created',
  defaultMeasure: { field: '*', agg: 'count' }, defaultDimension: 'status',
  fields: [
    { key: 'status', label: 'Status', type: 'enum', role: 'dimension', enumValues: [...ENUMS.ticketStatus], get: r => r.status },
    { key: 'priority', label: 'Prioriteit', type: 'enum', role: 'dimension', enumValues: [...ENUMS.priority], get: r => r.priority },
    { key: 'client', label: 'Klant', type: 'string', role: 'dimension', get: (r, lk) => lk.clientName(r.client_id) },
    { key: 'created', label: 'Aangemaakt', type: 'date', role: 'dimension', get: r => r.created_at },
  ],
});

export const REPORT_SOURCES: Record<ReportSourceKey, ReportSourceDef> = {
  invoices: invoices as ReportSourceDef,
  quotes: quotes as ReportSourceDef,
  purchase_invoices: purchaseInvoices as ReportSourceDef,
  clients: clients as ReportSourceDef,
  projects: projects as ReportSourceDef,
  tasks: tasks as ReportSourceDef,
  tickets: tickets as ReportSourceDef,
};

export const REPORT_SOURCE_ORDER: ReportSourceKey[] = ['invoices', 'quotes', 'purchase_invoices', 'clients', 'projects', 'tasks', 'tickets'];

/** Bouw een verstandige standaarddefinitie voor een gekozen bron. */
export function defaultReportFor(sourceKey: ReportSourceKey): ReportDefinition {
  const source = REPORT_SOURCES[sourceKey];
  const dim = source.defaultDimension ? source.fields.find(f => f.key === source.defaultDimension) : null;
  return {
    source: sourceKey,
    measure: { ...source.defaultMeasure },
    dimension: source.defaultDimension,
    granularity: 'month',
    filters: [],
    datePreset: 'this_year',
    chart: dim && dim.type === 'date' ? 'line' : dim ? 'bar' : 'kpi',
  };
}

/** Meetwaarde-opties voor de bron: altijd "Aantal", plus som/gemiddelde per getalveld. */
export function measureOptions(source: ReportSourceDef): { measure: ReportMeasure; label: string }[] {
  const options: { measure: ReportMeasure; label: string }[] = [{ measure: { field: '*', agg: 'count' }, label: 'Aantal' }];
  for (const f of source.fields) {
    if (f.role !== 'measure') continue;
    options.push({ measure: { field: f.key, agg: 'sum' }, label: `Som · ${f.label}` });
    options.push({ measure: { field: f.key, agg: 'avg' }, label: `Gemiddelde · ${f.label}` });
  }
  return options;
}

export const measureKey = (m: ReportMeasure) => `${m.agg}:${m.field}`;

// ── Sjabloonbibliotheek ─────────────────────────────────────────────────────
// Kant-en-klare startrapporten. De gebruiker laadt er één en past hem desgewenst
// aan; opslaan maakt er een eigen rapport van.
export interface ReportTemplate { name: string; description: string; definition: ReportDefinition; }

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    name: 'Omzet per klant',
    description: 'Som van bedrag van betaalde facturen, per klant — dit jaar.',
    definition: { source: 'invoices', measure: { field: 'amount', agg: 'sum' }, dimension: 'client', granularity: 'month', filters: [{ field: 'status', value: 'paid' }], datePreset: 'this_year', chart: 'bar' },
  },
  {
    name: 'Omzet per maand',
    description: 'Som van bedrag van betaalde facturen per maand — laatste 12 maanden.',
    definition: { source: 'invoices', measure: { field: 'amount', agg: 'sum' }, dimension: 'date', granularity: 'month', filters: [{ field: 'status', value: 'paid' }], datePreset: 'last_12m', chart: 'line' },
  },
  {
    name: 'Facturen per status',
    description: 'Aantal facturen per status — dit jaar.',
    definition: { source: 'invoices', measure: { field: '*', agg: 'count' }, dimension: 'status', granularity: 'month', filters: [], datePreset: 'this_year', chart: 'pie' },
  },
  {
    name: 'Offerteconversie',
    description: 'Aantal offertes per status — dit jaar.',
    definition: { source: 'quotes', measure: { field: '*', agg: 'count' }, dimension: 'status', granularity: 'month', filters: [], datePreset: 'this_year', chart: 'pie' },
  },
  {
    name: 'Kosten per leverancier',
    description: 'Som van bedrag van inkoopfacturen, per leverancier — dit jaar.',
    definition: { source: 'purchase_invoices', measure: { field: 'amount', agg: 'sum' }, dimension: 'supplier', granularity: 'month', filters: [], datePreset: 'this_year', chart: 'bar' },
  },
  {
    name: 'Klanten per status',
    description: 'Aantal klanten per status — alle periodes.',
    definition: { source: 'clients', measure: { field: '*', agg: 'count' }, dimension: 'status', granularity: 'month', filters: [], datePreset: 'all', chart: 'pie' },
  },
  {
    name: 'Taken per status',
    description: 'Aantal taken per status — alle periodes.',
    definition: { source: 'tasks', measure: { field: '*', agg: 'count' }, dimension: 'status', granularity: 'month', filters: [], datePreset: 'all', chart: 'bar' },
  },
  {
    name: 'Ureninschatting per project',
    description: 'Som van geschatte minuten, per project — alle periodes.',
    definition: { source: 'tasks', measure: { field: 'minutes', agg: 'sum' }, dimension: 'project', granularity: 'month', filters: [], datePreset: 'all', chart: 'bar' },
  },
];

/** Diepe kloon van een definitie zodat geladen sjablonen/rapporten los staan van de bron. */
export function cloneDefinition(def: ReportDefinition): ReportDefinition {
  return { ...def, measure: { ...def.measure }, filters: def.filters.map(f => ({ ...f })) };
}
