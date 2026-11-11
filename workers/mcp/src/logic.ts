// De regels van de Worker op het eigen adres van de AI-koppeling
// (mcp-staging.resofly.com, straks mcp.resofly.com), los van de runtime zodat
// `npm test` ze in node kan nalopen (logic.test.ts). Zie index.ts voor het
// geheel.

/** De twee edge functions achter dit adres. */
export type McpFunction = 'mcp' | 'mcp-oauth';

export type Route =
  /** Door naar een edge function, op dit pad achter de functienaam. */
  | { kind: 'function'; fn: McpFunction; path: string }
  /** Een mens die het adres in zijn browser opent. */
  | { kind: 'info' }
  | { kind: 'robots' }
  | { kind: 'notFound' };

/**
 * De paden van de autorisatieserver. De issuer is de root van het domein
 * (MCP_PUBLIC_BASE_URL, op staging https://mcp-staging.resofly.com), dus de
 * eindpunten staan daar ook: authorizationServerMetadata noemt ze als
 * `${issuer}/authorize` enzovoort.
 *
 * /consent en /approve staan er bewust niet bij. Die roept alleen ons eigen
 * toestemmingsscherm aan, rechtstreeks op Supabase (src/lib/mcp-api.ts). Een
 * AI-client heeft ze niet nodig, dus dit adres hoeft ze niet te bieden.
 */
const OAUTH_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/jwks',
]);

/**
 * Waar een client het resource-document (RFC 9728) zoekt.
 *
 * - `/mcp/.well-known/oauth-protected-resource` noemt de 401 van de MCP-server
 *   zelf (WWW-Authenticate), want die plakt het achter MCP_RESOURCE_URL.
 * - `/.well-known/oauth-protected-resource/mcp` is de plek uit de RFC: het pad
 *   van de bron achter het well-known-deel. Een client die de header niet leest,
 *   probeert die.
 * - `/.well-known/oauth-protected-resource` (zonder pad) proberen sommige
 *   clients daarna nog.
 *
 * Alle drie geven hetzelfde document. Op supabase.co was alleen de eerste van
 * ons; de root van dat domein beantwoordt Supabase zelf met een 401.
 */
const RESOURCE_METADATA_PATHS = new Set([
  '/mcp/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
]);

/**
 * Waar gaat dit verzoek heen?
 *
 * Een vaste tabel, geen doorgegeven pad: wat de client in de URL zet, bepaalt
 * alleen WELKE regel geldt, nooit waar we upstream uitkomen. Zo kan niemand via
 * dit adres bij een andere edge function komen (`/../api`, `/%2e%2e/`): die
 * paden staan niet in de tabel en worden een 404.
 */
export function routeFor(pathname: string, method: string, accept: string): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const upper = method.toUpperCase();
  const readsPage = upper === 'GET' || upper === 'HEAD';

  if (path === '/') return readsPage ? { kind: 'info' } : { kind: 'notFound' };
  if (path === '/robots.txt') return readsPage ? { kind: 'robots' } : { kind: 'notFound' };

  if (path === '/mcp') {
    // Plakt iemand het adres in zijn browser, dan kreeg hij van de MCP-server
    // "Method not allowed". Een AI-client vraagt met GET hooguit een
    // event-stream (en krijgt dan die 405); een browser vraagt HTML.
    if (readsPage && wantsHtml(accept)) return { kind: 'info' };
    return { kind: 'function', fn: 'mcp', path: '' };
  }
  if (RESOURCE_METADATA_PATHS.has(path)) {
    return { kind: 'function', fn: 'mcp', path: '/.well-known/oauth-protected-resource' };
  }
  if (OAUTH_PATHS.has(path)) return { kind: 'function', fn: 'mcp-oauth', path };
  return { kind: 'notFound' };
}

function wantsHtml(accept: string): boolean {
  const value = accept.toLowerCase();
  return value.includes('text/html') && !value.includes('text/event-stream');
}

/** Het adres van de edge function, met de query van de client erachter. */
export function upstreamUrl(supabaseUrl: string, fn: McpFunction, path: string, search: string): string {
  const base = String(supabaseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    throw new Error('SUPABASE_URL moet een https-adres zonder pad zijn.');
  }
  return `${base}/functions/v1/${fn}${path}${search}`;
}

/**
 * Met deze twee headers vertelt de Worker aan mcp-oauth wie er écht aanklopt.
 *
 * WAAROM. mcp-oauth remt registraties per IP-adres (60 per uur). Een verzoek
 * dat via een Worker bij Supabase aankomt, komt van het adres van Cloudflare
 * zelf: daar zet Cloudflare `cf-connecting-ip` op een vast Worker-adres. Zonder
 * deze headers deelden álle klanten achter het eigen adres dus één teller, en
 * zat koppelen voor iedereen dicht zodra er in een uur zestig AI-apps bij
 * kwamen. De Worker kent het echte adres wel (`cf-connecting-ip` op het
 * binnenkomende verzoek, gezet door Cloudflare) en geeft het door.
 *
 * mcp-oauth gelooft het adres alleen met het juiste geheim erbij
 * (MCP_PROXY_SECRET, aan beide kanten hetzelfde). Zonder geheim, of met een
 * verkeerd, telt het gewone adres; een client die deze headers zelf meestuurt,
 * schiet daar niets mee op. De namen moeten gelijk zijn aan die in
 * supabase/functions/_shared/mcpAuth.ts; logic.test.ts bewaakt dat.
 */
export const PROXY_CLIENT_IP_HEADER = 'x-resofly-client-ip';
export const PROXY_SECRET_HEADER = 'x-resofly-proxy-secret';

/**
 * Headers die niet mee naar Supabase gaan. Hop-by-hop-headers horen bij één
 * verbinding; de adres-headers zet Cloudflare op het verzoek naar Supabase
 * opnieuw, en de twee van ons hierboven zet alleen de Worker zelf.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'true-client-ip', 'cdn-loop',
  PROXY_CLIENT_IP_HEADER, PROXY_SECRET_HEADER,
]);

/**
 * De headers voor het verzoek naar Supabase: die van de client (Authorization,
 * Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Origin …), zonder wat
 * hierboven staat, met het echte adres van de client en het geheim erbij.
 */
export function forwardHeaders(incoming: Headers, proxySecret: string | undefined): Headers {
  const headers = new Headers();
  incoming.forEach((value, name) => {
    const key = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(key) || key.startsWith('cf-')) return;
    headers.set(key, value);
  });
  const clientIp = (incoming.get('cf-connecting-ip') || '').trim();
  const secret = String(proxySecret || '');
  if (clientIp && secret) {
    headers.set(PROXY_CLIENT_IP_HEADER, clientIp);
    headers.set(PROXY_SECRET_HEADER, secret);
  }
  return headers;
}

export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/** Voor wie het adres in een browser opent: wat dit is en wat je ermee doet. */
export function infoPage(origin: string, appUrl: string | undefined): string {
  const serverUrl = `${origin}/mcp`;
  const app = safeHttpsUrl(appUrl);
  const link = app ? `<p><a href="${escapeHtml(app)}">Naar ResoFly</a></p>` : '';
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ResoFly — koppel je eigen AI</title><style>:root{color-scheme:light dark;--bg:#f6f6f8;--fg:#15151b;--muted:#55555f;--box:#ffffff;--line:#e2e2e8;--accent:#4f46e5}@media (prefers-color-scheme:dark){:root{--bg:#15151b;--fg:#f3f3f6;--muted:#b9b9c4;--box:#1e1e26;--line:#2e2e38;--accent:#a5b4fc}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;box-sizing:border-box}main{max-width:34rem;width:100%}h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}code{display:block;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--box);color:var(--fg);font:15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;margin:0 0 16px}a{color:var(--accent)}</style></head><body><main><h1>Koppel je eigen AI aan ResoFly</h1><p>Dit adres is voor je AI-app, niet voor je browser. Voeg het in Claude, ChatGPT of Gemini toe als connector:</p><code>${escapeHtml(serverUrl)}</code><p>Hoe dat per AI-app gaat, staat in ResoFly onder Instellingen → AI. Je logt daarna in en kiest wat je AI mag.</p>${link}</main></body></html>`;
}

function safeHttpsUrl(value: string | undefined): string | null {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
