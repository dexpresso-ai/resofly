import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellOff, Check, Loader2, Play, RefreshCw, Sparkles } from 'lucide-react';
import { supabaseAuth } from '../lib/supabase';
import {
  DECISION_KIND_INFO, DEFAULT_SIGNAL_SETTINGS, deleteDecisionMute, evaluateSignalNow, listDecisionMutes, listQueuedSignals,
  loadSignalSettings, loadSignalStatus, runSweepNow, saveSignalSettings,
  type AiDecisionMute, type AiSignal, type AiSignalSettings, type DecisionKind, type SignalStatus,
} from '../lib/decisions-api';
import { Button } from './Ui';
import type { UUID } from '../types';

const KINDS = Object.keys(DECISION_KIND_INFO) as DecisionKind[];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Instellingen van de beslislijst (owner/admin): aan/uit, per soort, tijdstip
 * van de veegronde, wachttijden, de ruisrem, plus wat er wacht op rijping en
 * wat gedempt is. "Gerrie stelt voor, jij beslist" — ook hier: aanzetten maakt
 * de gebruiker die aanzet de actor (wiens tegoed en rechten Gerrie gebruikt).
 */
export function SignalSettingsPanel({ organizationId, canManage }: { organizationId: UUID; canManage: boolean }) {
  const [settings, setSettings] = useState<AiSignalSettings | null>(null);
  const [draft, setDraft] = useState<Omit<AiSignalSettings, 'organization_id'>>(DEFAULT_SIGNAL_SETTINGS);
  const [status, setStatus] = useState<SignalStatus | null>(null);
  const [mutes, setMutes] = useState<AiDecisionMute[]>([]);
  const [queued, setQueued] = useState<AiSignal[]>([]);
  const [busy, setBusy] = useState<'save' | 'sweep' | string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [s, m, q] = await Promise.all([
      loadSignalSettings(organizationId).catch(() => null),
      listDecisionMutes(organizationId).catch(() => [] as AiDecisionMute[]),
      listQueuedSignals(organizationId).catch(() => [] as AiSignal[]),
    ]);
    setSettings(s);
    setDraft(s ? { ...DEFAULT_SIGNAL_SETTINGS, ...s, kinds: s.kinds ?? {} } : DEFAULT_SIGNAL_SETTINGS);
    setMutes(m);
    setQueued(q);
    if (canManage) loadSignalStatus(organizationId).then(setStatus).catch(() => setStatus(null));
  }, [organizationId, canManage]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { supabaseAuth.getUser().then(({ data }) => setUserId(data.user?.id ?? null)).catch(() => setUserId(null)); }, []);

  function kindOn(kind: DecisionKind): boolean { return draft.kinds[kind] !== false; }

  async function save(patch: Partial<Omit<AiSignalSettings, 'organization_id'>> = {}) {
    setBusy('save'); setMessage(null);
    try {
      const next = { ...draft, ...patch };
      // Aanzetten zonder actor: wie aanzet wordt de actor — zijn tegoed, zijn rechten.
      if (next.enabled && !next.actor_user_id && userId) next.actor_user_id = userId;
      const saved = await saveSignalSettings(organizationId, {
        enabled: next.enabled, actor_user_id: next.actor_user_id, kinds: next.kinds, digest_hour: next.digest_hour,
        timezone: next.timezone, quote_follow_up_days: next.quote_follow_up_days, contract_follow_up_days: next.contract_follow_up_days,
        max_gerrie_cards_per_day: next.max_gerrie_cards_per_day,
      });
      setSettings(saved);
      setDraft({ ...DEFAULT_SIGNAL_SETTINGS, ...saved, kinds: saved.kinds ?? {} });
      setMessage({ tone: 'ok', text: saved.enabled ? 'Opgeslagen. Gerrie kijkt binnen een minuut voor het eerst rond.' : 'Opgeslagen.' });
      void reload();
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Opslaan mislukt.' });
    } finally { setBusy(null); }
  }

  async function sweep() {
    setBusy('sweep'); setMessage(null);
    try {
      const r = await runSweepNow(organizationId);
      setMessage({ tone: 'ok', text: `Veegronde klaar: ${r.signals} nieuw${r.signals === 1 ? '' : 'e'} signa${r.signals === 1 ? 'al' : 'len'}, ${r.expired} kaart${r.expired === 1 ? '' : 'en'} verlopen, ${r.open} open.` });
      void reload();
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Veegronde mislukt.' });
    } finally { setBusy(null); }
  }

  async function evaluate(signal: AiSignal) {
    setBusy(signal.id); setMessage(null);
    try {
      const r = await evaluateSignalNow(organizationId, signal.id);
      setMessage({ tone: r.outcome === 'card' ? 'ok' : 'err', text: r.outcome === 'card' ? 'Kaart gemaakt — hij staat bovenaan.' : `${r.outcome === 'skipped' ? 'Overgeslagen' : 'Mislukt'}: ${r.reason ?? 'zonder reden'}` });
      void reload();
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Beoordelen mislukt.' });
    } finally { setBusy(null); }
  }

  async function unmute(m: AiDecisionMute) {
    setBusy(m.id);
    try { await deleteDecisionMute(m.id); void reload(); }
    catch (e) { setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Opheffen mislukt.' }); }
    finally { setBusy(null); }
  }

  const enabled = draft.enabled;

  return (
    <section className="dc-settings" aria-label="Instellingen van de beslislijst">
      <header className="dc-settings-head">
        <div>
          <h3><Sparkles size={15} aria-hidden="true" /> Gerrie signaleert</h3>
          <p className="hint">Gerrie kijkt naar wat er in de app gebeurt en zet kaarten klaar. <b>Gerrie stelt voor, jij beslist.</b> Niets wordt verstuurd of aangemaakt zonder jouw klik.</p>
        </div>
        {canManage && (
          <label className="dc-switch">
            <input type="checkbox" checked={enabled} disabled={busy === 'save'} onChange={(e) => void save({ enabled: e.target.checked })} />
            <span>{enabled ? 'Aan' : 'Uit'}</span>
          </label>
        )}
      </header>

      {!canManage && <p className="hint">Alleen een owner of admin kan de beslislijst instellen. Hij staat nu {settings?.enabled ? 'aan' : 'uit'}.</p>}

      {message && <p className={`dc-msg ${message.tone === 'ok' ? 'is-ok' : 'is-err'}`}>{message.tone === 'ok' ? <Check size={13} /> : <AlertTriangle size={13} />} {message.text}</p>}

      {canManage && (
        <>
          <div className="dc-status">
            <span>Laatste veegronde: <b>{status?.last_sweep_at ? fmt(status.last_sweep_at) : 'nog nooit'}</b></span>
            <span>Volgende: <b>{status?.next_sweep_at ? fmt(status.next_sweep_at) : (enabled ? 'zo meteen' : '—')}</b></span>
            <span>Wacht op rijping: <b>{status?.queued ?? queued.length}</b></span>
            <span>Gerrie-kaarten vandaag: <b>{status?.gerrie_today ?? 0} / {draft.max_gerrie_cards_per_day}</b></span>
            {status?.budget_blocked_at && <span className="is-warn"><AlertTriangle size={12} /> Het maandtegoed van de actor is op; Gerrie-kaarten wachten tot volgende maand. Regelkaarten lopen door.</span>}
            {enabled && <Button variant="ghost" disabled={busy === 'sweep'} onClick={() => void sweep()}>{busy === 'sweep' ? <Loader2 size={13} className="ag-spin" /> : <RefreshCw size={13} />} Nu rondkijken</Button>}
          </div>

          <div>
            <h4>Welke kaarten</h4>
            <div className="dc-kinds">
              {KINDS.map((kind) => {
                const info = DECISION_KIND_INFO[kind];
                return (
                  <label key={kind} className="dc-kind">
                    <input type="checkbox" checked={kindOn(kind)} disabled={busy === 'save'}
                      onChange={(e) => setDraft((d) => ({ ...d, kinds: { ...d.kinds, [kind]: e.target.checked } }))} />
                    <span>
                      <b>{info.label}<span className={`dc-tag${info.origin === 'gerrie' ? ' is-gerrie' : ''}`}>{info.origin === 'gerrie' ? 'Gerrie' : 'regel'}</span></b>
                      <span>{info.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="dc-fields">
            <label>Veegronde en dagelijkse melding om
              <select className="form-input" value={draft.digest_hour} onChange={(e) => setDraft((d) => ({ ...d, digest_hour: Number(e.target.value) }))}>
                {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </label>
            <label>Opvolgmail offerte na (dagen)
              <input className="form-input" type="number" min={1} max={14} value={draft.quote_follow_up_days} onChange={(e) => setDraft((d) => ({ ...d, quote_follow_up_days: clamp(e.target.value, 1, 14, 3) }))} />
            </label>
            <label>Herinnering contract na (dagen)
              <input className="form-input" type="number" min={1} max={30} value={draft.contract_follow_up_days} onChange={(e) => setDraft((d) => ({ ...d, contract_follow_up_days: clamp(e.target.value, 1, 30, 7) }))} />
            </label>
            <label>Hoogstens Gerrie-kaarten per dag
              <input className="form-input" type="number" min={1} max={50} value={draft.max_gerrie_cards_per_day} onChange={(e) => setDraft((d) => ({ ...d, max_gerrie_cards_per_day: clamp(e.target.value, 1, 50, 10) }))} />
            </label>
          </div>
          <p className="hint">Gerrie-kaarten draaien op het zuinige model onder het maandtegoed van {settings?.actor_user_id === userId ? 'jou' : 'de owner of admin die de lijst aanzette'}. Regelkaarten kosten geen tegoed. De dagcap is een rem op ruis, geen budget.</p>
          <div className="dc-actions-row">
            <Button disabled={busy === 'save'} onClick={() => void save()}>{busy === 'save' ? <Loader2 size={13} className="ag-spin" /> : <Check size={13} />} Opslaan</Button>
          </div>

          {mutes.length > 0 && (
            <div>
              <h4><BellOff size={13} aria-hidden="true" /> Gedempt</h4>
              <ul className="dc-list">
                {mutes.map((m) => (
                  <li key={m.id}>
                    <span>{muteLabel(m)}</span>
                    <Button variant="ghost" disabled={busy === m.id} onClick={() => void unmute(m)}>Opheffen</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {queued.length > 0 && (
            <details className="dc-debug">
              <summary>Wacht op rijping ({queued.length})</summary>
              <ul className="dc-list">
                {queued.map((s) => (
                  <li key={s.id}>
                    <span><b>{DECISION_KIND_INFO[s.kind]?.label ?? s.kind}</b> · rijpt {fmt(s.due_at)}{s.status === 'claimed' ? ' · in behandeling' : ''}{s.reason ? ` · ${s.reason}` : ''}</span>
                    <Button variant="ghost" disabled={busy === s.id} onClick={() => void evaluate(s)}>{busy === s.id ? <Loader2 size={13} className="ag-spin" /> : <Play size={13} />} Nu beoordelen</Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}
function clamp(v: string, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function muteLabel(m: AiDecisionMute): string {
  const until = m.until ? ` tot ${fmt(m.until)}` : '';
  if (m.scope === 'kind') return `Dit soort kaarten: ${m.kind ? (DECISION_KIND_INFO[m.kind]?.label ?? m.kind) : '?'}${until}`;
  if (m.scope === 'client') return `Alles van één klant${until}`;
  return `Eén item (${m.entity_type || 'onbekend'})${until}`;
}
