import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityText, canClaim, dnsRecordShortName, normalizeSubdomainInput, subdomainFormatProblem, suggestCustomDomain,
  suggestSubdomain, SUBDOMAIN_PROBLEM_TEXT,
} from './clientDomains.ts';
import {
  subdomainFormatProblem as serverProblem, SUBDOMAIN_PROBLEM_TEXT as SERVER_TEXT,
} from '../../supabase/functions/_shared/clientDomains.ts';

test('de vorm van een naam en de zinnen zijn gelijk aan die van de server', () => {
  assert.deepEqual(SUBDOMAIN_PROBLEM_TEXT, SERVER_TEXT);
  for (const name of ['jansen', 'ab', 'a'.repeat(41), 'Jansen', '-x-', 'jan--sen', '123', 'studio-noord-2', 'x_y', '']) {
    assert.equal(subdomainFormatProblem(name), serverProblem(name), name);
  }
});

test('typen wordt een geldige naam', () => {
  assert.equal(normalizeSubdomainInput('Fotostudio Jansen'), 'fotostudio-jansen');
  assert.equal(normalizeSubdomainInput('Café Élan'), 'cafe-elan');
  assert.equal(normalizeSubdomainInput('studio.noord'), 'studio-noord');
  assert.equal(normalizeSubdomainInput('a  b__c'), 'a-b-c');
  assert.equal(normalizeSubdomainInput('jansen-'), 'jansen-', 'een streepje aan het eind blijft staan tijdens het typen');
  assert.equal(normalizeSubdomainInput('--jansen'), 'jansen');
  assert.equal(normalizeSubdomainInput('<script>'), 'script');
  assert.equal(normalizeSubdomainInput('x'.repeat(60)).length, 40);
});

test('een voorstel uit de bedrijfsnaam', () => {
  assert.equal(suggestSubdomain('Studio Lopik B.V.'), 'studio-lopik');
  assert.equal(suggestSubdomain('Bakkerij De Korenaar vof'), 'bakkerij-de-korenaar');
  assert.equal(suggestSubdomain('Jansen Holding BV'), 'jansen');
  assert.equal(suggestSubdomain('Fotostudio Jansen'), 'fotostudio-jansen');
  assert.equal(suggestSubdomain('AB'), '', 'te kort: geen voorstel');
  assert.equal(suggestSubdomain(null), '');
});

test('de zin onder het veld, en wanneer je kunt vastleggen', () => {
  assert.equal(availabilityText({ name: 'jansen', status: 'available' }, 'jansen.resofly.com'), 'jansen.resofly.com is beschikbaar.');
  assert.equal(availabilityText({ name: 'jansen', status: 'taken' }, 'jansen.resofly.com'), 'Dit adres bestaat al. Kies een andere naam.');
  assert.equal(availabilityText({ name: 'www', status: 'reserved' }, 'www.resofly.com'), SUBDOMAIN_PROBLEM_TEXT.gereserveerd);
  assert.equal(canClaim({ name: 'x', status: 'available' }), true);
  assert.equal(canClaim({ name: 'x', status: 'own_previous' }), true);
  assert.equal(canClaim({ name: 'x', status: 'own' }), false);
  assert.equal(canClaim({ name: 'x', status: 'taken' }), false);
  assert.equal(canClaim(null), false);
});

test('een voorstel voor een eigen domein, uit de website', () => {
  assert.equal(suggestCustomDomain('https://www.jansen.nl/contact', 'resofly.com'), 'albums.jansen.nl');
  assert.equal(suggestCustomDomain('jansen.nl', 'resofly.com'), 'albums.jansen.nl');
  assert.equal(suggestCustomDomain('HTTP://Studio-Lopik.NL:8080?x=1', 'resofly.com'), 'albums.studio-lopik.nl');
  assert.equal(suggestCustomDomain('jansen.resofly.com', 'resofly.com'), '', 'een adres bij ResoFly is geen eigen domein');
  assert.equal(suggestCustomDomain('resofly.com', 'resofly.com'), '');
  assert.equal(suggestCustomDomain('geen website', 'resofly.com'), '');
  assert.equal(suggestCustomDomain('', 'resofly.com'), '');
  assert.equal(suggestCustomDomain(null, 'resofly.com'), '');
});

test('de korte naam voor het DNS-record', () => {
  assert.equal(dnsRecordShortName('portaal.jansen.nl'), 'portaal');
  assert.equal(dnsRecordShortName('klant.portaal.jansen.nl'), 'klant.portaal');
  assert.equal(dnsRecordShortName('_cf-custom-hostname.portaal.jansen.nl'), '_cf-custom-hostname.portaal');
  assert.equal(dnsRecordShortName('portaal.jansen.co.uk'), 'portaal');
  assert.equal(dnsRecordShortName('portaal.jansen.nl.'), 'portaal');
  assert.equal(dnsRecordShortName('jansen.nl'), '@');
});
