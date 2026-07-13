import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Check, X, AlertTriangle, Square, ListChecks, Wand2 } from 'lucide-react';
import {
  streamGerrieReply, planGerrieMission, loadGerrieBudget, confirmGerrieAction,
  type GerrieActionHandlers, type GerrieProposal, type GerrieMissionSubtask,
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
                <span className="cc-chip-model gold">Planner · sterk model</span>
                <span className="cc-chip-model">Deel-agents · Haiku (zuinig)</span>
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
            <p className="cc-note"><b>Zuinig:</b> deel-agents draaien op Haiku, plannen op het sterke model. Max 4 agents per missie.</p>
          </div>

          {(busy || lanes.some((l) => l.status !== 'running')) && (
            <div className="cc-controls">
              {activeCount > 0 && <button className="cc-btn ghost danger" onClick={stopAll}><Square size={13} /> Stop alles</button>}
              {lanes.some((l) => l.status !== 'running' && l.status !== 'waiting') && <button className="cc-btn ghost" onClick={clearFinished}>Klaar opruimen</button>}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function LaneCard({ lane, onStop }: { lane: Lane; onStop: () => void }) {
  const pill = statusPill(lane.status);
  return (
    <article className={`cc-lane${lane.status === 'waiting' ? ' attn' : ''}`}>
      <div className="cc-lane-top">
        <span className="cc-lane-name">{lane.role}</span>
        {lane.kind !== 'read' && <span className="cc-lane-model">Haiku</span>}
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
