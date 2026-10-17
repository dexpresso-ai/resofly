// ============================================================
// Wie mag wat met een agent — één regel voor de runner, de tests en de app.
//
// Uitgangspunt: een agent kan nooit meer dan degene namens wie hij draait.
//   - Een agent hebben mag iedereen die Gerrie mag gebruiken (module Gerrie
//     minstens "lezen"). Zo'n agent kijkt mee en vat samen.
//   - Iets laten KLAARZETTEN (mail, factuur, taak…) mag alleen wie zelf mag
//     wijzigen: een schrijvende rol én Gerrie op "volledig". Wat er klaargezet
//     wordt, voert de gebruiker daarna uit onder zijn eigen sessie, dus ook dan
//     gelden zijn eigen modulerechten nog een keer.
//   - Welke gegevens en handelingen een agent krijgt, volgt de toolcatalogus van
//     de eigenaar: die is al gefilterd op zijn modulerechten (gerrieCore).
//   - Aanpassen, starten en erop antwoorden doet alleen de eigenaar; een owner
//     of admin kan een agent van een collega pauzeren, archiveren en terugzetten
//     (toezicht), maar hem niet aanzetten — dan zou hij gaan draaien namens
//     iemand die daar niet om vroeg.
//
// Puur (alleen roles.ts), zodat node test er rechtstreeks overheen draait.
// ============================================================

import { isWriterRole, memberModuleLevel } from './roles.ts';

/** Hoeveel agents één teamlid tegelijk mag hebben (gearchiveerde tellen niet mee). */
export const MAX_AGENTS_PER_USER = 25;

/** Grenzen op het aantal voorstellen dat één run mag klaarzetten. */
export const MAX_PROPOSALS_LIMIT = 10;
export const DEFAULT_MAX_PROPOSALS = 3;

export type AgentMode = 'report' | 'propose';

export interface AgentCapabilities {
  /** Mag eigen agents hebben en beheren: Gerrie staat minstens op lezen. */
  canUse: boolean;
  /** Mag een agent iets laten klaarzetten: schrijvende rol én Gerrie volledig. */
  canPropose: boolean;
  /** Owner/admin: ziet alle agents van de organisatie en kan ze pauzeren of archiveren. */
  canOversee: boolean;
}

export function agentCapabilities(role: string, moduleAccess: Record<string, unknown> | null | undefined): AgentCapabilities {
  const gerrie = memberModuleLevel(role, moduleAccess, 'gerrie');
  return {
    canUse: gerrie !== 'none',
    canPropose: gerrie === 'write' && isWriterRole(role),
    canOversee: role === 'owner' || role === 'admin',
  };
}

/** De modus die deze gebruiker écht mag; wie niet mag wijzigen, krijgt een agent die alleen leest. */
export function allowedAgentMode(requested: unknown, caps: AgentCapabilities): AgentMode {
  return requested === 'propose' && caps.canPropose ? 'propose' : 'report';
}

/** Van wie is deze agent: de identiteit waaronder hij draait. */
export function agentOwnerId(agent: { run_as_user_id?: unknown; created_by?: unknown }): string | null {
  const owner = agent.run_as_user_id ?? agent.created_by;
  return typeof owner === 'string' && owner ? owner : null;
}

export type AgentAction = 'edit' | 'run' | 'reply' | 'activate' | 'share' | 'pause' | 'archive' | 'restore';

/** Mag deze gebruiker dit met deze agent? */
export function canManageAgent(
  agent: { run_as_user_id?: unknown; created_by?: unknown },
  userId: string,
  caps: AgentCapabilities,
  action: AgentAction,
): boolean {
  const owner = agentOwnerId(agent);
  const isOwner = owner !== null && owner === userId && caps.canUse;
  switch (action) {
    case 'edit':
    case 'run':
    case 'reply':
    case 'activate':
    case 'share':
      return isOwner;
    case 'pause':
    case 'archive':
    case 'restore':
      return isOwner || caps.canOversee;
  }
}

/** De zin die de gebruiker leest als het niet mag. */
export function manageRefusal(action: AgentAction): string {
  return action === 'pause' || action === 'archive' || action === 'restore'
    ? 'Deze agent is van een collega. Alleen die collega, of een owner of admin, kan hem pauzeren of archiveren.'
    : 'Deze agent draait namens een collega, met diens rechten. Alleen die collega kan hem aanpassen, aanzetten, starten of erop antwoorden.';
}

/** Mag deze gebruiker deze agent als startpunt voor een eigen agent gebruiken? */
export function canCloneAgent(
  agent: { run_as_user_id?: unknown; created_by?: unknown; visibility?: unknown },
  userId: string,
  caps: AgentCapabilities,
): boolean {
  if (!caps.canUse) return false;
  return agentOwnerId(agent) === userId || agent.visibility === 'team' || caps.canOversee;
}

/** Eén regel uit de toolcatalogus van een gebruiker (al gefilterd op zijn rechten). */
export interface AgentCatalogEntry { name: string; kind: 'read' | 'propose' }

/**
 * Welke tools een agent van deze gebruiker echt krijgt.
 *
 * Alleen wat in ZIJN catalogus staat (dus binnen zijn modulerechten), in de
 * volgorde waarin hij ze koos, zonder dubbelingen; en bij een agent die alleen
 * leest valt alles wat iets klaarzet eraf. `dropped` zegt wat er afviel, zodat
 * de app dat kan melden in plaats van het stil weg te laten.
 */
export function permittedAgentTools(
  requested: readonly unknown[],
  catalog: readonly AgentCatalogEntry[],
  mode: AgentMode,
): { tools: string[]; dropped: string[] } {
  const kinds = new Map(catalog.map((entry) => [entry.name, entry.kind]));
  const tools: string[] = [];
  const dropped: string[] = [];
  for (const raw of requested) {
    const name = String(raw ?? '').trim();
    if (!name || tools.includes(name) || dropped.includes(name)) continue;
    const kind = kinds.get(name);
    if (!kind || (mode === 'report' && kind !== 'read')) dropped.push(name);
    else tools.push(name);
  }
  return { tools, dropped };
}
