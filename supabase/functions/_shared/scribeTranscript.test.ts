import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranscript, scribeFailed, scribeRequestId, transcriptEndSeconds } from './scribeTranscript.ts';

// Hoe Scribe woorden aanlevert: met spaties als eigen "woord", sprekers en tijden.
const WOORDEN = [
  { text: 'Goedemorgen', type: 'word', start: 0.1, end: 0.8, speaker_id: 'speaker_0' },
  { text: ' ', type: 'spacing', start: 0.8, end: 0.9, speaker_id: 'speaker_0' },
  { text: 'allemaal.', type: 'word', start: 0.9, end: 1.5, speaker_id: 'speaker_0' },
  { text: 'Dag', type: 'word', start: 2.0, end: 2.3, speaker_id: 'speaker_1' },
  { text: 'Anna.', type: 'word', start: 2.4, end: 41.75, speaker_id: 'speaker_1' },
];
const TRANSCRIPT = { language_code: 'nl', language_probability: 0.99, text: 'Goedemorgen allemaal. Dag Anna.', words: WOORDEN };

test('synchroon antwoord: segmenten per spreker, tekst met sprekerlabels', () => {
  const t = normalizeTranscript(TRANSCRIPT);
  assert.equal(t.language, 'nl');
  assert.equal(t.text, 'Spreker 1: Goedemorgen allemaal.\nSpreker 2: Dag Anna.');
  assert.deepEqual(t.segments.map((s) => [s.speaker, s.start, s.end]), [['Spreker 1', 0.1, 1.5], ['Spreker 2', 2.0, 41.75]]);
});

test('webhook: het transcript zit in data.transcription (zoals ElevenLabs het stuurt)', () => {
  const t = normalizeTranscript({ type: 'speech_to_text_transcription', data: { request_id: 'req_1', transcription: TRANSCRIPT } });
  assert.equal(t.text, 'Spreker 1: Goedemorgen allemaal.\nSpreker 2: Dag Anna.');
  assert.equal(t.language, 'nl');
  assert.equal(t.segments.length, 2);
});

test('webhook in de oude vorm (transcript direct in data) werkt nog', () => {
  const t = normalizeTranscript({ data: { request_id: 'req_1', ...TRANSCRIPT } });
  assert.equal(t.segments.length, 2);
  assert.match(t.text, /^Spreker 1: Goedemorgen/);
});

test('zonder woorden: de kale tekst', () => {
  const t = normalizeTranscript({ text: 'Alleen tekst.', language_code: 'nl' });
  assert.equal(t.text, 'Alleen tekst.');
  assert.deepEqual(t.segments, []);
});

test('waar het transcript eindigt: het laatste tijdstip, 0 zonder tijden', () => {
  assert.equal(transcriptEndSeconds(normalizeTranscript(TRANSCRIPT).segments), 41.75);
  assert.equal(transcriptEndSeconds([]), 0);
  assert.equal(transcriptEndSeconds(null), 0);
  assert.equal(transcriptEndSeconds([{ speaker: null, text: 'x', start: 3, end: null }]), 3);
});

test('request_id staat bovenaan of in data', () => {
  assert.equal(scribeRequestId({ request_id: 'a' }), 'a');
  assert.equal(scribeRequestId({ data: { request_id: 'b' } }), 'b');
  assert.equal(scribeRequestId({ data: { requestId: 'c' } }), 'c');
  assert.equal(scribeRequestId({}), '');
});

test('een foutmelding van ElevenLabs is een fout, een transcript niet', () => {
  assert.equal(scribeFailed({ type: 'speech_to_text_transcription', data: { request_id: 'x', transcription: TRANSCRIPT } }), false);
  assert.equal(scribeFailed({ data: { request_id: 'x', status: 'failed' } }), true);
  assert.equal(scribeFailed({ status: 'error', request_id: 'x' }), true);
  assert.equal(scribeFailed({ type: 'webhook_error', request_id: 'x', error_message: 'Audio kon niet worden gelezen' }), true);
  assert.equal(scribeFailed({ request_id: 'x', error_message: 'Te lang' }), true);
});
