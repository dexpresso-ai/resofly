/**
 * Tests voor de videocall-regel in de omschrijving van Google/Microsoft-items
 * (meetingLinks.ts). Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleConferenceUrl, readMeetingUrl, sanitizeMeetingUrl, stripMeetingLine, withMeetingLine } from './meetingLinks.ts';

const JITSI = 'https://meet.jit.si/ResoFly-AbCdEfGhJkMnPq';
const MEET = 'https://meet.google.com/abc-defg-hij';
const TEAMS = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_${'x'.repeat(200)}%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d`;

test('alleen http(s), en niet eindeloos lang', () => {
  assert.equal(sanitizeMeetingUrl(` ${JITSI} `), JITSI);
  assert.equal(sanitizeMeetingUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeMeetingUrl(`https://x.nl/${'a'.repeat(2048)}`), null);
  assert.equal(sanitizeMeetingUrl(null), null);
});

test('de regel onderaan (Google) en bovenaan (Microsoft)', () => {
  assert.equal(withMeetingLine('Agenda', JITSI), `Agenda\n\n🎥 Videocall: ${JITSI}`);
  assert.equal(withMeetingLine('Agenda', JITSI, 'start'), `🎥 Videocall: ${JITSI}\n\nAgenda`);
  assert.equal(withMeetingLine(null, JITSI, 'start'), `🎥 Videocall: ${JITSI}`);
  assert.equal(withMeetingLine('Agenda', null), 'Agenda');
  // Opnieuw opslaan stapelt geen regels, ook niet als de plek wisselt.
  const once = withMeetingLine('Agenda', JITSI, 'start');
  assert.equal(withMeetingLine(once, JITSI, 'start'), once);
  assert.equal(withMeetingLine(withMeetingLine('Agenda', MEET), JITSI, 'start'), `🎥 Videocall: ${JITSI}\n\nAgenda`);
  // Link weghalen haalt de regel weg, waar hij ook stond.
  assert.equal(withMeetingLine(once, null, 'start'), 'Agenda');
  assert.equal(stripMeetingLine(`Agenda\n\n🎥 Videocall: ${JITSI}`), 'Agenda');
  assert.equal(stripMeetingLine(`🎥 Videocall: ${JITSI}`), null);
});

test('Microsoft: de link bovenaan overleeft een lange omschrijving in bodyPreview', () => {
  const long = 'Bespreekpunten: '.repeat(30);
  const body = withMeetingLine(long, JITSI, 'start')!;
  // Graph knipt de preview af op 255 tekens en maakt van regelafstanden spaties.
  const preview = body.replace(/\s+/g, ' ').slice(0, 255);
  assert.equal(readMeetingUrl(null, preview, null), JITSI);
  assert.equal(stripMeetingLine(preview)!.startsWith('Bespreekpunten:'), true);
  // Onderaan zou hij in de preview zijn weggevallen.
  const oldPreview = withMeetingLine(long, JITSI)!.slice(0, 255);
  assert.equal(readMeetingUrl(null, oldPreview, null), null);
});

test('omgezet van Meet of Teams naar Jitsi: de Jitsi-link wint', () => {
  assert.equal(readMeetingUrl(MEET, `Agenda\n\n🎥 Videocall: ${JITSI}`, null), JITSI);
  assert.equal(readMeetingUrl(TEAMS, `🎥 Videocall: ${JITSI} Agenda`, null), JITSI);
});

test('dezelfde dienst in de regel als in de conferentie: de conferentie geldt', () => {
  // Bij bewerken in ResoFly wordt de Meet-link meegeschreven…
  assert.equal(readMeetingUrl(MEET, `Agenda\n\n🎥 Videocall: ${MEET}`, null), MEET);
  // …en een Teams-link is in de preview van 255 tekens vaak afgekapt.
  const cut = `🎥 Videocall: ${TEAMS}`.slice(0, 255);
  assert.equal(readMeetingUrl(TEAMS, cut, null), TEAMS);
});

test('zonder eigen regel: conferentie, dan een losse bekende link', () => {
  assert.equal(readMeetingUrl(MEET, 'Agenda', null), MEET);
  assert.equal(readMeetingUrl(null, `Inbellen via ${JITSI} graag`, null), JITSI);
  assert.equal(readMeetingUrl(null, null, `${JITSI}`), JITSI);
  assert.equal(readMeetingUrl(null, 'https://8x8.vc/vpaas-magic-cookie-1/Kamer', null), 'https://8x8.vc/vpaas-magic-cookie-1/Kamer');
  assert.equal(readMeetingUrl(null, 'Gewoon tekst met https://example.com', null), null);
});

test('Google conferenceData', () => {
  assert.equal(googleConferenceUrl({ hangoutLink: MEET }), MEET);
  assert.equal(googleConferenceUrl({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+31' }, { entryPointType: 'video', uri: MEET }] } }), MEET);
  assert.equal(googleConferenceUrl({}), null);
});
