import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import type {
  AppData, FiscalYearListRow, OrganizationMember, OwnersEquityOverview, PartnershipPartner, PartnershipPartnerChange, PartnershipPartnerHours, UUID,
} from '../types';
import { Button, Input, Select, Skeleton } from '../components/Ui';
import { PageIcon } from '../components/PageIcon';
import { euro, minutesToHours } from '../lib/format';
import { formatISODate } from '../lib/dates';
import { missingFiscalYear } from '../lib/jaarwissel';
import { downloadCsv } from '../lib/csv';
import {
  EQUITY_CSV_HEADER, INCOME_TAX_SUMMARY_CSV_HEADER, equityCsvRows, incomeTaxSummaryCsvRows, type IncomeTaxSummaryLine,
} from '../lib/financeCsv';
import { HOUR_CRITERION_MINUTES, projectHourCriterion } from '../lib/hourCriterion';
import { memberName } from '../lib/members';
import { useBackStep } from '../lib/useBackStep';
import {
  IB_CORRECTION_LABELS, buildIncomeTaxOverview, formatRate, incomeTaxRulesFor, type IncomeTaxInputs,
} from '../lib/inkomstenbelasting';
import {
  deletePartnershipPartner, deletePartnershipPartnerChange, listFiscalYears, listPartnershipPartnerTimeline, listPartnershipPartners, loadIncomeTaxInputs,
  loadOwnersEquityOverview, loadPartnershipPartnerHours, openFiscalYear, savePartnershipPartner, setPartnershipPartnerMember, setUpBookkeeping,
} from '../lib/repository';
import {
  LossShiftNote, SplitPeriods, YearSplitPanel, changedAfterYearEnd, dayLabel, legalFormWord, parsePercent, periodLabel, periodProblem, pct, splitSourceLabel,
} from './PartnerSplit';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
/** Hele uren, naar boven afgerond: "nog 325 u", net als de "900 u" ernaast. */
const wholeHours = (minutes: number) => `${Math.ceil(Math.max(0, minutes) / 60).toLocaleString('nl-NL')}\u00a0u`;
const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/** De rekening uit Instellingen → Boekhouding, zoals de jaarafsluiting hem gebruikt. */
function resultAccountLabel(code: string | null | undefined): string {
  return code === '0500' ? '0500 Eigen vermogen' : '0510 Onverdeeld resultaat';
}

type PartnerForm = { name: string; share: string; kind: PartnershipPartner['kind']; isActive: boolean; userId: string; date: string };

/** Het percentage zoals in het veld: "50" of "33,33". */
const bpToField = (bp: number) => String(bp / 100).replace('.', ',');

/** JJJJ-MM-DD plus `days` (ook negatief), zonder tijdzone-gedoe. */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** De dag (in Nederland) waarop iets is vastgelegd, als JJJJ-MM-DD. */
function amsterdamDay(timestamp: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(timestamp));
}

/** De stand van een vennoot op `day`: de laatste wijziging met een ingangsdatum op of vóór die dag. */
function standOn(changes: PartnershipPartnerChange[], day: string): PartnershipPartnerChange | null {
  let found: PartnershipPartnerChange | null = null;
  for (const c of changes) if (c.valid_from <= day) found = c;
  return found;
}

const kindWord = (kind: PartnershipPartner['kind']) => (kind === 'commanditair' ? 'commanditair (stil)' : 'beherend');

/** Eén regel van de tijdlijn: "sinds 1 jan 2025: 50%", "vanaf 1 jul 2026: 30%", "uitgetreden per 1 feb 2026". */
function changeLabel(change: PartnershipPartnerChange, previous: PartnershipPartnerChange | null, cv: boolean): string {
  const kind = cv && change.kind === 'commanditair' ? ', commanditair' : '';
  if (!change.is_active) return `uitgetreden per ${dayLabel(change.valid_from)}`;
  const share = `${pct(change.share_basis_points)}${kind}`;
  if (!previous) return `sinds ${dayLabel(change.valid_from)}: ${share}`;
  if (!previous.is_active) return `weer vennoot per ${dayLabel(change.valid_from)}: ${share}`;
  return `vanaf ${dayLabel(change.valid_from)}: ${share}`;
}

/**
 * Wat er in de tabel onder de naam staat: "sinds 1 jan 2025", "uitgetreden per
 * 1 jul 2026", en wat er nog komt ("treedt uit per 1 jan 2027").
 */
function partnerDates(changes: PartnershipPartnerChange[], today: string): string | null {
  if (changes.length === 0) return null;
  const now = standOn(changes, today);
  const next = changes.find(c => c.valid_from > today) ?? null;
  const parts: string[] = [];
  if (!now) {
    parts.push(next?.is_active ? `vennoot vanaf ${dayLabel(next.valid_from)}` : 'nog geen vennoot');
    return parts.join(' · ');
  }
  if (!now.is_active) parts.push(`uitgetreden per ${dayLabel(now.valid_from)}`);
  else {
    // Sinds het begin van de periode waarin hij nu vennoot is: een ander
    // percentage halverwege verandert "sinds" niet.
    let since: string | null = null;
    for (const c of changes) {
      if (c.valid_from > today) break;
      if (!c.is_active) since = null;
      else if (since === null) since = c.valid_from;
    }
    parts.push(`sinds ${dayLabel(since ?? now.valid_from)}`);
  }
  if (next) {
    if (!next.is_active) parts.push(`treedt uit per ${dayLabel(next.valid_from)}`);
    else if (!now.is_active) parts.push(`weer vennoot per ${dayLabel(next.valid_from)}`);
    else if (next.share_basis_points !== now.share_basis_points) parts.push(`vanaf ${dayLabel(next.valid_from)}: ${pct(next.share_basis_points)}`);
  }
  return parts.join(' · ');
}

/** Wat er in de kolom Urencriterium staat: de uren, en of het haalbaar is. */
function hoursCell(partner: PartnershipPartner, row: PartnershipPartnerHours | undefined, year: number, today: string) {
  // Een commanditaire vennoot is voor de inkomstenbelasting geen ondernemer.
  if (partner.kind === 'commanditair') return { text: 'n.v.t.', tone: '' };
  if (!partner.user_id) return { text: '—', tone: 'bk-muted' };
  if (!row) return { text: '—', tone: 'bk-muted' };
  const total = row.direct_minutes + row.indirect_minutes;
  const hours = `${Math.floor(minutesToHours(total)).toLocaleString('nl-NL')}\u00a0u`;
  if (total >= HOUR_CRITERION_MINUTES) return { text: `${hours} · gehaald`, tone: 'bk-pos' };
  const currentYear = Number(today.slice(0, 4));
  if (year > currentYear) return { text: hours, tone: '' };
  if (year < currentYear) return { text: `${hours} · niet gehaald`, tone: 'bk-neg' };
  const projection = projectHourCriterion({ totalMinutes: total, firstEntryDate: row.first_entry_date, today, year });
  return projection.projectedMinutes >= HOUR_CRITERION_MINUTES
    ? { text: `${hours} · op koers`, tone: '' }
    // "nog 325u" naast "900 u" las als twee verschillende eenheden.
    : { text: `${hours} · onder koers, nog ${wholeHours(projection.remainingMinutes)}`, tone: 'bk-neg' };
}

/**
 * Eigen vermogen van een eenmanszaak, en de vennoten van een vof, maatschap of cv.
 *
 * Bij een IB-onderneming is de winst van de ondernemer of de vennoten zelf. Deze
 * pagina laat per boekjaar de kapitaalvergelijking zien (begin, resultaat,
 * stortingen, opnamen, eind): dat is wat de aangifte inkomstenbelasting vraagt
 * als ondernemingsvermogen aan het begin en het eind van het jaar. Bij een vof
 * staat dat per vennoot, en hier leg je de vennoten en hun winstaandeel vast.
 *
 * Het urencriterium geldt per vennoot. Tot 17 november 2026 telde ResoFly
 * alleen de uren van wie was ingelogd (bij Uren), en kon niemand zien of de
 * andere vennoot de 1225 uur haalde. Daarom hangt een vennoot nu aan zijn
 * teamlid, en staan hier de uren van elke vennoot in het kalenderjaar van het
 * gekozen boekjaar. Alleen met leesrecht op Uren: de database weigert anders.
 */
export function OwnersPage({ data, organizationId, canWrite, onChanged, canReadHours = true, teamMembers = [], currentUserId = null, onOpenIncomeTax }: {
  data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void;
  /**
   * Niet meer gebruikt. De uren van de eigenaar komen nu uit dezelfde aanroep
   * als de raming (get_income_tax_inputs), zodat dit overzicht en Financiën →
   * Inkomstenbelasting dezelfde eigenaar en dezelfde uren tellen. De app-shell
   * geeft hem nog mee.
   */
  ownerUserId?: UUID | null;
  /** Zonder leesrecht op Uren (vaak de boekhouder) zie je geen uren: dan zegt het overzicht dat, in plaats van "0 uur, niet gehaald". */
  canReadHours?: boolean;
  /** De teamleden die je aan een vennoot kunt koppelen (vof, maatschap, cv). */
  teamMembers?: OrganizationMember[];
  currentUserId?: UUID | null;
  /** Naar Financiën → Inkomstenbelasting; zonder deze prop staat er alleen waar je het vindt. */
  onOpenIncomeTax?: () => void;
}) {
  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  const isIb = ['eenmanszaak', 'vof', 'maatschap', 'cv'].includes(legalForm);
  const isPartnershipForm = ['vof', 'maatschap', 'cv'].includes(legalForm);
  const resultLabel = resultAccountLabel(data.companySettings?.year_result_account_code);

  const [years, setYears] = useState<FiscalYearListRow[]>([]);
  const [fiscalYearId, setFiscalYearId] = useState('');
  const [partners, setPartners] = useState<PartnershipPartner[]>([]);
  const [overview, setOverview] = useState<OwnersEquityOverview | null>(null);
  const [hours, setHours] = useState<Map<string, PartnershipPartnerHours> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Het venster van een vennoot: een bestaande (zijn id) of een nieuwe (null). */
  const [dialog, setDialog] = useState<{ partnerId: string | null } | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  /** De standen van alle vennoten, met ingangsdatum (20261124120000). */
  const [timeline, setTimeline] = useState<PartnershipPartnerChange[]>([]);

  const accountCode = useMemo(() => new Map(data.ledgerAccounts.map(a => [a.id, a.code])), [data.ledgerAccounts]);
  const today = formatISODate(new Date());
  // Het urencriterium loopt over het kalenderjaar. Bij een eenmanszaak, vof,
  // maatschap of cv is het boekjaar het kalenderjaar; anders telt het jaar
  // waarin het boekjaar begint.
  const selectedYear = years.find(y => y.id === fiscalYearId) ?? null;
  const hoursYear = selectedYear ? Number(selectedYear.period_start.slice(0, 4)) : Number(today.slice(0, 4));
  const showHours = isPartnershipForm && canReadHours;
  // Na de jaarwissel: het nieuwe boekjaar opent vanzelf bij de eerste boeking.
  // Tot dan stond hier alleen het oude jaar, zonder uitleg.
  const yearToOpen = missingFiscalYear({ today, calendarYearOnly: isIb, years });
  const openMissingYear = async () => {
    if (yearToOpen === null) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const opened = await openFiscalYear(organizationId, { periodStart: `${yearToOpen}-01-01`, periodEnd: `${yearToOpen}-12-31` });
      await loadBase();
      setFiscalYearId(opened.id);
      setMessage(`Boekjaar ${yearToOpen} is geopend.`);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Boekjaar openen mislukt'); }
    finally { setBusy(false); }
  };
  const anyLinked = partners.some(p => p.user_id);
  // Welke vennoot aan welk teamlid hangt. Het effect hieronder hing alleen aan
  // "is er iemand gekoppeld": wie een tweede vennoot koppelde, zag bij hem "—"
  // tot hij de pagina herlaadde.
  const linkedKey = partners.map(p => `${p.id}:${p.user_id ?? ''}`).join(',');

  const loadBase = useCallback(async () => {
    try {
      const [ys, ps, tl] = await Promise.all([
        listFiscalYears(organizationId),
        listPartnershipPartners(organizationId),
        // Zonder tijdlijn (een database van vóór 20261124120000) blijft de
        // pagina werken zoals daarvoor, met de stand van de vennoten zelf.
        isPartnershipForm ? listPartnershipPartnerTimeline(organizationId).catch(() => [] as PartnershipPartnerChange[]) : Promise.resolve([] as PartnershipPartnerChange[]),
      ]);
      setYears(ys);
      setPartners(ps);
      setTimeline(tl);
      setFiscalYearId(prev => prev || ys[0]?.id || '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Laden mislukt'); }
  }, [organizationId, isPartnershipForm]);

  const loadOverview = useCallback(async (id: string) => {
    if (!id) { setOverview(null); return; }
    setLoading(true);
    try { setOverview(await loadOwnersEquityOverview(organizationId, id)); }
    catch (e) { setOverview(null); setError(e instanceof Error ? e.message : 'Overzicht laden mislukt'); }
    finally { setLoading(false); }
  }, [organizationId]);

  const loadHours = useCallback(async (year: number) => {
    try {
      const rows = await loadPartnershipPartnerHours(organizationId, year);
      setHours(new Map(rows.map(r => [r.partner_id, r])));
    } catch {
      // Zonder uren blijft de rest van de pagina gewoon bruikbaar.
      setHours(null);
    }
  }, [organizationId]);

  useEffect(() => { if (isIb) void loadBase(); }, [isIb, loadBase]);
  useEffect(() => { if (isIb && fiscalYearId) void loadOverview(fiscalYearId); }, [isIb, fiscalYearId, loadOverview]);
  useEffect(() => {
    if (showHours && anyLinked) void loadHours(hoursYear);
    else setHours(null);
  }, [showHours, anyLinked, linkedKey, hoursYear, loadHours]);

  if (!isIb) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">Eigen vermogen</div>
      <div>Dit overzicht hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.
        Bij een BV of NV staat het eigen vermogen bij de aandeelhouders en de resultaatbestemming.</div>
    </div></div>;
  }

  // De standen per vennoot, oudste eerst.
  const changesOf = (partnerId: string) => timeline.filter(c => c.partner_id === partnerId).sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  // Actief en percentage van vandaag. De vennoot zelf staat sinds
  // 20261124120000 op zijn laatste stand, ook als die pas later ingaat: wie per
  // 1 januari uittreedt, telde hier anders nu al niet meer mee.
  const nowOf = (p: PartnershipPartner) => {
    const changes = changesOf(p.id);
    if (changes.length === 0) return { active: p.is_active, bp: p.profit_share_basis_points };
    const stand = standOn(changes, today);
    return { active: Boolean(stand?.is_active), bp: stand?.share_basis_points ?? 0 };
  };
  const activePartners = partners.filter(p => nowOf(p).active);
  const activeShare = activePartners.reduce((s, p) => s + nowOf(p).bp, 0);
  const shareOk = activeShare === 10000;
  // Teamleden die je aan een vennoot kunt koppelen: actief, en nog niet aan een
  // andere vennoot gekoppeld (de database weigert dat ook).
  const linkableMembers = (forPartnerId: string | null) => teamMembers.filter(m =>
    m.status === 'active' && !partners.some(p => p.user_id === m.user_id && p.id !== forPartnerId));
  // De boekhouder (en wie de ledenlijst verder niet mag lezen) krijgt van de
  // database alleen zijn eigen rij. Dan stond bij elke vennoot "Teamlid (niet
  // meer in de organisatie)", terwijl dat teamlid er gewoon was.
  const membersReadable = teamMembers.some(m => m.user_id !== currentUserId);
  const linkedLabel = (userId: UUID) => (teamMembers.some(m => m.user_id === userId)
    ? `Teamlid: ${memberName(userId, teamMembers, currentUserId)}`
    : membersReadable ? 'Teamlid (niet meer in de organisatie)' : 'Gekoppeld aan een teamlid');

  /**
   * Een per ongeluk vastgelegde vennoot weer weghalen. Hij bleef anders
   * voorgoed in elke kapitaalvergelijking en keuzelijst staan, en telde mee
   * voor het maximum van negen. Met boekingen weigert de database; die
   * melding zegt wat je dan doet (op uitgetreden zetten), dus die tonen we
   * zoals hij is.
   */
  const removePartner = async (partner: PartnershipPartner) => {
    if (!confirm(`${partner.name} verwijderen, met zijn kapitaal- en privérekeningen? Dat kan alleen als er nog niets op die rekeningen is geboekt. Heeft hij boekingen, zet hem dan op uitgetreden.`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await deletePartnershipPartner(organizationId, partner.id);
      await loadBase();
      await loadOverview(fiscalYearId);
      onChanged();
      setMessage(`${partner.name} is verwijderd, met zijn rekeningen.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt'); }
    finally { setBusy(false); }
  };

  /** Na opslaan of een wijziging weghalen in het venster: alles opnieuw, want de verdeling en de perioden kunnen anders zijn. */
  const reloadAfterPartnerChange = async (text: string | null) => {
    await loadBase();
    await loadOverview(fiscalYearId);
    onChanged();
    if (text) setMessage(text);
  };

  // Geen boekjaar: met één klik het rekeningschema en de boekjaren vanaf de
  // start van de boekhouding. Hier stond alleen "Maak eerst een boekjaar aan
  // bij Financiën → Boekjaren", zonder knop.
  const setUp = async () => {
    setBusy(true); setError(null);
    try {
      await setUpBookkeeping(organizationId);
      await loadBase();
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Boekjaar openen mislukt'); }
    finally { setBusy(false); }
  };

  const owners = overview?.owners ?? [];
  const totals = owners.reduce((t, o) => ({
    begin: t.begin + o.beginCents, result: t.result + o.resultShareCents, contributions: t.contributions + o.contributionsCents,
    withdrawals: t.withdrawals + o.withdrawalsCents, other: t.other + o.otherMovementsCents, end: t.end + o.endCents,
    toCurrent: t.toCurrent + (o.toCurrentAccountCents ?? 0),
  }), { begin: 0, result: 0, contributions: 0, withdrawals: 0, other: 0, end: 0, toCurrent: 0 });
  // De kolom "Naar rekening-courant" alleen als er iemand is uitgetreden: de
  // tabel heeft op de telefoon al zeven kolommen.
  const showToCurrent = owners.some(o => (o.toCurrentAccountCents ?? 0) !== 0);
  // Het saldo van de rekening-courant per vennoot (een schuld aan hem of een
  // vordering op hem), en bij een open jaar wat het na het afsluiten wordt.
  const currentAccounts = owners.filter(o => (o.currentAccountCents ?? 0) !== 0 || (o.toCurrentAccountCents ?? 0) !== 0);
  const unassigned = overview?.unassigned ?? null;
  // De winst van een vorig jaar dat nog open staat, staat sinds 20261122100000
  // apart. Hij zat in het begin van "nog niet toegewezen", en de tekst eronder
  // raadde aan dat bedrag met een memoriaal over de vennoten te verdelen: wie
  // dat deed en daarna het vorige jaar afsloot, gaf de vennoten die winst twee keer.
  const openPrior = unassigned?.openPriorResultCents ?? 0;
  const unassignedResult = unassigned?.resultCents ?? 0;
  const unassignedEnd = (unassigned?.endCents ?? 0) - openPrior;
  // Bij een vof, maatschap of cv altijd de vennoten, ook als er in dit jaar
  // niemand meedoet in de verdeling. Anders stond er "Ondernemer" met de
  // bedrijfsnaam en de teksten van een eenmanszaak.
  const vofView = Boolean(overview?.isPartnershipForm);
  const yearLabel = overview?.fiscalYear.label ?? '';
  const yearOpen = overview?.fiscalYear.status !== 'closed';
  const changed = overview ? changedAfterYearEnd(overview) : [];
  // Het jaar van de beginbalans: het boekjaar waarin de boekhouding begint, of
  // anders het eerste. Daar hoort een sluitpost op 0500 thuis.
  const bookkeepingStart = data.companySettings?.bookkeeping_start_date ?? null;
  const openingYear = (bookkeepingStart ? years.find(y => bookkeepingStart >= y.period_start && bookkeepingStart <= y.period_end) : null)
    ?? (years.length > 0 ? years[years.length - 1] : null);
  // Begon de boekhouding in ResoFly in de loop van het kalenderjaar van dit
  // boekjaar, dan kent ResoFly de winst van daarvóór niet. Bij een
  // eenmanszaak zegt de raming hieronder dat; bij een vof stond het nergens,
  // en ging elke vennoot uit van een winstaandeel over een half jaar.
  const calendarYear = overview ? overview.fiscalYear.periodStart.slice(0, 4) : '';
  const lateStart = vofView && bookkeepingStart && overview
    && bookkeepingStart.slice(0, 4) === calendarYear && bookkeepingStart > `${calendarYear}-01-01`
    && bookkeepingStart <= overview.fiscalYear.periodEnd ? bookkeepingStart : null;

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><PageIcon page="owners" />
          <h2>{isPartnershipForm ? 'Vennoten' : 'Eigen vermogen'}</h2>
          <p>{isPartnershipForm
            ? 'De vennoten, hun winstaandeel en per vennoot de kapitaalvergelijking: wat ieder in zijn eigen aangifte inkomstenbelasting nodig heeft.'
            : 'De kapitaalvergelijking van je onderneming: beginvermogen, winst, privé-stortingen en -opnamen, eindvermogen.'}</p>
        </div>
        <div className="bk-head-actions">
          <Select value={fiscalYearId} onChange={e => setFiscalYearId(e.target.value)}>
            {years.length === 0 && <option value="">Geen boekjaren</option>}
            {years.map(y => <option key={y.id} value={y.id}>{y.label}</option>)}
          </Select>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <p className="bk-note">{message}</p>}
      {yearToOpen !== null && (
        <p className="bk-note">
          Er is nog geen boekjaar {yearToOpen}. Het komt er vanzelf bij je eerste boeking in {yearToOpen}.
          {canWrite && <>{' '}<button type="button" className="bk-link-button" disabled={busy} onClick={() => void openMissingYear()}>Boekjaar {yearToOpen} nu openen</button></>}
        </p>
      )}

      {/* ── Vennoten ── */}
      {isPartnershipForm && (
        <div className="bk-report">
          <div className="bk-report-bar">
            <div className="bk-report-kpis">
              <div><span>Vennoten</span><strong>{activePartners.length}</strong></div>
              <div><span>Winstverdeling</span><strong className={activePartners.length > 0 && !shareOk ? 'bk-neg' : ''}>{pct(activeShare)}</strong></div>
            </div>
            {canWrite && (
              <Button onClick={() => { setMessage(null); setDialog({ partnerId: null }); }} disabled={busy}><Plus size={14} /> Vennoot toevoegen</Button>
            )}
          </div>

          {partners.length === 0
            ? <p className="bk-muted">
                Nog geen vennoten vastgelegd. Zolang dat zo is, verdeelt de jaarafsluiting niets: de winst gaat naar {resultLabel} (in te stellen bij
                Instellingen → Boekhouding), en privé-opnamen en -stortingen op 0550 en 0560 gaan naar 0500 Eigen vermogen.
              </p>
            : <div className="bk-table-wrap"><table className="bk-table bk-partners-table">
                <thead><tr>
                  {/* "nu": het percentage van vandaag. Wat er in een boekjaar gold,
                      staat bij de kapitaalvergelijking van dat jaar. */}
                  <th>Vennoot</th><th className="bk-num">Winstaandeel nu</th>
                  {legalForm === 'cv' && <th>Soort</th>}
                  {showHours && <th>Urencriterium {hoursYear}</th>}
                  <th className="bk-col-wide">Rekeningen</th>
                  {canWrite && <th aria-label="Aanpassen of verwijderen" />}
                </tr></thead>
                <tbody>{partners.map(p => {
                  const cell = hoursCell(p, hours?.get(p.id), hoursYear, today);
                  const now = nowOf(p);
                  const dates = partnerDates(changesOf(p.id), today);
                  return (
                    <tr key={p.id} className={now.active ? '' : 'is-reversed'}>
                      {/* Het teamlid en de status onder de naam: als eigen kolommen
                          stonden ze op de telefoon pas na zijwaarts vegen in beeld, en
                          dan was de naam weg. Sinds 20261124120000 met de datums:
                          "sinds 1 jan 2025", "uitgetreden per 1 jul 2026". */}
                      <td><strong>{p.name}</strong>
                        <div className="bk-muted bk-partner-member">
                          {p.user_id ? linkedLabel(p.user_id) : 'Geen teamlid gekoppeld'}
                          {!dates && !now.active && <> · <span className="bk-partner-status">uitgetreden</span></>}
                        </div>
                        {/* Op een eigen regel: achter het teamlid brak het op de telefoon midden in de woorden. */}
                        {dates && <div className={`bk-muted bk-partner-member${now.active ? '' : ' bk-partner-status'}`}>{dates}</div>}
                      </td>
                      {/* Een uitgetreden vennoot heeft nu geen winstaandeel; zijn
                          percentage van toen staat in het venster bij zijn standen. */}
                      <td className="bk-num">{now.active ? pct(now.bp) : '—'}</td>
                      {legalForm === 'cv' && <td>{p.kind === 'commanditair' ? 'Commanditair (stil)' : 'Beherend'}</td>}
                      {showHours && <td className={`bk-partner-hours ${cell.tone}`.trim()}>{cell.text}</td>}
                      <td className="bk-muted bk-col-wide">{[p.capital_account_id, p.withdrawals_account_id, p.contributions_account_id, p.current_account_id]
                        .filter((id): id is string => Boolean(id)).map(id => accountCode.get(id) ?? '—').join(' · ')}</td>
                      {canWrite && (
                        <td className="bk-cell-action">
                          <div className="bk-partner-actions">
                            <button type="button" className="bk-icon-btn" title={`${p.name} aanpassen`} aria-label={`${p.name} aanpassen`} disabled={busy}
                              onClick={() => { setMessage(null); setDialog({ partnerId: p.id }); }}>
                              <Pencil size={14} /></button>
                            <button type="button" className="bk-icon-btn" title={`${p.name} verwijderen (alleen zonder boekingen)`} aria-label={`${p.name} verwijderen`} disabled={busy}
                              onClick={() => void removePartner(p)}>
                              <Trash2 size={14} /></button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}</tbody>
              </table></div>}

          {partners.length > 0 && activePartners.length === 0 && (
            <p className="bk-muted">
              Er is geen actieve vennoot. Bij de jaarafsluiting gaat de winst dan zonder verdeling naar {resultLabel}; het privé van elke vennoot gaat naar zijn eigen kapitaal.
            </p>
          )}
          {activePartners.length > 0 && !shareOk && (
            <p className="bk-neg"><AlertTriangle size={13} /> De winstverdeling van de actieve vennoten telt op tot {pct(activeShare)}. Bij de jaarafsluiting moet dat precies 100% zijn.</p>
          )}

          <p className="bk-muted">
            Elke vennoot krijgt een eigen kapitaalrekening (050n), privérekeningen voor opnamen (055n) en stortingen (056n), en een rekening-courant (141n). Bij de jaarafsluiting
            gaat het resultaat naar de kapitaalrekeningen, tot op de cent sluitend, en gaat het privé van elke vennoot naar zijn kapitaal.
            {/* Tot 24 november 2026 stond hier dat de verdeling per boekjaar
                geldt. Wie halverwege het jaar toetrad of uittrad, moest zijn
                deel dan zelf uitrekenen en als bedrag vooraf vastleggen. */}
            {' '}Elke wijziging heeft een ingangsdatum. Treedt iemand in de loop van een jaar toe of uit, of krijgt hij een ander percentage, dan valt dat jaar uiteen in perioden:
            het resultaat van elke periode gaat naar wie toen vennoot was. Wie uittreedt, houdt geen kapitaal in de {legalFormWord(legalForm)}: bij de jaarafsluiting gaat het naar zijn rekening-courant, een schuld aan hem.
            {/* Tot 22 november 2026 stond hier "boek die als memoriaal tussen de
                kapitaalrekeningen". Dat kwam in de kapitaalvergelijking onder
                Overig, en niet in het winstaandeel dat elke vennoot aangeeft. */}
            {' '}Staat er in het vennootschapscontract een arbeidsbeloning of rente over het kapitaal vóór de verdeling, vul die dan in als voorafgaand bedrag in de verdeling van het boekjaar
            (Verdeling aanpassen bij de kapitaalvergelijking hieronder, of bij Boekjaren → Afsluiten). Dan telt hij mee in het winstaandeel.
            {legalForm === 'cv' && ' Een commanditaire vennoot deelt in de winst, maar is voor de inkomstenbelasting geen ondernemer: geen ondernemersaftrek en geen urencriterium. Verlies draagt hij niet verder dan zijn eigen vermogen; het meerdere gaat naar de beherende vennoten.'}
          </p>
          {partners.length > 0 && (
            <p className="bk-muted">
              {showHours
                ? `Het urencriterium geldt per vennoot: ten minste 1225 uur in ${hoursYear}, directe en indirecte uren samen. Koppel elke vennoot aan zijn teamlid; dan tellen de uren die hij bij Uren schrijft hier mee. Daarnaast moet een vennoot meer dan de helft van zijn werktijd aan de onderneming besteden, tenzij hij starter is. Indicatief, geen fiscaal advies.`
                : 'Het urencriterium geldt per vennoot. Koppel elke vennoot aan zijn teamlid; met leesrecht op Uren zie je hier dan ieders uren.'}
            </p>
          )}
        </div>
      )}

      {/* ── Kapitaalvergelijking ── */}
      {loading ? <div className="bk-report-loading"><Skeleton lines={5} /></div> : !overview ? (
        years.length === 0
          ? <div className="bk-setup">
              <div><strong>Nog geen boekjaar.</strong><p>De kapitaalvergelijking gaat per boekjaar. Open het boekjaar vanaf de start van je boekhouding{data.companySettings?.bookkeeping_start_date ? ` (${data.companySettings.bookkeeping_start_date.split('-').reverse().join('-')})` : ''}.</p></div>
              {canWrite && <Button variant="primary" disabled={busy} onClick={() => void setUp()}>{busy ? 'Bezig…' : 'Boekjaar openen'}</Button>}
            </div>
          : <p className="bk-muted">Kies een boekjaar.</p>
      ) : (
        <div className="bk-report">
          <div className="bk-report-bar">
            <div className="bk-report-kpis">
              <div><span>{overview.resultCents >= 0 ? 'Winst' : 'Verlies'} {overview.fiscalYear.label}</span><strong className={overview.resultCents < 0 ? 'bk-neg' : ''}>{euroCents(Math.abs(overview.resultCents))}</strong></div>
              <div><span>Privé-opnamen</span><strong>{euroCents(totals.withdrawals)}</strong></div>
              <div><span>Eigen vermogen eind</span><strong>{euroCents(totals.end + (unassigned?.endCents ?? 0))}</strong></div>
            </div>
            <span className={`status-pill ${overview.fiscalYear.status === 'closed' ? 'bk-je-posted' : 'bk-status-draft'}`}>
              {overview.fiscalYear.status === 'closed' ? 'Afgesloten' : 'Voorlopig'}
            </span>
            {/* Voor de boekhouder: hij nam de kapitaalvergelijking over van het scherm. */}
            <Button onClick={() => downloadCsv(`kapitaalvergelijking-${overview.fiscalYear.label.replace(/[^0-9A-Za-z-]+/g, '-')}.csv`, EQUITY_CSV_HEADER, equityCsvRows(overview))}>
              <Download size={14} /> CSV
            </Button>
          </div>

          {/* De verdeling van dit boekjaar: vastgelegd, of die van de vennoten
              nu. Aanpassen kan zolang het jaar open is, met hetzelfde venster
              als bij Boekjaren → Afsluiten. */}
          {vofView && (
            <div className="bk-split-head bk-split-status">
              <div>
                <strong>Verdeling {yearLabel}</strong><span className="bk-muted"> · {splitSourceLabel(overview)}</span>
                {!yearOpen && overview.splitFixed && <div className="bk-muted bk-split-sub">Moet die anders, heropen {yearLabel} dan eerst bij Boekjaren.</div>}
              </div>
              {yearOpen && canWrite && partners.length > 0 && (
                <Button onClick={() => { setMessage(null); setSplitOpen(true); }} disabled={busy}><Pencil size={13} /> Verdeling aanpassen</Button>
              )}
            </div>
          )}
          {changed.length > 0 && (
            <p className="bk-note bk-split-warn" role="alert">
              <AlertTriangle size={13} aria-hidden="true" /> Na {overview.fiscalYear.periodEnd.split('-').reverse().join('-')} zijn de vennoten of hun verdeling gewijzigd ({changed.join(', ')}).
              {' '}De bedragen hieronder rekenen met de verdeling van nu, en die kan voor {yearLabel} niet kloppen. Leg de verdeling van {yearLabel} vast; afsluiten kan pas daarna.
            </p>
          )}
          {vofView && !overview.isPartnership && unassignedResult !== 0 && (
            <p className="bk-note">
              <AlertTriangle size={13} aria-hidden="true" /> {overview.resultCents >= 0 ? 'Winst' : 'Verlies'} {yearLabel}: niet verdeeld, er doet geen vennoot mee in de verdeling.
              {' '}Het staat hieronder bij "nog niet toegewezen"{yearOpen ? ' en gaat bij het afsluiten naar de resultaatrekening, bij geen enkele vennoot' : ''}.
            </p>
          )}
          {/* Een jaar met perioden: per periode wie meedeed en wat hij kreeg
              (20261124120000). Daaronder het totaal per vennoot. */}
          {vofView && overview.isPartnership && (
            <SplitPeriods overview={overview} onPartnersPage canEdit={yearOpen && canWrite && partners.length > 0} />
          )}
          {/* Treedt Bram per 1 juli uit en blijft Anna op 50%, dan telt de
              tweede helft op tot 50% en weigert de jaarafsluiting. Dat zag je
              pas bij het afsluiten; nu hier, met wat je eraan doet. */}
          {vofView && yearOpen && (() => {
            const problem = periodProblem(overview);
            if (!problem) return null;
            const when = periodLabel(problem.period.periodStart, problem.period.periodEnd);
            return (
              <p className="bk-note bk-split-warn" role="alert">
                <AlertTriangle size={13} aria-hidden="true" /> {problem.period.shares.length === 0
                  ? `Van ${when} doet geen vennoot mee, dus het resultaat van die periode kan nergens heen.`
                  : `De verdeling van ${when} telt op tot ${pct(problem.total)}; dat moet precies 100% zijn.`}
                {' '}Geef de vennoten per {dayLabel(problem.period.periodStart)} een percentage dat samen 100% is (het potlood bij de vennoot, met die datum), of leg met Verdeling aanpassen een verdeling voor heel {yearLabel} vast. Afsluiten kan pas daarna.
              </p>
            );
          })()}

          <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr>
              <th>{vofView ? 'Vennoot' : 'Ondernemer'}</th>
              <th className="bk-num">Begin</th>
              <th className="bk-num">{vofView ? 'Winstaandeel' : 'Resultaat'}</th>
              <th className="bk-num">Stortingen</th>
              <th className="bk-num">Opnamen</th>
              <th className="bk-num">Overig</th>
              {showToCurrent && <th className="bk-num">Naar rekening-courant</th>}
              <th className="bk-num">Eind</th>
            </tr></thead>
            <tbody>
              {owners.map(o => {
                const joinedInYear = o.joinedOn && o.joinedOn > overview.fiscalYear.periodStart && o.joinedOn <= overview.fiscalYear.periodEnd ? o.joinedOn : null;
                const toCurrent = o.toCurrentAccountCents ?? 0;
                return (
                  <tr key={o.partnerId ?? 'owner'} className={o.isActive ? '' : 'is-reversed'}>
                    <td><strong>{o.name}</strong>
                      {/* Het percentage van dít jaar, niet dat van nu. */}
                      {vofView && o.partnerId && (o.inSplit === false
                        ? <span className="bk-muted"> · doet niet mee in {yearLabel}</span>
                        : <span className="bk-muted"> · {pct(o.shareBasisPoints)}</span>)}
                      {/* Wie in dit jaar toe- of uittrad, met de datum: zo lees je
                          het winstaandeel als dat van een deel van het jaar. */}
                      {(joinedInYear || o.leftOn) && (
                        <div className="bk-muted bk-split-sub">
                          {[joinedInYear && `sinds ${dayLabel(joinedInYear)}`, o.leftOn && `uitgetreden per ${dayLabel(o.leftOn)}`].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="bk-num">{euroCents(o.beginCents)}</td>
                    <td className="bk-num">{euroCents(o.resultShareCents)}
                      {(o.priorShareCents ?? 0) !== 0 && <div className="bk-muted bk-split-sub">waarvan vooraf {euroCents(o.priorShareCents)}</div>}
                    </td>
                    <td className="bk-num">{euroCents(o.contributionsCents)}</td>
                    {/* Zonder opnamen stond er "€ -0,00". */}
                    <td className="bk-num">{euroCents(o.withdrawalsCents ? -o.withdrawalsCents : 0)}</td>
                    <td className="bk-num">{o.otherMovementsCents ? euroCents(o.otherMovementsCents) : '—'}</td>
                    {/* Eraf, net als de opnamen: het eind is wat er daarna op zijn kapitaal staat. */}
                    {showToCurrent && (
                      <td className="bk-num">{toCurrent ? euroCents(-toCurrent) : '—'}
                        {toCurrent !== 0 && yearOpen && <div className="bk-muted bk-split-sub">bij afsluiten</div>}
                      </td>
                    )}
                    <td className="bk-num"><strong>{euroCents(o.endCents)}</strong></td>
                  </tr>
                );
              })}
              {unassigned && (unassigned.beginCents !== 0 || unassigned.movementsCents !== 0 || unassignedResult !== 0 || openPrior === 0) && (
                <tr className="bk-balance-sub">
                  <td>Nog niet aan een vennoot toegewezen</td>
                  <td className="bk-num">{euroCents(unassigned.beginCents)}</td>
                  <td className="bk-num">{unassignedResult ? euroCents(unassignedResult) : '—'}</td><td className="bk-num">—</td><td className="bk-num">—</td>
                  <td className="bk-num">{unassigned.movementsCents ? euroCents(unassigned.movementsCents) : '—'}</td>
                  {showToCurrent && <td className="bk-num">—</td>}
                  <td className="bk-num"><strong>{euroCents(unassignedEnd)}</strong></td>
                </tr>
              )}
              {openPrior !== 0 && (
                <tr className="bk-balance-sub bk-open-prior">
                  <td>{openPrior >= 0 ? 'Winst' : 'Verlies'} van {(overview.openPriorYears ?? []).join(', ') || 'een vorig jaar'}, nog niet verdeeld
                    <div className="bk-muted bk-split-sub">{(overview.openPriorYears?.length ?? 0) > 1 ? 'Die jaren staan open' : `${overview.openPriorYears?.[0] ?? 'Dat jaar'} staat open`}</div>
                  </td>
                  <td className="bk-num">{euroCents(openPrior)}</td>
                  <td className="bk-num">—</td><td className="bk-num">—</td><td className="bk-num">—</td><td className="bk-num">—</td>
                  {showToCurrent && <td className="bk-num">—</td>}
                  <td className="bk-num"><strong>{euroCents(openPrior)}</strong></td>
                </tr>
              )}
            </tbody>
            {(owners.length > 1 || unassigned) && (
              <tfoot><tr className="bk-report-result">
                <td>Totaal</td>
                <td className="bk-num">{euroCents(totals.begin + (unassigned?.beginCents ?? 0) + openPrior)}</td>
                <td className="bk-num">{euroCents(totals.result + unassignedResult)}</td>
                <td className="bk-num">{euroCents(totals.contributions)}</td>
                <td className="bk-num">{euroCents(totals.withdrawals ? -totals.withdrawals : 0)}</td>
                <td className="bk-num">{euroCents(totals.other + (unassigned?.movementsCents ?? 0))}</td>
                {showToCurrent && <td className="bk-num">{euroCents(-totals.toCurrent)}</td>}
                <td className="bk-num">{euroCents(totals.end + (unassigned?.endCents ?? 0))}</td>
              </tr></tfoot>
            )}
          </table></div>

          {/* De rekening-courant per vennoot (141n): een schuld van de vof aan
              hem, of een vordering op hem. Geen eigen vermogen, dus niet in de
              tabel hierboven; wel wat hij in zijn aangifte als vordering op de
              vof (of schuld) opgeeft. */}
          {vofView && currentAccounts.length > 0 && (
            <div className="bk-rc-list">
              <strong>Rekening-courant eind {yearLabel}</strong>
              {currentAccounts.map(o => {
                const now = o.currentAccountCents ?? 0;
                const after = now + (o.toCurrentAccountCents ?? 0);
                const code = o.currentAccountId ? accountCode.get(o.currentAccountId) : null;
                const balance = (cents: number) => (cents > 0 ? `schuld aan ${o.name} ${euroCents(cents)}`
                  : cents < 0 ? `vordering op ${o.name} ${euroCents(-cents)}` : 'nul, verrekend');
                return (
                  <p key={o.partnerId ?? o.name}>
                    <span className="bk-muted">{o.name}{code ? ` · ${code}` : ''}:</span> {yearOpen && (o.toCurrentAccountCents ?? 0) !== 0
                      ? <>nu {balance(now)}; na het afsluiten {balance(after)}</>
                      : balance(now)}
                  </p>
                );
              })}
            </div>
          )}
          {vofView && <LossShiftNote overview={overview} />}

          {unassigned && (unassigned.beginCents !== 0 || unassigned.movementsCents !== 0) && (
            <p className="bk-muted">
              Een deel van het eigen vermogen staat op 0500, 0510 of de algemene privérekeningen (0550/0560) en dus op geen enkele vennoot, bijvoorbeeld de sluitpost
              van een beginbalans van vóór de vennoten.
              {unassigned.beginCents !== 0 && (openingYear && openingYear.status === 'closed'
                ? ` Komt het uit de beginbalans: die hoort bij boekjaar ${openingYear.label}, en dat is afgesloten. Heropen ${openingYear.label} eerst bij Boekjaren (eigenaar of beheerder), corrigeer dan de beginbalans bij Grootboek → Beginbalans met Regel per vennoot, en sluit ${openingYear.label} weer af.`
                : ` Komt het uit de beginbalans, corrigeer die dan bij Grootboek → Beginbalans → Beginbalans corrigeren: met Regel per vennoot zet je het kapitaal van elke vennoot op zijn eigen kapitaalrekening.`)}
              {unassigned.movementsCents !== 0 && ` Wat er in ${yearLabel} op 0550/0560 is geboekt, hoort bij een vennoot: boek het om naar zijn eigen privérekening (055n of 056n) met een memoriaal bij Grootboek → Journaal.`}
            </p>
          )}
          {(overview.openPriorYears?.length ?? 0) > 0 && (
            <p className="bk-note">
              <AlertTriangle size={13} /> {overview.openPriorYears!.length === 1 ? `Boekjaar ${overview.openPriorYears![0]} is` : `De boekjaren ${overview.openPriorYears!.join(', ')} zijn`} nog niet afgesloten.
              {vofView
                ? ` De voorlopige winst daarvan (${euroCents(overview.openPriorResultCents ?? openPrior)}) staat hierboven apart: die gaat bij het afsluiten naar de vennoten, volgens de verdeling van dat jaar. Verdeel hem niet zelf met een memoriaal, anders krijgen de vennoten hem twee keer.`
                : ` Het beginvermogen telt de voorlopige winst daarvan mee (${euroCents(overview.openPriorResultCents ?? 0)}).`}
              {' '}Sluit {overview.openPriorYears!.length === 1 ? 'dat jaar' : 'die jaren'} af bij Boekjaren zodra de cijfers vaststaan, bijvoorbeeld na je aangifte.
            </p>
          )}
          {overview.fiscalYear.status !== 'closed' && (
            <p className="bk-muted">Het boekjaar loopt nog of is nog niet afgesloten: de {vofView ? 'winstaandelen zijn' : 'winst is'} voorlopig, op basis van wat er nu geboekt is.</p>
          )}
          {lateStart && (
            <p className="bk-note">
              <AlertTriangle size={13} aria-hidden="true" /> Je boekhouding in ResoFly begint op {Number(lateStart.slice(8, 10))} {MONTHS[Number(lateStart.slice(5, 7)) - 1]} {calendarYear}: de winstaandelen hierboven tellen de winst vanaf die dag.
              {' '}Had de {legalFormWord(overview.legalForm)} eerder in {calendarYear} al winst, dan hoort het deel van elke vennoot ook in zijn aangifte. Tel het erbij bij Financiën → Inkomstenbelasting, onder Fiscale correcties (soort "Overige correctie"); anders valt de raming te laag uit.
            </p>
          )}
          <p className="bk-muted">
            {vofView
              ? 'Elke vennoot geeft zijn eigen winstaandeel aan in zijn aangifte inkomstenbelasting en moet zelf aan het urencriterium voldoen voor de ondernemersaftrek. Boek wat een vennoot opneemt op zijn eigen privé-opnamenrekening (055n) en wat hij inbrengt op zijn privé-stortingenrekening (056n).'
              : 'Boek geld dat je voor jezelf opneemt op 0550 Privé-opnamen en geld dat je inbrengt op 0560 Privé-stortingen, ook bij de bank. Bij de jaarafsluiting gaan ze naar 0500 Eigen vermogen. Begin- en eindvermogen heb je nodig in je aangifte inkomstenbelasting; de winst volgt uit de vergelijking van die twee, plus de opnamen en min de stortingen.'}
          </p>
          {/* Tot 24 november 2026 kon een lening alleen op privé, en verdween
              ze bij de jaarafsluiting in het kapitaal: dan stond een schuld van
              de vof als eigen vermogen op de balans. */}
          {vofView && (
            <p className="bk-muted">
              Leent een vennoot geld aan de {legalFormWord(overview.legalForm)} of leent hij ervan, of betaal je een uitgetreden vennoot zijn kapitaal uit, boek dat dan op zijn rekening-courant (141n), niet op privé:
              privé gaat bij de jaarafsluiting naar zijn kapitaal, de rekening-courant blijft staan als schuld of vordering. Rente op een lening van een vennoot is voor de belasting geen kost maar
              winstverdeling: leg die vast als bedrag vooraf in de verdeling van het boekjaar (Verdeling aanpassen).
            </p>
          )}
        </div>
      )}

      {/* De raming hoort bij een eenmanszaak-jaar: na de overstap van vof naar
          eenmanszaak toonde 2025 anders de raming van één persoon over de winst
          van de vof. */}
      {overview && !overview.isPartnershipForm && (
        <IncomeTaxSection data={data} organizationId={organizationId} overview={overview} onOpenIncomeTax={onOpenIncomeTax} />
      )}

      {splitOpen && overview && (
        <SplitDialog
          organizationId={organizationId}
          overview={overview}
          partners={partners}
          canWrite={canWrite}
          onClose={() => setSplitOpen(false)}
          onSaved={text => { setSplitOpen(false); setMessage(text); void loadOverview(fiscalYearId); }}
        />
      )}

      {dialog && isPartnershipForm && (() => {
        const partner = dialog.partnerId ? partners.find(p => p.id === dialog.partnerId) ?? null : null;
        // Een vennoot die intussen is verwijderd: niets om te tonen.
        if (dialog.partnerId && !partner) return null;
        return (
          <PartnerDialog
            key={dialog.partnerId ?? 'nieuw'}
            organizationId={organizationId}
            legalForm={legalForm}
            partner={partner}
            partners={partners}
            changes={partner ? changesOf(partner.id) : []}
            years={years}
            memberOptions={linkableMembers(partner?.id ?? null)}
            teamMembers={teamMembers}
            currentUserId={currentUserId}
            bookkeepingStart={bookkeepingStart}
            today={today}
            canWrite={canWrite}
            onClose={() => setDialog(null)}
            onSaved={async text => { setDialog(null); await reloadAfterPartnerChange(text); }}
            onChangesChanged={text => reloadAfterPartnerChange(text)}
            onFailed={() => void loadBase()}
          />
        );
      })()}
    </div>
  );
}

/**
 * Het venster van een vennoot: naam, winstaandeel, soort, teamlid, of hij
 * vennoot is, en sinds 20261124120000 de ingangsdatum en zijn standen.
 *
 * Waarom een datum: een vennoot had alleen "actief" of "uitgetreden" en één
 * percentage. Wie halverwege het jaar uittrad, kreeg zo over het hele jaar
 * niets (of alles), en zijn deel moest je zelf uitrekenen en als bedrag vooraf
 * vastleggen. Nu is elke wijziging een stand met de eerste dag waarop hij
 * geldt, en splitst de jaarafsluiting het jaar daarop.
 *
 * Tot 24 november 2026 stond dit formulier onder de tabel; met de standen en
 * de uitleg bij de datum werd het een eigen venster (met de terugknop dicht).
 */
function PartnerDialog({ organizationId, legalForm, partner, partners, changes, years, memberOptions, teamMembers, currentUserId, bookkeepingStart, today, canWrite, onClose, onSaved, onChangesChanged, onFailed }: {
  organizationId: string;
  legalForm: string;
  /** null: een nieuwe vennoot. */
  partner: PartnershipPartner | null;
  partners: PartnershipPartner[];
  /** Zijn standen, oudste eerst. */
  changes: PartnershipPartnerChange[];
  years: FiscalYearListRow[];
  /** Teamleden die je aan deze vennoot kunt koppelen. */
  memberOptions: OrganizationMember[];
  teamMembers: OrganizationMember[];
  currentUserId: UUID | null;
  bookkeepingStart: string | null;
  today: string;
  canWrite: boolean;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  /** Een stand is weggehaald: laad opnieuw, het venster blijft open. */
  onChangesChanged: (message: string) => Promise<void>;
  /** Opslaan mislukte half (een nieuwe vennoot, maar het koppelen niet): laad de lijst opnieuw. */
  onFailed: () => void;
}) {
  // De terugknop van de telefoon sluit het venster, zoals Annuleren.
  useBackStep(true, onClose);
  const cv = legalForm === 'cv';
  const [form, setForm] = useState<PartnerForm>(() => (partner
    ? { name: partner.name, share: bpToField(partner.profit_share_basis_points), kind: partner.kind, isActive: partner.is_active, userId: partner.user_id ?? '', date: '' }
    : { name: '', share: partners.length === 0 ? '50' : '', kind: 'beherend', isActive: true, userId: '', date: '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Vult het venster de datum zelf in (vandaag, bij uittreden), dan haalt het
  // hem ook weer weg als je terugzet naar Actief.
  const [autoDate, setAutoDate] = useState(false);

  // Na het weghalen van een stand staat de vennoot op een andere stand: het
  // formulier volgt, anders sloeg Opslaan de oude stand weer op.
  const standKey = partner ? `${partner.profit_share_basis_points}|${partner.kind}|${partner.is_active}` : '';
  const [shownStand, setShownStand] = useState(standKey);
  if (partner && standKey !== shownStand) {
    setShownStand(standKey);
    setForm(f => ({ ...f, share: bpToField(partner.profit_share_basis_points), kind: partner.kind, isActive: partner.is_active, date: '' }));
    setAutoDate(false);
  }

  const shareBp = parsePercent(form.share);
  const kind: PartnershipPartner['kind'] = cv ? form.kind : 'beherend';
  const who = form.name.trim() || partner?.name || 'de vennoot';
  // Wat deze wijziging is, ten opzichte van zijn laatste stand (zo vergelijkt
  // save_partnership_partner zonder datum ook).
  const action: 'nieuw' | 'uittreden' | 'terug' | 'wijziging' | 'geen' = !partner ? 'nieuw'
    : partner.is_active && !form.isActive ? 'uittreden'
    : !partner.is_active && form.isActive ? 'terug'
    : (shareBp !== null && shareBp !== partner.profit_share_basis_points) || kind !== partner.kind ? 'wijziging'
    : 'geen';
  const dateLabel = { nieuw: 'Vennoot sinds', uittreden: 'Uitgetreden per', terug: 'Weer vennoot per', wijziging: 'Met ingang van', geen: 'Met ingang van' }[action];

  // De eerste vennoten (allemaal vandaag vastgelegd) zijn er zonder datum
  // vanaf het begin van de boekhouding; een latere vanaf vandaag. Zo rekent
  // save_partnership_partner het ook.
  const firstPartners = partners.every(p => !p.created_at || amsterdamDay(p.created_at) >= today);
  const startDay = [today, bookkeepingStart, ...years.map(y => y.period_start)]
    .filter((d): d is string => Boolean(d)).reduce((min, d) => (d < min ? d : min), today);

  // De dag waarop de nieuwe stand ingaat, als die er komt.
  const effective = form.date || (action === 'uittreden' || action === 'terug' ? today : null);
  const lastClosed = years.filter(y => y.status === 'closed').reduce<FiscalYearListRow | null>((last, y) => (!last || y.period_end > last.period_end ? y : last), null);
  // Op of vóór het einde van het laatste afgesloten jaar verandert de tijdlijn
  // niet meer, net als in save_partnership_partner: een stand van eerder loopt
  // door dat jaar heen. Eerst blokkeerde alleen een datum ín een afgesloten jaar.
  const closedYearOf = (day: string) => (lastClosed && day <= lastClosed.period_end ? lastClosed : null);
  const closedYear = effective && action !== 'geen' ? closedYearOf(effective) : null;
  const maxDate = addDays(today, 366);
  // Een correctie zonder datum: ligt zijn laatste stand in of vóór het laatste
  // afgesloten boekjaar, dan wordt het een nieuwe stand vanaf de dag na dat
  // jaar (save_partnership_partner). Eerst corrigeerde hij de stand zelf, en
  // veranderde zo stil de verdeling van een jaar dat al geboekt was.
  const latestStand = changes.length > 0 ? changes[changes.length - 1] : null;
  const correctionFrom = lastClosed && latestStand && latestStand.valid_from <= lastClosed.period_end
    ? { from: addDays(lastClosed.period_end, 1), label: lastClosed.label }
    : null;

  const hint = (() => {
    if (action === 'nieuw') {
      if (form.date) return `${who} doet mee in de verdeling vanaf ${dayLabel(form.date)}.`;
      return firstPartners
        ? `Leeg: vanaf het begin van je boekhouding (${dayLabel(startDay)}).`
        : `Leeg: vanaf vandaag (${dayLabel(today)}).`;
    }
    if (!form.date) {
      if (action === 'uittreden' || action === 'terug') return `Leeg: per vandaag (${dayLabel(today)}).`;
      if (action === 'wijziging') {
        const what = shareBp !== null && shareBp !== partner?.profit_share_basis_points
          ? `${pct(partner?.profit_share_basis_points)} wordt ${pct(shareBp)}`
          : `${kindWord(partner?.kind ?? 'beherend')} wordt ${kindWord(kind)}`;
        // Een correctie raakt geen afgesloten jaar: ligt de stand van nu daarin
        // of ervoor, dan maakt de database een stand vanaf de dag erna.
        if (correctionFrom) {
          return `Leeg: ${what} vanaf ${dayLabel(correctionFrom.from)}. Boekjaar ${correctionFrom.label} is afgesloten en blijft zoals het is. Geldt het pas later, vul die dag dan in.`;
        }
        return `Leeg: een correctie van wat er nu staat (${what}), zonder nieuwe periode. Geldt het pas vanaf een bepaalde dag, vul die dan in.`;
      }
      return correctionFrom
        ? `Wijzig je het winstaandeel of de soort, dan geldt dat vanaf deze datum. Leeg: vanaf ${dayLabel(correctionFrom.from)}, want ${correctionFrom.label} is afgesloten.`
        : 'Wijzig je het winstaandeel of de soort, dan geldt dat vanaf deze datum. Leeg is een correctie van wat er nu staat.';
    }
    const before = standOn(changes, form.date);
    if (!before) return `${who} is dan vennoot vanaf ${dayLabel(form.date)}.`;
    if (before.is_active && !form.isActive) {
      return `De eerste dag dat ${who} geen vennoot meer is: zijn winstaandeel loopt tot en met ${dayLabel(addDays(form.date, -1))}. Bij de jaarafsluiting gaat zijn kapitaal naar zijn rekening-courant, een schuld aan hem.`;
    }
    if (!before.is_active && form.isActive) return `De eerste dag dat ${who} weer meedoet in de verdeling.`;
    if (shareBp !== null && before.share_basis_points !== shareBp) {
      return `Tot en met ${dayLabel(addDays(form.date, -1))} ${pct(before.share_basis_points)}, vanaf ${dayLabel(form.date)} ${pct(shareBp)}.`;
    }
    if (before.kind !== kind) return `Vanaf ${dayLabel(form.date)} is ${who} ${kindWord(kind)} vennoot.`;
    return `Op ${dayLabel(form.date)} stond het al zo: er verandert niets.`;
  })();

  const setStatus = (active: boolean) => {
    if (!partner) return;
    // Uittreden heeft altijd een datum; standaard vandaag.
    if (partner.is_active && !active && !form.date) { setForm({ ...form, isActive: active, date: today }); setAutoDate(true); return; }
    if (active === partner.is_active && autoDate) { setForm({ ...form, isActive: active, date: '' }); setAutoDate(false); return; }
    setForm({ ...form, isActive: active });
  };

  async function save() {
    setBusy(true); setError(null);
    try {
      if (!form.name.trim()) throw new Error('Geef de vennoot een naam.');
      if (shareBp === null) throw new Error('Vul het winstaandeel in als percentage tussen 0 en 100.');
      const saved = await savePartnershipPartner(organizationId, {
        id: partner?.id ?? null, name: form.name.trim(), profitShareBasisPoints: shareBp, kind, isActive: form.isActive,
        effectiveDate: form.date || null,
      });
      const wantedUser = form.userId || null;
      if ((saved.user_id ?? null) !== wantedUser) await setPartnershipPartnerMember(organizationId, saved.id, wantedUser);
      const name = form.name.trim();
      const text = action === 'nieuw' ? `${name} is vastgelegd, met eigen kapitaal-, privé- en rekening-courantrekeningen.`
        : action === 'uittreden' ? `${name} is uitgetreden per ${dayLabel(effective ?? today)}. Geef de vennoten die blijven per die dag een percentage dat samen 100% is.`
        : action === 'terug' ? `${name} is weer vennoot per ${dayLabel(effective ?? today)}.`
        : action === 'wijziging' ? ((form.date || correctionFrom?.from)
          ? `${name}: ${pct(shareBp)}${cv ? `, ${kindWord(kind)}` : ''} vanaf ${dayLabel(form.date || correctionFrom?.from || today)}.`
          : `${name}: gecorrigeerd naar ${pct(shareBp)}${cv ? `, ${kindWord(kind)}` : ''}.`)
        : 'Vennoot bijgewerkt.';
      await onSaved(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
      // Een nieuwe vennoot kan al bestaan als alleen het koppelen misging.
      onFailed();
    } finally { setBusy(false); }
  }

  async function removeChange(change: PartnershipPartnerChange, previous: PartnershipPartnerChange | null) {
    const back = previous ? changeLabel(previous, null, cv).replace(/^sinds [^:]+: /, '') : '';
    if (!confirm(`De wijziging "${changeLabel(change, previous, cv)}" weghalen? Dan geldt ${previous?.is_active ? `weer ${back}` : 'weer de stand ervoor'}.`)) return;
    setBusy(true); setError(null);
    try {
      await deletePartnershipPartnerChange(organizationId, change.id);
      await onChangesChanged(`De wijziging van ${dayLabel(change.valid_from)} is weggehaald.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Weghalen mislukt'); }
    finally { setBusy(false); }
  }

  return (
    <div className="bk-modal-backdrop" onClick={onClose}>
      <div className="bk-modal bk-modal-split bk-partner-dialog" role="dialog" aria-label={partner ? `${partner.name} aanpassen` : 'Vennoot toevoegen'} onClick={e => e.stopPropagation()}>
        <h3>{partner ? `${partner.name} aanpassen` : 'Vennoot toevoegen'}</h3>
        <div className="bk-modal-body">
          <div className="bk-fy-new-fields">
            <label><span>Naam</span><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Naam van de vennoot" /></label>
            <label><span>Winstaandeel (%)</span><Input inputMode="decimal" value={form.share} onChange={e => setForm({ ...form, share: e.target.value })} placeholder="50" /></label>
            {cv && (
              <label><span>Soort</span>
                <Select aria-label="Soort" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as PartnershipPartner['kind'] })}>
                  <option value="beherend">Beherend vennoot</option>
                  <option value="commanditair">Commanditaire (stille) vennoot</option>
                </Select>
              </label>
            )}
            <label><span>Teamlid</span>
              <Select aria-label="Teamlid" value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}>
                <option value="">Niet gekoppeld</option>
                {form.userId && !teamMembers.some(m => m.user_id === form.userId) && (
                  <option value={form.userId}>Teamlid (niet meer in de organisatie)</option>
                )}
                {memberOptions.map(m => (
                  <option key={m.user_id} value={m.user_id}>{memberName(m.user_id, teamMembers, currentUserId)}</option>
                ))}
              </Select>
            </label>
            {partner && (
              <label><span>Status</span>
                <Select aria-label="Status" value={form.isActive ? 'actief' : 'uit'} onChange={e => setStatus(e.target.value === 'actief')}>
                  <option value="actief">Vennoot</option>
                  <option value="uit">Uitgetreden</option>
                </Select>
              </label>
            )}
            <label className="bk-partner-date"><span>{dateLabel}</span>
              <Input type="date" value={form.date} max={maxDate} aria-describedby="bk-partner-date-hint"
                onChange={e => { setForm({ ...form, date: e.target.value }); setAutoDate(false); }} />
            </label>
          </div>
          <p id="bk-partner-date-hint" className="bk-muted bk-partner-date-hint">{hint}</p>
          {closedYear && (
            <p className="bk-neg"><AlertTriangle size={13} aria-hidden="true" /> Boekjaar {closedYear.label} is afgesloten, met de verdeling die toen gold.
              {' '}Kies een datum na {dayLabel(closedYear.period_end)}, of heropen {closedYear.label} eerst bij Boekjaren.</p>
          )}

          {partner && changes.length > 0 && (
            <div className="bk-partner-timeline">
              <span className="bk-partner-timeline-head">Standen</span>
              <ul>
                {changes.map((change, i) => {
                  const previous = i > 0 ? changes[i - 1] : null;
                  const closed = closedYearOf(change.valid_from);
                  return (
                    <li key={change.id} className={change.valid_from > today ? 'is-future' : ''}>
                      <span>{changeLabel(change, previous, cv)}{change.valid_from > today && <span className="bk-muted"> · nog niet ingegaan</span>}</span>
                      {/* De eerste stand haal je niet weg: dan was hij nooit vennoot. */}
                      {i > 0 && canWrite && (
                        <button type="button" className="bk-icon-btn" disabled={busy || Boolean(closed)}
                          title={closed ? `Valt in boekjaar ${closed.label}, en dat is afgesloten` : 'Deze wijziging weghalen'}
                          aria-label={`Wijziging van ${dayLabel(change.valid_from)} weghalen`}
                          onClick={() => void removeChange(change, previous)}>
                          <Trash2 size={14} /></button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {changes.length > 1 && <p className="bk-muted">Een verkeerde wijziging haal je weg met de prullenbak; dan geldt de stand ervoor weer.</p>}
            </div>
          )}
          {error && <div className="error bk-modal-error">{error}</div>}
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}><X size={14} /> Annuleren</Button>
          <Button variant="primary" disabled={busy || Boolean(closedYear)} title={closedYear ? `Boekjaar ${closedYear.label} is afgesloten` : undefined} onClick={() => void save()}>
            <Save size={14} /> {busy ? 'Bezig…' : 'Opslaan'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "Verdeling aanpassen" op Vennoten: hetzelfde formulier als in het afsluitvenster bij Boekjaren. */
function SplitDialog({ organizationId, overview, partners, canWrite, onClose, onSaved }: {
  organizationId: string; overview: OwnersEquityOverview; partners: PartnershipPartner[]; canWrite: boolean;
  onClose: () => void; onSaved: (message: string) => void;
}) {
  // De terugknop van de telefoon sluit het venster, zoals Annuleren.
  useBackStep(true, onClose);
  return (
    <div className="bk-modal-backdrop" onClick={onClose}>
      <div className="bk-modal bk-modal-split" role="dialog" aria-label={`Verdeling ${overview.fiscalYear.label} aanpassen`} onClick={e => e.stopPropagation()}>
        <h3>Verdeling {overview.fiscalYear.label} aanpassen</h3>
        <div className="bk-modal-body">
          <YearSplitPanel organizationId={organizationId} overview={overview} partners={partners} canWrite={canWrite}
            editing onEditingChange={value => { if (!value) onClose(); }} onSaved={onSaved} />
        </div>
      </div>
    </div>
  );
}

/**
 * Van winst naar belastbare winst uit onderneming, voor de aangifte
 * inkomstenbelasting van een eenmanszaak. Bij een vof doet elke vennoot dit
 * zelf over zijn winstaandeel; dat staat bij Financiën → Inkomstenbelasting.
 *
 * Dit blok rekent niet zelf: het toont de regels van de raming
 * (get_income_tax_inputs + buildIncomeTaxOverview, geboekt), met wat daar is
 * opgeslagen. Tot november 2026 rekende het hier apart (lib/incomeTax.ts), met
 * de uren die de app zelf had geladen en een eigen startervinkje dat nergens werd
 * bewaard, zonder KIA en zonder fiscale correcties. Wie bij Inkomstenbelasting
 * "urencriterium ja" en "starter" had opgeslagen, zag daar bij € 45.000 winst
 * een belastbare winst van € 36.384,02 en hier € 39.285,00, onder een tekst
 * die "tot op de cent gelijk" beloofde.
 */
function IncomeTaxSection({ data, organizationId, overview, onOpenIncomeTax }: {
  data: AppData; organizationId: string; overview: OwnersEquityOverview; onOpenIncomeTax?: () => void;
}) {
  const year = Number(overview.fiscalYear.periodStart.slice(0, 4));
  const hasRules = incomeTaxRulesFor(year) !== null;
  const [loaded, setLoaded] = useState<{ inputs: IncomeTaxInputs | null; error: string | null } | null>(null);

  // Opnieuw bij elk nieuw overzicht (een ander boekjaar, of na een wijziging):
  // de winst hierboven en de raming hieronder horen bij hetzelfde moment.
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    if (!hasRules) return undefined;
    loadIncomeTaxInputs(organizationId, year)
      .then(inputs => { if (!cancelled) setLoaded({ inputs, error: null }); })
      .catch(e => { if (!cancelled) setLoaded({ inputs: null, error: e instanceof Error ? e.message : 'De raming laden mislukt' }); });
    return () => { cancelled = true; };
  }, [organizationId, year, hasRules, overview]);

  const today = formatISODate(new Date());
  const ib = useMemo(() => (loaded?.inputs ? buildIncomeTaxOverview(loaded.inputs, { basis: 'geboekt', today }) : null), [loaded, today]);
  const hasMixedAccount = useMemo(() => data.ledgerAccounts.some(a => a.subtype === 'mixed_costs'), [data.ledgerAccounts]);

  const where = onOpenIncomeTax
    ? <Button onClick={onOpenIncomeTax}>Naar Inkomstenbelasting</Button>
    : null;

  if (!hasRules) {
    return (
      <div className="bk-report">
        <div className="bk-report-bar">
          <div className="bk-report-kpis">
            <div><span>Voor je aangifte inkomstenbelasting {year}</span><strong>—</strong></div>
          </div>
        </div>
        <p className="bk-muted">De bedragen voor {year} (zelfstandigenaftrek, mkb-winstvrijstelling, de drempel voor gemengde kosten) staan nog niet in ResoFly. De winst en het eigen vermogen hierboven kun je wel gebruiken.</p>
      </div>
    );
  }
  if (!loaded) return <div className="bk-report-loading"><Skeleton lines={4} /></div>;
  const person = ib?.persons[0] ?? null;
  // De regels waarmee de raming rekende (voor een jaar na de laatste tabel
  // met de zelfstandigenaftrek van dat jaar), niet de kale tabel van rulesYear.
  const rules = ib ? incomeTaxRulesFor(ib.year)?.rules ?? null : null;
  if (!ib || !person || !rules) {
    return (
      <div className="bk-report">
        <p className="bk-muted">De berekening voor je aangifte inkomstenbelasting {year} kon niet worden geladen{loaded.error ? `: ${loaded.error}` : '.'} Je vindt hem bij Financiën → Inkomstenbelasting.</p>
        {where && <div className="bk-fy-new-actions">{where}</div>}
      </div>
    );
  }

  const { profile, estimate: e } = person;
  const meets = profile.meetsHoursCriterion;
  const hours = person.registeredMinutes === null ? null : Math.floor(person.registeredMinutes / 60).toLocaleString('nl-NL');
  const row = (key: string, label: React.ReactNode, cents: number, sign: '' | '+' | '−' | '=' = '', strong = false) => (
    <tr className={strong ? 'bk-report-total' : ''} key={key}>
      <td>{sign && <span className="bk-muted">{sign} </span>}{label}</td>
      <td className="bk-num">{euroCents(cents)}</td>
    </tr>
  );
  const zaHint = meets === null ? '(urencriterium niet ingevuld)'
    : !meets ? '(urencriterium niet gehaald)'
    : profile.aowStatus === 'heel_jaar' ? '(de helft, AOW-leeftijd)'
    : e.zelfstandigenaftrekUnusedCents > 0 ? '(niet hoger dan de winst)' : '';
  // Dezelfde regels als de tabel hieronder, om te bewaren of door te sturen.
  const csvLines: IncomeTaxSummaryLine[] = [
    { label: 'Winst volgens je boekhouding', cents: e.profitShareCents },
    ...person.corrections.map(c => ({ label: c.label, cents: Math.abs(c.amountCents), sign: (c.amountCents < 0 ? '−' : '+') as IncomeTaxSummaryLine['sign'] })),
    ...(e.kiaCents > 0 ? [{ label: 'Investeringsaftrek (KIA)', cents: e.kiaCents, sign: '−' as const }] : []),
    { label: 'Winst uit onderneming', cents: e.profitCents, sign: '=' },
    { label: `Zelfstandigenaftrek ${zaHint}`.trim(), cents: e.zelfstandigenaftrekCents, sign: '−' },
    ...(profile.starter || e.startersaftrekCents > 0 ? [{ label: 'Startersaftrek', cents: e.startersaftrekCents, sign: '−' as const }] : []),
    ...(e.otherEntrepreneurDeductionCents > 0 ? [{ label: 'Overige ondernemersaftrek', cents: e.otherEntrepreneurDeductionCents, sign: '−' as const }] : []),
    { label: `Mkb-winstvrijstelling (${formatRate(rules.mkbExemptionRate)})`, cents: Math.abs(e.mkbExemptionCents), sign: e.mkbExemptionCents < 0 ? '+' : '−' },
    { label: 'Belastbare winst uit onderneming', cents: e.taxableProfitCents, sign: '=' },
  ];
  const exportCsv = () => downloadCsv(`aangifte-ib-${year}.csv`, INCOME_TAX_SUMMARY_CSV_HEADER, incomeTaxSummaryCsvRows(csvLines));

  return (
    <div className="bk-report">
      <div className="bk-report-bar">
        <div className="bk-report-kpis">
          <div><span>Voor je aangifte inkomstenbelasting {year}</span><strong>{euroCents(e.taxableProfitCents)}</strong></div>
          <div><span>Urencriterium {year}</span>{/* De uren alleen als het urencriterium ze volgt: "200 / 1.225 uur" in het groen naast een zelf gekozen ja las als een fout. */}
            <strong className={meets ? 'bk-pos' : ''}>{person.hoursFromTimeTracking && hours !== null ? `${hours} / 1.225 uur` : meets === null ? '—' : meets ? 'Ja, zelf gekozen' : 'Nee, zelf gekozen'}</strong></div>
        </div>
        <Button onClick={exportCsv}><Download size={14} /> CSV</Button>
        {where}
      </div>

      {ib.warnings.map(w => <p key={w} className="bk-note ib-warning"><AlertTriangle size={13} aria-hidden="true" /> {w}</p>)}

      <div className="bk-table-wrap"><table className="bk-table bk-report-table bk-ib-table">
        <tbody>
          {row('winst', 'Winst volgens je boekhouding', e.profitShareCents)}
          {/* Een correctie kan de winst verhogen of verlagen: het teken ervoor, het bedrag positief. */}
          {person.corrections.map(c => row(c.id,
            <>{c.label}<span className="bk-muted"> · {c.automatic ? 'uit rekening 4600, niet aftrekbaar' : IB_CORRECTION_LABELS[c.code] ?? c.code}</span></>,
            Math.abs(c.amountCents), c.amountCents < 0 ? '−' : '+'))}
          {e.kiaCents > 0 && row('kia', <>Investeringsaftrek (KIA)<span className="bk-muted"> · over {euroCents(ib.investmentTotalCents)} aan investeringen</span></>, e.kiaCents, '−')}
          {row('winst-uit-onderneming', 'Winst uit onderneming', e.profitCents, '=', true)}
          {/* Aftrekposten positief, met het minteken ervoor: "− € 1.200", niet "− € -1.200". */}
          {row('zelfstandigenaftrek', <>Zelfstandigenaftrek {zaHint}</>, e.zelfstandigenaftrekCents, '−')}
          {(profile.starter || e.startersaftrekCents > 0) && row('startersaftrek',
            <>Startersaftrek {meets !== true ? '(alleen met het urencriterium)' : profile.aowStatus === 'heel_jaar' ? '(de helft, AOW-leeftijd)' : ''}</>, e.startersaftrekCents, '−')}
          {e.otherEntrepreneurDeductionCents > 0 && row('overige-aftrek', 'Overige ondernemersaftrek', e.otherEntrepreneurDeductionCents, '−')}
          {/* Bij een verlies maakt de vrijstelling het verlies kleiner: dan staat er een plus. */}
          {row('mkb', `Mkb-winstvrijstelling (${formatRate(rules.mkbExemptionRate)})${e.mkbExemptionCents < 0 ? ', maakt het verlies kleiner' : ''}`, Math.abs(e.mkbExemptionCents), e.mkbExemptionCents < 0 ? '+' : '−')}
          {row('belastbare-winst', 'Belastbare winst uit onderneming', e.taxableProfitCents, '=', true)}
        </tbody>
      </table></div>

      <p className="bk-muted">
        {person.hoursFromTimeTracking
          ? `Urencriterium volgens Uren: de eigenaar heeft in ${year} ${hours} uur geregistreerd, ${meets ? 'genoeg voor de 1.225 uur' : 'minder dan 1.225'}.`
          : meets === null
            ? 'Het urencriterium is nog niet ingevuld, en de uren van de eigenaar zie je hier alleen met leesrecht op Uren: de zelfstandigenaftrek is daarom niet meegerekend.'
            : `Urencriterium: bij Inkomstenbelasting is zelf ${meets ? 'ja' : 'nee'} gekozen${hours !== null ? `; bij Uren staan ${hours} uur in ${year}` : ''}.`}
        {meets !== true && ' Zonder urencriterium (1.225 uur, en meer dan de helft van je werktijd) geen zelfstandigenaftrek en startersaftrek; de mkb-winstvrijstelling krijg je wel.'}
      </p>
      {/* Een gebroken boekjaar: de kapitaalvergelijking gaat over het boekjaar, de inkomstenbelasting over het kalenderjaar. */}
      {e.profitShareCents !== overview.resultCents && (
        <p className="bk-muted">
          De winst van {year} hier ({euroCents(e.profitShareCents)}) is die van het kalenderjaar; de kapitaalvergelijking hierboven telt boekjaar {overview.fiscalYear.label} ({euroCents(overview.resultCents)}).
        </p>
      )}
      {!hasMixedAccount && !ib.mixedCosts && (
        <p className="bk-muted">Er is geen rekening voor eten, drinken en representatie (4600). Boek je die kosten op een andere rekening, geef het niet-aftrekbare deel dan op als fiscale correctie bij Inkomstenbelasting.</p>
      )}
      <p className="bk-muted">
        Een indicatie{overview.fiscalYear.status !== 'closed' ? ', op basis van wat er nu geboekt is' : ''}: dezelfde berekening als bij Financiën → Inkomstenbelasting, met wat daar is opgeslagen.
        {' '}Het urencriterium, starter, de AOW-leeftijd, wat meetelt voor de KIA en fiscale correcties (zoals de bijtelling voor een auto van de zaak) stel je daar in.
        Daar staat ook wat je aan inkomstenbelasting en Zvw-bijdrage betaalt.
      </p>
    </div>
  );
}
