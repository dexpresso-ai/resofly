import type { AppData, Note, Project, Quote, Task, TaskStatus } from '../types';
import { Button } from '../components/Ui';
import { dateNL, priorityLabel } from '../lib/format';
import { RelatedNotes } from './Notes';
import { ProjectQuotesPanel } from './Finance';

const columns: {key: TaskStatus; label: string}[] = [{key:'todo',label:'Te doen'}, {key:'doing',label:'Bezig'}, {key:'review',label:'Review'}, {key:'done',label:'Klaar'}];

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
  const activeProjects = data.projects.filter(project => !project.archived);
  const archivedProjects = data.projects.filter(project => project.archived);
  const totalOpenTasks = data.tasks.filter(task => task.status !== 'done').length;
  const overdueTasks = data.tasks.filter(task => task.status !== 'done' && task.end_date && new Date(`${task.end_date}T23:59:59`) < new Date()).length;

  return <div className="projects-page">
    <section className="projects-hero">
      <div>
        <span className="eyebrow">Projecthub</span>
        <h1>Alle projecten op één plek</h1>
        <p>Projecten staan niet meer los in het zijmenu, maar netjes verzameld op deze pagina. De kleurbolletjes blijven behouden voor snelle herkenning.</p>
      </div>
      <div className="projects-hero-actions">
        <Button variant="primary" onClick={onNewProject} disabled={!canWrite}>+ Nieuw project</Button>
      </div>
    </section>

    <div className="project-summary-grid">
      <ProjectSummaryCard label="Actieve projecten" value={activeProjects.length} />
      <ProjectSummaryCard label="Gearchiveerd" value={archivedProjects.length} />
      <ProjectSummaryCard label="Open taken" value={totalOpenTasks} />
      <ProjectSummaryCard label="Taken te laat" value={overdueTasks} tone={overdueTasks > 0 ? 'danger' : 'default'} />
    </div>

    <ProjectGridSection
      title="Actieve projecten"
      description="Open een project voor taken, notities en projectdetails."
      projects={activeProjects}
      data={data}
      canWrite={canWrite}
      onOpenProject={onOpenProject}
      onEditProject={onEditProject}
      emptyTitle="Nog geen actieve projecten"
      emptyText="Maak je eerste project aan of zet een ticket om naar een project."
    />

    {archivedProjects.length > 0 && <ProjectGridSection
      title="Gearchiveerde projecten"
      description="Deze projecten blijven inzichtelijk, maar zijn als afgerond of niet-actief gemarkeerd."
      projects={archivedProjects}
      data={data}
      canWrite={canWrite}
      onOpenProject={onOpenProject}
      onEditProject={onEditProject}
      emptyTitle="Geen gearchiveerde projecten"
      emptyText=""
    />}
  </div>;
}

function ProjectSummaryCard({ label, value, tone = 'default' }: { label: string; value: string | number; tone?: 'default' | 'danger' }) {
  return <div className={`project-summary-card ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
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
