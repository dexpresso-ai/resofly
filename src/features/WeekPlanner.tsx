import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { AppData, Task, UUID } from '../types';
import { Button } from '../components/Ui';
import { addDays, DAY_NAMES_NL, formatISODate, isoWeekNumber, isSameDay, parseISODate, startOfWeek } from '../lib/dates';
import { priorityLabel } from '../lib/format';

export function WeekPlanner({
  data,
  canWrite,
  onUpdateTaskDate,
  onEditTask,
}: {
  data: AppData;
  canWrite: boolean;
  onUpdateTaskDate: (taskId: UUID, endDate: string | null) => Promise<void>;
  onEditTask: (task: Task) => void;
}) {
  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const weekEnd = days[6];

  const { byDay, unscheduled, outsideThisWeek } = useMemo(() => {
    const byDay = new Map<string, Task[]>();
    const unscheduled: Task[] = [];
    const outsideThisWeek: Task[] = [];
    for (const day of days) byDay.set(formatISODate(day), []);

    for (const task of data.tasks) {
      if (task.status === 'done') continue;
      if (!task.end_date) { unscheduled.push(task); continue; }
      const taskDate = parseISODate(task.end_date);
      const inWeek = days.some(d => isSameDay(d, taskDate));
      if (inWeek) {
        const key = formatISODate(taskDate);
        byDay.get(key)!.push(task);
      } else {
        outsideThisWeek.push(task);
      }
    }
    return { byDay, unscheduled, outsideThisWeek };
  }, [data.tasks, days]);

  function onDragStart(e: React.DragEvent, taskId: string) {
    if (!canWrite) return;
    setDragId(taskId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
  }

  function onDragEnd() {
    setDragId(null);
    setDragOverKey(null);
  }

  function onDragOver(e: React.DragEvent, key: string) {
    if (!canWrite) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverKey !== key) setDragOverKey(key);
  }

  async function onDrop(e: React.DragEvent, target: { type: 'day'; date: string } | { type: 'unscheduled' }) {
    if (!canWrite) return;
    e.preventDefault();
    setDragOverKey(null);
    const taskId = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    if (!taskId) return;
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return;
    const newDate = target.type === 'day' ? target.date : null;
    if (task.end_date === newDate) return;
    setError(null);
    try { await onUpdateTaskDate(taskId, newDate); }
    catch (err) { setError(err instanceof Error ? err.message : 'Bijwerken mislukt'); }
  }

  const projectColor = (projectId: string) => data.projects.find(p => p.id === projectId)?.color ?? '#FFD966';
  const projectName = (projectId: string) => data.projects.find(p => p.id === projectId)?.name ?? '—';

  const todayLocal = new Date();
  const weekLabel = `Week ${isoWeekNumber(anchor)} · ${anchor.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })} – ${weekEnd.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' })}`;

  return <div className="week-planner">
    <div className="wp-toolbar">
      <Button onClick={() => setAnchor(prev => addDays(prev, -7))} title="Vorige week"><ChevronLeft size={14}/> Vorige</Button>
      <Button onClick={() => setAnchor(startOfWeek(new Date()))}>Vandaag</Button>
      <Button onClick={() => setAnchor(prev => addDays(prev, 7))} title="Volgende week">Volgende <ChevronRight size={14}/></Button>
      <div className="wp-week-label">{weekLabel}</div>
    </div>

    {!canWrite && <div className="readonly-note">Je hebt alleen-lezen toegang. Taken openen kan, maar slepen/plannen is uitgeschakeld.</div>}
    {error && <div className="error">{error}</div>}

    <div className="wp-grid">
      {days.map((day, i) => {
        const key = formatISODate(day);
        const tasks = byDay.get(key) ?? [];
        const isToday = isSameDay(day, todayLocal);
        const isDropTarget = dragOverKey === key;
        return <div
          key={key}
          className={`wp-day ${isToday ? 'is-today' : ''} ${isDropTarget ? 'is-drop' : ''}`}
          onDragOver={(e) => onDragOver(e, key)}
          onDragLeave={() => dragOverKey === key && setDragOverKey(null)}
          onDrop={(e) => onDrop(e, { type: 'day', date: key })}
        >
          <div className="wp-day-head">
            <span className="wp-day-name">{DAY_NAMES_NL[i]}</span>
            <span className="wp-day-num">{day.getDate()}</span>
            {tasks.length > 0 && <span className="wp-day-count">{tasks.length}</span>}
          </div>
          <div className="wp-day-body">
            {tasks.map(task => <article
              key={task.id}
              className={`wp-task ${dragId === task.id ? 'is-dragging' : ''}`}
              draggable={canWrite}
              onDragStart={(e) => onDragStart(e, task.id)}
              onDragEnd={onDragEnd}
              onClick={() => onEditTask(task)}
            >
              <span className="wp-task-dot" style={{ background: projectColor(task.project_id) }}/>
              <div className="wp-task-body">
                <div className="wp-task-title">{task.title}</div>
                <div className="wp-task-meta">
                  <span className="wp-task-project">{projectName(task.project_id)}</span>
                  <span className={`pri-badge pri-${task.priority}`}>{priorityLabel(task.priority)}</span>
                <span className="wp-task-counts">☑ {task.subtasks?.filter(s => s.done).length ?? 0}/{task.subtasks?.length ?? 0} · 💬 {task.comments?.length ?? 0}</span>
                </div>
              </div>
            </article>)}
            {tasks.length === 0 && <div className="wp-day-empty">Sleep een taak hierheen</div>}
          </div>
        </div>;
      })}
    </div>

    <div
      className={`wp-unscheduled ${dragOverKey === '__unscheduled__' ? 'is-drop' : ''}`}
      onDragOver={(e) => onDragOver(e, '__unscheduled__')}
      onDragLeave={() => dragOverKey === '__unscheduled__' && setDragOverKey(null)}
      onDrop={(e) => onDrop(e, { type: 'unscheduled' })}
    >
      <div className="wp-unscheduled-head">Niet ingepland ({unscheduled.length}){outsideThisWeek.length > 0 && <span className="wp-outside"> · {outsideThisWeek.length} buiten deze week</span>}</div>
      <div className="wp-unscheduled-body">
        {unscheduled.slice(0, 30).map(task => <article
          key={task.id}
          className={`wp-task ${dragId === task.id ? 'is-dragging' : ''}`}
          draggable={canWrite}
          onDragStart={(e) => onDragStart(e, task.id)}
          onDragEnd={onDragEnd}
          onClick={() => onEditTask(task)}
        >
          <span className="wp-task-dot" style={{ background: projectColor(task.project_id) }}/>
          <div className="wp-task-body">
            <div className="wp-task-title">{task.title}</div>
            <div className="wp-task-meta">
              <span className="wp-task-project">{projectName(task.project_id)}</span>
              <span className={`pri-badge pri-${task.priority}`}>{priorityLabel(task.priority)}</span>
            <span className="wp-task-counts">☑ {task.subtasks?.filter(s => s.done).length ?? 0}/{task.subtasks?.length ?? 0} · 💬 {task.comments?.length ?? 0}</span>
                </div>
          </div>
        </article>)}
        {unscheduled.length === 0 && <div className="wp-day-empty">Geen taken zonder datum</div>}
        {unscheduled.length > 30 && <div className="wp-day-empty">+ {unscheduled.length - 30} meer (open een project om in te plannen)</div>}
      </div>
    </div>
  </div>;
}
