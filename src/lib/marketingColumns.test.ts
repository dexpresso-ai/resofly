import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * De kolommen die het scherm en de campaigns-functie opvragen, naast de
 * kolommen die de migraties aanmaken.
 *
 * Waarom: PostgREST weigert een vraag met één onbekende kolom helemaal. Tot
 * november 2026 vroeg het scherm `created_by` op bij de ontvangers van een
 * campagne; die kolom bestaat niet, en de ontvangerslijst laadde nooit. Geen
 * typecheck ziet dat: de kolommen zijn een tekst.
 */

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const migrations = readdirSync(new URL('supabase/migrations/', root))
  .filter((name) => /^\d{14}_.+\.sql$/.test(name))
  .sort()
  .map((name) => read(`supabase/migrations/${name}`));

/** Kolommen van een tabel: uit `create table` en latere `add column`. */
function tableColumns(table: string): Set<string> {
  const columns = new Set<string>();
  const create = new RegExp(`create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
  const alter = new RegExp(`alter table (?:if exists )?(?:only )?public\\.${table}\\b([^;]*);`, 'gi');
  for (const sql of migrations) {
    const block = create.exec(sql);
    if (block) {
      for (const line of block[1].split('\n')) {
        const m = line.trim().match(/^([a-z_][a-z0-9_]*)\s+(uuid|text|integer|int|bigint|jsonb|timestamptz|boolean|numeric|date|citext)\b/i);
        if (m) columns.add(m[1].toLowerCase());
      }
    }
    for (const statement of sql.matchAll(alter)) {
      for (const add of statement[1].matchAll(/add column (?:if not exists )?([a-z_][a-z0-9_]*)/gi)) columns.add(add[1].toLowerCase());
    }
  }
  return columns;
}

function constant(source: string, name: string, file: string): string[] {
  const m = source.match(new RegExp(`const ${name} =\\s*'([^']+)'`));
  assert.ok(m, `${name} niet gevonden in ${file}`);
  return m[1].split(',').map((column) => column.trim());
}

const repository = read('src/lib/repository.ts');
const campaigns = read('supabase/functions/campaigns/index.ts');

const LISTS: Array<{ file: string; source: string; name: string; table: string }> = [
  { file: 'repository.ts', source: repository, name: 'CAMPAIGN_COLUMNS', table: 'email_campaigns' },
  { file: 'repository.ts', source: repository, name: 'CAMPAIGN_RECIPIENT_COLUMNS', table: 'email_campaign_recipients' },
  { file: 'repository.ts', source: repository, name: 'FLOW_COLUMNS', table: 'email_flows' },
  { file: 'repository.ts', source: repository, name: 'FLOW_STEP_COLUMNS', table: 'email_flow_steps' },
  { file: 'repository.ts', source: repository, name: 'FLOW_ENROLLMENT_COLUMNS', table: 'email_flow_enrollments' },
  { file: 'campaigns/index.ts', source: campaigns, name: 'CAMPAIGN_COLUMNS', table: 'email_campaigns' },
  { file: 'campaigns/index.ts', source: campaigns, name: 'FLOW_COLUMNS', table: 'email_flows' },
  { file: 'campaigns/index.ts', source: campaigns, name: 'FLOW_STEP_COLUMNS', table: 'email_flow_steps' },
];

test('de migraties leveren de marketingtabellen zoals deze test ze leest', () => {
  // Leest de test de migraties verkeerd, dan zou hieronder alles "ontbreken".
  assert.ok(tableColumns('email_campaign_recipients').has('merge_data'), 'merge_data (20260814) niet gevonden');
  assert.ok(tableColumns('email_campaigns').has('started_at'));
  assert.equal(tableColumns('email_campaign_recipients').has('created_by'), false);
});

for (const list of LISTS) {
  test(`${list.file}: ${list.name} vraagt alleen kolommen die ${list.table} heeft`, () => {
    const known = tableColumns(list.table);
    const missing = constant(list.source, list.name, list.file).filter((column) => !known.has(column));
    assert.deepEqual(missing, [], `${list.table} heeft deze kolommen niet`);
  });
}

test('repository.ts: de afmeldlijst vraagt alleen kolommen die email_suppressions heeft', () => {
  const m = repository.match(/from\('email_suppressions'\)\s*\.select\('([^']+)'\)/);
  assert.ok(m, 'loadSuppressions niet gevonden');
  const known = tableColumns('email_suppressions');
  assert.deepEqual(m[1].split(',').filter((column) => !known.has(column)), []);
});
