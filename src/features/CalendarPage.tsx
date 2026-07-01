import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { CalendarDays, CalendarPlus, ChevronDown, ChevronRight, Clock, ExternalLink, LayoutList, MapPin, Pencil, Plus, RefreshCcw, Repeat, Trash2, Unplug, Video, X } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { MeetingRecorder } from '../components/MeetingRecorder';
import { RichTextExcerpt } from '../components/RichTextEditor';
import { createNoteWithCalendarLink } from '../lib/repository';
import { addDays, DAY_NAMES_NL, formatISODate, isSameDay, parseISODate, startOfWeek } from '../lib/dates';
import { dateNL, formatMinutes } from '../lib/format';
import { detectMeetingKind, isValidMeetingUrl } from '../lib/meeting';
import {
  createCalendarAppPassword,
  createExternalCalendarEvent,
  createNativeCalendar,
  deleteCalendarEvent,
  deleteNativeCalendar,
  disconnectCalendarConnection,
  getCalendarEventAttendees,
  getCalendarOAuthUrl,
  listCalendarAppPasswords,
  listExternalCalendarEvents,
  loadCalendarIntegrations,
  refreshCalendarSources,
  revokeCalendarAppPassword,
  updateCalendarEvent,
  updateCalendarSource,
  updateNativeCalendar,
  type CalendarEventRef,
  type CalendarIntegrationsPayload,
} from '../lib/calendar-api';
import { supabase } from '../lib/supabase';
import type { AttendeeStatus, CalendarAppPassword, CalendarEventAttendee, EventRecurrence, RecurrenceFrequency } from '../types';
import type { AppData, CalendarEventLink, CalendarExternalEvent, CalendarProvider, CalendarSource, CalendarVisibility, Client, Note, NoteCalendarLink, Project, Task, UUID } from '../types';
import { getNoteTypeLabel } from './Notes';
import { TimeEntryModal } from './TimeTracking';

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
// Slepen & herschalen van agenda-items: de zichtbare dag beslaat DAY_MINUTES
// minuten; tijden worden op SNAP_MIN-rasters afgerond zodat slepen netjes "klikt".
const DAY_MINUTES = (HOUR_END - HOUR_START) * 60;
const SNAP_MIN = 15;
const MIN_EVENT_MINUTES = 15;

/** Bouwt een Google Maps-zoek-URL voor een vrije locatietekst. */
function googleMapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Identiteit van een agenda-item voor bewerk/verwijder-acties (native vs extern). */
function eventRef(event: CalendarExternalEvent): CalendarEventRef {
  return event.provider === 'native'
    ? { eventId: event.native_event_id, sourceId: event.source_id }
    : { sourceId: event.source_id, providerEventId: event.provider_event_id };
}

function toInputDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputDateTimeToIso(value: string): string {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

/** Parseert een eenvoudige RRULE-string naar de formuliervelden (freq + einddatum). */
function parseRruleToForm(rrule: string | null): { freq: '' | RecurrenceFrequency; until: string } {
  if (!rrule) return { freq: '', until: '' };
  const map: Record<string, RecurrenceFrequency> = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' };
  const parts = new Map<string, string>();
  for (const seg of rrule.split(';')) { const [k, v] = seg.split('='); if (k && v) parts.set(k.toUpperCase(), v); }
  const freq = map[(parts.get('FREQ') || '').toUpperCase()] ?? '';
  let until = '';
  const u = parts.get('UNTIL');
  if (u) { const m = u.match(/^(\d{4})(\d{2})(\d{2})/); if (m) until = `${m[1]}-${m[2]}-${m[3]}`; }
  return { freq, until };
}

const RECURRENCE_LABELS: Record<RecurrenceFrequency, string> = { daily: 'Elke dag', weekly: 'Elke week', monthly: 'Elke maand' };

type NewEventState = {
  sourceId: string; title: string; description: string; location: string;
  startsAt: string; endsAt: string; allDay: boolean; clientId: string; projectId: string;
  trackTime: boolean;
  recurrenceFreq: '' | RecurrenceFrequency; recurrenceUntil: string; editingEventId: string;
  attendees: { email: string; name: string }[];
  meetingUrl: string; addConference: boolean;
};

const ATTENDEE_STATUS_LABELS: Record<AttendeeStatus, string> = {
  'needs-action': 'Nog niet beantwoord',
  accepted: 'Geaccepteerd',
  declined: 'Afgewezen',
  tentative: 'Misschien',
};

/** Korte, leesbare omschrijving van een herhaling voor in het detailpaneel. */
function recurrenceLabel(rrule: string | null | undefined): string | null {
  const { freq, until } = parseRruleToForm(rrule ?? null);
  if (!freq) return null;
  const base = RECURRENCE_LABELS[freq];
  return until ? `${base}, t/m ${dateNL(until)}` : base;
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

type EventInteractionMode = 'move' | 'resize-start' | 'resize-end';
interface EventInteraction {
  mode: EventInteractionMode;
  event: CalendarExternalEvent;
  originDayIndex: number;
  originStartMin: number;
  originEndMin: number;
  grabOffsetMin: number;
  pointerStartX: number;
  pointerStartY: number;
  preview: { dayIndex: number; startMin: number; endMin: number };
  moved: boolean;
}

// Pas slepen pas toe nadat de cursor merkbaar bewogen is; zo opent een gewone
// klik (met minieme trilling) gewoon het item i.p.v. het ongewild te verzetten.
const DRAG_THRESHOLD_PX = 4;

function eventIdentityKey(ev: CalendarExternalEvent): string {
  return `${ev.provider}|${ev.source_id}|${ev.provider_event_id}|${ev.starts_at}`;
}

function TimeBlockGrid({ days, events, tasks, sourceColors, trackedMinutesFor, canWrite, writeableSources, onSelectSlot, onEditTask, onOpenEvent, onMoveEvent }: {
  days: Date[];
  events: CalendarExternalEvent[];
  tasks: Task[];
  sourceColors: Map<string, string>;
  trackedMinutesFor: (event: CalendarExternalEvent) => number | null;
  canWrite: boolean;
  writeableSources: CalendarSource[];
  onSelectSlot: (day: Date, startSlot: number, endSlot: number) => void;
  onEditTask: (task: Task) => void;
  onOpenEvent: (event: CalendarExternalEvent) => void;
  onMoveEvent: (event: CalendarExternalEvent, startIso: string, endIso: string) => void | Promise<void>;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const canSelect = canWrite && writeableSources.length > 0;
  const daysKey = days.map(formatISODate).join('|');

  // Slepen/herschalen van bestaande native afspraken.
  const [interaction, setInteraction] = useState<EventInteraction | null>(null);
  const interactionRef = useRef<EventInteraction | null>(null);
  const draggedRef = useRef(false);

  const writeableSourceIds = useMemo(() => new Set(writeableSources.map(s => s.id)), [writeableSources]);
  const canDragEvent = useCallback(
    (ev: CalendarExternalEvent) => {
      if (!canWrite || ev.is_private_masked || ev.all_day) return false;
      return ev.provider === 'native'
        ? Boolean(ev.native_event_id)
        : Boolean(ev.provider_event_id) && writeableSourceIds.has(ev.source_id);
    },
    [canWrite, writeableSourceIds],
  );

  // Bepaalt boven welke dagkolom de cursor staat en hoeveel minuten vanaf
  // middernacht dat is (op basis van de werkelijk gerenderde kolomhoogte).
  const pointerToCol = useCallback((clientX: number, clientY: number): { dayIndex: number; minutes: number } | null => {
    const cols = colRefs.current;
    let dayIndex = -1;
    for (let i = 0; i < cols.length; i++) {
      const el = cols[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right) { dayIndex = i; break; }
    }
    const refEl = (dayIndex >= 0 ? cols[dayIndex] : cols.find(Boolean)) ?? null;
    if (!refEl) return null;
    const rr = refEl.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientY - rr.top) / rr.height));
    return { dayIndex, minutes: frac * DAY_MINUTES };
  }, []);

  const beginEventInteraction = useCallback((e: React.PointerEvent, ev: CalendarExternalEvent, dayIndex: number, mode: EventInteractionMode) => {
    if (e.pointerType === 'touch') return; // op touch: tikken opent, vegen blijft scrollen
    if (e.button !== 0) return;
    if (!canDragEvent(ev)) return;
    const dayStart = startOfDay(days[dayIndex]).getTime();
    const startMin = (new Date(ev.starts_at).getTime() - dayStart) / 60000;
    const endMin = (new Date(ev.ends_at).getTime() - dayStart) / 60000;
    if (startMin < 0 || endMin > DAY_MINUTES) return; // meerdaagse blokken: niet slepen
    e.preventDefault();
    e.stopPropagation();
    const hit = pointerToCol(e.clientX, e.clientY);
    const grabOffsetMin = hit ? hit.minutes - startMin : 0;
    const next: EventInteraction = {
      mode, event: ev, originDayIndex: dayIndex,
      originStartMin: startMin, originEndMin: endMin, grabOffsetMin,
      pointerStartX: e.clientX, pointerStartY: e.clientY,
      preview: { dayIndex, startMin, endMin }, moved: false,
    };
    interactionRef.current = next;
    setInteraction(next);
  }, [canDragEvent, days, pointerToCol]);

  // Pointermove/-up wereldwijd volgen zolang er een interactie loopt.
  useEffect(() => {
    if (!interaction) return;
    const snap = (m: number) => Math.round(m / SNAP_MIN) * SNAP_MIN;
    function onMove(e: PointerEvent) {
      const it = interactionRef.current;
      if (!it) return;
      // Pas reageren zodra de drempel gepasseerd is (anders blijft het een klik).
      if (!it.moved && Math.hypot(e.clientX - it.pointerStartX, e.clientY - it.pointerStartY) <= DRAG_THRESHOLD_PX) return;
      const hit = pointerToCol(e.clientX, e.clientY);
      if (!hit) return;
      let preview: EventInteraction['preview'];
      if (it.mode === 'move') {
        const di = hit.dayIndex >= 0 ? hit.dayIndex : it.preview.dayIndex;
        const duration = it.originEndMin - it.originStartMin;
        let s = snap(hit.minutes - it.grabOffsetMin);
        s = Math.max(0, Math.min(s, DAY_MINUTES - duration));
        preview = { dayIndex: di, startMin: s, endMin: s + duration };
      } else if (it.mode === 'resize-end') {
        let en = snap(hit.minutes);
        en = Math.max(it.originStartMin + MIN_EVENT_MINUTES, Math.min(en, DAY_MINUTES));
        preview = { dayIndex: it.originDayIndex, startMin: it.originStartMin, endMin: en };
      } else {
        let s = snap(hit.minutes);
        s = Math.min(it.originEndMin - MIN_EVENT_MINUTES, Math.max(0, s));
        preview = { dayIndex: it.originDayIndex, startMin: s, endMin: it.originEndMin };
      }
      const updated: EventInteraction = { ...it, preview, moved: true };
      interactionRef.current = updated;
      setInteraction(updated);
    }
    function onUp() {
      const it = interactionRef.current;
      interactionRef.current = null;
      setInteraction(null);
      if (!it || !it.moved) return; // gewone klik → laat onClick het item openen
      draggedRef.current = true; // onderdruk de klik die direct na het slepen volgt
      window.setTimeout(() => { draggedRef.current = false; }, 0);
      const pv = it.preview;
      const changed = pv.dayIndex !== it.originDayIndex || pv.startMin !== it.originStartMin || pv.endMin !== it.originEndMin;
      if (!changed) return; // teruggesleept naar de oorspronkelijke plek: niets opslaan
      const day = days[pv.dayIndex] ?? days[it.originDayIndex];
      const base = startOfDay(day).getTime();
      const startIso = new Date(base + pv.startMin * 60000).toISOString();
      const endIso = new Date(base + pv.endMin * 60000).toISOString();
      void onMoveEvent(it.event, startIso, endIso);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [interaction !== null, days, onMoveEvent, pointerToCol]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (interactionRef.current) return; // niet selecteren terwijl een item gesleept wordt
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
                <div className={`tb-col${isToday ? ' tb-today-col' : ''}`} key={di} ref={el => { colRefs.current[di] = el; }} style={{ gridColumn: di + 2, gridRow: `1 / span ${TOTAL_SLOTS}` }}>
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
                    const trackedMin = trackedMinutesFor(ev);
                    const draggable = canDragEvent(ev) && !segment.startsBeforeDay && !segment.endsAfterDay;
                    const isGhosted = Boolean(interaction) && eventIdentityKey(interaction!.event) === eventIdentityKey(ev);
                    return (
                      <button type="button" className={`tb-ev${densityClass}${ev.visibility === 'private' ? ' tb-ev-priv' : ''}${trackedMin != null ? ' tb-ev-tracked' : ''}${draggable ? ' tb-ev-draggable' : ''}${isGhosted ? ' tb-ev-ghosted' : ''}`} key={`${ev.provider}-${ev.provider_event_id}-${di}`}
                        onClick={() => { if (draggedRef.current) return; onOpenEvent(ev); }}
                        onPointerDown={draggable ? e => beginEventInteraction(e, ev, di, 'move') : undefined}
                        style={{
                          ...eventColorStyle(eventColor(ev)),
                          top: `${segment.top}%`,
                          height: `${segment.height}%`,
                          left: `calc(${left}% + 2px)`,
                          right: `calc(${right}% + 2px)`,
                        }}
                        title={`${visualTime}\n${ev.title}\n${eventMeta}${trackedMin != null ? `\n${formatMinutes(trackedMin)} geregistreerd` : ''}${draggable ? '\nSleep om te verplaatsen · sleep de randen om de duur te wijzigen' : ''}`}>
                        {trackedMin != null && <span className="tb-ev-track" title={`${formatMinutes(trackedMin)} geregistreerd`}><Clock size={10} />{formatMinutes(trackedMin)}</span>}
                        {ev.meeting_url && <span className="tb-ev-video" title="Videocall gekoppeld"><Video size={10} /></span>}
                        {draggable && <span className="tb-ev-handle tb-ev-handle-top" onPointerDown={e => beginEventInteraction(e, ev, di, 'resize-start')} title="Sleep om de starttijd te wijzigen" />}
                        <span className="tb-ev-time">{visualTime}</span>
                        <span className="tb-ev-title">{ev.title}</span>
                        <span className="tb-ev-src">{eventMeta}</span>
                        {draggable && <span className="tb-ev-handle tb-ev-handle-bottom" onPointerDown={e => beginEventInteraction(e, ev, di, 'resize-end')} title="Sleep om de eindtijd te wijzigen" />}
                      </button>
                    );
                  })}

                  {interaction && interaction.preview.dayIndex === di && (() => {
                    const pv = interaction.preview;
                    const top = (pv.startMin / DAY_MINUTES) * 100;
                    const height = Math.max(((pv.endMin - pv.startMin) / DAY_MINUTES) * 100, (100 / TOTAL_SLOTS) * MIN_EVENT_HEIGHT_SLOTS);
                    const fmt = (m: number) => formatHour(Math.floor(m / 60) % 24, Math.round(m % 60));
                    return (
                      <div className="tb-ev tb-ev-preview" style={{ ...eventColorStyle(eventColor(interaction.event)), top: `${top}%`, height: `${height}%`, left: '2px', right: '2px' }}>
                        <span className="tb-ev-time">{fmt(pv.startMin)} – {fmt(pv.endMin)}</span>
                        <span className="tb-ev-title">{interaction.event.title}</span>
                      </div>
                    );
                  })()}

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

      {canSelect && <p className="tb-hint">Sleep over lege tijdslots om snel een event aan te maken · sleep een afspraak om te verplaatsen · sleep de boven-/onderrand om de duur te wijzigen</p>}
    </div>
  );
}

/* ── Month view ───────────────────────────────────────────────────────── */

function CalendarMonthView({ days, anchor, events, tasks, data, sourceColors, trackedMinutesFor, onEditTask, onOpenDay, onOpenEvent }: {
  days: Date[];
  anchor: Date;
  events: CalendarExternalEvent[];
  tasks: Task[];
  data: AppData;
  sourceColors: Map<string, string>;
  trackedMinutesFor: (event: CalendarExternalEvent) => number | null;
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
                    {trackedMinutesFor(item.ev) != null && <em className="month-chip-track"><Clock size={9} />{formatMinutes(trackedMinutesFor(item.ev)!)}</em>}
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

/* ── Locatieveld met kaart-suggesties ───────────────────────────────── */

type GeoSuggestion = { place_id: number | string; display_name: string };

/**
 * Locatie-invoer met adres-suggesties terwijl je typt (gratis via OpenStreetMap
 * Nominatim, geen API-sleutel nodig) plus een knop om de locatie in Google Maps
 * te openen. Suggesties worden ge-debounced; kiezen vult het volledige adres in.
 */
function LocationField({ value, onChange, placeholder }: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<GeoSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const skipFetchRef = useRef(false);

  useEffect(() => {
    // Na het kiezen van een suggestie niet meteen opnieuw zoeken op de ingevulde tekst.
    if (skipFetchRef.current) { skipFetchRef.current = false; return; }
    const q = value.trim();
    if (q.length < 3) { setSuggestions([]); setOpen(false); return; }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=nl&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('geocode-fout');
        const rows = (await res.json()) as GeoSuggestion[];
        setSuggestions(Array.isArray(rows) ? rows : []);
        setOpen(true);
        setHighlight(-1);
      } catch {
        setSuggestions([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [value]);

  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  function pick(s: GeoSuggestion) {
    skipFetchRef.current = true;
    onChange(s.display_name);
    setSuggestions([]);
    setOpen(false);
    setHighlight(-1);
  }

  return (
    <div className="location-field" ref={boxRef}>
      <div className="location-field-row">
        <Input
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          onFocus={() => { if (suggestions.length) setOpen(true); }}
          onKeyDown={e => {
            if (!open || suggestions.length === 0) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, suggestions.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
            else if (e.key === 'Enter' && highlight >= 0) { e.preventDefault(); pick(suggestions[highlight]); }
            else if (e.key === 'Escape') { setOpen(false); }
          }}
        />
        {value.trim() && (
          <a className="location-field-maps" href={googleMapsSearchUrl(value)} target="_blank" rel="noreferrer"
            title="Open in Google Maps" onMouseDown={e => e.stopPropagation()}>
            <MapPin size={15} />
          </a>
        )}
      </div>
      {open && (loading || suggestions.length > 0) && (
        <ul className="location-suggestions">
          {loading && <li className="location-suggestion-empty">Zoeken…</li>}
          {!loading && suggestions.map((s, i) => (
            <li key={s.place_id}>
              <button type="button" className={`location-suggestion${i === highlight ? ' active' : ''}`}
                onMouseDown={e => { e.preventDefault(); pick(s); }}>
                <MapPin size={13} /><span>{s.display_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Floating creation panel ─────────────────────────────────────────── */

// Videovergadering-veld: automatisch genereren (Google Meet op Google, Teams op
// Microsoft) óf zelf een Meet/Teams/Zoom-link plakken. Op de eigen ResoFly-agenda
// (native) kan alleen een link geplakt worden — die hosten we immers niet zelf.
function MeetingFields({ provider, meetingUrl, addConference, onChange }: {
  provider: CalendarProvider | null;
  meetingUrl: string;
  addConference: boolean;
  onChange: (patch: Partial<Pick<NewEventState, 'meetingUrl' | 'addConference'>>) => void;
}) {
  const canAuto = provider === 'google' || provider === 'microsoft';
  const autoLabel = provider === 'microsoft' ? 'Teams-vergadering' : 'Google Meet-link';
  // Auto-genereren kan alleen bij Google/Microsoft; op een native agenda vervalt het
  // altijd naar het plakveld (ook als addConference nog van een eerdere bron aanstond).
  const autoActive = canAuto && addConference;
  const trimmed = meetingUrl.trim();
  const invalid = trimmed.length > 0 && !isValidMeetingUrl(trimmed);
  const detected = trimmed && !invalid ? detectMeetingKind(trimmed) : null;
  return (
    <div className="event-meeting-field">
      <div className="tb-panel-section-label"><Video size={13} /> Videovergadering</div>
      {canAuto && (
        <label className="check-row">
          <input type="checkbox" checked={addConference}
            onChange={e => onChange(e.target.checked ? { addConference: true, meetingUrl: '' } : { addConference: false })} />
          <span>Voeg automatisch een {autoLabel} toe</span>
        </label>
      )}
      {autoActive ? (
        <p className="calendar-help">Er wordt automatisch een {autoLabel} aangemaakt en meegestuurd met de uitnodiging.</p>
      ) : (
        <>
          <label>{canAuto ? 'Of plak een eigen videocall-link' : 'Videocall-link'}
            <Input type="url" value={meetingUrl} placeholder="Google Meet-, Teams- of Zoom-link…"
              onChange={e => onChange({ meetingUrl: e.target.value })} />
          </label>
          {invalid
            ? <p className="calendar-help calendar-help-warn">Voer een geldige http(s)-link in.</p>
            : detected && <p className="calendar-help"><Video size={12} /> {detected.label}-link herkend</p>}
        </>
      )}
    </div>
  );
}

function EventCreationPanel({ newEvent, setNewEvent, writeableSources, clients, projects, loading, canWrite, selectedSourceIsNative, selectedSourceProvider, onSubmit, onClose }: {
  newEvent: NewEventState;
  setNewEvent: (fn: (prev: NewEventState) => NewEventState) => void;
  writeableSources: CalendarSource[];
  clients: Client[];
  projects: Project[];
  loading: boolean;
  canWrite: boolean;
  selectedSourceIsNative: boolean;
  selectedSourceProvider: CalendarProvider | null;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}) {
  const editing = Boolean(newEvent.editingEventId);
  const [attendeeEmail, setAttendeeEmail] = useState('');
  function addAttendee() {
    const email = attendeeEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    setAttendeeEmail('');
    if (newEvent.attendees.some(a => a.email === email)) return;
    setNewEvent(p => ({ ...p, attendees: [...p.attendees, { email, name: '' }] }));
  }
  return (
    <div className="tb-overlay" onClick={onClose}>
      <form className="tb-panel" onClick={e => e.stopPropagation()} onSubmit={onSubmit}>
        <div className="tb-panel-head">
          <div className="tb-panel-title"><CalendarDays size={16} /><h3>{editing ? 'Afspraak bewerken' : 'Nieuwe afspraak'}</h3></div>
          <button type="button" className="tb-panel-close" onClick={onClose}><X size={16} /></button>
        </div>
        <label>Agenda<Select value={newEvent.sourceId} disabled={editing} onChange={e => setNewEvent(p => ({ ...p, sourceId: e.target.value }))}>
          <option value="">Kies agenda</option>
          {writeableSources.map(s => <option value={s.id} key={s.id}>{providerLabel(s.provider)} · {s.name}{s.visibility === 'private' ? ' · privé' : ' · team'}</option>)}
        </Select></label>
        {editing && <p className="calendar-help">De agenda van een bestaande afspraak kan niet worden gewijzigd.</p>}
        <label>Titel<Input autoFocus value={newEvent.title} onChange={e => setNewEvent(p => ({ ...p, title: e.target.value }))} placeholder="Bijv. Intake klant" /></label>
        <label>Locatie<LocationField value={newEvent.location} onChange={next => setNewEvent(p => ({ ...p, location: next }))} placeholder="Zoek een adres of plaats…" /></label>
        <div className="settings-grid compact">
          <label>Start<Input type="datetime-local" value={newEvent.startsAt} onChange={e => setNewEvent(p => ({ ...p, startsAt: e.target.value }))} /></label>
          <label>Einde<Input type="datetime-local" value={newEvent.endsAt} onChange={e => setNewEvent(p => ({ ...p, endsAt: e.target.value }))} /></label>
        </div>
        <label>Omschrijving<Textarea value={newEvent.description} onChange={e => setNewEvent(p => ({ ...p, description: e.target.value }))} placeholder="Optioneel" /></label>
        <label className="check-row"><input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent(p => ({ ...p, allDay: e.target.checked }))} /> Hele dag</label>
        <MeetingFields provider={selectedSourceProvider} meetingUrl={newEvent.meetingUrl} addConference={newEvent.addConference}
          onChange={patch => setNewEvent(p => ({ ...p, ...patch }))} />
        {selectedSourceIsNative ? (
          <div className="settings-grid compact">
            <label>Herhaling<Select value={newEvent.recurrenceFreq} onChange={e => setNewEvent(p => ({ ...p, recurrenceFreq: e.target.value as '' | RecurrenceFrequency }))}>
              <option value="">Niet herhalen</option>
              <option value="daily">Elke dag</option>
              <option value="weekly">Elke week</option>
              <option value="monthly">Elke maand</option>
            </Select></label>
            {newEvent.recurrenceFreq && <label>Tot en met<Input type="date" value={newEvent.recurrenceUntil} onChange={e => setNewEvent(p => ({ ...p, recurrenceUntil: e.target.value }))} /></label>}
          </div>
        ) : null}
        {selectedSourceIsNative ? (
          <div className="event-attendees">
            <div className="tb-panel-section-label">Genodigden</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Input value={attendeeEmail} type="email" placeholder="naam@voorbeeld.nl"
                onChange={e => setAttendeeEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAttendee(); } }} />
              <Button type="button" onClick={addAttendee}>Toevoegen</Button>
            </div>
            {newEvent.attendees.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {newEvent.attendees.map(a => (
                  <span key={a.email} className="attendee-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(0,0,0,0.06)', borderRadius: 12, padding: '2px 6px 2px 10px' }}>
                    {a.email}
                    <button type="button" aria-label={`Verwijder ${a.email}`} onClick={() => setNewEvent(p => ({ ...p, attendees: p.attendees.filter(x => x.email !== a.email) }))} style={{ border: 'none', background: 'none', cursor: 'pointer', lineHeight: 1 }}><X size={13} /></button>
                  </span>
                ))}
              </div>
            )}
            <p className="calendar-help">Genodigden krijgen een uitnodiging per e-mail en kunnen accepteren of afwijzen.</p>
          </div>
        ) : null}
        <div className="tb-panel-section-label">Koppelen aan</div>
        <ClientProjectPicker clients={clients} projects={projects} clientId={newEvent.clientId} projectId={newEvent.projectId}
          onChange={next => setNewEvent(p => ({ ...p, clientId: next.clientId, projectId: next.projectId }))} />
        {(newEvent.clientId || newEvent.projectId) && !newEvent.allDay && (
          <label className="check-row track-time-row">
            <input type="checkbox" checked={newEvent.trackTime} onChange={e => setNewEvent(p => ({ ...p, trackTime: e.target.checked }))} />
            <span><Clock size={13} /> Telt mee voor urenregistratie</span>
          </label>
        )}
        <Button variant="primary" disabled={loading || !canWrite || !writeableSources.length}>{editing ? 'Wijzigingen opslaan' : 'Afspraak opslaan'}</Button>
      </form>
    </div>
  );
}


function CalendarEventDetailPanel({ event, organizationId, data, sourceColors, canWrite, editable, onNewNote, onNewDocument, onSetEventLink, onLogTime, onReschedule, onEditNote, onLinkExistingNote, onUnlinkNote, onEditEvent, onDeleteEvent, onClose }: {
  event: CalendarExternalEvent | null;
  organizationId: UUID;
  data: AppData;
  sourceColors: Map<string, string>;
  canWrite: boolean;
  editable: boolean;
  onNewNote: (event: CalendarExternalEvent) => void;
  onNewDocument: (event: CalendarExternalEvent) => void;
  onSetEventLink: (event: CalendarExternalEvent, clientId: string | null, projectId: string | null, trackTime?: boolean) => void | Promise<void>;
  onLogTime: (event: CalendarExternalEvent) => void;
  onReschedule: (event: CalendarExternalEvent, startIso: string, endIso: string) => void | Promise<void>;
  onEditNote: (note: Note) => void;
  onLinkExistingNote: (noteId: UUID, event: CalendarExternalEvent) => void | Promise<void>;
  onUnlinkNote: (linkId: UUID) => void | Promise<void>;
  onEditEvent: (event: CalendarExternalEvent) => void;
  onDeleteEvent: (event: CalendarExternalEvent) => void | Promise<void>;
  onClose: () => void;
}) {
  const [selectedNoteId, setSelectedNoteId] = useState('');
  const [attendees, setAttendees] = useState<CalendarEventAttendee[]>([]);
  // Snel de tijd aanpassen direct in het detailpaneel (zonder het volledige
  // bewerk-formulier te openen).
  const [startLocal, setStartLocal] = useState('');
  const [endLocal, setEndLocal] = useState('');
  const [savingTime, setSavingTime] = useState(false);
  const [timeError, setTimeError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedNoteId('');
  }, [event?.id, event?.provider_event_id, event?.starts_at]);

  useEffect(() => {
    setTimeError(null);
    if (!event) return;
    setStartLocal(toInputDateTime(new Date(event.starts_at)));
    setEndLocal(toInputDateTime(new Date(event.ends_at)));
  }, [event?.id, event?.provider_event_id, event?.starts_at, event?.ends_at]);

  const nativeEventId = event?.provider === 'native' ? event.native_event_id : undefined;
  useEffect(() => {
    setAttendees([]);
    if (!nativeEventId) return;
    let active = true;
    getCalendarEventAttendees(organizationId, nativeEventId).then(rows => { if (active) setAttendees(rows); }).catch(() => {});
    return () => { active = false; };
  }, [nativeEventId, organizationId]);

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

  // Notulen van een opname als gekoppelde notitie op de afspraak (klant/project) opslaan.
  async function saveSummaryAsNote(text: string) {
    if (!event) return;
    await createNoteWithCalendarLink(organizationId, {
      title: `Notulen — ${event.title || 'afspraak'}`.slice(0, 200),
      content: text,
      note_type: 'meeting',
      client_id: eventLink?.client_id ?? null,
      project_id: eventLink?.project_id ?? null,
      tags: [],
    }, {
      provider: event.provider,
      calendar_source_id: event.source_id,
      provider_event_id: event.provider_event_id,
      event_starts_at: event.starts_at,
      event_ends_at: event.ends_at,
      event_title_snapshot: event.title,
      event_location_snapshot: event.location,
      event_html_link: event.html_link,
      visibility_snapshot: event.visibility,
      is_private_masked_snapshot: event.is_private_masked ?? false,
    });
  }
  const lockedReason = event.visibility !== 'organization'
    ? 'Notities koppelen is uitgeschakeld voor privé-agenda-items, zodat persoonlijke agenda-informatie niet per ongeluk organisatiebreed zichtbaar wordt.'
    : event.is_private_masked
      ? 'Dit agenda-item is afgeschermd. Koppelen is geblokkeerd totdat de details zichtbaar gedeeld zijn.'
      : !canWrite
        ? 'Je hebt alleen-lezen toegang tot deze organisatie.'
        : null;

  const isTimeEditable = editable && !event.all_day;
  const timeChanged = isTimeEditable && (
    startLocal !== toInputDateTime(new Date(event.starts_at)) || endLocal !== toInputDateTime(new Date(event.ends_at))
  );
  async function saveTime() {
    const sIso = inputDateTimeToIso(startLocal);
    const eIso = inputDateTimeToIso(endLocal);
    if (new Date(eIso).getTime() <= new Date(sIso).getTime()) { setTimeError('Eindtijd moet na starttijd liggen.'); return; }
    setSavingTime(true); setTimeError(null);
    try { await onReschedule(event!, sIso, eIso); }
    catch (err) { setTimeError(err instanceof Error ? err.message : 'Tijd opslaan mislukt.'); }
    finally { setSavingTime(false); }
  }

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
          {isTimeEditable ? (
            <div className="event-detail-meta-card event-detail-time-edit">
              <Clock size={15} />
              <div className="event-time-edit">
                <div className="event-time-edit-fields">
                  <Input type="datetime-local" value={startLocal} onChange={e => setStartLocal(e.target.value)} aria-label="Starttijd" />
                  <span className="event-time-edit-sep">tot</span>
                  <Input type="datetime-local" value={endLocal} onChange={e => setEndLocal(e.target.value)} aria-label="Eindtijd" />
                </div>
                {timeChanged && (
                  <div className="event-time-edit-actions">
                    <Button type="button" variant="primary" disabled={savingTime} onClick={saveTime}>{savingTime ? 'Opslaan…' : 'Tijd opslaan'}</Button>
                    <Button type="button" variant="ghost" disabled={savingTime} onClick={() => { setStartLocal(toInputDateTime(new Date(event.starts_at))); setEndLocal(toInputDateTime(new Date(event.ends_at))); setTimeError(null); }}>Herstel</Button>
                  </div>
                )}
                {timeError && <span className="event-time-edit-error">{timeError}</span>}
              </div>
            </div>
          ) : (
            <div className="event-detail-meta-card">
              <Clock size={15} />
              <span>{formatEventRange(event)}</span>
            </div>
          )}
          <div className="event-detail-meta-card">
            <CalendarDays size={15} />
            <span>{event.visibility === 'private' ? 'Privé-agenda' : 'Gedeeld met organisatie'}{event.is_private_masked ? ' · details afgeschermd' : ''}</span>
          </div>
          {recurrenceLabel(event.rrule) && (
            <div className="event-detail-meta-card">
              <Repeat size={15} />
              <span>{recurrenceLabel(event.rrule)}</span>
            </div>
          )}
          {event.location && (
            <a className="event-detail-meta-card event-detail-map-link" href={googleMapsSearchUrl(event.location)} target="_blank" rel="noreferrer" title="Open locatie in Google Maps">
              <MapPin size={15} />
              <span>{event.location}</span>
              <ExternalLink size={12} className="event-detail-map-ext" />
            </a>
          )}
          {event.meeting_url && (
            <a className="event-detail-meta-card event-detail-join-link" href={event.meeting_url} target="_blank" rel="noreferrer" title="Deelnemen aan de videocall">
              <Video size={15} />
              <span>Deelnemen · {detectMeetingKind(event.meeting_url).label}</span>
              <ExternalLink size={12} className="event-detail-map-ext" />
            </a>
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
              onChange={next => onSetEventLink(event, next.clientId || null, next.projectId || null, eventLink?.track_time ?? true)}
            />
          ) : (
            <div className="event-link-readonly">
              {linkedClient || linkedProject
                ? <>{linkedClient ? `Klant: ${linkedClient.name}` : 'Geen klant'} · {linkedProject ? `Project: ${linkedProject.name}` : 'Geen project'}</>
                : 'Nog niet gekoppeld aan een klant of project.'}
            </div>
          )}
          {canAttachNotes && eventLink && (eventLink.client_id || eventLink.project_id) && !event.all_day && (() => {
            const tracked = data.timeEntries.find(t => t.calendar_event_link_id === eventLink.id) ?? null;
            return (
              <div className="event-track-time">
                <label className="check-row track-time-row">
                  <input type="checkbox" checked={eventLink.track_time}
                    onChange={e => onSetEventLink(event, eventLink.client_id, eventLink.project_id, e.target.checked)} />
                  <span><Clock size={13} /> Telt mee voor urenregistratie</span>
                </label>
                {eventLink.track_time && tracked && <span className="event-track-time-amount">{formatMinutes(tracked.minutes)} geregistreerd</span>}
              </div>
            );
          })()}
          {canWrite && !event.all_day && (
            <button type="button" className="btn btn-ghost event-log-time-btn" onClick={() => { onClose(); onLogTime(event); }}>
              <Clock size={13} /> Uren loggen
            </button>
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

        {attendees.length > 0 && (
          <section className="event-link-panel">
            <div className="event-link-head">
              <span className="event-notes-kicker">Genodigden</span>
              <h4>Uitnodigingen</h4>
              <p>{attendees.filter(a => a.status === 'accepted').length} van {attendees.length} geaccepteerd</p>
            </div>
            <div className="attendee-status-list">
              {attendees.map(a => (
                <div key={a.id} className="attendee-status-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', gap: 8 }}>
                  <span>{a.display_name || a.email}</span>
                  <span className={`attendee-status attendee-status-${a.status}`}>{ATTENDEE_STATUS_LABELS[a.status]}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <MeetingRecorder
          organizationId={organizationId}
          canWrite={canWrite}
          event={{
            provider: event.provider,
            sourceId: event.source_id,
            eventRef: event.provider_event_id,
            eventTitle: event.title,
            clientId: eventLink?.client_id ?? null,
            projectId: eventLink?.project_id ?? null,
          }}
          onSaveAsNote={canAttachNotes ? saveSummaryAsNote : undefined}
        />

        <div className="event-detail-actions">
          {event.html_link && <a className="btn btn-primary" href={event.html_link} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in agenda</a>}
          {editable && (<>
            <button type="button" className="btn btn-primary" onClick={() => onEditEvent(event)}><Pencil size={14} /> Bewerken</button>
            <button type="button" className="btn btn-danger" onClick={() => onDeleteEvent(event)}><Trash2 size={14} /> Verwijderen</button>
          </>)}
          <button type="button" className="btn btn-ghost" onClick={onClose}>Sluiten</button>
        </div>
      </aside>
    </div>
  );
}

const CALDAV_SERVER_HOST = 'caldav.resofly.com';

/** Beheer van app-wachtwoorden + uitleg om de ResoFly-agenda op de telefoon te zetten (CalDAV). */
function PhoneCalendarCard({ organizationId }: { organizationId: UUID }) {
  const [appPasswords, setAppPasswords] = useState<CalendarAppPassword[]>([]);
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listCalendarAppPasswords(organizationId).then(rows => { if (active) setAppPasswords(rows); }).catch(() => {});
    supabase.auth.getUser().then(({ data }) => { if (active) setEmail(data.user?.email ?? ''); }).catch(() => {});
    return () => { active = false; };
  }, [organizationId]);

  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null); setSecret(null);
    try {
      const result = await createCalendarAppPassword(organizationId, label.trim() || 'Apparaat');
      setSecret(result.secret);
      setLabel('');
      setAppPasswords(prev => [result.appPassword, ...prev]);
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : 'App-wachtwoord aanmaken mislukt.'); }
    finally { setBusy(false); }
  }

  async function revoke(id: UUID) {
    if (!confirm('Dit app-wachtwoord intrekken? Apparaten die het gebruiken verliezen de toegang.')) return;
    setErr(null);
    try {
      await revokeCalendarAppPassword(organizationId, id);
      setAppPasswords(prev => prev.map(p => p.id === id ? { ...p, revoked_at: new Date().toISOString() } : p));
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : 'Intrekken mislukt.'); }
  }

  const active = appPasswords.filter(p => !p.revoked_at);

  return (
    <section className="calendar-section connections-panel" id="calendar-phone">
      <div className="calendar-section-head">
        <div>
          <h3>Agenda op je telefoon</h3>
          <p>Zet je ResoFly-agenda’s op je telefoon via CalDAV (Apple Agenda, of Android met DAVx⁵). Maak per apparaat een app-wachtwoord aan.</p>
        </div>
      </div>

      {err && <div className="error">{err}</div>}

      <form onSubmit={generate} style={{ display: 'flex', gap: 8, margin: '8px 0 12px', flexWrap: 'wrap' }}>
        <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="Naam van het apparaat, bijv. iPhone van Jan" />
        <Button variant="primary" disabled={busy}>App-wachtwoord aanmaken</Button>
      </form>

      {secret && (
        <div className="success" style={{ display: 'grid', gap: 6 }}>
          <strong>Nieuw app-wachtwoord — kopieer het nu, je ziet het maar één keer:</strong>
          <code style={{ fontSize: 16, letterSpacing: 1 }}>{secret}</code>
        </div>
      )}

      <div className="settings-help" style={{ marginTop: 8 }}>
        <strong>Instellen op de telefoon</strong>
        <ol style={{ margin: '6px 0 0 18px' }}>
          <li>Voeg een <em>CalDAV-account</em> toe (iPhone: Instellingen → Agenda → Account → Anders → CalDAV-account).</li>
          <li>Server: <code>{CALDAV_SERVER_HOST}</code></li>
          <li>Gebruikersnaam: <code>{email || 'je inlogmailadres'}</code></li>
          <li>Wachtwoord: het app-wachtwoord hierboven</li>
        </ol>
        <p style={{ marginTop: 6, opacity: 0.8 }}>De CalDAV-server wordt in een volgende stap geactiveerd; app-wachtwoorden kun je nu al klaarzetten.</p>
      </div>

      {active.length > 0 && (
        <div className="source-list" style={{ marginTop: 10 }}>
          {active.map(p => (
            <div className="source-row privacy" key={p.id}>
              <div className="source-info">
                <strong>{p.label}</strong>
                <span>Aangemaakt {dateNL(p.created_at)}{p.last_used_at ? ` · laatst gebruikt ${dateNL(p.last_used_at)}` : ' · nog niet gebruikt'}</span>
              </div>
              <Button variant="danger" onClick={() => revoke(p.id)}><Trash2 size={13} /> Intrekken</Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ── Main CalendarPage ───────────────────────────────────────────────── */

export function CalendarPage({ mode = 'agenda', organizationId, currentUserId, data, canWrite, onChanged, onEditTask, onNewNoteForEvent, onNewDocumentForEvent, onSetEventLink, onEditNote, onLinkExistingNoteToEvent, onUnlinkNoteFromEvent }: {
  mode?: 'agenda' | 'settings';
  organizationId: UUID; currentUserId: UUID | null; data: AppData; canWrite: boolean; onEditTask: (task: Task) => void;
  onChanged: () => void | Promise<void>;
  onNewNoteForEvent: (event: CalendarExternalEvent) => void;
  onNewDocumentForEvent: (event: CalendarExternalEvent) => void;
  onSetEventLink: (event: CalendarExternalEvent, clientId: string | null, projectId: string | null, trackTime?: boolean) => void | Promise<void>;
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
    return { sourceId: '', title: '', description: '', location: '', startsAt: toInputDateTime(s), endsAt: toInputDateTime(e), allDay: false, clientId: '', projectId: '', trackTime: true, recurrenceFreq: '' as '' | RecurrenceFrequency, recurrenceUntil: '', editingEventId: '', attendees: [] as { email: string; name: string }[], meetingUrl: '', addConference: false };
  });
  // Bij het bewerken van een native afspraak bewaren we het originele event, zodat
  // we bij een gewijzigde starttijd de oude koppeling (en afgeleide urenpost) kunnen opruimen.
  const [editingOriginal, setEditingOriginal] = useState<CalendarExternalEvent | null>(null);
  const [newCalendarName, setNewCalendarName] = useState('');

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

  // Mag dit item bewerkt/verplaatst/verwijderd worden? Native: heeft een db-id;
  // extern (Google/Microsoft): de bron staat op schrijfbaar. Afgeschermde
  // privé-items blijven uitgesloten.
  const eventIsEditable = useCallback((event: CalendarExternalEvent): boolean => {
    if (!canWrite || event.is_private_masked) return false;
    if (event.provider === 'native') return Boolean(event.native_event_id);
    return Boolean(event.provider_event_id) && writeableSources.some(s => s.id === event.source_id);
  }, [canWrite, writeableSources]);

  // Agenda-item dat snel gelogd wordt (handmatige urenpost vanuit de afspraak).
  const [logTimeEvent, setLogTimeEvent] = useState<CalendarExternalEvent | null>(null);

  // Geregistreerde minuten per agenda-item: koppel time_entries via hun
  // calendar_event_link_id aan de eventidentiteit, zodat de blokken de uren tonen.
  const trackedMinutesByEvent = useMemo(() => {
    const minutesByLink = new Map<string, number>();
    for (const te of data.timeEntries) if (te.calendar_event_link_id) minutesByLink.set(te.calendar_event_link_id, te.minutes);
    const map = new Map<string, number>();
    for (const link of data.calendarEventLinks) {
      if (!link.track_time) continue;
      const mins = minutesByLink.get(link.id);
      if (mins == null) continue;
      map.set(`${link.provider}|${link.calendar_source_id}|${link.provider_event_id}|${new Date(link.event_starts_at).getTime()}`, mins);
    }
    return map;
  }, [data.timeEntries, data.calendarEventLinks]);
  const trackedMinutesFor = useCallback(
    (event: CalendarExternalEvent): number | null =>
      trackedMinutesByEvent.get(`${event.provider}|${event.source_id}|${event.provider_event_id}|${new Date(event.starts_at).getTime()}`) ?? null,
    [trackedMinutesByEvent],
  );

  // Opent de uren-modal voorgevuld met de klant/het project en de duur van de afspraak.
  const openLogTimeForEvent = useCallback((event: CalendarExternalEvent) => {
    setSelectedEvent(null);
    setLogTimeEvent(event);
  }, []);

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
    setEditingOriginal(null);
    setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: toInputDateTime(sd), endsAt: toInputDateTime(ed), clientId: '', projectId: '', trackTime: true, editingEventId: '', meetingUrl: '', addConference: false }));
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
    const source = integrations.sources.find(s => s.id === newEvent.sourceId);
    const isNative = source?.provider === 'native';
    const recurrence: EventRecurrence | null = isNative && newEvent.recurrenceFreq
      ? { freq: newEvent.recurrenceFreq, until: newEvent.recurrenceUntil ? `${newEvent.recurrenceUntil}T23:59:59.000Z` : null }
      : null;
    const input = {
      sourceId: newEvent.sourceId, title: newEvent.title.trim(),
      description: newEvent.description.trim() || null, location: newEvent.location.trim() || null,
      startsAt: sIso, endsAt: eIso, allDay: newEvent.allDay, recurrence,
      attendees: isNative ? newEvent.attendees.map(a => ({ email: a.email, name: a.name || null })) : undefined,
      // Automatisch genereren kan alleen bij Google/Microsoft; native accepteert alleen een geplakte link.
      meetingUrl: newEvent.addConference && !isNative ? null : (newEvent.meetingUrl.trim() || null),
      addConference: !isNative && newEvent.addConference,
    };
    setLoading(true); setError(null); setMessage(null);
    try {
      if (newEvent.editingEventId) {
        const ref = editingOriginal ? eventRef(editingOriginal) : { eventId: newEvent.editingEventId, sourceId: newEvent.sourceId };
        const updated = await updateCalendarEvent(organizationId, ref, input);
        // Is de afspraak naar een ander tijdstip verplaatst? Dan staat de oude
        // koppeling nog op de vorige starttijd (die zit in de unieke sleutel).
        // Ontkoppel die eerst, zodat de afgeleide urenpost niet verweesd achterblijft.
        const moved = editingOriginal && new Date(editingOriginal.starts_at).getTime() !== new Date(updated.starts_at).getTime();
        if (moved && editingOriginal) await onSetEventLink(editingOriginal, null, null);
        // (Her)koppel op de huidige identiteit — leeg = ontkoppelen.
        await onSetEventLink(updated, newEvent.clientId || null, newEvent.projectId || null, newEvent.trackTime);
        setMessage('Afspraak bijgewerkt.');
      } else {
        const created = await createExternalCalendarEvent(organizationId, input);
        if (newEvent.clientId || newEvent.projectId) await onSetEventLink(created, newEvent.clientId || null, newEvent.projectId || null, newEvent.trackTime);
        setMessage(isNative ? 'Afspraak aangemaakt in je ResoFly-agenda.' : 'Event aangemaakt en zichtbaar in je externe agenda.');
      }
      setEditingOriginal(null);
      const d = makeDefaultTimes();
      setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: d.startsAt, endsAt: d.endsAt, clientId: '', projectId: '', trackTime: true, recurrenceFreq: '', recurrenceUntil: '', editingEventId: '', attendees: [], meetingUrl: '', addConference: false }));
      setShowCreatePanel(false);
      refreshEventsOnly().catch(() => {});
    } catch (err) { setError(err instanceof Error ? err.message : 'Opslaan mislukt.'); }
    finally { setLoading(false); }
  }

  async function startEditEvent(event: CalendarExternalEvent) {
    if (!eventIsEditable(event)) return;
    const isNative = event.provider === 'native';
    const rec = parseRruleToForm(event.rrule ?? null);
    const link = data.calendarEventLinks.find(l => calendarEventLinkMatchesEvent(l, event)) ?? null;
    let attendees: { email: string; name: string }[] = [];
    if (isNative && event.native_event_id) {
      try {
        const rows = await getCalendarEventAttendees(organizationId, event.native_event_id);
        attendees = rows.map(r => ({ email: r.email, name: r.display_name ?? '' }));
      } catch { /* genodigden zijn optioneel */ }
    }
    setSelectedEvent(null);
    setEditingOriginal(event);
    setNewEvent(p => ({
      ...p,
      sourceId: event.source_id,
      title: event.title === '(Geen titel)' ? '' : event.title,
      description: event.description ?? '',
      location: event.location ?? '',
      allDay: event.all_day,
      startsAt: toInputDateTime(new Date(event.starts_at)),
      endsAt: toInputDateTime(new Date(event.ends_at)),
      clientId: link?.client_id ?? '', projectId: link?.project_id ?? '',
      trackTime: link?.track_time ?? true,
      recurrenceFreq: rec.freq, recurrenceUntil: rec.until,
      editingEventId: isNative ? (event.native_event_id as string) : event.provider_event_id,
      attendees,
      meetingUrl: event.meeting_url ?? '',
      addConference: false,
    }));
    setShowCreatePanel(true);
  }

  async function removeEvent(event: CalendarExternalEvent) {
    if (!eventIsEditable(event)) return;
    if (!confirm('Deze afspraak verwijderen?')) return;
    setLoading(true); setError(null); setMessage(null);
    try {
      await deleteCalendarEvent(organizationId, eventRef(event));
      setSelectedEvent(null);
      setMessage('Afspraak verwijderd.');
      await refreshEventsOnly();
    } catch (err) { setError(err instanceof Error ? err.message : 'Verwijderen mislukt.'); }
    finally { setLoading(false); }
  }

  // Verplaatst/herschaalt een afspraak (drag & drop, randen slepen, of de tijd
  // aanpassen in het detailpaneel) — native én extern (Google/Microsoft).
  // Behoudt titel/omschrijving/locatie; voor native ook herhaling + genodigden.
  // Verhuist de klant/project-koppeling mee wanneer de starttijd wijzigt (die
  // zit in de unieke sleutel van de koppeling).
  const rescheduleEvent = useCallback(async (event: CalendarExternalEvent, startIso: string, endIso: string) => {
    if (!eventIsEditable(event)) return;
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) { setError('Eindtijd moet na starttijd liggen.'); return; }
    const isNative = event.provider === 'native';
    // Optimistisch verschuiven zodat het blok meteen op de nieuwe plek staat.
    setEvents(prev => prev.map(e => e === event ? { ...e, starts_at: startIso, ends_at: endIso } : e));
    setError(null);
    let recurrence: EventRecurrence | null = null;
    let attendees: { email: string; name: string | null }[] | undefined;
    if (isNative && event.native_event_id) {
      const rec = parseRruleToForm(event.rrule ?? null);
      recurrence = rec.freq ? { freq: rec.freq, until: rec.until ? `${rec.until}T23:59:59.000Z` : null } : null;
      try {
        const rows = await getCalendarEventAttendees(organizationId, event.native_event_id);
        attendees = rows.map(r => ({ email: r.email, name: r.display_name ?? null }));
      } catch { /* genodigden zijn optioneel; nooit het verschuiven laten falen */ }
    }
    const input = {
      sourceId: event.source_id,
      title: event.title?.trim() || 'Afspraak',
      description: event.description ?? null,
      location: event.location ?? null,
      startsAt: startIso, endsAt: endIso, allDay: event.all_day,
      recurrence, attendees,
      // Videocall-link behouden bij verplaatsen/herschalen.
      meetingUrl: event.meeting_url ?? null,
    };
    try {
      const updated = await updateCalendarEvent(organizationId, eventRef(event), input);
      const startChanged = new Date(event.starts_at).getTime() !== new Date(updated.starts_at).getTime();
      if (startChanged) {
        const link = data.calendarEventLinks.find(l => calendarEventLinkMatchesEvent(l, event)) ?? null;
        if (link && (link.client_id || link.project_id)) {
          await onSetEventLink(event, null, null);
          await onSetEventLink(updated, link.client_id, link.project_id, link.track_time);
        }
      }
      setSelectedEvent(prev => (prev && prev === event) ? updated : prev);
      await refreshEventsOnly();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verplaatsen mislukt.');
      await refreshEventsOnly();
    }
  }, [eventIsEditable, organizationId, data.calendarEventLinks, onSetEventLink]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addNativeCalendar(e: FormEvent) {
    e.preventDefault();
    if (!canWrite) { setError('Je hebt alleen-lezen toegang.'); return; }
    const name = newCalendarName.trim();
    if (!name) { setError('Geef de agenda een naam.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try {
      await createNativeCalendar(organizationId, { name });
      setNewCalendarName('');
      setIntegrations(await loadCalendarIntegrations(organizationId));
      setMessage('ResoFly-agenda aangemaakt.');
      if (mode === 'agenda') await refreshEventsOnly();
    } catch (err) { setError(err instanceof Error ? err.message : 'Agenda aanmaken mislukt.'); }
    finally { setLoading(false); }
  }

  async function renameNative(source: CalendarSource) {
    const name = prompt('Nieuwe naam voor deze agenda:', source.name);
    if (name === null) return;
    if (!name.trim()) { setError('Naam mag niet leeg zijn.'); return; }
    setError(null); setMessage(null);
    try {
      const upd = await updateNativeCalendar(organizationId, source.id, { name: name.trim() });
      setIntegrations(prev => ({ ...prev, sources: prev.sources.map(s => s.id === upd.id ? upd : s) }));
    } catch (err) { setError(err instanceof Error ? err.message : 'Hernoemen mislukt.'); }
  }

  async function removeNative(source: CalendarSource) {
    if (!confirm(`Agenda "${source.name}" en alle bijbehorende afspraken verwijderen?`)) return;
    setLoading(true); setError(null); setMessage(null);
    try {
      await deleteNativeCalendar(organizationId, source.id);
      setIntegrations(await loadCalendarIntegrations(organizationId));
      if (mode === 'agenda') await refreshEventsOnly();
      setMessage('Agenda verwijderd.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Verwijderen mislukt.'); }
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

  const nativeSources = integrations.sources.filter(s => s.provider === 'native');
  const nativeCalendarsSection = (
    <section className="calendar-section connections-panel" id="calendar-native">
      <div className="calendar-section-head">
        <div>
          <h3>ResoFly-agenda's</h3>
          <p>Eigen agenda's, zonder Google of Microsoft. Je kunt ze op je telefoon zetten via "Agenda op je telefoon".</p>
        </div>
      </div>
      {canWrite && (
        <form className="native-calendar-create" onSubmit={addNativeCalendar} style={{ display: 'flex', gap: 8, margin: '8px 0 12px', flexWrap: 'wrap' }}>
          <Input value={newCalendarName} onChange={e => setNewCalendarName(e.target.value)} placeholder="Naam, bijv. Kantoor of Monteurs" />
          <Button variant="primary" disabled={loading || !newCalendarName.trim()}><CalendarPlus size={14} /> Agenda toevoegen</Button>
        </form>
      )}
      {nativeSources.length === 0 ? (
        <div className="calendar-empty">Nog geen eigen agenda. Maak er een aan om afspraken in ResoFly bij te houden.</div>
      ) : (
        <div className="source-list">
          {nativeSources.map(src => {
            const owns = canManageSource(src);
            return (
              <div className="source-row privacy" key={src.id}>
                <span className="source-dot" style={{ background: src.color || '#2563eb' }} />
                <div className="source-info">
                  <strong>{src.name}</strong>
                  <span>{src.visibility === 'organization' ? 'Gedeeld met de organisatie' : 'Privé'}{owns ? '' : ' · van een teamlid'}</span>
                </div>
                {owns && (
                  <>
                    <label className="toggle-row"><input type="checkbox" checked={src.visibility === 'organization'} onChange={() => toggleSource(src, 'visibility')} /> Delen met team</label>
                    <Button onClick={() => renameNative(src)}><Pencil size={13} /> Hernoem</Button>
                    <Button variant="danger" onClick={() => removeNative(src)}><Trash2 size={13} /> Verwijder</Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );

  if (mode === 'settings') {
    return <div className="calendar-page calendar-settings-page">
      <section className="calendar-hero calendar-settings-hero" id="calendar-settings">
        <div>
          <h2>Agenda-instellingen</h2>
          <p>Maak eigen ResoFly-agenda's, of koppel Google Calendar en Microsoft Outlook. Agenda's blijven standaard privé en worden alleen gedeeld als je dat expliciet aanzet.</p>
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

      {nativeCalendarsSection}
      <PhoneCalendarCard organizationId={organizationId} />
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
          sourceColors={sourceColors} trackedMinutesFor={trackedMinutesFor} canWrite={canWrite} writeableSources={writeableSources} onSelectSlot={handleSlotSelect} onEditTask={onEditTask} onOpenEvent={setSelectedEvent} onMoveEvent={rescheduleEvent} />
      ) : view === 'month' ? (
        <CalendarMonthView days={days} anchor={anchor} events={events} tasks={data.tasks.filter(t => t.status !== 'done')} data={data}
          sourceColors={sourceColors} trackedMinutesFor={trackedMinutesFor} onEditTask={onEditTask} onOpenDay={openDay} onOpenEvent={setSelectedEvent} />
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
                  <span className="calendar-item-time">{formatTime(ev.starts_at, ev.all_day)}{!ev.all_day ? ` – ${formatTime(ev.ends_at)}` : ''}{ev.meeting_url ? <Video size={11} className="calendar-item-video" /> : null}</span><strong>{ev.title}</strong>
                  <small>{providerLabel(ev.provider)} · {ev.source_name}{ev.visibility === 'private' ? ' · privé' : ' · team'}{trackedMinutesFor(ev) != null ? ` · ⏱ ${formatMinutes(trackedMinutesFor(ev)!)}` : ''}{ev.meeting_url ? ' · videocall' : ''}</small>
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
        <label>Locatie<LocationField value={newEvent.location} onChange={next => setNewEvent(p => ({ ...p, location: next }))} placeholder="Zoek een adres of plaats…" /></label>
        <div className="settings-grid compact">
          <label>Start<Input type="datetime-local" value={newEvent.startsAt} onChange={e => setNewEvent(p => ({ ...p, startsAt: e.target.value }))} /></label>
          <label>Einde<Input type="datetime-local" value={newEvent.endsAt} onChange={e => setNewEvent(p => ({ ...p, endsAt: e.target.value }))} /></label>
        </div>
        <label>Omschrijving<Textarea value={newEvent.description} onChange={e => setNewEvent(p => ({ ...p, description: e.target.value }))} placeholder="Optioneel" /></label>
        <label className="check-row"><input type="checkbox" checked={newEvent.allDay} onChange={e => setNewEvent(p => ({ ...p, allDay: e.target.checked }))} /> Hele dag</label>
        <MeetingFields provider={integrations.sources.find(s => s.id === newEvent.sourceId)?.provider ?? null} meetingUrl={newEvent.meetingUrl} addConference={newEvent.addConference}
          onChange={patch => setNewEvent(p => ({ ...p, ...patch }))} />
        <div className="tb-panel-section-label">Koppelen aan</div>
        <ClientProjectPicker clients={data.clients} projects={data.projects} clientId={newEvent.clientId} projectId={newEvent.projectId}
          onChange={next => setNewEvent(p => ({ ...p, clientId: next.clientId, projectId: next.projectId }))} />
        {(newEvent.clientId || newEvent.projectId) && !newEvent.allDay && (
          <label className="check-row track-time-row">
            <input type="checkbox" checked={newEvent.trackTime} onChange={e => setNewEvent(p => ({ ...p, trackTime: e.target.checked }))} />
            <span><Clock size={13} /> Telt mee voor urenregistratie</span>
          </label>
        )}
        <Button variant="primary" disabled={loading || !canWrite || !writeableSources.length}>Event aanmaken</Button>
        {!writeableSources.length && <p className="calendar-help">Zet bij je eigen agenda eerst "Schrijven" aan.</p>}
      </form>
    )}

    {/* FAB for time-grid views */}
    {(view === 'day' || view === 'week') && canWrite && writeableSources.length > 0 && !showCreatePanel && (
      <button className="tb-fab" onClick={() => { const d = makeDefaultTimes(); setEditingOriginal(null); setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: d.startsAt, endsAt: d.endsAt, clientId: '', projectId: '', trackTime: true, recurrenceFreq: '', recurrenceUntil: '', editingEventId: '', attendees: [], meetingUrl: '', addConference: false })); setShowCreatePanel(true); }} title="Nieuwe afspraak aanmaken">
        <Plus size={22} />
      </button>
    )}

    {/* Floating panel */}
    {showCreatePanel && <EventCreationPanel newEvent={newEvent} setNewEvent={setNewEvent} writeableSources={writeableSources}
      clients={data.clients} projects={data.projects}
      selectedSourceIsNative={integrations.sources.find(s => s.id === newEvent.sourceId)?.provider === 'native'}
      selectedSourceProvider={integrations.sources.find(s => s.id === newEvent.sourceId)?.provider ?? null}
      loading={loading} canWrite={canWrite} onSubmit={submitNewEvent} onClose={() => { setShowCreatePanel(false); setEditingOriginal(null); }} />}

    <CalendarEventDetailPanel event={selectedEvent} organizationId={organizationId} data={data} sourceColors={sourceColors} canWrite={canWrite} editable={selectedEvent ? eventIsEditable(selectedEvent) : false} onNewNote={onNewNoteForEvent} onNewDocument={onNewDocumentForEvent} onSetEventLink={onSetEventLink} onLogTime={openLogTimeForEvent} onReschedule={rescheduleEvent} onEditNote={onEditNote} onLinkExistingNote={onLinkExistingNoteToEvent} onUnlinkNote={onUnlinkNoteFromEvent} onEditEvent={startEditEvent} onDeleteEvent={removeEvent} onClose={() => setSelectedEvent(null)} />

    {logTimeEvent && (() => {
      const link = data.calendarEventLinks.find(l => calendarEventLinkMatchesEvent(l, logTimeEvent)) ?? null;
      const minutes = logTimeEvent.all_day ? 60 : Math.max(0, Math.round((new Date(logTimeEvent.ends_at).getTime() - new Date(logTimeEvent.starts_at).getTime()) / 60000));
      const orgVisible = logTimeEvent.visibility === 'organization' && !logTimeEvent.is_private_masked;
      return (
        <TimeEntryModal
          organizationId={organizationId}
          data={data}
          entry={null}
          defaults={{
            projectId: link?.project_id ?? null,
            clientId: link?.client_id ?? null,
            date: dateKeyFromValue(logTimeEvent.starts_at),
            minutes: minutes > 0 ? minutes : 60,
            description: orgVisible ? logTimeEvent.title : '',
          }}
          onClose={() => setLogTimeEvent(null)}
          onSaved={onChanged}
        />
      );
    })()}
  </div>;
}
