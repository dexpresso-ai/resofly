import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Sparkles, Send, Check, X, AlertTriangle, Wand2, Clock, Plus, Play, Pause, Archive, ArchiveRestore, Pencil, RotateCw, Loader2, ChevronDown, ChevronRight, ChevronUp, CornerDownLeft, ClipboardCheck, Eye, Mailbox, Users2, Gauge, BookOpen, ScrollText } from 'lucide-react';
import {
  streamGerrieReply, loadGerrieBudget, confirmGerrieAction,
  listRoutines, listRoutineRuns, saveRoutine, setRoutineStatus, archiveRoutine, restoreRoutine, runRoutineNow, listRunProposals,
  loadRunTranscript, listRunEvents, listRunDecisions, replyToRun, listPendingAgentApprovals, listRoutineToolsSafe, routineToolLabel,
  type GerrieActionHandlers, type GerrieProposal,
  type GerrieRoutine, type GerrieRoutineRun, type GerrieRoutineInput, type GerrieRunMessage, type GerrieAgentProposal,
  type GerrieRunEvent, type GerrieRunDecision, type RoutineTool,
  type RoutineMode, type RoutineScheduleKind, type RoutineStatus, type RoutineRunStatus, type AgentEmailMode,
} from '../lib/gerrie-api';
import { STANDARD_MERGE_TOKENS } from '../lib/mergeTokens';
import { executeProposal, openProposal, proposalLabel } from '../lib/gerrie-proposals';
import { AgentApprovals } from '../components/AgentApprovals';
import { AgentBuilder } from '../components/AgentBuilder';
import { AgentBatchBoard, asBatchProposal } from '../components/AgentBatchBoard';
import { AGENT_ICONS, AgentGlyph, agentIconKey, type AgentIconKey } from '../components/AgentGlyph';
import type { UUID } from '../types';

/**
 * Gerrie Commandocentrum — schermvullende multi-agent-pagina.
 *
 * Gerrie werkt hier als een team van agents die MEERDERE taken tegelijk oppakken. De
 * BROWSER is de dirigent: hij vuurt per deeltaak een aparte `streamGerrieReply` af
 * (zuinig model) en toont elke agent als een live "baan". Alles wat iets
 * VERSTUURT/AANMAAKT/WIJZIGT komt als voorstel in de centrale goedkeuringswachtrij;
 * lezen/analyseren loopt automatisch. Goedgekeurde acties worden uitgevoerd via
 * dezelfde handlers (gerrieActions) als de gewone Gerrie-chat.
 *
 * Fase 1 = "live meekijken": missies draaien zolang deze pagina open is. Doordraaien
 * op de achtergrond (durable queue + cron) is een latere fase.
 */

let runSeq = 0;
function newId(): string {
  try { return crypto.randomUUID(); } catch { return `run-${Date.now()}-${++runSeq}`; }
}

/**
 * Eén losse opdracht die je nu laat uitvoeren. Bewust géén "missie" meer met
 * parallelle deel-agents: dat draaide alleen zolang dit tabblad openstond, was de
 * duurste weg, en had zijn eigen tweede goedkeurpad naast de wachtrij. Wat overbleef
 * is de bruikbare helft — één opdracht, één keer, en wat hij klaarzet beslis je hier.
 */
interface RunResult {
  id: string;
  instruction: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  /** Waar hij nu mee bezig is ("Klanten zoeken…"); alleen tijdens het draaien. */
  statusLabel: string | null;
  text: string;
  proposal?: GerrieProposal;
  auditId?: string;
  resolution?: 'executing' | 'executed' | 'rejected' | 'error';
  error?: string;
}

const QUICK_TASKS = [
  'Welke facturen staan langer dan 30 dagen open?',
  'Zet de betalingsherinneringen klaar die vandaag aan de beurt zijn',
  'Welke offertes liggen stil en wat is de status per klant?',
  'Geef een overzicht van mijn omzet en grootste klanten dit jaar',
];

export function GerrieCommandCenter({ organizationId, canWrite, openAgentId = null, onOpenAgentConsumed, ...handlers }: {
  organizationId: UUID;
  canWrite: boolean;
  /** Net vanuit de chat aangemaakte agent; die klapt hier meteen open. */
  openAgentId?: string | null;
  onOpenAgentConsumed?: () => void;
} & GerrieActionHandlers) {
  // Agents is de voordeur: daar zit het werk. "Nu uitvoeren" is voor het losse geval.
  const [tab, setTab] = useState<'agents' | 'run' | 'queue'>('agents');
  const [draft, setDraft] = useState('');
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [budget, setBudget] = useState<number | null>(null);
  const controllers = useRef<Map<string, AbortController>>(new Map());

  // Openstaande voorstellen van geplande agents: voedt de badge op het tabblad én
  // het belletje op elke agent-tegel. Los van de wachtrij-component zelf, want die
  // is alleen gemount als je op dat tabblad staat.
  const [pendingByAgent, setPendingByAgent] = useState<Record<string, number>>({});
  const [pendingTotal, setPendingTotal] = useState(0);
  const reloadPending = useCallback(() => {
    listPendingAgentApprovals(organizationId)
      .then((rows) => {
        const map: Record<string, number> = {};
        for (const r of rows) if (r.agentId) map[r.agentId] = (map[r.agentId] ?? 0) + 1;
        setPendingByAgent(map);
        setPendingTotal(rows.length);
      })
      // Geen wachtrij te lezen (module dicht, sessie verlopen): dan gewoon geen badge.
      .catch(() => { setPendingByAgent({}); setPendingTotal(0); });
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    loadGerrieBudget(organizationId).then((f) => { if (!cancelled && f !== null) setBudget(f); });
    reloadPending();
    return () => { cancelled = true; };
  }, [organizationId, reloadPending]);

  // Bij het verlaten van de pagina/orgwissel: lopende opdrachten netjes afbreken.
  useEffect(() => () => { controllers.current.forEach((c) => c.abort()); controllers.current.clear(); }, [organizationId]);

  function patchRun(id: string, patch: Partial<RunResult>) {
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /**
   * Voert één opdracht uit via hetzelfde brein als de chat. Bewust dezelfde weg:
   * dan gedraagt een losse opdracht zich precies als een vraag in de chat-dock, en
   * loopt de goedkeuring langs dezelfde gedeelde handlers.
   */
  function startRun(text: string) {
    const instruction = text.trim();
    if (!instruction) return;
    setDraft('');
    const run: RunResult = { id: newId(), instruction, status: 'running', statusLabel: 'Gerrie start…', text: '' };
    setRuns((prev) => [run, ...prev]);

    const ctrl = new AbortController();
    controllers.current.set(run.id, ctrl);
    let streamed = '';
    streamGerrieReply({
      organizationId,
      conversationId: null,
      message: instruction,
      signal: ctrl.signal,
      onStatus: (st) => patchRun(run.id, { statusLabel: st.label }),
      onDelta: (d) => { streamed += d; patchRun(run.id, { text: streamed, statusLabel: null }); },
    })
      .then((result) => {
        if (result.budget) setBudget(result.budget.remainingFraction);
        patchRun(run.id, {
          status: 'done', statusLabel: null,
          text: result.text || streamed,
          proposal: result.proposal,
          auditId: result.auditId,
        });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) { patchRun(run.id, { status: 'cancelled', statusLabel: null }); return; }
        patchRun(run.id, { status: 'failed', statusLabel: null, error: err instanceof Error ? err.message : 'Er ging iets mis.' });
      })
      .finally(() => { controllers.current.delete(run.id); });
  }

  function stopRun(id: string) { controllers.current.get(id)?.abort(); }

  async function approve(run: RunResult) {
    if (!run.proposal) return;
    patchRun(run.id, { resolution: 'executing' });
    try {
      await executeProposal(run.proposal, handlers);
      if (run.auditId) void confirmGerrieAction(organizationId, run.auditId, 'executed');
      patchRun(run.id, { resolution: 'executed' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Uitvoeren mislukt.';
      if (run.auditId) void confirmGerrieAction(organizationId, run.auditId, 'failed', msg);
      patchRun(run.id, { resolution: 'error', error: msg });
    }
  }
  function reject(run: RunResult) {
    if (run.auditId) void confirmGerrieAction(organizationId, run.auditId, 'failed', 'Afgewezen door gebruiker.');
    patchRun(run.id, { resolution: 'rejected' });
  }

  const activeCount = runs.filter((r) => r.status === 'running').length;

  return (
    <div className="cc-root">
      <header className="cc-top">
        <div className="cc-brand"><span className="cc-spark" aria-hidden="true"><Sparkles size={18} /></span><b>Gerrie</b><span className="cc-sub">Commandocentrum</span></div>
        <nav className="cc-tabs" aria-label="Gerrie-weergave">
          <button className={`cc-tab${tab === 'agents' ? ' on' : ''}`} onClick={() => setTab('agents')}><Clock size={14} /> Agents</button>
          <button className={`cc-tab${tab === 'run' ? ' on' : ''}`} onClick={() => setTab('run')}><Sparkles size={14} /> Nu uitvoeren</button>
          <button className={`cc-tab${tab === 'queue' ? ' on' : ''}`} onClick={() => { setTab('queue'); reloadPending(); }}>
            <ClipboardCheck size={14} /> Jouw akkoord
            {pendingTotal > 0 && <span className="cc-tab-badge">{pendingTotal}</span>}
          </button>
        </nav>
        <div className="cc-top-spacer" />
        {activeCount > 0 && <span className="cc-live" role="status"><span className="cc-live-dot" />bezig</span>}
        {budget !== null && (
          <div className="cc-budget" title="Resterend AI-tegoed deze maand">
            <span className="cc-budget-label">AI-tegoed</span>
            <span className="cc-budget-track"><span className="cc-budget-fill" data-low={budget <= 0.2 ? 'true' : 'false'} style={{ width: `${Math.round(budget * 100)}%` }} /></span>
            <span className="cc-budget-pct">{Math.round(budget * 100)}%</span>
          </div>
        )}
      </header>

      {tab === 'agents' ? (
        <RoutinesPanel organizationId={organizationId} canWrite={canWrite} handlers={handlers}
          pendingByAgent={pendingByAgent} onApprovalsChanged={reloadPending} budget={budget}
          openAgentId={openAgentId} onOpenAgentConsumed={onOpenAgentConsumed} />
      ) : tab === 'queue' ? (
        <div className="ag-page">
          <AgentApprovals organizationId={organizationId} canWrite={canWrite} handlers={handlers}
            variant="page" onChanged={reloadPending} onCountChange={setPendingTotal} />
        </div>
      ) : (
        <div className="ag-page">
          <header className="ag-page-head">
            <div>
              <h2>Nu uitvoeren</h2>
              <p>Eén opdracht, één keer. Handig als het te eenmalig is voor een agent. <b>Lezen doet hij zelf</b>; alles wat verstuurt of aanmaakt vink jij hieronder af.</p>
            </div>
          </header>

          <section className="cc-composer">
            <label className="cc-composer-label" htmlFor="cc-input">Wat moet er gebeuren?</label>
            <textarea
              id="cc-input"
              className="cc-input"
              rows={2}
              placeholder="Bijv. “Welke facturen staan langer dan 30 dagen open?”"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startRun(draft); } }}
            />
            <div className="cc-composer-actions">
              <button className="cc-btn primary" disabled={!draft.trim()} onClick={() => startRun(draft)}>
                <Send size={14} /> Uitvoeren
              </button>
            </div>
            {runs.length === 0 && (
              <div className="cc-quick">
                <span className="cc-quick-label">Snel starten</span>
                <div className="cc-quick-chips">
                  {QUICK_TASKS.map((q) => (
                    <button key={q} className="cc-chip" onClick={() => startRun(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {runs.length === 0 ? (
            <div className="cc-empty">
              <span className="cc-empty-icon" aria-hidden="true"><Sparkles size={26} /></span>
              <h2>Vraag het gewoon</h2>
              <p>Moet het elke week vanzelf gebeuren? Maak er dan een agent van op het tabblad hiernaast.</p>
            </div>
          ) : (
            <section className="cc-lanes cc-lanes-single" aria-label="Uitgevoerde opdrachten">
              {runs.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  canWrite={canWrite}
                  handlers={handlers}
                  organizationId={organizationId}
                  onStop={() => stopRun(run.id)}
                  onApprove={() => void approve(run)}
                  onReject={() => reject(run)}
                  onResolved={() => patchRun(run.id, { resolution: 'executed' })}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Eén uitgevoerde opdracht: wat hij zei, en wat hij eventueel klaarzette. */
function RunCard({ run, canWrite, handlers, organizationId, onStop, onApprove, onReject, onResolved }: {
  run: RunResult;
  canWrite: boolean;
  handlers: GerrieActionHandlers;
  organizationId: UUID;
  onStop: () => void;
  onApprove: () => void;
  onReject: () => void;
  onResolved: () => void;
}) {
  const info = run.proposal ? proposalLabel(run.proposal) : null;
  // Een reeks (mail, facturen, offertes, herinneringen) beslis je hier net zoals in
  // de wachtrij: per regel, met een vinkje.
  const batch = run.proposal ? asBatchProposal(run.proposal) : null;
  const beslist = run.resolution === 'executed' || run.resolution === 'rejected';

  return (
    <article className={`cc-lane${run.proposal && !beslist ? ' attn' : ''}`}>
      <div className="cc-lane-top">
        <span className="cc-lane-name">Opdracht</span>
        <span className="cc-lane-push" />
        <span className={`cc-pill ${run.status === 'running' ? 'run' : run.status === 'failed' ? 'fail' : run.status === 'cancelled' ? 'cancel' : run.proposal && !beslist ? 'wait' : 'done'}`}>
          <span className="cc-dot" />
          {run.status === 'running' ? 'Bezig' : run.status === 'failed' ? 'Mislukt' : run.status === 'cancelled' ? 'Gestopt' : run.proposal && !beslist ? 'Wacht op akkoord' : 'Klaar'}
        </span>
        {run.status === 'running' && <button className="cc-lane-stop" title="Stoppen" onClick={onStop}><X size={13} /></button>}
      </div>
      <div className="cc-lane-title">{run.instruction}</div>
      <div className="cc-lane-log">
        {run.statusLabel && run.status === 'running' && <div className="cc-lane-status">{run.statusLabel}</div>}
        {run.text ? <div className="cc-lane-text">{run.text}</div>
          : run.status === 'running' && !run.statusLabel ? <div className="cc-lane-typing" aria-label="bezig"><span /><span /><span /></div>
          : null}
        {run.status === 'failed' && run.error && <div className="cc-lane-err"><AlertTriangle size={13} /> {run.error}</div>}
        {run.status === 'cancelled' && <div className="cc-lane-cancel">Gestopt.</div>}
        {run.resolution === 'error' && run.error && <div className="cc-approve-err">{run.error}</div>}
      </div>

      {run.proposal && info && (
        run.resolution === 'executed' ? <div className="cc-lane-ok"><Check size={13} /> Uitgevoerd</div>
        : run.resolution === 'rejected' ? <div className="cc-lane-cancel">Afgewezen.</div>
        : batch ? (
          <AgentBatchBoard
            proposal={batch}
            canWrite={canWrite}
            handlers={handlers}
            onResolved={({ sent, skipped }) => {
              if (run.auditId) void confirmGerrieAction(organizationId, run.auditId, sent > 0 ? 'executed' : 'failed', `${sent} verstuurd, ${skipped} overgeslagen.`);
              onResolved();
            }}
          />
        ) : (
          <div className="cc-approve">
            <div className="cc-approve-t">{info.title}</div>
            {info.sub && <div className="cc-approve-s">{info.sub}</div>}
            <div className="cc-approve-actions">
              <button className="cc-btn tiny ghost" disabled={run.resolution === 'executing'} onClick={onReject}>Afwijzen</button>
              {/* Akkoord schrijft het weg; Openen zet het eerst vooringevuld in het scherm. */}
              {info.openable && canWrite && (
                <button className="cc-btn tiny ghost" disabled={run.resolution === 'executing'} onClick={() => run.proposal && openProposal(run.proposal, handlers)}>Openen</button>
              )}
              <button className="cc-btn tiny primary" disabled={run.resolution === 'executing' || (info.write && !canWrite)} onClick={onApprove}>
                {run.resolution === 'executing' ? 'Bezig…' : 'Akkoord'}
              </button>
            </div>
          </div>
        )
      )}
    </article>
  );
}

// ── Agents (geplande routines) ───────────────────────────────────────────────

const DOW_NAMES = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

interface RoutineTemplate {
  name: string; blurb: string; instruction: string; mode: RoutineMode;
  schedule_kind: RoutineScheduleKind; hour: number; day_of_week?: number; day_of_month?: number; tools: string[];
  icon: AgentIconKey; hue: number;
}
const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  { name: 'Wekelijks factuuroverzicht', blurb: 'Leest je facturen en meldt wat te lang openstaat.', instruction: 'Geef een overzicht van alle openstaande facturen ouder dan 30 dagen: klantnaam, bedrag en aantal dagen te laat. Sluit af met het totaalbedrag.', mode: 'report', schedule_kind: 'weekly', day_of_week: 1, hour: 8, tools: ['list_invoices', 'list_due_reminders'], icon: 'receipt', hue: 208 },
  { name: 'Wekelijkse betalingsherinneringen', blurb: 'Zet herinneringen klaar; jij drukt op versturen.', instruction: 'Bekijk welke betalingsherinneringen vandaag aan de beurt zijn en zet ze klaar om te versturen. Groepeer per niveau (1e/2e/3e).', mode: 'propose', schedule_kind: 'weekly', day_of_week: 1, hour: 9, tools: ['list_due_reminders', 'propose_send_reminders'], icon: 'bell', hue: 20 },
  { name: 'Maandelijkse omzetsamenvatting', blurb: 'Vat je maand samen: omzet, klanten, openstaand.', instruction: 'Vat de omzet van de afgelopen maand samen: totaalomzet, grootste klanten en het totaal openstaande bedrag.', mode: 'report', schedule_kind: 'monthly', day_of_month: 1, hour: 8, tools: ['get_financial_summary', 'list_invoices'], icon: 'trending', hue: 140 },
  { name: 'Offertes die stilliggen', blurb: 'Signaleert verstuurde offertes zonder antwoord.', instruction: 'Welke offertes staan al langer dan twee weken op "verstuurd" zonder reactie? Noem klant, bedrag en hoe lang het stil is, met de oudste bovenaan.', mode: 'report', schedule_kind: 'weekly', day_of_week: 4, hour: 8, tools: ['list_quotes', 'search_clients'], icon: 'rocket', hue: 284 },
  { name: 'Maandagoverzicht van je week', blurb: 'Start je week met projecten, taken en tickets.', instruction: 'Geef een kort weekoverzicht: welke taken staan deze week gepland, welke projecten lopen en welke tickets zijn nog onbehandeld. Maximaal tien regels.', mode: 'report', schedule_kind: 'weekly', day_of_week: 1, hour: 7, tools: ['list_tasks', 'list_projects', 'list_tickets'], icon: 'checks', hue: 190 },
];

function scheduleLabel(r: { schedule_kind: RoutineScheduleKind; hour: number; day_of_week: number | null; day_of_month: number | null }): string {
  const t = `${String(r.hour).padStart(2, '0')}:00`;
  if (r.schedule_kind === 'daily') return `Elke dag om ${t}`;
  if (r.schedule_kind === 'weekly') return `Elke ${DOW_NAMES[(r.day_of_week ?? 1) - 1]} om ${t}`;
  return `Maandelijks op dag ${r.day_of_month ?? 1} om ${t}`;
}
function routineStatusLabel(s: RoutineStatus): string {
  return s === 'active' ? 'Actief' : s === 'paused' ? 'Gepauzeerd' : s === 'archived' ? 'Gearchiveerd' : 'Concept';
}
function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
}
/** Alleen de klok — binnen één run staat de datum al bovenaan. */
function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; }
}

/** De afloop van een voorstel in gewone taal: wát, en hoe het is afgelopen. */
function decisionLabel(d: GerrieRunDecision): string {
  const what = routineToolLabel(d.action);
  if (d.status === 'executed' || d.status === 'auto_executed') return `${what} — uitgevoerd`;
  if (d.status === 'cancelled') return `${what} — geannuleerd`;
  if (d.status === 'failed') return `${what} — afgewezen of mislukt`;
  return `${what} — ${d.status}`;
}

/**
 * Eén regel extra bij een logboekstap: het filter waarmee hij zocht, hoeveel hij
 * vond, wat de run kostte. Bewust compact — het logboek moet te scannen zijn.
 */
function logDetail(ev: GerrieRunEvent): string {
  const d = ev.detail ?? {};
  const parts: string[] = [];
  if (ev.kind === 'start') {
    parts.push(d.mode === 'propose' ? 'mag voorstellen doen' : 'alleen lezen');
    if (Array.isArray(d.tools)) parts.push(`${(d.tools as unknown[]).length} tools`);
  } else if (ev.kind === 'finish') {
    if (typeof d.tokens === 'number') parts.push(`${d.tokens.toLocaleString('nl-NL')} tokens`);
    if (typeof d.cost_usd === 'number' && d.cost_usd > 0) parts.push(`$ ${Number(d.cost_usd).toFixed(4)}`);
  } else if (ev.kind === 'delivery') {
    if (typeof d.note === 'string') parts.push(d.note);
  } else {
    const input = d.input && typeof d.input === 'object' ? (d.input as Record<string, unknown>) : null;
    if (input) {
      for (const [k, v] of Object.entries(input)) {
        if (parts.length >= 3) break;
        parts.push(`${k}: ${Array.isArray(v) ? `${v.length}` : String(v).slice(0, 40)}`);
      }
    }
  }
  return parts.join(' · ');
}
function runStatusLabel(s: RoutineRunStatus): string {
  switch (s) {
    case 'succeeded': return 'Gelukt';
    case 'failed': return 'Mislukt';
    case 'partial': return 'Deels';
    case 'skipped_budget': return 'Budget op';
    case 'cancelled': return 'Geannuleerd';
    case 'running': return 'Bezig';
    default: return 'Wachtrij';
  }
}
function templateToRoutine(t: RoutineTemplate): GerrieRoutine {
  return {
    id: '' as UUID, name: t.name, description: null, icon: t.icon, hue: t.hue, instruction: t.instruction,
    email_mode: 'compose', email_subject: null, email_body: null, max_emails_per_run: 5,
    model_kind: 'cheap', mode: t.mode, enabled_tools: t.tools,
    schedule_kind: t.schedule_kind, hour: t.hour, day_of_week: t.day_of_week ?? null, day_of_month: t.day_of_month ?? null,
    timezone: 'Europe/Amsterdam', status: 'draft', archived_at: null, next_run_at: null, last_run_at: null,
    consecutive_failures: 0,
    delivery: { channels: ['inapp'], recipient_user_ids: [] }, created_at: '', updated_at: '',
  };
}

/** Kort ritme-label voor op de tegel: "Ma 08:00" leest sneller dan een volzin. */
function shortSchedule(r: { schedule_kind: RoutineScheduleKind; hour: number; day_of_week: number | null; day_of_month: number | null }): string {
  const t = `${String(r.hour).padStart(2, '0')}:00`;
  if (r.schedule_kind === 'daily') return `Elke dag · ${t}`;
  if (r.schedule_kind === 'weekly') return `${capitalize(DOW_NAMES[(r.day_of_week ?? 1) - 1].slice(0, 2))} · ${t}`;
  return `Dag ${r.day_of_month ?? 1} · ${t}`;
}
function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }


/** Zet een door Gerrie voorgestelde agent om in een concept voor de editor. */
function proposalToRoutine(p: GerrieAgentProposal): GerrieRoutine {
  return {
    id: '' as UUID, name: p.name, description: null, icon: null, hue: null, instruction: p.instruction,
    email_mode: p.email_mode, email_subject: p.email_subject, email_body: p.email_body, max_emails_per_run: 5,
    model_kind: 'cheap', mode: p.mode, enabled_tools: p.enabled_tools,
    schedule_kind: p.schedule_kind, hour: p.hour, day_of_week: p.day_of_week, day_of_month: p.day_of_month,
    timezone: 'Europe/Amsterdam', status: 'draft', archived_at: null, next_run_at: null, last_run_at: null,
    consecutive_failures: 0,
    delivery: { channels: ['inapp'], recipient_user_ids: [] }, created_at: '', updated_at: '',
  };
}

function RoutinesPanel({ organizationId, canWrite, handlers, pendingByAgent, onApprovalsChanged, budget, openAgentId, onOpenAgentConsumed }: {
  organizationId: UUID;
  canWrite: boolean;
  handlers: GerrieActionHandlers;
  /** Aantal openstaande voorstellen per agent — het belletje op de tegel. */
  pendingByAgent: Record<string, number>;
  onApprovalsChanged: () => void;
  /** Resterend maandtegoed van het account als fractie 0..1; null = geen limiet. */
  budget: number | null;
  /** Net vanuit de chat aangemaakte agent; klapt hier meteen open. */
  openAgentId?: string | null;
  onOpenAgentConsumed?: () => void;
}) {
  const [routines, setRoutines] = useState<GerrieRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 'build' = het gesprek waarin Gerrie de agent voor je in elkaar zet (de voordeur);
  // 'new' = het lege formulier voor wie het liever zelf invult.
  const [editing, setEditing] = useState<GerrieRoutine | 'new' | 'build' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [runsKey, setRunsKey] = useState(0);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'success' | 'error' } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const reload = () => setReloadKey((k) => k + 1);
  function notify(text: string, kind: 'info' | 'success' | 'error' = 'info', sticky = false) {
    setToast({ text, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (!sticky) toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 6000 : 4000);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    listRoutines(organizationId)
      .then((r) => { if (alive) setRoutines(r); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Routines laden mislukt.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [organizationId, reloadKey]);

  async function doStatus(r: GerrieRoutine, status: RoutineStatus) {
    setBusyId(r.id);
    try { await setRoutineStatus(organizationId, r.id, status); reload(); notify(status === 'active' ? 'Agent geactiveerd.' : status === 'paused' ? 'Agent gepauzeerd.' : 'Bijgewerkt.', 'success'); }
    catch (e) { notify(e instanceof Error ? e.message : 'Mislukt.', 'error'); }
    finally { setBusyId(null); }
  }
  // "Verwijderen" is archiveren: de agent gaat uit en verdwijnt uit de galerij,
  // maar zijn runs en logboek blijven — daar staat wat er namens jou is gebeurd.
  async function doArchive(r: GerrieRoutine) {
    if (!confirm(`Agent "${r.name || 'naamloos'}" archiveren?\n\nHij stopt met draaien en verdwijnt uit je galerij. Alles wat hij heeft gedaan blijft bewaard onder "Archief".`)) return;
    setBusyId(r.id);
    try { await archiveRoutine(organizationId, r.id); setOpenId(null); reload(); notify('Agent gearchiveerd — zijn historie blijft bewaard.', 'success'); }
    catch (e) { notify(e instanceof Error ? e.message : 'Archiveren mislukt.', 'error'); }
    finally { setBusyId(null); }
  }
  async function doRestore(r: GerrieRoutine) {
    setBusyId(r.id);
    try { await restoreRoutine(organizationId, r.id); reload(); notify('Agent teruggezet — hij staat gepauzeerd klaar.', 'success'); }
    catch (e) { notify(e instanceof Error ? e.message : 'Terugzetten mislukt.', 'error'); }
    finally { setBusyId(null); }
  }
  async function doRunNow(r: GerrieRoutine) {
    setBusyId(r.id); setOpenId(r.id);
    notify(`"${r.name || 'Agent'}" draait…`, 'info', true);
    try {
      const res = await runRoutineNow(organizationId, r.id);
      notify(res.proposalsCreated ? `Klaar — ${res.proposalsCreated} voorstel${res.proposalsCreated === 1 ? '' : 'len'} klaargezet om goed te keuren.` : 'Klaar — bekijk de run hieronder.', 'success');
      setRunsKey((k) => k + 1); reload(); onApprovalsChanged();
    } catch (e) { notify(e instanceof Error ? e.message : 'Draaien mislukt.', 'error'); }
    finally { setBusyId(null); }
  }

  // Is er net vanuit de chat een agent aangemaakt? Dan klapt hij hier meteen open,
  // zodat je zijn eerste run ziet binnenkomen. Daarna melden we hem als verbruikt,
  // zodat een terugkeer naar dit tabblad hem niet opnieuw opendwingt.
  useEffect(() => {
    if (!openAgentId) return;
    setOpenId(openAgentId);
    onOpenAgentConsumed?.();
  }, [openAgentId, onOpenAgentConsumed]);

  // Een geopende agent hoort in beeld te komen; op een lang scherm staat het
  // paneel anders onder de vouw en lijkt de klik niets te doen.
  useEffect(() => {
    if (!openId || !sheetRef.current) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    sheetRef.current.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [openId]);

  /**
   * Bouwt de agent uit het gesprek en laat hem meteen beginnen.
   *
   * `startNow` staat standaard aan: je hebt zojuist verteld wat hij mag en wanneer
   * hij draait, dus een agent die daarna nog als slapend concept blijft liggen is
   * gewoon een extra klik. Hij gaat aan én draait direct één ronde, zodat je binnen
   * een minuut ziet wat hij oplevert. De eerste run wachten we niet af — die duurt
   * tientallen seconden en hoort thuis in de historie hieronder.
   */
  async function createFromBuilder(p: GerrieAgentProposal, startNow: boolean) {
    const routine = proposalToRoutine(p);
    const saved = await saveRoutine(organizationId, {
      name: routine.name, instruction: routine.instruction,
      icon: p.icon, hue: null,
      email_mode: routine.email_mode, email_subject: routine.email_subject, email_body: routine.email_body,
      max_emails_per_run: routine.max_emails_per_run,
      model_kind: 'cheap', mode: routine.mode, enabled_tools: routine.enabled_tools,
      schedule_kind: routine.schedule_kind, hour: routine.hour,
      day_of_week: routine.day_of_week, day_of_month: routine.day_of_month,
      timezone: 'Europe/Amsterdam', delivery: { channels: ['inapp'] },
    }, undefined, startNow);
    setEditing(null);
    setOpenId(saved.id ?? null);
    if (startNow && saved.id) {
      // Activeren zat al in het aanmaken; is dat toch niet gelukt, dan zeggen we dat
      // eerlijk in plaats van te doen alsof hij draait.
      if (saved.status !== 'active') {
        try { await setRoutineStatus(organizationId, saved.id as UUID, 'active'); }
        catch { notify('Agent aangemaakt, maar aanzetten lukte niet. Zet hem zelf aan.', 'error'); reload(); return; }
      }
      notify('Agent staat aan en draait zijn eerste ronde…', 'info', true);
      runRoutineNow(organizationId, saved.id as UUID)
        .then((res) => {
          notify(res.proposalsCreated
            ? `Eerste ronde klaar — ${res.proposalsCreated} voorstel${res.proposalsCreated === 1 ? '' : 'len'} om af te vinken.`
            : 'Eerste ronde klaar — bekijk het resultaat hieronder.', 'success');
          setRunsKey((k) => k + 1); onApprovalsChanged();
        })
        .catch((e) => notify(e instanceof Error ? e.message : 'De eerste ronde mislukte; kijk in de historie.', 'error'));
    } else {
      notify('Agent aangemaakt als concept.', 'success');
    }
    reload();
  }

  if (editing === 'build') {
    return <AgentBuilder
      organizationId={organizationId}
      onCreate={createFromBuilder}
      onOpenForm={(p) => setEditing(p ? proposalToRoutine(p) : 'new')}
      onCancel={() => setEditing(null)}
    />;
  }
  if (editing) {
    return <RoutineEditor organizationId={organizationId} routine={editing === 'new' ? null : editing}
      onDone={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />;
  }

  const open = routines.find((r) => r.id === openId) ?? null;
  // Gearchiveerde agents staan apart: ze werken niet meer, maar hun logboek blijft.
  const live = routines.filter((r) => r.status !== 'archived');
  const archived = routines.filter((r) => r.status === 'archived');

  return (
    <div className="ag-page">
      <header className="ag-page-head">
        <div>
          <h2>Je agents</h2>
          <p>Elk embleem is een agent die vanzelf op zijn eigen moment draait. <b>Hij stelt voor, jij vinkt af</b> — er gaat niets de deur uit zonder jouw akkoord.</p>
        </div>
        <button className="cc-btn primary" onClick={() => setEditing('build')}><Plus size={15} /> Nieuwe agent</button>
      </header>

      {toast && (
        <div className={`cc-routines-toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.kind === 'success' ? <Check size={15} /> : toast.kind === 'error' ? <AlertTriangle size={15} /> : <Loader2 size={15} className="cc-spin" />}
          <span>{toast.text}</span>
        </div>
      )}
      {error && <div className="cc-plan-error">{error}</div>}

      {loading ? <p className="ag-loading"><Loader2 size={14} className="cc-spin" /> Agents laden…</p> : <>
        {live.length === 0 ? (
          <div className="ag-starters">
            <p className="ag-starters-lead">Je hebt nog geen agents. Kies een startpunt — je kunt daarna alles nog aanpassen.</p>
            <div className="ag-starter-grid">
              {ROUTINE_TEMPLATES.map((t) => (
                <button key={t.name} type="button" className="ag-starter" onClick={() => setEditing(templateToRoutine(t))}>
                  <AgentGlyph agent={{ id: t.name, name: t.name, icon: t.icon, hue: t.hue }} size="lg" />
                  <strong>{t.name}</strong>
                  <span>{t.blurb}</span>
                </button>
              ))}
              <button type="button" className="ag-starter ag-starter-blank" onClick={() => setEditing('build')}>
                <span className="ag-tile-plus" aria-hidden="true"><Wand2 size={24} /></span>
                <strong>Vertel het Gerrie</strong>
                <span>Zeg in je eigen woorden wat je nodig hebt; hij bouwt de agent.</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="ag-grid">
            {live.map((r) => {
              const waiting = pendingByAgent[r.id] ?? 0;
              const isOpen = openId === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`ag-tile${isOpen ? ' is-open' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => setOpenId(isOpen ? null : r.id)}
                >
                  {waiting > 0 && <span className="ag-tile-badge" title={`${waiting} wacht op jouw akkoord`}>{waiting}</span>}
                  <AgentGlyph agent={r} size="lg" state={busyId === r.id ? 'running' : r.status} />
                  <strong className="ag-tile-name">{r.name || 'Naamloze agent'}</strong>
                  <span className="ag-tile-rhythm"><Clock size={11} /> {shortSchedule(r)}</span>
                  <span className={`ag-tile-state is-${r.status}`}>{routineStatusLabel(r.status)}</span>
                  <span className="ag-tile-hint">{isOpen ? <>Sluiten <ChevronUp size={12} /></> : <>Wat kan hij? <ChevronDown size={12} /></>}</span>
                </button>
              );
            })}
            <button type="button" className="ag-tile ag-tile-new" onClick={() => setEditing('build')}>
              <span className="ag-tile-plus" aria-hidden="true"><Wand2 size={24} /></span>
              <strong className="ag-tile-name">Nieuwe agent</strong>
              <span className="ag-tile-rhythm">Vertel wat je nodig hebt</span>
            </button>
          </div>
        )}

        {open && (
          <div className="ag-sheet" ref={sheetRef}>
            <AgentSheet
              routine={open}
              organizationId={organizationId}
              canWrite={canWrite}
              handlers={handlers}
              busy={busyId === open.id}
              runsKey={runsKey}
              budget={budget}
              waiting={pendingByAgent[open.id] ?? 0}
              onRunNow={() => void doRunNow(open)}
              onStatus={(s) => void doStatus(open, s)}
              onEdit={() => setEditing(open)}
              onArchive={() => void doArchive(open)}
              onRestore={() => void doRestore(open)}
              onClose={() => setOpenId(null)}
              onApprovalsChanged={onApprovalsChanged}
            />
          </div>
        )}

        {/* Het archief: agents die niet meer draaien maar wél verantwoording dragen.
            Standaard dicht, want dit is naslag — geen dagelijks werk. */}
        {archived.length > 0 && (
          <section className="ag-archive">
            <button type="button" className="ag-archive-head" aria-expanded={showArchive} onClick={() => setShowArchive((v) => !v)}>
              {showArchive ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Archive size={14} />
              <strong>Archief</strong>
              <span>{archived.length} gearchiveerde agent{archived.length === 1 ? '' : 's'} — hun logboek blijft raadpleegbaar</span>
            </button>
            {showArchive && (
              <div className="ag-grid ag-grid-archive">
                {archived.map((r) => {
                  const isOpen = openId === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      className={`ag-tile is-archived${isOpen ? ' is-open' : ''}`}
                      aria-expanded={isOpen}
                      onClick={() => setOpenId(isOpen ? null : r.id)}
                    >
                      <AgentGlyph agent={r} size="lg" state="archived" />
                      <strong className="ag-tile-name">{r.name || 'Naamloze agent'}</strong>
                      <span className="ag-tile-rhythm"><Archive size={11} /> {r.archived_at ? fmtWhen(r.archived_at) : 'gearchiveerd'}</span>
                      <span className="ag-tile-state is-archived">Gearchiveerd</span>
                      <span className="ag-tile-hint">{isOpen ? <>Sluiten <ChevronUp size={12} /></> : <>Logboek <ChevronDown size={12} /></>}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </>}
    </div>
  );
}

/**
 * Wat de tegel bewust NIET laat zien: hier staat het. Eerst wat de agent mag —
 * lezen, voorstellen, wanneer, waar het heen gaat en binnen welke grenzen — dan
 * zijn opdracht, dan de knoppen, en onderaan wat hij tot nu toe gedaan heeft.
 */
function AgentSheet({ routine, organizationId, canWrite, handlers, busy, runsKey, budget, waiting, onRunNow, onStatus, onEdit, onArchive, onRestore, onClose, onApprovalsChanged }: {
  routine: GerrieRoutine;
  organizationId: UUID;
  canWrite: boolean;
  handlers: GerrieActionHandlers;
  busy: boolean;
  runsKey: number;
  /** Resterend maandtegoed van het account als fractie 0..1; null = geen limiet. */
  budget: number | null;
  waiting: number;
  onRunNow: () => void;
  onStatus: (status: RoutineStatus) => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onClose: () => void;
  onApprovalsChanged: () => void;
}) {
  const readTools = routine.enabled_tools.filter((n) => !n.startsWith('propose_'));
  const proposeTools = routine.enabled_tools.filter((n) => n.startsWith('propose_'));
  const emailToo = Array.isArray(routine.delivery?.channels) && routine.delivery.channels.includes('email');
  const isArchived = routine.status === 'archived';

  return (
    <>
      <header className="ag-sheet-head">
        <AgentGlyph agent={routine} size="lg" state={busy ? 'running' : routine.status} />
        <div className="ag-sheet-ident">
          <h3>{routine.name || 'Naamloze agent'}</h3>
          <div className="ag-sheet-pills">
            <span className={`cc-pill ${routine.status === 'active' ? 'run' : routine.status === 'paused' ? 'wait' : 'cancel'}`}><span className="cc-dot" />{routineStatusLabel(routine.status)}</span>
            <span className={`cc-kind ${routine.mode === 'propose' ? 'write' : 'read'}`}>{routine.mode === 'propose' ? 'stelt acties voor' : 'alleen lezen'}</span>
            {waiting > 0 && <span className="ag-sheet-waiting"><ClipboardCheck size={12} /> {waiting} wacht op jou</span>}
          </div>
        </div>
        <button type="button" className="ag-sheet-close" onClick={onClose} aria-label="Sluiten"><X size={16} /></button>
      </header>

      {isArchived && (
        <p className="ag-archived-note">
          <Archive size={13} />
          <span>
            Deze agent is gearchiveerd{routine.archived_at ? ` op ${fmtWhen(routine.archived_at)}` : ''} en draait niet meer.
            Zijn volledige logboek staat hieronder; zet hem terug als je hem weer wilt gebruiken.
          </span>
        </p>
      )}

      <div className="ag-caps">
        <Capability icon={<Eye size={14} />} title="Mag inzien">
          {readTools.length === 0
            ? <span className="ag-cap-plain">De standaard leesset (klanten, facturen, herinneringen).</span>
            : <div className="ag-cap-chips">{readTools.map((n) => <span key={n} className="ag-cap-chip">{routineToolLabel(n)}</span>)}</div>}
        </Capability>

        <Capability icon={<ClipboardCheck size={14} />} title="Mag voorstellen">
          {routine.mode !== 'propose' || proposeTools.length === 0
            ? <span className="ag-cap-plain">Niets — deze agent rapporteert alleen en raakt nooit iets aan.</span>
            : <div className="ag-cap-chips">{proposeTools.map((n) => <span key={n} className="ag-cap-chip is-write">{routineToolLabel(n)}</span>)}</div>}
        </Capability>

        <Capability icon={<Clock size={14} />} title="Ritme">
          <span className="ag-cap-plain">{scheduleLabel(routine)}</span>
          <span className="ag-cap-note">Volgende: {fmtWhen(routine.next_run_at)}{routine.last_run_at ? ` · laatste: ${fmtWhen(routine.last_run_at)}` : ''}</span>
        </Capability>

        <Capability icon={<Mailbox size={14} />} title="Bezorging">
          <span className="ag-cap-plain">In de app{emailToo ? ' én per e-mail' : ''}</span>
        </Capability>

        {/* Eén budget: het maandtegoed van het account. Hier stond eerder "max € per
            run · hoogstens N× per dag" — twee grenzen die nergens werden afgedwongen.
            Een scherm dat een grens belooft die de code niet kent is erger dan geen
            grens tonen, dus staat er nu alleen wat écht geldt. */}
        <Capability icon={<Gauge size={14} />} title="Kosten">
          <span className="ag-cap-plain">{routine.model_kind === 'strong' ? 'Krachtig model' : 'Zuinig model'}</span>
          <span className="ag-cap-note">
            Wat hij verbruikt gaat van het maandtegoed van je account
            {budget !== null ? ` — daarvan is nog ${Math.round(budget * 100)}% over` : ''}.
            {budget !== null && budget <= 0 ? ' Hij slaat runs over tot volgende maand.' : ''}
          </span>
        </Capability>

        <Capability icon={<Users2 size={14} />} title="Bevoegdheid">
          <span className="ag-cap-plain">{routine.mode === 'propose' ? 'Zet klaar, verstuurt nooit zelf' : 'Kijkt mee, verandert niets'}</span>
          {routine.consecutive_failures > 0 && <span className="ag-cap-note">{routine.consecutive_failures}× achter elkaar mislukt</span>}
        </Capability>
      </div>

      {routine.instruction && (
        <div className="ag-brief">
          <span className="ag-brief-label"><BookOpen size={13} /> Zijn opdracht</span>
          <p>{routine.instruction}</p>
        </div>
      )}

      <div className="ag-sheet-actions">
        {isArchived ? (
          <button className="cc-btn tiny primary" disabled={busy} onClick={onRestore}>
            {busy ? <><Loader2 size={13} className="cc-spin" /> Bezig…</> : <><ArchiveRestore size={13} /> Terugzetten</>}
          </button>
        ) : <>
          <button className="cc-btn tiny ghost" disabled={busy} onClick={onRunNow}>
            {busy ? <><Loader2 size={13} className="cc-spin" /> Draait…</> : <><Play size={13} /> Nu draaien</>}
          </button>
          {routine.status === 'active'
            ? <button className="cc-btn tiny ghost" disabled={busy} onClick={() => onStatus('paused')}><Pause size={13} /> Pauzeren</button>
            : <button className="cc-btn tiny primary" disabled={busy} onClick={() => onStatus('active')}><Play size={13} /> Activeren</button>}
          <button className="cc-btn tiny ghost" onClick={onEdit}><Pencil size={13} /> Bewerken</button>
          <span className="ag-sheet-spacer" />
          {/* Geen "verwijderen": wat hij namens jou deed gooien we niet weg. */}
          <button className="cc-btn tiny ghost danger" disabled={busy} onClick={onArchive} title="De agent stopt; zijn logboek blijft bewaard">
            <Archive size={13} /> Archiveren
          </button>
        </>}
      </div>

      <div className="ag-history">
        <span className="ag-history-label"><RotateCw size={13} /> Wat heeft hij gedaan?</span>
        <RoutineRuns organizationId={organizationId} agentId={routine.id} canWrite={canWrite} handlers={handlers}
          refreshKey={runsKey} onApprovalsChanged={onApprovalsChanged} />
      </div>
    </>
  );
}

function Capability({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="ag-cap">
      <span className="ag-cap-icon" aria-hidden="true">{icon}</span>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

interface EditorFields {
  name: string; instruction: string; mode: RoutineMode; model_kind: 'cheap' | 'strong';
  schedule_kind: RoutineScheduleKind; hour: number; day_of_week: number; day_of_month: number; tools: string[]; email: boolean;
  /** null = laat de app het embleem afleiden uit naam + opdracht + tools. */
  icon: AgentIconKey | null; hue: number | null;
  /** Klantmail: wie schrijft, welke vaste tekst, en hoeveel mails per run. */
  email_mode: AgentEmailMode; email_subject: string; email_body: string; max_emails: number;
}

const MAIL_TOOL = 'propose_send_client_email';

function RoutineEditor({ organizationId, routine, onDone, onCancel }: { organizationId: UUID; routine: GerrieRoutine | null; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState<EditorFields>(() => ({
    name: routine?.name ?? '',
    instruction: routine?.instruction ?? '',
    mode: routine?.mode ?? 'report',
    model_kind: routine?.model_kind ?? 'cheap',
    schedule_kind: routine?.schedule_kind ?? 'weekly',
    hour: routine?.hour ?? 8,
    day_of_week: routine?.day_of_week ?? 1,
    day_of_month: routine?.day_of_month ?? 1,
    tools: routine?.enabled_tools ?? [],
    email: Array.isArray(routine?.delivery?.channels) ? routine!.delivery.channels.includes('email') : false,
    icon: (routine?.icon as AgentIconKey | null) ?? null,
    hue: routine?.hue ?? null,
    email_mode: routine?.email_mode ?? 'compose',
    email_subject: routine?.email_subject ?? '',
    email_body: routine?.email_body ?? '',
    max_emails: routine?.max_emails_per_run ?? 5,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const isNew = !routine || !routine.id;
  const mailsClients = f.tools.includes(MAIL_TOOL);

  // Alles wat een agent kán, opgehaald bij de bron in plaats van uit een lijst hier.
  // Zo krijgt een agent elke nieuwe Gerrie-capability automatisch, en zie je alleen
  // wat jouw modulerechten toestaan.
  const [catalog, setCatalog] = useState<RoutineTool[]>([]);
  const [catalogFallback, setCatalogFallback] = useState(false);
  useEffect(() => {
    let alive = true;
    listRoutineToolsSafe(organizationId).then(({ tools, fallback }) => {
      if (!alive) return;
      setCatalog(tools);
      setCatalogFallback(fallback);
    });
    return () => { alive = false; };
  }, [organizationId]);
  const readTools = catalog.filter((t) => t.kind === 'read');
  const proposeTools = catalog.filter((t) => t.kind === 'propose');

  /** Plakt een variabele op de cursorpositie in de vaste tekst. */
  function insertToken(token: string) {
    const el = bodyRef.current;
    const snippet = `{{${token}}}`;
    if (!el) { setF((p) => ({ ...p, email_body: `${p.email_body}${snippet}` })); return; }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setF((p) => ({ ...p, email_body: `${p.email_body.slice(0, start)}${snippet}${p.email_body.slice(end)}` }));
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + snippet.length;
      el.setSelectionRange(caret, caret);
    });
  }

  // Het embleem in de kop is een levend voorbeeld: typ je "facturen", dan verandert
  // het icoon mee zolang je zelf niets gekozen hebt.
  const preview = { id: routine?.id || 'nieuw', name: f.name, instruction: f.instruction, enabled_tools: f.tools, icon: f.icon, hue: f.hue };
  const derivedIcon = agentIconKey({ ...preview, icon: null });

  function toggleTool(name: string) {
    setF((p) => ({ ...p, tools: p.tools.includes(name) ? p.tools.filter((t) => t !== name) : [...p.tools, name] }));
  }

  async function save() {
    if (!f.instruction.trim()) { setErr('Geef een opdracht voor de agent.'); return; }
    // Een vaste tekst zonder tekst levert een agent op die elke run stukloopt;
    // dat hoor je hier te horen, niet pas bij de eerste run.
    if (mailsClients && f.email_mode === 'template' && !f.email_body.trim()) {
      setErr('Je hebt gekozen voor een vaste mailtekst — vul die dan ook in.'); return;
    }
    if (mailsClients && f.email_mode === 'template' && !f.email_subject.trim()) {
      setErr('Geef een onderwerp voor de vaste mailtekst.'); return;
    }
    setSaving(true); setErr(null);
    const input: GerrieRoutineInput = {
      name: f.name.trim() || 'Naamloze agent',
      instruction: f.instruction.trim(),
      icon: f.icon, hue: f.hue,
      email_mode: f.email_mode,
      email_subject: f.email_subject.trim() || null,
      email_body: f.email_body.trim() || null,
      max_emails_per_run: f.max_emails,
      model_kind: f.model_kind, mode: f.mode, enabled_tools: f.tools,
      schedule_kind: f.schedule_kind, hour: f.hour,
      day_of_week: f.schedule_kind === 'weekly' ? f.day_of_week : null,
      day_of_month: f.schedule_kind === 'monthly' ? f.day_of_month : null,
      timezone: 'Europe/Amsterdam',
      delivery: { channels: f.email ? ['inapp', 'email'] : ['inapp'] },
    };
    try {
      await saveRoutine(organizationId, input, routine && routine.id ? routine.id : undefined);
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Opslaan mislukt.'); setSaving(false); }
  }

  return (
    <div className="ag-page">
      <header className="ag-page-head">
        <div className="ag-editor-ident">
          <AgentGlyph agent={preview} size="lg" />
          <div>
            <h2>{isNew ? 'Nieuwe agent' : 'Agent bewerken'}</h2>
            <p>{f.name.trim() || 'Geef hem een naam, een opdracht en een moment.'}</p>
          </div>
        </div>
        <button className="cc-btn ghost" onClick={onCancel}><X size={14} /> Sluiten</button>
      </header>
      <div className="cc-card cc-routine-form">
        <label className="cc-field"><span>Naam</span>
          <input className="cc-text" value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} placeholder="Bijv. Wekelijks factuuroverzicht" />
        </label>
        <label className="cc-field"><span>Opdracht (in gewone taal)</span>
          <textarea className="cc-input" rows={3} value={f.instruction} onChange={(e) => setF((p) => ({ ...p, instruction: e.target.value }))} placeholder="Bijv. Geef een overzicht van openstaande facturen ouder dan 30 dagen." />
        </label>

        <div className="cc-field"><span>Zijn gezicht</span>
          <div className="ag-picker">
            <button
              type="button"
              className={`ag-pick-icon${f.icon === null ? ' on' : ''}`}
              onClick={() => setF((p) => ({ ...p, icon: null }))}
              title="Laat Gerrie het icoon kiezen op basis van de opdracht"
            >
              <AgentGlyph agent={{ ...preview, icon: null }} size="sm" />
              <span className="ag-pick-auto">Automatisch</span>
            </button>
            {AGENT_ICONS.map((d) => (
              <button
                key={d.key}
                type="button"
                className={`ag-pick-icon${f.icon === d.key ? ' on' : ''}`}
                onClick={() => setF((p) => ({ ...p, icon: d.key }))}
                title={d.label}
                aria-label={d.label}
                aria-pressed={f.icon === d.key}
              >
                <AgentGlyph agent={{ ...preview, icon: d.key }} size="sm" />
              </button>
            ))}
          </div>
          {/* Geen kleurkiezer meer: elk embleem draagt het merkgoud. Een kiezer die
              twaalf tinten aanbiedt die allemaal hetzelfde opleveren, zou een keuze
              suggereren die er niet is. */}
          <p className="cc-note">Alle emblemen dragen de merkkleur; het <b>icoon</b> maakt het verschil. Kies je niets, dan leidt Gerrie het af uit de opdracht — nu <b>{AGENT_ICONS.find((d) => d.key === derivedIcon)?.label ?? 'Robot'}</b>.</p>
        </div>
        <div className="cc-field-row">
          <label className="cc-field"><span>Wat mag de agent?</span>
            <select className="cc-text" value={f.mode} onChange={(e) => setF((p) => ({ ...p, mode: e.target.value as RoutineMode }))}>
              <option value="report">Alleen rapporteren (lezen)</option>
              <option value="propose">Voorstellen doen (jij keurt goed)</option>
            </select>
          </label>
          <label className="cc-field"><span>Model</span>
            <select className="cc-text" value={f.model_kind} onChange={(e) => setF((p) => ({ ...p, model_kind: e.target.value === 'strong' ? 'strong' : 'cheap' }))}>
              <option value="cheap">Zuinig</option>
              <option value="strong">Krachtig</option>
            </select>
          </label>
        </div>
        {f.mode === 'report' && <p className="cc-note">Wil je dat de agent ook iets kan <b>versturen of aanmaken</b> (bv. herinneringen of facturen)? Zet “Wat mag de agent?” op <b>Voorstellen doen</b>.</p>}
        <div className="cc-field-row">
          <label className="cc-field"><span>Wanneer</span>
            <select className="cc-text" value={f.schedule_kind} onChange={(e) => setF((p) => ({ ...p, schedule_kind: e.target.value as RoutineScheduleKind }))}>
              <option value="daily">Elke dag</option>
              <option value="weekly">Wekelijks</option>
              <option value="monthly">Maandelijks</option>
            </select>
          </label>
          {f.schedule_kind === 'weekly' && (
            <label className="cc-field"><span>Dag</span>
              <select className="cc-text" value={f.day_of_week} onChange={(e) => setF((p) => ({ ...p, day_of_week: Number(e.target.value) }))}>
                {DOW_NAMES.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
              </select>
            </label>
          )}
          {f.schedule_kind === 'monthly' && (
            <label className="cc-field"><span>Dag v/d maand</span>
              <input className="cc-text" type="number" min={1} max={31} value={f.day_of_month} onChange={(e) => setF((p) => ({ ...p, day_of_month: Number(e.target.value) }))} />
            </label>
          )}
          <label className="cc-field"><span>Uur</span>
            <input className="cc-text" type="number" min={0} max={23} value={f.hour} onChange={(e) => setF((p) => ({ ...p, hour: Number(e.target.value) }))} />
          </label>
        </div>

        <div className="cc-field"><span>Welke gegevens mag de agent gebruiken?</span>
          <ToolPicker tools={readTools} chosen={f.tools} onToggle={toggleTool} />
          {catalogFallback && <p className="cc-note">De volledige lijst was even niet op te halen; je ziet een beperkte set. Herlaad de pagina om alles te zien.</p>}
        </div>
        {f.mode === 'propose' && (
          <div className="cc-field"><span>Acties die de agent mag vóórstellen</span>
            <ToolPicker tools={proposeTools} chosen={f.tools} onToggle={toggleTool} />
            <p className="cc-note">De agent <b>stelt deze acties alleen voor</b>. Jij keurt ze daarna goed — per regel, met een vinkje — en dán worden ze <b>écht uitgevoerd</b> (verstuurd/aangemaakt), via dezelfde weg als in de chat. Zonder jouw akkoord gebeurt er niets.</p>
          </div>
        )}

        {f.mode === 'propose' && mailsClients && (
          <div className="cc-field ag-mailbox">
            <span>Het mailtje naar de klant</span>
            <div className="ag-mailmode">
              <label className={`ag-mailmode-opt${f.email_mode === 'compose' ? ' on' : ''}`}>
                <input type="radio" name="ag-email-mode" checked={f.email_mode === 'compose'}
                  onChange={() => setF((p) => ({ ...p, email_mode: 'compose' }))} />
                <b>Gerrie schrijft hem</b>
                <em>Per klant een eigen tekst, passend bij wat hij ziet. Jij leest elke mail vóór hij weggaat.</em>
              </label>
              <label className={`ag-mailmode-opt${f.email_mode === 'template' ? ' on' : ''}`}>
                <input type="radio" name="ag-email-mode" checked={f.email_mode === 'template'}
                  onChange={() => setF((p) => ({ ...p, email_mode: 'template' }))} />
                <b>Jouw vaste tekst</b>
                <em>Altijd hetzelfde bericht, met variabelen ingevuld. De agent kiest alleen wie hem krijgt.</em>
              </label>
            </div>

            {f.email_mode === 'template' && <>
              <label className="cc-field"><span>Onderwerp</span>
                <input className="cc-text" value={f.email_subject} maxLength={300}
                  onChange={(e) => setF((p) => ({ ...p, email_subject: e.target.value }))}
                  placeholder="Bijv. Even bijpraten over je project" />
              </label>
              <label className="cc-field"><span>Tekst</span>
                <textarea ref={bodyRef} className="cc-input" rows={7} value={f.email_body} maxLength={8000}
                  onChange={(e) => setF((p) => ({ ...p, email_body: e.target.value }))}
                  placeholder={'Beste {{voornaam|klant}},\n\n…\n\nMet vriendelijke groet'} />
              </label>
              <div className="ag-tokens">
                <span className="ag-tokens-label">Variabelen — klik om in te voegen</span>
                <div className="ag-tokens-chips">
                  {STANDARD_MERGE_TOKENS.map((t) => (
                    <button key={t.token} type="button" className="cc-chip" title={`${t.label} (${t.group})`}
                      onClick={() => insertToken(t.token)}>{t.label}</button>
                  ))}
                </div>
              </div>
            </>}

            <label className="cc-field"><span>Hoogstens zoveel mails per run</span>
              <input className="cc-text ag-num" type="number" min={1} max={25} value={f.max_emails}
                onChange={(e) => setF((p) => ({ ...p, max_emails: Math.max(1, Math.min(25, Number(e.target.value) || 1)) }))} />
            </label>
            <p className="cc-note">Het plafond geldt <b>per run</b>: meer klanten dan dit worden niet stilzwijgend gemaild maar gewoon niet klaargezet. Klanten zonder e-mailadres vallen sowieso af.</p>
          </div>
        )}

        <label className="cc-tool cc-tool-wide"><input type="checkbox" checked={f.email} onChange={(e) => setF((p) => ({ ...p, email: e.target.checked }))} /> Stuur me ook een e-mail met het resultaat</label>

        {err && <div className="cc-plan-error">{err}</div>}
        <div className="cc-routine-form-foot">
          <button className="cc-btn ghost" onClick={onCancel} disabled={saving}>Annuleren</button>
          <button className="cc-btn primary" onClick={() => void save()} disabled={saving}>{saving ? 'Opslaan…' : isNew ? 'Aanmaken' : 'Opslaan'}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * De capability-kiezer. Groepeert per module (Klanten, Financiën, Projecten…),
 * want de catalogus groeit mee met de app en een ongesorteerde lijst van dertig
 * vinkjes is geen keuze meer maar een muur.
 */
function ToolPicker({ tools, chosen, onToggle }: { tools: RoutineTool[]; chosen: string[]; onToggle: (name: string) => void }) {
  // De lijst telt inmiddels honderden regels: alles wat de app kan, staat erin.
  // Zonder zoekveld scrol je je een ongeluk om "galerij publiceren" te vinden.
  const [query, setQuery] = useState('');
  if (tools.length === 0) return <p className="cc-note">Laden…</p>;

  const needle = query.trim().toLowerCase();
  // Aangevinkte regels blijven altijd staan, ook als ze buiten het filter vallen —
  // anders lijkt het alsof je selectie verdwijnt zodra je begint te typen.
  const visible = needle
    ? tools.filter((t) => chosen.includes(t.name)
        || t.label.toLowerCase().includes(needle)
        || t.name.toLowerCase().includes(needle)
        || (t.moduleLabel ?? '').toLowerCase().includes(needle))
    : tools;

  // Volgorde van eerste voorkomen aanhouden: die volgt de tooldefinities, en die
  // staan al in een logische volgorde (klanten → geld → werk → agenda).
  const groups: Array<{ key: string; label: string; tools: RoutineTool[] }> = [];
  for (const t of visible) {
    const key = t.module ?? 'overig';
    const label = t.moduleLabel ?? 'Overig';
    let group = groups.find((g) => g.key === key);
    if (!group) { group = { key, label, tools: [] }; groups.push(group); }
    group.tools.push(t);
  }

  return (
    <div className="cc-tool-groups">
      <input
        className="cc-input"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Zoek in ${tools.length} dingen die hij kan…`}
        aria-label="Zoek een capability"
      />
      {needle && visible.length === 0 && <p className="cc-note">Niets gevonden voor “{query}”.</p>}
      {groups.map((g) => (
        <section key={g.key} className="cc-tool-group">
          <h5>{g.label}</h5>
          <div className="cc-tool-grid">
            {g.tools.map((t) => (
              <label key={t.name} className={`cc-tool${chosen.includes(t.name) ? ' on' : ''}`}>
                <input type="checkbox" checked={chosen.includes(t.name)} onChange={() => onToggle(t.name)} /> {t.label}
              </label>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Spin({ size = 14 }: { size?: number }) { return <Loader2 size={size} className="cc-spin" />; }

function runPillClass(s: RoutineRunStatus): string {
  return s === 'succeeded' ? 'done' : s === 'failed' ? 'fail' : (s === 'running' || s === 'claimed') ? 'run' : s === 'partial' ? 'wait' : 'cancel';
}

function RoutineRuns({ organizationId, agentId, canWrite, handlers, refreshKey, onApprovalsChanged }: { organizationId: UUID; agentId: UUID; canWrite: boolean; handlers: GerrieActionHandlers; refreshKey: number; onApprovalsChanged?: () => void }) {
  const [runs, setRuns] = useState<GerrieRoutineRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listRoutineRuns(organizationId, agentId)
      .then((r) => { if (alive) setRuns(r); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Runs laden mislukt.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [organizationId, agentId, refreshKey]);

  if (loading) return <div className="cc-runs"><Spin size={13} /> Runs laden…</div>;
  if (err) return <div className="cc-runs cc-plan-error">{err}</div>;
  if (runs.length === 0) return <div className="cc-runs cc-rail-empty">Nog geen runs. Klik “Nu draaien” om te testen.</div>;

  return (
    <div className="cc-runs">
      {runs.map((run, i) => (
        <RunItem key={run.id} run={run} organizationId={organizationId} canWrite={canWrite} handlers={handlers} defaultOpen={i === 0} onApprovalsChanged={onApprovalsChanged} />
      ))}
    </div>
  );
}

function RunItem({ run, organizationId, canWrite, handlers, defaultOpen, onApprovalsChanged }: { run: GerrieRoutineRun; organizationId: UUID; canWrite: boolean; handlers: GerrieActionHandlers; defaultOpen: boolean; onApprovalsChanged?: () => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const running = run.status === 'running' || run.status === 'claimed';
  return (
    <div className={`cc-run${open ? ' open' : ''}`}>
      <button className="cc-run-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="cc-run-chev">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
        <span className={`cc-pill ${runPillClass(run.status)}`}>{running ? <Spin size={11} /> : <span className="cc-dot" />}{runStatusLabel(run.status)}</span>
        <span className="cc-run-when">{fmtWhen(run.created_at)}</span>
        {run.triggered_by === 'manual' && <span className="cc-run-tag">handmatig</span>}
        {run.proposals_created > 0 && <span className="cc-run-badge">{run.proposals_created} voorstel{run.proposals_created === 1 ? '' : 'len'}</span>}
        {!open && run.summary && <span className="cc-run-peek">{run.summary}</span>}
      </button>
      {open && <RunDetail run={run} organizationId={organizationId} canWrite={canWrite} handlers={handlers} onApprovalsChanged={onApprovalsChanged} />}
    </div>
  );
}

type PropState = 'idle' | 'busy' | 'done' | 'rejected' | 'error';

function RunDetail({ run, organizationId, canWrite, handlers, onApprovalsChanged }: { run: GerrieRoutineRun; organizationId: UUID; canWrite: boolean; handlers: GerrieActionHandlers; onApprovalsChanged?: () => void }) {
  const [transcript, setTranscript] = useState<GerrieRunMessage[]>([]);
  const [proposals, setProposals] = useState<Array<{ auditId: string; proposal: GerrieProposal }>>([]);
  const [events, setEvents] = useState<GerrieRunEvent[]>([]);
  const [decisions, setDecisions] = useState<GerrieRunDecision[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [reply, setReply] = useState('');
  const [replying, setReplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pstate, setPstate] = useState<Record<string, PropState>>({});
  const [pmsg, setPmsg] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const convId = run.conversation_id;
    Promise.all([
      convId ? loadRunTranscript(organizationId, convId) : Promise.resolve([] as GerrieRunMessage[]),
      listRunProposals(organizationId, run.id),
      // Het logboek en de afloop van de voorstellen: samen "wat heeft hij gedaan,
      // en wat is daar vervolgens mee gebeurd?".
      listRunEvents(organizationId, run.id).catch(() => [] as GerrieRunEvent[]),
      listRunDecisions(organizationId, run.id).catch(() => [] as GerrieRunDecision[]),
    ])
      .then(([t, p, e, d]) => { if (alive) { setTranscript(t); setProposals(p); setEvents(e); setDecisions(d); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : 'Laden mislukt.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [organizationId, run.id, run.conversation_id, refresh]);

  // Alleen de afgehandelde beslissingen; wat nog openstaat toont het bord hieronder.
  const settled = decisions.filter((d) => d.status !== 'proposed');

  async function sendReply() {
    const m = reply.trim();
    if (!m || replying) return;
    setReplying(true); setErr(null);
    // Een antwoord kan alsnog een voorstel opleveren; de tellers moeten dat zien.
    try { await replyToRun(organizationId, run.id, m); setReply(''); setRefresh((x) => x + 1); onApprovalsChanged?.(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Antwoord mislukt.'); }
    finally { setReplying(false); }
  }
  async function approve(auditId: string, p: GerrieProposal) {
    setPstate((s) => ({ ...s, [auditId]: 'busy' }));
    try {
      await executeProposal(p, handlers);
      void confirmGerrieAction(organizationId, auditId, 'executed');
      setPstate((s) => ({ ...s, [auditId]: 'done' }));
      onApprovalsChanged?.();
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Uitvoeren mislukt.';
      void confirmGerrieAction(organizationId, auditId, 'failed', m);
      setPstate((s) => ({ ...s, [auditId]: 'error' })); setPmsg((x) => ({ ...x, [auditId]: m }));
      onApprovalsChanged?.();
    }
  }
  function reject(auditId: string) {
    void confirmGerrieAction(organizationId, auditId, 'failed', 'Afgewezen door gebruiker.');
    setPstate((s) => ({ ...s, [auditId]: 'rejected' }));
    onApprovalsChanged?.();
  }

  return (
    <div className="cc-run-detail">
      {loading ? <div className="cc-run-loading"><Spin size={13} /> Laden…</div> : (
        <>
          {transcript.length > 0 ? (
            <div className="cc-thread">
              {transcript.map((m, i) => <div key={i} className={`cc-msg ${m.role}`}>{m.content}</div>)}
            </div>
          ) : run.summary ? <div className="cc-msg assistant">{run.summary}</div> : null}
          {run.error && <div className="cc-lane-err"><AlertTriangle size={13} /> {run.error}</div>}

          {proposals.map(({ auditId, proposal }) => {
            const info = proposalLabel(proposal);
            const st = pstate[auditId] ?? 'idle';
            // Een reeks (mail, facturen, offertes, herinneringen) beslis je hier net
            // zoals in de wachtrij: per regel, met een vinkje.
            const batch = asBatchProposal(proposal);
            return (
              <div key={auditId} className="cc-approve">
                <div className="cc-approve-t">{info.title}</div>
                {info.sub && <div className="cc-approve-s">{info.sub}</div>}
                {st === 'error' && pmsg[auditId] && <div className="cc-approve-err">{pmsg[auditId]}</div>}
                {st === 'done' ? <div className="cc-lane-ok"><Check size={13} /> Uitgevoerd</div>
                  : st === 'rejected' ? <div className="cc-lane-cancel">Afgewezen.</div>
                  : batch ? (
                    <AgentBatchBoard
                      proposal={batch}
                      canWrite={canWrite}
                      handlers={handlers}
                      onResolved={({ sent, skipped }) => {
                        void confirmGerrieAction(organizationId, auditId, sent > 0 ? 'executed' : 'failed', `${sent} verstuurd, ${skipped} overgeslagen.`);
                        setPstate((s) => ({ ...s, [auditId]: sent > 0 ? 'done' : 'rejected' }));
                        onApprovalsChanged?.();
                      }}
                    />
                  ) : (
                    <div className="cc-approve-actions">
                      <button className="cc-btn tiny ghost" disabled={st === 'busy'} onClick={() => reject(auditId)}>Afwijzen</button>
                      {info.openable && canWrite && (
                        <button className="cc-btn tiny ghost" disabled={st === 'busy'} onClick={() => openProposal(proposal, handlers)}>Openen</button>
                      )}
                      <button className="cc-btn tiny primary" disabled={st === 'busy' || (info.write && !canWrite)} onClick={() => void approve(auditId, proposal)}>
                        {st === 'busy' ? <><Spin size={13} /> Bezig…</> : 'Goedkeuren'}
                      </button>
                    </div>
                  )}
              </div>
            );
          })}

          {/* Wat er met eerdere voorstellen van deze run is gebeurd. Dit is de
              verantwoording: goedgekeurd, afgewezen of mislukt — met de reden. */}
          {settled.length > 0 && (
            <ul className="cc-decisions">
              {settled.map((d) => (
                <li key={d.auditId} className={`cc-decision is-${d.status}`}>
                  <span className="cc-decision-mark" aria-hidden="true">
                    {d.status === 'executed' || d.status === 'auto_executed' ? <Check size={12} /> : <X size={12} />}
                  </span>
                  <span className="cc-decision-what">{decisionLabel(d)}</span>
                  {d.detail && <span className="cc-decision-detail">{d.detail}</span>}
                  <span className="cc-decision-when">{fmtWhen(d.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="cc-reply">
            <input
              className="cc-text" value={reply} disabled={replying}
              placeholder="Antwoord de agent… (bv. “ja, verstuur maar”)"
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(); } }}
            />
            <button className="cc-btn tiny primary" disabled={!reply.trim() || replying} onClick={() => void sendReply()}>
              {replying ? <Spin size={13} /> : <CornerDownLeft size={13} />} Stuur
            </button>
          </div>
          {err && <div className="cc-approve-err">{err}</div>}

          {/* Het logboek: elke stap die de agent zette, in volgorde. Dicht by
              default — je wilt eerst het resultaat, en pas daarna het bewijs. */}
          {events.length > 0 && (
            <div className="cc-log">
              <button type="button" className="cc-log-head" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>
                {showLog ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <ScrollText size={13} />
                Logboek — {events.length} stap{events.length === 1 ? '' : 'pen'}
              </button>
              {showLog && (
                <ol className="cc-log-list">
                  {events.map((ev) => (
                    <li key={ev.id} className={`cc-log-row is-${ev.kind}`}>
                      <span className="cc-log-time">{fmtTime(ev.created_at)}</span>
                      <span className="cc-log-label">{ev.label}</span>
                      {logDetail(ev) && <span className="cc-log-detail">{logDetail(ev)}</span>}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
