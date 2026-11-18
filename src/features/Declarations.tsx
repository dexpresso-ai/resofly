import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReceiptText, RefreshCw } from 'lucide-react';
import type { Declaration } from '../types';
import { PageIcon } from '../components/PageIcon';
import { Button, Skeleton } from '../components/Ui';
import { ReceiptCapture } from '../components/ReceiptCapture';
import { dateNL, euro } from '../lib/format';
import { listMyDeclarations } from '../lib/repository';
import { readableError } from '../lib/networkRetry';
import { DECLARATION_STATUS_HINTS, DECLARATION_STATUS_LABELS, splitDeclarations } from '../lib/receipts';

/**
 * Declaraties (2026-11-17): voor teamleden die Financiën niet mogen bewerken.
 *
 * Je fotografeert een bon die je zelf hebt betaald; Gerrie leest hem en hij
 * komt bij Financiën als concept dat iemand goedkeurt. Hier zie je je eigen
 * declaraties en hoe het ermee staat: ingediend, goedgekeurd, uitbetaald of
 * afgewezen (met de reden).
 *
 * Alleen je eigen bonnen, en dat bewaakt de database: de lijst komt uit
 * list_my_declarations, die filtert op wie er is ingelogd. De factuur-inbox
 * en de inkoopfacturen zelf blijven achter de module Financiën.
 */
export function DeclarationsPage({ organizationId, canWrite }: { organizationId: string; canWrite: boolean }) {
  const [items, setItems] = useState<Declaration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDone, setShowDone] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listMyDeclarations(organizationId));
      setError(null);
    } catch (e) {
      setError(readableError(e, 'Je declaraties laden mislukte.'));
      setItems(prev => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  // Zolang Gerrie nog leest, af en toe opnieuw kijken. Een goedkeuring kan
  // uren duren; daarvoor is er de melding en de knop Vernieuwen.
  const reading = (items ?? []).some(d => d.status === 'processing');
  useEffect(() => {
    if (!reading) return undefined;
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [reading, load]);

  const { open, done } = useMemo(() => splitDeclarations(items ?? []), [items]);
  const openTotal = open.reduce((sum, d) => sum + (d.currency === 'EUR' ? d.total_cents ?? 0 : 0), 0);

  return (
    <div className="bk-page decl-page">
      <div className="bk-head">
        <div>
          <PageIcon page="declarations" />
          <h2>Declaraties</h2>
          <p>Kosten die je zelf hebt voorgeschoten. Fotografeer de bon: Gerrie leest hem, en iemand van Financiën keurt hem goed.</p>
        </div>
        <div className="bk-head-actions">
          <Button onClick={() => void load()} disabled={loading} title="Opnieuw laden"><RefreshCw size={15} /> Vernieuwen</Button>
        </div>
      </div>

      <section className="decl-hero">
        <div className="decl-hero-text">
          <span className="decl-hero-icon" aria-hidden="true"><ReceiptText size={22} /></span>
          <div>
            <b>Nieuwe declaratie</b>
            <span>Leg de bon plat neer, met de hele bon in beeld. Een pdf of een foto uit je galerij kan ook.</span>
          </div>
        </div>
        <ReceiptCapture organizationId={organizationId} mode="declaration" disabled={!canWrite} onChanged={() => void load()} />
      </section>

      {error && <div className="error">{error}</div>}

      {items === null
        ? <Skeleton lines={3} />
        : items.length === 0
          ? <div className="empty">
              <div className="e-big">Nog geen declaraties</div>
              <p>Fotografeer een bon om je eerste declaratie in te dienen. Je ziet hier alleen je eigen declaraties.</p>
            </div>
          : <>
              {open.length > 0 && <section className="decl-section">
                <h3>Ingediend <span className="bk-muted">· {open.length}{openTotal ? ` · ${euro(openTotal / 100)}` : ''}</span></h3>
                <ul className="decl-list">{open.map(d => <DeclarationRow key={d.id} declaration={d} />)}</ul>
              </section>}
              {done.length > 0 && <section className="decl-section">
                <h3>
                  Afgehandeld <span className="bk-muted">· {done.length}</span>
                  <button type="button" className="bk-link-button" onClick={() => setShowDone(v => !v)}>{showDone ? 'Verbergen' : 'Tonen'}</button>
                </h3>
                {showDone && <ul className="decl-list">{done.map(d => <DeclarationRow key={d.id} declaration={d} />)}</ul>}
              </section>}
              <p className="bk-muted decl-privacy">Je ziet hier alleen je eigen declaraties.</p>
            </>}
    </div>
  );
}

function DeclarationRow({ declaration: d }: { declaration: Declaration }) {
  const amount = d.total_cents != null ? `${d.currency !== 'EUR' ? `${d.currency} ` : ''}${euro(d.total_cents / 100)}` : null;
  return (
    <li className={`decl-row is-${d.status}`}>
      <div className="decl-row-main">
        <b>{d.store_name || (d.status === 'processing' ? 'Wordt gelezen…' : 'Bon')}</b>
        <span className="decl-row-meta">
          {d.receipt_date ? dateNL(d.receipt_date) : `ingediend ${dateNL(d.submitted_at.slice(0, 10))}`}
          {d.file_name ? ` · ${d.file_name}` : ''}
        </span>
        {d.status === 'rejected' && d.review_note
          ? <span className="decl-row-note">Afgewezen: {d.review_note}</span>
          : <span className="decl-row-note">{DECLARATION_STATUS_HINTS[d.status]}</span>}
      </div>
      <div className="decl-row-side">
        {amount && <span className="decl-row-amount">{amount}</span>}
        <span className={`decl-status decl-status-${d.status}`}>{DECLARATION_STATUS_LABELS[d.status]}</span>
        {d.decided_at && (d.status === 'approved' || d.status === 'rejected' || d.status === 'paid') && <small className="bk-muted">{dateNL(d.decided_at.slice(0, 10))}</small>}
      </div>
    </li>
  );
}
