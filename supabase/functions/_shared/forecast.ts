// ============================================================
// De PROGNOSE (forecast): wat een organisatie de komende maanden verwacht aan
// nieuwe projecten, omzet, kosten en winst.
//
// Eén bestand voor twee kanten:
//  - de app: src/lib/forecast.ts zet het door naar de pagina Prognose;
//  - Gerrie, de agents, de MCP en de API: actions/forecast.ts.
// Bewust geen twee kopieën met een test ertussen (zoals galleryLayout.ts):
// hier hangt alles van alles af. Een kaart van Gerrie zegt "winst over twaalf
// maanden € 48.000 → € 61.500"; rekende de app daarna € 61.200, dan klopte de
// kaart niet die je goedkeurde. Met één bestand kan dat niet.
//
// Daarom puur: geen imports, geen Deno, geen DOM, alleen ES2020. Deno, de
// browserbundel (Vite) en `npm test` (node) laden het alle drie. Zet hier dus
// nooit een import van een URL, npm: of jsr: in: dan breekt de app.
//
// De cijfers waarop de prognose rust komen uit public.forecast_history
// (migratie 20261118124500). De app en de server roepen dezelfde functie aan.
// ============================================================

// ── Maanden ─────────────────────────────────────────────────────────────────

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MONTH_NAMES = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MONTH_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** 'JJJJ-MM', een echte maand. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && MONTH_RE.test(value);
}

/** De maand van een datum 'JJJJ-MM-DD'. */
export function monthOfDate(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function monthIndex(month: string): number {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  return year * 12 + (mon - 1);
}

function monthFromIndex(index: number): string {
  const year = Math.floor(index / 12);
  const mon = index - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(mon).padStart(2, '0')}`;
}

export function addMonths(month: string, count: number): string {
  return monthFromIndex(monthIndex(month) + count);
}

/** Hoeveel maanden `to` na `from` ligt (negatief als hij ervoor ligt). */
export function monthsBetween(from: string, to: string): number {
  return monthIndex(to) - monthIndex(from);
}

/** "januari 2027", of kort "jan 2027". */
export function monthLabel(month: string, style: 'long' | 'short' = 'long'): string {
  if (!isMonthKey(month)) return month;
  const names = style === 'short' ? MONTH_SHORT : MONTH_NAMES;
  return `${names[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** Alleen de maand: "jan". */
export function monthShortName(month: string): string {
  return isMonthKey(month) ? MONTH_SHORT[Number(month.slice(5, 7)) - 1] : month;
}

// ── Getallen als tekst ──────────────────────────────────────────────────────
// Met de hand en niet met Intl: de kaart van Gerrie (Deno) en het scherm
// (browser) moeten letterlijk dezelfde zin opleveren, en npm test ook.

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** "€ 1.250", "€ 1.250,50", "€ -300". Centen alleen als die er zijn. */
export function euroText(cents: number): string {
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  const body = rest === 0 ? groupThousands(String(euros)) : `${groupThousands(String(euros))},${String(rest).padStart(2, '0')}`;
  return `€ ${rounded < 0 ? '-' : ''}${body}`;
}

/**
 * Hele euro's: "€ 20.181". Een prognose in centen wekt een schijn van
 * precisie, en de kaart van Gerrie en de pagina noemen zo letterlijk hetzelfde
 * bedrag (de kaart zei eerst "€ 20.181,45", de pagina "€ 20.181").
 */
export function wholeEuroText(cents: number): string {
  return euroText(Math.round(cents / 100) * 100);
}

/** Een getal met hooguit `decimals` cijfers achter de komma: "2,4", "3". */
export function numberText(value: number, decimals = 1): string {
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(value * factor) / factor;
  const negative = rounded < 0;
  const [whole, fraction] = Math.abs(rounded).toFixed(decimals).split('.');
  const trimmed = (fraction ?? '').replace(/0+$/, '');
  return `${negative ? '-' : ''}${groupThousands(whole)}${trimmed ? `,${trimmed}` : ''}`;
}

export function pctText(value: number): string {
  return `${numberText(value, 1)}%`;
}

function toCents(euros: number): number {
  return Math.round(euros * 100);
}

// ── De aannames ─────────────────────────────────────────────────────────────

export type ForecastItemKind = 'revenue' | 'cost';

/** Een extra post: een nieuwe medewerker, een investering, een grote opdracht. */
export interface ForecastItem {
  /** Vaste sleutel binnen de prognose ("post-3"); Gerrie wijst er een post mee aan. */
  id: string;
  label: string;
  kind: ForecastItemKind;
  /** Per maand, in euro's exclusief btw. */
  amount: number;
  /** Eerste maand, 'JJJJ-MM'. */
  from: string;
  /** Laatste maand (tot en met), of null: tot het eind van de prognose. */
  to: string | null;
}

/**
 * Wat je verwacht. Een veld dat null is, is AUTOMATISCH: de waarde komt uit
 * de cijfers van de laatste twaalf maanden en schuift elke maand mee.
 */
export interface ForecastAssumptions {
  /** Eerste maand van de prognose, of null: deze maand (schuift mee). */
  start_month: string | null;
  /** Hoeveel maanden vooruit. */
  months: number;
  projects_per_month: number | null;
  /** Groei per jaar in procenten, op projecten en overige omzet. */
  growth_pct: number;
  /** Euro's exclusief btw. */
  revenue_per_project: number | null;
  /** Over zoveel maanden komt de omzet van een project binnen, vanaf de start. */
  project_months: number;
  /** Omzet zonder project per maand (abonnementen, losse verkoop), exclusief btw. */
  other_revenue: number | null;
  /** Kosten per maand, exclusief btw. */
  fixed_costs: number | null;
  /** Stijging van de vaste kosten per jaar, in procenten. */
  cost_increase_pct: number;
  /** Kosten die meegroeien met de omzet, als percentage van de omzet. */
  variable_cost_pct: number;
  /** Per maand ('JJJJ-MM') een eigen aantal nieuwe projecten: vakantie, seizoen. */
  month_projects: Record<string, number>;
  items: ForecastItem[];
}

export const DEFAULT_ASSUMPTIONS: ForecastAssumptions = {
  start_month: null,
  months: 12,
  projects_per_month: null,
  growth_pct: 0,
  revenue_per_project: null,
  project_months: 1,
  other_revenue: null,
  fixed_costs: null,
  cost_increase_pct: 0,
  variable_cost_pct: 0,
  month_projects: {},
  items: [],
};

export type ForecastNumberField =
  | 'months' | 'projects_per_month' | 'growth_pct' | 'revenue_per_project' | 'project_months'
  | 'other_revenue' | 'fixed_costs' | 'cost_increase_pct' | 'variable_cost_pct';

export interface ForecastFieldInfo {
  key: ForecastNumberField;
  label: string;
  unit: 'euro' | 'pct' | 'count' | 'months';
  /** Mag leeg zijn: dan automatisch, uit de cijfers. */
  auto: boolean;
  decimals: number;
  min: number;
  max: number;
  help: string;
}

/** De getallen, met hun grenzen. Het scherm, de kaart van Gerrie en de controle lezen allemaal deze lijst. */
export const FORECAST_FIELDS: readonly ForecastFieldInfo[] = [
  { key: 'projects_per_month', label: 'Nieuwe projecten per maand', unit: 'count', auto: true, decimals: 2, min: 0, max: 1000,
    help: 'Leeg = het gemiddelde van de laatste twaalf maanden.' },
  { key: 'revenue_per_project', label: 'Omzet per project', unit: 'euro', auto: true, decimals: 2, min: 0, max: 10000000,
    help: 'Exclusief btw. Leeg = wat een project het afgelopen jaar gemiddeld opbracht.' },
  { key: 'project_months', label: 'Omzet van een project verdeeld over', unit: 'months', auto: false, decimals: 0, min: 1, max: 24,
    help: 'Zoveel maanden factureer je een project, vanaf de start. 1 = alles in de startmaand.' },
  { key: 'other_revenue', label: 'Overige omzet per maand', unit: 'euro', auto: true, decimals: 2, min: 0, max: 10000000,
    help: 'Omzet zonder project, zoals abonnementen of losse verkoop. Leeg = het gemiddelde van het afgelopen jaar.' },
  { key: 'growth_pct', label: 'Groei per jaar', unit: 'pct', auto: false, decimals: 1, min: -90, max: 300,
    help: 'Meer (of minder) projecten en overige omzet, geleidelijk over het jaar.' },
  { key: 'fixed_costs', label: 'Vaste kosten per maand', unit: 'euro', auto: true, decimals: 2, min: 0, max: 10000000,
    help: 'Exclusief btw. Leeg = je gemiddelde kosten per maand van het afgelopen jaar, alles samen.' },
  { key: 'cost_increase_pct', label: 'Kostenstijging per jaar', unit: 'pct', auto: false, decimals: 1, min: -50, max: 100,
    help: 'Huur, abonnementen en lonen die duurder worden, geleidelijk over het jaar.' },
  { key: 'variable_cost_pct', label: 'Kosten die meegroeien met de omzet', unit: 'pct', auto: false, decimals: 1, min: 0, max: 100,
    help: 'Een deel van elke euro omzet: inkoop, uitbesteed werk, freelancers.' },
  { key: 'months', label: 'Aantal maanden vooruit', unit: 'months', auto: false, decimals: 0, min: 1, max: 36,
    help: 'Hooguit drie jaar.' },
];

const FIELD_BY_KEY = new Map(FORECAST_FIELDS.map((field) => [field.key, field]));

export function forecastField(key: ForecastNumberField): ForecastFieldInfo {
  return FIELD_BY_KEY.get(key) as ForecastFieldInfo;
}

export const MAX_ITEMS = 50;
export const MAX_MONTH_PROJECTS = 60;
export const ITEM_LABEL_MAX = 80;
const ITEM_AMOUNT_MAX = 10000000;
const ITEM_ID_RE = /^[a-z0-9-]{1,40}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Een getal uit wat er binnenkomt: 2, "2", "2,5". Iets anders is null. */
function readNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw.trim().replace(',', '.'));
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function roundTo(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clampField(key: ForecastNumberField, value: number): number {
  const field = forecastField(key);
  return Math.min(field.max, Math.max(field.min, roundTo(value, field.decimals)));
}

function cleanLabel(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, ITEM_LABEL_MAX);
}

function nextItemId(taken: Set<string>): string {
  let n = 1;
  while (taken.has(`post-${n}`)) n += 1;
  return `post-${n}`;
}

/**
 * Herstellen bij het LEZEN: wat er in de database staat, wordt altijd een
 * bruikbare prognose. Onzin valt terug op de standaard, getallen worden
 * afgekapt. Schrijven gaat door applyForecastPatch, die onzin weigert.
 */
export function normalizeAssumptions(raw: unknown): ForecastAssumptions {
  const src = isObject(raw) ? raw : {};
  const out: ForecastAssumptions = { ...DEFAULT_ASSUMPTIONS, month_projects: {}, items: [] };

  out.start_month = isMonthKey(src.start_month) ? src.start_month : null;
  for (const field of FORECAST_FIELDS) {
    const value = readNumber(src[field.key]);
    if (value === null) continue;
    (out as unknown as Record<string, number>)[field.key] = clampField(field.key, value);
  }

  if (isObject(src.month_projects)) {
    const keys = Object.keys(src.month_projects).filter(isMonthKey).sort().slice(0, MAX_MONTH_PROJECTS);
    for (const key of keys) {
      const value = readNumber(src.month_projects[key]);
      if (value !== null) out.month_projects[key] = clampField('projects_per_month', value);
    }
  }

  if (Array.isArray(src.items)) {
    const taken = new Set<string>();
    for (const rawItem of src.items.slice(0, MAX_ITEMS)) {
      if (!isObject(rawItem)) continue;
      const label = cleanLabel(rawItem.label);
      const amount = readNumber(rawItem.amount);
      if (!label || amount === null || !isMonthKey(rawItem.from)) continue;
      const kind: ForecastItemKind = rawItem.kind === 'revenue' ? 'revenue' : 'cost';
      const from = rawItem.from;
      const to = isMonthKey(rawItem.to) ? (rawItem.to < from ? from : rawItem.to) : null;
      const id = typeof rawItem.id === 'string' && ITEM_ID_RE.test(rawItem.id) && !taken.has(rawItem.id) ? rawItem.id : nextItemId(taken);
      taken.add(id);
      out.items.push({ id, label, kind, amount: Math.min(ITEM_AMOUNT_MAX, Math.max(0, roundTo(amount, 2))), from, to });
    }
  }
  return out;
}

// ── Een wijziging, met de reden als hij niet kan ───────────────────────────

/** Een wijziging die niet kan; de tekst is voor de gebruiker (en voor Gerrie, die zich dan verbetert). */
export class ForecastInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForecastInputError';
  }
}

export interface ForecastItemInput {
  label?: unknown;
  kind?: unknown;
  amount?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * Wat er verandert. Elk veld is optioneel; null bij een automatisch veld zet
 * het terug op automatisch. `month_projects` vult aan: een maand met null gaat
 * terug naar de verwachting.
 */
export interface ForecastPatch {
  start_month?: string | null;
  months?: number;
  projects_per_month?: number | null;
  growth_pct?: number;
  revenue_per_project?: number | null;
  project_months?: number;
  other_revenue?: number | null;
  fixed_costs?: number | null;
  cost_increase_pct?: number;
  variable_cost_pct?: number;
  month_projects?: Record<string, number | null>;
  add_items?: ForecastItemInput[];
  update_items?: Array<ForecastItemInput & { id?: unknown }>;
  remove_item_ids?: string[];
}

export const PATCH_KEYS: readonly (keyof ForecastPatch)[] = [
  'start_month', 'months', 'projects_per_month', 'growth_pct', 'revenue_per_project', 'project_months',
  'other_revenue', 'fixed_costs', 'cost_increase_pct', 'variable_cost_pct', 'month_projects',
  'add_items', 'update_items', 'remove_item_ids',
];

/** Een veld zoals de gebruiker het leest: "€ 5.000", "10%", "2,4", "3 maanden", of "automatisch". */
export function fieldValueText(key: ForecastNumberField, value: number | null): string {
  if (value === null) return 'automatisch';
  const field = forecastField(key);
  if (field.unit === 'euro') return euroText(toCents(value));
  if (field.unit === 'pct') return pctText(value);
  if (field.unit === 'months') return `${numberText(value, 0)} ${value === 1 ? 'maand' : 'maanden'}`;
  return numberText(value, 2);
}

function startText(start: string | null): string {
  return start ? monthLabel(start) : 'deze maand (schuift mee)';
}

export function itemText(item: ForecastItem): string {
  const period = item.to === null
    ? `vanaf ${monthLabel(item.from)}`
    : item.to === item.from ? `in ${monthLabel(item.from)}` : `${monthLabel(item.from)} t/m ${monthLabel(item.to)}`;
  return `${item.label}: ${item.kind === 'revenue' ? 'omzet' : 'kosten'} ${euroText(toCents(item.amount))} per maand, ${period}`;
}

function strictNumber(key: ForecastNumberField, raw: unknown): number {
  const field = forecastField(key);
  const value = readNumber(raw);
  if (value === null) throw new ForecastInputError(`"${field.label}" moet een getal zijn.`);
  if (value < field.min || value > field.max) {
    throw new ForecastInputError(`"${field.label}" moet tussen ${fieldValueText(key, field.min)} en ${fieldValueText(key, field.max)} liggen.`);
  }
  if (field.decimals === 0 && !Number.isInteger(value)) throw new ForecastInputError(`"${field.label}" moet een heel getal zijn.`);
  return roundTo(value, field.decimals);
}

function strictMonth(raw: unknown, label: string): string {
  if (!isMonthKey(raw)) throw new ForecastInputError(`${label} moet een maand zijn als JJJJ-MM, bijvoorbeeld 2027-03.`);
  return raw;
}

function strictItem(input: ForecastItemInput, base: ForecastItem | null, id: string): ForecastItem {
  const label = input.label === undefined && base ? base.label : cleanLabel(input.label);
  if (!label) throw new ForecastInputError('Een extra post heeft een naam nodig, bijvoorbeeld "Nieuwe medewerker".');
  const kindRaw = input.kind === undefined && base ? base.kind : input.kind;
  if (kindRaw !== 'revenue' && kindRaw !== 'cost') {
    throw new ForecastInputError(`Bij de post "${label}" moet "kind" revenue (omzet) of cost (kosten) zijn.`);
  }
  let amount: number;
  if (input.amount === undefined && base) amount = base.amount;
  else {
    const value = readNumber(input.amount);
    if (value === null || value < 0 || value > ITEM_AMOUNT_MAX) {
      throw new ForecastInputError(`Bij de post "${label}" moet het bedrag per maand tussen € 0 en € 10.000.000 liggen (exclusief btw). Is het een vermindering, kies dan de andere soort.`);
    }
    amount = roundTo(value, 2);
  }
  const from = input.from === undefined && base ? base.from : strictMonth(input.from, `Bij de post "${label}" de eerste maand`);
  let to: string | null;
  if (input.to === undefined) to = base ? base.to : null;
  else if (input.to === null || input.to === '') to = null;
  else to = strictMonth(input.to, `Bij de post "${label}" de laatste maand`);
  if (to !== null && to < from) throw new ForecastInputError(`Bij de post "${label}" ligt de laatste maand vóór de eerste.`);
  return { id, label, kind: kindRaw, amount, from, to };
}

/**
 * Past een wijziging toe. Wat niet kan, gooit een ForecastInputError met de
 * reden; `changes` zegt in gewone woorden wat er veranderde (diffAssumptions).
 * Voor Gerrie, de MCP en de API; het scherm bouwt de aannames zelf.
 */
export function applyForecastPatch(current: unknown, rawPatch: unknown): { next: ForecastAssumptions; changes: string[] } {
  if (!isObject(rawPatch)) throw new ForecastInputError('De wijziging moet een object zijn.');
  const patch = rawPatch as Record<string, unknown>;
  const base = normalizeAssumptions(current);
  const next: ForecastAssumptions = { ...base, month_projects: { ...base.month_projects }, items: base.items.map((item) => ({ ...item })) };

  if ('start_month' in patch) {
    const raw = patch.start_month;
    next.start_month = raw === null || raw === '' ? null : strictMonth(raw, 'Het begin');
  }

  for (const field of FORECAST_FIELDS) {
    if (!(field.key in patch)) continue;
    const raw = patch[field.key];
    let value: number | null;
    if (raw === null || raw === '') {
      if (!field.auto) throw new ForecastInputError(`"${field.label}" kan niet leeg; geef een getal.`);
      value = null;
    } else {
      value = strictNumber(field.key, raw);
    }
    (next as unknown as Record<string, number | null>)[field.key] = value;
  }

  if (patch.month_projects !== undefined && patch.month_projects !== null) {
    if (!isObject(patch.month_projects)) throw new ForecastInputError('"month_projects" moet een object zijn: { "2027-07": 1 }.');
    for (const [month, raw] of Object.entries(patch.month_projects)) {
      strictMonth(month, `"${month}" in month_projects`);
      if (raw === null || raw === '') delete next.month_projects[month];
      else next.month_projects[month] = strictNumber('projects_per_month', raw);
    }
    if (Object.keys(next.month_projects).length > MAX_MONTH_PROJECTS) {
      throw new ForecastInputError(`Hooguit ${MAX_MONTH_PROJECTS} maanden met een eigen aantal projecten.`);
    }
  }

  if (patch.remove_item_ids !== undefined && patch.remove_item_ids !== null) {
    if (!Array.isArray(patch.remove_item_ids)) throw new ForecastInputError('"remove_item_ids" moet een lijst met id\'s van posten zijn.');
    for (const rawId of patch.remove_item_ids) {
      const index = next.items.findIndex((item) => item.id === String(rawId));
      if (index < 0) throw new ForecastInputError(`Er is geen post met id "${String(rawId)}". Kijk eerst met forecast.list welke posten er zijn.`);
      next.items.splice(index, 1);
    }
  }

  if (patch.update_items !== undefined && patch.update_items !== null) {
    if (!Array.isArray(patch.update_items)) throw new ForecastInputError('"update_items" moet een lijst zijn.');
    for (const rawItem of patch.update_items) {
      if (!isObject(rawItem)) throw new ForecastInputError('Elke post in "update_items" moet een object zijn met een id.');
      const index = next.items.findIndex((item) => item.id === String(rawItem.id ?? ''));
      if (index < 0) throw new ForecastInputError(`Er is geen post met id "${String(rawItem.id ?? '')}". Kijk eerst met forecast.list welke posten er zijn.`);
      next.items[index] = strictItem(rawItem, next.items[index], next.items[index].id);
    }
  }

  if (patch.add_items !== undefined && patch.add_items !== null) {
    if (!Array.isArray(patch.add_items)) throw new ForecastInputError('"add_items" moet een lijst zijn.');
    for (const rawItem of patch.add_items) {
      if (!isObject(rawItem)) throw new ForecastInputError('Elke nieuwe post moet een object zijn met label, kind, amount en from.');
      next.items.push(strictItem(rawItem, null, nextItemId(new Set(next.items.map((existing) => existing.id)))));
    }
  }
  if (next.items.length > MAX_ITEMS) throw new ForecastInputError(`Hooguit ${MAX_ITEMS} extra posten per prognose.`);

  return { next, changes: diffAssumptions(base, next) };
}

function capitalize(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function monthProjectsText(month: string, count: number): string {
  return `${capitalize(monthLabel(month))}: ${numberText(count, 2)} ${count === 1 ? 'nieuw project' : 'nieuwe projecten'}`;
}

/**
 * Wat er tussen twee standen veranderde, in gewone woorden. Komt op de kaart
 * van Gerrie, in de geschiedenis van een prognose en in het logboek ervan:
 * "Groei per jaar: 0% → 10%", "Post erbij: Nieuwe medewerker: kosten
 * € 3.500 per maand, vanaf maart 2027".
 */
export function diffAssumptions(beforeRaw: unknown, afterRaw: unknown): string[] {
  const before = normalizeAssumptions(beforeRaw);
  const after = normalizeAssumptions(afterRaw);
  const changes: string[] = [];
  if (before.start_month !== after.start_month) changes.push(`Begin: ${startText(before.start_month)} → ${startText(after.start_month)}`);
  for (const field of FORECAST_FIELDS) {
    const was = (before as unknown as Record<string, number | null>)[field.key];
    const is = (after as unknown as Record<string, number | null>)[field.key];
    if (was !== is) changes.push(`${field.label}: ${fieldValueText(field.key, was)} → ${fieldValueText(field.key, is)}`);
  }
  const months = [...new Set([...Object.keys(before.month_projects), ...Object.keys(after.month_projects)])].sort();
  for (const month of months) {
    const was = before.month_projects[month];
    const is = after.month_projects[month];
    if (was === is) continue;
    changes.push(is === undefined ? `${capitalize(monthLabel(month))}: weer volgens de verwachting` : monthProjectsText(month, is));
  }
  const afterIds = new Set(after.items.map((item) => item.id));
  for (const item of before.items) if (!afterIds.has(item.id)) changes.push(`Post weg: ${item.label}`);
  const beforeById = new Map(before.items.map((item) => [item.id, item]));
  for (const item of after.items) {
    const was = beforeById.get(item.id);
    if (!was) changes.push(`Post erbij: ${itemText(item)}`);
    else if (itemText(was) !== itemText(item)) changes.push(`Post aangepast: ${itemText(item)}`);
  }
  return changes;
}

/** Eén regel voor in de geschiedenis: de wijzigingen achter elkaar, ingekort. */
export function changeNote(changes: string[], prefix = '', max = 480): string {
  const text = `${prefix}${changes.join('; ')}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── De cijfers uit de administratie ────────────────────────────────────────

export interface HistoryMonth {
  month: string;
  /** Null: deze gebruiker mag Projecten niet lezen. */
  projects: number | null;
  revenue_project_cents: number;
  revenue_other_cents: number;
  purchase_cents: number;
  ledger_revenue_cents: number;
  ledger_expense_cents: number;
}

export interface PipelineInfo {
  /** Verstuurd en nog geldig. */
  open_count: number;
  open_cents: number;
  /** Geaccepteerd, nog geen factuur. */
  accepted_count: number;
  accepted_cents: number;
  /** Het afgelopen jaar: hoeveel offertes het werden, en hoeveel niet. */
  won_count: number;
  lost_count: number;
}

export interface ForecastInputs {
  from: string;
  to: string;
  today: string;
  projects_visible: boolean;
  months: HistoryMonth[];
  pipeline: PipelineInfo;
}

const EMPTY_PIPELINE: PipelineInfo = { open_count: 0, open_cents: 0, accepted_count: 0, accepted_cents: 0, won_count: 0, lost_count: 0 };

function intOf(raw: unknown): number {
  const value = readNumber(raw);
  return value === null ? 0 : Math.round(value);
}

/** Leest het antwoord van forecast_history. Een ontbrekend getal telt als nul, nooit als NaN. */
export function parseForecastInputs(raw: unknown, today: string): ForecastInputs {
  const src = isObject(raw) ? raw : {};
  const projectsVisible = src.projects_visible !== false;
  const months: HistoryMonth[] = [];
  if (Array.isArray(src.months)) {
    for (const row of src.months) {
      if (!isObject(row) || !isMonthKey(row.month)) continue;
      months.push({
        month: row.month,
        projects: projectsVisible && row.projects !== null && row.projects !== undefined ? intOf(row.projects) : null,
        revenue_project_cents: intOf(row.revenue_project_cents),
        revenue_other_cents: intOf(row.revenue_other_cents),
        purchase_cents: intOf(row.purchase_cents),
        ledger_revenue_cents: intOf(row.ledger_revenue_cents),
        ledger_expense_cents: intOf(row.ledger_expense_cents),
      });
    }
  }
  months.sort((a, b) => a.month.localeCompare(b.month));
  const pipe = isObject(src.pipeline) ? src.pipeline : {};
  return {
    from: isMonthKey(src.from) ? src.from : (months[0]?.month ?? monthOfDate(today)),
    to: isMonthKey(src.to) ? src.to : (months[months.length - 1]?.month ?? monthOfDate(today)),
    today: typeof src.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(src.today) ? src.today : today,
    projects_visible: projectsVisible,
    months,
    pipeline: {
      open_count: intOf(pipe.open_count), open_cents: intOf(pipe.open_cents),
      accepted_count: intOf(pipe.accepted_count), accepted_cents: intOf(pipe.accepted_cents),
      won_count: intOf(pipe.won_count), lost_count: intOf(pipe.lost_count),
    },
  };
}

export function emptyForecastInputs(today: string): ForecastInputs {
  const month = monthOfDate(today);
  return { from: month, to: month, today, projects_visible: true, months: [], pipeline: { ...EMPTY_PIPELINE } };
}

/** Gefactureerde omzet van een maand, exclusief btw. */
export function historyRevenueCents(row: HistoryMonth): number {
  return row.revenue_project_cents + row.revenue_other_cents;
}

/**
 * De kosten van een maand: het hoogste van wat er in de boekhouding als kosten
 * geboekt is en de inkoopfacturen. Zijn de inkoopfacturen geboekt, dan zitten
 * ze in de boekhouding (met de lonen en afschrijvingen erbij) en wint die.
 * Boek je niet in ResoFly, dan zijn de inkoopfacturen het beste wat er is.
 * Optellen zou geboekte inkoopfacturen dubbel tellen.
 */
export function historyCostsCents(row: HistoryMonth): number {
  return Math.max(row.ledger_expense_cents, row.purchase_cents);
}

/** Uit welke maanden de prognose leert: de twaalf hele maanden vóór deze maand. */
export const BASELINE_MONTHS = 12;

export function baselineWindow(today: string): { from: string; to: string } {
  const current = monthOfDate(today);
  return { from: addMonths(current, -BASELINE_MONTHS), to: addMonths(current, -1) };
}

/**
 * Welke maanden de app en Gerrie bij forecast_history opvragen: het
 * leerjaar, plus de maanden van een prognose die al begonnen is (om er de
 * werkelijke cijfers naast te zetten), tot en met deze maand. Nooit verder
 * terug dan vier jaar.
 */
export function historyRange(today: string, starts: Array<string | null | undefined>): { from: string; to: string } {
  const current = monthOfDate(today);
  let from = baselineWindow(today).from;
  for (const start of starts) if (isMonthKey(start) && start < from) from = start;
  const earliest = addMonths(current, -48);
  if (from < earliest) from = earliest;
  return { from, to: current };
}

export type CostSource = 'ledger' | 'purchases' | 'mixed' | 'none';

export interface ForecastBaseline {
  /** De maanden waaruit geleerd is; null als er nog niets was. */
  from: string | null;
  to: string | null;
  months: number;
  projects_visible: boolean;
  /** Totalen over die maanden. */
  projects: number | null;
  revenue_project_cents: number;
  revenue_other_cents: number;
  costs_cents: number;
  /** Wat "automatisch" betekent, per maand. */
  projects_per_month: number;
  revenue_per_project_cents: number;
  other_revenue_cents: number;
  fixed_costs_cents: number;
  cost_source: CostSource;
}

/**
 * Het gemiddelde van de laatste twaalf hele maanden. Is het bedrijf jonger,
 * dan telt het vanaf de eerste maand met iets erin: wie in juni begon, deelt
 * niet door twaalf.
 *
 * Omzet zonder project en omzet van projecten die vóór het jaar begonnen
 * (als er in het jaar geen projecten startten) zijn "overige omzet". Zo levert
 * de prognose zonder groei precies het gemiddelde van het afgelopen jaar op.
 */
export function computeBaseline(inputs: ForecastInputs, today: string): ForecastBaseline {
  const learn = baselineWindow(today);
  const rows = inputs.months.filter((row) => row.month >= learn.from && row.month <= learn.to);
  const firstActive = rows.find((row) => (row.projects ?? 0) > 0 || historyRevenueCents(row) !== 0 || historyCostsCents(row) !== 0);
  const empty: ForecastBaseline = {
    from: null, to: null, months: 0, projects_visible: inputs.projects_visible,
    projects: inputs.projects_visible ? 0 : null, revenue_project_cents: 0, revenue_other_cents: 0, costs_cents: 0,
    projects_per_month: 0, revenue_per_project_cents: 0, other_revenue_cents: 0, fixed_costs_cents: 0, cost_source: 'none',
  };
  if (!firstActive) return empty;

  const used = rows.filter((row) => row.month >= firstActive.month);
  const months = monthsBetween(firstActive.month, learn.to) + 1;
  let projects = 0;
  let revenueProject = 0;
  let revenueOther = 0;
  let costs = 0;
  let ledgerMonths = 0;
  let purchaseMonths = 0;
  for (const row of used) {
    projects += row.projects ?? 0;
    revenueProject += row.revenue_project_cents;
    revenueOther += row.revenue_other_cents;
    const monthCosts = historyCostsCents(row);
    costs += monthCosts;
    if (monthCosts !== 0) {
      if (row.ledger_expense_cents >= row.purchase_cents) ledgerMonths += 1;
      else purchaseMonths += 1;
    }
  }
  const visible = inputs.projects_visible;
  const countedProjects = visible ? projects : 0;
  return {
    from: firstActive.month,
    to: learn.to,
    months,
    projects_visible: visible,
    projects: visible ? projects : null,
    revenue_project_cents: revenueProject,
    revenue_other_cents: revenueOther,
    costs_cents: costs,
    projects_per_month: countedProjects / months,
    revenue_per_project_cents: countedProjects > 0 ? Math.round(revenueProject / countedProjects) : 0,
    other_revenue_cents: Math.round((revenueOther + (countedProjects > 0 ? 0 : revenueProject)) / months),
    fixed_costs_cents: Math.round(costs / months),
    cost_source: ledgerMonths === 0 && purchaseMonths === 0 ? 'none' : purchaseMonths === 0 ? 'ledger' : ledgerMonths === 0 ? 'purchases' : 'mixed',
  };
}

export const COST_SOURCE_TEXT: Readonly<Record<CostSource, string>> = {
  ledger: 'uit je boekhouding',
  purchases: 'uit je inkoopfacturen',
  mixed: 'uit je boekhouding en je inkoopfacturen',
  none: 'nog geen kosten gevonden',
};

// ── De prognose zelf ────────────────────────────────────────────────────────

export interface ForecastActual {
  projects: number | null;
  revenue_cents: number;
  costs_cents: number;
  profit_cents: number;
  /** De maand is voorbij; anders staat er wat er tot nu toe is. */
  complete: boolean;
}

export interface ForecastMonth {
  month: string;
  /** Nieuwe projecten; kan een breuk zijn (2,4 per maand). */
  projects: number;
  /** Met de hand gezet voor deze maand (month_projects). */
  projects_set: boolean;
  revenue_projects_cents: number;
  revenue_other_cents: number;
  revenue_items_cents: number;
  revenue_cents: number;
  costs_fixed_cents: number;
  costs_variable_cents: number;
  costs_items_cents: number;
  costs_cents: number;
  profit_cents: number;
  cumulative_profit_cents: number;
  /** Wat er werkelijk gebeurde, voor een maand die al begonnen of voorbij is. */
  actual: ForecastActual | null;
}

export interface ForecastTotals {
  projects: number;
  revenue_cents: number;
  costs_cents: number;
  profit_cents: number;
  /** Winst als deel van de omzet; null zonder omzet. */
  margin_pct: number | null;
}

export interface ForecastEffective {
  start_month: string;
  end_month: string;
  months: number;
  projects_per_month: number;
  revenue_per_project_cents: number;
  other_revenue_cents: number;
  fixed_costs_cents: number;
  /** Welke waarden automatisch zijn (uit de cijfers). */
  auto: { projects_per_month: boolean; revenue_per_project: boolean; other_revenue: boolean; fixed_costs: boolean; start_month: boolean };
}

export interface HistoryPoint {
  month: string;
  projects: number | null;
  revenue_cents: number;
  costs_cents: number;
  profit_cents: number;
}

export interface ForecastResult {
  assumptions: ForecastAssumptions;
  effective: ForecastEffective;
  baseline: ForecastBaseline;
  months: ForecastMonth[];
  totals: ForecastTotals;
  /** De twaalf hele maanden vóór deze maand, voor de vergelijking. */
  history: HistoryPoint[];
  history_totals: ForecastTotals;
  /** Voor de maanden van de prognose die al voorbij zijn: verwacht tegenover werkelijk. */
  so_far: { months: number; expected: ForecastTotals; actual: ForecastTotals } | null;
  pipeline: PipelineInfo;
}

function totalsOf(rows: Array<{ projects: number | null; revenue_cents: number; costs_cents: number; profit_cents: number }>): ForecastTotals {
  let projects = 0;
  let revenue = 0;
  let costs = 0;
  for (const row of rows) {
    projects += row.projects ?? 0;
    revenue += row.revenue_cents;
    costs += row.costs_cents;
  }
  const profit = revenue - costs;
  return { projects, revenue_cents: revenue, costs_cents: costs, profit_cents: profit, margin_pct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null };
}

function activeIn(item: ForecastItem, month: string): boolean {
  return item.from <= month && (item.to === null || month <= item.to);
}

/**
 * Rekent de prognose uit. Alle bedragen in hele centen, per maand afgerond.
 *
 * - Nieuwe projecten: het aantal per maand, met de groei geleidelijk erbij
 *   (10% per jaar is per maand de twaalfde machtswortel van 1,10), tenzij een
 *   maand een eigen aantal heeft.
 * - Omzet uit projecten: elk project levert zijn omzet verdeeld over
 *   `project_months` maanden vanaf de start. Voor de maanden vóór de prognose
 *   telt dezelfde verwachting door, anders begon elke prognose met een dip.
 * - Overige omzet groeit mee; extra posten tellen in hun maanden.
 * - Kosten: vast (met de stijging per jaar), meegroeiend als deel van de
 *   omzet, en de extra posten.
 */
export function computeForecast(rawAssumptions: unknown, inputs: ForecastInputs, today: string): ForecastResult {
  const a = normalizeAssumptions(rawAssumptions);
  const baseline = computeBaseline(inputs, today);
  const current = monthOfDate(today);
  const start = a.start_month ?? current;
  const end = addMonths(start, a.months - 1);

  const projectsPerMonth = a.projects_per_month ?? baseline.projects_per_month;
  const valueCents = a.revenue_per_project !== null ? toCents(a.revenue_per_project) : baseline.revenue_per_project_cents;
  const otherCents = a.other_revenue !== null ? toCents(a.other_revenue) : baseline.other_revenue_cents;
  const fixedCents = a.fixed_costs !== null ? toCents(a.fixed_costs) : baseline.fixed_costs_cents;
  const growth = Math.pow(1 + a.growth_pct / 100, 1 / 12);
  const costRise = Math.pow(1 + a.cost_increase_pct / 100, 1 / 12);
  const spread = a.project_months;

  const projectsAt = (offset: number): number => {
    const set = a.month_projects[addMonths(start, offset)];
    return set !== undefined ? set : projectsPerMonth * Math.pow(growth, offset);
  };

  const byMonth = new Map(inputs.months.map((row) => [row.month, row]));
  const months: ForecastMonth[] = [];
  let cumulative = 0;
  for (let t = 0; t < a.months; t += 1) {
    const month = addMonths(start, t);
    const projects = projectsAt(t);
    let projectRevenue = 0;
    for (let k = 0; k < spread; k += 1) projectRevenue += (projectsAt(t - k) * valueCents) / spread;
    const revenueProjects = Math.round(projectRevenue);
    const revenueOther = Math.round(otherCents * Math.pow(growth, t));
    let revenueItems = 0;
    let costItems = 0;
    for (const item of a.items) {
      if (!activeIn(item, month)) continue;
      if (item.kind === 'revenue') revenueItems += toCents(item.amount);
      else costItems += toCents(item.amount);
    }
    const revenue = revenueProjects + revenueOther + revenueItems;
    const costsFixed = Math.round(fixedCents * Math.pow(costRise, t));
    const costsVariable = Math.round((revenue * a.variable_cost_pct) / 100);
    const costs = costsFixed + costsVariable + costItems;
    const profit = revenue - costs;
    cumulative += profit;

    let actual: ForecastActual | null = null;
    if (month <= current) {
      const row = byMonth.get(month);
      if (row) {
        const actualRevenue = historyRevenueCents(row);
        const actualCosts = historyCostsCents(row);
        actual = { projects: row.projects, revenue_cents: actualRevenue, costs_cents: actualCosts, profit_cents: actualRevenue - actualCosts, complete: month < current };
      }
    }

    months.push({
      month, projects, projects_set: a.month_projects[month] !== undefined,
      revenue_projects_cents: revenueProjects, revenue_other_cents: revenueOther, revenue_items_cents: revenueItems, revenue_cents: revenue,
      costs_fixed_cents: costsFixed, costs_variable_cents: costsVariable, costs_items_cents: costItems, costs_cents: costs,
      profit_cents: profit, cumulative_profit_cents: cumulative, actual,
    });
  }

  const learn = baselineWindow(today);
  const history: HistoryPoint[] = [];
  for (let t = 0; t < BASELINE_MONTHS; t += 1) {
    const month = addMonths(learn.from, t);
    const row = byMonth.get(month);
    const revenue = row ? historyRevenueCents(row) : 0;
    const costs = row ? historyCostsCents(row) : 0;
    history.push({ month, projects: inputs.projects_visible ? (row?.projects ?? 0) : null, revenue_cents: revenue, costs_cents: costs, profit_cents: revenue - costs });
  }

  const past = months.filter((row) => row.actual?.complete);
  const soFar = past.length > 0
    ? {
      months: past.length,
      expected: totalsOf(past.map((row) => ({ projects: row.projects, revenue_cents: row.revenue_cents, costs_cents: row.costs_cents, profit_cents: row.profit_cents }))),
      actual: totalsOf(past.map((row) => row.actual as ForecastActual)),
    }
    : null;

  return {
    assumptions: a,
    effective: {
      start_month: start,
      end_month: end,
      months: a.months,
      projects_per_month: projectsPerMonth,
      revenue_per_project_cents: valueCents,
      other_revenue_cents: otherCents,
      fixed_costs_cents: fixedCents,
      auto: {
        projects_per_month: a.projects_per_month === null,
        revenue_per_project: a.revenue_per_project === null,
        other_revenue: a.other_revenue === null,
        fixed_costs: a.fixed_costs === null,
        start_month: a.start_month === null,
      },
    },
    baseline,
    months,
    totals: totalsOf(months.map((row) => ({ projects: row.projects, revenue_cents: row.revenue_cents, costs_cents: row.costs_cents, profit_cents: row.profit_cents }))),
    history,
    history_totals: totalsOf(history),
    so_far: soFar,
    pipeline: inputs.pipeline,
  };
}

// ── In gewone woorden ───────────────────────────────────────────────────────

/** "12 maanden (dec 2026 t/m nov 2027): 29 nieuwe projecten, omzet € 345.600, kosten € 240.000, winst € 105.600 (31%)." */
export function summarizeForecast(result: ForecastResult): string {
  const { effective, totals } = result;
  const span = `${effective.months} ${effective.months === 1 ? 'maand' : 'maanden'} (${monthLabel(effective.start_month, 'short')} t/m ${monthLabel(effective.end_month, 'short')})`;
  const projects = result.baseline.projects_visible ? `${numberText(totals.projects, 1)} nieuwe projecten, ` : '';
  const margin = totals.margin_pct === null ? '' : ` (${pctText(totals.margin_pct)})`;
  return `${span}: ${projects}omzet ${wholeEuroText(totals.revenue_cents)}, kosten ${wholeEuroText(totals.costs_cents)}, winst ${wholeEuroText(totals.profit_cents)}${margin}.`;
}

/** Elke aanname als regel: "Nieuwe projecten per maand: 2,4 (automatisch)". */
export function describeAssumptions(result: ForecastResult): string[] {
  const { assumptions: a, effective } = result;
  const lines = [`Begin: ${startText(a.start_month)}, ${effective.months} ${effective.months === 1 ? 'maand' : 'maanden'} vooruit`];
  const auto = (flag: boolean) => (flag ? ' (automatisch, uit je cijfers)' : '');
  lines.push(`Nieuwe projecten per maand: ${numberText(effective.projects_per_month, 2)}${auto(effective.auto.projects_per_month)}`);
  lines.push(`Omzet per project: ${euroText(effective.revenue_per_project_cents)}${auto(effective.auto.revenue_per_project)}, verdeeld over ${fieldValueText('project_months', a.project_months)}`);
  lines.push(`Overige omzet per maand: ${euroText(effective.other_revenue_cents)}${auto(effective.auto.other_revenue)}`);
  lines.push(`Groei per jaar: ${pctText(a.growth_pct)}`);
  lines.push(`Vaste kosten per maand: ${euroText(effective.fixed_costs_cents)}${auto(effective.auto.fixed_costs)}`);
  lines.push(`Kostenstijging per jaar: ${pctText(a.cost_increase_pct)}`);
  lines.push(`Kosten die meegroeien met de omzet: ${pctText(a.variable_cost_pct)}`);
  for (const [month, count] of Object.entries(a.month_projects)) {
    lines.push(`${capitalize(monthLabel(month))}: ${numberText(count, 2)} ${count === 1 ? 'nieuw project' : 'nieuwe projecten'}`);
  }
  for (const item of a.items) lines.push(`Extra post (${item.id}) ${itemText(item)}`);
  return lines;
}
