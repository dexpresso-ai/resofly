import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Bewaakt de naden van de beslislijst tegen enum-drift.
 *
 * De acht kaartsoorten staan op vier plekken: de migratie (ai_signal_kinds()),
 * de regels (signalRules.ts), de frontend (decisions-api.ts) en de
 * moduletabel/herkomsttabel in de regels. Eén plek vergeten en je krijgt een
 * signaal dat de database weigert, of een kaart zonder label — stil, pas
 * zichtbaar als iemand hem mist. Hetzelfde geldt voor het push-type
 * 'decision_digest', dat op vier plekken tegelijk moet bestaan.
 *
 * Alles wordt als TEKST gelezen: gerrieCore leest bij import Deno-env uit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

const migration = read('../../migrations/20260914000000_gerrie_beslislijst.sql');
const rules = read('signalRules.ts');
const api = read('../../../src/lib/decisions-api.ts');
const core = read('gerrieCore.ts');
const pushApi = read('../../../src/lib/push-api.ts');

function quoted(block: string): string[] {
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}
function between(source: string, start: string, end: string, label: string): string {
  const a = source.indexOf(start);
  assert.ok(a >= 0, `kon "${start}" niet vinden in ${label}`);
  const b = source.indexOf(end, a + start.length);
  assert.ok(b > a, `kon het einde van "${start}" niet vinden in ${label}`);
  return source.slice(a + start.length, b);
}

const sqlKinds = quoted(between(migration, 'create or replace function public.ai_signal_kinds()', ']::text[]', 'de migratie'));
const tsKinds = quoted(between(rules, 'export const SIGNAL_KINDS = [', '] as const', 'signalRules.ts'));
const apiKinds = [...between(api, 'export const DECISION_KIND_INFO', '\n};', 'decisions-api.ts').matchAll(/^\s{2}([a-z_]+): \{/gm)].map((m) => m[1]);
const ruleKinds = quoted(between(rules, 'export const RULE_KINDS = [', '] as const', 'RULE_KINDS'));
const gerrieKinds = quoted(between(rules, 'export const GERRIE_KINDS = [', '] as const', 'GERRIE_KINDS'));

test('de acht soorten staan in migratie, regels en frontend gelijk', () => {
  assert.equal(sqlKinds.length, 8, 'de migratie kent niet precies acht soorten');
  assert.deepEqual([...tsKinds].sort(), [...sqlKinds].sort(), 'signalRules.ts en de migratie lopen uit de pas');
  assert.deepEqual([...apiKinds].sort(), [...sqlKinds].sort(), 'decisions-api.ts en de migratie lopen uit de pas');
});

test('elke soort is óf regel óf Gerrie, en heeft een module', () => {
  assert.deepEqual([...ruleKinds, ...gerrieKinds].sort(), [...sqlKinds].sort(), 'RULE_KINDS + GERRIE_KINDS dekken niet precies alle soorten');
  const moduleKeys = [...between(rules, 'export const KIND_MODULE', '\n};', 'KIND_MODULE').matchAll(/^\s{2}([a-z_]+): '/gm)].map((m) => m[1]);
  const originKeys = [...between(rules, 'export const KIND_ORIGIN', '\n};', 'KIND_ORIGIN').matchAll(/^\s{2}([a-z_]+): '/gm)].map((m) => m[1]);
  assert.deepEqual([...moduleKeys].sort(), [...sqlKinds].sort(), 'KIND_MODULE mist een soort');
  assert.deepEqual([...originKeys].sort(), [...sqlKinds].sort(), 'KIND_ORIGIN mist een soort');
  const known = ['clients', 'projects', 'time', 'calendar', 'tickets', 'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie'];
  const modules = [...between(rules, 'export const KIND_MODULE', '\n};', 'KIND_MODULE').matchAll(/: '([a-z]+)'/g)].map((m) => m[1]);
  const bad = modules.filter((m) => !known.includes(m));
  assert.deepEqual(bad, [], `onbekende module in KIND_MODULE: ${bad.join(', ')}`);
});

test('elke Gerrie-soort heeft een allowlist van bestaande tools', () => {
  const toolNames = new Set([...core.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]));
  const block = between(rules, 'export const GERRIE_ALLOWED_TOOLS', '\n};', 'GERRIE_ALLOWED_TOOLS');
  for (const kind of gerrieKinds) {
    const line = block.split('\n').find((l) => l.trim().startsWith(`${kind}:`));
    assert.ok(line, `geen allowlist voor ${kind}`);
    const tools = quoted(line);
    assert.ok(tools.length > 0, `lege allowlist voor ${kind}`);
    const missing = tools.filter((t) => !toolNames.has(t));
    assert.deepEqual(missing, [], `allowlist van ${kind} noemt tools die niet bestaan: ${missing.join(', ')}`);
    assert.ok(tools.some((t) => t.startsWith('propose_')), `${kind} kan niets klaarzetten (geen propose_-tool)`);
  }
});

test("push-type 'decision_digest' bestaat op alle vier de plekken", () => {
  const checks = migration.match(/event_type in \([^)]*'decision_digest'[^)]*\)/g) ?? [];
  assert.equal(checks.length, 2, 'de migratie moet decision_digest in BEIDE CHECKs (outbox én preferences) zetten');
  assert.match(pushApi, /\|\s*'decision_digest'/, 'PushEventType in push-api.ts mist decision_digest');
  assert.match(pushApi, /type: 'decision_digest'/, 'PUSH_EVENTS in push-api.ts mist decision_digest');
});

test('de migratie heeft voor elke signaalbron een exception-wrapped trigger', () => {
  const triggers = [...migration.matchAll(/create or replace function public\.(ai_signal_on_[a-z_]+)\(\)/g)].map((m) => m[1]);
  assert.equal(triggers.length, 7, `verwacht zeven triggerfuncties, kreeg ${triggers.length}`);
  for (const name of triggers) {
    const body = between(migration, `public.${name}()`, '$$;\n', name);
    assert.match(body, /exception when others then/, `${name} is niet exception-wrapped: een fout zou de bron-insert breken`);
    assert.match(body, /security definer/, `${name} moet security definer zijn`);
  }
});
