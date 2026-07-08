import { throwFunctionError } from './functionErrors';
import { supabase } from './supabase';
import type { CampaignAudience, CampaignAudiencePreview, UUID } from '../types';

// Service-laag voor de `campaigns` Edge Function. Campagne-/suppressie-CRUD loopt
// via RLS (repository.ts); hier zitten alleen de acties die de service-role nodig
// hebben: doelgroep-telling, test-/echte verzending en plannen/pauzeren.

async function invokeCampaigns<T = Record<string, unknown>>(
  organizationId: UUID,
  action: string,
  payload: Record<string, unknown>,
  failureMessage: string,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke('campaigns', {
    body: { action, organizationId, ...payload },
  });
  if (error) await throwFunctionError(error, failureMessage);
  if (!data?.ok) throw new Error(data?.error || failureMessage);
  return data as T;
}

/** Live telling van de doelgroep (na suppressie- en 'geen e-mail'-aftrek). */
export async function previewCampaignAudience(
  organizationId: UUID,
  audience: CampaignAudience,
): Promise<CampaignAudiencePreview> {
  const data = await invokeCampaigns<CampaignAudiencePreview & { ok: boolean }>(
    organizationId,
    'previewAudience',
    { audience },
    'Doelgroep berekenen mislukt.',
  );
  return {
    total: Number(data.total || 0),
    sendable: Number(data.sendable || 0),
    suppressed: Number(data.suppressed || 0),
    withoutEmail: Number(data.withoutEmail || 0),
    matchedClients: Number(data.matchedClients || 0),
    sample: Array.isArray(data.sample) ? data.sample : [],
  };
}

/** Verstuur een testmail van de campagne naar één adres (geen tracking). */
export async function sendTestCampaign(
  organizationId: UUID,
  campaignId: UUID,
  testEmail: string,
): Promise<{ providerEmailId: string; recipientEmail: string }> {
  const data = await invokeCampaigns<{ providerEmailId?: string; recipientEmail?: string }>(
    organizationId,
    'sendTestCampaign',
    { campaignId, testEmail },
    'Testmail versturen mislukt.',
  );
  return {
    providerEmailId: String(data.providerEmailId || ''),
    recipientEmail: String(data.recipientEmail || testEmail),
  };
}

/** Materialiseer de ontvangers en start de verzending (eerste batch direct). */
export async function sendCampaign(
  organizationId: UUID,
  campaignId: UUID,
): Promise<{ materialized: number; sent: number; failed: number; remaining: number }> {
  const data = await invokeCampaigns<{ materialized?: number; sent?: number; failed?: number; remaining?: number }>(
    organizationId,
    'sendCampaign',
    { campaignId },
    'Campagne versturen mislukt.',
  );
  return {
    materialized: Number(data.materialized || 0),
    sent: Number(data.sent || 0),
    failed: Number(data.failed || 0),
    remaining: Number(data.remaining || 0),
  };
}

/** Plan de campagne in voor een later verzendmoment. */
export async function scheduleCampaign(
  organizationId: UUID,
  campaignId: UUID,
  scheduledAt: string,
): Promise<void> {
  await invokeCampaigns(organizationId, 'scheduleCampaign', { campaignId, scheduledAt }, 'Campagne inplannen mislukt.');
}

export async function pauseCampaign(organizationId: UUID, campaignId: UUID): Promise<void> {
  await invokeCampaigns(organizationId, 'pauseCampaign', { campaignId }, 'Campagne pauzeren mislukt.');
}

export async function resumeCampaign(organizationId: UUID, campaignId: UUID): Promise<void> {
  await invokeCampaigns(organizationId, 'resumeCampaign', { campaignId }, 'Campagne hervatten mislukt.');
}

export async function cancelCampaign(organizationId: UUID, campaignId: UUID): Promise<void> {
  await invokeCampaigns(organizationId, 'cancelCampaign', { campaignId }, 'Campagne annuleren mislukt.');
}
