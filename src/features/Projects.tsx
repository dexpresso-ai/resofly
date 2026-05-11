import type { AppData, Note, Project, Task, TaskStatus } from '../types';
import { Button } from '../components/Ui';
import { dateNL, priorityLabel } from '../lib/format';
import { RelatedNotes } from './Notes';

const columns: {key: TaskStatus; label: string}[] = [{key:'todo',label:'Te doen'}, {key:'doing',label:'Bezig'}, {key:'review',label:'Review'}, {key:'done',label:'Klaar'}];
export function ProjectPage({
  data,
  project,
  canWrite,
  onNewTask,
  onEditTask,
  onEditProject,
  onNewNote,
  onEditNote,
  setTaskStatus,
}: {
  data: AppData;
  project: Project;
  canWrite: boolean;
  onNewTask: () => void;
  onEditTask: (task: Task) => void;
  onEditProject: () => void;
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
    <RelatedNotes title="Projectnotities" notes={projectNotes} data={data} canWrite={canWrite && !project.archived} onNew={onNewNote} onEdit={onEditNote} emptyText="Nog geen notities bij dit project." />
  </>;
}
