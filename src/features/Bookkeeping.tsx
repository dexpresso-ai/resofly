import { useMemo, useState } from 'react';
import { BookOpen, FileDown, Layers, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type {
  AppData, JournalEntry, JournalLine, LedgerAccount, LedgerAccountType, PurchaseInvoice, PurchaseInvoiceLine, Supplier, VatCode,
} from '../types';
import { Modal } from '../components/Modal';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { dateNL, euro, uid } from '../lib/format';
import {
  bookPurchaseInvoice, deleteRow, ensureDefaultLedgerAccounts, insertRow, reverseJournalEntry, updateRow,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);

type PageProps = {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onChanged: () => void;
};

/** Banner die verschijnt zolang het rekeningschema nog niet geseed is. */
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
        <p>Maak het standaard rekeningschema en de BTW-codes aan om te beginnen.</p>
        {error && <p className="error">{error}</p>}
      </div>
      <Button variant="primary" disabled={!canWrite || busy} onClick={setup}>{busy ? 'Bezig…' : 'Rekeningschema aanmaken'}</Button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="bk-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

// ───────────────────────────── Leveranciers ─────────────────────────────

const emptySupplier = () => ({
  name: '', supplier_code: '', contact_name: '', email: '', phone: '',
  address_line1: '', postal_code: '', city: '', country: 'Nederland',
  vat_number: '', kvk_number: '', iban: '', default_expense_account_id: '', default_vat_code: '', notes: '', status: 'active',
});

export function SuppliersPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<Supplier | 'new' | null>(null);
  const expenseAccounts = data.ledgerAccounts.filter(a => a.type === 'expense' || a.type === 'asset');

  return (
    <div className="bk-page">
      {data.ledgerAccounts.length === 0 && <SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      <div className="bk-head">
        <div><h2>Leveranciers</h2><p>Crediteuren voor je inkoopfacturen.</p></div>
        <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Nieuwe leverancier</Button>
      </div>
      {data.suppliers.length === 0
        ? <div className="empty"><div className="e-big">Nog geen leveranciers</div></div>
        : <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr><th>Naam</th><th>Contact</th><th>BTW-nummer</th><th>IBAN</th><th></th></tr></thead>
            <tbody>{data.suppliers.map(s => (
              <tr key={s.id} className="bk-row" onClick={() => setEdit(s)}>
                <td><strong>{s.name}</strong>{s.supplier_code && <small className="bk-muted"> · {s.supplier_code}</small>}</td>
                <td>{s.contact_name || s.email || '—'}</td>
                <td>{s.vat_number || '—'}</td>
                <td>{s.iban || '—'}</td>
                <td className="bk-cell-action">Bewerk</td>
              </tr>
            ))}</tbody>
          </table></div>}
      {edit && <SupplierForm data={data} organizationId={organizationId} canWrite={canWrite} supplier={edit === 'new' ? null : edit} expenseAccounts={expenseAccounts} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </div>
  );
}

function SupplierForm({ data, organizationId, canWrite, supplier, expenseAccounts, onClose, onSaved }: {
  data: AppData; organizationId: string; canWrite: boolean; supplier: Supplier | null;
  expenseAccounts: LedgerAccount[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<Record<string, any>>(() => supplier ? { ...supplier } : emptySupplier());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!String(form.name || '').trim()) { setError('Naam is verplicht.'); return; }
    setBusy(true); setError(null);
    try {
      const values = {
        name: form.name, supplier_code: form.supplier_code || null, contact_name: form.contact_name || null,
        email: form.email || null, phone: form.phone || null, address_line1: form.address_line1 || null,
        postal_code: form.postal_code || null, city: form.city || null, country: form.country || null,
        vat_number: form.vat_number || null, kvk_number: form.kvk_number || null, iban: form.iban || null,
        default_expense_account_id: form.default_expense_account_id || null, default_vat_code: form.default_vat_code || null,
        notes: form.notes || null, status: form.status || 'active',
      };
      supplier ? await updateRow<Supplier>('suppliers', supplier.id, values, organizationId)
               : await insertRow<Supplier>('suppliers', organizationId, values);
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!supplier || !confirm('Leverancier verwijderen?')) return;
    setBusy(true); setError(null);
    try { await deleteRow('suppliers', supplier.id, organizationId); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt'); setBusy(false); }
  }

  return (
    <Modal title={supplier ? 'Leverancier bewerken' : 'Nieuwe leverancier'} onClose={onClose}
      footer={<div className="bk-foot">
        {supplier && canWrite && <Button variant="danger" onClick={remove} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
        <span className="bk-spacer" />
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" onClick={save} disabled={!canWrite || busy}>{busy ? 'Bezig…' : 'Opslaan'}</Button>
      </div>}>
      {error && <div className="error">{error}</div>}
      <div className="bk-grid2">
        <Field label="Naam"><Input value={form.name} onChange={e => set('name', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Leverancierscode"><Input value={form.supplier_code} onChange={e => set('supplier_code', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Contactpersoon"><Input value={form.contact_name} onChange={e => set('contact_name', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="E-mail"><Input value={form.email} onChange={e => set('email', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Telefoon"><Input value={form.phone} onChange={e => set('phone', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="BTW-nummer"><Input value={form.vat_number} onChange={e => set('vat_number', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="KvK-nummer"><Input value={form.kvk_number} onChange={e => set('kvk_number', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="IBAN"><Input value={form.iban} onChange={e => set('iban', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Adres"><Input value={form.address_line1} onChange={e => set('address_line1', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Postcode"><Input value={form.postal_code} onChange={e => set('postal_code', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Plaats"><Input value={form.city} onChange={e => set('city', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Standaard kostenrekening">
          <Select value={form.default_expense_account_id || ''} onChange={e => set('default_expense_account_id', e.target.value)} disabled={!canWrite}>
            <option value="">— geen —</option>
            {expenseAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </Field>
        <Field label="Standaard BTW-code">
          <Select value={form.default_vat_code || ''} onChange={e => set('default_vat_code', e.target.value)} disabled={!canWrite}>
            <option value="">— geen —</option>
            {data.vatCodes.map(v => <option key={v.id} value={v.code}>{v.label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Notities"><Textarea value={form.notes} onChange={e => set('notes', e.target.value)} disabled={!canWrite} rows={2} /></Field>
    </Modal>
  );
}

// ──────────────────────────── Inkoopfacturen ────────────────────────────

function nextPurchaseNumber(data: AppData, date = new Date()): string {
  const prefix = `INK-${date.getFullYear()}-`;
  const max = data.purchaseInvoices
    .map(p => p.internal_number || '')
    .filter(n => n.startsWith(prefix))
    .reduce((m, n) => Math.max(m, parseInt(n.slice(prefix.length), 10) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/** Header-totalen: BTW per tariefgroep afgerond (gelijk aan de serverboeking). */
function purchaseTotals(lines: PurchaseInvoiceLine[]) {
  const byRate = new Map<number, number>();
  let subtotal = 0;
  for (const l of lines) {
    const base = Number(l.amount_cents) || 0;
    subtotal += base;
    byRate.set(l.vat_rate || 0, (byRate.get(l.vat_rate || 0) || 0) + base);
  }
  let vat = 0;
  byRate.forEach((base, rate) => { vat += Math.round((base * rate) / 100); });
  return { subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
}

const purchaseStatusLabel: Record<PurchaseInvoice['status'], string> = {
  draft: 'Concept', booked: 'Geboekt', paid: 'Betaald', cancelled: 'Geannuleerd',
};

export function PurchaseInvoicesPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<PurchaseInvoice | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supplierName = (id: string | null) => data.suppliers.find(s => s.id === id)?.name ?? '—';

  async function book(pi: PurchaseInvoice) {
    if (!canWrite) return;
    setBusyId(pi.id); setError(null);
    try { await bookPurchaseInvoice(organizationId, pi.id); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Boeken mislukt'); }
    finally { setBusyId(null); }
  }

  const notReady = data.ledgerAccounts.length === 0;
  return (
    <div className="bk-page">
      {notReady && <SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      <div className="bk-head">
        <div><h2>Inkoopfacturen</h2><p>Boek leveranciersfacturen in en verwerk de voorbelasting.</p></div>
        <Button variant="primary" disabled={!canWrite || notReady} onClick={() => setEdit('new')}><Plus size={15} /> Nieuwe inkoopfactuur</Button>
      </div>
      {error && <div className="error">{error}</div>}
      {data.purchaseInvoices.length === 0
        ? <div className="empty"><div className="e-big">Nog geen inkoopfacturen</div></div>
        : <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr><th>Nummer</th><th>Leverancier</th><th>Datum</th><th className="bk-num">Excl.</th><th className="bk-num">BTW</th><th className="bk-num">Totaal</th><th>Status</th><th></th></tr></thead>
            <tbody>{data.purchaseInvoices.map(pi => (
              <tr key={pi.id} className="bk-row">
                <td onClick={() => setEdit(pi)}><strong>{pi.internal_number || '—'}</strong>{pi.supplier_invoice_number && <small className="bk-muted"> · {pi.supplier_invoice_number}</small>}</td>
                <td onClick={() => setEdit(pi)}>{supplierName(pi.supplier_id)}</td>
                <td onClick={() => setEdit(pi)}>{dateNL(pi.date)}</td>
                <td className="bk-num">{euroCents(pi.subtotal_cents)}</td>
                <td className="bk-num">{euroCents(pi.vat_cents)}</td>
                <td className="bk-num"><strong>{euroCents(pi.total_cents)}</strong></td>
                <td><span className={`status-pill bk-status-${pi.status}`}>{purchaseStatusLabel[pi.status]}</span></td>
                <td className="bk-cell-action">
                  {pi.status === 'draft'
                    ? <Button variant="primary" disabled={!canWrite || busyId === pi.id} onClick={() => book(pi)}>{busyId === pi.id ? 'Boeken…' : 'Boeken'}</Button>
                    : <span className="bk-muted">{pi.journal_entry_id ? 'In grootboek' : ''}</span>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>}
      {edit && <PurchaseInvoiceForm data={data} organizationId={organizationId} canWrite={canWrite}
        invoice={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </div>
  );
}

function PurchaseInvoiceForm({ data, organizationId, canWrite, invoice, onClose, onSaved }: {
  data: AppData; organizationId: string; canWrite: boolean; invoice: PurchaseInvoice | null;
  onClose: () => void; onSaved: () => void;
}) {
  const expenseAccounts = useMemo(() => data.ledgerAccounts.filter(a => a.type === 'expense' || a.type === 'asset'), [data.ledgerAccounts]);
  const defaultVat = data.vatCodes.find(v => v.code === 'HOOG') ?? data.vatCodes[0];
  const today = new Date().toISOString().slice(0, 10);
  const readOnly = !canWrite || (invoice != null && invoice.status !== 'draft');

  const [form, setForm] = useState<Record<string, any>>(() => invoice ? {
    supplier_id: invoice.supplier_id ?? '', supplier_invoice_number: invoice.supplier_invoice_number ?? '',
    internal_number: invoice.internal_number ?? '', date: invoice.date, due_date: invoice.due_date ?? '',
    project_id: invoice.project_id ?? '', notes: invoice.notes ?? '',
  } : {
    supplier_id: '', supplier_invoice_number: '', internal_number: nextPurchaseNumber(data), date: today, due_date: '', project_id: '', notes: '',
  });
  const [lines, setLines] = useState<PurchaseInvoiceLine[]>(() => invoice?.lines?.length
    ? invoice.lines
    : [{ id: uid(), description: '', amount_cents: 0, vat_code: defaultVat?.code ?? 'HOOG', vat_rate: defaultVat?.rate ?? 21, account_id: null }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const updateLine = (id: string, patch: Partial<PurchaseInvoiceLine>) =>
    setLines(ls => ls.map(l => l.id === id ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, { id: uid(), description: '', amount_cents: 0, vat_code: defaultVat?.code ?? 'HOOG', vat_rate: defaultVat?.rate ?? 21, account_id: null }]);
  const removeLine = (id: string) => setLines(ls => ls.length > 1 ? ls.filter(l => l.id !== id) : ls);

  const totals = purchaseTotals(lines);

  async function save() {
    if (!form.supplier_id) { setError('Kies een leverancier.'); return; }
    const cleaned = lines.filter(l => String(l.description || '').trim() || Number(l.amount_cents));
    if (cleaned.length === 0) { setError('Voeg minimaal één regel toe.'); return; }
    setBusy(true); setError(null);
    try {
      const t = purchaseTotals(cleaned);
      const values = {
        supplier_id: form.supplier_id, supplier_invoice_number: form.supplier_invoice_number || null,
        internal_number: form.internal_number || nextPurchaseNumber(data), date: form.date, due_date: form.due_date || null,
        project_id: form.project_id || null, notes: form.notes || null, lines: cleaned,
        subtotal_cents: t.subtotal_cents, vat_cents: t.vat_cents, total_cents: t.total_cents,
      };
      invoice ? await updateRow<PurchaseInvoice>('purchase_invoices', invoice.id, values, organizationId)
              : await insertRow<PurchaseInvoice>('purchase_invoices', organizationId, { ...values, status: 'draft', payment_status: 'unpaid' });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); setBusy(false); }
  }

  return (
    <Modal className="bk-modal-wide" title={invoice ? `Inkoopfactuur ${invoice.internal_number ?? ''}` : 'Nieuwe inkoopfactuur'} onClose={onClose}
      footer={<div className="bk-foot">
        <span className="bk-spacer" />
        <Button onClick={onClose}>Sluiten</Button>
        {!readOnly && <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Bezig…' : 'Opslaan als concept'}</Button>}
      </div>}>
      {error && <div className="error">{error}</div>}
      {readOnly && invoice && invoice.status !== 'draft' && <div className="bk-note">Deze factuur is geboekt en kan niet meer worden gewijzigd. Corrigeren kan via een tegenboeking in het grootboek.</div>}
      <div className="bk-grid2">
        <Field label="Leverancier">
          <Select value={form.supplier_id || ''} onChange={e => {
            const sup = data.suppliers.find(s => s.id === e.target.value);
            set('supplier_id', e.target.value);
            if (sup?.default_expense_account_id) setLines(ls => ls.map(l => l.account_id ? l : { ...l, account_id: sup.default_expense_account_id }));
          }} disabled={readOnly}>
            <option value="">— kies —</option>
            {data.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Factuurnummer leverancier"><Input value={form.supplier_invoice_number} onChange={e => set('supplier_invoice_number', e.target.value)} disabled={readOnly} /></Field>
        <Field label="Intern nummer"><Input value={form.internal_number} onChange={e => set('internal_number', e.target.value)} disabled={readOnly} /></Field>
        <Field label="Factuurdatum"><Input type="date" value={form.date} onChange={e => set('date', e.target.value)} disabled={readOnly} /></Field>
        <Field label="Vervaldatum"><Input type="date" value={form.due_date} onChange={e => set('due_date', e.target.value)} disabled={readOnly} /></Field>
        <Field label="Project">
          <Select value={form.project_id || ''} onChange={e => set('project_id', e.target.value)} disabled={readOnly}>
            <option value="">— geen —</option>
            {data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      </div>

      <div className="bk-lines">
        <div className="bk-lines-head"><span>Omschrijving</span><span>Grootboek</span><span>BTW</span><span className="bk-num">Bedrag excl.</span><span /></div>
        {lines.map(l => (
          <div className="bk-line" key={l.id}>
            <Input value={l.description} placeholder="Omschrijving" onChange={e => updateLine(l.id, { description: e.target.value })} disabled={readOnly} />
            <Select value={l.account_id || ''} onChange={e => updateLine(l.id, { account_id: e.target.value || null })} disabled={readOnly}>
              <option value="">— rekening —</option>
              {expenseAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </Select>
            <Select value={l.vat_code} onChange={e => {
              const vc = data.vatCodes.find(v => v.code === e.target.value);
              updateLine(l.id, { vat_code: e.target.value, vat_rate: vc?.rate ?? 0 });
            }} disabled={readOnly}>
              {data.vatCodes.map(v => <option key={v.id} value={v.code}>{v.label}</option>)}
            </Select>
            <Input className="bk-num" type="number" step="0.01" value={(l.amount_cents / 100).toString()}
              onChange={e => updateLine(l.id, { amount_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} disabled={readOnly} />
            {!readOnly && <button className="bk-line-del" onClick={() => removeLine(l.id)} title="Regel verwijderen">×</button>}
          </div>
        ))}
        {!readOnly && <button className="bk-add-line" onClick={addLine}><Plus size={14} /> Regel toevoegen</button>}
      </div>

      <div className="bk-totals">
        <div><span>Subtotaal</span><strong>{euroCents(totals.subtotal_cents)}</strong></div>
        <div><span>BTW</span><strong>{euroCents(totals.vat_cents)}</strong></div>
        <div className="bk-total-grand"><span>Totaal</span><strong>{euroCents(totals.total_cents)}</strong></div>
      </div>
      <Field label="Notities"><Textarea value={form.notes} onChange={e => set('notes', e.target.value)} disabled={readOnly} rows={2} /></Field>
    </Modal>
  );
}

// ─────────────────────────────── Grootboek ───────────────────────────────

export function LedgerPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [tab, setTab] = useState<'journal' | 'accounts' | 'vat'>('journal');
  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} /></div>;
  }
  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><h2>Grootboek</h2><p>Journaalposten en rekeningschema — de basis onder je W&amp;V en BTW-aangifte.</p></div>
      </div>
      <div className="bk-tabs">
        <button className={tab === 'journal' ? 'is-active' : ''} onClick={() => setTab('journal')}><BookOpen size={15} /> Journaal</button>
        <button className={tab === 'accounts' ? 'is-active' : ''} onClick={() => setTab('accounts')}><Layers size={15} /> Rekeningschema</button>
        <button className={tab === 'vat' ? 'is-active' : ''} onClick={() => setTab('vat')}><FileDown size={15} /> BTW-codes</button>
      </div>
      {tab === 'journal' && <JournalView data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      {tab === 'accounts' && <AccountsView data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      {tab === 'vat' && <VatCodesView vatCodes={data.vatCodes} />}
    </div>
  );
}

function JournalView({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accountLabel = (id: string) => {
    const a = data.ledgerAccounts.find(x => x.id === id);
    return a ? `${a.code} · ${a.name}` : id;
  };
  const linesByEntry = useMemo(() => {
    const map = new Map<string, JournalLine[]>();
    for (const l of data.journalLines) {
      const arr = map.get(l.entry_id) ?? [];
      arr.push(l); map.set(l.entry_id, arr);
    }
    map.forEach(arr => arr.sort((a, b) => a.line_index - b.line_index));
    return map;
  }, [data.journalLines]);

  async function reverse(entry: JournalEntry) {
    if (!canWrite || !confirm(`Boekstuk ${entry.entry_number} tegenboeken?`)) return;
    setBusyId(entry.id); setError(null);
    try { await reverseJournalEntry(entry.id); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Tegenboeken mislukt'); }
    finally { setBusyId(null); }
  }

  if (data.journalEntries.length === 0) {
    return <div className="empty"><div className="e-big">Nog geen journaalposten</div><p>Boek een inkoop- of verkoopfactuur om te beginnen.</p></div>;
  }
  return (
    <div className="bk-journal">
      {error && <div className="error">{error}</div>}
      {data.journalEntries.map(entry => {
        const lines = linesByEntry.get(entry.id) ?? [];
        const debit = lines.reduce((s, l) => s + l.debit_cents, 0);
        const credit = lines.reduce((s, l) => s + l.credit_cents, 0);
        return (
          <div key={entry.id} className={`bk-entry${entry.status === 'reversed' ? ' is-reversed' : ''}`}>
            <div className="bk-entry-head">
              <div>
                <strong>{entry.entry_number}</strong>
                <span className="bk-muted"> · {dateNL(entry.date)} · {entry.description}</span>
              </div>
              <div className="bk-entry-actions">
                <span className={`status-pill bk-je-${entry.status}`}>{entry.status === 'posted' ? 'Geboekt' : entry.status === 'reversed' ? 'Tegengeboekt' : 'Concept'}</span>
                {entry.status === 'posted' && canWrite && (
                  <Button onClick={() => reverse(entry)} disabled={busyId === entry.id}><RotateCcw size={13} /> {busyId === entry.id ? '…' : 'Tegenboeken'}</Button>
                )}
              </div>
            </div>
            <table className="bk-table bk-entry-lines">
              <thead><tr><th>Rekening</th><th>Omschrijving</th><th className="bk-num">Debet</th><th className="bk-num">Credit</th></tr></thead>
              <tbody>{lines.map(l => (
                <tr key={l.id}>
                  <td>{accountLabel(l.account_id)}</td>
                  <td>{l.description || '—'}</td>
                  <td className="bk-num">{l.debit_cents ? euroCents(l.debit_cents) : ''}</td>
                  <td className="bk-num">{l.credit_cents ? euroCents(l.credit_cents) : ''}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={2}>Totaal</td><td className="bk-num"><strong>{euroCents(debit)}</strong></td><td className="bk-num"><strong>{euroCents(credit)}</strong></td></tr></tfoot>
            </table>
          </div>
        );
      })}
    </div>
  );
}

const accountTypeLabel: Record<LedgerAccount['type'], string> = {
  asset: 'Activa', liability: 'Passiva', equity: 'Eigen vermogen', revenue: 'Opbrengsten', expense: 'Kosten',
};

const ACCOUNT_TYPE_OPTIONS: { value: LedgerAccountType; label: string }[] = [
  { value: 'asset', label: 'Activa (bezittingen)' },
  { value: 'liability', label: 'Passiva (schulden)' },
  { value: 'equity', label: 'Eigen vermogen' },
  { value: 'revenue', label: 'Opbrengsten' },
  { value: 'expense', label: 'Kosten' },
];

/** Vertaalt database-fouten naar begrijpelijke meldingen voor de rekening-editor. */
function describeAccountError(e: unknown): string {
  const err = e as { code?: string; message?: string; details?: string } | undefined;
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`;
  if (err?.code === '23505' || /duplicate key|unique/i.test(text)) return 'Er bestaat al een rekening met deze code.';
  if (err?.code === '23503' || /foreign key/i.test(text)) return 'Deze rekening is in gebruik in journaalposten en kan daarom niet worden verwijderd.';
  if (err?.code === '23514' || /check constraint/i.test(text)) return 'Ongeldige waarde — controleer de code, naam en het type.';
  return (e instanceof Error ? e.message : err?.message) || 'Opslaan mislukt.';
}

function AccountsView({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<LedgerAccount | 'new' | null>(null);
  return (
    <div className="bk-accounts">
      <div className="bk-subhead">
        <p className="bk-muted">Eigen rekeningen kun je vrij aanmaken en aanpassen. Systeemrekeningen zijn nodig voor het automatisch boeken en daarom beperkt bewerkbaar.</p>
        <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Nieuwe rekening</Button>
      </div>
      <div className="bk-table-wrap"><table className="bk-table">
        <thead><tr><th>Code</th><th>Naam</th><th>Type</th><th>Standaard BTW</th><th>Actief</th><th></th></tr></thead>
        <tbody>{data.ledgerAccounts.map(a => (
          <tr key={a.id} className={canWrite ? 'bk-row' : ''} onClick={() => canWrite && setEdit(a)}>
            <td><strong>{a.code}</strong></td>
            <td>{a.name}{a.is_system && <small className="bk-muted"> · systeem</small>}</td>
            <td>{accountTypeLabel[a.type]}</td>
            <td>{a.default_vat_code || '—'}</td>
            <td>{a.is_active ? 'Ja' : <span className="bk-muted">Nee</span>}</td>
            <td className="bk-cell-action">{canWrite ? 'Bewerk' : ''}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {edit && <LedgerAccountForm data={data} organizationId={organizationId} canWrite={canWrite}
        account={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </div>
  );
}

function LedgerAccountForm({ data, organizationId, canWrite, account, onClose, onSaved }: {
  data: AppData; organizationId: string; canWrite: boolean; account: LedgerAccount | null;
  onClose: () => void; onSaved: () => void;
}) {
  const isSystem = Boolean(account?.is_system);
  const [form, setForm] = useState<Record<string, any>>(() => account ? {
    code: account.code, name: account.name, type: account.type,
    subtype: account.subtype ?? '', default_vat_code: account.default_vat_code ?? '', is_active: account.is_active,
  } : { code: '', name: '', type: 'expense', subtype: '', default_vat_code: '', is_active: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!isSystem && !String(form.code || '').trim()) { setError('Code is verplicht.'); return; }
    if (!String(form.name || '').trim()) { setError('Naam is verplicht.'); return; }
    setBusy(true); setError(null);
    try {
      if (account) {
        // Systeemrekeningen: alleen naam, BTW-standaard en actief-status mogen wijzigen.
        // Code en type worden door de boekings-RPC's op code opgezocht en moeten stabiel blijven.
        const patch = isSystem
          ? { name: form.name, default_vat_code: form.default_vat_code || null, is_active: Boolean(form.is_active) }
          : { code: String(form.code).trim(), name: form.name, type: form.type, subtype: form.subtype || null, default_vat_code: form.default_vat_code || null, is_active: Boolean(form.is_active) };
        await updateRow<LedgerAccount>('ledger_accounts', account.id, patch, organizationId);
      } else {
        await insertRow<LedgerAccount>('ledger_accounts', organizationId, {
          code: String(form.code).trim(), name: form.name, type: form.type,
          subtype: form.subtype || null, default_vat_code: form.default_vat_code || null, is_active: Boolean(form.is_active),
        });
      }
      onSaved();
    } catch (e) { setError(describeAccountError(e)); setBusy(false); }
  }

  async function remove() {
    if (!account || isSystem) return;
    if (!confirm(`Rekening ${account.code} · ${account.name} verwijderen?`)) return;
    setBusy(true); setError(null);
    try { await deleteRow('ledger_accounts', account.id, organizationId); onSaved(); }
    catch (e) { setError(describeAccountError(e)); setBusy(false); }
  }

  return (
    <Modal title={account ? `Rekening ${account.code}` : 'Nieuwe grootboekrekening'} onClose={onClose}
      footer={<div className="bk-foot">
        {account && !isSystem && canWrite && <Button variant="danger" onClick={remove} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
        <span className="bk-spacer" />
        <Button onClick={onClose}>Annuleren</Button>
        {canWrite && <Button variant="primary" onClick={save} disabled={busy}>{busy ? 'Bezig…' : 'Opslaan'}</Button>}
      </div>}>
      {error && <div className="error">{error}</div>}
      {isSystem && <div className="bk-note">Dit is een systeemrekening. De code en het type liggen vast omdat het automatisch boeken die rekening op code opzoekt — je kunt wel de naam, standaard-BTW en de actief-status aanpassen.</div>}
      <div className="bk-grid2">
        <Field label="Code" hint="Bijv. 4600 of 8040"><Input value={form.code} onChange={e => set('code', e.target.value)} disabled={!canWrite || isSystem} /></Field>
        <Field label="Naam"><Input value={form.name} onChange={e => set('name', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Type" hint="Bepaalt of de rekening in de balans of de W&amp;V valt.">
          <Select value={form.type} onChange={e => set('type', e.target.value)} disabled={!canWrite || isSystem}>
            {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
        <Field label="Standaard BTW-code" hint="Optioneel.">
          <Select value={form.default_vat_code || ''} onChange={e => set('default_vat_code', e.target.value)} disabled={!canWrite}>
            <option value="">— geen —</option>
            {data.vatCodes.map(v => <option key={v.id} value={v.code}>{v.label}</option>)}
          </Select>
        </Field>
      </div>
      <label className="bk-setting-check bk-account-active">
        <input type="checkbox" checked={Boolean(form.is_active)} onChange={e => set('is_active', e.target.checked)} disabled={!canWrite} />
        <span>Actief (verschijnt in keuzelijsten bij het boeken)</span>
      </label>
    </Modal>
  );
}

function VatCodesView({ vatCodes }: { vatCodes: VatCode[] }) {
  return (
    <div className="bk-table-wrap"><table className="bk-table">
      <thead><tr><th>Code</th><th>Omschrijving</th><th className="bk-num">Tarief</th><th>Soort</th><th>Aangifte</th></tr></thead>
      <tbody>{vatCodes.map(v => (
        <tr key={v.id}>
          <td><strong>{v.code}</strong></td>
          <td>{v.label}</td>
          <td className="bk-num">{v.rate}%</td>
          <td>{v.kind}</td>
          <td>{[v.sales_box, v.vat_box].filter(Boolean).join(' / ') || '—'}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
