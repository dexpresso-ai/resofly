import { useMemo, useState, type CSSProperties } from 'react';
import type { AppData, OrganizationContext, Project, Task } from '../types';
import { dateNL, euro } from '../lib/format';
import { Button } from '../components/Ui';

type ProjectPhase = 'planning' | 'active' | 'review' | 'overdue' | 'completed';

type TimelineProject = {
  project: Project;
  clientName: string;
  phase: ProjectPhase;
  start: Date;
  end: Date;
  hasExactPlanning: boolean;
  tasks: Task[];
  progress: number;
};

const projectPhaseOptions: { key: ProjectPhase; label: string; description: string }[] = [
  { key: 'planning', label: 'Planning', description: 'Nog niet gestart of alleen voorbereid' },
  { key: 'active', label: 'Bezig', description: 'Project loopt of heeft taken in uitvoering' },
  { key: 'review', label: 'Review', description: 'Er staan taken klaar voor review' },
  { key: 'overdue', label: 'Te laat', description: 'Einddatum is verstreken en niet alles is klaar' },
  { key: 'completed', label: 'Afgerond', description: 'Gearchiveerd of alle taken afgerond' },
];

const defaultPhaseFilters: Record<ProjectPhase, boolean> = {
  planning: true,
  active: true,
  review: true,
  overdue: true,
  completed: false,
};

export function Dashboard({
  data,
  organizationContext,
  openProject,
  openSettings,
}: {
  data: AppData;
  organizationContext: OrganizationContext;
  openProject: (id: string) => void;
  openSettings: () => void;
}) {
  const openTasks = data.tasks.filter(t => t.status !== 'done').length;
  const dueTasks = data.tasks.filter(t => t.status !== 'done' && t.end_date && new Date(`${t.end_date}T23:59:59`) < new Date()).length;
  const revenue = data.invoices
    .filter(i => i.status === 'paid')
    .reduce((s, i) => s + (i.lines ?? []).reduce((a, l) => a + l.quantity * l.unit_price * (1 + l.vat / 100), 0), 0);
  const activeClients = data.clients.filter(c => c.status === 'active').length;
  const activeProjects = data.projects.filter(p => !p.archived);
  const activeOrganization = organizationContext.activeOrganization;
  const activeRole = organizationContext.activeMembership?.role ?? 'geen rol';
  const onboardingItems = [
    { label: 'Organisatie aangemaakt', done: Boolean(activeOrganization) },
    { label: 'Bedrijfsgegevens ingevuld', done: Boolean(data.companySettings?.company_name?.trim()) },
    { label: 'Teamrol actief', done: Boolean(organizationContext.activeMembership) },
    { label: 'Eerste klant toegevoegd', done: data.clients.length > 0 },
    { label: 'Eerste project ingericht', done: data.projects.length > 0 },
  ];
  const onboardingDone = onboardingItems.filter(item => item.done).length;
  const onboardingPct = Math.round((onboardingDone / onboardingItems.length) * 100);

  return <>
    <section className="workspace-hero">
      <div>
        <span className="eyebrow">ResoFly cockpit</span>
        <h1>{activeOrganization?.name ?? 'ResoFly'}</h1>
        <p>Direct overzicht over klanten, projecten, tickets, offertes, facturen en teamtoegang — ontworpen als één strakke flow in plaats van losse schermen.</p>
      </div>
      <div className="workspace-meta-card">
        <span>Jouw rol</span>
        <strong>{activeRole}</strong>
        <small>{organizationContext.teamMembers.length} actief teamlid{organizationContext.teamMembers.length === 1 ? '' : 'en'}</small>
      </div>
    </section>

    <div className="dash-stats">
      <Stat label="Actieve klanten" value={activeClients}/>
      <Stat label="Projecten" value={activeProjects.length}/>
      <Stat label="Open taken" value={openTasks}/>
      <Stat label="Taken te laat" value={dueTasks}/>
      <Stat label="Betaald" value={euro(revenue)}/>
    </div>

    <section className="dashboard-layout">
      <div className="dash-main">
        <ProjectTimeline data={data} openProject={openProject} />
      </div>

      <aside className="dash-side">
        <div className="onboarding-card">
          <div className="onboarding-head">
            <div><h3>Workspace setup</h3><p>{onboardingDone}/{onboardingItems.length} stappen afgerond</p></div>
            <strong>{onboardingPct}%</strong>
          </div>
          <div className="prog-bar setup"><div className="prog-fill" style={{ width: `${onboardingPct}%` }}/></div>
          <div className="onboarding-list">
            {onboardingItems.map(item => <div className={`onboarding-row ${item.done ? 'done' : ''}`} key={item.label}><span>{item.done ? '✓' : '•'}</span>{item.label}</div>)}
          </div>
          <Button onClick={openSettings}>Organisatie instellen</Button>
        </div>

        <div className="activity-card compact-activity">
          <h3>Laatste activiteit</h3>
          {organizationContext.auditLogs.slice(0, 5).map(log => <div className="activity-row" key={log.id}>
            <div><strong>{auditLabel(log.action)}</strong><span>{log.entity_label || log.entity_type}</span></div>
            <time>{formatRelativeTime(log.created_at)}</time>
          </div>)}
          {organizationContext.auditLogs.length === 0 && <p className="settings-help">Nog geen audit-events. Nieuwe wijzigingen worden hier zichtbaar zodra de database-migratie is uitgevoerd.</p>}
        </div>
      </aside>
    </section>
  </>;
}

function ProjectTimeline({ data, openProject }: { data: AppData; openProject: (id: string) => void }) {
  const [phaseFilters, setPhaseFilters] = useState<Record<ProjectPhase, boolean>>(() => ({ ...defaultPhaseFilters }));

  const timelineProjects = useMemo<TimelineProject[]>(() => {
    return data.projects.map(project => {
      const tasks = data.tasks.filter(task => task.project_id === project.id);
      const doneTasks = tasks.filter(task => task.status === 'done').length;
      const progress = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;
      const client = data.clients.find(item => item.id === project.client_id);
      const dates = normalizeProjectDates(project);

      return {
        project,
        clientName: client?.name ?? 'Geen klant gekoppeld',
        phase: deriveProjectPhase(project, tasks),
        start: dates.start,
        end: dates.end,
        hasExactPlanning: dates.hasExactPlanning,
        tasks,
        progress,
      };
    }).sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [data.clients, data.projects, data.tasks]);

  const phaseCounts = useMemo(() => {
    return projectPhaseOptions.reduce<Record<ProjectPhase, number>>((acc, option) => {
      acc[option.key] = timelineProjects.filter(item => item.phase === option.key).length;
      return acc;
    }, { planning: 0, active: 0, review: 0, overdue: 0, completed: 0 });
  }, [timelineProjects]);

  const activePhaseKeys = projectPhaseOptions.filter(option => phaseFilters[option.key]).map(option => option.key);
  const filteredProjects = timelineProjects.filter(item => phaseFilters[item.phase]);
  const timelineRange = useMemo(() => getTimelineRange(filteredProjects), [filteredProjects]);
  const weeks = useMemo(() => getWeeks(timelineRange.start, timelineRange.end), [timelineRange.start, timelineRange.end]);
  const gridTemplateColumns = `repeat(${Math.max(weeks.length, 1)}, minmax(96px, 1fr))`;
  const weekLoads = weeks.map(week => filteredProjects.filter(item => rangesOverlap(item.start, item.end, week.start, week.end)).length);
  const peakLoad = Math.max(0, ...weekLoads);
  const missingExactPlanning = filteredProjects.filter(item => !item.hasExactPlanning).length;

  function togglePhase(phase: ProjectPhase) {
    setPhaseFilters(current => ({ ...current, [phase]: !current[phase] }));
  }

  function showAllPhases() {
    setPhaseFilters({ planning: true, active: true, review: true, overdue: true, completed: true });
  }

  return <section className="project-timeline-card">
    <div className="project-timeline-head">
      <div>
        <span className="eyebrow">Projectplanning</span>
        <h2>Visuele timeline per project</h2>
        <p>Projecten worden per week getoond op basis van start- en einddatum. De gekleurde balken maken overlap en werkdruk direct zichtbaar.</p>
      </div>
      <div className="timeline-insights" aria-label="Projectplanning samenvatting">
        <div><span>Getoond</span><strong>{filteredProjects.length}</strong></div>
        <div><span>Piek overlap</span><strong>{peakLoad}</strong></div>
        <div><span>Zonder planning</span><strong>{missingExactPlanning}</strong></div>
      </div>
    </div>

    <div className="timeline-filter-panel" aria-label="Projectfase filters">
      <div className="timeline-filter-copy">
        <strong>Fasefilters</strong>
        <span>Klik fases aan of uit om je dashboard-focus te bepalen.</span>
      </div>
      <div className="timeline-filter-buttons">
        {projectPhaseOptions.map(option => <button
          key={option.key}
          type="button"
          className={`timeline-filter phase-filter-${option.key} ${phaseFilters[option.key] ? 'is-selected' : ''}`}
          onClick={() => togglePhase(option.key)}
          title={option.description}
          aria-pressed={phaseFilters[option.key]}
        >
          <span className="timeline-filter-dot" />
          {option.label}
          <strong>{phaseCounts[option.key]}</strong>
        </button>)}
        {activePhaseKeys.length === 0 && <Button onClick={showAllPhases}>Alles tonen</Button>}
      </div>
    </div>

    {filteredProjects.length === 0 ? <div className="empty inline-empty timeline-empty"><div className="e-big">Geen projecten binnen deze filters</div><p>Zet één of meerdere fases aan om de planning weer zichtbaar te maken.</p></div> : <div className="timeline-scroll" role="region" aria-label="Projecttimeline" tabIndex={0}>
      <div className="timeline-week-header" style={{ gridTemplateColumns }}>
        {weeks.map(week => <div className="timeline-week" key={week.key}>
          <strong>W{week.isoWeek}</strong>
          <span>{formatShortDate(week.start)} – {formatShortDate(week.end)}</span>
        </div>)}
      </div>

      <div className="timeline-load-row">
        <div className="timeline-load-label">Overlap per week</div>
        <div className="timeline-load-grid" style={{ gridTemplateColumns }}>
          {weeks.map((week, index) => {
            const intensity = peakLoad > 0 ? weekLoads[index] / peakLoad : 0;
            return <div
              key={week.key}
              className="timeline-load-cell"
              style={{ '--load-opacity': String(0.12 + intensity * 0.62) } as CSSProperties}
              title={`${weekLoads[index]} project${weekLoads[index] === 1 ? '' : 'en'} in week ${week.isoWeek}`}
            ><span>{weekLoads[index] || ''}</span></div>;
          })}
        </div>
      </div>

      <div className="timeline-project-list">
        {filteredProjects.map(item => {
          const startIndex = clamp(getWeekIndex(timelineRange.start, item.start), 0, weeks.length - 1);
          const endIndex = clamp(getWeekIndex(timelineRange.start, item.end), startIndex, weeks.length - 1);
          const span = Math.max(1, endIndex - startIndex + 1);
          const openTasks = item.tasks.filter(task => task.status !== 'done').length;

          return <article className={`timeline-project-row phase-${item.phase}`} key={item.project.id}>
            <div className="timeline-project-label">
              <span className="project-color-dot" style={{ background: item.project.color }} />
              <div>
                <strong>{item.project.name}</strong>
                <span>{item.clientName}</span>
              </div>
            </div>
            <div className="timeline-track" style={{ gridTemplateColumns }}>
              {weeks.map(week => <div className="timeline-grid-cell" key={week.key} />)}
              <button
                type="button"
                className="timeline-bar"
                onClick={() => openProject(item.project.id)}
                style={{
                  gridColumn: `${startIndex + 1} / span ${span}`,
                  '--project-color': item.project.color,
                } as CSSProperties}
                title={`Open ${item.project.name}`}
              >
                <span className="timeline-bar-main">
                  <span className="timeline-bar-title">{item.project.name}</span>
                  <span className="timeline-bar-meta">{phaseLabel(item.phase)} · {item.progress}% · {openTasks} open</span>
                </span>
                <span className="timeline-bar-progress"><span style={{ width: `${item.progress}%` }} /></span>
              </button>
            </div>
            <div className="timeline-project-dates">
              <span>{item.project.start_date ? dateNL(item.project.start_date) : 'Geen start'}</span>
              <span>{item.project.end_date ? dateNL(item.project.end_date) : 'Geen einde'}</span>
              {!item.hasExactPlanning && <em>Planning geschat</em>}
            </div>
          </article>;
        })}
      </div>
    </div>}
  </section>;
}

function Stat({ label, value }: { label: string; value: string | number }) { return <div className="stat-card"><div className="sc-label">{label}</div><div className="sc-val">{value}</div></div>; }
function auditLabel(action: string) {
  const labels: Record<string, string> = { created: 'Aangemaakt', updated: 'Bijgewerkt', deleted: 'Verwijderd', invited: 'Uitgenodigd', accepted: 'Geaccepteerd', revoked: 'Ingetrokken', role_changed: 'Rol gewijzigd', disabled: 'Uitgeschakeld' };
  return labels[action] ?? action;
}
function formatRelativeTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function deriveProjectPhase(project: Project, tasks: Task[]): ProjectPhase {
  const now = new Date();
  const endDate = parseDate(project.end_date);
  const startDate = parseDate(project.start_date);
  const allTasksDone = tasks.length > 0 && tasks.every(task => task.status === 'done');

  if (project.archived || allTasksDone) return 'completed';
  if (endDate && endOfDay(endDate) < now) return 'overdue';
  if (tasks.some(task => task.status === 'review')) return 'review';
  if (tasks.some(task => task.status === 'doing')) return 'active';
  if (startDate && startOfDay(startDate) <= now) return 'active';
  return 'planning';
}

function phaseLabel(phase: ProjectPhase) {
  return projectPhaseOptions.find(option => option.key === phase)?.label ?? phase;
}

function normalizeProjectDates(project: Project): { start: Date; end: Date; hasExactPlanning: boolean } {
  const start = parseDate(project.start_date);
  const end = parseDate(project.end_date);
  const createdAt = new Date(project.created_at);
  const base = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;

  if (start && end) {
    return { start: startOfDay(start), end: endOfDay(end), hasExactPlanning: true };
  }
  if (start) {
    return { start: startOfDay(start), end: endOfDay(addDays(start, 14)), hasExactPlanning: false };
  }
  if (end) {
    return { start: startOfDay(addDays(end, -14)), end: endOfDay(end), hasExactPlanning: false };
  }
  return { start: startOfDay(base), end: endOfDay(addDays(base, 7)), hasExactPlanning: false };
}

function getTimelineRange(projects: TimelineProject[]) {
  if (projects.length === 0) {
    const now = new Date();
    return { start: startOfWeek(now), end: endOfWeek(addDays(now, 28)) };
  }
  const minStart = new Date(Math.min(...projects.map(item => item.start.getTime())));
  const maxEnd = new Date(Math.max(...projects.map(item => item.end.getTime())));
  return { start: startOfWeek(minStart), end: endOfWeek(maxEnd) };
}

function getWeeks(start: Date, end: Date) {
  const weeks: { key: string; start: Date; end: Date; isoWeek: number }[] = [];
  let cursor = startOfWeek(start);
  const final = endOfWeek(end);

  while (cursor <= final) {
    const weekStart = new Date(cursor);
    const weekEnd = endOfWeek(weekStart);
    weeks.push({ key: weekStart.toISOString(), start: weekStart, end: weekEnd, isoWeek: getIsoWeek(weekStart) });
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

function getWeekIndex(rangeStart: Date, date: Date) {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.floor((startOfWeek(date).getTime() - startOfWeek(rangeStart).getTime()) / msPerWeek);
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart <= bEnd && aEnd >= bStart;
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function startOfWeek(date: Date) {
  const copy = startOfDay(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function endOfWeek(date: Date) {
  return endOfDay(addDays(startOfWeek(date), 6));
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function getIsoWeek(date: Date) {
  const copy = startOfDay(date);
  copy.setDate(copy.getDate() + 3 - ((copy.getDay() + 6) % 7));
  const week1 = new Date(copy.getFullYear(), 0, 4);
  return 1 + Math.round(((copy.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

function formatShortDate(date: Date) {
  return new Intl.DateTimeFormat('nl-NL', { day: '2-digit', month: 'short' }).format(date).replace('.', '');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
