import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanRow, EXPORT_MANIFEST, EXPORT_SCHEMA_VERSION, exportTables, fileKeysOf, looksSecret, skippedTables, zipPathForKey,
  type ExportTableRule,
} from './exportManifest.ts';

/**
 * Het exportmanifest tegen het echte schema. Het schema komt uit de migraties,
 * op volgorde gelezen: create table, alter table add/drop/rename column, drop
 * table. Op 11 november 2026 gaf dat precies dezelfde 205 tabellen en kolommen
 * als een verse database (supabase db start), op de views na.
 */

const migrationsDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const migrationFiles = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Splitst op komma's buiten haakjes en aanhalingstekens. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '\'' || ch === '"') {
      quote = ch; current += ch;
    } else if (ch === '(') {
      depth += 1; current += ch;
    } else if (ch === ')') {
      depth -= 1; current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current); current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

const NOT_A_COLUMN = /^\s*(constraint|primary\s+key|unique|check|foreign\s+key|exclude|like)\b/i;

function readSchema(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const statement = /create\s+table\s+(if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(|alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?\s+([^;]*?);|drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi;
  for (const file of migrationFiles) {
    const sql = stripComments(readFileSync(join(migrationsDir, file), 'utf8'));
    for (const match of sql.matchAll(statement)) {
      if (match[2]) {
        const name = match[2];
        let depth = 1;
        let end = match.index! + match[0].length;
        while (end < sql.length && depth > 0) {
          if (sql[end] === '(') depth += 1;
          else if (sql[end] === ')') depth -= 1;
          end += 1;
        }
        if (tables.has(name) && match[1]) continue;
        const columns: string[] = [];
        for (const part of splitTopLevel(sql.slice(match.index! + match[0].length, end - 1))) {
          if (!part.trim() || NOT_A_COLUMN.test(part)) continue;
          const column = /^\s*"?(\w+)"?\s+/.exec(part);
          if (column) columns.push(column[1]);
        }
        tables.set(name, columns);
      } else if (match[3]) {
        let name = match[3];
        if (!tables.has(name)) continue;
        for (const raw of splitTopLevel(match[4])) {
          const action = raw.trim();
          const columns = tables.get(name)!;
          const add = /^add\s+column\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/i.exec(action);
          const drop = /^drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?/i.exec(action);
          const rename = /^rename\s+column\s+"?(\w+)"?\s+to\s+"?(\w+)"?/i.exec(action);
          const renameTable = /^rename\s+to\s+"?(\w+)"?/i.exec(action);
          if (add && !columns.includes(add[1])) columns.push(add[1]);
          else if (drop) tables.set(name, columns.filter(c => c !== drop[1]));
          else if (rename) tables.set(name, columns.map(c => (c === rename[1] ? rename[2] : c)));
          else if (renameTable) { tables.set(renameTable[1], columns); tables.delete(name); name = renameTable[1]; }
        }
      } else if (match[5]) {
        tables.delete(match[5]);
      }
    }
  }
  return tables;
}

const schema = readSchema();
const exportRules = Object.entries(EXPORT_MANIFEST).filter((entry): entry is [string, ExportTableRule] => entry[1].kind === 'export');

test('het schema is gevonden', () => {
  assert.ok(schema.size > 200, `maar ${schema.size} tabellen gevonden in de migraties`);
  assert.ok(schema.get('invoices')?.includes('organization_id'));
});

test('elke tabel staat in het manifest', () => {
  const missing = [...schema.keys()].filter(table => !(table in EXPORT_MANIFEST)).sort();
  assert.deepEqual(missing, [], `Deze tabellen staan niet in src/lib/exportManifest.ts. Zet ze erin: 'export' als ze bij de administratie van de klant horen, anders een soort met een reden.\n${missing.join('\n')}`);
});

test('het manifest noemt geen tabellen die niet meer bestaan', () => {
  const stale = Object.keys(EXPORT_MANIFEST).filter(table => !schema.has(table)).sort();
  assert.deepEqual(stale, [], `Deze tabellen bestaan niet (meer): ${stale.join(', ')}`);
});

test('een tabel die meegaat, is per organisatie te lezen en stabiel te doorbladeren', () => {
  for (const [table, rule] of exportRules) {
    const columns = schema.get(table)!;
    const orgColumn = rule.orgColumn ?? 'organization_id';
    assert.ok(columns.includes(orgColumn), `${table}: kolom ${orgColumn} bestaat niet`);
    for (const column of rule.orderBy ?? ['id']) {
      assert.ok(columns.includes(column), `${table}: sorteren op ${column} kan niet; zet orderBy op de primaire sleutel`);
    }
  }
});

test('elke genoemde kolom bestaat', () => {
  for (const [table, rule] of exportRules) {
    const columns = schema.get(table)!;
    const named = [
      ...Object.keys(rule.omit ?? {}), ...(rule.keep ?? []), ...(rule.files ?? []),
      ...Object.keys(rule.fileLists ?? {}), ...Object.keys(rule.skipFiles ?? {}), ...(rule.select ?? []),
    ];
    for (const column of named) assert.ok(columns.includes(column), `${table}.${column} bestaat niet`);
  }
});

test('select en omit samen zijn precies alle kolommen', () => {
  for (const [table, rule] of exportRules) {
    if (!rule.select) continue;
    const covered = [...rule.select, ...Object.keys(rule.omit ?? {})].sort();
    assert.deepEqual(covered, [...schema.get(table)!].sort(), `${table}: een kolom ontbreekt in select of omit`);
  }
});

test('een kolom die als sleutel werkt, gaat alleen mee als dat uitdrukkelijk mag', () => {
  const problems: string[] = [];
  for (const [table, rule] of exportRules) {
    for (const column of schema.get(table)!) {
      if (!looksSecret(column)) continue;
      if (rule.omit && column in rule.omit) continue;
      if (rule.keep?.includes(column)) continue;
      problems.push(`${table}.${column}`);
    }
  }
  assert.deepEqual(problems, [], `Zet deze kolommen in omit (met reden) of, als het geen sleutel is, in keep:\n${problems.join('\n')}`);
});

test('elke kolom met een opslagsleutel is bekend: het bestand gaat mee of er staat waarom niet', () => {
  const problems: string[] = [];
  for (const [table, rule] of exportRules) {
    for (const column of schema.get(table)!) {
      if (!/(^|_)storage_key$/.test(column)) continue;
      if (rule.files?.includes(column) || (rule.skipFiles && column in rule.skipFiles)) continue;
      problems.push(`${table}.${column}`);
    }
  }
  assert.deepEqual(problems, [], `Zet deze kolommen in files of skipFiles:\n${problems.join('\n')}`);
});

test('wat niet meegaat, heeft een reden', () => {
  for (const { table, reason } of skippedTables()) assert.ok(reason.trim().length > 20, `${table}: geen reden`);
});

test('geen enkele galerijtabel gaat mee', () => {
  for (const { table } of exportTables()) assert.ok(!table.startsWith('gallery') && table !== 'galleries', `${table} hoort niet in de export`);
});

test('de schemaversie is de laatste migratie', () => {
  const latest = migrationFiles[migrationFiles.length - 1].slice(0, 14);
  assert.equal(EXPORT_SCHEMA_VERSION, latest, `Er is een nieuwere migratie (${latest}). Kijk of er tabellen of kolommen bijkwamen en zet EXPORT_SCHEMA_VERSION op ${latest}.`);
});

// ── De hulpfuncties ─────────────────────────────────────────────────────────

test('looksSecret kijkt naar hele woorden', () => {
  for (const column of ['token_hash', 'public_token_hash', 'password_hash', 'share_pin_hash', 'api_key_encrypted', 'organizer_token', 'refresh_token_encrypted']) {
    assert.ok(looksSecret(column), column);
  }
  for (const column of ['input_tokens', 'auditor_opinion_received', 'is_pinned', 'pinned_at', 'storage_key', 'api_key_id', 'signature_image', 'bookkeeping_start_date']) {
    assert.ok(!looksSecret(column), column);
  }
});

test('cleanRow laat omit en onbekende sleutels weg, en houdt keep', () => {
  const rule: ExportTableRule = { kind: 'export', omit: { secret_note: 'test' }, keep: ['file_hash'] };
  assert.deepEqual(
    cleanRow(rule, { id: '1', name: 'Jansen', secret_note: 'x', file_hash: 'abc', new_token: 'zzz' }),
    { id: '1', name: 'Jansen', file_hash: 'abc' },
  );
});

test('fileKeysOf vindt sleutels in kolommen en in JSON-lijsten', () => {
  const rule: ExportTableRule = { kind: 'export', files: ['storage_key', 'pdf_storage_key'], fileLists: { attachments: 'storage_key' } };
  assert.deepEqual(fileKeysOf(rule, {
    storage_key: 'org/client/1/a.pdf',
    pdf_storage_key: null,
    attachments: [{ storage_key: 'org/purchase_invoice_inbox/2/b.pdf' }, { name: 'zonder sleutel' }, null],
  }), ['org/client/1/a.pdf', 'org/purchase_invoice_inbox/2/b.pdf']);
});

test('zipPathForKey: alleen bestanden van deze organisatie, nooit galerij of zending', () => {
  const org = '11111111-1111-1111-1111-111111111111';
  assert.equal(zipPathForKey(`${org}/invoice-pdfs/abc/123-FAC-2026-0001.pdf`, org), 'bestanden/facturen-pdf/abc/123-FAC-2026-0001.pdf');
  assert.equal(zipPathForKey(`${org}/client/abc/x-offerte.docx`, org), 'bestanden/klanten/abc/x-offerte.docx');
  assert.equal(zipPathForKey(`${org}/iets-nieuws/abc/x.pdf`, org), 'bestanden/overig/abc/x.pdf');
  assert.equal(zipPathForKey(`${org}/gallery/g/i/master.jpg`, org), null);
  assert.equal(zipPathForKey(`${org}/transfer/t/x.pdf`, org), null);
  assert.equal(zipPathForKey(`22222222-2222-2222-2222-222222222222/client/abc/x.pdf`, org), null);
  assert.equal(zipPathForKey(`${org}/client/../../etc/passwd`, org), null);
  assert.equal(zipPathForKey(`${org}/client`, org), null);
});
