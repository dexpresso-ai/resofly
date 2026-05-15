import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

type Provider = 'google' | 'microsoft';
type CalendarVisibility = 'private' | 'organization';
type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type CalendarSourceRow = {
  id: string;
  organization_id: string;
  user_id: string;
  connection_id: string;
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
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
  const state = await signState({ provider, userId, organizationId, returnTo, nonce: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 });

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
  const state = await verifyState(stateRaw);

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
  const { data: source, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).eq('write_enabled', true).single();
  if (error || !source) throw new Error('Schrijfbare agenda-bron niet gevonden.');
  const calendarSource = source as CalendarSourceRow;
  if (calendarSource.user_id !== requesterUserId && calendarSource.visibility !== 'organization') {
    throw new Error('Deze privé-agenda is niet met de organisatie gedeeld.');
  }
  if (!sourceCanWrite(calendarSource)) {
    throw new Error('Deze externe agenda is niet schrijfbaar volgens de provider.');
  }
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
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) throw new Error('Ongeldig OAuth state formaat.');
  const expected = await hmac(payload, STATE_SECRET);
  if (!timingSafeEqual(signature, expected)) throw new Error('Ongeldige OAuth state handtekening.');
  const state = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as OAuthState;
  if (!state.exp || state.exp < Math.floor(Date.now() / 1000)) throw new Error('OAuth state is verlopen.');
  state.provider = parseProvider(state.provider);
  state.returnTo = sanitizeReturnTo(state.returnTo);
  return state;
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
