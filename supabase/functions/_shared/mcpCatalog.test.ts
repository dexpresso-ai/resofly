import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MCP_PROMPTS, MCP_RESOURCES, MCP_RESOURCE_TEMPLATES, findPrompt,
  matchTemplate, templateField, type McpResource,
} from './mcpCatalog.ts';

/**
 * Bewaakt dat de catalogus blijft kloppen met de handelingenregistry.
 *
 * Een bron als `resofly://postvak` is een naam die naar een handeling wijst.
 * Wordt die handeling ooit hernoemd of van module verhuisd, dan blijft de bron
 * er keurig staan en breekt hij pas op het moment dat een klant hem aanklikt —
 * met een foutmelding waar hij niets van begrijpt, in zijn eigen AI-app, waar
 * wij het niet zien gebeuren. Vandaar dat dit een test is en geen afspraak.
 *
 * De registry wordt als TEKST gelezen, net als in de andere bewakingstests: de
 * serverkant leunt op Deno-imports en is niet in node te laden.
 */

const here = dirname(fileURLToPath(import.meta.url));
const actionsDir = join(here, 'actions');

const MODULES = new Set([
  'clients', 'projects', 'time', 'calendar', 'tickets',
  'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie',
]);

interface ActionFacts { kind: string; module: string; required: string[] }

/** Leest per handeling-id de soort, de module en de verplichte invoervelden. */
function registry(): Map<string, ActionFacts> {
  const facts = new Map<string, ActionFacts>();
  for (const file of readdirSync(actionsDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    if (['types.ts', 'index.ts', 'registry.ts'].includes(file)) continue;
    const source = readFileSync(join(actionsDir, file), 'utf8');
    for (const block of source.split(/^ {4}id: '/m).slice(1)) {
      const id = block.slice(0, block.indexOf("'"));
      const head = block.slice(0, 2000);
      const kind = /^ {4}kind: '(read|write)',/m.exec(head)?.[1] ?? '';
      const module = /^ {4}module: '([a-z]+)',/m.exec(head)?.[1] ?? '';
      const requiredRaw = /^ {4}required: \[(.*?)\],/ms.exec(head)?.[1] ?? '';
      const required = [...requiredRaw.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]);
      facts.set(id, { kind, module, required });
    }
  }
  return facts;
}

const ACTIONS = registry();

test('de registry is überhaupt uitgelezen', () => {
  // Zonder dit slaagt alles hieronder gratis zodra het uitlezen stukloopt.
  assert.ok(ACTIONS.size > 200, `verwacht honderden handelingen, gevonden: ${ACTIONS.size}`);
});

// ── Bronnen ──────────────────────────────────────────────────────────────────

const ALL: McpResource[] = [...MCP_RESOURCES, ...MCP_RESOURCE_TEMPLATES];

test('elke bron wijst naar een handeling die bestaat en alleen leest', () => {
  for (const resource of ALL) {
    if (resource.actionId === null) continue; // door de server zelf samengesteld
    const action = ACTIONS.get(resource.actionId);
    assert.ok(action, `bron "${resource.name}" wijst naar "${resource.actionId}", en die handeling bestaat niet`);
    assert.equal(action.kind, 'read',
      `bron "${resource.name}" gebruikt "${resource.actionId}", maar dat is een ${action.kind}-handeling. Een bron hoort alleen te lezen.`);
  }
});

test('de module van een bron klopt met die van zijn handeling', () => {
  for (const resource of ALL) {
    if (resource.actionId === null) {
      assert.equal(resource.module, null, `bron "${resource.name}" heeft geen handeling en hoort dus geen module te noemen`);
      continue;
    }
    assert.ok(resource.module && MODULES.has(resource.module), `bron "${resource.name}" noemt een onbekende module: ${resource.module}`);
    assert.equal(resource.module, ACTIONS.get(resource.actionId)!.module,
      `bron "${resource.name}" staat op module "${resource.module}", maar "${resource.actionId}" hoort bij "${ACTIONS.get(resource.actionId)!.module}". ` +
      'Dan ziet iemand een bron die hij niet mag ophalen, of andersom.');
  }
});

test('een sjabloon vult precies het veld in dat zijn handeling verplicht stelt', () => {
  for (const resource of MCP_RESOURCE_TEMPLATES) {
    const field = templateField(resource.uri);
    assert.ok(field, `sjabloon "${resource.name}" heeft geen veld in zijn adres: ${resource.uri}`);
    const required = ACTIONS.get(resource.actionId!)!.required;
    assert.deepEqual(required, [field],
      `sjabloon "${resource.name}" vult "${field}" in, maar "${resource.actionId}" verlangt [${required.join(', ')}]. ` +
      'Die twee moeten gelijk zijn, anders klopt het adres niet met wat de handeling vraagt.');
  }
});

test('vaste bronnen leveren alles aan wat hun handeling verplicht stelt', () => {
  for (const resource of MCP_RESOURCES) {
    if (resource.actionId === null) continue;
    const required = ACTIONS.get(resource.actionId)!.required;
    const given = Object.keys(resource.input ?? {});
    const missing = required.filter((key) => !given.includes(key));
    assert.deepEqual(missing, [],
      `bron "${resource.name}" mist verplichte invoer voor "${resource.actionId}": ${missing.join(', ')}. ` +
      'Een vaste bron heeft geen gebruiker om het alsnog te vragen, dus hij loopt meteen stuk.');
  }
});

test('namen en adressen zijn uniek', () => {
  const names = ALL.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, `dubbele bronnaam: ${names.join(', ')}`);
  const uris = ALL.map((r) => r.uri);
  assert.equal(new Set(uris).size, uris.length, `dubbel bronadres: ${uris.join(', ')}`);
});

test('een vaste bron heeft geen veld in zijn adres', () => {
  for (const resource of MCP_RESOURCES) {
    assert.equal(templateField(resource.uri), null,
      `bron "${resource.name}" heeft een {veld} in zijn adres maar staat bij de vaste bronnen`);
  }
});

// ── Het matchen van adressen ────────────────────────────────────────────────

test('een adres past alleen op het sjabloon waar het bij hoort', () => {
  const template = 'resofly://project/{project_id}';
  assert.equal(matchTemplate(template, 'resofly://project/abc-123'), 'abc-123');
  // En alle manieren waarop het NIET hoort te passen:
  assert.equal(matchTemplate(template, 'resofly://project/'), null);
  assert.equal(matchTemplate(template, 'resofly://project'), null);
  assert.equal(matchTemplate(template, 'resofly://factuur/abc-123'), null);
  assert.equal(matchTemplate(template, 'resofly://project/abc/def'), null, 'een tweede segment hoort niet mee te glippen');
  assert.equal(matchTemplate(template, 'https://elders.nl/project/abc'), null);
  assert.equal(matchTemplate(template, ''), null);
});

test('een adres met leestekens komt er onbeschadigd uit', () => {
  assert.equal(matchTemplate('resofly://klant/{client_id}', 'resofly://klant/a%20b'), 'a b');
});

// ── Standaardvragen ─────────────────────────────────────────────────────────

test('elke standaardvraag noemt bestaande modules', () => {
  for (const prompt of MCP_PROMPTS) {
    assert.ok(prompt.modules.length > 0, `standaardvraag "${prompt.name}" noemt geen enkele module`);
    for (const module of prompt.modules) {
      assert.ok(MODULES.has(module), `standaardvraag "${prompt.name}" noemt een onbekende module: ${module}`);
    }
  }
});

test('elke standaardvraag levert een bruikbare opdracht op', () => {
  for (const prompt of MCP_PROMPTS) {
    const args = Object.fromEntries(prompt.arguments.map((a) => [a.name, 'proefwaarde']));
    const text = prompt.build(args);
    assert.ok(text.length > 80, `de opdracht van "${prompt.name}" is verdacht kort`);
    // Elke opdracht hoort het model naar de registry te sturen; anders gaat het
    // gokken op wat de app kan.
    assert.match(text, /find_actions/, `"${prompt.name}" vertelt het model niet hoe het moet zoeken`);
  }
});

test('een ingevuld veld komt echt in de opdracht terecht', () => {
  const prompt = findPrompt('klant-doorlichten');
  assert.ok(prompt, 'klant-doorlichten hoort te bestaan');
  assert.match(prompt.build({ klant: 'Van Dijk BV' }), /Van Dijk BV/);
});

test('een ontbrekend veld laat geen "undefined" in de opdracht achter', () => {
  // Een client mag een verplicht veld weglaten; dan hoort er geen kapotte zin
  // naar het model te gaan.
  for (const prompt of MCP_PROMPTS) {
    const text = prompt.build({});
    assert.doesNotMatch(text, /undefined|\[object Object\]/, `"${prompt.name}" lekt een lege waarde in zijn opdracht`);
  }
});

test('namen van standaardvragen zijn uniek en opzoekbaar', () => {
  const names = MCP_PROMPTS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, `dubbele naam: ${names.join(', ')}`);
  for (const name of names) assert.ok(findPrompt(name), `"${name}" is niet op te zoeken`);
  assert.equal(findPrompt('bestaat-niet'), undefined);
});

// ── Push-type 'mcp_proposal' ────────────────────────────────────────────────
//
// Net als decision_digest moet dit type op vier plekken tegelijk bestaan: de
// twee CHECKs in de migratie, en PushEventType + PUSH_EVENTS in push-api.ts.
// Mist er één, dan faalt de insert in notification_outbox stil in een trigger
// (die is exception-wrapped, dus het voorstel komt wel aan — de melding niet).

const PUSH_MIGRATION = readFileSync(join(here, '..', '..', 'migrations', '20260917010000_mcp_proposal_push.sql'), 'utf8');
const PUSH_API = readFileSync(join(here, '..', '..', '..', 'src', 'lib', 'push-api.ts'), 'utf8');

/** De types die er al waren; de nieuwe migratie mag er geen laten vallen. */
const EARLIER_PUSH_TYPES = ['ticket_new', 'ticket_note_client', 'chat_message', 'client_email_inbound', 'booking_new', 'invoice_paid', 'decision_digest'];

test("push-type 'mcp_proposal' staat in beide CHECKs van de migratie", () => {
  const checks = PUSH_MIGRATION.match(/event_type in \([^)]*'mcp_proposal'[^)]*\)/g) ?? [];
  assert.equal(checks.length, 2, 'de migratie moet mcp_proposal in BEIDE CHECKs (outbox én preferences) zetten');
});

test('de nieuwe CHECKs laten geen bestaand push-type vallen', () => {
  // De migratie vervangt de constraint in zijn geheel. Vergeet hij een oud
  // type, dan weigert de database vanaf dat moment élke melding van dat type —
  // en niemand ziet dat, want de triggers slikken de fout in.
  for (const check of PUSH_MIGRATION.match(/event_type in \([^)]*\)/g) ?? []) {
    for (const type of EARLIER_PUSH_TYPES) {
      assert.ok(check.includes(`'${type}'`), `de nieuwe CHECK mist het bestaande push-type '${type}'`);
    }
  }
});

test("push-type 'mcp_proposal' staat in push-api.ts, op beide plekken", () => {
  assert.match(PUSH_API, /\|\s*'mcp_proposal'/, 'PushEventType mist mcp_proposal');
  assert.match(PUSH_API, /type: 'mcp_proposal'/, 'PUSH_EVENTS mist mcp_proposal (dan kan niemand hem uitzetten)');
});

test('de push-trigger kan het voorstel zelf nooit tegenhouden', () => {
  const start = PUSH_MIGRATION.indexOf('public.push_on_mcp_proposal()');
  const body = PUSH_MIGRATION.slice(start, PUSH_MIGRATION.indexOf('$$;', start));
  assert.match(body, /security definer/, 'de trigger moet security definer zijn om push_enqueue te mogen aanroepen');
  assert.match(body, /exception when others then/, 'de trigger is niet exception-wrapped: een fout in de melding zou het voorstel breken');
  assert.match(body, /new\.mcp_grant_id is null/, 'de trigger hoort voorstellen zonder koppeling (Gerrie zelf) over te slaan');
});
