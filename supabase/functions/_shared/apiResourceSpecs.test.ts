import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { buildOpenApi } from './publicApi.ts';
import { resourceOpenApi, writableFields } from './apiResources.ts';
import { matchResource, refineTaskPlanning, refineTimeEntryType, RESOURCE_LIST, RESOURCES } from './apiResourceSpecs.ts';
import { WEBHOOK_EVENTS } from './webhooks.ts';

/**
 * De zeven resources naast de database en de rest van de API.
 *
 * De specs zeggen welke waarden een veld mag hebben; de database zegt het ook
 * (CHECK-constraints). Lopen die uiteen, dan weigert de API een waarde die de
 * app wel kent, of laat hij er een door die de database daarna afwijst met een
 * kale Postgres-melding. Deze test legt ze naast elkaar — tegen de laatste
 * definitie in de migraties, of anders die in het volledige schema.
 */

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const FRESH = readFileSync(new URL('../../FRESH_INSTALL_COMPLETE_SCHEMA.sql', import.meta.url), 'utf8');
const REST_MIGRATION = readFileSync(new URL('20261003020000_api_rest.sql', MIGRATIONS_DIR), 'utf8');

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort()
  .map((name) => readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8'));

const quoted = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

/** De waarden uit de LAATSTE `add constraint <naam> check (... <kolom> in (...) ...)`. */
function namedCheckValues(name: string, column: string): string[] | null {
  let found: string[] | null = null;
  const re = new RegExp(`add\\s+constraint\\s+${name}\\s+check\\s*\\(([\\s\\S]*?)\\);`, 'gi');
  for (const sql of migrations) {
    for (const match of sql.matchAll(re)) {
      const list = match[1].match(new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, 'i'));
      if (list) found = quoted(list[1]);
    }
  }
  return found;
}

/** Een inline check uit het volledige schema, tenzij een migratie hem later opnieuw definieerde. */
function inlineCheckValues(table: string, column: string): string[] {
  const redefined = namedCheckValues(`${table}_${column}_check`, column);
  if (redefined) return redefined;
  const start = FRESH.indexOf(`create table public.${table} (`);
  assert.ok(start >= 0, `create table public.${table} niet gevonden`);
  const block = FRESH.slice(start, FRESH.indexOf('\n);', start));
  const match = block.match(new RegExp(`\\n\\s*${column}\\s+text[^\\n]*check \\(${column} in \\(([^)]*)\\)\\)`));
  assert.ok(match, `check op ${table}.${column} niet gevonden`);
  return quoted(match[1]);
}

// ── Toegestane waarden ───────────────────────────────────────────────────────

test('de toegestane waarden zijn die van de database', () => {
  const cases: Array<{ resource: keyof typeof RESOURCES; field: string; values: string[] }> = [
    { resource: 'clients', field: 'status', values: inlineCheckValues('clients', 'status') },
    { resource: 'clients', field: 'client_kind', values: namedCheckValues('clients_client_kind_check', 'client_kind')! },
    { resource: 'projects', field: 'billing_type', values: namedCheckValues('projects_billing_type_check', 'billing_type')! },
    { resource: 'tasks', field: 'status', values: inlineCheckValues('tasks', 'status') },
    { resource: 'tasks', field: 'priority', values: inlineCheckValues('tasks', 'priority') },
    { resource: 'tickets', field: 'status', values: inlineCheckValues('tickets', 'status') },
    { resource: 'tickets', field: 'priority', values: inlineCheckValues('tickets', 'priority') },
    { resource: 'ticket_notes', field: 'author_type', values: namedCheckValues('ticket_notes_author_type_check', 'author_type')! },
    { resource: 'time_entries', field: 'entry_type', values: namedCheckValues('time_entries_entry_type_ck', 'entry_type')! },
    { resource: 'time_entries', field: 'indirect_category', values: namedCheckValues('time_entries_indirect_category_ck', 'indirect_category')! },
  ];
  for (const { resource, field, values } of cases) {
    assert.ok(values && values.length > 0, `${resource}.${field}: geen waarden gevonden in de SQL`);
    assert.deepEqual([...(RESOURCES[resource].fields[field].values ?? [])].sort(), [...values].sort(), `${resource}.${field}`);
  }
  // Wat je zelf mag zetten, is een deel van wat de database kent.
  for (const spec of RESOURCE_LIST) {
    for (const [name, field] of Object.entries(spec.fields)) {
      for (const value of field.inputValues ?? []) {
        assert.ok(field.values?.includes(value), `${spec.name}.${name}: invoerwaarde "${value}" bestaat niet`);
      }
    }
  }
});

test('een ticket omzetten naar een project kan niet via een status', () => {
  assert.ok(!RESOURCES.tickets.fields.status.inputValues?.includes('converted'));
  assert.ok(RESOURCES.tickets.fields.status.values?.includes('converted'));
});

// ── Wat de app zelf beheert ──────────────────────────────────────────────────

/** De lijst die api_rest_write per resource weigert (v_server_only). */
function sqlServerOnly(resource: string): string[] {
  const block = REST_MIGRATION.slice(REST_MIGRATION.indexOf('v_server_only := case p_resource'));
  const line = block.match(new RegExp(`when '${resource}'\\s+then array\\[([^\\]]*)\\]`));
  assert.ok(line, `${resource} ontbreekt in v_server_only`);
  return quoted(line[1]);
}

test('wat in de specs alleen-lezen is, weigert de database ook', () => {
  const generic = new Set(['id', 'created_at', 'updated_at', 'created_by']);
  for (const spec of RESOURCE_LIST) {
    const serverOnly = new Set(sqlServerOnly(spec.name));
    for (const [name, field] of Object.entries(spec.fields)) {
      if (!field.readOnly || generic.has(name) || name === spec.parent?.column) continue;
      assert.ok(serverOnly.has(name), `${spec.name}.${name} is alleen-lezen in de spec, maar api_rest_write laat hem toe`);
    }
  }
  // Alleen bij aanmaken: ook dat weet de database.
  const createOnly = REST_MIGRATION.match(/when 'contacts' then array\[([^\]]*)\]/);
  assert.deepEqual(quoted(createOnly![1]), Object.entries(RESOURCES.contacts.fields).filter(([, f]) => f.createOnly).map(([n]) => n));
});

test('een resource zonder wijzigen weigert de database ook', () => {
  for (const spec of RESOURCE_LIST.filter((s) => !s.update)) {
    assert.match(REST_MIGRATION, new RegExp(`if p_row_id is not null and p_resource = '${spec.name}' then\\s*\\n\\s*raise exception`),
      `${spec.name} kan via de API niet gewijzigd worden, maar api_rest_write laat het toe`);
  }
  for (const spec of RESOURCE_LIST) {
    assert.match(REST_MIGRATION, new RegExp(`when '${spec.name}'\\s+then '${spec.table}'`), `${spec.name} → ${spec.table} ontbreekt in api_rest_write`);
  }
});

test('geen veld dat op een geheim lijkt, en organisatie en maker staan er nooit als invoer in', () => {
  for (const spec of RESOURCE_LIST) {
    for (const name of Object.keys(spec.fields)) {
      assert.doesNotMatch(name, /(^|_)(token|tokens|hash|secret|secrets|password|pin)(_|$)/, `${spec.name}.${name}`);
    }
    assert.ok(!('organization_id' in spec.fields), `${spec.name} laat organization_id zien`);
    for (const mode of ['create', 'update'] as const) {
      const writable = writableFields(spec, mode);
      for (const forbidden of ['id', 'organization_id', 'created_by', 'created_at', 'updated_at']) {
        assert.ok(!writable.includes(forbidden), `${spec.name}: ${forbidden} is te zetten`);
      }
    }
  }
});

// ── Samenhang met de rest van de API ─────────────────────────────────────────

test('dezelfde module als de webhooks van hetzelfde onderwerp', () => {
  for (const spec of RESOURCE_LIST) {
    const events = WEBHOOK_EVENTS.filter((event) => event.type.split('.')[0] === spec.event);
    assert.ok(events.length > 0, `geen webhooks voor ${spec.event}`);
    for (const event of events) assert.equal(event.module, spec.module, `${event.type} hoort bij ${event.module}, ${spec.name} bij ${spec.module}`);
  }
});

test('elk pad vindt de goede resource', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const ticket = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(pick(matchResource('/v1/clients')), ['clients', null, null]);
  assert.deepEqual(pick(matchResource(`/v1/clients/${id}`)), ['clients', id, null]);
  assert.deepEqual(pick(matchResource(`/v1/tickets/${ticket}`)), ['tickets', ticket, null]);
  assert.deepEqual(pick(matchResource(`/v1/tickets/${ticket}/notes`)), ['ticket_notes', null, ticket]);
  assert.deepEqual(pick(matchResource(`/v1/tickets/${ticket}/notes/${id}`)), ['ticket_notes', id, ticket]);
  assert.deepEqual(pick(matchResource('/v1/time_entries')), ['time_entries', null, null]);
  assert.equal(matchResource('/v1/actions'), null);
  assert.equal(matchResource('/v1/webhooks'), null);
  assert.equal(matchResource(`/v1/clients/${id}/extra`), null);
});

function pick(match: ReturnType<typeof matchResource>): [string, string | null, string | null] | null {
  return match ? [match.spec.name, match.id, match.parentId] : null;
}

test('het OpenAPI-document: elk adres, elk schema, en elke operationId één keer', () => {
  const extra = resourceOpenApi(RESOURCE_LIST);
  const doc = buildOpenApi({
    serverUrl: 'https://x.test/api',
    actions: [{ id: 'invoice.set_status', label: 'x', module: 'finance', kind: 'write', description: 'x', input: {} }],
    extra,
  }) as { paths: Record<string, Record<string, { operationId?: string }>>; components: { schemas: Record<string, unknown> } };
  for (const spec of RESOURCE_LIST) {
    const base = `/v1/${spec.path}`;
    assert.ok(doc.paths[base]?.get, `${base} GET`);
    assert.ok(doc.paths[`${base}/{id}`]?.get, `${base}/{id} GET`);
    assert.equal(Boolean(doc.paths[base]?.post), spec.create, `${base} POST`);
    assert.equal(Boolean(doc.paths[`${base}/{id}`]?.patch), spec.update, `${base}/{id} PATCH`);
    for (const schema of [spec.schemaName, `${spec.schemaName}List`, ...(spec.create ? [`${spec.schemaName}Create`] : []), ...(spec.update ? [`${spec.schemaName}Update`] : [])]) {
      assert.ok(doc.components.schemas[schema], `schema ${schema}`);
    }
  }
  const ids = Object.values(doc.paths).flatMap((path) => Object.values(path).map((op) => op?.operationId).filter(Boolean));
  assert.equal(new Set(ids).size, ids.length, `dubbele operationId: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
  // Het invoerschema van een nieuwe klant noemt wat verplicht is, en kent geen klantnummer.
  const create = doc.components.schemas.ClientCreate as { required: string[]; properties: Record<string, unknown> };
  assert.deepEqual(create.required, ['name']);
  assert.ok(!('client_code' in create.properties));
  const note = doc.components.schemas.TicketNoteCreate as { properties: Record<string, { default?: unknown }> };
  assert.equal(note.properties.is_internal.default, true, 'een reactie via de API is standaard intern');
});

// ── Regels over meer velden ──────────────────────────────────────────────────

test('planning van een taak: één dag met begintijd, of meer dagen zonder', () => {
  assert.doesNotThrow(() => refineTaskPlanning({ planned_date: '2026-10-05', planned_start_minute: 540 }, 'create'));
  assert.doesNotThrow(() => refineTaskPlanning({ planned_date: '2026-10-05', planned_end_date: '2026-10-07' }, 'create'));
  assert.throws(() => refineTaskPlanning({ planned_end_date: '2026-10-07' }, 'create'), /samen met "planned_date"/);
  assert.throws(() => refineTaskPlanning({ planned_date: '2026-10-05', planned_end_date: '2026-10-04' }, 'update'), /op of na/);
  assert.throws(() => refineTaskPlanning({ planned_date: '2026-10-05', planned_end_date: '2026-10-07', planned_start_minute: 60 }, 'create'), /begintijd/);
  assert.throws(() => refineTaskPlanning({ planned_start_minute: 60 }, 'create'), /ingeplande dag/);
  // Bij wijzigen hangt het van de bestaande rij af; dat bewaakt de database.
  assert.doesNotThrow(() => refineTaskPlanning({ planned_end_date: '2026-10-07' }, 'update'));
});

test('uren: een categorie hoort alleen bij indirecte uren', () => {
  assert.doesNotThrow(() => refineTimeEntryType({ entry_type: 'indirect', indirect_category: 'admin' }, 'create'));
  assert.throws(() => refineTimeEntryType({ indirect_category: 'admin' }, 'create'), /indirect/);
  assert.throws(() => refineTimeEntryType({ entry_type: 'direct', indirect_category: 'travel' }, 'update'), /indirect/);
  const switched: Record<string, unknown> = { entry_type: 'direct' };
  refineTimeEntryType(switched, 'update');
  assert.equal(switched.indirect_category, null, 'wie naar direct wisselt, verliest de categorie — net als in de app');
});
