/**
 * De regels van het koppelen van een Google- of Microsoft-agenda
 * (calendarOAuth.ts). Draaien met:  npm test
 *
 * Wat hier fout kan gaan, raakt meteen de beveiliging: een terugkeeradres naar
 * een vreemde site levert iemand andermans code op, een state die te lang
 * geldig is of niet ondertekend, laat koppelen voor een ander. En wat de
 * gebruiker leest bij een fout, mag nooit uit het adres zelf komen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALENDAR_OAUTH_ERROR_CODES,
  OAUTH_STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  checkOAuthState,
  classifyProviderError,
  classifyTokenFailure,
  fallbackReturnTo,
  missingCalendarCapabilities,
  parseReturnOrigins,
  sanitizeReturnTo,
  signOAuthState,
  tokenFailureMessage,
  withReturnParams,
  type OAuthState,
} from './calendarOAuth.ts';
import { CALENDAR_OAUTH_ERROR_CODES as APP_CODES } from '../../../src/lib/calendarConnection.ts';

const SECRET = 'geheim-voor-de-test-van-de-agendakoppeling';
const APP = 'https://app.resofly.test';
const ORIGINS = [APP];
const NOW = 1_800_000_000;

function state(overrides: Partial<OAuthState> = {}): OAuthState {
  return {
    provider: 'google',
    userId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
    returnTo: `${APP}/`,
    nonce: '33333333-3333-4333-8333-333333333333',
    iat: NOW,
    exp: NOW + OAUTH_STATE_TTL_SECONDS,
    ...overrides,
  };
}

// ── Terugkeeradres ──────────────────────────────────────────────────────────

test('terugkeeradres: alleen de app zelf en de Cloudflare-previews van ResoFly', () => {
  assert.equal(sanitizeReturnTo(`${APP}/#calendar-connections`, ORIGINS), `${APP}/#calendar-connections`);
  assert.equal(sanitizeReturnTo('https://feature-x.resofly.pages.dev/', ORIGINS), 'https://feature-x.resofly.pages.dev/');
  assert.throws(() => sanitizeReturnTo('https://kwaadwillend.example/', ORIGINS), /niet toegestaan/);
  assert.throws(() => sanitizeReturnTo('https://resofly.pages.dev.kwaadwillend.example/', ORIGINS), /niet toegestaan/);
  assert.throws(() => sanitizeReturnTo('http://feature-x.resofly.pages.dev/', ORIGINS), /niet toegestaan/);
  assert.throws(() => sanitizeReturnTo('javascript:alert(1)', ORIGINS), /Ongeldig/);
  assert.throws(() => sanitizeReturnTo('geen adres', ORIGINS), /Ongeldig/);
});

test('terugkeeradres: zonder ingestelde origins alleen lokaal (eerst mocht dan elk adres)', () => {
  assert.equal(sanitizeReturnTo('http://localhost:5173/', []), 'http://localhost:5173/');
  assert.throws(() => sanitizeReturnTo('https://kwaadwillend.example/', []), /niet toegestaan/);
  assert.equal(sanitizeReturnTo('', []), 'http://localhost:5173/');
  assert.equal(sanitizeReturnTo('', ORIGINS), `${APP}/`);
});

test('terugkeeradres: geen inloggegevens en geen oude koppelparameters erin', () => {
  assert.equal(sanitizeReturnTo(`https://iemand:wachtwoord@app.resofly.test/`, ORIGINS), `${APP}/`);
  const schoon = sanitizeReturnTo(`${APP}/?tab=agenda&calendar_code=oud&calendar_error=geweigerd`, ORIGINS);
  assert.equal(schoon, `${APP}/?tab=agenda`);
});

test('origins uit de instelling: genormaliseerd, "*" en "null" tellen niet', () => {
  assert.deepEqual(parseReturnOrigins('https://App.ResoFly.test/, http://localhost:5173 ,*,null,ftp://x.test'), ['https://app.resofly.test', 'http://localhost:5173']);
  assert.deepEqual(parseReturnOrigins(undefined), []);
  assert.equal(fallbackReturnTo(ORIGINS), `${APP}/`);
  assert.equal(fallbackReturnTo([]), null);
});

test('de callback zet parameters netjes in het adres, ook naast een #', () => {
  assert.equal(withReturnParams(`${APP}/#x`, { calendar_error: 'geweigerd' }), `${APP}/?calendar_error=geweigerd#x`);
});

// ── State ───────────────────────────────────────────────────────────────────

test('state: ondertekend heen, ongeschonden terug', async () => {
  const raw = await signOAuthState(state(), SECRET);
  const check = await checkOAuthState(raw, SECRET, ORIGINS, NOW + 60);
  assert.equal(check.ok, true);
  assert.equal(check.ok && check.state.userId, state().userId);
});

test('state: geknoeid, verkeerd geheim of rommel is ongeldig', async () => {
  const raw = await signOAuthState(state(), SECRET);
  const [payload, signature] = raw.split('.');
  const anderePayload = Buffer.from(JSON.stringify(state({ userId: '44444444-4444-4444-8444-444444444444' }))).toString('base64url');
  for (const kapot of [
    `${anderePayload}.${signature}`,
    `${payload}.${signature.slice(0, -2)}xx`,
    `${payload}`,
    `${payload}.${signature}.extra`,
    '',
    'x'.repeat(5000),
  ]) {
    const check = await checkOAuthState(kapot, SECRET, ORIGINS, NOW);
    assert.deepEqual(check, { ok: false, reason: 'ongeldig' }, kapot.slice(0, 40));
  }
  assert.deepEqual(await checkOAuthState(raw, 'ander-geheim', ORIGINS, NOW), { ok: false, reason: 'ongeldig' });
  assert.deepEqual(await checkOAuthState(raw, '', ORIGINS, NOW), { ok: false, reason: 'ongeldig' });
  assert.deepEqual(await checkOAuthState(null, SECRET, ORIGINS, NOW), { ok: false, reason: 'ongeldig' });
});

test('state: verlopen komt mét inhoud terug, zodat de callback netjes terug kan', async () => {
  const raw = await signOAuthState(state(), SECRET);
  const check = await checkOAuthState(raw, SECRET, ORIGINS, NOW + OAUTH_STATE_TTL_SECONDS + 1);
  assert.equal(check.ok, false);
  assert.equal(!check.ok && check.reason, 'verlopen');
  assert.equal(!check.ok && check.reason === 'verlopen' && check.state.returnTo, `${APP}/`);
});

test('state: dertig minuten is genoeg voor inloggen met tweestaps, en niet langer', async () => {
  assert.equal(OAUTH_STATE_TTL_SECONDS, 30 * 60);
  const traag = await checkOAuthState(await signOAuthState(state(), SECRET), SECRET, ORIGINS, NOW + 25 * 60);
  assert.equal(traag.ok, true);
  const teLang = await signOAuthState(state({ exp: NOW + 24 * 3600 }), SECRET);
  assert.deepEqual(await checkOAuthState(teLang, SECRET, ORIGINS, NOW), { ok: false, reason: 'ongeldig' });
  const toekomst = await signOAuthState(state({ iat: NOW + 3600, exp: NOW + 3600 + 600 }), SECRET);
  assert.deepEqual(await checkOAuthState(toekomst, SECRET, ORIGINS, NOW), { ok: false, reason: 'ongeldig' });
});

test('state: velden worden streng gecontroleerd', async () => {
  for (const kapot of [
    state({ provider: 'apple' as never }),
    state({ userId: 'iemand' }),
    state({ organizationId: '' }),
    state({ nonce: 'abc' }),
    state({ iat: 1.5 }),
    state({ exp: -1 }),
  ]) {
    const raw = await signOAuthState(kapot, SECRET);
    assert.deepEqual(await checkOAuthState(raw, SECRET, ORIGINS, NOW), { ok: false, reason: 'ongeldig' });
  }
});

test('state: een terugkeeradres dat (inmiddels) niet mag, maakt de state ongeldig', async () => {
  const raw = await signOAuthState(state({ returnTo: 'https://kwaadwillend.example/' }), SECRET);
  assert.deepEqual(await checkOAuthState(raw, SECRET, ORIGINS, NOW), { ok: false, reason: 'ongeldig' });
});

// ── De toestemmingslink ─────────────────────────────────────────────────────

test('Google: accountkeuze bij koppelen, het bekende account bij opnieuw koppelen', () => {
  const nieuw = new URL(buildAuthorizeUrl({ provider: 'google', clientId: 'cid', redirectUri: 'https://fn.test/cb', state: 's', microsoftTenant: 'common' }));
  assert.equal(nieuw.origin, 'https://accounts.google.com');
  assert.equal(nieuw.searchParams.get('prompt'), 'select_account consent');
  assert.equal(nieuw.searchParams.get('access_type'), 'offline');
  assert.equal(nieuw.searchParams.get('login_hint'), null);
  assert.match(nieuw.searchParams.get('scope') ?? '', /calendar\.events/);
  const opnieuw = new URL(buildAuthorizeUrl({ provider: 'google', clientId: 'cid', redirectUri: 'https://fn.test/cb', state: 's', microsoftTenant: 'common', loginHint: 'jan@bedrijf.nl' }));
  assert.equal(opnieuw.searchParams.get('prompt'), 'consent', 'zonder consent geen vernieuwtoken');
  assert.equal(opnieuw.searchParams.get('login_hint'), 'jan@bedrijf.nl');
});

test('Microsoft: accountkiezer, tenant uit de instelling, en geen rommel als hint', () => {
  const url = new URL(buildAuthorizeUrl({ provider: 'microsoft', clientId: 'cid', redirectUri: 'https://fn.test/cb', state: 's', microsoftTenant: 'organizations' }));
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.match(url.searchParams.get('scope') ?? '', /offline_access/);
  const rommel = new URL(buildAuthorizeUrl({ provider: 'microsoft', clientId: 'cid', redirectUri: 'https://fn.test/cb', state: 's', microsoftTenant: 'common', loginHint: 'geen adres' }));
  assert.equal(rommel.searchParams.get('login_hint'), null);
  assert.equal(rommel.searchParams.get('prompt'), 'select_account');
});

// ── Rechten ─────────────────────────────────────────────────────────────────

test('Google: zonder agenda-vinkjes geen koppeling; contacten zijn optioneel', () => {
  const g = 'https://www.googleapis.com/auth/';
  assert.deepEqual(missingCalendarCapabilities('google', ['openid', `${g}calendar.events`, `${g}calendar.calendarlist.readonly`]), []);
  assert.deepEqual(missingCalendarCapabilities('google', ['openid', `${g}calendar`]), [], 'de oude brede scope geeft alles');
  assert.deepEqual(missingCalendarCapabilities('google', ['openid', `${g}contacts.readonly`]), ['agendalijst', 'afspraken']);
  assert.deepEqual(missingCalendarCapabilities('google', [`${g}calendar.calendarlist.readonly`]), ['afspraken']);
});

test('Microsoft: Calendars.ReadWrite, ook als volledige URI', () => {
  assert.deepEqual(missingCalendarCapabilities('microsoft', ['https://graph.microsoft.com/Calendars.ReadWrite', 'User.Read']), []);
  assert.deepEqual(missingCalendarCapabilities('microsoft', ['calendars.readwrite.shared']), []);
  assert.deepEqual(missingCalendarCapabilities('microsoft', ['User.Read', 'Calendars.Read']), ['agendalijst', 'afspraken']);
});

// ── Fouten ──────────────────────────────────────────────────────────────────

test('fouten van de provider worden vaste codes; de app kent elke code', () => {
  assert.deepEqual([...APP_CODES], [...CALENDAR_OAUTH_ERROR_CODES]);
  assert.equal(classifyProviderError('access_denied'), 'geweigerd');
  assert.equal(classifyProviderError('access_denied', 'AADSTS65004: User declined to consent'), 'geweigerd');
  assert.equal(classifyProviderError('access_denied', null, 'cancel'), 'geweigerd');
  assert.equal(classifyProviderError('access_denied', 'AADSTS65001: The user or administrator has not consented'), 'beheerder');
  assert.equal(classifyProviderError('consent_required'), 'beheerder');
  assert.equal(classifyProviderError('admin_policy_enforced'), 'beheerder');
  assert.equal(classifyProviderError('temporarily_unavailable'), 'storing');
  assert.equal(classifyProviderError('<script>'), 'mislukt');
  for (const code of ['access_denied', 'consent_required', 'server_error', 'iets']) {
    assert.ok((CALENDAR_OAUTH_ERROR_CODES as readonly string[]).includes(classifyProviderError(code)));
  }
});

test('mislukte tokenvernieuwing: ingetrokken, instelling of storing', () => {
  // Precies wat Google op staging teruggaf: invalid_grant met "Bad Request".
  assert.equal(classifyTokenFailure(400, { error: 'invalid_grant', error_description: 'Bad Request' }), 'ingetrokken');
  assert.equal(classifyTokenFailure(400, { error: 'interaction_required' }), 'ingetrokken');
  assert.equal(classifyTokenFailure(401, { error: 'invalid_client' }), 'instelling');
  assert.equal(classifyTokenFailure(503, {}), 'tijdelijk');
  assert.equal(classifyTokenFailure(429, {}), 'tijdelijk');
  assert.equal(classifyTokenFailure(0, null), 'tijdelijk');
  assert.match(tokenFailureMessage('google', 'ingetrokken'), /Koppel het account opnieuw/);
  assert.match(tokenFailureMessage('microsoft', 'instelling', 'invalid_client'), /beheerder.*|invalid_client/);
  assert.doesNotMatch(tokenFailureMessage('google', 'ingetrokken'), /Bad Request/);
});
