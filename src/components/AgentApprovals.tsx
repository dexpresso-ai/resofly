import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, Bot, CalendarClock, Check, ChevronRight, ClipboardCheck, Coins, ListChecks, Loader2, Mail, RefreshCw, Sparkles, X } from 'lucide-react';
import { confirmGerrieAction, listPendingAgentApprovals, type AgentApproval } from '../lib/gerrie-api';
import type { GerrieActionHandlers } from '../lib/gerrie-api';
import { executeProposal, proposalLabel, type ProposalKind } from '../lib/gerrie-proposals';
import { AgentGlyph } from './AgentGlyph';
import { ClientEmailBatch } from './ClientEmailBatch';
import type { UUID } from '../types';

/**
 * De goedkeurwachtrij — het "human in the loop"-bord.
 *
 * Geplande agents draaien terwijl niemand kijkt. Alles wat ze willen VERSTUREN of
 * AANMAKEN zetten ze klaar in plaats van het te doen; hier staat dat rijtje, en
 * hier gebeurt het ook echt. Uitvoeren loopt via dezelfde handlers als de chat
 * (`executeProposal`), dus een akkoord op het startscherm doet precies hetzelfde
 * als een akkoord in het commandocentrum.
 *
 * Twee gedaantes:
 *   variant="dashboard" — op het startscherm; verdwijnt volledig als er niets wacht.
 *   variant="page"      — in het commandocentrum; houdt een lege staat aan.
 */

type Variant = 'dashboard' | 'page';
type RowState = 'idle' | 'busy' | 'error';

const KIND_ICON: Record<ProposalKind, typeof Mail> = {
  mail: Mail,
  money: Coins,
  agenda: CalendarClock,
  work: ListChecks,
  insight: Sparkles,
  agent: Bot,
};

export function AgentApprovals({
  organizationId, canWrite, handlers, variant = 'page', onOpenCommandCenter, onCountChange, onChanged, refreshKey = 0,
}: {
  organizationId: UUID;
  /** Mag dit teamlid daadwerkelijk versturen/aanmaken? Zo nee: alleen afwijzen. */
  canWrite: boolean;
  handlers: GerrieActionHandlers;
  variant?: Variant;
  /** Zonder deze prop verdwijnt de "Naar het commandocentrum"-knop. */
  onOpenCommandCenter?: () => void;
  onCountChange?: (count: number) => void;
  /** Vuurt na elk akkoord/afwijzing, zodat tellers elders (tabbadge, tegels) meelopen. */
  onChanged?: () => void;
  /** Verhoog dit om een verse ophaal af te dwingen (bv. na "Nu draaien"). */
  refreshKey?: number;
}) {
  const [items, setItems] = useState<AgentApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback((quiet: boolean) => {
    if (!quiet) setLoading(true);
    listPendingAgentApprovals(organizationId)
      .then((rows) => { if (alive.current) { setItems(rows); setError(null); } })
      // Staat de Gerrie-module dicht of is de sessie net verlopen, dan is een lege
      // wachtrij het juiste antwoord — niet een rode balk op het startscherm.
      .catch((e) => { if (alive.current) setError(e instanceof Error ? e.message : 'Wachtrij laden mislukt.'); })
      .finally(() => { if (alive.current) setLoading(false); });
  }, [organizationId]);

  useEffect(() => { load(false); }, [load, refreshKey, tick]);

  // Zachtjes bijwerken: agents draaien op de achtergrond door, dus een startscherm
  // dat een uur openstaat hoort niet te blijven hangen op de stand van toen. Alleen
  // wanneer het tabblad écht in beeld is — anders tikt het door in een slapende tab.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load(true); };
    const timer = window.setInterval(refresh, 90_000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);

  useEffect(() => { onCountChange?.(items.length); }, [items.length, onCountChange]);

  function drop(auditId: string) {
    setItems((prev) => prev.filter((i) => i.auditId !== auditId));
    onChanged?.();
  }

  async function approve(item: AgentApproval) {
    setRowState((s) => ({ ...s, [item.auditId]: 'busy' }));
    try {
      await executeProposal(item.proposal, handlers);
      void confirmGerrieAction(organizationId, item.auditId, 'executed');
      // Ook een "openen"-voorstel (dat een formulier opent) verlaat de wachtrij:
      // de beslissing is genomen, het scherm neemt het over.
      drop(item.auditId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Uitvoeren mislukt.';
      void confirmGerrieAction(organizationId, item.auditId, 'failed', msg);
      setRowState((s) => ({ ...s, [item.auditId]: 'error' }));
      setRowError((s) => ({ ...s, [item.auditId]: msg }));
    }
  }

  function reject(item: AgentApproval) {
    void confirmGerrieAction(organizationId, item.auditId, 'failed', 'Afgewezen door gebruiker.');
    drop(item.auditId);
  }

  const count = items.length;

  // Op het startscherm is "niets te doen" geen bericht maar afwezigheid.
  if (variant === 'dashboard' && (count === 0 || error)) return null;

  return (
    <section className={`ag-queue ag-queue-${variant}`} aria-label="Acties die op je akkoord wachten">
      <header className="ag-queue-head">
        <span className="ag-queue-mark" aria-hidden="true"><ClipboardCheck size={16} /></span>
        <div className="ag-queue-titles">
          <h2>Jouw akkoord</h2>
          <p>
            {count === 0
              ? 'Je agents hebben niets klaargezet dat op je wacht.'
              : `${count} actie${count === 1 ? '' : 's'} klaargezet door je agents — niets is verstuurd zonder jou.`}
          </p>
        </div>
        {count > 0 && <span className="ag-queue-count">{count}</span>}
        <button type="button" className="ag-queue-refresh" onClick={() => setTick((t) => t + 1)} title="Wachtrij verversen" aria-label="Wachtrij verversen">
          <RefreshCw size={14} className={loading ? 'ag-spin' : undefined} />
        </button>
      </header>

      {error && variant === 'page' && <p className="ag-queue-error"><AlertTriangle size={13} /> {error}</p>}

      {loading && count === 0 && !error
        ? <p className="ag-queue-empty">Wachtrij laden…</p>
        : count === 0 && !error
          ? <div className="ag-queue-zero">
              <span aria-hidden="true"><Check size={15} /></span>
              <div><strong>Niets te beslissen</strong>Zodra een agent iets wil versturen of aanmaken, staat het hier klaar.</div>
            </div>
          : <ul className="ag-queue-list">
              {items.map((item) => {
                const info = proposalLabel(item.proposal);
                const state = rowState[item.auditId] ?? 'idle';
                const KindIcon = KIND_ICON[info.kind];
                const blocked = info.write && !canWrite;
                // Een reeks klantmails krijgt geen enkele akkoordknop maar het
                // uitklapbare mailbord: je beslist per mail, niet per stapel.
                const mailBatch = item.proposal.type === 'send_client_email' ? item.proposal : null;
                return (
                  <li key={item.auditId} className={`ag-queue-row${state === 'error' ? ' is-error' : ''}${mailBatch ? ' is-batch' : ''}`}>
                    <AgentGlyph
                      agent={{ id: item.agentId ?? undefined, name: item.agentName, icon: item.agentIcon, hue: item.agentHue }}
                      size="md"
                      title={item.agentName}
                    />
                    <div className="ag-queue-body">
                      <div className="ag-queue-what">
                        <span className="ag-queue-kind" aria-hidden="true"><KindIcon size={12} /></span>
                        <strong>{info.title}</strong>
                      </div>
                      <div className="ag-queue-meta">
                        <span className="ag-queue-agent">{item.agentName}</span>
                        {info.sub && <span className="ag-queue-sub">{info.sub}</span>}
                        <span className="ag-queue-when">{relativeTime(item.createdAt)}</span>
                      </div>
                      {state === 'error' && rowError[item.auditId] && (
                        <p className="ag-queue-rowerr"><AlertTriangle size={12} /> {rowError[item.auditId]}</p>
                      )}
                      {blocked && !mailBatch && <p className="ag-queue-rowhint">Je hebt geen schrijfrechten voor deze actie — vraag een owner of admin.</p>}
                      {mailBatch && (
                        <ClientEmailBatch
                          proposal={mailBatch}
                          canWrite={canWrite}
                          onSendOne={(mail) => handlers.onSendClientEmail
                            ? handlers.onSendClientEmail(mail)
                            : Promise.reject(new Error('Mailen is hier niet beschikbaar.'))}
                          onResolved={({ sent, skipped }) => {
                            void confirmGerrieAction(
                              organizationId, item.auditId,
                              sent > 0 ? 'executed' : 'failed',
                              `${sent} verstuurd, ${skipped} overgeslagen.`,
                            );
                            drop(item.auditId);
                          }}
                        />
                      )}
                    </div>
                    {!mailBatch && <div className="ag-queue-actions">
                      <button type="button" className="ag-btn ag-btn-ghost" disabled={state === 'busy'} onClick={() => reject(item)}>
                        <X size={13} /> Afwijzen
                      </button>
                      <button type="button" className="ag-btn ag-btn-go" disabled={state === 'busy' || blocked} onClick={() => void approve(item)}>
                        {state === 'busy'
                          ? <><Loader2 size={13} className="ag-spin" /> Bezig…</>
                          : info.write ? <><Check size={13} /> Akkoord</> : <><ArrowRight size={13} /> Openen</>}
                      </button>
                    </div>}
                  </li>
                );
              })}
            </ul>}

      {onOpenCommandCenter && (
        <button type="button" className="ag-queue-more" onClick={onOpenCommandCenter}>
          Naar je agents <ChevronRight size={14} />
        </button>
      )}
    </section>
  );
}

/** "net nu" / "12 min geleden" / "gisteren 08:00" — korter leesbaar dan een tijdstempel. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 2) return 'net nu';
  if (mins < 60) return `${mins} min geleden`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} uur geleden`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'gisteren';
  if (days < 8) return `${days} dagen geleden`;
  return new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(new Date(then));
}
