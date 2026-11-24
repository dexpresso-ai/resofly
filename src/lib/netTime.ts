import type { CalendarEventLink, Task } from '../types';
import { linkedMinutesOnDay, remainingEstimateOnDay } from './calendar-links.ts';
import { hasPlannedTime, isSpanningTask, shiftDateKey, taskBlockMinutes } from './planning.ts';

/**
 * Netto tijd in de weekplanner (2026-11-24).
 *
 * De vraag van maandagochtend is niet "hoe vol is mijn week" maar "past mijn
 * werk nog". Daarvoor is een maat nodig: je werktijd. Daar gaan je afspraken
 * vanaf, want een uur in een meeting kun je niet meer aan een taak besteden.
 * Wat overblijft is je netto tijd, en daar moeten je taken in passen.
 *
 *   werktijd − afspraken = netto tijd;  netto tijd − taken = vrij (of te veel)
 *
 * Eerder had de planner zonder zelf gezette "dagstreep" geen maat: dan toonde
 * hij alleen de verhouding tussen afspraken en taken en zei hij nooit dat iets
 * niet paste. Nu rekent hij zonder instelling met acht uur op een werkdag.
 *
 * Bewust zonder DOM en met alleen rekenwerk, zodat het onder `npm test` draait.
 */

/** Zonder eigen instelling: acht uur op een werkdag, het weekend telt niet. */
export const DEFAULT_WORKDAY_MINUTES = 8 * 60;

export type Workday = {
  /** Werktijd op een dag die meetelt, in minuten. */
  minutes: number;
  includeWeekend: boolean;
  /** Niets ingesteld: de planner rekent met de standaard van acht uur. */
  isDefault: boolean;
};

/**
 * De werktijd uit de persoonlijke instelling (`planner_day_capacity`). Een rij
 * met 0 minuten was "geen streep"; die betekent nu "de standaard", want zonder
 * werktijd bestaat er geen netto tijd.
 */
export function workdayFrom(capacity: { minutes: number; include_weekend: boolean } | null | undefined): Workday {
  const minutes = Number(capacity?.minutes);
  if (capacity && Number.isFinite(minutes) && minutes > 0) {
    return { minutes: Math.min(24 * 60, Math.round(minutes)), includeWeekend: !!capacity.include_weekend, isDefault: false };
  }
  return { minutes: DEFAULT_WORKDAY_MINUTES, includeWeekend: !!capacity?.include_weekend, isDefault: true };
}

/** Zaterdag of zondag? Op de datumsleutel zelf, zodat een tijdzone niets verschuift. */
export function isWeekendKey(dayKey: string): boolean {
  const [year, month, day] = dayKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Telt deze dag mee als werkdag? */
export function isWorkday(dayKey: string, workday: Workday): boolean {
  return workday.includeWeekend || !isWeekendKey(dayKey);
}

/** Werktijd van één dag: nul op een dag die niet meetelt. */
export function workMinutesOn(dayKey: string, workday: Workday): number {
  return isWorkday(dayKey, workday) ? workday.minutes : 0;
}

/**
 * Welke afspraken zijn van jou? Alleen die in je eigen agenda's: de gedeelde
 * agenda van een collega staat ook in de lijst, maar zijn meetings kosten jou
 * geen tijd. Eerder telden ze wel mee en ging de netto tijd van iedereen omlaag
 * zodra één collega zijn agenda met de organisatie deelde. Dezelfde regel als
 * bij het tekenen van je beschikbaarheid (`clashingAppointment`).
 *
 * Twee uitzonderingen, allebei "we weten het niet beter":
 *  - de agenda's zijn nog niet geladen (`sources` is null): dan alles;
 *  - je hebt geen eigen agenda die getoond wordt, alleen een gedeelde: dan is
 *    die de jouwe. Een eigen agenda op "niet tonen" levert geen afspraken, en
 *    dan bleef er niets over.
 */
export function ownCalendarEvents<T extends { source_id: string }>(
  events: T[],
  sources: ReadonlyArray<{ id: string; user_id: string; sync_enabled?: boolean }> | null,
  userId: string | null,
): T[] {
  if (!sources || !userId) return events;
  const own = new Set(sources.filter(source => source.user_id === userId && source.sync_enabled !== false).map(source => source.id));
  if (own.size === 0) return events;
  return events.filter(event => own.has(event.source_id));
}

/** Heeft deze taak een schatting? */
export function hasEstimate(task: Task): boolean {
  return task.estimated_minutes !== null
    && task.estimated_minutes !== undefined
    && Number.isFinite(Number(task.estimated_minutes));
}

/** Minuten die deze taak meetelt. Zonder schatting is dat niets: een onbekende
 *  duur stil als een uur meetellen maakt elk totaal deels verzonnen. */
export function taskEstimateMinutes(task: Task): number {
  if (!hasEstimate(task)) return 0;
  return Math.max(0, Math.min(24 * 60, Math.round(Number(task.estimated_minutes))));
}

/**
 * Hoeveel tijd neemt een dagtaak op zijn dag in? Een blok in het rooster neemt
 * zijn blok in, ook zonder schatting: het staat daar een uur en "Vul mijn week"
 * plant er niets overheen. Telde het als nul, dan zei de dagkop "8u vrij" naast
 * een rooster met drie blokken. Een taak zonder tijd telt zijn schatting.
 *
 * Een gekoppelde afspraak op die dag staat al bij de afspraken; de taak telt
 * alleen wat daarnaast overblijft (anders leest "4u taak + 1u30 meeting voor
 * die taak" als 5u30).
 */
export function dayTaskMinutes(task: Task, dayKey: string, links: CalendarEventLink[]): number {
  const own = hasPlannedTime(task) ? taskBlockMinutes(task) : taskEstimateMinutes(task);
  return remainingEstimateOnDay(own, links, dayKey);
}

/** De kalenderdagen van een weekstrook, met een bovengrens tegen een typfout van tien jaar. */
function spanKeys(task: Task): string[] {
  const keys: string[] = [];
  let key = task.planned_date!;
  while (key <= task.planned_end_date! && keys.length < 400) {
    keys.push(key);
    key = shiftDateKey(key, 1);
  }
  return keys;
}

/**
 * Hoeveel van een weekstrook valt op elk van `dayKeys`? De schatting wordt
 * verdeeld over de werkdagen van de hele strook, niet over de dagen die toevallig
 * in beeld staan. Eerder viel een strook van twee weken met twintig uur in zijn
 * geheel in de eerste week, en verdween een deel in een weekend dat niet meetelt.
 * Heeft de strook geen enkele werkdag, dan over al zijn dagen.
 */
export function spanShares(task: Task, dayKeys: string[], workday: Workday, links: CalendarEventLink[]): Map<string, number> {
  const shares = new Map<string, number>();
  if (!isSpanningTask(task)) return shares;
  const all = spanKeys(task);
  const working = all.filter(key => isWorkday(key, workday));
  const over = working.length > 0 ? working : all;
  if (over.length === 0) return shares;
  // Gekoppelde afspraken binnen de strook staan al bij de afspraken.
  const linked = links.length > 0 ? all.reduce((sum, key) => sum + linkedMinutesOnDay(links, key), 0) : 0;
  const minutes = Math.max(0, taskEstimateMinutes(task) - linked);
  if (minutes <= 0) return shares;
  const share = minutes / over.length;
  const overSet = new Set(over);
  for (const key of dayKeys) if (overSet.has(key)) shares.set(key, share);
  return shares;
}

export type DayTaskLoad = {
  /** Dagtaken: blokken en taken met alleen een dag. */
  minutes: number;
  /** Het aandeel van weekstroken: een verdeling, geen meting (vandaar de ±). */
  spanMinutes: number;
};

/** Wat je taken per dag aan tijd vragen. Afgeronde taken horen er niet in; dat filtert de aanroeper. */
export function taskLoadByDay(
  dayKeys: string[],
  tasks: Task[],
  workday: Workday,
  linksFor: (taskId: string) => CalendarEventLink[],
): Map<string, DayTaskLoad> {
  const byDay = new Map<string, DayTaskLoad>();
  for (const key of dayKeys) byDay.set(key, { minutes: 0, spanMinutes: 0 });
  for (const task of tasks) {
    if (!task.planned_date) continue;
    if (isSpanningTask(task)) {
      for (const [key, share] of spanShares(task, dayKeys, workday, linksFor(task.id))) byDay.get(key)!.spanMinutes += share;
      continue;
    }
    const bucket = byDay.get(task.planned_date);
    if (bucket) bucket.minutes += dayTaskMinutes(task, task.planned_date, linksFor(task.id));
  }
  return byDay;
}

export type NetDay = {
  key: string;
  /** Is het een werkdag? Zo niet, dan is er geen werktijd en dus geen "vrij". */
  counts: boolean;
  workMinutes: number;
  meetingMinutes: number;
  taskMinutes: number;
  /** Werktijd min afspraken, nooit onder nul: de tijd die er is voor taken. */
  netMinutes: number;
  /** Netto tijd min taken; negatief is te veel. `null` op een dag die niet meetelt. */
  freeMinutes: number | null;
};

export function netDay(key: string, workday: Workday, meetingMinutes: number, taskMinutes: number): NetDay {
  const counts = isWorkday(key, workday);
  const work = counts ? workday.minutes : 0;
  const meetings = Math.max(0, meetingMinutes);
  const tasks = Math.max(0, taskMinutes);
  return {
    key,
    counts,
    workMinutes: work,
    meetingMinutes: meetings,
    taskMinutes: tasks,
    netMinutes: Math.max(0, work - meetings),
    freeMinutes: counts ? work - meetings - tasks : null,
  };
}

export type NetWeek = {
  /** Over de werkdagen van de week. */
  workMinutes: number;
  meetingMinutes: number;
  taskMinutes: number;
  netMinutes: number;
  /** Netto min taken; negatief is te veel. */
  freeMinutes: number;
  /** Afspraken en taken op dagen die niet meetellen (het weekend, tenzij dat meetelt). */
  offDayMinutes: number;
};

/**
 * De week bij elkaar: alleen de werkdagen tellen. Eerder telden afspraken en
 * taken in het weekend mee tegen een streep die het weekend niet kende, en
 * stond er minder vrij dan er was.
 *
 * Op weekniveau mag een drukke dag een rustige compenseren: tien uur meetings op
 * maandag maakt de week niet langer. Daarom is de week de som, niet de som van
 * per dag afgeronde getallen.
 */
export function netWeek(days: NetDay[]): NetWeek {
  let work = 0;
  let meetings = 0;
  let tasks = 0;
  let offDay = 0;
  for (const day of days) {
    if (!day.counts) { offDay += day.meetingMinutes + day.taskMinutes; continue; }
    work += day.workMinutes;
    meetings += day.meetingMinutes;
    tasks += day.taskMinutes;
  }
  return {
    workMinutes: work,
    meetingMinutes: meetings,
    taskMinutes: tasks,
    netMinutes: Math.max(0, work - meetings),
    freeMinutes: work - meetings - tasks,
    offDayMinutes: offDay,
  };
}

/**
 * Tot hoe laat zet "Vul mijn week" werk neer? Negen uur plus je werktijd, en
 * minstens tot vijf. Met een werkdag van tien uur bleef het venster op 09:00 –
 * 17:00 staan en paste er nooit meer dan acht uur in.
 */
export function autoPlanWindowEnd(workday: Workday, start = 9 * 60): number {
  return Math.min(23 * 60, Math.max(17 * 60, start + workday.minutes));
}
