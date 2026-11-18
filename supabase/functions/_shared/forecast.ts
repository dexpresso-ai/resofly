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
// (migratie 20261118144500). De app en de server roepen dezelfde functie aan.
//
// Sinds 20261118171500 ook:
//  - een SEIZOENSPATROON uit de vorige jaren (computeSeasonality): de
//    verwachting volgt de drukke en rustige maanden van je eigen omzet;
//  - een CASHFLOW (computeCashflow): wat er op je rekening staat, maand voor
//    maand. Die rust daarnaast op public.forecast_cash_position: het banksaldo,
//    de openstaande posten, de btw-aangiftes en het betaalgedrag.
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

/**
 * Omzet en kosten tellen in de winst (en via de btw en de betaaltermijn in de
 * cashflow). Geld erbij en geld eraf tellen ALLEEN in de cashflow: een lening,
 * een privé-opname of -storting, een investering (die kost geld bij de aankoop
 * en daarna afschrijving, geen geld), een belastingaanslag.
 */
export type ForecastItemKind = 'revenue' | 'cost' | 'cash_in' | 'cash_out';

export const ITEM_KINDS: readonly ForecastItemKind[] = ['revenue', 'cost', 'cash_in', 'cash_out'];

/** Hoe een soort post heet: "omzet", "kosten", "geld erbij", "geld eraf". */
export const ITEM_KIND_TEXT: Readonly<Record<ForecastItemKind, string>> = {
  revenue: 'omzet',
  cost: 'kosten',
  cash_in: 'geld erbij',
  cash_out: 'geld eraf',
};

/** Telt de post alleen in de cashflow (niet in omzet, kosten en winst)? */
export function isCashItem(kind: ForecastItemKind): boolean {
  return kind === 'cash_in' || kind === 'cash_out';
}

/** Een extra post: een nieuwe medewerker, een investering, een grote opdracht, een lening. */
export interface ForecastItem {
  /** Vaste sleutel binnen de prognose ("post-3"); Gerrie wijst er een post mee aan. */
  id: string;
  label: string;
  kind: ForecastItemKind;
  /** Per maand, in euro's: omzet en kosten exclusief btw, geld erbij en eraf zoals het van de rekening gaat. */
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
  /**
   * Hoe sterk de prognose het seizoenspatroon van de vorige jaren volgt: 0 =
   * uit (elke maand gelijk), 100 = zoals de vorige jaren. Werkt op de nieuwe
   * projecten en de overige omzet; een maand met een eigen aantal projecten
   * houdt dat aantal.
   */
  seasonality_pct: number;
  /** Banksaldo vandaag in euro's (bank en kas), of null: automatisch uit ResoFly. */
  cash_start: number | null;
  /** Na hoeveel dagen klanten betalen, of null: automatisch (hun betaalgedrag, anders je betaaltermijn). */
  collection_days: number | null;
  /** Btw op je omzet in procenten, of null: automatisch (wat je factureerde; met de KOR 0). */
  vat_sales_pct: number | null;
  /** Btw op je kosten zonder afschrijvingen, in procenten, of null: automatisch. */
  vat_costs_pct: number | null;
  /** Kosten per maand die niet van je rekening gaan (afschrijvingen), of null: automatisch. */
  noncash_costs: number | null;
  /** Ondergrens voor je saldo in euro's: daaronder waarschuwt de cashflow. */
  cash_buffer: number;
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
  seasonality_pct: 0,
  cash_start: null,
  collection_days: null,
  vat_sales_pct: null,
  vat_costs_pct: null,
  noncash_costs: null,
  cash_buffer: 0,
};

export type ForecastNumberField =
  | 'months' | 'projects_per_month' | 'growth_pct' | 'revenue_per_project' | 'project_months'
  | 'other_revenue' | 'fixed_costs' | 'cost_increase_pct' | 'variable_cost_pct'
  | 'seasonality_pct' | 'cash_start' | 'collection_days' | 'vat_sales_pct' | 'vat_costs_pct' | 'noncash_costs' | 'cash_buffer';

/** Waar een aanname op de pagina staat: bij het resultaat, het seizoen of de cashflow. */
export type ForecastFieldGroup = 'result' | 'season' | 'cash';

export interface ForecastFieldInfo {
  key: ForecastNumberField;
  group: ForecastFieldGroup;
  label: string;
  unit: 'euro' | 'pct' | 'count' | 'months' | 'days';
  /** Mag leeg zijn: dan automatisch, uit de cijfers. */
  auto: boolean;
  decimals: number;
  min: number;
  max: number;
  help: string;
}

/** De getallen, met hun grenzen. Het scherm, de kaart van Gerrie en de controle lezen allemaal deze lijst. */
export const FORECAST_FIELDS: readonly ForecastFieldInfo[] = [
  { key: 'projects_per_month', group: 'result', label: 'Nieuwe projecten per maand', unit: 'count', auto: true, decimals: 2, min: 0, max: 1000,
    help: 'Leeg = het gemiddelde van de laatste twaalf maanden.' },
  { key: 'revenue_per_project', group: 'result', label: 'Omzet per project', unit: 'euro', auto: true, decimals: 2, min: 0, max: 10000000,
    help: 'Exclusief btw. Leeg = wat een project het afgelopen jaar gemiddeld opbracht.' },
  { key: 'project_months', group: 'result', label: 'Omzet van een project verdeeld over', unit: 'months', auto: false, decimals: 0, min: 1, max: 24,
    help: 'Zoveel maanden factureer je een project, vanaf de start. 1 = alles in de startmaand.' },
  { key: 'other_revenue', group: 'result', label: 'Overige omzet per maand', unit: 'euro', auto: true, decimals: 2, min: 0, max: 10000000,
    help: 'Omzet zonder project, zoals abonnementen of losse verkoop. Leeg = het gemiddelde van het afgelopen jaar.' },
  { key: 'growth_pct', group: 'result', label: 'Groei per jaar', unit: 'pct', auto: false, decimals: 1, min: -90, max: 300,
    help: 'Meer (of minder) projecten en overige omzet, geleidelijk over het jaar.' },
  { key: 'fixed_costs', group: 'result', label: 'Vaste kosten per maand', unit: 'euro', auto: true, decimals: 2, min: 0, max: 10000000,
    help: 'Exclusief btw. Leeg = je gemiddelde kosten per maand van het afgelopen jaar, alles samen.' },
  { key: 'cost_increase_pct', group: 'result', label: 'Kostenstijging per jaar', unit: 'pct', auto: false, decimals: 1, min: -50, max: 100,
    help: 'Huur, abonnementen en lonen die duurder worden, geleidelijk over het jaar.' },
  { key: 'variable_cost_pct', group: 'result', label: 'Kosten die meegroeien met de omzet', unit: 'pct', auto: false, decimals: 1, min: 0, max: 100,
    help: 'Een deel van elke euro omzet: inkoop, uitbesteed werk, freelancers.' },
  { key: 'months', group: 'result', label: 'Aantal maanden vooruit', unit: 'months', auto: false, decimals: 0, min: 1, max: 36,
    help: 'Hooguit drie jaar.' },
  { key: 'seasonality_pct', group: 'season', label: 'Seizoenspatroon', unit: 'pct', auto: false, decimals: 0, min: 0, max: 100,
    help: '0% = elke maand gelijk. 100% = drukke en rustige maanden zoals in de vorige jaren.' },
  { key: 'cash_start', group: 'cash', label: 'Banksaldo nu', unit: 'euro', auto: true, decimals: 2, min: -100000000, max: 100000000,
    help: 'Wat er vandaag op je rekeningen en in de kas staat. Leeg = uit je bankrekeningen in ResoFly.' },
  { key: 'collection_days', group: 'cash', label: 'Klanten betalen na', unit: 'days', auto: true, decimals: 0, min: 0, max: 180,
    help: 'Dagen na de factuurdatum. Leeg = hoe snel je klanten het afgelopen jaar betaalden, of je betaaltermijn.' },
  { key: 'vat_sales_pct', group: 'cash', label: 'Btw op je omzet', unit: 'pct', auto: true, decimals: 1, min: 0, max: 30,
    help: 'Gemiddeld over al je facturen. Leeg = wat je het afgelopen jaar factureerde; met de KOR 0%.' },
  { key: 'vat_costs_pct', group: 'cash', label: 'Btw op je kosten', unit: 'pct', auto: true, decimals: 1, min: 0, max: 30,
    help: 'Gemiddeld over je kosten zonder afschrijvingen; lonen hebben geen btw. Leeg = uit je inkoop van het afgelopen jaar.' },
  { key: 'noncash_costs', group: 'cash', label: 'Afschrijvingen per maand', unit: 'euro', auto: true, decimals: 2, min: 0, max: 10000000,
    help: 'Kosten die niet van je rekening gaan. Leeg = je afschrijvingen van het afgelopen jaar.' },
  { key: 'cash_buffer', group: 'cash', label: 'Ondergrens saldo', unit: 'euro', auto: false, decimals: 2, min: 0, max: 100000000,
    help: 'Komt je saldo hieronder, dan waarschuwt de cashflow. 0 = alleen als je rood komt te staan.' },
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
      const kind: ForecastItemKind = ITEM_KINDS.includes(rawItem.kind as ForecastItemKind) ? rawItem.kind as ForecastItemKind : 'cost';
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
  seasonality_pct?: number;
  cash_start?: number | null;
  collection_days?: number | null;
  vat_sales_pct?: number | null;
  vat_costs_pct?: number | null;
  noncash_costs?: number | null;
  cash_buffer?: number;
}

export const PATCH_KEYS: readonly (keyof ForecastPatch)[] = [
  'start_month', 'months', 'projects_per_month', 'growth_pct', 'revenue_per_project', 'project_months',
  'other_revenue', 'fixed_costs', 'cost_increase_pct', 'variable_cost_pct', 'month_projects',
  'add_items', 'update_items', 'remove_item_ids',
  'seasonality_pct', 'cash_start', 'collection_days', 'vat_sales_pct', 'vat_costs_pct', 'noncash_costs', 'cash_buffer',
];

/** Een veld zoals de gebruiker het leest: "€ 5.000", "10%", "2,4", "3 maanden", "14 dagen", of "automatisch". */
export function fieldValueText(key: ForecastNumberField, value: number | null): string {
  if (value === null) return 'automatisch';
  const field = forecastField(key);
  if (key === 'seasonality_pct' && value === 0) return 'uit';
  if (field.unit === 'euro') return euroText(toCents(value));
  if (field.unit === 'pct') return pctText(value);
  if (field.unit === 'months') return `${numberText(value, 0)} ${value === 1 ? 'maand' : 'maanden'}`;
  if (field.unit === 'days') return `${numberText(value, 0)} ${value === 1 ? 'dag' : 'dagen'}`;
  return numberText(value, 2);
}

function startText(start: string | null): string {
  return start ? monthLabel(start) : 'deze maand (schuift mee)';
}

export function itemText(item: ForecastItem): string {
  const period = item.to === null
    ? `vanaf ${monthLabel(item.from)}`
    : item.to === item.from ? `in ${monthLabel(item.from)}` : `${monthLabel(item.from)} t/m ${monthLabel(item.to)}`;
  return `${item.label}: ${ITEM_KIND_TEXT[item.kind]} ${euroText(toCents(item.amount))} per maand, ${period}`;
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
  if (!ITEM_KINDS.includes(kindRaw as ForecastItemKind)) {
    throw new ForecastInputError(`Bij de post "${label}" moet "kind" revenue (omzet), cost (kosten), cash_in (geld erbij, alleen cashflow) of cash_out (geld eraf, alleen cashflow) zijn.`);
  }
  const kind = kindRaw as ForecastItemKind;
  let amount: number;
  if (input.amount === undefined && base) amount = base.amount;
  else {
    const value = readNumber(input.amount);
    if (value === null || value < 0 || value > ITEM_AMOUNT_MAX) {
      throw new ForecastInputError(isCashItem(kind)
        ? `Bij de post "${label}" moet het bedrag per maand tussen € 0 en € 10.000.000 liggen. Gaat het geld de andere kant op, kies dan de andere soort.`
        : `Bij de post "${label}" moet het bedrag per maand tussen € 0 en € 10.000.000 liggen (exclusief btw). Is het een vermindering, kies dan de andere soort.`);
    }
    amount = roundTo(value, 2);
  }
  const from = input.from === undefined && base ? base.from : strictMonth(input.from, `Bij de post "${label}" de eerste maand`);
  let to: string | null;
  if (input.to === undefined) to = base ? base.to : null;
  else if (input.to === null || input.to === '') to = null;
  else to = strictMonth(input.to, `Bij de post "${label}" de laatste maand`);
  if (to !== null && to < from) throw new ForecastInputError(`Bij de post "${label}" ligt de laatste maand vóór de eerste.`);
  return { id, label, kind, amount, from, to };
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
  /** Btw op de facturen (min creditnota's) en op de inkoopfacturen van de maand. */
  vat_out_cents: number;
  vat_in_cents: number;
  /** Dezelfde btw uit de boekhouding, zonder de boeking van een aangifte zelf. */
  ledger_vat_out_cents: number;
  ledger_vat_in_cents: number;
  /** Afschrijvingen: kosten die niet van de rekening gaan. */
  ledger_depreciation_cents: number;
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
  /**
   * Gaf forecast_history de btw en de afschrijvingen mee (20261118171500)? De
   * app rolt uit vóór de migratie draait: zonder deze velden zou een
   * ontbrekende btw als 0% gelezen worden, en dat is wat anders dan onbekend.
   */
  cash_fields: boolean;
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
  let cashFields = false;
  if (Array.isArray(src.months)) {
    for (const row of src.months) {
      if (!isObject(row) || !isMonthKey(row.month)) continue;
      if ('vat_out_cents' in row) cashFields = true;
      months.push({
        month: row.month,
        projects: projectsVisible && row.projects !== null && row.projects !== undefined ? intOf(row.projects) : null,
        revenue_project_cents: intOf(row.revenue_project_cents),
        revenue_other_cents: intOf(row.revenue_other_cents),
        purchase_cents: intOf(row.purchase_cents),
        ledger_revenue_cents: intOf(row.ledger_revenue_cents),
        ledger_expense_cents: intOf(row.ledger_expense_cents),
        vat_out_cents: intOf(row.vat_out_cents),
        vat_in_cents: intOf(row.vat_in_cents),
        ledger_vat_out_cents: intOf(row.ledger_vat_out_cents),
        ledger_vat_in_cents: intOf(row.ledger_vat_in_cents),
        ledger_depreciation_cents: intOf(row.ledger_depreciation_cents),
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
    cash_fields: cashFields,
  };
}

export function emptyForecastInputs(today: string): ForecastInputs {
  const month = monthOfDate(today);
  return { from: month, to: month, today, projects_visible: true, months: [], pipeline: { ...EMPTY_PIPELINE }, cash_fields: true };
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

/**
 * De kosten van een maand die van de rekening gingen: zonder afschrijvingen.
 * Dezelfde keuze als historyCostsCents: het hoogste van de boekhouding (nu
 * zonder afschrijving) en de inkoopfacturen (die zijn altijd geld).
 */
export function historyCashCostsCents(row: HistoryMonth): number {
  return Math.max(row.ledger_expense_cents - row.ledger_depreciation_cents, row.purchase_cents);
}

/**
 * De btw van een maand: het hoogste van de boekhouding en de facturen. Boek je
 * je facturen in ResoFly, dan staat hun btw in allebei; boek je ook kosten met
 * btw via de bank, dan heeft alleen de boekhouding die. Optellen telt dubbel.
 */
export function historyVatOutCents(row: HistoryMonth): number {
  return Math.max(row.ledger_vat_out_cents, row.vat_out_cents);
}

export function historyVatInCents(row: HistoryMonth): number {
  return Math.max(row.ledger_vat_in_cents, row.vat_in_cents);
}

/** Uit welke maanden de prognose leert: de twaalf hele maanden vóór deze maand. */
export const BASELINE_MONTHS = 12;

/** Hoeveel maanden terug de cijfers komen: vier jaar, voor het seizoenspatroon. */
export const HISTORY_MONTHS = 48;

export function baselineWindow(today: string): { from: string; to: string } {
  const current = monthOfDate(today);
  return { from: addMonths(current, -BASELINE_MONTHS), to: addMonths(current, -1) };
}

/**
 * Welke maanden de app en Gerrie bij forecast_history opvragen: vier jaar
 * terug tot en met deze maand. Het leerjaar zit erin, het seizoenspatroon
 * heeft de jaren ervoor nodig, en een prognose die al begon kan hooguit zo
 * ver terug (`starts` blijft voor wie dat later anders wil). Tot 18 november
 * vroeg de app alleen het leerjaar op: een seizoen zie je daar niet in.
 */
export function historyRange(today: string, starts: Array<string | null | undefined>): { from: string; to: string } {
  const current = monthOfDate(today);
  const earliest = addMonths(current, -HISTORY_MONTHS);
  let from = baselineWindow(today).from;
  for (const start of [earliest, ...starts]) if (isMonthKey(start) && start < from) from = start;
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
  /** Afschrijvingen per maand: kosten die niet van de rekening gaan. */
  noncash_cents: number;
  /** Btw op de omzet in procenten (een decimaal), of null: geen omzet of geen btw-cijfers. */
  vat_sales_pct: number | null;
  /** Btw op de kosten zonder afschrijvingen, in procenten, of null. */
  vat_costs_pct: number | null;
}

/** Een btw-percentage uit twee sommen: een decimaal, tussen 0 en 30. */
function vatPct(vatCents: number, baseCents: number): number | null {
  if (baseCents <= 0) return null;
  return Math.min(30, Math.max(0, Math.round((vatCents / baseCents) * 1000) / 10));
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
    noncash_cents: 0, vat_sales_pct: null, vat_costs_pct: null,
  };
  if (!firstActive) return empty;

  const used = rows.filter((row) => row.month >= firstActive.month);
  const months = monthsBetween(firstActive.month, learn.to) + 1;
  let projects = 0;
  let revenueProject = 0;
  let revenueOther = 0;
  let costs = 0;
  let cashCosts = 0;
  let vatOut = 0;
  let vatIn = 0;
  let ledgerMonths = 0;
  let purchaseMonths = 0;
  for (const row of used) {
    projects += row.projects ?? 0;
    revenueProject += row.revenue_project_cents;
    revenueOther += row.revenue_other_cents;
    const monthCosts = historyCostsCents(row);
    costs += monthCosts;
    cashCosts += historyCashCostsCents(row);
    vatOut += historyVatOutCents(row);
    vatIn += historyVatInCents(row);
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
    noncash_cents: Math.max(0, Math.round((costs - cashCosts) / months)),
    vat_sales_pct: inputs.cash_fields ? vatPct(vatOut, revenueProject + revenueOther) : null,
    vat_costs_pct: inputs.cash_fields ? vatPct(vatIn, cashCosts) : null,
  };
}

export const COST_SOURCE_TEXT: Readonly<Record<CostSource, string>> = {
  ledger: 'uit je boekhouding',
  purchases: 'uit je inkoopfacturen',
  mixed: 'uit je boekhouding en je inkoopfacturen',
  none: 'nog geen kosten gevonden',
};

// ── Het seizoenspatroon ─────────────────────────────────────────────────────

/** Zoveel maanden omzet heeft een seizoenspatroon minstens nodig: twee hele jaren. */
export const SEASON_MIN_MONTHS = 24;

/**
 * Hoe zwaar één maand hooguit telt: drie keer een gewone maand. Eén grote
 * opdracht in een maand zou anders elk jaar terugkomen als "seizoen".
 */
export const SEASON_RATIO_CAP = 3;

export interface SeasonalPattern {
  /** Is er genoeg omzet uit de vorige jaren? */
  available: boolean;
  /** Waarom niet, in gewone woorden; null als het er is. */
  reason: string | null;
  /** De maanden omzet waaruit geleerd is. */
  from: string | null;
  to: string | null;
  months: number;
  /** Per kalendermaand (januari eerst) hoe druk die is: 1 = een gemiddelde maand, 1,2 = 20% meer. Gemiddeld precies 1. */
  index: number[];
  /** Per kalendermaand uit hoeveel jaren dat getal komt. */
  samples: number[];
}

const FLAT_SEASON = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

/** De kalendermaand van 'JJJJ-MM': 0 = januari. */
function calendarMonth(month: string): number {
  return Number(month.slice(5, 7)) - 1;
}

/**
 * Het seizoenspatroon van de omzet, uit de hele maanden vóór deze maand.
 *
 * Per maand: de omzet gedeeld door het gecentreerde gemiddelde van de twaalf
 * maanden eromheen (de helft van de maanden op zes afstand, de volle elf
 * ertussen). Zo telt groei niet als seizoen: wie elk jaar 30% groeit, heeft in
 * december niet "30% meer seizoen" dan in januari. Een simpel gemiddelde per
 * kalenderjaar zou dat wel zeggen, en dan voorspelde de prognose elk jaar een
 * dip in januari en een piek in december die er niet is.
 *
 * Per kalendermaand het gemiddelde over de jaren, daarna zo geschaald dat
 * de twaalf samen precies twaalf maanden zijn: over een heel jaar verandert
 * het patroon de omzet niet, het verdeelt hem alleen.
 *
 * Het begint bij de eerste maand met omzet (een bedrijf dat in juni begon, had
 * geen rustige voorjaren) en heeft minstens twee jaar nodig: met één jaar is
 * een toevallige drukke maand niet van een seizoen te onderscheiden.
 */
export function computeSeasonality(inputs: ForecastInputs, today: string): SeasonalPattern {
  const last = addMonths(monthOfDate(today), -1);
  const byMonth = new Map(inputs.months.map((row) => [row.month, row]));
  const first = inputs.months.find((row) => row.month <= last && historyRevenueCents(row) > 0);
  const none = (reason: string, from: string | null = null, months = 0): SeasonalPattern => ({
    available: false, reason, from, to: from ? last : null, months, index: [...FLAT_SEASON], samples: FLAT_SEASON.map(() => 0),
  });
  if (!first) return none('Er is nog geen omzet om een seizoen uit te leren.');

  const n = monthsBetween(first.month, last) + 1;
  if (n < SEASON_MIN_MONTHS) {
    return none(`Een seizoenspatroon heeft minstens twee hele jaren omzet nodig; er zijn er nu ${n} ${n === 1 ? 'maand' : 'maanden'} (vanaf ${monthLabel(first.month)}).`, first.month, n);
  }

  const raw: number[] = [];
  for (let t = 0; t < n; t += 1) {
    const row = byMonth.get(addMonths(first.month, t));
    // Een maand met meer creditnota's dan facturen is geen "negatief seizoen".
    raw.push(row ? Math.max(0, historyRevenueCents(row)) : 0);
  }
  // Eén grote opdracht trekt ook het gemiddelde van de twaalf maanden eromheen
  // omhoog: dan leken alle maanden rond die opdracht "rustig". Met één maand
  // van twintig keer gewoon in twee jaar kwam die maand uit op bijna vijf keer
  // gewoon en de rest op 62%. Daarom eerst elke maand begrenzen op drie keer de
  // mediaan van de maanden met omzet. Wie twee keer per jaar factureert,
  // merkt daar niets van: zijn mediaan is zo'n factuur.
  const positive = raw.filter((value) => value > 0).sort((x, y) => x - y);
  const half = Math.floor(positive.length / 2);
  const median = positive.length % 2 === 1 ? positive[half] : (positive[half - 1] + positive[half]) / 2;
  const values = raw.map((value) => Math.min(value, median * SEASON_RATIO_CAP));

  const sums = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let t = 6; t + 6 < n; t += 1) {
    let trend = (values[t - 6] + values[t + 6]) / 2;
    for (let k = -5; k <= 5; k += 1) trend += values[t + k];
    trend /= 12;
    if (trend <= 0) continue;
    const cal = calendarMonth(addMonths(first.month, t));
    sums[cal] += Math.min(SEASON_RATIO_CAP, values[t] / trend);
    counts[cal] += 1;
  }
  if (counts.some((count) => count === 0)) {
    return none('In de vorige jaren zat te weinig omzet om per maand een patroon te zien.', first.month, n);
  }
  const perMonth = sums.map((sum, cal) => sum / counts[cal]);
  const mean = perMonth.reduce((total, value) => total + value, 0) / 12;
  if (mean <= 0) return none('In de vorige jaren zat te weinig omzet om per maand een patroon te zien.', first.month, n);
  return {
    available: true,
    reason: null,
    from: first.month,
    to: last,
    months: n,
    index: perMonth.map((value) => value / mean),
    samples: counts,
  };
}

/** De factor voor een maand bij een sterkte van 0 t/m 100%: 1 = geen effect. */
export function seasonFactor(pattern: SeasonalPattern, strengthPct: number, month: string): number {
  if (!pattern.available || strengthPct <= 0) return 1;
  return 1 + (strengthPct / 100) * (pattern.index[calendarMonth(month)] - 1);
}

/** "jan 82% · feb 90% · …": hoe druk elke maand is, een gemiddelde maand is 100%. */
export function seasonText(pattern: SeasonalPattern): string {
  if (!pattern.available) return pattern.reason ?? 'Geen seizoenspatroon.';
  return MONTH_SHORT.map((name, cal) => `${name} ${Math.round(pattern.index[cal] * 100)}%`).join(' · ');
}

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
  /** Het seizoen voor deze maand: 1 = gewoon, 1,2 = 20% drukker. */
  season_factor: number;
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
  seasonality_pct: number;
  /** Rekent de prognose echt met een seizoen (aan, én er is een patroon)? */
  season_applied: boolean;
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
  /** Het seizoenspatroon uit de vorige jaren (ook als het uit staat: om te laten zien). */
  season: SeasonalPattern;
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
 * - Seizoen (als het aanstaat): de nieuwe projecten en de overige omzet
 *   volgen de drukke en rustige maanden van de vorige jaren. Een maand met een
 *   eigen aantal projecten houdt dat aantal: wie "in juli 1 project" zegt,
 *   bedoelt 1.
 * - Kosten: vast (met de stijging per jaar), meegroeiend als deel van de
 *   omzet, en de extra posten. Geld erbij en eraf (cash_in, cash_out) telt
 *   hier niet: dat is geen omzet of kosten, alleen de cashflow ziet het.
 */
export function computeForecast(rawAssumptions: unknown, inputs: ForecastInputs, today: string): ForecastResult {
  const a = normalizeAssumptions(rawAssumptions);
  const baseline = computeBaseline(inputs, today);
  const season = computeSeasonality(inputs, today);
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
  const factorAt = (month: string): number => seasonFactor(season, a.seasonality_pct, month);

  const projectsAt = (offset: number): number => {
    const month = addMonths(start, offset);
    const set = a.month_projects[month];
    return set !== undefined ? set : projectsPerMonth * Math.pow(growth, offset) * factorAt(month);
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
    const factor = factorAt(month);
    const revenueOther = Math.round(otherCents * Math.pow(growth, t) * factor);
    let revenueItems = 0;
    let costItems = 0;
    for (const item of a.items) {
      if (!activeIn(item, month)) continue;
      if (item.kind === 'revenue') revenueItems += toCents(item.amount);
      else if (item.kind === 'cost') costItems += toCents(item.amount);
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
      month, projects, projects_set: a.month_projects[month] !== undefined, season_factor: factor,
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
      seasonality_pct: a.seasonality_pct,
      season_applied: season.available && a.seasonality_pct > 0,
    },
    baseline,
    months,
    totals: totalsOf(months.map((row) => ({ projects: row.projects, revenue_cents: row.revenue_cents, costs_cents: row.costs_cents, profit_cents: row.profit_cents }))),
    history,
    history_totals: totalsOf(history),
    so_far: soFar,
    pipeline: inputs.pipeline,
    season,
  };
}

// ── De cashflow: wat er op je rekening staat ───────────────────────────────

export type VatFrequency = 'monthly' | 'quarterly';

export interface CashBankAccount {
  name: string;
  /** Null: ResoFly weet het saldo van deze rekening niet. */
  balance_cents: number | null;
  /** 'statement': het laatste afschrift plus de regels daarna; 'ledger': de boekhouding plus wat nog niet geboekt is. */
  method: 'statement' | 'ledger' | null;
  as_of: string | null;
}

/** Openstaande posten die in één maand vervallen. */
export interface CashOpenBucket {
  month: string;
  cents: number;
  count: number;
}

export interface CashVatReturn {
  period_type: 'month' | 'quarter';
  year: number;
  index: number;
  status: string;
  /** Te betalen (positief) of terug (negatief), in hele euro's maar in centen. */
  saldo_cents: number;
}

export interface CashTaxPayment {
  date: string;
  cents: number;
}

/** Het antwoord van forecast_cash_position, gelezen. */
export interface CashPosition {
  /** False: de functie bestaat (nog) niet of gaf geen antwoord. */
  available: boolean;
  today: string;
  bank: CashBankAccount[];
  cash_accounts_cents: number;
  receivables: CashOpenBucket[];
  payables: CashOpenBucket[];
  vat_frequency: VatFrequency;
  kor: boolean;
  vat_returns: CashVatReturn[];
  tax_payments: CashTaxPayment[];
  payment_terms_days: number;
  collection_paid_count: number;
  /** Na hoeveel dagen klanten gemiddeld betaalden (naar bedrag gewogen), of null. */
  collection_days: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyCashPosition(today: string): CashPosition {
  return {
    available: false, today, bank: [], cash_accounts_cents: 0, receivables: [], payables: [],
    vat_frequency: 'quarterly', kor: false, vat_returns: [], tax_payments: [], payment_terms_days: 14,
    collection_paid_count: 0, collection_days: null,
  };
}

function bucketsOf(raw: unknown): CashOpenBucket[] {
  if (!Array.isArray(raw)) return [];
  const out: CashOpenBucket[] = [];
  for (const row of raw) {
    if (!isObject(row) || !isMonthKey(row.month)) continue;
    out.push({ month: row.month, cents: intOf(row.cents), count: intOf(row.count) });
  }
  return out.sort((x, y) => x.month.localeCompare(y.month));
}

/** Leest het antwoord van forecast_cash_position. Een ontbrekend getal telt als nul, nooit als NaN. */
export function parseCashPosition(raw: unknown, today: string): CashPosition {
  if (!isObject(raw)) return emptyCashPosition(today);
  const bank: CashBankAccount[] = [];
  if (Array.isArray(raw.bank)) {
    for (const row of raw.bank) {
      if (!isObject(row)) continue;
      const balance = readNumber(row.balance_cents);
      bank.push({
        name: cleanLabel(row.name) || 'Bankrekening',
        balance_cents: balance === null ? null : Math.round(balance),
        method: row.method === 'statement' || row.method === 'ledger' ? row.method : null,
        as_of: typeof row.as_of === 'string' && DATE_RE.test(row.as_of) ? row.as_of : null,
      });
    }
  }
  const returns: CashVatReturn[] = [];
  if (Array.isArray(raw.vat_returns)) {
    for (const row of raw.vat_returns) {
      if (!isObject(row) || (row.period_type !== 'month' && row.period_type !== 'quarter')) continue;
      returns.push({ period_type: row.period_type, year: intOf(row.year), index: intOf(row.index), status: String(row.status ?? ''), saldo_cents: intOf(row.saldo_cents) });
    }
  }
  const taxes: CashTaxPayment[] = [];
  if (Array.isArray(raw.tax_payments)) {
    for (const row of raw.tax_payments) {
      if (!isObject(row) || typeof row.date !== 'string' || !DATE_RE.test(row.date)) continue;
      taxes.push({ date: row.date, cents: intOf(row.cents) });
    }
  }
  const collection = isObject(raw.collection) ? raw.collection : {};
  const days = readNumber(collection.days);
  const terms = readNumber(raw.payment_terms_days);
  return {
    available: true,
    today: typeof raw.today === 'string' && DATE_RE.test(raw.today) ? raw.today : today,
    bank,
    cash_accounts_cents: intOf(raw.cash_accounts_cents),
    receivables: bucketsOf(raw.receivables),
    payables: bucketsOf(raw.payables),
    vat_frequency: raw.vat_frequency === 'monthly' ? 'monthly' : 'quarterly',
    kor: raw.kor === true,
    vat_returns: returns,
    tax_payments: taxes,
    payment_terms_days: terms === null ? 14 : Math.min(120, Math.max(1, Math.round(terms))),
    collection_paid_count: intOf(collection.paid_count),
    collection_days: days === null ? null : Math.min(365, Math.max(0, days)),
  };
}

/** Zoveel betaalde facturen zijn er nodig om het betaalgedrag te gebruiken; met minder telt de betaaltermijn. */
export const COLLECTION_MIN_INVOICES = 5;

/** Een maand telt hier als dertig dagen: 15 dagen betaaltermijn is een halve maand. */
const DAYS_PER_MONTH = 30;

/** Btw op je omzet als er nog niets gefactureerd is: het algemene tarief. */
const DEFAULT_VAT_SALES_PCT = 21;

export interface CashflowMonth {
  month: string;
  /** De lopende maand: vanaf vandaag. */
  partial: boolean;
  start_cents: number;
  /** Openstaande facturen die deze maand vervallen; in de lopende maand ook alles wat al te laat is. */
  in_open_cents: number;
  /** Nieuwe omzet met btw, als de klant betaalt. */
  in_sales_cents: number;
  /** Openstaande inkoopfacturen die deze maand vervallen. */
  out_open_cents: number;
  /** Kosten zonder afschrijvingen, met btw. */
  out_costs_cents: number;
  /** Naar de Belastingdienst (positief) of terug (negatief). */
  vat_cents: number;
  /** De btw-tijdvakken die deze maand betaald worden ("Q4 2026"). */
  vat_periods: string[];
  /** Geld erbij (positief) en eraf (negatief): leningen, privé, investeringen. */
  other_cents: number;
  net_cents: number;
  end_cents: number;
}

export interface CashVatPayment {
  period: string;
  month: string;
  cents: number;
  /** 'return': het saldo van een afgesloten aangifte in ResoFly; 'estimate': uitgerekend. */
  source: 'return' | 'estimate';
}

export type CollectionSource = 'set' | 'history' | 'terms';

export interface CashflowEffective {
  start_cents: number;
  start_auto: boolean;
  /** Is er een banksaldo: zelf ingevuld, of minstens één rekening of de kas bekend. */
  start_known: boolean;
  collection_days: number;
  collection_source: CollectionSource;
  vat_sales_pct: number;
  vat_sales_auto: boolean;
  vat_costs_pct: number;
  vat_costs_auto: boolean;
  noncash_cents: number;
  noncash_auto: boolean;
  buffer_cents: number;
  vat_frequency: VatFrequency;
  kor: boolean;
}

export interface CashflowTotals {
  in_cents: number;
  out_cents: number;
  vat_cents: number;
  other_cents: number;
  net_cents: number;
}

export interface CashflowResult {
  /** False: geen cashflow, met de reden. */
  available: boolean;
  reason: string | null;
  effective: CashflowEffective;
  bank: CashBankAccount[];
  cash_accounts_cents: number;
  /** Rekeningen waarvan ResoFly het saldo niet weet. */
  unknown_accounts: string[];
  months: CashflowMonth[];
  totals: CashflowTotals;
  /**
   * Het laagste saldo: nu (at_start) of aan het eind van een maand. Het saldo
   * van nu telt mee: anders zei de cashflow "laagste € 37.431" terwijl er nu
   * € 30.450 staat, omdat het die maand alleen maar beter wordt.
   */
  lowest: { month: string; cents: number; at_start: boolean } | null;
  end_cents: number;
  /** De eerste maand die eindigt onder de ondergrens (bij 0: onder nul). */
  below_buffer: string | null;
  open: {
    receivables_cents: number;
    receivables_overdue_cents: number;
    receivables_later_cents: number;
    payables_cents: number;
    payables_overdue_cents: number;
    payables_later_cents: number;
  };
  vat_payments: CashVatPayment[];
  notes: string[];
}

function vatPeriodLabel(type: 'month' | 'quarter', lastMonth: string): string {
  return type === 'quarter' ? `Q${Math.ceil(Number(lastMonth.slice(5, 7)) / 3)} ${lastMonth.slice(0, 4)}` : monthLabel(lastMonth);
}

/**
 * De effectieve waarden voor de cashflow: wat er ingevuld is, anders
 * automatisch. Los van computeCashflow, zodat het scherm "automatisch: 23
 * dagen" kan tonen ook als de cashflow er (nog) niet is.
 */
export function cashflowEffective(result: ForecastResult, cash: CashPosition): CashflowEffective {
  const a = result.assumptions;
  const known = cash.bank.filter((account) => account.balance_cents !== null);
  const autoStart = known.reduce((total, account) => total + (account.balance_cents ?? 0), 0) + cash.cash_accounts_cents;
  const autoKnown = known.length > 0 || cash.cash_accounts_cents !== 0;
  let collectionDays: number;
  let collectionSource: CollectionSource;
  if (a.collection_days !== null) { collectionDays = a.collection_days; collectionSource = 'set'; }
  else if (cash.collection_paid_count >= COLLECTION_MIN_INVOICES && cash.collection_days !== null) {
    collectionDays = Math.round(cash.collection_days);
    collectionSource = 'history';
  } else { collectionDays = cash.payment_terms_days; collectionSource = 'terms'; }
  return {
    start_cents: a.cash_start !== null ? toCents(a.cash_start) : autoStart,
    start_auto: a.cash_start === null,
    start_known: a.cash_start !== null || autoKnown,
    collection_days: collectionDays,
    collection_source: collectionSource,
    // Met de KOR reken je geen btw en trek je niets af: de btw op je inkoop
    // is dan kosten (zo boekt ResoFly hem ook), dus hier 0.
    vat_sales_pct: a.vat_sales_pct ?? (cash.kor ? 0 : (result.baseline.vat_sales_pct ?? DEFAULT_VAT_SALES_PCT)),
    vat_sales_auto: a.vat_sales_pct === null,
    vat_costs_pct: a.vat_costs_pct ?? (cash.kor ? 0 : (result.baseline.vat_costs_pct ?? 0)),
    vat_costs_auto: a.vat_costs_pct === null,
    noncash_cents: a.noncash_costs !== null ? toCents(a.noncash_costs) : result.baseline.noncash_cents,
    noncash_auto: a.noncash_costs === null,
    buffer_cents: toCents(a.cash_buffer),
    vat_frequency: cash.vat_frequency,
    kor: cash.kor,
  };
}

/**
 * De cashflow: per maand wat er binnenkomt en uitgaat, en het saldo. Van
 * vandaag tot het eind van de prognose; de lopende maand is de eerste en telt
 * vanaf vandaag.
 *
 * - Begin: het banksaldo (zelf ingevuld, of de bankrekeningen en de kas).
 * - Klanten: openstaande facturen op hun vervaldatum (te laat: deze maand),
 *   en de omzet van de prognose met btw, betaald na `collection_days`: bij 15
 *   dagen komt de helft in de maand van de factuur en de helft een maand later.
 *   Van de lopende maand telt alleen wat nog gefactureerd moet worden; wat er
 *   al gefactureerd is, staat bij de openstaande facturen of is al betaald.
 * - Kosten: zonder afschrijvingen (die gaan niet van je rekening), met btw,
 *   betaald in hun maand; openstaande inkoopfacturen op hun vervaldatum. Ook
 *   hier van de lopende maand alleen wat er nog bij komt.
 * - Btw: per tijdvak (maand of kwartaal, uit de bedrijfsgegevens), betaald in
 *   de maand erna. Een afgesloten of ingediende aangifte telt met haar saldo,
 *   een betaalde niet; voor de rest de btw van de facturen en inkoop die er al
 *   zijn plus die van de prognose. Een tijdvak waarvan de betaalmaand voorbij
 *   is, is betaald. Ging er na afloop van het tijdvak al geld naar de
 *   Belastingdienst, dan ook: dat staat al in het banksaldo, en twee keer
 *   aftrekken zou een tekort voorspellen dat er niet is.
 * - Geld erbij en eraf (posten cash_in en cash_out) in hun maanden.
 */
export function computeCashflow(result: ForecastResult, inputs: ForecastInputs, cash: CashPosition, today: string): CashflowResult {
  const current = monthOfDate(today);
  const effective = cashflowEffective(result, cash);
  const unknownAccounts = cash.bank.filter((account) => account.balance_cents === null).map((account) => account.name);
  const empty = (reason: string): CashflowResult => ({
    available: false, reason, effective, bank: cash.bank, cash_accounts_cents: cash.cash_accounts_cents, unknown_accounts: unknownAccounts,
    months: [], totals: { in_cents: 0, out_cents: 0, vat_cents: 0, other_cents: 0, net_cents: 0 },
    lowest: null, end_cents: effective.start_cents, below_buffer: null,
    open: { receivables_cents: 0, receivables_overdue_cents: 0, receivables_later_cents: 0, payables_cents: 0, payables_overdue_cents: 0, payables_later_cents: 0 },
    vat_payments: [], notes: [],
  });
  if (!cash.available) return empty('De cashflow staat in deze omgeving nog niet aan: de database wordt nog bijgewerkt.');
  const { start_month: start, end_month: end } = result.effective;
  if (start > current) {
    return empty(`De cashflow rekent vanaf vandaag, en deze prognose begint pas in ${monthLabel(start)}. Laat hem deze maand beginnen om de cashflow te zien.`);
  }
  if (end < current) return empty('Deze prognose is al afgelopen; de cashflow rekent vanaf vandaag.');

  const count = monthsBetween(current, end) + 1;
  const index = (month: string) => monthsBetween(current, month);
  const byForecast = new Map(result.months.map((row) => [row.month, row]));
  const byHistory = new Map(inputs.months.map((row) => [row.month, row]));
  const actualNow = byHistory.get(current);

  // Wat er per maand nog gefactureerd wordt en aan kosten bij komt, zonder btw.
  const billedAt = (month: string): number => {
    const row = byForecast.get(month);
    if (!row) return 0;
    if (month === current) return Math.max(0, row.revenue_cents - (actualNow ? historyRevenueCents(actualNow) : 0));
    return row.revenue_cents;
  };
  const cashCostsAt = (month: string): number => {
    const row = byForecast.get(month);
    if (!row) return 0;
    const full = Math.max(0, row.costs_cents - effective.noncash_cents);
    if (month === current) return Math.max(0, full - (actualNow ? historyCashCostsCents(actualNow) : 0));
    return full;
  };

  const inOpen = new Array<number>(count).fill(0);
  const inSales = new Array<number>(count).fill(0);
  const outOpen = new Array<number>(count).fill(0);
  const outCosts = new Array<number>(count).fill(0);
  const vat = new Array<number>(count).fill(0);
  const vatPeriods: string[][] = Array.from({ length: count }, () => []);
  const other = new Array<number>(count).fill(0);
  const open = { receivables_cents: 0, receivables_overdue_cents: 0, receivables_later_cents: 0, payables_cents: 0, payables_overdue_cents: 0, payables_later_cents: 0 };

  for (const bucket of cash.receivables) {
    const at = Math.max(0, index(bucket.month));
    if (bucket.month < current) open.receivables_overdue_cents += bucket.cents;
    if (at < count) { inOpen[at] += bucket.cents; open.receivables_cents += bucket.cents; }
    else open.receivables_later_cents += bucket.cents;
  }
  for (const bucket of cash.payables) {
    const at = Math.max(0, index(bucket.month));
    if (bucket.month < current) open.payables_overdue_cents += bucket.cents;
    if (at < count) { outOpen[at] += bucket.cents; open.payables_cents += bucket.cents; }
    else open.payables_later_cents += bucket.cents;
  }

  // Klanten betalen na `collection_days`: een deel nog in de maand van de
  // factuur, de rest een (of meer) maand later. Facturen liggen gemiddeld
  // gelijk verdeeld over de maand; bij 15 dagen is dat half om half.
  const shift = effective.collection_days / DAYS_PER_MONTH;
  const whole = Math.floor(shift);
  const part = shift - whole;
  for (let t = 0; t < count; t += 1) {
    const billed = billedAt(addMonths(current, t)) * (1 + effective.vat_sales_pct / 100);
    if (billed === 0) continue;
    if (t + whole < count) inSales[t + whole] += billed * (1 - part);
    if (part > 0 && t + whole + 1 < count) inSales[t + whole + 1] += billed * part;
  }
  for (let t = 0; t < count; t += 1) {
    outCosts[t] = cashCostsAt(addMonths(current, t)) * (1 + effective.vat_costs_pct / 100);
  }

  // De btw van één maand: wat er al is (facturen en inkoop), plus wat de
  // prognose er nog bij verwacht.
  const vatOfMonth = (month: string): number => {
    const row = byHistory.get(month);
    const known = row ? historyVatOutCents(row) - historyVatInCents(row) : 0;
    if (month < current) return known;
    const expected = (billedAt(month) * effective.vat_sales_pct - cashCostsAt(month) * effective.vat_costs_pct) / 100;
    return month === current ? known + expected : expected;
  };
  const payments: CashVatPayment[] = [];
  const notes: string[] = [];
  if (!effective.kor) {
    const type: 'month' | 'quarter' = effective.vat_frequency === 'monthly' ? 'month' : 'quarter';
    for (let t = 0; t < count; t += 1) {
      const due = addMonths(current, t);
      const lastMonth = addMonths(due, -1);
      const mon = Number(lastMonth.slice(5, 7));
      if (type === 'quarter' && mon % 3 !== 0) continue;
      const firstMonth = type === 'quarter' ? addMonths(lastMonth, -2) : lastMonth;
      const year = Number(lastMonth.slice(0, 4));
      const periodIndex = type === 'quarter' ? mon / 3 : mon;
      const label = vatPeriodLabel(type, lastMonth);
      const filed = cash.vat_returns.find((row) => row.period_type === type && row.year === year && row.index === periodIndex);
      if (filed && filed.status === 'paid') continue;
      // Deze maand betalen, en er ging na afloop van het tijdvak al geld naar
      // de Belastingdienst: dan is het (meestal) deze btw, en die zit al in het
      // banksaldo. Ook als de aangifte in ResoFly nog niet op betaald staat:
      // die gaat pas op betaald als de bankregel geboekt is.
      if (t === 0 && cash.tax_payments.some((payment) => payment.date > `${lastMonth}-31`)) {
        notes.push(`De btw over ${label} staat er niet in: na afloop van dat tijdvak ging er al geld naar de Belastingdienst, en dat zit in je banksaldo.`);
        continue;
      }
      if (filed && (filed.status === 'finalized' || filed.status === 'filed')) {
        vat[t] += filed.saldo_cents;
        vatPeriods[t].push(label);
        payments.push({ period: label, month: due, cents: filed.saldo_cents, source: 'return' });
        continue;
      }
      let amount = 0;
      for (let month = firstMonth; month <= lastMonth; month = addMonths(month, 1)) amount += vatOfMonth(month);
      const cents = Math.round(amount);
      vat[t] += cents;
      vatPeriods[t].push(label);
      payments.push({ period: label, month: due, cents, source: 'estimate' });
    }
    // Een aangifte waarvan de betaalmaand voorbij is maar die nog niet als
    // betaald staat: niet in de cijfers (de meeste zijn gewoon betaald buiten
    // de bank van ResoFly om), wel als vraag.
    for (const row of cash.vat_returns) {
      if (row.status !== 'finalized' && row.status !== 'filed') continue;
      const lastMonth = row.period_type === 'quarter' ? `${row.year}-${String(row.index * 3).padStart(2, '0')}` : `${row.year}-${String(row.index).padStart(2, '0')}`;
      if (!isMonthKey(lastMonth) || addMonths(lastMonth, 1) >= current || row.saldo_cents <= 0) continue;
      notes.push(`De btw-aangifte over ${vatPeriodLabel(row.period_type, lastMonth)} (${wholeEuroText(row.saldo_cents)}) staat in ResoFly nog niet als betaald. Al betaald? Dan klopt het. Zo niet, zet hem als geld eraf erbij.`);
    }
  }

  for (const item of result.assumptions.items) {
    if (!isCashItem(item.kind)) continue;
    const cents = toCents(item.amount) * (item.kind === 'cash_in' ? 1 : -1);
    for (let t = 0; t < count; t += 1) if (activeIn(item, addMonths(current, t))) other[t] += cents;
  }

  const months: CashflowMonth[] = [];
  let balance = effective.start_cents;
  const totals: CashflowTotals = { in_cents: 0, out_cents: 0, vat_cents: 0, other_cents: 0, net_cents: 0 };
  let lowest: { month: string; cents: number; at_start: boolean } = { month: current, cents: balance, at_start: true };
  let belowBuffer: string | null = balance < effective.buffer_cents ? current : null;
  for (let t = 0; t < count; t += 1) {
    const month = addMonths(current, t);
    const row = {
      in_open_cents: Math.round(inOpen[t]),
      in_sales_cents: Math.round(inSales[t]),
      out_open_cents: Math.round(outOpen[t]),
      out_costs_cents: Math.round(outCosts[t]),
      vat_cents: Math.round(vat[t]),
      other_cents: Math.round(other[t]),
    };
    const net = row.in_open_cents + row.in_sales_cents - row.out_open_cents - row.out_costs_cents - row.vat_cents + row.other_cents;
    const startOfMonth = balance;
    balance += net;
    months.push({ month, partial: t === 0, start_cents: startOfMonth, ...row, vat_periods: vatPeriods[t], net_cents: net, end_cents: balance });
    totals.in_cents += row.in_open_cents + row.in_sales_cents;
    totals.out_cents += row.out_open_cents + row.out_costs_cents;
    totals.vat_cents += row.vat_cents;
    totals.other_cents += row.other_cents;
    totals.net_cents += net;
    if (balance < lowest.cents) lowest = { month, cents: balance, at_start: false };
    if (belowBuffer === null && balance < effective.buffer_cents) belowBuffer = month;
  }

  if (!effective.start_known) {
    notes.unshift('ResoFly weet je banksaldo niet: vul het in bij de aannames. Nu rekent de cashflow vanaf € 0, en zegt het saldo alleen hoeveel er bij of af gaat.');
  } else if (effective.start_auto && unknownAccounts.length > 0) {
    notes.unshift(`Van ${unknownAccounts.join(', ')} weet ResoFly het saldo niet; die tellen niet mee. Lees een afschrift met eindsaldo in, of vul je banksaldo zelf in.`);
  }
  if (open.receivables_overdue_cents > 0) {
    notes.push(`${wholeEuroText(open.receivables_overdue_cents)} aan facturen is al te laat; dat staat in ${monthLabel(current)}, alsof het nu binnenkomt.`);
  }
  if (effective.kor) notes.push('Met de KOR reken je geen btw en trek je niets af: er gaat geen btw naar de Belastingdienst.');
  if (!inputs.cash_fields) notes.push('De btw van de maanden die al voorbij zijn, is nog niet bekend; de btw-betalingen kunnen te laag zijn.');

  return {
    available: true,
    reason: null,
    effective,
    bank: cash.bank,
    cash_accounts_cents: cash.cash_accounts_cents,
    unknown_accounts: unknownAccounts,
    months,
    totals,
    lowest,
    end_cents: balance,
    below_buffer: effective.start_known ? belowBuffer : null,
    open,
    vat_payments: payments,
    notes,
  };
}

/** "Saldo nu € 12.000; laagste € 3.400 eind maart 2027; eind december 2027 € 18.900." */
export function summarizeCashflow(flow: CashflowResult): string {
  if (!flow.available) return flow.reason ?? 'Geen cashflow.';
  const start = flow.effective.start_known ? `Saldo nu ${wholeEuroText(flow.effective.start_cents)}` : 'Saldo nu onbekend (gerekend vanaf € 0)';
  const lowest = !flow.lowest ? '' : flow.lowest.at_start ? ', daarna niet lager' : `; laagste ${wholeEuroText(flow.lowest.cents)} eind ${monthLabel(flow.lowest.month)}`;
  const last = flow.months[flow.months.length - 1];
  const end = last ? `; eind ${monthLabel(last.month)} ${wholeEuroText(flow.end_cents)}` : '';
  const vat = flow.totals.vat_cents !== 0 ? `; btw naar de Belastingdienst ${wholeEuroText(flow.totals.vat_cents)}` : '';
  return `${start}${lowest}${end}${vat}.`;
}

/** Waar de waarden van de cashflow vandaan komen, als regels. */
export function describeCashflow(flow: CashflowResult): string[] {
  const e = flow.effective;
  const auto = (flag: boolean) => (flag ? ' (automatisch)' : '');
  const collection = e.collection_source === 'set' ? '' : e.collection_source === 'history' ? ' (automatisch: hoe snel je klanten betaalden)' : ' (automatisch: je betaaltermijn)';
  const lines = [
    `Banksaldo nu: ${e.start_known ? wholeEuroText(e.start_cents) : 'onbekend'}${auto(e.start_auto)}`,
    `Klanten betalen na: ${fieldValueText('collection_days', e.collection_days)}${collection}`,
    `Btw op je omzet: ${pctText(e.vat_sales_pct)}${auto(e.vat_sales_auto)}`,
    `Btw op je kosten: ${pctText(e.vat_costs_pct)}${auto(e.vat_costs_auto)}`,
    `Afschrijvingen per maand (geen geld): ${wholeEuroText(e.noncash_cents)}${auto(e.noncash_auto)}`,
    `Btw-aangifte: ${e.kor ? 'geen (KOR)' : e.vat_frequency === 'monthly' ? 'per maand' : 'per kwartaal'}`,
  ];
  if (e.buffer_cents > 0) lines.push(`Ondergrens saldo: ${wholeEuroText(e.buffer_cents)}`);
  return lines;
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
  lines.push(`Seizoenspatroon: ${fieldValueText('seasonality_pct', a.seasonality_pct)}${a.seasonality_pct > 0 && !result.season.available ? ` (er is nog geen patroon: ${result.season.reason})` : ''}`);
  for (const field of FORECAST_FIELDS) {
    if (field.group !== 'cash') continue;
    const value = (a as unknown as Record<string, number | null>)[field.key];
    // Alleen wat iemand zelf invulde; de automatische waarden staan bij de cashflow.
    if (value === null || (field.key === 'cash_buffer' && value === 0)) continue;
    lines.push(`${field.label}: ${fieldValueText(field.key, value)}`);
  }
  for (const [month, count] of Object.entries(a.month_projects)) {
    lines.push(`${capitalize(monthLabel(month))}: ${numberText(count, 2)} ${count === 1 ? 'nieuw project' : 'nieuwe projecten'}`);
  }
  for (const item of a.items) lines.push(`Extra post (${item.id}) ${itemText(item)}`);
  return lines;
}
