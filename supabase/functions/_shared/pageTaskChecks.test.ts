import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskCheckSummary, taskChecksFor, withTaskChecks } from './pageTaskChecks.ts';

// Stap 2-2c: in een download volgt het vinkje van een regel met een taak de
// stand van die taak. Welke taken er zijn, bepaalt de database (de RLS op
// tasks, met de rechten van wie exporteert).

const item = (id: string, checked: boolean, nested: unknown[] = []) => ({
  type: 'taskItem', attrs: { checked, id },
  content: [{ type: 'paragraph', content: [{ type: 'text', text: id }] }, ...nested],
});
const page = (...items: unknown[]) => ({ type: 'doc', content: [{ type: 'taskList', content: items }] });

test('per pagina en per regel: een gekopieerde pagina met dezelfde regel-id volgt haar eigen taak', () => {
  const tasks = [
    { page_id: 'p1', page_block_id: 'r1', status: 'done' },
    { page_id: 'p2', page_block_id: 'r1', status: 'todo' },
    { page_id: 'p1', page_block_id: null, status: 'done' },
    { page_id: 'p1', page_block_id: 'r2', status: 'doing' },
  ];
  assert.deepEqual([...taskChecksFor('p1', tasks)], [['r1', true], ['r2', false]]);
  assert.deepEqual([...taskChecksFor('p2', tasks)], [['r1', false]]);
  // Dezelfde body, twee pagina's: elk de eigen stand.
  const body = page(item('r1', false));
  const opP1 = withTaskChecks(body, taskChecksFor('p1', tasks));
  const opP2 = withTaskChecks(body, taskChecksFor('p2', tasks));
  assert.equal((opP1.body as ReturnType<typeof page>).content[0].content[0].attrs.checked, true);
  assert.equal(opP2.body, body, 'niets te doen: dezelfde body');
});

test('aan en uit, ook genest; een regel zonder taak blijft zoals hij is', () => {
  const body = page(
    item('klaar', false),
    item('weer-open', true, [{ type: 'taskList', content: [item('genest-klaar', false)] }]),
    item('zonder-taak', true),
  );
  const checks = new Map([['klaar', true], ['weer-open', false], ['genest-klaar', true]]);
  const out = withTaskChecks(body, checks);
  assert.equal(out.on, 2);
  assert.equal(out.off, 1);
  const json = JSON.stringify(out.body);
  assert.ok(json.includes('"checked":true,"id":"klaar"'));
  assert.ok(json.includes('"checked":false,"id":"weer-open"'));
  assert.ok(json.includes('"checked":true,"id":"genest-klaar"'));
  assert.ok(json.includes('"checked":true,"id":"zonder-taak"'));
  // De oorspronkelijke body is niet veranderd.
  assert.ok(JSON.stringify(body).includes('"checked":false,"id":"klaar"'));
  // Al gelijk: dezelfde body, niets geteld.
  const again = withTaskChecks(out.body, checks);
  assert.equal(again.body, out.body);
  assert.deepEqual([again.on, again.off], [0, 0]);
  // Geen taken, of geen body: niets.
  assert.equal(withTaskChecks(body, new Map()).body, body);
  assert.equal(withTaskChecks(null, checks).body, null);
});

test('wat achterloopt, in gewone woorden', () => {
  assert.equal(taskCheckSummary(1, 0), '1 gaat aan');
  assert.equal(taskCheckSummary(2, 1), '2 gaan aan, 1 gaat uit');
  assert.equal(taskCheckSummary(0, 3), '3 gaan uit');
});
