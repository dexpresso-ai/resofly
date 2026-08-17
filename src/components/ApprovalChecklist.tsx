import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, CheckSquare, ChevronDown, ChevronUp, Loader2, Square, X } from 'lucide-react';

/**
 * De afvinklijst — het scherm waar een reeks van een agent mens voor mens,
 * factuur voor factuur wordt afgehandeld.
 *
 * Een agent zet dingen KLAAR; wat er daadwerkelijk de deur uit gaat bepaal jij.
 * Eén knop onder een stapel post zou die belofte breken, dus staat er per regel
 * een vinkje: aan = versturen, uit = laten liggen. Met de knop bovenaan zet je
 * ze in één klik allemaal aan of uit, zodat "alles behalve die ene" net zo snel
 * gaat als "alleen die ene".
 *
 * Elke regel wordt APART verstuurd. Mislukt er één, dan blijft die staan met de
 * foutmelding erbij en gaan de andere gewoon door — je blijft nooit half
 * verstuurd achter zonder te weten waar het misging.
 *
 * Pas als élke regel een uitkomst heeft (verstuurd of overgeslagen) meldt de
 * component dat via `onResolved`; dán mag de aanroeper de rij uit de wachtrij
 * halen. Een half afgehandelde reeks blijft dus staan.
 */

type ItemState = 'open' | 'busy' | 'sent' | 'skipped' | 'error';

export interface ChecklistItem {
  /** Stabiele sleutel binnen deze lijst (bv. het factuur-id). */
  key: string;
  /** De hoofdregel: klantnaam, of het nummer van het document. */
  title: string;
  /** Onder de hoofdregel: het e-mailadres waar het heen gaat. */
  subtitle?: string;
  /** In het midden: het onderwerp, of waar het document over gaat. */
  meta?: string;
  /** Rechts: bedrag, niveau, dagen te laat — waar je op beslist. */
  badge?: string;
  /** Uitklapbare inhoud (bijvoorbeeld de volledige mailtekst). */
  detail?: ReactNode;
  /** Label van de uitklapknop; standaard "Details". */
  detailLabel?: string;
}

export function ApprovalChecklist({
  items, canWrite, sendOne, onResolved,
  lead, skippedNote, sendLabel = 'Verstuur', unitLabel = 'regel', unitLabelPlural = 'regels',
  openDetailsUpTo = 0, disabled = false, noWriteHint = 'Je hebt geen schrijfrechten voor deze actie — vraag een owner of admin.',
}: {
  items: ChecklistItem[];
  canWrite: boolean;
  /** Handelt ÉÉN regel af. Gooit een fout als het misging. */
  sendOne: (item: ChecklistItem, index: number) => Promise<void>;
  /** Vuurt één keer, zodra elke regel verstuurd of overgeslagen is. */
  onResolved: (outcome: { sent: number; skipped: number; failed: number }) => void;
  /** Eén regel context boven de lijst. */
  lead?: ReactNode;
  /** Wat er buiten de lijst viel (en waarom). */
  skippedNote?: ReactNode;
  sendLabel?: string;
  unitLabel?: string;
  unitLabelPlural?: string;
  /** Klap de details meteen uit als de lijst hoogstens zo lang is. */
  openDetailsUpTo?: number;
  disabled?: boolean;
  noWriteHint?: string;
}) {
  const [state, setState] = useState<ItemState[]>(() => items.map(() => 'open'));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<boolean[]>(() => items.map(() => true));
  // Bij twee mails lees je ze gewoon; bij tien wil je eerst het overzicht.
  const [openDetail, setOpenDetail] = useState<Record<number, boolean>>(() =>
    items.length <= openDetailsUpTo ? Object.fromEntries(items.map((_, i) => [i, true])) : {});
  const [running, setRunning] = useState(false);

  const counts = useMemo(() => ({
    sent: state.filter((s) => s === 'sent').length,
    skipped: state.filter((s) => s === 'skipped').length,
    failed: state.filter((s) => s === 'error').length,
    open: state.filter((s) => s === 'open' || s === 'busy').length,
  }), [state]);

  const pickedOpen = state.reduce((n, s, i) => n + (s === 'open' && picked[i] ? 1 : 0), 0);
  const stillOpen = state.reduce((n, s) => n + (s === 'open' ? 1 : 0), 0);
  const allPicked = stillOpen > 0 && pickedOpen === stillOpen;

  function settle(next: ItemState[]) {
    setState(next);
    // 'error' telt als onafgehandeld: die regel staat er nog, je kunt hem opnieuw
    // proberen of alsnog wegstrepen.
    if (next.every((s) => s === 'sent' || s === 'skipped')) {
      onResolved({
        sent: next.filter((s) => s === 'sent').length,
        skipped: next.filter((s) => s === 'skipped').length,
        failed: 0,
      });
    }
  }

  /** Alles aan, of — als alles al aan stond — alles uit. Alleen wat nog openstaat. */
  function toggleAll() {
    const target = !allPicked;
    setPicked((p) => p.map((v, i) => (state[i] === 'open' ? target : v)));
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
        await sendOne(items[i], i);
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
      {lead && <div className="cem-lead">{lead}</div>}
      {skippedNote}

      {stillOpen > 1 && (
        <div className="cem-all">
          <button
            type="button"
            className="cem-allbtn"
            disabled={running || disabled || !canWrite}
            onClick={toggleAll}
            aria-pressed={allPicked}
          >
            {allPicked ? <CheckSquare size={13} /> : <Square size={13} />}
            {allPicked ? 'Alles uitvinken' : 'Alles aanvinken'}
          </button>
          <span className="cem-allcount">{pickedOpen} van {stillOpen} aangevinkt</span>
        </div>
      )}

      <ul className="cem-list">
        {items.map((item, i) => {
          const s = state[i];
          const done = s === 'sent' || s === 'skipped';
          const showDetail = openDetail[i] === true;
          return (
            <li key={item.key} className={`cem-item is-${s}`}>
              <div className="cem-row">
                <label className="cem-pick">
                  <input
                    type="checkbox"
                    checked={s === 'sent' ? true : s === 'skipped' ? false : picked[i]}
                    disabled={done || running || disabled || !canWrite}
                    onChange={() => setPicked((p) => p.map((v, x) => (x === i ? !v : v)))}
                    aria-label={`${item.title} meenemen`}
                  />
                </label>
                <div className="cem-who">
                  <strong>{item.title}</strong>
                  {item.subtitle && <span>{item.subtitle}</span>}
                </div>
                {item.meta && <div className="cem-subject">{item.meta}</div>}
                {item.badge && <span className="cem-badge">{item.badge}</span>}
                <span className="cem-status">
                  {s === 'busy' && <><Loader2 size={12} className="ag-spin" /> Versturen…</>}
                  {s === 'sent' && <><Check size={12} /> Verstuurd</>}
                  {s === 'skipped' && <>Overgeslagen</>}
                  {s === 'error' && <><AlertTriangle size={12} /> Mislukt</>}
                </span>
                {item.detail && (
                  <button
                    type="button"
                    className="cem-toggle"
                    aria-expanded={showDetail}
                    onClick={() => setOpenDetail((o) => ({ ...o, [i]: !showDetail }))}
                  >
                    {showDetail
                      ? <>{item.detailLabel ?? 'Details'} verbergen <ChevronUp size={12} /></>
                      : <>{item.detailLabel ?? 'Details'} <ChevronDown size={12} /></>}
                  </button>
                )}
              </div>

              {/* Een afgehandelde regel mag je niet meer bewerken: de mail is weg of
                  bewust overgeslagen, en een invulveld zou suggereren dat het nog
                  ergens toe leidt. Een uitgeschakelde fieldset vergrendelt in één
                  keer alles wat erin staat. */}
              {showDetail && item.detail && (
                <fieldset className="cem-body" disabled={done || running}>{item.detail}</fieldset>
              )}
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
            : <><Check size={13} /> {sendLabel} {pickedOpen} {pickedOpen === 1 ? unitLabel : unitLabelPlural}</>}
        </button>
      </div>
      {!canWrite && <p className="cem-nowrite">{noWriteHint}</p>}
    </div>
  );
}
