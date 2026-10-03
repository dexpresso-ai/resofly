import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ContentTooLargeError, decodeContentEncoding, pinnedGet, vettedAddresses } from './pinnedGet.ts';
import { buildRequestHead, TransportError, type PinnedRequest, type PinnedResponse } from './webhookTransport.ts';

/**
 * Iets ophalen van een adres dat iemand van buiten opgaf (een agenda-link):
 * één keer opzoeken, elk adres keuren, en dan precies met zo'n adres
 * verbinden. Niet op te zoeken is niet ophalen.
 */

const privateAddress = (address: string) => /^(127\.|10\.|169\.254\.|192\.168\.)/.test(address) || address === '::1';
const allowed = (address: string) => !privateAddress(address);
const ok = (): PinnedResponse => ({ status: 200, body: new TextEncoder().encode('BEGIN:VCALENDAR'), headers: new Map([['etag', '"v1"']]) });

function recording(answer: (request: PinnedRequest) => PinnedResponse | Error) {
  const requests: PinnedRequest[] = [];
  const transport = async (request: PinnedRequest): Promise<PinnedResponse> => {
    requests.push(request);
    const result = answer(request);
    if (result instanceof Error) throw result;
    return result;
  };
  return { transport, requests };
}

const options = (resolve: (host: string) => Promise<string[]>, transport: (r: PinnedRequest) => Promise<PinnedResponse>) => ({
  headers: { Accept: 'text/calendar' }, timeoutMs: 5000, maxBodyBytes: 1000, resolve, isAllowedAddress: allowed, transport,
});

test('verbindt met precies het gekeurde adres, als GET', async () => {
  const { transport, requests } = recording(ok);
  const response = await pinnedGet(new URL('https://agenda.example.com/feed.ics'), options(async () => ['93.184.216.34'], transport));
  assert.equal(response.status, 200);
  assert.equal(response.address, '93.184.216.34');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].address, '93.184.216.34', 'geen tweede DNS-vraag: het gekeurde adres zelf');
  assert.equal(requests[0].method, 'GET');
  assert.equal(response.headers?.get('etag'), '"v1"');
});

test('één intern adres tussen de antwoorden: niet ophalen (DNS-rebinding)', async () => {
  const { transport, requests } = recording(ok);
  await assert.rejects(pinnedGet(new URL('https://rebind.example.com/x.ics'), options(async () => ['93.184.216.34', '127.0.0.1'], transport)),
    /intern adres/);
  await assert.rejects(pinnedGet(new URL('https://meta.example.com/x.ics'), options(async () => ['169.254.169.254'], transport)), /intern adres/);
  assert.equal(requests.length, 0, 'er is niets verstuurd');
});

test('niet op te zoeken, of geen adres: niet ophalen (geen stille terugval)', async () => {
  const { transport, requests } = recording(ok);
  await assert.rejects(pinnedGet(new URL('https://agenda.example.com/x.ics'), options(async () => { throw new Error('dns'); }, transport)),
    /kon nu niet worden opgezocht/);
  await assert.rejects(pinnedGet(new URL('https://agenda.example.com/x.ics'), options(async () => [], transport)), /geen IP-adres/);
  assert.equal(requests.length, 0);
});

test('een IP-adres in de link zelf wordt ook gekeurd', async () => {
  const { transport } = recording(ok);
  await assert.rejects(vettedAddresses(new URL('https://127.0.0.1/x.ics'), { resolve: async () => [], isAllowedAddress: allowed }), /intern/);
  await assert.rejects(vettedAddresses(new URL('https://[::1]/x.ics'), { resolve: async () => [], isAllowedAddress: allowed }), /intern/);
  const response = await pinnedGet(new URL('https://93.184.216.34/x.ics'), options(async () => { throw new Error('niet nodig'); }, transport));
  assert.equal(response.address, '93.184.216.34');
});

test('geen verbinding met het eerste adres: het volgende; een fout ná de verbinding: niet opnieuw', async () => {
  let calls = 0;
  const { transport, requests } = recording(() => (calls++ === 0 ? new TransportError('weg', 'connect') : ok()));
  const response = await pinnedGet(new URL('https://agenda.example.com/x.ics'), options(async () => ['2001:db8::1', '93.184.216.34', '93.184.216.35'], transport));
  assert.equal(response.address, '93.184.216.35', 'IPv4 eerst, en na een mislukte verbinding het volgende');
  assert.deepEqual(requests.map((r) => r.address), ['93.184.216.34', '93.184.216.35']);
  const failing = recording(() => new TransportError('Onleesbaar antwoord', 'protocol'));
  await assert.rejects(pinnedGet(new URL('https://agenda.example.com/x.ics'), options(async () => ['93.184.216.34', '93.184.216.35'], failing.transport)));
  assert.equal(failing.requests.length, 1);
});

test('een GET draagt geen inhoud en geen Content-Length; een POST wel', () => {
  const get = buildRequestHead(new URL('https://agenda.example.com/feed.ics?t=1'), { Accept: 'text/calendar' }, 0, 'GET');
  assert.match(get, /^GET \/feed\.ics\?t=1 HTTP\/1\.1\r\nHost: agenda\.example\.com\r\n/);
  assert.doesNotMatch(get, /Content-Length/);
  assert.match(buildRequestHead(new URL('https://h.example.com/'), {}, 3), /^POST \/ HTTP\/1\.1[\s\S]*Content-Length: 3/);
});

test('de agenda-ophaler gebruikt de vastgepinde verbinding, geen losse fetch', () => {
  const source = readFileSync(new URL('./icsSubscription.ts', import.meta.url), 'utf8');
  const fetcher = source.slice(source.indexOf('async function fetchIcsFeed('), source.indexOf('\n}\n', source.indexOf('async function fetchIcsFeed(')));
  assert.match(fetcher, /await pinnedGet\(new URL\(current\), \{/);
  assert.match(fetcher, /isAllowedAddress: \(address\) => !isDisallowedIp\(address\)/);
  assert.match(fetcher, /current = await assertSafeFeedUrl\(new URL\(location, current\)\.toString\(\)\);/, 'elke omleiding opnieuw gekeurd');
  assert.match(fetcher, /decodeContentEncoding\(res\.body, res\.headers\?\.get\('content-encoding'\), MAX_FEED_BYTES\)/, 'gecomprimeerd: uitpakken met dezelfde limiet');
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /\bfetch\(/, 'nergens nog een fetch die de naam zelf opzoekt');
});

async function compress(text: string, format: 'gzip' | 'deflate'): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream(format))).arrayBuffer());
}

test('een server die toch comprimeert: uitpakken, met een harde limiet op wat eruit komt', async () => {
  const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
  const plain = new TextEncoder().encode(ics);
  assert.equal(await decodeContentEncoding(plain, null, 1000), plain, 'zonder compressie: ongewijzigd');
  assert.equal(await decodeContentEncoding(plain, 'identity', 1000), plain);
  assert.equal(new TextDecoder().decode(await decodeContentEncoding(await compress(ics, 'gzip'), 'gzip', 1000)), ics);
  assert.equal(new TextDecoder().decode(await decodeContentEncoding(await compress(ics, 'deflate'), ' Deflate ', 1000)), ics);
  // Een zip-bom: een paar kB gecomprimeerd, megabytes uitgepakt.
  const bomb = await compress('A'.repeat(2_000_000), 'gzip');
  assert.ok(bomb.byteLength < 10_000);
  await assert.rejects(decodeContentEncoding(bomb, 'gzip', 100_000), (error: unknown) => error instanceof ContentTooLargeError);
  await assert.rejects(decodeContentEncoding(plain, 'gzip', 1000), /beschadigd/);
  await assert.rejects(decodeContentEncoding(plain, 'br', 1000), /onbekende compressie/);
});
