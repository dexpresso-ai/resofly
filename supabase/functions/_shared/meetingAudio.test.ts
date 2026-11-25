/**
 * Wanneer de audio van een opname weg mag, met behoud van transcript en
 * notulen (Inhoud → Meetings).
 * Draaien met:  npm test
 *
 * Gaat dit mis, dan wist iemand de audio van een opname die nog moet worden
 * uitgeschreven (het tegoed was op), en is de meeting voorgoed weg.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { audioDeleteDecision } from './meetingAudio.ts';

const key = 'org/meeting_recording/rec/meeting.webm';

test('met transcript mag de audio weg, ook als de notulen nog komen of mislukten', () => {
  for (const status of ['transcribed', 'summarizing', 'done', 'error']) {
    assert.deepEqual(audioDeleteDecision({ status, storage_key: key, transcript_text: 'Spreker 1: hallo' }), { kind: 'allowed' }, status);
  }
});

test('zolang er geen transcript is, blijft de audio staan', () => {
  for (const status of ['uploaded', 'transcribing']) {
    const decision = audioDeleteDecision({ status, storage_key: key, transcript_text: null });
    assert.equal(decision.kind, 'refused', status);
  }
  // Ook met een (oud) transcript: een opname die opnieuw wordt uitgeschreven, heeft zijn audio nodig.
  assert.equal(audioDeleteDecision({ status: 'transcribing', storage_key: key, transcript_text: 'oud' }).kind, 'refused');
  // Uitschrijven mislukt: dan blijft er zonder audio niets over.
  const failed = audioDeleteDecision({ status: 'error', storage_key: key, transcript_text: '   ' });
  assert.equal(failed.kind, 'refused');
  assert.match(failed.kind === 'refused' ? failed.message : '', /hele opname/);
});

test('geen audio meer: niets te doen, en geen fout', () => {
  assert.deepEqual(audioDeleteDecision({ status: 'done', storage_key: null, transcript_text: 'tekst' }), { kind: 'gone' });
  assert.deepEqual(audioDeleteDecision({ status: 'uploaded', storage_key: null, transcript_text: null }), { kind: 'gone' });
});
