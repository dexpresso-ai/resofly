import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientAddressFrom, galleryShareUrl } from './clientAddress.ts';

const APP = 'https://staging.resofly.com';

test('zonder overzicht: alles op het adres van de app', () => {
  const address = clientAddressFrom(null, `${APP}/`);
  assert.deepEqual(address, {
    baseUrl: APP, onClientHost: false,
    portal: { baseUrl: APP, onClientHost: false },
    albums: { baseUrl: APP, onClientHost: false },
  });
});

test('alleen albums live: de deellink naar het klantadres, de rest naar de app', () => {
  const address = clientAddressFrom({
    clientUrl: APP, onClientHost: false,
    portalUrl: APP, portalOnClientHost: false,
    albumUrl: 'https://brand-new-gerrie.resofly.com/', albumOnClientHost: true,
  }, APP);
  assert.deepEqual(address.albums, { baseUrl: 'https://brand-new-gerrie.resofly.com', onClientHost: true });
  assert.deepEqual([address.baseUrl, address.onClientHost], [APP, false]);
  assert.deepEqual(address.portal, { baseUrl: APP, onClientHost: false });
});

test('alles live, met een eigen domein: albums en documenten daar, het portaal op de naam bij ResoFly', () => {
  const address = clientAddressFrom({
    clientUrl: 'https://albums.jansen.nl', onClientHost: true,
    portalUrl: 'https://jansen.resofly.com', portalOnClientHost: true,
    albumUrl: 'https://albums.jansen.nl', albumOnClientHost: true,
  }, APP);
  assert.deepEqual(address.albums, { baseUrl: 'https://albums.jansen.nl', onClientHost: true });
  assert.deepEqual([address.baseUrl, address.onClientHost], ['https://albums.jansen.nl', true]);
  assert.deepEqual(address.portal, { baseUrl: 'https://jansen.resofly.com', onClientHost: true });
});

test('een oudere functie zonder albumUrl: albums zoals de documenten, zoals voorheen', () => {
  const address = clientAddressFrom({ clientUrl: 'https://jansen.resofly.com', onClientHost: true }, APP);
  assert.deepEqual(address.albums, { baseUrl: 'https://jansen.resofly.com', onClientHost: true });
  assert.deepEqual(address.portal, { baseUrl: APP, onClientHost: false });
});

test('alleen een http(s)-adres telt; al het andere wordt het adres van de app', () => {
  for (const albumUrl of ['javascript:alert(1)', 'data:text/html,x', 'ftp://jansen.resofly.com', 'geen adres', 'https://x:y@jansen.resofly.com', '   ']) {
    const address = clientAddressFrom({ clientUrl: APP, albumUrl, albumOnClientHost: true }, APP);
    // Een lege albumUrl valt terug op de documenten; de rest op de app.
    assert.deepEqual(address.albums, { baseUrl: APP, onClientHost: false }, albumUrl);
  }
});

test('de deellink van een album', () => {
  assert.equal(galleryShareUrl('https://jansen.resofly.com', 'Ab3_kQ9-xYz'), 'https://jansen.resofly.com/gallerij/Ab3_kQ9-xYz');
  assert.equal(galleryShareUrl('https://jansen.resofly.com//', 'abc'), 'https://jansen.resofly.com/gallerij/abc');
  // Een token is base64url; mocht er toch iets anders in staan, dan blijft het in het pad.
  assert.equal(galleryShareUrl(APP, 'a/b?c'), `${APP}/gallerij/a%2Fb%3Fc`);
});
