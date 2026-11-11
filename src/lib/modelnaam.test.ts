import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Welk AI-model er achter Gerrie en de agents zit, laat de app nergens zien.
 *
 * Op de agentpagina stond "Model en kosten: Claude Sonnet 5.5 · grondig", en
 * in de editor "Beide standen draaien op Claude Sonnet 5.5". Ook na het
 * weghalen kwam zo'n naam makkelijk terug bij een nieuwe tekst. Deze test leest
 * alle broncode van de app en faalt op een modelnaam of een model-id.
 *
 * "Claude" alleen mag wel: bij de MCP-koppeling kiest de gebruiker zijn eigen
 * AI-app, en die heet soms zo.
 */

const MODEL_NAME = /\b(Sonnet|Haiku|Fable)\b|\bOpus \d|\bclaude-(sonnet|haiku|opus|fable)\b/;

function sourceFiles(dir: URL): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(tsx?|css|html)$/.test(path) && !path.endsWith('.test.ts'));
}

test('de app noemt nergens welk AI-model er draait', () => {
  const src = new URL('../', import.meta.url);
  const hits: string[] = [];
  for (const path of sourceFiles(src)) {
    readFileSync(new URL(path, src), 'utf8').split('\n').forEach((line, i) => {
      if (MODEL_NAME.test(line)) hits.push(`src/${path}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], 'haal de modelnaam weg; zeg "grondig" of "snel" als het om nadenken gaat');
});

test('de controle herkent een modelnaam echt', () => {
  assert.match('Claude Sonnet 5.5 · grondig', MODEL_NAME);
  assert.match('model: claude-sonnet-5-5', MODEL_NAME);
  assert.match('Claude Opus 5.5', MODEL_NAME);
  // Een audioformaat en de eigen AI-app van de gebruiker zijn geen modelnaam.
  assert.doesNotMatch("'audio/webm;codecs=opus'", MODEL_NAME);
  assert.doesNotMatch('Claude (web, desktop, telefoon)', MODEL_NAME);
});
