import { CLIENT_EXECUTORS } from './clients';
import { FINANCE_EXECUTORS } from './finance';
import { BOOKKEEPING_EXECUTORS } from './bookkeeping';
import { BUSINESS_EXECUTORS } from './business';
import { PROJECTS_EXECUTORS } from './projects';
import { CALENDAR_EXECUTORS } from './calendar';
import { TICKETS_EXECUTORS } from './tickets';
import { MARKETING_EXECUTORS } from './marketing';
import { ADMIN_EXECUTORS } from './admin';
import { INSIGHT_EXECUTORS } from './insight';
import type { ActionExecutor, ActionRunCtx } from './types';

export type { ActionExecutor, ActionRunCtx } from './types';

/**
 * Alle uitvoerders van de handelingenregistry, op handeling-id.
 *
 * Deze tabel is de browserkant van `supabase/functions/_shared/actions/`. Wat daar
 * als handeling staat, hoort hier een uitvoerder te hebben — anders zet Gerrie iets
 * klaar dat bij het akkoord blijft steken. `npm test` vergelijkt de twee lijsten en
 * slaat alarm zodra er een uit de pas loopt.
 *
 * Het bovenste deel van dit bestand wordt gegenereerd uit de domeinen die er liggen.
 */
export const ACTION_EXECUTORS: Record<string, ActionExecutor> = {
  ...CLIENT_EXECUTORS,
  ...FINANCE_EXECUTORS,
  ...BOOKKEEPING_EXECUTORS,
  ...BUSINESS_EXECUTORS,
  ...PROJECTS_EXECUTORS,
  ...CALENDAR_EXECUTORS,
  ...TICKETS_EXECUTORS,
  ...MARKETING_EXECUTORS,
  ...ADMIN_EXECUTORS,
  ...INSIGHT_EXECUTORS,
};

/** Voert een goedgekeurde handeling uit en geeft de bevestigingszin terug. */
export async function runRegistryAction(
  actionId: string,
  payload: Record<string, unknown>,
  ctx: ActionRunCtx,
): Promise<string> {
  const executor = ACTION_EXECUTORS[actionId];
  if (!executor) {
    // Kan gebeuren als de server nieuwer is dan deze pagina. Eerlijk melden is beter
    // dan doen alsof er iets gebeurd is.
    throw new Error('Deze handeling kent deze versie van de app nog niet. Herlaad de pagina en probeer het opnieuw.');
  }
  return executor(payload, ctx);
}
