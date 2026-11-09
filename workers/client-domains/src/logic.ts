// De regels van de Worker op de klantadressen, los te testen (logic.test.ts).
// Geen Workers-API's hier: alleen beslissingen en tekst.
//
// Zie src/index.ts voor wat de Worker doet, en
// docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md voor het waarom.

/** Wat de edge function client-domains (lookup) over een hostnaam zegt. */
export type HostLookup =
  | {
    status: 'active';
    kind: 'subdomain' | 'custom';
    host: string;
    portalKey: string | null;
    /** Staat het klantportaal hier? Op een naam bij ResoFly altijd; op een eigen domein als de organisatie het aanzette. */
    portalEnabled: boolean;
    /** Bij een eigen domein zonder portaal: de naam bij ResoFly, waar het portaal woont. */
    portalHost: string | null;
    brand: { name: string | null; accentColor: string | null; headerColor: string | null; clientTheme?: string | null; hidePoweredBy?: boolean };
  }
  | { status: 'redirect'; redirectHost: string }
  | { status: 'pending' | 'blocked' | 'unknown' };

export function parseLookup(value: unknown): HostLookup {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.ok !== true) return { status: 'unknown' };
  if (v.status === 'redirect' && typeof v.redirectHost === 'string' && /^[a-z0-9.-]+$/i.test(v.redirectHost)) {
    return { status: 'redirect', redirectHost: v.redirectHost.toLowerCase() };
  }
  if (v.status === 'active' && typeof v.host === 'string') {
    const brand = (v.brand ?? {}) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x : null);
    const kind = v.kind === 'custom' ? 'custom' : 'subdomain';
    return {
      status: 'active',
      kind,
      host: v.host.toLowerCase(),
      // Een oudere edge function zegt niets: dan geen portaal op een eigen domein.
      portalEnabled: kind === 'subdomain' || v.portalEnabled === true,
      portalKey: typeof v.portalKey === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-z2-7]{10}$/.test(v.portalKey) ? v.portalKey : null,
      portalHost: typeof v.portalHost === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v.portalHost) ? v.portalHost.toLowerCase() : null,
      brand: {
        name: str(brand.name),
        accentColor: typeof brand.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(brand.accentColor) ? brand.accentColor : null,
        headerColor: typeof brand.headerColor === 'string' && /^#[0-9a-f]{6}$/i.test(brand.headerColor) ? brand.headerColor : null,
        clientTheme: str(brand.clientTheme),
        hidePoweredBy: brand.hidePoweredBy === true,
      },
    };
  }
  if (v.status === 'pending' || v.status === 'blocked') return { status: v.status };
  return { status: 'unknown' };
}

export type Route =
  | { kind: 'page'; tokenPage: boolean }
  | { kind: 'asset' }
  | { kind: 'unsubscribe' }
  | { kind: 'robots' }
  | { kind: 'favicon' }
  | { kind: 'notFound' }
  | { kind: 'method' };

const TOKEN_PAGES = /^\/(quote|invoice|contract|booking|gallerij|gedeeld|ontvang)\/[A-Za-z0-9_.%~-]+\/?$/;
const PORTAL_KEY_PATH = /^\/portal\/([a-z0-9]+(?:-[a-z0-9]+)*-[a-z2-7]{10})\/?$/;

/**
 * Welke paden een klantadres bedient. Alleen wat een klant ziet: het portaal
 * en de pagina's achter een link uit een mail. De werkruimte, /mcp en het
 * voorbeeld van het portaal (/portal/voorbeeld) niet: zo komt een teamlid op
 * een klantadres nooit bij een inlogscherm voor de werkruimte, en ziet het
 * adres nooit zijn wachtwoord of sessie.
 */
export function routeFor(pathname: string, method: string, portalKey: string | null): Route {
  const m = method.toUpperCase();
  if (pathname === '/afmelden') return m === 'GET' || m === 'POST' || m === 'HEAD' ? { kind: 'unsubscribe' } : { kind: 'method' };
  if (m !== 'GET' && m !== 'HEAD') return { kind: 'method' };
  if (pathname === '/robots.txt') return { kind: 'robots' };
  if (pathname === '/favicon.svg' || pathname === '/favicon.ico') return { kind: 'favicon' };
  if (pathname.startsWith('/assets/') || pathname.startsWith('/fonts/') || pathname.startsWith('/icons/')) {
    return pathname.includes('..') ? { kind: 'notFound' } : { kind: 'asset' };
  }
  if (pathname === '/' || pathname === '/portal' || pathname === '/portal/' || pathname === '/portal/inloggen' || pathname === '/portal/inloggen/') {
    return { kind: 'page', tokenPage: pathname.startsWith('/portal/inloggen') };
  }
  const key = PORTAL_KEY_PATH.exec(pathname);
  if (key) return key[1] === portalKey ? { kind: 'page', tokenPage: false } : { kind: 'notFound' };
  if (TOKEN_PAGES.test(pathname)) return { kind: 'page', tokenPage: true };
  return { kind: 'notFound' };
}

/** Zoals de kop van een klantpagina: de naam van de organisatie. */
export function pageTitle(brandName: string | null): string {
  const name = String(brandName ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
  return name ? `${name} · Klantportaal` : 'Klantportaal';
}

export function escapeAttr(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * De meta die de app leest (src/lib/clientHost.ts). `tokenLogin`: het portaal
 * op een eigen domein, waar de klant inlogt met een code van ResoFly en een
 * sleutel krijgt, nooit een inlog bij Supabase (migratie 20261109020000).
 */
export function clientHostMeta(host: string, portalKey: string | null, portalHost: string | null = null, tokenLogin = false): string {
  return `<meta name="resofly-client-host" content="${escapeAttr(JSON.stringify({
    host, portalKey, ...(portalHost ? { portalHost } : {}), ...(tokenLogin ? { portalMode: 'token' } : {}),
  }))}">`;
}

/**
 * Een pad van het klantportaal: de voordeur, inloggen en de sessie. Op een
 * eigen domein alleen als de organisatie het portaal daar aanzette
 * (Instellingen → Domein, migratie 20261109020000). De DNS van een eigen
 * domein beheert de organisatie zelf; daarom logt een klant daar in met een
 * code van ResoFly en krijgt hij een sleutel voor alleen het portaal van die
 * organisatie, nooit een inlog bij Supabase (die geldt voor zijn hele account).
 */
export function isPortalPath(pathname: string): boolean {
  return pathname === '/' || pathname === '/portal' || pathname.startsWith('/portal/');
}

/**
 * Hetzelfde pad op een ander adres. Als tekst, niet met new URL(pad, adres):
 * een pad als //evil.example/x is voor new URL een ander domein, en dan was
 * een hernoemd adres een open redirect.
 */
export function sameUrlOn(host: string, pathname: string, search: string): string {
  return `https://${host}${pathname.startsWith('/') ? pathname : `/${pathname}`}${search}`;
}

/** Waar een portaalpad op een eigen domein heen gaat (de naam bij ResoFly), of null. */
export function portalRedirectUrl(pathname: string, search: string, portalHost: string | null): string | null {
  if (!portalHost) return null;
  return sameUrlOn(portalHost, pathname === '/' ? '/portal' : pathname, search);
}

/** Leesbare tekst op een kleur: wit of bijna zwart. */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#ffffff';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (1.05) / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#ffffff' : '#111114';
}

/** Een icoon voor het tabblad: de eerste letter van de naam op de merkkleur. */
export function faviconSvg(brandName: string | null, accentColor: string | null): string {
  const color = accentColor && /^#[0-9a-f]{6}$/i.test(accentColor) ? accentColor : '#3a3a46';
  const letter = (String(brandName ?? '').trim().match(/[\p{L}\p{N}]/u)?.[0] ?? 'K').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="43" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="700" fill="${textOn(color)}">${escapeAttr(letter)}</text></svg>`;
}

/** Een eenvoudige pagina zonder merk, voor een adres dat (nog) niets toont. */
export function neutralPage(title: string, text: string): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeAttr(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#15151b;color:#f3f3f6;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}main{max-width:32rem}h1{font-size:22px;margin:0 0 8px}p{margin:0;color:#b9b9c4}</style></head><body><main><h1>${escapeAttr(title)}</h1><p>${escapeAttr(text)}</p></main></body></html>`;
}

export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/**
 * De headers van een klantpagina. De CSP komt mee uit public/_headers (de
 * Pages-build): één bron, en scripts/check-csp-hash.mjs bewaakt hem. Hier komt
 * erbij wat een klantadres anders maakt: nooit in een zoekmachine, geen
 * Referer naar buiten op een pagina met een token, en HSTS zonder
 * includeSubDomains: dat is aan de eigenaar van het domein.
 */
export function securityHeaders(base: Headers, options: { tokenPage: boolean }): Headers {
  const headers = new Headers();
  for (const name of ['content-type', 'content-security-policy', 'x-content-type-options', 'x-frame-options', 'permissions-policy', 'etag', 'last-modified']) {
    const value = base.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('x-content-type-options', 'nosniff');
  if (!headers.get('x-frame-options')) headers.set('x-frame-options', 'DENY');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('referrer-policy', options.tokenPage ? 'no-referrer' : 'strict-origin-when-cross-origin');
  headers.set('strict-transport-security', 'max-age=31536000');
  headers.set('cache-control', 'no-cache');
  return headers;
}

/** Hostnamen die deze Worker nooit bedient, maar ongewijzigd doorgeeft (de werkruimte, mail, agenda). */
export function parseHostList(value: string | undefined): Set<string> {
  return new Set(String(value ?? '').split(',').map((h) => h.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean));
}
