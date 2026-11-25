/**
 * Wie mag een opname zien (_shared/recordingPrivacy.ts).
 * Draaien met:  npm test
 *
 * Gaat dit mis, dan lezen, mailen of wissen collega's via Gerrie, MCP, de API
 * of meeting-transcribe de notulen van een meeting uit iemands privé-agenda,
 * of komen die notulen op de gedeelde beslislijst.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordingSharedWithTeam, recordingVisibleTo, sourceReadableBy, visibleRecordingsFilter,
} from './recordingPrivacy.ts';

const IK = '11111111-1111-4111-8111-111111111111';
const COLLEGA = '22222222-2222-4222-8222-222222222222';
const PRIVE = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';
const mijnPrive = { user_id: IK, visibility: 'private' };
const teamAgenda = { user_id: IK, visibility: 'organization' };

test('een agenda lees je als hij van jou is of met het team gedeeld', () => {
  assert.equal(sourceReadableBy(mijnPrive, IK), true);
  assert.equal(sourceReadableBy(mijnPrive, COLLEGA), false);
  assert.equal(sourceReadableBy(teamAgenda, COLLEGA), true);
  assert.equal(sourceReadableBy(null, IK), false);
  assert.equal(sourceReadableBy(mijnPrive, null), false, 'zonder gebruiker: alleen gedeeld');
});

test('een opname uit jouw privé-agenda ziet je collega niet', () => {
  const rec = { created_by: IK, source_id: PRIVE };
  assert.equal(recordingVisibleTo(rec, IK, mijnPrive), true);
  assert.equal(recordingVisibleTo(rec, COLLEGA, mijnPrive), false);
  assert.equal(recordingSharedWithTeam(rec, mijnPrive), false, 'niet op de beslislijst');
});

test('gedeelde agenda, eigen opname, in Inhoud, gesprek en notitie: wel', () => {
  assert.equal(recordingVisibleTo({ created_by: IK, source_id: TEAM }, COLLEGA, teamAgenda), true);
  assert.equal(recordingSharedWithTeam({ created_by: IK, source_id: TEAM }, teamAgenda), true);
  assert.equal(recordingVisibleTo({ created_by: COLLEGA, source_id: PRIVE }, COLLEGA, mijnPrive), true, 'de collega nam hem zelf op');
  assert.equal(recordingVisibleTo({ created_by: IK, source_id: PRIVE, content_note_id: 'n' }, COLLEGA, mijnPrive), true, 'staat al in Inhoud');
  assert.equal(recordingVisibleTo({ created_by: IK, call_id: 'c' }, COLLEGA, null), true, 'telefoongesprek');
  assert.equal(recordingVisibleTo({ created_by: IK, note_id: 'n' }, COLLEGA, null), true, 'notitie-opname');
});

test('zonder agenda (verwijderd) ziet alleen de maker hem', () => {
  assert.equal(recordingVisibleTo({ created_by: IK, source_id: null }, IK, null), true);
  assert.equal(recordingVisibleTo({ created_by: IK, source_id: null }, COLLEGA, null), false);
  // Een agenda-id die niet (meer) te vinden is, telt als geen agenda.
  assert.equal(recordingVisibleTo({ created_by: IK, source_id: PRIVE }, COLLEGA, null), false);
});

test('het lijstfilter: alleen uuid\'s, en zonder agenda\'s geen lege lijst', () => {
  assert.equal(visibleRecordingsFilter(COLLEGA, [TEAM, PRIVE]),
    `note_id.not.is.null,call_id.not.is.null,content_note_id.not.is.null,created_by.eq.${COLLEGA},source_id.in.(${TEAM},${PRIVE})`);
  assert.equal(visibleRecordingsFilter(COLLEGA, []),
    `note_id.not.is.null,call_id.not.is.null,content_note_id.not.is.null,created_by.eq.${COLLEGA}`);
  // Tekst die geen uuid is, komt nooit in het filter.
  assert.equal(visibleRecordingsFilter('x),or(id.not.is.null', ['y)']),
    'note_id.not.is.null,call_id.not.is.null,content_note_id.not.is.null');
});
