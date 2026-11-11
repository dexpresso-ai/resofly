import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  AlertTriangle, CalendarClock, Check, ClipboardCheck, Database, FileSignature, FileText, FolderKanban, Headset,
  Landmark, ListTodo, Mails, Megaphone, ReceiptText, Timer, TrendingUp, UsersRound, Zap, type LucideIcon,
} from 'lucide-react';
import { listRecentAgentRuns, listRunEvents, routineToolIsRead, routineToolLabel, type GerrieRoutine, type GerrieRoutineRun, type GerrieRunEvent } from '../lib/gerrie-api';
import { formatElapsed } from '../lib/reportBuild';
import { WORK_STEPS, lastTool, latestRunByAgent, liveRunByAgent, liveSteps, workPhase, type LiveRun } from '../lib/agentWork';
import { AgentGlyph } from './AgentGlyph';
import { StepTrack, useElapsed } from './StepTrack';
import type { UUID } from '../types';

/**
 * Agents aan het werk (2026-11-11).
 *
 * Een agent draait op de server. De runner schrijft elke stap meteen in het
 * logboek (gerrie-agent-runner, `log.live`); hier lezen we dat terug, zolang de
 * pagina in beeld is. Voorheen zag je van een draaiende agent niets: hoogstens een
 * melding "draait…" tot hij klaar was, en een geplande run zag je helemaal niet.
 *
 * Twee hooks en twee weergaven:
 *   - useAgentActivity: de recente runs van alle agents; wie draait er nu, en wat
 *     leverde de laatste run per agent op;
 *   - useRunEvents: het logboek van één lopende run;
 *   - AgentWorkbench: de werkbank in het paneel van een agent (de animatie);
 *   - AgentLiveLine: één regel op de kaart in de lijst.
 */

/**
 * Staat de pagina echt in beeld? Alle werktabbladen blijven gemount; een tabblad
 * op de achtergrond heeft `hidden`, en dan heeft niets erin een offsetParent.
 * Zonder deze controle bleef elk open Gerrie-tabblad op de achtergrond vragen.
 */
function isShown(ref: RefObject<HTMLElement>): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  const el = ref.current;
  return !el || el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
}

/** Hoe vaak we kijken: rustig als er niets loopt, vlot als er iets aan het werk is. */
const IDLE_POLL_MS = 15_000;
const BUSY_POLL_MS = 3_000;

export interface AgentActivity {
  runs: GerrieRoutineRun[];
  latest: Record<string, GerrieRoutineRun>;
  live: Record<string, LiveRun>;
  refresh: () => void;
}

export function useAgentActivity(organizationId: UUID, anchor: RefObject<HTMLElement>, eager = false): AgentActivity {
  const [runs, setRuns] = useState<GerrieRoutineRun[]>([]);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const live = useMemo(() => liveRunByAgent(runs), [runs]);
  const latest = useMemo(() => latestRunByAgent(runs), [runs]);
  const busy = eager || Object.keys(live).length > 0;

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (!isShown(anchor)) return;
      listRecentAgentRuns(organizationId).then((rows) => { if (alive) setRuns(rows); }).catch(() => { /* dan geen live stand */ });
    };
    load();
    const timer = window.setInterval(load, busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [organizationId, busy, tick, anchor]);

  return { runs, latest, live, refresh };
}

/** Het logboek van één lopende run, elke paar seconden opnieuw. */
export function useRunEvents(organizationId: UUID, runId: string | null, anchor: RefObject<HTMLElement>, intervalMs = 1_500): GerrieRunEvent[] {
  const [events, setEvents] = useState<GerrieRunEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!runId) return undefined;
    let alive = true;
    const load = () => {
      if (!isShown(anchor)) return;
      listRunEvents(organizationId, runId as UUID).then((rows) => { if (alive) setEvents(rows); }).catch(() => { /* volgende keer opnieuw */ });
    };
    load();
    const timer = window.setInterval(load, intervalMs);
    return () => { alive = false; window.clearInterval(timer); };
  }, [organizationId, runId, intervalMs, anchor]);
  return events;
}

/** Een icoon per soort gegevens, voor de bronnen links op de werkbank. */
const TOOL_ICONS: Array<[RegExp, LucideIcon]> = [
  [/invoice|reminder|payment|credit/, ReceiptText],
  [/financial|ledger|journal|vat|bank|pnl|balance/, Landmark],
  [/quote/, FileText],
  [/contract/, FileSignature],
  [/client|contact|supplier/, UsersRound],
  [/ticket/, Headset],
  [/task/, ListTodo],
  [/project/, FolderKanban],
  [/calendar|meeting|booking/, CalendarClock],
  [/time_entr|hours/, Timer],
  [/email|mail/, Mails],
  [/campaign|marketing/, Megaphone],
  [/report|summary|stats/, TrendingUp],
  [/^action:/, Zap],
];
export function toolIcon(name: string): LucideIcon {
  const key = name.toLowerCase();
  for (const [re, Icon] of TOOL_ICONS) if (re.test(key)) return Icon;
  return Database;
}

/** De bronnen die op de werkbank staan: de leestools van de agent, hoogstens vier. */
function sourcesOf(routine: Pick<GerrieRoutine, 'enabled_tools'>): string[] {
  const read = routine.enabled_tools.filter(routineToolIsRead);
  return (read.length ? read : ['search_clients', 'list_invoices']).slice(0, 4);
}

/**
 * De werkbank: links de gegevens waar de agent in kijkt, in het midden de agent,
 * rechts wat hij oplevert. Wat er stroomt, volgt de stap uit het logboek: eerst
 * van de bronnen naar de agent (de bron die hij nu gebruikt licht op), daarna van
 * de agent naar de uitkomst, en bij het afronden krijgen de uitkomsten een vinkje.
 *
 * Alles is CSS (agents.css, "De werkbank"). Met minder beweging staat het stil,
 * maar de stap zie je nog steeds aan wat er oplicht en aan de stappenbalk.
 */
export function AgentWorkbench({ routine, run, events }: {
  routine: GerrieRoutine;
  run: LiveRun;
  events: GerrieRunEvent[];
}) {
  const startedAt = Date.parse(run.startedAt);
  const elapsed = useElapsed(Number.isFinite(startedAt) ? startedAt : Date.now());
  const phase = workPhase(events);
  const steps = liveSteps(events);
  const sources = sourcesOf(routine);
  const active = lastTool(events);
  const activeIndex = active ? sources.indexOf(active) : -1;
  const propose = routine.mode === 'propose';
  const outputs = propose ? Math.min(3, Math.max(1, routine.max_proposals_per_run ?? 3)) : 3;
  const lastLabel = steps.length ? steps[steps.length - 1].label : 'Gestart';

  return (
    <section className="agw" aria-label={`${routine.name || 'De agent'} is aan het werk`}>
      <div className="agw-stage" data-phase={phase} aria-hidden="true" style={{ '--agw-n': sources.length, '--agw-m': outputs } as CSSProperties}>
        <div className="agw-sources">
          {sources.map((name, i) => {
            const Icon = toolIcon(name);
            // Weet het logboek nog niet welke bron, dan gaan ze om de beurt.
            const lit = activeIndex === -1 ? undefined : i === activeIndex;
            return (
              <span key={name} className={`agw-chip${lit === true ? ' is-lit' : lit === false ? ' is-dim' : ''}`} style={{ '--i': i } as CSSProperties}>
                <Icon size={15} strokeWidth={1.8} />
                <em>{routineToolLabel(name)}</em>
              </span>
            );
          })}
        </div>
        <svg className="agw-flow agw-flow-in" viewBox="0 0 100 100" preserveAspectRatio="none">
          {sources.map((name, i) => {
            const y = ((i + 0.5) / sources.length) * 100;
            return <path key={name} className={i === activeIndex ? 'is-lit' : undefined} style={{ '--i': i } as CSSProperties} d={`M0 ${y} C45 ${y} 55 50 100 50`} />;
          })}
        </svg>
        <div className="agw-core">
          <span className="agw-orbit" />
          <span className="agw-orbit agw-orbit-2" />
          <AgentGlyph agent={routine} size="xl" state="running" />
          <span className="agw-spark" /><span className="agw-spark" /><span className="agw-spark" />
        </div>
        <svg className="agw-flow agw-flow-out" viewBox="0 0 100 100" preserveAspectRatio="none">
          {Array.from({ length: outputs }, (_, i) => {
            const y = ((i + 0.5) / outputs) * 100;
            return <path key={i} style={{ '--i': i } as CSSProperties} d={`M0 50 C45 50 55 ${y} 100 ${y}`} />;
          })}
        </svg>
        <div className="agw-outputs">
          {Array.from({ length: outputs }, (_, i) => (
            <span key={i} className="agw-out" style={{ '--i': i } as CSSProperties}>
              <span className="agw-out-mark">{propose ? <ClipboardCheck size={12} /> : <FileText size={12} />}</span>
              <i /><i />
              <span className="agw-out-check"><Check size={11} strokeWidth={3} /></span>
            </span>
          ))}
        </div>
      </div>

      <div className="agw-info">
        <div className="agw-head">
          <div className="agw-head-text">
            <b>{routine.name || 'Je agent'} is aan het werk</b>
            <span role="status">{lastLabel}</span>
          </div>
          <span className="aire-build-time" title="Zo lang is hij al bezig">{formatElapsed(elapsed)}</span>
        </div>
        <StepTrack steps={WORK_STEPS} phase={phase} label="Waar de agent is" />
        <ol className="agw-log" aria-label="Wat hij tot nu toe deed">
          {steps.map((s) => (
            <li key={s.key} className={s.ok ? undefined : 'is-fail'}>
              <span className="agw-log-mark">{s.ok ? <Check size={11} strokeWidth={3} /> : <AlertTriangle size={11} />}</span>
              <span className="agw-log-label">{s.label}</span>
              <span className="agw-log-at">{offset(s.at, run.startedAt)}</span>
            </li>
          ))}
          <li className="is-now">
            <span className="agw-log-mark"><span className="agw-dots"><i /><i /><i /></span></span>
            <span className="agw-log-label">{WORK_STEPS[phase]}…</span>
          </li>
        </ol>
        <p className="agw-note">Je kunt gewoon verder werken. {propose ? 'Wat hij klaarzet, komt bij Jouw akkoord te staan.' : 'Zijn uitkomst verschijnt hieronder zodra hij klaar is.'}</p>
      </div>
    </section>
  );
}

/** "+0:12": hoe lang na de start een stap kwam. */
function offset(at: string, startedAt: string): string {
  const ms = Date.parse(at) - Date.parse(startedAt);
  return Number.isFinite(ms) ? `+${formatElapsed(Math.max(0, ms))}` : '';
}

/** Eén regel op de kaart: wat hij nu doet, en hoe lang al. */
export function AgentLiveLine({ organizationId, run, anchor }: { organizationId: UUID; run: LiveRun; anchor: RefObject<HTMLElement> }) {
  const events = useRunEvents(organizationId, run.id, anchor, 2_500);
  const startedAt = Date.parse(run.startedAt);
  const elapsed = useElapsed(Number.isFinite(startedAt) ? startedAt : Date.now());
  const steps = liveSteps(events);
  const phase = workPhase(events);
  const label = steps.length > 1 ? steps[steps.length - 1].label : `${WORK_STEPS[phase]}…`;
  return (
    <span className="agx-live" role="status">
      <span className="agx-live-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="agx-live-text">{label}</span>
      <span className="agx-live-time">{formatElapsed(elapsed)}</span>
      <span className="agx-live-track" aria-hidden="true">{WORK_STEPS.map((s, i) => <i key={s} className={i < phase ? 'is-done' : i === phase ? 'is-active' : undefined} />)}</span>
    </span>
  );
}

/** Een ref die altijd naar een element op de pagina wijst; voor isShown. */
export function useAnchor<T extends HTMLElement>() {
  return useRef<T>(null);
}
