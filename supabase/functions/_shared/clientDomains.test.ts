import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cloudflareHostnameState, customDomainProblem, dnsInstructions, ownershipVerdict, txtValues, isApexDomain, parseClientHost, parseHostnameInput,
  subdomainFormatProblem, subdomainHost, SUBDOMAIN_PROBLEM_TEXT, translateCloudflareError,
} from './clientDomains.ts';

const RESERVED = ['resofly.com', 'domeinen.resofly.com', 'staging.resofly.com'];

test('de vorm van een naam: zoals client_subdomain_problem() in de migratie', () => {
  assert.equal(subdomainFormatProblem('jansen'), null);
  assert.equal(subdomainFormatProblem('studio-noord-2'), null);
  assert.equal(subdomainFormatProblem('ab'), 'te_kort');
  assert.equal(subdomainFormatProblem('a'.repeat(41)), 'te_lang');
  assert.equal(subdomainFormatProblem('a'.repeat(40)), null);
  assert.equal(subdomainFormatProblem('Jansen'), 'tekens', 'hoofdletters horen er niet in (de app maakt ze klein)');
  assert.equal(subdomainFormatProblem('jan sen'), 'tekens');
  assert.equal(subdomainFormatProblem('jänsen'), 'tekens');
  assert.equal(subdomainFormatProblem('-jansen'), 'streepje');
  assert.equal(subdomainFormatProblem('jansen-'), 'streepje');
  assert.equal(subdomainFormatProblem('xn--bcher-kva'), 'streepje', 'geen punycode-namen die op een ander woord lijken');
  assert.equal(subdomainFormatProblem('2026'), 'alleen_cijfers');
});

test('de zinnen zijn dezelfde als in de database', () => {
  const sql = readFileSync(new URL('../../migrations/20261108230000_klantdomeinen.sql', import.meta.url), 'utf8');
  for (const [code, text] of Object.entries(SUBDOMAIN_PROBLEM_TEXT)) {
    assert.ok(sql.includes(`when '${code}' then '${text}'`), `${code} staat niet zo in client_subdomain_problem_text()`);
  }
});

test('een geplakt domein wordt een kale hostnaam', () => {
  assert.equal(parseHostnameInput('https://Portaal.Jansen.nl/pad?x=1'), 'portaal.jansen.nl');
  assert.equal(parseHostnameInput('portaal.jansen.nl.'), 'portaal.jansen.nl');
  assert.equal(parseHostnameInput('  klanten.jansen.nl  '), 'klanten.jansen.nl');
  assert.equal(parseHostnameInput('info@jansen.nl'), 'jansen.nl');
  assert.equal(parseHostnameInput('portaal.bücher.de'), 'portaal.xn--bcher-kva.de');
  assert.equal(parseHostnameInput('https://user:pw@portaal.jansen.nl'), null);
  assert.equal(parseHostnameInput(''), null);
  assert.equal(parseHostnameInput('niet een domein'), null);
  assert.equal(parseHostnameInput('portaal'), null);
});

test('hoofddomein of subdomein', () => {
  assert.equal(isApexDomain('jansen.nl'), true);
  assert.equal(isApexDomain('portaal.jansen.nl'), false);
  assert.equal(isApexDomain('jansen.co.uk'), true);
  assert.equal(isApexDomain('portaal.jansen.co.uk'), false);
  assert.equal(isApexDomain('a.b.jansen.nl'), false);
});

test('welk eigen domein mag', () => {
  assert.equal(customDomainProblem('portaal.jansen.nl', RESERVED), null);
  assert.match(customDomainProblem('jansen.nl', RESERVED) ?? '', /subdomein, zoals portaal\.jansen\.nl/);
  assert.match(customDomainProblem('portaal.co.uk', RESERVED) ?? '', /subdomein/);
  assert.match(customDomainProblem('jansen.resofly.com', RESERVED) ?? '', /ResoFly zelf/);
  assert.match(customDomainProblem('x.domeinen.resofly.com', RESERVED) ?? '', /ResoFly zelf/);
  assert.match(customDomainProblem('192.168.1.10', RESERVED) ?? '', /IP-adres/);
  assert.match(customDomainProblem('portaal.jansen.test', RESERVED) ?? '', /bestaat niet/);
  assert.match(customDomainProblem('', RESERVED) ?? '', /Vul een domein in/);
});

test('een adres herkennen: een naam onder het basisdomein of een eigen domein', () => {
  assert.deepEqual(parseClientHost('jansen.resofly.com', 'resofly.com'), { kind: 'subdomain', name: 'jansen' });
  assert.deepEqual(parseClientHost('Jansen.ResoFly.com.', 'resofly.com'), { kind: 'subdomain', name: 'jansen' });
  assert.equal(parseClientHost('resofly.com', 'resofly.com'), null, 'het basisdomein zelf is geen klantadres');
  assert.equal(parseClientHost('a.b.resofly.com', 'resofly.com'), null, 'dieper dan één label niet');
  assert.equal(parseClientHost('-x.resofly.com', 'resofly.com'), null);
  assert.deepEqual(parseClientHost('portaal.jansen.nl', 'resofly.com'), { kind: 'custom', hostname: 'portaal.jansen.nl' });
  assert.equal(parseClientHost('jansen.nl', 'resofly.com'), null, 'een hoofddomein kan geen klantadres zijn');
  assert.equal(subdomainHost('Jansen', 'resofly.com.'), 'jansen.resofly.com');
});

test('de stand bij Cloudflare in onze woorden', () => {
  assert.deepEqual(cloudflareHostnameState({ status: 'active', ssl: { status: 'active' } }, false), { status: 'active', problem: null });
  assert.equal(cloudflareHostnameState({ status: 'pending', ssl: { status: 'pending_validation' } }, false).status, 'pending_dns');
  const noCname = cloudflareHostnameState({ status: 'pending', verification_errors: ['custom hostname does not CNAME to this zone.'], ssl: { status: 'pending_validation' } }, false);
  assert.equal(noCname.status, 'pending_dns');
  assert.match(noCname.problem ?? '', /CNAME-record/);
  assert.equal(cloudflareHostnameState({ status: 'active', ssl: { status: 'pending_issuance' } }, false).status, 'pending_certificate');
  assert.equal(cloudflareHostnameState({ status: 'pending', ssl: { status: 'pending_deployment' } }, false).status, 'pending_certificate');
  // Was actief: verdwijnt het record, dan hapert het (en wacht het niet weer op DNS).
  assert.equal(cloudflareHostnameState({ status: 'moved', ssl: { status: 'active' } }, true).status, 'failing');
  assert.equal(cloudflareHostnameState({ status: 'moved', ssl: { status: 'active' } }, false).status, 'pending_dns');
  assert.equal(cloudflareHostnameState({ status: 'active', ssl: { status: 'expired' } }, true).status, 'failing');
  assert.equal(cloudflareHostnameState({ status: 'blocked' }, true).status, 'blocked');
  assert.equal(cloudflareHostnameState(null, true).status, 'failing');
  const caa = cloudflareHostnameState({ status: 'pending', ssl: { status: 'validation_timed_out', validation_errors: [{ message: 'CAA record prevents issuance' }] } }, false);
  assert.match(caa.problem ?? '', /CAA-record/);
  assert.match(translateCloudflareError('iets onbekends'), /Cloudflare meldt: iets onbekends/);
});

test('de records voor de domeinbeheerder', () => {
  assert.deepEqual(dnsInstructions('Portaal.Jansen.nl', 'domeinen.resofly.com'), [
    { type: 'CNAME', name: 'portaal.jansen.nl', value: 'domeinen.resofly.com' },
  ]);
  const withTxt = dnsInstructions('portaal.jansen.nl', 'domeinen.resofly.com', {
    ownership_verification: { type: 'txt', name: '_cf-custom-hostname.portaal.jansen.nl', value: 'abc-123' },
  });
  assert.equal(withTxt.length, 2);
  assert.deepEqual(withTxt[1], { type: 'TXT', name: '_cf-custom-hostname.portaal.jansen.nl', value: 'abc-123' });
});

test('TXT-antwoorden: aanhalingstekens weg, stukken aan elkaar', () => {
  assert.deepEqual(txtValues(['"abc-123"', '"deel een" "deel twee"', 'kaal', '"met \\"quote\\""']), ['abc-123', 'deel eendeel twee', 'kaal', 'met "quote"']);
});

test('actief pas met het TXT-record van deze koppeling (tegen overname van een vergeten record)', () => {
  const actief = { status: 'active' as const, problem: null };
  const naam = '_cf-custom-hostname.portaal.jansen.nl';
  // Cloudflare zegt actief (het CNAME-record staat er), maar het TXT-record niet: niet actief.
  const zonder = ownershipVerdict(actief, { wasVerified: false, name: naam, found: false });
  assert.equal(zonder.status, 'pending_dns');
  assert.match(zonder.problem ?? '', /TXT-record op _cf-custom-hostname\.portaal\.jansen\.nl/);
  // Niet te controleren: ook niet actief.
  assert.equal(ownershipVerdict(actief, { wasVerified: false, name: naam, found: null }).status, 'pending_dns');
  // Met het record: actief.
  assert.deepEqual(ownershipVerdict(actief, { wasVerified: false, name: naam, found: true }), actief);
  // Was al eens actief: het record mag weg.
  assert.deepEqual(ownershipVerdict(actief, { wasVerified: true, name: naam, found: false }), actief);
  // Een CNAME-probleem gaat voor.
  const cname = { status: 'pending_dns' as const, problem: 'portaal.jansen.nl wijst nu naar elders.nl.' };
  assert.deepEqual(ownershipVerdict(cname, { wasVerified: false, name: naam, found: false }), cname);
  // Het certificaat komt al, het TXT-record nog niet: terug naar "records".
  assert.equal(ownershipVerdict({ status: 'pending_certificate', problem: null }, { wasVerified: false, name: naam, found: false }).status, 'pending_dns');
  // Geblokkeerd blijft geblokkeerd.
  assert.equal(ownershipVerdict({ status: 'blocked', problem: 'x' }, { wasVerified: false, name: naam, found: false }).status, 'blocked');
});
