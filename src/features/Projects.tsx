import { useMemo, useState } from 'react';
import type { AppData, Note, Project, Quote, Task, TaskStatus } from '../types';
import { Button } from '../components/Ui';
import { dateNL, priorityLabel } from '../lib/format';
import { RelatedNotes } from './Notes';
import { ProjectQuotesPanel } from './Finance';
import { ProjectTimeline } from './ProjectTimeline';

const columns: {key: TaskStatus; label: string}[] = [{key:'todo',label:'Te doen'}, {key:'doing',label:'Bezig'}, {key:'review',label:'Review'}, {key:'done',label:'Klaar'}];

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
    <section className="projects-hero projects-planning-hero">
      <div>
        <span className="eyebrow">Projectplanning</span>
        <h1>Planning en overlap per project</h1>
        <p>Een aparte, ruimere timeline-view onder Projecten. Zo blijft het dashboard compact, terwijl je hier rustig kunt sturen op planning, overlap, open taken en fases.</p>
      </div>
    </section>
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
      <select
        className="projects-filter-select"
        value={clientFilter}
        onChange={event => setClientFilter(event.target.value)}
        aria-label="Filter op klant"
      >
        <option value="all">Alle klanten</option>
        <option value="unassigned">Zonder klant</option>
        {filterClients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
      </select>
      <select
        className="projects-filter-select"
        value={sortKey}
        onChange={event => changeSortKey(event.target.value as ProjectSortKey)}
        aria-label="Sorteren"
      >
        {projectSortOptions.map(option => <option key={option.key} value={option.key}>Sorteer: {option.label}</option>)}
      </select>
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
  canWrite,
  canAdmin,
  onNewTask,
  onEditTask,
  onEditProject,
  onNewQuote,
  onEditQuote,
  onSubmitQuoteApproval,
  onApproveQuote,
  onRejectQuote,
  onSendQuote,
  onConvertQuoteToInvoice,
  onNewNote,
  onEditNote,
  setTaskStatus,
}: {
  data: AppData;
  project: Project;
  canWrite: boolean;
  canAdmin: boolean;
  onNewTask: () => void;
  onEditTask: (task: Task) => void;
  onEditProject: () => void;
  onNewQuote: () => void;
  onEditQuote: (quote: Quote) => void;
  onSubmitQuoteApproval: (quote: Quote) => void;
  onApproveQuote: (quote: Quote) => void;
  onRejectQuote: (quote: Quote) => void;
  onSendQuote: (quote: Quote) => void;
  onConvertQuoteToInvoice?: (quote: Quote) => void;
  onNewNote: () => void;
  onEditNote: (note: Note) => void;
  setTaskStatus: (task: Task, status: TaskStatus) => void;
}) {
  const tasks = data.tasks.filter(t => t.project_id === project.id);
  const client = data.clients.find(c => c.id === project.client_id);
  const projectNotes = data.notes.filter(note => note.project_id === project.id);

  return <>
    <div className="proj-fin-panel">
      <div className="proj-fin-header">
        <div>
          <h3>{project.name}</h3>
          <p className="pc-desc">{client?.name ?? 'Geen klant'} · {project.description ?? ''}</p>
          {project.archived && <span className="status-pill archived">Gearchiveerd</span>}
        </div>
        <div className="proj-actions"><Button onClick={onEditProject}>Project bewerken</Button><Button variant="primary" onClick={onNewTask} disabled={project.archived || !canWrite}>+ Taak</Button></div>
      </div>
    </div>
    <section className="kanban">{columns.map(col => <div className="kan-col" key={col.key}><header className="kan-col-head"><span className="kan-dot" style={{background: project.color}} />{col.label}<span className="kan-count">{tasks.filter(t=>t.status===col.key).length}</span></header><div className="kan-body">
      {tasks.filter(t=>t.status===col.key).map(task => <article className="task-card" key={task.id} onClick={() => onEditTask(task)}>
        <div className="tc-title">{task.title}</div><div className="tc-desc">{task.description}</div><div className="tc-meta"><span className={`pri-badge pri-${task.priority}`}>{priorityLabel(task.priority)}</span>{task.tags?.map(tag=><span className="tag-pill" key={tag}>{tag}</span>)}</div><div className="tc-footer"><span>☑ {task.subtasks?.filter(s=>s.done).length ?? 0}/{task.subtasks?.length ?? 0}</span><span>💬 {task.comments?.length ?? 0}</span><span className="tc-deadline">{dateNL(task.end_date)}</span></div>
        {!project.archived && canWrite && <div className="quick-status">{columns.filter(c=>c.key!==task.status).map(c=><button key={c.key} onClick={(e)=>{e.stopPropagation(); setTaskStatus(task,c.key);}}>{c.label}</button>)}</div>}
      </article>)}
      </div></div>)}</section>
    <ProjectQuotesPanel data={data} projectId={project.id} canWrite={canWrite && !project.archived} canAdmin={canAdmin && !project.archived} onNewQuote={onNewQuote} onEditQuote={onEditQuote} onSubmitApproval={onSubmitQuoteApproval} onApprove={onApproveQuote} onReject={onRejectQuote} onSend={onSendQuote} onConvertToInvoice={onConvertQuoteToInvoice} />
    <RelatedNotes title="Projectnotities" notes={projectNotes} data={data} canWrite={canWrite && !project.archived} onNew={onNewNote} onEdit={onEditNote} emptyText="Nog geen notities bij dit project." />
  </>;
}
