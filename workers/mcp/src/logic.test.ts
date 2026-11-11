import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, forwardHeaders, infoPage, PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER, routeFor, upstreamUrl,
} from './logic.ts';
import * as mcpAuth from '../../../supabase/functions/_shared/mcpAuth.ts';

/**
 * De Worker op mcp.resofly.com. Dit adres plakt een klant in zijn AI-app; de
 * tests hieronder bewaken dat elk pad dat een AI-client nodig heeft op de juiste
 * functie uitkomt, en dat er verder niets door kan.
 */

const MCP = { kind: 'function', fn: 'mcp', path: '' } as const;
const RESOURCE_DOC = { kind: 'function', fn: 'mcp', path: '/.well-known/oauth-protected-resource' } as const;

test('de MCP-server zelf', () => {
  assert.deepEqual(routeFor('/mcp', 'POST', 'application/json, text/event-stream'), MCP);
  assert.deepEqual(routeFor('/mcp/', 'POST', 'application/json'), MCP, 'een slash erachter is hetzelfde adres');
  assert.deepEqual(routeFor('/mcp', 'OPTIONS', '*/*'), MCP, 'de preflight van een browser-client beantwoordt de functie');
  assert.deepEqual(routeFor('/mcp', 'DELETE', ''), MCP, 'een sessie afsluiten mag de functie zelf weigeren');
  // Een AI-client die een server-naar-client-stroom wil, krijgt de 405 van de
  // functie; die hoort hij te krijgen, geen uitlegpagina.
  assert.deepEqual(routeFor('/mcp', 'GET', 'text/event-stream'), MCP);
  assert.deepEqual(routeFor('/mcp', 'GET', 'text/html, text/event-stream'), MCP);
});

test('wie het adres in een browser opent, krijgt uitleg in plaats van "Method not allowed"', () => {
  const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  assert.deepEqual(routeFor('/mcp', 'GET', browser), { kind: 'info' });
  assert.deepEqual(routeFor('/', 'GET', browser), { kind: 'info' });
  assert.deepEqual(routeFor('/', 'HEAD', ''), { kind: 'info' });
  assert.deepEqual(routeFor('/robots.txt', 'GET', ''), { kind: 'robots' });
});

test('het resource-document staat op elke plek waar een client het zoekt', () => {
  for (const path of [
    '/mcp/.well-known/oauth-protected-resource', // uit de WWW-Authenticate van de 401
    '/.well-known/oauth-protected-resource/mcp', // RFC 9728
    '/.well-known/oauth-protected-resource',
  ]) {
    assert.deepEqual(routeFor(path, 'GET', 'application/json'), RESOURCE_DOC, path);
  }
});

test('de autorisatieserver staat op de root van het domein', () => {
  for (const path of [
    '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration',
    '/authorize', '/token', '/register', '/revoke', '/jwks',
  ]) {
    assert.deepEqual(routeFor(path, path === '/token' || path === '/register' ? 'POST' : 'GET', ''), { kind: 'function', fn: 'mcp-oauth', path }, path);
  }
});

test('verder kan er niets door', () => {
  for (const path of [
    // Alleen ons eigen toestemmingsscherm gebruikt deze, rechtstreeks op Supabase.
    '/consent', '/approve',
    // Andere edge functions, ook niet met een omweg.
    '/api/v1', '/functions/v1/api', '/../api', '/%2e%2e/api', '/mcp/../api', '/mcp/tools', '/mcp-oauth/token',
    // Een metadata-plek bij een issuer met pad: die hebben we niet.
    '/.well-known/oauth-authorization-server/mcp',
    // Het adres is exact; hoofdletters zijn een ander adres.
    '/MCP', '/favicon.ico',
  ]) {
    assert.deepEqual(routeFor(path, 'GET', 'application/json'), { kind: 'notFound' }, path);
  }
  assert.deepEqual(routeFor('/', 'POST', 'application/json'), { kind: 'notFound' }, 'een POST op de root is geen MCP-aanroep');
});

test('het adres van de functie: vast pad, de query van de client erachter', () => {
  const base = 'https://enzghpduqwaojcxgwarr.supabase.co';
  assert.equal(upstreamUrl(base, 'mcp', '', ''), `${base}/functions/v1/mcp`);
  assert.equal(upstreamUrl(`${base}/`, 'mcp-oauth', '/authorize', '?client_id=x&state=y'), `${base}/functions/v1/mcp-oauth/authorize?client_id=x&state=y`);
  assert.equal(upstreamUrl(base, 'mcp', '/.well-known/oauth-protected-resource', ''), `${base}/functions/v1/mcp/.well-known/oauth-protected-resource`);
  assert.equal(upstreamUrl('http://localhost:54321', 'mcp', '', ''), 'http://localhost:54321/functions/v1/mcp');
  for (const bad of ['', 'http://project.supabase.co', 'https://project.supabase.co/functions/v1', 'project.supabase.co']) {
    assert.throws(() => upstreamUrl(bad, 'mcp', '', ''), /SUPABASE_URL/, bad);
  }
});

test('de headers van de client gaan mee, die van de verbinding niet', () => {
  const incoming = new Headers({
    authorization: 'Bearer rsfmcp.abc.def',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
    'mcp-session-id': 'sessie-1',
    origin: 'https://claude.ai',
    'user-agent': 'claude-user',
    host: 'mcp.resofly.com',
    connection: 'keep-alive',
    'cf-ray': '8f00',
    'cf-ipcountry': 'NL',
    'cf-connecting-ip': '203.0.113.7',
    'x-forwarded-for': '203.0.113.7',
    'x-real-ip': '203.0.113.7',
  });
  const out = forwardHeaders(incoming, undefined);
  for (const name of ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'origin', 'user-agent']) {
    assert.equal(out.get(name), incoming.get(name), name);
  }
  for (const name of ['host', 'connection', 'cf-ray', 'cf-ipcountry', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) {
    assert.equal(out.has(name), false, name);
  }
});

test('de Worker geeft het echte adres mee, met het geheim', () => {
  const secret = 'werker-geheim-mcp-0123456789abcdef';
  const out = forwardHeaders(new Headers({ 'cf-connecting-ip': '203.0.113.7' }), secret);
  assert.equal(out.get(PROXY_CLIENT_IP_HEADER), '203.0.113.7');
  assert.equal(out.get(PROXY_SECRET_HEADER), secret);
  // En mcp-oauth leest precies dat terug als het adres van de client.
  assert.equal(mcpAuth.senderAddress(new Headers({ ...Object.fromEntries(out), 'cf-connecting-ip': '2a06:98c0:3600::103' }), secret), '203.0.113.7');
});

test('wat een client zelf als adres of geheim meestuurt, gaat nooit door', () => {
  const spoofed = new Headers({
    'cf-connecting-ip': '203.0.113.7',
    [PROXY_CLIENT_IP_HEADER]: '192.0.2.99',
    [PROXY_SECRET_HEADER]: 'geraden',
  });
  const zonderGeheim = forwardHeaders(spoofed, undefined);
  assert.equal(zonderGeheim.has(PROXY_CLIENT_IP_HEADER), false);
  assert.equal(zonderGeheim.has(PROXY_SECRET_HEADER), false);
  const metGeheim = forwardHeaders(spoofed, 'werker-geheim-mcp-0123456789abcdef');
  assert.equal(metGeheim.get(PROXY_CLIENT_IP_HEADER), '203.0.113.7', 'het adres van Cloudflare, niet dat van de client');
  assert.equal(metGeheim.get(PROXY_SECRET_HEADER), 'werker-geheim-mcp-0123456789abcdef');
});

test('de Worker en mcp-oauth gebruiken dezelfde headernamen', () => {
  assert.equal(PROXY_CLIENT_IP_HEADER, mcpAuth.PROXY_CLIENT_IP_HEADER);
  assert.equal(PROXY_SECRET_HEADER, mcpAuth.PROXY_SECRET_HEADER);
});

test('de uitlegpagina noemt het adres en linkt alleen naar een https-app', () => {
  const page = infoPage('https://mcp.resofly.com', 'https://staging.resofly.com/');
  assert.match(page, /<code>https:\/\/mcp\.resofly\.com\/mcp<\/code>/);
  assert.match(page, /href="https:\/\/staging\.resofly\.com"/);
  assert.match(page, /<html lang="nl">/);
  assert.doesNotMatch(infoPage('https://mcp.resofly.com', 'javascript:alert(1)'), /href=/);
  assert.doesNotMatch(infoPage('https://mcp.resofly.com', undefined), /href=/);
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
