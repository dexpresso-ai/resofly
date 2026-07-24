import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, ListChecks, Scale, TrendingUp } from 'lucide-react';
import type { AppData, BalanceSheetRow, OpenItemsReport, ProfitAndLossRow } from '../types';
import { Button } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { ensureDefaultLedgerAccounts, reportBalanceSheet, reportOpenItems, reportProfitAndLoss } from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(year, month, 0).getDate();
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

type PeriodType = 'month' | 'quarter' | 'year' | 'custom';
type PeriodBounds = { from: string; to: string; label: string };

// Vrij datumbereik: de "vorige" periode is het even lange bereik direct ervóór,
// zodat de W&V-vergelijking betekenisvol blijft.
function customPeriod(from: string, to: string): { current: PeriodBounds; previous: PeriodBounds } {
  const iso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const f = new Date(`${from}T00:00:00`), t = new Date(`${to}T00:00:00`);
  const days = Math.max(1, Math.round((t.getTime() - f.getTime()) / 86400000) + 1);
  const pt = new Date(f.getTime() - 86400000);
  const pf = new Date(pt.getTime() - (days - 1) * 86400000);
  return {
    current: { from, to, label: `${dateNL(from)} – ${dateNL(to)}` },
    previous: { from: iso(pf), to: iso(pt), label: `${dateNL(iso(pf))} – ${dateNL(iso(pt))}` },
  };
}

function fiscalYearBounds(startMonth: number, year: number): PeriodBounds {
  const from = `${year}-${pad2(startMonth)}-01`;
  const endYear = startMonth === 1 ? year : year + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const to = `${endYear}-${pad2(endMonth)}-${pad2(lastDay(endYear, endMonth))}`;
  const label = startMonth === 1 ? `${year}` : `${year}/${year + 1}`;
  return { from, to, label };
}

function getPeriod(type: PeriodType, year: number, month: number, quarter: number, startMonth: number): { current: PeriodBounds; previous: PeriodBounds } {
  if (type === 'year') {
    return {
      current: fiscalYearBounds(startMonth, year),
      previous: fiscalYearBounds(startMonth, year - 1),
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
  const escape = (v: string | number) => {
    let s = String(v);
    // Geldbedragen (bijv. "-1234.56") naar NL-decimaal (komma) zodat Excel/nl-NL ze
    // als getal leest bij een ;-gescheiden bestand. Alleen exacte bedrag-cellen —
    // omschrijvingen, codes en datums bevatten dit patroon niet.
    if (/^-?\d+\.\d{2}$/.test(s)) s = s.replace('.', ',');
    return `"${s.replace(/"/g, '""')}"`;
  };
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
  const [view, setView] = useState<'pnl' | 'balance' | 'open'>('pnl');
  const [periodType, setPeriodType] = useState<PeriodType>('quarter');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);
  const [customFrom, setCustomFrom] = useState(`${now.getFullYear()}-01-01`);
  const [customTo, setCustomTo] = useState(`${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`);

  const [pnlCurrent, setPnlCurrent] = useState<ProfitAndLossRow[]>([]);
  const [pnlPrevious, setPnlPrevious] = useState<ProfitAndLossRow[]>([]);
  const [balance, setBalance] = useState<BalanceSheetRow[]>([]);
  const [openItems, setOpenItems] = useState<OpenItemsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fiscalStartMonth = data.companySettings?.fiscal_year_start_month ?? 1;
  const period = useMemo(
    () => periodType === 'custom' ? customPeriod(customFrom, customTo) : getPeriod(periodType, year, month, quarter, fiscalStartMonth),
    [periodType, year, month, quarter, fiscalStartMonth, customFrom, customTo],
  );

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (view === 'pnl') {
        const [cur, prev] = await Promise.all([
          reportProfitAndLoss(organizationId, period.current.from, period.current.to),
          reportProfitAndLoss(organizationId, period.previous.from, period.previous.to),
        ]);
        setPnlCurrent(cur); setPnlPrevious(prev);
      } else if (view === 'balance') {
        setBalance(await reportBalanceSheet(organizationId, period.current.to));
      } else {
        setOpenItems(await reportOpenItems(organizationId, period.current.to));
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
          {(['month', 'quarter', 'year', 'custom'] as PeriodType[]).map(t => (
            <button key={t} className={periodType === t ? 'is-active' : ''} onClick={() => setPeriodType(t)}>
              {t === 'month' ? 'Maand' : t === 'quarter' ? 'Kwartaal' : t === 'year' ? 'Jaar' : 'Vrij'}
            </button>
          ))}
        </div>
        <div className="bk-period-pick">
          {periodType === 'custom' ? (
            <>
              <input type="date" className="form-input" value={customFrom} max={customTo} onChange={e => setCustomFrom(e.target.value)} title="Vanaf" />
              <span className="bk-muted">t/m</span>
              <input type="date" className="form-input" value={customTo} min={customFrom} onChange={e => setCustomTo(e.target.value)} title="Tot en met" />
            </>
          ) : (
            <>
              <button className="bk-step" onClick={() => setYear(y => y - 1)} title="Vorig jaar"><ChevronLeft size={16} /></button>
              <strong>{year}</strong>
              <button className="bk-step" onClick={() => setYear(y => y + 1)} title="Volgend jaar"><ChevronRight size={16} /></button>
              {periodType === 'quarter' && <div className="bk-seg bk-seg-sm">{[1, 2, 3, 4].map(q => <button key={q} className={quarter === q ? 'is-active' : ''} onClick={() => setQuarter(q)}>Q{q}</button>)}</div>}
              {periodType === 'month' && <select className="form-select bk-month-select" value={month} onChange={e => setMonth(Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>}
            </>
          )}
        </div>
        <div className="bk-seg">
          <button className={view === 'pnl' ? 'is-active' : ''} onClick={() => setView('pnl')}><TrendingUp size={14} /> W&amp;V</button>
          <button className={view === 'balance' ? 'is-active' : ''} onClick={() => setView('balance')}><Scale size={14} /> Balans</button>
          <button className={view === 'open' ? 'is-active' : ''} onClick={() => setView('open')}><ListChecks size={14} /> Openstaand</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {loading
        ? <div className="bk-muted bk-report-loading">Laden…</div>
        : view === 'pnl'
          ? <PnlReport current={pnlCurrent} previous={pnlPrevious} period={period} />
          : view === 'balance'
            ? <BalanceReport rows={balance} label={period.current.label} asOf={period.current.to} data={data} />
            : openItems
              ? <OpenItemsView report={openItems} label={period.current.label} />
              : <div className="bk-muted bk-report-loading">Laden…</div>}
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

function BalanceReport({ rows, label, asOf, data }: { rows: BalanceSheetRow[]; label: string; asOf: string; data: AppData }) {
  const [assetsExpanded, setAssetsExpanded] = useState(true);
  const assets = rows.filter(r => r.section === 'asset');
  const liabilities = rows.filter(r => r.section === 'liability');
  const equityAccounts = rows.filter(r => r.section === 'equity');
  const result = rows.find(r => r.section === 'result')?.amount_cents ?? 0;
  const sum = (rs: BalanceSheetRow[]) => rs.reduce((s, r) => s + r.amount_cents, 0);

  // De grootboekrekeningen die de activamodule gebruikt (activarekening +
  // cumulatieve afschrijving) bundelen tot één boekwaarderegel = aanschaf − afschrijving.
  const fixedAccountIds = new Set<string>();
  for (const a of data.fixedAssets) {
    if (a.asset_account_id) fixedAccountIds.add(a.asset_account_id);
    if (a.accumulated_depreciation_account_id) fixedAccountIds.add(a.accumulated_depreciation_account_id);
  }
  const fixedRows = assets.filter(r => r.account_id && fixedAccountIds.has(r.account_id));
  const otherAssets = assets.filter(r => !(r.account_id && fixedAccountIds.has(r.account_id)));
  const fixedNet = sum(fixedRows);

  // Per-activum boekwaarde op de PEILDATUM: alleen afschrijvingen t/m asOf, alleen
  // activa aangeschaft t/m asOf en (nog) niet afgestoten op de peildatum — zodat de
  // sub-regels aansluiten op de datumgefilterde groepsregel (fixedNet uit het grootboek).
  const postedByAsset = new Map<string, number>();
  for (const d of data.assetDepreciations) if (d.status === 'posted' && d.date <= asOf) postedByAsset.set(d.asset_id, (postedByAsset.get(d.asset_id) ?? 0) + d.amount_cents);
  const perAsset = data.fixedAssets
    .filter(a => a.acquisition_date <= asOf && !(a.status === 'disposed' && a.disposal_date != null && a.disposal_date <= asOf))
    .map(a => ({ id: a.id, name: a.asset_number ? `${a.asset_number} · ${a.name}` : a.name, bookValue: a.acquisition_cost_cents - (postedByAsset.get(a.id) ?? 0) }))
    .sort((x, y) => x.name.localeCompare(y.name));

  const totalAssets = sum(assets);
  const totalEquity = sum(equityAccounts) + result;
  const totalPassiva = sum(liabilities) + totalEquity;
  const balanced = totalAssets === totalPassiva;

  const exportCsv = () => downloadCsv(
    `balans-${label.replace(/\s/g, '-')}.csv`,
    ['Sectie', 'Rekening', 'Bedrag'],
    [
      ...otherAssets.map(r => ['Activa', `${r.code ? r.code + ' · ' : ''}${r.name}`, (r.amount_cents / 100).toFixed(2)] as (string | number)[]),
      ...(fixedRows.length ? [['Activa', 'Vaste activa (boekwaarde)', (fixedNet / 100).toFixed(2)] as (string | number)[]] : []),
      ...(fixedRows.length ? perAsset.map(a => ['Activa · vaste activa', a.name, (a.bookValue / 100).toFixed(2)] as (string | number)[]) : []),
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
            {otherAssets.map(r => line(`${r.code ? r.code + ' · ' : ''}${r.name}`, r.amount_cents))}
            {fixedRows.length > 0 && <>
              <tr className="bk-balance-group" onClick={() => setAssetsExpanded(e => !e)} title="Klik om de afzonderlijke activa te tonen">
                <td><span className="bk-group-toggle">{assetsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span> Vaste activa (boekwaarde)</td>
                <td className="bk-num">{euroCents(fixedNet)}</td>
              </tr>
              {assetsExpanded && (perAsset.length
                ? perAsset.map(a => <tr className="bk-balance-sub" key={a.id}><td>{a.name}</td><td className="bk-num">{euroCents(a.bookValue)}</td></tr>)
                : <tr className="bk-balance-sub"><td colSpan={2} className="bk-muted">Geen activa geregistreerd.</td></tr>)}
            </>}
            {otherAssets.length === 0 && fixedRows.length === 0 && <tr><td colSpan={2} className="bk-muted">Geen activa.</td></tr>}
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

/**
 * Openstaande-postenlijst (review 3.5): per factuur geboekt − betaald − gecrediteerd
 * uit het grootboek, met aansluiting op het 1300/1600-saldo. Het "niet aan een
 * factuur gekoppeld"-bedrag maakt desyncs zichtbaar die eerder onvindbaar waren.
 */
function OpenItemsView({ report, label }: { report: OpenItemsReport; label: string }) {
  const recv = report.receivables;
  const pay = report.payables;
  const today = new Date().toISOString().slice(0, 10);

  const exportCsv = () => downloadCsv(
    `openstaande-posten-${label.replace(/\s/g, '-')}.csv`,
    ['Soort', 'Nummer', 'Relatie', 'Datum', 'Vervaldatum', 'Geboekt', 'Betaald', 'Gecrediteerd', 'Open'],
    [
      ...recv.rows.map(r => ['Debiteur', r.number ?? '', r.client_name ?? '', r.date, r.due_date ?? '', (r.booked_cents / 100).toFixed(2), (r.paid_cents / 100).toFixed(2), (r.credited_cents / 100).toFixed(2), (r.open_cents / 100).toFixed(2)] as (string | number)[]),
      ...pay.rows.map(r => ['Crediteur', r.number ?? '', r.supplier_name ?? '', r.date, r.due_date ?? '', (r.booked_cents / 100).toFixed(2), (r.paid_cents / 100).toFixed(2), '', (r.open_cents / 100).toFixed(2)] as (string | number)[]),
    ],
  );

  const side = (title: string, kpis: { open: number; gl: number; unmatched: number }, table: React.ReactNode) => (
    <div className="bk-report">
      <div className="bk-open-kpis">
        <div><span>{title} openstaand</span><strong>{euroCents(kpis.open)}</strong></div>
        <div><span>Grootboeksaldo</span><strong>{euroCents(kpis.gl)}</strong></div>
        <div>
          <span>Niet aan factuur gekoppeld</span>
          <strong className={kpis.unmatched === 0 ? 'bk-pos' : 'bk-neg'}>{euroCents(kpis.unmatched)}</strong>
        </div>
      </div>
      {kpis.unmatched !== 0 && (
        <p className="bk-muted">Het grootboeksaldo bevat {euroCents(Math.abs(kpis.unmatched))} die niet uit facturen komt (beginbalans of vrije boekingen op de rekening). Openstaand + dit bedrag = grootboeksaldo.</p>
      )}
      {table}
    </div>
  );

  return (
    <div className="bk-report">
      <div className="bk-report-bar">
        <div className="bk-report-kpis">
          <div><span>Openstaand per {dateNL(report.as_of)}</span><strong>{euroCents(recv.open_total_cents)} <span className="bk-muted">te ontvangen</span></strong></div>
          <div><span>&nbsp;</span><strong>{euroCents(pay.open_total_cents)} <span className="bk-muted">te betalen</span></strong></div>
        </div>
        <Button onClick={exportCsv}><Download size={14} /> Exporteer CSV</Button>
      </div>

      {side('Debiteuren (1300)', { open: recv.open_total_cents, gl: recv.gl_balance_cents, unmatched: recv.unmatched_cents },
        <div className="bk-table-wrap"><table className="bk-table">
          <thead><tr><th>Factuur</th><th>Klant</th><th>Datum</th><th>Vervalt</th><th className="bk-num">Geboekt</th><th className="bk-num">Betaald</th><th className="bk-num">Gecrediteerd</th><th className="bk-num">Open</th></tr></thead>
          <tbody>
            {recv.rows.length === 0 && <tr><td colSpan={8} className="bk-muted">Geen openstaande debiteuren. 🎉</td></tr>}
            {recv.rows.map(r => (
              <tr key={r.invoice_id}>
                <td><strong>{r.number ?? '—'}</strong></td>
                <td>{r.client_name ?? '—'}</td>
                <td>{dateNL(r.date)}</td>
                <td className={r.due_date && r.due_date < today && r.open_cents > 0 ? 'bk-neg' : ''}>{r.due_date ? dateNL(r.due_date) : '—'}</td>
                <td className="bk-num">{euroCents(r.booked_cents)}</td>
                <td className="bk-num">{euroCents(r.paid_cents)}</td>
                <td className="bk-num">{r.credited_cents ? euroCents(r.credited_cents) : ''}</td>
                <td className="bk-num"><strong>{euroCents(r.open_cents)}</strong></td>
              </tr>
            ))}
          </tbody>
          {recv.rows.length > 0 && <tfoot><tr className="bk-report-result"><td colSpan={7}>Totaal openstaand</td><td className="bk-num">{euroCents(recv.open_total_cents)}</td></tr></tfoot>}
        </table></div>)}

      {side('Crediteuren (1600)', { open: pay.open_total_cents, gl: pay.gl_balance_cents, unmatched: pay.unmatched_cents },
        <div className="bk-table-wrap"><table className="bk-table">
          <thead><tr><th>Inkoopfactuur</th><th>Leverancier</th><th>Datum</th><th>Vervalt</th><th className="bk-num">Geboekt</th><th className="bk-num">Betaald</th><th className="bk-num">Open</th></tr></thead>
          <tbody>
            {pay.rows.length === 0 && <tr><td colSpan={7} className="bk-muted">Geen openstaande crediteuren.</td></tr>}
            {pay.rows.map(r => (
              <tr key={r.purchase_invoice_id}>
                <td><strong>{r.number ?? '—'}</strong></td>
                <td>{r.supplier_name ?? '—'}</td>
                <td>{dateNL(r.date)}</td>
                <td className={r.due_date && r.due_date < today && r.open_cents > 0 ? 'bk-neg' : ''}>{r.due_date ? dateNL(r.due_date) : '—'}</td>
                <td className="bk-num">{euroCents(r.booked_cents)}</td>
                <td className="bk-num">{euroCents(r.paid_cents)}</td>
                <td className="bk-num"><strong>{euroCents(r.open_cents)}</strong></td>
              </tr>
            ))}
          </tbody>
          {pay.rows.length > 0 && <tfoot><tr className="bk-report-result"><td colSpan={6}>Totaal openstaand</td><td className="bk-num">{euroCents(pay.open_total_cents)}</td></tr></tfoot>}
        </table></div>)}
    </div>
  );
}
