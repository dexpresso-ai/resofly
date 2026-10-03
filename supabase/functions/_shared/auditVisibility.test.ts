import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ADMIN_ACTIONS, AUDIT_ENTITY_MODULE, visibleAuditEntityTypes } from './actions/admin.ts';
import { ActionError, type ActionCtx } from './actions/types.ts';

/**
 * Wie leest welke regel uit het auditlog. Het label van een regel is de naam,
 * titel of het e-mailadres uit de rij die veranderde — dus hoort een regel over
 * een factuur bij Financiën, een regel over een API-sleutel bij owners en admins,
 * en geeft een afspraak in een privé-agenda zijn titel niet prijs.
 *
 * De database (RLS) en de handeling audit.list (die met de service-role leest)
 * moeten hetzelfde zeggen: deze test houdt de twee lijsten gelijk.
 */

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const migrationFiles = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const migration = (name: string) => readFileSync(new URL(name, MIGRATIONS), 'utf8');
const RECHECK = '20261003060000_recheck_audit_and_licenses.sql';

/** De laatste definitie van een functie, over alle migraties heen. */
function latestDefinition(fn: string): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  const pattern = new RegExp(`create (?:or replace )?function public\\.${fn}\\(([\\s\\S]*?)\\n\\$\\$;`, 'g');
  for (const file of migrationFiles) {
    for (const match of migration(file).matchAll(pattern)) found = { file, body: match[0] };
  }
  assert.ok(found, `${fn} niet gevonden`);
  return found;
}

/** De CASE uit audit_entity_module(), als { entity_type: module }. */
function sqlMapping(): Record<string, string | null> {
  const { file, body } = latestDefinition('audit_entity_module');
  assert.equal(file, RECHECK, 'de indeling staat in de herkontrole-migratie (of de test moet mee)');
  const mapping: Record<string, string | null> = {};
  for (const branch of body.matchAll(/when p_entity_type in \(([^)]*)\) then (null|'[a-z]+')/g)) {
    const module = branch[2] === 'null' ? null : branch[2].slice(1, -1);
    for (const type of branch[1].matchAll(/'([a-z_]+)'/g)) {
      assert.ok(!(type[1] in mapping), `${type[1]} staat twee keer in de CASE`);
      mapping[type[1]] = module;
    }
  }
  assert.match(body, /else 'admin'/, 'onbekend = alleen owners/admins');
  return mapping;
}

test('de indeling in SQL en in audit.list is dezelfde', () => {
  assert.deepEqual(sqlMapping(), { ...AUDIT_ENTITY_MODULE });
});

test('elke soort regel die ergens gelogd wordt, is bewust ingedeeld', () => {
  const logged = new Set<string>();
  for (const file of migrationFiles) {
    const sql = migration(file);
    for (const match of sql.matchAll(/audit_row_change\('([a-z_]+)'/g)) logged.add(match[1]);
    for (const match of sql.matchAll(/log_billing_audit\(\s*[^,]+,\s*'[a-z_]+',\s*'([a-z_]+)'/g)) logged.add(match[1]);
  }
  // Rechtstreeks vanuit een edge function (invoice-workflow: creditnota gemaild).
  logged.add('credit_note');
  assert.ok(logged.size >= 60, `te weinig gevonden (${logged.size}) — klopt de zoekopdracht nog?`);
  const missing = [...logged].filter((type) => !(type in AUDIT_ENTITY_MODULE));
  assert.deepEqual(missing, [], 'nieuw in het auditlog: kies een module in audit_entity_module() én AUDIT_ENTITY_MODULE');
});

test('de leesregel: lid van de organisatie, en dan per module of als owner/admin', () => {
  const sql = migration(RECHECK);
  const policy = sql.slice(sql.indexOf('create policy "audit logs read by org members"'));
  assert.match(policy, /public\.can_read_org\(organization_id\)\s*and \(/);
  assert.match(policy, /public\.can_admin_org\(organization_id\)/);
  assert.match(policy, /public\.audit_entity_module\(entity_type\) is null/);
  assert.match(policy, /<> 'admin'\s*and public\.can_read_module\(organization_id, public\.audit_entity_module\(entity_type\)\)/);
  // Geen latere migratie die de oude, ruime regel terugzet.
  for (const file of migrationFiles.filter((name) => name > RECHECK)) {
    assert.doesNotMatch(migration(file), /policy "audit logs read by org members"/, `${file} raakt de leesregel opnieuw`);
  }
});

test('een privé-agenda geeft in het auditlog geen titel prijs', () => {
  const { body } = latestDefinition('audit_logs_mask_private_calendar');
  for (const type of ['calendar_event', 'calendar_event_link', 'note_calendar_link']) {
    assert.match(body, new RegExp(`new\\.entity_type = '${type}'[\\s\\S]*?new\\.entity_label := 'Privé-afspraak'`));
  }
  assert.match(body, /new\.entity_type = 'calendar_source'[\s\S]*?new\.entity_label := 'Privé-agenda'/);
  assert.match(body, /if not coalesce\(v_shared, false\)/, 'bij twijfel (rij weg, geen bron): maskeren');
  assert.match(body, /exception when others then/, 'het loggen strandt nooit op het maskeren');
  const sql = migration(RECHECK);
  assert.match(sql, /create trigger audit_logs_mask_private_calendar\s+before insert on public\.audit_logs/);
  assert.match(sql, /update public\.audit_logs a set entity_label = 'Privé-afspraak'/, 'bestaande regels worden opgeschoond');
});

test('de licentietelling werkt ook vanuit de server, en anders alleen voor leden', () => {
  const { file, body } = latestDefinition('organization_license_usage');
  assert.equal(file, RECHECK);
  assert.match(body, /if auth\.role\(\) is distinct from 'service_role' and not public\.can_read_org\(p_organization_id\) then\s+raise exception/);
  const sql = migration(RECHECK);
  assert.match(sql, /revoke all on function public\.organization_license_usage\(uuid\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.organization_license_usage\(uuid\) to authenticated, service_role;/);
});

// ── audit.list zelf ─────────────────────────────────────────────────────────

const ALL_MODULES = ['clients', 'projects', 'time', 'calendar', 'tickets', 'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie'];

function ctxFor(role: string, readable: string[], calls: Array<[string, unknown[]]> = []): ActionCtx {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'in', 'gte', 'order', 'limit']) {
    chain[name] = (...args: unknown[]) => { calls.push([name, args]); return chain; };
  }
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
  return {
    organizationId: '0000000a-0000-0000-0000-000000000000', userId: '00000000-0000-0000-0000-0000000000a3', role, today: '2026-10-03',
    db: { from: () => chain, rpc: () => { throw new Error('geen rpc'); } },
    canRead: (module) => readable.includes(module),
  };
}

test('owner of admin zonder beperking: alles; met een beperkte sleutel: als teamlid', () => {
  assert.equal(visibleAuditEntityTypes(ctxFor('owner', ALL_MODULES)), 'all');
  assert.equal(visibleAuditEntityTypes(ctxFor('admin', ALL_MODULES)), 'all');
  const restricted = visibleAuditEntityTypes(ctxFor('admin', ['clients', 'stats']));
  assert.notEqual(restricted, 'all');
  assert.ok(Array.isArray(restricted));
  assert.ok(restricted.includes('client') && restricted.includes('member'));
  for (const hidden of ['invoice', 'api_key', 'webhook_endpoint', 'invitation', 'calendar_event']) {
    assert.ok(!restricted.includes(hidden), `${hidden} hoort niet bij een sleutel voor Klanten`);
  }
});

test('een teamlid ziet per module wat hij mag lezen, en nooit de beheerregels', () => {
  const member = visibleAuditEntityTypes(ctxFor('member', ALL_MODULES.filter((m) => m !== 'finance')));
  assert.ok(Array.isArray(member));
  assert.ok(member.includes('client') && member.includes('task') && member.includes('time_entry'));
  for (const hidden of ['invoice', 'journal_entry', 'quote', 'api_key', 'webhook_endpoint', 'invitation', 'payment']) {
    assert.ok(!member.includes(hidden), `${hidden} is niet voor een teamlid zonder Financiën`);
  }
  const viewer = visibleAuditEntityTypes(ctxFor('viewer', ALL_MODULES));
  assert.ok(Array.isArray(viewer) && viewer.includes('invoice') && !viewer.includes('api_key'));
});

test('audit.list filtert in de query, en zegt het als je om een verborgen soort vraagt', async () => {
  const list = ADMIN_ACTIONS.find((a) => a.id === 'audit.list');
  assert.ok(list?.read);
  const calls: Array<[string, unknown[]]> = [];
  await list.read(ctxFor('member', ['clients', 'stats'], calls), {});
  const filter = calls.find(([name]) => name === 'in');
  assert.ok(filter, 'een teamlid krijgt een filter op entity_type');
  assert.equal(filter[1][0], 'entity_type');
  assert.ok(!(filter[1][1] as string[]).includes('invoice'));
  await assert.rejects(list.read(ctxFor('member', ['clients', 'stats']), { entity_type: 'invoice' }),
    (error: unknown) => error instanceof ActionError && /niet zichtbaar/.test(error.message));
  await assert.rejects(list.read(ctxFor('admin', ['clients', 'stats']), { entity_type: 'api_key' }),
    (error: unknown) => error instanceof ActionError && /niet zichtbaar/.test(error.message), 'beperkte sleutel van een admin');
  const ownerCalls: Array<[string, unknown[]]> = [];
  await list.read(ctxFor('owner', ALL_MODULES, ownerCalls), { entity_type: 'api_key' });
  assert.ok(!ownerCalls.some(([name]) => name === 'in'), 'een owner zonder beperking: geen filter nodig');
  assert.ok(ownerCalls.some(([name, args]) => name === 'eq' && args[0] === 'entity_type' && args[1] === 'api_key'));
});
