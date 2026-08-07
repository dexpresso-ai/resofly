import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Calculator, FileDown, FileText, Layers, PenSquare, Plus, RotateCcw, Scale, Sparkles, Trash2, Upload } from 'lucide-react';
import type {
  AccountLedgerRow, AppData, JournalEntry, JournalLine, LedgerAccount, LedgerAccountType, PurchaseInvoice, PurchaseInvoiceLine, Supplier, TrialBalanceRow, UUID, VatCode,
} from '../types';
import { REPORT_GROUPS_BY_TYPE, REPORT_GROUP_LABELS } from '../types';
import { Modal } from '../components/Modal';
import { CsvImportModal } from '../components/CsvImportModal';
import type { ImportColumn } from '../lib/csvImport';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { dateNL, euro, uid } from '../lib/format';
import {
  bookPurchaseInvoice, createOpeningBalance, deleteRow, ensureDefaultLedgerAccounts, insertRow,
  openingBalancePlugAccount,
  postManualJournalEntry, reportAccountLedger, reportTrialBalance, reverseJournalEntry, updateRow,
} from '../lib/repository';
import { downloadXaf } from '../lib/xaf';
import { uploadToR2 } from '../lib/r2';
import { scanInvoice, SCAN_ACCEPT, SCAN_MAX_BYTES, type ScanResult } from '../lib/invoice-scan-api';

// Vaste kolommen voor de bulk CSV-import van leveranciers (crediteuren).
const SUPPLIER_IMPORT_COLUMNS: ImportColumn[] = [
  { key: 'name', header: 'Naam', required: true, example: 'Groothandel BV' },
  { key: 'supplier_code', header: 'Leverancierscode', example: 'L-001' },
  { key: 'contact_name', header: 'Contactpersoon', example: 'Piet Pietersen' },
  { key: 'email', header: 'E-mail', kind: 'email', example: 'inkoop@groothandel.nl' },
  { key: 'phone', header: 'Telefoon', example: '020-7654321' },
  { key: 'address_line1', header: 'Adres', example: 'Industrieweg 1' },
  { key: 'postal_code', header: 'Postcode', example: '1234 AB' },
  { key: 'city', header: 'Plaats', example: 'Amsterdam' },
  { key: 'country', header: 'Land', default: 'Nederland', example: 'Nederland' },
  { key: 'vat_number', header: 'BTW-nummer', example: 'NL001234567B01' },
  { key: 'kvk_number', header: 'KvK-nummer', example: '12345678' },
  { key: 'iban', header: 'IBAN', example: 'NL00BANK0123456789' },
  { key: 'notes', header: 'Notities', example: '' },
  {
    key: 'status', header: 'Status', kind: 'enum', default: 'active', example: 'Actief',
    enumValues: { actief: 'active', active: 'active', inactief: 'inactive', inactive: 'inactive' },
  },
];

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);

type PageProps = {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onChanged: () => void;
};

/** Banner die verschijnt zolang het rekeningschema nog niet geseed is. */
export function SetupBanner({ organizationId, canWrite, onChanged }: { organizationId: string; canWrite: boolean; onChanged: () => void }) {
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
  const [importing, setImporting] = useState(false);
  const expenseAccounts = data.ledgerAccounts.filter(a => a.type === 'expense' || a.type === 'asset');

  return (
    <div className="bk-page">
      {data.ledgerAccounts.length === 0 && <SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      <div className="bk-head">
        <div><h2>Leveranciers</h2><p>Crediteuren voor je inkoopfacturen.</p></div>
        <div className="bk-head-actions">
          <Button disabled={!canWrite} onClick={() => setImporting(true)}><Upload size={15} /> Importeren</Button>
          <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Nieuwe leverancier</Button>
        </div>
      </div>
      {importing && <CsvImportModal
        title="Leveranciers importeren"
        entityLabel="leveranciers"
        columns={SUPPLIER_IMPORT_COLUMNS}
        templateFilename="leveranciers-import-voorbeeld.csv"
        importRow={(record) => insertRow<Supplier>('suppliers', organizationId, record).then(() => undefined)}
        onClose={() => setImporting(false)}
        onDone={onChanged}
      />}
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

/** Header-totalen: BTW per (kostenrekening, btw-code, tarief)-groep afgerond, dan
 *  gesommeerd — identiek aan book_purchase_invoice (dat per zo'n groep boekt met
 *  round(Σbase * tarief/100)). Zo sluiten de opgeslagen totalen cent-exact aan op
 *  de crediteurenregel (1600) van de grootboekboeking, ook als twee regels met
 *  hetzelfde tarief op verschillende kostenrekeningen staan.
 *  fallbackAccountId spiegelt de server-coalesce van een lege rekening → 4500,
 *  zodat een blanco regel en een expliciete 4500-regel in dezelfde groep vallen. */
function purchaseTotals(lines: PurchaseInvoiceLine[], fallbackAccountId: UUID | null = null) {
  const groups = new Map<string, { base: number; rate: number }>();
  let subtotal = 0;
  for (const l of lines) {
    const base = Number(l.amount_cents) || 0;
    subtotal += base;
    const rate = l.vat_rate || 0;
    // Groepeer zoals de backend: op (account_id, vat_code, tarief). Een lege
    // rekening valt (net als server-side coalesce) op de vangnetrekening 4500.
    const account = l.account_id || fallbackAccountId || '';
    const key = `${account}|${(l.vat_code ?? '').trim()}|${rate}`;
    const g = groups.get(key);
    if (g) g.base += base;
    else groups.set(key, { base, rate });
  }
  let vat = 0;
  groups.forEach(g => { vat += Math.round((g.base * g.rate) / 100); });
  return { subtotal_cents: subtotal, vat_cents: vat, total_cents: subtotal + vat };
}

const purchaseStatusLabel: Record<PurchaseInvoice['status'], string> = {
  draft: 'Concept', booked: 'Geboekt', paid: 'Betaald', cancelled: 'Geannuleerd',
};

export function PurchaseInvoicesPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<PurchaseInvoice | 'new' | null>(null);
  const [seed, setSeed] = useState<InvoiceFormSeed | null>(null);
  const [scan, setScan] = useState(false);
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
        <div className="bk-head-actions">
          <Button disabled={!canWrite || notReady} onClick={() => setScan(true)} title="Lees een factuur automatisch uit: UBL-e-facturen (XML) deterministisch, PDF/foto met AI"><Sparkles size={15} /> Factuur scannen (AI / UBL)</Button>
          <Button variant="primary" disabled={!canWrite || notReady} onClick={() => { setSeed(null); setEdit('new'); }}><Plus size={15} /> Nieuwe inkoopfactuur</Button>
        </div>
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
      {scan && <InvoiceScanModal data={data} organizationId={organizationId}
        onClose={() => setScan(false)}
        onSeed={s => { setScan(false); setSeed(s); setEdit('new'); }} />}
      {edit && <PurchaseInvoiceForm data={data} organizationId={organizationId} canWrite={canWrite}
        invoice={edit === 'new' ? null : edit} seed={edit === 'new' ? seed : null}
        onClose={() => { setEdit(null); setSeed(null); }}
        onSaved={() => { setEdit(null); setSeed(null); onChanged(); }} />}
    </div>
  );
}

// ── AI-factuurscan: uitlezen → voorstel → vooringevuld concept ────────────────

const CONFIDENCE_LABEL: Record<'high' | 'medium' | 'low', string> = { high: 'hoog', medium: 'gemiddeld', low: 'laag' };

interface NewSupplierPayload {
  name: string; vat_number: string | null; kvk_number: string | null; iban: string | null;
  email: string | null; phone: string | null; address_line1: string | null; postal_code: string | null;
  city: string | null; country: string | null; default_expense_account_id: UUID | null; default_vat_code: string | null;
}

/** Vooringevuld voorstel dat de scan (AI of UBL) doorgeeft aan het inkoopfactuurformulier. */
interface InvoiceFormSeed {
  supplierId: UUID | null;
  newSupplier: NewSupplierPayload | null;
  /** Herkomst van het concept: 'ai_scan' (Claude) of 'import' (UBL-e-factuur). */
  source: 'ai_scan' | 'import';
  form: { supplier_invoice_number: string; date: string; due_date: string; notes: string };
  lines: PurchaseInvoiceLine[];
  pendingFile: File | null;
  extractionMeta: Record<string, unknown>;
  ai: { confidence: 'high' | 'medium' | 'low'; warnings: string[] };
}

/** Upload een factuur → laat de AI hem uitlezen → toon het voorstel → neem over in een concept. */
function InvoiceScanModal({ data, organizationId, onClose, onSeed }: {
  data: AppData; organizationId: string; onClose: () => void; onSeed: (seed: InvoiceFormSeed) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accountLabel = (id: string | null) => {
    const a = id ? data.ledgerAccounts.find(x => x.id === id) : null;
    return a ? `${a.code} · ${a.name}` : '— (vangnet bij boeken)';
  };
  const vatLabel = (code: string) => data.vatCodes.find(v => v.code === code)?.label ?? code;

  function pick(f: File | null) {
    setError(null); setResult(null);
    if (!f) { setFile(null); return; }
    if (f.size > SCAN_MAX_BYTES) { setError(`Bestand is te groot (max ${Math.round(SCAN_MAX_BYTES / 1024 / 1024)} MB).`); return; }
    setFile(f);
  }

  async function run() {
    if (!file) return;
    setBusy(true); setError(null);
    try { setResult(await scanInvoice(organizationId, file)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Uitlezen mislukt.'); }
    finally { setBusy(false); }
  }

  function apply() {
    if (!result || !file) return;
    const p = result.proposal;
    const lines: PurchaseInvoiceLine[] = p.lines.length
      ? p.lines.map(l => ({ id: uid(), description: l.description, amount_cents: l.amount_cents, vat_code: l.vat_code, vat_rate: l.vat_rate, account_id: l.account_id }))
      : [{ id: uid(), description: '', amount_cents: 0, vat_code: 'HOOG', vat_rate: 21, account_id: null }];
    onSeed({
      supplierId: p.supplier.matchedId,
      source: result.method === 'ubl' ? 'import' : 'ai_scan',
      newSupplier: p.supplier.matchedId ? null : {
        name: p.supplier.name || 'Onbekende leverancier',
        vat_number: p.supplier.vat_number, kvk_number: p.supplier.kvk_number, iban: p.supplier.iban,
        email: p.supplier.email, phone: p.supplier.phone, address_line1: p.supplier.address_line1,
        postal_code: p.supplier.postal_code, city: p.supplier.city, country: p.supplier.country,
        default_expense_account_id: p.supplier.default_expense_account_id, default_vat_code: p.supplier.default_vat_code,
      },
      form: {
        supplier_invoice_number: p.supplier_invoice_number ?? '',
        date: p.date ?? new Date().toISOString().slice(0, 10),
        due_date: p.due_date ?? '',
        notes: p.notes ?? '',
      },
      lines,
      pendingFile: file,
      extractionMeta: result.extraction_meta,
      ai: { confidence: p.confidence, warnings: p.warnings },
    });
  }

  const p = result?.proposal ?? null;
  const matchedSupplierName = p?.supplier.matchedId ? data.suppliers.find(s => s.id === p.supplier.matchedId)?.name : null;

  return (
    <Modal className="bk-modal-wide" title="Factuur scannen (AI)" onClose={onClose}
      footer={<div className="bk-foot">
        <span className="bk-spacer" />
        <Button onClick={onClose}>Annuleren</Button>
        {!result
          ? <Button variant="primary" onClick={run} disabled={!file || busy}>{busy ? 'Uitlezen…' : 'Uitlezen'}</Button>
          : <Button variant="primary" onClick={apply}>Overnemen in concept →</Button>}
      </div>}>
      {error && <div className="error">{error}</div>}

      {!p ? (
        <>
          <p className="bk-muted">Upload een inkoopfactuur als PDF, foto of UBL-e-factuur (XML). E-facturen worden exact uitgelezen (zonder AI); PDF's en foto's leest de AI uit. Je controleert alles daarna in het concept — er wordt niets automatisch geboekt.</p>
          <div
            className={`bk-dropzone${dragOver ? ' is-over' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); pick(e.dataTransfer.files?.[0] ?? null); }}
          >
            <Upload size={22} />
            {file
              ? <div><strong>{file.name}</strong><div className="bk-muted">{(file.size / 1024).toFixed(0)} kB — klik om te wijzigen</div></div>
              : <div>Sleep een factuur hierheen of <span className="bk-link">kies een bestand</span><div className="bk-muted">PDF, JPG, PNG, WEBP, GIF of UBL-XML · max {Math.round(SCAN_MAX_BYTES / 1024 / 1024)} MB</div></div>}
          </div>
          <input ref={inputRef} type="file" accept={SCAN_ACCEPT} style={{ display: 'none' }}
            onChange={e => pick(e.target.files?.[0] ?? null)} />
          {busy && <div className="bk-note">De factuur wordt uitgelezen — dit kan ongeveer 10 seconden duren.</div>}
        </>
      ) : (
        <div className="bk-scan-review">
          <div className="bk-note bk-ai-note">
            {result?.method === 'ubl'
              ? <strong><Sparkles size={13} /> E-factuur (UBL) — exact uitgelezen, zonder AI</strong>
              : <strong><Sparkles size={13} /> Uitgelezen voorstel</strong>}
            {' '}— controleer alles voordat je het overneemt.{result?.method !== 'ubl' && <> Betrouwbaarheid: {CONFIDENCE_LABEL[p.confidence]}.</>}
            {p.warnings.length > 0 && <ul className="bk-ai-warnings">{p.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          </div>
          <div className="bk-grid2">
            <Field label="Leverancier">
              <div className="bk-scan-val">
                <strong>{p.supplier.name || '—'}</strong>{' '}
                {p.supplier.matchedId
                  ? <span className="status-pill">bestaand{matchedSupplierName && matchedSupplierName !== p.supplier.name ? `: ${matchedSupplierName}` : ''}</span>
                  : <span className="status-pill">nieuw — wordt aangemaakt</span>}
                {p.supplier.vat_number && <div className="bk-muted">BTW: {p.supplier.vat_number}</div>}
                {p.supplier.iban && <div className="bk-muted">IBAN: {p.supplier.iban}</div>}
              </div>
            </Field>
            <Field label="Factuurgegevens">
              <div className="bk-scan-val">
                <div>Factuurnr.: <strong>{p.supplier_invoice_number || '—'}</strong></div>
                <div>Datum: <strong>{p.date ? dateNL(p.date) : '—'}</strong></div>
                {p.due_date && <div>Vervalt: {dateNL(p.due_date)}</div>}
              </div>
            </Field>
          </div>

          <div className="bk-scan-lines">
            <table className="bk-table">
              <thead><tr><th>Omschrijving</th><th>Grootboek</th><th>BTW</th><th className="bk-num">Excl.</th></tr></thead>
              <tbody>{p.lines.map((l, i) => (
                <tr key={i}>
                  <td>{l.description || '—'}</td>
                  <td className={l.account_id ? '' : 'bk-muted'}>{accountLabel(l.account_id)}</td>
                  <td>{vatLabel(l.vat_code)}</td>
                  <td className="bk-num">{euroCents(l.amount_cents)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          <div className="bk-totals">
            <div><span>Subtotaal</span><strong>{euroCents(p.totals.subtotal_cents)}</strong></div>
            <div><span>BTW</span><strong>{euroCents(p.totals.vat_cents)}</strong></div>
            <div className="bk-total-grand"><span>Totaal</span><strong>{euroCents(p.totals.total_cents)}</strong></div>
            {p.extracted_totals?.total_cents != null && p.extracted_totals.total_cents !== p.totals.total_cents && (
              <div className="bk-muted">Op de factuur vermeld totaal: {euroCents(p.extracted_totals.total_cents)}</div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function PurchaseInvoiceForm({ data, organizationId, canWrite, invoice, seed, onClose, onSaved }: {
  data: AppData; organizationId: string; canWrite: boolean; invoice: PurchaseInvoice | null; seed?: InvoiceFormSeed | null;
  onClose: () => void; onSaved: () => void;
}) {
  const expenseAccounts = useMemo(() => data.ledgerAccounts.filter(a => a.type === 'expense' || a.type === 'asset'), [data.ledgerAccounts]);
  // Vangnetrekening voor regels zonder gekozen grootboek (spiegelt de server-coalesce → 4500).
  const fallbackAccountId = useMemo(() => data.ledgerAccounts.find(a => a.code === '4500')?.id ?? null, [data.ledgerAccounts]);
  const defaultVat = data.vatCodes.find(v => v.code === 'HOOG') ?? data.vatCodes[0];
  const today = new Date().toISOString().slice(0, 10);
  const readOnly = !canWrite || (invoice != null && invoice.status !== 'draft');

  const [form, setForm] = useState<Record<string, any>>(() => invoice ? {
    supplier_id: invoice.supplier_id ?? '', supplier_invoice_number: invoice.supplier_invoice_number ?? '',
    internal_number: invoice.internal_number ?? '', date: invoice.date, due_date: invoice.due_date ?? '',
    project_id: invoice.project_id ?? '', notes: invoice.notes ?? '',
  } : seed ? {
    supplier_id: seed.supplierId ?? (seed.newSupplier ? '__new__' : ''),
    supplier_invoice_number: seed.form.supplier_invoice_number,
    internal_number: nextPurchaseNumber(data), date: seed.form.date || today, due_date: seed.form.due_date,
    project_id: '', notes: seed.form.notes,
  } : {
    supplier_id: '', supplier_invoice_number: '', internal_number: nextPurchaseNumber(data), date: today, due_date: '', project_id: '', notes: '',
  });
  const [lines, setLines] = useState<PurchaseInvoiceLine[]>(() => invoice?.lines?.length
    ? invoice.lines
    : seed?.lines?.length
    ? seed.lines
    : [{ id: uid(), description: '', amount_cents: 0, vat_code: defaultVat?.code ?? 'HOOG', vat_rate: defaultVat?.rate ?? 21, account_id: null }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const updateLine = (id: string, patch: Partial<PurchaseInvoiceLine>) =>
    setLines(ls => ls.map(l => l.id === id ? { ...l, ...patch } : l));
  const addLine = () => setLines(ls => [...ls, { id: uid(), description: '', amount_cents: 0, vat_code: defaultVat?.code ?? 'HOOG', vat_rate: defaultVat?.rate ?? 21, account_id: null }]);
  const removeLine = (id: string) => setLines(ls => ls.length > 1 ? ls.filter(l => l.id !== id) : ls);

  const totals = purchaseTotals(lines, fallbackAccountId);

  async function save() {
    if (!form.supplier_id) { setError('Kies een leverancier.'); return; }
    if (form.supplier_id === '__new__' && !seed?.newSupplier) { setError('Kies een leverancier.'); return; }
    const cleaned = lines.filter(l => String(l.description || '').trim() || Number(l.amount_cents));
    if (cleaned.length === 0) { setError('Voeg minimaal één regel toe.'); return; }
    setBusy(true); setError(null);
    try {
      // Nieuwe leverancier uit de AI-scan? Maak hem aan en gebruik zijn id.
      let supplierId = form.supplier_id as string;
      if (form.supplier_id === '__new__' && seed?.newSupplier) {
        const createdSupplier = await insertRow<Supplier>('suppliers', organizationId, { ...seed.newSupplier, status: 'active' });
        supplierId = createdSupplier.id;
      }
      const t = purchaseTotals(cleaned, fallbackAccountId);
      const values = {
        supplier_id: supplierId, supplier_invoice_number: form.supplier_invoice_number || null,
        internal_number: form.internal_number || nextPurchaseNumber(data), date: form.date, due_date: form.due_date || null,
        project_id: form.project_id || null, notes: form.notes || null, lines: cleaned,
        subtotal_cents: t.subtotal_cents, vat_cents: t.vat_cents, total_cents: t.total_cents,
      };
      if (invoice) {
        await updateRow<PurchaseInvoice>('purchase_invoices', invoice.id, values, organizationId);
      } else {
        const saved = await insertRow<PurchaseInvoice>('purchase_invoices', organizationId, {
          ...values, status: 'draft', payment_status: 'unpaid',
          ...(seed ? { source: seed.source, extraction_meta: seed.extractionMeta } : {}),
        });
        // Originele factuur als bewijsstuk koppelen (best-effort: een R2-hapering
        // mag de al opgeslagen boeking niet blokkeren).
        if (seed?.pendingFile && saved?.id) {
          try { await uploadToR2(seed.pendingFile, organizationId, { entity_type: 'purchase_invoice', entity_id: saved.id }); }
          catch (uploadErr) { console.warn('Bijlage koppelen aan inkoopfactuur mislukt:', uploadErr); }
        }
      }
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
      {seed && (
        <div className="bk-note bk-ai-note">
          <strong><Sparkles size={13} /> {seed.source === 'import' ? 'E-factuur (UBL)' : 'AI-voorstel'}</strong> — controleer leverancier, grootboekrekeningen, BTW en bedragen voordat je opslaat.{seed.source !== 'import' && <> Betrouwbaarheid: {CONFIDENCE_LABEL[seed.ai.confidence]}.</>}
          {seed.ai.warnings.length > 0 && <ul className="bk-ai-warnings">{seed.ai.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </div>
      )}
      {readOnly && invoice && invoice.status !== 'draft' && <div className="bk-note">Deze factuur is geboekt en kan niet meer worden gewijzigd. Corrigeren kan via een tegenboeking in het grootboek.</div>}
      <div className="bk-grid2">
        <Field label="Leverancier">
          <Select value={form.supplier_id || ''} onChange={e => {
            const sup = data.suppliers.find(s => s.id === e.target.value);
            set('supplier_id', e.target.value);
            if (sup?.default_expense_account_id) setLines(ls => ls.map(l => l.account_id ? l : { ...l, account_id: sup.default_expense_account_id }));
          }} disabled={readOnly}>
            <option value="">— kies —</option>
            {seed?.newSupplier && <option value="__new__">➕ Nieuwe leverancier: {seed.newSupplier.name}</option>}
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

/** Boekjaargrenzen (ondersteunt gebroken boekjaren via fiscal_year_start_month). */
function ledgerFiscalYearBounds(startMonth: number, year: number): { start: string; end: string; label: string } {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const start = `${year}-${p2(startMonth)}-01`;
  const endYear = startMonth === 1 ? year : year + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const end = `${endYear}-${p2(endMonth)}-${p2(new Date(endYear, endMonth, 0).getDate())}`;
  return { start, end, label: startMonth === 1 ? `${year}` : `${year}-${year + 1}` };
}

export function LedgerPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [tab, setTab] = useState<'journal' | 'accounts' | 'trial' | 'vat' | 'opening'>('journal');
  const [xafYear, setXafYear] = useState(new Date().getFullYear());
  const fiscalStartMonth = data.companySettings?.fiscal_year_start_month ?? 1;

  // Jaren waarin daadwerkelijk geboekt is (+ huidig jaar), voor de XAF-keuzelijst.
  const years = useMemo(() => {
    const set = new Set<number>([new Date().getFullYear()]);
    for (const e of data.journalEntries) set.add(Number(e.date.slice(0, 4)));
    return [...set].sort((a, b) => b - a);
  }, [data.journalEntries]);

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} /></div>;
  }

  function exportXaf() {
    const fy = ledgerFiscalYearBounds(fiscalStartMonth, xafYear);
    downloadXaf({ data, fiscalYearLabel: fy.label, startDate: fy.start, endDate: fy.end });
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><h2>Grootboek</h2><p>Journaalposten en rekeningschema — de basis onder je W&amp;V en BTW-aangifte.</p></div>
        <div className="bk-head-actions">
          <Select inline value={String(xafYear)} onChange={e => setXafYear(Number(e.target.value))}>
            {years.map(y => <option key={y} value={y}>{ledgerFiscalYearBounds(fiscalStartMonth, y).label}</option>)}
          </Select>
          <Button onClick={exportXaf} title="XML Auditfile Financieel 3.2 — voor je accountant of de Belastingdienst"><FileDown size={14} /> Auditfile (XAF)</Button>
        </div>
      </div>
      <div className="bk-tabs">
        <button className={tab === 'journal' ? 'is-active' : ''} onClick={() => setTab('journal')}><BookOpen size={15} /> Journaal</button>
        <button className={tab === 'accounts' ? 'is-active' : ''} onClick={() => setTab('accounts')}><Layers size={15} /> Rekeningschema</button>
        <button className={tab === 'trial' ? 'is-active' : ''} onClick={() => setTab('trial')}><Calculator size={15} /> Saldibalans</button>
        <button className={tab === 'vat' ? 'is-active' : ''} onClick={() => setTab('vat')}><FileDown size={15} /> BTW-codes</button>
        <button className={tab === 'opening' ? 'is-active' : ''} onClick={() => setTab('opening')}><Scale size={15} /> Beginbalans</button>
      </div>
      {tab === 'journal' && <JournalView data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      {tab === 'accounts' && <AccountsView data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      {tab === 'trial' && <TrialBalanceView data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      {tab === 'vat' && <VatCodesView vatCodes={data.vatCodes} />}
      {tab === 'opening' && <OpeningBalanceView data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
    </div>
  );
}

// ─────────────────────────── Saldibalans + grootboekkaart ───────────────────────────

/** Proef-/saldibalans per peildatum; elke rekening opent een klikbare grootboekkaart. */
function TrialBalanceView({ organizationId }: PageProps) {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<TrialBalanceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ledgerAccount, setLedgerAccount] = useState<{ id: UUID; code: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await reportTrialBalance(organizationId, asOf)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Saldibalans laden mislukt'); }
  }, [organizationId, asOf]);
  useEffect(() => { load(); }, [load]);

  const totalDebit = (rows ?? []).reduce((s, r) => s + r.debit_cents, 0);
  const totalCredit = (rows ?? []).reduce((s, r) => s + r.credit_cents, 0);
  const balanced = totalDebit === totalCredit;

  return (
    <div className="bk-accounts">
      <div className="bk-subhead">
        <p className="bk-muted">Per grootboekrekening het totaal geboekte debet en credit met het saldo t/m de peildatum — inclusief de jaarafsluiting, dus de werkelijke grootboekstand. Klik een rekening voor de grootboekkaart.</p>
        <Field label="Peildatum"><Input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></Field>
      </div>
      {error && <div className="error">{error}</div>}
      {rows === null
        ? <div className="bk-report-loading bk-muted">Saldibalans laden…</div>
        : rows.length === 0
        ? <div className="empty"><div className="e-big">Nog geen boekingen</div><p>Zodra je boekt, verschijnt hier de proef- en saldibalans.</p></div>
        : <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr><th>Rekening</th><th className="bk-num">Debet</th><th className="bk-num">Credit</th><th className="bk-num">Saldo</th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.account_id} className="bk-row" onClick={() => setLedgerAccount({ id: r.account_id, code: r.code, name: r.name })}>
                <td><strong>{r.code}</strong> · {r.name}</td>
                <td className="bk-num">{r.debit_cents ? euroCents(r.debit_cents) : ''}</td>
                <td className="bk-num">{r.credit_cents ? euroCents(r.credit_cents) : ''}</td>
                <td className="bk-num">{euroCents(r.balance_cents)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr className="bk-report-total">
              <td>Totaal · {balanced ? <span className="bk-balance-ok">✓ in balans</span> : <span className="bk-balance-bad">⚠ niet in balans</span>}</td>
              <td className="bk-num"><strong>{euroCents(totalDebit)}</strong></td>
              <td className="bk-num"><strong>{euroCents(totalCredit)}</strong></td>
              <td className="bk-num" />
            </tr></tfoot>
          </table></div>}
      {ledgerAccount && <AccountLedgerModal organizationId={organizationId} account={ledgerAccount} onClose={() => setLedgerAccount(null)} />}
    </div>
  );
}

/** Grootboekkaart: mutaties op één rekening in een periode, met beginsaldo en lopend saldo. */
function AccountLedgerModal({ organizationId, account, onClose }: {
  organizationId: string; account: { id: UUID; code: string; name: string }; onClose: () => void;
}) {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<AccountLedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setRows(await reportAccountLedger(organizationId, account.id, from, to)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Grootboekkaart laden mislukt'); }
  }, [organizationId, account.id, from, to]);
  useEffect(() => { load(); }, [load]);

  // De laatste rij draagt het eindsaldo (loopt door vanaf het beginsaldo).
  const endBalance = rows && rows.length > 0 ? rows[rows.length - 1].running_balance_cents : 0;
  const hasMovement = (rows ?? []).some(r => r.entry_id);

  return (
    <Modal className="bk-modal-wide" title={`Grootboekkaart ${account.code} · ${account.name}`} onClose={onClose}
      footer={<div className="bk-foot"><span className="bk-spacer" /><Button onClick={onClose}>Sluiten</Button></div>}>
      <div className="bk-form-grid">
        <Field label="Van"><Input type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="Tot en met"><Input type="date" value={to} onChange={e => setTo(e.target.value)} /></Field>
      </div>
      {error && <div className="error">{error}</div>}
      {rows === null
        ? <div className="bk-report-loading bk-muted">Grootboekkaart laden…</div>
        : <>
            <div className="bk-table-wrap"><table className="bk-table">
              <thead><tr><th>Datum</th><th>Boekstuk</th><th>Omschrijving</th><th className="bk-num">Debet</th><th className="bk-num">Credit</th><th className="bk-num">Saldo</th></tr></thead>
              <tbody>{rows.map((r, i) => (
                <tr key={r.entry_id ?? `open-${i}`} className={r.entry_id ? '' : 'bk-ledger-open'}>
                  <td>{r.date ? dateNL(r.date) : ''}</td>
                  <td>{r.entry_number || ''}</td>
                  <td>{r.description || '—'}</td>
                  <td className="bk-num">{r.debit_cents ? euroCents(r.debit_cents) : ''}</td>
                  <td className="bk-num">{r.credit_cents ? euroCents(r.credit_cents) : ''}</td>
                  <td className="bk-num">{euroCents(r.running_balance_cents)}</td>
                </tr>
              ))}</tbody>
              <tfoot><tr className="bk-report-total"><td colSpan={5}>Eindsaldo per {dateNL(to)}</td><td className="bk-num"><strong>{euroCents(endBalance)}</strong></td></tr></tfoot>
            </table></div>
            {!hasMovement && <p className="bk-muted">Geen mutaties in deze periode; alleen het beginsaldo wordt getoond.</p>}
          </>}
    </Modal>
  );
}

function JournalView({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMemorial, setShowMemorial] = useState(false);
  const [reversing, setReversing] = useState<JournalEntry | null>(null);
  const [reverseDate, setReverseDate] = useState(() => new Date().toISOString().slice(0, 10));
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

  function askReverse(entry: JournalEntry) {
    if (!canWrite) return;
    setError(null);
    setReverseDate(new Date().toISOString().slice(0, 10));
    setReversing(entry);
  }

  async function confirmReverse() {
    if (!reversing) return;
    const entry = reversing;
    setBusyId(entry.id); setError(null);
    try { await reverseJournalEntry(entry.id, reverseDate); setReversing(null); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Tegenboeken mislukt'); }
    finally { setBusyId(null); }
  }

  return (
    <div className="bk-journal">
      <div className="bk-subhead">
        <p className="bk-muted">Elke boeking — automatisch of handmatig — is een boekstuk. Met een memoriaalboeking corrigeer je vrij (afschrijving, privé-opname, correctie op een eerdere periode).</p>
        <Button variant="primary" disabled={!canWrite} onClick={() => setShowMemorial(true)}><PenSquare size={14} /> Memoriaalboeking</Button>
      </div>
      {error && <div className="error">{error}</div>}
      {showMemorial && (
        <MemorialModal
          data={data}
          organizationId={organizationId}
          onClose={() => setShowMemorial(false)}
          onSaved={() => { setShowMemorial(false); onChanged(); }}
        />
      )}
      {reversing && (
        <Modal title={`Boekstuk ${reversing.entry_number ?? ''} tegenboeken`} onClose={() => setReversing(null)}
          footer={<div className="bk-foot">
            <span className="bk-spacer" />
            <Button onClick={() => setReversing(null)}>Annuleren</Button>
            <Button variant="primary" onClick={confirmReverse} disabled={busyId === reversing.id}><RotateCcw size={14} /> {busyId === reversing.id ? 'Bezig…' : 'Tegenboeken'}</Button>
          </div>}>
          <p className="bk-muted">Er wordt een spiegelboeking gemaakt die {reversing.entry_number} neutraliseert. Kies de boekdatum van de tegenboeking (standaard vandaag); in een afgesloten periode boeken kan niet.</p>
          <Field label="Boekdatum tegenboeking"><Input type="date" value={reverseDate} onChange={e => setReverseDate(e.target.value)} /></Field>
        </Modal>
      )}
      {data.journalEntries.length === 0 && (
        <div className="empty"><div className="e-big">Nog geen journaalposten</div><p>Boek een inkoop- of verkoopfactuur om te beginnen, of maak een memoriaalboeking.</p></div>
      )}
      {data.journalEntries.map(entry => {
        const lines = linesByEntry.get(entry.id) ?? [];
        const debit = lines.reduce((s, l) => s + l.debit_cents, 0);
        const credit = lines.reduce((s, l) => s + l.credit_cents, 0);
        // Sinds fix 20260721: een tegengeboekt origineel blijft 'posted' (het paar
        // telt netto op tot nul); reversed_by_entry_id markeert het. status='reversed'
        // betekent "volledig uit de rapporten" en komt alleen nog van boekjaar-heropening.
        const isReversedPair = entry.reversed_by_entry_id != null;
        const isReversalEntry = entry.reverses_entry_id != null;
        const pill = entry.status === 'draft' ? 'Concept'
          : entry.status === 'reversed' ? 'Vervallen'
          : isReversedPair ? 'Tegengeboekt'
          : isReversalEntry ? 'Tegenboeking'
          : 'Geboekt';
        // Jaarafsluiting en resultaatbestemming zijn systeemboekstukken: die
        // draai je terug via "Boekjaar heropenen" respectievelijk "Bestemming
        // terugdraaien", zodat de bijbehorende administratie meebeweegt. Los
        // tegenboeken zou het boekjaar in een toestand achterlaten waar geen
        // van beide knoppen nog uit komt. De database weigert het ook.
        const canReverse = canWrite && entry.status === 'posted' && !isReversedPair
          && !['year_close', 'result_appropriation', 'corporate_tax'].includes(entry.source_type);
        return (
          <div key={entry.id} className={`bk-entry${entry.status === 'reversed' || isReversedPair ? ' is-reversed' : ''}`}>
            <div className="bk-entry-head">
              <div>
                <strong>{entry.entry_number}</strong>
                <span className="bk-muted"> · {dateNL(entry.date)} · {entry.description}</span>
              </div>
              <div className="bk-entry-actions">
                <span className={`status-pill bk-je-${isReversedPair ? 'reversed' : entry.status}`}>{pill}</span>
                {canReverse && (
                  <Button onClick={() => askReverse(entry)} disabled={busyId === entry.id}><RotateCcw size={13} /> {busyId === entry.id ? '…' : 'Tegenboeken'}</Button>
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

// ─────────────────────────────── Memoriaalboeking ───────────────────────────────

type MemorialLine = { key: string; account_id: string; description: string; debit: string; credit: string; vat_code: string; client_id: string; supplier_id: string; project_id: string };

const parseEuro = (v: string): number => Math.round((parseFloat(v.replace(',', '.')) || 0) * 100);

function MemorialModal({ data, organizationId, onClose, onSaved }: {
  data: AppData; organizationId: UUID; onClose: () => void; onSaved: () => void;
}) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState('');
  const emptyLine = (): MemorialLine => ({ key: uid(), account_id: '', description: '', debit: '', credit: '', vat_code: '', client_id: '', supplier_id: '', project_id: '' });
  const [lines, setLines] = useState<MemorialLine[]>([emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = data.ledgerAccounts.filter(a => a.is_active);
  const activeProjects = useMemo(() => data.projects.filter(p => !p.archived), [data.projects]);
  const accountById = useMemo(() => new Map(data.ledgerAccounts.map(a => [a.id, a])), [data.ledgerAccounts]);
  const update = (key: string, patch: Partial<MemorialLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const totalDebit = lines.reduce((s, l) => s + parseEuro(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + parseEuro(l.credit), 0);
  const diff = totalDebit - totalCredit;
  const filled = lines.filter(l => l.account_id && (parseEuro(l.debit) !== 0 || parseEuro(l.credit) !== 0));
  const canSave = !busy && description.trim().length > 0 && filled.length >= 2 && diff === 0;

  async function save() {
    if (!canSave) return;
    setBusy(true); setError(null);
    try {
      await postManualJournalEntry(organizationId, {
        date,
        description: description.trim(),
        lines: filled.map(l => {
          const debit = parseEuro(l.debit);
          const credit = parseEuro(l.credit);
          const account = accountById.get(l.account_id);
          const code = l.vat_code ? data.vatCodes.find(v => v.code === l.vat_code) : undefined;
          // Rubriek-metadata: de grondslag volgt de natuurlijke kant van de
          // rekening (omzet = credit − debet, kosten/activa = debet − credit),
          // zodat compute_vat_boxes de regel in de juiste rubriek kan tellen.
          const base = account?.type === 'revenue' ? credit - debit : debit - credit;
          return {
            account_id: l.account_id,
            description: l.description.trim() || null,
            debit_cents: debit,
            credit_cents: credit,
            // Tegenpartij/project meesturen zodat handmatige correcties op
            // debiteuren/crediteuren per partij meetellen in report_open_items.
            ...(l.client_id ? { client_id: l.client_id } : {}),
            ...(l.supplier_id ? { supplier_id: l.supplier_id } : {}),
            ...(l.project_id ? { project_id: l.project_id } : {}),
            ...(code ? {
              vat_code: code.code,
              vat_rate: code.rate,
              vat_base_cents: base,
              vat_amount_cents: Math.round(base * (code.rate / 100)),
            } : {}),
          };
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Boeken mislukt');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal className="bk-modal-wide" title="Memoriaalboeking" onClose={onClose}>
      <p className="bk-muted">Vrije journaalpost. Debet en credit moeten gelijk zijn; een btw-code op een omzet- of kostenregel zorgt dat de aangifte de grondslag in de juiste rubriek telt (boek de btw zelf op 1500/1510). Kies bij een debiteuren- of crediteurenregel de klant of leverancier, zodat de correctie in de openstaande posten per partij meetelt.</p>
      {error && <div className="error">{error}</div>}
      <div className="bk-form-grid">
        <Field label="Boekdatum" hint="In een afgesloten periode boeken kan niet; kies een datum in een open periode."><Input type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Omschrijving"><Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Bijv. correctie telefoonkosten Q1" /></Field>
      </div>
      <div className="bk-lines">
        <div className="bk-lines-head bk-lines-head-memorial"><span>Rekening</span><span>Omschrijving</span><span>Tegenpartij</span><span>Project</span><span>BTW</span><span className="bk-num">Debet</span><span className="bk-num">Credit</span><span /></div>
        {lines.map(l => {
          const acc = accountById.get(l.account_id);
          const isReceivable = acc?.subtype === 'accounts_receivable';
          const isPayable = acc?.subtype === 'accounts_payable';
          return (
          <div className="bk-line bk-line-memorial" key={l.key}>
            <Select value={l.account_id} onChange={e => update(l.key, { account_id: e.target.value, client_id: '', supplier_id: '' })}>
              <option value="">— rekening —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </Select>
            <Input value={l.description} placeholder="Omschrijving" onChange={e => update(l.key, { description: e.target.value })} />
            {isReceivable ? (
              <Select value={l.client_id} onChange={e => update(l.key, { client_id: e.target.value })} aria-label="Klant">
                <option value="">— klant —</option>
                {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            ) : isPayable ? (
              <Select value={l.supplier_id} onChange={e => update(l.key, { supplier_id: e.target.value })} aria-label="Leverancier">
                <option value="">— leverancier —</option>
                {data.suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            ) : (
              <Select value="" disabled aria-label="Tegenpartij niet van toepassing">
                <option value="">n.v.t.</option>
              </Select>
            )}
            <Select value={l.project_id} onChange={e => update(l.key, { project_id: e.target.value })} aria-label="Project">
              <option value="">— geen —</option>
              {activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Select value={l.vat_code} onChange={e => update(l.key, { vat_code: e.target.value })}>
              <option value="">— geen —</option>
              {data.vatCodes.filter(v => v.is_active).map(v => <option key={v.id} value={v.code}>{v.code}</option>)}
            </Select>
            <Input className="bk-num" type="number" step="0.01" min="0" value={l.debit} placeholder="0,00"
              onChange={e => update(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} />
            <Input className="bk-num" type="number" step="0.01" min="0" value={l.credit} placeholder="0,00"
              onChange={e => update(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} />
            <button className="bk-line-del" onClick={() => setLines(ls => (ls.length > 2 ? ls.filter(x => x.key !== l.key) : ls))} title="Regel verwijderen">×</button>
          </div>
          );
        })}
        <button className="bk-add-line" onClick={() => setLines(ls => [...ls, emptyLine()])}><Plus size={14} /> Regel toevoegen</button>
      </div>
      <div className="bk-totals">
        <div><span>Debet</span><strong>{euroCents(totalDebit)}</strong></div>
        <div><span>Credit</span><strong>{euroCents(totalCredit)}</strong></div>
        <div className={diff === 0 ? 'bk-balance-ok' : 'bk-balance-bad'}>
          {diff === 0 ? '✓ In balans' : `⚠ Verschil ${euroCents(Math.abs(diff))}`}
        </div>
      </div>
      <div className="bk-modal-actions">
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" onClick={save} disabled={!canSave}>{busy ? 'Bezig…' : 'Boeken'}</Button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────── Beginbalans ───────────────────────────────

type OpeningLine = { key: string; account_id: string; debit: string; credit: string };

function OpeningBalanceView({ data, organizationId, canWrite, onChanged }: PageProps) {
  const existing = useMemo(
    () => data.journalEntries.find(e => e.source_type === 'opening_balance' && e.status === 'posted' && !e.reversed_by_entry_id) ?? null,
    [data.journalEntries],
  );
  const emptyLine = (): OpeningLine => ({ key: uid(), account_id: '', debit: '', credit: '' });
  const [date, setDate] = useState(data.companySettings?.bookkeeping_start_date ?? `${new Date().getFullYear()}-01-01`);
  const [lines, setLines] = useState<OpeningLine[]>([emptyLine(), emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Welke rekening de sluitpost krijgt, hangt aan de rechtsvorm: bij een BV gaat
  // het meegebrachte vermogen naar de reserves, niet naar het aandelenkapitaal.
  // De database beslist dat; hier alleen ophalen zodat het scherm niet iets
  // anders belooft dan er geboekt wordt.
  const [plug, setPlug] = useState<{ code: string; name: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    openingBalancePlugAccount(organizationId)
      .then(row => { if (!cancelled) setPlug(row); })
      .catch(() => { /* val terug op de neutrale tekst hieronder */ });
    return () => { cancelled = true; };
  }, [organizationId]);
  const plugLabel = plug ? `${plug.code} ${plug.name}` : 'de eigen-vermogensrekening';

  const accountById = useMemo(() => new Map(data.ledgerAccounts.map(a => [a.id, a])), [data.ledgerAccounts]);
  // Beginbalans = balansstanden; W&V-rekeningen horen er niet in.
  const balanceAccounts = data.ledgerAccounts.filter(a => a.is_active && (a.type === 'asset' || a.type === 'liability' || a.type === 'equity'));
  const update = (key: string, patch: Partial<OpeningLine>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const totalDebit = lines.reduce((s, l) => s + parseEuro(l.debit), 0);
  const totalCredit = lines.reduce((s, l) => s + parseEuro(l.credit), 0);
  const equity = totalDebit - totalCredit;
  const filled = lines.filter(l => l.account_id && (parseEuro(l.debit) !== 0 || parseEuro(l.credit) !== 0));

  async function save() {
    if (!canWrite || filled.length === 0) return;
    if (!confirm(`Beginbalans per ${dateNL(date)} vastleggen? Het verschil van ${euroCents(Math.abs(equity))} wordt automatisch op ${plugLabel} gezet. Dit kan maar één keer.`)) return;
    setBusy(true); setError(null);
    try {
      await createOpeningBalance(organizationId, date, filled.map(l => ({
        account_id: l.account_id,
        description: `Beginbalans ${accountById.get(l.account_id)?.name ?? ''}`.trim(),
        debit_cents: parseEuro(l.debit),
        credit_cents: parseEuro(l.credit),
      })));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Beginbalans vastleggen mislukt');
    } finally {
      setBusy(false);
    }
  }

  if (existing) {
    const entryLines = data.journalLines.filter(l => l.entry_id === existing.id).sort((a, b) => a.line_index - b.line_index);
    return (
      <div className="bk-accounts">
        <p className="bk-muted">De beginbalans is vastgelegd op {dateNL(existing.date)} (boekstuk {existing.entry_number}). Klopt er iets niet, boek het boekstuk dan tegen via het Journaal en leg een nieuwe beginbalans vast.</p>
        <div className="bk-table-wrap"><table className="bk-table">
          <thead><tr><th>Rekening</th><th>Omschrijving</th><th className="bk-num">Debet</th><th className="bk-num">Credit</th></tr></thead>
          <tbody>{entryLines.map(l => {
            const a = accountById.get(l.account_id);
            return (
              <tr key={l.id}>
                <td>{a ? `${a.code} · ${a.name}` : l.account_id}</td>
                <td>{l.description || '—'}</td>
                <td className="bk-num">{l.debit_cents ? euroCents(l.debit_cents) : ''}</td>
                <td className="bk-num">{l.credit_cents ? euroCents(l.credit_cents) : ''}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </div>
    );
  }

  return (
    <div className="bk-accounts">
      <div className="bk-subhead">
        <p className="bk-muted">
          Stap je over van een ander pakket? Vul hier de eindbalans van je oude administratie in (banksaldo, openstaande debiteuren/crediteuren, activa).
          Het verschil tussen debet en credit wordt automatisch als eigen vermogen geboekt, zodat de balans sluit.
        </p>
        <Button variant="primary" disabled={!canWrite || busy || filled.length === 0} onClick={save}>{busy ? 'Bezig…' : 'Beginbalans vastleggen'}</Button>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="bk-form-grid">
        <Field label="Per datum" hint="Meestal de boekhoud-startdatum (zie Instellingen → Boekhouding)."><Input type="date" value={date} onChange={e => setDate(e.target.value)} disabled={!canWrite} /></Field>
      </div>
      <div className="bk-lines">
        <div className="bk-lines-head bk-lines-head-opening"><span>Rekening</span><span className="bk-num">Debet</span><span className="bk-num">Credit</span><span /></div>
        {lines.map(l => (
          <div className="bk-line bk-line-opening" key={l.key}>
            <Select value={l.account_id} onChange={e => update(l.key, { account_id: e.target.value })} disabled={!canWrite}>
              <option value="">— rekening —</option>
              {balanceAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </Select>
            <Input className="bk-num" type="number" step="0.01" min="0" value={l.debit} placeholder="0,00"
              onChange={e => update(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} disabled={!canWrite} />
            <Input className="bk-num" type="number" step="0.01" min="0" value={l.credit} placeholder="0,00"
              onChange={e => update(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} disabled={!canWrite} />
            <button className="bk-line-del" onClick={() => setLines(ls => (ls.length > 1 ? ls.filter(x => x.key !== l.key) : ls))} title="Regel verwijderen">×</button>
          </div>
        ))}
        <button className="bk-add-line" onClick={() => setLines(ls => [...ls, emptyLine()])}><Plus size={14} /> Regel toevoegen</button>
      </div>
      <div className="bk-totals">
        <div><span>Debet</span><strong>{euroCents(totalDebit)}</strong></div>
        <div><span>Credit</span><strong>{euroCents(totalCredit)}</strong></div>
        <div><span>Sluitpost eigen vermogen{plug ? ` (${plug.code})` : ''}</span><strong>{euroCents(Math.abs(equity))} {equity >= 0 ? 'credit' : 'debet'}</strong></div>
      </div>
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
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  /**
   * Het standaardschema opnieuw langslopen. Nodig zodra de rechtsvorm verandert:
   * een administratie die naar BV gaat heeft aandelenkapitaal, reserves en
   * vennootschapsbelasting nodig, en die kwamen tot nu toe pas bij de volgende
   * boeking binnen — zonder dat ergens te zien was. Bestaande rekeningen blijven
   * onaangeroerd; de RPC voegt alleen toe wat ontbreekt.
   */
  async function syncChart() {
    setSyncing(true); setSyncError(null); setSyncMessage(null);
    try {
      await ensureDefaultLedgerAccounts(organizationId);
      onChanged();
      // Niet melden wat er is toegevoegd: `data` is een prop van deze render en
      // verandert pas ná de herlaadronde, dus een telling vóór en ná zou altijd
      // gelijk zijn. De lijst hieronder ververst zichzelf en laat het resultaat
      // zien; dat is eerlijker dan een bericht dat er niets naast kan zitten.
      setSyncMessage('Het rekeningschema is nagelopen; ontbrekende rekeningen zijn toegevoegd.');
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : 'Bijwerken mislukt');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="bk-accounts">
      <div className="bk-subhead">
        <p className="bk-muted">Eigen rekeningen kun je vrij aanmaken en aanpassen. Systeemrekeningen zijn nodig voor het automatisch boeken en daarom beperkt bewerkbaar.</p>
        <div className="bk-head-actions">
          <Button disabled={!canWrite || syncing} onClick={syncChart} title="Voegt de rekeningen toe die bij je rechtsvorm horen en nog ontbreken">
            <RotateCcw size={14} /> {syncing ? 'Bezig…' : 'Schema bijwerken'}
          </Button>
          <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Nieuwe rekening</Button>
        </div>
      </div>
      {syncError && <div className="error">{syncError}</div>}
      {syncMessage && <p className="bk-note">{syncMessage}</p>}
      <div className="bk-table-wrap"><table className="bk-table">
        <thead><tr><th>Code</th><th>Naam</th><th>Type</th><th>Rubriek</th><th>Standaard BTW</th><th>Actief</th><th></th></tr></thead>
        <tbody>{data.ledgerAccounts.map(a => (
          <tr key={a.id} className={canWrite ? 'bk-row' : ''} onClick={() => canWrite && setEdit(a)}>
            <td><strong>{a.code}</strong></td>
            <td>{a.name}{a.is_system && <small className="bk-muted"> · systeem</small>}</td>
            <td>{accountTypeLabel[a.type]}</td>
            <td>{a.report_group ? REPORT_GROUP_LABELS[a.report_group] : <span className="bk-muted">—</span>}</td>
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
    code: account.code, name: account.name, type: account.type, report_group: account.report_group ?? '',
    is_restricted_reserve: account.is_restricted_reserve ?? false,
    subtype: account.subtype ?? '', default_vat_code: account.default_vat_code ?? '', is_active: account.is_active,
  } : { code: '', name: '', type: 'expense', report_group: 'overige_bedrijfskosten', is_restricted_reserve: false, subtype: '', default_vat_code: '', is_active: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));
  const isEquity = form.type === 'equity';

  async function save() {
    if (!isSystem && !String(form.code || '').trim()) { setError('Code is verplicht.'); return; }
    if (!String(form.name || '').trim()) { setError('Naam is verplicht.'); return; }
    setBusy(true); setError(null);
    try {
      if (account) {
        // Systeemrekeningen: alleen naam, BTW-standaard en rubriek mogen wijzigen. Code en
        // type worden door de boekings-RPC's op code opgezocht en moeten stabiel blijven; de
        // actief-status blijft óók vast, want anders zou een systeemrekening uit de
        // keuzelijsten verdwijnen terwijl automatische boekingen hem nog op code opzoeken.
        // De rubriek mag wél: die stuurt alleen de indeling van de overzichten, geen boeking.
        const patch = isSystem
          ? { name: form.name, default_vat_code: form.default_vat_code || null, report_group: form.report_group || null, is_restricted_reserve: isEquity && Boolean(form.is_restricted_reserve) }
          : { code: String(form.code).trim(), name: form.name, type: form.type, report_group: form.report_group || null, is_restricted_reserve: isEquity && Boolean(form.is_restricted_reserve), subtype: form.subtype || null, default_vat_code: form.default_vat_code || null, is_active: Boolean(form.is_active) };
        await updateRow<LedgerAccount>('ledger_accounts', account.id, patch, organizationId);
      } else {
        await insertRow<LedgerAccount>('ledger_accounts', organizationId, {
          code: String(form.code).trim(), name: form.name, type: form.type, report_group: form.report_group || null,
          is_restricted_reserve: isEquity && Boolean(form.is_restricted_reserve),
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
      {isSystem && <div className="bk-note">Dit is een systeemrekening. De code, het type en de actief-status liggen vast omdat het automatisch boeken deze rekening op code opzoekt — je kunt wel de naam, de standaard-BTW en de rubriek aanpassen.</div>}
      <div className="bk-grid2">
        <Field label="Code" hint="Bijv. 4600 of 8040"><Input value={form.code} onChange={e => set('code', e.target.value)} disabled={!canWrite || isSystem} /></Field>
        <Field label="Naam"><Input value={form.name} onChange={e => set('name', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Type" hint="Bepaalt of de rekening in de balans of de W&amp;V valt.">
          <Select
            value={form.type}
            onChange={e => {
              const type = e.target.value as LedgerAccountType;
              // Bij een ander type past de oude rubriek meestal niet meer; val
              // dan terug op de eerste die er wél bij hoort.
              const allowed = REPORT_GROUPS_BY_TYPE[type];
              setForm(f => ({ ...f, type, report_group: allowed.includes(f.report_group) ? f.report_group : allowed[0] }));
            }}
            disabled={!canWrite || isSystem}
          >
            {ACCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
        <Field label="Rubriek" hint="Waar de rekening in de balans of de W&amp;V wordt opgeteld (Titel 9 Boek 2 BW).">
          <Select value={form.report_group || ''} onChange={e => set('report_group', e.target.value)} disabled={!canWrite}>
            <option value="">— nog niet ingedeeld —</option>
            {(REPORT_GROUPS_BY_TYPE[form.type as LedgerAccountType] ?? []).map(g => (
              <option key={g} value={g}>{REPORT_GROUP_LABELS[g]}</option>
            ))}
          </Select>
        </Field>
      </div>
      {/* De rubriek geldt met terugwerkende kracht: de balans groepeert op de
          rubriek zoals die NU is, ook in de vergelijkende kolom. Dat is precies
          de "stelselwijziging" die art. 2:363 lid 4/5 BW alleen om gegronde
          redenen toestaat, mét toelichting. Wij kunnen dat niet afdwingen, maar
          de gebruiker hoort het wel te weten op het moment dat hij het doet. */}
      {account && (form.report_group || null) !== (account.report_group ?? null) && (
        <div className="bk-note">
          Let op: de balans en de W&amp;V groeperen op de rubriek zoals die nú is — óók de
          vergelijkende cijfers van eerdere perioden. Een eerder uitgedraaid overzicht
          kan er daardoor anders uitzien dan een nieuwe uitdraai van dezelfde periode.
        </div>
      )}
      <div className="bk-grid2">
        <Field label="Standaard BTW-code" hint="Optioneel.">
          <Select value={form.default_vat_code || ''} onChange={e => set('default_vat_code', e.target.value)} disabled={!canWrite}>
            <option value="">— geen —</option>
            {data.vatCodes.map(v => <option key={v.id} value={v.code}>{v.label}</option>)}
          </Select>
        </Field>
      </div>
      {/* Alleen bij eigen vermogen: de balanstest voor een dividendbesluit
          (art. 2:216 lid 1 BW) mag niets uitkeren boven het eigen vermogen
          minus de reserves die de wet of de statuten verplicht aanhouden. Een
          statutaire reserve staat in de statuten van deze BV — die kunnen wij
          niet raden, dus die wijst de gebruiker hier aan. */}
      {isEquity && (
        <label className="bk-setting-check">
          <input type="checkbox" checked={Boolean(form.is_restricted_reserve)} onChange={e => set('is_restricted_reserve', e.target.checked)} disabled={!canWrite} />
          <span>
            Wettelijke of statutaire reserve — niet uitkeerbaar
            <small className="bk-muted"> · telt niet mee als vrij uitkeerbaar vermogen bij een dividendbesluit. Uitvinken verruimt de balanstest van art. 2:216 lid 1 BW; doe dat alleen als de reserve echt vrij is.</small>
          </span>
        </label>
      )}
      <label className="bk-setting-check bk-account-active">
        <input type="checkbox" checked={Boolean(form.is_active)} onChange={e => set('is_active', e.target.checked)} disabled={!canWrite || isSystem} />
        <span>Actief (verschijnt in keuzelijsten bij het boeken){isSystem && <small className="bk-muted"> · systeemrekening blijft altijd actief</small>}</span>
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
