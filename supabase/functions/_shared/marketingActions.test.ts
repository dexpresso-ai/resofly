import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKETING_ACTIONS } from './actions/marketing.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';

/**
 * Gerrie (en een gekoppelde AI) en de afmeldlijst, de doelgroep en de stappen
 * van een stroom. Met een nep-database: plan() en read() draaien echt, alleen
 * de rijen zijn verzonnen. Zie docs/rapporten/CONTROLE_MARKETING_2026-11-07.md.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const FLOW = 'f0000000-0000-4000-8000-000000000001';
const CLIENT = 'c0000000-0000-4000-8000-000000000001';

function fakeDb(rows: Record<string, Array<Record<string, unknown>>>, asked: string[] = []) {
  return {
    from(table: string) {
      asked.push(table);
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

function ctx(rows: Record<string, Array<Record<string, unknown>>>, { clients = true, asked = [] as string[] } = {}): ActionCtx {
  return {
    organizationId: ORG, userId: '00000000-0000-0000-0000-0000000000a1', role: 'member', today: '2026-11-07',
    db: fakeDb(rows, asked),
    canRead: (module: string) => module !== 'clients' || clients,
    canWrite: (module: string) => module !== 'clients' || clients,
  };
}

function action(id: string): ActionDef {
  const found = MARKETING_ACTIONS.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

test('een eigen afmelding of een spamklacht zet Gerrie niet klaar om op te heffen', async () => {
  const remove = action('suppression.remove');
  for (const reason of ['unsubscribed', 'complained']) {
    await assert.rejects(
      remove.plan!(ctx({ email_suppressions: [{ email: 'jan@klant.nl', reason, source: 'link', created_at: '2026-11-01' }] }), { email: 'jan@klant.nl' }),
      (error: unknown) => error instanceof ActionError && /kun je niet opheffen/.test(error.message),
      reason,
    );
  }
});

test('een handmatige blokkade of een bounce kan Gerrie wel klaarzetten om op te heffen', async () => {
  const remove = action('suppression.remove');
  for (const reason of ['manual', 'bounced']) {
    const plan = await remove.plan!(ctx({ email_suppressions: [{ email: 'jan@klant.nl', reason, source: 'handmatig', created_at: '2026-11-01' }] }), { email: 'jan@klant.nl' });
    assert.equal(plan.payload.email, 'jan@klant.nl');
    assert.equal(plan.payload.reason, reason);
  }
});

test('blokkeren noemt de klant alleen voor wie Klanten mag lezen', async () => {
  const add = action('suppression.add');
  const rows = { email_suppressions: [], clients: [{ name: 'Bakkerij de Vries' }] };
  const met = await add.plan!(ctx(rows), { email: 'jan@klant.nl' });
  assert.match(met.sub, /Bakkerij de Vries/);
  const asked: string[] = [];
  const zonder = await add.plan!(ctx(rows, { clients: false, asked }), { email: 'jan@klant.nl' });
  assert.doesNotMatch(zonder.sub, /Bakkerij de Vries/);
  assert.equal(asked.includes('clients'), false, 'de klantentabel werd toch gelezen');
});

test('een handmatige doelgroep noemt namen alleen voor wie Klanten mag lezen', async () => {
  const setAudience = action('campaign.set_audience');
  const rows = {
    email_campaigns: [{ name: 'Najaar', status: 'draft' }],
    clients: [{ id: CLIENT, name: 'Bakkerij de Vries' }],
  };
  const input = { campaign_id: 'a0000000-0000-4000-8000-000000000001', mode: 'manual', manual_client_ids: [CLIENT] };
  const met = await setAudience.plan!(ctx(rows), input);
  assert.match(met.sub, /Bakkerij de Vries/);
  const zonder = await setAudience.plan!(ctx(rows, { clients: false }), input);
  assert.doesNotMatch(zonder.sub, /Bakkerij de Vries/);
  assert.match(zonder.sub, /1 handmatig gekozen klant/);
});

test('flow.get geeft ook de tekst van een stap die alleen HTML heeft', async () => {
  const get = action('flow.get');
  const result = await get.read!(ctx({
    email_flows: [{ id: FLOW, name: 'Opvolging', status: 'draft', stop_condition: 'reply', audience: {}, created_at: '2026-11-01' }],
    email_flow_steps: [
      { step_index: 0, delay_days: 0, subject: 'Welkom', preheader: null, body_text: null, body_html: '<p>Hallo daar,</p><p>Fijn dat je er bent.</p>', accent_color: null },
      { step_index: 1, delay_days: 3, subject: 'Nog even', preheader: null, body_text: 'Eigen platte tekst', body_html: '<p>Anders</p>', accent_color: null },
    ],
  }), { flow_id: FLOW }) as { steps: Array<Record<string, unknown>> };
  assert.equal(result.steps[0].body_text, 'Hallo daar,\nFijn dat je er bent.');
  assert.equal(result.steps[1].body_text, 'Eigen platte tekst', 'een eigen platte tekst gaat voor');
  assert.equal('body_html' in result.steps[0], false, 'de HTML zelf hoort niet in het antwoord');
});
