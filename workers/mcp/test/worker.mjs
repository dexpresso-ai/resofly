#!/usr/bin/env node
/*
 * De Worker op mcp.resofly.com in workerd (Miniflare), met nagebootste edge
 * functions mcp en mcp-oauth. Geen netwerk: elke uitgaande aanroep van de
 * Worker komt hier binnen en wordt vastgelegd.
 *
 *   cd workers/mcp && npm install && node test/worker.mjs
 *
 * Controleert: elk pad dat een AI-client nodig heeft, komt op de juiste functie
 * uit, met methode, headers en inhoud ongeschonden; het antwoord komt ongewijzigd
 * terug (ook de 401 met WWW-Authenticate en de 302 van /authorize, die de Worker
 * niet zelf volgt); het echte adres van de client gaat mee met het geheim, en
 * een opgegeven adres van de client niet; andere paden komen nergens; een
 * browser krijgt uitleg. Een Supabase die niet antwoordt, test src/index.test.ts:
 * Miniflare maakt van zo'n fout zelf een 500.
 */
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE = 'https://project.supabase.test';
const APP = 'https://staging.resofly.test';
const SECRET = 'werker-geheim-mcp-0123456789abcdef';
const BASE = 'https://mcp.resofly.com';

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? ' ok ' : 'FAIL'} ${label}${!ok && detail ? `  ← ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const outbound = [];

async function outboundService(request) {
  const url = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
  outbound.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body });
  if (url.origin !== SUPABASE) return new Response('niet nagebootst', { status: 599 });

  switch (url.pathname) {
    case '/functions/v1/mcp': {
      if (request.method === 'OPTIONS') {
        return new Response('ok', { headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version' } });
      }
      if (!request.headers.get('authorization')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer realm="ResoFly", resource_metadata="${BASE}/mcp/.well-known/oauth-protected-resource"` },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { echo: JSON.parse(body) } }), {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'sessie-terug' },
      });
    }
    case '/functions/v1/mcp/.well-known/oauth-protected-resource':
      return Response.json({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    case '/functions/v1/mcp-oauth/.well-known/oauth-authorization-server':
      return Response.json({ issuer: BASE, token_endpoint: `${BASE}/token` });
    case '/functions/v1/mcp-oauth/authorize':
      return new Response(null, { status: 302, headers: { location: `${APP}/mcp/authorize?request=ondertekend` } });
    case '/functions/v1/mcp-oauth/register':
      return Response.json({ client_id: 'client-1' }, { status: 201 });
    case '/functions/v1/mcp-oauth/token':
      return Response.json({ access_token: 'rsfmcp.a.b', token_type: 'Bearer' }, { headers: { 'cache-control': 'no-store' } });
    default:
      return new Response('niet nagebootst', { status: 599 });
  }
}

const bundle = await build({
  entryPoints: [path.join(ROOT, 'src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, target: 'es2022',
});
const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-07-01',
  bindings: { SUPABASE_URL: SUPABASE, APP_URL: APP, MCP_PROXY_SECRET: SECRET },
  outboundService,
});

try {
  const send = (pad, init = {}) => mf.dispatchFetch(`${BASE}${pad}`, { redirect: 'manual', ...init });
  const last = () => outbound[outbound.length - 1];

  // De MCP-server zonder token: de 401 met de wegwijzer komt ongewijzigd terug.
  outbound.length = 0;
  const rpc = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  let res = await send('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: rpc });
  check('een aanroep zonder token geeft de 401 van de functie', res.status === 401, `${res.status}`);
  check('met de WWW-Authenticate die naar het resource-document wijst', (res.headers.get('www-authenticate') || '').includes(`${BASE}/mcp/.well-known/oauth-protected-resource`));
  await res.text();
  check('naar de functie mcp, met dezelfde methode en inhoud', last()?.url === `${SUPABASE}/functions/v1/mcp` && last()?.method === 'POST' && last()?.body === rpc, JSON.stringify(last()));

  // Met token: de headers van de client gaan mee, die van het antwoord komen terug.
  res = await send('/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer rsfmcp.x.y', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18', 'mcp-session-id': 'sessie-heen' },
    body: rpc,
  });
  const echoed = await res.json();
  check('een aanroep met token komt aan en het antwoord komt terug', res.status === 200 && echoed?.result?.echo?.method === 'tools/list', JSON.stringify(echoed));
  check('Authorization, protocolversie en sessie gaan mee', last()?.headers.authorization === 'Bearer rsfmcp.x.y' && last()?.headers['mcp-protocol-version'] === '2025-06-18' && last()?.headers['mcp-session-id'] === 'sessie-heen');
  check('de sessie-header van het antwoord komt terug', res.headers.get('mcp-session-id') === 'sessie-terug');

  // De preflight van een client in een browser.
  res = await send('/mcp', { method: 'OPTIONS', headers: { origin: 'https://inspector.test', 'access-control-request-method': 'POST' } });
  check('een preflight beantwoordt de functie', res.status === 200 && res.headers.get('access-control-allow-origin') === '*' && last()?.method === 'OPTIONS');
  await res.text();

  // Discovery.
  for (const pad of ['/mcp/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    res = await send(pad);
    const doc = await res.json();
    check(`het resource-document op ${pad}`, res.status === 200 && doc.resource === `${BASE}/mcp` && last()?.url === `${SUPABASE}/functions/v1/mcp/.well-known/oauth-protected-resource`, JSON.stringify(last()?.url));
  }
  res = await send('/.well-known/oauth-authorization-server');
  check('de metadata van de autorisatieserver op de root', res.status === 200 && (await res.json()).issuer === BASE && last()?.url === `${SUPABASE}/functions/v1/mcp-oauth/.well-known/oauth-authorization-server`);

  // /authorize: de 302 gaat naar de browser, de Worker volgt hem niet.
  outbound.length = 0;
  res = await send('/authorize?client_id=client-1&state=abc&response_type=code');
  check('/authorize stuurt de browser door naar het toestemmingsscherm', res.status === 302 && res.headers.get('location') === `${APP}/mcp/authorize?request=ondertekend`, `${res.status} ${res.headers.get('location')}`);
  check('met de query van de client erbij', last()?.url === `${SUPABASE}/functions/v1/mcp-oauth/authorize?client_id=client-1&state=abc&response_type=code`);
  check('zonder de redirect zelf te volgen', outbound.length === 1, JSON.stringify(outbound.map(o => o.url)));

  // Registreren: het echte adres gaat mee, met het geheim; een opgegeven adres niet.
  const registration = JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
  res = await send('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', 'x-resofly-client-ip': '192.0.2.99', 'x-resofly-proxy-secret': 'geraden', 'x-forwarded-for': '192.0.2.99' },
    body: registration,
  });
  check('registreren komt aan', res.status === 201 && last()?.url === `${SUPABASE}/functions/v1/mcp-oauth/register` && last()?.body === registration);
  await res.text();
  check('met het echte adres van de client', last()?.headers['x-resofly-client-ip'] === '203.0.113.7', JSON.stringify(last()?.headers));
  check('en het geheim van de Worker, niet dat van de client', last()?.headers['x-resofly-proxy-secret'] === SECRET);
  check('zonder het x-forwarded-for van de client', last()?.headers['x-forwarded-for'] !== '192.0.2.99');

  // Token: een formulier, ongeschonden heen, het antwoord met zijn headers terug.
  const form = 'grant_type=authorization_code&code=abc&code_verifier=xyz&client_id=client-1';
  res = await send('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  check('een token ophalen komt aan', res.status === 200 && last()?.body === form && last()?.headers['content-type'] === 'application/x-www-form-urlencoded');
  check('het antwoord houdt cache-control: no-store', res.headers.get('cache-control') === 'no-store');
  await res.text();

  // Wat hier niet hoort.
  outbound.length = 0;
  for (const pad of ['/consent?request=x', '/approve', '/api/v1/me', '/functions/v1/api', '/mcp-oauth/token']) {
    res = await send(pad, { method: pad === '/approve' ? 'POST' : 'GET' });
    const text = await res.text();
    check(`${pad} bestaat hier niet`, res.status === 404 && text.includes(`${BASE}/mcp`), `${res.status} ${text.slice(0, 120)}`);
  }
  check('en daarvoor ging er niets naar Supabase', outbound.length === 0, JSON.stringify(outbound.map(o => o.url)));

  // Een mens in een browser.
  res = await send('/mcp', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  let html = await res.text();
  check('wie /mcp in een browser opent, krijgt uitleg', res.status === 200 && html.includes(`<code>${BASE}/mcp</code>`) && html.includes(`href="${APP}"`));
  check('die pagina komt niet in een zoekmachine en laadt niets van buiten', res.headers.get('x-robots-tag') === 'noindex, nofollow' && (res.headers.get('content-security-policy') || '').startsWith("default-src 'none'"));
  res = await send('/');
  html = await res.text();
  check('de root geeft dezelfde uitleg', res.status === 200 && html.includes('Koppel je eigen AI aan ResoFly'));
  res = await send('/robots.txt');
  check('robots.txt houdt zoekmachines weg', res.status === 200 && (await res.text()).includes('Disallow: /'));
  check('voor geen van deze ging er iets naar Supabase', outbound.length === 0);

} finally {
  await mf.dispose();
}

if (failures.length) {
  console.error(`\n${failures.length} controle(s) mislukt.`);
  process.exit(1);
}
console.log('\nDe Worker op mcp.resofly.com doet wat hij hoort te doen.');
