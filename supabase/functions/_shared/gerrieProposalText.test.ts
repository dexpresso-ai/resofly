import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatProposalText, historyContent, OLD_INVOICE_FALLBACK } from './gerrieProposalText.ts';

// Gerrie zei "Ik heb een conceptfactuur voor je klaargezet" bij elk voorstel dat
// niet in zijn lijst stond: uren op een project, een projectteam, een taak
// toewijzen, een agent, en alles uit de handelingenregistry. Deze tests houden
// vast dat elk soort voorstel zijn eigen naam krijgt.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const core = read('./gerrieCore.ts');
const textSource = read('./gerrieProposalText.ts');

/** De soorten voorstel uit de union `type Proposal = …` in gerrieCore.ts. */
function proposalTypes(): string[] {
  const union = core.match(/^type Proposal = ([^;]+);/m);
  assert.ok(union, 'type Proposal niet gevonden in gerrieCore.ts');
  const names = union[1].split('|').map((s) => s.trim()).filter(Boolean);
  return names.map((name) => {
    const decl = core.match(new RegExp(`interface ${name}\\s*\\{\\s*type:\\s*'([a-z_]+)'`));
    assert.ok(decl, `interface ${name} zonder type-veld`);
    return decl[1];
  });
}

test('elk soort voorstel heeft een eigen zin in de chat', () => {
  const types = proposalTypes();
  assert.ok(types.length >= 35, `maar ${types.length} soorten gevonden; klopt de regex nog?`);
  const missing = types.filter((t) => !textSource.includes(`case '${t}':`));
  assert.deepEqual(missing, [], 'Deze voorstellen hebben geen zin in chatProposalText en vallen terug op een algemene tekst.');
});

const notInvoice: Array<[string, Record<string, unknown>, string]> = [
  ['action', { type: 'action', action_id: 'project_template.create', title: 'Projectsjabloon aanmaken: Website', sub: '', kind: 'work', risk: 'normal', payload: {} }, 'Projectsjabloon aanmaken: Website'],
  ['action (definitief)', { type: 'action', action_id: 'project.delete', title: 'Project "Website" verwijderen', sub: '', kind: 'work', risk: 'high', payload: {} }, 'Project "Website" verwijderen'],
  ['project', { type: 'project', name: 'Website', client_id: null, client_name: '', description: null, start_date: null, end_date: null }, 'project "Website"'],
  ['time_entry', { type: 'time_entry', project_id: 'p1', project_name: 'Website', client_id: null, client_name: null, date: '2026-11-14', minutes: 90, description: null, billable: true, hourly_rate_cents: null }, '1 uur en 30 minuten registreer op project "Website"'],
  ['project_team', { type: 'project_team', project_id: 'p1', project_name: 'Website', add: [{ user_id: 'u1', name: 'Anna' }, { user_id: 'u2', name: 'Bram' }], remove: [] }, 'teamwijziging voor project "Website" klaargezet (erbij: Anna en Bram)'],
  ['task_assign', { type: 'task_assign', task_id: 't1', task_title: 'Logo', project_name: 'Website', assignees: [{ user_id: 'u1', name: 'Anna' }] }, 'taak "Logo" toewijs aan Anna'],
  ['agent', { type: 'agent', name: 'Maandag-overzicht' }, 'agent "Maandag-overzicht"'],
  ['client_contact', { type: 'client_contact', client_id: 'c1', client_name: 'Jansen BV', name: 'Piet', email: null, phone: null, role: null, gives_portal_access: false }, 'Piet als contactpersoon toevoeg bij Jansen BV'],
  ['edit_client_contact', { type: 'edit_client_contact', id: 'k1', name: 'Piet', client_name: 'Jansen BV', changes: {} }, 'contactpersoon Piet (Jansen BV)'],
  ['edit_calendar_event', { type: 'edit_calendar_event', title: 'Kick-off' }, 'agenda-item "Kick-off" aanpas'],
  ['cancel_calendar_event', { type: 'cancel_calendar_event', title: 'Kick-off', has_attendees: true }, 'agenda-item "Kick-off" afzeg? De genodigden krijgen dan een afzegging.'],
  ['send_client_email', { type: 'send_client_email', items: [{ client_name: 'Jansen BV' }], total: 1 }, 'mail aan Jansen BV'],
  ['task', { type: 'task', title: 'Logo' }, 'taak "Logo"'],
];

for (const [label, proposal, expected] of notInvoice) {
  test(`${label}: de chat noemt het bij zijn naam, niet "factuur"`, () => {
    const text = chatProposalText(proposal as never);
    assert.ok(text.includes(expected), `"${text}" mist "${expected}"`);
    assert.doesNotMatch(text, /factuur/i);
  });
}

test('een onomkeerbare handeling zegt dat erbij', () => {
  const text = chatProposalText({ type: 'action', action_id: 'project.delete', title: 'Project "Website" verwijderen.', sub: '', kind: 'work', risk: 'high', payload: {} } as never);
  assert.match(text, /niet terugdraaien/);
  assert.doesNotMatch(text, /verwijderen\.\./);
});

test('een factuur heet nog steeds een factuur, met de klant erbij', () => {
  const text = chatProposalText({ type: 'invoice', client_id: 'c1', client_name: 'Jansen BV', lines: [], notes: null, due_date: null, total_eur: 100 } as never);
  assert.match(text, /conceptfactuur voor Jansen BV/);
});

test('een onbekende soort voorstel krijgt een neutrale zin, nooit "factuur"', () => {
  const text = chatProposalText({ type: 'iets_nieuws' } as never);
  assert.doesNotMatch(text, /factuur/i);
  assert.match(text, /klaargezet/);
});

const LABELS = { propose_project: 'Project aanmaken', propose_time_entry: 'Uren registreren' };

test('oud gesprek: de verkeerde factuurzin onder een project verdwijnt bij het teruglezen', () => {
  const out = historyContent(OLD_INVOICE_FALLBACK, [{ name: 'list_projects', input: {} }, { name: 'propose_project', input: { name: 'Website' } }], LABELS);
  assert.doesNotMatch(out, /factuur/i);
  assert.equal(out, '[Eerder voorgesteld: project aanmaken ("Website").]');
});

test('oud gesprek: onder een echte factuur blijft de zin staan', () => {
  const out = historyContent(OLD_INVOICE_FALLBACK, [{ name: 'propose_invoice', input: { client_id: 'c1', lines: [{ quantity: 2, description: 'Uren', unit_price: 50, vat: 21 }] } }], LABELS);
  assert.ok(out.startsWith(OLD_INVOICE_FALLBACK));
  assert.match(out, /conceptfactuur voor client_id c1; regels: 2× Uren à €50 \(21% btw\)/);
});

test('nieuw gesprek: de bewaarde omschrijving van het voorstel komt in de notitie', () => {
  const out = historyContent('Ik heb het klaargezet.', [{ name: 'propose_time_entry', input: { minutes: 90 }, summary: '90 minuten urenregistratie' }], LABELS);
  assert.equal(out, 'Ik heb het klaargezet.\n[Eerder voorgesteld: 90 minuten urenregistratie.]');
});

test('een handeling uit de registry zonder omschrijving noemt het id', () => {
  const out = historyContent('', [{ name: 'propose_action', input: { action_id: 'project_template.create' } }], LABELS);
  assert.equal(out, '[Eerder voorgesteld: de handeling project_template.create.]');
});

test('een bericht zonder voorstel blijft zoals het was', () => {
  assert.equal(historyContent('Je hebt 3 open facturen.', [{ name: 'list_invoices', input: {} }], LABELS), 'Je hebt 3 open facturen.');
  assert.equal(historyContent('Hoi', null, LABELS), 'Hoi');
});
