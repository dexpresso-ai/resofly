import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { agentForEditing } from './agentEditing.ts';

// Een agent aanpassen via de chat (2026-11-11): de app stuurt de huidige
// instellingen mee. Wat er bij de bouwer aankomt, is alleen wat hij nodig heeft,
// begrensd; en de runner schrijft elke stap van een agent meteen in het logboek,
// zodat de app live kan laten zien wat hij doet.

test('alleen de velden die de bouwer nodig heeft, begrensd', () => {
  const out = agentForEditing({
    id: 'a1', run_as_user_id: 'u1', status: 'active', organization_id: 'o1', created_by: 'u1',
    name: 'Te late facturen', instruction: 'x'.repeat(5000), mode: 'report',
    enabled_tools: ['list_invoices', 42, 'search_clients'], schedule_kind: 'weekly', day_of_week: 1, hour: 8.7, minute: 0,
    trigger_events: [], max_proposals_per_run: 3, email_mode: 'compose', email_subject: null, icon: 'receipt',
  });
  assert.ok(out);
  // Eigenaar, status en organisatie gaan niet mee het gesprek in.
  for (const key of ['id', 'run_as_user_id', 'status', 'organization_id', 'created_by']) assert.equal(key in out, false, key);
  assert.equal(out.name, 'Te late facturen');
  assert.equal((out.instruction as string).length, 4000);
  assert.deepEqual(out.enabled_tools, ['list_invoices', 'search_clients']);
  assert.equal(out.hour, 8);
  // Een lege waarde verdwijnt in plaats van als null mee te gaan.
  assert.equal('email_subject' in out, false);
});

test('onzin wordt geen agent', () => {
  assert.equal(agentForEditing(null), null);
  assert.equal(agentForEditing('agent'), null);
  assert.equal(agentForEditing([{ name: 'x' }]), null);
  assert.equal(agentForEditing({ mode: 'report' }), null, 'zonder naam en opdracht valt er niets aan te passen');
  const odd = agentForEditing({ name: 'A', schedule_kind: 'elke-seconde', mode: 'alles', email_mode: 'spam' });
  assert.deepEqual(odd, { name: 'A' });
});

test('de bouwer krijgt de huidige agent als gegevens, niet als opdracht', () => {
  const core = readFileSync(new URL('./gerrieCore.ts', import.meta.url), 'utf8');
  assert.match(core, /JE PAST NU EEN BESTAANDE AGENT AAN/);
  assert.match(core, /wrapToolData\('huidige_agent', current\)/);
  const fn = readFileSync(new URL('../gerrie-agent/index.ts', import.meta.url), 'utf8');
  assert.match(fn, /designAgent\(ctx, user\.id, messages, agentForEditing\(body\.current\)\)/);
});

test('de runner schrijft elke stap meteen weg, bij een run en bij een antwoord', () => {
  const runner = readFileSync(new URL('../gerrie-agent-runner/index.ts', import.meta.url), 'utf8');
  assert.equal((runner.match(/onStep: \(step\) => log\.live\(step\),/g) ?? []).length, 2);
  // Niet daarnaast nog eens na afloop: dan stond elke stap dubbel in het logboek.
  assert.doesNotMatch(runner, /for \(const step of outcome\.steps\) log\.addStep\(step\)/);
  // De laatste flush wacht op alles wat er tijdens de run al onderweg was.
  assert.match(runner, /chain = chain\.then\(\(\) => write\(batch\)\);/);
  const core = readFileSync(new URL('./gerrieCore.ts', import.meta.url), 'utf8');
  // Elke stap in runAgent gaat via record(), anders mist het live logboek er een.
  const body = core.slice(core.indexOf('async function runAgent('), core.indexOf('// Afronden — loop-plafond'));
  assert.doesNotMatch(body, /steps\.push\(logStep\(/);
  assert.ok((body.match(/record\(logStep\(/g) ?? []).length >= 6);
});
