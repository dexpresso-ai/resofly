import type { ActionDef } from './types.ts';
import { CLIENT_ACTIONS } from './clients.ts';
import { FINANCE_ACTIONS } from './finance.ts';
import { BOOKKEEPING_ACTIONS } from './bookkeeping.ts';
import { BUSINESS_ACTIONS } from './business.ts';
import { PROJECTS_ACTIONS } from './projects.ts';
import { CALENDAR_ACTIONS } from './calendar.ts';
import { TICKETS_ACTIONS } from './tickets.ts';
import { MARKETING_ACTIONS } from './marketing.ts';
import { ADMIN_ACTIONS } from './admin.ts';
import { INSIGHT_ACTIONS } from './insight.ts';

/**
 * De volledige handelingenregistry, samengesteld uit de domeinbestanden.
 *
 * DIT BESTAND WORDT GEGENEREERD uit de domeinen die in deze map liggen. Zoeken en
 * opzoeken staat in `registry.ts`; schrijf daar je aanpassingen, niet hier.
 *
 * Een nieuw domein hoort op twee plekken: hier, én in `src/lib/actions/` met de
 * uitvoerder die de browser gebruikt zodra de gebruiker akkoord geeft. Een handeling
 * zonder uitvoerder blijft bij dat akkoord steken — `npm test` bewaakt dat.
 */
export const ACTIONS: ActionDef[] = [
  ...CLIENT_ACTIONS,
  ...FINANCE_ACTIONS,
  ...BOOKKEEPING_ACTIONS,
  ...BUSINESS_ACTIONS,
  ...PROJECTS_ACTIONS,
  ...CALENDAR_ACTIONS,
  ...TICKETS_ACTIONS,
  ...MARKETING_ACTIONS,
  ...ADMIN_ACTIONS,
  ...INSIGHT_ACTIONS,
];
