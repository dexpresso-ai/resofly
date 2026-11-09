// ResoFly — de klantadressen (Cloudflare Worker)
//
// Bedient jansen.resofly.com (een naam bij ResoFly, migratie 20261108230000)
// en portaal.jansen.nl (een eigen domein via Cloudflare for SaaS): de app voor
// klanten, in de huisstijl van die organisatie. Het plan staat in
// docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md, het inrichten in
// docs/setup/KLANTDOMEINEN_SETUP.md.
//
// Per verzoek:
//   1. Een adres van ResoFly zelf (de werkruimte, de agenda): ongewijzigd door.
//   2. Wat hoort er bij deze hostnaam? De edge function client-domains zegt
//      het (met CLIENT_DOMAINS_WORKER_SECRET); een minuut onthouden. Nooit het
//      id van de organisatie: alleen de status, het inlogadres en het merk.
//   3. Onbekend, nog niet klaar of uitgezet: een neutrale pagina.
//      Hernoemd of verhuisd: 301 naar hetzelfde pad op het nieuwe adres.
//   4. Op een eigen domein zonder portaal: het portaal door naar de naam bij
//      ResoFly. Met het portaal aan (Instellingen → Domein) blijft het hier.
//   5. Alleen de paden van een klant (logic.ts: routeFor). De HTML komt uit
//      dezelfde Pages-build als de werkruimte, met de naam van de organisatie
//      in de titel, haar icoon, en een meta die de app vertelt dat hij op een
//      klantadres draait. Geen manifest, geen service worker.
//
// Auth, REST en de edge functions roept de browser rechtstreeks aan, zoals op
// het adres van ResoFly. Via deze Worker zou elk verzoek van hetzelfde IP
// komen, en dan gaan de remmen per IP voor alle klanten tegelijk dicht.

import {
  clientHostMeta, faviconSvg, isHtmlType, isPortalPath, neutralPage, pageTitle, parseHostList, parseLookup, portalRedirectUrl, ROBOTS_TXT,
  routeFor, sameUrlOn, securityHeaders, withoutTrailingDot, type HostLookup,
} from './logic';

export interface Env {
  /** De Pages-build van deze omgeving, bijvoorbeeld https://staging.resofly.pages.dev. */
  APP_ORIGIN: string;
  /** Het Supabase-project: daar staan client-domains en email-unsubscribe. */
  SUPABASE_URL: string;
  /** De namen staan onder dit domein: <naam>.<CLIENT_DOMAIN_BASE>. */
  CLIENT_DOMAIN_BASE: string;
  /** Adressen van ResoFly zelf die deze Worker ongewijzigd doorgeeft (komma's). */
  PASSTHROUGH_HOSTS?: string;
  /** Gedeeld geheim met de edge function client-domains (wrangler secret). */
  CLIENT_DOMAINS_WORKER_SECRET: string;
}

const LOOKUP_TTL_SECONDS = 60;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // 0. Een adres met een punt aan het eind: naar hetzelfde adres zonder
    //    (logic.ts: withoutTrailingDot). Ook vóór de adressen van ResoFly zelf.
    if (url.hostname.endsWith('.')) {
      const bare = withoutTrailingDot(url.hostname);
      if (!bare) return html(neutralPage('Dit adres is niet in gebruik', 'Er staat hier (nog) niets. Controleer het adres, of neem contact op met wie je de link stuurde.'), 404);
      return new Response(null, { status: 301, headers: { location: sameUrlOn(bare, url.pathname, url.search), 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
    }
    const host = url.hostname.toLowerCase();

    // 1. De werkruimte, de agenda, het basisdomein zelf: niet van ons.
    if (parseHostList(env.PASSTHROUGH_HOSTS).has(host) || host === String(env.CLIENT_DOMAIN_BASE || '').toLowerCase()) {
      return fetch(request);
    }

    // 2. Wat hoort er bij deze hostnaam?
    let lookup: HostLookup;
    try {
      lookup = await lookupHost(host, env, ctx);
    } catch (error) {
      console.error('client-domains worker: opzoeken mislukt', error instanceof Error ? error.message : error);
      return html(neutralPage('Even niet bereikbaar', 'Deze pagina is nu even niet bereikbaar. Probeer het over een paar minuten opnieuw.'), 503);
    }

    // 3. Niets (meer) te tonen, of doorsturen.
    if (lookup.status === 'redirect') {
      const target = sameUrlOn(lookup.redirectHost, url.pathname, url.search);
      return new Response(null, { status: 301, headers: { location: target, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
    }
    if (lookup.status === 'pending') return html(neutralPage('Bijna klaar', 'Dit adres wordt op dit moment ingericht. Probeer het over een paar minuten opnieuw.'), 503);
    if (lookup.status === 'blocked') return html(neutralPage('Niet beschikbaar', 'Dit adres is niet beschikbaar.'), 410);
    if (lookup.status !== 'active') return html(neutralPage('Dit adres is niet in gebruik', 'Er staat hier (nog) niets. Controleer het adres, of neem contact op met wie je de link stuurde.'), 404);

    // 4. Het portaal op een eigen domein alleen als de organisatie het aanzette
    //    (logic.ts: isPortalPath). Anders door naar de naam bij ResoFly.
    //    Documenten met een token blijven hier.
    if (lookup.kind === 'custom' && !lookup.portalEnabled && isPortalPath(url.pathname)) {
      const target = portalRedirectUrl(url.pathname, url.search, lookup.portalHost);
      if (!target) return html(neutralPage('Pagina niet gevonden', 'Het klantportaal staat niet op dit adres.'), 404);
      return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' } });
    }

    // 5. Alleen de paden van een klant.
    const route = routeFor(url.pathname, request.method, lookup.portalKey);
    switch (route.kind) {
      case 'method':
        return new Response('Methode niet toegestaan', { status: 405, headers: { allow: 'GET, HEAD', 'x-robots-tag': 'noindex, nofollow' } });
      case 'notFound':
        return html(neutralPage('Pagina niet gevonden', 'Deze pagina bestaat niet. Controleer de link uit je mail.'), 404);
      case 'robots':
        return new Response(ROBOTS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
      case 'favicon':
        return new Response(faviconSvg(lookup.brand.name, lookup.brand.accentColor), {
          headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' },
        });
      case 'unsubscribe':
        return unsubscribe(request, url, env);
      case 'asset':
        return asset(request, url, env);
      case 'page':
        return page(request, env, lookup, route.tokenPage);
    }
  },
};

async function lookupHost(host: string, env: Env, ctx: ExecutionContext): Promise<HostLookup> {
  const cache = caches.default;
  const key = new Request(`https://client-domains.lookup/${encodeURIComponent(host)}`);
  const hit = await cache.match(key);
  if (hit) return parseLookup(await hit.json());

  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/client-domains`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-domains-secret': env.CLIENT_DOMAINS_WORKER_SECRET },
    body: JSON.stringify({ host }),
  });
  if (!res.ok) throw new Error(`lookup HTTP ${res.status}`);
  const payload = await res.json();
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json', 'cache-control': `max-age=${LOOKUP_TTL_SECONDS}` },
  })));
  return parseLookup(payload);
}

/** De HTML van de app, met de naam en het icoon van de organisatie. */
async function page(request: Request, env: Env, lookup: Extract<HostLookup, { status: 'active' }>, tokenPage: boolean): Promise<Response> {
  const upstream = await fetch(`${env.APP_ORIGIN.replace(/\/+$/, '')}/`, { headers: { accept: 'text/html' } });
  if (!upstream.ok) return html(neutralPage('Even niet bereikbaar', 'Deze pagina is nu even niet bereikbaar. Probeer het over een paar minuten opnieuw.'), 502);
  const headers = securityHeaders(upstream.headers, { tokenPage });
  headers.set('content-type', 'text/html; charset=utf-8');
  const title = pageTitle(lookup.brand.name);
  const rewritten = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    // Het manifest en de naam op het beginscherm horen bij de werkruimte.
    .on('link[rel="manifest"]', { element(el) { el.remove(); } })
    .on('meta[name="apple-mobile-web-app-title"]', { element(el) { el.setAttribute('content', lookup.brand.name ?? 'Klantportaal'); } })
    .on('link[rel="icon"]', { element(el) { el.setAttribute('href', '/favicon.svg'); el.setAttribute('type', 'image/svg+xml'); } })
    .on('link[rel="apple-touch-icon"]', { element(el) { el.remove(); } })
    .on('head', {
      element(el) {
        const customPortal = lookup.kind === 'custom' && lookup.portalEnabled;
        el.append(clientHostMeta(lookup.host, lookup.portalKey, lookup.kind === 'custom' && !lookup.portalEnabled ? lookup.portalHost : null, customPortal), { html: true });
        el.append('<meta name="robots" content="noindex,nofollow">', { html: true });
        if (lookup.brand.name) {
          const name = lookup.brand.name.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
          el.append(`<meta property="og:site_name" content="${name}"><meta property="og:title" content="${name}">`, { html: true });
        }
      },
    })
    .transform(new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers }));
  return rewritten;
}

/** Een bestand van de app (scripts, stijlen, lettertypen, iconen), ongewijzigd uit Pages. */
async function asset(request: Request, url: URL, env: Env): Promise<Response> {
  const upstream = await fetch(`${env.APP_ORIGIN.replace(/\/+$/, '')}${url.pathname}${url.search}`, { method: request.method });
  // Een bestand dat niet bestaat, geeft Pages als de app zelf (logic.ts: isHtmlType).
  if (isHtmlType(upstream.headers.get('content-type'))) {
    await upstream.body?.cancel();
    return html(neutralPage('Pagina niet gevonden', 'Deze pagina bestaat niet. Controleer de link uit je mail.'), 404);
  }
  const headers = new Headers(upstream.headers);
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.delete('set-cookie');
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** De afmeldlink uit een nieuwsbrief (ook de one-click POST), doorgegeven aan email-unsubscribe. */
async function unsubscribe(request: Request, url: URL, env: Env): Promise<Response> {
  const target = `${env.SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/email-unsubscribe${url.search}`;
  const init: RequestInit = { method: request.method, headers: { 'content-type': request.headers.get('content-type') ?? 'text/plain' } };
  if (request.method === 'POST') init.body = await request.text();
  const upstream = await fetch(target, init);
  const headers = new Headers(upstream.headers);
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('referrer-policy', 'no-referrer');
  headers.delete('set-cookie');
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
