import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { AppData, Project, Task } from '../types';
import { Input, Select } from '../components/Ui';
import { useLook } from '../lib/look';

type ProjectPhase = 'planning' | 'active' | 'review' | 'overdue' | 'completed';
type TimelineVariant = 'dashboard' | 'full';
type Scale = 'week' | 'month' | 'quarter';

type TimelineProject = {
  project: Project;
  clientName: string;
  phase: ProjectPhase;
  start: Date;
  end: Date;
  hasExactPlanning: boolean;
  tasks: Task[];
  doneTasks: number;
  progress: number;
};

/** Eén kolom op de tijdbalk. `label` staat groot, `sub` klein eronder en
 *  `groupLabel` bundelt opeenvolgende kolommen in de band erboven. */
type Column = {
  key: string;
  start: Date;
  end: Date;
  label: string;
  sub: string;
  groupKey: string;
  groupLabel: string;
};

const projectPhaseOptions: { key: ProjectPhase; label: string; description: string }[] = [
  { key: 'planning', label: 'Planning', description: 'Nog niet gestart of alleen voorbereid' },
  { key: 'active', label: 'Bezig', description: 'Project loopt of heeft taken in uitvoering' },
  { key: 'review', label: 'Review', description: 'Er staan taken klaar voor review' },
  { key: 'overdue', label: 'Te laat', description: 'Einddatum is verstreken en niet alles is klaar' },
  { key: 'completed', label: 'Afgerond', description: 'Gearchiveerd of alle taken afgerond' },
];

const scaleOptions: { key: Scale; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Maand' },
  { key: 'quarter', label: 'Kwartaal' },
];

const defaultPhaseFilters: Record<ProjectPhase, boolean> = {
  planning: true,
  active: true,
  review: true,
  overdue: true,
  completed: false,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Onbewolkt (Zenit): drie lenzen in plaats van vijf fasefilters, een zoekveld
 *  en een archief-knop naast elkaar. Wie fijner wil kijken, opent Verfijnen. */
type Lens = 'lopend' | 'telaat' | 'alles';
const LENS_PHASES: Record<Lens, Record<ProjectPhase, boolean>> = {
  lopend: { ...defaultPhaseFilters },
  telaat: { planning: false, active: false, review: false, overdue: true, completed: false },
  alles: { planning: true, active: true, review: true, overdue: true, completed: true },
};
const samePhases = (a: Record<ProjectPhase, boolean>, b: Record<ProjectPhase, boolean>) =>
  projectPhaseOptions.every(option => a[option.key] === b[option.key]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ProjectTimeline({
  data,
  openProject,
  variant = 'dashboard',
}: {
  data: AppData;
  openProject: (id: string) => void;
  variant?: TimelineVariant;
}) {
  const [phaseFilters, setPhaseFilters] = useState<Record<ProjectPhase, boolean>>(() => ({ ...defaultPhaseFilters }));
  const [query, setQuery] = useState('');
  const [clientId, setClientId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  /** `null` = schaal volgt de lengte van de planning; een keuze zet hem vast. */
  const [pickedScale, setPickedScale] = useState<Scale | null>(null);
  const isFull = variant === 'full';
  const [look] = useLook();
  const calm = look === 'zenit' && isFull;
  const [refineOpen, setRefineOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLDivElement>(null);
  const centeredOnce = useRef(false);

  const timelineProjects = useMemo<TimelineProject[]>(() => {
    return data.projects.map(project => {
      const tasks = data.tasks.filter(task => task.project_id === project.id);
      const doneTasks = tasks.filter(task => task.status === 'done').length;
      const progress = tasks.length ? Math.round((doneTasks / tasks.length) * 100) : 0;
      const client = data.clients.find(item => item.id === project.client_id);
      const dates = normalizeProjectDates(project);

      return {
        project,
        clientName: client?.name ?? 'Geen klant',
        phase: deriveProjectPhase(project, tasks),
        start: dates.start,
        end: dates.end,
        hasExactPlanning: dates.hasExactPlanning,
        tasks,
        doneTasks,
        progress,
      };
    }).sort((a, b) => a.start.getTime() - b.start.getTime() || a.project.name.localeCompare(b.project.name, 'nl'));
  }, [data.clients, data.projects, data.tasks]);

  const baseProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return timelineProjects.filter(item => {
      if (isFull && !showArchived && item.project.archived) return false;
      if (clientId && item.project.client_id !== clientId) return false;

      if (!normalizedQuery) return true;
      const haystack = [
        item.project.name,
        item.project.description ?? '',
        item.clientName,
        item.tasks.map(task => `${task.title} ${task.description ?? ''} ${task.tags?.join(' ') ?? ''}`).join(' '),
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [clientId, isFull, query, showArchived, timelineProjects]);

  const phaseCounts = useMemo(() => {
    return projectPhaseOptions.reduce<Record<ProjectPhase, number>>((acc, option) => {
      acc[option.key] = baseProjects.filter(item => item.phase === option.key).length;
      return acc;
    }, { planning: 0, active: 0, review: 0, overdue: 0, completed: 0 });
  }, [baseProjects]);

  const activePhaseKeys = projectPhaseOptions.filter(option => phaseFilters[option.key]).map(option => option.key);
  const filteredProjects = useMemo(() => baseProjects.filter(item => phaseFilters[item.phase]), [baseProjects, phaseFilters]);

  // De lenzen tellen over alles wat de zoekterm en de klant overlaten, met én
  // zonder archief: "hoeveel zijn er zo?", niet "hoeveel zie ik nu?".
  const lensCounts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const pool = timelineProjects.filter(item => {
      if (clientId && item.project.client_id !== clientId) return false;
      if (!normalizedQuery) return true;
      return [item.project.name, item.project.description ?? '', item.clientName].join(' ').toLowerCase().includes(normalizedQuery)
        || item.tasks.some(task => `${task.title} ${task.description ?? ''} ${task.tags?.join(' ') ?? ''}`.toLowerCase().includes(normalizedQuery));
    });
    return {
      lopend: pool.filter(item => !item.project.archived && item.phase !== 'completed').length,
      telaat: pool.filter(item => !item.project.archived && item.phase === 'overdue').length,
      alles: pool.length,
    };
  }, [clientId, query, timelineProjects]);
  const lens: Lens | null = samePhases(phaseFilters, LENS_PHASES.alles) && showArchived ? 'alles'
    : showArchived ? null
    : samePhases(phaseFilters, LENS_PHASES.lopend) ? 'lopend'
    : samePhases(phaseFilters, LENS_PHASES.telaat) ? 'telaat'
    : null;
  function pickLens(next: Lens) {
    setPhaseFilters({ ...LENS_PHASES[next] });
    setShowArchived(next === 'alles');
  }
  const clientName = clientId ? data.clients.find(client => client.id === clientId)?.name ?? 'Klant' : null;
  const refineCount = (clientId ? 1 : 0) + (lens === null ? 1 : 0);

  /** De ruwe periode: alles wat getoond wordt én vandaag, zodat de "nu"-lijn
   *  altijd in beeld te brengen is. */
  const span = useMemo(() => {
    const today = new Date();
    const stamps = [today.getTime(), ...filteredProjects.flatMap(item => [item.start.getTime(), item.end.getTime()])];
    return { from: new Date(Math.min(...stamps)), to: new Date(Math.max(...stamps)) };
  }, [filteredProjects]);

  const autoScale = useMemo<Scale>(() => {
    const days = Math.max(1, (span.to.getTime() - span.from.getTime()) / DAY_MS);
    if (days <= 190) return 'week';
    if (days <= 900) return 'month';
    return 'quarter';
  }, [span.from, span.to]);

  const scale = pickedScale ?? autoScale;
  const columns = useMemo(() => buildColumns(span.from, span.to, scale), [scale, span.from, span.to]);
  const groups = useMemo(() => groupColumns(columns), [columns]);

  const rangeStart = columns[0].start.getTime();
  const rangeEnd = columns[columns.length - 1].end.getTime() + 1;
  const rangeMs = Math.max(1, rangeEnd - rangeStart);

  const columnLoads = useMemo(
    () => columns.map(column => filteredProjects.filter(item => rangesOverlap(item.start, item.end, column.start, column.end)).length),
    [columns, filteredProjects],
  );
  const peakLoad = Math.max(0, ...columnLoads);
  const missingExactPlanning = filteredProjects.filter(item => !item.hasExactPlanning).length;
  const openTasks = filteredProjects.reduce((sum, item) => sum + item.tasks.filter(task => task.status !== 'done').length, 0);

  const now = Date.now();
  const todayFraction = clamp((now - rangeStart) / rangeMs, 0, 1);
  const todayInRange = now >= rangeStart && now <= rangeEnd;

  /** Springt direct (niet `smooth`): een vloeiende scroll wordt door de
   *  compositor gedreven en blijft halverwege steken zodra het tabblad niet
   *  tekent — dan zou de knop soms wél en soms niets doen. */
  function scrollToToday() {
    const scroller = scrollRef.current;
    const marker = todayRef.current;
    if (!scroller || !marker) return;
    scroller.scrollLeft = Math.max(0, marker.offsetLeft - scroller.clientWidth / 2);
  }

  /** Bij het openen staat de tijdbalk op vandaag; daarna bepaalt de gebruiker
   *  zelf waar hij kijkt. */
  useEffect(() => {
    if (centeredOnce.current) return;
    const scroller = scrollRef.current;
    const marker = todayRef.current;
    if (!scroller || !marker) return;
    centeredOnce.current = true;
    scroller.scrollLeft = Math.max(0, marker.offsetLeft - scroller.clientWidth / 2);
  }, [columns.length, filteredProjects.length]);

  function togglePhase(phase: ProjectPhase) {
    setPhaseFilters(current => ({ ...current, [phase]: !current[phase] }));
  }

  /** Alleen gegevens staan hier: een inline `--ptl-col-w` zou de media queries
   *  overrulen, dus de kolombreedte hangt aan de klasse `ptl-scale-*`. */
  const boardStyle = {
    '--ptl-cols': columns.length,
    '--ptl-today': todayFraction,
  } as CSSProperties;

  return <section className={`ptl ptl-${variant} ptl-scale-${scale}${calm ? ' ptl-calm' : ''}`}>
    {calm
      ? <>
        <header className="ptl-head ptl-calm-head">
          <div className="ptl-heading">
            <h2>Projectplanning</h2>
            {/* Eén zin in plaats van vier tegels: wat er loopt, wanneer het
                druk is en wat er openstaat. */}
            <p className="ptl-sentence">
              {plural(filteredProjects.length, 'project', 'projecten')} in beeld
              {peakLoad > 1 && <> · drukste {scale === 'week' ? 'week' : scale === 'month' ? 'maand' : 'kwartaal'}: <b>{columns[columnLoads.indexOf(peakLoad)]?.label}</b> met {peakLoad} tegelijk</>}
              {openTasks > 0 && <> · {plural(openTasks, 'open taak', 'open taken')}</>}
              {phaseCounts.overdue > 0 && phaseFilters.overdue && <> · <b className="is-late">{phaseCounts.overdue} te laat</b></>}
              {missingExactPlanning > 0 && <> · {missingExactPlanning} zonder vaste datum</>}
            </p>
          </div>
        </header>

        <div className="ptl-toolbar ptl-calm-bar">
          <div className="ptl-lens" role="group" aria-label="Welke projecten">
            {([['lopend', 'Lopend'], ['telaat', 'Te laat'], ['alles', 'Alles']] as const).map(([key, label]) => <button
              key={key}
              type="button"
              className={lens === key ? 'is-on' : ''}
              aria-pressed={lens === key}
              onClick={() => pickLens(key)}
            >{label}<span className="ptl-lens-n">{lensCounts[key]}</span></button>)}
          </div>
          <label className="ptl-qsearch">
            <Search size={15} aria-hidden="true" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Zoek project, klant of taak" aria-label="Zoek in de planning" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Zoekterm wissen"><X size={13} /></button>}
          </label>
          <button
            type="button"
            className={`ptl-refine${refineOpen ? ' is-open' : ''}`}
            aria-expanded={refineOpen}
            aria-label={refineCount > 0 ? `Verfijnen, ${refineCount} actief` : undefined}
            onClick={() => setRefineOpen(open => !open)}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />Verfijnen
            {refineCount > 0 && <span className="ptl-refine-n" aria-hidden="true">{refineCount}</span>}
          </button>
          <div className="ptl-toolbar-end">
            <div className="ptl-scaleswitch" role="group" aria-label="Schaal van de tijdbalk">
              {scaleOptions.map(option => <button
                key={option.key}
                type="button"
                className={scale === option.key ? 'is-on' : ''}
                onClick={() => setPickedScale(option.key)}
                aria-pressed={scale === option.key}
              >{option.label}</button>)}
            </div>
            <button type="button" className="ptl-toggle" onClick={scrollToToday} disabled={!todayInRange}>Vandaag</button>
          </div>
        </div>

        {refineOpen && <div className="ptl-refine-row">
          <div className="ptl-client">
            <Select value={clientId} onChange={event => setClientId(event.target.value)} aria-label="Klant">
              <option value="">Alle klanten</option>
              {data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Select>
          </div>
          <div className="ptl-chips" role="group" aria-label="Fases">
            {projectPhaseOptions.map(option => <button
              key={option.key}
              type="button"
              className={`ptl-chip phase-${option.key} ${phaseFilters[option.key] ? 'is-on' : ''}`}
              onClick={() => togglePhase(option.key)}
              title={option.description}
              aria-pressed={phaseFilters[option.key]}
            >
              <span className="ptl-chip-dot" aria-hidden="true" />
              {option.label}
              <span className="ptl-chip-count">{phaseCounts[option.key]}</span>
            </button>)}
          </div>
          <button
            type="button"
            className={`ptl-toggle ${showArchived ? 'is-on' : ''}`}
            onClick={() => setShowArchived(value => !value)}
            aria-pressed={showArchived}
          >{showArchived ? 'Met archief' : 'Zonder archief'}</button>
        </div>}

        {!refineOpen && refineCount > 0 && <div className="ptl-active">
          {clientName && <button type="button" className="ptl-active-chip" onClick={() => setClientId('')}>Klant: {clientName}<X size={12} aria-label="weg" /></button>}
          {lens === null && <button type="button" className="ptl-active-chip" onClick={() => pickLens('lopend')}>Eigen keuze: {activePhaseKeys.map(key => phaseLabel(key)).join(', ') || 'geen fases'}{showArchived ? ' + archief' : ''}<X size={12} aria-label="weg" /></button>}
        </div>}
      </>
      : <>
      <header className="ptl-head">
        <div className="ptl-heading">
          <h2>Projectplanning</h2>
          <p>{isFull
            ? 'Alle projecten op één tijdbalk — sleep horizontaal om verder vooruit of terug te kijken.'
            : 'Wie loopt er wanneer? De balken tonen looptijd en voortgang per project.'}</p>
        </div>
        {/* Elk cijfer draagt twee labels: het volledige voor een breed scherm en een
            kort voor de telefoon, waar de vier cijfers op één regel staan. Alleen
            het zichtbare label wordt voorgelezen — `display:none` haalt het andere
            ook uit de toegankelijkheidsboom. */}
        <div className="ptl-stats">
          {[
            { key: 'shown', label: 'Getoond', short: 'Getoond', value: filteredProjects.length },
            { key: 'peak', label: 'Piek overlap', short: 'Piek', value: peakLoad },
            { key: 'open', label: 'Open taken', short: 'Open', value: openTasks },
            { key: 'unplanned', label: 'Zonder planning', short: 'Ongepland', value: missingExactPlanning },
          ].map(stat => <div key={stat.key}>
            <span>
              <span className="ptl-stat-long">{stat.label}</span>
              <span className="ptl-stat-short">{stat.short}</span>
            </span>
            <strong>{stat.value}</strong>
          </div>)}
        </div>
      </header>

      <div className="ptl-toolbar">
        {isFull && <div className="ptl-search">
          <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Zoek op project, klant, taak of tag" />
        </div>}
        {isFull && <div className="ptl-client">
          <Select value={clientId} onChange={event => setClientId(event.target.value)}>
            <option value="">Alle klanten</option>
            {data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
          </Select>
        </div>}
        {isFull && <button
          type="button"
          className={`ptl-toggle ${showArchived ? 'is-on' : ''}`}
          onClick={() => setShowArchived(value => !value)}
          aria-pressed={showArchived}
        >{showArchived ? 'Inclusief archief' : 'Alleen actief'}</button>}

        <div className="ptl-toolbar-end">
          <div className="ptl-scaleswitch" role="group" aria-label="Schaal van de tijdbalk">
            {scaleOptions.map(option => <button
              key={option.key}
              type="button"
              className={scale === option.key ? 'is-on' : ''}
              onClick={() => setPickedScale(option.key)}
              aria-pressed={scale === option.key}
            >{option.label}</button>)}
          </div>
          <button type="button" className="ptl-toggle" onClick={scrollToToday} disabled={!todayInRange}>Vandaag</button>
        </div>
      </div>

      <div className="ptl-chips" role="group" aria-label="Projectfase filters">
        <span className="ptl-chips-label">Fase</span>
        {projectPhaseOptions.map(option => <button
          key={option.key}
          type="button"
          className={`ptl-chip phase-${option.key} ${phaseFilters[option.key] ? 'is-on' : ''}`}
          onClick={() => togglePhase(option.key)}
          title={option.description}
          aria-pressed={phaseFilters[option.key]}
        >
          <span className="ptl-chip-dot" aria-hidden="true" />
          {option.label}
          <span className="ptl-chip-count">{phaseCounts[option.key]}</span>
        </button>)}
        {activePhaseKeys.length === 0 && <button
          type="button"
          className="ptl-chip-reset"
          onClick={() => setPhaseFilters({ planning: true, active: true, review: true, overdue: true, completed: true })}
        >Alles tonen</button>}
      </div>

      </>}

    {filteredProjects.length === 0
      ? <div className="ptl-empty">
        <strong>Geen projecten binnen deze filters</strong>
        <span>Zet één of meerdere fases aan of pas je zoekopdracht aan.</span>
      </div>
      : <div className="ptl-scroll" ref={scrollRef} role="region" aria-label="Projecttijdbalk" tabIndex={0}>
        <div className="ptl-board" style={boardStyle}>
          <div className="ptl-headband">
            <div className="ptl-row ptl-row-group">
              <div className="ptl-label ptl-label-head" />
              <div className="ptl-cells">
                {groups.map(group => <div className="ptl-group" key={group.key} style={{ gridColumn: `span ${group.span}` }}>
                  <span>{group.label}</span>
                </div>)}
              </div>
            </div>

            <div className="ptl-row ptl-row-cols">
              <div className="ptl-label ptl-label-head"><span>Project</span></div>
              <div className="ptl-cells">
                {columns.map(column => <div
                  className={`ptl-col ${isNowColumn(column, now) ? 'is-now' : ''}`}
                  key={column.key}
                >
                  <strong>{column.label}</strong>
                  {column.sub && <span>{column.sub}</span>}
                </div>)}
              </div>
            </div>

            <div className="ptl-row ptl-row-load">
              <div className="ptl-label ptl-label-head"><span>Bezetting</span></div>
              <div className="ptl-cells">
                {columns.map((column, index) => <div
                  className="ptl-load"
                  key={column.key}
                  title={`${columnLoads[index]} project${columnLoads[index] === 1 ? '' : 'en'} in ${column.label}`}
                >
                  <span className="ptl-load-bar" style={{ height: `${peakLoad ? (columnLoads[index] / peakLoad) * 100 : 0}%` }} aria-hidden="true" />
                  <b>{columnLoads[index] || ''}</b>
                </div>)}
              </div>
            </div>

            {todayInRange && <div className="ptl-todaycap" aria-hidden="true"><span>vandaag</span></div>}
          </div>

          <div className="ptl-rows">
            {filteredProjects.map(item => {
              const left = clamp((item.start.getTime() - rangeStart) / rangeMs, 0, 1) * 100;
              const right = clamp((item.end.getTime() + 1 - rangeStart) / rangeMs, 0, 1) * 100;
              const width = Math.max(right - left, 0.4);
              const openProjectTasks = item.tasks.length - item.doneTasks;
              const dateLabel = item.hasExactPlanning
                ? formatRange(item.start, item.end)
                : `${formatRange(item.start, item.end)} · geschat`;
              const barTitle = `${item.project.name} — ${phaseLabel(item.phase)} · ${dateLabel} · ${item.progress}% klaar · ${openProjectTasks} open taken`;

              return <article className={`ptl-row ptl-project phase-${item.phase}`} key={item.project.id}>
                <div className="ptl-label">
                  <button type="button" className="ptl-label-btn" onClick={() => openProject(item.project.id)} title={barTitle}>
                    <span className="ptl-dot" style={{ background: item.project.color }} aria-hidden="true" />
                    <span className="ptl-label-text">
                      <strong>{item.project.name}</strong>
                      <span className="ptl-label-sub">
                        {item.clientName}
                        <em className={`ptl-phase phase-${item.phase}`}>{phaseLabel(item.phase)}</em>
                      </span>
                    </span>
                    <span className="ptl-label-count">{item.tasks.length ? `${item.doneTasks}/${item.tasks.length}` : '—'}</span>
                  </button>
                </div>
                <div className="ptl-track">
                  <button
                    type="button"
                    className={`ptl-bar ${item.hasExactPlanning ? '' : 'is-estimated'}`}
                    onClick={() => openProject(item.project.id)}
                    style={{ left: `${left}%`, width: `${width}%`, '--pc': item.project.color } as CSSProperties}
                    title={barTitle}
                    aria-label={barTitle}
                  >
                    <span className="ptl-bar-fill" style={{ width: `${item.progress}%` }} aria-hidden="true" />
                    <span className="ptl-bar-text">
                      <strong>{item.project.name}</strong>
                      <span>{dateLabel}</span>
                    </span>
                  </button>
                </div>
              </article>;
            })}
          </div>

          {todayInRange && <div className="ptl-todayline" ref={todayRef} aria-hidden="true" />}
        </div>
      </div>}
  </section>;
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
    // Een omgedraaide invoer (einde vóór start) zou een balk met negatieve
    // breedte geven; die draaien we hier recht.
    const from = start <= end ? start : end;
    const to = start <= end ? end : start;
    return { start: startOfDay(from), end: endOfDay(to), hasExactPlanning: true };
  }
  if (start) {
    return { start: startOfDay(start), end: endOfDay(addDays(start, 14)), hasExactPlanning: false };
  }
  if (end) {
    return { start: startOfDay(addDays(end, -14)), end: endOfDay(end), hasExactPlanning: false };
  }
  return { start: startOfDay(base), end: endOfDay(addDays(base, 7)), hasExactPlanning: false };
}

/** Bouwt de kolommen zó dat ze de héle periode dekken — inclusief een lege
 *  kolom marge aan beide kanten, zodat een balk nooit tegen de rand plakt. */
function buildColumns(from: Date, to: Date, scale: Scale): Column[] {
  const columns: Column[] = [];
  const startOfUnit = scale === 'week' ? startOfWeek : scale === 'month' ? startOfMonth : startOfQuarter;

  let cursor = shiftUnit(startOfUnit(from), scale, -1);
  const final = shiftUnit(startOfUnit(to), scale, 1);
  let guard = 0;

  while (cursor <= final && guard < 600) {
    guard += 1;
    const next = shiftUnit(cursor, scale, 1);
    const end = endOfDay(addDays(next, -1));
    columns.push({
      key: cursor.toISOString(),
      start: cursor,
      end,
      label: scale === 'week' ? `W${getIsoWeek(cursor)}` : scale === 'month' ? monthShort(cursor) : `Q${Math.floor(cursor.getMonth() / 3) + 1}`,
      sub: scale === 'week' ? `${dayMonth(cursor)} – ${dayMonth(end)}` : '',
      groupKey: scale === 'week' ? `${cursor.getFullYear()}-${cursor.getMonth()}` : String(cursor.getFullYear()),
      groupLabel: scale === 'week' ? `${monthLong(cursor)} ${cursor.getFullYear()}` : String(cursor.getFullYear()),
    });
    cursor = next;
  }

  return columns.length ? columns : [{
    key: 'leeg',
    start: startOfWeek(from),
    end: endOfWeek(from),
    label: `W${getIsoWeek(from)}`,
    sub: '',
    groupKey: 'leeg',
    groupLabel: `${monthLong(from)} ${from.getFullYear()}`,
  }];
}

function shiftUnit(date: Date, scale: Scale, amount: number) {
  if (scale === 'week') return addDays(date, 7 * amount);
  const copy = startOfDay(date);
  copy.setMonth(copy.getMonth() + amount * (scale === 'month' ? 1 : 3), 1);
  return copy;
}

function groupColumns(columns: Column[]) {
  const groups: { key: string; group: string; label: string; span: number }[] = [];
  columns.forEach((column, index) => {
    const last = groups[groups.length - 1];
    if (last && last.group === column.groupKey) last.span += 1;
    else groups.push({ key: `${column.groupKey}-${index}`, group: column.groupKey, label: column.groupLabel, span: 1 });
  });
  return groups;
}

function isNowColumn(column: Column, now: number) {
  return now >= column.start.getTime() && now <= column.end.getTime();
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

function startOfMonth(date: Date) {
  const copy = startOfDay(date);
  copy.setDate(1);
  return copy;
}

function startOfQuarter(date: Date) {
  const copy = startOfMonth(date);
  copy.setMonth(Math.floor(copy.getMonth() / 3) * 3, 1);
  return copy;
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

const dayMonthFormat = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });
const monthShortFormat = new Intl.DateTimeFormat('nl-NL', { month: 'short' });
const monthLongFormat = new Intl.DateTimeFormat('nl-NL', { month: 'long' });

function dayMonth(date: Date) {
  return dayMonthFormat.format(date).replace('.', '');
}

function monthShort(date: Date) {
  return monthShortFormat.format(date).replace('.', '');
}

function monthLong(date: Date) {
  return monthLongFormat.format(date);
}

/** "22 jun – 6 jul", met jaartal zodra de planning buiten dit jaar valt. */
function formatRange(start: Date, end: Date) {
  const thisYear = new Date().getFullYear();
  const suffix = start.getFullYear() !== thisYear || end.getFullYear() !== thisYear
    ? ` ${end.getFullYear()}`
    : '';
  const startLabel = start.getFullYear() !== end.getFullYear() ? `${dayMonth(start)} ${start.getFullYear()}` : dayMonth(start);
  return `${startLabel} – ${dayMonth(end)}${suffix}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
