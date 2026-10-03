import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryTarget, parseDnsOverrides, resolveHostAddresses, webhookAddressProblem } from './webhookDelivery.ts';

/**
 * Waar wijst een webhook-adres naartoe, als de runtime zelf geen DNS kan
 * opvragen? Dan gaat het via DNS-over-HTTPS, bij twee aanbieders. In node
 * bestaat Deno.resolveDns niet, dus hier loopt precies die weg — met een
 * nagespeelde fetch in plaats van het internet.
 */

type Answers = Record<string, { status?: number; body?: unknown } | 'down'>;

/** Een nagespeelde fetch: per aanbieder en type een antwoord, of "down". */
function fakeFetch(answers: Answers, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const key = `${url.host}:${url.searchParams.get('type')}`;
    seen.push(key);
    const answer = answers[key] ?? answers[url.host];
    if (!answer || answer === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  }) as typeof fetch;
}

/** Opzoeken via de nagespeelde DNS-over-HTTPS. */
const via = (fetcher: typeof fetch) => (host: string) => resolveHostAddresses(host, fetcher);

const A = (ip: string) => ({ body: { Status: 0, Answer: [{ type: 1, data: ip }] } });
const NONE = { body: { Status: 0, Answer: [] } };

test('zonder eigen DNS: de adressen komen van DNS-over-HTTPS', async () => {
  const addresses = await resolveHostAddresses('hooks.example.com', fakeFetch({
    'cloudflare-dns.com:A': A('93.184.216.34'), 'cloudflare-dns.com:AAAA': NONE,
  }));
  assert.deepEqual(addresses, ['93.184.216.34']);
});

test('valt de eerste aanbieder uit, dan antwoordt de tweede', async () => {
  const seen: string[] = [];
  const addresses = await resolveHostAddresses('hooks.example.com', fakeFetch({
    'cloudflare-dns.com': { status: 503 }, 'dns.google:A': A('93.184.216.34'), 'dns.google:AAAA': NONE,
  }, seen));
  assert.deepEqual(addresses, ['93.184.216.34']);
  assert.ok(seen.some((k) => k.startsWith('dns.google')));
});

test('antwoordt niemand, dan weten we het niet — en dat is een fout, geen "geen adressen"', async () => {
  await assert.rejects(resolveHostAddresses('hooks.example.com', fakeFetch({ 'cloudflare-dns.com': 'down', 'dns.google': 'down' })), /kon niet op tijd worden opgezocht/);
  await assert.rejects(resolveHostAddresses('hooks.example.com', fakeFetch({ 'cloudflare-dns.com': { body: { Status: 2 } }, 'dns.google': { body: { Status: 2 } } })), /DNS/);
});

test('een naam die naar binnen wijst, wordt bij het aanmaken geweigerd', async () => {
  const problem = await webhookAddressProblem('https://127.0.0.1.nip.io/hook', via(fakeFetch({
    'cloudflare-dns.com:A': A('127.0.0.1'), 'cloudflare-dns.com:AAAA': NONE,
  })));
  assert.match(problem ?? '', /wijst naar een intern adres/);
  const v6 = await webhookAddressProblem('https://v6.example.com/hook', via(fakeFetch({
    'cloudflare-dns.com:A': NONE, 'cloudflare-dns.com:AAAA': { body: { Status: 0, Answer: [{ type: 28, data: 'fd00::1' }] } },
  })));
  assert.match(v6 ?? '', /intern adres/);
  // Een tunnel of vertaler met iets erachter (6to4 voor 127.0.0.1) telt ook als binnen.
  assert.match(await webhookAddressProblem('https://tunnel.example.com/x', async () => ['2002:7f00:1::']) ?? '', /intern adres/);
});

test('een gewone naam mag; en lukt opzoeken bij het aanmaken niet, dan beslist de bezorging', async () => {
  assert.equal(await webhookAddressProblem('https://hooks.example.com/x', via(fakeFetch({
    'cloudflare-dns.com:A': A('93.184.216.34'), 'cloudflare-dns.com:AAAA': NONE,
  }))), null);
  assert.equal(await webhookAddressProblem('https://hooks.example.com/x', via(fakeFetch({ 'cloudflare-dns.com': 'down', 'dns.google': 'down' }))), null);
  // Nog geen adres (de DNS staat er nog niet): bij het aanmaken geen bezwaar.
  assert.equal(await webhookAddressProblem('https://nog-niet.example.com/x', async () => []), null);
  // Wat zonder DNS al vaststaat, blijft gelden.
  assert.match(await webhookAddressProblem('https://localhost./x', async () => []) ?? '', /intern netwerk/);
  assert.match(await webhookAddressProblem('http://hooks.example.com/x', async () => []) ?? '', /https/);
});

// ── Het doel van een bezorging: de adressen waarmee verbonden wordt ──────────

test('bij een bezorging: de goedgekeurde adressen, IPv4 eerst', async () => {
  const target = await deliveryTarget('https://hooks.example.com/x?y=1', async () => ['2606:4700::1111', '93.184.216.34', '93.184.216.34']);
  assert.ok('addresses' in target);
  assert.deepEqual(target.addresses, ['93.184.216.34', '2606:4700::1111']);
  assert.equal(target.url.href, 'https://hooks.example.com/x?y=1');
});

test('één intern adres tussen de openbare: het eindpunt gaat uit', async () => {
  const target = await deliveryTarget('https://hooks.example.com/x', async () => ['93.184.216.34', '10.0.0.5']);
  assert.ok('problem' in target && target.disable === true);
  assert.match(target.problem, /intern adres/);
});

test('geen enkel adres: later opnieuw, niet uitzetten en zeker niet blind versturen', async () => {
  const target = await deliveryTarget('https://weg.example.com/x', async () => []);
  assert.ok('problem' in target && target.disable === false);
  assert.match(target.problem, /geen IP-adres/);
});

test('een IP-adres in de URL zelf: dat adres, zonder DNS', async () => {
  let asked = false;
  const target = await deliveryTarget('https://93.184.216.34/x', async () => { asked = true; return []; });
  assert.ok('addresses' in target);
  assert.deepEqual(target.addresses, ['93.184.216.34']);
  assert.equal(asked, false);
  const v6 = await deliveryTarget('https://[2606:4700::1111]:8443/x', async () => []);
  assert.ok('addresses' in v6 && v6.addresses[0] === '2606:4700::1111');
});

test('lukt opzoeken bij een bezorging niet, dan gooit het (en wordt het later opnieuw geprobeerd)', async () => {
  await assert.rejects(deliveryTarget('https://hooks.example.com/x', via(fakeFetch({ 'cloudflare-dns.com': 'down', 'dns.google': 'down' }))), /DNS/);
});

test('vaste DNS-antwoorden voor een testomgeving', () => {
  const overrides = parseDnsOverrides(' hooks.test.nl. = 203.0.113.10 , 203.0.113.11 ; leeg= ; =1.2.3.4;andere.nl=198.51.100.7');
  assert.deepEqual([...overrides.entries()], [
    ['hooks.test.nl', ['203.0.113.10', '203.0.113.11']],
    ['andere.nl', ['198.51.100.7']],
  ]);
  assert.equal(parseDnsOverrides(undefined).size, 0);
});
