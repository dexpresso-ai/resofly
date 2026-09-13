import type { CalendarExternalEvent, Task, UUID } from '../types';

/** Een taak die over meerdere dagen loopt, uitgerekend voor de zichtbare week. */
export type WeekBar = {
  task: Task;
  startIdx: number;
  span: number;
  continuesLeft: boolean;
  continuesRight: boolean;
  lane: number;
};

/** Zelfde stapgrootte als `reorder_task_planning` in de database gebruikt. Door
 *  ruime stappen te bewaren blijft er plek tussen twee taken voor een latere
 *  invoeging zonder dat de hele dag hernummerd hoeft te worden. */
export const PLANNING_ORDER_STEP = 1000;

/** Taken zonder `planned_order` sorteren achteraan — gelijk aan de
 *  `coalesce(planned_order, 2147483647)` in de database. Let op: `Number(null)`
 *  is 0 en niet NaN, dus leeg moet expliciet worden afgevangen. Anders springt
 *  een net toegevoegde taak (nog zonder volgorde) naar bóvenaan de dag, om bij
 *  de eerstvolgende serveractie alsnog naar onderen te zakken. */
function orderValue(task: Task): number {
  if (task.planned_order === null || task.planned_order === undefined) return Number.MAX_SAFE_INTEGER;
  const raw = Number(task.planned_order);
  return Number.isFinite(raw) ? raw : Number.MAX_SAFE_INTEGER;
}

/** De volgorde binnen één plandag, identiek aan die van de database:
 *  planned_order, dan created_at, dan id. */
export function comparePlannedTasks(a: Task, b: Task): number {
  const byOrder = orderValue(a) - orderValue(b);
  if (byOrder !== 0) return byOrder;
  const byCreated = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
  if (byCreated !== 0) return byCreated;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Spiegelt `reorder_task_planning` in de client, zodat een versleepte taak
 * meteen op zijn nieuwe plek staat en pas daarna door de server wordt bevestigd.
 * De uitkomst is bewust gelijk aan wat de database zou opleveren: dezelfde
 * sortering, dezelfde hernummering van de bron- en doeldag.
 */
export function applyPlanningLocally(
  tasks: Task[],
  taskId: UUID,
  plannedDate: string | null,
  beforeTaskId: UUID | null,
): Task[] {
  const moving = tasks.find(task => task.id === taskId);
  if (!moving) return tasks;

  const fromDate = moving.planned_date ?? null;
  const patches = new Map<string, Task>();

  if (plannedDate) {
    const destination = tasks
      .filter(task => task.planned_date === plannedDate && task.id !== taskId)
      .sort(comparePlannedTasks);

    const ordered: Task[] = [];
    let inserted = false;
    for (const task of destination) {
      if (beforeTaskId && task.id === beforeTaskId && !inserted) {
        ordered.push(moving);
        inserted = true;
      }
      ordered.push(task);
    }
    if (!inserted) ordered.push(moving);

    ordered.forEach((task, index) => {
      patches.set(task.id, {
        ...task,
        planned_date: plannedDate,
        planned_order: (index + 1) * PLANNING_ORDER_STEP,
        // In een dagkolom laten vallen maakt er een dagtaak van; alleen de
        // versleepte taak verliest zijn looptijd én zijn tijdstip, net als in de RPC.
        planned_end_date: task.id === taskId ? null : task.planned_end_date,
        planned_start_minute: task.id === taskId ? null : task.planned_start_minute,
      });
    });
  } else {
    patches.set(moving.id, { ...moving, planned_date: null, planned_end_date: null, planned_start_minute: null, planned_order: null });
  }

  // De dag waar de taak vandaan komt houdt een gat; die nummeren we opnieuw.
  if (fromDate && fromDate !== plannedDate) {
    tasks
      .filter(task => task.planned_date === fromDate && task.id !== taskId)
      .sort(comparePlannedTasks)
      .forEach((task, index) => {
        patches.set(task.id, { ...(patches.get(task.id) ?? task), planned_order: (index + 1) * PLANNING_ORDER_STEP });
      });
  }

  if (patches.size === 0) return tasks;
  return tasks.map(task => patches.get(task.id) ?? task);
}

/**
 * Spiegelt `set_task_planning_period`: zet begin en einde van een weekstrook.
 * Vallen begin en einde op dezelfde dag, dan is het weer een dagtaak en krijgt
 * de taak ook meteen een plek in de volgorde van die dag.
 */
export function applyPeriodLocally(
  tasks: Task[],
  taskId: UUID,
  plannedDate: string,
  plannedEndDate: string | null,
): Task[] {
  if (!tasks.some(task => task.id === taskId)) return tasks;
  const end = plannedEndDate && plannedEndDate > plannedDate ? plannedEndDate : null;
  const patched = tasks.map(task =>
    task.id === taskId ? { ...task, planned_date: plannedDate, planned_end_date: end } : task,
  );
  return end ? patched : applyPlanningLocally(patched, taskId, plannedDate, null);
}

/** Loopt deze taak over meer dan één dag? Dan hoort hij in de strokenband. */
export function isSpanningTask(task: Task): boolean {
  const start = task.planned_date;
  const end = task.planned_end_date;
  return !!start && !!end && end > start;
}

/**
 * Verschuift een datumsleutel (jjjj-mm-dd) een aantal dagen. Bewust met
 * UTC-rekenwerk en zonder hulp uit `dates.ts`: dit bestand blijft daardoor vrij
 * van imports en dus rechtstreeks te testen met de Node-testrunner. Een
 * kalenderdatum kent geen tijdzone, dus UTC geeft hier nooit een dag verschil.
 */
export function shiftDateKey(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, (month ?? 1) - 1, (day ?? 1) + days));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Verdeelt de stroken over rijen: de langste balk per startdag claimt de
 * bovenste rij, kortere balken vullen de gaten eronder. Dezelfde inpaklogica
 * als de hele-dag-rij van de agenda, zodat de twee schermen zich hetzelfde
 * gedragen.
 */
export function layoutWeekBars(dayKeys: string[], tasks: Task[]): { bars: WeekBar[]; laneCount: number } {
  const firstKey = dayKeys[0];
  const lastKey = dayKeys[dayKeys.length - 1];
  const bars: WeekBar[] = [];

  for (const task of tasks) {
    const start = task.planned_date;
    const end = task.planned_end_date;
    // Tijdens het herschalen mag een strook even één dag breed zijn.
    if (!start || !end || end < start) continue;
    if (end < firstKey || start > lastKey) continue;
    const startIdx = dayKeys.indexOf(start < firstKey ? firstKey : start);
    const endIdx = dayKeys.indexOf(end > lastKey ? lastKey : end);
    if (startIdx < 0 || endIdx < 0) continue;
    bars.push({
      task, startIdx, span: endIdx - startIdx + 1,
      continuesLeft: start < firstKey, continuesRight: end > lastKey, lane: 0,
    });
  }

  bars.sort((a, b) =>
    a.startIdx - b.startIdx
    || b.span - a.span
    || a.task.title.localeCompare(b.task.title, 'nl-NL'));

  const laneEnds: number[] = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex(end => end <= bar.startIdx);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    bar.lane = lane;
    laneEnds[lane] = bar.startIdx + bar.span;
  }

  return { bars, laneCount: laneEnds.length };
}

// Sleep je tegen een rand van het scrollgebied, dan scrollt het mee. Op een
// telefoon staan de zeven dagen onder elkaar; zonder dit kun je een taak nooit
// van maandag naar zondag brengen.
export const EDGE_SCROLL_ZONE_PX = 84;
export const EDGE_SCROLL_MAX_PX = 20;
/**
 * Een vak binnen de pagina — een dagkolom, de lade — is veel kleiner dan het
 * venster. Met de volle randzone zou daar bijna geen neutraal midden overblijven
 * en zou het vak al schuiven zodra je erboven hangt.
 */
export const PANE_EDGE_SCROLL_ZONE_PX = 30;

/**
 * Hoeveel pixels moet er geschoven worden bij deze aanwijzerpositie? Negatief is
 * terug, positief is vooruit, nul is buiten de randzones. Hoe dichter tegen de
 * rand, hoe sneller — precies aan de rand is het volle tempo.
 *
 * Is het scrollgebied kleiner dan twee randzones, dan zou elke positie in een
 * zone vallen en het gebied ongevraagd blijven schuiven; daar doen we niets.
 */
export function edgeScrollDelta(position: number, min: number, max: number, zone = EDGE_SCROLL_ZONE_PX): number {
  if (max - min < zone * 2) return 0;
  if (position < min + zone) {
    return -Math.ceil(EDGE_SCROLL_MAX_PX * (1 - Math.max(0, position - min) / zone));
  }
  if (position > max - zone) {
    return Math.ceil(EDGE_SCROLL_MAX_PX * (1 - Math.max(0, max - position) / zone));
  }
  return 0;
}

export type DayAgenda = {
  minutes: number;
  items: CalendarExternalEvent[];
  /** Hele-dag-items van deze dag. Ze tellen géén minuten — ze zouden in hun
   *  eentje elke balk volzetten — maar een shootdag mag niet als lege dag lezen. */
  allDay: CalendarExternalEvent[];
};

/**
 * Wat staat er per dag in de agenda, en hoeveel tijd kost dat? Een afspraak die
 * over middernacht loopt wordt per kalenderdag geknipt, zodat elke dag alleen
 * zijn eigen minuten telt.
 *
 * Hele-dag-items tellen géén uren: ze claimen geen blok in je dag. Ze zouden
 * anders in hun eentje elke dagbalk volzetten. Ze verdwenen eerder helemaal,
 * waardoor een dag vol hele-dag-afspraken er leeg uitzag; nu komen ze apart
 * terug in `allDay` zodat de dagkop ze kan tonen.
 */
export function groupEventMinutesByDay(dayKeys: string[], events: CalendarExternalEvent[]): Map<string, DayAgenda> {
  const byDay = new Map<string, DayAgenda>();
  for (const key of dayKeys) byDay.set(key, { minutes: 0, items: [], allDay: [] });

  for (const event of events) {
    if (event.all_day) {
      // Over welke kalenderdagen loopt dit hele-dag-item?
      const from = event.starts_at.slice(0, 10);
      const to = (event.ends_at || event.starts_at).slice(0, 10);
      for (const key of dayKeys) {
        if (key >= from && key <= to) byDay.get(key)?.allDay.push(event);
      }
      continue;
    }
    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;

    for (const key of dayKeys) {
      const bucket = byDay.get(key);
      if (!bucket) continue;
      const [year, month, day] = key.split('-').map(Number);
      // Lokale kalenderdag, gelijk aan hoe de gebruiker zijn agenda leest.
      const dayStart = new Date(year, (month ?? 1) - 1, day ?? 1);
      const dayEnd = new Date(year, (month ?? 1) - 1, (day ?? 1) + 1);
      const overlapStart = start > dayStart ? start : dayStart;
      const overlapEnd = end < dayEnd ? end : dayEnd;
      const minutes = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 60000);
      if (minutes <= 0) continue;
      bucket.minutes += minutes;
      bucket.items.push(event);
    }
  }

  for (const bucket of byDay.values()) {
    bucket.items.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    bucket.allDay.sort((a, b) => a.title.localeCompare(b.title, 'nl-NL'));
  }
  return byDay;
}

/** Legt verse serverrijen over de lokale lijst heen; onbekende id's komen erbij. */
export function mergeTaskRows(tasks: Task[], rows: Task[]): Task[] {
  if (rows.length === 0) return tasks;
  const incoming = new Map(rows.map(row => [row.id, row]));
  const merged = tasks.map(task => incoming.get(task.id) ?? task);
  for (const row of rows) {
    if (!tasks.some(task => task.id === row.id)) merged.push(row);
  }
  return merged;
}

/**
 * Leest een tijdsduur zoals iemand die typt: "90", "90m", "1u", "1u30", "1:30",
 * "1.5u". Geeft `null` als er niets bruikbaars in staat, zodat een typfout geen
 * verzonnen schatting oplevert.
 */
export function parseDurationInput(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(',', '.');
  if (!text) return null;

  // "1:30" — uren en minuten gescheiden door een dubbele punt.
  const clock = text.match(/^(\d+)\s*:\s*(\d{1,2})$/);
  if (clock) {
    const minutes = Number(clock[1]) * 60 + Number(clock[2]);
    return Number.isFinite(minutes) ? clamp(minutes) : null;
  }

  // "1u30", "1u", "2 uur 15" — uren met eventueel losse minuten erachter.
  const hours = text.match(/^(\d+(?:\.\d+)?)\s*(?:u|uur|h)\s*(\d{1,2})?\s*(?:m|min|minuten)?$/);
  if (hours) {
    const total = Number(hours[1]) * 60 + (hours[2] ? Number(hours[2]) : 0);
    return Number.isFinite(total) ? clamp(total) : null;
  }

  // "90", "90m", "45 min" — kaal getal is altijd minuten.
  const minutes = text.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|minuten)?$/);
  if (minutes) {
    const total = Number(minutes[1]);
    return Number.isFinite(total) ? clamp(total) : null;
  }

  return null;
}

function clamp(minutes: number): number {
  return Math.max(0, Math.min(24 * 60, Math.round(minutes)));
}

/**
 * Haalt een tijdsduur uit een net getypte taaktitel: "Montage 2u" wordt een taak
 * van 120 minuten die gewoon "Montage" heet. Alleen aan het eind van de titel,
 * zodat "2 uur durende sessie" niet stilletjes wordt opgegeten.
 */
export function splitTitleAndEstimate(title: string): { title: string; minutes: number | null } {
  const match = title.match(/^(.*?)[\s·-]+(\d+(?:[.,]\d+)?\s*(?:u|uur|h)(?:\s*\d{1,2})?|\d+\s*(?:m|min|minuten)|\d+\s*:\s*\d{1,2})$/i);
  if (!match) return { title: title.trim(), minutes: null };
  const rest = match[1].trim();
  if (!rest) return { title: title.trim(), minutes: null };
  const minutes = parseDurationInput(match[2]);
  return minutes === null ? { title: title.trim(), minutes: null } : { title: rest, minutes };
}

/**
 * Draait alleen de taken terug die op één van `dates` stonden of staan. Bij een
 * mislukte planningsactie ging eerder de héle takenlijst terug naar een
 * momentopname van vóór de actie: sleepbewegingen die intussen wél gelukt waren
 * kwamen dan mee terug, en beeld en database liepen uiteen tot de eerstvolgende
 * verversing. `null` in `dates` staat voor de lade (taken zonder plandatum).
 */
export function restoreTasksForDates(current: Task[], snapshot: Task[], dates: (string | null)[]): Task[] {
  const keys = new Set(dates.map(date => date ?? '__unscheduled__'));
  const dayOf = (task: Task) => task.planned_date ?? '__unscheduled__';
  const before = new Map(snapshot.map(task => [task.id, task]));

  return current.map(task => {
    const original = before.get(task.id);
    if (!original) return task;
    // Raakt deze taak een van de betrokken dagen — nu of in de oude stand?
    if (!keys.has(dayOf(task)) && !keys.has(dayOf(original))) return task;
    return original;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tijdblokken: een taak op een tijdstip in de dag (2026-09-12)
//
// De weekplanner tekent taken sinds deze ronde in hetzelfde tijdrooster als de
// agenda. Een taak zonder tijd staat in de dagband ("nog geen tijd"); zodra hij
// een `planned_start_minute` heeft is hij een blok, met de schatting als duur.
// Alles hieronder is puur rekenwerk, zonder DOM en zonder imports, zodat het
// onder de Node-testrunner draait.
// ═══════════════════════════════════════════════════════════════════════════

/** Duur van een blok voor een taak zonder schatting: een uur, tot je hem oprekt. */
export const DEFAULT_BLOCK_MINUTES = 60;
/** Blokken klikken op het kwartier, net als afspraken in de agenda. */
export const BLOCK_SNAP_MINUTES = 15;
export const MIN_BLOCK_MINUTES = 15;
const DAY_END_MINUTE = 24 * 60;

/** Staat deze taak op een tijdstip? Een weekstrook nooit — die heeft geen tijd. */
export function hasPlannedTime(task: Task): boolean {
  return !!task.planned_date
    && task.planned_start_minute !== null
    && task.planned_start_minute !== undefined
    && Number.isFinite(Number(task.planned_start_minute))
    && !isSpanningTask(task);
}

/** Hoeveel minuten beslaat het blok van deze taak? De schatting, en anders een uur. */
export function taskBlockMinutes(task: Task): number {
  const raw = task.estimated_minutes === null || task.estimated_minutes === undefined ? NaN : Number(task.estimated_minutes);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BLOCK_MINUTES;
  return Math.max(MIN_BLOCK_MINUTES, Math.min(DAY_END_MINUTE, Math.round(raw)));
}

/** Rondt een minuut in de dag af op het kwartier en houdt hem binnen de dag. */
export function snapMinute(minute: number, blockMinutes = MIN_BLOCK_MINUTES): number {
  const snapped = Math.round(minute / BLOCK_SNAP_MINUTES) * BLOCK_SNAP_MINUTES;
  return Math.max(0, Math.min(DAY_END_MINUTE - Math.max(MIN_BLOCK_MINUTES, blockMinutes), snapped));
}

/** "09:30" — voor labels op blokken en in menu's. */
export function clockLabel(minute: number): string {
  const safe = Math.max(0, Math.min(DAY_END_MINUTE, Math.round(minute)));
  const hours = Math.floor(safe / 60) % 24;
  const rest = safe % 60;
  return String(hours).padStart(2, '0') + ':' + String(rest).padStart(2, '0');
}

/**
 * Spiegelt het zetten van een tijdstip in de client. De taak wordt een
 * dagtaak op `plannedDate` met een tijd; een looptijd vervalt. Verhuist hij
 * naar een andere dag, dan sluit hij daar achteraan aan en wordt de oude dag
 * hernummerd — precies wat de server ook doet.
 */
export function applyTimeLocally(
  tasks: Task[],
  taskId: UUID,
  plannedDate: string,
  startMinute: number,
  minutes?: number | null,
): Task[] {
  const moving = tasks.find(task => task.id === taskId);
  if (!moving) return tasks;
  const fromDate = moving.planned_date ?? null;
  const patches = new Map<string, Task>();
  const dayChanged = fromDate !== plannedDate;

  const siblings = tasks
    .filter(task => task.planned_date === plannedDate && task.id !== taskId)
    .sort(comparePlannedTasks);
  const nextOrder = dayChanged || moving.planned_order === null || moving.planned_order === undefined
    ? (siblings.length + 1) * PLANNING_ORDER_STEP
    : moving.planned_order;

  patches.set(taskId, {
    ...moving,
    planned_date: plannedDate,
    planned_end_date: null,
    planned_start_minute: snapMinute(startMinute, minutes ?? taskBlockMinutes(moving)),
    planned_order: nextOrder,
    ...(minutes === null || minutes === undefined ? {} : { estimated_minutes: Math.max(MIN_BLOCK_MINUTES, Math.min(DAY_END_MINUTE, Math.round(minutes))) }),
  });

  if (dayChanged && fromDate) {
    tasks
      .filter(task => task.planned_date === fromDate && task.id !== taskId)
      .sort(comparePlannedTasks)
      .forEach((task, index) => {
        patches.set(task.id, { ...task, planned_order: (index + 1) * PLANNING_ORDER_STEP });
      });
  }

  return tasks.map(task => patches.get(task.id) ?? task);
}

/** Een bezet stuk van een dag, in minuten na middernacht (einde exclusief). */
export type BusySlot = { start: number; end: number };

/** Voegt overlappende stukken samen en sorteert ze. */
export function mergeBusySlots(slots: BusySlot[]): BusySlot[] {
  const sorted = slots
    .filter(slot => Number.isFinite(slot.start) && Number.isFinite(slot.end) && slot.end > slot.start)
    .map(slot => ({ start: Math.max(0, slot.start), end: Math.min(DAY_END_MINUTE, slot.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: BusySlot[] = [];
  for (const slot of sorted) {
    const last = merged[merged.length - 1];
    if (last && slot.start <= last.end) last.end = Math.max(last.end, slot.end);
    else merged.push({ ...slot });
  }
  return merged;
}

/** De vrije gaten binnen een venster, gegeven wat er al bezet is. */
export function freeGaps(busy: BusySlot[], windowStart: number, windowEnd: number): BusySlot[] {
  const gaps: BusySlot[] = [];
  let cursor = windowStart;
  for (const slot of mergeBusySlots(busy)) {
    if (slot.end <= cursor) continue;
    if (slot.start >= windowEnd) break;
    if (slot.start > cursor) gaps.push({ start: cursor, end: Math.min(slot.start, windowEnd) });
    cursor = Math.max(cursor, slot.end);
    if (cursor >= windowEnd) break;
  }
  if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });
  return gaps.filter(gap => gap.end - gap.start >= MIN_BLOCK_MINUTES);
}

export type PlanProposal = { taskId: UUID; dayKey: string; startMinute: number; minutes: number };

export type AutoPlanInput = {
  /** De dagen van de zichtbare week, op volgorde. */
  dayKeys: string[];
  /** Wat er per dag al vaststaat: afspraken én taken die al een tijd hebben. */
  busy: Map<string, BusySlot[]>;
  /** Werk dat een plek zoekt; de volgorde bepaalt wie het eerst kiest. */
  candidates: Task[];
  todayKey: string;
  /** Minuten na middernacht, nu. Op vandaag begint het voorstel pas hierna. */
  nowMinute: number;
  /** Het venster waarbinnen werk wordt neergezet. */
  workStart?: number;
  workEnd?: number;
  /** Dagen die overgeslagen worden (bijv. het weekend, tenzij dat meetelt). */
  skipDays?: Set<string>;
  /** Je dagstreep in minuten, en wat er per dag al aan uren staat. Zonder streep
   *  is het venster de enige harde grens. */
  dailyCap?: number | null;
  usedMinutes?: Map<string, number>;
  /** Zonder streep: een zachte bovengrens per dag, zodat het voorstel het werk
   *  over de week spreidt in plaats van de eerste dag vol te gooien. Past iets
   *  nergens binnen die grens, dan mag het alsnog in het eerste vrije gat. */
  softCap?: number | null;
};

/** De volgorde waarin het voorstel taken neerzet: eerst de deadline die het
 *  dichtst bij is, dan prioriteit, dan de dag waarop ze al stonden, dan de naam. */
export function sortForAutoPlan(tasks: Task[]): Task[] {
  const weight: Record<string, number> = { high: 0, med: 1, low: 2 };
  return [...tasks].sort((a, b) =>
    String(a.end_date ?? '9999-12-31').localeCompare(String(b.end_date ?? '9999-12-31'))
    || (weight[a.priority] ?? 1) - (weight[b.priority] ?? 1)
    || String(a.planned_date ?? '9999-12-31').localeCompare(String(b.planned_date ?? '9999-12-31'))
    || a.title.localeCompare(b.title, 'nl-NL'));
}

/**
 * "Vul mijn week": zet werk dat nog geen tijd heeft in de eerste vrije gaten.
 *
 * Gulzig en voorspelbaar: per taak de eerste dag (vanaf vandaag) met een gat
 * dat groot genoeg is, vroeg in het venster. Wat niet past blijft liggen — dit
 * is een voorstel dat de planner laat zien en dat jij bevestigt, geen automaat
 * die je week volgooit.
 */
export function proposeTimeBlocks(input: AutoPlanInput): { proposals: PlanProposal[]; unplaced: Task[] } {
  const workStart = input.workStart ?? 9 * 60;
  const workEnd = input.workEnd ?? 17 * 60;
  const busy = new Map<string, BusySlot[]>();
  for (const key of input.dayKeys) busy.set(key, [...(input.busy.get(key) ?? [])]);
  const used = new Map<string, number>();
  for (const key of input.dayKeys) used.set(key, input.usedMinutes?.get(key) ?? 0);

  const proposals: PlanProposal[] = [];
  const unplaced: Task[] = [];

  const openDays = input.dayKeys.filter(key => key >= input.todayKey && !input.skipDays?.has(key));

  /** De eerste dag met een gat dat groot genoeg is, binnen de bovengrens. */
  const tryPlace = (task: Task, minutes: number, cap: number | null): boolean => {
    for (const key of openDays) {
      if (cap !== null && (used.get(key) ?? 0) + minutes > cap) continue;
      // Vandaag begint het voorstel pas ná nu, afgerond op het kwartier.
      const earliest = key === input.todayKey
        ? Math.max(workStart, Math.ceil(input.nowMinute / BLOCK_SNAP_MINUTES) * BLOCK_SNAP_MINUTES)
        : workStart;
      const gap = freeGaps(busy.get(key) ?? [], earliest, workEnd).find(candidate => candidate.end - candidate.start >= minutes);
      if (!gap) continue;
      proposals.push({ taskId: task.id, dayKey: key, startMinute: gap.start, minutes });
      busy.get(key)!.push({ start: gap.start, end: gap.start + minutes });
      used.set(key, (used.get(key) ?? 0) + minutes);
      return true;
    }
    return false;
  };

  for (const task of input.candidates) {
    const minutes = taskBlockMinutes(task);
    const strict = input.dailyCap ?? null;
    // Met een streep is die de grens, punt. Zonder streep spreidt de zachte
    // grens het werk over de dagen; wat daar nergens in past krijgt alsnog het
    // eerste vrije gat — beter een volle dag dan werk dat blijft liggen.
    let placed = tryPlace(task, minutes, strict ?? input.softCap ?? null);
    if (!placed && strict === null && input.softCap != null) placed = tryPlace(task, minutes, null);
    if (!placed) unplaced.push(task);
  }

  return { proposals, unplaced };
}
