/**
 * Tests voor de regels van Google Meet en Teams bij een afspraak
 * (conference.ts). Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountSupportsService,
  calendarConferenceService,
  classifyMeetingFailure,
  createdMeetingUrl,
  defaultVideoService,
  googleCalendarConferenceTypes,
  googleEventConference,
  isGoogleMeetUrl,
  isTeamsUrl,
  meetingFailureMessage,
  microsoftCalendarConferenceTypes,
  microsoftEventConference,
  parseVideoRequest,
  pickMeetingConnection,
  planVideo,
  serviceOfUrl,
  videoServiceStateMessage,
} from './conference.ts';
import { GOOGLE_MEET_SCOPE } from './calendarOAuth.ts';

const MEET = 'https://meet.google.com/abc-defg-hij';
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d';
const JITSI = 'https://meet.jit.si/ResoFly-AbCdEfGhJkMnPq';

test('Meet- en Teams-links herkennen, alleen via https en de echte hosts', () => {
  assert.equal(isGoogleMeetUrl(MEET), true);
  assert.equal(isGoogleMeetUrl('http://meet.google.com/abc-defg-hij'), false);
  assert.equal(isGoogleMeetUrl('https://meet.google.com.example.nl/x'), false);
  assert.equal(isTeamsUrl(TEAMS), true);
  assert.equal(isTeamsUrl('https://teams.live.com/meet/9876543210'), true);
  assert.equal(isTeamsUrl('https://gov.teams.microsoft.com/l/x'), true);
  assert.equal(isTeamsUrl('https://teams.microsoft.com.evil.example/l/x'), false);
  assert.equal(serviceOfUrl(JITSI), null);
  assert.equal(serviceOfUrl('javascript:alert(1)'), null);
});

test('een gemaakte vergadering: alleen een echte link van díe dienst telt', () => {
  assert.equal(createdMeetingUrl('google_meet', { name: 'spaces/x', meetingUri: MEET }), MEET);
  assert.equal(createdMeetingUrl('teams', { joinWebUrl: TEAMS }), TEAMS);
  assert.equal(createdMeetingUrl('teams', { joinUrl: TEAMS }), TEAMS);
  // Een andere dienst, een vreemde link of niets: geen link.
  assert.equal(createdMeetingUrl('google_meet', { meetingUri: TEAMS }), null);
  assert.equal(createdMeetingUrl('google_meet', { meetingUri: 'javascript:alert(1)' }), null);
  assert.equal(createdMeetingUrl('teams', { joinWebUrl: 'https://evil.example/teams.microsoft.com' }), null);
  assert.equal(createdMeetingUrl('google_meet', null), null);
});

test('wat een agenda zelf kan', () => {
  assert.deepEqual(googleCalendarConferenceTypes({ conferenceProperties: { allowedConferenceSolutionTypes: ['hangoutsMeet', 'hangoutsMeet', '<x>'] } }), ['hangoutsMeet']);
  assert.equal(googleCalendarConferenceTypes({}), null);
  assert.equal(googleCalendarConferenceTypes({ conferenceProperties: {} }), null);
  assert.deepEqual(microsoftCalendarConferenceTypes({ allowedOnlineMeetingProviders: ['teamsForBusiness'] }), ['teamsForBusiness']);
  // Een privé-account (outlook.com): geen Teams.
  assert.deepEqual(microsoftCalendarConferenceTypes({ allowedOnlineMeetingProviders: ['unknown'] }), []);
  assert.equal(microsoftCalendarConferenceTypes({}), null);

  assert.equal(calendarConferenceService('google', ['hangoutsMeet']), 'google_meet');
  assert.equal(calendarConferenceService('google', ['eventHangout']), null);
  assert.equal(calendarConferenceService('microsoft', ['teamsForBusiness', 'skypeForBusiness']), 'teams');
  assert.equal(calendarConferenceService('microsoft', ['skypeForConsumer']), null);
  // Onbekend = zoals het altijd werkte.
  assert.equal(calendarConferenceService('google', null), 'google_meet');
  assert.equal(calendarConferenceService('microsoft', undefined), 'teams');
  assert.equal(calendarConferenceService('native', null), null);
  assert.equal(calendarConferenceService('ics', ['hangoutsMeet']), null);
});

test('kan het account de dienst: ja, tenzij geen enkele agenda hem toelaat', () => {
  assert.equal(accountSupportsService('teams', [[], ['skypeForConsumer']]), false);
  assert.equal(accountSupportsService('teams', [[], null]), true);
  assert.equal(accountSupportsService('teams', [['teamsForBusiness']]), true);
  assert.equal(accountSupportsService('google_meet', []), true);
});

test('de Meet op een Google-afspraak teruglezen, ook als Google hem nog maakt', () => {
  assert.deepEqual(googleEventConference({ hangoutLink: MEET }), { service: 'google_meet', url: MEET, status: 'ready' });
  assert.deepEqual(googleEventConference({
    conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: MEET }] },
  }), { service: 'google_meet', url: MEET, status: 'ready' });
  assert.deepEqual(googleEventConference({
    conferenceData: { createRequest: { requestId: 'r', conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'pending' } } },
  }), { service: 'google_meet', url: null, status: 'pending' });
  assert.deepEqual(googleEventConference({
    conferenceData: { createRequest: { requestId: 'r', conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'failure' } } },
  }), { service: 'google_meet', url: null, status: 'failed' });
  // Een Zoom-add-on is geen Meet.
  assert.deepEqual(googleEventConference({
    conferenceData: { conferenceSolution: { key: { type: 'addOn' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/123' }] },
  }), { service: 'other', url: 'https://zoom.us/j/123', status: 'ready' });
  assert.equal(googleEventConference({ summary: 'Zonder vergadering' }), null);
  // Alleen een telefoonnummer: geen bruikbare videolink.
  assert.equal(googleEventConference({ conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+31201234567' }] } }), null);
});

test('Teams op een Microsoft-afspraak teruglezen', () => {
  assert.deepEqual(microsoftEventConference({ isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', onlineMeeting: { joinUrl: TEAMS } }),
    { service: 'teams', url: TEAMS, status: 'ready' });
  // Gevraagd, maar Microsoft maakte er geen (privé-account): mislukt.
  assert.deepEqual(microsoftEventConference({ isOnlineMeeting: true, onlineMeeting: null }), { service: 'other', url: null, status: 'failed' });
  assert.equal(microsoftEventConference({ isOnlineMeeting: false, onlineMeeting: null }), null);
});

test('de videovraag uit de invoer: wat er niet staat, verandert niet', () => {
  assert.equal(parseVideoRequest({ title: 'x' }).present, false);
  assert.equal(parseVideoRequest({ meetingUrl: null }).present, true);
  assert.equal(parseVideoRequest({ meetingUrl: undefined }).present, false);
  assert.equal(parseVideoRequest({ meetingUrl: 'javascript:alert(1)' }).meetingUrl, null);
  assert.equal(parseVideoRequest({ videoService: 'teams' }).videoService, 'teams');
  assert.equal(parseVideoRequest({ videoService: null }).videoService, null);
  assert.throws(() => parseVideoRequest({ videoService: 'zoom' }), /Onbekende videodienst/);
});

test('plan: de agenda maakt Meet/Teams zelf, elders los, en een bestaande link blijft', () => {
  const req = (input: Record<string, unknown>) => parseVideoRequest(input);
  // Bewerken zonder iets over video: alles laten staan. Nieuw: geen video.
  assert.deepEqual(planVideo('google', null, req({}), 'update'), { kind: 'keep' });
  assert.deepEqual(planVideo('google', null, req({}), 'create'), { kind: 'none' });
  // Meet op Google, Teams op Microsoft: van de agenda.
  assert.deepEqual(planVideo('google', ['hangoutsMeet'], req({ videoService: 'google_meet' }), 'create'), { kind: 'calendar', service: 'google_meet' });
  assert.deepEqual(planVideo('microsoft', null, req({ videoService: 'teams' }), 'create'), { kind: 'calendar', service: 'teams' });
  // De oude vorm doet hetzelfde.
  assert.deepEqual(planVideo('google', null, req({ addConference: true }), 'create'), { kind: 'calendar', service: 'google_meet' });
  // Kan de agenda het niet, dan een uitleg in plaats van een afspraak zonder link.
  assert.throws(() => planVideo('microsoft', [], req({ videoService: 'teams' }), 'create'), /werk- of schoolaccount/);
  assert.throws(() => planVideo('google', ['eventHangout'], req({ addConference: true }), 'create'), /Google Meet uit/);
  // In de ResoFly-agenda, of Teams op een Google-agenda: los.
  assert.deepEqual(planVideo('native', null, req({ videoService: 'google_meet' }), 'create'), { kind: 'standalone', service: 'google_meet' });
  assert.deepEqual(planVideo('google', null, req({ videoService: 'teams' }), 'update'), { kind: 'standalone', service: 'teams' });
  // Staat er al een link van die dienst, dan geen tweede vergadering.
  assert.deepEqual(planVideo('native', null, req({ videoService: 'google_meet', meetingUrl: MEET }), 'update'), { kind: 'link', url: MEET });
  // Een link van een andere dienst telt niet als "al een vergadering".
  assert.deepEqual(planVideo('native', null, req({ videoService: 'google_meet', meetingUrl: JITSI }), 'update'), { kind: 'standalone', service: 'google_meet' });
  // De oude vorm op een agenda die zelf niets maakt: genegeerd, zoals altijd.
  assert.deepEqual(planVideo('native', null, req({ addConference: true, meetingUrl: JITSI }), 'create'), { kind: 'link', url: JITSI });
  assert.deepEqual(planVideo('native', null, req({ addConference: true }), 'create'), { kind: 'none' });
  // Een link, of uitdrukkelijk niets.
  assert.deepEqual(planVideo('microsoft', null, req({ meetingUrl: JITSI }), 'update'), { kind: 'link', url: JITSI });
  assert.deepEqual(planVideo('microsoft', null, req({ meetingUrl: null }), 'update'), { kind: 'none' });
});

test('standaard voor "een videocall": wat de agenda kan, anders Jitsi', () => {
  assert.equal(defaultVideoService('google', null), 'google_meet');
  assert.equal(defaultVideoService('microsoft', ['teamsForBusiness']), 'teams');
  assert.equal(defaultVideoService('microsoft', []), 'jitsi');
  assert.equal(defaultVideoService('native', null), 'jitsi');
});

test('welke koppeling een losse vergadering maakt', () => {
  const c = (id: string, provider: string, status: string, scopes: string[], created_at: string) => ({ id, provider, status, scopes, created_at });
  const zonder = c('a', 'google', 'active', ['openid'], '2026-01-01');
  const met = c('b', 'google', 'error', [GOOGLE_MEET_SCOPE], '2026-02-01');
  const ouderMet = c('c', 'google', 'active', [GOOGLE_MEET_SCOPE], '2025-12-01');
  const verlopen = c('d', 'google', 'expired', [GOOGLE_MEET_SCOPE], '2025-01-01');
  const ingetrokken = c('e', 'google', 'revoked', [GOOGLE_MEET_SCOPE], '2024-01-01');
  const ms = c('f', 'microsoft', 'active', ['https://graph.microsoft.com/OnlineMeetings.ReadWrite'], '2026-01-01');

  assert.deepEqual(pickMeetingConnection('google_meet', [zonder, met, ouderMet]), { state: 'klaar', connection: ouderMet });
  assert.deepEqual(pickMeetingConnection('google_meet', [zonder, met]), { state: 'klaar', connection: met });
  assert.deepEqual(pickMeetingConnection('google_meet', [zonder]), { state: 'toestemming', connection: zonder });
  assert.deepEqual(pickMeetingConnection('google_meet', [zonder], () => false), { state: 'account', connection: zonder });
  assert.deepEqual(pickMeetingConnection('google_meet', [verlopen, ingetrokken]), { state: 'verlopen', connection: verlopen });
  assert.deepEqual(pickMeetingConnection('google_meet', [ingetrokken, ms]), { state: 'geen_koppeling', connection: null });
  // Microsoft geeft de scope als volledige URI.
  assert.deepEqual(pickMeetingConnection('teams', [ms]), { state: 'klaar', connection: ms });
});

test('fouten van de Meet API en Graph in gewone woorden', () => {
  const disabled = { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Meet REST API has not been used in project 123 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } };
  assert.equal(classifyMeetingFailure('google_meet', 403, disabled), 'uitgeschakeld');
  assert.equal(classifyMeetingFailure('google_meet', 403, { error: { message: 'Request had insufficient authentication scopes.', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }), 'toestemming');
  assert.equal(classifyMeetingFailure('google_meet', 403, { error: { message: 'The caller does not have permission' } }), 'account');
  assert.equal(classifyMeetingFailure('google_meet', 503, {}), 'tijdelijk');
  assert.equal(classifyMeetingFailure('google_meet', 0, null), 'tijdelijk');
  assert.equal(classifyMeetingFailure('teams', 403, { error: { code: 'Forbidden', message: 'Forbidden' } }), 'account');
  assert.equal(classifyMeetingFailure('teams', 401, { error: { code: 'InvalidAuthenticationToken' } }), 'toestemming');
  assert.equal(classifyMeetingFailure('teams', 400, { error: { code: 'BadRequest', message: 'This API is not supported for MSA accounts' } }), 'account');
  assert.equal(classifyMeetingFailure('teams', 429, {}), 'tijdelijk');
  assert.equal(classifyMeetingFailure('teams', 400, { error: { code: 'BadRequest', message: 'Invalid date' } }), 'mislukt');

  assert.match(meetingFailureMessage('google_meet', 'uitgeschakeld'), /Google Meet REST API aan in Google Cloud/);
  assert.match(meetingFailureMessage('teams', 'account'), /werk- of schoolaccount/);
  assert.match(videoServiceStateMessage('google_meet', 'toestemming'), /Instellingen → Agenda, bij je Google-account/);
  assert.equal(videoServiceStateMessage('teams', 'klaar'), '');
});
