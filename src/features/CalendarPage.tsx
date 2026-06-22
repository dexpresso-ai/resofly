import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, Clock, ExternalLink, LayoutList, MapPin, Plus, RefreshCcw, Unplug, X } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { RichTextExcerpt } from '../components/RichTextEditor';
import { addDays, DAY_NAMES_NL, formatISODate, isSameDay, parseISODate, startOfWeek } from '../lib/dates';
import { dateNL } from '../lib/format';
import {
  createExternalCalendarEvent,
  disconnectCalendarConnection,
  getCalendarOAuthUrl,
  listExternalCalendarEvents,
  loadCalendarIntegrations,
  refreshCalendarSources,
  updateCalendarSource,
  type CalendarIntegrationsPayload,
} from '../lib/calendar-api';
import type { AppData, CalendarEventLink, CalendarExternalEvent, CalendarProvider, CalendarSource, CalendarVisibility, Client, Note, NoteCalendarLink, Project, Task, UUID } from '../types';
import { getNoteTypeLabel } from './Notes';

/* ── Constants & helpers ─────────────────────────────────────────────── */

const HOUR_START = 0;
const HOUR_END = 24;
const WORKDAY_START = 8;
const WORKDAY_END = 18;
const SLOT_MINUTES = 30;
const TOTAL_SLOTS = (HOUR_END - HOUR_START) * (60 / SLOT_MINUTES);
const MIN_EVENT_HEIGHT_SLOTS = 0.85;
// De volledige dag (00:00-24:00) blijft scrollbaar zodat ook de vroege/late uren
// bereikbaar zijn. De rijhoogte schaalt zo dat de WERKDAG de zichtbare hoogte
// vult (ruime, schermvullende blokken); de grid scrollt voor de overige uren en
// opent automatisch op de werkdag-start.
const WORKDAY_SLOTS = (WORKDAY_END - WORKDAY_START) * (60 / SLOT_MINUTES);
const MIN_ROW_HEIGHT = 24;
const MAX_ROW_HEIGHT = 52;

function toInputDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputDateTimeToIso(value: string): string {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

function formatTime(value: string, allDay?: boolean): string {
  if (allDay) return 'Hele dag';
  return new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dateKeyFromValue(value?: string | null): string {
  if (!value) return formatISODate(new Date());
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? formatISODate(new Date()) : formatISODate(parsed);
}

function addDateKeyDays(dateKey: string, days: number): string {
  return formatISODate(addDays(parseISODate(dateKey), days));
}

function formatDateKey(dateKey: string): string {
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(parseISODate(dateKey));
}

function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value));
}

function allDayStartDateKey(event: CalendarExternalEvent): string {
  return dateKeyFromValue(event.starts_at);
}

function allDayEndDateKeyExclusive(event: CalendarExternalEvent): string {
  const start = allDayStartDateKey(event);
  const end = dateKeyFromValue(event.ends_at);
  return end <= start ? addDateKeyDays(start, 1) : end;
}

function formatEventRange(event: CalendarExternalEvent): string {
  if (event.all_day) {
    const start = allDayStartDateKey(event);
    const endExclusive = allDayEndDateKeyExclusive(event);
    const lastVisibleDay = addDateKeyDays(endExclusive, -1);
    if (lastVisibleDay <= start) return `${formatDateKey(start)} · hele dag`;
    return `${formatDateKey(start)} – ${formatDateKey(lastVisibleDay)} · hele dag`;
  }
  const sameDay = isSameDay(new Date(event.starts_at), new Date(event.ends_at));
  if (sameDay) return `${formatDateOnly(event.starts_at)} · ${formatTime(event.starts_at)} – ${formatTime(event.ends_at)}`;
  return `${formatDateOnly(event.starts_at)} ${formatTime(event.starts_at)} – ${formatDateOnly(event.ends_at)} ${formatTime(event.ends_at)}`;
}

function formatHour(hour: number, minutes: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function startOfDay(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  return result;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  const result = startOfMonth(d);
  result.setMonth(result.getMonth() + n);
  return result;
}

function dayNameNl(day: Date): string {
  return DAY_NAMES_NL[(day.getDay() + 6) % 7];
}

function monthLabelNl(day: Date): string {
  return new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric' }).format(day);
}

function fullDateLabelNl(day: Date): string {
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(day);
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function dayBounds(day: Date): { start: Date; end: Date } {
  const start = startOfDay(day);
  return { start, end: addDays(start, 1) };
}

function visibleTimeBounds(day: Date): { start: Date; end: Date } {
  const start = startOfDay(day);
  start.setHours(HOUR_START, 0, 0, 0);
  const end = startOfDay(day);
  end.setHours(HOUR_END, 0, 0, 0);
  return { start, end };
}

function eventOverlapsDay(event: CalendarExternalEvent, day: Date): boolean {
  if (event.all_day) {
    // Google and Microsoft both use an exclusive end date for all-day events.
    // Keep the comparison date-only so UTC/local timezone conversion can never
    // leak a holiday into the next day in NL time.
    const dayKey = formatISODate(day);
    const startKey = allDayStartDateKey(event);
    const endKeyExclusive = allDayEndDateKeyExclusive(event);
    return startKey <= dayKey && dayKey < endKeyExclusive;
  }
  const { start, end } = dayBounds(day);
  const eventStart = new Date(event.starts_at);
  const eventEnd = new Date(event.ends_at);
  return eventStart < end && eventEnd > start;
}

function calendarDaysForView(view: CalendarView, anchor: Date): Date[] {
  if (view === 'day') return [startOfDay(anchor)];
  if (view === 'month') {
    const monthStart = startOfMonth(anchor);
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const gridStart = startOfWeek(monthStart);
    const daysToSunday = monthEnd.getDay() === 0 ? 0 : 7 - monthEnd.getDay();
    const gridEnd = addDays(monthEnd, daysToSunday);
    const dayCount = Math.round((startOfDay(gridEnd).getTime() - startOfDay(gridStart).getTime()) / 86400000) + 1;
    return Array.from({ length: dayCount }, (_, i) => addDays(gridStart, i));
  }
  const weekStart = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

function providerLabel(p: CalendarProvider): string { return p === 'google' ? 'Google' : 'Microsoft'; }
function providerClass(p: CalendarProvider): string { return p === 'google' ? 'provider-google' : 'provider-microsoft'; }
function visibilityLabel(v: CalendarVisibility): string { return v === 'organization' ? 'Gedeeld met organisatie' : 'Privé'; }

function normalizeHexColor(color?: string | null): string {
  if (!color) return '#FFD966';
  const trimmed = color.trim();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  return '#FFD966';
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = normalizeHexColor(hex).slice(1);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function eventColorStyle(color?: string | null): CSSProperties {
  const c = normalizeHexColor(color);
  return {
    '--event-color': c,
    '--event-bg': hexToRgba(c, 0.62),
    '--event-border': hexToRgba(c, 0.88),
    '--event-border-soft': hexToRgba(c, 0.72),
  } as CSSProperties;
}

function timeValue(value?: string | null): number {
  if (!value) return Number.NaN;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function noteCalendarLinkMatchesEvent(link: NoteCalendarLink, event: CalendarExternalEvent): boolean {
  return link.provider === event.provider
    && link.calendar_source_id === event.source_id
    && link.provider_event_id === event.provider_event_id
    && timeValue(link.event_starts_at) === timeValue(event.starts_at);
}

function calendarEventLinkMatchesEvent(link: CalendarEventLink, event: CalendarExternalEvent): boolean {
  return link.provider === event.provider
    && link.calendar_source_id === event.source_id
    && link.provider_event_id === event.provider_event_id
    && timeValue(link.event_starts_at) === timeValue(event.starts_at);
}

/**
 * Klant- en projectkeuze voor een agenda-item. Het projectmenu filtert op de
 * gekozen klant; bij het kiezen van een project wordt de klant automatisch
 * afgeleid als die nog leeg is. Wordt gebruikt bij het aanmaken én bij het
 * bewerken van de koppeling in het eventdetail.
 */
function ClientProjectPicker({ clients, projects, clientId, projectId, onChange, disabled = false }: {
  clients: Client[];
  projects: Project[];
  clientId: string;
  projectId: string;
  onChange: (next: { clientId: string; projectId: string }) => void;
  disabled?: boolean;
}) {
  const sortedClients = useMemo(() => [...clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [clients]);
  const projectOptions = useMemo(
    () => projects
      .filter(p => !p.archived && (!clientId || p.client_id === clientId))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl')),
    [projects, clientId],
  );
  return (
    <div className="settings-grid compact">
      <label>Klant
        <Select value={clientId} disabled={disabled} onChange={e => {
          const nextClient = e.target.value;
          const keepProject = projectId && projects.find(p => p.id === projectId)?.client_id === nextClient;
          onChange({ clientId: nextClient, projectId: keepProject ? projectId : '' });
        }}>
          <option value="">Geen klant</option>
          {sortedClients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </label>
      <label>Project
        <Select value={projectId} disabled={disabled} onChange={e => {
          const nextProject = e.target.value;
          const proj = projects.find(p => p.id === nextProject);
          onChange({ clientId: clientId || (proj?.client_id ?? ''), projectId: nextProject });
        }}>
          <option value="">Geen project</option>
          {projectOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </label>
    </div>
  );
}

function slotToTime(slot: number): { hour: number; minutes: number } {
  const totalMin = HOUR_START * 60 + slot * SLOT_MINUTES;
  return { hour: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}

function dateToDayFraction(day: Date, d: Date): number {
  const { start, end } = dayBounds(day);
  const time = d.getTime();
  if (time <= start.getTime()) return 0;
  if (time >= end.getTime()) return 1;
  return (time - start.getTime()) / (end.getTime() - start.getTime());
}

function dateToVisibleDayFraction(day: Date, d: Date): number {
  const { start, end } = visibleTimeBounds(day);
  const time = d.getTime();
  if (time <= start.getTime()) return 0;
  if (time >= end.getTime()) return 1;
  return (time - start.getTime()) / (end.getTime() - start.getTime());
}

function eventOverlapsVisibleWindow(event: CalendarExternalEvent, day: Date): boolean {
  if (event.all_day) return false;
  const { start, end } = visibleTimeBounds(day);
  const eventStart = new Date(event.starts_at);
  const eventEnd = new Date(event.ends_at);
  return eventStart < end && eventEnd > start;
}

type CalendarView = 'day' | 'week' | 'month' | 'list';

interface DragState { dayIndex: number; startSlot: number; endSlot: number }

/* ── TimeBlockGrid ───────────────────────────────────────────────────── */

const MAX_OVERLAP_COLS = 2;

type TimedEventSegment = {
  event: CalendarExternalEvent;
  startMinute: number;
  endMinute: number;
  top: number;
  height: number;
  column: number;
  columns: number;
  startsBeforeDay: boolean;
  endsAfterDay: boolean;
};

type OverflowChip = { top: number; count: number };

function layoutTimedEventsForDay(
  day: Date,
  events: CalendarExternalEvent[],
): { segments: TimedEventSegment[]; overflows: OverflowChip[] } {
  const { start: visibleStartBound, end: visibleEndBound } = visibleTimeBounds(day);
  const minutesInWindow = (HOUR_END - HOUR_START) * 60;
  const raw = events
    .filter(ev => eventOverlapsVisibleWindow(ev, day))
    .map(ev => {
      const eventStart = new Date(ev.starts_at);
      const eventEnd = new Date(ev.ends_at);
      const visibleStart = new Date(Math.max(eventStart.getTime(), visibleStartBound.getTime()));
      const visibleEnd = new Date(Math.min(eventEnd.getTime(), visibleEndBound.getTime()));
      const startMinute = Math.max(0, Math.round((visibleStart.getTime() - visibleStartBound.getTime()) / 60000));
      const endMinute = Math.max(startMinute + 15, Math.min(minutesInWindow, Math.round((visibleEnd.getTime() - visibleStartBound.getTime()) / 60000)));
      const top = dateToVisibleDayFraction(day, visibleStart) * 100;
      const height = Math.max(dateToVisibleDayFraction(day, visibleEnd) * 100 - top, (100 / TOTAL_SLOTS) * MIN_EVENT_HEIGHT_SLOTS);
      return { event: ev, startMinute, endMinute, top, height, column: 0, columns: 1, startsBeforeDay: eventStart < visibleStartBound, endsAfterDay: eventEnd > visibleEndBound };
    })
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);

  const clusters: TimedEventSegment[][] = [];
  let current: TimedEventSegment[] = [];
  let currentEnd = -1;

  raw.forEach(segment => {
    if (!current.length || segment.startMinute < currentEnd) {
      current.push(segment);
      currentEnd = Math.max(currentEnd, segment.endMinute);
    } else {
      clusters.push(current);
      current = [segment];
      currentEnd = segment.endMinute;
    }
  });
  if (current.length) clusters.push(current);

  const overflows: OverflowChip[] = [];

  clusters.forEach(cluster => {
    const columnEnds: number[] = [];
    cluster.forEach(segment => {
      const reusableColumn = columnEnds.findIndex(end => end <= segment.startMinute);
      const column = reusableColumn >= 0 ? reusableColumn : columnEnds.length;
      segment.column = column;
      columnEnds[column] = segment.endMinute;
    });
    const visibleCols = Math.min(Math.max(1, columnEnds.length), MAX_OVERLAP_COLS);
    const hidden = cluster.filter(s => s.column >= MAX_OVERLAP_COLS);
    if (hidden.length > 0) {
      overflows.push({ top: hidden[0].top, count: hidden.length });
    }
    cluster.forEach(segment => { segment.columns = visibleCols; });
  });

  return { segments: raw.filter(s => s.column < MAX_OVERLAP_COLS), overflows };
}

function TimeBlockGrid({ days, events, tasks, sourceColors, canWrite, writeableSources, onSelectSlot, onEditTask, onOpenEvent }: {
  days: Date[];
  events: CalendarExternalEvent[];
  tasks: Task[];
  sourceColors: Map<string, string>;
  canWrite: boolean;
  writeableSources: CalendarSource[];
  onSelectSlot: (day: Date, startSlot: number, endSlot: number) => void;
  onEditTask: (task: Task) => void;
  onOpenEvent: (event: CalendarExternalEvent) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const canSelect = canWrite && writeableSources.length > 0;
  const daysKey = days.map(formatISODate).join('|');

  // Meet de zichtbare hoogte en kies een rijhoogte zó dat de werkdag die hoogte
  // vult (ruime blokken die het scherm vullen); de volledige dag blijft scrollbaar
  // voor de vroege/late uren. Reageert op resize én op een groeiende "hele dag"-
  // balk via een ResizeObserver. useLayoutEffect voorkomt een flits.
  useLayoutEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const measure = () => {
      const headers = scrollEl.querySelector<HTMLElement>('.tb-day-headers');
      const allday = scrollEl.querySelector<HTMLElement>('.tb-allday-row');
      const chrome = (headers?.offsetHeight ?? 0) + (allday?.offsetHeight ?? 0);
      const available = scrollEl.clientHeight - chrome;
      if (available <= 0) return;
      const fitted = Math.floor(available / WORKDAY_SLOTS);
      setRowHeight(Math.min(Math.max(fitted, MIN_ROW_HEIGHT), MAX_ROW_HEIGHT));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(scrollEl);
    const alldayEl = scrollEl.querySelector('.tb-allday-row');
    if (alldayEl) ro.observe(alldayEl);
    return () => ro.disconnect();
  }, [daysKey]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const firstSlot = scrollEl.querySelector<HTMLElement>('.tb-time-label');
    const grid = scrollEl.querySelector<HTMLElement>('.tb-grid');
    const slotHeight = firstSlot?.getBoundingClientRect().height ?? 24;
    const workdayStartSlot = ((WORKDAY_START - HOUR_START) * 60) / SLOT_MINUTES;
    const gridOffsetTop = grid?.offsetTop ?? 0;
    scrollEl.scrollTop = Math.max(0, gridOffsetTop + Math.round(workdayStartSlot * slotHeight) - 2);
  }, [daysKey]);

  const handleMouseDown = useCallback((dayIndex: number, slot: number) => {
    if (!canSelect) return;
    setDrag({ dayIndex, startSlot: slot, endSlot: slot });
    setIsDragging(true);
  }, [canSelect]);

  const handleMouseEnter = useCallback((_dayIndex: number, slot: number) => {
    if (!isDragging || !drag) return;
    if (_dayIndex !== drag.dayIndex) return;
    setDrag(prev => prev ? { ...prev, endSlot: slot } : null);
  }, [isDragging, drag]);

  const handleMouseUp = useCallback(() => {
    if (drag && isDragging) {
      const minS = Math.min(drag.startSlot, drag.endSlot);
      const maxS = Math.max(drag.startSlot, drag.endSlot);
      onSelectSlot(days[drag.dayIndex], minS, maxS);
    }
    setIsDragging(false);
    setDrag(null);
  }, [drag, isDragging, days, onSelectSlot]);

  useEffect(() => {
    const up = () => { if (isDragging) handleMouseUp(); };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, [isDragging, handleMouseUp]);

  const hourLabels: { hour: number; minutes: number; label: string }[] = [];
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    const t = slotToTime(s);
    hourLabels.push({ ...t, label: formatHour(t.hour, t.minutes) });
  }

  function allDayEventsForDay(day: Date) { return events.filter(e => e.all_day && eventOverlapsDay(e, day)); }
  function tasksForDay(day: Date) { return tasks.filter(t => t.end_date && isSameDay(new Date(`${t.end_date}T12:00:00`), day)); }
  function eventColor(ev: CalendarExternalEvent): string { return sourceColors.get(ev.source_id) ?? '#FFD966'; }

  function isInSelection(di: number, si: number): boolean {
    if (!drag || !isDragging || di !== drag.dayIndex) return false;
    const lo = Math.min(drag.startSlot, drag.endSlot);
    const hi = Math.max(drag.startSlot, drag.endSlot);
    return si >= lo && si <= hi;
  }

  function selectionLabel(): string | null {
    if (!drag || !isDragging) return null;
    const lo = Math.min(drag.startSlot, drag.endSlot);
    const hi = Math.max(drag.startSlot, drag.endSlot);
    const s = slotToTime(lo);
    const e = slotToTime(hi + 1);
    return `${formatHour(s.hour, s.minutes)} – ${formatHour(e.hour, e.minutes)}`;
  }

  const today = (d: Date) => isSameDay(d, new Date());
  const now = new Date();
  const gridStyle = {
    '--tb-days': days.length,
    '--tb-slots': TOTAL_SLOTS,
    ...(rowHeight ? { '--tb-h': `${rowHeight}px` } : {}),
  } as CSSProperties;
  const workdayOverlayStyle = {
    top: `${(((WORKDAY_START - HOUR_START) * 60) / ((HOUR_END - HOUR_START) * 60)) * 100}%`,
    height: `${(((WORKDAY_END - WORKDAY_START) * 60) / ((HOUR_END - HOUR_START) * 60)) * 100}%`,
  } as CSSProperties;

  return (
    <div className={`tb-container${days.length === 1 ? ' tb-single-day' : ''}`} style={gridStyle} onMouseLeave={() => { if (isDragging) handleMouseUp(); }}>
      <div className="tb-scroll" ref={scrollRef}>
        <div className="tb-canvas">
          <div className="tb-day-headers">
            <div className="tb-gutter tb-sticky-gutter tb-corner" />
            {days.map(day => {
              const td = today(day);
              return <div className={`tb-dh${td ? ' tb-today' : ''}`} key={formatISODate(day)}>
                <span className="tb-dh-name">{dayNameNl(day)}</span>
                <span className={`tb-dh-num${td ? ' tb-today-num' : ''}`}>{day.getDate()}</span>
                <span className="tb-dh-month">{new Intl.DateTimeFormat('nl-NL', { month: 'short' }).format(day)}</span>
                {td && <span className="tb-dh-today">Vandaag</span>}
              </div>;
            })}
          </div>

          <div className="tb-allday-row">
            <div className="tb-gutter tb-sticky-gutter tb-allday-label">Hele dag</div>
            {days.map((day, di) => {
              const ad = allDayEventsForDay(day);
              const dt = tasksForDay(day);
              return (
                <div className={`tb-allday-cell${today(day) ? ' tb-today-col' : ''}`} key={di}>
                  {ad.map(ev => (
                    <button type="button" className="tb-ad-chip ext" key={`${ev.provider}-${ev.provider_event_id}-${di}`} onClick={() => onOpenEvent(ev)} title={ev.title} style={eventColorStyle(eventColor(ev))}>{ev.title}</button>
                  ))}
                  {dt.map(t => (
                    <button type="button" className="tb-ad-chip task" key={t.id} onClick={() => onEditTask(t)} title={t.title}>{t.title}</button>
                  ))}
                  {ad.length === 0 && dt.length === 0 && <span className="tb-ad-empty">—</span>}
                </div>
              );
            })}
          </div>


          <div className="tb-grid">
            <div className="tb-workday-window" style={workdayOverlayStyle} />
            {hourLabels.map((h, si) => (
              <div className={`tb-gutter tb-sticky-gutter tb-time-label${h.minutes === 0 ? ' tb-gutter-full' : ' tb-gutter-half'}`} key={`g${si}`} style={{ gridRow: si + 1 }}>
                {h.minutes === 0 && <span>{h.label}</span>}
              </div>
            ))}

            {days.map((day, di) => {
              const { segments: daySegments, overflows: dayOverflows } = layoutTimedEventsForDay(day, events);
              const isToday = today(day);
              const nowFrac = isToday ? dateToVisibleDayFraction(day, now) : 0;
              return (
                <div className={`tb-col${isToday ? ' tb-today-col' : ''}`} key={di} style={{ gridColumn: di + 2, gridRow: `1 / span ${TOTAL_SLOTS}` }}>
                  {hourLabels.map((h, si) => {
                    const selected = isInSelection(di, si);
                    return (
                      <div
                        className={`tb-cell${h.minutes === 0 ? ' tb-cell-hour' : ' tb-cell-half'}${selected ? ' tb-cell-sel' : ''}${canSelect ? ' tb-cell-can' : ''}`}
                        key={si}
                        style={{ top: `calc(var(--tb-h) * ${si})`, height: 'var(--tb-h)' }}
                        onMouseDown={() => handleMouseDown(di, si)}
                        onMouseEnter={() => handleMouseEnter(di, si)}
                      >
                        {selected && si === Math.min(drag!.startSlot, drag!.endSlot) && (
                          <span className="tb-sel-label">{selectionLabel()}</span>
                        )}
                      </div>
                    );
                  })}

                  {isToday && nowFrac > 0 && nowFrac < 1 && (
                    <div className="tb-now" style={{ top: `${nowFrac * 100}%` }}>
                      <div className="tb-now-dot" />
                      <span className="tb-now-label">{formatTime(now.toISOString())}</span>
                    </div>
                  )}

                  {daySegments.map(segment => {
                    const ev = segment.event;
                    const columnWidth = 100 / segment.columns;
                    const left = segment.column * columnWidth;
                    const right = 100 - (segment.column + 1) * columnWidth;
                    const visualTime = `${segment.startsBeforeDay ? '↖ ' : ''}${formatTime(ev.starts_at)} – ${segment.endsAfterDay ? '↘ ' : ''}${formatTime(ev.ends_at)}`;
                    const visibleDuration = segment.endMinute - segment.startMinute;
                    const densityClass = visibleDuration < 30 ? ' tb-ev-tight' : visibleDuration < 60 ? ' tb-ev-compact' : ' tb-ev-roomy';
                    const eventMeta = [providerLabel(ev.provider), ev.source_name, ev.location].filter(Boolean).join(' · ');
                    return (
                      <button type="button" className={`tb-ev${densityClass}${ev.visibility === 'private' ? ' tb-ev-priv' : ''}`} key={`${ev.provider}-${ev.provider_event_id}-${di}`}
                        onClick={() => onOpenEvent(ev)}
                        style={{
                          ...eventColorStyle(eventColor(ev)),
                          top: `${segment.top}%`,
                          height: `${segment.height}%`,
                          left: `calc(${left}% + 2px)`,
                          right: `calc(${right}% + 2px)`,
                        }}
                        title={`${visualTime}\n${ev.title}\n${eventMeta}`}>
                        <span className="tb-ev-time">{visualTime}</span>
                        <span className="tb-ev-title">{ev.title}</span>
                        <span className="tb-ev-src">{eventMeta}</span>
                      </button>
                    );
                  })}

                  {dayOverflows.map((ov, i) => (
                    <div key={`ov-${di}-${i}`} className="tb-overflow-chip" style={{ top: `${ov.top}%` }}>
                      +{ov.count}
                    </div>
                  ))}
                </div>
              );
            })}

            {hourLabels.map((h, si) => (
              <div className={`tb-line${h.minutes === 0 ? ' tb-line-hour' : ''}`} key={`l${si}`} style={{ gridRow: si + 1, gridColumn: '2 / -1' }} />
            ))}
          </div>
        </div>
      </div>

      {canSelect && <p className="tb-hint">Sleep over lege tijdslots om snel een event aan te maken</p>}
    </div>
  );
}

/* ── Month view ───────────────────────────────────────────────────────── */

function CalendarMonthView({ days, anchor, events, tasks, data, sourceColors, onEditTask, onOpenDay, onOpenEvent }: {
  days: Date[];
  anchor: Date;
  events: CalendarExternalEvent[];
  tasks: Task[];
  data: AppData;
  sourceColors: Map<string, string>;
  onEditTask: (task: Task) => void;
  onOpenDay: (day: Date) => void;
  onOpenEvent: (event: CalendarExternalEvent) => void;
}) {
  function tasksForDay(day: Date) { return tasks.filter(t => t.end_date && isSameDay(new Date(`${t.end_date}T12:00:00`), day)); }
  function eventsForDay(day: Date) { return events.filter(ev => eventOverlapsDay(ev, day)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)); }
  function eventColor(ev: CalendarExternalEvent): string { return sourceColors.get(ev.source_id) ?? '#FFD966'; }

  return (
    <div className="calendar-month-view">
      <div className="calendar-month-weekdays">
        {DAY_NAMES_NL.map(day => <span key={day}>{day}</span>)}
      </div>
      <div className="calendar-month-grid">
        {days.map(day => {
          const dayEvents = eventsForDay(day);
          const dayTasks = tasksForDay(day);
          const visibleItems = [...dayEvents.map(ev => ({ kind: 'event' as const, ev })), ...dayTasks.map(task => ({ kind: 'task' as const, task }))];
          const clippedItems = visibleItems.slice(0, 5);
          const remaining = Math.max(0, visibleItems.length - clippedItems.length);
          const outsideMonth = !isSameMonth(day, anchor);
          const today = isSameDay(day, new Date());

          return (
            <article className={`calendar-month-cell${outsideMonth ? ' is-outside-month' : ''}${today ? ' is-today' : ''}`} key={formatISODate(day)}>
              <button className="calendar-month-date" onClick={() => onOpenDay(day)} title="Open dagweergave">
                <span>{dayNameNl(day)}</span>
                <strong>{day.getDate()}</strong>
              </button>
              <div className="calendar-month-items">
                {clippedItems.map((item, idx) => item.kind === 'event' ? (
                  <button
                    type="button"
                    className={`month-chip external${item.ev.visibility === 'private' ? ' private-event' : ''}`}
                    onClick={() => onOpenEvent(item.ev)}
                    key={`${item.ev.provider}-${item.ev.provider_event_id}-${idx}`}
                    style={eventColorStyle(eventColor(item.ev))}
                    title={`${formatTime(item.ev.starts_at, item.ev.all_day)} · ${item.ev.title}`}
                  >
                    <span>{formatTime(item.ev.starts_at, item.ev.all_day)}</span>
                    <strong>{item.ev.title}</strong>
                  </button>
                ) : (
                  <button className="month-chip task" key={item.task.id} onClick={() => onEditTask(item.task)} title={item.task.title}>
                    <span>Taak</span>
                    <strong>{item.task.title}</strong>
                    <em>{data.projects.find(p => p.id === item.task.project_id)?.name ?? 'Project'}</em>
                  </button>
                ))}
                {remaining > 0 && <button className="month-chip more" onClick={() => onOpenDay(day)}>+{remaining} meer</button>}
                {visibleItems.length === 0 && <div className="month-empty">Geen items</div>}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/* ── Floating creation panel ─────────────────────────────────────────── */

function EventCreationPanel({ newEvent, setNewEvent, writeableSources, clients, projects, loading, canWrite, onSubmit, onClose }: {
  newEvent: { sourceId: string; title: string; description: string; location: string; startsAt: string; endsAt: string; allDay: boolean; clientId: string; projectId: string };
  setNewEvent: (fn: (prev: typeof newEvent) => typeof newEvent) => void;
  writeableSources: CalendarSource[];
  clients: Client[];
  projects: Project[];
  loading: boolean;
  canWrite: boolean;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}) {
  return (
    <div className="tb-overlay" onClick={onClose}>
      <form className="tb-panel" onClick={e => e.stopPropagation()} onSubmit={onSubmit}>
        <div className="tb-panel-head">
          <div className="tb-panel-title"><CalendarDays size={16} /><h3>Nieuw event</h3></div>
          <button type="button" className="tb-panel-close" onClick={onClose}><X size={16} /></button>
        </div>
        <label>Agenda<Select value={newEvent.sourceId} onChange={e => setNewEvent(p => ({ ...p, sourceId: e.target.value }))}>
          <option value="">Kies agenda</option>
          {writeableSources.map(s => <option value={s.id} key={s.id}>{providerLabel(s.provider)} · {s.name}{s.visibility === 'private' ? ' · privé' : ' · team'}</option>)}
        </Select></label>
        <label>Titel<Input autoFocus value={newEvent.title} onChange={e => setNewEvent(p => ({ ...p, title: e.target.value }))} placeholder="Bijv. Intake klant" /></label>
        <label>Locatie<Input value={newEvent.location} onChange={e => setNewEvent(p => ({ ...p, location: e.target.value }))} placeholder="Optioneel" /></label>
        <div className="settings-grid compact">
          <label>Start<Input type="datetime-local" value={newEvent.startsAt} onChange={e => setNewEvent(p => ({ ...p, startsAt: e.target.value }))} /></label>
          <label>Einde<Input type="datetime-local" value={newEvent.endsAt} onChange={e => setNewEvent(p => ({ ...p, endsAt: e.target.value }))} /></label>
        </div>
        <label>Omschrijving<Textarea value={newEvent.description} onChange={e => setNewEvent(p => ({ ...p, description: e.target.value }))} placeholder="Optioneel" /></label>
        <label className="check-row"><input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent(p => ({ ...p, allDay: e.target.checked }))} /> Hele dag</label>
        <div className="tb-panel-section-label">Koppelen aan</div>
        <ClientProjectPicker clients={clients} projects={projects} clientId={newEvent.clientId} projectId={newEvent.projectId}
          onChange={next => setNewEvent(p => ({ ...p, clientId: next.clientId, projectId: next.projectId }))} />
        <Button variant="primary" disabled={loading || !canWrite || !writeableSources.length}>Event aanmaken</Button>
      </form>
    </div>
  );
}


function CalendarEventDetailPanel({ event, data, sourceColors, canWrite, onNewNote, onNewDocument, onSetEventLink, onEditNote, onLinkExistingNote, onUnlinkNote, onClose }: {
  event: CalendarExternalEvent | null;
  data: AppData;
  sourceColors: Map<string, string>;
  canWrite: boolean;
  onNewNote: (event: CalendarExternalEvent) => void;
  onNewDocument: (event: CalendarExternalEvent) => void;
  onSetEventLink: (event: CalendarExternalEvent, clientId: string | null, projectId: string | null) => void | Promise<void>;
  onEditNote: (note: Note) => void;
  onLinkExistingNote: (noteId: UUID, event: CalendarExternalEvent) => void | Promise<void>;
  onUnlinkNote: (linkId: UUID) => void | Promise<void>;
  onClose: () => void;
}) {
  const [selectedNoteId, setSelectedNoteId] = useState('');

  useEffect(() => {
    setSelectedNoteId('');
  }, [event?.id, event?.provider_event_id, event?.starts_at]);

  if (!event) return null;

  const color = sourceColors.get(event.source_id) ?? '#FFD966';
  const linkedRows = data.noteCalendarLinks
    .filter(link => noteCalendarLinkMatchesEvent(link, event))
    .map(link => ({ link, note: data.notes.find(note => note.id === link.note_id) ?? null }))
    .filter((row): row is { link: NoteCalendarLink; note: Note } => Boolean(row.note));
  const linkedNoteIds = new Set(linkedRows.map(row => row.note.id));
  const linkableNotes = data.notes
    .filter(note => !linkedNoteIds.has(note.id))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const canAttachNotes = canWrite && event.visibility === 'organization' && !event.is_private_masked;
  const eventLink = data.calendarEventLinks.find(link => calendarEventLinkMatchesEvent(link, event)) ?? null;
  const linkedClient = eventLink?.client_id ? data.clients.find(c => c.id === eventLink.client_id) ?? null : null;
  const linkedProject = eventLink?.project_id ? data.projects.find(p => p.id === eventLink.project_id) ?? null : null;
  const lockedReason = event.visibility !== 'organization'
    ? 'Notities koppelen is uitgeschakeld voor privé-agenda-items, zodat persoonlijke agenda-informatie niet per ongeluk organisatiebreed zichtbaar wordt.'
    : event.is_private_masked
      ? 'Dit agenda-item is afgeschermd. Koppelen is geblokkeerd totdat de details zichtbaar gedeeld zijn.'
      : !canWrite
        ? 'Je hebt alleen-lezen toegang tot deze organisatie.'
        : null;

  return (
    <div className="event-detail-overlay" onClick={onClose}>
      <aside className="event-detail-panel" onClick={e => e.stopPropagation()} style={eventColorStyle(color)}>
        <div className="event-detail-glow" />
        <div className="event-detail-head">
          <div>
            <span className="event-detail-kicker">{providerLabel(event.provider)} · {event.source_name}</span>
            <h3>{event.title}</h3>
          </div>
          <button type="button" className="tb-panel-close" onClick={onClose} aria-label="Sluit eventdetails"><X size={17} /></button>
        </div>

        <div className="event-detail-meta-grid">
          <div className="event-detail-meta-card">
            <Clock size={15} />
            <span>{formatEventRange(event)}</span>
          </div>
          <div className="event-detail-meta-card">
            <CalendarDays size={15} />
            <span>{event.visibility === 'private' ? 'Privé-agenda' : 'Gedeeld met organisatie'}{event.is_private_masked ? ' · details afgeschermd' : ''}</span>
          </div>
          {event.location && (
            <div className="event-detail-meta-card">
              <MapPin size={15} />
              <span>{event.location}</span>
            </div>
          )}
        </div>

        {event.description ? (
          <div className="event-detail-description">
            <span>Omschrijving</span>
            <p>{event.description}</p>
          </div>
        ) : (
          <div className="event-detail-empty">Geen omschrijving toegevoegd.</div>
        )}

        <section className="event-link-panel">
          <div className="event-link-head">
            <span className="event-notes-kicker">Koppeling</span>
            <h4>Klant &amp; project</h4>
            <p>Koppel dit agenda-item aan een klant en project, zodat je er makkelijk notities en documenten bij maakt.</p>
          </div>
          {canAttachNotes ? (
            <ClientProjectPicker
              clients={data.clients}
              projects={data.projects}
              clientId={eventLink?.client_id ?? ''}
              projectId={eventLink?.project_id ?? ''}
              onChange={next => onSetEventLink(event, next.clientId || null, next.projectId || null)}
            />
          ) : (
            <div className="event-link-readonly">
              {linkedClient || linkedProject
                ? <>{linkedClient ? `Klant: ${linkedClient.name}` : 'Geen klant'} · {linkedProject ? `Project: ${linkedProject.name}` : 'Geen project'}</>
                : 'Nog niet gekoppeld aan een klant of project.'}
            </div>
          )}
        </section>

        <section className="event-notes-panel">
          <div className="event-notes-head">
            <div>
              <span className="event-notes-kicker">Context</span>
              <h4>Notities &amp; documenten</h4>
              <p>{linkedRows.length} gekoppelde notitie{linkedRows.length === 1 ? '' : 's'}</p>
            </div>
            {canAttachNotes && <div className="event-notes-actions">
              <Button onClick={() => { onClose(); onNewNote(event); }}>+ Notitie</Button>
              <Button onClick={() => { onClose(); onNewDocument(event); }}>+ Document</Button>
            </div>}
          </div>

          {lockedReason && <div className="event-notes-locked">{lockedReason}</div>}

          {linkedRows.length === 0 ? (
            <div className="event-notes-empty">Nog geen notities gekoppeld aan deze afspraak.</div>
          ) : (
            <div className="event-notes-list">
              {linkedRows.map(({ link, note }) => (
                <article className="event-note-card" key={link.id}>
                  <button type="button" className="event-note-main" onClick={() => { onClose(); onEditNote(note); }}>
                    <div className="event-note-top">
                      <span className={`note-type note-type-${note.note_type ?? 'general'}`}>{getNoteTypeLabel(note.note_type)}</span>
                      <span>{dateNL(note.created_at)}</span>
                    </div>
                    <strong>{note.title}</strong>
                    <p><RichTextExcerpt content={note.content} emptyText="Geen inhoud" /></p>
                    {Array.isArray(note.tags) && note.tags.length > 0 && <div className="note-tags compact">{note.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
                  </button>
                  {canAttachNotes && <button type="button" className="event-note-unlink" onClick={() => onUnlinkNote(link.id)}>Ontkoppel</button>}
                </article>
              ))}
            </div>
          )}

          {canAttachNotes && linkableNotes.length > 0 && (
            <div className="event-note-linker">
              <Select value={selectedNoteId} onChange={e => setSelectedNoteId(e.target.value)} aria-label="Bestaande notitie kiezen">
                <option value="">Bestaande notitie koppelen…</option>
                {linkableNotes.map(note => <option key={note.id} value={note.id}>{note.title} · {getNoteTypeLabel(note.note_type)}</option>)}
              </Select>
              <Button variant="ghost" disabled={!selectedNoteId} onClick={() => {
                if (!selectedNoteId) return;
                const noteId = selectedNoteId;
                setSelectedNoteId('');
                void onLinkExistingNote(noteId, event);
              }}>Koppelen</Button>
            </div>
          )}
        </section>

        <div className="event-detail-actions">
          {event.html_link && <a className="btn btn-primary" href={event.html_link} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in agenda</a>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Sluiten</button>
        </div>
      </aside>
    </div>
  );
}

/* ── Main CalendarPage ───────────────────────────────────────────────── */

export function CalendarPage({ mode = 'agenda', organizationId, currentUserId, data, canWrite, onEditTask, onNewNoteForEvent, onNewDocumentForEvent, onSetEventLink, onEditNote, onLinkExistingNoteToEvent, onUnlinkNoteFromEvent }: {
  mode?: 'agenda' | 'settings';
  organizationId: UUID; currentUserId: UUID | null; data: AppData; canWrite: boolean; onEditTask: (task: Task) => void;
  onNewNoteForEvent: (event: CalendarExternalEvent) => void;
  onNewDocumentForEvent: (event: CalendarExternalEvent) => void;
  onSetEventLink: (event: CalendarExternalEvent, clientId: string | null, projectId: string | null) => void | Promise<void>;
  onEditNote: (note: Note) => void;
  onLinkExistingNoteToEvent: (noteId: UUID, event: CalendarExternalEvent) => void | Promise<void>;
  onUnlinkNoteFromEvent: (linkId: UUID) => void | Promise<void>;
}) {
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [integrations, setIntegrations] = useState<CalendarIntegrationsPayload>({ connections: [], sources: [] });
  const [events, setEvents] = useState<CalendarExternalEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<CalendarView>('week');
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarExternalEvent | null>(null);
  const [showConnections, setShowConnections] = useState(() => mode === 'settings' || window.location.hash === '#calendar-connections');
  const [newEvent, setNewEvent] = useState(() => {
    const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    const e = new Date(s); e.setHours(e.getHours() + 1);
    return { sourceId: '', title: '', description: '', location: '', startsAt: toInputDateTime(s), endsAt: toInputDateTime(e), allDay: false, clientId: '', projectId: '' };
  });

  const days = useMemo(() => calendarDaysForView(view, anchor), [view, anchor]);
  const rangeStart = useMemo(() => days[0].toISOString(), [days]);
  const rangeEnd = useMemo(() => addDays(days[days.length - 1], 1).toISOString(), [days]);
  const calendarRangeLabel = useMemo(() => {
    if (view === 'day') return fullDateLabelNl(anchor);
    if (view === 'month') return monthLabelNl(anchor);
    return `${formatISODate(days[0])} t/m ${formatISODate(days[days.length - 1])}`;
  }, [anchor, days, view]);
  const canManageSource = (src: CalendarSource) => Boolean(canWrite && currentUserId && src.user_id === currentUserId);
  const canManageConnection = (uid: UUID) => Boolean(canWrite && currentUserId && uid === currentUserId);
  const writeableSources = useMemo(
    () => integrations.sources.filter(s => s.write_enabled && s.sync_enabled && (s.user_id === currentUserId || s.visibility === 'organization')),
    [integrations.sources, currentUserId],
  );
  const sourceColors = useMemo(
    () => new Map(integrations.sources.map(s => [s.id, normalizeHexColor(s.color)])),
    [integrations.sources],
  );

  useEffect(() => { void refreshAll(); }, [organizationId, mode]); // eslint-disable-line
  useEffect(() => { if (mode === 'agenda') void refreshEventsOnly(); }, [rangeStart, rangeEnd, mode]); // eslint-disable-line
  useEffect(() => { if (mode === 'settings') setShowConnections(true); }, [mode]);
  useEffect(() => {
    const handleCalendarAnchor = (event: Event) => {
      const anchor = (event as CustomEvent<{ anchor?: string }>).detail?.anchor;
      if (anchor === 'connections' || anchor === 'settings') setShowConnections(true);
      window.setTimeout(() => document.getElementById(`calendar-${anchor ?? 'agenda'}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
    };
    window.addEventListener('brandcore:calendar-anchor', handleCalendarAnchor);
    if (window.location.hash === '#calendar-connections' || window.location.hash === '#calendar-settings') {
      setShowConnections(true);
      window.setTimeout(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    }
    return () => window.removeEventListener('brandcore:calendar-anchor', handleCalendarAnchor);
  }, []);
  useEffect(() => {
    if (!newEvent.sourceId && writeableSources[0]) setNewEvent(p => ({ ...p, sourceId: writeableSources[0].id }));
    if (newEvent.sourceId && !writeableSources.some(s => s.id === newEvent.sourceId)) setNewEvent(p => ({ ...p, sourceId: writeableSources[0]?.id ?? '' }));
  }, [newEvent.sourceId, writeableSources]);

  async function refreshAll() {
    setLoading(true); setError(null); setMessage(null);
    try { const n = await loadCalendarIntegrations(organizationId); setIntegrations(n); if (mode === 'agenda') await refreshEventsOnly(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Agenda-koppelingen laden mislukt.'); }
    finally { setLoading(false); }
  }
  async function refreshEventsOnly() {
    setEventsLoading(true); setError(null);
    try { setEvents(await listExternalCalendarEvents(organizationId, rangeStart, rangeEnd)); }
    catch (err) { setError(err instanceof Error ? err.message : 'Agenda-events laden mislukt.'); }
    finally { setEventsLoading(false); }
  }
  async function connect(provider: CalendarProvider) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try { window.location.assign(await getCalendarOAuthUrl(organizationId, provider, window.location.href.split('?')[0])); }
    catch (err) { setError(err instanceof Error ? err.message : 'OAuth starten mislukt.'); setLoading(false); }
  }
  async function refreshSources(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try { const n = await refreshCalendarSources(organizationId, connectionId); setIntegrations(n); setMessage("Agenda\u2019s opnieuw opgehaald."); if (mode === 'agenda') await refreshEventsOnly(); }
    catch (err) { setError(err instanceof Error ? err.message : "Agenda\u2019s ophalen mislukt."); }
    finally { setLoading(false); }
  }
  async function disconnect(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    if (!confirm('Deze persoonlijke agenda-koppeling loskoppelen?')) return;
    setLoading(true); setError(null); setMessage(null);
    try { await disconnectCalendarConnection(organizationId, connectionId); setIntegrations(await loadCalendarIntegrations(organizationId)); setMessage('Agenda-koppeling losgekoppeld.'); if (mode === 'agenda') await refreshEventsOnly(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Loskoppelen mislukt.'); }
    finally { setLoading(false); }
  }
  async function toggleSource(source: CalendarSource, key: 'sync_enabled' | 'write_enabled' | 'visibility') {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang.'); return; }
    if (!canManageSource(source)) { setError('Alleen de eigenaar kan deze instelling wijzigen.'); return; }
    const patch: Partial<Pick<CalendarSource, 'sync_enabled' | 'write_enabled' | 'visibility'>> = {};
    if (key === 'visibility') patch.visibility = source.visibility === 'organization' ? 'private' : 'organization';
    else if (key === 'sync_enabled') patch.sync_enabled = !source.sync_enabled;
    else patch.write_enabled = !source.write_enabled;
    setError(null); setMessage(null);
    try {
      const upd = await updateCalendarSource(organizationId, source.id, patch);
      setIntegrations(prev => ({ ...prev, sources: prev.sources.map(s => s.id === upd.id ? upd : s) }));
      if (mode === 'agenda' && (key === 'sync_enabled' || key === 'visibility')) await refreshEventsOnly();
      if (key === 'visibility') setMessage(upd.visibility === 'organization' ? 'Agenda gedeeld met de organisatie.' : 'Agenda staat weer privé.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Instelling bijwerken mislukt.'); }
  }

  function makeDefaultTimes() {
    const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    const e = new Date(s); e.setHours(e.getHours() + 1);
    return { startsAt: toInputDateTime(s), endsAt: toInputDateTime(e) };
  }

  const handleSlotSelect = useCallback((day: Date, startSlot: number, endSlot: number) => {
    const st = slotToTime(startSlot);
    const et = slotToTime(endSlot + 1);
    const sd = new Date(day); sd.setHours(st.hour, st.minutes, 0, 0);
    const ed = new Date(day); ed.setHours(et.hour, et.minutes, 0, 0);
    setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: toInputDateTime(sd), endsAt: toInputDateTime(ed), clientId: '', projectId: '' }));
    setShowCreatePanel(true);
  }, []);

  async function submitNewEvent(e: FormEvent) {
    e.preventDefault();
    if (!canWrite) { setError('Je hebt alleen-lezen toegang.'); return; }
    if (!newEvent.sourceId) { setError('Kies eerst een schrijfbare agenda.'); return; }
    if (!newEvent.title.trim()) { setError('Geef het event een titel.'); return; }
    const sIso = newEvent.allDay ? `${newEvent.startsAt.slice(0, 10)}T00:00:00.000Z` : inputDateTimeToIso(newEvent.startsAt);
    const eIso = newEvent.allDay ? `${newEvent.endsAt.slice(0, 10)}T00:00:00.000Z` : inputDateTimeToIso(newEvent.endsAt);
    if (!newEvent.allDay && new Date(eIso).getTime() <= new Date(sIso).getTime()) { setError('Eindtijd moet na starttijd liggen.'); return; }
    if (newEvent.allDay && dateKeyFromValue(eIso) < dateKeyFromValue(sIso)) { setError('Einddatum mag niet voor startdatum liggen.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try {
      const created = await createExternalCalendarEvent(organizationId, {
        sourceId: newEvent.sourceId, title: newEvent.title.trim(),
        description: newEvent.description.trim() || null, location: newEvent.location.trim() || null,
        startsAt: sIso, endsAt: eIso, allDay: newEvent.allDay,
      });
      setEvents(prev => [...prev, created].sort((a, b) => a.starts_at.localeCompare(b.starts_at)));
      if (newEvent.clientId || newEvent.projectId) {
        await onSetEventLink(created, newEvent.clientId || null, newEvent.projectId || null);
      }
      const d = makeDefaultTimes();
      setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: d.startsAt, endsAt: d.endsAt, clientId: '', projectId: '' }));
      setMessage(newEvent.clientId || newEvent.projectId
        ? 'Event aangemaakt, gekoppeld aan klant/project en zichtbaar in je externe agenda.'
        : 'Event aangemaakt en zichtbaar in je externe agenda.');
      setShowCreatePanel(false);
      refreshEventsOnly().catch(() => {});
    } catch (err) { setError(err instanceof Error ? err.message : 'Event aanmaken mislukt.'); }
    finally { setLoading(false); }
  }

  function tasksForDay(day: Date) { return data.tasks.filter(t => t.status !== 'done' && t.end_date && isSameDay(new Date(`${t.end_date}T12:00:00`), day)); }
  function eventsForDay(day: Date) { return events.filter(ev => eventOverlapsDay(ev, day)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)); }

  function changeView(nextView: CalendarView) {
    setView(nextView);
    setAnchor(prev => {
      if (nextView === 'month') return startOfMonth(prev);
      if (nextView === 'week' || nextView === 'list') return startOfWeek(prev);
      return startOfDay(prev);
    });
  }

  function movePeriod(direction: -1 | 1) {
    setAnchor(prev => {
      if (view === 'day') return addDays(prev, direction);
      if (view === 'month') return addMonths(prev, direction);
      return addDays(prev, direction * 7);
    });
  }

  function openDay(day: Date) {
    setAnchor(startOfDay(day));
    setView('day');
  }

  function goToday() {
    setAnchor(startOfDay(new Date()));
  }

  // ↑/↓ zoomt in/uit langs dag → week → maand (lijst blijft via 'l').
  function cycleView(direction: -1 | 1) {
    const order: CalendarView[] = ['day', 'week', 'month'];
    const current = order.indexOf(view);
    const base = current === -1 ? order.indexOf('week') : current;
    const next = order[Math.min(order.length - 1, Math.max(0, base + direction))];
    if (next !== view) changeView(next);
  }

  // Sneltoetsen voor snelle navigatie. Genegeerd tijdens typen in formulieren of
  // als er een paneel/modal openstaat (Escape sluit die i.p.v. hier te navigeren).
  useEffect(() => {
    if (mode !== 'agenda') return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (showCreatePanel || selectedEvent) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); movePeriod(-1); break;
        case 'ArrowRight': e.preventDefault(); movePeriod(1); break;
        case 'ArrowUp': e.preventDefault(); cycleView(-1); break;
        case 'ArrowDown': e.preventDefault(); cycleView(1); break;
        case 'v': case 'V': e.preventDefault(); goToday(); break;
        case 'd': case 'D': e.preventDefault(); changeView('day'); break;
        case 'w': case 'W': e.preventDefault(); changeView('week'); break;
        case 'm': case 'M': e.preventDefault(); changeView('month'); break;
        case 'l': case 'L': e.preventDefault(); changeView('list'); break;
        default: break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, view, showCreatePanel, selectedEvent]); // eslint-disable-line

  const previousLabel = view === 'day' ? 'Vorige dag' : view === 'month' ? 'Vorige maand' : 'Vorige week';
  const nextLabel = view === 'day' ? 'Volgende dag' : view === 'month' ? 'Volgende maand' : 'Volgende week';

  const connectionsSection = <section className="calendar-section connections-panel" id="calendar-connections">
    <button className="calendar-section-head calendar-collapse-head" onClick={() => setShowConnections(prev => !prev)} aria-expanded={showConnections}>
      <div>
        <h3>Gekoppelde accounts</h3>
        <p>{integrations.connections.length} account{integrations.connections.length === 1 ? '' : 's'} · {integrations.sources.length} agenda{integrations.sources.length === 1 ? '' : "'s"}. Tokens blijven versleuteld server-side.</p>
      </div>
      <span className="calendar-collapse-indicator">{showConnections ? <ChevronDown size={16} /> : <ChevronRight size={16} />} {showConnections ? 'Inklappen' : 'Uitklappen'}</span>
    </button>
    {showConnections && (<>
    {integrations.connections.length === 0 ? <div className="calendar-empty">Nog geen agenda gekoppeld of gedeeld.</div> : <div className="connection-list">
      {integrations.connections.map(conn => {
        const srcs = integrations.sources.filter(s => s.connection_id === conn.id);
        const owns = canManageConnection(conn.user_id);
        return <article className="connection-card" key={conn.id}>
          <div className="connection-top">
            <div className={`provider-badge ${providerClass(conn.provider)}`}>{providerLabel(conn.provider)}</div>
            <div className="connection-info">
              <strong>{owns ? (conn.display_name || conn.provider_account_email || 'Mijn account') : 'Gedeelde agenda'}</strong>
              <span>{owns ? (conn.provider_account_email || conn.provider_account_id) : 'Accountgegevens afgeschermd'}</span>
            </div>
            <span className={`connection-status status-${conn.status}`}>{conn.status}</span>
            <Button onClick={() => refreshSources(conn.id)} disabled={loading || !owns}><RefreshCcw size={14} /> Agenda's</Button>
            <Button variant="danger" onClick={() => disconnect(conn.id)} disabled={loading || !owns}><Unplug size={14} /> Loskoppelen</Button>
          </div>
          <div className="source-list">
            {srcs.map(src => {
              const ownsSrc = canManageSource(src);
              return <div className="source-row privacy" key={src.id}>
                <span className="source-dot" style={{ background: src.color || '#FFD966' }} />
                <div className="source-info">
                  <strong>{src.name}</strong>
                  <span>{src.is_primary ? 'Primair · ' : ''}{src.access_role || 'geen rol'}{src.timezone ? ` · ${src.timezone}` : ''}</span>
                  <span className={`privacy-pill ${src.visibility === 'organization' ? 'shared' : 'private'}`}>{visibilityLabel(src.visibility)}{src.user_id === currentUserId ? ' · van jou' : ''}</span>
                </div>
                <label className="toggle-row"><input type="checkbox" checked={src.sync_enabled} disabled={!ownsSrc} onChange={() => toggleSource(src, 'sync_enabled')} /> Tonen</label>
                <label className="toggle-row"><input type="checkbox" checked={src.visibility === 'organization'} disabled={!ownsSrc} onChange={() => toggleSource(src, 'visibility')} /> Delen</label>
                <label className="toggle-row"><input type="checkbox" checked={src.write_enabled} disabled={!ownsSrc} onChange={() => toggleSource(src, 'write_enabled')} /> Schrijven</label>
              </div>;
            })}
            {srcs.length === 0 && <div className="calendar-empty small">Klik "Agenda's" om beschikbare agenda's op te halen.</div>}
          </div>
        </article>;
      })}
    </div>}
    </>)}
  </section>;

  if (mode === 'settings') {
    return <div className="calendar-page calendar-settings-page">
      <section className="calendar-hero calendar-settings-hero" id="calendar-settings">
        <div>
          <h2>Agenda-instellingen</h2>
          <p>Koppel Google Calendar en Microsoft Outlook hier, los van de agendaweergave. Agenda's blijven standaard privé en worden alleen gedeeld als je dat expliciet aanzet.</p>
          {!canWrite && <p className="calendar-help">Je hebt alleen-lezen toegang.</p>}
        </div>
        <div className="calendar-actions">
          <Button variant="primary" onClick={() => connect('google')} disabled={loading || !canWrite}>Google koppelen</Button>
          <Button variant="primary" onClick={() => connect('microsoft')} disabled={loading || !canWrite}>Microsoft koppelen</Button>
          <Button onClick={refreshAll} disabled={loading}><RefreshCcw size={14} /> Ververs</Button>
        </div>
      </section>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <section className="calendar-section calendar-settings-overview">
        <div className="calendar-settings-metric">
          <span>Accounts</span>
          <strong>{integrations.connections.length}</strong>
          <small>Google en Microsoft koppelingen</small>
        </div>
        <div className="calendar-settings-metric">
          <span>Agenda's</span>
          <strong>{integrations.sources.length}</strong>
          <small>Beschikbare bronnen binnen deze workspace</small>
        </div>
        <div className="calendar-settings-metric">
          <span>Schrijfbaar</span>
          <strong>{writeableSources.length}</strong>
          <small>Agenda's waarop nieuwe events kunnen worden aangemaakt</small>
        </div>
      </section>

      {connectionsSection}
    </div>;
  }

  return <div className="calendar-page calendar-agenda-page">
    {error && <div className="error">{error}</div>}
    {message && <div className="success">{message}</div>}

    {/* Calendar view */}
    <div className={`calendar-main-card calendar-main-card-${view}`} id="calendar-agenda">
      <div className="calendar-toolbar calendar-toolbar-premium">
        <div className="calendar-period-controls">
          <Button onClick={() => movePeriod(-1)} title={`${previousLabel} (←)`}>{previousLabel}</Button>
          <Button onClick={goToday} title="Spring naar vandaag (V)">Vandaag</Button>
          <Button onClick={() => movePeriod(1)} title={`${nextLabel} (→)`}>{nextLabel}</Button>
        </div>
        <div className="calendar-range-block">
          <span className="calendar-range-label">{view === 'day' ? 'Dag' : view === 'week' ? 'Week' : view === 'month' ? 'Maand' : 'Lijst'}</span>
          <div className="calendar-range">{calendarRangeLabel}{eventsLoading ? ' · laden…' : ''}</div>
        </div>
        <Button className="calendar-link-btn" onClick={refreshAll} disabled={loading || eventsLoading}><RefreshCcw size={14} /> Ververs</Button>
        <div className="tb-view-tog calendar-view-tabs" aria-label="Agendaweergave">
          <button className={`tb-vbtn${view === 'day' ? ' active' : ''}`} onClick={() => changeView('day')} title="Dagweergave (D)"><CalendarDays size={14} /><span>Dag</span></button>
          <button className={`tb-vbtn${view === 'week' ? ' active' : ''}`} onClick={() => changeView('week')} title="Weekweergave (W)"><Clock size={14} /><span>Week</span></button>
          <button className={`tb-vbtn${view === 'month' ? ' active' : ''}`} onClick={() => changeView('month')} title="Maandweergave (M)"><CalendarDays size={14} /><span>Maand</span></button>
          <button className={`tb-vbtn${view === 'list' ? ' active' : ''}`} onClick={() => changeView('list')} title="Lijstweergave (L)"><LayoutList size={14} /><span>Lijst</span></button>
        </div>
      </div>

      {view === 'day' || view === 'week' ? (
        <TimeBlockGrid days={days} events={events} tasks={data.tasks.filter(t => t.status !== 'done')}
          sourceColors={sourceColors} canWrite={canWrite} writeableSources={writeableSources} onSelectSlot={handleSlotSelect} onEditTask={onEditTask} onOpenEvent={setSelectedEvent} />
      ) : view === 'month' ? (
        <CalendarMonthView days={days} anchor={anchor} events={events} tasks={data.tasks.filter(t => t.status !== 'done')} data={data}
          sourceColors={sourceColors} onEditTask={onEditTask} onOpenDay={openDay} onOpenEvent={setSelectedEvent} />
      ) : (
        <div className="calendar-week-grid calendar-list-grid">
          {days.map(day => {
            const dt = tasksForDay(day); const de = eventsForDay(day);
            return <div className="calendar-day" key={formatISODate(day)}>
              <div className="calendar-day-head"><span>{dayNameNl(day)}</span><strong>{day.getDate()}</strong></div>
              <div className="calendar-day-body">
                {dt.map(t => <button className="calendar-item task" key={t.id} onClick={() => onEditTask(t)}>
                  <span className="calendar-item-time">Taak</span><strong>{t.title}</strong>
                  <small>{data.projects.find(p => p.id === t.project_id)?.name ?? 'Project'}</small>
                </button>)}
                {de.map(ev => <button type="button" className={`calendar-item external${ev.visibility === 'private' ? ' private-event' : ''}`}
                  key={`${ev.provider}-${ev.provider_event_id}-${ev.starts_at}`} onClick={() => setSelectedEvent(ev)}
                  style={eventColorStyle(sourceColors.get(ev.source_id))}>
                  <span className="calendar-item-time">{formatTime(ev.starts_at, ev.all_day)}{!ev.all_day ? ` – ${formatTime(ev.ends_at)}` : ''}</span><strong>{ev.title}</strong>
                  <small>{providerLabel(ev.provider)} · {ev.source_name}{ev.visibility === 'private' ? ' · privé' : ' · team'}</small>
                </button>)}
                {dt.length === 0 && de.length === 0 && <div className="calendar-no-items">Geen items</div>}
              </div>
            </div>;
          })}
        </div>
      )}
    </div>


    {/* List-view sidebar form */}
    {view === 'list' && (
      <form className="calendar-create-card" onSubmit={submitNewEvent}>
        <div className="calendar-create-head"><CalendarDays size={18} /><div><h3>Nieuw extern event</h3><p>Schrijf naar je eigen of een gedeelde agenda.</p></div></div>
        <label>Agenda<Select value={newEvent.sourceId} onChange={e => setNewEvent(p => ({ ...p, sourceId: e.target.value }))}>
          <option value="">Kies agenda</option>
          {writeableSources.map(s => <option value={s.id} key={s.id}>{providerLabel(s.provider)} · {s.name}{s.visibility === 'private' ? ' · privé' : ' · team'}</option>)}
        </Select></label>
        <label>Titel<Input value={newEvent.title} onChange={e => setNewEvent(p => ({ ...p, title: e.target.value }))} placeholder="Bijv. Intake klant" /></label>
        <label>Locatie<Input value={newEvent.location} onChange={e => setNewEvent(p => ({ ...p, location: e.target.value }))} placeholder="Optioneel" /></label>
        <div className="settings-grid compact">
          <label>Start<Input type="datetime-local" value={newEvent.startsAt} onChange={e => setNewEvent(p => ({ ...p, startsAt: e.target.value }))} /></label>
          <label>Einde<Input type="datetime-local" value={newEvent.endsAt} onChange={e => setNewEvent(p => ({ ...p, endsAt: e.target.value }))} /></label>
        </div>
        <label>Omschrijving<Textarea value={newEvent.description} onChange={e => setNewEvent(p => ({ ...p, description: e.target.value }))} placeholder="Optioneel" /></label>
        <label className="check-row"><input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent(p => ({ ...p, allDay: e.target.checked }))} /> Hele dag</label>
        <div className="tb-panel-section-label">Koppelen aan</div>
        <ClientProjectPicker clients={data.clients} projects={data.projects} clientId={newEvent.clientId} projectId={newEvent.projectId}
          onChange={next => setNewEvent(p => ({ ...p, clientId: next.clientId, projectId: next.projectId }))} />
        <Button variant="primary" disabled={loading || !canWrite || !writeableSources.length}>Event aanmaken</Button>
        {!writeableSources.length && <p className="calendar-help">Zet bij je eigen agenda eerst "Schrijven" aan.</p>}
      </form>
    )}

    {/* FAB for time-grid views */}
    {(view === 'day' || view === 'week') && canWrite && writeableSources.length > 0 && !showCreatePanel && (
      <button className="tb-fab" onClick={() => { const d = makeDefaultTimes(); setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: d.startsAt, endsAt: d.endsAt, clientId: '', projectId: '' })); setShowCreatePanel(true); }} title="Nieuw event aanmaken">
        <Plus size={22} />
      </button>
    )}

    {/* Floating panel */}
    {showCreatePanel && <EventCreationPanel newEvent={newEvent} setNewEvent={setNewEvent} writeableSources={writeableSources}
      clients={data.clients} projects={data.projects}
      loading={loading} canWrite={canWrite} onSubmit={submitNewEvent} onClose={() => setShowCreatePanel(false)} />}

    <CalendarEventDetailPanel event={selectedEvent} data={data} sourceColors={sourceColors} canWrite={canWrite} onNewNote={onNewNoteForEvent} onNewDocument={onNewDocumentForEvent} onSetEventLink={onSetEventLink} onEditNote={onEditNote} onLinkExistingNote={onLinkExistingNoteToEvent} onUnlinkNote={onUnlinkNoteFromEvent} onClose={() => setSelectedEvent(null)} />
  </div>;
}
