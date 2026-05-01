import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

type OrganizationRole = 'owner' | 'admin' | 'member' | 'viewer';
type BillingProfile = {
  id: string;
  organization_id: string;
  plan_key: string;
  included_seats: number;
  purchased_seats: number;
  licensed_seats: number;
  payment_status: string;
  mollie_connect_status: string;
  mollie_connect_account_id: string | null;
  mollie_customer_id: string | null;
  mollie_mandate_id: string | null;
  mollie_subscription_id: string | null;
  subscription_status: string;
  last_payment_status: string | null;
  next_invoice_date: string | null;
  trial_ends_at: string | null;
  current_period_ends_at: string | null;
};
type BillingPlan = {
  plan_key: string;
  name: string;
  included_seats: number | null;
  monthly_price_cents: number;
  extra_seat_price_cents: number;
  currency: string;
  is_custom?: boolean;
  is_active: boolean;
};
type MollieConnection = {
  id: string;
  organization_id: string;
  billing_profile_id: string | null;
  status: 'pending' | 'connected' | 'mock_connected' | 'error' | 'revoked';
  mollie_organization_id: string | null;
  token_type: string;
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  scopes: string[] | null;
  expires_at: string | null;
  last_refreshed_at: string | null;
  last_error: string | null;
  refresh_token_version: number;
  metadata: Record<string, unknown> | null;
};
type OAuthState = {
  organizationId: string;
  userId: string;
  returnTo: string;
  nonce: string;
  exp: number;
};

type CheckoutKind = 'extra_seat' | 'plan_change';

type CheckoutResult = {
  paymentId: string;
  providerPaymentId: string;
  checkoutUrl: string;
  mock: boolean;
  paymentType: CheckoutKind;
  reused?: boolean;
};

type LocalPaymentRecord = {
  id: string;
  organization_id: string;
  billing_profile_id: string | null;
  payment_type: CheckoutKind;
  provider: string;
  provider_payment_id: string | null;
  provider_checkout_url: string | null;
  idempotency_key: string | null;
  status: string;
  amount_cents: number;
  currency: string;
  plan_key: string | null;
  license_delta: number;
  seats_before: number | null;
  seats_after: number | null;
  checkout_expires_at: string | null;
  metadata: Record<string, unknown> | null;
};

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const MOLLIE_CONNECT_CLIENT_ID = Deno.env.get('MOLLIE_CONNECT_CLIENT_ID') || '';
const MOLLIE_CONNECT_CLIENT_SECRET = Deno.env.get('MOLLIE_CONNECT_CLIENT_SECRET') || '';
const MOLLIE_CONNECT_REDIRECT_URL = Deno.env.get('MOLLIE_CONNECT_REDIRECT_URL') || '';
const MOLLIE_WEBHOOK_URL = Deno.env.get('MOLLIE_WEBHOOK_URL') || '';
const MOLLIE_WEBHOOK_SECRET = Deno.env.get('MOLLIE_WEBHOOK_SECRET') || '';
const MOLLIE_ALLOW_MOCK = (Deno.env.get('MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
const ALLOWED_RETURN_ORIGINS = (Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const CHECKOUT_TTL_MINUTES = 30;
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

class BillingHttpError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BillingHttpError';
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return json(req, { ok: true });
  try {
    if (req.method === 'GET') return await handleMollieConnectCallback(req);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method not allowed' }, 405);

    const url = new URL(req.url);
    const contentType = req.headers.get('content-type') || '';

    if (url.searchParams.get('webhook') === 'mollie') {
      const body = await parseBody(req, contentType);
      return await handleMollieWebhook(req, url, body);
    }

    assertAllowedRequestOrigin(req);
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(user.id, organizationId);
    requireRole(role, ['owner', 'admin'], 'Alleen owners/admins mogen billing-acties uitvoeren.');

    switch (action) {
      case 'connectStart': return json(req, { ok: true, ...(await startMollieConnect(user.id, organizationId, body)) });
      case 'createExtraSeatCheckout': return json(req, { ok: true, ...(await createExtraSeatCheckout(user.id, organizationId, Number(body.quantity || 1), String(body.returnUrl || ''), String(body.idempotencyKey || ''))) });
      case 'createPlanChangeCheckout': return json(req, { ok: true, ...(await createPlanChangeCheckout(user.id, organizationId, String(body.planKey || ''), String(body.returnUrl || ''), String(body.idempotencyKey || ''))) });
      case 'markMockPaymentPaid': return json(req, { ok: true, payment: await markMockPaymentPaid(organizationId, String(body.providerPaymentId || '')) });
      case 'refreshBilling': return json(req, { ok: true, overview: await loadBillingOverview(organizationId) });
      default: return json(req, { ok: false, error: `Onbekende billing action: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof BillingHttpError ? error.status : 500;
    const internalMessage = error instanceof Error ? error.message : 'Onbekende billing fout.';
    if (status >= 500) console.error('billing function error', internalMessage);
    const publicMessage = error instanceof BillingHttpError
      ? error.message
      : 'Billing-actie mislukt door een server- of providerfout. Controleer de Edge Function logs.';
    return json(req, { ok: false, error: publicMessage }, status);
  }
});

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('origin') || '';
  const allowOrigin = ALLOWED_RETURN_ORIGINS.includes(origin)
    ? origin
    : (MOLLIE_ALLOW_MOCK && ALLOWED_RETURN_ORIGINS.length === 0 ? '*' : 'null');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

function assertAllowedRequestOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (!origin || ALLOWED_RETURN_ORIGINS.length === 0) {
    if (MOLLIE_ALLOW_MOCK) return;
    throw new BillingHttpError('BILLING_ALLOWED_RETURN_ORIGINS is verplicht in productie en moet de frontend-origin bevatten.', 500);
  }
  if (!ALLOWED_RETURN_ORIGINS.includes(origin)) {
    throw new BillingHttpError('Deze frontend-origin is niet toegestaan voor billing-acties.', 403);
  }
}

function assertProductionBillingConfig(): void {
  if (MOLLIE_ALLOW_MOCK) return;
  const missing = [
    ['MOLLIE_CONNECT_CLIENT_ID', MOLLIE_CONNECT_CLIENT_ID],
    ['MOLLIE_CONNECT_CLIENT_SECRET', MOLLIE_CONNECT_CLIENT_SECRET],
    ['MOLLIE_CONNECT_REDIRECT_URL', MOLLIE_CONNECT_REDIRECT_URL],
    ['MOLLIE_WEBHOOK_URL', MOLLIE_WEBHOOK_URL],
    ['MOLLIE_WEBHOOK_SECRET', MOLLIE_WEBHOOK_SECRET],
    ['MOLLIE_OAUTH_STATE_SECRET', Deno.env.get('MOLLIE_OAUTH_STATE_SECRET') || ''],
    ['MOLLIE_TOKEN_ENCRYPTION_KEY', Deno.env.get('MOLLIE_TOKEN_ENCRYPTION_KEY') || ''],
    ['BILLING_ALLOWED_RETURN_ORIGINS', ALLOWED_RETURN_ORIGINS.join(',')],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    console.error('Billing productieconfiguratie mist verplichte serverinstellingen:', missing.map(([name]) => name).join(', '));
    throw new BillingHttpError('Billing productieconfiguratie is niet volledig. Controleer de vereiste server secrets en toegestane origins.', 500);
  }
}

async function parseBody(req: Request, contentType: string): Promise<Record<string, string>> {
  if (contentType.includes('application/json')) return await req.json().catch(() => ({}));
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

async function requireUser(req: Request): Promise<{ id: string; email?: string }> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw new BillingHttpError('Niet ingelogd: Authorization header ontbreekt.', 401);
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) throw new BillingHttpError('Niet ingelogd of ongeldig sessietoken.', 401);
  return { id: data.user.id, email: data.user.email || undefined };
}

async function requireOrganizationAccess(userId: string, organizationId: string): Promise<OrganizationRole> {
  if (!isUuid(organizationId)) throw new BillingHttpError('Ongeldige organisatie.', 400);
  const { data, error } = await supabaseAdmin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);
  if (error) throw error;
  const role = data?.[0]?.role as OrganizationRole | undefined;
  if (!role) throw new BillingHttpError('Geen toegang tot deze organisatie.', 403);
  return role;
}

function requireRole(role: OrganizationRole, allowed: OrganizationRole[], message: string): void {
  if (!allowed.includes(role)) throw new BillingHttpError(message, 403);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

async function loadBillingOverview(organizationId: string): Promise<unknown> {
  const profile = await ensureBillingProfile(organizationId);
  const plan = await getPlan(profile.plan_key);
  const usage = await getOrganizationSeatUsage(organizationId);

  return {
    organization_id: profile.organization_id,
    plan_key: profile.plan_key,
    plan_name: plan.name,
    included_seats: profile.included_seats,
    purchased_seats: profile.purchased_seats,
    licensed_seats: profile.licensed_seats,
    active_members: usage.activeMembers,
    pending_invitations: usage.pendingInvitations,
    used_seats: usage.usedSeats,
    available_seats: Math.max(profile.licensed_seats - usage.usedSeats, 0),
    subscription_status: profile.subscription_status,
    payment_status: profile.payment_status,
    mollie_connect_status: profile.mollie_connect_status,
    mollie_customer_id: profile.mollie_customer_id,
    mollie_mandate_id: profile.mollie_mandate_id,
    mollie_subscription_id: profile.mollie_subscription_id,
    last_payment_status: profile.last_payment_status,
    next_invoice_date: profile.next_invoice_date,
    trial_ends_at: profile.trial_ends_at,
    current_period_ends_at: profile.current_period_ends_at,
    monthly_price_cents: plan.monthly_price_cents,
    extra_seat_price_cents: plan.extra_seat_price_cents,
    currency: plan.currency,
  };
}

async function getOrganizationSeatUsage(organizationId: string): Promise<{ activeMembers: number; pendingInvitations: number; usedSeats: number }> {
  const now = new Date().toISOString();
  const { count: activeMembers, error: activeError } = await supabaseAdmin
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active');
  if (activeError) throw activeError;

  const { count: pendingInvitations, error: pendingError } = await supabaseAdmin
    .from('organization_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .eq('consumes_license', true)
    .or(`expires_at.is.null,expires_at.gt.${now}`);
  if (pendingError) throw pendingError;

  const active = activeMembers ?? 0;
  const pending = pendingInvitations ?? 0;
  return { activeMembers: active, pendingInvitations: pending, usedSeats: active + pending };
}

async function ensureBillingProfile(organizationId: string): Promise<BillingProfile> {
  const { data, error } = await supabaseAdmin.rpc('ensure_organization_billing_profile', { p_organization_id: organizationId });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as BillingProfile;
}

async function getPlan(planKey: string): Promise<BillingPlan> {
  const { data, error } = await supabaseAdmin
    .from('billing_plans')
    .select('*')
    .eq('plan_key', planKey)
    .single();
  if (error) throw error;
  return data as BillingPlan;
}

async function startMollieConnect(userId: string, organizationId: string, body: Record<string, unknown>): Promise<{ authUrl?: string; mockConnected?: boolean }> {
  const profile = await ensureBillingProfile(organizationId);
  const returnTo = sanitizeReturnTo(String(body.returnTo || ''));

  if (MOLLIE_ALLOW_MOCK && (!MOLLIE_CONNECT_CLIENT_ID || !MOLLIE_CONNECT_CLIENT_SECRET || !MOLLIE_CONNECT_REDIRECT_URL)) {
    await markOrganizationMollieConnected({
      organizationId,
      profileId: profile.id,
      userId,
      accountId: `mock_org_${organizationId.slice(0, 8)}`,
      status: 'mock_connected',
      metadata: { mock: true },
    });
    return { mockConnected: true };
  }

  assertProductionBillingConfig();

  const state = await signState({ organizationId, userId, returnTo, nonce: crypto.randomUUID(), exp: Math.floor(Date.now() / 1000) + 600 });
  const params = new URLSearchParams({
    client_id: MOLLIE_CONNECT_CLIENT_ID,
    redirect_uri: MOLLIE_CONNECT_REDIRECT_URL,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'organizations.read payments.read payments.write customers.read customers.write mandates.read subscriptions.read subscriptions.write profiles.read',
    state,
  });

  await supabaseAdmin
    .from('organization_billing_profiles')
    .update({ mollie_connect_status: 'pending' })
    .eq('organization_id', organizationId);

  await supabaseAdmin
    .from('organization_mollie_connections')
    .upsert({
      organization_id: organizationId,
      billing_profile_id: profile.id,
      status: 'pending',
      connected_by: userId,
      last_error: null,
      metadata: { started_at: new Date().toISOString() },
    }, { onConflict: 'organization_id' });

  return { authUrl: `https://my.mollie.com/oauth2/authorize?${params.toString()}` };
}

async function handleMollieConnectCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const stateRaw = url.searchParams.get('state');
  if (!stateRaw) return json(req, { ok: false, error: 'OAuth state ontbreekt.' }, 400);
  const state = await verifyState(stateRaw);

  const error = url.searchParams.get('error');
  if (error) return redirectWithStatus(req, state.returnTo, { billing_error: url.searchParams.get('error_description') || error });

  const code = url.searchParams.get('code');
  if (!code) return redirectWithStatus(req, state.returnTo, { billing_error: 'OAuth code ontbreekt.' });

  try {
    assertProductionBillingConfig();
    await requireOrganizationAccess(state.userId, state.organizationId);
    const profile = await ensureBillingProfile(state.organizationId);
    const token = await exchangeMollieCode(code);
    const accessToken = String(token.access_token || '');
    const refreshToken = String(token.refresh_token || '');
    if (!accessToken || !refreshToken) throw new Error('Mollie gaf geen access token of refresh token terug.');

    const organization = await fetchMollieOrganization(accessToken);
    const accountId = String(organization.id || organization.resource || `mollie_${state.organizationId}`);
    await markOrganizationMollieConnected({
      organizationId: state.organizationId,
      profileId: profile.id,
      userId: state.userId,
      accountId,
      status: 'connected',
      token,
      metadata: { organization },
    });
    return redirectWithStatus(req, state.returnTo, { billing_connected: 'mollie' });
  } catch (err) {
    const internalMessage = err instanceof Error ? err.message : 'Mollie Connect callback mislukt.';
    console.error('Mollie callback failed', internalMessage);
    const publicMessage = 'Mollie Connect kon niet veilig worden afgerond. Controleer de koppeling en probeer opnieuw.';
    await supabaseAdmin.from('organization_billing_profiles').update({ mollie_connect_status: 'error' }).eq('organization_id', state.organizationId);
    await supabaseAdmin.from('organization_mollie_connections').update({ status: 'error', last_error: publicMessage }).eq('organization_id', state.organizationId);
    return redirectWithStatus(req, state.returnTo, { billing_error: publicMessage });
  }
}

async function exchangeMollieCode(code: string): Promise<Record<string, unknown>> {
  return await postMollieToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: MOLLIE_CONNECT_REDIRECT_URL,
    client_id: MOLLIE_CONNECT_CLIENT_ID,
    client_secret: MOLLIE_CONNECT_CLIENT_SECRET,
  });
}

async function refreshMollieToken(refreshToken: string): Promise<Record<string, unknown>> {
  return await postMollieToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: MOLLIE_CONNECT_CLIENT_ID,
    client_secret: MOLLIE_CONNECT_CLIENT_SECRET,
  });
}

async function postMollieToken(params: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.mollie.com/oauth2/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Mollie token request failed', String(data.detail || data.title || response.statusText));
    throw new BillingHttpError('Mollie tokenaanvraag mislukt. Controleer de Mollie Connect-configuratie.', 502);
  }
  return data;
}

async function fetchMollieOrganization(accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.mollie.com/v2/organizations/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Mollie organization fetch failed', String(data.detail || data.title || response.statusText));
    throw new BillingHttpError('Mollie organisatie kon niet worden opgehaald.', 502);
  }
  return data;
}

async function markOrganizationMollieConnected(input: {
  organizationId: string;
  profileId: string;
  userId: string;
  accountId: string;
  status: 'connected' | 'mock_connected';
  token?: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const connectionPatch: Record<string, unknown> = {
    organization_id: input.organizationId,
    billing_profile_id: input.profileId,
    status: input.status,
    mollie_organization_id: input.accountId,
    token_type: String(input.token?.token_type || 'Bearer'),
    scopes: parseScope(input.token?.scope),
    expires_at: computeTokenExpiresAt(input.token),
    last_refreshed_at: input.token ? new Date().toISOString() : null,
    last_error: null,
    connected_by: input.userId,
    revoked_at: null,
    metadata: input.metadata,
  };

  if (input.token) {
    connectionPatch.access_token_encrypted = await encryptSecret(String(input.token.access_token || ''));
    connectionPatch.refresh_token_encrypted = await encryptSecret(String(input.token.refresh_token || ''));
  }

  const { error: connectionError } = await supabaseAdmin
    .from('organization_mollie_connections')
    .upsert(connectionPatch, { onConflict: 'organization_id' });
  if (connectionError) throw connectionError;

  const { error } = await supabaseAdmin
    .from('organization_billing_profiles')
    .update({
      mollie_connect_status: input.status,
      mollie_connect_account_id: input.accountId,
      metadata: input.metadata,
    })
    .eq('organization_id', input.organizationId);
  if (error) throw error;

  await supabaseAdmin.rpc('log_billing_audit', {
    p_organization_id: input.organizationId,
    p_action: 'mollie_connected',
    p_entity_type: 'billing_profile',
    p_entity_id: null,
    p_entity_label: input.accountId,
    p_metadata: { status: input.status, accountId: input.accountId, token_storage: input.token ? 'encrypted' : 'mock' },
    p_actor_user_id: input.userId,
  });
}

function parseScope(scope: unknown): string[] {
  if (Array.isArray(scope)) return scope.map(String).filter(Boolean);
  return String(scope || '').split(/\s+/).map(value => value.trim()).filter(Boolean);
}

function computeTokenExpiresAt(token: Record<string, unknown> | undefined): string | null {
  if (!token) return null;
  const expiresIn = Number(token.expires_in || 0);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

async function getTenantMollieAccessToken(organizationId: string): Promise<string> {
  assertProductionBillingConfig();
  const { data, error } = await supabaseAdmin
    .from('organization_mollie_connections')
    .select('*')
    .eq('organization_id', organizationId)
    .single();
  if (error || !data) throw new BillingHttpError('Geen Mollie Connect-token gevonden voor deze organisatie. Koppel Mollie opnieuw.', 400);

  const connection = data as MollieConnection;
  if (connection.status !== 'connected') throw new BillingHttpError('Mollie Connect is niet actief voor deze organisatie.', 400);
  if (!connection.access_token_encrypted || !connection.refresh_token_encrypted) throw new BillingHttpError('Mollie token storage is incompleet. Koppel Mollie opnieuw.', 400);

  const expiresAt = connection.expires_at ? new Date(connection.expires_at).getTime() : 0;
  if (expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return await decryptSecret(connection.access_token_encrypted);
  }

  const refreshToken = await decryptSecret(connection.refresh_token_encrypted);
  try {
    const refreshed = await refreshMollieToken(refreshToken);
    const accessToken = String(refreshed.access_token || '');
    const rotatedRefreshToken = String(refreshed.refresh_token || refreshToken);
    if (!accessToken) throw new Error('Mollie refresh gaf geen access token terug.');

    const previousVersion = Number(connection.refresh_token_version || 0);
    const patch = {
      access_token_encrypted: await encryptSecret(accessToken),
      refresh_token_encrypted: await encryptSecret(rotatedRefreshToken),
      token_type: String(refreshed.token_type || connection.token_type || 'Bearer'),
      scopes: parseScope(refreshed.scope || connection.scopes || []),
      expires_at: computeTokenExpiresAt(refreshed),
      last_refreshed_at: new Date().toISOString(),
      last_error: null,
      refresh_token_version: previousVersion + 1,
    };

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('organization_mollie_connections')
      .update(patch)
      .eq('id', connection.id)
      .eq('refresh_token_version', previousVersion)
      .select('id')
      .maybeSingle();

    if (updateError) throw updateError;
    if (updated) return accessToken;

    const fallback = await readFreshlyRotatedToken(connection);
    if (fallback) return fallback;
    throw new Error('Mollie token refresh kon niet atomair worden opgeslagen.');
  } catch (refreshError) {
    const fallback = await readFreshlyRotatedToken(connection);
    if (fallback) {
      await supabaseAdmin
        .from('organization_mollie_connections')
        .update({ last_error: null })
        .eq('id', connection.id);
      return fallback;
    }

    const message = refreshError instanceof Error ? refreshError.message : 'Mollie token refresh mislukt.';
    await supabaseAdmin
      .from('organization_mollie_connections')
      .update({ last_error: message })
      .eq('id', connection.id);
    throw new BillingHttpError('Mollie token refresh mislukt. Koppel Mollie opnieuw als dit blijft gebeuren.', 502);
  }
}

async function readFreshlyRotatedToken(previous: MollieConnection): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('organization_mollie_connections')
    .select('*')
    .eq('id', previous.id)
    .maybeSingle();
  if (!data) return null;

  const current = data as MollieConnection;
  const previousVersion = Number(previous.refresh_token_version || 0);
  const currentVersion = Number(current.refresh_token_version || 0);
  const previousRefreshTime = previous.last_refreshed_at ? new Date(previous.last_refreshed_at).getTime() : 0;
  const currentRefreshTime = current.last_refreshed_at ? new Date(current.last_refreshed_at).getTime() : 0;
  const currentExpiresAt = current.expires_at ? new Date(current.expires_at).getTime() : 0;
  const wasRefreshedByAnotherRequest = (currentVersion > previousVersion || currentRefreshTime > previousRefreshTime)
    && currentExpiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS;

  if (current.status === 'connected' && wasRefreshedByAnotherRequest && current.access_token_encrypted) {
    return await decryptSecret(current.access_token_encrypted);
  }
  return null;
}

async function createExtraSeatCheckout(userId: string, organizationId: string, quantityRaw: number, returnUrlRaw: string, idempotencyRaw: string): Promise<CheckoutResult> {
  const quantity = Math.max(1, Math.min(25, Math.floor(Number.isFinite(quantityRaw) ? quantityRaw : 1)));
  const profile = await ensureConnectedBillingProfile(organizationId);
  const plan = await getPlan(profile.plan_key);
  const amountCents = quantity * plan.extra_seat_price_cents;
  if (amountCents <= 0) throw new BillingHttpError('Voor dit plan is geen automatische extra-seat prijs ingesteld. Gebruik handmatige billing voor Custom-plannen.', 400);

  return await createTenantCheckout({
    userId,
    organizationId,
    profile,
    paymentType: 'extra_seat',
    amountCents,
    currency: plan.currency,
    description: `BrandCore extra seat x${quantity}`,
    returnUrlRaw,
    idempotencyRaw,
    planKey: profile.plan_key,
    licenseDelta: quantity,
    seatsAfter: profile.licensed_seats + quantity,
    metadata: { quantity, unit_price_cents: plan.extra_seat_price_cents, source: 'billing_function' },
  });
}

async function createPlanChangeCheckout(userId: string, organizationId: string, planKey: string, returnUrlRaw: string, idempotencyRaw: string): Promise<CheckoutResult> {
  if (!planKey) throw new BillingHttpError('Kies een geldig plan.', 400);

  const profile = await ensureConnectedBillingProfile(organizationId);
  if (profile.plan_key === planKey) throw new BillingHttpError('Deze organisatie gebruikt dit plan al.', 400);

  const currentPlan = await getPlan(profile.plan_key);
  const targetPlan = await getPlan(planKey);
  const usage = await getOrganizationSeatUsage(organizationId);

  if (!targetPlan.is_active) throw new BillingHttpError('Dit plan is niet actief en kan niet via self-service checkout worden gekozen.', 400);
  if (targetPlan.is_custom) throw new BillingHttpError('Custom-plannen kunnen niet via self-service checkout worden gekozen. Neem contact op voor handmatige billing.', 400);

  const targetIncludedSeats = targetPlan.included_seats ?? profile.included_seats;
  const targetLicensedSeats = targetIncludedSeats + profile.purchased_seats;
  if (targetLicensedSeats < usage.usedSeats) {
    throw new BillingHttpError('Dit plan heeft te weinig seats voor de huidige actieve gebruikers en openstaande uitnodigingen.', 400);
  }

  if (targetPlan.monthly_price_cents <= currentPlan.monthly_price_cents) {
    throw new BillingHttpError('Downgrades of gelijk geprijsde planwijzigingen lopen handmatig zodat credit/proratie correct wordt verwerkt.', 400);
  }
  const amountCents = targetPlan.monthly_price_cents;

  return await createTenantCheckout({
    userId,
    organizationId,
    profile,
    paymentType: 'plan_change',
    amountCents,
    currency: targetPlan.currency,
    description: `BrandCore planwijziging naar ${targetPlan.name}`,
    returnUrlRaw,
    idempotencyRaw,
    planKey: targetPlan.plan_key,
    licenseDelta: targetLicensedSeats - profile.licensed_seats,
    seatsAfter: targetLicensedSeats,
    metadata: {
      source: 'billing_function',
      old_plan_key: profile.plan_key,
      new_plan_key: targetPlan.plan_key,
      target_included_seats: targetIncludedSeats,
      target_licensed_seats: targetLicensedSeats,
      active_members: usage.activeMembers,
      pending_invitations: usage.pendingInvitations,
    },
  });
}

async function ensureConnectedBillingProfile(organizationId: string): Promise<BillingProfile> {
  const profile = await ensureBillingProfile(organizationId);
  if (MOLLIE_ALLOW_MOCK && profile.mollie_connect_status === 'mock_connected') return profile;
  if (profile.mollie_connect_status !== 'connected') {
    throw new BillingHttpError('Koppel het Mollie-account van deze organisatie voordat je billing checkouts aanmaakt.', 400);
  }
  return profile;
}

async function createTenantCheckout(input: {
  userId: string;
  organizationId: string;
  profile: BillingProfile;
  paymentType: CheckoutKind;
  amountCents: number;
  currency: string;
  description: string;
  returnUrlRaw: string;
  idempotencyRaw: string;
  planKey: string;
  licenseDelta: number;
  seatsAfter: number;
  metadata: Record<string, unknown>;
}): Promise<CheckoutResult> {
  const returnUrl = sanitizeReturnTo(input.returnUrlRaw);
  const requestedIdempotencyKey = sanitizeIdempotencyKey(input.idempotencyRaw);
  const existing = await findReusablePayment(input, requestedIdempotencyKey);
  if (existing) {
    return checkoutResultFromPayment(existing, input.paymentType, true);
  }

  const generatedIdempotencyKey = `${input.paymentType}:${input.organizationId}:${input.licenseDelta}:${crypto.randomUUID()}`;
  const idempotencyKey = requestedIdempotencyKey || generatedIdempotencyKey;

  if (MOLLIE_ALLOW_MOCK && input.profile.mollie_connect_status === 'mock_connected') {
    return await createMockCheckout(input, returnUrl, idempotencyKey);
  }

  assertProductionBillingConfig();
  const accessToken = await getTenantMollieAccessToken(input.organizationId);
  const webhookUrl = MOLLIE_WEBHOOK_SECRET
    ? `${MOLLIE_WEBHOOK_URL}${MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?'}secret=${encodeURIComponent(MOLLIE_WEBHOOK_SECRET)}`
    : MOLLIE_WEBHOOK_URL;

  const payment = await getOrCreateRecoverablePaymentRecord(input, idempotencyKey);
  const mollieIdempotencyKey = sanitizeIdempotencyKey(String(payment.idempotency_key || idempotencyKey)) || generatedIdempotencyKey;

  if (payment.provider_payment_id && payment.provider_checkout_url) {
    return checkoutResultFromPayment(payment, input.paymentType, true);
  }

  const molliePayment = await createMolliePayment(accessToken, {
    amountCents: input.amountCents,
    currency: input.currency,
    description: input.description,
    redirectUrl: returnUrl,
    webhookUrl,
    idempotencyKey: mollieIdempotencyKey,
    metadata: { organizationId: input.organizationId, paymentRecordId: payment.id, type: input.paymentType, licenseDelta: input.licenseDelta },
  });

  const externalId = String(molliePayment.id || '');
  const externalCheckoutUrl = String((molliePayment._links as Record<string, { href?: string }> | undefined)?.checkout?.href || '');
  if (!externalId || !externalCheckoutUrl) throw new Error('Mollie gaf geen payment id of checkout URL terug.');

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('organization_payment_records')
    .update({
      provider_payment_id: externalId,
      provider_checkout_url: externalCheckoutUrl,
      idempotency_key: mollieIdempotencyKey,
      raw_payload: molliePayment,
      checkout_expires_at: new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', payment.id)
    .select('*')
    .single();
  if (updateError) throw updateError;

  return checkoutResultFromPayment(updated, input.paymentType, false);
}
function checkoutResultFromPayment(payment: Record<string, unknown>, paymentType: CheckoutKind, reused: boolean): CheckoutResult {
  return {
    paymentId: String(payment.id || ''),
    providerPaymentId: String(payment.provider_payment_id || ''),
    checkoutUrl: String(payment.provider_checkout_url || ''),
    mock: String(payment.provider_payment_id || '').startsWith('mock_payment_'),
    paymentType,
    reused,
  };
}

async function getOrCreateRecoverablePaymentRecord(input: {
  userId: string;
  organizationId: string;
  profile: BillingProfile;
  paymentType: CheckoutKind;
  amountCents: number;
  currency: string;
  planKey: string;
  licenseDelta: number;
  seatsAfter: number;
  metadata: Record<string, unknown>;
}, idempotencyKey: string): Promise<LocalPaymentRecord> {
  const exact = await findPaymentByIdempotencyKey(input.organizationId, idempotencyKey);
  if (exact) {
    assertPaymentRecordCompatible(exact, input);
    return exact;
  }

  const incomplete = await findIncompleteRecoverablePayment(input);
  if (incomplete) {
    assertPaymentRecordCompatible(incomplete, input);
    return incomplete;
  }

  return await insertRecoverablePaymentRecord(input, idempotencyKey);
}

async function findPaymentByIdempotencyKey(organizationId: string, idempotencyKey: string): Promise<LocalPaymentRecord | null> {
  if (!idempotencyKey) return null;
  const { data, error } = await supabaseAdmin
    .from('organization_payment_records')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  return data ? data as LocalPaymentRecord : null;
}

async function findIncompleteRecoverablePayment(input: {
  organizationId: string;
  paymentType: CheckoutKind;
  planKey: string;
  licenseDelta: number;
  amountCents: number;
  currency: string;
}): Promise<LocalPaymentRecord | null> {
  const { data, error } = await supabaseAdmin
    .from('organization_payment_records')
    .select('*')
    .eq('organization_id', input.organizationId)
    .eq('payment_type', input.paymentType)
    .eq('license_delta', input.licenseDelta)
    .eq('plan_key', input.planKey)
    .eq('amount_cents', input.amountCents)
    .eq('currency', input.currency)
    .in('status', ['open', 'pending'])
    .gt('checkout_expires_at', new Date().toISOString())
    .is('provider_payment_id', null)
    .is('provider_checkout_url', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? data as LocalPaymentRecord : null;
}

async function insertRecoverablePaymentRecord(input: {
  userId: string;
  organizationId: string;
  profile: BillingProfile;
  paymentType: CheckoutKind;
  amountCents: number;
  currency: string;
  planKey: string;
  licenseDelta: number;
  seatsAfter: number;
  metadata: Record<string, unknown>;
}, idempotencyKey: string): Promise<LocalPaymentRecord> {
  const { data, error } = await supabaseAdmin
    .from('organization_payment_records')
    .insert({
      organization_id: input.organizationId,
      billing_profile_id: input.profile.id,
      payment_type: input.paymentType,
      provider: 'mollie',
      idempotency_key: idempotencyKey,
      status: 'open',
      amount_cents: input.amountCents,
      currency: input.currency,
      plan_key: input.planKey,
      license_delta: input.licenseDelta,
      seats_before: input.profile.licensed_seats,
      seats_after: input.seatsAfter,
      checkout_expires_at: new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString(),
      created_by: input.userId,
      metadata: input.metadata,
    })
    .select('*')
    .single();

  if (error) {
    if (String((error as { code?: string }).code || '') === '23505') {
      const existing = await findPaymentByIdempotencyKey(input.organizationId, idempotencyKey)
        ?? await findIncompleteRecoverablePayment(input);
      if (existing) {
        assertPaymentRecordCompatible(existing, input);
        return existing;
      }
    }
    throw error;
  }

  return data as LocalPaymentRecord;
}

function assertPaymentRecordCompatible(payment: LocalPaymentRecord, input: {
  paymentType: CheckoutKind;
  amountCents: number;
  currency: string;
  planKey: string;
  licenseDelta: number;
}): void {
  if (!['open', 'pending'].includes(payment.status)) {
    throw new BillingHttpError('Deze checkout is al afgerond of verlopen. Start een nieuwe checkout.', 409);
  }
  const expiresAt = payment.checkout_expires_at ? new Date(payment.checkout_expires_at).getTime() : 0;
  if (expiresAt && expiresAt <= Date.now()) {
    throw new BillingHttpError('Deze checkout is verlopen. Start een nieuwe checkout.', 409);
  }
  const sameShape = payment.payment_type === input.paymentType
    && Number(payment.amount_cents) === input.amountCents
    && String(payment.currency) === input.currency
    && String(payment.plan_key || '') === input.planKey
    && Number(payment.license_delta) === input.licenseDelta;
  if (!sameShape) {
    throw new BillingHttpError('Idempotency-key conflicteert met een andere billing checkout. Start de actie opnieuw.', 409);
  }
}

async function createMockCheckout(input: {
  userId: string;
  organizationId: string;
  profile: BillingProfile;
  paymentType: CheckoutKind;
  amountCents: number;
  currency: string;
  returnUrlRaw: string;
  planKey: string;
  licenseDelta: number;
  seatsAfter: number;
  metadata: Record<string, unknown>;
}, returnUrl: string, requestedIdempotencyKey: string): Promise<CheckoutResult> {
  const payment = await getOrCreateRecoverablePaymentRecord(input, requestedIdempotencyKey);
  if (payment.provider_payment_id && payment.provider_checkout_url) {
    return checkoutResultFromPayment(payment, input.paymentType, true);
  }

  const providerPaymentId = `mock_payment_${crypto.randomUUID()}`;
  const checkoutUrl = `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}mock_payment_id=${encodeURIComponent(providerPaymentId)}&billing_mock=1`;
  const { data: updated, error } = await supabaseAdmin
    .from('organization_payment_records')
    .update({
      provider_payment_id: providerPaymentId,
      provider_checkout_url: checkoutUrl,
      raw_payload: { mock: true, paymentRecordId: payment.id },
      metadata: { ...input.metadata, mock: true },
      checkout_expires_at: new Date(Date.now() + CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', payment.id)
    .select('*')
    .single();
  if (error) throw error;
  return checkoutResultFromPayment(updated, input.paymentType, false);
}

async function findReusablePayment(input: {
  organizationId: string;
  paymentType: CheckoutKind;
  licenseDelta: number;
  planKey: string;
  amountCents: number;
  currency: string;
}, idempotencyKey: string): Promise<LocalPaymentRecord | null> {
  if (idempotencyKey) {
    const { data, error } = await supabaseAdmin
      .from('organization_payment_records')
      .select('*')
      .eq('organization_id', input.organizationId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      const payment = data as LocalPaymentRecord;
      assertPaymentRecordCompatible(payment, input);
      if (payment.provider_payment_id && payment.provider_checkout_url) return payment;
    }
  }

  const { data, error } = await supabaseAdmin
    .from('organization_payment_records')
    .select('*')
    .eq('organization_id', input.organizationId)
    .eq('payment_type', input.paymentType)
    .eq('license_delta', input.licenseDelta)
    .eq('plan_key', input.planKey)
    .eq('amount_cents', input.amountCents)
    .eq('currency', input.currency)
    .in('status', ['open', 'pending'])
    .gt('checkout_expires_at', new Date().toISOString())
    .not('provider_payment_id', 'is', null)
    .not('provider_checkout_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? data as LocalPaymentRecord : null;
}

function sanitizeIdempotencyKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 160);
}

async function createMolliePayment(accessToken: string, input: { amountCents: number; currency: string; description: string; redirectUrl: string; webhookUrl: string; idempotencyKey: string; metadata: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const response = await fetch('https://api.mollie.com/v2/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({
      amount: { currency: input.currency, value: formatAmount(input.amountCents) },
      description: input.description,
      redirectUrl: input.redirectUrl,
      webhookUrl: input.webhookUrl,
      metadata: input.metadata,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Mollie payment create failed', String(data.detail || data.title || response.statusText));
    throw new BillingHttpError('Mollie checkout kon niet worden aangemaakt.', 502);
  }
  return data;
}

async function handleMollieWebhook(req: Request, url: URL, body: Record<string, string>): Promise<Response> {
  if (!MOLLIE_ALLOW_MOCK) assertProductionBillingConfig();
  if (MOLLIE_WEBHOOK_SECRET && !timingSafeEqual(url.searchParams.get('secret') || '', MOLLIE_WEBHOOK_SECRET)) {
    return json(req, { ok: false, error: 'Unauthorized webhook.' }, 401);
  }
  if (!MOLLIE_ALLOW_MOCK && !MOLLIE_WEBHOOK_SECRET) {
    return json(req, { ok: false, error: 'Webhook secret is not configured.' }, 500);
  }

  const paymentId = String(body.id || body.paymentId || '');
  if (!paymentId) return json(req, { ok: false, error: 'Mollie payment id ontbreekt.' }, 400);

  const paymentRecord = await findPaymentRecordByProviderId(paymentId);
  if (!paymentRecord) {
    console.warn('Mollie webhook ignored: unknown provider payment id');
    return json(req, { ok: true, ignored: true });
  }

  const payment = MOLLIE_ALLOW_MOCK && paymentId.startsWith('mock_payment_')
    ? { id: paymentId, status: String(body.status || 'paid'), metadata: { mock: true, paymentRecordId: paymentRecord.id } }
    : await fetchMolliePayment(paymentId, await getTenantMollieAccessToken(String(paymentRecord.organization_id)));

  const status = normalizeMolliePaymentStatus(String(payment.status || 'open'));
  const { data, error } = await supabaseAdmin.rpc('apply_paid_organization_payment', {
    p_provider_payment_id: paymentId,
    p_payment_status: status,
    p_payload: payment,
  });
  if (error) throw error;
  return json(req, { ok: true, payment: data });
}

async function findPaymentRecordByProviderId(providerPaymentId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabaseAdmin
    .from('organization_payment_records')
    .select('id, organization_id, provider_payment_id, status')
    .eq('provider', 'mollie')
    .eq('provider_payment_id', providerPaymentId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function fetchMolliePayment(paymentId: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.mollie.com/v2/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Mollie payment fetch failed', String(data.detail || data.title || response.statusText));
    throw new BillingHttpError('Mollie betaling kon niet worden opgehaald.', 502);
  }
  return data;
}

async function markMockPaymentPaid(organizationId: string, providerPaymentId: string): Promise<unknown> {
  if (!MOLLIE_ALLOW_MOCK) throw new BillingHttpError('Mock payments zijn uitgeschakeld.', 403);
  if (!providerPaymentId.startsWith('mock_payment_')) throw new BillingHttpError('Alleen mock payments kunnen via deze actie worden afgerond.', 400);
  const { data: payment, error: lookupError } = await supabaseAdmin
    .from('organization_payment_records')
    .select('id, organization_id')
    .eq('provider', 'mollie')
    .eq('provider_payment_id', providerPaymentId)
    .eq('organization_id', organizationId)
    .single();
  if (lookupError) throw lookupError;
  const { data, error } = await supabaseAdmin.rpc('apply_paid_organization_payment', {
    p_provider_payment_id: providerPaymentId,
    p_payment_status: 'paid',
    p_payload: { id: providerPaymentId, status: 'paid', mock: true, paymentRecordId: payment.id },
  });
  if (error) throw error;
  return data;
}

function normalizeMolliePaymentStatus(status: string): string {
  if (status === 'cancelled') return 'canceled';
  if (['open', 'pending', 'paid', 'failed', 'expired', 'canceled', 'authorized'].includes(status)) return status;
  return 'pending';
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

function sanitizeReturnTo(value: string): string {
  const fallback = 'http://localhost:5173/settings';
  let url: URL;
  try { url = new URL(value || fallback); } catch { url = new URL(fallback); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new BillingHttpError('Return URL is niet toegestaan voor billing.', 400);
  }
  if (ALLOWED_RETURN_ORIGINS.length === 0) {
    if (MOLLIE_ALLOW_MOCK && ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(url.origin)) return url.toString();
    throw new BillingHttpError('BILLING_ALLOWED_RETURN_ORIGINS is verplicht voor veilige billing return URLs.', 500);
  }
  if (!ALLOWED_RETURN_ORIGINS.includes(url.origin)) {
    throw new BillingHttpError('Return URL is niet toegestaan voor billing.', 400);
  }
  return url.toString();
}

function redirectWithStatus(req: Request, returnTo: string, params: Record<string, string>): Response {
  const target = new URL(returnTo);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: target.toString(), ...corsHeaders(req) } });
}

function getStateSecret(): string {
  const secret = Deno.env.get('MOLLIE_OAUTH_STATE_SECRET') || '';
  if (!secret && !MOLLIE_ALLOW_MOCK) throw new Error('MOLLIE_OAUTH_STATE_SECRET ontbreekt.');
  return secret || 'dev-only-change-me';
}

async function signState(state: OAuthState): Promise<string> {
  const payload = btoaUrlString(JSON.stringify(state));
  const signature = await hmac(payload, getStateSecret());
  return `${payload}.${signature}`;
}

async function verifyState(raw: string): Promise<OAuthState> {
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) throw new Error('Ongeldige OAuth state.');
  const expected = await hmac(payload, getStateSecret());
  if (!timingSafeEqual(signature, expected)) throw new Error('OAuth state signature ongeldig.');
  const state = JSON.parse(atobUrlString(payload)) as OAuthState;
  if (!state.exp || state.exp < Math.floor(Date.now() / 1000)) throw new Error('OAuth state is verlopen.');
  return state;
}

async function hmac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoaUrlBytes(new Uint8Array(sig));
}

async function encryptionKey(): Promise<CryptoKey> {
  const secret = Deno.env.get('MOLLIE_TOKEN_ENCRYPTION_KEY') || '';
  if (!secret && !MOLLIE_ALLOW_MOCK) throw new Error('MOLLIE_TOKEN_ENCRYPTION_KEY ontbreekt.');
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret || 'dev-only-token-key'));
  return await crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecret(plainText: string): Promise<string> {
  if (!plainText) throw new Error('Lege Mollie token kan niet worden opgeslagen.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plainText));
  return `v1.${btoaUrlBytes(iv)}.${btoaUrlBytes(new Uint8Array(cipher))}`;
}

async function decryptSecret(value: string): Promise<string> {
  const [version, ivRaw, cipherRaw] = value.split('.');
  if (version !== 'v1' || !ivRaw || !cipherRaw) throw new Error('Mollie token storage formaat is ongeldig.');
  const key = await encryptionKey();
  const iv = atobUrlBytes(ivRaw);
  const cipher = atobUrlBytes(cipherRaw);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

function btoaUrlString(value: string): string {
  return btoaUrlBytes(new TextEncoder().encode(value));
}

function atobUrlString(value: string): string {
  return new TextDecoder().decode(atobUrlBytes(value));
}

function btoaUrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function atobUrlBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
