// ============================================================
// query_records — de databron achter de rapportages van Gerrie.
//
// Waarom een eigen bron naast de lees-tools van Gerrie: die tools zijn gemaakt
// om een vraag in de chat te beantwoorden en geven hooguit honderd regels terug.
// Een rapportage "omzet per maand" die daarop rekent, toont bij de 101e factuur
// stil een verkeerd getal. En elke databasevraag levert op staging hooguit
// duizend regels (PostgREST max_rows). Daarom hier:
//  - per vraag tot MAX_SCAN_ROWS regels, opgehaald in pagina's van duizend;
//  - wat er niet meer bij past, wordt gemeld (`truncated`), nooit stil weggelaten;
//  - groeperen en optellen gebeurt hier, in centen, zodat een rapportage exact
//    dezelfde bedragen toont als Financiën (financeTotals);
//  - alleen de velden die hieronder staan gaan naar buiten. Een kolom die later
//    aan een tabel wordt toegevoegd (een token, een sleutel) komt er niet vanzelf bij.
//
// Beveiliging: elke vraag filtert op de organisatie uit de context (de
// service-role slaat RLS over, dus dit is de grens), de module van de bron moet
// leesbaar zijn, en bedragen buiten Financiën (klantwaarde, uurtarief) blijven
// leeg voor wie Financiën niet mag lezen — net als in de API.
//
// Puur op de database na: `db` komt van buiten, zodat reportRecords.test.ts er
// met een nep-database overheen kan.
// ============================================================

import { financeTotals } from './financeTotals.ts';
import { tzOffsetMs } from './schedule.ts';

// deno-lint-ignore no-explicit-any
type Query = any;
export interface RecordsDb { from(table: string): Query }

export interface RecordsCtx {
  db: RecordsDb;
  organizationId: string;
  /** Vandaag in Europe/Amsterdam, YYYY-MM-DD. */
  today: string;
  canRead: (module: string) => boolean;
}

export class RecordsQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'RecordsQueryError'; }
}

export const MAX_SCAN_ROWS = 20_000;
const PAGE_SIZE = 1000;
const MAX_ROWS_OUT = 5000;
const MAX_GROUPS_OUT = 2000;
const MAX_FILL_BUCKETS = 400;
const TZ = 'Europe/Amsterdam';

export type FieldType = 'id' | 'text' | 'number' | 'money' | 'date' | 'boolean' | 'list';
export interface RecordField {
  key: string;
  label: string;
  type: FieldType;
  values?: readonly string[];
  /** Bedrag dat bij Financiën hoort: leeg zonder leesrecht daar. */
  finance?: boolean;
}

type Row = Record<string, unknown>;
type LookupKey = 'clients' | 'projects' | 'suppliers' | 'members' | 'accounts' | 'bankAccounts' | 'invoices';
interface Lookups {
  clients: Map<string, { name: string }>;
  projects: Map<string, { name: string; client_id: string | null; hourly_rate_cents: number | null }>;
  suppliers: Map<string, { name: string }>;
  members: Map<string, { email: string }>;
  accounts: Map<string, { code: string; name: string; type: string; group: string | null }>;
  bankAccounts: Map<string, { name: string }>;
  invoices: Map<string, { number: string; client_id: string | null }>;
}
interface MapCtx { today: string; seeFinance: boolean }

interface DateField { column: string; kind: 'date' | 'timestamp' }
interface SourceSpec {
  key: string;
  label: string;
  module: string;
  table: string;
  /** Uitleg voor Gerrie: wat de bron is en hoe je er goed mee rekent. */
  about: string;
  select: string;
  /** Datumvelden waarop from/to werkt; de eerste is de standaard. */
  dateFields: Record<string, DateField>;
  /** Velden die 1-op-1 een kolom zijn: eq/in gaat dan al in de databasevraag mee. */
  sqlColumns?: Record<string, string>;
  /** Vaste voorwaarde op elke vraag. */
  base?: (query: Query) => Query;
  lookups: LookupKey[];
  fields: RecordField[];
  map: (row: Row, lk: Lookups, ctx: MapCtx) => Row;
}

// ── Kleine helpers ──────────────────────────────────────────────────────────

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' ? null : s;
}
function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function money(value: number): number { return Math.round(value * 100) / 100; }
function cents(value: unknown): number { return money(num(value) / 100); }
/** De kalenderdag in Nederland van een tijdstip; een datum blijft een datum. */
export function amsterdamDay(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const at = new Date(s);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString('en-CA', { timeZone: TZ });
}
/** Het UTC-moment waarop deze Nederlandse kalenderdag begint. */
export function amsterdamDayStartIso(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(guess - tzOffsetMs(TZ, new Date(guess))).toISOString();
}
export function addDays(ymd: string, days: number): string {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)) + days);
  return new Date(t).toISOString().slice(0, 10);
}
function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}
export function isYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
const OPEN_INVOICE = new Set(['sent', 'overdue']);
/** Bedragen van een factuur of offerte: het vastgelegde totaal als het er is, anders uit de regels. */
function documentAmounts(row: Row): { subtotal: number; vat: number; total: number } {
  const stored = num(row.total_amount);
  if (stored > 0) return { subtotal: money(num(row.subtotal_amount)), vat: money(num(row.vat_amount)), total: money(stored) };
  const t = financeTotals(Array.isArray(row.lines) ? row.lines as Row[] : []);
  return { subtotal: t.subtotal, vat: t.vat, total: t.total };
}
function nameOf(map: Map<string, { name: string }>, id: unknown): string | null {
  const key = str(id);
  return key ? map.get(key)?.name ?? null : null;
}

// ── De bronnen ──────────────────────────────────────────────────────────────

const ID = (key: string, label: string): RecordField => ({ key, label, type: 'id' });
const INVOICE_STATUSES = ['draft', 'sent', 'overdue', 'paid', 'cancelled', 'void', 'written_off', 'refunded'] as const;
const QUOTE_STATUSES = ['draft', 'pending_internal_approval', 'internally_approved', 'sent', 'accepted', 'rejected', 'expired', 'paid', 'overdue', 'cancelled'] as const;

const SOURCES: SourceSpec[] = [
  {
    key: 'invoices', label: 'Facturen', module: 'finance', table: 'invoices',
    about: 'Verkoopfacturen. Omzet = som van subtotal_eur (excl. btw) van facturen met status sent, overdue of paid; concepten (draft) en geannuleerde/vervallen facturen tellen niet mee. Trek uitgegeven creditnota\'s (bron credit_notes) daar vanaf. Openstaand = is_open (verstuurd, nog niet betaald).',
    select: 'id, number, status, date, due_date, client_id, project_id, lines, subtotal_amount, vat_amount, total_amount, sent_at, paid_at, refunded_amount',
    dateFields: { date: { column: 'date', kind: 'date' }, due_date: { column: 'due_date', kind: 'date' }, paid_date: { column: 'paid_at', kind: 'timestamp' }, sent_date: { column: 'sent_at', kind: 'timestamp' } },
    sqlColumns: { status: 'status', client_id: 'client_id', project_id: 'project_id', number: 'number' },
    lookups: ['clients', 'projects'],
    fields: [
      ID('id', 'Id'), { key: 'number', label: 'Factuurnummer', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', values: INVOICE_STATUSES },
      { key: 'date', label: 'Factuurdatum', type: 'date' }, { key: 'due_date', label: 'Vervaldatum', type: 'date' },
      { key: 'sent_date', label: 'Verstuurd op', type: 'date' }, { key: 'paid_date', label: 'Betaald op', type: 'date' },
      ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      ID('project_id', 'Project-id'), { key: 'project_name', label: 'Project', type: 'text' },
      { key: 'subtotal_eur', label: 'Bedrag excl. btw', type: 'money' }, { key: 'vat_eur', label: 'Btw', type: 'money' },
      { key: 'total_eur', label: 'Bedrag incl. btw', type: 'money' }, { key: 'refunded_eur', label: 'Terugbetaald', type: 'money' },
      { key: 'is_sent', label: 'Verstuurd', type: 'boolean' }, { key: 'is_open', label: 'Openstaand', type: 'boolean' },
      { key: 'is_overdue', label: 'Te laat', type: 'boolean' }, { key: 'days_overdue', label: 'Dagen te laat', type: 'number' },
      { key: 'days_to_pay', label: 'Betaaltermijn in dagen', type: 'number' },
    ],
    map: (r, lk, ctx) => {
      const amounts = documentAmounts(r);
      const date = str(r.date);
      const due = str(r.due_date);
      const paid = amsterdamDay(r.paid_at);
      const open = OPEN_INVOICE.has(String(r.status));
      const overdue = open && !!due && due < ctx.today;
      const project = str(r.project_id) ? lk.projects.get(String(r.project_id)) : undefined;
      return {
        id: r.id, number: str(r.number), status: str(r.status), date, due_date: due,
        sent_date: amsterdamDay(r.sent_at), paid_date: paid,
        client_id: str(r.client_id), client_name: nameOf(lk.clients, r.client_id),
        project_id: str(r.project_id), project_name: project?.name ?? null,
        subtotal_eur: amounts.subtotal, vat_eur: amounts.vat, total_eur: amounts.total,
        refunded_eur: money(num(r.refunded_amount)),
        is_sent: Boolean(r.sent_at), is_open: open, is_overdue: overdue,
        days_overdue: overdue && due ? daysBetween(due, ctx.today) : 0,
        days_to_pay: paid && date ? Math.max(0, daysBetween(date, paid)) : null,
      };
    },
  },
  {
    key: 'credit_notes', label: 'Creditnota\'s', module: 'finance', table: 'credit_notes',
    about: 'Creditfacturen bij verkoopfacturen. Bedragen staan POSITIEF; ze verminderen de omzet. Alleen status issued telt (draft is nog niet uitgegeven, void is vervallen).',
    select: 'id, number, invoice_id, date, status, reason, subtotal_amount, vat_amount, total_amount',
    dateFields: { date: { column: 'date', kind: 'date' } },
    sqlColumns: { status: 'status', invoice_id: 'invoice_id' },
    lookups: ['invoices', 'clients'],
    fields: [
      ID('id', 'Id'), { key: 'number', label: 'Nummer', type: 'text' }, ID('invoice_id', 'Factuur-id'),
      { key: 'invoice_number', label: 'Factuurnummer', type: 'text' }, ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      { key: 'date', label: 'Datum', type: 'date' }, { key: 'status', label: 'Status', type: 'text', values: ['draft', 'issued', 'void'] },
      { key: 'reason', label: 'Reden', type: 'text' },
      { key: 'subtotal_eur', label: 'Bedrag excl. btw', type: 'money' }, { key: 'vat_eur', label: 'Btw', type: 'money' }, { key: 'total_eur', label: 'Bedrag incl. btw', type: 'money' },
    ],
    map: (r, lk) => {
      const invoice = str(r.invoice_id) ? lk.invoices.get(String(r.invoice_id)) : undefined;
      return {
        id: r.id, number: str(r.number), invoice_id: str(r.invoice_id), invoice_number: invoice?.number ?? null,
        client_id: invoice?.client_id ?? null, client_name: nameOf(lk.clients, invoice?.client_id),
        date: str(r.date), status: str(r.status), reason: str(r.reason),
        subtotal_eur: money(num(r.subtotal_amount)), vat_eur: money(num(r.vat_amount)), total_eur: money(num(r.total_amount)),
      };
    },
  },
  {
    key: 'quotes', label: 'Offertes', module: 'finance', table: 'quotes',
    about: 'Offertes. Conversie = aantal accepted gedeeld door het aantal dat een beslissing kreeg (accepted + rejected + expired). Bedragen komen uit de offerteregels.',
    select: 'id, number, status, date, valid_until, client_id, project_id, lines, sent_at, accepted_at, client_decision_at',
    dateFields: { date: { column: 'date', kind: 'date' }, valid_until: { column: 'valid_until', kind: 'date' }, sent_date: { column: 'sent_at', kind: 'timestamp' }, accepted_date: { column: 'accepted_at', kind: 'timestamp' } },
    sqlColumns: { status: 'status', client_id: 'client_id', project_id: 'project_id' },
    lookups: ['clients', 'projects'],
    fields: [
      ID('id', 'Id'), { key: 'number', label: 'Offertenummer', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', values: QUOTE_STATUSES },
      { key: 'date', label: 'Offertedatum', type: 'date' }, { key: 'valid_until', label: 'Geldig tot', type: 'date' },
      { key: 'sent_date', label: 'Verstuurd op', type: 'date' }, { key: 'accepted_date', label: 'Geaccepteerd op', type: 'date' },
      { key: 'decision_date', label: 'Beslist op', type: 'date' },
      ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      ID('project_id', 'Project-id'), { key: 'project_name', label: 'Project', type: 'text' },
      { key: 'subtotal_eur', label: 'Bedrag excl. btw', type: 'money' }, { key: 'vat_eur', label: 'Btw', type: 'money' }, { key: 'total_eur', label: 'Bedrag incl. btw', type: 'money' },
      { key: 'is_sent', label: 'Verstuurd', type: 'boolean' }, { key: 'is_expired', label: 'Verlopen', type: 'boolean' },
    ],
    map: (r, lk, ctx) => {
      const t = financeTotals(Array.isArray(r.lines) ? r.lines as Row[] : []);
      const validUntil = str(r.valid_until);
      const waiting = ['sent', 'internally_approved', 'pending_internal_approval', 'draft'].includes(String(r.status));
      return {
        id: r.id, number: str(r.number), status: str(r.status), date: str(r.date), valid_until: validUntil,
        sent_date: amsterdamDay(r.sent_at), accepted_date: amsterdamDay(r.accepted_at), decision_date: amsterdamDay(r.client_decision_at),
        client_id: str(r.client_id), client_name: nameOf(lk.clients, r.client_id),
        project_id: str(r.project_id), project_name: str(r.project_id) ? lk.projects.get(String(r.project_id))?.name ?? null : null,
        subtotal_eur: t.subtotal, vat_eur: t.vat, total_eur: t.total,
        is_sent: Boolean(r.sent_at),
        is_expired: String(r.status) === 'expired' || (waiting && !!validUntil && validUntil < ctx.today),
      };
    },
  },
  {
    key: 'purchase_invoices', label: 'Inkoopfacturen', module: 'finance', table: 'purchase_invoices',
    about: 'Inkoopfacturen (kosten). Kosten = som van subtotal_eur (excl. btw) van status booked of paid; concepten en geannuleerde tellen niet mee.',
    select: 'id, supplier_id, supplier_invoice_number, internal_number, date, due_date, paid_at, status, payment_status, subtotal_cents, vat_cents, total_cents, project_id',
    dateFields: { date: { column: 'date', kind: 'date' }, due_date: { column: 'due_date', kind: 'date' }, paid_date: { column: 'paid_at', kind: 'timestamp' } },
    sqlColumns: { status: 'status', payment_status: 'payment_status', supplier_id: 'supplier_id', project_id: 'project_id' },
    lookups: ['suppliers', 'projects'],
    fields: [
      ID('id', 'Id'), ID('supplier_id', 'Leverancier-id'), { key: 'supplier_name', label: 'Leverancier', type: 'text' },
      { key: 'supplier_invoice_number', label: 'Factuurnummer leverancier', type: 'text' }, { key: 'internal_number', label: 'Eigen nummer', type: 'text' },
      { key: 'date', label: 'Factuurdatum', type: 'date' }, { key: 'due_date', label: 'Vervaldatum', type: 'date' }, { key: 'paid_date', label: 'Betaald op', type: 'date' },
      { key: 'status', label: 'Status', type: 'text', values: ['draft', 'booked', 'paid', 'cancelled'] },
      { key: 'payment_status', label: 'Betaalstatus', type: 'text', values: ['unpaid', 'partially_paid', 'paid'] },
      { key: 'subtotal_eur', label: 'Bedrag excl. btw', type: 'money' }, { key: 'vat_eur', label: 'Btw', type: 'money' }, { key: 'total_eur', label: 'Bedrag incl. btw', type: 'money' },
      ID('project_id', 'Project-id'), { key: 'project_name', label: 'Project', type: 'text' },
      { key: 'is_overdue', label: 'Te laat betaald', type: 'boolean' },
    ],
    map: (r, lk, ctx) => {
      const due = str(r.due_date);
      const unpaid = String(r.payment_status) !== 'paid' && !['cancelled', 'draft'].includes(String(r.status));
      return {
        id: r.id, supplier_id: str(r.supplier_id), supplier_name: nameOf(lk.suppliers, r.supplier_id),
        supplier_invoice_number: str(r.supplier_invoice_number), internal_number: str(r.internal_number),
        date: str(r.date), due_date: due, paid_date: amsterdamDay(r.paid_at),
        status: str(r.status), payment_status: str(r.payment_status),
        subtotal_eur: cents(r.subtotal_cents), vat_eur: cents(r.vat_cents), total_eur: cents(r.total_cents),
        project_id: str(r.project_id), project_name: str(r.project_id) ? lk.projects.get(String(r.project_id))?.name ?? null : null,
        is_overdue: unpaid && !!due && due < ctx.today,
      };
    },
  },
  {
    key: 'clients', label: 'Klanten', module: 'clients', table: 'clients',
    about: 'Klanten en prospects. value_eur (geschatte klantwaarde) is leeg zonder leesrecht op Financiën.',
    select: 'id, name, client_code, status, client_kind, city, country, tags, follow_up, value_eur, created_at',
    dateFields: { created_date: { column: 'created_at', kind: 'timestamp' }, follow_up: { column: 'follow_up', kind: 'date' } },
    sqlColumns: { status: 'status', client_kind: 'client_kind', id: 'id' },
    lookups: [],
    fields: [
      ID('id', 'Id'), { key: 'name', label: 'Naam', type: 'text' }, { key: 'client_code', label: 'Klantnummer', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', values: ['active', 'prospect', 'inactive'] },
      { key: 'client_kind', label: 'Soort', type: 'text', values: ['business', 'consumer'] },
      { key: 'city', label: 'Plaats', type: 'text' }, { key: 'country', label: 'Land', type: 'text' }, { key: 'tags', label: 'Labels', type: 'list' },
      { key: 'created_date', label: 'Aangemaakt op', type: 'date' }, { key: 'follow_up', label: 'Opvolgen op', type: 'date' },
      { key: 'value_eur', label: 'Klantwaarde', type: 'money', finance: true },
    ],
    map: (r, _lk, ctx) => ({
      id: r.id, name: str(r.name), client_code: str(r.client_code), status: str(r.status), client_kind: str(r.client_kind),
      city: str(r.city), country: str(r.country), tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      created_date: amsterdamDay(r.created_at), follow_up: str(r.follow_up),
      value_eur: ctx.seeFinance ? money(num(r.value_eur)) : null,
    }),
  },
  {
    key: 'projects', label: 'Projecten', module: 'projects', table: 'projects',
    about: 'Projecten. budgeted_hours is het urenbudget; zet het naast bron time_entries (hours per project_id) voor budgetbewaking. hourly_rate_eur is leeg zonder leesrecht op Financiën.',
    select: 'id, name, client_id, archived, start_date, end_date, billing_type, budgeted_minutes, hourly_rate_cents, created_at',
    dateFields: { created_date: { column: 'created_at', kind: 'timestamp' }, start_date: { column: 'start_date', kind: 'date' }, end_date: { column: 'end_date', kind: 'date' } },
    sqlColumns: { id: 'id', client_id: 'client_id', archived: 'archived', billing_type: 'billing_type' },
    lookups: ['clients'],
    fields: [
      ID('id', 'Id'), { key: 'name', label: 'Project', type: 'text' }, ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      { key: 'archived', label: 'Gearchiveerd', type: 'boolean' }, { key: 'start_date', label: 'Start', type: 'date' }, { key: 'end_date', label: 'Einde', type: 'date' },
      { key: 'billing_type', label: 'Facturering', type: 'text', values: ['hourly', 'fixed_price'] },
      { key: 'budgeted_hours', label: 'Urenbudget', type: 'number' }, { key: 'hourly_rate_eur', label: 'Uurtarief', type: 'money', finance: true },
      { key: 'created_date', label: 'Aangemaakt op', type: 'date' },
    ],
    map: (r, lk, ctx) => ({
      id: r.id, name: str(r.name), client_id: str(r.client_id), client_name: nameOf(lk.clients, r.client_id),
      archived: Boolean(r.archived), start_date: str(r.start_date), end_date: str(r.end_date), billing_type: str(r.billing_type),
      budgeted_hours: r.budgeted_minutes == null ? null : Math.round((num(r.budgeted_minutes) / 60) * 100) / 100,
      hourly_rate_eur: ctx.seeFinance && r.hourly_rate_cents != null ? cents(r.hourly_rate_cents) : null,
      created_date: amsterdamDay(r.created_at),
    }),
  },
  {
    key: 'tasks', label: 'Taken', module: 'projects', table: 'tasks',
    about: 'Taken binnen projecten. Klaar = status done. estimated_hours is de schatting.',
    select: 'id, title, project_id, client_id, status, priority, tags, planned_date, start_date, end_date, estimated_minutes, subtasks, created_at, updated_at',
    dateFields: { created_date: { column: 'created_at', kind: 'timestamp' }, planned_date: { column: 'planned_date', kind: 'date' }, end_date: { column: 'end_date', kind: 'date' }, updated_date: { column: 'updated_at', kind: 'timestamp' } },
    sqlColumns: { status: 'status', priority: 'priority', project_id: 'project_id' },
    lookups: ['projects', 'clients'],
    fields: [
      ID('id', 'Id'), { key: 'title', label: 'Taak', type: 'text' }, ID('project_id', 'Project-id'), { key: 'project_name', label: 'Project', type: 'text' },
      ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', values: ['todo', 'doing', 'review', 'done'] },
      { key: 'priority', label: 'Prioriteit', type: 'text', values: ['low', 'med', 'high'] }, { key: 'tags', label: 'Labels', type: 'list' },
      { key: 'planned_date', label: 'Gepland op', type: 'date' }, { key: 'start_date', label: 'Start', type: 'date' }, { key: 'end_date', label: 'Deadline', type: 'date' },
      { key: 'estimated_hours', label: 'Geschatte uren', type: 'number' }, { key: 'is_done', label: 'Klaar', type: 'boolean' },
      { key: 'is_late', label: 'Over de deadline', type: 'boolean' },
      { key: 'subtasks_total', label: 'Subtaken', type: 'number' }, { key: 'subtasks_done', label: 'Subtaken klaar', type: 'number' },
      { key: 'created_date', label: 'Aangemaakt op', type: 'date' }, { key: 'updated_date', label: 'Laatst gewijzigd', type: 'date' },
    ],
    map: (r, lk, ctx) => {
      const project = str(r.project_id) ? lk.projects.get(String(r.project_id)) : undefined;
      const clientId = str(r.client_id) ?? project?.client_id ?? null;
      const subtasks = Array.isArray(r.subtasks) ? r.subtasks as Row[] : [];
      const done = String(r.status) === 'done';
      const end = str(r.end_date);
      return {
        id: r.id, title: str(r.title), project_id: str(r.project_id), project_name: project?.name ?? null,
        client_id: clientId, client_name: nameOf(lk.clients, clientId),
        status: str(r.status), priority: str(r.priority), tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
        planned_date: str(r.planned_date), start_date: str(r.start_date), end_date: end,
        estimated_hours: r.estimated_minutes == null ? null : Math.round((num(r.estimated_minutes) / 60) * 100) / 100,
        is_done: done, is_late: !done && !!end && end < ctx.today,
        subtasks_total: subtasks.length, subtasks_done: subtasks.filter((s) => Boolean(s?.done)).length,
        created_date: amsterdamDay(r.created_at), updated_date: amsterdamDay(r.updated_at),
      };
    },
  },
  {
    key: 'tickets', label: 'Tickets', module: 'tickets', table: 'tickets',
    about: 'Meldingen en supportvragen. Afgehandeld = status resolved; open = is_open. hours_to_resolve is de doorlooptijd van afgehandelde tickets.',
    select: 'id, title, status, priority, client_id, created_at, resolved_at',
    dateFields: { created_date: { column: 'created_at', kind: 'timestamp' }, resolved_date: { column: 'resolved_at', kind: 'timestamp' } },
    sqlColumns: { status: 'status', priority: 'priority', client_id: 'client_id' },
    lookups: ['clients'],
    fields: [
      ID('id', 'Id'), { key: 'title', label: 'Ticket', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', values: ['new', 'review', 'approved', 'rejected', 'converted', 'resolved'] },
      { key: 'priority', label: 'Prioriteit', type: 'text', values: ['low', 'med', 'high'] },
      ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      { key: 'created_date', label: 'Gemeld op', type: 'date' }, { key: 'resolved_date', label: 'Afgehandeld op', type: 'date' },
      { key: 'is_open', label: 'Open', type: 'boolean' }, { key: 'hours_to_resolve', label: 'Doorlooptijd in uren', type: 'number' },
    ],
    map: (r, lk) => {
      const created = Date.parse(String(r.created_at ?? ''));
      const resolved = Date.parse(String(r.resolved_at ?? ''));
      return {
        id: r.id, title: str(r.title), status: str(r.status), priority: str(r.priority),
        client_id: str(r.client_id), client_name: nameOf(lk.clients, r.client_id),
        created_date: amsterdamDay(r.created_at), resolved_date: amsterdamDay(r.resolved_at),
        is_open: !['resolved', 'rejected', 'converted'].includes(String(r.status)),
        hours_to_resolve: Number.isFinite(created) && Number.isFinite(resolved) ? Math.round(((resolved - created) / 3_600_000) * 10) / 10 : null,
      };
    },
  },
  {
    key: 'time_entries', label: 'Urenregistraties', module: 'time', table: 'time_entries',
    about: 'Geschreven uren van het hele team. hours = minutes/60. Declarabel = billable. entry_type indirect = niet aan een klant (indirect_category: admin, acquisition, travel, education, other). value_eur (uren × tarief, alleen declarabele uren) is leeg zonder leesrecht op Financiën.',
    select: 'id, entry_date, minutes, billable, entry_type, indirect_category, project_id, client_id, user_id, task_id, description, hourly_rate_cents',
    dateFields: { date: { column: 'entry_date', kind: 'date' } },
    sqlColumns: { project_id: 'project_id', client_id: 'client_id', user_id: 'user_id', billable: 'billable', entry_type: 'entry_type' },
    lookups: ['projects', 'clients', 'members'],
    fields: [
      ID('id', 'Id'), { key: 'date', label: 'Datum', type: 'date' }, { key: 'minutes', label: 'Minuten', type: 'number' }, { key: 'hours', label: 'Uren', type: 'number' },
      { key: 'billable', label: 'Declarabel', type: 'boolean' }, { key: 'entry_type', label: 'Soort', type: 'text', values: ['direct', 'indirect'] },
      { key: 'indirect_category', label: 'Indirecte categorie', type: 'text', values: ['admin', 'acquisition', 'travel', 'education', 'other'] },
      ID('project_id', 'Project-id'), { key: 'project_name', label: 'Project', type: 'text' },
      ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      ID('user_id', 'Teamlid-id'), { key: 'user_email', label: 'Teamlid', type: 'text' }, ID('task_id', 'Taak-id'),
      { key: 'description', label: 'Omschrijving', type: 'text' },
      { key: 'hourly_rate_eur', label: 'Uurtarief', type: 'money', finance: true }, { key: 'value_eur', label: 'Waarde', type: 'money', finance: true },
    ],
    map: (r, lk, ctx) => {
      const project = str(r.project_id) ? lk.projects.get(String(r.project_id)) : undefined;
      const clientId = str(r.client_id) ?? project?.client_id ?? null;
      const minutes = num(r.minutes);
      const rateCents = r.hourly_rate_cents != null ? num(r.hourly_rate_cents) : (project?.hourly_rate_cents ?? null);
      return {
        id: r.id, date: str(r.entry_date), minutes, hours: Math.round((minutes / 60) * 100) / 100,
        billable: Boolean(r.billable), entry_type: str(r.entry_type), indirect_category: str(r.indirect_category),
        project_id: str(r.project_id), project_name: project?.name ?? null,
        client_id: clientId, client_name: nameOf(lk.clients, clientId),
        user_id: str(r.user_id), user_email: str(r.user_id) ? lk.members.get(String(r.user_id))?.email ?? null : null,
        task_id: str(r.task_id), description: str(r.description),
        hourly_rate_eur: ctx.seeFinance && rateCents != null ? cents(rateCents) : null,
        value_eur: ctx.seeFinance && rateCents != null && r.billable ? money((minutes / 60) * (rateCents / 100)) : (ctx.seeFinance ? 0 : null),
      };
    },
  },
  {
    key: 'journal_lines', label: 'Boekingsregels', module: 'finance', table: 'journal_lines',
    about: 'De boekhouding per regel (grootboek). amount_eur = debet min credit. Alleen entry_status posted is definitief; reversed is tegengeboekt. Omzet volgens de boekhouding = -som(amount_eur) op account_type revenue; kosten = som(amount_eur) op account_type expense. Voor een winst-en-verliesrekening of balans is de handeling ledger.profit_and_loss of ledger.balance_sheet vaak handiger.',
    select: 'id, entry_id, account_id, description, debit_cents, credit_cents, vat_code, client_id, supplier_id, project_id, journal_entries!inner(date, status, entry_number, description, source_type)',
    dateFields: { date: { column: 'journal_entries.date', kind: 'date' } },
    sqlColumns: { account_id: 'account_id', client_id: 'client_id', supplier_id: 'supplier_id', project_id: 'project_id', entry_status: 'journal_entries.status' },
    lookups: ['accounts', 'clients', 'suppliers', 'projects'],
    fields: [
      ID('id', 'Id'), ID('entry_id', 'Boeking-id'), { key: 'date', label: 'Boekdatum', type: 'date' },
      { key: 'entry_number', label: 'Boekingsnummer', type: 'text' },
      { key: 'entry_status', label: 'Status boeking', type: 'text', values: ['draft', 'posted', 'reversed'] },
      { key: 'entry_description', label: 'Omschrijving boeking', type: 'text' },
      { key: 'source_type', label: 'Bron', type: 'text', values: ['sales_invoice', 'purchase_invoice', 'asset_depreciation', 'asset_acquisition', 'asset_disposal', 'vat_return', 'payment', 'opening_balance', 'manual', 'year_close', 'credit_note'] },
      ID('account_id', 'Rekening-id'), { key: 'account_code', label: 'Rekeningnummer', type: 'text' }, { key: 'account_name', label: 'Grootboekrekening', type: 'text' },
      { key: 'account_type', label: 'Soort rekening', type: 'text', values: ['asset', 'liability', 'equity', 'revenue', 'expense'] },
      { key: 'account_group', label: 'Rapportagegroep', type: 'text' },
      { key: 'debit_eur', label: 'Debet', type: 'money' }, { key: 'credit_eur', label: 'Credit', type: 'money' }, { key: 'amount_eur', label: 'Saldo (debet − credit)', type: 'money' },
      { key: 'vat_code', label: 'Btw-code', type: 'text' }, { key: 'line_description', label: 'Omschrijving regel', type: 'text' },
      ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      ID('supplier_id', 'Leverancier-id'), { key: 'supplier_name', label: 'Leverancier', type: 'text' },
      ID('project_id', 'Project-id'), { key: 'project_name', label: 'Project', type: 'text' },
    ],
    map: (r, lk) => {
      const entry = (r.journal_entries ?? {}) as Row;
      const account = str(r.account_id) ? lk.accounts.get(String(r.account_id)) : undefined;
      const debit = cents(r.debit_cents);
      const credit = cents(r.credit_cents);
      return {
        id: r.id, entry_id: str(r.entry_id), date: str(entry.date), entry_number: str(entry.entry_number),
        entry_status: str(entry.status), entry_description: str(entry.description), source_type: str(entry.source_type),
        account_id: str(r.account_id), account_code: account?.code ?? null, account_name: account?.name ?? null,
        account_type: account?.type ?? null, account_group: account?.group ?? null,
        debit_eur: debit, credit_eur: credit, amount_eur: money(debit - credit),
        vat_code: str(r.vat_code), line_description: str(r.description),
        client_id: str(r.client_id), client_name: nameOf(lk.clients, r.client_id),
        supplier_id: str(r.supplier_id), supplier_name: nameOf(lk.suppliers, r.supplier_id),
        project_id: str(r.project_id), project_name: str(r.project_id) ? lk.projects.get(String(r.project_id))?.name ?? null : null,
      };
    },
  },
  {
    key: 'bank_transactions', label: 'Banktransacties', module: 'finance', table: 'bank_transactions',
    about: 'Bij- en afschrijvingen op de bankrekeningen. amount_eur is positief bij geld binnen en negatief bij geld eruit. Samengevoegde dubbele regels zijn al weggelaten. is_booked = verwerkt in de boekhouding.',
    select: 'id, booking_date, amount_cents, counterparty_name, description, status, journal_entry_id, bank_account_id, is_manual',
    dateFields: { date: { column: 'booking_date', kind: 'date' } },
    sqlColumns: { status: 'status', bank_account_id: 'bank_account_id' },
    base: (q) => q.is('merged_into_id', null),
    lookups: ['bankAccounts'],
    fields: [
      ID('id', 'Id'), { key: 'date', label: 'Boekdatum', type: 'date' }, { key: 'amount_eur', label: 'Bedrag', type: 'money' },
      { key: 'direction', label: 'Richting', type: 'text', values: ['in', 'uit'] },
      { key: 'counterparty_name', label: 'Tegenpartij', type: 'text' }, { key: 'description', label: 'Omschrijving', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', values: ['unmatched', 'suggested', 'booked', 'ignored'] },
      { key: 'is_booked', label: 'Verwerkt', type: 'boolean' }, ID('bank_account_id', 'Rekening-id'), { key: 'bank_account_name', label: 'Bankrekening', type: 'text' },
      { key: 'is_manual', label: 'Handmatig ingevoerd', type: 'boolean' },
    ],
    map: (r, lk) => {
      const amount = cents(r.amount_cents);
      return {
        id: r.id, date: str(r.booking_date), amount_eur: amount, direction: amount >= 0 ? 'in' : 'uit',
        counterparty_name: str(r.counterparty_name), description: str(r.description), status: str(r.status),
        is_booked: Boolean(r.journal_entry_id) || String(r.status) === 'booked',
        bank_account_id: str(r.bank_account_id), bank_account_name: nameOf(lk.bankAccounts, r.bank_account_id),
        is_manual: Boolean(r.is_manual),
      };
    },
  },
  {
    key: 'contracts', label: 'Contracten', module: 'finance', table: 'contracts',
    about: 'Contracten met klanten. Getekend = status signed.',
    select: 'id, number, title, client_id, date, valid_until, status, amount_cents, sent_at, signed_at',
    dateFields: { date: { column: 'date', kind: 'date' }, valid_until: { column: 'valid_until', kind: 'date' }, signed_date: { column: 'signed_at', kind: 'timestamp' } },
    sqlColumns: { status: 'status', client_id: 'client_id' },
    lookups: ['clients'],
    fields: [
      ID('id', 'Id'), { key: 'number', label: 'Nummer', type: 'text' }, { key: 'title', label: 'Titel', type: 'text' },
      ID('client_id', 'Klant-id'), { key: 'client_name', label: 'Klant', type: 'text' },
      { key: 'date', label: 'Datum', type: 'date' }, { key: 'valid_until', label: 'Geldig tot', type: 'date' },
      { key: 'status', label: 'Status', type: 'text', values: ['draft', 'pending_internal_approval', 'internally_approved', 'sent', 'signed', 'declined', 'expired', 'voided'] },
      { key: 'amount_eur', label: 'Bedrag', type: 'money' }, { key: 'sent_date', label: 'Verstuurd op', type: 'date' }, { key: 'signed_date', label: 'Getekend op', type: 'date' },
    ],
    map: (r, lk) => ({
      id: r.id, number: str(r.number), title: str(r.title), client_id: str(r.client_id), client_name: nameOf(lk.clients, r.client_id),
      date: str(r.date), valid_until: str(r.valid_until), status: str(r.status),
      amount_eur: r.amount_cents == null ? null : cents(r.amount_cents),
      sent_date: amsterdamDay(r.sent_at), signed_date: amsterdamDay(r.signed_at),
    }),
  },
  {
    key: 'suppliers', label: 'Leveranciers', module: 'finance', table: 'suppliers',
    about: 'Leveranciers. Combineer met purchase_invoices (supplier_id) voor kosten per leverancier.',
    select: 'id, name, supplier_code, status, city, country, created_at',
    dateFields: { created_date: { column: 'created_at', kind: 'timestamp' } },
    sqlColumns: { status: 'status', id: 'id' },
    lookups: [],
    fields: [
      ID('id', 'Id'), { key: 'name', label: 'Naam', type: 'text' }, { key: 'supplier_code', label: 'Leveranciersnummer', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', values: ['active', 'inactive'] }, { key: 'city', label: 'Plaats', type: 'text' },
      { key: 'country', label: 'Land', type: 'text' }, { key: 'created_date', label: 'Aangemaakt op', type: 'date' },
    ],
    map: (r) => ({
      id: r.id, name: str(r.name), supplier_code: str(r.supplier_code), status: str(r.status),
      city: str(r.city), country: str(r.country), created_date: amsterdamDay(r.created_at),
    }),
  },
];

const BY_KEY = new Map(SOURCES.map((s) => [s.key, s]));
export const RECORD_SOURCE_KEYS = SOURCES.map((s) => s.key);

/** Welke bronnen deze gebruiker kan lezen, met hun velden: voor de tooluitleg van Gerrie. */
export function describeRecordSources(canRead: (module: string) => boolean): string {
  return SOURCES.filter((s) => canRead(s.module)).map((s) => {
    const dates = Object.keys(s.dateFields).join(', ');
    const fields = s.fields.map((f) => {
      const values = f.values ? `[${f.values.join('|')}]` : '';
      return `${f.key}:${f.type}${values}`;
    }).join(', ');
    return `• ${s.key} — ${s.label}. ${s.about}\n  periodevelden: ${dates}\n  velden: ${fields}`;
  }).join('\n');
}

// ── De vraag ────────────────────────────────────────────────────────────────

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type Agg = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';
type FilterOp = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_null' | 'not_null';
interface Filter { field: string; op: FilterOp; value: unknown }
interface Dimension { field: string; period: Period | null; as: string }
interface Measure { field: string | null; agg: Agg; as: string }
interface SortKey { field: string; desc: boolean }
export interface RecordsQuery {
  source: string;
  dateField: string | null;
  from: string | null;
  to: string | null;
  filters: Filter[];
  groupBy: Dimension[];
  measures: Measure[];
  fields: string[] | null;
  sort: SortKey[];
  limit: number;
  fillPeriods: boolean;
}

const PERIODS: Period[] = ['day', 'week', 'month', 'quarter', 'year'];
const AGGS: Agg[] = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'];
const OPS: FilterOp[] = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'not_null'];
const OUTPUT_KEY = /^[a-z][a-z0-9_]{0,39}$/;

function fieldOf(source: SourceSpec, key: string): RecordField {
  const field = source.fields.find((f) => f.key === key);
  if (!field) {
    throw new RecordsQueryError(`Het veld "${key}" bestaat niet in bron ${source.key}. Kies uit: ${source.fields.map((f) => f.key).join(', ')}.`);
  }
  return field;
}

/** Controleert de vraag en maakt hem netjes; elke fout is een zin waar Gerrie mee verder kan. */
export function parseRecordsQuery(raw: unknown): RecordsQuery {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Row : {};
  const sourceKey = String(input.source ?? '').trim();
  const source = BY_KEY.get(sourceKey);
  if (!source) throw new RecordsQueryError(`Onbekende bron "${sourceKey}". Kies uit: ${RECORD_SOURCE_KEYS.join(', ')}.`);

  const from = input.from == null || input.from === '' ? null : String(input.from);
  const to = input.to == null || input.to === '' ? null : String(input.to);
  if (from !== null && !isYmd(from)) throw new RecordsQueryError(`"from" moet een datum zijn als JJJJ-MM-DD, niet "${from}".`);
  if (to !== null && !isYmd(to)) throw new RecordsQueryError(`"to" moet een datum zijn als JJJJ-MM-DD, niet "${to}".`);
  if (from && to && from > to) throw new RecordsQueryError(`"from" (${from}) ligt na "to" (${to}).`);
  let dateField: string | null = null;
  if (input.date_field != null && input.date_field !== '') {
    dateField = String(input.date_field);
    if (!source.dateFields[dateField]) {
      throw new RecordsQueryError(`"${dateField}" is geen periodeveld van ${source.key}. Kies uit: ${Object.keys(source.dateFields).join(', ')}.`);
    }
  } else if (from || to) {
    dateField = Object.keys(source.dateFields)[0];
  }

  const filters: Filter[] = [];
  const rawFilters = Array.isArray(input.filters) ? input.filters : [];
  if (rawFilters.length > 12) throw new RecordsQueryError('Hoogstens 12 filters per vraag.');
  for (const f of rawFilters as Row[]) {
    const field = fieldOf(source, String(f?.field ?? ''));
    const op = String(f?.op ?? 'eq') as FilterOp;
    if (!OPS.includes(op)) throw new RecordsQueryError(`Onbekende filteroperatie "${op}". Kies uit: ${OPS.join(', ')}.`);
    let value = f?.value;
    if ((op === 'in' || op === 'not_in') && !Array.isArray(value)) value = value == null ? [] : [value];
    if (Array.isArray(value) && value.length > 200) throw new RecordsQueryError('Een filterlijst mag hoogstens 200 waarden hebben.');
    if (field.values && (op === 'eq' || op === 'neq' || op === 'in' || op === 'not_in')) {
      const list = Array.isArray(value) ? value : [value];
      const wrong = list.map(String).filter((v) => !field.values!.includes(v));
      if (wrong.length) throw new RecordsQueryError(`Ongeldige waarde ${wrong.map((w) => `"${w}"`).join(', ')} voor ${source.key}.${field.key}. Kies uit: ${field.values.join(', ')}.`);
    }
    filters.push({ field: field.key, op, value });
  }

  const groupBy: Dimension[] = [];
  const rawGroups = Array.isArray(input.group_by) ? input.group_by : input.group_by ? [input.group_by] : [];
  if (rawGroups.length > 2) throw new RecordsQueryError('Groepeer op hoogstens twee velden.');
  for (const g of rawGroups as unknown[]) {
    const spec = typeof g === 'string' ? { field: g } : (g ?? {}) as Row;
    const field = fieldOf(source, String(spec.field ?? ''));
    let period: Period | null = null;
    if (spec.period != null && spec.period !== '') {
      period = String(spec.period) as Period;
      if (!PERIODS.includes(period)) throw new RecordsQueryError(`Onbekende periode "${spec.period}". Kies uit: ${PERIODS.join(', ')}.`);
      if (field.type !== 'date') throw new RecordsQueryError(`Per periode groeperen kan alleen op een datumveld; ${field.key} is geen datum.`);
    } else if (field.type === 'date') {
      period = 'day';
    }
    if (field.type === 'list' || field.type === 'money' || field.type === 'number') {
      throw new RecordsQueryError(`Groeperen op ${field.key} (${field.type}) kan niet; kies een tekst-, id-, ja/nee- of datumveld.`);
    }
    const as = spec.as ? String(spec.as) : (period && period !== 'day' ? `${field.key}_${period}` : field.key);
    if (!OUTPUT_KEY.test(as)) throw new RecordsQueryError(`"${as}" is geen geldige naam (kleine letters, cijfers en _).`);
    groupBy.push({ field: field.key, period, as });
  }

  const measures: Measure[] = [];
  const rawMeasures = Array.isArray(input.measures) ? input.measures : [];
  if (rawMeasures.length > 8) throw new RecordsQueryError('Hoogstens 8 meetwaarden per vraag.');
  for (const m of rawMeasures as Row[]) {
    const agg = String(m?.agg ?? '') as Agg;
    if (!AGGS.includes(agg)) throw new RecordsQueryError(`Onbekende berekening "${m?.agg}". Kies uit: ${AGGS.join(', ')}.`);
    let fieldKey: string | null = m?.field == null || m.field === '' ? null : String(m.field);
    if (agg === 'count' && fieldKey === '*') fieldKey = null;
    if (agg !== 'count' && !fieldKey) throw new RecordsQueryError(`Bij "${agg}" hoort een veld.`);
    if (fieldKey) {
      const field = fieldOf(source, fieldKey);
      if ((agg === 'sum' || agg === 'avg') && field.type !== 'money' && field.type !== 'number') {
        throw new RecordsQueryError(`"${agg}" kan alleen over een getal of bedrag; ${field.key} is ${field.type}.`);
      }
      if ((agg === 'min' || agg === 'max') && !['money', 'number', 'date'].includes(field.type)) {
        throw new RecordsQueryError(`"${agg}" kan over een getal, bedrag of datum; ${field.key} is ${field.type}.`);
      }
    }
    const as = m?.as ? String(m.as) : (fieldKey ? `${agg}_${fieldKey}` : 'count');
    if (!OUTPUT_KEY.test(as)) throw new RecordsQueryError(`"${as}" is geen geldige naam (kleine letters, cijfers en _).`);
    measures.push({ field: fieldKey, agg, as });
  }
  if (groupBy.length > 0 && measures.length === 0) measures.push({ field: null, agg: 'count', as: 'count' });
  const outKeys = [...groupBy.map((g) => g.as), ...measures.map((m) => m.as)];
  if (new Set(outKeys).size !== outKeys.length) throw new RecordsQueryError('Twee uitkomsten hebben dezelfde naam; geef ze een eigen "as".');

  let fields: string[] | null = null;
  if (Array.isArray(input.fields) && input.fields.length > 0) {
    fields = (input.fields as unknown[]).map((k) => fieldOf(source, String(k)).key);
  }

  const sort: SortKey[] = [];
  const rawSort = Array.isArray(input.sort) ? input.sort : input.sort ? [input.sort] : [];
  for (const s of rawSort as unknown[]) {
    const spec = typeof s === 'string' ? { field: s.replace(/^-/, ''), dir: s.startsWith('-') ? 'desc' : 'asc' } : (s ?? {}) as Row;
    const key = String(spec.field ?? '');
    const known = groupBy.length || measures.length ? outKeys.includes(key) : source.fields.some((f) => f.key === key);
    if (!known) throw new RecordsQueryError(`Sorteren op "${key}" kan niet; kies een veld uit de uitkomst.`);
    sort.push({ field: key, desc: String(spec.dir ?? 'asc').toLowerCase() === 'desc' });
  }

  const grouped = groupBy.length > 0 || measures.length > 0;
  const maxLimit = grouped ? MAX_GROUPS_OUT : MAX_ROWS_OUT;
  const rawLimit = Math.floor(num(input.limit));
  const limit = Math.max(1, Math.min(maxLimit, rawLimit || (grouped ? 500 : 200)));

  return {
    source: source.key, dateField, from, to, filters, groupBy, measures, fields, sort, limit,
    fillPeriods: Boolean(input.fill_periods),
  };
}

// ── Uitvoeren ───────────────────────────────────────────────────────────────

/** Alle rijen van één vraag, in pagina's van duizend, tot `cap`. */
async function fetchAll(make: () => Query, cap: number): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let offset = 0; offset <= cap; offset += PAGE_SIZE) {
    const end = Math.min(offset + PAGE_SIZE, cap + 1) - 1;
    const { data, error } = await make().range(offset, end);
    if (error) throw new Error(error.message ?? String(error));
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < end - offset + 1) break;
  }
  if (rows.length > cap) return { rows: rows.slice(0, cap), truncated: true };
  return { rows, truncated: false };
}

async function loadLookups(ctx: RecordsCtx, keys: LookupKey[]): Promise<Lookups> {
  const lk: Lookups = {
    clients: new Map(), projects: new Map(), suppliers: new Map(), members: new Map(),
    accounts: new Map(), bankAccounts: new Map(), invoices: new Map(),
  };
  const org = ctx.organizationId;
  const list = async (table: string, columns: string) =>
    (await fetchAll(() => ctx.db.from(table).select(columns).eq('organization_id', org).order('id', { ascending: true }), MAX_SCAN_ROWS)).rows;
  const tasks: Array<Promise<void>> = [];
  const want = new Set(keys);
  if (want.has('clients')) tasks.push(list('clients', 'id, name').then((rows) => { for (const r of rows) lk.clients.set(String(r.id), { name: String(r.name ?? '') }); }));
  if (want.has('projects')) tasks.push(list('projects', 'id, name, client_id, hourly_rate_cents').then((rows) => {
    for (const r of rows) lk.projects.set(String(r.id), { name: String(r.name ?? ''), client_id: str(r.client_id), hourly_rate_cents: numOrNull(r.hourly_rate_cents) });
  }));
  if (want.has('suppliers')) tasks.push(list('suppliers', 'id, name').then((rows) => { for (const r of rows) lk.suppliers.set(String(r.id), { name: String(r.name ?? '') }); }));
  if (want.has('members')) tasks.push(
    (async () => {
      const { rows } = await fetchAll(() => ctx.db.from('organization_members').select('user_id, email').eq('organization_id', org).order('user_id', { ascending: true }), MAX_SCAN_ROWS);
      for (const r of rows) if (r.user_id) lk.members.set(String(r.user_id), { email: String(r.email ?? '') });
    })(),
  );
  if (want.has('accounts')) tasks.push(list('ledger_accounts', 'id, code, name, type, report_group').then((rows) => {
    for (const r of rows) lk.accounts.set(String(r.id), { code: String(r.code ?? ''), name: String(r.name ?? ''), type: String(r.type ?? ''), group: str(r.report_group) });
  }));
  if (want.has('bankAccounts')) tasks.push(list('bank_accounts', 'id, name').then((rows) => { for (const r of rows) lk.bankAccounts.set(String(r.id), { name: String(r.name ?? '') }); }));
  if (want.has('invoices')) tasks.push(list('invoices', 'id, number, client_id').then((rows) => {
    for (const r of rows) lk.invoices.set(String(r.id), { number: String(r.number ?? ''), client_id: str(r.client_id) });
  }));
  await Promise.all(tasks);
  return lk;
}

function matches(value: unknown, filter: Filter): boolean {
  const { op } = filter;
  if (op === 'is_null') return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (op === 'not_null') return !(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0));
  if (op === 'contains') {
    const needle = String(filter.value ?? '').toLowerCase();
    if (Array.isArray(value)) return value.some((v) => String(v).toLowerCase() === needle);
    return String(value ?? '').toLowerCase().includes(needle);
  }
  const list = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (op === 'in') return list.some((v) => same(value, v));
  if (op === 'not_in') return !list.some((v) => same(value, v));
  if (op === 'eq') return same(value, filter.value);
  if (op === 'neq') return !same(value, filter.value);
  if (value === null || value === undefined) return false;
  const a = typeof value === 'number' ? value : String(value);
  const b = typeof value === 'number' ? num(filter.value) : String(filter.value ?? '');
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b;
}
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  if (typeof a === 'number') return a === num(b);
  return String(a ?? '') === String(b ?? '');
}

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function isoWeek(ymd: string): { year: number; week: number } {
  const d = new Date(`${ymd}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7) };
}
/** Sleutel (sorteerbaar) en label (leesbaar) van de periode waar een datum in valt. */
export function periodBucket(ymd: string, period: Period): { key: string; label: string } {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  switch (period) {
    case 'year': return { key: `${y}`, label: `${y}` };
    case 'quarter': { const q = Math.floor((m - 1) / 3) + 1; return { key: `${y}-Q${q}`, label: `Q${q} ${y}` }; }
    case 'month': return { key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTHS[m - 1]} ${y}` };
    case 'week': { const w = isoWeek(ymd); return { key: `${w.year}-W${String(w.week).padStart(2, '0')}`, label: `wk ${w.week} ${w.year}` }; }
    default: return { key: ymd, label: `${d} ${MONTHS[m - 1]} ${y}` };
  }
}
/** De eerste dag van de periode na deze; voor het opvullen van lege maanden. */
function nextPeriodStart(ymd: string, period: Period): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  switch (period) {
    case 'year': return `${y + 1}-01-01`;
    case 'quarter': { const qStart = Math.floor((m - 1) / 3) * 3 + 1; const next = new Date(Date.UTC(y, qStart - 1 + 3, 1)); return next.toISOString().slice(0, 10); }
    case 'month': return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    case 'week': return addDays(ymd, 7);
    default: return addDays(ymd, 1);
  }
}
function periodStart(ymd: string, period: Period): string {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  switch (period) {
    case 'year': return `${y}-01-01`;
    case 'quarter': return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
    case 'month': return `${ymd.slice(0, 7)}-01`;
    case 'week': { const day = new Date(`${ymd}T00:00:00Z`).getUTCDay() || 7; return addDays(ymd, 1 - day); }
    default: return ymd;
  }
}

interface Accumulator { count: number; values: number[]; distinct: Set<string>; sumCents: number; min: unknown; max: unknown }
function newAcc(): Accumulator { return { count: 0, values: [], distinct: new Set(), sumCents: 0, min: null, max: null }; }
function feed(acc: Accumulator, measure: Measure, record: Row, type: FieldType | null): void {
  if (measure.agg === 'count') {
    if (!measure.field || !(record[measure.field] === null || record[measure.field] === undefined)) acc.count += 1;
    return;
  }
  const value = record[measure.field!];
  if (value === null || value === undefined || value === '') return;
  if (measure.agg === 'count_distinct') { acc.distinct.add(String(value)); return; }
  if (type === 'date') {
    if (acc.min === null || String(value) < String(acc.min)) acc.min = value;
    if (acc.max === null || String(value) > String(acc.max)) acc.max = value;
    acc.count += 1;
    return;
  }
  const n = num(value);
  acc.count += 1;
  acc.values.push(n);
  if (type === 'money') acc.sumCents += Math.round(n * 100);
  if (acc.min === null || n < (acc.min as number)) acc.min = n;
  if (acc.max === null || n > (acc.max as number)) acc.max = n;
}
function result(acc: Accumulator, measure: Measure, type: FieldType | null): number | string | null {
  switch (measure.agg) {
    case 'count': return acc.count;
    case 'count_distinct': return acc.distinct.size;
    case 'sum': return type === 'money' ? acc.sumCents / 100 : Math.round(acc.values.reduce((s, v) => s + v, 0) * 10000) / 10000;
    case 'avg': {
      if (acc.count === 0) return null;
      const total = type === 'money' ? acc.sumCents / 100 : acc.values.reduce((s, v) => s + v, 0);
      return Math.round((total / acc.count) * 100) / 100;
    }
    case 'min': return acc.min as number | string | null;
    case 'max': return acc.max as number | string | null;
  }
}

export interface RecordsResult {
  source: string;
  label: string;
  period: { field: string; from: string | null; to: string | null } | null;
  /** Regels die aan de filters voldoen. */
  matched: number;
  /** Er waren meer dan MAX_SCAN_ROWS regels; alleen de eerste zijn meegeteld. */
  truncated: boolean;
  note?: string;
  fields: Array<{ key: string; label: string; type: FieldType }>;
  rows?: Row[];
  groups?: Row[];
  totals?: Row;
  /** Er waren meer groepen of regels dan `limit`; de rest is weggelaten (zie de sortering). */
  limited?: boolean;
}

export async function runRecordsQuery(ctx: RecordsCtx, raw: unknown): Promise<RecordsResult> {
  const q = parseRecordsQuery(raw);
  const source = BY_KEY.get(q.source)!;
  if (!ctx.canRead(source.module)) {
    throw new RecordsQueryError(`Je hebt geen toegang tot de gegevens van ${source.label.toLowerCase()} (module ${source.module}).`);
  }
  const seeFinance = ctx.canRead('finance');
  const pushdown = (query: Query): Query => {
    let next = query;
    if (q.dateField) {
      const df = source.dateFields[q.dateField];
      if (df.kind === 'date') {
        if (q.from) next = next.gte(df.column, q.from);
        if (q.to) next = next.lte(df.column, q.to);
      } else {
        if (q.from) next = next.gte(df.column, amsterdamDayStartIso(q.from));
        if (q.to) next = next.lt(df.column, amsterdamDayStartIso(addDays(q.to, 1)));
      }
    }
    for (const f of q.filters) {
      const column = source.sqlColumns?.[f.field];
      if (!column) continue;
      if (f.op === 'eq' && f.value !== null && f.value !== undefined) next = next.eq(column, f.value);
      else if (f.op === 'in' && Array.isArray(f.value) && f.value.length > 0 && f.value.every((v) => v !== null && v !== undefined)) next = next.in(column, f.value);
    }
    return next;
  };
  const make = () => {
    let query = ctx.db.from(source.table).select(source.select).eq('organization_id', ctx.organizationId);
    if (source.base) query = source.base(query);
    return pushdown(query).order('id', { ascending: true });
  };
  const [{ rows: rawRows, truncated }, lookups] = await Promise.all([
    fetchAll(make, MAX_SCAN_ROWS),
    loadLookups(ctx, source.lookups),
  ]);

  const mapCtx: MapCtx = { today: ctx.today, seeFinance };
  let records = rawRows.map((r) => source.map(r, lookups, mapCtx));
  for (const f of q.filters) records = records.filter((r) => matches(r[f.field], f));

  const typeOf = (key: string): FieldType | null => source.fields.find((f) => f.key === key)?.type ?? null;
  const out: RecordsResult = {
    source: source.key,
    label: source.label,
    period: q.dateField ? { field: q.dateField, from: q.from, to: q.to } : null,
    matched: records.length,
    truncated,
    fields: [],
  };
  if (truncated) out.note = `Er zijn meer dan ${MAX_SCAN_ROWS.toLocaleString('nl-NL')} regels; alleen de eerste ${MAX_SCAN_ROWS.toLocaleString('nl-NL')} zijn meegeteld. Kies een kortere periode of een strenger filter.`;
  const hidden = source.fields.filter((f) => f.finance && !seeFinance).map((f) => f.key);
  if (hidden.length) out.note = [out.note, `Zonder leesrecht op Financiën blijven ${hidden.join(', ')} leeg.`].filter(Boolean).join(' ');

  if (q.groupBy.length === 0 && q.measures.length === 0) {
    const keys = q.fields ?? source.fields.map((f) => f.key);
    out.fields = keys.map((k) => { const f = source.fields.find((x) => x.key === k)!; return { key: f.key, label: f.label, type: f.type }; });
    const sorted = sortRows(records, q.sort.length ? q.sort : defaultRowSort(source));
    out.rows = sorted.slice(0, q.limit).map((r) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null])));
    if (sorted.length > q.limit) out.limited = true;
    return out;
  }

  // Groeperen en rekenen.
  const groups = new Map<string, { dims: Row; accs: Accumulator[] }>();
  const totals = q.measures.map(() => newAcc());
  for (const record of records) {
    const dims: Row = {};
    const parts: string[] = [];
    for (const d of q.groupBy) {
      const value = record[d.field];
      if (d.period) {
        const day = typeof value === 'string' && isYmd(value) ? value : null;
        if (!day) { dims[d.as] = null; dims[`${d.as}_label`] = 'Onbekend'; parts.push('~'); continue; }
        const bucket = periodBucket(day, d.period);
        dims[d.as] = bucket.key;
        dims[`${d.as}_label`] = bucket.label;
        parts.push(bucket.key);
      } else {
        const v = value === undefined || value === '' ? null : value;
        dims[d.as] = v;
        parts.push(JSON.stringify(v));
      }
    }
    const key = parts.join('|');
    let group = groups.get(key);
    if (!group) { group = { dims, accs: q.measures.map(() => newAcc()) }; groups.set(key, group); }
    q.measures.forEach((m, i) => {
      const type = m.field ? typeOf(m.field) : null;
      feed(group!.accs[i], m, record, type);
      feed(totals[i], m, record, type);
    });
  }

  let rows: Row[] = [...groups.values()].map((g) => {
    const row: Row = { ...g.dims };
    q.measures.forEach((m, i) => { row[m.as] = result(g.accs[i], m, m.field ? typeOf(m.field) : null); });
    return row;
  });

  // Lege perioden opvullen, zodat een lijn of staafdiagram geen maanden overslaat.
  const periodDim = q.groupBy.length === 1 && q.groupBy[0].period ? q.groupBy[0] : null;
  if (q.fillPeriods && periodDim) {
    const known = new Set(rows.map((r) => String(r[periodDim.as])));
    const keys = rows.map((r) => r[periodDim.as]).filter((k): k is string => typeof k === 'string').sort();
    const first = q.from ?? (keys.length ? firstDayOfKey(keys[0], periodDim.period!) : null);
    const last = q.to ?? (keys.length ? firstDayOfKey(keys[keys.length - 1], periodDim.period!) : null);
    if (first && last) {
      let cursor = periodStart(first, periodDim.period!);
      for (let i = 0; i < MAX_FILL_BUCKETS && cursor <= last; i += 1) {
        const bucket = periodBucket(cursor, periodDim.period!);
        if (!known.has(bucket.key)) {
          const empty: Row = { [periodDim.as]: bucket.key, [`${periodDim.as}_label`]: bucket.label };
          for (const m of q.measures) empty[m.as] = m.agg === 'count' || m.agg === 'count_distinct' || m.agg === 'sum' ? 0 : null;
          rows.push(empty);
          known.add(bucket.key);
        }
        cursor = nextPeriodStart(cursor, periodDim.period!);
      }
    }
  }

  const sortKeys = q.sort.length
    ? q.sort
    : q.groupBy.some((d) => d.period)
      ? q.groupBy.map((d) => ({ field: d.as, desc: false }))
      : [{ field: q.measures[0].as, desc: true }];
  rows = sortRows(rows, sortKeys);
  out.fields = [
    ...q.groupBy.flatMap((d) => {
      const f = source.fields.find((x) => x.key === d.field)!;
      return d.period
        ? [{ key: d.as, label: `${f.label} (${d.period})`, type: 'text' as FieldType }, { key: `${d.as}_label`, label: f.label, type: 'text' as FieldType }]
        : [{ key: d.as, label: f.label, type: f.type }];
    }),
    ...q.measures.map((m) => {
      const f = m.field ? source.fields.find((x) => x.key === m.field) : null;
      const type: FieldType = m.agg === 'count' || m.agg === 'count_distinct' ? 'number' : (f?.type ?? 'number');
      return { key: m.as, label: `${m.agg}${f ? ` ${f.label}` : ''}`, type };
    }),
  ];
  out.groups = rows.slice(0, q.limit);
  if (rows.length > q.limit) out.limited = true;
  const totalRow: Row = {};
  q.measures.forEach((m, i) => { totalRow[m.as] = result(totals[i], m, m.field ? typeOf(m.field) : null); });
  out.totals = totalRow;
  return out;
}

function firstDayOfKey(key: string, period: Period): string {
  if (period === 'year') return `${key}-01-01`;
  if (period === 'quarter') { const [y, q] = key.split('-Q'); return `${y}-${String((Number(q) - 1) * 3 + 1).padStart(2, '0')}-01`; }
  if (period === 'month') return `${key}-01`;
  if (period === 'week') {
    const [y, w] = key.split('-W').map(Number);
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const day = jan4.getUTCDay() || 7;
    return addDays(jan4.toISOString().slice(0, 10), 1 - day + (w - 1) * 7);
  }
  return key;
}

function defaultRowSort(source: SourceSpec): SortKey[] {
  const first = Object.keys(source.dateFields)[0];
  return first && source.fields.some((f) => f.key === first) ? [{ field: first, desc: true }] : [];
}

function sortRows(rows: Row[], keys: SortKey[]): Row[] {
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const x = a[k.field];
      const y = b[k.field];
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'nl');
      if (cmp !== 0) return k.desc ? -cmp : cmp;
    }
    return 0;
  });
}
