import { useCallback, useEffect, useMemo, useState } from 'react';
import { Calculator, Download, Landmark, Lock, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type {
  AppData, CorporateTaxComputation, CorporateTaxCorrectionCode, CorporateTaxCorrectionRow,
  CorporateTaxInputs, CorporateTaxReturn, FiscalYearListRow,
} from '../types';
import { CORPORATE_TAX_CORRECTION_LABELS } from '../types';
import { Button, Input, Select, Skeleton } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import {
  addCorporateTaxCorrection, deleteCorporateTaxCorrection, listCorporateTaxCorrections,
  listCorporateTaxReturns, listFiscalYears, reverseCorporateTaxReturn,
} from '../lib/repository';
import { finalizeCorporateTax, previewCorporateTax, saveCorporateTax } from '../services/corporateTaxService';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pct = (basisPoints: number) => `${(basisPoints / 100).toFixed(2).replace('.', ',')}%`;

/** Euro-invoer naar centen; accepteert zowel komma als punt. */
function parseEuro(value: string): number {
  const n = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    let s = String(v);
    if (/^-?\d+\.\d{2}$/.test(s)) s = s.replace('.', ',');
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [header, ...rows].map(r => r.map(escape).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/**
 * Vennootschapsbelasting per boekjaar.
 *
 * Het rekenwerk gebeurt niet hier maar in supabase/functions/_shared/vpb.ts, via
 * de edge function. Dit scherm laat zien wat daaruit komt, laat de fiscale
 * correcties invoeren, en stelt de berekening vast — waarna de reservering op
 * 9900/1540 wordt geboekt.
 *
 * Bewust géén aangifte: wij rekenen en specificeren, de klant of zijn accountant
 * dient in. Zelfde lijn als bij de omzetbelasting.
 */
export function CorporateTaxPage({ data, organizationId, canWrite, canAdmin, businessActive, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; canAdmin: boolean;
  businessActive: boolean; onChanged: () => void;
}) {
  const [years, setYears] = useState<FiscalYearListRow[]>([]);
  const [fiscalYearId, setFiscalYearId] = useState<string>('');
  const [inputs, setInputs] = useState<CorporateTaxInputs | null>(null);
  const [computation, setComputation] = useState<CorporateTaxComputation | null>(null);
  const [corrections, setCorrections] = useState<CorporateTaxCorrectionRow[]>([]);
  const [returns, setReturns] = useState<CorporateTaxReturn[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [newCode, setNewCode] = useState<CorporateTaxCorrectionCode>('niet_aftrekbaar');
  const [newLabel, setNewLabel] = useState('');
  const [newAmount, setNewAmount] = useState('');

  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  const isVpb = ['bv', 'nv', 'cooperatie'].includes(legalForm);

  const current = useMemo(
    () => returns.find(r => r.fiscal_year_id === fiscalYearId && r.status !== 'reversed') ?? null,
    [returns, fiscalYearId],
  );

  const loadYears = useCallback(async () => {
    try {
      const [ys, rs] = await Promise.all([listFiscalYears(organizationId), listCorporateTaxReturns(organizationId)]);
      setYears(ys);
      setReturns(rs);
      setFiscalYearId(prev => prev || ys[0]?.id || '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Boekjaren laden mislukt'); }
  }, [organizationId]);

  useEffect(() => { if (isVpb) void loadYears(); }, [loadYears, isVpb]);

  /** Doorrekenen zonder op te slaan: de gebruiker ziet eerst wat eruit komt. */
  const recompute = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true); setError(null); setMessage(null);
    try {
      const [result, cs] = await Promise.all([
        previewCorporateTax(organizationId, id),
        listCorporateTaxCorrections(organizationId, id),
      ]);
      setInputs(result.inputs);
      setComputation(result.computation);
      setCorrections(cs);
    } catch (e) {
      setInputs(null); setComputation(null);
      setError(e instanceof Error ? e.message : 'Berekening mislukt');
    } finally { setLoading(false); }
  }, [organizationId]);

  useEffect(() => { if (fiscalYearId) void recompute(fiscalYearId); }, [fiscalYearId, recompute]);

  async function run(action: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await action();
      await loadYears();
      await recompute(fiscalYearId);
      onChanged();
      setMessage(ok);
    } catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt'); }
    finally { setBusy(false); }
  }

  const addCorrection = () => run(async () => {
    const amount = parseEuro(newAmount);
    if (!newLabel.trim()) throw new Error('Geef de correctie een omschrijving.');
    if (amount === 0) throw new Error('Een correctie van nul heeft geen effect.');
    await addCorporateTaxCorrection(organizationId, {
      fiscalYearId, code: newCode, label: newLabel.trim(), amountCents: amount,
    });
    setNewLabel(''); setNewAmount('');
  }, 'Correctie toegevoegd.');

  const exportCsv = () => {
    if (!inputs || !computation) return;
    const rows: (string | number)[][] = [
      ['Commercieel resultaat', '', (computation.commercialResultCents / 100).toFixed(2)],
      ...corrections.map(c => [
        CORPORATE_TAX_CORRECTION_LABELS[c.code], c.label, (c.amount_cents / 100).toFixed(2),
      ] as (string | number)[]),
      ['Totaal correcties', '', (computation.totalCorrectionsCents / 100).toFixed(2)],
      ['Fiscale winst', '', (computation.fiscalProfitCents / 100).toFixed(2)],
      ['Maximaal te verrekenen verlies', 'art. 20 lid 2 Wet Vpb', (computation.lossReliefCapCents / 100).toFixed(2)],
      ...computation.lossesUsed.map(l => [
        'Verliesverrekening', `verlies ${l.year}`, (-l.usedCents / 100).toFixed(2),
      ] as (string | number)[]),
      ['Belastbaar bedrag', `afgerond op € 5`, (computation.taxableAmountCents / 100).toFixed(2)],
      ['Vennootschapsbelasting', `tarief ${inputs.rules.year}`, (computation.taxCents / 100).toFixed(2)],
      ['Betaalde voorlopige aanslagen', '', (-computation.prepaidCents / 100).toFixed(2)],
      ['Te betalen', '', (computation.balanceDueCents / 100).toFixed(2)],
      ...computation.lossesRemaining.map(l => [
        'Nog te verrekenen verlies', `uit ${l.year}`, (l.remainingCents / 100).toFixed(2),
      ] as (string | number)[]),
    ];
    downloadCsv(`vpb-${inputs.fiscalYear.label}.csv`, ['Post', 'Toelichting', 'Bedrag'], rows);
  };

  if (!isVpb) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">Vennootschapsbelasting</div>
      <div>Deze rechtsvorm ({legalForm}) betaalt geen vennootschapsbelasting maar inkomstenbelasting.
        Staat je rechtsvorm verkeerd, pas hem dan aan bij Instellingen → Facturatie.</div>
    </div></div>;
  }

  if (!businessActive) {
    return <div className="bk-page"><div className="bk-setup">
      <div><strong>De zakelijke module staat uit.</strong>
        <p>Vennootschapsbelasting hoort bij de zakelijke module. Zet die aan via Instellingen → Abonnement.</p></div>
    </div></div>;
  }

  const row = (label: string, amount: number, cls = '', hint?: string) => (
    <tr className={cls} key={label}>
      <td>{label}{hint && <span className="bk-muted"> · {hint}</span>}</td>
      <td className="bk-num">{euroCents(amount)}</td>
    </tr>
  );

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div>
          <h2>Vennootschapsbelasting</h2>
          <p>Van commercieel resultaat naar belastbaar bedrag: fiscale correcties, verliesverrekening en het tarief van het boekjaar. Een hulpmiddel — indienen doe je zelf of via je accountant.</p>
        </div>
        <div className="bk-head-actions">
          <Select value={fiscalYearId} onChange={e => setFiscalYearId(e.target.value)}>
            {years.length === 0 && <option value="">Geen boekjaren</option>}
            {years.map(y => <option key={y.id} value={y.id}>{y.label}</option>)}
          </Select>
          {computation && <Button onClick={exportCsv}><Download size={14} /> Specificatie</Button>}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <p className="bk-note">{message}</p>}

      {loading ? <div className="bk-report-loading"><Skeleton lines={6} /></div> : !computation || !inputs ? (
        <p className="bk-muted">Kies een boekjaar om de berekening te zien.</p>
      ) : (
        <>
          <div className="bk-report">
            <div className="bk-report-bar">
              <div className="bk-report-kpis">
                <div><span>Belastbaar bedrag {inputs.fiscalYear.label}</span><strong>{euroCents(computation.taxableAmountCents)}</strong></div>
                <div><span>Vennootschapsbelasting</span><strong>{euroCents(computation.taxCents)}</strong></div>
                <div><span>Gemiddeld tarief</span><strong>{pct(computation.effectiveRateBasisPoints)}</strong></div>
                <div>
                  <span>{computation.balanceDueCents >= 0 ? 'Nog te betalen' : 'Terug te ontvangen'}</span>
                  <strong className={computation.balanceDueCents > 0 ? 'bk-neg' : 'bk-pos'}>{euroCents(Math.abs(computation.balanceDueCents))}</strong>
                </div>
              </div>
              {current && (
                <span className={`status-pill ${current.status === 'final' ? 'bk-je-posted' : 'bk-status-draft'}`}>
                  {current.status === 'final' ? <><Lock size={12} /> Vastgesteld</> : 'Concept'}
                </span>
              )}
            </div>

            <div className="bk-table-wrap"><table className="bk-table bk-report-table">
              <thead><tr><th>Berekening</th><th className="bk-num">Bedrag</th></tr></thead>
              <tbody>
                {row('Commercieel resultaat', computation.commercialResultCents, '', 'uit het grootboek, exclusief de Vpb zelf')}
                {corrections.length > 0 && <tr className="bk-report-section"><td colSpan={2}>Fiscale correcties</td></tr>}
                {corrections.map(c => (
                  <tr className="bk-balance-sub" key={c.id}>
                    <td>
                      {c.label}<span className="bk-muted"> · {CORPORATE_TAX_CORRECTION_LABELS[c.code]}</span>
                      {canWrite && current?.status !== 'final' && (
                        <button className="bk-line-del" title="Verwijderen" disabled={busy}
                          onClick={() => run(() => deleteCorporateTaxCorrection(organizationId, c.id), 'Correctie verwijderd.')}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </td>
                    <td className="bk-num">{euroCents(c.amount_cents)}</td>
                  </tr>
                ))}
                {row('Fiscale winst', computation.fiscalProfitCents, 'bk-report-total')}

                {computation.lossesUsed.length > 0 && <>
                  <tr className="bk-report-section"><td colSpan={2}>Verliesverrekening</td></tr>
                  {computation.lossesUsed.map(l => (
                    <tr className="bk-balance-sub" key={l.year}>
                      <td>Verlies uit {l.year}</td>
                      <td className="bk-num">{euroCents(-l.usedCents)}</td>
                    </tr>
                  ))}
                  {row('Maximaal verrekenbaar', computation.lossReliefCapCents, 'bk-balance-sub', 'art. 20 lid 2 Wet Vpb')}
                </>}

                {row('Belastbaar bedrag', computation.taxableAmountCents, 'bk-report-total', 'naar beneden afgerond op € 5')}
                {row(`Vennootschapsbelasting (tarief ${inputs.rules.year})`, computation.taxCents, 'bk-report-total')}
                {computation.prepaidCents !== 0 && row('Betaalde voorlopige aanslagen', -computation.prepaidCents)}
              </tbody>
              <tfoot><tr className="bk-report-result">
                <td>{computation.balanceDueCents >= 0 ? 'Nog te betalen' : 'Terug te ontvangen'}</td>
                <td className="bk-num">{euroCents(Math.abs(computation.balanceDueCents))}</td>
              </tr></tfoot>
            </table></div>

            <p className="bk-muted">
              Tariefschijven {inputs.rules.year}: {inputs.rules.brackets.map((b, i) =>
                `${i === 0 ? 'tot' : 'vanaf'} ${euroCents(b.lowerBoundCents || inputs.rules.brackets[1]?.lowerBoundCents || 0)} ${pct(b.rateBasisPoints)}`,
              ).join(' · ')}. De schijven werken cumulatief (art. 22 Wet Vpb): het hoge tarief geldt alleen over het deel boven de grens.
            </p>
          </div>

          {/* ── Fiscale correcties ── */}
          {canWrite && current?.status !== 'final' && (
            <div className="bk-report">
              <div className="bk-subhead">
                <p className="bk-muted">Voeg toe wat de fiscale winst afwijkt van het commerciële resultaat. Positief verhoogt de winst (niet-aftrekbare kosten), negatief verlaagt hem (investeringsaftrek).</p>
              </div>
              <div className="bk-fy-new-fields">
                <label><span>Soort</span>
                  <Select value={newCode} onChange={e => setNewCode(e.target.value as CorporateTaxCorrectionCode)}>
                    {(Object.keys(CORPORATE_TAX_CORRECTION_LABELS) as CorporateTaxCorrectionCode[]).map(k => (
                      <option key={k} value={k}>{CORPORATE_TAX_CORRECTION_LABELS[k]}</option>
                    ))}
                  </Select>
                </label>
                <label><span>Omschrijving</span>
                  <Input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Bijv. verkeersboetes" />
                </label>
                <label><span>Bedrag</span>
                  <Input value={newAmount} onChange={e => setNewAmount(e.target.value)} placeholder="1500,00" />
                </label>
              </div>
              <div className="bk-fy-new-actions">
                <Button disabled={busy} onClick={addCorrection}><Plus size={14} /> Correctie toevoegen</Button>
              </div>
            </div>
          )}

          {/* ── Vastleggen ── */}
          <div className="bk-report">
            <div className="bk-subhead">
              <p className="bk-muted">
                Vaststellen boekt de last op 9900 Vennootschapsbelasting tegen 1540 Te betalen vennootschapsbelasting, op de balansdatum van het boekjaar.
                {inputs.lossesCarriedForward.some(l => !l.establishedByAssessment) && ' Let op: een deel van de openstaande verliezen is nog niet door de Belastingdienst vastgesteld; dat is onze eigen berekening.'}
              </p>
            </div>
            <div className="bk-fy-new-actions">
              {canWrite && current?.status !== 'final' && (
                <>
                  <Button disabled={busy} onClick={() => run(async () => { await saveCorporateTax(organizationId, fiscalYearId); }, 'Berekening opgeslagen als concept.')}>
                    <Calculator size={14} /> Opslaan als concept
                  </Button>
                  <Button variant="primary" disabled={busy} onClick={() => run(async () => { await finalizeCorporateTax(organizationId, fiscalYearId); }, 'Berekening vastgesteld en geboekt.')}>
                    <Landmark size={14} /> Vaststellen en boeken
                  </Button>
                </>
              )}
              {canAdmin && current?.status === 'final' && (
                <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await reverseCorporateTaxReturn(organizationId, current.id); }, 'Berekening teruggedraaid.')}>
                  <RotateCcw size={14} /> Berekening terugdraaien
                </Button>
              )}
            </div>
          </div>

          {/* ── Openstaande verliezen ── */}
          {computation.lossesRemaining.length > 0 && (
            <div className="bk-report">
              <div className="bk-table-wrap"><table className="bk-table">
                <thead><tr><th>Nog te verrekenen verlies</th><th className="bk-num">Bedrag</th><th>Vastgesteld</th></tr></thead>
                <tbody>{computation.lossesRemaining.map(l => {
                  const known = inputs.lossesCarriedForward.find(x => x.year === l.year);
                  return (
                    <tr key={l.year}>
                      <td>Uit {l.year}</td>
                      <td className="bk-num">{euroCents(l.remainingCents)}</td>
                      <td>{known?.establishedByAssessment ? 'Bij beschikking' : <span className="bk-muted">Eigen berekening</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            </div>
          )}

          {returns.length > 0 && (
            <div className="bk-report">
              <div className="bk-table-wrap"><table className="bk-table">
                <thead><tr><th>Boekjaar</th><th className="bk-num">Belastbaar</th><th className="bk-num">Belasting</th><th>Status</th><th>Vastgesteld op</th></tr></thead>
                <tbody>{returns.map(r => (
                  <tr key={r.id} className={r.status === 'reversed' ? 'is-reversed' : ''}>
                    <td><strong>{r.year}</strong></td>
                    <td className="bk-num">{euroCents(r.taxable_amount_cents)}</td>
                    <td className="bk-num">{euroCents(r.tax_cents)}</td>
                    <td>{r.status === 'final' ? 'Vastgesteld' : r.status === 'draft' ? 'Concept' : 'Teruggedraaid'}</td>
                    <td>{r.finalized_at ? dateNL(r.finalized_at.slice(0, 10)) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
