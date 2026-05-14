import { Download, Mail, ShieldCheck, Send, XCircle } from 'lucide-react';
import type { AppData, FinanceStatus, Invoice, Quote, QuoteEmailDelivery, QuoteVersion } from '../types';
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
  return <>
    <div className="fin-header"><h2>{title}</h2><Button variant="primary" onClick={onNew}>+ Nieuw</Button></div>
    <div className="fin-list">
      {docs.map(doc => {
        const client = data.clients.find(c => c.id === doc.client_id) ?? null;
        const project = data.projects.find(p => p.id === doc.project_id) ?? null;
        const amount = total(doc.lines).total;
        const quote = kind === 'quote' ? doc as Quote : null;
        const events = quote ? data.quoteApprovalEvents.filter(event => event.quote_id === quote.id).slice(0, 6) : [];
        const deliveries = quote ? data.quoteEmailDeliveries.filter(delivery => delivery.quote_id === quote.id) : [];
        const latestDelivery = deliveries[0] ?? null;
        const versions = quote ? data.quoteVersions.filter(version => version.quote_id === quote.id).slice(0, 4) : [];
        return <article className={`fin-item fin-item-rich st-${doc.status}`} key={doc.id} onClick={() => onEdit(doc)}>
          <div className="fin-main-row">
            <div className="fin-num">{doc.number}</div>
            <div className="fin-body">
              <div className="fin-title">{client?.name ?? 'Geen klant'}</div>
              <div className="fin-meta">{dateNL(doc.date)}{project ? ` · ${project.name}` : ''}</div>
            </div>
            <div className="fin-date">{'due_date' in doc ? dateNL(doc.due_date) : dateNL((doc as Quote).valid_until)}</div>
            <div className="fin-amount">{euro(amount)}</div>
            <div className={`fin-status ${doc.status}`}>{kind === 'quote' ? quoteStatusLabel(doc as Quote) : statusLabel(doc.status)}</div>
            <button
              type="button"
              className="att-btn"
              onClick={(e) => { e.stopPropagation(); void exportFinancePDF(doc, kind, client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }}
              title="Download PDF"
            ><Download size={14}/></button>
          </div>

          {quote && <div className="quote-workflow-panel" onClick={event => event.stopPropagation()}>
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
              onEdit={() => onEdit(doc)}
            />
            <QuoteVersions versions={versions} />
            <QuoteTimeline events={events} emptyText="Nog geen workflow-events." />
          </div>}
        </article>;
      })}
      {docs.length === 0 && <div className="empty"><div className="e-big">Nog geen {title.toLowerCase()}</div></div>}
    </div>
  </>;
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
