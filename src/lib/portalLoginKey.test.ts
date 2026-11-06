import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isPortalLoginKey, PORTAL_LOGIN_KEY_SOURCE, portalKeyFromPathname, portalLoginPath } from './portalLoginKey.ts';

// De sleutel van het eigen inlogadres staat op drie plekken: de CHECK in de
// database, de app (hier) en de edge functions (_shared/portalAddress.ts).
// Lopen ze uit elkaar, dan maakt de database een sleutel aan die het portaal
// niet herkent: dan staat het inlogscherm stil neutraal, zonder foutmelding.

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

function checkPattern(): string {
  const file = readdirSync(MIGRATIONS).find(name => name.endsWith('_klantlogin_huisstijl.sql'));
  assert.ok(file, 'migratie klantlogin_huisstijl ontbreekt');
  const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
  const match = /check \(key ~ '([^']+)' and length\(key\) <= 48\)/.exec(sql);
  assert.ok(match, 'CHECK op portal_login_addresses.key niet gevonden');
  return match[1];
}

test('de app, de server en de database kennen dezelfde sleutel', () => {
  // Postgres kent geen (?:…); verder moet het letterlijk hetzelfde zijn.
  assert.equal(`^${PORTAL_LOGIN_KEY_SOURCE.replace(/\(\?:/g, '(')}$`, checkPattern());
  const server = readFileSync(new URL('../../supabase/functions/_shared/portalAddress.ts', import.meta.url), 'utf8');
  assert.ok(server.includes(`/^${PORTAL_LOGIN_KEY_SOURCE}$/`), 'de regel in _shared/portalAddress.ts wijkt af');
  assert.ok(server.includes('value.length <= 48'), 'de lengtegrens in _shared/portalAddress.ts wijkt af');
});

test('sleutels zoals de database ze maakt', () => {
  for (const key of ['studio-noord-ro2ystqucm', 'cafe-elan-zonen-t6alnk2frg', 'portaal-hsvhbqutxr', 'een-hele-lange-bedrijfsn-xpz5cyanxv', 'voorbeeld-guqyudyxva']) {
    assert.equal(isPortalLoginKey(key), true, key);
    assert.equal(portalKeyFromPathname(`/portal/${key}`), key);
    assert.equal(portalKeyFromPathname(`/portal/${key}/`), key);
  }
});

test('wat geen sleutel is, opent geen huisstijl', () => {
  for (const path of [
    '/portal', '/portal/', '/portal/voorbeeld', '/portal/voorbeeld/',
    '/portal/Studio-Noord-ro2ystqucm', // hoofdletters maakt de database nooit
    '/portal/studio-noord-ro2ystqu1m', // 1 zit niet in het base32-alfabet
    '/portal/studio-noord-ro2ystquc', // negen tekens
    '/portal/-ro2ystqucm',
    '/portal/studio--noord-ro2ystqucm',
    '/portal/studio-noord-ro2ystqucm/extra',
    '/xportal/studio-noord-ro2ystqucm',
    `/portal/${'a'.repeat(40)}-ro2ystqucm`, // langer dan 48
  ]) {
    assert.equal(portalKeyFromPathname(path), null, path);
  }
  for (const value of [null, undefined, 42, {}, '']) assert.equal(isPortalLoginKey(value), false);
});

test('het pad van het inlogscherm', () => {
  assert.equal(portalLoginPath('studio-noord-ro2ystqucm'), '/portal/studio-noord-ro2ystqucm');
  assert.equal(portalLoginPath(null), '/portal');
  assert.equal(portalLoginPath('voorbeeld'), '/portal', 'een ongeldige sleutel wordt nooit een pad');
});
