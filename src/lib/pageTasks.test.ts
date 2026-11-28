import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageTaskLinks, TASK_TITLE_MAX, taskTitleFromItem } from './pageTasks.ts';

// Stap 2-2a: een regel in een takenlijst wordt een taak. Welke taken je
// krijgt, bepaalt de database (de RLS op tasks); dat test
// tests/database/paginas_taken.sql.

const KLANT = '11111111-1111-4111-8111-111111111111';
const TAAK = '22222222-2222-4222-8222-222222222222';

test('de taken van een pagina, per regel; andere pagina\'s en taken zonder regel tellen niet', () => {
  const links = pageTaskLinks([
    { id: 't1', title: 'Offerte sturen', status: 'todo', page_id: 'p1', page_block_id: 'r1' },
    { id: 't2', title: 'Elders', status: 'done', page_id: 'p2', page_block_id: 'r2' },
    { id: 't3', title: 'Uit de pagina', status: 'doing', page_id: 'p1', page_block_id: null },
    { id: 't4', title: 'Gewoon', status: 'todo' },
  ], 'p1');
  assert.deepEqual([...links.entries()], [['r1', { id: 't1', title: 'Offerte sturen', status: 'todo' }]]);
});

test('de titel: de tekst van de regel, met de naam die je ziet, zonder wat eronder hangt', () => {
  const item = {
    type: 'taskItem', attrs: { checked: false, id: 'r1' },
    content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'Bel  ' }, { type: 'mention', attrs: { kind: 'client', id: KLANT } },
        { type: 'hardBreak' }, { type: 'text', text: 'over de ', marks: [{ type: 'bold' }] }, { type: 'mention', attrs: { kind: 'task', id: TAAK } },
      ] },
      { type: 'taskList', content: [{ type: 'taskItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Onderliggend' }] }] }] },
    ],
  };
  const names = (kind: string, id: string) => (kind === 'client' && id === KLANT ? 'Bakkerij Jansen' : null);
  assert.equal(taskTitleFromItem(item, names), 'Bel Bakkerij Jansen over de taak');
  // Zonder namen: de soort, zoals op de chip.
  assert.equal(taskTitleFromItem(item, () => null), 'Bel klant over de taak');
  // Een lege regel: geen titel.
  assert.equal(taskTitleFromItem({ type: 'taskItem', content: [{ type: 'paragraph' }] }, () => null), '');
  // Te lang: afgekapt, met een beletselteken.
  const lang = taskTitleFromItem({ type: 'taskItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(800) }] }] }, () => null);
  assert.equal(lang.length, TASK_TITLE_MAX);
  assert.ok(lang.endsWith('…'));
});
