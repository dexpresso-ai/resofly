/**
 * Tests voor de @-vermeldingen in een pagina (stap 2-1a). Draaien met:  npm test
 *
 * Een vermelding bewaart alleen de soort en het id. Wat hier niet klopt, komt
 * nergens als vermelding mee: niet in Word, niet bij de klant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENTION_KIND_WORDS, MENTION_KINDS, mentionKey, mentionKind, mentionOf, mentionsIn, mentionText } from './pageMentions.ts';

const ID = '11111111-2222-4333-8444-555555555555';

test('een vermelding: een bekende soort en een uuid, anders niets', () => {
  assert.deepEqual(mentionOf({ type: 'mention', attrs: { kind: 'task', id: ID.toUpperCase() } }), { kind: 'task', id: ID });
  for (const node of [
    { type: 'mention', attrs: { kind: 'leverancier', id: ID } },
    { type: 'mention', attrs: { kind: 'task', id: 'abc' } },
    { type: 'mention', attrs: { kind: 'task' } },
    { type: 'mention' },
    { type: 'paragraph', attrs: { kind: 'task', id: ID } },
    null,
    'mention',
  ]) {
    assert.equal(mentionOf(node), null, JSON.stringify(node));
  }
  assert.equal(mentionKind('member'), 'member');
  assert.equal(mentionKind('Member'), null);
});

test('elke soort heeft een woord voor wie de naam niet mag zien', () => {
  for (const kind of MENTION_KINDS) assert.ok(MENTION_KIND_WORDS[kind], kind);
  assert.equal(mentionText({ kind: 'invoice', id: ID }, {}), 'factuur');
  assert.equal(mentionText({ kind: 'invoice', id: ID }, { [mentionKey({ kind: 'invoice', id: ID })]: ' F-2026-014 ' }), 'F-2026-014');
  assert.equal(mentionText({ kind: 'client', id: ID }, { [mentionKey({ kind: 'client', id: ID })]: '  ' }), 'klant');
  assert.equal(mentionText(null, null), 'vermelding');
  // Een sleutel als "constructor" zit niet in elk object.
  assert.equal(mentionText({ kind: 'client', id: ID }, Object.create(null)), 'klant');
});

test('de vermeldingen in een pagina, ook diep in een tabel of kolom, elk één keer', () => {
  const m = (kind: string, id = ID) => ({ type: 'mention', attrs: { kind, id } });
  const body = { type: 'doc', content: [
    { type: 'paragraph', content: [m('client'), { type: 'text', text: ' en ' }, m('client')] },
    { type: 'columns', content: [{ type: 'column', content: [{ type: 'paragraph', content: [m('member', '66666666-7777-4888-9999-000000000000')] }] }] },
    { type: 'paragraph', content: [m('kapot')] },
  ] };
  assert.deepEqual(mentionsIn([body, null, body]), [
    { kind: 'client', id: ID },
    { kind: 'member', id: '66666666-7777-4888-9999-000000000000' },
  ]);
});
