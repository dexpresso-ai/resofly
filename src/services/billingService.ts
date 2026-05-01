import { supabase, supabaseAuth } from '../lib/supabase';
import type { BillingCheckoutResult, BillingPlan, OrganizationBillingOverview, UUID } from '../types';

type FunctionResponse<T> = { ok?: boolean; error?: string } & T;

export async function loadBillingPlans(): Promise<BillingPlan[]> {
  const { data, error } = await supabase
    .from('billing_plans')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as BillingPlan[];
}

export function getSelfServiceBillingPlans(plans: BillingPlan[]): BillingPlan[] {
  return plans.filter(plan => !plan.is_custom);
}

export async function loadBillingOverview(organizationId: UUID): Promise<OrganizationBillingOverview | null> {
  const { data, error } = await supabase.rpc('organization_billing_overview', { p_organization_id: organizationId });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as OrganizationBillingOverview | null;
}

export async function startMollieConnect(organizationId: UUID): Promise<{ authUrl?: string; mockConnected?: boolean }> {
  return invokeBillingFunction<{ authUrl?: string; mockConnected?: boolean }>('connectStart', {
    organizationId,
    returnTo: window.location.href,
  });
}

export async function createExtraSeatCheckout(organizationId: UUID, quantity = 1): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('createExtraSeatCheckout', {
    organizationId,
    quantity,
    returnUrl: window.location.href,
    idempotencyKey: createCheckoutIdempotencyKey('extra-seat', organizationId, String(quantity)),
  });
}

export async function createPlanChangeCheckout(organizationId: UUID, planKey: string): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('createPlanChangeCheckout', {
    organizationId,
    planKey,
    returnUrl: window.location.href,
    idempotencyKey: createCheckoutIdempotencyKey('plan-change', organizationId, planKey),
  });
}

export async function markMockPaymentPaid(organizationId: UUID, providerPaymentId: string): Promise<void> {
  await invokeBillingFunction<{ payment: unknown }>('markMockPaymentPaid', { organizationId, providerPaymentId });
}

export async function changeOrganizationPlan(organizationId: UUID, planKey: string): Promise<BillingCheckoutResult> {
  return await createPlanChangeCheckout(organizationId, planKey);
}

function createCheckoutIdempotencyKey(kind: string, organizationId: UUID, variant: string): string {
  const safeVariant = variant.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'default';
  const bucket = Math.floor(Date.now() / (30 * 60 * 1000));
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${kind}:${organizationId}:${safeVariant}:${bucket}:${random}`;
}

async function invokeBillingFunction<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data: sessionData, error: sessionError } = await supabaseAuth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session?.access_token) throw new Error('Je bent niet ingelogd.');

  const { data, error } = await supabase.functions.invoke<FunctionResponse<T>>('billing', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
  });
  if (error) throw error;
  if (!data) throw new Error('Geen response van billing-functie ontvangen.');
  if (data.error) throw new Error(data.error);
  return data as T;
}
