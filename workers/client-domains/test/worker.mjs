#!/usr/bin/env node
/*
 * De Worker van de klantadressen in workerd (Miniflare), met nagebootste
 * Pages-build en een nagebootste edge function client-domains. Geen netwerk:
 * elke uitgaande aanroep van de Worker komt hier binnen en wordt vastgelegd.
 *
 *   cd workers/client-domains && npm install && node test/worker.mjs
 *
 * Controleert: adressen van ResoFly gaan ongewijzigd door; een onbekend,
 * wachtend of geblokkeerd adres toont een neutrale pagina; een hernoemd adres
 * stuurt met 301 door naar hetzelfde pad; alleen de paden van een klant; de
 * HTML krijgt de naam, het icoon en de meta voor de app, zonder manifest; de
 * headers (geen zoekmachine, geen Referer op een tokenpagina, de CSP uit de
 * build); afmelden gaat door naar email-unsubscribe (ook de one-click POST);
 * de Worker stuurt zijn geheim mee en onthoudt een antwoord een minuut; een
 * ontbrekend bestand is een 404 en geen app; een adres met een punt aan het
 * eind stuurt door naar het adres zonder.
 */
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'werker-geheim-klantdomeinen';
const APP = 'https://app-build.test';
const SUPABASE = 'https://project.supabase.test';
const KEY = 'jansen-ab3kzxq2mp';

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? ' ok ' : 'FAIL'} ${label}${!ok && detail ? `  ← ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const INDEX_HTML = `<!doctype html><html lang="nl"><head><meta charset="UTF-8"/><title>ResoFly Werkruimte</title><meta name="theme-color" content="#09090A"/><link rel="manifest" href="/manifest.webmanifest"/><link rel="icon" type="image/png" href="/icons/icon-192.png"/><link rel="apple-touch-icon" href="/icons/icon-192.png"/><meta name="apple-mobile-web-app-title" content="ResoFly"/></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;
const CSP = "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'sha256-x'";

const outbound = [];
const lookups = new Map([
  ['jansen.resofly.com', { ok: true, status: 'active', kind: 'subdomain', host: 'jansen.resofly.com', portalKey: KEY, brand: { name: 'Fotostudio "Jansen"', accentColor: '#2E8B76', headerColor: null, clientTheme: 'dark', hidePoweredBy: false } }],
  ['portaal.jansen.nl', { ok: true, status: 'active', kind: 'custom', host: 'portaal.jansen.nl', portalKey: KEY, portalHost: 'jansen.resofly.com', brand: { name: 'Fotostudio Jansen', accentColor: '#2E8B76', headerColor: null } }],
  ['portaal.zonder-naam.nl', { ok: true, status: 'active', kind: 'custom', host: 'portaal.zonder-naam.nl', portalKey: null, portalHost: null, brand: { name: 'Zonder naam', accentColor: null, headerColor: null } }],
  ['portaal.pietersen.nl', { ok: true, status: 'active', kind: 'custom', host: 'portaal.pietersen.nl', portalKey: null, portalEnabled: true, portalHost: null, brand: { name: 'Drukkerij Pietersen', accentColor: '#AA3355', headerColor: null } }],
  ['oud-jansen.resofly.com', { ok: true, status: 'redirect', redirectHost: 'jansen.resofly.com' }],
  ['wacht.jansen.nl', { ok: true, status: 'pending' }],
  ['fout.resofly.com', { ok: true, status: 'blocked' }],
]);

async function outboundService(request) {
  const url = new URL(request.url);
  outbound.push({ method: request.method, url: request.url, secret: request.headers.get('x-client-domains-secret') });
  if (url.origin === SUPABASE && url.pathname === '/functions/v1/client-domains') {
    if (request.headers.get('x-client-domains-secret') !== SECRET) return new Response(JSON.stringify({ ok: false }), { status: 401 });
    const { host } = await request.json();
    return Response.json(lookups.get(host) ?? { ok: true, status: 'unknown' });
  }
  if (url.origin === SUPABASE && url.pathname === '/functions/v1/email-unsubscribe') {
    const body = request.method === 'POST' ? await request.text() : '';
    return new Response(`<html><body>afgemeld ${url.searchParams.get('token')} ${request.method} ${body}</body></html>`, { headers: { 'content-type': 'text/html' } });
  }
  if (url.origin === APP && url.pathname === '/') {
    return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html', 'content-security-policy': CSP, 'strict-transport-security': 'max-age=31536000; includeSubDomains', 'x-frame-options': 'DENY' } });
  }
  if (url.origin === APP && url.pathname === '/assets/index-abc.js') {
    return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' } });
  }
  // Zoals Pages: een bestand dat niet bestaat, geeft de app zelf (index.html, 200).
  if (url.origin === APP && /^\/(assets|fonts|icons)\//.test(url.pathname)) {
    return new Response(INDEX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (url.hostname === 'staging.resofly.com') return new Response('werkruimte', { headers: { 'content-type': 'text/plain' } });
  return new Response('niet nagebootst', { status: 599 });
}

const bundle = await build({
  entryPoints: [path.join(ROOT, 'src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, target: 'es2022',
});
const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-07-01',
  bindings: {
    APP_ORIGIN: APP,
    SUPABASE_URL: SUPABASE,
    CLIENT_DOMAIN_BASE: 'resofly.com',
    PASSTHROUGH_HOSTS: 'staging.resofly.com,caldav.resofly.com',
    CLIENT_DOMAINS_WORKER_SECRET: SECRET,
  },
  outboundService,
});

try {
  const get = (url, init) => mf.dispatchFetch(url, { redirect: 'manual', ...init });

  // Adressen van ResoFly zelf: ongewijzigd door, zonder opzoeken.
  outbound.length = 0;
  let res = await get('https://staging.resofly.com/dashboard');
  check('de werkruimte gaat ongewijzigd door', res.status === 200 && (await res.text()) === 'werkruimte' && outbound.length === 1 && outbound[0].url === 'https://staging.resofly.com/dashboard');
  check('zonder het geheim te gebruiken', !outbound.some(o => o.url.includes('client-domains')));

  // Een actief klantadres: de app, in de huisstijl.
  outbound.length = 0;
  res = await get('https://jansen.resofly.com/portal');
  const html = await res.text();
  check('het portaal op een naam bij ResoFly', res.status === 200, `${res.status}`);
  check('de Worker stuurt zijn geheim mee', outbound.find(o => o.url.includes('client-domains'))?.secret === SECRET);
  check('de titel is de naam van de organisatie', html.includes('<title>Fotostudio "Jansen" · Klantportaal</title>'), html.slice(0, 300));
  check('de meta voor de app, met adres en inlogsleutel', html.includes('name="resofly-client-host"') && html.includes('&quot;host&quot;:&quot;jansen.resofly.com&quot;') && html.includes(KEY));
  check('geen manifest en geen icoon van de werkruimte', !html.includes('manifest.webmanifest') && !html.includes('apple-touch-icon') && html.includes('href="/favicon.svg"'));
  check('de naam in og:site_name, ge-escaped', html.includes('<meta property="og:site_name" content="Fotostudio &quot;Jansen&quot;">'));
  check('de CSP uit de build komt mee', res.headers.get('content-security-policy') === CSP);
  check('nooit in een zoekmachine', res.headers.get('x-robots-tag') === 'noindex, nofollow');
  check('HSTS zonder includeSubDomains', res.headers.get('strict-transport-security') === 'max-age=31536000');

  // Een minuut onthouden: de tweede keer geen nieuwe vraag aan client-domains.
  outbound.length = 0;
  await (await get('https://jansen.resofly.com/')).text();
  check('het antwoord wordt onthouden', !outbound.some(o => o.url.includes('client-domains')), JSON.stringify(outbound));

  // Een pagina met een token: geen Referer naar buiten.
  res = await get('https://jansen.resofly.com/invoice/abcdefghijklmnopqrstuvwx');
  check('een factuurlink opent, zonder Referer', res.status === 200 && res.headers.get('referrer-policy') === 'no-referrer');
  await res.text();

  // Een eigen domein: documenten wel, het portaal niet (de sessie hoort op de naam bij ResoFly).
  res = await get('https://portaal.jansen.nl/gallerij/abcdefghijklmnopqrstuvwx');
  const album = await res.text();
  check('een album op een eigen domein', res.status === 200 && album.includes('&quot;host&quot;:&quot;portaal.jansen.nl&quot;'));
  check('met de naam bij ResoFly in de meta', album.includes('&quot;portalHost&quot;:&quot;jansen.resofly.com&quot;'));
  check('zonder sleutelmodus (daar staat het portaal niet)', !album.includes('portalMode'));
  for (const [pad, doel] of [['/', 'https://jansen.resofly.com/portal'], ['/portal', 'https://jansen.resofly.com/portal'], ['/portal/inloggen?aanvraag=abc', 'https://jansen.resofly.com/portal/inloggen?aanvraag=abc'], [`/portal/${KEY}`, `https://jansen.resofly.com/portal/${KEY}`]]) {
    res = await get(`https://portaal.jansen.nl${pad}`);
    check(`het portaal op een eigen domein (${pad}) gaat door naar de naam bij ResoFly`, res.status === 302 && res.headers.get('location') === doel, `${res.status} ${res.headers.get('location')}`);
  }
  res = await get('https://portaal.zonder-naam.nl/portal');
  check('een eigen domein zonder naam bij ResoFly: geen portaal', res.status === 404);
  await res.text();

  // Het portaal aangezet op het eigen domein (Instellingen → Domein): het blijft hier.
  for (const pad of ['/', '/portal', '/portal/inloggen?aanvraag=abc']) {
    res = await get(`https://portaal.pietersen.nl${pad}`);
    const tekst = await res.text();
    check(`het portaal aan op een eigen domein (${pad}): de app, hier`, res.status === 200 && tekst.includes('&quot;host&quot;:&quot;portaal.pietersen.nl&quot;'), `${res.status} ${res.headers.get('location')}`);
    check(`zonder doorstuuradres in de meta (${pad})`, !tekst.includes('portalHost'));
    check(`met inloggen via een sleutel in de meta (${pad})`, tekst.includes('&quot;portalMode&quot;:&quot;token&quot;'));
  }
  res = await get('https://portaal.pietersen.nl/portal/inloggen?aanvraag=abc');
  check('de inloglink op een eigen domein: geen Referer naar buiten', res.headers.get('referrer-policy') === 'no-referrer');
  await res.text();
  for (const p of ['/portal/voorbeeld', '/dashboard']) {
    res = await get(`https://portaal.pietersen.nl${p}`);
    check(`${p} op een eigen domein met portaal: 404`, res.status === 404, `${res.status}`);
    await res.text();
  }

  // Niet de werkruimte, niet /mcp, niet het voorbeeld, niet de sleutel van een ander.
  for (const p of ['/dashboard', '/mcp/authorize', '/portal/voorbeeld', '/portal/andere-org-ab3kzxq2mp', '/sw.js']) {
    res = await get(`https://jansen.resofly.com${p}`);
    check(`${p} geeft 404`, res.status === 404, `${res.status}`);
    await res.text();
  }
  res = await get(`https://jansen.resofly.com/portal/${KEY}`);
  check('het eigen inlogadres mag', res.status === 200);
  await res.text();
  res = await get('https://jansen.resofly.com/portal', { method: 'POST', body: 'x' });
  check('POST op een pagina: 405', res.status === 405);
  await res.text();

  // Bestanden van de app: ongewijzigd uit de build.
  res = await get('https://jansen.resofly.com/assets/index-abc.js');
  check('scripts komen uit de build, met hun cache', res.status === 200 && (await res.text()) === 'console.log(1)' && res.headers.get('cache-control')?.includes('immutable'));

  // Een bestand dat niet bestaat: geen app (en dus geen inlogscherm van de werkruimte) op het klantadres.
  for (const p of ['/assets/bestaat-niet.js', '/fonts/x', '/icons/x/../../dashboard']) {
    res = await get(`https://portaal.pietersen.nl${p}`);
    const tekst = await res.text();
    check(`${p}: 404, niet de app`, res.status === 404 && !tekst.includes('<div id="root">'), `${res.status} ${tekst.slice(0, 80)}`);
  }

  // Een punt aan het eind van het adres: hetzelfde adres zonder (anders keurde de app de meta af).
  res = await get('https://portaal.pietersen.nl./portal?x=1');
  check('een adres met een punt aan het eind stuurt door naar het adres zonder', res.status === 301 && res.headers.get('location') === 'https://portaal.pietersen.nl/portal?x=1', `${res.status} ${res.headers.get('location')}`);
  res = await get('https://staging.resofly.com./dashboard');
  check('ook bij een adres van ResoFly zelf', res.status === 301 && res.headers.get('location') === 'https://staging.resofly.com/dashboard', `${res.status} ${res.headers.get('location')}`);

  // Hernoemd: 301 naar hetzelfde pad op het nieuwe adres.
  res = await get('https://oud-jansen.resofly.com/invoice/abc?x=1');
  check('een oude naam stuurt door', res.status === 301 && res.headers.get('location') === 'https://jansen.resofly.com/invoice/abc?x=1', `${res.status} ${res.headers.get('location')}`);
  // Geen open redirect: een pad dat met // begint blijft op het nieuwe adres.
  res = await get('https://oud-jansen.resofly.com//evil.example/x');
  const doel = res.headers.get('location') ?? '';
  check('een pad met // stuurt niet naar een ander domein', res.status === 301 && new URL(doel).hostname === 'jansen.resofly.com', `${res.status} ${doel}`);

  // Onbekend, wachtend, geblokkeerd: neutraal, zonder merk.
  res = await get('https://bestaat-niet.resofly.com/portal');
  const unknown = await res.text();
  check('een onbekend adres: 404, neutraal', res.status === 404 && unknown.includes('niet in gebruik') && !unknown.includes('ResoFly Werkruimte'));
  res = await get('https://wacht.jansen.nl/');
  check('een eigen domein dat nog wacht: 503', res.status === 503 && (await res.text()).includes('Bijna klaar'));
  res = await get('https://fout.resofly.com/');
  check('een geblokkeerd adres: 410', res.status === 410);
  await res.text();

  // Afmelden: door naar email-unsubscribe, ook de one-click POST.
  res = await get('https://jansen.resofly.com/afmelden?token=t123');
  check('afmelden (GET) gaat door', res.status === 200 && (await res.text()).includes('afgemeld t123 GET'));
  res = await get('https://jansen.resofly.com/afmelden?token=t123', { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check('afmelden met één klik (POST) gaat door', res.status === 200 && (await res.text()).includes('afgemeld t123 POST List-Unsubscribe=One-Click'));

  // Het icoon en robots.txt.
  res = await get('https://jansen.resofly.com/favicon.svg');
  const svg = await res.text();
  check('het icoon: de eerste letter op de merkkleur', res.headers.get('content-type') === 'image/svg+xml' && svg.includes('fill="#2E8B76"') && svg.includes('>F</text>'));
  res = await get('https://jansen.resofly.com/robots.txt');
  check('robots.txt houdt zoekmachines buiten', (await res.text()).includes('Disallow: /'));
} finally {
  await mf.dispose();
}

console.log(`\n${failures.length ? `${failures.length} controle(s) mislukt.` : 'Alle controles geslaagd.'}`);
process.exit(failures.length ? 1 : 0);
