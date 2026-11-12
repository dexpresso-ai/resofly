// ============================================================
// Staat Gerrie aan? — één regel voor elke deur naar de AI.
//
// Een gebruiker zet Gerrie zelf aan, per organisatie, en gaat daarbij akkoord
// met drie punten: de AI leest je gegevens en stelt op basis daarvan
// handelingen voor, de AI kan fouten maken, en de AI beslist niets zelf
// (migratie 20261112190000, tabel ai_consents).
//
// De edge functions draaien met de service-role en komen dus niet langs RLS.
// Elke plek waar gegevens naar een model gaan, weegt het akkoord daarom hier:
// gerrie-agent, gerrie-agent-runner (ook bij elke geplande run), gerrie-signals
// (kaarten die Gerrie beoordeelt) en de MCP-koppeling. aiConsent.test.ts
// controleert dat ze dat ook doen.
//
// Puur (alleen een type-import), zodat `npm test` er rechtstreeks overheen draait.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

/**
 * De versie van de tekst waarmee iemand akkoord ging. Spiegel van
 * public.ai_terms_version() en van AI_TERMS_VERSION in src/lib/aiConsent.ts.
 * Hoog op als de tekst wezenlijk verandert: wie onder een oudere versie
 * akkoord ging, leest dan eerst de nieuwe.
 */
export const AI_TERMS_VERSION = '2026-11-12';

/** De zin die de gebruiker leest als Gerrie voor hem uit staat. */
export const AI_CONSENT_REFUSAL =
  'Gerrie staat voor jou nog uit in deze organisatie. Zet hem aan onder Gerrie of onder Instellingen → AI, en lees daar wat dat betekent.';

export interface AiConsentRow {
  enabled?: unknown;
  terms_version?: unknown;
}

/** Aan, en onder de tekst die nu geldt. Een akkoord op een oudere tekst telt niet. */
export function consentIsActive(row: AiConsentRow | null | undefined): boolean {
  return Boolean(row && row.enabled === true && row.terms_version === AI_TERMS_VERSION);
}

/**
 * Heeft deze gebruiker Gerrie in deze organisatie aangezet?
 *
 * Bij een fout van de database: nee. Liever een keer geen Gerrie dan gegevens
 * naar een model zonder akkoord.
 */
export async function hasAiConsent(admin: SupabaseClient, userId: string, organizationId: string): Promise<boolean> {
  if (!userId || !organizationId) return false;
  const { data, error } = await admin.from('ai_consents')
    .select('enabled, terms_version')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('ai_consents lezen mislukt; Gerrie blijft dicht', error.message);
    return false;
  }
  return consentIsActive(data as AiConsentRow | null);
}
