/**
 * Subtaken in het taakvenster: typen en opslaan.
 * Draaien met:  npm test
 *
 * Het taakvenster zette elke subtaak bij elke toetsaanslag opnieuw in vorm, en
 * haalde daarbij de spaties eraf. Een spatie aan het eind verdween dus meteen,
 * en een subtaak van twee woorden was niet te typen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Subtask } from '../types.ts';
import { normalizeSubtasks, subtasksForSave } from './subtasks.ts';

/** Doet na wat het taakvenster doet: per toetsaanslag de hele lijst opnieuw in vorm. */
function typeInto(subtasks: Subtask[], id: string, text: string): Subtask[] {
  let current = subtasks;
  for (const key of text) {
    const shown = normalizeSubtasks(current);
    const label = shown.find(s => s.id === id)!.label;
    // Het invoerveld zet de toets achter wat er nu in het veld staat.
    current = shown.map(s => s.id === id ? { ...s, label: label + key } : s);
  }
  return normalizeSubtasks(current);
}

test('je kunt een subtaak van meer woorden typen, met spaties ertussen', () => {
  const start: Subtask[] = [{ id: 's1', label: '', done: false }];
  const typed = typeInto(start, 's1', 'feedback verwerken');
  assert.equal(typed[0].label, 'feedback verwerken');
});

test('een spatie aan het eind blijft staan zolang je typt', () => {
  const shown = normalizeSubtasks([{ id: 's1', label: 'feedback ', done: false }]);
  assert.equal(shown[0].label, 'feedback ');
});

test('bij het opslaan gaan de spaties voor en achter eraf, die ertussen blijven', () => {
  const saved = subtasksForSave([
    { id: 's1', label: '  feedback  verwerken ', done: true },
    { id: 's2', label: '   ', done: false },
    { id: 's3', label: '', done: false },
  ]);
  assert.deepEqual(saved, [{ id: 's1', label: 'feedback  verwerken', done: true }]);
});

test('rommel uit de database wordt een nette lijst', () => {
  assert.deepEqual(normalizeSubtasks(null), []);
  const shown = normalizeSubtasks([{ label: 'zonder id' }, undefined]);
  assert.equal(shown.length, 2);
  assert.ok(shown[0].id.length > 0, 'een subtaak zonder id krijgt er een');
  assert.equal(shown[0].label, 'zonder id');
  assert.equal(shown[0].done, false);
  assert.equal(shown[1].label, '');
});
