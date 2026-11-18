import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { History, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import type { Forecast, ForecastVersion, OrganizationMember, UUID } from '../types';
import { Button, Skeleton } from '../components/Ui';
import { Modal } from '../components/Modal';
import { PageIcon } from '../components/PageIcon';
import { Sparkline } from '../components/Charts';
import { askGerrie } from '../components/GerrieChat';
import { formatISODate } from '../lib/dates';
import { memberShortName } from '../lib/members';
import { NotMigratedError } from '../lib/postgrestErrors';
import { createForecast, deleteForecast, loadForecastCashPosition, loadForecastHistory, selectForecastVersions, selectForecasts, updateForecast } from '../lib/repository';
import {
  COST_SOURCE_TEXT, DEFAULT_ASSUMPTIONS, FORECAST_FIELDS, MAX_ITEMS, MAX_MONTH_PROJECTS, addMonths, baselineWindow, changeNote,
  computeCashflow, computeForecast, diffAssumptions, emptyCashPosition, euroText, fieldValueText, historyRange, isCashItem, monthLabel,
  monthOfDate, monthShortName, monthsBetween, normalizeAssumptions, numberText, parseCashPosition, parseForecastInputs, pctText, wholeEuroText,
  type CashPosition, type CashflowResult, type ForecastAssumptions, type ForecastFieldInfo, type ForecastInputs, type ForecastItem,
  type ForecastItemKind, type ForecastResult, type SeasonalPattern,
} from '../lib/forecast';

/**
 * Financiën → Prognose (2026-11-17).
 *
 * Wat je de komende maanden verwacht aan nieuwe projecten, omzet, kosten en
 * winst. De rekenregels staan in src/lib/forecast.ts (dezelfde als die van
 * Gerrie); de cijfers waar "automatisch" op rust, komen uit forecast_history.
 *
 * Aanpassen kan op twee manieren, en die komen op dezelfde plek uit:
 *  - zelf, in de aannames: de cijfers rekenen meteen door, Bewaren legt het vast;
 *  - met Gerrie: "reken met 10% groei" opent de chat; Gerrie zet een wijziging
 *    klaar met de winst ervoor en erna, en pas na jouw akkoord verandert er iets.
 * Elke bewaarde stand staat in de geschiedenis en kun je terugzetten.
 */

const SUGGESTIONS = [
  'Reken met 10% groei per jaar',
  'Een extra medewerker van € 3.500 per maand vanaf volgend kwartaal',
  'Maak een voorzichtig scenario met 20% minder projecten',
];

/** Op de cashflow: wat iemand daar wil weten, als wijziging die Gerrie kan klaarzetten. */
const CASH_SUGGESTIONS = [
  'Een nieuwe bus van € 25.000 in maart',
  'Een lening van € 10.000 volgende maand',
  'Reken met het seizoenspatroon van de vorige jaren',
];

type ForecastView = 'result' | 'cash';

/** Hele euro's, net als de kaart van Gerrie (wholeEuroText). */
const money = wholeEuroText;

function deltaPct(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** "17 nov. 14:32". */
function dateTimeNL(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Een getal zoals iemand het intypt: "2,5", "2.5", "4.750", "€ 1.250,50".
 * Met een komma zijn punten duizendtallen; zonder komma is een punt met
 * precies drie cijfers erachter ook een duizendtal ("4.750"), anders een
 * decimaal ("2.5"). Wie "2.5" projecten bedoelt, kreeg anders er 25.
 */
function parseDecimal(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(/^€/, '');
  if (!t) return null;
  const normalized = t.includes(',')
    ? t.replace(/\./g, '').replace(',', '.')
    : /^-?\d{1,3}(\.\d{3})+$/.test(t) ? t.replace(/\./g, '') : t;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Een getal om te bewerken: komma als decimaalteken, geen duizendtallen. */
function editText(value: number | null): string {
  return value === null ? '' : String(value).replace('.', ',');
}

/**
 * " Laagste saldo € 3.400 → € 900." voor de balk "Nog niet bewaard": een
 * investering verandert de winst niet, het saldo wel. Leeg zonder cashflow,
 * zonder bekend banksaldo of als het niet verandert.
 */
function lowestChange(before: CashflowResult | null, after: CashflowResult | null): string {
  if (!before?.available || !after?.available || !before.lowest || !after.lowest || !after.effective.start_known) return '';
  const was = wholeEuroText(before.lowest.cents);
  const is = wholeEuroText(after.lowest.cents);
  return was === is ? '' : ` Laagste saldo ${was} → ${is}.`;
}

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* privémodus: dan niet onthouden */ }
}

export function ForecastPage({ organizationId, canWrite, canAskGerrie, refreshKey, teamMembers, currentUserId }: {
  organizationId: UUID;
  /** Schrijfrecht op Financiën (en organisatiebreed). */
  canWrite: boolean;
  /** Gerrie staat aan en de module Gerrie is open voor dit teamlid. */
  canAskGerrie: boolean;
  /** Telt op bij elke ververs van de werkruimte: na een goedgekeurd voorstel van Gerrie laadt de pagina opnieuw. */
  refreshKey: number;
  teamMembers: OrganizationMember[];
  currentUserId: UUID | null;
}) {
  const today = formatISODate(new Date());
  const currentMonth = monthOfDate(today);
  const storageKey = `resofly.forecast.${organizationId}`;

  const [forecasts, setForecasts] = useState<Forecast[] | null>(null);
  const [inputs, setInputs] = useState<ForecastInputs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => readStorage(storageKey));
  const [draft, setDraft] = useState<ForecastAssumptions>(() => normalizeAssumptions(DEFAULT_ASSUMPTIONS));
  const [draftName, setDraftName] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | 'new' | 'history' | 'delete'>(null);
  const [question, setQuestion] = useState('');
  const [cash, setCash] = useState<CashPosition | null>(null);
  const [cashError, setCashError] = useState<string | null>(null);
  const viewKey = `resofly.forecast.view.${organizationId}`;
  const [view, setView] = useState<ForecastView>(() => (readStorage(viewKey) === 'cash' ? 'cash' : 'result'));

  function chooseView(next: ForecastView) {
    setView(next);
    writeStorage(viewKey, next);
  }

  // Een ververs na een goedgekeurd voorstel en het bijladen voor een vroeger
  // begin kunnen tegelijk lopen: alleen het laatst gestarte antwoord telt, anders
  // zette een trager, ouder antwoord de vorige versie terug op het scherm.
  const loadSeq = useRef(0);
  const load = useCallback(async (extraStart: string | null = null) => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    // De cashpositie los: lukt die niet (de migratie loopt nog, een tijdelijke
    // fout), dan staat de prognose er gewoon, alleen nog zonder cashflow.
    const cashLoad = loadForecastCashPosition(organizationId)
      .then(raw => ({ position: parseCashPosition(raw, today), error: null as string | null }))
      .catch((error: unknown) => ({
        position: emptyCashPosition(today),
        error: error instanceof NotMigratedError ? null : errorText(error, 'Het banksaldo kon niet worden geladen.'),
      }));
    try {
      const rows = await selectForecasts(organizationId);
      const range = historyRange(today, [...rows.map(row => normalizeAssumptions(row.assumptions).start_month), extraStart]);
      const [raw, cashResult] = await Promise.all([loadForecastHistory(organizationId, range.from, range.to), cashLoad]);
      if (seq !== loadSeq.current) return;
      setForecasts(rows);
      setInputs(parseForecastInputs(raw, today));
      setCash(cashResult.position);
      setCashError(cashResult.error);
      setNotMigrated(false);
    } catch (error) {
      if (seq !== loadSeq.current) return;
      if (error instanceof NotMigratedError) { setNotMigrated(true); setForecasts([]); setInputs(null); return; }
      setLoadError(errorText(error, 'De prognose kon niet worden geladen.'));
    }
  }, [organizationId, today]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const selected = useMemo(
    () => (forecasts ? forecasts.find(forecast => forecast.id === selectedId) ?? forecasts[0] ?? null : null),
    [forecasts, selectedId],
  );
  const savedAssumptions = useMemo(() => normalizeAssumptions(selected?.assumptions ?? DEFAULT_ASSUMPTIONS), [selected]);
  const savedName = selected?.name ?? 'Basis';
  const savedNotes = selected?.notes ?? '';

  // Het concept volgt de bewaarde prognose. Wisselt de prognose, dan begint het
  // concept opnieuw. Komt er van dezelfde prognose een nieuwe versie binnen
  // (een goedgekeurd voorstel van Gerrie, een collega), dan neemt het concept
  // die over, behalve als je zelf iets aan het wijzigen bent: dan blijft je werk
  // staan en zegt een balk dat er een nieuwere versie is.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef<{ id: string | null; version: number; assumptions: ForecastAssumptions; name: string; notes: string } | null>(null);
  useEffect(() => {
    if (forecasts === null) return;
    const previous = baseRef.current;
    const next = { id: selected?.id ?? null, version: selected?.version ?? 0, assumptions: savedAssumptions, name: savedName, notes: savedNotes };
    baseRef.current = next;
    const reset = () => { setDraft(savedAssumptions); setDraftName(savedName); setDraftNotes(savedNotes); setStale(false); };
    if (!previous || previous.id !== next.id) { reset(); return; }
    if (previous.version === next.version) return;
    if (diffAssumptions(previous.assumptions, draftRef.current).length === 0) reset();
    else setStale(true);
  }, [forecasts, selected, savedAssumptions, savedName, savedNotes]);

  // Een begin vóór de opgevraagde maanden: haal die maanden erbij, zodat er
  // werkelijke cijfers naast de prognose staan.
  useEffect(() => {
    if (!inputs || !draft.start_month) return;
    const needed = historyRange(today, [draft.start_month]).from;
    if (needed < inputs.from) void load(draft.start_month);
  }, [draft.start_month, inputs, load, today]);

  const result = useMemo(() => (inputs ? computeForecast(draft, inputs, today) : null), [draft, inputs, today]);
  const savedResult = useMemo(() => (inputs ? computeForecast(savedAssumptions, inputs, today) : null), [savedAssumptions, inputs, today]);
  const flow = useMemo(() => (result && inputs && cash ? computeCashflow(result, inputs, cash, today) : null), [result, inputs, cash, today]);
  const savedFlow = useMemo(() => (savedResult && inputs && cash ? computeCashflow(savedResult, inputs, cash, today) : null), [savedResult, inputs, cash, today]);
  const changes = useMemo(() => {
    const list = diffAssumptions(savedAssumptions, draft);
    if (selected && draftName.trim() && draftName.trim() !== savedName) list.unshift(`Naam: ${savedName} → ${draftName.trim()}`);
    if (selected && draftNotes.trim() !== savedNotes.trim()) list.push('Toelichting aangepast');
    return list;
  }, [savedAssumptions, draft, selected, draftName, savedName, draftNotes, savedNotes]);
  const dirty = changes.length > 0;

  function choose(id: string) {
    if (selected?.id === id) return;
    if (dirty && !window.confirm('Je wijzigingen zijn nog niet bewaard. Toch naar een andere prognose?')) return;
    setSelectedId(id);
    writeStorage(storageKey, id);
    setNotice(null);
    setActionError(null);
  }

  function undo() {
    setDraft(savedAssumptions);
    setDraftName(savedName);
    setDraftNotes(savedNotes);
    setStale(false);
  }

  async function save() {
    if (!canWrite || busy) return;
    setBusy(true); setActionError(null); setNotice(null);
    try {
      if (!selected) {
        const created = await createForecast(organizationId, {
          name: draftName.trim() || 'Basis',
          notes: draftNotes.trim() || null,
          assumptions: draft,
          change_note: changeNote(changes.length ? changes : ['Bewaard zoals uitgerekend']),
        });
        setSelectedId(created.id);
        writeStorage(storageKey, created.id);
      } else {
        const name = draftName.trim();
        await updateForecast(organizationId, selected.id, {
          ...(name && name !== savedName ? { name } : {}),
          ...(draftNotes.trim() !== savedNotes.trim() ? { notes: draftNotes.trim() || null } : {}),
          assumptions: draft,
          change_note: changeNote(changes),
        }, selected.version);
        // Tegen de versie die nu bewaard is, ook na de balk "intussen gewijzigd":
        // de wijzigingen in change_note zijn tegen die versie uitgerekend.
      }
      // Na het bewaren neemt het concept de nieuwe versie vanzelf over.
      baseRef.current = null;
      setNotice('Bewaard.');
      await load(draft.start_month);
    } catch (error) {
      setActionError(errorText(error, 'Bewaren lukte niet.'));
    } finally {
      setBusy(false);
    }
  }

  function ask(text: string) {
    const wish = text.trim();
    if (!wish) return;
    const target = selected
      ? `de prognose "${selected.name}"`
      : 'mijn prognose (er is er nog geen bewaard: maak een nieuwe)';
    askGerrie(`Pas ${target} aan${view === 'cash' ? ' (ik kijk naar de cashflow)' : ''}: ${wish}`);
    setQuestion('');
  }

  function onAsk(event: FormEvent) {
    event.preventDefault();
    ask(question);
  }

  const update = (patch: Partial<ForecastAssumptions>) => setDraft(current => ({ ...current, ...patch }));

  // ── Laden, fout, nog niet beschikbaar ─────────────────────────────────────

  const head = (
    <div className="bk-head fc-head">
      <div><PageIcon page="forecast" /><h2>Prognose</h2><p>Wat je de komende maanden verwacht aan nieuwe projecten, omzet, kosten en winst, en wat er op je rekening staat. Uitgerekend uit je eigen cijfers; pas aan wat je anders verwacht.</p></div>
      {canWrite && !notMigrated && forecasts !== null && <div className="bk-head-actions">
        <Button className="fc-new" onClick={() => setDialog('new')}><Plus size={15} aria-hidden="true" /> Nieuwe prognose</Button>
      </div>}
    </div>
  );

  if (notMigrated) {
    return <div className="bk-page fc-page">{head}<div className="fc-card fc-note" role="status">De prognose staat in deze omgeving nog niet aan: de database wordt nog bijgewerkt. Probeer het over een paar minuten opnieuw.</div></div>;
  }
  if (loadError && (!forecasts || !inputs)) {
    return <div className="bk-page fc-page">{head}<div className="fc-card fc-note is-error" role="alert"><p>{loadError}</p><Button onClick={() => void load()}>Opnieuw proberen</Button></div></div>;
  }
  if (!forecasts || !inputs || !result || !savedResult) {
    return <div className="bk-page fc-page">{head}<Skeleton lines={6} /></div>;
  }

  const projectsVisible = result.baseline.projects_visible;
  const history = result.history_totals;
  const span = `${result.effective.months} ${result.effective.months === 1 ? 'maand' : 'maanden'}`;
  const sameSpan = result.effective.months === 12;
  const perMonth = (cents: number) => cents / Math.max(1, result.effective.months);

  const kpis: Array<{ key: string; label: string; value: string; sub: string; trend: number | null; goodUp: boolean; spark?: number[] }> = [];
  if (projectsVisible) kpis.push({
    key: 'projects', label: 'Nieuwe projecten', value: numberText(result.totals.projects, 1),
    sub: sameSpan ? `vorige 12 maanden ${numberText(history.projects, 1)}` : `${numberText(result.totals.projects / result.effective.months, 1)} per maand · was ${numberText(history.projects / 12, 1)}`,
    trend: sameSpan ? deltaPct(result.totals.projects, history.projects) : null, goodUp: true,
  });
  kpis.push({
    key: 'revenue', label: 'Omzet', value: money(result.totals.revenue_cents),
    sub: sameSpan ? `vorige 12 maanden ${money(history.revenue_cents)}` : `${money(perMonth(result.totals.revenue_cents))} per maand · was ${money(history.revenue_cents / 12)}`,
    trend: sameSpan ? deltaPct(result.totals.revenue_cents, history.revenue_cents) : null, goodUp: true,
    spark: result.months.map(month => month.revenue_cents),
  });
  kpis.push({
    key: 'costs', label: 'Kosten', value: money(result.totals.costs_cents),
    sub: sameSpan ? `vorige 12 maanden ${money(history.costs_cents)}` : `${money(perMonth(result.totals.costs_cents))} per maand · was ${money(history.costs_cents / 12)}`,
    trend: sameSpan ? deltaPct(result.totals.costs_cents, history.costs_cents) : null, goodUp: false,
  });
  kpis.push({
    key: 'profit', label: 'Winst', value: money(result.totals.profit_cents),
    sub: result.totals.margin_pct === null ? `over ${span}` : `marge ${pctText(result.totals.margin_pct)} · vorige 12 maanden ${money(history.profit_cents)}`,
    trend: null, goodUp: true,
  });

  const cashKpis: Array<{ key: string; label: string; value: string; sub: string; danger?: boolean; spark?: number[] }> = [];
  if (flow?.available) {
    const e = flow.effective;
    const knownAccounts = flow.bank.filter(account => account.balance_cents !== null).length;
    const startSub = !e.start_known
      ? 'onbekend: vul het in bij de aannames'
      : !e.start_auto
        ? 'zelf ingevuld'
        : `${knownAccounts} ${knownAccounts === 1 ? 'rekening' : 'rekeningen'}${flow.cash_accounts_cents !== 0 ? ' en de kas' : ''}${flow.unknown_accounts.length > 0 ? ` · ${flow.unknown_accounts.length} onbekend` : ''}`;
    cashKpis.push({ key: 'start', label: 'Saldo nu', value: e.start_known ? money(e.start_cents) : 'Onbekend', sub: startSub });
    if (flow.lowest) {
      const tooLow = flow.below_buffer !== null;
      cashKpis.push({
        key: 'lowest', label: 'Laagste saldo', value: money(flow.lowest.cents), danger: e.start_known && (flow.lowest.cents < 0 || tooLow),
        sub: `${flow.lowest.at_start ? 'nu; daarna niet lager' : `eind ${monthLabel(flow.lowest.month, 'short')}`}${tooLow ? ` · ${e.buffer_cents > 0 ? 'onder je ondergrens' : 'rood'} vanaf ${monthLabel(flow.below_buffer as string, 'short')}` : ''}`,
      });
    }
    const last = flow.months[flow.months.length - 1];
    cashKpis.push({
      key: 'end', label: 'Saldo aan het eind', value: money(flow.end_cents), danger: e.start_known && flow.end_cents < 0,
      sub: `eind ${monthLabel(last.month, 'short')} · ${flow.totals.net_cents >= 0 ? '+' : ''}${money(flow.totals.net_cents)}`,
      spark: flow.months.map(month => month.end_cents),
    });
    const next = flow.vat_payments[0];
    cashKpis.push({
      key: 'vat', label: 'Btw naar de Belastingdienst', value: money(flow.totals.vat_cents),
      sub: e.kor ? 'geen btw: je hebt de KOR' : next ? `eerst ${monthLabel(next.month, 'short')}: ${money(next.cents)} (${next.period})` : 'geen betaling in deze periode',
    });
  }

  return (
    <div className="bk-page fc-page">
      {head}

      <div className="fc-bar">
        <div className="fc-scenarios" role="group" aria-label="Prognoses">
          {forecasts.length === 0
            ? <span className="fc-scenario is-on" aria-current="true">Automatisch <small>nog niet bewaard</small></span>
            : forecasts.map(forecast => <button
                key={forecast.id}
                type="button"
                className={`fc-scenario${forecast.id === selected?.id ? ' is-on' : ''}`}
                aria-pressed={forecast.id === selected?.id}
                onClick={() => choose(forecast.id)}
              >{forecast.name}</button>)}
          {/* Op de telefoon is de kop met de knop verborgen (alleen de werktab draagt de naam). */}
          {canWrite && <button type="button" className="fc-scenario fc-scenario-new fc-new" onClick={() => setDialog('new')}><Plus size={14} aria-hidden="true" /> Nieuwe prognose</button>}
        </div>
        {/* Resultaat of cashflow: dezelfde prognose, twee vragen. Wat verdien
            ik, en wat staat er op mijn rekening. Op de regel van de periode:
            als eigen regel duwde hij op de telefoon het eerste kerncijfer
            onder de 220px die de schermtest toestaat. */}
        <div className="fc-bar-end">
          <div className="fc-views" role="group" aria-label="Weergave">
            <button type="button" className={`fc-view${view === 'result' ? ' is-on' : ''}`} aria-pressed={view === 'result'} onClick={() => chooseView('result')}>Resultaat</button>
            <button type="button" className={`fc-view${view === 'cash' ? ' is-on' : ''}`} aria-pressed={view === 'cash'} onClick={() => chooseView('cash')}>Cashflow</button>
          </div>
          <span className="fc-span">{monthLabel(view === 'cash' && flow?.available ? flow.months[0].month : result.effective.start_month, 'short')} t/m {monthLabel(result.effective.end_month, 'short')}</span>
        </div>
      </div>

      {view === 'result' && <div className="fc-kpis">
        {kpis.map(kpi => {
          const up = kpi.trend !== null && kpi.trend >= 0;
          const good = kpi.trend !== null && (up === kpi.goodUp);
          return <div key={kpi.key} className={`stat-card fc-kpi${kpi.key === 'profit' && result.totals.profit_cents < 0 ? ' stat-card-danger' : ''}`}>
            {kpi.spark && kpi.spark.length > 1 && <Sparkline values={kpi.spark} />}
            <div className="sc-label">{kpi.label}</div>
            <div className="sc-val">{kpi.value}</div>
            <div className="sc-sub">
              {kpi.trend !== null && kpi.trend !== 0 && <span className={`sc-trend ${good ? 'up' : 'down'}`}>{kpi.trend > 0 ? '+' : '−'}{Math.abs(kpi.trend)}%</span>}
              <span>{kpi.sub}</span>
            </div>
          </div>;
        })}
      </div>}

      {view === 'cash' && (flow?.available
        ? <div className="fc-kpis">
          {cashKpis.map(kpi => <div key={kpi.key} className={`stat-card fc-kpi fc-kpi-cash${kpi.danger ? ' stat-card-danger' : ''}`} data-kpi={kpi.key}>
            {kpi.spark && kpi.spark.length > 1 && <Sparkline values={kpi.spark} />}
            <div className="sc-label">{kpi.label}</div>
            <div className="sc-val">{kpi.value}</div>
            <div className="sc-sub"><span>{kpi.sub}</span></div>
          </div>)}
        </div>
        : <div className="fc-card fc-note" role="status">
          <p>{cashError ? `De cashflow kon niet worden geladen: ${cashError}` : flow?.reason ?? 'De cashflow wordt geladen…'}</p>
          {cashError && <Button onClick={() => void load(draft.start_month)}>Opnieuw proberen</Button>}
        </div>)}

      {canAskGerrie && canWrite && <form className="fc-card fc-ask" onSubmit={onAsk}>
        <div className="fc-ask-row">
          <label htmlFor="fc-ask-input" className="fc-ask-label"><Sparkles size={15} aria-hidden="true" /> Pas aan met Gerrie</label>
          <input
            id="fc-ask-input"
            className="form-input"
            value={question}
            onChange={event => setQuestion(event.target.value)}
            placeholder="Wat wil je anders?"
            maxLength={500}
          />
          <Button variant="primary" type="submit" disabled={!question.trim()}>Vraag Gerrie</Button>
        </div>
        <div className="fc-ask-suggest">
          {(view === 'cash' ? CASH_SUGGESTIONS : SUGGESTIONS).map(suggestion => <button key={suggestion} type="button" onClick={() => ask(suggestion)}>{suggestion}</button>)}
        </div>
        <p className="fc-ask-note">Gerrie zet de wijziging klaar met de winst{flow?.available ? ' en het laagste saldo' : ''} ervoor en erna. Er verandert pas iets als jij op Uitvoeren klikt{dirty ? '; hij werkt met de bewaarde versie, dus bewaar eerst je eigen wijzigingen' : ''}.</p>
      </form>}

      {loadError && <div className="fc-card fc-note is-error" role="alert">
        <p>Verversen lukte niet: {loadError} Je ziet de cijfers van daarvoor.</p>
        <Button onClick={() => void load(draft.start_month)}>Opnieuw proberen</Button>
      </div>}

      {stale && <div className="fc-card fc-note" role="status">
        <p>Deze prognose is intussen gewijzigd, bijvoorbeeld door een goedgekeurd voorstel van Gerrie. Jouw wijzigingen zijn nog niet bewaard.</p>
        <Button onClick={undo}>Toon de nieuwe versie</Button>
      </div>}

      {(dirty || notice || actionError) && <div className={`fc-card fc-dirty${actionError ? ' is-error' : ''}`} role={actionError ? 'alert' : 'status'}>
        {actionError
          ? <p>{actionError}</p>
          : dirty
            ? <p><b>Nog niet bewaard:</b> {changes.slice(0, 4).join(' · ')}{changes.length > 4 ? ` en ${changes.length - 4} meer` : ''}. Verwachte winst {money(savedResult.totals.profit_cents)} → {money(result.totals.profit_cents)}.{lowestChange(savedFlow, flow)}</p>
            : <p>{notice}</p>}
        {dirty && <div className="fc-dirty-acts">
          <Button onClick={undo} disabled={busy}><RotateCcw size={14} aria-hidden="true" /> Ongedaan maken</Button>
          {canWrite && <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? 'Bewaren…' : selected ? 'Bewaren' : 'Bewaren als prognose'}</Button>}
        </div>}
      </div>}

      {view === 'result' && result.so_far && <div className="fc-card fc-sofar">
        <b>Tot nu toe</b> ({result.so_far.months} {result.so_far.months === 1 ? 'maand' : 'maanden'}): omzet {money(result.so_far.actual.revenue_cents)} werkelijk tegen {money(result.so_far.expected.revenue_cents)} verwacht, winst {money(result.so_far.actual.profit_cents)} tegen {money(result.so_far.expected.profit_cents)}.
      </div>}

      <div className="fc-layout">
        {view === 'result'
          ? <div className="fc-main">
            <section className="fc-card fc-chart-card" aria-labelledby="fc-chart-title">
              <div className="fc-card-head">
                <h3 id="fc-chart-title">Omzet en kosten per maand</h3>
                <ChartLegend />
              </div>
              <ForecastChart result={result} currentMonth={currentMonth} />
            </section>

            <ForecastTable result={result} projectsVisible={projectsVisible} />
          </div>
          : <div className="fc-main">
            {flow?.available && <>
              {flow.notes.length > 0 && <div className="fc-card fc-cash-notes" role="note">
                <ul>{flow.notes.map(note => <li key={note}>{note}</li>)}</ul>
              </div>}
              <section className="fc-card fc-chart-card" aria-labelledby="fc-cash-title">
                <div className="fc-card-head">
                  <h3 id="fc-cash-title">Saldo aan het eind van elke maand</h3>
                  <CashLegend buffer={flow.effective.buffer_cents} />
                </div>
                <CashChart flow={flow} />
              </section>
              <CashTable flow={flow} />
            </>}
          </div>}

        <aside className="fc-side">
          <AssumptionsPanel
            result={result}
            flow={flow}
            view={view}
            draft={draft}
            onChange={update}
            canWrite={canWrite}
            name={draftName}
            notes={draftNotes}
            onName={setDraftName}
            onNotes={setDraftNotes}
            showName={Boolean(selected)}
            currentMonth={currentMonth}
          />
          <BasisPanel result={result} flow={flow} view={view} inputs={inputs} draft={draft} canWrite={canWrite} onAddItem={(item) => update({ items: [...draft.items, item] })} />
        </aside>
      </div>

      {selected && <div className="fc-foot">
        <span>Versie {selected.version} · bijgewerkt {dateTimeNL(selected.updated_at)}{selected.updated_by ? ` door ${selected.updated_by === currentUserId ? 'jou' : memberShortName(selected.updated_by, teamMembers, currentUserId)}` : ''}</span>
        <span className="fc-foot-acts">
          <Button onClick={() => setDialog('history')}><History size={14} aria-hidden="true" /> Geschiedenis</Button>
          {canWrite && <Button variant="danger" onClick={() => setDialog('delete')}><Trash2 size={14} aria-hidden="true" /> Verwijderen</Button>}
        </span>
      </div>}

      {dialog === 'new' && <NewForecastDialog
        names={forecasts.map(forecast => forecast.name)}
        current={selected ? draftName.trim() || selected.name : dirty ? 'Automatisch' : null}
        onClose={() => setDialog(null)}
        onCreate={async (name, copy) => {
          const created = await createForecast(organizationId, {
            name,
            assumptions: copy ? draft : normalizeAssumptions(DEFAULT_ASSUMPTIONS),
            change_note: copy && selected ? `Kopie van ${selected.name}` : copy ? changeNote(['Bewaard zoals op het scherm', ...changes]) : 'Nieuwe prognose, automatisch uit de cijfers',
          });
          setSelectedId(created.id);
          writeStorage(storageKey, created.id);
          baseRef.current = null;
          setDialog(null);
          setNotice(`Prognose "${created.name}" aangemaakt.`);
          await load(copy ? draft.start_month : null);
        }}
      />}

      {dialog === 'history' && selected && <HistoryDialog
        organizationId={organizationId}
        forecast={selected}
        canWrite={canWrite}
        teamMembers={teamMembers}
        currentUserId={currentUserId}
        onClose={() => setDialog(null)}
        onRestore={async (version) => {
          await updateForecast(organizationId, selected.id, {
            name: version.name,
            notes: version.notes,
            assumptions: normalizeAssumptions(version.assumptions),
            change_note: `Versie ${version.version} teruggezet`,
          }, selected.version);
          baseRef.current = null;
          setDialog(null);
          setNotice(`Versie ${version.version} teruggezet.`);
          await load(normalizeAssumptions(version.assumptions).start_month);
        }}
      />}

      {dialog === 'delete' && selected && <Modal
        title="Prognose verwijderen"
        onClose={() => setDialog(null)}
        footer={<>
          <Button onClick={() => setDialog(null)}>Annuleren</Button>
          <Button variant="danger" disabled={busy} onClick={async () => {
            setBusy(true); setActionError(null);
            try {
              await deleteForecast(organizationId, selected.id);
              const rest = forecasts.filter(forecast => forecast.id !== selected.id);
              setSelectedId(rest[0]?.id ?? null);
              writeStorage(storageKey, rest[0]?.id ?? '');
              baseRef.current = null;
              setDialog(null);
              setNotice(`Prognose "${selected.name}" verwijderd.`);
              await load();
            } catch (error) {
              setActionError(errorText(error, 'Verwijderen lukte niet.'));
              setDialog(null);
            } finally {
              setBusy(false);
            }
          }}>Verwijderen</Button>
        </>}
      >
        <p>"{selected.name}" en al zijn versies verdwijnen. Er gaat geen factuur of boeking mee weg: een prognose is alleen een verwachting.</p>
      </Modal>}
    </div>
  );
}

// ── De grafiek ──────────────────────────────────────────────────────────────

function ChartLegend() {
  return <ul className="fc-legend" aria-label="Legenda">
    <li><span className="fc-key is-rev" aria-hidden="true" />Omzet</li>
    <li><span className="fc-key is-cost" aria-hidden="true" />Kosten</li>
    <li><span className="fc-key is-dash" aria-hidden="true" />Prognose</li>
  </ul>;
}

interface ChartPoint {
  month: string;
  actualRevenue: number | null;
  actualCosts: number | null;
  forecastRevenue: number | null;
  forecastCosts: number | null;
  profit: number | null;
  projects: number | null;
  complete: boolean;
}

function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(240, Math.round(node.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Ronde stappen voor de as: 1, 2, 2,5 of 5 maal een macht van tien. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

function axisMoney(cents: number): string {
  const euros = cents / 100;
  if (Math.abs(euros) >= 1000000) return `€ ${numberText(euros / 1000000, 1)} mln`;
  if (Math.abs(euros) >= 10000) return `€ ${numberText(euros / 1000, 0)}k`;
  return euroText(Math.round(euros) * 100);
}

/**
 * Omzet en kosten per maand, één as in euro's. Doorgetrokken: wat er werkelijk
 * was; gestippeld: de prognose. De winst is de afstand tussen de twee lijnen;
 * het bedrag staat in de tooltip en in de tabel eronder. Met de muis of de
 * pijltjestoetsen loop je langs de maanden.
 */
function ForecastChart({ result, currentMonth }: { result: ForecastResult; currentMonth: string }) {
  const [boxRef, width] = useWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<number | null>(null);
  const descriptionId = useId();

  const points = useMemo(() => {
    const learnFrom = baselineWindow(`${currentMonth}-01`).from;
    const first = result.effective.start_month < learnFrom ? result.effective.start_month : learnFrom;
    const last = result.effective.end_month > currentMonth ? result.effective.end_month : currentMonth;
    const byForecast = new Map(result.months.map(month => [month.month, month]));
    const byHistory = new Map(result.history.map(month => [month.month, month]));
    const list: ChartPoint[] = [];
    for (let index = 0; index <= monthsBetween(first, last); index += 1) {
      const month = addMonths(first, index);
      const forecast = byForecast.get(month);
      const historyPoint = byHistory.get(month);
      const actual = forecast?.actual ?? (historyPoint && month < currentMonth
        ? { revenue_cents: historyPoint.revenue_cents, costs_cents: historyPoint.costs_cents, projects: historyPoint.projects, complete: true }
        : null);
      list.push({
        month,
        actualRevenue: actual && actual.complete ? actual.revenue_cents : null,
        actualCosts: actual && actual.complete ? actual.costs_cents : null,
        forecastRevenue: forecast ? forecast.revenue_cents : null,
        forecastCosts: forecast ? forecast.costs_cents : null,
        profit: forecast ? forecast.profit_cents : actual && actual.complete ? actual.revenue_cents - actual.costs_cents : null,
        projects: forecast ? forecast.projects : actual ? actual.projects : null,
        complete: Boolean(actual?.complete),
      });
    }
    return list;
  }, [result, currentMonth]);

  const height = width < 520 ? 210 : 250;
  const pad = { left: width < 520 ? 52 : 64, right: 14, top: 22, bottom: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = points.flatMap(point => [point.actualRevenue, point.actualCosts, point.forecastRevenue, point.forecastCosts]).filter((value): value is number => value !== null);
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const step = niceStep((rawMax - rawMin) / 4 || 100000);
  const top = Math.max(step, Math.ceil(rawMax / step) * step);
  const bottom = Math.min(0, Math.floor(rawMin / step) * step);
  const ticks: number[] = [];
  for (let value = bottom; value <= top + step / 2; value += step) ticks.push(value);
  const n = points.length;
  const x = (index: number) => pad.left + (n <= 1 ? innerW / 2 : (index / (n - 1)) * innerW);
  const y = (value: number) => pad.top + innerH - ((value - bottom) / (top - bottom || 1)) * innerH;

  const path = (pick: (point: ChartPoint) => number | null) => {
    let d = '';
    let open = false;
    points.forEach((point, index) => {
      const value = pick(point);
      if (value === null) { open = false; return; }
      d += `${open ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      open = true;
    });
    return d;
  };

  const forecastStart = points.findIndex(point => point.forecastRevenue !== null);
  const forecastEnd = points.length - 1 - [...points].reverse().findIndex(point => point.forecastRevenue !== null);
  const nowIndex = points.findIndex(point => point.month === currentMonth);
  const lastForecast = forecastEnd >= 0 ? points[forecastEnd] : null;

  // Maandlabels die elkaar nooit raken. Eerst de vaste ankers (het begin, het
  // eind en elke januari, met het jaartal erbij), dan de andere maanden waar er
  // ruimte is. Met een vaste stap van twee maanden kwamen "nov 25" en "jan 26"
  // tegen elkaar aan, en "sep" tegen "okt" aan het eind; schoof je de stap op,
  // dan viel januari weg en zag je de jaarwissel niet meer.
  const axisLabels = useMemo(() => {
    const text = (index: number) => {
      const month = points[index].month;
      return month.endsWith('-01') || index === 0 ? `${monthShortName(month)} ${month.slice(2, 4)}` : monthShortName(month);
    };
    const span = (index: number): [number, number] => {
      const width = text(index).length * 6.6 + 6;
      const at = x(index);
      return index === 0 ? [at, at + width] : index === n - 1 ? [at - width, at] : [at - width / 2, at + width / 2];
    };
    const order = [
      0, n - 1,
      ...points.map((point, index) => (point.month.endsWith('-01') ? index : -1)).filter(index => index > 0 && index < n - 1),
      ...points.map((_, index) => index).filter(index => index > 0 && index < n - 1 && !points[index].month.endsWith('-01')),
    ];
    const chosen: Array<[number, number, number]> = [];
    for (const index of order) {
      if (index < 0 || index >= n || chosen.some(([i]) => i === index)) continue;
      const [left, right] = span(index);
      if (chosen.every(([, l, r]) => right + 8 <= l || left >= r + 8)) chosen.push([index, left, right]);
    }
    return chosen.sort((a, b) => a[0] - b[0]).map(([index]) => ({ index, text: text(index) }));
  // x hangt alleen af van n en innerW.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, n, innerW]);

  function pick(clientX: number, target: Element) {
    const box = target.getBoundingClientRect();
    const local = clientX - box.left;
    const index = n <= 1 ? 0 : Math.round(((local - pad.left) / innerW) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, index)));
  }

  function onKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { setActive(null); return; }
    const from = active ?? (forecastStart >= 0 ? forecastStart : n - 1);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : event.key === 'ArrowLeft' ? from - 1 : from + 1;
    setActive(Math.min(n - 1, Math.max(0, next)));
  }

  const shown = active !== null ? points[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(x(active), 90), width - 90) : 0;

  return <div
    ref={boxRef}
    className="fc-chart"
    tabIndex={0}
    role="group"
    aria-label="Grafiek met omzet en kosten per maand. Pijltjes links en rechts lopen langs de maanden; de tabel eronder heeft alle cijfers."
    aria-describedby={descriptionId}
    onKeyDown={onKey}
    onBlur={() => setActive(null)}
  >
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"
      onPointerMove={(event: ReactPointerEvent<SVGSVGElement>) => pick(event.clientX, event.currentTarget)}
      onPointerDown={(event: ReactPointerEvent<SVGSVGElement>) => pick(event.clientX, event.currentTarget)}
      onPointerLeave={() => setActive(null)}
    >
      {forecastStart >= 0 && <rect className="fc-band" x={x(forecastStart) - (n > 1 ? innerW / (n - 1) / 2 : 0)} y={pad.top} width={Math.max(0, x(forecastEnd) - x(forecastStart) + (n > 1 ? innerW / (n - 1) : 0))} height={innerH} />}
      {ticks.map(value => <g key={value}>
        <line className={value === 0 ? 'fc-axis' : 'fc-grid'} x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} />
        <text className="fc-tick" x={pad.left - 8} y={y(value) + 4} textAnchor="end">{axisMoney(value)}</text>
      </g>)}
      {nowIndex >= 0 && <g>
        <line className="fc-now" x1={x(nowIndex)} x2={x(nowIndex)} y1={pad.top - 6} y2={pad.top + innerH} />
        <text className="fc-tick fc-now-label" x={x(nowIndex)} y={pad.top - 9} textAnchor="middle">nu</text>
      </g>}
      <path className="fc-line is-rev" d={path(point => point.actualRevenue)} />
      <path className="fc-line is-cost" d={path(point => point.actualCosts)} />
      <path className="fc-line is-rev is-dash" d={path(point => point.forecastRevenue)} />
      <path className="fc-line is-cost is-dash" d={path(point => point.forecastCosts)} />
      {lastForecast && lastForecast.forecastRevenue !== null && lastForecast.forecastCosts !== null && <>
        <circle className="fc-dot is-rev" cx={x(forecastEnd)} cy={y(lastForecast.forecastRevenue)} r={4} />
        <circle className="fc-dot is-cost" cx={x(forecastEnd)} cy={y(lastForecast.forecastCosts)} r={4} />
      </>}
      {axisLabels.map(label => <text
        key={points[label.index].month}
        className="fc-tick"
        x={x(label.index)}
        y={height - 10}
        textAnchor={label.index === 0 ? 'start' : label.index === n - 1 ? 'end' : 'middle'}
      >{label.text}</text>)}
      {active !== null && <line className="fc-cross" x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + innerH} />}
      {active !== null && shown && <>
        {shown.forecastRevenue !== null && <circle className="fc-dot is-rev" cx={x(active)} cy={y(shown.forecastRevenue)} r={4} />}
        {shown.forecastCosts !== null && <circle className="fc-dot is-cost" cx={x(active)} cy={y(shown.forecastCosts)} r={4} />}
        {shown.actualRevenue !== null && <circle className="fc-dot is-rev" cx={x(active)} cy={y(shown.actualRevenue)} r={4} />}
        {shown.actualCosts !== null && <circle className="fc-dot is-cost" cx={x(active)} cy={y(shown.actualCosts)} r={4} />}
      </>}
    </svg>
    <p id={descriptionId} className="fc-sr">De tabel onder de grafiek toont per maand dezelfde cijfers.</p>
    {shown && <div className="fc-tip" style={{ left: tipLeft }} role="status">
      <b>{monthLabel(shown.month)}</b>
      {shown.forecastRevenue !== null && <span><i className="fc-key is-rev is-dash" aria-hidden="true" /><strong>{money(shown.forecastRevenue)}</strong> omzet (prognose)</span>}
      {shown.forecastCosts !== null && <span><i className="fc-key is-cost is-dash" aria-hidden="true" /><strong>{money(shown.forecastCosts)}</strong> kosten (prognose)</span>}
      {shown.actualRevenue !== null && <span><i className="fc-key is-rev" aria-hidden="true" /><strong>{money(shown.actualRevenue)}</strong> omzet (werkelijk)</span>}
      {shown.actualCosts !== null && <span><i className="fc-key is-cost" aria-hidden="true" /><strong>{money(shown.actualCosts)}</strong> kosten (werkelijk)</span>}
      {shown.profit !== null && <span><strong>{money(shown.profit)}</strong> winst</span>}
      {shown.projects !== null && <span><strong>{numberText(shown.projects, 1)}</strong> nieuwe projecten</span>}
    </div>}
  </div>;
}

// ── De tabel ────────────────────────────────────────────────────────────────

function ForecastTable({ result, projectsVisible }: { result: ForecastResult; projectsVisible: boolean }) {
  return <div className="bk-table-wrap fc-table-wrap">
    <table className="bk-table fc-table">
      <caption className="fc-sr">Prognose per maand</caption>
      <thead>
        <tr>
          <th scope="col">Maand</th>
          {projectsVisible && <th scope="col" className="bk-num fc-col-proj">Projecten</th>}
          <th scope="col" className="bk-num">Omzet</th>
          <th scope="col" className="bk-num">Kosten</th>
          <th scope="col" className="bk-num">Winst</th>
          <th scope="col" className="bk-num fc-col-cum">Winst t/m</th>
        </tr>
      </thead>
      <tbody>
        {result.months.map(month => {
          const actual = month.actual;
          const actualWord = actual?.complete ? 'werkelijk' : 'tot nu';
          return <tr key={month.month} className={actual?.complete ? 'is-past' : undefined}>
            <th scope="row">{monthLabel(month.month, 'short')}{month.projects_set && <small className="fc-mark" title="Eigen aantal projecten voor deze maand">eigen aantal</small>}{projectsVisible && <small className="fc-proj-inline">{numberText(month.projects, 1)} {month.projects === 1 ? 'project' : 'projecten'}</small>}</th>
            {projectsVisible && <td className="bk-num fc-col-proj">{numberText(month.projects, 1)}{actual && actual.projects !== null && <small>{actualWord} {actual.projects}</small>}</td>}
            <td className="bk-num">{money(month.revenue_cents)}{actual && <small>{actualWord} {money(actual.revenue_cents)}</small>}</td>
            <td className="bk-num">{money(month.costs_cents)}{actual && <small>{actualWord} {money(actual.costs_cents)}</small>}</td>
            <td className={`bk-num${month.profit_cents < 0 ? ' fc-neg' : ''}`}>{money(month.profit_cents)}{actual && <small>{actualWord} {money(actual.profit_cents)}</small>}</td>
            <td className={`bk-num fc-col-cum${month.cumulative_profit_cents < 0 ? ' fc-neg' : ''}`}>{money(month.cumulative_profit_cents)}</td>
          </tr>;
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Totaal{projectsVisible && <small className="fc-proj-inline">{numberText(result.totals.projects, 1)} projecten</small>}</th>
          {projectsVisible && <td className="bk-num fc-col-proj">{numberText(result.totals.projects, 1)}</td>}
          <td className="bk-num">{money(result.totals.revenue_cents)}</td>
          <td className="bk-num">{money(result.totals.costs_cents)}</td>
          <td className={`bk-num${result.totals.profit_cents < 0 ? ' fc-neg' : ''}`}>{money(result.totals.profit_cents)}</td>
          <td className="bk-num fc-col-cum">{result.totals.margin_pct === null ? '' : `marge ${pctText(result.totals.margin_pct)}`}</td>
        </tr>
      </tfoot>
    </table>
  </div>;
}

// ── De cashflow ─────────────────────────────────────────────────────────────

function CashLegend({ buffer }: { buffer: number }) {
  return <ul className="fc-legend" aria-label="Legenda">
    <li><span className="fc-key is-cash" aria-hidden="true" />Saldo</li>
    {buffer > 0 && <li><span className="fc-key is-buffer" aria-hidden="true" />Ondergrens</li>}
  </ul>;
}

/**
 * Het saldo aan het eind van elke maand, van nu tot het eind van de prognose.
 * Eén lijn, één as in euro's; de nullijn is donkerder en een ondergrens
 * gestippeld. Een maand onder nul of onder de ondergrens krijgt een rode
 * stip. In de tooltip wat er die maand binnenkomt en uitgaat; de tabel eronder
 * heeft dezelfde cijfers.
 */
interface CashPoint {
  key: string;
  /** Null: het saldo van nu, vóór de eerste maand. */
  month: CashflowResult['months'][number] | null;
  end_cents: number;
}

function CashChart({ flow }: { flow: CashflowResult }) {
  const [boxRef, width] = useWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<number | null>(null);
  const descriptionId = useId();
  // Het saldo van nu als eerste punt: het laagste saldo kan nu zijn, en een
  // lijn die pas eind deze maand begint, liet dat niet zien.
  const points = useMemo<CashPoint[]>(() => [
    { key: 'nu', month: null, end_cents: flow.effective.start_cents },
    ...flow.months.map(month => ({ key: month.month, month, end_cents: month.end_cents })),
  ], [flow]);
  const buffer = flow.effective.buffer_cents;
  const height = width < 520 ? 200 : 240;
  const pad = { left: width < 520 ? 52 : 64, right: 14, top: 18, bottom: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = [...points.map(point => point.end_cents), buffer];
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const step = niceStep((rawMax - rawMin) / 4 || 100000);
  const top = Math.max(step, Math.ceil(rawMax / step) * step);
  const bottom = Math.min(0, Math.floor(rawMin / step) * step);
  const ticks: number[] = [];
  for (let value = bottom; value <= top + step / 2; value += step) ticks.push(value);
  const n = points.length;
  const x = (index: number) => pad.left + (n <= 1 ? innerW / 2 : (index / (n - 1)) * innerW);
  const y = (value: number) => pad.top + innerH - ((value - bottom) / (top - bottom || 1)) * innerH;
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.end_cents).toFixed(1)}`).join('');
  const low = (cents: number) => flow.effective.start_known && (cents < 0 || cents < buffer);

  // Dezelfde regel als de grafiek van het resultaat: eerst het begin, het eind
  // en elke januari, dan de rest waar er ruimte is. Labels raken elkaar nooit.
  const labels = useMemo(() => {
    const text = (index: number) => {
      const month = points[index].month?.month;
      if (!month) return 'nu';
      return month.endsWith('-01') || index === 1 ? `${monthShortName(month)} ${month.slice(2, 4)}` : monthShortName(month);
    };
    const span = (index: number): [number, number] => {
      const w = text(index).length * 6.6 + 6;
      const at = x(index);
      return index === 0 ? [at, at + w] : index === n - 1 ? [at - w, at] : [at - w / 2, at + w / 2];
    };
    const isJanuary = (index: number) => Boolean(points[index].month?.month.endsWith('-01'));
    const order = [0, n - 1, ...points.map((_, index) => (isJanuary(index) ? index : -1)).filter(index => index > 0 && index < n - 1),
      ...points.map((_, index) => index).filter(index => index > 0 && index < n - 1 && !isJanuary(index))];
    const chosen: Array<[number, number, number]> = [];
    for (const index of order) {
      if (index < 0 || index >= n || chosen.some(([i]) => i === index)) continue;
      const [left, right] = span(index);
      if (chosen.every(([, l, r]) => right + 8 <= l || left >= r + 8)) chosen.push([index, left, right]);
    }
    return chosen.sort((a, b) => a[0] - b[0]).map(([index]) => ({ index, text: text(index) }));
  // x hangt alleen af van n en innerW.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, n, innerW]);

  function pick(clientX: number, target: Element) {
    const box = target.getBoundingClientRect();
    const index = n <= 1 ? 0 : Math.round(((clientX - box.left - pad.left) / innerW) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, index)));
  }

  function onKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { setActive(null); return; }
    const from = active ?? 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : event.key === 'ArrowLeft' ? from - 1 : from + 1;
    setActive(Math.min(n - 1, Math.max(0, next)));
  }

  const shown = active !== null ? points[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(x(active), 95), width - 95) : 0;
  return <div
    ref={boxRef}
    className="fc-chart"
    tabIndex={0}
    role="group"
    aria-label="Grafiek met het saldo aan het eind van elke maand. Pijltjes links en rechts lopen langs de maanden; de tabel eronder heeft alle cijfers."
    aria-describedby={descriptionId}
    onKeyDown={onKey}
    onBlur={() => setActive(null)}
  >
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"
      onPointerMove={(event: ReactPointerEvent<SVGSVGElement>) => pick(event.clientX, event.currentTarget)}
      onPointerDown={(event: ReactPointerEvent<SVGSVGElement>) => pick(event.clientX, event.currentTarget)}
      onPointerLeave={() => setActive(null)}
    >
      {ticks.map(value => <g key={value}>
        <line className={value === 0 ? 'fc-axis' : 'fc-grid'} x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} />
        <text className="fc-tick" x={pad.left - 8} y={y(value) + 4} textAnchor="end">{axisMoney(value)}</text>
      </g>)}
      {buffer > 0 && <line className="fc-buffer" x1={pad.left} x2={width - pad.right} y1={y(buffer)} y2={y(buffer)} />}
      <path className="fc-line is-cash" d={line} />
      {points.map((point, index) => (low(point.end_cents) || index === 0 || index === n - 1 || index === active)
        ? <circle key={point.key} className={`fc-dot ${low(point.end_cents) ? 'is-low' : 'is-cash'}`} cx={x(index)} cy={y(point.end_cents)} r={4} />
        : null)}
      {labels.map(label => <text
        key={points[label.index].key}
        className="fc-tick"
        x={x(label.index)}
        y={height - 10}
        textAnchor={label.index === 0 ? 'start' : label.index === n - 1 ? 'end' : 'middle'}
      >{label.text}</text>)}
      {active !== null && <line className="fc-cross" x1={x(active)} x2={x(active)} y1={pad.top} y2={pad.top + innerH} />}
    </svg>
    <p id={descriptionId} className="fc-sr">De tabel onder de grafiek toont per maand wat er binnenkomt, uitgaat en overblijft.</p>
    {shown && !shown.month && <div className="fc-tip" style={{ left: tipLeft }} role="status">
      <b>Nu</b>
      <span><i className="fc-key is-cash" aria-hidden="true" /><strong>{flow.effective.start_known ? money(shown.end_cents) : 'onbekend'}</strong> saldo</span>
    </div>}
    {shown?.month && <div className="fc-tip" style={{ left: tipLeft }} role="status">
      <b>{monthLabel(shown.month.month)}{shown.month.partial ? ' (vanaf vandaag)' : ''}</b>
      <span><strong>{money(shown.month.in_open_cents + shown.month.in_sales_cents)}</strong> binnen</span>
      <span><strong>{money(shown.month.out_open_cents + shown.month.out_costs_cents)}</strong> uit</span>
      {shown.month.vat_cents !== 0 && <span><strong>{money(shown.month.vat_cents)}</strong> btw ({shown.month.vat_periods.join(', ')})</span>}
      {shown.month.other_cents !== 0 && <span><strong>{money(Math.abs(shown.month.other_cents))}</strong> {shown.month.other_cents > 0 ? 'geld erbij' : 'geld eraf'}</span>}
      <span><i className="fc-key is-cash" aria-hidden="true" /><strong>{money(shown.end_cents)}</strong> saldo</span>
    </div>}
  </div>;
}

function CashTable({ flow }: { flow: CashflowResult }) {
  const buffer = flow.effective.buffer_cents;
  const known = flow.effective.start_known;
  return <div className="bk-table-wrap fc-table-wrap">
    <table className="bk-table fc-table fc-cash-table">
      <caption className="fc-sr">Cashflow per maand</caption>
      <thead>
        <tr>
          <th scope="col">Maand</th>
          <th scope="col" className="bk-num">Binnen</th>
          <th scope="col" className="bk-num">Uit</th>
          <th scope="col" className="bk-num fc-col-vat">Btw</th>
          <th scope="col" className="bk-num fc-col-other">Geld erbij/eraf</th>
          <th scope="col" className="bk-num">Saldo</th>
        </tr>
      </thead>
      <tbody>
        <tr className="is-past">
          <th scope="row">Nu</th>
          <td className="bk-num" />
          <td className="bk-num" />
          <td className="bk-num fc-col-vat" />
          <td className="bk-num fc-col-other" />
          <td className={`bk-num${known && flow.effective.start_cents < 0 ? ' fc-neg' : ''}`}>{known ? money(flow.effective.start_cents) : 'onbekend'}</td>
        </tr>
        {flow.months.map(month => {
          const low = known && (month.end_cents < 0 || month.end_cents < buffer);
          return <tr key={month.month}>
            <th scope="row">
              {monthLabel(month.month, 'short')}
              {month.partial && <small>vanaf vandaag</small>}
              {month.vat_cents !== 0 && <small className="fc-vat-inline">btw {money(month.vat_cents)}</small>}
              {month.other_cents !== 0 && <small className="fc-other-inline">{month.other_cents > 0 ? 'geld erbij' : 'geld eraf'} {money(Math.abs(month.other_cents))}</small>}
            </th>
            <td className="bk-num">{money(month.in_open_cents + month.in_sales_cents)}{month.in_open_cents !== 0 && <small className="fc-open-sub">open {money(month.in_open_cents)}</small>}</td>
            <td className="bk-num">{money(month.out_open_cents + month.out_costs_cents)}{month.out_open_cents !== 0 && <small className="fc-open-sub">open {money(month.out_open_cents)}</small>}</td>
            <td className="bk-num fc-col-vat">{month.vat_cents !== 0 ? money(month.vat_cents) : '–'}{month.vat_periods.length > 0 && <small>{month.vat_periods.join(', ')}</small>}</td>
            <td className="bk-num fc-col-other">{month.other_cents !== 0 ? money(month.other_cents) : '–'}</td>
            <td className={`bk-num${low ? ' fc-neg' : ''}`}>{money(month.end_cents)}{low && <small>{month.end_cents < 0 ? 'rood' : 'onder de ondergrens'}</small>}</td>
          </tr>;
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Totaal{flow.totals.vat_cents !== 0 && <small className="fc-vat-inline">btw {money(flow.totals.vat_cents)}</small>}</th>
          <td className="bk-num">{money(flow.totals.in_cents)}</td>
          <td className="bk-num">{money(flow.totals.out_cents)}</td>
          <td className="bk-num fc-col-vat">{money(flow.totals.vat_cents)}</td>
          <td className="bk-num fc-col-other">{money(flow.totals.other_cents)}</td>
          <td className={`bk-num${known && flow.end_cents < 0 ? ' fc-neg' : ''}`}>{money(flow.end_cents)}</td>
        </tr>
      </tfoot>
    </table>
  </div>;
}

// ── Het seizoen ─────────────────────────────────────────────────────────────

/**
 * De twaalf maanden van het seizoenspatroon als staafjes: hoe druk elke maand
 * was tegen een gemiddelde maand (de streep op 100%). Met het percentage
 * eronder, zodat het ook zonder kleur en zonder de staafjes te lezen is.
 */
function SeasonBars({ season, strength }: { season: SeasonalPattern; strength: number }) {
  const max = Math.max(1.2, ...season.index);
  const applied = (value: number) => 1 + (strength / 100) * (value - 1);
  return <ol className="fc-season" aria-label="Seizoenspatroon per maand; 100% is een gemiddelde maand">
    {season.index.map((value, cal) => {
      const pct = Math.round(value * 100);
      const used = Math.round(applied(value) * 100);
      return <li key={cal} className={value >= 1 ? 'is-busy' : 'is-quiet'} title={strength > 0 && strength < 100 ? `${pct}% in de vorige jaren, ${used}% in de prognose` : `${pct}%`}>
        <span className="fc-season-bar" aria-hidden="true"><span style={{ height: `${Math.max(2, (value / max) * 100)}%` }} /><i style={{ bottom: `${(1 / max) * 100}%` }} /></span>
        <span className="fc-season-m">{monthShortName(`2000-${String(cal + 1).padStart(2, '0')}`)}</span>
        <span className="fc-season-v">{pct}%</span>
      </li>;
    })}
  </ol>;
}

// ── De aannames ─────────────────────────────────────────────────────────────

function autoText(field: ForecastFieldInfo, result: ForecastResult, flow: CashflowResult | null): string | null {
  if (!field.auto) return null;
  if (field.key === 'projects_per_month') return numberText(result.baseline.projects_per_month, 2);
  if (field.key === 'revenue_per_project') return money(result.baseline.revenue_per_project_cents);
  if (field.key === 'other_revenue') return money(result.baseline.other_revenue_cents);
  if (field.key === 'fixed_costs') return money(result.baseline.fixed_costs_cents);
  if (!flow) return null;
  const e = flow.effective;
  if (field.key === 'cash_start') return e.start_known ? money(e.start_cents) : 'onbekend';
  if (field.key === 'collection_days') return fieldValueText('collection_days', e.collection_days);
  if (field.key === 'vat_sales_pct') return pctText(e.vat_sales_pct);
  if (field.key === 'vat_costs_pct') return pctText(e.vat_costs_pct);
  if (field.key === 'noncash_costs') return money(e.noncash_cents);
  return null;
}

function NumberField({ field, value, auto, disabled, onChange }: {
  field: ForecastFieldInfo;
  value: number | null;
  /** Wat "automatisch" nu is, als tekst ("€ 4.750"); null bij een veld zonder automatisch. */
  auto: string | null;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(editText(value));
  const [focused, setFocused] = useState(false);
  // Van buiten gewijzigd (Ongedaan maken, een nieuwe versie): het veld volgt,
  // behalve terwijl je erin typt.
  useEffect(() => {
    if (!focused) setText(editText(value));
  }, [value, focused]);

  const parsed = parseDecimal(text);
  let problem: string | null = null;
  if (parsed === null) problem = field.auto ? null : 'Vul een getal in.';
  else if (!Number.isFinite(parsed)) problem = 'Vul een getal in.';
  else if (parsed < field.min || parsed > field.max) problem = `Tussen ${fieldValueText(field.key, field.min)} en ${fieldValueText(field.key, field.max)}.`;
  else if (field.decimals === 0 && !Number.isInteger(parsed)) problem = 'Een heel getal.';

  function change(next: string) {
    setText(next);
    const n = parseDecimal(next);
    if (n === null) { if (field.auto) onChange(null); return; }
    if (!Number.isFinite(n) || n < field.min || n > field.max) return;
    if (field.decimals === 0 && !Number.isInteger(n)) return;
    const factor = Math.pow(10, field.decimals);
    onChange(Math.round(n * factor) / factor);
  }

  const hintId = `${id}-hint`;
  const unit = field.unit === 'pct' ? '%' : field.unit === 'months' ? 'mnd' : field.unit === 'days' ? 'dagen' : null;
  // De eenheid staat al naast het veld: "21" en niet "21% %".
  const placeholder = auto === null ? ''
    : field.unit === 'euro' ? auto.replace(/^€\s*/, '')
      : field.unit === 'pct' ? auto.replace(/%$/, '')
        : field.unit === 'days' ? auto.replace(/\s*dagen?$/, '') : auto;
  return <div className="fc-field" data-field={field.key}>
    <label htmlFor={id}>{field.label}</label>
    <div className={`fc-input${problem ? ' is-invalid' : ''}`}>
      {field.unit === 'euro' && <span className="fc-unit" aria-hidden="true">€</span>}
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={problem ? true : undefined}
        aria-describedby={hintId}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={event => change(event.target.value)}
      />
      {unit && <span className="fc-unit" aria-hidden="true">{unit}</span>}
    </div>
    <small id={hintId} className={`fc-hint${problem ? ' is-error' : ''}`}>
      {problem ?? (field.auto && value === null ? `Automatisch: ${auto}` : field.help)}
    </small>
    {field.auto && value !== null && !disabled && <button type="button" className="fc-link" onClick={() => { setText(''); onChange(null); }}>Terug naar automatisch</button>}
  </div>;
}

/** Bedrag per maand van een extra post, met eigen tekst zolang je typt. */
function AmountInput({ value, disabled, cashOnly, onChange }: { value: number; disabled: boolean; cashOnly: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(editText(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(editText(value)); }, [value, focused]);
  const parsed = parseDecimal(text);
  const invalid = parsed === null || !Number.isFinite(parsed) || parsed < 0 || parsed > 10000000;
  return <div className={`fc-input fc-item-amount${invalid ? ' is-invalid' : ''}`}>
    <span className="fc-unit" aria-hidden="true">€</span>
    <input
      type="text"
      inputMode="decimal"
      aria-label={cashOnly ? 'Bedrag per maand' : 'Bedrag per maand, exclusief btw'}
      aria-invalid={invalid ? true : undefined}
      value={text}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={event => {
        setText(event.target.value);
        const n = parseDecimal(event.target.value);
        if (n !== null && Number.isFinite(n) && n >= 0 && n <= 10000000) onChange(Math.round(n * 100) / 100);
      }}
    />
    <span className="fc-unit" aria-hidden="true">p/m</span>
  </div>;
}

function monthOptions(currentMonth: string, extra: Array<string | null>): string[] {
  const set = new Set<string>();
  for (let offset = -24; offset <= 36; offset += 1) set.add(addMonths(currentMonth, offset));
  for (const month of extra) if (month) set.add(month);
  return [...set].sort();
}

const KIND_OPTIONS: Array<{ value: ForecastItemKind; label: string }> = [
  { value: 'cost', label: 'Kosten' },
  { value: 'revenue', label: 'Omzet' },
  { value: 'cash_out', label: 'Geld eraf' },
  { value: 'cash_in', label: 'Geld erbij' },
];

function AssumptionsPanel({ result, flow, view, draft, onChange, canWrite, name, notes, onName, onNotes, showName, currentMonth }: {
  result: ForecastResult;
  flow: CashflowResult | null;
  view: ForecastView;
  draft: ForecastAssumptions;
  onChange: (patch: Partial<ForecastAssumptions>) => void;
  canWrite: boolean;
  name: string;
  notes: string;
  onName: (value: string) => void;
  onNotes: (value: string) => void;
  showName: boolean;
  currentMonth: string;
}) {
  const nameId = useId();
  const notesId = useId();
  const startId = useId();
  const [newMonth, setNewMonth] = useState(addMonths(currentMonth, 1));
  const [newCount, setNewCount] = useState('0');
  const options = monthOptions(currentMonth, [draft.start_month, ...draft.items.flatMap(item => [item.from, item.to]), ...Object.keys(draft.month_projects)]);
  const fields = FORECAST_FIELDS.filter(field => field.group === 'result' && field.key !== 'months');
  const cashFields = FORECAST_FIELDS.filter(field => field.group === 'cash');
  const monthsField = FORECAST_FIELDS.find(field => field.key === 'months') as ForecastFieldInfo;
  const seasonField = FORECAST_FIELDS.find(field => field.key === 'seasonality_pct') as ForecastFieldInfo;
  const season = result.season;
  const numberField = (field: ForecastFieldInfo) => <NumberField
    key={field.key}
    field={field}
    value={(draft as unknown as Record<string, number | null>)[field.key]}
    auto={autoText(field, result, flow)}
    disabled={!canWrite}
    onChange={value => {
      if (value === null && !field.auto) return;
      onChange({ [field.key]: value } as Partial<ForecastAssumptions>);
    }}
  />;

  function setItem(index: number, patch: Partial<ForecastItem>) {
    onChange({ items: draft.items.map((item, i) => (i === index ? { ...item, ...patch } : item)) });
  }

  function addItem() {
    const taken = new Set(draft.items.map(item => item.id));
    let n = 1;
    while (taken.has(`post-${n}`)) n += 1;
    onChange({ items: [...draft.items, { id: `post-${n}`, label: 'Nieuwe post', kind: 'cost', amount: 0, from: result.effective.start_month, to: null }] });
  }

  const newCountValue = parseDecimal(newCount);
  const newCountOk = newCountValue !== null && Number.isFinite(newCountValue) && newCountValue >= 0 && newCountValue <= 1000;

  function addMonth() {
    const count = parseDecimal(newCount);
    if (count === null || !Number.isFinite(count) || count < 0 || count > 1000) return;
    onChange({ month_projects: { ...draft.month_projects, [newMonth]: Math.round(count * 100) / 100 } });
  }

  const monthEntries = Object.entries(draft.month_projects).sort(([a], [b]) => a.localeCompare(b));
  const disabled = !canWrite;

  return <section className="fc-card fc-assumptions" aria-labelledby="fc-assumptions-title">
    <div className="fc-card-head"><h3 id="fc-assumptions-title">Aannames</h3>{!canWrite && <small className="fc-muted">alleen lezen</small>}</div>
    <p className="fc-muted fc-intro">Leeg is automatisch: dan komt het uit je cijfers en schuift het elke maand mee. Alles rekent meteen door; Bewaren legt het vast.</p>

    {showName && <div className="fc-field">
      <label htmlFor={nameId}>Naam</label>
      <input id={nameId} className="form-input" value={name} maxLength={80} disabled={disabled} onChange={event => onName(event.target.value)} />
    </div>}

    <div className="fc-fields">
      <div className="fc-field">
        <label htmlFor={startId}>Begin</label>
        <select id={startId} className="form-select" value={draft.start_month ?? ''} disabled={disabled} onChange={event => onChange({ start_month: event.target.value || null })}>
          <option value="">Deze maand (schuift mee)</option>
          {options.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select>
        <small className="fc-hint">Een vast begin houdt de prognose op zijn plek; dan zie je per maand ook wat er werkelijk gebeurde.</small>
      </div>
      <NumberField field={monthsField} value={draft.months} auto={null} disabled={disabled} onChange={value => { if (value !== null) onChange({ months: value }); }} />
      {fields.map(numberField)}
    </div>

    <div className="fc-sub fc-season-sub">
      <h4>Seizoen</h4>
      {season.available
        ? <p className="fc-muted">Geleerd uit je omzet van {monthLabel(season.from as string)} t/m {monthLabel(season.to as string)}. Op 100% volgen de nieuwe projecten en de overige omzet de drukke en rustige maanden; een maand met een eigen aantal projecten houdt dat aantal.</p>
        : <p className="fc-muted">{season.reason}</p>}
      {numberField(seasonField)}
      {season.available && <SeasonBars season={season} strength={draft.seasonality_pct} />}
    </div>

    {view === 'cash' && <div className="fc-sub fc-cash-sub">
      <h4>Geld</h4>
      <p className="fc-muted">Wat er op je rekening gebeurt. Leeg is automatisch, uit je bank, je facturen en je btw.</p>
      <div className="fc-fields">{cashFields.map(numberField)}</div>
    </div>}

    <div className="fc-sub">
      <h4>Extra posten</h4>
      <p className="fc-muted">Een nieuwe medewerker of een grote opdracht (omzet of kosten), of alleen geld: een lening, een investering, een privé-opname. Geld erbij of eraf telt niet in de winst, wel in de cashflow.</p>
      {draft.items.length === 0 && <p className="fc-muted fc-empty">Nog geen extra posten.</p>}
      {draft.items.map((item, index) => <div key={item.id} className="fc-item">
        <input className="form-input fc-item-label" aria-label="Naam van de post" value={item.label} maxLength={80} disabled={disabled}
          onChange={event => setItem(index, { label: event.target.value })}
          onBlur={() => { if (!item.label.trim()) setItem(index, { label: 'Post' }); }} />
        <select className="form-select fc-item-kind" aria-label="Soort" value={item.kind} disabled={disabled} onChange={event => {
          const kind = KIND_OPTIONS.find(option => option.value === event.target.value)?.value ?? 'cost';
          setItem(index, { kind });
        }}>
          {KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <AmountInput value={item.amount} disabled={disabled} cashOnly={isCashItem(item.kind)} onChange={amount => setItem(index, { amount })} />
        <select className="form-select" aria-label="Vanaf" value={item.from} disabled={disabled} onChange={event => setItem(index, { from: event.target.value, to: item.to !== null && item.to < event.target.value ? event.target.value : item.to })}>
          {options.map(month => <option key={month} value={month}>{monthLabel(month, 'short')}</option>)}
        </select>
        <select className="form-select" aria-label="Tot en met" value={item.to ?? ''} disabled={disabled} onChange={event => setItem(index, { to: event.target.value || null })}>
          <option value="">tot het eind</option>
          {options.filter(month => month >= item.from).map(month => <option key={month} value={month}>t/m {monthLabel(month, 'short')}</option>)}
        </select>
        {!disabled && <button type="button" className="fc-icon" aria-label={`Post ${item.label} weghalen`} onClick={() => onChange({ items: draft.items.filter((_, i) => i !== index) })}><Trash2 size={15} aria-hidden="true" /></button>}
      </div>)}
      {!disabled && draft.items.length < MAX_ITEMS && <Button onClick={addItem}><Plus size={14} aria-hidden="true" /> Post toevoegen</Button>}
    </div>

    <div className="fc-sub">
      <h4>Maanden met een eigen aantal projecten</h4>
      <p className="fc-muted">Vakantie, een rustige zomer of een drukke decembermaand.</p>
      {monthEntries.length === 0 && <p className="fc-muted fc-empty">Elke maand volgt de verwachting.</p>}
      {monthEntries.map(([month, count]) => <div key={month} className="fc-month">
        <span>{monthLabel(month)}</span>
        <b>{numberText(count, 2)} {count === 1 ? 'project' : 'projecten'}</b>
        {!disabled && <button type="button" className="fc-icon" aria-label={`${monthLabel(month)} weer volgens de verwachting`} onClick={() => {
          const next = { ...draft.month_projects };
          delete next[month];
          onChange({ month_projects: next });
        }}><Trash2 size={15} aria-hidden="true" /></button>}
      </div>)}
      {!disabled && monthEntries.length < MAX_MONTH_PROJECTS && <div className="fc-month-add">
        <select className="form-select" aria-label="Maand" value={newMonth} onChange={event => setNewMonth(event.target.value)}>
          {options.map(month => <option key={month} value={month}>{monthLabel(month)}</option>)}
        </select>
        <input className="form-input" type="text" inputMode="decimal" aria-label="Aantal nieuwe projecten" value={newCount} onChange={event => setNewCount(event.target.value)} />
        <Button onClick={addMonth} disabled={!newCountOk}><Plus size={14} aria-hidden="true" /> Zet</Button>
      </div>}
    </div>

    {showName && <div className="fc-field">
      <label htmlFor={notesId}>Toelichting</label>
      <textarea id={notesId} className="form-textarea" rows={3} value={notes} maxLength={2000} disabled={disabled} onChange={event => onNotes(event.target.value)} placeholder="Waarom deze verwachting? Voor wie hem later leest." />
    </div>}
  </section>;
}

// ── Waar het op rust ────────────────────────────────────────────────────────

const METHOD_TEXT: Record<'statement' | 'ledger', string> = {
  statement: 'afschrift en de regels daarna',
  ledger: 'boekhouding en de nog niet geboekte regels',
};

/** Waar de cashflow begint: het saldo per rekening, de openstaande posten, het betaalgedrag en de btw. */
function CashBasis({ flow }: { flow: CashflowResult }) {
  const e = flow.effective;
  const collection = e.collection_source === 'set' ? 'zelf ingevuld'
    : e.collection_source === 'history' ? 'zo snel betaalden je klanten het afgelopen jaar gemiddeld, naar bedrag gewogen'
      : 'je betaaltermijn uit de bedrijfsgegevens (er zijn nog te weinig betaalde facturen om het betaalgedrag te gebruiken)';
  return <div className="fc-pipeline fc-cash-basis">
    <h4>Cashflow</h4>
    <p>Banksaldo {e.start_auto ? 'uit ResoFly' : <b>zelf ingevuld: {money(e.start_cents)}</b>}{e.start_auto && !e.start_known ? ': nog niet bekend' : ''}:</p>
    {(flow.bank.length > 0 || flow.cash_accounts_cents !== 0) && <ul className="fc-facts">
      {flow.bank.map(account => <li key={account.name}>
        {account.name}: {account.balance_cents === null
          ? <span className="fc-muted">onbekend (geen afschrift met eindsaldo en geen beginbalans)</span>
          : <><b>{money(account.balance_cents)}</b> <span className="fc-muted">volgens je {METHOD_TEXT[account.method ?? 'ledger']}{account.as_of ? `, t/m ${Number(account.as_of.slice(8, 10))} ${monthShortName(account.as_of.slice(0, 7))} ${account.as_of.slice(0, 4)}` : ''}</span></>}
      </li>)}
      {flow.cash_accounts_cents !== 0 && <li>Kas: <b>{money(flow.cash_accounts_cents)}</b></li>}
    </ul>}
    <p>Openstaande facturen <b>{money(flow.open.receivables_cents + flow.open.receivables_later_cents)}</b>{flow.open.receivables_overdue_cents > 0 ? `, waarvan ${money(flow.open.receivables_overdue_cents)} te laat` : ''}; openstaande inkoopfacturen <b>{money(flow.open.payables_cents + flow.open.payables_later_cents)}</b>. Ze tellen in de maand waarin ze vervallen.</p>
    <p>Klanten betalen na <b>{fieldValueText('collection_days', e.collection_days)}</b>: {collection}.</p>
    <p>{e.kor
      ? 'Je hebt de KOR: geen btw op je facturen en geen aftrek.'
      : <>Btw {e.vat_frequency === 'monthly' ? 'per maand' : 'per kwartaal'}, betaald in de maand erna: <b>{pctText(e.vat_sales_pct)}</b> op je omzet, <b>{pctText(e.vat_costs_pct)}</b> op je kosten.</>}</p>
    {flow.vat_payments.length > 0 && <ul className="fc-facts">
      {flow.vat_payments.map(payment => <li key={payment.period}>{payment.period}: <b>{money(payment.cents)}</b> in {monthLabel(payment.month)} <span className="fc-muted">({payment.source === 'return' ? 'uit je aangifte' : 'uitgerekend'})</span></li>)}
    </ul>}
    {e.noncash_cents > 0 && <p className="fc-muted">Afschrijvingen ({money(e.noncash_cents)} per maand) staan in je kosten, maar gaan niet van je rekening af; de cashflow laat ze weg.</p>}
  </div>;
}

function BasisPanel({ result, flow, view, inputs, draft, canWrite, onAddItem }: {
  result: ForecastResult;
  flow: CashflowResult | null;
  view: ForecastView;
  inputs: ForecastInputs;
  draft: ForecastAssumptions;
  canWrite: boolean;
  onAddItem: (item: ForecastItem) => void;
}) {
  const base = result.baseline;
  const pipeline = inputs.pipeline;
  const decided = pipeline.won_count + pipeline.lost_count;
  const alreadyAdded = draft.items.some(item => item.label === 'Geaccepteerde offertes');
  return <section className="fc-card fc-basis" aria-labelledby="fc-basis-title">
    <div className="fc-card-head"><h3 id="fc-basis-title">Waar dit op rust</h3></div>
    {view === 'cash' && flow?.available && <><CashBasis flow={flow} /><h4 className="fc-basis-h">Resultaat</h4></>}
    {base.months === 0 || !base.from || !base.to
      ? <p>Er zijn nog geen cijfers uit de afgelopen twaalf maanden. Vul je verwachting zelf in, of vraag Gerrie om mee te denken.</p>
      : <>
        <p>Automatisch is het gemiddelde van <b>{monthLabel(base.from)} t/m {monthLabel(base.to)}</b> ({base.months} {base.months === 1 ? 'maand' : 'maanden'}{base.months < 12 ? ', je bedrijf is jonger dan een jaar' : ''}):</p>
        <ul className="fc-facts">
          {base.projects_visible && <li><b>{numberText(base.projects_per_month, 2)}</b> nieuwe projecten per maand</li>}
          {base.projects_visible && <li><b>{money(base.revenue_per_project_cents)}</b> omzet per project</li>}
          <li><b>{money(base.other_revenue_cents)}</b> overige omzet per maand</li>
          <li><b>{money(base.fixed_costs_cents)}</b> kosten per maand, {COST_SOURCE_TEXT[base.cost_source]}</li>
        </ul>
      </>}
    {!base.projects_visible && <p className="fc-muted">Projecten zie je niet: je hebt geen leesrecht op Projecten. Alle omzet telt hier als overige omzet.</p>}
    <p className="fc-muted">Omzet is wat je factureerde, exclusief btw en op factuurdatum. Kosten zijn per maand het hoogste van wat er in je boekhouding als kosten staat en je inkoopfacturen.</p>
    {(pipeline.open_count > 0 || pipeline.accepted_count > 0) && <div className="fc-pipeline">
      <h4>Offertes</h4>
      {pipeline.open_count > 0 && <p>{pipeline.open_count} verstuurd en nog geldig, samen <b>{money(pipeline.open_cents)}</b>.</p>}
      {pipeline.accepted_count > 0 && <p>{pipeline.accepted_count} geaccepteerd en nog niet gefactureerd, samen <b>{money(pipeline.accepted_cents)}</b>.</p>}
      {decided >= 3 && <p className="fc-muted">Het afgelopen jaar werd {Math.round((pipeline.won_count / decided) * 100)}% van je besliste offertes een opdracht.</p>}
      <p className="fc-muted">Offertes tellen niet vanzelf mee: ze zitten al in het gemiddelde. Verwacht je meer dan gewoonlijk, zet ze dan als extra post erbij.</p>
      {canWrite && pipeline.accepted_cents > 0 && !alreadyAdded && <Button onClick={() => {
        const taken = new Set(draft.items.map(item => item.id));
        let n = 1;
        while (taken.has(`post-${n}`)) n += 1;
        const current = monthOfDate(inputs.today);
        const month = result.effective.start_month < current ? current : result.effective.start_month;
        onAddItem({ id: `post-${n}`, label: 'Geaccepteerde offertes', kind: 'revenue', amount: Math.round(pipeline.accepted_cents) / 100, from: month, to: month });
      }}><Plus size={14} aria-hidden="true" /> Geaccepteerde offertes als extra post</Button>}
    </div>}
  </section>;
}

// ── Vensters ────────────────────────────────────────────────────────────────

function NewForecastDialog({ names, current, onClose, onCreate }: {
  names: string[];
  /** De prognose die nu openstaat, om te kopiëren; null als er nog geen is. */
  current: string | null;
  onClose: () => void;
  onCreate: (name: string, copy: boolean) => Promise<void>;
}) {
  const nameId = useId();
  const [name, setName] = useState(current ? `${current} (kopie)` : 'Basis');
  const [copy, setCopy] = useState(Boolean(current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = name.replace(/\s+/g, ' ').trim();
  const taken = names.some(existing => existing.toLowerCase() === clean.toLowerCase());

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!clean || taken || busy) return;
    setBusy(true); setError(null);
    try { await onCreate(clean, copy); }
    catch (e) { setError(errorText(e, 'Aanmaken lukte niet.')); setBusy(false); }
  }

  return <Modal title="Nieuwe prognose" onClose={onClose} footer={<>
    <Button onClick={onClose}>Annuleren</Button>
    <Button variant="primary" disabled={!clean || taken || busy} onClick={() => void submit()}>{busy ? 'Aanmaken…' : 'Aanmaken'}</Button>
  </>}>
    <form className="fc-dialog" onSubmit={submit}>
      <div className="fc-field">
        <label htmlFor={nameId}>Naam</label>
        <input id={nameId} className="form-input" value={name} maxLength={80} autoFocus onChange={event => setName(event.target.value)} />
        {taken && <small className="fc-hint is-error">Er is al een prognose met deze naam.</small>}
      </div>
      <fieldset className="fc-choice">
        <legend>Begin met</legend>
        <label><input type="radio" name="fc-start" checked={!copy} onChange={() => setCopy(false)} /> Automatisch, uit je cijfers van het afgelopen jaar</label>
        {current && <label><input type="radio" name="fc-start" checked={copy} onChange={() => setCopy(true)} /> Een kopie van "{current}", zoals hij nu op je scherm staat</label>}
      </fieldset>
      {error && <p className="error">{error}</p>}
    </form>
  </Modal>;
}

function HistoryDialog({ organizationId, forecast, canWrite, teamMembers, currentUserId, onClose, onRestore }: {
  organizationId: UUID;
  forecast: Forecast;
  canWrite: boolean;
  teamMembers: OrganizationMember[];
  currentUserId: UUID | null;
  onClose: () => void;
  onRestore: (version: ForecastVersion) => Promise<void>;
}) {
  const [versions, setVersions] = useState<ForecastVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    selectForecastVersions(organizationId, forecast.id)
      .then(rows => { if (!cancelled) setVersions(rows); })
      .catch(e => { if (!cancelled) setError(errorText(e, 'De geschiedenis kon niet worden geladen.')); });
    return () => { cancelled = true; };
  }, [organizationId, forecast.id, forecast.version]);

  return <Modal title={`Geschiedenis van ${forecast.name}`} onClose={onClose} className="fc-history-modal">
    {error && <p className="error">{error}</p>}
    {!versions && !error && <Skeleton lines={4} />}
    {versions && <ol className="fc-versions">
      {versions.map(version => <li key={version.id}>
        <div className="fc-version-head">
          <b>Versie {version.version}</b>
          <span className="fc-muted">{dateTimeNL(version.created_at)}{version.created_by ? ` · ${version.created_by === currentUserId ? 'jij' : memberShortName(version.created_by, teamMembers, currentUserId)}` : ''}</span>
        </div>
        <p>{version.change_note ?? (version.version === 1 ? 'Aangemaakt' : 'Gewijzigd')}</p>
        {version.version === forecast.version
          ? <small className="fc-muted">Dit is de huidige versie.</small>
          : canWrite && <Button disabled={busy !== null} onClick={async () => {
              setBusy(version.version); setError(null);
              try { await onRestore(version); }
              catch (e) { setError(errorText(e, 'Terugzetten lukte niet.')); setBusy(null); }
            }}><RotateCcw size={14} aria-hidden="true" /> {busy === version.version ? 'Terugzetten…' : 'Terugzetten'}</Button>}
      </li>)}
    </ol>}
  </Modal>;
}
