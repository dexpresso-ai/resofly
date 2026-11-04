import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, Plus, Save, X } from 'lucide-react';
import type { AppData, FiscalYearListRow, OwnersEquityOverview, PartnershipPartner } from '../types';
import { Button, Input, Select, Skeleton } from '../components/Ui';
import { PageIcon } from '../components/PageIcon';
import { euro } from '../lib/format';
import { listFiscalYears, listPartnershipPartners, loadOwnersEquityOverview, savePartnershipPartner } from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pct = (bp: number | null | undefined) => `${((bp ?? 0) / 100).toLocaleString('nl-NL', { maximumFractionDigits: 2 })}%`;

/** "60", "33,33" of "33.33" → basispunten; ongeldig → null. */
function parsePercent(value: string): number | null {
  const n = Number(value.replace(/\s/g, '').replace('%', '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

type PartnerForm = { id: string | null; name: string; share: string; kind: PartnershipPartner['kind']; isActive: boolean };
const EMPTY_FORM: PartnerForm = { id: null, name: '', share: '', kind: 'beherend', isActive: true };

/**
 * Eigen vermogen van een eenmanszaak, en de vennoten van een vof, maatschap of cv.
 *
 * Bij een IB-onderneming is de winst van de ondernemer of de vennoten zelf. Deze
 * pagina laat per boekjaar de kapitaalvergelijking zien (begin, resultaat,
 * stortingen, opnamen, eind): dat is wat de aangifte inkomstenbelasting vraagt
 * als ondernemingsvermogen aan het begin en het eind van het jaar. Bij een vof
 * staat dat per vennoot, en hier leg je de vennoten en hun winstaandeel vast.
 */
export function OwnersPage({ data, organizationId, canWrite, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void;
}) {
  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  const isIb = ['eenmanszaak', 'vof', 'maatschap', 'cv'].includes(legalForm);
  const isPartnershipForm = ['vof', 'maatschap', 'cv'].includes(legalForm);

  const [years, setYears] = useState<FiscalYearListRow[]>([]);
  const [fiscalYearId, setFiscalYearId] = useState('');
  const [partners, setPartners] = useState<PartnershipPartner[]>([]);
  const [overview, setOverview] = useState<OwnersEquityOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<PartnerForm | null>(null);

  const accountCode = useMemo(() => new Map(data.ledgerAccounts.map(a => [a.id, a.code])), [data.ledgerAccounts]);

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

  useEffect(() => { if (isIb) void loadBase(); }, [isIb, loadBase]);
  useEffect(() => { if (isIb && fiscalYearId) void loadOverview(fiscalYearId); }, [isIb, fiscalYearId, loadOverview]);

  if (!isIb) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">Eigen vermogen</div>
      <div>Dit overzicht hoort bij een eenmanszaak, vof, maatschap of cv: daar is de winst van de ondernemer of de vennoten zelf.
        Bij een BV of NV staat het eigen vermogen bij de aandeelhouders en de resultaatbestemming.</div>
    </div></div>;
  }

  const activeShare = partners.filter(p => p.is_active).reduce((s, p) => s + p.profit_share_basis_points, 0);
  const shareOk = activeShare === 10000;

  const savePartner = async () => {
    if (!form) return;
    const share = parsePercent(form.share);
    setBusy(true); setError(null); setMessage(null);
    try {
      if (!form.name.trim()) throw new Error('Geef de vennoot een naam.');
      if (share === null) throw new Error('Vul het winstaandeel in als percentage tussen 0 en 100.');
      await savePartnershipPartner(organizationId, {
        id: form.id, name: form.name.trim(), profitShareBasisPoints: share,
        kind: legalForm === 'cv' ? form.kind : 'beherend', isActive: form.isActive,
      });
      setForm(null);
      await loadBase();
      await loadOverview(fiscalYearId);
      onChanged();
      setMessage(form.id ? 'Vennoot bijgewerkt.' : 'Vennoot vastgelegd, met eigen kapitaal- en privérekeningen.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); }
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
              <div><span>Vennoten</span><strong>{partners.filter(p => p.is_active).length}</strong></div>
              <div><span>Winstverdeling</span><strong className={partners.length > 0 && !shareOk ? 'bk-neg' : ''}>{pct(activeShare)}</strong></div>
            </div>
            {canWrite && !form && (
              <Button onClick={() => setForm({ ...EMPTY_FORM, share: partners.length === 0 ? '50' : '' })} disabled={busy}><Plus size={14} /> Vennoot toevoegen</Button>
            )}
          </div>

          {partners.length === 0
            ? <p className="bk-muted">Nog geen vennoten vastgelegd. Zolang dat zo is, behandelt de boekhouding de {legalForm} als een eenmanszaak: de winst gaat naar 0500 Eigen vermogen, zonder verdeling.</p>
            : <div className="bk-table-wrap"><table className="bk-table">
                <thead><tr>
                  <th>Vennoot</th><th className="bk-num">Winstaandeel</th>
                  {legalForm === 'cv' && <th>Soort</th>}
                  <th>Rekeningen</th><th>Status</th><th />
                </tr></thead>
                <tbody>{partners.map(p => (
                  <tr key={p.id} className={p.is_active ? '' : 'is-reversed'}>
                    <td><strong>{p.name}</strong></td>
                    <td className="bk-num">{pct(p.profit_share_basis_points)}</td>
                    {legalForm === 'cv' && <td>{p.kind === 'commanditair' ? 'Commanditair (stil)' : 'Beherend'}</td>}
                    <td className="bk-muted">{[p.capital_account_id, p.withdrawals_account_id, p.contributions_account_id].map(id => accountCode.get(id) ?? '—').join(' · ')}</td>
                    <td>{p.is_active ? 'Actief' : 'Uitgetreden'}</td>
                    <td className="bk-cell-action">
                      {canWrite && <button className="bk-line-del" title="Aanpassen" disabled={busy}
                        onClick={() => setForm({ id: p.id, name: p.name, share: String(p.profit_share_basis_points / 100).replace('.', ','), kind: p.kind, isActive: p.is_active })}>
                        <Pencil size={12} /></button>}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>}

          {partners.length > 0 && !shareOk && (
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
        </div>
      )}

      {/* ── Kapitaalvergelijking ── */}
      {loading ? <div className="bk-report-loading"><Skeleton lines={5} /></div> : !overview ? (
        <p className="bk-muted">{years.length === 0 ? 'Maak eerst een boekjaar aan bij Financiën → Boekjaren.' : 'Kies een boekjaar.'}</p>
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
                  <td className="bk-num">{euroCents(-o.withdrawalsCents)}</td>
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
                <td className="bk-num">{euroCents(-totals.withdrawals)}</td>
                <td className="bk-num">{euroCents(totals.other + (unassigned?.movementsCents ?? 0))}</td>
                <td className="bk-num">{euroCents(totals.end + (unassigned?.endCents ?? 0))}</td>
              </tr></tfoot>
            )}
          </table></div>

          {unassigned && (
            <p className="bk-muted">
              Een deel van het eigen vermogen staat op 0500, 0510 of de algemene privérekeningen en dus op geen enkele vennoot — bijvoorbeeld een beginbalans van vóór de
              vennoten. Verdeel het met een memoriaalboeking over de kapitaalrekeningen, zodat ieders beginvermogen klopt.
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
    </div>
  );
}
