// ============================================================
// Agents in de app: van wie is hij, waar hoort hij op het scherm, wanneer
// draait hij, en wat leverde hij deze maand op.
//
// Puur (geen Supabase, alleen type-imports), zodat node --test er rechtstreeks
// overheen draait. De regels zelf staan op de server:
//   supabase/functions/_shared/agentAccess.ts   — wie mag wat
//   supabase/functions/_shared/agentSchedule.ts — het ritme
// agents.test.ts legt deze weergave naast die twee, zodat het scherm niet iets
// anders belooft dan de runner doet.
// ============================================================

import type { AgentApproval, AgentVisibility, RoutineRunStatus, RoutineScheduleKind, RoutineStatus } from './gerrie-api';

export const DOW_NAMES = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

// ── Het ritme ────────────────────────────────────────────────────────────────

/** De velden waar het ritme van een agent uit volgt. */
export interface RhythmFields {
  schedule_kind: RoutineScheduleKind;
  hour: number;
  minute?: number | null;
  end_hour?: number | null;
  day_of_week?: number | null;
  day_of_month?: number | null;
}

export function clock(hour: number, minute = 0): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Het laatste uur van een "elk uur"-venster: zelfde regel als normalizeSchedule (standaard 17, nooit vóór het begin). */
export function hourlyEnd(r: Pick<RhythmFields, 'hour' | 'end_hour'>): number {
  return Math.max(r.hour, r.end_hour ?? 17);
}

/** Het ritme in een volzin: "Elke werkdag om 08:30". */
export function scheduleLabel(r: RhythmFields): string {
  const minute = r.minute ?? 0;
  const t = clock(r.hour, minute);
  switch (r.schedule_kind) {
    case 'daily': return `Elke dag om ${t}`;
    case 'weekdays': return `Elke werkdag om ${t}`;
    case 'weekly': return `Elke ${DOW_NAMES[(r.day_of_week ?? 1) - 1] ?? DOW_NAMES[0]} om ${t}`;
    case 'hourly': {
      const end = hourlyEnd(r);
      // Een venster van één uur is gewoon één run per werkdag.
      return end === r.hour ? `Elke werkdag om ${t}` : `Elk uur op werkdagen, van ${t} tot en met ${clock(end, minute)}`;
    }
    default: {
      const day = r.day_of_month ?? 1;
      // De runner schuift de 29e-31e in een kortere maand naar de laatste dag.
      return day >= 29
        ? `Maandelijks op dag ${day} (of de laatste dag van de maand) om ${t}`
        : `Maandelijks op dag ${day} om ${t}`;
    }
  }
}

/** Kort, voor op de tegel: "Ma–vr · 08:30" leest sneller dan een volzin. */
export function shortSchedule(r: RhythmFields): string {
  const minute = r.minute ?? 0;
  const t = clock(r.hour, minute);
  switch (r.schedule_kind) {
    case 'daily': return `Elke dag · ${t}`;
    case 'weekdays': return `Ma–vr · ${t}`;
    case 'weekly': {
      const day = DOW_NAMES[(r.day_of_week ?? 1) - 1] ?? DOW_NAMES[0];
      return `${day.charAt(0).toUpperCase()}${day.slice(1, 2)} · ${t}`;
    }
    case 'hourly': {
      const end = hourlyEnd(r);
      return end === r.hour ? `Ma–vr · ${t}` : `Elk uur · ${clock(r.hour, minute)}–${clock(end, minute)}`;
    }
    default: return `Dag ${r.day_of_month ?? 1} · ${t}`;
  }
}

// ── Van wie is hij, en waar staat hij ────────────────────────────────────────

export interface AgentOwnership {
  run_as_user_id: string | null;
  created_by: string | null;
}

/** Namens wie draait deze agent? Zelfde regel als agentOwnerId op de server. */
export function agentOwner(agent: AgentOwnership): string | null {
  const owner = agent.run_as_user_id ?? agent.created_by;
  return typeof owner === 'string' && owner ? owner : null;
}

/** Wat jij met deze agent mag, zoals de knoppen het nodig hebben. */
export interface AgentPowers {
  /** Eigenaar: aanpassen, starten, aanzetten, delen en antwoorden. */
  manage: boolean;
  /** Pauzeren, archiveren en terugzetten: de eigenaar, of een owner/admin (toezicht). */
  oversee: boolean;
  /** Een eigen kopie maken: van je eigen agent, een gedeelde, of voor toezicht elke. */
  copy: boolean;
}

/** Spiegel van canManageAgent/canCloneAgent op de server (agentAccess.ts). */
export function agentPowers(
  agent: AgentOwnership & { visibility?: AgentVisibility | null },
  me: string | null | undefined,
  canOversee: boolean,
): AgentPowers {
  const owner = agentOwner(agent);
  const mine = Boolean(me) && owner === me;
  return {
    manage: mine,
    oversee: mine || canOversee,
    copy: mine || canOversee || agent.visibility === 'team',
  };
}

export interface AgentSections<T> {
  /** Jouw eigen agents. */
  mine: T[];
  /** Door een collega gedeeld als startpunt — voor wie geen toezicht houdt. */
  shared: T[];
  /** De agents van collega's — alleen voor owners/admins. */
  team: T[];
  /** Gearchiveerd: je eigen, en voor toezicht ook die van collega's. */
  archived: T[];
}

/**
 * Deelt de agents die je mag zien op in de stukken van het scherm. Wat je te
 * zien krijgt bepaalt de database (RLS); dit bepaalt alleen waar het staat.
 */
export function sortAgents<T extends AgentOwnership & { status: RoutineStatus; visibility?: AgentVisibility | null }>(
  agents: T[],
  me: string | null | undefined,
  canOversee: boolean,
): AgentSections<T> {
  const sections: AgentSections<T> = { mine: [], shared: [], team: [], archived: [] };
  for (const agent of agents) {
    if (agent.status === 'archived') { sections.archived.push(agent); continue; }
    const owner = agentOwner(agent);
    // Onbekend wie er kijkt: dan zoals vroeger, alles onder "je agents".
    if (!me || owner === me) sections.mine.push(agent);
    else if (canOversee) sections.team.push(agent);
    else if (agent.visibility === 'team') sections.shared.push(agent);
  }
  return sections;
}

// ── De goedkeurwachtrij ──────────────────────────────────────────────────────

/**
 * Wacht dit voorstel op jou?
 *   'mine'   — ja: het komt van je eigen agent, of (als owner/admin) van een
 *              gekoppelde AI of API-sleutel; daarover beslissen alleen zij.
 *   'team'   — het komt van de agent van een collega. Als owner/admin kún je
 *              erover beslissen, maar het wacht in de eerste plaats op die collega.
 *   'hidden' — niet aan jou: ai_action_decide zou je akkoord toch weigeren.
 */
export type ApprovalScope = 'mine' | 'team' | 'hidden';

export function approvalScope(
  approval: Pick<AgentApproval, 'source' | 'userId'>,
  me: string | null | undefined,
  canOversee: boolean,
): ApprovalScope {
  if (approval.source !== 'agent') return canOversee ? 'mine' : 'hidden';
  if (!me || approval.userId === me) return 'mine';
  return canOversee ? 'team' : 'hidden';
}

// ── Wat leverde hij op ───────────────────────────────────────────────────────

export interface AgentMonthStats {
  runs: number;
  /** Runs zonder nieuws (stil-als-leeg): geteld, maar geen mail of melding. */
  quiet: number;
  failed: number;
  costUsd: number;
  proposals: number;
  approved: number;
  rejected: number;
  /** Mislukt bij het uitvoeren (niet afgewezen). */
  failedDecisions: number;
  open: number;
}

/**
 * De maand van één agent in een paar getallen. Vooral de verhouding akkoord /
 * afgewezen zegt iets: wijs je de helft af, dan is de opdracht te ruim.
 */
export function summarizeAgentMonth(
  runs: Array<{ status: RoutineRunStatus | string; cost_usd: number | string | null; proposals_created: number | null; result?: { quiet?: unknown } | null }>,
  decisions: Array<{ status: string; decision?: string | null }>,
): AgentMonthStats {
  const stats: AgentMonthStats = { runs: 0, quiet: 0, failed: 0, costUsd: 0, proposals: 0, approved: 0, rejected: 0, failedDecisions: 0, open: 0 };
  for (const run of runs) {
    // Een overgeslagen run (tegoed op, eigenaar weg) heeft niets gedaan.
    if (run.status === 'skipped_budget' || run.status === 'cancelled') continue;
    stats.runs += 1;
    if (run.status === 'failed') stats.failed += 1;
    if (run.result?.quiet === true) stats.quiet += 1;
    const cost = Number(run.cost_usd ?? 0);
    if (Number.isFinite(cost)) stats.costUsd += cost;
    stats.proposals += Math.max(0, Number(run.proposals_created ?? 0) || 0);
  }
  stats.costUsd = Math.round(stats.costUsd * 10_000) / 10_000;
  for (const d of decisions) {
    if (d.status === 'proposed') stats.open += 1;
    else if (d.status === 'executed' || d.status === 'auto_executed') stats.approved += 1;
    else if (d.decision === 'rejected') stats.rejected += 1;
    else if (d.status === 'failed' || d.status === 'cancelled') stats.failedDecisions += 1;
  }
  return stats;
}

/** Eén regel onder het kopje "Deze maand": "12 runs · 4 voorstellen (3 goedgekeurd) · ± $ 0,21". */
export function monthStatsLine(s: AgentMonthStats): string {
  if (s.runs === 0) return 'Nog niet gedraaid.';
  const parts = [`${s.runs} run${s.runs === 1 ? '' : 's'}`];
  if (s.quiet > 0) parts.push(`${s.quiet} zonder nieuws`);
  if (s.failed > 0) parts.push(`${s.failed} mislukt`);
  if (s.proposals > 0) {
    const decided = [
      s.approved > 0 ? `${s.approved} goedgekeurd` : null,
      s.rejected > 0 ? `${s.rejected} afgewezen` : null,
      s.open > 0 ? `${s.open} open` : null,
    ].filter(Boolean).join(', ');
    parts.push(`${s.proposals} voorstel${s.proposals === 1 ? '' : 'len'}${decided ? ` (${decided})` : ''}`);
  }
  if (s.costUsd > 0) parts.push(`± $ ${s.costUsd.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  return parts.join(' · ');
}

/** Begin van de huidige kalendermaand, lokaal — de grens van "deze maand". */
export function startOfMonthIso(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}
