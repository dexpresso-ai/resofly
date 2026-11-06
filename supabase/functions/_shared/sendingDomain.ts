// Gedeelde helper: kies het afzenderadres voor een organisatie.
//
// Als de organisatie een geverifieerd eigen verzenddomein heeft (onderdeel A),
// versturen we vanaf dát adres. Anders valt alles terug op het globale
// RESEND_FROM_EMAIL. De helper gooit nooit: bij elke fout valt hij stil terug op
// de meegegeven fallback, zodat het inhaken in bestaande (betaalkritische)
// verzendpaden veilig is en het gedrag ongewijzigd blijft voor organisaties
// zonder eigen domein.
//
// Optioneel kan een userId worden meegegeven: dan wordt de persoonlijke afzender
// van dat teamlid (user_sender_identities) toegepast — de naam altijd, het adres
// alleen wanneer het domein ervan op dit moment een GEVERIFIEERD verzenddomein
// van de organisatie is (anti-spoofing; verificatie intrekken = terugvallen).
//
// Reply-To: vertrekt de mail vanaf het eigen domein, dan komen antwoorden op
// dát adres terug. Eerst bleef de Reply-To ook dan het algemene ResoFly-adres
// (RESEND_REPLY_TO): een klant die op een factuur van info@bedrijf.nl
// antwoordde, mailde zonder het te zien naar ResoFly in plaats van naar het
// bedrijf.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { formatFromHeader, isPlainEmailAddress } from './resendDomains.ts';

export interface SenderIdentity {
  /** Volledige From-waarde voor Resend ("Naam <adres>" of "adres"). */
  from: string;
  /** Reply-To: het eigen afzenderadres, of bij terugvallen de globale Reply-To. */
  replyTo?: string;
  /** Id van het gebruikte verzenddomein, of null bij fallback. */
  domainId: string | null;
  /** Het kale afzender-e-mailadres, of null bij fallback. */
  fromEmail: string | null;
}

type VerifiedDomainRow = {
  id: string;
  domain: string;
  from_email: string | null;
  from_name: string | null;
  is_default: boolean;
  created_at: string;
};

export async function resolveSenderIdentity(
  supabaseAdmin: SupabaseClient,
  organizationId: string,
  fallbackFrom: string,
  fallbackReplyTo?: string,
  userId?: string | null,
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
      .select('id,domain,from_email,from_name,status,is_default,created_at')
      .eq('organization_id', organizationId)
      .eq('status', 'verified')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) return fallback;
    const verified = (data || []) as VerifiedDomainRow[];

    // Basis-identiteit van de organisatie: het standaarddomein, anders het meest
    // recent gekoppelde, met een bruikbaar afzenderadres. Een adres dat niet kaal
    // op het eigen domein staat, slaan we over: dan zou de From-header meer
    // kunnen bevatten dan één afzender. Een domein zonder afzenderadres (kon tot
    // november 2026) sloeg eerst alles over, ook een tweede domein dat er wél een
    // had.
    const usableEmail = (row: VerifiedDomainRow): string | null => {
      const email = String(row.from_email || '').trim().toLowerCase();
      return isPlainEmailAddress(email) && email.endsWith(`@${String(row.domain).toLowerCase()}`) ? email : null;
    };
    const primary = verified.find((row) => usableEmail(row)) ?? verified[0] ?? null;
    let fromEmail = primary ? usableEmail(primary) : null;
    let fromName = String(primary?.from_name || '').trim() || null;
    let domainId = primary ? String(primary.id) : null;

    // Persoonlijke afzender van het teamlid, indien ingesteld.
    if (userId) {
      try {
        const { data: personal } = await supabaseAdmin
          .from('user_sender_identities')
          .select('from_name,from_email')
          .eq('organization_id', organizationId)
          .eq('user_id', userId)
          .maybeSingle();
        if (personal) {
          const personalName = String(personal.from_name || '').trim();
          if (personalName) fromName = personalName;
          const personalEmail = String(personal.from_email || '').trim().toLowerCase();
          if (personalEmail && isPlainEmailAddress(personalEmail)) {
            const atIndex = personalEmail.lastIndexOf('@');
            const personalDomain = atIndex > 0 ? personalEmail.slice(atIndex + 1) : '';
            const match = verified.find((row) => String(row.domain).toLowerCase() === personalDomain);
            if (match) {
              fromEmail = personalEmail;
              domainId = String(match.id);
            }
          }
        }
      } catch (_personalError) {
        // Persoonlijke voorkeur is best-effort; org-identiteit blijft leidend.
      }
    }

    // Zonder concreet afzenderadres kunnen we geen persoonlijke From opbouwen —
    // dan het bestaande gedrag: de globale fallback ongewijzigd.
    if (!fromEmail) return fallback;

    // De naam vult een teamlid zelf in: formatFromHeader haalt aanhalingstekens,
    // hoekhaken, komma's en regeleinden weg en zet hem tussen quotes, zodat hij
    // nooit een tweede adres in de From-header kan worden.
    return { from: formatFromHeader(fromName, fromEmail), replyTo: fromEmail, domainId, fromEmail };
  } catch (_error) {
    return fallback;
  }
}
