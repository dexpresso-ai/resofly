import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Coins, Download, RotateCcw, Scale } from 'lucide-react';
import type {
  DividendDistributionLine, DividendDistributionRow, DividendKind,
  ResultAppropriationRow, ShareholderPosition,
} from '../types';
import { Button, Input, Select } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import {
  declareDividend, dividendTaxRateOn, listDividendDistributions, listResultAppropriations,
  loadDividendDistributionLines, reverseDividendDistribution,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pct = (bp: number | null | undefined) => `${((bp ?? 0) / 100).toFixed(2).replace('.', ',')}%`;

/** Euro-invoer naar centen; accepteert zowel komma als punt. */
function parseEuro(value: string): number {
  const n = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/** Eén maand na de terbeschikkingstelling — art. 19 lid 3 AWR. */
function deadlineTone(deadline: string | null): 'warn' | 'muted' {
  if (!deadline) return 'muted';
  return deadline < new Date().toISOString().slice(0, 10) ? 'warn' : 'muted';
}

/**
 * Dividenduitkeringen.
 *
 * Twee wegen naar hetzelfde eindpunt. Uit de vastgestelde winst: de algemene
 * vergadering heeft het resultaat al bestemd en de schuld staat op 1580; hier
 * wordt alleen nog verdeeld en ingehouden. Tussentijds: het besluit ontstaat
 * hier, en dan gelden de balanstest én de bestuursgoedkeuring van art. 2:216 BW
 * alsnog volledig.
 *
 * De dividendbelasting (15%, art. 5 Wet DB 1965) wordt per aandeelhouder
 * berekend, want de inhoudingsvrijstelling van art. 4 Wet DB 1965 geldt per
 * ontvanger — bij een holdingstructuur houdt de werk-BV op de uitkering aan de
 * holding vaak niets in en op die aan een mens wel.
 */
export function Dividends({ organizationId, canWrite, canAdmin, positions, asOf, onChanged }: {
  organizationId: string;
  canWrite: boolean;
  canAdmin: boolean;
  positions: ShareholderPosition[];
  asOf: string;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<DividendDistributionRow[]>([]);
  const [appropriations, setAppropriations] = useState<ResultAppropriationRow[]>([]);
  const [detail, setDetail] = useState<{ row: DividendDistributionRow; lines: DividendDistributionLine[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ds, as] = await Promise.all([
        listDividendDistributions(organizationId),
        listResultAppropriations(organizationId).catch(() => [] as ResultAppropriationRow[]),
      ]);
      setRows(ds);
      setAppropriations(as);
    } catch (e) { setError(e instanceof Error ? e.message : 'Uitkeringen laden mislukt'); }
  }, [organizationId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Besluiten die wél dividend toekenden maar waarvan de uitkering nog niet is
   * vastgelegd. Zolang die er staan, staat het bruto bedrag nog onverdeeld op
   * 1580 en is er niets ingehouden.
   */
  const openAppropriations = useMemo(() => {
    const used = new Set(rows.filter(r => r.status === 'posted' && r.result_appropriation_id)
      .map(r => r.result_appropriation_id as string));
    return appropriations.filter(a => a.status === 'posted' && a.dividend_cents > 0 && !used.has(a.id));
  }, [rows, appropriations]);

  async function run(action: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); await load(); onChanged(); setMessage(ok); }
    catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt'); }
    finally { setBusy(false); }
  }

  async function openDetail(row: DividendDistributionRow) {
    setError(null);
    try {
      const lines = await loadDividendDistributionLines(organizationId, row.id);
      setDetail({ row, lines });
    } catch (e) { setError(e instanceof Error ? e.message : 'Regels laden mislukt'); }
  }

  return (
    <>
      <div className="bk-report">
        <div className="bk-subhead">
          <div>
            <h3>Dividend</h3>
            <p className="bk-muted">
              De vennootschap houdt de dividendbelasting in op het moment dat het dividend ter beschikking wordt gesteld
              (art. 7 lid 3 Wet DB 1965) en draagt die op aangifte af, uiterlijk één maand later (art. 19 lid 3 AWR).
              Het uitbetalen zelf en de afdracht lopen als gewone bankmutaties tegen 1580 en 1560.
            </p>
          </div>
          {canWrite && positions.length > 0 && (
            <Button onClick={() => { setShowForm(v => !v); setError(null); setMessage(null); }}>
              <Coins size={14} /> {showForm ? 'Sluiten' : 'Dividend uitkeren'}
            </Button>
          )}
        </div>

        {error && <div className="error">{error}</div>}
        {message && <p className="bk-note">{message}</p>}

        {openAppropriations.length > 0 && !showForm && (
          <p className="bk-neg">
            <AlertTriangle size={13} />{' '}
            {openAppropriations.length === 1
              ? `Het besluit van ${dateNL(openAppropriations[0].decision_date)} kende ${euroCents(openAppropriations[0].dividend_cents)} dividend toe, maar de uitkering is nog niet vastgelegd — er is dus nog niets ingehouden.`
              : `Er zijn ${openAppropriations.length} besluiten met toegekend dividend waarvan de uitkering nog niet is vastgelegd.`}
          </p>
        )}

        {positions.length === 0 && (
          <p className="bk-muted">Leg eerst het aandelenbezit vast; zonder aandeelhouders valt er niets te verdelen.</p>
        )}

        {showForm && canWrite && (
          <DividendForm
            organizationId={organizationId}
            positions={positions}
            asOf={asOf}
            openAppropriations={openAppropriations}
            busy={busy}
            onCancel={() => setShowForm(false)}
            onDone={async () => { setShowForm(false); await load(); onChanged(); setMessage('Dividend vastgelegd en geboekt.'); }}
          />
        )}

        {rows.length === 0
          ? <p className="bk-muted">Nog geen dividend uitgekeerd.</p>
          : <div className="bk-table-wrap"><table className="bk-table">
              <thead><tr>
                <th>Ter beschikking</th><th>Soort</th>
                <th className="bk-num">Bruto</th><th className="bk-num">Ingehouden</th><th className="bk-num">Netto</th>
                <th>Aangifte uiterlijk</th><th></th>
              </tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.id} className={r.status === 'reversed' ? 'is-reversed' : ''}>
                  <td>
                    <button type="button" className="bk-linklike" onClick={() => void openDetail(r)}>{dateNL(r.available_date)}</button>
                    {r.status === 'reversed' && <span className="bk-muted"> · teruggedraaid</span>}
                  </td>
                  <td>
                    {r.kind === 'final'
                      ? <>Uit de winst{r.fiscal_year_label ? ` ${r.fiscal_year_label}` : ''}</>
                      : <>Tussentijds<span className="bk-muted"> · uit {r.source_account_code}</span></>}
                  </td>
                  <td className="bk-num">{euroCents(r.gross_cents)}</td>
                  <td className="bk-num">{euroCents(r.tax_cents)}<span className="bk-muted"> · {pct(r.tax_rate_basis_points)}</span></td>
                  <td className="bk-num">{euroCents(r.net_cents)}</td>
                  <td className={r.status === 'posted' && deadlineTone(r.filing_deadline) === 'warn' ? 'bk-neg' : ''}>
                    {r.filing_deadline ? <><CalendarClock size={12} /> {dateNL(r.filing_deadline)}</> : <span className="bk-muted">geen inhouding</span>}
                  </td>
                  <td className="bk-cell-action">
                    {canAdmin && r.status === 'posted' && (
                      <Button variant="ghost" disabled={busy}
                        onClick={() => run(() => reverseDividendDistribution(organizationId, r.id), 'Uitkering teruggedraaid.')}>
                        <RotateCcw size={13} /> Terugdraaien
                      </Button>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>}
      </div>

      {detail && (
        <DetailDialog
          row={detail.row}
          lines={detail.lines}
          onClose={() => setDetail(null)}
        />
      )}
    </>
  );
}

/** Het formulier: wie krijgt wat, en wat wordt er ingehouden. */
function DividendForm({ organizationId, positions, asOf, openAppropriations, busy, onCancel, onDone }: {
  organizationId: string;
  positions: ShareholderPosition[];
  asOf: string;
  openAppropriations: ResultAppropriationRow[];
  busy: boolean;
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [kind, setKind] = useState<DividendKind>(openAppropriations.length > 0 ? 'final' : 'interim');
  const [appropriationId, setAppropriationId] = useState(openAppropriations[0]?.id ?? '');
  const [decisionDate, setDecisionDate] = useState(today);
  const [availableDate, setAvailableDate] = useState(today);
  const [sourceCode, setSourceCode] = useState('0520');
  const [boardApproved, setBoardApproved] = useState(false);
  const [note, setNote] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [rate, setRate] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appropriation = openAppropriations.find(a => a.id === appropriationId) ?? null;

  // Eén rij per aandeelhouder: het register kan meerdere soorten aandelen per
  // persoon kennen, maar een dividendbedrag krijgt hij één keer.
  const holders = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; shares: number; basisPoints: number; exempt: boolean }>();
    for (const p of positions) {
      const prev = byId.get(p.shareholder_id);
      byId.set(p.shareholder_id, {
        id: p.shareholder_id,
        name: p.name,
        shares: (prev?.shares ?? 0) + p.shares,
        basisPoints: (prev?.basisPoints ?? 0) + p.share_basis_points,
        exempt: p.withholding_exempt,
      });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  }, [positions]);

  useEffect(() => {
    let alive = true;
    void dividendTaxRateOn(availableDate)
      .then(r => { if (alive) setRate(r); })
      .catch(() => { if (alive) setRate(null); });
    return () => { alive = false; };
  }, [availableDate]);

  const totals = useMemo(() => {
    let gross = 0, tax = 0;
    for (const h of holders) {
      const g = parseEuro(amounts[h.id] ?? '');
      gross += g;
      if (!h.exempt && rate !== null) tax += Math.round((g * rate) / 10000);
    }
    return { gross, tax, net: gross - tax };
  }, [holders, amounts, rate]);

  /**
   * Naar belang verdelen. De laatste aandeelhouder krijgt het afrondingsrestje,
   * anders telt de verdeling niet op tot het besluit — en bij een dividend uit
   * de vastgestelde winst weigert de RPC dan terecht.
   */
  function distributePro(totalCents: number) {
    const withShares = holders.filter(h => h.basisPoints > 0);
    if (withShares.length === 0) return;
    const next: Record<string, string> = {};
    let handed = 0;
    withShares.forEach((h, i) => {
      const amount = i === withShares.length - 1
        ? totalCents - handed
        : Math.round((totalCents * h.basisPoints) / 10000);
      handed += amount;
      next[h.id] = centsToInput(amount);
    });
    setAmounts(next);
  }

  const grossMismatch = kind === 'final' && appropriation !== null && totals.gross !== appropriation.dividend_cents;
  const blocked = saving || busy || totals.gross <= 0 || grossMismatch
    || (kind === 'final' && !appropriation)
    || (kind === 'interim' && !boardApproved)
    || availableDate < decisionDate;

  async function submit() {
    setSaving(true); setError(null);
    try {
      const lines = holders
        .map(h => ({ shareholderId: h.id, grossCents: parseEuro(amounts[h.id] ?? '') }))
        .filter(l => l.grossCents > 0);
      if (lines.length === 0) throw new Error('Vul minstens één bedrag in.');
      await declareDividend(organizationId, {
        kind,
        decisionDate,
        availableDate,
        lines,
        resultAppropriationId: kind === 'final' ? appropriationId : null,
        boardApproved: kind === 'interim' ? boardApproved : undefined,
        sourceAccountCode: kind === 'interim' ? sourceCode : undefined,
        note: note.trim() || null,
      });
      await onDone();
    } catch (e) { setError(e instanceof Error ? e.message : 'Vastleggen mislukt'); }
    finally { setSaving(false); }
  }

  return (
    <div className="bk-dividend-form">
      <div className="bk-fy-new-fields">
        <label><span>Soort uitkering</span>
          <Select value={kind} onChange={e => { setKind(e.target.value as DividendKind); setAmounts({}); }}>
            <option value="final" disabled={openAppropriations.length === 0}>Uit de vastgestelde winst</option>
            <option value="interim">Tussentijds (interim-dividend)</option>
          </Select>
        </label>
        {kind === 'final' && (
          <label><span>Besluit van de algemene vergadering</span>
            <Select value={appropriationId} onChange={e => { setAppropriationId(e.target.value); setAmounts({}); }}>
              {openAppropriations.length === 0 && <option value="">Geen besluit met dividend</option>}
              {openAppropriations.map(a => (
                <option key={a.id} value={a.id}>
                  {a.fiscal_year_label} · {dateNL(a.decision_date)} · {euroCents(a.dividend_cents)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {kind === 'interim' && (
          <label><span>Ten laste van</span>
            <Input value={sourceCode} onChange={e => setSourceCode(e.target.value)} placeholder="0520" />
          </label>
        )}
        <label><span>Datum van het besluit</span>
          <input type="date" className="form-input" value={decisionDate} onChange={e => setDecisionDate(e.target.value)} />
        </label>
        <label><span>Ter beschikking gesteld op</span>
          <input type="date" className="form-input" value={availableDate} min={decisionDate} onChange={e => setAvailableDate(e.target.value)} />
        </label>
      </div>

      {kind === 'interim' && (
        <p className="bk-muted">
          Een tussentijdse uitkering gaat ten laste van de vrije reserves (0520) of de lopende winst.
          Een wettelijke of statutaire reserve kan niet: die moet worden aangehouden (art. 2:216 lid 1 BW).
          De balanstest wordt bij het opslaan op de besluitdatum gecontroleerd.
        </p>
      )}

      <div className="bk-table-wrap"><table className="bk-table">
        <thead><tr>
          <th>Aandeelhouder</th><th className="bk-num">Belang</th><th className="bk-num">Bruto</th>
          <th className="bk-num">Inhouding</th><th className="bk-num">Netto</th>
        </tr></thead>
        <tbody>{holders.map(h => {
          const g = parseEuro(amounts[h.id] ?? '');
          const t = h.exempt || rate === null ? 0 : Math.round((g * rate) / 10000);
          return (
            <tr key={h.id}>
              <td>
                {h.name}
                {h.exempt && <span className="bk-muted"> · inhoudingsvrijstelling</span>}
              </td>
              <td className="bk-num">{pct(h.basisPoints)}</td>
              <td className="bk-num">
                <Input value={amounts[h.id] ?? ''} placeholder="0,00"
                  onChange={e => setAmounts(a => ({ ...a, [h.id]: e.target.value }))} />
              </td>
              <td className="bk-num">{h.exempt ? <span className="bk-muted">vrijgesteld</span> : euroCents(t)}</td>
              <td className="bk-num">{euroCents(g - t)}</td>
            </tr>
          );
        })}</tbody>
        <tfoot><tr className="bk-report-result">
          <td colSpan={2}>Totaal</td>
          <td className="bk-num">{euroCents(totals.gross)}</td>
          <td className="bk-num">{euroCents(totals.tax)}</td>
          <td className="bk-num">{euroCents(totals.net)}</td>
        </tr></tfoot>
      </table></div>

      <div className="bk-fy-new-actions">
        <Button variant="ghost" disabled={saving}
          onClick={() => distributePro(kind === 'final' && appropriation ? appropriation.dividend_cents : totals.gross)}>
          <Scale size={13} /> Verdeel naar belang
        </Button>
      </div>

      {rate === null && <p className="bk-neg">Voor {dateNL(availableDate)} is geen tarief dividendbelasting vastgelegd.</p>}
      {grossMismatch && appropriation && (
        <p className="bk-neg">
          De verdeling moet precies het toegekende dividend van {euroCents(appropriation.dividend_cents)} bedragen; nu is het {euroCents(totals.gross)}.
        </p>
      )}
      {availableDate < decisionDate && <p className="bk-neg">Het dividend kan niet ter beschikking zijn gesteld vóór het besluit.</p>}
      {asOf !== decisionDate && (
        <p className="bk-muted">
          De belangen hierboven zijn de stand per {dateNL(asOf)}; de verdeling wordt vastgelegd bij het besluit van {dateNL(decisionDate)}.
        </p>
      )}

      {kind === 'interim' && (
        <label className="bk-setting-check">
          <input type="checkbox" checked={boardApproved} onChange={e => setBoardApproved(e.target.checked)} />
          <span>
            Het bestuur keurt de uitkering goed: het verwacht dat de vennootschap haar opeisbare schulden ook ná deze uitkering kan blijven betalen (uitkeringstoets, art. 2:216 lid 2 BW).
            <small className="bk-muted"> Zonder die goedkeuring heeft het besluit geen gevolgen. Kan de vennootschap na de uitkering haar opeisbare schulden niet betalen, dan zijn de bestuurders die dat wisten of behoorden te voorzien hoofdelijk verbonden voor het tekort (lid 3).</small>
          </span>
        </label>
      )}
      {kind === 'final' && appropriation && (
        <p className="bk-muted">
          De balanstest en de bestuursgoedkeuring zijn bij het besluit van {dateNL(appropriation.decision_date)} al vastgelegd; het bruto bedrag staat sindsdien als schuld op 1580.
          Hier wordt alleen nog verdeeld en ingehouden.
        </p>
      )}

      <label className="bk-setting-field">
        <span>Toelichting (optioneel)</span>
        <input className="form-input" value={note} placeholder="Bijv. verwijzing naar de notulen van de AvA" onChange={e => setNote(e.target.value)} />
      </label>

      {error && <div className="error">{error}</div>}

      <div className="bk-fy-new-actions">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Annuleren</Button>
        <Button variant="primary" disabled={blocked} onClick={() => void submit()}>
          {saving ? 'Bezig…' : 'Uitkering vastleggen en boeken'}
        </Button>
      </div>
    </div>
  );
}

/**
 * De regels van één uitkering: dit is de onderbouwing van de aangifte
 * dividendbelasting en tegelijk alles wat er in een dividendnota hoort
 * (art. 9 Wet DB 1965).
 */
function DetailDialog({ row, lines, onClose }: {
  row: DividendDistributionRow; lines: DividendDistributionLine[]; onClose: () => void;
}) {
  function exportCsv() {
    const escape = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ['Aandeelhouder', 'Adres', 'Postcode', 'Plaats', 'Land', 'Aandelen', 'Bruto', 'Vrijgesteld', 'Ingehouden', 'Netto'];
    const body = lines.map(l => [
      l.name,
      l.address_line ?? '', l.postal_code ?? '', l.city ?? '', l.country_code,
      l.shares,
      (l.gross_cents / 100).toFixed(2).replace('.', ','),
      l.withholding_exempt ? 'ja' : 'nee',
      (l.tax_cents / 100).toFixed(2).replace('.', ','),
      (l.net_cents / 100).toFixed(2).replace('.', ','),
    ]);
    const csv = [header, ...body].map(r => r.map(escape).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `dividend-${row.available_date}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="bk-modal-backdrop" onClick={onClose}>
      <div className="bk-modal bk-modal-wide" onClick={e => e.stopPropagation()}>
        <h3>Dividend van {dateNL(row.available_date)}</h3>
        <div className="bk-modal-body">
          <div className="bk-report-kpis">
            <div><span>Bruto</span><strong>{euroCents(row.gross_cents)}</strong></div>
            <div><span>Ingehouden ({pct(row.tax_rate_basis_points)})</span><strong>{euroCents(row.tax_cents)}</strong></div>
            <div><span>Netto</span><strong>{euroCents(row.net_cents)}</strong></div>
            {row.distributable_cents !== null && (
              <div><span>Vrij uitkeerbaar bij het besluit</span><strong>{euroCents(row.distributable_cents)}</strong></div>
            )}
          </div>

          <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr>
              <th>Aandeelhouder</th><th className="bk-num">Aandelen</th>
              <th className="bk-num">Bruto</th><th className="bk-num">Ingehouden</th><th className="bk-num">Netto</th>
            </tr></thead>
            <tbody>{lines.map(l => (
              <tr key={l.shareholder_id}>
                <td>
                  {l.name}
                  <div className="bk-muted">
                    {[l.address_line, [l.postal_code, l.city].filter(Boolean).join('  '), l.country_code !== 'NL' ? l.country_code : null]
                      .filter(Boolean).join(' · ') || 'geen adres vastgelegd'}
                  </div>
                  {l.withholding_exempt && (
                    <div className="bk-muted">Inhoudingsvrijstelling (art. 4 Wet DB 1965){l.exempt_note ? `: ${l.exempt_note}` : ''}</div>
                  )}
                </td>
                <td className="bk-num">{l.shares}</td>
                <td className="bk-num">{euroCents(l.gross_cents)}</td>
                <td className="bk-num">{euroCents(l.tax_cents)}</td>
                <td className="bk-num">{euroCents(l.net_cents)}</td>
              </tr>
            ))}</tbody>
          </table></div>

          <p className="bk-muted">
            Voor de aangifte dividendbelasting: opbrengst {euroCents(row.gross_cents)}, ingehouden {euroCents(row.tax_cents)},
            ter beschikking gesteld op {dateNL(row.available_date)}
            {row.filing_deadline ? `, uiterlijk af te dragen op ${dateNL(row.filing_deadline)}` : ''}.
            De adressen hierboven zijn wat er in de dividendnota hoort die elke ontvanger krijgt (art. 9 Wet DB 1965).
          </p>
          {row.note && <p className="bk-muted">{row.note}</p>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={exportCsv}><Download size={14} /> Specificatie</Button>
          <Button variant="primary" onClick={onClose}>Sluiten</Button>
        </div>
      </div>
    </div>
  );
}
