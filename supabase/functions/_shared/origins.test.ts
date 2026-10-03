import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  corsAllowOrigin, isLocalDevOrigin, normalizeOrigin, OPAQUE_ORIGIN, originRefusal, parseAllowedOrigins,
} from './origins.ts';

/**
 * Welke browser-herkomst mag een Edge Function aanroepen? Twee regels, overal:
 * Access-Control-Allow-Origin is nooit "null", en een verzoek met
 * `Origin: null` (sandbox-iframe, data:- of file:-pagina) komt er niet in.
 */

const APP = 'https://app.resofly.nl';

test('toegestane origins: alleen echte webherkomsten, zoals een browser ze stuurt', () => {
  assert.deepEqual(parseAllowedOrigins([
    'https://App.ResoFly.nl/, https://app.resofly.nl/dashboard',
    'null, *, javascript:alert(1), ftp://x.nl, , https://staging.resofly.nl:443',
    undefined, null, 'http://localhost:5173',
  ]), [APP, 'https://staging.resofly.nl', 'http://localhost:5173']);
  assert.equal(normalizeOrigin('null'), null);
  assert.equal(normalizeOrigin('*'), null);
  assert.equal(normalizeOrigin('https://'), null);
});

test('de header: alleen een toegestane origin krijgt hem terug, nooit "null"', () => {
  assert.equal(corsAllowOrigin(APP, [APP], false), APP);
  assert.equal(corsAllowOrigin('https://evil.example', [APP], false), null, 'geen match = geen header');
  assert.equal(corsAllowOrigin(OPAQUE_ORIGIN, [APP], false), null);
  assert.equal(corsAllowOrigin(OPAQUE_ORIGIN, [APP, OPAQUE_ORIGIN], true), null, 'ook niet als iemand "null" toch instelt');
  assert.equal(corsAllowOrigin('', [APP], true), '*', 'lokaal: curl en scripts zonder Origin');
  assert.equal(corsAllowOrigin('', [APP], false), null);
  assert.equal(corsAllowOrigin('http://localhost:5173', [], true), 'http://localhost:5173');
  assert.equal(corsAllowOrigin('http://localhost:5173', [], false), null);
});

test('binnenkomen: Origin null nooit, ook niet lokaal of zonder ingestelde origins', () => {
  for (const [allowed, local] of [[[APP], false], [[APP], true], [[], true], [[], false]] as const) {
    const refusal = originRefusal(OPAQUE_ORIGIN, [...allowed], local);
    assert.ok(refusal && refusal.status === 403, `null hoort geweigerd te worden (${JSON.stringify({ allowed, local })})`);
  }
  assert.equal(originRefusal(APP, [APP], false), null);
  assert.equal(originRefusal('https://evil.example', [APP], false)?.status, 403);
  assert.equal(originRefusal('', [APP], false)?.status, 403, 'zonder Origin alleen lokaal');
  assert.equal(originRefusal('', [APP], true), null);
  assert.equal(originRefusal(APP, [], false)?.status, 500, 'productie zonder ingestelde origins is een configuratiefout');
  assert.equal(originRefusal('https://x.nl', [], true), null, 'lokaal zonder instellingen: alles, behalve null');
  assert.ok(isLocalDevOrigin('http://127.0.0.1:8080'));
  assert.ok(!isLocalDevOrigin('http://localhost.evil.example'));
});

// ── Alle functies houden zich eraan ─────────────────────────────────────────

const functionsDir = new URL('../', import.meta.url);
const functions = readdirSync(functionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => ({ name: entry.name, source: readFileSync(new URL(`${entry.name}/index.ts`, functionsDir), 'utf8') }));

/** De tekst van één functie (meerregelig of op één regel). */
function body(source: string, start: number): string {
  const lineEnd = source.indexOf('\n', start);
  const firstLine = source.slice(start, lineEnd);
  if (firstLine.trimEnd().endsWith('}') && firstLine.split('{').length === firstLine.split('}').length) return firstLine;
  return source.slice(start, source.indexOf('\n}\n', start));
}

test('geen enkele functie stuurt Access-Control-Allow-Origin: null', () => {
  const offenders = functions.filter(({ source }) => {
    const at = source.indexOf('function corsHeaders(');
    return at >= 0 && /'null'/.test(body(source, at));
  }).map(({ name }) => name);
  assert.deepEqual(offenders, [], 'gebruik makeCors (edgeAuth.ts) of laat de header weg bij geen match');
  assert.ok(functions.length > 20, 'de functies werden niet gevonden');
});

test('elke eigen origin-controle weigert Origin: null', () => {
  const missing: string[] = [];
  for (const { name, source } of functions) {
    for (const match of source.matchAll(/function assert[A-Za-z]*Origin\(/g)) {
      if (!/origin === 'null'/.test(body(source, match.index!))) missing.push(name);
    }
  }
  assert.deepEqual(missing, []);
  const edgeAuth = readFileSync(new URL('./edgeAuth.ts', import.meta.url), 'utf8');
  assert.match(edgeAuth, /const allowOrigin = corsAllowOrigin\(/);
  assert.match(edgeAuth, /const refusal = originRefusal\(/);
});
