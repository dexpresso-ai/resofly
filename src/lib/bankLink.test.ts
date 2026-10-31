/**
 * Tests voor de terugkeer van de bank en de staat van een toestemming, zoals de
 * app ze leest (bankLink.ts). Draaien met:  npm test
 *
 * De vergelijking met de serverkant staat in
 * supabase/functions/_shared/bankSync.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { consentState, isCancelledBankReturn, isSandboxLink, readBankReturn } from './bankLink.ts';

const STATE = '29dab87c-8de6-4c5d-b70c-04cb5dfa4289';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-30T12:00:00Z');

test('terug van de bank: gelukt, afgebroken, of niet van ons', () => {
  assert.deepEqual(readBankReturn(`?code=abc123&state=${STATE}`), { kind: 'code', code: 'abc123', state: STATE });
  assert.deepEqual(readBankReturn(`?error=access_denied&error_description=Geannuleerd&state=${STATE}`), {
    kind: 'error', state: STATE, error: 'access_denied', description: 'Geannuleerd',
  });
  assert.equal(readBankReturn(`?state=${STATE}`), null, 'state zonder code of error');
  // Een inloglink van Supabase heeft ook ?code= of ?error=access_denied — zonder onze state.
  assert.equal(readBankReturn('?code=pkce-code-van-supabase'), null);
  assert.equal(readBankReturn('?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid'), null);
  assert.equal(readBankReturn('?code=abc&state=xyz'), null, 'state is altijd onze UUID');
  assert.equal(readBankReturn(''), null);
  assert.equal(readBankReturn(`?code=abc&error=access_denied&state=${STATE}`)?.kind, 'code', 'een code wint');
});

test('afgebroken door de klant of geweigerd door de bank', () => {
  assert.equal(isCancelledBankReturn('access_denied'), true);
  assert.equal(isCancelledBankReturn('CANCELLED'), true);
  assert.equal(isCancelledBankReturn('server_error'), false);
  assert.equal(isCancelledBankReturn(''), false);
});

test('toestemming: verlopen, of over hoeveel dagen', () => {
  assert.deepEqual(consentState({ status: 'linked', expires_at: '2026-09-24T09:11:58Z' }, NOW), { expired: true, daysLeft: 0 });
  assert.deepEqual(consentState({ status: 'linked', expires_at: new Date(NOW + 10 * DAY).toISOString() }, NOW), { expired: false, daysLeft: 10 });
  assert.deepEqual(consentState({ status: 'linked', expires_at: new Date(NOW + 1).toISOString() }, NOW), { expired: false, daysLeft: 1 });
  assert.deepEqual(consentState({ status: 'expired', expires_at: new Date(NOW + 10 * DAY).toISOString() }, NOW), { expired: true, daysLeft: 0 });
  assert.deepEqual(consentState({ status: 'linked', expires_at: null }, NOW), { expired: false, daysLeft: null });
  assert.deepEqual(consentState(undefined, NOW), { expired: false, daysLeft: null });
});

test('testomgeving herkennen aan de toestemmingslink', () => {
  assert.equal(isSandboxLink('https://tilisy-sandbox.enablebanking.com/ais/start?sessionid=x'), true);
  assert.equal(isSandboxLink('https://tilisy.enablebanking.com/ais/start?sessionid=x'), false);
  assert.equal(isSandboxLink('https://sandbox.example.com/start'), true);
  assert.equal(isSandboxLink('https://sandboxed.example.com/start'), false);
  assert.equal(isSandboxLink('https://tilisy.enablebanking.com/?env=sandbox'), false, 'alleen de host telt');
  assert.equal(isSandboxLink('geen url'), false);
  assert.equal(isSandboxLink(null), false);
});
