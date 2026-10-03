import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestHead, parseResponseHead, readHttpResponse, TransportError } from './webhookTransport.ts';

/**
 * Het kleine HTTP-deel van de vastgepinde webhookverbinding: wat er de deur
 * uit gaat, en hoe een antwoord gelezen wordt. Het belangrijkste: nooit meer
 * lezen dan het plafond, wat het eindpunt ook terugstuurt.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Een bron die het antwoord in de gegeven brokken teruggeeft, en telt hoeveel er gelezen werd. */
function source(chunks: (string | Uint8Array)[]): { next: () => Promise<Uint8Array | null>; read: () => number } {
  let index = 0;
  let total = 0;
  return {
    next: async () => {
      if (index >= chunks.length) return null;
      const chunk = chunks[index++];
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      total += bytes.length;
      return bytes;
    },
    read: () => total,
  };
}

/** Een bron die eindeloos doorgaat: een eindpunt dat ons vol wil laten lopen. */
function endless(head: string): { next: () => Promise<Uint8Array | null>; read: () => number } {
  let sentHead = false;
  let total = 0;
  const block = encoder.encode('x'.repeat(16_384));
  return {
    next: async () => {
      const bytes = sentHead ? block : encoder.encode(head);
      sentHead = true;
      total += bytes.length;
      return bytes;
    },
    read: () => total,
  };
}

// ── Het verzoek ──────────────────────────────────────────────────────────────

test('het verzoek: pad met zoekdeel, Host met poort, lengte in bytes, en de verbinding gaat daarna dicht', () => {
  const head = buildRequestHead(new URL('https://hooks.example.com:8443/in/x?y=1'), { 'Content-Type': 'application/json', 'ResoFly-Event': 'ping' }, 12);
  assert.equal(head, [
    'POST /in/x?y=1 HTTP/1.1',
    'Host: hooks.example.com:8443',
    'Content-Type: application/json',
    'ResoFly-Event: ping',
    'Content-Length: 12',
    'Accept-Encoding: identity',
    'Connection: close',
    '', '',
  ].join('\r\n'));
  assert.match(buildRequestHead(new URL('https://hooks.example.com'), {}, 0), /^POST \/ HTTP\/1\.1\r\nHost: hooks\.example\.com\r\n/);
});

test('een regeleinde in een header maakt er geen tweede verzoek van', () => {
  assert.throws(() => buildRequestHead(new URL('https://a.example.com/'), { 'ResoFly-Event': 'x\r\nX-Evil: 1' }, 0), TransportError);
  assert.throws(() => buildRequestHead(new URL('https://a.example.com/'), { 'Bad Name': 'x' }, 0), TransportError);
  // Wat de verbinding zelf bepaalt, kan niet van buiten worden gezet.
  const head = buildRequestHead(new URL('https://a.example.com/'), { Host: 'intern', 'Content-Length': '1', Connection: 'keep-alive' }, 5);
  assert.doesNotMatch(head, /intern|keep-alive|Content-Length: 1\r/);
});

// ── Het antwoord ─────────────────────────────────────────────────────────────

test('een gewoon antwoord met Content-Length', async () => {
  const res = await readHttpResponse(source(['HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n{"received":true}']).next, 4000);
  assert.equal(res.status, 200);
  assert.equal(decoder.decode(res.body), '{"received":true}');
});

test('kop en inhoud in losse brokken, ook midden in de scheiding', async () => {
  const res = await readHttpResponse(source(['HTTP/1.1 201 Cre', 'ated\r\nContent-Length: 5\r', '\n\r', '\nhel', 'lo']).next, 4000);
  assert.equal(res.status, 201);
  assert.equal(decoder.decode(res.body), 'hello');
});

test('chunked: samengevoegd, met uitbreidingen en een slot', async () => {
  const res = await readHttpResponse(source([
    'HTTP/1.1 500 Internal Server Error\r\nTransfer-Encoding: chunked\r\n\r\n',
    '5;naam=waarde\r\nHallo\r\n', '1', '\r\n \r\n6\r\nwereld\r\n0\r\n\r\n',
  ]).next, 4000);
  assert.equal(res.status, 500);
  assert.equal(decoder.decode(res.body), 'Hallo wereld');
});

test('100 Continue en 103 Early Hints worden overgeslagen', async () => {
  const res = await readHttpResponse(source([
    'HTTP/1.1 100 Continue\r\n\r\n',
    'HTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n',
  ]).next, 4000);
  assert.equal(res.status, 204);
  assert.equal(res.body.length, 0);
});

test('zonder Content-Length: lezen tot het plafond, en dan stoppen', async () => {
  const src = endless('HTTP/1.1 200 OK\r\n\r\n');
  const res = await readHttpResponse(src.next, 4000);
  assert.equal(res.body.length, 4000);
  assert.ok(src.read() < 4000 + 2 * 16_384, `er werd ${src.read()} bytes gelezen voor een plafond van 4000`);
});

test('een opgegeven lengte van een gigabyte leest er niet meer dan het plafond', async () => {
  const src = endless('HTTP/1.1 200 OK\r\nContent-Length: 1000000000\r\n\r\n');
  const res = await readHttpResponse(src.next, 4000);
  assert.equal(res.body.length, 4000);
  assert.ok(src.read() < 4000 + 2 * 16_384);
});

test('chunked met een enorme brok: ook dan niet meer dan het plafond', async () => {
  const src = endless('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffff\r\n');
  const res = await readHttpResponse(src.next, 4000);
  assert.equal(res.body.length, 4000);
  assert.ok(src.read() < 4000 + 2 * 16_384);
});

test('een kop die nooit ophoudt: een fout, niet eindeloos lezen', async () => {
  const src = endless('HTTP/1.1 200 OK\r\nX-Lang: ');
  await assert.rejects(readHttpResponse(src.next, 4000), /te groot/);
  assert.ok(src.read() < 64 * 1024);
});

test('geen HTTP, of de verbinding valt weg vóór het antwoord: een fout', async () => {
  await assert.rejects(readHttpResponse(source(['SSH-2.0-OpenSSH_9.6\r\n\r\n']).next, 100), /HTTP\/1\.1/);
  await assert.rejects(readHttpResponse(source(['HTTP/1.1 200 OK\r\nContent-Le']).next, 100), /sloot de verbinding/);
  await assert.rejects(readHttpResponse(source(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n']).next, 100), /chunked/);
});

test('een inhoud die eerder ophoudt dan aangekondigd: wat er is', async () => {
  const res = await readHttpResponse(source(['HTTP/1.0 502 Bad Gateway\r\nContent-Length: 50\r\n\r\nkort']).next, 4000);
  assert.equal(res.status, 502);
  assert.equal(decoder.decode(res.body), 'kort');
});

test('de kop: status en headers, dubbele samengevoegd', () => {
  const head = parseResponseHead('HTTP/1.1 302 Found\r\nLocation: https://elders/\r\nSet-Cookie: a=1\r\nset-cookie: b=2\r\nkapot');
  assert.equal(head.status, 302);
  assert.equal(head.headers.get('location'), 'https://elders/');
  assert.equal(head.headers.get('set-cookie'), 'a=1, b=2');
  assert.throws(() => parseResponseHead('HTTP/2 200'), TransportError);
});
