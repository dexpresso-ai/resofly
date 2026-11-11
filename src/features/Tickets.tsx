import { useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, CalendarPlus, CircleCheck, FolderPlus, List, MoreVertical, RotateCcw, Table as TableIcon } from 'lucide-react';
import type { AppData, OrganizationMember, Priority, Ticket, TicketStatus } from '../types';
import { Button } from '../components/Ui';
import { Modal } from '../components/Modal';
import { SearchFilterPanel } from '../components/SearchFilterPanel';
import type { FilterField } from '../components/SearchFilterPanel';
import { dateNL, priorityLabel } from '../lib/format';
import { listTime } from '../lib/communication';
import {
  TICKET_OPEN_STATUSES, TICKET_STATUS_LABELS, TICKET_STATUS_ORDER, TICKET_WORKLIST_STATUSES,
  canResolveTicket, isTicketArchived, sortArchivedTickets, ticketInScope, ticketResolvedAt, type TicketScope,
} from '../lib/tickets';
import { useNarrowViewport } from '../lib/useNarrowViewport';
import { holderName, matchesHolder, memberColor, memberInitials, memberShortName, membersWhoCanHold } from '../lib/members';

// Om te zetten naar een project = nog actief te behandelen: dezelfde drie
// statussen als "Openstaand" (niet afgewezen, niet omgezet en niet
// afgehandeld). De labels en volgorde staan in lib/tickets.ts, gedeeld met het
// klantdossier en Berichten.
const convertibleStatuses = TICKET_OPEN_STATUSES;
const openStatuses = TICKET_OPEN_STATUSES;
const STATUS_ORDER = TICKET_STATUS_ORDER;
const ticketStatusLabels = TICKET_STATUS_LABELS;
const priorityRank: Record<Priority, number> = { high: 3, med: 2, low: 1 };

const VIEW_STORAGE_KEY = 'resofly.tickets.view';
type TicketView = 'list' | 'table';
function readStoredView(): TicketView {
  try { return localStorage.getItem(VIEW_STORAGE_KEY) === 'table' ? 'table' : 'list'; } catch { return 'list'; }
}
function persistView(view: TicketView) {
  try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* private mode / storage disabled */ }
}

/** Wat je met een ticket kunt doen; kaart, tabel en telefoontabel bieden hetzelfde aan. */
type TicketActions = {
  onEdit: (t: Ticket) => void;
  onConvert: (t: Ticket) => void;
  onPlan: (t: Ticket) => void;
  onResolve: (t: Ticket) => void;
  onReopen: (t: Ticket) => void;
};

/* ── Snelfilters ───────────────────────────────────────────────────────────
 * Eén tik in plaats van drie dropdowns. Het zijn échte checkboxes (met de
 * spatiebalk aan te vinken, door een schermlezer aan te kondigen) die als
 * chip getekend zijn. Meerdere vinkjes stapelen: ze moeten állemaal kloppen
 * (EN, geen OF) — "openstaand én hoge prioriteit" is de vraag die je stelt.
 *
 * Een paar vragen gaan alleen over de werklijst: in het archief is alles
 * afgehandeld, niet meer om te zetten en niet ongelezen (de view ticket_unread
 * telt een afgehandeld ticket niet). Daar zouden ze altijd 0 tonen. */
type QuickFilterKey = 'mine' | 'unassigned' | 'open' | 'unread' | 'high' | 'convertible' | 'noClient';
type QuickFilterDef = {
  key: QuickFilterKey;
  label: string;
  title: string;
  worklistOnly?: boolean;
  match: (ticket: Ticket, unread: Set<string>, currentUserId: string | null) => boolean;
};
const QUICK_FILTERS: QuickFilterDef[] = [
  // Vooraan: "wat ligt er op mijn bord?" is de eerste vraag van wie de werklijst opent.
  { key: 'mine', label: 'Aan mij', title: 'Alleen tickets die aan jou zijn toegewezen', match: (ticket, _unread, me) => matchesHolder(ticket.assignee_user_id, 'me', me) },
  { key: 'unassigned', label: 'Niet toegewezen', title: 'Alleen tickets die nog niemand heeft opgepakt', worklistOnly: true, match: ticket => !ticket.assignee_user_id },
  { key: 'open', label: 'Openstaand', title: 'Alleen tickets die nog behandeld moeten worden', worklistOnly: true, match: ticket => openStatuses.has(ticket.status) },
  { key: 'unread', label: 'Ongelezen', title: 'Alleen tickets met iets nieuws dat je nog niet gezien hebt', worklistOnly: true, match: (ticket, unread) => unread.has(ticket.id) },
  { key: 'high', label: 'Hoge prioriteit', title: 'Alleen tickets met prioriteit hoog', match: ticket => ticket.priority === 'high' },
  { key: 'convertible', label: 'Om te zetten', title: 'Alleen tickets die je nog naar een project kunt omzetten', worklistOnly: true, match: ticket => convertibleStatuses.has(ticket.status) && !ticket.converted_to_project_id },
  { key: 'noClient', label: 'Zonder klant', title: 'Alleen tickets die nog aan geen enkele klant hangen', match: ticket => !ticket.client_id },
];
function quickFiltersFor(scope: TicketScope): QuickFilterDef[] {
  return scope === 'worklist' ? QUICK_FILTERS : QUICK_FILTERS.filter(def => !def.worklistOnly);
}

/** `assignee`: zie matchesHolder ('' = iedereen, 'me', 'none' of een user-id). */
type TicketFilters = { query: string; status: string; priority: string; clientId: string; assignee: string; quick: QuickFilterKey[] };
const emptyTicketFilters: TicketFilters = { query: '', status: '', priority: '', clientId: '', assignee: '', quick: [] };

type SortKey = 'title' | 'client' | 'assignee' | 'priority' | 'status' | 'created' | 'resolved';
type SortState = { key: SortKey; dir: 'asc' | 'desc' };
/** Het archief begint bij wat het laatst is afgehandeld, de werklijst bij het nieuwste ticket. */
function defaultSort(scope: TicketScope): SortState {
  return scope === 'archive' ? { key: 'resolved', dir: 'desc' } : { key: 'created', dir: 'desc' };
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('nl-NL')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTicketSearchText(ticket: Ticket, data: AppData, members: OrganizationMember[]): string {
  const client = data.clients.find(c => c.id === ticket.client_id) ?? null;
  const parts = [
    ticket.assignee_user_id ? holderName(ticket.assignee_user_id, members, '') : null,
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

function filterTickets(tickets: Ticket[], data: AppData, filters: TicketFilters, unread: Set<string>, scope: TicketScope, members: OrganizationMember[], currentUserId: string | null): Ticket[] {
  const query = normalize(filters.query);
  const quick = quickFiltersFor(scope).filter(def => filters.quick.includes(def.key));
  return tickets.filter(ticket => {
    if (filters.clientId && ticket.client_id !== filters.clientId) return false;
    if (!matchesHolder(ticket.assignee_user_id, filters.assignee, currentUserId)) return false;
    if (filters.priority && ticket.priority !== filters.priority) return false;
    // Het statusfilter is er alleen op de werklijst; in het archief is alles afgehandeld.
    if (scope === 'worklist') {
      if (filters.status === 'open') {
        if (!openStatuses.has(ticket.status)) return false;
      } else if (filters.status && ticket.status !== filters.status) return false;
    }
    for (const def of quick) if (!def.match(ticket, unread, currentUserId)) return false;
    if (!query) return true;
    return buildTicketSearchText(ticket, data, members).includes(query);
  });
}

function sortTickets(tickets: Ticket[], data: AppData, sort: SortState, members: OrganizationMember[]): Ticket[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const clientName = (ticket: Ticket) => data.clients.find(c => c.id === ticket.client_id)?.name ?? '';
  // Niet toegewezen sorteert achteraan bij oplopend: "~" komt na elke letter.
  const assigneeName = (ticket: Ticket) => ticket.assignee_user_id ? holderName(ticket.assignee_user_id, members, '') : '~';
  return [...tickets].sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case 'title': cmp = a.title.localeCompare(b.title, 'nl-NL'); break;
      case 'client': cmp = clientName(a).localeCompare(clientName(b), 'nl-NL'); break;
      case 'assignee': cmp = assigneeName(a).localeCompare(assigneeName(b), 'nl-NL'); break;
      case 'priority': cmp = priorityRank[a.priority] - priorityRank[b.priority]; break;
      case 'status': cmp = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status); break;
      case 'created': cmp = (a.created_at || '').localeCompare(b.created_at || ''); break;
      case 'resolved': cmp = (Date.parse(ticketResolvedAt(a)) || 0) - (Date.parse(ticketResolvedAt(b)) || 0); break;
    }
    // Stabiele secundaire sortering op aanmaakdatum zodat gelijke waarden vaste volgorde houden.
    if (cmp === 0) cmp = (a.created_at || '').localeCompare(b.created_at || '');
    return cmp * dir;
  });
}

export function Tickets({ data, onNew, onEdit, onConvert, onPlan, onResolve, onReopen, unreadTicketIds, teamMembers = [], currentUserId = null }: { data: AppData; onNew: () => void; onEdit: (t: Ticket) => void; onConvert: (t: Ticket) => void; onPlan: (t: Ticket) => void; onResolve: (t: Ticket) => void; onReopen: (t: Ticket) => void; unreadTicketIds: Set<string>; teamMembers?: OrganizationMember[]; currentUserId?: string | null }) {
  const [view, setView] = useState<TicketView>(() => readStoredView());
  const [scope, setScope] = useState<TicketScope>('worklist');
  const [filters, setFilters] = useState<TicketFilters>(emptyTicketFilters);
  // Eerst werklijst of archief, dan pas de filters: zo tellen de chips en
  // "x van y" binnen wat je voor je hebt, niet over alle tickets samen.
  const scopeTickets = useMemo(() => {
    const list = data.tickets.filter(ticket => ticketInScope(ticket, scope));
    return scope === 'archive' ? sortArchivedTickets(list) : list;
  }, [data.tickets, scope]);
  const archivedCount = useMemo(() => data.tickets.filter(isTicketArchived).length, [data.tickets]);
  // Filteren gebeurt hier en niet in de tabel, zodat hetzelfde filter ook in de
  // lijstweergave werkt en een klik op een statuskaart je niet meer naar de
  // tabel hoeft te duwen om iets te doen.
  const visible = useMemo(() => filterTickets(scopeTickets, data, filters, unreadTicketIds, scope, teamMembers, currentUserId), [scopeTickets, data, filters, unreadTicketIds, scope, teamMembers, currentUserId]);
  const actions: TicketActions = { onEdit, onConvert, onPlan, onResolve, onReopen };

  const switchView = (next: TicketView) => { setView(next); persistView(next); };
  const resetFilters = () => setFilters(emptyTicketFilters);
  /** Zoekterm, klant en prioriteit gaan mee; wat alleen op de werklijst iets betekent, gaat uit. */
  const switchScope = (next: TicketScope) => {
    setScope(next);
    setFilters(prev => ({
      ...prev,
      status: '',
      quick: prev.quick.filter(key => quickFiltersFor(next).some(def => def.key === key)),
    }));
  };
  const handleStatSelect = (status: TicketStatus) => {
    // De statuskaarten gaan over de werklijst. Vanuit het archief brengt er een
    // je terug, met dat filter aan.
    if (scope === 'archive') {
      setScope('worklist');
      setFilters(prev => ({ ...prev, status }));
      return;
    }
    setFilters(prev => ({ ...prev, status: prev.status === status ? '' : status }));
  };

  return <>
    <TicketStatsBar data={data} activeStatus={scope === 'worklist' ? filters.status : ''} onSelect={handleStatSelect} />

    <div className="crm-toolbar ticket-toolbar">
      <div className="ticket-toolbar-start">
        <div className="ticket-view-switch" role="group" aria-label="Weergave kiezen">
          <button type="button" aria-pressed={view === 'list'} onClick={() => switchView('list')}><List size={14}/> Lijst</button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => switchView('table')}><TableIcon size={14}/> Tabel</button>
        </div>
        {/* Het archief zit naast de weergavekeuze en niet in een eigen rij: op
            een telefoon kost elke rij boven de lijst een ticket minder in beeld. */}
        <button
          type="button"
          className="ticket-archive-toggle"
          aria-pressed={scope === 'archive'}
          aria-label={`Archief: ${archivedCount} afgehandeld${archivedCount === 1 ? ' ticket' : 'e tickets'}`}
          title={scope === 'archive' ? 'Terug naar de werklijst' : 'Afgehandelde tickets bekijken'}
          onClick={() => switchScope(scope === 'archive' ? 'worklist' : 'archive')}
        >
          <Archive size={14} aria-hidden="true"/>
          <span className="ticket-archive-label">Archief</span>
          <span className="ticket-archive-count">{archivedCount}</span>
        </button>
      </div>
      <Button variant="primary" onClick={onNew}>+ Nieuw ticket</Button>
    </div>

    {scope === 'archive' && <div className="ticket-archive-note">
      <Archive size={15} aria-hidden="true"/>
      <p><strong>Archief</strong>: afgehandelde tickets, laatst afgehandeld bovenaan. Reageert de klant nog, dan komt het ticket vanzelf terug op de werklijst. <button type="button" className="ticket-archive-back" onClick={() => switchScope('worklist')}>Naar de werklijst</button></p>
    </div>}

    <TicketFilterPanel data={data} tickets={scopeTickets} scope={scope} filters={filters} visibleCount={visible.length} onChange={setFilters} unreadTicketIds={unreadTicketIds} teamMembers={teamMembers} currentUserId={currentUserId} />

    {view === 'list'
      ? <TicketCardList data={data} tickets={visible} scope={scope} scopeTotal={scopeTickets.length} actions={actions} unreadTicketIds={unreadTicketIds} onReset={resetFilters} onScope={switchScope} teamMembers={teamMembers} currentUserId={currentUserId} />
      // key: een andere lijst begint met zijn eigen sortering (zie defaultSort).
      : <TicketTable key={scope} data={data} tickets={visible} scope={scope} scopeTotal={scopeTickets.length} actions={actions} unreadTicketIds={unreadTicketIds} onReset={resetFilters} onScope={switchScope} teamMembers={teamMembers} currentUserId={currentUserId} />}
  </>;
}

function TicketStatsBar({ data, activeStatus, onSelect }: { data: AppData; activeStatus: string; onSelect: (status: TicketStatus) => void }) {
  return <div className="ticket-stats">
    {TICKET_WORKLIST_STATUSES.map(status => {
      const count = data.tickets.filter(t => t.status === status).length;
      const isActive = activeStatus === status;
      return <button type="button" key={status} className={`ticket-stat as-filter${isActive ? ' is-active' : ''}`} onClick={() => onSelect(status)} aria-pressed={isActive} title={`Filter op status ${ticketStatusLabels[status]}`}>
        <div className="ts-label">{ticketStatusLabels[status]}</div>
        <div className="ts-val">{count}</div>
      </button>;
    })}
  </div>;
}

/** Leeg scherm. Onderscheid tussen "er is hier nog niets" en "je filter laat
 *  er nu niets zien" — anders lijkt een te streng filter op een lege app. En
 *  een werklijst die leeg is omdat alles is afgehandeld, wijst naar het archief. */
function TicketEmpty({ scope, scopeTotal, hasTickets, onReset, onScope }: { scope: TicketScope; scopeTotal: number; hasTickets: boolean; onReset: () => void; onScope: (scope: TicketScope) => void }) {
  if (scopeTotal === 0) {
    if (scope === 'archive') return <div className="empty quote-table-empty"><div className="e-big">Het archief is nog leeg</div><p>Zet een ticket op <strong>Afgehandeld</strong>, dan verdwijnt het van de werklijst en vind je het hier terug.</p></div>;
    if (hasTickets) return <div className="empty quote-table-empty finance-search-empty"><div className="e-big">Alles is afgehandeld</div><p>Er staat niets meer op de werklijst. Afgehandelde tickets vind je in het archief.</p><button type="button" onClick={() => onScope('archive')}><Archive size={14}/> Naar het archief</button></div>;
    return <div className="empty quote-table-empty"><div className="e-big">Nog geen tickets</div><p>Maak je eerste ticket aan om binnenkomende vragen op te volgen.</p></div>;
  }
  return <div className="empty quote-table-empty finance-search-empty"><div className="e-big">Geen tickets gevonden</div><p>Pas je zoekterm of filters aan om meer resultaten te tonen.</p><button type="button" onClick={onReset}><RotateCcw size={14}/> Filters wissen</button></div>;
}

/**
 * De knoppen bij een ticket. Afhandelen staat bij alles wat nog kan; alleen een
 * omgezet ticket niet, want dat werd een project (de database houdt het op
 * "omgezet"). In het archief is er één knop: heropenen.
 *
 * Op de telefoon passen drie knoppen met tekst niet naast elkaar. Staan "Op de
 * planning" en "Project maken" ernaast, dan wordt Afhandelen daar een rond
 * vinkje (CSS: .tk-resolve-btn.is-compact); staat hij alleen, dan houdt hij
 * zijn woord.
 */
function TicketActionButtons({ ticket, actions }: { ticket: Ticket; actions: TicketActions }) {
  const run = (action: (t: Ticket) => void) => (event: MouseEvent) => { event.stopPropagation(); action(ticket); };
  if (isTicketArchived(ticket)) {
    return <Button onClick={run(actions.onReopen)} title="Terug naar de werklijst, op Review"><ArchiveRestore size={14} aria-hidden="true"/> Heropenen</Button>;
  }
  const canConvert = convertibleStatuses.has(ticket.status) && !ticket.converted_to_project_id;
  const canResolve = canResolveTicket(ticket);
  return <>
    {canConvert && <Button onClick={run(actions.onPlan)} title="Maak er meteen een taak van in de weekplanner">Op de planning</Button>}
    {canConvert && <Button onClick={run(actions.onConvert)}>Project maken</Button>}
    {canResolve && <Button className={`tk-resolve-btn${canConvert ? ' is-compact' : ''}`} onClick={run(actions.onResolve)} aria-label="Afhandelen" title="Afhandelen: het ticket gaat van de werklijst naar het archief"><CircleCheck size={14} aria-hidden="true"/><span className="tk-btn-text">Afhandelen</span></Button>}
    {!canConvert && !canResolve && <Button disabled>{ticket.status === 'converted' || ticket.converted_to_project_id ? 'Al omgezet' : 'Niet converteerbaar'}</Button>}
  </>;
}

type TicketListProps = { data: AppData; tickets: Ticket[]; scope: TicketScope; scopeTotal: number; actions: TicketActions; unreadTicketIds: Set<string>; onReset: () => void; onScope: (scope: TicketScope) => void; teamMembers: OrganizationMember[]; currentUserId: string | null };

/** Wie het ticket heeft, als avatar met naam; niets als niemand het heeft. */
function TicketAssignee({ ticket, teamMembers, currentUserId, withName = true }: { ticket: Ticket; teamMembers: OrganizationMember[]; currentUserId: string | null; withName?: boolean }) {
  const userId = ticket.assignee_user_id;
  if (!userId) return null;
  const full = holderName(userId, teamMembers, '');
  const short = userId === currentUserId ? 'Jij' : full === 'Oud-teamlid' ? full : memberShortName(userId, teamMembers);
  return <span className="tk-assignee" title={`Toegewezen aan ${userId === currentUserId ? 'jou' : full}`}>
    <span className="assignee-avatar" style={{ background: memberColor(userId) }}>{memberInitials(userId, teamMembers)}</span>
    {withName && <span className="tk-assignee-name">{short}</span>}
  </span>;
}

function TicketCardList({ data, tickets, scope, scopeTotal, actions, unreadTicketIds, onReset, onScope, teamMembers, currentUserId }: TicketListProps) {
  if (tickets.length === 0) return <TicketEmpty scope={scope} scopeTotal={scopeTotal} hasTickets={data.tickets.length > 0} onReset={onReset} onScope={onScope} />;
  return <div className={`ticket-list${scope === 'archive' ? ' is-archive' : ''}`}>
    {tickets.map(ticket => {
      const client = data.clients.find(c => c.id === ticket.client_id);
      const isUnread = unreadTicketIds.has(ticket.id);
      return <article className={`ticket-item pri-${ticket.priority}${isUnread ? ' is-unread' : ''}`} key={ticket.id} onClick={() => actions.onEdit(ticket)}>
        <div className="tk-body"><div className="tk-title">{ticket.title}</div><div className="tk-meta"><TicketAssignee ticket={ticket} teamMembers={teamMembers} currentUserId={currentUserId} /><span>{client?.name ?? 'Geen klant'}</span><span className={`tk-pri-label ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>{isUnread && <span className="tk-new-badge">Nieuw</span>}{ticket.converted_to_project_id && <span>Project aangemaakt</span>}{isTicketArchived(ticket) && <span className="tk-resolved-on">Afgehandeld {dateNL(ticketResolvedAt(ticket))}</span>}</div></div><span className={`tk-status ${ticket.status}`}>{ticketStatusLabels[ticket.status]}</span><div className="tk-actions-btn"><TicketActionButtons ticket={ticket} actions={actions} /></div>
      </article>;
    })}
  </div>;
}

function TicketTable({ data, tickets, scope, scopeTotal, actions, unreadTicketIds, onReset, onScope, teamMembers, currentUserId }: TicketListProps) {
  const [sort, setSort] = useState<SortState>(() => defaultSort(scope));
  const sorted = useMemo(() => sortTickets(tickets, data, sort, teamMembers), [tickets, data, sort, teamMembers]);
  const narrow = useNarrowViewport();
  const archive = scope === 'archive';

  const toggleSort = (key: SortKey) => setSort(prev => prev.key === key
    ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'created' || key === 'resolved' ? 'desc' : 'asc' });

  const empty = <TicketEmpty scope={scope} scopeTotal={scopeTotal} hasTickets={data.tickets.length > 0} onReset={onReset} onScope={onScope} />;
  if (narrow) return <TicketCompactTable data={data} tickets={sorted} scope={scope} sort={sort} onSort={toggleSort} actions={actions} unreadTicketIds={unreadTicketIds} empty={empty} teamMembers={teamMembers} currentUserId={currentUserId} />;

  return <div className="quote-table-card ticket-table-card">
    <div className="quote-table-scroll" role="region" aria-label={archive ? 'Archief van tickets' : 'Tickets tabel'}>
      <table className="quote-table ticket-table">
        <thead>
          <tr>
            <SortableTh label="Titel" sortKey="title" sort={sort} onSort={toggleSort} />
            <SortableTh label="Klant" sortKey="client" sort={sort} onSort={toggleSort} />
            <SortableTh label="Toegewezen" sortKey="assignee" sort={sort} onSort={toggleSort} />
            <SortableTh label="Prioriteit" sortKey="priority" sort={sort} onSort={toggleSort} />
            {/* In het archief is de status altijd "Afgehandeld"; wanneer zegt daar meer. */}
            {archive
              ? <SortableTh label="Afgehandeld" sortKey="resolved" sort={sort} onSort={toggleSort} />
              : <SortableTh label="Status" sortKey="status" sort={sort} onSort={toggleSort} />}
            <SortableTh label="Aangemaakt" sortKey="created" sort={sort} onSort={toggleSort} />
            <th aria-label="Acties" />
          </tr>
        </thead>
        <tbody>
          {sorted.map(ticket => {
            const client = data.clients.find(c => c.id === ticket.client_id) ?? null;
            const isUnread = unreadTicketIds.has(ticket.id);
            return <tr key={ticket.id} className={`quote-table-row ticket-table-row st-${ticket.status}${isUnread ? ' is-unread' : ''}`} tabIndex={0}
              onClick={() => actions.onEdit(ticket)}
              onKeyDown={(event) => {
                // Alleen reageren als de rij zélf gefocust is; anders zou Enter/Space op de
                // "Project maken"-knop in de rij worden gekaapt (verkeerde/dubbele actie).
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.onEdit(ticket); }
              }}>
              <td data-label="Titel"><strong>{ticket.title}</strong>{isUnread && <span className="tk-new-badge">Nieuw</span>}</td>
              <td data-label="Klant"><span>{client?.name ?? 'Geen klant'}</span></td>
              <td data-label="Toegewezen">{ticket.assignee_user_id ? <TicketAssignee ticket={ticket} teamMembers={teamMembers} currentUserId={currentUserId} /> : <span className="tk-unassigned">Niemand</span>}</td>
              <td data-label="Prioriteit"><span className={`tk-pri-label ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span></td>
              {archive
                ? <td data-label="Afgehandeld"><span>{dateNL(ticketResolvedAt(ticket))}</span></td>
                : <td data-label="Status"><span className={`tk-status ${ticket.status}`}>{ticketStatusLabels[ticket.status]}</span>{ticket.converted_to_project_id && <span className="tk-converted-pill">Project</span>}</td>}
              <td data-label="Aangemaakt"><span>{dateNL(ticket.created_at)}</span></td>
              <td className="quote-row-actions ticket-row-actions" onClick={event => event.stopPropagation()}>
                <TicketActionButtons ticket={ticket} actions={actions} />
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    {sorted.length === 0 && empty}
  </div>;
}

/* ── Tickets op de telefoon: een échte tabel ──────────────────────────────
 * De tabel hierboven heeft zes kolommen en is 820px breed. Op een telefoon
 * klapte hij om naar losse kaarten van drie regels met twee grote knoppen:
 * ±165px per ticket, dus nog geen drie tickets per scherm — en het leek niet
 * meer op de tabel die je had gekozen. Deze variant is wél een tabel, maar
 * dan met drie kolommen die op een telefoon passen:
 *
 *   TICKET · KLANT · DATUM ↓            STATUS · PRIO
 *   ● Website laadt traag op mobiel    [NIEUW]         ⋮
 *     Fysio Centrum Zuid · 23 aug      [HOOG]
 *
 * Elke kolom houdt twee gegevens onder elkaar, en de kop sorteert op elk van
 * de vijf — er verdwijnt dus niets van wat de brede tabel kan. "Op de
 * planning", "Project maken" en "Afhandelen" zitten achter ⋮: knoppen per rij
 * kostten een kwart van de breedte, en die ging van de titel en de klantnaam
 * af. Het menu opent als paneel onderin (de Modal is op een telefoon een
 * bodemvenster) met de acties voluit geschreven. In het archief is de datum
 * die van het afhandelen, en staat er in het menu alleen "Heropenen".
 *
 * Een aparte tabel en geen CSS-truc op de brede: die draagt `.quote-table`,
 * en de kaartstapel die daar op mobiel onder ligt, zou elke regel hier
 * moeten terugdraaien. Welke van de twee er staat, beslist
 * `useNarrowViewport` — dezelfde grens (760px) als de mobiele CSS. */
function TicketCompactTable({ data, tickets, scope, sort, onSort, actions, unreadTicketIds, empty, teamMembers, currentUserId }: { data: AppData; tickets: Ticket[]; scope: TicketScope; sort: SortState; onSort: (key: SortKey) => void; actions: TicketActions; unreadTicketIds: Set<string>; empty: ReactNode; teamMembers: OrganizationMember[]; currentUserId: string | null }) {
  const [actionsFor, setActionsFor] = useState<Ticket | null>(null);
  const archive = scope === 'archive';
  /** Eerst het paneel dicht, dan de actie: die opent zelf een bevestiging of een andere pagina. */
  const run = (action: (ticket: Ticket) => void) => {
    const ticket = actionsFor;
    setActionsFor(null);
    if (ticket) action(ticket);
  };
  const sheetConvertible = actionsFor ? convertibleStatuses.has(actionsFor.status) && !actionsFor.converted_to_project_id : false;

  return <div className="tk-ctable-card">
    <table className="tk-ctable" aria-label={archive ? 'Archief van tickets' : 'Tickets tabel'}>
      <thead>
        <tr>
          <th className="tk-ct-main">
            <span className="tk-ct-sorts">
              <SortButton label="Ticket" sortKey="title" sort={sort} onSort={onSort} />
              <span aria-hidden="true">·</span>
              <SortButton label="Klant" sortKey="client" sort={sort} onSort={onSort} />
              <span aria-hidden="true">·</span>
              {/* In het archief de datum van het afhandelen. Het woord blijft
                  "Datum": "Afgehandeld" brak de kop op 390px over drie regels. */}
              <SortButton label="Datum" sortKey={archive ? 'resolved' : 'created'} sort={sort} onSort={onSort} />
            </span>
          </th>
          <th className="tk-ct-status">
            <span className="tk-ct-sorts">
              <SortButton label="Status" sortKey="status" sort={sort} onSort={onSort} />
              <span aria-hidden="true">·</span>
              <SortButton label="Prio" sortKey="priority" sort={sort} onSort={onSort} />
            </span>
          </th>
          <th className="tk-ct-actions" aria-label="Acties" />
        </tr>
      </thead>
      <tbody>
        {tickets.map(ticket => {
          const client = data.clients.find(c => c.id === ticket.client_id) ?? null;
          const hasActions = isTicketArchived(ticket) || canResolveTicket(ticket) || (convertibleStatuses.has(ticket.status) && !ticket.converted_to_project_id);
          const isUnread = unreadTicketIds.has(ticket.id);
          const when = archive ? ticketResolvedAt(ticket) : ticket.created_at;
          return <tr key={ticket.id} className={`tk-ct-row${isUnread ? ' is-unread' : ''}`} tabIndex={0}
            onClick={() => actions.onEdit(ticket)}
            onKeyDown={(event) => {
              // Zelfde regel als de brede tabel: alleen de rij zélf reageert,
              // anders kaapt Enter de actieknoppen erin.
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); actions.onEdit(ticket); }
            }}>
            <td className="tk-ct-main">
              <span className="tk-ct-title">
                {isUnread && <span className="tk-ct-dot" role="img" aria-label="Nieuw" title="Nieuw sinds je laatste bezoek" />}
                <strong>{ticket.title}</strong>
              </span>
              <span className="tk-ct-sub">
                <TicketAssignee ticket={ticket} teamMembers={teamMembers} currentUserId={currentUserId} withName={false} />
                <span className="tk-ct-client">{client?.name ?? 'Geen klant'}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={when} title={archive ? `Afgehandeld ${dateNL(when)}` : dateNL(when)}>{listTime(when)}</time>
              </span>
            </td>
            <td className="tk-ct-status">
              <span className={`tk-status ${ticket.status}`}>{ticketStatusLabels[ticket.status]}</span>
              <span className={`tk-pri-label ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>
              {ticket.converted_to_project_id && <span className="tk-converted-pill">Project</span>}
            </td>
            <td className="tk-ct-actions" onClick={event => event.stopPropagation()}>
              {hasActions && <button type="button" className="tk-ct-more" onClick={() => setActionsFor(ticket)} aria-haspopup="dialog" aria-label={`Acties voor ${ticket.title}`}>
                <MoreVertical size={17} aria-hidden="true"/>
              </button>}
            </td>
          </tr>;
        })}
      </tbody>
    </table>
    {tickets.length === 0 && empty}
    {actionsFor && <Modal title={actionsFor.title} className="tk-actions-sheet" onClose={() => setActionsFor(null)}>
      <div className="tk-sheet-actions">
        {isTicketArchived(actionsFor)
          ? <button type="button" className="tk-sheet-item" onClick={() => run(actions.onReopen)}>
              <ArchiveRestore size={18} aria-hidden="true"/>
              <span><strong>Heropenen</strong><small>Terug naar de werklijst, op Review</small></span>
            </button>
          : <>
              {sheetConvertible && <button type="button" className="tk-sheet-item" onClick={() => run(actions.onPlan)}>
                <CalendarPlus size={18} aria-hidden="true"/>
                <span><strong>Op de planning</strong><small>Maak er meteen een taak van, op vandaag</small></span>
              </button>}
              {sheetConvertible && <button type="button" className="tk-sheet-item" onClick={() => run(actions.onConvert)}>
                <FolderPlus size={18} aria-hidden="true"/>
                <span><strong>Project maken</strong><small>Zet het ticket om naar een project</small></span>
              </button>}
              {canResolveTicket(actionsFor) && <button type="button" className="tk-sheet-item" onClick={() => run(actions.onResolve)}>
                <CircleCheck size={18} aria-hidden="true"/>
                <span><strong>Afhandelen</strong><small>Van de werklijst naar het archief</small></span>
              </button>}
            </>}
      </div>
    </Modal>}
  </div>;
}

function SortButton({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void }) {
  const isActive = sort.key === sortKey;
  return <button type="button" className={`th-sort${isActive ? ' is-active' : ''}`} onClick={() => onSort(sortKey)} aria-label={`Sorteer op ${label}${isActive ? `, nu ${sort.dir === 'asc' ? 'oplopend' : 'aflopend'} gesorteerd` : ''}`}>
    {label}{isActive && (sort.dir === 'asc' ? <ArrowUp size={12} aria-hidden="true"/> : <ArrowDown size={12} aria-hidden="true"/>)}
  </button>;
}

function SortableTh({ label, sortKey, sort, onSort, className }: { label: string; sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void; className?: string }) {
  const isActive = sort.key === sortKey;
  const ariaSort = isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return <th className={className} aria-sort={ariaSort}>
    <SortButton label={label} sortKey={sortKey} sort={sort} onSort={onSort} />
  </th>;
}

function TicketFilterPanel({ data, tickets, scope, filters, visibleCount, onChange, unreadTicketIds, teamMembers, currentUserId }: { data: AppData; tickets: Ticket[]; scope: TicketScope; filters: TicketFilters; visibleCount: number; onChange: (filters: TicketFilters) => void; unreadTicketIds: Set<string>; teamMembers: OrganizationMember[]; currentUserId: string | null }) {
  const clientOptions = useMemo(() => {
    const clientIds = new Set(tickets.map(ticket => ticket.client_id).filter(Boolean));
    return data.clients
      .filter(client => clientIds.has(client.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl-NL'));
  }, [data.clients, tickets]);
  const chips = useMemo(
    () => quickFiltersFor(scope).map(def => ({
      key: def.key,
      label: def.label,
      title: def.title,
      count: tickets.filter(ticket => def.match(ticket, unreadTicketIds, currentUserId)).length,
    })),
    [tickets, scope, unreadTicketIds, currentUserId],
  );
  // Wie tickets kan krijgen, plus wie er nu een heeft. Meestal dezelfde mensen
  // (de database haalt de toewijzing weg bij wie de toegang verliest), maar een
  // teamlijst die even achterloopt mag geen tickets onvindbaar maken.
  const assigneeOptions = useMemo(() => {
    const holders = membersWhoCanHold(teamMembers, 'tickets').map(m => m.user_id);
    const used = tickets.map(t => t.assignee_user_id).filter((id): id is string => Boolean(id));
    const ids = [...new Set([...holders, ...used])].filter(id => id !== currentUserId);
    return [
      { value: '', label: 'Iedereen' },
      ...(currentUserId ? [{ value: 'me', label: 'Aan mij' }] : []),
      { value: 'none', label: 'Niet toegewezen' },
      ...ids.map(id => ({ value: id, label: holderName(id, teamMembers, '') }))
        .sort((a, b) => a.label.localeCompare(b.label, 'nl')),
    ];
  }, [teamMembers, tickets, currentUserId]);

  const update = (patch: Partial<TicketFilters>) => onChange({ ...filters, ...patch });
  const fields: FilterField[] = [
    ...(scope === 'worklist'
      ? [{ key: 'status', label: 'Status', value: filters.status, options: [{ value: '', label: 'Alle statussen' }, { value: 'open', label: 'Openstaand' }, ...TICKET_WORKLIST_STATUSES.map(status => ({ value: status, label: ticketStatusLabels[status] }))] }]
      : []),
    { key: 'priority', label: 'Prioriteit', value: filters.priority, options: [{ value: '', label: 'Alle prioriteiten' }, { value: 'high', label: 'Hoog' }, { value: 'med', label: 'Normaal' }, { value: 'low', label: 'Laag' }] },
    { key: 'clientId', label: 'Klant', value: filters.clientId, searchable: true, searchPlaceholder: 'Zoek een klant…', options: [{ value: '', label: 'Alle klanten' }, ...clientOptions.map(client => ({ value: client.id, label: client.name }))] },
    { key: 'assignee', label: 'Toegewezen aan', value: filters.assignee, searchable: assigneeOptions.length > 8, searchPlaceholder: 'Zoek een teamlid…', options: assigneeOptions },
  ];

  return <SearchFilterPanel
    className="is-wide"
    ariaLabel={scope === 'archive' ? 'Archief zoeken en filteren' : 'Tickets zoeken en filteren'}
    query={filters.query}
    queryPlaceholder={scope === 'archive' ? 'Zoek in het archief…' : 'Zoek op titel, klant, teamlid, omschrijving of notitie…'}
    onQueryChange={query => update({ query })}
    visibleCount={visibleCount}
    totalCount={tickets.length}
    noun={scope === 'archive' ? 'afgehandelde tickets' : 'tickets'}
    chips={chips}
    activeChips={filters.quick}
    onChipToggle={key => {
      const quickKey = key as QuickFilterKey;
      update({ quick: filters.quick.includes(quickKey) ? filters.quick.filter(k => k !== quickKey) : [...filters.quick, quickKey] });
    }}
    fields={fields}
    onFieldChange={(key, value) => update({ [key]: value } as Partial<TicketFilters>)}
    onReset={() => onChange(emptyTicketFilters)}
  />;
}
