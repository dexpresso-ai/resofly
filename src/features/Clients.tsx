import type { AppData, Client, Invoice, Note, Project, Quote } from '../types';
import { dateNL, euro, total } from '../lib/format';
import { Button } from '../components/Ui';
import { RelatedNotes } from './Notes';

const invoiceStatusLabels: Record<string, string> = {
  draft: 'Concept',
  sent: 'Verzonden',
  accepted: 'Openstaand',
  paid: 'Betaald',
  overdue: 'Vervallen',
  cancelled: 'Geannuleerd',
};

const quoteStatusLabels: Record<string, string> = {
  draft: 'Concept',
  pending_internal_approval: 'Wacht op interne goedkeuring',
  internally_approved: 'Intern goedgekeurd',
  sent: 'Verzonden',
  accepted: 'Geaccepteerd',
  rejected: 'Afgewezen',
  expired: 'Verlopen',
  cancelled: 'Geannuleerd',
};

export function Clients({
  data,
  onNew,
  onOpen,
}: {
  data: AppData;
  onNew: () => void;
  onOpen: (c: Client) => void;
}) {
  const notesForClient = (client: Client) => getClientNotes(data, client.id);

  return <>
    <div className="crm-toolbar"><Button variant="primary" onClick={onNew}>+ Nieuwe klant</Button></div>
    <div className="clients-grid">
      {data.clients.map(client => {
        const noteCount = notesForClient(client).length;
        const invoices = getClientInvoices(data, client.id);
        const quotes = getClientQuotes(data, client.id);
        const overdueInvoices = invoices.filter(isInvoiceOverdue);
        const openInvoices = invoices.filter(isInvoiceOpen);

        return <article className="client-card" key={client.id} onClick={() => onOpen(client)}>
          <div className="client-card-head">
            <div className="cc-avatar" style={{ background: client.color }}>{client.name.slice(0, 2).toUpperCase()}</div>
            {overdueInvoices.length > 0 && <span className="client-alert danger">{overdueInvoices.length} vervallen</span>}
            {overdueInvoices.length === 0 && openInvoices.length > 0 && <span className="client-alert warning">{openInvoices.length} open</span>}
          </div>
          <div className="cc-name">{client.name}</div>
          <div className="cc-id">{client.client_code ?? '—'}</div>
          <div className="cc-meta"><span>{client.contact_name ?? 'Geen contact'}</span><span>{euro(client.value_eur)}</span></div>
          <div className="client-card-finance">
            <span>{quotes.length} offerte{quotes.length === 1 ? '' : 's'}</span>
            <span>{invoices.length} factu{invoices.length === 1 ? 'ur' : 'ren'}</span>
          </div>
          <div className="cc-note-count">📝 {noteCount} notitie{noteCount === 1 ? '' : 's'}</div>
          <div className="cd-tags">{client.tags?.map(tag => <span className="cd-tag" key={tag}>{tag}</span>)}</div>
        </article>;
      })}
    </div>
  </>;
}

export function ClientDetailPage({
  data,
  client,
  canWrite,
  onBack,
  onEditClient,
  onNewQuote,
  onEditQuote,
  onNewInvoice,
  onEditInvoice,
  onOpenProject,
  onNewNote,
  onEditNote,
}: {
  data: AppData;
  client: Client;
  canWrite: boolean;
  onBack: () => void;
  onEditClient: () => void;
  onNewQuote: () => void;
  onEditQuote: (quote: Quote) => void;
  onNewInvoice: () => void;
  onEditInvoice: (invoice: Invoice) => void;
  onOpenProject: (project: Project) => void;
  onNewNote: () => void;
  onEditNote: (note: Note) => void;
}) {
  const projects = data.projects.filter(project => project.client_id === client.id);
  const notes = getClientNotes(data, client.id);
  const quotes = getClientQuotes(data, client.id);
  const invoices = getClientInvoices(data, client.id);
  const openInvoices = invoices.filter(isInvoiceOpen);
  const overdueInvoices = invoices.filter(isInvoiceOverdue);
  const paidInvoices = invoices.filter(invoice => invoice.status === 'paid');
  const invoiceTotal = invoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0);
  const openInvoiceTotal = openInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0);
  const overdueInvoiceTotal = overdueInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0);
  const quoteTotal = quotes.reduce((sum, quote) => sum + total(quote.lines).total, 0);

  return <div className="client-detail-page">
    <section className="client-detail-hero">
      <div className="client-detail-title">
        <Button onClick={onBack}>← Terug naar klanten</Button>
        <div className="client-title-row">
          <div className="client-hero-avatar" style={{ background: client.color }}>{client.name.slice(0, 2).toUpperCase()}</div>
          <div>
            <h2>{client.name}</h2>
            <p>{client.client_code ?? 'Geen klantcode'} · {client.status}</p>
          </div>
        </div>
      </div>
      <div className="client-detail-actions">
        <Button onClick={onEditClient}>Klant bewerken</Button>
        <Button onClick={onNewQuote} disabled={!canWrite}>+ Offerte</Button>
        <Button variant="primary" onClick={onNewInvoice} disabled={!canWrite}>+ Factuur</Button>
      </div>
    </section>

    {(overdueInvoices.length > 0 || openInvoices.length > 0) && <section className={`client-billing-alert ${overdueInvoices.length > 0 ? 'danger' : 'warning'}`}>
      <strong>{overdueInvoices.length > 0 ? `${overdueInvoices.length} vervallen factuur${overdueInvoices.length === 1 ? '' : 'en'}` : `${openInvoices.length} openstaande factuur${openInvoices.length === 1 ? '' : 'en'}`}</strong>
      <span>{overdueInvoices.length > 0 ? `${euro(overdueInvoiceTotal)} staat over de vervaldatum.` : `${euro(openInvoiceTotal)} staat nog open.`}</span>
    </section>}

    <section className="client-kpi-grid">
      <ClientKpi label="Offertes" value={quotes.length} sub={euro(quoteTotal)} />
      <ClientKpi label="Facturen" value={invoices.length} sub={euro(invoiceTotal)} />
      <ClientKpi label="Openstaand" value={openInvoices.length} sub={euro(openInvoiceTotal)} tone={openInvoices.length ? 'warning' : undefined} />
      <ClientKpi label="Vervallen" value={overdueInvoices.length} sub={euro(overdueInvoiceTotal)} tone={overdueInvoices.length ? 'danger' : undefined} />
      <ClientKpi label="Betaald" value={paidInvoices.length} sub={euro(paidInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0))} tone="success" />
    </section>

    <section className="client-detail-grid">
      <article className="client-panel client-info-panel">
        <div className="client-panel-head"><h3>Klantgegevens</h3></div>
        <dl className="client-info-list">
          <div><dt>Contactpersoon</dt><dd>{client.contact_name || '—'}</dd></div>
          <div><dt>E-mail</dt><dd>{client.email || '—'}</dd></div>
          <div><dt>Telefoon</dt><dd>{client.phone || '—'}</dd></div>
          <div><dt>Waarde</dt><dd>{euro(client.value_eur)}</dd></div>
          <div><dt>Aangemaakt</dt><dd>{dateNL(client.created_at)}</dd></div>
          <div><dt>Bijgewerkt</dt><dd>{dateNL(client.updated_at)}</dd></div>
        </dl>
        {client.notes && <p className="client-inline-notes">{client.notes}</p>}
        <div className="cd-tags">{client.tags?.map(tag => <span className="cd-tag" key={tag}>{tag}</span>)}</div>
      </article>

      <article className="client-panel">
        <div className="client-panel-head"><h3>Projecten</h3><span>{projects.length}</span></div>
        <div className="client-project-list">
          {projects.length === 0 && <div className="client-empty-line">Nog geen projecten gekoppeld.</div>}
          {projects.map(project => <button key={project.id} type="button" className="client-project-row" onClick={() => onOpenProject(project)}>
            <span className="client-project-dot" style={{ background: project.color }} />
            <span>{project.name}</span>
            {project.archived && <em>Gearchiveerd</em>}
          </button>)}
        </div>
      </article>
    </section>

    <section className="client-finance-grid">
      <FinancePanel
        title="Offertes"
        emptyText="Nog geen offertes voor deze klant."
        items={quotes}
        kind="quote"
        onEdit={onEditQuote}
      />
      <FinancePanel
        title="Facturen"
        emptyText="Nog geen facturen voor deze klant."
        items={invoices}
        kind="invoice"
        onEdit={onEditInvoice}
      />
    </section>

    <RelatedNotes title="Klantnotities" notes={notes} data={data} canWrite={canWrite} onNew={onNewNote} onEdit={onEditNote} emptyText="Nog geen notities bij deze klant." />
  </div>;
}

function ClientKpi({ label, value, sub, tone }: { label: string; value: number; sub: string; tone?: 'warning' | 'danger' | 'success' }) {
  return <article className={`client-kpi ${tone ?? ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{sub}</small>
  </article>;
}

function FinancePanel<T extends Quote | Invoice>({
  title,
  emptyText,
  items,
  kind,
  onEdit,
}: {
  title: string;
  emptyText: string;
  items: T[];
  kind: 'quote' | 'invoice';
  onEdit: (item: T) => void;
}) {
  return <article className="client-panel">
    <div className="client-panel-head"><h3>{title}</h3><span>{items.length}</span></div>
    <div className="client-finance-list">
      {items.length === 0 && <div className="client-empty-line">{emptyText}</div>}
      {items.map(item => {
        const isInvoice = kind === 'invoice';
        const dueLabel = isInvoice ? dateNL((item as Invoice).due_date) : dateNL((item as Quote).valid_until);
        const amount = total(item.lines).total;
        const overdue = isInvoice && isInvoiceOverdue(item as Invoice);
        const statusLabel = isInvoice ? invoiceStatusLabels[item.status] ?? item.status : quoteStatusLabels[item.status] ?? item.status;

        return <button key={item.id} type="button" className={`client-finance-row ${overdue ? 'is-overdue' : ''}`} onClick={() => onEdit(item)}>
          <span className="client-finance-number">{item.number}</span>
          <span className="client-finance-meta">{dateNL(item.date)} · {isInvoice ? 'Vervalt' : 'Geldig tot'} {dueLabel}</span>
          <span className="client-finance-amount">{euro(amount)}</span>
          <span className={`client-finance-status ${overdue ? 'overdue' : item.status}`}>{overdue ? 'Vervallen' : statusLabel}</span>
        </button>;
      })}
    </div>
  </article>;
}

function getClientProjectIds(data: AppData, clientId: string) {
  return new Set(data.projects.filter(project => project.client_id === clientId).map(project => project.id));
}

function getClientQuotes(data: AppData, clientId: string) {
  const projectIds = getClientProjectIds(data, clientId);
  return data.quotes
    .filter(quote => quote.client_id === clientId || Boolean(quote.project_id && projectIds.has(quote.project_id)))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

function getClientInvoices(data: AppData, clientId: string) {
  const projectIds = getClientProjectIds(data, clientId);
  return data.invoices
    .filter(invoice => invoice.client_id === clientId || Boolean(invoice.project_id && projectIds.has(invoice.project_id)))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}

function getClientNotes(data: AppData, clientId: string) {
  const projectIds = getClientProjectIds(data, clientId);
  return data.notes.filter(note => note.client_id === clientId || Boolean(note.project_id && projectIds.has(note.project_id)));
}

function isInvoiceOpen(invoice: Invoice) {
  return !['paid', 'cancelled', 'draft'].includes(invoice.status);
}

function isInvoiceOverdue(invoice: Invoice) {
  if (invoice.status === 'paid' || invoice.status === 'cancelled') return false;
  if (invoice.status === 'overdue') return true;
  if (!invoice.due_date) return false;
  return invoice.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10);
}
