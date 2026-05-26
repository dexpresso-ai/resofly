import { useMemo, useState } from 'react';
import type { AppData, Client, ClientStatus, Invoice, Note, Project, Quote } from '../types';
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

type ClientViewMode = 'cards' | 'table';

type ClientOverviewRow = {
  client: Client;
  noteCount: number;
  invoiceCount: number;
  quoteCount: number;
  overdueInvoiceCount: number;
  openInvoiceCount: number;
  openInvoiceTotal: number;
};

const clientViewStorageKey = 'resofly.clients.viewMode';

const clientStatusLabels: Record<ClientStatus, string> = {
  active: 'Actief',
  prospect: 'Prospect',
  inactive: 'Inactief',
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
  const [viewMode, setViewMode] = useState<ClientViewMode>(readClientViewMode);

  const rows = useMemo<ClientOverviewRow[]>(() => data.clients.map(client => {
    const invoices = getClientInvoices(data, client.id);
    const openInvoices = invoices.filter(isInvoiceOpen);
    const overdueInvoices = invoices.filter(isInvoiceOverdue);

    return {
      client,
      noteCount: getClientNotes(data, client.id).length,
      invoiceCount: invoices.length,
      quoteCount: getClientQuotes(data, client.id).length,
      overdueInvoiceCount: overdueInvoices.length,
      openInvoiceCount: openInvoices.length,
      openInvoiceTotal: openInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0),
    };
  }), [data]);

  const changeViewMode = (nextViewMode: ClientViewMode) => {
    setViewMode(nextViewMode);
    try {
      window.localStorage.setItem(clientViewStorageKey, nextViewMode);
    } catch {
      // LocalStorage is een UX-voorkeur; als dit faalt blijft de toggle gewoon werken tijdens de sessie.
    }
  };

  return <div className="clients-page">
    <div className="clients-page-head">
      <div>
        <p className="eyebrow">CRM</p>
        <h2>Klanten</h2>
        <span>{rows.length} klant{rows.length === 1 ? '' : 'en'} in deze werkruimte</span>
      </div>
      <div className="clients-toolbar-actions">
        <div className="client-view-toggle" role="group" aria-label="Klantweergave">
          <button type="button" className={viewMode === 'cards' ? 'active' : ''} onClick={() => changeViewMode('cards')} aria-pressed={viewMode === 'cards'}>Kaarten</button>
          <button type="button" className={viewMode === 'table' ? 'active' : ''} onClick={() => changeViewMode('table')} aria-pressed={viewMode === 'table'}>Tabel</button>
        </div>
        <Button variant="primary" onClick={onNew}>+ Nieuwe klant</Button>
      </div>
    </div>

    {rows.length === 0 && <div className="client-empty-state">
      <strong>Nog geen klanten</strong>
      <span>Maak je eerste klant aan om offertes, facturen, projecten en notities netjes te bundelen.</span>
      <Button variant="primary" onClick={onNew}>+ Nieuwe klant</Button>
    </div>}

    {rows.length > 0 && viewMode === 'cards' && <ClientCardGrid rows={rows} onOpen={onOpen} />}
    {rows.length > 0 && viewMode === 'table' && <ClientTable rows={rows} onOpen={onOpen} />}
  </div>;
}

function ClientCardGrid({ rows, onOpen }: { rows: ClientOverviewRow[]; onOpen: (client: Client) => void }) {
  return <div className="clients-grid">
    {rows.map(row => {
      const { client } = row;

      return <article className="client-card" key={client.id} onClick={() => onOpen(client)}>
        <div className="client-card-head">
          <div className="cc-avatar" style={{ background: client.color }}>{client.name.slice(0, 2).toUpperCase()}</div>
          {row.overdueInvoiceCount > 0 && <span className="client-alert danger">{row.overdueInvoiceCount} vervallen</span>}
          {row.overdueInvoiceCount === 0 && row.openInvoiceCount > 0 && <span className="client-alert warning">{row.openInvoiceCount} open</span>}
        </div>
        <div className="cc-name">{client.name}</div>
        <div className="cc-id">{client.client_code ?? '—'}</div>
        <div className="cc-meta"><span>{client.contact_name ?? 'Geen contact'}</span><span>{euro(client.value_eur)}</span></div>
        <div className="client-card-finance">
          <span>{row.quoteCount} offerte{row.quoteCount === 1 ? '' : 's'}</span>
          <span>{row.invoiceCount} factu{row.invoiceCount === 1 ? 'ur' : 'ren'}</span>
        </div>
        <div className="cc-note-count">📝 {row.noteCount} notitie{row.noteCount === 1 ? '' : 's'}</div>
        <div className="cd-tags">{client.tags?.map(tag => <span className="cd-tag" key={tag}>{tag}</span>)}</div>
      </article>;
    })}
  </div>;
}

function ClientTable({ rows, onOpen }: { rows: ClientOverviewRow[]; onOpen: (client: Client) => void }) {
  return <section className="clients-table-card" aria-label="Klanten tabelweergave">
    <div className="clients-table-scroll">
      <table className="clients-table">
        <thead>
          <tr>
            <th>Klantnummer</th>
            <th>Klant</th>
            <th>Contact</th>
            <th>Status</th>
            <th className="number">Offertes</th>
            <th className="number">Facturen</th>
            <th className="money">Openstaand</th>
            <th className="money">Waarde</th>
            <th>Bijgewerkt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const { client } = row;
            return <tr
              key={client.id}
              className="clients-table-row"
              tabIndex={0}
              onClick={() => onOpen(client)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpen(client);
                }
              }}
            >
              <td><strong>{client.client_code ?? '—'}</strong></td>
              <td>
                <div className="clients-table-name">
                  <span className="clients-table-avatar" style={{ background: client.color }}>{client.name.slice(0, 2).toUpperCase()}</span>
                  <span>{client.name}</span>
                </div>
              </td>
              <td><span>{client.contact_name || client.email || '—'}</span></td>
              <td><span className={`client-status-pill ${client.status}`}>{clientStatusLabels[client.status] ?? client.status}</span></td>
              <td className="number">{row.quoteCount}</td>
              <td className="number">
                <span className="client-table-finance-count">{row.invoiceCount}</span>
                {row.overdueInvoiceCount > 0 && <em className="client-table-alert danger">{row.overdueInvoiceCount} vervallen</em>}
                {row.overdueInvoiceCount === 0 && row.openInvoiceCount > 0 && <em className="client-table-alert warning">{row.openInvoiceCount} open</em>}
              </td>
              <td className="money">{euro(row.openInvoiceTotal)}</td>
              <td className="money">{euro(client.value_eur)}</td>
              <td>{dateNL(client.updated_at)}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}

function readClientViewMode(): ClientViewMode {
  try {
    const saved = window.localStorage.getItem(clientViewStorageKey);
    return saved === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
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
