import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { AI_CONSENT_REFUSAL, AI_TERMS_VERSION, consentIsActive, hasAiConsent } from './aiConsent.ts';
import { AI_CONSENT_KEYS, AI_TERMS_VERSION as APP_TERMS_VERSION } from '../../../src/lib/aiConsent.ts';

/**
 * Gerrie aanzetten (20261112160000): de gebruiker zet de AI zelf aan, met
 * akkoord op drie punten. Hier staat dat elke deur naar de AI dat akkoord
 * weegt, en dat de database, de edge functions en de app dezelfde versie van
 * de tekst en dezelfde drie punten kennen.
 *
 * De edge functions lezen Deno-variabelen bij het laden en draaien niet in
 * node; die lezen we als tekst, net als gerrieSecurity.test.ts.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const migrationsDir = new URL('../../migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
const MIGRATION = '20261112160000_gerrie_aanzetten.sql';
const sql = read(`../../migrations/${MIGRATION}`);

function latestDefinition(fn: string): { file: string; body: string } {
  let found: { file: string; body: string } | null = null;
  const pattern = new RegExp(`create (?:or replace )?function public\\.${fn}\\(([\\s\\S]*?)\\n\\$\\$;`, 'g');
  for (const file of migrationFiles) {
    for (const match of read(`../../migrations/${file}`).matchAll(pattern)) found = { file, body: match[0] };
  }
  assert.ok(found, `${fn} niet gevonden`);
  return found;
}

// ── De regel ─────────────────────────────────────────────────────────────────

test('alleen aan onder de tekst die nu geldt', () => {
  assert.equal(consentIsActive({ enabled: true, terms_version: AI_TERMS_VERSION }), true);
  assert.equal(consentIsActive({ enabled: false, terms_version: AI_TERMS_VERSION }), false);
  assert.equal(consentIsActive({ enabled: true, terms_version: '2020-01-01' }), false);
  assert.equal(consentIsActive({ enabled: 'true', terms_version: AI_TERMS_VERSION }), false);
  assert.equal(consentIsActive(null), false);
  assert.equal(consentIsActive(undefined), false);
});

/** Een nep-client die precies de vraag van hasAiConsent beantwoordt. */
function fakeClient(answer: { data: unknown; error: unknown }, seen: Array<[string, string]> = []): SupabaseClient {
  const query = {
    eq(column: string, value: string) { seen.push([column, value]); return query; },
    maybeSingle: () => Promise.resolve(answer),
  };
  return { from: (table: string) => { seen.push(['table', table]); return { select: () => query }; } } as unknown as SupabaseClient;
}

test('hasAiConsent: vraagt de rij van deze gebruiker in deze organisatie', async () => {
  const seen: Array<[string, string]> = [];
  const ok = await hasAiConsent(fakeClient({ data: { enabled: true, terms_version: AI_TERMS_VERSION }, error: null }, seen), 'u1', 'o1');
  assert.equal(ok, true);
  assert.deepEqual(seen, [['table', 'ai_consents'], ['organization_id', 'o1'], ['user_id', 'u1']]);
});

test('hasAiConsent: geen rij, uitgezet, oude tekst of een fout = nee', async () => {
  assert.equal(await hasAiConsent(fakeClient({ data: null, error: null }), 'u1', 'o1'), false);
  assert.equal(await hasAiConsent(fakeClient({ data: { enabled: false, terms_version: AI_TERMS_VERSION }, error: null }), 'u1', 'o1'), false);
  assert.equal(await hasAiConsent(fakeClient({ data: { enabled: true, terms_version: 'oud' }, error: null }), 'u1', 'o1'), false);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await hasAiConsent(fakeClient({ data: null, error: { message: 'relation does not exist' } }), 'u1', 'o1'), false);
  } finally {
    console.warn = warn;
  }
  // Zonder gebruiker of organisatie wordt er niet eens gevraagd.
  assert.equal(await hasAiConsent(fakeClient({ data: { enabled: true, terms_version: AI_TERMS_VERSION }, error: null }), '', 'o1'), false);
});

test('de weigering zegt waar je Gerrie aanzet, en noemt geen model', () => {
  assert.match(AI_CONSENT_REFUSAL, /Instellingen → AI/);
  assert.doesNotMatch(AI_CONSENT_REFUSAL, /claude|anthropic|sonnet|haiku|opus/i);
});

// ── Eén versie, drie punten ──────────────────────────────────────────────────

test('database, edge functions en app kennen dezelfde versie van de tekst', () => {
  const { body } = latestDefinition('ai_terms_version');
  const inSql = body.match(/select '([^']+)'::text/)?.[1];
  assert.equal(inSql, AI_TERMS_VERSION, 'public.ai_terms_version()');
  assert.equal(APP_TERMS_VERSION, AI_TERMS_VERSION, 'src/lib/aiConsent.ts');
});

test('set_ai_consent eist precies de drie punten uit het scherm', () => {
  const { body } = latestDefinition('set_ai_consent');
  const required = body.match(/v_required text\[\] := array\[([^\]]+)\]/)?.[1] ?? '';
  const keys = [...required.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, [...AI_CONSENT_KEYS]);
  assert.match(body, /if not \(v_required <@ coalesce\(p_acknowledged, '\{\}'::text\[\]\)\) then/);
  assert.match(body, /if p_terms_version is distinct from public\.ai_terms_version\(\) then/);
});

// ── De database ──────────────────────────────────────────────────────────────

test('aanzetten alleen voor jezelf, als lid, met de module Gerrie open', () => {
  const { body } = latestDefinition('set_ai_consent');
  assert.match(body, /security definer\s+set search_path = public/);
  assert.match(body, /v_user uuid := auth\.uid\(\);/);
  assert.match(body, /m\.organization_id = p_organization_id and m\.user_id = v_user and m\.status = 'active'/);
  assert.match(body, /if not public\.can_read_module\(p_organization_id, 'gerrie'\) then/);
  // De rij komt altijd van de ingelogde gebruiker, nooit uit een parameter.
  assert.match(body, /values\s*\(p_organization_id, v_user, true,/);
  assert.doesNotMatch(body, /p_user_id/);
  assert.match(sql, /revoke all on function public\.set_ai_consent\(uuid, boolean, text, text\[\]\) from public, anon;/);
});

test('uitzetten pauzeert je eigen agents in deze organisatie, en niets meer', () => {
  const { body } = latestDefinition('set_ai_consent');
  assert.match(body, /update public\.ai_agents\s+set status = 'paused', next_run_at = null, lease_until = null\s+where organization_id = p_organization_id and run_as_user_id = v_user and status = 'active';/);
  // Uitzetten vraagt niet naar de module: ook wie Gerrie dicht kreeg, zet hem uit.
  const off = body.slice(body.indexOf('-- Uitzetten.'));
  assert.doesNotMatch(off, /can_read_module/);
});

test('niemand schrijft zelf in ai_consents; lezen: jezelf of beheer', () => {
  assert.match(sql, /alter table public\.ai_consents enable row level security;/);
  assert.match(sql, /for select using \(\s*user_id = auth\.uid\(\) or public\.can_admin_org\(organization_id\)\s*\);/);
  assert.doesNotMatch(sql, /on public\.ai_consents for (insert|update|delete|all)/);
  assert.match(sql, /revoke insert, update, delete, truncate on public\.ai_consents from authenticated;/);
  assert.match(sql, /select public\.apply_accountant_fence\('ai_consents'\);/);
});

test('aan- en uitzetten komen in het logboek', () => {
  assert.match(sql, /v_nieuw text\[\] := array\['ai_enabled', 'ai_disabled'\];/);
  const { body } = latestDefinition('set_ai_consent');
  assert.match(body, /'ai_enabled', 'organization', p_organization_id, 'Gerrie \(AI\)'/);
  assert.match(body, /'ai_disabled', 'organization', p_organization_id, 'Gerrie \(AI\)'/);
});

// ── Elke deur naar de AI ─────────────────────────────────────────────────────

const chat = read('../gerrie-agent/index.ts');
const runner = read('../gerrie-agent-runner/index.ts');
const signals = read('../gerrie-signals/index.ts');
const mcp = read('../mcp/index.ts');
const mcpOauth = read('../mcp-oauth/index.ts');

test('gerrie-agent: het akkoord vóór elke handeling', () => {
  const check = chat.indexOf('if (!(await hasAiConsent(supabaseAdmin, user.id, organizationId))) {');
  assert.ok(check > 0, 'gerrie-agent weegt het akkoord niet');
  assert.ok(check > chat.indexOf("getModuleLevel(supabaseAdmin, user.id, organizationId, 'gerrie')"), 'eerst de module, dan het akkoord');
  // Vóór de eerste handeling, ook die zonder model.
  for (const marker of ["action === 'report_chat'", "'confirm'", "'usage'", "'budget'", "'delete_conversation'", "'plan'", "'design_agent'", 'streamResponse(req, async (emit) => {']) {
    const at = chat.indexOf(marker);
    assert.ok(at > check, `${marker} staat vóór de controle op het akkoord`);
  }
  assert.match(chat, /throw new HttpError\(AI_CONSENT_REFUSAL, 403\);/);
});

test('gerrie-agent-runner: beheer én elke run wegen het akkoord van de eigenaar', () => {
  const app = runner.indexOf('if (!(await hasAiConsent(supabaseAdmin, user.id, organizationId))) throw new HttpError(AI_CONSENT_REFUSAL, 403);');
  assert.ok(app > 0, 'het app-pad van de runner weegt het akkoord niet');
  assert.ok(app < runner.indexOf("case 'create':"), 'het akkoord komt na de acties');
  const run = runner.indexOf('if (!(await hasAiConsent(supabaseAdmin, runAsUserId, orgId))) {');
  assert.ok(run > 0, 'een geplande run weegt het akkoord niet');
  assert.ok(run < runner.indexOf('const userBudget = await checkUserBudget(runAsUserId, orgId);'), 'het akkoord komt na het budget');
  assert.ok(run < runner.indexOf('const outcome = await runAgent('), 'het akkoord komt na het model');
  assert.match(runner.slice(run, run + 400), /cancelRun\(agentId, runId, log, '[^']*', 'ai_off'\)/);
});

test('gerrie-signals: een Gerrie-kaart alleen met het akkoord van de actor', () => {
  const check = signals.indexOf('if (!(await hasAiConsent(supabaseAdmin, actor.id, org))) return skipSignal(');
  assert.ok(check > 0, 'gerrie-signals weegt het akkoord niet');
  assert.ok(check < signals.indexOf('await runAgent(ctx, [], brief.instruction'), 'het akkoord komt na het model');
});

test('MCP: bij het koppelen en bij elke aanroep', () => {
  const approve = mcpOauth.indexOf('if (!(await hasAiConsent(admin, user.id, organizationId))) {');
  assert.ok(approve > 0, 'mcp-oauth weegt het akkoord niet');
  assert.ok(approve < mcpOauth.indexOf("if (body.decision === 'deny')"), 'het akkoord komt te laat bij het koppelen');
  const call = mcp.indexOf('if (!(await hasAiConsent(admin, String(grant.user_id), String(grant.organization_id)))) {');
  assert.ok(call > 0, 'mcp weegt het akkoord niet bij een aanroep');
  assert.ok(call < mcp.indexOf('await chargeRateLimit(String(grant.id), 1);'), 'het akkoord hoort in authenticate, vóór het werk');
});

test('een nieuwe functie die Gerrie laat denken, weegt ook het akkoord', () => {
  // Wie het model van Gerrie aanroept, moet het akkoord kennen. Zo valt een
  // nieuwe deur op voordat hij live staat. runGerrieTool telt hier niet: dat
  // is een databasehandeling zonder model, en de openbare API (api) gebruikt
  // hem voor software met een API-sleutel, niet voor een AI. De MCP-koppeling
  // gebruikt hem wel voor een AI; die staat hierboven apart.
  const functionsDir = new URL('../', import.meta.url);
  const brain = /\b(runAgent|planMission|designAgent|handleReportChat)\s*\(/;
  const missing: string[] = [];
  for (const entry of readdirSync(functionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    let source: string;
    try { source = read(`../${entry.name}/index.ts`); } catch { continue; }
    if (brain.test(source) && !/import \{[^}]*\bhasAiConsent\b[^}]*\} from '\.\.\/_shared\/aiConsent\.ts';/.test(source)) missing.push(entry.name);
  }
  assert.deepEqual(missing, []);
});
