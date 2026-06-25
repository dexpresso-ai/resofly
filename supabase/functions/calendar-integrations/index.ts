import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { generateAppPasswordToken, generateSalt, hashAppPassword } from '../_shared/appPassword.ts';

type Provider = 'google' | 'microsoft' | 'native';
type CalendarVisibility = 'private' | 'organization';
type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type CalendarSourceRow = {
  id: string;
  organization_id: string;
  user_id: string;
  connection_id: string | null;
  provider: Provider;
  provider_calendar_id: string;
  name: string;
  description: string | null;
  color: string | null;
  timezone: string | null;
  is_primary: boolean;
  access_role: string | null;
  sync_enabled: boolean;
  write_enabled: boolean;
  visibility: CalendarVisibility;
  created_at: string;
  updated_at: string;
};

type ConnectionRow = {
  id: string;
  organization_id: string;
  user_id: string;
  provider: Provider;
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
  provider: Provider;
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
  token_type: string | null;
  scopes: string[];
  expires_at: string | null;
};

type OAuthState = {
  provider: Provider;
  userId: string;
  organizationId: string;
  returnTo: string;
  nonce: string;
  iat: number;
  exp: number;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const CALENDAR_REDIRECT_URL = requiredEnv('CALENDAR_REDIRECT_URL');
const STATE_SECRET = requiredEnv('CALENDAR_OAUTH_STATE_SECRET');
const TOKEN_ENCRYPTION_KEY = requiredEnv('CALENDAR_TOKEN_ENCRYPTION_KEY');
const ALLOWED_RETURN_ORIGINS = (Deno.env.get('CALENDAR_ALLOWED_RETURN_ORIGINS') || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CALENDAR_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CALENDAR_CLIENT_SECRET') || '';
const MICROSOFT_CLIENT_ID = Deno.env.get('MICROSOFT_CALENDAR_CLIENT_ID') || '';
const MICROSOFT_CLIENT_SECRET = Deno.env.get('MICROSOFT_CALENDAR_CLIENT_SECRET') || '';
const MICROSOFT_TENANT_ID = Deno.env.get('MICROSOFT_CALENDAR_TENANT_ID') || 'common';
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_STATE_MAX_LENGTH = 4096;
const OAUTH_STATE_CLOCK_SKEW_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  try {
    if (req.method === 'GET') return await handleOAuthCallback(req);
    if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(user.id, organizationId);
    const requireWrite = () => requireRole(role, ['owner', 'admin', 'member'], 'Deze agenda-actie vereist schrijfrechten binnen de organisatie.');

    switch (action) {
      case 'oauthStart': requireWrite(); return json({ ok: true, authUrl: await startOAuth(user.id, organizationId, body) });
      case 'listIntegrations': return json({ ok: true, ...(await listIntegrations(organizationId, user.id)) });
      case 'refreshSources': requireWrite(); return json({ ok: true, ...(await refreshSources(organizationId, user.id, String(body.connectionId || ''))) });
      case 'updateSource': requireWrite(); return json({ ok: true, source: await updateSource(organizationId, user.id, String(body.sourceId || ''), body.patch || {}) });
      case 'disconnectConnection': requireWrite(); await disconnectConnection(organizationId, user.id, String(body.connectionId || '')); return json({ ok: true });
      case 'listEvents': return json({ ok: true, events: await listEvents(organizationId, user.id, String(body.start || ''), String(body.end || '')) });
      case 'createEvent': requireWrite(); return json({ ok: true, event: await createEvent(organizationId, user.id, body.event || {}) });
      case 'updateEvent': requireWrite(); return json({ ok: true, event: await updateNativeEvent(organizationId, user.id, body.event || {}) });
      case 'deleteEvent': requireWrite(); await deleteNativeEvent(organizationId, user.id, String(body.eventId || '')); return json({ ok: true });
      case 'createNativeCalendar': requireWrite(); return json({ ok: true, source: await createNativeCalendar(organizationId, user.id, body) });
      case 'updateNativeCalendar': requireWrite(); return json({ ok: true, source: await updateNativeCalendar(organizationId, user.id, body) });
      case 'deleteNativeCalendar': requireWrite(); await deleteNativeCalendar(organizationId, user.id, String(body.sourceId || '')); return json({ ok: true });
      case 'createAppPassword': return json({ ok: true, ...(await createAppPassword(organizationId, user.id, body)) });
      case 'listAppPasswords': return json({ ok: true, appPasswords: await listAppPasswords(organizationId, user.id) });
      case 'revokeAppPassword': await revokeAppPassword(organizationId, user.id, String(body.appPasswordId || '')); return json({ ok: true });
      default: return json({ ok: false, error: `Onbekende calendar action: ${action}` }, 400);
    }
  } catch (error) {
    console.error('calendar-integrations error', error);
    return json({ ok: false, error: error instanceof Error ? error.message : 'Onbekende calendar-integrations fout.' }, 500);
  }
});

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Niet ingelogd: Authorization header ontbreekt.');
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new Error('Niet ingelogd of ongeldig sessietoken.');
  return { id: data.user.id, email: data.user.email || undefined };
}

async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!UUID_RE.test(organizationId)) {
    throw new Error('Ongeldige organisatie.');
  }
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new Error('Geen toegang tot deze organisatie.');
  return role;
}

function requireRole(role: OrganizationRole, allowed: OrganizationRole[], message: string): void {
  if (!allowed.includes(role)) throw new Error(message);
}

async function startOAuth(userId: string, organizationId: string, body: Record<string, unknown>): Promise<string> {
  const provider = parseProvider(body.provider);
  assertProviderConfigured(provider);
  const returnTo = sanitizeReturnTo(String(body.returnTo || ''));
  const now = Math.floor(Date.now() / 1000);
  const state = await signState({
    provider,
    userId,
    organizationId,
    returnTo,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + OAUTH_STATE_TTL_SECONDS,
  });

  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: CALENDAR_REDIRECT_URL,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: googleScopes().join(' '),
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    redirect_uri: CALENDAR_REDIRECT_URL,
    response_type: 'code',
    response_mode: 'query',
    scope: microsoftScopes().join(' '),
    state,
  });
  return `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?${params}`;
}

async function handleOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');
  const stateRaw = url.searchParams.get('state');
  if (!stateRaw) return json({ ok: false, error: 'OAuth state ontbreekt.' }, 400);

  let state: OAuthState;
  try {
    state = await verifyState(stateRaw);
  } catch (stateError) {
    console.warn('calendar OAuth callback rejected invalid state', stateError);
    return json({ ok: false, error: 'Ongeldige of verlopen OAuth state.' }, 400);
  }

  if (error) return redirectWithStatus(state.returnTo, { calendar_error: errorDescription || error });

  const code = url.searchParams.get('code');
  if (!code) return redirectWithStatus(state.returnTo, { calendar_error: 'OAuth code ontbreekt.' });

  try {
    const token = await exchangeCode(state.provider, code);
    const accessToken = String(token.access_token || '');
    if (!accessToken) throw new Error('Provider gaf geen access token terug.');
    const account = await fetchAccountProfile(state.provider, accessToken);
    await requireOrganizationAccess(state.userId, state.organizationId);
    const connection = await upsertConnection(state.userId, state.organizationId, state.provider, account, token);
    await upsertTokens(connection, token);
    await syncSourcesForConnection(connection);
    return redirectWithStatus(state.returnTo, { calendar_connected: state.provider });
  } catch (err) {
    console.error('oauth callback failed', err);
    return redirectWithStatus(state.returnTo, { calendar_error: err instanceof Error ? err.message : 'OAuth callback mislukt.' });
  }
}

function redirectWithStatus(returnTo: string, params: Record<string, string>): Response {
  const target = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: target.toString(), ...corsHeaders } });
}

function parseProvider(value: unknown): Provider {
  if (value === 'google' || value === 'microsoft') return value;
  throw new Error('Ongeldige agenda-provider.');
}

function assertProviderConfigured(provider: Provider) {
  if (provider === 'google' && (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)) throw new Error('Google Calendar OAuth secrets ontbreken.');
  if (provider === 'microsoft' && (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET)) throw new Error('Microsoft Calendar OAuth secrets ontbreken.');
}

function googleScopes(): string[] {
  return ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'];
}

function microsoftScopes(): string[] {
  return ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Calendars.ReadWrite'];
}

function sanitizeReturnTo(raw: string): string {
  const fallback = ALLOWED_RETURN_ORIGINS[0] || 'http://localhost:5173';
  const candidate = raw || fallback;
  const url = new URL(candidate);

  const isConfiguredOrigin = ALLOWED_RETURN_ORIGINS.includes(url.origin);
  const isResoflyCloudflarePreview =
    url.protocol === 'https:' &&
    (url.hostname === 'resofly.pages.dev' || url.hostname.endsWith('.resofly.pages.dev'));

  if (ALLOWED_RETURN_ORIGINS.length > 0 && !isConfiguredOrigin && !isResoflyCloudflarePreview) {
    throw new Error(`Return URL origin niet toegestaan: ${url.origin}`);
  }

  return url.toString();
}

async function exchangeCode(provider: Provider, code: string): Promise<Record<string, string | number | undefined>> {
  const endpoint = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALENDAR_REDIRECT_URL,
    client_id: provider === 'google' ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID,
    client_secret: provider === 'google' ? GOOGLE_CLIENT_SECRET : MICROSOFT_CLIENT_SECRET,
  });
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error_description || payload.error || `${provider} token exchange mislukt.`);
  return payload;
}

async function refreshAccessToken(token: TokenRow): Promise<string> {
  const expires = token.expires_at ? new Date(token.expires_at).getTime() : 0;
  if (expires && expires - Date.now() > 120_000) return await decrypt(token.access_token_encrypted);
  if (!token.refresh_token_encrypted) return await decrypt(token.access_token_encrypted);

  const refreshToken = await decrypt(token.refresh_token_encrypted);
  const endpoint = token.provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: token.provider === 'google' ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID,
    client_secret: token.provider === 'google' ? GOOGLE_CLIENT_SECRET : MICROSOFT_CLIENT_SECRET,
  });
  if (token.provider === 'microsoft') params.set('scope', microsoftScopes().join(' '));

  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    await supabaseAdmin.from('calendar_connections').update({ status: 'expired', last_error: payload.error_description || payload.error || 'Refresh token verlopen' }).eq('id', token.connection_id);
    throw new Error(payload.error_description || payload.error || 'Agenda-token vernieuwen mislukt.');
  }

  const accessToken = String(payload.access_token || '');
  if (!accessToken) throw new Error('Provider gaf geen access token terug.');
  const nextRefreshToken = payload.refresh_token ? String(payload.refresh_token) : refreshToken;
  await supabaseAdmin.from('calendar_connection_tokens').update({
    access_token_encrypted: await encrypt(accessToken),
    refresh_token_encrypted: await encrypt(nextRefreshToken),
    token_type: payload.token_type ? String(payload.token_type) : token.token_type,
    scopes: parseScope(payload.scope, token.scopes),
    expires_at: payload.expires_in ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString() : token.expires_at,
  }).eq('connection_id', token.connection_id);
  await supabaseAdmin.from('calendar_connections').update({ status: 'active', last_error: null }).eq('id', token.connection_id);
  return accessToken;
}

async function fetchAccountProfile(provider: Provider, accessToken: string): Promise<{ id: string; email: string | null; name: string | null }> {
  const endpoint = provider === 'google' ? 'https://www.googleapis.com/oauth2/v3/userinfo' : 'https://graph.microsoft.com/v1.0/me';
  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || `${provider} profiel ophalen mislukt.`);
  if (provider === 'google') return { id: String(payload.sub), email: payload.email ?? null, name: payload.name ?? null };
  return { id: String(payload.id), email: payload.mail || payload.userPrincipalName || null, name: payload.displayName ?? null };
}

async function upsertConnection(userId: string, organizationId: string, provider: Provider, account: { id: string; email: string | null; name: string | null }, token: Record<string, string | number | undefined>): Promise<ConnectionRow> {
  const scopes = parseScope(token.scope, provider === 'google' ? googleScopes() : microsoftScopes());
  const { data, error } = await supabaseAdmin.from('calendar_connections').upsert({
    organization_id: organizationId,
    user_id: userId,
    provider,
    provider_account_id: account.id,
    provider_account_email: account.email,
    display_name: account.name,
    status: 'active',
    scopes,
    last_error: null,
  }, { onConflict: 'organization_id,user_id,provider,provider_account_id' }).select('*').single();
  if (error) throw error;
  return data as ConnectionRow;
}

async function upsertTokens(connection: ConnectionRow, token: Record<string, string | number | undefined>) {
  const accessToken = String(token.access_token || '');
  if (!accessToken) throw new Error('Provider gaf geen access token terug.');
  const refreshToken = token.refresh_token ? String(token.refresh_token) : null;

  const existing = await getToken(connection.organization_id, connection.id).catch(() => null);
  const refreshEncrypted = refreshToken
    ? await encrypt(refreshToken)
    : existing?.refresh_token_encrypted ?? null;

  const { error } = await supabaseAdmin.from('calendar_connection_tokens').upsert({
    connection_id: connection.id,
    organization_id: connection.organization_id,
    user_id: connection.user_id,
    provider: connection.provider,
    access_token_encrypted: await encrypt(accessToken),
    refresh_token_encrypted: refreshEncrypted,
    token_type: token.token_type ? String(token.token_type) : 'Bearer',
    scopes: parseScope(token.scope, connection.scopes),
    expires_at: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
  }, { onConflict: 'connection_id' });
  if (error) throw error;
}

function parseScope(scope: unknown, fallback: string[]): string[] {
  if (typeof scope !== 'string' || !scope.trim()) return fallback;
  return scope.split(/\s+/).filter(Boolean);
}

async function listIntegrations(organizationId: string, requesterUserId: string): Promise<{ connections: ConnectionRow[]; sources: CalendarSourceRow[] }> {
  const [{ data: connections, error: cError }, { data: sources, error: sError }] = await Promise.all([
    supabaseAdmin.from('calendar_connections').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false }),
    supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).order('name', { ascending: true }),
  ]);
  if (cError) throw cError;
  if (sError) throw sError;

  const visibleSources = ((sources ?? []) as CalendarSourceRow[]).filter(source => source.user_id === requesterUserId || source.visibility === 'organization');
  const visibleConnectionIds = new Set(visibleSources.map(source => source.connection_id));
  const visibleConnections = ((connections ?? []) as ConnectionRow[])
    .filter(connection => connection.user_id === requesterUserId || visibleConnectionIds.has(connection.id))
    .map(connection => sanitizeConnectionForRequester(connection, requesterUserId));

  return { connections: visibleConnections, sources: visibleSources };
}

function sanitizeConnectionForRequester(connection: ConnectionRow, requesterUserId: string): ConnectionRow {
  if (connection.user_id === requesterUserId) return connection;
  return {
    ...connection,
    provider_account_id: 'shared',
    provider_account_email: null,
    display_name: 'Gedeelde agenda',
    scopes: [],
    last_error: null,
  };
}

async function getConnection(organizationId: string, connectionId: string): Promise<ConnectionRow> {
  const { data, error } = await supabaseAdmin.from('calendar_connections').select('*').eq('organization_id', organizationId).eq('id', connectionId).single();
  if (error || !data) throw new Error('Agenda-koppeling niet gevonden.');
  return data as ConnectionRow;
}

async function getToken(organizationId: string, connectionId: string): Promise<TokenRow> {
  const { data, error } = await supabaseAdmin.from('calendar_connection_tokens').select('*').eq('organization_id', organizationId).eq('connection_id', connectionId).single();
  if (error || !data) throw new Error('Agenda-token niet gevonden. Koppel het account opnieuw.');
  return data as TokenRow;
}

async function refreshSources(organizationId: string, requesterUserId: string, connectionId: string) {
  const connection = await getConnection(organizationId, connectionId);
  if (connection.user_id !== requesterUserId) throw new Error('Alleen de eigenaar kan deze agenda-koppeling verversen.');
  await syncSourcesForConnection(connection);
  return await listIntegrations(organizationId, requesterUserId);
}

async function syncSourcesForConnection(connection: ConnectionRow) {
  const token = await getToken(connection.organization_id, connection.id);
  const accessToken = await refreshAccessToken(token);
  const sources = connection.provider === 'google'
    ? await fetchGoogleSources(accessToken)
    : await fetchMicrosoftSources(accessToken);

  for (const source of sources) {
    const { error } = await supabaseAdmin.from('calendar_sources').upsert({
      organization_id: connection.organization_id,
      user_id: connection.user_id,
      connection_id: connection.id,
      provider: connection.provider,
      provider_calendar_id: source.provider_calendar_id,
      name: source.name,
      description: source.description,
      color: source.color,
      timezone: source.timezone,
      is_primary: source.is_primary,
      access_role: source.access_role,
    }, { onConflict: 'connection_id,provider_calendar_id' });
    if (error) throw error;
  }
}

async function fetchGoogleSources(accessToken: string) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=freeBusyReader&showDeleted=false', { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Google agenda’s ophalen mislukt.');
  return (payload.items ?? []).map((item: Record<string, unknown>) => ({
    provider_calendar_id: String(item.id),
    name: String(item.summary || 'Naamloze Google agenda'),
    description: item.description ? String(item.description) : null,
    color: item.backgroundColor ? String(item.backgroundColor) : null,
    timezone: item.timeZone ? String(item.timeZone) : null,
    is_primary: Boolean(item.primary),
    access_role: item.accessRole ? String(item.accessRole) : null,
  }));
}

async function fetchMicrosoftSources(accessToken: string) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,color,canEdit,canShare,canViewPrivateItems,isDefaultCalendar,owner', { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft agenda’s ophalen mislukt.');
  return (payload.value ?? []).map((item: Record<string, unknown>) => ({
    provider_calendar_id: String(item.id),
    name: String(item.name || 'Naamloze Microsoft agenda'),
    description: null,
    color: item.color ? String(item.color) : null,
    timezone: null,
    is_primary: Boolean(item.isDefaultCalendar),
    access_role: item.canEdit ? 'writer' : 'reader',
  }));
}

async function updateSource(organizationId: string, requesterUserId: string, sourceId: string, patch: Record<string, unknown>): Promise<CalendarSourceRow> {
  const allowed: Partial<Pick<CalendarSourceRow, 'sync_enabled' | 'write_enabled' | 'visibility'>> = {};
  if (typeof patch.sync_enabled === 'boolean') allowed.sync_enabled = patch.sync_enabled;
  if (typeof patch.write_enabled === 'boolean') allowed.write_enabled = patch.write_enabled;
  if (patch.visibility === 'private' || patch.visibility === 'organization') allowed.visibility = patch.visibility;
  if (Object.keys(allowed).length === 0) throw new Error('Geen geldige agenda-instelling aangeleverd.');

  const { data: existing, error: loadError } = await supabaseAdmin
    .from('calendar_sources')
    .select('*')
    .eq('id', sourceId)
    .eq('organization_id', organizationId)
    .single();
  if (loadError || !existing) throw new Error('Agenda-bron niet gevonden.');
  const current = existing as CalendarSourceRow;
  if (current.user_id !== requesterUserId) throw new Error('Alleen de gebruiker die deze agenda heeft gekoppeld kan delen, tonen of schrijven aanpassen.');
  if (allowed.write_enabled === true && !sourceCanWrite(current)) {
    throw new Error('Deze externe agenda lijkt alleen-lezen. Schrijven kan niet worden ingeschakeld.');
  }

  const { data, error } = await supabaseAdmin.from('calendar_sources').update(allowed).eq('id', sourceId).eq('organization_id', organizationId).eq('user_id', requesterUserId).select('*').single();
  if (error || !data) throw new Error('Agenda-bron niet gevonden of niet bijgewerkt.');
  return data as CalendarSourceRow;
}

function sourceCanWrite(source: CalendarSourceRow): boolean {
  const role = String(source.access_role || '').toLowerCase();
  if (source.provider === 'google') return ['owner', 'writer'].includes(role);
  if (source.provider === 'microsoft') return role === 'writer' || role === 'owner';
  return false;
}

async function disconnectConnection(organizationId: string, requesterUserId: string, connectionId: string) {
  const connection = await getConnection(organizationId, connectionId);
  if (connection.user_id !== requesterUserId) throw new Error('Alleen de eigenaar kan deze agenda-koppeling loskoppelen.');
  const token = await getToken(organizationId, connection.id).catch(() => null);
  if (token) await revokeBestEffort(connection.provider, token);
  const { error } = await supabaseAdmin.from('calendar_connections').delete().eq('id', connection.id).eq('organization_id', organizationId).eq('user_id', requesterUserId);
  if (error) throw error;
}

async function revokeBestEffort(provider: Provider, token: TokenRow) {
  try {
    const accessToken = await decrypt(token.access_token_encrypted);
    if (provider === 'google') {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, { method: 'POST' });
    }
    // Microsoft delegated token revocation is tenant/user policy-dependent; local token deletion remains the source of truth.
  } catch (err) {
    console.warn('Token revoke best-effort failed', err);
  }
}

async function listEvents(organizationId: string, requesterUserId: string, start: string, end: string) {
  const startIso = assertIso(start, 'start');
  const endIso = assertIso(end, 'end');
  const { data: sources, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('sync_enabled', true);
  if (error) throw error;
  const events: Record<string, unknown>[] = [];
  const visibleSources = ((sources ?? []) as CalendarSourceRow[]).filter(source => source.user_id === requesterUserId || source.visibility === 'organization');
  for (const source of visibleSources) {
    try {
      if (source.provider === 'native') {
        const nativeEvents = await fetchNativeEvents(organizationId, source, startIso, endIso);
        events.push(...nativeEvents.map(event => maskPrivateEventForRequester(event, source, requesterUserId)));
        continue;
      }
      if (!source.connection_id) continue;
      const connection = await getConnection(organizationId, source.connection_id);
      const token = await getToken(organizationId, connection.id);
      const accessToken = await refreshAccessToken(token);
      const sourceEvents = source.provider === 'google'
        ? await fetchGoogleEvents(accessToken, source, startIso, endIso)
        : await fetchMicrosoftEvents(accessToken, source, startIso, endIso);
      events.push(...sourceEvents.map(event => maskPrivateEventForRequester(event, source, requesterUserId)));
    } catch (err) {
      console.warn('Event sync failed for source', source.id, err);
      await supabaseAdmin.from('calendar_connections').update({ status: 'error', last_error: err instanceof Error ? err.message : 'Event sync mislukt' }).eq('id', source.connection_id);
    }
  }
  return dedupeCalendarEvents(events).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
}

function dedupeCalendarEvents(events: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const event of events) {
    const key = [event.provider, event.source_id, event.provider_event_id, event.starts_at].map(value => String(value || '')).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function maskPrivateEventForRequester(event: Record<string, unknown>, source: CalendarSourceRow, requesterUserId: string) {
  if (source.visibility !== 'private' || source.user_id === requesterUserId) return event;
  return {
    ...event,
    title: 'Bezet',
    description: null,
    location: null,
    html_link: null,
    is_private_masked: true,
  };
}

async function fetchGoogleEvents(accessToken: string, source: CalendarSourceRow, start: string, end: string) {
  const params = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Google events ophalen mislukt.');
  return (payload.items ?? []).filter((item: Record<string, unknown>) => item.status !== 'cancelled').map((item: Record<string, unknown>) => {
    const startObj = (item.start ?? {}) as Record<string, string>;
    const endObj = (item.end ?? {}) as Record<string, string>;
    const allDay = Boolean(startObj.date && !startObj.dateTime);
    const allDayRange = allDay ? normalizeAllDayEventRange(startObj.date, endObj.date) : null;
    return {
      id: `${source.id}:${String(item.id)}`,
      provider: 'google' as Provider,
      source_id: source.id,
      source_name: source.name,
      provider_event_id: String(item.id),
      title: String(item.summary || '(Geen titel)'),
      description: item.description ? String(item.description) : null,
      location: item.location ? String(item.location) : null,
      starts_at: allDayRange ? allDayRange.starts_at : String(startObj.dateTime),
      ends_at: allDayRange ? allDayRange.ends_at : String(endObj.dateTime),
      all_day: allDay,
      html_link: item.htmlLink ? String(item.htmlLink) : null,
      visibility: source.visibility,
      is_private_masked: false,
    };
  });
}

async function fetchMicrosoftEvents(accessToken: string, source: CalendarSourceRow, start: string, end: string) {
  const params = new URLSearchParams({ startDateTime: start, endDateTime: end, '$top': '250', '$orderby': 'start/dateTime', '$select': 'id,subject,bodyPreview,location,start,end,isAllDay,webLink' });
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(source.provider_calendar_id)}/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft events ophalen mislukt.');
  return (payload.value ?? []).map((item: Record<string, unknown>) => {
    const startObj = (item.start ?? {}) as Record<string, string>;
    const endObj = (item.end ?? {}) as Record<string, string>;
    const location = (item.location ?? {}) as Record<string, string>;
    const allDay = Boolean(item.isAllDay);
    const allDayRange = allDay ? normalizeAllDayEventRange(startObj.dateTime, endObj.dateTime) : null;
    return {
      id: `${source.id}:${String(item.id)}`,
      provider: 'microsoft' as Provider,
      source_id: source.id,
      source_name: source.name,
      provider_event_id: String(item.id),
      title: String(item.subject || '(Geen titel)'),
      description: item.bodyPreview ? String(item.bodyPreview) : null,
      location: location.displayName ? String(location.displayName) : null,
      starts_at: allDayRange ? allDayRange.starts_at : normalizeMicrosoftDateTime(startObj.dateTime),
      ends_at: allDayRange ? allDayRange.ends_at : normalizeMicrosoftDateTime(endObj.dateTime),
      all_day: allDay,
      html_link: item.webLink ? String(item.webLink) : null,
      visibility: source.visibility,
      is_private_masked: false,
    };
  });
}

async function createEvent(organizationId: string, requesterUserId: string, input: Record<string, unknown>) {
  const sourceId = String(input.sourceId || '');
  const { data: source, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
  if (error || !source) throw new Error('Agenda-bron niet gevonden.');
  const calendarSource = source as CalendarSourceRow;
  if (calendarSource.user_id !== requesterUserId && calendarSource.visibility !== 'organization') {
    throw new Error('Deze privé-agenda is niet met de organisatie gedeeld.');
  }
  if (calendarSource.provider === 'native') {
    return await createNativeEvent(organizationId, requesterUserId, calendarSource, input);
  }
  if (!calendarSource.write_enabled) {
    throw new Error('Schrijfbare agenda-bron niet gevonden.');
  }
  if (!sourceCanWrite(calendarSource)) {
    throw new Error('Deze externe agenda is niet schrijfbaar volgens de provider.');
  }
  if (!calendarSource.connection_id) throw new Error('Externe agenda-bron mist een koppeling.');
  const connection = await getConnection(organizationId, calendarSource.connection_id);
  if (connection.status !== 'active') {
    throw new Error(`Agenda-koppeling is niet actief (status: ${connection.status}). Koppel het account opnieuw.`);
  }
  const token = await getToken(organizationId, connection.id);
  const accessToken = await refreshAccessToken(token);
  const event = normalizeNewEventInput(input);
  return calendarSource.provider === 'google'
    ? await createGoogleEvent(accessToken, calendarSource, event)
    : await createMicrosoftEvent(accessToken, calendarSource, event);
}

function normalizeNewEventInput(input: Record<string, unknown>) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Eventtitel ontbreekt.');
  const startsAt = assertIso(String(input.startsAt || ''), 'startsAt');
  const endsAt = assertIso(String(input.endsAt || ''), 'endsAt');
  const allDay = Boolean(input.allDay);
  // For timed events, end must be strictly after start.
  // For all-day events, start == end is valid (single day).
  if (!allDay && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('Eindtijd moet na starttijd liggen.');
  }
  if (allDay && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw new Error('Einddatum mag niet voor startdatum liggen.');
  }
  return {
    title,
    description: input.description ? String(input.description) : null,
    location: input.location ? String(input.location) : null,
    startsAt,
    endsAt,
    allDay,
  };
}

/** Given a date string "YYYY-MM-DD", return the next day as "YYYY-MM-DD". */
function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z'); // noon UTC avoids DST edge cases
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function providerDateKey(value?: string | null): string | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeAllDayEventRange(startValue?: string | null, endExclusiveValue?: string | null): { starts_at: string; ends_at: string } {
  const startDate = providerDateKey(startValue) || new Date().toISOString().slice(0, 10);
  const rawEndExclusive = providerDateKey(endExclusiveValue) || nextDay(startDate);
  const endExclusive = rawEndExclusive <= startDate ? nextDay(startDate) : rawEndExclusive;
  return {
    starts_at: `${startDate}T00:00:00.000Z`,
    ends_at: `${endExclusive}T00:00:00.000Z`,
  };
}

async function createGoogleEvent(accessToken: string, source: CalendarSourceRow, event: ReturnType<typeof normalizeNewEventInput>) {
  let body: Record<string, unknown>;
  if (event.allDay) {
    const startDate = event.startsAt.slice(0, 10);
    // Google Calendar API: end.date is EXCLUSIVE. For a single-day event on 2026-05-08,
    // start.date = "2026-05-08", end.date = "2026-05-09".
    const endDateRaw = event.endsAt.slice(0, 10);
    const endExclusive = endDateRaw <= startDate
      ? nextDay(startDate)
      : nextDay(endDateRaw);
    body = {
      summary: event.title,
      description: event.description,
      location: event.location,
      start: { date: startDate },
      end: { date: endExclusive },
    };
  } else {
    // Timed events: startsAt/endsAt are already UTC ISO strings (ending in Z).
    // Optionally set the source timezone so Google can display correctly in the calendar's zone.
    const tz = source.timezone || undefined;
    body = {
      summary: event.title,
      description: event.description,
      location: event.location,
      start: { dateTime: event.startsAt, timeZone: tz },
      end: { dateTime: event.endsAt, timeZone: tz },
    };
  }
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Google event aanmaken mislukt.');
  const allDay = Boolean(payload.start?.date && !payload.start?.dateTime);
  const allDayRange = allDay ? normalizeAllDayEventRange(payload.start?.date, payload.end?.date) : null;
  return {
    id: `${source.id}:${String(payload.id)}`,
    provider: 'google' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: String(payload.id),
    title: String(payload.summary || event.title),
    description: payload.description ? String(payload.description) : event.description,
    location: payload.location ? String(payload.location) : event.location,
    starts_at: allDayRange ? allDayRange.starts_at : String(payload.start.dateTime),
    ends_at: allDayRange ? allDayRange.ends_at : String(payload.end.dateTime),
    all_day: allDay,
    html_link: payload.htmlLink ? String(payload.htmlLink) : null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

async function createMicrosoftEvent(accessToken: string, source: CalendarSourceRow, event: ReturnType<typeof normalizeNewEventInput>) {
  let start: { dateTime: string; timeZone: string };
  let end: { dateTime: string; timeZone: string };
  if (event.allDay) {
    // Microsoft Graph: all-day events also use exclusive end dates.
    // dateTime should be midnight UTC, timeZone: 'UTC'.
    const startDate = event.startsAt.slice(0, 10);
    const endDateRaw = event.endsAt.slice(0, 10);
    const endExclusive = endDateRaw <= startDate ? nextDay(startDate) : nextDay(endDateRaw);
    start = { dateTime: `${startDate}T00:00:00`, timeZone: 'UTC' };
    end = { dateTime: `${endExclusive}T00:00:00`, timeZone: 'UTC' };
  } else {
    start = { dateTime: toMicrosoftDateTime(event.startsAt), timeZone: 'UTC' };
    end = { dateTime: toMicrosoftDateTime(event.endsAt), timeZone: 'UTC' };
  }
  const body = {
    subject: event.title,
    body: { contentType: 'HTML', content: event.description || '' },
    location: event.location ? { displayName: event.location } : undefined,
    isAllDay: event.allDay,
    start,
    end,
  };
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(source.provider_calendar_id)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft event aanmaken mislukt.');
  const location = (payload.location ?? {}) as Record<string, string>;
  const allDay = Boolean(payload.isAllDay);
  const allDayRange = allDay ? normalizeAllDayEventRange(payload.start?.dateTime || event.startsAt, payload.end?.dateTime || event.endsAt) : null;
  return {
    id: `${source.id}:${String(payload.id)}`,
    provider: 'microsoft' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: String(payload.id),
    title: String(payload.subject || event.title),
    description: payload.bodyPreview ? String(payload.bodyPreview) : event.description,
    location: location.displayName ? String(location.displayName) : event.location,
    starts_at: allDayRange ? allDayRange.starts_at : normalizeMicrosoftDateTime(payload.start?.dateTime || event.startsAt),
    ends_at: allDayRange ? allDayRange.ends_at : normalizeMicrosoftDateTime(payload.end?.dateTime || event.endsAt),
    all_day: allDay,
    html_link: payload.webLink ? String(payload.webLink) : null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

function assertIso(value: string, field: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`Ongeldige datum voor ${field}.`);
  return date.toISOString();
}

// ============================================================
// Native (eigen ResoFly) agenda's + agenda-items
// ============================================================

type NativeEventRow = {
  id: string;
  organization_id: string;
  source_id: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  timezone: string | null;
  rrule: string | null;
  exdate: string[] | null;
  recurs: boolean;
  sequence: number;
};

const NATIVE_DEFAULT_TZ = 'Europe/Amsterdam';
const NATIVE_DEFAULT_COLOR = '#2563eb';

async function createNativeCalendar(organizationId: string, userId: string, body: Record<string, unknown>): Promise<CalendarSourceRow> {
  const name = (String(body.name || '').trim() || 'Mijn agenda').slice(0, 120);
  const color = body.color ? String(body.color) : NATIVE_DEFAULT_COLOR;
  const visibility: CalendarVisibility = body.visibility === 'organization' ? 'organization' : 'private';
  const { data, error } = await supabaseAdmin.from('calendar_sources').insert({
    organization_id: organizationId,
    user_id: userId,
    connection_id: null,
    provider: 'native',
    provider_calendar_id: crypto.randomUUID(),
    name,
    color,
    timezone: NATIVE_DEFAULT_TZ,
    is_primary: false,
    access_role: 'owner',
    sync_enabled: true,
    write_enabled: true,
    visibility,
  }).select('*').single();
  if (error) throw error;
  return data as CalendarSourceRow;
}

async function updateNativeCalendar(organizationId: string, userId: string, body: Record<string, unknown>): Promise<CalendarSourceRow> {
  const source = await getOwnedNativeSource(organizationId, userId, String(body.sourceId || ''));
  const patch: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
  if (body.color !== undefined) patch.color = body.color ? String(body.color) : null;
  if (body.visibility === 'private' || body.visibility === 'organization') patch.visibility = body.visibility;
  if (typeof body.sync_enabled === 'boolean') patch.sync_enabled = body.sync_enabled;
  if (Object.keys(patch).length === 0) throw new Error('Geen geldige agenda-wijziging aangeleverd.');
  const { data, error } = await supabaseAdmin.from('calendar_sources').update(patch).eq('id', source.id).select('*').single();
  if (error || !data) throw new Error('Agenda kon niet worden bijgewerkt.');
  return data as CalendarSourceRow;
}

async function deleteNativeCalendar(organizationId: string, userId: string, sourceId: string): Promise<void> {
  const source = await getOwnedNativeSource(organizationId, userId, sourceId);
  const { error } = await supabaseAdmin.from('calendar_sources').delete().eq('id', source.id).eq('provider', 'native');
  if (error) throw error;
}

async function getOwnedNativeSource(organizationId: string, requesterUserId: string, sourceId: string): Promise<CalendarSourceRow> {
  if (!UUID_RE.test(sourceId)) throw new Error('Ongeldige agenda.');
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).eq('provider', 'native').single();
  if (error || !data) throw new Error('ResoFly-agenda niet gevonden.');
  const source = data as CalendarSourceRow;
  if (source.user_id !== requesterUserId) throw new Error('Alleen de eigenaar kan deze agenda aanpassen.');
  return source;
}

async function getWritableNativeSource(organizationId: string, requesterUserId: string, sourceId: string): Promise<CalendarSourceRow> {
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
  if (error || !data) throw new Error('Agenda-bron niet gevonden.');
  const source = data as CalendarSourceRow;
  if (source.provider !== 'native') throw new Error('Alleen items in een ResoFly-agenda kunnen hier bewerkt worden.');
  if (source.user_id !== requesterUserId && source.visibility !== 'organization') {
    throw new Error('Deze privé-agenda is niet met de organisatie gedeeld.');
  }
  return source;
}

async function createNativeEvent(organizationId: string, userId: string, source: CalendarSourceRow, input: Record<string, unknown>) {
  const event = normalizeNewEventInput(input);
  const rrule = normalizeRrule(input);
  const { data, error } = await supabaseAdmin.from('calendar_events').insert({
    organization_id: organizationId,
    source_id: source.id,
    created_by: userId,
    uid: `resofly-${crypto.randomUUID()}`,
    title: event.title,
    description: event.description,
    location: event.location,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    all_day: event.allDay,
    timezone: source.timezone,
    rrule,
    recurs: rrule !== null,
  }).select('*').single();
  if (error) throw error;
  return nativeRowToBaseEvent(data as NativeEventRow, source);
}

async function updateNativeEvent(organizationId: string, requesterUserId: string, input: Record<string, unknown>) {
  const eventId = String(input.eventId || input.id || '');
  if (!UUID_RE.test(eventId)) throw new Error('Ongeldig agenda-item.');
  const { data: row, error } = await supabaseAdmin.from('calendar_events').select('*').eq('organization_id', organizationId).eq('id', eventId).is('deleted_at', null).single();
  if (error || !row) throw new Error('Agenda-item niet gevonden.');
  const current = row as NativeEventRow;
  const source = await getWritableNativeSource(organizationId, requesterUserId, current.source_id);
  const event = normalizeNewEventInput(input);
  const rrule = normalizeRrule(input);
  const { data: updated, error: updateError } = await supabaseAdmin.from('calendar_events').update({
    title: event.title,
    description: event.description,
    location: event.location,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    all_day: event.allDay,
    rrule,
    recurs: rrule !== null,
    exdate: null,
    sequence: (current.sequence ?? 0) + 1,
  }).eq('id', current.id).select('*').single();
  if (updateError || !updated) throw new Error('Agenda-item kon niet worden bijgewerkt.');
  return nativeRowToBaseEvent(updated as NativeEventRow, source);
}

async function deleteNativeEvent(organizationId: string, requesterUserId: string, eventId: string): Promise<void> {
  if (!UUID_RE.test(eventId)) throw new Error('Ongeldig agenda-item.');
  const { data: row, error } = await supabaseAdmin.from('calendar_events').select('*').eq('organization_id', organizationId).eq('id', eventId).single();
  if (error || !row) throw new Error('Agenda-item niet gevonden.');
  const current = row as NativeEventRow;
  await getWritableNativeSource(organizationId, requesterUserId, current.source_id);
  // Soft-delete: blijft als tombstone staan voor de latere CalDAV sync-collection.
  const { error: deleteError } = await supabaseAdmin.from('calendar_events')
    .update({ deleted_at: new Date().toISOString(), sequence: (current.sequence ?? 0) + 1 })
    .eq('id', current.id);
  if (deleteError) throw deleteError;
}

async function fetchNativeEvents(organizationId: string, source: CalendarSourceRow, startIso: string, endIso: string) {
  const [{ data: singles, error: singleError }, { data: recurringRows, error: recurringError }] = await Promise.all([
    supabaseAdmin.from('calendar_events').select('*')
      .eq('organization_id', organizationId).eq('source_id', source.id).is('deleted_at', null).eq('recurs', false)
      .lt('starts_at', endIso).gte('ends_at', startIso),
    supabaseAdmin.from('calendar_events').select('*')
      .eq('organization_id', organizationId).eq('source_id', source.id).is('deleted_at', null).eq('recurs', true),
  ]);
  if (singleError) throw singleError;
  if (recurringError) throw recurringError;
  const out: Record<string, unknown>[] = [];
  for (const row of (singles ?? []) as NativeEventRow[]) out.push(nativeRowToBaseEvent(row, source));
  for (const row of (recurringRows ?? []) as NativeEventRow[]) out.push(...expandRecurringNativeRow(row, source, startIso, endIso));
  return out;
}

function nativeRowToBaseEvent(row: NativeEventRow, source: CalendarSourceRow): Record<string, unknown> {
  return {
    id: `${source.id}:${row.uid}`,
    provider: 'native' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: row.uid,
    native_event_id: row.id,
    title: row.title || '(Geen titel)',
    description: row.description ?? null,
    location: row.location ?? null,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    all_day: row.all_day,
    rrule: row.rrule ?? null,
    recurs: row.recurs,
    html_link: null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

// Eenvoudige herhaling-uitvouwing voor fase 0 (FREQ DAILY/WEEKLY/MONTHLY +
// INTERVAL/UNTIL/COUNT + EXDATE). Volledige RRULE-afhandeling (BYDAY etc.) volgt
// met ical.js in de CalDAV-Worker.
function expandRecurringNativeRow(row: NativeEventRow, source: CalendarSourceRow, startIso: string, endIso: string): Record<string, unknown>[] {
  const base = nativeRowToBaseEvent(row, source);
  const rule = parseSimpleRrule(row.rrule);
  if (!rule) return [base];
  const durationMs = new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime();
  const winStart = new Date(startIso).getTime();
  const winEnd = new Date(endIso).getTime();
  const until = rule.until ? new Date(rule.until).getTime() : null;
  const exdates = new Set((row.exdate ?? []).map(value => new Date(value).getTime()));
  const out: Record<string, unknown>[] = [];
  let cursor = new Date(row.starts_at);
  let count = 0;
  for (let i = 0; i < 800; i++) {
    const startMs = cursor.getTime();
    if (until !== null && startMs > until) break;
    if (rule.count && count >= rule.count) break;
    if (startMs > winEnd) break;
    const endMs = startMs + durationMs;
    if (endMs >= winStart && !exdates.has(startMs)) {
      out.push({
        ...base,
        id: `${source.id}:${row.uid}:${startMs}`,
        starts_at: new Date(startMs).toISOString(),
        ends_at: new Date(endMs).toISOString(),
      });
    }
    count += 1;
    cursor = advanceRecurrence(cursor, rule.freq, rule.interval);
  }
  return out;
}

type SimpleRrule = { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'; interval: number; until: string | null; count: number | null };

function parseSimpleRrule(rrule: string | null): SimpleRrule | null {
  if (!rrule) return null;
  const parts = new Map<string, string>();
  for (const segment of rrule.split(';')) {
    const [key, value] = segment.split('=');
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim());
  }
  const freqRaw = parts.get('FREQ');
  if (freqRaw !== 'DAILY' && freqRaw !== 'WEEKLY' && freqRaw !== 'MONTHLY') return null;
  const interval = Math.max(1, parseInt(parts.get('INTERVAL') || '1', 10) || 1);
  const untilRaw = parts.get('UNTIL');
  const countRaw = parts.get('COUNT');
  return {
    freq: freqRaw,
    interval,
    until: untilRaw ? rruleUntilToIso(untilRaw) : null,
    count: countRaw ? (parseInt(countRaw, 10) || null) : null,
  };
}

function advanceRecurrence(date: Date, freq: 'DAILY' | 'WEEKLY' | 'MONTHLY', interval: number): Date {
  const next = new Date(date.getTime());
  if (freq === 'DAILY') next.setUTCDate(next.getUTCDate() + interval);
  else if (freq === 'WEEKLY') next.setUTCDate(next.getUTCDate() + 7 * interval);
  else next.setUTCMonth(next.getUTCMonth() + interval);
  return next;
}

// RRULE UNTIL "YYYYMMDDTHHMMSSZ" (of "YYYYMMDD") → ISO.
function rruleUntilToIso(value: string): string | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!m) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
  }
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +(hh ?? 0), +(mm ?? 0), +(ss ?? 0))).toISOString();
}

function isoToRruleUntil(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

// Bouwt een RRULE-string uit een vrij RRULE-veld óf een eenvoudig
// {freq, interval, until, count}-object dat de frontend stuurt.
function normalizeRrule(input: Record<string, unknown>): string | null {
  const raw = input.rrule;
  if (typeof raw === 'string' && raw.trim()) {
    return parseSimpleRrule(raw.trim()) ? raw.trim().toUpperCase() : null;
  }
  const rec = input.recurrence;
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Record<string, unknown>;
  const freqMap: Record<string, string> = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' };
  const freq = freqMap[String(r.freq || '').toLowerCase()];
  if (!freq) return null;
  const parts = [`FREQ=${freq}`];
  const interval = Number(r.interval);
  if (Number.isInteger(interval) && interval > 1) parts.push(`INTERVAL=${interval}`);
  if (r.until) {
    const until = new Date(String(r.until));
    if (!Number.isNaN(until.getTime())) parts.push(`UNTIL=${isoToRruleUntil(until)}`);
  }
  const count = Number(r.count);
  if (Number.isInteger(count) && count > 0) parts.push(`COUNT=${count}`);
  return parts.join(';');
}

// ============================================================
// App-wachtwoorden (CalDAV) — beheer vanuit de app
// ============================================================

async function createAppPassword(organizationId: string, userId: string, body: Record<string, unknown>) {
  const label = (String(body.label || '').trim() || 'Apparaat').slice(0, 80);
  const secret = generateAppPasswordToken();
  const salt = generateSalt();
  const password_hash = await hashAppPassword(secret, salt);
  const { data, error } = await supabaseAdmin.from('calendar_app_passwords').insert({
    organization_id: organizationId,
    user_id: userId,
    label,
    password_hash,
    salt,
  }).select('id,label,created_at,last_used_at,revoked_at').single();
  if (error) throw error;
  // secret wordt EENMALIG teruggegeven en nergens bewaard.
  return { appPassword: data, secret };
}

async function listAppPasswords(organizationId: string, userId: string) {
  const { data, error } = await supabaseAdmin.from('calendar_app_passwords')
    .select('id,label,created_at,last_used_at,revoked_at')
    .eq('organization_id', organizationId).eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

async function revokeAppPassword(organizationId: string, userId: string, appPasswordId: string): Promise<void> {
  if (!UUID_RE.test(appPasswordId)) throw new Error('Ongeldig app-wachtwoord.');
  const { error } = await supabaseAdmin.from('calendar_app_passwords')
    .update({ revoked_at: new Date().toISOString() })
    .eq('organization_id', organizationId).eq('user_id', userId).eq('id', appPasswordId).is('revoked_at', null);
  if (error) throw error;
}

function normalizeMicrosoftDateTime(value: string): string {
  if (!value) return new Date().toISOString();
  return value.endsWith('Z') ? value : `${value}Z`;
}

function toMicrosoftDateTime(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, '');
}

async function signState(state: OAuthState): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(state)));
  const signature = await hmac(payload, STATE_SECRET);
  return `${payload}.${signature}`;
}

async function verifyState(raw: string): Promise<OAuthState> {
  if (!raw || raw.length > OAUTH_STATE_MAX_LENGTH) throw new Error('Ongeldige OAuth state lengte.');

  const parts = raw.split('.');
  if (parts.length !== 2) throw new Error('Ongeldig OAuth state formaat.');
  const [payload, signature] = parts;
  if (!payload || !signature) throw new Error('Ongeldig OAuth state formaat.');

  const expected = await hmac(payload, STATE_SECRET);
  if (!timingSafeEqual(signature, expected)) throw new Error('Ongeldige OAuth state handtekening.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  } catch {
    throw new Error('OAuth state payload is ongeldig.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('OAuth state payload ontbreekt.');
  const candidate = parsed as Partial<OAuthState>;

  const provider = parseProvider(candidate.provider);
  const userId = assertUuid(candidate.userId, 'OAuth user');
  const organizationId = assertUuid(candidate.organizationId, 'OAuth organisatie');
  const returnTo = sanitizeReturnTo(String(candidate.returnTo || ''));
  const nonce = assertOAuthNonce(candidate.nonce);
  const iat = assertUnixTimestamp(candidate.iat, 'OAuth state issued-at');
  const exp = assertUnixTimestamp(candidate.exp, 'OAuth state expiration');

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) throw new Error('OAuth state is verlopen.');
  if (iat > now + OAUTH_STATE_CLOCK_SKEW_SECONDS) throw new Error('OAuth state ligt te ver in de toekomst.');
  if (exp <= iat) throw new Error('OAuth state tijdvenster is ongeldig.');
  if (exp - iat > OAUTH_STATE_TTL_SECONDS + OAUTH_STATE_CLOCK_SKEW_SECONDS) {
    throw new Error('OAuth state is te lang geldig.');
  }

  return { provider, userId, organizationId, returnTo, nonce, iat, exp };
}

function assertUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(`${label} is ongeldig.`);
  return value;
}

function assertOAuthNonce(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error('OAuth nonce is ongeldig.');
  return value;
}

function assertUnixTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} is ongeldig.`);
  }
  return value;
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64UrlEncode(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function encryptionKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(TOKEN_ENCRYPTION_KEY));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
}

async function decrypt(value: string): Promise<string> {
  const [ivRaw, dataRaw] = value.split('.');
  if (!ivRaw || !dataRaw) throw new Error('Token decryptieformaat is ongeldig.');
  const key = await encryptionKey();
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlDecode(ivRaw) }, key, base64UrlDecode(dataRaw));
  return new TextDecoder().decode(decrypted);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
