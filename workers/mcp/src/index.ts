// ResoFly — het adres van de AI-koppeling (Cloudflare Worker)
//
// https://mcp.resofly.com/mcp is wat een klant in zijn AI-app plakt. Daarvoor
// was dat https://<project>.supabase.co/functions/v1/mcp: het werkte, maar het
// was het adres van onze leverancier, met een projectcode erin, en het
// veranderde zodra we van Supabase-project wisselden.
//
// Achter dit adres staan dezelfde twee edge functions als altijd: mcp (de
// MCP-server) en mcp-oauth (de autorisatieserver). Deze Worker stuurt door en
// verandert niets aan wat er heen en weer gaat. Onder welk adres ze bekendstaan,
// weten de functies zelf: MCP_RESOURCE_URL en MCP_PUBLIC_BASE_URL in de
// Supabase-secrets. Het plan en de uitrol staan in
// docs/setup/MCP_CONNECTOR_SETUP.md ("Het eigen adres").
//
// Wat de Worker wél doet:
//   - alleen de paden uit de tabel in logic.ts (routeFor), elk naar een vast
//     pad op een vaste functie. Andere edge functions zijn hier niet te
//     bereiken;
//   - het echte IP-adres van de client meegeven, met een geheim, zodat de rem
//     op registraties per client blijft tellen en niet voor iedereen tegelijk
//     dichtgaat (zie PROXY_CLIENT_IP_HEADER);
//   - redirects niet zelf volgen. /authorize stuurt de browser met een 302 naar
//     het toestemmingsscherm; die hoort bij de browser aan te komen, niet hier;
//   - een korte uitleg tonen aan wie het adres in een browser opent.

import { forwardHeaders, infoPage, ROBOTS_TXT, routeFor, upstreamUrl } from './logic.ts';

export interface Env {
  /** Het Supabase-project, bijvoorbeeld https://enzghpduqwaojcxgwarr.supabase.co. */
  SUPABASE_URL: string;
  /** De app, voor de link op de uitlegpagina. */
  APP_URL?: string;
  /** Gedeeld geheim met mcp-oauth (wrangler secret, NIET in wrangler.toml). */
  MCP_PROXY_SECRET?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, fetch);
  },
};

/**
 * Het hele verzoek. `fetcher` staat los zodat index.test.ts een Supabase kan
 * nabootsen die niet antwoordt: in Miniflare wordt zo'n fout een 500 van
 * Miniflare zelf, en dan was de 502 hieronder nergens getest.
 */
export async function handle(request: Request, env: Env, fetcher: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const route = routeFor(url.pathname, request.method, request.headers.get('accept') || '');

  if (route.kind === 'info') return page(infoPage(url.origin, env.APP_URL), request.method);
  if (route.kind === 'robots') {
    return new Response(request.method === 'HEAD' ? null : ROBOTS_TXT, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  }
  if (route.kind === 'notFound') {
    return json({
      error: 'not_found',
      error_description: `Dit pad bestaat hier niet. De MCP-server van ResoFly staat op ${url.origin}/mcp.`,
    }, 404);
  }

  let target: string;
  try {
    target = upstreamUrl(env.SUPABASE_URL, route.fn, route.path, url.search);
  } catch (error) {
    console.error('mcp worker: instelling klopt niet', error instanceof Error ? error.message : error);
    return json({ error: 'server_error', error_description: 'De koppelserver is niet goed ingesteld.' }, 500);
  }

  const method = request.method.toUpperCase();
  try {
    return await fetcher(target, {
      method,
      headers: forwardHeaders(request.headers, env.MCP_PROXY_SECRET),
      body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
  } catch (error) {
    // Komt Supabase niet tot antwoord, dan zegt een 502 de AI-client dat het
    // aan ons ligt en dat hij het zo nog eens kan proberen. Een 401 zou hem
    // opnieuw laten koppelen, en dat lost niets op.
    console.error('mcp worker: Supabase onbereikbaar', error instanceof Error ? error.message : error);
    return json({
      error: 'temporarily_unavailable',
      error_description: 'De koppelserver is even niet bereikbaar. Probeer het zo opnieuw.',
    }, 502);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}

function page(body: string, method: string): Response {
  return new Response(method.toUpperCase() === 'HEAD' ? null : body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
