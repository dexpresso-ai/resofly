import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amsterdamDay, amsterdamDayStartIso, MAX_SCAN_ROWS, parseRecordsQuery, periodBucket, RecordsQueryError, runRecordsQuery,
  type RecordsDb,
} from './reportRecords.ts';

// Een nep-database die de vraagvorm van supabase-js nabootst: filters worden
// vastgelegd en echt toegepast, en elke pagina geeft hooguit 1000 regels, net als
// PostgREST op staging (max_rows). Zo toetsen we ook het pagineren.
type Row = Record<string, unknown>;
interface Call { table: string; filters: string[]; ranges: Array<[number, number]> }

function fakeDb(tables: Record<string, Row[]>, calls: Call[] = []): RecordsDb {
  return {
    from(table: string) {
      const call: Call = { table, filters: [], ranges: [] };
      calls.push(call);
      const preds: Array<(r: Row) => boolean> = [];
      const get = (r: Row, column: string) => column.includes('.')
        ? (r[column.split('.')[0]] as Row | undefined)?.[column.split('.')[1]]
        : r[column];
      let order: string | null = null;
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) { call.filters.push(`${column}=${value}`); preds.push((r) => String(get(r, column)) === String(value)); return builder; },
        in(column: string, values: unknown[]) { call.filters.push(`${column} in ${values.join(',')}`); preds.push((r) => values.map(String).includes(String(get(r, column)))); return builder; },
        is(column: string, value: unknown) { call.filters.push(`${column} is ${value}`); preds.push((r) => (get(r, column) ?? null) === value); return builder; },
        gte(column: string, value: string) { call.filters.push(`${column}>=${value}`); preds.push((r) => get(r, column) != null && String(get(r, column)) >= value); return builder; },
        lte(column: string, value: string) { call.filters.push(`${column}<=${value}`); preds.push((r) => get(r, column) != null && String(get(r, column)) <= value); return builder; },
        lt(column: string, value: string) { call.filters.push(`${column}<${value}`); preds.push((r) => get(r, column) != null && String(get(r, column)) < value); return builder; },
        order(column: string) { order = column; return builder; },
        range(from: number, to: number) {
          call.ranges.push([from, to]);
          let rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
          if (order) rows = [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
          const end = Math.min(to, from + 999);
          return Promise.resolve({ data: rows.slice(from, end + 1), error: null });
        },
      };
      return builder;
    },
  };
}

const ORG = 'org-1';
const ctx = (tables: Record<string, Row[]>, opts: { finance?: boolean; calls?: Call[]; modules?: string[] } = {}) => ({
  db: fakeDb(tables, opts.calls),
  organizationId: ORG,
  today: '2026-11-09',
  canRead: (m: string) => (opts.modules ? opts.modules.includes(m) : (m !== 'finance' || opts.finance !== false)),
});

const line = (quantity: number, unit_price: number, vat = 21) => ({ quantity, unit_price, vat });

test('omzet per maand: exact in centen, alleen deze organisatie, lege maanden opgevuld', async () => {
  const calls: Call[] = [];
  const invoices: Row[] = [
    { id: 'a', organization_id: ORG, status: 'paid', date: '2026-01-15', client_id: 'c1', lines: [line(1, 0.1), line(2, 0.1)] },
    { id: 'b', organization_id: ORG, status: 'sent', date: '2026-01-20', client_id: 'c1', lines: [line(1, 100)] },
    { id: 'c', organization_id: ORG, status: 'draft', date: '2026-01-21', client_id: 'c1', lines: [line(1, 999)] },
    { id: 'd', organization_id: ORG, status: 'paid', date: '2026-03-02', client_id: 'c2', lines: [], subtotal_amount: 50, vat_amount: 10.5, total_amount: 60.5 },
    { id: 'x', organization_id: 'andere-org', status: 'paid', date: '2026-02-01', client_id: 'c9', lines: [line(1, 5000)] },
  ];
  const clients: Row[] = [{ id: 'c1', organization_id: ORG, name: 'Jansen' }, { id: 'c2', organization_id: ORG, name: 'De Vries' }];
  const result = await runRecordsQuery(ctx({ invoices, clients, projects: [] }, { calls }), {
    source: 'invoices', from: '2026-01-01', to: '2026-04-30',
    filters: [{ field: 'status', op: 'in', value: ['sent', 'overdue', 'paid'] }],
    group_by: [{ field: 'date', period: 'month' }],
    measures: [{ agg: 'sum', field: 'subtotal_eur', as: 'omzet' }, { agg: 'count', as: 'aantal' }],
    fill_periods: true,
  });
  assert.deepEqual(result.groups, [
    { date_month: '2026-01', date_month_label: 'jan 2026', omzet: 100.3, aantal: 2 },
    { date_month: '2026-02', date_month_label: 'feb 2026', omzet: 0, aantal: 0 },
    { date_month: '2026-03', date_month_label: 'mrt 2026', omzet: 50, aantal: 1 },
    { date_month: '2026-04', date_month_label: 'apr 2026', omzet: 0, aantal: 0 },
  ]);
  assert.deepEqual(result.totals, { omzet: 150.3, aantal: 3 });
  assert.equal(result.matched, 3);
  assert.equal(result.truncated, false);
  // Elke vraag aan de database noemt de organisatie.
  for (const call of calls) assert.ok(call.filters.includes(`organization_id=${ORG}`), `${call.table} zonder organisatiefilter`);
  // Status en periode gaan al in de databasevraag mee.
  const inv = calls.find((c) => c.table === 'invoices')!;
  assert.ok(inv.filters.includes('status in sent,overdue,paid'));
  assert.ok(inv.filters.includes('date>=2026-01-01') && inv.filters.includes('date<=2026-04-30'));
});

test('per klant: namen uit de opzoeklijst, grootste eerst', async () => {
  const invoices: Row[] = [
    { id: 'a', organization_id: ORG, status: 'paid', date: '2026-01-15', client_id: 'c1', lines: [line(1, 10)] },
    { id: 'b', organization_id: ORG, status: 'paid', date: '2026-02-15', client_id: 'c2', lines: [line(1, 30)] },
    { id: 'c', organization_id: ORG, status: 'paid', date: '2026-02-16', client_id: null, lines: [line(1, 5)] },
  ];
  const clients: Row[] = [{ id: 'c1', organization_id: ORG, name: 'Jansen' }, { id: 'c2', organization_id: ORG, name: 'De Vries' }];
  const result = await runRecordsQuery(ctx({ invoices, clients, projects: [] }), {
    source: 'invoices', group_by: ['client_name'], measures: [{ agg: 'sum', field: 'total_eur', as: 'totaal' }],
  });
  assert.deepEqual(result.groups, [
    { client_name: 'De Vries', totaal: 36.3 },
    { client_name: 'Jansen', totaal: 12.1 },
    { client_name: null, totaal: 6.05 },
  ]);
});

test('pagineert tot alles binnen is, en meldt het als het plafond bereikt is', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({
    id: `t${String(i).padStart(5, '0')}`, organization_id: ORG, entry_date: '2026-10-01', minutes: 30, billable: true, project_id: null, client_id: null, user_id: 'u1',
  }));
  const calls: Call[] = [];
  const result = await runRecordsQuery(ctx({ time_entries: many, projects: [], clients: [], organization_members: [] }, { calls }), {
    source: 'time_entries', measures: [{ agg: 'sum', field: 'hours', as: 'uren' }],
  });
  assert.equal(result.totals?.uren, 1250);
  assert.equal(result.matched, 2500);
  assert.equal(result.truncated, false);
  // Elke pagina is een eigen databasevraag van hooguit duizend regels.
  const pages = calls.filter((c) => c.table === 'time_entries').flatMap((c) => c.ranges);
  assert.ok(pages.length >= 3, `verwacht meerdere pagina's, kreeg ${pages.length}`);
  assert.ok(pages.every(([from, to]) => to - from < 1000));

  const tooMany = Array.from({ length: MAX_SCAN_ROWS + 5 }, (_, i) => ({ id: `t${String(i).padStart(6, '0')}`, organization_id: ORG, entry_date: '2026-10-01', minutes: 60 }));
  const capped = await runRecordsQuery(ctx({ time_entries: tooMany, projects: [], clients: [], organization_members: [] }), {
    source: 'time_entries', measures: [{ agg: 'count', as: 'n' }],
  });
  assert.equal(capped.truncated, true);
  assert.equal(capped.totals?.n, MAX_SCAN_ROWS);
  assert.match(String(capped.note), /meer dan/);
});

test('zonder Financiën: geen financiële bron, en bedragen in andere bronnen blijven leeg', async () => {
  const tables = { invoices: [], clients: [{ id: 'c1', organization_id: ORG, name: 'Jansen', status: 'active', value_eur: 1200, created_at: '2026-01-02T10:00:00Z' }] };
  await assert.rejects(
    runRecordsQuery(ctx(tables, { modules: ['clients'] }), { source: 'invoices' }),
    (e: unknown) => e instanceof RecordsQueryError && /geen toegang/.test(String((e as Error).message)),
  );
  const result = await runRecordsQuery(ctx(tables, { modules: ['clients'] }), { source: 'clients' });
  assert.equal(result.rows?.[0].value_eur, null);
  assert.match(String(result.note), /Financiën/);
  const withFinance = await runRecordsQuery(ctx(tables), { source: 'clients' });
  assert.equal(withFinance.rows?.[0].value_eur, 1200);
});

test('een tijdstip telt op de Nederlandse kalenderdag', async () => {
  assert.equal(amsterdamDay('2026-03-31T22:30:00Z'), '2026-04-01');
  assert.equal(amsterdamDay('2026-01-31T23:30:00Z'), '2026-02-01');
  assert.equal(amsterdamDayStartIso('2026-07-01'), '2026-06-30T22:00:00.000Z');
  assert.equal(amsterdamDayStartIso('2026-01-01'), '2025-12-31T23:00:00.000Z');
  const tickets: Row[] = [
    { id: 'a', organization_id: ORG, status: 'resolved', created_at: '2026-03-31T22:30:00Z', resolved_at: '2026-04-01T10:30:00Z', client_id: null },
    { id: 'b', organization_id: ORG, status: 'new', created_at: '2026-03-31T12:00:00Z', resolved_at: null, client_id: null },
  ];
  const result = await runRecordsQuery(ctx({ tickets, clients: [] }), {
    source: 'tickets', group_by: [{ field: 'created_date', period: 'month' }], measures: [{ agg: 'count', as: 'n' }, { agg: 'avg', field: 'hours_to_resolve', as: 'doorloop' }],
  });
  assert.deepEqual(result.groups, [
    { created_date_month: '2026-03', created_date_month_label: 'mrt 2026', n: 1, doorloop: null },
    { created_date_month: '2026-04', created_date_month_label: 'apr 2026', n: 1, doorloop: 12 },
  ]);
});

test('boekingsregels: datum en status van de boeking, saldo debet min credit', async () => {
  const journal_lines: Row[] = [
    { id: 'l1', organization_id: ORG, entry_id: 'e1', account_id: 'r1', debit_cents: 0, credit_cents: 10000, journal_entries: { date: '2026-05-01', status: 'posted', entry_number: 'M1' } },
    { id: 'l2', organization_id: ORG, entry_id: 'e1', account_id: 'k1', debit_cents: 2500, credit_cents: 0, journal_entries: { date: '2026-05-01', status: 'posted', entry_number: 'M1' } },
    { id: 'l3', organization_id: ORG, entry_id: 'e2', account_id: 'r1', debit_cents: 0, credit_cents: 999, journal_entries: { date: '2026-05-02', status: 'draft', entry_number: 'M2' } },
  ];
  const ledger_accounts: Row[] = [
    { id: 'r1', organization_id: ORG, code: '8000', name: 'Omzet', type: 'revenue' },
    { id: 'k1', organization_id: ORG, code: '4000', name: 'Kosten', type: 'expense' },
  ];
  const calls: Call[] = [];
  const result = await runRecordsQuery(ctx({ journal_lines, ledger_accounts, clients: [], suppliers: [], projects: [] }, { calls }), {
    source: 'journal_lines', from: '2026-01-01', to: '2026-12-31',
    filters: [{ field: 'entry_status', op: 'eq', value: 'posted' }],
    group_by: ['account_type'], measures: [{ agg: 'sum', field: 'amount_eur', as: 'saldo' }],
  });
  assert.deepEqual(result.groups, [{ account_type: 'expense', saldo: 25 }, { account_type: 'revenue', saldo: -100 }]);
  const lines = calls.find((c) => c.table === 'journal_lines')!;
  assert.ok(lines.filters.includes('journal_entries.date>=2026-01-01'));
  assert.ok(lines.filters.includes('journal_entries.status=posted'));
});

test('de vraag wordt nagekeken, met een zin waar Gerrie mee verder kan', () => {
  const fails = (input: unknown, pattern: RegExp) => assert.throws(() => parseRecordsQuery(input), (e: unknown) => e instanceof RecordsQueryError && pattern.test((e as Error).message));
  fails({ source: 'geheim' }, /Onbekende bron/);
  fails({ source: 'invoices', group_by: ['omzet'] }, /bestaat niet/);
  fails({ source: 'invoices', filters: [{ field: 'status', op: 'eq', value: 'betaald' }] }, /Ongeldige waarde/);
  fails({ source: 'invoices', from: '2026-02-30' }, /datum/);
  fails({ source: 'invoices', measures: [{ agg: 'sum', field: 'client_name' }] }, /getal of bedrag/);
  fails({ source: 'invoices', group_by: [{ field: 'client_name', period: 'month' }] }, /datumveld/);
  fails({ source: 'invoices', group_by: ['a', 'b', 'c'] }, /hoogstens twee/);
  const q = parseRecordsQuery({ source: 'invoices', group_by: ['status'] });
  assert.deepEqual(q.measures, [{ field: null, agg: 'count', as: 'count' }]);
});

test('perioden: week, kwartaal en jaar', () => {
  assert.deepEqual(periodBucket('2026-01-01', 'week'), { key: '2026-W01', label: 'wk 1 2026' });
  assert.deepEqual(periodBucket('2027-01-01', 'week'), { key: '2026-W53', label: 'wk 53 2026' });
  assert.deepEqual(periodBucket('2026-11-09', 'quarter'), { key: '2026-Q4', label: 'Q4 2026' });
  assert.deepEqual(periodBucket('2026-11-09', 'year'), { key: '2026', label: '2026' });
});

// Accountlead en toegewezen teamlid (20261111160000). Rapporteren "per
// accountlead" of "per behandelaar" moet kloppen, en de accountlead blijft leeg
// voor wie Klanten niet mag lezen: wie welke klant beheert is klantinformatie.
test('omzet per accountlead: via de klant, en leeg zonder leesrecht op Klanten', async () => {
  const invoices: Row[] = [
    { id: 'a', organization_id: ORG, status: 'paid', date: '2026-02-01', client_id: 'c1', lines: [line(1, 100)] },
    { id: 'b', organization_id: ORG, status: 'paid', date: '2026-03-01', client_id: 'c2', lines: [line(1, 50)] },
    { id: 'c', organization_id: ORG, status: 'paid', date: '2026-03-02', client_id: 'c3', lines: [line(1, 7)] },
  ];
  const clients: Row[] = [
    { id: 'c1', organization_id: ORG, name: 'Jansen', account_lead_user_id: 'u1' },
    { id: 'c2', organization_id: ORG, name: 'De Vries', account_lead_user_id: 'u1' },
    { id: 'c3', organization_id: ORG, name: 'Bakker', account_lead_user_id: null },
  ];
  const organization_members: Row[] = [{ user_id: 'u1', organization_id: ORG, email: 'anna@bureau.nl' }];
  const tables = { invoices, clients, projects: [], organization_members };
  const result = await runRecordsQuery(ctx(tables), {
    source: 'invoices', group_by: ['account_lead'], measures: [{ agg: 'sum', field: 'subtotal_eur', as: 'omzet' }],
  });
  const byLead = Object.fromEntries((result.groups ?? []).map((g) => [String(g.account_lead), g.omzet]));
  assert.deepEqual(byLead, { 'anna@bureau.nl': 150, null: 7 });

  const filtered = await runRecordsQuery(ctx(tables), {
    source: 'invoices', filters: [{ field: 'account_lead_id', op: 'eq', value: 'u1' }], measures: [{ agg: 'count', as: 'n' }],
  });
  assert.equal(filtered.groups?.[0]?.n, 2);

  // De boekhouder: Financiën wel, Klanten niet.
  const accountant = await runRecordsQuery(ctx(tables, { modules: ['finance'] }), { source: 'invoices', fields: ['number', 'account_lead_id', 'account_lead'] });
  assert.ok((accountant.rows ?? []).every((r) => r.account_lead === null && r.account_lead_id === null));
  assert.match(String(accountant.note), /Klanten/);
});

test('tickets per toegewezen teamlid, met filter in de databasevraag', async () => {
  const calls: Call[] = [];
  const tickets: Row[] = [
    { id: 't1', organization_id: ORG, status: 'new', created_at: '2026-05-01T09:00:00Z', client_id: null, assignee_user_id: 'u1' },
    { id: 't2', organization_id: ORG, status: 'review', created_at: '2026-05-02T09:00:00Z', client_id: null, assignee_user_id: 'u2' },
    { id: 't3', organization_id: ORG, status: 'new', created_at: '2026-05-03T09:00:00Z', client_id: null, assignee_user_id: null },
    { id: 'x', organization_id: 'org-2', status: 'new', created_at: '2026-05-03T09:00:00Z', client_id: null, assignee_user_id: 'u1' },
  ];
  const organization_members: Row[] = [
    { user_id: 'u1', organization_id: ORG, email: 'anna@bureau.nl' },
    { user_id: 'u2', organization_id: ORG, email: 'bram@bureau.nl' },
  ];
  const grouped = await runRecordsQuery(ctx({ tickets, clients: [], organization_members }), {
    source: 'tickets', group_by: ['assignee'], measures: [{ agg: 'count', as: 'n' }],
  });
  const byAssignee = Object.fromEntries((grouped.groups ?? []).map((g) => [String(g.assignee), g.n]));
  assert.deepEqual(byAssignee, { 'anna@bureau.nl': 1, 'bram@bureau.nl': 1, null: 1 });

  const mine = await runRecordsQuery(ctx({ tickets, clients: [], organization_members }, { calls }), {
    source: 'tickets', filters: [{ field: 'assignee_id', op: 'eq', value: 'u1' }], fields: ['id', 'assignee'],
  });
  assert.deepEqual(mine.rows, [{ id: 't1', assignee: 'anna@bureau.nl' }]);
  assert.ok(calls.some((c) => c.table === 'tickets' && c.filters.includes('assignee_user_id=u1')));
});
