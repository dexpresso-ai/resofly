import { useEffect, useMemo, useState } from 'react';
import type { AppData, Priority, ProjectTemplate, ProjectTemplateTask, ProjectTemplateTaskInput, TaskStatus, UUID } from '../types';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { dateNL, uid } from '../lib/format';
import { addDays, formatISODate, parseISODate } from '../lib/dates';
import {
  createProjectTemplate,
  deleteProjectTemplate,
  saveProjectTemplateTasks,
  updateProjectTemplate,
} from '../lib/repository';
import { ChevronDown, ChevronRight, ChevronsDown, ChevronsUp, Copy, Trash2 } from 'lucide-react';

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Te doen',
  doing: 'Bezig',
  review: 'Review',
  done: 'Klaar',
};

const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Laag',
  med: 'Normaal',
  high: 'Hoog',
};

/**
 * Bewerkbare sjabloontaak in de editor. Tags staan hier bewust als losse tekst
 * (komma-gescheiden), net als in het taakvenster; pas bij opslaan wordt dat een
 * array. Zo kun je rustig doortypen zonder dat elke komma een tag oplevert.
 */
type DraftTask = Omit<ProjectTemplateTaskInput, 'tags' | 'position'> & { key: string; tagsText: string };

/** Leeg sjabloon-taakje, met dezelfde standaarden als een nieuwe gewone taak. */
function emptyDraftTask(): DraftTask {
  return {
    key: uid(),
    title: '',
    description: null,
    status: 'todo',
    priority: 'med',
    tagsText: '',
    start_offset_days: null,
    due_offset_days: null,
    planned_offset_days: null,
    estimated_minutes: 60,
    subtasks: [],
  };
}

function toDraftTask(task: ProjectTemplateTask): DraftTask {
  return {
    key: task.id,
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    tagsText: (task.tags ?? []).join(', '),
    start_offset_days: task.start_offset_days,
    due_offset_days: task.due_offset_days,
    planned_offset_days: task.planned_offset_days,
    estimated_minutes: task.estimated_minutes,
    subtasks: Array.isArray(task.subtasks) ? task.subtasks : [],
  };
}

function toDraftTasks(data: AppData, templateId: UUID): DraftTask[] {
  return data.projectTemplateTasks
    .filter(task => task.template_id === templateId)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .map(toDraftTask);
}

/** Leest een offsetveld: leeg blijft leeg (geen datum), anders een heel aantal dagen. */
function parseOffset(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Math.round(Number(trimmed));
  if (!Number.isFinite(parsed)) return null;
  return Math.min(3650, Math.max(-3650, parsed));
}

function offsetValue(value: number | null): string {
  return value === null ? '' : String(value);
}

/** "dag +14" / "dag −3" / "op de startdag" — leesbaar in plaats van een kaal getal. */
export function offsetLabel(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return 'op de startdag';
  return value > 0 ? `dag +${value}` : `dag −${Math.abs(value)}`;
}

/** Korte samenvatting van een sjabloon voor lijstjes en de projectkeuze. */
export function templateSummary(data: AppData, templateId: UUID): { tasks: number; subtasks: number } {
  const tasks = data.projectTemplateTasks.filter(task => task.template_id === templateId);
  return {
    tasks: tasks.length,
    subtasks: tasks.reduce((sum, task) => sum + (task.subtasks?.length ?? 0), 0),
  };
}

export function ProjectTemplatesManager({ data, organizationId, canWrite, onChanged }: {
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const templates = useMemo(
    () => [...data.projectTemplates].sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' })),
    [data.projectTemplates],
  );

  const [selectedId, setSelectedId] = useState<UUID | null>(templates[0]?.id ?? null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [tasks, setTasks] = useState<DraftTask[]>([]);
  const [openTaskKey, setOpenTaskKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selected = templates.find(template => template.id === selectedId) ?? null;

  // Is het geselecteerde sjabloon weg (verwijderd, of nog niets gekozen), val dan
  // terug op het eerste sjabloon in de lijst.
  useEffect(() => {
    if (selectedId && templates.some(template => template.id === selectedId)) return;
    setSelectedId(templates[0]?.id ?? null);
  }, [templates, selectedId]);

  // Laad het gekozen sjabloon in de editor. Bewust alleen op id-wissel: een
  // refresh van AppData mag niet je onopgeslagen wijzigingen overschrijven.
  useEffect(() => {
    if (!selected) {
      setName(''); setDescription(''); setIsActive(true); setTasks([]);
    } else {
      setName(selected.name);
      setDescription(selected.description ?? '');
      setIsActive(selected.is_active);
      setTasks(toDraftTasks(data, selected.id));
    }
    setOpenTaskKey(null);
    setDirty(false);
    setError(null);
    setMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function touch() {
    setDirty(true);
    setMessage(null);
  }

  function selectTemplate(template: ProjectTemplate) {
    if (dirty && !confirm('Je hebt niet-opgeslagen wijzigingen in dit sjabloon. Toch wisselen?')) return;
    setSelectedId(template.id);
  }

  function updateTask(key: string, patch: Partial<DraftTask>) {
    setTasks(prev => prev.map(task => task.key === key ? { ...task, ...patch } : task));
    touch();
  }

  function addTask() {
    const draft = emptyDraftTask();
    setTasks(prev => [...prev, draft]);
    setOpenTaskKey(draft.key);
    touch();
  }

  function duplicateTask(key: string) {
    setTasks(prev => {
      const index = prev.findIndex(task => task.key === key);
      if (index < 0) return prev;
      const source = prev[index];
      // Zonder `id` en met nieuwe subtaak-id's, zodat de kopie een échte nieuwe
      // rij wordt in plaats van dezelfde rij twee keer op te slaan.
      const copy: DraftTask = {
        ...source,
        key: uid(),
        id: undefined,
        title: `${source.title} (kopie)`,
        subtasks: source.subtasks.map(subtask => ({ id: uid(), label: subtask.label })),
      };
      return [...prev.slice(0, index + 1), copy, ...prev.slice(index + 1)];
    });
    touch();
  }

  function removeTask(key: string) {
    const task = tasks.find(item => item.key === key);
    if (task?.title.trim() && !confirm(`Taak "${task.title}" uit dit sjabloon verwijderen?`)) return;
    setTasks(prev => prev.filter(item => item.key !== key));
    touch();
  }

  function moveTask(key: string, direction: -1 | 1) {
    setTasks(prev => {
      const index = prev.findIndex(task => task.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    touch();
  }

  function updateSubtask(taskKey: string, subtaskId: UUID, label: string) {
    setTasks(prev => prev.map(task => task.key === taskKey
      ? { ...task, subtasks: task.subtasks.map(subtask => subtask.id === subtaskId ? { ...subtask, label } : subtask) }
      : task));
    touch();
  }

  function addSubtask(taskKey: string) {
    setTasks(prev => prev.map(task => task.key === taskKey
      ? { ...task, subtasks: [...task.subtasks, { id: uid(), label: '' }] }
      : task));
    touch();
  }

  function removeSubtask(taskKey: string, subtaskId: UUID) {
    setTasks(prev => prev.map(task => task.key === taskKey
      ? { ...task, subtasks: task.subtasks.filter(subtask => subtask.id !== subtaskId) }
      : task));
    touch();
  }

  async function createTemplate() {
    if (!canWrite || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const created = await createProjectTemplate(organizationId, { name: 'Nieuw sjabloon' });
      await onChanged();
      setSelectedId(created.id);
      setMessage('Sjabloon aangemaakt. Geef het een naam en voeg de standaardtaken toe.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sjabloon aanmaken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!selected || !canWrite || busy) return;
    const cleanName = name.trim();
    if (!cleanName) { setError('Geef het sjabloon een naam.'); return; }

    // Taken zonder titel zijn half-ingevulde regels; die slaan we niet op.
    const meaningful = tasks.filter(task => task.title.trim().length > 0);

    setBusy(true); setError(null); setMessage(null);
    try {
      await updateProjectTemplate(organizationId, selected.id, {
        name: cleanName,
        description,
        is_active: isActive,
      });
      const savedTasks = await saveProjectTemplateTasks(organizationId, selected.id, meaningful.map((task, index) => ({
        id: task.id,
        position: index,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        tags: task.tagsText.split(',').map(tag => tag.trim()).filter(Boolean),
        start_offset_days: task.start_offset_days,
        due_offset_days: task.due_offset_days,
        planned_offset_days: task.planned_offset_days,
        estimated_minutes: task.estimated_minutes,
        subtasks: task.subtasks.filter(subtask => subtask.label.trim().length > 0),
      })));
      await onChanged();
      // Neem de opgeslagen rijen (mét id) over, zodat nieuwe taken bij een
      // volgende keer opslaan bijgewerkt worden i.p.v. opnieuw aangemaakt.
      setTasks(savedTasks.map(toDraftTask));
      setOpenTaskKey(null);
      setDirty(false);
      const dropped = tasks.length - meaningful.length;
      setMessage(dropped > 0
        ? `Sjabloon opgeslagen. ${dropped} taak zonder titel is niet bewaard.`
        : 'Sjabloon opgeslagen.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sjabloon opslaan mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function removeTemplate() {
    if (!selected || !canWrite || busy) return;
    if (!confirm(`Sjabloon "${selected.name}" verwijderen? De standaardtaken erin verdwijnen mee. Projecten die eerder met dit sjabloon zijn aangemaakt blijven ongewijzigd.`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await deleteProjectTemplate(organizationId, selected.id);
      setSelectedId(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sjabloon verwijderen mislukt.');
    } finally {
      setBusy(false);
    }
  }

  const subtaskTotal = tasks.reduce((sum, task) => sum + task.subtasks.filter(s => s.label.trim()).length, 0);

  return <section className="settings-card organization-card tpl-card">
    <div className="settings-card-head">
      <div>
        <h3>Projectsjablonen</h3>
        <p className="settings-help">
          Werk je bij elk project op dezelfde manier? Leg die werkwijze hier één keer vast als standaardtaken met subtaken.
          Bij een nieuw project kies je het sjabloon en staan alle taken er meteen in. Deadlines leg je relatief vast
          ten opzichte van de startdatum, dus je hoeft nooit datums over te typen.
        </p>
      </div>
      {canWrite && <Button variant="primary" onClick={createTemplate} disabled={busy}>+ Nieuw sjabloon</Button>}
    </div>

    {message && <div className="success">{message}</div>}
    {error && <div className="error">{error}</div>}

    {!canWrite && <p className="settings-help">Je kunt sjablonen bekijken, maar alleen teamleden met schrijfrechten kunnen ze aanpassen.</p>}

    {templates.length === 0 ? <div className="tpl-empty">
      <strong>Nog geen sjablonen</strong>
      <p>Denk aan een vaste aanpak zoals “Filmproductie” (research → draaiboek → opnamedag → montage → oplevering) of “Verbouwing” (inmeten → offerte → materiaal bestellen → uitvoeren → oplevering).</p>
      {canWrite && <Button variant="primary" onClick={createTemplate} disabled={busy}>Maak je eerste sjabloon</Button>}
    </div> : <>
      <div className="tpl-list" role="tablist" aria-label="Projectsjablonen">
        {templates.map(template => {
          const summary = templateSummary(data, template.id);
          const active = template.id === selectedId;
          return <button
            key={template.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`tpl-chip${active ? ' is-active' : ''}${template.is_active ? '' : ' is-inactive'}`}
            onClick={() => selectTemplate(template)}
          >
            <strong>{template.name}</strong>
            <span>{summary.tasks} {summary.tasks === 1 ? 'taak' : 'taken'}{summary.subtasks > 0 ? ` · ${summary.subtasks} subtaken` : ''}</span>
            {!template.is_active && <em>Niet actief</em>}
          </button>;
        })}
      </div>

      {selected && <div className="tpl-editor">
        <div className="tpl-editor-grid">
          <label className="field">
            <span>Naam</span>
            <Input value={name} onChange={e => { setName(e.target.value); touch(); }} placeholder="Bijv. Filmproductie" disabled={!canWrite} />
          </label>
          <label className="field">
            <span>Omschrijving</span>
            <Textarea value={description} onChange={e => { setDescription(e.target.value); touch(); }} placeholder="Waar is dit sjabloon voor bedoeld?" disabled={!canWrite} />
            <small>Alleen voor jezelf en je team — de klant ziet dit niet.</small>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={isActive} onChange={e => { setIsActive(e.target.checked); touch(); }} disabled={!canWrite} />
            <span>Actief — laat dit sjabloon zien bij het aanmaken van een project</span>
          </label>
        </div>

        <div className="tpl-tasks-head">
          <div>
            <strong>Standaardtaken</strong>
            <span>{tasks.length} {tasks.length === 1 ? 'taak' : 'taken'}{subtaskTotal > 0 ? ` · ${subtaskTotal} subtaken` : ''}</span>
          </div>
          {canWrite && <Button onClick={addTask} disabled={busy}>+ Taak</Button>}
        </div>

        {tasks.length === 0 && <div className="tpl-empty-line">Nog geen taken in dit sjabloon. Voeg de stappen toe die je bij elk project doorloopt.</div>}

        <ol className="tpl-task-list">
          {tasks.map((task, index) => {
            const open = openTaskKey === task.key;
            return <li className={`tpl-task${open ? ' is-open' : ''}`} key={task.key}>
              <div className="tpl-task-row">
                <button
                  type="button"
                  className="tpl-task-toggle"
                  onClick={() => setOpenTaskKey(open ? null : task.key)}
                  aria-expanded={open}
                >
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <span className="tpl-task-index">{index + 1}</span>
                  <span className="tpl-task-title">{task.title.trim() || <em>Naamloze taak</em>}</span>
                </button>
                <span className="tpl-task-meta">
                  <span className={`pri-badge pri-${task.priority}`}>{PRIORITY_LABELS[task.priority]}</span>
                  {task.due_offset_days !== null && <span className="tpl-task-offset">Deadline {offsetLabel(task.due_offset_days)}</span>}
                  {task.subtasks.length > 0 && <span className="tpl-task-offset">☑ {task.subtasks.length}</span>}
                </span>
                {canWrite && <span className="tpl-task-actions">
                  <button type="button" className="icon-btn" onClick={() => moveTask(task.key, -1)} disabled={index === 0} title="Omhoog"><ChevronsUp size={14} /></button>
                  <button type="button" className="icon-btn" onClick={() => moveTask(task.key, 1)} disabled={index === tasks.length - 1} title="Omlaag"><ChevronsDown size={14} /></button>
                  <button type="button" className="icon-btn" onClick={() => duplicateTask(task.key)} title="Dupliceren"><Copy size={14} /></button>
                  <button type="button" className="icon-btn danger" onClick={() => removeTask(task.key)} title="Verwijderen"><Trash2 size={14} /></button>
                </span>}
              </div>

              {open && <div className="tpl-task-body">
                <label className="field">
                  <span>Taaktitel</span>
                  <Input value={task.title} onChange={e => updateTask(task.key, { title: e.target.value })} placeholder="Bijv. Draaiboek maken" disabled={!canWrite} />
                </label>
                <label className="field">
                  <span>Beschrijving</span>
                  <Textarea value={task.description ?? ''} onChange={e => updateTask(task.key, { description: e.target.value })} placeholder="Wat houdt deze stap in?" disabled={!canWrite} />
                </label>

                <div className="tpl-task-fields">
                  <label className="field field-compact">
                    <span>Status</span>
                    <Select value={task.status} onChange={e => updateTask(task.key, { status: e.target.value as TaskStatus })} disabled={!canWrite}>
                      {(Object.keys(STATUS_LABELS) as TaskStatus[]).map(status => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
                    </Select>
                  </label>
                  <label className="field field-compact">
                    <span>Prioriteit</span>
                    <Select value={task.priority} onChange={e => updateTask(task.key, { priority: e.target.value as Priority })} disabled={!canWrite}>
                      {(Object.keys(PRIORITY_LABELS) as Priority[]).map(priority => <option key={priority} value={priority}>{PRIORITY_LABELS[priority]}</option>)}
                    </Select>
                  </label>
                  <label className="field field-compact">
                    <span>Geschatte duur (min)</span>
                    <Input
                      type="number" min="0" max="1440" step="15"
                      value={String(task.estimated_minutes)}
                      onChange={e => updateTask(task.key, { estimated_minutes: Math.min(1440, Math.max(0, Math.round(Number(e.target.value) || 0))) })}
                      disabled={!canWrite}
                    />
                  </label>
                  <label className="field field-compact">
                    <span>Tags</span>
                    <Input value={task.tagsText} onChange={e => updateTask(task.key, { tagsText: e.target.value })} placeholder="Komma gescheiden" disabled={!canWrite} />
                  </label>
                </div>

                <div className="tpl-offsets">
                  <p className="settings-help">Dagen ten opzichte van de startdatum van het project. Leeg = geen datum. <strong>0</strong> is de startdag zelf, <strong>-2</strong> is twee dagen ervoor.</p>
                  <div className="tpl-task-fields">
                    <label className="field field-compact">
                      <span>Start</span>
                      <Input type="number" min="-3650" max="3650" value={offsetValue(task.start_offset_days)} onChange={e => updateTask(task.key, { start_offset_days: parseOffset(e.target.value) })} placeholder="—" disabled={!canWrite} />
                      <small>{offsetLabel(task.start_offset_days)}</small>
                    </label>
                    <label className="field field-compact">
                      <span>Deadline</span>
                      <Input type="number" min="-3650" max="3650" value={offsetValue(task.due_offset_days)} onChange={e => updateTask(task.key, { due_offset_days: parseOffset(e.target.value) })} placeholder="—" disabled={!canWrite} />
                      <small>{offsetLabel(task.due_offset_days)}</small>
                    </label>
                    <label className="field field-compact">
                      <span>Plandatum</span>
                      <Input type="number" min="-3650" max="3650" value={offsetValue(task.planned_offset_days)} onChange={e => updateTask(task.key, { planned_offset_days: parseOffset(e.target.value) })} placeholder="—" disabled={!canWrite} />
                      <small>Zet de taak op deze dag in de weekplanner.</small>
                    </label>
                  </div>
                </div>

                <div className="tpl-subtasks">
                  <div className="tes-head">
                    <div><strong>Subtaken</strong><span>{task.subtasks.length}</span></div>
                    {canWrite && <Button onClick={() => addSubtask(task.key)}>+ Subtaak</Button>}
                  </div>
                  <div className="subtask-list">
                    {task.subtasks.map(subtask => <div className="subtask-row" key={subtask.id}>
                      <Input value={subtask.label} onChange={e => updateSubtask(task.key, subtask.id, e.target.value)} placeholder="Bijv. shotlist doornemen" disabled={!canWrite} />
                      {canWrite && <Button variant="ghost" onClick={() => removeSubtask(task.key, subtask.id)}>×</Button>}
                    </div>)}
                    {task.subtasks.length === 0 && <div className="tpl-empty-line">Nog geen subtaken. Handig voor de vaste checklist binnen deze stap.</div>}
                  </div>
                </div>
              </div>}
            </li>;
          })}
        </ol>

        {canWrite && <div className="tpl-editor-foot">
          <Button variant="primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Opslaan…' : dirty ? 'Sjabloon opslaan' : 'Opgeslagen'}</Button>
          <Button variant="danger" onClick={removeTemplate} disabled={busy}>Sjabloon verwijderen</Button>
          {dirty && <span className="tpl-dirty">Niet-opgeslagen wijzigingen</span>}
        </div>}
      </div>}
    </>}
  </section>;
}

/** Zet een dagoffset om naar een echte datum t.o.v. de projectstart. */
function offsetToDate(startDate: string, offset: number | null): string | null {
  if (!startDate || offset === null) return null;
  return formatISODate(addDays(parseISODate(startDate), offset));
}

/**
 * Sjabloonkeuze bij een nieuw project. Toont meteen wélke taken er worden
 * aangemaakt en — zodra er een startdatum staat — op welke datums ze landen.
 * Zonder startdatum komen de taken zonder datum binnen; dat zegt de hint er ook bij.
 */
export function ProjectTemplatePicker({ data, value, startDate, disabled, onChange }: {
  data: AppData;
  value: string;
  startDate: string;
  disabled: boolean;
  onChange: (templateId: string) => void;
}) {
  const options = useMemo(
    () => data.projectTemplates
      .filter(template => template.is_active)
      .sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' })),
    [data.projectTemplates],
  );

  const tasks = useMemo(
    () => value
      ? data.projectTemplateTasks
          .filter(task => task.template_id === value)
          .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
      : [],
    [data.projectTemplateTasks, value],
  );

  if (options.length === 0) return null;

  const subtaskTotal = tasks.reduce((sum, task) => sum + (task.subtasks?.length ?? 0), 0);

  return <div className="tpl-pick">
    <div className="tpl-pick-head">
      <strong>Beginnen vanuit een sjabloon</strong>
      <span className="tpl-task-offset">Optioneel</span>
    </div>
    <Select value={value} onChange={e => onChange(e.target.value)} disabled={disabled} aria-label="Projectsjabloon">
      <option value="">Geen sjabloon — leeg project</option>
      {options.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
    </Select>

    {value && tasks.length === 0 && <p className="settings-help">Dit sjabloon heeft nog geen taken. Vul het aan onder Instellingen → Projectsjablonen.</p>}

    {tasks.length > 0 && <>
      <p className="settings-help">
        {tasks.length} {tasks.length === 1 ? 'taak' : 'taken'}{subtaskTotal > 0 ? ` en ${subtaskTotal} subtaken` : ''} worden meteen aangemaakt.
        {startDate
          ? ' De datums hieronder zijn berekend vanaf de startdatum van dit project.'
          : ' Vul een startdatum in om de taken ook meteen in te plannen — zonder startdatum komen ze zonder datum binnen.'}
      </p>
      <div className="tpl-pick-preview">
        <ol>
          {tasks.map((task, index) => {
            const due = offsetToDate(startDate, task.due_offset_days);
            return <li key={task.id}>
              <div className="tpl-pick-row">
                <span className="tpl-task-index">{index + 1}</span>
                <strong>{task.title}</strong>
                {due
                  ? <span className="tpl-pick-date">{dateNL(due)}</span>
                  : task.due_offset_days !== null && <span className="tpl-pick-date">{offsetLabel(task.due_offset_days)}</span>}
              </div>
              {(task.subtasks?.length ?? 0) > 0 && <div className="tpl-pick-sub">
                {task.subtasks.map(subtask => subtask.label).join(' · ')}
              </div>}
            </li>;
          })}
        </ol>
      </div>
    </>}
  </div>;
}
