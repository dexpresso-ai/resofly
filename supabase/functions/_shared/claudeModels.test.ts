import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addUsage, anthropicHeaders, assistantContentForHistory, claudeModelSpec, DEFAULT_CLAUDE_MODEL, modelCostUsd,
  modelRequestFields, refusalText, SERVER_FALLBACK_BETA, usageFromResponse, type TokenUsage,
} from './claudeModels.ts';

/**
 * Het model achter Gerrie, de agents, de notulen en de factuurherkenning.
 *
 * Claude Sonnet 5.5 weigert een paar dingen die oudere modellen wel slikten
 * (een geforceerde tool_choice, thinking uitzetten) — met een 400, dus pas te
 * merken als iemand Gerrie iets vraagt. Deze tests houden de request-vorm per
 * model vast, en houden de oude vormen uit de code.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('het standaardmodel is Claude Sonnet 5.5, met zijn eigen prijzen', () => {
  assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-sonnet-5-5');
  const spec = claudeModelSpec(undefined);
  assert.equal(spec.id, 'claude-sonnet-5-5');
  assert.deepEqual([spec.input, spec.output, spec.cacheRead, spec.cacheWrite], [2, 10, 0.2, 2.5]);
  assert.equal(spec.forcedToolChoice, false, 'Sonnet 5.5 weigert tool_choice any/tool');
  assert.equal(spec.serverFallback, true);
  assert.equal(claudeModelSpec('   ').id, 'claude-sonnet-5-5');
});

test('een gedateerde naam hoort bij de langste bekende naam, een onbekende bij de veilige standaard', () => {
  assert.equal(claudeModelSpec('claude-haiku-4-5-20251001').adaptiveThinking, false);
  // 'claude-sonnet-5' is een voorvoegsel van 'claude-sonnet-5-5'; die twee mogen niet door elkaar.
  assert.equal(claudeModelSpec('claude-sonnet-5-5-20261001').forcedToolChoice, false);
  assert.equal(claudeModelSpec('claude-sonnet-5').forcedToolChoice, true);
  const unknown = claudeModelSpec('claude-iets-nieuws-9');
  assert.equal(unknown.id, 'claude-iets-nieuws-9');
  assert.equal(unknown.forcedToolChoice, false, 'onbekend: auto, dat werkt overal');
  assert.equal(unknown.serverFallback, false, 'onbekend: geen beta-parameter die het model misschien niet kent');
});

test('de request-vorm per model: thinking, effort en het vangnet', () => {
  const sonnet = claudeModelSpec('claude-sonnet-5-5');
  assert.deepEqual(modelRequestFields(sonnet, 'medium'), {
    model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, fallbacks: 'default',
  });
  assert.equal(anthropicHeaders('k', sonnet)['anthropic-beta'], SERVER_FALLBACK_BETA);
  assert.equal(SERVER_FALLBACK_BETA, 'server-side-fallback-2026-07-01', 'de "default"-vorm hoort bij precies deze header');

  const haiku = claudeModelSpec('claude-haiku-4-5');
  assert.deepEqual(modelRequestFields(haiku, 'low'), { model: 'claude-haiku-4-5' }, 'Haiku 4.5 kent geen adaptive thinking of effort');
  assert.equal(anthropicHeaders('k', haiku)['anthropic-beta'], undefined);
  // Nergens thinking uitzetten: dat is een 400 op Sonnet 5.5.
  for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6']) {
    const thinking = modelRequestFields(claudeModelSpec(id), 'low').thinking as { type?: string } | undefined;
    assert.notEqual(thinking?.type, 'disabled');
  }
});

test('na een fallback halverwege: alleen de tekst van vóór de grens mag mee terug', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'a' },
    { type: 'text', text: 'Ik zoek het op. ' },
    { type: 'tool_use', id: 'toolu_1', name: 'list_invoices', input: {} },
    { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
    { type: 'text', text: 'Verder.' },
    { type: 'tool_use', id: 'toolu_2', name: 'list_quotes', input: {} },
  ];
  assert.deepEqual(assistantContentForHistory(content).map((b) => b.type), ['text', 'text', 'tool_use']);
  assert.equal(assistantContentForHistory(content).find((b) => b.type === 'tool_use')?.id, 'toolu_2');
  // Zonder fallback-blok: ongewijzigd terug, thinking-blokken incluis.
  const plain = [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Klaar.' }];
  assert.equal(assistantContentForHistory(plain), plain);
});

test('verbruik: top-level, of per poging als er een fallback was', () => {
  assert.deepEqual(usageFromResponse({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }),
    { input: 100, output: 20, cacheRead: 900, cacheWrite: 50 });
  assert.deepEqual(usageFromResponse({
    input_tokens: 120, output_tokens: 30,
    iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 5 },
      { type: 'fallback_message', input_tokens: 120, output_tokens: 30 },
    ],
  }), { input: 220, output: 35, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(usageFromResponse(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('kosten in dollars, op vier decimalen', () => {
  const spec = claudeModelSpec('claude-sonnet-5-5');
  assert.equal(modelCostUsd(spec, { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 }), 3.2);
  assert.equal(modelCostUsd(spec, { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0 }), 0.0081);
});

test('na een fallback rekent elke poging tegen het tarief van het model dat hem deed', () => {
  const sonnet = claudeModelSpec('claude-sonnet-5-5');
  // Sonnet 5.5 weigerde ($ 2 per miljoen invoertokens), Opus 5.5 nam over ($ 4).
  const fellBack = usageFromResponse({
    input_tokens: 1_000_000, output_tokens: 0,
    iterations: [
      { type: 'message', input_tokens: 1_000_000, output_tokens: 0 },
      { type: 'fallback_message', input_tokens: 1_000_000, output_tokens: 0 },
    ],
  }, sonnet, 'claude-opus-5-5');
  assert.equal(modelCostUsd(sonnet, fellBack), 6);
  // Zonder fallback gewoon het tarief van het gevraagde model.
  assert.equal(modelCostUsd(sonnet, usageFromResponse({ input_tokens: 1_000_000 }, sonnet, 'claude-sonnet-5-5')), 2);

  // Optellen over beurten heen houdt de prijs per poging vast; een beurt zonder
  // prijs rekent tegen het gevraagde model.
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  addUsage(total, fellBack, sonnet);
  addUsage(total, usageFromResponse({ input_tokens: 1_000_000 }), sonnet);
  assert.equal(total.input, 3_000_000);
  assert.equal(modelCostUsd(sonnet, total), 8);
});

test('een weigering wordt een gewone zin', () => {
  assert.match(refusalText('cyber'), /veiligheidsfilter/);
  assert.match(refusalText('reasoning_extraction'), /interne redenering/);
  assert.match(refusalText(null), /Formuleer het anders/);
});

test('geen geforceerde tool_choice meer in de code die Sonnet 5.5 aanspreekt', () => {
  const core = read('./gerrieCore.ts');
  assert.doesNotMatch(core, /tool_choice: \{ type: 'any' \}/, 'any geeft een 400 op Sonnet 5.5');
  assert.doesNotMatch(core, /tool_choice: \{ type: 'tool'/, 'tool geeft een 400 op Sonnet 5.5');
  // De factuurherkenning mag het alleen nog op een model dat het accepteert.
  const invoice = read('./claudeInvoice.ts');
  assert.match(invoice, /spec\.forcedToolChoice\s*\?\s*\{ type: 'tool', name: TOOL_NAME \}/);
  // Alle drie lezen het model uit het register in plaats van een eigen standaard.
  for (const file of ['./gerrieCore.ts', './claudeSummary.ts', './claudeInvoice.ts']) {
    assert.doesNotMatch(read(file), /'claude-sonnet-4-6'/, `${file} noemt nog een eigen standaardmodel`);
    assert.match(read(file), /from '\.\/claudeModels\.ts'|from '\.\.\/_shared\/claudeModels\.ts'/, `${file} gebruikt het register niet`);
  }
});
