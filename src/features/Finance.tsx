import { useMemo, useState } from 'react';
import { AlertTriangle, Bell, BookOpen, CreditCard, Download, Eye, FileText, Mail, Pause, Play, RotateCcw, ShieldCheck, Send, XCircle } from 'lucide-react';
import type { AppData, CreditNote, DunningNotice, FinanceLine, FinanceStatus, Invoice, InvoiceChargeback, InvoiceEmailDelivery, InvoicePaymentRecord, InvoiceRefund, InvoiceVersion, Quote, QuoteEmailDelivery, QuoteVersion } from '../types';
import { Modal } from '../components/Modal';
import { FinanceDocPreview } from '../components/FinanceDocPreview';
import { Button, Select } from '../components/Ui';
import { SearchFilterPanel } from '../components/SearchFilterPanel';
import type { FilterField } from '../components/SearchFilterPanel';
import { dateNL, euro, total, lineGross } from '../lib/format';
import { exportFinancePDF } from '../lib/pdf';

export type RefundInput = { amountCents: number; reason: string; createCreditNote: boolean; idempotencyKey: string; kind: 'manual' | 'mollie' };

export function Quotes({
  data,
  canWrite,
  canAdmin,
  onNew,
  onEdit,
  onSubmitApproval,
  onApprove,
  onReject,
  onSend,
  onConvertToInvoice,
  onDownloadPdf,
}: {
  data: AppData;
  canWrite: boolean;
  canAdmin: boolean;
  onNew: () => void;
  onEdit: (q: Quote) => void;
  onSubmitApproval: (q: Quote) => void;
  onApprove: (q: Quote) => void;
  onReject: (q: Quote) => void;
  onSend: (q: Quote) => void;
  onConvertToInvoice?: (q: Quote) => void;
  onDownloadPdf?: (q: Quote) => void;
}) {
  return <FinanceList
    kind="quote"
    title="Offertes"
    docs={data.quotes}
    data={data}
    canWrite={canWrite}
    canAdmin={canAdmin}
    onNew={onNew}
    onEdit={onEdit}
    onSubmitApproval={onSubmitApproval}
    onApprove={onApprove}
    onReject={onReject}
    onSend={onSend}
    onConvertToInvoice={onConvertToInvoice}
    onDownloadPdf={onDownloadPdf}
  />;
}

export function Invoices({ data, canWrite, canAdmin = false, onNew, onEdit, onSend, onSendReminder, onToggleRemindersPaused, onDownloadPdf, onDownloadUbl, onRefund, onDownloadCreditNote, onDownloadCreditNoteUbl, onEmailCreditNote, onPostCreditNote, onPostToLedger, onBookAllUnbooked, onProposeDunning, onSendDunning, onCancelDunning }: { data: AppData; canWrite: boolean; canAdmin?: boolean; onNew: () => void; onEdit: (i: Invoice) => void; onSend: (i: Invoice) => void; onSendReminder?: (i: Invoice) => void; onToggleRemindersPaused?: (i: Invoice, paused: boolean) => void; onDownloadPdf?: (i: Invoice) => void; onDownloadUbl?: (i: Invoice) => void; onRefund?: (invoice: Invoice, input: RefundInput) => Promise<void>; onDownloadCreditNote?: (creditNote: CreditNote) => void; onDownloadCreditNoteUbl?: (creditNote: CreditNote) => void; onEmailCreditNote?: (creditNote: CreditNote) => void; onPostCreditNote?: (creditNote: CreditNote) => void; onPostToLedger?: (i: Invoice) => void; onBookAllUnbooked?: () => void; onProposeDunning?: (i: Invoice) => void; onSendDunning?: (n: DunningNotice) => void; onCancelDunning?: (n: DunningNotice) => void }) {
  return <FinanceList kind="invoice" title="Facturen" docs={data.invoices} data={data} canWrite={canWrite} canAdmin={canAdmin} onNew={onNew} onEdit={onEdit} onSendInvoice={onSend} onSendInvoiceReminder={onSendReminder} onToggleInvoiceRemindersPaused={onToggleRemindersPaused} onDownloadInvoicePdf={onDownloadPdf} onDownloadInvoiceUbl={onDownloadUbl} onRefundInvoice={onRefund} onDownloadCreditNote={onDownloadCreditNote} onDownloadCreditNoteUbl={onDownloadCreditNoteUbl} onEmailCreditNote={onEmailCreditNote} onPostCreditNote={onPostCreditNote} onPostInvoiceToLedger={onPostToLedger} onBookAllUnbooked={onBookAllUnbooked} onProposeDunning={onProposeDunning} onSendDunning={onSendDunning} onCancelDunning={onCancelDunning}/>;
}

function FinanceList<T extends Quote | Invoice>({
  kind,
  title,
  docs,
  data,
  canWrite = true,
  canAdmin = false,
  onNew,
  onEdit,
  onSubmitApproval,
  onApprove,
  onReject,
  onSend,
  onConvertToInvoice,
  onSendInvoice,
  onSendInvoiceReminder,
  onToggleInvoiceRemindersPaused,
  onDownloadPdf,
  onDownloadInvoicePdf,
  onDownloadInvoiceUbl,
  onRefundInvoice,
  onDownloadCreditNote,
  onDownloadCreditNoteUbl,
  onEmailCreditNote,
  onPostCreditNote,
  onPostInvoiceToLedger,
  onBookAllUnbooked,
  onProposeDunning,
  onSendDunning,
  onCancelDunning,
}: {
  kind: 'quote' | 'invoice';
  title: string;
  docs: T[];
  data: AppData;
  canWrite?: boolean;
  canAdmin?: boolean;
  onNew: () => void;
  onEdit: (doc: T) => void;
  onSubmitApproval?: (q: Quote) => void;
  onApprove?: (q: Quote) => void;
  onReject?: (q: Quote) => void;
  onSend?: (q: Quote) => void;
  onConvertToInvoice?: (q: Quote) => void;
  onSendInvoice?: (i: Invoice) => void;
  onSendInvoiceReminder?: (i: Invoice) => void;
  onToggleInvoiceRemindersPaused?: (i: Invoice, paused: boolean) => void;
  onDownloadPdf?: (q: Quote) => void;
  onDownloadInvoicePdf?: (i: Invoice) => void;
  onDownloadInvoiceUbl?: (i: Invoice) => void;
  onRefundInvoice?: (invoice: Invoice, input: RefundInput) => Promise<void>;
  onDownloadCreditNote?: (creditNote: CreditNote) => void;
  onDownloadCreditNoteUbl?: (creditNote: CreditNote) => void;
  onEmailCreditNote?: (creditNote: CreditNote) => void;
  onPostCreditNote?: (creditNote: CreditNote) => void;
  onPostInvoiceToLedger?: (i: Invoice) => void;
  onBookAllUnbooked?: () => void;
  onProposeDunning?: (i: Invoice) => void;
  onSendDunning?: (n: DunningNotice) => void;
  onCancelDunning?: (n: DunningNotice) => void;
}) {
  if (kind === 'quote') {
    return <QuoteTable
      title={title}
      quotes={docs as Quote[]}
      data={data}
      canWrite={canWrite}
      canAdmin={canAdmin}
      onNew={onNew}
      onEdit={onEdit as (doc: Quote) => void}
      onSubmitApproval={onSubmitApproval}
      onApprove={onApprove}
      onReject={onReject}
      onSend={onSend}
      onConvertToInvoice={onConvertToInvoice}
      onDownloadPdf={onDownloadPdf}
    />;
  }

  return <InvoiceTable
    title={title}
    invoices={docs as Invoice[]}
    data={data}
    canWrite={canWrite}
    canAdmin={canAdmin}
    onNew={onNew}
    onEdit={onEdit as (doc: Invoice) => void}
    onSend={onSendInvoice}
    onSendReminder={onSendInvoiceReminder}
    onToggleRemindersPaused={onToggleInvoiceRemindersPaused}
    onDownloadPdf={onDownloadInvoicePdf}
    onDownloadUbl={onDownloadInvoiceUbl}
    onRefund={onRefundInvoice}
    onDownloadCreditNote={onDownloadCreditNote}
    onDownloadCreditNoteUbl={onDownloadCreditNoteUbl}
    onEmailCreditNote={onEmailCreditNote}
    onPostCreditNote={onPostCreditNote}
    onPostToLedger={onPostInvoiceToLedger}
    onBookAllUnbooked={onBookAllUnbooked}
    onProposeDunning={onProposeDunning}
    onSendDunning={onSendDunning}
    onCancelDunning={onCancelDunning}
  />;
}


type FinanceKind = 'quote' | 'invoice';

/* ── Snelfilters op offertes en facturen ──────────────────────────────────
 * Bewust géén herhaling van de statuslijst die er als dropdown al staat: dit
 * zijn de vragen die je stelt en die géén enkele status beantwoordt — "moet ik
 * hier nog achteraan?", "wat loopt er dit jaar?", "wat hangt nergens aan?" */
type FinanceQuickKey = 'open' | 'overdue' | 'thisYear' | 'noProject';

/** Nog niet afgerond: de deur uit, maar nog geen beslissing of betaling.
 *  Concepten tellen niet mee — die zijn nog van jou. */
function isFinanceOutstanding(doc: Quote | Invoice): boolean {
  return !['paid', 'cancelled', 'draft', 'void', 'written_off', 'refunded'].includes(doc.status);
}

/** Over de datum = nog openstaand én de uiterste datum is voorbij. Op de status
 *  alleen kun je niet afgaan: die springt pas op 'overdue'/'expired' als er iets
 *  langsgekomen is dat hem bijwerkt. Voor een factuur is dat de vervaldatum,
 *  voor een offerte de geldigheidsdatum. */
function isFinanceOverdue(doc: Quote | Invoice): boolean {
  if (!isFinanceOutstanding(doc)) return false;
  if (doc.status === 'overdue' || doc.status === 'expired') return true;
  const deadline = 'due_date' in doc ? doc.due_date : (doc as Quote).valid_until;
  return Boolean(deadline) && (deadline as string) < new Date().toISOString().slice(0, 10);
}

const FINANCE_QUICK_FILTERS: Array<{ key: FinanceQuickKey; label: string; title: string; match: (doc: Quote | Invoice) => boolean }> = [
  { key: 'open', label: 'Openstaand', title: 'De deur uit, maar nog geen beslissing of betaling', match: isFinanceOutstanding },
  { key: 'overdue', label: 'Over de datum', title: 'Openstaand terwijl de uiterste datum al voorbij is', match: isFinanceOverdue },
  { key: 'thisYear', label: 'Dit jaar', title: 'Alleen stukken met een datum in het lopende kalenderjaar', match: doc => (doc.date ?? '').slice(0, 4) === String(new Date().getFullYear()) },
  { key: 'noProject', label: 'Zonder project', title: 'Nog aan geen enkel project gekoppeld', match: doc => !doc.project_id },
];

type FinanceSearchFilters = {
  query: string;
  clientId: string;
  projectId: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
  quick: FinanceQuickKey[];
};

const emptyFinanceSearchFilters: FinanceSearchFilters = {
  query: '',
  clientId: '',
  projectId: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  amountMin: '',
  amountMax: '',
  quick: [],
};

function createDefaultFinanceSearchFilters(): FinanceSearchFilters {
  return { ...emptyFinanceSearchFilters };
}

function FinanceSearchPanel<T extends Quote | Invoice>({
  kind,
  docs,
  data,
  filters,
  visibleCount,
  visibleTotalAmount,
  onChange,
}: {
  kind: FinanceKind;
  docs: T[];
  data: AppData;
  filters: FinanceSearchFilters;
  visibleCount: number;
  visibleTotalAmount: number;
  onChange: (filters: FinanceSearchFilters) => void;
}) {
  const isQuote = kind === 'quote';
  const clientOptions = useMemo(() => {
    const clientIds = new Set(docs.map(doc => doc.client_id).filter(Boolean));
    return data.clients
      .filter(client => clientIds.has(client.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl-NL'));
  }, [data.clients, docs]);
  const projectOptions = useMemo(() => {
    const projectIds = new Set(docs.map(doc => doc.project_id).filter(Boolean));
    return data.projects
      .filter(project => projectIds.has(project.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl-NL'));
  }, [data.projects, docs]);
  const statusOptions = useMemo(() => buildFinanceStatusOptions(kind, docs), [docs, kind]);
  // De tellers staan op de volledige lijst: een chip zegt "hoeveel zijn er zo?",
  // niet "hoeveel blijven er over als je hem aanzet".
  const chips = useMemo(
    () => FINANCE_QUICK_FILTERS.map(def => ({
      key: def.key,
      label: def.label,
      title: def.title,
      count: docs.filter(doc => def.match(doc)).length,
    })),
    [docs],
  );

  const updateFilters = (patch: Partial<FinanceSearchFilters>) => onChange({ ...filters, ...patch });
  const fields: FilterField[] = [
    { key: 'clientId', label: 'Klant', value: filters.clientId, searchable: true, searchPlaceholder: 'Zoek een klant…', options: [{ value: '', label: 'Alle klanten' }, ...clientOptions.map(client => ({ value: client.id, label: client.name }))] },
    { key: 'projectId', label: 'Project', value: filters.projectId, searchable: true, searchPlaceholder: 'Zoek een project…', options: [{ value: '', label: 'Alle projecten' }, ...projectOptions.map(project => ({ value: project.id, label: project.name }))] },
    { key: 'status', label: 'Status', value: filters.status, options: [{ value: '', label: 'Alle statussen' }, ...statusOptions] },
    { key: 'dateFrom', label: isQuote ? 'Offertedatum vanaf' : 'Factuurdatum vanaf', value: filters.dateFrom, type: 'date' },
    { key: 'dateTo', label: isQuote ? 'Offertedatum t/m' : 'Factuurdatum t/m', value: filters.dateTo, type: 'date' },
    { key: 'amountMin', label: 'Bedrag vanaf', value: filters.amountMin, inputMode: 'decimal', placeholder: '€ min.' },
    { key: 'amountMax', label: 'Bedrag t/m', value: filters.amountMax, inputMode: 'decimal', placeholder: '€ max.' },
  ];

  return <SearchFilterPanel
    ariaLabel={`${isQuote ? 'Offertes' : 'Facturen'} zoeken en filteren`}
    query={filters.query}
    queryPlaceholder={isQuote ? 'Zoek op offertenummer, klant, project, omschrijving, status of bedrag…' : 'Zoek op factuurnummer, klant, project, offerte, omschrijving, status of bedrag…'}
    onQueryChange={query => updateFilters({ query })}
    visibleCount={visibleCount}
    totalCount={docs.length}
    noun={isQuote ? 'offertes' : 'facturen'}
    summary={`${euro(visibleTotalAmount)} totaal`}
    chips={chips}
    activeChips={filters.quick}
    onChipToggle={key => {
      const quickKey = key as FinanceQuickKey;
      updateFilters({ quick: filters.quick.includes(quickKey) ? filters.quick.filter(k => k !== quickKey) : [...filters.quick, quickKey] });
    }}
    fields={fields}
    onFieldChange={(key, value) => updateFilters({ [key]: value } as Partial<FinanceSearchFilters>)}
    onReset={() => onChange(createDefaultFinanceSearchFilters())}
  />;
}

function buildFinanceStatusOptions<T extends Quote | Invoice>(kind: FinanceKind, docs: T[]): Array<{ value: string; label: string }> {
  const options = new Map<string, string>();
  docs.forEach(doc => {
    const key = getFinanceStatusKey(kind, doc);
    options.set(key, getFinanceStatusLabel(kind, doc));
  });
  return [...options.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'nl-NL'));
}

function filterFinanceDocs<T extends Quote | Invoice>(kind: FinanceKind, docs: T[], data: AppData, filters: FinanceSearchFilters): T[] {
  const query = normalizeSearchValue(filters.query);
  const amountMin = parseAmountFilter(filters.amountMin);
  const amountMax = parseAmountFilter(filters.amountMax);

  const quick = FINANCE_QUICK_FILTERS.filter(def => filters.quick.includes(def.key));

  return docs.filter(doc => {
    for (const def of quick) if (!def.match(doc)) return false;
    if (filters.clientId && doc.client_id !== filters.clientId) return false;
    if (filters.projectId && doc.project_id !== filters.projectId) return false;
    if (filters.status && getFinanceStatusKey(kind, doc) !== filters.status) return false;

    const docDate = normalizeDateInput(doc.date);
    if (filters.dateFrom && (!docDate || docDate < filters.dateFrom)) return false;
    if (filters.dateTo && (!docDate || docDate > filters.dateTo)) return false;

    const amount = total(doc.lines).total;
    if (amountMin !== null && amount < amountMin) return false;
    if (amountMax !== null && amount > amountMax) return false;

    if (!query) return true;
    return buildFinanceSearchText(kind, doc, data).includes(query);
  });
}

function buildFinanceSearchText<T extends Quote | Invoice>(kind: FinanceKind, doc: T, data: AppData): string {
  const client = data.clients.find(item => item.id === doc.client_id) ?? null;
  const project = data.projects.find(item => item.id === doc.project_id) ?? null;
  const amounts = total(doc.lines);
  const linkedQuote = kind === 'invoice' ? data.quotes.find(item => item.id === (doc as Invoice).quote_id) ?? null : null;
  const emailDeliveryText = kind === 'quote'
    ? data.quoteEmailDeliveries.filter(delivery => delivery.quote_id === doc.id).map(delivery => `${delivery.recipient_email} ${delivery.recipient_name ?? ''} ${delivery.subject} ${emailStatusLabel(delivery.status)} ${delivery.attachment_file_name ?? ''}`).join(' ')
    : data.invoiceEmailDeliveries.filter(delivery => delivery.invoice_id === doc.id).map(delivery => `${delivery.recipient_email} ${delivery.recipient_name ?? ''} ${delivery.subject} ${emailStatusLabel(delivery.status)} ${delivery.attachment_file_name ?? ''}`).join(' ');
  const invoicePaymentText = kind === 'invoice'
    ? data.invoicePaymentRecords.filter(payment => payment.invoice_id === doc.id).map(payment => `${paymentStatusLabel(payment.status)} ${payment.provider_payment_id ?? ''} ${payment.currency} ${euro(payment.amount_cents / 100)}`).join(' ')
    : '';

  const rawParts = [
    doc.number,
    getFinanceStatusLabel(kind, doc),
    statusLabel(doc.status),
    doc.status,
    doc.notes,
    doc.date,
    dateNL(doc.date),
    kind === 'quote' ? (doc as Quote).valid_until : (doc as Invoice).due_date,
    kind === 'quote' ? dateNL((doc as Quote).valid_until) : dateNL((doc as Invoice).due_date),
    client?.name,
    client?.client_code,
    client?.contact_name,
    client?.email,
    project?.name,
    project?.description,
    linkedQuote?.number,
    euro(amounts.subtotal),
    euro(amounts.vat),
    euro(amounts.total),
    amounts.subtotal.toFixed(2),
    amounts.vat.toFixed(2),
    amounts.total.toFixed(2),
    ...doc.lines.flatMap(line => [line.description, line.quantity, line.unit_price, line.vat, euro(lineGross(line))]),
    emailDeliveryText,
    invoicePaymentText,
  ];

  return normalizeSearchValue(rawParts.filter(part => part !== null && part !== undefined).join(' '));
}

function getFinanceStatusKey<T extends Quote | Invoice>(kind: FinanceKind, doc: T): string {
  if (kind === 'quote') {
    const quote = doc as Quote;
    if (quote.status === 'draft' && quote.internal_approval_status === 'rejected') return 'internal_rejected';
  }
  return doc.status;
}

function getFinanceStatusLabel<T extends Quote | Invoice>(kind: FinanceKind, doc: T): string {
  if (kind === 'quote') return quoteStatusLabel(doc as Quote);
  return statusLabel((doc as Invoice).status);
}

function parseAmountFilter(value: string): number | null {
  const compact = value.replace(/\s/g, '').replace(/[€]/g, '');
  const normalized = compact.includes(',') && compact.includes('.')
    ? compact.replace(/\./g, '').replace(',', '.')
    : compact.includes(',')
      ? compact.replace(',', '.')
      : compact;
  const safeValue = normalized.replace(/[^0-9.-]/g, '');
  if (!safeValue) return null;
  const parsed = Number(safeValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '';
}

function normalizeSearchValue(value: string): string {
  return value
    .toLocaleLowerCase('nl-NL')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[€.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function FinanceSearchEmptyState({ kind, onReset }: { kind: FinanceKind; onReset: () => void }) {
  return <div className="empty quote-table-empty finance-search-empty"><div className="e-big">Geen {kind === 'quote' ? 'offertes' : 'facturen'} gevonden</div><p>Pas je zoekterm of filters aan om meer resultaten te tonen.</p><button type="button" onClick={onReset}><RotateCcw size={14}/> Filters wissen</button></div>;
}

function QuoteTable({
  title,
  quotes,
  data,
  canWrite,
  canAdmin,
  onNew,
  onEdit,
  onSubmitApproval,
  onApprove,
  onReject,
  onSend,
  onConvertToInvoice,
  onDownloadPdf,
}: {
  title: string;
  quotes: Quote[];
  data: AppData;
  canWrite: boolean;
  canAdmin: boolean;
  onNew: () => void;
  onEdit: (quote: Quote) => void;
  onSubmitApproval?: (quote: Quote) => void;
  onApprove?: (quote: Quote) => void;
  onReject?: (quote: Quote) => void;
  onSend?: (quote: Quote) => void;
  onConvertToInvoice?: (quote: Quote) => void;
  onDownloadPdf?: (quote: Quote) => void;
}) {
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const [searchFilters, setSearchFilters] = useState<FinanceSearchFilters>(() => createDefaultFinanceSearchFilters());
  const filteredQuotes = useMemo(() => filterFinanceDocs('quote', quotes, data, searchFilters), [data, quotes, searchFilters]);
  const selectedQuote = useMemo(() => quotes.find(quote => quote.id === selectedQuoteId) ?? null, [quotes, selectedQuoteId]);
  const visibleTotalAmount = useMemo(() => filteredQuotes.reduce((sum, quote) => sum + total(quote.lines).total, 0), [filteredQuotes]);

  return <>
    <div className="fin-header quote-table-header">
      <div>
        <h2>{title}</h2>
        <p>Compact overzicht met bedragen, klant- en projectcontext. Klik op een offerte voor workflow en details.</p>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw</Button>
    </div>

    <FinanceSearchPanel kind="quote" docs={quotes} data={data} filters={searchFilters} visibleCount={filteredQuotes.length} visibleTotalAmount={visibleTotalAmount} onChange={setSearchFilters} />

    <div className="quote-table-card">
      <div className="quote-table-scroll" role="region" aria-label="Offertes tabel">
        <table className="quote-table">
          <thead>
            <tr>
              <th>Offerte</th><th>Klant</th><th>Project</th><th>Datum</th><th>Verloopt</th><th className="money">Bedrag ex.</th><th className="money">BTW</th><th className="money">Totaal</th><th>Status</th><th aria-label="Acties" />
            </tr>
          </thead>
          <tbody>
            {filteredQuotes.map(quote => {
              const client = data.clients.find(c => c.id === quote.client_id) ?? null;
              const project = data.projects.find(p => p.id === quote.project_id) ?? null;
              const amounts = total(quote.lines);
              return <tr key={quote.id} className={`quote-table-row st-${quote.status}`} onClick={() => setSelectedQuoteId(quote.id)} tabIndex={0} onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedQuoteId(quote.id); }
              }}>
                <td data-label="Offerte"><strong>{quote.number}</strong></td>
                <td data-label="Klant"><span>{client?.name ?? 'Geen klant'}</span></td>
                <td data-label="Project"><span>{project?.name ?? 'Geen project'}</span></td>
                <td data-label="Datum"><span>{dateNL(quote.date)}</span></td>
                <td data-label="Verloopt"><span>{dateNL(quote.valid_until)}</span></td>
                <td data-label="Bedrag ex." className="money"><span>{euro(amounts.subtotal)}</span></td>
                <td data-label="BTW" className="money"><span>{euro(amounts.vat)}</span></td>
                <td data-label="Totaal" className="money total"><strong>{euro(amounts.total)}</strong></td>
                <td data-label="Status"><span className={`fin-status ${quote.status}`}>{quoteStatusLabel(quote)}</span></td>
                <td className="quote-row-actions" onClick={event => event.stopPropagation()}>
                  <button type="button" className="att-btn" onClick={() => setSelectedQuoteId(quote.id)} title="Bekijk details"><Eye size={14}/></button>
                  {quoteHasStoredPdf(quote)
                    ? <button type="button" className="att-btn" onClick={() => onDownloadPdf?.(quote)} title="Download verzonden PDF"><Download size={14}/></button>
                    : <button type="button" className="att-btn" onClick={() => { void exportFinancePDF(quote, 'quote', client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }} title="Download concept-PDF"><Download size={14}/></button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      {quotes.length === 0 && <div className="empty quote-table-empty"><div className="e-big">Nog geen offertes</div><p>Maak je eerste offerte aan om de workflow te starten.</p></div>}
      {quotes.length > 0 && filteredQuotes.length === 0 && <FinanceSearchEmptyState kind="quote" onReset={() => setSearchFilters(createDefaultFinanceSearchFilters())} />}
    </div>

    {selectedQuote && <QuoteDetailModal
      quote={selectedQuote}
      data={data}
      canWrite={canWrite}
      canAdmin={canAdmin}
      onClose={() => setSelectedQuoteId(null)}
      onEdit={(quote) => { setSelectedQuoteId(null); onEdit(quote); }}
      onSubmitApproval={onSubmitApproval}
      onApprove={onApprove}
      onReject={onReject}
      onSend={onSend}
      onConvertToInvoice={onConvertToInvoice}
      onDownloadPdf={onDownloadPdf}
    />}
  </>;
}

function InvoiceTable({
  title,
  invoices,
  data,
  canWrite,
  canAdmin = false,
  onNew,
  onEdit,
  onSend,
  onSendReminder,
  onToggleRemindersPaused,
  onDownloadPdf,
  onDownloadUbl,
  onRefund,
  onDownloadCreditNote,
  onDownloadCreditNoteUbl,
  onEmailCreditNote,
  onPostCreditNote,
  onPostToLedger,
  onBookAllUnbooked,
  onProposeDunning,
  onSendDunning,
  onCancelDunning,
}: {
  title: string;
  invoices: Invoice[];
  data: AppData;
  canWrite: boolean;
  canAdmin?: boolean;
  onNew: () => void;
  onEdit: (invoice: Invoice) => void;
  onSend?: (invoice: Invoice) => void;
  onSendReminder?: (invoice: Invoice) => void;
  onToggleRemindersPaused?: (invoice: Invoice, paused: boolean) => void;
  onDownloadPdf?: (invoice: Invoice) => void;
  onDownloadUbl?: (invoice: Invoice) => void;
  onRefund?: (invoice: Invoice, input: RefundInput) => Promise<void>;
  onDownloadCreditNote?: (creditNote: CreditNote) => void;
  onDownloadCreditNoteUbl?: (creditNote: CreditNote) => void;
  onEmailCreditNote?: (creditNote: CreditNote) => void;
  onPostCreditNote?: (creditNote: CreditNote) => void;
  onPostToLedger?: (invoice: Invoice) => void;
  onBookAllUnbooked?: () => void;
  onProposeDunning?: (invoice: Invoice) => void;
  onSendDunning?: (notice: DunningNotice) => void;
  onCancelDunning?: (notice: DunningNotice) => void;
}) {
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [searchFilters, setSearchFilters] = useState<FinanceSearchFilters>(() => createDefaultFinanceSearchFilters());
  const filteredInvoices = useMemo(() => filterFinanceDocs('invoice', invoices, data, searchFilters), [data, invoices, searchFilters]);
  const selectedInvoice = useMemo(() => invoices.find(invoice => invoice.id === selectedInvoiceId) ?? null, [invoices, selectedInvoiceId]);
  const visibleTotalAmount = useMemo(() => filteredInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0), [filteredInvoices]);
  // Uitgegeven facturen (verstuurd t/m betaald) horen automatisch in het grootboek
  // te staan. Zijn er toch niet-geboekte, dan is er iets misgegaan bij het
  // automatisch boeken — toon een vangnet-banner om alsnog te boeken.
  const unbookedInvoices = useMemo(
    () => invoices.filter(i => ['sent', 'accepted', 'paid', 'overdue'].includes(i.status) && !i.journal_entry_id),
    [invoices]);

  return <>
    <div className="fin-header quote-table-header">
      <div>
        <h2>{title}</h2>
        <p>Volwassen factuurmodule met detailpaneel, verzendhistorie, Mollie-betaalstatus, snapshots en audit-timeline.</p>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw</Button>
    </div>

    {onBookAllUnbooked && unbookedInvoices.length > 0 && (
      <div className="fin-autobook-banner" role="status">
        <AlertTriangle size={16} />
        <span>{unbookedInvoices.length} verstuurde/betaalde factuur(en) staan nog niet in het grootboek. Verstuurde facturen worden normaal automatisch geboekt (factuurstelsel).</span>
        {canWrite && <Button onClick={onBookAllUnbooked}><BookOpen size={14} /> Boek nu alsnog</Button>}
      </div>
    )}

    <FinanceSearchPanel kind="invoice" docs={invoices} data={data} filters={searchFilters} visibleCount={filteredInvoices.length} visibleTotalAmount={visibleTotalAmount} onChange={setSearchFilters} />

    <div className="quote-table-card invoice-table-card">
      <div className="quote-table-scroll" role="region" aria-label="Facturen tabel">
        <table className="quote-table invoice-table">
          <thead>
            <tr><th>Factuur</th><th>Klant</th><th>Project</th><th>Offerte</th><th>Datum</th><th>Vervalt</th><th className="money">Bedrag ex.</th><th className="money">BTW</th><th className="money">Totaal</th><th>Status</th><th aria-label="Acties" /></tr>
          </thead>
          <tbody>
            {filteredInvoices.map(invoice => {
              const client = data.clients.find(c => c.id === invoice.client_id) ?? null;
              const project = data.projects.find(p => p.id === invoice.project_id) ?? null;
              const quote = data.quotes.find(q => q.id === invoice.quote_id) ?? null;
              const amounts = total(invoice.lines);
              return <tr key={invoice.id} className={`quote-table-row st-${invoice.status}`} onClick={() => setSelectedInvoiceId(invoice.id)} tabIndex={0} onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedInvoiceId(invoice.id); }
              }}>
                <td data-label="Factuur"><strong>{invoice.number}</strong></td>
                <td data-label="Klant"><span>{client?.name ?? 'Geen klant'}</span></td>
                <td data-label="Project"><span>{project?.name ?? 'Geen project'}</span></td>
                <td data-label="Offerte"><span>{quote?.number ?? '—'}</span></td>
                <td data-label="Datum"><span>{dateNL(invoice.date)}</span></td>
                <td data-label="Vervalt"><span>{dateNL(invoice.due_date)}</span></td>
                <td data-label="Bedrag ex." className="money"><span>{euro(amounts.subtotal)}</span></td>
                <td data-label="BTW" className="money"><span>{euro(amounts.vat)}</span></td>
                <td data-label="Totaal" className="money total"><strong>{euro(amounts.total)}</strong></td>
                <td data-label="Status"><span className={`fin-status ${invoice.status}`}>{statusLabel(invoice.status)}</span>{['sent','accepted','paid','overdue'].includes(invoice.status) && !invoice.journal_entry_id && <span className="fin-reminder-pill unbooked" title="Nog niet in het grootboek geboekt">niet geboekt</span>}{(invoice.reminder_level ?? 0) > 0 && <span className="fin-reminder-pill" title={`Laatste herinnering verstuurd: niveau ${invoice.reminder_level}${invoice.last_reminder_at ? ` op ${dateNL(invoice.last_reminder_at)}` : ''}`}>H{invoice.reminder_level}</span>}{invoice.reminders_paused && <span className="fin-reminder-pill paused" title="Automatische herinneringen gepauzeerd">⏸</span>}</td>
                <td className="quote-row-actions" onClick={event => event.stopPropagation()}>
                  <button type="button" className="att-btn" onClick={() => setSelectedInvoiceId(invoice.id)} title="Bekijk details"><Eye size={14}/></button>
                  {invoiceHasStoredPdf(invoice) && onDownloadPdf
                    ? <button type="button" className="att-btn" onClick={() => onDownloadPdf(invoice)} title="Download verzonden PDF"><Download size={14}/></button>
                    : <button type="button" className="att-btn" onClick={() => { void exportFinancePDF(invoice, 'invoice', client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }} title="Download concept-PDF"><Download size={14}/></button>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      {invoices.length === 0 && <div className="empty quote-table-empty"><div className="e-big">Nog geen facturen</div><p>Zet een geaccepteerde offerte om of maak handmatig een conceptfactuur aan.</p></div>}
      {invoices.length > 0 && filteredInvoices.length === 0 && <FinanceSearchEmptyState kind="invoice" onReset={() => setSearchFilters(createDefaultFinanceSearchFilters())} />}
    </div>

    {selectedInvoice && <InvoiceDetailModal
      invoice={selectedInvoice}
      data={data}
      canWrite={canWrite}
      canAdmin={canAdmin}
      onClose={() => setSelectedInvoiceId(null)}
      onEdit={(invoice) => { setSelectedInvoiceId(null); onEdit(invoice); }}
      onSend={onSend}
      onSendReminder={onSendReminder}
      onToggleRemindersPaused={onToggleRemindersPaused}
      onDownloadPdf={onDownloadPdf}
      onDownloadUbl={onDownloadUbl}
      onRefund={onRefund}
      onDownloadCreditNote={onDownloadCreditNote}
      onDownloadCreditNoteUbl={onDownloadCreditNoteUbl}
      onEmailCreditNote={onEmailCreditNote}
      onPostCreditNote={onPostCreditNote}
      onPostToLedger={onPostToLedger}
      onProposeDunning={onProposeDunning}
      onSendDunning={onSendDunning}
      onCancelDunning={onCancelDunning}
    />}
  </>;
}

function QuoteDetailModal({
  quote,
  data,
  canWrite,
  canAdmin,
  onClose,
  onEdit,
  onSubmitApproval,
  onApprove,
  onReject,
  onSend,
  onConvertToInvoice,
  onDownloadPdf,
}: {
  quote: Quote;
  data: AppData;
  canWrite: boolean;
  canAdmin: boolean;
  onClose: () => void;
  onEdit: (quote: Quote) => void;
  onSubmitApproval?: (quote: Quote) => void;
  onApprove?: (quote: Quote) => void;
  onReject?: (quote: Quote) => void;
  onSend?: (quote: Quote) => void;
  onConvertToInvoice?: (quote: Quote) => void;
  onDownloadPdf?: (quote: Quote) => void;
}) {
  const client = data.clients.find(c => c.id === quote.client_id) ?? null;
  const project = data.projects.find(p => p.id === quote.project_id) ?? null;
  const amounts = total(quote.lines);
  const events = data.quoteApprovalEvents.filter(event => event.quote_id === quote.id);
  const deliveries = data.quoteEmailDeliveries.filter(delivery => delivery.quote_id === quote.id);
  const latestDelivery = deliveries[0] ?? null;
  const versions = data.quoteVersions.filter(version => version.quote_id === quote.id);
  const linkedInvoice = data.invoices.find(invoice => invoice.quote_id === quote.id) ?? null;

  return <Modal title={`Offerte ${quote.number}`} onClose={onClose} className="quote-detail-modal has-preview">
    <div className="quote-detail-layout">
      <div className="quote-detail quote-detail-main">
      <section className="quote-detail-hero">
        <div>
          <span className="quote-detail-kicker">Offerteflow</span>
          <h2>{client?.name ?? 'Geen klant'}</h2>
          <p>{project?.name ?? 'Geen project gekoppeld'} · {dateNL(quote.date)} tot {dateNL(quote.valid_until)}</p>
        </div>
        <div className="quote-detail-total"><small>Totaal incl. btw</small><strong>{euro(amounts.total)}</strong><span className={`fin-status ${quote.status}`}>{quoteStatusLabel(quote)}</span></div>
      </section>

      <section className="quote-detail-metrics" aria-label="Offerte bedragen en datums">
        <QuoteMetric label="Bedrag ex. btw" value={euro(amounts.subtotal)} />
        <QuoteMetric label="BTW" value={euro(amounts.vat)} />
        <QuoteMetric label="Totaal" value={euro(amounts.total)} strong />
        <QuoteMetric label="Datum" value={dateNL(quote.date)} />
        <QuoteMetric label="Verloopdatum" value={dateNL(quote.valid_until)} />
        <QuoteMetric label="Factuur" value={linkedInvoice ? linkedInvoice.number : 'Nog niet omgezet'} />
      </section>

      <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Workflow</span><strong>Goedkeuring, verzending, klantbeslissing en factuurconversie</strong></div></div>
        <QuoteProgress quote={quote} />
        <QuoteEmailStatus delivery={latestDelivery} quote={quote} />
        <QuoteActions quote={quote} canWrite={canWrite} canAdmin={canAdmin} linkedInvoice={linkedInvoice} onSubmitApproval={onSubmitApproval} onApprove={onApprove} onReject={onReject} onSend={onSend} onConvertToInvoice={onConvertToInvoice} onDownloadPdf={onDownloadPdf} onEdit={() => onEdit(quote)} />
      </section>

      <section className="quote-detail-split">
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Versies</span><strong>Vastgelegde snapshots</strong></div></div><QuoteVersions versions={versions} /></div>
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Regels</span><strong>Offertebedragen</strong></div></div><FinanceLineTable lines={quote.lines} emptyText="Geen offerteregels." /></div>
      </section>

      <section className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Tijdlijn</span><strong>Alle workflow-events</strong></div></div><QuoteTimeline events={events} emptyText="Nog geen workflow-events." /></section>
      </div>
      <div className="finance-preview-pane">
        <FinanceDocPreview doc={quote} kind="quote" client={client} company={data.companySettings} title="Offerte-voorbeeld" />
      </div>
    </div>
  </Modal>;
}

function InvoiceDetailModal({
  invoice,
  data,
  canWrite,
  canAdmin = false,
  onClose,
  onEdit,
  onSend,
  onSendReminder,
  onToggleRemindersPaused,
  onDownloadPdf,
  onDownloadUbl,
  onRefund,
  onDownloadCreditNote,
  onDownloadCreditNoteUbl,
  onEmailCreditNote,
  onPostCreditNote,
  onPostToLedger,
  onProposeDunning,
  onSendDunning,
  onCancelDunning,
}: {
  invoice: Invoice;
  data: AppData;
  canWrite: boolean;
  canAdmin?: boolean;
  onClose: () => void;
  onEdit: (invoice: Invoice) => void;
  onSend?: (invoice: Invoice) => void;
  onSendReminder?: (invoice: Invoice) => void;
  onToggleRemindersPaused?: (invoice: Invoice, paused: boolean) => void;
  onDownloadPdf?: (invoice: Invoice) => void;
  onDownloadUbl?: (invoice: Invoice) => void;
  onRefund?: (invoice: Invoice, input: RefundInput) => Promise<void>;
  onDownloadCreditNote?: (creditNote: CreditNote) => void;
  onDownloadCreditNoteUbl?: (creditNote: CreditNote) => void;
  onEmailCreditNote?: (creditNote: CreditNote) => void;
  onPostCreditNote?: (creditNote: CreditNote) => void;
  onPostToLedger?: (invoice: Invoice) => void;
  onProposeDunning?: (invoice: Invoice) => void;
  onSendDunning?: (notice: DunningNotice) => void;
  onCancelDunning?: (notice: DunningNotice) => void;
}) {
  const client = data.clients.find(c => c.id === invoice.client_id) ?? null;
  const project = data.projects.find(p => p.id === invoice.project_id) ?? null;
  const quote = data.quotes.find(q => q.id === invoice.quote_id) ?? null;
  const amounts = total(invoice.lines);
  const events = data.invoiceWorkflowEvents.filter(event => event.invoice_id === invoice.id);
  const deliveries = data.invoiceEmailDeliveries.filter(delivery => delivery.invoice_id === invoice.id);
  const reminderDeliveries = deliveries.filter(delivery => delivery.delivery_kind === 'reminder');
  const latestDelivery = deliveries[0] ?? null;
  const payments = data.invoicePaymentRecords.filter(payment => payment.invoice_id === invoice.id);
  const latestPayment = payments[0] ?? null;
  const versions = data.invoiceVersions.filter(version => version.invoice_id === invoice.id);
  const refunds = data.invoiceRefunds.filter(refund => refund.invoice_id === invoice.id);
  const creditNotes = data.creditNotes.filter(creditNote => creditNote.invoice_id === invoice.id);
  const chargebacks = data.invoiceChargebacks.filter(chargeback => chargeback.invoice_id === invoice.id);
  const dunningNotice = data.dunningNotices.find(notice => notice.invoice_id === invoice.id) ?? null;
  const refundedAmount = invoice.refunded_amount ?? 0;
  const chargedBackAmount = invoice.charged_back_amount ?? 0;
  // Nog niet-afgeronde (Mollie-)terugbetalingen tellen wel mee in de over-refund-guard
  // maar nog niet in refunded_amount; trek ze af voor een eerlijk "resterend" bedrag.
  const inFlightCents = refunds
    .filter(refund => refund.status === 'queued' || refund.status === 'pending' || refund.status === 'processing')
    .reduce((sum, refund) => sum + refund.amount_cents, 0);
  // Mollie-terugbetaling is alleen mogelijk als de factuur via Mollie is betaald en er
  // nog terugbetaalbaar bedrag op die betaling staat.
  const mollieRefundable = payments.some(payment =>
    payment.provider === 'mollie'
    && (payment.status === 'paid' || payment.status === 'refunded')
    && !!payment.provider_payment_id
    && ((payment.amount_cents || 0) - (payment.amount_refunded_cents || 0)) > 0);
  const [showRefund, setShowRefund] = useState(false);

  return <Modal title={`Factuur ${invoice.number}`} onClose={onClose} className="quote-detail-modal invoice-detail-modal has-preview">
    <div className="quote-detail-layout">
      <div className="quote-detail invoice-detail quote-detail-main">
      <section className="quote-detail-hero">
        <div>
          <span className="quote-detail-kicker">Facturatieflow</span>
          <h2>{client?.name ?? 'Geen klant'}</h2>
          <p>{project?.name ?? 'Geen project gekoppeld'} · {dateNL(invoice.date)} · vervalt {dateNL(invoice.due_date)}</p>
        </div>
        <div className="quote-detail-total"><small>Totaal incl. btw</small><strong>{euro(amounts.total)}</strong><span className={`fin-status ${invoice.status}`}>{statusLabel(invoice.status)}</span>{refundedAmount > 0 && invoice.status !== 'refunded' && <span className="fin-status refunded">Gedeeltelijk terugbetaald · {euro(refundedAmount)}</span>}{chargedBackAmount > 0 && <span className="fin-status charged-back">Teruggeboekt · {euro(chargedBackAmount)}</span>}</div>
      </section>

      <section className="quote-detail-metrics" aria-label="Factuur bedragen en statussen">
        <QuoteMetric label="Bedrag ex. btw" value={euro(amounts.subtotal)} />
        <QuoteMetric label="BTW" value={euro(amounts.vat)} />
        <QuoteMetric label="Totaal" value={euro(amounts.total)} strong />
        <QuoteMetric label="Gekoppelde offerte" value={quote?.number ?? 'Geen'} />
        <QuoteMetric label="Mailstatus" value={latestDelivery?.status ? emailStatusLabel(latestDelivery.status) : (invoice.last_email_delivery_status ? emailStatusLabel(invoice.last_email_delivery_status) : 'Nog niet verstuurd')} />
        <QuoteMetric label="Betaalstatus" value={latestPayment ? paymentStatusLabel(latestPayment.status) : statusLabel(invoice.status)} />
        {refundedAmount > 0 && <QuoteMetric label="Terugbetaald" value={euro(refundedAmount)} />}
        {chargedBackAmount > 0 && <QuoteMetric label="Teruggeboekt" value={euro(chargedBackAmount)} />}
      </section>

      {amounts.vatBreakdown.length > 1 && <section className="quote-detail-metrics" aria-label="BTW-uitsplitsing per tarief">
        {amounts.vatBreakdown.map(row => <QuoteMetric key={row.rate} label={`BTW ${row.rate}% over ${euro(row.base)}`} value={euro(row.vat)} />)}
      </section>}

      <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Acties</span><strong>Versturen, betaallink en PDF-snapshot</strong></div></div>
        <InvoiceStatusStrip invoice={invoice} delivery={latestDelivery} payment={latestPayment} />
        <InvoiceActions invoice={invoice} canWrite={canWrite} canAdmin={canAdmin} payment={latestPayment} onEdit={() => onEdit(invoice)} onSend={onSend} onSendReminder={onSendReminder} onDownloadPdf={onDownloadPdf} onDownloadUbl={onDownloadUbl} onRefund={canAdmin && onRefund ? () => setShowRefund(true) : undefined} onPostToLedger={onPostToLedger} />
        {showRefund && onRefund && <RefundModal invoice={invoice} mollieRefundable={mollieRefundable} inFlightCents={inFlightCents} onClose={() => setShowRefund(false)} onSubmit={(input) => onRefund(invoice, input)} />}
      </section>

      {(invoiceIsReminderEligible(invoice) || (invoice.reminder_level ?? 0) > 0 || reminderDeliveries.length > 0) && <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Betalingsherinneringen</span><strong>Getrapte aanmaningen</strong></div></div>
        <InvoiceReminderPanel invoice={invoice} reminders={reminderDeliveries} canWrite={canWrite} onToggleRemindersPaused={onToggleRemindersPaused} />
      </section>}

      {(dunningNotice || invoiceIsReminderEligible(invoice)) && <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Aanmaning</span><strong>Formele aanmaning · rente + WIK-incassokosten</strong></div></div>
        <InvoiceDunningPanel invoice={invoice} notice={dunningNotice} canWrite={canWrite} onPropose={onProposeDunning} onSend={onSendDunning} onCancel={onCancelDunning} />
      </section>}

      <section className="quote-detail-split">
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Regels</span><strong>Factuurbedragen</strong></div></div><FinanceLineTable lines={invoice.lines} emptyText="Geen factuurregels." /></div>
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Verzendhistorie</span><strong>Resend en PDF</strong></div></div><InvoiceDeliveries deliveries={deliveries} /></div>
      </section>

      <section className="quote-detail-split">
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Betalingen</span><strong>Mollie records</strong></div></div><InvoicePayments payments={payments} /></div>
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>PDF-snapshots</span><strong>Factuurversies</strong></div></div><InvoiceVersions versions={versions} /></div>
      </section>

      {(refunds.length > 0 || creditNotes.length > 0) && <section className="quote-detail-split">
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Terugbetalingen</span><strong>Refund-ledger</strong></div></div><InvoiceRefunds refunds={refunds} /></div>
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Creditfacturen</span><strong>Credit notes</strong></div></div><CreditNotes creditNotes={creditNotes} canWrite={canWrite} onDownload={onDownloadCreditNote} onDownloadUbl={onDownloadCreditNoteUbl} onEmail={onEmailCreditNote} onPostToLedger={onPostCreditNote} /></div>
      </section>}

      {chargebacks.length > 0 && <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Terugboekingen</span><strong>Chargebacks via de bank</strong></div></div>
        <InvoiceChargebacks chargebacks={chargebacks} />
      </section>}

      <section className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Audit-timeline</span><strong>Alle factuur-events</strong></div></div><InvoiceTimeline events={events} emptyText="Nog geen factuur-events." /></section>
      </div>
      <div className="finance-preview-pane">
        <FinanceDocPreview doc={invoice} kind="invoice" client={client} company={data.companySettings} title="Factuur-voorbeeld" />
      </div>
    </div>
  </Modal>;
}

function QuoteMetric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`quote-metric ${strong ? 'strong' : ''}`}><span>{label}</span><strong>{value}</strong></div>;
}

function FinanceLineTable({ lines, emptyText }: { lines: FinanceLine[]; emptyText: string }) {
  if (lines.length === 0) return <div className="quote-lines-empty">{emptyText}</div>;
  return <div className="quote-lines-table-wrap">
    <table className="quote-lines-table">
      <thead><tr><th>Omschrijving</th><th>Aantal</th><th>Prijs</th><th>BTW</th><th>Totaal</th></tr></thead>
      <tbody>{lines.map(line => {
        return <tr key={line.id}><td>{line.description || '—'}</td><td>{line.quantity}</td><td>{euro(line.unit_price)}</td><td>{line.vat}%</td><td>{euro(lineGross(line))}</td></tr>;
      })}</tbody>
    </table>
  </div>;
}

export function ProjectQuotesPanel({
  data,
  projectId,
  canWrite,
  canAdmin,
  onNewQuote,
  onEditQuote,
  onSubmitApproval,
  onApprove,
  onReject,
  onSend,
  onConvertToInvoice,
  onDownloadPdf,
  hideHeader = false,
}: {
  data: AppData;
  projectId: string;
  canWrite: boolean;
  canAdmin: boolean;
  onNewQuote: () => void;
  onEditQuote: (quote: Quote) => void;
  onSubmitApproval: (quote: Quote) => void;
  onApprove: (quote: Quote) => void;
  onReject: (quote: Quote) => void;
  onSend: (quote: Quote) => void;
  onConvertToInvoice?: (quote: Quote) => void;
  onDownloadPdf?: (quote: Quote) => void;
  hideHeader?: boolean;
}) {
  const quotes = data.quotes.filter(quote => quote.project_id === projectId);
  return <section className="project-quotes-panel">
    {!hideHeader && <div className="section-head-inline project-section-head"><div><h2>Offertes</h2><p>Projectgekoppelde offertes met interne goedkeuring, Resend-status, klantbeslissing en factuurconversie.</p></div><Button variant="primary" onClick={onNewQuote} disabled={!canWrite}>+ Offerte</Button></div>}
    {quotes.length === 0 ? <div className="empty project-empty"><div className="e-big">Nog geen offertes bij dit project</div><p>Maak een offerte direct vanuit het project, dan worden klant en project automatisch gekoppeld.</p></div> : <div className="project-quotes-list">
      {quotes.map(quote => {
        const client = data.clients.find(item => item.id === quote.client_id) ?? null;
        const latestDelivery = data.quoteEmailDeliveries.find(delivery => delivery.quote_id === quote.id) ?? null;
        const events = data.quoteApprovalEvents.filter(event => event.quote_id === quote.id).slice(0, 4);
        const versions = data.quoteVersions.filter(version => version.quote_id === quote.id).slice(0, 3);
        const linkedInvoice = data.invoices.find(invoice => invoice.quote_id === quote.id) ?? null;
        return <article key={quote.id} className={`project-quote-card st-${quote.status}`}>
          <div className="project-quote-head" onClick={() => onEditQuote(quote)}><div><strong>{quote.number}</strong><span>{client?.name ?? 'Geen klant'} · {dateNL(quote.date)}</span></div><div><strong>{euro(total(quote.lines).total)}</strong><span>{quoteStatusLabel(quote)}</span></div></div>
          <QuoteProgress quote={quote} compact />
          <QuoteEmailStatus delivery={latestDelivery} quote={quote} />
          <QuoteActions quote={quote} canWrite={canWrite} canAdmin={canAdmin} linkedInvoice={linkedInvoice} onSubmitApproval={onSubmitApproval} onApprove={onApprove} onReject={onReject} onSend={onSend} onConvertToInvoice={onConvertToInvoice} onDownloadPdf={onDownloadPdf} onEdit={() => onEditQuote(quote)} compact />
          <QuoteVersions versions={versions} compact />
          <QuoteTimeline events={events} emptyText="Nog geen events." compact />
        </article>;
      })}
    </div>}
  </section>;
}

function QuoteProgress({ quote, compact = false }: { quote: Quote; compact?: boolean }) {
  const steps = [
    { key: 'draft', label: 'Concept', done: true },
    { key: 'approval', label: 'Interne check', done: ['pending','approved'].includes(quote.internal_approval_status), current: quote.status === 'pending_internal_approval' },
    { key: 'approved', label: 'Goedgekeurd', done: quote.internal_approval_status === 'approved', current: quote.status === 'internally_approved' },
    { key: 'sent', label: 'Verzonden', done: ['sent','accepted','rejected'].includes(quote.status), current: quote.status === 'sent' },
    { key: 'decision', label: quote.status === 'rejected' ? 'Geweigerd' : 'Akkoord', done: ['accepted','rejected'].includes(quote.status), current: ['accepted','rejected'].includes(quote.status) },
  ];
  return <div className={`quote-progress ${compact ? 'compact' : ''}`}>{steps.map(step => <div key={step.key} className={`quote-step ${step.done ? 'done' : ''} ${step.current ? 'current' : ''}`}><span />{!compact && <small>{step.label}</small>}</div>)}</div>;
}

function QuoteEmailStatus({ quote, delivery }: { quote: Quote; delivery: QuoteEmailDelivery | null }) {
  const status = delivery?.status || quote.last_email_delivery_status;
  return <div className="quote-email-status"><Mail size={14}/><span>{status ? emailStatusLabel(status) : 'Nog niet verstuurd'}</span>{delivery?.recipient_email && <small>{delivery.recipient_email}</small>}{delivery?.attachment_file_name && <small>PDF: {delivery.attachment_file_name}</small>}{quote.public_token_expires_at && <small>Link tot {dateNL(quote.public_token_expires_at)}</small>}</div>;
}

function QuoteActions({ quote, canWrite, canAdmin, linkedInvoice, onSubmitApproval, onApprove, onReject, onSend, onConvertToInvoice, onDownloadPdf, onEdit, compact = false }: { quote: Quote; canWrite: boolean; canAdmin: boolean; linkedInvoice?: Invoice | null; onSubmitApproval?: (quote: Quote) => void; onApprove?: (quote: Quote) => void; onReject?: (quote: Quote) => void; onSend?: (quote: Quote) => void; onConvertToInvoice?: (quote: Quote) => void; onDownloadPdf?: (quote: Quote) => void; onEdit: () => void; compact?: boolean }) {
  const canSubmit = canWrite && ['draft'].includes(quote.status) && quote.internal_approval_status !== 'pending';
  const canApprove = canAdmin && quote.status === 'pending_internal_approval';
  const canSend = canWrite && quote.status === 'internally_approved' && quote.internal_approval_status === 'approved';
  const canConvert = canWrite && quote.status === 'accepted' && !linkedInvoice;
  const canDownloadStored = Boolean(onDownloadPdf) && quoteHasStoredPdf(quote);
  return <div className={`quote-actions ${compact ? 'compact' : ''}`}>
    <Button onClick={onEdit}>Bewerken</Button>
    {canSubmit && <Button onClick={() => onSubmitApproval?.(quote)}><ShieldCheck size={14}/> Ter goedkeuring</Button>}
    {canApprove && <Button variant="primary" onClick={() => onApprove?.(quote)}><ShieldCheck size={14}/> Goedkeuren</Button>}
    {canApprove && <Button variant="danger" onClick={() => onReject?.(quote)}><XCircle size={14}/> Afwijzen</Button>}
    {canSend && <Button variant="primary" onClick={() => onSend?.(quote)}><Send size={14}/> Verstuur via Resend</Button>}
    {canDownloadStored && <Button onClick={() => onDownloadPdf?.(quote)}><Download size={14}/> Download verzonden PDF</Button>}
    {canConvert && <Button variant="primary" onClick={() => onConvertToInvoice?.(quote)}><FileText size={14}/> Maak factuur van offerte</Button>}
    {linkedInvoice && <span className="quote-converted-pill"><FileText size={14}/> Factuur {linkedInvoice.number}</span>}
  </div>;
}

/**
 * A quote has an immutable, server-stored PDF snapshot once it has been sent to
 * the client (or progressed beyond that). Used to decide whether the download
 * button should fetch the stored snapshot or regenerate a draft PDF.
 */
function quoteHasStoredPdf(quote: Quote): boolean {
  return ['sent', 'accepted', 'rejected', 'expired'].includes(quote.status) || Boolean(quote.sent_at);
}

function InvoiceStatusStrip({ invoice, delivery, payment }: { invoice: Invoice; delivery: InvoiceEmailDelivery | null; payment: InvoicePaymentRecord | null }) {
  return <div className="quote-email-status invoice-status-strip">
    <Mail size={14}/><span>{delivery?.status ? emailStatusLabel(delivery.status) : 'Nog niet verstuurd'}</span>
    {delivery?.recipient_email && <small>{delivery.recipient_email}</small>}
    {delivery?.attachment_file_name && <small>PDF: {delivery.attachment_file_name}</small>}
    <CreditCard size={14}/><span>{payment ? paymentStatusLabel(payment.status) : 'Nog geen betaallink'}</span>
    {payment?.provider_checkout_url && <a href={payment.provider_checkout_url} target="_blank" rel="noreferrer">Open betaallink</a>}
    {invoice.public_token_expires_at && <small>Publieke link tot {dateNL(invoice.public_token_expires_at)}</small>}
  </div>;
}

function InvoiceActions({ invoice, canWrite, canAdmin = false, payment, onEdit, onSend, onSendReminder, onDownloadPdf, onDownloadUbl, onRefund, onPostToLedger }: { invoice: Invoice; canWrite: boolean; canAdmin?: boolean; payment: InvoicePaymentRecord | null; onEdit: () => void; onSend?: (invoice: Invoice) => void; onSendReminder?: (invoice: Invoice) => void; onDownloadPdf?: (invoice: Invoice) => void; onDownloadUbl?: (invoice: Invoice) => void; onRefund?: () => void; onPostToLedger?: (invoice: Invoice) => void }) {
  const invoiceClosed = ['paid', 'cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status);
  const isLocked = Boolean(invoice.locked_at) || ['sent','overdue','paid','cancelled','void','written_off','refunded'].includes(invoice.status) || Boolean(payment);
  const canSend = canWrite && !invoiceClosed;
  const canDownloadStored = Boolean(onDownloadPdf) && invoiceHasStoredPdf(invoice);
  // A refund is only possible for a paid invoice that still has a non-refunded
  // remainder. Gated to owners/admins (passed as onRefund only when allowed).
  const refundedCents = Math.round((invoice.refunded_amount ?? 0) * 100);
  const remainingCents = Math.max(total(invoice.lines).totalCents - refundedCents, 0);
  const canRefund = Boolean(canAdmin && onRefund) && ['paid', 'refunded'].includes(invoice.status) && remainingCents > 0;
  // Herinnering kan zodra de factuur onbetaald én over de vervaldatum is. Het
  // volgende niveau is reminder_level + 1 (max 3); de Edge Function kiest 'm zelf.
  const canRemind = Boolean(canWrite && onSendReminder) && invoiceIsReminderEligible(invoice);
  const nextReminderLevel = Math.min(3, (invoice.reminder_level ?? 0) + 1);
  // Verkoopfactuur in het grootboek boeken (omzet + af te dragen BTW). Kan zodra de
  // factuur niet geannuleerd is en nog niet eerder is geboekt.
  const isPosted = Boolean(invoice.journal_entry_id);
  const canPostToLedger = Boolean(canWrite && onPostToLedger) && !isPosted && !['draft', 'cancelled', 'void'].includes(invoice.status);
  // The Mollie payment link is created automatically while sending (when the
  // organisation has Mollie connected), so there is no separate "create link"
  // button — sending is the single action that produces invoice + betaallink.
  return <div className="quote-actions invoice-actions">
    <Button onClick={onEdit} disabled={isLocked} title={isLocked ? 'Deze factuur is vergrendeld na verzending of betaallink.' : undefined}>Bewerken</Button>
    {canSend && <Button variant="primary" onClick={() => onSend?.(invoice)}><Send size={14}/> Verstuur via Resend</Button>}
    {canRemind && <Button onClick={() => onSendReminder?.(invoice)} title={`Stuurt betalingsherinnering niveau ${nextReminderLevel} naar de klant.`}><Bell size={14}/> Stuur herinnering (niveau {nextReminderLevel})</Button>}
    {canDownloadStored && <Button onClick={() => onDownloadPdf?.(invoice)}><Download size={14}/> Download verzonden PDF</Button>}
    {onDownloadUbl && !['cancelled', 'void'].includes(invoice.status) && <Button onClick={() => onDownloadUbl(invoice)} title="Download deze factuur als UBL 2.1 e-factuur (Peppol BIS 3.0) — voor overheden en boekhoudpakketten."><Download size={14}/> E-factuur (UBL)</Button>}
    {canRefund && <Button variant="danger" onClick={() => onRefund?.()}><RotateCcw size={14}/> Terugbetaling</Button>}
    {canPostToLedger && <Button onClick={() => onPostToLedger?.(invoice)} title="Boekt de omzet en af te dragen BTW van deze factuur in het grootboek."><BookOpen size={14}/> Boek naar grootboek</Button>}
    {isPosted && <span className="status-pill bk-je-posted" title="Deze factuur staat in het grootboek."><BookOpen size={13}/> In grootboek</span>}
  </div>;
}

// True zodra een factuur onbetaald is én de vervaldatum is verstreken (status
// 'overdue', of berekend op basis van due_date < vandaag). Spiegelt de cron-logica.
function invoiceIsReminderEligible(invoice: Invoice): boolean {
  if (['paid', 'cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status)) return false;
  if (invoice.status === 'overdue') return true;
  if (!invoice.due_date) return false;
  const due = new Date(invoice.due_date);
  return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
}

/**
 * True when an invoice has (or should have) a stored PDF snapshot because it was
 * sent to the client or progressed beyond that. Mirrors quoteHasStoredPdf().
 */
function invoiceHasStoredPdf(invoice: Invoice): boolean {
  return ['sent', 'overdue', 'paid', 'cancelled', 'void', 'written_off'].includes(invoice.status) || Boolean(invoice.sent_at);
}

function QuoteVersions({ versions, compact = false }: { versions: QuoteVersion[]; compact?: boolean }) {
  if (versions.length === 0) return <div className={`quote-versions ${compact ? 'compact' : ''}`}><span>Nog geen offerteversies vastgelegd.</span></div>;
  return <div className={`quote-versions ${compact ? 'compact' : ''}`}>{versions.map(version => <div className="quote-version-pill" key={version.id} title={version.pdf_sha256 ? `PDF SHA-256: ${version.pdf_sha256}` : undefined}><strong>v{version.version_number}</strong><span>{quoteVersionReasonLabel(version.snapshot_reason)}</span>{!compact && <small>{dateNL(version.created_at)} · {euro(Number(version.total_amount || 0))}</small>}{!compact && version.pdf_file_name && <small>PDF-snapshot: {version.pdf_file_name}{version.pdf_size_bytes ? ` · ${formatBytes(version.pdf_size_bytes)}` : ''}</small>}</div>)}</div>;
}

function InvoiceVersions({ versions }: { versions: InvoiceVersion[] }) {
  if (versions.length === 0) return <div className="quote-versions"><span>Nog geen factuurversies vastgelegd.</span></div>;
  return <div className="quote-versions">{versions.map(version => <div className="quote-version-pill" key={version.id} title={version.pdf_sha256 ? `PDF SHA-256: ${version.pdf_sha256}` : undefined}><strong>v{version.version_number}</strong><span>{invoiceVersionReasonLabel(version.snapshot_reason)}</span><small>{dateNL(version.created_at)} · {euro(Number(version.total_amount || 0))}</small>{version.pdf_file_name && <small>PDF-snapshot: {version.pdf_file_name}{version.pdf_size_bytes ? ` · ${formatBytes(version.pdf_size_bytes)}` : ''}</small>}</div>)}</div>;
}

function InvoiceDeliveries({ deliveries }: { deliveries: InvoiceEmailDelivery[] }) {
  if (deliveries.length === 0) return <div className="quote-timeline-empty">Nog geen factuurmail verzonden.</div>;
  return <div className="quote-versions">{deliveries.map(delivery => <div className="quote-version-pill" key={delivery.id}><strong>{delivery.delivery_kind === 'reminder' ? `Herinnering N${delivery.reminder_level ?? '?'} · ` : delivery.delivery_kind === 'dunning' ? 'Aanmaning · ' : ''}{emailStatusLabel(delivery.status)}</strong><span>{delivery.recipient_email}</span><small>{dateNL(delivery.created_at)} · {delivery.subject}</small>{delivery.attachment_file_name && <small>{delivery.attachment_file_name}</small>}{delivery.error_message && <small>{delivery.error_message}</small>}</div>)}</div>;
}

function reminderLevelLabel(level: number): string {
  switch (level) {
    case 1: return 'Niveau 1 · Vriendelijke herinnering verstuurd';
    case 2: return 'Niveau 2 · Tweede herinnering verstuurd';
    case 3: return 'Niveau 3 · Aanmaning verstuurd';
    default: return 'Nog geen herinnering verstuurd';
  }
}

function InvoiceReminderPanel({ invoice, reminders, canWrite, onToggleRemindersPaused }: { invoice: Invoice; reminders: InvoiceEmailDelivery[]; canWrite: boolean; onToggleRemindersPaused?: (invoice: Invoice, paused: boolean) => void }) {
  const level = invoice.reminder_level ?? 0;
  const paused = Boolean(invoice.reminders_paused);
  return <div className="invoice-reminder-panel">
    <div className="invoice-reminder-summary">
      <span className="quote-version-pill"><strong>{reminderLevelLabel(level)}</strong>{invoice.last_reminder_at && <small>Laatste herinnering: {dateNL(invoice.last_reminder_at)}</small>}{paused && <small>Automatische herinneringen gepauzeerd</small>}</span>
      {canWrite && onToggleRemindersPaused && <Button onClick={() => onToggleRemindersPaused(invoice, !paused)} title={paused ? 'Automatische herinneringen hervatten voor deze factuur' : 'Automatische herinneringen pauzeren voor deze factuur'}>{paused ? <><Play size={14}/> Hervat herinneringen</> : <><Pause size={14}/> Pauzeer herinneringen</>}</Button>}
    </div>
    {reminders.length === 0
      ? <div className="quote-timeline-empty">Nog geen herinnering verstuurd.</div>
      : <div className="quote-versions">{reminders.map(delivery => <div className="quote-version-pill" key={delivery.id}><strong>Niveau {delivery.reminder_level ?? '-'} · {emailStatusLabel(delivery.status)}</strong><span>{delivery.recipient_email}</span><small>{dateNL(delivery.created_at)} · {delivery.subject}</small>{delivery.error_message && <small>{delivery.error_message}</small>}</div>)}</div>}
  </div>;
}

function dunningStatusLabel(status: DunningNotice['status']): string {
  switch (status) {
    case 'proposed': return 'Aanmaning voorgesteld — wacht op bevestiging';
    case 'confirmed': return 'Aanmaning wordt verstuurd…';
    case 'sent': return 'Aanmaning verstuurd';
    case 'failed': return 'Aanmaning mislukt';
    case 'cancelled': return 'Aanmaning geannuleerd';
    default: return 'Aanmaning';
  }
}

function InvoiceDunningPanel({ invoice, notice, canWrite, onPropose, onSend, onCancel }: {
  invoice: Invoice;
  notice: DunningNotice | null;
  canWrite: boolean;
  onPropose?: (invoice: Invoice) => void;
  onSend?: (notice: DunningNotice) => void;
  onCancel?: (notice: DunningNotice) => void;
}) {
  const c = (cents: number) => euro((Number(cents) || 0) / 100);
  if (!notice) {
    return <div className="invoice-reminder-panel">
      <div className="quote-timeline-empty">Nog geen aanmaning. Een formele aanmaning berekent de wettelijke (handels)rente en WIK-incassokosten en verstuurt na jouw bevestiging een 14-dagenbrief.</div>
      {canWrite && onPropose && <Button onClick={() => onPropose(invoice)} title="Berekent de bedragen en maakt een aanmaningsvoorstel dat je daarna zelf bevestigt."><FileText size={14}/> Stel aanmaning op</Button>}
    </div>;
  }
  const isConsumer = notice.client_kind === 'consumer';
  const dueNowCents = isConsumer ? notice.principal_cents + notice.interest_cents : notice.total_claim_cents;
  const open = notice.status === 'proposed' || notice.status === 'confirmed' || notice.status === 'failed';
  return <div className="invoice-reminder-panel">
    <div className="invoice-reminder-summary">
      <span className="quote-version-pill"><strong>{dunningStatusLabel(notice.status)}</strong>
        <small>{isConsumer ? 'Consument · wettelijke rente · 14-dagenbrief' : 'Zakelijk · wettelijke handelsrente'}</small>
        {notice.deadline_date && <small>Uiterste betaaldatum: {dateNL(notice.deadline_date)}</small>}
        {notice.sent_at && <small>Verstuurd: {dateNL(notice.sent_at)}</small>}
        {notice.error_message && <small>{notice.error_message}</small>}
      </span>
    </div>
    <div className="quote-versions">
      <div className="quote-version-pill"><strong>Hoofdsom</strong><span>{c(notice.principal_cents)}</span></div>
      <div className="quote-version-pill"><strong>{isConsumer ? 'Wettelijke rente' : 'Handelsrente'} · {notice.interest_days} dagen</strong><span>{c(notice.interest_cents)}</span></div>
      <div className="quote-version-pill"><strong>Incassokosten{isConsumer ? ' (na termijn)' : ''}{notice.collection_costs_vat_cents > 0 ? ' + btw' : ''}</strong><span>{c(notice.collection_costs_cents + notice.collection_costs_vat_cents)}</span></div>
      <div className="quote-version-pill total"><strong>{isConsumer ? 'Nu te voldoen' : 'Totaal te voldoen'}</strong><span>{c(isConsumer ? dueNowCents : notice.total_claim_cents)}</span></div>
    </div>
    {open && canWrite && <div className="invoice-reminder-summary">
      {onSend && <Button variant="primary" onClick={() => onSend(notice)} title="Bevestigt de bedragen (rente herberekend op vandaag) en verstuurt de formele 14-dagenbrief per e-mail."><Send size={14}/> {notice.status === 'failed' ? 'Opnieuw versturen' : 'Bevestig & verstuur'}</Button>}
      {onCancel && notice.status !== 'confirmed' && <Button onClick={() => onCancel(notice)} title="Annuleer dit aanmaningsvoorstel."><XCircle size={14}/> Annuleer voorstel</Button>}
    </div>}
  </div>;
}

function InvoicePayments({ payments }: { payments: InvoicePaymentRecord[] }) {
  if (payments.length === 0) return <div className="quote-timeline-empty">Nog geen Mollie-betaalrecords.</div>;
  return <div className="quote-versions">{payments.map(payment => <div className="quote-version-pill" key={payment.id}><strong>{paymentStatusLabel(payment.status)}</strong><span>{euro(payment.amount_cents / 100)} {payment.currency}</span><small>{dateNL(payment.created_at)}{payment.provider_payment_id ? ` · ${payment.provider_payment_id}` : ''}</small>{payment.provider_checkout_url && <a href={payment.provider_checkout_url} target="_blank" rel="noreferrer">Open betaallink</a>}{payment.paid_at && <small>Betaald op {dateNL(payment.paid_at)}</small>}</div>)}</div>;
}

function QuoteTimeline({ events, emptyText, compact = false }: { events: AppData['quoteApprovalEvents']; emptyText: string; compact?: boolean }) {
  return <div className={`quote-timeline ${compact ? 'compact' : ''}`}>{events.length === 0 && <div className="quote-timeline-empty">{emptyText}</div>}{events.map(event => <div className="quote-timeline-item" key={event.id}><span>{new Date(event.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><strong>{event.title}</strong>{!compact && event.description && <p>{event.description}</p>}</div>)}</div>;
}

function InvoiceTimeline({ events, emptyText }: { events: AppData['invoiceWorkflowEvents']; emptyText: string }) {
  return <div className="quote-timeline">{events.length === 0 && <div className="quote-timeline-empty">{emptyText}</div>}{events.map(event => <div className="quote-timeline-item" key={event.id}><span>{new Date(event.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><strong>{event.title}</strong>{event.description && <p>{event.description}</p>}</div>)}</div>;
}

function quoteStatusLabel(quote: Quote): string {
  if (quote.status === 'draft' && quote.internal_approval_status === 'rejected') return 'Intern afgewezen';
  if (quote.status === 'draft') return 'Concept';
  if (quote.status === 'pending_internal_approval') return 'Wacht op interne goedkeuring';
  if (quote.status === 'internally_approved') return 'Intern goedgekeurd';
  return statusLabel(quote.status);
}

function statusLabel(status: FinanceStatus | string): string {
  const labels: Record<string, string> = { draft: 'Concept', pending_internal_approval: 'Wacht op interne goedkeuring', internally_approved: 'Intern goedgekeurd', sent: 'Verzonden', accepted: 'Openstaand', paid: 'Betaald', rejected: 'Afgewezen', expired: 'Verlopen', overdue: 'Te laat', cancelled: 'Geannuleerd', void: 'Ongeldig gemaakt', written_off: 'Afgeboekt', refunded: 'Terugbetaald' };
  return labels[status] || status;
}

function emailStatusLabel(status: string): string {
  const labels: Record<string, string> = { queued: 'E-mail in wachtrij', sent: 'E-mail verzonden', delivered: 'E-mail afgeleverd', opened: 'E-mail geopend', clicked: 'Link aangeklikt', bounced: 'E-mail bounced', failed: 'E-mail mislukt', complained: 'Spamklacht' };
  return labels[status] || status;
}

function RefundModal({ invoice, mollieRefundable, inFlightCents = 0, onClose, onSubmit }: { invoice: Invoice; mollieRefundable: boolean; inFlightCents?: number; onClose: () => void; onSubmit: (input: RefundInput) => Promise<void> }) {
  const totals = total(invoice.lines);
  const refundedCents = Math.round((invoice.refunded_amount ?? 0) * 100);
  const remainingCents = Math.max(totals.totalCents - refundedCents - inFlightCents, 0);
  const idempotencyKey = useMemo(() => crypto.randomUUID(), []);
  const [method, setMethod] = useState<'manual' | 'mollie'>(mollieRefundable ? 'mollie' : 'manual');
  const [amountEuro, setAmountEuro] = useState((remainingCents / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const [createCreditNote, setCreateCreditNote] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountCents = Math.round(Number(String(amountEuro).replace(',', '.')) * 100);
  const amountValid = Number.isFinite(amountCents) && amountCents > 0 && amountCents <= remainingCents;
  const isMollie = method === 'mollie';

  async function submit() {
    if (!amountValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ amountCents, reason: reason.trim(), createCreditNote, idempotencyKey, kind: method });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Terugbetaling mislukt');
    } finally {
      setBusy(false);
    }
  }

  return <Modal
    title={`Terugbetaling — factuur ${invoice.number}`}
    onClose={onClose}
    className="refund-modal"
    footer={<>
      <Button onClick={onClose} disabled={busy}>Annuleren</Button>
      <Button variant="primary" onClick={() => void submit()} disabled={!amountValid || busy}>{busy ? 'Bezig…' : (isMollie ? 'Via Mollie terugbetalen' : 'Terugbetaling registreren')}</Button>
    </>}
  >
    <div className="refund-form">
      <div className="refund-summary">
        <div><span>Factuurtotaal</span><strong>{euro(totals.total)}</strong></div>
        <div><span>Al terugbetaald</span><strong>{euro(refundedCents / 100)}</strong></div>
        {inFlightCents > 0 && <div><span>In behandeling</span><strong>{euro(inFlightCents / 100)}</strong></div>}
        <div><span>Resterend</span><strong>{euro(remainingCents / 100)}</strong></div>
      </div>

      {mollieRefundable && <div className="refund-method" role="radiogroup" aria-label="Terugbetaalmethode">
        <button type="button" role="radio" aria-checked={isMollie} className={isMollie ? 'is-active' : ''} disabled={busy} onClick={() => setMethod('mollie')}>
          <strong>Via Mollie</strong><small>Automatisch terug naar de klant</small>
        </button>
        <button type="button" role="radio" aria-checked={!isMollie} className={!isMollie ? 'is-active' : ''} disabled={busy} onClick={() => setMethod('manual')}>
          <strong>Handmatig</strong><small>Zelf overmaken (bijv. bank)</small>
        </button>
      </div>}

      <label className="refund-field">
        <span>Bedrag (EUR)</span>
        <input type="number" inputMode="decimal" min="0" step="0.01" max={(remainingCents / 100).toFixed(2)} value={amountEuro} disabled={busy} onChange={event => setAmountEuro(event.target.value)} />
      </label>
      <button type="button" className="refund-full-btn" disabled={busy} onClick={() => setAmountEuro((remainingCents / 100).toFixed(2))}>Volledig restbedrag ({euro(remainingCents / 100)})</button>

      <label className="refund-field">
        <span>Reden (optioneel)</span>
        <textarea rows={3} value={reason} disabled={busy} placeholder="Bijv. annulering, prijscorrectie, dubbele betaling…" onChange={event => setReason(event.target.value)} />
      </label>

      <label className="refund-checkbox">
        <input type="checkbox" checked={createCreditNote} disabled={busy} onChange={event => setCreateCreditNote(event.target.checked)} />
        <span>Creditfactuur aanmaken (aanbevolen voor de boekhouding)</span>
      </label>

      {isMollie
        ? <p className="refund-note">Dit stuurt de terugbetaling naar <strong>Mollie</strong>; de klant krijgt het bedrag automatisch terug op de oorspronkelijke betaalmethode. De terugbetaling kan even “in behandeling” staan — de status en de creditfactuur volgen automatisch zodra Mollie de terugbetaling heeft verwerkt.</p>
        : <p className="refund-note">Dit registreert een <strong>handmatige</strong> terugbetaling: maak het bedrag zelf over (bijv. via je bank). De factuurstatus en aggregaten worden direct bijgewerkt; bij een volledige terugbetaling gaat de factuur naar “Terugbetaald”.</p>}

      {amountCents > remainingCents && <p className="refund-error">Bedrag mag niet groter zijn dan het resterende bedrag ({euro(remainingCents / 100)}).</p>}
      {error && <p className="refund-error">{error}</p>}
    </div>
  </Modal>;
}

function InvoiceRefunds({ refunds }: { refunds: InvoiceRefund[] }) {
  if (refunds.length === 0) return <div className="quote-timeline-empty">Nog geen terugbetalingen.</div>;
  return <div className="quote-versions">{refunds.map(refund => <div className="quote-version-pill" key={refund.id}>
    <strong>{refundStatusLabel(refund.status)}</strong>
    <span>{euro(refund.amount_cents / 100)} {refund.currency}</span>
    <small>{dateNL(refund.created_at)} · {refund.kind === 'manual' ? 'Handmatig' : 'Mollie'}</small>
    {refund.reason && <small>{refund.reason}</small>}
    {refund.status === 'failed' && refund.error_message && <small className="refund-error">{refund.error_message}</small>}
  </div>)}</div>;
}

function CreditNotes({ creditNotes, canWrite = false, onDownload, onDownloadUbl, onEmail, onPostToLedger }: { creditNotes: CreditNote[]; canWrite?: boolean; onDownload?: (creditNote: CreditNote) => void; onDownloadUbl?: (creditNote: CreditNote) => void; onEmail?: (creditNote: CreditNote) => void; onPostToLedger?: (creditNote: CreditNote) => void }) {
  if (creditNotes.length === 0) return <div className="quote-timeline-empty">Nog geen creditfacturen.</div>;
  return <div className="quote-versions">{creditNotes.map(creditNote => <div className="quote-version-pill" key={creditNote.id}>
    <strong>{creditNote.number}</strong>
    <span>- {euro(Number(creditNote.total_amount || 0))}</span>
    <small>{dateNL(creditNote.date)}</small>
    {creditNote.journal_entry_id && <small className="cn-ledger-pill" title="Deze creditnota is in het grootboek verwerkt (omzet en btw teruggeboekt)."><BookOpen size={12}/> In grootboek</small>}
    <div className="cn-pill-actions">
      {onDownload && creditNote.pdf_file_name && <button type="button" className="att-btn" title="Download creditfactuur-PDF" onClick={() => onDownload(creditNote)}><Download size={14}/> PDF</button>}
      {onDownloadUbl && creditNote.status !== 'void' && <button type="button" className="att-btn" title="Download als UBL 2.1 e-creditnota (Peppol BIS 3.0)" onClick={() => onDownloadUbl(creditNote)}><Download size={14}/> UBL</button>}
      {onEmail && creditNote.pdf_file_name && <button type="button" className="att-btn" title="Mail creditfactuur naar de klant" onClick={() => onEmail(creditNote)}><Mail size={14}/> Mail</button>}
      {onPostToLedger && canWrite && !creditNote.journal_entry_id && creditNote.status === 'issued'
        && <button type="button" className="att-btn" title="Boek de creditering naar het grootboek: omzet en af te dragen btw worden teruggenomen, debiteuren verlaagd." onClick={() => onPostToLedger(creditNote)}><BookOpen size={14}/> Boek naar grootboek</button>}
    </div>
  </div>)}</div>;
}

function InvoiceChargebacks({ chargebacks }: { chargebacks: InvoiceChargeback[] }) {
  if (chargebacks.length === 0) return <div className="quote-timeline-empty">Geen terugboekingen.</div>;
  return <div className="quote-versions">{chargebacks.map(chargeback => <div className="quote-version-pill" key={chargeback.id}>
    <strong>{chargebackStatusLabel(chargeback.status)}</strong>
    <span>- {euro(chargeback.amount_cents / 100)} {chargeback.currency}</span>
    <small>{dateNL(chargeback.charged_back_at)}{chargeback.reversed_at ? ` · teruggedraaid ${dateNL(chargeback.reversed_at)}` : ''}</small>
    {chargeback.reason && <small>{chargeback.reason}</small>}
  </div>)}</div>;
}

function refundStatusLabel(status: string): string {
  const labels: Record<string, string> = { queued: 'In wachtrij', pending: 'In behandeling', processing: 'Wordt verwerkt', refunded: 'Terugbetaald', failed: 'Mislukt', canceled: 'Geannuleerd' };
  return labels[status] || status;
}

function chargebackStatusLabel(status: string): string {
  const labels: Record<string, string> = { charged_back: 'Teruggeboekt', reversed: 'Teruggedraaid' };
  return labels[status] || status;
}

function paymentStatusLabel(status: string): string {
  const labels: Record<string, string> = { creating: 'Wordt aangemaakt', open: 'Open', pending: 'In behandeling', authorized: 'Geautoriseerd', paid: 'Betaald', failed: 'Mislukt', expired: 'Verlopen', canceled: 'Geannuleerd', refunded: 'Terugbetaald', charged_back: 'Teruggeboekt' };
  return labels[status] || status;
}

function quoteVersionReasonLabel(reason: string): string {
  const labels: Record<string, string> = { internal_approval: 'Interne goedkeuring', sent_to_client: 'Verzonden versie', client_accepted: 'Geaccepteerde versie', manual: 'Handmatige snapshot' };
  return labels[reason] || reason;
}

function invoiceVersionReasonLabel(reason: string): string {
  const labels: Record<string, string> = { sent_to_client: 'Verzonden versie', payment_created: 'Betaallink gemaakt', paid: 'Betaalde versie', manual: 'Handmatige snapshot' };
  return labels[reason] || reason;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
