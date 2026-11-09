import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVerifier, loginRequestFromLocation, normalizeLoginCode, parseStoredVerifiers, sha256Hex,
} from './portalLoginFlow.ts';

test('een geheim is lang, willekeurig en url-veilig', async () => {
  const a = createVerifier();
  const b = createVerifier();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.match(await sha256Hex(a), /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('opgeslagen geheimen: alleen geldige, niet te oud, nieuwste eerst, hooguit vijf', () => {
  const now = 1_700_000_000_000;
  const v = (n: number) => `${'x'.repeat(40)}${n}`;
  const raw = JSON.stringify([
    { v: v(1), at: now - 60_000 },
    { v: v(2), at: now - 1_000 },
    { v: 'te-kort', at: now },
    { v: v(3), at: now - 31 * 60_000 },
    { v: v(4), at: now - 2_000 },
    { v: v(5), at: now - 3_000 },
    { v: v(6), at: now - 4_000 },
    { v: v(7), at: now - 5_000 },
  ]);
  assert.deepEqual(parseStoredVerifiers(raw, now), [v(2), v(4), v(5), v(6), v(7)]);
  assert.deepEqual(parseStoredVerifiers('geen json', now), []);
  assert.deepEqual(parseStoredVerifiers('{"v":1}', now), []);
  assert.deepEqual(parseStoredVerifiers(null, now), []);
});

test('de link uit de mail herkennen', () => {
  const id = 'AbC_123-' + 'x'.repeat(30);
  assert.equal(loginRequestFromLocation({ pathname: '/portal/inloggen', search: `?aanvraag=${id}` }), id);
  assert.equal(loginRequestFromLocation({ pathname: '/portal/inloggen/', search: `?aanvraag=${id}` }), id);
  assert.equal(loginRequestFromLocation({ pathname: '/portal', search: `?aanvraag=${id}` }), null);
  assert.equal(loginRequestFromLocation({ pathname: '/portal/inloggen', search: '?aanvraag=<script>' }), null);
  assert.equal(loginRequestFromLocation({ pathname: '/portal/inloggen', search: '' }), null);
});

test('een code uit de mail', () => {
  assert.equal(normalizeLoginCode('1234 5678'), '12345678');
  assert.equal(normalizeLoginCode(' 123456 '), '123456');
  assert.equal(normalizeLoginCode('12345'), null);
  assert.equal(normalizeLoginCode('abc'), null);
});
