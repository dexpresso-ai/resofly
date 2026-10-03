import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHostAddresses, webhookAddressProblem } from './webhookDelivery.ts';

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
  const problem = await webhookAddressProblem('https://127.0.0.1.nip.io/hook', fakeFetch({
    'cloudflare-dns.com:A': A('127.0.0.1'), 'cloudflare-dns.com:AAAA': NONE,
  }));
  assert.match(problem ?? '', /wijst naar een intern adres/);
  const v6 = await webhookAddressProblem('https://v6.example.com/hook', fakeFetch({
    'cloudflare-dns.com:A': NONE, 'cloudflare-dns.com:AAAA': { body: { Status: 0, Answer: [{ type: 28, data: 'fd00::1' }] } },
  }));
  assert.match(v6 ?? '', /intern adres/);
});

test('een gewone naam mag; en lukt opzoeken bij het aanmaken niet, dan beslist de bezorging', async () => {
  assert.equal(await webhookAddressProblem('https://hooks.example.com/x', fakeFetch({
    'cloudflare-dns.com:A': A('93.184.216.34'), 'cloudflare-dns.com:AAAA': NONE,
  })), null);
  assert.equal(await webhookAddressProblem('https://hooks.example.com/x', fakeFetch({ 'cloudflare-dns.com': 'down', 'dns.google': 'down' })), null);
  // Wat zonder DNS al vaststaat, blijft gelden.
  assert.match(await webhookAddressProblem('https://localhost./x', fakeFetch({})) ?? '', /intern netwerk/);
  assert.match(await webhookAddressProblem('http://hooks.example.com/x', fakeFetch({})) ?? '', /https/);
});
