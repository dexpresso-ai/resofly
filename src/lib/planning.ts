import type { Task, UUID } from '../types';

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
      patches.set(task.id, { ...task, planned_date: plannedDate, planned_order: (index + 1) * PLANNING_ORDER_STEP });
    });
  } else {
    patches.set(moving.id, { ...moving, planned_date: null, planned_order: null });
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
