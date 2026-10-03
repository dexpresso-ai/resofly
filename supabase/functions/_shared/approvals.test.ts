import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Goedkeuren van voorstellen (de goedkeurwachtrij, de chat, het
 * commandocentrum). De browser voert een voorstel uit onder de sessie van het
 * teamlid; wat er daarna in de audit komt, beslist de database
 * (ai_action_decide) en niet de browser.
 *
 * Als TEKST gelezen: de functies leunen op Deno-imports en de regels staan in
 * SQL. De werking zelf is end-to-end nagelopen (vastzetten, uitvoeren,
 * afwijzen, een collega die al bezig is); hier gaat het erom dat niemand de
 * grens ongemerkt weghaalt.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const migrationsDir = new URL('../../migrations/', import.meta.url);
const migrations = readdirSync(migrationsDir).filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort()
  .map((name) => readFileSync(new URL(name, migrationsDir), 'utf8'));

/** De LAATSTE definitie van een functie in de migraties. */
function latest(name: string): string {
  const marker = `create or replace function public.${name}(`;
  for (const sql of [...migrations].reverse()) {
    const start = sql.indexOf(marker);
    if (start >= 0) return sql.slice(start, sql.indexOf('\n$$;', start));
  }
  throw new Error(`${name} staat in geen enkele migratie`);
}

const decide = latest('ai_action_decide');
const guard = latest('ai_action_audit_guard_update');
const core = read('./gerrieCore.ts');
const client = read('../../../src/lib/gerrie-api.ts');

// ── De database beslist ──────────────────────────────────────────────────────

test('alleen de server legt een beslissing vast, met de rol vers uit organization_members', () => {
  assert.match(decide, /security definer/);
  assert.match(decide, /if auth\.role\(\) is distinct from 'service_role' then/);
  assert.match(decide, /from public\.organization_members m\s*\n\s*where m\.organization_id = p_organization_id and m\.user_id = p_user_id and m\.status = 'active'/);
  const sql = migrations.join('\n');
  assert.match(sql, /revoke all on function public\.ai_action_decide\(uuid, uuid, uuid, text, text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.ai_action_decide\(uuid, uuid, uuid, text, text\) to service_role;/);
});

test('een teamlid beslist alleen over zijn eigen chatvoorstel; de wachtrij is van owners en admins', () => {
  assert.match(decide, /if v_role not in \('owner', 'admin'\)\s*\n\s*and \(v_row\.agent_id is not null or v_row\.agent_run_id is not null or v_row\.mcp_grant_id is not null\s*\n\s*or v_row\.api_key_id is not null or v_row\.signal_id is not null\s*\n\s*or v_row\.user_id is distinct from p_user_id\) then/);
});

test('alleen wat nog open staat; afgewezen en uitgevoerd zijn definitief', () => {
  assert.match(decide, /if not \(v_row\.status = 'proposed'\s*\n\s*or \(v_row\.status = 'failed' and coalesce\(v_row\.result ->> 'decision', ''\) = 'failed'\)\) then/);
  assert.match(decide, /for update;/, 'de rij hoort vergrendeld te zijn, anders beslissen twee mensen tegelijk');
});

test('vastzetten vóór uitvoeren: een ander kan niet beslissen zolang het vastligt', () => {
  assert.match(decide, /if v_claimer is not null and v_claimer <> p_user_id and v_until > now\(\) then/);
  assert.match(decide, /'claimed_by', p_user_id, 'claimed_until', now\(\) \+ interval '10 minutes'/);
  assert.match(decide, /'decided_by', p_user_id, 'decided_at', now\(\)/, 'wie besliste, hoort erbij te staan');
});

test('een afgehandelde auditregel herschrijft niemand meer — ook de service-role niet', () => {
  assert.match(guard, /or new\.params is distinct from old\.params/, 'wat er voorgesteld werd, verandert niet');
  assert.match(guard, /or \(new\.api_key_id is distinct from old\.api_key_id and new\.api_key_id is not null\)/,
    'een verwijzing mag alleen leeg worden (on delete set null)');
  assert.match(guard, /if \(old\.status in \('executed', 'auto_executed', 'cancelled', 'confirmed'\)\s*\n\s*or \(old\.status = 'failed' and coalesce\(old\.result ->> 'decision', ''\) <> 'failed'\)\)/);
  assert.match(migrations.join('\n'), /create trigger ai_action_audit_guard_update\s*\n\s*before update on public\.ai_action_audit/);
});

// ── De server en de app ──────────────────────────────────────────────────────

test('gerrie-agent schrijft de uitkomst niet zelf, maar via ai_action_decide', () => {
  const confirm = core.slice(core.indexOf('async function confirmAction('), core.indexOf('\n}\n', core.indexOf('async function confirmAction(')));
  assert.match(confirm, /supabaseAdmin\.rpc\('ai_action_decide', \{/);
  assert.match(confirm, /p_user_id: userId/);
  assert.doesNotMatch(confirm, /from\('ai_action_audit'\)/);
  // Nergens anders in de functies wordt een auditregel bijgewerkt: alleen aangemaakt.
  const functionsDir = new URL('../', import.meta.url);
  const offenders: string[] = [];
  for (const entry of readdirSync(functionsDir, { withFileTypes: true })) {
    const files = entry.isDirectory() ? readdirSync(new URL(`${entry.name}/`, functionsDir)).map((f) => `${entry.name}/${f}`) : [entry.name];
    for (const file of files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const source = readFileSync(new URL(file, functionsDir), 'utf8');
      if (/from\('ai_action_audit'\)\s*\.update\(/.test(source)) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test('de app zet een voorstel vast vóór het uitvoeren, overal waar het wordt uitgevoerd', () => {
  const run = client.slice(client.indexOf('export async function runGerrieDecision'));
  const claim = run.indexOf('await claimGerrieAction(organizationId, auditId);');
  assert.ok(claim > 0 && claim < run.indexOf('const result = await run();'), 'eerst vastzetten, dan uitvoeren');
  for (const file of ['../../../src/components/AgentApprovals.tsx', '../../../src/features/GerrieCommandCenter.tsx']) {
    const source = read(file);
    for (const match of source.matchAll(/executeProposal\(/g)) {
      const before = source.slice(Math.max(0, match.index! - 120), match.index!);
      assert.match(before, /runGerrieDecision\([^)]*\(\) => $/, `${file}: executeProposal zonder runGerrieDecision ervoor`);
    }
    for (const match of source.matchAll(/<AgentBatchBoard[\s\S]*?handlers=\{([^}]*)\}/g)) {
      assert.match(match[1], /claimingHandlers\(/, `${file}: een reeks wordt uitgevoerd zonder vast te zetten`);
    }
  }
  const chat = read('../../../src/components/GerrieChat.tsx');
  assert.match(chat, /return await runGerrieDecision\(organizationId, auditId, action\);/);
});

// ── Opruimen ─────────────────────────────────────────────────────────────────

test('opruimen: dagelijks via pg_cron als dat er is, en ook de mislukte pogingen', () => {
  const purge = latest('api_purge_expired');
  assert.match(purge, /delete from public\.api_auth_failures/);
  const sql = read('../../migrations/20261003040000_approvals_auth_limits.sql');
  assert.match(sql, /if to_regclass\('cron\.job'\) is not null\s*\n\s*and to_regprocedure\('cron\.schedule\(text,text,text\)'\) is not null/,
    'zonder pg_cron hoort de migratie niet te falen');
  assert.match(sql, /perform cron\.unschedule\(j\.jobid\) from cron\.job j where j\.jobname = 'resofly-api-purge';/, 'opnieuw draaien vervangt de taak');
  assert.match(sql, /'select public\.api_purge_expired\(\); select public\.webhook_purge_expired\(\);'/);
});
