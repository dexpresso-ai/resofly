import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_ACTIONS } from './actions/content.ts';
import { WORK_ACTIONS } from './actions/work.ts';
import { REMOVAL_ACTIONS } from './actions/removal.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';

/**
 * De regels van de handelingen die erbij kwamen toen Gerrie "alles wat de app
 * kan" moest kunnen (november 2026): inhoud, de losse knoppen en verwijderen.
 *
 * Met een nep-database: plan() en read() draaien echt, alleen de rijen zijn
 * verzonnen. Wat hier staat, zijn de grenzen die de gebruiker niet mag merken
 * door een fout: de bewaarplicht, de modulerechten, delen binnen het eigen
 * klantdossier, en dat verwijderen altijd langs een mens gaat.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const ME = '00000000-0000-4000-8000-0000000000a1';
const ID = 'c0000000-0000-4000-8000-000000000001';
const OTHER = 'c0000000-0000-4000-8000-000000000002';

/** Een database die per tabel dezelfde rij(en) teruggeeft, ook als telling. */
function fakeDb(rows: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const list = rows[table] ?? [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const name of ['select', 'eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'neq', 'not', 'or', 'ilike']) chain[name] = self;
      chain.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
      chain.single = async () => ({ data: list[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: list, error: null, count: list.length });
      return chain;
    },
    rpc() { throw new Error('geen rpc in deze test'); },
  };
}

function ctx(rows: Record<string, Array<Record<string, unknown>>>, access: { read?: string[]; write?: string[] } = { write: ['clients', 'projects', 'time', 'calendar', 'tickets', 'content', 'stats', 'marketing', 'finance', 'chat'] }): ActionCtx {
  return {
    organizationId: ORG, userId: ME, role: 'member', today: '2026-11-10',
    db: fakeDb(rows),
    canRead: (module) => (access.read ?? []).includes(module) || (access.write ?? []).includes(module),
    canWrite: (module) => (access.write ?? []).includes(module),
  };
}

const ALL = [...CONTENT_ACTIONS, ...WORK_ACTIONS, ...REMOVAL_ACTIONS];
function action(id: string): ActionDef {
  const found = ALL.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

async function refuses(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => error instanceof ActionError && pattern.test(error.message));
}

test('elke verwijderhandeling is onomkeerbaar gemarkeerd en gaat altijd langs een mens', async () => {
  for (const def of REMOVAL_ACTIONS) {
    assert.equal(def.kind, 'write', def.id);
    assert.equal(def.risk, 'high', `${def.id} hoort risk 'high' te hebben`);
  }
  const plan = await action('task.delete').plan!(ctx({ tasks: [{ title: 'Offerte nalopen', project_id: null, status: 'todo' }] }), { task_id: ID });
  assert.equal(plan.risk, 'high');
  assert.equal(plan.humanOnly, true);
  assert.match(plan.warning ?? '', /niet ongedaan/);
});

test('bewaarplicht: een verstuurde of geboekte factuur verwijder je niet', async () => {
  const del = action('invoice.delete_draft');
  await refuses(del.plan!(ctx({ invoices: [{ number: 'F-1', status: 'sent', journal_entry_id: null, sent_at: '2026-11-01', client_id: null }] }), { invoice_id: ID }), /bewaarplicht/);
  await refuses(del.plan!(ctx({ invoices: [{ number: 'F-2', status: 'draft', journal_entry_id: OTHER, sent_at: null, client_id: null }] }), { invoice_id: ID }), /grootboek/);
  const ok = await del.plan!(ctx({ invoices: [{ number: 'F-3', status: 'draft', journal_entry_id: null, sent_at: null, client_id: null }] }), { invoice_id: ID });
  assert.equal(ok.humanOnly, true);
});

test('bewaarplicht: een offerte die naar de klant ging, verwijder je niet', async () => {
  const del = action('quote.delete_draft');
  await refuses(del.plan!(ctx({ quotes: [{ number: 'O-1', status: 'draft', sent_at: '2026-11-01', client_decision_at: null, client_id: null }] }), { quote_id: ID }), /bewaarplicht/);
  await refuses(del.plan!(ctx({ quotes: [{ number: 'O-2', status: 'accepted', sent_at: null, client_decision_at: null, client_id: null }] }), { quote_id: ID }), /bewaarplicht/);
});

test('een klant met facturen of offertes kan niet weg', async () => {
  await refuses(action('client.delete').plan!(ctx({ clients: [{ name: 'Jansen BV' }], invoices: [{ id: ID }], quotes: [] }), { client_id: ID }), /bewaarplicht/);
});

test('een actiepunt van een collega haal je niet weg', async () => {
  await refuses(action('week_action.delete').plan!(ctx({ planner_notes: [{ text: 'Bellen', user_id: OTHER, week_start: '2026-11-09' }] }), { note_id: ID }), /collega/);
});

test('crediteren en intrekken alleen vanuit de juiste status', async () => {
  await refuses(action('invoice.credit').plan!(ctx({ invoices: [{ number: 'F-1', status: 'draft', client_id: null, total_amount: 100 }] }), { invoice_id: ID }), /concept/);
  await refuses(action('invoice.credit').plan!(ctx({ invoices: [{ number: 'F-1', status: 'paid', client_id: null, total_amount: 100 }] }), { invoice_id: ID }), /betaald/);
  const credit = await action('invoice.credit').plan!(ctx({ invoices: [{ number: 'F-1', status: 'sent', client_id: null, total_amount: 121 }] }), { invoice_id: ID });
  assert.match(credit.warning ?? '', /niet ongedaan/);
  await refuses(action('quote.withdraw').plan!(ctx({ quotes: [{ number: 'O-1', status: 'accepted', client_id: null }] }), { quote_id: ID }), /geaccepteerd/);
});

test('tekst vervangen krijgt een waarschuwing, aanvullen niet', async () => {
  const update = action('note.update');
  const rows = { notes: [{ title: 'Kick-off', content: '<p>Afspraken</p>', client_id: null, project_id: null }] };
  const replace = await update.plan!(ctx(rows), { note_id: ID, content: 'Nieuwe tekst' });
  assert.equal(replace.risk, 'high');
  assert.match(replace.warning ?? '', /vervangen/);
  const append = await update.plan!(ctx(rows), { note_id: ID, content: 'Actiepunt: bellen', content_mode: 'append' });
  assert.equal(append.risk, undefined);
  assert.equal((append.payload as { content_mode: string }).content_mode, 'append');
});

test('een Word-document bewerk je niet als tekst', async () => {
  const rows = { documents: [{ title: 'Contract', content: '', client_id: null, project_id: null, storage_key: 'org/doc.docx' }] };
  await refuses(action('document.update').plan!(ctx(rows), { document_id: ID, content: 'Nieuwe tekst' }), /Word/);
  // Titel en soort kunnen wel.
  const plan = await action('document.update').plan!(ctx(rows), { document_id: ID, title: 'Contract 2027' });
  assert.equal((plan.payload as { patch: Record<string, unknown> }).patch.title, 'Contract 2027');
});

test('een bestand aan een factuur wijzig je alleen met schrijfrecht in Financiën', async () => {
  const rows = { attachments: [{ name: 'bon.pdf', entity_type: 'invoice', entity_id: OTHER }] };
  await refuses(action('attachment.rename').plan!(ctx(rows, { write: ['content'] }), { attachment_id: ID, name: 'nieuw' }), /niet wijzigen/);
  const ok = await action('attachment.rename').plan!(ctx(rows, { write: ['content', 'finance'] }), { attachment_id: ID, name: 'nieuw' });
  assert.equal((ok.payload as { name: string }).name, 'nieuw.pdf', 'de extensie blijft staan');
});

test('zoeken laat bestanden uit modules zonder leesrecht weg, en chatbijlagen altijd', async () => {
  const rows = {
    notes: [], documents: [], content_folders: [],
    attachments: [
      { id: ID, name: 'offerte jansen.pdf', entity_type: 'invoice', entity_id: OTHER, mime_type: 'application/pdf', size_bytes: 1000, created_at: '2026-11-01' },
      { id: OTHER, name: 'offerte jansen.png', entity_type: 'chat_message', entity_id: OTHER, mime_type: 'image/png', size_bytes: 1000, created_at: '2026-11-02' },
      { id: ME, name: 'offerte jansen.docx', entity_type: 'folder', entity_id: OTHER, mime_type: 'x', size_bytes: 1000, created_at: '2026-11-03' },
    ],
  };
  const result = await action('content.search').read!(ctx(rows, { read: ['content'] }), { query: 'offerte jansen', kind: 'files' }) as { results: Array<{ id: string }> };
  assert.deepEqual(result.results.map((r) => r.id), [ME]);
});

test('delen blijft binnen het eigen klantdossier', async () => {
  const share = action('drive.share');
  const clientNote = { notes: [{ title: 'Verslag', client_id: OTHER }] };
  // Een los e-mailadres voor iets uit een klantdossier: nee.
  await refuses(share.plan!(ctx(clientNote), { item_type: 'note', item_id: ID, emails: ['iemand@elders.nl'] }), /klantdossier/);
  // Een contactpersoon van een andere klant: nee.
  await refuses(share.plan!(ctx({ ...clientNote, client_contacts: [{ id: ME, name: 'Piet', email: 'piet@x.nl', client_id: ID, is_active: true }] }),
    { item_type: 'note', item_id: ID, contact_ids: [ME] }), /andere klant/);
  // Dezelfde klant: ja, en de kaart zegt dat de ontvanger het ziet.
  const ok = await share.plan!(ctx({ ...clientNote, client_contacts: [{ id: ME, name: 'Piet', email: 'piet@x.nl', client_id: OTHER, is_active: true }] }),
    { item_type: 'note', item_id: ID, contact_ids: [ME] });
  assert.equal(ok.kind, 'mail');
  assert.ok(ok.warning);
});

test('een teamchatbericht draagt de afzender van het voorstel mee', async () => {
  const dm = action('teamchat.send_dm');
  await refuses(dm.plan!(ctx({ organization_members: [{ email: 'ik@org.nl', status: 'active' }] }), { user_id: ME, body: 'Hoi' }), /zelf/);
  const plan = await dm.plan!(ctx({ organization_members: [{ email: 'piet@org.nl', status: 'active' }] }), { user_id: OTHER, body: 'De offerte is eruit.' });
  assert.equal((plan.payload as { sender_user_id: string }).sender_user_id, ME);
});

test('weekplanner-capaciteit is van wie het vraagt, niet van wie goedkeurt', async () => {
  const plan = await action('planner.set_day_capacity').plan!(ctx({}), { hours: 6 });
  assert.deepEqual(plan.payload, { user_id: ME, minutes: 360, include_weekend: false });
});

test('instellingen zijn alleen voor owners en admins', () => {
  assert.equal(action('settings.set_ticket_emails').adminOnly, true);
  assert.equal(action('settings.save_jitsi_server').adminOnly, true);
});
