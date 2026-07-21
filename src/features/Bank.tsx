import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Banknote, Check, Landmark, Link2, Plus, RefreshCw, RotateCcw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type {
  AppData, BankAccount, BankInstitution, BankRequisition, BankRule, BankTransaction, Invoice, LedgerAccount, PurchaseInvoice,
} from '../types';
import { Modal } from '../components/Modal';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { dateNL, euro } from '../lib/format';
import { SetupBanner } from './Bookkeeping';
import { parseBankFile } from '../lib/bankImport';
import {
  bookBankTransaction, createBankRequisition, deleteRow, finalizeBankRequisition, importBankTransactions,
  insertRow, listBankInstitutions, matchBankTransactions, setBankTransactionStatus, syncBankAccount,
  unbookBankTransaction, updateRow,
} from '../lib/repository';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);

type PageProps = { data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="bk-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function BankPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  // Na de bank-redirect komen we terug met ?code=&state=… → meteen het tabblad
  // "Rekeningen & koppeling" tonen zodat de afronding zichtbaar is.
  const hasReturnCode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('code');
  const [tab, setTab] = useState<'reconcile' | 'accounts' | 'rules'>(hasReturnCode ? 'accounts' : 'reconcile');

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} /></div>;
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><h2>Bank</h2><p>Lees je bankafschriften in en boek ze automatisch — W&amp;V en balans werken direct bij.</p></div>
      </div>
      <div className="bk-tabs">
        <button className={tab === 'reconcile' ? 'is-active' : ''} onClick={() => setTab('reconcile')}><Banknote size={15} /> Af te letteren</button>
        <button className={tab === 'accounts' ? 'is-active' : ''} onClick={() => setTab('accounts')}><Landmark size={15} /> Rekeningen &amp; koppeling</button>
        <button className={tab === 'rules' ? 'is-active' : ''} onClick={() => setTab('rules')}><Sparkles size={15} /> Regels</button>
      </div>
      {tab === 'reconcile' && <ReconcileTab data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      {tab === 'accounts' && <AccountsTab data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
      {tab === 'rules' && <RulesTab data={data} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
    </div>
  );
}

// ───────────────────────────── Af te letteren ─────────────────────────────

type StatusFilter = 'open' | 'booked' | 'ignored';

function ReconcileTab({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);

  const accountName = (id: string) => data.bankAccounts.find(a => a.id === id)?.name ?? '—';

  const transactions = useMemo(() => {
    return data.bankTransactions.filter(t => {
      if (accountFilter !== 'all' && t.bank_account_id !== accountFilter) return false;
      if (filter === 'open') return t.status === 'unmatched' || t.status === 'suggested';
      if (filter === 'booked') return t.status === 'booked';
      return t.status === 'ignored';
    });
  }, [data.bankTransactions, filter, accountFilter]);

  const openCount = data.bankTransactions.filter(t => t.status === 'unmatched' || t.status === 'suggested').length;

  async function runMatch() {
    if (!canWrite) return;
    setMatching(true); setError(null);
    try { await matchBankTransactions(organizationId); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Matchen mislukt'); }
    finally { setMatching(false); }
  }

  if (data.bankAccounts.length === 0) {
    return <div className="empty"><div className="e-big">Nog geen bankrekening</div><p>Maak eerst een bankrekening aan onder “Rekeningen &amp; koppeling” en lees een afschrift in.</p></div>;
  }

  return (
    <div className="bank-reconcile">
      {error && <div className="error">{error}</div>}
      <div className="bank-toolbar">
        <div className="bk-seg bk-seg-sm">
          <button className={filter === 'open' ? 'is-active' : ''} onClick={() => setFilter('open')}>Openstaand ({openCount})</button>
          <button className={filter === 'booked' ? 'is-active' : ''} onClick={() => setFilter('booked')}>Geboekt</button>
          <button className={filter === 'ignored' ? 'is-active' : ''} onClick={() => setFilter('ignored')}>Genegeerd</button>
        </div>
        <span className="bk-spacer" />
        {data.bankAccounts.length > 1 && (
          <Select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}>
            <option value="all">Alle rekeningen</option>
            {data.bankAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        )}
        <Button disabled={!canWrite || matching} onClick={runMatch}><Sparkles size={14} /> {matching ? 'Bezig…' : 'Opnieuw matchen'}</Button>
      </div>

      {transactions.length === 0
        ? <div className="empty"><div className="e-big">Niets te zien</div><p>{filter === 'open' ? 'Alle transacties zijn afgehandeld.' : 'Geen transacties in deze weergave.'}</p></div>
        : <div className="bank-tx-list">
            {transactions.map(txn => (
              <BankTxRow key={txn.id} txn={txn} data={data} organizationId={organizationId} canWrite={canWrite}
                accountName={accountName(txn.bank_account_id)} onChanged={onChanged} />
            ))}
          </div>}
    </div>
  );
}

function BankTxRow({ txn, data, organizationId, canWrite, accountName, onChanged }: {
  txn: BankTransaction; data: AppData; organizationId: string; canWrite: boolean; accountName: string; onChanged: () => void;
}) {
  const incoming = txn.amount_cents > 0;
  const abs = Math.abs(txn.amount_cents);
  const [mode, setMode] = useState<'invoice' | 'purchase' | 'account'>(
    incoming ? (txn.matched_invoice_id ? 'invoice' : 'account') : (txn.matched_purchase_invoice_id ? 'purchase' : 'account'),
  );
  const [invoiceId, setInvoiceId] = useState<string>(txn.matched_invoice_id ?? '');
  const [purchaseId, setPurchaseId] = useState<string>(txn.matched_purchase_invoice_id ?? '');
  const [accountId, setAccountId] = useState<string>(txn.suggested_account_id ?? '');
  const [vatCode, setVatCode] = useState<string>(txn.suggested_vat_code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useMemo(() => data.ledgerAccounts.filter(a => a.is_active), [data.ledgerAccounts]);
  // Alleen documenten die in het grootboek staan zijn afletterbaar (fix 20260721):
  // zonder debitering van 1300/creditering van 1600 zou de bankboeking de
  // debiteuren-/crediteurenstand negatief maken — de server weigert die nu ook.
  const openInvoices = useMemo(
    () => data.invoices.filter(i => i.status !== 'cancelled' && i.status !== 'void' && i.journal_entry_id != null).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [data.invoices],
  );
  const openPurchases = useMemo(
    () => data.purchaseInvoices.filter(p => p.status !== 'cancelled' && p.journal_entry_id != null).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [data.purchaseInvoices],
  );
  const clientName = (id: string | null) => data.clients.find(c => c.id === id)?.name ?? '';
  const supplierName = (id: string | null) => data.suppliers.find(s => s.id === id)?.name ?? '';

  async function book() {
    if (!canWrite) return;
    if (mode === 'invoice' && !invoiceId) { setError('Kies een verkoopfactuur.'); return; }
    if (mode === 'purchase' && !purchaseId) { setError('Kies een inkoopfactuur.'); return; }
    if (mode === 'account' && !accountId) { setError('Kies een grootboekrekening.'); return; }
    setBusy(true); setError(null);
    try {
      if (mode === 'invoice') await bookBankTransaction(organizationId, txn.id, { matchedInvoiceId: invoiceId });
      else if (mode === 'purchase') await bookBankTransaction(organizationId, txn.id, { matchedPurchaseInvoiceId: purchaseId });
      else await bookBankTransaction(organizationId, txn.id, { lines: [{ account_id: accountId, amount_cents: abs, vat_code: vatCode || null, description: txn.counterparty_name || txn.description || 'Banktransactie' }] });
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Boeken mislukt'); }
    finally { setBusy(false); }
  }

  async function ignore() {
    if (!canWrite) return;
    setBusy(true); setError(null);
    try { await setBankTransactionStatus(organizationId, txn.id, 'ignored'); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Mislukt'); }
    finally { setBusy(false); }
  }
  async function reopen() {
    if (!canWrite) return;
    setBusy(true); setError(null);
    try { await setBankTransactionStatus(organizationId, txn.id, 'unmatched'); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Mislukt'); }
    finally { setBusy(false); }
  }
  async function unbook() {
    if (!canWrite || !confirm('Deze geboekte transactie terugdraaien (tegenboeking in het grootboek)?')) return;
    setBusy(true); setError(null);
    try { await unbookBankTransaction(organizationId, txn.id); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Terugdraaien mislukt'); }
    finally { setBusy(false); }
  }

  const isOpen = txn.status === 'unmatched' || txn.status === 'suggested';

  return (
    <div className={`bank-tx bank-tx-${txn.status}`}>
      <div className="bank-tx-main">
        <div className="bank-tx-date">{dateNL(txn.booking_date)}</div>
        <div className="bank-tx-info">
          <strong>{txn.counterparty_name || txn.description || 'Transactie'}</strong>
          <small className="bk-muted">
            {accountName}
            {txn.counterparty_iban ? ` · ${txn.counterparty_iban}` : ''}
            {txn.description && txn.counterparty_name ? ` · ${txn.description}` : ''}
          </small>
          {isOpen && txn.match_confidence === 'tax_authority' && (
            <small className="bank-tx-hint">Herkend als Belastingdienst — voorgesteld: omzetbelasting (1530). De aangifte met dit saldo wordt bij boeken automatisch op “Betaald” gezet.</small>
          )}
        </div>
        <div className={`bank-tx-amount ${incoming ? 'bk-pos' : 'bk-neg'}`}>{incoming ? '+ ' : '− '}{euroCents(abs)}</div>
      </div>

      {error && <div className="error bank-tx-error">{error}</div>}

      {isOpen && (
        <div className="bank-tx-actions">
          <div className="bk-seg bk-seg-sm bank-mode">
            {incoming
              ? <button className={mode === 'invoice' ? 'is-active' : ''} onClick={() => setMode('invoice')}>Verkoopfactuur</button>
              : <button className={mode === 'purchase' ? 'is-active' : ''} onClick={() => setMode('purchase')}>Inkoopfactuur</button>}
            <button className={mode === 'account' ? 'is-active' : ''} onClick={() => setMode('account')}>Grootboekrekening</button>
          </div>

          {mode === 'invoice' && (
            <>
              <Select value={invoiceId} onChange={e => setInvoiceId(e.target.value)} disabled={!canWrite}>
                <option value="">— kies factuur —</option>
                {openInvoices.map((i: Invoice) => (
                  <option key={i.id} value={i.id}>{i.number} · {euro(i.total_amount ?? 0)}{clientName(i.client_id) ? ` · ${clientName(i.client_id)}` : ''}</option>
                ))}
              </Select>
              {openInvoices.length === 0 && (
                <small className="bank-tx-hint">Geen afletterbare facturen: alleen facturen die in het grootboek staan kun je afletteren. Gebruik eerst “Boek naar grootboek” op de factuur.</small>
              )}
            </>
          )}
          {mode === 'purchase' && (
            <>
              <Select value={purchaseId} onChange={e => setPurchaseId(e.target.value)} disabled={!canWrite}>
                <option value="">— kies inkoopfactuur —</option>
                {openPurchases.map((p: PurchaseInvoice) => (
                  <option key={p.id} value={p.id}>{p.internal_number || p.supplier_invoice_number || '—'} · {euroCents(p.total_cents)}{supplierName(p.supplier_id) ? ` · ${supplierName(p.supplier_id)}` : ''}</option>
                ))}
              </Select>
              {openPurchases.length === 0 && (
                <small className="bank-tx-hint">Geen afletterbare inkoopfacturen: boek de inkoopfactuur eerst naar het grootboek.</small>
              )}
            </>
          )}
          {mode === 'account' && (
            <>
              <Select value={accountId} onChange={e => setAccountId(e.target.value)} disabled={!canWrite}>
                <option value="">— grootboekrekening —</option>
                {accounts.map((a: LedgerAccount) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </Select>
              <Select value={vatCode} onChange={e => setVatCode(e.target.value)} disabled={!canWrite}>
                <option value="">Geen BTW</option>
                {data.vatCodes.map(v => <option key={v.id} value={v.code}>{v.label}</option>)}
              </Select>
            </>
          )}

          <span className="bk-spacer" />
          <Button onClick={ignore} disabled={!canWrite || busy} title="Negeren"><X size={14} /> Negeren</Button>
          <Button variant="primary" onClick={book} disabled={!canWrite || busy}><Check size={14} /> {busy ? 'Boeken…' : 'Boeken'}</Button>
        </div>
      )}

      {txn.status === 'booked' && (
        <div className="bank-tx-actions">
          <span className="status-pill bk-status-booked">Geboekt</span>
          <span className="bk-spacer" />
          {canWrite && <Button onClick={unbook} disabled={busy}><RotateCcw size={13} /> {busy ? '…' : 'Terugdraaien'}</Button>}
        </div>
      )}
      {txn.status === 'ignored' && (
        <div className="bank-tx-actions">
          <span className="bk-muted">Genegeerd</span>
          <span className="bk-spacer" />
          {canWrite && <Button onClick={reopen} disabled={busy}>Weer openen</Button>}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Rekeningen & koppeling ─────────────────────────

function AccountsTab({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<BankAccount | 'new' | null>(null);
  const [connect, setConnect] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const lastImport = (a: BankAccount) =>
    a.last_imported_at ? `Laatste import ${dateNL(a.last_imported_at.slice(0, 10))}` : 'Nog niets ingelezen';
  const lastSync = (a: BankAccount) =>
    a.last_synced_at ? `Laatst gesynct ${dateNL(a.last_synced_at.slice(0, 10))}` : 'Nog niet gesynct';
  const reqFor = (a: BankAccount): BankRequisition | undefined =>
    data.bankRequisitions.find(r => r.id === a.bank_requisition_id);

  // Afronden van de bankkoppeling na de redirect (?code=&state=…). Eénmalig.
  const finalizedRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state || finalizedRef.current) return;
    finalizedRef.current = true;
    // Verwijder de querystring uit de URL zodat een refresh niet opnieuw afrondt.
    const clean = window.location.origin + window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', clean);
    setFinalizing(true); setBanner(null);
    finalizeBankRequisition(organizationId, { code, state })
      .then(res => {
        if (res.status === 'linked') setBanner({ kind: 'ok', text: `Bank gekoppeld: ${res.linked} rekening(en), ${res.imported} transacties opgehaald.` });
        else if (res.status === 'expired') setBanner({ kind: 'err', text: 'De toestemming is verlopen of geweigerd. Probeer de koppeling opnieuw.' });
        else setBanner({ kind: 'err', text: 'De koppeling is nog niet voltooid. Rond de toestemming bij je bank af en probeer opnieuw.' });
        onChanged();
      })
      .catch(e => setBanner({ kind: 'err', text: e instanceof Error ? e.message : 'Afronden van de koppeling mislukt.' }))
      .finally(() => setFinalizing(false));
  }, [organizationId, onChanged]);

  async function sync(a: BankAccount) {
    if (!canWrite) return;
    setSyncingId(a.id); setBanner(null);
    try {
      const res = await syncBankAccount(organizationId, a.id);
      const r = res.results[0];
      if (res.needsReconsent) setBanner({ kind: 'err', text: 'De banktoestemming is verlopen. Koppel de bank opnieuw via "Koppel bank".' });
      else if (r?.error) setBanner({ kind: 'err', text: `Synchroniseren mislukt: ${r.error}` });
      else setBanner({ kind: 'ok', text: `${r?.inserted ?? 0} nieuwe, ${r?.skipped ?? 0} al bekende transacties.` });
      onChanged();
    } catch (e) { setBanner({ kind: 'err', text: e instanceof Error ? e.message : 'Synchroniseren mislukt' }); }
    finally { setSyncingId(null); }
  }

  return (
    <div className="bk-page">
      <div className="bk-subhead">
        <p className="bk-muted">Koppel elke bankrekening aan een grootboekrekening (meestal 1100 Bank). Lees afschriften in (CAMT.053, MT940 of CSV) of koppel je bank direct (PSD2) voor automatisch ophalen.</p>
        <div className="bank-subhead-actions">
          <Button disabled={!canWrite || finalizing} onClick={() => setConnect(true)}><Link2 size={15} /> Koppel bank</Button>
          <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Handmatige rekening</Button>
        </div>
      </div>

      {finalizing && <div className="bk-note">Koppeling afronden…</div>}
      {banner && <div className={banner.kind === 'ok' ? 'bk-note' : 'error'}>{banner.text}</div>}

      {data.bankAccounts.length === 0
        ? <div className="empty"><div className="e-big">Nog geen bankrekeningen</div></div>
        : <div className="bank-accounts">
            {data.bankAccounts.map(a => {
              const ledger = data.ledgerAccounts.find(l => l.id === a.ledger_account_id);
              const count = data.bankTransactions.filter(t => t.bank_account_id === a.id).length;
              const linked = a.source !== 'import';
              const req = reqFor(a);
              const expired = req?.status === 'expired';
              return (
                <div key={a.id} className="bank-account-card">
                  <div className="bank-account-head">
                    <div>
                      <strong>{a.name}{linked && <span className="bank-tag">gekoppeld</span>}</strong>
                      <small className="bk-muted">{a.iban || 'geen IBAN'}{ledger ? ` · ${ledger.code} ${ledger.name}` : ''}</small>
                    </div>
                    <button className="bk-cell-action" onClick={() => setEdit(a)} disabled={!canWrite}>Bewerk</button>
                  </div>
                  {expired && <div className="bank-reconsent"><AlertTriangle size={14} /> Toestemming verlopen — koppel de bank opnieuw via "Koppel bank".</div>}
                  <div className="bank-account-meta">
                    <span className="bk-muted">{count} transacties · {linked ? lastSync(a) : lastImport(a)}</span>
                    <span className="bk-spacer" />
                    {linked
                      ? <Button disabled={!canWrite || syncingId === a.id} onClick={() => sync(a)}><RefreshCw size={14} /> {syncingId === a.id ? 'Synchroniseren…' : 'Synchroniseer'}</Button>
                      : <ImportButton account={a} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />}
                  </div>
                </div>
              );
            })}
          </div>}

      {edit && <BankAccountForm data={data} organizationId={organizationId} canWrite={canWrite}
        account={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
      {connect && <BankConnectModal organizationId={organizationId} onClose={() => setConnect(false)} />}
    </div>
  );
}

function BankConnectModal({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const [institutions, setInstitutions] = useState<BankInstitution[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listBankInstitutions(organizationId)
      .then(list => { if (active) setInstitutions(list); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Banken ophalen mislukt'); });
    return () => { active = false; };
  }, [organizationId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (institutions ?? []).filter(i => !q || i.name.toLowerCase().includes(q));
  }, [institutions, query]);

  async function pick(inst: BankInstitution) {
    setBusy(inst.id); setError(null);
    try {
      // De bank stuurt na toestemming terug naar deze URL met ?code=&state=… erachter.
      const redirectUrl = window.location.origin + window.location.pathname;
      const { link } = await createBankRequisition(organizationId, { institutionId: inst.id, institutionName: inst.name, redirectUrl });
      window.location.assign(link);
    } catch (e) { setError(e instanceof Error ? e.message : 'Koppeling starten mislukt'); setBusy(null); }
  }

  return (
    <Modal title="Koppel een bank" onClose={onClose}
      footer={<div className="bk-foot"><span className="bk-spacer" /><Button onClick={onClose}>Sluiten</Button></div>}>
      {error && <div className="error">{error}</div>}
      <p className="bk-muted">Kies je bank. Je wordt doorgestuurd naar de bank om toestemming te geven (PSD2); daarna komen je transacties automatisch binnen.</p>
      <div className="bank-inst-search"><Search size={15} /><Input value={query} placeholder="Zoek je bank…" onChange={e => setQuery(e.target.value)} /></div>
      {institutions === null && !error
        ? <div className="bk-report-loading bk-muted">Banken laden…</div>
        : <div className="bank-inst-list">
            {filtered.map(inst => (
              <button key={inst.id} className="bank-inst" disabled={busy !== null} onClick={() => pick(inst)}>
                {inst.logo ? <img src={inst.logo} alt="" className="bank-inst-logo" /> : <span className="bank-inst-logo bank-inst-logo-fallback"><Landmark size={16} /></span>}
                <span className="bank-inst-name">{inst.name}</span>
                {busy === inst.id && <span className="bk-muted">Doorsturen…</span>}
              </button>
            ))}
            {filtered.length === 0 && <div className="bk-muted">Geen banken gevonden.</div>}
          </div>}
    </Modal>
  );
}

function ImportButton({ account, organizationId, canWrite, onChanged }: { account: BankAccount; organizationId: string; canWrite: boolean; onChanged: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const parsed = await parseBankFile(file);
      if (parsed.transactions.length === 0) throw new Error('Geen transacties in dit bestand gevonden.');
      const res = await importBankTransactions(organizationId, account.id, parsed);
      setMsg(`${res.inserted} nieuw, ${res.skipped} al bekend (${parsed.format.toUpperCase()}).`);
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : 'Inlezen mislukt'); }
    finally { setBusy(false); }
  }

  return (
    <span className="bank-import">
      <input ref={inputRef} type="file" accept=".xml,.940,.sta,.mt940,.csv,.txt,text/xml,text/csv" style={{ display: 'none' }} onChange={onFile} />
      <Button disabled={!canWrite || busy} onClick={() => inputRef.current?.click()}><Upload size={14} /> {busy ? 'Inlezen…' : 'Afschrift inlezen'}</Button>
      {msg && <small className="bank-import-msg">{msg}</small>}
      {error && <small className="error bank-import-msg">{error}</small>}
    </span>
  );
}

function BankAccountForm({ data, organizationId, canWrite, account, onClose, onSaved }: {
  data: AppData; organizationId: string; canWrite: boolean; account: BankAccount | null; onClose: () => void; onSaved: () => void;
}) {
  const bankAccounts = useMemo(() => data.ledgerAccounts.filter(a => a.type === 'asset'), [data.ledgerAccounts]);
  const defaultLedger = data.ledgerAccounts.find(a => a.subtype === 'bank') ?? data.ledgerAccounts.find(a => a.code === '1100');
  const [form, setForm] = useState<Record<string, any>>(() => account ? {
    name: account.name, iban: account.iban ?? '', currency: account.currency, ledger_account_id: account.ledger_account_id, is_active: account.is_active,
  } : { name: '', iban: '', currency: 'EUR', ledger_account_id: defaultLedger?.id ?? '', is_active: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!String(form.name || '').trim()) { setError('Naam is verplicht.'); return; }
    if (!form.ledger_account_id) { setError('Kies een grootboekrekening.'); return; }
    setBusy(true); setError(null);
    try {
      const values = { name: form.name, iban: form.iban || null, currency: form.currency || 'EUR', ledger_account_id: form.ledger_account_id, is_active: Boolean(form.is_active) };
      account ? await updateRow<BankAccount>('bank_accounts', account.id, values, organizationId)
              : await insertRow<BankAccount>('bank_accounts', organizationId, { ...values, source: 'import' });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); setBusy(false); }
  }

  async function remove() {
    if (!account || !confirm('Bankrekening verwijderen? De ingelezen transacties verdwijnen ook.')) return;
    setBusy(true); setError(null);
    try { await deleteRow('bank_accounts', account.id, organizationId); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt'); setBusy(false); }
  }

  return (
    <Modal title={account ? 'Bankrekening bewerken' : 'Nieuwe bankrekening'} onClose={onClose}
      footer={<div className="bk-foot">
        {account && canWrite && <Button variant="danger" onClick={remove} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
        <span className="bk-spacer" />
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" onClick={save} disabled={!canWrite || busy}>{busy ? 'Bezig…' : 'Opslaan'}</Button>
      </div>}>
      {error && <div className="error">{error}</div>}
      <div className="bk-grid2">
        <Field label="Naam" hint="Bijv. Rabobank zakelijk"><Input value={form.name} onChange={e => set('name', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="IBAN"><Input value={form.iban} onChange={e => set('iban', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Valuta"><Input value={form.currency} onChange={e => set('currency', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Grootboekrekening" hint="Meestal 1100 Bank. Geef elke rekening een eigen grootboekrekening.">
          <Select value={form.ledger_account_id || ''} onChange={e => set('ledger_account_id', e.target.value)} disabled={!canWrite}>
            <option value="">— kies —</option>
            {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </Field>
      </div>
      <label className="bk-setting-check bk-account-active">
        <input type="checkbox" checked={Boolean(form.is_active)} onChange={e => set('is_active', e.target.checked)} disabled={!canWrite} />
        <span>Actief</span>
      </label>
    </Modal>
  );
}

// ──────────────────────────────── Regels ────────────────────────────────

const directionLabel: Record<BankRule['match_direction'], string> = { in: 'Ontvangsten', out: 'Betalingen', both: 'Beide' };

function RulesTab({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<BankRule | 'new' | null>(null);
  const accountName = (id: string | null) => { const a = data.ledgerAccounts.find(x => x.id === id); return a ? `${a.code} · ${a.name}` : '—'; };

  return (
    <div className="bk-page">
      <div className="bk-subhead">
        <p className="bk-muted">Regels stellen automatisch een grootboekrekening voor bij herkende transacties (bv. bankkosten). Zet “Automatisch boeken” aan om ze direct te boeken zodra ze binnenkomen.</p>
        <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Nieuwe regel</Button>
      </div>
      {data.bankRules.length === 0
        ? <div className="empty"><div className="e-big">Nog geen regels</div></div>
        : <div className="bk-table-wrap"><table className="bk-table">
            <thead><tr><th>Naam</th><th>Richting</th><th>Voorwaarde</th><th>Boekt op</th><th>Auto</th><th></th></tr></thead>
            <tbody>{data.bankRules.map(r => (
              <tr key={r.id} className={canWrite ? 'bk-row' : ''} onClick={() => canWrite && setEdit(r)}>
                <td><strong>{r.name}</strong>{!r.is_active && <small className="bk-muted"> · uit</small>}</td>
                <td>{directionLabel[r.match_direction]}</td>
                <td className="bk-muted">{[
                  r.match_counterparty_iban && `IBAN ${r.match_counterparty_iban}`,
                  r.match_counterparty_name_contains && `naam bevat “${r.match_counterparty_name_contains}”`,
                  r.match_description_contains && `omschrijving bevat “${r.match_description_contains}”`,
                  r.match_amount_cents != null && `bedrag ${euroCents(r.match_amount_cents)}`,
                ].filter(Boolean).join(', ') || '—'}</td>
                <td>{accountName(r.target_account_id)}{r.target_vat_code ? ` · ${r.target_vat_code}` : ''}</td>
                <td>{r.auto_book ? 'Ja' : <span className="bk-muted">Nee</span>}</td>
                <td className="bk-cell-action">{canWrite ? 'Bewerk' : ''}</td>
              </tr>
            ))}</tbody>
          </table></div>}
      {edit && <BankRuleForm data={data} organizationId={organizationId} canWrite={canWrite}
        rule={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
    </div>
  );
}

function BankRuleForm({ data, organizationId, canWrite, rule, onClose, onSaved }: {
  data: AppData; organizationId: string; canWrite: boolean; rule: BankRule | null; onClose: () => void; onSaved: () => void;
}) {
  const accounts = useMemo(() => data.ledgerAccounts.filter(a => a.is_active), [data.ledgerAccounts]);
  const [form, setForm] = useState<Record<string, any>>(() => rule ? {
    name: rule.name, priority: rule.priority, match_direction: rule.match_direction,
    match_counterparty_iban: rule.match_counterparty_iban ?? '', match_counterparty_name_contains: rule.match_counterparty_name_contains ?? '',
    match_description_contains: rule.match_description_contains ?? '', match_amount: rule.match_amount_cents != null ? String(rule.match_amount_cents / 100) : '',
    target_account_id: rule.target_account_id ?? '', target_vat_code: rule.target_vat_code ?? '', auto_book: rule.auto_book, is_active: rule.is_active,
  } : {
    name: '', priority: 100, match_direction: 'both', match_counterparty_iban: '', match_counterparty_name_contains: '',
    match_description_contains: '', match_amount: '', target_account_id: '', target_vat_code: '', auto_book: false, is_active: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    if (!String(form.name || '').trim()) { setError('Naam is verplicht.'); return; }
    if (form.auto_book && !form.target_account_id) { setError('Automatisch boeken vereist een grootboekrekening.'); return; }
    setBusy(true); setError(null);
    try {
      const amountStr = String(form.match_amount).trim();
      const values = {
        name: form.name, priority: Number(form.priority) || 100, match_direction: form.match_direction,
        match_counterparty_iban: form.match_counterparty_iban || null,
        match_counterparty_name_contains: form.match_counterparty_name_contains || null,
        match_description_contains: form.match_description_contains || null,
        match_amount_cents: amountStr ? Math.round(parseFloat(amountStr) * 100) : null,
        target_account_id: form.target_account_id || null, target_vat_code: form.target_vat_code || null,
        auto_book: Boolean(form.auto_book), is_active: Boolean(form.is_active),
      };
      rule ? await updateRow<BankRule>('bank_rules', rule.id, values, organizationId)
           : await insertRow<BankRule>('bank_rules', organizationId, values);
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Opslaan mislukt'); setBusy(false); }
  }

  async function remove() {
    if (!rule || !confirm('Regel verwijderen?')) return;
    setBusy(true); setError(null);
    try { await deleteRow('bank_rules', rule.id, organizationId); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Verwijderen mislukt'); setBusy(false); }
  }

  return (
    <Modal title={rule ? 'Regel bewerken' : 'Nieuwe regel'} onClose={onClose}
      footer={<div className="bk-foot">
        {rule && canWrite && <Button variant="danger" onClick={remove} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
        <span className="bk-spacer" />
        <Button onClick={onClose}>Annuleren</Button>
        <Button variant="primary" onClick={save} disabled={!canWrite || busy}>{busy ? 'Bezig…' : 'Opslaan'}</Button>
      </div>}>
      {error && <div className="error">{error}</div>}
      <div className="bk-grid2">
        <Field label="Naam"><Input value={form.name} onChange={e => set('name', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Prioriteit" hint="Lager = eerst."><Input type="number" value={form.priority} onChange={e => set('priority', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Richting">
          <Select value={form.match_direction} onChange={e => set('match_direction', e.target.value)} disabled={!canWrite}>
            <option value="both">Beide</option>
            <option value="in">Alleen ontvangsten</option>
            <option value="out">Alleen betalingen</option>
          </Select>
        </Field>
        <Field label="Bedrag is exact" hint="Optioneel, in euro's."><Input value={form.match_amount} onChange={e => set('match_amount', e.target.value)} disabled={!canWrite} placeholder="bv. 12,50" /></Field>
        <Field label="Tegenrekening (IBAN) is"><Input value={form.match_counterparty_iban} onChange={e => set('match_counterparty_iban', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Naam bevat"><Input value={form.match_counterparty_name_contains} onChange={e => set('match_counterparty_name_contains', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Omschrijving bevat"><Input value={form.match_description_contains} onChange={e => set('match_description_contains', e.target.value)} disabled={!canWrite} /></Field>
        <Field label="Boek op grootboekrekening">
          <Select value={form.target_account_id || ''} onChange={e => set('target_account_id', e.target.value)} disabled={!canWrite}>
            <option value="">— kies —</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </Field>
        <Field label="BTW-code">
          <Select value={form.target_vat_code || ''} onChange={e => set('target_vat_code', e.target.value)} disabled={!canWrite}>
            <option value="">Geen</option>
            {data.vatCodes.map(v => <option key={v.id} value={v.code}>{v.label}</option>)}
          </Select>
        </Field>
      </div>
      <label className="bk-setting-check bk-account-active">
        <input type="checkbox" checked={Boolean(form.auto_book)} onChange={e => set('auto_book', e.target.checked)} disabled={!canWrite} />
        <span>Automatisch boeken zodra een transactie hieraan voldoet</span>
      </label>
      <label className="bk-setting-check bk-account-active">
        <input type="checkbox" checked={Boolean(form.is_active)} onChange={e => set('is_active', e.target.checked)} disabled={!canWrite} />
        <span>Actief</span>
      </label>
    </Modal>
  );
}
