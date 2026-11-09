// Draait de app op een klantadres (jansen.resofly.com, portaal.jansen.nl)?
//
// De Worker op die adressen (workers/client-domains) zet in de HTML:
//   <meta name="resofly-client-host" content='{"host":"…","portalKey":"…"}'>
// Op een klantadres toont de app alleen wat een klant ziet: het portaal en de
// klantpagina's, nooit het inlogscherm of de werkruimte van een teamlid.
//
// Dit bepaalt alleen wat er in beeld komt. Toegang regelt de server: de
// tokens van de klantpagina's en de sessie van het portaal (harde regel 1).

import { isPortalLoginKey } from './portalLoginKey.ts';

export interface ClientHostInfo {
  host: string;
  /** Het eigen inlogadres van de organisatie (/portal/<sleutel>), als de Worker het meegaf. */
  portalKey: string | null;
  /**
   * Op een eigen domein zonder portaal: de naam bij ResoFly
   * (jansen.resofly.com), waar het portaal woont.
   */
  portalHost: string | null;
  /**
   * Het portaal op een eigen domein (migratie 20261109020000): inloggen met
   * een code van ResoFly, met een sleutel voor alleen deze organisatie. Nooit
   * een inlog bij Supabase: die geldt voor het hele account van de klant, en
   * wat hier in de browser staat, kan de beheerder van het domein uitlezen.
   */
  tokenLogin: boolean;
}

/** Leest de meta, alleen als die bij dit adres hoort. Puur, voor de test. */
export function parseClientHostMeta(content: string | null | undefined, currentHost: string): ClientHostInfo | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { host?: unknown; portalKey?: unknown; portalHost?: unknown; portalMode?: unknown };
    const host = typeof parsed.host === 'string' ? parsed.host.toLowerCase() : '';
    if (!host || host !== String(currentHost || '').toLowerCase()) return null;
    const portalHost = typeof parsed.portalHost === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(parsed.portalHost)
      ? parsed.portalHost.toLowerCase()
      : null;
    const tokenLogin = parsed.portalMode === 'token';
    return {
      host,
      portalKey: isPortalLoginKey(parsed.portalKey) ? parsed.portalKey : null,
      // Met het portaal hier stuurt de app nergens heen.
      portalHost: portalHost === host || tokenLogin ? null : portalHost,
      tokenLogin,
    };
  } catch {
    return null;
  }
}

/**
 * Een pad van het portaal op een eigen domein: waar het heen moet (de naam bij
 * ResoFly), of null. De Worker stuurt al door; dit is de tweede laag, voor een
 * pad dat de app zelf opent.
 */
export function portalRedirectTarget(info: ClientHostInfo | null, location: { pathname: string; search: string }): string | null {
  if (!info?.portalHost) return null;
  const path = location.pathname;
  if (!(path === '/' || path === '/portal' || path.startsWith('/portal/'))) return null;
  return `https://${info.portalHost}${path === '/' ? '/portal' : path}${location.search}`;
}

let cached: ClientHostInfo | null | undefined;

export function clientHostInfo(): ClientHostInfo | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const content = document.querySelector('meta[name="resofly-client-host"]')?.getAttribute('content');
  cached = parseClientHostMeta(content, window.location.hostname);
  return cached;
}

export function isClientHost(): boolean {
  return clientHostInfo() !== null;
}
