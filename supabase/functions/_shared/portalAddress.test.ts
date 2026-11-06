import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPortalLoginKey, loadPortalLoginKey, portalLoginUrl } from './portalAddress.ts';
import { portalSettingsUrl, portalTicketUrl } from './portalNotify.ts';

const KEY = 'studio-noord-ro2ystqucm';
const CLIENT = '11111111-2222-4333-8444-555555555555';
const TICKET = '66666666-7777-4888-9999-000000000000';

test('de link naar het portaal: het eigen adres, anders het algemene', () => {
  assert.equal(portalLoginUrl('https://app.resofly.nl/', KEY), `https://app.resofly.nl/portal/${KEY}`);
  assert.equal(portalLoginUrl('https://app.resofly.nl', null), 'https://app.resofly.nl/portal');
  // Een ongeldige sleutel (wat dan ook uit de database kwam) wordt nooit een pad.
  assert.equal(portalLoginUrl('https://app.resofly.nl', 'voorbeeld'), 'https://app.resofly.nl/portal');
  assert.equal(portalLoginUrl('https://app.resofly.nl', '../admin-ro2ystqucm'), 'https://app.resofly.nl/portal');
  assert.equal(
    portalLoginUrl('https://app.resofly.nl', KEY, { dossier: CLIENT, view: 'instellingen' }),
    `https://app.resofly.nl/portal/${KEY}?dossier=${CLIENT}&view=instellingen`,
  );
  assert.equal(portalLoginUrl('https://app.resofly.nl', null, { q: 'a b&c' }), 'https://app.resofly.nl/portal?q=a%20b%26c');
});

test('de deeplinks in de ticketmail gaan naar het eigen adres', () => {
  assert.equal(portalTicketUrl('https://app.resofly.nl/', CLIENT, TICKET, KEY), `https://app.resofly.nl/portal/${KEY}?dossier=${CLIENT}&ticket=${TICKET}`);
  assert.equal(portalSettingsUrl('https://app.resofly.nl', CLIENT, KEY), `https://app.resofly.nl/portal/${KEY}?dossier=${CLIENT}&view=instellingen`);
  // Zonder adres precies wat het was.
  assert.equal(portalTicketUrl('https://app.resofly.nl', CLIENT, TICKET), `https://app.resofly.nl/portal?dossier=${CLIENT}&ticket=${TICKET}`);
});

test('het adres ophalen: alleen een geldige sleutel, en nooit een fout', async () => {
  const calls: Array<{ fn: string; params: unknown }> = [];
  const admin = (result: unknown) => ({
    rpc: async (fn: string, params: unknown) => { calls.push({ fn, params }); return result; },
  }) as never;
  assert.equal(await loadPortalLoginKey(admin({ data: KEY, error: null }), 'org-1'), KEY);
  assert.deepEqual(calls[0], { fn: 'ensure_portal_login_key', params: { p_organization_id: 'org-1' } });
  assert.equal(await loadPortalLoginKey(admin({ data: null, error: { message: 'function does not exist' } }), 'org-1'), null);
  assert.equal(await loadPortalLoginKey(admin({ data: 'Niet Geldig', error: null }), 'org-1'), null);
  const crashing = { rpc: async () => { throw new Error('netwerk weg'); } } as never;
  assert.equal(await loadPortalLoginKey(crashing, 'org-1'), null);
  assert.equal(isPortalLoginKey(KEY), true);
});

test('elke mail met een link naar het portaal gebruikt het eigen adres', async () => {
  // Bronnen lezen in plaats van draaien: een nieuwe mail die toch weer
  // `${base}/portal` bouwt, valt hier op.
  const { readFileSync } = await import('node:fs');
  for (const fn of ['mail', 'file-share', 'contract-public', 'portal-notify']) {
    const source = readFileSync(new URL(`../${fn}/index.ts`, import.meta.url), 'utf8');
    assert.match(source, /loadPortalLoginKey\(/, `${fn} haalt het inlogadres niet op`);
    assert.doesNotMatch(source, /\}\/portal`/, `${fn} bouwt nog zelf een link naar /portal`);
  }
});
