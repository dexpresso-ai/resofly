import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Supabase geeft elke nieuwe functie in schema public een EXECUTE-grant aan anon
 * en authenticated, en Postgres zelf aan PUBLIC. "revoke ... from public" alleen
 * haalt daar niets van weg: zo stonden in september 2026 elf billing-functies
 * open voor de publieke anon-sleutel. Migratie 20260926000000 heeft alle
 * bestaande security-definer-functies dichtgezet voor anon; deze test bewaakt
 * dat elke security-definer-functie uit een LATERE migratie in hetzelfde bestand
 * expliciet voor anon wordt dichtgezet.
 */

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const HARDENING_MIGRATION = '20260926000000';

function laterMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) > HARDENING_MIGRATION)
    .sort();
}

/** Namen van security-definer-functies (geen triggerfuncties) in een SQL-bestand. */
function definerFunctions(sql: string): string[] {
  const names: string[] = [];
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(([\s\S]*?)\bas\s+\$[a-z_]*\$/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql))) {
    const header = match[2];
    if (!/security\s+definer/i.test(header)) continue;
    if (/returns\s+trigger\b/i.test(header)) continue;
    names.push(match[1].toLowerCase());
  }
  return names;
}

function revokesAnon(sql: string, name: string): boolean {
  const re = new RegExp(
    `revoke\\s+(?:all|execute)(?:\\s+privileges)?\\s+on\\s+function\\s+(?:public\\.)?${name}\\s*\\([^;]*\\bfrom\\b[^;]*\\banon\\b[^;]*;`,
    'i',
  );
  return re.test(sql);
}

test('de hardening-migratie zelf staat er', () => {
  const names = readdirSync(MIGRATIONS_DIR);
  assert.ok(names.some((name) => name.startsWith(`${HARDENING_MIGRATION}_`)), 'migratie 20260926000000 ontbreekt');
});

test('elke nieuwe security-definer-functie wordt voor anon dichtgezet', () => {
  const missing: string[] = [];
  for (const file of laterMigrations()) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    for (const name of definerFunctions(sql)) {
      if (!revokesAnon(sql, name)) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'Voeg per functie toe: revoke all on function public.<naam>(<args>) from public, anon; '
      + 'en daarna grant execute ... to authenticated (of alleen service_role).',
  );
});

test('de controle herkent een functie zonder revoke', () => {
  const sql = `create or replace function public.voorbeeld(p uuid) returns void language sql security definer set search_path = public as $$ select 1 $$;`;
  assert.deepEqual(definerFunctions(sql), ['voorbeeld']);
  assert.equal(revokesAnon(sql, 'voorbeeld'), false);
  const fixed = `${sql}\nrevoke all on function public.voorbeeld(uuid) from public, anon;`;
  assert.equal(revokesAnon(fixed, 'voorbeeld'), true);
});
