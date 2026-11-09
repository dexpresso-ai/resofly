import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearClientOriginCache, clientBaseUrl, clientDomainsConfig, clientOriginMismatch, clientOriginOf, clientPortalBaseUrl,
  containsPublicLink, isAllowedReturnUrl, portalLinkBase, portalOriginMismatch, portalOriginOf, rememberClientOrigin,
  type ClientDomainsConfig,
} from './clientLinks.ts';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;

/**
 * Een minimale nep-Supabase: from(tabel).select().eq().in().order().limit()
 * .maybeSingle(). Telt de aanroepen, zodat te zien is dat er gefilterd is.
 */
function fakeAdmin(tables: Record<string, Row[]>, options: { fail?: boolean } = {}) {
  const calls: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];
  return {
    calls,
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      calls.push({ table, filters });
      const query = {
        select() { return query; },
        eq(col: string, value: unknown) { filters.push(['eq', col, value]); return query; },
        in(col: string, values: unknown[]) { filters.push(['in', col, values]); return query; },
        order() { return query; },
        limit() { return query; },
        async maybeSingle() {
          if (options.fail) return { data: null, error: { message: 'relation does not exist' } };
          const rows = (tables[table] ?? []).filter(row => filters.every(([op, col, value]) =>
            op === 'eq' ? row[col] === value : (value as unknown[]).includes(row[col])));
          return { data: rows[0] ?? null, error: null };
        },
      };
      return query;
    },
  } as unknown as Parameters<typeof clientBaseUrl>[0] & { calls: typeof calls };
}

const LIVE: ClientDomainsConfig = { base: 'resofly.com', live: true, cnameTarget: 'domeinen.resofly.com' };
const NOT_LIVE: ClientDomainsConfig = { ...LIVE, live: false };

const tables = {
  client_subdomains: [
    { organization_id: ORG_A, name: 'jansen', status: 'active' },
    { organization_id: ORG_A, name: 'oud-jansen', status: 'redirect' },
    { organization_id: ORG_B, name: 'pietersen', status: 'active' },
  ],
  client_domains: [
    { organization_id: ORG_B, hostname: 'portaal.pietersen.nl', status: 'active' },
    { organization_id: ORG_A, hostname: 'portaal.jansen.nl', status: 'pending_dns' },
  ],
};

test('de instellingen: basisdomein, aan of uit, CNAME-doel', () => {
  assert.deepEqual(clientDomainsConfig(() => undefined), { base: 'resofly.com', live: false, cnameTarget: 'domeinen.resofly.com' });
  const env: Record<string, string> = { CLIENT_DOMAIN_BASE: 'Klant.Example.NL.', CLIENT_DOMAINS_LIVE: 'true', CLIENT_DOMAIN_CNAME_TARGET: 'cname.example.nl' };
  assert.deepEqual(clientDomainsConfig((n) => env[n]), { base: 'klant.example.nl', live: true, cnameTarget: 'cname.example.nl' });
  assert.equal(clientDomainsConfig((n) => (n === 'CLIENT_DOMAINS_LIVE' ? 'nee' : undefined)).live, false);
});

test('de link gaat naar het klantadres van díe organisatie', async () => {
  const admin = fakeAdmin(tables);
  assert.equal(await clientBaseUrl(admin, ORG_A, 'https://staging.resofly.com/', LIVE), 'https://jansen.resofly.com');
  // Een actief eigen domein gaat voor de naam; een domein dat nog wacht niet.
  assert.equal(await clientBaseUrl(admin, ORG_B, 'https://staging.resofly.com', LIVE), 'https://portaal.pietersen.nl');
  // Elke vraag filtert op de organisatie.
  assert.ok(admin.calls.every(call => call.filters.some(([op, col, value]) => op === 'eq' && col === 'organization_id' && (value === ORG_A || value === ORG_B))));
});

test('nog niet aan, geen naam, of de tabel ontbreekt: het oude adres', async () => {
  assert.equal(await clientBaseUrl(fakeAdmin(tables), ORG_A, 'https://staging.resofly.com/', NOT_LIVE), 'https://staging.resofly.com');
  assert.equal(await clientBaseUrl(fakeAdmin({}), ORG_A, 'https://staging.resofly.com', LIVE), 'https://staging.resofly.com');
  assert.equal(await clientBaseUrl(fakeAdmin(tables, { fail: true }), ORG_A, 'https://staging.resofly.com', LIVE), 'https://staging.resofly.com');
  assert.equal(await clientBaseUrl(fakeAdmin(tables), null, 'https://staging.resofly.com', LIVE), 'https://staging.resofly.com');
});

test('een publieke link met token herkennen, op elk adres', () => {
  const token = 'Ab3_kQ9-xYz12345678901234567890abcdefghijk';
  assert.equal(containsPublicLink(`https://staging.resofly.com/invoice/${token}`), true);
  assert.equal(containsPublicLink(`Betaal via https://portaal.jansen.nl/invoice/${token} vóór vrijdag`), true);
  assert.equal(containsPublicLink(`https://jansen.resofly.com/quote/${token}`, ['invoice']), false);
  assert.equal(containsPublicLink(`https://jansen.resofly.com/quote/${token}`, ['quote']), true);
  assert.equal(containsPublicLink('https://www.mollie.com/checkout/select-method/abcdef'), false);
  assert.equal(containsPublicLink('https://portaal.jansen.nl/invoice/'), false);
  assert.equal(containsPublicLink(''), false);
});

test('terugkeren na betalen: alleen naar dezelfde pagina op een toegestaan adres', () => {
  const allowed = ['https://jansen.resofly.com', 'https://staging.resofly.com/'];
  assert.equal(isAllowedReturnUrl('https://jansen.resofly.com/invoice/abc', '/invoice/abc', allowed), true);
  assert.equal(isAllowedReturnUrl('https://staging.resofly.com/invoice/abc?betaald=1', '/invoice/abc', allowed), true);
  assert.equal(isAllowedReturnUrl('https://evil.example/invoice/abc', '/invoice/abc', allowed), false);
  assert.equal(isAllowedReturnUrl('https://jansen.resofly.com/', '/invoice/abc', allowed), false);
  assert.equal(isAllowedReturnUrl('https://x:y@jansen.resofly.com/invoice/abc', '/invoice/abc', allowed), false);
  assert.equal(isAllowedReturnUrl('javascript:alert(1)', '/invoice/abc', allowed), false);
});

test('een verzoek van een klantadres: herkend, en een token van een ander geeft niets', async () => {
  clearClientOriginCache();
  const admin = fakeAdmin(tables);
  const fromA = new Request('https://x.supabase.co/functions/v1/invoice-public', { headers: { origin: 'https://jansen.resofly.com' } });
  const client = await rememberClientOrigin(admin, fromA, LIVE);
  assert.deepEqual(client, { origin: 'https://jansen.resofly.com', host: 'jansen.resofly.com', organizationId: ORG_A, kind: 'subdomain', portalEnabled: true });
  assert.equal(clientOriginOf(fromA)?.organizationId, ORG_A);
  assert.equal(clientOriginMismatch(fromA, ORG_A), false);
  assert.equal(clientOriginMismatch(fromA, ORG_B), true, 'de factuur van B op het adres van A');

  const custom = new Request('https://x.supabase.co/functions/v1/invoice-public', { headers: { origin: 'https://portaal.pietersen.nl' } });
  assert.equal((await rememberClientOrigin(admin, custom, LIVE))?.organizationId, ORG_B);

  // Geen klantadres: een oude naam (stuurt door), een domein dat nog wacht, het algemene adres, http, een poort.
  for (const origin of ['https://oud-jansen.resofly.com', 'https://portaal.jansen.nl', 'https://staging.resofly.com', 'http://jansen.resofly.com', 'https://jansen.resofly.com:8443', 'null', '']) {
    const req = new Request('https://x.supabase.co/functions/v1/invoice-public', { headers: origin ? { origin } : {} });
    assert.equal(await rememberClientOrigin(admin, req, LIVE), null, origin);
    assert.equal(clientOriginMismatch(req, ORG_B), false, `${origin}: van het algemene adres mag alles`);
  }
  // Mislukt het opzoeken, dan is het geen klantadres (en dus ook geen extra toegang).
  clearClientOriginCache();
  const broken = new Request('https://x.supabase.co/', { headers: { origin: 'https://jansen.resofly.com' } });
  assert.equal(await rememberClientOrigin(fakeAdmin(tables, { fail: true }), broken, LIVE), null);
});

test('het portaal: op de naam bij ResoFly, of op het eigen domein als het daar aan staat', async () => {
  const admin = fakeAdmin(tables);
  // ORG_B heeft een actief eigen domein zonder portaal: documenten gaan daarheen, het portaal niet.
  assert.equal(await clientBaseUrl(admin, ORG_B, 'https://staging.resofly.com', LIVE), 'https://portaal.pietersen.nl');
  assert.equal(await clientPortalBaseUrl(admin, ORG_B, 'https://staging.resofly.com', LIVE), 'https://pietersen.resofly.com');
  assert.deepEqual(await portalLinkBase(admin, ORG_B, 'https://staging.resofly.com/', LIVE), { base: 'https://pietersen.resofly.com', onClientHost: true });
  // Niet aan, geen naam, of de tabel ontbreekt: het algemene adres (met sleutel).
  assert.deepEqual(await portalLinkBase(admin, ORG_B, 'https://staging.resofly.com', NOT_LIVE), { base: 'https://staging.resofly.com', onClientHost: false });
  assert.equal(await clientPortalBaseUrl(fakeAdmin({}), ORG_A, 'https://staging.resofly.com', LIVE), 'https://staging.resofly.com');
  assert.equal(await clientPortalBaseUrl(fakeAdmin(tables, { fail: true }), ORG_A, 'https://staging.resofly.com', LIVE), 'https://staging.resofly.com');
  // Elke vraag filtert op de organisatie.
  assert.ok(admin.calls.every(call => call.filters.some(([op, col, value]) => op === 'eq' && col === 'organization_id' && (value === ORG_A || value === ORG_B))));

  // Met het portaal aan op het eigen domein: daar. Een domein dat nog wacht, telt niet.
  const aan = fakeAdmin({
    ...tables,
    client_domains: [
      { organization_id: ORG_B, hostname: 'portaal.pietersen.nl', status: 'active', portal_enabled: true },
      { organization_id: ORG_A, hostname: 'portaal.jansen.nl', status: 'pending_dns', portal_enabled: true },
    ],
  });
  assert.equal(await clientPortalBaseUrl(aan, ORG_B, 'https://staging.resofly.com', LIVE), 'https://portaal.pietersen.nl');
  assert.deepEqual(await portalLinkBase(aan, ORG_B, 'https://staging.resofly.com', LIVE), { base: 'https://portaal.pietersen.nl', onClientHost: true });
  assert.equal(await clientPortalBaseUrl(aan, ORG_A, 'https://staging.resofly.com', LIVE), 'https://jansen.resofly.com');
  assert.equal(await clientPortalBaseUrl(aan, ORG_B, 'https://staging.resofly.com', NOT_LIVE), 'https://staging.resofly.com');
});

test('voor het portaal telt een naam bij ResoFly, en een eigen domein alleen met het portaal aan en actief', async () => {
  clearClientOriginCache();
  const admin = fakeAdmin({ ...tables, client_domains: [
    { organization_id: ORG_B, hostname: 'portaal.pietersen.nl', status: 'active' },
    { organization_id: ORG_A, hostname: 'portaal.jansen.nl', status: 'active', portal_enabled: true },
    { organization_id: ORG_A, hostname: 'klanten.jansen.nl', status: 'failing', portal_enabled: true },
  ] });
  const naam = new Request('https://x.test/f', { headers: { origin: 'https://pietersen.resofly.com' } });
  const eigen = new Request('https://x.test/f', { headers: { origin: 'https://portaal.pietersen.nl' } });
  const eigenMetPortaal = new Request('https://x.test/f', { headers: { origin: 'https://portaal.jansen.nl' } });
  const hapert = new Request('https://x.test/f', { headers: { origin: 'https://klanten.jansen.nl' } });
  await rememberClientOrigin(admin, naam, LIVE);
  await rememberClientOrigin(admin, eigen, LIVE);
  await rememberClientOrigin(admin, eigenMetPortaal, LIVE);
  await rememberClientOrigin(admin, hapert, LIVE);
  assert.equal(clientOriginOf(eigen)?.kind, 'custom', 'voor documenten is het eigen domein een klantadres');
  assert.equal(clientOriginOf(eigen)?.portalEnabled, false);
  assert.equal(portalOriginOf(eigen), null, 'zonder portaal: voor het portaal niet');
  assert.equal(portalOriginOf(naam)?.organizationId, ORG_B);
  assert.equal(portalOriginMismatch(naam, ORG_A), true);
  assert.equal(portalOriginMismatch(naam, ORG_B), false);
  assert.equal(portalOriginMismatch(naam, null), true, 'een inlog voor alles hoort niet op het adres van één organisatie');
  assert.equal(portalOriginMismatch(eigen, ORG_A), false, 'geen portaaladres: dan geldt het algemene adres');
  // Het portaal aan op een actief domein: wel.
  assert.deepEqual(portalOriginOf(eigenMetPortaal), {
    origin: 'https://portaal.jansen.nl', host: 'portaal.jansen.nl', organizationId: ORG_A, kind: 'custom', portalEnabled: true,
  });
  assert.equal(portalOriginMismatch(eigenMetPortaal, ORG_A), false);
  assert.equal(portalOriginMismatch(eigenMetPortaal, ORG_B), true);
  // Het portaal aan, maar het domein hapert (het record wijst misschien al
  // naar een ander): voor het portaal niet meer, voor documenten nog wel.
  // Eerst wel; dan kon iedereen vanaf zo'n domein inlogmails laten sturen.
  assert.equal(clientOriginOf(hapert)?.kind, 'custom');
  assert.equal(clientOriginOf(hapert)?.portalEnabled, false);
  assert.equal(portalOriginOf(hapert), null);
  clearClientOriginCache();
});
