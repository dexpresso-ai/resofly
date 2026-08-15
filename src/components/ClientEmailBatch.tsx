import { useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Loader2, Mail, UserX, X } from 'lucide-react';
import type { GerrieClientEmailItem, GerrieSendClientEmailProposal } from '../lib/gerrie-api';

/**
 * Een reeks klantmails die een agent heeft klaargezet — mail voor mail af te vinken.
 *
 * Dit is het scherm waar echte post naar echte klanten gaat, dus de vorm volgt de
 * verantwoordelijkheid: je ziet per mail de ontvanger, het onderwerp en de VOLLEDIGE
 * tekst (bij twee of minder mails meteen opengeklapt), en je zet er zelf een vinkje
 * bij. Wat je uitvinkt gaat niet weg en verdwijnt als "overgeslagen".
 *
 * Pas als élke mail een uitkomst heeft — verstuurd of overgeslagen — meldt de
 * component dat terug via `onResolved`; dán mag de aanroeper de rij uit de wachtrij
 * halen. Een half afgehandelde reeks blijft dus staan.
 */

type ItemState = 'open' | 'busy' | 'sent' | 'skipped' | 'error';

export function ClientEmailBatch({ proposal, canWrite, onSendOne, onResolved, disabled = false }: {
  proposal: GerrieSendClientEmailProposal;
  canWrite: boolean;
  onSendOne: (item: GerrieClientEmailItem) => Promise<void>;
  /** Vuurt één keer, zodra alle mails verstuurd of overgeslagen zijn. */
  onResolved: (outcome: { sent: number; skipped: number; failed: number }) => void;
  disabled?: boolean;
}) {
  const items = proposal.items;
  const [state, setState] = useState<ItemState[]>(() => items.map(() => 'open'));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<boolean[]>(() => items.map(() => true));
  // Bij twee mails lees je ze gewoon; bij tien wil je eerst het overzicht.
  const [openText, setOpenText] = useState<Record<number, boolean>>(() =>
    items.length <= 2 ? Object.fromEntries(items.map((_, i) => [i, true])) : {});
  const [running, setRunning] = useState(false);

  const counts = useMemo(() => ({
    sent: state.filter((s) => s === 'sent').length,
    skipped: state.filter((s) => s === 'skipped').length,
    failed: state.filter((s) => s === 'error').length,
    open: state.filter((s) => s === 'open' || s === 'busy').length,
  }), [state]);

  const pickedOpen = state.reduce((n, s, i) => n + (s === 'open' && picked[i] ? 1 : 0), 0);

  function settle(next: ItemState[]) {
    setState(next);
    // 'error' telt als onafgehandeld: die mail staat er nog, je kunt hem opnieuw
    // proberen of alsnog wegstrepen.
    if (next.every((s) => s === 'sent' || s === 'skipped')) {
      onResolved({
        sent: next.filter((s) => s === 'sent').length,
        skipped: next.filter((s) => s === 'skipped').length,
        failed: 0,
      });
    }
  }

  async function sendPicked() {
    if (running) return;
    setRunning(true);
    const next = [...state];
    for (let i = 0; i < items.length; i += 1) {
      if (next[i] !== 'open' || !picked[i]) continue;
      next[i] = 'busy';
      setState([...next]);
      try {
        await onSendOne(items[i]);
        next[i] = 'sent';
        setErrors((e) => { const c = { ...e }; delete c[i]; return c; });
      } catch (err) {
        next[i] = 'error';
        const msg = err instanceof Error ? err.message : 'Versturen mislukt.';
        setErrors((e) => ({ ...e, [i]: msg }));
      }
      setState([...next]);
    }
    setRunning(false);
    settle(next);
  }

  function skipOne(index: number) {
    const next = [...state];
    next[index] = 'skipped';
    settle(next);
  }

  function retry(index: number) {
    const next = [...state];
    next[index] = 'open';
    setState(next);
  }

  function skipAllOpen() {
    settle(state.map((s) => (s === 'open' || s === 'error' ? 'skipped' : s)));
  }

  return (
    <div className="cem">
      <div className="cem-lead">
        <Mail size={13} aria-hidden="true" />
        <span>
          {proposal.origin === 'template'
            ? 'Jouw vaste tekst, per klant ingevuld.'
            : 'Door je agent geschreven — lees hem na voordat je akkoord geeft.'}
        </span>
      </div>

      {proposal.skipped.length > 0 && (
        <p className="cem-skipped"><UserX size={12} /> Geen e-mailadres bekend: {proposal.skipped.join(', ')}</p>
      )}

      <ul className="cem-list">
        {items.map((item, i) => {
          const s = state[i];
          const done = s === 'sent' || s === 'skipped';
          const showText = openText[i] === true;
          return (
            <li key={`${item.client_id}-${i}`} className={`cem-item is-${s}`}>
              <div className="cem-row">
                <label className="cem-pick">
                  <input
                    type="checkbox"
                    checked={s === 'sent' ? true : s === 'skipped' ? false : picked[i]}
                    disabled={done || running || disabled || !canWrite}
                    onChange={() => setPicked((p) => p.map((v, x) => (x === i ? !v : v)))}
                  />
                </label>
                <div className="cem-who">
                  <strong>{item.client_name || item.recipient_email}</strong>
                  <span>{item.recipient_email}</span>
                </div>
                <div className="cem-subject">{item.subject}</div>
                <span className="cem-status">
                  {s === 'busy' && <><Loader2 size={12} className="ag-spin" /> Versturen…</>}
                  {s === 'sent' && <><Check size={12} /> Verstuurd</>}
                  {s === 'skipped' && <>Overgeslagen</>}
                  {s === 'error' && <><AlertTriangle size={12} /> Mislukt</>}
                </span>
                <button
                  type="button"
                  className="cem-toggle"
                  aria-expanded={showText}
                  onClick={() => setOpenText((o) => ({ ...o, [i]: !showText }))}
                >
                  {showText ? <>Tekst verbergen <ChevronUp size={12} /></> : <>Tekst lezen <ChevronDown size={12} /></>}
                </button>
              </div>

              {showText && <div className="cem-body">{item.body}</div>}
              {s === 'error' && errors[i] && (
                <div className="cem-error">
                  <span><AlertTriangle size={12} /> {errors[i]}</span>
                  <span className="cem-error-actions">
                    <button type="button" className="ag-btn ag-btn-ghost" onClick={() => retry(i)}>Opnieuw proberen</button>
                    <button type="button" className="ag-btn ag-btn-ghost" onClick={() => skipOne(i)}>Toch overslaan</button>
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="cem-foot">
        <span className="cem-tally">{[
          counts.sent > 0 ? `${counts.sent} verstuurd` : '',
          counts.failed > 0 ? `${counts.failed} mislukt` : '',
          counts.skipped > 0 ? `${counts.skipped} overgeslagen` : '',
          counts.open > 0 ? `${counts.open} nog te beslissen` : '',
        ].filter(Boolean).join(' · ')}</span>
        <button type="button" className="ag-btn ag-btn-ghost" disabled={running || disabled} onClick={skipAllOpen}>
          <X size={13} /> De rest overslaan
        </button>
        <button
          type="button"
          className="ag-btn ag-btn-go"
          disabled={running || disabled || !canWrite || pickedOpen === 0}
          onClick={() => void sendPicked()}
        >
          {running
            ? <><Loader2 size={13} className="ag-spin" /> Bezig…</>
            : <><Check size={13} /> {pickedOpen === 1 ? 'Verstuur deze mail' : `Verstuur ${pickedOpen} mailtjes`}</>}
        </button>
      </div>
      {!canWrite && <p className="cem-nowrite">Je hebt geen schrijfrechten voor klantmail — vraag een owner of admin.</p>}
    </div>
  );
}
