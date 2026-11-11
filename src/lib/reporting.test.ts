/**
 * De rapportbouwer: rapporteren per accountlead en per toegewezen teamlid.
 * Draaien met:  npm test
 *
 * Een opgeslagen rapport filtert op een user-id, niet op een naam: de naam is
 * het e-mailadres en dat kan veranderen. En één gedeeld rapport "mijn
 * openstaande tickets" moet voor elke collega zijn eigen cijfers geven.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppData, Client, Invoice, OrganizationMember, Ticket } from '../types.ts';
import { REPORT_SOURCES, REPORT_TEMPLATES, describeReportDefinition, runReport, type ReportDefinition } from './reporting.ts';

const ANNA = 'u-anna';
const BRAM = 'u-bram';
const members = [
  { user_id: ANNA, email: 'anna@bureau.nl', role: 'member', status: 'active' },
  { user_id: BRAM, email: 'bram@bureau.nl', role: 'member', status: 'active' },
] as OrganizationMember[];

const client = (id: string, lead: string | null) => ({ id, name: id, account_lead_user_id: lead, status: 'active', created_at: '2026-01-01T10:00:00Z' }) as unknown as Client;
const invoice = (id: string, clientId: string, amount: number) => ({
  id, client_id: clientId, status: 'paid', date: '2026-03-01', lines: [{ id: `${id}-1`, description: 'Werk', quantity: 1, unit_price: amount, vat: 0 }],
}) as unknown as Invoice;
const ticket = (id: string, status: string, assignee: string | null, clientId: string | null = null) => ({
  id, title: id, status, priority: 'med', client_id: clientId, assignee_user_id: assignee, created_at: '2026-04-01T10:00:00Z',
}) as unknown as Ticket;

const data = {
  clients: [client('jansen', ANNA), client('devries', ANNA), client('bakker', null), client('smit', BRAM)],
  projects: [], suppliers: [],
  invoices: [invoice('f1', 'jansen', 100), invoice('f2', 'devries', 50), invoice('f3', 'bakker', 7), invoice('f4', 'smit', 20)],
  tickets: [ticket('t1', 'new', ANNA), ticket('t2', 'review', ANNA), ticket('t3', 'resolved', ANNA), ticket('t4', 'new', null), ticket('t5', 'approved', BRAM, 'smit')],
} as unknown as AppData;

const def = (patch: Partial<ReportDefinition>): ReportDefinition => ({
  source: 'invoices', measure: { field: '*', agg: 'count' }, dimension: null, granularity: 'month', filters: [], datePreset: 'all', chart: 'kpi', ...patch,
});

test('omzet per accountlead loopt via de klant; zonder accountlead is een eigen groep', () => {
  const result = runReport(def({ measure: { field: 'subtotal', agg: 'sum' }, dimension: 'account_lead', chart: 'bar' }), data, { members });
  assert.deepEqual(result.rows.map(r => [r.label, r.value]), [['anna@bureau.nl', 150], ['bram@bureau.nl', 20], ['Geen accountlead', 7]]);
});

test('openstaande tickets per teamlid: het filter "open" en de groep "niet toegewezen"', () => {
  const result = runReport(def({ source: 'tickets', dimension: 'assignee', filters: [{ field: 'open', value: 'yes' }], chart: 'bar' }), data, { members });
  // Grootste eerst; bij een gelijke stand de volgorde waarin ze voorkomen.
  assert.deepEqual(result.rows.map(r => [r.label, r.value]), [['anna@bureau.nl', 2], ['Niet toegewezen', 1], ['bram@bureau.nl', 1]]);
});

test('filteren op een teamlid gaat op id; "me" is wie het rapport bekijkt', () => {
  const onAnna = def({ source: 'tickets', filters: [{ field: 'assignee', value: ANNA }] });
  assert.equal(runReport(onAnna, data, { members }).total, 3);
  const mine = def({ source: 'tickets', filters: [{ field: 'assignee', value: 'me' }] });
  assert.equal(runReport(mine, data, { members, currentUserId: BRAM }).total, 1);
  assert.equal(runReport(mine, data, { members, currentUserId: ANNA }).total, 3);
  // Zonder ingelogde gebruiker is "mij" niemand, niet iedereen.
  assert.equal(runReport(mine, data, { members }).total, 0);
  const nobody = def({ source: 'tickets', filters: [{ field: 'assignee', value: 'none' }] });
  assert.equal(runReport(nobody, data, { members }).total, 1);
  // Accountlead van de klant van het ticket.
  const leadBram = def({ source: 'tickets', filters: [{ field: 'account_lead', value: BRAM }] });
  assert.equal(runReport(leadBram, data, { members }).total, 1);
});

test('een teamlid dat er niet meer is, heet "Oud-teamlid" en verdwijnt niet uit de cijfers', () => {
  const result = runReport(def({ source: 'clients', dimension: 'account_lead', chart: 'bar' }), data, { members: members.filter(m => m.user_id !== BRAM) });
  assert.deepEqual(result.rows.map(r => [r.label, r.value]), [['anna@bureau.nl', 2], ['Geen accountlead', 1], ['Oud-teamlid', 1]]);
});

test('de filterkeuzes van een teamlidveld: ik, niemand en elk teamlid', () => {
  const field = REPORT_SOURCES.tickets.fields.find(f => f.key === 'assignee');
  assert.ok(field?.filterOptions);
  const options = field.filterOptions({ memberName: (id) => members.find(m => m.user_id === id)?.email ?? 'Oud-teamlid', currentUserId: null, members });
  assert.deepEqual(options.map(o => o.value), ['me', 'none', ANNA, BRAM]);
});

test('elk sjabloon gebruikt velden die bestaan', () => {
  for (const template of REPORT_TEMPLATES) {
    const source = REPORT_SOURCES[template.definition.source];
    assert.ok(source, template.name);
    const keys = new Set(source.fields.map(f => f.key));
    if (template.definition.dimension) assert.ok(keys.has(template.definition.dimension), `${template.name}: dimensie ${template.definition.dimension}`);
    if (template.definition.measure.agg !== 'count') assert.ok(keys.has(template.definition.measure.field), `${template.name}: meetwaarde`);
    for (const filter of template.definition.filters) {
      const field = source.fields.find(f => f.key === filter.field);
      assert.ok(field, `${template.name}: filter ${filter.field}`);
      if (field.enumValues) assert.ok(field.enumValues.some(e => e.value === filter.value), `${template.name}: waarde ${filter.value}`);
    }
  }
});

test('de omschrijving op Gerries voorstelkaart toont nooit een user-id', () => {
  const text = describeReportDefinition(def({ source: 'tickets', filters: [{ field: 'assignee', value: ANNA }] }));
  assert.doesNotMatch(text, /u-anna/);
  assert.match(text, /Toegewezen aan: een teamlid/);
  assert.match(describeReportDefinition(def({ source: 'tickets', filters: [{ field: 'assignee', value: ANNA }] }), { members }), /Toegewezen aan: anna@bureau\.nl/);
});
