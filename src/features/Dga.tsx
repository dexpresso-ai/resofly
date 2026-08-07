import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Percent, Plus, RotateCcw, Trash2, Wallet } from 'lucide-react';
import type { AppData, DgaInterestComputation, DgaInterestPosting, DgaInterestRate, DgaSignals } from '../types';
import { Button, Input, Skeleton } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { PayrollImport } from './PayrollImport';
import {
  addDgaInterestRate, bookDgaInterest, computeDgaInterest, deleteDgaInterestRate,
  listDgaInterestPostings, listDgaInterestRates, loadDgaSignals, reverseDgaInterest,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pct = (bp: number | null | undefined) => `${((bp ?? 0) / 100).toFixed(2).replace('.', ',')}%`;

/**
 * De DGA-pagina.
 *
 * Twee dingen die de wet aan een directeur-grootaandeelhouder hangt: hij moet
 * zichzelf een gebruikelijk loon betalen (art. 12a Wet LB), en leent hij van
 * zijn eigen BV, dan zit daar een grens aan (art. 4.14a Wet IB) én moet er
 * zakelijke rente over.
 *
 * Wat dit scherm WEL doet: het laat de feiten uit de eigen administratie zien
 * met het wettelijke bedrag ernaast. Wat het NIET doet: oordelen. Of een schuld
 * een eigenwoningschuld is, of er een hypotheekrecht is verstrekt, of er
 * verbonden personen meetellen — dat staat niet in een boekhouding. En het
 * rentepercentage vult de gebruiker zelf in: de Belastingdienst schrijft er
 * geen voor, dus een suggestie zou een norm verzinnen die niet bestaat.
 */
export function DgaPage({ data, organizationId, canWrite, canAdmin, businessActive, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; canAdmin: boolean;
  businessActive: boolean; onChanged: () => void;
}) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [signals, setSignals] = useState<DgaSignals | null>(null);
  const [interest, setInterest] = useState<DgaInterestComputation | null>(null);
  const [rates, setRates] = useState<DgaInterestRate[]>([]);
  const [postings, setPostings] = useState<DgaInterestPosting[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [newFrom, setNewFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [newRate, setNewRate] = useState('');
  const [newNote, setNewNote] = useState('');

  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  const isCorporate = legalForm === 'bv' || legalForm === 'nv';
  const posted = postings.find(p => p.year === year && p.status === 'posted') ?? null;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, i, r, p] = await Promise.all([
        loadDgaSignals(organizationId, year),
        computeDgaInterest(organizationId, year),
        listDgaInterestRates(organizationId),
        listDgaInterestPostings(organizationId),
      ]);
      setSignals(s); setInterest(i); setRates(r); setPostings(p);
    } catch (e) { setError(e instanceof Error ? e.message : 'Laden mislukt'); }
    finally { setLoading(false); }
  }, [organizationId, year]);

  useEffect(() => { if (isCorporate && businessActive) void load(); }, [load, isCorporate, businessActive]);

  async function run(action: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); await load(); onChanged(); setMessage(ok); }
    catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt'); }
    finally { setBusy(false); }
  }

  if (!isCorporate) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">DGA</div>
      <div>Een directeur-grootaandeelhouder hoort bij een BV of NV. Bij deze rechtsvorm ({legalForm}) speelt dit niet.</div>
    </div></div>;
  }
  if (!businessActive) {
    return <div className="bk-page"><div className="bk-setup">
      <div><strong>De zakelijke module staat uit.</strong>
        <p>De rekening-courant DGA en het gebruikelijk loon horen bij de zakelijke module. Zet die aan via Instellingen → Abonnement.</p></div>
    </div></div>;
  }

  const signal = (text: string, tone: 'warn' | 'ok' | 'muted' = 'muted') => (
    <p className={tone === 'warn' ? 'bk-neg' : tone === 'ok' ? 'bk-pos' : 'bk-muted'}>
      {tone === 'warn' && <AlertTriangle size={13} />} {text}
    </p>
  );

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div>
          <h2>DGA</h2>
          <p>Gebruikelijk loon en de rekening-courant met de eigen BV. Signalen uit je eigen administratie, met het wettelijke bedrag ernaast — geen fiscaal advies.</p>
        </div>
        <div className="bk-period-pick">
          <button className="bk-step" onClick={() => setYear(y => y - 1)} title="Vorig jaar"><ChevronLeft size={16} /></button>
          <strong>{year}</strong>
          <button className="bk-step" onClick={() => setYear(y => y + 1)} title="Volgend jaar"><ChevronRight size={16} /></button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <p className="bk-note">{message}</p>}

      {loading ? <div className="bk-report-loading"><Skeleton lines={6} /></div> : !signals ? null : !signals.normsKnown ? (
        <p className="bk-muted">Voor {year} zijn de normbedragen nog niet vastgesteld. Zodra de wetgever ze publiceert worden ze toegevoegd.</p>
      ) : (
        <>
          {/* ── Gebruikelijk loon ── */}
          <div className="bk-report">
            <div className="bk-report-bar">
              <div className="bk-report-kpis">
                <div><span>Normbedrag {year}</span><strong>{euroCents(signals.usualSalaryNormCents)}</strong></div>
                <div><span>Geboekt brutoloon</span><strong>{euroCents(signals.wagesBookedCents)}</strong></div>
              </div>
            </div>
            {signals.noWagesBooked
              ? signal(`Er is dit jaar nog geen brutoloon geboekt. Het gebruikelijk loon is ten minste het hoogste van: het loon uit de meest vergelijkbare dienstbetrekking, het hoogste loon van een werknemer in de groep, of ${euroCents(signals.usualSalaryNormCents)} (art. 12a Wet LB 1964).`, 'warn')
              : signal(`Het geboekte bedrag is het totaal van alle brutolonen — welk deel daarvan het DGA-loon is, weet je administratie niet. Vergelijk het zelf met de norm van ${euroCents(signals.usualSalaryNormCents)}.`)}
            <p className="bk-muted">
              Onder {euroCents(signals.deMinimisCents)} per jaar hoeft er geen gebruikelijk loon te worden vastgesteld.
              Werk je in deeltijd, dan geldt de norm nog steeds: een lager loon moet je aannemelijk maken aan de hand van de meest vergelijkbare dienstbetrekking, niet door de norm zelf te delen.
            </p>
          </div>

          {/* ── Rekening-courant ── */}
          <div className="bk-report">
            <div className="bk-report-bar">
              <div className="bk-report-kpis">
                <div><span>Saldo op 31 december</span><strong className={signals.currentAccountYearEndCents > 0 ? 'bk-neg' : ''}>{euroCents(signals.currentAccountYearEndCents)}</strong></div>
                <div><span>Hoogste stand dit jaar</span><strong>{euroCents(signals.currentAccountPeakCents)}</strong></div>
              </div>
            </div>
            {!signals.hasCurrentAccount
              ? signal('Er is nog geen rekening-courant DGA in het rekeningschema. Werk het schema bij vanuit Grootboek als je die nodig hebt.')
              : <>
                {signals.excessiveLoanThresholdCents !== null && (
                  signals.aboveExcessiveLoanThreshold
                    ? signal(`Het saldo op 31 december (${euroCents(signals.currentAccountYearEndCents)}) ligt boven de grens van ${euroCents(signals.excessiveLoanThresholdCents)} (art. 4.14a Wet IB 2001). Het meerdere kan als inkomen uit aanmerkelijk belang worden belast. Of dat werkelijk zo is hangt af van zaken die hier niet staan — een eigenwoningschuld met hypotheekrecht, schulden van een partner of verbonden personen, en eerder belaste bedragen. Bespreek dit met je adviseur.`, 'warn')
                    : signal(`Onder de grens van ${euroCents(signals.excessiveLoanThresholdCents)} (art. 4.14a Wet IB 2001). Let op: die grens wordt op 31 december gemeten, dus aflossen vóór het jaareinde telt.`, 'ok')
                )}
                {signals.aboveInterestFreeLimit
                  ? signal(`De rekening-courant stond dit jaar boven ${euroCents(signals.interestFreeLimitCents)}. Dan moet er over het volle bedrag rente worden berekend, niet alleen over het meerdere.`, 'warn')
                  : signal(`Het saldo bleef dit jaar onder ${euroCents(signals.interestFreeLimitCents)}; dan hoeft er geen rente te worden berekend. Die toets geldt voor het hele jaar, niet alleen voor de einddatum.`, 'ok')}
              </>}
          </div>

          {/* ── Rentepercentage ── */}
          <div className="bk-report">
            <div className="bk-subhead">
              <p className="bk-muted">
                <Percent size={13} /> De Belastingdienst schrijft geen rentepercentage voor: het moet zakelijk zijn — wat de BV elders als particuliere belegger zou krijgen.
                Hypotheekrentes, interbancaire tarieven en rekening-courantkredieten zijn uitdrukkelijk géén maatstaf. Leg hier vast wat je met je adviseur hebt afgesproken; ResoFly vult niets voor.
              </p>
            </div>
            {rates.length === 0
              ? <p className="bk-muted">Nog geen percentage vastgelegd.</p>
              : <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr><th>Vanaf</th><th className="bk-num">Percentage</th><th>Onderbouwing</th><th></th></tr></thead>
                  <tbody>{rates.map(r => (
                    <tr key={r.id}>
                      <td>{dateNL(r.valid_from)}</td>
                      <td className="bk-num">{pct(r.rate_basis_points)}</td>
                      <td>{r.basis_note || <span className="bk-muted">—</span>}</td>
                      <td className="bk-cell-action">
                        {canWrite && <button className="bk-line-del" title="Verwijderen" disabled={busy}
                          onClick={() => run(() => deleteDgaInterestRate(organizationId, r.id), 'Percentage verwijderd.')}>
                          <Trash2 size={12} /></button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>}

            {canWrite && <>
              <div className="bk-fy-new-fields">
                <label><span>Vanaf</span><input type="date" className="form-input" value={newFrom} onChange={e => setNewFrom(e.target.value)} /></label>
                <label><span>Percentage</span><Input value={newRate} onChange={e => setNewRate(e.target.value)} placeholder="4,50" /></label>
                <label><span>Onderbouwing</span><Input value={newNote} onChange={e => setNewNote(e.target.value)} placeholder="Bijv. afgesproken met de accountant, gebaseerd op…" /></label>
              </div>
              <div className="bk-fy-new-actions">
                <Button disabled={busy} onClick={() => run(async () => {
                  const bp = Math.round((Number(newRate.replace(',', '.')) || 0) * 100);
                  if (bp <= 0) throw new Error('Vul een percentage in.');
                  await addDgaInterestRate(organizationId, { validFrom: newFrom, rateBasisPoints: bp, basisNote: newNote.trim() || null });
                  setNewRate(''); setNewNote('');
                }, 'Percentage vastgelegd.')}><Plus size={14} /> Percentage vastleggen</Button>
              </div>
            </>}
          </div>

          {/* ── Loonjournaalpost ── */}
          <PayrollImport organizationId={organizationId} canWrite={canWrite} onPosted={() => { void load(); onChanged(); }} />

          {/* ── Renteberekening ── */}
          {interest && signals.hasCurrentAccount && (
            <div className="bk-report">
              <div className="bk-report-bar">
                <div className="bk-report-kpis">
                  <div><span>Rente {year}</span><strong>{euroCents(interest.interestCents)}</strong></div>
                </div>
                {posted && <span className="status-pill bk-je-posted">Geboekt</span>}
              </div>
              {interest.periods.length > 0 && (
                <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr><th>Percentage</th><th className="bk-num">Dagen</th><th className="bk-num">Gemiddeld saldo</th><th className="bk-num">Rente</th></tr></thead>
                  <tbody>{interest.periods.map((p, i) => (
                    <tr key={i}>
                      <td>{p.rateBasisPoints === null ? <span className="bk-neg">geen percentage vastgelegd</span> : pct(p.rateBasisPoints)}</td>
                      <td className="bk-num">{p.days}</td>
                      <td className="bk-num">{euroCents(p.averageBalanceCents)}</td>
                      <td className="bk-num">{euroCents(p.interestCents)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
              <p className="bk-muted">
                Berekend over het dagsaldo: elke dag het saldo maal het percentage dat op die dag gold, gedeeld door {interest.daysInYear}.
                Boeken zet de rente op de rekening-courant zelf, tegen 9000 Rentebaten of 9100 Rentelasten.
              </p>
              <div className="bk-fy-new-actions">
                {canWrite && !posted && (
                  <Button variant="primary" disabled={busy || interest.hasDaysWithoutRate || interest.interestCents === 0}
                    title={interest.hasDaysWithoutRate ? 'Leg eerst voor het hele jaar een percentage vast' : undefined}
                    onClick={() => run(async () => { await bookDgaInterest(organizationId, year); }, 'Rente geboekt.')}>
                    <Wallet size={14} /> Rente boeken
                  </Button>
                )}
                {canAdmin && posted && (
                  <Button variant="ghost" disabled={busy}
                    onClick={() => run(async () => { await reverseDgaInterest(organizationId, posted.id); }, 'Renteboeking teruggedraaid.')}>
                    <RotateCcw size={14} /> Rente terugdraaien
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
