/**
 * Hoe vol een dag zit, voor het balkje boven elke dag in de maandweergave.
 *
 * In de maand kapt een volle dag af met "+3 meer". Wat erachter zit, zag je
 * dan niet: een dag met vier korte belletjes en een dag met drie
 * werksessies van drie uur leken even druk. Dit telt de uren die echt bezet
 * zijn, per agendakleur, zodat het balkje laat zien hoe vol de dag is en uit
 * welke agenda's dat komt.
 *
 * Bewust zonder React, zodat `npm test` het kan nalopen.
 */

export type OccupancyEvent = { starts_at: string; ends_at: string; all_day?: boolean | null };

export type DayOccupancy = {
  /** Bezette minuten op deze dag. Overlappende afspraken tellen één keer. */
  minutes: number;
  /** Dezelfde minuten per agendakleur, in de volgorde van de dag. */
  segments: { color: string; minutes: number }[];
};

/** Zonder eigen dagstreep (de planner) is een werkdag acht uur. */
export const DEFAULT_DAY_CAPACITY_MINUTES = 8 * 60;

/**
 * De bezetting van één lokale kalenderdag.
 *
 * Hele-dag-afspraken tellen niet mee: een verjaardag of "kantoor dicht" maakt
 * je niet bezet, en Google telt ze ook als vrij. Overlap telt één keer; die
 * tijd hoort bij de afspraak die het eerst begon. Eerst opgeteld per afspraak
 * stond een dag met twee gelijktijdige gesprekken op dubbel zoveel uur.
 */
export function dayOccupancy<E extends OccupancyEvent>(day: Date, events: readonly E[], colorOf: (event: E) => string): DayOccupancy {
  // Middernacht tot middernacht in lokale tijd; zo heeft een dag met de
  // omschakeling naar zomer- of wintertijd 23 of 25 uur, zoals in het echt.
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();

  const parts: { start: number; end: number; color: string }[] = [];
  for (const event of events) {
    if (event.all_day) continue;
    const start = Math.max(new Date(event.starts_at).getTime(), dayStart);
    const end = Math.min(new Date(event.ends_at).getTime(), dayEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    parts.push({ start, end, color: colorOf(event) });
  }
  parts.sort((a, b) => a.start - b.start || b.end - a.end);

  const perColor = new Map<string, number>();
  let covered = dayStart;
  let totalMs = 0;
  for (const part of parts) {
    const from = Math.max(part.start, covered);
    if (part.end <= from) continue;
    const ms = part.end - from;
    totalMs += ms;
    perColor.set(part.color, (perColor.get(part.color) ?? 0) + ms);
    covered = part.end;
  }

  return {
    minutes: Math.round(totalMs / 60000),
    segments: [...perColor].map(([color, ms]) => ({ color, minutes: Math.round(ms / 60000) })).filter(s => s.minutes > 0),
  };
}

/** "45m", "3u", "5u 30m" — kort genoeg voor een tooltip boven een dag. */
export function formatOccupancy(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}u` : `${h}u ${m}m`;
}
