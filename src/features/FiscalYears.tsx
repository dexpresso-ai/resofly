import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarClock, Lock, Plus, Unlock } from 'lucide-react';
import type { AppData, FiscalYearListRow } from '../types';
import { Button, Skeleton } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { closeFiscalYear, ensureDefaultLedgerAccounts, listFiscalYears, openFiscalYear, reopenFiscalYear } from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(year, month, 0).getDate();

/**
 * Einde van het boekjaar (uitgelijnd op de boekjaar-startmaand) dat de begindatum
 * bevat: de dag vóór de eerstvolgende boekjaarstart. Zo valt een geopend boekjaar
 * altijd samen met de "Jaar"-grens in Winst & verlies (fiscalYearBounds). Een
 * begindatum die niet op de 1e van de startmaand valt (go-live midden in het jaar)
 * levert een verkort eerste boekjaar op dat toch op de jaargrens eindigt.
 */
function endOfFiscalYear(start: string, startMonth: number): string {
  const [y, m] = start.split('-').map(Number);
  const fyStartYear = m >= startMonth ? y : y - 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? fyStartYear : fyStartYear + 1;
  return `${endYear}-${pad2(endMonth)}-${pad2(lastDay(endYear, endMonth))}`;
}

/** Voorstel voor het eerstvolgende nieuwe boekjaar (uitgelijnd op de startmaand). */
function nextRangeSuggestion(rows: FiscalYearListRow[], startMonth: number, bookkeepingStart: string | null): { start: string; end: string } {
  if (rows.length > 0) {
    // Rijen komen aflopend binnen; het laatste (nieuwste) boekjaar staat vooraan.
    const latestEnd = rows.reduce((max, r) => (r.period_end > max ? r.period_end : max), rows[0].period_end);
    const d = new Date(`${latestEnd}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const start = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return { start, end: endOfFiscalYear(start, startMonth) };
  }
  const now = new Date();
  const start = bookkeepingStart ?? `${now.getFullYear()}-${pad2(startMonth)}-01`;
  return { start, end: endOfFiscalYear(start, startMonth) };
}

function SetupBanner({ organizationId, onChanged }: { organizationId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function setup() {
    setBusy(true); setError(null);
    try { await ensureDefaultLedgerAccounts(organizationId); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Aanmaken mislukt'); }
    finally { setBusy(false); }
  }
  return (
    <div className="bk-setup">
      <div><strong>Boekhouding nog niet ingericht.</strong><p>Maak eerst het rekeningschema aan (tabblad Grootboek).</p>{error && <p className="error">{error}</p>}</div>
      <Button variant="primary" disabled={busy} onClick={setup}>{busy ? 'Bezig…' : 'Rekeningschema aanmaken'}</Button>
    </div>
  );
}

export function FiscalYearsPage({ data, organizationId, canWrite, canAdmin, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; canAdmin: boolean; onChanged: () => void;
}) {
  const [rows, setRows] = useState<FiscalYearListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<FiscalYearListRow | null>(null);
  const [confirmReopen, setConfirmReopen] = useState<FiscalYearListRow | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');

  const startMonth = data.companySettings?.fiscal_year_start_month ?? 1;
  const resultCode = data.companySettings?.year_result_account_code ?? '0510';
  const resultLabel = resultCode === '0500' ? '0500 · Eigen vermogen' : '0510 · Onverdeeld resultaat';

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setRows(await listFiscalYears(organizationId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Boekjaren laden mislukt'); }
    finally { setLoading(false); }
  }, [organizationId]);

  useEffect(() => { if (data.ledgerAccounts.length > 0) void load(); }, [load, data.ledgerAccounts.length]);

  const hasOpenYear = useMemo(() => rows.some(r => r.status === 'open'), [rows]);

  function startNewYear() {
    const s = nextRangeSuggestion(rows, startMonth, data.companySettings?.bookkeeping_start_date ?? null);
    setNewStart(s.start); setNewEnd(s.end); setActionError(null); setShowNew(true);
  }

  async function submitNewYear() {
    setBusyId('new'); setActionError(null);
    try {
      await openFiscalYear(organizationId, { periodStart: newStart, periodEnd: newEnd });
      setShowNew(false);
      await load(); onChanged();
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Openen mislukt'); }
    finally { setBusyId(null); }
  }

  async function doClose(row: FiscalYearListRow) {
    setBusyId(row.id); setActionError(null);
    try {
      await closeFiscalYear(organizationId, row.id);
      setConfirmClose(null);
      await load(); onChanged();
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Afsluiten mislukt'); }
    finally { setBusyId(null); }
  }

  async function doReopen(row: FiscalYearListRow) {
    setBusyId(row.id); setActionError(null);
    try {
      await reopenFiscalYear(organizationId, row.id);
      setConfirmReopen(null);
      await load(); onChanged();
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Heropenen mislukt'); }
    finally { setBusyId(null); }
  }

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} onChanged={onChanged} /></div>;
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div>
          <h2>Boekjaren</h2>
          <p>Open een nieuw boekjaar, sluit een lopend boekjaar af (resultaat naar {resultLabel}) en bekijk voorgaande jaren.</p>
        </div>
        {canWrite && <Button variant="primary" onClick={startNewYear}><Plus size={14} /> Nieuw boekjaar openen</Button>}
      </div>

      {error && <div className="error">{error}</div>}
      {actionError && <div className="error">{actionError}</div>}

      {showNew && (
        <div className="bk-fy-new">
          <div className="bk-fy-new-fields">
            <label><span>Begindatum</span><input type="date" className="form-input" value={newStart} onChange={e => { const v = e.target.value; setNewStart(v); if (v) setNewEnd(endOfFiscalYear(v, startMonth)); }} /></label>
            <label><span>Einddatum</span><input type="date" className="form-input" value={newEnd} onChange={e => setNewEnd(e.target.value)} /></label>
          </div>
          <div className="bk-fy-new-actions">
            <Button variant="ghost" onClick={() => setShowNew(false)}>Annuleren</Button>
            <Button variant="primary" disabled={busyId === 'new' || !newStart || !newEnd} onClick={submitNewYear}>{busyId === 'new' ? 'Bezig…' : 'Boekjaar openen'}</Button>
          </div>
        </div>
      )}

      {loading ? <div className="bk-muted bk-report-loading"><Skeleton lines={5} /></div> : (
        <div className="bk-table-wrap">
          <table className="bk-table">
            <thead><tr>
              <th>Boekjaar</th><th>Periode</th><th>Status</th><th className="bk-num">Resultaat</th><th></th>
            </tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="bk-muted">Nog geen boekjaren. Open het eerste boekjaar om te beginnen.</td></tr>}
              {rows.map(r => {
                const result = r.status === 'closed' ? (r.result_cents ?? 0) : r.computed_result_cents;
                return (
                  <tr key={r.id}>
                    <td><strong>{r.label}</strong></td>
                    <td>{dateNL(r.period_start)} – {dateNL(r.period_end)}</td>
                    <td>
                      {r.status === 'closed'
                        ? <span className="bk-badge bk-badge-closed"><Lock size={12} /> Afgesloten</span>
                        : <span className="bk-badge bk-badge-open"><CalendarClock size={12} /> Open</span>}
                    </td>
                    <td className={`bk-num ${result >= 0 ? 'bk-pos' : 'bk-neg'}`}>
                      {euroCents(result)}
                      {r.status === 'open' && <span className="bk-muted bk-fy-hint"> (lopend)</span>}
                      {r.status === 'closed' && (r.result_cents ?? 0) !== r.computed_result_cents && (
                        <span className="bk-fy-hint bk-neg" title={`Na afsluiting is er nog in dit boekjaar geboekt. Bestemd naar ${resultLabel}: ${euroCents(r.result_cents ?? 0)}; nu herberekend: ${euroCents(r.computed_result_cents)}. Heropen en sluit opnieuw af om te corrigeren.`}> ⚠ afwijking</span>
                      )}
                    </td>
                    <td className="bk-fy-actions">
                      {r.status === 'open' && canWrite && (
                        <Button disabled={busyId === r.id} onClick={() => { setActionError(null); setConfirmClose(r); }}><Lock size={13} /> Afsluiten</Button>
                      )}
                      {r.status === 'closed' && canAdmin && (
                        <Button variant="ghost" disabled={busyId === r.id} onClick={() => { setActionError(null); setConfirmReopen(r); }}><Unlock size={13} /> Heropenen</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmClose && (
        <ConfirmDialog
          title={`Boekjaar ${confirmClose.label} afsluiten?`}
          confirmLabel="Definitief afsluiten"
          busy={busyId === confirmClose.id}
          error={actionError}
          onCancel={() => { setConfirmClose(null); setActionError(null); }}
          onConfirm={() => doClose(confirmClose)}
        >
          <p>Het resultaat van dit boekjaar wordt geboekt naar <strong>{resultLabel}</strong> en het volledige jaar wordt vergrendeld — er kan daarna niet meer in geboekt worden.</p>
          <p className="bk-fy-result">Te bestemmen resultaat: <strong className={confirmClose.computed_result_cents >= 0 ? 'bk-pos' : 'bk-neg'}>{euroCents(confirmClose.computed_result_cents)}</strong> ({confirmClose.computed_result_cents >= 0 ? 'winst' : 'verlies'})</p>
          <p className="bk-muted">Alle BTW-aangiften van dit boekjaar moeten eerst gefinaliseerd zijn. Een afgesloten boekjaar kan later alleen door een eigenaar/beheerder worden heropend.</p>
        </ConfirmDialog>
      )}

      {confirmReopen && (
        <ConfirmDialog
          title={`Boekjaar ${confirmReopen.label} heropenen?`}
          confirmLabel="Heropenen"
          busy={busyId === confirmReopen.id}
          error={actionError}
          onCancel={() => { setConfirmReopen(null); setActionError(null); }}
          onConfirm={() => doReopen(confirmReopen)}
        >
          <p>De resultaatbestemming wordt teruggedraaid en de jaar-vergrendeling opgeheven, zodat je weer in dit boekjaar kunt boeken.</p>
          <p className="bk-muted">Doe dit alleen om een fout te herstellen. Latere afgesloten boekjaren moeten eerst heropend worden.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ConfirmDialog({ title, confirmLabel, busy, error, children, onCancel, onConfirm }: {
  title: string; confirmLabel: string; busy: boolean; error?: string | null; children: ReactNode; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="bk-modal-body">{children}{error && <div className="error bk-modal-error">{error}</div>}</div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button variant="primary" onClick={onConfirm} disabled={busy}>{busy ? 'Bezig…' : confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
