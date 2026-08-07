import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Download, FilePlus2, Globe2, Landmark, Lock } from 'lucide-react';
import type { AppData, IcpDeclaration, VatReturn, VatReturnBox, VatReturnRubrieken } from '../types';
import { Button, Skeleton, Textarea } from '../components/Ui';
import { Modal } from '../components/Modal';
import { dateNL, euro } from '../lib/format';
import { downloadCsv } from '../lib/csv';
import {
  closeVatPeriod, computeIcpDeclaration, computeVatReturn, computeVatSupplementDelta, createVatSupplement,
  ensureDefaultLedgerAccounts, listVatSupplementEntries, updateRow,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
/** Rekenkundig afronden mét .50 weg van nul (zoals Postgres' numeric round()); JS Math.round rondt negatieve .50 juist naar +Infinity, dus -0,50 zou anders fout worden afgerond. */
const roundHalfAwayFromZero = (n: number) => (n < 0 ? -Math.round(-n) : Math.round(n));
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

/** Rubrieken van het aangifteformulier. Exotische rubrieken (1c/1d/3c) verschijnen alleen met een saldo. */
const BOX_ROWS: { box: string; label: string; hasVat: boolean; alwaysShow: boolean }[] = [
  { box: '1a', label: 'Leveringen/diensten belast met hoog tarief', hasVat: true, alwaysShow: true },
  { box: '1b', label: 'Leveringen/diensten belast met laag tarief', hasVat: true, alwaysShow: true },
  { box: '1c', label: 'Leveringen/diensten belast met overige tarieven', hasVat: true, alwaysShow: false },
  { box: '1d', label: 'Privégebruik', hasVat: true, alwaysShow: false },
  { box: '1e', label: 'Leveringen/diensten belast met 0% of niet bij u belast', hasVat: false, alwaysShow: true },
  { box: '2a', label: 'Leveringen/diensten waarbij de btw naar u is verlegd', hasVat: true, alwaysShow: true },
  { box: '3a', label: 'Leveringen naar landen buiten de EU (uitvoer)', hasVat: false, alwaysShow: false },
  { box: '3b', label: 'Leveringen naar/diensten in landen binnen de EU', hasVat: false, alwaysShow: false },
  { box: '3c', label: 'Installatie/afstandsverkopen binnen de EU', hasVat: false, alwaysShow: false },
  { box: '4a', label: 'Leveringen/diensten uit landen buiten de EU', hasVat: true, alwaysShow: false },
  { box: '4b', label: 'Verwervingen uit landen binnen de EU', hasVat: true, alwaysShow: false },
];
const BOX_SECTION: Record<string, string> = {
  '1a': 'Prestaties binnenland — verschuldigde omzetbelasting',
  '2a': 'Verleggingsregelingen binnenland',
  '3a': 'Prestaties naar of in het buitenland',
  '4a': 'Prestaties vanuit het buitenland aan u verricht',
};

const formBox = (r: VatReturnRubrieken, box: string): VatReturnBox | null => {
  const v = r.form?.[box];
  return v && typeof v === 'object' ? v : null;
};
const formTotal = (r: VatReturnRubrieken, key: string): number | null => {
  const v = r.form?.[key];
  return typeof v === 'number' ? v : null;
};

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
  const [showSupplement, setShowSupplement] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [icp, setIcp] = useState<IcpDeclaration | null>(null);
  const [icpLoading, setIcpLoading] = useState(false);

  const period = useMemo(() => bounds(view, year, month, quarter), [view, year, month, quarter]);
  // Suppleties zijn extra rijen voor dezelfde periode; de primaire aangifte is de rij zónder supplements_return_id.
  const existing = useMemo(
    () => data.vatReturns.find(r => r.period_type === period.dbType && r.year === year && r.period_index === period.index && !r.supplements_return_id) ?? null,
    [data.vatReturns, period, year],
  );
  const supplements = useMemo(
    () => (existing ? data.vatReturns.filter(r => r.supplements_return_id === existing.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : []),
    [data.vatReturns, existing],
  );
  // Overlapt de gekozen periode een AL afgesloten aangifteperiode (bijv. maand
  // januari terwijl Q1 al is afgesloten)? Dan mag ze niet nog eens afgesloten worden
  // — anders ontstaat een overlappende, dubbele periode-lock.
  const overlapsClosed = useMemo(
    () => data.closedPeriods.some(cp => cp.period_start != null && cp.period_end != null
      && !(period.to < cp.period_start || period.from > cp.period_end)),
    [data.closedPeriods, period],
  );

  const load = useCallback(async () => {
    setIcp(null);
    if (existing) { setLive(existing.rubrieken); return; }
    setLoading(true); setError(null);
    try { setLive(await computeVatReturn(organizationId, period.from, period.to)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Berekenen mislukt'); setLive(null); }
    finally { setLoading(false); }
  }, [organizationId, period, existing]);

  useEffect(() => { if (data.ledgerAccounts.length > 0) void load(); }, [load, data.ledgerAccounts.length]);

  const loadIcp = useCallback(async () => {
    setIcpLoading(true);
    try { setIcp(await computeIcpDeclaration(organizationId, period.from, period.to)); }
    catch (e) { setError(e instanceof Error ? e.message : 'ICP-opgaaf berekenen mislukt'); }
    finally { setIcpLoading(false); }
  }, [organizationId, period]);

  // 3b gevuld → de ICP-opgaaf hoort erbij; automatisch meeladen.
  const icpRelevant = ((live?.boxes?.['3b']?.base ?? 0) !== 0);
  useEffect(() => { if (icpRelevant && !icp && !icpLoading) void loadIcp(); }, [icpRelevant, icp, icpLoading, loadIcp]);

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} onChanged={onChanged} /></div>;
  }

  const r = live;
  const saldo = r?.saldo ?? 0;
  // saldo_afgerond ontbreekt bij aangiftes van vóór deze afronding werd toegevoegd; dan
  // hier zelf afronden als indicatie (er is voor die periode niets op 4900 geboekt).
  const saldoAfgerond = r ? (r.saldo_afgerond ?? roundHalfAwayFromZero(r.saldo / 100) * 100) : 0;
  const afronding = r ? (r.afronding_cents ?? r.saldo - saldoAfgerond) : 0;
  const finalized = existing != null;
  const afrondingGeboekt = finalized && existing!.rubrieken.saldo_afgerond != null;
  const hasBoxes = Boolean(r?.boxes);

  async function setStatus(target: VatReturn, status: VatReturn['status']) {
    if (!canWrite) return;
    setBusy(true); setError(null);
    try { await updateRow<VatReturn>('vat_returns', target.id, { status }, organizationId); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Status bijwerken mislukt'); }
    finally { setBusy(false); }
  }

  // Zichtbare rubriekrijen, met de sectiekop vóór de eerste zichtbare rij van elk blok.
  const boxTableRows: React.ReactNode[] = [];
  if (r?.boxes) {
    let pendingSection: string | undefined;
    for (const def of BOX_ROWS) {
      if (BOX_SECTION[def.box]) pendingSection = BOX_SECTION[def.box];
      const b = r.boxes[def.box];
      const base = b?.base ?? 0;
      const vat = b?.vat ?? 0;
      if (!def.alwaysShow && base === 0 && vat === 0) continue;
      if (pendingSection) {
        boxTableRows.push(<tr className="bk-report-section" key={`sec-${def.box}`}><td colSpan={5}>{pendingSection}</td></tr>);
        pendingSection = undefined;
      }
      const f = formBox(r, def.box);
      boxTableRows.push(
        <tr key={def.box}>
          <td>{def.box}</td>
          <td>{def.label}</td>
          <td className="bk-num">{euroCents(base)}</td>
          <td className="bk-num">{def.hasVat ? euroCents(vat) : '—'}</td>
          <td className="bk-num bk-muted">{f ? (def.hasVat ? `€ ${f.vat ?? 0}` : `€ ${f.base}`) : ''}</td>
        </tr>,
      );
    }
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

      <details className="bk-vat-overview">
        <summary>Jaaroverzicht {year} — alle {view === 'monthly' ? 'maanden' : 'kwartalen'} in één oogopslag</summary>
        <div className="bk-table-wrap">
          <table className="bk-table">
            <thead><tr><th>Periode</th><th>Status</th><th className="bk-num">Saldo (afgerond)</th></tr></thead>
            <tbody>
              {(view === 'monthly' ? MONTHS.map((m, i) => ({ index: i + 1, label: m })) : [1, 2, 3, 4].map(q => ({ index: q, label: `Q${q}` }))).map(p => {
                const ret = data.vatReturns.find(vr => vr.year === year && vr.period_type === (view === 'monthly' ? 'month' : 'quarter') && vr.period_index === p.index && !vr.supplements_return_id);
                const saldoC = ret ? Number(ret.rubrieken?.saldo_afgerond ?? ret.rubrieken?.saldo ?? 0) : null;
                const isCur = p.index === (view === 'monthly' ? month : quarter);
                return (
                  <tr key={p.index} className={isCur ? 'is-active' : ''} style={{ cursor: 'pointer' }} onClick={() => view === 'monthly' ? setMonth(p.index) : setQuarter(p.index)}>
                    <td>{p.label}</td>
                    <td>{ret ? <span className={`status-pill bk-vat-${ret.status}`}>{statusLabel[ret.status]}</span> : <span className="bk-muted">Nog niet aangegeven</span>}</td>
                    <td className="bk-num">{saldoC != null ? `${euroCents(Math.abs(saldoC))}${saldoC > 0 ? ' te betalen' : saldoC < 0 ? ' terug' : ''}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>

      {loading || !r
        ? <div className="bk-muted bk-report-loading"><Skeleton lines={5} /></div>
        : <>
          <div className="bk-report-bar">
            <div className="bk-report-kpis">
              <div><span>Saldo {period.label}</span><strong className={saldoAfgerond > 0 ? 'bk-neg' : 'bk-pos'}>{euroCents(Math.abs(saldoAfgerond))}</strong></div>
              <div className={saldoAfgerond > 0 ? 'bk-balance-bad' : 'bk-balance-ok'}>{saldoAfgerond > 0 ? 'Te betalen' : saldoAfgerond < 0 ? 'Terug te ontvangen' : 'Nihil'}</div>
            </div>
            {!finalized && !overlapsClosed && canWrite && <Button variant="primary" onClick={() => setShowClose(true)} disabled={busy}><Landmark size={14} /> Periode afsluiten</Button>}
            {!finalized && overlapsClosed && <span className="bk-muted">Deze periode valt binnen een al afgesloten aangifteperiode.</span>}
            {finalized && existing!.status === 'finalized' && canWrite && <Button onClick={() => setStatus(existing!, 'filed')} disabled={busy}><CheckCircle2 size={14} /> Markeer als ingediend</Button>}
            {finalized && existing!.status === 'filed' && canWrite && <Button onClick={() => setStatus(existing!, 'paid')} disabled={busy}><CheckCircle2 size={14} /> Markeer als betaald</Button>}
          </div>

          {hasBoxes && r.boxes_consistent === false && (
            <div className="bk-note"><AlertTriangle size={14} /> De rubriekverdeling sluit niet aan op het grootboek (verschil {euroCents(Math.abs(r.boxes_vat_diff_cents ?? 0))} op 1510/1520). Waarschijnlijk is er rechtstreeks op een BTW-rekening geboekt zonder btw-code. Het af te dragen bedrag is daarom op het totaal afgerond; controleer de rubrieken vóór het indienen.</div>
          )}

          {hasBoxes ? (
            <div className="bk-table-wrap"><table className="bk-table bk-report-table">
              <thead><tr><th>Rubriek</th><th>Omschrijving</th><th className="bk-num">Grondslag</th><th className="bk-num">BTW</th><th className="bk-num">Aangifte (hele €)</th></tr></thead>
              <tbody>
                {boxTableRows}
                <tr className="bk-report-total"><td>5a</td><td>Verschuldigde omzetbelasting</td><td className="bk-num" /><td className="bk-num">{euroCents(r.verschuldigd_total)}</td><td className="bk-num bk-muted">{formTotal(r, '5a') != null ? `€ ${formTotal(r, '5a')}` : ''}</td></tr>
                <tr className="bk-report-total"><td>5b</td><td>Voorbelasting</td><td className="bk-num" /><td className="bk-num">{euroCents(r.voorbelasting)}</td><td className="bk-num bk-muted">{formTotal(r, '5b') != null ? `€ ${formTotal(r, '5b')}` : ''}</td></tr>
              </tbody>
              <tfoot>
                <tr className="bk-report-result"><td>5c</td><td>Saldo (5a − 5b)</td><td className="bk-num" /><td className={`bk-num ${saldo > 0 ? 'bk-neg' : 'bk-pos'}`}>{euroCents(Math.abs(saldo))}</td><td className="bk-num bk-muted">{formTotal(r, '5c') != null ? `€ ${formTotal(r, '5c')}` : ''}</td></tr>
                <tr className="bk-report-result"><td /><td>{saldoAfgerond >= 0 ? 'Af te dragen' : 'Terug te ontvangen'} (hele euro's per rubriek)</td><td className="bk-num" /><td className={`bk-num ${saldoAfgerond > 0 ? 'bk-neg' : 'bk-pos'}`} colSpan={2}>{euroCents(Math.abs(saldoAfgerond))}</td></tr>
              </tfoot>
            </table></div>
          ) : (
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
              <tfoot>
                <tr className="bk-report-result"><td>5c</td><td>Berekend saldo</td><td className="bk-num" /><td className={`bk-num ${saldo > 0 ? 'bk-neg' : 'bk-pos'}`}>{euroCents(Math.abs(saldo))}</td></tr>
                <tr className="bk-report-result"><td /><td>{saldoAfgerond >= 0 ? 'Af te dragen' : 'Terug te ontvangen'} (afgerond op hele euro's)</td><td className="bk-num" /><td className={`bk-num ${saldoAfgerond > 0 ? 'bk-neg' : 'bk-pos'}`}>{euroCents(Math.abs(saldoAfgerond))}</td></tr>
              </tfoot>
            </table></div>
          )}

          {afronding !== 0 && !finalized && (
            <p className="bk-muted">Afrondingsverschil van {euroCents(Math.abs(afronding))} gaat bij het doorboeken naar grootboekrekening 4900 (Afrondingsverschillen).</p>
          )}
          {afronding !== 0 && afrondingGeboekt && (
            <p className="bk-muted">Afrondingsverschil van {euroCents(Math.abs(afronding))} is bij het doorboeken geboekt op grootboekrekening 4900 (Afrondingsverschillen).</p>
          )}

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
          {finalized && existing!.filed_at && (
            <p className="bk-muted">Als ingediend bevestigd op {dateNL(existing!.filed_at)} — de OB-aangifte voor deze periode is door jullie zelf bij de Belastingdienst ingediend.</p>
          )}
          {finalized && <p className="bk-muted">Deze periode is vergrendeld. Boek een nagekomen post gewoon op de datum van vandaag: die telt automatisch mee in de eerstvolgende aangifte (kleine correctie), of verreken hem hieronder in een formele suppletie.</p>}

          {/* ---------------- Suppleties ---------------- */}
          {finalized && (
            <section className="bk-subsection">
              <div className="bk-subhead">
                <div>
                  <h3>Suppleties {period.label}</h3>
                  <p className="bk-muted">Corrigeer een al ingediende aangifte: kies de correctieboekstukken; het btw-effect wordt doorgeboekt naar “Te betalen omzetbelasting” en de boekstukken tellen niet meer mee in de reguliere aangifte. Wettelijk verplicht zodra de correctie per saldo meer dan € 1.000 is.</p>
                </div>
                {canWrite && <Button onClick={() => setShowSupplement(true)}><FilePlus2 size={14} /> Suppletie aanmaken</Button>}
              </div>
              {supplements.length === 0
                ? <p className="bk-muted">Nog geen suppleties voor deze periode.</p>
                : <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr><th>Datum</th><th>Boekstukken</th><th className="bk-num">Saldo</th><th>Status</th><th>Notitie</th><th /></tr></thead>
                  <tbody>{supplements.map(s => {
                    const sSaldo = s.rubrieken.saldo_afgerond ?? s.rubrieken.saldo ?? 0;
                    return (
                      <tr key={s.id}>
                        <td>{dateNL(s.created_at)}</td>
                        <td>{(s.rubrieken.entry_ids?.length ?? 0)} boekstuk(ken)</td>
                        <td className={`bk-num ${sSaldo > 0 ? 'bk-neg' : 'bk-pos'}`}>{sSaldo > 0 ? 'Te betalen ' : sSaldo < 0 ? 'Terug ' : ''}{euroCents(Math.abs(sSaldo))}</td>
                        <td><span className={`status-pill bk-vat-${s.status}`}>{statusLabel[s.status]}</span></td>
                        <td className="bk-muted">{s.notes || '—'}</td>
                        <td>
                          {canWrite && s.status === 'finalized' && <Button onClick={() => setStatus(s, 'filed')} disabled={busy}>Ingediend</Button>}
                          {canWrite && s.status === 'filed' && <Button onClick={() => setStatus(s, 'paid')} disabled={busy}>Betaald</Button>}
                        </td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>}
            </section>
          )}

          {/* ---------------- ICP-opgaaf ---------------- */}
          <section className="bk-subsection">
            <div className="bk-subhead">
              <div>
                <h3><Globe2 size={15} /> ICP-opgaaf {period.label}</h3>
                <p className="bk-muted">Opgaaf intracommunautaire prestaties: leveringen (ICP goederen) en diensten (ICP diensten) per EU-afnemer. Hoort aan te sluiten op rubriek 3b.</p>
              </div>
              {!icp && <Button onClick={loadIcp} disabled={icpLoading}>{icpLoading ? 'Berekenen…' : 'ICP-opgaaf berekenen'}</Button>}
              {icp && icp.rows.length > 0 && <Button onClick={() => downloadCsv(
                `icp-opgaaf-${period.label.replace(/\s/g, '-')}.csv`,
                ['Afnemer', 'Land', 'BTW-nummer', 'Goederen', 'Diensten'],
                icp.rows.map(row => [row.client_name, row.country ?? '', row.vat_number ?? '', (row.goods_cents / 100).toFixed(2), (row.services_cents / 100).toFixed(2)]),
              )}><Download size={14} /> CSV</Button>}
            </div>
            {icp && (icp.rows.length === 0
              ? <p className="bk-muted">Geen intracommunautaire prestaties in deze periode.</p>
              : <>
                {icp.missing_vat_numbers > 0 && <div className="bk-note"><AlertTriangle size={14} /> {icp.missing_vat_numbers} afnemer(s) zonder btw-nummer — vul het btw-nummer aan op de klantkaart; zonder btw-nummer is de ICP-opgaaf (en het 0%-tarief) niet geldig.</div>}
                {icp.unassigned_cents !== 0 && <div className="bk-note"><AlertTriangle size={14} /> {euroCents(icp.unassigned_cents)} aan ICP-omzet is niet aan een klant gekoppeld (vrije boeking zonder klant) en kan niet in de opgaaf worden opgenomen.</div>}
                <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr><th>Afnemer</th><th>Land</th><th>BTW-nummer</th><th className="bk-num">Goederen (3b)</th><th className="bk-num">Diensten (3b)</th></tr></thead>
                  <tbody>{icp.rows.map((row, i) => (
                    <tr key={row.client_id ?? i}>
                      <td>{row.client_name}</td>
                      <td>{row.country ?? '—'}</td>
                      <td>{row.vat_number || <span className="bk-neg">⚠ ontbreekt</span>}</td>
                      <td className="bk-num">{euroCents(row.goods_cents)}</td>
                      <td className="bk-num">{euroCents(row.services_cents)}</td>
                    </tr>
                  ))}</tbody>
                  <tfoot><tr className="bk-report-total"><td colSpan={3}>Totaal</td><td className="bk-num">{euroCents(icp.goods_total_cents)}</td><td className="bk-num">{euroCents(icp.services_total_cents)}</td></tr></tfoot>
                </table></div>
              </>)}
          </section>
        </>}

      {showSupplement && existing && (
        <SupplementModal
          data={data}
          organizationId={organizationId}
          originalReturn={existing}
          onClose={() => setShowSupplement(false)}
          onCreated={() => { setShowSupplement(false); onChanged(); }}
        />
      )}

      {showClose && r && (
        <ClosePeriodModal
          organizationId={organizationId}
          periodLabel={period.label}
          period={{ periodType: period.dbType, year, periodIndex: period.index, from: period.from, to: period.to }}
          saldoAfgerond={saldoAfgerond}
          onClose={() => setShowClose(false)}
          onClosed={() => { setShowClose(false); onChanged(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────── Periode-afsluiten-modal ───────────────────────────────

function ClosePeriodModal({ organizationId, periodLabel, period, saldoAfgerond, onClose, onClosed }: {
  organizationId: string;
  periodLabel: string;
  period: { periodType: 'month' | 'quarter'; year: number; periodIndex: number; from: string; to: string };
  saldoAfgerond: number;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!attested || busy) return;
    setBusy(true); setError(null);
    try { await closeVatPeriod(organizationId, period); onClosed(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Afsluiten mislukt'); }
    finally { setBusy(false); }
  }

  const bedrag = euroCents(Math.abs(saldoAfgerond));
  const richting = saldoAfgerond > 0 ? 'Af te dragen' : saldoAfgerond < 0 ? 'Terug te ontvangen' : 'Nihil';

  return (
    <Modal title={`Periode afsluiten — ${periodLabel}`} onClose={onClose}>
      <p className="bk-muted">
        ResoFly verstuurt de aangifte niet elektronisch. Sluit de periode pas af zodra je de
        OB-aangifte zelf bij de Belastingdienst hebt ingediend — zo blijft je grootboek gelijk
        met wat je hebt aangegeven.
      </p>

      <div className="bk-supplement-delta">
        <strong>{richting}</strong>
        <p className={saldoAfgerond > 0 ? 'bk-neg' : saldoAfgerond < 0 ? 'bk-pos' : 'bk-muted'}>{bedrag}</p>
      </div>

      {error && <div className="error">{error}</div>}

      <label className="bk-check">
        <input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} />
        <span>Ik bevestig dat ik de OB-aangifte voor {periodLabel} bij de Belastingdienst heb ingediend.</span>
      </label>

      <p className="bk-muted">
        {saldoAfgerond === 0
          ? 'Bij afsluiten wordt de periode vergrendeld (nihilaangifte — er wordt niets doorgeboekt).'
          : `Bij afsluiten wordt ${bedrag} doorgeboekt naar “Te betalen omzetbelasting” en wordt de periode vergrendeld.`}
        {' '}Nagekomen boekingen schuiven daarna automatisch naar de eerstvolgende open datum.
      </p>

      <div className="bk-modal-actions">
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" onClick={submit} disabled={!attested || busy}>
          <Landmark size={14} /> {busy ? 'Bezig…' : 'Afsluiten & doorboeken'}
        </Button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────── Suppletie-modal ───────────────────────────────

function SupplementModal({ data, organizationId, originalReturn, onClose, onCreated }: {
  data: AppData;
  organizationId: string;
  originalReturn: VatReturn;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [attributed, setAttributed] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyAfterPeriod, setOnlyAfterPeriod] = useState(true);
  const [delta, setDelta] = useState<VatReturnRubrieken | null>(null);
  const [deltaLoading, setDeltaLoading] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listVatSupplementEntries(organizationId)
      .then(rows => { if (!cancelled) setAttributed(new Set(rows.map(row => row.entry_id))); })
      .catch(() => { if (!cancelled) setAttributed(new Set()); });
    return () => { cancelled = true; };
  }, [organizationId]);

  // Netto btw-saldo-effect per boekstuk (indicatief, uit de geladen journaalregels).
  const vatEffectByEntry = useMemo(() => {
    const bySubtype = new Map(data.ledgerAccounts.map(a => [a.id, a.subtype]));
    const map = new Map<string, number>();
    for (const line of data.journalLines) {
      const subtype = bySubtype.get(line.account_id);
      if (subtype !== 'vat_output' && subtype !== 'vat_reverse' && subtype !== 'vat_input') continue;
      const effect = subtype === 'vat_input'
        ? -(line.debit_cents - line.credit_cents)
        : (line.credit_cents - line.debit_cents);
      map.set(line.entry_id, (map.get(line.entry_id) ?? 0) + effect);
    }
    return map;
  }, [data.journalLines, data.ledgerAccounts]);

  const candidates = useMemo(() => {
    if (!attributed) return [];
    return data.journalEntries
      .filter(e => e.status === 'posted'
        && !e.reversed_by_entry_id
        // Systeemboekstukken horen niet in een suppletie. Een resultaat-
        // bestemming raakt alleen eigen vermogen en schulden: btw-effect nul,
        // maar hem aanvinken sluit hem wél permanent uit de reguliere aangifte.
        && !['year_close', 'vat_return', 'opening_balance', 'result_appropriation', 'corporate_tax', 'dga_interest'].includes(e.source_type)
        && !attributed.has(e.id)
        && (!onlyAfterPeriod || e.date > originalReturn.period_end))
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [data.journalEntries, attributed, onlyAfterPeriod, originalReturn.period_end]);

  useEffect(() => {
    const ids = [...selected];
    if (ids.length === 0) { setDelta(null); return; }
    let cancelled = false;
    setDeltaLoading(true);
    computeVatSupplementDelta(organizationId, ids)
      .then(result => { if (!cancelled) setDelta(result); })
      .catch(e => { if (!cancelled) { setDelta(null); setError(e instanceof Error ? e.message : 'Delta berekenen mislukt'); } })
      .finally(() => { if (!cancelled) setDeltaLoading(false); });
    return () => { cancelled = true; };
  }, [selected, organizationId]);

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setError(null);
  }

  async function submit() {
    if (selected.size === 0) return;
    const deltaSaldo = delta?.saldo_afgerond ?? delta?.saldo ?? 0;
    if (!confirm(`Suppletie definitief maken? Het btw-effect van ${selected.size} boekstuk(ken) wordt doorgeboekt naar “Te betalen omzetbelasting” (${deltaSaldo >= 0 ? 'te betalen' : 'terug te ontvangen'} ${euroCents(Math.abs(deltaSaldo))}) en deze boekstukken tellen niet meer mee in de reguliere aangifte.`)) return;
    setBusy(true); setError(null);
    try {
      await createVatSupplement(organizationId, {
        originalReturnId: originalReturn.id,
        entryIds: [...selected],
        notes: notes.trim() || null,
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Suppletie aanmaken mislukt');
    } finally {
      setBusy(false);
    }
  }

  const deltaSaldo = delta?.saldo_afgerond ?? delta?.saldo ?? 0;
  const deltaBoxes = delta?.boxes
    ? Object.entries(delta.boxes).filter(([, v]) => (v.base ?? 0) !== 0 || (v.vat ?? 0) !== 0)
    : [];

  return (
    <Modal title={`Suppletie ${originalReturn.period_type === 'quarter' ? `Q${originalReturn.period_index}` : MONTHS[originalReturn.period_index - 1]} ${originalReturn.year}`} onClose={onClose}>
      <p className="bk-muted">
        Kies de geboekte correctieboekstukken (bijvoorbeeld je memoriaal of een nagekomen inkoopfactuur) die bij deze periode horen.
        Boek een correctie dus eerst — via Grootboek → Memoriaal of door de factuur alsnog te boeken — en verreken hem daarna hier.
      </p>
      {error && <div className="error">{error}</div>}

      <label className="bk-check">
        <input type="checkbox" checked={onlyAfterPeriod} onChange={e => setOnlyAfterPeriod(e.target.checked)} />
        <span>Alleen boekstukken van ná {dateNL(originalReturn.period_end)} tonen</span>
      </label>

      {attributed == null
        ? <div className="bk-muted bk-report-loading">Boekstukken laden…</div>
        : candidates.length === 0
          ? <p className="bk-muted">Geen (nieuwe) geboekte boekstukken gevonden om te verrekenen.</p>
          : <div className="bk-supplement-list">
            {candidates.map(entry => {
              const effect = vatEffectByEntry.get(entry.id) ?? 0;
              return (
                <label key={entry.id} className="bk-supplement-row">
                  <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggle(entry.id)} />
                  <span className="bk-supplement-main">
                    <strong>{entry.entry_number}</strong> · {dateNL(entry.date)} · {entry.description || '—'}
                  </span>
                  <span className={`bk-num ${effect > 0 ? 'bk-neg' : effect < 0 ? 'bk-pos' : 'bk-muted'}`}>
                    {effect === 0 ? 'geen btw' : `${effect > 0 ? '+' : '−'}${euroCents(Math.abs(effect))} btw`}
                  </span>
                </label>
              );
            })}
          </div>}

      {selected.size > 0 && (
        <div className="bk-supplement-delta">
          <strong>Suppletie-effect</strong>
          {deltaLoading ? <span className="bk-muted"> berekenen…</span> : delta && (
            <>
              <div className="bk-supplement-chips">
                {deltaBoxes.map(([box, v]) => (
                  <span key={box} className="bk-chip">{box}: {euroCents(v.base)}{v.vat != null && v.vat !== 0 ? ` / btw ${euroCents(v.vat)}` : ''}</span>
                ))}
                {deltaBoxes.length === 0 && <span className="bk-muted">Geen rubriek-effect.</span>}
              </div>
              <p className={deltaSaldo > 0 ? 'bk-neg' : 'bk-pos'}>
                {deltaSaldo >= 0 ? 'Alsnog te betalen: ' : 'Terug te ontvangen: '}{euroCents(Math.abs(deltaSaldo))}
              </p>
            </>
          )}
        </div>
      )}

      <label className="bk-field"><span>Notitie (optioneel)</span>
        <Textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Bijv. vergeten inkoopfactuur maart" />
      </label>

      <div className="bk-modal-actions">
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" onClick={submit} disabled={busy || selected.size === 0 || deltaLoading}>
          {busy ? 'Bezig…' : 'Suppletie definitief maken'}
        </Button>
      </div>
    </Modal>
  );
}
