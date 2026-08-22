/**
 * Eén rekenmodule voor "wanneer hoort deze taak ergens thuis".
 *
 * Dit bestond in drie varianten die stilletjes uiteenliepen. Het startscherm nam
 * `planned_date ?? end_date` als dag van een taak, de weekplanner keek alleen
 * naar `planned_date`, en het projectscherm keek naar geen van beide. Dezelfde
 * taak was daardoor op het ene scherm gepland en op het andere ongepland — en
 * dat is precies het soort verschil dat je pas ontdekt als je erop vertrouwde.
 *
 * Wat hier staat is de enige waarheid. Bewust zonder imports behalve types,
 * zodat het rechtstreeks te testen is met de Node-testrunner. `isSpanningTask`
 * hoort er inhoudelijk bij maar woont in planning.ts, waar de strokenlayout hem
 * ook gebruikt — één definitie is belangrijker dan één vindplaats.
 */
import type { Task } from '../types';

/**
 * De dag waarop een taak in een daglijst thuishoort: de plandatum, en anders de
 * deadline. Een taak met alleen een deadline is niet ingepland, maar hij moet
 * ergens opduiken — anders valt hij tot de dag van de deadline volledig buiten
 * beeld.
 */
export function taskDayKey(task: Task): string | null {
  return task.planned_date ?? task.end_date ?? null;
}

/** Laatste dag waarop deze taak nog op tijd is; bij een weekstrook de einddag. */
export function taskLastDayKey(task: Task): string | null {
  if (task.planned_date) {
    return task.planned_end_date && task.planned_end_date > task.planned_date
      ? task.planned_end_date
      : task.planned_date;
  }
  return task.end_date ?? null;
}

/** Loopt deze taak op de opgegeven dag? Houdt rekening met meerdaagse stroken. */
export function coversDay(task: Task, dayKey: string): boolean {
  if (!task.planned_date) return false;
  const end = task.planned_end_date && task.planned_end_date > task.planned_date
    ? task.planned_end_date
    : task.planned_date;
  return task.planned_date <= dayKey && dayKey <= end;
}

/** Is deze taak over zijn laatste dag heen? Zegt niets over de status. */
export function isOverdue(task: Task, todayKey: string): boolean {
  const last = taskLastDayKey(task);
  return last !== null && last < todayKey;
}

/** Valt de taak binnen dit venster van dagen (grenzen meegerekend)? */
export function inWeek(task: Task, firstKey: string, lastKey: string): boolean {
  if (task.planned_date) {
    const end = task.planned_end_date && task.planned_end_date > task.planned_date
      ? task.planned_end_date
      : task.planned_date;
    return end >= firstKey && task.planned_date <= lastKey;
  }
  return !!task.end_date && task.end_date >= firstKey && task.end_date <= lastKey;
}

/**
 * "Mijn werk" is overal in de app hetzelfde: wat aan mij is toegewezen, plus wat
 * nog aan niemand hangt. Zonder dat tweede deel verdwijnt een net toegevoegde
 * losse taak meteen uit je eigen beeld.
 */
export function scopeTasks(
  tasks: Task[],
  scope: 'mine' | 'team',
  currentUserId: string | null,
  assigneesByTask: Map<string, string[]>,
): Task[] {
  if (scope === 'team' || !currentUserId) return tasks;
  return tasks.filter(task => {
    const assignees = assigneesByTask.get(task.id);
    return !assignees || assignees.length === 0 || assignees.includes(currentUserId);
  });
}

/** Toewijzingen omgezet naar een opzoektabel per taak. */
export function groupAssigneesByTask(rows: { task_id: string; user_id: string }[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.task_id);
    if (list) list.push(row.user_id);
    else map.set(row.task_id, [row.user_id]);
  }
  return map;
}
