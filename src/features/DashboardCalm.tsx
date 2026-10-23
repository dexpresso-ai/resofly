import { useEffect, useId, useState, type ReactNode } from 'react';
import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, MapPin, Video } from 'lucide-react';
import type { CalendarExternalEvent, Client, Project, Task } from '../types';
import { taskDayKey } from '../lib/workweek';
import { formatClock } from '../lib/sun';

/**
 * Onbewolkt (2026-10-23): Vandaag in Zenit, zonder dat hetzelfde feit twee of
 * drie keer op het scherm staat. De Dagboog bovenaan is het beeld van je dag;
 * hieronder staan de woorden (Je dag), wat op je wacht (Aandacht), en achter
 * één balk de rest: de week, de projecten, de cijfers.
 *
 * Alles hier is weergave. Wat erin gaat, rekent Dashboard.tsx uit; zo blijven
 * de regels voor "mijn" taken, rechten en "te laat" op één plek.
 */

const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const minutesOfDay = (date: Date) => date.getHours() * 60 + date.getMinutes();

// ── Je dag ──────────────────────────────────────────────────────────────────

type AgendaEntry =
  | { kind: 'event'; key: string; start: number; end: number; event: CalendarExternalEvent }
  | { kind: 'task'; key: string; start: number; end: number; task: Task };

/** Afspraken en taken van vandaag in de volgorde van de klok, met een gouden
 *  lijn op "nu". Wat is blijven liggen staat erboven, wat nog geen tijd heeft
 *  eronder. Een taak afvinken gaat met dezelfde regel als overal op het
 *  dashboard (`renderTask`). */
export function DayAgenda({ events, lingering, tasks, todayKey, dayStartIso, renderTask, onOpenCalendar, tools, moreLingering = 0, onOpenPlanner }: {
  events: CalendarExternalEvent[];
  lingering: Task[];
  tasks: Task[];
  todayKey: string;
  dayStartIso: string;
  renderTask: (task: Task) => ReactNode;
  onOpenCalendar?: () => void;
  /** Rechts in de kop: Mijn / Team. */
  tools?: ReactNode;
  moreLingering?: number;
  onOpenPlanner?: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const nowMin = minutesOfDay(now);
  const dayStart = new Date(dayStartIso).getTime();
  const minuteOf = (iso: string) => Math.max(0, Math.min(1440, (new Date(iso).getTime() - dayStart) / 60000));

  const allDay = events.filter(event => event.all_day);
  const timed: AgendaEntry[] = [
    ...events.filter(event => !event.all_day).map(event => ({
      kind: 'event' as const,
      key: `event-${event.source_id}:${event.id}`,
      start: minuteOf(event.starts_at),
      end: minuteOf(event.ends_at),
      event,
    })),
    ...tasks
      .filter(task => task.planned_date === todayKey && task.planned_start_minute != null && !task.planned_end_date)
      .map(task => ({
        kind: 'task' as const,
        key: `task-${task.id}`,
        start: task.planned_start_minute ?? 0,
        end: (task.planned_start_minute ?? 0) + (task.estimated_minutes ?? 60),
        task,
      })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);
  const timedTaskIds = new Set(timed.flatMap(entry => entry.kind === 'task' ? [entry.task.id] : []));
  const untimed = tasks.filter(task => !timedTaskIds.has(task.id));
  // De nu-lijn staat vóór het eerste item dat nog moet beginnen.
  const nowIndex = timed.findIndex(entry => entry.start > nowMin);
  const nowAt = nowIndex === -1 ? timed.length : nowIndex;

  const meetingCount = events.length;
  const taskCount = tasks.filter(task => task.status !== 'done').length + lingering.length;
  const summary = meetingCount + taskCount === 0
    ? 'Niets gepland'
    : [meetingCount ? pl(meetingCount, 'afspraak', 'afspraken') : '', taskCount ? pl(taskCount, 'taak', 'taken') : ''].filter(Boolean).join(' · ');

  const nowLine = <div className="zag-now" aria-label={`Nu, ${formatClock(nowMin)}`} key="nu"><span>nu · {formatClock(nowMin)}</span></div>;

  return <section className="zcard zagenda" aria-label="Je dag">
    <header className="zcard-h">
      <div><h2>Je dag</h2><p>{summary}</p></div>
      {tools}
    </header>

    {lingering.length > 0 && <div className="zag-group is-late">
      <div className="zag-label">Blijft liggen</div>
      {lingering.map(task => <div className="zag-row" key={task.id}><span className="zag-time" aria-hidden="true" />{renderTask(task)}</div>)}
      {moreLingering > 0 && <button type="button" className="zag-more" onClick={onOpenPlanner}>Nog {moreLingering} in de weekplanner <ChevronRight size={13} aria-hidden="true" /></button>}
    </div>}

    {allDay.length > 0 && <div className="zag-allday">
      <CalendarClock size={14} aria-hidden="true" />
      <span>Hele dag: {allDay.map(event => event.title || 'Afspraak').join(' · ')}</span>
    </div>}

    {timed.length > 0 && <div className="zag-group">
      {timed.flatMap((entry, index) => {
        const nodes: ReactNode[] = [];
        if (index === nowAt) nodes.push(nowLine);
        const past = entry.end <= nowMin;
        const live = entry.start <= nowMin && nowMin < entry.end;
        if (entry.kind === 'task') {
          nodes.push(<div className={`zag-row${past ? ' is-past' : ''}`} key={entry.key}>
            <span className="zag-time">{formatClock(entry.start)}</span>
            {renderTask(entry.task)}
          </div>);
        } else {
          const event = entry.event;
          const where = event.location || null;
          nodes.push(<div className={`zag-row zag-event${past ? ' is-past' : ''}${live ? ' is-now' : ''}`} key={entry.key}>
            <span className="zag-time">{formatClock(entry.start)}</span>
            <button type="button" className="zag-ev-main" onClick={onOpenCalendar} disabled={!onOpenCalendar}>
              <span className="zag-ev-ic" aria-hidden="true">{event.meeting_url ? <Video size={14} /> : <CalendarClock size={14} />}</span>
              <span className="zag-ev-t">
                <strong>{event.title || 'Afspraak'}</strong>
                <span>tot {formatClock(entry.end)}{where && <><MapPin size={11} aria-hidden="true" />{where}</>}</span>
              </span>
            </button>
            {event.meeting_url && !past && <a className="btn zag-join" href={event.meeting_url} target="_blank" rel="noreferrer">Deelnemen</a>}
          </div>);
        }
        if (index === timed.length - 1 && nowAt === timed.length) nodes.push(nowLine);
        return nodes;
      })}
    </div>}

    {untimed.length > 0 && <div className="zag-group">
      <div className="zag-label">{timed.length > 0 ? 'Ergens vandaag' : 'Vandaag'}</div>
      {untimed.map(task => <div className="zag-row" key={task.id}><span className="zag-time" aria-hidden="true" />{renderTask(task)}</div>)}
    </div>}

    {timed.length === 0 && untimed.length === 0 && lingering.length === 0 && allDay.length === 0 && <p className="zag-empty">
      Een open dag. Plan iets in de weekplanner, of geniet ervan.
    </p>}
  </section>;
}

// ── Aandacht ────────────────────────────────────────────────────────────────

export type CalmSignal = { key: string; tone: 'default' | 'danger'; icon: ReactNode; label: string; meta?: string; onClick: () => void };

/** Wat op je wacht, één regel per soort. Leeg is ook een antwoord. */
export function AttentionList({ items }: { items: CalmSignal[] }) {
  return <section className="zcard zsignals" aria-label="Aandacht">
    <header className="zcard-h">
      <div><h2>Aandacht</h2><p>{items.length ? pl(items.length, 'ding wacht op je', 'dingen wachten op je') : 'Alles is bij'}</p></div>
    </header>
    {items.length === 0
      ? <div className="zsig-empty">
          <span className="zsig-ic is-ok" aria-hidden="true"><CheckCircle2 size={16} /></span>
          <span><b>Niets dat op je wacht</b>Geen te late facturen, open tickets of taken over hun deadline.</span>
        </div>
      : <div className="zsig-list">
          {items.map(item => <button type="button" key={item.key} className={`zsig-row${item.tone === 'danger' ? ' is-danger' : ''}`} onClick={item.onClick}>
            <span className="zsig-ic" aria-hidden="true">{item.icon}</span>
            <span className="zsig-t"><b>{item.label}</b>{item.meta && <span>{item.meta}</span>}</span>
            <ChevronRight size={15} className="zsig-chev" aria-hidden="true" />
          </button>)}
        </div>}
  </section>;
}

// ── Meer van vandaag ───────────────────────────────────────────────────────

const FOLD_KEY = 'resofly.dashboard.meer';

/** De rest van het dashboard achter één balk. Dicht fluistert hij de
 *  belangrijkste cijfers; open toont hij week, projecten, cijfers en
 *  rapportages. De stand wordt onthouden. */
export function MoreFold({ whisper, children }: { whisper: string[]; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(FOLD_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(FOLD_KEY, open ? '1' : '0'); } catch { /* privémodus: dan alleen voor nu */ }
  }, [open]);
  const bodyId = useId();
  return <section className={`zfold${open ? ' is-open' : ''}`}>
    <button type="button" className="zfold-bar" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
      <span className="zfold-t">{open ? 'Minder' : 'Meer van vandaag'}</span>
      {!open && whisper.length > 0 && <span className="zfold-w">{whisper.join(' · ')}</span>}
      <ChevronDown size={16} className="zfold-chev" aria-hidden="true" />
    </button>
    <div id={bodyId} className="zfold-body" hidden={!open}>{open && children}</div>
  </section>;
}

// ── Deze week ───────────────────────────────────────────────────────────────

/** De week in getallen: per dag hoeveel er openstaat, met de kleuren van de
 *  projecten. Vandaag in detail staat erboven; dit is de rest, zacht. */
export function WeekStrip({ dayKeys, todayKey, tasks, projects, weekNumber, onOpen }: {
  dayKeys: string[];
  todayKey: string;
  tasks: Task[];
  projects: Project[];
  weekNumber: number;
  onOpen: () => void;
}) {
  const colorOf = new Map(projects.map(project => [project.id, project.color]));
  const byDay = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = taskDayKey(task);
    if (!key) continue;
    const list = byDay.get(key);
    if (list) list.push(task); else byDay.set(key, [task]);
  }
  return <section className="zcard zweek" aria-label="Deze week">
    <header className="zcard-h">
      <div><h2>Deze week</h2><p>Week {weekNumber} · {pl(tasks.length, 'open actie', 'open acties')}</p></div>
      <button type="button" className="zlink" onClick={onOpen}>Weekplanner <ChevronRight size={14} aria-hidden="true" /></button>
    </header>
    <ol className="zweek-days">
      {dayKeys.map(key => {
        const date = new Date(`${key}T00:00:00`);
        const list = byDay.get(key) ?? [];
        const isToday = key === todayKey;
        const isPast = key < todayKey;
        const weekday = date.toLocaleDateString('nl-NL', { weekday: 'short' }).replace('.', '');
        const longDay = date.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
        return <li key={key}>
          <button
            type="button"
            className={`zweek-day${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}${list.length ? ' has-items' : ''}${isPast && list.length ? ' is-late' : ''}`}
            onClick={onOpen}
            aria-label={`${longDay}${isToday ? ' (vandaag)' : ''}: ${pl(list.length, 'open actie', 'open acties')}. Open de weekplanner`}
          >
            {/* Op de telefoon past "vandaag" niet in het vakje; daar blijft de
                weekdag staan en zegt de gouden rand dat het vandaag is. */}
            <span className="zweek-name">{isToday ? <><span className="zweek-long">vandaag</span><span className="zweek-short">{weekday}</span></> : weekday}</span>
            <span className="zweek-num">{date.getDate()}</span>
            <span className="zweek-count">{list.length || '·'}</span>
            <span className="zweek-dots" aria-hidden="true">
              {list.slice(0, 5).map(task => <i key={task.id} style={{ background: (task.project_id && colorOf.get(task.project_id)) || 'var(--ink-4)' }} />)}
            </span>
          </button>
        </li>;
      })}
    </ol>
  </section>;
}

// ── Projecten in één blik ──────────────────────────────────────────────────

const DAY_MS = 86_400_000;

type Glance = {
  project: Project;
  clientName: string | null;
  start: number;
  end: number;
  total: number;
  done: number;
  /** Hoeveel van de looptijd voorbij is, 0..1. */
  elapsed: number;
  /** Hoeveel van het werk af is, 0..1. */
  progress: number;
  status: { text: string; tone: 'ok' | 'warn' | 'danger' | 'quiet' };
};

function dayStart(value: string | null): number | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** Lopende projecten, elk met één balk: de vulling is het werk dat af is, het
 *  streepje is waar je in de tijd staat. Ligt het streepje ver voor de
 *  vulling, dan loopt het project achter — dat zie je zonder één filter. */
export function ProjectGlance({ projects, tasks, clients, onOpen, onOpenPlanning, limit = 6 }: {
  projects: Project[];
  tasks: Task[];
  clients: Client[];
  onOpen: (id: string) => void;
  onOpenPlanning?: () => void;
  limit?: number;
}) {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const clientName = new Map(clients.map(client => [client.id, client.name]));
  const tasksByProject = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.project_id) continue;
    const list = tasksByProject.get(task.project_id);
    if (list) list.push(task); else tasksByProject.set(task.project_id, [task]);
  }

  const rows: Glance[] = projects
    .filter(project => !project.archived)
    .map(project => {
      const list = tasksByProject.get(project.id) ?? [];
      const done = list.filter(task => task.status === 'done').length;
      const created = new Date(project.created_at).getTime();
      const start = dayStart(project.start_date) ?? (Number.isNaN(created) ? todayStart : created);
      const end = dayStart(project.end_date) ?? start + 14 * DAY_MS;
      const span = Math.max(DAY_MS, end + DAY_MS - start);
      const elapsed = Math.max(0, Math.min(1, (todayStart - start) / span));
      const progress = list.length ? done / list.length : 0;
      const daysLeft = Math.round((end - todayStart) / DAY_MS);
      const open = list.length - done;
      let status: Glance['status'];
      if (list.length > 0 && open === 0) status = { text: 'klaar', tone: 'ok' };
      else if (daysLeft < 0) status = { text: `${pl(-daysLeft, 'dag', 'dagen')} te laat`, tone: 'danger' };
      else if (start > todayStart) status = { text: `start over ${pl(Math.round((start - todayStart) / DAY_MS), 'dag', 'dagen')}`, tone: 'quiet' };
      else if (list.length > 0 && elapsed - progress > 0.25) status = { text: `achter · nog ${daysLeft} d`, tone: 'warn' };
      else status = { text: `nog ${pl(daysLeft, 'dag', 'dagen')}`, tone: 'quiet' };
      return { project, clientName: project.client_id ? clientName.get(project.client_id) ?? null : null, start, end, total: list.length, done, elapsed, progress, status };
    })
    // Afgerond en ver weg doet er nu niet toe.
    .filter(row => row.status.tone !== 'ok' && row.start <= todayStart + 45 * DAY_MS)
    .sort((a, b) => {
      const weight = (row: Glance) => row.status.tone === 'danger' ? 0 : row.status.tone === 'warn' ? 1 : 2;
      return weight(a) - weight(b) || a.end - b.end;
    });

  const shown = rows.slice(0, limit);
  const late = rows.filter(row => row.status.tone === 'danger').length;
  const behind = rows.filter(row => row.status.tone === 'warn').length;
  const summary = [
    pl(rows.length, 'lopend project', 'lopende projecten'),
    late ? `${late} te laat` : '',
    behind ? `${behind} achter op schema` : '',
  ].filter(Boolean).join(' · ');

  return <section className="zcard zglance" aria-label="Projecten">
    <header className="zcard-h">
      <div><h2>Projecten</h2><p>{rows.length ? summary : 'Geen lopende projecten'}</p></div>
      {onOpenPlanning && <button type="button" className="zlink" onClick={onOpenPlanning}>Planning <ChevronRight size={14} aria-hidden="true" /></button>}
    </header>
    {shown.length > 0 && <ul className="zglance-list">
      {shown.map(row => <li key={row.project.id}>
        <button type="button" className="zglance-row" onClick={() => onOpen(row.project.id)}>
          <span className="zglance-dot" style={{ background: row.project.color }} aria-hidden="true" />
          <span className="zglance-name">
            <strong>{row.project.name}</strong>
            <span>{[row.clientName, row.total ? `${row.done}/${row.total} klaar` : 'nog geen taken'].filter(Boolean).join(' · ')}</span>
          </span>
          <span
            className="zglance-track"
            role="img"
            aria-label={`${Math.round(row.progress * 100)}% van het werk af, ${Math.round(row.elapsed * 100)}% van de tijd voorbij`}
            title={`${Math.round(row.progress * 100)}% af · ${Math.round(row.elapsed * 100)}% van de tijd voorbij`}
          >
            <i className="zglance-fill" style={{ width: `${Math.round(row.progress * 100)}%`, background: row.project.color }} />
            {row.elapsed > 0 && row.elapsed < 1 && <i className="zglance-now" style={{ left: `${(row.elapsed * 100).toFixed(1)}%` }} />}
          </span>
          <span className={`zglance-status tone-${row.status.tone}`}>{row.status.text}</span>
        </button>
      </li>)}
    </ul>}
    {rows.length > shown.length && onOpenPlanning && <button type="button" className="zag-more" onClick={onOpenPlanning}>Nog {rows.length - shown.length} in de planning <ChevronRight size={13} aria-hidden="true" /></button>}
  </section>;
}
