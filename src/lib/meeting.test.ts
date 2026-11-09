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
  connectionMeetingState,
  meetingModeOf,
  meetingUrlToKeep,
  normalizeJitsiBaseUrl,
  usesPublicJitsi,
  videoFieldsForSave,
  videoServiceOptions,
} from './meeting.ts';
import type { VideoServices } from '../types.ts';

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

// ── Google Meet en Teams ────────────────────────────────────────────────────

const MEET = 'https://meet.google.com/abc-defg-hij';
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0';
const JITSI = 'https://meet.jit.si/ResoFly-AbCdEfGhJkMnPq';
const status = (google: string, teams: string) => ({
  google_meet: { state: google, account: null, connectionId: null },
  teams: { state: teams, account: null, connectionId: null },
}) as unknown as VideoServices;

test('Meet/Teams-keuzes: van de agenda, los met je eigen koppeling, of nog aanzetten', () => {
  // Een Google-agenda maakt Meet zelf; Teams kan er los bij als je dat aanzette.
  const google = videoServiceOptions('google', null, status('geen_koppeling', 'klaar'));
  assert.deepEqual(google.google_meet, { available: true, how: 'calendar', hint: null });
  assert.deepEqual(google.teams, { available: true, how: 'standalone', hint: null });
  // In de ResoFly-agenda: alleen los, en een tip als de toestemming nog ontbreekt.
  const native = videoServiceOptions('native', null, status('toestemming', 'geen_koppeling'));
  assert.equal(native.google_meet.available, false);
  assert.match(native.google_meet.hint ?? '', /Instellingen → Agenda, bij je Google-account/);
  assert.deepEqual(native.teams, { available: false, how: null, hint: null });
  // Een privé-Microsoftaccount maakt geen Teams, ook niet los.
  const outlook = videoServiceOptions('microsoft', [], status('klaar', 'klaar'));
  assert.equal(outlook.teams.available, false);
  assert.match(outlook.teams.hint ?? '', /werk- of schoolaccount/);
  assert.equal(outlook.google_meet.how, 'standalone');
  // Een oudere server zonder videoServices: zoals eerst, alleen wat de agenda kan.
  const oud = videoServiceOptions('microsoft', null, undefined);
  assert.equal(oud.teams.available, true);
  assert.equal(oud.google_meet.available, false);
});

test('de keuze bij een bestaande afspraak', () => {
  const beide = { google_meet: true, teams: true };
  assert.equal(meetingModeOf(MEET, beide), 'google_meet');
  assert.equal(meetingModeOf(TEAMS, beide), 'teams');
  // Kan Meet hier niet (geen koppeling), dan is een geplakte Meet-link gewoon een eigen link.
  assert.equal(meetingModeOf(MEET, { google_meet: false, teams: false }), 'link');
  assert.equal(meetingModeOf(JITSI, beide), 'jitsi');
  assert.equal(meetingModeOf('https://zoom.us/j/1', beide), 'link');
  assert.equal(meetingModeOf('', beide), 'none');
  // Google maakt de Meet nog (nog geen link): toch al Meet.
  assert.equal(meetingModeOf(null, beide, null, { service: 'google_meet', url: null }), 'google_meet');
});

test('opslaan: de vergadering van de agenda blijft, en komt niet in de omschrijving', () => {
  const meetVanAgenda = { service: 'google_meet' as const, url: MEET };
  // Niets veranderd aan de video: niets meesturen over Meet.
  assert.deepEqual(videoFieldsForSave('google_meet', MEET, meetVanAgenda), { meetingUrl: null });
  // Overstappen naar Jitsi of "Geen": de Meet gaat eraf.
  assert.deepEqual(videoFieldsForSave('jitsi', JITSI, meetVanAgenda), { meetingUrl: JITSI, removeConference: true });
  assert.deepEqual(videoFieldsForSave('none', '', meetVanAgenda), { meetingUrl: null, removeConference: true });
  assert.deepEqual(videoFieldsForSave('teams', '', meetVanAgenda), { meetingUrl: null, videoService: 'teams', removeConference: true });
  // Nieuw gekozen: de server maakt hem.
  assert.deepEqual(videoFieldsForSave('google_meet', '', null), { meetingUrl: null, videoService: 'google_meet' });
  // Een losse Meet-link die er al staat (ResoFly-agenda): die blijft.
  assert.deepEqual(videoFieldsForSave('google_meet', MEET, null), { meetingUrl: MEET });
  // Een Zoom-add-on van Google, ongewijzigd: niets doen (geen dubbele regel).
  const zoom = { service: 'other' as const, url: 'https://zoom.us/j/1' };
  assert.deepEqual(videoFieldsForSave('link', 'https://zoom.us/j/1', zoom), { meetingUrl: null });
  assert.deepEqual(videoFieldsForSave('link', ' https://example.com/x ', null), { meetingUrl: 'https://example.com/x' });
});

test('verplaatsen: alleen een link uit de omschrijving gaat mee', () => {
  assert.equal(meetingUrlToKeep(MEET, { service: 'google_meet', url: MEET }), null);
  assert.equal(meetingUrlToKeep(JITSI, { service: 'google_meet', url: MEET }), JITSI);
  assert.equal(meetingUrlToKeep(JITSI, null), JITSI);
  assert.equal(meetingUrlToKeep(null, null), null);
});

test('boekingslink: Google Meet of Teams per boeking', () => {
  assert.equal(bookingVideoFromLink(true, 'google_meet', 'native'), 'google_meet');
  assert.equal(bookingVideoFromLink(true, 'teams', 'google'), 'teams');
  // Meet op een Google-agenda is gewoon "van de agenda".
  assert.equal(bookingVideoFromLink(true, 'google_meet', 'google'), 'calendar');
  assert.equal(effectiveBookingVideo('teams', 'microsoft'), 'calendar');
  assert.deepEqual(bookingVideoFields('google_meet', 'native'), { autoConference: true, conferenceProvider: 'google_meet' });
  assert.deepEqual(bookingVideoFields('teams', 'microsoft'), { autoConference: true, conferenceProvider: 'calendar' });
});

test('per account: Meet/Teams buiten de agenda aan, uit, of kan dit account niet', () => {
  assert.equal(connectionMeetingState('google', ['openid', 'https://www.googleapis.com/auth/meetings.space.created'], [['hangoutsMeet']]), 'aan');
  assert.equal(connectionMeetingState('google', ['openid'], [null]), 'uit');
  assert.equal(connectionMeetingState('microsoft', ['https://graph.microsoft.com/OnlineMeetings.ReadWrite'], [['teamsForBusiness']]), 'aan');
  // Een privé-Microsoftaccount: geen Teams, dus ook geen knop om het aan te zetten.
  assert.equal(connectionMeetingState('microsoft', ['User.Read'], [[], ['skypeForConsumer']]), 'kan_niet');
  assert.equal(connectionMeetingState('native', [], []), null);
});
