import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Bewaakt de belofte "wat Gerrie kan, kan een agent ook".
 *
 * De agent-bouwer liet ooit een handgeschreven lijstje tools zien. Dat liep achter:
 * twaalf dingen die Gerrie in de chat allang kon (klant aanmaken, project, taak,
 * rapportage) waren aan een agent simpelweg niet te geven, omdat ze in dat lijstje
 * ontbraken — zonder dat iets faalde. De lijst komt nu uit `toolCatalog()`, maar die
 * leunt op `TOOL_LABELS`, en een vergeten label is precies dezelfde stille drift:
 * de tool verschijnt dan met zijn technische naam ertussen.
 *
 * Deze test leest gerrieCore.ts als TEKST. Dat is bewust: het bestand leest bij
 * import Deno-omgevingsvariabelen uit en is daarom niet in node te laden. Een
 * tekstcontrole is grof, maar vangt exact de fout die we willen voorkomen.
 */

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'gerrieCore.ts'),
  'utf8',
);

/** Tools die geen agent-capability zijn maar een gestuurde uitvoer-tool. */
const META_TOOLS = new Set(['ask_user', 'emit_agent', 'emit_plan']);

function section(startMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `kon "${startMarker}" niet vinden in gerrieCore.ts`);
  // Tot de eerstvolgende regel die op kolom 0 met "];" of "};" eindigt.
  const end = source.slice(start).search(/\n[}\]];/);
  assert.ok(end > 0, `kon het einde van "${startMarker}" niet vinden`);
  return source.slice(start, start + end);
}

function toolDefinitionNames(): string[] {
  const block = section('const TOOL_DEFINITIONS');
  return [...block.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
}

function labelledNames(): string[] {
  const block = section('const TOOL_LABELS');
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

function moduleMappedNames(): string[] {
  const block = section('const TOOL_MODULE');
  return [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
}

test('elke tool die Gerrie heeft, is ook aan een agent te geven', () => {
  const tools = toolDefinitionNames().filter((n) => !META_TOOLS.has(n));
  assert.ok(tools.length > 20, `verwacht een gevulde toolset, kreeg er ${tools.length}`);

  const labels = new Set(labelledNames());
  const missing = tools.filter((n) => !labels.has(n));
  assert.deepEqual(
    missing, [],
    `deze tools hebben geen label in TOOL_LABELS en verschijnen dus met hun technische naam in de agent-bouwer: ${missing.join(', ')}`,
  );
});

test('TOOL_LABELS bevat geen labels voor tools die niet meer bestaan', () => {
  const tools = new Set(toolDefinitionNames());
  const stale = labelledNames().filter((n) => !tools.has(n));
  assert.deepEqual(stale, [], `deze labels horen bij verdwenen tools: ${stale.join(', ')}`);
});

test('elke schrijf-tool zit aan een module vast, zodat modulerechten hem kunnen afschermen', () => {
  const mapped = new Set(moduleMappedNames());
  const unmapped = toolDefinitionNames()
    .filter((n) => n.startsWith('propose_'))
    .filter((n) => !mapped.has(n));
  assert.deepEqual(
    unmapped, [],
    `deze propose-tools staan niet in TOOL_MODULE en ontsnappen dus aan de modulerechten: ${unmapped.join(', ')}`,
  );
});
