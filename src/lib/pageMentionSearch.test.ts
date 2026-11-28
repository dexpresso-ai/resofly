import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedMentionCandidates, mentionCandidates, mentionMembers, searchMentions, type MentionSources } from './pageMentionSearch.ts';

// Stap 2-1b: de @-kiezer zoekt in wat de app geladen heeft. Wat de database je
// niet geeft (regel 3), staat er dus ook niet in; dat test de database zelf.

const sources: MentionSources = {
  clients: [{ id: 'k1', name: 'Bakkerij Jansen' }, { id: 'k2', name: 'Café De Kroon' }, { id: 'k3', name: '  ' }],
  projects: [
    { id: 'p1', name: 'Verbouwing', client_id: 'k1' },
    { id: 'p2', name: 'Oud project', client_id: 'k1', archived: true },
    { id: 'p3', name: 'Website', client_id: null },
  ],
  tasks: [
    { id: 't1', title: 'Offerte Jansen nakijken', project_id: 'p1', status: 'todo' },
    { id: 't2', title: 'Afgerond', project_id: 'p1', status: 'done' },
  ],
  invoices: [{ id: 'f1', number: 'F-2026-014', client_id: 'k2' }],
  members: [{ id: 'u1', name: 'sanne', email: 'sanne@studio.test' }],
};

test('de kandidaten: elke soort, met waar het bij hoort; geen archief, niets afgerond, niets zonder naam', () => {
  assert.deepEqual(mentionCandidates(sources).map(c => `${c.kind}:${c.label}:${c.hint}`), [
    'client:Bakkerij Jansen:Klant',
    'client:Café De Kroon:Klant',
    'project:Verbouwing:Project · Bakkerij Jansen',
    'project:Website:Project',
    'task:Offerte Jansen nakijken:Taak · Verbouwing',
    'invoice:F-2026-014:Factuur · Café De Kroon',
    'member:sanne:Collega · sanne@studio.test',
  ]);
});

test('zoeken: de naam begint ermee, dan een woord, dan ergens in de naam, dan waar het bij hoort', () => {
  const candidates = mentionCandidates(sources);
  const labels = (query: string) => searchMentions(query, candidates).map(c => c.label);
  // "bak": de klant zelf, en daarna zijn project (via de klant in de hint).
  assert.deepEqual(labels('bak'), ['Bakkerij Jansen', 'Verbouwing']);
  // "jan": het tweede woord van de klant, een woord in de taak, en het project van die klant.
  assert.deepEqual(labels('jan'), ['Bakkerij Jansen', 'Offerte Jansen nakijken', 'Verbouwing']);
  // Accenten en hoofdletters maken niet uit; de factuur van die klant komt erachter.
  assert.deepEqual(labels('CAFE'), ['Café De Kroon', 'F-2026-014']);
  // Een nummer, ook het stuk na het streepje.
  assert.deepEqual(labels('014'), ['F-2026-014']);
  // Ergens in de naam, na de woorden.
  assert.deepEqual(labels('ouw'), ['Verbouwing']);
  // De klant van een project telt als laatste: "kroon" vindt de klant en zijn factuur.
  assert.deepEqual(labels('kroon'), ['Café De Kroon', 'F-2026-014']);
  assert.deepEqual(labels('xyz'), []);
  // Niets getypt: de eerste in de vaste volgorde, hoogstens het maximum.
  assert.equal(searchMentions('', candidates, 3).length, 3);
  assert.equal(searchMentions('', candidates)[0].label, 'Bakkerij Jansen');
});

test('dezelfde lijsten: dezelfde kandidaten, zonder opnieuw te bouwen', () => {
  const first = cachedMentionCandidates(sources);
  assert.equal(cachedMentionCandidates({ ...sources }), first);
  const changed = cachedMentionCandidates({ ...sources, clients: [{ id: 'k9', name: 'Nieuw' }] });
  assert.notEqual(changed, first);
  assert.equal(changed[0].label, 'Nieuw');
});

test('collega\'s voor de kiezer: alleen actief, met het adres zonder domein, en dezelfde lijst voor dezelfde invoer', () => {
  const members = [
    { user_id: 'u1', email: 'sanne@studio.test', status: 'active' },
    { user_id: 'u2', email: 'oud@studio.test', status: 'removed' },
    { user_id: 'u3', email: null, status: 'active' },
  ];
  assert.deepEqual(mentionMembers(members), [{ id: 'u1', name: 'sanne', email: 'sanne@studio.test' }]);
  assert.equal(mentionMembers(members), mentionMembers(members));
});
