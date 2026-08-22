import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Check, CheckSquare, ChevronLeft, ChevronRight, MessageSquare, Plus, X } from 'lucide-react';
import type { AppData, CalendarExternalEvent, OrganizationMember, PlannerNote, Priority, Task, TaskStatus, UUID } from '../types';
import { getCachedCalendarEvents, listCalendarEventsCached } from '../lib/calendar-api';
import { memberColor, memberInitials, memberShortName } from '../lib/members';
import { SearchFilterPanel } from '../components/SearchFilterPanel';
import { AssigneeAvatars } from '../components/AssigneeAvatars';
import { addDays, DAY_NAMES_NL, formatISODate, isoWeekNumber, isSameDay, parseISODate, startOfWeek } from '../lib/dates';
import { comparePlannedTasks, edgeScrollDelta, groupEventMinutesByDay, isSpanningTask, layoutWeekBars, PANE_EDGE_SCROLL_ZONE_PX, parseDurationInput, shiftDateKey } from '../lib/planning';
import type { WeekBar } from '../lib/planning';
import { priorityLabel } from '../lib/format';

type StatusFilter = 'open' | 'all' | TaskStatus;
type Scope = 'mine' | 'team';
type Density = 'compact' | 'comfortable';
/** Maakt het plusje van een dag werk van één dag, of een strook over meer dagen? */
type QuickAddMode = 'day' | 'week';

type PlannerFilters = {
  query: string;
  clientId: string;
  projectId: string;
  priority: 'all' | Priority;
  status: StatusFilter;
};

type DropTarget =
  /** `userId` is alleen gezet in de teamweergave: daar bepaalt de rij waar je
   *  loslaat óók aan wie de taak wordt toegewezen. `null` = niemand. */
  | { type: 'day'; date: string; beforeTaskId: UUID | null; userId?: string | null }
  | { type: 'unscheduled' };

/** Sleutel voor de rij "nog aan niemand toegewezen" in de teamweergave. */
const NO_MEMBER = '__nobody__';
/** Scheidingsteken in een dropzone-sleutel: `<persoon>::<datum>`. */
const ZONE_SEP = '::';

/** Een lopend sleepgebaar. `moved` blijft false zolang het nog een klik kan worden. */
type DragState = {
  taskId: UUID;
  touch: boolean;
  origin: { x: number; y: number };
  pointer: { x: number; y: number };
  width: number;
  moved: boolean;
  target: DropTarget | null;
};

type PlannerBucket = {
  tasks: Task[];
  count: number;
  minutes: number;
  /** Hoeveel taken op deze dag nog géén tijdschatting hebben. */
  noEstimateCount: number;
  /** Uit de agenda: hoeveel van deze dag al bezet is met afspraken. */
  agendaMinutes: number;
  /** Aandeel van de weekstroken die over deze dag lopen. Een strook van drie
   *  dagen met achttien uur droeg eerder aan géén enkele dagbalk bij, waardoor
   *  een volgeplande week er leeg uitzag. Het is een verdeling, geen meting —
   *  daarom staat er een ± bij zodra dit meetelt. */
  spanMinutes: number;
};

const EMPTY_BUCKET: PlannerBucket = { tasks: [], count: 0, minutes: 0, noEstimateCount: 0, agendaMinutes: 0, spanMinutes: 0 };

/** Een lopend gebaar op een strook: verschuiven of aan een van de randen trekken. */
type BarDrag = {
  taskId: UUID;
  mode: 'move' | 'resize-start' | 'resize-end';
  grabIdx: number;
  startDate: string;
  endDate: string;
  previewStart: string;
  previewEnd: string;
  moved: boolean;
};

/** Eén taak terug naar waar hij stond, inclusief zijn plek in de rij. */
type UndoStep = {
  taskId: UUID;
  plannedDate: string | null;
  plannedEndDate: string | null;
  /** Vóór wélke taak hij stond. Zonder dit is "terug" niet meer dan "die dag". */
  beforeTaskId: UUID | null;
};

type UndoAction = {
  /** Wat er gebeurde, in gewone taal: "Montage: wo → do". */
  label: string;
  steps: UndoStep[];
};

/** Filterwaarde voor "taken die (nog) geen project of klant hebben". */
const NO_LINK = '__none__';
/** Sleutel van de lade in de dropzone-registratie; geen datum, dus botst nooit. */
const TRAY_KEY = '__unscheduled__';
/** Prefix van een dropzone in de mobiele dagstrip: slepen naar een andere dag
 *  blijft daardoor mogelijk terwijl er maar één dag in beeld staat. */
const STRIP_PREFIX = 'strip:';

const PREFS_STORAGE_KEY = 'resofly-weekplanner-prefs';

// Touch: vegen moet gewoon blijven scrollen, dus pakken we een sleep pas op nadat
// de vinger ~⅓ seconde stil ligt — hetzelfde gebaar als in de agenda.
const TOUCH_HOLD_MS = 320;
const TOUCH_HOLD_TOLERANCE_PX = 10;
// Met de muis is een paar pixels genoeg om een sleep van een klik te onderscheiden.
const MOUSE_DRAG_THRESHOLD_PX = 4;

/** Onder deze breedte staan de dagen onder elkaar in plaats van naast elkaar. */
const NARROW_QUERY = '(max-width: 900px)';

/** Korte trilling als een sleepgebaar "pakt" (waar ondersteund). */
function hapticTick() {
  try { navigator.vibrate?.(12); } catch { /* niet ondersteund — puur cosmetisch */ }
}

/** Volgt een media query, zodat de planner op smal scherm ander gedrag kan kiezen. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Wijzen twee dropzones naar dezelfde plek? Voorkomt renders zonder verschil. */
function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  if (a.type !== 'day' || b.type !== 'day') return true;
  return a.date === b.date && a.beforeTaskId === b.beforeTaskId && a.userId === b.userId;
}

/** Het dichtstbijzijnde element dat werkelijk kan scrollen, anders het venster. */
function findScrollHost(start: HTMLElement | null): HTMLElement | null {
  let node = start?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    const scrollsY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
    const scrollsX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
    if (scrollsY || scrollsX) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Het scrollbare vak dat onder de aanwijzer ligt: een dagkolom of de lade. Die
 * vakken scrollen apart van de pagina, dus tijdens het slepen moet ook dáár bij
 * de rand meegescrold worden — anders is een taak onderin een dichtgeschoven
 * lijst onbereikbaar. `stop` is het buitenste vak waar we nog in kijken; wat
 * daarboven ligt is de pagina zelf en gaat via de gewone weg.
 */
function scrollablePaneAt(x: number, y: number, stop: HTMLElement | null): HTMLElement | null {
  const hit = document.elementFromPoint(x, y);
  let node = hit instanceof HTMLElement ? hit : null;
  while (node && node !== stop) {
    if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}


type StoredPrefs = {
  scope: Scope;
  density: Density;
  clientId: string;
  projectId: string;
  priority: PlannerFilters['priority'];
  status: StatusFilter;
};

/** Weergavekeuzes overleven het wisselen van tabblad en het herladen van de app.
 *  De zoektekst bewaren we bewust niet: die hoort bij één zoekactie. */
function loadPrefs(): Partial<StoredPrefs> {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw as Partial<StoredPrefs> : {};
  } catch {
    return {};
  }
}

export function WeekPlanner({
  data,
  organizationId,
  canWrite,
  teamMembers,
  currentUserId,
  onPlanTask,
  onSetTaskPeriod,
  onQuickAddTask,
  onCarryOver,
  onAssignTask,
  onAddNote,
  onToggleNote,
  onRemoveNote,
  onEditTask,
  onSetTaskStatus,
  onSetTaskEstimate,
  onOpenProject,
  onOpenCalendar,
}: {
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  teamMembers: OrganizationMember[];
  currentUserId: string | null;
  onPlanTask: (taskId: UUID, plannedDate: string | null, beforeTaskId?: UUID | null) => Promise<void>;
  onSetTaskPeriod: (taskId: UUID, plannedDate: string, plannedEndDate: string | null) => Promise<void>;
  onQuickAddTask: (plannedDate: string, title: string, plannedEndDate?: string | null) => Promise<Task | null>;
  onCarryOver: (taskIds: UUID[], toDate: string) => Promise<void>;
  onAssignTask: (taskId: UUID, userId: string | null, mode?: 'replace' | 'add') => Promise<void>;
  onAddNote: (weekStart: string, text: string) => Promise<void>;
  onToggleNote: (id: UUID, done: boolean) => Promise<void>;
  onRemoveNote: (id: UUID) => Promise<void>;
  onEditTask: (task: Task) => void;
  onSetTaskStatus: (task: Task, status: TaskStatus) => Promise<void> | void;
  onSetTaskEstimate: (task: Task, minutes: number | null) => Promise<void> | void;
  onOpenProject: (projectId: UUID) => void;
  /** Opent de agenda op één dag — de chips in de dagkolom zijn nu deuren. */
  onOpenCalendar: (dateKey: string) => void;
}) {
  const storedPrefs = useRef(loadPrefs()).current;

  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [scope, setScope] = useState<Scope>(storedPrefs.scope === 'team' ? 'team' : 'mine');
  const [density, setDensity] = useState<Density>(storedPrefs.density === 'comfortable' ? 'comfortable' : 'compact');
  const [filters, setFilters] = useState<PlannerFilters>({
    query: '',
    clientId: storedPrefs.clientId ?? '',
    projectId: storedPrefs.projectId ?? '',
    priority: storedPrefs.priority ?? 'all',
    status: storedPrefs.status ?? 'open',
  });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quickAddDay, setQuickAddDay] = useState<string | null>(null);
  /** Welke dag er op een smal scherm in beeld staat. */
  const [mobileDay, setMobileDay] = useState<string>(() => formatISODate(new Date()));
  /** Snelinvoer in de teamweergave: welke persoon, welke dag. */
  const [teamQuickAdd, setTeamQuickAdd] = useState<{ rowKey: string; dateKey: string } | null>(null);
  const [quickAddBusy, setQuickAddBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Op smal scherm staan de dagen onder elkaar; een strook over kolommen slepen
  // heeft dan geen betekenis meer.
  const isNarrow = useMediaQuery(NARROW_QUERY);

  useEffect(() => {
    const prefs: StoredPrefs = {
      scope,
      density,
      clientId: filters.clientId,
      projectId: filters.projectId,
      priority: filters.priority,
      status: filters.status,
    };
    try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs)); } catch { /* privémodus: niet erg */ }
  }, [scope, density, filters.clientId, filters.projectId, filters.priority, filters.status]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const weekEnd = days[6];
  const dayKeys = useMemo(() => new Set(days.map(formatISODate)), [days]);

  // ── Agenda-afspraken van de zichtbare week ────────────────────────────
  // De planner rekende met acht lege uren per dag; de agenda wist hij niets van.
  // Nu telt de balk eerst je afspraken en dan pas je taken.
  const windowStart = useMemo(() => new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate()).toISOString(), [anchor]);
  const windowEnd = useMemo(() => addDays(weekEnd, 1).toISOString(), [weekEnd]);
  const [events, setEvents] = useState<CalendarExternalEvent[]>(
    () => getCachedCalendarEvents(organizationId, windowStart, windowEnd) ?? [],
  );

  useEffect(() => {
    let cancelled = false;
    // Meteen tonen wat al in de cache zit, zodat bladeren niet flikkert.
    setEvents(getCachedCalendarEvents(organizationId, windowStart, windowEnd) ?? []);
    listCalendarEventsCached(organizationId, windowStart, windowEnd)
      .then(fetched => { if (!cancelled) setEvents(fetched); })
      // Geen agenda gekoppeld of even niet bereikbaar: de planner werkt dan
      // gewoon door met alleen de taken. Dit mag de pagina nooit blokkeren.
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [organizationId, windowStart, windowEnd]);

  const agendaByDay = useMemo(() => groupEventMinutesByDay(days.map(formatISODate), events), [events, days]);

  const projectsById = useMemo(() => new Map(data.projects.map(project => [project.id, project])), [data.projects]);
  const clientsById = useMemo(() => new Map(data.clients.map(client => [client.id, client])), [data.clients]);
  const assigneesByTask = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of data.taskAssignees) {
      const list = map.get(a.task_id);
      if (list) list.push(a.user_id); else map.set(a.task_id, [a.user_id]);
    }
    return map;
  }, [data.taskAssignees]);

  /** Gearchiveerde projecten horen niet in de keuzelijst — anders kies je werk
   *  van twee jaar terug. Staat er tóch een archiefproject in het filter (bijv.
   *  omdat het net gearchiveerd is), dan blijft dat ene zichtbaar zodat de
   *  dropdown zijn eigen waarde niet kwijtraakt. */
  const projectOptions = useMemo(() => {
    const live = data.projects.filter(project => !project.archived || project.id === filters.projectId);
    if (!filters.clientId || filters.clientId === NO_LINK) return live;
    return live.filter(project => project.client_id === filters.clientId);
  }, [data.projects, filters.clientId, filters.projectId]);

  /** Projecten die uit beeld horen te blijven. De lade liep vol met taken van
   *  gearchiveerde projecten; die zijn per definitie niet meer in te plannen. */
  const archivedProjectIds = useMemo(
    () => new Set(data.projects.filter(project => project.archived).map(project => project.id)),
    [data.projects],
  );

  const filteredTasks = useMemo(() => {
    const normalizedQuery = filters.query.trim().toLowerCase();

    return data.tasks.filter(task => {
      // Werk van een gearchiveerd project plan je niet meer in. Kies je dat
      // project expliciet in het filter, dan zie je het wél — dat is dan een
      // bewuste vraag en geen ruis.
      if (task.project_id && archivedProjectIds.has(task.project_id) && filters.projectId !== task.project_id) return false;

      // "Mijn week" toont wat aan mij is toegewezen én wat nog aan niemand hangt —
      // anders zou een net toegevoegde losse taak meteen uit beeld verdwijnen.
      if (scope === 'mine' && currentUserId) {
        const assignees = assigneesByTask.get(task.id);
        if (assignees && assignees.length > 0 && !assignees.includes(currentUserId)) return false;
      }

      const project = task.project_id ? projectsById.get(task.project_id) ?? null : null;
      const clientId = project?.client_id ?? task.client_id ?? null;
      const client = clientId ? clientsById.get(clientId) ?? null : null;

      if (filters.status === 'open' && task.status === 'done') return false;
      if (filters.status !== 'open' && filters.status !== 'all' && task.status !== filters.status) return false;
      if (filters.priority !== 'all' && task.priority !== filters.priority) return false;
      if (filters.projectId === NO_LINK && task.project_id) return false;
      if (filters.projectId && filters.projectId !== NO_LINK && task.project_id !== filters.projectId) return false;
      if (filters.clientId === NO_LINK && clientId) return false;
      if (filters.clientId && filters.clientId !== NO_LINK && clientId !== filters.clientId) return false;

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
  }, [archivedProjectIds, assigneesByTask, clientsById, currentUserId, data.tasks, filters, projectsById, scope]);

  const { byDay, unscheduled, outsideThisWeek, weekBucket, busiestMinutes, spanningTasks } = useMemo(() => {
    const byDay = new Map<string, PlannerBucket>();
    const unscheduled: Task[] = [];
    const outsideThisWeek: Task[] = [];
    const spanningTasks: Task[] = [];
    const orderedKeys = days.map(formatISODate);
    const firstKey = orderedKeys[0];
    const lastKey = orderedKeys[orderedKeys.length - 1];
    for (const key of orderedKeys) byDay.set(key, { ...EMPTY_BUCKET, tasks: [] });

    for (const task of filteredTasks) {
      const plannedDate = task.planned_date ?? null;
      if (!plannedDate) {
        unscheduled.push(task);
        continue;
      }

      // Werk over meerdere dagen hoort in de strokenband, niet in één dagkolom.
      if (isSpanningTask(task)) {
        if (task.planned_end_date! >= firstKey && plannedDate <= lastKey) spanningTasks.push(task);
        else outsideThisWeek.push(task);
        continue;
      }

      if (dayKeys.has(plannedDate)) {
        byDay.get(plannedDate)!.tasks.push(task);
      } else {
        outsideThisWeek.push(task);
      }
    }

    for (const [key, bucket] of byDay) {
      bucket.tasks.sort(comparePlannedTasks);
      bucket.count = bucket.tasks.length;
      bucket.minutes = bucket.tasks.reduce((sum, task) => sum + taskEstimateMinutes(task), 0);
      bucket.noEstimateCount = bucket.tasks.filter(task => !hasEstimate(task)).length;
      bucket.agendaMinutes = agendaByDay.get(key)?.minutes ?? 0;
    }

    // Weekstroken verdelen hun uren over de dagen die ze beslaan.
    for (const task of spanningTasks) {
      const minutes = taskEstimateMinutes(task);
      if (minutes <= 0) continue;
      const covered = orderedKeys.filter(key => key >= task.planned_date! && key <= task.planned_end_date!);
      if (covered.length === 0) continue;
      const share = minutes / covered.length;
      for (const key of covered) {
        const bucket = byDay.get(key);
        if (bucket) bucket.spanMinutes += share;
      }
    }

    unscheduled.sort(sortLooseTasks);
    outsideThisWeek.sort(sortOutsideTasks);

    const weekTasks = Array.from(byDay.values()).flatMap(bucket => bucket.tasks);
    const weekBucket: PlannerBucket = {
      tasks: weekTasks,
      count: weekTasks.length,
      minutes: weekTasks.reduce((sum, task) => sum + taskEstimateMinutes(task), 0),
      noEstimateCount: [...weekTasks, ...spanningTasks].filter(task => !hasEstimate(task)).length,
      agendaMinutes: Array.from(byDay.values()).reduce((sum, bucket) => sum + bucket.agendaMinutes, 0),
      spanMinutes: 0,
    };
    // De balk per dag wordt geschaald op de volste dag van deze week: geen norm,
    // alleen de onderlinge verhouding. De weekstroken tellen nu wél mee met hun
    // aandeel per dag — een strook van achttien uur die nul bijdraagt is erger
    // dan een verdeling met een ± ervoor.
    const busiestMinutes = Math.max(0, ...Array.from(byDay.values()).map(bucket => bucket.minutes + bucket.agendaMinutes + bucket.spanMinutes));

    return { byDay, unscheduled, outsideThisWeek, weekBucket, busiestMinutes, spanningTasks };
  }, [agendaByDay, dayKeys, days, filteredTasks]);

  // "Vandaag" mag niet blijven staan op gisteren wanneer de app 's nachts open
  // blijft — alle werktabbladen blijven gemount. Eén timer die precies om
  // middernacht afgaat, plus een controle zodra het venster weer focus krijgt;
  // géén interval van een minuut dat de hele app wakker houdt.
  const [todayLocal, setTodayLocal] = useState(() => new Date());
  useEffect(() => {
    let timer = 0;
    function schedule() {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
      timer = window.setTimeout(() => { setTodayLocal(new Date()); schedule(); }, midnight.getTime() - now.getTime());
    }
    function onFocus() {
      setTodayLocal(prev => isSameDay(prev, new Date()) ? prev : new Date());
    }
    schedule();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const weekLabel = `Week ${isoWeekNumber(anchor)} · ${anchor.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })} – ${weekEnd.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  const isCurrentWeek = isSameDay(anchor, startOfWeek(todayLocal));

  /** Alle taakuren van de week: dagtaken plus de weekstroken. Die laatste vielen
   *  eerder buiten het weektotaal en hingen als los pilletje in de kop. */
  const weekTaskMinutes = weekBucket.minutes + spanningTasks.reduce((sum, task) => sum + taskEstimateMinutes(task), 0);
  const weekTaskCount = weekBucket.count + spanningTasks.length;

  /** De schaal van de dagbalken. Een bodem van vier uur voorkomt dat één taak van
   *  een kwartier de maandagbalk helemaal vol trekt: zonder bodem is de volste
   *  dag per definitie 100%, hoe leeg de week ook is. */
  const loadScale = Math.max(busiestMinutes, 240);
  const busiestKey = useMemo(() => {
    let best: { key: string; minutes: number } | null = null;
    for (const [key, bucket] of byDay) {
      const total = bucket.minutes + bucket.agendaMinutes;
      if (total > 0 && (!best || total > best.minutes)) best = { key, minutes: total };
    }
    return best?.key ?? null;
  }, [byDay]);

  // ── Blijven liggen werk ───────────────────────────────────────────────
  // Open taken met een plandatum vóór vandaag. Niet automatisch verplaatsen:
  // dat zou de geschiedenis herschrijven. Eén klik, en jij beslist.
  const todayKey = formatISODate(todayLocal);
  /**
   * Alles wat open staat en waarvan de laatste dag voorbij is — inclusief de
   * weekstroken, die hier eerder expliciet werden overgeslagen. Op vrijdagmiddag
   * telt je eigen vrijdagwerk mee: dat is precies het moment waarop je deze
   * vraag stelt, en het viel er eerst buiten omdat alleen `< vandaag` telde.
   */
  const overdueTasks = useMemo(() => filteredTasks
    .filter(task => task.status !== 'done' && !!task.planned_date && (task.planned_end_date ?? task.planned_date)! <= todayKey)
    .sort((a, b) => String(a.planned_date).localeCompare(String(b.planned_date)) || sortLooseTasks(a, b)),
    [filteredTasks, todayKey]);
  const [carryOverBusy, setCarryOverBusy] = useState(false);
  /** Per week weggeklikt, niet voor de hele sessie: één vlag die bij bladeren
   *  nooit terugkwam maakte het voorstel onvindbaar. */
  const [carryOverDismissed, setCarryOverDismissed] = useState<string[]>([]);

  /** Taken met een deadline ín deze week — die verdienen een eigen tabblad in de lade. */
  const deadlineThisWeek = useMemo(() => {
    const first = formatISODate(days[0]);
    const last = formatISODate(days[6]);
    return filteredTasks
      .filter(task => task.status !== 'done' && !!task.end_date && task.end_date >= first && task.end_date <= last)
      .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)) || sortLooseTasks(a, b));
  }, [days, filteredTasks]);

  /** Taken met een deadline in deze week die nog nergens gepland staan. Dat is
   *  het signaal dat vooruitkijkt; de meeneembalk kijkt alleen achteruit. */
  const unplannedDeadlines = useMemo(
    () => deadlineThisWeek.filter(task => !task.planned_date),
    [deadlineThisWeek],
  );


  /** Actiepunten van de zichtbare week (persoonlijk, uit de database). */
  const weekNotes = useMemo(() => {
    const weekStart = formatISODate(anchor);
    return data.plannerNotes
      .filter(note => note.week_start === weekStart)
      .sort((a, b) => (a.position - b.position) || a.created_at.localeCompare(b.created_at));
  }, [anchor, data.plannerNotes]);

  /** Eén rij per persoon in de teamweergave, plus een rij voor werk dat nog aan
   *  niemand hangt. Een taak met meerdere toegewezenen staat in elke rij. */
  const teamRows = useMemo(() => {
    if (scope !== 'team') return [];
    type Row = { key: string; name: string; color: string; initials: string; byDay: Map<string, Task[]>; total: number };
    const rows = new Map<string, Row>();

    const ensure = (key: string): Row => {
      let row = rows.get(key);
      if (!row) {
        const isNobody = key === NO_MEMBER;
        row = {
          key,
          name: isNobody ? 'Nog niet toegewezen' : memberShortName(key, teamMembers, currentUserId),
          color: isNobody ? 'var(--bg5)' : memberColor(key),
          initials: isNobody ? '?' : memberInitials(key, teamMembers),
          byDay: new Map(days.map(day => [formatISODate(day), [] as Task[]])),
          total: 0,
        };
        rows.set(key, row);
      }
      return row;
    };

    for (const [dateKey, bucket] of byDay) {
      for (const task of bucket.tasks) {
        const assignees = assigneesByTask.get(task.id) ?? [];
        for (const memberKey of assignees.length > 0 ? assignees : [NO_MEMBER]) {
          const row = ensure(memberKey);
          row.byDay.get(dateKey)?.push(task);
          row.total += 1;
        }
      }
    }

    // Jij bovenaan, daarna op naam, en het niet-toegewezen werk onderaan.
    return [...rows.values()].sort((a, b) => {
      if (a.key === NO_MEMBER) return 1;
      if (b.key === NO_MEMBER) return -1;
      if (currentUserId && a.key === currentUserId) return -1;
      if (currentUserId && b.key === currentUserId) return 1;
      return a.name.localeCompare(b.name, 'nl-NL');
    });
  }, [assigneesByTask, byDay, currentUserId, days, scope, teamMembers]);

  /** Staat er iets aan dat het beeld beperkt? De filters overleven het herladen,
   *  dus je kunt maandag een lege planner openen zonder te zien dat er nog een
   *  projectfilter van vrijdag aanstaat. */
  const hasActiveFilters = filters.query.trim() !== ''
    || filters.clientId !== ''
    || filters.projectId !== ''
    || filters.priority !== 'all'
    || filters.status !== 'open';

  function resetFilters() {
    setFilters({ query: '', clientId: '', projectId: '', priority: 'all', status: 'open' });
  }

  function updateFilter<K extends keyof PlannerFilters>(key: K, value: PlannerFilters[K]) {
    setFilters(prev => {
      const next = { ...prev, [key]: value };
      if (key === 'clientId') next.projectId = '';
      return next;
    });
  }

  // ── Slepen ────────────────────────────────────────────────────────────
  // De dropzones melden zichzelf aan; het raken van een zone gebeurt op
  // coördinaten, zodat muis en vinger exact dezelfde route volgen.
  const zonesRef = useRef(new Map<string, HTMLElement>());
  const registerZone = useCallback((key: string, el: HTMLElement | null) => {
    if (el) zonesRef.current.set(key, el);
    else zonesRef.current.delete(key);
  }, []);

  const dragRef = useRef<DragState | null>(null);
  const pendingFocusRef = useRef<UUID | null>(null);

  const resolveTarget = useCallback((x: number, y: number, taskId: UUID): DropTarget | null => {
    for (const [key, el] of zonesRef.current) {
      const rect = el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (key === TRAY_KEY) return { type: 'unscheduled' };
      // Loslaten op de dagstrip: dan is de dag zelf het doel, achteraan.
      if (key.startsWith(STRIP_PREFIX)) return { type: 'day', date: key.slice(STRIP_PREFIX.length), beforeTaskId: null };
      // In de teamweergave heet een zone `<persoon>::<datum>`; de rij waar je
      // loslaat bepaalt dan óók de toewijzing.
      const separator = key.indexOf(ZONE_SEP);
      const date = separator >= 0 ? key.slice(separator + ZONE_SEP.length) : key;
      const member = separator >= 0 ? key.slice(0, separator) : null;
      const userId = member === null ? undefined : (member === NO_MEMBER ? null : member);

      const cards = Array.from(el.querySelectorAll<HTMLElement>('[data-task-id]'));
      for (const card of cards) {
        if (card.dataset.taskId === taskId) continue;
        const cardRect = card.getBoundingClientRect();
        if (y < cardRect.top + cardRect.height / 2) {
          return { type: 'day', date, beforeTaskId: card.dataset.taskId as UUID, userId };
        }
      }
      return { type: 'day', date, beforeTaskId: null, userId };
    }
    return null;
  }, []);

  // ── Ongedaan maken ────────────────────────────────────────────────────
  // "Undo" kwam in dit scherm nul keer voor, en een sleep die net naast een
  // dropzone landde was volkomen stil. Wie bang is iets kwijt te raken sleept
  // niet meer, en dan is een briefje sneller dan het bord.
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const undoTimer = useRef(0);

  const offerUndo = useCallback((action: UndoAction) => {
    setUndo(action);
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 9000);
  }, []);
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  /**
   * Legt van elke taak vast waar hij nú staat — inclusief vóór wélke taak.
   * Dat laatste is het punt: `reorder_task_planning` hernummert de hele dag, dus
   * na de verplaatsing bestaat de oude volgorde niet meer en is "terug" zonder
   * die buurman niet meer dan "ergens op die dag".
   */
  const captureUndo = useCallback((taskIds: UUID[]): UndoStep[] => {
    return taskIds.map(taskId => {
      const task = data.tasks.find(row => row.id === taskId);
      if (!task) return null;
      const siblings = task.planned_date
        ? [...data.tasks.filter(row => row.planned_date === task.planned_date && !isSpanningTask(row))].sort(comparePlannedTasks)
        : [];
      const index = siblings.findIndex(row => row.id === taskId);
      return {
        taskId,
        plannedDate: task.planned_date ?? null,
        plannedEndDate: task.planned_end_date ?? null,
        beforeTaskId: index >= 0 ? siblings[index + 1]?.id ?? null : null,
      } as UndoStep;
    }).filter((step): step is UndoStep => step !== null);
  }, [data.tasks]);

  async function runUndo() {
    const action = undo;
    if (!action || undoBusy) return;
    setUndoBusy(true);
    setError(null);
    try {
      for (const step of action.steps) {
        if (step.plannedDate && step.plannedEndDate && step.plannedEndDate > step.plannedDate) {
          await onSetTaskPeriod(step.taskId, step.plannedDate, step.plannedEndDate);
        } else {
          await onPlanTask(step.taskId, step.plannedDate, step.beforeTaskId);
        }
      }
      setUndo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ongedaan maken mislukt');
    } finally {
      setUndoBusy(false);
    }
  }

  const commitPlan = useCallback(async (taskId: UUID, target: DropTarget) => {
    const task = data.tasks.find(t => t.id === taskId);
    if (!task) return;
    const plannedDate = target.type === 'day' ? target.date : null;
    const beforeTaskId = target.type === 'day' ? target.beforeTaskId : null;
    if (beforeTaskId === taskId) return;

    // In de teamweergave: losgelaten in de rij van een ander? Dan verhuist de
    // taak mee naar die persoon.
    const targetUser = target.type === 'day' ? target.userId : undefined;
    const current = assigneesByTask.get(taskId) ?? [];
    const reassign = targetUser !== undefined
      && !(targetUser === null ? current.length === 0 : current.length === 1 && current[0] === targetUser);

    // Al op deze plek, en niemand hoeft te verhuizen? Dan hoeft er niets naar de server.
    if (!reassign && (task.planned_date ?? null) === plannedDate && !beforeTaskId) {
      const bucket = plannedDate ? byDay.get(plannedDate) : null;
      if (bucket && bucket.tasks[bucket.tasks.length - 1]?.id === taskId) return;
      if (!plannedDate) return;
    }

    setError(null);
    pendingFocusRef.current = taskId;
    const undoSteps = captureUndo([taskId]);
    try {
      await onPlanTask(taskId, plannedDate, beforeTaskId);
      offerUndo({
        label: `${task.title}: ${undoSteps[0] ? planLabel(undoSteps[0].plannedDate) : '?'} → ${planLabel(plannedDate)}`,
        steps: undoSteps,
      });
      if (!reassign) return;
      // Hangt de taak aan meerdere mensen, dan is "verplaatsen" dubbelzinnig:
      // vervang je het hele team of komt deze collega erbij? Eerder werd er
      // stilzwijgend vervangen en raakte je zonder één woord mensen kwijt.
      if (targetUser && current.length > 1) {
        setAssignChoice({ taskId, userId: targetUser, point: dragRef.current?.pointer ?? null });
        return;
      }
      await onAssignTask(taskId, targetUser ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Planning bijwerken mislukt');
    }
  }, [assigneesByTask, byDay, captureUndo, data.tasks, offerUndo, onAssignTask, onPlanTask]);

  // ── Snelmenu ──────────────────────────────────────────────────────────
  // `onContextMenu` kwam in de hele app niet voor, en lang indrukken is op touch
  // al bezet door het slepen. Eén menu dekt zeven handelingen die anders elk hun
  // eigen knopje op een kaart van 52px hadden moeten krijgen.
  const [menu, setMenu] = useState<{ taskId: UUID; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  function openMenu(task: Task, x: number, y: number) {
    if (!canWrite) return;
    setMenu({ taskId: task.id, x, y });
  }

  /** Openstaande vraag na een sleep naar de rij van een collega. */
  const [assignChoice, setAssignChoice] = useState<{ taskId: UUID; userId: string; point: { x: number; y: number } | null } | null>(null);

  async function resolveAssignChoice(mode: 'replace' | 'add' | 'cancel') {
    const choice = assignChoice;
    setAssignChoice(null);
    if (!choice || mode === 'cancel') return;
    try {
      await onAssignTask(choice.taskId, choice.userId, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toewijzen mislukt');
    }
  }

  // Zet de focus terug op de kaart die zojuist verplaatst is, zodat je met het
  // toetsenbord door kunt werken zonder opnieuw te hoeven zoeken.
  useEffect(() => {
    const taskId = pendingFocusRef.current;
    if (!taskId) return;
    pendingFocusRef.current = null;
    const el = document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
    el?.focus({ preventScroll: false });
  }, [data.tasks]);

  // ── Weekstroken ───────────────────────────────────────────────────────
  const [barDrag, setBarDrag] = useState<BarDrag | null>(null);
  const barDragRef = useRef<BarDrag | null>(null);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const orderedDayKeys = useMemo(() => days.map(formatISODate), [days]);

  /** Welke dagkolom ligt er onder deze x-positie? */
  const dayIndexFromX = useCallback((x: number): number | null => {
    const el = bandRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const index = Math.floor(((x - rect.left) / rect.width) * 7);
    return Math.max(0, Math.min(6, index));
  }, []);

  /** Stroken tekenen we tijdens het slepen op hun voorbeeldpositie. */
  const barTasks = useMemo(() => {
    if (!barDrag?.moved) return spanningTasks;
    return spanningTasks.map(task => task.id === barDrag.taskId
      ? { ...task, planned_date: barDrag.previewStart, planned_end_date: barDrag.previewEnd }
      : task);
  }, [barDrag, spanningTasks]);

  const { bars, laneCount } = useMemo(() => layoutWeekBars(orderedDayKeys, barTasks), [barTasks, orderedDayKeys]);

  const commitPeriod = useCallback(async (taskId: UUID, start: string, end: string) => {
    setError(null);
    const task = data.tasks.find(row => row.id === taskId);
    const undoSteps = captureUndo([taskId]);
    try {
      await onSetTaskPeriod(taskId, start, end > start ? end : null);
      offerUndo({ label: `${task?.title ?? 'Weekstrook'}: periode verzet`, steps: undoSteps });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Weekstrook bijwerken mislukt');
    }
  }, [captureUndo, data.tasks, offerUndo, onSetTaskPeriod]);

  function beginBarPointer(e: React.PointerEvent, bar: WeekBar, mode: BarDrag['mode']) {
    if (!canWrite) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    const grabIdx = dayIndexFromX(e.clientX);
    if (grabIdx === null) return;
    const start = bar.task.planned_date!;
    const end = bar.task.planned_end_date!;
    const next: BarDrag = {
      taskId: bar.task.id, mode, grabIdx,
      startDate: start, endDate: end,
      previewStart: start, previewEnd: end,
      // Aan een rand trekken is meteen een gebaar; het lijf mag nog een klik worden.
      moved: mode !== 'move',
    };
    barDragRef.current = next;
    setBarDrag(next);
  }

  const isBarDragging = barDrag !== null;
  useEffect(() => {
    if (!isBarDragging) return;

    function onMove(e: PointerEvent) {
      const state = barDragRef.current;
      if (!state) return;
      const index = dayIndexFromX(e.clientX);
      if (index === null) return;

      let previewStart = state.startDate;
      let previewEnd = state.endDate;
      if (state.mode === 'move') {
        const delta = index - state.grabIdx;
        previewStart = shiftDateKey(state.startDate, delta);
        previewEnd = shiftDateKey(state.endDate, delta);
      } else if (state.mode === 'resize-start') {
        const candidate = orderedDayKeys[index];
        previewStart = candidate > state.endDate ? state.endDate : candidate;
      } else {
        const candidate = orderedDayKeys[index];
        previewEnd = candidate < state.startDate ? state.startDate : candidate;
      }

      const moved = state.moved || previewStart !== state.startDate || previewEnd !== state.endDate;
      if (moved === state.moved && previewStart === state.previewStart && previewEnd === state.previewEnd) return;
      const next: BarDrag = { ...state, previewStart, previewEnd, moved };
      barDragRef.current = next;
      setBarDrag(next);
    }

    function onUp() {
      const state = barDragRef.current;
      barDragRef.current = null;
      setBarDrag(null);
      if (!state) return;
      if (!state.moved) {
        const task = data.tasks.find(t => t.id === state.taskId);
        if (task) onEditTask(task);
        return;
      }
      if (state.previewStart === state.startDate && state.previewEnd === state.endDate) return;
      void commitPeriod(state.taskId, state.previewStart, state.previewEnd);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [isBarDragging, commitPeriod, data.tasks, dayIndexFromX, onEditTask, orderedDayKeys]);

  function handleBarKey(e: React.KeyboardEvent, bar: WeekBar) {
    const task = bar.task;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEditTask(task); return; }
    if (!canWrite) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

    e.preventDefault();
    e.stopPropagation(); // niet ook nog een week vooruit bladeren
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const start = task.planned_date!;
    const end = task.planned_end_date!;
    if (e.shiftKey) {
      // Met shift verschuif je alleen het einde: korter of langer maken.
      const nextEnd = shiftDateKey(end, step);
      void commitPeriod(task.id, start, nextEnd < start ? start : nextEnd);
    } else {
      void commitPeriod(task.id, shiftDateKey(start, step), shiftDateKey(end, step));
    }
  }

  const holdCancelRef = useRef<(() => void) | null>(null);
  const cancelHold = useCallback(() => { holdCancelRef.current?.(); }, []);
  const startHold = useCallback((x: number, y: number, arm: () => void) => {
    cancelHold();
    let timer = 0;
    function detach() {
      window.clearTimeout(timer);
      if (holdCancelRef.current === detach) holdCancelRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', detach);
      window.removeEventListener('pointercancel', detach);
    }
    function onMove(ev: PointerEvent) {
      if (Math.hypot(ev.clientX - x, ev.clientY - y) > TOUCH_HOLD_TOLERANCE_PX) detach();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', detach);
    window.addEventListener('pointercancel', detach);
    timer = window.setTimeout(() => { detach(); hapticTick(); arm(); }, TOUCH_HOLD_MS);
    holdCancelRef.current = detach;
  }, [cancelHold]);
  useEffect(() => cancelHold, [cancelHold]);

  const armDrag = useCallback((taskId: UUID, x: number, y: number, touch: boolean, width: number) => {
    const next: DragState = {
      taskId, touch, origin: { x, y }, pointer: { x, y }, width,
      moved: touch, // een lange druk ís al een sleepgebaar
      target: null,
    };
    dragRef.current = next;
    setDrag(next);
  }, []);

  function beginCardPointer(e: React.PointerEvent, task: Task) {
    if (!canWrite) return;
    const el = e.currentTarget as HTMLElement;
    const width = el.getBoundingClientRect().width;
    const startX = e.clientX;
    const startY = e.clientY;

    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      armDrag(task.id, startX, startY, false, width);
      return;
    }

    // Touch/pen: tik opent de taak, lange druk begint het slepen.
    let isTap = true;
    function cleanup() {
      window.removeEventListener('pointermove', onTapMove);
      window.removeEventListener('pointerup', onTapUp);
      window.removeEventListener('pointercancel', cleanup);
    }
    function onTapMove(ev: PointerEvent) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > TOUCH_HOLD_TOLERANCE_PX) { isTap = false; cleanup(); }
    }
    function onTapUp() {
      cleanup();
      if (isTap && !dragRef.current) onEditTask(task);
    }
    window.addEventListener('pointermove', onTapMove);
    window.addEventListener('pointerup', onTapUp);
    window.addEventListener('pointercancel', cleanup);
    startHold(startX, startY, () => { isTap = false; cleanup(); armDrag(task.id, startX, startY, true, width); });
  }

  const isDragging = drag !== null;
  useEffect(() => {
    if (!isDragging) return;
    const host = findScrollHost(rootRef.current);
    let raf = 0;

    /** Verwerkt een aanwijzerpositie: doelzone bepalen en het voorbeeld bijwerken. */
    function applyPointer(x: number, y: number) {
      const state = dragRef.current;
      if (!state) return;
      const moved = state.moved || Math.hypot(x - state.origin.x, y - state.origin.y) > MOUSE_DRAG_THRESHOLD_PX;
      const target = moved ? resolveTarget(x, y, state.taskId) : null;
      const same = moved === state.moved
        && state.pointer.x === x && state.pointer.y === y
        && sameTarget(state.target, target);
      if (same) return;
      const next: DragState = { ...state, pointer: { x, y }, moved, target };
      dragRef.current = next;
      setDrag(next);
    }

    /**
     * Meescrollen bij de randen, en daarna opnieuw kijken wat er onder de
     * aanwijzer ligt — de inhoud is immers verschoven. Dit draait zowel bij elke
     * beweging (meteen reageren) als in een lus (doorscrollen terwijl de vinger
     * stilligt tegen de rand).
     */
    function autoScroll() {
      const state = dragRef.current;
      if (!state || !state.moved) return;
      const { x, y } = state.pointer;

      // Eerst het vak onder de aanwijzer zelf — een dagkolom of de lade heeft
      // zijn eigen scroll. Daarna pas de pagina: hang je onderin het venster,
      // dan schuiven ze allebei mee en houdt de pagina het over zodra het vak
      // op is.
      let paned = false;
      const pane = scrollablePaneAt(x, y, host);
      if (pane) {
        const paneRect = pane.getBoundingClientRect();
        const paneDy = edgeScrollDelta(y, paneRect.top, paneRect.bottom, PANE_EDGE_SCROLL_ZONE_PX);
        if (paneDy) {
          const before = pane.scrollTop;
          pane.scrollTop += paneDy;
          paned = pane.scrollTop !== before;
        }
      }

      let dx = 0;
      let dy = 0;
      if (host) {
        const rect = host.getBoundingClientRect();
        dy = edgeScrollDelta(y, rect.top, rect.bottom);
        dx = edgeScrollDelta(x, rect.left, rect.right);
        if (dy) host.scrollTop += dy;
        if (dx) host.scrollLeft += dx;
      } else {
        dy = edgeScrollDelta(y, 0, window.innerHeight);
        dx = edgeScrollDelta(x, 0, window.innerWidth);
        if (dy || dx) window.scrollBy(dx, dy);
      }
      if (dy || dx || paned) applyPointer(x, y);
    }

    function step() {
      raf = requestAnimationFrame(step);
      autoScroll();
    }
    raf = requestAnimationFrame(step);

    function onMove(e: PointerEvent) {
      applyPointer(e.clientX, e.clientY);
      autoScroll();
    }

    function onUp() {
      const state = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!state) return;
      // Muisklik zonder beweging opent gewoon de taak.
      if (!state.moved) {
        const task = data.tasks.find(t => t.id === state.taskId);
        if (task) onEditTask(task);
        return;
      }
      if (state.target) void commitPlan(state.taskId, state.target);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [isDragging, commitPlan, data.tasks, onEditTask, resolveTarget]);

  // Zolang een vinger sleept mag de pagina niet meescrollen — anders schuift het
  // rooster onder je vinger vandaan.
  const blockPageScroll = drag?.touch === true && drag.moved;
  useEffect(() => {
    if (!blockPageScroll) return;
    const block = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    window.addEventListener('touchmove', block, { passive: false });
    return () => window.removeEventListener('touchmove', block);
  }, [blockPageScroll]);

  // ── Toetsenbord ───────────────────────────────────────────────────────
  function handleCardKey(e: React.KeyboardEvent, task: Task) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEditTask(task); return; }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const card = e.currentTarget as HTMLElement;
      const siblings = Array.from(card.parentElement?.querySelectorAll<HTMLElement>('[data-task-id]') ?? []);
      const index = siblings.indexOf(card);
      const next = siblings[index + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
      return;
    }

    if (!canWrite) return;
    if (e.key >= '1' && e.key <= '7') {
      e.preventDefault();
      const day = days[Number(e.key) - 1];
      void commitPlan(task.id, { type: 'day', date: formatISODate(day), beforeTaskId: null });
      return;
    }
    if (e.key === '0') {
      e.preventDefault();
      void commitPlan(task.id, { type: 'unscheduled' });
    }
  }

  /**
   * "Vandaag" zette alleen de week terug. Op een smal scherm staan de dagen
   * onder elkaar, dus je landde bovenaan bij maandag en moest alsnog scrollen
   * naar de dag waar het om ging.
   */
  function goToToday() {
    const target = startOfWeek(todayLocal);
    setAnchor(target);
    if (!isNarrow) return;
    const key = formatISODate(todayLocal);
    window.setTimeout(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-day-head="${key}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  }

  function handleRootKey(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      if (!undo) return;
      e.preventDefault();
      void runUndo();
      return;
    }
    if (e.key === 'ArrowLeft' && e.shiftKey) { e.preventDefault(); setAnchor(prev => addDays(prev, -7)); }
    else if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); setAnchor(prev => addDays(prev, 7)); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); goToToday(); }
  }

  /** Maakt een taak op een dag. `assignTo` is alleen gezet vanuit de teamweergave:
   *  daar hoort een nieuwe taak meteen bij de persoon van die rij. */
  async function quickAdd(dateKey: string, title: string, endKey?: string, assignTo?: string | null): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed || quickAddBusy) return false;
    setError(null);
    setQuickAddBusy(true);
    try {
      const created = await onQuickAddTask(dateKey, trimmed, endKey ?? null);
      if (created && assignTo) await onAssignTask(created.id, assignTo);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Taak aanmaken mislukt');
      return false;
    } finally {
      setQuickAddBusy(false);
    }
  }

  // Een half getypte taaktitel hoort niet stilletjes te verdwijnen doordat het
  // invoerveld ergens anders opnieuw opduikt: bij het wisselen van week of
  // weergave sluiten we de snelinvoer expliciet.
  useEffect(() => { setQuickAddDay(null); setTeamQuickAdd(null); }, [anchor, scope]);

  // Blader je naar een andere week, dan wijst de gekozen mobiele dag nergens
  // meer naar. Vandaag als die in beeld is, anders de maandag.
  useEffect(() => {
    setMobileDay(prev => {
      if (dayKeys.has(prev)) return prev;
      const today = formatISODate(todayLocal);
      return dayKeys.has(today) ? today : formatISODate(anchor);
    });
  }, [anchor, dayKeys, todayLocal]);

  /** Project en klant van een taak. Beide zijn optioneel: een taak die net in de
   *  weekplanner is aangemaakt heeft ze nog niet. Hangt er een project aan, dan is dat
   *  leidend voor de klant; anders telt de eigen klantkoppeling van de taak. */
  const taskLinks = (task: Task) => {
    const project = task.project_id ? projectsById.get(task.project_id) ?? null : null;
    const clientId = project?.client_id ?? task.client_id ?? null;
    const client = clientId ? clientsById.get(clientId) ?? null : null;
    return {
      projectName: project?.name ?? null,
      projectId: project?.id ?? null,
      clientName: client?.name ?? null,
      color: project?.color ?? client?.color ?? '#FFD966',
    };
  };

  /**
   * Waar komt de invoeglijn in deze zone? In de teamweergave hoort daar ook de
   * persoon bij: dezelfde dag in de rij van een collega is een ándere zone.
   * `memberKey` weglaten betekent "de gewone dagkolom".
   */
  const insertMarkerFor = (dateKey: string, memberKey?: string | null): string | null => {
    if (!drag?.moved || !drag.target || drag.target.type !== 'day') return null;
    if (drag.target.date !== dateKey) return null;
    if (memberKey !== undefined && drag.target.userId !== memberKey) return null;
    return drag.target.beforeTaskId ?? '__end__';
  };

  const taskCard = (task: Task, options: { showPlannedDate?: boolean; insertBefore?: string | null } = {}) => (
    <TaskCard
      key={task.id}
      task={task}
      {...taskLinks(task)}
      assigneeIds={assigneesByTask.get(task.id) ?? []}
      teamMembers={teamMembers}
      currentUserId={currentUserId}
      density={density}
      isDragging={drag?.taskId === task.id && drag.moved}
      isInsertTarget={options.insertBefore === task.id}
      canWrite={canWrite}
      showPlannedDate={options.showPlannedDate}
      onPointerDown={(event) => beginCardPointer(event, task)}
      onKeyDown={(event) => handleCardKey(event, task)}
      onOpen={() => onEditTask(task)}
      onSetStatus={(target, status) => { void onSetTaskStatus(target, status); }}
      onSetEstimate={(target, minutes) => { void onSetTaskEstimate(target, minutes); }}
      onOpenProject={onOpenProject}
      onMenu={openMenu}
    />
  );

  const draggedTask = drag ? data.tasks.find(t => t.id === drag.taskId) ?? null : null;

  return <div className={`week-planner density-${density}`} ref={rootRef} onKeyDown={handleRootKey}>
    {/*
      Eén kopkaart in plaats van vier losse stroken. Werkbalk, gouden
      samenvatting, vijf eigengebouwde filtervelden en een sneltoetsalinea
      kostten samen zo'n 437px voordat de eerste taakkaart in beeld kwam — op
      een laptopscherm moest je scrollen om je eigen week te zien. Dit is
      hetzelfde blok dat klanten, offertes, facturen, projecten, tickets en
      campagnes al delen; de telpil erin verklapt eindelijk dat er nog een
      filter van vorige week aanstaat.
    */}
    <SearchFilterPanel
      className="is-wide"
      ariaLabel="Weekplanner zoeken en filteren"
      header={{
        eyebrow: 'Planning',
        title: isCurrentWeek ? 'Deze week' : `Week ${isoWeekNumber(anchor)}`,
        meta: weekLabel,
        actions: <>
          <div className="wp-seg" role="group" aria-label="Wiens taken">
            <button type="button" className={scope === 'mine' ? 'is-on' : ''} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>Mijn week</button>
            <button type="button" className={scope === 'team' ? 'is-on' : ''} aria-pressed={scope === 'team'} onClick={() => setScope('team')}>Team</button>
          </div>
          <div className="wp-seg" role="group" aria-label="Hoeveel detail per kaart">
            <button type="button" className={density === 'compact' ? 'is-on' : ''} aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>Compact</button>
            <button type="button" className={density === 'comfortable' ? 'is-on' : ''} aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}>Ruim</button>
          </div>
          <div className="wp-nav" role="group" aria-label="Week kiezen">
            <button type="button" onClick={() => setAnchor(prev => addDays(prev, -7))} aria-label="Vorige week" title="Vorige week (shift + pijl links)"><ChevronLeft size={15}/></button>
            <button type="button" onClick={goToToday} title="Deze week (T)">Vandaag</button>
            <button type="button" onClick={() => setAnchor(prev => addDays(prev, 7))} aria-label="Volgende week" title="Volgende week (shift + pijl rechts)"><ChevronRight size={15}/></button>
          </div>
        </>,
      }}
      query={filters.query}
      queryPlaceholder="Zoek op taak, project, klant of tag…"
      onQueryChange={query => updateFilter('query', query)}
      visibleCount={weekTaskCount + unscheduled.length}
      totalCount={data.tasks.filter(task => task.status !== 'done').length}
      noun="taken"
      fields={[
        { key: 'clientId', label: 'Klant', value: filters.clientId, options: [{ value: '', label: 'Alle klanten' }, { value: NO_LINK, label: 'Zonder klant' }, ...data.clients.map(client => ({ value: client.id, label: client.name }))] },
        { key: 'projectId', label: 'Project', value: filters.projectId, options: [{ value: '', label: 'Alle projecten' }, { value: NO_LINK, label: 'Zonder project' }, ...projectOptions.map(project => ({ value: project.id, label: project.name }))] },
        { key: 'priority', label: 'Prioriteit', value: filters.priority, options: [{ value: 'all', label: 'Alle prioriteiten' }, { value: 'high', label: 'Hoog' }, { value: 'med', label: 'Normaal' }, { value: 'low', label: 'Laag' }] },
        { key: 'status', label: 'Status', value: filters.status, options: [{ value: 'open', label: 'Open taken' }, { value: 'todo', label: 'Te doen' }, { value: 'doing', label: 'Bezig' }, { value: 'review', label: 'Review' }, { value: 'done', label: 'Klaar' }, { value: 'all', label: 'Alle statussen' }] },
      ]}
      onFieldChange={(key, value) => updateFilter(key as keyof PlannerFilters, value as never)}
      onReset={resetFilters}
    />

    {/*
      Eén optelling, niet twee die elkaar tegenspreken. Hiervoor stond in
      dezelfde balk "Xu ingepland" (alleen taken) náást "Volst: Yu" (taken plús
      agenda), met de dagkoppen die weer die tweede definitie volgden. Nu telt
      alles bij elkaar op: taken + weekstroken + afspraken = belegd.
    */}
    <section className="wp-summary" aria-label="Deze week in uren">
      <div className="wp-summary-main">
        <span>{isCurrentWeek ? 'Deze week' : `Week ${isoWeekNumber(anchor)}`}</span>
        <strong>
          {formatDuration(weekTaskMinutes)} taken
          {weekBucket.agendaMinutes > 0 && <> + {formatDuration(weekBucket.agendaMinutes)} afspraken</>}
          {weekBucket.agendaMinutes > 0 && <> = {formatDuration(weekTaskMinutes + weekBucket.agendaMinutes)} belegd</>}
        </strong>
      </div>
      <div className="wp-summary-meta">
        <span>{weekTaskCount} {weekTaskCount === 1 ? 'taak' : 'taken'}</span>
        {busiestKey && <span>Volst: {formatDayShort(busiestKey)} · {formatDuration(busiestMinutes)}</span>}
        {weekBucket.noEstimateCount > 0 && <span className="is-soft">
          {weekBucket.noEstimateCount === 1 ? '1 taak zonder schatting' : `${weekBucket.noEstimateCount} taken zonder schatting`}
        </span>}
      </div>
    </section>

    {!canWrite && <div className="readonly-note">Je hebt alleen-lezen toegang. Taken openen kan, maar slepen en plannen is uitgeschakeld.</div>}
    {error && <div className="error">{error}</div>}

    {canWrite && overdueTasks.length > 0 && !carryOverDismissed.includes(formatISODate(anchor)) && <CarryOverPanel
      tasks={overdueTasks}
      busy={carryOverBusy}
      todayKey={todayKey}
      taskLinks={taskLinks}
      onDismiss={() => setCarryOverDismissed(prev => [...prev, formatISODate(anchor)])}
      onCarryOver={async (taskIds, toDate) => {
        setCarryOverBusy(true);
        setError(null);
        const undoSteps = captureUndo(taskIds);
        try {
          await onCarryOver(taskIds, toDate);
          offerUndo({
            label: `${taskIds.length} ${taskIds.length === 1 ? 'taak' : 'taken'} meegenomen naar ${planLabel(toDate)}`,
            steps: undoSteps,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Meenemen mislukt');
        } finally {
          setCarryOverBusy(false);
        }
      }}
    />}

    {/* Vooruitkijken in plaats van achteruit: deze lijst bestond al maar werd
        nergens als signaal gebruikt. */}
    {unplannedDeadlines.length > 0 && <div className="wp-deadline-cue" role="status">
      {unplannedDeadlines.length === 1
        ? '1 taak met een deadline deze week staat nog nergens gepland.'
        : `${unplannedDeadlines.length} taken met een deadline deze week staan nog nergens gepland.`}
    </div>}

    <div className="wp-board">
      <div className="wp-board-main">
        {/*
          Eén raster voor de hele week: dagkoppen bovenin, dan de rijen met
          weekstroken, dan de dagkolommen. De stroken krijgen een kolombereik en
          lopen daardoor dwars over de dagen heen in plaats van in een losse
          balk erboven. De stroken staan bewust vooraan in de DOM: op een smal
          scherm — waar het raster een kolom wordt — komen ze dan bovenaan.
        */}
        {isNarrow && scope === 'mine' && <div className="wp-daystrip" role="tablist" aria-label="Dag kiezen">
          {days.map(day => {
            const key = formatISODate(day);
            const bucket = byDay.get(key) ?? EMPTY_BUCKET;
            const total = bucket.minutes + bucket.agendaMinutes + bucket.spanMinutes;
            const isDropHere = drag?.moved === true && drag.target?.type === 'day' && drag.target.date === key;
            return <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === mobileDay}
              className={`wp-daystrip-day ${key === mobileDay ? 'is-on' : ''} ${isSameDay(day, todayLocal) ? 'is-today' : ''} ${isDropHere ? 'is-drop' : ''}`}
              ref={el => registerZone(`${STRIP_PREFIX}${key}`, el)}
              onClick={() => setMobileDay(key)}
            >
              <span className="wp-daystrip-name">{DAY_NAMES_NL[day.getDay() === 0 ? 6 : day.getDay() - 1]}</span>
              <span className="wp-daystrip-num">{day.getDate()}</span>
              <span className={`wp-daystrip-dot ${total > 0 ? 'is-busy' : ''}`} style={{ opacity: total > 0 ? Math.min(1, 0.35 + total / loadScale) : 0 }}/>
            </button>;
          })}
        </div>}

        <div
          className="wp-week"
          ref={bandRef}
          style={{ gridTemplateRows: `auto${laneCount > 0 ? ` repeat(${laneCount}, 26px)` : ''}${scope === 'mine' ? ' minmax(0, 1fr)' : ''}` }}
        >
          {bars.map(bar => {
            const links = taskLinks(bar.task);
            const dragging = barDrag?.taskId === bar.task.id && barDrag.moved;
            const draggable = canWrite && !isNarrow;
            return <div
              key={bar.task.id}
              className={`wp-bar ${dragging ? 'is-dragging' : ''} ${bar.continuesLeft ? 'continues-left' : ''} ${bar.continuesRight ? 'continues-right' : ''} ${draggable ? '' : 'is-static'}`}
              style={{ '--bar': links.color, gridColumn: `${bar.startIdx + 1} / span ${bar.span}`, gridRow: bar.lane + 2 } as React.CSSProperties}
              data-bar-id={bar.task.id}
              tabIndex={0}
              role="button"
              aria-label={`${bar.task.title}, van ${formatDateShort(bar.task.planned_date!)} tot en met ${formatDateShort(bar.task.planned_end_date!)}`}
              onPointerDown={draggable ? (e => beginBarPointer(e, bar, 'move')) : undefined}
              onKeyDown={e => handleBarKey(e, bar)}
              onClick={draggable ? undefined : () => onEditTask(bar.task)}
            >
              {draggable && !bar.continuesLeft && <span
                className="wp-bar-grip wp-bar-grip-start"
                onPointerDown={e => beginBarPointer(e, bar, 'resize-start')}
                title="Sleep om eerder te laten beginnen"
              />}
              <span className="wp-bar-title">{bar.task.title}</span>
              {links.projectName && <span className="wp-bar-project">{links.projectName}</span>}
              <span className="wp-bar-span">{isNarrow ? barDateLabel(bar) : barSpanLabel(bar)}</span>
              {draggable && !bar.continuesRight && <span
                className="wp-bar-grip wp-bar-grip-end"
                onPointerDown={e => beginBarPointer(e, bar, 'resize-end')}
                title="Sleep om later te laten eindigen"
              />}
            </div>;
          })}

          {days.map((day, i) => {
            const key = formatISODate(day);
            // Op een telefoon zeven blokken onder elkaar zetten betekent scrollen
            // langs zes dagen die je niet zocht, met de lade helemaal onderaan.
            // Daar tonen we één dag; de strook erboven is de weg naar de rest —
            // én een dropzone, dus slepen naar een andere dag kan er nog steeds.
            if (isNarrow && key !== mobileDay) return null;
            const bucket = byDay.get(key) ?? EMPTY_BUCKET;
            const agenda = agendaByDay.get(key);
            const isToday = isSameDay(day, todayLocal);
            const marker = scope === 'mine' ? insertMarkerFor(key) : null;
            const total = bucket.minutes + bucket.agendaMinutes + bucket.spanMinutes;
            const scale = loadScale;
            // Geen aparte markering meer voor de volste dag: die deelde zijn
            // specificiteit met `is-today` en won, waardoor "vandaag" verdween
            // zodra vandaag óók je drukste dag was. De balk zegt het al.
            const state = `${isToday ? 'is-today ' : ''}${marker !== null ? 'is-drop' : ''}`;
            return <Fragment key={key}>
              {/* Het kolomvlak geeft de dag zijn kaartvorm en loopt van de kop
                  tot onder de kolom door, zodat een strook er dwars overheen valt. */}
              <div className={`wp-col ${state}`} style={{ gridColumn: i + 1, gridRow: '1 / -1' }} aria-hidden="true"/>

              <div className={`wp-day-head ${state}`} data-day-head={key} style={{ gridColumn: i + 1, gridRow: 1 }}>
                <div className="wp-day-row">
                  <span className="wp-day-name">{DAY_NAMES_NL[i]}</span>
                  <span className="wp-day-num">{day.getDate()}</span>
                  {/* Aantal én uren: acht taken zonder schatting leest anders als
                      een lege dag, want dan staat de urenteller op nul. */}
                  {bucket.count > 0 && <span className="wp-day-count">{bucket.count}</span>}
                  {/* De ± staat er zodra een weekstrook meetelt: dat deel is een
                      verdeling over zijn dagen, geen gemeten tijd. */}
                  {total > 0 && <span className="wp-day-total">{bucket.spanMinutes > 0 ? '±' : ''}{formatDuration(total)}</span>}
                  {/* Alleen in "Mijn week": in de teamweergave hoort een nieuwe
                      taak bij een persoon, en die staat in de rij eronder — niet
                      hier. Deze knop stond er wél en deed daar niets. */}
                  {canWrite && scope === 'mine' && <button
                    type="button"
                    className="wp-day-add"
                    onClick={() => setQuickAddDay(prev => prev === key ? null : key)}
                    aria-expanded={quickAddDay === key}
                    aria-label={`Taak toevoegen op ${DAY_NAMES_NL[i]} ${day.getDate()}`}
                    title={`Taak toevoegen op ${DAY_NAMES_NL[i]} ${day.getDate()}`}
                  >
                    <Plus size={13}/>
                  </button>}
                </div>
                {/* Eerst je afspraken, dan je taken; de rest van de balk is vrij. */}
                <div
                  className="wp-day-load"
                  role="img"
                  aria-label={`${formatDuration(bucket.agendaMinutes)} afspraken en ${formatDuration(bucket.minutes + bucket.spanMinutes)} taken`}
                >
                  <span className="wp-day-load-agenda" style={{ width: `${(bucket.agendaMinutes / scale) * 100}%` }}/>
                  <span className="wp-day-load-fill" style={{ width: `${((bucket.minutes + bucket.spanMinutes) / scale) * 100}%` }}/>
                </div>
                {/* Hele-dag-afspraken kosten geen minuten maar maken je dag wél
                    vol. Ze verdwenen hier volledig, dus een shootdag las als een
                    lege dag. */}
                {!!agenda?.allDay.length && <div className="wp-day-allday">
                  {agenda.allDay.map(event => <span key={`${event.source_id}-${event.provider_event_id}`} className="wp-allday-chip" title={event.title}>
                    {event.title}
                  </span>)}
                </div>}
              </div>

              {scope === 'mine' && <div
                className={`wp-day-body ${state}`}
                style={{ gridColumn: i + 1, gridRow: laneCount + 2 }}
                ref={el => registerZone(key, el)}
              >
                {/* Twee eigen vakken onder elkaar: bovenin wat vastligt (de
                    agenda), daaronder wat je kunt schuiven (de taken). Elk vak
                    scrollt apart, zodat een volle agenda de taken niet wegduwt
                    en een lange takenlijst de afspraken niet uit beeld drukt. */}
                {!!agenda?.items.length && <div
                  className="wp-day-pane wp-day-agenda"
                  role="group"
                  aria-label={`Afspraken op ${DAY_NAMES_NL[i]} ${day.getDate()}`}
                >
                  {/* Was een dode <div> met alleen een `title`; nu een deur naar
                      de agenda op precies deze dag. */}
                  {agenda.items.map(event => <button
                    key={`${event.source_id}-${event.provider_event_id}-${event.starts_at}`}
                    type="button"
                    className="wp-agenda-chip"
                    title={`${event.title} — open in de agenda`}
                    onClick={() => onOpenCalendar(key)}
                  >
                    <span className="wp-agenda-time">{formatEventTime(event.starts_at)}</span>
                    <span className="wp-agenda-name">{event.title}</span>
                  </button>)}
                </div>}
                {/* Het invoerveld blijft bewust búiten het scrollvak staan: het
                    hoort bij de dag, niet bij een plek in de lijst. */}
                {quickAddDay === key && <QuickAddTask
                  busy={quickAddBusy}
                  weekHint={`van ${formatDateShort(key)} tot en met ${formatDateShort(weekStripEnd(key, orderedDayKeys[6]))}`}
                  onSubmit={(title, mode) => quickAdd(key, title, mode === 'week' ? weekStripEnd(key, orderedDayKeys[6]) : undefined)}
                  onCancel={() => setQuickAddDay(null)}
                />}
                {/* Een lege dag krijgt geen tekst en geen stippellijn meer: zeven
                    keer "Sleep een taak hierheen" is ruis, en tijdens het slepen
                    laat `.wp-col.is-drop` de dropzone al zien. In alleen-lezen
                    stond die uitnodiging er zelfs terwijl slepen uit staat. */}
                <DayTasksPane
                  label={`Taken op ${DAY_NAMES_NL[i]} ${day.getDate()}`}
                  count={bucket.tasks.length}
                >
                  {bucket.tasks.map(task => taskCard(task, { insertBefore: marker }))}
                  {marker === '__end__' && <div className="wp-insert-line" aria-hidden="true"/>}
                </DayTasksPane>
                {bucket.noEstimateCount > 0 && <div className="wp-day-noestimate">
                  {bucket.noEstimateCount === 1 ? '1 taak zonder schatting' : `${bucket.noEstimateCount} taken zonder schatting`}
                </div>}
              </div>}
            </Fragment>;
          })}
        </div>

        {scope === 'team' && <div className="wp-team">
          {teamRows.map(row => <div className="wp-team-row" key={row.key}>
            <div className="wp-team-head">
              <span className="wp-team-avatar" style={{ background: row.color }}>{row.initials}</span>
              <span className="wp-team-name">{row.name}</span>
              <span className="wp-team-count">{row.total} {row.total === 1 ? 'taak' : 'taken'}</span>
            </div>
            <div className="wp-grid">
              {days.map(day => {
                const key = formatISODate(day);
                const zoneKey = `${row.key}${ZONE_SEP}${key}`;
                const cards = row.byDay.get(key) ?? [];
                const marker = insertMarkerFor(key, row.key === NO_MEMBER ? null : row.key);
                const isAdding = teamQuickAdd?.rowKey === row.key && teamQuickAdd.dateKey === key;
                return <div
                  key={key}
                  className={`wp-team-cell ${marker !== null ? 'is-drop' : ''}`}
                  ref={el => registerZone(zoneKey, el)}
                >
                  {cards.map(task => taskCard(task, { insertBefore: marker }))}
                  {marker === '__end__' && <div className="wp-insert-line" aria-hidden="true"/>}
                  {isAdding && <QuickAddTask
                    busy={quickAddBusy}
                    weekHint={`van ${formatDateShort(key)} tot en met ${formatDateShort(weekStripEnd(key, orderedDayKeys[6]))}`}
                    onSubmit={(title, mode) => quickAdd(
                      key,
                      title,
                      mode === 'week' ? weekStripEnd(key, orderedDayKeys[6]) : undefined,
                      row.key === NO_MEMBER ? null : row.key,
                    )}
                    onCancel={() => setTeamQuickAdd(null)}
                  />}
                  {/* Hier wél een plusje: deze cel weet wélke dag én wie. */}
                  {canWrite && !isAdding && <button
                    type="button"
                    className="wp-team-add"
                    aria-label={`Taak toevoegen voor ${row.name} op ${formatDayShort(key)}`}
                    title={`Taak toevoegen voor ${row.name}`}
                    onClick={() => setTeamQuickAdd({ rowKey: row.key, dateKey: key })}
                  ><Plus size={12}/></button>}
                  {cards.length === 0 && !isAdding && <div className="wp-team-empty" aria-hidden="true"/>}
                </div>;
              })}
            </div>
          </div>)}
          {teamRows.length === 0 && <div className="wp-day-empty">Geen taken van het team in deze week binnen deze filterselectie</div>}
        </div>}
      </div>

      <PlannerTray
        unscheduled={unscheduled}
        outsideThisWeek={outsideThisWeek}
        deadlineThisWeek={deadlineThisWeek}
        renderTask={taskCard}
        isDropTarget={drag?.moved === true && drag.target?.type === 'unscheduled'}
        forceTray={drag?.moved === true}
        trayRef={el => registerZone(TRAY_KEY, el)}
        notes={weekNotes}
        weekStart={formatISODate(anchor)}
        canWrite={canWrite}
        hasFilters={hasActiveFilters}
        onAddNote={onAddNote}
        onToggleNote={onToggleNote}
        onRemoveNote={onRemoveNote}
      />
    </div>

    {/* Een sleep die landt zegt nu wát er gebeurde, en biedt de weg terug.
        `role="status"` zodat een schermlezer het ook meekrijgt. */}
    {menu && (() => {
      const task = data.tasks.find(row => row.id === menu.taskId);
      if (!task) return null;
      const assigned = assigneesByTask.get(task.id) ?? [];
      const move = (date: string | null) => {
        setMenu(null);
        void commitPlan(task.id, date === null ? { type: 'unscheduled' } : { type: 'day', date, beforeTaskId: null });
      };
      return <div
        className="wp-menu"
        role="menu"
        style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 330) }}
        onPointerDown={e => e.stopPropagation()}
      >
        <div className="wp-menu-head">{task.title}</div>
        <div className="wp-menu-group">
          {(['doing', 'review', 'done'] as TaskStatus[]).map(status => <button
            key={status}
            type="button"
            role="menuitem"
            disabled={task.status === status}
            onClick={() => { setMenu(null); void onSetTaskStatus(task, status); }}
          >{statusLabel(status)}</button>)}
        </div>
        <div className="wp-menu-group">
          <button type="button" role="menuitem" onClick={() => move(shiftDateKey(todayKey, 1))}>Naar morgen</button>
          <button type="button" role="menuitem" onClick={() => move(shiftDateKey(task.planned_date ?? todayKey, 7))}>Naar volgende week</button>
          {/* Een weekstrook kon langs geen enkele weg naar de lade: het
              toetsenbord kent daar geen '0' en slepen kan alleen binnen de band. */}
          <button type="button" role="menuitem" onClick={() => move(null)}>Naar de lade</button>
        </div>
        {teamMembers.length > 0 && <div className="wp-menu-group">
          <div className="wp-menu-label">Toewijzen aan</div>
          {teamMembers.slice(0, 6).map(member => <button
            key={member.user_id}
            type="button"
            role="menuitem"
            className={assigned.includes(member.user_id) ? 'is-on' : ''}
            onClick={() => { setMenu(null); void onAssignTask(task.id, member.user_id, 'add'); }}
          >{memberShortName(member.user_id, teamMembers, currentUserId)}</button>)}
        </div>}
        <div className="wp-menu-group">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); onEditTask(task); }}>Open taak…</button>
        </div>
      </div>;
    })()}

    {undo && <div className="wp-undo" role="status">
      <span className="wp-undo-text">{undo.label}</span>
      <button type="button" className="wp-undo-btn" disabled={undoBusy} onClick={() => void runUndo()}>
        {undoBusy ? 'Bezig…' : 'Ongedaan maken'}
      </button>
      <button type="button" className="wp-undo-close" aria-label="Melding sluiten" onClick={() => setUndo(null)}><X size={12}/></button>
    </div>}

    {assignChoice && <div
      className="wp-assign-choice"
      role="dialog"
      aria-label="Toewijzing van deze taak"
      style={assignChoice.point ? { left: assignChoice.point.x, top: assignChoice.point.y } : undefined}
    >
      <span className="wp-assign-text">
        Deze taak staat op meerdere mensen. {memberShortName(assignChoice.userId, teamMembers, currentUserId)} …
      </span>
      <button type="button" onClick={() => void resolveAssignChoice('replace')}>alleen {memberShortName(assignChoice.userId, teamMembers, currentUserId)}</button>
      <button type="button" onClick={() => void resolveAssignChoice('add')}>erbij</button>
      <button type="button" className="is-ghost" onClick={() => void resolveAssignChoice('cancel')}>annuleren</button>
    </div>}

    {drag?.moved && draggedTask && <div
      className="wp-ghost"
      style={{ left: drag.pointer.x, top: drag.pointer.y, width: drag.width }}
      aria-hidden="true"
    >
      <span className="wp-ghost-dot" style={{ background: taskLinks(draggedTask).color }}/>
      <span className="wp-ghost-title">{draggedTask.title}</span>
    </div>}
  </div>;
}

/**
 * Het meeneem-voorstel voor blijven liggen werk. Was één knop die twintig taken
 * ineens verzette naar vandaag, zonder weg terug — een onomkeerbare herindeling
 * van je week met één klik. Nu kies je wát er meegaat en naar wélke dag, en zie
 * je de uitkomst in de knop staan voordat je hem indrukt.
 */
function CarryOverPanel({ tasks, busy, todayKey, taskLinks, onCarryOver, onDismiss }: {
  tasks: Task[];
  busy: boolean;
  todayKey: string;
  taskLinks: (task: Task) => { projectName: string | null };
  onCarryOver: (taskIds: UUID[], toDate: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Standaard staat alles aan: dat is bijna altijd wat je wilt, en uitvinken is
  // sneller dan twintig keer aanvinken.
  const [skipped, setSkipped] = useState<UUID[]>([]);
  const [target, setTarget] = useState<'today' | 'tomorrow' | 'monday'>('today');

  const chosen = tasks.filter(task => !skipped.includes(task.id));
  const minutes = chosen.reduce((sum, task) => sum + taskEstimateMinutes(task), 0);

  const targets: { key: typeof target; label: string; date: string }[] = [
    { key: 'today', label: 'vandaag', date: todayKey },
    { key: 'tomorrow', label: 'morgen', date: shiftDateKey(todayKey, 1) },
    { key: 'monday', label: 'maandag', date: nextMondayKey(todayKey) },
  ];
  const targetDate = targets.find(t => t.key === target)!;

  return <div className={`wp-rollover ${open ? 'is-open' : ''}`}>
    <div className="wp-rollover-row">
      <strong>{tasks.length === 1 ? '1 taak' : `${tasks.length} taken`} van eerder staan nog open.</strong>
      <button type="button" className="wp-rollover-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {open ? 'Verberg lijst' : 'Bekijk en kies'}
      </button>
      <span className="wp-rollover-grow"/>
      <div className="wp-rollover-targets" role="group" aria-label="Naar welke dag">
        {targets.map(option => <button
          key={option.key}
          type="button"
          className={target === option.key ? 'is-on' : ''}
          aria-pressed={target === option.key}
          onClick={() => setTarget(option.key)}
        >{option.label}</button>)}
      </div>
      <button
        type="button"
        className="wp-rollover-btn"
        disabled={busy || chosen.length === 0}
        onClick={() => void onCarryOver(chosen.map(task => task.id), targetDate.date)}
      >
        {busy
          ? 'Bezig…'
          : `Neem ${chosen.length} ${chosen.length === 1 ? 'taak' : 'taken'} mee naar ${targetDate.label}${minutes > 0 ? ` (${formatDuration(minutes)})` : ''}`}
      </button>
      <button type="button" className="wp-rollover-btn is-ghost" onClick={onDismiss}>Laat staan</button>
    </div>

    {open && <ul className="wp-rollover-list">
      {tasks.map(task => {
        const checked = !skipped.includes(task.id);
        return <li key={task.id}>
          <label>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => setSkipped(prev => checked ? [...prev, task.id] : prev.filter(id => id !== task.id))}
            />
            <span className="wp-rollover-title">{task.title}</span>
            <span className="wp-rollover-meta">
              {taskLinks(task).projectName ?? 'Losse taak'}
              {' · '}
              {planLabel(task.planned_date)}
              {hasEstimate(task) ? ` · ${formatDuration(taskEstimateMinutes(task))}` : ''}
            </span>
          </label>
        </li>;
      })}
    </ul>}
  </div>;
}

/** De eerstvolgende maandag ná deze dag. Voor de vrijdagmiddagvraag. */
function nextMondayKey(fromKey: string): string {
  const date = parseISODate(fromKey);
  const day = date.getDay(); // 0 = zondag
  const ahead = day === 1 ? 7 : (8 - (day === 0 ? 7 : day)) % 7 || 7;
  return shiftDateKey(fromKey, ahead);
}

/**
 * Het scrollvak met de taken van één dag, plus een voet die zegt hoeveel er nog
 * onder staan. Zonder die voet zie je bij vijftien taken er zeven en verklapt
 * niets dat er meer is — op een Mac verschijnt de scrollbalk pas als je al
 * scrolt. Het tellen gebeurt in een observer, niet in de renderlus.
 */
function DayTasksPane({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState(0);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    function measure() {
      const el = paneRef.current;
      if (!el) return;
      const cards = Array.from(el.querySelectorAll<HTMLElement>('[data-task-id]'));
      const cutoff = el.scrollTop + el.clientHeight;
      // Een kaart telt pas als "onder de vouw" wanneer hij er echt helemaal
      // buiten valt; half zichtbaar zie je nog.
      setHidden(cards.filter(card => card.offsetTop >= cutoff - 2).length);
    }

    measure();
    pane.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => {
      pane.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [count]);

  return <>
    <div className="wp-day-pane wp-day-tasks" role="group" aria-label={label} ref={paneRef}>
      {children}
    </div>
    {hidden > 0 && <div className="wp-day-more" aria-hidden="true">nog {hidden} ↓</div>}
  </>;
}

/** Snelkeuzes van de tijdpil. Zes stappen dekken vrijwel elke plannerbeslissing;
 *  wat er niet bij staat typ je in het vrije veld ernaast. */
const ESTIMATE_PRESETS: { label: string; minutes: number }[] = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1u', minutes: 60 },
  { label: '2u', minutes: 120 },
  { label: '4u', minutes: 240 },
  { label: 'Hele dag', minutes: 480 },
];

/**
 * De kaart in de planner. Drie zones: links het vinkje, in het midden het sleep-
 * en openvlak, rechts de tijdpil. Bewust `role="group"` en niet `role="button"`:
 * een knop in een knop bestaat niet in HTML, en een schermlezer sloeg de
 * binnenste knoppen daardoor over.
 */
function TaskCard({
  task,
  projectName,
  projectId,
  clientName,
  color,
  assigneeIds,
  teamMembers,
  currentUserId,
  density,
  isDragging,
  isInsertTarget,
  canWrite,
  showPlannedDate,
  onPointerDown,
  onKeyDown,
  onOpen,
  onSetStatus,
  onSetEstimate,
  onOpenProject,
  onMenu,
}: {
  task: Task;
  projectName: string | null;
  projectId: string | null;
  clientName: string | null;
  color: string;
  assigneeIds: string[];
  teamMembers: OrganizationMember[];
  currentUserId: string | null;
  density: Density;
  isDragging: boolean;
  isInsertTarget: boolean;
  canWrite: boolean;
  showPlannedDate?: boolean;
  onPointerDown: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onOpen: () => void;
  onSetStatus: (task: Task, status: TaskStatus) => void;
  onSetEstimate: (task: Task, minutes: number | null) => void;
  onOpenProject: (projectId: string) => void;
  onMenu: (task: Task, x: number, y: number) => void;
}) {
  const plannedAfterDeadline = !!task.end_date && !!task.planned_date && task.planned_date > task.end_date;
  const done = task.status === 'done';
  const [estimateOpen, setEstimateOpen] = useState(false);
  const [freeInput, setFreeInput] = useState('');

  const subtaskTotal = task.subtasks?.length ?? 0;
  const subtaskDone = task.subtasks?.filter(s => s.done).length ?? 0;
  const commentCount = task.comments?.length ?? 0;

  /** Een klik op een bedieningselement mag geen sleepgebaar starten. */
  const swallow = (event: React.PointerEvent) => event.stopPropagation();

  function commitFree() {
    const raw = freeInput.trim();
    if (!raw) return;
    const minutes = parseDurationInput(raw);
    if (minutes === null) return;
    onSetEstimate(task, minutes);
    setFreeInput('');
    setEstimateOpen(false);
  }

  return <article
    className={`wp-task ${isDragging ? 'is-dragging' : ''} ${isInsertTarget ? 'is-insert-target' : ''} ${done ? 'is-done' : ''}`}
    data-task-id={task.id}
    tabIndex={0}
    role="group"
    aria-label={`${task.title}${projectName ? `, project ${projectName}` : ''}${done ? ', klaar' : ''}`}
    onPointerDown={onPointerDown}
    onKeyDown={event => {
      // Shift+F10 is de toetsenbordweg naar een contextmenu.
      if (event.shiftKey && event.key === 'F10') {
        event.preventDefault();
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        onMenu(task, rect.left + 24, rect.bottom - 4);
        return;
      }
      onKeyDown(event);
    }}
    onContextMenu={event => {
      if (!canWrite) return;
      event.preventDefault();
      onMenu(task, event.clientX, event.clientY);
    }}
  >
    <button
      type="button"
      className="wp-task-check"
      aria-pressed={done}
      aria-label={done ? `${task.title} weer openzetten` : `${task.title} afvinken`}
      disabled={!canWrite}
      onPointerDown={swallow}
      onClick={() => onSetStatus(task, done ? 'todo' : 'done')}
    >
      {done && <Check size={12} aria-hidden="true"/>}
    </button>

    <span className="wp-task-dot" style={{ background: color }}/>

    <div className="wp-task-body">
      {/* De titel is de knop die de taak opent — niet de hele kaart. */}
      <button type="button" className="wp-task-title" onPointerDown={swallow} onClick={onOpen}>{task.title}</button>
      <div className="wp-task-sub">
        {projectName && projectId
          ? <button
              type="button"
              className="wp-task-project-link"
              onPointerDown={swallow}
              onClick={() => onOpenProject(projectId)}
              title={`Open project ${projectName}`}
            >{projectName}</button>
          : <span className="is-unlinked">Geen project</span>}
        {clientName && <span className="wp-task-client">{clientName}</span>}
      </div>
      {density === 'comfortable' && <div className="wp-task-meta">
        <span className={`pri-badge pri-${task.priority}`}>{priorityLabel(task.priority)}</span>
        {/* Status is nu een knop: één klik schuift hem door de cyclus. */}
        <button
          type="button"
          className={`wp-task-status status-${task.status}`}
          disabled={!canWrite}
          onPointerDown={swallow}
          onClick={() => onSetStatus(task, nextStatus(task.status))}
          title={canWrite ? `Nu ${statusLabel(task.status).toLowerCase()} — klik voor ${statusLabel(nextStatus(task.status)).toLowerCase()}` : undefined}
        >{statusLabel(task.status)}</button>
        {/* Tellers alleen tonen als er echt iets te tellen valt. */}
        {subtaskTotal > 0 && <span className="wp-task-counts"><CheckSquare size={10} aria-hidden="true"/> {subtaskDone}/{subtaskTotal}</span>}
        {commentCount > 0 && <span className="wp-task-counts"><MessageSquare size={10} aria-hidden="true"/> {commentCount}</span>}
      </div>}
      {(plannedAfterDeadline || showPlannedDate || density === 'comfortable') && <div className="wp-task-planning-meta">
        {plannedAfterDeadline && <span className="wp-flag-clash">Gepland ná deadline {formatDateShort(task.end_date!)}</span>}
        {density === 'comfortable' && task.end_date && !plannedAfterDeadline && <span>Deadline {formatDateShort(task.end_date)}</span>}
        {showPlannedDate && task.planned_date && <span>Gepland {formatDateShort(task.planned_date)}</span>}
        {density === 'comfortable' && <AssigneeAvatars userIds={assigneeIds} teamMembers={teamMembers} currentUserId={currentUserId} max={4} />}
      </div>}
    </div>

    <button
      type="button"
      className={`wp-task-est ${hasEstimate(task) ? '' : 'is-unset'}`}
      disabled={!canWrite}
      aria-expanded={estimateOpen}
      aria-label={hasEstimate(task) ? `Tijdschatting ${formatDuration(taskEstimateMinutes(task))}, klik om te wijzigen` : 'Nog geen tijdschatting, klik om in te vullen'}
      onPointerDown={swallow}
      onClick={() => setEstimateOpen(open => !open)}
    >
      {hasEstimate(task) ? formatDuration(taskEstimateMinutes(task)) : '—'}
    </button>

    {/* Op touch is de rechtermuisknop er niet en is lang indrukken al bezet
        door het slepen; daarom een eigen knopje. */}
    {canWrite && <button
      type="button"
      className="wp-task-more"
      aria-label={`Meer handelingen voor ${task.title}`}
      onPointerDown={swallow}
      onClick={event => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        onMenu(task, rect.left, rect.bottom + 2);
      }}
    >⋯</button>}

    {estimateOpen && canWrite && <div className="wp-est-pop" onPointerDown={swallow}>
      <div className="wp-est-presets">
        {ESTIMATE_PRESETS.map(preset => <button
          key={preset.minutes}
          type="button"
          className={taskEstimateMinutes(task) === preset.minutes && hasEstimate(task) ? 'is-on' : ''}
          onClick={() => { onSetEstimate(task, preset.minutes); setEstimateOpen(false); }}
        >{preset.label}</button>)}
      </div>
      <div className="wp-est-free">
        <input
          className="wp-est-input"
          value={freeInput}
          placeholder="bijv. 90m of 1u30"
          aria-label="Eigen tijdschatting"
          autoFocus
          onChange={e => setFreeInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitFree(); }
            if (e.key === 'Escape') { e.preventDefault(); setEstimateOpen(false); }
          }}
        />
        {hasEstimate(task) && <button
          type="button"
          className="wp-est-clear"
          onClick={() => { onSetEstimate(task, null); setEstimateOpen(false); }}
        >Wissen</button>}
      </div>
    </div>}
  </article>;
}

/**
 * Snelinvoer in een dagkolom: titel typen, Enter, en de taak staat er. Je kiest
 * er zelf bij of het werk van één dag is of over meerdere dagen loopt.
 * Bewust zonder project of klant — die koppel je daarna door de kaart te openen.
 */
function QuickAddTask({ busy, onSubmit, onCancel, weekHint }: {
  busy: boolean;
  onSubmit: (title: string, mode: QuickAddMode) => Promise<boolean>;
  onCancel: () => void;
  /** Wat een weekstrook vanaf déze dag gaat beslaan, in gewone taal. */
  weekHint: string;
}) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<QuickAddMode>('day');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus bij openen én opnieuw zodra het opslaan klaar is: tijdens het opslaan staat
  // het veld op `disabled`, wat de focus wegneemt. Pas ná de her-render kan hij terug.
  useEffect(() => { if (!busy) inputRef.current?.focus(); }, [busy]);

  async function submit() {
    // Veld leegmaken zodat je meteen de volgende taak kunt typen.
    if (await onSubmit(title, mode)) setTitle('');
  }

  /** De keuzeknoppen mogen de focus niet uit het invoerveld halen: dat veld
   *  sluit zichzelf bij een leeg blur, en dan zou de keuze de invoer wegklappen. */
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  return <div className="wp-quick-add">
    <div className="wp-quick-add-modes" role="group" aria-label="Wat voeg je toe?">
      <button
        type="button"
        className={mode === 'day' ? 'is-on' : ''}
        aria-pressed={mode === 'day'}
        onMouseDown={keepFocus}
        onClick={() => setMode('day')}
      >
        Dagtaak
      </button>
      <button
        type="button"
        className={mode === 'week' ? 'is-on' : ''}
        aria-pressed={mode === 'week'}
        onMouseDown={keepFocus}
        onClick={() => setMode('week')}
      >
        Weekstrook
      </button>
    </div>
    <input
      ref={inputRef}
      className="wp-quick-add-input"
      value={title}
      disabled={busy}
      placeholder={mode === 'week' ? 'Waar werk je aan…' : 'Taaktitel…'}
      aria-label={mode === 'week' ? 'Nieuwe weekstrook vanaf deze dag' : 'Nieuwe taak op deze dag'}
      onChange={e => setTitle(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={() => { if (!title.trim()) onCancel(); }}
    />
    <div className="wp-quick-add-hint">
      {mode === 'week'
        ? `Enter maakt een strook ${weekHint}. De randen versleep je daarna.`
        : 'Enter voegt toe · Esc sluit. Project en klant koppel je daarna in de taak.'}
    </div>
  </div>;
}

/**
 * De lade rechts: alles wat nog een plek zoekt, plus je actiepunten. Vervangt de
 * drie panelen die eerst onder het raster stonden, elk met hun eigen scrollbalk.
 */
function PlannerTray({
  unscheduled, outsideThisWeek, deadlineThisWeek, renderTask, isDropTarget, forceTray, trayRef,
  notes, weekStart, canWrite, hasFilters, onAddNote, onToggleNote, onRemoveNote,
}: {
  unscheduled: Task[];
  outsideThisWeek: Task[];
  deadlineThisWeek: Task[];
  renderTask: (task: Task, options?: { showPlannedDate?: boolean; insertBefore?: string | null }) => React.ReactNode;
  isDropTarget: boolean;
  forceTray: boolean;
  trayRef: (el: HTMLDivElement | null) => void;
  notes: PlannerNote[];
  weekStart: string;
  canWrite: boolean;
  /** Staat er een filter aan? Dan is "niets gevonden" iets anders dan "niets te doen". */
  hasFilters: boolean;
  onAddNote: (weekStart: string, text: string) => Promise<void>;
  onToggleNote: (id: UUID, done: boolean) => Promise<void>;
  onRemoveNote: (id: UUID) => Promise<void>;
}) {
  const [tab, setTab] = useState<'tray' | 'deadline' | 'outside'>('tray');
  // Tijdens het slepen altijd de lade tonen: daar kun je iets in loslaten.
  const active = forceTray ? 'tray' : tab;

  return <aside className={`wp-tray ${isDropTarget ? 'is-drop' : ''}`}>
    <div className="wp-tray-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={active === 'tray'} className={active === 'tray' ? 'is-on' : ''} onClick={() => setTab('tray')}>
        Lade {unscheduled.length}
      </button>
      <button type="button" role="tab" aria-selected={active === 'deadline'} className={active === 'deadline' ? 'is-on' : ''} onClick={() => setTab('deadline')}>
        Deadline {deadlineThisWeek.length}
      </button>
      <button type="button" role="tab" aria-selected={active === 'outside'} className={active === 'outside' ? 'is-on' : ''} onClick={() => setTab('outside')}>
        Buiten week {outsideThisWeek.length}
      </button>
    </div>

    {/* De lade is de dropzone, dus die blijft altijd gemonteerd. */}
    <div className="wp-tray-body" ref={trayRef} hidden={active !== 'tray'}>
      {/* In alleen-lezen kan er niets gesleept worden; dan is deze uitnodiging
          een belofte die het scherm niet waarmaakt. */}
      {canWrite && <p className="wp-tray-hint">Sleep hierheen om een taak van de kalender te halen, of van hier naar een dag.</p>}
      {unscheduled.map(task => renderTask(task))}
      {unscheduled.length === 0 && <div className="wp-day-empty">
        {hasFilters ? 'Geen taken zonder planning binnen dit filter' : 'Niets zonder planning — alles staat op een dag.'}
      </div>}
    </div>

    {active === 'deadline' && <div className="wp-tray-body">
      <p className="wp-tray-hint">Open taken met een deadline in deze week, ongeacht wanneer ze gepland staan.</p>
      {deadlineThisWeek.map(task => renderTask(task, { showPlannedDate: true }))}
      {deadlineThisWeek.length === 0 && <div className="wp-day-empty">Geen deadlines deze week binnen deze filterselectie</div>}
    </div>}

    {active === 'outside' && <div className="wp-tray-body">
      <p className="wp-tray-hint">Deze taken hebben wel een plandatum, maar vallen buiten de huidige week.</p>
      {outsideThisWeek.map(task => renderTask(task, { showPlannedDate: true }))}
      {outsideThisWeek.length === 0 && <div className="wp-day-empty">Geen geplande taken buiten deze week binnen deze filterselectie</div>}
    </div>}

    <PlannerNotes
      notes={notes}
      weekStart={weekStart}
      canWrite={canWrite}
      onAdd={onAddNote}
      onToggle={onToggleNote}
      onRemove={onRemoveNote}
    />
  </aside>;
}

/** Leest een oude, in de browser bewaarde actiepuntenlijst van vóór de database. */
function readLegacyChecklist(weekKey: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(`resofly-checklist-${weekKey}`) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(item => String(item?.text ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Actiepunten van de week: snel iets noteren zonder aan project, duur of dag te
 * denken. Persoonlijk en in de database, dus ook op je telefoon en in de back-up.
 */
function PlannerNotes({ notes, weekStart, canWrite, onAdd, onToggle, onRemove }: {
  notes: PlannerNote[];
  weekStart: string;
  canWrite: boolean;
  onAdd: (weekStart: string, text: string) => Promise<void>;
  onToggle: (id: UUID, done: boolean) => Promise<void>;
  onRemove: (id: UUID) => Promise<void>;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [legacy, setLegacy] = useState<string[]>([]);

  // Nog iets in de browser van vóór de verhuizing? Eén keer aanbieden.
  useEffect(() => {
    setLegacy(notes.length === 0 ? readLegacyChecklist(weekStart) : []);
  }, [notes.length, weekStart]);

  async function add() {
    const text = input.trim();
    if (!text || busy || !canWrite) return;
    setBusy(true);
    try { await onAdd(weekStart, text); setInput(''); }
    finally { setBusy(false); }
  }

  async function importLegacy() {
    setBusy(true);
    try {
      for (const text of legacy) await onAdd(weekStart, text);
      localStorage.removeItem(`resofly-checklist-${weekStart}`);
      setLegacy([]);
    } finally {
      setBusy(false);
    }
  }

  const open = notes.filter(note => !note.done);
  const done = notes.filter(note => note.done);

  return <section className="wp-notes">
    <div className="wp-notes-head">
      <span>Actiepunten deze week</span>
      {notes.length > 0 && <span className="wp-notes-count">{open.length} open</span>}
    </div>

    {legacy.length > 0 && canWrite && <div className="wp-notes-legacy">
      <span>{legacy.length === 1 ? '1 actiepunt staat nog in deze browser.' : `${legacy.length} actiepunten staan nog in deze browser.`}</span>
      <button type="button" onClick={() => void importLegacy()} disabled={busy}>Overzetten</button>
    </div>}

    {canWrite && <div className="wp-notes-input-row">
      <input
        className="wp-notes-input"
        value={input}
        disabled={busy}
        placeholder="Noteer iets snel…"
        aria-label="Nieuw actiepunt voor deze week"
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
      />
      <button type="button" className="wp-notes-add" onClick={() => void add()} disabled={!input.trim() || busy} title="Toevoegen">
        <Plus size={14}/>
      </button>
    </div>}

    {notes.length === 0 && <div className="wp-notes-empty">Nog geen actiepunten voor deze week.</div>}
    {notes.length > 0 && <ul className="wp-notes-list">
      {[...open, ...done].map(note => <li key={note.id} className={`wp-notes-item ${note.done ? 'is-done' : ''}`}>
        <input
          type="checkbox"
          className="wp-notes-checkbox"
          id={`note-${note.id}`}
          checked={note.done}
          disabled={!canWrite}
          onChange={() => void onToggle(note.id, !note.done)}
        />
        <label htmlFor={`note-${note.id}`} className="wp-notes-label">{note.text}</label>
        {canWrite && <button type="button" className="wp-notes-delete" onClick={() => void onRemove(note.id)} title="Verwijderen">
          <X size={11}/>
        </button>}
      </li>)}
    </ul>}
  </section>;
}

/** Heeft deze taak een ingevulde tijdschatting? */
function hasEstimate(task: Task): boolean {
  return task.estimated_minutes !== null
    && task.estimated_minutes !== undefined
    && Number.isFinite(Number(task.estimated_minutes));
}

/** Minuten die deze taak meetelt. Zonder schatting is dat niets: een onbekende
 *  duur stil als een uur meetellen maakt elk totaal deels verzonnen. */
function taskEstimateMinutes(task: Task): number {
  if (!hasEstimate(task)) return 0;
  return Math.max(0, Math.min(24 * 60, Math.round(Number(task.estimated_minutes))));
}

function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function barSpanLabel(bar: WeekBar): string {
  if (bar.continuesLeft && bar.continuesRight) return 'loopt door';
  if (bar.span === 7) return 'hele week';
  const days = bar.span;
  return `${days} ${days === 1 ? 'dag' : 'dagen'}`;
}

/**
 * Tot en met welke dag loopt een strook die op deze dag begint? Tot het einde
 * van de zichtbare week — behalve op de laatste dag, want dan zou er niets te
 * overspannen zijn en werd het stilzwijgend weer een dagtaak. Daar loopt hij
 * één dag door in de volgende week.
 */
function weekStripEnd(dayKey: string, lastDayKey: string): string {
  return dayKey < lastDayKey ? lastDayKey : shiftDateKey(dayKey, 1);
}

/** Op smal scherm staan de dagen onder elkaar, dus zegt "3 dagen" niets over
 *  wélke dagen. Daar noemen we de periode voluit. */
function barDateLabel(bar: WeekBar): string {
  return `${formatDateShort(bar.task.planned_date!)} – ${formatDateShort(bar.task.planned_end_date!)}`;
}

function sortOutsideTasks(a: Task, b: Task): number {
  const dateCompare = String(a.planned_date ?? '').localeCompare(String(b.planned_date ?? ''));
  if (dateCompare !== 0) return dateCompare;
  return comparePlannedTasks(a, b);
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

/** De volgende stand in de cyclus, zodat één klik op de statuspil vooruit loopt.
 *  Vanaf "klaar" begin je weer bij "te doen" — dat is de enige weg terug die je
 *  zonder venster nodig hebt. */
function nextStatus(status: TaskStatus): TaskStatus {
  return ({ todo: 'doing', doing: 'review', review: 'done', done: 'todo' } as Record<TaskStatus, TaskStatus>)[status] ?? 'doing';
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

/** Waar een taak stond of komt te staan, in twee woorden: "wo 13" of "de lade". */
function planLabel(dateKey: string | null): string {
  return dateKey ? formatDayShort(dateKey) : 'de lade';
}

function formatDayShort(dateKey: string): string {
  return parseISODate(dateKey).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric' });
}
