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
  sourceCanWrite,
  ProviderHttpError,
  CalendarTokenError,
} from '../_shared/calendarCore.ts';
import {
  type CalendarOAuthProvider,
  OAUTH_STATE_TTL_SECONDS,
  buildAuthorizeUrl,
  checkOAuthState,
  classifyProviderError,
  fallbackReturnTo,
  hasMeetingScope,
  missingCalendarCapabilities,
  parseReturnOrigins,
  providerLabel,
  sanitizeReturnTo,
  signOAuthState,
  timingSafeEqual,
  withReturnParams,
} from '../_shared/calendarOAuth.ts';
import { listEvents } from '../_shared/calendarAvailability.ts';
import { syncIcsSource, syncDueIcsSubscriptions, assertSafeFeedUrl } from '../_shared/icsSubscription.ts';
import {
  createEvent,
  getEventAttendees,
  getExternalWriteAccessToken,
  getWritableNativeSource,
  sendEventCancellations,
  updateExternalEvent,
  updateNativeEvent,
} from '../_shared/calendarEventWrite.ts';
import { VideoUnavailableError, googleCalendarConferenceTypes, isVideoService, microsoftCalendarConferenceTypes } from '../_shared/conference.ts';
import { createStandaloneMeeting, videoServiceStatus } from '../_shared/onlineMeetings.ts';
import { cancelConflictingBookingSlots } from '../_shared/meetingBookingSync.ts';
import { getModuleLevel } from '../_shared/edgeAuth.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const CALENDAR_REDIRECT_URL = requiredEnv('CALENDAR_REDIRECT_URL');
const STATE_SECRET = requiredEnv('CALENDAR_OAUTH_STATE_SECRET');
// Genormaliseerd tot origins: "https://app.resofly.nl/" telde eerst niet als
// "https://app.resofly.nl" en gaf dan "Return URL origin niet toegestaan".
const ALLOWED_RETURN_ORIGINS = parseReturnOrigins(Deno.env.get('CALENDAR_ALLOWED_RETURN_ORIGINS'));

// Cron-secret voor het periodiek verversen van ICS-abonnementen (x-cron-secret).
const ICS_CRON_SECRET = Deno.env.get('CALENDAR_ICS_CRON_SECRET') || '';
// Bronnen die langer dan dit niet ververst zijn, pakt de cron op (net onder een uur).
const ICS_REFRESH_AGE_MINUTES = 55;

serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  try {
    // Cron-endpoint: ververs vervallen ICS-abonnementen. Geen gebruiker-JWT, maar
    // een gedeeld secret (net als de campaigns-/herinnering-cron). Vóór requireUser.
    const cron = new URL(req.url).searchParams.get('cron');
    if (cron) {
      if (cron !== 'ics') return json({ ok: false, error: `Onbekende cron: ${cron}` }, 400);
      if (!ICS_CRON_SECRET || !timingSafeEqual(req.headers.get('x-cron-secret') || '', ICS_CRON_SECRET)) {
        return json({ ok: false, error: 'Ongeldig of ontbrekend cron-secret.' }, 401);
      }
      return json({ ok: true, ...(await syncDueIcsSubscriptions(ICS_REFRESH_AGE_MINUTES)) });
    }

    if (req.method === 'GET') return await handleOAuthCallback(req);
    if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(user.id, organizationId);
    // Service-role omzeilt RLS: modulerechten hier expliciet controleren.
    const calendarLevel = await getModuleLevel(supabaseAdmin, user.id, organizationId, 'calendar');
    if (calendarLevel === 'none') throw new CalendarHttpError('Je hebt geen toegang tot de module Agenda in deze organisatie.', 403);
    const requireWrite = () => {
      requireRole(role, ['owner', 'admin', 'member'], 'Deze agenda-actie vereist schrijfrechten binnen de organisatie.');
      if (calendarLevel !== 'write') throw new CalendarHttpError('Je mag niets wijzigen in de module Agenda van deze organisatie.', 403);
    };

    switch (action) {
      case 'oauthStart': requireWrite(); return json({ ok: true, authUrl: await startOAuth(user.id, organizationId, body) });
      case 'oauthComplete': return json({ ok: true, ...(await completeOAuth(user.id, body)) });
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
      case 'createIcsSubscription': requireWrite(); return json({ ok: true, ...(await createIcsSubscription(organizationId, user.id, body)) });
      case 'refreshIcsSubscription': requireWrite(); return json({ ok: true, ...(await refreshIcsSubscriptionAction(organizationId, user.id, String(body.sourceId || ''))) });
      case 'updateIcsSubscription': requireWrite(); return json({ ok: true, source: await updateIcsSubscription(organizationId, user.id, body) });
      case 'deleteIcsSubscription': requireWrite(); await deleteIcsSubscription(organizationId, user.id, String(body.sourceId || '')); return json({ ok: true });
      case 'createAppPassword': return json({ ok: true, ...(await createAppPassword(organizationId, user.id, body)) });
      case 'listAppPasswords': return json({ ok: true, appPasswords: await listAppPasswords(organizationId, user.id) });
      case 'revokeAppPassword': await revokeAppPassword(organizationId, user.id, String(body.appPasswordId || '')); return json({ ok: true });
      case 'getEventAttendees': return json({ ok: true, attendees: await getEventAttendees(organizationId, user.id, String(body.eventId || '')) });
      case 'searchContacts': return json({ ok: true, ...(await searchContacts(organizationId, user.id, String(body.sourceId || ''), String(body.query || ''))) });
      // Kan ik hier een losse Meet/Teams maken? Alleen over de eigen koppelingen.
      case 'videoServices': return json({ ok: true, videoServices: await videoServiceStatus(organizationId, user.id) });
      case 'createMeeting': requireWrite(); return json({ ok: true, ...(await createMeeting(organizationId, user.id, body)) });
      default: return json({ ok: false, error: `Onbekende calendar action: ${action}` }, 400);
    }
  } catch (error) {
    const status = errorStatus(error);
    if (status >= 500) console.error('calendar-integrations error', error);
    else console.warn('calendar-integrations weigert', status, error instanceof Error ? error.message : error);
    // Een databasefout (geen Error, maar een PostgREST-object) blijft binnen: de tekst daarvan is niet voor de gebruiker.
    return json({ ok: false, error: error instanceof Error ? error.message : 'Er ging iets mis in de agenda-koppeling. Probeer het opnieuw.' }, status);
  }
});

/** Een weigering met een eigen HTTP-status (niet ingelogd, geen toegang). */
class CalendarHttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CalendarHttpError';
    this.status = status;
  }
}

/**
 * Elke fout gaf eerst status 500. Daardoor stond elke gewone weigering als
 * crash in de logs, en las de app (supabase.functions.invoke) de uitleg niet:
 * de gebruiker zag "Edge Function returned a non-2xx status code".
 */
function errorStatus(error: unknown): number {
  if (error instanceof CalendarHttpError) return error.status;
  if (error instanceof VideoUnavailableError) return error.status;
  if (error instanceof CalendarTokenError) return error.failure === 'tijdelijk' ? 503 : 409;
  if (error instanceof ProviderHttpError) return 502;
  // Onze eigen, Nederlandse meldingen: de vraag klopt niet of mag niet.
  if (error instanceof Error && error.name === 'Error') return 400;
  return 500;
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
  if (!token) throw new CalendarHttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new CalendarHttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}

async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!UUID_RE.test(organizationId)) {
    throw new CalendarHttpError('Ongeldige organisatie.', 400);
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
  if (!role) throw new CalendarHttpError('Geen toegang tot deze organisatie.', 403);
  return role;
}

function requireRole(role: OrganizationRole, allowed: OrganizationRole[], message: string): void {
  if (!allowed.includes(role)) throw new CalendarHttpError(message, 403);
}

async function startOAuth(userId: string, organizationId: string, body: Record<string, unknown>): Promise<string> {
  const provider = parseProvider(body.provider);
  assertProviderConfigured(provider);
  const returnTo = sanitizeReturnTo(body.returnTo, ALLOWED_RETURN_ORIGINS);
  // "Google Meet / Teams aanzetten" vraagt het extra recht. Ook bij gewoon
  // opnieuw koppelen van een account dat het al had: Microsoft geeft in het
  // nieuwe token alleen wat gevraagd is, en dan stond Teams daarna stil uit.
  const meetings = body.meetings === true || await accountHasMeetingScope(userId, organizationId, provider, body.loginHint);
  const now = Math.floor(Date.now() / 1000);
  const state = await signOAuthState({
    provider,
    userId,
    organizationId,
    returnTo,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + OAUTH_STATE_TTL_SECONDS,
    ...(meetings ? { meetings: true } : {}),
  }, STATE_SECRET);
  return buildAuthorizeUrl({
    provider,
    clientId: provider === 'google' ? GOOGLE_CLIENT_ID : MICROSOFT_CLIENT_ID,
    redirectUri: CALENDAR_REDIRECT_URL,
    state,
    microsoftTenant: MICROSOFT_TENANT_ID,
    // Bij "opnieuw koppelen" het bekende adres, zodat het juiste account klaarstaat.
    loginHint: body.loginHint,
    meetings,
  });
}

/** Had de eigen koppeling met dit adres het Meet/Teams-recht al? */
async function accountHasMeetingScope(userId: string, organizationId: string, provider: CalendarOAuthProvider, loginHint: unknown): Promise<boolean> {
  const email = typeof loginHint === 'string' ? loginHint.trim().toLowerCase() : '';
  if (!email || email.length > 254) return false;
  const { data } = await supabaseAdmin.from('calendar_connections').select('provider_account_email, scopes')
    .eq('organization_id', organizationId).eq('user_id', userId).eq('provider', provider);
  return ((data ?? []) as Array<{ provider_account_email: string | null; scopes: string[] | null }>)
    .some(c => String(c.provider_account_email ?? '').toLowerCase() === email && hasMeetingScope(provider, c.scopes));
}

async function handleOAuthCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const stateRaw = url.searchParams.get('state');
  const check = await checkOAuthState(stateRaw, STATE_SECRET, ALLOWED_RETURN_ORIGINS);

  if (!check.ok && check.reason === 'ongeldig') {
    // Niet van ons (of geknoeid): het terugkeeradres erin is dan niet te
    // vertrouwen. Wel terug naar de app zelf, met uitleg, in plaats van een
    // kale JSON-foutpagina op het adres van Supabase.
    console.warn('calendar OAuth callback: ongeldige state');
    const fallback = fallbackReturnTo(ALLOWED_RETURN_ORIGINS);
    if (fallback) return redirectTo(withReturnParams(fallback, { calendar_error: 'ongeldig' }));
    return json({ ok: false, error: 'Deze koppellink klopt niet (meer). Start het koppelen opnieuw vanuit ResoFly.' }, 400);
  }

  const state = check.state;
  const providerError = url.searchParams.get('error');
  if (providerError) {
    // Alleen een vaste code naar de app; de tekst van de provider blijft in het log.
    console.warn('calendar OAuth callback: provider meldt een fout', state.provider, providerError, url.searchParams.get('error_description'));
    const code = classifyProviderError(providerError, url.searchParams.get('error_description'), url.searchParams.get('error_subcode'));
    return redirectTo(withReturnParams(state.returnTo, { calendar_error: code, calendar_provider: state.provider }));
  }
  if (!check.ok) {
    return redirectTo(withReturnParams(state.returnTo, { calendar_error: 'verlopen', calendar_provider: state.provider }));
  }

  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) {
    return redirectTo(withReturnParams(state.returnTo, { calendar_error: 'mislukt', calendar_provider: state.provider }));
  }

  // De code hier NIET zelf inwisselen. Deze callback heeft geen sessie: wie de
  // toestemmingslink volgt, is niet per se wie de koppeling startte. Zo kon
  // iemand zijn eigen koppellink naar een collega of klant sturen, en kwam na
  // diens "toestaan" diens agenda (en contacten) in het account van de
  // afzender terecht. De app rondt daarom af (oauthComplete), met het JWT van
  // wie er is ingelogd; dat moet dezelfde gebruiker zijn als in de state.
  // returnTo is een adres van de app zelf (sanitizeReturnTo).
  return redirectTo(withReturnParams(state.returnTo, { calendar_code: code, calendar_state: stateRaw ?? '' }));
}

/** Rondt de koppeling af vanuit de app: alleen voor wie de koppeling startte. */
async function completeOAuth(userId: string, body: Record<string, unknown>): Promise<{ provider: Provider; organizationId: string; account: string | null; warning?: string; meetings?: boolean }> {
  const code = String(body.code || '');
  if (!code || code.length > 4096) throw new Error('De code van Google of Microsoft ontbreekt. Start het koppelen opnieuw.');
  const check = await checkOAuthState(body.state, STATE_SECRET, ALLOWED_RETURN_ORIGINS);
  if (!check.ok) {
    throw new Error(check.reason === 'verlopen'
      ? 'Het koppelen duurde te lang. Start het opnieuw vanuit Instellingen → Agenda.'
      : 'Deze koppellink klopt niet (meer). Start het koppelen opnieuw vanuit Instellingen → Agenda.');
  }
  const state = check.state;
  if (state.userId !== userId) {
    throw new CalendarHttpError('Deze agendakoppeling is gestart door een ander account. Start de koppeling opnieuw vanuit je eigen werkruimte.', 403);
  }
  const role = await requireOrganizationAccess(userId, state.organizationId);
  requireRole(role, ['owner', 'admin', 'member'], 'Deze agenda-actie vereist schrijfrechten binnen de organisatie.');
  if (await getModuleLevel(supabaseAdmin, userId, state.organizationId, 'calendar') !== 'write') {
    throw new CalendarHttpError('Je mag niets wijzigen in de module Agenda van deze organisatie.', 403);
  }
  const token = await exchangeCode(state.provider, code);
  const accessToken = String(token.access_token || '');
  if (!accessToken) throw new Error(`${providerLabel(state.provider)} gaf geen toegang terug. Start het koppelen opnieuw.`);

  // Google laat losse vinkjes uitzetten. Zonder agendarechten heeft een
  // koppeling geen zin: eerlijk zeggen wat er mist, in plaats van een koppeling
  // die bij elk ophalen "insufficient authentication scopes" geeft.
  const granted = parseScope(token.scope, []);
  if (granted.length && missingCalendarCapabilities(state.provider, granted).length) {
    throw new Error(state.provider === 'google'
      ? 'Je gaf Google geen toegang tot je agenda. Koppel opnieuw en laat bij Google de vinkjes voor je agenda\'s en afspraken aan staan.'
      : 'Microsoft gaf geen toegang tot je agenda. Koppel opnieuw en sta de rechten voor je agenda toe; lukt dat niet, vraag dan de beheerder van je Microsoft-account om ResoFly goed te keuren.');
  }

  const account = await fetchAccountProfile(state.provider, accessToken);
  const connection = await upsertConnection(userId, state.organizationId, state.provider, account, token);
  await upsertTokens(connection, token);
  // Gevraagd om Meet/Teams, maar dat vinkje stond bij Google uit (of Microsoft
  // gaf het recht niet): de koppeling staat, en dat zeggen we erbij.
  const meetingWarning = state.meetings && !hasMeetingScope(state.provider, connection.scopes)
    ? (state.provider === 'google'
      ? 'Gekoppeld, maar zonder Google Meet: dat vinkje stond bij Google uit. Zet het opnieuw aan als je Meet ook buiten je Google-agenda wilt gebruiken.'
      : 'Gekoppeld, maar Microsoft gaf geen toestemming voor Teams-vergaderingen. Dat kan alleen met een werk- of schoolaccount van Microsoft 365; soms moet je beheerder het eerst goedkeuren.')
    : undefined;
  // Meet/Teams kan nu ook buiten de agenda om (de app zegt het erbij).
  const meetingsOn = state.meetings === true && hasMeetingScope(state.provider, connection.scopes) ? { meetings: true } : {};
  try {
    await syncSourcesForConnection(connection);
  } catch (err) {
    // De koppeling zelf staat; alleen de lijst met agenda's kwam nog niet. Eerst
    // gaf dit een foutmelding, terwijl de koppeling er wel was (zonder agenda's).
    console.error('calendar sources sync na koppelen mislukt', err);
    const detail = err instanceof Error ? err.message : 'onbekende fout';
    const warning = `Gekoppeld, maar de lijst met agenda's ophalen lukte nog niet (${detail}). Probeer het straks met "Agenda's ophalen".`;
    await supabaseAdmin.from('calendar_connections').update({ status: 'error', last_error: warning })
      .eq('id', connection.id).eq('organization_id', connection.organization_id);
    return { provider: state.provider, organizationId: state.organizationId, account: account.email, warning: meetingWarning ? `${warning} ${meetingWarning}` : warning, ...meetingsOn };
  }
  return { provider: state.provider, organizationId: state.organizationId, account: account.email, ...(meetingWarning ? { warning: meetingWarning } : {}), ...meetingsOn };
}

function redirectTo(location: string): Response {
  // no-store: in deze redirect staat een eenmalige code; die hoort in geen enkele cache.
  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function parseProvider(value: unknown): CalendarOAuthProvider {
  if (value === 'google' || value === 'microsoft') return value;
  throw new Error('Ongeldige agenda-provider.');
}

function assertProviderConfigured(provider: Provider) {
  if (provider === 'google' && (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET)) throw new Error('Google Agenda is op deze omgeving nog niet ingesteld (OAuth-gegevens ontbreken).');
  if (provider === 'microsoft' && (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET)) throw new Error('Microsoft Agenda is op deze omgeving nog niet ingesteld (OAuth-gegevens ontbreken).');
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
  if (!res.ok) {
    console.warn('calendar code exchange mislukt', provider, res.status, payload.error, payload.error_description);
    if (payload.error === 'invalid_grant') {
      throw new Error('Deze toestemming is al gebruikt of verlopen. Start het koppelen opnieuw vanuit Instellingen → Agenda.');
    }
    throw new Error(`${providerLabel(provider)} gaf geen toegang terug${payload.error ? ` (${String(payload.error).slice(0, 60)})` : ''}. Probeer het opnieuw; blijft het misgaan, laat de beheerder van ResoFly de koppeling nakijken.`);
  }
  return payload;
}

async function fetchAccountProfile(provider: Provider, accessToken: string): Promise<{ id: string; email: string | null; name: string | null }> {
  const endpoint = provider === 'google' ? 'https://www.googleapis.com/oauth2/v3/userinfo' : 'https://graph.microsoft.com/v1.0/me';
  const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || `${providerLabel(provider)}-profiel ophalen mislukt.`);
  const id = provider === 'google' ? payload.sub : payload.id;
  // Zonder vast account-id kan de koppeling niet goed (her)kend worden; eerst
  // werd het dan de tekst "undefined", en kwam elk volgend account erbovenop.
  if (!id) throw new Error(`${providerLabel(provider)} gaf geen account terug. Start het koppelen opnieuw.`);
  if (provider === 'google') return { id: String(id), email: payload.email ?? null, name: payload.name ?? null };
  return { id: String(id), email: payload.mail || payload.userPrincipalName || null, name: payload.displayName ?? null };
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

async function listIntegrations(organizationId: string, requesterUserId: string): Promise<{ connections: ConnectionRow[]; sources: CalendarSourceRow[]; videoServices: Awaited<ReturnType<typeof videoServiceStatus>> }> {
  const [{ data: connections, error: cError }, { data: sources, error: sError }, videoServices] = await Promise.all([
    supabaseAdmin.from('calendar_connections').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false }),
    supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).order('name', { ascending: true }),
    // Of de aanvrager zelf een losse Meet/Teams kan maken: alleen zijn eigen koppelingen.
    videoServiceStatus(organizationId, requesterUserId),
  ]);
  if (cError) throw cError;
  if (sError) throw sError;

  const visibleSources = ((sources ?? []) as CalendarSourceRow[])
    .filter(source => source.user_id === requesterUserId || source.visibility === 'organization')
    // De feed-URL van een ICS-abonnement is vaak een geheim token (bv. Google's
    // "geheime iCal-adres"). Deel die niet met andere leden van een gedeelde agenda.
    .map(source => source.provider === 'ics' && source.user_id !== requesterUserId
      ? { ...source, feed_url: null }
      : source);
  const visibleConnectionIds = new Set(visibleSources.map(source => source.connection_id));
  const visibleConnections = ((connections ?? []) as ConnectionRow[])
    .filter(connection => connection.user_id === requesterUserId || visibleConnectionIds.has(connection.id))
    .map(connection => sanitizeConnectionForRequester(connection, requesterUserId));

  return { connections: visibleConnections, sources: visibleSources, videoServices };
}

/**
 * Een losse Meet- of Teams-vergadering, nu (de teamchat: "Nu vergaderen"). Met
 * de eigen koppeling van de aanvrager; zie onlineMeetings.ts.
 */
async function createMeeting(organizationId: string, requesterUserId: string, body: Record<string, unknown>): Promise<{ url: string; service: string; account: string | null }> {
  const service = body.service;
  if (!isVideoService(service)) throw new Error('Kies Google Meet of Teams.');
  const title = typeof body.title === 'string' ? body.title.slice(0, 255) : null;
  const startsAt = typeof body.startsAt === 'string' ? body.startsAt : null;
  const endsAt = typeof body.endsAt === 'string' ? body.endsAt : null;
  const meeting = await createStandaloneMeeting(organizationId, requesterUserId, service, { title, startsAt, endsAt });
  return { url: meeting.url, service, account: meeting.account };
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
  if (!UUID_RE.test(connectionId)) throw new Error('Ongeldige agenda-koppeling.');
  const connection = await getConnection(organizationId, connectionId);
  if (connection.user_id !== requesterUserId) throw new Error('Alleen de eigenaar kan deze agenda-koppeling verversen.');
  await syncSourcesForConnection(connection);
  return await listIntegrations(organizationId, requesterUserId);
}

type ProviderCalendar = {
  provider_calendar_id: string;
  name: string;
  description: string | null;
  color: string | null;
  timezone: string | null;
  is_primary: boolean;
  access_role: string | null;
  /** Staat hij bij de provider zelf "aan"? Bepaalt alleen of een nieuwe agenda hier meteen getoond wordt. */
  shown: boolean;
  /** Welke videovergadering de agenda zelf maakt (conference.ts); null = de provider zei er niets over. */
  conference_types: string[] | null;
};

/**
 * Haalt de agendalijst van het account op en zet hem naast wat er al staat.
 *
 * - Nieuw: getoond als hij bij Google ook aan staat (het vinkje in Google
 *   Agenda); de hoofdagenda meteen schrijfbaar als de provider dat toelaat.
 *   Eerst stond na het koppelen alles aan (ook "Feestdagen" en "Verjaardagen")
 *   en niets schrijfbaar, zodat "Nieuwe afspraak" geen agenda had om in te zetten.
 * - Bestaand: alleen naam, kleur en rol bijwerken; wat de gebruiker hier zelf
 *   aan- of uitzette blijft staan. Mag schrijven bij de provider niet meer,
 *   dan gaat "Schrijven" hier ook uit.
 * - Weg bij de provider: hier ook weg. Alleen als de lijst compleet binnen is en
 *   niet leeg (elk account heeft een hoofdagenda), zodat een haperende
 *   provider nooit de agenda's wist. Uren uit die afspraken blijven bestaan
 *   (migratie 20261106140000_agenda_uren_bewaren).
 */
async function syncSourcesForConnection(connection: ConnectionRow) {
  const token = await getToken(connection.organization_id, connection.id);
  const accessToken = await refreshAccessToken(token);
  const { calendars, complete } = connection.provider === 'google'
    ? await fetchGoogleSources(accessToken)
    : await fetchMicrosoftSources(accessToken);

  const { data: existingRows, error: loadError } = await supabaseAdmin.from('calendar_sources')
    .select('id, provider_calendar_id, write_enabled')
    .eq('organization_id', connection.organization_id)
    .eq('connection_id', connection.id);
  if (loadError) throw loadError;
  const existing = new Map((existingRows ?? []).map((row: { id: string; provider_calendar_id: string; write_enabled: boolean }) => [row.provider_calendar_id, row]));

  for (const calendar of calendars) {
    const meta = {
      name: calendar.name,
      description: calendar.description,
      color: calendar.color,
      timezone: calendar.timezone,
      is_primary: calendar.is_primary,
      access_role: calendar.access_role,
      conference_types: calendar.conference_types,
    };
    const writable = sourceCanWrite({ provider: connection.provider, access_role: calendar.access_role } as CalendarSourceRow);
    const current = existing.get(calendar.provider_calendar_id);
    if (current) {
      const patch: Record<string, unknown> = { ...meta };
      if (current.write_enabled && !writable) patch.write_enabled = false;
      const { error } = await supabaseAdmin.from('calendar_sources').update(patch)
        .eq('id', current.id).eq('organization_id', connection.organization_id);
      if (error) throw error;
      continue;
    }
    // ignoreDuplicates: twee keer snel achter elkaar ophalen mag niet op een unieke sleutel stuklopen.
    const { error } = await supabaseAdmin.from('calendar_sources').upsert({
      organization_id: connection.organization_id,
      user_id: connection.user_id,
      connection_id: connection.id,
      provider: connection.provider,
      provider_calendar_id: calendar.provider_calendar_id,
      ...meta,
      sync_enabled: calendar.shown || calendar.is_primary,
      write_enabled: calendar.is_primary && writable,
      visibility: 'private',
    }, { onConflict: 'connection_id,provider_calendar_id', ignoreDuplicates: true });
    if (error) throw error;
  }

  if (complete && calendars.length > 0) {
    const present = new Set(calendars.map(calendar => calendar.provider_calendar_id));
    const gone = (existingRows ?? [])
      .filter((row: { provider_calendar_id: string }) => !present.has(row.provider_calendar_id))
      .map((row: { id: string }) => row.id);
    if (gone.length) {
      const { error } = await supabaseAdmin.from('calendar_sources').delete()
        .in('id', gone).eq('organization_id', connection.organization_id).eq('connection_id', connection.id);
      if (error) throw error;
    }
  }
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const MAX_LIST_PAGES = 10;

async function fetchGoogleSources(accessToken: string): Promise<{ calendars: ProviderCalendar[]; complete: boolean }> {
  const calendars: ProviderCalendar[] = [];
  let pageToken = '';
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    // showHidden: een agenda die je in Google uit de lijst verborg, bestaat nog.
    // Zonder deze vlag zou hij hier als "verdwenen" gelden.
    const params = new URLSearchParams({ minAccessRole: 'freeBusyReader', showDeleted: 'false', showHidden: 'true', maxResults: '250' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderHttpError(res.status, payload.error?.message || 'Google agenda’s ophalen mislukt.');
    for (const item of (payload.items ?? []) as Record<string, unknown>[]) {
      calendars.push({
        provider_calendar_id: String(item.id),
        name: String(item.summaryOverride || item.summary || 'Naamloze Google agenda').slice(0, 200),
        description: item.description ? String(item.description).slice(0, 2000) : null,
        color: typeof item.backgroundColor === 'string' && HEX_COLOR_RE.test(item.backgroundColor) ? item.backgroundColor : null,
        timezone: item.timeZone ? String(item.timeZone) : null,
        is_primary: Boolean(item.primary),
        access_role: item.accessRole ? String(item.accessRole) : null,
        shown: Boolean(item.selected) && !item.hidden,
        conference_types: googleCalendarConferenceTypes(item),
      });
    }
    pageToken = payload.nextPageToken ? String(payload.nextPageToken) : '';
    if (!pageToken) return { calendars, complete: true };
  }
  return { calendars, complete: false };
}

async function fetchMicrosoftSources(accessToken: string): Promise<{ calendars: ProviderCalendar[]; complete: boolean }> {
  const calendars: ProviderCalendar[] = [];
  // Zonder $top gaf Graph er tien per keer, en volgden we geen tweede pagina:
  // de elfde agenda kwam nooit in de lijst.
  let url: string | null = 'https://graph.microsoft.com/v1.0/me/calendars?$top=100&$select=id,name,color,hexColor,canEdit,isDefaultCalendar,owner,allowedOnlineMeetingProviders';
  for (let page = 0; url && page < MAX_LIST_PAGES; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new ProviderHttpError(res.status, payload.error?.message || 'Microsoft agenda’s ophalen mislukt.');
    for (const item of (payload.value ?? []) as Record<string, unknown>[]) {
      calendars.push({
        provider_calendar_id: String(item.id),
        name: String(item.name || 'Naamloze Microsoft agenda').slice(0, 200),
        description: null,
        // `color` is een naam ("lightBlue", "auto"); de echte kleur staat in hexColor.
        color: typeof item.hexColor === 'string' && HEX_COLOR_RE.test(item.hexColor) ? item.hexColor : null,
        timezone: null,
        is_primary: Boolean(item.isDefaultCalendar),
        access_role: item.canEdit ? 'writer' : 'reader',
        shown: true,
        conference_types: microsoftCalendarConferenceTypes(item),
      });
    }
    const next = payload['@odata.nextLink'];
    // Alleen een vervolglink bij Graph zelf volgen: ons token gaat erachteraan.
    url = typeof next === 'string' && next.startsWith('https://graph.microsoft.com/') ? next : null;
    if (!url) return { calendars, complete: true };
  }
  return { calendars, complete: false };
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
  if (!UUID_RE.test(connectionId)) throw new Error('Ongeldige agenda-koppeling.');
  const connection = await getConnection(organizationId, connectionId);
  if (connection.user_id !== requesterUserId) throw new Error('Alleen de eigenaar kan deze agenda-koppeling loskoppelen.');
  const token = await getToken(organizationId, connection.id).catch(() => null);
  if (token && connection.provider === 'google' && !(await grantInUseElsewhere(connection))) await revokeBestEffort(connection.provider, token);
  const { error } = await supabaseAdmin.from('calendar_connections').delete().eq('id', connection.id).eq('organization_id', organizationId).eq('user_id', requesterUserId);
  if (error) throw error;
}

/**
 * Gebruikt een andere koppeling in ResoFly nog hetzelfde Google-account? Google
 * trekt bij het intrekken van één token de hele toestemming in, voor alle tokens
 * van die gebruiker bij onze app. Wie hetzelfde account in twee organisaties had
 * gekoppeld en het in één loskoppelde, zag het in de andere stil stoppen.
 *
 * Bewust over organisaties heen: het is alleen een ja/nee, er gaat niets terug
 * naar de gebruiker, en het voorkomt dat een handeling hier een koppeling in
 * een andere organisatie breekt.
 */
async function grantInUseElsewhere(connection: ConnectionRow): Promise<boolean> {
  const { count, error } = await supabaseAdmin.from('calendar_connections')
    .select('id', { count: 'exact', head: true })
    .eq('provider', connection.provider)
    .eq('provider_account_id', connection.provider_account_id)
    .neq('id', connection.id)
    .neq('status', 'revoked');
  if (error) return true; // bij twijfel niet intrekken: loskoppelen hier gaat toch door
  return (count ?? 0) > 0;
}

async function revokeBestEffort(provider: Provider, token: TokenRow) {
  try {
    if (provider === 'google') {
      // Het vernieuwtoken intrekken, niet het toegangstoken: dat laatste is na
      // een uur al verlopen, en dan bleef de toestemming bij Google gewoon staan.
      // In de body, niet in de URL: tokens horen niet in logregels.
      const value = await decrypt(token.refresh_token_encrypted ?? token.access_token_encrypted);
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: value }),
      });
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
  // Het adresboek is persoonlijk: ook als iemand zijn agenda met het team deelt,
  // doorzoekt een collega niet met diens Google-/Microsoft-token zijn contacten.
  if (calendarSource.user_id !== requesterUserId) return { contacts: [], needsReconnect: false };
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

// ── Agenda's via link (iCal/ICS-abonnementen) ──────────────────────────────
const ICS_DEFAULT_COLOR = '#0891b2';

/** Voegt een read-only ICS-abonnement toe en haalt de feed meteen één keer op. */
async function createIcsSubscription(organizationId: string, userId: string, body: Record<string, unknown>): Promise<{ source: CalendarSourceRow; count: number; warning?: string }> {
  const feedUrl = await assertSafeFeedUrl(String(body.url ?? body.feedUrl ?? ''));
  const name = (String(body.name || '').trim() || 'Externe agenda').slice(0, 120);
  const color = body.color ? String(body.color) : ICS_DEFAULT_COLOR;
  const visibility: CalendarVisibility = body.visibility === 'organization' ? 'organization' : 'private';
  const { data, error } = await supabaseAdmin.from('calendar_sources').insert({
    organization_id: organizationId,
    user_id: userId,
    connection_id: null,
    provider: 'ics',
    provider_calendar_id: crypto.randomUUID(),
    name,
    color,
    timezone: null,
    is_primary: false,
    access_role: 'reader',
    sync_enabled: true,
    write_enabled: false,
    visibility,
    feed_url: feedUrl,
  }).select('*').single();
  if (error) throw error;
  const source = data as CalendarSourceRow;
  // Meteen ophalen zodat de agenda direct gevuld is. Mislukt dat (onbereikbare
  // link, geen geldige iCal), dan blijft de bron staan mét foutmelding zodat de
  // gebruiker de link kan corrigeren of later 'Ververs nu' kan proberen.
  try {
    const result = await syncIcsSource(source, { force: true });
    return { source, count: result.count };
  } catch (err) {
    return { source, count: 0, warning: err instanceof Error ? err.message : 'De agenda kon nog niet worden opgehaald.' };
  }
}

/** Ververst één ICS-abonnement direct ("Ververs nu"). */
async function refreshIcsSubscriptionAction(organizationId: string, userId: string, sourceId: string): Promise<{ source: CalendarSourceRow; count: number }> {
  const source = await getOwnedIcsSource(organizationId, userId, sourceId);
  const result = await syncIcsSource(source, { force: true });
  const { data } = await supabaseAdmin.from('calendar_sources').select('*').eq('id', source.id).single();
  return { source: (data as CalendarSourceRow) ?? source, count: result.count };
}

/** Wijzigt naam/kleur/zichtbaarheid/sync of de feed-URL van een ICS-abonnement. */
async function updateIcsSubscription(organizationId: string, userId: string, body: Record<string, unknown>): Promise<CalendarSourceRow> {
  const source = await getOwnedIcsSource(organizationId, userId, String(body.sourceId || ''));
  const patch: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
  if (body.color !== undefined) patch.color = body.color ? String(body.color) : null;
  if (body.visibility === 'private' || body.visibility === 'organization') patch.visibility = body.visibility;
  if (typeof body.sync_enabled === 'boolean') patch.sync_enabled = body.sync_enabled;
  let urlChanged = false;
  if (typeof body.url === 'string' && body.url.trim()) {
    patch.feed_url = await assertSafeFeedUrl(body.url);
    patch.feed_etag = null;
    patch.feed_content_hash = null; // forceer verse ophaal bij een nieuwe URL
    urlChanged = true;
  }
  if (Object.keys(patch).length === 0) throw new Error('Geen geldige wijziging aangeleverd.');
  const { data, error } = await supabaseAdmin.from('calendar_sources').update(patch).eq('id', source.id).eq('provider', 'ics').select('*').single();
  if (error || !data) throw new Error('Agenda-abonnement kon niet worden bijgewerkt.');
  const updated = data as CalendarSourceRow;
  if (urlChanged) { try { await syncIcsSource(updated, { force: true }); } catch { /* fout staat al op de bron */ } }
  return updated;
}

/** Verwijdert een ICS-abonnement (calendar_events cascaden mee via FK). */
async function deleteIcsSubscription(organizationId: string, userId: string, sourceId: string): Promise<void> {
  const source = await getOwnedIcsSource(organizationId, userId, sourceId);
  const { error } = await supabaseAdmin.from('calendar_sources').delete().eq('id', source.id).eq('provider', 'ics');
  if (error) throw error;
}

async function getOwnedIcsSource(organizationId: string, requesterUserId: string, sourceId: string): Promise<CalendarSourceRow> {
  if (!UUID_RE.test(sourceId)) throw new Error('Ongeldige agenda.');
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).eq('provider', 'ics').single();
  if (error || !data) throw new Error('Agenda-abonnement niet gevonden.');
  const source = data as CalendarSourceRow;
  if (source.user_id !== requesterUserId) throw new Error('Alleen de eigenaar kan dit agenda-abonnement aanpassen.');
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
