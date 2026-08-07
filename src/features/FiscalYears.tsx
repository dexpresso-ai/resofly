import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarClock, Lock, Plus, Scale, Unlock } from 'lucide-react';
import type { AppData, FiscalYearListRow, ResultAppropriationRow } from '../types';
import { Button, Skeleton } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import {
  appropriateResult, closeFiscalYear, ensureDefaultLedgerAccounts, listFiscalYears,
  listResultAppropriations, openFiscalYear, reopenFiscalYear, reverseResultAppropriation,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pad2 = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(year, month, 0).getDate();
const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Rechtsvormen waarbij de winst niet automatisch van de ondernemer is, maar door
 * de algemene vergadering wordt bestemd. Bij een IB-onderneming bestaat die stap
 * niet: het resultaat gaat rechtstreeks naar het eigen vermogen.
 */
const APPROPRIATION_LEGAL_FORMS = ['bv', 'nv', 'cooperatie'];

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

export function FiscalYearsPage({ data, organizationId, canWrite, canAdmin, businessActive, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; canAdmin: boolean;
  /** Zakelijke module actief; zonder die module weigert appropriate_result. */
  businessActive: boolean;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<FiscalYearListRow[]>([]);
  const [appropriations, setAppropriations] = useState<ResultAppropriationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<FiscalYearListRow | null>(null);
  const [confirmReopen, setConfirmReopen] = useState<FiscalYearListRow | null>(null);
  const [appropriate, setAppropriate] = useState<FiscalYearListRow | null>(null);
  const [confirmUndo, setConfirmUndo] = useState<ResultAppropriationRow | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');

  const startMonth = data.companySettings?.fiscal_year_start_month ?? 1;
  const resultCode = data.companySettings?.year_result_account_code ?? '0510';
  const resultLabel = resultCode === '0500' ? '0500 · Eigen vermogen' : '0510 · Onverdeeld resultaat';
  // De rechtsvorm staat al in de bedrijfsgegevens; die hoeft niet nog eens als
  // prop door de app te reizen. Zonder rechtsvorm: eenmanszaak, dus geen AvA.
  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  // De rechtsvorm is los van het abonnement in te stellen, maar appropriate_result
  // weigert zonder de zakelijke module. Beide moeten kloppen, anders staat er een
  // knop die het nooit kan doen.
  const usesAppropriation = businessActive && APPROPRIATION_LEGAL_FORMS.includes(legalForm);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      // Bestemmingen ALTIJD ophalen, ook bij een eenmanszaak. Wie de rechtsvorm
      // na een bestemming terugzet, moet die nog kunnen terugdraaien — anders
      // blijft het boekjaar geblokkeerd zonder knop om eruit te komen. Een
      // aparte catch, zodat een lege of geweigerde lijst de boekjaren zelf niet
      // meesleept.
      const [years, appropriated] = await Promise.all([
        listFiscalYears(organizationId),
        listResultAppropriations(organizationId).catch(() => [] as ResultAppropriationRow[]),
      ]);
      setRows(years);
      setAppropriations(appropriated);
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Boekjaren laden mislukt'); }
    finally { setLoading(false); }
  }, [organizationId]);

  useEffect(() => { if (data.ledgerAccounts.length > 0) void load(); }, [load, data.ledgerAccounts.length]);

  const hasOpenYear = useMemo(() => rows.some(r => r.status === 'open'), [rows]);
  /** De geldige (niet-teruggedraaide) bestemming per boekjaar. */
  const activeAppropriations = useMemo(
    () => new Map(appropriations.filter(a => a.status === 'posted').map(a => [a.fiscal_year_id, a])),
    [appropriations],
  );

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

  async function doAppropriate(row: FiscalYearListRow, input: { decisionDate: string; dividendCents: number; boardApproved: boolean; note: string }) {
    const result = row.result_cents ?? 0;
    setBusyId(row.id); setActionError(null);
    try {
      await appropriateResult(organizationId, {
        fiscalYearId: row.id,
        decisionDate: input.decisionDate,
        // Wat niet wordt uitgekeerd, gaat naar de overige reserves. Bij een
        // verlies is er niets uit te keren en gaat het volledige bedrag.
        reservesCents: result - input.dividendCents,
        dividendCents: input.dividendCents,
        boardApproved: input.boardApproved,
        note: input.note.trim() || null,
      });
      setAppropriate(null);
      await load(); onChanged();
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Resultaatbestemming mislukt'); }
    finally { setBusyId(null); }
  }

  async function doUndoAppropriation(row: ResultAppropriationRow) {
    setBusyId(row.id); setActionError(null);
    try {
      await reverseResultAppropriation(organizationId, row.id);
      setConfirmUndo(null);
      await load(); onChanged();
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Terugdraaien mislukt'); }
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
          <p>
            Open een nieuw boekjaar, sluit een lopend boekjaar af (resultaat naar {resultLabel}) en bekijk voorgaande jaren.
            {usesAppropriation && ' Daarna bestemt de algemene vergadering het resultaat: naar de reserves of als dividend.'}
          </p>
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
                const appropriated = activeAppropriations.get(r.id) ?? null;
                const canAppropriate = usesAppropriation && r.status === 'closed' && !appropriated && (r.result_cents ?? 0) !== 0;
                return (
                  <tr key={r.id}>
                    <td><strong>{r.label}</strong></td>
                    <td>{dateNL(r.period_start)} – {dateNL(r.period_end)}</td>
                    <td>
                      {r.status === 'closed'
                        ? <span className="bk-badge bk-badge-closed"><Lock size={12} /> Afgesloten</span>
                        : <span className="bk-badge bk-badge-open"><CalendarClock size={12} /> Open</span>}
                      {appropriated && (
                        <span className="bk-fy-hint bk-muted" title={`Besluit van ${dateNL(appropriated.decision_date)}${appropriated.entry_number ? ` · boekstuk ${appropriated.entry_number}` : ''}. Naar de reserves ${euroCents(appropriated.reserves_cents)}${appropriated.dividend_cents > 0 ? `, dividend ${euroCents(appropriated.dividend_cents)}` : ''}.`}>
                          {' '}· bestemd{appropriated.dividend_cents > 0 ? ` (${euroCents(appropriated.dividend_cents)} dividend)` : ''}
                        </span>
                      )}
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
                      {canAppropriate && canWrite && (
                        <Button disabled={busyId === r.id} onClick={() => { setActionError(null); setAppropriate(r); }}><Scale size={13} /> Resultaat bestemmen</Button>
                      )}
                      {appropriated && canAdmin && (
                        <Button variant="ghost" disabled={busyId === appropriated.id} onClick={() => { setActionError(null); setConfirmUndo(appropriated); }}>Bestemming terugdraaien</Button>
                      )}
                      {r.status === 'closed' && canAdmin && (
                        <Button
                          variant="ghost"
                          // Heropenen weigert zolang er een geldige bestemming
                          // ligt; dat hier al blokkeren scheelt een rauwe
                          // databasefout en wijst meteen de goede volgorde aan.
                          disabled={busyId === r.id || Boolean(appropriated)}
                          title={appropriated ? 'Draai eerst de resultaatbestemming terug' : undefined}
                          onClick={() => { setActionError(null); setConfirmReopen(r); }}
                        ><Unlock size={13} /> Heropenen</Button>
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
          <p>Het jaarafsluitboekstuk vervalt en de jaar-vergrendeling wordt opgeheven, zodat je weer in dit boekjaar kunt boeken. Het resultaat staat daarna weer als lopend resultaat in de balans.</p>
          <p className="bk-muted">Doe dit alleen om een fout te herstellen. Latere afgesloten boekjaren moeten eerst heropend worden{usesAppropriation ? ', en een resultaatbestemming van dit boekjaar moet eerst zijn teruggedraaid' : ''}.</p>
        </ConfirmDialog>
      )}

      {appropriate && (
        <AppropriationDialog
          row={appropriate}
          canDistribute={legalForm === 'bv' || legalForm === 'nv'}
          busy={busyId === appropriate.id}
          error={actionError}
          resultLabel={resultLabel}
          onCancel={() => { setAppropriate(null); setActionError(null); }}
          onConfirm={input => doAppropriate(appropriate, input)}
        />
      )}

      {confirmUndo && (
        <ConfirmDialog
          title={`Resultaatbestemming ${confirmUndo.fiscal_year_label} terugdraaien?`}
          confirmLabel="Terugdraaien"
          busy={busyId === confirmUndo.id}
          error={actionError}
          onCancel={() => { setConfirmUndo(null); setActionError(null); }}
          onConfirm={() => doUndoAppropriation(confirmUndo)}
        >
          <p>Het boekstuk van {dateNL(confirmUndo.decision_date)} vervalt, zodat het resultaat weer onbestemd op {resultLabel} staat. Het blijft bewaard in het journaal, net als bij het heropenen van een boekjaar.</p>
          {confirmUndo.dividend_cents > 0 && (
            <p className="bk-muted">Let op: de dividendschuld van {euroCents(confirmUndo.dividend_cents)} vervalt hiermee. Is het dividend al uitbetaald, corrigeer die betaling dan apart.</p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * Het besluit van de algemene vergadering over de bestemming van het resultaat
 * (art. 2:216 BW). Eén invoerveld: hoeveel gaat er als dividend naar de
 * aandeelhouders. De rest gaat naar de overige reserves, want het besluit moet
 * het hele resultaat bestemmen. Bij een verlies is er niets uit te keren.
 *
 * De balanstest (lid 1) rekent de database uit en blokkeert een te hoog
 * dividend; de uitkeringstest (lid 2) is een oordeel van het bestuur over de
 * toekomst en vraagt hier daarom om een expliciete bevestiging.
 */
function AppropriationDialog({ row, canDistribute, busy, error, resultLabel, onCancel, onConfirm }: {
  row: FiscalYearListRow;
  /** Kapitaalvennootschap: alleen een BV of NV keert dividend uit op aandelen. */
  canDistribute: boolean;
  busy: boolean;
  error?: string | null;
  resultLabel: string;
  onCancel: () => void;
  onConfirm: (input: { decisionDate: string; dividendCents: number; boardApproved: boolean; note: string }) => void;
}) {
  const result = row.result_cents ?? 0;
  const isProfit = result > 0;
  const showDividend = isProfit && canDistribute;
  // De algemene vergadering besluit ná de balansdatum, dus de vroegst mogelijke
  // besluitdatum is de dag erna — de datum van de balansdatum zelf zou de RPC
  // meteen weigeren. Vandaag is de gebruikelijke keuze.
  const earliest = useMemo(() => {
    const d = new Date(`${row.period_end}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }, [row.period_end]);
  const [decisionDate, setDecisionDate] = useState(() => {
    const today = todayIso();
    return today > earliest ? today : earliest;
  });
  const [dividendEuro, setDividendEuro] = useState('0');
  const [boardApproved, setBoardApproved] = useState(false);
  const [note, setNote] = useState('');

  const dividendCents = showDividend ? Math.max(0, Math.round((Number(dividendEuro.replace(',', '.')) || 0) * 100)) : 0;
  const reservesCents = result - dividendCents;
  const dividendTooHigh = dividendCents > Math.max(0, result);
  const dateTooEarly = decisionDate < earliest;
  const blocked = busy || dateTooEarly || dividendTooHigh || (dividendCents > 0 && !boardApproved);

  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal" onClick={e => e.stopPropagation()}>
        <h3>Resultaat {row.label} bestemmen</h3>
        <div className="bk-modal-body">
          <p>Het resultaat van {euroCents(result)} staat nu onbestemd op {resultLabel}. Leg hier vast wat de algemene vergadering heeft besloten.</p>

          <div className="bk-fy-new-fields">
            <label>
              <span>Datum van het besluit</span>
              <input type="date" className="form-input" value={decisionDate} min={earliest} onChange={e => setDecisionDate(e.target.value)} />
            </label>
            {showDividend && (
              <label>
                <span>Dividend</span>
                <input type="number" className="form-input" min="0" step="0.01" value={dividendEuro} onChange={e => setDividendEuro(e.target.value)} />
              </label>
            )}
          </div>

          {dateTooEarly && <p className="bk-neg">De vergadering besluit ná de balansdatum: kies een datum vanaf {dateNL(earliest)}.</p>}
          {dividendTooHigh && <p className="bk-neg">Het dividend kan niet hoger zijn dan het resultaat van {euroCents(result)}.</p>}

          <p className="bk-fy-result">
            {isProfit
              ? <>Naar de overige reserves: <strong>{euroCents(reservesCents)}</strong>{dividendCents > 0 && <> · dividend: <strong>{euroCents(dividendCents)}</strong></>}</>
              : <>Het verlies van <strong className="bk-neg">{euroCents(result)}</strong> gaat volledig ten laste van de overige reserves. Uit een verlies wordt niets uitgekeerd.</>}
          </p>
          {isProfit && !canDistribute && (
            <p className="bk-muted">Deze rechtsvorm kent geen dividend op aandelen; de hele winst gaat naar de reserves.</p>
          )}

          {dividendCents > 0 && (
            <label className="bk-setting-check">
              <input type="checkbox" checked={boardApproved} onChange={e => setBoardApproved(e.target.checked)} />
              <span>
                Het bestuur keurt de uitkering goed: het verwacht dat de vennootschap haar opeisbare schulden ook ná deze uitkering kan blijven betalen (uitkeringstoets, art. 2:216 lid 2 BW).
                <small className="bk-muted"> Zonder die goedkeuring heeft het besluit geen gevolgen. Kan de vennootschap na de uitkering haar opeisbare schulden niet betalen, dan zijn de bestuurders die dat wisten of behoorden te voorzien hoofdelijk verbonden voor het tekort — en moet ook een ontvanger die dat wist of behoorde te voorzien zijn uitkering terugbetalen (lid 3).</small>
              </span>
            </label>
          )}

          <label className="bk-setting-field">
            <span>Toelichting (optioneel)</span>
            <input className="form-input" value={note} placeholder="Bijv. verwijzing naar de notulen van de AvA" onChange={e => setNote(e.target.value)} />
          </label>

          <p className="bk-muted">
            Er komt één boekstuk op de besluitdatum: van {resultLabel} naar 0520 Overige reserves{dividendCents > 0 && ' en 1580 Te betalen dividend'}.
            De balanstest van art. 2:216 lid 1 BW wordt bij het opslaan gecontroleerd op de balansdatum van dit boekjaar.
          </p>

          {error && <div className="error bk-modal-error">{error}</div>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button
            variant="primary"
            disabled={blocked}
            onClick={() => onConfirm({ decisionDate, dividendCents, boardApproved, note })}
          >{busy ? 'Bezig…' : 'Besluit vastleggen'}</Button>
        </div>
      </div>
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
