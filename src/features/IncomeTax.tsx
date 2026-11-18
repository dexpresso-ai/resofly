import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Info, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { AppData } from '../types';
import { Button, Input, Select, Skeleton } from '../components/Ui';
import { PageIcon } from '../components/PageIcon';
import { dateNL, euro } from '../lib/format';
import { formatISODate } from '../lib/dates';
import { parseDutchAmountCents } from '../lib/money';
import { downloadCsv } from '../lib/csv';
import {
  IB_CORRECTION_LABELS, IB_DISCLAIMER, IB_FIRST_YEAR, IB_RULES, buildIncomeTaxOverview, formatRate,
  type AowStatus, type IbCorrectionCode, type IbYearRules, type IncomeTaxBasis, type IncomeTaxInputs,
  type IncomeTaxOverview, type IncomeTaxPerson, type IncomeTaxProfile,
} from '../lib/inkomstenbelasting';
import {
  addIncomeTaxCorrection, deleteIncomeTaxCorrection, loadIncomeTaxInputs, saveIncomeTaxProfile, setIncomeTaxKiaExclusion,
} from '../lib/repository';

/** `|| 0` ook voor −0: een aftrek van nul stond er anders als "€ -0,00". */
const euroCents = (cents: number | null | undefined) => euro((cents || 0) / 100);
const shareText = (bp: number | null) => (bp === null ? '' : `${(bp / 100).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}%`);
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/** Bedragen in het formulier zoals je ze typt: "1.500" is vijftienhonderd (parseDutchAmount). */
function centsToText(cents: number): string {
  return cents ? (cents / 100).toFixed(2).replace('.', ',') : '';
}
function textToCents(text: string): number | null {
  if (!text.trim()) return 0;
  const cents = parseDutchAmountCents(text);
  return cents === null || cents < 0 ? null : cents;
}

function sameProfile(a: IncomeTaxProfile, b: IncomeTaxProfile): boolean {
  return a.meetsHoursCriterion === b.meetsHoursCriterion && a.starter === b.starter && a.aowStatus === b.aowStatus
    && (a.aowStatus !== 'in_jaar' || a.aowMonth === b.aowMonth)
    && a.lossCarryForwardCents === b.lossCarryForwardCents
    && a.otherEntrepreneurDeductionCents === b.otherEntrepreneurDeductionCents
    && a.provisionalIncomeTaxCents === b.provisionalIncomeTaxCents
    && a.provisionalZvwCents === b.provisionalZvwCents;
}

/** Correcties met een vaste richting: je typt het bedrag, de soort bepaalt het teken. */
const SIGN_BY_CODE: Partial<Record<IbCorrectionCode, 1 | -1>> = {
  gemengde_kosten: 1, privegebruik_auto: 1, niet_aftrekbaar: 1, desinvesteringsbijtelling: 1, investeringsaftrek: -1,
};

/**
 * Inkomstenbelasting van de ondernemer of de vennoten: een raming per persoon.
 *
 * Bij een eenmanszaak, vof, maatschap of cv betalen de ondernemer of de
 * vennoten zelf inkomstenbelasting over de winst. Dit scherm rekent per persoon
 * uit wat dat ongeveer is: winst(aandeel), fiscale correcties, KIA,
 * ondernemersaftrek, mkb-winstvrijstelling, box 1, heffingskortingen en de
 * Zvw-bijdrage, min wat er al aan voorlopige aanslagen is betaald.
 *
 * Het rekenwerk staat in src/lib/inkomstenbelasting.ts (met tests); Gerrie
 * gebruikt dezelfde code. Wat niet in de boekhouding staat (urencriterium,
 * starter, AOW-leeftijd, voorlopige aanslagen) vul je hier in, per persoon per
 * kalenderjaar. Wijzig je iets, dan rekent de raming meteen mee; opslaan legt
 * het vast.
 *
 * Alleen het zakelijke inkomen telt mee: de disclaimer staat bovenaan en gaat
 * mee in de specificatie.
 */
export function IncomeTaxPage({ data, organizationId, canWrite }: {
  data: AppData; organizationId: string; canWrite: boolean;
}) {
  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  const isIb = ['eenmanszaak', 'vof', 'maatschap', 'cv'].includes(legalForm);
  const isPartnershipForm = ['vof', 'maatschap', 'cv'].includes(legalForm);

  const currentYear = new Date().getFullYear();
  const years = useMemo(() => {
    const out: number[] = [];
    for (let y = Math.max(currentYear, IB_FIRST_YEAR); y >= IB_FIRST_YEAR; y -= 1) out.push(y);
    return out;
  }, [currentYear]);

  const [year, setYear] = useState(Math.max(currentYear, IB_FIRST_YEAR));
  const [inputs, setInputs] = useState<IncomeTaxInputs | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [basis, setBasis] = useState<IncomeTaxBasis>('geboekt');
  const [drafts, setDrafts] = useState<Record<string, IncomeTaxProfile>>({});
  const [formVersion, setFormVersion] = useState(0);

  // Wie snel van jaar wisselt, mag geen antwoord van het vorige jaar krijgen.
  const requestedYear = useRef(year);
  const load = useCallback(async (y: number) => {
    requestedYear.current = y;
    setLoading(true);
    setError(null);
    try {
      const result = await loadIncomeTaxInputs(organizationId, y);
      if (requestedYear.current === y) setInputs(result);
    } catch (e) {
      if (requestedYear.current === y) {
        setInputs(null);
        setError(e instanceof Error ? e.message : 'Gegevens laden mislukt');
      }
    } finally {
      if (requestedYear.current === y) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    if (!isIb) return;
    // Eerst leeg: de kaarten van het nieuwe jaar beginnen pas met de gegevens
    // van dat jaar, niet met de velden van het vorige.
    setInputs(null);
    setDrafts({});
    setMessage(null);
    void load(year);
  }, [isIb, year, load]);

  const today = formatISODate(new Date());
  // De raming rekent meteen mee met wat je invult, ook vóór het opslaan.
  const overview = useMemo<IncomeTaxOverview | null>(() => {
    if (!inputs) return null;
    const keyOf = (partnerId: string | null) => partnerId ?? 'ondernemer';
    const saved = inputs.profiles.filter(p => !drafts[keyOf(p.partnerId)]);
    const merged = { ...inputs, profiles: [...saved, ...Object.values(drafts)] };
    return buildIncomeTaxOverview(merged, { basis, today });
  }, [inputs, drafts, basis, today]);

  if (!isIb) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">Inkomstenbelasting</div>
      <div>De raming van de inkomstenbelasting hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.
        Een BV of NV betaalt vennootschapsbelasting; die staat bij Vennootschapsbelasting.</div>
    </div></div>;
  }

  /** Opslaan, opnieuw laden, en pas dán `after`: zo tonen de velden nooit de oude waarden. */
  async function run(action: () => Promise<void>, ok: string, after?: () => void): Promise<boolean> {
    setBusy(true); setError(null); setMessage(null);
    try {
      await action();
      await load(year);
      after?.();
      setMessage(ok);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const dropDraft = (key: string) => {
    setDrafts(prev => { const next = { ...prev }; delete next[key]; return next; });
    setFormVersion(v => v + 1);
  };

  const saveProfile = (person: IncomeTaxPerson) => {
    const draft = drafts[person.key];
    if (!draft) return;
    void run(() => saveIncomeTaxProfile(organizationId, year, draft), `Gegevens van ${person.name} opgeslagen voor ${year}.`, () => dropDraft(person.key));
  };

  const rules: IbYearRules | null = overview ? IB_RULES[overview.rulesYear] ?? null : null;

  const exportCsv = () => {
    if (!overview || !rules) return;
    downloadCsv(`inkomstenbelasting-${overview.year}.csv`, ['Persoon', 'Post', 'Toelichting', 'Bedrag'], specificationRows(overview, rules));
  };

  const dirtyKeys = overview ? overview.persons.filter(p => drafts[p.key] && !sameProfile(drafts[p.key], savedProfile(inputs, p))).map(p => p.key) : [];
  const fiscalYearClosed = (inputs?.overlappingFiscalYears.length ?? 0) > 0 && inputs!.overlappingFiscalYears.every(fy => fy.status === 'closed');
  const multiple = (overview?.persons.length ?? 0) > 1;

  return (
    <div className="bk-page ib-page">
      <div className="bk-head">
        <div><PageIcon page="income-tax" />
          <h2>Inkomstenbelasting</h2>
          <p>{isPartnershipForm
            ? 'Een raming per vennoot van de inkomstenbelasting en de Zvw-bijdrage over zijn winstaandeel, met de ondernemersaftrek, de mkb-winstvrijstelling, de KIA en de heffingskortingen.'
            : 'Een raming van de inkomstenbelasting en de Zvw-bijdrage over je winst, met de ondernemersaftrek, de mkb-winstvrijstelling, de KIA en de heffingskortingen.'}</p>
        </div>
        <div className="bk-head-actions">
          <Select value={String(year)} onChange={e => setYear(Number(e.target.value))} aria-label="Kalenderjaar">
            {years.map(y => <option key={y} value={String(y)}>{y}</option>)}
          </Select>
          {overview?.projection && (
            <div className="bk-seg" role="group" aria-label="Rekenen met">
              <button type="button" className={overview.basis === 'geboekt' ? 'is-active' : ''} onClick={() => setBasis('geboekt')}>Tot nu toe</button>
              <button type="button" className={overview.basis === 'prognose' ? 'is-active' : ''} onClick={() => setBasis('prognose')}>Prognose heel jaar</button>
            </div>
          )}
          {overview && <Button onClick={exportCsv}><Download size={14} /> Specificatie</Button>}
        </div>
      </div>

      <div className="ib-disclaimer" role="note">
        <Info size={16} aria-hidden="true" />
        <p><strong>Alleen zakelijk inkomen.</strong> {IB_DISCLAIMER}</p>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <p className="bk-note">{message}</p>}

      {loading && !inputs ? <div className="bk-report-loading"><Skeleton lines={6} /></div> : !inputs ? null : !overview || !rules ? (
        <p className="bk-muted">Voor {year} rekent ResoFly de inkomstenbelasting niet uit: de tarieven staan erin vanaf {IB_FIRST_YEAR}.</p>
      ) : (
        <>
          {overview.warnings.map(w => <p key={w} className="bk-note ib-warning"><AlertTriangle size={13} aria-hidden="true" /> {w}</p>)}

          <div className="bk-report">
            <div className="bk-report-bar">
              <div className="bk-report-kpis">
                <div>
                  <span>{overview.basis === 'prognose' ? `Winst ${year} (prognose)` : overview.usedResultCents < 0 ? `Verlies ${year}` : `Winst ${year}`}</span>
                  <strong className={overview.usedResultCents < 0 ? 'bk-neg' : ''}>{euroCents(Math.abs(overview.usedResultCents))}</strong>
                </div>
                <div><span>Inkomstenbelasting + Zvw</span><strong>{euroCents(overview.totals.totalCents)}</strong></div>
                {overview.totals.provisionalCents > 0 && <div><span>Al betaald (voorlopig)</span><strong>{euroCents(overview.totals.provisionalCents)}</strong></div>}
                <div>
                  <span>{overview.totals.balanceCents >= 0 ? 'Nog te betalen' : 'Terug te krijgen'}</span>
                  <strong className={overview.totals.balanceCents > 0 ? 'bk-neg' : overview.totals.balanceCents < 0 ? 'bk-pos' : ''}>{euroCents(Math.abs(overview.totals.balanceCents))}</strong>
                </div>
              </div>
              <span className={`status-pill ${fiscalYearClosed ? 'bk-je-posted' : 'bk-status-draft'}`}>{fiscalYearClosed ? 'Boekjaar afgesloten' : 'Voorlopig'}</span>
            </div>
            {overview.basis === 'prognose' && overview.projection && (
              <p className="bk-muted">
                Prognose: de winst tot en met vandaag ({euroCents(overview.resultCents)} over {overview.projection.elapsedDays} dagen
                {overview.projection.fromDate !== `${year}-01-01` ? ` vanaf ${dateNL(overview.projection.fromDate)}` : ''}) in hetzelfde tempo doorgetrokken naar 31 december.
                Grote posten die nog komen of al geweest zijn, verschuiven die uitkomst.
              </p>
            )}
            {overview.basis === 'geboekt' && year === currentYear && (
              <p className="bk-muted">Het jaar loopt nog: dit is de raming over de winst die nu geboekt is.{overview.projection ? ' Kies Prognose heel jaar om de winst door te trekken naar 31 december.' : ''}</p>
            )}
            {!isPartnershipForm && overview.ownerMinutes !== null && (
              <p className="bk-muted">De eigenaar heeft in {year} {Math.floor(overview.ownerMinutes / 60).toLocaleString('nl-NL')} uur geregistreerd bij Uren; het urencriterium vraagt er 1.225.</p>
            )}
            {!isPartnershipForm && overview.ownerMinutes === null && inputs.myMinutes !== null && (
              <p className="bk-muted">Jij hebt in {year} {Math.floor(inputs.myMinutes / 60).toLocaleString('nl-NL')} uur geregistreerd; het urencriterium vraagt er 1.225.</p>
            )}
            {isPartnershipForm && inputs.myMinutes !== null && (
              <p className="bk-muted">Jij hebt in {year} {Math.floor(inputs.myMinutes / 60).toLocaleString('nl-NL')} uur geregistreerd. Het urencriterium (1.225 uur) geldt per vennoot.</p>
            )}
          </div>

          {overview.persons.map(person => (
            <PersonCard
              key={`${year}:${person.key}:${formVersion}`}
              person={person}
              rules={rules}
              year={year}
              multiple={multiple}
              partnershipForm={isPartnershipForm}
              isPrognose={overview.basis === 'prognose'}
              canWrite={canWrite}
              busy={busy}
              dirty={dirtyKeys.includes(person.key)}
              investmentTotalCents={overview.investmentTotalCents}
              kiaCents={overview.kiaCents}
              onChange={profile => setDrafts(prev => ({ ...prev, [person.key]: profile }))}
              onSave={() => saveProfile(person)}
              onReset={() => dropDraft(person.key)}
            />
          ))}

          <KiaSection overview={overview} rules={rules} canWrite={canWrite} busy={busy} multiple={multiple}
            onToggle={(assetId, excluded) => void run(() => setIncomeTaxKiaExclusion(organizationId, assetId, excluded),
              excluded ? 'Het activum telt niet meer mee voor de KIA.' : 'Het activum telt weer mee voor de KIA.')} />

          <CorrectionsSection overview={overview} year={year} canWrite={canWrite} busy={busy} isPartnershipForm={isPartnershipForm}
            onAdd={input => run(() => addIncomeTaxCorrection(organizationId, input), 'Correctie toegevoegd.')}
            onDelete={id => void run(() => deleteIncomeTaxCorrection(organizationId, id), 'Correctie verwijderd.')} />

          <p className="bk-muted ib-rules">
            Tarieven {rules.year}{!overview.rulesExact ? ` (gebruikt voor ${year})` : ''}: {rules.brackets.map((b, i) => {
              const from = i === 0 ? null : rules.brackets[i - 1].upToCents;
              return b.upToCents !== null
                ? `${from === null ? 'tot' : `${euroCents(from)} tot`} ${euroCents(b.upToCents)} ${formatRate(b.rate)}`
                : `daarboven ${formatRate(b.rate)}`;
            }).join(' · ')} (inclusief premie volksverzekeringen; met de AOW-leeftijd {formatRate(rules.aowFirstBracketRate)} in de eerste schijf).
            Zelfstandigenaftrek {euroCents(rules.zelfstandigenaftrekCents)}, startersaftrek {euroCents(rules.startersaftrekCents)},
            mkb-winstvrijstelling {formatRate(rules.mkbExemptionRate)}, aftrekbeperking tot {formatRate(rules.deductionCapRate)},
            Zvw-bijdrage {formatRate(rules.zvwRate)} tot {euroCents(rules.zvwMaxBaseCents)}.
            Bronnen: Belastingdienst en de Wet IB 2001. Een raming, geen aangifte: die doe je zelf of via je boekhouder.
          </p>
        </>
      )}
    </div>
  );
}

/** Het opgeslagen profiel van een persoon (zonder wat je net hebt gewijzigd). */
function savedProfile(inputs: IncomeTaxInputs | null, person: IncomeTaxPerson): IncomeTaxProfile {
  const saved = inputs?.profiles.find(p => p.partnerId === person.partnerId);
  return saved ?? {
    partnerId: person.partnerId, meetsHoursCriterion: null, starter: false, aowStatus: 'nee', aowMonth: null,
    lossCarryForwardCents: 0, otherEntrepreneurDeductionCents: 0, provisionalIncomeTaxCents: 0, provisionalZvwCents: 0, updatedAt: null,
  };
}

// ── Eén persoon ─────────────────────────────────────────────────────────────

type MoneyField = 'lossCarryForwardCents' | 'otherEntrepreneurDeductionCents' | 'provisionalIncomeTaxCents' | 'provisionalZvwCents';

function PersonCard({ person, rules, year, multiple, partnershipForm, isPrognose, canWrite, busy, dirty, investmentTotalCents, kiaCents, onChange, onSave, onReset }: {
  person: IncomeTaxPerson; rules: IbYearRules; year: number; multiple: boolean; partnershipForm: boolean; isPrognose: boolean;
  canWrite: boolean; busy: boolean; dirty: boolean; investmentTotalCents: number; kiaCents: number;
  onChange: (profile: IncomeTaxProfile) => void; onSave: () => void; onReset: () => void;
}) {
  const { profile, estimate: e } = person;
  const isCommanditair = person.kind === 'commanditair';
  const [texts, setTexts] = useState<Record<MoneyField, string>>(() => ({
    lossCarryForwardCents: centsToText(profile.lossCarryForwardCents),
    otherEntrepreneurDeductionCents: centsToText(profile.otherEntrepreneurDeductionCents),
    provisionalIncomeTaxCents: centsToText(profile.provisionalIncomeTaxCents),
    provisionalZvwCents: centsToText(profile.provisionalZvwCents),
  }));
  const invalid = (Object.keys(texts) as MoneyField[]).filter(k => textToCents(texts[k]) === null);

  const change = (patch: Partial<IncomeTaxProfile>) => onChange({ ...profile, ...patch });
  const changeMoney = (field: MoneyField, value: string) => {
    setTexts(prev => ({ ...prev, [field]: value }));
    const cents = textToCents(value);
    if (cents !== null) change({ [field]: cents } as Partial<IncomeTaxProfile>);
  };
  const setAow = (value: AowStatus) => change({ aowStatus: value, aowMonth: value === 'in_jaar' ? (profile.aowMonth ?? 1) : null });

  const row = (label: string, amount: number, cls = '', hint?: string) => (
    <tr className={cls} key={label}>
      <td>{label}{hint && <span className="bk-muted"> · {hint}</span>}</td>
      <td className="bk-num">{euroCents(amount)}</td>
    </tr>
  );

  const zaHint = isCommanditair ? 'geen ondernemer'
    : profile.meetsHoursCriterion === null ? 'urencriterium nog niet ingevuld'
    : !profile.meetsHoursCriterion ? 'urencriterium niet gehaald'
    : profile.aowStatus === 'heel_jaar' ? 'de helft, AOW-leeftijd'
    : e.zelfstandigenaftrekUnusedCents > 0 ? 'tot de winst' : undefined;

  const field = (key: MoneyField, label: string, hint: string) => (
    <label className="bk-setting-field">
      <span>{label}</span>
      <Input inputMode="decimal" value={texts[key]} placeholder="0,00" disabled={!canWrite || busy}
        aria-invalid={textToCents(texts[key]) === null} onChange={ev => changeMoney(key, ev.target.value)} />
      <small className="bk-muted">{textToCents(texts[key]) === null ? 'Geen geldig bedrag.' : hint}</small>
    </label>
  );

  return (
    <section className="bk-report ib-person" aria-label={`Raming ${person.name}`}>
      <div className="bk-report-bar">
        <div className="ib-person-head">
          <h3>{person.name}</h3>
          <span className="bk-muted">
            {person.kind === 'ondernemer' ? (partnershipForm ? 'Hele winst, nog zonder vennoten' : 'Eenmanszaak')
              : person.kind === 'commanditair' ? 'Commanditaire vennoot' : 'Vennoot'}
            {person.shareBasisPoints !== null && ` · winstaandeel ${shareText(person.shareBasisPoints)}`}
          </span>
        </div>
        {multiple && (
          <div className="bk-report-kpis">
            <div><span>IB + Zvw</span><strong>{euroCents(e.totalCents)}</strong></div>
            <div>
              <span>{e.balanceCents >= 0 ? 'Nog te betalen' : 'Terug'}</span>
              <strong className={e.balanceCents > 0 ? 'bk-neg' : e.balanceCents < 0 ? 'bk-pos' : ''}>{euroCents(Math.abs(e.balanceCents))}</strong>
            </div>
          </div>
        )}
      </div>

      <div className="ib-person-grid">
        <div className="ib-person-form">
          {!isCommanditair && (
            <>
              <label className="bk-setting-field">
                <span>Urencriterium {year}</span>
                <Select value={profile.meetsHoursCriterion === null ? '' : profile.meetsHoursCriterion ? 'ja' : 'nee'} disabled={!canWrite || busy}
                  onChange={ev => change({ meetsHoursCriterion: ev.target.value === '' ? null : ev.target.value === 'ja' })}>
                  <option value="">Nog niet ingevuld</option>
                  <option value="ja">Ja, 1.225 uur of meer</option>
                  <option value="nee">Nee, minder dan 1.225 uur</option>
                </Select>
                <small className="bk-muted">{person.hoursFromTimeTracking
                  ? 'Ingevuld volgens de uren van de eigenaar bij Uren. Kies zelf als dat niet klopt, en sla op.'
                  : 'Alle uren aan de onderneming, ook indirecte. Meer dan de helft van je werktijd, behalve als starter.'}</small>
              </label>
              <label className="bk-setting-check">
                <input type="checkbox" checked={profile.starter} disabled={!canWrite || busy} onChange={ev => change({ starter: ev.target.checked })} />
                <span>Starter: recht op startersaftrek<small className="bk-muted"> In 1 of meer van de 5 jaar ervoor geen ondernemer, en daarin hooguit 2 keer zelfstandigenaftrek.</small></span>
              </label>
            </>
          )}
          <label className="bk-setting-field">
            <span>AOW-leeftijd</span>
            <Select value={profile.aowStatus} disabled={!canWrite || busy} onChange={ev => setAow(ev.target.value as AowStatus)}>
              <option value="nee">Nog niet bereikt</option>
              <option value="heel_jaar">Al vóór 1 januari {year}</option>
              <option value="in_jaar">In de loop van {year}</option>
            </Select>
          </label>
          {profile.aowStatus === 'in_jaar' && (
            <label className="bk-setting-field">
              <span>Maand waarin de AOW-leeftijd bereikt wordt</span>
              <Select value={String(profile.aowMonth ?? 1)} disabled={!canWrite || busy} onChange={ev => change({ aowMonth: Number(ev.target.value) })}>
                {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </Select>
            </label>
          )}
          {field('lossCarryForwardCents', 'Verlies uit eerdere jaren', 'Nog te verrekenen verlies uit werk en woning, volgens je aanslag of verliesbeschikking.')}
          {!isCommanditair && field('otherEntrepreneurDeductionCents', 'Overige ondernemersaftrek', 'S&O-, meewerk- of stakingsaftrek, als je die hebt.')}
          {field('provisionalIncomeTaxCents', `Voorlopige aanslag IB ${year}`, 'Wat je al betaalt of betaald hebt.')}
          {field('provisionalZvwCents', `Voorlopige aanslag Zvw ${year}`, 'De bijdrage Zorgverzekeringswet, een aparte aanslag.')}
          {canWrite && (
            <div className="bk-fy-new-actions">
              <Button variant="primary" disabled={busy || !dirty || invalid.length > 0} onClick={onSave}><Save size={14} /> Opslaan</Button>
              {dirty && <Button variant="ghost" disabled={busy} onClick={onReset}><RotateCcw size={14} /> Terugzetten</Button>}
            </div>
          )}
          <p className="bk-muted ib-saved">
            {dirty ? 'Nog niet opgeslagen: de raming rekent al met wat je hebt ingevuld.'
              : person.profileSaved && profile.updatedAt ? `Opgeslagen op ${dateNL(profile.updatedAt.slice(0, 10))}.`
              : 'Nog niets opgeslagen voor dit jaar.'}
          </p>
        </div>

        <div className="bk-table-wrap ib-calc">
          <table className="bk-table bk-report-table">
            <thead><tr><th>Berekening {year}</th><th className="bk-num">Bedrag</th></tr></thead>
            <tbody>
              {row(person.shareBasisPoints !== null ? `Winstaandeel (${shareText(person.shareBasisPoints)})` : 'Winst uit de boekhouding', e.profitShareCents, '',
                isPrognose ? 'prognose heel jaar' : undefined)}
              {person.corrections.map(c => (
                <tr key={c.id} className="bk-balance-sub">
                  <td>{c.label}<span className="bk-muted"> · {c.automatic ? 'uit rekening 4600, niet aftrekbaar' : IB_CORRECTION_LABELS[c.code] ?? c.code}{c.shared ? ', naar winstaandeel' : ''}</span></td>
                  <td className="bk-num">{euroCents(c.amountCents)}</td>
                </tr>
              ))}
              {e.kiaCents > 0 && row('Investeringsaftrek (KIA)', -e.kiaCents, 'bk-balance-sub',
                multiple ? `aandeel in ${euroCents(kiaCents)} over ${euroCents(investmentTotalCents)}` : `over ${euroCents(investmentTotalCents)} aan investeringen`)}
              {row('Winst uit onderneming', e.profitCents, 'bk-report-total')}

              <tr className="bk-report-section"><td colSpan={2}>Ondernemersaftrek en mkb-winstvrijstelling</td></tr>
              {row('Zelfstandigenaftrek', -e.zelfstandigenaftrekCents, 'bk-balance-sub', zaHint)}
              {(profile.starter || e.startersaftrekCents > 0) && !isCommanditair && row('Startersaftrek', -e.startersaftrekCents, 'bk-balance-sub',
                profile.meetsHoursCriterion !== true ? 'alleen met het urencriterium' : profile.aowStatus === 'heel_jaar' ? 'de helft, AOW-leeftijd' : undefined)}
              {e.otherEntrepreneurDeductionCents > 0 && row('Overige ondernemersaftrek', -e.otherEntrepreneurDeductionCents, 'bk-balance-sub')}
              {row(`Mkb-winstvrijstelling (${formatRate(rules.mkbExemptionRate)})`, -e.mkbExemptionCents, 'bk-balance-sub',
                isCommanditair ? 'geen ondernemer' : e.mkbExemptionCents < 0 ? 'maakt het verlies kleiner' : undefined)}
              {row('Belastbare winst uit onderneming', e.taxableProfitCents, 'bk-report-total')}

              <tr className="bk-report-section"><td colSpan={2}>Box 1</td></tr>
              {e.lossOffsetCents > 0 && row('Verlies uit eerdere jaren', -e.lossOffsetCents, 'bk-balance-sub')}
              {row('Belastbaar inkomen uit werk en woning', e.taxableIncomeCents, 'bk-balance-sub')}
              {e.brackets.map((b, i) => row(
                `Schijf ${i + 1}: ${formatRate(b.rate)} over ${euroCents(b.amountCents)}`, b.taxCents, 'bk-balance-sub',
                i === 0 && e.premiumMonths < 12 ? (e.premiumMonths === 0 ? 'zonder AOW-premie' : `AOW-premie over ${e.premiumMonths} maanden`) : undefined,
              ))}
              {e.deductionCapCents > 0 && row('Aftrekbeperking', e.deductionCapCents, 'bk-balance-sub', `aftrek levert hoogstens ${formatRate(rules.deductionCapRate)} op`)}
              {row('Algemene heffingskorting', -e.generalCreditCents, 'bk-balance-sub')}
              {row('Arbeidskorting', -e.labourCreditCents, 'bk-balance-sub', isCommanditair ? 'winstaandeel is geen arbeidsinkomen' : `over ${euroCents(e.labourIncomeCents)}`)}
              {e.elderlyCreditCents > 0 && row('Ouderenkorting', -e.elderlyCreditCents, 'bk-balance-sub')}
              {e.creditsCents > e.creditsAppliedCents && row('Kortingen boven de belasting', e.creditsCents - e.creditsAppliedCents, 'bk-balance-sub', 'vallen weg')}
              {row('Inkomstenbelasting en premie volksverzekeringen', e.incomeTaxCents, 'bk-report-total')}
              {row(`Bijdrage Zvw (${formatRate(rules.zvwRate)} over ${euroCents(e.zvwBaseCents)})`, e.zvwCents, 'bk-report-total', 'aparte aanslag')}
              {(e.provisionalIncomeTaxCents > 0 || e.provisionalZvwCents > 0) && <>
                {row('Totaal', e.totalCents, 'bk-report-total')}
                {e.provisionalIncomeTaxCents > 0 && row('Voorlopige aanslag IB', -e.provisionalIncomeTaxCents, 'bk-balance-sub')}
                {e.provisionalZvwCents > 0 && row('Voorlopige aanslag Zvw', -e.provisionalZvwCents, 'bk-balance-sub')}
              </>}
            </tbody>
            <tfoot><tr className="bk-report-result">
              <td>{e.provisionalIncomeTaxCents > 0 || e.provisionalZvwCents > 0
                ? (e.balanceCents >= 0 ? 'Nog te betalen' : 'Terug te krijgen')
                : 'Te betalen (IB + Zvw)'}</td>
              <td className="bk-num">{euroCents(Math.abs(e.balanceCents))}</td>
            </tr></tfoot>
          </table>
        </div>
      </div>

      {(person.notes.length > 0 || e.effectiveRate > 0) && (
        <div className="ib-notes">
          {e.effectiveRate > 0 && <p className="bk-muted">Gemiddeld {(e.effectiveRate / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}% van de winst uit onderneming gaat naar inkomstenbelasting en Zvw.</p>}
          {person.notes.map(note => <p key={note} className="bk-muted">{note}</p>)}
        </div>
      )}
    </section>
  );
}

// ── KIA ─────────────────────────────────────────────────────────────────────

function KiaSection({ overview, rules, canWrite, busy, multiple, onToggle }: {
  overview: IncomeTaxOverview; rules: IbYearRules; canWrite: boolean; busy: boolean; multiple: boolean;
  onToggle: (assetId: string, excluded: boolean) => void;
}) {
  const k = rules.kia;
  return (
    <section className="bk-report ib-kia" aria-label="Kleinschaligheidsinvesteringsaftrek">
      <div className="bk-report-bar">
        <div className="ib-person-head">
          <h3>Kleinschaligheidsinvesteringsaftrek (KIA)</h3>
          <span className="bk-muted">Investeringen in {overview.year} uit Activa</span>
        </div>
        <div className="bk-report-kpis">
          <div><span>Investeringen</span><strong>{euroCents(overview.investmentTotalCents)}</strong></div>
          <div><span>KIA</span><strong>{euroCents(overview.kiaCents)}</strong></div>
        </div>
      </div>
      {overview.investments.length === 0
        ? <p className="bk-muted">Geen activa aangeschaft in {overview.year}. Leg een investering vast bij Activa, dan telt hij hier mee.</p>
        : <ul className="ib-kia-list">
            {overview.investments.map(inv => (
              <li key={inv.assetId}>
                <label className="bk-setting-check">
                  <input type="checkbox" checked={inv.counts} disabled={!canWrite || busy || inv.belowMinimum}
                    onChange={ev => onToggle(inv.assetId, !ev.target.checked)} />
                  <span>
                    {inv.name}{inv.assetNumber && <span className="bk-muted"> · {inv.assetNumber}</span>}
                    <small className="bk-muted"> {dateNL(inv.acquisitionDate)} · {euroCents(inv.costCents)}{inv.belowMinimum ? ` · onder ${euroCents(k.minAssetCents)}, telt niet mee` : inv.excluded ? ' · telt niet mee' : ''}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>}
      <p className="bk-muted">
        De KIA in {rules.year}: geen aftrek tot en met {euroCents(k.zeroUpToCents)} aan investeringen, {formatRate(k.rate)} tot en met {euroCents(k.percentageUpToCents)},
        {' '}{euroCents(k.fixedCents)} tot en met {euroCents(k.fixedUpToCents)}, daarna {formatRate(k.phaseOutRate)} minder over het meerdere, en niets boven {euroCents(k.maxCents)}.
        Een bedrijfsmiddel telt vanaf {euroCents(k.minAssetCents)}. Zet uit wat niet meetelt: een personenauto (behalve een taxi of een auto zonder CO₂-uitstoot), grond, een woning of iets wat je verhuurt.
        {multiple && ' Bij een vof telt het totaal van de vof; de aftrek gaat naar winstaandeel naar de vennoten (Hoge Raad 2020).'}
        {' '}Verkoop je binnen 5 jaar iets waarvoor je KIA kreeg, geef dan een desinvesteringsbijtelling op als correctie.
      </p>
    </section>
  );
}

// ── Correcties ──────────────────────────────────────────────────────────────

function CorrectionsSection({ overview, year, canWrite, busy, isPartnershipForm, onAdd, onDelete }: {
  overview: IncomeTaxOverview; year: number; canWrite: boolean; busy: boolean; isPartnershipForm: boolean;
  onAdd: (input: { year: number; partnerId: string | null; code: IbCorrectionCode; label: string; amountCents: number }) => Promise<boolean>;
  onDelete: (id: string) => void;
}) {
  const [code, setCode] = useState<IbCorrectionCode>('privegebruik_auto');
  const [partnerId, setPartnerId] = useState('');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const partners = overview.persons.filter(p => p.partnerId !== null);
  const all = useMemo(() => {
    const seen = new Map<string, { id: string; code: IbCorrectionCode; label: string; amountCents: number; who: string; automatic: boolean }>();
    for (const p of overview.persons) {
      for (const c of p.corrections) {
        if (c.shared) {
          const prev = seen.get(c.id);
          seen.set(c.id, { id: c.id, code: c.code, label: c.label, amountCents: (prev?.amountCents ?? 0) + c.amountCents, who: 'Hele onderneming', automatic: c.automatic });
        } else {
          seen.set(c.id, { id: c.id, code: c.code, label: c.label, amountCents: c.amountCents, who: partners.length > 0 ? p.name : 'Onderneming', automatic: c.automatic });
        }
      }
    }
    return [...seen.values()];
  }, [overview.persons, partners.length]);

  const add = async () => {
    setFormError(null);
    const typed = parseDutchAmountCents(amount);
    if (!label.trim()) { setFormError('Geef de correctie een omschrijving.'); return; }
    if (typed === null || typed === 0) { setFormError('Vul een bedrag in.'); return; }
    const sign = SIGN_BY_CODE[code];
    const amountCents = sign ? sign * Math.abs(typed) : typed;
    if (await onAdd({ year, partnerId: partnerId || null, code, label: label.trim(), amountCents })) {
      setLabel(''); setAmount('');
    }
  };

  return (
    <section className="bk-report ib-corrections" aria-label="Fiscale correcties">
      <div className="ib-person-head">
        <h3>Fiscale correcties {year}</h3>
        <span className="bk-muted">Wat de fiscale winst anders maakt dan de winst in de boekhouding</span>
      </div>
      {all.length === 0
        ? <p className="bk-muted">Geen correcties. Denk aan de bijtelling voor privégebruik van een auto van de zaak, boetes, of een energie- of milieu-investeringsaftrek. Eten, drinken en representatie op 4600 rekent ResoFly zelf mee.</p>
        : <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr><th>Correctie</th><th className="bk-num">Bedrag</th><th aria-label="Acties" /></tr></thead>
            <tbody>{all.map(c => (
              <tr key={c.id}>
                <td>{c.label}<div className="bk-muted ib-sub">{c.automatic
                  ? 'Automatisch: wat op 4600 Eten, drinken en representatie staat, is beperkt aftrekbaar. Het gunstigste van 20% of de drempel.'
                  : IB_CORRECTION_LABELS[c.code] ?? c.code}{isPartnershipForm ? ` · ${c.who}` : ''}</div></td>
                <td className="bk-num">{euroCents(c.amountCents)}</td>
                <td className="bk-cell-action">
                  {canWrite && !c.automatic && <button type="button" className="bk-line-del" title="Verwijderen" aria-label={`Correctie ${c.label} verwijderen`} disabled={busy} onClick={() => onDelete(c.id)}><Trash2 size={13} /></button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>}
      {canWrite && (
        <>
          <div className="bk-fy-new-fields ib-correction-form">
            <label><span>Soort</span>
              <Select value={code} onChange={e => setCode(e.target.value as IbCorrectionCode)}>
                {(Object.keys(IB_CORRECTION_LABELS) as IbCorrectionCode[]).map(k => <option key={k} value={k}>{IB_CORRECTION_LABELS[k]}</option>)}
              </Select>
            </label>
            {partners.length > 0 && (
              <label><span>Voor</span>
                <Select value={partnerId} onChange={e => setPartnerId(e.target.value)}>
                  <option value="">Hele onderneming (naar winstaandeel)</option>
                  {partners.map(p => <option key={p.key} value={p.partnerId ?? ''}>{p.name}</option>)}
                </Select>
              </label>
            )}
            <label><span>Omschrijving</span><Input value={label} maxLength={200} onChange={e => setLabel(e.target.value)} placeholder="Bijv. bijtelling auto" /></label>
            <label><span>Bedrag</span><Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="1500,00" /></label>
          </div>
          <p className="bk-muted">
            {SIGN_BY_CODE[code] === -1 ? 'Deze correctie verlaagt de winst.' : SIGN_BY_CODE[code] === 1 ? 'Deze correctie verhoogt de winst.' : 'Positief verhoogt de winst, negatief (met een min) verlaagt hem.'}
            {code === 'gemengde_kosten' && ' Wat op 4600 Eten, drinken en representatie staat, rekent ResoFly zelf mee; vul hier alleen het niet-aftrekbare deel in van wat op een andere rekening staat.'}
          </p>
          {formError && <p className="bk-neg">{formError}</p>}
          <div className="bk-fy-new-actions">
            <Button disabled={busy} onClick={() => void add()}><Plus size={14} /> Correctie toevoegen</Button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Specificatie (CSV) ──────────────────────────────────────────────────────

function specificationRows(overview: IncomeTaxOverview, rules: IbYearRules): (string | number)[][] {
  const amount = (cents: number) => (cents / 100).toFixed(2);
  const rows: (string | number)[][] = [
    ['', 'Let op', overview.disclaimer, ''],
    ['', 'Kalenderjaar', `${overview.year}${overview.rulesExact ? '' : ` (tarieven ${rules.year})`}`, ''],
    ['', overview.basis === 'prognose' ? 'Winst (prognose heel jaar)' : 'Winst (geboekt)', '', amount(overview.usedResultCents)],
    ['', 'Investeringen voor de KIA', '', amount(overview.investmentTotalCents)],
    ['', 'KIA', '', amount(overview.kiaCents)],
  ];
  for (const p of overview.persons) {
    const e = p.estimate;
    const who = p.name;
    rows.push(
      [who, p.shareBasisPoints !== null ? 'Winstaandeel' : 'Winst', p.shareBasisPoints !== null ? shareText(p.shareBasisPoints) : '', amount(e.profitShareCents)],
      ...p.corrections.map(c => [who, 'Correctie', `${c.label} (${IB_CORRECTION_LABELS[c.code] ?? c.code})`, amount(c.amountCents)] as (string | number)[]),
      [who, 'KIA', '', amount(-e.kiaCents)],
      [who, 'Winst uit onderneming', '', amount(e.profitCents)],
      [who, 'Zelfstandigenaftrek', p.profile.meetsHoursCriterion === null ? 'urencriterium niet ingevuld' : p.profile.meetsHoursCriterion ? 'urencriterium gehaald' : 'urencriterium niet gehaald', amount(-e.zelfstandigenaftrekCents)],
      [who, 'Startersaftrek', '', amount(-e.startersaftrekCents)],
      [who, 'Overige ondernemersaftrek', '', amount(-e.otherEntrepreneurDeductionCents)],
      [who, 'Mkb-winstvrijstelling', formatRate(rules.mkbExemptionRate), amount(-e.mkbExemptionCents)],
      [who, 'Belastbare winst uit onderneming', '', amount(e.taxableProfitCents)],
      [who, 'Verlies uit eerdere jaren', '', amount(-e.lossOffsetCents)],
      [who, 'Belastbaar inkomen uit werk en woning', '', amount(e.taxableIncomeCents)],
      ...e.brackets.map((b, i) => [who, `Schijf ${i + 1}`, `${formatRate(b.rate)} over ${amount(b.amountCents)}`, amount(b.taxCents)] as (string | number)[]),
      [who, 'Aftrekbeperking', '', amount(e.deductionCapCents)],
      [who, 'Algemene heffingskorting', '', amount(-e.generalCreditCents)],
      [who, 'Arbeidskorting', '', amount(-e.labourCreditCents)],
      [who, 'Ouderenkorting', '', amount(-e.elderlyCreditCents)],
      [who, 'Niet te verrekenen kortingen', '', amount(e.creditsCents - e.creditsAppliedCents)],
      [who, 'Inkomstenbelasting en premie volksverzekeringen', '', amount(e.incomeTaxCents)],
      [who, 'Bijdrage Zvw', `${formatRate(rules.zvwRate)} over ${amount(e.zvwBaseCents)}`, amount(e.zvwCents)],
      [who, 'Totaal', '', amount(e.totalCents)],
      [who, 'Voorlopige aanslag IB', '', amount(-e.provisionalIncomeTaxCents)],
      [who, 'Voorlopige aanslag Zvw', '', amount(-e.provisionalZvwCents)],
      [who, e.balanceCents >= 0 ? 'Nog te betalen' : 'Terug te krijgen', '', amount(Math.abs(e.balanceCents))],
    );
  }
  for (const w of overview.warnings) rows.push(['', 'Waarschuwing', w, '']);
  return rows;
}
