import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { DragEvent } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import type { AppData, Priority, Task, TaskStatus, UUID } from '../types';
import { Button, Input, Select } from '../components/Ui';
import { addDays, DAY_NAMES_NL, formatISODate, isoWeekNumber, isSameDay, parseISODate, startOfWeek } from '../lib/dates';
import { priorityLabel } from '../lib/format';

type StatusFilter = 'open' | 'all' | TaskStatus;

type PlannerFilters = {
  query: string;
  clientId: string;
  projectId: string;
  priority: 'all' | Priority;
  status: StatusFilter;
};

type DropTarget =
  | { type: 'day'; date: string; beforeTaskId?: UUID | null }
  | { type: 'unscheduled' };

type PlannerBucket = {
  tasks: Task[];
  count: number;
  minutes: number;
};

type ChecklistItem = {
  id: string;
  text: string;
  done: boolean;
};

const DEFAULT_TASK_ESTIMATE_MINUTES = 60;
const WEEKDAY_CAPACITY_MINUTES = 8 * 60;
const WEEKEND_CAPACITY_MINUTES = 0;

export function WeekPlanner({
  data,
  canWrite,
  onPlanTask,
  onEditTask,
}: {
  data: AppData;
  canWrite: boolean;
  onPlanTask: (taskId: UUID, plannedDate: string | null, beforeTaskId?: UUID | null) => Promise<void>;
  onEditTask: (task: Task) => void;
}) {
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [filters, setFilters] = useState<PlannerFilters>({ query: '', clientId: '', projectId: '', priority: 'all', status: 'open' });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const weekEnd = days[6];
  const dayKeys = useMemo(() => new Set(days.map(formatISODate)), [days]);

  const projectsById = useMemo(() => new Map(data.projects.map(project => [project.id, project])), [data.projects]);
  const clientsById = useMemo(() => new Map(data.clients.map(client => [client.id, client])), [data.clients]);

  const projectOptions = useMemo(() => {
    if (!filters.clientId) return data.projects;
    return data.projects.filter(project => project.client_id === filters.clientId);
  }, [data.projects, filters.clientId]);

  const filteredTasks = useMemo(() => {
    const normalizedQuery = filters.query.trim().toLowerCase();

    return data.tasks.filter(task => {
      const project = projectsById.get(task.project_id) ?? null;
      const client = project?.client_id ? clientsById.get(project.client_id) ?? null : null;

      if (filters.status === 'open' && task.status === 'done') return false;
      if (filters.status !== 'open' && filters.status !== 'all' && task.status !== filters.status) return false;
      if (filters.priority !== 'all' && task.priority !== filters.priority) return false;
      if (filters.projectId && task.project_id !== filters.projectId) return false;
      if (filters.clientId && project?.client_id !== filters.clientId) return false;

      if (!normalizedQuery) return true;
      const haystack = [
        task.title,
        task.description ?? '',
        task.tags?.join(' ') ?? '',
        project?.name ?? '',
        client?.name ?? '',
        client?.email ?? '',
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [clientsById, data.tasks, filters, projectsById]);

  const { byDay, unscheduled, outsideThisWeek, weekBucket } = useMemo(() => {
    const byDay = new Map<string, PlannerBucket>();
    const unscheduled: Task[] = [];
    const outsideThisWeek: Task[] = [];
    for (const day of days) byDay.set(formatISODate(day), { tasks: [], count: 0, minutes: 0 });

    for (const task of filteredTasks) {
      const plannedDate = task.planned_date ?? null;
      if (!plannedDate) {
        unscheduled.push(task);
        continue;
      }

      if (dayKeys.has(plannedDate)) {
        byDay.get(plannedDate)!.tasks.push(task);
      } else {
        outsideThisWeek.push(task);
      }
    }

    for (const bucket of byDay.values()) {
      bucket.tasks.sort(sortPlannedTasks);
      bucket.count = bucket.tasks.length;
      bucket.minutes = bucket.tasks.reduce((sum, task) => sum + taskEstimateMinutes(task), 0);
    }

    unscheduled.sort(sortLooseTasks);
    outsideThisWeek.sort(sortOutsideTasks);

    const weekTasks = Array.from(byDay.values()).flatMap(bucket => bucket.tasks);
    const weekBucket = {
      tasks: weekTasks,
      count: weekTasks.length,
      minutes: weekTasks.reduce((sum, task) => sum + taskEstimateMinutes(task), 0),
    };

    return { byDay, unscheduled, outsideThisWeek, weekBucket };
  }, [dayKeys, days, filteredTasks]);

  const todayLocal = new Date();
  const weekLabel = `Week ${isoWeekNumber(anchor)} · ${anchor.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })} – ${weekEnd.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  const totalCapacity = days.reduce((sum, day) => sum + dayCapacityMinutes(day), 0);

  function updateFilter<K extends keyof PlannerFilters>(key: K, value: PlannerFilters[K]) {
    setFilters(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'clientId') next.projectId = '';
      return next;
    });
  }

  function onDragStart(e: DragEvent, taskId: string) {
    if (!canWrite) return;
    setDragId(taskId);
    setError(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
  }

  function onDragEnd() {
    setDragId(null);
    setDragOverKey(null);
    setDragOverTaskId(null);
  }

  function onDragOver(e: DragEvent, key: string, beforeTaskId?: string | null) {
    if (!canWrite) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverKey !== key) setDragOverKey(key);
    setDragOverTaskId(beforeTaskId ?? null);
  }

  async function onDrop(e: DragEvent, target: DropTarget) {
    if (!canWrite) return;
    e.preventDefault();
    e.stopPropagation();
    const taskId = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    setDragOverKey(null);
    setDragOverTaskId(null);
    if (!taskId) return;

    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return;

    const plannedDate = target.type === 'day' ? target.date : null;
    const beforeTaskId = target.type === 'day' ? target.beforeTaskId ?? null : null;
    if (beforeTaskId === taskId) return;
    if ((task.planned_date ?? null) === plannedDate && !beforeTaskId) {
      const bucket = plannedDate ? byDay.get(plannedDate) : null;
      const isAlreadyLast = bucket ? bucket.tasks[bucket.tasks.length - 1]?.id === taskId : false;
      if (isAlreadyLast) return;
    }

    setError(null);
    try {
      await onPlanTask(taskId, plannedDate, beforeTaskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Planning bijwerken mislukt');
    }
  }

  const projectColor = (projectId: string) => projectsById.get(projectId)?.color ?? '#FFD966';
  const projectName = (projectId: string) => projectsById.get(projectId)?.name ?? '—';
  const clientName = (projectId: string) => {
    const clientId = projectsById.get(projectId)?.client_id;
    return clientId ? clientsById.get(clientId)?.name ?? null : null;
  };

  const taskCard = (task: Task, options: { plannedDate?: string | null; showPlannedDate?: boolean } = {}) => (
    <TaskCard
      key={task.id}
      task={task}
      projectName={projectName(task.project_id)}
      clientName={clientName(task.project_id)}
      projectColor={projectColor(task.project_id)}
      isDragging={dragId === task.id}
      isInsertTarget={dragOverTaskId === task.id}
      canWrite={canWrite}
      showPlannedDate={options.showPlannedDate}
      onDragStart={(event) => onDragStart(event, task.id)}
      onDragEnd={onDragEnd}
      onDragOver={options.plannedDate ? (event) => onDragOver(event, options.plannedDate!, task.id) : undefined}
      onDrop={options.plannedDate ? (event) => onDrop(event, { type: 'day', date: options.plannedDate!, beforeTaskId: task.id }) : undefined}
      onClick={() => onEditTask(task)}
    />
  );

  return <div className="week-planner">
    <div className="wp-toolbar">
      <Button onClick={() => setAnchor(prev => addDays(prev, -7))} title="Vorige week"><ChevronLeft size={14}/> Vorige</Button>
      <Button onClick={() => setAnchor(startOfWeek(new Date()))}>Vandaag</Button>
      <Button onClick={() => setAnchor(prev => addDays(prev, 7))} title="Volgende week">Volgende <ChevronRight size={14}/></Button>
      <div className="wp-week-label">{weekLabel}</div>
    </div>

    <section className="wp-summary" aria-label="Weekcapaciteit">
      <div className="wp-summary-main">
        <span>Weekcapaciteit</span>
        <strong>{weekBucket.count} taken · {formatDuration(weekBucket.minutes)} gepland</strong>
      </div>
      <div className="wp-summary-meta">
        <span>Richtlijn: {formatDuration(totalCapacity)}</span>
        <span>{totalCapacity > 0 ? `${Math.round((weekBucket.minutes / totalCapacity) * 100)}% bezet` : 'Geen capaciteit ingesteld'}</span>
        <span>{unscheduled.length} niet ingepland</span>
        <span>{outsideThisWeek.length} buiten deze week</span>
      </div>
    </section>

    <section className="wp-filters" aria-label="Weekplanner filters">
      <Input value={filters.query} onChange={e => updateFilter('query', e.target.value)} placeholder="Zoek op taak, project, klant of tag" />
      <Select value={filters.clientId} onChange={e => updateFilter('clientId', e.target.value)}>
        <option value="">Alle klanten</option>{data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
      </Select>
      <Select value={filters.projectId} onChange={e => updateFilter('projectId', e.target.value)}>
        <option value="">Alle projecten</option>{projectOptions.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </Select>
      <Select value={filters.priority} onChange={e => updateFilter('priority', e.target.value as PlannerFilters['priority'])}>
        <option value="all">Alle prioriteiten</option>
        <option value="high">Hoog</option>
        <option value="med">Normaal</option>
        <option value="low">Laag</option>
      </Select>
      <Select value={filters.status} onChange={e => updateFilter('status', e.target.value as StatusFilter)}>
        <option value="open">Open taken</option>
        <option value="todo">Te doen</option>
        <option value="doing">Bezig</option>
        <option value="review">Review</option>
        <option value="done">Klaar</option>
        <option value="all">Alle statussen</option>
      </Select>
    </section>

    {!canWrite && <div className="readonly-note">Je hebt alleen-lezen toegang. Taken openen kan, maar slepen/plannen is uitgeschakeld.</div>}
    {error && <div className="error">{error}</div>}

    <div className="wp-grid">
      {days.map((day, i) => {
        const key = formatISODate(day);
        const bucket = byDay.get(key) ?? { tasks: [], count: 0, minutes: 0 };
        const isToday = isSameDay(day, todayLocal);
        const isDropTarget = dragOverKey === key && !dragOverTaskId;
        const capacity = dayCapacityMinutes(day);
        return <div
          key={key}
          className={`wp-day ${isToday ? 'is-today' : ''} ${isDropTarget ? 'is-drop' : ''} ${capacity > 0 && bucket.minutes > capacity ? 'is-over-capacity' : ''}`}
          onDragOver={(e) => onDragOver(e, key, null)}
          onDragLeave={() => { if (dragOverKey === key) { setDragOverKey(null); setDragOverTaskId(null); } }}
          onDrop={(e) => onDrop(e, { type: 'day', date: key })}
        >
          <div className="wp-day-head">
            <span className="wp-day-name">{DAY_NAMES_NL[i]}</span>
            <span className="wp-day-num">{day.getDate()}</span>
            <span className="wp-day-count">{bucket.count} · {formatDuration(bucket.minutes)}</span>
          </div>
          <div className="wp-day-capacity">
            <span>{capacity ? `${Math.round((bucket.minutes / capacity) * 100)}% van dag` : 'Weekend'}</span>
            <span>{bucket.count === 1 ? '1 taak' : `${bucket.count} taken`}</span>
          </div>
          <div className="wp-day-body">
            {bucket.tasks.map(task => taskCard(task, { plannedDate: key }))}
            {bucket.tasks.length === 0 && <div className="wp-day-empty">Sleep een taak hierheen</div>}
            {bucket.tasks.length > 0 && <div className="wp-drop-to-bottom">Sleep hierheen voor onderaan</div>}
          </div>
        </div>;
      })}
    </div>

    <div className="wp-bottom-row">
      <PlannerSection
        title={`Niet ingepland (${unscheduled.length})`}
        className={`wp-unscheduled ${dragOverKey === '__unscheduled__' ? 'is-drop' : ''}`}
        onDragOver={(e) => onDragOver(e, '__unscheduled__')}
        onDragLeave={() => dragOverKey === '__unscheduled__' && setDragOverKey(null)}
        onDrop={(e) => onDrop(e, { type: 'unscheduled' })}
      >
        {unscheduled.map(task => taskCard(task))}
        {unscheduled.length === 0 && <div className="wp-day-empty">Geen taken zonder planning binnen deze filterselectie</div>}
      </PlannerSection>

      <PlannerSection title={`Buiten deze week (${outsideThisWeek.length})`} mutedText="Deze taken hebben wel een plandatum, maar vallen buiten de huidige week.">
        {outsideThisWeek.map(task => taskCard(task, { showPlannedDate: true }))}
        {outsideThisWeek.length === 0 && <div className="wp-day-empty">Geen geplande taken buiten deze week binnen deze filterselectie</div>}
      </PlannerSection>

      <WeekChecklist weekKey={formatISODate(anchor)} />
    </div>
  </div>;
}

function TaskCard({
  task,
  projectName,
  clientName,
  projectColor,
  isDragging,
  isInsertTarget,
  canWrite,
  showPlannedDate,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onClick,
}: {
  task: Task;
  projectName: string;
  clientName: string | null;
  projectColor: string;
  isDragging: boolean;
  isInsertTarget: boolean;
  canWrite: boolean;
  showPlannedDate?: boolean;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  onClick: () => void;
}) {
  return <article
    className={`wp-task ${isDragging ? 'is-dragging' : ''} ${isInsertTarget ? 'is-insert-target' : ''}`}
    draggable={canWrite}
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    onDragOver={onDragOver}
    onDrop={onDrop}
    onClick={onClick}
  >
    <span className="wp-task-dot" style={{ background: projectColor }}/>
    <div className="wp-task-body">
      <div className="wp-task-title">{task.title}</div>
      <div className="wp-task-meta">
        <span className="wp-task-project">{projectName}</span>
        {clientName && <span className="wp-task-client">{clientName}</span>}
        <span className={`pri-badge pri-${task.priority}`}>{priorityLabel(task.priority)}</span>
        <span className={`wp-task-status status-${task.status}`}>{statusLabel(task.status)}</span>
        <span className="wp-task-counts">☑ {task.subtasks?.filter(s => s.done).length ?? 0}/{task.subtasks?.length ?? 0} · 💬 {task.comments?.length ?? 0}</span>
      </div>
      <div className="wp-task-planning-meta">
        <span>{formatDuration(taskEstimateMinutes(task))}</span>
        {task.end_date && <span>Deadline {formatDateShort(task.end_date)}</span>}
        {showPlannedDate && task.planned_date && <span>Gepland {formatDateShort(task.planned_date)}</span>}
      </div>
    </div>
  </article>;
}

function PlannerSection({ title, mutedText, className, children, onDragOver, onDragLeave, onDrop }: {
  title: string;
  mutedText?: string;
  className?: string;
  children: React.ReactNode;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}) {
  return <section className={className ?? 'wp-unscheduled'} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <div className="wp-unscheduled-head">{title}{mutedText && <span className="wp-outside"> · {mutedText}</span>}</div>
    <div className="wp-unscheduled-body">{children}</div>
  </section>;
}

/** Voegt (van buitenaf, bijv. door Gerrie) een actiepunt toe aan de checklist van de
 *  week waar `dateIso` in valt, en seint het paneel om te verversen. */
export function addWeekChecklistItem(dateIso: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const weekKey = formatISODate(startOfWeek(parseISODate(dateIso)));
  const storageKey = `resofly-checklist-${weekKey}`;
  let items: ChecklistItem[] = [];
  try { items = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); } catch { items = []; }
  items.push({ id: crypto.randomUUID(), text: trimmed, done: false });
  localStorage.setItem(storageKey, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('resofly-checklist-changed', { detail: { weekKey } }));
}

function WeekChecklist({ weekKey }: { weekKey: string }) {
  const storageKey = `resofly-checklist-${weekKey}`;

  function load(): ChecklistItem[] {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]'); } catch { return []; }
  }

  const [items, setItems] = useState<ChecklistItem[]>(load);
  const [input, setInput] = useState('');
  const prevKey = useRef(weekKey);

  if (prevKey.current !== weekKey) {
    prevKey.current = weekKey;
    setItems(load());
    setInput('');
  }

  // Ververs als een actiepunt van buitenaf (bijv. via Gerrie) aan deze week is toegevoegd.
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { weekKey?: string } | undefined;
      if (!detail || detail.weekKey === weekKey) setItems(load());
    };
    window.addEventListener('resofly-checklist-changed', onChange);
    return () => window.removeEventListener('resofly-checklist-changed', onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekKey]);

  function save(next: ChecklistItem[]) {
    setItems(next);
    localStorage.setItem(`resofly-checklist-${weekKey}`, JSON.stringify(next));
  }

  function addItem() {
    const text = input.trim();
    if (!text) return;
    save([...items, { id: crypto.randomUUID(), text, done: false }]);
    setInput('');
  }

  const openItems = items.filter(i => !i.done);
  const doneItems = items.filter(i => i.done);

  return (
    <section className="wp-checklist">
      <div className="wp-checklist-head">
        <span>Actiepunten deze week</span>
        {items.length > 0 && (
          <span className="wp-checklist-count">{openItems.length} open · {doneItems.length} afgerond</span>
        )}
      </div>
      <div className="wp-checklist-body">
        <div className="wp-checklist-input-row">
          <input
            className="wp-checklist-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addItem(); }}
            placeholder="Voeg een actiepunt toe…"
          />
          <button className="wp-checklist-add" onClick={addItem} disabled={!input.trim()} title="Toevoegen">
            <Plus size={14} />
          </button>
        </div>
        {items.length === 0 && (
          <div className="wp-checklist-empty">Nog geen actiepunten voor deze week. Typ hierboven en druk op Enter.</div>
        )}
        {items.length > 0 && (
          <ul className="wp-checklist-list">
            {[...openItems, ...doneItems].map(item => (
              <li key={item.id} className={`wp-checklist-item ${item.done ? 'is-done' : ''}`}>
                <input
                  type="checkbox"
                  className="wp-checklist-checkbox"
                  checked={item.done}
                  id={`chk-${item.id}`}
                  onChange={() => save(items.map(i => i.id === item.id ? { ...i, done: !i.done } : i))}
                />
                <label htmlFor={`chk-${item.id}`} className="wp-checklist-label">{item.text}</label>
                <button
                  className="wp-checklist-delete"
                  onClick={() => save(items.filter(i => i.id !== item.id))}
                  title="Verwijderen"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function taskEstimateMinutes(task: Task): number {
  const raw = Number(task.estimated_minutes ?? DEFAULT_TASK_ESTIMATE_MINUTES);
  if (!Number.isFinite(raw)) return DEFAULT_TASK_ESTIMATE_MINUTES;
  return Math.max(0, Math.min(24 * 60, Math.round(raw)));
}

function dayCapacityMinutes(day: Date): number {
  const dayNumber = day.getDay();
  return dayNumber === 0 || dayNumber === 6 ? WEEKEND_CAPACITY_MINUTES : WEEKDAY_CAPACITY_MINUTES;
}

function sortPlannedTasks(a: Task, b: Task): number {
  const orderA = Number.isFinite(Number(a.planned_order)) ? Number(a.planned_order) : Number.MAX_SAFE_INTEGER;
  const orderB = Number.isFinite(Number(b.planned_order)) ? Number(b.planned_order) : Number.MAX_SAFE_INTEGER;
  if (orderA !== orderB) return orderA - orderB;
  return sortLooseTasks(a, b);
}

function sortOutsideTasks(a: Task, b: Task): number {
  const dateCompare = String(a.planned_date ?? '').localeCompare(String(b.planned_date ?? ''));
  if (dateCompare !== 0) return dateCompare;
  return sortPlannedTasks(a, b);
}

function sortLooseTasks(a: Task, b: Task): number {
  const priorityWeight: Record<Priority, number> = { high: 0, med: 1, low: 2 };
  const priorityCompare = priorityWeight[a.priority] - priorityWeight[b.priority];
  if (priorityCompare !== 0) return priorityCompare;
  return a.title.localeCompare(b.title, 'nl-NL');
}

function statusLabel(status: TaskStatus): string {
  return ({ todo: 'Te doen', doing: 'Bezig', review: 'Review', done: 'Klaar' } as Record<TaskStatus, string>)[status] ?? status;
}

function formatDuration(minutes: number): string {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const rest = safeMinutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}u`;
  return `${hours}u ${rest}m`;
}

function formatDateShort(date: string): string {
  return parseISODate(date).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' });
}
