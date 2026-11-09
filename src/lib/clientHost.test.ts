import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientHostMeta, portalRedirectTarget } from './clientHost.ts';

const KEY = 'jansen-ab3kzxq2mp';

test('de meta van de Worker: alleen als hij bij dit adres hoort', () => {
  const meta = JSON.stringify({ host: 'jansen.resofly.com', portalKey: KEY });
  assert.deepEqual(parseClientHostMeta(meta, 'Jansen.ResoFly.com'), { host: 'jansen.resofly.com', portalKey: KEY, portalHost: null });
  assert.equal(parseClientHostMeta(meta, 'pietersen.resofly.com'), null, 'een meta van een ander adres telt niet');
  assert.equal(parseClientHostMeta('{kapot', 'jansen.resofly.com'), null);
  assert.equal(parseClientHostMeta(null, 'jansen.resofly.com'), null);
  assert.equal(parseClientHostMeta(JSON.stringify({ host: 'jansen.resofly.com', portalKey: '<script>' }), 'jansen.resofly.com')?.portalKey, null);
});

test('het portaal op een eigen domein gaat naar de naam bij ResoFly', () => {
  const eigen = parseClientHostMeta(JSON.stringify({ host: 'portaal.jansen.nl', portalKey: KEY, portalHost: 'jansen.resofly.com' }), 'portaal.jansen.nl');
  assert.equal(eigen?.portalHost, 'jansen.resofly.com');
  assert.equal(portalRedirectTarget(eigen, { pathname: '/', search: '' }), 'https://jansen.resofly.com/portal');
  assert.equal(portalRedirectTarget(eigen, { pathname: '/portal/inloggen', search: '?aanvraag=x' }), 'https://jansen.resofly.com/portal/inloggen?aanvraag=x');
  assert.equal(portalRedirectTarget(eigen, { pathname: '/invoice/abc', search: '' }), null, 'een document blijft op het eigen domein');
  // Op de naam bij ResoFly zelf: nergens heen.
  const naam = parseClientHostMeta(JSON.stringify({ host: 'jansen.resofly.com', portalKey: KEY, portalHost: 'jansen.resofly.com' }), 'jansen.resofly.com');
  assert.equal(naam?.portalHost, null);
  assert.equal(portalRedirectTarget(naam, { pathname: '/portal', search: '' }), null);
  // Een verkeerd gevormde naam telt niet.
  assert.equal(parseClientHostMeta(JSON.stringify({ host: 'portaal.jansen.nl', portalHost: 'evil.com/x' }), 'portaal.jansen.nl')?.portalHost, null);
  assert.equal(portalRedirectTarget(null, { pathname: '/portal', search: '' }), null);
});
