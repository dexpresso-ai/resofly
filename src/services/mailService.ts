import { throwFunctionError } from '../lib/functionErrors';
import { supabase } from '../lib/supabase';
import type { SendingDomain, UUID } from '../types';

export interface SendResendTestEmailResult {
  providerEmailId: string;
  recipientEmail: string;
}

export async function sendResendTestEmail(
  organizationId: UUID,
  input: { recipientEmail: string; recipientName?: string },
): Promise<SendResendTestEmailResult> {
  const { data, error } = await supabase.functions.invoke('mail', {
    body: {
      action: 'sendTestEmail',
      organizationId,
      recipientEmail: input.recipientEmail,
      recipientName: input.recipientName,
    },
  });

  if (error) await throwFunctionError(error, 'Testmail verzenden mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Testmail verzenden mislukt.');

  return {
    providerEmailId: String(data.providerEmailId || ''),
    recipientEmail: String(data.recipientEmail || input.recipientEmail),
  };
}

// ── Eigen-domein e-mail: verzenddomeinen beheren ────────────────────────────
// Aanmaken/verifiëren/verwijderen vereist Resend-API-calls met de gedeelde
// server-key, dus dit loopt via de `mail` Edge Function (service role). De
// functie dwingt zelf owner/admin-rechten af.

async function invokeDomainAction(
  action: string,
  organizationId: UUID,
  payload: Record<string, unknown>,
  failureMessage: string,
): Promise<SendingDomain> {
  const { data, error } = await supabase.functions.invoke('mail', {
    body: { action, organizationId, ...payload },
  });
  if (error) await throwFunctionError(error, failureMessage);
  if (!data?.ok) throw new Error(data?.error || failureMessage);
  return data.domain as SendingDomain;
}

/** Registreer een nieuw verzenddomein bij Resend en sla de DNS-records op. */
export async function addSendingDomain(
  organizationId: UUID,
  input: { domain: string; fromEmail?: string; fromName?: string },
): Promise<SendingDomain> {
  return invokeDomainAction(
    'addSendingDomain',
    organizationId,
    { domain: input.domain, fromEmail: input.fromEmail, fromName: input.fromName },
    'Domein toevoegen mislukt.',
  );
}

/** Vraag Resend om de DNS-records (opnieuw) te controleren en werk de status bij. */
export async function verifySendingDomain(
  organizationId: UUID,
  domainId: UUID,
): Promise<SendingDomain> {
  return invokeDomainAction(
    'verifySendingDomain',
    organizationId,
    { domainId },
    'Domeinverificatie mislukt.',
  );
}

/** Werk het afzenderadres/de naam bij of maak dit domein het standaard verzenddomein. */
export async function updateSendingDomain(
  organizationId: UUID,
  domainId: UUID,
  patch: { fromEmail?: string; fromName?: string; isDefault?: boolean },
): Promise<SendingDomain> {
  return invokeDomainAction(
    'updateSendingDomain',
    organizationId,
    { domainId, ...patch },
    'Verzenddomein bijwerken mislukt.',
  );
}

/** Verwijder het verzenddomein (ook bij Resend, best-effort). */
export async function removeSendingDomain(
  organizationId: UUID,
  domainId: UUID,
): Promise<void> {
  const { data, error } = await supabase.functions.invoke('mail', {
    body: { action: 'removeSendingDomain', organizationId, domainId },
  });
  if (error) await throwFunctionError(error, 'Verzenddomein verwijderen mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'Verzenddomein verwijderen mislukt.');
}
