import { Fragment, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, Plus, RotateCcw, Save, X } from 'lucide-react';
import type { OwnersEquityOverview, OwnersEquityPeriod, PartnershipPartner } from '../types';
import { LEGAL_FORM_LABELS } from '../types';
import { Button, Input, Select } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { parseDutchAmountCents } from '../lib/money';
import { splitByShares } from '../lib/inkomstenbelasting';
import { setFiscalYearPartnerShares } from '../lib/repository';

/**
 * De verdeling van één boekjaar over de vennoten: wat het afsluitvenster bij
 * Boekjaren en de pagina Vennoten allebei tonen en laten aanpassen.
 *
 * Waarom per boekjaar: de jaarafsluiting, de kapitaalvergelijking en de raming
 * lazen tot 22 november 2026 de vennoten en percentages van vandaag. Een
 * vennoot die uittrad vóór het afsluiten van het vorige jaar kreeg niets, een
 * nieuwe vennoot kreeg winst over een jaar waarin hij er niet was, en het
 * overzicht van een afgesloten jaar verschoof zodra je een percentage
 * wijzigde. Een arbeidsbeloning vóór de verdeling kon alleen als memoriaal, en
 * dat kwam onder "Overig" en niet in het winstaandeel dat elke vennoot aangeeft.
 * Zie supabase/migrations/20261122100000_vof_verdeling_per_boekjaar.sql.
 */

export const PARTNERSHIP_FORMS: readonly string[] = ['vof', 'maatschap', 'cv'];
export const IB_FORMS = ['eenmanszaak', 'vof', 'maatschap', 'cv'] as const;
export type IbLegalForm = (typeof IB_FORMS)[number];

export const isPartnershipLegalForm = (form: string | null | undefined) => PARTNERSHIP_FORMS.includes(form ?? '');
export const isIbLegalForm = (form: string | null | undefined): form is IbLegalForm =>
  (IB_FORMS as readonly string[]).includes(form ?? '');

/** De rechtsvorm zoals hij in een zin staat: "sluit af als vof", "nu is het een eenmanszaak". */
export function legalFormWord(form: string | null | undefined): string {
  if (!form) return 'eenmanszaak';
  if (isIbLegalForm(form)) return form;
  return LEGAL_FORM_LABELS[form as keyof typeof LEGAL_FORM_LABELS] ?? form;
}

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
export const pct = (bp: number | null | undefined) => `${((bp ?? 0) / 100).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}%`;

/** "60", "33,33" of "33.33" → basispunten; ongeldig → null. */
export function parsePercent(value: string): number | null {
  const trimmed = value.replace(/\s/g, '').replace('%', '').replace(',', '.');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

const bpToInput = (bp: number) => (bp / 100).toLocaleString('nl-NL', { maximumFractionDigits: 2, useGrouping: false });
const centsToInput = (cents: number) => (cents ? (cents / 100).toFixed(2).replace('.', ',') : '');

const MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/**
 * "1 jan 2025" (of "1 jan" zonder jaar). Zelf, niet met Intl: die schrijft
 * "1 jan. 2025", en in een regel als "1 jan t/m 30 jun 2026" las de punt als
 * het einde van een zin.
 */
export function dayLabel(iso: string, withYear = true): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1] ?? ''}${withYear ? ` ${y}` : ''}`;
}

/** "1 jan t/m 30 jun 2026"; over een jaargrens heen met beide jaren. */
export function periodLabel(start: string, end: string): string {
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${dayLabel(start, false)} t/m ${dayLabel(end)}`
    : `${dayLabel(start)} t/m ${dayLabel(end)}`;
}

/** Valt het jaar uiteen in meer dan één periode (in- of uittreden, een ander percentage met een datum)? */
export function hasPeriods(overview: OwnersEquityOverview): boolean {
  return overview.splitMode === 'automatisch' && (overview.periods?.length ?? 0) > 1;
}

/**
 * De eerste periode die niet op precies 100% uitkomt, of waarin niemand
 * vennoot is. Zo weigert ook de jaarafsluiting (close_fiscal_year), en die
 * noemt dezelfde periode.
 */
export function periodProblem(overview: OwnersEquityOverview): { period: OwnersEquityPeriod; total: number } | null {
  if (!hasPeriods(overview)) return null;
  for (const period of overview.periods ?? []) {
    const total = period.shares.reduce((sum, s) => sum + s.shareBasisPoints, 0);
    if (total !== 10000) return { period, total };
  }
  return null;
}

/** De dag (in Nederland) waarop iets is vastgelegd, als JJJJ-MM-DD. */
function amsterdamDay(timestamp: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date(timestamp));
}

/**
 * Werden alle vennoten pas na het einde van dit jaar vastgelegd (je stapte net
 * over)? Dan weigert de jaarafsluiting niet, maar is de verdeling die van nu.
 */
export function partnersAllAfterYearEnd(partners: PartnershipPartner[], periodEnd: string): boolean {
  return partners.length > 0 && partners.every(p => Boolean(p.created_at) && amsterdamDay(p.created_at) > periodEnd.slice(0, 10));
}

/** Alleen bij een open jaar zonder vastgelegde verdeling: wie er na het jaareinde veranderde. */
export function changedAfterYearEnd(overview: OwnersEquityOverview): string[] {
  if (overview.fiscalYear.status === 'closed' || overview.splitFixed) return [];
  return overview.splitChangedAfterYearEnd ?? [];
}

/** Waar de verdeling van dit jaar vandaan komt, in een paar woorden. */
export function splitSourceLabel(overview: OwnersEquityOverview): string {
  // Sinds 20261124120000 legt de afsluiting van een automatische verdeling een
  // momentopname vast die niet als "vastgelegd" telt (splitFixed is dan
  // false). Hier stond daarom "niet over vennoten verdeeld" bij een jaar dat
  // wél over de vennoten was verdeeld.
  if (overview.fiscalYear.status === 'closed') {
    if (overview.splitFixed) return 'vastgelegd bij het afsluiten';
    return overview.splitMode === 'automatisch' && overview.isPartnership
      ? 'volgens de ingangsdatums, geboekt bij het afsluiten'
      : 'niet over vennoten verdeeld';
  }
  if (overview.splitFixed) return 'vastgelegd voor dit jaar';
  return overview.splitMode === 'automatisch' ? 'volgens de ingangsdatums van de vennoten' : 'die van de vennoten nu';
}

/**
 * Telt de verdeling van dit jaar op tot iets anders dan 100%? (null als er
 * niemand meedoet). Bij perioden: het totaal van de eerste periode die niet
 * klopt, anders 100%. De percentages van alle vennoten van het jaar optellen
 * gaf bij Bram eruit en Chris erin per 1 juli 150%, en dan stond afsluiten uit.
 */
export function splitTotalBasisPoints(overview: OwnersEquityOverview): number | null {
  const inSplit = overview.owners.filter(o => o.inSplit);
  if (inSplit.length === 0) return null;
  if (hasPeriods(overview)) return periodProblem(overview)?.total ?? 10000;
  return inSplit.reduce((sum, o) => sum + o.shareBasisPoints, 0);
}

/** Per vennoot zijn percentages door het jaar heen, in volgorde: [50] of [50, 30]. */
function periodShares(overview: OwnersEquityOverview, partnerId: string | null): number[] {
  const out: number[] = [];
  for (const period of overview.periods ?? []) {
    const share = period.shares.find(s => s.partnerId === partnerId);
    if (share && out[out.length - 1] !== share.shareBasisPoints) out.push(share.shareBasisPoints);
  }
  return out;
}

/**
 * De perioden van een jaar met een automatische verdeling, onder elkaar: wanneer,
 * het resultaat, en per vennoot zijn percentage en deel. Alleen bij meer dan
 * één periode; anders zegt de tabel eronder alles.
 */
export function SplitPeriods({ overview, onPartnersPage = false, canEdit = false }: {
  overview: OwnersEquityOverview;
  /** Op Vennoten staan de ingangsdatums op dezelfde pagina; in het afsluitvenster niet. */
  onPartnersPage?: boolean;
  canEdit?: boolean;
}) {
  if (!hasPeriods(overview)) return null;
  return (
    <div className="bk-split-periods">
      <ol className="bk-split-period-list">
        {(overview.periods ?? []).map(period => (
          <li key={period.periodStart} className="bk-split-period">
            <strong>{periodLabel(period.periodStart, period.periodEnd)}</strong>
            <span className={period.resultCents < 0 ? 'bk-neg' : ''}> · resultaat {euroCents(period.resultCents)}</span>
            {period.shares.length === 0
              ? <span className="bk-neg"> · geen vennoot, niet verdeeld</span>
              // De punt buiten het blok: een spatie aan het begin van een
              // inline-block valt weg, en dan stond er "€ 40.000,00· Anna".
              : period.shares.map(s => (
                  <Fragment key={s.partnerId}>{' · '}<span className="bk-split-period-share">{s.name} {pct(s.shareBasisPoints)} {euroCents(s.shareCents)}</span></Fragment>
                ))}
          </li>
        ))}
      </ol>
      <p className="bk-muted">
        De verdeling volgt uit de ingangsdatums {onPartnersPage ? 'van de vennoten hierboven' : 'bij Vennoten'}: het resultaat van elke periode gaat naar wie toen vennoot was, met het percentage van toen.
        {canEdit && ' Met Verdeling aanpassen leg je een eigen verdeling voor het hele jaar vast; die gaat dan voor.'}
      </p>
    </div>
  );
}

/** "Anna", "Anna en Bram", "Anna, Bram en Chris". */
function joinNL(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} en ${items[items.length - 1]}`;
}

/**
 * De verliesgrens van een cv: een commanditaire vennoot draagt niet meer
 * verlies dan zijn eigen vermogen (art. 20 lid 3 WvK). Het meerdere gaat naar
 * de beherende vennoten; dat staat al in hun winstaandeel, en hier waarom.
 */
export function LossShiftNote({ overview }: { overview: OwnersEquityOverview }) {
  const givers = overview.owners.filter(o => (o.lossShiftCents ?? 0) > 0);
  if (givers.length === 0) return null;
  const takers = overview.owners.filter(o => (o.lossShiftCents ?? 0) < 0);
  return (
    <p className="bk-note bk-loss-shift">
      Een commanditaire vennoot draagt niet meer verlies dan zijn eigen vermogen.
      {' '}{joinNL(givers.map(o => `${o.name} draagt ${euroCents(o.lossShiftCents)} van zijn deel niet`))}; dat gaat naar de beherende vennoten
      {takers.length > 0 ? ` (${joinNL(takers.map(o => `${o.name} ${euroCents(-(o.lossShiftCents ?? 0))}`))})` : ''}.
    </p>
  );
}

/**
 * Wie aan het eind van het jaar geen vennoot meer is: zijn kapitaal gaat bij
 * de jaarafsluiting naar zijn rekening-courant. Tot 24 november 2026 bleef het
 * eigen vermogen, terwijl de vof het hem schuldig is.
 */
export function CurrentAccountTransferNote({ overview }: { overview: OwnersEquityOverview }) {
  const leavers = overview.owners.filter(o => (o.toCurrentAccountCents ?? 0) !== 0);
  if (leavers.length === 0) return null;
  const closed = overview.fiscalYear.status === 'closed';
  return (
    <>
      {leavers.map(o => {
        const cents = o.toCurrentAccountCents ?? 0;
        const who = o.leftOn ? `${o.name} is uitgetreden per ${dayLabel(o.leftOn)}` : `${o.name} is aan het eind van ${overview.fiscalYear.label} geen vennoot meer`;
        return (
          <p key={o.partnerId ?? o.name} className="bk-note bk-rc-note">
            {cents > 0
              ? <>{who}: zijn kapitaal ({euroCents(cents)}) {closed ? 'ging' : 'gaat'} bij het afsluiten naar zijn rekening-courant, een schuld aan hem.</>
              : <>{who}: zijn kapitaal is negatief ({euroCents(cents)}) en {closed ? 'ging' : 'gaat'} bij het afsluiten naar zijn rekening-courant, een vordering op hem.</>}
            {' '}{cents > 0 ? 'Wat je hem uitbetaalt' : 'Wat hij terugbetaalt'}, boek je bij de bank op die rekening-courant, niet op privé.
          </p>
        );
      })}
    </>
  );
}

/**
 * De verdeling van één boekjaar: per vennoot het aandeel, het voorafgaande
 * bedrag en wat er op zijn kapitaal komt, met de meldingen die erbij horen.
 * Met `editing` staat in plaats van de tabel het formulier.
 */
export function YearSplitPanel({ organizationId, overview, partners, canWrite, editing, onEditingChange, onSaved }: {
  organizationId: string;
  overview: OwnersEquityOverview;
  /** Alle vennoten, ook uitgetreden: die kun je aan de verdeling van dit jaar toevoegen. */
  partners: PartnershipPartner[];
  canWrite: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Na opslaan (of terugzetten): laad het overzicht opnieuw. */
  onSaved: (message: string) => void;
}) {
  const year = overview.fiscalYear;
  const open = year.status !== 'closed';
  const inSplit = overview.owners.filter(o => o.inSplit);
  const changed = changedAfterYearEnd(overview);
  const allAfter = open && !overview.splitFixed && inSplit.length > 0 && changed.length === 0
    && partnersAllAfterYearEnd(partners, year.periodEnd);
  const total = splitTotalBasisPoints(overview);
  const priorTotal = inSplit.reduce((sum, o) => sum + (o.priorShareCents ?? 0), 0);
  const shareSum = inSplit.reduce((sum, o) => sum + o.resultShareCents, 0);
  const canEdit = open && canWrite && partners.length > 0;
  const multi = hasPeriods(overview);
  const problem = periodProblem(overview);

  return (
    <div className="bk-split">
      <div className="bk-split-head">
        <div>
          <strong>Verdeling {year.label}</strong>
          <span className="bk-muted"> · {splitSourceLabel(overview)}</span>
        </div>
        {canEdit && !editing && (
          <Button onClick={() => onEditingChange(true)}><Pencil size={13} /> Verdeling aanpassen</Button>
        )}
      </div>

      {changed.length > 0 && (
        <p className="bk-note bk-split-warn" role="alert">
          <AlertTriangle size={13} aria-hidden="true" /> Na {dateNL(year.periodEnd)} zijn de vennoten of hun verdeling gewijzigd ({changed.join(', ')}).
          {' '}Welke verdeling gold in {year.label}? Leg die eerst vast met Verdeling aanpassen: de verdeling van nu kan voor {year.label} niet kloppen.
          {open && ' Daarna kun je het jaar afsluiten.'}
        </p>
      )}
      {allAfter && !editing && (
        <p className="bk-note">
          {/* Met de tijdlijn (20261124120000) is het niet meer "de verdeling
              van nu": de eerste stand van de vennoten geldt vanaf het begin
              van de boekhouding, en een latere wijziging heeft een datum. */}
          Klopt deze verdeling voor {year.label}? De vennoten zijn pas na {year.label} in ResoFly vastgelegd, {overview.splitMode
            ? 'en hun eerste stand geldt vanaf het begin van je boekhouding.'
            : 'dus dit is hun verdeling van nu.'}
          {' '}Was die in {year.label} anders, of kreeg iemand vooraf een arbeidsbeloning of rente, pas hem dan aan.
        </p>
      )}

      {!editing && <SplitPeriods overview={overview} canEdit={canEdit} />}

      {editing
        ? <YearSplitEditor organizationId={organizationId} overview={overview} partners={partners}
            onCancel={() => onEditingChange(false)}
            onSaved={message => { onEditingChange(false); onSaved(message); }} />
        : inSplit.length === 0
          ? <p className="bk-muted">Er doet in {year.label} geen vennoot mee in de verdeling.{canEdit ? ' Met Verdeling aanpassen zet je de vennoten van dat jaar erin, ook als ze inmiddels zijn uitgetreden.' : ''}</p>
          : <div className="bk-table-wrap"><table className="bk-table bk-split-table">
              <thead><tr>
                <th>Vennoot</th><th className="bk-num">Aandeel</th>
                <th className="bk-num bk-split-col-prior" title="Arbeidsbeloning of rente over het kapitaal, vóór de verdeling naar rato">Vooraf</th>
                <th className="bk-num">Naar kapitaal</th>
              </tr></thead>
              <tbody>{inSplit.map(o => {
                // Met perioden heeft een vennoot soms meer dan één percentage
                // ("50% → 30%"), en doet hij niet het hele jaar mee: dat staat
                // onder zijn naam.
                const shares = multi ? periodShares(overview, o.partnerId) : [o.shareBasisPoints];
                const joinedInYear = o.joinedOn && o.joinedOn > year.periodStart && o.joinedOn <= year.periodEnd ? o.joinedOn : null;
                return (
                  <tr key={o.partnerId ?? o.name}>
                    <td><strong>{o.name}</strong>
                      {/* Op een eigen regel: achter de naam begon de tweede
                          regel op de telefoon met een losse punt. */}
                      {(o.leftOn || joinedInYear)
                        ? <div className="bk-muted bk-split-sub">
                            {[joinedInYear && `sinds ${dayLabel(joinedInYear)}`, o.leftOn && `uitgetreden per ${dayLabel(o.leftOn)}`].filter(Boolean).join(' · ')}
                          </div>
                        // Uitgetreden na dit jaar: "· uitgetreden" las in het
                        // venster van 2025 alsof hij in 2025 uittrad.
                        : !o.isActive && <span className="bk-muted"> · inmiddels uitgetreden</span>}
                    </td>
                    <td className="bk-num">{(shares.length ? shares : [o.shareBasisPoints]).map(pct).join(' → ')}</td>
                    <td className="bk-num bk-split-col-prior">{o.priorShareCents ? euroCents(o.priorShareCents) : '—'}</td>
                    <td className={`bk-num ${o.resultShareCents < 0 ? 'bk-neg' : ''}`}><strong>{euroCents(o.resultShareCents)}</strong>
                      {/* Op de telefoon past de kolom Vooraf er niet naast: dan hier. */}
                      {o.priorShareCents ? <div className="bk-muted bk-split-sub bk-split-prior-inline">waarvan vooraf {euroCents(o.priorShareCents)}</div> : null}
                    </td>
                  </tr>
                );
              })}</tbody>
              {inSplit.length > 1 && (
                <tfoot><tr className="bk-split-total-row">
                  <td>Samen</td>
                  <td className={`bk-num ${total !== 10000 ? 'bk-neg' : ''}`}>{pct(total)}{multi && total === 10000 ? ' per periode' : ''}</td>
                  <td className="bk-num bk-split-col-prior">{priorTotal ? euroCents(priorTotal) : '—'}</td>
                  <td className="bk-num">{euroCents(shareSum)}</td>
                </tr></tfoot>
              )}
            </table></div>}

      {!editing && problem && (
        <p className="bk-neg"><AlertTriangle size={13} aria-hidden="true" /> {problem.period.shares.length === 0
          ? <>Van {periodLabel(problem.period.periodStart, problem.period.periodEnd)} doet geen vennoot mee, dus het resultaat van die periode kan nergens heen.</>
          : <>De verdeling van {periodLabel(problem.period.periodStart, problem.period.periodEnd)} telt op tot {pct(problem.total)}; dat moet precies 100% zijn.</>}
          {' '}Kijk de datums en percentages na bij Vennoten{canEdit ? ', of leg met Verdeling aanpassen een verdeling voor het hele jaar vast' : ''}.
        </p>
      )}
      {!editing && !problem && total !== null && total !== 10000 && (
        <p className="bk-neg"><AlertTriangle size={13} aria-hidden="true" /> De verdeling van {year.label} telt op tot {pct(total)}. Dat moet precies 100% zijn{canEdit ? ': pas hem aan' : ''}.</p>
      )}
      {!editing && <LossShiftNote overview={overview} />}
      {!editing && priorTotal !== 0 && (
        <p className="bk-muted">
          Eerst krijgt elke vennoot zijn voorafgaande bedrag (samen {euroCents(priorTotal)}); de rest van het resultaat gaat naar rato van het aandeel.
        </p>
      )}
    </div>
  );
}

type SplitRow = { partnerId: string; share: string; prior: string };

/**
 * Het formulier: per vennoot het aandeel en het voorafgaande bedrag, vennoten
 * toevoegen of weghalen. Opslaan legt de verdeling van dit jaar vast; "Terug
 * naar de vennoten van nu" haalt hem weg (een lege lijst).
 */
function YearSplitEditor({ organizationId, overview, partners, onCancel, onSaved }: {
  organizationId: string;
  overview: OwnersEquityOverview;
  partners: PartnershipPartner[];
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const year = overview.fiscalYear;
  const [rows, setRows] = useState<SplitRow[]>(() => overview.owners
    .filter(o => o.inSplit && o.partnerId)
    .map(o => ({ partnerId: o.partnerId as string, share: bpToInput(o.shareBasisPoints), prior: centsToInput(o.priorShareCents ?? 0) })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(partners.map(p => [p.id, p])), [partners]);
  const addable = partners.filter(p => !rows.some(r => r.partnerId === p.id));

  const parsed = rows.map(r => ({
    ...r,
    bp: parsePercent(r.share),
    prior: r.prior.trim() === '' ? 0 : parseDutchAmountCents(r.prior),
  }));
  const valid = parsed.every(r => r.bp !== null && r.prior !== null);
  const total = parsed.reduce((sum, r) => sum + (r.bp ?? 0), 0);
  // Wat er per vennoot op zijn kapitaal komt, met dezelfde afronding als de
  // jaarafsluiting (fiscal_year_result_shares): eerst ieders voorafgaande
  // bedrag, het restant naar rato, de losse centen naar de grootste resten.
  const preview = (() => {
    if (!valid) return null;
    const priorTotal = parsed.reduce((sum, r) => sum + (r.prior ?? 0), 0);
    const rest = splitByShares(overview.resultCents - priorTotal, parsed.map(r => ({
      key: r.partnerId, basisPoints: r.bp ?? 0, order: byId.get(r.partnerId)?.partner_number ?? 99,
    })));
    return new Map(parsed.map(r => [r.partnerId, (r.prior ?? 0) + (rest.get(r.partnerId) ?? 0)]));
  })();

  const update = (partnerId: string, patch: Partial<SplitRow>) => setRows(rs => rs.map(r => (r.partnerId === partnerId ? { ...r, ...patch } : r)));
  const canSave = !busy && rows.length > 0 && valid && total === 10000;

  async function save() {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      await setFiscalYearPartnerShares(organizationId, year.id, parsed.map(r => ({
        partner_id: r.partnerId, share_basis_points: r.bp ?? 0, prior_share_cents: r.prior ?? 0,
      })));
      onSaved(`De verdeling van ${year.label} is vastgelegd. De jaarafsluiting en de kapitaalvergelijking van ${year.label} rekenen er nu mee.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); }
    finally { setBusy(false); }
  }

  // Sinds 20261124120000 is "geen vastgelegde verdeling" niet meer "de vennoten
  // van nu", maar de verdeling volgens de ingangsdatums bij Vennoten.
  const automaticWord = overview.splitMode ? 'de verdeling volgens de ingangsdatums bij Vennoten' : 'die van de actieve vennoten van nu';
  async function reset() {
    if (!confirm(`De vastgelegde verdeling van ${year.label} weghalen? Dan geldt weer ${automaticWord}.`)) return;
    setBusy(true); setError(null);
    try {
      await setFiscalYearPartnerShares(organizationId, year.id, []);
      onSaved(`De verdeling van ${year.label} is weer ${automaticWord}.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Terugzetten mislukt'); }
    finally { setBusy(false); }
  }

  return (
    <div className="bk-split-edit">
      <div className="bk-split-row bk-split-row-head" aria-hidden="true">
        <span>Vennoot</span><span>Aandeel (%)</span><span>Arbeidsbeloning of rente, vóór de verdeling</span><span className="bk-num">Naar kapitaal</span><span />
      </div>
      {parsed.map(r => {
        const partner = byId.get(r.partnerId);
        const name = partner?.name ?? 'Vennoot';
        const amount = preview?.get(r.partnerId);
        return (
          <div key={r.partnerId} className="bk-split-row">
            <div className="bk-split-name"><strong>{name}</strong>{partner && !partner.is_active && <span className="bk-muted"> · uitgetreden</span>}</div>
            <label className="bk-split-field">
              <span>Aandeel (%)</span>
              <Input inputMode="decimal" value={rows.find(x => x.partnerId === r.partnerId)?.share ?? ''} aria-label={`Aandeel van ${name} in procenten`}
                aria-invalid={r.bp === null} onChange={e => update(r.partnerId, { share: e.target.value })} placeholder="50" />
            </label>
            <label className="bk-split-field">
              <span>Vooraf (arbeidsbeloning, rente)</span>
              <Input inputMode="decimal" value={rows.find(x => x.partnerId === r.partnerId)?.prior ?? ''} aria-label={`Arbeidsbeloning of rente van ${name}, vóór de verdeling, in euro`}
                aria-invalid={r.prior === null} onChange={e => update(r.partnerId, { prior: e.target.value })} placeholder="0,00" />
            </label>
            <div className={`bk-split-amount bk-num ${amount !== undefined && amount < 0 ? 'bk-neg' : ''}`}>
              <span className="bk-split-amount-label">Naar kapitaal </span>{amount === undefined ? '—' : euroCents(amount)}
            </div>
            <button type="button" className="bk-icon-btn" title={`${name} uit de verdeling van ${year.label} halen`} aria-label={`${name} uit de verdeling halen`}
              disabled={busy} onClick={() => setRows(rs => rs.filter(x => x.partnerId !== r.partnerId))}><X size={14} /></button>
          </div>
        );
      })}
      {rows.length === 0 && <p className="bk-muted">Nog geen vennoot in de verdeling van {year.label}. Voeg ze hieronder toe.</p>}

      <div className="bk-split-foot">
        {addable.length > 0 && (
          <Select value="" placeholder="Vennoot toevoegen" icon={<Plus size={14} />} onChange={e => {
            const id = e.target.value;
            if (id) setRows(rs => [...rs, { partnerId: id, share: rows.length === 0 ? '100' : '0', prior: '' }]);
          }}>
            {addable.map(p => <option key={p.id} value={p.id}>{p.name}{p.is_active ? '' : ' (uitgetreden)'}</option>)}
          </Select>
        )}
        <span className={`bk-split-total ${total !== 10000 ? 'bk-neg' : ''}`}>Samen {pct(total)}{total !== 10000 ? ' · moet 100% zijn' : ''}</span>
      </div>

      {!valid && <p className="bk-neg">Vul elk aandeel in als percentage tussen 0 en 100, en het voorafgaande bedrag in euro's (of laat het leeg).</p>}
      <p className="bk-muted">
        Vooraf: wat een vennoot volgens het vennootschapscontract eerst krijgt, zoals een arbeidsbeloning of rente over zijn kapitaal.
        {' '}Het is geen kost maar een deel van zijn winstaandeel, en telt mee in wat hij aangeeft. De rest van het resultaat ({euroCents(overview.resultCents)} nu) gaat naar rato van het aandeel.
        {' '}Een vennoot die in {year.label} meedeed maar inmiddels is uitgetreden, hoort er gewoon in.
        {/* Wie hier opslaat bij een jaar met perioden, ruilt die in voor één
            verdeling over het hele jaar; dat moet vooraf duidelijk zijn. */}
        {hasPeriods(overview) && ` Wat je hier vastlegt, geldt voor heel ${year.label}: de perioden van de ingangsdatums vervallen dan, en het resultaat gaat in één keer naar rato.`}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="bk-fy-new-actions bk-split-actions">
        <Button variant="primary" disabled={!canSave} onClick={() => void save()}><Save size={14} /> {busy ? 'Bezig…' : 'Opslaan'}</Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}><X size={14} /> Annuleren</Button>
        {overview.splitFixed && (
          <Button variant="ghost" disabled={busy} onClick={() => void reset()} title={`Haal de vastgelegde verdeling weg: dan geldt weer ${automaticWord}`}>
            <RotateCcw size={14} /> {overview.splitMode ? 'Terug naar de ingangsdatums' : 'Terug naar de vennoten van nu'}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Privé zonder vennoot (0550/0560) in dit jaar. Bij het afsluiten gaat dat
 * naar 0500 en komt het bij geen enkele vennoot op de aangifte: wie het zo
 * liet staan, gaf één vennoot te weinig opnamen op, zonder dat iets het zei.
 */
export function GeneralPrivateNote({ overview }: { overview: OwnersEquityOverview }) {
  const cents = overview.generalPrivateCents ?? 0;
  if (!overview.isPartnershipForm || cents === 0) return null;
  const withdrawn = cents > 0;
  return (
    <p className="bk-note bk-split-warn">
      <AlertTriangle size={13} aria-hidden="true" /> Op 0550/0560 (privé, geen vennoot) staat in {overview.fiscalYear.label} per saldo {euroCents(Math.abs(cents))} {withdrawn ? 'opgenomen' : 'ingebracht'}.
      {' '}Bij het afsluiten gaat dat naar 0500 Eigen vermogen en komt het bij geen enkele vennoot op de aangifte.
      {' '}Boek het eerst om naar de privérekening van de vennoot ({withdrawn ? '055n Privé-opnamen' : '056n Privé-stortingen'}) met een memoriaal bij Grootboek → Journaal.
    </p>
  );
}
