// Gedeelde helper: kies het afzenderadres voor een organisatie.
//
// Als de organisatie een geverifieerd eigen verzenddomein heeft (onderdeel A),
// versturen we vanaf dát adres. Anders valt alles terug op het globale
// RESEND_FROM_EMAIL. De helper gooit nooit: bij elke fout valt hij stil terug op
// de meegegeven fallback, zodat het inhaken in bestaande (betaalkritische)
// verzendpaden veilig is en het gedrag ongewijzigd blijft voor organisaties
// zonder eigen domein.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export interface SenderIdentity {
  /** Volledige From-waarde voor Resend ("Naam <adres>" of "adres"). */
  from: string;
  /** Optionele Reply-To-fallback. */
  replyTo?: string;
  /** Id van het gebruikte verzenddomein, of null bij fallback. */
  domainId: string | null;
  /** Het kale afzender-e-mailadres, of null bij fallback. */
  fromEmail: string | null;
}

export async function resolveSenderIdentity(
  supabaseAdmin: SupabaseClient,
  organizationId: string,
  fallbackFrom: string,
  fallbackReplyTo?: string,
): Promise<SenderIdentity> {
  const fallback: SenderIdentity = {
    from: fallbackFrom,
    replyTo: fallbackReplyTo || undefined,
    domainId: null,
    fromEmail: null,
  };

  try {
    const { data, error } = await supabaseAdmin
      .from('organization_email_domains')
      .select('id,from_email,from_name,status,is_default,created_at')
      .eq('organization_id', organizationId)
      .eq('status', 'verified')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data || !data.from_email) return fallback;

    const fromEmail = String(data.from_email);
    const fromName = String(data.from_name || '').trim();
    const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

    return { from, replyTo: fallbackReplyTo || undefined, domainId: String(data.id), fromEmail };
  } catch (_error) {
    return fallback;
  }
}
