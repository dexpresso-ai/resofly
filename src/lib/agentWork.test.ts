import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLiveRun, lastTool, latestRunByAgent, liveRunByAgent, liveSteps, runOutcome, STALE_RUN_MS, whenShort, workPhase } from './agentWork.ts';

// Een agent aan het werk: welke runs lopen nu, in welke stap zitten ze, en wat
// leverde de laatste run op. Wat hier fout gaat, zie je in de app als een agent
// die eeuwig "bezig" is, of een stappenbalk die terugspringt.

const NOW = Date.parse('2026-11-11T10:00:00Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

test('een run loopt alleen als hij op running staat en niet gestrand is', () => {
  assert.equal(isLiveRun({ status: 'running', started_at: ago(40), created_at: ago(40) }, NOW), true);
  assert.equal(isLiveRun({ status: 'claimed', started_at: null, created_at: ago(5) }, NOW), true);
  assert.equal(isLiveRun({ status: 'succeeded', started_at: ago(40), created_at: ago(40) }, NOW), false);
  // Een run die een kwartier "loopt", is gestrand: die tonen we niet als bezig.
  assert.equal(isLiveRun({ status: 'running', started_at: new Date(NOW - STALE_RUN_MS - 1000).toISOString(), created_at: ago(2000) }, NOW), false);
  assert.equal(isLiveRun({ status: 'running', started_at: 'onzin', created_at: 'onzin' }, NOW), false);
});

test('per agent de nieuwste run, en de run die nu loopt', () => {
  const runs = [
    { id: 'r1', agent_id: 'a', status: 'succeeded' as const, started_at: ago(7200), created_at: ago(7200) },
    { id: 'r2', agent_id: 'a', status: 'running' as const, started_at: ago(30), created_at: ago(30) },
    { id: 'r3', agent_id: 'b', status: 'failed' as const, started_at: ago(600), created_at: ago(600) },
  ];
  const latest = latestRunByAgent(runs);
  assert.equal(latest.a.id, 'r2');
  assert.equal(latest.b.id, 'r3');
  const live = liveRunByAgent(runs, NOW);
  assert.deepEqual(Object.keys(live), ['a']);
  assert.equal(live.a.id, 'r2');
});

test('de stap volgt het logboek en springt niet terug', () => {
  assert.equal(workPhase([]), 0);
  assert.equal(workPhase([{ kind: 'start' }]), 0);
  assert.equal(workPhase([{ kind: 'start' }, { kind: 'tool' }]), 1);
  assert.equal(workPhase([{ kind: 'start' }, { kind: 'tool' }, { kind: 'proposal' }]), 2);
  // Nog een tool na een voorstel: hij is aan het uitwerken, niet terug bij af.
  assert.equal(workPhase([{ kind: 'start' }, { kind: 'proposal' }, { kind: 'tool' }]), 2);
  assert.equal(workPhase([{ kind: 'start' }, { kind: 'tool' }, { kind: 'error' }]), 1);
  assert.equal(workPhase([{ kind: 'start' }, { kind: 'tool' }, { kind: 'answer' }, { kind: 'delivery' }]), 3);
});

test('de live stappen staan op volgorde, en het antwoord is één regel', () => {
  const steps = liveSteps([
    { seq: 2, kind: 'answer', label: 'Zijn antwoord', detail: { text: 'Een hele lap tekst' }, created_at: ago(5) },
    { seq: 0, kind: 'start', label: 'Handmatig gestart', detail: {}, created_at: ago(30) },
    { seq: 1, kind: 'tool', label: 'Facturen bekijken — 12 gevonden', detail: { tool: 'list_invoices', ok: true }, created_at: ago(20) },
    { seq: 3, kind: 'error', label: 'Klanten zoeken mislukte', detail: {}, created_at: ago(2) },
  ]);
  assert.deepEqual(steps.map((s) => s.label), ['Handmatig gestart', 'Facturen bekijken — 12 gevonden', 'Zijn antwoord geschreven', 'Klanten zoeken mislukte']);
  assert.deepEqual(steps.map((s) => s.ok), [true, true, true, false]);
});

test('de laatst gebruikte tool licht op', () => {
  assert.equal(lastTool([]), null);
  assert.equal(lastTool([
    { seq: 1, kind: 'tool', detail: { tool: 'list_invoices' } },
    { seq: 2, kind: 'tool', detail: { tool: 'search_clients' } },
    { seq: 3, kind: 'answer', detail: {} },
  ]), 'search_clients');
});

test('de uitkomst van een run in één regel', () => {
  assert.deepEqual(runOutcome(null), { text: 'Nog niet gedraaid', tone: 'none' });
  assert.equal(runOutcome({ status: 'failed', summary: null, error: 'Claude was even niet bereikbaar.', proposals_created: 0, result: null }).tone, 'bad');
  assert.deepEqual(runOutcome({ status: 'succeeded', summary: 'Niets.', error: null, proposals_created: 0, result: { quiet: true } }), { text: 'Niets te melden', tone: 'quiet' });
  assert.equal(runOutcome({ status: 'succeeded', summary: 'Vier facturen  staan open.', error: null, proposals_created: 2, result: {} }).text, '2 voorstellen klaargezet · Vier facturen staan open.');
  assert.equal(runOutcome({ status: 'skipped_budget', summary: null, error: null, proposals_created: 0, result: null }).tone, 'warn');
});

test('wanneer, kort', () => {
  const now = new Date('2026-11-11T10:00:00Z');
  assert.equal(whenShort('2026-11-11T07:00:00Z', now), 'vandaag 08:00');
  assert.equal(whenShort('2026-11-10T13:30:00Z', now), 'gisteren 14:30');
  assert.match(whenShort('2026-11-03T08:00:00Z', now), /3 nov/);
  assert.equal(whenShort(null, now), '');
});
