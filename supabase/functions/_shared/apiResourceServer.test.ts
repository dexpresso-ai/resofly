import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Bewaakt de grenzen van de vaste adressen (/v1/clients en verder): de functie
 * `api`, de store (apiResourceStore.ts) en de schrijffunctie in de database
 * (api_rest_write, migratie 20261003020000).
 *
 * Als TEKST gelezen, net als publicApiServer.test.ts: de serverkant leunt op
 * Deno-imports. Grof, maar het vangt precies de fout die we willen voorkomen.
 *
 *   LEZEN      — met de service-role, dus elke query filtert zelf op de
 *                organisatie uit de sleutel.
 *   SCHRIJVEN  — nooit met de service-role, alleen via api_rest_write: als het
 *                teamlid, met de RLS en triggers van de app.
 *   WAT MAG    — leesrecht in de module om te lezen; `execute` én schrijfrecht
 *                om te wijzigen, getoetst vóór er iets gebeurt.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const store = read('./apiResourceStore.ts');
const api = read('../api/index.ts');
const migration = read('../../migrations/20261003020000_api_rest.sql');

function fn(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `"${header}" niet gevonden`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end === -1 ? undefined : end);
}

// ── Lezen ────────────────────────────────────────────────────────────────────

test('elke leesquery in de store filtert op de organisatie uit de sleutel', () => {
  const lines = store.split('\n');
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (!/\.from\(/.test(line)) return;
    const window = lines.slice(index, index + 4).join('\n');
    if (!/\.eq\('organization_id', ctx\.organizationId\)/.test(window)) problems.push(`${index + 1}: ${line.trim()}`);
  });
  assert.deepEqual(problems, [], 'Deze queries draaien op de service-role zonder org-filter en zien dus ook rijen van andere organisaties.');
});

test('de organisatie komt uit de sleutel, nooit uit de invoer', () => {
  assert.match(fn(api, 'function storeContext('), /organizationId: caller\.organizationId, userId: caller\.userId/);
  assert.doesNotMatch(store, /(values|input|params)\s*(\.|\[\s*['"])organization_?[iI]d/);
});

test('een verwijzing naar een andere rij moet in dezelfde organisatie bestaan', () => {
  const refs = fn(store, 'export async function assertReferences(');
  assert.match(refs, /\.eq\('organization_id', ctx\.organizationId\)\.eq\('id', String\(value\)\)/);
  for (const name of ['export async function createRow(', 'export async function updateRow(']) {
    assert.match(fn(store, name), /await assertReferences\(ctx, spec, values\);/, `${name} slaat de verwijzingscontrole over`);
  }
});

// ── Schrijven ────────────────────────────────────────────────────────────────

test('de store schrijft nooit rechtstreeks met de service-role', () => {
  assert.doesNotMatch(store, /\.(insert|update|upsert|delete)\(/, 'schrijven hoort via api_rest_write te gaan, als het teamlid');
  assert.match(fn(store, 'async function write('), /ctx\.db\.rpc\('api_rest_write'/);
  assert.match(fn(store, 'async function write('), /p_user_id: ctx\.userId,\s*\n\s*p_organization_id: ctx\.organizationId,/);
});

test('wijzigen zoekt de rij eerst op binnen de organisatie', () => {
  const update = fn(store, 'export async function updateRow(');
  assert.ok(update.indexOf('await getRow(ctx, spec, id, parentId)') < update.indexOf('await write('));
});

test('api_rest_write: alleen voor de service role, en pas daarna als het teamlid', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.api_rest_write('));
  assert.match(body, /security invoker/, 'als security definer zou hij RLS overslaan — precies wat hij niet moet');
  const roleCheck = body.indexOf("if auth.role() is distinct from 'service_role' then");
  const memberCheck = body.indexOf("m.user_id = p_user_id and m.status = 'active'");
  const switchRole = body.indexOf("perform set_config('role', 'authenticated', true);");
  const claims = body.indexOf("perform set_config('request.jwt.claims'");
  assert.ok(roleCheck > 0 && memberCheck > 0 && switchRole > 0 && claims > 0);
  assert.ok(roleCheck < switchRole && memberCheck < switchRole, 'de controles horen vóór de wissel naar het teamlid');
  assert.ok(claims < switchRole);
  for (const write of ["'insert into public.%1$I", "'update public.%1$I"]) {
    assert.ok(body.indexOf(write) > switchRole, `${write} staat vóór de wissel en draait dus zonder RLS`);
  }
  assert.match(migration, /revoke all on function public\.api_rest_write\(uuid, uuid, text, jsonb, uuid\) from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.api_rest_write\(uuid, uuid, text, jsonb, uuid\) to service_role;/);
});

test('api_rest_write: de organisatie en wie-en-wanneer komen nooit uit de invoer', () => {
  const body = migration.slice(migration.indexOf('create or replace function public.api_rest_write('));
  assert.match(body, /where k in \('id', 'organization_id', 'created_by', 'created_at', 'updated_at'\)/);
  assert.match(body, /or public\.webhook_is_secret_column\(k\)/);
  assert.match(body, /insert into public\.%1\$I as t \(organization_id, created_by%2\$s\) '/);
  assert.match(body, /'select \$1, \$2%2\$s from jsonb_populate_record/);
  assert.match(body, /where t\.id = \$2 and t\.organization_id = \$3/);
});

// ── Wat mag ──────────────────────────────────────────────────────────────────

test('lezen vraagt leesrecht in de module, vóór er iets wordt opgezocht', () => {
  const handler = fn(api, 'async function handleResource(');
  const level = handler.indexOf("if (level === 'none')");
  assert.ok(level > 0 && level < handler.indexOf('listRows(') && level < handler.indexOf('getRow('));
  assert.match(handler, /const level = moduleLevel\(caller, spec\.module\);/);
});

test('aanmaken en wijzigen vragen `execute` en schrijfrecht, getoetst vóór het schrijven', () => {
  const handler = fn(api, 'async function handleResource(');
  for (const call of ['createRow(', 'updateRow(']) {
    const at = handler.indexOf(call);
    const guard = handler.lastIndexOf('assertMayWrite(caller, spec, level);', at);
    assert.ok(at > 0 && guard > 0 && guard < at, `${call} zonder assertMayWrite ervoor`);
  }
  const guard = fn(api, 'function assertMayWrite(');
  assert.match(guard, /if \(!mayExecute\(caller\)\)/);
  assert.match(guard, /if \(level !== 'write'\)/);
});

test('aanmaken en wijzigen zijn veilig te herhalen en komen in het auditlog', () => {
  const handler = fn(api, 'async function handleResource(');
  assert.equal((handler.match(/withIdempotency\(req, caller, route, rawBody, requestId,/g) ?? []).length, 2);
  assert.equal((handler.match(/await recordResourceWrite\(caller, spec, '(create|update)', row, values\);/g) ?? []).length, 2);
  const audit = fn(api, 'async function recordResourceWrite(');
  assert.match(audit, /api_key_id: caller\.keyId/);
  assert.match(audit, /organization_id: caller\.organizationId/);
});

test('een reactie hoort bij een ticket uit DEZE organisatie, en het ticket komt uit het pad', () => {
  const handler = fn(api, 'async function handleResource(');
  assert.match(handler, /if \(spec\.parent && parentId !== null\) await getRow\(ctx, RESOURCES\[spec\.parent\.resource\], parentId\);/);
  assert.match(handler, /if \(spec\.parent && parentId !== null\) values\[spec\.parent\.column\] = parentId;/);
});
