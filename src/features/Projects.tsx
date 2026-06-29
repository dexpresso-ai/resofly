import { useMemo, useRef, useState } from 'react';
import type { AppData, InternalDocument, Invoice, Note, Project, Quote, Task, TaskStatus, TimeEntry, UUID } from '../types';
import { Button, Select } from '../components/Ui';
import { dateNL, euro, formatMinutes, priorityLabel } from '../lib/format';
import { RelatedNotes } from './Notes';
import { RelatedDocuments } from './Documents';
import { ProjectQuotesPanel } from './Finance';
import { ProjectTimeline } from './ProjectTimeline';
import { TimeEntryModal, timeEntryValueCents } from './TimeTracking';
import { deleteTimeEntry, updateTimeEntry } from '../lib/repository';
import { ChevronDown, ChevronRight, Clock, Pencil, Trash2 } from 'lucide-react';

/** Uitklapbare dashboard-sectie */
function DashboardSection({
  icon,
  title,
  subtitle,
  badge,
  accentColor,
  defaultOpen = true,
  action,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: number | string;
  accentColor?: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`proj-dash-section ${open ? 'open' : 'closed'}`}>
      <button
        type="button"
        className="proj-dash-section-header"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <div className="proj-dash-section-left">
          <span className="proj-dash-section-icon" style={accentColor ? { color: accentColor } : undefined}>
            {icon}
          </span>
          <div className="proj-dash-section-titles">
            <span className="proj-dash-section-title">{title}</span>
            {subtitle && <span className="proj-dash-section-sub">{subtitle}</span>}
          </div>
          {badge !== undefined && badge !== 0 && (
            <span className="proj-dash-section-badge">{badge}</span>
          )}
        </div>
        <div className="proj-dash-section-right" onClick={e => e.stopPropagation()}>
          {action}
          <span className="proj-dash-chevron">
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </span>
        </div>
      </button>
      {open && <div className="proj-dash-section-body">{children}</div>}
    </div>
  );
}

const columns: {key: TaskStatus; label: string}[] = [{key:'todo',label:'Te doen'}, {key:'doing',label:'Bezig'}, {key:'review',label:'Review'}, {key:'done',label:'Klaar'}];

type ProjectTab = 'overview' | 'kanban' | 'quotes' | 'invoices' | 'time' | 'notes' | 'documents';

const projectQuoteStatusLabels: Record<string, string> = {
  draft: 'Concept',
  pending_internal_approval: 'Wacht op goedkeuring',
  internally_approved: 'Intern goedgekeurd',
  sent: 'Verzonden',
  accepted: 'Geaccepteerd',
  rejected: 'Afgewezen',
  expired: 'Verlopen',
  cancelled: 'Geannuleerd',
};

const projectInvoiceStatusLabels: Record<string, string> = {
  draft: 'Concept',
  sent: 'Verzonden',
  accepted: 'Openstaand',
  paid: 'Betaald',
  overdue: 'Vervallen',
  cancelled: 'Geannuleerd',
};

type ProjectViewMode = 'cards' | 'table';
const projectViewStorageKey = 'resofly.projects.viewMode';

type ProjectSortKey = 'name' | 'progress' | 'open' | 'overdue' | 'end_date' | 'updated';
const projectSortStorageKey = 'resofly.projects.sortKey';

const projectSortOptions: { key: ProjectSortKey; label: string }[] = [
  { key: 'name', label: 'Naam (A–Z)' },
  { key: 'updated', label: 'Recent bijgewerkt' },
  { key: 'progress', label: 'Voortgang' },
  { key: 'open', label: 'Open taken' },
  { key: 'overdue', label: 'Taken te laat' },
  { key: 'end_date', label: 'Einddatum' },
];

function readProjectViewMode(): ProjectViewMode {
  try {
    return window.localStorage.getItem(projectViewStorageKey) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

function readProjectSortKey(): ProjectSortKey {
  try {
    const saved = window.localStorage.getItem(projectSortStorageKey);
    return projectSortOptions.some(option => option.key === saved) ? saved as ProjectSortKey : 'name';
  } catch {
    return 'name';
  }
}

type ProjectStats = { tasks: number; doneTasks: number; openTasks: number; overdueTasks: number; progress: number };

function computeProjectStats(data: AppData, project: Project): ProjectStats {
  const tasks = data.tasks.filter(task => task.project_id === project.id);
  const doneTasks = tasks.filter(task => task.status === 'done').length;
  const overdueTasks = tasks.filter(task => task.status !== 'done' && task.end_date && new Date(`${task.end_date}T23:59:59`) < new Date()).length;
  return {
    tasks: tasks.length,
    doneTasks,
    openTasks: tasks.length - doneTasks,
    overdueTasks,
    progress: tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0,
  };
}

function sortProjects(projects: Project[], data: AppData, sortKey: ProjectSortKey): Project[] {
  const statsCache = new Map<string, ProjectStats>();
  const statsOf = (project: Project) => {
    let stats = statsCache.get(project.id);
    if (!stats) {
      stats = computeProjectStats(data, project);
      statsCache.set(project.id, stats);
    }
    return stats;
  };

  return [...projects].sort((a, b) => {
    switch (sortKey) {
      case 'progress': return statsOf(b).progress - statsOf(a).progress;
      case 'open': return statsOf(b).openTasks - statsOf(a).openTasks;
      case 'overdue': return statsOf(b).overdueTasks - statsOf(a).overdueTasks;
      case 'end_date': return String(a.end_date ?? '9999').localeCompare(String(b.end_date ?? '9999'));
      case 'updated': return String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''));
      case 'name':
      default: return a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' });
    }
  });
}


export function ProjectsPlanningPage({
  data,
  onOpenProject,
}: {
  data: AppData;
  onOpenProject: (project: Project) => void;
}) {
  return <div className="projects-page projects-planning-page">
    <ProjectTimeline data={data} variant="full" openProject={(id) => {
      const project = data.projects.find(item => item.id === id);
      if (project) onOpenProject(project);
    }} />
  </div>;
}

export function ProjectsListPage({
  data,
  canWrite,
  onNewProject,
  onOpenProject,
  onEditProject,
}: {
  data: AppData;
  canWrite: boolean;
  onNewProject: () => void;
  onOpenProject: (project: Project) => void;
  onEditProject: (project: Project) => void;
}) {
  const [viewMode, setViewMode] = useState<ProjectViewMode>(readProjectViewMode);
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState<string>('all');
  const [sortKey, setSortKey] = useState<ProjectSortKey>(readProjectSortKey);

  const clientNameById = useMemo(() => {
    const map = new Map<string, string>();
    data.clients.forEach(client => map.set(client.id, client.name));
    return map;
  }, [data.clients]);

  // Alleen klanten die daadwerkelijk aan een project hangen, in het filter tonen.
  const filterClients = useMemo(() => {
    const usedIds = new Set(data.projects.map(project => project.client_id).filter(Boolean) as string[]);
    return data.clients
      .filter(client => usedIds.has(client.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }));
  }, [data.clients, data.projects]);

  const matchesFilters = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (project: Project) => {
      if (clientFilter === 'unassigned' && project.client_id) return false;
      if (clientFilter !== 'all' && clientFilter !== 'unassigned' && project.client_id !== clientFilter) return false;
      if (!needle) return true;
      const clientName = project.client_id ? (clientNameById.get(project.client_id) ?? '') : '';
      return [project.name, project.description ?? '', clientName]
        .some(field => field.toLowerCase().includes(needle));
    };
  }, [search, clientFilter, clientNameById]);

  const activeProjects = useMemo(
    () => sortProjects(data.projects.filter(project => !project.archived && matchesFilters(project)), data, sortKey),
    [data, matchesFilters, sortKey],
  );
  const archivedProjects = useMemo(
    () => sortProjects(data.projects.filter(project => project.archived && matchesFilters(project)), data, sortKey),
    [data, matchesFilters, sortKey],
  );

  const totalActive = useMemo(() => data.projects.filter(project => !project.archived).length, [data.projects]);
  const totalArchived = useMemo(() => data.projects.filter(project => project.archived).length, [data.projects]);
  const isFiltering = search.trim().length > 0 || clientFilter !== 'all';
  const visibleCount = activeProjects.length + archivedProjects.length;

  const changeViewMode = (nextViewMode: ProjectViewMode) => {
    setViewMode(nextViewMode);
    try {
      window.localStorage.setItem(projectViewStorageKey, nextViewMode);
    } catch {
      // LocalStorage is een UX-voorkeur; als dit faalt blijft de toggle gewoon werken tijdens de sessie.
    }
  };

  const changeSortKey = (nextSortKey: ProjectSortKey) => {
    setSortKey(nextSortKey);
    try {
      window.localStorage.setItem(projectSortStorageKey, nextSortKey);
    } catch {
      // Voorkeur; niet kritisch.
    }
  };

  const resetFilters = () => {
    setSearch('');
    setClientFilter('all');
  };

  const renderSection = (
    projects: Project[],
    title: string,
    description: string,
    emptyTitle: string,
    emptyText: string,
  ) => viewMode === 'table'
    ? <ProjectTableSection
        title={title}
        description={description}
        projects={projects}
        data={data}
        canWrite={canWrite}
        onOpenProject={onOpenProject}
        onEditProject={onEditProject}
        emptyTitle={emptyTitle}
        emptyText={emptyText}
      />
    : <ProjectGridSection
        title={title}
        description={description}
        projects={projects}
        data={data}
        canWrite={canWrite}
        onOpenProject={onOpenProject}
        onEditProject={onEditProject}
        emptyTitle={emptyTitle}
        emptyText={emptyText}
      />;

  return <div className="projects-page">
    <div className="projects-page-head">
      <div>
        <p className="eyebrow">Projecthub</p>
        <h2>Projecten</h2>
        <span>
          {isFiltering
            ? `${visibleCount} van ${totalActive + totalArchived} getoond`
            : `${totalActive} actief · ${totalArchived} gearchiveerd`}
        </span>
      </div>
      <div className="projects-toolbar-actions">
        <div className="project-view-toggle" role="group" aria-label="Projectweergave">
          <button type="button" className={viewMode === 'cards' ? 'active' : ''} onClick={() => changeViewMode('cards')} aria-pressed={viewMode === 'cards'}>Kaarten</button>
          <button type="button" className={viewMode === 'table' ? 'active' : ''} onClick={() => changeViewMode('table')} aria-pressed={viewMode === 'table'}>Tabel</button>
        </div>
        <Button variant="primary" onClick={onNewProject} disabled={!canWrite}>+ Nieuw project</Button>
      </div>
    </div>

    <div className="projects-filterbar">
      <div className="projects-search">
        <span className="projects-search-icon" aria-hidden="true">⌕</span>
        <input
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Zoek op project, omschrijving of klant"
          aria-label="Projecten zoeken"
        />
      </div>
      <Select
        className="projects-filter-select"
        inline
        value={clientFilter}
        onChange={event => setClientFilter(event.target.value)}
        aria-label="Filter op klant"
      >
        <option value="all">Alle klanten</option>
        <option value="unassigned">Zonder klant</option>
        {filterClients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
      </Select>
      <Select
        className="projects-filter-select"
        inline
        value={sortKey}
        onChange={event => changeSortKey(event.target.value as ProjectSortKey)}
        aria-label="Sorteren"
      >
        {projectSortOptions.map(option => <option key={option.key} value={option.key}>Sorteer: {option.label}</option>)}
      </Select>
      {isFiltering && <button type="button" className="projects-filter-reset" onClick={resetFilters}>Wis filters</button>}
    </div>

    {isFiltering && visibleCount === 0 ? <div className="empty project-empty">
      <div className="e-big">Geen projecten gevonden</div>
      <p>Geen project komt overeen met je zoekopdracht of filter. Pas je zoekterm aan of wis de filters.</p>
      <Button onClick={resetFilters}>Wis filters</Button>
    </div> : <>
      {renderSection(
        activeProjects,
        'Actieve projecten',
        'Open een project voor taken, notities en projectdetails.',
        isFiltering ? 'Geen actieve projecten voor dit filter' : 'Nog geen actieve projecten',
        isFiltering ? '' : 'Maak je eerste project aan of zet een ticket om naar een project.',
      )}

      {(archivedProjects.length > 0 || (totalArchived > 0 && !isFiltering)) && renderSection(
        archivedProjects,
        'Gearchiveerde projecten',
        'Deze projecten blijven inzichtelijk, maar zijn als afgerond of niet-actief gemarkeerd.',
        'Geen gearchiveerde projecten',
        '',
      )}
    </>}
  </div>;
}

function ProjectGridSection({
  title,
  description,
  projects,
  data,
  canWrite,
  onOpenProject,
  onEditProject,
  emptyTitle,
  emptyText,
}: {
  title: string;
  description: string;
  projects: Project[];
  data: AppData;
  canWrite: boolean;
  onOpenProject: (project: Project) => void;
  onEditProject: (project: Project) => void;
  emptyTitle: string;
  emptyText: string;
}) {
  return <section className="project-section">
    <div className="section-head-inline project-section-head">
      <div><h2>{title}</h2><p>{description}</p></div>
      <span>{projects.length}</span>
    </div>
    {projects.length === 0 ? <div className="empty project-empty"><div className="e-big">{emptyTitle}</div>{emptyText && <p>{emptyText}</p>}</div> : <div className="projects-grid">
      {projects.map(project => <ProjectListCard key={project.id} project={project} data={data} canWrite={canWrite} onOpen={() => onOpenProject(project)} onEdit={() => onEditProject(project)} />)}
    </div>}
  </section>;
}

function ProjectTableSection({
  title,
  description,
  projects,
  data,
  canWrite,
  onOpenProject,
  onEditProject,
  emptyTitle,
  emptyText,
}: {
  title: string;
  description: string;
  projects: Project[];
  data: AppData;
  canWrite: boolean;
  onOpenProject: (project: Project) => void;
  onEditProject: (project: Project) => void;
  emptyTitle: string;
  emptyText: string;
}) {
  return <section className="project-section">
    <div className="section-head-inline project-section-head">
      <div><h2>{title}</h2><p>{description}</p></div>
      <span>{projects.length}</span>
    </div>
    {projects.length === 0 ? <div className="empty project-empty"><div className="e-big">{emptyTitle}</div>{emptyText && <p>{emptyText}</p>}</div> : <div className="projects-table-card">
      <div className="projects-table-scroll">
        <table className="projects-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Klant</th>
              <th>Voortgang</th>
              <th className="number">Open</th>
              <th className="number">Te laat</th>
              <th className="number">Offertes</th>
              <th className="number">Facturen</th>
              <th>Periode</th>
              {canWrite && <th aria-label="Acties" />}
            </tr>
          </thead>
          <tbody>
            {projects.map(project => <ProjectTableRow
              key={project.id}
              project={project}
              data={data}
              canWrite={canWrite}
              onOpen={() => onOpenProject(project)}
              onEdit={() => onEditProject(project)}
            />)}
          </tbody>
        </table>
      </div>
    </div>}
  </section>;
}

function ProjectTableRow({ project, data, canWrite, onOpen, onEdit }: { project: Project; data: AppData; canWrite: boolean; onOpen: () => void; onEdit: () => void }) {
  const tasks = data.tasks.filter(task => task.project_id === project.id);
  const doneTasks = tasks.filter(task => task.status === 'done').length;
  const openTasks = tasks.length - doneTasks;
  const overdueTasks = tasks.filter(task => task.status !== 'done' && task.end_date && new Date(`${task.end_date}T23:59:59`) < new Date()).length;
  const progress = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;
  const client = data.clients.find(item => item.id === project.client_id);
  const projectQuotes = data.quotes.filter(quote => quote.project_id === project.id).length;
  const projectInvoices = data.invoices.filter(invoice => invoice.project_id === project.id).length;

  return <tr
    className={`projects-table-row ${project.archived ? 'is-archived' : ''}`}
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    }}
  >
    <td>
      <div className="projects-table-name">
        <span className="project-color-dot" style={{ background: project.color }} />
        <div className="projects-table-name-text">
          <strong>{project.name}</strong>
          {project.archived && <span className="status-pill archived">Gearchiveerd</span>}
        </div>
      </div>
    </td>
    <td><span>{client?.name ?? 'Geen klant'}</span></td>
    <td>
      <div className="projects-table-progress">
        <div className="prog-bar"><div className="prog-fill" style={{ width: `${progress}%`, background: project.color }} /></div>
        <span>{progress}% · {doneTasks}/{tasks.length}</span>
      </div>
    </td>
    <td className="number">{openTasks}</td>
    <td className="number">{overdueTasks > 0 ? <em className="projects-table-alert danger">{overdueTasks}</em> : '0'}</td>
    <td className="number">{projectQuotes}</td>
    <td className="number">{projectInvoices}</td>
    <td>
      <span className="projects-table-period">
        {project.start_date ? dateNL(project.start_date) : '—'} → {project.end_date ? dateNL(project.end_date) : '—'}
      </span>
    </td>
    {canWrite && <td className="projects-table-actions-cell">
      <Button onClick={(event) => { event.stopPropagation(); onEdit(); }}>Bewerken</Button>
    </td>}
  </tr>;
}

function ProjectListCard({ project, data, canWrite, onOpen, onEdit }: { project: Project; data: AppData; canWrite: boolean; onOpen: () => void; onEdit: () => void }) {
  const tasks = data.tasks.filter(task => task.project_id === project.id);
  const doneTasks = tasks.filter(task => task.status === 'done').length;
  const openTasks = tasks.length - doneTasks;
  const overdueTasks = tasks.filter(task => task.status !== 'done' && task.end_date && new Date(`${task.end_date}T23:59:59`) < new Date()).length;
  const progress = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;
  const client = data.clients.find(item => item.id === project.client_id);
  const projectNotes = data.notes.filter(note => note.project_id === project.id).length;
  const projectQuotes = data.quotes.filter(quote => quote.project_id === project.id).length;
  const projectInvoices = data.invoices.filter(invoice => invoice.project_id === project.id).length;

  return <article className={`project-list-card ${project.archived ? 'is-archived' : ''}`} onClick={onOpen}>
    <div className="project-list-top">
      <span className="project-color-dot" style={{ background: project.color }} />
      <div>
        <h3>{project.name}</h3>
        <p>{client?.name ?? 'Geen klant gekoppeld'}</p>
      </div>
      {project.archived && <span className="status-pill archived">Gearchiveerd</span>}
    </div>
    <p className="project-list-description">{project.description || 'Geen omschrijving toegevoegd.'}</p>
    <div className="project-progress-row">
      <span>{progress}% afgerond</span>
      <span>{doneTasks}/{tasks.length} taken</span>
    </div>
    <div className="prog-bar"><div className="prog-fill" style={{ width: `${progress}%`, background: project.color }} /></div>
    <div className="project-card-metrics">
      <span>{openTasks} open</span>
      <span className={overdueTasks > 0 ? 'danger' : ''}>{overdueTasks} te laat</span>
      <span>{projectNotes} notities</span>
      <span>{projectQuotes} offertes</span>
      <span>{projectInvoices} facturen</span>
    </div>
    <div className="project-card-footer">
      <span>{project.start_date ? `Start ${dateNL(project.start_date)}` : 'Geen startdatum'}</span>
      <span>{project.end_date ? `Einde ${dateNL(project.end_date)}` : 'Geen einddatum'}</span>
    </div>
    {canWrite && <div className="project-card-actions">
      <Button onClick={(event) => { event.stopPropagation(); onEdit(); }}>Bewerken</Button>
    </div>}
  </article>;
}

export function ProjectPage({
  data,
  project,
  organizationId,
  onChanged,
  canWrite,
  canAdmin,
  onNewTask,
  onEditTask,
  onEditProject,
  onNewQuote,
  onEditQuote,
  onNewInvoice,
  onSubmitQuoteApproval,
  onApproveQuote,
  onRejectQuote,
  onSendQuote,
  onConvertQuoteToInvoice,
  onDownloadQuotePdf,
  onEditInvoice,
  onNewNote,
  onEditNote,
  onNewDocument,
  onEditDocument,
  setTaskStatus,
}: {
  data: AppData;
  project: Project;
  organizationId: UUID;
  onChanged: () => void | Promise<void>;
  canWrite: boolean;
  canAdmin: boolean;
  onNewTask: () => void;
  onEditTask: (task: Task) => void;
  onEditProject: () => void;
  onNewQuote: () => void;
  onEditQuote: (quote: Quote) => void;
  onNewInvoice: () => void;
  onSubmitQuoteApproval: (quote: Quote) => void;
  onApproveQuote: (quote: Quote) => void;
  onRejectQuote: (quote: Quote) => void;
  onSendQuote: (quote: Quote) => void;
  onConvertQuoteToInvoice?: (quote: Quote) => void;
  onDownloadQuotePdf?: (quote: Quote) => void;
  onEditInvoice: (invoice: Invoice) => void;
  onNewNote: () => void;
  onEditNote: (note: Note) => void;
  onNewDocument: () => void;
  onEditDocument: (doc: InternalDocument) => void;
  setTaskStatus: (task: Task, status: TaskStatus) => void;
}) {
  const dragTaskId = useRef<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null);
  const [activeTab, setActiveTab] = useState<ProjectTab>('overview');
  const [timeModal, setTimeModal] = useState<{ entry: TimeEntry | null } | null>(null);

  const tasks = data.tasks.filter(t => t.project_id === project.id);
  const client = data.clients.find(c => c.id === project.client_id);
  const projectNotes = data.notes.filter(note => note.project_id === project.id);
  const projectDocuments = data.documents.filter(doc => doc.project_id === project.id);
  const projectQuotes = data.quotes.filter(q => q.project_id === project.id);
  const projectInvoices = data.invoices.filter(i => i.project_id === project.id);
  const projectTimeEntries = useMemo(
    () => data.timeEntries.filter(t => t.project_id === project.id).sort((a, b) => b.entry_date.localeCompare(a.entry_date)),
    [data.timeEntries, project.id],
  );
  const trackedMinutes = projectTimeEntries.reduce((s, t) => s + t.minutes, 0);
  const trackedValueCents = projectTimeEntries.reduce((s, t) => s + timeEntryValueCents(t), 0);

  async function removeTimeEntry(entry: TimeEntry) {
    if (!canWrite) return;
    if (!confirm('Deze urenregistratie verwijderen?')) return;
    await deleteTimeEntry(organizationId, entry.id);
    await onChanged();
  }

  async function toggleTimeEntryBillable(entry: TimeEntry) {
    if (!canWrite) return;
    await updateTimeEntry(organizationId, entry.id, { billable: !entry.billable });
    await onChanged();
  }

  const doneTasks = tasks.filter(t => t.status === 'done').length;
  const progress = tasks.length > 0 ? Math.round((doneTasks / tasks.length) * 100) : 0;
  const openTasks = tasks.filter(t => t.status !== 'done').length;
  const overdueTasks = tasks.filter(t => t.end_date && new Date(t.end_date) < new Date() && t.status !== 'done').length;
  const invoiceTotal = projectInvoices.reduce((sum, i) => sum + (i.lines?.reduce((s, l) => s + l.quantity * l.unit_price * (1 + (l.vat ?? 0) / 100), 0) ?? 0), 0);

  const switchTab = (tab: ProjectTab) => setActiveTab(tab);

  const tabs: Array<{ id: ProjectTab; label: string; count: number }> = [
    { id: 'overview', label: 'Overzicht', count: 0 },
    { id: 'kanban', label: 'Kanban', count: openTasks },
    { id: 'quotes', label: 'Offertes', count: projectQuotes.length },
    { id: 'invoices', label: 'Facturen', count: projectInvoices.length },
    { id: 'time', label: 'Uren', count: projectTimeEntries.length },
    { id: 'notes', label: 'Notities', count: projectNotes.length },
    { id: 'documents', label: 'Documenten', count: projectDocuments.length },
  ];

  return (
    <div className="proj-dashboard">

      {/* ── Hero header ── */}
      <div className="proj-dash-hero">
        <div className="proj-dash-hero-accent" style={{ background: project.color ?? 'var(--accent)' }} />
        <div className="proj-dash-hero-content">
          <div className="proj-dash-hero-text">
            <div className="proj-dash-hero-kicker">{client?.name ?? 'Geen klant'}</div>
            <h2 className="proj-dash-hero-name">{project.name}</h2>
            {project.description && <p className="proj-dash-hero-desc">{project.description}</p>}
            {project.archived && <span className="status-pill archived">Gearchiveerd</span>}
          </div>
          <div className="proj-dash-hero-actions">
            <Button onClick={onEditProject}>Bewerken</Button>
            <Button variant="primary" onClick={onNewTask} disabled={project.archived || !canWrite}>+ Taak</Button>
          </div>
        </div>

        {/* ── Klikbare stat strip ── */}
        <div className="proj-dash-stats">
          <button type="button" className="proj-dash-stat proj-dash-stat-btn" onClick={() => switchTab('kanban')}>
            <span className="proj-dash-stat-val">{tasks.length}</span>
            <span className="proj-dash-stat-lbl">Taken totaal</span>
          </button>
          <button type="button" className="proj-dash-stat proj-dash-stat-btn" onClick={() => switchTab('kanban')}>
            <span className="proj-dash-stat-val" style={{ color: 'var(--accent)' }}>{openTasks}</span>
            <span className="proj-dash-stat-lbl">Open</span>
          </button>
          <button type="button" className="proj-dash-stat proj-dash-stat-btn" onClick={() => switchTab('kanban')}>
            <span className="proj-dash-stat-val" style={{ color: overdueTasks > 0 ? 'var(--accent-r)' : 'inherit' }}>{overdueTasks}</span>
            <span className="proj-dash-stat-lbl">Te laat</span>
          </button>
          <button type="button" className="proj-dash-stat proj-dash-stat-btn" onClick={() => switchTab('quotes')}>
            <span className="proj-dash-stat-val">{projectQuotes.length}</span>
            <span className="proj-dash-stat-lbl">Offertes</span>
          </button>
          <button type="button" className="proj-dash-stat proj-dash-stat-btn" onClick={() => switchTab('invoices')}>
            <span className="proj-dash-stat-val">{projectInvoices.length > 0 ? euro(invoiceTotal) : '—'}</span>
            <span className="proj-dash-stat-lbl">Gefactureerd</span>
          </button>
          <button type="button" className="proj-dash-stat proj-dash-stat-btn" onClick={() => switchTab('time')}>
            <span className="proj-dash-stat-val">{trackedMinutes > 0 ? formatMinutes(trackedMinutes) : '—'}</span>
            <span className="proj-dash-stat-lbl">Uren</span>
          </button>
          <div className="proj-dash-stat proj-dash-stat-progress">
            <div className="proj-dash-progress-bar">
              <div className="proj-dash-progress-fill" style={{ width: `${progress}%`, background: project.color ?? 'var(--accent)' }} />
            </div>
            <span className="proj-dash-stat-lbl">{progress}% klaar</span>
          </div>
        </div>
      </div>

      {/* ── Tab bar ── */}
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
            {tab.count > 0 && <span className="client-tab-badge">{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* ── Tab: Overzicht ── */}
      {activeTab === 'overview' && <div className="client-overview-layout">
        <aside className="client-overview-sidebar">
          <article className="client-panel">
            <div className="client-panel-head"><h3>Projectgegevens</h3></div>
            <dl className="client-info-list">
              <div><dt>Klant</dt><dd>{client?.name ?? '—'}</dd></div>
              <div><dt>Facturatie</dt><dd>{project.billing_type === 'fixed_price' ? 'Aangenomen prijs' : 'Urenbasis'}{project.billing_type === 'hourly' && project.hourly_rate_cents != null ? ` · ${euro(project.hourly_rate_cents / 100)}/u` : ''}</dd></div>
              <div><dt>Startdatum</dt><dd>{dateNL(project.start_date) || '—'}</dd></div>
              <div><dt>Einddatum</dt><dd>{dateNL(project.end_date) || '—'}</dd></div>
              <div><dt>Aangemaakt</dt><dd>{dateNL(project.created_at)}</dd></div>
            </dl>
            <div className="proj-overview-progress">
              <div className="proj-overview-progress-bar">
                <div className="proj-overview-progress-fill" style={{ width: `${progress}%`, background: project.color ?? 'var(--accent)' }} />
              </div>
              <span className="proj-overview-progress-pct">{progress}% klaar · {doneTasks}/{tasks.length} taken</span>
            </div>
          </article>

          <article className="client-panel">
            <div className="client-panel-head">
              <h3>Taken per status</h3>
              <button type="button" className="client-overview-more-btn" onClick={() => switchTab('kanban')}>Kanban →</button>
            </div>
            <div className="proj-task-status-grid">
              {columns.map(col => (
                <button key={col.key} type="button" className={`proj-task-status-card ${col.key}`} onClick={() => switchTab('kanban')}>
                  <strong>{tasks.filter(t => t.status === col.key).length}</strong>
                  <span>{col.label}</span>
                </button>
              ))}
            </div>
          </article>
        </aside>

        <div className="client-overview-main">
          <article className="client-panel">
            <div className="client-panel-head">
              <h3>Recente offertes</h3>
              <button type="button" className="client-overview-more-btn" onClick={() => switchTab('quotes')}>
                Alle {projectQuotes.length} offertes →
              </button>
            </div>
            <div className="client-finance-list">
              {projectQuotes.length === 0 && <div className="client-empty-line">Nog geen offertes bij dit project.</div>}
              {projectQuotes.slice(0, 4).map(quote => {
                const qt = quote.lines?.reduce((s, l) => s + l.quantity * l.unit_price * (1 + (l.vat ?? 0) / 100), 0) ?? 0;
                return <button key={quote.id} type="button" className="client-finance-row" onClick={() => onEditQuote(quote)}>
                  <span className="client-finance-number">{quote.number}</span>
                  <span className="client-finance-meta">{dateNL(quote.date)}</span>
                  <span className="client-finance-amount">{euro(qt)}</span>
                  <span className={`client-finance-status ${quote.status}`}>{projectQuoteStatusLabels[quote.status] ?? quote.status}</span>
                </button>;
              })}
              {projectQuotes.length > 4 && <button type="button" className="client-overview-more-link" onClick={() => switchTab('quotes')}>+{projectQuotes.length - 4} meer offertes</button>}
            </div>
          </article>

          <article className="client-panel">
            <div className="client-panel-head">
              <h3>Recente facturen</h3>
              <button type="button" className="client-overview-more-btn" onClick={() => switchTab('invoices')}>
                Alle {projectInvoices.length} facturen →
              </button>
            </div>
            <div className="client-finance-list">
              {projectInvoices.length === 0 && <div className="client-empty-line">Nog geen facturen bij dit project.</div>}
              {projectInvoices.slice(0, 4).map(inv => {
                const invTotal = inv.lines?.reduce((s, l) => s + l.quantity * l.unit_price * (1 + (l.vat ?? 0) / 100), 0) ?? 0;
                const overdue = inv.status !== 'paid' && inv.status !== 'cancelled' && !!inv.due_date && inv.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10);
                return <button key={inv.id} type="button" className={`client-finance-row ${overdue ? 'is-overdue' : ''}`} onClick={() => onEditInvoice(inv)}>
                  <span className="client-finance-number">{inv.number}</span>
                  <span className="client-finance-meta">{dateNL(inv.date)} · Vervalt {dateNL(inv.due_date)}</span>
                  <span className="client-finance-amount">{euro(invTotal)}</span>
                  <span className={`client-finance-status ${overdue ? 'overdue' : inv.status}`}>{overdue ? 'Vervallen' : (projectInvoiceStatusLabels[inv.status] ?? inv.status)}</span>
                </button>;
              })}
              {projectInvoices.length > 4 && <button type="button" className="client-overview-more-link" onClick={() => switchTab('invoices')}>+{projectInvoices.length - 4} meer facturen</button>}
            </div>
          </article>
        </div>
      </div>}

      {/* ── Tab: Kanban ── */}
      {activeTab === 'kanban' && <div className="proj-kanban-tab">
        <div className="proj-kanban-tab-head">
          <span>{openTasks} open {openTasks === 1 ? 'taak' : 'taken'}{overdueTasks > 0 ? ` · ${overdueTasks} te laat` : ''}</span>
          {canWrite && !project.archived && <Button variant="primary" onClick={onNewTask}>+ Taak</Button>}
        </div>
        <div className="kanban proj-dash-kanban">
          {columns.map(col => (
            <div
              className={`kan-col${dragOverCol === col.key ? ' kan-drag-over' : ''}`}
              key={col.key}
              onDragOver={e => { e.preventDefault(); setDragOverCol(col.key); }}
              onDragLeave={() => setDragOverCol(null)}
              onDrop={e => {
                e.preventDefault();
                setDragOverCol(null);
                if (dragTaskId.current) {
                  const task = tasks.find(t => t.id === dragTaskId.current);
                  if (task && task.status !== col.key) setTaskStatus(task, col.key);
                  dragTaskId.current = null;
                }
              }}
            >
              <header className="kan-col-head">
                <span className="kan-dot" style={{ background: project.color }} />
                {col.label}
                <span className="kan-count">{tasks.filter(t => t.status === col.key).length}</span>
              </header>
              <div className="kan-body">
                {tasks.filter(t => t.status === col.key).map(task => (
                  <article
                    className="task-card"
                    key={task.id}
                    draggable={!project.archived && canWrite}
                    onDragStart={e => {
                      dragTaskId.current = task.id;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => { dragTaskId.current = null; setDragOverCol(null); }}
                    onClick={() => onEditTask(task)}
                  >
                    <div className="tc-title">{task.title}</div>
                    <div className="tc-desc">{task.description}</div>
                    <div className="tc-meta">
                      <span className={`pri-badge pri-${task.priority}`}>{priorityLabel(task.priority)}</span>
                      {task.tags?.map(tag => <span className="tag-pill" key={tag}>{tag}</span>)}
                    </div>
                    <div className="tc-footer">
                      <span>☑ {task.subtasks?.filter(s => s.done).length ?? 0}/{task.subtasks?.length ?? 0}</span>
                      <span>💬 {task.comments?.length ?? 0}</span>
                      <span className="tc-deadline">{dateNL(task.end_date)}</span>
                    </div>
                  </article>
                ))}
                {tasks.filter(t => t.status === col.key).length === 0 && (
                  <div className="kan-empty">Geen taken</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>}

      {/* ── Tab: Offertes ── */}
      {activeTab === 'quotes' && <article className="client-panel">
        <div className="client-panel-head">
          <h3>Offertes</h3>
          <div className="client-panel-head-right">
            <span>{projectQuotes.length}</span>
            {canWrite && !project.archived && <Button variant="primary" onClick={onNewQuote}>+ Offerte</Button>}
          </div>
        </div>
        <ProjectQuotesPanel
          data={data}
          projectId={project.id}
          canWrite={canWrite}
          canAdmin={canAdmin}
          onNewQuote={onNewQuote}
          onEditQuote={onEditQuote}
          onSubmitApproval={onSubmitQuoteApproval}
          onApprove={onApproveQuote}
          onReject={onRejectQuote}
          onSend={onSendQuote}
          onConvertToInvoice={onConvertQuoteToInvoice}
          onDownloadPdf={onDownloadQuotePdf}
          hideHeader
        />
      </article>}

      {/* ── Tab: Facturen ── */}
      {activeTab === 'invoices' && <article className="client-panel">
        <div className="client-panel-head">
          <h3>Facturen</h3>
          <div className="client-panel-head-right">
            <span>{projectInvoices.length}</span>
            {canWrite && !project.archived && <Button variant="primary" onClick={onNewInvoice}>+ Factuur</Button>}
          </div>
        </div>
        <div className="client-finance-list">
          {projectInvoices.length === 0 && <div className="client-empty-line">Nog geen facturen bij dit project. Zet een geaccepteerde offerte om naar factuur.</div>}
          {projectInvoices.map(inv => {
            const invTotal = inv.lines?.reduce((s, l) => s + l.quantity * l.unit_price * (1 + (l.vat ?? 0) / 100), 0) ?? 0;
            const overdue = inv.status !== 'paid' && inv.status !== 'cancelled' && !!inv.due_date && inv.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10);
            return <button key={inv.id} type="button" className={`client-finance-row ${overdue ? 'is-overdue' : ''}`} onClick={() => onEditInvoice(inv)}>
              <span className="client-finance-number">{inv.number}</span>
              <span className="client-finance-meta">{dateNL(inv.date)} · Vervalt {dateNL(inv.due_date)}</span>
              <span className="client-finance-amount">{euro(invTotal)}</span>
              <span className={`client-finance-status ${overdue ? 'overdue' : inv.status}`}>{overdue ? 'Vervallen' : (projectInvoiceStatusLabels[inv.status] ?? inv.status)}</span>
            </button>;
          })}
        </div>
      </article>}

      {/* ── Tab: Uren ── */}
      {activeTab === 'time' && <article className="client-panel">
        <div className="client-panel-head">
          <h3>Urenregistratie</h3>
          <div className="client-panel-head-right">
            <span>{formatMinutes(trackedMinutes)}{trackedValueCents > 0 ? ` · ${euro(trackedValueCents / 100)}` : ''}</span>
            {canWrite && !project.archived && <Button variant="primary" onClick={() => setTimeModal({ entry: null })}><Clock size={14} /> Uren loggen</Button>}
          </div>
        </div>
        {project.billing_type === 'fixed_price'
          ? <p className="settings-help" style={{ margin: '0 0 10px' }}>Aangenomen-prijs-project: uren worden geregistreerd voor inzicht, maar staan standaard niet-declarabel — factureren loopt via offerte/factuur.</p>
          : <p className="settings-help" style={{ margin: '0 0 10px' }}>Urenbasis-project: geregistreerde uren zijn declarabel en vormen de factuurbasis.</p>}
        <div className="proj-time-list">
          {projectTimeEntries.length === 0 && <div className="client-empty-line">Nog geen uren op dit project. Koppel een afspraak in de agenda of log handmatig uren.</div>}
          {projectTimeEntries.map(entry => {
            const value = timeEntryValueCents(entry);
            const editable = canWrite && entry.source !== 'calendar';
            return (
              <div className="proj-time-row" key={entry.id}>
                <span className="proj-time-date">{dateNL(entry.entry_date)}</span>
                <span className="proj-time-dur">{formatMinutes(entry.minutes)}</span>
                <span className="proj-time-desc">{entry.description || (entry.source === 'calendar' ? 'Agenda-afspraak' : 'Registratie')}</span>
                <span className={`tt-source-badge tt-source-${entry.source}`}>{entry.source === 'calendar' ? 'Agenda' : entry.source === 'timer' ? 'Timer' : 'Handmatig'}</span>
                <button type="button" className={`tt-billable-pill${entry.billable ? ' is-billable' : ''}`} disabled={!canWrite} onClick={() => toggleTimeEntryBillable(entry)} title="Declarabel aan/uit">{entry.billable ? 'Declarabel' : 'Niet decl.'}</button>
                <span className="proj-time-value">{value > 0 ? euro(value / 100) : '—'}</span>
                <span className="proj-time-actions">
                  {editable && <button type="button" className="icon-btn" onClick={() => setTimeModal({ entry })} title="Bewerken"><Pencil size={14} /></button>}
                  {editable && <button type="button" className="icon-btn danger" onClick={() => removeTimeEntry(entry)} title="Verwijderen"><Trash2 size={14} /></button>}
                </span>
              </div>
            );
          })}
        </div>
      </article>}

      {/* ── Tab: Notities ── */}
      {activeTab === 'notes' && <RelatedNotes
        title="Projectnotities"
        notes={projectNotes}
        data={data}
        canWrite={canWrite && !project.archived}
        onNew={onNewNote}
        onEdit={onEditNote}
        emptyText="Nog geen notities bij dit project."
      />}

      {/* ── Tab: Documenten ── */}
      {activeTab === 'documents' && <RelatedDocuments
        title="Documenten"
        documents={projectDocuments}
        data={data}
        canWrite={canWrite && !project.archived}
        onNew={onNewDocument}
        onEdit={onEditDocument}
        emptyText="Nog geen documenten bij dit project."
      />}

      {timeModal && (
        <TimeEntryModal
          organizationId={organizationId}
          data={data}
          entry={timeModal.entry}
          defaults={{ projectId: project.id, clientId: project.client_id }}
          onClose={() => setTimeModal(null)}
          onSaved={onChanged}
        />
      )}

    </div>
  );
}
