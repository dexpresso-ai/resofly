import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, isUuid,
  makeCors, parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type OrganizationRole,
} from '../_shared/edgeAuth.ts';
import {
  OAUTH_STATE_TTL_SECONDS,
  checkOAuthState,
  classifyProviderError,
  classifyTokenFailure,
  fallbackReturnTo,
  parseReturnOrigins,
  sanitizeReturnTo,
  signOAuthState,
  timingSafeEqual,
  withReturnParams,
  type TokenFailure,
} from '../_shared/calendarOAuth.ts';
import {
  MAX_DELETE_ATTEMPTS,
  MAX_LINK_FILES,
  buildDriveAuthorizeUrl,
  classifyDeleteResponse,
  cloudProviderLabel,
  cloudStorageKey,
  decryptToken,
  driveStateSecret,
  encryptToken,
  googleDriveScopes,
  hasDriveScope,
  isCloudProvider,
  isProviderId,
  microsoftDriveRefreshScopes,
  microsoftDriveScopes,
  nextAttemptDelaySeconds,
  parseGoogleFile,
  parseMicrosoftItem,
  pickerTokenScopesOk,
  safeGraphNextLink,
  stripDriveReturnParams,
  type CloudFileMeta,
  type CloudProvider,
  type DeleteOutcome,
} from '../_shared/cloudFiles.ts';

// ============================================================
// ResoFly — Google Drive en OneDrive koppelen aan Inhoud (cloud-files)
//
// GET  ?state&code  — terugkeer van Google of Microsoft na "toestaan"
// POST ?cron=deletions (x-cron-secret) — de verwijderwachtrij afwerken
// POST, ingelogd:
//   status          — eigen koppelingen, wat er nog weg moet, wat er kan
//   oauthStart      — toestemmingslink
//   oauthComplete   — afronden, met de sessie van wie startte
//   disconnect      — eigen koppeling uit
//   pickerToken     — kort token voor de kiezer van Google (alleen drive.file)
//   browse          — de eigen OneDrive bekijken (de kiezer bouwen we zelf)
//   link            — gekozen bestanden in een dossiermap zetten
//   processDeletions— wat er in Drive of OneDrive weg moet, nu afwerken
//   retryDeletion   — een mislukte opnieuw proberen
//   dismissDeletion — een mislukte laten staan (niet meer proberen)
//
// Deze functie draait op de service-role. Daarom hier expliciet: lid van de
// organisatie, module Inhoud (lezen, en schrijven waar iets verandert), en
// alleen de eigen koppelingen. organization_id komt uit de sessie of de
// ondertekende state, nooit los uit de invoer (harde regel 1).
//
// Verwijderen zelf gebeurt hier niet: dat doet de app (of een cascade) met de
// rechten van wie verwijdert, en de database zet het dan in
// cloud_file_deletions. Hier gaat het daarna in Drive of OneDrive naar de
// prullenbak, met de koppeling van wie het bestand koppelde.
// ============================================================

const admin = createAdminClient();

function env(name: string): string {
  return (Deno.env.get(name) || '').trim();
}

const SUPABASE_URL = env('SUPABASE_URL').replace(/\/$/, '');
const REDIRECT_URL = env('CLOUD_FILES_REDIRECT_URL') || `${SUPABASE_URL}/functions/v1/cloud-files`;
const STATE_SECRET = driveStateSecret(env('CLOUD_FILES_OAUTH_STATE_SECRET') || env('CALENDAR_OAUTH_STATE_SECRET'));
const TOKEN_KEY = env('CLOUD_FILES_TOKEN_ENCRYPTION_KEY') || env('CALENDAR_TOKEN_ENCRYPTION_KEY');
const RETURN_ORIGINS = parseReturnOrigins(env('CLOUD_FILES_ALLOWED_RETURN_ORIGINS') || env('CALENDAR_ALLOWED_RETURN_ORIGINS'));
// Dezelfde app-registraties als de agenda, tenzij je er voor Drive een eigen
// wilt (aangeraden bij Google: dan draagt het token voor de kiezer nooit
// agendarechten, zie pickerTokenScopesOk).
const GOOGLE_CLIENT_ID = env('GOOGLE_DRIVE_CLIENT_ID') || env('GOOGLE_CALENDAR_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = env('GOOGLE_DRIVE_CLIENT_SECRET') || env('GOOGLE_CALENDAR_CLIENT_SECRET');
const MICROSOFT_CLIENT_ID = env('MICROSOFT_DRIVE_CLIENT_ID') || env('MICROSOFT_CALENDAR_CLIENT_ID');
const MICROSOFT_CLIENT_SECRET = env('MICROSOFT_DRIVE_CLIENT_SECRET') || env('MICROSOFT_CALENDAR_CLIENT_SECRET');
const MICROSOFT_TENANT = env('MICROSOFT_DRIVE_TENANT_ID') || env('MICROSOFT_CALENDAR_TENANT_ID') || 'common';
// De kiezer van Google: een browsersleutel (alleen de Picker API, alleen de
// adressen van de app) en het projectnummer van de Google Cloud-app.
const GOOGLE_PICKER_API_KEY = env('GOOGLE_PICKER_API_KEY');
const GOOGLE_APP_ID = env('GOOGLE_CLOUD_PROJECT_NUMBER');
const CRON_SECRET = env('CLOUD_FILES_CRON_SECRET');

// Dezelfde lijsten als file-share en file-transfer, plus die van de agenda:
// welke er op een omgeving staat, verschilt, en elk ervan noemt de app.
const cors = makeCors(
  parseAllowedOrigins([
    env('CLOUD_FILES_ALLOWED_ORIGINS'),
    env('FILE_SHARE_ALLOWED_ORIGINS'),
    env('APP_ALLOWED_ORIGINS'),
    env('APP_PUBLIC_URL'),
    env('MAIL_ALLOWED_ORIGINS'),
    env('CALENDAR_ALLOWED_RETURN_ORIGINS'),
  ]),
  env('ALLOW_LOCAL_DEV') === '1',
);

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MICROSOFT_TOKEN_URL = `https://login.microsoftonline.com/${encodeURIComponent(MICROSOFT_TENANT)}/oauth2/v2.0/token`;
const GOOGLE_FILES = 'https://www.googleapis.com/drive/v3/files';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const GRAPH_SELECT = 'id,name,size,webUrl,file,folder,package,parentReference,deleted,lastModifiedDateTime';

type Ctx = { userId: string; organizationId: string; role: OrganizationRole };

type ConnectionRow = {
  id: string;
  organization_id: string;
  user_id: string;
  provider: CloudProvider;
  provider_account_id: string;
  provider_account_email: string | null;
  display_name: string | null;
  status: 'active' | 'expired' | 'revoked' | 'error';
  scopes: string[];
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type TokenRow = {
  connection_id: string;
  organization_id: string;
  user_id: string;
  provider: CloudProvider;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_type: string | null;
  scopes: string[];
  expires_at: string | null;
};

type DeletionRow = {
  id: string;
  organization_id: string;
  connection_id: string | null;
  provider: CloudProvider;
  file_id: string;
  drive_id: string | null;
  name: string;
  attachment_id: string | null;
  requested_by: string | null;
  status: 'pending' | 'done' | 'failed';
  failure: 'connection' | 'permission' | 'other' | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  done_at: string | null;
};

/** Een token vernieuwen lukte niet; `failure` zegt of opnieuw koppelen helpt. */
class CloudTokenError extends Error {
  failure: TokenFailure;
  constructor(message: string, failure: TokenFailure) {
    super(message);
    this.name = 'CloudTokenError';
    this.failure = failure;
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('cron') === 'deletions') return await handleCron(req);
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
    const ctx: Ctx = { userId: user.id, organizationId, role };
    const requireWrite = async () => {
      assertWriteRole(role);
      await assertModuleAccess(admin, user.id, organizationId, 'content', 'write');
    };

    switch (action) {
      case 'status': return cors.json(req, { ok: true, ...(await status(ctx)) });
      case 'oauthStart': await requireWrite(); return cors.json(req, { ok: true, authUrl: await startOAuth(ctx, body) });
      // Je eigen koppeling uitzetten mag altijd, ook met alleen leesrecht: wie
      // minder mag dan toen hij koppelde, moet hem kunnen stoppen.
      case 'disconnect': return cors.json(req, { ok: true, ...(await disconnect(ctx, String(body.connectionId || ''))) });
      case 'pickerToken': await requireWrite(); return cors.json(req, { ok: true, ...(await pickerToken(ctx)) });
      case 'browse': await requireWrite(); return cors.json(req, { ok: true, ...(await browse(ctx, body)) });
      case 'link': await requireWrite(); return cors.json(req, { ok: true, ...(await link(ctx, body)) });
      // Werkt alleen af wat de database al in de wachtrij zette, met de rechten
      // van wie verwijderde. Lezen is dus genoeg om het aan te zwengelen.
      case 'processDeletions': return cors.json(req, { ok: true, ...(await processForOrganization(ctx)) });
      case 'retryDeletion': await requireWrite(); return cors.json(req, { ok: true, ...(await retryDeletion(ctx, String(body.deletionId || ''))) });
      case 'dismissDeletion': await requireWrite(); return cors.json(req, { ok: true, ...(await dismissDeletion(ctx, String(body.deletionId || ''))) });
      default: throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
  } catch (err) {
    const { status, message } = toHttp(err);
    if (status >= 500) console.error('cloud-files error', message, err instanceof Error ? err.stack : err);
    else console.warn('cloud-files weigert', status, message);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

// ── Fouten ────────────────────────────────────────────────────────────

function toHttp(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof CloudTokenError) return { status: err.failure === 'tijdelijk' ? 503 : 409, message: err.message };
  const pg = err as { message?: string; code?: string };
  if (pg && typeof pg === 'object' && typeof pg.code === 'string') {
    // De triggers zijn als gebruikerstekst geschreven.
    if (pg.code === '42501' || pg.code === 'P0001') return { status: 403, message: pg.message || 'Dat mag niet.' };
    if (pg.code === '23505') return { status: 409, message: 'Dit bestand staat al in ResoFly.' };
    console.error('cloud-files databasefout', pg.code, pg.message);
    return { status: 500, message: 'Er ging iets mis in de database. Probeer het opnieuw.' };
  }
  return { status: 500, message: err instanceof Error ? err.message : 'Onbekende fout' };
}

async function must<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ── Wat er kan ────────────────────────────────────────────────────────

function providerConfigured(provider: CloudProvider): boolean {
  const base = Boolean(STATE_SECRET && TOKEN_KEY && TOKEN_KEY.length >= 16);
  if (provider === 'google') return base && Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  return base && Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);
}

function assertConfigured(provider: CloudProvider): void {
  if (!providerConfigured(provider)) {
    throw new HttpError(`${cloudProviderLabel(provider)} is op deze omgeving nog niet ingesteld. Vraag de beheerder van ResoFly om de koppeling in te richten.`, 400);
  }
  if (provider === 'google' && !(GOOGLE_PICKER_API_KEY && GOOGLE_APP_ID)) {
    throw new HttpError('Google Drive is op deze omgeving nog niet helemaal ingesteld: de sleutel voor de kiezer van Google ontbreekt.', 400);
  }
}

function parseProvider(value: unknown): CloudProvider {
  if (isCloudProvider(value)) return value;
  throw new HttpError('Kies Google Drive of OneDrive.', 400);
}

type PublicConnection = {
  id: string;
  provider: CloudProvider;
  account: string | null;
  name: string | null;
  status: ConnectionRow['status'];
  lastError: string | null;
  createdAt: string;
  linkedFiles: number;
};

type PublicDeletion = {
  id: string;
  provider: CloudProvider;
  name: string;
  status: DeletionRow['status'];
  failure: DeletionRow['failure'];
  lastError: string | null;
  attempts: number;
  createdAt: string;
  /** Hoort bij een koppeling van jezelf: opnieuw koppelen lost het dan op. */
  mine: boolean;
};

async function ownConnections(ctx: Ctx): Promise<ConnectionRow[]> {
  return (await must(admin.from('cloud_drive_connections').select('*')
    .eq('organization_id', ctx.organizationId).eq('user_id', ctx.userId)
    .order('updated_at', { ascending: false }))) as ConnectionRow[];
}

/** De koppeling waarmee je nu kiest: de laatst gebruikte die aan staat. */
async function activeConnection(ctx: Ctx, provider: CloudProvider): Promise<ConnectionRow> {
  const rows = (await ownConnections(ctx)).filter(c => c.provider === provider);
  const active = rows.find(c => c.status === 'active');
  if (active) return active;
  if (rows.length) {
    throw new CloudTokenError(`Je koppeling met ${cloudProviderLabel(provider)} is verlopen of staat uit. Koppel opnieuw.`, 'ingetrokken');
  }
  throw new HttpError(`Je hebt ${cloudProviderLabel(provider)} nog niet gekoppeld.`, 409);
}

async function openDeletions(ctx: Ctx): Promise<PublicDeletion[]> {
  const rows = (await must(admin.from('cloud_file_deletions').select('*')
    .eq('organization_id', ctx.organizationId).in('status', ['pending', 'failed'])
    .order('created_at', { ascending: false }).limit(50))) as DeletionRow[];
  const connectionIds = [...new Set(rows.map(r => r.connection_id).filter((id): id is string => Boolean(id)))];
  const mine = new Set<string>();
  if (connectionIds.length) {
    const own = (await must(admin.from('cloud_drive_connections').select('id')
      .eq('organization_id', ctx.organizationId).eq('user_id', ctx.userId).in('id', connectionIds))) as Array<{ id: string }>;
    for (const c of own) mine.add(c.id);
  }
  return rows.map(r => ({
    id: r.id,
    provider: r.provider,
    name: r.name,
    status: r.status,
    failure: r.failure,
    lastError: r.last_error,
    attempts: r.attempts,
    createdAt: r.created_at,
    mine: Boolean(r.connection_id && mine.has(r.connection_id)),
  }));
}

async function linkedCount(organizationId: string, connectionId: string): Promise<number> {
  const { count, error } = await admin.from('attachments').select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId).eq('cloud_connection_id', connectionId);
  if (error) throw error;
  return count ?? 0;
}

async function status(ctx: Ctx) {
  const connections = await ownConnections(ctx);
  const publicConnections: PublicConnection[] = [];
  for (const c of connections) {
    publicConnections.push({
      id: c.id,
      provider: c.provider,
      account: c.provider_account_email,
      name: c.display_name,
      status: c.status,
      lastError: c.last_error,
      createdAt: c.created_at,
      linkedFiles: await linkedCount(ctx.organizationId, c.id),
    });
  }
  return {
    providers: {
      google: { configured: providerConfigured('google') && Boolean(GOOGLE_PICKER_API_KEY && GOOGLE_APP_ID) },
      microsoft: { configured: providerConfigured('microsoft') },
    },
    connections: publicConnections,
    deletions: await openDeletions(ctx),
  };
}

// ── Koppelen ──────────────────────────────────────────────────────────

async function startOAuth(ctx: Ctx, body: Record<string, unknown>): Promise<string> {
  const provider = parseProvider(body.provider);
  assertConfigured(provider);
  let returnTo: string;
  try {
    returnTo = stripDriveReturnParams(sanitizeReturnTo(body.returnTo, RETURN_ORIGINS));
  } catch (err) {
    throw new HttpError(err instanceof Error ? err.message : 'Ongeldig terugkeeradres.', 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const state = await signOAuthState({
    provider,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    returnTo,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + OAUTH_STATE_TTL_SECONDS,
  }, STATE_SECRET);
  return buildDriveAuthorizeUrl({
    provider,
    clientId: provider === 'google' ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID,
    redirectUri: REDIRECT_URL,
    state,
    microsoftTenant: MICROSOFT_TENANT,
    loginHint: body.loginHint,
  });
}

function redirectTo(location: string): Response {
  // no-store: in deze redirect staat een eenmalige code; die hoort in geen enkele cache.
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function plainError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/**
 * De terugkeer van Google of Microsoft. De code wordt hier NIET ingewisseld:
 * deze stap heeft geen sessie, en wie de toestemmingslink volgt is niet per se
 * wie hem startte. De app rondt af met de sessie van wie er is ingelogd (zie
 * dezelfde les bij de agenda, calendar-integrations).
 */
async function handleOAuthCallback(url: URL): Promise<Response> {
  if (!STATE_SECRET) return plainError('Google Drive en OneDrive zijn op deze omgeving nog niet ingesteld.', 500);
  const stateRaw = url.searchParams.get('state');
  const check = await checkOAuthState(stateRaw, STATE_SECRET, RETURN_ORIGINS);
  if (!check.ok && check.reason === 'ongeldig') {
    console.warn('cloud-files OAuth callback: ongeldige state');
    const fallback = fallbackReturnTo(RETURN_ORIGINS);
    if (fallback) return redirectTo(withReturnParams(fallback, { drive_error: 'ongeldig' }));
    return plainError('Deze koppellink klopt niet (meer). Start het koppelen opnieuw vanuit ResoFly.');
  }
  const state = check.state;
  const providerError = url.searchParams.get('error');
  if (providerError) {
    console.warn('cloud-files OAuth callback: provider meldt een fout', state.provider, providerError, url.searchParams.get('error_description'));
    const code = classifyProviderError(providerError, url.searchParams.get('error_description'), url.searchParams.get('error_subcode'));
    return redirectTo(withReturnParams(state.returnTo, { drive_error: code, drive_provider: state.provider }));
  }
  if (!check.ok) return redirectTo(withReturnParams(state.returnTo, { drive_error: 'verlopen', drive_provider: state.provider }));
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) return redirectTo(withReturnParams(state.returnTo, { drive_error: 'mislukt', drive_provider: state.provider }));
  return redirectTo(withReturnParams(state.returnTo, { drive_code: code, drive_state: stateRaw ?? '' }));
}

async function completeOAuth(userId: string, body: Record<string, unknown>) {
  const code = String(body.code || '');
  if (!code || code.length > 4096) throw new HttpError('De code van Google of Microsoft ontbreekt. Start het koppelen opnieuw.', 400);
  const check = await checkOAuthState(body.state, STATE_SECRET, RETURN_ORIGINS);
  if (!check.ok) {
    throw new HttpError(check.reason === 'verlopen'
      ? 'Het koppelen duurde te lang. Begin opnieuw met koppelen vanuit Inhoud.'
      : 'Deze koppellink klopt niet (meer). Begin opnieuw met koppelen vanuit Inhoud.', 400);
  }
  const state = check.state;
  if (state.userId !== userId) {
    throw new HttpError('Deze koppeling is gestart door een ander account. Start hem opnieuw vanuit je eigen werkruimte.', 403);
  }
  const organizationId = state.organizationId;
  const role = await requireOrganizationAccess(admin, userId, organizationId);
  assertWriteRole(role);
  await assertModuleAccess(admin, userId, organizationId, 'content', 'write');
  const provider = state.provider as CloudProvider;
  assertConfigured(provider);

  const token = await exchangeCode(provider, code);
  const accessToken = String(token.access_token || '');
  if (!accessToken) throw new HttpError(`${cloudProviderLabel(provider)} gaf geen toegang terug. Start het koppelen opnieuw.`, 502);
  const granted = parseScope(token.scope, provider === 'google' ? googleDriveScopes() : microsoftDriveScopes());
  if (!hasDriveScope(provider, granted)) {
    throw new HttpError(provider === 'google'
      ? 'Je gaf Google geen toegang tot de bestanden die je kiest. Koppel opnieuw en laat bij Google het vinkje voor Google Drive aan staan.'
      : 'Microsoft gaf geen toegang tot je OneDrive. Koppel opnieuw en sta de rechten voor je bestanden toe; lukt dat niet, vraag dan de beheerder van je Microsoft-account om ResoFly goed te keuren.', 400);
  }
  const account = await fetchAccountProfile(provider, accessToken);

  const connection = (await must(admin.from('cloud_drive_connections').upsert({
    organization_id: organizationId,
    user_id: userId,
    provider,
    provider_account_id: account.id,
    provider_account_email: account.email,
    display_name: account.name,
    status: 'active',
    scopes: granted,
    last_error: null,
  }, { onConflict: 'organization_id,user_id,provider,provider_account_id' }).select('*').single())) as ConnectionRow;

  const existing = (await must(admin.from('cloud_drive_connection_tokens').select('refresh_token_encrypted')
    .eq('connection_id', connection.id).maybeSingle())) as { refresh_token_encrypted: string | null } | null;
  const refreshToken = token.refresh_token ? String(token.refresh_token) : null;
  await must(admin.from('cloud_drive_connection_tokens').upsert({
    connection_id: connection.id,
    organization_id: organizationId,
    user_id: userId,
    provider,
    access_token_encrypted: await encryptToken(accessToken, TOKEN_KEY),
    refresh_token_encrypted: refreshToken ? await encryptToken(refreshToken, TOKEN_KEY) : existing?.refresh_token_encrypted ?? null,
    token_type: token.token_type ? String(token.token_type) : 'Bearer',
    scopes: granted,
    expires_at: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
  }, { onConflict: 'connection_id' }));

  // Wat er wachtte omdat deze koppeling verlopen was, gaat nu alsnog.
  const retried = (await must(admin.from('cloud_file_deletions')
    .update({ status: 'pending', failure: null, attempts: 0, next_attempt_at: new Date().toISOString() })
    .eq('organization_id', organizationId).eq('connection_id', connection.id)
    .eq('status', 'failed').eq('failure', 'connection').select('id'))) as Array<{ id: string }>;
  if (retried.length) await processDue({ organizationId, connectionId: connection.id, limit: 25 });

  return { provider, organizationId, account: account.email, retried: retried.length };
}

function parseScope(scope: unknown, fallback: string[]): string[] {
  if (typeof scope !== 'string' || !scope.trim()) return fallback;
  return scope.split(/\s+/).filter(Boolean);
}

async function exchangeCode(provider: CloudProvider, code: string): Promise<Record<string, string | number | undefined>> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URL,
    client_id: provider === 'google' ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID,
    client_secret: provider === 'google' ? GOOGLE_CLIENT_SECRET : MICROSOFT_CLIENT_SECRET,
  });
  const res = await fetch(provider === 'google' ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await res.json().catch(() => ({})) as Record<string, string | number | undefined>;
  if (!res.ok) {
    console.warn('cloud-files code exchange mislukt', provider, res.status, payload.error, payload.error_description);
    if (payload.error === 'invalid_grant') throw new HttpError('Deze toestemming is al gebruikt of verlopen. Begin opnieuw met koppelen.', 400);
    throw new HttpError(`${cloudProviderLabel(provider)} gaf geen toegang terug${payload.error ? ` (${String(payload.error).slice(0, 60)})` : ''}. Probeer het opnieuw; blijft het misgaan, laat de beheerder van ResoFly de koppeling nakijken.`, 502);
  }
  return payload;
}

async function fetchAccountProfile(provider: CloudProvider, accessToken: string): Promise<{ id: string; email: string | null; name: string | null }> {
  const endpoint = provider === 'google' ? 'https://www.googleapis.com/oauth2/v3/userinfo' : `${GRAPH}/me?$select=id,mail,userPrincipalName,displayName`;
  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new HttpError(`Je ${cloudProviderLabel(provider)}-account ophalen lukte niet. Probeer het opnieuw.`, 502);
  const id = provider === 'google' ? payload.sub : payload.id;
  if (!id) throw new HttpError(`${cloudProviderLabel(provider)} gaf geen account terug. Start het koppelen opnieuw.`, 502);
  if (provider === 'google') return { id: String(id), email: typeof payload.email === 'string' ? payload.email : null, name: typeof payload.name === 'string' ? payload.name : null };
  const email = typeof payload.mail === 'string' && payload.mail ? payload.mail : typeof payload.userPrincipalName === 'string' ? payload.userPrincipalName : null;
  return { id: String(id), email, name: typeof payload.displayName === 'string' ? payload.displayName : null };
}

async function disconnect(ctx: Ctx, connectionId: string) {
  if (!isUuid(connectionId)) throw new HttpError('Welke koppeling?', 400);
  const own = (await ownConnections(ctx)).find(c => c.id === connectionId);
  if (!own) throw new HttpError('Deze koppeling bestaat niet (meer), of is niet van jou.', 404);
  // Bewust geen "revoke" bij Google: dat trekt de hele toestemming voor de app
  // in, en als de agenda dezelfde Google-app gebruikt, viel die dan mee om.
  await must(admin.from('cloud_drive_connection_tokens').delete().eq('connection_id', own.id).eq('organization_id', ctx.organizationId));
  await must(admin.from('cloud_drive_connections').update({ status: 'revoked', last_error: 'Ontkoppeld.' })
    .eq('id', own.id).eq('organization_id', ctx.organizationId));
  return { linkedFiles: await linkedCount(ctx.organizationId, own.id) };
}

// ── Tokens ────────────────────────────────────────────────────────────

async function accessTokenFor(connection: ConnectionRow): Promise<{ accessToken: string; scopes: string[] }> {
  const label = cloudProviderLabel(connection.provider);
  const token = (await must(admin.from('cloud_drive_connection_tokens').select('*')
    .eq('connection_id', connection.id).eq('organization_id', connection.organization_id).maybeSingle())) as TokenRow | null;
  if (!token || connection.status === 'revoked') {
    throw new CloudTokenError(`De koppeling met ${label} staat uit. Koppel ${label} opnieuw.`, 'ingetrokken');
  }
  const expires = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (expires && expires - Date.now() > 120_000) {
    return { accessToken: await decryptToken(token.access_token_encrypted, TOKEN_KEY), scopes: token.scopes };
  }
  if (!token.refresh_token_encrypted) {
    throw new CloudTokenError(`${label} geeft ResoFly geen toegang meer (verlopen). Koppel ${label} opnieuw.`, 'ingetrokken');
  }

  const refreshToken = await decryptToken(token.refresh_token_encrypted, TOKEN_KEY);
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: connection.provider === 'google' ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID,
    client_secret: connection.provider === 'google' ? GOOGLE_CLIENT_SECRET : MICROSOFT_CLIENT_SECRET,
  });
  if (connection.provider === 'microsoft') params.set('scope', microsoftDriveRefreshScopes(token.scopes).join(' '));

  let status = 0;
  let payload: Record<string, unknown> = {};
  try {
    const res = await fetch(connection.provider === 'google' ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    payload = await res.json().catch(() => ({}));
  } catch (err) {
    console.warn('cloud-files token refresh: netwerkfout', connection.provider, err);
  }
  if (status < 200 || status >= 300 || !payload.access_token) {
    const failure = status >= 200 && status < 300 ? 'tijdelijk' : classifyTokenFailure(status, payload);
    const message = failure === 'ingetrokken'
      ? `${label} geeft ResoFly geen toegang meer (ingetrokken of verlopen). Koppel ${label} opnieuw.`
      : failure === 'instelling'
        ? `De koppeling met ${label} is niet goed ingesteld${payload.error ? ` (${String(payload.error).slice(0, 60)})` : ''}. Laat de beheerder van ResoFly dit nakijken.`
        : `${label} was even niet bereikbaar. ResoFly probeert het straks opnieuw.`;
    console.warn('cloud-files token refresh mislukt', connection.provider, status, payload.error, payload.error_description);
    if (failure !== 'tijdelijk') {
      await admin.from('cloud_drive_connections')
        .update({ status: failure === 'ingetrokken' ? 'expired' : 'error', last_error: message })
        .eq('id', connection.id).eq('organization_id', connection.organization_id);
    }
    throw new CloudTokenError(message, failure);
  }

  const accessToken = String(payload.access_token);
  const scopes = parseScope(payload.scope, token.scopes);
  await admin.from('cloud_drive_connection_tokens').update({
    access_token_encrypted: await encryptToken(accessToken, TOKEN_KEY),
    refresh_token_encrypted: payload.refresh_token ? await encryptToken(String(payload.refresh_token), TOKEN_KEY) : token.refresh_token_encrypted,
    token_type: payload.token_type ? String(payload.token_type) : token.token_type,
    scopes,
    expires_at: payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : null,
  }).eq('connection_id', connection.id).eq('organization_id', connection.organization_id);
  if (connection.status !== 'active') {
    await admin.from('cloud_drive_connections').update({ status: 'active', last_error: null })
      .eq('id', connection.id).eq('organization_id', connection.organization_id);
  }
  return { accessToken, scopes };
}

async function providerFetch(url: string, accessToken: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  } catch (err) {
    console.warn('cloud-files: provider niet bereikbaar', url.split('?')[0], err);
    return { status: 0, body: null };
  }
}

// ── Kiezen ────────────────────────────────────────────────────────────

/**
 * Het token voor de kiezer van Google. Dat komt in de browser (de kiezer is
 * een script van Google), dus het mag niet meer kunnen dan drive.file: alleen
 * de bestanden die iemand zelf kiest. Draagt het meer (de agenda, als Google de
 * rechten van dezelfde app samenvoegt), dan weigeren we.
 */
async function pickerToken(ctx: Ctx) {
  assertConfigured('google');
  const connection = await activeConnection(ctx, 'google');
  const { accessToken, scopes } = await accessTokenFor(connection);
  if (!pickerTokenScopesOk(scopes)) {
    throw new HttpError('Dit Google-token kan meer dan bestanden kiezen (bijvoorbeeld je agenda). Daarom geeft ResoFly het niet aan de kiezer. Laat de beheerder een eigen Google-app voor Drive instellen (GOOGLE_DRIVE_CLIENT_ID), en koppel daarna opnieuw.', 409);
  }
  return { accessToken, apiKey: GOOGLE_PICKER_API_KEY, appId: GOOGLE_APP_ID, account: connection.provider_account_email, connectionId: connection.id };
}

type BrowseItem = { id: string; driveId: string | null; name: string; isFolder: boolean; size: number | null; mimeType: string; modified: string | null; webUrl: string | null };

/**
 * De eigen OneDrive bekijken. De kiezer van Microsoft zelf vraagt tokens in de
 * browser (en voor werkaccounts rechten op SharePoint); deze lijst houdt het
 * token op de server.
 */
async function browse(ctx: Ctx, body: Record<string, unknown>) {
  assertConfigured('microsoft');
  const connection = await activeConnection(ctx, 'microsoft');
  const { accessToken } = await accessTokenFor(connection);
  const next = safeGraphNextLink(body.next);
  const folderId = typeof body.folderId === 'string' && body.folderId !== 'root' ? body.folderId : null;
  if (folderId && !isProviderId(folderId)) throw new HttpError('Onbekende map.', 400);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : '';

  let url: string;
  if (next) url = next;
  else if (query) url = `${GRAPH}/me/drive/root/search(q='${encodeURIComponent(query.replace(/'/g, "''"))}')?$top=50&$select=${GRAPH_SELECT}`;
  else if (folderId) url = `${GRAPH}/me/drive/items/${encodeURIComponent(folderId)}/children?$top=100&$select=${GRAPH_SELECT}`;
  else url = `${GRAPH}/me/drive/root/children?$top=100&$select=${GRAPH_SELECT}`;

  const res = await providerFetch(url, accessToken);
  if (res.status === 401) throw new CloudTokenError('OneDrive geeft ResoFly geen toegang meer. Koppel OneDrive opnieuw.', 'ingetrokken');
  if (res.status === 404) throw new HttpError('Deze map staat niet (meer) in je OneDrive.', 404);
  if (res.status < 200 || res.status >= 300) throw new HttpError('Je OneDrive kon niet worden gelezen. Probeer het zo opnieuw.', 502);
  const payload = (res.body && typeof res.body === 'object' ? res.body : {}) as Record<string, unknown>;
  const values = Array.isArray(payload.value) ? payload.value : [];
  const items: BrowseItem[] = [];
  for (const raw of values) {
    const meta = parseMicrosoftItem(raw);
    if (!meta || meta.trashed) continue;
    const modified = raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).lastModifiedDateTime === 'string'
      ? String((raw as Record<string, unknown>).lastModifiedDateTime) : null;
    items.push({ id: meta.id, driveId: meta.driveId, name: meta.name, isFolder: meta.isFolder, size: meta.size, mimeType: meta.mimeType, modified, webUrl: meta.webUrl });
  }
  items.sort((a, b) => Number(b.isFolder) - Number(a.isFolder) || a.name.localeCompare(b.name, 'nl'));
  return { items, next: safeGraphNextLink(payload['@odata.nextLink']), account: connection.provider_account_email };
}

// ── In een map zetten ─────────────────────────────────────────────────

type LinkSkip = { name: string; reason: string };

async function link(ctx: Ctx, body: Record<string, unknown>) {
  const provider = parseProvider(body.provider);
  assertConfigured(provider);
  const folderId = String(body.folderId || '');
  if (!isUuid(folderId)) throw new HttpError('Kies eerst een map in Inhoud.', 400);
  const folder = (await must(admin.from('content_folders').select('id, name')
    .eq('id', folderId).eq('organization_id', ctx.organizationId).maybeSingle())) as { id: string; name: string } | null;
  if (!folder) throw new HttpError('Deze map bestaat niet (meer).', 404);

  const rawFiles = Array.isArray(body.files) ? body.files : [];
  if (rawFiles.length === 0) throw new HttpError('Kies minstens één bestand.', 400);
  if (rawFiles.length > MAX_LINK_FILES) throw new HttpError(`Kies hooguit ${MAX_LINK_FILES} bestanden tegelijk.`, 400);
  const files: Array<{ id: string; driveId: string | null }> = [];
  for (const raw of rawFiles) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!isProviderId(r.id)) throw new HttpError('Een van de gekozen bestanden heeft geen geldig id.', 400);
    if (r.driveId !== undefined && r.driveId !== null && !isProviderId(r.driveId)) throw new HttpError('Een van de gekozen bestanden heeft geen geldige schijf.', 400);
    files.push({ id: r.id, driveId: typeof r.driveId === 'string' ? r.driveId : null });
  }

  const connection = await activeConnection(ctx, provider);
  const { accessToken } = await accessTokenFor(connection);
  const added: unknown[] = [];
  const skipped: LinkSkip[] = [];
  const notDeletable: string[] = [];

  for (const file of files) {
    const meta = await fetchMeta(provider, accessToken, file);
    if ('skip' in meta) { skipped.push(meta.skip); continue; }
    const id = crypto.randomUUID();
    const { data, error } = await admin.from('attachments').insert({
      id,
      organization_id: ctx.organizationId,
      created_by: ctx.userId,
      entity_type: 'folder',
      entity_id: folder.id,
      name: meta.name,
      mime_type: meta.mimeType,
      size_bytes: 0,
      storage_key: cloudStorageKey(ctx.organizationId, provider, id),
      public_url: null,
      cloud_provider: provider,
      cloud_file_id: meta.id,
      cloud_drive_id: meta.driveId,
      cloud_connection_id: connection.id,
      cloud_web_url: meta.webUrl,
      cloud_size_bytes: meta.size,
    }).select('*').single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        skipped.push({ name: meta.name, reason: 'Staat al in ResoFly.' });
        continue;
      }
      throw error;
    }
    added.push(data);
    if (meta.canDelete === false) notDeletable.push(meta.name);
  }
  return { added, skipped, notDeletable };
}

async function fetchMeta(
  provider: CloudProvider, accessToken: string, file: { id: string; driveId: string | null },
): Promise<CloudFileMeta | { skip: LinkSkip }> {
  const url = provider === 'google'
    ? `${GOOGLE_FILES}/${encodeURIComponent(file.id)}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,trashed,driveId,capabilities/canTrash`
    : file.driveId
      ? `${GRAPH}/drives/${encodeURIComponent(file.driveId)}/items/${encodeURIComponent(file.id)}?$select=${GRAPH_SELECT}`
      : `${GRAPH}/me/drive/items/${encodeURIComponent(file.id)}?$select=${GRAPH_SELECT}`;
  const res = await providerFetch(url, accessToken);
  const label = cloudProviderLabel(provider);
  if (res.status === 401) throw new CloudTokenError(`${label} geeft ResoFly geen toegang meer. Koppel ${label} opnieuw.`, 'ingetrokken');
  if (res.status === 403 || res.status === 404) return { skip: { name: file.id, reason: `Niet gevonden in ${label}, of ResoFly mag er niet bij.` } };
  if (res.status < 200 || res.status >= 300) return { skip: { name: file.id, reason: `${label} was even niet bereikbaar. Probeer het opnieuw.` } };
  const meta = provider === 'google' ? parseGoogleFile(res.body) : parseMicrosoftItem(res.body);
  if (!meta) return { skip: { name: file.id, reason: `${label} gaf geen bruikbaar antwoord.` } };
  if (meta.isFolder) return { skip: { name: meta.name, reason: 'Een map kun je (nog) niet koppelen. Kies de bestanden erin.' } };
  if (meta.trashed) return { skip: { name: meta.name, reason: `Staat in de prullenbak van ${label}.` } };
  if (provider === 'microsoft' && !meta.driveId) return { skip: { name: meta.name, reason: 'OneDrive zei niet op welke schijf dit bestand staat.' } };
  return meta;
}

// ── Weggooien ─────────────────────────────────────────────────────────

async function processForOrganization(ctx: Ctx) {
  const result = await processDue({ organizationId: ctx.organizationId, limit: 25 });
  return { ...result, deletions: await openDeletions(ctx) };
}

async function retryDeletion(ctx: Ctx, deletionId: string) {
  if (!isUuid(deletionId)) throw new HttpError('Welke?', 400);
  const rows = (await must(admin.from('cloud_file_deletions')
    .update({ status: 'pending', failure: null, attempts: 0, next_attempt_at: new Date().toISOString() })
    .eq('id', deletionId).eq('organization_id', ctx.organizationId).in('status', ['failed', 'pending'])
    .select('*'))) as DeletionRow[];
  if (!rows.length) throw new HttpError('Dit staat niet (meer) in de lijst.', 404);
  const outcome = await processDeletion(rows[0]);
  return { outcome, deletions: await openDeletions(ctx) };
}

async function dismissDeletion(ctx: Ctx, deletionId: string) {
  if (!isUuid(deletionId)) throw new HttpError('Welke?', 400);
  await must(admin.from('cloud_file_deletions').delete()
    .eq('id', deletionId).eq('organization_id', ctx.organizationId).in('status', ['failed', 'pending']));
  return { deletions: await openDeletions(ctx) };
}

async function processDue(filter: { organizationId?: string; connectionId?: string; limit: number }) {
  let query = admin.from('cloud_file_deletions').select('*')
    .eq('status', 'pending').lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true }).limit(filter.limit);
  if (filter.organizationId) query = query.eq('organization_id', filter.organizationId);
  if (filter.connectionId) query = query.eq('connection_id', filter.connectionId);
  const rows = (await must(query)) as DeletionRow[];
  const counts = { done: 0, failed: 0, pending: 0 };
  for (const row of rows) counts[await processDeletion(row)] += 1;
  return counts;
}

/**
 * Eén bestand in de prullenbak van Drive of OneDrive. Eerst "claimen" (de
 * volgende poging een paar minuten vooruit), zodat de app en de geplande taak
 * hetzelfde bestand niet tegelijk doen.
 */
async function processDeletion(row: DeletionRow): Promise<'done' | 'failed' | 'pending'> {
  const nowIso = new Date().toISOString();
  const claimed = (await must(admin.from('cloud_file_deletions')
    .update({ next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString() })
    .eq('id', row.id).eq('status', 'pending').lte('next_attempt_at', nowIso).select('id'))) as Array<{ id: string }>;
  if (!claimed.length) return 'pending';

  // Wijst er in ResoFly nog iets naar hetzelfde bestand (in een andere
  // organisatie van hetzelfde account), dan niet weggooien.
  const { count, error: countError } = await admin.from('attachments').select('id', { count: 'exact', head: true })
    .eq('cloud_provider', row.provider).eq('cloud_file_id', row.file_id);
  if (countError) throw countError;
  if ((count ?? 0) > 0) return await finish(row, { kind: 'done', note: 'Staat nog op een andere plek in ResoFly; daarom niet weggegooid.' });

  const label = cloudProviderLabel(row.provider);
  const connection = row.connection_id
    ? (await must(admin.from('cloud_drive_connections').select('*')
      .eq('id', row.connection_id).eq('organization_id', row.organization_id).maybeSingle())) as ConnectionRow | null
    : null;
  if (!connection) {
    return await finish(row, { kind: 'failed', failure: 'other', message: `De koppeling waarmee dit bestand in ResoFly kwam, bestaat niet meer. Het staat dus nog in ${label}.` });
  }
  if (connection.provider !== row.provider) {
    return await finish(row, { kind: 'failed', failure: 'other', message: 'Deze koppeling hoort bij een andere aanbieder.' });
  }

  let accessToken: string;
  try {
    accessToken = (await accessTokenFor(connection)).accessToken;
  } catch (err) {
    if (err instanceof CloudTokenError) {
      if (err.failure === 'tijdelijk') return await finish(row, { kind: 'retry', message: err.message });
      const who = connection.provider_account_email ? ` (${connection.provider_account_email})` : '';
      return await finish(row, { kind: 'failed', failure: 'connection', message: `De koppeling met ${label}${who} is verlopen of staat uit. Zodra die opnieuw is gekoppeld, gooit ResoFly het bestand alsnog weg.` });
    }
    throw err;
  }

  const res = row.provider === 'google'
    ? await providerFetch(`${GOOGLE_FILES}/${encodeURIComponent(row.file_id)}?supportsAllDrives=true&fields=id,trashed`, accessToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    })
    : row.drive_id
      ? await providerFetch(`${GRAPH}/drives/${encodeURIComponent(row.drive_id)}/items/${encodeURIComponent(row.file_id)}`, accessToken, { method: 'DELETE' })
      : { status: 400, body: null };
  return await finish(row, classifyDeleteResponse(row.provider, res.status, res.body));
}

async function finish(row: DeletionRow, outcome: DeleteOutcome): Promise<'done' | 'failed' | 'pending'> {
  const attempts = row.attempts + 1;
  const now = new Date();
  let patch: Partial<DeletionRow>;
  let result: 'done' | 'failed' | 'pending';
  if (outcome.kind === 'done') {
    patch = { status: 'done', failure: null, last_error: outcome.note, attempts, done_at: now.toISOString() };
    result = 'done';
  } else if (outcome.kind === 'retry' && attempts < MAX_DELETE_ATTEMPTS) {
    patch = { status: 'pending', last_error: outcome.message, attempts, next_attempt_at: new Date(now.getTime() + nextAttemptDelaySeconds(attempts) * 1000).toISOString() };
    result = 'pending';
  } else {
    const message = outcome.kind === 'retry' ? `${outcome.message} Na ${attempts} pogingen gestopt.` : outcome.message;
    patch = { status: 'failed', failure: outcome.kind === 'failed' ? outcome.failure : 'other', last_error: message, attempts };
    result = 'failed';
  }
  await must(admin.from('cloud_file_deletions').update(patch).eq('id', row.id).eq('organization_id', row.organization_id));
  return result;
}

// ── De geplande taak ──────────────────────────────────────────────────

async function handleCron(req: Request): Promise<Response> {
  const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ ok: false, error: 'Alleen POST.' }, 405);
  if (!CRON_SECRET || !timingSafeEqual(req.headers.get('x-cron-secret') || '', CRON_SECRET)) {
    return json({ ok: false, error: 'Ongeldig of ontbrekend cron-secret.' }, 401);
  }
  try {
    const counts = await processDue({ limit: 100 });
    // Wat klaar is, bewaren we een maand (wie vraagt "is het weg?", ziet het nog).
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    await cleanup(admin, cutoff);
    return json({ ok: true, ...counts });
  } catch (err) {
    console.error('cloud-files cron mislukt', err);
    return json({ ok: false, error: err instanceof Error ? err.message : 'Onbekende fout' }, 500);
  }
}

async function cleanup(client: SupabaseClient, cutoff: string): Promise<void> {
  const { error } = await client.from('cloud_file_deletions').delete().eq('status', 'done').lt('done_at', cutoff);
  if (error) console.warn('cloud-files opruimen mislukt', error.message);
}
