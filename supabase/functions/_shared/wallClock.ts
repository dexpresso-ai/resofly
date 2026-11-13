// Rekenen op de wandklok: herhalende afspraken, zomer- en wintertijd.
//
// Een reeks "elke maandag 9.00 uur" hoort het hele jaar om 9.00 uur te staan.
// Tot november 2026 telde ResoFly vanaf het eerste begin hele dagen in UTC op:
// een reeks uit de winter stond na de klokwissel van maart om 10.00 uur, in de
// app, bij de boekingslinks en op de telefoon. Hier tellen we op in de
// tijdzone van de afspraak (de datum en de kloktijd), en rekenen daarna pas
// terug naar UTC.
//
// Zonder imports: de edge functions (calendarCore.ts, calendarAvailability.ts)
// en de agendaserver (workers/caldav) gebruiken dezelfde code, zodat de app en
// de telefoon hetzelfde uitrekenen.

export interface WallClock {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

/** Waar een reeks op valt als niets anders bekend is: de agenda's van ResoFly staan op Amsterdam. */
export const DEFAULT_TIME_ZONE = 'Europe/Amsterdam';

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Datum en kloktijd van een moment in een tijdzone. */
export function wallClock(ms: number, timeZone: string): WallClock {
  const millisecond = ((ms % 1000) + 1000) % 1000;
  if (timeZone === 'UTC') {
    const d = new Date(ms);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), millisecond };
  }
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second, millisecond };
}

function asUtc(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond);
}

/** Hoeveel de tijdzone op dat moment voor UTC loopt, in milliseconden (Amsterdam: 1 of 2 uur). */
export function utcOffsetMs(ms: number, timeZone: string): number {
  if (timeZone === 'UTC') return 0;
  return asUtc(wallClock(ms, timeZone)) - ms;
}

function sameWall(a: WallClock, b: WallClock): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * Het moment (UTC, in ms) van een datum en kloktijd in een tijdzone. Zoals
 * RFC 5545 §3.3.5 het wil:
 * - een kloktijd die twee keer voorkomt (oktober, 2.30 uur): de eerste;
 * - een kloktijd die niet bestaat (maart, 2.30 uur): met de verschuiving van
 *   vóór de wissel, dus 3.30 uur zomertijd.
 */
export function wallClockToUtcMs(w: WallClock, timeZone: string): number {
  const naive = asUtc(w);
  if (timeZone === 'UTC') return naive;
  const before = utcOffsetMs(naive - 86_400_000, timeZone);
  const after = utcOffsetMs(naive + 86_400_000, timeZone);
  const candidates = [...new Set([naive - before, naive - after])]
    .filter(t => sameWall(wallClock(t, timeZone), w))
    .sort((a, b) => a - b);
  return candidates.length ? candidates[0] : naive - before;
}

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  /** ISO; de reeks stopt ná dit moment. */
  until: string | null;
  count: number | null;
}

/**
 * De begintijden (UTC, ms) van een reeks die (deels) in het venster vallen.
 * Elke keer telt vanaf het eerste begin op de wandklok: dezelfde kloktijd,
 * ook na een klokwissel. Een maand zonder die dag (de 31e in april) slaat de
 * reeks over, zoals een telefoon doet (RFC 5545); eerst schoof hij door naar
 * de 1e van de maand erna, en liep de reeks daarna voorgoed scheef.
 */
export function recurrenceStarts(
  startMs: number,
  durationMs: number,
  rule: RecurrenceRule,
  timeZone: string,
  windowStartMs: number,
  windowEndMs: number,
  excluded: ReadonlySet<number> = new Set(),
): number[] {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const base = wallClock(startMs, tz);
  const interval = Math.max(1, Math.floor(rule.interval) || 1);
  const untilMs = rule.until ? Date.parse(rule.until) : NaN;
  const stepDays = rule.freq === 'DAILY' ? interval : rule.freq === 'WEEKLY' ? 7 * interval : 0;
  const out: number[] = [];

  // Dagen en weken: meteen naar vlak voor het venster. Eerst liep de lus altijd
  // vanaf het eerste begin, met een grens van 800 keer: een dagelijkse reeks
  // van meer dan twee jaar oud verdween dan uit de agenda.
  let n = 0;
  if (stepDays) {
    const skip = Math.floor((windowStartMs - durationMs - startMs) / (stepDays * 86_400_000)) - 1;
    if (skip > 0) n = skip;
  }
  let generated = n; // bij dagen en weken valt er nooit een keer uit
  for (let guard = 0; guard < 2000; guard++, n++) {
    let wall: WallClock;
    if (stepDays) {
      const d = new Date(Date.UTC(base.year, base.month - 1, base.day + n * stepDays));
      wall = { ...base, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    } else {
      const d = new Date(Date.UTC(base.year, base.month - 1 + n * interval, 1));
      const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      if (base.day > daysInMonth) continue;
      wall = { ...base, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    }
    if (rule.count && generated >= rule.count) break;
    const ms = wallClockToUtcMs(wall, tz);
    if (Number.isFinite(untilMs) && ms > untilMs) break;
    if (ms > windowEndMs) break;
    generated += 1;
    if (ms + durationMs >= windowStartMs && !excluded.has(ms)) out.push(ms);
  }
  return out;
}

/* ── iCalendar ──────────────────────────────────────────────────────── */

const p2 = (n: number) => String(n).padStart(2, '0');

/** "20261116T090000": een kloktijd zonder zone, voor DTSTART;TZID=…. */
export function icsWallClock(ms: number, timeZone: string): string {
  const w = wallClock(ms, timeZone);
  return `${String(w.year).padStart(4, '0')}${p2(w.month)}${p2(w.day)}T${p2(w.hour)}${p2(w.minute)}${p2(w.second)}`;
}

function icsOffset(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${p2(Math.floor(abs / 60))}${p2(abs % 60)}`;
}

interface Transition { utcMs: number; from: number; to: number }

/** De klokwissels van één jaar: zoek per week, en dan op de minuut nauwkeurig. */
function transitionsInYear(year: number, timeZone: string): Transition[] {
  const out: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let t = Date.UTC(year, 0, 1);
  let offset = utcOffsetMs(t, timeZone);
  while (t < end) {
    const next = Math.min(t + 7 * 86_400_000, end);
    const nextOffset = utcOffsetMs(next, timeZone);
    if (nextOffset !== offset) {
      let lo = t;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
        if (utcOffsetMs(mid, timeZone) === offset) lo = mid; else hi = mid;
      }
      out.push({ utcMs: hi, from: offset, to: nextOffset });
    }
    t = next;
    offset = nextOffset;
  }
  return out;
}

// "CET" en "CEST" kent alleen de Britse notatie; de Amerikaanse zegt "GMT+1".
function zoneAbbreviation(ms: number, timeZone: string): string | null {
  for (const locale of ['en-US', 'en-GB']) {
    try {
      const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName');
      if (part && /^[A-Z]{2,5}$/.test(part.value)) return part.value;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Een VTIMEZONE voor een IANA-zone, zodat een telefoon of agenda-app een reeks
 * met TZID op dezelfde kloktijd houdt als ResoFly. Met een jaarregel als de
 * wissel elk jaar op dezelfde soort zondag valt (Europa: de laatste van maart
 * en oktober), anders met de losse data.
 */
export function vtimezoneLines(timeZone: string, fromYear: number): string[] {
  if (!isValidTimeZone(timeZone) || timeZone === 'UTC') return [];
  const years = [fromYear, fromYear + 1, fromYear + 2, fromYear + 3];
  const all = years.flatMap(y => transitionsInYear(y, timeZone));
  const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`];
  if (!all.length) {
    const offset = icsOffset(utcOffsetMs(Date.UTC(fromYear, 0, 1), timeZone));
    const name = zoneAbbreviation(Date.UTC(fromYear, 0, 1), timeZone);
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, ...(name ? [`TZNAME:${name}`] : []), 'END:STANDARD');
    lines.push('END:VTIMEZONE');
    return lines;
  }
  for (const kind of ['DAYLIGHT', 'STANDARD'] as const) {
    const list = all.filter(t => (kind === 'DAYLIGHT' ? t.to > t.from : t.to < t.from));
    if (!list.length) continue;
    const first = list[0];
    // De kloktijd van de wissel, zoals de klok hem vóór de wissel aangaf (2.00 uur in maart).
    const local = (t: Transition) => icsWallClock(t.utcMs + t.from, 'UTC');
    lines.push(`BEGIN:${kind}`, `DTSTART:${local(first)}`, `TZOFFSETFROM:${icsOffset(first.from)}`, `TZOFFSETTO:${icsOffset(first.to)}`);
    const rule = yearlyRule(list.map(t => new Date(t.utcMs + t.from)));
    if (rule) {
      lines.push(`RRULE:${rule}`);
    } else {
      const more: string[] = [];
      for (let y = fromYear + 4; y <= fromYear + 30; y++) {
        for (const t of transitionsInYear(y, timeZone)) if ((kind === 'DAYLIGHT') === (t.to > t.from)) more.push(local(t));
      }
      const rdates = [...list.slice(1).map(local), ...more];
      if (rdates.length) lines.push(`RDATE:${rdates.join(',')}`);
    }
    const name = zoneAbbreviation(first.utcMs + 3_600_000, timeZone);
    if (name) lines.push(`TZNAME:${name}`);
    lines.push(`END:${kind}`);
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** "FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU" als alle wissels dezelfde soort dag zijn, anders null. */
function yearlyRule(localOnsets: Date[]): string | null {
  if (localOnsets.length < 2) return null;
  const month = localOnsets[0].getUTCMonth();
  const weekday = localOnsets[0].getUTCDay();
  const time = localOnsets[0].getUTCHours() * 3600 + localOnsets[0].getUTCMinutes() * 60;
  const same = localOnsets.every(d => d.getUTCMonth() === month && d.getUTCDay() === weekday && d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 === time);
  if (!same) return null;
  const nth = localOnsets.map(d => Math.ceil(d.getUTCDate() / 7));
  const last = localOnsets.map(d => d.getUTCDate() + 7 > new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate());
  let byday: string | null = null;
  if (nth.every(n => n === nth[0]) && nth[0] <= 4) byday = `${nth[0]}${WEEKDAYS[weekday]}`;
  else if (last.every(Boolean)) byday = `-1${WEEKDAYS[weekday]}`;
  return byday ? `FREQ=YEARLY;BYMONTH=${month + 1};BYDAY=${byday}` : null;
}
