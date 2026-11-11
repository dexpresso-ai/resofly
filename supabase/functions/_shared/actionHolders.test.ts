import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_ACTIONS } from './actions/clients.ts';
import { TICKETS_ACTIONS } from './actions/tickets.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';

/**
 * Accountlead van een klant en de behandelaar van een ticket (20261111160000).
 *
 * De goedkeurkaart moet al zeggen dat iets niet kan, met dezelfde regel als de
 * database (public.member_can_hold): een actief teamlid van deze organisatie,
 * geen boekhouder, dat de module mag zien. Anders keurde iemand een kaart goed
 * die bij Uitvoeren op een databasefout stukliep.
 *
 * Met een nep-database: plan() draait echt, alleen de rijen zijn verzonnen.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const ME = '00000000-0000-4000-8000-0000000000a1';
const ANNA = '00000000-0000-4000-8000-0000000000b2';
const T1 = 'c0000000-0000-4000-8000-000000000001';
const T2 = 'c0000000-0000-4000-8000-000000000002';

/** Een database die op elke vraag dezelfde rij(en) teruggeeft. */
function fakeDb(rows: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const list = rows[table] ?? [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const name of ['select', 'eq', 'in', 'is', 'order', 'limit']) chain[name] = self;
      chain.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: list, error: null });
      return chain;
    },
    rpc() { throw new Error('geen rpc in deze test'); },
  };
}

function ctx(rows: Record<string, Array<Record<string, unknown>>>): ActionCtx {
  return {
    organizationId: ORG, userId: ME, role: 'member', today: '2026-11-11',
    db: fakeDb(rows),
    canRead: () => true,
    canWrite: () => true,
  };
}

function action(list: ActionDef[], id: string): ActionDef {
  const found = list.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

const member = (patch: Record<string, unknown> = {}) => ({
  user_id: ANNA, email: 'anna@bureau.nl', role: 'member', status: 'active', module_access: {}, ...patch,
});

test('ticket toewijzen: de kaart noemt het teamlid, en wat al goed stond valt eraf', async () => {
  const assign = action(TICKETS_ACTIONS, 'ticket.assign');
  const rows = {
    tickets: [
      { id: T1, title: 'Website offline', status: 'new', assignee_user_id: null },
      { id: T2, title: 'Factuur kwijt', status: 'review', assignee_user_id: ANNA },
    ],
    organization_members: [member()],
  };
  const plan = await assign.plan!(ctx(rows), { ticket_ids: [T1, T2], user_id: ANNA });
  assert.match(plan.title, /anna@bureau\.nl/);
  assert.deepEqual(plan.payload.ticket_ids, [T1]);
  assert.equal(plan.payload.user_id, ANNA);
  assert.match(String(plan.sub), /nu: niemand/);
  assert.match(String(plan.sub), /1 stond al goed/);
});

test('ticket toewijzen: alleen aan een actief teamlid dat Tickets ziet, nooit aan de boekhouder', async () => {
  const assign = action(TICKETS_ACTIONS, 'ticket.assign');
  const tickets = [{ id: T1, title: 'Website offline', status: 'new', assignee_user_id: null }];
  const refused = async (who: Record<string, unknown> | null, pattern: RegExp) => {
    await assert.rejects(
      assign.plan!(ctx({ tickets, organization_members: who ? [who] : [] }), { ticket_ids: [T1], user_id: ANNA }),
      (error: unknown) => error instanceof ActionError && pattern.test(error.message),
    );
  };
  await refused(member({ role: 'accountant' }), /boekhouder/);
  await refused(member({ module_access: { tickets: 'none' } }), /Tickets niet zien/);
  await refused(member({ status: 'disabled' }), /geen actief teamlid/);
  // Een id uit een andere organisatie vindt de org-gefilterde vraag niet.
  await refused(null, /geen actief teamlid/);
  // Een verzonnen id is geen uuid.
  await assert.rejects(assign.plan!(ctx({ tickets, organization_members: [member()] }), { ticket_ids: [T1], user_id: 'Anna' }),
    (error: unknown) => error instanceof ActionError && /user_id/.test(error.message));
});

test('"me" is degene namens wie de handeling draait; leeg haalt de toewijzing weg', async () => {
  const assign = action(TICKETS_ACTIONS, 'ticket.assign');
  const mine = await assign.plan!(
    ctx({ tickets: [{ id: T1, title: 'Website offline', status: 'new', assignee_user_id: ANNA }], organization_members: [member({ user_id: ME, email: 'ik@bureau.nl' })] }),
    { ticket_ids: [T1], user_id: 'me' },
  );
  assert.equal(mine.payload.user_id, ME);
  const loose = await assign.plan!(
    ctx({ tickets: [{ id: T1, title: 'Website offline', status: 'new', assignee_user_id: ANNA }], organization_members: [member()] }),
    { ticket_ids: [T1] },
  );
  assert.equal(loose.payload.user_id, null);
  assert.match(loose.title, /weghalen/);
});

test('accountlead: alleen een teamlid dat Klanten ziet, en niets doen is geen voorstel', async () => {
  const setLead = action(CLIENT_ACTIONS, 'client.set_account_lead');
  const clients = [{ id: T1, name: 'Jansen BV', account_lead_user_id: null }];
  const plan = await setLead.plan!(ctx({ clients, organization_members: [member()] }), { client_ids: [T1], user_id: ANNA });
  assert.match(plan.title, /anna@bureau\.nl accountlead maken van Jansen BV/);
  assert.equal(plan.payload.user_id, ANNA);

  await assert.rejects(setLead.plan!(ctx({ clients, organization_members: [member({ module_access: { clients: 'none' } })] }), { client_ids: [T1], user_id: ANNA }),
    (error: unknown) => error instanceof ActionError && /Klanten niet zien/.test(error.message));
  await assert.rejects(setLead.plan!(ctx({ clients, organization_members: [] }), { client_ids: [T1] }),
    (error: unknown) => error instanceof ActionError && /al geen accountlead/.test(error.message));
  // Een klant die niet in deze organisatie bestaat.
  await assert.rejects(setLead.plan!(ctx({ clients: [], organization_members: [member()] }), { client_ids: [T1], user_id: ANNA }),
    (error: unknown) => error instanceof ActionError && /bestaan niet in deze organisatie/.test(error.message));
});
