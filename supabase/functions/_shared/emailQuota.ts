// ============================================================
// Mailquotum per organisatie (migratie 20261101050000).
//
// Alle organisaties delen één Resend-account en één platform-afzender. Een
// organisatie die spamt of phisht, raakt anders de verzending van iedereen.
// email_quota_take telt per uur; standaard 200 per uur en 1000 per 24 uur.
//
// Faalt de teller zelf (database onbereikbaar, migratie nog niet gedraaid),
// dan gaat de mail door en komt er een waarschuwing in de log: een kapotte
// teller mag de facturen van alle klanten niet stilleggen. Een aanvaller kan
// de teller niet laten falen; "te veel" is altijd een harde nee.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export type QuotaAnswer = { ok: boolean; hour?: number; day?: number; hourly_limit?: number; daily_limit?: number };

/** De zin voor de gebruiker als het quotum op is, of null als het mag. */
export function quotaRefusal(answer: QuotaAnswer | null): string | null {
  if (!answer || answer.ok !== false) return null;
  const perHour = answer.hourly_limit ?? 0;
  const perDay = answer.daily_limit ?? 0;
  return `Deze werkruimte heeft de grens voor e-mail bereikt (${perHour} per uur, ${perDay} per dag). `
    + 'Probeer het later opnieuw, of neem contact op met ResoFly als je structureel meer nodig hebt.';
}

/** Telt `count` mails voor deze organisatie, of gooit `makeError` (429) als dat niet meer past. */
export async function takeEmailQuota(
  admin: SupabaseClient,
  organizationId: string,
  count: number,
  makeError: (message: string, status: 429) => Error,
): Promise<void> {
  const { data, error } = await admin.rpc('email_quota_take', { p_organization_id: organizationId, p_count: Math.max(1, Math.floor(count)) });
  if (error) {
    console.warn('email_quota_take mislukt; de mail gaat door zonder telling', error.message);
    return;
  }
  const refusal = quotaRefusal(data as QuotaAnswer | null);
  if (refusal) throw makeError(refusal, 429);
}
