import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_ACTIONS } from './actions/clients.ts';
import { PROJECTS_ACTIONS } from './actions/projects.ts';
import { CALENDAR_ACTIONS } from './actions/calendar.ts';
import { ADMIN_ACTIONS } from './actions/admin.ts';
import { MARKETING_ACTIONS } from './actions/marketing.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';

/**
 * Wat een handeling met velden uit een ÁNDERE module doet. Een uurtarief of
 * klantwaarde hoort bij Financiën; een sleutel (of teamlid) zonder schrijfrecht
 * daar, kan ze ook niet via een handeling uit Projecten, Uren of Klanten zetten —
 * net zoals de vaste adressen van de API dat al weigeren. En wat zo'n handeling
 * laat zien, volgt het leesrecht.
 *
 * Met een nep-database: plan() en read() draaien echt, alleen de rijen zijn verzonnen.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const ID = 'c0000000-0000-4000-8000-000000000001';

/** Een database die op elke vraag dezelfde rij(en) teruggeeft. */
function fakeDb(rows: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const list = rows[table] ?? [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const name of ['select', 'eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'neq', 'not', 'or', 'ilike']) chain[name] = self;
      chain.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
      chain.single = async () => ({ data: list[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: list, error: null });
      return chain;
    },
    rpc() { throw new Error('geen rpc in deze test'); },
  };
}

function ctx(rows: Record<string, Array<Record<string, unknown>>>, access: { read?: string[]; write?: string[] }): ActionCtx {
  return {
    organizationId: ORG, userId: '00000000-0000-0000-0000-0000000000a1', role: 'member', today: '2026-10-03',
    db: fakeDb(rows),
    canRead: (module) => (access.read ?? []).includes(module) || (access.write ?? []).includes(module),
    canWrite: (module) => (access.write ?? []).includes(module),
  };
}

function action(list: ActionDef[], id: string): ActionDef {
  const found = list.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

const NO_FINANCE = { write: ['clients', 'projects', 'time'] };
const WITH_FINANCE = { write: ['clients', 'projects', 'time', 'finance'] };

test('klantwaarde zetten vraagt schrijfrecht in Financiën', async () => {
  const update = action(CLIENT_ACTIONS, 'client.update_details');
  const rows = { clients: [{ name: 'Jansen BV' }] };
  await assert.rejects(update.plan!(ctx(rows, NO_FINANCE), { client_id: ID, value_eur: 1 }),
    (error: unknown) => error instanceof ActionError && /"value_eur" hoort bij Financiën/.test(error.message));
  const plan = await update.plan!(ctx(rows, WITH_FINANCE), { client_id: ID, value_eur: 1 });
  assert.deepEqual(plan.payload.patch, { value_eur: 1 });
  // Andere velden blijven gewoon kunnen.
  const city = await update.plan!(ctx(rows, NO_FINANCE), { client_id: ID, city: 'Zwolle' });
  assert.deepEqual(city.payload.patch, { city: 'Zwolle' });
});

test('een projecttarief zetten vraagt schrijfrecht in Financiën; het budget niet', async () => {
  const billing = action(PROJECTS_ACTIONS, 'project.update_billing');
  const rows = { projects: [{ name: 'Website', client_id: null, billing_type: 'hourly', hourly_rate_cents: 9500, budgeted_minutes: null }] };
  await assert.rejects(billing.plan!(ctx(rows, NO_FINANCE), { project_id: ID, hourly_rate_euro: 120 }),
    (error: unknown) => error instanceof ActionError && /Financiën/.test(error.message));
  const budget = await billing.plan!(ctx(rows, NO_FINANCE), { project_id: ID, budgeted_hours: 40 });
  assert.deepEqual(budget.payload.patch, { budgeted_minutes: 2400 });
  assert.doesNotMatch(`${budget.title} ${budget.sub}`, /95/, 'het huidige tarief staat niet op de kaart');
});

test('het tarief van een urenpost: geen raadspel met "er verandert niets"', async () => {
  const details = action(CALENDAR_ACTIONS, 'time_entry.update_details');
  const rows = {
    time_entries: [{
      source: 'manual', description: 'Overleg', entry_date: '2026-10-01', minutes: 60,
      entry_type: 'direct', indirect_category: null, hourly_rate_cents: 9500, project_id: null, client_id: null,
    }],
  };
  // Het HUIDIGE tarief noemen gaf "Geef minstens één ding" — en verried zo het tarief.
  for (const guess of [95, 120]) {
    await assert.rejects(details.plan!(ctx(rows, NO_FINANCE), { time_entry_id: ID, hourly_rate_eur: guess }),
      (error: unknown) => error instanceof ActionError && /Financiën/.test(error.message), `gok ${guess}`);
  }
});

test('het projectdashboard laat het tarief weg zonder leesrecht in Financiën', async () => {
  const dashboard = action(PROJECTS_ACTIONS, 'project.dashboard');
  const rows = {
    projects: [{ name: 'Website', client_id: null, archived: false, start_date: null, end_date: null, billing_type: 'hourly', hourly_rate_cents: 9500, budgeted_minutes: 600 }],
    tasks: [], invoices: [], time_entries: [],
  };
  const hidden = await dashboard.read!(ctx(rows, NO_FINANCE), { project_id: ID }) as { project: { hourly_rate_cents: unknown }; money: unknown };
  assert.equal(hidden.project.hourly_rate_cents, null);
  assert.equal(hidden.money, null);
  const shown = await dashboard.read!(ctx(rows, WITH_FINANCE), { project_id: ID }) as { project: { hourly_rate_cents: unknown } };
  assert.equal(shown.project.hourly_rate_cents, 9500);
});

test('portaaltoegang: het e-mailadres staat op de kaart en gaat mee in het voorstel', async () => {
  const access = action(CLIENT_ACTIONS, 'client_contact.set_portal_access');
  const rows = { client_contacts: [{ id: ID, name: 'Kees', email: 'kees@jansen.nl', gives_portal_access: false }] };
  const plan = await access.plan!(ctx(rows, NO_FINANCE), { contact_ids: [ID], gives_portal_access: true });
  assert.match(plan.sub, /kees@jansen\.nl/, 'wie er straks inlogt, hoort op de kaart');
  assert.deepEqual(plan.payload.emails, ['kees@jansen.nl'], 'de uitvoerder controleert dat het adres niet veranderde');
  assert.equal(access.risk, 'high');
});

test('openstaande uitnodigingen zijn voor owners en admins, zoals in de app', () => {
  assert.equal(action(ADMIN_ACTIONS, 'team.list_invitations').adminOnly, true);
});

test('instellingen van een GEPUBLICEERDE galerij zijn naar buiten gericht', async () => {
  const settings = action(MARKETING_ACTIONS, 'gallery.update_settings');
  const published = { galleries: [{ title: 'Bruiloft', status: 'published', allow_downloads: false, expires_at: null }] };
  const draft = { galleries: [{ title: 'Bruiloft', status: 'draft', allow_downloads: false, expires_at: null }] };
  const input = { gallery_id: ID, allow_downloads: true };
  assert.equal((await settings.plan!(ctx(published, { write: ['projects'] }), input)).risk, 'high');
  assert.equal((await settings.plan!(ctx(draft, { write: ['projects'] }), input)).risk, 'normal');
});

// ── Bedragen op de kaart ─────────────────────────────────────────────────────

test('het bedrag op een goedkeurkaart is cent voor cent dat van de app (computeTotals)', async () => {
  const { linesTotalEur } = await import('./actions/finance.ts');
  const { computeTotals } = await import('../../../src/lib/money.ts');
  assert.equal(linesTotalEur([{ quantity: 2, unit_price: 500, vat: 21 }]), 1210, '2 × € 500 + 21% btw');
  assert.equal(linesTotalEur([{ quantity: 1, unit_price: 99.99, vat: 9 }, { quantity: 3, unit_price: 0.335, vat: 21 }, { quantity: 1, unit_price: 10, vat: 0 }]),
    computeTotals([{ quantity: 1, unit_price: 99.99, vat: 9 }, { quantity: 3, unit_price: 0.335, vat: 21 }, { quantity: 1, unit_price: 10, vat: 0 }]).total);
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let round = 0; round < 500; round += 1) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, () => ({
      quantity: Math.round(random() * 2000) / 100,
      unit_price: Math.round((random() * 2000 - 100) * 1000) / 1000,
      vat: [0, 9, 21][Math.floor(random() * 3)],
    }));
    assert.equal(linesTotalEur(lines), computeTotals(lines).total, JSON.stringify(lines));
  }
});

test('een datum in een handeling bestaat echt: 30 februari is een fout met het veld, geen databasefout', async () => {
  const { isoDate, optIsoDate } = await import('./actions/types.ts');
  assert.equal(isoDate({ d: '2028-02-29' }, 'd'), '2028-02-29');
  assert.throws(() => isoDate({ d: '2026-02-30' }, 'd'), (error: unknown) => error instanceof ActionError && /"d" is geen bestaande datum/.test(error.message));
  assert.throws(() => optIsoDate({ d: '2026-13-01' }, 'd'), ActionError);
  assert.equal(optIsoDate({}, 'd'), null);
});
