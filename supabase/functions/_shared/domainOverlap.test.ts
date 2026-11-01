import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainParents, domainsOverlap, normalizeDomainName, senderDomain } from './domainOverlap.ts';

test('bovenliggende domeinen, zonder de TLD', () => {
  assert.deepEqual(domainParents('a.b.example.nl'), ['b.example.nl', 'example.nl']);
  assert.deepEqual(domainParents('example.nl'), []);
  assert.deepEqual(domainParents('Mail.Example.NL.'), ['example.nl']);
});

test('overlap: gelijk, subdomein of bovenliggend', () => {
  assert.equal(domainsOverlap('example.nl', 'example.nl'), true);
  assert.equal(domainsOverlap('mail.example.nl', 'example.nl'), true);
  assert.equal(domainsOverlap('example.nl', 'mail.example.nl'), true);
  assert.equal(domainsOverlap('EXAMPLE.nl', 'example.NL.'), true);
});

test('geen overlap bij een domein dat er alleen op lijkt', () => {
  assert.equal(domainsOverlap('badexample.nl', 'example.nl'), false);
  assert.equal(domainsOverlap('example.nl.evil.com', 'example.nl'), false);
  assert.equal(domainsOverlap('example.com', 'example.nl'), false);
  assert.equal(domainsOverlap('', 'example.nl'), false);
});

test('het domein van de platform-afzender', () => {
  assert.equal(senderDomain('ResoFly <no-reply@Mail.ResoFly.com>'), 'mail.resofly.com');
  assert.equal(senderDomain('no-reply@resofly.com'), 'resofly.com');
  assert.equal(senderDomain(''), null);
  assert.equal(normalizeDomainName(' Example.NL. '), 'example.nl');
});
