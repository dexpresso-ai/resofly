import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToPdfBlocks, normalizePdfText } from './pdfText.ts';

const texts = (html: string) => htmlToPdfBlocks(html).map((b) => b.text);

test('div-regels na een kop komen mee in de PDF (dit ging mis)', () => {
  const blocks = htmlToPdfBlocks('<h2>Artikel 1 - Prijs</h2><div>De prijs is EUR 1.000 per maand.</div><div>Opzegtermijn: 3 maanden.</div>');
  assert.deepEqual(blocks, [
    { type: 'h2', text: 'Artikel 1 - Prijs' },
    { type: 'p', text: 'De prijs is EUR 1.000 per maand.' },
    { type: 'p', text: 'Opzegtermijn: 3 maanden.' },
  ]);
});

test('losse tekst, h1/h5/h6 en tabellen gaan niet verloren', () => {
  assert.deepEqual(texts('Inleiding<h1>Titel</h1><h5>Klein</h5><h6>Kleiner</h6>slot'), ['Inleiding', 'Titel', 'Klein', 'Kleiner', 'slot']);
  assert.deepEqual(texts('<p>Tarieven</p><table><tr><th>Dienst</th><th>Prijs</th></tr><tr><td>Uur</td><td>&euro; 95</td></tr></table>'),
    ['Tarieven', 'Dienst | Prijs', 'Uur | € 95']);
});

test('geneste lijsten: alle items, met nummering en inspringen', () => {
  const blocks = htmlToPdfBlocks('<ol><li>Eén<ul><li>Sub a</li><li>Sub b</li></ul></li><li>Twee</li></ol><p>Na de lijst</p>');
  assert.deepEqual(blocks, [
    { type: 'li', text: '1. Eén', depth: 0 },
    { type: 'li', text: '•  Sub a', depth: 1 },
    { type: 'li', text: '•  Sub b', depth: 1 },
    { type: 'li', text: '2. Twee', depth: 0 },
    { type: 'p', text: 'Na de lijst' },
  ]);
});

test('inline-opmaak, regeleinden, citaten en entiteiten', () => {
  assert.deepEqual(htmlToPdfBlocks('<p>Dit is <strong>vet</strong> en <em>schuin</em>.<br>Nieuwe regel &amp; &#8364; 5 &#x2264; 6</p><blockquote><p>Citaat</p></blockquote>'), [
    { type: 'p', text: 'Dit is vet en schuin.' },
    { type: 'p', text: 'Nieuwe regel & € 5 ≤ 6' },
    { type: 'quote', text: 'Citaat' },
  ]);
});

test('script, style en commentaar komen nooit in de PDF', () => {
  assert.deepEqual(texts('<p>Zichtbaar</p><!-- intern --><script>alert(1)</script><style>p{}</style><p>Ook</p>'), ['Zichtbaar', 'Ook']);
});

test('platte tekst zonder HTML: alinea per lege regel', () => {
  assert.deepEqual(texts('Eerste alinea\nnog een regel\n\nTweede alinea'), ['Eerste alinea nog een regel', 'Tweede alinea']);
  assert.deepEqual(htmlToPdfBlocks(''), []);
});

test('namen en tekens buiten Latin-1 worden vertaald, niet weggegooid', () => {
  assert.equal(normalizePdfText('Łukasz Dvořák'), 'Lukasz Dvorák');
  assert.equal(normalizePdfText('Boete ≤ € 500'), 'Boete <= EUR 500');
  assert.equal(normalizePdfText('Vaněk — “Œuvre”'), 'Vanek - "OEuvre"');
  // Wat echt niet kan, wordt één zichtbaar vraagteken.
  assert.equal(normalizePdfText('Klant 😀 BV'), 'Klant ? BV');
});
