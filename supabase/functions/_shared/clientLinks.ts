// ============================================================
// Links naar klantpagina's, en verzoeken die van een klantadres komen.
//
// Waarom dit bestaat: elke mail aan een klant (factuur, offerte, contract,
// album, portaal) linkte naar één vast adres uit de instellingen
// (APP_PUBLIC_URL en zes varianten). Met een eigen webadres per organisatie
// (migratie 20261108230000) hoort de link naar het adres van díe organisatie.
//
// Drie regels:
//   1. Een link bouwt de server uit de organisatie (organization_id), nooit
//      uit Host of Origin van het verzoek. Wie de link in een mail naar een
//      domein kan sturen dat hij (later) zelf beheert, onderschept anders het
//      token ("host header injection").
//   2. Pas als de klantadressen echt draaien (CLIENT_DOMAINS_LIVE), gaan links
//      ernaartoe. Tot die tijd het oude adres: een mail met een link die
//      nergens heen gaat, is erger dan een mail met het adres van ResoFly.
//   3. Een verzoek van een klantadres mag een publieke functie aanroepen
//      (CORS), maar het adres bepaalt nooit tot wat het toegang geeft: een
//      token van organisatie A via het adres van organisatie B geeft niets.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { normalizeHost, parseClientHost, subdomainHost } from './clientDomains.ts';

type EnvGetter = (name: string) => string | undefined;
const denoEnv: EnvGetter = (name) =>
  (globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } } }).Deno?.env?.get?.(name);

/** Het basisdomein als CLIENT_DOMAIN_BASE niet is gezet. */
export const DEFAULT_CLIENT_DOMAIN_BASE = 'resofly.com';

export interface ClientDomainsConfig {
  /** De namen staan onder dit domein: <naam>.<base>. */
  base: string;
  /** Gaan links al naar de klantadressen? Pas als DNS en de Worker er staan. */
  live: boolean;
  /** Waar een eigen domein met een CNAME-record naar wijst. */
  cnameTarget: string;
}

export function clientDomainsConfig(env: EnvGetter = denoEnv): ClientDomainsConfig {
  const base = normalizeHost(env('CLIENT_DOMAIN_BASE') || DEFAULT_CLIENT_DOMAIN_BASE);
  const live = /^(1|true|ja|yes|on)$/i.test(String(env('CLIENT_DOMAINS_LIVE') ?? '').trim());
  const cnameTarget = normalizeHost(env('CLIENT_DOMAIN_CNAME_TARGET') || `domeinen.${base}`);
  return { base, live, cnameTarget };
}

/**
 * Het klantadres van een organisatie (zonder https://), of null als links nog
 * naar het algemene adres gaan. Een actief eigen domein gaat voor de naam bij
 * ResoFly. Met de service-role: het filter op organization_id staat hier.
 */
export async function clientHostForOrganization(
  admin: SupabaseClient,
  organizationId: string,
  config: ClientDomainsConfig = clientDomainsConfig(),
): Promise<string | null> {
  if (!config.live || !organizationId) return null;
  const { data: domain, error: domainError } = await admin
    .from('client_domains')
    .select('hostname')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (domainError) throw domainError;
  if (domain?.hostname) return normalizeHost(String(domain.hostname));
  const { data: sub, error: subError } = await admin
    .from('client_subdomains')
    .select('name')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .maybeSingle();
  if (subError) throw subError;
  return sub?.name ? subdomainHost(String(sub.name), config.base) : null;
}

/**
 * De basis-URL voor links naar klantpagina's van deze organisatie:
 * https://<klantadres>, of `fallback` (het adres uit de instellingen). Gooit
 * nooit: zonder klantadres, of als het opzoeken mislukt (de migratie staat er
 * nog niet), gaat de mail gewoon met het oude adres.
 */
export async function clientBaseUrl(
  admin: SupabaseClient,
  organizationId: string | null | undefined,
  fallback: string,
  config: ClientDomainsConfig = clientDomainsConfig(),
): Promise<string> {
  const fallbackUrl = String(fallback || '').replace(/\/+$/, '');
  if (!organizationId) return fallbackUrl;
  try {
    const host = await clientHostForOrganization(admin, organizationId, config);
    return host ? `https://${host}` : fallbackUrl;
  } catch (error) {
    console.warn('klantadres opzoeken mislukt; de link krijgt het algemene adres', error instanceof Error ? error.message : error);
    return fallbackUrl;
  }
}

/**
 * Waar het klantportaal van een organisatie woont: het eigen domein als de
 * organisatie het portaal daar heeft aangezet (Instellingen → Domein), anders
 * de naam bij ResoFly (jansen.resofly.com).
 *
 * Tot migratie 20261109020000 nooit een eigen domein. De inlog van een klant
 * staat in de browser, bij het adres waarop hij inlogde, en gold bij al zijn
 * leveranciers. De DNS van een eigen domein beheert de organisatie zelf: wees
 * portaal.jansen.nl later naar een eigen server, dan las een pagina daar die
 * inlog uit, en zag Jansen wat de klant bij een ander heeft (harde regel 1).
 * Nu geldt een inlog op het adres van een organisatie alleen voor die
 * organisatie (_shared/portalSession.ts, portal_sessions).
 */
export async function clientPortalBaseUrl(
  admin: SupabaseClient,
  organizationId: string | null | undefined,
  fallback: string,
  config: ClientDomainsConfig = clientDomainsConfig(),
): Promise<string> {
  const fallbackUrl = String(fallback || '').replace(/\/+$/, '');
  if (!organizationId || !config.live) return fallbackUrl;
  try {
    const { data: domain, error: domainError } = await admin
      .from('client_domains')
      .select('hostname')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .eq('portal_enabled', true)
      .order('verified_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (domainError) throw domainError;
    if (domain?.hostname) return `https://${normalizeHost(String(domain.hostname))}`;
    const { data, error } = await admin
      .from('client_subdomains')
      .select('name')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw error;
    return data?.name ? `https://${subdomainHost(String(data.name), config.base)}` : fallbackUrl;
  } catch (error) {
    console.warn('portaaladres opzoeken mislukt; de link krijgt het algemene adres', error instanceof Error ? error.message : error);
    return fallbackUrl;
  }
}

/**
 * De basis voor een link naar het klantportaal. Op het klantadres
 * (https://jansen.resofly.com/portal) is het eigen inlogadres (/portal/<sleutel>)
 * overbodig: het adres zegt al van wie het portaal is. Zonder klantadres het
 * algemene adres; de aanroeper zet daar de sleutel achter, zoals voorheen.
 */
export async function portalLinkBase(
  admin: SupabaseClient,
  organizationId: string | null | undefined,
  fallback: string,
  config: ClientDomainsConfig = clientDomainsConfig(),
): Promise<{ base: string; onClientHost: boolean }> {
  const fallbackUrl = String(fallback || '').replace(/\/+$/, '');
  const base = await clientPortalBaseUrl(admin, organizationId, fallbackUrl, config);
  return { base, onClientHost: base !== fallbackUrl };
}

// ── Publieke links met een token herkennen ──────────────────────────────────

const PUBLIC_LINK_KINDS = ['invoice', 'quote', 'contract', 'booking', 'gallerij', 'gedeeld', 'ontvang'] as const;
export type PublicLinkKind = typeof PUBLIC_LINK_KINDS[number];

/**
 * Staat er een publieke link met token in deze tekst, op welk adres dan ook?
 * Vroeger zocht invoice-workflow op één voorvoegsel (INVOICE_PUBLIC_BASE_URL);
 * een link op een klantadres glipte daar doorheen.
 */
export function containsPublicLink(value: string, kinds: readonly PublicLinkKind[] = PUBLIC_LINK_KINDS): boolean {
  const text = String(value ?? '');
  if (!text) return false;
  const pattern = new RegExp(`https?://[^\\s"'<>/]+(?:/[^\\s"'<>]*)?/(?:${kinds.join('|')})/[A-Za-z0-9_\\-.%~]{16,}`, 'i');
  return pattern.test(text);
}

/**
 * Mag een betaling terugkeren naar deze URL? Alleen naar precies de publieke
 * pagina van dit document, op een van de toegestane adressen (het klantadres
 * van de organisatie en het algemene adres).
 */
export function isAllowedReturnUrl(candidate: string, expectedPath: string, allowedOrigins: readonly string[]): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (url.username || url.password) return false;
    const origins = new Set(allowedOrigins.map(o => { try { return new URL(o).origin; } catch { return ''; } }).filter(Boolean));
    return origins.has(url.origin) && url.pathname === expectedPath;
  } catch {
    return false;
  }
}

// ── Verzoeken van een klantadres ─────────────────────────────────────────────

export interface ClientOrigin {
  origin: string;
  host: string;
  organizationId: string;
  kind: 'subdomain' | 'custom';
  /**
   * Staat het klantportaal op dit adres? Op een naam bij ResoFly altijd; op
   * een eigen domein als de organisatie het aanzette én het domein actief is.
   */
  portalEnabled: boolean;
}

const verdicts = new WeakMap<Request, ClientOrigin | null>();
const cache = new Map<string, { value: ClientOrigin | null; until: number }>();
const CACHE_MS = 60_000;
/**
 * Hooguit zoveel adressen onthouden. Wie met steeds een andere Origin aanklopt
 * (een verzonnen hostnaam per verzoek), liet de lijst anders onbeperkt groeien.
 */
const CACHE_MAX = 500;

/** Alleen voor de tests: begin zonder onthouden antwoorden. */
export function clearClientOriginCache(): void {
  cache.clear();
}

async function lookupClientOrigin(admin: SupabaseClient, origin: string, config: ClientDomainsConfig): Promise<ClientOrigin | null> {
  if (!origin || origin === 'null') return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // Alleen een echte https-herkomst op de standaardpoort, precies zoals een
  // browser hem meestuurt: geen pad, geen poort, geen http.
  if (url.protocol !== 'https:' || url.port || url.origin !== origin) return null;
  const parsed = parseClientHost(url.hostname, config.base);
  if (!parsed) return null;

  const hit = cache.get(origin);
  if (hit && hit.until > Date.now()) return hit.value;

  let value: ClientOrigin | null = null;
  if (parsed.kind === 'subdomain') {
    const { data, error } = await admin.from('client_subdomains').select('organization_id,status').eq('name', parsed.name).maybeSingle();
    if (error) throw error;
    if (data?.status === 'active') {
      value = { origin, host: url.hostname, organizationId: String(data.organization_id), kind: 'subdomain', portalEnabled: true };
    }
  } else {
    const { data, error } = await admin.from('client_domains').select('organization_id,status,portal_enabled')
      .eq('hostname', parsed.hostname).in('status', ['active', 'failing']).limit(1).maybeSingle();
    if (error) throw error;
    if (data) {
      // Het portaal alleen op een actief domein. Bij 'failing' wijst het record
      // misschien al naar een ander, en dan zijn de pagina's daar niet meer van
      // ons: eerst kon iedereen vanaf zo'n domein een inlogmail laten sturen
      // (in de huisstijl van de organisatie, met een link naar dat domein).
      // Documenten met een token blijven er wel werken: de link uit een mail
      // gaat daar toch al heen.
      value = {
        origin, host: url.hostname, organizationId: String(data.organization_id), kind: 'custom',
        portalEnabled: data.portal_enabled === true && data.status === 'active',
      };
    }
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(origin, { value, until: Date.now() + CACHE_MS });
  return value;
}

/**
 * Kijkt één keer per verzoek of de Origin een actief klantadres is, en
 * onthoudt het antwoord bij het verzoek. Daarna kunnen de gewone
 * (synchrone) CORS-functies het lezen met clientOriginOf(). Gooit nooit: als
 * het opzoeken mislukt, is het geen klantadres.
 */
export async function rememberClientOrigin(
  admin: SupabaseClient,
  req: Request,
  config: ClientDomainsConfig = clientDomainsConfig(),
): Promise<ClientOrigin | null> {
  if (verdicts.has(req)) return verdicts.get(req) ?? null;
  let value: ClientOrigin | null = null;
  try {
    value = await lookupClientOrigin(admin, req.headers.get('origin') || '', config);
  } catch (error) {
    console.warn('klantadres van de herkomst opzoeken mislukt', error instanceof Error ? error.message : error);
    value = null;
  }
  verdicts.set(req, value);
  return value;
}

/** Het klantadres waar dit verzoek vandaan kwam (na rememberClientOrigin), of null. */
export function clientOriginOf(req: Request): ClientOrigin | null {
  return verdicts.get(req) ?? null;
}

/**
 * Hetzelfde, maar alleen een adres waar het klantportaal staat: een naam bij
 * ResoFly, of een eigen domein waar de organisatie het portaal aanzette. Een
 * eigen domein zonder portaal krijgt voor het portaal en het inloggen geen
 * CORS, en dus nooit een inlog.
 */
export function portalOriginOf(req: Request): ClientOrigin | null {
  const origin = clientOriginOf(req);
  return origin?.portalEnabled ? origin : null;
}

/**
 * clientOriginMismatch voor het portaal: alleen een adres met het portaal
 * telt. Ook "anders" als er geen organisatie is (een inlog voor alles op het
 * adres van één organisatie).
 */
export function portalOriginMismatch(req: Request, organizationId: string | null | undefined): boolean {
  const origin = portalOriginOf(req);
  if (!origin) return false;
  return !organizationId || origin.organizationId !== organizationId;
}

/**
 * Hoort dit document bij een andere organisatie dan het klantadres waar het
 * verzoek vandaan kwam? Dan opent de pagina het niet: de factuur van de een in
 * de huisstijl en op het adres van de ander is precies wat een oplichter wil.
 * Van het algemene adres (geen klantadres) mag alles, zoals altijd.
 */
export function clientOriginMismatch(req: Request, organizationId: string | null | undefined): boolean {
  const client = clientOriginOf(req);
  if (!client) return false;
  return !organizationId || client.organizationId !== organizationId;
}
