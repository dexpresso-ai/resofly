// ============================================================
// Het ritme van een agent: wanneer draait hij de volgende keer?
//
// Stond in de runner zelf; hier, zonder Deno-afhankelijkheden, zodat node de
// test ernaast kan draaien — net als schedule.ts, waar de DST-rekensom vandaan
// komt. Vijf ritmes:
//   daily    — elke dag om hh:mm
//   weekdays — elke werkdag (ma-vr) om hh:mm
//   weekly   — één vaste dag per week om hh:mm
//   monthly  — één dag per maand (de 31e wordt in een korte maand de laatste dag)
//   hourly   — elk uur op werkdagen, van `hour` tot en met `end_hour`, op :mm
// Alles in de wandklok van de agent (standaard Europe/Amsterdam): "08:30"
// blijft 08:30, ook in de nacht van de klokwissel.
// ============================================================

import { daysInMonth, localYmd, wallToUtc } from './schedule.ts';

export const SCHEDULE_KINDS = ['daily', 'weekdays', 'weekly', 'monthly', 'hourly'] as const;
export type ScheduleKind = typeof SCHEDULE_KINDS[number];

export function isScheduleKind(value: unknown): value is ScheduleKind {
  return typeof value === 'string' && (SCHEDULE_KINDS as readonly string[]).includes(value);
}

/** De velden van een agent waar het ritme uit volgt (rauw uit de database of een request). */
export interface AgentScheduleFields {
  schedule_kind?: unknown;
  hour?: unknown;
  minute?: unknown;
  end_hour?: unknown;
  day_of_week?: unknown;
  day_of_month?: unknown;
  timezone?: unknown;
}

/** Het ritme, opgeschoond: elk getal binnen zijn grenzen, elk ontbrekend veld ingevuld. */
export interface AgentSchedule {
  kind: ScheduleKind;
  hour: number;
  minute: number;
  /** Alleen bij hourly: het laatste uur van het venster (nooit vóór `hour`). */
  endHour: number | null;
  /** Alleen bij weekly: ISO 1=maandag t/m 7=zondag. */
  dayOfWeek: number | null;
  /** Alleen bij monthly: 1-31. */
  dayOfMonth: number | null;
  timezone: string;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeSchedule(fields: AgentScheduleFields): AgentSchedule {
  const kind: ScheduleKind = isScheduleKind(fields.schedule_kind) ? fields.schedule_kind : 'weekly';
  const hour = clampInt(fields.hour, 8, 0, 23);
  return {
    kind,
    hour,
    minute: clampInt(fields.minute, 0, 0, 59),
    // Een venster dat eindigt vóór het begint, is één run per dag — niet nul.
    endHour: kind === 'hourly' ? Math.max(hour, clampInt(fields.end_hour, 17, 0, 23)) : null,
    dayOfWeek: kind === 'weekly' ? clampInt(fields.day_of_week, 1, 1, 7) : null,
    dayOfMonth: kind === 'monthly' ? clampInt(fields.day_of_month, 1, 1, 31) : null,
    timezone: typeof fields.timezone === 'string' && fields.timezone.trim() ? fields.timezone.trim() : 'Europe/Amsterdam',
  };
}

/** ISO-weekdag (1=maandag t/m 7=zondag) van een kalenderdatum. */
function isoWeekday(y: number, m: number, d: number): number {
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** Eerstvolgende run-moment ná `after`, in UTC. */
export function computeNextRunAt(fields: AgentScheduleFields, after: Date): Date {
  const s = normalizeSchedule(fields);
  const base = localYmd(s.timezone, after);

  for (let offset = 0; offset <= 400; offset += 1) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + offset));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const weekday = isoWeekday(y, m, d);

    let matches = false;
    if (s.kind === 'daily') matches = true;
    else if (s.kind === 'weekdays' || s.kind === 'hourly') matches = weekday <= 5;
    else if (s.kind === 'weekly') matches = weekday === s.dayOfWeek;
    else if (s.kind === 'monthly') matches = d === Math.min(s.dayOfMonth ?? 1, daysInMonth(y, m));
    if (!matches) continue;

    const lastHour = s.kind === 'hourly' ? (s.endHour ?? s.hour) : s.hour;
    for (let hour = s.hour; hour <= lastHour; hour += 1) {
      const candidate = wallToUtc(s.timezone, y, m, d, hour, s.minute);
      if (candidate.getTime() > after.getTime()) return candidate;
    }
  }
  // Vangnet; met een geldig ritme komen we hier niet.
  return new Date(after.getTime() + 86_400_000);
}
