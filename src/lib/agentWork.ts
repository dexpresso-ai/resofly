// Puur (geen Supabase, alleen type-imports), zodat node --test er rechtstreeks
// mee kan werken.
import type { GerrieRoutineRun, RoutineRunStatus, RunEventKind } from './gerrie-api';

/**
 * Een agent aan het werk (2026-11-11).
 *
 * Een agent draait op de server, soms een minuut lang. De runner schrijft elke stap
 * meteen in het logboek; de app leest dat terug en laat zien waar hij is. Hier
 * staat de logica daarvan: welke runs nu lopen, in welke stap ze zijn, en wat de
 * laatste run van een agent opleverde.
 */

export const WORK_STEPS = ['Opstarten', 'Gegevens bekijken', 'Uitwerken', 'Afronden'] as const;
export type WorkPhase = 0 | 1 | 2 | 3;

/**
 * Een run die langer "loopt" dan dit, is gestrand (de edge function is ermee
 * gestopt zonder af te ronden). Die tonen we niet als bezig: anders draaide een
 * agent in de app eeuwig door.
 */
export const STALE_RUN_MS = 15 * 60_000;

export interface LiveRun { id: string; agentId: string; startedAt: string }

/** Loopt deze run nu echt? */
export function isLiveRun(run: Pick<GerrieRoutineRun, 'status' | 'started_at' | 'created_at'>, now = Date.now()): boolean {
  if (run.status !== 'running' && run.status !== 'claimed') return false;
  const started = Date.parse(run.started_at ?? run.created_at ?? '');
  return Number.isFinite(started) && now - started < STALE_RUN_MS && now - started > -60_000;
}

/** Per agent de nieuwste run (de lijst komt nieuwste eerst, maar daar rekenen we niet op). */
export function latestRunByAgent<T extends Pick<GerrieRoutineRun, 'agent_id' | 'created_at'>>(runs: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const run of runs) {
    const prev = out[run.agent_id];
    if (!prev || Date.parse(run.created_at) > Date.parse(prev.created_at)) out[run.agent_id] = run;
  }
  return out;
}

/** Per agent de run die nu loopt (de nieuwste, als het er meer zijn). */
export function liveRunByAgent(runs: Array<Pick<GerrieRoutineRun, 'id' | 'agent_id' | 'status' | 'started_at' | 'created_at'>>, now = Date.now()): Record<string, LiveRun> {
  const out: Record<string, LiveRun> = {};
  for (const run of runs) {
    if (!isLiveRun(run, now)) continue;
    const startedAt = run.started_at ?? run.created_at;
    const prev = out[run.agent_id];
    if (!prev || Date.parse(startedAt) > Date.parse(prev.startedAt)) out[run.agent_id] = { id: run.id, agentId: run.agent_id, startedAt };
  }
  return out;
}

/**
 * De stap van een run, uit wat er in het logboek staat. De laatste regel telt:
 * stap 1 tot er gegevens bekeken zijn, 2 zodra hij iets uitwerkt (een voorstel
 * of zijn antwoord), 3 bij het bezorgen en afronden.
 */
export function workPhase(events: Array<{ kind: RunEventKind | string }>): WorkPhase {
  let phase: WorkPhase = 0;
  for (const ev of events) {
    const next: WorkPhase = ev.kind === 'tool' || ev.kind === 'reply' ? 1
      : ev.kind === 'proposal' || ev.kind === 'answer' ? 2
        : ev.kind === 'delivery' || ev.kind === 'finish' ? 3
          : ev.kind === 'error' ? phase : 0;
    if (next > phase) phase = next;
  }
  return phase;
}

export interface LiveStep { key: string; label: string; ok: boolean; kind: string; at: string }

/**
 * Wat de app tijdens het werk onder elkaar zet. Het antwoord zelf (de hele tekst)
 * hoort niet in deze lijst: daar komt één regel voor in de plaats.
 */
export function liveSteps(events: Array<{ id?: string; seq: number; kind: string; label: string; detail?: Record<string, unknown> | null; created_at: string }>): LiveStep[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((ev) => ({
      key: ev.id ?? String(ev.seq),
      kind: ev.kind,
      at: ev.created_at,
      ok: ev.kind !== 'error' && ev.detail?.ok !== false,
      label: ev.kind === 'answer' ? 'Zijn antwoord geschreven' : ev.label,
    }));
}

/** Welke tool de agent het laatst gebruikte (voor het oplichtende icoon). */
export function lastTool(events: Array<{ seq: number; kind: string; detail?: Record<string, unknown> | null }>): string | null {
  const sorted = [...events].sort((a, b) => b.seq - a.seq);
  for (const ev of sorted) {
    const tool = ev.detail?.tool;
    if ((ev.kind === 'tool' || ev.kind === 'proposal') && typeof tool === 'string') return tool;
  }
  return null;
}

/** "vandaag 08:00", "gisteren 14:30", "ma 10 nov" — waar het lijstje om vraagt. */
export function whenShort(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
  const dayKey = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000));
  if (dayKey(d) === today) return `vandaag ${time}`;
  if (dayKey(d) === yesterday) return `gisteren ${time}`;
  return d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
}

/** De uitkomst van een run in één regel, voor op de kaart. */
export function runOutcome(run: Pick<GerrieRoutineRun, 'status' | 'summary' | 'error' | 'proposals_created' | 'result'> | null | undefined): { text: string; tone: 'ok' | 'quiet' | 'warn' | 'bad' | 'none' } {
  if (!run) return { text: 'Nog niet gedraaid', tone: 'none' };
  const status: RoutineRunStatus = run.status;
  if (status === 'failed') return { text: run.error ? `Mislukt: ${run.error}` : 'Mislukt', tone: 'bad' };
  if (status === 'skipped_budget') return { text: 'Overgeslagen: het AI-tegoed was op', tone: 'warn' };
  if (status === 'cancelled') return { text: 'Afgebroken', tone: 'warn' };
  if (run.result?.quiet) return { text: 'Niets te melden', tone: 'quiet' };
  const summary = (run.summary ?? '').replace(/\s+/g, ' ').trim();
  const proposals = run.proposals_created > 0 ? `${run.proposals_created} voorstel${run.proposals_created === 1 ? '' : 'len'} klaargezet` : '';
  const text = [proposals, summary].filter(Boolean).join(' · ') || (status === 'partial' ? 'Deels gelukt' : 'Klaar');
  return { text, tone: status === 'partial' ? 'warn' : 'ok' };
}
