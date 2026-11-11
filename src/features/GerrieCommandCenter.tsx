import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Sparkles, Send, Check, X, AlertTriangle, Play, Pause, Archive, ArchiveRestore, Loader2, ChevronDown, ChevronRight, CornerDownLeft, ClipboardCheck, Eye, Mailbox, Users2, Gauge, BookOpen, ScrollText, Copy, Share2, UserRound, BarChart3,
  ArrowLeft, ArrowUp, BotMessageSquare, CalendarClock, CheckCheck, Ellipsis, History, MessagesSquare, Power, Radar, ScanSearch, ShieldCheck, SlidersHorizontal, WandSparkles, Zap } from 'lucide-react';
import {
  streamGerrieReply, loadGerrieBudget, confirmGerrieAction, runGerrieDecision, rejectGerrieAction, claimingHandlers, batchDecision,
  listRoutines, listRoutineRuns, saveRoutine, setRoutineStatus, archiveRoutine, restoreRoutine, runRoutineNow, listRunProposals,
  loadRunTranscript, listRunEvents, listRunDecisions, replyToRun, listPendingAgentApprovals, listRoutineToolsSafe, routineToolLabel, routineToolIsRead,
  cloneRoutine, shareRoutine, loadAgentMonth, previewRoutine,
  type GerrieActionHandlers, type GerrieProposal,
  type GerrieRoutine, type GerrieRoutineRun, type GerrieRoutineInput, type GerrieRunMessage, type GerrieAgentProposal,
  type GerrieRunEvent, type GerrieRunDecision, type RoutineTool, type RoutineCatalog, type RoutineSaveResult, type RoutinePreview,
  type RoutineMode, type RoutineScheduleKind, type RoutineStatus, type RoutineRunStatus, type AgentEmailMode, type AgentVisibility,
} from '../lib/gerrie-api';
import {
  DOW_NAMES, agentOwner, agentPowers, approvalScope, clock, hourlyEnd, monthStatsLine, scheduleLabel, shortSchedule, sortAgents,
  startOfMonthIso, summarizeAgentMonth, type AgentMonthStats, type AgentPowers,
  AGENT_EVENT_LABELS,
} from '../lib/agents';
import { memberShortName } from '../lib/members';
import { STANDARD_MERGE_TOKENS } from '../lib/mergeTokens';
import { executeProposal, openProposal, proposalLabel } from '../lib/gerrie-proposals';
import { AgentApprovals } from '../components/AgentApprovals';
import { AgentBuilder } from '../components/AgentBuilder';
import { AgentBatchBoard, asBatchProposal } from '../components/AgentBatchBoard';
import { DecisionFeed } from '../components/DecisionFeed';
import { SignalSettingsPanel } from '../components/SignalSettingsPanel';
import { countDueDecisions, type DecisionTarget } from '../lib/decisions-api';
import { AGENT_ICONS, AgentGlyph, agentIconKey, type AgentIconKey } from '../components/AgentGlyph';
import { AgentLiveLine, AgentWorkbench, useAgentActivity, useRunEvents } from '../components/AgentWork';
import { isLiveRun, runOutcome, whenShort, type LiveRun } from '../lib/agentWork';
import type { OrganizationMember, UUID } from '../types';

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

export function GerrieCommandCenter({ organizationId, canWrite, openAgentId = null, onOpenAgentConsumed, isAdmin = false, onOpenDecisionTarget, currentUserId = null, teamMembers = [], ...handlers }: {
  organizationId: UUID;
  /** Gerrie op "volledig" met een schrijvende rol: mag voorstellen uitvoeren, en zijn agents mogen iets klaarzetten. */
  canWrite: boolean;
  /** Net vanuit de chat aangemaakte agent (of uit een pushmelding); die klapt hier meteen open. */
  openAgentId?: string | null;
  onOpenAgentConsumed?: () => void;
  /** Owner of admin: mag de beslislijst instellen en houdt toezicht op de agents van het team. */
  isAdmin?: boolean;
  /** "Openen" op een kaart van de beslislijst. */
  onOpenDecisionTarget?: (target: DecisionTarget) => void;
  /** De ingelogde gebruiker: zijn agents zijn "je agents", die van collega's staan apart. */
  currentUserId?: string | null;
  /** Voor de naam bij een agent of voorstel van een collega. */
  teamMembers?: OrganizationMember[];
} & GerrieActionHandlers) {
  // Agents is de voordeur: daar zit het werk. "Nu uitvoeren" is voor het losse geval.
  const [tab, setTab] = useState<'agents' | 'run' | 'queue' | 'decisions'>('agents');
  const [draft, setDraft] = useState('');
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [budget, setBudget] = useState<number | null>(null);
  const controllers = useRef<Map<string, AbortController>>(new Map());

  // Wat dit teamlid met agents mag. De server zegt het (zelfde regel als de runner);
  // tot dat antwoord er is, volgen we de rechten die de app al kent.
  const [catalog, setCatalog] = useState<RoutineCatalog | null>(null);
  const canPropose = catalog?.capabilities?.canPropose ?? canWrite;
  const canOversee = catalog?.capabilities?.canOversee ?? isAdmin;

  // Openstaande voorstellen van geplande agents: voedt de badge op het tabblad én
  // het belletje op elke agent-tegel. Los van de wachtrij-component zelf, want die
  // is alleen gemount als je op dat tabblad staat. De badge telt wat op JOU wacht;
  // het belletje op de tegel van een collega-agent telt wat op die collega wacht.
  const [pendingByAgent, setPendingByAgent] = useState<Record<string, number>>({});
  const [pendingTotal, setPendingTotal] = useState(0);
  const [decisionTotal, setDecisionTotal] = useState(0);
  const reloadPending = useCallback(() => {
    listPendingAgentApprovals(organizationId)
      .then((rows) => {
        const map: Record<string, number> = {};
        let mine = 0;
        for (const r of rows) {
          const scope = approvalScope(r, currentUserId, canOversee);
          if (scope === 'hidden') continue;
          if (r.agentId) map[r.agentId] = (map[r.agentId] ?? 0) + 1;
          if (scope === 'mine') mine += 1;
        }
        setPendingByAgent(map);
        setPendingTotal(mine);
      })
      // Geen wachtrij te lezen (module dicht, sessie verlopen): dan gewoon geen badge.
      .catch(() => { setPendingByAgent({}); setPendingTotal(0); });
  }, [organizationId, currentUserId, canOversee]);

  useEffect(() => {
    let cancelled = false;
    loadGerrieBudget(organizationId).then((f) => { if (!cancelled && f !== null) setBudget(f); });
    // De capability-catalogus alvast ophalen: de agentkaarten tonen per agent wat
    // hij mag (zonder catalogus kennen ze alleen de rauwe namen), de editor en de
    // startpunten volgen er jouw rechten mee.
    listRoutineToolsSafe(organizationId).then((c) => { if (!cancelled) setCatalog(c); });
    countDueDecisions(organizationId).then((n) => { if (!cancelled) setDecisionTotal(n); }).catch(() => { /* dan geen badge */ });
    return () => { cancelled = true; };
  }, [organizationId]);

  useEffect(() => { reloadPending(); }, [reloadPending]);

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
    const proposal = run.proposal;
    if (!proposal) return;
    patchRun(run.id, { resolution: 'executing' });
    try {
      // Vastzetten, uitvoeren, uitkomst melden (zie runGerrieDecision).
      await runGerrieDecision(organizationId, run.auditId, () => executeProposal(proposal, handlers));
      patchRun(run.id, { resolution: 'executed' });
    } catch (e) {
      patchRun(run.id, { resolution: 'error', error: e instanceof Error ? e.message : 'Uitvoeren mislukt.' });
    }
  }
  async function reject(run: RunResult) {
    try {
      if (run.auditId) await rejectGerrieAction(organizationId, run.auditId);
      patchRun(run.id, { resolution: 'rejected' });
    } catch (e) {
      patchRun(run.id, { resolution: 'error', error: e instanceof Error ? e.message : 'Afwijzen mislukt.' });
    }
  }

  const activeCount = runs.filter((r) => r.status === 'running').length;

  return (
    <div className="cc-root">
      <header className="cc-top">
        <div className="cc-brand"><span className="cc-spark" aria-hidden="true"><Sparkles size={18} /></span><b>Gerrie</b><span className="cc-sub">Commandocentrum</span></div>
        <nav className="cc-tabs" aria-label="Gerrie-weergave">
          <button className={`cc-tab${tab === 'agents' ? ' on' : ''}`} onClick={() => setTab('agents')}><BotMessageSquare size={15} /> Agents</button>
          <button className={`cc-tab${tab === 'run' ? ' on' : ''}`} onClick={() => setTab('run')}><Zap size={15} /> Nu uitvoeren</button>
          <button className={`cc-tab${tab === 'queue' ? ' on' : ''}`} onClick={() => { setTab('queue'); reloadPending(); }}>
            <CheckCheck size={15} /> Jouw akkoord
            {pendingTotal > 0 && <span className="cc-tab-badge">{pendingTotal}</span>}
          </button>
          <button className={`cc-tab${tab === 'decisions' ? ' on' : ''}`} onClick={() => setTab('decisions')}>
            <Radar size={15} /> Beslissingen
            {decisionTotal > 0 && <span className="cc-tab-badge">{decisionTotal}</span>}
          </button>
        </nav>
        <div className="cc-top-spacer" />
        {activeCount > 0 && <span className="cc-live" role="status"><span className="cc-live-dot" />bezig</span>}
        {budget !== null && (
          <div className="cc-budget" title="Resterend AI-tegoed deze maand">
            <span className="cc-budget-label">AI-tegoed</span>
            <span className="cc-budget-track"><span className="cc-budget-fill" data-low={budget <= 0.2 ? 'true' : 'false'} style={{ '--fill': budget } as CSSProperties} /></span>
            <span className="cc-budget-pct">{Math.round(budget * 100)}%</span>
          </div>
        )}
      </header>

      {tab === 'agents' ? (
        <RoutinesPanel organizationId={organizationId} canWrite={canWrite} handlers={handlers}
          pendingByAgent={pendingByAgent} onApprovalsChanged={reloadPending} budget={budget}
          openAgentId={openAgentId} onOpenAgentConsumed={onOpenAgentConsumed}
          currentUserId={currentUserId} teamMembers={teamMembers} catalog={catalog}
          canPropose={canPropose} canOversee={canOversee}
          pendingTotal={pendingTotal} onOpenQueue={() => { setTab('queue'); reloadPending(); }} />
      ) : tab === 'decisions' ? (
        <div className="ag-page">
          <DecisionFeed organizationId={organizationId} canWrite={() => canWrite} handlers={handlers}
            variant="page" onOpenTarget={onOpenDecisionTarget} onCountChange={setDecisionTotal} />
          <SignalSettingsPanel organizationId={organizationId} canManage={isAdmin} />
        </div>
      ) : tab === 'queue' ? (
        <div className="ag-page">
          <AgentApprovals organizationId={organizationId} canWrite={canWrite} handlers={handlers}
            variant="page" onChanged={reloadPending} onCountChange={setPendingTotal}
            currentUserId={currentUserId} canOversee={canOversee} teamMembers={teamMembers} />
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
                  onReject={() => void reject(run)}
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
            handlers={run.auditId ? claimingHandlers(organizationId, run.auditId, handlers) : handlers}
            onResolved={(result) => {
              const decision = batchDecision(result);
              if (run.auditId) void confirmGerrieAction(organizationId, run.auditId, decision.outcome, decision.detail);
              onResolved();
            }}
          />
        ) : (
          <div className="cc-approve">
            <div className="cc-approve-t">{info.title}</div>
            {info.sub && <div className="cc-approve-s">{info.sub}</div>}
            {info.detail && <div className="cc-approve-detail">{info.detail}</div>}
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

interface RoutineTemplate {
  name: string; blurb: string; instruction: string; mode: RoutineMode;
  schedule_kind: RoutineScheduleKind; hour: number; minute?: number; end_hour?: number;
  day_of_week?: number; day_of_month?: number; tools: string[];
  icon: AgentIconKey; hue: number;
  /** Standaard grondig; een agent die elk uur draait, mag kort nadenken. */
  model?: 'cheap' | 'strong';
  /** Pushmelding bij nieuws, en stil als er niets is. */
  push?: boolean; quiet?: boolean;
  /** Bij schedule_kind 'event': waarop hij start. */
  events?: string[];
}
const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  { name: 'Ochtendbriefing', blurb: 'Elke werkdag: je agenda, taken die vandaag moeten en tickets die wachten.', instruction: 'Geef me een korte ochtendbriefing: wat staat er vandaag in mijn agenda, welke taken moeten vandaag af of zijn te laat, en welke tickets wachten op een antwoord? Belangrijkste eerst, hoogstens acht regels.', mode: 'report', schedule_kind: 'weekdays', hour: 8, minute: 0, tools: ['list_calendar_events', 'list_tasks', 'list_tickets'], icon: 'calendar', hue: 32, push: true },
  { name: 'Ticketwacht', blurb: 'Kijkt elk werkuur naar nieuwe tickets en meldt zich alleen als er iets is.', instruction: 'Welke tickets zijn het afgelopen uur binnengekomen of hebben een nieuwe reactie van de klant die nog niet beantwoord is? Noem per ticket de klant, het onderwerp en hoe lang het al wacht.', mode: 'report', schedule_kind: 'hourly', hour: 9, minute: 5, end_hour: 17, tools: ['list_tickets', 'search_clients'], icon: 'lifebuoy', hue: 200, model: 'cheap', push: true, quiet: true },
  { name: 'Wekelijks factuuroverzicht', blurb: 'Leest je facturen en meldt wat te lang openstaat.', instruction: 'Geef een overzicht van alle openstaande facturen ouder dan 30 dagen: klantnaam, bedrag en aantal dagen te laat. Sluit af met het totaalbedrag.', mode: 'report', schedule_kind: 'weekly', day_of_week: 1, hour: 8, tools: ['list_invoices', 'list_due_reminders'], icon: 'receipt', hue: 208 },
  { name: 'Wekelijkse betalingsherinneringen', blurb: 'Zet herinneringen klaar; jij drukt op versturen.', instruction: 'Bekijk welke betalingsherinneringen vandaag aan de beurt zijn en zet ze klaar om te versturen. Groepeer per niveau (1e/2e/3e).', mode: 'propose', schedule_kind: 'weekly', day_of_week: 1, hour: 9, tools: ['list_due_reminders', 'propose_send_reminders'], icon: 'bell', hue: 20 },
  { name: 'Urencheck op vrijdag', blurb: 'Laat zien hoeveel je deze week schreef, en waar het ontbreekt.', instruction: 'Hoeveel uur heb ik deze week geschreven, per project? Noem dagen zonder uren, en projecten met openstaande taken waar deze week niets op geboekt is.', mode: 'report', schedule_kind: 'weekly', day_of_week: 5, hour: 15, minute: 30, tools: ['list_time_entries', 'list_projects', 'list_tasks'], icon: 'clock', hue: 260, push: true },
  { name: 'Maandelijkse omzetsamenvatting', blurb: 'Vat je maand samen: omzet, klanten, openstaand.', instruction: 'Vat de omzet van de afgelopen maand samen: totaalomzet, grootste klanten en het totaal openstaande bedrag.', mode: 'report', schedule_kind: 'monthly', day_of_month: 1, hour: 8, tools: ['get_financial_summary', 'list_invoices'], icon: 'trending', hue: 140 },
  { name: 'Offertes die stilliggen', blurb: 'Signaleert verstuurde offertes zonder antwoord.', instruction: 'Welke offertes staan al langer dan twee weken op "verstuurd" zonder reactie? Noem klant, bedrag en hoe lang het stil is, met de oudste bovenaan.', mode: 'report', schedule_kind: 'weekly', day_of_week: 4, hour: 8, tools: ['list_quotes', 'search_clients'], icon: 'rocket', hue: 284 },
  { name: 'Maandagoverzicht van je week', blurb: 'Start je week met projecten, taken en tickets.', instruction: 'Geef een kort weekoverzicht: welke taken staan deze week gepland, welke projecten lopen en welke tickets zijn nog onbehandeld. Maximaal tien regels.', mode: 'report', schedule_kind: 'weekly', day_of_week: 1, hour: 7, tools: ['list_tasks', 'list_projects', 'list_tickets'], icon: 'checks', hue: 190 },
  // Op een gebeurtenis: de agent begint zodra het gebeurt, met precies dat ding in handen.
  { name: 'Klantmail beantwoorden', blurb: 'Zodra een klant mailt: een antwoord klaarzetten dat jij nakijkt.', instruction: 'Er is een mail van een klant binnengekomen. Lees de mail en wat er recent met deze klant speelde (offertes, facturen, tickets). Zet een kort, vriendelijk antwoord klaar dat op de vraag ingaat. Is het een vraag die je niet uit de administratie kunt beantwoorden, zet dan een taak klaar om het uit te zoeken in plaats van een antwoord.', mode: 'propose', schedule_kind: 'event', hour: 8, events: ['client_email.received'], tools: ['search_clients', 'list_invoices', 'list_quotes', 'list_tickets', 'action:client_email.list', 'propose_send_client_email', 'propose_task'], icon: 'mail', hue: 205, push: true, quiet: true },
  { name: 'Eerste reactie op tickets', blurb: 'Zodra er een ticket binnenkomt: een eerste reactie en de prioriteit klaarzetten.', instruction: 'Er is een nieuw ticket binnengekomen. Bekijk het ticket en de klant. Zet een korte eerste reactie klaar voor de klant (zichtbaar in het portaal) waarin je bevestigt dat we ernaar kijken, en zet de prioriteit op hoog als het om een storing of iets dringends gaat.', mode: 'propose', schedule_kind: 'event', hour: 8, events: ['ticket.created'], tools: ['list_tickets', 'search_clients', 'propose_ticket_note', 'propose_edit_ticket'], icon: 'lifebuoy', hue: 200, model: 'cheap', push: true, quiet: true },
  { name: 'Offerte geaccepteerd', blurb: 'Zodra een klant akkoord geeft: project en factuur klaarzetten.', instruction: 'Een klant heeft een offerte geaccepteerd. Zet een project klaar voor deze klant met de naam van de offerte, en zet de omzetting van de offerte naar een factuur klaar. Noem in je samenvatting de klant, het offertenummer en het bedrag.', mode: 'propose', schedule_kind: 'event', hour: 8, events: ['quote.accepted'], tools: ['list_quotes', 'search_clients', 'propose_project', 'propose_convert_quote'], icon: 'rocket', hue: 140, push: true },
];

/**
 * De startpunten die bij JOU passen: alleen met gegevens waar je zelf bij kunt, en
 * iets laten klaarzetten alleen als je dat zelf mag. Een sjabloon dat bij het
 * opslaan half wordt weggesnoeid, is geen goed begin.
 */
function startersFor(catalog: RoutineCatalog | null, canPropose: boolean): RoutineTemplate[] {
  const known = catalog && !catalog.fallback ? new Set(catalog.tools.map((t) => t.name)) : null;
  // Een startpunt op een gebeurtenis alleen als je die gebeurtenis ook mag zien.
  const events = catalog && !catalog.fallback ? new Set(catalog.events.map((e) => e.key)) : null;
  return ROUTINE_TEMPLATES.filter((t) => (t.mode === 'report' || canPropose)
    && (!known || t.tools.every((name) => known.has(name)))
    && (!t.events || !events || t.events.every((key) => events.has(key))));
}

/**
 * Hoe lang de agent nadenkt, in gewone taal. Hier stond eerst de naam van het
 * model erbij; welk model er achter Gerrie zit, laat de app bewust nergens
 * zien (modelnaam.test.ts).
 */
function thinkingLabel(kind: 'cheap' | 'strong'): string {
  return kind === 'strong' ? 'Grondig — denkt langer na' : 'Snel — korter nadenken, zuiniger';
}

/** Waar het resultaat heen gaat, in gewone taal. */
function deliveryLabel(delivery: GerrieRoutine['delivery'] | null | undefined): string {
  const channels = Array.isArray(delivery?.channels) ? delivery.channels : [];
  const ways = ['in de app', channels.includes('email') ? 'per e-mail' : null, channels.includes('push') ? 'met een pushmelding' : null]
    .filter((w): w is string => Boolean(w));
  const text = ways.length > 1 ? `${ways.slice(0, -1).join(', ')} en ${ways[ways.length - 1]}` : ways[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Wat er van een opgeslagen agent terechtkwam, als één zin. Een agent kan nooit
 * meer dan zijn eigenaar: wat de server eraf haalde, zeggen we hier hardop in
 * plaats van het stil weg te laten.
 */
function saveMessage(result: RoutineSaveResult, done: string): { text: string; kind: 'success' | 'info' } {
  const notes: string[] = [];
  if (result.downgraded) notes.push('Hij kijkt alleen mee: jij mag in Gerrie zelf niets klaarzetten, dus je agent ook niet.');
  if (result.dropped.length > 0) notes.push(`Niet meegenomen, want daar heb jij geen rechten op: ${result.dropped.map(routineToolLabel).join(', ')}.`);
  return { text: [done, ...notes].join(' '), kind: notes.length ? 'info' : 'success' };
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
/** Een nieuw, nog niet opgeslagen concept: de velden die de editor nodig heeft. */
function blankRoutine(fields: Partial<GerrieRoutine> & Pick<GerrieRoutine, 'name' | 'instruction' | 'mode' | 'enabled_tools' | 'schedule_kind' | 'hour'>): GerrieRoutine {
  return {
    id: '' as UUID, run_as_user_id: null, created_by: null, visibility: 'private', copied_from: null,
    description: null, icon: null, hue: null,
    email_mode: 'compose', email_subject: null, email_body: null, max_emails_per_run: 5,
    model_kind: 'strong', minute: 0, end_hour: null, day_of_week: null, day_of_month: null,
    max_proposals_per_run: 3, timezone: 'Europe/Amsterdam', status: 'draft', archived_at: null,
    next_run_at: null, last_run_at: null, consecutive_failures: 0,
    delivery: { channels: ['inapp'], recipient_user_ids: [] }, created_at: '', updated_at: '',
    ...fields,
  };
}

/**
 * Waar een door Gerrie gebouwde agent zijn resultaat laat: in de app en met een
 * pushmelding. Een agent die elk uur draait, meldt zich alleen als hij iets vond —
 * anders wordt hij ruis.
 */
function builderDelivery(p: GerrieAgentProposal): GerrieRoutine['delivery'] {
  return { channels: ['inapp', 'push'], recipient_user_ids: [], quiet: p.schedule_kind === 'hourly' || p.schedule_kind === 'event' };
}

/** Zet een door Gerrie voorgestelde agent om in een concept voor de editor. */
function proposalToRoutine(p: GerrieAgentProposal): GerrieRoutine {
  return blankRoutine({
    name: p.name, instruction: p.instruction,
    email_mode: p.email_mode, email_subject: p.email_subject, email_body: p.email_body,
    max_emails_per_run: p.max_emails_per_run ?? 5,
    mode: p.mode, enabled_tools: p.enabled_tools,
    schedule_kind: p.schedule_kind, hour: p.hour, minute: p.minute ?? 0, end_hour: p.end_hour ?? null,
    day_of_week: p.day_of_week, day_of_month: p.day_of_month,
    max_proposals_per_run: p.max_proposals_per_run ?? 3,
    trigger_events: p.trigger_events ?? [], max_event_runs_per_day: p.max_event_runs_per_day ?? 24,
    delivery: builderDelivery(p),
  });
}

/**
 * Wat er van een door Gerrie gebouwd voorstel wordt opgeslagen. Bij aanpassen via
 * de chat blijft van de bestaande agent staan wat het gesprek niet raakt: hoe hij
 * bezorgt, met wie hij gedeeld is, hoe grondig hij nadenkt.
 *
 * `trigger_events` ging tot 2026-11-11 niet mee: een agent die Gerrie bouwde voor
 * "zodra er een klantmail binnenkomt", werd zonder gebeurtenis opgeslagen en
 * startte dus nooit.
 */
function inputFromProposal(p: GerrieAgentProposal, base?: GerrieRoutine): GerrieRoutineInput {
  const routine = proposalToRoutine(p);
  return {
    name: routine.name, instruction: routine.instruction,
    icon: p.icon ?? base?.icon ?? null, hue: base?.hue ?? null,
    email_mode: routine.email_mode, email_subject: routine.email_subject, email_body: routine.email_body,
    max_emails_per_run: routine.max_emails_per_run,
    model_kind: base?.model_kind ?? routine.model_kind, mode: routine.mode, enabled_tools: routine.enabled_tools,
    schedule_kind: routine.schedule_kind, hour: routine.hour, minute: routine.minute,
    end_hour: routine.schedule_kind === 'hourly' ? routine.end_hour : null,
    day_of_week: routine.schedule_kind === 'weekly' ? routine.day_of_week : null,
    day_of_month: routine.schedule_kind === 'monthly' ? routine.day_of_month : null,
    max_proposals_per_run: routine.max_proposals_per_run,
    trigger_events: routine.schedule_kind === 'event' ? routine.trigger_events ?? [] : [],
    max_event_runs_per_day: routine.max_event_runs_per_day ?? 24,
    timezone: base?.timezone || 'Europe/Amsterdam',
    ...(base ? { visibility: base.visibility } : {}),
    delivery: base?.delivery ?? routine.delivery,
  };
}

/** Een startpunt als voorstel: dan opent het in het gesprek, meteen klaar om aan te maken. */
function templateToProposal(t: RoutineTemplate): GerrieAgentProposal {
  return {
    type: 'agent', name: t.name, icon: t.icon, instruction: t.instruction, mode: t.mode, enabled_tools: t.tools,
    schedule_kind: t.schedule_kind, hour: t.hour, minute: t.minute ?? 0, end_hour: t.end_hour ?? null,
    day_of_week: t.day_of_week ?? null, day_of_month: t.day_of_month ?? null, max_proposals_per_run: 3,
    email_mode: 'compose', email_subject: null, email_body: null, max_emails_per_run: 5,
    trigger_events: t.events ?? [], max_event_runs_per_day: 24,
  };
}

function RoutinesPanel({ organizationId, canWrite, handlers, pendingByAgent, onApprovalsChanged, budget, openAgentId, onOpenAgentConsumed, currentUserId, teamMembers, catalog, canPropose, canOversee, pendingTotal, onOpenQueue }: {
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
  currentUserId: string | null;
  teamMembers: OrganizationMember[];
  /** De toolcatalogus van dit teamlid (null = nog aan het laden). */
  catalog: RoutineCatalog | null;
  /** Mogen zijn agents iets klaarzetten? Zo nee: ze kijken alleen mee. */
  canPropose: boolean;
  /** Owner/admin: ziet ook de agents van collega's (pauzeren, archiveren). */
  canOversee: boolean;
  /** Wat er in totaal op jouw akkoord wacht, en de weg erheen. */
  pendingTotal: number;
  onOpenQueue: () => void;
}) {
  const [routines, setRoutines] = useState<GerrieRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Het formulier, voor wie het liever zelf invult: een agent, of 'new' voor een lege.
  const [editing, setEditing] = useState<GerrieRoutine | 'new' | null>(null);
  // Het gesprek waarin Gerrie de agent bouwt of aanpast: de voordeur.
  const [builder, setBuilder] = useState<{ editing: GerrieRoutine | null; message: string | null; initial: { agent: GerrieAgentProposal; summary: string } | null } | null>(null);
  // De vraag bovenaan de pagina; versturen opent het gesprek met die vraag erin.
  const [ask, setAsk] = useState('');
  // Hoeveel runs we zelf net gestart hebben: dan kijken we vlot mee tot ze lopen.
  const [starting, setStarting] = useState(0);
  const anchor = useRef<HTMLDivElement | null>(null);
  const activity = useAgentActivity(organizationId, anchor, starting > 0);
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
    const owner = agentOwner(r);
    const gallery = owner && owner !== currentUserId ? `de galerij van ${memberShortName(owner, teamMembers, currentUserId)}` : 'je galerij';
    if (!confirm(`Agent "${r.name || 'naamloos'}" archiveren?\n\nHij stopt met draaien en verdwijnt uit ${gallery}. Alles wat hij heeft gedaan blijft bewaard onder "Archief".`)) return;
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
  // De run zelf zie je op de werkbank in het paneel (live, uit het logboek); de
  // melding hier zegt alleen hoe hij afliep.
  async function doRunNow(r: GerrieRoutine) {
    setBusyId(r.id); setOpenId(r.id); setStarting((n) => n + 1);
    activity.refresh();
    try {
      const res = await runRoutineNow(organizationId, r.id);
      notify(res.proposalsCreated ? `Klaar: ${res.proposalsCreated} voorstel${res.proposalsCreated === 1 ? '' : 'len'} klaargezet om goed te keuren.` : 'Klaar. De uitkomst staat hieronder.', 'success');
      setRunsKey((k) => k + 1); reload(); onApprovalsChanged();
    } catch (e) { notify(e instanceof Error ? e.message : 'Draaien mislukt.', 'error'); }
    finally { setBusyId(null); setStarting((n) => Math.max(0, n - 1)); activity.refresh(); }
  }
  // Delen = je collega's zien zijn instellingen en kunnen er een eigen kopie van
  // maken. Zijn runs, logboek en voorstellen blijven van jou.
  async function doShare(r: GerrieRoutine, visibility: AgentVisibility) {
    setBusyId(r.id);
    try {
      await shareRoutine(organizationId, r.id, visibility);
      reload();
      notify(visibility === 'team'
        ? 'Gedeeld — je collega’s zien hem nu als startpunt voor een eigen agent. Zijn runs en voorstellen blijven van jou.'
        : 'Niet meer gedeeld.', 'success');
    } catch (e) { notify(e instanceof Error ? e.message : 'Delen mislukt.', 'error'); }
    finally { setBusyId(null); }
  }
  // Een kopie is altijd van wie hem maakt, en draait met diens rechten. Hij komt
  // als concept binnen: eerst kijken of hij past, dan pas aanzetten.
  async function doCopy(r: GerrieRoutine) {
    setBusyId(r.id);
    try {
      const saved = await cloneRoutine(organizationId, r.id, false);
      reload();
      if (saved.id) setOpenId(saved.id);
      const message = saveMessage(saved, 'Je eigen kopie staat klaar als concept — pas hem aan of zet hem aan.');
      notify(message.text, message.kind);
    } catch (e) { notify(e instanceof Error ? e.message : 'Kopiëren mislukt.', 'error'); }
    finally { setBusyId(null); }
  }
  /** Na opslaan in de editor: terug naar de galerij, met de agent open en eerlijk wat er van werd. */
  function afterSave(result: RoutineSaveResult, activated: boolean) {
    setEditing(null);
    reload();
    if (result.id) setOpenId(result.id);
    const message = saveMessage(result, activated ? 'Opgeslagen — de agent staat aan.' : 'Opgeslagen.');
    notify(message.text, message.kind);
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
    const saved = await saveRoutine(organizationId, inputFromProposal(p), undefined, startNow);
    setBuilder(null);
    setOpenId(saved.id ?? null);
    // Wat er van zijn rechten afviel, hoort de maker meteen te horen — ook als
    // hij daarna gewoon gaat draaien.
    const trimmed = saved.downgraded || saved.dropped.length > 0 ? saveMessage(saved, '').text.trim() : '';
    if (startNow && saved.id) {
      // Activeren zat al in het aanmaken; is dat toch niet gelukt, dan zeggen we dat
      // eerlijk in plaats van te doen alsof hij draait.
      if (saved.status !== 'active') {
        try { await setRoutineStatus(organizationId, saved.id as UUID, 'active'); }
        catch { notify('Agent aangemaakt, maar aanzetten lukte niet. Zet hem zelf aan.', 'error'); reload(); return; }
      }
      notify(`Je agent staat aan en doet zijn eerste ronde.${trimmed ? ` ${trimmed}` : ''}`, 'success');
      setStarting((n) => n + 1);
      runRoutineNow(organizationId, saved.id as UUID)
        .then((res) => {
          notify(res.proposalsCreated
            ? `Eerste ronde klaar: ${res.proposalsCreated} voorstel${res.proposalsCreated === 1 ? '' : 'len'} om af te vinken.`
            : 'Eerste ronde klaar. De uitkomst staat hieronder.', 'success');
          setRunsKey((k) => k + 1); onApprovalsChanged();
        })
        .catch((e) => notify(e instanceof Error ? e.message : 'De eerste ronde mislukte; kijk in de geschiedenis.', 'error'))
        .finally(() => { setStarting((n) => Math.max(0, n - 1)); activity.refresh(); reload(); });
    } else {
      const message = saveMessage(saved, 'Agent aangemaakt als concept.');
      notify(message.text, message.kind);
    }
    reload();
  }

  /** Een via de chat aangepaste agent opslaan over de bestaande heen. */
  async function saveFromBuilder(base: GerrieRoutine, p: GerrieAgentProposal) {
    const saved = await saveRoutine(organizationId, inputFromProposal(p, base), base.id);
    setBuilder(null);
    reload();
    setOpenId(base.id);
    const message = saveMessage(saved, 'Aangepast en opgeslagen.');
    notify(message.text, message.kind);
  }

  if (builder) {
    const base = builder.editing;
    return <AgentBuilder
      organizationId={organizationId}
      editing={base}
      initialMessage={builder.message}
      initial={builder.initial}
      onCreate={createFromBuilder}
      onSave={base ? (p) => saveFromBuilder(base, p) : undefined}
      onOpenForm={(p) => {
        setBuilder(null);
        // Naar het formulier met wat er in het gesprek ontstond; bij aanpassen over
        // de bestaande agent heen, zodat opslaan hem bijwerkt in plaats van te kopiëren.
        if (base) setEditing(p ? { ...base, ...proposalToRoutine(p), id: base.id, status: base.status, delivery: base.delivery, visibility: base.visibility } : base);
        else setEditing(p ? proposalToRoutine(p) : 'new');
      }}
      onCancel={() => { setBuilder(null); if (base) setOpenId(base.id); }}
    />;
  }
  if (editing) {
    return <RoutineEditor organizationId={organizationId} routine={editing === 'new' ? null : editing}
      catalog={catalog} canPropose={canPropose}
      onDone={afterSave} onCancel={() => setEditing(null)} />;
  }

  const open = routines.find((r) => r.id === openId) ?? null;
  // Wat je ziet bepaalt de database; waar het staat, bepaalt dit. Gearchiveerde
  // agents staan apart: ze werken niet meer, maar hun logboek blijft.
  const sections = sortAgents(routines, currentUserId, canOversee);
  const live = sections.mine;
  const archived = sections.archived;
  const starters = startersFor(catalog, canPropose);
  const atCap = catalog?.maxAgents != null && live.length >= catalog.maxAgents;
  const ownerName = (r: GerrieRoutine): string | null => {
    const owner = agentOwner(r);
    if (!owner) return FORMER_MEMBER;
    return owner === currentUserId ? null : memberShortName(owner, teamMembers, currentUserId);
  };
  const capMessage = () => notify(`Je hebt al ${catalog?.maxAgents} agents. Archiveer er eerst een die je niet meer gebruikt.`, 'error');
  const openBuilder = (message: string | null, initial: { agent: GerrieAgentProposal; summary: string } | null = null) => {
    if (atCap) { capMessage(); return; }
    setBuilder({ editing: null, message, initial });
    setAsk('');
  };
  const working = [...live, ...sections.team].filter((r) => activity.live[r.id]);
  const counts = {
    active: live.filter((r) => r.status === 'active').length,
    paused: live.filter((r) => r.status === 'paused').length,
    draft: live.filter((r) => r.status === 'draft').length,
  };
  const card = (r: GerrieRoutine, compact = false) => (
    <AgentCard key={r.id} routine={r} organizationId={organizationId} anchor={anchor} compact={compact}
      selected={openId === r.id} busy={busyId === r.id} waiting={pendingByAgent[r.id] ?? 0}
      owner={ownerName(r)} live={activity.live[r.id] ?? null} latest={activity.latest[r.id] ?? null}
      canRun={agentPowers(r, currentUserId, canOversee).manage && r.status !== 'archived'}
      onOpen={() => setOpenId(openId === r.id && !compact ? null : r.id)}
      onRunNow={() => void doRunNow(r)} />
  );

  const toastView = toast && (
    <div className={`cc-routines-toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
      {toast.kind === 'success' ? <Check size={15} /> : toast.kind === 'error' ? <AlertTriangle size={15} /> : <Loader2 size={15} className="cc-spin" />}
      <span>{toast.text}</span>
    </div>
  );

  // ── Eén agent open: links de lijst, rechts alles over deze agent. ──
  // Dit stond eerst als paneel ónder de hele galerij: met tien agents scrolde je
  // weg van wat je net aanklikte, en terug naar de lijst ging nergens heen.
  if (open) {
    return (
      <div className="ag-page agx-page is-detail" ref={anchor}>
        {toastView}
        <div className="agx-layout">
          <nav className="agx-rail" aria-label="Je agents">
            <button type="button" className="agx-back" onClick={() => setOpenId(null)}><ArrowLeft size={15} /> Alle agents</button>
            <div className="agx-rail-list">
              {live.map((r) => card(r, true))}
              {sections.team.length > 0 && <span className="agx-rail-head">Van je team</span>}
              {sections.team.map((r) => card(r, true))}
              {archived.some((r) => r.id === open.id) && <><span className="agx-rail-head">Archief</span>{card(open, true)}</>}
            </div>
          </nav>
          <div className="agx-detail-col" ref={sheetRef}>
            <AgentDetail
              routine={open}
              organizationId={organizationId}
              canWrite={canWrite}
              handlers={handlers}
              busy={busyId === open.id}
              runsKey={runsKey}
              budget={budget}
              waiting={pendingByAgent[open.id] ?? 0}
              powers={agentPowers(open, currentUserId, canOversee)}
              owner={ownerName(open)}
              live={activity.live[open.id] ?? null}
              latest={activity.latest[open.id] ?? null}
              anchor={anchor}
              onRunNow={() => void doRunNow(open)}
              onStatus={(st) => void doStatus(open, st)}
              onChat={() => setBuilder({ editing: open, message: null, initial: null })}
              onEdit={() => setEditing(open)}
              onArchive={() => void doArchive(open)}
              onRestore={() => void doRestore(open)}
              onShare={(v) => void doShare(open, v)}
              onCopy={() => void doCopy(open)}
              onClose={() => setOpenId(null)}
              onApprovalsChanged={onApprovalsChanged}
              onOpenQueue={onOpenQueue}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Het overzicht ──
  return (
    <div className="ag-page agx-page" ref={anchor}>
      {/* De voordeur is een vraag aan Gerrie, niet een formulier: je zegt wat er
          vanzelf moet gebeuren en hij bouwt de agent. Voorheen zat dat gesprek
          achter de knop "Nieuwe agent", en wist je niet dat het er was. */}
      <section className="agx-hero" aria-label="Een agent laten bouwen">
        <div className="agx-hero-text">
          <h2>Je agents</h2>
          <p>{canPropose
            ? <>Agents doen vanzelf werk voor je, met precies jouw rechten. Wat ze willen versturen of aanmaken, zetten ze klaar; <b>jij keurt het goed</b>.</>
            : <>Agents kijken vanzelf voor je mee en vatten samen, met precies jouw rechten. Laten klaarzetten kan met jouw rechten niet.</>}</p>
        </div>
        <form className={`agx-ask${atCap ? ' is-disabled' : ''}`} onSubmit={(e) => { e.preventDefault(); if (ask.trim()) openBuilder(ask.trim()); }}>
          <span className="agx-orb" aria-hidden="true" />
          <label htmlFor="agx-ask-input" className="agx-sr">Wat moet er vanzelf gebeuren?</label>
          <input
            id="agx-ask-input"
            value={ask}
            disabled={atCap}
            onChange={(e) => setAsk(e.target.value.slice(0, 4000))}
            placeholder={atCap ? `Je hebt het maximum van ${catalog?.maxAgents} agents bereikt` : 'Wat moet er vanzelf gebeuren? Bijv. elke maandag de te late facturen'}
          />
          <button type="submit" className="agx-send" disabled={!ask.trim() || atCap} aria-label="Laat Gerrie de agent bouwen"><ArrowUp size={17} /></button>
        </form>
        <div className="agx-hero-foot">
          <button type="button" className="agx-link" onClick={() => openBuilder(null)} disabled={atCap}><MessagesSquare size={14} /> Gesprek beginnen</button>
          <button type="button" className="agx-link" onClick={() => { if (atCap) capMessage(); else setEditing('new'); }}><SlidersHorizontal size={14} /> Zelf invullen</button>
        </div>
      </section>

      {toastView}
      {error && <div className="cc-plan-error">{error}</div>}

      {loading ? <p className="ag-loading"><Loader2 size={14} className="cc-spin" /> Agents laden…</p> : <>
        {live.length > 0 && (
          <div className="agx-summary" role="status">
            {working.length > 0 && <span className="agx-sum is-working"><span className="agx-sum-dot" />{working.length} aan het werk</span>}
            <span className="agx-sum"><span className="agx-sum-dot is-active" />{counts.active} actief</span>
            {counts.paused > 0 && <span className="agx-sum"><span className="agx-sum-dot is-paused" />{counts.paused} gepauzeerd</span>}
            {counts.draft > 0 && <span className="agx-sum"><span className="agx-sum-dot is-draft" />{counts.draft} concept{counts.draft === 1 ? '' : 'en'}</span>}
            {pendingTotal > 0 && (
              <button type="button" className="agx-sum is-waiting" onClick={onOpenQueue}>
                <ClipboardCheck size={13} /> {pendingTotal} wacht{pendingTotal === 1 ? '' : 'en'} op jouw akkoord <ChevronRight size={13} />
              </button>
            )}
          </div>
        )}

        {live.length > 0 && <div className="agx-cards">{live.map((r) => card(r))}</div>}
        {atCap && <p className="cc-note">Je hebt het maximum van {catalog?.maxAgents} agents bereikt. Archiveer er een die je niet meer gebruikt om ruimte te maken.</p>}

        {/* Startpunten: kant-en-klare agents. Een klik opent ze in het gesprek, al
            ingevuld; aanmaken kan meteen, bijsturen in gewone taal. */}
        {starters.length > 0 && !atCap && (
          <section className="agx-section" aria-label="Startpunten">
            <header className="agx-section-head">
              <strong>{live.length === 0 ? 'Begin met een voorbeeld' : 'Meer ideeën'}</strong>
              <span>Kant-en-klaar; je kunt alles nog aanpassen.</span>
            </header>
            <div className={`agx-starters${live.length > 0 ? ' is-compact' : ''}`}>
              {(live.length === 0 ? starters : starters.filter((t) => !live.some((r) => r.name === t.name)).slice(0, 4)).map((t) => (
                <button key={t.name} type="button" className="agx-starter" onClick={() => openBuilder(null, { agent: templateToProposal(t), summary: t.blurb })}>
                  <AgentGlyph agent={{ id: t.name, name: t.name, icon: t.icon }} size="md" />
                  <span><strong>{t.name}</strong><small>{t.blurb}</small></span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Gedeeld door je team: agents die een collega als startpunt aanbiedt.
            Je ziet zijn instellingen, niet zijn runs; "Gebruik deze" maakt er JOUW
            agent van, met jouw rechten. */}
        {sections.shared.length > 0 && (
          <section className="agx-section" aria-label="Gedeeld door je team">
            <header className="agx-section-head">
              <strong><Share2 size={14} aria-hidden="true" /> Gedeeld door je team</strong>
              <span>Maak er je eigen kopie van; hij draait dan met jóuw rechten.</span>
            </header>
            <div className="ag-shared-grid">
              {sections.shared.map((r) => (
                <article key={r.id} className="ag-shared">
                  <div className="ag-shared-top">
                    <AgentGlyph agent={r} size="md" state="draft" />
                    <div>
                      <strong>{r.name || 'Naamloze agent'}</strong>
                      <span className="ag-shared-meta"><UserRound size={11} aria-hidden="true" /> {ownerName(r)} · {shortSchedule(r)} · {r.mode === 'propose' ? 'zet klaar' : 'kijkt mee'}</span>
                    </div>
                  </div>
                  <p>{excerpt(r.instruction)}</p>
                  <button type="button" className="cc-btn tiny primary" disabled={busyId === r.id || atCap} onClick={() => void doCopy(r)}>
                    {busyId === r.id ? <><Loader2 size={13} className="cc-spin" /> Bezig…</> : <><Copy size={13} /> Gebruik deze</>}
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Toezicht: de agents van collega's. Ze draaien met HUN rechten en hun
            voorstellen wachten op hén; een owner/admin kan ze pauzeren of
            archiveren, maar niet aanzetten of aanpassen. */}
        {sections.team.length > 0 && (
          <section className="agx-section" aria-label="Agents van je team">
            <header className="agx-section-head">
              <strong><Users2 size={14} aria-hidden="true" /> Agents van je team</strong>
              <span>Ze draaien namens je collega’s, met hún rechten. Jij kunt ze pauzeren of archiveren.</span>
            </header>
            <div className="agx-cards">{sections.team.map((r) => card(r))}</div>
          </section>
        )}

        {/* Het archief: agents die niet meer draaien maar wél verantwoording dragen.
            Standaard dicht, want dit is naslag, geen dagelijks werk. */}
        {archived.length > 0 && (
          <section className="ag-archive">
            <button type="button" className="ag-archive-head" aria-expanded={showArchive} onClick={() => setShowArchive((v) => !v)}>
              {showArchive ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Archive size={14} />
              <strong>Archief</strong>
              <span>{archived.length} gearchiveerde agent{archived.length === 1 ? '' : 's'}; hun logboek blijft te lezen</span>
            </button>
            {showArchive && <div className="agx-cards">{archived.map((r) => card(r))}</div>}
          </section>
        )}
      </>}
    </div>
  );
}

/** Hoe een agent heet waarvan de eigenaar niet meer in de organisatie zit. */
const FORMER_MEMBER = 'een oud-teamlid';

/** De eerste zin of zo van een opdracht — genoeg om te zien wat een gedeelde agent doet. */
function excerpt(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * Eén agent in de lijst (2026-11-11; voorheen een tegel met alleen gezicht, naam,
 * ritme en "Wat kan hij?"). Nu staat erop wat je wilt weten zonder te klikken:
 * of hij aan staat, wanneer hij draait, wat hij de vorige keer vond, wat er op je
 * wacht, en als hij nu bezig is wat hij aan het doen is. Nu draaien kan vanaf de
 * kaart; de rest staat in het detail.
 */
function AgentCard({ routine: r, organizationId, anchor, compact, selected, busy, waiting, owner, live, latest, canRun, onOpen, onRunNow }: {
  routine: GerrieRoutine;
  organizationId: UUID;
  anchor: RefObject<HTMLElement>;
  /** In de lijst naast het detail: kleiner, zonder knoppen. */
  compact: boolean;
  selected: boolean;
  busy: boolean;
  waiting: number;
  /** Naam van de eigenaar; null = jouw eigen agent. */
  owner: string | null;
  live: LiveRun | null;
  latest: GerrieRoutineRun | null;
  canRun: boolean;
  onOpen: () => void;
  onRunNow: () => void;
}) {
  const archived = r.status === 'archived';
  const working = Boolean(live) || busy;
  const finished = latest && !isLiveRun(latest) ? latest : null;
  const outcome = runOutcome(finished);
  const when = finished ? whenShort(finished.finished_at ?? finished.started_at ?? finished.created_at) : '';
  return (
    <article className={`agx-card is-${r.status}${working ? ' is-working' : ''}${selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}`}>
      <button type="button" className="agx-card-open" onClick={onOpen} aria-current={selected ? 'true' : undefined}
        aria-label={`${r.name || 'Naamloze agent'}${working ? ', aan het werk' : ''}${waiting ? `, ${waiting} wacht op akkoord` : ''}`} />
      <AgentGlyph agent={r} size={compact ? 'sm' : 'md'} state={working ? 'running' : archived ? 'archived' : r.status} />
      <div className="agx-card-body">
        <div className="agx-card-top">
          <strong>{r.name || 'Naamloze agent'}</strong>
          {waiting > 0 && <span className="agx-badge" title={owner ? `${waiting} wacht op ${owner}` : `${waiting} wacht op jouw akkoord`}>{waiting}</span>}
          {r.visibility === 'team' && !archived && !compact && <span className="agx-flag" title="Gedeeld met je team"><Share2 size={11} /></span>}
        </div>
        <div className="agx-card-meta">
          <span className={`agx-state is-${working ? 'working' : r.status}`}>{working ? 'Aan het werk' : routineStatusLabel(r.status)}</span>
          {!compact && <span>{archived ? (r.archived_at ? `gearchiveerd ${whenShort(r.archived_at)}` : 'gearchiveerd') : shortSchedule(r)}</span>}
          {!compact && <span>{r.mode === 'propose' ? 'zet klaar' : 'kijkt mee'}</span>}
          {owner && <span className="agx-owner"><UserRound size={11} aria-hidden="true" /> {owner}</span>}
        </div>
        {!compact && (live
          ? <AgentLiveLine organizationId={organizationId} run={live} anchor={anchor} />
          : busy
            ? <span className="agx-live"><span className="agx-live-dots" aria-hidden="true"><i /><i /><i /></span><span className="agx-live-text">Opstarten…</span></span>
            : <span className={`agx-last is-${outcome.tone}`}>{when && <b>{when}</b>}<span>{outcome.text}</span></span>)}
      </div>
      {!compact && canRun && (
        <button type="button" className="agx-icon-btn" onClick={onRunNow} disabled={working} title={working ? 'Hij is al bezig' : 'Nu één keer draaien'} aria-label={`${r.name || 'Agent'} nu draaien`}>
          {working ? <Loader2 size={15} className="cc-spin" /> : <Play size={15} />}
        </button>
      )}
    </article>
  );
}

/**
 * Alles over één agent, naast de lijst (voorheen een paneel ónder de galerij, met
 * zeven losse vakjes). Van boven naar beneden: wie hij is en de knoppen, wat hij
 * nu doet (de werkbank), wat hij de vorige keer vond, hoe hij werkt, zijn
 * opdracht, en zijn geschiedenis.
 *
 * Welke knoppen er staan, volgt `powers` (dezelfde regel als de runner): de
 * eigenaar mag alles; een owner/admin kan de agent van een collega alleen
 * pauzeren, archiveren of terugzetten, want hij draait namens die collega.
 */
function AgentDetail({ routine, organizationId, canWrite, handlers, busy, runsKey, budget, waiting, powers, owner, live, latest, anchor, onRunNow, onStatus, onChat, onEdit, onArchive, onRestore, onShare, onCopy, onClose, onApprovalsChanged, onOpenQueue }: {
  routine: GerrieRoutine;
  organizationId: UUID;
  canWrite: boolean;
  handlers: GerrieActionHandlers;
  busy: boolean;
  runsKey: number;
  /** Resterend maandtegoed van het account als fractie 0..1; null = geen limiet. */
  budget: number | null;
  waiting: number;
  powers: AgentPowers;
  /** Naam van de eigenaar; null = jouw eigen agent. */
  owner: string | null;
  live: LiveRun | null;
  latest: GerrieRoutineRun | null;
  anchor: RefObject<HTMLElement>;
  onRunNow: () => void;
  onStatus: (status: RoutineStatus) => void;
  onChat: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onShare: (visibility: AgentVisibility) => void;
  onCopy: () => void;
  onClose: () => void;
  onApprovalsChanged: () => void;
  onOpenQueue: () => void;
}) {
  const readTools = routine.enabled_tools.filter(routineToolIsRead);
  const proposeTools = routine.enabled_tools.filter((n) => !routineToolIsRead(n));
  const isArchived = routine.status === 'archived';
  const shared = routine.visibility === 'team';
  const events = useRunEvents(organizationId, live?.id ?? null, anchor);
  const finished = latest && !isLiveRun(latest) ? latest : null;
  const outcome = runOutcome(finished);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  // Wat hij deze maand deed. Best-effort: lukt het niet, dan staat er gewoon niets.
  const [month, setMonth] = useState<AgentMonthStats | null>(null);
  useEffect(() => {
    let alive = true;
    loadAgentMonth(organizationId, routine.id, startOfMonthIso())
      .then(({ runs, decisions }) => { if (alive) setMonth(summarizeAgentMonth(runs, decisions)); })
      .catch(() => { if (alive) setMonth(null); });
    return () => { alive = false; };
  }, [organizationId, routine.id, runsKey]);

  // Het menu "Meer" sluit bij een klik ernaast en met Escape.
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDoc = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);

  const working = Boolean(live) || busy;
  const nextLine = routine.schedule_kind === 'event'
    ? `Start zodra het gebeurt, hoogstens ${routine.max_event_runs_per_day ?? 24} keer per dag`
    : routine.status === 'active' && routine.next_run_at ? `Volgende keer: ${fmtWhen(routine.next_run_at)}` : routine.status === 'active' ? '' : 'Draait niet zolang hij niet aan staat';
  const menu = (label: ReactNode, onClick: () => void, opts: { danger?: boolean; title?: string } = {}) => (
    <button type="button" role="menuitem" className={opts.danger ? 'is-danger' : undefined} title={opts.title} onClick={() => { setMoreOpen(false); onClick(); }}>{label}</button>
  );

  return (
    <article className={`agx-detail${working ? ' is-working' : ''}`} aria-label={routine.name || 'Agent'}>
      <header className="agx-detail-head">
        <AgentGlyph agent={routine} size="lg" state={working ? 'running' : isArchived ? 'archived' : routine.status} />
        <div className="agx-detail-ident">
          <h2>{routine.name || 'Naamloze agent'}</h2>
          <div className="agx-detail-pills">
            <span className={`agx-state is-${working ? 'working' : routine.status}`}>{working ? 'Aan het werk' : routineStatusLabel(routine.status)}</span>
            <span className={`agx-mode is-${routine.mode}`}>{routine.mode === 'propose' ? 'Zet klaar, jij keurt goed' : 'Kijkt mee, verandert niets'}</span>
            {owner && <span className="agx-owner"><UserRound size={12} /> van {owner}</span>}
            {shared && !isArchived && <span className="agx-owner"><Share2 size={12} /> gedeeld met het team</span>}
          </div>
          <p className="agx-detail-when"><CalendarClock size={13} /> {scheduleLabel(routine)}{nextLine ? <span> · {nextLine}</span> : null}</p>
        </div>
        <button type="button" className="ag-sheet-close" onClick={onClose} aria-label="Sluiten"><X size={16} /></button>
      </header>

      <div className="agx-actions">
        {isArchived ? (
          powers.oversee && (
            <button className="agx-primary" disabled={busy} onClick={onRestore}>
              {busy ? <><Loader2 size={14} className="cc-spin" /> Bezig…</> : <><ArchiveRestore size={14} /> Terugzetten</>}
            </button>
          )
        ) : <>
          {powers.manage && <>
            <button className="agx-primary" disabled={working} onClick={onRunNow}>
              {working ? <><Loader2 size={14} className="cc-spin" /> Aan het werk…</> : <><Play size={14} /> Nu draaien</>}
            </button>
            {routine.status === 'active'
              ? <button className="agx-ghost" disabled={busy} onClick={() => onStatus('paused')}><Pause size={14} /> Pauzeren</button>
              : <button className="agx-ghost is-go" disabled={busy} onClick={() => onStatus('active')}><Power size={14} /> Aanzetten</button>}
            <button className="agx-ghost" onClick={onChat}><WandSparkles size={14} /> Aanpassen met Gerrie</button>
          </>}
          {/* Toezicht: stilzetten mag, aanzetten niet; dan zou hij gaan draaien
              namens iemand die daar niet om vroeg. */}
          {!powers.manage && powers.oversee && routine.status === 'active' && (
            <button className="agx-ghost" disabled={busy} onClick={() => onStatus('paused')}><Pause size={14} /> Pauzeren</button>
          )}
          {!powers.manage && powers.copy && (
            <button className="agx-ghost" disabled={busy} onClick={onCopy}><Copy size={14} /> Kopie voor mezelf</button>
          )}
          {(powers.manage || powers.oversee) && (
            <div className="agx-more" ref={moreRef}>
              <button type="button" className="agx-ghost" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}><Ellipsis size={15} /> Meer</button>
              {moreOpen && (
                <div className="agx-menu" role="menu">
                  {powers.manage && menu(<><SlidersHorizontal size={14} /> In het formulier bewerken</>, onEdit)}
                  {powers.manage && menu(<><Share2 size={14} /> {shared ? 'Niet meer delen' : 'Delen met het team'}</>, () => onShare(shared ? 'private' : 'team'),
                    { title: shared ? 'Collega’s zien hem dan niet meer als startpunt' : 'Collega’s zien zijn instellingen en kunnen er een eigen kopie van maken; niet zijn runs of voorstellen' })}
                  {powers.manage && powers.copy && menu(<><Copy size={14} /> Kopie maken</>, onCopy)}
                  {/* Geen "verwijderen": wat hij namens iemand deed gooien we niet weg. */}
                  {powers.oversee && menu(<><Archive size={14} /> Archiveren</>, onArchive, { danger: true, title: 'De agent stopt; zijn logboek blijft bewaard' })}
                </div>
              )}
            </div>
          )}
        </>}
      </div>

      {isArchived && (
        <p className="ag-archived-note">
          <Archive size={13} />
          <span>Deze agent is gearchiveerd{routine.archived_at ? ` op ${fmtWhen(routine.archived_at)}` : ''} en draait niet meer. Zijn logboek staat hieronder; zet hem terug als je hem weer wilt gebruiken.</span>
        </p>
      )}
      {/* Toezicht op de agent van een collega: zeg waarom de helft van de knoppen
          ontbreekt, in plaats van ze te tonen en dan te weigeren. */}
      {!isArchived && !powers.manage && (
        <p className="ag-archived-note">
          <Users2 size={13} />
          <span>{owner === FORMER_MEMBER
            ? 'De medewerker namens wie deze agent draaide, is er niet meer. Hij draait niet; archiveer hem, of maak er een eigen kopie van.'
            : `Deze agent draait namens ${owner}, met diens rechten, en zijn voorstellen wachten op ${owner}. Jij kunt hem pauzeren of archiveren; aanpassen, aanzetten en starten doet ${owner} zelf.`}</span>
        </p>
      )}

      {live
        ? <AgentWorkbench routine={routine} run={live} events={events} />
        : busy && <div className="agx-starting" role="status"><span className="agw-dots" aria-hidden="true"><i /><i /><i /></span> Hij start op…</div>}

      {!live && (
        <section className={`agx-outcome is-${outcome.tone}`} aria-label="Laatste uitkomst">
          <header>
            <span>Laatste keer{finished ? ` · ${whenShort(finished.finished_at ?? finished.started_at ?? finished.created_at)}` : ''}</span>
            {finished && <span className={`cc-pill ${runPillClass(finished.status)}`}><span className="cc-dot" />{runStatusLabel(finished.status)}</span>}
          </header>
          <p>{finished?.summary && outcome.tone !== 'bad' && outcome.tone !== 'quiet' ? finished.summary : outcome.text}</p>
          {waiting > 0 && (
            <button type="button" className="agx-link" onClick={onOpenQueue}>
              <ClipboardCheck size={14} /> {waiting} voorstel{waiting === 1 ? '' : 'len'} wacht{waiting === 1 ? '' : 'en'} op {owner ?? 'jouw'} akkoord <ChevronRight size={13} />
            </button>
          )}
        </section>
      )}

      <dl className="agx-how" aria-label="Zo werkt hij">
        <div>
          <dt><ScanSearch size={14} /> Kijkt in</dt>
          <dd>{readTools.length === 0
            ? 'De standaard leesset (klanten, facturen, herinneringen)'
            : <span className="agx-tags">{readTools.map((n) => <span key={n}>{routineToolLabel(n)}</span>)}</span>}</dd>
        </div>
        <div>
          <dt><ClipboardCheck size={14} /> Mag klaarzetten</dt>
          <dd>{routine.mode !== 'propose' || proposeTools.length === 0
            ? 'Niets; deze agent rapporteert alleen'
            : <><span className="agx-tags is-write">{proposeTools.map((n) => <span key={n}>{routineToolLabel(n)}</span>)}</span>
                <small>Hoogstens {routine.max_proposals_per_run ?? 3} per keer, elk achter {owner ? `het akkoord van ${owner}` : 'jouw akkoord'}.</small></>}</dd>
        </div>
        <div>
          <dt><Mailbox size={14} /> Bezorging</dt>
          <dd>{deliveryLabel(routine.delivery)}{routine.delivery?.quiet && <small>Niets te melden? Dan geen mail of melding; de run staat wel in de app.</small>}</dd>
        </div>
        <div>
          <dt><BarChart3 size={14} /> Deze maand</dt>
          <dd>{month ? monthStatsLine(month) : '—'}
            {/* De verhouding akkoord/afgewezen is de eerlijkste feedback die een
                agent krijgt: wijs je het meeste af, dan is de opdracht te ruim. */}
            {month && month.rejected > month.approved && month.rejected >= 2 && <small>Meer afgewezen dan goedgekeurd: maak de opdracht scherper, of laat hem alleen rapporteren.</small>}
          </dd>
        </div>
        <div>
          <dt><Gauge size={14} /> Nadenken en kosten</dt>
          <dd>{thinkingLabel(routine.model_kind)}
            <small>Gaat van het maandtegoed van {owner ? `het account van ${owner}` : 'je account'}{budget !== null && !owner ? `; nog ${Math.round(budget * 100)}% over` : ''}.{budget !== null && budget <= 0 && !owner ? ' Hij slaat runs over tot volgende maand.' : ''}</small>
          </dd>
        </div>
        <div>
          <dt><ShieldCheck size={14} /> Rechten</dt>
          <dd>Precies die van {owner ?? 'jou'}, nooit meer.{routine.consecutive_failures > 0 && <small>{routine.consecutive_failures}× achter elkaar mislukt</small>}</dd>
        </div>
      </dl>

      {routine.instruction && (
        <section className="agx-brief-box">
          <header>
            <span><BookOpen size={14} /> Zijn opdracht</span>
            {powers.manage && !isArchived && <button type="button" className="agx-link" onClick={onChat}><WandSparkles size={13} /> Aanpassen</button>}
          </header>
          <p>{routine.instruction}</p>
        </section>
      )}

      <div className="ag-history">
        <span className="ag-history-label"><History size={13} /> Geschiedenis</span>
        <RoutineRuns organizationId={organizationId} agentId={routine.id} canWrite={canWrite} handlers={handlers}
          refreshKey={runsKey} onApprovalsChanged={onApprovalsChanged} canReply={powers.manage && !isArchived} />
      </div>
    </article>
  );
}

interface EditorFields {
  name: string; instruction: string; mode: RoutineMode; model_kind: 'cheap' | 'strong';
  schedule_kind: RoutineScheduleKind; hour: number; minute: number; end_hour: number;
  day_of_week: number; day_of_month: number; tools: string[];
  /** Hoeveel dingen één run hoogstens klaarzet (bij "voorstellen doen"). */
  max_proposals: number;
  /** Bezorging naast de app: mail, pushmelding, en stil als er niets is. */
  email: boolean; push: boolean; quiet: boolean;
  visibility: AgentVisibility;
  /** null = laat de app het embleem afleiden uit naam + opdracht + tools. */
  icon: AgentIconKey | null; hue: number | null;
  /** Klantmail: wie schrijft, welke vaste tekst, en hoeveel mails per run. */
  email_mode: AgentEmailMode; email_subject: string; email_body: string; max_emails: number;
  /** Bij "zodra er iets gebeurt": waarop hij start, en hoe vaak per dag hoogstens. */
  trigger_events: string[]; max_event_runs: number;
}

const MAIL_TOOL = 'propose_send_client_email';

/** Uur en minuut uit een `<input type="time">`; leeg of onzin = ongewijzigd. */
function parseClock(value: string, fallback: { hour: number; minute: number }): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : fallback;
}

function RoutineEditor({ organizationId, routine, catalog, canPropose, onDone, onCancel }: {
  organizationId: UUID;
  routine: GerrieRoutine | null;
  /** De catalogus uit het commandocentrum; null = nog niet binnen, dan haalt de editor hem zelf. */
  catalog: RoutineCatalog | null;
  /** Mag deze agent iets klaarzetten? Zo nee, dan kijkt hij alleen mee. */
  canPropose: boolean;
  /** Na opslaan: wat de server ervan maakte, en of hij (nu) aan staat. */
  onDone: (result: RoutineSaveResult, activated: boolean) => void;
  onCancel: () => void;
}) {
  const channels = Array.isArray(routine?.delivery?.channels) ? routine!.delivery.channels : [];
  const [f, setF] = useState<EditorFields>(() => ({
    name: routine?.name ?? '',
    instruction: routine?.instruction ?? '',
    // Wie zelf niets mag klaarzetten, krijgt hier geen keuze die de server toch terugdraait.
    mode: canPropose ? (routine?.mode ?? 'report') : 'report',
    model_kind: routine?.model_kind ?? 'strong',
    schedule_kind: routine?.schedule_kind ?? 'weekly',
    hour: routine?.hour ?? 8,
    minute: routine?.minute ?? 0,
    end_hour: routine ? hourlyEnd(routine) : 17,
    day_of_week: routine?.day_of_week ?? 1,
    day_of_month: routine?.day_of_month ?? 1,
    tools: routine?.enabled_tools ?? [],
    max_proposals: routine?.max_proposals_per_run ?? 3,
    email: channels.includes('email'),
    push: channels.includes('push'),
    quiet: routine?.delivery?.quiet === true,
    visibility: routine?.visibility ?? 'private',
    icon: (routine?.icon as AgentIconKey | null) ?? null,
    hue: routine?.hue ?? null,
    email_mode: routine?.email_mode ?? 'compose',
    email_subject: routine?.email_subject ?? '',
    email_body: routine?.email_body ?? '',
    max_emails: routine?.max_emails_per_run ?? 5,
    trigger_events: routine?.trigger_events ?? [],
    max_event_runs: routine?.max_event_runs_per_day ?? 24,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);
  const [preview, setPreview] = useState<RoutinePreview | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const isNew = !routine || !routine.id;
  // Een nieuwe agent of een concept kan in één keer aan; een agent die al loopt of
  // gepauzeerd staat, houdt gewoon zijn stand.
  const canActivate = isNew || routine?.status === 'draft';
  const mailsClients = f.tools.includes(MAIL_TOOL);

  // Alles wat een agent kán, opgehaald bij de bron in plaats van uit een lijst hier.
  // Zo krijgt een agent elke nieuwe Gerrie-capability automatisch, en zie je alleen
  // wat jouw modulerechten toestaan.
  const [ownCatalog, setOwnCatalog] = useState<RoutineCatalog | null>(null);
  useEffect(() => {
    if (catalog) return;
    let alive = true;
    listRoutineToolsSafe(organizationId).then((c) => { if (alive) setOwnCatalog(c); });
    return () => { alive = false; };
  }, [organizationId, catalog]);
  const tools = (catalog ?? ownCatalog)?.tools ?? [];
  const catalogFallback = (catalog ?? ownCatalog)?.fallback === true;
  const readTools = tools.filter((t) => t.kind === 'read');
  const proposeTools = tools.filter((t) => t.kind === 'propose');
  // Waarop een agent kan starten: van de server (alleen modules die jij mag lezen),
  // of zolang die er niet is de vaste lijst.
  const eventChoices = (catalog ?? ownCatalog)?.events?.length
    ? (catalog ?? ownCatalog)!.events
    : AGENT_EVENT_LABELS.map((e) => ({ key: e.key, label: e.label, example: '' }));

  function toggleEvent(key: string) {
    setF((p) => ({ ...p, trigger_events: p.trigger_events.includes(key) ? p.trigger_events.filter((k) => k !== key) : [...p.trigger_events, key] }));
  }

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
  const glyph = { id: routine?.id || 'nieuw', name: f.name, instruction: f.instruction, enabled_tools: f.tools, icon: f.icon, hue: f.hue };
  const derivedIcon = agentIconKey({ ...glyph, icon: null });

  function toggleTool(name: string) {
    setF((p) => ({ ...p, tools: p.tools.includes(name) ? p.tools.filter((t) => t !== name) : [...p.tools, name] }));
  }

  /**
   * Eén keer proefdraaien met wat er nu in het formulier staat: alleen kijken, er
   * wordt niets aangemaakt of klaargezet. Zo zie je vóór het opslaan of de opdracht
   * met deze gegevens te doen is.
   */
  async function tryOut() {
    if (!f.instruction.trim() || trying) { if (!f.instruction.trim()) setErr('Geef eerst een opdracht om mee te proefdraaien.'); return; }
    setTrying(true); setErr(null);
    try {
      setPreview(await previewRoutine(organizationId, { instruction: f.instruction.trim(), enabled_tools: f.tools, model_kind: f.model_kind }));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Proefdraaien lukte niet.'); }
    finally { setTrying(false); }
  }

  async function save(activate: boolean) {
    if (!f.instruction.trim()) { setErr('Geef een opdracht voor de agent.'); return; }
    // Een vaste tekst zonder tekst levert een agent op die elke run stukloopt;
    // dat hoor je hier te horen, niet pas bij de eerste run.
    if (f.mode === 'propose' && mailsClients && f.email_mode === 'template' && !f.email_body.trim()) {
      setErr('Je hebt gekozen voor een vaste mailtekst — vul die dan ook in.'); return;
    }
    if (f.mode === 'propose' && mailsClients && f.email_mode === 'template' && !f.email_subject.trim()) {
      setErr('Geef een onderwerp voor de vaste mailtekst.'); return;
    }
    if (f.schedule_kind === 'event' && f.trigger_events.length === 0) {
      setErr('Kies minstens één gebeurtenis waarop de agent start.'); return;
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
      model_kind: f.model_kind, mode: canPropose ? f.mode : 'report', enabled_tools: f.tools,
      schedule_kind: f.schedule_kind, hour: f.hour, minute: f.minute,
      end_hour: f.schedule_kind === 'hourly' ? Math.max(f.hour, f.end_hour) : null,
      day_of_week: f.schedule_kind === 'weekly' ? f.day_of_week : null,
      day_of_month: f.schedule_kind === 'monthly' ? f.day_of_month : null,
      timezone: routine?.timezone || 'Europe/Amsterdam',
      max_proposals_per_run: f.max_proposals,
      trigger_events: f.schedule_kind === 'event' ? f.trigger_events : [],
      max_event_runs_per_day: f.max_event_runs,
      visibility: f.visibility,
      delivery: {
        channels: ['inapp', ...(f.email ? ['email'] : []), ...(f.push ? ['push'] : [])],
        quiet: f.quiet,
      },
    };
    try {
      const id = routine && routine.id ? routine.id : undefined;
      const result = await saveRoutine(organizationId, input, id, activate && !id);
      let activated = activate && result.status === 'active';
      // Een bestaand concept gaat na het opslaan apart aan.
      if (activate && id && result.id) {
        await setRoutineStatus(organizationId, result.id as UUID, 'active');
        activated = true;
      }
      onDone(result, activated);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Opslaan mislukt.'); setSaving(false); }
  }

  return (
    <div className="ag-page">
      <header className="ag-page-head">
        <div className="ag-editor-ident">
          <AgentGlyph agent={glyph} size="lg" />
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
              <AgentGlyph agent={{ ...glyph, icon: null }} size="sm" />
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
                <AgentGlyph agent={{ ...glyph, icon: d.key }} size="sm" />
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
            <select className="cc-text" value={f.mode} disabled={!canPropose} onChange={(e) => setF((p) => ({ ...p, mode: e.target.value as RoutineMode }))}>
              <option value="report">Alleen rapporteren (lezen)</option>
              <option value="propose">Voorstellen doen (jij keurt goed)</option>
            </select>
          </label>
          <label className="cc-field"><span>Nadenken</span>
            <select className="cc-text" value={f.model_kind} onChange={(e) => setF((p) => ({ ...p, model_kind: e.target.value === 'cheap' ? 'cheap' : 'strong' }))}>
              <option value="strong">{thinkingLabel('strong')}</option>
              <option value="cheap">{thinkingLabel('cheap')}</option>
            </select>
          </label>
        </div>
        {!canPropose
          ? <p className="cc-note">Jij kunt in Gerrie <b>lezen maar niets laten klaarzetten</b>, dus deze agent kijkt mee en vat samen. Een agent kan nooit meer dan degene namens wie hij draait.</p>
          : f.mode === 'report' && <p className="cc-note">Wil je dat de agent ook iets kan <b>versturen of aanmaken</b> (bv. herinneringen of facturen)? Zet “Wat mag de agent?” op <b>Voorstellen doen</b>.</p>}
        <p className="cc-note"><b>Grondig</b> is het beste voor opdrachten waarbij hij moet zoeken en afwegen; <b>snel</b> volstaat voor een korte check die vaak draait.</p>

        <div className="cc-field-row">
          <label className="cc-field"><span>Wanneer</span>
            <select className="cc-text" value={f.schedule_kind} onChange={(e) => setF((p) => ({ ...p, schedule_kind: e.target.value as RoutineScheduleKind }))}>
              <option value="daily">Elke dag</option>
              <option value="weekdays">Elke werkdag (ma–vr)</option>
              <option value="weekly">Wekelijks</option>
              <option value="monthly">Maandelijks</option>
              <option value="hourly">Elk uur op werkdagen</option>
              <option value="event">Zodra er iets gebeurt</option>
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
              <input className="cc-text" type="number" min={1} max={31} value={f.day_of_month} onChange={(e) => setF((p) => ({ ...p, day_of_month: Math.max(1, Math.min(31, Number(e.target.value) || 1)) }))} />
            </label>
          )}
          {f.schedule_kind !== 'event' && (
            <label className="cc-field"><span>{f.schedule_kind === 'hourly' ? 'Van' : 'Tijd'}</span>
              <input className="cc-text" type="time" step={300} value={clock(f.hour, f.minute)}
                onChange={(e) => setF((p) => ({ ...p, ...parseClock(e.target.value, { hour: p.hour, minute: p.minute }) }))} />
            </label>
          )}
          {f.schedule_kind === 'event' && (
            <label className="cc-field"><span>Hoogstens zo vaak per dag</span>
              <input className="cc-text ag-num" type="number" min={1} max={96} value={f.max_event_runs}
                onChange={(e) => setF((p) => ({ ...p, max_event_runs: Math.max(1, Math.min(96, Number(e.target.value) || 1)) }))} />
            </label>
          )}
          {f.schedule_kind === 'hourly' && (
            <label className="cc-field"><span>Tot en met</span>
              <select className="cc-text" value={Math.max(f.hour, f.end_hour)} onChange={(e) => setF((p) => ({ ...p, end_hour: Number(e.target.value) }))}>
                {Array.from({ length: 24 - f.hour }, (_, i) => f.hour + i).map((h) => <option key={h} value={h}>{clock(h, f.minute)}</option>)}
              </select>
            </label>
          )}
        </div>
        {f.schedule_kind === 'event' && (
          <div className="cc-field"><span>Waarop start hij?</span>
            <div className="ag-events">
              {eventChoices.map((e) => (
                <label key={e.key} className={`ag-event${f.trigger_events.includes(e.key) ? ' on' : ''}`}>
                  <input type="checkbox" checked={f.trigger_events.includes(e.key)} onChange={() => toggleEvent(e.key)} />
                  <span>
                    <b>{e.label}</b>
                    {e.example && <small>bijv. {e.example}</small>}
                  </span>
                </label>
              ))}
            </div>
            <p className="cc-note">Komen er een paar tegelijk binnen, dan handelt hij ze in <b>één run</b> af, meestal binnen een paar minuten. Je ziet alleen gebeurtenissen uit modules die jij mag inzien.</p>
          </div>
        )}
        <p className="cc-note">{scheduleLabel(f)}.{f.schedule_kind === 'hourly' ? ' Zet hieronder “stil als er niets te melden is” aan, anders krijg je elk uur een bericht.' : ''}</p>

        <div className="cc-field"><span>Welke gegevens mag de agent gebruiken?</span>
          <ToolPicker tools={readTools} chosen={f.tools} onToggle={toggleTool} />
          {catalogFallback && <p className="cc-note">De volledige lijst was even niet op te halen; je ziet een beperkte set. Herlaad de pagina om alles te zien.</p>}
          <p className="cc-note">Je ziet alleen wat jij zelf mag inzien: een agent draait met jouw rechten.</p>
        </div>
        {f.mode === 'propose' && (
          <div className="cc-field"><span>Acties die de agent mag vóórstellen</span>
            <ToolPicker tools={proposeTools} chosen={f.tools} onToggle={toggleTool} />
            <p className="cc-note">De agent <b>stelt deze acties alleen voor</b>. Jij keurt ze daarna goed — per regel, met een vinkje — en dán worden ze <b>écht uitgevoerd</b> (verstuurd/aangemaakt), via dezelfde weg als in de chat. Zonder jouw akkoord gebeurt er niets.</p>
            <label className="cc-field"><span>Hoogstens zoveel voorstellen per run</span>
              <input className="cc-text ag-num" type="number" min={1} max={10} value={f.max_proposals}
                onChange={(e) => setF((p) => ({ ...p, max_proposals: Math.max(1, Math.min(10, Number(e.target.value) || 1)) }))} />
            </label>
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

        <div className="cc-field"><span>Waar wil je het resultaat?</span>
          <div className="ag-delivery">
            <label className="cc-tool on"><input type="checkbox" checked disabled /> In de app (altijd)</label>
            <label className={`cc-tool${f.email ? ' on' : ''}`}><input type="checkbox" checked={f.email} onChange={(e) => setF((p) => ({ ...p, email: e.target.checked }))} /> Ook per e-mail</label>
            <label className={`cc-tool${f.push ? ' on' : ''}`}><input type="checkbox" checked={f.push} onChange={(e) => setF((p) => ({ ...p, push: e.target.checked }))} /> Pushmelding op je telefoon of computer</label>
            <label className={`cc-tool${f.quiet ? ' on' : ''}`}><input type="checkbox" checked={f.quiet} onChange={(e) => setF((p) => ({ ...p, quiet: e.target.checked }))} /> Stil als er niets te melden is</label>
          </div>
          {f.push && <p className="cc-note">Een pushmelding komt alleen aan op apparaten waar je meldingen hebt aangezet (Instellingen → Meldingen, “Je agents”).</p>}
        </div>

        <label className={`cc-tool cc-tool-wide${f.visibility === 'team' ? ' on' : ''}`}>
          <input type="checkbox" checked={f.visibility === 'team'} onChange={(e) => setF((p) => ({ ...p, visibility: e.target.checked ? 'team' : 'private' }))} />
          Deel met je team als startpunt — collega’s kunnen er een eigen kopie van maken (niet zijn runs of voorstellen zien)
        </label>

        {/* Proefdraaien met wat hier nu staat: alleen kijken, niets klaarzetten. */}
        <div className="abx-try">
          <button type="button" className="cc-btn ghost" disabled={saving || trying} onClick={() => void tryOut()}>
            {trying ? <><Loader2 size={13} className="cc-spin" /> Hij kijkt…</> : <><Eye size={13} /> Laat zien wat hij vindt</>}
          </button>
          <span>Draait hem één keer proef — alleen kijken; hij zet niets klaar en verstuurt niets. Telt mee voor je tegoed.</span>
        </div>
        {preview && (
          <div className={`abx-preview${preview.ok ? '' : ' is-empty'}`}>
            {preview.budget
              ? <p className="abx-preview-note">Je maandtegoed is op, dus proefdraaien kan nu niet.</p>
              : <>
                  <p className="abx-preview-text">{preview.text || 'Hij kwam niet met een antwoord terug.'}</p>
                  {preview.steps.length > 0 && (
                    <ul className="abx-preview-steps">
                      {preview.steps.map((st, i) => <li key={i} className={st.ok ? undefined : 'is-fail'}>{st.label}</li>)}
                    </ul>
                  )}
                </>}
          </div>
        )}

        {err && <div className="cc-plan-error">{err}</div>}
        <div className="cc-routine-form-foot">
          <button className="cc-btn ghost" onClick={onCancel} disabled={saving}>Annuleren</button>
          {canActivate ? <>
            <button className="cc-btn ghost" onClick={() => void save(false)} disabled={saving}>{saving ? 'Opslaan…' : 'Opslaan als concept'}</button>
            <button className="cc-btn primary" onClick={() => void save(true)} disabled={saving}>{saving ? 'Opslaan…' : isNew ? 'Aanmaken en aanzetten' : 'Opslaan en aanzetten'}</button>
          </> : (
            <button className="cc-btn primary" onClick={() => void save(false)} disabled={saving}>{saving ? 'Opslaan…' : 'Opslaan'}</button>
          )}
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

function RoutineRuns({ organizationId, agentId, canWrite, handlers, refreshKey, onApprovalsChanged, canReply = true }: { organizationId: UUID; agentId: UUID; canWrite: boolean; handlers: GerrieActionHandlers; refreshKey: number; onApprovalsChanged?: () => void; /** Alleen de eigenaar antwoordt de agent. */ canReply?: boolean }) {
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
  if (runs.length === 0) return <div className="cc-runs cc-rail-empty">{canReply ? 'Nog geen runs. Klik “Nu draaien” om te testen.' : 'Nog geen runs.'}</div>;

  return (
    <div className="cc-runs">
      {runs.map((run, i) => (
        <RunItem key={run.id} run={run} organizationId={organizationId} canWrite={canWrite} handlers={handlers} defaultOpen={i === 0} onApprovalsChanged={onApprovalsChanged} canReply={canReply} />
      ))}
    </div>
  );
}

function RunItem({ run, organizationId, canWrite, handlers, defaultOpen, onApprovalsChanged, canReply }: { run: GerrieRoutineRun; organizationId: UUID; canWrite: boolean; handlers: GerrieActionHandlers; defaultOpen: boolean; onApprovalsChanged?: () => void; canReply: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const running = run.status === 'running' || run.status === 'claimed';
  return (
    <div className={`cc-run${open ? ' open' : ''}`}>
      <button className="cc-run-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="cc-run-chev">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
        <span className={`cc-pill ${runPillClass(run.status)}`}>{running ? <Spin size={11} /> : <span className="cc-dot" />}{runStatusLabel(run.status)}</span>
        <span className="cc-run-when">{fmtWhen(run.created_at)}</span>
        {run.triggered_by === 'manual' && <span className="cc-run-tag">handmatig</span>}
        {run.triggered_by === 'event' && <span className="cc-run-tag">gebeurtenis</span>}
        {run.proposals_created > 0 && <span className="cc-run-badge">{run.proposals_created} voorstel{run.proposals_created === 1 ? '' : 'len'}</span>}
        {run.result?.quiet === true && <span className="cc-run-tag">niets te melden</span>}
        {!open && run.summary && <span className="cc-run-peek">{run.summary}</span>}
      </button>
      {open && <RunDetail run={run} organizationId={organizationId} canWrite={canWrite} handlers={handlers} onApprovalsChanged={onApprovalsChanged} canReply={canReply} />}
    </div>
  );
}

type PropState = 'idle' | 'busy' | 'done' | 'rejected' | 'error';

function RunDetail({ run, organizationId, canWrite, handlers, onApprovalsChanged, canReply }: { run: GerrieRoutineRun; organizationId: UUID; canWrite: boolean; handlers: GerrieActionHandlers; onApprovalsChanged?: () => void; canReply: boolean }) {
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
      await runGerrieDecision(organizationId, auditId, () => executeProposal(p, handlers));
      setPstate((s) => ({ ...s, [auditId]: 'done' }));
      onApprovalsChanged?.();
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Uitvoeren mislukt.';
      setPstate((s) => ({ ...s, [auditId]: 'error' })); setPmsg((x) => ({ ...x, [auditId]: m }));
      onApprovalsChanged?.();
    }
  }
  async function reject(auditId: string) {
    setPstate((s) => ({ ...s, [auditId]: 'busy' }));
    try {
      await rejectGerrieAction(organizationId, auditId);
      setPstate((s) => ({ ...s, [auditId]: 'rejected' }));
    } catch (e) {
      setPstate((s) => ({ ...s, [auditId]: 'error' }));
      setPmsg((x) => ({ ...x, [auditId]: e instanceof Error ? e.message : 'Afwijzen mislukt.' }));
    }
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
                {info.detail && <div className="cc-approve-detail">{info.detail}</div>}
                {st === 'error' && pmsg[auditId] && <div className="cc-approve-err">{pmsg[auditId]}</div>}
                {st === 'done' ? <div className="cc-lane-ok"><Check size={13} /> Uitgevoerd</div>
                  : st === 'rejected' ? <div className="cc-lane-cancel">Afgewezen.</div>
                  : batch ? (
                    <AgentBatchBoard
                      proposal={batch}
                      canWrite={canWrite}
                      handlers={claimingHandlers(organizationId, auditId, handlers)}
                      onResolved={(result) => {
                        const decision = batchDecision(result);
                        void confirmGerrieAction(organizationId, auditId, decision.outcome, decision.detail);
                        setPstate((s) => ({ ...s, [auditId]: decision.outcome === 'executed' ? 'done' : 'rejected' }));
                        onApprovalsChanged?.();
                      }}
                    />
                  ) : (
                    <div className="cc-approve-actions">
                      <button className="cc-btn tiny ghost" disabled={st === 'busy'} onClick={() => void reject(auditId)}>Afwijzen</button>
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

          {/* Antwoorden draait de agent nog een beurt, met de rechten en het tegoed van
              zijn eigenaar — dus dat doet alleen die eigenaar. */}
          {canReply && <div className="cc-reply">
            <input
              className="cc-text" value={reply} disabled={replying}
              placeholder="Antwoord de agent… (bv. “ja, verstuur maar”)"
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(); } }}
            />
            <button className="cc-btn tiny primary" disabled={!reply.trim() || replying} onClick={() => void sendReply()}>
              {replying ? <Spin size={13} /> : <CornerDownLeft size={13} />} Stuur
            </button>
          </div>}
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
