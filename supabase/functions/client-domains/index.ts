import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import {
  HttpError, createAdminClient, isUuid, makeCors, parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type OrganizationRole,
} from '../_shared/edgeAuth.ts';
import {
  cloudflareHostnameState, customDomainProblem, dnsInstructions, normalizeHost, ownershipVerdict, parseClientHost,
  parseHostnameInput, subdomainHost, txtValues, type ClientDomainStatus, type CloudflareCustomHostname, type DnsRecordInstruction,
} from '../_shared/clientDomains.ts';
import { clientBaseUrl, clientDomainsConfig, clientPortalBaseUrl, type ClientDomainsConfig } from '../_shared/clientLinks.ts';
import { loadBranding } from '../_shared/branding.ts';
import { escapeHtml, renderEmailLayout } from '../_shared/emailTemplates/layout.ts';
import { sanitizeIdempotencyPart, sendViaResend } from '../_shared/resend.ts';
import { loadEmailBrand, withEmailBrand } from '../_shared/emailBrand.ts';
import { takeEmailQuota } from '../_shared/emailQuota.ts';

// ============================================================
// ResoFly — Het webadres van een organisatie (client-domains)
//
// Migratie 20261108230000 en docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md.
// De naam bij ResoFly (<naam>.<basisdomein>) kiest de app zelf, met de RPC's
// client_subdomain_check en client_subdomain_claim. Deze functie doet wat een
// RPC niet kan:
//
//   overview      wat een teamlid in Instellingen → Domein ziet;
//   addDomain     een eigen domein koppelen (owner/admin): Cloudflare for SaaS
//                 maakt er een "custom hostname" van, met certificaat;
//   refreshDomain de stand bij Cloudflare opnieuw ophalen;
//   removeDomain  ontkoppelen. Was het actief, dan stuurt het nog twaalf
//                 maanden door (links in verstuurde mails blijven werken);
//   setPortal     het klantportaal ook op het eigen domein, of niet (owner/
//                 admin, migratie 20261109020000);
//   lookup        voor de Worker: wat hoort er bij deze hostnaam (alleen met
//                 CLIENT_DOMAINS_WORKER_SECRET, en alleen openbare gegevens);
//   ?cron=recheck voor pg_cron: wachtende en actieve domeinen nalopen, oude
//                 namen, inlogaanvragen en inloggen in het portaal opruimen.
//
// De organisatie komt uit de aanroep, maar alleen na de controle op het
// lidmaatschap van de ingelogde gebruiker (harde regel 1). Alles wat hier
// schrijft, filtert zelf op organization_id: de service-role ziet alles.
// ============================================================

const admin = createAdminClient();

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const APP_PUBLIC_URL = (Deno.env.get('APP_PUBLIC_URL') || '').replace(/\/+$/, '');
const CRON_SECRET = Deno.env.get('CLIENT_DOMAINS_CRON_SECRET') || '';
const WORKER_SECRET = Deno.env.get('CLIENT_DOMAINS_WORKER_SECRET') || '';
const CF_API = (Deno.env.get('CLOUDFLARE_API_BASE') || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

/** Een verwijderd domein dat actief was, stuurt zo lang door. */
const REDIRECT_MONTHS = 12;
/** Een koppeling die zo lang nooit actief werd, mag een andere organisatie overnemen. */
const UNVERIFIED_TAKEOVER_DAYS = 7;

const cors = makeCors(
  parseAllowedOrigins([
    Deno.env.get('CLIENT_DOMAINS_ALLOWED_ORIGINS'),
    Deno.env.get('APP_ALLOWED_ORIGINS'),
    Deno.env.get('APP_PUBLIC_URL'),
    Deno.env.get('MAIL_ALLOWED_ORIGINS'),
  ]),
  (Deno.env.get('ALLOW_LOCAL_DEV') ?? '0') === '1',
);

type DomainRow = {
  id: string;
  organization_id: string;
  hostname: string;
  status: ClientDomainStatus;
  cf_custom_hostname_id: string | null;
  cf_state: Record<string, unknown> | null;
  verified_at: string | null;
  last_checked_at: string | null;
  redirect_until: string | null;
  created_at: string;
  portal_enabled: boolean;
};

const DOMAIN_COLUMNS = 'id,organization_id,hostname,status,cf_custom_hostname_id,cf_state,verified_at,last_checked_at,redirect_until,created_at,portal_enabled';
const LIVE_STATUSES: ClientDomainStatus[] = ['pending_dns', 'pending_certificate', 'active', 'failing', 'blocked'];

serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('cron') === 'recheck') return handleCron(req);
  if (req.headers.get('x-client-domains-secret') !== null) return handleLookup(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Alleen POST.', 400);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    if (!isUuid(organizationId)) throw new HttpError('organizationId is verplicht.', 400);

    const user = await requireUser(admin, req);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    const config = clientDomainsConfig();

    switch (action) {
      case 'overview':
        return cors.json(req, { ok: true, ...(await overview(organizationId, config)) });
      case 'addDomain':
        assertAdmin(role);
        return cors.json(req, { ok: true, ...(await addDomain(organizationId, user.id, String(body.hostname ?? ''), config)) });
      case 'refreshDomain':
        assertAdmin(role);
        return cors.json(req, { ok: true, ...(await refreshDomain(organizationId, user.id, String(body.domainId ?? ''), config)) });
      case 'removeDomain':
        assertAdmin(role);
        return cors.json(req, { ok: true, ...(await removeDomain(organizationId, user.id, String(body.domainId ?? ''), config)) });
      case 'setPortal':
        assertAdmin(role);
        if (typeof body.enabled !== 'boolean') throw new HttpError('Kies aan of uit.', 400);
        return cors.json(req, { ok: true, ...(await setPortal(organizationId, user.id, String(body.domainId ?? ''), body.enabled, config)) });
      default:
        throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Er ging iets mis met het webadres. Probeer het later opnieuw.';
    if (status >= 500) console.error('client-domains error', err instanceof Error ? err.message : err, err instanceof Error ? err.stack : undefined);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

function assertAdmin(role: OrganizationRole): void {
  if (role !== 'owner' && role !== 'admin') {
    throw new HttpError('Alleen de eigenaar of een beheerder kan het webadres wijzigen.', 403);
  }
}

// ── Overzicht ────────────────────────────────────────────────────────────────

/**
 * Een eigen domein alleen voor een organisatie die betaalt, of die ResoFly
 * heeft vrijgesteld. Een eigen domein maakt een nepfactuur geloofwaardiger, en
 * een gratis account is zo aangemaakt (plan, §6 punt 8). Het webadres bij
 * ResoFly krijgt iedereen: daar staat ons domein in.
 */
async function customDomainAllowed(organizationId: string): Promise<boolean> {
  const { data, error } = await admin.from('organization_billing_profiles')
    .select('billing_exempt,mollie_subscription_id,subscription_status')
    .eq('organization_id', organizationId).maybeSingle();
  if (error) throw error;
  if (!data) return false;
  if (data.billing_exempt === true) return true;
  return Boolean(data.mollie_subscription_id) && ['active', 'past_due', 'trialing'].includes(String(data.subscription_status));
}

async function overview(organizationId: string, config: ClientDomainsConfig) {
  const [subs, domains, clientUrl, portalUrl, allowed] = await Promise.all([
    admin.from('client_subdomains').select('name,status,redirect_until,created_at')
      .eq('organization_id', organizationId).order('created_at', { ascending: false }),
    admin.from('client_domains').select(DOMAIN_COLUMNS)
      .eq('organization_id', organizationId).neq('status', 'removed').order('created_at', { ascending: false }),
    clientBaseUrl(admin, organizationId, APP_PUBLIC_URL, config),
    clientPortalBaseUrl(admin, organizationId, APP_PUBLIC_URL, config),
    customDomainAllowed(organizationId),
  ]);
  if (subs.error) throw subs.error;
  if (domains.error) throw domains.error;
  const now = Date.now();
  const subRows = (subs.data ?? []) as Array<{ name: string; status: string; redirect_until: string | null }>;
  const active = subRows.find(row => row.status === 'active') ?? null;
  const domainRows = (domains.data ?? []) as DomainRow[];
  const live = domainRows.find(row => LIVE_STATUSES.includes(row.status)) ?? null;
  return {
    config: {
      base: config.base,
      live: config.live,
      cnameTarget: config.cnameTarget,
      customDomainsAvailable: cloudflare() !== null,
    },
    customDomainAllowed: allowed,
    subdomain: active ? { name: active.name, host: subdomainHost(active.name, config.base) } : null,
    blocked: subRows.some(row => row.status === 'blocked'),
    previous: subRows
      .filter(row => row.status === 'redirect' && row.redirect_until && Date.parse(row.redirect_until) > now)
      .map(row => ({ name: row.name, host: subdomainHost(row.name, config.base), redirectUntil: row.redirect_until })),
    domain: live ? domainView(live, config) : null,
    moved: domainRows
      .filter(row => row.status === 'moved' && row.redirect_until && Date.parse(row.redirect_until) > now)
      .map(row => ({ id: row.id, hostname: row.hostname, redirectUntil: row.redirect_until })),
    clientUrl,
    // Net als portalLinkBase: wijkt het adres af van dat van de app, dan is het
    // het klantadres. De app laat het inlogadres met sleutel dan weg.
    onClientHost: Boolean(clientUrl) && clientUrl !== APP_PUBLIC_URL,
    // Het portaal: op het eigen domein als het daar aan staat, anders op de naam bij ResoFly.
    portalUrl,
    portalOnClientHost: Boolean(portalUrl) && portalUrl !== APP_PUBLIC_URL,
  };
}

function domainView(row: DomainRow, config: ClientDomainsConfig) {
  const state = (row.cf_state ?? {}) as { problem?: string | null; ownership?: CloudflareCustomHostname['ownership_verification']; cname?: string[] | null };
  const records: DnsRecordInstruction[] = dnsInstructions(row.hostname, config.cnameTarget, { ownership_verification: state.ownership ?? undefined });
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    problem: typeof state.problem === 'string' ? state.problem : null,
    cnameFound: Array.isArray(state.cname) ? state.cname : null,
    records,
    verifiedAt: row.verified_at,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    portalEnabled: row.portal_enabled === true,
  };
}

// ── Cloudflare for SaaS ─────────────────────────────────────────────────────

function cloudflare(): { token: string; zone: string } | null {
  const token = Deno.env.get('CLOUDFLARE_SAAS_API_TOKEN') || '';
  const zone = Deno.env.get('CLOUDFLARE_SAAS_ZONE_ID') || '';
  return token && zone ? { token, zone } : null;
}

type CfResponse = { ok: boolean; status: number; result: unknown; errors: Array<{ code?: number; message?: string }> };

async function cf(path: string, init: RequestInit = {}): Promise<CfResponse> {
  const conf = cloudflare();
  if (!conf) throw new HttpError('Eigen domeinen zijn op deze omgeving nog niet ingericht. Neem contact op met ResoFly.', 409);
  let res: Response;
  try {
    res = await fetch(`${CF_API}/zones/${encodeURIComponent(conf.zone)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${conf.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error('client-domains: Cloudflare niet bereikbaar', error instanceof Error ? error.message : error);
    throw new HttpError('Cloudflare is nu niet bereikbaar. Probeer het over een paar minuten opnieuw.', 502);
  }
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: CfResponse['errors'] };
  return { ok: res.ok && json.success !== false, status: res.status, result: json.result ?? null, errors: json.errors ?? [] };
}

function cfErrorText(res: CfResponse): string {
  return res.errors.map(e => e?.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
}

async function cfCreate(hostname: string): Promise<CloudflareCustomHostname> {
  const body = JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } });
  const res = await cf('/custom_hostnames', { method: 'POST', body });
  if (res.ok && res.result) return res.result as CloudflareCustomHostname;
  // Bestaat al in de zone: een eerdere poging kwam bij Cloudflare aan, maar
  // het opslaan hier mislukte. Dan die gebruiken; wie hem bij ons heeft, is
  // al gecontroleerd vóór we hier kwamen.
  if (res.errors.some(e => e?.code === 1406 || /duplicate|already exists/i.test(String(e?.message ?? '')))) {
    const found = await cfFind(hostname);
    if (found) return found;
  }
  console.error('client-domains: aanmaken bij Cloudflare mislukte', cfErrorText(res));
  throw new HttpError(`Cloudflare nam het domein niet aan: ${cfErrorText(res)}`, 502);
}

async function cfFind(hostname: string): Promise<CloudflareCustomHostname | null> {
  const res = await cf(`/custom_hostnames?hostname=${encodeURIComponent(hostname)}`);
  if (!res.ok || !Array.isArray(res.result)) return null;
  return (res.result as CloudflareCustomHostname[]).find(item => normalizeHost(String(item.hostname ?? '')) === hostname) ?? null;
}

/** Null als Cloudflare hem niet (meer) kent. */
async function cfGet(id: string): Promise<CloudflareCustomHostname | null> {
  const res = await cf(`/custom_hostnames/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(`Cloudflare gaf geen stand: ${cfErrorText(res)}`, 502);
  return res.result as CloudflareCustomHostname;
}

/** Verwijdert bij Cloudflare. Bestond hij al niet meer, dan is dat ook goed. */
async function cfDelete(id: string): Promise<void> {
  const res = await cf(`/custom_hostnames/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.ok || res.status === 404) return;
  throw new HttpError(`Cloudflare kon het domein niet verwijderen: ${cfErrorText(res)}`, 502);
}

type Ownership = { type: 'txt'; name: string; value: string };

/** Het TXT-record van deze koppeling, zoals Cloudflare het gaf. */
function ownershipOf(result: CloudflareCustomHostname | null): Ownership | null {
  const own = result?.ownership_verification;
  return own?.type === 'txt' && own.name && own.value ? { type: 'txt', name: normalizeHost(own.name), value: String(own.value) } : null;
}

/** Het bewaarde TXT-record: Cloudflare laat het weg zodra de hostnaam actief is. */
function storedOwnership(row: DomainRow | null): Ownership | null {
  const own = (row?.cf_state as { ownership?: Partial<Ownership> | null } | null)?.ownership;
  return own?.type === 'txt' && own.name && own.value ? { type: 'txt', name: String(own.name), value: String(own.value) } : null;
}

/** Wat we van een antwoord van Cloudflare bewaren: genoeg voor het scherm. */
function cfStateFor(result: CloudflareCustomHostname | null, problem: string | null, cname: string[] | null, ownership: Ownership | null): Record<string, unknown> {
  return {
    status: result?.status ?? null,
    ssl: result?.ssl?.status ?? null,
    problem,
    ownership,
    cname,
    checkedAt: new Date().toISOString(),
  };
}

// ── DNS: waar wijst het record nu naartoe? (voor een duidelijke melding) ─────

async function lookupCname(host: string): Promise<string[] | null> {
  const native = (globalThis as { Deno?: { resolveDns?: (name: string, type: 'CNAME') => Promise<string[]> } }).Deno?.resolveDns;
  if (typeof native === 'function') {
    try {
      return (await Promise.race([
        native(host, 'CNAME'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
      ])).map(normalizeHost);
    } catch (error) {
      if (error instanceof Error && /no.?records|not.?found|NXDOMAIN/i.test(error.message)) return [];
      // Valt terug op DNS-over-HTTPS.
    }
  }
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=CNAME`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    return (json.Answer ?? []).filter(a => a.type === 5 && a.data).map(a => normalizeHost(String(a.data)));
  } catch {
    return null;
  }
}

/** De TXT-waarden op een naam; [] = geen, null = geen antwoord (dan niet actief). */
async function lookupTxt(name: string): Promise<string[] | null> {
  const native = (globalThis as { Deno?: { resolveDns?: (name: string, type: 'TXT') => Promise<string[][]> } }).Deno?.resolveDns;
  if (typeof native === 'function') {
    try {
      const records = await Promise.race([
        native(name, 'TXT'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
      ]);
      return records.map((chunks) => chunks.join(''));
    } catch (error) {
      if (error instanceof Error && /no.?records|not.?found|NXDOMAIN/i.test(error.message)) return [];
      // Valt terug op DNS-over-HTTPS.
    }
  }
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { Answer?: Array<{ type?: number; data?: string }> };
    return txtValues((json.Answer ?? []).filter(a => a.type === 16 && a.data).map(a => String(a.data)));
  } catch {
    return null;
  }
}

/** Staat het TXT-record van deze koppeling er? */
async function ownershipFound(ownership: Ownership | null): Promise<boolean | null> {
  if (!ownership) return null;
  const values = await lookupTxt(ownership.name);
  return values === null ? null : values.includes(ownership.value);
}

function dnsProblem(hostname: string, cname: string[] | null, target: string): string | null {
  if (cname === null) return null;
  if (cname.length === 0) return `We vinden nog geen CNAME-record op ${hostname}. Een wijziging bij je domeinbeheerder kan een paar uur duren.`;
  if (!cname.includes(target)) return `${hostname} wijst nu naar ${cname[0]}. Verander het CNAME-record in ${target}.`;
  return null;
}

// ── Eigen domein koppelen, nalopen, ontkoppelen ─────────────────────────────

async function loadDomain(organizationId: string, domainId: string): Promise<DomainRow> {
  if (!isUuid(domainId)) throw new HttpError('Ongeldig domein.', 400);
  const { data, error } = await admin.from('client_domains').select(DOMAIN_COLUMNS)
    .eq('id', domainId).eq('organization_id', organizationId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError('Dit domein hoort niet bij deze organisatie.', 404);
  return data as DomainRow;
}

async function addDomain(organizationId: string, userId: string, input: string, config: ClientDomainsConfig) {
  const hostname = parseHostnameInput(input);
  if (!hostname) throw new HttpError('Vul een domein in, zoals portaal.jouwbedrijf.nl.', 422);
  const reserved = [config.base, config.cnameTarget, APP_PUBLIC_URL ? new URL(APP_PUBLIC_URL).hostname : ''];
  const problem = customDomainProblem(hostname, reserved);
  if (problem) throw new HttpError(problem, 422);
  if (!cloudflare()) throw new HttpError('Eigen domeinen zijn op deze omgeving nog niet ingericht. Neem contact op met ResoFly.', 409);
  if (!(await customDomainAllowed(organizationId))) {
    throw new HttpError('Een eigen domein kan met een betaald abonnement. Je webadres bij ResoFly werkt al.', 403);
  }

  // Per organisatie één eigen domein tegelijk.
  const { data: own, error: ownError } = await admin.from('client_domains').select('id,hostname')
    .eq('organization_id', organizationId).in('status', LIVE_STATUSES).limit(1);
  if (ownError) throw ownError;
  if (own && own.length > 0) {
    throw new HttpError(`Je hebt al een eigen domein (${own[0].hostname}). Verwijder dat eerst.`, 409);
  }

  // Bij een andere organisatie? Een domein dat ooit actief was, blijft van
  // die organisatie. Een koppeling die na zeven dagen nooit actief werd, mag
  // een ander overnemen: anders houdt wie het eerst typt de echte eigenaar
  // voorgoed buiten (dezelfde regel als bij verzenddomeinen).
  const { data: taken, error: takenError } = await admin.from('client_domains').select(DOMAIN_COLUMNS)
    .eq('hostname', hostname).neq('status', 'removed');
  if (takenError) throw takenError;
  for (const row of (taken ?? []) as DomainRow[]) {
    const stale = !row.verified_at && Date.parse(row.created_at) < Date.now() - UNVERIFIED_TAKEOVER_DAYS * 86_400_000
      && row.status !== 'blocked';
    if (!stale) throw new HttpError('Dit domein is al gekoppeld aan een andere organisatie.', 409);
    if (row.cf_custom_hostname_id) await cfDelete(row.cf_custom_hostname_id);
    const { error } = await admin.from('client_domains')
      .update({ status: 'removed', redirect_until: null, cf_custom_hostname_id: null })
      .eq('id', row.id).eq('organization_id', row.organization_id);
    if (error) throw error;
    await audit(row.organization_id, null, 'taken_over', row.id, row.hostname, {});
  }

  const created = await cfCreate(hostname);
  const ownership = ownershipOf(created);
  const [cname, found] = await Promise.all([lookupCname(hostname), ownershipFound(ownership)]);
  const fromCloudflare = cloudflareHostnameState(created, false);
  const withDns = fromCloudflare.status === 'active'
    ? fromCloudflare
    : { status: fromCloudflare.status, problem: dnsProblem(hostname, cname, config.cnameTarget) ?? fromCloudflare.problem };
  const mapped = ownershipVerdict(withDns, { wasVerified: false, name: ownership?.name ?? null, found });
  const now = new Date().toISOString();
  const { data: inserted, error: insertError } = await admin.from('client_domains').insert({
    organization_id: organizationId,
    hostname,
    status: mapped.status,
    cf_custom_hostname_id: created.id ?? null,
    cf_state: cfStateFor(created, mapped.problem, cname, ownership),
    verified_at: mapped.status === 'active' ? now : null,
    last_checked_at: now,
    created_by: userId,
  }).select(DOMAIN_COLUMNS).single();
  if (insertError || !inserted) {
    // Niet half laten staan: dan blijft het bij Cloudflare zonder rij die erbij hoort.
    if (created.id) await cfDelete(created.id).catch(err => console.error('client-domains: opruimen na mislukt opslaan mislukte', err));
    if (insertError && (insertError as { code?: string }).code === '23505') {
      throw new HttpError('Dit domein is net door een andere organisatie gekoppeld, of je hebt al een eigen domein.', 409);
    }
    throw insertError ?? new Error('opslaan mislukt');
  }
  await audit(organizationId, userId, 'added', inserted.id, hostname, { status: mapped.status });
  return { domain: domainView(inserted as DomainRow, config) };
}

async function checkDomain(row: DomainRow, config: ClientDomainsConfig): Promise<DomainRow> {
  const wasActive = Boolean(row.verified_at);
  const result = row.cf_custom_hostname_id ? await cfGet(row.cf_custom_hostname_id) : null;
  const fromCloudflare = cloudflareHostnameState(result, wasActive);
  const cname = fromCloudflare.status === 'active' ? null : await lookupCname(row.hostname);
  const withDns = fromCloudflare.status === 'active'
    ? fromCloudflare
    : { status: fromCloudflare.status, problem: dnsProblem(row.hostname, cname, config.cnameTarget) ?? fromCloudflare.problem };
  // Het TXT-bewijs van deze koppeling: alleen nodig tot het domein één keer actief was.
  const ownership = ownershipOf(result) ?? storedOwnership(row);
  const found = wasActive ? true : await ownershipFound(ownership);
  const mapped = ownershipVerdict(withDns, { wasVerified: wasActive, name: ownership?.name ?? null, found });
  const problem = mapped.problem;
  // 'blocked' zet alleen ResoFly; Cloudflare kan het ook melden.
  const status: ClientDomainStatus = row.status === 'blocked' ? 'blocked' : mapped.status;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status,
    cf_state: cfStateFor(result, problem, cname, ownership),
    last_checked_at: now,
  };
  if (status === 'active' && !row.verified_at) patch.verified_at = now;
  const { data, error } = await admin.from('client_domains').update(patch)
    .eq('id', row.id).eq('organization_id', row.organization_id).select(DOMAIN_COLUMNS).single();
  if (error) throw error;
  const next = data as DomainRow;
  if (row.status !== next.status && (next.status === 'active' || next.status === 'failing')) {
    await audit(row.organization_id, null, next.status === 'active' ? 'active' : 'failing', row.id, row.hostname, { problem });
    await notifyAdmins(row.organization_id, row.hostname, next.status, problem, next.portal_enabled === true);
  }
  return next;
}

async function refreshDomain(organizationId: string, _userId: string, domainId: string, config: ClientDomainsConfig) {
  const row = await loadDomain(organizationId, domainId);
  if (!LIVE_STATUSES.includes(row.status)) throw new HttpError('Dit domein is verwijderd.', 409);
  const next = await checkDomain(row, config);
  return { domain: domainView(next, config) };
}

async function removeDomain(organizationId: string, userId: string, domainId: string, config: ClientDomainsConfig) {
  const row = await loadDomain(organizationId, domainId);
  if (row.status === 'removed') return { removed: true };
  if (row.status === 'blocked') throw new HttpError('Dit domein is door ResoFly uitgezet. Neem contact op met ResoFly.', 409);
  // Was het actief: twaalf maanden doorsturen, zodat links in verstuurde mails
  // en PDF's blijven werken zolang het oude record naar ons wijst.
  if (row.verified_at && row.status !== 'moved') {
    const until = new Date();
    until.setMonth(until.getMonth() + REDIRECT_MONTHS);
    const { error } = await admin.from('client_domains')
      .update({ status: 'moved', redirect_until: until.toISOString() })
      .eq('id', row.id).eq('organization_id', organizationId);
    if (error) throw error;
    await audit(organizationId, userId, 'moved', row.id, row.hostname, { redirect_until: until.toISOString() });
    return { removed: false, redirectUntil: until.toISOString(), clientUrl: await clientBaseUrl(admin, organizationId, APP_PUBLIC_URL, config) };
  }
  // Nooit actief geweest (of de doorstuurtijd stoppen): ook bij Cloudflare weg.
  // Lukt dat niet, dan blijft het hier staan: anders blijft het daar zonder
  // rij die erbij hoort, en kan niemand het nog koppelen of opruimen.
  if (row.cf_custom_hostname_id) await cfDelete(row.cf_custom_hostname_id);
  const { error } = await admin.from('client_domains')
    .update({ status: 'removed', redirect_until: null, cf_custom_hostname_id: null })
    .eq('id', row.id).eq('organization_id', organizationId);
  if (error) throw error;
  await audit(organizationId, userId, 'removed', row.id, row.hostname, {});
  return { removed: true, clientUrl: await clientBaseUrl(admin, organizationId, APP_PUBLIC_URL, config) };
}

/**
 * Het klantportaal ook op het eigen domein, of niet. Een inlog daar geldt
 * alleen voor deze organisatie (portal_sessions), dus de DNS van het domein
 * geeft geen toegang tot wat een klant bij een ander heeft. Gaat het uit, dan
 * geven de inloggen van dat domein niets meer (portal_session_scope kijkt bij
 * elke aanroep of het portaal er nog aan staat).
 */
async function setPortal(organizationId: string, userId: string, domainId: string, enabled: boolean, config: ClientDomainsConfig) {
  const row = await loadDomain(organizationId, domainId);
  if (row.status === 'blocked') throw new HttpError('Dit domein is door ResoFly uitgezet. Neem contact op met ResoFly.', 409);
  if (!LIVE_STATUSES.includes(row.status)) throw new HttpError('Dit domein is verwijderd.', 409);
  if (row.portal_enabled === enabled) return { domain: domainView(row, config) };
  const { data, error } = await admin.from('client_domains').update({ portal_enabled: enabled })
    .eq('id', row.id).eq('organization_id', organizationId).select(DOMAIN_COLUMNS).single();
  if (error) throw error;
  await audit(organizationId, userId, enabled ? 'portal_enabled' : 'portal_disabled', row.id, row.hostname, {});
  return { domain: domainView(data as DomainRow, config) };
}

// ── Voor de Worker: wat hoort er bij deze hostnaam? ─────────────────────────

/**
 * Alleen met het gedeelde geheim van de Worker. Geeft alleen wat iedereen op
 * dat adres toch ziet: de status, het inlogadres van het portaal en de naam
 * en kleuren van het merk. Nooit het id van de organisatie.
 */
async function handleLookup(req: Request): Promise<Response> {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const secret = req.headers.get('x-client-domains-secret') || '';
  if (!WORKER_SECRET || !timingSafeEqual(secret, WORKER_SECRET)) return json({ ok: false, error: 'Geen toegang.' }, 401);
  if (req.method !== 'POST') return json({ ok: false, error: 'Alleen POST.' }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const host = normalizeHost(String(body.host ?? ''));
    const config = clientDomainsConfig();
    return json({ ok: true, ...(await lookupHost(host, config)) });
  } catch (err) {
    console.error('client-domains lookup', err instanceof Error ? err.message : err);
    return json({ ok: false, error: 'Opzoeken mislukt.' }, 500);
  }
}

/** Het huidige adres van een organisatie, ook als links nog niet "live" zijn: waar een oud adres heen stuurt. */
async function currentHost(organizationId: string, config: ClientDomainsConfig): Promise<string | null> {
  const { data: domain } = await admin.from('client_domains').select('hostname')
    .eq('organization_id', organizationId).eq('status', 'active').limit(1).maybeSingle();
  if (domain?.hostname) return String(domain.hostname);
  const { data: sub } = await admin.from('client_subdomains').select('name')
    .eq('organization_id', organizationId).eq('status', 'active').maybeSingle();
  return sub?.name ? subdomainHost(String(sub.name), config.base) : null;
}

async function brandFor(organizationId: string) {
  const [branding, key] = await Promise.all([
    loadBranding(admin, organizationId),
    admin.from('portal_login_addresses').select('key').eq('organization_id', organizationId).maybeSingle(),
  ]);
  return {
    portalKey: (key.data?.key as string | undefined) ?? null,
    brand: {
      name: branding.companyName,
      accentColor: branding.accentColor,
      headerColor: branding.headerColor,
      clientTheme: branding.clientTheme,
      hidePoweredBy: branding.hidePoweredBy,
    },
  };
}

async function lookupHost(host: string, config: ClientDomainsConfig) {
  const parsed = parseClientHost(host, config.base);
  if (!parsed) return { status: 'unknown' as const };
  const now = Date.now();
  if (parsed.kind === 'subdomain') {
    const { data, error } = await admin.from('client_subdomains').select('organization_id,status,redirect_until')
      .eq('name', parsed.name).maybeSingle();
    if (error) throw error;
    if (!data) return { status: 'unknown' as const };
    if (data.status === 'blocked') return { status: 'blocked' as const };
    if (data.status === 'redirect') {
      if (!data.redirect_until || Date.parse(data.redirect_until) <= now) return { status: 'unknown' as const };
      const target = await currentHost(String(data.organization_id), config);
      return target ? { status: 'redirect' as const, redirectHost: target } : { status: 'unknown' as const };
    }
    return { status: 'active' as const, kind: 'subdomain' as const, host, ...(await brandFor(String(data.organization_id))) };
  }
  const { data, error } = await admin.from('client_domains').select('organization_id,status,redirect_until,portal_enabled')
    .eq('hostname', parsed.hostname).neq('status', 'removed').limit(1).maybeSingle();
  if (error) throw error;
  if (!data) return { status: 'unknown' as const };
  if (data.status === 'blocked') return { status: 'blocked' as const };
  if (data.status === 'pending_dns' || data.status === 'pending_certificate') return { status: 'pending' as const };
  if (data.status === 'moved') {
    if (!data.redirect_until || Date.parse(data.redirect_until) <= now) return { status: 'unknown' as const };
    const target = await currentHost(String(data.organization_id), config);
    return target && target !== host ? { status: 'redirect' as const, redirectHost: target } : { status: 'unknown' as const };
  }
  // Het portaal staat hier als de organisatie het aanzette (setPortal). Anders
  // stuurt de Worker het door naar de naam bij ResoFly.
  if (data.portal_enabled === true) {
    return { status: 'active' as const, kind: 'custom' as const, host, portalEnabled: true, portalHost: null, ...(await brandFor(String(data.organization_id))) };
  }
  const { data: sub } = await admin.from('client_subdomains').select('name')
    .eq('organization_id', String(data.organization_id)).eq('status', 'active').maybeSingle();
  const portalHost = sub?.name ? subdomainHost(String(sub.name), config.base) : null;
  return { status: 'active' as const, kind: 'custom' as const, host, portalEnabled: false, portalHost, ...(await brandFor(String(data.organization_id))) };
}

// ── pg_cron: nalopen en opruimen ─────────────────────────────────────────────

async function handleCron(req: Request): Promise<Response> {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ ok: false, error: 'Alleen POST.' }, 405);
  const secret = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || !timingSafeEqual(secret, CRON_SECRET)) return json({ ok: false, error: 'Geen toegang: cron-secret ontbreekt of klopt niet.' }, 401);
  try {
    const config = clientDomainsConfig();
    const started = Date.now();
    const result = { checked: 0, removed: 0, failed: 0, names: 0, logins: 0, sessions: 0 };
    const nowIso = new Date().toISOString();

    // Oude namen waarvan de doorstuurtijd voorbij is: weer vrij.
    const { data: freed, error: freeError } = await admin.from('client_subdomains').delete()
      .eq('status', 'redirect').lt('redirect_until', nowIso).select('id');
    if (freeError) throw freeError;
    result.names = freed?.length ?? 0;

    // Inlogaanvragen van het portaal: na een dag weg (ze gelden een kwartier).
    const { data: logins, error: loginError } = await admin.from('portal_login_requests').delete()
      .lt('expires_at', new Date(Date.now() - 86_400_000).toISOString()).select('id');
    if (loginError) throw loginError;
    result.logins = logins?.length ?? 0;

    // Inloggen in het portaal die Supabase Auth niet meer kent (uitgelogd, verlopen).
    const { data: sessions, error: sessionError } = await admin.rpc('portal_sessions_cleanup');
    if (sessionError) throw sessionError;
    result.sessions = Number(sessions) || 0;

    if (cloudflare()) {
      // Verhuisde domeinen waarvan de doorstuurtijd voorbij is: ook bij Cloudflare weg.
      const { data: moved, error: movedError } = await admin.from('client_domains').select(DOMAIN_COLUMNS)
        .eq('status', 'moved').lt('redirect_until', nowIso).limit(50);
      if (movedError) throw movedError;
      for (const row of (moved ?? []) as DomainRow[]) {
        try {
          if (row.cf_custom_hostname_id) await cfDelete(row.cf_custom_hostname_id);
          await admin.from('client_domains').update({ status: 'removed', redirect_until: null, cf_custom_hostname_id: null })
            .eq('id', row.id).eq('organization_id', row.organization_id);
          result.removed += 1;
        } catch (err) {
          result.failed += 1;
          console.warn('client-domains cron: opruimen mislukte', row.hostname, err instanceof Error ? err.message : err);
        }
      }

      // Wachtende domeinen elke ronde (de eerste twee weken, daarna dagelijks),
      // actieve en haperende elke zes uur.
      const { data: due, error: dueError } = await admin.from('client_domains').select(DOMAIN_COLUMNS)
        .in('status', ['pending_dns', 'pending_certificate', 'active', 'failing'])
        .order('last_checked_at', { ascending: true, nullsFirst: true }).limit(200);
      if (dueError) throw dueError;
      for (const row of (due ?? []) as DomainRow[]) {
        if (Date.now() - started > 90_000) break;
        const age = Date.now() - Date.parse(row.created_at);
        const since = row.last_checked_at ? Date.now() - Date.parse(row.last_checked_at) : Infinity;
        const pending = row.status === 'pending_dns' || row.status === 'pending_certificate';
        const interval = pending ? (age < 14 * 86_400_000 ? 0 : 86_400_000) : 6 * 3_600_000;
        if (since < interval) continue;
        try {
          await checkDomain(row, config);
          result.checked += 1;
        } catch (err) {
          result.failed += 1;
          console.warn('client-domains cron: nalopen mislukte', row.hostname, err instanceof Error ? err.message : err);
        }
      }
    }
    return json({ ok: true, ...result });
  } catch (err) {
    console.error('client-domains cron', err instanceof Error ? err.message : err);
    return json({ ok: false, error: 'Nalopen mislukte.' }, 500);
  }
}

// ── Logboek en meldingen ────────────────────────────────────────────────────

/** Wat er met een eigen domein gebeurde. De zin in het Logboek: src/lib/auditLog.ts. */
type DomainEvent = 'added' | 'active' | 'failing' | 'moved' | 'removed' | 'taken_over' | 'portal_enabled' | 'portal_disabled';

// audit_logs.action kent een vaste lijst (audit_logs_action_check). De
// gebeurtenis gaat daarom in de metadata, bij de handeling die erbij past.
// Eerst stonden hier eigen handelingen ('added', …): die
// weigerde de database, en dan stond er niets in het Logboek.
const EVENT_ACTION: Record<DomainEvent, 'created' | 'updated' | 'deleted'> = {
  added: 'created', active: 'updated', failing: 'updated', moved: 'updated', removed: 'deleted', taken_over: 'deleted',
  portal_enabled: 'updated', portal_disabled: 'updated',
};

async function audit(organizationId: string, userId: string | null, event: DomainEvent, entityId: string, label: string, metadata: Record<string, unknown>) {
  const { error } = await admin.from('audit_logs').insert({
    organization_id: organizationId,
    actor_user_id: userId,
    action: EVENT_ACTION[event],
    entity_type: 'client_domain',
    entity_id: entityId,
    entity_label: label,
    metadata: { ...metadata, event },
  });
  if (error) console.warn('client-domains: auditregel wegschrijven mislukte', error.message);
}

/** Een mail aan de eigenaar en de beheerders als een eigen domein actief wordt of hapert. */
async function notifyAdmins(organizationId: string, hostname: string, status: 'active' | 'failing', problem: string | null, portalEnabled: boolean) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) return;
  try {
    const { data: members } = await admin.from('organization_members').select('email,role')
      .eq('organization_id', organizationId).eq('status', 'active').in('role', ['owner', 'admin']);
    const to = [...new Set(((members ?? []) as Array<{ email: string | null }>).map(m => String(m.email ?? '').trim().toLowerCase()).filter(Boolean))];
    if (to.length === 0) return;
    const branding = await loadBranding(admin, organizationId);
    const active = status === 'active';
    const title = active ? `${hostname} is actief` : `${hostname} werkt niet meer`;
    const intro = active
      ? `<p>Je eigen domein <strong>${escapeHtml(hostname)}</strong> is klaar. Je klanten openen je albums, offertes, facturen en contracten vanaf nu op dat adres.${portalEnabled
        ? ' Het klantportaal ook.'
        : ' Het klantportaal staat op je adres bij ResoFly. Wil je het ook op dit domein? Zet het aan bij Instellingen → Domein.'}</p>`
      : `<p>Je eigen domein <strong>${escapeHtml(hostname)}</strong> werkt niet meer.${problem ? ` ${escapeHtml(problem)}` : ''}</p><p>Nieuwe mails linken zolang naar je adres bij ResoFly. Kijk in ResoFly bij Instellingen → Domein wat er moet gebeuren.</p>`;
    const html = renderEmailLayout({ brandName: branding.companyName || 'ResoFly', title, introHtml: intro, accentColor: branding.accentColor });
    // Telt mee in het mailquotum van de organisatie, en met haar logo, net als elke andere mail.
    await takeEmailQuota(admin, organizationId, to.length, (message) => new Error(message));
    const brand = await loadEmailBrand(admin, organizationId);
    await sendViaResend(RESEND_API_KEY, withEmailBrand({
      from: RESEND_FROM_EMAIL,
      to,
      subject: active ? `Je eigen domein ${hostname} is actief` : `Let op: je eigen domein ${hostname} werkt niet meer`,
      html,
    }, brand), `client-domain-${sanitizeIdempotencyPart(hostname)}-${status}-${new Date().toISOString().slice(0, 13)}`);
  } catch (err) {
    console.warn('client-domains: melding versturen mislukte', err instanceof Error ? err.message : err);
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i++) out |= left[i] ^ right[i];
  return out === 0;
}

