import type { CalendarEventLink, CalendarExternalEvent, UUID } from '../types';

/**
 * Afspraak ↔ taak.
 *
 * Een agenda-koppeling (`calendar_event_links`) hangt sinds 2026-09 ook aan een
 * taak. Wat hier staat is het rekenwerk dat de weekplanner, de agenda en het
 * taakvenster delen: welke koppeling hoort bij welke afspraak, hoeveel minuten
 * van een afspraak vallen op een dag, en hoe je zo'n koppeling kort opschrijft.
 *
 * Bewust zonder imports uit `dates.ts` of `planning.ts`: dan draait dit
 * bestand rechtstreeks onder de Node-testrunner (`npm test`).
 */

/** Dezelfde identiteit als de UI: provider + agenda + event-id + starttijd. */
export function calendarEventLinkMatchesEvent(link: CalendarEventLink, event: CalendarExternalEvent): boolean {
  return link.provider === event.provider
    && link.calendar_source_id === event.source_id
    && link.provider_event_id === event.provider_event_id
    && new Date(link.event_starts_at).getTime() === new Date(event.starts_at).getTime();
}

/** Sleutel waarmee een afspraak-instantie in een Map of als dropzone te vinden is. */
export function calendarEventKey(event: Pick<CalendarExternalEvent, 'provider' | 'source_id' | 'provider_event_id' | 'starts_at'>): string {
  return `${event.provider}|${event.source_id}|${event.provider_event_id}|${new Date(event.starts_at).getTime()}`;
}

/** Zelfde sleutel, maar vanuit de koppeling — zodat beide kanten elkaar vinden. */
export function calendarLinkKey(link: CalendarEventLink): string {
  return `${link.provider}|${link.calendar_source_id}|${link.provider_event_id}|${new Date(link.event_starts_at).getTime()}`;
}

/** Alle koppelingen per taak, gesorteerd op starttijd. */
export function groupLinksByTask(links: CalendarEventLink[]): Map<UUID, CalendarEventLink[]> {
  const byTask = new Map<UUID, CalendarEventLink[]>();
  for (const link of links) {
    if (!link.task_id) continue;
    const list = byTask.get(link.task_id) ?? [];
    list.push(link);
    byTask.set(link.task_id, list);
  }
  for (const list of byTask.values()) list.sort((a, b) => a.event_starts_at.localeCompare(b.event_starts_at));
  return byTask;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Lokale kalenderdag (jjjj-mm-dd) van een tijdstip — zoals de gebruiker zijn agenda leest. */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Hoeveel minuten van deze koppelingen vallen op één kalenderdag? Een afspraak
 * over middernacht wordt per dag geknipt, net als in `groupEventMinutesByDay`.
 * Hele-dag-items tellen niet: ze claimen geen blok in je dag.
 *
 * Hiermee corrigeert de weekplanner de dubbeltelling: een taak van vier uur met
 * een gekoppelde meeting van anderhalf uur op dezelfde dag telt nog 2u30 als
 * taak, want die 1u30 staat al in de agendabalk.
 */
export function linkedMinutesOnDay(links: CalendarEventLink[], dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  const dayStart = new Date(year, (month ?? 1) - 1, day ?? 1);
  const dayEnd = new Date(year, (month ?? 1) - 1, (day ?? 1) + 1);
  let total = 0;
  for (const link of links) {
    if (link.event_all_day || !link.event_ends_at) continue;
    const start = new Date(link.event_starts_at);
    const end = new Date(link.event_ends_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    const overlapStart = start > dayStart ? start : dayStart;
    const overlapEnd = end < dayEnd ? end : dayEnd;
    const minutes = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 60000);
    if (minutes > 0) total += minutes;
  }
  return total;
}

/** Wat een taak op een dag nog aan eigen schatting overhoudt náást zijn afspraken. */
export function remainingEstimateOnDay(estimateMinutes: number, links: CalendarEventLink[], dayKey: string): number {
  return Math.max(0, estimateMinutes - linkedMinutesOnDay(links, dayKey));
}

const DAY_SHORT_NL = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'] as const;
const MONTH_SHORT_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'] as const;

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "di 10:00–11:30" — kort genoeg voor een pil op de kaart. Hele dag: "di · hele dag". */
export function formatLinkShort(link: Pick<CalendarEventLink, 'event_starts_at' | 'event_ends_at' | 'event_all_day'>): string {
  const start = new Date(link.event_starts_at);
  const day = DAY_SHORT_NL[start.getDay()];
  if (link.event_all_day) return `${day} · hele dag`;
  const end = link.event_ends_at ? timeLabel(link.event_ends_at) : null;
  return end ? `${day} ${timeLabel(link.event_starts_at)}–${end}` : `${day} ${timeLabel(link.event_starts_at)}`;
}

/** "di 8 sep · 10:00–11:30" — voor het taakvenster, waar ruimte is voor de datum. */
export function formatLinkWhen(link: Pick<CalendarEventLink, 'event_starts_at' | 'event_ends_at' | 'event_all_day'>): string {
  const start = new Date(link.event_starts_at);
  const date = `${DAY_SHORT_NL[start.getDay()]} ${start.getDate()} ${MONTH_SHORT_NL[start.getMonth()]}`;
  if (link.event_all_day) return `${date} · hele dag`;
  const end = link.event_ends_at ? timeLabel(link.event_ends_at) : null;
  return end ? `${date} · ${timeLabel(link.event_starts_at)}–${end}` : `${date} · ${timeLabel(link.event_starts_at)}`;
}

/** Duur van de gekoppelde afspraak in minuten; nul voor hele-dag-items of zonder eind. */
export function linkMinutes(link: Pick<CalendarEventLink, 'event_starts_at' | 'event_ends_at' | 'event_all_day'>): number {
  if (link.event_all_day || !link.event_ends_at) return 0;
  const minutes = Math.round((new Date(link.event_ends_at).getTime() - new Date(link.event_starts_at).getTime()) / 60000);
  return minutes > 0 ? minutes : 0;
}
