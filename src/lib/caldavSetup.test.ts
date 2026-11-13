import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caldavHost, caldavServerUrl, feedDetailLabel, feedLinkUrl } from './caldavSetup.ts';

test('het adres van de agendaserver per omgeving', () => {
  assert.equal(caldavServerUrl({ VITE_APP_ENV: 'staging' }), 'https://caldav-staging.resofly.com');
  // Productie heeft nog geen server: liever geen adres dan een dat niet bestaat.
  assert.equal(caldavServerUrl({ VITE_APP_ENV: 'production' }), null);
  assert.equal(caldavServerUrl({}), null, 'lokaal: geen server');
});

test('een eigen adres gaat voor, maar alleen een echt adres', () => {
  assert.equal(caldavServerUrl({ VITE_CALDAV_URL: 'https://caldav.voorbeeld.nl/', VITE_APP_ENV: 'staging' }), 'https://caldav.voorbeeld.nl');
  assert.equal(caldavServerUrl({ VITE_CALDAV_URL: 'http://localhost:8787' }), 'http://localhost:8787');
  assert.equal(caldavServerUrl({ VITE_CALDAV_URL: 'http://caldav.voorbeeld.nl' }), null, 'geen http buiten de eigen computer: het app-wachtwoord gaat mee');
  assert.equal(caldavServerUrl({ VITE_CALDAV_URL: 'javascript:alert(1)' }), null);
  assert.equal(caldavServerUrl({ VITE_CALDAV_URL: 'https://caldav.voorbeeld.nl/pad' }), null, 'de server staat op de root');
});

test('wat de iPhone en de deellink nodig hebben', () => {
  assert.equal(caldavHost('https://caldav-staging.resofly.com'), 'caldav-staging.resofly.com');
  const token = 'a'.repeat(43);
  assert.equal(feedLinkUrl('https://caldav-staging.resofly.com/', token), `https://caldav-staging.resofly.com/feed/${token}.ics`);
  assert.equal(feedDetailLabel('busy'), 'Alleen bezet');
  assert.equal(feedDetailLabel('details'), 'Titel, tijd en plaats');
});
