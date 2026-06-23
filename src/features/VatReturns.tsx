import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Landmark, Lock } from 'lucide-react';
import type { AppData, VatReturn, VatReturnRubrieken } from '../types';
import { Button } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { computeVatReturn, ensureDefaultLedgerAccounts, finalizeVatReturn, updateRow } from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(year, month, 0).getDate();
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

type ViewPeriod = 'monthly' | 'quarterly';

function bounds(view: ViewPeriod, year: number, month: number, quarter: number) {
  if (view === 'monthly') {
    return {
      from: `${year}-${pad2(month)}-01`, to: `${year}-${pad2(month)}-${pad2(lastDay(year, month))}`,
      index: month, dbType: 'month' as const, label: `${MONTHS[month - 1]} ${year}`,
    };
  }
  const sm = (quarter - 1) * 3 + 1, em = sm + 2;
  return {
    from: `${year}-${pad2(sm)}-01`, to: `${year}-${pad2(em)}-${pad2(lastDay(year, em))}`,
    index: quarter, dbType: 'quarter' as const, label: `Q${quarter} ${year}`,
  };
}

const statusLabel: Record<VatReturn['status'], string> = {
  draft: 'Concept', finalized: 'Doorgeboekt', filed: 'Ingediend', paid: 'Betaald',
};

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

export function VatReturnsPage({ data, organizationId, canWrite, onChanged }: { data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void }) {
  const now = new Date();
  const settingPeriod: ViewPeriod = data.companySettings?.vat_return_period === 'monthly' ? 'monthly' : 'quarterly';
  const kor = Boolean(data.companySettings?.kor_enabled);

  const [view, setView] = useState<ViewPeriod>(settingPeriod);
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);
  const [live, setLive] = useState<VatReturnRubrieken | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const period = useMemo(() => bounds(view, year, month, quarter), [view, year, month, quarter]);
  const existing = useMemo(
    () => data.vatReturns.find(r => r.period_type === period.dbType && r.year === year && r.period_index === period.index) ?? null,
    [data.vatReturns, period, year],
  );

  const load = useCallback(async () => {
    if (existing) { setLive(existing.rubrieken); return; }
    setLoading(true); setError(null);
    try { setLive(await computeVatReturn(organizationId, period.from, period.to)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Berekenen mislukt'); setLive(null); }
    finally { setLoading(false); }
  }, [organizationId, period, existing]);

  useEffect(() => { if (data.ledgerAccounts.length > 0) void load(); }, [load, data.ledgerAccounts.length]);

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} onChanged={onChanged} /></div>;
  }

  const r = live;
  const saldo = r?.saldo ?? 0;
  const finalized = existing != null;

  async function finalize() {
    if (!canWrite) return;
    if (!confirm(`Aangifte ${period.label} definitief maken en doorboeken naar "Te betalen omzetbelasting"? Daarna wordt de periode vergrendeld.`)) return;
    setBusy(true); setError(null);
    try { await finalizeVatReturn(organizationId, { periodType: period.dbType, year, periodIndex: period.index, from: period.from, to: period.to }); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Doorboeken mislukt'); }
    finally { setBusy(false); }
  }

  async function setStatus(status: VatReturn['status']) {
    if (!existing || !canWrite) return;
    setBusy(true); setError(null);
    try { await updateRow<VatReturn>('vat_returns', existing.id, { status }, organizationId); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Status bijwerken mislukt'); }
    finally { setBusy(false); }
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><h2>Omzetbelasting</h2><p>BTW-aangifte per {view === 'monthly' ? 'maand' : 'kwartaal'}, berekend uit de geboekte journaalposten.</p></div>
      </div>

      {kor && <div className="bk-note">Je organisatie valt onder de <strong>KOR</strong>: je brengt geen BTW in rekening en mag geen voorbelasting aftrekken. De aangifte is daarom nihil.</div>}

      <div className="bk-report-controls">
        <div className="bk-seg">
          <button className={view === 'monthly' ? 'is-active' : ''} onClick={() => setView('monthly')}>Maand</button>
          <button className={view === 'quarterly' ? 'is-active' : ''} onClick={() => setView('quarterly')}>Kwartaal</button>
        </div>
        <div className="bk-period-pick">
          <button className="bk-step" onClick={() => setYear(y => y - 1)} title="Vorig jaar"><ChevronLeft size={16} /></button>
          <strong>{year}</strong>
          <button className="bk-step" onClick={() => setYear(y => y + 1)} title="Volgend jaar"><ChevronRight size={16} /></button>
          {view === 'quarterly' && <div className="bk-seg bk-seg-sm">{[1, 2, 3, 4].map(q => <button key={q} className={quarter === q ? 'is-active' : ''} onClick={() => setQuarter(q)}>Q{q}</button>)}</div>}
          {view === 'monthly' && <select className="form-select bk-month-select" value={month} onChange={e => setMonth(Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>}
        </div>
        <div className="bk-vat-status">
          {finalized
            ? <span className={`status-pill bk-vat-${existing!.status}`}><Lock size={12} /> {statusLabel[existing!.status]}</span>
            : <span className="bk-muted">Nog niet aangegeven</span>}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading || !r
        ? <div className="bk-muted bk-report-loading">Laden…</div>
        : <>
          <div className="bk-report-bar">
            <div className="bk-report-kpis">
              <div><span>Saldo {period.label}</span><strong className={saldo > 0 ? 'bk-neg' : 'bk-pos'}>{euroCents(Math.abs(saldo))}</strong></div>
              <div className={saldo > 0 ? 'bk-balance-bad' : 'bk-balance-ok'}>{saldo > 0 ? 'Te betalen' : saldo < 0 ? 'Terug te ontvangen' : 'Nihil'}</div>
            </div>
            {!finalized && canWrite && <Button variant="primary" onClick={finalize} disabled={busy}><Landmark size={14} /> {busy ? 'Bezig…' : 'Definitief maken & doorboeken'}</Button>}
            {finalized && existing!.status === 'finalized' && canWrite && <Button onClick={() => setStatus('filed')} disabled={busy}><CheckCircle2 size={14} /> Markeer als ingediend</Button>}
            {finalized && existing!.status === 'filed' && canWrite && <Button onClick={() => setStatus('paid')} disabled={busy}><CheckCircle2 size={14} /> Markeer als betaald</Button>}
          </div>

          <div className="bk-table-wrap"><table className="bk-table bk-report-table">
            <thead><tr><th>Rubriek</th><th>Omschrijving</th><th className="bk-num">Omzet</th><th className="bk-num">BTW</th></tr></thead>
            <tbody>
              <tr className="bk-report-section"><td colSpan={4}>Prestaties binnenland — verschuldigde omzetbelasting</td></tr>
              <tr><td>1a</td><td>Leveringen/diensten 21%</td><td className="bk-num">{euroCents(r.omzet_hoog_base)}</td><td className="bk-num">{euroCents(r.omzet_hoog_btw)}</td></tr>
              <tr><td>1b</td><td>Leveringen/diensten 9%</td><td className="bk-num">{euroCents(r.omzet_laag_base)}</td><td className="bk-num">{euroCents(r.omzet_laag_btw)}</td></tr>
              <tr><td>1e</td><td>Leveringen/diensten 0% of niet bij u belast</td><td className="bk-num">{euroCents(r.omzet_nul_base)}</td><td className="bk-num">—</td></tr>
              <tr><td>2a</td><td>Verleggingsregelingen / intracommunautaire verwerving</td><td className="bk-num">—</td><td className="bk-num">{euroCents(r.verlegd_btw)}</td></tr>
              <tr className="bk-report-total"><td>5a</td><td>Verschuldigde omzetbelasting</td><td className="bk-num" /><td className="bk-num">{euroCents(r.verschuldigd_total)}</td></tr>
              <tr className="bk-report-section"><td colSpan={4}>Voorbelasting</td></tr>
              <tr className="bk-report-total"><td>5b</td><td>Voorbelasting</td><td className="bk-num" /><td className="bk-num">{euroCents(r.voorbelasting)}</td></tr>
            </tbody>
            <tfoot><tr className="bk-report-result"><td>5c</td><td>{saldo >= 0 ? 'Te betalen' : 'Terug te ontvangen'}</td><td className="bk-num" /><td className={`bk-num ${saldo > 0 ? 'bk-neg' : 'bk-pos'}`}>{euroCents(Math.abs(saldo))}</td></tr></tfoot>
          </table></div>

          {finalized && existing!.journal_entry_id && (() => {
            const entry = data.journalEntries.find(j => j.id === existing!.journal_entry_id);
            return entry
              ? <p className="bk-muted">Doorgeboekt op {dateNL(entry.date)} · boekstuk {entry.entry_number}{existing!.finalized_at ? ` · ${dateNL(existing!.finalized_at)}` : ''}.</p>
              : null;
          })()}
          {finalized && existing!.status === 'paid' && existing!.paid_bank_transaction_id && (() => {
            const txn = data.bankTransactions.find(t => t.id === existing!.paid_bank_transaction_id);
            return txn
              ? <p className="bk-muted">{saldo >= 0 ? 'Betaald' : 'Teruggave ontvangen'} via de bank op {dateNL(txn.booking_date)} — automatisch afgeletterd tegen “Te betalen omzetbelasting”.</p>
              : null;
          })()}
          {finalized && <p className="bk-muted">Deze periode is vergrendeld. Latere boekingen met een datum in deze periode worden geweigerd en vallen in de eerstvolgende open aangifte.</p>}
        </>}
    </div>
  );
}
