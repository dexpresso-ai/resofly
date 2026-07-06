import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { generateAppPasswordToken, generateSalt, hashAppPassword } from '../_shared/appPassword.ts';
import {
  type Provider,
  type CalendarVisibility,
  type OrganizationRole,
  type CalendarSourceRow,
  type ConnectionRow,
  type TokenRow,
  type NativeEventRow,
  requiredEnv,
  supabaseAdmin,
  UUID_RE,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  MICROSOFT_TENANT_ID,
  googleScopes,
  microsoftScopes,
  parseScope,
  getConnection,
  getToken,
  refreshAccessToken,
  encrypt,
  decrypt,
  base64UrlEncode,
  base64UrlDecode,
  sourceCanWrite,
  normalizeRrule,
} from '../_shared/calendarCore.ts';
import { listEvents, nativeRowToBaseEvent } from '../_shared/calendarAvailability.ts';
import {
  createEvent,
  getEventAttendees,
  normalizeNewEventInput,
  getExternalWriteAccessToken,
  buildGoogleEventBody,
  googleWriteQuery,
  googleEventToBaseEvent,
  buildMicrosoftEventBody,
  microsoftEventToBaseEvent,
  applyAttendees,
  sendEventCancellations,
} from '../_shared/calendarEventWrite.ts';
import { cancelConflictingBookingSlots, cancelConflictingBookingSlotsForNativeEvent } from '../_shared/meetingBookingSync.ts';

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

const CALENDAR_REDIRECT_URL = requiredEnv('CALENDAR_REDIRECT_URL');
const STATE_SECRET = requiredEnv('CALENDAR_OAUTH_STATE_SECRET');
const ALLOWED_RETURN_ORIGINS = (Deno.env.get('CALENDAR_ALLOWED_RETURN_ORIGINS') || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_STATE_MAX_LENGTH = 4096;
const OAUTH_STATE_CLOCK_SKEW_SECONDS = 60;

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
      case 'updateEvent': requireWrite(); return json({ ok: true, event: await updateEvent(organizationId, user.id, body.event || {}) });
      case 'deleteEvent': requireWrite(); await deleteEvent(organizationId, user.id, body); return json({ ok: true });
      case 'createNativeCalendar': requireWrite(); return json({ ok: true, source: await createNativeCalendar(organizationId, user.id, body) });
      case 'updateNativeCalendar': requireWrite(); return json({ ok: true, source: await updateNativeCalendar(organizationId, user.id, body) });
      case 'deleteNativeCalendar': requireWrite(); await deleteNativeCalendar(organizationId, user.id, String(body.sourceId || '')); return json({ ok: true });
      case 'createAppPassword': return json({ ok: true, ...(await createAppPassword(organizationId, user.id, body)) });
      case 'listAppPasswords': return json({ ok: true, appPasswords: await listAppPasswords(organizationId, user.id) });
      case 'revokeAppPassword': await revokeAppPassword(organizationId, user.id, String(body.appPasswordId || '')); return json({ ok: true });
      case 'getEventAttendees': return json({ ok: true, attendees: await getEventAttendees(organizationId, user.id, String(body.eventId || '')) });
      case 'searchContacts': return json({ ok: true, ...(await searchContacts(organizationId, user.id, String(body.sourceId || ''), String(body.query || ''))) });
      default: return json({ ok: false, error: `Onbekende calendar action: ${action}` }, 400);
    }
  } catch (error) {
    console.error('calendar-integrations error', error);
    return json({ ok: false, error: error instanceof Error ? error.message : 'Onbekende calendar-integrations fout.' }, 500);
  }
});

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

/* ── Contacten opzoeken (Google People / Microsoft Graph) ──────────────── */

/**
 * Zoekt contacten in het adresboek van de agenda-provider. App-eigen contacten
 * (klanten/leveranciers) worden client-side uit de al geladen data gefilterd;
 * deze functie levert alleen de provider-contacten. Ontbreekt de contacten-scope
 * (gebruiker heeft nog met de oude rechten gekoppeld), dan komt needsReconnect terug.
 */
async function searchContacts(organizationId: string, requesterUserId: string, sourceId: string, query: string): Promise<{ contacts: Array<{ name: string | null; email: string }>; needsReconnect: boolean }> {
  const q = query.trim();
  if (q.length < 2 || !sourceId) return { contacts: [], needsReconnect: false };
  const { data: source } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
  if (!source) return { contacts: [], needsReconnect: false };
  const calendarSource = source as CalendarSourceRow;
  if (calendarSource.provider === 'native' || !calendarSource.connection_id) return { contacts: [], needsReconnect: false };
  if (calendarSource.user_id !== requesterUserId && calendarSource.visibility !== 'organization') return { contacts: [], needsReconnect: false };
  const connection = await getConnection(organizationId, calendarSource.connection_id);
  if (connection.status !== 'active') return { contacts: [], needsReconnect: true };
  try {
    const token = await getToken(organizationId, connection.id);
    const accessToken = await refreshAccessToken(token);
    const contacts = calendarSource.provider === 'google'
      ? await googleSearchContacts(accessToken, q)
      : await microsoftSearchContacts(accessToken, q);
    return { contacts, needsReconnect: false };
  } catch (err) {
    // 401/403 = onvoldoende rechten → opnieuw koppelen; overige fouten: leeg teruggeven.
    const msg = err instanceof Error ? err.message : '';
    if (/\b(401|403)\b|insufficient|scope|permission/i.test(msg)) return { contacts: [], needsReconnect: true };
    console.error('searchContacts', err);
    return { contacts: [], needsReconnect: false };
  }
}

function dedupeContacts(rows: Array<{ name: string | null; email: string }>): Array<{ name: string | null; email: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string | null; email: string }> = [];
  for (const r of rows) {
    const email = r.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ name: r.name?.trim() || null, email });
  }
  return out.slice(0, 20);
}

async function googleSearchContacts(accessToken: string, query: string): Promise<Array<{ name: string | null; email: string }>> {
  const readMask = 'names,emailAddresses';
  const headers = { Authorization: `Bearer ${accessToken}` };
  // Zowel opgeslagen contacten als "other contacts" (mensen die je gemaild hebt) doorzoeken.
  const [main, other] = await Promise.all([
    fetch(`https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(query)}&pageSize=15&readMask=${readMask}`, { headers }),
    fetch(`https://people.googleapis.com/v1/otherContacts:search?query=${encodeURIComponent(query)}&pageSize=15&readMask=${readMask}`, { headers }),
  ]);
  if (main.status === 401 || main.status === 403) throw new Error(`Google contacts ${main.status}`);
  const rows: Array<{ name: string | null; email: string }> = [];
  for (const res of [main, other]) {
    if (!res.ok) continue;
    const payload = await res.json().catch(() => ({}));
    for (const r of (payload.results ?? []) as Record<string, unknown>[]) {
      const person = (r.person ?? {}) as Record<string, unknown>;
      const name = ((person.names ?? []) as Record<string, string>[])[0]?.displayName ?? null;
      for (const e of (person.emailAddresses ?? []) as Record<string, string>[]) {
        if (e.value) rows.push({ name, email: e.value });
      }
    }
  }
  return dedupeContacts(rows);
}

async function microsoftSearchContacts(accessToken: string, query: string): Promise<Array<{ name: string | null; email: string }>> {
  // /me/people = relevantie-gerangschikt (contacten + directory + recente mail).
  const url = `https://graph.microsoft.com/v1.0/me/people?$search=${encodeURIComponent(`"${query}"`)}&$top=15&$select=displayName,scoredEmailAddresses,personType`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401 || res.status === 403) throw new Error(`Microsoft people ${res.status}`);
  if (!res.ok) return [];
  const payload = await res.json().catch(() => ({}));
  const rows: Array<{ name: string | null; email: string }> = [];
  for (const p of (payload.value ?? []) as Record<string, unknown>[]) {
    const name = p.displayName ? String(p.displayName) : null;
    for (const e of (p.scoredEmailAddresses ?? []) as Record<string, string>[]) {
      if (e.address) rows.push({ name, email: e.address });
    }
  }
  return dedupeContacts(rows);
}

/* ── Bewerken/verwijderen van externe (Google/Microsoft) agenda-items ──── */

async function updateExternalEvent(organizationId: string, requesterUserId: string, source: CalendarSourceRow, input: Record<string, unknown>) {
  const providerEventId = String(input.providerEventId || input.eventId || '');
  if (!providerEventId) throw new Error('Onbekend agenda-item.');
  const accessToken = await getExternalWriteAccessToken(organizationId, requesterUserId, source);
  const event = normalizeNewEventInput(input);
  return source.provider === 'google'
    ? await updateGoogleEvent(accessToken, source, providerEventId, event)
    : await updateMicrosoftEvent(accessToken, source, providerEventId, event);
}

async function deleteExternalEvent(organizationId: string, requesterUserId: string, source: CalendarSourceRow, providerEventId: string): Promise<void> {
  if (!providerEventId) throw new Error('Onbekend agenda-item.');
  const accessToken = await getExternalWriteAccessToken(organizationId, requesterUserId, source);
  const url = source.provider === 'google'
    // sendUpdates=all zodat Google een afzegging naar de genodigden mailt.
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events/${encodeURIComponent(providerEventId)}?sendUpdates=all`
    : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(providerEventId)}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  // 200/204 = verwijderd; 404/410 = al weg → idempotent toelaten.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error?.message || 'Agenda-item verwijderen mislukt.');
  }
}

async function updateGoogleEvent(accessToken: string, source: CalendarSourceRow, eventId: string, event: ReturnType<typeof normalizeNewEventInput>) {
  const body = buildGoogleEventBody(source, event);
  const query = googleWriteQuery(event);
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events/${encodeURIComponent(eventId)}${query}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Google event bijwerken mislukt.');
  return googleEventToBaseEvent(payload, source, event);
}

async function updateMicrosoftEvent(accessToken: string, source: CalendarSourceRow, eventId: string, event: ReturnType<typeof normalizeNewEventInput>) {
  const body = buildMicrosoftEventBody(event);
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft event bijwerken mislukt.');
  return microsoftEventToBaseEvent(payload, source, event);
}

// ============================================================
// Native (eigen ResoFly) agenda's + agenda-items
// ============================================================

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

/** Routeert een bewerk-actie naar de juiste provider op basis van de agenda-bron. */
async function updateEvent(organizationId: string, requesterUserId: string, input: Record<string, unknown>) {
  const sourceId = String(input.sourceId || '');
  if (sourceId) {
    const { data: source } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
    if (source && (source as CalendarSourceRow).provider !== 'native') {
      const result = await updateExternalEvent(organizationId, requesterUserId, source as CalendarSourceRow, input);
      // Verplaatsen/herschalen kan een afspraak alsnog over een openstaande
      // boekingsoptie leggen. Google/Microsoft ondersteunen hier geen herhaling.
      await cancelConflictingBookingSlots(organizationId, String(result.source_id ?? ''), String(result.starts_at ?? ''), String(result.ends_at ?? ''));
      return result;
    }
  }
  // updateNativeEvent regelt zelf de boekingsoptie-reconciliatie (incl. herhalingen).
  return await updateNativeEvent(organizationId, requesterUserId, input);
}

/** Routeert een verwijder-actie naar de juiste provider op basis van de agenda-bron. */
async function deleteEvent(organizationId: string, requesterUserId: string, body: Record<string, unknown>): Promise<void> {
  const sourceId = String(body.sourceId || '');
  if (sourceId) {
    const { data: source } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
    if (source && (source as CalendarSourceRow).provider !== 'native') {
      await deleteExternalEvent(organizationId, requesterUserId, source as CalendarSourceRow, String(body.providerEventId || ''));
      return;
    }
  }
  await deleteNativeEvent(organizationId, requesterUserId, String(body.eventId || ''));
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
    meeting_url: event.meetingUrl,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    all_day: event.allDay,
    rrule,
    recurs: rrule !== null,
    exdate: null,
    // Wis de canonieke iCalendar-tekst: een wijziging vanuit de app moet door de
    // CalDAV-Worker opnieuw gegenereerd worden uit de bijgewerkte velden.
    icalendar_raw: null,
    sequence: (current.sequence ?? 0) + 1,
  }).eq('id', current.id).select('*').single();
  if (updateError || !updated) throw new Error('Agenda-item kon niet worden bijgewerkt.');
  const updatedRow = updated as NativeEventRow;
  await applyAttendees(organizationId, source, updatedRow, input).catch(err => console.error('invite (update) failed', err));
  // Verplaatsen/herschalen (slepen, tijd bewerken) kan een (mogelijk herhalende)
  // afspraak alsnog over een openstaande boekingsoptie leggen.
  await cancelConflictingBookingSlotsForNativeEvent(organizationId, source, updatedRow);
  return nativeRowToBaseEvent(updatedRow, source);
}

async function deleteNativeEvent(organizationId: string, requesterUserId: string, eventId: string): Promise<void> {
  if (!UUID_RE.test(eventId)) throw new Error('Ongeldig agenda-item.');
  const { data: row, error } = await supabaseAdmin.from('calendar_events').select('*').eq('organization_id', organizationId).eq('id', eventId).single();
  if (error || !row) throw new Error('Agenda-item niet gevonden.');
  const current = row as NativeEventRow;
  const source = await getWritableNativeSource(organizationId, requesterUserId, current.source_id);
  // Soft-delete: blijft als tombstone staan voor de latere CalDAV sync-collection.
  const { error: deleteError } = await supabaseAdmin.from('calendar_events')
    .update({ deleted_at: new Date().toISOString(), sequence: (current.sequence ?? 0) + 1 })
    .eq('id', current.id);
  if (deleteError) throw deleteError;
  await sendEventCancellations(organizationId, source, current).catch(err => console.error('invite (cancel) failed', err));
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

// ============================================================
// OAuth-state (HMAC-ondertekend, korte TTL)
// ============================================================

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
