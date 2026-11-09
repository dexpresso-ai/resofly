import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClientHostMeta, portalRedirectTarget } from './clientHost.ts';

const KEY = 'jansen-ab3kzxq2mp';

test('de meta van de Worker: alleen als hij bij dit adres hoort', () => {
  const meta = JSON.stringify({ host: 'jansen.resofly.com', portalKey: KEY });
  assert.deepEqual(parseClientHostMeta(meta, 'Jansen.ResoFly.com'), { host: 'jansen.resofly.com', portalKey: KEY, portalHost: null, tokenLogin: false });
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

test('het portaal op een eigen domein: inloggen met een sleutel, en nergens heen sturen', () => {
  const eigen = parseClientHostMeta(JSON.stringify({ host: 'portaal.jansen.nl', portalKey: KEY, portalMode: 'token' }), 'portaal.jansen.nl');
  assert.deepEqual(eigen, { host: 'portaal.jansen.nl', portalKey: KEY, portalHost: null, tokenLogin: true });
  assert.equal(portalRedirectTarget(eigen, { pathname: '/portal', search: '' }), null);
  // Ook als er (per ongeluk) een doorstuuradres bij staat: het portaal staat hier.
  const beide = parseClientHostMeta(JSON.stringify({ host: 'portaal.jansen.nl', portalHost: 'jansen.resofly.com', portalMode: 'token' }), 'portaal.jansen.nl');
  assert.equal(beide?.portalHost, null);
  // Alleen precies 'token' telt.
  assert.equal(parseClientHostMeta(JSON.stringify({ host: 'portaal.jansen.nl', portalMode: 'TOKEN' }), 'portaal.jansen.nl')?.tokenLogin, false);
  assert.equal(parseClientHostMeta(JSON.stringify({ host: 'portaal.jansen.nl', portalMode: true }), 'portaal.jansen.nl')?.tokenLogin, false);
});
