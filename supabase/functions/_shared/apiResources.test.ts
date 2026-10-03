import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldsOutsideWrite, filtersOf, isIsoDate, MAX_OFFSET, normalizeInput, parseListParams, presentRow, ResourceInputError,
  selectColumns, writableFields, type ResourceSpec,
} from './apiResources.ts';

/**
 * De motor achter de vaste adressen (/v1/clients en verder): invoer controleren,
 * lijstparameters lezen, antwoorden vormen. Met een proefresource, zodat deze
 * regels los van de echte velden vastliggen; apiResourceSpecs.test.ts legt de
 * echte resources naast de database.
 */

const spec: ResourceSpec = {
  name: 'clients',
  path: 'proef',
  table: 'proef',
  module: 'clients',
  schemaName: 'Proef',
  label: 'Proef',
  labelPlural: 'Proeven',
  event: 'proef',
  fields: {
    id: { type: 'uuid', description: 'id', readOnly: true },
    name: { type: 'text', description: 'naam', required: true, maxLength: 10 },
    note: { type: 'text', description: 'notitie', nullable: true },
    email: { type: 'email', description: 'mail', nullable: true },
    status: { type: 'enum', description: 'status', values: ['active', 'archived'] },
    parent_id: { type: 'uuid', description: 'ouder', createOnly: true, nullable: true },
    day: { type: 'date', description: 'dag', nullable: true },
    at: { type: 'datetime', description: 'tijdstip', nullable: true },
    start: { type: 'time', description: 'begin', nullable: true },
    minutes: { type: 'integer', description: 'minuten', minimum: 0, maximum: 1440 },
    rate: { type: 'number', description: 'tarief', minimum: 0, nullable: true, module: 'finance' },
    billable: { type: 'boolean', description: 'declarabel' },
    tags: { type: 'text_array', description: 'labels', maxLength: 20 },
    extra: { type: 'object', description: 'eigen velden' },
    created_at: { type: 'datetime', description: 'aangemaakt', readOnly: true },
    updated_at: { type: 'datetime', description: 'gewijzigd', readOnly: true },
  },
  filters: {
    status: { column: 'status', op: 'eq', type: 'enum', values: ['active', 'archived'], description: 'status' },
    parent_id: { column: 'parent_id', op: 'eq', type: 'uuid', description: 'ouder' },
    from: { column: 'day', op: 'gte', type: 'date', description: 'vanaf' },
    billable: { column: 'billable', op: 'eq_bool', type: 'boolean', description: 'declarabel' },
    email: { column: 'email', op: 'eq', type: 'text', description: 'mail', lowercase: true },
  },
  search: ['name', 'email'],
  sort: ['-created_at', 'created_at', 'name', '-updated_at'],
  create: true,
  update: true,
};

function rejects(fn: () => unknown, pattern: RegExp, field?: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ResourceInputError, `verwacht ResourceInputError, kreeg ${error}`);
    assert.match(error.message, pattern);
    if (field) assert.equal(error.field, field);
    return;
  }
  assert.fail(`verwacht een fout die past op ${pattern}`);
}

// ── Invoer ───────────────────────────────────────────────────────────────────

test('aanmaken: verplichte velden, en wat je mag zetten', () => {
  assert.deepEqual(normalizeInput(spec, { name: '  Jansen  ' }, 'create'), { name: 'Jansen' });
  rejects(() => normalizeInput(spec, {}, 'create'), /Verplicht bij een nieuwe proef: name/, 'name');
  rejects(() => normalizeInput(spec, { name: null }, 'create'), /"name" mag niet leeg zijn/);
  rejects(() => normalizeInput(spec, { name: '   ' }, 'create'), /"name" mag niet leeg zijn/);
  assert.deepEqual(writableFields(spec, 'create').sort(), ['billable', 'day', 'email', 'extra', 'at', 'minutes', 'name', 'note', 'parent_id', 'rate', 'start', 'status', 'tags'].sort());
  assert.ok(!writableFields(spec, 'update').includes('parent_id'), 'createOnly hoort niet bij wijzigen');
});

test('een onbekend of alleen-lezen veld is een fout, geen stilte', () => {
  rejects(() => normalizeInput(spec, { name: 'x', emial: 'a@b.nl' }, 'create'), /Onbekend veld "emial"/, 'emial');
  rejects(() => normalizeInput(spec, { name: 'x', id: '1' }, 'create'), /"id" kun je niet zelf zetten/, 'id');
  rejects(() => normalizeInput(spec, { organization_id: 'x' }, 'update'), /Onbekend veld "organization_id"/);
  rejects(() => normalizeInput(spec, { parent_id: null }, 'update'), /"parent_id" ligt vast/);
  rejects(() => normalizeInput(spec, {}, 'update'), /Er valt niets te wijzigen/);
  rejects(() => normalizeInput(spec, [] as unknown as Record<string, unknown>, 'update'), /JSON-object/);
});

test('waarden worden gecontroleerd en genormaliseerd', () => {
  const values = normalizeInput(spec, {
    note: '',
    email: ' Info@Jansen.NL ',
    status: 'archived',
    day: '2026-02-28',
    at: '2026-10-03T09:00:00+02:00',
    start: '09:30',
    minutes: '90',
    rate: '87,50',
    billable: 'true',
    tags: ['vip', ' vip ', '', 'noord'],
    extra: { kvk: '123' },
  }, 'update');
  assert.deepEqual(values, {
    note: null,
    email: 'info@jansen.nl',
    status: 'archived',
    day: '2026-02-28',
    at: '2026-10-03T07:00:00.000Z',
    start: '09:30',
    minutes: 90,
    rate: 87.5,
    billable: true,
    tags: ['vip', 'noord'],
    extra: { kvk: '123' },
  });
});

test('wat niet klopt, zegt welk veld en waarom', () => {
  rejects(() => normalizeInput(spec, { name: 'veel te lange naam' }, 'create'), /hooguit 10 tekens/, 'name');
  rejects(() => normalizeInput(spec, { email: 'geen-mail' }, 'update'), /geldig e-mailadres/, 'email');
  rejects(() => normalizeInput(spec, { status: 'weg' }, 'update'), /een van deze zijn: active, archived/, 'status');
  rejects(() => normalizeInput(spec, { day: '2026-02-30' }, 'update'), /JJJJ-MM-DD/, 'day');
  rejects(() => normalizeInput(spec, { day: '03-10-2026' }, 'update'), /JJJJ-MM-DD/);
  rejects(() => normalizeInput(spec, { at: '2026-10-03T09:00:00' }, 'update'), /met tijdzone/, 'at');
  rejects(() => normalizeInput(spec, { start: '24:00' }, 'update'), /UU:MM/, 'start');
  rejects(() => normalizeInput(spec, { minutes: 1.5 }, 'update'), /geheel getal/, 'minutes');
  rejects(() => normalizeInput(spec, { minutes: -1 }, 'update'), /minstens 0/);
  rejects(() => normalizeInput(spec, { minutes: 2000 }, 'update'), /hooguit 1440/);
  rejects(() => normalizeInput(spec, { minutes: 'veel' }, 'update'), /geheel getal/);
  rejects(() => normalizeInput(spec, { billable: 'ja' }, 'update'), /true of false/, 'billable');
  rejects(() => normalizeInput(spec, { billable: null }, 'update'), /mag niet leeg zijn/);
  rejects(() => normalizeInput(spec, { tags: 'vip' }, 'update'), /lijst met teksten/, 'tags');
  rejects(() => normalizeInput(spec, { tags: ['x'.repeat(21)] }, 'update'), /hooguit 20 tekens/);
  rejects(() => normalizeInput(spec, { extra: [1] }, 'update'), /een object/, 'extra');
  rejects(() => normalizeInput(spec, { parent_id: 'abc' }, 'create'), /uuid/, 'parent_id');
});

test('isIsoDate kent de kalender', () => {
  assert.ok(isIsoDate('2028-02-29'));
  assert.ok(!isIsoDate('2026-02-29'));
  assert.ok(!isIsoDate('2026-13-01'));
  assert.ok(!isIsoDate('2026-1-01'));
});

// ── Lijsten ──────────────────────────────────────────────────────────────────

test('lijstparameters: filters, zoeken, sorteren en pagineren', () => {
  const params = parseListParams(spec, new URLSearchParams({
    q: 'jansen, (or) *%', status: 'active', from: '2026-10-01', billable: 'false', sort: 'name', limit: '500', offset: '20',
    updated_since: '2026-10-01T00:00:00Z',
  }));
  assert.equal(params.q, 'jansen or', 'tekens die in een PostgREST-filter iets betekenen, gaan eruit');
  assert.deepEqual(params.sort, { column: 'name', ascending: true });
  assert.equal(params.limit, 100);
  assert.equal(params.offset, 20);
  assert.deepEqual(params.filters, [
    { column: 'updated_at', op: 'gte', value: '2026-10-01T00:00:00.000Z' },
    { column: 'status', op: 'eq', value: 'active' },
    { column: 'day', op: 'gte', value: '2026-10-01' },
    { column: 'billable', op: 'eq_bool', value: false },
  ]);
  const defaults = parseListParams(spec, new URLSearchParams());
  assert.deepEqual(defaults.sort, { column: 'created_at', ascending: false });
  assert.equal(defaults.limit, 25);
  assert.equal(defaults.q, null);
});

test('een onbekende parameter of verkeerde filterwaarde is een fout', () => {
  rejects(() => parseListParams(spec, new URLSearchParams({ stauts: 'active' })), /Onbekende parameter "stauts"/);
  rejects(() => parseListParams(spec, new URLSearchParams({ status: 'weg' })), /Filter "status"/);
  rejects(() => parseListParams(spec, new URLSearchParams({ parent_id: 'x' })), /uuid/);
  rejects(() => parseListParams(spec, new URLSearchParams({ sort: 'email' })), /Sorteren kan op/);
  rejects(() => parseListParams(spec, new URLSearchParams({ updated_since: 'gisteren' })), /ISO 8601/);
});

test('de gemeenschappelijke filters gelden alleen waar de kolom bestaat', () => {
  assert.ok('updated_since' in filtersOf(spec));
  const withoutUpdated: ResourceSpec = { ...spec, fields: { id: spec.fields.id, created_at: spec.fields.created_at }, filters: {} };
  assert.deepEqual(Object.keys(filtersOf(withoutUpdated)), ['created_since']);
});

// ── Antwoorden ───────────────────────────────────────────────────────────────

test('een antwoord bevat precies de velden uit de spec, en niets anders', () => {
  const row = { id: '1', name: 'Jansen', public_token_hash: 'geheim', organization_id: 'org' };
  const shown = presentRow(spec, row);
  assert.deepEqual(Object.keys(shown), Object.keys(spec.fields));
  assert.equal(shown.name, 'Jansen');
  assert.equal(shown.note, null);
  assert.ok(!('public_token_hash' in shown));
  assert.equal(selectColumns(spec), Object.keys(spec.fields).join(', '));
});

// ── Bevindingen uit de veiligheidstest (oktober 2026) ────────────────────────

test('namen van ingebouwde objecteigenschappen zijn gewoon onbekende velden', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    const input = JSON.parse(`{"name": "x", "${name}": 1}`);
    rejects(() => normalizeInput(spec, input, 'create'), /Onbekend veld/, name);
  }
});

test('stuurtekens in q en in tekstfilters', () => {
  const textSpec: ResourceSpec = { ...spec, filters: { ...spec.filters, email: { column: 'email', op: 'eq', type: 'text', description: 'mail' } } };
  assert.equal(parseListParams(textSpec, new URLSearchParams({ q: 'jan\u0000sen\tbv' })).q, 'jan sen bv');
  rejects(() => parseListParams(textSpec, new URLSearchParams({ email: 'a\u0000@b.nl' })), /stuurtekens/, 'email');
  assert.deepEqual(parseListParams(textSpec, new URLSearchParams({ email: 'a,b(c)@d.nl' })).filters, [{ column: 'email', op: 'eq', value: 'a,b(c)@d.nl' }]);
});

test('een keuzelijst-filter met meer waarden tegelijk', () => {
  assert.deepEqual(parseListParams(spec, new URLSearchParams({ status: 'active,archived,active' })).filters,
    [{ column: 'status', op: 'in', value: ['active', 'archived'] }]);
  rejects(() => parseListParams(spec, new URLSearchParams({ status: 'active,weg' })), /Filter "status"/);
  // Een id of datum blijft één waarde.
  rejects(() => parseListParams(spec, new URLSearchParams({ parent_id: 'a,b' })), /uuid/);
});

// ── Tweede ronde ─────────────────────────────────────────────────────────────

test('een getal is een getal: "87,50" wel, "0x3C", "6e1" of "Infinity" niet', () => {
  assert.equal(normalizeInput(spec, { name: 'a', rate: '87,50' }, 'create').rate, 87.5);
  assert.equal(normalizeInput(spec, { name: 'a', minutes: ' 90 ' }, 'create').minutes, 90);
  for (const bad of ['0x3C', '6e1', 'Infinity', '1_000', '1.2.3', '--1', 'tien']) {
    rejects(() => normalizeInput(spec, { name: 'a', rate: bad }, 'create'), /getal/, 'rate');
  }
  rejects(() => normalizeInput(spec, { name: 'a', minutes: '' }, 'create'), /leeg/, 'minutes');
});

test('een lijst met teksten bevat teksten (of getallen), geen objecten', () => {
  assert.deepEqual(normalizeInput(spec, { name: 'a', tags: ['x', 2, null, ' x '] }, 'create').tags, ['x', '2']);
  rejects(() => normalizeInput(spec, { name: 'a', tags: [{ a: 1 }] }, 'create'), /lijst met teksten/, 'tags');
  rejects(() => normalizeInput(spec, { name: 'a', tags: [['geneste']] }, 'create'), /lijst met teksten/, 'tags');
});

test('bladeren gaat tot MAX_OFFSET; daarna een fout met de uitweg, geen stille lege pagina', () => {
  assert.equal(parseListParams(spec, new URLSearchParams({ offset: String(MAX_OFFSET) })).offset, MAX_OFFSET);
  rejects(() => parseListParams(spec, new URLSearchParams({ offset: String(MAX_OFFSET + 1) })), /updated_since/, 'offset');
  rejects(() => parseListParams(spec, new URLSearchParams({ offset: '99999999999999999999' })), /offset/, 'offset');
});

test('een e-mailfilter vergelijkt in kleine letters (zo staan adressen opgeslagen)', () => {
  const params = parseListParams(spec, new URLSearchParams({ email: 'Info@Bedrijf.NL' }));
  assert.deepEqual(params.filters, [{ column: 'email', op: 'eq', value: 'info@bedrijf.nl' }]);
});

test('een veld uit een module die je niet mag lezen, komt als null terug', () => {
  const row = { id: '1', name: 'a', rate: 95 };
  assert.equal(presentRow(spec, row).rate, 95, 'zonder rechtencheck: alles');
  assert.equal(presentRow(spec, row, () => true).rate, 95);
  const hidden = presentRow(spec, row, (module) => module !== 'finance');
  assert.equal(hidden.rate, null);
  assert.equal(hidden.name, 'a');
  assert.ok('rate' in hidden, 'het veld blijft bestaan, zodat een koppeling niet denkt dat het schema veranderde');
});

test('een veld uit een module waar je niet mag schrijven, kun je niet zetten', () => {
  const noFinance = (module: string) => module !== 'finance';
  assert.deepEqual(fieldsOutsideWrite(spec, { name: 'a', rate: 1 }, noFinance), ['rate']);
  assert.deepEqual(fieldsOutsideWrite(spec, { name: 'a' }, noFinance), []);
  assert.deepEqual(fieldsOutsideWrite(spec, { name: 'a', rate: 1 }, () => true), []);
});
