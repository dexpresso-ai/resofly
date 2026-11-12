import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Archive, Building2, CalendarRange, ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react';
import type { AppData, Project, Task } from '../types';
import { Select } from '../components/Ui';
import { isZenitFamily, useLook } from '../lib/look';

type ProjectPhase = 'planning' | 'active' | 'review' | 'overdue' | 'completed';
type TimelineVariant = 'dashboard' | 'full';
type Scale = 'week' | 'month' | 'quarter';

type TimelineProject = {
  project: Project;
  clientName: string;
  hasClient: boolean;
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

/** Waar de naam van een project staat. `full`: naam en datums in de balk;
 *  `name`: alleen de naam past; `after`/`before`: de balk is te kort, de tekst
 *  staat ernaast. Afkappen tot "Alge" of "Doc" (zo stond het tot 2026-11-12)
 *  zegt niemand iets. */
type LabelFit = 'full' | 'name' | 'after' | 'before';

const projectPhaseOptions: { key: ProjectPhase; label: string; description: string }[] = [
  { key: 'planning', label: 'Gepland', description: 'Nog niet gestart of alleen voorbereid' },
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
  const calm = isZenitFamily(look) && isFull;
  const [refineOpen, setRefineOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const centeredOnce = useRef(false);
  /** Breedte van het spoor in pixels en de letter van de pagina: daarmee
   *  rekenen we uit of een naam in zijn balk past. */
  const [track, setTrack] = useState<{ px: number; font: string }>({ px: 0, font: '' });

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
        hasClient: Boolean(client),
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
  const scaleNoun = scale === 'week' ? 'week' : scale === 'month' ? 'maand' : 'kwartaal';
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
  const lateCount = filteredProjects.filter(item => item.phase === 'overdue').length;

  const now = Date.now();
  const todayFraction = clamp((now - rangeStart) / rangeMs, 0, 1);
  const todayInRange = now >= rangeStart && now <= rangeEnd;
  const nowIndex = columns.findIndex(column => isNowColumn(column, now));
  const hasRows = filteredProjects.length > 0;

  /** Per project: waar de balk staat, of hij uitloopt en waar de naam past.
   *  Zolang de breedte nog niet gemeten is, rekenen we met de standaardkolom. */
  const bars = useMemo(() => {
    const trackPx = track.px || columns.length * 110;
    const font = track.font || 'sans-serif';
    return filteredProjects.map(item => {
      const left = clamp((item.start.getTime() - rangeStart) / rangeMs, 0, 1) * 100;
      const right = clamp((item.end.getTime() + 1 - rangeStart) / rangeMs, 0, 1) * 100;
      const width = Math.max(right - left, 0.4);
      // Te laat: de uitloop loopt van de einddatum tot vandaag, gearceerd.
      // Zo zie je op de balk zelf hoe ver een project over zijn tijd is.
      const overdueDays = item.phase === 'overdue' ? Math.max(1, Math.ceil((now - item.end.getTime()) / DAY_MS)) : 0;
      const overrun = overdueDays > 0 && todayInRange
        ? { left: left + width, width: Math.max(0, todayFraction * 100 - (left + width)) }
        : null;
      const dateLabel = item.hasExactPlanning
        ? formatRange(item.start, item.end)
        : `${formatRange(item.start, item.end)} · geschat`;

      // 16px links (het accentje), 12px rechts, 8px tussen naam en datum.
      // Zenit zet in de balk alleen de datums: de naam staat al links.
      const nameW = calm ? 0 : textWidth(item.project.name, `600 12px ${font}`) * 1.06;
      const dateW = textWidth(dateLabel, `500 11px ${font}`) * 1.06;
      const barPx = (width / 100) * trackPx;
      const outsidePx = nameW + (nameW ? 8 : 0) + dateW;
      const tailPx = ((overrun ? overrun.left + overrun.width : left + width) / 100) * trackPx;
      const fit: LabelFit = barPx >= 28 + outsidePx ? 'full'
        : !calm && barPx >= 28 + nameW ? 'name'
        : tailPx + 10 + outsidePx <= trackPx || (left / 100) * trackPx < outsidePx + 10 ? 'after'
        : 'before';
      // Staat de tekst ná een uitlopende balk, dan begint hij na de uitloop.
      const afterOffset = fit === 'after' && overrun ? (overrun.width / 100) * trackPx : 0;

      return { item, left, width, overrun, overdueDays, dateLabel, fit, afterOffset };
    });
  }, [calm, columns.length, filteredProjects, now, rangeMs, rangeStart, todayFraction, todayInRange, track.font, track.px]);
  const anyEstimated = bars.some(bar => !bar.item.hasExactPlanning);
  const anyOverrun = bars.some(bar => bar.overrun && bar.overrun.width > 0);

  /** Springt direct (niet `smooth`): een vloeiende scroll wordt door de
   *  compositor gedreven en blijft halverwege steken zodra het tabblad niet
   *  tekent — dan zou de knop soms wél en soms niets doen. */
  function scrollToToday() {
    const scroller = scrollRef.current;
    const marker = todayRef.current;
    if (!scroller || !marker) return;
    scroller.scrollLeft = todayScrollLeft(scroller, marker);
  }

  /** Een flink stuk verder of terug, met de projectkolom eraf: zonder
   *  trackpad is zijwaarts slepen op een desktop een gedoe. */
  function scrollByPage(direction: 1 | -1) {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const labelWidth = scroller.querySelector<HTMLElement>('.ptl-corner')?.offsetWidth ?? 0;
    scroller.scrollLeft += direction * Math.max(120, (scroller.clientWidth - labelWidth) * 0.75);
  }

  /** Bij het openen staat de tijdbalk op vandaag; daarna bepaalt de gebruiker
   *  zelf waar hij kijkt. */
  useEffect(() => {
    if (centeredOnce.current) return;
    const scroller = scrollRef.current;
    const marker = todayRef.current;
    if (!scroller || !marker) return;
    centeredOnce.current = true;
    scroller.scrollLeft = todayScrollLeft(scroller, marker);
  }, [columns.length, filteredProjects.length]);

  useEffect(() => {
    const cells = colsRef.current;
    if (!cells) return;
    const measure = () => {
      const px = cells.clientWidth;
      const font = getComputedStyle(cells).fontFamily;
      setTrack(current => (current.px === px && current.font === font ? current : { px, font }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(cells);
    // Een webfont dat later binnenkomt, is breder of smaller dan de reserve.
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => observer.disconnect();
  }, [hasRows]);

  function togglePhase(phase: ProjectPhase) {
    setPhaseFilters(current => ({ ...current, [phase]: !current[phase] }));
  }

  function showEverything() {
    setQuery('');
    setClientId('');
    pickLens('alles');
  }

  /** Alleen gegevens staan hier: een inline `--ptl-col-w` zou de media queries
   *  overrulen, dus de kolombreedte hangt aan de klasse `ptl-scale-*`. */
  const boardStyle = {
    '--ptl-cols': columns.length,
    '--ptl-today': todayFraction,
    '--ptl-now-i': Math.max(0, nowIndex),
  } as CSSProperties;

  const stats = [
    { key: 'shown', label: 'Projecten', short: 'Projecten', value: filteredProjects.length, tone: '' },
    { key: 'late', label: 'Te laat', short: 'Te laat', value: lateCount, tone: lateCount > 0 ? 'is-alert' : '' },
    { key: 'open', label: 'Open taken', short: 'Open', value: openTasks, tone: '' },
    { key: 'unplanned', label: 'Zonder vaste datum', short: 'Geen datum', value: missingExactPlanning, tone: '' },
  ];

  const phaseChips = <div className="ptl-chips" role="group" aria-label="Projectfase filters">
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
  </div>;

  const scaleSwitch = <div className="ptl-scaleswitch" role="group" aria-label="Schaal van de tijdbalk">
    {scaleOptions.map(option => <button
      key={option.key}
      type="button"
      className={scale === option.key ? 'is-on' : ''}
      onClick={() => setPickedScale(option.key)}
      aria-pressed={scale === option.key}
    >{option.label}</button>)}
  </div>;

  const navigator = <div className="ptl-nav" role="group" aria-label="Door de tijd">
    <button type="button" className="ptl-nav-step" onClick={() => scrollByPage(-1)} disabled={!hasRows} aria-label="Terug in de tijd" title="Terug"><ChevronLeft size={15} aria-hidden="true" /></button>
    <button type="button" className="ptl-nav-today" onClick={scrollToToday} disabled={!hasRows || !todayInRange}>Vandaag</button>
    <button type="button" className="ptl-nav-step" onClick={() => scrollByPage(1)} disabled={!hasRows} aria-label="Verder in de tijd" title="Verder"><ChevronRight size={15} aria-hidden="true" /></button>
  </div>;

  return <section className={`ptl ptl-${variant} ptl-scale-${scale}${calm ? ' ptl-calm' : ''}`}>
    <div className="ptl-top">
      {calm
        ? <>
          <header className="ptl-head ptl-calm-head">
            <div className="ptl-heading">
              <h2>Projectplanning</h2>
              {/* Eén zin in plaats van vier tegels: wat er loopt, wanneer het
                  druk is en wat er openstaat. */}
              <p className="ptl-sentence">
                {plural(filteredProjects.length, 'project', 'projecten')} in beeld
                {peakLoad > 1 && <> · drukste {scaleNoun}: <b>{columns[columnLoads.indexOf(peakLoad)]?.label}</b> met {peakLoad} tegelijk</>}
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
              {scaleSwitch}
              {navigator}
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
              ? 'Alle projecten op één tijdbalk. Scroll opzij of gebruik de pijltjes om vooruit of terug te kijken.'
              : 'Wie loopt er wanneer? De balken tonen looptijd en voortgang per project.'}</p>
          </div>
          {/* Elk cijfer draagt twee labels: het volledige voor een breed scherm en een
              kort voor de telefoon, waar de vier cijfers op één regel staan. Alleen
              het zichtbare label wordt voorgelezen — `display:none` haalt het andere
              ook uit de toegankelijkheidsboom. */}
          <div className="ptl-stats">
            {stats.map(stat => <div key={stat.key} className={stat.tone}>
              <span>
                <span className="ptl-stat-long">{stat.label}</span>
                <span className="ptl-stat-short">{stat.short}</span>
              </span>
              <strong>{stat.value}</strong>
            </div>)}
          </div>
        </header>

        {/* Op het dashboard is er niets te zoeken: daar delen de fases en de
            tijdknoppen één regel. */}
        <div className={`ptl-toolbar${isFull ? '' : ' ptl-toolbar-compact'}`}>
          {!isFull && phaseChips}
          {isFull && <label className="ptl-search">
            <Search size={15} aria-hidden="true" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Zoek op project, klant, taak of tag" aria-label="Zoek in de planning" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Zoekterm wissen"><X size={13} /></button>}
          </label>}
          {isFull && <div className="ptl-client">
            <Select value={clientId} onChange={event => setClientId(event.target.value)} aria-label="Klant" icon={<Building2 size={14} />}>
              <option value="">Alle klanten</option>
              {data.clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}
            </Select>
          </div>}
          {isFull && <button
            type="button"
            className={`ptl-toggle ptl-archive ${showArchived ? 'is-on' : ''}`}
            onClick={() => setShowArchived(value => !value)}
            aria-pressed={showArchived}
            title={showArchived ? 'Gearchiveerde projecten staan erbij' : 'Gearchiveerde projecten staan er niet bij'}
          ><Archive size={14} aria-hidden="true" /><span className="ptl-archive-text">{showArchived ? 'Met archief' : 'Zonder archief'}</span></button>}

          <div className="ptl-toolbar-end">
            {scaleSwitch}
            {navigator}
          </div>
        </div>

        {isFull && phaseChips}
        </>}
    </div>

    {!hasRows
      ? <div className="ptl-empty">
        <span className="ptl-empty-icon" aria-hidden="true"><CalendarRange size={20} /></span>
        <strong>Geen projecten binnen deze filters</strong>
        <span>Zet een fase aan, kies een andere klant of pas je zoekwoord aan.</span>
        <button type="button" className="ptl-empty-btn" onClick={showEverything}>Alles tonen</button>
      </div>
      : <>
      <div className="ptl-scroll" ref={scrollRef} role="region" aria-label="Projecttijdbalk" tabIndex={0}>
        <div className="ptl-board" style={boardStyle}>
          {/* De huidige week (of maand) licht over de hele hoogte op: zo zie
              je in één oogopslag wat er nú loopt. */}
          {nowIndex >= 0 && <div className="ptl-nowcol" aria-hidden="true" />}

          <div className="ptl-headband">
            <div className="ptl-corner">
              <span>Projecten</span>
              <b>{filteredProjects.length}</b>
            </div>
            <div className="ptl-cells ptl-groups">
              {groups.map(group => <div className="ptl-group" key={group.key} style={{ gridColumn: `span ${group.span}` }}>
                <span>{group.label}</span>
              </div>)}
            </div>
            <div className="ptl-cells ptl-cols" ref={colsRef}>
              {columns.map(column => <div
                className={`ptl-col ${isNowColumn(column, now) ? 'is-now' : ''}`}
                key={column.key}
              >
                <strong>{column.label}</strong>
                {column.sub && <span>{column.sub}</span>}
              </div>)}
            </div>
            <div className="ptl-corner ptl-corner-load" title={`Hoeveel projecten er per ${scaleNoun} tegelijk lopen`}>
              <span>Drukte</span>
              {peakLoad > 0 && <em>max {peakLoad}</em>}
            </div>
            <div className="ptl-cells ptl-loads">
              {columns.map((column, index) => {
                const load = columnLoads[index];
                return <div
                  className={`ptl-load${load > 0 && load === peakLoad ? ' is-peak' : ''}${index === nowIndex ? ' is-now' : ''}`}
                  key={column.key}
                  title={`${plural(load, 'project', 'projecten')} in ${column.label}`}
                >
                  {load > 0 && <span className="ptl-load-bar" style={{ '--load': peakLoad ? load / peakLoad : 0 } as CSSProperties} aria-hidden="true" />}
                  <b>{load || ''}</b>
                </div>;
              })}
            </div>

            {todayInRange && <div className="ptl-todaycap" aria-hidden="true"><span>Vandaag</span></div>}
          </div>

          <div className="ptl-rows">
            {bars.map(({ item, left, width, overrun, overdueDays, dateLabel, fit, afterOffset }) => {
              const openProjectTasks = item.tasks.length - item.doneTasks;
              const lateNote = overdueDays > 0 ? ` · ${plural(overdueDays, 'dag', 'dagen')} over de einddatum` : '';
              const barTitle = `${item.project.name} — ${phaseLabel(item.phase)} · ${dateLabel}${lateNote} · ${item.progress}% klaar · ${plural(openProjectTasks, 'open taak', 'open taken')}`;
              const swatch = { '--pc': item.project.color || 'var(--accent)' } as CSSProperties;

              return <article className={`ptl-row ptl-project phase-${item.phase}`} key={item.project.id}>
                <div className="ptl-label">
                  <button type="button" className="ptl-label-btn" onClick={() => openProject(item.project.id)} title={barTitle}>
                    <span className="ptl-swatch" style={swatch} aria-hidden="true" />
                    <strong className="ptl-label-name">{item.project.name}</strong>
                    <span className="ptl-label-sub">
                      <span className={item.hasClient ? '' : 'is-none'}>{item.clientName}</span>
                      {item.tasks.length > 0 && <span className="ptl-label-tasks">{item.doneTasks}/{item.tasks.length} taken</span>}
                    </span>
                    <em className={`ptl-phase phase-${item.phase}`}>{phaseLabel(item.phase)}</em>
                  </button>
                </div>
                <div className="ptl-track">
                  {overrun && overrun.width > 0 && <span
                    className="ptl-overrun"
                    style={{ left: `${overrun.left}%`, width: `${overrun.width}%` }}
                    aria-hidden="true"
                  />}
                  <button
                    type="button"
                    className={`ptl-bar fit-${fit}${item.hasExactPlanning ? '' : ' is-estimated'}`}
                    onClick={() => openProject(item.project.id)}
                    style={{ left: `${left}%`, width: `${width}%`, '--pc': item.project.color || 'var(--accent)', '--after': `${afterOffset}px` } as CSSProperties}
                    title={barTitle}
                    aria-label={barTitle}
                  >
                    <span className="ptl-bar-body" aria-hidden="true">
                      <span className="ptl-bar-fill" style={{ width: `${item.progress}%` }} />
                    </span>
                    <span className="ptl-bar-text" aria-hidden="true">
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
      </div>

      {/* Wat de vormen betekenen, alleen als ze ook op het bord staan. */}
      {(anyEstimated || anyOverrun || todayInRange) && <div className="ptl-legend" aria-hidden="true">
        {todayInRange && <span className="ptl-legend-item"><i className="ptl-key-today" />Vandaag</span>}
        <span className="ptl-legend-item"><i className="ptl-key-progress" />Voortgang (afgeronde taken)</span>
        {anyEstimated && <span className="ptl-legend-item"><i className="ptl-key-estimated" />Geschatte looptijd</span>}
        {anyOverrun && <span className="ptl-legend-item"><i className="ptl-key-overrun" />Over de einddatum</span>}
      </div>}
      </>}
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

/** Vandaag op tweevijfde van het zichtbare spoor: iets terug en meer vooruit.
 *  Het midden van het hele venster lag achter de vaste projectkolom; op de
 *  telefoon stond vandaag dan tegen de linkerrand. */
function todayScrollLeft(scroller: HTMLElement, marker: HTMLElement) {
  const labelWidth = scroller.querySelector<HTMLElement>('.ptl-corner')?.offsetWidth ?? 0;
  const visibleTrack = Math.max(0, scroller.clientWidth - labelWidth);
  return Math.max(0, marker.offsetLeft - labelWidth - visibleTrack * 0.4);
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Breedte van een tekst in pixels, zonder hem eerst in de pagina te zetten.
 *  Zonder canvas (oude browser, test) schatten we per teken. */
function textWidth(text: string, font: string) {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) return text.length * 6.8;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
