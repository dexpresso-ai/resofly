import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Elke kolom die een handeling opvraagt, bestaat ook.
 *
 * Een select met een kolom die er niet is, faalt pas als iemand de handeling
 * echt gebruikt — en dan altijd. Zo stonden quote.history, quote.submit_internal
 * en quote.approve_internal maandenlang op `quotes.total_amount`, een kolom die
 * alleen op quote_versions bestaat: ze werkten nooit.
 *
 * Het schema komt uit FRESH_INSTALL_COMPLETE_SCHEMA.sql plus de migraties
 * (create table, add column, rename column). Een tabel die daar niet in te
 * vinden is, wordt overgeslagen: deze test zoekt fouten, geen volledigheid.
 */

const root = new URL('../../', import.meta.url);
const migrationsDir = new URL('migrations/', root);
const sources = [
  readFileSync(new URL('FRESH_INSTALL_COMPLETE_SCHEMA.sql', root), 'utf8'),
  ...readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    .map((name) => readFileSync(new URL(name, migrationsDir), 'utf8')),
];

const SKIP = new Set(['constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like']);
const schema = new Map<string, Set<string>>();
const columnsOf = (table: string) => {
  if (!schema.has(table)) schema.set(table, new Set());
  return schema.get(table)!;
};

for (const sql of sources) {
  // Commentaar eerst weg: haakjes en komma's daarin verstoren het tellen.
  const lower = sql.replace(/--[^\n]*/g, '').toLowerCase();
  for (const match of lower.matchAll(/create table (?:if not exists )?(?:public\.)?"?(\w+)"? \(/g)) {
    const start = match.index! + match[0].length;
    let depth = 1;
    let end = start;
    while (end < lower.length && depth > 0) {
      if (lower[end] === '(') depth += 1;
      else if (lower[end] === ')') depth -= 1;
      end += 1;
    }
    const body = lower.slice(start, end - 1);
    let level = 0;
    let current = '';
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === '(') level += 1;
      if (ch === ')') level -= 1;
      if (ch === ',' && level === 0) { parts.push(current); current = ''; } else current += ch;
    }
    parts.push(current);
    for (const part of parts) {
      const name = part.replace(/--[^\n]*/g, '').trim().split(/\s+/)[0]?.replace(/"/g, '');
      if (name && !SKIP.has(name) && /^\w+$/.test(name)) columnsOf(match[1]).add(name);
    }
  }
  for (const match of lower.matchAll(/alter table (?:if exists )?(?:only )?(?:public\.)?"?(\w+)"?([\s\S]*?);/g)) {
    for (const add of match[2].matchAll(/add column (?:if not exists )?"?(\w+)"?/g)) columnsOf(match[1]).add(add[1]);
    for (const rename of match[2].matchAll(/rename column "?(\w+)"? to "?(\w+)"?/g)) columnsOf(match[1]).add(rename[2]);
  }
}

const SELECTS = [
  /\brow<[\s\S]*?>\(\s*ctx,\s*'(\w+)',\s*[\w.]+,\s*((?:'[^']*'\s*\+?\s*)+)/g,
  /\brow\(\s*ctx,\s*'(\w+)',\s*[\w.]+,\s*((?:'[^']*'\s*\+?\s*)+)/g,
  /\borgQuery\(\s*ctx,\s*'(\w+)',\s*((?:'[^']*'\s*\+?\s*)+)/g,
  /\borgTable\(\s*'(\w+)'[^)]*\)\s*\.select\(\s*((?:'[^']*'\s*\+?\s*)+)/g,
  /\.from\(\s*'(\w+)'\s*\)\s*\.select\(\s*((?:'[^']*'\s*\+?\s*)+)/g,
];

/** 'a, b, rel(x, y), alias:c' -> ['a', 'b', 'c']: ingebedde relaties tellen niet mee. */
function selectedColumns(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of select) {
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; current += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(current.trim()); current = ''; } else current += ch;
  }
  out.push(current.trim());
  return out.filter((item) => item && item !== '*' && !item.includes('('))
    .map((item) => item.split(':').pop()!.split('::')[0].split('->')[0].trim());
}

test('elke kolom die een handeling, kerntool of de API opvraagt, bestaat in het schema', () => {
  const actionsDir = new URL('./actions/', import.meta.url);
  const files = [
    ...readdirSync(actionsDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts')).map((name) => new URL(name, actionsDir)),
    new URL('./gerrieCore.ts', import.meta.url),
    new URL('./apiResourceStore.ts', import.meta.url),
    new URL('./webhookAdmin.ts', import.meta.url),
    new URL('./webhookDelivery.ts', import.meta.url),
    new URL('../api/index.ts', import.meta.url),
  ];
  const missing: string[] = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of SELECTS) {
      for (const match of source.matchAll(pattern)) {
        const table = match[1];
        const known = schema.get(table);
        if (!known || known.size === 0) continue;
        const select = [...match[2].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
        for (const column of selectedColumns(select)) {
          checked += 1;
          if (!known.has(column)) missing.push(`${file.pathname.split('/functions/')[1]}: ${table}.${column}`);
        }
      }
    }
  }
  assert.ok(checked > 500, `te weinig kolommen gevonden (${checked}); klopt het patroon nog?`);
  assert.deepEqual([...new Set(missing)].sort(), []);
});
