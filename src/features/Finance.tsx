import { useMemo, useState } from 'react';
import { CreditCard, Download, Eye, FileText, Mail, ShieldCheck, Send, XCircle } from 'lucide-react';
import type { AppData, FinanceLine, FinanceStatus, Invoice, InvoiceEmailDelivery, InvoicePaymentRecord, InvoiceVersion, Quote, QuoteEmailDelivery, QuoteVersion } from '../types';
import { Modal } from '../components/Modal';
import { Button } from '../components/Ui';
import { dateNL, euro, total } from '../lib/format';
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
  />;
}

export function Invoices({ data, canWrite, onNew, onEdit, onSend, onCreatePayment }: { data: AppData; canWrite: boolean; onNew: () => void; onEdit: (i: Invoice) => void; onSend: (i: Invoice) => void; onCreatePayment: (i: Invoice) => void }) {
  return <FinanceList kind="invoice" title="Facturen" docs={data.invoices} data={data} canWrite={canWrite} onNew={onNew} onEdit={onEdit} onSendInvoice={onSend} onCreatePayment={onCreatePayment}/>;
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
  onCreatePayment,
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
  onCreatePayment?: (i: Invoice) => void;
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
    onCreatePayment={onCreatePayment}
  />;
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
}) {
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const selectedQuote = useMemo(() => quotes.find(quote => quote.id === selectedQuoteId) ?? null, [quotes, selectedQuoteId]);

  return <>
    <div className="fin-header quote-table-header">
      <div>
        <h2>{title}</h2>
        <p>Compact overzicht met bedragen, klant- en projectcontext. Klik op een offerte voor workflow en details.</p>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw</Button>
    </div>

    <div className="quote-table-card">
      <div className="quote-table-scroll" role="region" aria-label="Offertes tabel">
        <table className="quote-table">
          <thead>
            <tr>
              <th>Offerte</th><th>Klant</th><th>Project</th><th>Datum</th><th>Verloopt</th><th className="money">Bedrag ex.</th><th className="money">BTW</th><th className="money">Totaal</th><th>Status</th><th aria-label="Acties" />
            </tr>
          </thead>
          <tbody>
            {quotes.map(quote => {
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
                  <button type="button" className="att-btn" onClick={() => { void exportFinancePDF(quote, 'quote', client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }} title="Download PDF"><Download size={14}/></button>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      {quotes.length === 0 && <div className="empty quote-table-empty"><div className="e-big">Nog geen offertes</div><p>Maak je eerste offerte aan om de workflow te starten.</p></div>}
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
  onCreatePayment,
}: {
  title: string;
  invoices: Invoice[];
  data: AppData;
  canWrite: boolean;
  onNew: () => void;
  onEdit: (invoice: Invoice) => void;
  onSend?: (invoice: Invoice) => void;
  onCreatePayment?: (invoice: Invoice) => void;
}) {
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const selectedInvoice = useMemo(() => invoices.find(invoice => invoice.id === selectedInvoiceId) ?? null, [invoices, selectedInvoiceId]);

  return <>
    <div className="fin-header quote-table-header">
      <div>
        <h2>{title}</h2>
        <p>Volwassen factuurmodule met detailpaneel, verzendhistorie, Mollie-betaalstatus, snapshots en audit-timeline.</p>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw</Button>
    </div>

    <div className="quote-table-card invoice-table-card">
      <div className="quote-table-scroll" role="region" aria-label="Facturen tabel">
        <table className="quote-table invoice-table">
          <thead>
            <tr><th>Factuur</th><th>Klant</th><th>Project</th><th>Offerte</th><th>Datum</th><th>Vervalt</th><th className="money">Bedrag ex.</th><th className="money">BTW</th><th className="money">Totaal</th><th>Status</th><th aria-label="Acties" /></tr>
          </thead>
          <tbody>
            {invoices.map(invoice => {
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
                  <button type="button" className="att-btn" onClick={() => { void exportFinancePDF(invoice, 'invoice', client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }} title="Download PDF"><Download size={14}/></button>
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      {invoices.length === 0 && <div className="empty quote-table-empty"><div className="e-big">Nog geen facturen</div><p>Zet een geaccepteerde offerte om of maak handmatig een conceptfactuur aan.</p></div>}
    </div>

    {selectedInvoice && <InvoiceDetailModal
      invoice={selectedInvoice}
      data={data}
      canWrite={canWrite}
      onClose={() => setSelectedInvoiceId(null)}
      onEdit={(invoice) => { setSelectedInvoiceId(null); onEdit(invoice); }}
      onSend={onSend}
      onCreatePayment={onCreatePayment}
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
        <QuoteActions quote={quote} canWrite={canWrite} canAdmin={canAdmin} linkedInvoice={linkedInvoice} onSubmitApproval={onSubmitApproval} onApprove={onApprove} onReject={onReject} onSend={onSend} onConvertToInvoice={onConvertToInvoice} onEdit={() => onEdit(quote)} />
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
  onCreatePayment,
}: {
  invoice: Invoice;
  data: AppData;
  canWrite: boolean;
  onClose: () => void;
  onEdit: (invoice: Invoice) => void;
  onSend?: (invoice: Invoice) => void;
  onCreatePayment?: (invoice: Invoice) => void;
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

      <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Acties</span><strong>Versturen, betaallink en PDF-snapshot</strong></div></div>
        <InvoiceStatusStrip invoice={invoice} delivery={latestDelivery} payment={latestPayment} />
        <InvoiceActions invoice={invoice} canWrite={canWrite} payment={latestPayment} onEdit={() => onEdit(invoice)} onSend={onSend} onCreatePayment={onCreatePayment} />
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
        const subtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
        const lineVat = subtotal * Number(line.vat || 0) / 100;
        return <tr key={line.id}><td>{line.description || '—'}</td><td>{line.quantity}</td><td>{euro(line.unit_price)}</td><td>{line.vat}%</td><td>{euro(subtotal + lineVat)}</td></tr>;
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
}) {
  const quotes = data.quotes.filter(quote => quote.project_id === projectId);
  return <section className="project-quotes-panel">
    <div className="section-head-inline project-section-head"><div><h2>Offertes</h2><p>Projectgekoppelde offertes met interne goedkeuring, Resend-status, klantbeslissing en factuurconversie.</p></div><Button variant="primary" onClick={onNewQuote} disabled={!canWrite}>+ Offerte</Button></div>
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

function QuoteActions({ quote, canWrite, canAdmin, linkedInvoice, onSubmitApproval, onApprove, onReject, onSend, onConvertToInvoice, onEdit, compact = false }: { quote: Quote; canWrite: boolean; canAdmin: boolean; linkedInvoice?: Invoice | null; onSubmitApproval?: (quote: Quote) => void; onApprove?: (quote: Quote) => void; onReject?: (quote: Quote) => void; onSend?: (quote: Quote) => void; onConvertToInvoice?: (quote: Quote) => void; onEdit: () => void; compact?: boolean }) {
  const canSubmit = canWrite && ['draft'].includes(quote.status) && quote.internal_approval_status !== 'pending';
  const canApprove = canAdmin && quote.status === 'pending_internal_approval';
  const canSend = canWrite && quote.status === 'internally_approved' && quote.internal_approval_status === 'approved';
  const canConvert = canWrite && quote.status === 'accepted' && !linkedInvoice;
  return <div className={`quote-actions ${compact ? 'compact' : ''}`}>
    <Button onClick={onEdit}>Bewerken</Button>
    {canSubmit && <Button onClick={() => onSubmitApproval?.(quote)}><ShieldCheck size={14}/> Ter goedkeuring</Button>}
    {canApprove && <Button variant="primary" onClick={() => onApprove?.(quote)}><ShieldCheck size={14}/> Goedkeuren</Button>}
    {canApprove && <Button variant="danger" onClick={() => onReject?.(quote)}><XCircle size={14}/> Afwijzen</Button>}
    {canSend && <Button variant="primary" onClick={() => onSend?.(quote)}><Send size={14}/> Verstuur via Resend</Button>}
    {canConvert && <Button variant="primary" onClick={() => onConvertToInvoice?.(quote)}><FileText size={14}/> Maak factuur van offerte</Button>}
    {linkedInvoice && <span className="quote-converted-pill"><FileText size={14}/> Factuur {linkedInvoice.number}</span>}
  </div>;
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

function InvoiceActions({ invoice, canWrite, payment, onEdit, onSend, onCreatePayment }: { invoice: Invoice; canWrite: boolean; payment: InvoicePaymentRecord | null; onEdit: () => void; onSend?: (invoice: Invoice) => void; onCreatePayment?: (invoice: Invoice) => void }) {
  const invoiceClosed = ['paid', 'cancelled', 'void', 'written_off'].includes(invoice.status);
  const isLocked = Boolean(invoice.locked_at) || ['sent','overdue','paid','cancelled','void','written_off'].includes(invoice.status) || Boolean(payment);
  const canSend = canWrite && !invoiceClosed;
  const canPay = canWrite && !invoiceClosed && !['paid','creating','open','pending','authorized'].includes(payment?.status || '');
  return <div className="quote-actions invoice-actions">
    <Button onClick={onEdit} disabled={isLocked} title={isLocked ? 'Deze factuur is vergrendeld na verzending of betaallink.' : undefined}>Bewerken</Button>
    {canSend && <Button variant="primary" onClick={() => onSend?.(invoice)}><Send size={14}/> Verstuur via Resend</Button>}
    {canPay && <Button variant="primary" onClick={() => onCreatePayment?.(invoice)}><CreditCard size={14}/> Maak Mollie-betaallink</Button>}
  </div>;
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
