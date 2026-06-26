// ResoFly klant-billing — doorlopende abonnementen op ResoFly's EIGEN Mollie-account.
//
// Richting: klanten betalen ResoFly. We maken per organisatie één Mollie Customer aan
// op het platform-account (MOLLIE_PLATFORM_API_KEY), nemen een eerste betaling
// (sequenceType:'first') om een mandaat te krijgen, en starten daarna een Mollie
// Subscription die maandelijks automatisch incasseert. Seat-/planwijzigingen passen het
// abonnementsbedrag aan (PATCH) en worden direct in de DB toegepast.
//
// NB: dit vervangt de oude "tenant betaalt zichzelf via Mollie Connect"-richting. De
// per-factuur Mollie-koppeling (eigen org-key, invoice-workflow) staat hier los van.

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
  subscription_status: string;
  mollie_connect_status: string;
  mollie_customer_id: string | null;
  mollie_mandate_id: string | null;
  mollie_subscription_id: string | null;
  billing_exempt: boolean;
  current_period_ends_at: string | null;
  next_invoice_date: string | null;
  trial_ends_at: string | null;
  last_payment_status: string | null;
};

type BillingPlan = {
  plan_key: string;
  name: string;
  included_seats: number | null;
  monthly_price_cents: number;
  extra_seat_price_cents: number;
  currency: string;
  trial_days: number;
  is_custom?: boolean;
  is_active: boolean;
};

type CheckoutResult = {
  checkoutUrl?: string;
  applied?: boolean;
  mock?: boolean;
  providerPaymentId?: string;
  status?: string;
};

const SUPABASE_URL = requiredEnv('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
const MOLLIE_API_KEY = Deno.env.get('MOLLIE_PLATFORM_API_KEY') || '';
const MOLLIE_WEBHOOK_URL = Deno.env.get('MOLLIE_WEBHOOK_URL') || '';
const MOLLIE_WEBHOOK_SECRET = Deno.env.get('MOLLIE_WEBHOOK_SECRET') || '';
const MOLLIE_ALLOW_MOCK = (Deno.env.get('MOLLIE_ALLOW_MOCK') || 'false').toLowerCase() === 'true';
const ALLOWED_RETURN_ORIGINS = (Deno.env.get('BILLING_ALLOWED_RETURN_ORIGINS') || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const MOLLIE_API_BASE = 'https://api.mollie.com/v2';

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
    if (req.method === 'GET') return json(req, { ok: true, service: 'billing' });
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
      case 'startSubscriptionCheckout':
        return json(req, { ok: true, ...(await startSubscriptionCheckout(user.id, organizationId, String(body.planKey || ''), String(body.returnUrl || ''))) });
      case 'createExtraSeatCheckout':
        return json(req, { ok: true, ...(await createExtraSeatCheckout(user.id, organizationId, Number(body.quantity || 1), String(body.returnUrl || ''))) });
      case 'createPlanChangeCheckout':
        return json(req, { ok: true, ...(await createPlanChangeCheckout(user.id, organizationId, String(body.planKey || ''), String(body.returnUrl || ''))) });
      case 'cancelSubscription':
        return json(req, { ok: true, ...(await cancelSubscription(organizationId)) });
      case 'markMockPaymentPaid':
        return json(req, { ok: true, ...(await markMockPaymentPaid(organizationId, String(body.providerPaymentId || ''))) });
      case 'refreshBilling':
        return json(req, { ok: true, overview: await loadBillingOverview(organizationId) });
      default:
        return json(req, { ok: false, error: `Onbekende billing action: ${action}` }, 400);
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

// ---------------------------------------------------------------------------
// Infra helpers
// ---------------------------------------------------------------------------

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

function assertMollieConfigured(): void {
  if (MOLLIE_ALLOW_MOCK) return;
  if (!MOLLIE_API_KEY) {
    throw new BillingHttpError('MOLLIE_PLATFORM_API_KEY ontbreekt. Configureer ResoFly\'s Mollie-key in de Edge Function secrets.', 500);
  }
  if (!MOLLIE_WEBHOOK_URL || !MOLLIE_WEBHOOK_SECRET) {
    throw new BillingHttpError('Mollie webhook-configuratie ontbreekt (MOLLIE_WEBHOOK_URL / MOLLIE_WEBHOOK_SECRET).', 500);
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
  // Standaard UUID-vorm 8-4-4-4-12. (De vorige regex miste een groep en wees daardoor
  // elke echte UUID af → "Ongeldige organisatie".)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function ensureBillingProfile(organizationId: string): Promise<BillingProfile> {
  const { data, error } = await supabaseAdmin.rpc('ensure_organization_billing_profile', { p_organization_id: organizationId });
  if (error) throw error;
  return (Array.isArray(data) ? data[0] : data) as BillingProfile;
}

async function getProfile(organizationId: string): Promise<BillingProfile> {
  const { data, error } = await supabaseAdmin
    .from('organization_billing_profiles')
    .select('*')
    .eq('organization_id', organizationId)
    .single();
  if (error) throw error;
  return data as BillingProfile;
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

function monthlyCents(plan: BillingPlan, purchasedSeats: number): number {
  return plan.monthly_price_cents + Math.max(0, purchasedSeats) * plan.extra_seat_price_cents;
}

// Service-role-veilige overview (de RPC vereist auth.uid()/can_admin_org en werkt niet
// onder de service-role; toegang is hier al afgedwongen in de action-handler).
async function loadBillingOverview(organizationId: string): Promise<unknown> {
  const profile = await ensureBillingProfile(organizationId);
  const plan = await getPlan(profile.plan_key);
  const nowIso = new Date().toISOString();

  const { count: activeMembers } = await supabaseAdmin
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active');
  const { count: pendingInvitations } = await supabaseAdmin
    .from('organization_invitations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'pending')
    .eq('consumes_license', true)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

  const active = activeMembers ?? 0;
  const pending = pendingInvitations ?? 0;
  const used = active + pending;

  return {
    organization_id: profile.organization_id,
    plan_key: profile.plan_key,
    plan_name: plan.name,
    included_seats: profile.included_seats,
    purchased_seats: profile.purchased_seats,
    licensed_seats: profile.licensed_seats,
    active_members: active,
    pending_invitations: pending,
    used_seats: used,
    available_seats: Math.max(profile.licensed_seats - used, 0),
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
    billing_exempt: profile.billing_exempt,
  };
}

async function assertNotExempt(profile: BillingProfile): Promise<void> {
  if (profile.billing_exempt) {
    throw new BillingHttpError('Deze organisatie is intern/vrijgesteld; er is geen abonnement of betaling nodig.', 400);
  }
}

// ---------------------------------------------------------------------------
// Mollie API (ResoFly platform account)
// ---------------------------------------------------------------------------

async function mollieFetch(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Record<string, unknown>> {
  assertMollieConfigured();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${MOLLIE_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`${MOLLIE_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Mollie ${method} ${path} failed`, String(data.detail || data.title || response.statusText));
    throw new BillingHttpError('Mollie-aanvraag mislukt. Controleer de Mollie-configuratie en logs.', 502);
  }
  return data as Record<string, unknown>;
}

async function ensureMollieCustomer(profile: BillingProfile): Promise<string> {
  if (profile.mollie_customer_id) return profile.mollie_customer_id;

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('name')
    .eq('id', profile.organization_id)
    .maybeSingle();
  const { data: ownerRow } = await supabaseAdmin
    .from('organization_members')
    .select('email')
    .eq('organization_id', profile.organization_id)
    .eq('role', 'owner')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  const customer = await mollieFetch('POST', '/customers', {
    name: String(org?.name || 'ResoFly-organisatie'),
    email: ownerRow?.email || undefined,
    metadata: { organizationId: profile.organization_id },
  });
  const customerId = String(customer.id || '');
  if (!customerId) throw new BillingHttpError('Mollie gaf geen customer-id terug.', 502);

  await supabaseAdmin
    .from('organization_billing_profiles')
    .update({ mollie_customer_id: customerId, updated_at: new Date().toISOString() })
    .eq('organization_id', profile.organization_id);
  return customerId;
}

function webhookUrlWithSecret(): string {
  if (!MOLLIE_WEBHOOK_URL) return '';
  const sep = MOLLIE_WEBHOOK_URL.includes('?') ? '&' : '?';
  return MOLLIE_WEBHOOK_SECRET
    ? `${MOLLIE_WEBHOOK_URL}${sep}secret=${encodeURIComponent(MOLLIE_WEBHOOK_SECRET)}`
    : MOLLIE_WEBHOOK_URL;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function startSubscriptionCheckout(userId: string, organizationId: string, planKeyRaw: string, returnUrlRaw: string): Promise<CheckoutResult> {
  const profile = await ensureBillingProfile(organizationId);
  await assertNotExempt(profile);
  const planKey = planKeyRaw || profile.plan_key || 'starter';
  const plan = await getPlan(planKey);
  if (plan.is_custom) throw new BillingHttpError('Custom-plannen lopen handmatig, niet via self-service checkout.', 400);

  const amountCents = monthlyCents(plan, profile.purchased_seats);
  if (amountCents <= 0) throw new BillingHttpError('Voor dit plan is geen maandbedrag ingesteld.', 400);

  const returnUrl = sanitizeReturnTo(returnUrlRaw);

  if (MOLLIE_ALLOW_MOCK && !MOLLIE_API_KEY) {
    const providerPaymentId = `mock_payment_${crypto.randomUUID()}`;
    await recordPaymentRecord(organizationId, profile.id, 'subscription', providerPaymentId, amountCents, plan.currency, planKey, userId);
    const checkoutUrl = `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}mock_payment_id=${encodeURIComponent(providerPaymentId)}&billing_mock=1`;
    return { checkoutUrl, mock: true, providerPaymentId };
  }

  const customerId = await ensureMollieCustomer(profile);
  // Idempotency-key met uur-bucket: beschermt tegen dubbelklikken, maar voorkomt dat
  // Mollie 24u lang dezelfde (mogelijk afgeronde) betaling teruggeeft bij een herstart.
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const payment = await mollieFetch('POST', '/payments', {
    amount: { currency: plan.currency, value: formatAmount(amountCents) },
    description: `ResoFly ${plan.name} — abonnement`,
    redirectUrl: returnUrl,
    webhookUrl: webhookUrlWithSecret(),
    customerId,
    sequenceType: 'first',
    metadata: { organizationId, planKey, type: 'subscription_first' },
  }, `sub-first:${organizationId}:${planKey}:${hourBucket}`);

  const providerPaymentId = String(payment.id || '');
  const checkoutUrl = String((payment._links as Record<string, { href?: string }> | undefined)?.checkout?.href || '');
  if (!providerPaymentId || !checkoutUrl) throw new BillingHttpError('Mollie gaf geen payment-id of checkout-URL terug.', 502);

  await recordPaymentRecord(organizationId, profile.id, 'subscription', providerPaymentId, amountCents, plan.currency, planKey, userId);
  return { checkoutUrl, providerPaymentId, status: String(payment.status || 'open') };
}

async function createPlanChangeCheckout(userId: string, organizationId: string, planKey: string, returnUrlRaw: string): Promise<CheckoutResult> {
  if (!planKey) throw new BillingHttpError('Kies een geldig plan.', 400);
  const profile = await ensureBillingProfile(organizationId);
  await assertNotExempt(profile);
  const targetPlan = await getPlan(planKey);
  if (!targetPlan.is_active) throw new BillingHttpError('Dit plan is niet actief.', 400);
  if (targetPlan.is_custom) throw new BillingHttpError('Custom-plannen lopen handmatig.', 400);
  if (profile.plan_key === planKey) throw new BillingHttpError('Deze organisatie gebruikt dit plan al.', 400);

  // Geen actief abonnement → start een nieuw abonnement op het gekozen plan.
  if (!hasActiveSubscription(profile)) {
    return await startSubscriptionCheckout(userId, organizationId, planKey, returnUrlRaw);
  }

  // Actief abonnement → bedrag aanpassen en planwijziging direct toepassen.
  const newPurchased = profile.purchased_seats;
  const amountCents = monthlyCents(targetPlan, newPurchased);
  await updateMollieSubscriptionAmount(profile, amountCents, targetPlan, `ResoFly ${targetPlan.name} — abonnement`);
  const { error } = await supabaseAdmin.rpc('apply_organization_seat_change', {
    p_organization_id: organizationId,
    p_plan_key: planKey,
    p_purchased_seats: newPurchased,
    p_metadata: { source: 'plan_change', monthly_cents: amountCents },
  });
  if (error) throw error;
  return { applied: true };
}

async function createExtraSeatCheckout(_userId: string, organizationId: string, quantityRaw: number, _returnUrlRaw: string): Promise<CheckoutResult> {
  const quantity = Math.max(1, Math.min(25, Math.floor(Number.isFinite(quantityRaw) ? quantityRaw : 1)));
  const profile = await ensureBillingProfile(organizationId);
  await assertNotExempt(profile);

  if (!hasActiveSubscription(profile)) {
    throw new BillingHttpError('Start eerst een abonnement voordat je extra gebruikers toevoegt.', 400);
  }

  const plan = await getPlan(profile.plan_key);
  if (plan.extra_seat_price_cents <= 0) {
    throw new BillingHttpError('Voor dit plan is geen extra-seat prijs ingesteld. Gebruik handmatige billing voor Custom-plannen.', 400);
  }

  const newPurchased = profile.purchased_seats + quantity;
  const amountCents = monthlyCents(plan, newPurchased);
  await updateMollieSubscriptionAmount(profile, amountCents, plan, `ResoFly ${plan.name} — abonnement`);
  const { error } = await supabaseAdmin.rpc('apply_organization_seat_change', {
    p_organization_id: organizationId,
    p_purchased_seats: newPurchased,
    p_metadata: { source: 'extra_seat', quantity, monthly_cents: amountCents },
  });
  if (error) throw error;
  return { applied: true };
}

async function cancelSubscription(organizationId: string): Promise<CheckoutResult> {
  const profile = await ensureBillingProfile(organizationId);
  if (profile.mollie_customer_id && profile.mollie_subscription_id && !MOLLIE_ALLOW_MOCK) {
    await mollieFetch('DELETE', `/customers/${encodeURIComponent(profile.mollie_customer_id)}/subscriptions/${encodeURIComponent(profile.mollie_subscription_id)}`);
  }
  await supabaseAdmin
    .from('organization_billing_profiles')
    .update({ subscription_status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('organization_id', organizationId);
  await supabaseAdmin.rpc('log_billing_audit', {
    p_organization_id: organizationId,
    p_action: 'subscription_cancelled',
    p_entity_type: 'billing_profile',
    p_entity_id: profile.id,
    p_entity_label: profile.plan_key,
    p_metadata: { source: 'cancelSubscription' },
    p_actor_user_id: null,
  });
  return { applied: true };
}

function hasActiveSubscription(profile: BillingProfile): boolean {
  return profile.subscription_status === 'active'
    && (!!profile.mollie_subscription_id || (MOLLIE_ALLOW_MOCK && !!profile.mollie_mandate_id));
}

async function updateMollieSubscriptionAmount(profile: BillingProfile, amountCents: number, plan: BillingPlan, description: string): Promise<void> {
  if (MOLLIE_ALLOW_MOCK && !MOLLIE_API_KEY) return;
  if (!profile.mollie_customer_id || !profile.mollie_subscription_id) {
    throw new BillingHttpError('Geen actief Mollie-abonnement gevonden om bij te werken.', 400);
  }
  await mollieFetch('PATCH', `/customers/${encodeURIComponent(profile.mollie_customer_id)}/subscriptions/${encodeURIComponent(profile.mollie_subscription_id)}`, {
    amount: { currency: plan.currency, value: formatAmount(amountCents) },
    description,
  });
}

async function recordPaymentRecord(organizationId: string, profileId: string, paymentType: string, providerPaymentId: string, amountCents: number, currency: string, planKey: string, userId: string): Promise<void> {
  await supabaseAdmin
    .from('organization_payment_records')
    .insert({
      organization_id: organizationId,
      billing_profile_id: profileId,
      payment_type: paymentType,
      provider: 'mollie',
      provider_payment_id: providerPaymentId,
      status: 'open',
      amount_cents: amountCents,
      currency,
      plan_key: planKey,
      created_by: userId,
      metadata: { source: 'billing_function' },
    });
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

async function handleMollieWebhook(req: Request, url: URL, body: Record<string, string>): Promise<Response> {
  if (!MOLLIE_ALLOW_MOCK) assertMollieConfigured();
  if (MOLLIE_WEBHOOK_SECRET && !timingSafeEqual(url.searchParams.get('secret') || '', MOLLIE_WEBHOOK_SECRET)) {
    return json(req, { ok: false, error: 'Unauthorized webhook.' }, 401);
  }
  const paymentId = String(body.id || body.paymentId || '');
  if (!paymentId) return json(req, { ok: false, error: 'Mollie payment id ontbreekt.' }, 400);

  const payment = MOLLIE_ALLOW_MOCK && paymentId.startsWith('mock_payment_')
    ? null
    : await mollieFetch('GET', `/payments/${encodeURIComponent(paymentId)}`);

  if (!payment) return json(req, { ok: true, ignored: true });

  const status = normalizeStatus(String(payment.status || 'open'));
  const metadata = (payment.metadata as Record<string, unknown> | null) || {};
  const metaType = String(metadata.type || '');
  const subscriptionId = String(payment.subscriptionId || '');
  const customerId = String(payment.customerId || '');

  const organizationId = await resolveWebhookOrganization(String(metadata.organizationId || ''), subscriptionId, customerId);
  if (!organizationId) return json(req, { ok: true, ignored: true });

  const eventKey = `mollie:payment:${paymentId}:${status}`;
  const shouldProcess = await claimBillingEvent(organizationId, eventKey, `payment.${status}`, paymentId, payment);
  if (!shouldProcess) return json(req, { ok: true, deduped: true });

  // Lokale betaalstatus bijwerken (traceability).
  await supabaseAdmin
    .from('organization_payment_records')
    .update({ status, raw_payload: payment, updated_at: new Date().toISOString() })
    .eq('provider', 'mollie')
    .eq('provider_payment_id', paymentId);

  if (metaType === 'subscription_first') {
    if (status === 'paid') {
      await activateSubscriptionFromFirstPayment(organizationId, String(metadata.planKey || ''), customerId, String(payment.mandateId || ''));
    }
  } else if (subscriptionId) {
    await supabaseAdmin.rpc('record_organization_subscription_payment', {
      p_organization_id: organizationId,
      p_payment_status: status,
    });
  }

  await supabaseAdmin
    .from('organization_billing_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() })
    .eq('event_key', eventKey);

  return json(req, { ok: true });
}

async function resolveWebhookOrganization(metaOrgId: string, subscriptionId: string, customerId: string): Promise<string | null> {
  if (metaOrgId && isUuid(metaOrgId)) return metaOrgId;
  if (subscriptionId) {
    const { data } = await supabaseAdmin
      .from('organization_billing_profiles')
      .select('organization_id')
      .eq('mollie_subscription_id', subscriptionId)
      .maybeSingle();
    if (data?.organization_id) return String(data.organization_id);
  }
  if (customerId) {
    const { data } = await supabaseAdmin
      .from('organization_billing_profiles')
      .select('organization_id')
      .eq('mollie_customer_id', customerId)
      .maybeSingle();
    if (data?.organization_id) return String(data.organization_id);
  }
  return null;
}

async function activateSubscriptionFromFirstPayment(organizationId: string, planKey: string, customerId: string, mandateId: string): Promise<void> {
  const profile = await getProfile(organizationId);
  const effectivePlanKey = planKey || profile.plan_key || 'starter';
  const plan = await getPlan(effectivePlanKey);
  const amountCents = monthlyCents(plan, profile.purchased_seats);
  const effectiveCustomerId = customerId || profile.mollie_customer_id || '';

  let subscriptionId = profile.mollie_subscription_id || '';
  if (!subscriptionId && !(MOLLIE_ALLOW_MOCK && !MOLLIE_API_KEY)) {
    const subscription = await mollieFetch('POST', `/customers/${encodeURIComponent(effectiveCustomerId)}/subscriptions`, {
      amount: { currency: plan.currency, value: formatAmount(amountCents) },
      interval: '1 month',
      description: `ResoFly ${plan.name} — maandabonnement`,
      webhookUrl: webhookUrlWithSecret(),
      mandateId: mandateId || undefined,
      metadata: { organizationId, planKey: effectivePlanKey },
    }, `sub-create:${organizationId}:${effectivePlanKey}`);
    subscriptionId = String(subscription.id || '');
  }
  if (MOLLIE_ALLOW_MOCK && !subscriptionId) subscriptionId = `mock_sub_${organizationId.slice(0, 8)}`;

  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabaseAdmin.rpc('activate_organization_subscription', {
    p_organization_id: organizationId,
    p_plan_key: effectivePlanKey,
    p_mollie_customer_id: effectiveCustomerId || null,
    p_mollie_mandate_id: mandateId || null,
    p_mollie_subscription_id: subscriptionId || null,
    p_current_period_ends_at: periodEnd,
    p_metadata: { source: 'subscription_first_paid' },
  });
  if (error) throw error;
}

// Claim een billing-event voor verwerking. Geeft true terug zolang het event nog niet
// als 'processed' is gemarkeerd (eerste keer én bij retry na een gedeeltelijke fout),
// en false zodra het al verwerkt is. Zo blijft de webhook retry-veilig én idempotent.
async function claimBillingEvent(organizationId: string, eventKey: string, eventType: string, providerPaymentId: string, payload: unknown): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from('organization_billing_events')
    .upsert({
      organization_id: organizationId,
      event_key: eventKey,
      event_type: eventType,
      event_source: 'mollie_webhook',
      provider: 'mollie',
      provider_resource_id: providerPaymentId,
      status: 'received',
      payload: payload ?? {},
    }, { onConflict: 'event_key', ignoreDuplicates: true });
  if (error) throw error;

  const { data } = await supabaseAdmin
    .from('organization_billing_events')
    .select('status')
    .eq('event_key', eventKey)
    .maybeSingle();
  return String(data?.status || 'received') !== 'processed';
}

// Dev-only: rond een mock-eerste-betaling af zonder echte Mollie-call.
async function markMockPaymentPaid(organizationId: string, providerPaymentId: string): Promise<CheckoutResult> {
  if (!MOLLIE_ALLOW_MOCK) throw new BillingHttpError('Mock payments zijn uitgeschakeld.', 403);
  if (!providerPaymentId.startsWith('mock_payment_')) throw new BillingHttpError('Alleen mock payments kunnen via deze actie worden afgerond.', 400);
  const { data: record } = await supabaseAdmin
    .from('organization_payment_records')
    .select('plan_key')
    .eq('provider', 'mollie')
    .eq('provider_payment_id', providerPaymentId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  const eventKey = `mollie:payment:${providerPaymentId}:paid`;
  const shouldProcess = await claimBillingEvent(organizationId, eventKey, 'payment.paid', providerPaymentId, { mock: true });
  if (shouldProcess) {
    await supabaseAdmin
      .from('organization_payment_records')
      .update({ status: 'paid', updated_at: new Date().toISOString() })
      .eq('provider', 'mollie')
      .eq('provider_payment_id', providerPaymentId);
    await activateSubscriptionFromFirstPayment(organizationId, String(record?.plan_key || ''), `mock_cst_${organizationId.slice(0, 8)}`, `mock_mdt_${organizationId.slice(0, 8)}`);
    await supabaseAdmin
      .from('organization_billing_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('event_key', eventKey);
  }
  return { applied: true, mock: true };
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function normalizeStatus(status: string): string {
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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
