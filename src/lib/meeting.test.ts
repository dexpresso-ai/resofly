/**
 * Tests voor het herkennen van vergaderlinks en het maken van Jitsi-links.
 * Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_JITSI_BASE_URL,
  bookingVideoFields,
  bookingVideoFromLink,
  defaultBookingVideo,
  detectMeetingKind,
  effectiveBookingVideo,
  jitsiBaseUrl,
  jitsiMeetingUrl,
  jitsiRoomName,
  jitsiServerLabel,
  normalizeJitsiBaseUrl,
  usesPublicJitsi,
} from './meeting.ts';

test('bekende diensten krijgen hun eigen label', () => {
  assert.equal(detectMeetingKind('https://meet.google.com/abc-defg-hij').label, 'Google Meet');
  assert.equal(detectMeetingKind('https://teams.microsoft.com/l/meetup-join/x').kind, 'teams');
  assert.equal(detectMeetingKind('https://us02web.zoom.us/j/123').kind, 'zoom');
  assert.deepEqual(detectMeetingKind('https://meet.jit.si/ResoFly-AbCdEfGhJkMnPq'), { kind: 'jitsi', label: 'Jitsi Meet' });
  assert.equal(detectMeetingKind('https://8x8.vc/vpaas-magic-cookie-1/Overleg').kind, 'jitsi');
  assert.deepEqual(detectMeetingKind('https://example.com/kamer'), { kind: 'other', label: 'Videocall' });
  assert.equal(detectMeetingKind(null).kind, 'other');
  assert.equal(detectMeetingKind('geen url').kind, 'other');
});

test('een eigen Jitsi-server heet ook Jitsi Meet', () => {
  // Aan het ingestelde serveradres…
  assert.equal(detectMeetingKind('https://video.example.nl/Weekoverleg', 'video.example.nl').kind, 'jitsi');
  assert.equal(detectMeetingKind('https://video.example.nl/Weekoverleg').kind, 'other');
  // …of aan de kamernaam die ResoFly zelf maakt, ook als de instelling sindsdien veranderde.
  assert.equal(detectMeetingKind('https://oud.example.nl/ResoFly-AbCdEfGhJkMnPq').kind, 'jitsi');
  assert.equal(detectMeetingKind('https://oud.example.nl/ResoFly-kort').kind, 'other');
});

test('het serveradres wordt een nette https-basis', () => {
  assert.equal(normalizeJitsiBaseUrl('meet.example.nl'), 'https://meet.example.nl');
  assert.equal(normalizeJitsiBaseUrl('  https://Meet.Example.NL/  '), 'https://meet.example.nl');
  assert.equal(normalizeJitsiBaseUrl('https://meet.example.nl:8443'), 'https://meet.example.nl:8443');
  assert.equal(normalizeJitsiBaseUrl('https://8x8.vc/vpaas-magic-cookie-abc/'), 'https://8x8.vc/vpaas-magic-cookie-abc');
  // Leeg is geen fout: dan geldt de openbare server.
  assert.equal(normalizeJitsiBaseUrl(''), null);
  assert.equal(normalizeJitsiBaseUrl(null), null);
  // Geen http (de browser geeft camera en microfoon dan niet vrij), geen rommel.
  assert.equal(normalizeJitsiBaseUrl('http://meet.example.nl'), null);
  assert.equal(normalizeJitsiBaseUrl('javascript:alert(1)'), null);
  assert.equal(normalizeJitsiBaseUrl('https://user:pw@meet.example.nl'), null);
  assert.equal(normalizeJitsiBaseUrl('https://meet.example.nl/?x=1'), null);
  assert.equal(normalizeJitsiBaseUrl('https://meet.example.nl/#kamer'), null);
  assert.equal(normalizeJitsiBaseUrl('localhost'), null);
  // Een volledige vergaderlink is geen serveradres.
  assert.equal(normalizeJitsiBaseUrl('https://meet.example.nl/tenant/kamer'), null);
  assert.equal(normalizeJitsiBaseUrl(`https://${'a'.repeat(200)}.nl`), null);
});

test('zonder (geldige) instelling geldt meet.jit.si', () => {
  assert.equal(jitsiBaseUrl(null), DEFAULT_JITSI_BASE_URL);
  assert.equal(jitsiBaseUrl('http://onveilig.example.nl'), DEFAULT_JITSI_BASE_URL);
  assert.equal(jitsiBaseUrl('meet.example.nl'), 'https://meet.example.nl');
  assert.equal(usesPublicJitsi(null), true);
  assert.equal(usesPublicJitsi('https://meet.jit.si/'), true);
  assert.equal(usesPublicJitsi('meet.example.nl'), false);
  assert.equal(jitsiServerLabel(null), 'meet.jit.si');
  assert.equal(jitsiServerLabel('https://8x8.vc/vpaas-magic-cookie-abc'), '8x8.vc/vpaas-magic-cookie-abc');
});

test('kamernamen zijn onraadbaar en zonder verwarrende tekens', () => {
  const names = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const name = jitsiRoomName();
    assert.match(name, /^ResoFly-[a-km-zA-HJ-NP-Z2-9]{14}$/);
    names.add(name);
  }
  assert.equal(names.size, 500);
});

test('een vergaderlink is basis plus kamer, en wordt als Jitsi herkend', () => {
  const url = jitsiMeetingUrl('meet.example.nl');
  assert.match(url, /^https:\/\/meet\.example\.nl\/ResoFly-[A-Za-z0-9]{14}$/);
  assert.equal(detectMeetingKind(url).kind, 'jitsi');
  assert.match(jitsiMeetingUrl(), /^https:\/\/meet\.jit\.si\/ResoFly-/);
});

test('boekingslink: twee velden worden één keuze, en weer terug', () => {
  // Bestaande links (van vóór Jitsi) houden wat ze deden.
  assert.equal(bookingVideoFromLink(true, 'calendar', 'google'), 'calendar');
  assert.equal(bookingVideoFromLink(true, undefined, 'microsoft'), 'calendar');
  // Op een ResoFly-agenda maakte 'calendar' nooit iets aan: dat is "geen".
  assert.equal(bookingVideoFromLink(true, 'calendar', 'native'), 'none');
  assert.equal(bookingVideoFromLink(false, 'jitsi', 'google'), 'none');
  assert.equal(bookingVideoFromLink(true, 'jitsi', 'native'), 'jitsi');
  // Nieuw: wat de agenda kan, anders Jitsi.
  assert.equal(defaultBookingVideo('google'), 'calendar');
  assert.equal(defaultBookingVideo('native'), 'jitsi');
  // Gewisseld naar een ResoFly-agenda met Meet gekozen: dan Jitsi.
  assert.equal(effectiveBookingVideo('calendar', 'native'), 'jitsi');
  assert.deepEqual(bookingVideoFields('calendar', 'native'), { autoConference: true, conferenceProvider: 'jitsi' });
  assert.deepEqual(bookingVideoFields('calendar', 'google'), { autoConference: true, conferenceProvider: 'calendar' });
  assert.deepEqual(bookingVideoFields('jitsi', 'microsoft'), { autoConference: true, conferenceProvider: 'jitsi' });
  assert.deepEqual(bookingVideoFields('none', 'google'), { autoConference: false, conferenceProvider: 'calendar' });
});
