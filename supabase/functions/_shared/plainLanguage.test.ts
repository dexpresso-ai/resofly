import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ACTIONS } from './actions/index.ts';
import { PLAIN_LANGUAGE_RULES, technicalNames } from './plainLanguage.ts';

/**
 * Bewaakt de afspraak "een gebruiker ziet geen technische namen".
 *
 * Gerrie en een gekoppelde AI werken met namen als `propose_invoice` en
 * `inbox.list`; die horen in een aanroep, niet in een antwoord of op een scherm.
 * gerrieCore.ts en mcp/index.ts worden als TEKST gelezen, net als in
 * toolCatalog.test.ts: ze lezen bij import Deno-omgevingsvariabelen uit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const core = readFileSync(join(here, 'gerrieCore.ts'), 'utf8');
const mcp = readFileSync(join(here, '..', 'mcp', 'index.ts'), 'utf8');

/** Van `start` tot de eerste regel die op kolom 0 een blok of functie sluit. */
function block(source: string, start: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `kon "${start}" niet vinden`);
  const end = source.slice(from).search(/\n[}\]];?\n/);
  assert.ok(end > 0, `kon het einde van "${start}" niet vinden`);
  return source.slice(from, from + end);
}

test('de detector vindt technische namen en laat gewone taal met rust', () => {
  assert.deepEqual(technicalNames('ik heb propose_invoice gebruikt voor client_id 12'), ['propose_invoice', 'client_id']);
  assert.deepEqual(technicalNames('zie inbox.list en invoice.set_status'), ['inbox.list', 'invoice.set_status']);
  for (const plain of [
    'Factuurstatus wijzigen (o.a. betaald melden)',
    'E-mailtekst van een offerte-, factuur- of herinneringsmail aanpassen',
    'Ik heb een conceptfactuur voor Jansen klaargezet. Keur hem goed in ResoFly.',
  ]) {
    assert.deepEqual(technicalNames(plain), [], `"${plain}" is gewone taal`);
  }
});

test('Gerrie krijgt de taalregels in zijn systeemprompt', () => {
  // Elke route van Gerrie (chat, geplande agent, missie, agent-bouwer) bouwt op
  // buildSystemPrompt, dus hier hoort het één keer te staan.
  assert.match(block(core, 'function buildSystemPrompt('), /\.\.\.PLAIN_LANGUAGE_RULES/);
});

test('een gekoppelde AI krijgt dezelfde taalregels in de serverinstructies', () => {
  assert.match(block(mcp, 'function initialize('), /\.\.\.PLAIN_LANGUAGE_RULES/);
});

test('de taalregels noemen wat er niet in een antwoord hoort', () => {
  const rules = PLAIN_LANGUAGE_RULES.join('\n');
  for (const part of ['technische naam', 'veldnamen', 'statuscodes', "interne id's", 'foutmelding']) {
    assert.ok(rules.includes(part), `de taalregels zeggen niets over ${part}`);
  }
});

test('elke MCP-tool heeft een titel in gewone taal', () => {
  // De titel is wat een AI-app de gebruiker laat zien in plaats van de naam.
  const tools = block(mcp, 'const TOOLS = [');
  const names = [...tools.matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
  const titles = new Map([...tools.matchAll(/^\s{4}name: '([a-z_]+)',\n\s{4}title: '([^']+)',$/gm)].map((m) => [m[1], m[2]]));
  assert.ok(names.length >= 5, `verwacht de MCP-tools, kreeg er ${names.length}`);
  for (const name of names) {
    const title = titles.get(name);
    assert.ok(title, `${name} heeft geen title direct onder zijn naam`);
    assert.deepEqual(technicalNames(title!), [], `de titel van ${name} bevat een technische naam`);
  }
});

test('labels die een gebruiker ziet, bevatten geen technische namen', () => {
  // Registry-labels staan op goedkeurkaarten, in de agent-bouwer en in wat een
  // gekoppelde AI terugkrijgt; de kerntool-labels op de agentkaart en in het logboek.
  const leaks: string[] = [];
  for (const action of ACTIONS) {
    const found = technicalNames(action.label);
    if (found.length) leaks.push(`${action.id}: "${action.label}" (${found.join(', ')})`);
  }
  const labels = block(core, 'const TOOL_LABELS');
  for (const m of labels.matchAll(/^\s{2}([a-z_]+): (['"])(.+)\2,$/gm)) {
    const found = technicalNames(m[3]);
    if (found.length) leaks.push(`${m[1]}: "${m[3]}" (${found.join(', ')})`);
  }
  assert.deepEqual(leaks, [], `deze labels tonen een technische naam:\n  ${leaks.join('\n  ')}`);
});
