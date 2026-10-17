import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  agentCapabilities, allowedAgentMode, canCloneAgent, canManageAgent, permittedAgentTools,
  type AgentAction, type AgentCatalogEntry,
} from './agentAccess.ts';
import { SCHEDULE_KINDS } from './agentSchedule.ts';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const AGENTS_MIGRATION = '20261017000000_agents_for_every_member.sql';
const migrationFiles = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const migration = readFileSync(new URL(AGENTS_MIGRATION, MIGRATIONS), 'utf8');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Het stuk SQL van een policy, tot de puntkomma die hem afsluit. */
function policy(name: string): string {
  const start = migration.indexOf(`create policy "${name}"`);
  assert.ok(start >= 0, `policy "${name}" staat niet in de migratie`);
  return migration.slice(start, migration.indexOf(');\n', start));
}

/**
 * Een agent kan nooit meer dan degene namens wie hij draait. Deze tests houden
 * die regel vast voor elke rol, en voor een teamlid bij wie de owner Gerrie of
 * een module heeft dichtgezet.
 */

const ME = '11111111-1111-4111-8111-111111111111';
const COLLEAGUE = '22222222-2222-4222-8222-222222222222';

test('wie mag agents hebben, en wie mag ze iets laten klaarzetten', () => {
  assert.deepEqual(agentCapabilities('owner', {}), { canUse: true, canPropose: true, canOversee: true });
  assert.deepEqual(agentCapabilities('admin', { gerrie: 'none' }), { canUse: true, canPropose: true, canOversee: true },
    'een admin is nooit beperkt');
  assert.deepEqual(agentCapabilities('member', {}), { canUse: true, canPropose: true, canOversee: false });
  assert.deepEqual(agentCapabilities('member', { gerrie: 'read' }), { canUse: true, canPropose: false, canOversee: false },
    'Gerrie op lezen: een agent die meekijkt, niet een die klaarzet');
  assert.deepEqual(agentCapabilities('member', { gerrie: 'none' }), { canUse: false, canPropose: false, canOversee: false });
  assert.deepEqual(agentCapabilities('viewer', {}), { canUse: true, canPropose: false, canOversee: false },
    'een viewer leest, dus zijn agent ook');
  assert.deepEqual(agentCapabilities('accountant', {}), { canUse: false, canPropose: false, canOversee: false },
    'de boekhouder heeft geen Gerrie');
  assert.deepEqual(agentCapabilities('stranger', {}), { canUse: false, canPropose: false, canOversee: false });
});

test('een agent die klaarzet, alleen voor wie zelf mag wijzigen', () => {
  assert.equal(allowedAgentMode('propose', agentCapabilities('member', {})), 'propose');
  assert.equal(allowedAgentMode('propose', agentCapabilities('viewer', {})), 'report');
  assert.equal(allowedAgentMode('propose', agentCapabilities('member', { gerrie: 'read' })), 'report');
  assert.equal(allowedAgentMode('iets-anders', agentCapabilities('owner', {})), 'report');
});

test('aanpassen, starten en aanzetten: alleen de eigenaar — ook een admin niet', () => {
  const mine = { run_as_user_id: ME, created_by: ME };
  const theirs = { run_as_user_id: COLLEAGUE, created_by: COLLEAGUE };
  const member = agentCapabilities('member', {});
  const admin = agentCapabilities('admin', {});
  for (const action of ['edit', 'run', 'reply', 'activate', 'share'] as AgentAction[]) {
    assert.equal(canManageAgent(mine, ME, member, action), true, `eigenaar mag ${action}`);
    assert.equal(canManageAgent(theirs, ME, member, action), false, `collega mag geen ${action}`);
    assert.equal(canManageAgent(theirs, ME, admin, action), false, `admin mag geen ${action} op andermans agent`);
  }
  for (const action of ['pause', 'archive', 'restore'] as AgentAction[]) {
    assert.equal(canManageAgent(theirs, ME, admin, action), true, `admin mag ${action} (toezicht)`);
    assert.equal(canManageAgent(theirs, ME, member, action), false, `collega mag geen ${action}`);
    assert.equal(canManageAgent(mine, ME, member, action), true, `eigenaar mag ${action}`);
  }
});

test('wie Gerrie kwijt is, beheert ook zijn eigen agent niet meer', () => {
  const mine = { run_as_user_id: ME };
  assert.equal(canManageAgent(mine, ME, agentCapabilities('member', { gerrie: 'none' }), 'run'), false);
  assert.equal(canManageAgent(mine, ME, agentCapabilities('member', { gerrie: 'none' }), 'pause'), false);
});

test('een agent zonder eigenaar (medewerker verwijderd): alleen toezicht, niemand start hem', () => {
  const orphan = { run_as_user_id: null, created_by: null };
  const admin = agentCapabilities('owner', {});
  assert.equal(canManageAgent(orphan, ME, admin, 'run'), false);
  assert.equal(canManageAgent(orphan, ME, admin, 'activate'), false);
  assert.equal(canManageAgent(orphan, ME, admin, 'archive'), true);
});

test('kopiëren als startpunt: eigen agents, gedeelde sjablonen, en voor toezicht alles', () => {
  const member = agentCapabilities('member', {});
  assert.equal(canCloneAgent({ run_as_user_id: ME }, ME, member), true);
  assert.equal(canCloneAgent({ run_as_user_id: COLLEAGUE, visibility: 'team' }, ME, member), true);
  assert.equal(canCloneAgent({ run_as_user_id: COLLEAGUE, visibility: 'private' }, ME, member), false);
  assert.equal(canCloneAgent({ run_as_user_id: COLLEAGUE, visibility: 'private' }, ME, agentCapabilities('admin', {})), true);
  assert.equal(canCloneAgent({ run_as_user_id: COLLEAGUE, visibility: 'team' }, ME, agentCapabilities('member', { gerrie: 'none' })), false);
});

test('tools volgen de eigen catalogus; een lezende agent zet niets klaar', () => {
  const catalog: AgentCatalogEntry[] = [
    { name: 'list_projects', kind: 'read' },
    { name: 'list_tasks', kind: 'read' },
    { name: 'propose_task', kind: 'propose' },
    { name: 'action:gallery.publish', kind: 'propose' },
  ];
  // Financiën staat voor dit teamlid dicht: list_invoices zit niet in zijn catalogus.
  assert.deepEqual(
    permittedAgentTools(['list_invoices', 'list_projects', 'propose_task', 'list_projects', 'action:gallery.publish'], catalog, 'propose'),
    { tools: ['list_projects', 'propose_task', 'action:gallery.publish'], dropped: ['list_invoices'] },
  );
  assert.deepEqual(
    permittedAgentTools(['list_tasks', 'propose_task', 'action:gallery.publish', ''], catalog, 'report'),
    { tools: ['list_tasks'], dropped: ['propose_task', 'action:gallery.publish'] },
  );
});

// ── De database: lezen, ritmes, claimen en de pushmelding ────────────────────

test('lezen: je eigen agents, runs, logboek en voorstellen — owners/admins alles', () => {
  const agents = policy('ai_agents read');
  assert.match(agents, /m\.role in \('owner', 'admin'\)/);
  assert.match(agents, /or ai_agents\.run_as_user_id = auth\.uid\(\)/);
  // Gedeeld als startpunt: wel het team, niet de boekhouder-gast, en geen archief.
  assert.match(agents, /ai_agents\.visibility = 'team' and ai_agents\.archived_at is null\s*\n\s*and m\.role in \('member', 'viewer'\)/);

  for (const name of ['ai_agent_runs read', 'ai_agent_run_events read']) {
    const sql = policy(name);
    assert.match(sql, /m\.role in \('owner', 'admin'\)/, `${name}: toezicht`);
    assert.match(sql, /where a\.id = ai_agent_run[a-z_]*\.agent_id and a\.run_as_user_id = auth\.uid\(\)/, `${name}: alleen van je eigen agent`);
    assert.doesNotMatch(sql, /visibility/, `${name}: een gedeelde agent deelt zijn runs niet`);
  }
  assert.match(policy('ai_agent_run_events read'), /public\.can_read_module\(ai_agent_run_events\.organization_id, 'gerrie'\)/,
    'het logboek heeft geen eigen modulepoort, dus staat die in de policy');
  assert.match(policy('ai_action_audit read'), /m\.role in \('owner', 'admin'\) or ai_action_audit\.user_id = auth\.uid\(\)/);

  // Geen latere migratie die deze leesregels weer terugdraait.
  for (const file of migrationFiles.filter((name) => name > AGENTS_MIGRATION)) {
    const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
    assert.doesNotMatch(sql, /policy "ai_agents read"|policy "ai_agent_runs read"|policy "ai_action_audit read"/, `${file} raakt de leesregels opnieuw`);
  }
  // En nog steeds geen schrijfweg vanuit de browser: alles loopt via de runner.
  assert.doesNotMatch(migration, /create policy "[^"]*" on public\.[a-z_]+ for (insert|update|delete|all)/i);
});

test('de ritmes in de database zijn dezelfde als in de runner', () => {
  const check = migration.match(/check \(schedule_kind in \(([^)]*)\)\)/);
  assert.ok(check, 'de nieuwe schedule_kind-check staat in de migratie');
  assert.deepEqual([...check[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...SCHEDULE_KINDS]);
  assert.match(migration, /max_proposals_per_run int not null default 3\s*\n\s*check \(max_proposals_per_run between 1 and 10\)/);
});

test('claimen: tot tien per tik, en de runner vraagt er nooit meer', () => {
  assert.match(migration, /limit greatest\(1, least\(p_limit, 10\)\)/);
  const runner = read('../gerrie-agent-runner/index.ts');
  assert.match(runner, /Math\.min\(10, Number\(Deno\.env\.get\('AGENTS_CLAIM_LIMIT'\)/);
});

test("push-type 'agent_run' staat op alle vijf de plekken, zonder een oud type te laten vallen", () => {
  const checks = migration.match(/event_type in \([^)]*\)/g) ?? [];
  assert.equal(checks.length, 2, 'beide CHECKs (outbox én preferences)');
  const earlier = ['ticket_new', 'ticket_note_client', 'chat_message', 'client_email_inbound', 'booking_new', 'invoice_paid',
    'decision_digest', 'mcp_proposal', 'purchase_invoice_inbox', 'file_transfer_downloaded'];
  for (const check of checks) {
    assert.ok(check.includes("'agent_run'"));
    for (const type of earlier) assert.ok(check.includes(`'${type}'`), `de nieuwe CHECK mist het bestaande push-type '${type}'`);
  }
  const pushApi = read('../../../src/lib/push-api.ts');
  assert.match(pushApi, /\|\s*'agent_run'/, 'PushEventType mist agent_run');
  assert.match(pushApi, /type: 'agent_run'/, 'PUSH_EVENTS mist agent_run (dan kan niemand hem uitzetten)');
  // En in de handelingen van Gerrie/MCP ("zet de meldingen van mijn agents uit").
  assert.match(read('./actions/admin.ts'), /\{ type: 'agent_run', label: '[^']+' \}/, 'NOTIFICATION_EVENTS in actions/admin.ts mist agent_run');
});

test('de pushmelding gaat naar de eigenaar die de database kent, en alleen de server stuurt hem', () => {
  const start = migration.indexOf('create or replace function public.ai_agent_run_push(');
  const body = migration.slice(start, migration.indexOf('\n$$;', start));
  assert.match(body, /security definer/);
  assert.match(body, /if auth\.role\(\) is distinct from 'service_role' then/);
  assert.match(body, /array\[v_agent\.run_as_user_id\]/, 'de ontvanger komt uit de agent, niet van de aanroeper');
  assert.match(migration, /revoke execute on function public\.ai_agent_run_push\(uuid\) from public, anon, authenticated;/);
});
