// ============================================================
// AI-budget: per gebruiker én per organisatie, per kalendermaand.
//
// Eén regel voor Gerrie, agents, notulen, de factuurscan en de factuur-inbox.
// Voorheen:
//   - zonder GERRIE_MONTHLY_USER_COST_EUR geen enkel plafond;
//   - alleen per gebruiker (meer teamleden of agents = meer kosten, zonder grens);
//   - bij een leesfout toch doorlaten.
// Nu:
//   - ontbreekt de env-var, dan geldt de standaard (een expliciete 0 = geen
//     plafond, een bewuste keuze);
//   - daarnaast een plafond per organisatie (GERRIE_MONTHLY_ORG_COST_EUR);
//   - kan het verbruik niet worden gelezen, dan nee: liever even geen AI dan
//     onbegrensde kosten.
// De rekenregels zijn puur (aiBudget.test.ts); checkAiBudget leest het
// verbruik via ai_usage_month_totals (migratie 20261101100000).
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

export const DEFAULT_MONTHLY_USER_COST_EUR = 25;
export const DEFAULT_MONTHLY_ORG_COST_EUR = 250;

/** Plafond uit een env-waarde: leeg of ongeldig = de standaard, "0" = geen plafond (0 terug). */
export function budgetLimit(raw: string | null | undefined, fallback: number): number {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

export interface AiBudget {
  allowed: boolean;
  /** Verbruik en plafond van wat het krapst zit (voor de "nog x% over"-meter). 0 = geen plafond. */
  usedEur: number;
  limitEur: number;
  /** Wat de doorslag gaf: het eigen tegoed, dat van de organisatie, of een leesfout. */
  scope: 'user' | 'org' | 'error' | null;
}

/** Het oordeel bij een verbruik. Een plafond van 0 telt niet mee. */
export function aiBudgetVerdict(userEur: number, userLimit: number, orgEur: number, orgLimit: number): AiBudget {
  const remaining = (used: number, limit: number) => (limit > 0 ? (limit - used) / limit : Number.POSITIVE_INFINITY);
  const userLeft = remaining(userEur, userLimit);
  const orgLeft = remaining(orgEur, orgLimit);
  if (userLimit > 0 && userEur >= userLimit) return { allowed: false, usedEur: userEur, limitEur: userLimit, scope: 'user' };
  if (orgLimit > 0 && orgEur >= orgLimit) return { allowed: false, usedEur: orgEur, limitEur: orgLimit, scope: 'org' };
  if (orgLeft < userLeft) return { allowed: true, usedEur: orgEur, limitEur: orgLimit, scope: null };
  return { allowed: true, usedEur: userEur, limitEur: userLimit, scope: null };
}

/** De zin voor de gebruiker als het budget op is. */
export function aiBudgetMessage(budget: AiBudget): string {
  if (budget.scope === 'org') return 'Het AI-tegoed van deze werkruimte is deze maand op. Vraag een beheerder om meer ruimte, of probeer het volgende maand opnieuw.';
  if (budget.scope === 'error') return 'Het AI-tegoed kon niet worden gecontroleerd. Probeer het zo opnieuw.';
  return 'Je hebt je AI-tegoed voor deze maand opgebruikt. Begin volgende maand kun je weer verder, of vraag een beheerder om meer ruimte.';
}

/** Leest het verbruik van deze maand en geeft het oordeel. userId of organizationId mag leeg zijn. */
export async function checkAiBudget(admin: SupabaseClient, userId: string | null, organizationId: string | null): Promise<AiBudget> {
  const env = (name: string) => (globalThis as { Deno?: { env: { get(n: string): string | undefined } } }).Deno?.env.get(name);
  const usdToEur = Number(env('GERRIE_USD_TO_EUR') || '0.92');
  const userLimit = userId ? budgetLimit(env('GERRIE_MONTHLY_USER_COST_EUR'), DEFAULT_MONTHLY_USER_COST_EUR) : 0;
  const orgLimit = organizationId ? budgetLimit(env('GERRIE_MONTHLY_ORG_COST_EUR'), DEFAULT_MONTHLY_ORG_COST_EUR) : 0;
  if (!(userLimit > 0) && !(orgLimit > 0)) return { allowed: true, usedEur: 0, limitEur: 0, scope: null };
  const { data, error } = await admin.rpc('ai_usage_month_totals', { p_user_id: userId, p_organization_id: organizationId });
  if (error) {
    console.warn('AI-budget niet te lezen; geweigerd', error.message);
    return { allowed: false, usedEur: 0, limitEur: 0, scope: 'error' };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { user_usd?: number | string; org_usd?: number | string } | null;
  return aiBudgetVerdict(Number(row?.user_usd ?? 0) * usdToEur, userLimit, Number(row?.org_usd ?? 0) * usdToEur, orgLimit);
}
