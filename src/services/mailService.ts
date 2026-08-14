import { throwFunctionError } from '../lib/functionErrors';
import { supabase } from '../lib/supabase';
import type { SendingDomain, UserSenderIdentity, UUID } from '../types';

// ── Wie staat er straks als afzender? ───────────────────────────────────────
//
// De server beslist dit (functions/_shared/sendingDomain.ts) en doet dat pas op
// het moment van verzenden. Wie een mail schrijft ziet dus nergens vanaf welk
// adres hij vertrekt — en zonder geverifieerd eigen domein is dat het algemene
// ResoFly-adres. Deze functie herhaalt diezelfde regels in de browser, puur om
// het vóóraf te kunnen tonen. Ze bepaalt niets: wijkt hij ooit af, dan wint de
// server.

export interface EffectiveSender {
  /** Het adres waarmee de mail vertrekt; null als er (nog) geen eigen domein staat. */
  email: string | null;
  /** De naam die de ontvanger boven het adres ziet. */
  name: string | null;
  /** true = er is geen geverifieerd eigen domein, dus het algemene ResoFly-adres. */
  fallback: boolean;
}

/**
 * Spiegelt `resolveSenderIdentity` uit de Edge Function:
 * 1. het standaard geverifieerde domein van de organisatie (anders het meest
 *    recent geverifieerde),
 * 2. de persoonlijke naam van het teamlid overschrijft de organisatienaam,
 * 3. het persoonlijke adres telt alleen mee als het domein ervan op dit moment
 *    geverifieerd is — anders zou je namens een willekeurig domein kunnen
 *    versturen.
 */
export function resolveEffectiveSender(
  domains: SendingDomain[],
  identity: UserSenderIdentity | null,
): EffectiveSender {
  const verified = domains
    .filter(d => d.status === 'verified')
    .sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return (b.created_at ?? '').localeCompare(a.created_at ?? '');
    });
  const primary = verified[0] ?? null;

  let email = primary?.from_email ? String(primary.from_email) : null;
  let name = String(primary?.from_name || '').trim() || null;

  const personalName = String(identity?.from_name || '').trim();
  if (personalName) name = personalName;

  const personalEmail = String(identity?.from_email || '').trim().toLowerCase();
  if (personalEmail) {
    const at = personalEmail.lastIndexOf('@');
    const personalDomain = at > 0 ? personalEmail.slice(at + 1) : '';
    if (verified.some(d => String(d.domain).toLowerCase() === personalDomain)) email = personalEmail;
  }

  if (!email) return { email: null, name: null, fallback: true };
  return { email, name, fallback: false };
}

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

// ── Vrije klant-mail versturen ──────────────────────────────────────────────

export interface SendClientEmailResult {
  threadId: UUID;
  clientEmailId: UUID;
  providerEmailId: string;
  recipientEmail: string;
}

/**
 * Verstuur een vrije e-mail naar een klant vanaf het geverifieerde verzenddomein
 * (valt terug op het globale afzenderadres). De mail wordt server-side verstuurd
 * en gelogd; statusupdates komen via de Resend-webhook binnen.
 */
export async function sendClientEmail(
  organizationId: UUID,
  input: { clientId: UUID; subject: string; bodyHtml: string; bodyText?: string },
): Promise<SendClientEmailResult> {
  const { data, error } = await supabase.functions.invoke('mail', {
    body: {
      action: 'sendClientEmail',
      organizationId,
      clientId: input.clientId,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText,
    },
  });
  if (error) await throwFunctionError(error, 'E-mail versturen mislukt.');
  if (!data?.ok) throw new Error(data?.error || 'E-mail versturen mislukt.');
  return {
    threadId: String(data.threadId || ''),
    clientEmailId: String(data.clientEmailId || ''),
    providerEmailId: String(data.providerEmailId || ''),
    recipientEmail: String(data.recipientEmail || ''),
  };
}
