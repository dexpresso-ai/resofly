import { useMemo, useState } from 'react';
import { Download, Eye, Mail, ShieldCheck, Send, XCircle } from 'lucide-react';
import type { AppData, FinanceStatus, Invoice, Quote, QuoteEmailDelivery, QuoteVersion } from '../types';
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
  />;
}

export function Invoices({ data, onNew, onEdit }: { data: AppData; onNew: () => void; onEdit: (i: Invoice) => void }) {
  return <FinanceList kind="invoice" title="Facturen" docs={data.invoices} data={data} onNew={onNew} onEdit={onEdit}/>;
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
    />;
  }

  return <>
    <div className="fin-header"><h2>{title}</h2><Button variant="primary" onClick={onNew}>+ Nieuw</Button></div>
    <div className="fin-list">
      {docs.map(doc => {
        const client = data.clients.find(c => c.id === doc.client_id) ?? null;
        const project = data.projects.find(p => p.id === doc.project_id) ?? null;
        const amount = total(doc.lines).total;
        return <article className={`fin-item st-${doc.status}`} key={doc.id} onClick={() => onEdit(doc)}>
          <div className="fin-num">{doc.number}</div>
          <div className="fin-body">
            <div className="fin-title">{client?.name ?? 'Geen klant'}</div>
            <div className="fin-meta">{dateNL(doc.date)}{project ? ` · ${project.name}` : ''}</div>
          </div>
          <div className="fin-date">{'due_date' in doc ? dateNL(doc.due_date) : dateNL((doc as Quote).valid_until)}</div>
          <div className="fin-amount">{euro(amount)}</div>
          <div className={`fin-status ${doc.status}`}>{statusLabel(doc.status)}</div>
          <button
            type="button"
            className="att-btn"
            onClick={(e) => { e.stopPropagation(); void exportFinancePDF(doc, kind, client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }}
            title="Download PDF"
          ><Download size={14}/></button>
        </article>;
      })}
      {docs.length === 0 && <div className="empty"><div className="e-big">Nog geen {title.toLowerCase()}</div></div>}
    </div>
  </>;
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
}) {
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const selectedQuote = useMemo(() => quotes.find(quote => quote.id === selectedQuoteId) ?? null, [quotes, selectedQuoteId]);

  return <>
    <div className="fin-header quote-table-header">
      <div>
        <h2>{title}</h2>
        <p>Compact overzicht met alle bedragen, klant- en projectcontext. Klik op een offerte voor workflow en details.</p>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw</Button>
    </div>

    <div className="quote-table-card">
      <div className="quote-table-scroll" role="region" aria-label="Offertes tabel">
        <table className="quote-table">
          <thead>
            <tr>
              <th>Offerte</th>
              <th>Klant</th>
              <th>Project</th>
              <th>Datum</th>
              <th>Verloopt</th>
              <th className="money">Bedrag ex.</th>
              <th className="money">BTW</th>
              <th className="money">Totaal</th>
              <th>Status</th>
              <th aria-label="Acties" />
            </tr>
          </thead>
          <tbody>
            {quotes.map(quote => {
              const client = data.clients.find(c => c.id === quote.client_id) ?? null;
              const project = data.projects.find(p => p.id === quote.project_id) ?? null;
              const amounts = total(quote.lines);
              return <tr key={quote.id} className={`quote-table-row st-${quote.status}`} onClick={() => setSelectedQuoteId(quote.id)} tabIndex={0} onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelectedQuoteId(quote.id);
                }
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
                  <button
                    type="button"
                    className="att-btn"
                    onClick={() => { void exportFinancePDF(quote, 'quote', client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }}
                    title="Download PDF"
                  ><Download size={14}/></button>
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
      onEdit={(quote) => {
        setSelectedQuoteId(null);
        onEdit(quote);
      }}
      onSubmitApproval={onSubmitApproval}
      onApprove={onApprove}
      onReject={onReject}
      onSend={onSend}
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
}) {
  const client = data.clients.find(c => c.id === quote.client_id) ?? null;
  const project = data.projects.find(p => p.id === quote.project_id) ?? null;
  const amounts = total(quote.lines);
  const events = data.quoteApprovalEvents.filter(event => event.quote_id === quote.id);
  const deliveries = data.quoteEmailDeliveries.filter(delivery => delivery.quote_id === quote.id);
  const latestDelivery = deliveries[0] ?? null;
  const versions = data.quoteVersions.filter(version => version.quote_id === quote.id);

  return <Modal title={`Offerte ${quote.number}`} onClose={onClose} className="quote-detail-modal">
    <div className="quote-detail">
      <section className="quote-detail-hero">
        <div>
          <span className="quote-detail-kicker">Offerteflow</span>
          <h2>{client?.name ?? 'Geen klant'}</h2>
          <p>{project?.name ?? 'Geen project gekoppeld'} · {dateNL(quote.date)} tot {dateNL(quote.valid_until)}</p>
        </div>
        <div className="quote-detail-total">
          <small>Totaal incl. btw</small>
          <strong>{euro(amounts.total)}</strong>
          <span className={`fin-status ${quote.status}`}>{quoteStatusLabel(quote)}</span>
        </div>
      </section>

      <section className="quote-detail-metrics" aria-label="Offerte bedragen en datums">
        <QuoteMetric label="Bedrag ex. btw" value={euro(amounts.subtotal)} />
        <QuoteMetric label="BTW" value={euro(amounts.vat)} />
        <QuoteMetric label="Totaal" value={euro(amounts.total)} strong />
        <QuoteMetric label="Datum" value={dateNL(quote.date)} />
        <QuoteMetric label="Verloopdatum" value={dateNL(quote.valid_until)} />
        <QuoteMetric label="Laatste mailstatus" value={latestDelivery?.status ? emailStatusLabel(latestDelivery.status) : 'Nog niet verstuurd'} />
      </section>

      <section className="quote-detail-section">
        <div className="quote-detail-section-head">
          <div><span>Workflow</span><strong>Goedkeuring, verzending en klantbeslissing</strong></div>
        </div>
        <QuoteProgress quote={quote} />
        <QuoteEmailStatus delivery={latestDelivery} quote={quote} />
        <QuoteActions
          quote={quote}
          canWrite={canWrite}
          canAdmin={canAdmin}
          onSubmitApproval={onSubmitApproval}
          onApprove={onApprove}
          onReject={onReject}
          onSend={onSend}
          onEdit={() => onEdit(quote)}
        />
      </section>

      <section className="quote-detail-split">
        <div className="quote-detail-section">
          <div className="quote-detail-section-head"><div><span>Versies</span><strong>Vastgelegde snapshots</strong></div></div>
          <QuoteVersions versions={versions} />
        </div>
        <div className="quote-detail-section">
          <div className="quote-detail-section-head"><div><span>Regels</span><strong>Offertebedragen</strong></div></div>
          <QuoteLineTable lines={quote.lines} />
        </div>
      </section>

      <section className="quote-detail-section">
        <div className="quote-detail-section-head"><div><span>Tijdlijn</span><strong>Alle workflow-events</strong></div></div>
        <QuoteTimeline events={events} emptyText="Nog geen workflow-events." />
      </section>
    </div>
  </Modal>;
}

function QuoteMetric({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`quote-metric ${strong ? 'strong' : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>;
}

function QuoteLineTable({ lines }: { lines: Quote['lines'] }) {
  if (lines.length === 0) return <div className="quote-lines-empty">Geen offerteregels.</div>;
  return <div className="quote-lines-table-wrap">
    <table className="quote-lines-table">
      <thead><tr><th>Omschrijving</th><th>Aantal</th><th>Prijs</th><th>BTW</th><th>Totaal</th></tr></thead>
      <tbody>{lines.map(line => {
        const subtotal = Number(line.quantity || 0) * Number(line.unit_price || 0);
        const lineVat = subtotal * Number(line.vat || 0) / 100;
        return <tr key={line.id}>
          <td>{line.description || '—'}</td>
          <td>{line.quantity}</td>
          <td>{euro(line.unit_price)}</td>
          <td>{line.vat}%</td>
          <td>{euro(subtotal + lineVat)}</td>
        </tr>;
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
}) {
  const quotes = data.quotes.filter(quote => quote.project_id === projectId);
  return <section className="project-quotes-panel">
    <div className="section-head-inline project-section-head">
      <div><h2>Offertes</h2><p>Projectgekoppelde offertes met interne goedkeuring, Resend-status en klantbeslissing.</p></div>
      <Button variant="primary" onClick={onNewQuote} disabled={!canWrite}>+ Offerte</Button>
    </div>
    {quotes.length === 0 ? <div className="empty project-empty"><div className="e-big">Nog geen offertes bij dit project</div><p>Maak een offerte direct vanuit het project, dan worden klant en project automatisch gekoppeld.</p></div> : <div className="project-quotes-list">
      {quotes.map(quote => {
        const client = data.clients.find(item => item.id === quote.client_id) ?? null;
        const latestDelivery = data.quoteEmailDeliveries.find(delivery => delivery.quote_id === quote.id) ?? null;
        const events = data.quoteApprovalEvents.filter(event => event.quote_id === quote.id).slice(0, 4);
        const versions = data.quoteVersions.filter(version => version.quote_id === quote.id).slice(0, 3);
        return <article key={quote.id} className={`project-quote-card st-${quote.status}`}>
          <div className="project-quote-head" onClick={() => onEditQuote(quote)}>
            <div><strong>{quote.number}</strong><span>{client?.name ?? 'Geen klant'} · {dateNL(quote.date)}</span></div>
            <div><strong>{euro(total(quote.lines).total)}</strong><span>{quoteStatusLabel(quote)}</span></div>
          </div>
          <QuoteProgress quote={quote} compact />
          <QuoteEmailStatus delivery={latestDelivery} quote={quote} />
          <QuoteActions quote={quote} canWrite={canWrite} canAdmin={canAdmin} onSubmitApproval={onSubmitApproval} onApprove={onApprove} onReject={onReject} onSend={onSend} onEdit={() => onEditQuote(quote)} compact />
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
  return <div className="quote-email-status">
    <Mail size={14}/>
    <span>{status ? emailStatusLabel(status) : 'Nog niet verstuurd'}</span>
    {delivery?.recipient_email && <small>{delivery.recipient_email}</small>}
    {delivery?.attachment_file_name && <small>PDF: {delivery.attachment_file_name}</small>}
    {quote.public_token_expires_at && <small>Link tot {dateNL(quote.public_token_expires_at)}</small>}
  </div>;
}

function QuoteActions({
  quote,
  canWrite,
  canAdmin,
  onSubmitApproval,
  onApprove,
  onReject,
  onSend,
  onEdit,
  compact = false,
}: {
  quote: Quote;
  canWrite: boolean;
  canAdmin: boolean;
  onSubmitApproval?: (quote: Quote) => void;
  onApprove?: (quote: Quote) => void;
  onReject?: (quote: Quote) => void;
  onSend?: (quote: Quote) => void;
  onEdit: () => void;
  compact?: boolean;
}) {
  const canSubmit = canWrite && ['draft'].includes(quote.status) && quote.internal_approval_status !== 'pending';
  const canApprove = canAdmin && quote.status === 'pending_internal_approval';
  const canSend = canWrite && quote.status === 'internally_approved' && quote.internal_approval_status === 'approved';
  return <div className={`quote-actions ${compact ? 'compact' : ''}`}>
    <Button onClick={onEdit}>Bewerken</Button>
    {canSubmit && <Button onClick={() => onSubmitApproval?.(quote)}><ShieldCheck size={14}/> Ter goedkeuring</Button>}
    {canApprove && <Button variant="primary" onClick={() => onApprove?.(quote)}><ShieldCheck size={14}/> Goedkeuren</Button>}
    {canApprove && <Button variant="danger" onClick={() => onReject?.(quote)}><XCircle size={14}/> Afwijzen</Button>}
    {canSend && <Button variant="primary" onClick={() => onSend?.(quote)}><Send size={14}/> Verstuur via Resend</Button>}
  </div>;
}


function QuoteVersions({ versions, compact = false }: { versions: QuoteVersion[]; compact?: boolean }) {
  if (versions.length === 0) return <div className={`quote-versions ${compact ? 'compact' : ''}`}><span>Nog geen offerteversies vastgelegd.</span></div>;
  return <div className={`quote-versions ${compact ? 'compact' : ''}`}>
    {versions.map(version => <div className="quote-version-pill" key={version.id} title={version.pdf_sha256 ? `PDF SHA-256: ${version.pdf_sha256}` : undefined}>
      <strong>v{version.version_number}</strong>
      <span>{quoteVersionReasonLabel(version.snapshot_reason)}</span>
      {!compact && <small>{dateNL(version.created_at)} · {euro(Number(version.total_amount || 0))}</small>}
      {!compact && version.pdf_file_name && <small>PDF-snapshot: {version.pdf_file_name}{version.pdf_size_bytes ? ` · ${formatBytes(version.pdf_size_bytes)}` : ''}</small>}
    </div>)}
  </div>;
}

function QuoteTimeline({ events, emptyText, compact = false }: { events: AppData['quoteApprovalEvents']; emptyText: string; compact?: boolean }) {
  return <div className={`quote-timeline ${compact ? 'compact' : ''}`}>
    {events.length === 0 && <div className="quote-timeline-empty">{emptyText}</div>}
    {events.map(event => <div className="quote-timeline-item" key={event.id}>
      <span>{new Date(event.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      <strong>{event.title}</strong>
      {!compact && event.description && <p>{event.description}</p>}
    </div>)}
  </div>;
}

function quoteStatusLabel(quote: Quote): string {
  if (quote.status === 'draft' && quote.internal_approval_status === 'rejected') return 'Intern afgewezen';
  if (quote.status === 'draft') return 'Concept';
  if (quote.status === 'pending_internal_approval') return 'Wacht op interne goedkeuring';
  if (quote.status === 'internally_approved') return 'Intern goedgekeurd';
  return statusLabel(quote.status);
}

function statusLabel(status: FinanceStatus | string): string {
  const labels: Record<string, string> = {
    draft: 'Concept',
    pending_internal_approval: 'Wacht op interne goedkeuring',
    internally_approved: 'Intern goedgekeurd',
    sent: 'Verzonden',
    accepted: 'Geaccepteerd',
    paid: 'Betaald',
    rejected: 'Afgewezen',
    expired: 'Verlopen',
    overdue: 'Te laat',
    cancelled: 'Geannuleerd',
  };
  return labels[status] || status;
}

function emailStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: 'E-mail in wachtrij',
    sent: 'E-mail verzonden',
    delivered: 'E-mail afgeleverd',
    opened: 'E-mail geopend',
    clicked: 'Link aangeklikt',
    bounced: 'E-mail bounced',
    failed: 'E-mail mislukt',
    complained: 'Spamklacht',
  };
  return labels[status] || status;
}

function quoteVersionReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    internal_approval: 'Interne goedkeuring',
    sent_to_client: 'Verzonden versie',
    client_accepted: 'Geaccepteerde versie',
    manual: 'Handmatige snapshot',
  };
  return labels[reason] || reason;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
