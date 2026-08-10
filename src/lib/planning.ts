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
        // versleepte taak verliest zijn looptijd, net als in de RPC.
        planned_end_date: task.id === taskId ? null : task.planned_end_date,
      });
    });
  } else {
    patches.set(moving.id, { ...moving, planned_date: null, planned_end_date: null, planned_order: null });
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

export type DayAgenda = { minutes: number; items: CalendarExternalEvent[] };

/**
 * Wat staat er per dag in de agenda, en hoeveel tijd kost dat? Een afspraak die
 * over middernacht loopt wordt per kalenderdag geknipt, zodat elke dag alleen
 * zijn eigen minuten telt.
 *
 * Hele-dag-items tellen géén uren: ze claimen geen blok in je dag. Ze zouden
 * anders in hun eentje elke dagbalk volzetten.
 */
export function groupEventMinutesByDay(dayKeys: string[], events: CalendarExternalEvent[]): Map<string, DayAgenda> {
  const byDay = new Map<string, DayAgenda>();
  for (const key of dayKeys) byDay.set(key, { minutes: 0, items: [] });

  for (const event of events) {
    if (event.all_day) continue;
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
