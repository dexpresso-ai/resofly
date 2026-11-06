import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSenderAddress,
  cleanSenderName,
  formatFromHeader,
  isPlainEmailAddress,
  isValidSendingDomain,
  judgeDomainClaim,
  normalizeSendingDomainInput,
  sendingDomainStatus,
  UNVERIFIED_CLAIM_DAYS,
} from './resendDomains.ts';

const record = (kind: string, status: string) => ({ record: kind, status, name: 'x', type: 'TXT', value: 'v' });

test('status van Resend: verified, failed en nog niet klaar', () => {
  assert.equal(sendingDomainStatus('verified', []), 'verified');
  assert.equal(sendingDomainStatus('VERIFIED', undefined), 'verified');
  assert.equal(sendingDomainStatus('failed', [record('DKIM', 'failed')]), 'failed');
  for (const status of ['not_started', 'pending', '', null, 'iets_nieuws']) {
    assert.equal(sendingDomainStatus(status, [record('DKIM', 'pending'), record('SPF', 'pending')]), 'pending', String(status));
  }
});

test('gedeeltelijk geverifieerd: alleen versturen als SPF én DKIM kloppen', () => {
  const sendingOk = [record('DKIM', 'verified'), record('SPF', 'verified'), record('SPF', 'verified'), record('Tracking', 'pending')];
  assert.equal(sendingDomainStatus('partially_verified', sendingOk), 'verified');
  assert.equal(sendingDomainStatus('partially_failed', sendingOk), 'verified');
  // DKIM nog niet gevonden: wachten.
  assert.equal(sendingDomainStatus('partially_verified', [record('DKIM', 'pending'), record('SPF', 'verified')]), 'pending');
  // Zonder records weten we niets: niet als geverifieerd behandelen.
  assert.equal(sendingDomainStatus('partially_verified', []), 'pending');
  assert.equal(sendingDomainStatus('partially_verified', [record('SPF', 'verified')]), 'pending');
  assert.equal(sendingDomainStatus('partially_failed', [record('DKIM', 'failed'), record('SPF', 'verified')]), 'failed');
});

test('een record dat even niet gevonden wordt: tijdelijke fout', () => {
  assert.equal(sendingDomainStatus('partially_verified', [record('DKIM', 'temporary_failure'), record('SPF', 'verified')]), 'temporary_failure');
  assert.equal(sendingDomainStatus('temporary_failure', []), 'temporary_failure');
  // Zegt Resend zelf verified, dan volgen we Resend.
  assert.equal(sendingDomainStatus('verified', [record('DKIM', 'temporary_failure')]), 'verified');
});

test('domein uit het invoerveld', () => {
  assert.equal(normalizeSendingDomainInput(' Voorbeeld.NL '), 'voorbeeld.nl');
  assert.equal(normalizeSendingDomainInput('https://www.voorbeeld.nl/contact?x=1'), 'voorbeeld.nl');
  assert.equal(normalizeSendingDomainInput('voorbeeld.nl.'), 'voorbeeld.nl');
  assert.equal(normalizeSendingDomainInput('info@Voorbeeld.nl'), 'voorbeeld.nl');
  assert.equal(normalizeSendingDomainInput('mail.voorbeeld.nl:443'), 'mail.voorbeeld.nl');
  assert.equal(normalizeSendingDomainInput('bücher.nl'), 'xn--bcher-kva.nl');
  assert.equal(normalizeSendingDomainInput(''), '');
  assert.equal(normalizeSendingDomainInput('twee woorden.nl'), '');
});

test('geldige domeinen', () => {
  for (const domain of ['voorbeeld.nl', 'mail.voorbeeld.nl', 'a-b.co.uk', 'xn--bcher-kva.nl', 'voorbeeld.xn--p1ai']) {
    assert.equal(isValidSendingDomain(domain), true, domain);
  }
  for (const domain of ['nl', 'voorbeeld', '-voorbeeld.nl', 'voorbeeld-.nl', 'voor_beeld.nl', 'voorbeeld.n', 'voorbeeld.123', '']) {
    assert.equal(isValidSendingDomain(domain), false, domain);
  }
});

test('afzenderadres: kaal, op het eigen domein, zonder tekens die een header breken', () => {
  assert.deepEqual(checkSenderAddress(' Info@Voorbeeld.nl ', 'voorbeeld.nl'), { email: 'info@voorbeeld.nl' });
  assert.deepEqual(checkSenderAddress("jan.o'brien+offerte@voorbeeld.nl", 'voorbeeld.nl'), { email: "jan.o'brien+offerte@voorbeeld.nl" });
  assert.ok('error' in checkSenderAddress('', 'voorbeeld.nl'));
  assert.ok('error' in checkSenderAddress('info@ander.nl', 'voorbeeld.nl'));
  assert.ok('error' in checkSenderAddress('info@mail.voorbeeld.nl', 'voorbeeld.nl'), 'subdomein telt niet');
  assert.ok('error' in checkSenderAddress('info@voorbeeld.nl.ander.nl', 'voorbeeld.nl'));
  for (const bad of ['a>,"x"@voorbeeld.nl', 'a,b@voorbeeld.nl', '"a"@voorbeeld.nl', 'a b@voorbeeld.nl', '.a@voorbeeld.nl', 'a..b@voorbeeld.nl', 'a<b@voorbeeld.nl']) {
    assert.equal(isPlainEmailAddress(bad), false, bad);
    assert.ok('error' in checkSenderAddress(bad, 'voorbeeld.nl'), bad);
  }
});

test('afzendernaam: geen tweede adres, geen regeleinde, geen omgedraaide leesrichting', () => {
  assert.equal(cleanSenderName('  Bakkerij   De Molen '), 'Bakkerij De Molen');
  assert.equal(cleanSenderName('Evil" <ceo@bank.nl>, x'), 'Evil ceo bank.nl x');
  assert.equal(cleanSenderName('Naam\r\nBcc: iemand@ander.nl'), 'Naam Bcc: iemand ander.nl');
  assert.equal(cleanSenderName('abc‮gnp.exe'), 'abc gnp.exe');
  assert.equal(cleanSenderName('   '), null);
  assert.equal(cleanSenderName(null), null);
  assert.equal(cleanSenderName('x'.repeat(200))?.length, 80);
  assert.equal(formatFromHeader('Jan "JJ" de Vries', 'jan@voorbeeld.nl'), '"Jan JJ de Vries" <jan@voorbeeld.nl>');
  assert.equal(formatFromHeader('', 'jan@voorbeeld.nl'), 'jan@voorbeeld.nl');
});

test('koppelen: vrij, eigen, van een ander, of over te nemen', () => {
  const now = new Date('2026-11-06T12:00:00Z');
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const row = (organization_id: string, domain: string, status: string, verified_at: string | null, created_at: string) =>
    ({ organization_id, domain, status, verified_at, created_at });

  assert.deepEqual(judgeDomainClaim('A', 'voorbeeld.nl', [], now), { kind: 'free' });
  assert.deepEqual(judgeDomainClaim('A', 'voorbeeld.nl', [row('A', 'voorbeeld.nl', 'pending', null, days(30))], now), { kind: 'own' });

  // Geverifieerd (nu of ooit) bij een ander: ook boven- en onderliggende domeinen zijn bezet.
  assert.deepEqual(judgeDomainClaim('B', 'voorbeeld.nl', [row('A', 'voorbeeld.nl', 'verified', days(1), days(30))], now), { kind: 'taken' });
  assert.deepEqual(judgeDomainClaim('B', 'mail.voorbeeld.nl', [row('A', 'voorbeeld.nl', 'verified', days(1), days(30))], now), { kind: 'taken' });
  assert.deepEqual(judgeDomainClaim('B', 'voorbeeld.nl', [row('A', 'mail.voorbeeld.nl', 'failed', days(9), days(30))], now), { kind: 'taken' });

  // Nooit geverifieerd: alleen hetzelfde domein, en alleen een week lang.
  const fresh = judgeDomainClaim('B', 'voorbeeld.nl', [row('A', 'voorbeeld.nl', 'pending', null, days(2))], now);
  assert.equal(fresh.kind, 'claimed_until');
  assert.equal((fresh as { until: string }).until, new Date(Date.parse(days(2)) + UNVERIFIED_CLAIM_DAYS * 86_400_000).toISOString());
  assert.deepEqual(judgeDomainClaim('B', 'voorbeeld.nl', [row('A', 'voorbeeld.nl', 'failed', null, days(8))], now), { kind: 'take_over' });
  // Een nooit geverifieerd bovenliggend domein (bijvoorbeeld co.uk) blokkeert niemand.
  assert.deepEqual(judgeDomainClaim('B', 'voorbeeld.co.uk', [row('A', 'co.uk', 'pending', null, days(1))], now), { kind: 'free' });
  assert.deepEqual(judgeDomainClaim('B', 'voorbeeld.nl', [row('A', 'mail.voorbeeld.nl', 'pending', null, days(1))], now), { kind: 'free' });
});
