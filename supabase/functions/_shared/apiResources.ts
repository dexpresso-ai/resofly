// ============================================================
// Vaste adressen in de openbare API: klanten, contactpersonen, projecten,
// taken, tickets (met reacties) en uren als gewone REST-resources.
//
// WAAROM NAAST DE HANDELINGEN
// Met /v1/actions kan een koppeling alles wat de app kan. Maar een webshop die
// een klant aanmaakt, of een koppelplatform met de stap "Find client", wil een
// vast adres met een vaste vorm: GET /v1/clients?q=jansen, POST /v1/clients,
// PATCH /v1/clients/{id}. Dat is wat hier staat — voor de zeven onderwerpen
// waar koppelingen het vaakst mee werken.
//
// WAT HIER STAAT, EN WAT NIET
// BEWUST PUUR, net als publicApi.ts en webhooks.ts: geen Deno, geen database.
// Per resource welke velden er zijn, welke je mag zetten, welke filters er
// bestaan — en de controle van de invoer. Daardoor draait `npm test` er
// rechtstreeks overheen (apiResources.test.ts), en is dit tegelijk de bron voor
// het OpenAPI-document: wat hier staat, staat daar.
//
// Het WEGSCHRIJVEN gebeurt niet hier en niet met de service-role, maar in de
// database zelf (api_rest_write, migratie 20261003020000): onder de naam van
// het teamlid achter de sleutel, met dezelfde RLS, dezelfde triggers en
// hetzelfde auditlog als een wijziging in de app.
// ============================================================

import type { ModuleKey } from './publicApi.ts';

// ── Velden ───────────────────────────────────────────────────────────────────

export type FieldType =
  | 'text' | 'email' | 'uuid' | 'date' | 'datetime' | 'time' | 'color'
  | 'integer' | 'number' | 'boolean' | 'enum' | 'text_array' | 'object';

export interface FieldSpec {
  type: FieldType;
  description: string;
  /** Staat in het antwoord, maar is geen invoer (id, tijden, afgeleide velden). */
  readOnly?: boolean;
  /** Verplicht bij aanmaken. */
  required?: boolean;
  /** Alleen bij aanmaken te zetten, daarna vast (bijvoorbeeld het ticket van een reactie). */
  createOnly?: boolean;
  /** Mag leeg (null). */
  nullable?: boolean;
  values?: readonly string[];
  /** Bij een enum: de waarden die je zelf mag zetten, als dat er minder zijn dan `values`. */
  inputValues?: readonly string[];
  maxLength?: number;
  /** Bij een lijst: hoeveel items hooguit. */
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  /** Een id van een andere resource; moet in dezelfde organisatie bestaan. */
  references?: ResourceName;
  /** Standaardwaarde zoals de app hem zet; alleen voor de documentatie. */
  default?: unknown;
  /**
   * Het veld hoort (ook) bij een andere module, zoals een tarief bij
   * Financiën. Wie die module niet mag lezen, krijgt het veld als null; wie er
   * niet mag schrijven, kan het niet zetten.
   */
  module?: ModuleKey;
}

export interface FilterSpec {
  /** De kolom waarop gefilterd wordt. */
  column: string;
  /** eq: gelijk aan · gte/lte: vanaf/tot en met · eq_bool: true/false. */
  op: 'eq' | 'gte' | 'lte' | 'eq_bool';
  type: 'uuid' | 'enum' | 'date' | 'datetime' | 'boolean' | 'text';
  values?: readonly string[];
  description: string;
  /** De waarde in kleine letters vergelijken (e-mailadressen staan zo opgeslagen). */
  lowercase?: boolean;
}

export type ResourceName = 'clients' | 'contacts' | 'projects' | 'tasks' | 'tickets' | 'ticket_notes' | 'time_entries';

export interface ResourceSpec {
  name: ResourceName;
  /** Het pad onder /v1: `clients`, of voor reacties `tickets/{ticket_id}/notes`. */
  path: string;
  table: string;
  module: ModuleKey;
  /** Enkelvoud voor schema's en zinnen: `Client`, `klant`. */
  schemaName: string;
  label: string;
  labelPlural: string;
  /** De gebeurtenis-prefix in webhooks (`client` → client.created). */
  event: string;
  fields: Record<string, FieldSpec>;
  filters: Record<string, FilterSpec>;
  /** Kolommen waarin `q` zoekt. */
  search: readonly string[];
  /** Toegestane sortering; de eerste is de standaard (`-` = aflopend). */
  sort: readonly string[];
  /** Een resource onder een andere: reacties horen bij een ticket. */
  parent?: { resource: ResourceName; column: string; param: string };
  /** Welke bewegingen er zijn. Verwijderen bewust nergens: dat gaat via de app. */
  create: boolean;
  update: boolean;
  /** Waarden die de API bij aanmaken invult als de aanroeper ze weglaat (veilige keuze, niet die van de database). */
  createDefaults?: Record<string, unknown>;
  /**
   * Regels over meer velden tegelijk, op de genormaliseerde invoer. Mag de
   * invoer aanvullen (een veld dat logisch mee moet) of een ResourceInputError
   * gooien. Wat van de bestaande rij afhangt, bewaakt de database.
   */
  refine?: (values: Record<string, unknown>, mode: 'create' | 'update') => void;
}

// ── Invoer ───────────────────────────────────────────────────────────────────

/** Invoer die niet klopt. Wordt een 422 met `field` in de details. */
export class ResourceInputError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ResourceInputError';
    this.field = field;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Een geldige kalenderdatum in de vorm YYYY-MM-DD (geen 31 februari). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Welke velden de aanroeper mag zetten, bij aanmaken of wijzigen. */
export function writableFields(spec: ResourceSpec, mode: 'create' | 'update'): string[] {
  return Object.entries(spec.fields)
    .filter(([, field]) => !field.readOnly && (mode === 'create' || !field.createOnly))
    .map(([name]) => name);
}

/**
 * Controleert en normaliseert de invoer voor aanmaken of wijzigen.
 *
 * Streng met opzet: een onbekend veld is een fout en geen stilte. Een
 * koppeling die `emial` stuurt, hoort te horen dat er niets met dat veld
 * gebeurt — niet een klant zonder mailadres te krijgen en het pas weken later
 * te merken.
 */
export function normalizeInput(
  spec: ResourceSpec, input: Record<string, unknown>, mode: 'create' | 'update',
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ResourceInputError('Stuur een JSON-object met de velden.');
  }
  const allowed = new Set(writableFields(spec, mode));
  const values: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(input)) {
    // Object.hasOwn: "constructor" of "toString" zijn geen velden, ook al
    // bestaan ze op elk object.
    const field = Object.hasOwn(spec.fields, name) ? spec.fields[name] : undefined;
    if (!field) {
      throw new ResourceInputError(
        `Onbekend veld "${name}". Velden die je kunt zetten: ${[...allowed].join(', ')}.`, name);
    }
    if (field.readOnly) throw new ResourceInputError(`"${name}" kun je niet zelf zetten; dat doet ResoFly.`, name);
    if (!allowed.has(name)) throw new ResourceInputError(`"${name}" ligt vast na het aanmaken.`, name);
    values[name] = normalizeValue(name, field, raw);
  }

  if (mode === 'create') {
    for (const [name, value] of Object.entries(spec.createDefaults ?? {})) {
      if (values[name] === undefined) values[name] = value;
    }
    const missing = Object.entries(spec.fields)
      .filter(([name, field]) => field.required && (values[name] === undefined || values[name] === null))
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new ResourceInputError(
        `Verplicht bij een nieuwe ${spec.label.toLowerCase()}: ${missing.join(', ')}.`, missing[0]);
    }
  } else if (Object.keys(values).length === 0) {
    throw new ResourceInputError(`Er valt niets te wijzigen. Velden die je kunt zetten: ${[...allowed].join(', ')}.`);
  }
  spec.refine?.(values, mode);
  return values;
}

function normalizeValue(name: string, field: FieldSpec, raw: unknown): unknown {
  if (raw === null || (typeof raw === 'string' && raw.trim() === '' && field.type !== 'text')) {
    if (field.nullable) return null;
    throw new ResourceInputError(`"${name}" mag niet leeg zijn.`, name);
  }
  const fail = (what: string): never => {
    throw new ResourceInputError(`"${name}" moet ${what} zijn.`, name);
  };

  switch (field.type) {
    case 'text': {
      if (typeof raw !== 'string' && typeof raw !== 'number') fail('tekst');
      const text = String(raw).replace(/\r\n/g, '\n').trim();
      if (!text) {
        if (field.nullable) return null;
        throw new ResourceInputError(`"${name}" mag niet leeg zijn.`, name);
      }
      if (field.maxLength && text.length > field.maxLength) fail(`hooguit ${field.maxLength} tekens`);
      return text;
    }
    case 'email': {
      const email = String(raw).trim().toLowerCase();
      if (!EMAIL.test(email) || email.length > 320) fail('een geldig e-mailadres');
      return email;
    }
    case 'uuid': {
      const id = String(raw).trim().toLowerCase();
      if (!UUID.test(id)) fail('een id (uuid)');
      return id;
    }
    case 'date': {
      const date = String(raw).trim();
      if (!isIsoDate(date)) fail('een datum als JJJJ-MM-DD');
      return date;
    }
    case 'datetime': {
      const text = String(raw).trim();
      // Met tijdzone, zodat 09:00 niet stilletjes 09:00 UTC wordt.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
        fail('een tijdstip in ISO 8601 met tijdzone, zoals 2026-10-03T09:00:00+02:00');
      }
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) fail('een bestaand tijdstip');
      return date.toISOString();
    }
    case 'color': {
      const color = String(raw).trim();
      if (!/^#[0-9a-f]{6}$/i.test(color)) fail('een kleur als #RRGGBB');
      return color.toUpperCase();
    }
    case 'time': {
      const text = String(raw).trim();
      const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/);
      if (!match) fail('een tijd als UU:MM');
      return `${match![1]}:${match![2]}`;
    }
    case 'integer':
    case 'number': {
      // Een getal, of een tekst die er een is in gewone notatie ("87,50" mag;
      // "0x3C" of "6e1" niet: dat is geen bedrag of aantal dat iemand bedoelt).
      const text = typeof raw === 'string' ? raw.trim().replace(',', '.') : '';
      const value = typeof raw === 'number' ? raw : (/^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN);
      if (!Number.isFinite(value)) fail(field.type === 'integer' ? 'een geheel getal' : 'een getal');
      if (field.type === 'integer' && !Number.isInteger(value)) fail('een geheel getal');
      if (field.minimum !== undefined && value < field.minimum) fail(`minstens ${field.minimum}`);
      if (field.maximum !== undefined && value > field.maximum) fail(`hooguit ${field.maximum}`);
      return value;
    }
    case 'boolean': {
      if (raw === true || raw === 'true') return true;
      if (raw === false || raw === 'false') return false;
      return fail('true of false');
    }
    case 'enum': {
      const value = String(raw).trim();
      const allowed = field.inputValues ?? field.values ?? [];
      if (!allowed.includes(value)) fail(`een van deze zijn: ${allowed.join(', ')}`);
      return value;
    }
    case 'text_array': {
      if (!Array.isArray(raw)) fail('een lijst met teksten');
      if ((raw as unknown[]).some((item) => item !== null && typeof item !== 'string' && typeof item !== 'number')) {
        fail('een lijst met teksten');
      }
      const items = [...new Set((raw as unknown[]).map((item) => String(item ?? '').trim()).filter(Boolean))];
      const maxItems = field.maxItems ?? 50;
      if (items.length > maxItems) fail(`een lijst van hooguit ${maxItems}`);
      if (items.some((item) => item.length > (field.maxLength ?? 60))) fail(`een lijst met teksten van hooguit ${field.maxLength ?? 60} tekens`);
      return items;
    }
    case 'object': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('een object');
      if (JSON.stringify(raw).length > 20_000) fail('kleiner dan 20 kB');
      return raw;
    }
  }
}

// ── Lijsten ──────────────────────────────────────────────────────────────────

export interface ListParams {
  /** `in`: een van deze waarden (een enum-filter met komma's, zoals ?status=new,review). */
  filters: Array<{ column: string; op: FilterSpec['op'] | 'in'; value: string | boolean | string[] }>;
  q: string | null;
  sort: { column: string; ascending: boolean };
  limit: number;
  offset: number;
}

/** Zo ver mag je bladeren; daarna filters of updated_since. */
export const MAX_OFFSET = 10_000;

/** Filters die elke resource heeft: wat er sinds een moment veranderde of bijkwam. */
export const COMMON_FILTERS: Record<string, FilterSpec> = {
  updated_since: { column: 'updated_at', op: 'gte', type: 'datetime', description: 'Alleen wat sinds dit tijdstip is gewijzigd (ISO 8601). Handig om bij te houden wat er veranderde.' },
  created_since: { column: 'created_at', op: 'gte', type: 'datetime', description: 'Alleen wat sinds dit tijdstip is aangemaakt (ISO 8601).' },
};

/** De filters van één resource, plus de gemeenschappelijke voor zover die kolom er is. */
export function filtersOf(spec: ResourceSpec): Record<string, FilterSpec> {
  const common = Object.fromEntries(Object.entries(COMMON_FILTERS).filter(([, filter]) => filter.column in spec.fields));
  return { ...common, ...spec.filters };
}

/**
 * Leest ?q=, de filters, ?sort=, ?limit= en ?offset=. Een onbekende parameter
 * is een fout, om dezelfde reden als een onbekend veld bij het aanmaken: een
 * filter dat stilletjes niets doet, geeft een lijst die er goed uitziet en
 * niet klopt.
 */
export function parseListParams(spec: ResourceSpec, params: URLSearchParams): ListParams {
  const filters = filtersOf(spec);
  const known = new Set(['q', 'sort', 'limit', 'offset', ...Object.keys(filters)]);
  for (const key of params.keys()) {
    if (!known.has(key)) {
      throw new ResourceInputError(`Onbekende parameter "${key}". Wat kan: ${[...known].join(', ')}.`, key);
    }
  }

  const result: ListParams = {
    filters: [],
    q: null,
    sort: parseSort(spec, params.get('sort')),
    limit: clamp(params.get('limit'), 1, 100, 25),
    offset: clamp(params.get('offset'), 0, Number.MAX_SAFE_INTEGER, 0),
  };
  // Verder bladeren dan dit wordt traag en is zelden wat iemand wil. Stil
  // afkappen gaf eindeloos dezelfde pagina terug; nu een fout met een uitweg.
  if (result.offset > MAX_OFFSET) {
    throw new ResourceInputError(
      `Bladeren kan tot offset ${MAX_OFFSET}. Haal minder tegelijk op met filters, of houd bij wat er veranderde met updated_since.`, 'offset');
  }

  const q = (params.get('q') || '').trim();
  if (q) {
    if (spec.search.length === 0) throw new ResourceInputError('Zoeken met q kan hier niet.', 'q');
    // Tekens die in een PostgREST-filter iets betekenen, gaan eruit: zoeken is
    // zoeken, geen manier om een eigen filter mee te smokkelen.
    result.q = q.replace(/[,()*%\\"\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || null;
  }

  for (const [name, filter] of Object.entries(filters)) {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') continue;
    // Bij een keuzelijst mag je er meer tegelijk vragen: ?status=new,review.
    if (filter.type === 'enum' && filter.op === 'eq' && raw.includes(',')) {
      const values = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
      result.filters.push({ column: filter.column, op: 'in', value: values.map((value) => String(parseFilterValue(name, filter, value))) });
      continue;
    }
    result.filters.push({ column: filter.column, op: filter.op, value: parseFilterValue(name, filter, raw.trim()) });
  }
  return result;
}

function parseFilterValue(name: string, filter: FilterSpec, raw: string): string | boolean {
  const fail = (what: string): never => {
    throw new ResourceInputError(`Filter "${name}" moet ${what} zijn.`, name);
  };
  switch (filter.type) {
    case 'uuid': return isUuid(raw) ? raw.toLowerCase() : fail('een id (uuid)');
    case 'enum': return filter.values?.includes(raw) ? raw : fail(`een van deze zijn: ${filter.values?.join(', ')}`);
    case 'date': return isIsoDate(raw) ? raw : fail('een datum als JJJJ-MM-DD');
    case 'datetime': {
      const date = new Date(raw);
      return /^\d{4}-\d{2}-\d{2}/.test(raw) && !Number.isNaN(date.getTime()) ? date.toISOString() : fail('een tijdstip in ISO 8601');
    }
    case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : fail('true of false');
    case 'text': {
      if (/[\u0000-\u001f\u007f]/.test(raw)) return fail('tekst zonder stuurtekens');
      return filter.lowercase ? raw.slice(0, 200).toLowerCase() : raw.slice(0, 200);
    }
  }
}

function parseSort(spec: ResourceSpec, raw: string | null): { column: string; ascending: boolean } {
  const value = (raw || spec.sort[0]).trim();
  if (!spec.sort.includes(value)) {
    throw new ResourceInputError(`Sorteren kan op: ${spec.sort.join(', ')} (met - ervoor voor aflopend).`, 'sort');
  }
  return value.startsWith('-') ? { column: value.slice(1), ascending: false } : { column: value, ascending: true };
}

function clamp(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

// ── Antwoorden ───────────────────────────────────────────────────────────────

/** De kolommen die een resource naar buiten laat zien — en geen andere. */
export function selectColumns(spec: ResourceSpec): string {
  return Object.keys(spec.fields).join(', ');
}

/**
 * Alleen de velden uit de spec, in de volgorde van de spec. Een veld dat bij
 * een module hoort die de aanroeper niet mag lezen (een tarief bij Financiën),
 * komt terug als null.
 */
export function presentRow(
  spec: ResourceSpec, row: Record<string, unknown>, canRead?: (module: string) => boolean,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [
    name,
    field.module && canRead && !canRead(field.module) ? null : (row[name] ?? null),
  ]));
}

/** De velden in deze invoer die bij een module horen die de aanroeper niet mag schrijven. */
export function fieldsOutsideWrite(
  spec: ResourceSpec, values: Record<string, unknown>, canWrite: (module: string) => boolean,
): string[] {
  return Object.keys(values).filter((name) => {
    const module = spec.fields[name]?.module;
    return Boolean(module && !canWrite(module));
  });
}

// ── OpenAPI ──────────────────────────────────────────────────────────────────
//
// Uit dezelfde specs als de controle hierboven: een veld dat erbij komt, staat
// meteen in het document, met hetzelfde type en dezelfde toegestane waarden.

const JSON_CONTENT = 'application/json';

function schemaRef(name: string): Record<string, string> {
  return { $ref: `#/components/schemas/${name}` };
}

function errorResponse(description: string): Record<string, unknown> {
  return { description, content: { [JSON_CONTENT]: { schema: schemaRef('Error') } } };
}

/** Een veld als JSON-schema. */
export function fieldSchema(field: FieldSpec): Record<string, unknown> {
  const base: Record<string, unknown> = (() => {
    switch (field.type) {
      case 'text': return { type: 'string', ...(field.maxLength ? { maxLength: field.maxLength } : {}) };
      case 'email': return { type: 'string', format: 'email' };
      case 'uuid': return { type: 'string', format: 'uuid' };
      case 'date': return { type: 'string', format: 'date' };
      case 'datetime': return { type: 'string', format: 'date-time' };
      case 'time': return { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
      case 'color': return { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' };
      case 'integer': return { type: 'integer' };
      case 'number': return { type: 'number' };
      case 'boolean': return { type: 'boolean' };
      case 'enum': return { type: 'string', enum: [...(field.values ?? [])] };
      case 'text_array': return { type: 'array', items: { type: 'string' }, maxItems: field.maxItems ?? 50 };
      case 'object': return { type: 'object' };
    }
  })();
  if (field.minimum !== undefined) base.minimum = field.minimum;
  if (field.maximum !== undefined) base.maximum = field.maximum;
  if (field.nullable && typeof base.type === 'string') base.type = [base.type, 'null'];
  if (field.readOnly) base.readOnly = true;
  if (field.default !== undefined) base.default = field.default;
  base.description = field.description;
  return base;
}

/** Paden, schema's en tags voor de resources, om in het OpenAPI-document te voegen. */
export function resourceOpenApi(specs: ResourceSpec[]): {
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, unknown>;
  schemas: Record<string, unknown>;
} {
  const tags: Array<{ name: string; description: string }> = [];
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const spec of specs) {
    const tag = spec.labelPlural;
    tags.push({
      name: tag,
      description: `${spec.labelPlural} lezen${spec.create ? ', aanmaken' : ''}${spec.update ? ' en wijzigen' : ''}. Webhooks: \`${spec.event}.*\`.`,
    });

    const properties = Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [name, fieldSchema(field)]));
    schemas[spec.schemaName] = { type: 'object', properties };
    schemas[`${spec.schemaName}List`] = {
      type: 'object',
      properties: {
        data: { type: 'array', items: schemaRef(spec.schemaName) },
        has_more: { type: 'boolean' },
        next_offset: {
          type: ['integer', 'null'],
          description: 'Geef dit mee als `offset` voor de volgende pagina. Null als er geen is, ook voorbij offset 10000 (verfijn dan met filters of updated_since).',
        },
      },
    };
    const inputProps = (mode: 'create' | 'update') => Object.fromEntries(
      writableFields(spec, mode).map((name) => {
        const { readOnly: _readOnly, ...field } = spec.fields[name];
        const input = field.inputValues ? { ...field, values: field.inputValues } : field;
        const defaulted = mode === 'create' && spec.createDefaults && name in spec.createDefaults
          ? { ...input, default: spec.createDefaults[name] } : input;
        return [name, fieldSchema(defaulted)];
      }),
    );
    const required = Object.entries(spec.fields).filter(([, field]) => field.required).map(([name]) => name);
    if (spec.create) {
      schemas[`${spec.schemaName}Create`] = {
        type: 'object', additionalProperties: false, properties: inputProps('create'),
        ...(required.length > 0 ? { required } : {}),
      };
    }
    if (spec.update) {
      schemas[`${spec.schemaName}Update`] = { type: 'object', additionalProperties: false, minProperties: 1, properties: inputProps('update') };
    }

    const parentParam = spec.parent
      ? [{ name: spec.parent.param, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }]
      : [];
    const filterParams = Object.entries(filtersOf(spec)).map(([name, filter]) => ({
      name, in: 'query',
      description: filter.type === 'enum' && filter.op === 'eq'
        ? `${filter.description} Meer waarden tegelijk met komma's, bijvoorbeeld \`${(filter.values ?? []).slice(0, 2).join(',')}\`.`
        : filter.description,
      schema: filter.type === 'enum' ? { type: 'string', pattern: `^(${(filter.values ?? []).join('|')})(,(${(filter.values ?? []).join('|')}))*$` }
        : filter.type === 'boolean' ? { type: 'boolean' }
        : filter.type === 'uuid' ? { type: 'string', format: 'uuid' }
        : filter.type === 'date' ? { type: 'string', format: 'date' }
        : filter.type === 'datetime' ? { type: 'string', format: 'date-time' }
        : { type: 'string' },
    }));
    const collection = `/v1/${spec.path}`;
    const noun = spec.label.toLowerCase();
    const opBase = spec.name.replace(/(^|_)([a-z])/g, (_m, _s, c: string) => c.toUpperCase());

    paths[collection] = {
      ...(parentParam.length > 0 ? { parameters: parentParam } : {}),
      get: {
        tags: [tag],
        operationId: `list${opBase}`,
        summary: `${spec.labelPlural} opvragen`,
        parameters: [
          ...(spec.search.length > 0 ? [{ name: 'q', in: 'query', schema: { type: 'string' }, description: `Zoeken in ${spec.search.join(', ')}.` }] : []),
          ...filterParams,
          { name: 'sort', in: 'query', schema: { type: 'string', enum: [...spec.sort], default: spec.sort[0] } },
          { $ref: '#/components/parameters/Limit' },
          { $ref: '#/components/parameters/Offset' },
        ],
        responses: {
          200: { description: 'Een pagina.', content: { [JSON_CONTENT]: { schema: schemaRef(`${spec.schemaName}List`) } } },
          400: errorResponse('Een onbekende parameter of filterwaarde.'),
          401: errorResponse('Geen of een ongeldige API-sleutel.'),
          403: errorResponse(`De sleutel mag ${spec.labelPlural.toLowerCase()} niet lezen.`),
          429: errorResponse('Te veel verzoeken.'),
        },
      },
      ...(spec.create ? {
        post: {
          tags: [tag],
          operationId: `create${spec.schemaName}`,
          summary: `Een ${noun} aanmaken`,
          description: 'Vraagt toegangsniveau `execute` en schrijfrecht in de module. Gebeurt als het teamlid achter de sleutel, met dezelfde regels als in de app.',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: { [JSON_CONTENT]: { schema: schemaRef(`${spec.schemaName}Create`) } } },
          responses: {
            201: { description: 'Aangemaakt.', content: { [JSON_CONTENT]: { schema: schemaRef(spec.schemaName) } } },
            401: errorResponse('Geen of een ongeldige API-sleutel.'),
            403: errorResponse('De sleutel of het teamlid mag dit niet.'),
            409: errorResponse('Bestaat al.'),
            422: errorResponse('De invoer klopt niet; `details.field` zegt welk veld.'),
            429: errorResponse('Te veel verzoeken.'),
          },
        },
      } : {}),
    };

    const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
    paths[`${collection}/{id}`] = {
      parameters: [...parentParam, idParam],
      get: {
        tags: [tag],
        operationId: `get${spec.schemaName}`,
        summary: `Eén ${noun}`,
        responses: {
          200: { description: `De ${noun}.`, content: { [JSON_CONTENT]: { schema: schemaRef(spec.schemaName) } } },
          401: errorResponse('Geen of een ongeldige API-sleutel.'),
          403: errorResponse(`De sleutel mag ${spec.labelPlural.toLowerCase()} niet lezen.`),
          404: errorResponse('Niet gevonden in deze organisatie.'),
        },
      },
      ...(spec.update ? {
        patch: {
          tags: [tag],
          operationId: `update${spec.schemaName}`,
          summary: `Een ${noun} wijzigen`,
          description: 'Alleen de velden die je meestuurt, veranderen. `null` maakt een veld leeg. Vraagt toegangsniveau `execute`.',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: { [JSON_CONTENT]: { schema: schemaRef(`${spec.schemaName}Update`) } } },
          responses: {
            200: { description: 'Gewijzigd.', content: { [JSON_CONTENT]: { schema: schemaRef(spec.schemaName) } } },
            401: errorResponse('Geen of een ongeldige API-sleutel.'),
            403: errorResponse('De sleutel of het teamlid mag dit niet.'),
            404: errorResponse('Niet gevonden in deze organisatie.'),
            422: errorResponse('De invoer klopt niet; `details.field` zegt welk veld.'),
            429: errorResponse('Te veel verzoeken.'),
          },
        },
      } : {}),
    };
  }
  return { tags, paths, schemas };
}
