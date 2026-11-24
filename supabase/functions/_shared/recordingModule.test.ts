/**
 * De poort van meeting-transcribe: welke module bewaakt een opname?
 * Draaien met:  npm test
 *
 * Gaat dit mis, dan kan iemand met alleen Agenda het transcript van een
 * notitie mailen of wissen, of iemand met alleen Inhoud een afspraakopname.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { newRecordingModule, recordingModule } from './recordingModule.ts';

test('een bestaande opname: de rij beslist', () => {
  assert.equal(recordingModule({ call_id: null, note_id: 'n1' }), 'content');
  assert.equal(recordingModule({ call_id: 'c1', note_id: null }), 'clients');
  assert.equal(recordingModule({ call_id: null, note_id: null }), 'calendar');
  // Onbekend (niet gevonden in deze organisatie): de oude poort, Agenda.
  assert.equal(recordingModule(null), 'calendar');
});

test('een nieuwe opname: de aanvraag telt alleen bij create en budget', () => {
  assert.equal(newRecordingModule('create', { noteId: 'n1' }), 'content');
  assert.equal(newRecordingModule('create', { callId: 'c1' }), 'clients');
  assert.equal(newRecordingModule('create', {}), 'calendar');
  assert.equal(newRecordingModule('budget', { noteId: 'n1' }), 'content');
  // Een notitie die nog niet is opgeslagen heeft geen id.
  assert.equal(newRecordingModule('budget', { forNote: true }), 'content');
  // Bij create telt forNote niet: daar is het id verplicht.
  assert.equal(newRecordingModule('create', { forNote: true }), 'calendar');
  // Bij elke andere actie niet: anders loopt iemand met een los veld langs de poort.
  for (const action of ['start', 'summarize', 'update', 'sendSummary', 'delete']) {
    assert.equal(newRecordingModule(action, { noteId: 'n1' }), 'calendar', action);
    assert.equal(newRecordingModule(action, { callId: 'c1' }), 'calendar', action);
  }
  // Gesprek en notitie tegelijk: de strengste oude poort (createRecording weigert het daarna).
  assert.equal(newRecordingModule('create', { callId: 'c1', noteId: 'n1' }), 'calendar');
});
