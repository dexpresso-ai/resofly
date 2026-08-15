import { useEffect, useMemo, useState } from 'react';
import { Search, RotateCcw, Upload, ChevronDown, ChevronRight, Mail } from 'lucide-react';
import type { AppData, Client, ClientEmail, ClientEmailStatus, ClientEmailThread, ClientFieldDefinition, ClientStatus, Contract, InboundMessage, InboundMessageCategory, InternalDocument, Invoice, Note, Project, Quote } from '../types';
import { activeFieldDefinitions, customFieldsSearchText, formatCustomFieldValue } from '../components/CustomFields';
import { dateNL, euro, formatMinutes, minutesToHours, total } from '../lib/format';
import { sanitizeEmailHtml } from '../lib/sanitizeHtml';
import { Button, Input, Select } from '../components/Ui';
import { CsvImportModal } from '../components/CsvImportModal';
import type { ImportColumn } from '../lib/csvImport';
import { RichTextEditor } from '../components/RichTextEditor';
import { blockInboundSender, createClientWithServerCode, deleteClientEmail, linkInboundMessage, loadClientEmails, loadClientEmailThreads, loadClientEmailReadIds, loadInboundAlias, loadInboundMessages, loadInboundOpenCount, loadMySenderIdentity, loadSendingDomains, markClientEmailsRead, setInboundMessageStatus } from '../lib/repository';
import { resolveEffectiveSender, sendClientEmail, type EffectiveSender } from '../services/mailService';
import { supabase } from '../lib/supabase';
import { ClientFolders } from './ClientFolders';
import { ClientContacts } from './ClientContacts';
import { ContractStatusBadge } from './Contracts';

// Vaste kolommen voor de bulk CSV-import van klanten. Het klantnummer ontbreekt
// bewust: dat wordt server-side atomair toegekend (createClientWithServerCode).
const CLIENT_IMPORT_COLUMNS: ImportColumn[] = [
  { key: 'name', header: 'Naam', required: true, example: 'Acme BV' },
  { key: 'contact_name', header: 'Contactpersoon', example: 'Jan Jansen' },
  { key: 'email', header: 'E-mail', kind: 'email', example: 'info@acme.nl' },
  { key: 'phone', header: 'Telefoon', example: '010-1234567' },
  {
    key: 'status', header: 'Status', kind: 'enum', default: 'active', example: 'Actief',
    enumValues: { actief: 'active', active: 'active', prospect: 'prospect', inactief: 'inactive', inactive: 'inactive' },
  },
  { key: 'value_eur', header: 'Waarde (EUR)', kind: 'number', default: 0, example: '2500' },
  { key: 'tags', header: 'Tags', kind: 'tags', example: 'VIP, Retainer' },
  { key: 'notes', header: 'Notities', example: 'Belangrijke klant' },
];

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
  organizationId,
  canWrite,
  onNew,
  onOpen,
  onChanged,
  unreadByClient,
}: {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onNew: () => void;
  onOpen: (c: Client) => void;
  onChanged: () => void;
  unreadByClient: Record<string, number>;
}) {
  const [viewMode, setViewMode] = useState<ClientViewMode>(readClientViewMode);
  const [importing, setImporting] = useState(false);
  const [listTab, setListTab] = useState<'clients' | 'inbox'>('clients');
  const [inboxCount, setInboxCount] = useState(0);

  // Telling van de opvangbak. Faalt dit (bijv. geen leesrecht op de module),
  // dan blijft de teller op 0 en verdwijnt het tabblad simpelweg uit beeld.
  const refreshInboxCount = () => {
    loadInboundOpenCount(organizationId).then(setInboxCount).catch(() => setInboxCount(0));
  };
  useEffect(refreshInboxCount, [organizationId]);

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

  // Alleen de vrije velden die als kolom gemarkeerd zijn; de rest zou de tabel
  // onleesbaar breed maken.
  const listFields = useMemo(
    () => activeFieldDefinitions(data.clientFieldDefinitions).filter(d => d.show_in_list),
    [data.clientFieldDefinitions],
  );

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
        <Button onClick={() => setImporting(true)} disabled={!canWrite}><Upload size={15} /> Importeren</Button>
        <Button variant="primary" onClick={onNew}>+ Nieuwe klant</Button>
      </div>
    </div>

    {importing && <CsvImportModal
      title="Klanten importeren"
      entityLabel="klanten"
      columns={CLIENT_IMPORT_COLUMNS}
      templateFilename="klanten-import-voorbeeld.csv"
      importRow={(record) => createClientWithServerCode(organizationId, { ...record, color: '#FFD966' }).then(() => undefined)}
      onClose={() => setImporting(false)}
      onDone={onChanged}
    />}

    <div className="client-tabs-bar" role="tablist">
      <button type="button" role="tab" aria-selected={listTab === 'clients'} className={listTab === 'clients' ? 'active' : ''} onClick={() => setListTab('clients')}>
        Klanten
      </button>
      <button type="button" role="tab" aria-selected={listTab === 'inbox'} className={listTab === 'inbox' ? 'active' : ''} onClick={() => setListTab('inbox')}>
        Niet gekoppeld
        {inboxCount > 0 && <span className="client-comm-unread-badge">{inboxCount}</span>}
      </button>
    </div>

    {listTab === 'inbox' && <InboundInboxTab
      organizationId={organizationId}
      clients={data.clients}
      canWrite={canWrite}
      onChanged={() => { refreshInboxCount(); onChanged(); }}
    />}

    {listTab === 'clients' && <>
      {rows.length === 0 && <div className="client-empty-state">
        <strong>Nog geen klanten</strong>
        <span>Maak je eerste klant aan om offertes, facturen, projecten en notities netjes te bundelen.</span>
        <Button variant="primary" onClick={onNew}>+ Nieuwe klant</Button>
      </div>}

      {rows.length > 0 && viewMode === 'cards' && <ClientCardGrid rows={rows} onOpen={onOpen} unreadByClient={unreadByClient} />}
      {rows.length > 0 && viewMode === 'table' && <ClientTable rows={rows} onOpen={onOpen} unreadByClient={unreadByClient} listFields={listFields} />}
    </>}
  </div>;
}

// Waarom een bericht niet vanzelf bij een klant belandde, in gewone taal.
const INBOUND_REASON_LABELS: Record<string, string> = {
  no_match: 'Afzender hoort niet bij een bekende klant',
  ambiguous: 'Meerdere klanten hebben dit e-mailadres',
  blocked: 'Afzender staat op je negeerlijst',
  alias_retiring: 'Binnengekomen op je oude doorstuuradres',
  no_forwarding_evidence: 'Rechtstreeks gestuurd, niet via je doorstuurregel',
  rate_limited: 'Ongewoon veel post tegelijk — even apart gezet',
  token_sender_mismatch: 'Antwoord kwam van iemand anders dan de klant',
  token_org_mismatch: 'Tegenstrijdige adressering',
  messageid_conflict: 'Zelfde kenmerk als een bericht dat er al staat',
  auto_generated: 'Automatisch gegenereerd bericht',
  autoresponder: 'Automatisch antwoord (afwezigheid)',
  bulk: 'Nieuwsbrief of bulkbericht',
  noreply_sender: 'Afzender is een no-reply-adres',
  tnef: 'Bijlage in Outlook-formaat (winmail.dat)',
  oversized: 'Bericht te groot om volledig te lezen',
  parse_error: 'Bericht kon niet gelezen worden',
};

/**
 * De opvangbak: post die binnenkwam maar niet eenduidig aan een klant te
 * koppelen was. Bewust géén eigen pagina in het zijmenu — meestal is deze lijst
 * leeg, en een lege pagina in het menu is alleen maar ruis.
 */
function InboundInboxTab({ organizationId, clients, canWrite, onChanged }: {
  organizationId: string;
  clients: Client[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [category, setCategory] = useState<InboundMessageCategory>('human');
  const [messages, setMessages] = useState<InboundMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aliasId, setAliasId] = useState<string | null>(null);
  const [hasAlias, setHasAlias] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    Promise.all([loadInboundMessages(organizationId, category), loadInboundAlias(organizationId)])
      .then(([rows, alias]) => {
        if (cancelled) return;
        setMessages(rows);
        setAliasId(alias?.id ?? null);
        setHasAlias(Boolean(alias));
        setLoaded(true);
      })
      .catch(err => { if (!cancelled) { setLoadError(err instanceof Error ? err.message : 'Opvangbak laden mislukt.'); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [organizationId, category]);

  function removeRow(id: string) {
    setMessages(prev => prev.filter(m => m.id !== id));
    onChanged();
  }

  return <div className="inbound-inbox">
    <div className="inbound-inbox-head">
      <div>
        <h3>Niet gekoppelde berichten</h3>
        <p className="settings-help">
          Post die op je doorstuuradres binnenkwam maar niet vanzelf bij een klant te plaatsen was.
          Koppel hem hier alsnog, of leg hem weg.
        </p>
      </div>
      <div className="client-view-toggle" role="group" aria-label="Soort berichten">
        <button type="button" className={category === 'human' ? 'active' : ''} onClick={() => setCategory('human')} aria-pressed={category === 'human'}>Persoonlijk</button>
        <button type="button" className={category === 'automated' ? 'active' : ''} onClick={() => setCategory('automated')} aria-pressed={category === 'automated'}>Automatisch</button>
      </div>
    </div>

    {!loaded && <div className="client-empty-line">Opvangbak laden…</div>}
    {loaded && loadError && <div className="error">{loadError}</div>}

    {loaded && !loadError && hasAlias === false && <div className="client-empty-state">
      <strong>Je hebt nog geen doorstuuradres</strong>
      <span>
        Stel er een in onder Instellingen → E-mail &amp; domeinen. Daarna komt mail die een klant rechtstreeks
        naar je eigen adres stuurt hier binnen als hij niet vanzelf te plaatsen is.
      </span>
    </div>}

    {loaded && !loadError && hasAlias !== false && messages.length === 0 && <div className="client-empty-state">
      <strong>Niets te doen</strong>
      <span>{category === 'human'
        ? 'Alle binnengekomen post is aan een klant gekoppeld.'
        : 'Geen automatische berichten in de wacht.'}</span>
    </div>}

    <div className="inbound-inbox-list">
      {messages.map(message => (
        <InboundInboxRow
          key={message.id}
          message={message}
          clients={clients}
          organizationId={organizationId}
          aliasId={aliasId}
          canWrite={canWrite}
          onDone={() => removeRow(message.id)}
        />
      ))}
    </div>
  </div>;
}

function InboundInboxRow({ message, clients, organizationId, aliasId, canWrite, onDone }: {
  message: InboundMessage;
  clients: Client[];
  organizationId: string;
  aliasId: string | null;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [clientId, setClientId] = useState<string>(message.suggested_client_id ?? '');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(() => [...clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [clients]);
  const snippet = (message.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  // Weergavenaam afkappen: die is vrij te kiezen door de afzender en een lange
  // naam kan het echte adres uit beeld duwen.
  const senderName = (message.sender_name ?? '').slice(0, 80);

  const daysLeft = message.purge_after
    ? Math.ceil((new Date(message.purge_after).getTime() - Date.now()) / 86400000)
    : null;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Actie mislukt.');
      setBusy(false);
    }
  }

  return <article className="inbound-row">
    <div className="inbound-row-head">
      <div className="inbound-row-sender">
        <strong>{senderName || message.sender_email || 'Onbekende afzender'}</strong>
        {senderName && message.sender_email && <span className="inbound-row-address">{message.sender_email}</span>}
      </div>
      <time>{formatEmailDateTime(message.received_at)}</time>
    </div>

    <div className="inbound-row-subject">{message.subject || '(geen onderwerp)'}</div>
    {snippet && <p className="inbound-row-snippet">{snippet}{snippet.length === 240 ? '…' : ''}</p>}

    {message.attachment_names.length > 0 && <p className="inbound-row-note">
      {message.attachment_names.length} bijlage{message.attachment_names.length === 1 ? '' : 'n'}: {message.attachment_names.join(', ')}
      {' — '}niet opgeslagen, die staan nog in je eigen postvak.
    </p>}

    {message.reason && <p className="inbound-row-reason">
      {INBOUND_REASON_LABELS[message.reason] ?? message.reason}
    </p>}

    {message.candidates.length > 1 && <div className="inbound-row-candidates">
      <span>Bedoelde je:</span>
      {message.candidates.map(candidate => (
        <Button key={candidate.client_id} onClick={() => setClientId(candidate.client_id)} disabled={busy}>
          {candidate.label}
        </Button>
      ))}
    </div>}

    {daysLeft != null && daysLeft <= 14 && <p className="inbound-row-note">
      Wordt over {daysLeft} dag{daysLeft === 1 ? '' : 'en'} automatisch opgeruimd.
    </p>}

    {error && <div className="error">{error}</div>}

    <div className="inbound-row-actions">
      <Select value={clientId} onChange={e => { setClientId(e.target.value); setError(null); }} disabled={!canWrite || busy}>
        <option value="">Kies een klant…</option>
        {sorted.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
      </Select>
      <Button
        variant="primary"
        disabled={!canWrite || busy || !clientId}
        onClick={() => act(() => linkInboundMessage(organizationId, message.id, clientId, remember))}
      >
        {busy ? 'Bezig…' : 'Koppelen'}
      </Button>
      <Button disabled={!canWrite || busy} onClick={() => act(() => setInboundMessageStatus(organizationId, message.id, 'dropped'))}>
        Negeren
      </Button>
      {aliasId && message.sender_email && <Button
        variant="danger"
        disabled={!canWrite || busy}
        onClick={() => {
          if (!window.confirm(`Post van ${message.sender_email} voortaan altijd negeren?`)) return;
          void act(async () => {
            await blockInboundSender(organizationId, aliasId, message.sender_email!);
            await setInboundMessageStatus(organizationId, message.id, 'dropped');
          });
        }}
      >
        Altijd negeren
      </Button>}
    </div>

    <label className="inbound-row-remember">
      <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} disabled={!canWrite || busy} />
      Onthoud dit adres bij deze klant, zodat volgende berichten vanzelf goed komen
    </label>
  </article>;
}

function ClientCardGrid({ rows, onOpen, unreadByClient }: { rows: ClientOverviewRow[]; onOpen: (client: Client) => void; unreadByClient: Record<string, number> }) {
  return <div className="clients-grid">
    {rows.map(row => {
      const { client } = row;
      const unread = unreadByClient[client.id] ?? 0;

      return <article className="client-card" key={client.id} onClick={() => onOpen(client)}>
        <div className="client-card-head">
          <div className="cc-avatar" style={{ background: client.color }}>{client.name.slice(0, 2).toUpperCase()}</div>
          {unread > 0 && <span className="client-alert unread"><Mail size={12} /> {unread} nieuw</span>}
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

function ClientTable({ rows, onOpen, unreadByClient, listFields }: {
  rows: ClientOverviewRow[];
  onOpen: (client: Client) => void;
  unreadByClient: Record<string, number>;
  listFields: ClientFieldDefinition[];
}) {
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
            {listFields.map(def => <th key={def.id}>{def.label}</th>)}
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
                  {(unreadByClient[client.id] ?? 0) > 0 && <span className="client-table-alert unread"><Mail size={11} /> {unreadByClient[client.id]} nieuw</span>}
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
              {listFields.map(def => (
                <td key={def.id}>{formatCustomFieldValue((client.custom_fields ?? {})[def.field_key], def) || '—'}</td>
              ))}
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
  organizationId,
  onChanged,
  onBack,
  onEditClient,
  onNewQuote,
  onEditQuote,
  onNewInvoice,
  onEditInvoice,
  onOpenProject,
  onNewNote,
  onEditNote,
  onNewDocument,
  onEditDocument,
  unreadCount,
  onUnreadChanged,
}: {
  data: AppData;
  client: Client;
  canWrite: boolean;
  organizationId: string;
  onChanged: () => void;
  onBack: () => void;
  onEditClient: () => void;
  onNewQuote: () => void;
  onEditQuote: (quote: Quote) => void;
  onNewInvoice: () => void;
  onEditInvoice: (invoice: Invoice) => void;
  onOpenProject: (project: Project) => void;
  onNewNote: (folderId?: string | null) => void;
  onEditNote: (note: Note) => void;
  onNewDocument: (folderId?: string | null) => void;
  onEditDocument: (doc: InternalDocument) => void;
  unreadCount: number;
  onUnreadChanged: () => void;
}) {
  const projects = data.projects.filter(project => project.client_id === client.id);
  const notes = getClientNotes(data, client.id);
  const documents = getClientDocuments(data, client.id);
  const quotes = getClientQuotes(data, client.id);
  const invoices = getClientInvoices(data, client.id);
  const openInvoices = invoices.filter(isInvoiceOpen);
  const overdueInvoices = invoices.filter(isInvoiceOverdue);
  const paidInvoices = invoices.filter(invoice => invoice.status === 'paid');
  const invoiceTotal = invoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0);
  const openInvoiceTotal = openInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0);
  const overdueInvoiceTotal = overdueInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0);
  const quoteTotal = quotes.reduce((sum, quote) => sum + total(quote.lines).total, 0);

  // Effectief uurtarief: echte gefactureerde omzet (excl. btw, zonder concepten
  // en geannuleerde facturen) gedeeld door alle geboekte uren op deze klant.
  const clientProjectIds = new Set(projects.map(project => project.id));
  const clientTrackedMinutes = data.timeEntries
    .filter(entry => entry.client_id === client.id || Boolean(entry.project_id && clientProjectIds.has(entry.project_id)))
    .reduce((sum, entry) => sum + entry.minutes, 0);
  const invoicedSubtotal = invoices
    .filter(invoice => !['draft', 'cancelled', 'void'].includes(invoice.status))
    .reduce((sum, invoice) => sum + total(invoice.lines).subtotal, 0);
  const effectiveRate = clientTrackedMinutes > 0 && invoicedSubtotal > 0 ? invoicedSubtotal / (clientTrackedMinutes / 60) : null;

  // Zoek/filter over het volledige klantdossier (projecten, offertes, facturen
  // en notities). De KPI's en facturatie-waarschuwing blijven het totaalbeeld
  // tonen; alleen de detaillijsten hieronder reageren op de filters.
  const [activeTab, setActiveTab] = useState<ClientTab>('overview');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const normalizedQuery = clientSearchNormalize(query.trim());

  // Contracten staan niet in de centrale AppData; laad ze hier per klant.
  const [contracts, setContracts] = useState<Contract[]>([]);
  useEffect(() => {
    let cancelled = false;
    void supabase.from('contracts').select('*')
      .eq('organization_id', organizationId).eq('client_id', client.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (!cancelled) setContracts((data ?? []) as Contract[]); });
    return () => { cancelled = true; };
  }, [organizationId, client.id]);

  const filteredProjects = useMemo(
    () => projects.filter(project => projectMatchesQuery(project, normalizedQuery)),
    [projects, normalizedQuery],
  );
  const filteredQuotes = useMemo(
    () => quotes.filter(quote => quoteMatchesQuery(quote, normalizedQuery) && quoteMatchesStatus(quote, statusFilter)),
    [quotes, normalizedQuery, statusFilter],
  );
  const filteredInvoices = useMemo(
    () => invoices.filter(invoice => invoiceMatchesQuery(invoice, normalizedQuery) && invoiceMatchesStatus(invoice, statusFilter)),
    [invoices, normalizedQuery, statusFilter],
  );
  const switchTab = (tab: ClientTab) => {
    setActiveTab(tab);
    setQuery('');
    setStatusFilter('');
  };

  const activeFilterCount = (normalizedQuery ? 1 : 0) + (statusFilter ? 1 : 0);
  const resetFilters = () => { setQuery(''); setStatusFilter(''); };

  const tabs: Array<{ id: ClientTab; label: string; count: number; unread?: boolean }> = [
    { id: 'overview', label: 'Overzicht', count: 0 },
    { id: 'projects', label: 'Projecten', count: projects.length },
    { id: 'quotes', label: 'Offertes', count: quotes.length },
    { id: 'contracts', label: 'Contracten', count: contracts.length },
    { id: 'invoices', label: 'Facturen', count: invoices.length },
    { id: 'files', label: 'Bestanden', count: notes.length + documents.length },
    { id: 'communication', label: 'Communicatie', count: unreadCount, unread: true },
  ];

  return <div className="client-detail-page">
    <section className="client-detail-hero">
      <div className="client-detail-title">
        <Button onClick={onBack}>← Terug naar klanten</Button>
        <div className="client-title-row">
          <div className="client-hero-avatar" style={{ background: client.color }}>{client.name.slice(0, 2).toUpperCase()}</div>
          <div>
            <h2>{client.name}</h2>
            <div className="client-hero-meta">
              <span className={`client-status-pill ${client.status}`}>{clientStatusLabels[client.status] ?? client.status}</span>
              {client.client_code && <span className="client-hero-code">{client.client_code}</span>}
            </div>
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
      <ClientKpi label="Offertes" value={quotes.length} sub={euro(quoteTotal)} onClick={() => switchTab('quotes')} />
      <ClientKpi label="Facturen" value={invoices.length} sub={euro(invoiceTotal)} onClick={() => switchTab('invoices')} />
      <ClientKpi label="Openstaand" value={openInvoices.length} sub={euro(openInvoiceTotal)} tone={openInvoices.length ? 'warning' : undefined} onClick={() => switchTab('invoices')} />
      <ClientKpi label="Vervallen" value={overdueInvoices.length} sub={euro(overdueInvoiceTotal)} tone={overdueInvoices.length ? 'danger' : undefined} onClick={() => switchTab('invoices')} />
      <ClientKpi label="Betaald" value={paidInvoices.length} sub={euro(paidInvoices.reduce((sum, invoice) => sum + total(invoice.lines).total, 0))} tone="success" onClick={() => switchTab('invoices')} />
      <ClientKpi label="Uren" value={Math.round(minutesToHours(clientTrackedMinutes))} sub={effectiveRate != null ? `Effectief ${euro(effectiveRate)}/u` : clientTrackedMinutes > 0 ? formatMinutes(clientTrackedMinutes) : 'Geen uren geboekt'} onClick={() => switchTab('projects')} />
    </section>

    <div className="client-tabs-bar" role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          className={`client-tab-btn${activeTab === tab.id ? ' active' : ''}`}
          onClick={() => switchTab(tab.id)}
        >
          {tab.label}
          {tab.count > 0 && <span className={`client-tab-badge${tab.unread ? ' unread' : ''}`}>{tab.count}</span>}
        </button>
      ))}
    </div>

    {activeTab !== 'overview' && activeTab !== 'files' && activeTab !== 'communication' && <div className="client-tab-search">
      <label className="client-tab-search-field">
        <Search size={14} />
        <input
          className="client-tab-search-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={`Zoek in ${tabs.find(t => t.id === activeTab)?.label.toLowerCase() ?? 'dossier'}…`}
          autoComplete="off"
        />
      </label>
      {(activeTab === 'quotes' || activeTab === 'invoices') && (
        <Select className="form-select client-tab-status-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">Alle statussen</option>
          {clientStatusFilterOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </Select>
      )}
      {activeFilterCount > 0 && (
        <button type="button" className="client-tab-reset" onClick={resetFilters}>
          <RotateCcw size={13} /> Wissen
        </button>
      )}
    </div>}

    {activeTab === 'overview' && <div className="client-overview-layout">
      <aside className="client-overview-sidebar">
        <article className="client-panel">
          <div className="client-panel-head"><h3>Klantgegevens</h3></div>
          <dl className="client-info-list">
            <div><dt>Contactpersoon</dt><dd>{client.contact_name || '—'}</dd></div>
            <div><dt>E-mail</dt><dd>{client.email || '—'}</dd></div>
            <div><dt>Telefoon</dt><dd>{client.phone || '—'}</dd></div>
            <div><dt>Adres</dt><dd>{[client.address_line1, client.address_line2, [client.postal_code, client.city].filter(Boolean).join(' '), client.country].filter(Boolean).join(', ') || '—'}</dd></div>
            <div><dt>Btw-nummer</dt><dd>{client.vat_number || '—'}</dd></div>
            <div><dt>KVK</dt><dd>{client.kvk_number || '—'}</dd></div>
            <div><dt>Waarde</dt><dd>{euro(client.value_eur)}</dd></div>
            {activeFieldDefinitions(data.clientFieldDefinitions).map(def => (
              <div key={def.id}>
                <dt>{def.label}</dt>
                <dd>{formatCustomFieldValue((client.custom_fields ?? {})[def.field_key], def) || '—'}</dd>
              </div>
            ))}
            <div><dt>Aangemaakt</dt><dd>{dateNL(client.created_at)}</dd></div>
            <div><dt>Bijgewerkt</dt><dd>{dateNL(client.updated_at)}</dd></div>
            <div><dt>Klantportaal</dt><dd>{client.email
              ? <a className="client-portal-access-link" href="/portal" target="_blank" rel="noopener noreferrer">Inloggen via /portal</a>
              : <span className="client-portal-access-hint">E-mailadres nodig om in te loggen</span>}</dd></div>
          </dl>
          {client.notes && <p className="client-inline-notes">{client.notes}</p>}
          <div className="cd-tags">{client.tags?.map(tag => <span className="cd-tag" key={tag}>{tag}</span>)}</div>
        </article>

        <ClientContacts data={data} client={client} organizationId={organizationId} canWrite={canWrite} onChanged={onChanged} />

        <article className="client-panel">
          <div className="client-panel-head">
            <h3>Projecten</h3>
            <div className="client-panel-head-right">
              <span>{projects.length}</span>
              {projects.length > 0 && <button type="button" className="client-overview-more-btn" onClick={() => switchTab('projects')}>Bekijk alle →</button>}
            </div>
          </div>
          <div className="client-project-list">
            {projects.length === 0 && <div className="client-empty-line">Nog geen projecten gekoppeld.</div>}
            {projects.slice(0, 6).map(project => <button key={project.id} type="button" className="client-project-row" onClick={() => onOpenProject(project)}>
              <span className="client-project-dot" style={{ background: project.color }} />
              <span>{project.name}</span>
              {project.archived && <em>Gearchiveerd</em>}
            </button>)}
            {projects.length > 6 && <button type="button" className="client-overview-more-link" onClick={() => switchTab('projects')}>+{projects.length - 6} meer projecten</button>}
          </div>
        </article>
      </aside>

      <div className="client-overview-main">
        <article className="client-panel">
          <div className="client-panel-head">
            <h3>Recente offertes</h3>
            <button type="button" className="client-overview-more-btn" onClick={() => switchTab('quotes')}>
              Alle {quotes.length} offertes →
            </button>
          </div>
          <div className="client-finance-list">
            {quotes.length === 0 && <div className="client-empty-line">Nog geen offertes voor deze klant.</div>}
            {quotes.slice(0, 4).map(quote => {
              const amount = total(quote.lines).total;
              const statusLabel = quoteStatusLabels[quote.status] ?? quote.status;
              return <button key={quote.id} type="button" className="client-finance-row" onClick={() => onEditQuote(quote)}>
                <span className="client-finance-number">{quote.number}</span>
                <span className="client-finance-meta">{dateNL(quote.date)} · Geldig tot {dateNL((quote as Quote).valid_until)}</span>
                <span className="client-finance-amount">{euro(amount)}</span>
                <span className={`client-finance-status ${quote.status}`}>{statusLabel}</span>
              </button>;
            })}
            {quotes.length > 4 && <button type="button" className="client-overview-more-link" onClick={() => switchTab('quotes')}>+{quotes.length - 4} meer offertes bekijken</button>}
          </div>
        </article>

        <article className="client-panel">
          <div className="client-panel-head">
            <h3>Recente facturen</h3>
            <button type="button" className="client-overview-more-btn" onClick={() => switchTab('invoices')}>
              Alle {invoices.length} facturen →
            </button>
          </div>
          <div className="client-finance-list">
            {invoices.length === 0 && <div className="client-empty-line">Nog geen facturen voor deze klant.</div>}
            {invoices.slice(0, 4).map(invoice => {
              const overdue = isInvoiceOverdue(invoice);
              const amount = total(invoice.lines).total;
              const statusLabel = invoiceStatusLabels[invoice.status] ?? invoice.status;
              return <button key={invoice.id} type="button" className={`client-finance-row ${overdue ? 'is-overdue' : ''}`} onClick={() => onEditInvoice(invoice)}>
                <span className="client-finance-number">{invoice.number}</span>
                <span className="client-finance-meta">{dateNL(invoice.date)} · Vervalt {dateNL(invoice.due_date)}</span>
                <span className="client-finance-amount">{euro(amount)}</span>
                <span className={`client-finance-status ${overdue ? 'overdue' : invoice.status}`}>{overdue ? 'Vervallen' : statusLabel}</span>
              </button>;
            })}
            {invoices.length > 4 && <button type="button" className="client-overview-more-link" onClick={() => switchTab('invoices')}>+{invoices.length - 4} meer facturen bekijken</button>}
          </div>
        </article>
      </div>
    </div>}

    {activeTab === 'projects' && <article className="client-panel">
      <div className="client-panel-head"><h3>Projecten</h3><span>{filteredProjects.length}</span></div>
      <div className="client-project-list">
        {filteredProjects.length === 0 && <div className="client-empty-line">{projects.length === 0 ? 'Nog geen projecten gekoppeld.' : 'Geen projecten voor deze zoekopdracht.'}</div>}
        {filteredProjects.map(project => <button key={project.id} type="button" className="client-project-row" onClick={() => onOpenProject(project)}>
          <span className="client-project-dot" style={{ background: project.color }} />
          <span>{project.name}</span>
          {project.archived && <em>Gearchiveerd</em>}
        </button>)}
      </div>
    </article>}

    {activeTab === 'quotes' && <FinancePanel
      title="Offertes"
      emptyText={quotes.length === 0 ? 'Nog geen offertes voor deze klant.' : 'Geen offertes voor deze zoekopdracht of filter.'}
      items={filteredQuotes}
      kind="quote"
      onEdit={onEditQuote}
    />}

    {activeTab === 'invoices' && <FinancePanel
      title="Facturen"
      emptyText={invoices.length === 0 ? 'Nog geen facturen voor deze klant.' : 'Geen facturen voor deze zoekopdracht of filter.'}
      items={filteredInvoices}
      kind="invoice"
      onEdit={onEditInvoice}
    />}

    {activeTab === 'contracts' && <ClientContractsCard contracts={contracts} organizationId={organizationId} />}

    {activeTab === 'communication' && <ClientCommunication client={client} organizationId={organizationId} canWrite={canWrite} onUnreadChanged={onUnreadChanged} />}
    {activeTab === 'files' && <ClientFolders
      data={data}
      client={client}
      canWrite={canWrite}
      organizationId={organizationId}
      onChanged={onChanged}
      onNewNote={onNewNote}
      onEditNote={onEditNote}
      onNewDocument={onNewDocument}
      onEditDocument={onEditDocument}
    />}
  </div>;
}

function ClientKpi({ label, value, sub, tone, onClick }: { label: string; value: number; sub: string; tone?: 'warning' | 'danger' | 'success'; onClick?: () => void }) {
  return <button type="button" className={`client-kpi${tone ? ` ${tone}` : ''}${onClick ? ' is-clickable' : ''}`} onClick={onClick}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{sub}</small>
  </button>;
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

const CLIENT_EMAIL_STATUS_LABELS: Record<ClientEmailStatus, string> = {
  queued: 'In wachtrij',
  sent: 'Verzonden',
  delivered: 'Afgeleverd',
  opened: 'Geopend',
  clicked: 'Link geklikt',
  bounced: 'Gebounced',
  failed: 'Mislukt',
  complained: 'Spam-klacht',
  received: 'Ontvangen',
};

function clientEmailStatusTone(status: ClientEmailStatus): string {
  if (status === 'delivered' || status === 'opened' || status === 'clicked') return 'success';
  if (status === 'bounced' || status === 'failed' || status === 'complained') return 'danger';
  if (status === 'received') return 'inbound';
  return 'neutral';
}

function formatEmailDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * Waarom staat dit binnengekomen bericht in dít dossier? Bij mail die via het
 * doorstuuradres komt is dat een gok van het systeem, en dan hoor je te zien
 * waaróp die gok gebaseerd is.
 */
function inboundOriginLabel(msg: ClientEmail): string | null {
  const viaAlias = (msg.metadata as { inbound_route?: string } | null)?.inbound_route === 'alias';
  switch (msg.link_source) {
    case 'client_email': return viaAlias ? 'Binnengekomen via je doorstuuradres, herkend op het e-mailadres' : 'Automatisch gekoppeld op e-mailadres';
    case 'client_contact': return viaAlias ? 'Binnengekomen via je doorstuuradres, herkend op een contactpersoon' : 'Automatisch gekoppeld op een contactpersoon';
    case 'manual': return 'Handmatig gekoppeld vanuit de opvangbak';
    case 'header_thread': return 'Gekoppeld aan een lopend gesprek';
    case 'reply_token': return null; // antwoord op onze eigen mail: vanzelfsprekend
    default: return viaAlias ? 'Binnengekomen via je doorstuuradres' : null;
  }
}

function ClientCommunication({ client, organizationId, canWrite, onUnreadChanged }: { client: Client; organizationId: string; canWrite: boolean; onUnreadChanged?: () => void }) {
  const [threads, setThreads] = useState<ClientEmailThread[]>([]);
  const [emails, setEmails] = useState<ClientEmail[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  /** Wie er straks als afzender komt te staan; null zolang we het nog niet weten. */
  const [sender, setSender] = useState<EffectiveSender | null>(null);

  const recipient = (client.email ?? '').trim();
  const hasRecipient = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
  const bodyText = body.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  const canSend = canWrite && hasRecipient && subject.trim().length > 0 && bodyText.length > 0 && !sending;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    Promise.all([
      loadClientEmailThreads(organizationId, client.id),
      loadClientEmails(organizationId, client.id),
      loadClientEmailReadIds(organizationId, client.id),
    ])
      .then(([loadedThreads, loadedEmails, loadedReadIds]) => { if (!cancelled) { setThreads(loadedThreads); setEmails(loadedEmails); setReadIds(loadedReadIds); setLoaded(true); } })
      .catch(err => { if (!cancelled) { setLoadError(err instanceof Error ? err.message : 'Communicatie laden mislukt.'); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [organizationId, client.id]);

  // Het afzenderadres hangt aan de organisatie, niet aan de klant — één keer
  // ophalen per organisatie volstaat. Mislukt het, dan tonen we simpelweg niets:
  // het is toelichting bij het formulier, geen voorwaarde om te kunnen mailen.
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSendingDomains(organizationId), loadMySenderIdentity(organizationId)])
      .then(([domains, identity]) => { if (!cancelled) setSender(resolveEffectiveSender(domains, identity)); })
      .catch(() => { if (!cancelled) setSender(null); });
    return () => { cancelled = true; };
  }, [organizationId]);

  async function reload() {
    const [loadedThreads, loadedEmails, loadedReadIds] = await Promise.all([
      loadClientEmailThreads(organizationId, client.id),
      loadClientEmails(organizationId, client.id),
      loadClientEmailReadIds(organizationId, client.id),
    ]);
    setThreads(loadedThreads);
    setEmails(loadedEmails);
    setReadIds(loadedReadIds);
  }

  // Optie A brengt post van niet-klanten binnen; zonder wisrecht zou een fout
  // gekoppeld bericht voorgoed in het dossier blijven staan. Soft delete: de
  // rij blijft bestaan maar valt buiten de RLS-policy.
  async function removeMessage(clientEmailId: string) {
    if (!window.confirm('Dit bericht uit het klantdossier halen? Het verdwijnt uit het gesprek.')) return;
    try {
      await deleteClientEmail(organizationId, clientEmailId);
      await reload();
      onUnreadChanged?.();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Verwijderen mislukt.');
    }
  }

  async function send() {
    if (!canSend) return;
    setSending(true); setSendError(null); setSendMessage(null);
    try {
      const result = await sendClientEmail(organizationId, { clientId: client.id, subject: subject.trim(), bodyHtml: body });
      setSubject(''); setBody('');
      setSendMessage(`E-mail verzonden naar ${result.recipientEmail}.`);
      await reload();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'E-mail versturen mislukt.');
    } finally {
      setSending(false);
    }
  }

  const emailsByThread = useMemo(() => {
    const map = new Map<string, ClientEmail[]>();
    for (const email of emails) {
      const list = map.get(email.thread_id) ?? [];
      list.push(email);
      map.set(email.thread_id, list);
    }
    return map;
  }, [emails]);

  async function toggleThread(threadId: string) {
    const willExpand = !expandedThreads.has(threadId);
    setExpandedThreads(prev => {
      const next = new Set(prev);
      if (willExpand) next.add(threadId); else next.delete(threadId);
      return next;
    });
    if (!willExpand) return;
    // Openen = lezen: markeer de ongelezen inkomende berichten van deze thread als
    // gelezen voor de huidige gebruiker. Optimistisch lokaal, dan server + badge.
    const unreadIds = (emailsByThread.get(threadId) ?? [])
      .filter(msg => msg.direction === 'inbound' && !readIds.has(msg.id))
      .map(msg => msg.id);
    if (unreadIds.length === 0) return;
    setReadIds(prev => { const next = new Set(prev); unreadIds.forEach(id => next.add(id)); return next; });
    try {
      await markClientEmailsRead(organizationId, client.id, unreadIds);
      onUnreadChanged?.();
    } catch {
      // Bij een fout de lokale markering terugdraaien zodat de UI de serverwaarheid
      // blijft volgen (de 'nieuw'-badge komt dan gewoon terug).
      setReadIds(prev => { const next = new Set(prev); unreadIds.forEach(id => next.delete(id)); return next; });
    }
  }

  return <div className="client-comm">
    <article className="client-panel client-comm-compose">
      <div className="client-panel-head"><h3>Nieuwe e-mail</h3></div>
      {!hasRecipient
        ? <div className="client-empty-line">Deze klant heeft geen e-mailadres. Vul er een in bij de klantgegevens om te kunnen mailen.</div>
        : <>
          <p className="client-comm-to">Aan: <strong>{recipient}</strong></p>
          {sender && (sender.fallback
            ? <p className="client-comm-from is-fallback">
                Afzender: het algemene ResoFly-adres. Wil je dat de klant <em>jouw</em> naam en adres ziet?
                Voeg je eigen domein toe onder <strong>Instellingen → E-mail &amp; domeinen</strong> en zet de
                DNS-records klaar; daarna vertrekt deze mail vanaf je eigen adres.
              </p>
            : <p className="client-comm-from">
                Van: <strong>{sender.name ? `${sender.name} <${sender.email}>` : sender.email}</strong>
              </p>)}
          <label className="client-comm-field">Onderwerp
            <Input value={subject} onChange={e => { setSubject(e.target.value); setSendError(null); setSendMessage(null); }} placeholder="Onderwerp van je e-mail" disabled={!canWrite || sending} />
          </label>
          <div className="client-comm-field">Bericht
            <RichTextEditor value={body} onChange={setBody} placeholder="Schrijf je bericht…" disabled={!canWrite || sending} />
          </div>
          {sendMessage && <div className="success">{sendMessage}</div>}
          {sendError && <div className="error">{sendError}</div>}
          <div className="client-comm-actions">
            <Button variant="primary" onClick={send} disabled={!canSend}>{sending ? 'Versturen…' : 'Verstuur e-mail'}</Button>
          </div>
          {!canWrite && <p className="client-empty-line">Je hebt geen schrijfrechten om e-mails te versturen.</p>}
        </>}
    </article>

    <article className="client-panel">
      <div className="client-panel-head"><h3>Verzonden &amp; ontvangen</h3><span>{threads.length}</span></div>
      {!loaded && <div className="client-empty-line">Communicatie laden…</div>}
      {loaded && loadError && <div className="error">{loadError}</div>}
      {loaded && !loadError && threads.length === 0 && <div className="client-empty-line">Nog geen e-mails met deze klant.</div>}
      <div className="client-comm-threads">
        {threads.map(thread => {
          const msgs = emailsByThread.get(thread.id) ?? [];
          const unreadCount = msgs.filter(msg => msg.direction === 'inbound' && !readIds.has(msg.id)).length;
          const isOpen = expandedThreads.has(thread.id);
          return <div className={`client-comm-thread${unreadCount > 0 ? ' has-unread' : ''}${isOpen ? ' open' : ''}`} key={thread.id}>
            <button type="button" className="client-comm-thread-head" onClick={() => toggleThread(thread.id)} aria-expanded={isOpen}>
              <span className="client-comm-thread-caret" aria-hidden="true">{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
              <span className="client-comm-thread-title">
                <strong>{thread.subject || '(geen onderwerp)'}</strong>
                <span className="client-comm-thread-preview">{msgs.length} bericht{msgs.length === 1 ? '' : 'en'}</span>
              </span>
              {unreadCount > 0 && <span className="client-comm-unread-badge">{unreadCount} nieuw</span>}
              <time className="client-comm-thread-time">{formatEmailDateTime(thread.last_message_at)}</time>
            </button>
            {isOpen && <div className="client-comm-messages">
              {msgs.map(msg => {
                const isUnread = msg.direction === 'inbound' && !readIds.has(msg.id);
                return <div className={`client-comm-message ${msg.direction}${isUnread ? ' unread' : ''}`} key={msg.id}>
                  <div className="client-comm-message-meta">
                    <span className="client-comm-dir">{msg.direction === 'outbound' ? 'Uitgaand' : 'Inkomend'}</span>
                    <span className={`client-comm-status ${clientEmailStatusTone(msg.status)}`}>{CLIENT_EMAIL_STATUS_LABELS[msg.status] ?? msg.status}</span>
                    <time>{formatEmailDateTime(msg.created_at)}</time>
                  </div>
                  <div className="client-comm-message-from">
                    {msg.direction === 'outbound'
                      ? `${msg.from_email} → ${msg.to_email}`
                      /* Weergavenaam afgekapt: die is vrij te kiezen door de afzender. */
                      : `Van ${(msg.from_name ?? '').slice(0, 80) ? `${(msg.from_name ?? '').slice(0, 80)} <${msg.from_email}>` : msg.from_email}`}
                  </div>
                  {msg.direction === 'inbound' && inboundOriginLabel(msg) && (
                    <div className="client-comm-origin">{inboundOriginLabel(msg)}</div>
                  )}
                  {msg.body_html
                    ? <div className="client-comm-body" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msg.body_html) }} />
                    : <div className="client-comm-body client-comm-body-plain">{msg.body_text}</div>}
                  {msg.error_message && <div className="client-comm-error">{msg.error_message}</div>}
                  {canWrite && msg.direction === 'inbound' && <div className="client-comm-message-actions">
                    <button
                      type="button"
                      className="client-comm-remove"
                      onClick={() => void removeMessage(msg.id)}
                      title="Haal dit bericht uit het klantdossier"
                    >
                      Verwijderen
                    </button>
                  </div>}
                </div>;
              })}
            </div>}
          </div>;
        })}
      </div>
    </article>
  </div>;
}

function getClientProjectIds(data: AppData, clientId: string) {
  return new Set(data.projects.filter(project => project.client_id === clientId).map(project => project.id));
}

function ClientContractsCard({ contracts, organizationId }: { contracts: Contract[]; organizationId: string }) {
  return <article className="client-panel">
    <div className="client-panel-head"><h3>Contracten</h3><span>{contracts.length}</span></div>
    {contracts.length === 0
      ? <div className="client-empty-line">Nog geen contracten voor deze klant. Maak ze aan onder Financiën → Contracten.</div>
      : <div className="client-contract-list">
          {contracts.map(c => <ClientContractRow key={c.id} contract={c} organizationId={organizationId} />)}
        </div>}
  </article>;
}

function ClientContractRow({ contract, organizationId }: { contract: Contract; organizationId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('contract-workflow', {
        body: { action: 'downloadContractPdf', organizationId, contractId: contract.id },
      });
      if (error) {
        const context = (error as { context?: unknown })?.context;
        let detail = error instanceof Error ? error.message : 'Downloaden mislukt';
        if (context instanceof Response) {
          const payload = await context.clone().json().catch(() => null) as { error?: string } | null;
          if (payload?.error) detail = payload.error;
        }
        throw new Error(detail);
      }
      if (!data?.ok) throw new Error(data?.error || 'Downloaden mislukt');
      const bytes = Uint8Array.from(atob(data.pdf.base64), ch => ch.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = data.pdf.fileName || `contract-${contract.number}.pdf`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : 'Downloaden mislukt'); }
    finally { setBusy(false); }
  }

  return <div className="client-contract-row" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #2a2a31' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <strong>{contract.number}</strong>{contract.title ? ` · ${contract.title}` : ''}
      <div className="bk-muted" style={{ fontSize: 13 }}>{dateNL(contract.date)}{contract.signed_at ? ` · getekend ${dateNL(contract.signed_at)}` : ''}</div>
      {error && <div className="error">{error}</div>}
    </div>
    <ContractStatusBadge status={contract.status} />
    {contract.status === 'signed' && <Button onClick={download} disabled={busy}>{busy ? 'PDF…' : 'PDF'}</Button>}
  </div>;
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

function getClientDocuments(data: AppData, clientId: string) {
  const projectIds = getClientProjectIds(data, clientId);
  return data.documents.filter(doc => doc.client_id === clientId || Boolean(doc.project_id && projectIds.has(doc.project_id)));
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

// ── Zoeken/filteren op de klantdetailpagina ────────────────────────────
type ClientTab = 'overview' | 'projects' | 'quotes' | 'contracts' | 'invoices' | 'files' | 'communication';

// Statussen die zowel op offertes als facturen slaan staan zonder suffix; de
// finance- of offerte-specifieke statussen krijgen een suffix zodat duidelijk is
// welke sectie ze versmallen. Niet-relevante secties worden er niet door verborgen.
const clientStatusFilterOptions: Array<{ value: string; label: string }> = [
  { value: 'draft', label: 'Concept' },
  { value: 'sent', label: 'Verzonden' },
  { value: 'open', label: 'Openstaand · facturen' },
  { value: 'overdue', label: 'Vervallen · facturen' },
  { value: 'paid', label: 'Betaald · facturen' },
  { value: 'accepted', label: 'Geaccepteerd · offertes' },
  { value: 'rejected', label: 'Afgewezen · offertes' },
];

function clientSearchNormalize(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function projectMatchesQuery(project: Project, query: string): boolean {
  if (!query) return true;
  return [project.name, project.description, project.archived ? 'gearchiveerd' : '']
    .map(clientSearchNormalize).join(' ').includes(query);
}

function quoteMatchesQuery(quote: Quote, query: string): boolean {
  if (!query) return true;
  return [quote.number, quoteStatusLabels[quote.status] ?? quote.status, quote.notes, euro(total(quote.lines).total), dateNL(quote.date)]
    .map(clientSearchNormalize).join(' ').includes(query);
}

function invoiceMatchesQuery(invoice: Invoice, query: string): boolean {
  if (!query) return true;
  return [invoice.number, invoiceStatusLabels[invoice.status] ?? invoice.status, isInvoiceOverdue(invoice) ? 'vervallen' : '', invoice.notes, euro(total(invoice.lines).total), dateNL(invoice.date), dateNL(invoice.due_date)]
    .map(clientSearchNormalize).join(' ').includes(query);
}

function quoteMatchesStatus(quote: Quote, status: string): boolean {
  switch (status) {
    case 'draft': return quote.status === 'draft';
    case 'sent': return quote.status === 'sent';
    case 'accepted': return quote.status === 'accepted';
    case 'rejected': return quote.status === 'rejected';
    // Lege keuze of een factuur-specifieke status laat offertes ongemoeid.
    default: return true;
  }
}

function invoiceMatchesStatus(invoice: Invoice, status: string): boolean {
  switch (status) {
    case 'draft': return invoice.status === 'draft';
    case 'sent': return invoice.status === 'sent';
    case 'open': return isInvoiceOpen(invoice);
    case 'overdue': return isInvoiceOverdue(invoice);
    case 'paid': return invoice.status === 'paid';
    // Lege keuze of een offerte-specifieke status laat facturen ongemoeid.
    default: return true;
  }
}
