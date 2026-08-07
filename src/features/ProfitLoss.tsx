import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Download, ListChecks, Scale, TrendingUp } from 'lucide-react';
import type { AppData, BalanceSheetRow, LedgerReportGroup, OpenItemsReport, ProfitAndLossRow } from '../types';
import { REPORT_GROUP_LABELS } from '../types';
import { Button, Skeleton } from '../components/Ui';
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
  const [balancePrevious, setBalancePrevious] = useState<BalanceSheetRow[]>([]);
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
        // Vergelijkende cijfers zijn in een jaarrekening verplicht (art. 2:363
        // lid 5 BW): bij elke post ook het bedrag van het voorafgaande boekjaar.
        // Twee peildata, twee aanroepen — de RPC kent er maar één.
        const [cur, prev] = await Promise.all([
          reportBalanceSheet(organizationId, period.current.to),
          reportBalanceSheet(organizationId, period.previous.to),
        ]);
        setBalance(cur); setBalancePrevious(prev);
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
        ? <div className="bk-muted bk-report-loading"><Skeleton lines={5} /></div>
        : view === 'pnl'
          ? <PnlReport current={pnlCurrent} previous={pnlPrevious} period={period} />
          : view === 'balance'
            ? <BalanceReport rows={balance} previousRows={balancePrevious} period={period} data={data} />
            : openItems
              ? <OpenItemsView report={openItems} label={period.current.label} />
              : <div className="bk-muted bk-report-loading"><Skeleton lines={5} /></div>}
    </div>
  );
}

// === Rubrieken =============================================================
// De rapport-RPC's leveren per regel een rubriek (report_group) plus de
// wettelijke volgorde (group_rank). Rubriceren gebeurt dus in de database; hier
// wordt alleen gegroepeerd, opgeteld en getoond.

type MergedRow = { key: string; name: string; current: number; previous: number };
type ReportGroupBlock = { group: LedgerReportGroup; rank: number; rows: MergedRow[]; current: number; previous: number };

/** Rekeningen zonder rubriek (database van vóór migratie 20260807020000). */
function fallbackGroup(row: BalanceSheetRow | ProfitAndLossRow): LedgerReportGroup {
  if ('section' in row) {
    return row.section === 'asset' ? 'vorderingen' : row.section === 'liability' ? 'kortlopende_schulden' : 'eigen_vermogen';
  }
  return row.account_type === 'revenue' ? 'overige_bedrijfsopbrengsten' : 'overige_bedrijfskosten';
}

/**
 * Zet de regels van beide peilmomenten om in blokken per rubriek. Een rekening
 * die alleen in het vergelijkende jaar voorkomt hoort er óók bij te staan — met
 * nul in de huidige kolom — anders lijkt een gestopte post verdwenen.
 */
function groupRows<T extends BalanceSheetRow | ProfitAndLossRow>(
  current: T[],
  previous: T[],
  sign: (row: T) => number,
  keep: (row: T) => boolean = () => true,
  groupFor: (row: T) => LedgerReportGroup = row => row.report_group ?? fallbackGroup(row),
): ReportGroupBlock[] {
  const blocks = new Map<LedgerReportGroup, ReportGroupBlock & { index: Map<string, MergedRow> }>();
  const absorb = (rows: T[], field: 'current' | 'previous') => {
    for (const row of rows) {
      if (!keep(row)) continue;
      const group = groupFor(row);
      let block = blocks.get(group);
      if (!block) {
        // De rang uit de RPC hoort bij de rubriek van de rekening zelf; is die
        // hier vervangen, val dan terug op de restgroep-rang.
        const rank = group === row.report_group ? (row.group_rank ?? 999) : 999;
        block = { group, rank, rows: [], current: 0, previous: 0, index: new Map() };
        blocks.set(group, block);
      }
      const key = row.account_id ?? row.code ?? row.name;
      let line = block.index.get(key);
      if (!line) {
        line = { key, name: `${row.code ? row.code + ' · ' : ''}${row.name}`, current: 0, previous: 0 };
        block.index.set(key, line);
        block.rows.push(line);
      }
      const amount = sign(row) * row.amount_cents;
      line[field] += amount;
      block[field] += amount;
    }
  };
  absorb(current, 'current');
  absorb(previous, 'previous');
  return [...blocks.values()]
    .map(({ index: _index, ...block }) => ({ ...block, rows: block.rows.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group));
}

const sumBlocks = (blocks: ReportGroupBlock[], field: 'current' | 'previous') =>
  blocks.reduce((total, block) => total + block[field], 0);

/**
 * Winst- en verliesrekening in de secties van art. 2:377 BW / Model E:
 * bedrijfsopbrengsten − bedrijfslasten → financiële baten en lasten →
 * resultaat vóór belastingen → belastingen → resultaat na belastingen.
 *
 * Model E kent overigens geen regel "Bedrijfsresultaat" — het noemt alleen de
 * som der bedrijfsopbrengsten en de som der bedrijfslasten. Wij tonen het
 * subtotaal wél, omdat het in de praktijk (en in de Richtlijnen voor de
 * jaarverslaggeving) de meest gelezen regel is.
 *
 * Bedragen komen positief georiënteerd binnen: opbrengst = credit − debet,
 * kosten = debet − credit. In dit overzicht rekenen we per rubriek naar het
 * EFFECT OP HET RESULTAAT (opbrengst +, kosten −), zodat elk subtotaal een
 * gewone optelling is en er nooit een teken zoekraakt.
 */
function PnlReport({ current, previous, period }: { current: ProfitAndLossRow[]; previous: ProfitAndLossRow[]; period: { current: PeriodBounds; previous: PeriodBounds } }) {
  const effect = (row: ProfitAndLossRow) => (row.account_type === 'revenue' ? 1 : -1);

  // De rubriek van een W&V-rekening hoort een W&V-rubriek te zijn, maar de
  // database staat elke waarde op elke rekening toe. Een omzetrekening die per
  // ongeluk op "Liquide middelen" staat, mag niet uit het overzicht vallen: dan
  // telt het resultaat niet meer op tot omzet − kosten. Alles wat buiten de
  // W&V-rubrieken valt, gaat daarom naar de restgroep van zijn eigen soort.
  const PNL_GROUPS: LedgerReportGroup[] = [
    'netto_omzet', 'overige_bedrijfsopbrengsten',
    'inkoopwaarde', 'personeelskosten', 'afschrijvingen', 'overige_bedrijfskosten',
    'financiele_baten', 'financiele_lasten', 'belastingen', 'resultaat_deelnemingen',
  ];
  const groupOf = (row: ProfitAndLossRow): LedgerReportGroup => {
    const group = row.report_group;
    return group && PNL_GROUPS.includes(group) ? group : fallbackGroup(row);
  };
  const inGroups = (...groups: LedgerReportGroup[]) =>
    (row: ProfitAndLossRow) => groups.includes(groupOf(row));

  const income = groupRows(current, previous, effect, inGroups('netto_omzet', 'overige_bedrijfsopbrengsten'), groupOf);
  const costs = groupRows(current, previous, effect, inGroups('inkoopwaarde', 'personeelskosten', 'afschrijvingen', 'overige_bedrijfskosten'), groupOf);
  const financial = groupRows(current, previous, effect, inGroups('financiele_baten', 'financiele_lasten'), groupOf);
  const taxes = groupRows(current, previous, effect, inGroups('belastingen'), groupOf);
  const participations = groupRows(current, previous, effect, inGroups('resultaat_deelnemingen'), groupOf);

  const totals = (field: 'current' | 'previous') => {
    const revenue = sumBlocks(income, field);
    // Kosten zijn negatief in de effect-oriëntatie; als "som der bedrijfslasten"
    // hoort er een positief bedrag te staan.
    const expense = -sumBlocks(costs, field);
    const operating = revenue - expense;
    const finance = sumBlocks(financial, field);
    const beforeTax = operating + finance;
    const tax = -sumBlocks(taxes, field);
    const share = sumBlocks(participations, field);
    return { revenue, expense, operating, finance, beforeTax, tax, share, afterTax: beforeTax - tax + share };
  };
  const cur = totals('current');
  const prev = totals('previous');

  // Een IB-onderneming heeft doorgaans geen financiële rubrieken en geen
  // vennootschapsbelasting; die secties dan weglaten houdt het overzicht kort.
  const hasFinancial = financial.length > 0;
  const hasTaxes = taxes.length > 0;
  const hasParticipations = participations.length > 0;
  const hasBelowOperating = hasFinancial || hasTaxes || hasParticipations;

  const exportCsv = () => {
    const lines: (string | number)[][] = [];
    const push = (section: string, name: string, c: number, p: number) =>
      lines.push([section, name, (c / 100).toFixed(2), (p / 100).toFixed(2)]);
    for (const block of income) {
      for (const row of block.rows) push(REPORT_GROUP_LABELS[block.group], row.name, row.current, row.previous);
      push(REPORT_GROUP_LABELS[block.group], `Totaal ${REPORT_GROUP_LABELS[block.group].toLowerCase()}`, block.current, block.previous);
    }
    push('', 'Som der bedrijfsopbrengsten', cur.revenue, prev.revenue);
    for (const block of costs) {
      for (const row of block.rows) push(REPORT_GROUP_LABELS[block.group], row.name, -row.current, -row.previous);
      push(REPORT_GROUP_LABELS[block.group], `Totaal ${REPORT_GROUP_LABELS[block.group].toLowerCase()}`, -block.current, -block.previous);
    }
    push('', 'Som der bedrijfslasten', cur.expense, prev.expense);
    push('', 'Bedrijfsresultaat', cur.operating, prev.operating);
    if (hasFinancial) {
      for (const block of financial) for (const row of block.rows) push('Financiële baten en lasten', row.name, row.current, row.previous);
      push('', 'Saldo financiële baten en lasten', cur.finance, prev.finance);
    }
    if (hasBelowOperating) push('', 'Resultaat voor belastingen', cur.beforeTax, prev.beforeTax);
    if (hasTaxes) push('', 'Belastingen', cur.tax, prev.tax);
    if (hasParticipations) push('', 'Aandeel in resultaat van deelnemingen', cur.share, prev.share);
    push('', hasBelowOperating ? 'Resultaat na belastingen' : 'Resultaat', cur.afterTax, prev.afterTax);
    downloadCsv(
      `winst-verlies-${period.current.label.replace(/\s/g, '-')}.csv`,
      ['Rubriek', 'Omschrijving', period.current.label, period.previous.label],
      lines,
    );
  };

  const line = (key: string, name: string, c: number, p: number, cls = '') => (
    <tr className={cls} key={key}>
      <td>{name}</td><td className="bk-num">{euroCents(c)}</td><td className="bk-num bk-muted">{euroCents(p)}</td>
    </tr>
  );

  /** Eén rubriek: kopregel met het subtotaal en de rekeningen eronder. */
  const groupBlock = (block: ReportGroupBlock, flip: boolean) => {
    const s = flip ? -1 : 1;
    return (
      <Fragment key={block.group}>
        <tr className="bk-balance-group">
          <td>{REPORT_GROUP_LABELS[block.group]}</td>
          <td className="bk-num">{euroCents(s * block.current)}</td>
          <td className="bk-num bk-muted">{euroCents(s * block.previous)}</td>
        </tr>
        {block.rows.map(row => (
          <tr className="bk-balance-sub" key={row.key}>
            <td>{row.name}</td>
            <td className="bk-num">{euroCents(s * row.current)}</td>
            <td className="bk-num bk-muted">{euroCents(s * row.previous)}</td>
          </tr>
        ))}
      </Fragment>
    );
  };

  return (
    <div className="bk-report">
      <div className="bk-report-bar">
        <div className="bk-report-kpis">
          <div><span>Bedrijfsresultaat {period.current.label}</span><strong className={cur.operating >= 0 ? 'bk-pos' : 'bk-neg'}>{euroCents(cur.operating)}</strong></div>
          {hasBelowOperating && <div><span>Resultaat na belastingen</span><strong className={cur.afterTax >= 0 ? 'bk-pos' : 'bk-neg'}>{euroCents(cur.afterTax)}</strong></div>}
        </div>
        <Button onClick={exportCsv}><Download size={14} /> Exporteer CSV</Button>
      </div>
      <div className="bk-table-wrap"><table className="bk-table bk-report-table">
        <thead><tr><th>Omschrijving</th><th className="bk-num">{period.current.label}</th><th className="bk-num">{period.previous.label}</th></tr></thead>
        <tbody>
          <tr className="bk-report-section"><td colSpan={3}>Bedrijfsopbrengsten</td></tr>
          {income.length
            ? income.map(block => groupBlock(block, false))
            : <tr><td colSpan={3} className="bk-muted">Geen opbrengsten in deze periode.</td></tr>}
          {line('som-opbrengsten', 'Som der bedrijfsopbrengsten', cur.revenue, prev.revenue, 'bk-report-total')}

          <tr className="bk-report-section"><td colSpan={3}>Bedrijfslasten</td></tr>
          {costs.length
            ? costs.map(block => groupBlock(block, true))
            : <tr><td colSpan={3} className="bk-muted">Geen kosten in deze periode.</td></tr>}
          {line('som-lasten', 'Som der bedrijfslasten', cur.expense, prev.expense, 'bk-report-total')}
          {line('bedrijfsresultaat', 'Bedrijfsresultaat', cur.operating, prev.operating, 'bk-report-total')}

          {hasFinancial && <>
            <tr className="bk-report-section"><td colSpan={3}>Financiële baten en lasten</td></tr>
            {financial.map(block => block.rows.map(row => line(`${block.group}-${row.key}`, row.name, row.current, row.previous)))}
            {line('saldo-financieel', 'Saldo financiële baten en lasten', cur.finance, prev.finance, 'bk-report-total')}
          </>}

          {hasBelowOperating && line('voor-belasting', 'Resultaat voor belastingen', cur.beforeTax, prev.beforeTax, 'bk-report-total')}
          {hasTaxes && <>
            <tr className="bk-report-section"><td colSpan={3}>Belastingen</td></tr>
            {taxes.map(block => block.rows.map(row => line(`${block.group}-${row.key}`, row.name, -row.current, -row.previous)))}
          </>}
          {/* Model E zet het aandeel in het resultaat van deelnemingen ná de
              belastingregel, vlak vóór het resultaat na belastingen. */}
          {hasParticipations && participations.map(block => block.rows.map(row => line(`${block.group}-${row.key}`, row.name, row.current, row.previous)))}
        </tbody>
        <tfoot>
          <tr className="bk-report-result">
            <td>{hasBelowOperating ? 'Resultaat na belastingen' : 'Resultaat'}</td>
            <td className={`bk-num ${cur.afterTax >= 0 ? 'bk-pos' : 'bk-neg'}`}>{euroCents(cur.afterTax)}</td>
            <td className="bk-num bk-muted">{euroCents(prev.afterTax)}</td>
          </tr>
        </tfoot>
      </table></div>
    </div>
  );
}

/**
 * Boekwaarde per activum op een peildatum: alleen afschrijvingen t/m die datum,
 * alleen activa aangeschaft t/m die datum en op die datum nog niet afgestoten —
 * zodat de sub-regels aansluiten op de datumgefilterde groepsregel uit het
 * grootboek.
 */
function bookValuesAt(data: AppData, asOf: string): Map<string, number> {
  const posted = new Map<string, number>();
  for (const d of data.assetDepreciations) {
    if (d.status === 'posted' && d.date <= asOf) posted.set(d.asset_id, (posted.get(d.asset_id) ?? 0) + d.amount_cents);
  }
  const values = new Map<string, number>();
  for (const a of data.fixedAssets) {
    if (a.acquisition_date > asOf) continue;
    if (a.status === 'disposed' && a.disposal_date != null && a.disposal_date <= asOf) continue;
    values.set(a.id, a.acquisition_cost_cents - (posted.get(a.id) ?? 0));
  }
  return values;
}

/**
 * Balans ingedeeld volgens de hoofdindeling van art. 2:364 BW: per rubriek een
 * subtotaal, met de vergelijkende cijfers van de vorige periode ernaast
 * (art. 2:363 lid 5 BW).
 *
 * De KANT van de balans komt uit `section` en niet uit de rubriek: zo staat een
 * verkeerd gerubriceerde rekening hooguit onder de verkeerde kop, maar nooit aan
 * de verkeerde kant — en blijft het balanstotaal kloppen.
 */
function BalanceReport({ rows, previousRows, period, data }: {
  rows: BalanceSheetRow[]; previousRows: BalanceSheetRow[]; period: { current: PeriodBounds; previous: PeriodBounds }; data: AppData;
}) {
  const [assetsExpanded, setAssetsExpanded] = useState(false);
  const asOf = period.current.to;
  const prevAsOf = period.previous.to;

  const onAssetSide = (row: BalanceSheetRow) => row.section === 'asset';
  const onLiabilitySide = (row: BalanceSheetRow) => row.section !== 'asset';

  const assetGroups = groupRows(rows, previousRows, () => 1, onAssetSide);
  const passivaGroups = groupRows(rows, previousRows, () => 1, onLiabilitySide);

  const totalAssets = sumBlocks(assetGroups, 'current');
  const totalPassiva = sumBlocks(passivaGroups, 'current');
  const totalAssetsPrev = sumBlocks(assetGroups, 'previous');
  const totalPassivaPrev = sumBlocks(passivaGroups, 'previous');
  const balanced = totalAssets === totalPassiva;

  // De activamodule kent per activum een boekwaarde; die tonen we als
  // uitklapbare toelichting onder de rubriek waar het activum ook echt staat.
  // Software op 0020 hoort bij de immateriële vaste activa, een machine op 0100
  // bij de materiële — ze allemaal onder één kop zetten zou sub-regels geven die
  // niet optellen tot de rubriek erboven.
  const bookValues = bookValuesAt(data, asOf);
  const bookValuesPrev = bookValuesAt(data, prevAsOf);
  const groupByAccount = new Map(data.ledgerAccounts.map(a => [a.id, a.report_group]));
  const perAssetByGroup = new Map<LedgerReportGroup, { id: string; name: string; current: number; previous: number }[]>();
  for (const a of data.fixedAssets) {
    if (!bookValues.has(a.id) && !bookValuesPrev.has(a.id)) continue;
    const group = (a.asset_account_id ? groupByAccount.get(a.asset_account_id) : null) ?? 'materiele_vaste_activa';
    const list = perAssetByGroup.get(group) ?? [];
    list.push({
      id: a.id,
      name: a.asset_number ? `${a.asset_number} · ${a.name}` : a.name,
      current: bookValues.get(a.id) ?? 0,
      previous: bookValuesPrev.get(a.id) ?? 0,
    });
    perAssetByGroup.set(group, list);
  }
  for (const list of perAssetByGroup.values()) list.sort((x, y) => x.name.localeCompare(y.name));

  const exportCsv = () => {
    const lines: (string | number)[][] = [];
    const push = (side: string, group: string, name: string, c: number, p: number) =>
      lines.push([side, group, name, (c / 100).toFixed(2), (p / 100).toFixed(2)]);
    for (const block of assetGroups) {
      for (const row of block.rows) push('Activa', REPORT_GROUP_LABELS[block.group], row.name, row.current, row.previous);
      push('Activa', REPORT_GROUP_LABELS[block.group], `Totaal ${REPORT_GROUP_LABELS[block.group].toLowerCase()}`, block.current, block.previous);
    }
    push('Activa', '', 'Totaal activa', totalAssets, totalAssetsPrev);
    for (const block of passivaGroups) {
      for (const row of block.rows) push('Passiva', REPORT_GROUP_LABELS[block.group], row.name, row.current, row.previous);
      push('Passiva', REPORT_GROUP_LABELS[block.group], `Totaal ${REPORT_GROUP_LABELS[block.group].toLowerCase()}`, block.current, block.previous);
    }
    push('Passiva', '', 'Totaal passiva', totalPassiva, totalPassivaPrev);
    for (const [group, list] of perAssetByGroup) {
      for (const a of list) push('Toelichting', `Boekwaarde per activum · ${REPORT_GROUP_LABELS[group]}`, a.name, a.current, a.previous);
    }
    downloadCsv(
      `balans-${period.current.label.replace(/\s/g, '-')}.csv`,
      ['Kant', 'Rubriek', 'Omschrijving', period.current.label, period.previous.label],
      lines,
    );
  };

  /** Eén rubriek met subtotaal in de kop en de rekeningen eronder. */
  const groupBlock = (block: ReportGroupBlock, extra?: React.ReactNode) => (
    <Fragment key={block.group}>
      <tr className="bk-balance-group">
        <td>{REPORT_GROUP_LABELS[block.group]}</td>
        <td className="bk-num">{euroCents(block.current)}</td>
        <td className="bk-num bk-muted">{euroCents(block.previous)}</td>
      </tr>
      {block.rows.map(row => (
        <tr className="bk-balance-sub" key={row.key}>
          <td>{row.name}</td>
          <td className="bk-num">{euroCents(row.current)}</td>
          <td className="bk-num bk-muted">{euroCents(row.previous)}</td>
        </tr>
      ))}
      {extra}
    </Fragment>
  );

  const assetDetail = (group: LedgerReportGroup) => {
    const list = perAssetByGroup.get(group);
    if (!list?.length) return null;
    return (
      <>
        <tr className="bk-balance-sub bk-link" onClick={() => setAssetsExpanded(e => !e)} title="Boekwaarde per activum tonen">
          <td>
            <span className="bk-group-toggle">{assetsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
            {' '}Boekwaarde per activum
          </td>
          <td colSpan={2}></td>
        </tr>
        {assetsExpanded && list.map(a => (
          <tr className="bk-balance-sub" key={a.id}>
            <td>{a.name}</td>
            <td className="bk-num">{euroCents(a.current)}</td>
            <td className="bk-num bk-muted">{euroCents(a.previous)}</td>
          </tr>
        ))}
      </>
    );
  };

  return (
    <div className="bk-report">
      <div className="bk-report-bar">
        <div className="bk-report-kpis">
          <div><span>Balanstotaal per {period.current.label}</span><strong>{euroCents(totalAssets)}</strong></div>
          <div className={balanced ? 'bk-balance-ok' : 'bk-balance-bad'}>{balanced ? '✓ In balans' : `⚠ Verschil ${euroCents(totalAssets - totalPassiva)}`}</div>
        </div>
        <Button onClick={exportCsv}><Download size={14} /> Exporteer CSV</Button>
      </div>
      <div className="bk-balance-cols">
        <div className="bk-table-wrap"><table className="bk-table bk-report-table">
          <thead><tr><th>Activa</th><th className="bk-num">{dateNL(asOf)}</th><th className="bk-num">{dateNL(prevAsOf)}</th></tr></thead>
          <tbody>
            {assetGroups.length
              ? assetGroups.map(block => groupBlock(block, assetDetail(block.group)))
              : <tr><td colSpan={3} className="bk-muted">Geen activa.</td></tr>}
          </tbody>
          <tfoot><tr className="bk-report-result">
            <td>Totaal activa</td>
            <td className="bk-num">{euroCents(totalAssets)}</td>
            <td className="bk-num bk-muted">{euroCents(totalAssetsPrev)}</td>
          </tr></tfoot>
        </table></div>
        <div className="bk-table-wrap"><table className="bk-table bk-report-table">
          <thead><tr><th>Passiva</th><th className="bk-num">{dateNL(asOf)}</th><th className="bk-num">{dateNL(prevAsOf)}</th></tr></thead>
          <tbody>
            {passivaGroups.length
              ? passivaGroups.map(block => groupBlock(block))
              : <tr><td colSpan={3} className="bk-muted">Geen passiva.</td></tr>}
          </tbody>
          <tfoot><tr className="bk-report-result">
            <td>Totaal passiva</td>
            <td className="bk-num">{euroCents(totalPassiva)}</td>
            <td className="bk-num bk-muted">{euroCents(totalPassivaPrev)}</td>
          </tr></tfoot>
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
