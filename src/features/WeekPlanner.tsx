import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { CalendarCog, CalendarDays, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Flag, Inbox, ListTodo, MessageSquare, Palmtree, PanelLeftClose, PanelLeftOpen, Play, Plus, RotateCcw, Search, SlidersHorizontal, Square, Users, Wand2, X } from 'lucide-react';
import type { AppData, CalendarEventLink, CalendarExternalEvent, OrganizationMember, PlannerDayCapacity, PlannerNote, Priority, Task, TaskStatus, UUID } from '../types';
import { getCachedCalendarEvents, listCalendarEventsCached, loadCalendarIntegrations } from '../lib/calendar-api';
import { savePlannerDayOff, selectPlannerDaysOff } from '../lib/repository';
import { vividCalendarColor } from '../lib/calendarColors';
import { memberColor, memberInitials, memberShortName } from '../lib/members';
import { Select } from '../components/Ui';
import { PlannerPopover, Segmented, WeekPicker } from './WeekPlannerParts';
import { countActiveFilters, relativeWeekLabel, weekMeter, weekRangeLabel } from '../lib/weekView';
import { useBackStep } from '../lib/useBackStep';
import { loggedMinutesByTask, useRunningTimer } from '../lib/useTimer';
import { AssigneeAvatars } from '../components/AssigneeAvatars';
import { TimeBlockGrid, slotToTime, type GridDraft, type PreviewBlock, type TimeBlockGridHandle } from './CalendarPage';
import { addDays, DAY_NAMES_NL, formatISODate, isoWeekNumber, isSameDay, parseISODate, startOfWeek } from '../lib/dates';
import { clockLabel, comparePlannedTasks, DEFAULT_BLOCK_MINUTES, edgeScrollDelta, groupEventMinutesByDay, hasPlannedTime, isSpanningTask, layoutWeekBars, PANE_EDGE_SCROLL_ZONE_PX, parseDurationInput, proposeTimeBlocks, shiftDateKey, snapMinute, sortForAutoPlan, taskBlockMinutes } from '../lib/planning';
import { groupAssigneesByTask, scopeTasks } from '../lib/workweek';
import { calendarEventKey, calendarLinkKey, formatLinkShort, groupLinksByTask, groupTrackedMinutesByEventKey, localDayKey } from '../lib/calendar-links';
import { autoPlanWindowEnd, dayTaskMinutes, hasEstimate, isWorkday, netDay, netWeek, ownCalendarEvents, spanShares, taskEstimateMinutes, taskLoadByDay, workdayFrom, type NetDay } from '../lib/netTime';
import type { BusySlot, PlanProposal, WeekBar } from '../lib/planning';
import { priorityLabel } from '../lib/format';

type StatusFilter = 'open' | 'all' | TaskStatus;
type Scope = 'mine' | 'team';
type Density = 'compact' | 'comfortable';
/** Het rooster (dagen als kolommen, uren als rijen — hetzelfde als de agenda)
 *  of de lijst (zeven rijen onder elkaar die je open- en dichtklapt)? */
type Layout = 'grid' | 'stack';
/** Maakt het plusje van een dag werk van één dag, of een strook over meer dagen? */
type QuickAddMode = 'day' | 'week';
/** De drie manieren om naar je week te kijken. Eerst waren dat twee schakelaars
 *  (Mijn week/Team en Rooster/Lijst) waarvan de tweede in de teamweergave niets
 *  deed; nu is het één keuze. */
type PlannerView = 'grid' | 'stack' | 'team';
/** Het rooster met vijf of zeven dagen. Vijf kolommen zijn ruim een derde
 *  breder: de titels in de blokken werden bij zeven dagen afgekapt tot "We…". */
type DayMode = 'workweek' | 'week';
/** Welk tabblad van de werkvoorraad open staat. */
type TrayTab = 'tray' | 'deadline' | 'outside';

/** De beginstand van de filters: dit telt niet als "filter actief". */
const FILTER_REST = { clientId: '', projectId: '', priority: 'all', status: 'open' } as const;

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
  /** Losgelaten in het rooster: de taak krijgt deze dag én dit tijdstip, en
   *  wordt een blok met zijn schatting als duur. */
  | { type: 'time'; date: string; dayIndex: number; startMinute: number }
  /** Losgelaten op een afspraak-chip: de taak hoort dan bij die afspraak én
   *  komt op die dag te staan. `eventKey` is de sleutel van `calendarEventKey`. */
  | { type: 'event'; date: string; eventKey: string }
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
  /** Pak je een blok in het rooster halverwege op, dan blijft het blok onder je
   *  vinger hangen waar je het greep — dit is die afstand, in minuten. */
  grabOffsetMin: number;
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
  /** Het tijdstip dat hij had, als hij een blok was. */
  plannedStartMinute: number | null;
  /** Vóór wélke taak hij stond. Zonder dit is "terug" niet meer dan "die dag". */
  beforeTaskId: UUID | null;
};

/** Het voorstel van "Vul mijn week": blokken die er nog niet zijn, tot je ja zegt. */
type ProposalState = { items: PlanProposal[]; unplaced: number; skippedWeekend: boolean; candidates: number; pastWeek: boolean; weekendOnly: boolean };
/** Een getekend tijdvak in het rooster waar nog een titel bij moet. */
type DraftSlot = { dayIndex: number; startSlot: number; endSlot: number };

/** Waar het rooster de zoomstand bewaart; los van de agenda, die zijn eigen heeft. */
const GRID_ZOOM_STORAGE_KEY = 'resofly.weekplanner.zoom';
/** Vanaf hier zet "Vul mijn week" werk neer; tot hoe laat hangt af van je
 *  werktijd (`autoPlanWindowEnd`). De grens per dag is je netto tijd. Eerder
 *  spreidde het voorstel zonder streep tot zes en een half uur per dag, en
 *  zette het wat daar niet in paste alsnog in het eerste gat, ook als je dag
 *  al vol zat met meetings. */
const AUTO_PLAN_START_MINUTE = 9 * 60;

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
/** Staan de actiepunten onderin de werkvoorraad open? */
const NOTES_OPEN_STORAGE_KEY = 'resofly.weekplanner.notesOpen';
/** Dezelfde sleutel als de urenpagina: één lopende timer in de hele app. */
const TIMER_STORAGE_KEY = 'resofly-timer';

// Touch: vegen moet gewoon blijven scrollen, dus pakken we een sleep pas op nadat
// de vinger ~⅓ seconde stil ligt — hetzelfde gebaar als in de agenda.
const TOUCH_HOLD_MS = 320;
const TOUCH_HOLD_TOLERANCE_PX = 10;
// Met de muis is een paar pixels genoeg om een sleep van een klik te onderscheiden.
const MOUSE_DRAG_THRESHOLD_PX = 4;

/** Onder deze breedte staan de dagen onder elkaar in plaats van naast elkaar. */
const NARROW_QUERY = '(max-width: 900px)';

/** Voluit in de rijweergave: naast elkaar past alleen "Ma", onder elkaar is er
 *  ruimte zat en leest "maandag" een stuk rustiger. */
const DAY_FULL_NL = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'] as const;

/** Alle zeven weekdagnummers — voor "alles inklappen". */
const ALL_DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6];

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
  if (a.type === 'event' && b.type === 'event') return a.eventKey === b.eventKey;
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
  layout: Layout;
  /** Sinds welke ronde de weergavekeuze telt. Vóór versie 2 bestond het rooster
   *  niet; een bewaarde "onder elkaar" van toen is geen keuze tégen het rooster. */
  layoutVersion?: number;
  /** Vijf of zeven dagen in het rooster. Ontbreekt hij, dan volgt hij je
   *  werktijd: telt het weekend daar mee, dan staat het ook in beeld. */
  dayMode?: DayMode;
  /** Weekdagnummers (0 = maandag … 6 = zondag) die dichtgeklapt staan. Op
   *  nummer en niet op datum: wie het weekend dichtklapt wil dat volgende week
   *  ook, en anders staat elke nieuwe week weer helemaal open. */
  collapsedDays: number[];
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
  onPlanTaskTime,
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
  onSaveCapacity,
  onStopTimer,
  onOpenTicket,
  onLinkTaskToEvent,
  onUnlinkTaskEvent,
  onReserveTime,
}: {
  data: AppData;
  organizationId: UUID;
  canWrite: boolean;
  teamMembers: OrganizationMember[];
  currentUserId: string | null;
  onPlanTask: (taskId: UUID, plannedDate: string | null, beforeTaskId?: UUID | null) => Promise<void>;
  /** Zet een taak op een dag én een tijdstip (een blok in het rooster). `minutes`
   *  alleen meegeven als de duur verandert — bij het oprekken van een blok, of
   *  bij een taak zonder schatting die voor het eerst een blok wordt. */
  onPlanTaskTime: (taskId: UUID, plannedDate: string, startMinute: number, minutes?: number | null) => Promise<void>;
  onSetTaskPeriod: (taskId: UUID, plannedDate: string, plannedEndDate: string | null) => Promise<void>;
  onQuickAddTask: (plannedDate: string, title: string, plannedEndDate?: string | null, time?: { startMinute: number; minutes: number } | null) => Promise<Task | null>;
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
  onSaveCapacity: (minutes: number, includeWeekend: boolean) => Promise<void>;
  /** Schrijft een lopende timer weg als urenpost op deze taak. */
  onStopTimer: (startedAt: string, task: Task | null) => Promise<void>;
  onOpenTicket: (ticketId: UUID) => void;
  /** Afspraak ↔ taak: koppelen, ontkoppelen, en tijd reserveren via de agenda. */
  onLinkTaskToEvent: (task: Task, event: CalendarExternalEvent) => Promise<void>;
  onUnlinkTaskEvent: (link: CalendarEventLink) => Promise<void>;
  onReserveTime: (task: Task) => void;
}) {
  const storedPrefs = useRef(loadPrefs()).current;

  const [anchor, setAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [scope, setScope] = useState<Scope>(storedPrefs.scope === 'team' ? 'team' : 'mine');
  const [density, setDensity] = useState<Density>(storedPrefs.density === 'comfortable' ? 'comfortable' : 'compact');
  // Het rooster is de standaard — ook voor wie vóór deze ronde "onder elkaar"
  // koos, want toen was er nog geen rooster om tegen te kiezen. Wie daarna
  // bewust "Lijst" kiest houdt dat wel (layoutVersion 2). De oude kolomweergave
  // bestaat niet meer: het rooster ís de kolomweergave.
  const [layout, setLayout] = useState<Layout>(storedPrefs.layoutVersion === 2 && storedPrefs.layout === 'stack' ? 'stack' : 'grid');
  const [dayMode, setDayMode] = useState<DayMode>(() => storedPrefs.dayMode === 'week' || storedPrefs.dayMode === 'workweek'
    ? storedPrefs.dayMode
    : (data.plannerCapacity?.include_weekend ? 'week' : 'workweek'));
  /** Welk tabblad van de werkvoorraad open staat; hier en niet in de lade zelf,
   *  zodat de deadline-melding in de kop er rechtstreeks naartoe kan. */
  const [trayTab, setTrayTab] = useState<TrayTab>('tray');
  const [collapsedDays, setCollapsedDays] = useState<number[]>(() => (Array.isArray(storedPrefs.collapsedDays)
    ? storedPrefs.collapsedDays.filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    : []));
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
  /** Dagen onder elkaar als rijen die je open- en dichtklapt. Op een smal
   *  scherm toont het rooster één dag tegelijk — daar verandert deze keuze
   *  niets aan. De teamweergave blijft een raster van mensen × dagen: daar zíjn
   *  de kolommen het punt. */
  const stacked = layout === 'stack' && scope === 'mine' && !isNarrow;
  /** Het tijdrooster — hetzelfde als in de agenda — met de werkvoorraad ernaast. */
  const gridView = scope === 'mine' && !stacked;
  const view: PlannerView = scope === 'team' ? 'team' : stacked ? 'stack' : 'grid';
  const changeView = (next: PlannerView) => {
    if (next === 'team') { setScope('team'); return; }
    setScope('mine');
    setLayout(next);
  };
  const allFolded = collapsedDays.length === 7;

  // ── Het rooster ───────────────────────────────────────────────────────
  const gridRef = useRef<TimeBlockGridHandle | null>(null);
  /** Kleur per agenda, zodat een afspraak hier dezelfde kleur heeft als in de agenda. */
  const [sourceColors, setSourceColors] = useState<Map<string, string>>(() => new Map());
  /** Van wie is welke agenda? Alleen afspraken in je eigen agenda's kosten jóu
   *  tijd. `null` zolang het niet bekend is. */
  const [calendarSources, setCalendarSources] = useState<Array<{ id: string; user_id: string; sync_enabled: boolean }> | null>(null);
  /** Een getekend tijdvak waar nog een titel bij moet. */
  const [draft, setDraft] = useState<DraftSlot | null>(null);
  const [proposal, setProposal] = useState<ProposalState | null>(null);
  const [proposalBusy, setProposalBusy] = useState(false);
  const [gridZoom, setGridZoom] = useState<number>(() => {
    try { const raw = Number(localStorage.getItem(GRID_ZOOM_STORAGE_KEY) ?? '1'); return Number.isFinite(raw) && raw > 0 ? raw : 1; }
    catch { return 1; }
  });
  const [gridScrollKey, setGridScrollKey] = useState(0);
  /** De werkvoorraad kan dicht op een klein scherm, waar hij bóven het rooster
   *  staat — en daar begint hij dicht, anders scrol je op een telefoon eerst
   *  langs je hele voorraad voordat je de dag ziet. */
  const [backlogOpen, setBacklogOpen] = useState(() => typeof window === 'undefined' || !window.matchMedia('(max-width: 1024px)').matches);

  const applyGridZoom = useCallback((next: number) => {
    setGridZoom(next);
    try { localStorage.setItem(GRID_ZOOM_STORAGE_KEY, String(next)); } catch { /* privémodus */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadCalendarIntegrations(organizationId)
      .then(payload => {
        if (cancelled) return;
        setSourceColors(new Map(payload.sources.map(source => [source.id, vividCalendarColor(source.color)])));
        setCalendarSources(payload.sources.map(source => ({ id: source.id, user_id: source.user_id, sync_enabled: source.sync_enabled })));
      })
      // Geen agenda gekoppeld? Dan blijft het merkgoud de terugvalkleur.
      .catch(() => { /* de planner werkt door zonder agendakleuren */ });
    return () => { cancelled = true; };
  }, [organizationId]);
  const toggleDayFold = useCallback((index: number) => {
    setCollapsedDays(prev => prev.includes(index) ? prev.filter(day => day !== index) : [...prev, index]);
  }, []);

  useEffect(() => {
    const prefs: StoredPrefs = {
      scope,
      density,
      layout,
      layoutVersion: 2,
      dayMode,
      collapsedDays,
      clientId: filters.clientId,
      projectId: filters.projectId,
      priority: filters.priority,
      status: filters.status,
    };
    try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs)); } catch { /* privémodus: niet erg */ }
  }, [scope, density, layout, dayMode, collapsedDays, filters.clientId, filters.projectId, filters.priority, filters.status]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(anchor, i)), [anchor]);
  const weekEnd = days[6];
  const dayKeys = useMemo(() => new Set(days.map(formatISODate)), [days]);

  // ── Vrije dagen (2026-11-25) ──────────────────────────────────────────
  // Dagen die je zelf vrij zette: daar is geen werktijd, en "Vul mijn week"
  // slaat ze over. Per week geladen, niet bij het opstarten; bewaard in
  // planner_days_off, alleen voor jou.
  const [daysOff, setDaysOff] = useState<Set<string>>(() => new Set());
  const weekFirstKey = formatISODate(days[0]);
  const weekLastKey = formatISODate(weekEnd);
  // Een andere organisatie heeft haar eigen vrije dagen.
  useEffect(() => { setDaysOff(new Set()); }, [organizationId]);
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    selectPlannerDaysOff(organizationId, currentUserId, weekFirstKey, weekLastKey)
      .then(rows => {
        if (cancelled) return;
        setDaysOff(prev => {
          const next = new Set([...prev].filter(key => key < weekFirstKey || key > weekLastKey));
          for (const row of rows) next.add(row.day);
          return next;
        });
      })
      // Niet bereikbaar: dan is er geen vrije dag, en rekent de planner gewoon door.
      .catch(() => { /* de planner werkt door zonder vrije dagen */ });
    return () => { cancelled = true; };
  }, [organizationId, currentUserId, weekFirstKey, weekLastKey]);
  /** Alleen in "Mijn week": in het team zijn het andermans dagen. */
  const myDaysOff = scope === 'mine' ? daysOff : undefined;
  /** Een dag vrij zetten of weer werkdag maken. Meteen in beeld; lukt het
   *  opslaan niet, dan gaat hij terug en staat er waarom. */
  const toggleDayOff = useCallback(async (key: string) => {
    if (!currentUserId || !canWrite) return;
    const off = !daysOff.has(key);
    const flip = (value: boolean) => setDaysOff(prev => {
      const next = new Set(prev);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
    flip(off);
    setError(null);
    try {
      await savePlannerDayOff(organizationId, currentUserId, key, off);
    } catch (err) {
      flip(!off);
      setError(err instanceof Error ? err.message : 'Vrije dag opslaan mislukt');
    }
  }, [canWrite, currentUserId, daysOff, organizationId]);

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

  /** Je eigen afspraken. Een collega die zijn agenda met de organisatie deelt,
   *  stond hier eerst ook in, en zijn meetings gingen van jóuw netto tijd af. */
  const myEvents = useMemo(() => ownCalendarEvents(events, calendarSources, currentUserId), [events, calendarSources, currentUserId]);
  /** Per dag: welke afspraken, en hoeveel tijd ze samen bezet houden (overlap één keer). */
  const agendaByDay = useMemo(() => groupEventMinutesByDay(days.map(formatISODate), myEvents), [myEvents, days]);

  // ── Afspraak ↔ taak ───────────────────────────────────────────────────
  // Welke afspraken horen bij welke taak, en andersom. De koppelingen komen
  // uit de database (org-breed), de afspraken zelf uit de agenda hierboven.
  const linksByTask = useMemo(() => groupLinksByTask(data.calendarEventLinks), [data.calendarEventLinks]);
  const linksByEventKey = useMemo(() => {
    const map = new Map<string, CalendarEventLink>();
    for (const link of data.calendarEventLinks) if (link.task_id) map.set(calendarLinkKey(link), link);
    return map;
  }, [data.calendarEventLinks]);
  const tasksById = useMemo(() => new Map(data.tasks.map(task => [task.id, task])), [data.tasks]);
  /** Alle afspraken van de week op hun sleutel — voor de dropzones in het rooster. */
  const eventsByKey = useMemo(() => new Map(myEvents.map(event => [calendarEventKey(event), event])), [myEvents]);
  const trackedByEventKey = useMemo(() => groupTrackedMinutesByEventKey(data.timeEntries, data.calendarEventLinks), [data.timeEntries, data.calendarEventLinks]);
  const trackedMinutesFor = useCallback((event: CalendarExternalEvent) => trackedByEventKey.get(calendarEventKey(event)) ?? null, [trackedByEventKey]);

  const projectsById = useMemo(() => new Map(data.projects.map(project => [project.id, project])), [data.projects]);
  const clientsById = useMemo(() => new Map(data.clients.map(client => [client.id, client])), [data.clients]);
  const assigneesByTask = useMemo(() => groupAssigneesByTask(data.taskAssignees), [data.taskAssignees]);

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

    // "Mijn werk" komt uit dezelfde module als het startscherm, zodat dezelfde
    // taak niet op het ene scherm van jou is en op het andere niet.
    return scopeTasks(data.tasks, scope, currentUserId, assigneesByTask).filter(task => {
      // Werk van een gearchiveerd project plan je niet meer in. Kies je dat
      // project expliciet in het filter, dan zie je het wél — dat is dan een
      // bewuste vraag en geen ruis.
      if (task.project_id && archivedProjectIds.has(task.project_id) && filters.projectId !== task.project_id) return false;

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

  /** Je werktijd per dag: wat je zelf instelde, en anders acht uur op werkdagen. */
  const workday = useMemo(() => workdayFrom(data.plannerCapacity), [data.plannerCapacity]);

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
      // Zelfde regel als de netto tijd (`dayTaskMinutes`): een blok telt zijn
      // blok, een gekoppelde afspraak op deze dag staat al bij de afspraken.
      bucket.minutes = bucket.tasks.reduce((sum, task) => sum + dayTaskMinutes(task, key, linksByTask.get(task.id) ?? []), 0);
      bucket.noEstimateCount = bucket.tasks.filter(task => !hasEstimate(task) && !hasPlannedTime(task)).length;
      // In het team zijn het andermans dagen: jouw afspraken horen daar niet bij.
      bucket.agendaMinutes = scope === 'mine' ? agendaByDay.get(key)?.minutes ?? 0 : 0;
    }

    // Weekstroken verdelen hun uren over de werkdagen van de hele strook.
    for (const task of spanningTasks) {
      for (const [key, share] of spanShares(task, orderedKeys, workday, linksByTask.get(task.id) ?? [], myDaysOff)) {
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
      noEstimateCount: [...weekTasks, ...spanningTasks].filter(task => !hasEstimate(task) && !hasPlannedTime(task)).length,
      agendaMinutes: Array.from(byDay.values()).reduce((sum, bucket) => sum + bucket.agendaMinutes, 0),
      spanMinutes: 0,
    };
    // De balk per dag wordt geschaald op de volste dag van deze week: geen norm,
    // alleen de onderlinge verhouding. De weekstroken tellen nu wél mee met hun
    // aandeel per dag — een strook van achttien uur die nul bijdraagt is erger
    // dan een verdeling met een ± ervoor.
    const busiestMinutes = Math.max(0, ...Array.from(byDay.values()).map(bucket => bucket.minutes + bucket.agendaMinutes + bucket.spanMinutes));

    return { byDay, unscheduled, outsideThisWeek, weekBucket, busiestMinutes, spanningTasks };
  }, [agendaByDay, dayKeys, days, filteredTasks, linksByTask, myDaysOff, scope, workday]);

  // ── Netto tijd ────────────────────────────────────────────────────────
  // Werktijd − afspraken = netto tijd; netto tijd − taken = vrij. Gerekend over
  // al je open werk in deze week, los van zoeken en filters: met een filter op
  // één project zei de dagkop anders "6u vrij" terwijl de rest van je werk er
  // gewoon nog stond.
  const myOpenTasks = useMemo(() => scopeTasks(data.tasks, 'mine', currentUserId, assigneesByTask)
    .filter(task => task.status !== 'done' && !(task.project_id && archivedProjectIds.has(task.project_id))),
  [archivedProjectIds, assigneesByTask, currentUserId, data.tasks]);
  const linksFor = useCallback((taskId: string) => linksByTask.get(taskId) ?? [], [linksByTask]);
  const myLoad = useMemo(() => taskLoadByDay(days.map(formatISODate), myOpenTasks, workday, linksFor, daysOff), [days, daysOff, linksFor, myOpenTasks, workday]);
  const netByDay = useMemo(() => new Map<string, NetDay>(days.map(day => {
    const key = formatISODate(day);
    const load = myLoad.get(key);
    return [key, netDay(key, workday, agendaByDay.get(key)?.minutes ?? 0, (load?.minutes ?? 0) + (load?.spanMinutes ?? 0), daysOff.has(key))];
  })), [agendaByDay, days, daysOff, myLoad, workday]);
  const net = useMemo(() => netWeek([...netByDay.values()]), [netByDay]);
  /** Hoeveel van je open taken deze week staan, en hoeveel daarvan zonder schatting. */
  const myWeek = useMemo(() => {
    const first = formatISODate(days[0]);
    const last = formatISODate(days[6]);
    const inWeek = myOpenTasks.filter(task => !!task.planned_date && task.planned_date <= last && (task.planned_end_date ?? task.planned_date) >= first);
    // Een blok heeft altijd een duur; alleen werk zónder tijd kan een schatting missen.
    return { count: inWeek.length, noEstimate: inWeek.filter(task => !hasEstimate(task) && !hasPlannedTime(task)).length };
  }, [days, myOpenTasks]);

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

  const isCurrentWeek = isSameDay(anchor, startOfWeek(todayLocal));

  /** De weekstroken bij elkaar, voor het kopje boven de weektaken in de lijst. */
  const spanningMinutes = spanningTasks.reduce((sum, task) => sum + taskEstimateMinutes(task), 0);
  const weekTaskCount = weekBucket.count + spanningTasks.length;
  /** De taakuren van het team in beeld: dagtaken plus het deel van de stroken in deze week. */
  const teamWeekMinutes = Array.from(byDay.values()).reduce((sum, bucket) => sum + bucket.minutes + bucket.spanMinutes, 0);

  /**
   * Wat een dagkop laat zien, en waarop de dagbalk schaalt.
   *
   * In "Mijn week" is de werktijd de maat: de balk is je werkdag, violet zijn je
   * afspraken, goud je taken, en wat leeg blijft is vrij. Zonder zelf gezette
   * streep schaalde de balk op de volste dag van de week; die dag stond dan
   * altijd vol, hoe leeg hij ook was.
   *
   * In het team is er geen werktijd (wiens zou het zijn?) en geen agenda van
   * jou: daar blijft het de onderlinge verhouding tussen de dagen, met een
   * bodem van vier uur zodat één taak van een kwartier de balk niet vult.
   */
  const dayFigures = (key: string): { meetings: number; tasks: number; spread: boolean; net: NetDay | null; scale: number } => {
    if (scope === 'mine') {
      const netOfDay = netByDay.get(key) ?? netDay(key, workday, 0, 0);
      return {
        meetings: netOfDay.meetingMinutes,
        tasks: netOfDay.taskMinutes,
        spread: (myLoad.get(key)?.spanMinutes ?? 0) > 0,
        net: netOfDay,
        scale: Math.max(workday.minutes, netOfDay.meetingMinutes + netOfDay.taskMinutes),
      };
    }
    const bucket = byDay.get(key) ?? EMPTY_BUCKET;
    return { meetings: 0, tasks: bucket.minutes + bucket.spanMinutes, spread: bucket.spanMinutes > 0, net: null, scale: Math.max(busiestMinutes, 240) };
  };

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
  const activeFieldCount = countActiveFilters(filters, FILTER_REST);
  const hasActiveFilters = filters.query.trim() !== '' || activeFieldCount > 0;

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
  /** De afspraak-chips zijn óók dropzones: een taak erop loslaten koppelt hem.
   *  Ze liggen ín een dagzone en gaan daarom vóór bij het bepalen van het doel. */
  const eventZonesRef = useRef(new Map<string, { el: HTMLElement; date: string }>());
  const registerEventZone = useCallback((eventKey: string, date: string, el: HTMLElement | null) => {
    if (el) eventZonesRef.current.set(eventKey, { el, date });
    else eventZonesRef.current.delete(eventKey);
  }, []);

  const dragRef = useRef<DragState | null>(null);
  const pendingFocusRef = useRef<UUID | null>(null);

  const resolveTarget = useCallback((x: number, y: number, taskId: UUID): DropTarget | null => {
    for (const [eventKey, zone] of eventZonesRef.current) {
      const rect = zone.el.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      return { type: 'event', date: zone.date, eventKey };
    }
    // Het rooster: een afspraakblok is een dropzone (koppelen), de kolom eronder
    // een tijdstip, en de dagkop of de dagband de dag zónder tijd. Het rooster
    // zelf zegt alleen welke dag en welke minuut er onder de aanwijzer ligt.
    const hit = gridRef.current?.hitTest(x, y) ?? null;
    if (hit) {
      const date = formatISODate(hit.day);
      const under = document.elementFromPoint(x, y);
      const eventKey = under instanceof Element ? under.closest<HTMLElement>('[data-event-key]')?.dataset.eventKey ?? null : null;
      const event = eventKey ? eventsByKey.get(eventKey) : undefined;
      if (event && eventKey && canWrite && !event.all_day && event.visibility === 'organization' && !event.is_private_masked) {
        return { type: 'event', date, eventKey };
      }
      if (hit.minutes === null) return { type: 'day', date, beforeTaskId: null };
      const task = tasksById.get(taskId);
      const minutes = task ? taskBlockMinutes(task) : DEFAULT_BLOCK_MINUTES;
      const offset = dragRef.current?.grabOffsetMin ?? 0;
      return { type: 'time', date, dayIndex: hit.dayIndex, startMinute: snapMinute(hit.minutes - offset, minutes) };
    }
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
  }, [canWrite, eventsByKey, tasksById]);

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
        plannedStartMinute: hasPlannedTime(task) ? Number(task.planned_start_minute) : null,
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
        if (step.plannedDate && step.plannedStartMinute !== null) {
          await onPlanTaskTime(step.taskId, step.plannedDate, step.plannedStartMinute);
        } else if (step.plannedDate && step.plannedEndDate && step.plannedEndDate > step.plannedDate) {
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

    // Losgelaten op een afspraak: de taak hoort bij die afspraak én komt op die
    // dag te staan. Ongedaan maken zet alleen de plek terug; de koppeling haal
    // je via het snelmenu weer weg.
    if (target.type === 'event') {
      const event = agendaByDay.get(target.date)?.items.find(item => calendarEventKey(item) === target.eventKey);
      if (!event) return;
      setError(null);
      pendingFocusRef.current = taskId;
      const undoSteps = captureUndo([taskId]);
      const moves = (task.planned_date ?? null) !== target.date || isSpanningTask(task);
      try {
        await onLinkTaskToEvent(task, event);
        if (moves) {
          await onPlanTask(taskId, target.date, null);
          offerUndo({
            label: `${task.title}: bij «${event.title}» → ${planLabel(target.date)}`,
            steps: undoSteps,
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Koppelen aan afspraak mislukt');
      }
      return;
    }

    // Losgelaten in het rooster: dag én tijd. Een taak zonder schatting krijgt
    // meteen een uur — een blok zonder duur bestaat niet — en die duur rek je
    // daarna aan de randen op.
    if (target.type === 'time') {
      if (hasPlannedTime(task) && task.planned_date === target.date && Number(task.planned_start_minute) === target.startMinute) return;
      setError(null);
      pendingFocusRef.current = taskId;
      const undoSteps = captureUndo([taskId]);
      try {
        await onPlanTaskTime(taskId, target.date, target.startMinute, hasEstimate(task) ? undefined : DEFAULT_BLOCK_MINUTES);
        offerUndo({
          label: `${task.title}: ${undoSteps[0] ? planLabel(undoSteps[0].plannedDate) : '?'} → ${formatDayShort(target.date)} ${clockLabel(target.startMinute)}`,
          steps: undoSteps,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Tijd zetten mislukt');
      }
      return;
    }

    const plannedDate = target.type === 'day' ? target.date : null;
    const beforeTaskId = target.type === 'day' ? target.beforeTaskId : null;
    if (beforeTaskId === taskId) return;

    // In de teamweergave: losgelaten in de rij van een ander? Dan verhuist de
    // taak mee naar die persoon.
    const targetUser = target.type === 'day' ? target.userId : undefined;
    const current = assigneesByTask.get(taskId) ?? [];
    const reassign = targetUser !== undefined
      && !(targetUser === null ? current.length === 0 : current.length === 1 && current[0] === targetUser);
    // Een blok terug in de dagband zetten is wél een verplaatsing, ook al blijft
    // de dag gelijk: de tijd gaat eraf.
    const clearsTime = target.type === 'day' && hasPlannedTime(task);

    // Al op deze plek, en niemand hoeft te verhuizen? Dan hoeft er niets naar de server.
    if (!reassign && !clearsTime && (task.planned_date ?? null) === plannedDate && !beforeTaskId) {
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
        label: clearsTime && plannedDate
          ? `${task.title}: ${clockLabel(Number(task.planned_start_minute))} → ${planLabel(plannedDate)} zonder tijd`
          : `${task.title}: ${undoSteps[0] ? planLabel(undoSteps[0].plannedDate) : '?'} → ${planLabel(plannedDate)}`,
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
  }, [agendaByDay, assigneesByTask, byDay, captureUndo, data.tasks, offerUndo, onAssignTask, onLinkTaskToEvent, onPlanTask, onPlanTaskTime]);

  async function linkFromMenu(task: Task, event: CalendarExternalEvent) {
    setError(null);
    try {
      await onLinkTaskToEvent(task, event);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Koppelen aan afspraak mislukt');
    }
  }

  async function unlinkFromMenu(link: CalendarEventLink) {
    setError(null);
    try {
      await onUnlinkTaskEvent(link);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ontkoppelen mislukt');
    }
  }

  // ── Timer ─────────────────────────────────────────────────────────────
  // De timer zat opgesloten op de pagina Urenregistratie: je zag een taak voor
  // je liggen en moest naar een ander scherm om de klok te starten, waar je
  // project en klant nog eens met de hand koos. Nu leidt hij dat uit de taak af.
  const { running, persist: persistTimer } = useRunningTimer(TIMER_STORAGE_KEY);
  const loggedByTask = useMemo(() => loggedMinutesByTask(data.timeEntries), [data.timeEntries]);

  async function toggleTimer(task: Task) {
    if (!canWrite) return;
    setError(null);
    // Loopt de klok al op déze taak, dan stopt hij en wordt de tijd geschreven.
    if (running?.taskId === task.id) {
      try {
        await onStopTimer(running.startedAt, task);
        persistTimer(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Uren opslaan mislukt');
      }
      return;
    }
    // Loopt er een klok op iets anders? Die schrijven we eerst weg, zodat er
    // nooit twee tegelijk lopen en er geen tijd zoekraakt.
    if (running) {
      const previous = data.tasks.find(row => row.id === running.taskId) ?? null;
      try {
        await onStopTimer(running.startedAt, previous);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Lopende timer opslaan mislukt');
        return;
      }
    }
    const links = taskLinks(task);
    persistTimer({
      taskId: task.id,
      projectId: task.project_id ?? '',
      clientId: links.clientId ?? '',
      description: task.title,
      startedAt: new Date().toISOString(),
    });
  }

  // ── Snelmenu ──────────────────────────────────────────────────────────
  // `onContextMenu` kwam in de hele app niet voor, en lang indrukken is op touch
  // al bezet door het slepen. Eén menu dekt zeven handelingen die anders elk hun
  // eigen knopje op een kaart van 52px hadden moeten krijgen.
  const [menu, setMenu] = useState<{ taskId: UUID; x: number; y: number } | null>(null);
  /** De lijst "Koppel aan afspraak" klapt ín het menu open; dicht bij elk nieuw menu. */
  const [menuAgendaOpen, setMenuAgendaOpen] = useState(false);
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

  useBackStep(menu !== null, () => setMenu(null));

  function openMenu(task: Task, x: number, y: number) {
    if (!canWrite) return;
    setMenuAgendaOpen(false);
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

  const armDrag = useCallback((taskId: UUID, x: number, y: number, touch: boolean, width: number, grabOffsetMin = 0) => {
    const next: DragState = {
      taskId, touch, origin: { x, y }, pointer: { x, y }, width, grabOffsetMin,
      moved: touch, // een lange druk ís al een sleepgebaar
      target: null,
    };
    dragRef.current = next;
    setDrag(next);
  }, []);

  function beginCardPointer(e: React.PointerEvent, task: Task) {
    if (!canWrite) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const width = rect.width;
    const startX = e.clientX;
    const startY = e.clientY;
    // Een blok in het rooster pak je ergens halverwege op; dat punt blijft onder
    // de aanwijzer terwijl je sleept. Een kaart uit de werkvoorraad landt met
    // zijn begin op de aanwijzer.
    const grabOffsetMin = el.classList.contains('tb-task-block') && rect.height > 0
      ? ((startY - rect.top) / rect.height) * taskBlockMinutes(task)
      : 0;

    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      armDrag(task.id, startX, startY, false, width, grabOffsetMin);
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
    startHold(startX, startY, () => { isTap = false; cleanup(); armDrag(task.id, startX, startY, true, width, grabOffsetMin); });
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
    setMobileDay(formatISODate(todayLocal));
    // Het rooster scrolt alleen op verzoek terug naar "nu"; bladeren laat de
    // hoogte met rust, net als in de agenda.
    setGridScrollKey(key => key + 1);
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
  async function quickAdd(dateKey: string, title: string, endKey?: string, assignTo?: string | null, time?: { startMinute: number; minutes: number } | null): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed || quickAddBusy) return false;
    setError(null);
    setQuickAddBusy(true);
    try {
      const created = await onQuickAddTask(dateKey, trimmed, endKey ?? null, time ?? null);
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
  useEffect(() => { setQuickAddDay(null); setTeamQuickAdd(null); setDraft(null); setProposal(null); }, [anchor, scope]);

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
      clientId,
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

  /**
   * Eén kaart voor alles: dagtaken, de lade én — sinds de weektaken een eigen
   * kaart hebben — de stroken. Een strook geeft `bar` mee: dan krijgt de kaart
   * een periode-pil, sturen de pijltjestoetsen de periode in plaats van de
   * focus, en (in de kolomweergave) ligt hij dwars over zijn dagen met de
   * sleepranden erop.
   */
  const taskCard = (task: Task, options: {
    showPlannedDate?: boolean;
    insertBefore?: string | null;
    bar?: WeekBar;
    className?: string;
    style?: React.CSSProperties;
    isDragging?: boolean;
    onPointerDown?: (event: React.PointerEvent) => void;
    grips?: React.ReactNode;
  } = {}) => {
    const bar = options.bar;
    return <TaskCard
      key={task.id}
      task={task}
      {...taskLinks(task)}
      assigneeIds={assigneesByTask.get(task.id) ?? []}
      teamMembers={teamMembers}
      currentUserId={currentUserId}
      density={density}
      isDragging={options.isDragging ?? (drag?.taskId === task.id && drag.moved)}
      isInsertTarget={options.insertBefore === task.id}
      canWrite={canWrite}
      showPlannedDate={options.showPlannedDate}
      className={options.className}
      style={options.style}
      period={bar ? barPeriodLabel(bar) : null}
      agendaLinks={linksByTask.get(task.id) ?? []}
      onOpenAgendaLink={link => onOpenCalendar(localDayKey(link.event_starts_at))}
      onPointerDown={options.onPointerDown ?? ((event) => beginCardPointer(event, task))}
      onKeyDown={(event) => {
        if (bar && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { handleBarKey(event, bar); return; }
        handleCardKey(event, task);
      }}
      onOpen={() => onEditTask(task)}
      onSetStatus={(target, status) => { void onSetTaskStatus(target, status); }}
      onSetEstimate={(target, minutes) => { void onSetTaskEstimate(target, minutes); }}
      onOpenProject={onOpenProject}
      onMenu={openMenu}
      loggedMinutes={loggedByTask.get(task.id) ?? 0}
      isTiming={running?.taskId === task.id}
      onToggleTimer={() => { void toggleTimer(task); }}
      onOpenTicket={onOpenTicket}
    >{options.grips}</TaskCard>;
  };

  /**
   * Een afspraak in de dag: deur naar de agenda, en sinds de koppeling aan
   * taken ook dropzone — laat je er een taak op los, dan hoort die bij deze
   * afspraak en staat hij op deze dag. Draagt de afspraak al een taak, dan
   * staat die erbij, met het stipje van het project.
   */
  const agendaChip = (event: CalendarExternalEvent, dayKey: string) => {
    const eventKey = calendarEventKey(event);
    const link = linksByEventKey.get(eventKey);
    const linkedTask = link?.task_id ? tasksById.get(link.task_id) ?? null : null;
    const isDrop = drag?.moved === true && drag.target?.type === 'event' && drag.target.eventKey === eventKey;
    // Privé-afspraken blijven dicht: de koppeltabel is voor de hele organisatie leesbaar.
    const linkable = canWrite && !event.all_day && event.visibility === 'organization' && !event.is_private_masked;
    return <button
      key={`${event.source_id}-${event.provider_event_id}-${event.starts_at}`}
      type="button"
      className={`wp-agenda-chip ${linkedTask ? 'is-linked' : ''} ${isDrop ? 'is-drop' : ''}`}
      title={linkedTask
        ? `${event.title} · taak: ${linkedTask.title} — open in de agenda`
        : `${event.title} — open in de agenda${linkable ? ' · sleep een taak hierheen om te koppelen' : ''}`}
      ref={linkable ? (el => registerEventZone(eventKey, dayKey, el)) : undefined}
      onClick={() => onOpenCalendar(dayKey)}
    >
      <span className="wp-agenda-time">{formatEventTime(event.starts_at)}</span>
      <span className="wp-agenda-name">{event.title}</span>
      {linkedTask && <span className="wp-agenda-task"><i style={{ background: taskLinks(linkedTask).color }} aria-hidden="true"/>{linkedTask.title}</span>}
    </button>;
  };

  const draggedTask = drag ? data.tasks.find(t => t.id === drag.taskId) ?? null : null;

  // ── Het rooster: wat de planner aan het rooster geeft ─────────────────
  // Hetzelfde tijdrooster als de agenda. De planner levert de taken, de
  // afspraken en een paar render-functies; het rooster tekent en meet.

  /** Op een smal scherm één dag in het rooster; de dagstrip is de weg naar de
   *  rest. Breed zijn het vijf of zeven dagen, naar keuze. */
  const showWeekend = dayMode === 'week';
  const gridDays = useMemo(
    () => (isNarrow ? [parseISODate(mobileDay)] : showWeekend ? days : days.slice(0, 5)),
    [days, isNarrow, mobileDay, showWeekend],
  );
  /** Wat er in het weekend staat terwijl het uit beeld is. Zonder deze teller
   *  verdween een zaterdagklus geruisloos uit je week. */
  const hiddenWeekend = useMemo(() => {
    if (!gridView || isNarrow || showWeekend) return 0;
    return days.slice(5).reduce((sum, day) => {
      const key = formatISODate(day);
      const agenda = agendaByDay.get(key);
      return sum + (byDay.get(key)?.count ?? 0) + (agenda?.items.length ?? 0) + (agenda?.allDay.length ?? 0);
    }, 0);
  }, [agendaByDay, byDay, days, gridView, isNarrow, showWeekend]);
  const gridDayKeys = useMemo(() => gridDays.map(formatISODate), [gridDays]);
  /** Alles met een plandag; het rooster kiest zelf per dag wat erbij hoort. */
  const gridTasks = useMemo(() => filteredTasks.filter(task => !!task.planned_date), [filteredTasks]);
  /** Titel van de taak die aan een afspraak hangt — voor het taakteken op het blok. */
  const linkedTaskFor = useCallback((event: CalendarExternalEvent): string | null => {
    const link = linksByEventKey.get(calendarEventKey(event));
    return link?.task_id ? tasksById.get(link.task_id)?.title ?? null : null;
  }, [linksByEventKey, tasksById]);

  /** Een tijdvak tekenen (of het plusje in een dagkop) opent het formulier ín het vak. */
  const openDraft = (day: Date, startSlot: number, endSlot: number) => {
    if (!canWrite) return;
    const dayIndex = gridDays.findIndex(candidate => isSameDay(candidate, day));
    if (dayIndex < 0) return;
    setProposal(null);
    setDraft({ dayIndex, startSlot: Math.min(startSlot, endSlot), endSlot: Math.max(startSlot, endSlot) });
  };
  const minuteOfSlot = (slot: number) => { const time = slotToTime(slot); return time.hour * 60 + time.minutes; };
  const draftStartMinute = draft ? minuteOfSlot(draft.startSlot) : 0;
  const draftEndMinute = draft ? minuteOfSlot(draft.endSlot + 1) : 0;
  const gridDraft: GridDraft | null = draft && gridDayKeys[draft.dayIndex] ? {
    ...draft,
    node: <GridQuickAdd
      key={`${gridDayKeys[draft.dayIndex]}-${draft.startSlot}`}
      busy={quickAddBusy}
      startMinute={draftStartMinute}
      endMinute={draftEndMinute}
      onSubmit={title => quickAdd(gridDayKeys[draft.dayIndex], title, undefined, undefined, { startMinute: draftStartMinute, minutes: Math.max(15, draftEndMinute - draftStartMinute) })}
      onCancel={() => setDraft(null)}
    />,
  } : null;

  /** De kaart van een taak zonder tijd in de dagband: sleep hem het rooster in. */
  const bandChip = (task: Task, bar: { continuesLeft: boolean; continuesRight: boolean; span: number }) => {
    const links = taskLinks(task);
    const done = task.status === 'done';
    const spanning = isSpanningTask(task);
    const dragging = drag?.taskId === task.id && drag.moved;
    return <div
      className={`wp-band-task${done ? ' is-done' : ''}${dragging ? ' is-dragging' : ''}${spanning ? ' is-span' : ''}${task.priority === 'high' ? ' is-high' : ''}`}
      style={{ '--bar': links.color } as React.CSSProperties}
      data-task-id={task.id}
      role="group"
      tabIndex={0}
      aria-label={`${task.title}, nog geen tijd${spanning ? `, ${bar.span} dagen` : ''}${done ? ', klaar' : ''}`}
      title={`${task.title}${links.projectName ? ` · ${links.projectName}` : ''}${canWrite ? '\nSleep het rooster in om een tijd te kiezen' : ''}`}
      onPointerDown={canWrite ? (event => beginCardPointer(event, task)) : undefined}
      onKeyDown={event => handleCardKey(event, task)}
      onContextMenu={event => { if (!canWrite) return; event.preventDefault(); openMenu(task, event.clientX, event.clientY); }}
    >
      <button type="button" className="wp-band-check" aria-pressed={done} disabled={!canWrite}
        aria-label={done ? `${task.title} weer openzetten` : `${task.title} afvinken`}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => { void onSetTaskStatus(task, done ? 'todo' : 'done'); }}>
        {done && <Check size={10} aria-hidden="true"/>}
      </button>
      {/* Zelfde regel als op de kaart: de kaart sleept en opent, de titelknop is er voor Enter. */}
      <button type="button" className="wp-band-title" onClick={event => { if (event.detail === 0) onEditTask(task); }}>{task.title}</button>
      {spanning && <span className="wp-band-span">{bar.span === 1 ? '1 dag' : `${bar.span} dagen`}</span>}
      <span className={`wp-band-est${hasEstimate(task) ? '' : ' is-unset'}`}>{hasEstimate(task) ? formatDuration(taskEstimateMinutes(task)) : '—'}</span>
    </div>;
  };

  /** Onder de dagnaam in de kop: aantal, netto tijd, wat er vrij is en de drukte-balk. */
  /**
   * De knop om een dag vrij te zetten, naast het plusje. Alleen op dagen die
   * meetellen (een weekend dat niet meetelt is al vrij) en alleen in "Mijn
   * week". Staat de dag vrij, dan blijft de knop zichtbaar en zet hij hem terug.
   */
  const dayOffButton = (day: Date) => {
    const key = formatISODate(day);
    const off = daysOff.has(key);
    if (scope !== 'mine' || !canWrite || !currentUserId) return null;
    if (!off && !isWorkday(key, workday)) return null;
    const name = `${DAY_FULL_NL[(day.getDay() + 6) % 7]} ${day.getDate()}`;
    return <button
      type="button"
      className={`wp-day-offbtn${off ? ' is-on' : ''}`}
      aria-pressed={off}
      aria-label={off ? `${name} is een vrije dag; weer werkdag maken` : `${name} als vrije dag`}
      title={off ? 'Vrije dag. Klik om er weer een werkdag van te maken' : 'Vrije dag: geen werktijd, en Vul mijn week slaat hem over'}
      onClick={() => { void toggleDayOff(key); }}
    ><Palmtree size={12} aria-hidden="true"/></button>;
  };
  /** "Vrije dag", met wat er tóch staat erachter: dat werk moet een andere dag. */
  const dayOffLabel = (fig: { meetings: number; tasks: number; spread: boolean }) => {
    const total = fig.meetings + fig.tasks;
    return <span className="wp-day-offlabel">
      Vrije dag{total > 0 && <b className="is-warn"> · {fig.spread ? '±' : ''}{formatDuration(total)}</b>}
    </span>;
  };

  const dayHeaderExtra = (day: Date) => {
    const key = formatISODate(day);
    const bucket = byDay.get(key) ?? EMPTY_BUCKET;
    const fig = dayFigures(key);
    const total = fig.meetings + fig.tasks;
    const agendaShare = Math.min(100, (fig.meetings / fig.scale) * 100);
    const taskShare = Math.min(100 - agendaShare, (fig.tasks / fig.scale) * 100);
    return <>
      {/* "5u 30m netto · 1u 30m vrij": wat er na je afspraken overblijft voor
          taken, en wat daarvan nog over is. Eerder stond hier het totaal van
          afspraken plus taken, zonder maat ernaast. */}
      <div className="wp-dh-stats" title={fig.net ? netDayTitle(fig.net, fig.spread) : undefined}>
        {bucket.count > 0 && <span className="wp-day-count">{bucket.count}</span>}
        {fig.net?.dayOff
          ? dayOffLabel(fig)
          : fig.net?.counts
          ? <>
            <span className="wp-day-net"><b>{formatDuration(fig.net.netMinutes)}</b><span className="wp-day-net-word"> netto</span></span>
            <span className={`wp-day-room${fig.net.freeMinutes! < 0 ? ' is-over' : ''}`}>{roomLabel(fig.net.freeMinutes!, fig.spread)}</span>
          </>
          : <span className={`wp-day-total${total > 0 ? '' : ' is-empty'}`}>{total > 0 ? `${fig.spread ? '±' : ''}${formatDuration(total)}` : '—'}</span>}
        {dayOffButton(day)}
        {canWrite && <button
          type="button"
          className="wp-day-add"
          onClick={() => openDraft(day, 18, 19)}
          aria-label={`Taak toevoegen op ${DAY_FULL_NL[(day.getDay() + 6) % 7]} ${day.getDate()}`}
          title="Taak toevoegen op deze dag — om negen uur, daarna te verschuiven"
        ><Plus size={12}/></button>}
      </div>
      <div className="wp-day-load" role="img" aria-label={fig.net ? netDayTitle(fig.net, fig.spread) : `${formatDuration(fig.tasks)} taken`}>
        <span className="wp-day-load-agenda" style={{ width: `${agendaShare}%` }}/>
        <span className={`wp-day-load-fill${fig.net && fig.net.freeMinutes !== null && fig.net.freeMinutes < 0 ? ' is-over' : ''}`} style={{ width: `${taskShare}%` }}/>
      </div>
    </>;
  };

  /** De blokken die er nog niet zijn: de sleep boven het rooster, en het voorstel. */
  const previewBlocks: PreviewBlock[] = [];
  if (drag?.moved && drag.target?.type === 'time' && draggedTask) {
    const links = taskLinks(draggedTask);
    const minutes = taskBlockMinutes(draggedTask);
    previewBlocks.push({
      key: 'drag', dayIndex: drag.target.dayIndex, startMin: drag.target.startMinute, endMin: drag.target.startMinute + minutes,
      title: draggedTask.title, color: links.color, meta: links.projectName, kind: 'task', className: 'is-drag',
    });
  }
  if (proposal) {
    for (const item of proposal.items) {
      const task = tasksById.get(item.taskId);
      const dayIndex = gridDayKeys.indexOf(item.dayKey);
      if (!task || dayIndex < 0) continue;
      const links = taskLinks(task);
      previewBlocks.push({
        key: `proposal-${item.taskId}`, dayIndex, startMin: item.startMinute, endMin: item.startMinute + item.minutes,
        title: task.title, color: links.color, meta: links.projectName, kind: 'task', className: 'is-proposal',
      });
    }
  }

  /** Een blok aan de randen oprekken: de duur ís de schatting. */
  async function resizeBlock(task: Task, dayKey: string, startMin: number, endMin: number) {
    setError(null);
    const undoSteps = captureUndo([task.id]);
    const minutes = Math.max(15, endMin - startMin);
    try {
      await onPlanTaskTime(task.id, dayKey, startMin, minutes);
      offerUndo({ label: `${task.title}: ${clockLabel(startMin)}–${clockLabel(startMin + minutes)} op ${formatDayShort(dayKey)}`, steps: undoSteps });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Blok aanpassen mislukt');
    }
  }

  /** Welk stuk van deze dag houdt een afspraak bezet? Geknipt op de dag. */
  function eventBusyOnDay(event: CalendarExternalEvent, dayKey: string): BusySlot | null {
    const day = parseISODate(dayKey);
    const dayStart = day.getTime();
    const dayEnd = addDays(day, 1).getTime();
    const start = Math.max(new Date(event.starts_at).getTime(), dayStart);
    const end = Math.min(new Date(event.ends_at).getTime(), dayEnd);
    if (!(end > start)) return null;
    return { start: Math.round((start - dayStart) / 60000), end: Math.round((end - dayStart) / 60000) };
  }

  /**
   * "Vul mijn week": zet werk zonder tijd in de vrije gaten van je werkdag, om
   * je afspraken en bestaande blokken heen — als voorstel. De blokken staan er
   * gestippeld bij tot je "Zo inplannen" klikt; sluiten doet niets.
   *
   * De grens per dag is je netto tijd: werktijd min afspraken min wat er al
   * staat. Wat daar niet in past, blijft liggen en dat zegt het voorstel ook.
   */
  function proposeWeek() {
    // Kandidaten: de werkvoorraad plus wat deze week wel een dag maar nog geen
    // tijd heeft. Weekstroken blijven staan: die zijn bewust geen blok.
    const candidates = sortForAutoPlan([
      ...unscheduled,
      ...Array.from(byDay.values()).flatMap(bucket => bucket.tasks).filter(task => !hasPlannedTime(task)),
    ].filter(task => task.status !== 'done'));
    const candidateIds = new Set(candidates.map(task => task.id));
    // Wat al vastligt: al je open werk dat geen kandidaat is, ook wat zoeken of
    // een filter nu verbergt, en het deel van de weekstroken op die dag. Eerder
    // telden alleen de blokken in beeld; een weekstrook van twintig uur nam
    // geen minuut in en het voorstel zette er een volle week overheen.
    const fixed = myOpenTasks.filter(task => !candidateIds.has(task.id));
    const fixedLoad = taskLoadByDay(orderedDayKeys, fixed, workday, linksFor, daysOff);
    const busy = new Map<string, BusySlot[]>();
    const used = new Map<string, number>();
    for (const key of orderedDayKeys) {
      const slots: BusySlot[] = [];
      for (const event of agendaByDay.get(key)?.items ?? []) {
        const slot = eventBusyOnDay(event, key);
        if (slot) slots.push(slot);
      }
      for (const task of fixed) {
        if (task.planned_date !== key || !hasPlannedTime(task)) continue;
        const start = Number(task.planned_start_minute);
        slots.push({ start, end: start + taskBlockMinutes(task) });
      }
      busy.set(key, slots);
      // Afspraken tellen hun bezette tijd één keer, ook als ze overlappen.
      const load = fixedLoad.get(key);
      used.set(key, (agendaByDay.get(key)?.minutes ?? 0) + (load?.minutes ?? 0) + (load?.spanMinutes ?? 0));
    }
    // Het weekend telt mee als je werktijd dat zegt én het in beeld staat: een
    // voorstel op een dag die je niet ziet, kun je niet beoordelen.
    const includeWeekend = workday.includeWeekend && (showWeekend || isNarrow);
    // Je vrije dagen slaat het voorstel altijd over.
    const skipDays = new Set([
      ...days.filter(day => !includeWeekend && (day.getDay() === 0 || day.getDay() === 6)).map(formatISODate),
      ...orderedDayKeys.filter(key => daysOff.has(key)),
    ]);
    const now = new Date();
    const { proposals, unplaced } = proposeTimeBlocks({
      dayKeys: orderedDayKeys, busy, candidates, todayKey,
      nowMinute: now.getHours() * 60 + now.getMinutes(),
      workStart: AUTO_PLAN_START_MINUTE, workEnd: autoPlanWindowEnd(workday, AUTO_PLAN_START_MINUTE),
      skipDays, dailyCap: workday.minutes, usedMinutes: used,
    });
    const remaining = orderedDayKeys.filter(key => key >= todayKey);
    setDraft(null);
    setProposal({
      items: proposals,
      unplaced: unplaced.length,
      skippedWeekend: skipDays.size > 0 && unplaced.length > 0,
      candidates: candidates.length,
      pastWeek: remaining.length === 0,
      // Zondagmiddag op "Vul mijn week" drukken: er is nog wel een dag, maar
      // die telt niet mee. Dat verdient een ander antwoord dan "geen gat".
      weekendOnly: remaining.length > 0 && remaining.every(key => skipDays.has(key)),
    });
  }

  async function applyProposal() {
    if (!proposal || proposalBusy || proposal.items.length === 0) return;
    setProposalBusy(true);
    setError(null);
    const undoSteps = captureUndo(proposal.items.map(item => item.taskId));
    try {
      for (const item of proposal.items) {
        const task = tasksById.get(item.taskId);
        // Alleen een taak zónder schatting krijgt de voorgestelde duur als schatting.
        await onPlanTaskTime(item.taskId, item.dayKey, item.startMinute, task && hasEstimate(task) ? undefined : item.minutes);
      }
      offerUndo({ label: `${proposal.items.length} ${proposal.items.length === 1 ? 'taak' : 'taken'} ingedeeld via "Vul mijn week"`, steps: undoSteps });
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inplannen mislukt');
    } finally {
      setProposalBusy(false);
    }
  }

  const proposalMinutes = proposal ? proposal.items.reduce((sum, item) => sum + item.minutes, 0) : 0;
  const proposalText = !proposal ? '' : proposal.items.length > 0
    ? `Voorstel: ${proposal.items.length} ${proposal.items.length === 1 ? 'taak' : 'taken'} · ${formatDuration(proposalMinutes)}${proposal.unplaced > 0 ? ` · ${proposal.unplaced} ${proposal.unplaced === 1 ? 'past' : 'passen'} niet meer in je netto tijd` : ''}${proposal.skippedWeekend ? ' · weekend overgeslagen' : ''}`
    : proposal.candidates === 0
      ? 'Alles wat open staat heeft al een tijd.'
      : proposal.pastWeek
        ? 'Deze week is voorbij — blader naar een week die nog komt.'
        : proposal.weekendOnly
          ? 'Alleen het weekend is nog over, en dat telt niet mee. Blader naar volgende week, of zet onder Weergave het weekend aan (7 dagen, en "weekend telt ook mee" bij je werktijd).'
          : `Geen plek voor ${proposal.candidates} ${proposal.candidates === 1 ? 'taak' : 'taken'}: je netto tijd is op. Je werktijd (${formatDuration(workday.minutes)} per dag, tussen ${clockLabel(AUTO_PLAN_START_MINUTE)} en ${clockLabel(autoPlanWindowEnd(workday, AUTO_PLAN_START_MINUTE))}) zit vol met afspraken en werk dat al staat.`;

  // ── De kop ────────────────────────────────────────────────────────────
  const weekNumber = isoWeekNumber(anchor);
  const rangeLabel = weekRangeLabel(anchor);
  /** De weekbalk. In "Mijn week" is hij je werktijd van de week; in het team de
   *  taken in beeld, zonder maat. */
  const meter = scope === 'mine'
    ? weekMeter(net.meetingMinutes, net.taskMinutes, net.workMinutes)
    : weekMeter(0, teamWeekMinutes, null);
  /** De som van de week, voluit: voor de tooltip en de schermlezer. */
  const netWeekTitle = `Werktijd ${formatDuration(net.workMinutes)} (${formatDuration(workday.minutes)} × ${net.workdays} ${net.workdays === 1 ? 'werkdag' : 'werkdagen'}${workday.isDefault ? ', de standaard' : ''}${net.daysOff > 0 ? `; ${net.daysOff === 1 ? '1 vrije dag' : `${net.daysOff} vrije dagen`}` : ''}) − afspraken ${formatDuration(net.meetingMinutes)} = ${formatDuration(net.netMinutes)} netto voor taken. Ingepland ${formatDuration(net.taskMinutes)}, dus ${roomLabel(net.freeMinutes)}.${net.offDayMinutes > 0 ? ` Daarnaast ${formatDuration(net.offDayMinutes)} op dagen die niet meetellen.` : ''}`;
  const showCarryOver = canWrite && overdueTasks.length > 0 && !carryOverDismissed.includes(formatISODate(anchor));
  const hasNudges = showCarryOver || unplannedDeadlines.length > 0 || hiddenWeekend > 0;

  async function carryOver(taskIds: UUID[], toDate: string) {
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
  }

  return <div className={`week-planner density-${density} is-view-${view}${gridView ? ' is-grid' : ''}`} ref={rootRef} onKeyDown={handleRootKey}>
    {/*
      De kop van de planner. Was het gedeelde zoek- en filterblok met zeven
      losse knoppen van gelijk gewicht; op een laptop viel de zoekregel daarbij
      búiten de kaart (overflow: hidden op een vaste hoogte), zodat zoeken en
      filteren in de planner op desktop gewoon niet kon. En de telling zei
      altijd "2 filters actief", omdat "Alle prioriteiten" en "Open taken" als
      filter telden.

      Nu: links de week zelf (bladeren, en een weekkiezer achter het
      weeknummer), rechts de weergave en het gereedschap, en daaronder één
      regel met hoe vol de week is en wat er om aandacht vraagt.
    */}
    <header className="wp-hero" aria-label="Weekplanner">
      <div className="wp-hero-main">
        <div className="wp-when">
          <button type="button" className="wp-navbtn" onClick={() => setAnchor(prev => addDays(prev, -7))} aria-label="Vorige week" title="Vorige week (shift + pijl links)"><ChevronLeft size={17}/></button>
          <PlannerPopover
            triggerClassName="wp-weekbtn"
            triggerLabel={`Week ${weekNumber}, ${rangeLabel}. Andere week kiezen`}
            title="Andere week kiezen"
            align="start"
            panelClassName="wp-weekpick-pop"
            trigger={<>
              <span className={`wp-week-eyebrow${isCurrentWeek ? ' is-now' : ''}`}>{relativeWeekLabel(anchor, todayLocal)}</span>
              <span className="wp-week-title">Week {weekNumber}<ChevronDown size={16} aria-hidden="true"/></span>
              <span className="wp-week-range">{rangeLabel}</span>
            </>}
          >{close => <WeekPicker anchor={anchor} today={todayLocal} onPick={monday => { setAnchor(startOfWeek(monday)); close(); }}/>}</PlannerPopover>
          <button type="button" className="wp-navbtn" onClick={() => setAnchor(prev => addDays(prev, 7))} aria-label="Volgende week" title="Volgende week (shift + pijl rechts)"><ChevronRight size={17}/></button>
          <button type="button" className={`wp-todaybtn${isCurrentWeek ? ' is-current' : ''}`} onClick={goToToday} title={isCurrentWeek ? 'Naar nu in het rooster (T)' : 'Terug naar deze week (T)'}>Vandaag</button>
        </div>

        <div className="wp-hero-tools">
          <Segmented<PlannerView>
            className="wp-viewseg"
            label="Weergave"
            value={view}
            onChange={changeView}
            options={[
              { value: 'grid', label: <><CalendarDays size={14} aria-hidden="true"/><span>Rooster</span></>, title: 'Je week als tijdrooster, met je afspraken erin' },
              { value: 'stack', label: <><ListTodo size={14} aria-hidden="true"/><span>Lijst</span></>, title: 'Je dagen onder elkaar, open en dicht te klappen', hidden: isNarrow },
              { value: 'team', label: <><Users size={14} aria-hidden="true"/><span>Team</span></>, title: 'Wie doet wat deze week' },
            ]}
          />

          <label className={`wp-search${filters.query ? ' has-value' : ''}`}>
            <Search size={14} aria-hidden="true"/>
            <input
              value={filters.query}
              onChange={event => updateFilter('query', event.target.value)}
              placeholder="Zoeken"
              title="Zoek op taak, project, klant of tag"
              aria-label="Zoek op taak, project, klant of tag"
              autoComplete="off"
              onKeyDown={event => { if (event.key === 'Escape' && filters.query) { event.preventDefault(); updateFilter('query', ''); } }}
            />
            {filters.query && <button type="button" onClick={() => updateFilter('query', '')} aria-label="Zoekterm wissen"><X size={12}/></button>}
          </label>

          <PlannerPopover
            triggerClassName={`wp-toolbtn${activeFieldCount > 0 ? ' is-on' : ''}`}
            triggerLabel={activeFieldCount > 0 ? `Filters, ${activeFieldCount} actief` : 'Filters'}
            title="Filteren op klant, project, prioriteit en status"
            badge={activeFieldCount}
            panelClassName="wp-filter-pop"
            trigger={<><SlidersHorizontal size={14} aria-hidden="true"/><span className="wp-toolbtn-label">Filters</span></>}
          >{() => <div className="wp-pop-body">
            <div className="wp-pop-title">Filters</div>
            {[
              { key: 'clientId' as const, label: 'Klant', options: [{ value: '', label: 'Alle klanten' }, { value: NO_LINK, label: 'Zonder klant' }, ...data.clients.map(client => ({ value: client.id, label: client.name }))], searchable: data.clients.length > 8 },
              { key: 'projectId' as const, label: 'Project', options: [{ value: '', label: 'Alle projecten' }, { value: NO_LINK, label: 'Zonder project' }, ...projectOptions.map(project => ({ value: project.id, label: project.name }))], searchable: projectOptions.length > 8 },
              { key: 'priority' as const, label: 'Prioriteit', options: [{ value: 'all', label: 'Alle prioriteiten' }, { value: 'high', label: 'Hoog' }, { value: 'med', label: 'Normaal' }, { value: 'low', label: 'Laag' }], searchable: false },
              { key: 'status' as const, label: 'Status', options: [{ value: 'open', label: 'Open taken' }, { value: 'todo', label: 'Te doen' }, { value: 'doing', label: 'Bezig' }, { value: 'review', label: 'Review' }, { value: 'done', label: 'Klaar' }, { value: 'all', label: 'Alle statussen' }], searchable: false },
            ].map(field => <label className="wp-pop-field" key={field.key}>
              <span>{field.label}</span>
              <Select className="form-select" value={filters[field.key]} searchable={field.searchable} onChange={event => updateFilter(field.key, event.target.value as never)}>
                {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </label>)}
            <div className="wp-pop-foot">
              <span className="wp-pop-count">{weekTaskCount + unscheduled.length} van {data.tasks.filter(task => task.status !== 'done').length} open taken in beeld</span>
              {hasActiveFilters && <button type="button" className="wp-pop-reset" onClick={resetFilters}><RotateCcw size={12} aria-hidden="true"/>Wissen</button>}
            </div>
          </div>}</PlannerPopover>

          <PlannerPopover
            triggerClassName="wp-toolbtn is-icon"
            triggerLabel="Weergave-instellingen"
            title="Dagen, kaarten en je werktijd"
            panelClassName="wp-display-pop"
            trigger={<CalendarCog size={15} aria-hidden="true"/>}
          >{() => <div className="wp-pop-body">
            <div className="wp-pop-title">Weergave</div>
            {gridView && !isNarrow && <div className="wp-pop-row">
              <span>Dagen in het rooster</span>
              <Segmented<DayMode>
                label="Dagen in het rooster"
                value={dayMode}
                onChange={setDayMode}
                options={[{ value: 'workweek', label: 'Ma – vr' }, { value: 'week', label: '7 dagen' }]}
              />
            </div>}
            {!gridView && <div className="wp-pop-row">
              <span>Kaarten</span>
              <Segmented<Density>
                label="Hoeveel detail per kaart"
                value={density}
                onChange={setDensity}
                options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Ruim' }]}
              />
            </div>}
            {stacked && <div className="wp-pop-row">
              <span>Dagen in de lijst</span>
              <button type="button" className="wp-pop-btn" onClick={() => setCollapsedDays(allFolded ? [] : [...ALL_DAY_INDEXES])}>
                {allFolded ? <ChevronsUpDown size={13} aria-hidden="true"/> : <ChevronsDownUp size={13} aria-hidden="true"/>}
                {allFolded ? 'Alles uitklappen' : 'Alles inklappen'}
              </button>
            </div>}
            {scope === 'mine' && <CapacityControl capacity={data.plannerCapacity} canWrite={canWrite} onSave={onSaveCapacity}/>}
            {scope === 'mine' && currentUserId && <DaysOffControl
              days={days.filter(day => isWorkday(formatISODate(day), workday) || daysOff.has(formatISODate(day)))}
              daysOff={daysOff}
              canWrite={canWrite}
              onToggle={key => { void toggleDayOff(key); }}
            />}
            {gridView && <p className="wp-pop-hint">Zoomen in het rooster: Ctrl + scrollen, of knijpen op een touchscreen.</p>}
          </div>}</PlannerPopover>

          {gridView && canWrite && <button
            type="button"
            className={`wp-autoplan${proposal ? ' is-on' : ''}`}
            onClick={proposeWeek}
            disabled={proposalBusy}
            title="Zet werk zonder tijd in de vrije gaten van deze week — als voorstel; jij zegt ja"
          >
            <Wand2 size={14} aria-hidden="true"/>
            <span>Vul mijn week</span>
          </button>}
        </div>
      </div>

      {/* Hoe vol is de week, en wat vraagt om aandacht. De balk is je werktijd
          van de week en meteen de legenda van het rooster: violet zijn je
          afspraken, goud je eigen werk, en wat leeg blijft is vrij. Daarnaast
          de som: afspraken gaan van je werktijd af, wat overblijft is netto, en
          daar moeten je taken in passen. */}
      <div className="wp-pulse" title={scope === 'mine' ? netWeekTitle : undefined}>
        <div className="wp-meter" role="img" aria-label={scope === 'mine' ? netWeekTitle : `${formatDuration(teamWeekMinutes)} taken van het team`}>
          <span className="wp-meter-agenda" style={{ width: `${meter.agendaPct}%` }}/>
          <span className={`wp-meter-tasks${meter.overMinutes > 0 ? ' is-over' : ''}`} style={{ width: `${meter.taskPct}%` }}/>
        </div>
        {scope === 'mine' ? <div className="wp-pulse-stats">
          <span className="wp-stat is-agenda"><i aria-hidden="true"/><b>{formatDuration(net.meetingMinutes)}</b> afspraken</span>
          <span className="wp-stat is-net"><b>{formatDuration(net.netMinutes)}</b> netto <span className="wp-stat-of">van {formatDuration(net.workMinutes)}</span></span>
          <span className="wp-stat is-tasks"><i aria-hidden="true"/><b>{formatDuration(net.taskMinutes)}</b> {myWeek.count === 1 ? 'taak' : `in ${myWeek.count} taken`}</span>
          {net.freeMinutes >= 0
            ? <span className="wp-stat is-free"><i aria-hidden="true"/><b>{formatDuration(net.freeMinutes)}</b> vrij</span>
            : <span className="wp-stat is-over"><b>{formatDuration(-net.freeMinutes)}</b> te veel</span>}
          {myWeek.noEstimate > 0 && <span className="wp-stat is-minor is-warn">{myWeek.noEstimate === 1 ? '1 taak zonder schatting' : `${myWeek.noEstimate} zonder schatting`}</span>}
          {net.daysOff > 0 && <span className="wp-stat is-dayoff"><Palmtree size={12} aria-hidden="true"/>{net.daysOff === 1 ? '1 vrije dag' : `${net.daysOff} vrije dagen`}</span>}
          {net.offDayMinutes > 0 && <span className="wp-stat is-minor">+{formatDuration(net.offDayMinutes)} {net.daysOff > 0 ? 'buiten je werkdagen' : 'in het weekend'}</span>}
        </div> : <div className="wp-pulse-stats">
          {/* Het team heeft geen gezamenlijke werktijd en jouw afspraken horen
              hier niet: alleen de taken in beeld. */}
          <span className="wp-stat is-tasks"><i aria-hidden="true"/><b>{formatDuration(teamWeekMinutes)}</b> {weekTaskCount === 1 ? 'taak' : `in ${weekTaskCount} taken`}</span>
          {weekBucket.noEstimateCount > 0 && <span className="wp-stat is-minor is-warn">{weekBucket.noEstimateCount === 1 ? '1 taak zonder schatting' : `${weekBucket.noEstimateCount} zonder schatting`}</span>}
        </div>}

        {hasNudges && <div className="wp-nudges">
          {hiddenWeekend > 0 && <button type="button" className="wp-nudge" onClick={() => setDayMode('week')} title="Zaterdag en zondag in het rooster zetten">
            <CalendarDays size={13} aria-hidden="true"/>
            <span>{hiddenWeekend === 1 ? '1 item' : `${hiddenWeekend} items`} in het weekend</span>
            <b>Tonen</b>
          </button>}
          {unplannedDeadlines.length > 0 && <button
            type="button"
            className="wp-nudge is-deadline"
            onClick={() => { setTrayTab('deadline'); setBacklogOpen(true); }}
            title="Open de deadlines in de werkvoorraad"
          >
            <Flag size={13} aria-hidden="true"/>
            <span>{unplannedDeadlines.length === 1 ? '1 deadline deze week zonder plek' : `${unplannedDeadlines.length} deadlines deze week zonder plek`}</span>
            <b>Bekijk</b>
          </button>}
          {showCarryOver && <CarryOverNudge
            tasks={overdueTasks}
            busy={carryOverBusy}
            todayKey={todayKey}
            taskLinks={taskLinks}
            onDismiss={() => setCarryOverDismissed(prev => [...prev, formatISODate(anchor)])}
            onCarryOver={carryOver}
          />}
        </div>}
      </div>
    </header>

    {!canWrite && <div className="readonly-note">Je hebt alleen-lezen toegang. Taken openen kan, maar slepen en plannen is uitgeschakeld.</div>}
    {error && <div className="error wp-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="Melding sluiten"><X size={12}/></button></div>}

    <div className={`wp-board is-view-${view}${gridView ? ' is-grid' : ''}`}>
      {/* De werkvoorraad staat links: je pakt er een taak uit en zet hem rechts
          op een tijd. Op volle hoogte, met zijn eigen scrollvak — de lade van
          268 bij 340 pixels was te klein om je werk in te overzien. */}
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
        tab={trayTab}
        onTabChange={setTrayTab}
        hint={gridView
          ? 'Sleep een taak naar een dag of tijd. Een nieuwe taak? Teken een vak in het rooster.'
          : view === 'team'
            ? 'Sleep een taak naar een dag in de rij van wie hem gaat doen.'
            : 'Sleep een taak naar een dag. Een nieuwe taak? Het plusje naast elke dag.'}
        open={backlogOpen}
        onToggleOpen={() => setBacklogOpen(open => !open)}
        onAddNote={onAddNote}
        onToggleNote={onToggleNote}
        onRemoveNote={onRemoveNote}
      />
      <div className="wp-board-main">
        {/*
          Eén raster voor de hele week: dagkoppen bovenin, dan de rijen met
          weekstroken, dan de dagkolommen. De stroken krijgen een kolombereik en
          lopen daardoor dwars over de dagen heen in plaats van in een losse
          balk erboven. De stroken staan bewust vooraan in de DOM: op een smal
          scherm — waar het raster een kolom wordt — komen ze dan bovenaan.
        */}
        {/* Ook in de teamweergave: op een telefoon zag je daar zeven dagvakken
            per persoon onder elkaar, zonder te zeggen welke dag welk vak was. */}
        {isNarrow && <div className="wp-daystrip" role="tablist" aria-label="Dag kiezen">
          {days.map(day => {
            const key = formatISODate(day);
            const fig = dayFigures(key);
            const total = fig.meetings + fig.tasks;
            const isDropHere = drag?.moved === true && drag.target?.type === 'day' && drag.target.date === key;
            return <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === mobileDay}
              className={`wp-daystrip-day ${key === mobileDay ? 'is-on' : ''} ${isSameDay(day, todayLocal) ? 'is-today' : ''} ${isDropHere ? 'is-drop' : ''} ${fig.net?.freeMinutes != null && fig.net.freeMinutes < 0 ? 'is-over' : ''} ${fig.net?.dayOff ? 'is-off' : ''}`}
              title={fig.net ? netDayTitle(fig.net, fig.spread) : undefined}
              ref={el => registerZone(`${STRIP_PREFIX}${key}`, el)}
              onClick={() => setMobileDay(key)}
            >
              <span className="wp-daystrip-name">{DAY_NAMES_NL[day.getDay() === 0 ? 6 : day.getDay() - 1]}</span>
              <span className="wp-daystrip-num">{day.getDate()}</span>
              <span className={`wp-daystrip-dot ${total > 0 ? 'is-busy' : ''}`} style={{ opacity: total > 0 ? Math.min(1, 0.35 + total / fig.scale) : 0 }}/>
            </button>;
          })}
        </div>}

        {/*
          Het rooster: hetzelfde tijdrooster als de agenda, met twee talen erin.
          Een afspraak is een vol gevuld blok in de kleur van zijn agenda — vast,
          met anderen. Een taak is een omlijnd, licht getint blok in de kleur van
          zijn project, met een vinkje — van jou, en te verschuiven. Werk dat wel
          een dag maar nog geen tijd heeft staat als kaart in de dagband boven de
          kolom; sleep het naar beneden en het wordt een blok.

          `calendar-agenda-page` haalt de Google-look van de agenda binnen (dezelfde
          truc als de Boekingslinks-pagina); `.wp-rooster` zet daar de planner-
          maten op: een hogere dagkop met de drukte-balk, en de dagband op "Dag".
        */}
        {gridView && <div className="wp-rooster calendar-agenda-page">
          {/* De legenda-strook is weg: de weekbalk in de kop is de legenda
              (violet afspraken, goud je werk), en wat je hier kunt staat in de
              werkvoorraad. Dat scheelde een regel boven elk uur in het rooster. */}
          <TimeBlockGrid
            ref={gridRef}
            days={gridDays}
            events={myEvents}
            tasks={gridTasks}
            sourceColors={sourceColors}
            trackedMinutesFor={trackedMinutesFor}
            linkedTaskFor={linkedTaskFor}
            canWrite={canWrite}
            writeableSources={[]}
            allowSelect={canWrite}
            readOnlyEvents
            taskBand="planned"
            bandLabel="Dag"
            taskColorFor={task => taskLinks(task).color}
            taskMetaFor={task => { const links = taskLinks(task); return [links.projectName, links.clientName].filter(Boolean).join(' · ') || null; }}
            onSelectSlot={openDraft}
            onEditTask={onEditTask}
            onOpenEvent={event => onOpenCalendar(localDayKey(event.starts_at))}
            onMoveEvent={() => { /* afspraken verzet je in de agenda zelf */ }}
            onMoveTask={(task, dayKey, startMin, endMin) => { void resizeBlock(task, dayKey, startMin, endMin); }}
            onTaskBlockPointerDown={canWrite ? ((event, task) => beginCardPointer(event, task)) : undefined}
            onTaskMenu={openMenu}
            onToggleTaskDone={task => { void onSetTaskStatus(task, task.status === 'done' ? 'todo' : 'done'); }}
            renderTaskBar={bandChip}
            renderDayHeader={dayHeaderExtra}
            dayClassName={day => (myDaysOff?.has(formatISODate(day)) ? 'wp-col-off' : undefined)}
            previewBlocks={previewBlocks}
            draft={gridDraft}
            ghostTaskId={drag?.moved ? drag.taskId : null}
            zoom={gridZoom}
            onZoomChange={applyGridZoom}
            autoScrollKey={gridScrollKey}
          />
        </div>}

        {/*
          Dagen onder elkaar, elk open en dicht te klappen.

          Zeven kolommen naast elkaar geven per dag ~200px: genoeg voor een titel
          van drie woorden en verder niets, en een dag met acht taken verdwijnt in
          zijn eigen scrollvak. Onder elkaar krijgt een taak de volle breedte, en
          wat je nu niet nodig hebt klap je dicht — dichtgeklapt is de hele week
          zeven koppen op één scherm, mét de drukte-balk, je netto tijd en wat vrij is.

          De dichtgeklapte kop blijft een dropzone. Hij meldt zich aan onder
          dezelfde `strip:`-sleutel als de dagstrook op een telefoon, en die
          betekent al "deze dag, achteraan". Slepen naar een dichte dag werkt dus
          zonder dat hij onder je vinger openspringt.

          Weekstroken staan bovenaan in plaats van dwars over de dagen: zonder
          kolommen is er niets om dwars overheen te lopen. Ze zijn hier dus ook
          niet sleepbaar — precies zoals op een smal scherm.
        */}
        {stacked && <div className="wp-stack">
          {/* Weektaken: werk dat over meerdere dagen loopt, als volwaardige kaart
              in een eigen blok — met vinkje, uren, timer en menu, precies als
              een dagtaak. Was een balkje van 26px met alleen een titel. Een
              kaart in een dag laten vallen maakt er een dagtaak van. */}
          {bars.length > 0 && <section className="wp-weektasks" aria-label="Weektaken">
            <div className="wp-weektasks-head">
              <span className="wp-weektasks-title">Weektaken</span>
              <span className="wp-day-count">{bars.length}</span>
              <span className="wp-weektasks-sub">
                {spanningMinutes > 0 ? `±${formatDuration(spanningMinutes)} verdeeld over de dagen` : 'werk dat over meerdere dagen loopt'}
              </span>
              {canWrite && <span className="wp-weektasks-hint">Sleep een kaart in een dag om er een dagtaak van te maken</span>}
            </div>
            <div className="wp-weektasks-body">
              {bars.map(bar => taskCard(bar.task, {
                bar,
                className: `wp-task-week ${bar.continuesLeft ? 'continues-left' : ''} ${bar.continuesRight ? 'continues-right' : ''}`,
              }))}
            </div>
          </section>}

          {days.map((day, i) => {
            const key = formatISODate(day);
            const bucket = byDay.get(key) ?? EMPTY_BUCKET;
            const agenda = agendaByDay.get(key);
            const isToday = isSameDay(day, todayLocal);
            const marker = insertMarkerFor(key);
            const fig = dayFigures(key);
            const folded = collapsedDays.includes(i);
            const state = `${isToday ? 'is-today ' : ''}${marker !== null ? 'is-drop ' : ''}${fig.net?.dayOff ? 'is-off' : ''}`;
            // Zeven <section>-landmarks in één scherm maakt de landmarkslijst
            // onbruikbaar; dit is een uitklapper, geen sectie. De knop noemt de dag
            // en wijst met aria-controls naar het vak dat hij opent.
            const bodyId = `wp-day-${key}`;
            return <div
              className={`wp-stack-day ${folded ? 'is-folded' : 'is-open'} ${state}`}
              key={key}
            >
              {/* Dichtgeklapt is de kop zélf de dropzone; open neemt het vak
                  eronder het over. Twee sleutels, dus ze kunnen elkaar niet
                  wegpoetsen als React de refs opnieuw zet. */}
              <div
                className="wp-stack-head"
                ref={folded ? (el => registerZone(`${STRIP_PREFIX}${key}`, el)) : undefined}
              >
                <button
                  type="button"
                  className="wp-stack-toggle"
                  aria-expanded={!folded}
                  aria-controls={bodyId}
                  onClick={() => toggleDayFold(i)}
                  title={folded ? 'Uitklappen' : 'Inklappen'}
                >
                  <ChevronDown size={15} className="wp-stack-caret" aria-hidden="true"/>
                  <span className="wp-stack-name">{DAY_FULL_NL[i]}</span>
                  <span className="wp-stack-num">{day.getDate()}</span>
                  {isToday && <span className="wp-stack-today">vandaag</span>}
                </button>

                {/* Aantal, netto tijd en wat ervan vrij is. Het aantal blijft:
                    acht taken zonder schatting leest anders als een lege dag. De
                    ± staat er zodra een weekstrook meetelt — dat deel is een
                    verdeling over zijn dagen, geen gemeten tijd. */}
                {bucket.count > 0 && <span className="wp-day-count">{bucket.count}</span>}
                {fig.net?.dayOff
                  ? dayOffLabel(fig)
                  : fig.net?.counts
                  ? <span className="wp-day-net" title={netDayTitle(fig.net, fig.spread)}><b>{formatDuration(fig.net.netMinutes)}</b> netto</span>
                  : fig.meetings + fig.tasks > 0 && <span className="wp-day-total" title={fig.net ? netDayTitle(fig.net, fig.spread) : undefined}>{fig.spread ? '±' : ''}{formatDuration(fig.meetings + fig.tasks)}</span>}

                <div
                  className="wp-day-load"
                  role="img"
                  aria-label={fig.net ? netDayTitle(fig.net, fig.spread) : `${formatDuration(fig.tasks)} taken`}
                >
                  <span className="wp-day-load-agenda" style={{ width: `${Math.min(100, (fig.meetings / fig.scale) * 100)}%` }}/>
                  <span className={`wp-day-load-fill${fig.net?.freeMinutes != null && fig.net.freeMinutes < 0 ? ' is-over' : ''}`} style={{ width: `${Math.min(100, (fig.tasks / fig.scale) * 100)}%` }}/>
                </div>

                {fig.net?.counts && <div className={`wp-day-room ${fig.net.freeMinutes! < 0 ? 'is-over' : ''}`}>
                  {roomLabel(fig.net.freeMinutes!, fig.spread)}
                </div>}

                {dayOffButton(day)}
                {canWrite && <button
                  type="button"
                  className="wp-day-add"
                  onClick={() => {
                    // Op een dichte dag typen kan niet: het invoerveld zit in het
                    // vak eronder. Het plusje klapt hem daarom eerst open.
                    if (folded) setCollapsedDays(prev => prev.filter(index => index !== i));
                    setQuickAddDay(prev => (!folded && prev === key) ? null : key);
                  }}
                  aria-expanded={quickAddDay === key}
                  aria-label={`Taak toevoegen op ${DAY_FULL_NL[i]} ${day.getDate()}`}
                  title={`Taak toevoegen op ${DAY_FULL_NL[i]} ${day.getDate()}`}
                >
                  <Plus size={13}/>
                </button>}
              </div>

              {/* Hele-dag-afspraken kosten geen minuten maar maken je dag wél vol.
                  Ze blijven daarom ook staan als de dag dicht is: een shootdag mag
                  niet als een lege dag lezen. */}
              {!!agenda?.allDay.length && <div className="wp-stack-allday">
                {agenda.allDay.map(event => <span key={`${event.source_id}-${event.provider_event_id}`} className="wp-allday-chip" title={event.title}>
                  {event.title}
                </span>)}
              </div>}

              {!folded && <div className="wp-stack-body" id={bodyId} ref={el => registerZone(key, el)}>
                {!!agenda?.items.length && <div
                  className="wp-day-pane wp-day-agenda"
                  role="group"
                  aria-label={`Afspraken op ${DAY_FULL_NL[i]} ${day.getDate()}`}
                >
                  {agenda.items.map(event => agendaChip(event, key))}
                </div>}
                {quickAddDay === key && <QuickAddTask
                  busy={quickAddBusy}
                  weekHint={`van ${formatDateShort(key)} tot en met ${formatDateShort(weekStripEnd(key, orderedDayKeys[6]))}`}
                  onSubmit={(title, mode) => quickAdd(key, title, mode === 'week' ? weekStripEnd(key, orderedDayKeys[6]) : undefined)}
                  onCancel={() => setQuickAddDay(null)}
                />}
                <DayTasksPane
                  label={`Taken op ${DAY_FULL_NL[i]} ${day.getDate()}`}
                  count={bucket.tasks.length}
                >
                  {bucket.tasks.map(task => taskCard(task, { insertBefore: marker }))}
                  {marker === '__end__' && <div className="wp-insert-line" aria-hidden="true"/>}
                </DayTasksPane>
                {bucket.noEstimateCount > 0 && <div className="wp-day-noestimate">
                  {bucket.noEstimateCount === 1 ? '1 taak zonder schatting' : `${bucket.noEstimateCount} taken zonder schatting`}
                </div>}
              </div>}
            </div>;
          })}
        </div>}

        {/* De kolomkop met weekstroken is alleen nog de kop van de teamweergave;
            voor "Mijn week" is het rooster de kolomweergave. */}
        {scope === 'team' && <div
          className="wp-week"
          ref={bandRef}
          style={{ gridTemplateRows: `auto${laneCount > 0 ? ` repeat(${laneCount}, auto)` : ''}` }}
        >
          {/* Een weektaak ligt dwars over zijn dagen — de breedte zegt wélke —
              maar is nu dezelfde kaart als een dagtaak, met de sleepranden erop.
              Op een smal scherm staan de dagen onder elkaar en is er niets om
              overheen te lopen; daar is de kaart gewoon een kaart. */}
          {bars.map(bar => {
            const dragging = barDrag?.taskId === bar.task.id && barDrag.moved;
            const draggable = canWrite && !isNarrow && !stacked;
            return taskCard(bar.task, {
              bar,
              isDragging: dragging,
              className: `wp-task-bar ${bar.continuesLeft ? 'continues-left' : ''} ${bar.continuesRight ? 'continues-right' : ''} ${draggable ? '' : 'is-static'}`,
              style: { '--bar': taskLinks(bar.task).color, gridColumn: `${bar.startIdx + 1} / span ${bar.span}`, gridRow: bar.lane + 2 } as React.CSSProperties,
              onPointerDown: draggable ? (e => beginBarPointer(e, bar, 'move')) : (() => {}),
              grips: draggable ? <>
                {!bar.continuesLeft && <span
                  className="wp-bar-grip wp-bar-grip-start"
                  onPointerDown={e => beginBarPointer(e, bar, 'resize-start')}
                  title="Sleep om eerder te laten beginnen"
                />}
                {!bar.continuesRight && <span
                  className="wp-bar-grip wp-bar-grip-end"
                  onPointerDown={e => beginBarPointer(e, bar, 'resize-end')}
                  title="Sleep om later te laten eindigen"
                />}
              </> : null,
            });
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
            // De teamcellen eronder zijn de dropzones; de kop licht niet op.
            const marker: string | null = null;
            const fig = dayFigures(key);
            const total = fig.tasks;
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
                  {/* Geen plusje: in de teamweergave hoort een nieuwe taak bij een
                      persoon, en die staat in de rij eronder. */}
                </div>
                {/* De taken van het team, in verhouding tot de drukste dag. Geen
                    afspraken en geen werktijd: die zijn van jou, niet van het
                    team. Eerder stonden jouw meetings hier in de balk en mat de
                    dagkop het werk van het hele team tegen jouw dagstreep. */}
                <div
                  className="wp-day-load"
                  role="img"
                  aria-label={`${formatDuration(fig.tasks)} taken`}
                >
                  <span className="wp-day-load-fill" style={{ width: `${Math.min(100, (fig.tasks / fig.scale) * 100)}%` }}/>
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

            </Fragment>;
          })}
        </div>}

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
                // Op een telefoon één dag per persoon: de dag uit de dagstrip.
                if (isNarrow && key !== mobileDay) return null;
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
          {/* Een blok terug de dagband in: de dag blijft, de tijd gaat eraf. */}
          {hasPlannedTime(task) && <button type="button" role="menuitem" onClick={() => move(task.planned_date!)}>Tijd weghalen, blijft op {formatDayShort(task.planned_date!)}</button>}
          <button type="button" role="menuitem" onClick={() => move(null)}>Naar de werkvoorraad</button>
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
        {/* Afspraak ↔ taak vanuit de kaart: tijd reserveren opent de agenda met
            de taak al ingevuld; koppelen kiest uit de afspraken van deze week,
            de dichtstbijzijnde bij de plandatum eerst. */}
        {(() => {
          const taskEventLinks = linksByTask.get(task.id) ?? [];
          const linkedKeys = new Set(taskEventLinks.map(calendarLinkKey));
          const anchorTime = parseISODate(task.planned_date ?? todayKey).getTime();
          const seen = new Set<string>();
          const candidates = Array.from(agendaByDay.entries())
            .flatMap(([dayKey, agenda]) => agenda.items.map(event => ({ dayKey, event, eventKey: calendarEventKey(event) })))
            .filter(({ event, eventKey }) => {
              if (seen.has(eventKey) || linkedKeys.has(eventKey)) return false;
              seen.add(eventKey);
              return event.visibility === 'organization' && !event.is_private_masked;
            })
            .sort((a, b) =>
              Math.abs(parseISODate(a.dayKey).getTime() - anchorTime) - Math.abs(parseISODate(b.dayKey).getTime() - anchorTime)
              || a.event.starts_at.localeCompare(b.event.starts_at))
            .slice(0, 8);
          return <div className="wp-menu-group">
            <div className="wp-menu-label">Agenda</div>
            <button type="button" role="menuitem" onClick={() => { setMenu(null); onReserveTime(task); }}>Tijd reserveren in agenda…</button>
            {candidates.length > 0 && <button
              type="button"
              role="menuitem"
              aria-expanded={menuAgendaOpen}
              onClick={() => setMenuAgendaOpen(open => !open)}
            >Koppel aan afspraak <span className="wp-menu-hint">{menuAgendaOpen ? '▾' : '▸'}</span></button>}
            {menuAgendaOpen && candidates.map(({ event, eventKey }) => <button
              key={eventKey}
              type="button"
              role="menuitem"
              className="wp-menu-sub"
              onClick={() => { setMenu(null); void linkFromMenu(task, event); }}
            >
              <span className="wp-menu-when">{formatLinkShort({ event_starts_at: event.starts_at, event_ends_at: event.ends_at, event_all_day: event.all_day })}</span>
              <span className="wp-menu-text">{event.title}</span>
            </button>)}
            {taskEventLinks.map(link => <button
              key={link.id}
              type="button"
              role="menuitem"
              onClick={() => { setMenu(null); void unlinkFromMenu(link); }}
            >Ontkoppel van «{link.event_title_snapshot || formatLinkShort(link)}»</button>)}
          </div>;
        })()}
        <div className="wp-menu-group">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); onEditTask(task); }}>Open taak…</button>
        </div>
      </div>;
    })()}

    {/* Het voorstel van "Vul mijn week": de blokken staan gestippeld in het
        rooster, hier staat de samenvatting en de knop die het echt maakt. */}
    {proposal && <div className="wp-proposal" role="status">
      <Wand2 size={14} aria-hidden="true"/>
      <span className="wp-proposal-text">{proposalText}</span>
      {proposal.items.length > 0 && <button type="button" className="wp-undo-btn" disabled={proposalBusy} onClick={() => void applyProposal()}>
        {proposalBusy ? 'Bezig…' : 'Zo inplannen'}
      </button>}
      <button type="button" className="wp-undo-close" aria-label="Voorstel sluiten" onClick={() => setProposal(null)}><X size={12}/></button>
    </div>}

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

    {/* Boven het rooster tekent het voorbeeldblok al waar de taak landt; dan is
        de meereizende kaart alleen maar in de weg. */}
    {drag?.moved && draggedTask && drag.target?.type !== 'time' && <div
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
 * Je werktijd per dag: de maat waar de netto tijd van afgaat. Heette eerst de
 * "dagstreep" en stond standaard uit; dan had de planner geen maat en kon hij
 * nooit zeggen dat iets niet paste, hoeveel meetings er ook in je week stonden.
 * Nu rekent hij zonder instelling met acht uur op werkdagen, en zet je hier je
 * eigen getal.
 *
 * Bewust persoonlijk en niet zichtbaar in de teamweergave: "wiens werktijd?" is
 * daar onbeantwoordbaar. Staat in het paneel Weergave: een eigen knop in de
 * werkbalk was een instelling die zich als handeling voordeed.
 */
function CapacityControl({ capacity, canWrite, onSave }: {
  capacity: PlannerDayCapacity | null;
  canWrite: boolean;
  onSave: (minutes: number, includeWeekend: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const workday = workdayFrom(capacity);
  const [hours, setHours] = useState(() => String((workday.minutes / 60).toFixed(1).replace(/\.0$/, '')));
  const [weekend, setWeekend] = useState(workday.includeWeekend);

  async function save(minutes: number, includeWeekend: boolean) {
    setBusy(true);
    setSaved(false);
    try { await onSave(minutes, includeWeekend); setSaved(true); }
    finally { setBusy(false); }
  }

  return <section className="wp-cap" aria-label="Werktijd">
    <div className="wp-cap-head">
      <span>Werktijd</span>
      <b className={workday.isDefault ? '' : 'is-on'}>{formatDuration(workday.minutes)} per dag{workday.isDefault ? ' · standaard' : ''}</b>
    </div>
    <p className="wp-cap-hint">
      Hoeveel uur werk je op een werkdag? Je afspraken gaan daar vanaf; wat
      overblijft is je netto tijd voor taken. Zonder eigen getal rekent de
      planner met 8 uur, maandag tot en met vrijdag. Alleen voor jou.
    </p>
    <div className="wp-cap-row">
      <input
        className="wp-cap-input"
        type="number"
        min="0"
        max="24"
        step="0.5"
        value={hours}
        disabled={!canWrite}
        aria-label="Uren per werkdag"
        onChange={e => { setHours(e.target.value); setSaved(false); }}
      />
      <span>uur per dag</span>
    </div>
    <label className="wp-cap-weekend">
      <input type="checkbox" checked={weekend} disabled={!canWrite} onChange={e => { setWeekend(e.target.checked); setSaved(false); }}/>
      Weekend telt ook mee
    </label>
    {canWrite && <div className="wp-cap-actions">
      <button
        type="button"
        className="wp-cap-save"
        disabled={busy}
        onClick={() => void save(Math.round(Math.max(0, Math.min(24, Number(hours) || 0)) * 60), weekend)}
      >{busy ? 'Bezig…' : saved ? 'Opgeslagen' : 'Opslaan'}</button>
      {/* 0 minuten betekent "geen eigen getal": dan geldt de standaard weer. */}
      {!workday.isDefault && <button type="button" className="wp-cap-clear" disabled={busy} onClick={() => { setHours('8'); void save(0, weekend); }}>
        Terug naar 8 uur
      </button>}
    </div>}
  </section>;
}

/**
 * Vrije dagen van de week in beeld, als knoppen om aan en uit te zetten. Dezelfde
 * keuze als het palmboompje in elke dagkop, maar hier voor de hele week in één
 * keer: wie een week vakantie heeft, klikt vijf knoppen naast elkaar in plaats
 * van vijf dagkoppen langs.
 */
function DaysOffControl({ days, daysOff, canWrite, onToggle }: {
  days: Date[];
  daysOff: ReadonlySet<string>;
  canWrite: boolean;
  onToggle: (key: string) => void;
}) {
  const count = days.filter(day => daysOff.has(formatISODate(day))).length;
  return <section className="wp-cap wp-daysoff" aria-label="Vrije dagen deze week">
    <div className="wp-cap-head">
      <span>Vrije dagen deze week</span>
      <b className={count > 0 ? 'is-on' : ''}>{count === 0 ? 'geen' : count === 1 ? '1 dag' : `${count} dagen`}</b>
    </div>
    <p className="wp-cap-hint">
      Op een vrije dag heb je geen werktijd: de planner rekent er niet mee, en
      Vul mijn week zet er niets op.
    </p>
    <div className="wp-daysoff-days" role="group" aria-label="Vrije dagen">
      {days.map(day => {
        const key = formatISODate(day);
        const off = daysOff.has(key);
        return <button
          key={key}
          type="button"
          className={`wp-daysoff-day${off ? ' is-on' : ''}`}
          aria-pressed={off}
          aria-label={`${DAY_FULL_NL[(day.getDay() + 6) % 7]} ${day.getDate()}${off ? ', vrije dag' : ''}`}
          disabled={!canWrite}
          onClick={() => onToggle(key)}
        >
          <span>{DAY_NAMES_NL[(day.getDay() + 6) % 7]}</span>
          <b>{day.getDate()}</b>
        </button>;
      })}
    </div>
  </section>;
}

/**
 * Het meeneem-voorstel voor blijven liggen werk. Was een oranje balk over de
 * volle breedte (op de telefoon ruim 300 pixels hoog) die het rooster naar
 * beneden duwde; nu is het een kaartje in de kop met een paneel erachter.
 * Je kiest daar nog steeds wát er meegaat en naar wélke dag, en ziet de
 * uitkomst in de knop staan voordat je hem indrukt.
 */
function CarryOverNudge({ tasks, busy, todayKey, taskLinks, onCarryOver, onDismiss }: {
  tasks: Task[];
  busy: boolean;
  todayKey: string;
  taskLinks: (task: Task) => { projectName: string | null; color: string };
  onCarryOver: (taskIds: UUID[], toDate: string) => Promise<void>;
  onDismiss: () => void;
}) {
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

  return <PlannerPopover
    triggerClassName="wp-nudge is-carry"
    triggerLabel={`${tasks.length === 1 ? '1 taak' : `${tasks.length} taken`} van eerder staan nog open. Meenemen`}
    title="Werk van eerder dat nog open staat"
    panelClassName="wp-carry-pop"
    trigger={<>
      <RotateCcw size={13} aria-hidden="true"/>
      <span>{tasks.length === 1 ? '1 taak van eerder open' : `${tasks.length} taken van eerder open`}</span>
      <b>Meenemen</b>
    </>}
  >{close => <div className="wp-pop-body">
    <div className="wp-pop-title">Nog open van eerder</div>
    <p className="wp-pop-hint">Taken waarvan de plandag voorbij is (of vandaag is) en die nog niet klaar zijn. Er verschuift niets tot je op de knop drukt.</p>
    <div className="wp-pop-row">
      <span>Naar</span>
      <Segmented<typeof target>
        label="Naar welke dag"
        value={target}
        onChange={setTarget}
        options={targets.map(option => ({ value: option.key, label: option.label }))}
      />
    </div>
    <ul className="wp-carry-list">
      {tasks.map(task => {
        const checked = !skipped.includes(task.id);
        const links = taskLinks(task);
        return <li key={task.id}>
          <label>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => setSkipped(prev => checked ? [...prev, task.id] : prev.filter(id => id !== task.id))}
            />
            <i className="wp-carry-dot" style={{ background: links.color }} aria-hidden="true"/>
            <span className="wp-carry-title">{task.title}</span>
            <span className="wp-carry-meta">
              {planLabel(task.planned_date)}
              {hasEstimate(task) ? ` · ${formatDuration(taskEstimateMinutes(task))}` : ''}
            </span>
          </label>
        </li>;
      })}
    </ul>
    <div className="wp-pop-foot">
      <button type="button" className="wp-pop-ghost" onClick={() => { onDismiss(); close(); }}>Laat staan</button>
      <button
        type="button"
        className="wp-pop-primary"
        disabled={busy || chosen.length === 0}
        onClick={() => { void onCarryOver(chosen.map(task => task.id), targetDate.date).then(close); }}
      >
        {busy
          ? 'Bezig…'
          : `Neem ${chosen.length} mee naar ${targetDate.label}${minutes > 0 ? ` (${formatDuration(minutes)})` : ''}`}
      </button>
    </div>
  </div>}</PlannerPopover>;
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
  loggedMinutes,
  isTiming,
  onToggleTimer,
  onOpenTicket,
  agendaLinks = [],
  onOpenAgendaLink,
  period = null,
  className = '',
  style,
  children,
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
  /** Afspraken die bij deze taak horen; één wordt "di 10:00–11:30", meer een teller. */
  agendaLinks?: CalendarEventLink[];
  onOpenAgendaLink?: (link: CalendarEventLink) => void;
  /** Periode-pil van een weektaak ("07 sep – 09 sep · 3 dagen"). */
  period?: string | null;
  className?: string;
  style?: React.CSSProperties;
  /** De sleepranden van een weektaak in de kolomweergave. */
  children?: React.ReactNode;
  onPointerDown: (event: React.PointerEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onOpen: () => void;
  onSetStatus: (task: Task, status: TaskStatus) => void;
  onSetEstimate: (task: Task, minutes: number | null) => void;
  onOpenProject: (projectId: string) => void;
  onMenu: (task: Task, x: number, y: number) => void;
  /** Al geschreven uren op deze taak. Nul zolang er niets op geboekt is. */
  loggedMinutes: number;
  isTiming: boolean;
  onToggleTimer: () => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const plannedAfterDeadline = !!task.end_date && !!task.planned_date && task.planned_date > task.end_date;
  const done = task.status === 'done';
  // In "Ruim" staat de deadline al in de planningsregel, en een deadline vóór
  // de plandag heeft daar zijn eigen rode melding.
  const dueLabel = task.end_date && !done && density === 'compact' && !plannedAfterDeadline ? formatDayShort(task.end_date) : null;
  const dueTone = dueLabel ? deadlineTone(task.end_date!) : null;
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
    className={`wp-task ${className} ${isDragging ? 'is-dragging' : ''} ${isInsertTarget ? 'is-insert-target' : ''} ${done ? 'is-done' : ''}`}
    style={{ '--task-color': color, ...style } as React.CSSProperties}
    data-task-id={task.id}
    tabIndex={0}
    role="group"
    aria-label={`${task.title}${period ? `, ${period}` : ''}${projectName ? `, project ${projectName}` : ''}${done ? ', klaar' : ''}`}
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
      {/* De titel is de knop die de taak opent — voor het toetsenbord en de
          schermlezer. Met de muis of vinger regelt de kaart het zelf: pakken en
          bewegen is slepen, loslaten zonder bewegen opent. Daarom slikt de titel
          de pointerdown níét op (dat maakte ~80% van de kaart onsleepbaar) en
          reageert hij alleen op een klik zonder aanwijzer (detail 0 = Enter). */}
      <button type="button" className="wp-task-title" onClick={event => { if (event.detail === 0) onOpen(); }}>{task.title}</button>
      {/* Twee regels: eerst wáár het bij hoort (project en klant, met de
          projectkleur ervoor), dan de kenmerken die om een beslissing vragen.
          In één regel met flex-wrap brak het stipje los van het project en
          stond het als los bolletje op een eigen regel. */}
      <div className="wp-task-sub">
        <span className="wp-task-where">
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
        </span>
      </div>
      {(period || dueLabel || task.ticket_id || agendaLinks.length > 0) && <div className="wp-task-tags">
        {period && <span className="wp-task-period">{period}</span>}
        {/* De deadline staat op de kaart zelf: in de werkvoorraad is dat de
            reden om iets nú in te plannen, en die stond er alleen in "Ruim". */}
        {dueLabel && <span className={`wp-task-due${dueTone ? ` is-${dueTone}` : ''}`} title={`Deadline ${formatDateShort(task.end_date!)}`}>
          <Flag size={9} aria-hidden="true"/>{dueLabel}
        </span>}
        {/* Werk dat uit een klantvraag komt draagt dat zichtbaar mee. */}
        {task.ticket_id && <button
          type="button"
          className="wp-task-ticket"
          title="Open het ticket waar deze taak uit komt"
          onPointerDown={swallow}
          onClick={() => onOpenTicket(task.ticket_id!)}
        >Ticket</button>}
        {/* De afspraak op de kaart: één klik en je staat in de agenda op die dag. */}
        {agendaLinks.length > 0 && <button
          type="button"
          className="wp-task-agenda"
          title={agendaLinks.map(link => `${formatLinkShort(link)} · ${link.event_title_snapshot ?? 'afspraak'}`).join('\n')}
          onPointerDown={swallow}
          onClick={() => onOpenAgendaLink?.(agendaLinks[0])}
        >
          <CalendarDays size={10} aria-hidden="true"/>
          {agendaLinks.length === 1 ? formatLinkShort(agendaLinks[0]) : `${agendaLinks.length} afspraken`}
        </button>}
      </div>}
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
        {showPlannedDate && task.planned_date && <span>Gepland {formatDateShort(task.planned_date)}{hasPlannedTime(task) ? ` · ${clockLabel(Number(task.planned_start_minute))}` : ''}</span>}
        {density === 'comfortable' && <AssigneeAvatars userIds={assigneeIds} teamMembers={teamMembers} currentUserId={currentUserId} max={4} />}
      </div>}
    </div>

    <div className="wp-task-right">
      {/* Klok starten vanaf de kaart. Project, klant en het declarabel-vinkje
          leidt de app af uit de taak — die wist je toch al. */}
      {canWrite && <button
        type="button"
        className={`wp-task-timer ${isTiming ? 'is-running' : ''}`}
        aria-pressed={isTiming}
        aria-label={isTiming ? `Timer stoppen voor ${task.title}` : `Timer starten voor ${task.title}`}
        title={isTiming ? 'Stop en schrijf de uren weg' : 'Start de timer op deze taak'}
        onPointerDown={swallow}
        onClick={onToggleTimer}
      >{isTiming ? <Square size={10}/> : <Play size={10}/>}</button>}

      <button
        type="button"
        className={`wp-task-est ${hasEstimate(task) ? '' : 'is-unset'}`}
        disabled={!canWrite}
        aria-expanded={estimateOpen}
        aria-label={hasEstimate(task)
          ? `${loggedMinutes > 0 ? `${formatDuration(loggedMinutes)} gewerkt van ` : ''}${formatDuration(taskEstimateMinutes(task))} geschat, klik om te wijzigen`
          : 'Nog geen tijdschatting, klik om in te vullen'}
        onPointerDown={swallow}
        onClick={() => setEstimateOpen(open => !open)}
      >
        {/* Zodra er uren op de taak staan zegt de pil er twee dingen: gewerkt
            van geschat. Dat kon voorheen principieel niet — urenposten kenden
            geen taak. */}
        {loggedMinutes > 0 && <span className="wp-task-done-time">{formatDuration(loggedMinutes)}</span>}
        {loggedMinutes > 0 && hasEstimate(task) && <span className="wp-task-slash">/</span>}
        {hasEstimate(task) ? formatDuration(taskEstimateMinutes(task)) : (loggedMinutes > 0 ? '' : '—')}
      </button>
    </div>

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

    {children}
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
 * De snelinvoer ín een getekend tijdvak van het rooster: titel typen, Enter, en
 * de taak staat als blok op precies die tijd. "Montage 2u" maakt een blok van
 * twee uur, ook als je anderhalf uur tekende — wat je typt wint.
 */
function GridQuickAdd({ busy, startMinute, endMinute, onSubmit, onCancel }: {
  busy: boolean;
  startMinute: number;
  endMinute: number;
  onSubmit: (title: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!busy) inputRef.current?.focus(); }, [busy]);

  async function submit() {
    if (await onSubmit(title)) onCancel();
  }

  return <div className="wp-grid-add" role="group" aria-label="Nieuwe taak op deze tijd">
    <div className="wp-grid-add-when">{clockLabel(startMinute)} – {clockLabel(endMinute)} · {formatDuration(Math.max(15, endMinute - startMinute))}</div>
    <input
      ref={inputRef}
      className="wp-grid-add-input"
      value={title}
      disabled={busy}
      autoFocus
      placeholder="Waar ga je aan werken?"
      aria-label="Titel van de nieuwe taak"
      onChange={e => setTitle(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); void submit(); }
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      }}
      onBlur={() => { if (!title.trim()) onCancel(); }}
    />
    <div className="wp-grid-add-hint">Enter maakt de taak · Esc sluit · "Montage 2u" zet de duur</div>
  </div>;
}

/**
 * De werkvoorraad links: alles wat nog een plek zoekt, plus je actiepunten.
 * Vervangt de drie panelen die eerst onder het raster stonden, elk met hun eigen
 * scrollbalk — en sinds het rooster staat hij op volle hoogte naast de week.
 *
 * De tabbladen heetten "Lade", "Deadline" en "Buiten week". "Lade" was een
 * woord van de bouwers; wat erin ligt is werk dat nog geen dag heeft.
 */
function PlannerTray({
  unscheduled, outsideThisWeek, deadlineThisWeek, renderTask, isDropTarget, forceTray, trayRef,
  notes, weekStart, canWrite, hasFilters, tab, onTabChange, hint, open = true, onToggleOpen, onAddNote, onToggleNote, onRemoveNote,
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
  tab: TrayTab;
  onTabChange: (tab: TrayTab) => void;
  /** Wat je met de kaarten kunt; verschilt per weergave (in de lijst teken je niets). */
  hint: string;
  /** Op een klein scherm staat de werkvoorraad bóven het rooster en kan hij dicht. */
  open?: boolean;
  onToggleOpen?: () => void;
  onAddNote: (weekStart: string, text: string) => Promise<void>;
  onToggleNote: (id: UUID, done: boolean) => Promise<void>;
  onRemoveNote: (id: UUID) => Promise<void>;
}) {
  // Tijdens het slepen altijd de lade tonen: daar kun je iets in loslaten — en
  // dan mag hij ook niet dichtstaan.
  const active = forceTray ? 'tray' : tab;
  const shown = open || forceTray;
  const unscheduledMinutes = unscheduled.reduce((sum, task) => sum + taskEstimateMinutes(task), 0);
  const tabs: { key: TrayTab; label: string; count: number; title: string }[] = [
    { key: 'tray', label: 'Te plannen', count: unscheduled.length, title: 'Open taken die nog geen dag hebben' },
    { key: 'deadline', label: 'Deadlines', count: deadlineThisWeek.length, title: 'Open taken met een deadline in deze week' },
    { key: 'outside', label: 'Andere weken', count: outsideThisWeek.length, title: 'Taken die op een dag buiten deze week staan' },
  ];

  return <aside className={`wp-tray${isDropTarget ? ' is-drop' : ''}${shown ? '' : ' is-closed'}`} aria-label="Werkvoorraad">
    <div className="wp-tray-head">
      <span className="wp-tray-icon" aria-hidden="true"><Inbox size={15}/></span>
      <span className="wp-tray-title">Werkvoorraad</span>
      <span className="wp-tray-total" title={unscheduledMinutes > 0 ? `${formatDuration(unscheduledMinutes)} geschat` : undefined}>{unscheduled.length}</span>
      {onToggleOpen && <button
        type="button"
        className="wp-tray-toggle"
        aria-expanded={shown}
        onClick={onToggleOpen}
        title={shown ? 'Werkvoorraad inklappen' : 'Werkvoorraad uitklappen'}
        aria-label={shown ? 'Werkvoorraad inklappen' : 'Werkvoorraad uitklappen'}
      >
        {shown ? <PanelLeftClose size={14}/> : <PanelLeftOpen size={14}/>}
      </button>}
    </div>
    <div className="wp-tray-tabs" role="tablist" aria-label="Wat in de werkvoorraad" hidden={!shown}>
      {tabs.map(item => <button
        key={item.key}
        type="button"
        role="tab"
        aria-selected={active === item.key}
        className={active === item.key ? 'is-on' : ''}
        title={item.title}
        onClick={() => onTabChange(item.key)}
      >
        <span>{item.label}</span>
        <b className={item.count === 0 ? 'is-zero' : ''}>{item.count}</b>
      </button>)}
    </div>

    {/* De lade is de dropzone, dus die blijft altijd gemonteerd. */}
    <div className="wp-tray-body" ref={trayRef} hidden={!shown || active !== 'tray'}>
      {/* In alleen-lezen kan er niets gesleept worden; dan is deze uitnodiging
          een belofte die het scherm niet waarmaakt. */}
      {canWrite && unscheduled.length > 0 && <p className="wp-tray-hint">{hint}</p>}
      {unscheduled.map(task => renderTask(task))}
      {unscheduled.length === 0 && <div className="wp-tray-empty">
        <span className="wp-tray-empty-icon" aria-hidden="true">{hasFilters ? <Search size={18}/> : <Check size={18}/>}</span>
        <b>{hasFilters ? 'Niets binnen dit filter' : 'Alles heeft een plek'}</b>
        <span>{hasFilters ? 'Er is geen ongeplande taak die bij je zoekopdracht of filters past.' : 'Elke open taak staat op een dag. Sleep een kaart hierheen om hem uit de planning te halen.'}</span>
      </div>}
    </div>

    {shown && active === 'deadline' && <div className="wp-tray-body">
      <p className="wp-tray-hint">Open taken met een deadline in deze week, waar ze ook gepland staan.</p>
      {deadlineThisWeek.map(task => renderTask(task, { showPlannedDate: true }))}
      {deadlineThisWeek.length === 0 && <div className="wp-tray-empty">
        <span className="wp-tray-empty-icon" aria-hidden="true"><Flag size={18}/></span>
        <b>Geen deadlines deze week</b>
        <span>{hasFilters ? 'Binnen deze filters valt er deze week niets af.' : 'Er valt deze week geen open taak af.'}</span>
      </div>}
    </div>}

    {shown && active === 'outside' && <div className="wp-tray-body">
      <p className="wp-tray-hint">Wel een dag, maar niet in deze week. Sleep er een naar een dag om hem hierheen te halen.</p>
      {outsideThisWeek.map(task => renderTask(task, { showPlannedDate: true }))}
      {outsideThisWeek.length === 0 && <div className="wp-tray-empty">
        <span className="wp-tray-empty-icon" aria-hidden="true"><CalendarDays size={18}/></span>
        <b>Niets in andere weken</b>
        <span>Alles wat een dag heeft, staat in deze week.</span>
      </div>}
    </div>}

    {shown && <PlannerNotes
      notes={notes}
      weekStart={weekStart}
      canWrite={canWrite}
      onAdd={onAddNote}
      onToggle={onToggleNote}
      onRemove={onRemoveNote}
    />}
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
  // Inklapbaar: onderin de werkvoorraad nam dit blok op een laptop een derde van
  // de hoogte, ook in een week zonder één actiepunt. De keuze blijft bewaard.
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(NOTES_OPEN_STORAGE_KEY) !== '0'; } catch { return true; }
  });
  const toggleExpanded = () => setExpanded(value => {
    try { localStorage.setItem(NOTES_OPEN_STORAGE_KEY, value ? '0' : '1'); } catch { /* privémodus */ }
    return !value;
  });
  const bodyId = `wp-notes-${weekStart}`;

  return <section className={`wp-notes${expanded ? ' is-open' : ' is-closed'}`}>
    <button type="button" className="wp-notes-head" aria-expanded={expanded} aria-controls={bodyId} onClick={toggleExpanded}>
      <ChevronDown size={14} className="wp-notes-caret" aria-hidden="true"/>
      <span>Actiepunten deze week</span>
      {notes.length > 0 && <span className="wp-notes-count">{open.length} open</span>}
    </button>

    {expanded && <div className="wp-notes-body" id={bodyId}>

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
        {canWrite && <button type="button" className="wp-notes-delete" onClick={() => void onRemove(note.id)} title="Verwijderen" aria-label={`Actiepunt ${note.text} verwijderen`}>
          <X size={11}/>
        </button>}
      </li>)}
    </ul>}
    </div>}
  </section>;
}

/** Heeft deze taak een ingevulde tijdschatting? */
function formatEventTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function barSpanLabel(bar: WeekBar): string {
  if (bar.continuesLeft && bar.continuesRight) return 'loopt door';
  if (bar.span === 7) return 'hele week';
  const days = bar.span;
  return `${days} ${days === 1 ? 'dag' : 'dagen'}`;
}

/** De periode-pil op een weektaak-kaart: de echte data, en of het werk buiten
 *  deze week doorloopt — de kaart zelf laat alleen de zichtbare dagen zien. */
function barPeriodLabel(bar: WeekBar): string {
  const base = barDateLabel(bar);
  if (bar.continuesLeft && bar.continuesRight) return `${base} · loopt door`;
  if (bar.continuesRight) return `${base} · loopt door na deze week`;
  if (bar.continuesLeft) return `${base} · begon vorige week`;
  return `${base} · ${barSpanLabel(bar)}`;
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

/** "1u 30m vrij" of "45m te veel". Eerder stond er "45m over", en "over" kan
 *  in het Nederlands allebei betekenen: nog over, of eroverheen. */
function roomLabel(freeMinutes: number, spread = false): string {
  const prefix = spread ? '±' : '';
  return freeMinutes < 0 ? `${prefix}${formatDuration(-freeMinutes)} te veel` : `${prefix}${formatDuration(freeMinutes)} vrij`;
}

/** De som achter een dag, voor de tooltip en de schermlezer. */
function netDayTitle(net: NetDay, spread: boolean): string {
  const tasks = `${spread ? '±' : ''}${formatDuration(net.taskMinutes)}`;
  if (!net.counts) return `Geen werkdag: hier telt geen werktijd. Afspraken ${formatDuration(net.meetingMinutes)}, taken ${tasks}.`;
  return `Werktijd ${formatDuration(net.workMinutes)} − afspraken ${formatDuration(net.meetingMinutes)} = ${formatDuration(net.netMinutes)} netto voor taken. Ingepland ${tasks}, dus ${roomLabel(net.freeMinutes ?? 0, spread)}.`;
}

function formatDuration(minutes: number): string {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const rest = safeMinutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}u`;
  return `${hours}u ${rest}m`;
}

/** Is een deadline al voorbij, of valt hij binnen drie dagen? Op de dag van
 *  vandaag gerekend, niet op de week die in beeld staat. */
function deadlineTone(dateKey: string): 'late' | 'soon' | null {
  const today = formatISODate(new Date());
  if (dateKey < today) return 'late';
  if (dateKey <= shiftDateKey(today, 3)) return 'soon';
  return null;
}

function formatDateShort(date: string): string {
  return parseISODate(date).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' });
}

/** Waar een taak stond of komt te staan, in twee woorden: "wo 13" of "de werkvoorraad". */
function planLabel(dateKey: string | null): string {
  return dateKey ? formatDayShort(dateKey) : 'de werkvoorraad';
}

function formatDayShort(dateKey: string): string {
  return parseISODate(dateKey).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric' });
}
