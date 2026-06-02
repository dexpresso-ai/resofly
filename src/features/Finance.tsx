import { useMemo, useState } from 'react';
import { CreditCard, Download, Eye, FileText, Mail, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Send, XCircle } from 'lucide-react';
import type { AppData, FinanceLine, FinanceStatus, Invoice, InvoiceEmailDelivery, InvoicePaymentRecord, InvoiceVersion, Quote, QuoteEmailDelivery, QuoteVersion } from '../types';
import { Modal } from '../components/Modal';
import { Button } from '../components/Ui';
import { dateNL, euro, total, lineGross } from '../lib/format';
import { exportFinancePDF } from '../lib/pdf';

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

export function Invoices({ data, canWrite, onNew, onEdit, onSend, onDownloadPdf }: { data: AppData; canWrite: boolean; onNew: () => void; onEdit: (i: Invoice) => void; onSend: (i: Invoice) => void; onDownloadPdf?: (i: Invoice) => void }) {
  return <FinanceList kind="invoice" title="Facturen" docs={data.invoices} data={data} canWrite={canWrite} onNew={onNew} onEdit={onEdit} onSendInvoice={onSend} onDownloadInvoicePdf={onDownloadPdf}/>;
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
  onDownloadPdf,
  onDownloadInvoicePdf,
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
  onDownloadPdf?: (q: Quote) => void;
  onDownloadInvoicePdf?: (i: Invoice) => void;
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
    onNew={onNew}
    onEdit={onEdit as (doc: Invoice) => void}
    onSend={onSendInvoice}
    onDownloadPdf={onDownloadInvoicePdf}
  />;
}


type FinanceKind = 'quote' | 'invoice';

type FinanceSearchFilters = {
  query: string;
  clientId: string;
  projectId: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  amountMin: string;
  amountMax: string;
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
  const activeFilterCount = countActiveFinanceFilters(filters);
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

  const updateFilters = (patch: Partial<FinanceSearchFilters>) => onChange({ ...filters, ...patch });
  const resetFilters = () => onChange(createDefaultFinanceSearchFilters());
  const label = isQuote ? 'offertes' : 'facturen';

  return <section className="finance-search-card" aria-label={`${isQuote ? 'Offertes' : 'Facturen'} zoeken en filteren`}>
    <div className="finance-search-main">
      <label className="finance-search-query">
        <span><Search size={15}/> Snel zoeken</span>
        <input
          className="form-input"
          value={filters.query}
          onChange={event => updateFilters({ query: event.target.value })}
          placeholder={isQuote ? 'Zoek op offertenummer, klant, project, omschrijving, status of bedrag…' : 'Zoek op factuurnummer, klant, project, offerte, omschrijving, status of bedrag…'}
          autoComplete="off"
        />
      </label>
      <div className="finance-search-result-card">
        <SlidersHorizontal size={16}/>
        <div><strong>{visibleCount} van {docs.length}</strong><span>{label} zichtbaar</span></div>
        <small>{euro(visibleTotalAmount)} totaal</small>
      </div>
    </div>

    <div className="finance-search-grid">
      <label className="field finance-search-field"><span>Klant</span><select className="form-select" value={filters.clientId} onChange={event => updateFilters({ clientId: event.target.value })}><option value="">Alle klanten</option>{clientOptions.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
      <label className="field finance-search-field"><span>Project</span><select className="form-select" value={filters.projectId} onChange={event => updateFilters({ projectId: event.target.value })}><option value="">Alle projecten</option>{projectOptions.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label className="field finance-search-field"><span>Status</span><select className="form-select" value={filters.status} onChange={event => updateFilters({ status: event.target.value })}><option value="">Alle statussen</option>{statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className="field finance-search-field"><span>{isQuote ? 'Offertedatum vanaf' : 'Factuurdatum vanaf'}</span><input className="form-input" type="date" value={filters.dateFrom} onChange={event => updateFilters({ dateFrom: event.target.value })}/></label>
      <label className="field finance-search-field"><span>{isQuote ? 'Offertedatum t/m' : 'Factuurdatum t/m'}</span><input className="form-input" type="date" value={filters.dateTo} onChange={event => updateFilters({ dateTo: event.target.value })}/></label>
      <label className="field finance-search-field"><span>Bedrag vanaf</span><input className="form-input" inputMode="decimal" value={filters.amountMin} onChange={event => updateFilters({ amountMin: event.target.value })} placeholder="€ min."/></label>
      <label className="field finance-search-field"><span>Bedrag t/m</span><input className="form-input" inputMode="decimal" value={filters.amountMax} onChange={event => updateFilters({ amountMax: event.target.value })} placeholder="€ max."/></label>
    </div>

    {activeFilterCount > 0 && <div className="finance-search-active-row">
      <span>{activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} actief</span>
      <button type="button" onClick={resetFilters}><RotateCcw size={14}/> Filters wissen</button>
    </div>}
  </section>;
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

  return docs.filter(doc => {
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

function countActiveFinanceFilters(filters: FinanceSearchFilters): number {
  return Object.values(filters).filter(value => value.trim() !== '').length;
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
  onNew,
  onEdit,
  onSend,
  onDownloadPdf,
}: {
  title: string;
  invoices: Invoice[];
  data: AppData;
  canWrite: boolean;
  onNew: () => void;
  onEdit: (invoice: Invoice) => void;
  onSend?: (invoice: Invoice) => void;
  onDownloadPdf?: (invoice: Invoice) => void;
}) {
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [searchFilters, setSearchFilters] = useState<FinanceSearchFilters>(() => createDefaultFinanceSearchFilters());
  const filteredInvoices = useMemo(() => filterFinanceDocs('invoice', invoices, data, searchFilters), [data, invoices, searchFilters]);
  const selectedInvoice = useMemo(() => invoices.find(invoice => invoice.id === selectedInvoiceId) ?? null, [invoices, selectedInvoiceId]);
  const visibleTotalAmount = useMemo(() => filteredInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0), [filteredInvoices]);

  return <>
    <div className="fin-header quote-table-header">
      <div>
        <h2>{title}</h2>
        <p>Volwassen factuurmodule met detailpaneel, verzendhistorie, Mollie-betaalstatus, snapshots en audit-timeline.</p>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw</Button>
    </div>

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
                <td data-label="Status"><span className={`fin-status ${invoice.status}`}>{statusLabel(invoice.status)}</span></td>
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
      onClose={() => setSelectedInvoiceId(null)}
      onEdit={(invoice) => { setSelectedInvoiceId(null); onEdit(invoice); }}
      onSend={onSend}
      onDownloadPdf={onDownloadPdf}
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

  return <Modal title={`Offerte ${quote.number}`} onClose={onClose} className="quote-detail-modal">
    <div className="quote-detail">
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
  </Modal>;
}

function InvoiceDetailModal({
  invoice,
  data,
  canWrite,
  onClose,
  onEdit,
  onSend,
  onDownloadPdf,
}: {
  invoice: Invoice;
  data: AppData;
  canWrite: boolean;
  onClose: () => void;
  onEdit: (invoice: Invoice) => void;
  onSend?: (invoice: Invoice) => void;
  onDownloadPdf?: (invoice: Invoice) => void;
}) {
  const client = data.clients.find(c => c.id === invoice.client_id) ?? null;
  const project = data.projects.find(p => p.id === invoice.project_id) ?? null;
  const quote = data.quotes.find(q => q.id === invoice.quote_id) ?? null;
  const amounts = total(invoice.lines);
  const events = data.invoiceWorkflowEvents.filter(event => event.invoice_id === invoice.id);
  const deliveries = data.invoiceEmailDeliveries.filter(delivery => delivery.invoice_id === invoice.id);
  const latestDelivery = deliveries[0] ?? null;
  const payments = data.invoicePaymentRecords.filter(payment => payment.invoice_id === invoice.id);
  const latestPayment = payments[0] ?? null;
  const versions = data.invoiceVersions.filter(version => version.invoice_id === invoice.id);

  return <Modal title={`Factuur ${invoice.number}`} onClose={onClose} className="quote-detail-modal invoice-detail-modal">
    <div className="quote-detail invoice-detail">
      <section className="quote-detail-hero">
        <div>
          <span className="quote-detail-kicker">Facturatieflow</span>
          <h2>{client?.name ?? 'Geen klant'}</h2>
          <p>{project?.name ?? 'Geen project gekoppeld'} · {dateNL(invoice.date)} · vervalt {dateNL(invoice.due_date)}</p>
        </div>
        <div className="quote-detail-total"><small>Totaal incl. btw</small><strong>{euro(amounts.total)}</strong><span className={`fin-status ${invoice.status}`}>{statusLabel(invoice.status)}</span></div>
      </section>

      <section className="quote-detail-metrics" aria-label="Factuur bedragen en statussen">
        <QuoteMetric label="Bedrag ex. btw" value={euro(amounts.subtotal)} />
        <QuoteMetric label="BTW" value={euro(amounts.vat)} />
        <QuoteMetric label="Totaal" value={euro(amounts.total)} strong />
        <QuoteMetric label="Gekoppelde offerte" value={quote?.number ?? 'Geen'} />
        <QuoteMetric label="Mailstatus" value={latestDelivery?.status ? emailStatusLabel(latestDelivery.status) : (invoice.last_email_delivery_status ? emailStatusLabel(invoice.last_email_delivery_status) : 'Nog niet verstuurd')} />
        <QuoteMetric label="Betaalstatus" value={latestPayment ? paymentStatusLabel(latestPayment.status) : statusLabel(invoice.status)} />
      </section>

      {amounts.vatBreakdown.length > 1 && <section className="quote-detail-metrics" aria-label="BTW-uitsplitsing per tarief">
        {amounts.vatBreakdown.map(row => <QuoteMetric key={row.rate} label={`BTW ${row.rate}% over ${euro(row.base)}`} value={euro(row.vat)} />)}
      </section>}

      <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Acties</span><strong>Versturen, betaallink en PDF-snapshot</strong></div></div>
        <InvoiceStatusStrip invoice={invoice} delivery={latestDelivery} payment={latestPayment} />
        <InvoiceActions invoice={invoice} canWrite={canWrite} payment={latestPayment} onEdit={() => onEdit(invoice)} onSend={onSend} onDownloadPdf={onDownloadPdf} />
      </section>

      <section className="quote-detail-split">
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Regels</span><strong>Factuurbedragen</strong></div></div><FinanceLineTable lines={invoice.lines} emptyText="Geen factuurregels." /></div>
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Verzendhistorie</span><strong>Resend en PDF</strong></div></div><InvoiceDeliveries deliveries={deliveries} /></div>
      </section>

      <section className="quote-detail-split">
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Betalingen</span><strong>Mollie records</strong></div></div><InvoicePayments payments={payments} /></div>
        <div className="quote-detail-section"><div className="quote-detail-section-head"><div><span>PDF-snapshots</span><strong>Factuurversies</strong></div></div><InvoiceVersions versions={versions} /></div>
      </section>

      <section className="quote-detail-section"><div className="quote-detail-section-head"><div><span>Audit-timeline</span><strong>Alle factuur-events</strong></div></div><InvoiceTimeline events={events} emptyText="Nog geen factuur-events." /></section>
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
          <QuoteActions quote={quote} canWrite={canWrite} canAdmin={canAdmin} linkedInvoice={linkedInvoice} onSubmitApproval={onSubmitApproval} onApprove={onApprove} onReject={onReject} onSend={onSend} onConvertToInvoice={onConvertToInvoice} onEdit={() => onEditQuote(quote)} compact />
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

function InvoiceActions({ invoice, canWrite, payment, onEdit, onSend, onDownloadPdf }: { invoice: Invoice; canWrite: boolean; payment: InvoicePaymentRecord | null; onEdit: () => void; onSend?: (invoice: Invoice) => void; onDownloadPdf?: (invoice: Invoice) => void }) {
  const invoiceClosed = ['paid', 'cancelled', 'void', 'written_off'].includes(invoice.status);
  const isLocked = Boolean(invoice.locked_at) || ['sent','overdue','paid','cancelled','void','written_off'].includes(invoice.status) || Boolean(payment);
  const canSend = canWrite && !invoiceClosed;
  const canDownloadStored = Boolean(onDownloadPdf) && invoiceHasStoredPdf(invoice);
  // The Mollie payment link is created automatically while sending (when the
  // organisation has Mollie connected), so there is no separate "create link"
  // button — sending is the single action that produces invoice + betaallink.
  return <div className="quote-actions invoice-actions">
    <Button onClick={onEdit} disabled={isLocked} title={isLocked ? 'Deze factuur is vergrendeld na verzending of betaallink.' : undefined}>Bewerken</Button>
    {canSend && <Button variant="primary" onClick={() => onSend?.(invoice)}><Send size={14}/> Verstuur via Resend</Button>}
    {canDownloadStored && <Button onClick={() => onDownloadPdf?.(invoice)}><Download size={14}/> Download verzonden PDF</Button>}
  </div>;
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
  return <div className="quote-versions">{deliveries.map(delivery => <div className="quote-version-pill" key={delivery.id}><strong>{emailStatusLabel(delivery.status)}</strong><span>{delivery.recipient_email}</span><small>{dateNL(delivery.created_at)} · {delivery.subject}</small>{delivery.attachment_file_name && <small>{delivery.attachment_file_name}</small>}{delivery.error_message && <small>{delivery.error_message}</small>}</div>)}</div>;
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
  const labels: Record<string, string> = { draft: 'Concept', pending_internal_approval: 'Wacht op interne goedkeuring', internally_approved: 'Intern goedgekeurd', sent: 'Verzonden', accepted: 'Openstaand', paid: 'Betaald', rejected: 'Afgewezen', expired: 'Verlopen', overdue: 'Te laat', cancelled: 'Geannuleerd', void: 'Ongeldig gemaakt', written_off: 'Afgeboekt' };
  return labels[status] || status;
}

function emailStatusLabel(status: string): string {
  const labels: Record<string, string> = { queued: 'E-mail in wachtrij', sent: 'E-mail verzonden', delivered: 'E-mail afgeleverd', opened: 'E-mail geopend', clicked: 'Link aangeklikt', bounced: 'E-mail bounced', failed: 'E-mail mislukt', complained: 'Spamklacht' };
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
