import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Bewaakt de belofte "wat de app kan, kan een agent ook" voor de HANDELINGENREGISTRY.
 *
 * De registry heeft twee helften die los van elkaar te bewerken zijn:
 *   server — supabase/functions/_shared/actions/*.ts  (wat er kan, en de controle)
 *   client — src/lib/actions/*.ts                     (hoe het wordt uitgevoerd)
 *
 * Een handeling zonder uitvoerder ziet er in de chat volkomen normaal uit: Gerrie zet
 * hem keurig klaar, de gebruiker geeft akkoord, en dan pas blijkt dat er niets kan
 * gebeuren. Een uitvoerder zonder handeling is dode code die niemand meer opmerkt.
 * Allebei zijn het stille fouten — precies wat een test hoort te vangen.
 *
 * Net als toolCatalog.test.ts lezen we de bestanden als TEKST. Dat is bewust: de
 * serverkant leunt op Deno-imports en is niet in node te laden. Grof, maar het vangt
 * exact de fout die we willen voorkomen.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, 'actions');
const clientDir = join(here, '..', '..', '..', 'src', 'lib', 'actions');

function readAll(dir: string, skip: string[]): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !skip.includes(f))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/** De id's zoals ze in de serverregistry staan: `id: 'client.update_details',`. */
function serverActionIds(): string[] {
  const source = readAll(serverDir, ['types.ts', 'index.ts', 'registry.ts']);
  return [...source.matchAll(/^\s{4}id: '([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)',$/gm)].map((m) => m[1]);
}

/** De sleutels in de uitvoerdertabellen: `'client.update_details': async (…)`. */
function clientExecutorIds(): string[] {
  const source = readAll(clientDir, ['types.ts', 'index.ts', 'registry.ts']);
  return [...source.matchAll(/^\s{2}'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)':/gm)].map((m) => m[1]);
}

/** Alleen schrijf-handelingen hebben een uitvoerder nodig; lezen gebeurt op de server. */
function serverWriteActionIds(): string[] {
  const source = readAll(serverDir, ['types.ts', 'index.ts', 'registry.ts']);
  const ids: string[] = [];
  // Per blok tussen twee `id:`-regels kijken of er `kind: 'write'` in staat.
  const blocks = source.split(/^\s{4}id: '/m).slice(1);
  for (const block of blocks) {
    const id = block.slice(0, block.indexOf("'"));
    if (/^\s{4}kind: 'write',$/m.test(block.split(/^\s{4}id: '/m)[0])) ids.push(id);
  }
  return ids;
}

test('elke handeling in de registry heeft een geldig id', () => {
  const ids = serverActionIds();
  assert.ok(ids.length > 0, 'de registry is leeg — dat kan niet kloppen');
  const seen = new Set<string>();
  const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual([...new Set(dupes)], [], 'dubbele id\'s in de registry; de tweede overschrijft de eerste stil');
});

test('elke SCHRIJF-handeling heeft een uitvoerder in de browser', () => {
  const executors = new Set(clientExecutorIds());
  const missing = serverWriteActionIds().filter((id) => !executors.has(id));
  assert.deepEqual(
    missing, [],
    `deze handelingen zet Gerrie wél klaar maar kan de app niet uitvoeren: ${missing.join(', ')}. ` +
    'Voeg een uitvoerder toe in src/lib/actions/.',
  );
});

test('elke uitvoerder hoort bij een bestaande handeling', () => {
  const ids = new Set(serverActionIds());
  const stale = clientExecutorIds().filter((id) => !ids.has(id));
  assert.deepEqual(
    stale, [],
    `deze uitvoerders horen bij een handeling die niet meer bestaat: ${stale.join(', ')}`,
  );
});

test('elke handeling hangt aan een module, zodat modulerechten hem kunnen afschermen', () => {
  const source = readAll(serverDir, ['types.ts', 'index.ts', 'registry.ts']);
  const known = ['clients', 'projects', 'time', 'calendar', 'tickets', 'content', 'stats', 'marketing', 'finance', 'chat', 'gerrie'];
  const blocks = source.split(/^\s{4}id: '/m).slice(1);
  const bad: string[] = [];
  for (const block of blocks) {
    const id = block.slice(0, block.indexOf("'"));
    const head = block.split(/^\s{4}id: '/m)[0];
    const module = head.match(/^\s{4}module: '([a-z]+)',$/m)?.[1];
    if (!module || !known.includes(module)) bad.push(`${id} (${module ?? 'geen module'})`);
  }
  assert.deepEqual(bad, [], `deze handelingen hebben geen bekende module: ${bad.join(', ')}`);
});
