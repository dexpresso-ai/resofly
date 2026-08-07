import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookUser, Pencil, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import type {
  AppData, ShareEncumbrance, ShareEncumbranceKind, Shareholder, ShareholderKind,
  ShareholderPosition, ShareTransaction, ShareTransactionKind,
} from '../types';
import { SHARE_ENCUMBRANCE_LABELS, SHARE_TRANSACTION_LABELS, SHAREHOLDER_KIND_LABELS } from '../types';
import { Button, Input, Select, Skeleton } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { Dividends } from './Dividends';
import {
  addShareEncumbrance, addShareTransaction, createShareholder, deleteShareEncumbrance,
  deleteShareTransaction, deleteShareholder, listShareEncumbrances, listShareTransactions,
  listShareholders, loadShareholderPositions, updateShareholder,
} from '../lib/repository';
import type { ShareholderInput } from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const pct = (bp: number | null | undefined) => `${((bp ?? 0) / 100).toFixed(2).replace('.', ',')}%`;

function parseEuro(value: string): number {
  const n = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const EMPTY_SHAREHOLDER: ShareholderInput = {
  name: '', kind: 'natural_person', addressLine: '', postalCode: '', city: '',
  countryCode: 'NL', email: '', isDga: false, withholdingExempt: false,
  withholdingExemptNote: '', note: '',
};

/**
 * Aandeelhouders en dividend.
 *
 * Het register van art. 2:194 BW houdt het bestuur bij, en er staat meer in dan
 * "wie heeft hoeveel": ook wanneer iemand de aandelen kreeg, wanneer de
 * vennootschap dat erkende, om welke soort het gaat en wat er op elk aandeel is
 * gestort. Dat zijn eigenschappen van een gebeurtenis, niet van een persoon —
 * vandaar dat de stand hieronder wordt afgeleid uit de mutaties en niet ergens
 * als getal wordt bijgehouden.
 *
 * De uitkeringen staan onderaan: die steunen op dit register, want zonder te
 * weten wie er recht op heeft valt er niets in te houden.
 */
export function ShareholdersPage({ data, organizationId, canWrite, canAdmin, businessActive, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; canAdmin: boolean;
  businessActive: boolean; onChanged: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [shareholders, setShareholders] = useState<Shareholder[]>([]);
  const [positions, setPositions] = useState<ShareholderPosition[]>([]);
  const [transactions, setTransactions] = useState<ShareTransaction[]>([]);
  const [encumbrances, setEncumbrances] = useState<ShareEncumbrance[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: UUIDish; input: ShareholderInput } | null>(null);

  const legalForm = data.companySettings?.legal_form ?? 'eenmanszaak';
  const isCorporate = legalForm === 'bv' || legalForm === 'nv';

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [sh, pos, tx, enc] = await Promise.all([
        listShareholders(organizationId),
        loadShareholderPositions(organizationId, asOf),
        listShareTransactions(organizationId),
        listShareEncumbrances(organizationId),
      ]);
      setShareholders(sh); setPositions(pos); setTransactions(tx); setEncumbrances(enc);
    } catch (e) { setError(e instanceof Error ? e.message : 'Laden mislukt'); }
    finally { setLoading(false); }
  }, [organizationId, asOf]);

  useEffect(() => { if (isCorporate && businessActive) void load(); }, [load, isCorporate, businessActive]);

  async function run(action: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setMessage(null);
    try { await action(); await load(); onChanged(); setMessage(ok); }
    catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt'); }
    finally { setBusy(false); }
  }

  const totals = useMemo(() => positions.reduce(
    (acc, p) => ({
      shares: acc.shares + p.shares,
      nominal: acc.nominal + p.nominal_cents,
      paid: acc.paid + p.paid_up_cents,
    }),
    { shares: 0, nominal: 0, paid: 0 },
  ), [positions]);

  /**
   * Ingekochte eigen aandelen: uitgegeven min ingetrokken min wat er bij de
   * aandeelhouders ligt. Ze bestaan nog, maar geven geen stemrecht
   * (art. 2:228 lid 6 BW) en horen dus niet in de noemer van een belang.
   */
  const treasury = useMemo(() => {
    const upTo = transactions.filter(t => t.event_date <= asOf);
    const issued = upTo.filter(t => t.kind === 'issue').reduce((s, t) => s + t.quantity, 0);
    const cancelled = upTo.filter(t => t.kind === 'cancellation').reduce((s, t) => s + t.quantity, 0);
    return Math.max(0, issued - cancelled - totals.shares);
  }, [transactions, asOf, totals.shares]);

  if (!isCorporate) {
    return <div className="bk-page"><div className="empty">
      <div className="e-big">Aandeelhouders</div>
      <div>Een aandeelhoudersregister hoort bij een BV of NV. Bij deze rechtsvorm ({legalForm}) zijn er geen aandelen.</div>
    </div></div>;
  }
  if (!businessActive) {
    return <div className="bk-page"><div className="bk-setup">
      <div><strong>De zakelijke module staat uit.</strong>
        <p>Het aandeelhoudersregister en de dividenduitkeringen horen bij de zakelijke module. Zet die aan via Instellingen → Abonnement.</p></div>
    </div></div>;
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div>
          <h2>Aandeelhouders</h2>
          <p>
            Het register dat het bestuur op grond van art. 2:194 BW bijhoudt, en de dividenduitkeringen daarop.
            De stand wordt afgeleid uit de mutaties, zodat elke verkrijging met haar eigen datum en gestorte bedrag terug te vinden blijft.
          </p>
        </div>
        <div className="bk-head-actions">
          <label className="bk-setting-field">
            <span>Stand per</span>
            <input type="date" className="form-input" value={asOf} onChange={e => setAsOf(e.target.value)} />
          </label>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <p className="bk-note">{message}</p>}

      {loading ? <div className="bk-report-loading"><Skeleton lines={6} /></div> : (
        <>
          {/* ── De stand van het register ── */}
          <div className="bk-report">
            <div className="bk-report-bar">
              <div className="bk-report-kpis">
                <div><span>Aandelen bij aandeelhouders</span><strong>{totals.shares}</strong></div>
                <div><span>Nominale waarde</span><strong>{euroCents(totals.nominal)}</strong></div>
                <div><span>Gestort</span><strong>{euroCents(totals.paid)}</strong></div>
                {treasury > 0 && <div><span>Eigen aandelen</span><strong>{treasury}</strong></div>}
              </div>
            </div>

            {positions.length === 0
              ? <p className="bk-muted">Nog geen aandelen vastgelegd per {dateNL(asOf)}.</p>
              : <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr>
                    <th>Aandeelhouder</th><th>Soort aandelen</th>
                    <th className="bk-num">Aantal</th><th className="bk-num">Belang</th>
                    <th className="bk-num">Nominaal</th><th className="bk-num">Gestort</th>
                    <th>Sinds</th>
                  </tr></thead>
                  <tbody>{positions.map(p => (
                    <tr key={`${p.shareholder_id}-${p.share_class}`}>
                      <td>
                        {p.name}
                        <span className="bk-muted"> · {SHAREHOLDER_KIND_LABELS[p.kind]}</span>
                        {p.is_dga && <span className="bk-muted"> · DGA</span>}
                        {p.withholding_exempt && <span className="bk-muted"> · inhoudingsvrijstelling</span>}
                      </td>
                      <td>{p.share_class}</td>
                      <td className="bk-num">{p.shares}</td>
                      <td className="bk-num">{pct(p.share_basis_points)}</td>
                      <td className="bk-num">{euroCents(p.nominal_cents)}</td>
                      <td className="bk-num">{euroCents(p.paid_up_cents)}</td>
                      <td>{p.first_acquired ? dateNL(p.first_acquired) : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table></div>}

            {treasury > 0 && (
              <p className="bk-muted">
                De vennootschap houdt {treasury} eigen aandelen. Daarop kan geen stem worden uitgebracht (art. 2:228 lid 6 BW),
                dus ze tellen hierboven niet mee in de belangen.
              </p>
            )}
          </div>

          {/* ── De aandeelhouders zelf ── */}
          <div className="bk-report">
            <div className="bk-subhead">
              <div>
                <h3><Users size={15} /> Namen en adressen</h3>
                <p className="bk-muted">
                  Wat art. 2:194 lid 1 BW van het register vraagt. Het adres is niet vrijblijvend: het hoort in de dividendnota die elke ontvanger krijgt (art. 9 Wet DB 1965).
                </p>
              </div>
              {canWrite && (
                <Button onClick={() => setEditing({ id: null, input: { ...EMPTY_SHAREHOLDER } })}>
                  <Plus size={14} /> Aandeelhouder
                </Button>
              )}
            </div>

            {shareholders.length === 0
              ? <p className="bk-muted">Nog geen aandeelhouders vastgelegd.</p>
              : <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr><th>Naam</th><th>Soort</th><th>Adres</th><th>Dividendbelasting</th><th></th></tr></thead>
                  <tbody>{shareholders.map(s => (
                    <tr key={s.id}>
                      <td>{s.name}{s.is_dga && <span className="bk-muted"> · DGA</span>}</td>
                      <td>{SHAREHOLDER_KIND_LABELS[s.kind]}</td>
                      <td className="bk-muted">
                        {[s.address_line, [s.postal_code, s.city].filter(Boolean).join('  '), s.country_code !== 'NL' ? s.country_code : null]
                          .filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td>
                        {s.withholding_exempt
                          ? <span title={s.withholding_exempt_note ?? undefined}><ShieldCheck size={12} /> Vrijgesteld</span>
                          : <span className="bk-muted">Inhouden</span>}
                      </td>
                      <td className="bk-cell-action">
                        {canWrite && <>
                          <button className="bk-line-del" title="Bewerken" disabled={busy}
                            onClick={() => setEditing({
                              id: s.id,
                              input: {
                                name: s.name, kind: s.kind, addressLine: s.address_line ?? '',
                                postalCode: s.postal_code ?? '', city: s.city ?? '', countryCode: s.country_code,
                                email: s.email ?? '', isDga: s.is_dga,
                                withholdingExempt: s.withholding_exempt,
                                withholdingExemptNote: s.withholding_exempt_note ?? '',
                                note: s.note ?? '',
                              },
                            })}>
                            <Pencil size={12} />
                          </button>
                          <button className="bk-line-del" title="Verwijderen" disabled={busy}
                            onClick={() => run(() => deleteShareholder(organizationId, s.id), 'Aandeelhouder verwijderd.')}>
                            <Trash2 size={12} />
                          </button>
                        </>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>}
          </div>

          {/* ── De mutaties ── */}
          <div className="bk-report">
            <div className="bk-subhead">
              <div>
                <h3><BookUser size={15} /> Mutaties</h3>
                <p className="bk-muted">
                  Per gebeurtenis de datum van verkrijging, de datum van erkenning of betekening, de soort aandelen en het op elk aandeel gestorte bedrag.
                  Levering van aandelen in een BV kan alleen bij notariële akte (art. 2:196 BW); noteer de akte erbij.
                </p>
              </div>
            </div>

            {canWrite && shareholders.length > 0 && (
              <TransactionForm shareholders={shareholders} busy={busy}
                onSubmit={(input) => run(() => addShareTransaction(organizationId, input), 'Mutatie vastgelegd.')} />
            )}

            {transactions.length === 0
              ? <p className="bk-muted">Nog geen mutaties.</p>
              : <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr>
                    <th>Datum</th><th>Soort</th><th>Van</th><th>Naar</th>
                    <th className="bk-num">Aantal</th><th className="bk-num">Nominaal p/a</th><th className="bk-num">Gestort p/a</th>
                    <th>Erkend</th><th>Akte</th><th></th>
                  </tr></thead>
                  <tbody>{transactions.map(t => {
                    const name = (id: string | null) => shareholders.find(s => s.id === id)?.name ?? null;
                    return (
                      <tr key={t.id}>
                        <td>{dateNL(t.event_date)}</td>
                        <td>{SHARE_TRANSACTION_LABELS[t.kind]}<span className="bk-muted"> · {t.share_class}</span></td>
                        <td>{name(t.from_shareholder_id) ?? <span className="bk-muted">{t.kind === 'issue' ? 'uitgifte' : 'de vennootschap'}</span>}</td>
                        <td>{name(t.to_shareholder_id) ?? <span className="bk-muted">de vennootschap</span>}</td>
                        <td className="bk-num">{t.quantity}</td>
                        <td className="bk-num">{euroCents(t.nominal_value_cents)}</td>
                        <td className="bk-num">{euroCents(t.paid_up_cents)}</td>
                        <td>{t.acknowledged_on ? dateNL(t.acknowledged_on) : <span className="bk-muted">—</span>}</td>
                        <td className="bk-muted">{t.deed_reference || '—'}</td>
                        <td className="bk-cell-action">
                          {canWrite && <button className="bk-line-del" title="Verwijderen" disabled={busy}
                            onClick={() => run(() => deleteShareTransaction(organizationId, t.id), 'Mutatie verwijderd.')}>
                            <Trash2 size={12} /></button>}
                        </td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>}
          </div>

          {/* ── Pandrecht en vruchtgebruik ── */}
          <div className="bk-report">
            <div className="bk-subhead">
              <div>
                <h3>Pandrecht en vruchtgebruik</h3>
                <p className="bk-muted">
                  Ook verplicht onderdeel van het register (art. 2:194 lid 2 BW), met de rechten die de houder toekomen.
                  Het doet er echt toe: rust er vruchtgebruik op een aandeel, dan kan het dividend aan de vruchtgebruiker toekomen in plaats van aan de aandeelhouder.
                </p>
              </div>
            </div>

            {canWrite && shareholders.length > 0 && (
              <EncumbranceForm shareholders={shareholders} busy={busy}
                onSubmit={(input) => run(() => addShareEncumbrance(organizationId, input), 'Vastgelegd.')} />
            )}

            {encumbrances.length === 0
              ? <p className="bk-muted">Niets vastgelegd.</p>
              : <div className="bk-table-wrap"><table className="bk-table">
                  <thead><tr>
                    <th>Soort</th><th>Houder</th><th>Op de aandelen van</th>
                    <th className="bk-num">Aantal</th><th>Gevestigd</th><th>Rechten</th><th></th>
                  </tr></thead>
                  <tbody>{encumbrances.map(e => (
                    <tr key={e.id} className={e.ended_on ? 'is-reversed' : ''}>
                      <td>{SHARE_ENCUMBRANCE_LABELS[e.kind]}</td>
                      <td>{e.holder_name}{e.holder_address && <span className="bk-muted"> · {e.holder_address}</span>}</td>
                      <td>{shareholders.find(s => s.id === e.shareholder_id)?.name ?? '—'}</td>
                      <td className="bk-num">{e.quantity}</td>
                      <td>{dateNL(e.established_on)}{e.ended_on && <span className="bk-muted"> t/m {dateNL(e.ended_on)}</span>}</td>
                      <td className="bk-muted">
                        {[e.has_voting_rights ? 'stemrecht' : null, e.has_dividend_rights ? 'dividend' : null]
                          .filter(Boolean).join(' · ') || 'geen'}
                      </td>
                      <td className="bk-cell-action">
                        {canWrite && <button className="bk-line-del" title="Verwijderen" disabled={busy}
                          onClick={() => run(() => deleteShareEncumbrance(organizationId, e.id), 'Verwijderd.')}>
                          <Trash2 size={12} /></button>}
                      </td>
                    </tr>
                  ))}</tbody>
                </table></div>}
          </div>

          {/* ── Dividend ── */}
          <Dividends
            organizationId={organizationId}
            canWrite={canWrite}
            canAdmin={canAdmin}
            positions={positions}
            asOf={asOf}
            onChanged={onChanged}
          />
        </>
      )}

      {editing && (
        <ShareholderDialog
          input={editing.input}
          isNew={editing.id === null}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(input) => run(async () => {
            if (editing.id === null) await createShareholder(organizationId, input);
            else await updateShareholder(organizationId, editing.id, input);
            setEditing(null);
          }, editing.id === null ? 'Aandeelhouder toegevoegd.' : 'Aandeelhouder bijgewerkt.')}
        />
      )}
    </div>
  );
}

type UUIDish = string | null;

/** Nieuwe of bestaande aandeelhouder. */
function ShareholderDialog({ input, isNew, busy, onCancel, onSave }: {
  input: ShareholderInput; isNew: boolean; busy: boolean;
  onCancel: () => void; onSave: (input: ShareholderInput) => void;
}) {
  const [form, setForm] = useState<ShareholderInput>(input);
  const set = <K extends keyof ShareholderInput>(k: K, v: ShareholderInput[K]) => setForm(f => ({ ...f, [k]: v }));

  const exemptWithoutNote = (form.withholdingExempt ?? false) && !(form.withholdingExemptNote ?? '').trim();
  const blocked = busy || !form.name.trim() || exemptWithoutNote;

  return (
    <div className="bk-modal-backdrop" onClick={onCancel}>
      <div className="bk-modal" onClick={e => e.stopPropagation()}>
        <h3>{isNew ? 'Aandeelhouder toevoegen' : 'Aandeelhouder bewerken'}</h3>
        <div className="bk-modal-body">
          <label className="bk-setting-field"><span>Naam</span>
            <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Naam of statutaire naam" />
          </label>
          <label className="bk-setting-field"><span>Soort</span>
            <Select value={form.kind} onChange={e => set('kind', e.target.value as ShareholderKind)}>
              {(Object.keys(SHAREHOLDER_KIND_LABELS) as ShareholderKind[]).map(k =>
                <option key={k} value={k}>{SHAREHOLDER_KIND_LABELS[k]}</option>)}
            </Select>
          </label>
          <label className="bk-setting-field"><span>Adres</span>
            <Input value={form.addressLine ?? ''} onChange={e => set('addressLine', e.target.value)} placeholder="Straat en huisnummer" />
          </label>
          <div className="bk-grid2">
            <label className="bk-setting-field"><span>Postcode</span>
              <Input value={form.postalCode ?? ''} onChange={e => set('postalCode', e.target.value)} />
            </label>
            <label className="bk-setting-field"><span>Plaats</span>
              <Input value={form.city ?? ''} onChange={e => set('city', e.target.value)} />
            </label>
          </div>
          <div className="bk-grid2">
            <label className="bk-setting-field"><span>Land</span>
              <Input value={form.countryCode ?? 'NL'} onChange={e => set('countryCode', e.target.value)} placeholder="NL" />
            </label>
            <label className="bk-setting-field"><span>E-mail</span>
              <Input value={form.email ?? ''} onChange={e => set('email', e.target.value)} />
            </label>
          </div>

          <label className="bk-setting-check">
            <input type="checkbox" checked={form.isDga ?? false} onChange={e => set('isDga', e.target.checked)} />
            <span>Dit is de directeur-grootaandeelhouder</span>
          </label>

          <label className="bk-setting-check">
            <input type="checkbox" checked={form.withholdingExempt ?? false} onChange={e => set('withholdingExempt', e.target.checked)} />
            <span>
              Op uitkeringen aan deze aandeelhouder hoeft geen dividendbelasting te worden ingehouden (art. 4 Wet DB 1965).
              <small className="bk-muted"> Speelt vooral bij een holding: is de deelnemingsvrijstelling van toepassing, dan blijft de inhouding achterwege. Of dat zo is hangt af van het belang, de vestigingsplaats en de misbruiktoets — dat kan ResoFly niet voor je beoordelen.</small>
            </span>
          </label>
          {form.withholdingExempt && (
            <label className="bk-setting-field"><span>Onderbouwing van de vrijstelling</span>
              <Input value={form.withholdingExemptNote ?? ''} onChange={e => set('withholdingExemptNote', e.target.value)}
                placeholder="Bijv. 100%-deelneming, in Nederland gevestigde houdstermaatschappij" />
            </label>
          )}
          {exemptWithoutNote && <p className="bk-neg">Leg vast waaróm er niet ingehouden hoeft te worden; bij een controle is dat het enige dat telt.</p>}

          <label className="bk-setting-field"><span>Notitie (optioneel)</span>
            <Input value={form.note ?? ''} onChange={e => set('note', e.target.value)} />
          </label>
        </div>
        <div className="bk-modal-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Annuleren</Button>
          <Button variant="primary" disabled={blocked} onClick={() => onSave(form)}>{busy ? 'Bezig…' : 'Opslaan'}</Button>
        </div>
      </div>
    </div>
  );
}

/** Een mutatie in het aandelenbezit. */
function TransactionForm({ shareholders, busy, onSubmit }: {
  shareholders: Shareholder[]; busy: boolean;
  onSubmit: (input: Parameters<typeof addShareTransaction>[1]) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [kind, setKind] = useState<ShareTransactionKind>('issue');
  const [eventDate, setEventDate] = useState(today);
  const [acknowledgedOn, setAcknowledgedOn] = useState('');
  const [shareClass, setShareClass] = useState('gewoon');
  const [quantity, setQuantity] = useState('1');
  const [nominal, setNominal] = useState('1,00');
  const [paidUp, setPaidUp] = useState('1,00');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [deed, setDeed] = useState('');

  const needsFrom = kind !== 'issue';
  const needsTo = kind === 'issue' || kind === 'transfer';
  const qty = Number(quantity) || 0;
  const nominalCents = parseEuro(nominal);
  const paidUpCents = parseEuro(paidUp);
  const paidTooHigh = paidUpCents > nominalCents;

  const blocked = busy || qty <= 0 || paidTooHigh
    || (needsFrom && !from) || (needsTo && !to)
    || (kind === 'transfer' && from === to);

  return (
    <>
      <div className="bk-fy-new-fields">
        <label><span>Soort</span>
          <Select value={kind} onChange={e => { setKind(e.target.value as ShareTransactionKind); setFrom(''); setTo(''); }}>
            {(Object.keys(SHARE_TRANSACTION_LABELS) as ShareTransactionKind[]).map(k =>
              <option key={k} value={k}>{SHARE_TRANSACTION_LABELS[k]}</option>)}
          </Select>
        </label>
        <label><span>Datum verkrijging</span>
          <input type="date" className="form-input" value={eventDate} onChange={e => setEventDate(e.target.value)} />
        </label>
        <label><span>Erkend of betekend op</span>
          <input type="date" className="form-input" value={acknowledgedOn} onChange={e => setAcknowledgedOn(e.target.value)} />
        </label>
        {needsFrom && (
          <label><span>Van</span>
            <Select value={from} onChange={e => setFrom(e.target.value)}>
              <option value="">Kies…</option>
              {shareholders.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </label>
        )}
        {needsTo && (
          <label><span>Naar</span>
            <Select value={to} onChange={e => setTo(e.target.value)}>
              <option value="">Kies…</option>
              {shareholders.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </label>
        )}
        <label><span>Soort aandelen</span>
          <Input value={shareClass} onChange={e => setShareClass(e.target.value)} placeholder="gewoon" />
        </label>
        <label><span>Aantal</span>
          <Input value={quantity} onChange={e => setQuantity(e.target.value)} />
        </label>
        <label><span>Nominaal per aandeel</span>
          <Input value={nominal} onChange={e => setNominal(e.target.value)} placeholder="1,00" />
        </label>
        <label><span>Gestort per aandeel</span>
          <Input value={paidUp} onChange={e => setPaidUp(e.target.value)} placeholder="1,00" />
        </label>
        <label><span>Akte</span>
          <Input value={deed} onChange={e => setDeed(e.target.value)} placeholder="Bijv. akte van levering 12-03-2024, notaris Jansen" />
        </label>
      </div>
      {paidTooHigh && (
        <p className="bk-neg">
          Er kan niet meer gestort zijn dan de nominale waarde; wat daarbovenop is betaald is agio en hoort op 0505.
        </p>
      )}
      <div className="bk-fy-new-actions">
        <Button disabled={blocked} onClick={() => onSubmit({
          kind, eventDate, acknowledgedOn: acknowledgedOn || null,
          shareClass, quantity: qty,
          nominalValueCents: nominalCents, paidUpCents,
          fromShareholderId: needsFrom ? from : null,
          toShareholderId: needsTo ? to : null,
          deedReference: deed || null,
        })}><Plus size={14} /> Mutatie vastleggen</Button>
      </div>
    </>
  );
}

/** Pandrecht of vruchtgebruik op aandelen. */
function EncumbranceForm({ shareholders, busy, onSubmit }: {
  shareholders: Shareholder[]; busy: boolean;
  onSubmit: (input: Parameters<typeof addShareEncumbrance>[1]) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [shareholderId, setShareholderId] = useState('');
  const [kind, setKind] = useState<ShareEncumbranceKind>('pledge');
  const [holderName, setHolderName] = useState('');
  const [holderAddress, setHolderAddress] = useState('');
  const [shareClass, setShareClass] = useState('gewoon');
  const [quantity, setQuantity] = useState('1');
  const [establishedOn, setEstablishedOn] = useState(today);
  const [voting, setVoting] = useState(false);
  const [dividend, setDividend] = useState(false);

  const qty = Number(quantity) || 0;
  const blocked = busy || !shareholderId || !holderName.trim() || qty <= 0;

  return (
    <>
      <div className="bk-fy-new-fields">
        <label><span>Soort</span>
          <Select value={kind} onChange={e => setKind(e.target.value as ShareEncumbranceKind)}>
            {(Object.keys(SHARE_ENCUMBRANCE_LABELS) as ShareEncumbranceKind[]).map(k =>
              <option key={k} value={k}>{SHARE_ENCUMBRANCE_LABELS[k]}</option>)}
          </Select>
        </label>
        <label><span>Op de aandelen van</span>
          <Select value={shareholderId} onChange={e => setShareholderId(e.target.value)}>
            <option value="">Kies…</option>
            {shareholders.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </label>
        <label><span>Houder</span>
          <Input value={holderName} onChange={e => setHolderName(e.target.value)} placeholder="Naam pandhouder of vruchtgebruiker" />
        </label>
        <label><span>Adres van de houder</span>
          <Input value={holderAddress} onChange={e => setHolderAddress(e.target.value)} />
        </label>
        <label><span>Soort aandelen</span>
          <Input value={shareClass} onChange={e => setShareClass(e.target.value)} />
        </label>
        <label><span>Aantal</span>
          <Input value={quantity} onChange={e => setQuantity(e.target.value)} />
        </label>
        <label><span>Gevestigd op</span>
          <input type="date" className="form-input" value={establishedOn} onChange={e => setEstablishedOn(e.target.value)} />
        </label>
      </div>
      <label className="bk-setting-check">
        <input type="checkbox" checked={voting} onChange={e => setVoting(e.target.checked)} />
        <span>Het stemrecht komt de houder toe</span>
      </label>
      <label className="bk-setting-check">
        <input type="checkbox" checked={dividend} onChange={e => setDividend(e.target.checked)} />
        <span>Het dividend komt de houder toe</span>
      </label>
      <div className="bk-fy-new-actions">
        <Button disabled={blocked} onClick={() => onSubmit({
          shareholderId, kind, holderName, holderAddress: holderAddress || null,
          shareClass, quantity: qty, establishedOn,
          hasVotingRights: voting, hasDividendRights: dividend,
        })}><Plus size={14} /> Vastleggen</Button>
      </div>
    </>
  );
}
