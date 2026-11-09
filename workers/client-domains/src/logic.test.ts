import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientHostMeta, escapeAttr, faviconSvg, isPortalPath, pageTitle, parseHostList, parseLookup, portalRedirectUrl, routeFor, sameUrlOn, securityHeaders, textOn,
} from './logic.ts';

const KEY = 'jansen-ab3kzxq2mp';

test('alleen de paden van een klant', () => {
  assert.deepEqual(routeFor('/', 'GET', KEY), { kind: 'page', tokenPage: false });
  assert.deepEqual(routeFor('/portal', 'GET', KEY), { kind: 'page', tokenPage: false });
  assert.deepEqual(routeFor(`/portal/${KEY}`, 'GET', KEY), { kind: 'page', tokenPage: false });
  assert.deepEqual(routeFor('/portal/inloggen', 'GET', KEY), { kind: 'page', tokenPage: true });
  for (const p of ['/quote/abcDEF_123-x', '/invoice/abcdefghijklmnop', '/contract/x', '/booking/x', '/gallerij/x', '/gedeeld/x', '/ontvang/x']) {
    assert.deepEqual(routeFor(p, 'GET', KEY), { kind: 'page', tokenPage: true }, p);
  }
  // De werkruimte, /mcp, het voorbeeld en het inlogadres van een ánder: niet hier.
  for (const p of ['/mcp/authorize', '/portal/voorbeeld', '/portal/andere-org-ab3kzxq2mp', '/dashboard', '/instellingen', '/quote/a/b']) {
    assert.deepEqual(routeFor(p, 'GET', KEY), { kind: 'notFound' }, p);
  }
  assert.deepEqual(routeFor('/assets/index-abc.js', 'GET', KEY), { kind: 'asset' });
  assert.deepEqual(routeFor('/fonts/pdf/x.ttf', 'GET', KEY), { kind: 'asset' });
  assert.deepEqual(routeFor('/assets/../sw.js', 'GET', KEY), { kind: 'notFound' });
  assert.deepEqual(routeFor('/sw.js', 'GET', KEY), { kind: 'notFound' }, 'geen service worker van de werkruimte');
  assert.deepEqual(routeFor('/manifest.webmanifest', 'GET', KEY), { kind: 'notFound' });
  assert.deepEqual(routeFor('/robots.txt', 'GET', KEY), { kind: 'robots' });
  assert.deepEqual(routeFor('/favicon.svg', 'GET', KEY), { kind: 'favicon' });
  assert.deepEqual(routeFor('/afmelden', 'POST', KEY), { kind: 'unsubscribe' }, 'one-click afmelden is een POST');
  assert.deepEqual(routeFor('/portal', 'POST', KEY), { kind: 'method' });
  assert.deepEqual(routeFor(`/portal/${KEY}`, 'GET', null), { kind: 'notFound' }, 'zonder eigen sleutel geen sleutelpad');
});

test('het antwoord van client-domains keuren', () => {
  assert.deepEqual(parseLookup({ ok: true, status: 'redirect', redirectHost: 'Nieuw.ResoFly.com' }), { status: 'redirect', redirectHost: 'nieuw.resofly.com' });
  assert.deepEqual(parseLookup({ ok: true, status: 'redirect', redirectHost: 'evil.com/pad' }), { status: 'unknown' });
  const active = parseLookup({
    ok: true, status: 'active', kind: 'custom', host: 'Portaal.Jansen.nl', portalKey: KEY, portalHost: 'Jansen.ResoFly.com',
    brand: { name: 'Fotostudio Jansen', accentColor: '#2E8B76', headerColor: 'red', clientTheme: 'dark', hidePoweredBy: true },
  });
  assert.equal(active.status, 'active');
  if (active.status === 'active') {
    assert.equal(active.host, 'portaal.jansen.nl');
    assert.equal(active.portalKey, KEY);
    assert.equal(active.portalHost, 'jansen.resofly.com');
    assert.equal(active.portalEnabled, false, 'een eigen domein zonder portaal');
    assert.equal(active.brand.accentColor, '#2E8B76');
    assert.equal(active.brand.headerColor, null, 'alleen hexkleuren');
  }
  assert.equal(parseLookup({ ok: true, status: 'active', host: 'x', portalKey: '<script>' }).status, 'active');
  assert.equal((parseLookup({ ok: true, status: 'active', host: 'x', portalKey: '<script>' }) as { portalKey: string | null }).portalKey, null);
  assert.deepEqual(parseLookup({ ok: false }), { status: 'unknown' });
  assert.deepEqual(parseLookup(null), { status: 'unknown' });
  assert.deepEqual(parseLookup({ ok: true, status: 'blocked' }), { status: 'blocked' });
});

test('de titel, de meta en het icoon: met escapes', () => {
  assert.equal(pageTitle('Fotostudio Jansen'), 'Fotostudio Jansen · Klantportaal');
  assert.equal(pageTitle(null), 'Klantportaal');
  assert.equal(pageTitle('a\nb'), 'a b · Klantportaal');
  const meta = clientHostMeta('jansen.resofly.com', KEY);
  assert.match(meta, /^<meta name="resofly-client-host" content="\{&quot;host&quot;:&quot;jansen\.resofly\.com&quot;,&quot;portalKey&quot;:&quot;jansen-ab3kzxq2mp&quot;\}">$/);
  assert.equal(escapeAttr(`"><script>`), '&quot;&gt;&lt;script&gt;');
  const svg = faviconSvg('<Studio>', '#ffffff');
  assert.match(svg, /fill="#ffffff"/);
  assert.match(svg, />S<\/text>/);
  assert.ok(!svg.includes('<Studio>'));
  assert.match(faviconSvg(null, 'rood'), /fill="#3a3a46"/);
  assert.equal(textOn('#ffffff'), '#111114');
  assert.equal(textOn('#000000'), '#ffffff');
});

test('headers van een klantpagina: CSP uit de build, nooit in een zoekmachine', () => {
  const base = new Headers({
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'set-cookie': 'x=1',
    'access-control-allow-origin': '*',
  });
  const token = securityHeaders(base, { tokenPage: true });
  assert.equal(token.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
  assert.equal(token.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(token.get('referrer-policy'), 'no-referrer');
  assert.equal(token.get('strict-transport-security'), 'max-age=31536000', 'zonder includeSubDomains: het domein is van de klant');
  assert.equal(token.get('set-cookie'), null);
  assert.equal(token.get('access-control-allow-origin'), null);
  assert.equal(token.get('x-frame-options'), 'DENY');
  assert.equal(securityHeaders(base, { tokenPage: false }).get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('de lijst met adressen die niet van ons zijn', () => {
  assert.deepEqual([...parseHostList(' Staging.ResoFly.com , resofly.com.,, ')], ['staging.resofly.com', 'resofly.com']);
  assert.equal(parseHostList(undefined).size, 0);
});

test('het portaal staat op een naam bij ResoFly, en op een eigen domein alleen als het daar aan staat', () => {
  const naam = parseLookup({ ok: true, status: 'active', kind: 'subdomain', host: 'jansen.resofly.com', portalKey: KEY });
  const aan = parseLookup({ ok: true, status: 'active', kind: 'custom', host: 'portaal.jansen.nl', portalEnabled: true, portalHost: null });
  const uit = parseLookup({ ok: true, status: 'active', kind: 'custom', host: 'portaal.jansen.nl', portalEnabled: false, portalHost: 'jansen.resofly.com' });
  const oud = parseLookup({ ok: true, status: 'active', kind: 'custom', host: 'portaal.jansen.nl', portalHost: 'jansen.resofly.com' });
  const raar = parseLookup({ ok: true, status: 'active', kind: 'custom', host: 'portaal.jansen.nl', portalEnabled: 'ja' });
  assert.equal(naam.status === 'active' && naam.portalEnabled, true);
  assert.equal(aan.status === 'active' && aan.portalEnabled, true);
  assert.equal(uit.status === 'active' && uit.portalEnabled, false);
  assert.equal(oud.status === 'active' && oud.portalEnabled, false, 'een oudere edge function: geen portaal op het eigen domein');
  assert.equal(raar.status === 'active' && raar.portalEnabled, false, 'alleen true telt');
});

test('het portaal op een eigen domein zonder portaal: door naar de naam bij ResoFly', () => {
  for (const pad of ['/', '/portal', '/portal/', '/portal/inloggen', `/portal/${KEY}`]) assert.equal(isPortalPath(pad), true, pad);
  for (const pad of ['/invoice/abc', '/gallerij/abc', '/afmelden', '/assets/x.js', '/portaal', '/portalx']) assert.equal(isPortalPath(pad), false, pad);
  assert.equal(portalRedirectUrl('/', '', 'jansen.resofly.com'), 'https://jansen.resofly.com/portal');
  assert.equal(portalRedirectUrl('/portal/inloggen', '?aanvraag=abc', 'jansen.resofly.com'), 'https://jansen.resofly.com/portal/inloggen?aanvraag=abc');
  assert.equal(portalRedirectUrl('/portal', '', null), null, 'zonder naam bij ResoFly: nergens heen');
  assert.equal(parseLookup({ ok: true, status: 'active', host: 'x.nl', portalHost: 'evil.com/pad' }).status, 'active');
  assert.equal((parseLookup({ ok: true, status: 'active', host: 'x.nl', portalHost: 'evil.com/pad' }) as { portalHost: string | null }).portalHost, null);
  assert.ok(clientHostMeta('portaal.jansen.nl', KEY, 'jansen.resofly.com').includes('&quot;portalHost&quot;:&quot;jansen.resofly.com&quot;'));
  assert.ok(!clientHostMeta('jansen.resofly.com', KEY).includes('portalHost'));
  // Het portaal aan op een eigen domein: inloggen met een sleutel, en dat zegt de meta.
  assert.ok(clientHostMeta('portaal.jansen.nl', KEY, null, true).includes('&quot;portalMode&quot;:&quot;token&quot;'));
  assert.ok(!clientHostMeta('jansen.resofly.com', KEY).includes('portalMode'));
});

test('doorsturen houdt het domein vast, ook bij een pad dat met // begint', () => {
  assert.equal(sameUrlOn('jansen.resofly.com', '/invoice/abc', '?x=1'), 'https://jansen.resofly.com/invoice/abc?x=1');
  const listig = sameUrlOn('jansen.resofly.com', '//evil.example/x', '');
  assert.equal(new URL(listig).hostname, 'jansen.resofly.com');
  assert.equal(new URL(portalRedirectUrl('//evil.example/x', '', 'jansen.resofly.com') ?? 'https://x/').hostname, 'jansen.resofly.com');
});
