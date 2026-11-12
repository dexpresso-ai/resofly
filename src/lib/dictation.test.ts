import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_DICTATION, collapseRepeats, composeDraft, isAndroidUserAgent, readDictationEvent,
  type DictationState, type SpeechPiece,
} from './dictation.ts';

// Bootst na hoe Chrome en Safari de resultatenlijst opbouwen: alle definitieve
// resultaten van de sessie blijven staan, de tussenresultaten komen erachter,
// en resultIndex wijst naar het eerste nieuwe resultaat.
function session(android = false) {
  const finals: SpeechPiece[] = [];
  let state: DictationState = EMPTY_DICTATION;
  return {
    emit(newFinals: SpeechPiece[], interims: SpeechPiece[] = []): string {
      const resultIndex = finals.length;
      finals.push(...newFinals);
      const out = readDictationEvent(state, resultIndex, [...finals, ...interims], { android });
      state = out.state;
      return out.text;
    },
  };
}
const final = (transcript: string, confidence = 0.92): SpeechPiece => ({ transcript, isFinal: true, confidence });
const interim = (transcript: string): SpeechPiece => ({ transcript, isFinal: false, confidence: 0 });
// Chrome op Android: een tussenresultaat dat als definitief binnenkomt, zonder zekerheid.
const androidPartial = (transcript: string): SpeechPiece => ({ transcript, isFinal: true, confidence: 0 });

test('Chrome op de computer: tussenstukken en losse zinnen achter elkaar', () => {
  const s = session();
  assert.equal(s.emit([], [interim('hallo')]), 'hallo');
  assert.equal(s.emit([], [interim('hallo hoe'), interim(' gaat')]), 'hallo hoe gaat');
  assert.equal(s.emit([final('hallo hoe gaat het')]), 'hallo hoe gaat het');
  assert.equal(s.emit([], [interim(' met')]), 'hallo hoe gaat het met');
  assert.equal(s.emit([final(' met jou')]), 'hallo hoe gaat het met jou');
  assert.equal(s.emit([], [interim(' stuur de factuur')]), 'hallo hoe gaat het met jou stuur de factuur');
  assert.equal(s.emit([final(' stuur de factuur naar Jansen')]), 'hallo hoe gaat het met jou stuur de factuur naar Jansen');
});

test('Chrome op Android: elk tussenresultaat als definitief, zonder dubbele woorden', () => {
  const s = session(true);
  assert.equal(s.emit([androidPartial('hallo')]), 'hallo');
  assert.equal(s.emit([androidPartial('hallo hoe')]), 'hallo hoe');
  assert.equal(s.emit([androidPartial('hallo hoe gaat')]), 'hallo hoe gaat');
  assert.equal(s.emit([androidPartial('hallo hoe gaat het')]), 'hallo hoe gaat het');
  assert.equal(s.emit([final('hallo hoe gaat het', 0.87)]), 'hallo hoe gaat het');
});

test('Chrome op Android: een verbetering van de herkenner vervangt, plakt niet aan', () => {
  const s = session(true);
  s.emit([androidPartial('maak een')]);
  assert.equal(s.emit([androidPartial('maak een koe')]), 'maak een koe');
  assert.equal(s.emit([androidPartial('maak een offerte voor')]), 'maak een offerte voor');
  assert.equal(s.emit([androidPartial('maak een offerte voor Jansen')]), 'maak een offerte voor Jansen');
  assert.equal(s.emit([final('Maak een offerte voor Jansen.', 0.8)]), 'Maak een offerte voor Jansen.');
});

test('Chrome op Android: zonder echte uitslag aan het eind blijft de tekst staan', () => {
  const s = session(true);
  s.emit([androidPartial('welke facturen')]);
  assert.equal(s.emit([androidPartial('welke facturen staan open')]), 'welke facturen staan open');
});

test('Chrome op Android: losse zinnen per keer gaan niet verloren, de eindtekst niet dubbel', () => {
  const s = session(true);
  s.emit([androidPartial('hallo daar')]);
  assert.equal(s.emit([androidPartial('en verder')]), 'hallo daar en verder');
  assert.equal(s.emit([final('hallo daar en verder', 0.9)]), 'hallo daar en verder');
});

test('Safari: de hele tekst sinds de start opnieuw als definitief resultaat', () => {
  const s = session();
  assert.equal(s.emit([final('Hallo, hoe gaat het?')]), 'Hallo, hoe gaat het?');
  assert.equal(s.emit([], [interim('Hallo, hoe gaat het met')]), 'Hallo, hoe gaat het met');
  assert.equal(s.emit([final('Hallo, hoe gaat het met jou?')]), 'Hallo, hoe gaat het met jou?');
});

test('hetzelfde resultaat twee keer gemeld komt er één keer in', () => {
  const s = session();
  s.emit([final('welke offertes lopen er nog')]);
  assert.equal(s.emit([final('welke offertes lopen er nog')]), 'welke offertes lopen er nog');
  assert.equal(s.emit([final(' welke offertes lopen er nog ')]), 'welke offertes lopen er nog');
});

test('een zin die twee keer in één resultaat staat, één keer', () => {
  assert.equal(collapseRepeats('stuur de factuur stuur de factuur'), 'stuur de factuur');
  assert.equal(collapseRepeats('Stuur de factuur. stuur de factuur'), 'Stuur de factuur.');
  assert.equal(collapseRepeats('a b a b a b'), 'a b');
  const s = session();
  assert.equal(s.emit([], [interim('hoe laat is het hoe laat is het')]), 'hoe laat is het');
});

test('echte herhaling van één woord en gewone zinnen blijven heel', () => {
  assert.equal(collapseRepeats('nee nee'), 'nee nee');
  assert.equal(collapseRepeats('heel heel erg bedankt'), 'heel heel erg bedankt');
  assert.equal(collapseRepeats('  dubbele   spaties  weg '), 'dubbele spaties weg');
  const s = session();
  s.emit([final('ik wil een factuur')]);
  assert.equal(s.emit([final(' ik bedoel een offerte')]), 'ik wil een factuur ik bedoel een offerte');
});

test('lege en ontbrekende resultaten veranderen niets', () => {
  const out = readDictationEvent(EMPTY_DICTATION, 0, [interim('   '), final('')], { android: false });
  assert.equal(out.text, '');
  assert.deepEqual(out.state, EMPTY_DICTATION);
});

test('composeDraft zet de ingesproken tekst achter wat er al stond', () => {
  assert.equal(composeDraft('', 'hallo'), 'hallo');
  assert.equal(composeDraft('Vraag: ', 'hoe gaat het'), 'Vraag: hoe gaat het');
  assert.equal(composeDraft('Vraag:', ''), 'Vraag:');
  assert.equal(composeDraft('', '   '), '');
  assert.equal(composeDraft('ab', 'cd', 4), 'ab c');
});

test('isAndroidUserAgent', () => {
  assert.equal(isAndroidUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'), true);
  assert.equal(isAndroidUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'), false);
});
