import { useMemo, useState } from 'react';
import { CalendarClock, Layers, Plus, Trash2 } from 'lucide-react';
import type { AppData, AssetDepreciation, FixedAsset } from '../types';
import { Modal } from '../components/Modal';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { dateNL, euro, uid } from '../lib/format';
import {
  deleteRow, ensureDefaultLedgerAccounts, generateDepreciationSchedule, insertRow, postAssetDepreciation, updateRow,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);
const centsFromInput = (v: string) => Math.round((parseFloat(v) || 0) * 100);

const assetStatusLabel: Record<FixedAsset['status'], string> = {
  active: 'Actief', fully_depreciated: 'Volledig afgeschreven', disposed: 'Afgestoten',
};

type PageProps = { data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void };

function SetupBanner({ organizationId, canWrite, onChanged }: { organizationId: string; canWrite: boolean; onChanged: () => void }) {
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
      <div>
        <strong>Boekhouding nog niet ingericht.</strong>
        <p>Maak eerst het rekeningschema aan (tabblad Grootboek) om activa te kunnen afschrijven.</p>
        {error && <p className="error">{error}</p>}
      </div>
      <Button variant="primary" disabled={!canWrite || busy} onClick={setup}>{busy ? 'Bezig…' : 'Rekeningschema aanmaken'}</Button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="bk-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function nextAssetNumber(data: AppData, date = new Date()): string {
  const prefix = `ACT-${date.getFullYear()}-`;
  const max = data.fixedAssets
    .map(a => a.asset_number || '')
    .filter(n => n.startsWith(prefix))
    .reduce((m, n) => Math.max(m, parseInt(n.slice(prefix.length), 10) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/** Som van de geboekte afschrijving + huidige boekwaarde per activum. */
function assetBookValue(asset: FixedAsset, deps: AssetDepreciation[]): { posted: number; bookValue: number } {
  const posted = deps.filter(d => d.status === 'posted').reduce((s, d) => s + d.amount_cents, 0);
  return { posted, bookValue: asset.acquisition_cost_cents - posted };
}

export function AssetsPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<FixedAsset | 'new' | null>(null);
  const depsByAsset = useMemo(() => {
    const map = new Map<string, AssetDepreciation[]>();
    for (const d of data.assetDepreciations) {
      const arr = map.get(d.asset_id) ?? [];
      arr.push(d); map.set(d.asset_id, arr);
    }
    return map;
  }, [data.assetDepreciations]);

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} /></div>;
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><h2>Activa</h2><p>Vaste activa registreren en lineair afschrijven naar de winst- en verliesrekening.</p></div>
        <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Nieuw activum</Button>
      </div>
      {data.fixedAssets.length === 0
        ? <div className="empty"><div className="e-big">Nog geen activa</div></div>
        : <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr><th>Nummer</th><th>Naam</th><th>Aanschafdatum</th><th className="bk-num">Aanschaf</th><th className="bk-num">Afgeschreven</th><th className="bk-num">Boekwaarde</th><th>Status</th></tr></thead>
            <tbody>{data.fixedAssets.map(a => {
              const { posted, bookValue } = assetBookValue(a, depsByAsset.get(a.id) ?? []);
              return (
                <tr key={a.id} className="bk-row" onClick={() => setEdit(a)}>
                  <td><strong>{a.asset_number || '—'}</strong></td>
                  <td>{a.name}{a.category && <small className="bk-muted"> · {a.category}</small>}</td>
                  <td>{dateNL(a.acquisition_date)}</td>
                  <td className="bk-num">{euroCents(a.acquisition_cost_cents)}</td>
                  <td className="bk-num">{euroCents(posted)}</td>
                  <td className="bk-num"><strong>{euroCents(bookValue)}</strong></td>
                  <td><span className={`status-pill bk-asset-${a.status}`}>{assetStatusLabel[a.status]}</span></td>
                </tr>
              );
            })}</tbody>
          </table></div>}
      {edit && <AssetForm data={data} organizationId={organizationId} canWrite={canWrite}
        asset={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onChanged={onChanged} />}
    </div>
  );
}

function endOfCurrentMonth(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
}

function AssetForm({ data, organizationId, canWrite, asset, onClose, onChanged }: {
  data: AppData; organizationId: string; canWrite: boolean; asset: FixedAsset | null;
  onClose: () => void; onChanged: () => void;
}) {
  const accountId = (code: string) => data.ledgerAccounts.find(a => a.code === code)?.id ?? '';
  const assetAccounts = data.ledgerAccounts.filter(a => a.type === 'asset');
  const expenseAccounts = data.ledgerAccounts.filter(a => a.type === 'expense');
  const today = new Date().toISOString().slice(0, 10);

  // currentAsset houdt het opgeslagen activum vast zodat we ná aanmaken direct het
  // schema kunnen genereren zonder de modal te sluiten.
  const [currentAsset, setCurrentAsset] = useState<FixedAsset | null>(asset);
  const [form, setForm] = useState<Record<string, any>>(() => asset ? {
    name: asset.name, asset_number: asset.asset_number ?? '', category: asset.category ?? '',
    acquisition_date: asset.acquisition_date, acquisition_cost_cents: asset.acquisition_cost_cents,
    residual_value_cents: asset.residual_value_cents, useful_life_months: asset.useful_life_months,
    start_date: asset.start_date, asset_account_id: asset.asset_account_id,
    depreciation_account_id: asset.depreciation_account_id, accumulated_depreciation_account_id: asset.accumulated_depreciation_account_id,
    source_purchase_invoice_id: asset.source_purchase_invoice_id ?? '', notes: asset.notes ?? '',
  } : {
    name: '', asset_number: nextAssetNumber(data), category: '', acquisition_date: today,
    acquisition_cost_cents: 0, residual_value_cents: 0, useful_life_months: 60, start_date: today,
    asset_account_id: accountId('0100'), depreciation_account_id: accountId('4000'),
    accumulated_depreciation_account_id: accountId('0150'), source_purchase_invoice_id: '', notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [throughDate, setThroughDate] = useState<string>(endOfCurrentMonth());
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const schedule = useMemo(
    () => data.assetDepreciations.filter(d => d.asset_id === currentAsset?.id).sort((a, b) => a.period_index - b.period_index),
    [data.assetDepreciations, currentAsset],
  );
  const hasPosted = schedule.some(d => d.status === 'posted');
  const financialsLocked = !canWrite || hasPosted;

  async function save() {
    if (!String(form.name || '').trim()) { setError('Naam is verplicht.'); return; }
    if (!form.asset_account_id || !form.depreciation_account_id || !form.accumulated_depreciation_account_id) {
      setError('Kies de grootboekrekeningen voor activa, afschrijvingskosten en cumulatieve afschrijving.'); return;
    }
    if (Number(form.residual_value_cents) > Number(form.acquisition_cost_cents)) { setError('De restwaarde mag niet hoger zijn dan de aanschafwaarde.'); return; }
    if (Number(form.useful_life_months) <= 0) { setError('De gebruiksduur moet groter zijn dan 0 maanden.'); return; }
    setBusy(true); setError(null);
    try {
      const values = {
        name: form.name, asset_number: form.asset_number || null, category: form.category || null,
        acquisition_date: form.acquisition_date, acquisition_cost_cents: Number(form.acquisition_cost_cents) || 0,
        residual_value_cents: Number(form.residual_value_cents) || 0, useful_life_months: Number(form.useful_life_months) || 1,
        start_date: form.start_date, asset_account_id: form.asset_account_id,
        depreciation_account_id: form.depreciation_account_id, accumulated_depreciation_account_id: form.accumulated_depreciation_account_id,
        source_purchase_invoice_id: form.source_purchase_invoice_id || null, notes: form.notes || null,
      };
      const saved = currentAsset
        ? await updateRow<FixedAsset>('fixed_assets', currentAsset.id, values, organizationId)
        : await insertRow<FixedAsset>('fixed_assets', organizationId, values);
      setCurrentAsset(saved);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); }
    finally { setBusy(false); }
  }

  async function generate() {
    if (!currentAsset) return;
    setBusy(true); setError(null);
    try { await generateDepreciationSchedule(organizationId, currentAsset.id); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Schema berekenen mislukt'); }
    finally { setBusy(false); }
  }

  async function post() {
    if (!currentAsset) return;
    if (!confirm(`Afschrijving boeken t/m ${dateNL(throughDate)}? Dit maakt journaalposten aan.`)) return;
    setBusy(true); setError(null);
    try { await postAssetDepreciation(organizationId, currentAsset.id, throughDate); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Afschrijving boeken mislukt'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!currentAsset || !confirm('Activum verwijderen? Dit kan alleen zolang er nog niets is afgeschreven.')) return;
    setBusy(true); setError(null);
    try { await deleteRow('fixed_assets', currentAsset.id, organizationId); onChanged(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt'); setBusy(false); }
  }

  const dueCount = schedule.filter(d => d.status === 'scheduled' && d.date <= throughDate).length;

  return (
    <Modal className="bk-modal-wide" title={currentAsset ? `Activum ${currentAsset.asset_number ?? ''}` : 'Nieuw activum'} onClose={onClose}
      footer={<div className="bk-foot">
        {currentAsset && canWrite && !hasPosted && <Button variant="danger" onClick={remove} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
        <span className="bk-spacer" />
        <Button onClick={onClose}>Sluiten</Button>
        {canWrite && <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Bezig…' : currentAsset ? 'Opslaan' : 'Opslaan & doorgaan'}</Button>}
      </div>}>
      {error && <div className="error">{error}</div>}
      {hasPosted && <div className="bk-note">Er is al afgeschreven op dit activum; de financiële velden zijn vergrendeld om het schema sluitend te houden. Corrigeren kan via een tegenboeking in het grootboek.</div>}

      <div className="bk-grid2">
        <Field label="Naam"><Input value={form.name} onChange={e => set('name', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Activanummer"><Input value={form.asset_number} onChange={e => set('asset_number', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Categorie"><Input value={form.category} onChange={e => set('category', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Aanschafdatum"><Input type="date" value={form.acquisition_date} onChange={e => set('acquisition_date', e.target.value)} disabled={financialsLocked} /></Field>
        <Field label="Aanschafwaarde (excl. btw)"><Input type="number" step="0.01" value={(form.acquisition_cost_cents / 100).toString()} onChange={e => set('acquisition_cost_cents', centsFromInput(e.target.value))} disabled={financialsLocked} /></Field>
        <Field label="Restwaarde"><Input type="number" step="0.01" value={(form.residual_value_cents / 100).toString()} onChange={e => set('residual_value_cents', centsFromInput(e.target.value))} disabled={financialsLocked} /></Field>
        <Field label="Gebruiksduur (maanden)" hint="Bijv. 60 voor 5 jaar."><Input type="number" step="1" value={String(form.useful_life_months)} onChange={e => set('useful_life_months', parseInt(e.target.value, 10) || 0)} disabled={financialsLocked} /></Field>
        <Field label="Afschrijving start"><Input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} disabled={financialsLocked} /></Field>
        <Field label="Activarekening (balans)">
          <Select value={form.asset_account_id || ''} onChange={e => set('asset_account_id', e.target.value)} disabled={financialsLocked}>
            <option value="">— kies —</option>
            {assetAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </Field>
        <Field label="Afschrijvingskosten (W&amp;V)">
          <Select value={form.depreciation_account_id || ''} onChange={e => set('depreciation_account_id', e.target.value)} disabled={financialsLocked}>
            <option value="">— kies —</option>
            {expenseAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </Field>
        <Field label="Cumulatieve afschrijving (balans)">
          <Select value={form.accumulated_depreciation_account_id || ''} onChange={e => set('accumulated_depreciation_account_id', e.target.value)} disabled={financialsLocked}>
            <option value="">— kies —</option>
            {assetAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </Field>
        <Field label="Bron-inkoopfactuur" hint="Optioneel.">
          <Select value={form.source_purchase_invoice_id || ''} onChange={e => set('source_purchase_invoice_id', e.target.value)} disabled={!canWrite}>
            <option value="">— geen —</option>
            {data.purchaseInvoices.map(pi => <option key={pi.id} value={pi.id}>{pi.internal_number || pi.supplier_invoice_number || pi.id.slice(0, 8)}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Notities"><Textarea value={form.notes} onChange={e => set('notes', e.target.value)} disabled={!canWrite} rows={2} /></Field>

      {currentAsset ? (
        <div className="bk-schedule">
          <div className="bk-schedule-head">
            <h4><Layers size={15} /> Afschrijvingsschema</h4>
            <div className="bk-schedule-actions">
              {canWrite && <Button onClick={generate} disabled={busy}>{schedule.length ? 'Herbereken schema' : 'Genereer schema'}</Button>}
              {canWrite && schedule.length > 0 && <span className="bk-post-inline">
                <Input type="date" value={throughDate} onChange={e => setThroughDate(e.target.value)} />
                <Button variant="primary" onClick={post} disabled={busy || dueCount === 0}><CalendarClock size={14} /> Boek t/m ({dueCount})</Button>
              </span>}
            </div>
          </div>
          {schedule.length === 0
            ? <p className="bk-muted">Nog geen schema. Klik op “Genereer schema” om de lineaire afschrijving te berekenen.</p>
            : <div className="bk-table-wrap"><table className="bk-table">
                <thead><tr><th>#</th><th>Datum</th><th className="bk-num">Afschrijving</th><th className="bk-num">Boekwaarde na</th><th>Status</th></tr></thead>
                <tbody>{schedule.map(d => (
                  <tr key={d.id}>
                    <td>{d.period_index}</td>
                    <td>{dateNL(d.date)}</td>
                    <td className="bk-num">{euroCents(d.amount_cents)}</td>
                    <td className="bk-num">{euroCents(d.book_value_after_cents)}</td>
                    <td><span className={`status-pill bk-dep-${d.status}`}>{d.status === 'posted' ? 'Geboekt' : 'Gepland'}</span></td>
                  </tr>
                ))}</tbody>
              </table></div>}
        </div>
      ) : (
        <p className="bk-muted bk-schedule-hint">Sla het activum eerst op; daarna kun je het afschrijvingsschema genereren en boeken.</p>
      )}
    </Modal>
  );
}
