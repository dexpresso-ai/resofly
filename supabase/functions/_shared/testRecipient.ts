// ============================================================
// Een testmail gaat alleen naar het eigen team.
//
// De knoppen "Stuur testmail" (campagnes en het mailsjabloon) stuurden naar
// elk adres dat je invulde, met de platform-afzender en zonder limiet. Zo was
// elke organisatie een open relay: een lus over sendTestCampaign met een eigen
// tekst bereikte elk adres op internet. Testen kan nog steeds, naar je eigen
// adres of naar een actief teamlid van de organisatie.
//
// isTeamTestRecipient is puur (testRecipient.test.ts); assertTeamTestRecipient
// leest de actieve leden met de service-role.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export const TEST_RECIPIENT_MESSAGE =
  'Een testmail gaat alleen naar je eigen adres of naar een actief teamlid van deze organisatie.';

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Mag een testmail naar dit adres: het eigen adres of dat van een actief teamlid? */
export function isTeamTestRecipient(recipient: string, callerEmail: string | undefined, memberEmails: string[]): boolean {
  const target = normalize(recipient);
  if (!target) return false;
  if (target === normalize(callerEmail)) return true;
  return memberEmails.some((email) => normalize(email) === target);
}

/** Gooit `makeError(...)` als het adres niet het eigen adres of dat van een actief teamlid is. */
export async function assertTeamTestRecipient(
  admin: SupabaseClient,
  organizationId: string,
  recipient: string,
  callerEmail: string | undefined,
  makeError: (message: string, status: 403 | 500) => Error,
): Promise<void> {
  if (isTeamTestRecipient(recipient, callerEmail, [])) return;
  const { data, error } = await admin
    .from('organization_members')
    .select('email')
    .eq('organization_id', organizationId)
    .eq('status', 'active');
  if (error) throw makeError(`Teamleden ophalen mislukt: ${error.message}`, 500);
  const emails = (data || []).map((row: { email?: string | null }) => String(row.email || ''));
  if (!isTeamTestRecipient(recipient, callerEmail, emails)) throw makeError(TEST_RECIPIENT_MESSAGE, 403);
}
