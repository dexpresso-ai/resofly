import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Banknote, Check, Landmark, Link2, PenSquare, Plus, RefreshCw, RotateCcw, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import type {
  AppData, BankAccount, BankAllocationCandidates, BankAllocationKind, BankInstitution, BankOpenDocument, BankPsuType,
  BankReconciliation, BankRequisition, BankRule, BankTransaction, LedgerAccount,
} from '../types';
import { Modal } from '../components/Modal';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { PageIcon } from '../components/PageIcon';
import { dateNL, euro } from '../lib/format';
import { SetupBanner } from './Bookkeeping';
import { parseBankFile } from '../lib/bankImport';
import { consentState, isCancelledBankReturn, isSandboxLink, readBankReturn } from '../lib/bankLink';
import {
  bookBankTransaction, createBankRequisition, createManualBankTransaction, deleteManualBankTransaction, deleteRow,
  fetchBankAllocationCandidates, finalizeBankRequisition, importBankTransactions, insertRow, listBankInstitutions,
  matchBankTransactions, mergeBankTransactions, PossibleDuplicateBankTransactionError, selectBankReconciliation,
  setBankTransactionStatus, syncBankAccount, unbookBankTransaction, unmergeBankTransaction, updateManualBankTransaction, updateRow,
} from '../lib/repository';
import { parseDutchAmountCents } from '../lib/money';
import { amsterdamTodayIso } from '../lib/dates';
import {
  addLine, allocationPayload, allocationState, buildManualIndex, centsToInput, manualMatchesFor, naturalAmount, putRemainder,
  removeLine, suggestAllocations, type AllocationPayload, type DraftAllocation,
} from '../lib/bankAllocation';

const euroCents = (cents: number | null | undefined) => euro((cents ?? 0) / 100);

type PageProps = { data: AppData; organizationId: string; canWrite: boolean; onChanged: () => void };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="bk-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function BankPage({ data, organizationId, canWrite, onChanged }: PageProps) {
  // Na de bank-redirect komen we terug met ?code=&state=… (of ?error=&state=…) →
  // meteen het tabblad "Rekeningen & koppeling" tonen zodat de afronding zichtbaar is.
  const hasReturnCode = typeof window !== 'undefined' && readBankReturn(window.location.search) !== null;
  const [tab, setTab] = useState<'reconcile' | 'accounts' | 'rules'>(hasReturnCode ? 'accounts' : 'reconcile');

  if (data.ledgerAccounts.length === 0) {
    return <div className="bk-page"><SetupBanner organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} /></div>;
  }

  return (
    <div className="bk-page">
      <div className="bk-head">
        <div><PageIcon page="bank" /><h2>Bank</h2><p>Lees afschriften in, koppel je bank of voer mutaties zelf in, en boek ze — W&amp;V en balans werken direct bij.</p></div>
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
  const [notice, setNotice] = useState<string | null>(null);
  const [matching, setMatching] = useState(false);
  const [manualEdit, setManualEdit] = useState<BankTransaction | 'new' | null>(null);
  const [candidates, setCandidates] = useState<BankAllocationCandidates | null>(null);

  // Wat er per factuur openstaat, rekent de database (Mollie, creditnota's en
  // eerdere bankboekingen tellen mee). Opnieuw na elke wijziging die dat raakt.
  useEffect(() => {
    let active = true;
    fetchBankAllocationCandidates(organizationId)
      .then(result => { if (active) setCandidates(result); })
      .catch(() => { if (active) setCandidates(null); });
    return () => { active = false; };
  }, [organizationId, data.bankTransactions, data.bankAllocations, data.invoices, data.purchaseInvoices, data.journalEntries]);

  const accountName = (id: string) => data.bankAccounts.find(a => a.id === id)?.name ?? '—';

  // Een bankregel die een handmatige mutatie bevestigt, hoort bij die mutatie:
  // hij staat niet los in de lijst (status 'merged'), maar onder de mutatie.
  const partnerOf = useMemo(() => {
    const map = new Map<string, BankTransaction>();
    for (const t of data.bankTransactions) if (t.status === 'merged' && t.merged_into_id) map.set(t.merged_into_id, t);
    return map;
  }, [data.bankTransactions]);

  // Eén keer per weergave, niet per rij: op een rekening met duizenden open
  // transacties werd per-rij zoeken kwadratisch traag.
  const manualIndex = useMemo(() => buildManualIndex(data.bankTransactions), [data.bankTransactions]);
  const everBookedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of data.bankAllocations) ids.add(a.bank_transaction_id);
    for (const e of data.journalEntries) if (e.source_type === 'payment' && e.source_id) ids.add(e.source_id);
    return ids;
  }, [data.bankAllocations, data.journalEntries]);

  const transactions = useMemo(() => {
    return data.bankTransactions.filter(t => {
      if (t.status === 'merged') return false;
      if (accountFilter !== 'all' && t.bank_account_id !== accountFilter) return false;
      if (filter === 'open') return t.status === 'unmatched' || t.status === 'suggested';
      if (filter === 'booked') return t.status === 'booked';
      return t.status === 'ignored';
    });
  }, [data.bankTransactions, filter, accountFilter]);

  const openCount = data.bankTransactions.filter(t => t.status === 'unmatched' || t.status === 'suggested').length;

  async function runMatch() {
    if (!canWrite) return;
    setMatching(true); setError(null); setNotice(null);
    try {
      const res = await matchBankTransactions(organizationId);
      if (res.merged > 0) setNotice(`${res.merged} ${res.merged === 1 ? 'bankregel bevestigt' : 'bankregels bevestigen'} een mutatie die je zelf invoerde; samengevoegd.`);
      onChanged();
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Matchen mislukt'); }
    finally { setMatching(false); }
  }

  if (data.bankAccounts.length === 0) {
    return <div className="empty"><div className="e-big">Nog geen bankrekening</div><p>Maak eerst een bankrekening aan onder “Rekeningen &amp; koppeling” en lees een afschrift in, of voer mutaties met de hand in.</p></div>;
  }

  return (
    <div className="bank-reconcile">
      {error && <div className="error">{error}</div>}
      {notice && <div className="bk-note">{notice}</div>}
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
        <Button disabled={!canWrite} onClick={() => setManualEdit('new')}><Plus size={14} /> Mutatie invoeren</Button>
        <Button disabled={!canWrite || matching} onClick={runMatch}><Sparkles size={14} /> {matching ? 'Bezig…' : 'Opnieuw matchen'}</Button>
      </div>

      {transactions.length === 0
        ? <div className="empty"><div className="e-big">Niets te zien</div><p>{filter === 'open' ? 'Alle transacties zijn afgehandeld.' : 'Geen transacties in deze weergave.'}</p></div>
        : <div className="bank-tx-list">
            {transactions.map(txn => (
              <BankTxRow key={txn.id} txn={txn} data={data} organizationId={organizationId} canWrite={canWrite}
                accountName={accountName(txn.bank_account_id)} candidates={candidates}
                partner={partnerOf.get(txn.id) ?? null}
                manualMatches={txn.status === 'unmatched' || txn.status === 'suggested' ? manualMatchesFor(txn, manualIndex) : []}
                everBooked={txn.status === 'booked' || everBookedIds.has(txn.id)}
                onEditManual={setManualEdit} onChanged={onChanged} />
            ))}
          </div>}

      {manualEdit && (
        <ManualTxModal data={data} organizationId={organizationId}
          txn={manualEdit === 'new' ? null : manualEdit}
          defaultAccountId={accountFilter !== 'all' ? accountFilter : null}
          onClose={() => setManualEdit(null)}
          onSaved={() => { setManualEdit(null); onChanged(); }} />
      )}
    </div>
  );
}

const KIND_LABEL: Record<BankAllocationKind, string> = {
  sales_invoice: 'Verkoopfactuur',
  sales_credit_note: 'Terugbetaling creditnota',
  purchase_invoice: 'Inkoopfactuur',
  ledger: 'Grootboekrekening',
};

function BankTxRow({ txn, data, organizationId, canWrite, accountName, candidates, partner, manualMatches, everBooked, onEditManual, onChanged }: {
  txn: BankTransaction; data: AppData; organizationId: string; canWrite: boolean; accountName: string;
  candidates: BankAllocationCandidates | null;
  /** Bij een handmatige mutatie: de bankregel die hem bevestigt. */
  partner: BankTransaction | null;
  /** Bij een openstaande bankregel: handmatige mutaties met dezelfde rekening en hetzelfde bedrag. */
  manualMatches: BankTransaction[];
  /**
   * Ooit geboekt (en misschien teruggedraaid)? Dan verwijzen die boekingen
   * ernaar en blijft de mutatie bewaard; de database weigert verwijderen dan ook.
   */
  everBooked: boolean;
  onEditManual: (txn: BankTransaction) => void;
  onChanged: () => void;
}) {
  const incoming = txn.amount_cents > 0;
  const abs = Math.abs(txn.amount_cents);
  const manual = Boolean(txn.is_manual);
  const isOpen = txn.status === 'unmatched' || txn.status === 'suggested';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mergeChoice, setMergeChoice] = useState<string>('');
  // De kandidaten kunnen pas na de eerste weergave verschijnen (een mutatie die
  // je net invoerde); zonder keuze geldt de dichtstbijzijnde.
  const mergeWith = manualMatches.some(m => m.id === mergeChoice) ? mergeChoice : manualMatches[0]?.id ?? '';

  async function run(action: () => Promise<unknown>, fallback: string) {
    if (!canWrite) return;
    setBusy(true); setError(null);
    try { await action(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : fallback); }
    finally { setBusy(false); }
  }

  const unbook = () => {
    if (!confirm('Deze geboekte transactie terugdraaien? Er komt een tegenboeking in het grootboek; de facturen staan daarna weer open.')) return;
    void run(() => unbookBankTransaction(organizationId, txn.id), 'Terugdraaien mislukt');
  };
  const remove = () => {
    if (!confirm('Deze handmatige mutatie verwijderen?')) return;
    void run(() => deleteManualBankTransaction(organizationId, txn.id), 'Verwijderen mislukt');
  };
  const unmerge = () => {
    if (!confirm('Losmaken? De bankregel komt dan apart in "Af te letteren" te staan. Is de handmatige mutatie al geboekt, boek de bankregel dan niet nog eens.')) return;
    void run(() => unmergeBankTransaction(organizationId, txn.id), 'Losmaken mislukt');
  };
  const merge = () => {
    if (!mergeWith) return;
    void run(() => mergeBankTransactions(organizationId, txn.id, mergeWith), 'Samenvoegen mislukt');
  };

  return (
    <div className={`bank-tx bank-tx-${txn.status}`}>
      <div className="bank-tx-main">
        <div className="bank-tx-date">{dateNL(txn.booking_date)}</div>
        <div className="bank-tx-info">
          <strong>
            {txn.counterparty_name || txn.description || 'Transactie'}
            {manual && <span className="bank-tag bank-tag-manual">handmatig</span>}
            {manual && partner && <span className="bank-tag">bevestigd door bank</span>}
          </strong>
          <small className="bk-muted">
            {accountName}
            {txn.counterparty_iban ? ` · ${txn.counterparty_iban}` : ''}
            {txn.description && txn.counterparty_name ? ` · ${txn.description}` : ''}
          </small>
          {isOpen && txn.match_confidence === 'tax_authority' && (
            <small className="bank-tx-hint">Herkend als Belastingdienst — voorgesteld: omzetbelasting (1530). De aangifte met dit saldo wordt bij boeken automatisch op “Betaald” gezet.</small>
          )}
          {manual && partner && (
            <small className="bank-tx-partner">
              Bij de bank: {dateNL(partner.booking_date)}{partner.description ? ` · ${partner.description}` : ''}
              {canWrite && <button className="bank-link" onClick={unmerge} disabled={busy}>Losmaken</button>}
            </small>
          )}
        </div>
        <div className={`bank-tx-amount ${incoming ? 'bk-pos' : 'bk-neg'}`}>{incoming ? '+ ' : '− '}{euroCents(abs)}</div>
      </div>

      {error && <div className="error bank-tx-error">{error}</div>}

      {isOpen && !manual && manualMatches.length > 0 && (
        <div className="bank-merge-hint">
          <span>
            {manualMatches.length === 1
              ? <>Lijkt op je handmatige mutatie van {dateNL(manualMatches[0].booking_date)} ({manualMatches[0].counterparty_name || manualMatches[0].description || 'zonder omschrijving'}{manualMatches[0].status === 'booked' ? ', al geboekt' : ''}).</>
              : <>Lijkt op een van je handmatige mutaties met hetzelfde bedrag.</>}
            {' '}Samenvoegen voorkomt dat hetzelfde geld er twee keer staat.
          </span>
          {manualMatches.length > 1 && (
            <Select value={mergeWith} onChange={e => setMergeChoice(e.target.value)} disabled={!canWrite || busy}>
              {manualMatches.map(m => (
                <option key={m.id} value={m.id}>{dateNL(m.booking_date)} · {m.counterparty_name || m.description || 'zonder omschrijving'}{m.status === 'booked' ? ' · geboekt' : ''}</option>
              ))}
            </Select>
          )}
          <Button onClick={merge} disabled={!canWrite || busy || !mergeWith}><Link2 size={14} /> Samenvoegen</Button>
        </div>
      )}

      {isOpen && (
        <AllocationEditor txn={txn} data={data} candidates={candidates} disabled={!canWrite || busy} busy={busy}
          onBook={(allocations, description) => run(() => bookBankTransaction(organizationId, txn.id, { allocations, description }), 'Boeken mislukt')}>
          {manual && canWrite && <Button onClick={() => onEditManual(txn)} disabled={busy}><PenSquare size={14} /> Bewerken</Button>}
          {manual && canWrite && !everBooked && <Button onClick={remove} disabled={busy} title="Verwijderen"><Trash2 size={14} /> Verwijderen</Button>}
          <Button onClick={() => void run(() => setBankTransactionStatus(organizationId, txn.id, 'ignored'), 'Mislukt')}
            disabled={!canWrite || busy || (manual && Boolean(partner))}
            title={manual && partner ? 'Bevestigd door de bank: maak eerst los' : 'Negeren'}><X size={14} /> Negeren</Button>
        </AllocationEditor>
      )}

      {txn.status === 'booked' && (
        <div className="bank-tx-actions bank-booked">
          <BookedSummary txn={txn} data={data} />
          <span className="bk-spacer" />
          {canWrite && <Button onClick={unbook} disabled={busy}><RotateCcw size={13} /> {busy ? '…' : 'Terugdraaien'}</Button>}
        </div>
      )}
      {txn.status === 'ignored' && (
        <div className="bank-tx-actions">
          <span className="bk-muted">Genegeerd</span>
          <span className="bk-spacer" />
          {manual && canWrite && !everBooked && <Button onClick={remove} disabled={busy}><Trash2 size={14} /> Verwijderen</Button>}
          {canWrite && <Button onClick={() => void run(() => setBankTransactionStatus(organizationId, txn.id, 'unmatched'), 'Mislukt')} disabled={busy}>Weer openen</Button>}
        </div>
      )}
    </div>
  );
}

/** De keuzelijst van één soort stuk, met wat er volgens de database openstaat. */
function documentOptions(kind: BankAllocationKind, data: AppData, candidates: BankAllocationCandidates | null): BankOpenDocument[] {
  const clientName = (id: string | null | undefined) => data.clients.find(c => c.id === id)?.name ?? null;
  const supplierName = (id: string | null | undefined) => data.suppliers.find(s => s.id === id)?.name ?? null;
  if (kind === 'sales_invoice') {
    if (candidates) return candidates.sales_invoices;
    // Zonder de databasefunctie (oudere database): de geboekte, verzonden
    // facturen, zonder openstaand bedrag. De database controleert bij boeken.
    return data.invoices
      .filter(i => i.journal_entry_id != null && (i.status === 'sent' || i.status === 'overdue'))
      .map(i => ({ id: i.id, number: i.number, date: i.date, total_cents: Math.round((i.total_amount ?? 0) * 100), open_cents: Number.NaN, client_id: i.client_id, client_name: clientName(i.client_id) }));
  }
  if (kind === 'purchase_invoice') {
    if (candidates) return candidates.purchase_invoices;
    return data.purchaseInvoices
      .filter(p => p.journal_entry_id != null && p.status !== 'cancelled' && p.payment_status !== 'paid')
      .map(p => ({ id: p.id, number: p.internal_number || p.supplier_invoice_number || '—', date: p.date, total_cents: p.total_cents, open_cents: Number.NaN, supplier_id: p.supplier_id, supplier_name: supplierName(p.supplier_id) }));
  }
  if (kind === 'sales_credit_note') return candidates?.credit_notes ?? [];
  return [];
}

function documentLabel(kind: BankAllocationKind, doc: BankOpenDocument): string {
  const open = Number.isFinite(doc.open_cents) ? doc.open_cents : null;
  if (kind === 'sales_credit_note') {
    return `${doc.number}${doc.invoice_number ? ` (factuur ${doc.invoice_number})` : ''}${doc.client_name ? ` · ${doc.client_name}` : ''}${open !== null ? ` · terug te betalen ${euroCents(open)}` : ''}`;
  }
  const party = doc.client_name ?? doc.supplier_name;
  const amount = open === null ? '' : open < 0 ? ` · terug te krijgen ${euroCents(-open)}` : ` · open ${euroCents(open)}`;
  return `${doc.number}${party ? ` · ${party}` : ''}${amount}`;
}

/**
 * De verdeling van één openstaande transactie: één regel (het hele bedrag op
 * één stuk of rekening, zoals vroeger) of meer regels die samen precies het
 * bedrag dekken. Bedragen in de richting van het geld; een negatieve regel is
 * de andere kant op.
 */
function AllocationEditor({ txn, data, candidates, disabled, busy, onBook, children }: {
  txn: BankTransaction; data: AppData; candidates: BankAllocationCandidates | null;
  disabled: boolean; busy: boolean;
  onBook: (allocations: AllocationPayload[], description: string) => void;
  children?: React.ReactNode;
}) {
  const full = Math.abs(txn.amount_cents);
  const incoming = txn.amount_cents > 0;
  const [lines, setLines] = useState<DraftAllocation[]>(() => suggestAllocations(txn, candidates));
  const [touched, setTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [showDescription, setShowDescription] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Tot de gebruiker iets aanraakt, volgt de verdeling het voorstel: de
  // openstaande bedragen komen pas binnen na de eerste weergave.
  useEffect(() => {
    if (!touched) setLines(suggestAllocations(txn, candidates));
  }, [candidates, txn.matched_invoice_id, txn.matched_purchase_invoice_id, txn.suggested_account_id, txn.suggested_vat_code, txn.description]);

  const bankLedgerId = data.bankAccounts.find(a => a.id === txn.bank_account_id)?.ledger_account_id ?? null;
  const accounts = useMemo(
    () => data.ledgerAccounts.filter(a => a.is_active && a.id !== bankLedgerId),
    [data.ledgerAccounts, bankLedgerId],
  );
  const kinds: BankAllocationKind[] = incoming
    ? ['sales_invoice', 'ledger', 'purchase_invoice', 'sales_credit_note']
    : ['purchase_invoice', 'ledger', 'sales_credit_note', 'sales_invoice'];
  const multi = lines.length > 1;
  const state = allocationState(lines, full);
  const defaultDescription = `Bank ${data.bankAccounts.find(a => a.id === txn.bank_account_id)?.name ?? ''}: ${txn.counterparty_name || txn.description || 'transactie'}`;

  const openOf = (line: DraftAllocation): number | null => {
    if (line.kind === 'ledger' || !line.documentId) return null;
    const doc = documentOptions(line.kind, data, candidates).find(d => d.id === line.documentId);
    return doc && Number.isFinite(doc.open_cents) ? Math.abs(doc.open_cents) : null;
  };
  const change = (next: DraftAllocation[]) => { setTouched(true); setLocalError(null); setLines(next); };
  const update = (key: string, patch: Partial<DraftAllocation>) => change(lines.map(l => (l.key === key ? { ...l, ...patch } : l)));

  function pickDocument(line: DraftAllocation, documentId: string) {
    const patch: Partial<DraftAllocation> = { documentId };
    // Bij meer regels: een leeg bedrag vullen met wat er openstaat (niet meer dan er nog te verdelen is).
    if (multi && line.amount.trim() === '' && documentId) {
      const doc = documentOptions(line.kind, data, candidates).find(d => d.id === documentId);
      if (doc && Number.isFinite(doc.open_cents)) {
        // Met het teken van de kant van het geld; mee met het geld niet meer dan er nog te verdelen is.
        const natural = naturalAmount(line.kind, doc.open_cents, txn.amount_cents);
        const rest = state.remainderCents;
        const amount = natural > 0 ? (rest > 0 ? Math.min(natural, rest) : null) : natural;
        if (amount !== null) patch.amount = centsToInput(amount);
      }
    }
    update(line.key, patch);
  }

  function book() {
    try {
      const payload = allocationPayload(lines, full);
      onBook(payload, description);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'De verdeling klopt niet.');
    }
  }

  return (
    <div className="bank-tx-actions bank-alloc">
      <div className="bank-alloc-lines">
        {lines.map((line, index) => {
          const docs = line.kind === 'ledger' ? [] : documentOptions(line.kind, data, candidates);
          const account = data.ledgerAccounts.find(a => a.id === line.accountId);
          const party = account?.subtype === 'accounts_receivable' ? 'client' : account?.subtype === 'accounts_payable' ? 'supplier' : null;
          const selectedMissing = line.documentId && !docs.some(d => d.id === line.documentId);
          return (
            <div key={line.key} className={`bank-alloc-line${multi ? ' is-multi' : ''}`}>
              <Select value={line.kind} disabled={disabled} aria-label={`Soort, regel ${index + 1}`}
                onChange={e => update(line.key, { kind: e.target.value as BankAllocationKind, documentId: '', accountId: '', vatCode: '', partyId: '' })}>
                {kinds.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </Select>
              {line.kind === 'ledger' ? (
                <>
                  <Select value={line.accountId} disabled={disabled} searchable aria-label={`Grootboekrekening, regel ${index + 1}`}
                    onChange={e => update(line.key, { accountId: e.target.value, partyId: '', vatCode: line.vatCode || (data.ledgerAccounts.find(a => a.id === e.target.value)?.default_vat_code ?? '') })}>
                    <option value="">— grootboekrekening —</option>
                    {accounts.map((a: LedgerAccount) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </Select>
                  <Select value={line.vatCode} disabled={disabled} aria-label={`Btw, regel ${index + 1}`} onChange={e => update(line.key, { vatCode: e.target.value })}>
                    <option value="">Geen btw</option>
                    {data.vatCodes.map(v => <option key={v.id} value={v.code}>{v.label}</option>)}
                  </Select>
                  {party === 'client' && (
                    <Select value={line.partyId} disabled={disabled} searchable aria-label={`Klant, regel ${index + 1}`} onChange={e => update(line.key, { partyId: e.target.value })}>
                      <option value="">— klant —</option>
                      {data.clients.map(c => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}
                    </Select>
                  )}
                  {party === 'supplier' && (
                    <Select value={line.partyId} disabled={disabled} searchable aria-label={`Leverancier, regel ${index + 1}`} onChange={e => update(line.key, { partyId: e.target.value })}>
                      <option value="">— leverancier —</option>
                      {data.suppliers.map(s => <option key={s.id} value={`s:${s.id}`}>{s.name}</option>)}
                    </Select>
                  )}
                </>
              ) : (
                <Select value={line.documentId} disabled={disabled} searchable aria-label={`${KIND_LABEL[line.kind]}, regel ${index + 1}`}
                  onChange={e => pickDocument(line, e.target.value)}>
                  <option value="">{line.kind === 'sales_invoice' ? '— kies factuur —' : line.kind === 'sales_credit_note' ? '— kies creditnota —' : '— kies inkoopfactuur —'}</option>
                  {selectedMissing && <option value={line.documentId}>Gekozen stuk (niet meer open)</option>}
                  {docs.map(d => <option key={d.id} value={d.id}>{documentLabel(line.kind, d)}</option>)}
                </Select>
              )}
              {multi && (
                <>
                  <Input className="form-input bank-alloc-amount" inputMode="decimal" value={line.amount} disabled={disabled} placeholder="0,00"
                    aria-label={`Bedrag, regel ${index + 1}`} onChange={e => update(line.key, { amount: e.target.value })} />
                  <Input className="form-input bank-alloc-desc" value={line.description} disabled={disabled} maxLength={300} placeholder="Omschrijving (optioneel)"
                    aria-label={`Omschrijving, regel ${index + 1}`} onChange={e => update(line.key, { description: e.target.value })} />
                  <button className="bank-alloc-del" onClick={() => change(removeLine(lines, line.key))} disabled={disabled} title="Regel weghalen" aria-label={`Regel ${index + 1} weghalen`}>×</button>
                </>
              )}
              {!multi && docs.length === 0 && line.kind !== 'ledger' && (
                <small className="bank-tx-hint">
                  {line.kind === 'sales_invoice' && 'Geen openstaande verkoopfacturen in het grootboek. Gebruik eerst “Boek naar grootboek” op de factuur.'}
                  {line.kind === 'purchase_invoice' && 'Geen openstaande inkoopfacturen in het grootboek: boek de inkoopfactuur eerst.'}
                  {line.kind === 'sales_credit_note' && 'Geen creditnota met tegoed voor een klant. Registreer eerst de terugbetaling bij de factuur (die maakt de creditnota).'}
                </small>
              )}
            </div>
          );
        })}
      </div>

      <div className="bank-alloc-foot">
        <button className="bank-link" onClick={() => change(addLine(lines, full, openOf))} disabled={disabled}>
          <Plus size={13} /> {multi ? 'Regel toevoegen' : 'Verdelen'}
        </button>
        {multi && (
          <span className={state.remainderCents === 0 ? 'bank-alloc-sum is-ok' : 'bank-alloc-sum'}>
            {state.remainderCents === 0
              ? <><Check size={13} /> Precies verdeeld</>
              : state.remainderCents > 0
                ? <>Nog te verdelen: {euroCents(state.remainderCents)}</>
                : <>{euroCents(-state.remainderCents)} te veel verdeeld</>}
          </span>
        )}
        {multi && state.remainderCents !== 0 && (
          <button className="bank-link" onClick={() => change(putRemainder(lines, lines[lines.length - 1].key, full))} disabled={disabled}>Rest op de laatste regel</button>
        )}
        <button className="bank-link" onClick={() => setShowDescription(v => !v)} disabled={disabled}>
          {showDescription ? 'Standaardomschrijving' : 'Eigen omschrijving'}
        </button>
      </div>
      {multi && <small className="bk-muted bank-alloc-help">Bedragen gaan mee met het geld; een negatief bedrag is de andere kant op (bijvoorbeeld kosten die van een uitbetaling zijn afgehouden).</small>}
      {showDescription && (
        <Input className="form-input bank-alloc-booking-desc" value={description} maxLength={300} disabled={disabled}
          placeholder={defaultDescription} aria-label="Omschrijving van de boeking"
          onChange={e => setDescription(e.target.value)} />
      )}
      {localError && <div className="error bank-tx-error">{localError}</div>}

      <div className="bank-alloc-buttons">
        {children}
        <span className="bk-spacer" />
        <Button variant="primary" onClick={book} disabled={disabled || state.problem !== null} title={state.problem ?? undefined}>
          <Check size={14} /> {busy ? 'Boeken…' : 'Boeken'}
        </Button>
      </div>
    </div>
  );
}

/** Wat er geboekt is: de verdeling (of, bij een oude boeking, de journaalregels). */
function BookedSummary({ txn, data }: { txn: BankTransaction; data: AppData }) {
  const entry = data.journalEntries.find(e => e.id === txn.journal_entry_id);
  const sign = txn.amount_cents < 0 ? -1 : 1;
  const bankLedgerId = data.bankAccounts.find(a => a.id === txn.bank_account_id)?.ledger_account_id;
  const accountLabel = (id: string | null) => {
    const a = data.ledgerAccounts.find(x => x.id === id);
    return a ? `${a.code} · ${a.name}` : 'Grootboekrekening';
  };
  const allocations = data.bankAllocations
    .filter(a => a.bank_transaction_id === txn.id && a.journal_entry_id === txn.journal_entry_id)
    .sort((a, b) => a.position - b.position);
  const items: Array<{ key: string; label: string; cents: number }> = allocations.length > 0
    ? allocations.map(a => {
        const invoice = data.invoices.find(i => i.id === a.invoice_id);
        const purchase = data.purchaseInvoices.find(p => p.id === a.purchase_invoice_id);
        let label: string;
        if (a.kind === 'sales_invoice') label = `Factuur ${invoice?.number ?? ''}`;
        else if (a.kind === 'sales_credit_note') label = `Terugbetaling creditnota ${a.credit_note?.number ?? ''}${invoice ? ` (factuur ${invoice.number})` : ''}`;
        else if (a.kind === 'purchase_invoice') label = `Inkoopfactuur ${purchase?.internal_number || purchase?.supplier_invoice_number || ''}`;
        else label = `${accountLabel(a.account_id)}${a.vat_code ? ` · ${a.vat_code}` : ''}`;
        if (a.description) label += ` — ${a.description}`;
        return { key: a.id, label, cents: a.amount_cents * sign };
      })
    : data.journalLines
        .filter(l => l.entry_id === txn.journal_entry_id && l.account_id !== bankLedgerId)
        .map(l => ({ key: l.id, label: `${accountLabel(l.account_id)}${l.description ? ` — ${l.description}` : ''}`, cents: l.debit_cents || l.credit_cents }));
  return (
    <div className="bank-booked-summary">
      <div className="bank-booked-head">
        <span className="status-pill bk-status-booked">Geboekt</span>
        {entry?.entry_number && <span className="bk-muted">{entry.entry_number}</span>}
        {entry?.description && <span className="bank-booked-desc">{entry.description}</span>}
      </div>
      {items.length > 0 && (
        <ul className="bank-booked-lines">
          {items.map(item => <li key={item.key}><span>{item.label}</span><span className="bank-booked-amount">{euroCents(item.cents)}</span></li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Een mutatie met de hand invoeren of aanpassen. Staat de rekening ook aan de
 * bank gekoppeld (of lees je later een afschrift in), dan voegt ResoFly de
 * mutatie van de bank vanzelf samen met deze: zelfde rekening en bedrag,
 * binnen een week.
 */
function ManualTxModal({ data, organizationId, txn, defaultAccountId, onClose, onSaved }: {
  data: AppData; organizationId: string; txn: BankTransaction | null; defaultAccountId: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const editing = txn !== null;
  const accounts = data.bankAccounts.filter(a => a.is_active || a.id === txn?.bank_account_id);
  const [form, setForm] = useState(() => ({
    bankAccountId: txn?.bank_account_id ?? defaultAccountId ?? accounts[0]?.id ?? '',
    date: txn?.booking_date ?? amsterdamTodayIso(),
    direction: txn && txn.amount_cents < 0 ? 'out' : 'in',
    amount: txn ? centsToInput(Math.abs(txn.amount_cents)) : '',
    name: txn?.counterparty_name ?? '',
    iban: txn?.counterparty_iban ?? '',
    description: txn?.description ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => { setDuplicate(null); setForm(f => ({ ...f, [k]: v })); };

  async function save(allowDuplicate = false) {
    const cents = parseDutchAmountCents(form.amount);
    if (!form.bankAccountId) { setError('Kies een bankrekening.'); return; }
    if (!form.date) { setError('Kies de datum van de mutatie.'); return; }
    if (cents === null || cents <= 0) { setError('Vul een bedrag in, groter dan € 0,00. Of het geld binnenkwam of wegging, kies je erboven.'); return; }
    if (!form.name.trim() && !form.description.trim()) { setError('Geef een tegenpartij of een omschrijving, zodat je de mutatie later terugvindt.'); return; }
    const input = {
      bookingDate: form.date,
      amountCents: form.direction === 'out' ? -cents : cents,
      counterpartyName: form.name.trim() || null,
      counterpartyIban: form.iban.trim() || null,
      description: form.description.trim() || null,
    };
    setBusy(true); setError(null);
    try {
      if (editing) await updateManualBankTransaction(organizationId, txn!.id, input);
      else await createManualBankTransaction(organizationId, { ...input, bankAccountId: form.bankAccountId }, { allowDuplicate });
      onSaved();
    } catch (e) {
      if (e instanceof PossibleDuplicateBankTransactionError) setDuplicate(e.message);
      else setError(e instanceof Error ? e.message : 'Opslaan mislukt');
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? 'Mutatie bewerken' : 'Mutatie invoeren'} onClose={onClose}
      footer={<div className="bk-foot">
        <span className="bk-spacer" />
        <Button onClick={onClose}>Annuleren</Button>
        {duplicate
          ? <Button variant="primary" onClick={() => void save(true)} disabled={busy}>{busy ? 'Bezig…' : 'Toch invoeren'}</Button>
          : <Button variant="primary" onClick={() => void save(false)} disabled={busy}>{busy ? 'Bezig…' : 'Opslaan'}</Button>}
      </div>}>
      <p className="bk-muted">
        Voor geld dat (nog) niet via een afschrift of de bankkoppeling binnenkomt. Komt dezelfde mutatie later toch van de
        bank, dan voegt ResoFly die vanzelf samen met deze: zelfde rekening en bedrag, binnen een week. Zo staat het geld er één keer.
      </p>
      {error && <div className="error">{error}</div>}
      {duplicate && <div className="bk-note bank-duplicate"><AlertTriangle size={14} /> {duplicate}</div>}
      <div className="bk-seg bk-seg-sm bank-direction">
        <button className={form.direction === 'in' ? 'is-active' : ''} onClick={() => set('direction', 'in')} type="button">Ontvangst (geld erbij)</button>
        <button className={form.direction === 'out' ? 'is-active' : ''} onClick={() => set('direction', 'out')} type="button">Betaling (geld eraf)</button>
      </div>
      <div className="bk-grid2">
        <Field label="Bankrekening">
          <Select value={form.bankAccountId} onChange={e => set('bankAccountId', e.target.value)} disabled={editing}>
            <option value="">— kies —</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}{a.iban ? ` · ${a.iban}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Datum"><Input type="date" value={form.date} onChange={e => set('date', e.target.value)} /></Field>
        <Field label="Bedrag" hint="Zonder min-teken; de richting kies je hierboven."><Input inputMode="decimal" value={form.amount} placeholder="0,00" onChange={e => set('amount', e.target.value)} /></Field>
        <Field label="Tegenpartij"><Input value={form.name} maxLength={200} onChange={e => set('name', e.target.value)} placeholder="Bijv. de naam van de klant" /></Field>
        <Field label="IBAN tegenpartij" hint="Optioneel. Helpt bij het samenvoegen met de bank."><Input value={form.iban} onChange={e => set('iban', e.target.value)} placeholder="NL00 BANK 0123 4567 89" /></Field>
        <Field label="Omschrijving" hint="Noem het factuurnummer: dan stelt ResoFly de factuur voor."><Input value={form.description} maxLength={1000} onChange={e => set('description', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ───────────────────────── Rekeningen & koppeling ─────────────────────────

/**
 * Saldo-aansluiting per bankrekening: staat het geld dat de bank zegt te hebben
 * ook echt in de boekhouding? Het eindsaldo van het laatste afschrift wordt
 * vergeleken met de grootboekstand plus alles wat nog niet geboekt is. Loopt dat
 * uiteen, dan missen er transacties of staan ze dubbel — zonder deze controle
 * merk je dat pas bij de jaarrekening.
 */
function ReconciliationPanel({ rec }: { rec: BankReconciliation }) {
  if (rec.statement_closing_cents === null) {
    return (
      <div className="bank-recon bank-recon-unknown">
        <span className="bk-muted">
          Geen afschriftsaldo bekend — saldocontrole niet mogelijk.
          {rec.source === 'import'
            ? (rec.statement_id === null && (rec.manual_count ?? 0) > 0
                ? ' Op deze rekening staan alleen handmatige mutaties. Lees eens per periode een CAMT.053- of MT940-afschrift in; dan kan de aansluiting wél worden gecontroleerd.'
                : ' CSV bevat geen begin-/eindsaldo; gebruik een CAMT.053- of MT940-export.')
            : ' De bankkoppeling levert geen saldo mee; lees met “Afschrift inlezen” eens per periode een CAMT.053-afschrift in — dan kan de aansluiting wél worden gecontroleerd.'}
        </span>
      </div>
    );
  }
  // Delen meerdere bankrekeningen dezelfde grootboekrekening, dan is die stand de
  // som van allemaal en zou elk verschil per rekening onzin zijn. De server geeft
  // dan bewust geen getal terug.
  if (rec.difference_cents === null) {
    return (
      <div className="bank-recon bank-recon-unknown">
        <span className="bk-muted">
          Saldo volgens afschrift {euroCents(rec.statement_closing_cents)}
          {rec.as_of ? ` per ${dateNL(rec.as_of)}` : ''}. Aansluiting niet te berekenen: meerdere
          bankrekeningen boeken op {rec.ledger_code}, dus die stand is de som van al die rekeningen.
          Geef elke bankrekening een eigen grootboekrekening om per rekening te kunnen aansluiten.
        </span>
      </div>
    );
  }

  const diff = rec.difference_cents;
  const ok = diff === 0;
  return (
    <div className={`bank-recon ${ok ? 'bank-recon-ok' : 'bank-recon-off'}`}>
      <div className="bank-recon-head">
        {ok ? <Check size={14} /> : <AlertTriangle size={14} />}
        <strong>{ok ? 'Bank sluit aan' : `Verschil ${euroCents(Math.abs(diff))}`}</strong>
        {rec.as_of && <span className="bk-muted">per {dateNL(rec.as_of)}</span>}
      </div>
      <dl className="bank-recon-rows">
        <div><dt>Saldo volgens afschrift</dt><dd>{euroCents(rec.statement_closing_cents)}</dd></div>
        <div><dt>Grootboek {rec.ledger_code}</dt><dd>{euroCents(rec.ledger_balance_cents)}</dd></div>
        {rec.unbooked_count > 0 && (
          <div><dt>Nog te boeken ({rec.unbooked_count})</dt><dd>{euroCents(rec.unbooked_sum_cents)}</dd></div>
        )}
        {rec.ignored_count > 0 && (
          <div><dt>Genegeerd ({rec.ignored_count})</dt><dd>{euroCents(rec.ignored_sum_cents)}</dd></div>
        )}
        {(rec.timing_count ?? 0) > 0 && (
          <div><dt>Datumverschil handmatig/bank ({rec.timing_count})</dt><dd>{euroCents(rec.timing_sum_cents ?? 0)}</dd></div>
        )}
      </dl>
      {!ok && (
        <ul className="bank-recon-hints">
          {rec.ignored_count > 0 && (
            <li>Genegeerde transacties staan wél op het afschrift en tellen dus mee in de aansluiting. Heb je een dubbele regel genegeerd, dan blijft het verschil zichtbaar tot de dubbele rij echt weg is.</li>
          )}
          {(rec.manual_unconfirmed_count ?? 0) > 0 && (
            <li>
              {rec.manual_unconfirmed_count} handmatige mutatie(s) ({euroCents(rec.manual_unconfirmed_sum_cents ?? 0)}) staan in de boekhouding,
              maar niet op het afschrift. Klopt de datum, en ging het geld echt over deze rekening? Staat hij op het afschrift met een ander
              bedrag of verder weg in de tijd, voeg hem dan met de hand samen in “Af te letteren”.
            </li>
          )}
          {!rec.has_opening_balance && (
            <li>Er is geen beginbalans op {rec.ledger_code} geboekt. Begon je met een saldo op deze rekening, dan verklaart dat het verschil.</li>
          )}
          {rec.duplicate_suspects > 0 && (
            <li>{rec.duplicate_suspects} transactie(s) zijn qua datum, bedrag, tegenrekening én omschrijving identiek aan een andere. Meestal een dubbele import — controleer ze in “Af te letteren”.</li>
          )}
          {rec.statement_issues.length > 0 && (
            <li>
              {rec.statement_issues.length} afschrift(en) kloppen intern niet (beginsaldo + regels ≠ eindsaldo):{' '}
              {rec.statement_issues.map(s => `${s.file_name || 'afschrift'} (${euroCents(s.difference_cents)})`).join(', ')}. Er ontbreken regels in die bestanden.
            </li>
          )}
          {rec.has_opening_balance && rec.duplicate_suspects === 0 && rec.statement_issues.length === 0 && rec.ignored_count === 0 && !rec.manual_unconfirmed_count && (
            <li>Controleer of alle afschriften over deze periode zijn ingelezen, en of er handmatige journaalposten op {rec.ledger_code} staan die niet van de bank komen.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function AccountsTab({ data, organizationId, canWrite, onChanged }: PageProps) {
  const [edit, setEdit] = useState<BankAccount | 'new' | null>(null);
  // Met de hand invoeren kan ook bij een gekoppelde rekening: wat de bank later
  // levert, wordt samengevoegd met wat je hier invoert.
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [recon, setRecon] = useState<BankReconciliation[]>([]);

  // De aansluiting komt uit een RPC (server-side aggregatie): de journaalregels
  // van 1100 lopen ver boven de PostgREST-rijlimiet, dus client-side optellen
  // zou stilzwijgend een verkeerd saldo geven.
  useEffect(() => {
    let active = true;
    selectBankReconciliation(organizationId)
      .then(rows => { if (active) setRecon(rows); })
      .catch(() => { if (active) setRecon([]); });
    return () => { active = false; };
  }, [organizationId, data.bankTransactions, data.journalLines]);
  const lastImport = (a: BankAccount) =>
    a.last_imported_at ? `Laatste import ${dateNL(a.last_imported_at.slice(0, 10))}` : 'Nog niets ingelezen';
  const lastSync = (a: BankAccount) =>
    a.last_synced_at ? `Laatst gesynct ${dateNL(a.last_synced_at.slice(0, 10))}` : 'Nog niet gesynct';
  const reqFor = (a: BankAccount): BankRequisition | undefined =>
    data.bankRequisitions.find(r => r.id === a.bank_requisition_id);
  const now = Date.now();
  // De nieuwste koppelpoging zegt in welke omgeving de Enable Banking-app staat
  // (de lijst is nieuwste-eerst). Een sandbox-app koppelt nooit een echte rekening.
  const sandboxMode = isSandboxLink(data.bankRequisitions[0]?.link);

  // Afronden van de bankkoppeling na de redirect (?code=&state=…, of ?error=&state=…
  // als het bij de bank niet doorging). Eénmalig.
  const finalizedRef = useRef(false);
  useEffect(() => {
    const ret = readBankReturn(window.location.search);
    if (!ret || finalizedRef.current) return;
    finalizedRef.current = true;
    // Verwijder de querystring uit de URL zodat een refresh niet opnieuw afrondt.
    const clean = window.location.origin + window.location.pathname + window.location.hash;
    // Met history.state erin: daar staat de stap van de terugknop (lib/backButton.ts).
    window.history.replaceState(window.history.state, '', clean);
    setBanner(null);
    if (ret.kind === 'error') {
      // Afgebroken of geweigerd. Voorheen kwam je dan zonder één woord op het
      // dashboard terecht en bleef de koppeling voorgoed op "created" staan.
      setBanner({
        kind: 'err',
        text: isCancelledBankReturn(ret.error)
          ? 'Je hebt de koppeling bij je bank afgebroken. Er is niets gekoppeld; probeer het gerust opnieuw via "Koppel bank".'
          : `De bank heeft de koppeling niet afgerond${ret.description ? ` (${ret.description})` : ''}. Probeer het opnieuw, of kies bij "Koppel bank" de andere rekeningsoort (zakelijk/privé).`,
      });
      // Vastleggen bij de koppeling is bijzaak: de melding staat er al.
      finalizeBankRequisition(organizationId, { state: ret.state, error: ret.error, errorDescription: ret.description })
        .then(() => onChanged())
        .catch(() => undefined);
      return;
    }
    setFinalizing(true);
    finalizeBankRequisition(organizationId, { code: ret.code, state: ret.state })
      .then(res => {
        if (res.status === 'linked' && res.alreadyLinked) setBanner({ kind: 'ok', text: 'Deze bankkoppeling was al afgerond.' });
        else if (res.status === 'linked') {
          const done = `Bank gekoppeld: ${res.linked} rekening(en), ${res.imported} transacties opgehaald.`;
          // Gekoppeld maar niet opgehaald: niet als "0 transacties" laten lijken.
          setBanner(res.syncErrors
            ? { kind: 'err', text: `${done} Ophalen lukte nog niet voor ${res.syncErrors} rekening(en): ${res.syncError ?? 'onbekende fout'}` }
            : { kind: 'ok', text: done });
        }
        else setBanner({ kind: 'err', text: res.error || 'De koppeling is nog niet voltooid. Rond de toestemming bij je bank af en probeer opnieuw.' });
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
        <p className="bk-muted">Koppel elke bankrekening aan een grootboekrekening (meestal 1100 Bank). Lees afschriften in (CAMT.053, MT940 of CSV), koppel je bank direct (PSD2) voor automatisch ophalen, of voer een mutatie met de hand in. Komt die later ook van de bank, dan voegt ResoFly de twee samen.</p>
        <div className="bank-subhead-actions">
          <Button disabled={!canWrite || finalizing} onClick={() => setConnect(true)}><Link2 size={15} /> Koppel bank</Button>
          <Button variant="primary" disabled={!canWrite} onClick={() => setEdit('new')}><Plus size={15} /> Handmatige rekening</Button>
        </div>
      </div>

      {finalizing && <div className="bk-note">Koppeling afronden…</div>}
      {banner && <div className={banner.kind === 'ok' ? 'bk-note' : 'error'}>{banner.text}</div>}
      {sandboxMode && (
        <div className="bk-note">
          <strong>Testomgeving.</strong> De bankkoppeling loopt nog via de sandbox van Enable Banking: je kunt alleen
          testbanken met testgegevens koppelen, nog geen echte bankrekening. Rekeningen met het label "testdata" zijn zo
          gekoppeld — verwijder ze voordat je er echt mee boekhoudt.
        </div>
      )}

      {data.bankAccounts.length === 0
        ? <div className="empty"><div className="e-big">Nog geen bankrekeningen</div></div>
        : <div className="bank-accounts">
            {data.bankAccounts.map(a => {
              const ledger = data.ledgerAccounts.find(l => l.id === a.ledger_account_id);
              const count = data.bankTransactions.filter(t => t.bank_account_id === a.id).length;
              const linked = a.source !== 'import';
              const req = reqFor(a);
              // Op de verloopdatum, niet alleen na een mislukte sync: zonder sync
              // stond een verlopen koppeling anders maandenlang op "gekoppeld".
              const consent = linked ? consentState(req, now) : { expired: false, daysLeft: null };
              const soon = !consent.expired && consent.daysLeft !== null && consent.daysLeft <= 14;
              return (
                <div key={a.id} className="bank-account-card">
                  <div className="bank-account-head">
                    <div>
                      <strong>
                        {a.name}{linked && <span className="bank-tag">gekoppeld</span>}
                        {isSandboxLink(req?.link) && <span className="bank-tag bank-tag-test">testdata</span>}
                      </strong>
                      <small className="bk-muted">{a.iban || 'geen IBAN'}{ledger ? ` · ${ledger.code} ${ledger.name}` : ''}</small>
                    </div>
                    <button className="bk-cell-action" onClick={() => setEdit(a)} disabled={!canWrite}>Bewerk</button>
                  </div>
                  {consent.expired && (
                    <div className="bank-reconsent"><AlertTriangle size={14} /> Toestemming verlopen{req?.expires_at ? ` op ${dateNL(req.expires_at.slice(0, 10))}` : ''} — er komen geen nieuwe transacties meer binnen. Koppel de bank opnieuw.</div>
                  )}
                  {soon && (
                    <div className="bank-reconsent"><AlertTriangle size={14} /> Toestemming verloopt over {consent.daysLeft} {consent.daysLeft === 1 ? 'dag' : 'dagen'} — koppel de bank dan opnieuw via "Koppel bank".</div>
                  )}
                  {linked && !consent.expired && a.last_sync_error && (
                    <div className="bank-reconsent"><AlertTriangle size={14} /> Laatste synchronisatie mislukt: {a.last_sync_error}</div>
                  )}
                  {(() => {
                    const rec = recon.find(r => r.bank_account_id === a.id);
                    return rec ? <ReconciliationPanel rec={rec} /> : null;
                  })()}
                  <div className="bank-account-meta">
                    <span className="bk-muted">{count} transacties · {linked ? lastSync(a) : lastImport(a)}</span>
                    <span className="bk-spacer" />
                    {/* Afschrift inlezen kan ALTIJD, ook bij een gekoppelde rekening: de
                        PSD2-sync levert geen begin-/eindsaldo mee, dus zonder een CAMT- of
                        MT940-afschrift is de saldo-aansluiting hierboven onmogelijk — terwijl
                        die er juist om vraagt. Dubbele transacties worden op inhoud ontdubbeld
                        en wat er tóch doorheen glipt zie je meteen in het aansluitpaneel. */}
                    {linked && (consent.expired
                      ? <Button disabled={!canWrite || finalizing} onClick={() => setConnect(true)}><Link2 size={14} /> Opnieuw koppelen</Button>
                      : <Button disabled={!canWrite || syncingId === a.id} onClick={() => sync(a)}><RefreshCw size={14} /> {syncingId === a.id ? 'Synchroniseren…' : 'Synchroniseer'}</Button>)}
                    <Button disabled={!canWrite || !a.is_active} onClick={() => setManualFor(a.id)}><Plus size={14} /> Mutatie invoeren</Button>
                    <ImportButton account={a} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />
                  </div>
                </div>
              );
            })}
          </div>}

      {manualFor && <ManualTxModal data={data} organizationId={organizationId} txn={null} defaultAccountId={manualFor}
        onClose={() => setManualFor(null)} onSaved={() => { setManualFor(null); onChanged(); }} />}
      {edit && <BankAccountForm data={data} organizationId={organizationId} canWrite={canWrite}
        account={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); onChanged(); }} />}
      {connect && <BankConnectModal organizationId={organizationId} onClose={() => setConnect(false)} />}
    </div>
  );
}

function BankConnectModal({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const [institutions, setInstitutions] = useState<BankInstitution[] | null>(null);
  const [query, setQuery] = useState('');
  const [psuType, setPsuType] = useState<BankPsuType>('business');
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
    // Een bank die deze rekeningsoort niet aankan, tonen we niet: kiezen zou pas
    // bij de bank misgaan. Onbekend (of een oudere bank-sync) = gewoon tonen.
    return (institutions ?? []).filter(i => (!q || i.name.toLowerCase().includes(q))
      && (!i.psu_types?.length || i.psu_types.includes(psuType)));
  }, [institutions, query, psuType]);

  async function pick(inst: BankInstitution) {
    setBusy(inst.id); setError(null);
    try {
      // De bank stuurt na toestemming terug naar deze URL met ?code=&state=… erachter.
      const redirectUrl = window.location.origin + window.location.pathname;
      const { link } = await createBankRequisition(organizationId, { institutionId: inst.id, institutionName: inst.name, redirectUrl, psuType });
      window.location.assign(link);
    } catch (e) { setError(e instanceof Error ? e.message : 'Koppeling starten mislukt'); setBusy(null); }
  }

  return (
    <Modal title="Koppel een bank" onClose={onClose}
      footer={<div className="bk-foot"><span className="bk-spacer" /><Button onClick={onClose}>Sluiten</Button></div>}>
      {error && <div className="error">{error}</div>}
      <p className="bk-muted">Kies je bank. Je wordt doorgestuurd naar de bank om toestemming te geven (PSD2); daarna komen je transacties automatisch binnen.</p>
      {/* Zakelijk en privé zijn bij de bank een andere inlog en een andere
          koppeling; met de verkeerde soort ziet de bank je rekening niet. */}
      <div className="bank-psu">
        <div className="bk-seg bk-seg-sm">
          <button className={psuType === 'business' ? 'is-active' : ''} onClick={() => setPsuType('business')}>Zakelijke rekening</button>
          <button className={psuType === 'personal' ? 'is-active' : ''} onClick={() => setPsuType('personal')}>Privérekening</button>
        </div>
        <small className="bk-muted">Eenmanszaak met een gewone betaalrekening? Kies Privérekening.</small>
      </div>
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
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    setBusy(true); setError(null); setMsg(null); setWarnings([]);
    try {
      const parsed = await parseBankFile(file);
      if (parsed.transactions.length === 0) throw new Error('Geen transacties in dit bestand gevonden.');
      const res = await importBankTransactions(organizationId, account.id, parsed);
      setMsg(`${res.inserted} nieuw, ${res.duplicates} al bekend (${parsed.format.toUpperCase()}).`);
      // Klopt het afschrift met zichzelf? Beginsaldo + regels moet het eindsaldo
      // geven; zo niet, dan mist het bestand regels en zou de bank straks niet
      // aansluiten zonder dat je weet waarom.
      const serverWarnings: string[] = [];
      if (res.skippedNoDate > 0) serverWarnings.push(`${res.skippedNoDate} regel(s) niet ingelezen: geen leesbare boekdatum.`);
      if (res.skippedZeroAmount > 0) serverWarnings.push(`${res.skippedZeroAmount} regel(s) niet ingelezen: bedrag € 0,00.`);
      if (res.balanceOk === false) {
        serverWarnings.push(`Let op: beginsaldo + alle mutaties in deze periode wijken ${euroCents(Math.abs(res.balanceDifferenceCents ?? 0))} af van het eindsaldo. Er ontbreken transacties over deze periode.`);
      }
      setWarnings([...parsed.warnings, ...serverWarnings]);
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : 'Inlezen mislukt'); }
    finally { setBusy(false); }
  }

  return (
    <span className="bank-import">
      <input ref={inputRef} type="file" accept=".xml,.940,.sta,.mt940,.csv,.txt,text/xml,text/csv" style={{ display: 'none' }} onChange={onFile} />
      <Button disabled={!canWrite || busy} onClick={() => inputRef.current?.click()}><Upload size={14} /> {busy ? 'Inlezen…' : 'Afschrift inlezen'}</Button>
      {msg && <small className="bank-import-msg">{msg}</small>}
      {warnings.map((w, i) => <small key={i} className="bank-import-warn"><AlertTriangle size={12} /> {w}</small>)}
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
    // Zonder voorwaarde matcht een regel op élke transactie (en met automatisch
    // boeken boekt hij ze allemaal); de database weigert zo'n regel ook.
    const hasCondition = [form.match_counterparty_iban, form.match_counterparty_name_contains, form.match_description_contains, form.match_amount]
      .some(v => String(v ?? '').trim() !== '');
    if (!hasCondition) { setError('Geef minstens één voorwaarde: IBAN, naam bevat, omschrijving bevat of een exact bedrag.'); return; }
    setBusy(true); setError(null);
    try {
      const amountStr = String(form.match_amount).trim();
      const values = {
        name: form.name, priority: Number(form.priority) || 100, match_direction: form.match_direction,
        match_counterparty_iban: form.match_counterparty_iban || null,
        match_counterparty_name_contains: form.match_counterparty_name_contains || null,
        match_description_contains: form.match_description_contains || null,
        // "12,50" is € 12,50; parseFloat las het als 12.
        match_amount_cents: amountStr ? parseDutchAmountCents(amountStr) : null,
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
