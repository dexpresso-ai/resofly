import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, BellOff, CalendarClock, Check, ChevronRight, Clock, Coins, ListChecks, Loader2, Mail, RefreshCw, Sparkles, X } from 'lucide-react';
import { supabase, supabaseAuth } from '../lib/supabase';
import { isDue, listDecisions, muteDecision, resolveDecision, type AiDecision, type DecisionKind, type DecisionTarget } from '../lib/decisions-api';
import type { GerrieActionHandlers } from '../lib/gerrie-api';
import { executeProposal, isFormBackedProposal, openProposal, proposalVerb } from '../lib/gerrie-proposals';
import { AgentBatchBoard, asBatchProposal } from './AgentBatchBoard';
import type { UUID } from '../types';

/**
 * De beslislijst — kaarten die Gerrie zelf klaarzette uit signalen in de app.
 *
 * Elke kaart draagt een voorstel (offerte-opvolgmail, taken uit notulen, mail
 * koppelen, …) én de feiten waarom ("Waarom"). Akkoord voert het voorstel uit
 * langs precies dezelfde weg als de chat en de goedkeurwachtrij
 * (`executeProposal`), en pas daarna gaat de kaart dicht. Later en Niet meer
 * lopen via de RPC's; er is geen tweede schrijfweg.
 *
 * Twee gedaantes, zoals AgentApprovals:
 *   variant="dashboard" — bovenaan het startscherm; verdwijnt als er niets wacht.
 *   variant="page"      — in het commandocentrum; houdt een lege staat aan en
 *                         toont ook wat op "Later" staat.
 */

type Variant = 'dashboard' | 'page';
type RowState = 'idle' | 'busy' | 'error';
type Menu = 'snooze' | 'mute';

const KIND_ICON: Record<DecisionKind, typeof Mail> = {
  quote_opened_unanswered: Coins,
  quote_expiring: Coins,
  contract_unsigned: Coins,
  inbound_mail: Mail,
  mail_unmatched: Mail,
  meeting_notes_ready: ListChecks,
  meeting_notes_unsent: Mail,
  gallery_favorites_chosen: ListChecks,
};

export function DecisionFeed({
  organizationId, canWrite, handlers, variant = 'page', onOpenTarget, onOpenCommandCenter, onCountChange, refreshKey = 0,
}: {
  organizationId: UUID;
  /** Mag dit teamlid een kaart van deze module uitvoeren? */
  canWrite: (module: string) => boolean;
  handlers: GerrieActionHandlers;
  variant?: Variant;
  /** Opent het item waar de kaart over gaat (klant, project, offerte, …). */
  onOpenTarget?: (target: DecisionTarget) => void;
  onOpenCommandCenter?: () => void;
  onCountChange?: (count: number) => void;
  refreshKey?: number;
}) {
  const [items, setItems] = useState<AiDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ id: string; kind: Menu } | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const rows = await listDecisions(organizationId);
      if (!mounted.current) return;
      setItems(rows);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : 'Beslislijst laden mislukt.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load, tick, refreshKey]);

  // Zacht verversen (zoals de wachtrij) én live: een nieuwe kaart verschijnt meteen.
  useEffect(() => {
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 90_000);
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    supabaseAuth.getSession().then(({ data }) => {
      if (cancelled) return;
      const token = data.session?.access_token;
      if (token) supabase.realtime.setAuth(token);
      channel = supabase
        .channel(`decisions-feed-${organizationId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_decisions', filter: `organization_id=eq.${organizationId}` }, () => { void load(); })
        .subscribe();
    });
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      if (channel) supabase.removeChannel(channel);
    };
  }, [organizationId, load]);

  const due = useMemo(() => items.filter((d) => isDue(d)), [items]);
  const later = useMemo(() => items.filter((d) => !isDue(d)), [items]);

  useEffect(() => { onCountChange?.(due.length); }, [due.length, onCountChange]);

  function drop(id: string) {
    setItems((list) => list.filter((d) => d.id !== id));
    setMenu(null);
  }
  function fail(id: string, e: unknown) {
    setRowState((s) => ({ ...s, [id]: 'error' }));
    setRowError((s) => ({ ...s, [id]: e instanceof Error ? e.message : 'Er ging iets mis.' }));
  }

  async function approve(d: AiDecision) {
    if (!d.proposal) return;
    setRowState((s) => ({ ...s, [d.id]: 'busy' }));
    try {
      await executeProposal(d.proposal, handlers);
      await resolveDecision(d.id, 'done', null, 'akkoord');
      drop(d.id);
    } catch (e) { fail(d.id, e); }
  }
  async function snooze(d: AiDecision, until: string, label: string) {
    setRowState((s) => ({ ...s, [d.id]: 'busy' }));
    try {
      const updated = await resolveDecision(d.id, 'snoozed', until, `later: ${label}`);
      setItems((list) => list.map((x) => (x.id === d.id ? { ...x, ...updated } : x)));
      setRowState((s) => ({ ...s, [d.id]: 'idle' }));
      setMenu(null);
    } catch (e) { fail(d.id, e); }
  }
  async function dismiss(d: AiDecision, scope: 'card' | 'client' | 'kind') {
    setRowState((s) => ({ ...s, [d.id]: 'busy' }));
    try {
      if (scope === 'card') await resolveDecision(d.id, 'dismissed', null, 'niet nu');
      else await muteDecision(d.id, scope);
      drop(d.id);
      // Dempen kan méér kaarten sluiten (alles van deze klant); haal de lijst opnieuw op.
      if (scope !== 'card') void load();
    } catch (e) { fail(d.id, e); }
  }
  function open(d: AiDecision) {
    if (d.target && onOpenTarget) { onOpenTarget(d.target); return; }
    if (d.proposal && isFormBackedProposal(d.proposal)) openProposal(d.proposal, handlers);
  }

  const count = due.length;
  if (variant === 'dashboard' && (count === 0 || error)) return null;

  return (
    <section className={`ag-queue ag-queue-${variant} dc-feed`} aria-label="Beslissingen die Gerrie voor je klaarzette">
      <header className="ag-queue-head">
        <span className="ag-queue-mark" aria-hidden="true"><Sparkles size={16} /></span>
        <div className="ag-queue-titles">
          <h2>Te beslissen</h2>
          <p>
            {count === 0
              ? 'Niets te beslissen. Gerrie kijkt elke ochtend, en tussendoor bij nieuwe mail, notulen en offertes.'
              : `${count} kaart${count === 1 ? '' : 'en'} klaargezet uit wat er in de app gebeurde — Gerrie stelt voor, jij beslist.`}
          </p>
        </div>
        {count > 0 && <span className="ag-queue-count">{count}</span>}
        <button type="button" className="ag-queue-refresh" onClick={() => setTick((t) => t + 1)} title="Beslislijst verversen" aria-label="Beslislijst verversen">
          <RefreshCw size={14} className={loading ? 'ag-spin' : undefined} />
        </button>
      </header>

      {error && variant === 'page' && <p className="ag-queue-error"><AlertTriangle size={13} /> {error}</p>}

      {loading && count === 0 && !error
        ? <p className="ag-queue-empty">Beslislijst laden…</p>
        : count === 0 && !error
          ? <div className="ag-queue-zero">
              <span aria-hidden="true"><Check size={15} /></span>
              <div><strong>Niets te beslissen</strong>Zodra een offerte onbeantwoord blijft, notulen actiepunten bevatten of een klant mailt zonder dat iemand kijkt, staat het hier klaar.</div>
            </div>
          : <ul className="ag-queue-list">
              {due.map((d) => {
                const state = rowState[d.id] ?? 'idle';
                const Icon = KIND_ICON[d.kind] ?? ListChecks;
                const allowed = canWrite(d.module);
                const batch = d.proposal ? asBatchProposal(d.proposal) : null;
                const verb = d.proposal ? (d.severity === 'high' && d.proposal.type !== 'action' ? 'Definitief uitvoeren' : proposalVerb(d.proposal)) : 'Akkoord';
                const openable = Boolean(d.target && onOpenTarget) || Boolean(d.proposal && isFormBackedProposal(d.proposal));
                return (
                  <li key={d.id} className={`ag-queue-row dc-row dc-${d.origin}${state === 'error' ? ' is-error' : ''}${batch ? ' is-batch' : ''}`}>
                    <span className="dc-mark" aria-hidden="true" title={d.origin === 'gerrie' ? 'Gerrie beoordeelde dit signaal' : 'Regelkaart: volgt uit de gegevens'}>
                      {d.origin === 'gerrie' ? <Sparkles size={15} /> : <Icon size={15} />}
                    </span>
                    <div className="ag-queue-body">
                      <div className="ag-queue-what">
                        <span className="ag-queue-kind" aria-hidden="true"><Icon size={12} /></span>
                        <strong>{d.title}</strong>
                        {d.severity === 'high' && <span className="dc-sev">naar buiten</span>}
                      </div>
                      {d.summary && <p className="dc-summary">{d.summary}</p>}
                      {d.evidence.length > 0 && (
                        <ul className="dc-evidence" aria-label="Waarom">
                          {d.evidence.map((line, i) => <li key={i}>{line}</li>)}
                        </ul>
                      )}
                      <div className="ag-queue-meta">
                        <span className="ag-queue-agent">{d.origin === 'gerrie' ? 'Gerrie' : 'Regel'}</span>
                        <span className="ag-queue-when">{relativeTime(d.created_at)}</span>
                        {d.status === 'snoozed' && <span className="ag-queue-sub">teruggekomen uit Later</span>}
                      </div>
                      {state === 'error' && rowError[d.id] && <p className="ag-queue-rowerr"><AlertTriangle size={12} /> {rowError[d.id]}</p>}
                      {!allowed && !batch && <p className="ag-queue-rowhint">Je hebt geen schrijfrechten voor deze module — vraag een owner of admin.</p>}
                      {batch && (
                        <AgentBatchBoard
                          proposal={batch}
                          canWrite={allowed}
                          handlers={handlers}
                          onResolved={({ sent, skipped }) => {
                            void resolveDecision(d.id, sent > 0 ? 'done' : 'dismissed', null, `${sent} uitgevoerd, ${skipped} overgeslagen`)
                              .catch(() => { /* kaart blijft dan staan tot de volgende verversing */ });
                            drop(d.id);
                          }}
                        />
                      )}
                      {menu?.id === d.id && menu.kind === 'snooze' && (
                        <div className="dc-menu" role="group" aria-label="Later">
                          <button type="button" className="dc-chip" disabled={state === 'busy'} onClick={() => void snooze(d, snoozeUntil('afternoon'), 'vanmiddag')}>Vanmiddag</button>
                          <button type="button" className="dc-chip" disabled={state === 'busy'} onClick={() => void snooze(d, snoozeUntil('tomorrow'), 'morgen')}>Morgen</button>
                          <button type="button" className="dc-chip" disabled={state === 'busy'} onClick={() => void snooze(d, snoozeUntil('nextweek'), 'volgende week')}>Volgende week</button>
                          <button type="button" className="dc-chip" onClick={() => setMenu(null)}>Annuleren</button>
                        </div>
                      )}
                      {menu?.id === d.id && menu.kind === 'mute' && (
                        <div className="dc-menu" role="group" aria-label="Niet meer">
                          <button type="button" className="dc-chip" disabled={state === 'busy'} onClick={() => void dismiss(d, 'card')}>Alleen deze kaart</button>
                          {d.client_id && <button type="button" className="dc-chip" disabled={state === 'busy'} onClick={() => void dismiss(d, 'client')}>Alles van deze klant</button>}
                          <button type="button" className="dc-chip" disabled={state === 'busy'} onClick={() => void dismiss(d, 'kind')}>Dit soort kaarten</button>
                          <button type="button" className="dc-chip" onClick={() => setMenu(null)}>Annuleren</button>
                        </div>
                      )}
                    </div>
                    <div className="ag-queue-actions dc-actions">
                      <button type="button" className="ag-btn ag-btn-ghost" disabled={state === 'busy'} onClick={() => setMenu(menu?.id === d.id && menu.kind === 'snooze' ? null : { id: d.id, kind: 'snooze' })} title="Later terug laten komen">
                        <Clock size={13} /> Later
                      </button>
                      <button type="button" className="ag-btn ag-btn-ghost" disabled={state === 'busy'} onClick={() => setMenu(menu?.id === d.id && menu.kind === 'mute' ? null : { id: d.id, kind: 'mute' })} title="Deze kaart, deze klant of dit soort niet meer tonen">
                        <BellOff size={13} /> Niet meer
                      </button>
                      {openable && (
                        <button type="button" className="ag-btn ag-btn-ghost" disabled={state === 'busy'} onClick={() => open(d)}>
                          <ArrowRight size={13} /> Openen
                        </button>
                      )}
                      {!batch && d.proposal && (
                        <button type="button" className="ag-btn ag-btn-go" disabled={state === 'busy' || !allowed} onClick={() => void approve(d)}>
                          {state === 'busy' ? <><Loader2 size={13} className="ag-spin" /> Bezig…</> : <><Check size={13} /> {verb}</>}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>}

      {variant === 'page' && later.length > 0 && (
        <details className="dc-later">
          <summary><CalendarClock size={13} aria-hidden="true" /> Later ({later.length})</summary>
          <ul>
            {later.map((d) => (
              <li key={d.id}>
                <span><strong>{d.title}</strong> · komt terug {d.snoozed_until ? new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d.snoozed_until)) : 'later'}</span>
                <button type="button" className="ag-btn ag-btn-ghost" onClick={() => void resolveDecision(d.id, 'open').then(() => load()).catch((e) => fail(d.id, e))}><X size={12} /> Nu tonen</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {onOpenCommandCenter && (
        <button type="button" className="ag-queue-more" onClick={onOpenCommandCenter}>
          Naar de beslislijst <ChevronRight size={14} />
        </button>
      )}
    </section>
  );
}

/** "Vanmiddag" is 14:00 vandaag, of over drie uur als het al later is; "morgen" en "volgende week" om 08:00. */
export function snoozeUntil(option: 'afternoon' | 'tomorrow' | 'nextweek', now = new Date()): string {
  const d = new Date(now);
  if (option === 'afternoon') {
    d.setHours(14, 0, 0, 0);
    if (d.getTime() <= now.getTime()) d.setTime(now.getTime() + 3 * 3600000);
  } else if (option === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
  } else {
    const dow = d.getDay(); // 0 = zondag
    const add = ((8 - dow) % 7) || 7;
    d.setDate(d.getDate() + add);
    d.setHours(8, 0, 0, 0);
  }
  return d.toISOString();
}

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
