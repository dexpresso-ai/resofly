/**
 * Tests voor de gewone taal in het logboek van Gerrie. Draaien met:  npm test
 *
 * Een gebruiker hoort in het logboek "alleen te laat" te lezen, niet
 * "overdue_only: true", en nooit een id of de technische naam van een tool.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionStatusLabel, fallbackToolLabel, stepInputSummary } from './agentLogText.ts';

/** Technische namen: `snake_case` of `iets.anders`. */
const TECHNICAL = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z][a-z_]{2,}\.[a-z][a-z_]{2,}\b/;
const ID = '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b';

test('een onbekende tool krijgt een label zonder technische naam', () => {
  assert.equal(fallbackToolLabel('action:inbox.list'), 'Overige handeling');
  assert.equal(fallbackToolLabel('propose_send_reminders'), 'Iets klaarzetten');
  assert.equal(fallbackToolLabel('list_whatever'), 'Gegevens bekijken');
});

test('de afloop van een voorstel staat er in gewone taal, ook bij een onbekende status', () => {
  assert.equal(decisionStatusLabel('executed'), 'uitgevoerd');
  assert.equal(decisionStatusLabel('auto_executed'), 'uitgevoerd');
  assert.equal(decisionStatusLabel('proposed'), 'wacht op akkoord');
  assert.equal(decisionStatusLabel('confirmed'), 'goedgekeurd');
  assert.equal(decisionStatusLabel('iets_nieuws'), 'in behandeling');
});

test('filters worden vertaald en id\'s vallen weg', () => {
  assert.deepEqual(
    stepInputSummary({ client_id: ID, status: 'overdue', overdue_only: true, limit: 50 }),
    ['status: te laat', 'alleen te laat'],
  );
  assert.deepEqual(
    stepInputSummary({ query: 'jansen', date_preset: 'this_month' }),
    ['zoekterm "jansen"', 'periode: deze maand'],
  );
});

test('een handeling uit de registry staat er bij zijn label, of helemaal niet', () => {
  const input = { action_id: 'inbox.list', input: '…' };
  assert.deepEqual(stepInputSummary(input, () => 'Opvangbak bekijken'), ['Opvangbak bekijken']);
  assert.deepEqual(stepInputSummary(input), []);
  assert.deepEqual(stepInputSummary(input, () => null), []);
});

test('een waarde die er technisch uitziet, wordt niet getoond', () => {
  assert.deepEqual(stepInputSummary({ status: 'some_internal_code' }), []);
  assert.deepEqual(stepInputSummary({ name: ID }), []);
});

test('regels en lijsten worden geteld, ook als het logboek ze al inkortte', () => {
  assert.deepEqual(stepInputSummary({ lines: ['…', '…'] }), ['2 regels']);
  assert.deepEqual(stepInputSummary({ lines: '15 stuks' }), ['15 regels']);
  assert.deepEqual(stepInputSummary({ items: ['…'] }), ['1 stuk']);
});

test('hoogstens drie delen, en nooit een technische naam', () => {
  const parts = stepInputSummary({
    project_id: ID, status: 'doing', planned_only: true, include_archived: true, due_date: '2026-10-17',
    action_id: 'task.quick_plan', unknown_field: 'x', min_amount_eur: 100,
  });
  assert.equal(parts.length, 3);
  for (const part of parts) assert.doesNotMatch(part, TECHNICAL, `"${part}" bevat een technische naam`);
});
