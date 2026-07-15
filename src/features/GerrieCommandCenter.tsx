import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Check, X, AlertTriangle, Square, ListChecks, Wand2, Clock, Plus, Play, Pause, Trash2, Pencil, RotateCw } from 'lucide-react';
import {
  streamGerrieReply, planGerrieMission, loadGerrieBudget, confirmGerrieAction,
  listRoutines, listRoutineRuns, saveRoutine, setRoutineStatus, deleteRoutine, runRoutineNow, listRunProposals,
  ROUTINE_READ_TOOLS, ROUTINE_PROPOSE_TOOLS,
  type GerrieActionHandlers, type GerrieProposal, type GerrieMissionSubtask,
  type GerrieRoutine, type GerrieRoutineRun, type GerrieRoutineInput,
  type RoutineMode, type RoutineScheduleKind, type RoutineStatus, type RoutineRunStatus,
} from '../lib/gerrie-api';
import { euro, formatMinutes } from '../lib/format';
import type { UUID } from '../types';

/**
 * Gerrie Commandocentrum — schermvullende multi-agent-pagina.
 *
 * Gerrie werkt hier als een team van agents die MEERDERE taken tegelijk oppakken. De
 * BROWSER is de dirigent: hij vuurt per deeltaak een aparte `streamGerrieReply` af
 * (zuinig model = Haiku) en toont elke agent als een live "baan". Alles wat iets
 * VERSTUURT/AANMAAKT/WIJZIGT komt als voorstel in de centrale goedkeuringswachtrij;
 * lezen/analyseren loopt automatisch. Goedgekeurde acties worden uitgevoerd via
 * dezelfde handlers (gerrieActions) als de gewone Gerrie-chat.
 *
 * Fase 1 = "live meekijken": missies draaien zolang deze pagina open is. Doordraaien
 * op de achtergrond (durable queue + cron) is een latere fase.
 */

type LaneStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
interface Lane {
  id: string;
  title: string;
  role: string;
  kind: 'read' | 'write' | 'unknown';
  status: LaneStatus;
  statusLabel: string | null;
  text: string;
  proposal?: GerrieProposal;
  auditId?: string;
  /** Resolutie van een voorstel in de goedkeuringswachtrij. */
  resolution?: 'executing' | 'executed' | 'rejected' | 'error';
  error?: string;
}

/** Een klaargezet plan (grote opdracht) dat wacht op akkoord vóór het uitwaaiert. */
interface PendingPlan { goal: string; summary: string; subtasks: GerrieMissionSubtask[]; estimatePct: number | null }

const QUICK_MISSIONS = [
  'Verstuur alle herinneringen die vandaag aan de beurt zijn',
  'Analyseer mijn openstaande facturen en vat de risico\'s samen',
  'Welke offertes lopen nog en wat is de status per klant?',
  'Geef een overzicht van mijn omzet en grootste klanten dit jaar',
];

let laneSeq = 0;
function newId(): string {
  try { return crypto.randomUUID(); } catch { return `lane-${Date.now()}-${++laneSeq}`; }
}

export function GerrieCommandCenter({ organizationId, canWrite, ...handlers }: { organizationId: UUID; canWrite: boolean } & GerrieActionHandlers) {
  const [tab, setTab] = useState<'live' | 'routines'>('live');
  const [draft, setDraft] = useState('');
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [budget, setBudget] = useState<number | null>(null);
  const [estimatePct, setEstimatePct] = useState<number | null>(null);
  const controllers = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    let cancelled = false;
    loadGerrieBudget(organizationId).then((f) => { if (!cancelled && f !== null) setBudget(f); });
    return () => { cancelled = true; };
  }, [organizationId]);

  // Bij het verlaten van de pagina/orgwissel: alle lopende agents netjes afbreken.
  useEffect(() => () => { controllers.current.forEach((c) => c.abort()); controllers.current.clear(); }, [organizationId]);

  function patchLane(id: string, patch: Partial<Lane>) {
    setLanes((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  /** Start één deel-agent (aparte SSE-stream, zuinig model). */
  function runLane(lane: Lane, instruction: string) {
    const ctrl = new AbortController();
    controllers.current.set(lane.id, ctrl);
    let streamed = '';
    streamGerrieReply({
      organizationId,
      conversationId: null,
      message: instruction,
      modelKind: 'cheap',
      signal: ctrl.signal,
      onStatus: (s) => patchLane(lane.id, { statusLabel: s.label }),
      onDelta: (d) => { streamed += d; patchLane(lane.id, { text: streamed, statusLabel: null }); },
    })
      .then((result) => {
        if (result.budget) setBudget(result.budget.remainingFraction);
        patchLane(lane.id, {
          status: result.proposal ? 'waiting' : 'done',
          statusLabel: null,
          text: result.text || streamed,
          proposal: result.proposal,
          auditId: result.auditId,
        });
      })
      .catch((err) => {
        if (ctrl.signal.aborted) { patchLane(lane.id, { status: 'cancelled', statusLabel: null }); return; }
        patchLane(lane.id, { status: 'failed', statusLabel: null, error: err instanceof Error ? err.message : 'Er ging iets mis.' });
      })
      .finally(() => { controllers.current.delete(lane.id); });
  }

  /** Losse missie: één taak, meteen als één baan. */
  function startLosseMissie(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setDraft('');
    setPendingPlan(null);
    const lane: Lane = { id: newId(), title: trimmed.slice(0, 70), role: 'Losse missie', kind: 'unknown', status: 'running', statusLabel: 'Gerrie start…', text: '' };
    setLanes((prev) => [lane, ...prev]);
    runLane(lane, trimmed);
  }

  /** Grote opdracht: Gerrie (sterk model) maakt eerst een plan; jij bevestigt vóór het uitwaaiert. */
  async function planGroteOpdracht(text: string) {
    const trimmed = text.trim();
    if (!trimmed || planning) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const plan = await planGerrieMission(organizationId, trimmed);
      if (plan.budget.remainingFraction !== null) setBudget(plan.budget.remainingFraction);
      if (!plan.subtasks.length) { setPlanError(plan.summary || 'Gerrie kon hier geen deeltaken van maken. Formuleer het iets concreter.'); return; }
      setPendingPlan({ goal: trimmed, summary: plan.summary, subtasks: plan.subtasks, estimatePct: plan.estimatePct });
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : 'Plannen mislukt.');
    } finally {
      setPlanning(false);
    }
  }

  /** Bevestig een klaargezet plan: waaier uit naar parallelle deel-agents. */
  function launchPlan(plan: PendingPlan) {
    setDraft('');
    setEstimatePct(plan.estimatePct);
    const created: Lane[] = plan.subtasks.map((s) => ({
      id: newId(), title: s.title, role: s.role, kind: s.kind, status: 'running' as const, statusLabel: 'In de wachtrij…', text: '',
    }));
    setLanes((prev) => [...created, ...prev]);
    setPendingPlan(null);
    created.forEach((lane, i) => runLane(lane, plan.subtasks[i].instruction));
  }

  function stopLane(id: string) {
    controllers.current.get(id)?.abort();
  }
  function stopAll() {
    controllers.current.forEach((c) => c.abort());
  }
  function clearFinished() {
    setLanes((prev) => prev.filter((l) => l.status === 'running' || l.status === 'waiting'));
  }

  // ── Goedkeuringen: voer een voorgestelde actie uit via de gedeelde handlers ──
  async function approve(lane: Lane) {
    if (!lane.proposal) return;
    const p = lane.proposal;
    patchLane(lane.id, { resolution: 'executing' });
    try {
      await executeProposal(p, handlers);
      if (lane.auditId) void confirmGerrieAction(organizationId, lane.auditId, 'executed');
      patchLane(lane.id, { status: 'done', resolution: 'executed' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Uitvoeren mislukt.';
      if (lane.auditId) void confirmGerrieAction(organizationId, lane.auditId, 'failed', msg);
      patchLane(lane.id, { resolution: 'error', error: msg });
    }
  }
  function reject(lane: Lane) {
    if (lane.auditId) void confirmGerrieAction(organizationId, lane.auditId, 'failed', 'Afgewezen door gebruiker.');
    patchLane(lane.id, { status: 'cancelled', resolution: 'rejected' });
  }

  const activeCount = lanes.filter((l) => l.status === 'running').length;
  const approvals = lanes.filter((l) => l.proposal && l.status === 'waiting' && l.resolution !== 'executed' && l.resolution !== 'rejected');
  const busy = activeCount > 0 || planning;

  return (
    <div className="cc-root">
      <header className="cc-top">
        <div className="cc-brand"><span className="cc-spark" aria-hidden="true"><Sparkles size={18} /></span><b>Gerrie</b><span className="cc-sub">Commandocentrum</span></div>
        <nav className="cc-tabs" aria-label="Gerrie-weergave">
          <button className={`cc-tab${tab === 'live' ? ' on' : ''}`} onClick={() => setTab('live')}><Sparkles size={14} /> Live</button>
          <button className={`cc-tab${tab === 'routines' ? ' on' : ''}`} onClick={() => setTab('routines')}><Clock size={14} /> Routines</button>
        </nav>
        <div className="cc-top-spacer" />
        {activeCount > 0 && <span className="cc-live" role="status"><span className="cc-live-dot" />{activeCount} agent{activeCount === 1 ? '' : 's'} aan het werk</span>}
        {budget !== null && (
          <div className="cc-budget" title="Resterend AI-tegoed deze maand">
            <span className="cc-budget-label">AI-tegoed</span>
            <span className="cc-budget-track"><span className="cc-budget-fill" data-low={budget <= 0.2 ? 'true' : 'false'} style={{ width: `${Math.round(budget * 100)}%` }} /></span>
            <span className="cc-budget-pct">{Math.round(budget * 100)}%</span>
          </div>
        )}
      </header>

      {tab === 'routines' ? (
        <RoutinesPanel organizationId={organizationId} canWrite={canWrite} handlers={handlers} />
      ) : (
      <div className="cc-body">
        <main className="cc-main">
          {/* Composer */}
          <section className="cc-composer">
            <label className="cc-composer-label" htmlFor="cc-input">Wat moet er gebeuren?</label>
            <textarea
              id="cc-input"
              className="cc-input"
              rows={2}
              placeholder="Bijv. “Bereid de maandafsluiting voor” — Gerrie splitst dit op in parallelle taken."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void planGroteOpdracht(draft); } }}
            />
            <div className="cc-composer-actions">
              <button className="cc-btn primary" disabled={!draft.trim() || planning} onClick={() => void planGroteOpdracht(draft)}>
                <Wand2 size={15} /> {planning ? 'Gerrie plant…' : 'Gerrie splitst dit op'}
              </button>
              <button className="cc-btn ghost" disabled={!draft.trim() || busy} onClick={() => startLosseMissie(draft)}>
                <Send size={14} /> Als één taak
              </button>
            </div>
            {planError && <div className="cc-plan-error">{planError}</div>}
            {lanes.length === 0 && !pendingPlan && (
              <div className="cc-quick">
                <span className="cc-quick-label">Snel starten</span>
                <div className="cc-quick-chips">
                  {QUICK_MISSIONS.map((q) => (
                    <button key={q} className="cc-chip" onClick={() => setDraft(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Klaargezet plan — wacht op akkoord */}
          {pendingPlan && (
            <section className="cc-plan">
              <div className="cc-plan-head">
                <span className="cc-plan-eyebrow">Plan · {pendingPlan.subtasks.length} deel-agent{pendingPlan.subtasks.length === 1 ? '' : 's'}</span>
                <span className="cc-chip-model gold">Zuinig ingesteld</span>
              </div>
              <p className="cc-plan-summary">{pendingPlan.summary}</p>
              <ul className="cc-plan-list">
                {pendingPlan.subtasks.map((s, i) => (
                  <li key={i}><span className={`cc-kind ${s.kind}`}>{s.kind === 'write' ? 'actie' : 'lezen'}</span><b>{s.role}</b> — {s.title}</li>
                ))}
              </ul>
              <div className="cc-plan-foot">
                {pendingPlan.estimatePct !== null && <span className="cc-est">Geschat ±{Math.max(1, Math.round(pendingPlan.estimatePct * 100))}% van je maandtegoed</span>}
                <div className="cc-plan-buttons">
                  <button className="cc-btn ghost" onClick={() => setPendingPlan(null)}>Annuleren</button>
                  <button className="cc-btn primary" onClick={() => launchPlan(pendingPlan)}>Start missie</button>
                </div>
              </div>
            </section>
          )}

          {/* Agent-banen */}
          {lanes.length > 0 ? (
            <section className="cc-lanes" aria-label="Agents">
              {lanes.map((lane) => <LaneCard key={lane.id} lane={lane} onStop={() => stopLane(lane.id)} />)}
            </section>
          ) : !pendingPlan && (
            <div className="cc-empty">
              <span className="cc-empty-icon" aria-hidden="true"><Sparkles size={26} /></span>
              <h2>Zet Gerrie als team aan het werk</h2>
              <p>Geef een grote opdracht en Gerrie splitst hem op in taken die tegelijk draaien — of start losse taken naast elkaar. Lezen doet hij automatisch; alles wat verstuurt of aanmaakt vink jij rechts af.</p>
            </div>
          )}
        </main>

        {/* Rechter rail: goedkeuringen + kosten + besturing */}
        <aside className="cc-rail">
          <div className="cc-card">
            <h3 className="cc-card-title"><ListChecks size={14} /> Goedkeuringen {approvals.length > 0 && <span className="cc-count">{approvals.length}</span>}</h3>
            {approvals.length === 0 ? (
              <p className="cc-rail-empty">Nog niets te bevestigen. Lezen/analyseren doet Gerrie zelf; acties verschijnen hier.</p>
            ) : (
              <div className="cc-approvals">
                {approvals.map((lane) => {
                  const info = proposalLabel(lane.proposal!);
                  return (
                    <div key={lane.id} className="cc-approve">
                      <div className="cc-approve-t">{info.title}</div>
                      <div className="cc-approve-s">{lane.role}{info.sub ? ` · ${info.sub}` : ''}</div>
                      {lane.resolution === 'error' && lane.error && <div className="cc-approve-err">{lane.error}</div>}
                      <div className="cc-approve-actions">
                        <button className="cc-btn tiny ghost" disabled={lane.resolution === 'executing'} onClick={() => reject(lane)}>Afwijzen</button>
                        <button className="cc-btn tiny primary" disabled={lane.resolution === 'executing' || (info.write && !canWrite)} onClick={() => void approve(lane)}>
                          {lane.resolution === 'executing' ? 'Bezig…' : info.write ? 'Akkoord' : 'Openen'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="cc-card">
            <h3 className="cc-card-title">Kosten &amp; tegoed</h3>
            {estimatePct !== null && (
              <div className="cc-meter">
                <div className="cc-meter-row"><span>Laatste missie (schatting)</span><span className="cc-mono">±{Math.max(1, Math.round(estimatePct * 100))}%</span></div>
              </div>
            )}
            {budget !== null ? (
              <div className="cc-meter">
                <div className="cc-meter-row"><span>AI-tegoed deze maand</span><span className="cc-mono">{Math.round(budget * 100)}% over</span></div>
                <div className="cc-track"><span className="cc-track-fill" data-low={budget <= 0.2 ? 'true' : 'false'} style={{ width: `${Math.round(budget * 100)}%` }} /></div>
              </div>
            ) : <p className="cc-rail-empty">Geen maandlimiet ingesteld.</p>}
            <p className="cc-note"><b>Zuinig ingesteld:</b> maximaal 4 agents tegelijk per missie, elk geoptimaliseerd voor snelheid.</p>
          </div>

          {(busy || lanes.some((l) => l.status !== 'running')) && (
            <div className="cc-controls">
              {activeCount > 0 && <button className="cc-btn ghost danger" onClick={stopAll}><Square size={13} /> Stop alles</button>}
              {lanes.some((l) => l.status !== 'running' && l.status !== 'waiting') && <button className="cc-btn ghost" onClick={clearFinished}>Klaar opruimen</button>}
            </div>
          )}
        </aside>
      </div>
      )}
    </div>
  );
}

function LaneCard({ lane, onStop }: { lane: Lane; onStop: () => void }) {
  const pill = statusPill(lane.status);
  return (
    <article className={`cc-lane${lane.status === 'waiting' ? ' attn' : ''}`}>
      <div className="cc-lane-top">
        <span className="cc-lane-name">{lane.role}</span>
        <span className="cc-lane-push" />
        <span className={`cc-pill ${pill.cls}`}><span className="cc-dot" />{pill.label}</span>
        {lane.status === 'running' && <button className="cc-lane-stop" title="Stop deze agent" onClick={onStop}><X size={13} /></button>}
      </div>
      <div className="cc-lane-title">{lane.title}</div>
      <div className="cc-lane-log">
        {lane.statusLabel && lane.status === 'running' && <div className="cc-lane-status">{lane.statusLabel}</div>}
        {lane.text ? <div className="cc-lane-text">{lane.text}{lane.status === 'running' && <span className="cc-caret" aria-hidden="true"> </span>}</div>
          : lane.status === 'running' && !lane.statusLabel ? <div className="cc-lane-typing" aria-label="bezig"><span /><span /><span /></div>
          : null}
        {lane.status === 'failed' && lane.error && <div className="cc-lane-err"><AlertTriangle size={13} /> {lane.error}</div>}
        {lane.status === 'done' && lane.resolution === 'executed' && <div className="cc-lane-ok"><Check size={13} /> Uitgevoerd</div>}
        {lane.status === 'waiting' && <div className="cc-lane-wait">→ klaargezet voor goedkeuring (rechts)</div>}
        {lane.status === 'cancelled' && <div className="cc-lane-cancel">Gestopt.</div>}
      </div>
    </article>
  );
}

function statusPill(s: LaneStatus): { cls: string; label: string } {
  switch (s) {
    case 'running': return { cls: 'run', label: 'Bezig' };
    case 'waiting': return { cls: 'wait', label: 'Wacht op akkoord' };
    case 'done': return { cls: 'done', label: 'Klaar' };
    case 'failed': return { cls: 'fail', label: 'Mislukt' };
    case 'cancelled': return { cls: 'cancel', label: 'Gestopt' };
  }
}

/** Kort label voor een voorstel in de goedkeuringswachtrij. `write` = echte actie (versturen/aanmaken), anders opent een formulier. */
function proposalLabel(p: GerrieProposal): { title: string; sub: string; write: boolean } {
  switch (p.type) {
    case 'send_invoice': return { title: `Factuur ${p.number} versturen`, sub: `naar ${p.recipient_email}`, write: true };
    case 'send_quote': return { title: `Offerte ${p.number} versturen`, sub: `naar ${p.recipient_email}`, write: true };
    case 'convert_quote': return { title: `Offerte ${p.number} omzetten naar factuur`, sub: p.client_name, write: true };
    case 'send_reminders': return { title: `${p.total} herinnering${p.total === 1 ? '' : 'en'} versturen`, sub: '1e / 2e / 3e niveau', write: true };
    case 'calendar_event': return { title: `Agenda-item: ${p.title}`, sub: `${p.date} ${p.start_time}–${p.end_time}`, write: true };
    case 'week_action': return { title: `${p.total} actiepunt${p.total === 1 ? '' : 'en'} toevoegen`, sub: p.items.map((i) => i.title).join(' · ').slice(0, 80), write: true };
    case 'time_entry': return { title: `${formatMinutes(p.minutes)} registreren`, sub: [p.client_name, p.project_name].filter(Boolean).join(' · ') || 'geen koppeling', write: true };
    case 'invoice': return { title: 'Conceptfactuur openen', sub: `${p.client_name} · ${euro(p.total_eur)}`, write: false };
    case 'quote': return { title: 'Conceptofferte openen', sub: `${p.client_name} · ${euro(p.total_eur)}`, write: false };
    case 'client': return { title: 'Nieuwe klant openen', sub: p.name, write: false };
    case 'edit_invoice': return { title: `Wijziging factuur ${p.number} openen`, sub: p.client_name, write: false };
    case 'edit_quote': return { title: `Wijziging offerte ${p.number} openen`, sub: p.client_name, write: false };
    case 'edit_client': return { title: 'Wijziging klant openen', sub: p.name, write: false };
    case 'project': return { title: 'Project openen', sub: p.name, write: false };
    case 'edit_project': return { title: 'Wijziging project openen', sub: p.name, write: false };
    case 'task': return { title: 'Taak openen', sub: `${p.title} · ${p.project_name}`, write: false };
    case 'edit_task': return { title: 'Wijziging taak openen', sub: p.title, write: false };
    case 'report': return { title: `Rapportage openen: ${p.name}`, sub: '', write: false };
  }
}

/** Voert een goedgekeurd voorstel uit via de gedeelde handlers (zelfde als de chat-dock). */
async function executeProposal(p: GerrieProposal, h: GerrieActionHandlers): Promise<void> {
  const need = (fn: (() => Promise<void>) | undefined) => fn ? fn() : Promise.reject(new Error('Deze actie is hier niet beschikbaar.'));
  switch (p.type) {
    case 'invoice': h.onCreateInvoiceDraft?.(p); return;
    case 'quote': h.onCreateQuoteDraft?.(p); return;
    case 'client': h.onCreateClientDraft?.(p); return;
    case 'edit_invoice': h.onEditInvoice?.(p); return;
    case 'edit_quote': h.onEditQuote?.(p); return;
    case 'edit_client': h.onEditClient?.(p); return;
    case 'project': h.onCreateProject?.(p); return;
    case 'edit_project': h.onEditProject?.(p); return;
    case 'task': h.onCreateTask?.(p); return;
    case 'edit_task': h.onEditTask?.(p); return;
    case 'report': h.onCreateReport?.(p); return;
    case 'send_invoice': await need(h.onSendInvoice ? () => h.onSendInvoice!(p) : undefined); return;
    case 'send_quote': await need(h.onSendQuote ? () => h.onSendQuote!(p) : undefined); return;
    case 'convert_quote': await need(h.onConvertQuote ? () => h.onConvertQuote!(p) : undefined); return;
    case 'send_reminders': await need(h.onSendReminders ? () => h.onSendReminders!(p) : undefined); return;
    case 'calendar_event': await need(h.onCreateCalendarEvent ? () => h.onCreateCalendarEvent!(p) : undefined); return;
    case 'week_action': await need(h.onCreateWeekAction ? () => h.onCreateWeekAction!(p) : undefined); return;
    case 'time_entry': await need(h.onLogTimeEntry ? () => h.onLogTimeEntry!(p) : undefined); return;
  }
}

// ── Routines (geplande agents) ───────────────────────────────────────────────

const DOW_NAMES = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

interface RoutineTemplate {
  name: string; instruction: string; mode: RoutineMode;
  schedule_kind: RoutineScheduleKind; hour: number; day_of_week?: number; day_of_month?: number; tools: string[];
}
const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  { name: 'Wekelijks factuuroverzicht', instruction: 'Geef een overzicht van alle openstaande facturen ouder dan 30 dagen: klantnaam, bedrag en aantal dagen te laat. Sluit af met het totaalbedrag.', mode: 'report', schedule_kind: 'weekly', day_of_week: 1, hour: 8, tools: ['list_invoices', 'list_due_reminders'] },
  { name: 'Wekelijkse betalingsherinneringen', instruction: 'Bekijk welke betalingsherinneringen vandaag aan de beurt zijn en zet ze klaar om te versturen. Groepeer per niveau (1e/2e/3e).', mode: 'propose', schedule_kind: 'weekly', day_of_week: 1, hour: 9, tools: ['list_due_reminders', 'propose_send_reminders'] },
  { name: 'Maandelijkse omzetsamenvatting', instruction: 'Vat de omzet van de afgelopen maand samen: totaalomzet, grootste klanten en het totaal openstaande bedrag.', mode: 'report', schedule_kind: 'monthly', day_of_month: 1, hour: 8, tools: ['get_financial_summary', 'list_invoices'] },
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
    id: '' as UUID, name: t.name, description: null, instruction: t.instruction,
    model_kind: 'cheap', mode: t.mode, enabled_tools: t.tools,
    schedule_kind: t.schedule_kind, hour: t.hour, day_of_week: t.day_of_week ?? null, day_of_month: t.day_of_month ?? null,
    timezone: 'Europe/Amsterdam', status: 'draft', next_run_at: null, last_run_at: null,
    max_cost_eur_per_run: 0.25, monthly_budget_eur: null, max_runs_per_day: 4, consecutive_failures: 0,
    delivery: { channels: ['inapp'], recipient_user_ids: [] }, created_at: '', updated_at: '',
  };
}

function RoutinesPanel({ organizationId, canWrite, handlers }: { organizationId: UUID; canWrite: boolean; handlers: GerrieActionHandlers }) {
  const [routines, setRoutines] = useState<GerrieRoutine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<GerrieRoutine | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openRuns, setOpenRuns] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const reload = () => setReloadKey((k) => k + 1);

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
    try { await setRoutineStatus(organizationId, r.id, status); reload(); }
    catch (e) { setToast(e instanceof Error ? e.message : 'Mislukt.'); }
    finally { setBusyId(null); }
  }
  async function doDelete(r: GerrieRoutine) {
    if (!confirm(`Routine "${r.name || 'naamloos'}" verwijderen?`)) return;
    setBusyId(r.id);
    try { await deleteRoutine(organizationId, r.id); reload(); }
    catch (e) { setToast(e instanceof Error ? e.message : 'Verwijderen mislukt.'); }
    finally { setBusyId(null); }
  }
  async function doRunNow(r: GerrieRoutine) {
    setBusyId(r.id); setToast(`"${r.name || 'Routine'}" draait…`);
    try {
      const res = await runRoutineNow(organizationId, r.id);
      setToast(res.proposalsCreated ? `Klaar — ${res.proposalsCreated} voorstel klaargezet om goed te keuren.` : 'Klaar — bekijk de run-historie.');
      setOpenRuns(r.id); reload();
    } catch (e) { setToast(e instanceof Error ? e.message : 'Draaien mislukt.'); }
    finally { setBusyId(null); }
  }

  if (editing) {
    return <RoutineEditor organizationId={organizationId} routine={editing === 'new' ? null : editing}
      onDone={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />;
  }

  return (
    <div className="cc-routines">
      <div className="cc-routines-head">
        <div>
          <h2 className="cc-routines-title">Routines</h2>
          <p className="cc-routines-lead">Geplande agents die vanzelf terugkeren. <b>De agent stelt voor, jij keurt goed</b> — er wordt niets verstuurd zonder jouw akkoord.</p>
        </div>
        <button className="cc-btn primary" onClick={() => setEditing('new')}><Plus size={15} /> Nieuwe routine</button>
      </div>

      {toast && <div className="cc-routines-toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
      {error && <div className="cc-plan-error">{error}</div>}

      {routines.length === 0 && !loading && (
        <div className="cc-routines-templates">
          <span className="cc-quick-label">Begin met een sjabloon</span>
          <div className="cc-quick-chips">
            {ROUTINE_TEMPLATES.map((t) => (
              <button key={t.name} className="cc-chip" onClick={() => setEditing(templateToRoutine(t))}>{t.name}</button>
            ))}
          </div>
        </div>
      )}

      {loading ? <div className="cc-routines-empty">Laden…</div> : (
        <div className="cc-routines-list">
          {routines.map((r) => (
            <article key={r.id} className="cc-card cc-routine">
              <div className="cc-routine-top">
                <span className={`cc-pill ${r.status === 'active' ? 'run' : r.status === 'paused' ? 'wait' : 'cancel'}`}><span className="cc-dot" />{routineStatusLabel(r.status)}</span>
                <b className="cc-routine-name">{r.name || 'Naamloze routine'}</b>
                <span className={`cc-kind ${r.mode === 'propose' ? 'write' : 'read'}`}>{r.mode === 'propose' ? 'stelt voor' : 'alleen lezen'}</span>
              </div>
              <div className="cc-routine-meta">
                <span><Clock size={12} /> {scheduleLabel(r)}</span>
                <span>Volgende: {fmtWhen(r.next_run_at)}</span>
                {r.last_run_at && <span>Laatste: {fmtWhen(r.last_run_at)}</span>}
              </div>
              {r.instruction && <p className="cc-routine-instr">{r.instruction}</p>}
              <div className="cc-routine-actions">
                <button className="cc-btn tiny ghost" disabled={busyId === r.id} onClick={() => void doRunNow(r)}><Play size={13} /> Nu draaien</button>
                {r.status === 'active'
                  ? <button className="cc-btn tiny ghost" disabled={busyId === r.id} onClick={() => void doStatus(r, 'paused')}><Pause size={13} /> Pauzeren</button>
                  : <button className="cc-btn tiny primary" disabled={busyId === r.id} onClick={() => void doStatus(r, 'active')}><Play size={13} /> Activeren</button>}
                <button className="cc-btn tiny ghost" onClick={() => setEditing(r)}><Pencil size={13} /> Bewerken</button>
                <button className="cc-btn tiny ghost" onClick={() => setOpenRuns(openRuns === r.id ? null : r.id)}><RotateCw size={13} /> Runs</button>
                <button className="cc-btn tiny ghost danger" disabled={busyId === r.id} onClick={() => void doDelete(r)} title="Verwijderen"><Trash2 size={13} /></button>
              </div>
              {openRuns === r.id && <RoutineRuns organizationId={organizationId} agentId={r.id} canWrite={canWrite} handlers={handlers} />}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

interface EditorFields {
  name: string; instruction: string; mode: RoutineMode; model_kind: 'cheap' | 'strong';
  schedule_kind: RoutineScheduleKind; hour: number; day_of_week: number; day_of_month: number; tools: string[]; email: boolean;
}

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
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isNew = !routine || !routine.id;

  function toggleTool(name: string) {
    setF((p) => ({ ...p, tools: p.tools.includes(name) ? p.tools.filter((t) => t !== name) : [...p.tools, name] }));
  }

  async function save() {
    if (!f.instruction.trim()) { setErr('Geef een opdracht voor de agent.'); return; }
    setSaving(true); setErr(null);
    const input: GerrieRoutineInput = {
      name: f.name.trim() || 'Naamloze routine',
      instruction: f.instruction.trim(),
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
    <div className="cc-routines">
      <div className="cc-routines-head">
        <h2 className="cc-routines-title">{isNew ? 'Nieuwe routine' : 'Routine bewerken'}</h2>
        <button className="cc-btn ghost" onClick={onCancel}><X size={14} /> Sluiten</button>
      </div>
      <div className="cc-card cc-routine-form">
        <label className="cc-field"><span>Naam</span>
          <input className="cc-text" value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} placeholder="Bijv. Wekelijks factuuroverzicht" />
        </label>
        <label className="cc-field"><span>Opdracht (in gewone taal)</span>
          <textarea className="cc-input" rows={3} value={f.instruction} onChange={(e) => setF((p) => ({ ...p, instruction: e.target.value }))} placeholder="Bijv. Geef een overzicht van openstaande facturen ouder dan 30 dagen." />
        </label>
        <div className="cc-field-row">
          <label className="cc-field"><span>Wat mag de agent?</span>
            <select className="cc-text" value={f.mode} onChange={(e) => setF((p) => ({ ...p, mode: e.target.value as RoutineMode }))}>
              <option value="report">Alleen rapporteren (lezen)</option>
              <option value="propose">Voorstellen doen (jij keurt goed)</option>
            </select>
          </label>
          <label className="cc-field"><span>Model</span>
            <select className="cc-text" value={f.model_kind} onChange={(e) => setF((p) => ({ ...p, model_kind: e.target.value === 'strong' ? 'strong' : 'cheap' }))}>
              <option value="cheap">Zuinig (Haiku)</option>
              <option value="strong">Sterk (Sonnet)</option>
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
          <div className="cc-tool-grid">
            {ROUTINE_READ_TOOLS.map((t) => (
              <label key={t.name} className={`cc-tool${f.tools.includes(t.name) ? ' on' : ''}`}>
                <input type="checkbox" checked={f.tools.includes(t.name)} onChange={() => toggleTool(t.name)} /> {t.label}
              </label>
            ))}
          </div>
        </div>
        {f.mode === 'propose' && (
          <div className="cc-field"><span>Acties die de agent mag vóórstellen</span>
            <div className="cc-tool-grid">
              {ROUTINE_PROPOSE_TOOLS.map((t) => (
                <label key={t.name} className={`cc-tool${f.tools.includes(t.name) ? ' on' : ''}`}>
                  <input type="checkbox" checked={f.tools.includes(t.name)} onChange={() => toggleTool(t.name)} /> {t.label}
                </label>
              ))}
            </div>
            <p className="cc-note">De agent <b>stelt deze acties alleen voor</b>. Jij keurt ze daarna goed in de run-historie — en dán worden ze <b>écht uitgevoerd</b> (verstuurd/aangemaakt), via dezelfde weg als in de chat. Zonder jouw akkoord gebeurt er niets.</p>
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

function RoutineRuns({ organizationId, agentId, canWrite, handlers }: { organizationId: UUID; agentId: UUID; canWrite: boolean; handlers: GerrieActionHandlers }) {
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
  }, [organizationId, agentId]);

  if (loading) return <div className="cc-runs">Runs laden…</div>;
  if (err) return <div className="cc-runs cc-plan-error">{err}</div>;
  if (runs.length === 0) return <div className="cc-runs cc-rail-empty">Nog geen runs. Klik “Nu draaien” om te testen.</div>;

  return (
    <div className="cc-runs">
      {runs.map((run) => (
        <div key={run.id} className="cc-run">
          <div className="cc-run-top">
            <span className={`cc-pill ${run.status === 'succeeded' ? 'done' : run.status === 'failed' ? 'fail' : run.status === 'running' ? 'run' : 'cancel'}`}><span className="cc-dot" />{runStatusLabel(run.status)}</span>
            <span className="cc-run-when">{fmtWhen(run.created_at)}</span>
            {run.triggered_by === 'manual' && <span className="cc-run-tag">handmatig</span>}
          </div>
          {run.summary && <div className="cc-run-summary">{run.summary}</div>}
          {run.error && <div className="cc-lane-err"><AlertTriangle size={13} /> {run.error}</div>}
          {run.proposals_created > 0 && <RunProposals organizationId={organizationId} runId={run.id} canWrite={canWrite} handlers={handlers} />}
        </div>
      ))}
    </div>
  );
}

function RunProposals({ organizationId, runId, canWrite, handlers }: { organizationId: UUID; runId: UUID; canWrite: boolean; handlers: GerrieActionHandlers }) {
  const [items, setItems] = useState<Array<{ auditId: string; proposal: GerrieProposal }>>([]);
  const [state, setState] = useState<Record<string, 'idle' | 'busy' | 'done' | 'rejected' | 'error'>>({});
  const [msg, setMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    listRunProposals(organizationId, runId).then((r) => { if (alive) setItems(r); }).catch(() => { /* stil */ });
    return () => { alive = false; };
  }, [organizationId, runId]);

  if (items.length === 0) return null;

  async function approve(auditId: string, p: GerrieProposal) {
    setState((s) => ({ ...s, [auditId]: 'busy' }));
    try {
      await executeProposal(p, handlers);
      void confirmGerrieAction(organizationId, auditId, 'executed');
      setState((s) => ({ ...s, [auditId]: 'done' }));
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Uitvoeren mislukt.';
      void confirmGerrieAction(organizationId, auditId, 'failed', m);
      setState((s) => ({ ...s, [auditId]: 'error' })); setMsg((x) => ({ ...x, [auditId]: m }));
    }
  }
  function reject(auditId: string) {
    void confirmGerrieAction(organizationId, auditId, 'failed', 'Afgewezen door gebruiker.');
    setState((s) => ({ ...s, [auditId]: 'rejected' }));
  }

  return (
    <div className="cc-run-proposals">
      {items.map(({ auditId, proposal }) => {
        const info = proposalLabel(proposal);
        const st = state[auditId] ?? 'idle';
        return (
          <div key={auditId} className="cc-approve">
            <div className="cc-approve-t">{info.title}</div>
            {info.sub && <div className="cc-approve-s">{info.sub}</div>}
            {st === 'error' && msg[auditId] && <div className="cc-approve-err">{msg[auditId]}</div>}
            {st === 'done' ? <div className="cc-lane-ok"><Check size={13} /> Uitgevoerd</div>
              : st === 'rejected' ? <div className="cc-lane-cancel">Afgewezen.</div>
              : (
                <div className="cc-approve-actions">
                  <button className="cc-btn tiny ghost" disabled={st === 'busy'} onClick={() => reject(auditId)}>Afwijzen</button>
                  <button className="cc-btn tiny primary" disabled={st === 'busy' || (info.write && !canWrite)} onClick={() => void approve(auditId, proposal)}>
                    {st === 'busy' ? 'Bezig…' : info.write ? 'Goedkeuren' : 'Openen'}
                  </button>
                </div>
              )}
          </div>
        );
      })}
    </div>
  );
}
