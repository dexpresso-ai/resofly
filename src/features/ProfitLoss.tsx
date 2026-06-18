import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Scale, TrendingUp } from 'lucide-react';
import type { AppData, BalanceSheetRow, ProfitAndLossRow } from '../types';
import { Button } from '../components/Ui';
import { euro } from '../lib/format';
import { ensureDefaultLedgerAccounts, reportBalanceSheet, reportProfitAndLoss } from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(year, month, 0).getDate();
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

type PeriodType = 'month' | 'quarter' | 'year';
type PeriodBounds = { from: string; to: string; label: string };

function getPeriod(type: PeriodType, year: number, month: number, quarter: number): { current: PeriodBounds; previous: PeriodBounds } {
  if (type === 'year') {
    return {
      current: { from: `${year}-01-01`, to: `${year}-12-31`, label: `${year}` },
      previous: { from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, label: `${year - 1}` },
    };
  }
  if (type === 'quarter') {
    const sm = (quarter - 1) * 3 + 1, em = sm + 2;
    const pq = quarter === 1 ? 4 : quarter - 1, py = quarter === 1 ? year - 1 : year;
    const psm = (pq - 1) * 3 + 1, pem = psm + 2;
    return {
      current: { from: `${year}-${pad2(sm)}-01`, to: `${year}-${pad2(em)}-${pad2(lastDay(year, em))}`, label: `Q${quarter} ${year}` },
      previous: { from: `${py}-${pad2(psm)}-01`, to: `${py}-${pad2(pem)}-${pad2(lastDay(py, pem))}`, label: `Q${pq} ${py}` },
    };
  }
  const pm = month === 1 ? 12 : month - 1, py = month === 1 ? year - 1 : year;
  return {
    current: { from: `${year}-${pad2(month)}-01`, to: `${year}-${pad2(month)}-${pad2(lastDay(year, month))}`, label: `${MONTHS[month - 1]} ${year}` },
    previous: { from: `${py}-${pad2(pm)}-01`, to: `${py}-${pad2(pm)}-${pad2(lastDay(py, pm))}`, label: `${MONTHS[pm - 1]} ${py}` },
  };
}

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [header, ...rows].map(r => r.map(escape).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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

export function ProfitLossPage({ data, organizationId, onChanged }: { data: AppData; organizationId: string; onChanged: () => void }) {
  const now = new Date();
  const [view, setView] = useState<'pnl' | 'balance'>('pnl');
  const [periodType, setPeriodType] = useState<PeriodType>('quarter');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);

  const [pnlCurrent, setPnlCurrent] = useState<ProfitAndLossRow[]>([]);
  const [pnlPrevious, setPnlPrevious] = useState<ProfitAndLossRow[]>([]);
  const [balance, setBalance] = useState<BalanceSheetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const period = useMemo(() => getPeriod(periodType, year, month, quarter), [periodType, year, month, quarter]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (view === 'pnl') {
        const [cur, prev] = await Promise.all([
          reportProfitAndLoss(organizationId, period.current.from, period.current.to),
          reportProfitAndLoss(organizationId, period.previous.from, period.previous.to),
        ]);
        setPnlCurrent(cur); setPnlPrevious(prev);
      } else {
        setBalance(await reportBalanceSheet(organizationId, period.current.to));
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Overzicht laden mislukt'); }
    finally { setLoading(false); }
  }, [organizationId, view, period]);

  useEffect(() => { if (data.ledgerAccounts.length > 0) void load(); }, [load, data.ledgerAccounts.length]);

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} onChanged={onChanged} /></div>;
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><h2>Winst &amp; verlies</h2><p>Resultaat en balans, afgeleid uit de geboekte journaalposten.</p></div>
      </div>

      <div className="bk-report-controls">
        <div className="bk-seg">
          {(['month', 'quarter', 'year'] as PeriodType[]).map(t => (
            <button key={t} className={periodType === t ? 'is-active' : ''} onClick={() => setPeriodType(t)}>
              {t === 'month' ? 'Maand' : t === 'quarter' ? 'Kwartaal' : 'Jaar'}
            </button>
          ))}
        </div>
        <div className="bk-period-pick">
          <button className="bk-step" onClick={() => setYear(y => y - 1)} title="Vorig jaar"><ChevronLeft size={16} /></button>
          <strong>{year}</strong>
          <button className="bk-step" onClick={() => setYear(y => y + 1)} title="Volgend jaar"><ChevronRight size={16} /></button>
          {periodType === 'quarter' && <div className="bk-seg bk-seg-sm">{[1, 2, 3, 4].map(q => <button key={q} className={quarter === q ? 'is-active' : ''} onClick={() => setQuarter(q)}>Q{q}</button>)}</div>}
          {periodType === 'month' && <select className="form-select bk-month-select" value={month} onChange={e => setMonth(Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>}
        </div>
        <div className="bk-seg">
          <button className={view === 'pnl' ? 'is-active' : ''} onClick={() => setView('pnl')}><TrendingUp size={14} /> W&amp;V</button>
          <button className={view === 'balance' ? 'is-active' : ''} onClick={() => setView('balance')}><Scale size={14} /> Balans</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading
        ? <div className="bk-muted bk-report-loading">Laden…</div>
        : view === 'pnl'
          ? <PnlReport current={pnlCurrent} previous={pnlPrevious} period={period} />
          : <BalanceReport rows={balance} asOf={period.current.to} label={period.current.label} />}
    </div>
  );
}

type MergedRow = { key: string; name: string; current: number; previous: number };

function mergePnl(current: ProfitAndLossRow[], previous: ProfitAndLossRow[], type: 'revenue' | 'expense'): MergedRow[] {
  const map = new Map<string, MergedRow>();
  const keyOf = (r: ProfitAndLossRow) => r.account_id ?? r.code ?? r.name;
  for (const r of current.filter(x => x.account_type === type)) {
    map.set(keyOf(r), { key: keyOf(r), name: `${r.code ? r.code + ' · ' : ''}${r.name}`, current: r.amount_cents, previous: 0 });
  }
  for (const r of previous.filter(x => x.account_type === type)) {
    const k = keyOf(r);
    const ex = map.get(k);
    if (ex) ex.previous = r.amount_cents;
    else map.set(k, { key: k, name: `${r.code ? r.code + ' · ' : ''}${r.name}`, current: 0, previous: r.amount_cents });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function PnlReport({ current, previous, period }: { current: ProfitAndLossRow[]; previous: ProfitAndLossRow[]; period: { current: PeriodBounds; previous: PeriodBounds } }) {
  const revenue = mergePnl(current, previous, 'revenue');
  const expense = mergePnl(current, previous, 'expense');
  const sum = (rows: MergedRow[], k: 'current' | 'previous') => rows.reduce((s, r) => s + r[k], 0);
  const revCur = sum(revenue, 'current'), revPrev = sum(revenue, 'previous');
  const expCur = sum(expense, 'current'), expPrev = sum(expense, 'previous');
  const resCur = revCur - expCur, resPrev = revPrev - expPrev;

  const exportCsv = () => downloadCsv(
    `winst-verlies-${period.current.label.replace(/\s/g, '-')}.csv`,
    ['Rubriek', 'Rekening', period.current.label, period.previous.label],
    [
      ...revenue.map(r => ['Opbrengsten', r.name, (r.current / 100).toFixed(2), (r.previous / 100).toFixed(2)]),
      ['', 'Totaal opbrengsten', (revCur / 100).toFixed(2), (revPrev / 100).toFixed(2)],
      ...expense.map(r => ['Kosten', r.name, (r.current / 100).toFixed(2), (r.previous / 100).toFixed(2)]),
      ['', 'Totaal kosten', (expCur / 100).toFixed(2), (expPrev / 100).toFixed(2)],
      ['', 'Resultaat', (resCur / 100).toFixed(2), (resPrev / 100).toFixed(2)],
    ],
  );

  const row = (name: string, cur: number, prev: number, cls = '') => (
    <tr className={cls} key={name}>
      <td>{name}</td><td className="bk-num">{euroCents(cur)}</td><td className="bk-num bk-muted">{euroCents(prev)}</td>
    </tr>
  );

  return (
    <div className="bk-report">
      <div className="bk-report-bar">
        <div className="bk-report-kpis">
          <div><span>Resultaat {period.current.label}</span><strong className={resCur >= 0 ? 'bk-pos' : 'bk-neg'}>{euroCents(resCur)}</strong></div>
        </div>
        <Button onClick={exportCsv}><Download size={14} /> Exporteer CSV</Button>
      </div>
      <div className="bk-table-wrap"><table className="bk-table bk-report-table">
        <thead><tr><th>Omschrijving</th><th className="bk-num">{period.current.label}</th><th className="bk-num">{period.previous.label}</th></tr></thead>
        <tbody>
          <tr className="bk-report-section"><td colSpan={3}>Opbrengsten</td></tr>
          {revenue.length ? revenue.map(r => row(r.name, r.current, r.previous)) : <tr><td colSpan={3} className="bk-muted">Geen opbrengsten in deze periode.</td></tr>}
          {row('Totaal opbrengsten', revCur, revPrev, 'bk-report-total')}
          <tr className="bk-report-section"><td colSpan={3}>Kosten</td></tr>
          {expense.length ? expense.map(r => row(r.name, r.current, r.previous)) : <tr><td colSpan={3} className="bk-muted">Geen kosten in deze periode.</td></tr>}
          {row('Totaal kosten', expCur, expPrev, 'bk-report-total')}
        </tbody>
        <tfoot><tr className="bk-report-result"><td>Resultaat</td><td className={`bk-num ${resCur >= 0 ? 'bk-pos' : 'bk-neg'}`}>{euroCents(resCur)}</td><td className="bk-num bk-muted">{euroCents(resPrev)}</td></tr></tfoot>
      </table></div>
    </div>
  );
}

function BalanceReport({ rows, asOf, label }: { rows: BalanceSheetRow[]; asOf: string; label: string }) {
  const assets = rows.filter(r => r.section === 'asset');
  const liabilities = rows.filter(r => r.section === 'liability');
  const equityAccounts = rows.filter(r => r.section === 'equity');
  const resultRow = rows.find(r => r.section === 'result');
  const result = resultRow?.amount_cents ?? 0;
  const sum = (rs: BalanceSheetRow[]) => rs.reduce((s, r) => s + r.amount_cents, 0);
  const totalAssets = sum(assets);
  const totalEquity = sum(equityAccounts) + result;
  const totalPassiva = sum(liabilities) + totalEquity;
  const balanced = totalAssets === totalPassiva;

  const exportCsv = () => downloadCsv(
    `balans-${label.replace(/\s/g, '-')}.csv`,
    ['Sectie', 'Rekening', 'Bedrag'],
    [
      ...assets.map(r => ['Activa', `${r.code ? r.code + ' · ' : ''}${r.name}`, (r.amount_cents / 100).toFixed(2)]),
      ['', 'Totaal activa', (totalAssets / 100).toFixed(2)],
      ...liabilities.map(r => ['Vreemd vermogen', `${r.code ? r.code + ' · ' : ''}${r.name}`, (r.amount_cents / 100).toFixed(2)]),
      ...equityAccounts.map(r => ['Eigen vermogen', `${r.code ? r.code + ' · ' : ''}${r.name}`, (r.amount_cents / 100).toFixed(2)]),
      ['Eigen vermogen', 'Resultaat (onverdeeld)', (result / 100).toFixed(2)],
      ['', 'Totaal passiva', (totalPassiva / 100).toFixed(2)],
    ],
  );

  const line = (name: string, amount: number, cls = '') => (
    <tr className={cls} key={name}><td>{name}</td><td className="bk-num">{euroCents(amount)}</td></tr>
  );

  return (
    <div className="bk-report">
      <div className="bk-report-bar">
        <div className="bk-report-kpis">
          <div><span>Balanstotaal per {label}</span><strong>{euroCents(totalAssets)}</strong></div>
          <div className={balanced ? 'bk-balance-ok' : 'bk-balance-bad'}>{balanced ? '✓ In balans' : `⚠ Verschil ${euroCents(totalAssets - totalPassiva)}`}</div>
        </div>
        <Button onClick={exportCsv}><Download size={14} /> Exporteer CSV</Button>
      </div>
      <div className="bk-balance-cols">
        <div className="bk-table-wrap"><table className="bk-table bk-report-table">
          <thead><tr><th>Activa</th><th className="bk-num">Bedrag</th></tr></thead>
          <tbody>
            {assets.length ? assets.map(r => line(`${r.code ? r.code + ' · ' : ''}${r.name}`, r.amount_cents)) : <tr><td colSpan={2} className="bk-muted">Geen activa.</td></tr>}
          </tbody>
          <tfoot><tr className="bk-report-result"><td>Totaal activa</td><td className="bk-num">{euroCents(totalAssets)}</td></tr></tfoot>
        </table></div>
        <div className="bk-table-wrap"><table className="bk-table bk-report-table">
          <thead><tr><th>Passiva</th><th className="bk-num">Bedrag</th></tr></thead>
          <tbody>
            <tr className="bk-report-section"><td colSpan={2}>Vreemd vermogen</td></tr>
            {liabilities.length ? liabilities.map(r => line(`${r.code ? r.code + ' · ' : ''}${r.name}`, r.amount_cents)) : <tr><td colSpan={2} className="bk-muted">Geen.</td></tr>}
            <tr className="bk-report-section"><td colSpan={2}>Eigen vermogen</td></tr>
            {equityAccounts.map(r => line(`${r.code ? r.code + ' · ' : ''}${r.name}`, r.amount_cents))}
            {line('Resultaat (onverdeeld)', result)}
          </tbody>
          <tfoot><tr className="bk-report-result"><td>Totaal passiva</td><td className="bk-num">{euroCents(totalPassiva)}</td></tr></tfoot>
        </table></div>
      </div>
    </div>
  );
}
