import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  isOrganizationRole, isWriterRole, memberModuleLevel, MODULE_KEYS, ORGANIZATION_ROLES, ROLE_LABELS, WRITER_ROLES,
} from './roles.ts';
import { resolveModuleLevel, parseModuleAccess } from '../../../src/lib/permissions.ts';

/**
 * De regel "wat mag welke rol per module" staat op vier plekken: in de
 * database (member_module_level), hier (roles.ts, voor alle edge functions), in
 * de app (src/lib/permissions.ts) en in de media-worker. Deze tests houden ze
 * gelijk — en houden de boekhouder op de plek waar die hoort: Financiën lezen, de rest dicht.
 */

const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const ACCOUNTANT = '20261011000000_accountant_guest_access.sql';
const migrationFiles = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
const migration = (name: string) => readFileSync(new URL(name, MIGRATIONS), 'utf8');

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

// ── De regel zelf ────────────────────────────────────────────────────────────

test('de boekhouder: Financiën alleen lezen, de rest dicht — wat er ook is opgeslagen', () => {
  for (const stored of [{}, { finance: 'write', clients: 'write', gerrie: 'write' }, { finance: 'none' }]) {
    for (const module of MODULE_KEYS) {
      assert.equal(
        memberModuleLevel('accountant', stored, module),
        module === 'finance' ? 'read' : 'none',
        `${module} met ${JSON.stringify(stored)}`,
      );
    }
  }
});

test('de bestaande rollen houden precies hun gedrag', () => {
  assert.equal(memberModuleLevel('owner', { finance: 'none' }, 'finance'), 'write');
  assert.equal(memberModuleLevel('admin', { finance: 'none' }, 'finance'), 'write');
  assert.equal(memberModuleLevel('member', {}, 'finance'), 'write', 'ontbrekende sleutel = volledig');
  assert.equal(memberModuleLevel('member', { finance: 'read' }, 'finance'), 'read');
  assert.equal(memberModuleLevel('member', { finance: 'none' }, 'finance'), 'none');
  assert.equal(memberModuleLevel('viewer', {}, 'finance'), 'read');
  assert.equal(memberModuleLevel('viewer', { finance: 'write' }, 'finance'), 'read');
  assert.equal(memberModuleLevel('viewer', { finance: 'none' }, 'finance'), 'none');
});

test('een rol die de regel niet kent, krijgt niets', () => {
  for (const role of ['gast', '', 'OWNER', 'boekhouder']) {
    for (const module of MODULE_KEYS) assert.equal(memberModuleLevel(role, {}, module), 'none', `${role}/${module}`);
  }
  assert.equal(isOrganizationRole('gast'), false);
  assert.equal(isOrganizationRole('accountant'), true);
});

test('schrijven is een allowlist: viewer en boekhouder wijzigen nooit', () => {
  assert.deepEqual([...WRITER_ROLES], ['owner', 'admin', 'member']);
  assert.equal(isWriterRole('accountant'), false);
  assert.equal(isWriterRole('viewer'), false);
  assert.equal(isWriterRole(null), false);
  assert.equal(isWriterRole('member'), true);
  assert.equal(ROLE_LABELS.accountant, 'Boekhouder');
});

// ── Dezelfde regel op de andere plekken ─────────────────────────────────────

test('de app rekent precies hetzelfde als de edge functions', () => {
  const samples: Array<Record<string, string>> = [{}, { finance: 'read' }, { finance: 'none', time: 'read' }, { clients: 'write', gerrie: 'none' }];
  for (const role of ORGANIZATION_ROLES) {
    for (const stored of samples) {
      for (const module of MODULE_KEYS) {
        assert.equal(
          resolveModuleLevel(role, parseModuleAccess(stored), module),
          memberModuleLevel(role, stored, module),
          `${role} / ${module} / ${JSON.stringify(stored)}`,
        );
      }
    }
  }
});

test('de database: member_module_level kent de boekhouder en valt dicht voor de rest', () => {
  const { file, body } = latestDefinition('member_module_level');
  assert.equal(file, ACCOUNTANT);
  assert.match(body, /when p_role in \('owner', 'admin'\) then 'write'/);
  assert.match(body, /when p_role = 'accountant' then case when p_module = 'finance' then 'read' else 'none' end/);
  assert.match(body, /when p_role = 'member' then coalesce\(nullif\(p_module_access ->> p_module, ''\), 'write'\)/);
  assert.match(body, /else 'none'\s+end;/, 'een onbekende rol: dicht');
  // En org_module_level (dus alle module gates) gebruikt hem.
  const level = latestDefinition('org_module_level');
  assert.equal(level.file, ACCOUNTANT);
  assert.match(level.body, /select public\.member_module_level\(m\.role, m\.module_access, p_module\)/);
});

test('de media-worker heeft dezelfde regel, en schrijven is daar ook een allowlist', () => {
  const worker = readFileSync(new URL('../../../workers/media-api/src/index.ts', import.meta.url), 'utf8');
  assert.match(worker, /if \(role === 'accountant'\) return module === 'finance' \? 'read' : 'none';/);
  assert.match(worker, /const WRITER_ROLES = new Set\(\['owner', 'admin', 'member'\]\);/);
  assert.doesNotMatch(worker, /role !== 'viewer'|if \(!role \|\| role === 'viewer'\)|if \(role === 'viewer'\) throw/, 'geen "alles behalve viewer" meer');
});

// ── De migratie ──────────────────────────────────────────────────────────────

test('de rol bestaat in de database, en er is één boekhouder per administratie', () => {
  const sql = migration(ACCOUNTANT);
  assert.match(sql, /check \(role in \('owner', 'admin', 'member', 'viewer', 'accountant'\)\)/);
  assert.match(sql, /check \(role in \('admin', 'member', 'viewer', 'accountant'\)\)/);
  assert.match(sql, /create unique index if not exists organization_members_one_accountant[\s\S]*?where role = 'accountant' and status = 'active';/);
  assert.match(sql, /create unique index if not exists organization_invitations_one_accountant[\s\S]*?where role = 'accountant' and status = 'pending';/);
});

test('de boekhouder neemt nergens een gebruikerslicentie in', () => {
  for (const fn of ['organization_reserved_license_count', 'organization_license_usage', 'organization_billing_overview']) {
    const { file, body } = latestDefinition(fn);
    assert.equal(file, ACCOUNTANT, fn);
    assert.match(body, /role <> 'accountant'/, fn);
  }
  const member = latestDefinition('enforce_member_license_capacity');
  assert.match(member.body, /if new\.status = 'active' and new\.role <> 'accountant' then/);
  const invitation = latestDefinition('enforce_invitation_license_capacity');
  assert.match(invitation.body, /if new\.role = 'accountant' then\s+new\.consumes_license := false;\s+return new;/);
});

test('uitnodigen als boekhouder: vaste rechten, geen seat, één tegelijk', () => {
  const { body } = latestDefinition('invite_organization_member');
  assert.match(body, /p_role not in \('admin','member','viewer','accountant'\)/);
  assert.match(body, /v_access := '\{\}'::jsonb;/);
  assert.match(body, /p_role <> 'accountant', v_user_id, 'pending'/);
  assert.match(body, /Er is al een boekhouder actief/);
});

test('een rol wisselt niet naar of van boekhouder, behalve bij het accepteren', () => {
  const sql = migration(ACCOUNTANT);
  assert.match(sql, /create trigger organization_members_accountant_role_guard\s+before update of role on public\.organization_members/);
  const guard = latestDefinition('prevent_accountant_role_change');
  assert.match(guard.body, /current_setting\('resofly\.accepting_invitation', true\)/);
  const accept = latestDefinition('accept_organization_invitation');
  assert.match(accept.body, /set_config\('resofly\.accepting_invitation', 'on', true\)/);
  assert.match(accept.body, /set_config\('resofly\.accepting_invitation', '', true\)/);
});

test('het hek: elke organisatietabel zonder module gate, en de migratie controleert zichzelf', () => {
  const sql = migration(ACCOUNTANT);
  assert.match(sql, /perform public\.apply_accountant_fence\(v_table\);/);
  assert.match(sql, /select public\.apply_accountant_fence\('organization_members', 'user_id = \(select auth\.uid\(\)\)'\);/);
  assert.match(sql, /select public\.apply_accountant_fence\('audit_logs', 'public\.audit_entity_module\(entity_type\) = ''finance'''\);/);
  assert.match(sql, /select public\.apply_accountant_fence\('attachments', 'public\.attachment_module\(entity_type\) = ''finance'''\);/);
  assert.match(sql, /if exists \(select 1 from public\.accountant_fence_gaps\(\)\) then\s+raise exception/);
  // De rooktest na elke deploy vraagt dezelfde lijst op.
  const smoke = readFileSync(new URL('../../../scripts/supabase-smoke-test.sh', import.meta.url), 'utf8');
  assert.match(smoke, /accountant_fence_gaps\(\)/);
});

test('elke organisatietabel van na het hek krijgt een module gate of het hek', () => {
  // De rooktest ziet een vergeten tabel pas ná de deploy (accountant_fence_gaps);
  // dit vangt hem al in de migratie. Zo gemist in 20261013100000 (drie interne
  // tabellen van bestanden versturen), hersteld in 20261013110000.
  const all = migrationFiles.map((name) => migration(name).replace(/\r\n/g, '\n')).join('\n');
  const missing: string[] = [];
  for (const file of migrationFiles.filter((name) => name > ACCOUNTANT)) {
    const sql = migration(file).replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
    for (const match of sql.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      const [, table, body] = match;
      if (!/\borganization_id\b/.test(body)) continue;
      const covered = new RegExp(`apply_module_gate\\(\\s*'${table}'`).test(all)
        || new RegExp(`apply_accountant_fence\\(\\s*'${table}'`).test(all);
      if (!covered) missing.push(`${file}: ${table}`);
    }
  }
  assert.deepEqual(missing, [], 'deze tabellen hebben geen module gate en geen boekhouder-hek (apply_accountant_fence)');
});

test('een lezer trekt geen inkoopnummer meer', () => {
  const { file, body } = latestDefinition('next_purchase_invoice_number');
  assert.equal(file, ACCOUNTANT);
  assert.match(body, /not public\.can_write_module\(p_organization_id, 'finance'\)/);
});
