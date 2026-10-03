// ============================================================
// De vaste adressen van de API naar de database: lezen, aanmaken, wijzigen.
//
// LEZEN gaat met de service-role, met de organisatie uit de sleutel als filter
// op elke query. Dat is precies wat RLS in de app doet voor deze tabellen
// (lid van de organisatie + de module mag gelezen worden — de functie `api`
// toetst dat laatste voor hij hier komt). `apiResourceServer.test.ts` leest dit
// bestand en houdt elke query aan dat filter.
//
// SCHRIJVEN gaat NIET met de service-role, maar via `api_rest_write` in de
// database: die wisselt binnen één transactie naar het teamlid achter de
// sleutel. Dan gelden dezelfde RLS-regels (schrijfrecht in de organisatie én de
// module), dezelfde triggers en hetzelfde auditlog als bij een wijziging in de
// app — geen nagebouwde versie ervan.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  MAX_OFFSET, presentRow, ResourceInputError, selectColumns, type ListParams, type ResourceName, type ResourceSpec,
} from './apiResources.ts';
import { RESOURCES } from './apiResourceSpecs.ts';

/** Wie er leest of schrijft: uit de sleutel, nooit uit het verzoek. */
export interface StoreCtx {
  db: SupabaseClient;
  organizationId: string;
  userId: string;
  /**
   * Mag de sleutel deze module lezen? Velden uit een andere module (een tarief
   * bij Financiën) komen anders als null terug, en een koppeling naar een rij
   * in zo'n module kan niet. Zonder: alles.
   */
  canRead?: (module: string) => boolean;
  /**
   * Mag deze sleutel iets doen wat naar buiten gaat of het klantportaal raakt
   * (een reactie die de klant ziet, een ander e-mailadres bij een contact met
   * portaaltoegang)? Dat vraagt `execute_high`, net als bij handelingen.
   */
  allowOutward?: boolean;
}

/** Een fout met een HTTP-status, voor de functie om door te geven. */
export class ResourceStoreError extends Error {
  status: 403 | 404 | 409 | 422;
  field?: string;
  /** Bij een 403: ligt het aan het toegangsniveau van de sleutel (en niet aan de modulerechten)? */
  code?: 'insufficient_scope';
  constructor(status: 403 | 404 | 409 | 422, message: string, field?: string, code?: 'insufficient_scope') {
    super(message);
    this.name = 'ResourceStoreError';
    this.status = status;
    this.field = field;
    this.code = code;
  }
}

// ── Lezen ────────────────────────────────────────────────────────────────────

/** Een pagina, nieuwste eerst (of zoals gevraagd). Eén rij extra zegt of er meer is. */
export async function listRows(
  ctx: StoreCtx, spec: ResourceSpec, params: ListParams, parentId?: string,
): Promise<{ data: Record<string, unknown>[]; has_more: boolean; next_offset: number | null }> {
  let query = ctx.db.from(spec.table).select(selectColumns(spec))
    .eq('organization_id', ctx.organizationId);
  if (spec.parent) {
    if (!parentId) throw new ResourceStoreError(404, `Geen ${RESOURCES[spec.parent.resource].label.toLowerCase()} opgegeven.`);
    query = query.eq(spec.parent.column, parentId);
  }
  for (const filter of params.filters) {
    if (filter.op === 'in') query = query.in(filter.column, filter.value as string[]);
    else if (filter.op === 'gte') query = query.gte(filter.column, filter.value as string);
    else if (filter.op === 'lte') query = query.lte(filter.column, filter.value as string);
    else query = query.eq(filter.column, filter.value as string | boolean);
  }
  if (params.q) {
    query = query.or(spec.search.map((column) => `${column}.ilike.%${params.q}%`).join(','));
  }
  query = query.order(params.sort.column, { ascending: params.sort.ascending, nullsFirst: false })
    .order('id', { ascending: true })
    .range(params.offset, params.offset + params.limit);

  const { data, error } = await query;
  if (error) throw new Error(`${spec.labelPlural} ophalen mislukt: ${error.message}`);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const hasMore = rows.length > params.limit;
  const nextOffset = params.offset + params.limit;
  return {
    data: rows.slice(0, params.limit).map((row) => presentRow(spec, row, ctx.canRead)),
    has_more: hasMore,
    // Voorbij MAX_OFFSET bladeren kan niet; dan is er wel meer, maar geen
    // volgende pagina. Filters of updated_since brengen je verder.
    next_offset: hasMore && nextOffset <= MAX_OFFSET ? nextOffset : null,
  };
}

/** Eén rij, als hij in deze organisatie bestaat. Anders: niet gevonden. */
export async function getRow(ctx: StoreCtx, spec: ResourceSpec, id: string, parentId?: string): Promise<Record<string, unknown>> {
  if (!isId(id)) throw notFound(spec);
  let query = ctx.db.from(spec.table).select(selectColumns(spec))
    .eq('organization_id', ctx.organizationId).eq('id', id);
  if (spec.parent && parentId) query = query.eq(spec.parent.column, parentId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`${spec.label} ophalen mislukt: ${error.message}`);
  if (!data) throw notFound(spec);
  return presentRow(spec, data as unknown as Record<string, unknown>, ctx.canRead);
}

/**
 * Bestaat elke rij waar de invoer naar verwijst, in DEZE organisatie?
 *
 * Een foreign key kijkt alleen of de rij bestaat, niet van wie hij is. Zonder
 * deze controle hangt een koppeling met één geraden id een project aan een
 * klant van iemand anders — of krijgt ze via de foutmelding te horen dat die
 * klant bestaat.
 */
export async function assertReferences(ctx: StoreCtx, spec: ResourceSpec, values: Record<string, unknown>): Promise<void> {
  for (const [name, field] of Object.entries(spec.fields)) {
    const target = field.references;
    const value = values[name];
    if (!target || value === null || value === undefined) continue;
    const ref = RESOURCES[target];
    // Koppelen aan iets wat de sleutel niet mag zien, kan niet: anders zegt het
    // antwoord alsnog of die rij bestaat, en hangt er iets aan wat niemand met
    // deze rechten in de app kon kiezen.
    if (ctx.canRead && !ctx.canRead(ref.module)) {
      throw new ResourceStoreError(403,
        `"${name}" verwijst naar ${ref.labelPlural.toLowerCase()}, en die mag deze sleutel niet lezen.`, name);
    }
    const { data, error } = await ctx.db.from(ref.table).select('id')
      .eq('organization_id', ctx.organizationId).eq('id', String(value)).maybeSingle();
    if (error) throw new Error(`${ref.label} controleren mislukt: ${error.message}`);
    if (!data) {
      throw new ResourceStoreError(422, `"${name}" verwijst naar een ${ref.label.toLowerCase()} die niet bestaat in deze organisatie.`, name);
    }
  }
}

// ── Schrijven ────────────────────────────────────────────────────────────────

/** Aanmaken, als het teamlid achter de sleutel (zie api_rest_write). */
export async function createRow(
  ctx: StoreCtx, spec: ResourceSpec, values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await assertReferences(ctx, spec, values);
  const row = await write(ctx, spec, values, null);
  if (!row) throw new Error(`${spec.label} aanmaken gaf geen rij terug.`);
  return presentRow(spec, row, ctx.canRead);
}

/** Wijzigen, als het teamlid achter de sleutel. Een id uit een andere organisatie bestaat niet. */
export async function updateRow(
  ctx: StoreCtx, spec: ResourceSpec, id: string, values: Record<string, unknown>, parentId?: string,
): Promise<Record<string, unknown>> {
  // Eerst opzoeken binnen de organisatie (en de ouder): zo is "niet gevonden"
  // hetzelfde antwoord als bij lezen, en raakt de update nooit een rij erbuiten.
  await getRow(ctx, spec, id, parentId);
  await assertReferences(ctx, spec, values);
  const row = await write(ctx, spec, values, id);
  if (!row) throw notFound(spec);
  return presentRow(spec, row, ctx.canRead);
}

async function write(
  ctx: StoreCtx, spec: ResourceSpec, values: Record<string, unknown>, rowId: string | null,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await ctx.db.rpc('api_rest_write', {
    p_user_id: ctx.userId,
    p_organization_id: ctx.organizationId,
    p_resource: spec.name,
    p_values: values,
    p_row_id: rowId,
    p_allow_outward: ctx.allowOutward === true,
  });
  if (error) throw translateDbError(spec, error);
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * De CHECK- en UNIQUE-regels van de tabellen in gewone taal. Postgres zegt
 * `new row for relation "tasks" violates check constraint "tasks_planned_range"`;
 * een koppeling heeft meer aan welk veld en waarom.
 */
const CONSTRAINT_MESSAGES: Record<string, { field: string; message: string }> = {
  tasks_planned_range: { field: 'planned_end_date', message: '"planned_end_date" kan alleen samen met "planned_date", en ligt op of na die dag.' },
  tasks_planned_start_minute_range: {
    field: 'planned_start_minute',
    message: 'Een begintijd ("planned_start_minute", 0–1439) kan alleen bij een taak op één ingeplande dag: met "planned_date" en zonder "planned_end_date".',
  },
  tasks_estimated_minutes_range: { field: 'estimated_minutes', message: '"estimated_minutes" ligt tussen 0 en 1440.' },
  tasks_estimated_minutes_check: { field: 'estimated_minutes', message: '"estimated_minutes" ligt tussen 0 en 1440.' },
  time_entries_indirect_category_ck: { field: 'indirect_category', message: '"indirect_category" hoort alleen bij "entry_type": "indirect".' },
  time_entries_minutes_check: { field: 'minutes', message: '"minutes" kan niet negatief zijn.' },
  ticket_notes_body_not_blank: { field: 'body', message: '"body" mag niet leeg zijn.' },
  projects_budgeted_minutes_ck: { field: 'budgeted_minutes', message: '"budgeted_minutes" kan niet negatief zijn.' },
  idx_client_contacts_client_email_unique: { field: 'email', message: 'Deze klant heeft al een contactpersoon met dit e-mailadres.' },
};

/**
 * Een databasefout als zin voor de koppeling. De regels zijn die van de app;
 * hun eigen meldingen (uit triggers, in het Nederlands) gaan ongewijzigd door.
 * De kale meldingen van Postgres zelf (met tabel- en constraintnamen) niet:
 * die worden een zin, met hooguit de naam van het veld.
 */
export function translateDbError(spec: ResourceSpec, error: { code?: string; message?: string; details?: string | null }): ResourceStoreError | Error {
  const message = String(error.message || 'onbekende fout');
  const constraint = message.match(/constraint "([^"]+)"/)?.[1];
  const column = message.match(/column "([^"]+)"/)?.[1];
  const known = constraint ? CONSTRAINT_MESSAGES[constraint] : undefined;
  if (known && (error.code === '23514' || error.code === '23505')) {
    return new ResourceStoreError(error.code === '23505' ? 409 : 422, known.message, known.field);
  }
  if (constraint && error.code === '23514') {
    return new ResourceStoreError(422, `De invoer past niet bij de regels van ResoFly (${constraint}).`);
  }
  switch (error.code) {
    case 'RS403':
      // api_rest_write: iets wat naar buiten gaat of het portaal raakt, zonder
      // execute_high. Dat ligt aan het toegangsniveau, niet aan de rechten.
      return new ResourceStoreError(403, message, undefined, 'insufficient_scope');
    case '42501':
      // Een eigen melding uit de app (een trigger als enforce_module_write_access)
      // gaat door; de kale RLS-melding van Postgres wordt een zin.
      return new ResourceStoreError(403, /row-level security|permission denied/i.test(message)
        ? `Het teamlid achter deze sleutel mag ${spec.labelPlural.toLowerCase()} niet wijzigen (rol of modulerechten in ResoFly).`
        : message);
    case 'P0002':
      return new ResourceStoreError(404, `${spec.label} niet gevonden in deze organisatie.`);
    case '23505':
      return new ResourceStoreError(409, /^duplicate key value/i.test(message)
        ? `Dit bestaat al in deze organisatie: ${spec.label.toLowerCase()} met dezelfde waarde.`
        : message);
    case '23503':
      return new ResourceStoreError(422, 'De invoer verwijst naar iets wat niet bestaat.');
    case '23502':
      return column
        ? new ResourceStoreError(422, `"${column}" is verplicht en mag niet leeg zijn.`, column)
        : new ResourceStoreError(422, 'Er ontbreekt een verplicht veld.');
    case '22P02': {
      const type = message.match(/for type ([a-z][a-z ]*)/i)?.[1];
      return new ResourceStoreError(422, /^invalid input/i.test(message)
        ? `Een waarde heeft niet de juiste vorm${type ? ` (${type})` : ''}.`
        : message);
    }
    case '23514':
    case '22007':
    case '22008':
    case '22003':
    case '22023':
    case '22P05':
    case '22021':
    case 'P0001':
      return new ResourceStoreError(422, message);
    default:
      return new Error(`${spec.label} opslaan mislukt: ${message}`);
  }
}

// ── Hulp ─────────────────────────────────────────────────────────────────────

function isId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function notFound(spec: ResourceSpec): ResourceStoreError {
  return new ResourceStoreError(404, `${spec.label} niet gevonden in deze organisatie.`);
}

export { ResourceInputError };
export type { ResourceName };
