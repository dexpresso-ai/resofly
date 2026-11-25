/**
 * Inhoud → Meetings: wie welke meeting ziet, wanneer de audio weg mag, zoeken
 * en de teksten in de tabel.
 * Draaien met:  npm test
 *
 * Gaat dit mis, dan toont het overzicht de meeting uit de privé-agenda van
 * een collega (titel én transcript), of biedt het "Audio verwijderen" aan bij
 * een opname die nog moet worden uitgeschreven: dan is de meeting voorgoed weg.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioLabel, audioTotals, canDeleteAudio, durationShort, filterMeetings, matchesQuery, meetingDay, meetingKind,
  meetingTitle, notulenState, shortDay, sortMeetings, visibleInOverview, type MeetingKind, type MeetingOverviewRow,
} from './meetingsOverview.ts';
import { audioDeleteDecision } from '../../supabase/functions/_shared/meetingAudio.ts';
import { recordingVisibleTo } from '../../supabase/functions/_shared/recordingPrivacy.ts';

const ME = 'u-ik';
const COLLEGA = 'u-collega';
const SHARED = 'src-gedeeld';
const MINE_PRIVATE = 'src-eigen-prive';
const THEIRS_PRIVATE = 'src-collega-prive';
const readable = new Set([SHARED, MINE_PRIVATE]);

function row(extra: Partial<MeetingOverviewRow> = {}): MeetingOverviewRow {
  return {
    id: 'r1', organization_id: 'org', created_at: '2026-11-24T09:00:00Z', created_by: ME, provider: 'native', source_id: SHARED,
    event_title_snapshot: 'Kick-off', client_id: null, project_id: null, call_id: null, note_id: null, content_note_id: null,
    meeting_date: '2026-11-24', event_starts_at: null, storage_key: 'org/meeting_recording/r1/a.webm', mime_type: 'audio/webm',
    size_bytes: 1_000_000, duration_seconds: 1800, status: 'done', error_message: null, summary_text: 'Samenvatting',
    summary_sent_at: null, audio_deleted_at: null,
    ...extra,
  };
}

test('een meeting uit de privé-agenda van een collega staat niet in het overzicht', () => {
  const viewer = { userId: ME, readableSourceIds: readable };
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: THEIRS_PRIVATE }), viewer), false);
  // Ook niet zonder agenda (de agenda is weg): dan alleen voor wie hem maakte.
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: null }), viewer), false);
  assert.equal(visibleInOverview(row({ created_by: ME, source_id: null }), viewer), true);
});

test('gedeelde agenda, eigen agenda, eigen opname en wat al in Inhoud staat: wel', () => {
  const viewer = { userId: ME, readableSourceIds: readable };
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: SHARED }), viewer), true);
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: MINE_PRIVATE }), viewer), true);
  assert.equal(visibleInOverview(row({ created_by: ME, source_id: THEIRS_PRIVATE }), viewer), true);
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: THEIRS_PRIVATE, content_note_id: 'n1' }), viewer), true);
  // Een gesprek hoort bij het klantdossier, een notitie-opname bij Inhoud.
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: null, call_id: 'c1' }), viewer), true);
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: null, note_id: 'n2' }), viewer), true);
});

test('lukte het lezen van de agenda\'s niet, dan alleen wat zeker gedeeld is', () => {
  const viewer = { userId: ME, readableSourceIds: new Set<string>() };
  assert.equal(visibleInOverview(row({ created_by: COLLEGA, source_id: SHARED }), viewer), false);
  assert.equal(visibleInOverview(row({ created_by: ME }), viewer), true);
});

test('audio verwijderen alleen met audio én transcript, net als de server', () => {
  assert.equal(canDeleteAudio(row()), true);
  assert.equal(canDeleteAudio(row({ status: 'transcribed' })), true);
  assert.equal(canDeleteAudio(row({ status: 'summarizing' })), true);
  assert.equal(canDeleteAudio(row({ status: 'uploaded' })), false, 'wacht nog op uitschrijven');
  assert.equal(canDeleteAudio(row({ status: 'transcribing' })), false, 'wordt nog uitgeschreven');
  assert.equal(canDeleteAudio(row({ status: 'error' })), false, 'mislukt: dan de hele opname');
  assert.equal(canDeleteAudio(row({ storage_key: null })), false, 'al weg');
  // Waar de app de knop toont, weigert de server niet.
  for (const status of ['uploaded', 'transcribing', 'transcribed', 'summarizing', 'done', 'error'] as const) {
    const rec = row({ status });
    if (canDeleteAudio(rec)) {
      assert.equal(audioDeleteDecision({ status, storage_key: rec.storage_key, transcript_text: 'Spreker 1: hallo' }).kind, 'allowed', status);
    }
  }
});

test('de soort, de titel en de dag', () => {
  assert.equal(meetingKind(row()), 'afspraak');
  assert.equal(meetingKind(row({ call_id: 'c' })), 'gesprek');
  assert.equal(meetingKind(row({ note_id: 'n' })), 'notitie');
  assert.equal(meetingTitle(row({ event_title_snapshot: '  Weekstart \n team ' })), 'Weekstart team');
  assert.equal(meetingTitle(row({ event_title_snapshot: null })), 'Meeting zonder titel');
  assert.equal(meetingTitle(row({ event_title_snapshot: null, call_id: 'c' })), 'Telefoongesprek');
  assert.equal(meetingDay(row({ meeting_date: '2026-11-20' })), '2026-11-20');
  // Zonder dag van de afspraak: de opnamedag op Nederlandse tijd (23:30 UTC is al de volgende dag).
  assert.equal(meetingDay(row({ meeting_date: null, created_at: '2026-11-24T23:30:00Z' })), '2026-11-25');
  assert.equal(shortDay('2026-11-24', new Date('2026-11-25T12:00:00Z')), '24 nov');
  assert.equal(shortDay('2025-03-02', new Date('2026-11-25T12:00:00Z')), '2 mrt 2025');
});

test('duur en audio in gewone woorden', () => {
  assert.equal(durationShort(null), '');
  assert.equal(durationShort(20), '< 1 min');
  assert.equal(durationShort(45 * 60), '45 min');
  assert.equal(durationShort(65 * 60), '1 u 05');
  assert.equal(audioLabel(row({ size_bytes: 38_400_000 })), '37 MB');
  assert.equal(audioLabel(row({ size_bytes: 4_200_000 })), '4,0 MB');
  assert.equal(audioLabel(row({ storage_key: null, size_bytes: null, audio_deleted_at: '2026-11-25T10:00:00Z' })), 'Verwijderd');
  assert.equal(audioLabel(row({ storage_key: null, size_bytes: null })), '—');
});

test('de stand van de notulen', () => {
  assert.deepEqual(notulenState(row()), { label: 'Klaar', tone: 'ok' });
  assert.equal(notulenState(row({ status: 'transcribed', summary_text: null })).label, 'Notulen volgen');
  assert.equal(notulenState(row({ status: 'transcribed', error_message: 'Tegoed op', summary_text: null })).label, 'Alleen transcript');
  assert.equal(notulenState(row({ status: 'uploaded', error_message: 'Tegoed op' })).label, 'Wacht op tegoed');
  assert.equal(notulenState(row({ status: 'error' })).label, 'Mislukt');
});

test('zoeken op titel, klant en notulen; hoofdletters en accenten tellen niet', () => {
  const rec = row({ event_title_snapshot: 'Kick-off huisstijl', summary_text: 'Besproken: het café en de logo\'s' });
  assert.equal(matchesQuery(rec, 'De Korenaar', 'korenaar'), true);
  assert.equal(matchesQuery(rec, null, 'HUISSTIJL'), true);
  assert.equal(matchesQuery(rec, null, 'cafe logo'), true, 'alle woorden, in elke volgorde');
  assert.equal(matchesQuery(rec, null, 'cafe factuur'), false);
  assert.equal(matchesQuery(rec, null, '   '), true);
});

test('filteren op soort en audio, en de nieuwste meeting bovenaan', () => {
  const rows = [
    row({ id: 'a', meeting_date: '2026-11-01', created_at: '2026-11-01T10:00:00Z' }),
    row({ id: 'b', meeting_date: '2026-11-20', created_at: '2026-11-02T10:00:00Z', storage_key: null, size_bytes: null }),
    row({ id: 'c', call_id: 'c1', meeting_date: null, created_at: '2026-11-10T10:00:00Z' }),
  ];
  assert.deepEqual(sortMeetings(rows).map((r) => r.id), ['b', 'c', 'a']);
  const all = new Set<MeetingKind>(['afspraak', 'gesprek', 'notitie']);
  const none = () => null;
  assert.deepEqual(filterMeetings(rows, { query: '', audio: 'with-audio', kinds: all }, none).map((r) => r.id), ['a', 'c']);
  assert.deepEqual(filterMeetings(rows, { query: '', audio: 'all', kinds: new Set<MeetingKind>(['gesprek']) }, none).map((r) => r.id), ['c']);
  assert.deepEqual(audioTotals(rows), { count: 2, bytes: 2_000_000 });
});

test('de app en de server beslissen hetzelfde over wie een meeting ziet', () => {
  // Elke combinatie: soort, maker, agenda (privé van mij, gedeeld, weg), en wie kijkt.
  const sources: Record<string, { user_id: string; visibility: string } | null> = {
    [MINE_PRIVATE]: { user_id: ME, visibility: 'private' },
    [SHARED]: { user_id: ME, visibility: 'organization' },
    [THEIRS_PRIVATE]: { user_id: COLLEGA, visibility: 'private' },
  };
  const readableBy = (userId: string) => new Set(Object.entries(sources)
    .filter(([, s]) => s && (s.visibility === 'organization' || s.user_id === userId)).map(([id]) => id));
  for (const kind of [{}, { call_id: 'c' }, { note_id: 'n' }, { content_note_id: 'cn' }]) {
    for (const created_by of [ME, COLLEGA]) {
      for (const source_id of [MINE_PRIVATE, SHARED, THEIRS_PRIVATE, null]) {
        for (const viewer of [ME, COLLEGA]) {
          const rec = row({ ...kind, created_by, source_id });
          const app = visibleInOverview(rec, { userId: viewer, readableSourceIds: readableBy(viewer) });
          const server = recordingVisibleTo(rec, viewer, source_id ? sources[source_id] : null);
          assert.equal(app, server, JSON.stringify({ kind, created_by, source_id, viewer }));
        }
      }
    }
  }
});
