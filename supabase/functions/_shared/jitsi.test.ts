/**
 * Tests voor de Jitsi-links aan de serverkant (jitsi.ts). Draaien met:  npm test
 *
 * Dezelfde regels als src/lib/meeting.ts; deze test vergelijkt ook de twee, zodat
 * een boeking geen andere link maakt dan de agenda in de app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_JITSI_BASE_URL, isJitsiMeetingUrl, jitsiBaseUrl, jitsiMeetingUrl, jitsiRoomName, normalizeJitsiBaseUrl } from './jitsi.ts';
import * as app from '../../../src/lib/meeting.ts';

test('serveradres: https, netjes, en anders meet.jit.si', () => {
  assert.equal(normalizeJitsiBaseUrl('meet.example.nl/'), 'https://meet.example.nl');
  assert.equal(normalizeJitsiBaseUrl('https://8x8.vc/vpaas-magic-cookie-abc'), 'https://8x8.vc/vpaas-magic-cookie-abc');
  assert.equal(normalizeJitsiBaseUrl('http://meet.example.nl'), null);
  assert.equal(normalizeJitsiBaseUrl('https://meet.example.nl/a/b'), null);
  assert.equal(normalizeJitsiBaseUrl(42), null);
  assert.equal(jitsiBaseUrl(undefined), DEFAULT_JITSI_BASE_URL);
  assert.equal(jitsiBaseUrl('   '), DEFAULT_JITSI_BASE_URL);
});

test('een link per boeking, telkens een andere kamer', () => {
  const a = jitsiMeetingUrl(null);
  const b = jitsiMeetingUrl(null);
  assert.match(a, /^https:\/\/meet\.jit\.si\/ResoFly-[a-km-zA-HJ-NP-Z2-9]{14}$/);
  assert.notEqual(a, b);
  assert.match(jitsiMeetingUrl('video.example.nl'), /^https:\/\/video\.example\.nl\/ResoFly-/);
  assert.match(jitsiRoomName(), /^ResoFly-.{14}$/);
});

test('app en server normaliseren hetzelfde', () => {
  const inputs = [
    '', '  ', 'meet.example.nl', 'https://Meet.Example.NL/', 'https://meet.example.nl:8443/', 'http://meet.example.nl',
    'https://8x8.vc/vpaas-magic-cookie-abc/', 'https://meet.example.nl/a/b', 'https://u:p@meet.example.nl', 'https://meet.example.nl/?x',
    'https://meet.example.nl/#y', 'localhost', 'ftp://meet.example.nl', 'javascript:alert(1)', `https://${'a'.repeat(200)}.nl`,
  ];
  for (const input of inputs) {
    assert.equal(normalizeJitsiBaseUrl(input), app.normalizeJitsiBaseUrl(input), `verschil bij ${JSON.stringify(input)}`);
  }
  assert.equal(DEFAULT_JITSI_BASE_URL, app.DEFAULT_JITSI_BASE_URL);
});

test('de databasecontrole laat precies door wat de app opslaat', () => {
  // Haal de check uit de migratie en speel hem na met dezelfde POSIX-regex.
  const sql = readFileSync(new URL('../../migrations/20261014000000_jitsi_video_meetings.sql', import.meta.url), 'utf8');
  const match = sql.match(/jitsi_base_url ~ '([^']+)'/);
  assert.ok(match, 'check op jitsi_base_url niet gevonden in de migratie');
  const re = new RegExp(match[1].replace('[:space:]', '\\s'));
  for (const ok of ['https://meet.example.nl', 'https://meet.example.nl:8443', 'https://8x8.vc/vpaas-magic-cookie-abc', 'https://xn--bcher-kva.example']) {
    assert.ok(re.test(ok), `${ok} hoort toegestaan te zijn`);
    assert.equal(normalizeJitsiBaseUrl(ok), ok, `${ok} is al genormaliseerd`);
  }
  for (const bad of ['http://meet.example.nl', 'https://meet.example.nl/', 'https://meet.example.nl/a/b', 'https://meet.example.nl?x', 'javascript:alert(1)']) {
    assert.equal(re.test(bad), false, `${bad} hoort geweigerd te worden`);
  }
});

test('Jitsi herkennen: zelfde uitkomst als de app', () => {
  const cases: Array<[string | null, string | null]> = [
    ['https://meet.jit.si/ResoFly-AbCdEfGhJkMnPq', null],
    ['https://8x8.vc/vpaas-magic-cookie-1/Kamer', null],
    ['https://video.example.nl/Weekoverleg', 'video.example.nl'],
    ['https://video.example.nl/Weekoverleg', null],
    ['https://oud.example.nl/ResoFly-AbCdEfGhJkMnPq', null],
    ['https://meet.google.com/abc-defg-hij', null],
    ['https://example.com/ResoFly-kort', null],
    ['geen url', null],
    [null, null],
  ];
  for (const [url, base] of cases) {
    assert.equal(isJitsiMeetingUrl(url, base), app.detectMeetingKind(url, base).kind === 'jitsi', `verschil bij ${url} (${base})`);
  }
  assert.equal(isJitsiMeetingUrl('https://meet.jit.si/x'), true);
  assert.equal(isJitsiMeetingUrl('https://zoom.us/j/1'), false);
});
