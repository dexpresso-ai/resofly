import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * De directe uitvoerders (actions/apply.ts) schrijven als het teamlid: een rij
 * via action_member_write, een databasefunctie via action_member_call. Op de
 * service-role golden RLS, de modulepoort en de bewakers voor "authenticated"
 * niet — tot november 2026 kon een koppeling zo de code van een geboekte
 * rekening wijzigen, en keek de database bij klanten, projecten en tickets niet
 * mee met de modulerechten van het teamlid.
 *
 * Deze test legt de twee kanten naast elkaar: elke tabel en functie die
 * apply.ts gebruikt, staat in de lijst van de database (anders weigert die met
 * "gaat niet via deze weg"), en er schrijft niets meer langs de service-role.
 */

const applySource = readFileSync(new URL('./actions/apply.ts', import.meta.url), 'utf8');
const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);

/** De nieuwste definitie van een functie in de migraties, als tekst. */
function latestDefinition(name: string): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  let found = '';
  for (const file of files) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql))) {
      const end = sql.indexOf('$$;', match.index);
      found = sql.slice(match.index, end > 0 ? end : undefined);
    }
  }
  assert.ok(found, `${name} staat in geen enkele migratie`);
  return found;
}

/** De lijst achter `not in (` in de nieuwste definitie. */
function allowList(name: string, column: string): Set<string> {
  const body = latestDefinition(name);
  const start = body.indexOf(`${column} not in (`);
  assert.ok(start >= 0, `${name}: geen "${column} not in (…)"`);
  const end = body.indexOf(') then', start);
  const list = body.slice(start, end).replace(/--[^\n]*/g, '');
  return new Set([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

/** Tabellen die apply.ts aan updateOne/updateOwn/insertOne geeft. */
function tablesInApply(): Set<string> {
  const tables = new Set<string>();
  for (const m of applySource.matchAll(/\b(?:updateOne|updateOwn|insertOne)(?:<[^>]*>)?\(\s*ctx,\s*'([a-z_]+)'/g)) tables.add(m[1]);
  // Waar de tabel uit een variabele komt: `const table = … ? 'notes' : 'documents'`.
  for (const m of applySource.matchAll(/const table = [^;]*\? '([a-z_]+)' : '([a-z_]+)'/g)) { tables.add(m[1]); tables.add(m[2]); }
  return tables;
}

test('elke tabel van een directe uitvoerder staat in de lijst van action_member_write', () => {
  const allowed = allowList('action_member_write', 'p_table');
  const used = tablesInApply();
  assert.ok(used.size >= 20, `verwacht de tabellen uit apply.ts te vinden, kreeg er ${used.size}`);
  const missing = [...used].filter((table) => !allowed.has(table)).sort();
  assert.deepEqual(missing, [],
    `apply.ts schrijft in ${missing.join(', ')}, maar action_member_write kent die niet: voeg ze toe in een nieuwe migratie.`);
});

test('aanmaken kan alleen in de tabellen waar een uitvoerder ook aanmaakt', () => {
  const body = latestDefinition('action_member_write');
  const start = body.indexOf('if p_row_id is null and p_table not in (');
  assert.ok(start >= 0, 'action_member_write hoort een aparte lijst voor aanmaken te hebben');
  const list = body.slice(start, body.indexOf(') then', start)).replace(/--[^\n]*/g, '');
  const insertable = new Set([...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  const inserted = new Set([...applySource.matchAll(/\binsertOne(?:<[^>]*>)?\(\s*ctx,\s*'([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(inserted.size >= 4, `verwacht de aanmaaktabellen uit apply.ts te vinden, kreeg er ${inserted.size}`);
  assert.deepEqual([...inserted].filter((table) => !insertable.has(table)).sort(), [],
    'apply.ts maakt hier rijen aan die action_member_write niet laat aanmaken.');
  // En andersom: geen ruimere lijst dan nodig. Een klant aanmaken hoort langs
  // create_client_with_next_code (klantnummer, dubbelcontrole), niet hier.
  assert.deepEqual([...insertable].filter((table) => !inserted.has(table)).sort(), [],
    'action_member_write laat aanmaken toe in tabellen waar geen uitvoerder aanmaakt; haal ze uit de lijst.');
});

test('elke functie die een uitvoerder aanroept, staat in de lijst van action_member_call', () => {
  const allowed = allowList('action_member_call', 'p_function');
  const used = [...applySource.matchAll(/memberCall\(ctx, '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 2, 'verwacht de postvak-functies te vinden');
  assert.deepEqual(used.filter((fn) => !allowed.has(fn)), []);
});

test('de hulpjes schrijven alleen via action_member_write', () => {
  for (const name of ['updateOne', 'updateOwn', 'insertOne']) {
    const body = applySource.slice(applySource.indexOf(`async function ${name}`));
    const end = body.indexOf('\n}\n');
    assert.match(body.slice(0, end), /return await memberWrite</, `${name} hoort via memberWrite te schrijven`);
    assert.doesNotMatch(body.slice(0, end), /ctx\.db\.from\(/, `${name} hoort niet zelf naar een tabel te schrijven`);
  }
});

test('nergens in apply.ts schrijft iets rechtstreeks op de service-role', () => {
  const lines = applySource.split('\n');
  const strays: string[] = [];
  lines.forEach((line, index) => {
    if (!/\bctx\.db\.from\(/.test(line)) return;
    const scope = lines.slice(index, index + 4).join('\n');
    if (/\.(update|insert|upsert|delete)\(/.test(scope)) strays.push(`regel ${index + 1}: ${line.trim()}`);
  });
  assert.deepEqual(strays, []);
});

/** Databasefuncties die een uitvoerder op de service-role mag aanroepen: alleen lezen. */
const READ_ONLY_RPCS = new Set(['invoice_open_receivable_cents', 'action_member_write', 'action_member_call']);

test('een uitvoerder roept op de service-role alleen leesfuncties aan', () => {
  const used = [...applySource.matchAll(/ctx\.db\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(used.filter((fn) => !READ_ONLY_RPCS.has(fn)), [],
    'Een functie die schrijft, gaat via memberCall(): dan controleert de database de rechten van het teamlid.');
});

test('beide wissels zijn alleen voor de server en zetten anon dicht', () => {
  for (const name of ['action_member_write', 'action_member_call']) {
    const body = latestDefinition(name);
    assert.match(body, /security invoker/i, `${name}: security invoker, anders wisselt hij niet echt van rol`);
    assert.match(body, /auth\.role\(\) is distinct from 'service_role'/, `${name}: alleen de server`);
    assert.match(body, /m\.status = 'active'/, `${name}: alleen een actief lid`);
    assert.match(body, /set_config\('role', 'authenticated', true\)/, `${name}: de wissel naar het teamlid`);
  }
  const call = latestDefinition('action_member_call');
  assert.match(call, /- 'p_organization_id'\)\s*\|\| jsonb_build_object\('p_organization_id', p_organization_id\)/,
    'action_member_call hoort de organisatie uit de koppeling te zetten, niet uit de argumenten.');
});
