import { useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, List, RotateCcw, Search, SlidersHorizontal, Table as TableIcon } from 'lucide-react';
import type { AppData, Priority, Ticket, TicketStatus } from '../types';
import { Button, Select } from '../components/Ui';
import { dateNL, priorityLabel } from '../lib/format';

const convertibleStatuses = new Set<TicketStatus>(['new', 'review', 'approved']);
// "Openstaand" = nog actief te behandelen (dus niet afgewezen en niet omgezet).
const openStatuses = new Set<TicketStatus>(['new', 'review', 'approved']);

const STATUS_ORDER: TicketStatus[] = ['new', 'review', 'approved', 'rejected', 'converted'];
const ticketStatusLabels: Record<TicketStatus, string> = {
  new: 'Nieuw', review: 'Review', approved: 'Goedgekeurd', rejected: 'Geweigerd', converted: 'Omgezet',
};
const priorityRank: Record<Priority, number> = { high: 3, med: 2, low: 1 };

const VIEW_STORAGE_KEY = 'resofly.tickets.view';
type TicketView = 'list' | 'table';
function readStoredView(): TicketView {
  try { return localStorage.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'list'; } catch { return 'list'; }
}
function persistView(view: TicketView) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* private mode / storage disabled */ }
}

/* ── Snelfilters ───────────────────────────────────────────────────────────
 * Eén tik in plaats van drie dropdowns. Het zijn échte checkboxes (met de
 * spatiebalk aan te vinken, door een schermlezer aan te kondigen) die als
 * chip getekend zijn. Meerdere vinkjes stapelen: ze moeten állemaal kloppen
 * (EN, geen OF) — "openstaand én hoge prioriteit" is de vraag die je stelt. */
type QuickFilterKey = 'open' | 'unread' | 'high' | 'convertible' | 'noClient';
type QuickFilterDef = {
  key: QuickFilterKey;
  label: string;
  title: string;
  match: (ticket: Ticket, unread: Set<string>) => boolean;
};
const QUICK_FILTERS: QuickFilterDef[] = [
  { key: 'open', label: 'Openstaand', title: 'Alleen tickets die nog behandeld moeten worden', match: ticket => openStatuses.has(ticket.status) },
  { key: 'unread', label: 'Ongelezen', title: 'Alleen tickets met iets nieuws dat je nog niet gezien hebt', match: (ticket, unread) => unread.has(ticket.id) },
  { key: 'high', label: 'Hoge prioriteit', title: 'Alleen tickets met prioriteit hoog', match: ticket => ticket.priority === 'high' },
  { key: 'convertible', label: 'Om te zetten', title: 'Alleen tickets die je nog naar een project kunt omzetten', match: ticket => convertibleStatuses.has(ticket.status) && !ticket.converted_to_project_id },
  { key: 'noClient', label: 'Zonder klant', title: 'Alleen tickets die nog aan geen enkele klant hangen', match: ticket => !ticket.client_id },
];

type TicketFilters = { query: string; status: string; priority: string; clientId: string; quick: QuickFilterKey[] };
const emptyTicketFilters: TicketFilters = { query: '', status: '', priority: '', clientId: '', quick: [] };
function countActiveFilters(filters: TicketFilters): number {
  const text = [filters.query, filters.status, filters.priority, filters.clientId].filter(value => value.trim() !== '').length;
  return text + filters.quick.length;
}

type SortKey = 'title' | 'client' | 'priority' | 'status' | 'created';
type SortState = { key: SortKey; dir: 'asc' | 'desc' };

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('nl-NL')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTicketSearchText(ticket: Ticket, data: AppData): string {
  const client = data.clients.find(c => c.id === ticket.client_id) ?? null;
  const parts = [
    ticket.title,
    ticket.description,
    ticket.notes,
    ticketStatusLabels[ticket.status],
    priorityLabel(ticket.priority),
    client?.name,
    client?.client_code,
    dateNL(ticket.created_at),
  ];
  return normalize(parts.filter(part => part !== null && part !== undefined).join(' '));
}

function filterTickets(data: AppData, filters: TicketFilters, unread: Set<string>): Ticket[] {
  const query = normalize(filters.query);
  const quick = QUICK_FILTERS.filter(def => filters.quick.includes(def.key));
  return data.tickets.filter(ticket => {
    if (filters.clientId && ticket.client_id !== filters.clientId) return false;
    if (filters.priority && ticket.priority !== filters.priority) return false;
    if (filters.status === 'open') {
      if (!openStatuses.has(ticket.status)) return false;
    } else if (filters.status && ticket.status !== filters.status) return false;
    for (const def of quick) if (!def.match(ticket, unread)) return false;
    if (!query) return true;
    return buildTicketSearchText(ticket, data).includes(query);
  });
}

function sortTickets(tickets: Ticket[], data: AppData, sort: SortState): Ticket[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const clientName = (ticket: Ticket) => data.clients.find(c => c.id === ticket.client_id)?.name ?? '';
  return [...tickets].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case 'title': cmp = a.title.localeCompare(b.title, 'nl-NL'); break;
      case 'client': cmp = clientName(a).localeCompare(clientName(b), 'nl-NL'); break;
      case 'priority': cmp = priorityRank[a.priority] - priorityRank[b.priority]; break;
      case 'status': cmp = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status); break;
      case 'created': cmp = (a.created_at || '').localeCompare(b.created_at || ''); break;
    }
    // Stabiele secundaire sortering op aanmaakdatum zodat gelijke waarden vaste volgorde houden.
    if (cmp === 0) cmp = (a.created_at || '').localeCompare(b.created_at || '');
    return cmp * dir;
  });
}

export function Tickets({ data, onNew, onEdit, onConvert, unreadTicketIds }: { data: AppData; onNew: () => void; onEdit: (t: Ticket) => void; onConvert: (t: Ticket) => void; unreadTicketIds: Set<string> }) {
  const [view, setView] = useState<TicketView>(() => readStoredView());
  const [filters, setFilters] = useState<TicketFilters>(emptyTicketFilters);
  // Filteren gebeurt hier en niet in de tabel, zodat hetzelfde filter ook in de
  // lijstweergave werkt en een klik op een statuskaart je niet meer naar de
  // tabel hoeft te duwen om iets te doen.
  const visible = useMemo(() => filterTickets(data, filters, unreadTicketIds), [data, filters, unreadTicketIds]);

  const switchView = (next: TicketView) => { setView(next); persistView(next); };
  const resetFilters = () => setFilters(emptyTicketFilters);
  const handleStatSelect = (status: TicketStatus) => {
    setFilters(prev => ({ ...prev, status: prev.status === status ? '' : status }));
  };

  return <>
    <TicketStatsBar data={data} activeStatus={filters.status} onSelect={handleStatSelect} />

    <div className="crm-toolbar ticket-toolbar">
      <div className="ticket-view-switch" role="group" aria-label="Weergave kiezen">
        <button type="button" aria-pressed={view === 'list'} onClick={() => switchView('list')}><List size={14}/> Lijst</button>
        <button type="button" aria-pressed={view === 'table'} onClick={() => switchView('table')}><TableIcon size={14}/> Tabel</button>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw ticket</Button>
    </div>

    <TicketFilterPanel data={data} filters={filters} visibleCount={visible.length} onChange={setFilters} unreadTicketIds={unreadTicketIds} />

    {view === 'list'
      ? <TicketCardList data={data} tickets={visible} onEdit={onEdit} onConvert={onConvert} unreadTicketIds={unreadTicketIds} onReset={resetFilters} />
      : <TicketTable data={data} tickets={visible} onEdit={onEdit} onConvert={onConvert} unreadTicketIds={unreadTicketIds} onReset={resetFilters} />}
  </>;
}

function TicketStatsBar({ data, activeStatus, onSelect }: { data: AppData; activeStatus: string; onSelect: (status: TicketStatus) => void }) {
  return <div className="ticket-stats">
    {STATUS_ORDER.map(status => {
      const count = data.tickets.filter(t => t.status === status).length;
      const isActive = activeStatus === status;
      return <button type="button" key={status} className={`ticket-stat as-filter${isActive ? ' is-active' : ''}`} onClick={() => onSelect(status)} aria-pressed={isActive} title={`Filter op status ${ticketStatusLabels[status]}`}>
        <div className="ts-label">{ticketStatusLabels[status]}</div>
        <div className="ts-val">{count}</div>
      </button>;
    })}
  </div>;
}

/** Leeg scherm. Onderscheid tussen "er zijn nog geen tickets" en "je filter
 *  laat er nu geen zien" — anders lijkt een te streng filter op een lege app. */
function TicketEmpty({ hasTickets, onReset }: { hasTickets: boolean; onReset: () => void }) {
  if (!hasTickets) return <div className="empty quote-table-empty"><div className="e-big">Nog geen tickets</div><p>Maak je eerste ticket aan om binnenkomende vragen op te volgen.</p></div>;
  return <div className="empty quote-table-empty finance-search-empty"><div className="e-big">Geen tickets gevonden</div><p>Pas je zoekterm of filters aan om meer resultaten te tonen.</p><button type="button" onClick={onReset}><RotateCcw size={14}/> Filters wissen</button></div>;
}

function TicketCardList({ data, tickets, onEdit, onConvert, unreadTicketIds, onReset }: { data: AppData; tickets: Ticket[]; onEdit: (t: Ticket) => void; onConvert: (t: Ticket) => void; unreadTicketIds: Set<string>; onReset: () => void }) {
  if (tickets.length === 0) return <TicketEmpty hasTickets={data.tickets.length > 0} onReset={onReset} />;
  return <div className="ticket-list">
    {tickets.map(ticket => {
      const client = data.clients.find(c => c.id === ticket.client_id);
      const canConvert = convertibleStatuses.has(ticket.status) && !ticket.converted_to_project_id;
      const isUnread = unreadTicketIds.has(ticket.id);
      return <article className={`ticket-item pri-${ticket.priority}${isUnread ? ' is-unread' : ''}`} key={ticket.id} onClick={() => onEdit(ticket)}>
        <div className="tk-body"><div className="tk-title">{ticket.title}</div><div className="tk-meta"><span>{client?.name ?? 'Geen klant'}</span><span className={`tk-pri-label ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>{isUnread && <span className="tk-new-badge">Nieuw</span>}{ticket.converted_to_project_id && <span>Project aangemaakt</span>}</div></div><span className={`tk-status ${ticket.status}`}>{ticketStatusLabels[ticket.status]}</span><div className="tk-actions-btn">{canConvert ? <Button onClick={(e) => { e.stopPropagation(); onConvert(ticket); }}>Project maken</Button> : <Button disabled>{ticket.status === 'converted' || ticket.converted_to_project_id ? 'Al omgezet' : 'Niet converteerbaar'}</Button>}</div>
      </article>;
    })}
  </div>;
}

function TicketTable({ data, tickets, onEdit, onConvert, unreadTicketIds, onReset }: { data: AppData; tickets: Ticket[]; onEdit: (t: Ticket) => void; onConvert: (t: Ticket) => void; unreadTicketIds: Set<string>; onReset: () => void }) {
  const [sort, setSort] = useState<SortState>({ key: 'created', dir: 'desc' });
  const sorted = useMemo(() => sortTickets(tickets, data, sort), [tickets, data, sort]);

  const toggleSort = (key: SortKey) => setSort(prev => prev.key === key
    ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'created' ? 'desc' : 'asc' });

  return <div className="quote-table-card ticket-table-card">
    <div className="quote-table-scroll" role="region" aria-label="Tickets tabel">
      <table className="quote-table ticket-table">
        <thead>
          <tr>
            <SortableTh label="Titel" sortKey="title" sort={sort} onSort={toggleSort} />
            <SortableTh label="Klant" sortKey="client" sort={sort} onSort={toggleSort} />
            <SortableTh label="Prioriteit" sortKey="priority" sort={sort} onSort={toggleSort} />
            <SortableTh label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
            <SortableTh label="Aangemaakt" sortKey="created" sort={sort} onSort={toggleSort} />
            <th aria-label="Acties" />
          </tr>
        </thead>
        <tbody>
          {sorted.map(ticket => {
            const client = data.clients.find(c => c.id === ticket.client_id) ?? null;
            const canConvert = convertibleStatuses.has(ticket.status) && !ticket.converted_to_project_id;
            const isUnread = unreadTicketIds.has(ticket.id);
            return <tr key={ticket.id} className={`quote-table-row ticket-table-row st-${ticket.status}${isUnread ? ' is-unread' : ''}`} tabIndex={0}
              onClick={() => onEdit(ticket)}
              onKeyDown={(event) => {
                // Alleen reageren als de rij zélf gefocust is; anders zou Enter/Space op de
                // "Project maken"-knop in de rij worden gekaapt (verkeerde/dubbele actie).
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit(ticket); }
              }}>
              <td data-label="Titel"><strong>{ticket.title}</strong>{isUnread && <span className="tk-new-badge">Nieuw</span>}</td>
              <td data-label="Klant"><span>{client?.name ?? 'Geen klant'}</span></td>
              <td data-label="Prioriteit"><span className={`tk-pri-label ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span></td>
              <td data-label="Status"><span className={`tk-status ${ticket.status}`}>{ticketStatusLabels[ticket.status]}</span>{ticket.converted_to_project_id && <span className="tk-converted-pill">Project</span>}</td>
              <td data-label="Aangemaakt"><span>{dateNL(ticket.created_at)}</span></td>
              <td className="quote-row-actions ticket-row-actions" onClick={event => event.stopPropagation()}>
                {canConvert
                  ? <Button onClick={(e) => { e.stopPropagation(); onConvert(ticket); }}>Project maken</Button>
                  : <Button disabled>{ticket.status === 'converted' || ticket.converted_to_project_id ? 'Al omgezet' : 'Niet converteerbaar'}</Button>}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    {sorted.length === 0 && <TicketEmpty hasTickets={data.tickets.length > 0} onReset={onReset} />}
  </div>;
}

function SortableTh({ label, sortKey, sort, onSort, className }: { label: string; sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void; className?: string }) {
  const isActive = sort.key === sortKey;
  const ariaSort = isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return <th className={className} aria-sort={ariaSort}>
    <button type="button" className={`th-sort${isActive ? ' is-active' : ''}`} onClick={() => onSort(sortKey)} aria-label={`Sorteer op ${label}${isActive ? `, nu ${sort.dir === 'asc' ? 'oplopend' : 'aflopend'} gesorteerd` : ''}`}>
      {label}{isActive && (sort.dir === 'asc' ? <ArrowUp size={12} aria-hidden="true"/> : <ArrowDown size={12} aria-hidden="true"/>)}
    </button>
  </th>;
}

function TicketFilterPanel({ data, filters, visibleCount, onChange, unreadTicketIds }: { data: AppData; filters: TicketFilters; visibleCount: number; onChange: (filters: TicketFilters) => void; unreadTicketIds: Set<string> }) {
  const clientOptions = useMemo(() => {
    const clientIds = new Set(data.tickets.map(ticket => ticket.client_id).filter(Boolean));
    return data.clients
      .filter(client => clientIds.has(client.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl-NL'));
  }, [data.clients, data.tickets]);
  // Het getal op een snelfilter telt over álle tickets, niet over de al
  // gefilterde selectie: het beantwoordt "hoeveel zijn er zo?" en zakt dus
  // niet naar 0 zodra een ánder filter aanstaat.
  const quickCounts = useMemo(() => {
    const out = {} as Record<QuickFilterKey, number>;
    for (const def of QUICK_FILTERS) out[def.key] = data.tickets.filter(ticket => def.match(ticket, unreadTicketIds)).length;
    return out;
  }, [data.tickets, unreadTicketIds]);
  const activeFilterCount = countActiveFilters(filters);
  const totalCount = data.tickets.length;
  const update = (patch: Partial<TicketFilters>) => onChange({ ...filters, ...patch });
  const toggleQuick = (key: QuickFilterKey) => update({
    quick: filters.quick.includes(key) ? filters.quick.filter(k => k !== key) : [...filters.quick, key],
  });
  // Op een telefoon kostten de drie dropdowns ruim de helft van het filterblok,
  // terwijl de snelfilters eronder het meeste werk doen. Ze zitten daar achter
  // één knop; op een breed scherm staan ze gewoon uitgeklapt (CSS regelt dat,
  // deze schakelaar is daar niet zichtbaar).
  const [showFields, setShowFields] = useState(false);
  const fieldsId = useId();
  const fieldFilterCount = [filters.status, filters.priority, filters.clientId].filter(value => value !== '').length;

  return <section className="finance-search-card ticket-search-card" aria-label="Tickets zoeken en filteren">
    <div className="finance-search-main">
      <label className="finance-search-query">
        <span><Search size={15}/> Snel zoeken</span>
        <input
          className="form-input"
          value={filters.query}
          onChange={event => update({ query: event.target.value })}
          placeholder="Zoek op titel, klant, omschrijving of notitie…"
          autoComplete="off"
        />
      </label>
      <div className="finance-search-result-card">
        <SlidersHorizontal size={16}/>
        <div><strong>{visibleCount} van {totalCount}</strong><span>tickets zichtbaar</span></div>
      </div>
    </div>

    <div className="ticket-quick-filters" role="group" aria-label="Snelfilters">
      {QUICK_FILTERS.map(def => {
        const isActive = filters.quick.includes(def.key);
        const count = quickCounts[def.key] ?? 0;
        return <label key={def.key} className={`ticket-quick-chip${isActive ? ' is-active' : ''}${!isActive && count === 0 ? ' is-empty' : ''}`} title={def.title}>
          <input type="checkbox" checked={isActive} onChange={() => toggleQuick(def.key)} />
          <span className="tqc-box" aria-hidden="true"><Check size={11} strokeWidth={3}/></span>
          <span className="tqc-label">{def.label}</span>
          <span className="tqc-count">{count}</span>
        </label>;
      })}
    </div>

    <button type="button" className="ticket-filter-toggle" onClick={() => setShowFields(value => !value)} aria-expanded={showFields} aria-controls={fieldsId}>
      <SlidersHorizontal size={13}/> {showFields ? 'Minder filters' : 'Meer filters'}
      {fieldFilterCount > 0 && <span className="tft-count">{fieldFilterCount}</span>}
    </button>

    <div id={fieldsId} className={`finance-search-grid ticket-search-grid${showFields ? '' : ' is-collapsed'}`}>
      <label className="field finance-search-field"><span>Status</span><Select className="form-select" value={filters.status} onChange={event => update({ status: event.target.value })}><option value="">Alle statussen</option><option value="open">Openstaand</option>{STATUS_ORDER.map(status => <option key={status} value={status}>{ticketStatusLabels[status]}</option>)}</Select></label>
      <label className="field finance-search-field"><span>Prioriteit</span><Select className="form-select" value={filters.priority} onChange={event => update({ priority: event.target.value })}><option value="">Alle prioriteiten</option><option value="high">Hoog</option><option value="med">Normaal</option><option value="low">Laag</option></Select></label>
      <label className="field finance-search-field"><span>Klant</span><Select className="form-select" searchable searchPlaceholder="Zoek een klant…" value={filters.clientId} onChange={event => update({ clientId: event.target.value })}><option value="">Alle klanten</option>{clientOptions.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</Select></label>
    </div>

    {activeFilterCount > 0 && <div className="finance-search-active-row">
      <span>{activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} actief</span>
      <button type="button" onClick={() => onChange(emptyTicketFilters)}><RotateCcw size={14}/> Filters wissen</button>
    </div>}
  </section>;
}
