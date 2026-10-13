import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUrls, isEmojiOnly, parseChatText, plainPreview, toggleLinePrefix, toggleWrap,
  type ChatBlock, type ChatInline,
} from './chatFormat.ts';

const para = (blocks: ChatBlock[]): ChatInline[] => {
  assert.equal(blocks[0]?.t, 'p');
  return (blocks[0] as { t: 'p'; c: ChatInline[] }).c;
};

test('vet, cursief, doorgehaald en code', () => {
  assert.deepEqual(para(parseChatText('**vet** en _schuin_ en ~~weg~~ en `x = 1`')), [
    { t: 'b', c: [{ t: 'text', v: 'vet' }] },
    { t: 'text', v: ' en ' },
    { t: 'i', c: [{ t: 'text', v: 'schuin' }] },
    { t: 'text', v: ' en ' },
    { t: 's', c: [{ t: 'text', v: 'weg' }] },
    { t: 'text', v: ' en ' },
    { t: 'code', v: 'x = 1' },
  ]);
  assert.deepEqual(para(parseChatText('*ook schuin*')), [{ t: 'i', c: [{ t: 'text', v: 'ook schuin' }] }]);
});

test('geen opmaak waar die er niet hoort', () => {
  // snake_case, een los sterretje, een niet-afgesloten markering
  assert.deepEqual(para(parseChatText('zie client_email_threads en 3 * 4 = 12 of **half')), [
    { t: 'text', v: 'zie client_email_threads en 3 * 4 = 12 of **half' },
  ]);
});

test('links: kaal, met tekst, zonder leesteken erachter, en nooit javascript:', () => {
  assert.deepEqual(para(parseChatText('kijk op https://resofly.nl/x, of www.example.com.')), [
    { t: 'text', v: 'kijk op ' },
    { t: 'link', href: 'https://resofly.nl/x', c: [{ t: 'text', v: 'https://resofly.nl/x' }] },
    { t: 'text', v: ', of ' },
    { t: 'link', href: 'https://www.example.com', c: [{ t: 'text', v: 'www.example.com' }] },
    { t: 'text', v: '.' },
  ]);
  assert.deepEqual(para(parseChatText('[de offerte](https://app.resofly.nl/q/1)')), [
    { t: 'link', href: 'https://app.resofly.nl/q/1', c: [{ t: 'text', v: 'de offerte' }] },
  ]);
  assert.deepEqual(para(parseChatText('[klik](javascript:alert(1)) javascript:alert(1)')), [
    { t: 'text', v: '[klik](javascript:alert(1)) javascript:alert(1)' },
  ]);
  assert.deepEqual(para(parseChatText('(zie https://a.nl/b_(c))')), [
    { t: 'text', v: '(zie ' },
    { t: 'link', href: 'https://a.nl/b_(c)', c: [{ t: 'text', v: 'https://a.nl/b_(c)' }] },
    { t: 'text', v: ')' },
  ]);
});

test('vermeldingen: de langste naam wint, en alleen als los woord', () => {
  const names = ['Jan', 'Jan Jansen'];
  assert.deepEqual(para(parseChatText('Hoi @Jan Jansen en @Jan!', names)), [
    { t: 'text', v: 'Hoi ' },
    { t: 'mention', name: 'Jan Jansen' },
    { t: 'text', v: ' en ' },
    { t: 'mention', name: 'Jan' },
    { t: 'text', v: '!' },
  ]);
  assert.deepEqual(para(parseChatText('mail@Jansen.nl en @Janneke', names)), [{ t: 'text', v: 'mail@Jansen.nl en @Janneke' }]);
});

test('blokken: lijsten, citaat, codeblok en regeleinden', () => {
  const blocks = parseChatText('Boodschappen:\n- melk\n- **brood**\n\n1. eerst\n2. dan\n> geciteerd\n> tweede regel\n```\nconst a = **1**;\n```\nregel een\nregel twee');
  assert.deepEqual(blocks.map((b) => b.t), ['p', 'ul', 'ol', 'quote', 'pre', 'p']);
  assert.deepEqual((blocks[1] as { items: ChatInline[][] }).items, [
    [{ t: 'text', v: 'melk' }],
    [{ t: 'b', c: [{ t: 'text', v: 'brood' }] }],
  ]);
  assert.equal((blocks[2] as { start: number }).start, 1);
  assert.equal((blocks[4] as { v: string }).v, 'const a = **1**;');
  assert.deepEqual((blocks[5] as { c: ChatInline[] }).c, [{ t: 'text', v: 'regel een' }, { t: 'br' }, { t: 'text', v: 'regel twee' }]);
});

test('voorbeeldregel zonder opmaaktekens', () => {
  assert.equal(plainPreview('**Let op:** de _deadline_ is\n- vrijdag\n- [hier](https://a.nl)'), 'Let op: de deadline is vrijdag, hier');
  assert.equal(plainPreview('a'.repeat(30), 10), 'aaaaaaaaa…');
});

test('links uit een bericht halen', () => {
  assert.deepEqual(extractUrls('https://a.nl en **https://b.nl** en nog eens https://a.nl'), ['https://a.nl', 'https://b.nl']);
});

test('alleen emoji: groot tonen', () => {
  assert.equal(isEmojiOnly('👍'), true);
  assert.equal(isEmojiOnly('🎉 🎉'), true);
  assert.equal(isEmojiOnly('👍🏽'), true);
  assert.equal(isEmojiOnly('👨‍👩‍👧'), true);
  assert.equal(isEmojiOnly('👍👍👍👍'), false);
  assert.equal(isEmojiOnly('top 👍'), false);
  assert.equal(isEmojiOnly('123'), false);
  assert.equal(isEmojiOnly(''), false);
});

test('opmaakknoppen: om de selectie heen, en er weer af', () => {
  const on = toggleWrap('hallo wereld', 6, 12, '**');
  assert.deepEqual(on, { value: 'hallo **wereld**', start: 8, end: 14 });
  assert.deepEqual(toggleWrap(on.value, on.start, on.end, '**'), { value: 'hallo wereld', start: 6, end: 12 });
  assert.deepEqual(toggleWrap('', 0, 0, '_'), { value: '_tekst_', start: 1, end: 6 });
  const list = toggleLinePrefix('een\ntwee', 0, 8, 'number');
  assert.equal(list.value, '1. een\n2. twee');
  assert.equal(toggleLinePrefix(list.value, 0, list.value.length, 'number').value, 'een\ntwee');
});
