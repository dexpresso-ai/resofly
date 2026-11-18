import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, Plus, Save, X } from 'lucide-react';
import type { AppData, FiscalYearListRow, OrganizationMember, OwnersEquityOverview, PartnershipPartner, PartnershipPartnerHours, UUID } from '../types';
import { Button, Input, Select, Skeleton } from '../components/Ui';
import { PageIcon } from '../components/PageIcon';
import { euro, formatMinutes, minutesToHours } from '../lib/format';
import { formatISODate } from '../lib/dates';
import { HOUR_CRITERION_MINUTES, projectHourCriterion } from '../lib/hourCriterion';
import { memberName } from '../lib/members';
import { businessProfit } from '../lib/incomeTax';
import {
  listFiscalYears, listPartnershipPartners, loadOwnersEquityOverview, loadPartnershipPartnerHours, reportProfitAndLoss,
  savePartnershipPartner, setPartnershipPartnerMember, setUpBookkeeping,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pct = (bp: number | null | undefined) => `${((bp ?? 0) / 100).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}%`;

/** "60", "33,33" of "33.33" → basispunten; ongeldig → null. */
function parsePercent(value: string): number | null {
  const n = Number(value.replace(/\s/g, '').replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** De rekening uit Instellingen → Boekhouding, zoals de jaarafsluiting hem gebruikt. */
function resultAccountLabel(code: string | null | undefined): string {
  return code === '0500' ? '0500 Eigen vermogen' : '0510 Onverdeeld resultaat';
}

type PartnerForm = { id: string | null; name: string; share: string; kind: PartnershipPartner['kind']; isActive: boolean; userId: string };
const EMPTY_FORM: PartnerForm = { id: null, name: '', share: '', kind: 'beherend', isActive: true, userId: '' };

/** Wat er in de kolom Urencriterium staat: de uren, en of het haalbaar is. */
function hoursCell(partner: PartnershipPartner, row: PartnershipPartnerHours | undefined, year: number, today: string) {
  // Een commanditaire vennoot is voor de inkomstenbelasting geen ondernemer.
  if (partner.kind === 'commanditair') return { text: 'n.v.t.', tone: '' };
  if (!partner.user_id) return { text: '—', tone: 'bk-muted' };
  if (!row) return { text: '—', tone: 'bk-muted' };
  const total = row.direct_minutes + row.indirect_minutes;
  const hours = `${Math.floor(minutesToHours(total)).toLocaleString('nl-NL')} u`;
  if (total >= HOUR_CRITERION_MINUTES) return { text: `${hours} · gehaald`, tone: 'bk-pos' };
  const currentYear = Number(today.slice(0, 4));
  if (year > currentYear) return { text: hours, tone: '' };
  if (year < currentYear) return { text: `${hours} · niet gehaald`, tone: 'bk-neg' };
  const projection = projectHourCriterion({ totalMinutes: total, firstEntryDate: row.first_entry_date, today, year });
  return projection.projectedMinutes >= HOUR_CRITERION_MINUTES
    ? { text: `${hours} · op koers`, tone: '' }
    : { text: `${hours} · onder koers, nog ${formatMinutes(projection.remainingMinutes)}`, tone: 'bk-neg' };
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
export function OwnersPage({ data, organizationId, canWrite, onChanged, ownerUserId = null, canReadHours = true, teamMembers = [], currentUserId = null }: {
  data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void;
  /** De eigenaar is bij een eenmanszaak de ondernemer: zijn uren tellen voor het urencriterium. */
  ownerUserId?: UUID | null;
  /** Zonder leesrecht op Uren (vaak de boekhouder) zie je geen uren: dan zegt het overzicht dat, in plaats van "0 uur, niet gehaald". */
  canReadHours?: boolean;
  /** De teamleden die je aan een vennoot kunt koppelen (vof, maatschap, cv). */
  teamMembers?: OrganizationMember[];
  currentUserId?: UUID | null;
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
  const [form, setForm] = useState<PartnerForm | null>(null);

  const accountCode = useMemo(() => new Map(data.ledgerAccounts.map(a => [a.id, a.code])), [data.ledgerAccounts]);
  const today = formatISODate(new Date());
  // Het urencriterium loopt over het kalenderjaar. Bij een eenmanszaak, vof,
  // maatschap of cv is het boekjaar het kalenderjaar; anders telt het jaar
  // waarin het boekjaar begint.
  const selectedYear = years.find(y => y.id === fiscalYearId) ?? null;
  const hoursYear = selectedYear ? Number(selectedYear.period_start.slice(0, 4)) : Number(today.slice(0, 4));
  const showHours = isPartnershipForm && canReadHours;
  const anyLinked = partners.some(p => p.user_id);

  const loadBase = useCallback(async () => {
    try {
      const [ys, ps] = await Promise.all([listFiscalYears(organizationId), listPartnershipPartners(organizationId)]);
      setYears(ys);
      setPartners(ps);
      setFiscalYearId(prev => prev || ys[0]?.id || '');
    } catch (e) { setError(e instanceof Error ? e.message : 'Laden mislukt'); }
  }, [organizationId]);

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
  }, [showHours, anyLinked, hoursYear, loadHours]);

  if (!isIb) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">Eigen vermogen</div>
      <div>Dit overzicht hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.
        Bij een BV of NV staat het eigen vermogen bij de aandeelhouders en de resultaatbestemming.</div>
    </div></div>;
  }

  const activePartners = partners.filter(p => p.is_active);
  const activeShare = activePartners.reduce((s, p) => s + p.profit_share_basis_points, 0);
  const shareOk = activeShare === 10000;
  // Teamleden die je aan een vennoot kunt koppelen: actief, en nog niet aan een
  // andere vennoot gekoppeld (de database weigert dat ook).
  const linkableMembers = (forPartnerId: string | null) => teamMembers.filter(m =>
    m.status === 'active' && !partners.some(p => p.user_id === m.user_id && p.id !== forPartnerId));
  const linkedName = (userId: UUID) => (teamMembers.some(m => m.user_id === userId)
    ? memberName(userId, teamMembers, currentUserId)
    : 'Teamlid (niet meer in de organisatie)');

  const savePartner = async () => {
    if (!form) return;
    const share = parsePercent(form.share);
    setBusy(true); setError(null); setMessage(null);
    try {
      if (!form.name.trim()) throw new Error('Geef de vennoot een naam.');
      if (share === null) throw new Error('Vul het winstaandeel in als percentage tussen 0 en 100.');
      const saved = await savePartnershipPartner(organizationId, {
        id: form.id, name: form.name.trim(), profitShareBasisPoints: share,
        kind: legalForm === 'cv' ? form.kind : 'beherend', isActive: form.isActive,
      });
      const wantedUser = form.userId || null;
      if ((saved.user_id ?? null) !== wantedUser) await setPartnershipPartnerMember(organizationId, saved.id, wantedUser);
      setForm(null);
      await loadBase();
      await loadOverview(fiscalYearId);
      onChanged();
      setMessage(form.id ? 'Vennoot bijgewerkt.' : 'Vennoot vastgelegd, met eigen kapitaal- en privérekeningen.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
      // Een nieuwe vennoot kan al bestaan als alleen het koppelen misging.
      void loadBase();
    }
    finally { setBusy(false); }
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
  }), { begin: 0, result: 0, contributions: 0, withdrawals: 0, other: 0, end: 0 });
  const unassigned = overview?.unassigned ?? null;

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

      {/* ── Vennoten ── */}
      {isPartnershipForm && (
        <div className="bk-report">
          <div className="bk-report-bar">
            <div className="bk-report-kpis">
              <div><span>Vennoten</span><strong>{activePartners.length}</strong></div>
              <div><span>Winstverdeling</span><strong className={activePartners.length > 0 && !shareOk ? 'bk-neg' : ''}>{pct(activeShare)}</strong></div>
            </div>
            {canWrite && !form && (
              <Button onClick={() => setForm({ ...EMPTY_FORM, share: partners.length === 0 ? '50' : '' })} disabled={busy}><Plus size={14} /> Vennoot toevoegen</Button>
            )}
          </div>

          {partners.length === 0
            ? <p className="bk-muted">
                Nog geen vennoten vastgelegd. Zolang dat zo is, verdeelt de jaarafsluiting niets: de winst gaat naar {resultLabel} (in te stellen bij
                Instellingen → Boekhouding), en privé-opnamen en -stortingen op 0550 en 0560 gaan naar 0500 Eigen vermogen.
              </p>
            : <div className="bk-table-wrap"><table className="bk-table">
                <thead><tr>
                  <th>Vennoot</th><th className="bk-num">Winstaandeel</th>
                  {legalForm === 'cv' && <th>Soort</th>}
                  {showHours && <th>Urencriterium {hoursYear}</th>}
                  <th>Rekeningen</th><th>Status</th><th />
                </tr></thead>
                <tbody>{partners.map(p => {
                  const cell = hoursCell(p, hours?.get(p.id), hoursYear, today);
                  return (
                    <tr key={p.id} className={p.is_active ? '' : 'is-reversed'}>
                      {/* Het teamlid onder de naam: als eigen kolom duwde het e-mailadres
                          het urencriterium op de telefoon buiten beeld. */}
                      <td><strong>{p.name}</strong>
                        <div className="bk-muted bk-partner-member">{p.user_id ? `Teamlid: ${linkedName(p.user_id)}` : 'Geen teamlid gekoppeld'}</div>
                      </td>
                      <td className="bk-num">{pct(p.profit_share_basis_points)}</td>
                      {legalForm === 'cv' && <td>{p.kind === 'commanditair' ? 'Commanditair (stil)' : 'Beherend'}</td>}
                      {showHours && <td className={`bk-partner-hours ${cell.tone}`.trim()}>{cell.text}</td>}
                      <td className="bk-muted">{[p.capital_account_id, p.withdrawals_account_id, p.contributions_account_id].map(id => accountCode.get(id) ?? '—').join(' · ')}</td>
                      <td>{p.is_active ? 'Actief' : 'Uitgetreden'}</td>
                      <td className="bk-cell-action">
                        {canWrite && <button className="bk-line-del" title="Aanpassen" disabled={busy}
                          onClick={() => setForm({ id: p.id, name: p.name, share: String(p.profit_share_basis_points / 100).replace('.', ','), kind: p.kind, isActive: p.is_active, userId: p.user_id ?? '' })}>
                          <Pencil size={12} /></button>}
                      </td>
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

          {form && (
            <>
              <div className="bk-fy-new-fields">
                <label><span>Naam</span><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Naam van de vennoot" /></label>
                <label><span>Winstaandeel (%)</span><Input value={form.share} onChange={e => setForm({ ...form, share: e.target.value })} placeholder="50" /></label>
                {legalForm === 'cv' && (
                  <label><span>Soort</span>
                    <Select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value as PartnershipPartner['kind'] })}>
                      <option value="beherend">Beherend vennoot</option>
                      <option value="commanditair">Commanditaire (stille) vennoot</option>
                    </Select>
                  </label>
                )}
                <label><span>Teamlid</span>
                  <Select value={form.userId} onChange={e => setForm({ ...form, userId: e.target.value })}>
                    <option value="">Niet gekoppeld</option>
                    {form.userId && !teamMembers.some(m => m.user_id === form.userId) && (
                      <option value={form.userId}>Teamlid (niet meer in de organisatie)</option>
                    )}
                    {linkableMembers(form.id).map(m => (
                      <option key={m.user_id} value={m.user_id}>{memberName(m.user_id, teamMembers, currentUserId)}</option>
                    ))}
                  </Select>
                </label>
                {form.id && (
                  <label><span>Status</span>
                    <Select value={form.isActive ? 'actief' : 'uit'} onChange={e => setForm({ ...form, isActive: e.target.value === 'actief' })}>
                      <option value="actief">Actief</option>
                      <option value="uit">Uitgetreden</option>
                    </Select>
                  </label>
                )}
              </div>
              <div className="bk-fy-new-actions">
                <Button variant="primary" disabled={busy} onClick={() => void savePartner()}><Save size={14} /> Opslaan</Button>
                <Button variant="ghost" disabled={busy} onClick={() => setForm(null)}><X size={14} /> Annuleren</Button>
              </div>
            </>
          )}

          <p className="bk-muted">
            Elke vennoot krijgt een eigen kapitaalrekening (050n) en privérekeningen voor opnamen (055n) en stortingen (056n). Bij de jaarafsluiting
            gaat het resultaat naar rato van het winstaandeel naar de kapitaalrekeningen, tot op de cent sluitend, en gaat het privé van elke vennoot naar zijn kapitaal.
            Staat er in het vennootschapscontract een arbeidsvergoeding of rente over het kapitaal vóór de verdeling, boek die dan als memoriaal tussen de kapitaalrekeningen.
            {legalForm === 'cv' && ' Een commanditaire vennoot deelt in de winst, maar is voor de inkomstenbelasting geen ondernemer: geen ondernemersaftrek en geen urencriterium.'}
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
          </div>

          <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr>
              <th>{overview.isPartnership ? 'Vennoot' : 'Ondernemer'}</th>
              <th className="bk-num">Begin</th>
              <th className="bk-num">{overview.isPartnership ? 'Winstaandeel' : 'Resultaat'}</th>
              <th className="bk-num">Stortingen</th>
              <th className="bk-num">Opnamen</th>
              <th className="bk-num">Overig</th>
              <th className="bk-num">Eind</th>
            </tr></thead>
            <tbody>
              {owners.map(o => (
                <tr key={o.partnerId ?? 'owner'} className={o.isActive ? '' : 'is-reversed'}>
                  <td><strong>{o.name}</strong>{overview.isPartnership && <span className="bk-muted"> · {pct(o.shareBasisPoints)}</span>}</td>
                  <td className="bk-num">{euroCents(o.beginCents)}</td>
                  <td className="bk-num">{euroCents(o.resultShareCents)}</td>
                  <td className="bk-num">{euroCents(o.contributionsCents)}</td>
                  {/* Zonder opnamen stond er "€ -0,00". */}
                  <td className="bk-num">{euroCents(o.withdrawalsCents ? -o.withdrawalsCents : 0)}</td>
                  <td className="bk-num">{o.otherMovementsCents ? euroCents(o.otherMovementsCents) : '—'}</td>
                  <td className="bk-num"><strong>{euroCents(o.endCents)}</strong></td>
                </tr>
              ))}
              {unassigned && (
                <tr className="bk-balance-sub">
                  <td>Nog niet aan een vennoot toegewezen</td>
                  <td className="bk-num">{euroCents(unassigned.beginCents)}</td>
                  <td className="bk-num">—</td><td className="bk-num">—</td><td className="bk-num">—</td>
                  <td className="bk-num">{unassigned.movementsCents ? euroCents(unassigned.movementsCents) : '—'}</td>
                  <td className="bk-num"><strong>{euroCents(unassigned.endCents)}</strong></td>
                </tr>
              )}
            </tbody>
            {(owners.length > 1 || unassigned) && (
              <tfoot><tr className="bk-report-result">
                <td>Totaal</td>
                <td className="bk-num">{euroCents(totals.begin + (unassigned?.beginCents ?? 0))}</td>
                <td className="bk-num">{euroCents(totals.result)}</td>
                <td className="bk-num">{euroCents(totals.contributions)}</td>
                <td className="bk-num">{euroCents(totals.withdrawals ? -totals.withdrawals : 0)}</td>
                <td className="bk-num">{euroCents(totals.other + (unassigned?.movementsCents ?? 0))}</td>
                <td className="bk-num">{euroCents(totals.end + (unassigned?.endCents ?? 0))}</td>
              </tr></tfoot>
            )}
          </table></div>

          {unassigned && (
            <p className="bk-muted">
              Een deel van het eigen vermogen staat op 0500, 0510 of de algemene privérekeningen en dus op geen enkele vennoot — bijvoorbeeld de sluitpost van een
              beginbalans van vóór de vennoten. Verdeel het met een memoriaalboeking over de kapitaalrekeningen, zodat ieders beginvermogen klopt.
              Bij een nieuwe beginbalans voorkom je dit door het kapitaal van elke vennoot meteen op zijn eigen kapitaalrekening te zetten (Grootboek → Beginbalans).
            </p>
          )}
          {(overview.openPriorYears?.length ?? 0) > 0 && (
            <p className="bk-note">
              <AlertTriangle size={13} /> {overview.openPriorYears!.length === 1 ? `Boekjaar ${overview.openPriorYears![0]} is` : `De boekjaren ${overview.openPriorYears!.join(', ')} zijn`} nog niet afgesloten.
              Het beginvermogen telt de voorlopige winst daarvan mee ({euroCents(overview.openPriorResultCents ?? 0)}){overview.isPartnership ? ', nog niet over de vennoten verdeeld' : ''}.
              Sluit {overview.openPriorYears!.length === 1 ? 'dat jaar' : 'die jaren'} af bij Boekjaren zodra de cijfers vaststaan, bijvoorbeeld na je aangifte.
            </p>
          )}
          {overview.fiscalYear.status !== 'closed' && (
            <p className="bk-muted">Het boekjaar loopt nog of is nog niet afgesloten: de {overview.isPartnership ? 'winstaandelen zijn' : 'winst is'} voorlopig, op basis van wat er nu geboekt is.</p>
          )}
          <p className="bk-muted">
            {overview.isPartnership
              ? 'Elke vennoot geeft zijn eigen winstaandeel aan in zijn aangifte inkomstenbelasting en moet zelf aan het urencriterium voldoen voor de ondernemersaftrek. Boek wat een vennoot opneemt op zijn eigen privé-opnamenrekening (055n) en wat hij inbrengt op zijn privé-stortingenrekening (056n).'
              : 'Boek geld dat je voor jezelf opneemt op 0550 Privé-opnamen en geld dat je inbrengt op 0560 Privé-stortingen, ook bij de bank. Bij de jaarafsluiting gaan ze naar 0500 Eigen vermogen. Begin- en eindvermogen heb je nodig in je aangifte inkomstenbelasting; de winst volgt uit de vergelijking van die twee, plus de opnamen en min de stortingen.'}
          </p>
        </div>
      )}

      {overview && !isPartnershipForm && (
        <IncomeTaxSection data={data} organizationId={organizationId} overview={overview} ownerUserId={canReadHours ? ownerUserId : null} />
      )}
    </div>
  );
}

/**
 * Van winst naar belastbare winst uit onderneming (lib/incomeTax.ts), voor de
 * aangifte inkomstenbelasting van een eenmanszaak. Bij een vof doet elke
 * vennoot dit zelf over zijn winstaandeel, met zijn eigen uren; dat rekent
 * deze pagina niet uit.
 */
function IncomeTaxSection({ data, organizationId, overview, ownerUserId }: {
  data: AppData; organizationId: string; overview: OwnersEquityOverview; ownerUserId: UUID | null;
}) {
  const year = Number(overview.fiscalYear.periodStart.slice(0, 4));
  const [mixedCostsCents, setMixedCostsCents] = useState<number | null>(null);
  const [starter, setStarter] = useState(false);

  // Eten, drinken en representatie: de rekeningen met subtype mixed_costs
  // (4600 in het rekeningschema van een IB-onderneming).
  const mixedAccounts = useMemo(() => new Set(data.ledgerAccounts.filter(a => a.subtype === 'mixed_costs').map(a => a.id)), [data.ledgerAccounts]);
  useEffect(() => {
    let cancelled = false;
    setMixedCostsCents(null);
    reportProfitAndLoss(organizationId, overview.fiscalYear.periodStart, overview.fiscalYear.periodEnd)
      .then(rows => { if (!cancelled) setMixedCostsCents(rows.filter(r => r.account_type === 'expense' && r.account_id && mixedAccounts.has(r.account_id)).reduce((sum, r) => sum + r.amount_cents, 0)); })
      .catch(() => { if (!cancelled) setMixedCostsCents(0); });
    return () => { cancelled = true; };
  }, [organizationId, overview.fiscalYear.periodStart, overview.fiscalYear.periodEnd, mixedAccounts]);

  // Het urencriterium per kalenderjaar, met de uren van de eigenaar.
  const hoursMinutes = useMemo(() => {
    if (!ownerUserId) return null;
    return data.timeEntries
      .filter(e => e.user_id === ownerUserId && e.entry_date >= `${year}-01-01` && e.entry_date <= `${year}-12-31`)
      .reduce((sum, e) => sum + e.minutes, 0);
  }, [data.timeEntries, ownerUserId, year]);
  const hoursMet = hoursMinutes != null && hoursMinutes >= HOUR_CRITERION_MINUTES;

  if (mixedCostsCents == null) return <div className="bk-report-loading"><Skeleton lines={4} /></div>;
  const r = businessProfit({ year, profitCents: overview.resultCents, mixedCostsCents, hoursCriterionMet: hoursMet, starter });
  const hours = hoursMinutes == null ? null : Math.floor(hoursMinutes / 60);
  const row = (label: React.ReactNode, cents: number, sign: '' | '+' | '−' | '=' = '', strong = false) => (
    <tr className={strong ? 'bk-report-total' : ''}>
      <td>{sign && <span className="bk-muted">{sign} </span>}{label}</td>
      <td className="bk-num">{euroCents(cents)}</td>
    </tr>
  );

  return (
    <div className="bk-report">
      <div className="bk-report-bar">
        <div className="bk-report-kpis">
          <div><span>Voor je aangifte inkomstenbelasting {year}</span><strong>{r ? euroCents(r.taxableProfitCents) : '—'}</strong></div>
          <div><span>Urencriterium {year}</span><strong className={hoursMet ? 'bk-pos' : ''}>{hours == null ? '—' : `${hours.toLocaleString('nl-NL')} / 1.225 uur`}</strong></div>
        </div>
      </div>
      {!r ? (
        <p className="bk-muted">De bedragen voor {year} (zelfstandigenaftrek, mkb-winstvrijstelling, de drempel voor gemengde kosten) staan nog niet in ResoFly. De winst en het eigen vermogen hierboven kun je wel gebruiken.</p>
      ) : (
        <>
          <div className="bk-table-wrap"><table className="bk-table bk-report-table bk-ib-table">
            <tbody>
              {row('Winst volgens je boekhouding', r.profitCents)}
              {r.mixedCosts.totalCents > 0 && row(
                <>Niet aftrekbaar deel van eten, drinken en representatie ({r.mixedCosts.method === 'percentage'
                  ? <>20% van {euroCents(r.mixedCosts.totalCents)}</>
                  : <>tot de drempel van {euroCents(r.rules.mixedCostsThresholdCents)}</>})</>,
                r.mixedCosts.addBackCents, '+')}
              {row('Winst uit onderneming vóór ondernemersaftrek', r.fiscalProfitCents, '=', true)}
              {/* Aftrekposten positief, met het minteken ervoor: "− € 1.200", niet "− € -1.200". */}
              {row(<>Zelfstandigenaftrek {hoursMet ? (r.selfEmployedCapped ? '(niet hoger dan de winst)' : '') : hours == null ? '(uren niet te zien)' : '(urencriterium niet gehaald)'}</>, r.selfEmployedDeductionCents, '−')}
              {starter && row('Startersaftrek', r.starterDeductionCents, '−')}
              {/* Bij een verlies maakt de vrijstelling het verlies kleiner: dan staat er een plus. */}
              {row(`Mkb-winstvrijstelling (${(r.rules.smeExemptionBasisPoints / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2 })}%)${r.smeExemptionCents < 0 ? ', maakt het verlies kleiner' : ''}`, Math.abs(r.smeExemptionCents), r.smeExemptionCents < 0 ? '+' : '−')}
              {row('Belastbare winst uit onderneming', r.taxableProfitCents, '=', true)}
            </tbody>
          </table></div>
          <label className="bk-setting-check">
            <input type="checkbox" checked={starter} onChange={e => setStarter(e.target.checked)} />
            <span>Ik ben starter: in een of meer van de vijf jaren hiervoor was ik geen ondernemer, en ik had nog geen drie keer startersaftrek ({euroCents(r.rules.starterDeductionCents)}).</span>
          </label>
          {!hoursMet && (
            <p className="bk-muted">
              {hours == null
                ? 'De uren van de eigenaar zie je hier alleen met leesrecht op Uren; de zelfstandigenaftrek is daarom niet meegerekend.'
                : `Bij Uren staan ${hours.toLocaleString('nl-NL')} uur in ${year}.`}
              {' '}Zonder urencriterium (1.225 uur, en meer dan de helft van je werktijd) geen zelfstandigenaftrek en startersaftrek; de mkb-winstvrijstelling krijg je wel.
            </p>
          )}
          {mixedAccounts.size === 0 && (
            <p className="bk-muted">Er is geen rekening voor eten, drinken en representatie (4600). Boek je die kosten op een andere rekening, tel het niet-aftrekbare deel dan zelf bij de winst.</p>
          )}
          <p className="bk-muted">
            Een indicatie{overview.fiscalYear.status !== 'closed' ? ', op basis van wat er nu geboekt is' : ''}. Niet meegerekend: de kleinschaligheidsinvesteringsaftrek (investeerde je in {year} meer dan € 2.901 in bedrijfsmiddelen van elk minstens € 450?),
            de bijtelling als je privé rijdt in een auto van de zaak, een desinvesteringsbijtelling, de meewerkaftrek, en de halve zelfstandigenaftrek als je aan het begin van het jaar de AOW-leeftijd had.
            Niet benutte zelfstandigenaftrek schuift door naar volgende jaren.
            {' '}Die posten, de AOW-leeftijd en wat je aan inkomstenbelasting en Zvw-bijdrage betaalt, rekent Financiën → Inkomstenbelasting uit, tot op de cent gelijk aan dit overzicht.
          </p>
        </>
      )}
    </div>
  );
}
