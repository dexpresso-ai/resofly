/**
 * Tests voor wat er naar Google en Microsoft gaat bij het aanmaken en bewerken
 * van een afspraak (calendarEventBody.ts). Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeForProvider, googleEventBody, microsoftEventBody, needsCurrentDescription, nextDay, toMicrosoftDateTime } from './calendarEventBody.ts';

const JITSI = 'https://meet.jit.si/ResoFly-AbCdEfGhJkMnPq';
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0';
const draft = {
  title: 'Intake', startsAt: '2026-11-10T09:00:00.000Z', endsAt: '2026-11-10T10:00:00.000Z', allDay: false,
};

test('datumhulpjes', () => {
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2026-03-29'), '2026-03-30');
  assert.equal(toMicrosoftDateTime('2026-11-10T09:00:00.000Z'), '2026-11-10T09:00:00');
});

test('Google: alleen wat genoemd is gaat mee; een Meet alleen als erom gevraagd is', () => {
  const kaal = googleEventBody('Europe/Amsterdam', draft, null);
  assert.deepEqual(Object.keys(kaal).sort(), ['end', 'start', 'summary']);
  assert.deepEqual(kaal.start, { dateTime: draft.startsAt, timeZone: 'Europe/Amsterdam' });
  const vol = googleEventBody(null, { ...draft, description: null, location: '', attendees: [{ email: 'jan@x.nl', name: 'Jan', role: 'opt' }] }, 'req-1');
  // Expliciet leeg gaat wél mee: zo wist een lege omschrijving echt.
  assert.equal(vol.description, null);
  assert.equal(vol.location, '');
  assert.deepEqual(vol.attendees, [{ email: 'jan@x.nl', displayName: 'Jan', optional: true }]);
  assert.deepEqual(vol.conferenceData, { createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } });
});

test('Google en Microsoft: een hele dag met een exclusieve einddatum', () => {
  const dag = { ...draft, allDay: true, startsAt: '2026-05-08T00:00:00.000Z', endsAt: '2026-05-08T00:00:00.000Z' };
  assert.deepEqual(googleEventBody(null, dag, null).end, { date: '2026-05-09' });
  const ms = microsoftEventBody({ ...dag, endsAt: '2026-05-10T00:00:00.000Z' }, false);
  assert.deepEqual([ms.start, ms.end], [{ dateTime: '2026-05-08T00:00:00', timeZone: 'UTC' }, { dateTime: '2026-05-11T00:00:00', timeZone: 'UTC' }]);
});

test('Microsoft: alleen wat genoemd is, en Teams als erom gevraagd is', () => {
  const kaal = microsoftEventBody(draft, false);
  assert.deepEqual(Object.keys(kaal).sort(), ['end', 'isAllDay', 'start', 'subject']);
  const vol = microsoftEventBody({ ...draft, description: 'Agenda', location: null }, true);
  assert.deepEqual(vol.body, { contentType: 'HTML', content: 'Agenda' });
  assert.deepEqual(vol.location, { displayName: '' });
  assert.equal(vol.isOnlineMeeting, true);
  assert.equal(vol.onlineMeetingProvider, 'teamsForBusiness');
});

test('de omschrijving met videocall-regel: nieuw, vervangen, weghalen en laten staan', () => {
  // Nieuw of vervangen: Google onderaan, Microsoft bovenaan.
  assert.equal(describeForProvider('google', 'Agenda', JITSI, null), `Agenda\n\n🎥 Videocall: ${JITSI}`);
  assert.equal(describeForProvider('microsoft', 'Agenda', TEAMS, null), `🎥 Videocall: ${TEAMS}\n\nAgenda`);
  // Geen regel meer.
  assert.equal(describeForProvider('google', 'Agenda', null, null), 'Agenda');
  // Niets genoemd: niets meesturen.
  assert.equal(describeForProvider('google', undefined, 'keep', 'Oud'), undefined);
  // Alleen de omschrijving nieuw (Gerrie): de bestaande regel blijft.
  assert.equal(describeForProvider('google', 'Nieuw', 'keep', `Oud\n\n🎥 Videocall: ${JITSI}`), `Nieuw\n\n🎥 Videocall: ${JITSI}`);
  // Alleen de video nieuw: de bestaande omschrijving blijft, de oude regel gaat eraf.
  assert.equal(describeForProvider('google', undefined, TEAMS, `Oud\n\n🎥 Videocall: ${JITSI}`), `Oud\n\n🎥 Videocall: ${TEAMS}`);
  assert.equal(describeForProvider('microsoft', undefined, null, `🎥 Videocall: ${JITSI}\n\nOud`), 'Oud');

  assert.equal(needsCurrentDescription(undefined, 'keep'), false);
  assert.equal(needsCurrentDescription('x', JITSI), false);
  assert.equal(needsCurrentDescription(undefined, JITSI), true);
  assert.equal(needsCurrentDescription('x', 'keep'), true);
});
