import type { ActionDef } from './types.ts';
import { CLIENT_ACTIONS } from './clients.ts';
import { TICKETS_ACTIONS } from './tickets.ts';
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
  ...TICKETS_ACTIONS,
  ...INSIGHT_ACTIONS,
];
