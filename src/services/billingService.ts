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

// Start (of herstart) een doorlopend abonnement op ResoFly's eigen Mollie-account.
// Geeft een checkout-URL terug voor de eerste betaling (mandaat). De webhook maakt
// daarna het maandelijkse Mollie-abonnement aan en zet het profiel op 'active'.
export async function startSubscriptionCheckout(organizationId: UUID, planKey?: string, interval: 'month' | 'year' = 'month', creative?: boolean): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('startSubscriptionCheckout', {
    organizationId,
    planKey,
    interval,
    creative,
    returnUrl: window.location.href,
  });
}

// Creatieve module (galerij-oplevering) aan- of uitzetten op een lopend mandaat.
// Uitzetten bevriest: al gedeelde galerijen blijven de respijtperiode werken.
export async function setCreativeAddon(organizationId: UUID, enabled: boolean): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('setCreativeAddon', {
    organizationId,
    enabled,
  });
}

// Zakelijke module (BV-boekhouding, vennootschapsbelasting, jaarrekening) aan-
// of uitzetten. Uitzetten bevriest: bestaande administraties blijven de
// respijtperiode leesbaar.
export async function setBusinessAddon(organizationId: UUID, enabled: boolean): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('setBusinessAddon', {
    organizationId,
    enabled,
  });
}

// Extra gebruiker(s): past het abonnementsbedrag direct aan op een lopend mandaat.
export async function createExtraSeatCheckout(organizationId: UUID, quantity = 1): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('createExtraSeatCheckout', {
    organizationId,
    quantity,
    returnUrl: window.location.href,
  });
}

// Opslagbundel(s) bijkopen (accountbrede opslag): past het abonnementsbedrag
// direct aan op een lopend mandaat, zoals extra seats.
export async function createStorageAddonCheckout(organizationId: UUID, quantity = 1): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('createStorageAddonCheckout', {
    organizationId,
    quantity,
  });
}

// Planwijziging: past het bedrag aan (actief abonnement) of start een nieuw
// abonnement op het gekozen plan (nog geen abonnement).
export async function createPlanChangeCheckout(organizationId: UUID, planKey: string): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('createPlanChangeCheckout', {
    organizationId,
    planKey,
    returnUrl: window.location.href,
  });
}

export async function cancelSubscription(organizationId: UUID): Promise<BillingCheckoutResult> {
  return await invokeBillingFunction<BillingCheckoutResult>('cancelSubscription', { organizationId });
}

export async function markMockPaymentPaid(organizationId: UUID, providerPaymentId: string): Promise<void> {
  await invokeBillingFunction<BillingCheckoutResult>('markMockPaymentPaid', { organizationId, providerPaymentId });
}

export async function changeOrganizationPlan(organizationId: UUID, planKey: string): Promise<BillingCheckoutResult> {
  return await createPlanChangeCheckout(organizationId, planKey);
}

async function invokeBillingFunction<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data: sessionData, error: sessionError } = await supabaseAuth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session?.access_token) throw new Error('Je bent niet ingelogd.');

  const { data, error } = await supabase.functions.invoke<FunctionResponse<T>>('billing', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
  });
  if (error) {
    // supabase-js geeft bij een non-2xx een generieke FunctionsHttpError; de echte
    // (Nederlandstalige) servermelding zit in de response-body.
    const serverMessage = await extractFunctionErrorMessage(error);
    throw new Error(serverMessage || (error instanceof Error ? error.message : 'Billing-actie mislukt.'));
  }
  if (!data) throw new Error('Geen response van billing-functie ontvangen.');
  if (data.error) throw new Error(data.error);
  return data as T;
}

async function extractFunctionErrorMessage(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown })?.context;
  if (context && typeof (context as Response).clone === 'function') {
    try {
      const body = await (context as Response).clone().json();
      if (body && typeof body.error === 'string') return body.error;
    } catch { /* body niet als JSON leesbaar */ }
  }
  return null;
}
