/**
 * De terugkeer van een agendakoppeling in de app (calendarConnection.ts).
 * Draaien met:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_OAUTH_ERROR_CODES, calendarOAuthErrorText, connectionStatusView, parseCalendarOAuthReturn } from './calendarConnection.ts';

const APP = 'https://app.resofly.test';

test('code en state: afronden, en het adres is daarna schoon', () => {
  const { result, cleaned } = parseCalendarOAuthReturn(`${APP}/?calendar_code=abc&calendar_state=p.s#calendar-connections`);
  assert.deepEqual(result, { kind: 'code', code: 'abc', state: 'p.s' });
  assert.equal(cleaned, '/#calendar-connections');
});

test('een fout van de terugkeer komt in beeld (eerst bleef het stil)', () => {
  const { result, cleaned } = parseCalendarOAuthReturn(`${APP}/?tab=x&calendar_error=geweigerd&calendar_provider=microsoft`);
  assert.deepEqual(result, { kind: 'error', error: 'geweigerd', provider: 'microsoft' });
  assert.equal(cleaned, '/?tab=x');
});

test('alleen eigen teksten: wat er in het adres staat, wordt nooit getoond', () => {
  const { result } = parseCalendarOAuthReturn(`${APP}/?calendar_error=${encodeURIComponent('Bel 0900-1234 voor hulp')}&calendar_provider=evil`);
  assert.deepEqual(result, { kind: 'error', error: 'mislukt', provider: null });
  const tekst = calendarOAuthErrorText('mislukt', null);
  assert.doesNotMatch(tekst, /0900/);
});

test('geen koppelparameters: niets te doen, adres blijft staan', () => {
  assert.deepEqual(parseCalendarOAuthReturn(`${APP}/?tab=agenda`), { result: null, cleaned: null });
  assert.deepEqual(parseCalendarOAuthReturn('geen adres'), { result: null, cleaned: null });
});

test('alleen een code zonder state: niet afronden, wel het adres opschonen', () => {
  const { result, cleaned } = parseCalendarOAuthReturn(`${APP}/?calendar_code=abc`);
  assert.equal(result, null);
  assert.equal(cleaned, '/');
});

test('elke foutcode heeft een eigen, Nederlandse uitleg', () => {
  const teksten = new Set(CALENDAR_OAUTH_ERROR_CODES.map((code) => calendarOAuthErrorText(code, 'google')));
  assert.equal(teksten.size, CALENDAR_OAUTH_ERROR_CODES.length);
  assert.match(calendarOAuthErrorText('beheerder', 'microsoft'), /beheerder van je Microsoft-account/);
  assert.match(calendarOAuthErrorText('geweigerd', 'google'), /Google/);
});

test('status van een koppeling: in gewone woorden, met wat je kunt doen', () => {
  assert.deepEqual(connectionStatusView({ status: 'active', last_error: null, provider: 'google' }), { label: 'Actief', tone: 'ok', needsReconnect: false, hint: null });
  const verlopen = connectionStatusView({ status: 'expired', last_error: null, provider: 'google' });
  assert.equal(verlopen.label, 'Verlopen');
  assert.equal(verlopen.needsReconnect, true);
  assert.match(verlopen.hint ?? '', /Koppel het account opnieuw/);
  const fout = connectionStatusView({ status: 'error', last_error: 'Agenda "Werk": Not Found', provider: 'microsoft' });
  assert.equal(fout.label, 'Fout');
  assert.equal(fout.hint, 'Agenda "Werk": Not Found');
  assert.equal(connectionStatusView({ status: 'revoked', last_error: null, provider: 'google' }).label, 'Ingetrokken');
});
