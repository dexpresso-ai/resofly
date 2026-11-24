import {
  HttpError, assertModuleAccess, createAdminClient, isUuid,
  makeCors, parseAllowedOrigins, requireOrganizationAccess, requireUser,
} from '../_shared/edgeAuth.ts';
import {
  OAUTH_STATE_TTL_SECONDS,
  checkOAuthState,
  classifyProviderError,
  classifyTokenFailure,
  fallbackReturnTo,
  parseReturnOrigins,
  signOAuthState,
  timingSafeEqual,
  withReturnParams,
  type TokenFailure,
} from '../_shared/calendarOAuth.ts';
import {
  MAX_JOB_ATTEMPTS,
  NO_CLIENT_FOLDER,
  buildOneDriveAuthorizeUrl,
  classifyGraphResponse,
  contentVersion,
  decryptToken,
  documentFileName,
  encryptToken,
  hasFilesScope,
  isDriveId,
  mirrorableKey,
  nextAttemptDelaySeconds,
  numberedName,
  onedriveRefreshScopes,
  onedriveScopes,
  onedriveStateSecret,
  rootFolderName,
  safeDriveName,
  strictReturnTo,
} from '../_shared/onedriveSync.ts';

// ============================================================
// ResoFly — Een kopie van Inhoud in OneDrive (onedrive-sync)
//
// Plan en keuzes: docs/plannen/ONEDRIVE_KOPIE_PLAN_2026-11-24.md.
//
// GET  ?state&code        — terugkeer van Microsoft na "toestaan"
// POST ?cron=sync         — de wachtrij afwerken (x-cron-secret)
// POST, ingelogd:
//   status       — de koppeling, de wachtrij en wat er misging (eigenaar)
//   oauthStart   — toestemmingslink (eigenaar)
//   oauthComplete— afronden, met de sessie van wie startte (eigenaar)
//   enable       — de kopie aanzetten: de map van de organisatie in OneDrive (eigenaar)
//   disable      — de kopie uitzetten; wat in OneDrive staat, blijft (eigenaar)
//   disconnect   — ontkoppelen (eigenaar)
//   resyncAll    — "Alles opnieuw kopiëren" (eigenaar)
//   retryFailed  — wat mislukte opnieuw proberen (eigenaar)
//   process      — de wachtrij nu afwerken (wie Inhoud mag lezen: de app
//                  zwengelt hem aan na een wijziging)
//
// Deze functie draait op de service-role. Daarom hier expliciet: lid van de
// organisatie, de module Inhoud, en voor alles wat de koppeling verandert de
// rol eigenaar. organization_id komt uit de sessie of de ondertekende state,
// nooit los uit invoer (harde regel 1).
//
// Wat er in OneDrive moet gebeuren, zetten triggers in onedrive_sync_jobs (ook
// bij een cascade, zoals een verwijderde klant). Per taak rekent deze functie
// uit hoe het er in OneDrive uit moet zien, en maakt het zo. ResoFly is
// leidend: wat iemand in OneDrive zelf doet, neemt ResoFly niet over.
// ============================================================

const admin = createAdminClient();

function env(name: string): string {
  return (Deno.env.get(name) || '').trim();
}

const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '');
const REDIRECT_URL = env('ONEDRIVE_REDIRECT_URL') || `${SUPABASE_URL}/functions/v1/onedrive-sync`;
const STATE_SECRET = onedriveStateSecret(env('ONEDRIVE_OAUTH_STATE_SECRET') || env('CALENDAR_OAUTH_STATE_SECRET'));
const TOKEN_KEY = env('ONEDRIVE_TOKEN_ENCRYPTION_KEY') || env('CALENDAR_TOKEN_ENCRYPTION_KEY');
const RETURN_ORIGINS = parseReturnOrigins(env('ONEDRIVE_ALLOWED_RETURN_ORIGINS') || env('CALENDAR_ALLOWED_RETURN_ORIGINS'));
// Dezelfde app-registratie als de agenda, tenzij je er een eigen wilt.
const CLIENT_ID = env('ONEDRIVE_CLIENT_ID') || env('MICROSOFT_CALENDAR_CLIENT_ID');
const CLIENT_SECRET = env('ONEDRIVE_CLIENT_SECRET') || env('MICROSOFT_CALENDAR_CLIENT_SECRET');
const TENANT = env('ONEDRIVE_TENANT_ID') || env('MICROSOFT_CALENDAR_TENANT_ID') || 'common';
const CRON_SECRET = env('ONEDRIVE_SYNC_CRON_SECRET');
// De media-worker stuurt de bestanden uit R2 naar OneDrive (/internal/onedrive/push).
const MEDIA_WORKER_URL = (env('MEDIA_WORKER_URL') || env('INVOICE_PDF_STORAGE_WORKER_URL') || env('QUOTE_PDF_STORAGE_WORKER_URL')).replace(/\/$/, '');
const MEDIA_WORKER_SECRET = env('INTERNAL_UPLOAD_SECRET') || env('INVOICE_PDF_STORAGE_SECRET') || env('QUOTE_PDF_STORAGE_SECRET');

// Dezelfde lijsten als file-share en file-transfer, plus die van de agenda:
// welke er op een omgeving staat, verschilt, en elk ervan noemt de app.
const cors = makeCors(
  parseAllowedOrigins([
    env('ONEDRIVE_ALLOWED_ORIGINS'),
    env('FILE_SHARE_ALLOWED_ORIGINS'),
    env('APP_ALLOWED_ORIGINS'),
    env('APP_PUBLIC_URL'),
    env('MAIL_ALLOWED_ORIGINS'),
    env('CALENDAR_ALLOWED_RETURN_ORIGINS'),
  ]),
  env('ALLOW_LOCAL_DEV') === '1',
);

const TOKEN_URL = `https://login.microsoftonline.com/${encodeURIComponent(TENANT)}/oauth2/v2.0/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const ITEM_SELECT = 'id,name,cTag,eTag,webUrl,parentReference,folder,file';

type MirrorRow = {
  organization_id: string;
  connected_by: string;
  account_id: string;
  account_email: string | null;
  display_name: string | null;
  drive_id: string | null;
  root_item_id: string | null;
  root_name: string | null;
  root_web_url: string | null;
  enabled: boolean;
  status: 'active' | 'expired' | 'error';
  scopes: string[];
  last_error: string | null;
  last_synced_at: string | null;
  enabled_at: string | null;
};

type TokenRow = {
  organization_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_type: string | null;
  scopes: string[];
  expires_at: string | null;
};

type ItemType = 'noclient' | 'client' | 'project' | 'folder' | 'attachment' | 'document';

type MapRow = {
  organization_id: string;
  item_type: ItemType;
  item_id: string;
  drive_item_id: string;
  parent_drive_item_id: string | null;
  name: string;
  desired_name: string;
  content_version: string | null;
  remote_tag: string | null;
};

type JobRow = {
  id: string;
  organization_id: string;
  item_type: 'client' | 'project' | 'folder' | 'attachment' | 'document';
  item_id: string;
  kind: 'sync' | 'delete';
  verify: boolean;
  seq: number;
  status: 'pending' | 'failed';
  attempts: number;
  last_error: string | null;
};

/** Een map in de keten naar een bestand: klant, project, dossiermap, of "Zonder klant". */
type ContainerNode = { type: 'noclient' | 'client' | 'project' | 'folder'; id: string; name: string };

// ── Fouten ────────────────────────────────────────────────────────────

/** Het vernieuwen van het token lukte niet; `failure` zegt of opnieuw koppelen helpt. */
class TokenError extends Error {
  failure: TokenFailure;
  constructor(message: string, failure: TokenFailure) {
    super(message);
    this.name = 'TokenError';
    this.failure = failure;
  }
}

/** De koppeling werkt niet (meer): de taken van deze organisatie wachten. */
class MirrorPaused extends Error {}

/** Later opnieuw, na zoveel seconden (of de standaardwachttijd). */
class RetryLater extends Error {
  seconds: number | null;
  constructor(message: string, seconds: number | null = null) {
    super(message);
    this.seconds = seconds;
  }
}

/** Opnieuw proberen helpt niet; een mens moet kijken. */
class JobFailed extends Error {}

/** Een map waarin we iets zetten, bestaat in OneDrive niet meer: de keten opnieuw nalopen. */
class ParentGone extends Error {}

function toHttp(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof TokenError) return { status: err.failure === 'tijdelijk' ? 503 : 409, message: err.message };
  if (err instanceof MirrorPaused || err instanceof JobFailed) return { status: 409, message: err.message };
  if (err instanceof RetryLater) return { status: 503, message: err.message };
  const pg = err as { message?: string; code?: string };
  if (pg && typeof pg === 'object' && typeof pg.code === 'string') {
    if (pg.code === '42501' || pg.code === 'P0001') return { status: 403, message: pg.message || 'Dat mag niet.' };
    console.error('onedrive-sync databasefout', pg.code, pg.message);
    return { status: 500, message: 'Er ging iets mis in de database. Probeer het opnieuw.' };
  }
  return { status: 500, message: err instanceof Error ? err.message : 'Onbekende fout' };
}

async function must<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ── De ingang ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('cron') === 'sync') return await handleCron(req);
  if (req.method === 'GET') return await handleOAuthCallback(url);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Alleen POST.', 400);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const user = await requireUser(admin, req);

    // De organisatie komt hier uit de ondertekende state, niet uit de body.
    if (action === 'oauthComplete') return cors.json(req, { ok: true, ...(await completeOAuth(user.id, body)) });

    const organizationId = String(body.organizationId || '');
    if (!isUuid(organizationId)) throw new HttpError('organizationId is verplicht.', 400);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    await assertModuleAccess(admin, user.id, organizationId, 'content', 'read');
    const requireOwner = () => {
      if (role !== 'owner') throw new HttpError('Alleen de eigenaar van de organisatie regelt de kopie in OneDrive.', 403);
    };

    switch (action) {
      case 'status': requireOwner(); return cors.json(req, { ok: true, ...(await status(organizationId, user.id)) });
      case 'oauthStart': requireOwner(); return cors.json(req, { ok: true, authUrl: await startOAuth(organizationId, user.id, body) });
      case 'enable': requireOwner(); await enable(organizationId); return cors.json(req, { ok: true, ...(await status(organizationId, user.id)) });
      case 'disable': requireOwner(); await disable(organizationId); return cors.json(req, { ok: true, ...(await status(organizationId, user.id)) });
      case 'disconnect': requireOwner(); await disconnect(organizationId); return cors.json(req, { ok: true, ...(await status(organizationId, user.id)) });
      case 'resyncAll': {
        requireOwner();
        const queued = await resyncAll(organizationId);
        return cors.json(req, { ok: true, queued, ...(await status(organizationId, user.id)) });
      }
      case 'retryFailed': requireOwner(); await retryFailed(organizationId); return cors.json(req, { ok: true, ...(await status(organizationId, user.id)) });
      // Werkt alleen af wat de database al klaarzette, na wijzigingen door
      // iemand met de rechten daarvoor. Lezen is genoeg om het aan te zwengelen.
      case 'process': return cors.json(req, { ok: true, ...(await processDue({ organizationId, limit: 25, budgetMs: 25_000 })) });
      default: throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
  } catch (err) {
    const { status, message } = toHttp(err);
    if (status >= 500) console.error('onedrive-sync error', message, err instanceof Error ? err.stack : err);
    else console.warn('onedrive-sync weigert', status, message);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

// ── Wat er is ingesteld ───────────────────────────────────────────────

function configured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET && STATE_SECRET && TOKEN_KEY && TOKEN_KEY.length >= 16);
}

function assertConfigured(): void {
  if (!configured()) {
    throw new HttpError('OneDrive is op deze omgeving nog niet ingesteld. Vraag de beheerder van ResoFly om de koppeling in te richten.', 400);
  }
}

async function loadMirror(organizationId: string): Promise<MirrorRow | null> {
  return (await must(admin.from('onedrive_mirrors').select('*').eq('organization_id', organizationId).maybeSingle())) as MirrorRow | null;
}

async function itemName(organizationId: string, type: string, id: string): Promise<string | null> {
  const table = type === 'attachment' ? 'attachments' : type === 'document' ? 'documents' : type === 'folder' ? 'content_folders' : type === 'client' ? 'clients' : type === 'project' ? 'projects' : null;
  if (!table) return null;
  const column = type === 'document' ? 'title' : 'name';
  const { data } = await admin.from(table).select(column).eq('id', id).eq('organization_id', organizationId).maybeSingle();
  const value = data ? (data as Record<string, unknown>)[column] : null;
  return typeof value === 'string' ? value : null;
}

async function status(organizationId: string, userId: string) {
  const mirror = await loadMirror(organizationId);
  const count = async (statusValue: 'pending' | 'failed') => {
    const { count: n, error } = await admin.from('onedrive_sync_jobs').select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId).eq('status', statusValue);
    if (error) throw error;
    return n ?? 0;
  };
  const failedRows = (await must(admin.from('onedrive_sync_jobs').select('id,item_type,item_id,kind,last_error,attempts,updated_at')
    .eq('organization_id', organizationId).eq('status', 'failed').order('updated_at', { ascending: false }).limit(20))) as Array<{
      id: string; item_type: string; item_id: string; kind: string; last_error: string | null; attempts: number; updated_at: string;
    }>;
  const failedItems = [];
  for (const row of failedRows) {
    failedItems.push({
      id: row.id,
      itemType: row.item_type,
      kind: row.kind,
      name: (await itemName(organizationId, row.item_type, row.item_id)) ?? '(verwijderd)',
      lastError: row.last_error,
      attempts: row.attempts,
      updatedAt: row.updated_at,
    });
  }
  return {
    configured: configured(),
    connection: mirror ? {
      account: mirror.account_email,
      name: mirror.display_name,
      status: mirror.status,
      lastError: mirror.last_error,
      enabled: mirror.enabled,
      rootName: mirror.root_name,
      rootWebUrl: safeWebUrl(mirror.root_web_url),
      lastSyncedAt: mirror.last_synced_at,
      enabledAt: mirror.enabled_at,
      connectedByMe: mirror.connected_by === userId,
    } : null,
    queue: { pending: await count('pending'), failed: await count('failed'), failedItems },
  };
}

/** Een link naar OneDrive in de app: alleen https bij Microsoft. */
function safeWebUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const ok = url.protocol === 'https:' && (host === 'onedrive.live.com' || host === '1drv.ms' || host.endsWith('.sharepoint.com'));
    return ok ? url.toString() : null;
  } catch {
    return null;
  }
}

// ── Koppelen ──────────────────────────────────────────────────────────

async function startOAuth(organizationId: string, userId: string, body: Record<string, unknown>): Promise<string> {
  assertConfigured();
  let returnTo: string;
  try {
    returnTo = strictReturnTo(body.returnTo, RETURN_ORIGINS);
  } catch (err) {
    throw new HttpError(err instanceof Error ? err.message : 'Ongeldig terugkeeradres.', 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const state = await signOAuthState({
    provider: 'microsoft',
    userId,
    organizationId,
    returnTo,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + OAUTH_STATE_TTL_SECONDS,
  }, STATE_SECRET);
  const mirror = await loadMirror(organizationId);
  return buildOneDriveAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URL, state, tenant: TENANT, loginHint: mirror?.account_email ?? body.loginHint });
}

function redirectTo(location: string): Response {
  // no-store: in deze redirect staat een eenmalige code; die hoort in geen enkele cache.
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function plainError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/**
 * De terugkeer van Microsoft. De code wordt hier NIET ingewisseld: deze stap
 * heeft geen sessie, en wie de toestemmingslink volgt is niet per se wie hem
 * startte. De app rondt af met de sessie van wie er is ingelogd (dezelfde les
 * als bij de agenda, calendar-integrations).
 */
async function handleOAuthCallback(url: URL): Promise<Response> {
  if (!STATE_SECRET) return plainError('OneDrive is op deze omgeving nog niet ingesteld.', 500);
  const stateRaw = url.searchParams.get('state');
  const check = await checkOAuthState(stateRaw, STATE_SECRET, RETURN_ORIGINS);
  if (!check.ok && check.reason === 'ongeldig') {
    console.warn('onedrive-sync OAuth callback: ongeldige state');
    const fallback = fallbackReturnTo(RETURN_ORIGINS);
    if (fallback) return redirectTo(withReturnParams(fallback, { onedrive_error: 'ongeldig' }));
    return plainError('Deze koppellink klopt niet (meer). Start het koppelen opnieuw vanuit ResoFly.');
  }
  const state = check.state;
  const providerError = url.searchParams.get('error');
  if (providerError) {
    console.warn('onedrive-sync OAuth callback: Microsoft meldt een fout', providerError, url.searchParams.get('error_description'));
    const code = classifyProviderError(providerError, url.searchParams.get('error_description'), url.searchParams.get('error_subcode'));
    return redirectTo(withReturnParams(state.returnTo, { onedrive_error: code }));
  }
  if (!check.ok) return redirectTo(withReturnParams(state.returnTo, { onedrive_error: 'verlopen' }));
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) return redirectTo(withReturnParams(state.returnTo, { onedrive_error: 'mislukt' }));
  return redirectTo(withReturnParams(state.returnTo, { onedrive_code: code, onedrive_state: stateRaw ?? '' }));
}

function parseScope(scope: unknown, fallback: string[]): string[] {
  if (typeof scope !== 'string' || !scope.trim()) return fallback;
  return scope.split(/\s+/).filter(Boolean);
}

async function completeOAuth(userId: string, body: Record<string, unknown>) {
  assertConfigured();
  const code = String(body.code || '');
  if (!code || code.length > 4096) throw new HttpError('De code van Microsoft ontbreekt. Start het koppelen opnieuw.', 400);
  const check = await checkOAuthState(body.state, STATE_SECRET, RETURN_ORIGINS);
  if (!check.ok) {
    throw new HttpError(check.reason === 'verlopen'
      ? 'Het koppelen duurde te lang. Begin opnieuw vanuit Instellingen → OneDrive.'
      : 'Deze koppellink klopt niet (meer). Begin opnieuw vanuit Instellingen → OneDrive.', 400);
  }
  const state = check.state;
  if (state.userId !== userId) {
    throw new HttpError('Deze koppeling is gestart door een ander account. Start hem opnieuw vanuit je eigen werkruimte.', 403);
  }
  const organizationId = state.organizationId;
  const role = await requireOrganizationAccess(admin, userId, organizationId);
  if (role !== 'owner') throw new HttpError('Alleen de eigenaar van de organisatie koppelt OneDrive.', 403);

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URL,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(15_000) });
  const token = await res.json().catch(() => ({})) as Record<string, string | number | undefined>;
  if (!res.ok) {
    console.warn('onedrive-sync code exchange mislukt', res.status, token.error, token.error_description);
    if (token.error === 'invalid_grant') throw new HttpError('Deze toestemming is al gebruikt of verlopen. Begin opnieuw met koppelen.', 400);
    throw new HttpError(`Microsoft gaf geen toegang terug${token.error ? ` (${String(token.error).slice(0, 60)})` : ''}. Probeer het opnieuw; blijft het misgaan, laat de beheerder van ResoFly de koppeling nakijken.`, 502);
  }
  const accessToken = String(token.access_token || '');
  if (!accessToken) throw new HttpError('Microsoft gaf geen toegang terug. Start het koppelen opnieuw.', 502);
  const granted = parseScope(token.scope, onedriveScopes());
  if (!hasFilesScope(granted)) {
    throw new HttpError('Microsoft gaf geen toegang tot je OneDrive. Koppel opnieuw en sta de rechten voor je bestanden toe; lukt dat niet, vraag dan de beheerder van je Microsoft-account om ResoFly goed te keuren.', 400);
  }

  const me = await graph(accessToken, 'GET', '/me?$select=id,mail,userPrincipalName,displayName');
  const drive = await graph(accessToken, 'GET', '/me/drive?$select=id,driveType');
  if (me.status !== 200 || drive.status !== 200) {
    throw new HttpError('Je OneDrive kon niet worden gelezen. Heeft dit Microsoft-account wel een OneDrive? Probeer het opnieuw.', 502);
  }
  const accountId = String((me.body as Record<string, unknown>).id ?? '');
  const driveId = String((drive.body as Record<string, unknown>).id ?? '');
  if (!accountId || !isDriveId(driveId)) throw new HttpError('Microsoft gaf geen OneDrive terug. Start het koppelen opnieuw.', 502);
  const meBody = me.body as Record<string, unknown>;
  const email = typeof meBody.mail === 'string' && meBody.mail ? meBody.mail : typeof meBody.userPrincipalName === 'string' ? meBody.userPrincipalName : null;

  // Een ander account dan eerst: de oude map hoort daar niet bij. Alles wat
  // ResoFly over de oude kopie wist, gaat weg; de kopie staat dan uit.
  const existing = await loadMirror(organizationId);
  const sameAccount = existing && existing.account_id === accountId && existing.drive_id === driveId;
  if (existing && !sameAccount) {
    await must(admin.from('onedrive_sync_jobs').delete().eq('organization_id', organizationId));
    await must(admin.from('onedrive_sync_items').delete().eq('organization_id', organizationId));
  }
  await must(admin.from('onedrive_mirrors').upsert({
    organization_id: organizationId,
    connected_by: userId,
    account_id: accountId,
    account_email: email,
    display_name: typeof meBody.displayName === 'string' ? meBody.displayName : null,
    drive_id: driveId,
    ...(sameAccount ? {} : { root_item_id: null, root_name: null, root_web_url: null, enabled: false, enabled_at: null }),
    status: 'active',
    scopes: granted,
    last_error: null,
  }, { onConflict: 'organization_id' }));

  const prior = (await must(admin.from('onedrive_mirror_tokens').select('refresh_token_encrypted').eq('organization_id', organizationId).maybeSingle())) as { refresh_token_encrypted: string | null } | null;
  await must(admin.from('onedrive_mirror_tokens').upsert({
    organization_id: organizationId,
    access_token_encrypted: await encryptToken(accessToken, TOKEN_KEY),
    refresh_token_encrypted: token.refresh_token ? await encryptToken(String(token.refresh_token), TOKEN_KEY) : sameAccount ? prior?.refresh_token_encrypted ?? null : null,
    token_type: token.token_type ? String(token.token_type) : 'Bearer',
    scopes: granted,
    expires_at: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
  }, { onConflict: 'organization_id' }));

  return { organizationId, account: email, enabled: Boolean(sameAccount && existing?.enabled) };
}

async function enable(organizationId: string): Promise<void> {
  assertConfigured();
  const mirror = await loadMirror(organizationId);
  if (!mirror) throw new HttpError('Koppel eerst OneDrive.', 409);
  if (mirror.status !== 'active') throw new HttpError('De koppeling met OneDrive werkt niet meer. Koppel opnieuw.', 409);
  const ctx = await orgContext(mirror);
  const root = await ensureRoot(ctx, true);
  await must(admin.from('onedrive_mirrors').update({
    enabled: true,
    enabled_at: mirror.enabled ? mirror.enabled_at : new Date().toISOString(),
    root_item_id: root.id,
    root_name: root.name,
    root_web_url: root.webUrl,
    last_error: null,
  }).eq('organization_id', organizationId));
}

async function disable(organizationId: string): Promise<void> {
  await must(admin.from('onedrive_mirrors').update({ enabled: false }).eq('organization_id', organizationId));
  await must(admin.from('onedrive_sync_jobs').delete().eq('organization_id', organizationId));
}

/** Ontkoppelen: de koppeling en wat ResoFly erover wist, gaan weg. De bestanden in OneDrive blijven staan. */
async function disconnect(organizationId: string): Promise<void> {
  await must(admin.from('onedrive_sync_jobs').delete().eq('organization_id', organizationId));
  await must(admin.from('onedrive_sync_items').delete().eq('organization_id', organizationId));
  await must(admin.from('onedrive_mirrors').delete().eq('organization_id', organizationId));
}

async function resyncAll(organizationId: string): Promise<number> {
  const mirror = await loadMirror(organizationId);
  if (!mirror?.enabled) throw new HttpError('Zet de kopie eerst aan.', 409);
  const { data, error } = await admin.rpc('onedrive_queue_full_sync', { p_org: organizationId });
  if (error) throw error;
  return Number(data ?? 0);
}

async function retryFailed(organizationId: string): Promise<void> {
  await must(admin.from('onedrive_sync_jobs')
    .update({ status: 'pending', attempts: 0, last_error: null, next_attempt_at: new Date().toISOString(), claimed_until: null })
    .eq('organization_id', organizationId).eq('status', 'failed'));
  await must(admin.from('onedrive_mirrors').update({ last_error: null }).eq('organization_id', organizationId).eq('status', 'active'));
}

// ── Tokens en Microsoft Graph ─────────────────────────────────────────

async function accessTokenFor(mirror: MirrorRow): Promise<string> {
  const token = (await must(admin.from('onedrive_mirror_tokens').select('*').eq('organization_id', mirror.organization_id).maybeSingle())) as TokenRow | null;
  if (!token) throw new TokenError('De koppeling met OneDrive staat uit. De eigenaar moet OneDrive opnieuw koppelen.', 'ingetrokken');
  const expires = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (expires && expires - Date.now() > 120_000) return await decryptToken(token.access_token_encrypted, TOKEN_KEY);
  if (!token.refresh_token_encrypted) throw new TokenError('OneDrive geeft ResoFly geen toegang meer (verlopen). De eigenaar moet OneDrive opnieuw koppelen.', 'ingetrokken');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: await decryptToken(token.refresh_token_encrypted, TOKEN_KEY),
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: onedriveRefreshScopes(token.scopes).join(' '),
  });
  let status = 0;
  let payload: Record<string, unknown> = {};
  try {
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params, signal: AbortSignal.timeout(15_000) });
    status = res.status;
    payload = await res.json().catch(() => ({}));
  } catch (err) {
    console.warn('onedrive-sync token refresh: netwerkfout', err);
  }
  if (status < 200 || status >= 300 || !payload.access_token) {
    const failure: TokenFailure = status >= 200 && status < 300 ? 'tijdelijk' : classifyTokenFailure(status, payload);
    const message = failure === 'ingetrokken'
      ? 'OneDrive geeft ResoFly geen toegang meer (ingetrokken of verlopen). De eigenaar moet OneDrive opnieuw koppelen.'
      : failure === 'instelling'
        ? `De koppeling met OneDrive is niet goed ingesteld${payload.error ? ` (${String(payload.error).slice(0, 60)})` : ''}. Laat de beheerder van ResoFly dit nakijken.`
        : 'Microsoft was even niet bereikbaar. ResoFly probeert het straks opnieuw.';
    console.warn('onedrive-sync token refresh mislukt', status, payload.error, payload.error_description);
    if (failure !== 'tijdelijk') {
      await admin.from('onedrive_mirrors').update({ status: failure === 'ingetrokken' ? 'expired' : 'error', last_error: message })
        .eq('organization_id', mirror.organization_id);
    }
    throw new TokenError(message, failure);
  }
  const accessToken = String(payload.access_token);
  await admin.from('onedrive_mirror_tokens').update({
    access_token_encrypted: await encryptToken(accessToken, TOKEN_KEY),
    refresh_token_encrypted: payload.refresh_token ? await encryptToken(String(payload.refresh_token), TOKEN_KEY) : token.refresh_token_encrypted,
    token_type: payload.token_type ? String(payload.token_type) : token.token_type,
    scopes: parseScope(payload.scope, token.scopes),
    expires_at: payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : null,
  }).eq('organization_id', mirror.organization_id);
  return accessToken;
}

type GraphResult = { status: number; body: unknown; retryAfter: string | null };

async function graph(accessToken: string, method: string, path: string, body?: unknown, rawBody?: BodyInit): Promise<GraphResult> {
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (rawBody !== undefined) headers['Content-Type'] = 'application/octet-stream';
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : rawBody,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, retryAfter: res.headers.get('retry-after') };
  } catch (err) {
    console.warn('onedrive-sync: Microsoft niet bereikbaar', method, path.split('?')[0], err);
    return { status: 0, body: null, retryAfter: null };
  }
}

/**
 * Wat een mislukt antwoord betekent, als uitzondering. 404 en 409 behandelt
 * de aanroeper zelf; hier komt de rest.
 */
async function raiseFor(ctx: OrgCtx, res: GraphResult): Promise<never> {
  const outcome = classifyGraphResponse(res.status, res.body, res.retryAfter);
  if (outcome.kind === 'reconnect') {
    await admin.from('onedrive_mirrors').update({ status: 'expired', last_error: outcome.message }).eq('organization_id', ctx.orgId);
    throw new MirrorPaused(outcome.message);
  }
  if (outcome.kind === 'full') {
    ctx.problem = outcome.message;
    throw new RetryLater(outcome.message, 3600);
  }
  if (outcome.kind === 'retry') throw new RetryLater(outcome.message, outcome.retryAfterSeconds);
  if (outcome.kind === 'gone') throw new ParentGone('Niet gevonden in OneDrive.');
  if (outcome.kind === 'conflict') throw new RetryLater('Er stond in OneDrive al iets met deze naam.');
  if (outcome.kind === 'failed') throw new JobFailed(outcome.message);
  throw new JobFailed('Onverwacht antwoord van OneDrive.');
}

function driveItemOf(body: unknown): { id: string; name: string; parentId: string | null; cTag: string | null; webUrl: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!isDriveId(b.id)) return null;
  const parent = (b.parentReference && typeof b.parentReference === 'object' ? b.parentReference : {}) as Record<string, unknown>;
  return {
    id: b.id,
    name: typeof b.name === 'string' ? b.name : '',
    parentId: isDriveId(parent.id) ? parent.id : null,
    cTag: typeof b.cTag === 'string' ? b.cTag : null,
    webUrl: typeof b.webUrl === 'string' ? b.webUrl : null,
  };
}

// ── De wachtrij afwerken ──────────────────────────────────────────────

type OrgCtx = {
  orgId: string;
  mirror: MirrorRow;
  driveId: string;
  token: string;
  /** Wat de eigenaar moet weten (OneDrive vol); komt in onedrive_mirrors.last_error. */
  problem: string | null;
  synced: number;
};

async function orgContext(mirror: MirrorRow): Promise<OrgCtx> {
  if (!mirror.drive_id || !isDriveId(mirror.drive_id)) throw new MirrorPaused('Er is geen OneDrive gekoppeld.');
  let token: string;
  try {
    token = await accessTokenFor(mirror);
  } catch (err) {
    if (err instanceof TokenError && err.failure !== 'tijdelijk') throw new MirrorPaused(err.message);
    if (err instanceof TokenError) throw new RetryLater(err.message);
    throw err;
  }
  return { orgId: mirror.organization_id, mirror, driveId: mirror.drive_id, token, problem: null, synced: 0 };
}

async function processDue(filter: { organizationId?: string; limit: number; budgetMs: number }) {
  const deadline = Date.now() + filter.budgetMs;
  const counts = { done: 0, retry: 0, failed: 0, paused: 0 };
  const { data, error } = await admin.rpc('onedrive_claim_jobs', { p_org: filter.organizationId ?? null, p_limit: filter.limit, p_lease_seconds: 300 });
  if (error) throw error;
  const jobs = (data ?? []) as JobRow[];
  const contexts = new Map<string, OrgCtx | Error>();

  for (const job of jobs) {
    if (Date.now() > deadline) {
      await releaseClaim(job);
      continue;
    }
    let ctx = contexts.get(job.organization_id);
    if (!ctx) {
      try {
        const mirror = await loadMirror(job.organization_id);
        if (!mirror?.enabled) {
          await admin.from('onedrive_sync_jobs').delete().eq('id', job.id);
          continue;
        }
        ctx = await orgContext(mirror);
      } catch (err) {
        ctx = err instanceof Error ? err : new Error(String(err));
      }
      contexts.set(job.organization_id, ctx);
    }
    if (ctx instanceof Error) {
      await finishJob(job, ctx instanceof RetryLater ? { kind: 'retry', message: ctx.message, seconds: ctx.seconds } : { kind: 'paused' });
      counts[ctx instanceof RetryLater ? 'retry' : 'paused'] += 1;
      continue;
    }
    const outcome = await runJob(ctx, job);
    await finishJob(job, outcome);
    if (outcome.kind === 'done') { counts.done += 1; ctx.synced += 1; }
    else if (outcome.kind === 'retry') counts.retry += 1;
    else if (outcome.kind === 'failed') counts.failed += 1;
    else {
      counts.paused += 1;
      contexts.set(job.organization_id, new MirrorPaused('Gepauzeerd'));
    }
  }

  for (const ctx of contexts.values()) {
    if (ctx instanceof Error) continue;
    const patch: Record<string, unknown> = {};
    if (ctx.synced > 0) patch.last_synced_at = new Date().toISOString();
    if (ctx.problem) patch.last_error = ctx.problem;
    else if (ctx.synced > 0 && ctx.mirror.last_error) patch.last_error = null;
    if (Object.keys(patch).length) await admin.from('onedrive_mirrors').update(patch).eq('organization_id', ctx.orgId).eq('status', 'active');
  }

  const pendingFilter = admin.from('onedrive_sync_jobs').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  const { count: pending } = filter.organizationId ? await pendingFilter.eq('organization_id', filter.organizationId) : await pendingFilter;
  return { ...counts, pending: pending ?? 0 };
}

type JobOutcome =
  | { kind: 'done' }
  | { kind: 'retry'; message: string; seconds: number | null }
  | { kind: 'failed'; message: string }
  | { kind: 'paused' };

async function runJob(ctx: OrgCtx, job: JobRow): Promise<JobOutcome> {
  try {
    if (job.kind === 'delete') {
      await deleteMapped(ctx, job.item_type, job.item_id);
    } else {
      try {
        await syncItem(ctx, job, job.verify);
      } catch (err) {
        // Een map in de keten bestaat in OneDrive niet meer (iemand gooide hem
        // daar weg): de keten nog eens nalopen en ontbrekende mappen opnieuw
        // maken. Bij de volgende wijziging komt het bestand zo terug (keuze E).
        if (!(err instanceof ParentGone) || job.verify) throw err;
        await syncItem(ctx, job, true);
      }
    }
    return { kind: 'done' };
  } catch (err) {
    if (err instanceof MirrorPaused) return { kind: 'paused' };
    if (err instanceof RetryLater) return { kind: 'retry', message: err.message, seconds: err.seconds };
    if (err instanceof JobFailed) return { kind: 'failed', message: err.message };
    if (err instanceof ParentGone) return { kind: 'retry', message: 'Een map in OneDrive ontbrak; ResoFly probeert het opnieuw.', seconds: null };
    const { message } = toHttp(err);
    console.error('onedrive-sync taak mislukt', job.item_type, job.kind, err);
    return { kind: 'retry', message, seconds: null };
  }
}

async function releaseClaim(job: JobRow): Promise<void> {
  await admin.from('onedrive_sync_jobs').update({ claimed_until: null }).eq('id', job.id);
}

/**
 * Een taak afsluiten. Kwam er intussen een nieuwe wijziging (seq is hoger),
 * dan blijft hij staan en loopt hij nog een keer.
 */
async function finishJob(job: JobRow, outcome: JobOutcome): Promise<void> {
  if (outcome.kind === 'done') {
    const { data } = await admin.from('onedrive_sync_jobs').delete().eq('id', job.id).eq('seq', job.seq).select('id');
    if (!data?.length) await releaseClaim(job);
    return;
  }
  if (outcome.kind === 'paused') {
    await releaseClaim(job);
    return;
  }
  const attempts = job.attempts + 1;
  let patch: Record<string, unknown>;
  if (outcome.kind === 'retry' && attempts < MAX_JOB_ATTEMPTS) {
    patch = {
      attempts,
      last_error: outcome.message,
      next_attempt_at: new Date(Date.now() + nextAttemptDelaySeconds(attempts, outcome.seconds) * 1000).toISOString(),
      claimed_until: null,
    };
  } else {
    patch = {
      status: 'failed',
      attempts,
      last_error: outcome.kind === 'retry' ? `${outcome.message} Na ${attempts} pogingen gestopt.` : outcome.message,
      claimed_until: null,
    };
  }
  const { data } = await admin.from('onedrive_sync_jobs').update(patch).eq('id', job.id).eq('seq', job.seq).select('id');
  if (!data?.length) await releaseClaim(job);
}

// ── Koppelingen tussen ResoFly en OneDrive ────────────────────────────

async function getMap(ctx: OrgCtx, type: ItemType, id: string): Promise<MapRow | null> {
  return (await must(admin.from('onedrive_sync_items').select('*')
    .eq('organization_id', ctx.orgId).eq('item_type', type).eq('item_id', id).maybeSingle())) as MapRow | null;
}

async function putMap(ctx: OrgCtx, row: Omit<MapRow, 'organization_id'>): Promise<void> {
  await must(admin.from('onedrive_sync_items').upsert({ ...row, organization_id: ctx.orgId, synced_at: new Date().toISOString() }, { onConflict: 'organization_id,item_type,item_id' }));
}

async function dropMap(ctx: OrgCtx, type: ItemType, id: string): Promise<void> {
  await must(admin.from('onedrive_sync_items').delete().eq('organization_id', ctx.orgId).eq('item_type', type).eq('item_id', id));
}

// ── Mappen ────────────────────────────────────────────────────────────

/** De map van de organisatie. Gooide iemand hem weg, dan komt er een nieuwe. */
async function ensureRoot(ctx: OrgCtx, verify: boolean): Promise<{ id: string; name: string; webUrl: string | null }> {
  const m = ctx.mirror;
  if (m.root_item_id && isDriveId(m.root_item_id)) {
    if (!verify) return { id: m.root_item_id, name: m.root_name ?? '', webUrl: m.root_web_url };
    const res = await graph(ctx.token, 'GET', `/drives/${ctx.driveId}/items/${m.root_item_id}?$select=${ITEM_SELECT}`);
    if (res.status === 200) {
      const item = driveItemOf(res.body);
      if (item) return { id: item.id, name: item.name, webUrl: item.webUrl };
    } else if (res.status !== 404) {
      await raiseFor(ctx, res);
    }
  }
  const { data: org } = await admin.from('organizations').select('name').eq('id', ctx.orgId).maybeSingle();
  const name = rootFolderName((org as { name?: string } | null)?.name);
  const res = await graph(ctx.token, 'POST', `/drives/${ctx.driveId}/root/children`, { name, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
  if (res.status !== 200 && res.status !== 201) await raiseFor(ctx, res);
  const item = driveItemOf(res.body);
  if (!item) throw new RetryLater('OneDrive gaf geen map terug.');
  await must(admin.from('onedrive_mirrors').update({ root_item_id: item.id, root_name: item.name, root_web_url: item.webUrl })
    .eq('organization_id', ctx.orgId));
  ctx.mirror = { ...m, root_item_id: item.id, root_name: item.name, root_web_url: item.webUrl };
  return { id: item.id, name: item.name, webUrl: item.webUrl };
}

/**
 * Hernoemen en/of verplaatsen. Bestaat de naam al in die map, dan "naam (2)",
 * "naam (3)", …; OneDrive kiest bij verplaatsen zelf geen nieuwe naam.
 */
async function moveRename(ctx: OrgCtx, itemId: string, desired: string, parentId: string): Promise<{ name: string } | 'gone'> {
  for (let n = 1; n <= 6; n++) {
    const name = n === 1 ? desired : numberedName(desired, n);
    const res = await graph(ctx.token, 'PATCH', `/drives/${ctx.driveId}/items/${itemId}`, { name, parentReference: { id: parentId } });
    if (res.status === 200) return { name: driveItemOf(res.body)?.name || name };
    if (res.status === 404) return 'gone';
    if (res.status === 409) continue;
    await raiseFor(ctx, res);
  }
  throw new JobFailed(`In OneDrive staan al te veel bestanden met de naam "${desired}" in deze map.`);
}

async function ensureFolder(ctx: OrgCtx, node: ContainerNode, parentId: string, verify: boolean): Promise<string> {
  const desired = safeDriveName(node.type === 'noclient' ? NO_CLIENT_FOLDER : node.name);
  const map = await getMap(ctx, node.type, node.id);
  if (map) {
    let alive = true;
    let actualName = map.name;
    let actualParent = map.parent_drive_item_id;
    if (verify) {
      const res = await graph(ctx.token, 'GET', `/drives/${ctx.driveId}/items/${map.drive_item_id}?$select=${ITEM_SELECT}`);
      if (res.status === 404) alive = false;
      else if (res.status !== 200) await raiseFor(ctx, res);
      else {
        const item = driveItemOf(res.body);
        actualName = item?.name ?? actualName;
        actualParent = item?.parentId ?? actualParent;
      }
    }
    if (alive && (actualParent !== parentId || map.desired_name !== desired || actualName !== map.name)) {
      const moved = await moveRename(ctx, map.drive_item_id, desired, parentId);
      if (moved === 'gone') alive = false;
      else await putMap(ctx, { ...map, parent_drive_item_id: parentId, name: moved.name, desired_name: desired });
    }
    if (alive) return map.drive_item_id;
    await dropMap(ctx, node.type, node.id);
  }
  const res = await graph(ctx.token, 'POST', `/drives/${ctx.driveId}/items/${parentId}/children`, { name: desired, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' });
  if (res.status === 404) throw new ParentGone('De bovenliggende map ontbreekt in OneDrive.');
  if (res.status !== 200 && res.status !== 201) await raiseFor(ctx, res);
  const item = driveItemOf(res.body);
  if (!item) throw new RetryLater('OneDrive gaf geen map terug.');
  await putMap(ctx, { item_type: node.type, item_id: node.id, drive_item_id: item.id, parent_drive_item_id: parentId, name: item.name, desired_name: desired, content_version: null, remote_tag: null });
  return item.id;
}

async function ensurePath(ctx: OrgCtx, nodes: ContainerNode[], verify: boolean): Promise<string> {
  let parent = (await ensureRoot(ctx, verify)).id;
  for (const node of nodes) parent = await ensureFolder(ctx, node, parent, verify);
  return parent;
}

/** Klant en project boven een bestand, of "Zonder klant". Een project hoort bij de klant van dat project. */
async function containerNodes(ctx: OrgCtx, clientId: string | null, projectId: string | null): Promise<ContainerNode[]> {
  if (projectId) {
    const { data: project } = await admin.from('projects').select('id,name,client_id').eq('id', projectId).eq('organization_id', ctx.orgId).maybeSingle();
    if (project) {
      const p = project as { id: string; name: string; client_id: string | null };
      return [...(await containerNodes(ctx, p.client_id, null)), { type: 'project', id: p.id, name: p.name }];
    }
  }
  if (clientId) {
    const { data: client } = await admin.from('clients').select('id,name').eq('id', clientId).eq('organization_id', ctx.orgId).maybeSingle();
    if (client) {
      const c = client as { id: string; name: string };
      return [{ type: 'client', id: c.id, name: c.name }];
    }
  }
  return [{ type: 'noclient', id: ctx.orgId, name: NO_CLIENT_FOLDER }];
}

/** De keten van mappen tot en met deze dossiermap, met klant en project erboven. Null als de map er niet meer is. */
async function folderChain(ctx: OrgCtx, folderId: string): Promise<ContainerNode[] | null> {
  const rows: Array<{ id: string; name: string; parent_id: string | null; client_id: string | null; project_id: string | null }> = [];
  let id: string | null = folderId;
  for (let depth = 0; id && depth < 25; depth++) {
    const { data } = await admin.from('content_folders').select('id,name,parent_id,client_id,project_id').eq('id', id).eq('organization_id', ctx.orgId).maybeSingle();
    if (!data) return null;
    const row = data as { id: string; name: string; parent_id: string | null; client_id: string | null; project_id: string | null };
    if (rows.some(r => r.id === row.id)) break;
    rows.unshift(row);
    id = row.parent_id;
  }
  if (!rows.length) return null;
  const top = rows[0];
  return [...(await containerNodes(ctx, top.client_id, top.project_id)), ...rows.map(r => ({ type: 'folder' as const, id: r.id, name: r.name }))];
}

// ── Een taak ──────────────────────────────────────────────────────────

async function syncItem(ctx: OrgCtx, job: JobRow, verify: boolean): Promise<void> {
  const id = job.item_id;
  if (job.item_type === 'attachment') {
    const { data } = await admin.from('attachments').select('id,name,entity_type,entity_id,storage_key,size_bytes,edit_version')
      .eq('id', id).eq('organization_id', ctx.orgId).maybeSingle();
    const row = data as { id: string; name: string; entity_type: string; entity_id: string; storage_key: string | null; size_bytes: number | null; edit_version: number | null } | null;
    if (!row || row.entity_type !== 'folder' || !row.storage_key) return await deleteMapped(ctx, 'attachment', id);
    const nodes = await folderChain(ctx, row.entity_id);
    if (!nodes) return;
    return await syncFile(ctx, 'attachment', id, nodes, safeDriveName(row.name, 'Bestand'), row.storage_key, row.size_bytes, contentVersion(row), verify);
  }
  if (job.item_type === 'document') {
    const { data } = await admin.from('documents').select('id,title,storage_key,mime_type,size_bytes,edit_version,client_id,project_id,folder_id')
      .eq('id', id).eq('organization_id', ctx.orgId).maybeSingle();
    const row = data as { id: string; title: string | null; storage_key: string | null; mime_type: string | null; size_bytes: number | null; edit_version: number | null; client_id: string | null; project_id: string | null; folder_id: string | null } | null;
    if (!row || !row.storage_key) return await deleteMapped(ctx, 'document', id);
    const nodes = (row.folder_id ? await folderChain(ctx, row.folder_id) : null) ?? await containerNodes(ctx, row.client_id, row.project_id);
    return await syncFile(ctx, 'document', id, nodes, documentFileName(row.title, row.mime_type, row.storage_key), row.storage_key, row.size_bytes, contentVersion(row), verify);
  }
  // Een klant, project of map: alleen bijwerken als hij al in OneDrive staat.
  // Een lege map maakt ResoFly niet aan; dat gebeurt pas als er iets in komt.
  const map = await getMap(ctx, job.item_type, id);
  if (!map) return;
  let nodes: ContainerNode[] | null;
  if (job.item_type === 'client') {
    const { data } = await admin.from('clients').select('id,name').eq('id', id).eq('organization_id', ctx.orgId).maybeSingle();
    nodes = data ? [{ type: 'client', id, name: (data as { name: string }).name }] : null;
  } else if (job.item_type === 'project') {
    const { data } = await admin.from('projects').select('id').eq('id', id).eq('organization_id', ctx.orgId).maybeSingle();
    nodes = data ? await containerNodes(ctx, null, id) : null;
  } else {
    nodes = await folderChain(ctx, id);
  }
  // Weg in ResoFly: de delete-taak komt eraan (of liep al).
  if (!nodes) return;
  await ensurePath(ctx, nodes, verify);
}

async function syncFile(
  ctx: OrgCtx, type: 'attachment' | 'document', id: string, nodes: ContainerNode[],
  desired: string, key: string, sizeBytes: number | null, version: string, verify: boolean,
): Promise<void> {
  if (!mirrorableKey(key, ctx.orgId)) throw new JobFailed('Dit bestand gaat niet naar OneDrive (het staat niet in Inhoud).');
  const parentId = await ensurePath(ctx, nodes, verify);
  const map = await getMap(ctx, type, id);
  if (map) {
    let alive = true;
    let actualName = map.name;
    let actualParent = map.parent_drive_item_id;
    let remoteTag = map.remote_tag;
    if (verify) {
      const res = await graph(ctx.token, 'GET', `/drives/${ctx.driveId}/items/${map.drive_item_id}?$select=${ITEM_SELECT}`);
      if (res.status === 404) alive = false;
      else if (res.status !== 200) await raiseFor(ctx, res);
      else {
        const item = driveItemOf(res.body);
        actualName = item?.name ?? actualName;
        actualParent = item?.parentId ?? actualParent;
        remoteTag = item?.cTag ?? remoteTag;
      }
    }
    let current: MapRow = map;
    if (alive && (actualParent !== parentId || map.desired_name !== desired || actualName !== map.name)) {
      const moved = await moveRename(ctx, map.drive_item_id, desired, parentId);
      if (moved === 'gone') alive = false;
      else {
        current = { ...current, parent_drive_item_id: parentId, name: moved.name, desired_name: desired };
        await putMap(ctx, current);
      }
    }
    // ResoFly is leidend (keuze D): een andere inhoud in ResoFly, of bij
    // "Alles opnieuw kopiëren" een bestand dat iemand in OneDrive veranderde,
    // wordt overschreven. OneDrive bewaart de vorige versie.
    const changedInOneDrive = verify && Boolean(remoteTag && map.remote_tag && remoteTag !== map.remote_tag);
    if (alive && (map.content_version !== version || changedInOneDrive)) {
      const uploaded = await uploadContent(ctx, { itemId: map.drive_item_id }, key, sizeBytes);
      if (uploaded === 'gone') alive = false;
      else await putMap(ctx, { ...current, content_version: version, remote_tag: uploaded.cTag });
    }
    if (alive) return;
    await dropMap(ctx, type, id);
  }
  const uploaded = await uploadContent(ctx, { parentId, name: desired }, key, sizeBytes);
  if (uploaded === 'gone') throw new ParentGone('De map in OneDrive ontbreekt.');
  await putMap(ctx, {
    item_type: type, item_id: id, drive_item_id: uploaded.id, parent_drive_item_id: parentId,
    name: uploaded.name || desired, desired_name: desired, content_version: version, remote_tag: uploaded.cTag,
  });
}

type UploadTarget = { itemId: string } | { parentId: string; name: string };

/**
 * De inhoud naar OneDrive. Een nieuw bestand krijgt bij een bestaande naam
 * zelf "naam 1.pdf" (rename); een bestaand bestand wordt overschreven
 * (replace). De bytes stuurt de media-worker rechtstreeks uit R2.
 */
async function uploadContent(ctx: OrgCtx, target: UploadTarget, key: string, sizeBytes: number | null): Promise<{ id: string; name: string; cTag: string | null } | 'gone'> {
  if (sizeBytes === 0) return await uploadEmpty(ctx, target);
  const path = 'itemId' in target
    ? `/drives/${ctx.driveId}/items/${target.itemId}/createUploadSession`
    : `/drives/${ctx.driveId}/items/${target.parentId}:/${encodeURIComponent(target.name)}:/createUploadSession`;
  const body = 'itemId' in target
    ? { item: { '@microsoft.graph.conflictBehavior': 'replace' } }
    : { item: { '@microsoft.graph.conflictBehavior': 'rename', name: target.name } };
  const session = await graph(ctx.token, 'POST', path, body);
  if (session.status === 404) return 'gone';
  if (session.status !== 200) await raiseFor(ctx, session);
  const uploadUrl = session.body && typeof session.body === 'object' ? (session.body as Record<string, unknown>).uploadUrl : null;
  if (typeof uploadUrl !== 'string' || !uploadUrl.startsWith('https://')) throw new RetryLater('OneDrive gaf geen uploadadres terug.');

  const pushed = await workerPush(ctx.orgId, key, uploadUrl);
  if ('empty' in pushed) {
    await fetch(uploadUrl, { method: 'DELETE' }).catch(() => undefined);
    return await uploadEmpty(ctx, target);
  }
  return pushed;
}

/** Een leeg bestand kan niet via een uploadsessie. */
async function uploadEmpty(ctx: OrgCtx, target: UploadTarget): Promise<{ id: string; name: string; cTag: string | null } | 'gone'> {
  const path = 'itemId' in target
    ? `/drives/${ctx.driveId}/items/${target.itemId}/content`
    : `/drives/${ctx.driveId}/items/${target.parentId}:/${encodeURIComponent(target.name)}:/content?@microsoft.graph.conflictBehavior=rename`;
  const res = await graph(ctx.token, 'PUT', path, undefined, new Uint8Array(0));
  if (res.status === 404) return 'gone';
  if (res.status !== 200 && res.status !== 201) await raiseFor(ctx, res);
  const item = driveItemOf(res.body);
  if (!item) throw new RetryLater('OneDrive gaf geen bestand terug.');
  return { id: item.id, name: item.name, cTag: item.cTag };
}

async function workerPush(organizationId: string, key: string, uploadUrl: string): Promise<{ id: string; name: string; cTag: string | null } | { empty: true }> {
  if (!MEDIA_WORKER_URL || !MEDIA_WORKER_SECRET) throw new RetryLater('De bestandsopslag is niet gekoppeld (MEDIA_WORKER_URL / INTERNAL_UPLOAD_SECRET).', 3600);
  let res: Response;
  try {
    res = await fetch(`${MEDIA_WORKER_URL}/internal/onedrive/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MEDIA_WORKER_SECRET}`, 'Content-Type': 'application/json', 'X-Organization-Id': organizationId },
      body: JSON.stringify({ organizationId, key, uploadUrl }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    console.warn('onedrive-sync: media-worker niet bereikbaar', err);
    throw new RetryLater('De bestandsopslag was even niet bereikbaar.');
  }
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const message = typeof json.error === 'string' ? json.error : `De bestandsopslag gaf een fout (${res.status}).`;
    if (res.status === 404 || res.status === 403 || res.status === 413) throw new JobFailed(message);
    throw new RetryLater(message);
  }
  if (json.ok === true && json.empty === true) return { empty: true };
  if (json.ok === true) {
    const item = json.item as Record<string, unknown> | undefined;
    if (item && isDriveId(item.id)) {
      return { id: item.id, name: typeof item.name === 'string' ? item.name : '', cTag: typeof item.cTag === 'string' ? item.cTag : null };
    }
    throw new RetryLater('OneDrive gaf geen bestand terug.');
  }
  if (json.changed === true) throw new RetryLater('Het bestand veranderde tijdens het kopiëren.', 30);
  // Een weigering van OneDrive zelf, doorgegeven door de worker.
  const status = Number(json.status) || 0;
  const outcome = classifyGraphResponse(status, json.error, typeof json.retryAfter === 'string' ? json.retryAfter : null);
  if (outcome.kind === 'full') throw new RetryLater(outcome.message, 3600);
  if (outcome.kind === 'failed') throw new JobFailed(outcome.message);
  // Een verlopen uploadadres (404) of een storing: opnieuw, met een nieuw adres.
  throw new RetryLater(outcome.kind === 'retry' ? outcome.message : 'De upload naar OneDrive werd afgebroken.', outcome.kind === 'retry' ? outcome.retryAfterSeconds : null);
}

/** Verwijderd in ResoFly: naar de prullenbak van OneDrive. Al weg is ook goed. */
async function deleteMapped(ctx: OrgCtx, type: ItemType, id: string): Promise<void> {
  const map = await getMap(ctx, type, id);
  if (!map) return;
  const res = await graph(ctx.token, 'DELETE', `/drives/${ctx.driveId}/items/${map.drive_item_id}`);
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) await raiseFor(ctx, res);
  await dropMap(ctx, type, id);
}

// ── De geplande taak ──────────────────────────────────────────────────

async function handleCron(req: Request): Promise<Response> {
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ ok: false, error: 'Alleen POST.' }, 405);
  if (!CRON_SECRET || !timingSafeEqual(req.headers.get('x-cron-secret') || '', CRON_SECRET)) {
    return json({ ok: false, error: 'Ongeldig of ontbrekend cron-secret.' }, 401);
  }
  try {
    const { error } = await admin.rpc('onedrive_cleanup');
    if (error) console.warn('onedrive-sync opruimen mislukt', error.message);
    return json({ ok: true, ...(await processDue({ limit: 100, budgetMs: 50_000 })) });
  } catch (err) {
    console.error('onedrive-sync cron mislukt', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Onbekende fout' }, 500);
  }
}
