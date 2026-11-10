// ============================================================
// Datasets van een rapportage: wat een rapportagepagina bij het openen ophaalt.
//
// Een dataset is één aanroep van een lees-endpoint met vaste invoer:
//   { key: 'omzet', label: 'Omzet per maand', tool: 'query_records', input: {…} }
// `tool` is `query_records`, een lees-tool van Gerrie (`list_invoices`, …) of een
// lees-handeling uit de registry (`action:ledger.profit_and_loss`).
//
// Periodes lopen mee: in de invoer mag {{begin_jaar}} of {{maanden_terug:12}}
// staan in plaats van een vaste datum. Anders toont een rapportage "dit jaar"
// in januari nog het vorige jaar, en moet de gebruiker hem met AI-tegoed laten
// herschrijven om hem bij te werken.
//
// Puur: geen database en geen Deno. reportDatasets.test.ts draait er met node
// overheen; gerrieReports.ts voert de datasets uit.
// ============================================================

import { addDays, isYmd } from './reportRecords.ts';

export interface ReportDataset {
  key: string;
  label: string;
  tool: string;
  input: Record<string, unknown>;
}

export const MAX_DATASETS = 12;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_INPUT_JSON = 6000;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Controleert de vorm van de datasetlijst. Of de tools mógen, beslist de uitvoerder. */
export function normalizeDatasets(raw: unknown): Result<ReportDataset[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: '"datasets" moet een lijst zijn.' };
  if (raw.length > MAX_DATASETS) return { ok: false, error: `Hoogstens ${MAX_DATASETS} datasets per rapportage; voeg vragen samen met query_records (group_by).` };
  const seen = new Set<string>();
  const out: ReportDataset[] = [];
  for (const [index, item] of raw.entries()) {
    const d = (item && typeof item === 'object' && !Array.isArray(item)) ? item as Record<string, unknown> : null;
    if (!d) return { ok: false, error: `Dataset ${index + 1} is geen object.` };
    const key = String(d.key ?? '').trim();
    if (!KEY.test(key)) return { ok: false, error: `Dataset ${index + 1}: "key" moet beginnen met een kleine letter en mag alleen kleine letters, cijfers en _ bevatten (kreeg "${key}").` };
    if (seen.has(key)) return { ok: false, error: `De sleutel "${key}" komt twee keer voor.` };
    seen.add(key);
    const label = String(d.label ?? '').trim().slice(0, 120) || key;
    const tool = String(d.tool ?? '').trim();
    if (!tool) return { ok: false, error: `Dataset "${key}": "tool" ontbreekt.` };
    const input = d.input === undefined || d.input === null ? {} : d.input;
    if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: `Dataset "${key}": "input" moet een object zijn.` };
    if (JSON.stringify(input).length > MAX_INPUT_JSON) return { ok: false, error: `Dataset "${key}": de invoer is te groot.` };
    out.push({ key, label, tool, input: input as Record<string, unknown> });
  }
  return { ok: true, value: out };
}

// ── Meelopende datums ───────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(y: number, m: number, d: number): string {
  // Date.UTC normaliseert maand 13 en dag 0 vanzelf.
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}
function parts(today: string): { y: number; m: number; d: number } {
  return { y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)), d: Number(today.slice(8, 10)) };
}

/** De waarde van één token, of null als het token niet bestaat. */
export function placeholderValue(token: string, today: string): string | number | null {
  const [name, rawArg] = token.split(':');
  const arg = rawArg === undefined ? null : Number(rawArg);
  if (rawArg !== undefined && (!Number.isInteger(arg) || (arg as number) < 0 || (arg as number) > 3660)) return null;
  const { y, m } = parts(today);
  const q = Math.floor((m - 1) / 3);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  switch (name) {
    case 'vandaag': return today;
    case 'gisteren': return addDays(today, -1);
    case 'morgen': return addDays(today, 1);
    case 'begin_week': return addDays(today, 1 - weekday);
    case 'eind_week': return addDays(today, 7 - weekday);
    case 'begin_vorige_week': return addDays(today, 1 - weekday - 7);
    case 'eind_vorige_week': return addDays(today, -weekday);
    case 'begin_maand': return ymd(y, m, 1);
    case 'eind_maand': return ymd(y, m + 1, 0);
    case 'begin_vorige_maand': return ymd(y, m - 1, 1);
    case 'eind_vorige_maand': return ymd(y, m, 0);
    case 'begin_kwartaal': return ymd(y, q * 3 + 1, 1);
    case 'eind_kwartaal': return ymd(y, q * 3 + 4, 0);
    case 'begin_vorig_kwartaal': return ymd(y, q * 3 - 2, 1);
    case 'eind_vorig_kwartaal': return ymd(y, q * 3 + 1, 0);
    case 'begin_jaar': return `${y}-01-01`;
    case 'eind_jaar': return `${y}-12-31`;
    case 'begin_vorig_jaar': return `${y - 1}-01-01`;
    case 'eind_vorig_jaar': return `${y - 1}-12-31`;
    case 'zelfde_dag_vorig_jaar': return ymd(y - 1, m, Math.min(parts(today).d, new Date(Date.UTC(y - 1, m, 0)).getUTCDate()));
    case 'dit_jaar': return y;
    case 'vorig_jaar': return y - 1;
    case 'deze_maand': return m;
    case 'dit_kwartaal': return q + 1;
    case 'dagen_terug': return arg === null ? null : addDays(today, -(arg as number));
    case 'dagen_vooruit': return arg === null ? null : addDays(today, arg as number);
    case 'weken_terug': return arg === null ? null : addDays(today, -7 * (arg as number));
    // De eerste dag van de maand, zoveel maanden terug: "laatste 12 maanden" = {{maanden_terug:11}} t/m {{eind_maand}}.
    case 'maanden_terug': return arg === null ? null : ymd(y, m - (arg as number), 1);
    case 'jaren_terug': return arg === null ? null : `${y - (arg as number)}-01-01`;
    default: return null;
  }
}

export const PLACEHOLDER_HELP =
  '{{vandaag}}, {{gisteren}}, {{begin_week}}, {{eind_week}}, {{begin_vorige_week}}, {{eind_vorige_week}}, '
  + '{{begin_maand}}, {{eind_maand}}, {{begin_vorige_maand}}, {{eind_vorige_maand}}, '
  + '{{begin_kwartaal}}, {{eind_kwartaal}}, {{begin_vorig_kwartaal}}, {{eind_vorig_kwartaal}}, '
  + '{{begin_jaar}}, {{eind_jaar}}, {{begin_vorig_jaar}}, {{eind_vorig_jaar}}, {{zelfde_dag_vorig_jaar}}, '
  + '{{dagen_terug:N}}, {{dagen_vooruit:N}}, {{weken_terug:N}}, {{maanden_terug:N}} (eerste dag van die maand), {{jaren_terug:N}} (1 januari), '
  + 'en als getal {{dit_jaar}}, {{vorig_jaar}}, {{deze_maand}}, {{dit_kwartaal}}';

const TOKEN = /\{\{\s*([a-z_]+(?::\d+)?)\s*\}\}/g;

/**
 * Vult de tokens in, overal in de invoer. Staat er alleen een getal-token
 * ("{{dit_jaar}}"), dan wordt de waarde een getal: een `year`-veld verwacht er een.
 * Een onbekend token is een fout; anders zou er stil een letterlijke tekst als datum
 * naar de database gaan.
 */
export function resolvePlaceholders(value: unknown, today: string, unknown: string[] = []): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([a-z_]+(?::\d+)?)\s*\}\}$/);
    if (whole) {
      const v = placeholderValue(whole[1], today);
      if (v === null) { unknown.push(whole[1]); return value; }
      return v;
    }
    return value.replace(TOKEN, (match, token: string) => {
      const v = placeholderValue(token, today);
      if (v === null) { unknown.push(token); return match; }
      return String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, today, unknown));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolvePlaceholders(v, today, unknown)]));
  }
  return value;
}

/** Invoer klaar om te draaien: tokens ingevuld, of een fout die Gerrie kan herstellen. */
export function datasetInput(dataset: ReportDataset, today: string): Result<Record<string, unknown>> {
  const unknown: string[] = [];
  const input = resolvePlaceholders(dataset.input, today, unknown) as Record<string, unknown>;
  if (unknown.length) {
    return { ok: false, error: `Onbekende datum-token(s) in "${dataset.key}": ${[...new Set(unknown)].map((t) => `{{${t}}}`).join(', ')}. Gebruik: ${PLACEHOLDER_HELP}.` };
  }
  return { ok: true, value: input };
}

// ── Resultaten ──────────────────────────────────────────────────────────────

/** De hoofdlijst van een resultaat: de lijst zelf, of de grootste lijst erin (groups, rows, invoices, …). */
export function mainList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;
  let best: unknown[] | null = null;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(v) && (!best || v.length > best.length)) best = v;
  }
  return best;
}

/** Wat de rapportage over één dataset te weten krijgt. */
export interface DatasetResult {
  key: string;
  label: string;
  tool: string;
  ok: boolean;
  data: unknown;
  rows: number | null;
  truncated: boolean;
  error?: string;
}

/**
 * Is dit resultaat afgekapt? query_records zegt het zelf; een lijst-tool zit op
 * zijn plafond als hij precies zoveel regels gaf als hij mocht.
 */
export function isTruncated(data: unknown, rowCap: number): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (d.truncated === true || d.limited === true) return true;
  const list = mainList(data);
  return !!list && list.length >= rowCap;
}

/**
 * Een resultaat zoals het model het te zien krijgt: dezelfde vorm, maar lange
 * lijsten ingekort. Het model hoeft niet elke factuur te lezen om te zien hoe
 * de gegevens eruitzien, en elke regel kost de gebruiker tegoed. Wat er is
 * weggelaten, staat erachter in gewone taal; de rapportage zelf krijgt alles.
 */
export function compactForModel(value: unknown, maxItems = 15, maxString = 300): string {
  const notes: string[] = [];
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}…` : v;
    if (Array.isArray(v)) {
      const kept = v.slice(0, maxItems).map((x, i) => walk(x, `${path}[${i}]`, depth + 1));
      if (v.length > maxItems) notes.push(`${path || 'de lijst'}: ${maxItems} van ${v.length} regels getoond`);
      return kept;
    }
    if (v && typeof v === 'object') {
      if (depth > 6) return '…';
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, path ? `${path}.${k}` : k, depth + 1)]));
    }
    return v;
  };
  const text = JSON.stringify(walk(value, '', 0));
  if (notes.length === 0) return text;
  return `${text}\n\n(Ingekort voor jou: ${notes.slice(0, 8).join('; ')}. De rapportage krijgt bij het openen álle regels; reken dus in de HTML altijd met RF.data, nooit met getallen die je hier ziet.)`;
}

/** Hoe groot een resultaat als JSON is, zonder het twee keer te serialiseren waar dat niet hoeft. */
export function jsonSize(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return Number.POSITIVE_INFINITY; }
}

/**
 * Houdt het totaal van alle datasets onder `maxChars`: is het te groot, dan
 * worden de grootste lijsten ingekort en als afgekapt gemarkeerd. Liever een
 * rapportage met een duidelijke melding dan een pagina die niet laadt.
 */
export function capResults(results: DatasetResult[], maxChars: number): DatasetResult[] {
  let total = results.reduce((sum, r) => sum + jsonSize(r.data), 0);
  if (total <= maxChars) return results;
  const order = [...results].sort((a, b) => jsonSize(b.data) - jsonSize(a.data));
  for (const r of order) {
    if (total <= maxChars) break;
    const list = mainList(r.data);
    if (!list || list.length < 2) continue;
    const before = jsonSize(r.data);
    const share = Math.max(0.05, 1 - (total - maxChars) / before);
    const keep = Math.max(1, Math.floor(list.length * share * 0.9));
    list.splice(keep);
    r.truncated = true;
    r.rows = list.length;
    total = total - before + jsonSize(r.data);
  }
  return results;
}
