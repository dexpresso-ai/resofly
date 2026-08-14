import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { CalendarDays, CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Columns3, ExternalLink, LayoutList, Mail, MapPin, Pencil, Plus, RefreshCcw, Repeat, Trash2, Unplug, UserPlus, Users, Video, X } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../components/Ui';
import { MeetingRecorder } from '../components/MeetingRecorder';
import { RichTextExcerpt } from '../components/RichTextEditor';
import { createNoteWithCalendarLink } from '../lib/repository';
import { addDays, DAY_NAMES_NL, formatISODate, isoWeekNumber, isSameDay, parseISODate, startOfWeek } from '../lib/dates';
import { dateNL, formatMinutes } from '../lib/format';
import { detectMeetingKind, isValidMeetingUrl } from '../lib/meeting';
import {
  createCalendarAppPassword,
  createExternalCalendarEvent,
  createIcsSubscription,
  createNativeCalendar,
  deleteCalendarEvent,
  deleteIcsSubscription,
  deleteNativeCalendar,
  disconnectCalendarConnection,
  refreshIcsSubscription,
  getCalendarEventAttendees,
  getCalendarOAuthUrl,
  getCachedCalendarEvents,
  invalidateCalendarEventsCache,
  listCalendarAppPasswords,
  listCalendarEventsCached,
  loadCalendarIntegrations,
  refreshCalendarSources,
  revokeCalendarAppPassword,
  searchCalendarContacts,
  updateCalendarEvent,
  updateCalendarSource,
  updateNativeCalendar,
  type CalendarEventRef,
  type CalendarIntegrationsPayload,
} from '../lib/calendar-api';
import { addBookingSlots, createBookingLink, listBookingLinks, listBookingSlotsInRange, sendBookingLinkMail } from '../lib/meetingBookingApi';
import { Modal } from '../components/Modal';
import { supabase } from '../lib/supabase';
import type { AttendeeStatus, CalendarAppPassword, CalendarEventAttendee, EventRecurrence, MeetingBookingLinkListItem, RecurrenceFrequency } from '../types';
import type { AppData, CalendarEventLink, CalendarExternalEvent, CalendarProvider, CalendarSource, CalendarVisibility, Client, Note, NoteCalendarLink, Project, Supplier, Task, UUID } from '../types';
import { getNoteTypeLabel } from './Notes';
import { TimeEntryModal } from './TimeTracking';

/* ── Constants & helpers ─────────────────────────────────────────────── */

const HOUR_START = 0;
const HOUR_END = 24;
const WORKDAY_START = 8;
const WORKDAY_END = 18;
const SLOT_MINUTES = 30;
/** Aantal dagkolommen in de "3 dagen"-weergave (Google-stijl, vooral voor mobiel). */
const THREE_DAY_COUNT = 3;
const TOTAL_SLOTS = (HOUR_END - HOUR_START) * (60 / SLOT_MINUTES);
const MIN_EVENT_HEIGHT_SLOTS = 0.85;
// De volledige dag (00:00-24:00) blijft scrollbaar zodat ook de vroege/late uren
// bereikbaar zijn. De rijhoogte schaalt zo dat de WERKDAG de zichtbare hoogte
// vult (schermvullende blokken); de grid scrollt voor de overige uren en opent
// automatisch op de werkdag-start.
// De clamp houdt de rijen compact (Google-dichtheid, ~44-56px per uur i.p.v. de
// oude ~100px per uur op grote schermen) zodat je in één oogopslag veel meer van
// de dag ziet.
const WORKDAY_SLOTS = (WORKDAY_END - WORKDAY_START) * (60 / SLOT_MINUTES);
// Ondergrens iets ruimer dan de oude 22px: een afspraak van een half uur beslaat
// precies één rij, en onder ~24px is er geen regel meer leesbaar te krijgen.
const MIN_ROW_HEIGHT = 24;
const MAX_ROW_HEIGHT = 30;
// Slepen & herschalen van agenda-items: de zichtbare dag beslaat DAY_MINUTES
// minuten; tijden worden op SNAP_MIN-rasters afgerond zodat slepen netjes "klikt".
const DAY_MINUTES = (HOUR_END - HOUR_START) * 60;
const SNAP_MIN = 15;
const MIN_EVENT_MINUTES = 15;

/* ── Zoomen (zoals Google Agenda op de telefoon) ────────────────────────────
   De autofit-rijhoogte hierboven is de 1×-stand: die vult de werkdag netjes.
   Knijpen (twee vingers), Ctrl/⌘ + wiel en +/− schalen daaromheen. De absolute
   px-grenzen houden een rij leesbaar (boven) en het rooster hanteerbaar
   (onder), ook op een klein of juist heel hoog scherm. */
const ZOOM_MIN = 0.55;
const ZOOM_MAX = 3.2;
/** Eén toetsaanslag (+/−) of één wielklik met Ctrl ingedrukt. */
const ZOOM_STEP = 1.18;
const ROW_PX_MIN = 12;
const ROW_PX_MAX = 132;
const ZOOM_STORAGE_KEY = 'resofly.agenda.zoom';

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** Halve pixels: vloeiend genoeg om mee te knijpen, scherp genoeg voor de lijnen. */
function zoomedRowHeight(baseRow: number, zoom: number): number {
  const px = baseRow * clampZoom(zoom);
  return Math.min(ROW_PX_MAX, Math.max(ROW_PX_MIN, Math.round(px * 2) / 2));
}

function readStoredZoom(): number {
  try { return clampZoom(Number(window.localStorage.getItem(ZOOM_STORAGE_KEY) ?? '1')); }
  catch { return 1; }
}

/** Systeemvoorkeur "minder beweging": dan schuiven we niets, maar wisselen direct. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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
  // "3 dagen" (zoals Google op de telefoon): de gekozen dag plus de twee erna.
  if (view === '3day') return Array.from({ length: THREE_DAY_COUNT }, (_, i) => addDays(startOfDay(anchor), i));
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

/** Weergaven met een tijdrooster (dagkolommen × uren): dag, 3 dagen en week. */
function isTimeGridView(view: CalendarView): boolean {
  return view === 'day' || view === '3day' || view === 'week';
}

function providerLabel(p: CalendarProvider): string { return p === 'google' ? 'Google' : p === 'microsoft' ? 'Microsoft' : p === 'ics' ? 'Via link' : 'ResoFly'; }
function providerClass(p: CalendarProvider): string { return p === 'google' ? 'provider-google' : p === 'microsoft' ? 'provider-microsoft' : p === 'ics' ? 'provider-ics' : 'provider-native'; }
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

// Relatieve helderheid (WCAG) van een hex-kleur. Gebruikt om op een vol gevuld
// blok automatisch een leesbare tekstkleur te kiezen: donkere tekst op een
// lichte vulling (bijv. merk-goud), witte tekst op een donkere vulling. Zo
// blijven de Google-stijl solide agenda-blokken altijd leesbaar.
function relativeLuminance(hex: string): number {
  const normalized = normalizeHexColor(hex).slice(1);
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const r = toLinear(parseInt(normalized.slice(0, 2), 16));
  const g = toLinear(parseInt(normalized.slice(2, 4), 16));
  const b = toLinear(parseInt(normalized.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function eventColorStyle(color?: string | null): CSSProperties {
  const c = normalizeHexColor(color);
  const lightFill = relativeLuminance(c) > 0.42;
  return {
    '--event-color': c,
    // Vol gevuld blok (Google-stijl): bijna dekkend i.p.v. doorschijnend.
    '--event-solid': hexToRgba(c, 0.96),
    // Subtiele tint voor weergaven die géén vol blok zijn (lijst, detailpaneel).
    '--event-bg': hexToRgba(c, 0.26),
    '--event-border': hexToRgba(c, 0.88),
    '--event-border-soft': hexToRgba(c, 0.55),
    // Randje voor definitie tussen aangrenzende blokken van dezelfde kleur.
    '--event-edge': lightFill ? 'rgba(0, 0, 0, 0.24)' : 'rgba(0, 0, 0, 0.16)',
    // Leesbare tekst op de vulling (donker op licht, wit op donker).
    '--event-text': lightFill ? '#1a1a1a' : '#ffffff',
    '--event-text-soft': lightFill ? 'rgba(26, 26, 26, 0.74)' : 'rgba(255, 255, 255, 0.86)',
    '--event-text-faint': lightFill ? 'rgba(26, 26, 26, 0.6)' : 'rgba(255, 255, 255, 0.72)',
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

export function slotToTime(slot: number): { hour: number; minutes: number } {
  const totalMin = HOUR_START * 60 + slot * SLOT_MINUTES;
  return { hour: Math.floor(totalMin / 60), minutes: totalMin % 60 };
}

/** Grid-selectie (dag + slot-indices) → ISO-tijdstippen. Voor hergebruik van TimeBlockGrid buiten CalendarPage. */
export function slotSelectionToIso(day: Date, startSlot: number, endSlot: number): { startsAt: string; endsAt: string } {
  const st = slotToTime(startSlot);
  const et = slotToTime(endSlot + 1);
  const sd = new Date(day); sd.setHours(st.hour, st.minutes, 0, 0);
  const ed = new Date(day); ed.setHours(et.hour, et.minutes, 0, 0);
  return { startsAt: sd.toISOString(), endsAt: ed.toISOString() };
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

type CalendarView = 'day' | '3day' | 'week' | 'month' | 'list';

interface DragState { dayIndex: number; startSlot: number; endSlot: number }

/* ── TimeBlockGrid ───────────────────────────────────────────────────── */

const MAX_OVERLAP_COLS = 2;
// Rechts in elke dagkolom blijft een smalle strook rooster vrij van
// afspraakblokken (zoals Google Calendar): daar kun je altijd klikken en
// slepen, ook op tijden die al bezet zijn, zodat je een overlappende afspraak
// kunt aanmaken zonder dat het bestaande blok de muis afvangt.
// De breedte staat als `--tb-strip` in de CSS, zodat smalle telefoonkolommen
// hem kunnen verkleinen; deze waarde is de terugval als die ontbreekt.
const EVENT_CLICK_STRIP = 'var(--tb-strip, 12px)';
// Afspraken die (bijna) een hele dag vullen (bv. "op locatie", langdurige blokkade)
// tellen niet mee in de kolomverdeling: ze krijgen altijd de volle breedte als
// achtergrondlaag, zodat kortere afspraken die ermee overlappen nooit worden
// weggedrukt of verborgen — die renderen er altijd bovenop.
const BACKGROUND_EVENT_MIN_MINUTES = 6 * 60;

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
  isBackground: boolean;
};

type OverflowChip = { top: number; count: number };

/* ── Hele-dag-rij: doorlopende balken over meerdere dagen (Google-stijl) ──
   Hele-dag-afspraken én getimede afspraken van ≥24 uur worden als één balk
   over de betreffende dagkolommen getekend (met de starttijd in het label,
   zoals Google "Optie, 15:30"). Kortere afspraken die over middernacht heen
   lopen blijven geknipt in het tijdrooster staan. */
const MULTI_DAY_TIMED_MS = 24 * 60 * 60 * 1000;

function isAllDayBarEvent(ev: CalendarExternalEvent): boolean {
  if (ev.all_day) return true;
  return new Date(ev.ends_at).getTime() - new Date(ev.starts_at).getTime() >= MULTI_DAY_TIMED_MS;
}

type AllDayBar = {
  key: string;
  kind: 'event' | 'task';
  event?: CalendarExternalEvent;
  task?: Task;
  startIdx: number;
  span: number;
  continuesLeft: boolean;
  continuesRight: boolean;
  lane: number;
  timeLabel: string | null;
};

function layoutAllDayBars(days: Date[], events: CalendarExternalEvent[], tasks: Task[]): { bars: AllDayBar[]; laneCount: number } {
  const dayKeys = days.map(formatISODate);
  const firstKey = dayKeys[0];
  const lastKeyExclusive = addDateKeyDays(dayKeys[dayKeys.length - 1], 1);
  const bars: AllDayBar[] = [];
  for (const ev of events) {
    if (!isAllDayBarEvent(ev)) continue;
    let startKey: string;
    let endKeyExclusive: string;
    let timeLabel: string | null = null;
    if (ev.all_day) {
      startKey = allDayStartDateKey(ev);
      endKeyExclusive = allDayEndDateKeyExclusive(ev);
    } else {
      // Getimede meerdaagse: lokale kalenderdagen; einde-min-1ms zodat een
      // einde om exact middernacht geen extra dag oplevert.
      startKey = formatISODate(new Date(ev.starts_at));
      endKeyExclusive = addDateKeyDays(formatISODate(new Date(new Date(ev.ends_at).getTime() - 1)), 1);
      timeLabel = formatTime(ev.starts_at);
    }
    if (endKeyExclusive <= firstKey || startKey >= lastKeyExclusive) continue;
    const clampedStart = startKey < firstKey ? firstKey : startKey;
    const clampedLastDay = addDateKeyDays(endKeyExclusive > lastKeyExclusive ? lastKeyExclusive : endKeyExclusive, -1);
    const startIdx = dayKeys.indexOf(clampedStart);
    const endIdx = dayKeys.indexOf(clampedLastDay);
    if (startIdx < 0 || endIdx < 0) continue;
    bars.push({
      key: `ev-${eventIdentityKey(ev)}`, kind: 'event', event: ev,
      startIdx, span: endIdx - startIdx + 1,
      continuesLeft: startKey < firstKey, continuesRight: endKeyExclusive > lastKeyExclusive,
      lane: 0, timeLabel,
    });
  }
  for (const task of tasks) {
    if (!task.end_date) continue;
    const idx = dayKeys.indexOf(dateKeyFromValue(task.end_date));
    if (idx < 0) continue;
    bars.push({ key: `task-${task.id}`, kind: 'task', task, startIdx: idx, span: 1, continuesLeft: false, continuesRight: false, lane: 0, timeLabel: null });
  }
  // Lange balken eerst per startdag (Google): die claimen de bovenste lanes,
  // de rest vult de gaten eronder op.
  bars.sort((a, b) => a.startIdx - b.startIdx || b.span - a.span || (a.kind === 'task' ? 1 : 0) - (b.kind === 'task' ? 1 : 0));
  const laneEnds: number[] = [];
  for (const bar of bars) {
    let lane = laneEnds.findIndex(end => end <= bar.startIdx);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    bar.lane = lane;
    laneEnds[lane] = bar.startIdx + bar.span;
  }
  return { bars, laneCount: laneEnds.length };
}

function layoutTimedEventsForDay(
  day: Date,
  events: CalendarExternalEvent[],
): { segments: TimedEventSegment[]; overflows: OverflowChip[] } {
  const { start: visibleStartBound, end: visibleEndBound } = visibleTimeBounds(day);
  const minutesInWindow = (HOUR_END - HOUR_START) * 60;
  const raw = events
    // ≥24-uurs getimede afspraken staan als balk in de hele-dag-rij (Google-stijl),
    // dus niet nogmaals in het tijdrooster.
    .filter(ev => eventOverlapsVisibleWindow(ev, day) && !isAllDayBarEvent(ev))
    .map(ev => {
      const eventStart = new Date(ev.starts_at);
      const eventEnd = new Date(ev.ends_at);
      const visibleStart = new Date(Math.max(eventStart.getTime(), visibleStartBound.getTime()));
      const visibleEnd = new Date(Math.min(eventEnd.getTime(), visibleEndBound.getTime()));
      const startMinute = Math.max(0, Math.round((visibleStart.getTime() - visibleStartBound.getTime()) / 60000));
      const endMinute = Math.max(startMinute + 15, Math.min(minutesInWindow, Math.round((visibleEnd.getTime() - visibleStartBound.getTime()) / 60000)));
      const top = dateToVisibleDayFraction(day, visibleStart) * 100;
      const height = Math.max(dateToVisibleDayFraction(day, visibleEnd) * 100 - top, (100 / TOTAL_SLOTS) * MIN_EVENT_HEIGHT_SLOTS);
      const isBackground = endMinute - startMinute >= BACKGROUND_EVENT_MIN_MINUTES;
      return { event: ev, startMinute, endMinute, top, height, column: 0, columns: 1, startsBeforeDay: eventStart < visibleStartBound, endsAfterDay: eventEnd > visibleEndBound, isBackground };
    })
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);

  // Dagvullende afspraken vormen hun eigen achtergrondlaag: volle breedte, geen
  // kolom, en dus geen concurrentie met kortere afspraken om zichtbare ruimte.
  const backgroundSegments = raw.filter(s => s.isBackground);
  const foreground = raw.filter(s => !s.isBackground);

  const clusters: TimedEventSegment[][] = [];
  let current: TimedEventSegment[] = [];
  let currentEnd = -1;

  foreground.forEach(segment => {
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

  return { segments: [...backgroundSegments, ...foreground.filter(s => s.column < MAX_OVERLAP_COLS)], overflows };
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
  /** Touch-gebaren tellen meteen als "verplaatst": de lange druk ís al de bevestiging. */
  touch: boolean;
}

// Pas slepen pas toe nadat de cursor merkbaar bewogen is; zo opent een gewone
// klik (met minieme trilling) gewoon het item i.p.v. het ongewild te verzetten.
const DRAG_THRESHOLD_PX = 4;
// Touch: vegen moet gewoon blijven scrollen, dus pakken we een sleep pas op
// nadat de vinger ~⅓ seconde stil ligt (zelfde gebaar als in Google Agenda).
const TOUCH_HOLD_MS = 320;
// Beweegt de vinger tijdens dat wachten meer dan dit, dan was het een veeg.
const TOUCH_HOLD_TOLERANCE_PX = 10;
// Sleep je tegen de boven-/onderrand van het rooster, dan scrollt het mee.
const EDGE_SCROLL_ZONE_PX = 68;
const EDGE_SCROLL_MAX_PX = 16;

/** Korte trilling als een sleep- of selectiegebaar "pakt" (waar ondersteund). */
function hapticTick() {
  try { navigator.vibrate?.(12); } catch { /* niet ondersteund — puur cosmetisch */ }
}

function eventIdentityKey(ev: CalendarExternalEvent): string {
  return `${ev.provider}|${ev.source_id}|${ev.provider_event_id}|${ev.starts_at}`;
}

/** Lichte vorm voor de beschikbaarheid-overlay; concept-blokken (nog niet opgeslagen) hebben hun starttijd als id.
 *  `removable` = een verwijderbaar blok (concept/eigen link); anders alleen-lezen (aangeboden optie). */
export type BookingOverlaySlot = { id: string; starts_at: string; ends_at: string; status: string; removable?: boolean };

export function TimeBlockGrid({ days, events, tasks, sourceColors, trackedMinutesFor, canWrite, writeableSources, onSelectSlot, onEditTask, onOpenEvent, onMoveEvent, onOpenDay, bookingMode = false, bookingSlots = [], onRemoveBookingSlot, readOnlyEvents = false, zoom = 1, onZoomChange, autoScrollKey = 0 }: {
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
  /** Maakt de dagkoppen klikbaar (Google): klik op een dag opent de dagweergave. */
  onOpenDay?: (day: Date) => void;
  /** Beschikbaarheid-modus voor de boekingstool: sleep-selectie maakt blokken, en de bestaande/concept-blokken worden als aparte laag getoond. */
  bookingMode?: boolean;
  bookingSlots?: BookingOverlaySlot[];
  onRemoveBookingSlot?: (slotId: string) => void;
  /** Toon agenda-items alleen als context (niet versleepbaar) — voor hergebruik in de Boekingslinks-pagina. */
  readOnlyEvents?: boolean;
  /** Zoomfactor rond de autofit-rijhoogte. Knijpen/Ctrl+wiel melden een nieuwe waarde via `onZoomChange`. */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** Bump deze waarde om het rooster opnieuw naar "nu" (of de werkdagstart) te scrollen.
   *  Bladeren naar een andere week doet dat bewust NIET: je blijft op dezelfde hoogte staan. */
  autoScrollKey?: number;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Loopt de tijdselectie via een vinger? Dan houden we de pagina stil.
  const [touchSelecting, setTouchSelecting] = useState(false);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  // Hele-dag-rij: standaard alles tonen (zoals Google); inklapbaar bij 3+ lanes.
  const [allDayExpanded, setAllDayExpanded] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const canSelect = canWrite && writeableSources.length > 0;
  const daysKey = days.map(formatISODate).join('|');
  // Tijdens een sleep lopen de luisteraars op `window`. Die lezen `days` en de
  // callbacks via refs, zodat de effecten niet bij élke render (dus bij elke
  // muisbeweging) opnieuw aan- en afgekoppeld worden.
  const daysRef = useRef(days);
  daysRef.current = days;
  const onSelectSlotRef = useRef(onSelectSlot);
  onSelectSlotRef.current = onSelectSlot;
  const onMoveEventRef = useRef(onMoveEvent);
  onMoveEventRef.current = onMoveEvent;

  // Slepen/herschalen van bestaande native afspraken.
  const [interaction, setInteraction] = useState<EventInteraction | null>(null);
  const interactionRef = useRef<EventInteraction | null>(null);
  const draggedRef = useRef(false);
  // Lopende tijdselectie (zie "Tijd selecteren door te slepen" verderop). Staat
  // hier omdat het knijp-gebaar een half begonnen selectie moet kunnen afbreken.
  const dragRef = useRef<DragState | null>(null);

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

  // ── Lange druk op touch ────────────────────────────────────────────────
  // Zolang we wachten annuleert elke noemenswaardige beweging de druk, zodat
  // een veeg over een afspraak gewoon het rooster scrollt i.p.v. te verslepen.
  // `cancelHold` ruimt de lopende druk volledig op (timer én luisteraars); met
  // alleen de timer wissen zou een tweede vinger de eerste kunnen slopen.
  const holdCancelRef = useRef<(() => void) | null>(null);
  const cancelHold = useCallback(() => { holdCancelRef.current?.(); }, []);
  const startHold = useCallback((x: number, y: number, arm: () => void) => {
    cancelHold();
    let timer = 0;
    function detach() {
      window.clearTimeout(timer);
      if (holdCancelRef.current === detach) holdCancelRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', detach);
      window.removeEventListener('pointercancel', detach);
    }
    function onMove(ev: PointerEvent) {
      if (Math.hypot(ev.clientX - x, ev.clientY - y) > TOUCH_HOLD_TOLERANCE_PX) detach();
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', detach);
    window.addEventListener('pointercancel', detach);
    timer = window.setTimeout(() => { detach(); hapticTick(); arm(); }, TOUCH_HOLD_MS);
    holdCancelRef.current = detach;
  }, [cancelHold]);
  useEffect(() => cancelHold, [cancelHold]);

  // ── Meescrollen bij de randen ──────────────────────────────────────────
  const autoScrollDyRef = useRef(0);
  const autoScrollRafRef = useRef<number | null>(null);
  const stopAutoScroll = useCallback(() => {
    autoScrollDyRef.current = 0;
    if (autoScrollRafRef.current != null) { cancelAnimationFrame(autoScrollRafRef.current); autoScrollRafRef.current = null; }
  }, []);
  const autoScrollFor = useCallback((clientY: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const topGap = clientY - r.top;
    const bottomGap = r.bottom - clientY;
    let dy = 0;
    if (topGap < EDGE_SCROLL_ZONE_PX) dy = -EDGE_SCROLL_MAX_PX * Math.min(1, (EDGE_SCROLL_ZONE_PX - topGap) / EDGE_SCROLL_ZONE_PX);
    else if (bottomGap < EDGE_SCROLL_ZONE_PX) dy = EDGE_SCROLL_MAX_PX * Math.min(1, (EDGE_SCROLL_ZONE_PX - bottomGap) / EDGE_SCROLL_ZONE_PX);
    autoScrollDyRef.current = dy;
    if (dy !== 0 && autoScrollRafRef.current == null) {
      const step = () => {
        const sc = scrollRef.current;
        const d = autoScrollDyRef.current;
        if (!sc || d === 0) { autoScrollRafRef.current = null; return; }
        sc.scrollTop += d;
        autoScrollRafRef.current = requestAnimationFrame(step);
      };
      autoScrollRafRef.current = requestAnimationFrame(step);
    }
  }, []);
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const armEventInteraction = useCallback((clientX: number, clientY: number, ev: CalendarExternalEvent, dayIndex: number, mode: EventInteractionMode, touch: boolean) => {
    const dayStart = startOfDay(days[dayIndex]).getTime();
    const startMin = (new Date(ev.starts_at).getTime() - dayStart) / 60000;
    const endMin = (new Date(ev.ends_at).getTime() - dayStart) / 60000;
    if (startMin < 0 || endMin > DAY_MINUTES) return; // meerdaagse blokken: niet slepen
    const hit = pointerToCol(clientX, clientY);
    const grabOffsetMin = hit ? hit.minutes - startMin : 0;
    const next: EventInteraction = {
      mode, event: ev, originDayIndex: dayIndex,
      originStartMin: startMin, originEndMin: endMin, grabOffsetMin,
      pointerStartX: clientX, pointerStartY: clientY,
      preview: { dayIndex, startMin, endMin }, moved: false, touch,
    };
    interactionRef.current = next;
    setInteraction(next);
  }, [days, pointerToCol]);

  const beginEventInteraction = useCallback((e: React.PointerEvent, ev: CalendarExternalEvent, dayIndex: number, mode: EventInteractionMode) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!canDragEvent(ev)) return;
    if (interactionRef.current || dragRef.current) return; // tweede vinger negeren
    e.stopPropagation(); // nooit ook nog een tijdselectie eronder starten
    if (e.pointerType === 'mouse') {
      e.preventDefault();
      armEventInteraction(e.clientX, e.clientY, ev, dayIndex, mode, false);
      return;
    }
    // Touch/pen: pas oppakken na een lange druk. Tot dan blijft scrollen werken
    // en opent een gewone tik het item nog steeds.
    const { clientX, clientY } = e;
    startHold(clientX, clientY, () => armEventInteraction(clientX, clientY, ev, dayIndex, mode, true));
  }, [canDragEvent, armEventInteraction, startHold]);

  // Pointermove/-up wereldwijd volgen zolang er een interactie loopt.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!interaction) return;
    const snap = (m: number) => Math.round(m / SNAP_MIN) * SNAP_MIN;
    function applyPointer(clientX: number, clientY: number) {
      const it = interactionRef.current;
      if (!it) return;
      // Pas reageren zodra de cursor merkbaar bewogen is (anders blijft het een
      // klik). Bij touch is de lange druk zelf al de bevestiging.
      if (!it.moved && !it.touch && Math.hypot(clientX - it.pointerStartX, clientY - it.pointerStartY) <= DRAG_THRESHOLD_PX) return;
      const hit = pointerToCol(clientX, clientY);
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
      if (it.moved && preview.dayIndex === it.preview.dayIndex && preview.startMin === it.preview.startMin && preview.endMin === it.preview.endMin) return;
      const updated: EventInteraction = { ...it, preview, moved: true };
      interactionRef.current = updated;
      setInteraction(updated);
    }
    function onMove(e: PointerEvent) {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      // Sleep je tegen de rand, dan scrollt het rooster mee; de rAF-lus hieronder
      // houdt het voorbeeld bijwerken terwijl het rooster onder de vinger schuift.
      autoScrollFor(e.clientY);
      applyPointer(e.clientX, e.clientY);
    }
    // Herbereken het voorbeeld ook tijdens het randscrollen (vinger staat stil).
    let raf = requestAnimationFrame(function tick() {
      const p = lastPointerRef.current;
      if (p && autoScrollDyRef.current !== 0) applyPointer(p.x, p.y);
      raf = requestAnimationFrame(tick);
    });
    function onUp() {
      const it = interactionRef.current;
      interactionRef.current = null;
      lastPointerRef.current = null;
      stopAutoScroll();
      setInteraction(null);
      if (!it) return;
      // Na een touch-oppak nooit meteen het detailpaneel openen: de lange druk
      // was een sleepgebaar, geen tik.
      if (it.moved || it.touch) {
        draggedRef.current = true; // onderdruk de klik die direct na het slepen volgt
        window.setTimeout(() => { draggedRef.current = false; }, 0);
      }
      if (!it.moved) return; // gewone klik → laat onClick het item openen
      const pv = it.preview;
      const changed = pv.dayIndex !== it.originDayIndex || pv.startMin !== it.originStartMin || pv.endMin !== it.originEndMin;
      if (!changed) return; // teruggesleept naar de oorspronkelijke plek: niets opslaan
      const shown = daysRef.current;
      const day = shown[pv.dayIndex] ?? shown[it.originDayIndex];
      if (!day) return;
      const base = startOfDay(day).getTime();
      const startIso = new Date(base + pv.startMin * 60000).toISOString();
      const endIso = new Date(base + pv.endMin * 60000).toISOString();
      void onMoveEventRef.current(it.event, startIso, endIso);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      cancelAnimationFrame(raf);
      stopAutoScroll();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [interaction !== null, daysKey, pointerToCol, autoScrollFor, stopAutoScroll]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ── Zoomen: knijpen, Ctrl/⌘ + wiel ─────────────────────────────────────
  // `rowHeight` is de 1×-stand (autofit); de zoomfactor schaalt daaromheen.
  const effectiveRow = rowHeight != null ? zoomedRowHeight(rowHeight, zoom) : null;
  const rowHeightRef = useRef<number | null>(null);
  rowHeightRef.current = rowHeight;
  // De prop is leidend zodra die écht verandert. Tussendoor rekenen we door op
  // onze eigen laatste waarde: een trackpad vuurt meerdere wielstappen af binnen
  // één render, en die zouden anders allemaal vanaf dezelfde beginstand rekenen
  // (zoomen voelt dan traag en hakkelig).
  const zoomRef = useRef(zoom);
  const zoomPropRef = useRef(zoom);
  if (zoomPropRef.current !== zoom) { zoomPropRef.current = zoom; zoomRef.current = zoom; }
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;

  /** Waar het rooster begint binnen de scroller (dagkoppen + hele-dag-balk). */
  const gridOffsetTop = useCallback(() => scrollRef.current?.querySelector<HTMLElement>('.tb-grid')?.offsetTop ?? 0, []);
  /** Welk tijdstip (in rij-eenheden) staat er op `viewportY` binnen de scroller? */
  const rowsAt = useCallback((viewportY: number, row: number): number => {
    const el = scrollRef.current;
    if (!el || row <= 0) return 0;
    return (el.scrollTop + viewportY - gridOffsetTop()) / row;
  }, [gridOffsetTop]);
  /** Het punt dat onder de vingers/cursor stil moet blijven staan bij het zoomen.
   *  `scrollTop` dient om te zien of het anker nog vers is (zie `holdZoomAnchor`). */
  const zoomAnchorRef = useRef<{ rows: number; viewportY: number; scrollTop: number } | null>(null);
  /** Houdt hetzelfde anker vast zolang een zoomreeks op dezelfde plek doorloopt. */
  const holdZoomAnchor = useCallback((viewportY: number, row: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const current = zoomAnchorRef.current;
    if (current && Math.abs(current.viewportY - viewportY) <= 4 && current.scrollTop === el.scrollTop) return;
    zoomAnchorRef.current = { rows: rowsAt(viewportY, row), viewportY, scrollTop: el.scrollTop };
  }, [rowsAt]);

  // Na een zoomstap staat hetzelfde tijdstip weer onder de vingers (of, zonder
  // aangewezen punt, in het midden van het scherm) — anders spring je bij elke
  // stap naar een ander deel van de dag.
  const prevRowRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevRowRef.current;
    prevRowRef.current = effectiveRow;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    if (!el || effectiveRow == null || prev == null || prev === effectiveRow) return;
    const top = gridOffsetTop();
    const viewportY = anchor?.viewportY ?? el.clientHeight / 2;
    const rows = anchor?.rows ?? (el.scrollTop + viewportY - top) / prev;
    const behavior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = Math.max(0, Math.round(top + rows * effectiveRow - viewportY));
    el.style.scrollBehavior = behavior;
  }, [effectiveRow, gridOffsetTop]);

  useEffect(() => {
    const el = scrollRef.current;
    const container = containerRef.current;
    if (!el || !container || !onZoomChange) return;

    // Ctrl/⌘ + wiel = zoomen (de universele afspraak op het bureaublad).
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      const base = rowHeightRef.current;
      if (base == null) return;
      e.preventDefault();
      const scroller = scrollRef.current!;
      const viewportY = e.clientY - scroller.getBoundingClientRect().top;
      holdZoomAnchor(viewportY, zoomedRowHeight(base, zoomRef.current));
      const next = clampZoom(zoomRef.current * Math.exp(-e.deltaY * 0.0016));
      zoomRef.current = next;
      onZoomChangeRef.current?.(next);
    }

    // Knijpen met twee vingers (Google Agenda op de telefoon). Tijdens het
    // gebaar schrijven we `--tb-h` rechtstreeks weg: dat loopt op 60fps mee
    // zonder per beweging een hele render te doen. Bij loslaten leggen we de
    // eindstand één keer in de state vast.
    let pinch: { distance: number; zoom: number; rows: number; viewportY: number; last: number } | null = null;
    const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 2) return;
      const base = rowHeightRef.current;
      if (base == null) return;
      // Een tweede vinger betekent knijpen, geen selectie of sleep meer.
      cancelHold();
      dragRef.current = null;
      setDrag(null); setIsDragging(false); setTouchSelecting(false);
      interactionRef.current = null; setInteraction(null);
      const scroller = scrollRef.current!;
      const viewportY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - scroller.getBoundingClientRect().top;
      const row = zoomedRowHeight(base, zoomRef.current);
      pinch = { distance: Math.max(1, spread(e.touches)), zoom: zoomRef.current, rows: rowsAt(viewportY, row), viewportY, last: zoomRef.current };
      scroller.style.scrollBehavior = 'auto';
      container?.classList.add('tb-pinching');
    }

    function onTouchMove(e: TouchEvent) {
      if (!pinch || e.touches.length !== 2) return;
      const base = rowHeightRef.current;
      if (base == null) return;
      if (e.cancelable) e.preventDefault();
      const next = clampZoom(pinch.zoom * (spread(e.touches) / pinch.distance));
      const row = zoomedRowHeight(base, next);
      pinch.last = next;
      container!.style.setProperty('--tb-h', `${row}px`);
      const scroller = scrollRef.current!;
      scroller.scrollTop = Math.max(0, Math.round(gridOffsetTop() + pinch.rows * row - pinch.viewportY));
    }

    function endPinch() {
      if (!pinch) return;
      const { last, rows, viewportY } = pinch;
      pinch = null;
      const scroller = scrollRef.current;
      if (scroller) scroller.style.scrollBehavior = '';
      container?.classList.remove('tb-pinching');
      // De scrollpositie staat al goed; het anker voorkomt dat de layout-effect
      // hierboven hem alsnog naar het schermmidden trekt.
      zoomAnchorRef.current = { rows, viewportY, scrollTop: scroller?.scrollTop ?? 0 };
      zoomRef.current = last;
      onZoomChangeRef.current?.(last);
    }

    function onTouchEnd(e: TouchEvent) { if (pinch && e.touches.length < 2) endPinch(); }

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      container?.classList.remove('tb-pinching');
    };
  }, [onZoomChange, cancelHold, rowsAt, gridOffsetTop, holdZoomAnchor]);

  // Naar "nu" scrollen doen we bij het openen en bij het wisselen van weergave —
  // en op verzoek van de pagina (knop "Vandaag") via `autoScrollKey`. Bewust NIET
  // bij het bladeren naar een andere week: daar blijf je op dezelfde hoogte staan,
  // zodat het bladeren als één doorlopende beweging voelt (net als Google).
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const firstSlot = scrollEl.querySelector<HTMLElement>('.tb-time-label');
    const grid = scrollEl.querySelector<HTMLElement>('.tb-grid');
    const slotHeight = firstSlot?.getBoundingClientRect().height ?? 24;
    const gridOffsetTop = grid?.offsetTop ?? 0;
    // Google-gedrag: staat vandaag in beeld, open dan met de "nu"-lijn op ±30%
    // van de hoogte; anders op het begin van de werkdag.
    const nowDate = new Date();
    let target: number;
    if (days.some(d => isSameDay(d, nowDate))) {
      const nowFraction = (nowDate.getHours() * 60 + nowDate.getMinutes()) / DAY_MINUTES;
      target = gridOffsetTop + nowFraction * slotHeight * TOTAL_SLOTS - scrollEl.clientHeight * 0.3;
    } else {
      const workdayStartSlot = ((WORKDAY_START - HOUR_START) * 60) / SLOT_MINUTES;
      target = gridOffsetTop + workdayStartSlot * slotHeight - 2;
    }
    // Instant (niet smooth): de agenda opent direct op de juiste positie; de
    // CSS `scroll-behavior:smooth` op de scroller zou de sprong anders annuleren.
    scrollEl.scrollTo({ top: Math.max(0, Math.round(target)), behavior: 'instant' });
  }, [days.length, autoScrollKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tijd selecteren door te slepen (muis, pen én vinger) ───────────────
  // Eén pointer-gebaar voor alle invoerapparaten. Op de muis begint de selectie
  // meteen; op touch maakt een korte tik een standaardblok en selecteert
  // ingedrukt-houden-en-slepen een eigen tijdvak (zoals Google Agenda).
  const slotFromClientY = useCallback((dayIndex: number, clientY: number): number | null => {
    const el = colRefs.current[dayIndex];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) return null;
    const frac = Math.min(0.999999, Math.max(0, (clientY - r.top) / r.height));
    return Math.floor(frac * TOTAL_SLOTS);
  }, []);

  const armSelection = useCallback((dayIndex: number, clientY: number, touch: boolean) => {
    const slot = slotFromClientY(dayIndex, clientY);
    if (slot == null) return;
    const next: DragState = { dayIndex, startSlot: slot, endSlot: slot };
    dragRef.current = next;
    setDrag(next);
    setIsDragging(true);
    setTouchSelecting(touch);
  }, [slotFromClientY]);

  const beginSelection = useCallback((e: React.PointerEvent, dayIndex: number) => {
    if (!canSelect) return;
    if (interactionRef.current || dragRef.current) return; // niet selecteren tijdens een sleep
    // Op een bestaand item, boekingsblok of "+N"-chip nooit een selectie starten.
    if ((e.target as HTMLElement).closest('.tb-ev,.tb-booking-slot,.tb-overflow-chip')) return;
    const { clientX, clientY } = e;
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      e.preventDefault();
      armSelection(dayIndex, clientY, false);
      return;
    }
    // Touch/pen: onderscheid tik (standaardblok) van lange druk (eigen tijdvak).
    let isTap = true;
    function cleanup() {
      window.removeEventListener('pointermove', onTapMove);
      window.removeEventListener('pointerup', onTapUp);
      window.removeEventListener('pointercancel', cleanup);
    }
    function onTapMove(ev: PointerEvent) {
      if (Math.hypot(ev.clientX - clientX, ev.clientY - clientY) > TOUCH_HOLD_TOLERANCE_PX) { isTap = false; cleanup(); }
    }
    function onTapUp() {
      cleanup();
      if (!isTap || dragRef.current) return; // de lange druk heeft het overgenomen
      const slot = slotFromClientY(dayIndex, clientY);
      const day = daysRef.current[dayIndex];
      if (slot != null && day) onSelectSlotRef.current(day, slot, slot);
    }
    window.addEventListener('pointermove', onTapMove);
    window.addEventListener('pointerup', onTapUp);
    window.addEventListener('pointercancel', cleanup);
    startHold(clientX, clientY, () => { isTap = false; cleanup(); armSelection(dayIndex, clientY, true); });
  }, [canSelect, armSelection, startHold, slotFromClientY]);

  useEffect(() => {
    if (!isDragging) return;
    function apply(clientY: number) {
      const cur = dragRef.current;
      if (!cur) return;
      const slot = slotFromClientY(cur.dayIndex, clientY);
      if (slot == null || slot === cur.endSlot) return;
      const next: DragState = { ...cur, endSlot: slot };
      dragRef.current = next;
      setDrag(next);
    }
    function onMove(e: PointerEvent) {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      autoScrollFor(e.clientY);
      apply(e.clientY);
    }
    let raf = requestAnimationFrame(function tick() {
      const p = lastPointerRef.current;
      if (p && autoScrollDyRef.current !== 0) apply(p.y);
      raf = requestAnimationFrame(tick);
    });
    function onUp() {
      const cur = dragRef.current;
      dragRef.current = null;
      lastPointerRef.current = null;
      stopAutoScroll();
      setIsDragging(false);
      setDrag(null);
      setTouchSelecting(false);
      if (!cur) return;
      const day = daysRef.current[cur.dayIndex];
      if (!day) return;
      onSelectSlotRef.current(day, Math.min(cur.startSlot, cur.endSlot), Math.max(cur.startSlot, cur.endSlot));
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      cancelAnimationFrame(raf);
      stopAutoScroll();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [isDragging, daysKey, slotFromClientY, autoScrollFor, stopAutoScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zolang een touch-gebaar loopt mag de pagina niet meescrollen — anders
  // schuift het rooster onder je vinger vandaan tijdens het slepen.
  const blockPageScroll = touchSelecting || interaction?.touch === true;
  useEffect(() => {
    if (!blockPageScroll) return;
    const block = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    window.addEventListener('touchmove', block, { passive: false });
    return () => window.removeEventListener('touchmove', block);
  }, [blockPageScroll]);

  const hourLabels: { hour: number; minutes: number; label: string }[] = [];
  for (let s = 0; s < TOTAL_SLOTS; s++) {
    const t = slotToTime(s);
    hourLabels.push({ ...t, label: formatHour(t.hour, t.minutes) });
  }

  function eventColor(ev: CalendarExternalEvent): string { return sourceColors.get(ev.source_id) ?? '#FFD966'; }

  // Hele-dag-rij als doorlopende balken (Google): lanes over de dagkolommen heen.
  const { bars: allDayBars, laneCount: allDayLaneCount } = useMemo(
    () => layoutAllDayBars(days, events, tasks),
    [daysKey, events, tasks], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const ALLDAY_COLLAPSED_LANES = 2;
  const allDayCollapsible = allDayLaneCount > ALLDAY_COLLAPSED_LANES;
  const allDayShowAll = allDayExpanded || !allDayCollapsible;
  const visibleAllDayBars = allDayShowAll ? allDayBars : allDayBars.filter(b => b.lane < ALLDAY_COLLAPSED_LANES);
  // Bij ingeklapte rij: per dag hoeveel balken verborgen zijn ("+N").
  const hiddenAllDayCounts = allDayShowAll ? [] : days.map((_, di) =>
    allDayBars.filter(b => b.lane >= ALLDAY_COLLAPSED_LANES && di >= b.startIdx && di < b.startIdx + b.span).length);

  // Tijdzone-label in de hoek van de tijdgoot, zoals Google ("GMT+2").
  const tzOffsetMin = -new Date().getTimezoneOffset();
  const gmtLabel = `GMT${tzOffsetMin >= 0 ? '+' : '-'}${Math.floor(Math.abs(tzOffsetMin) / 60)}`;

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
    ...(effectiveRow ? { '--tb-h': `${effectiveRow}px` } : {}),
  } as CSSProperties;
  const workdayOverlayStyle = {
    top: `${(((WORKDAY_START - HOUR_START) * 60) / ((HOUR_END - HOUR_START) * 60)) * 100}%`,
    height: `${(((WORKDAY_END - WORKDAY_START) * 60) / ((HOUR_END - HOUR_START) * 60)) * 100}%`,
  } as CSSProperties;

  return (
    <div ref={containerRef} className={`tb-container${days.length === 1 ? ' tb-single-day' : ''}${days.length <= THREE_DAY_COUNT ? ' tb-few-days' : ''}${isDragging || interaction ? ' tb-gesturing' : ''}${blockPageScroll ? ' tb-touch-gesture' : ''}`} style={gridStyle}>
      <div className="tb-scroll" ref={scrollRef}>
        <div className="tb-canvas">
          <div className="tb-day-headers">
            <div className="tb-gutter tb-sticky-gutter tb-corner"><span className="tb-gmt">{gmtLabel}</span></div>
            {days.map(day => {
              const td = today(day);
              const inner = <>
                <span className="tb-dh-name">{dayNameNl(day)}</span>
                <span className={`tb-dh-num${td ? ' tb-today-num' : ''}`}>{day.getDate()}</span>
              </>;
              return <div className={`tb-dh${td ? ' tb-today' : ''}`} key={formatISODate(day)}>
                {onOpenDay
                  ? <button type="button" className="tb-dh-hit" onClick={() => onOpenDay(day)} title="Open dagweergave">{inner}</button>
                  : inner}
              </div>;
            })}
          </div>

          <div className="tb-allday-row">
            <div className="tb-gutter tb-sticky-gutter tb-allday-label">
              <span className="tb-allday-text">Hele dag</span>
              {allDayCollapsible && (
                <button type="button" className="tb-allday-toggle" onClick={() => setAllDayExpanded(v => !v)}
                  title={allDayExpanded ? 'Minder tonen' : 'Alle hele-dag-items tonen'}
                  aria-label={allDayExpanded ? 'Hele-dag-rij inklappen' : 'Hele-dag-rij uitklappen'}>
                  {allDayExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              )}
            </div>
            <div className="tb-allday-lanes" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
              {visibleAllDayBars.map(bar => bar.kind === 'event' && bar.event ? (
                <button type="button"
                  className={`tb-ad-bar${bar.continuesLeft ? ' tb-ad-cont-l' : ''}${bar.continuesRight ? ' tb-ad-cont-r' : ''}${bar.event.visibility === 'private' ? ' tb-ev-priv' : ''}`}
                  key={bar.key}
                  style={{ ...eventColorStyle(eventColor(bar.event)), gridColumn: `${bar.startIdx + 1} / span ${bar.span}`, gridRow: bar.lane + 1 }}
                  onClick={() => onOpenEvent(bar.event!)}
                  title={`${bar.event.title}\n${formatEventRange(bar.event)}`}>
                  {bar.continuesLeft && <ChevronLeft size={11} className="tb-ad-bar-cont" />}
                  <span className="tb-ad-bar-title">{bar.event.title}{bar.timeLabel ? `, ${bar.timeLabel}` : ''}</span>
                  {bar.continuesRight && <ChevronRight size={11} className="tb-ad-bar-cont tb-ad-bar-cont-r" />}
                </button>
              ) : bar.task ? (
                <button type="button" className="tb-ad-bar tb-ad-bar-task" key={bar.key}
                  style={{ gridColumn: `${bar.startIdx + 1} / span ${bar.span}`, gridRow: bar.lane + 1 }}
                  onClick={() => onEditTask(bar.task!)} title={`Taak · ${bar.task.title}`}>
                  <span className="tb-ad-bar-title">{bar.task.title}</span>
                </button>
              ) : null)}
              {!allDayShowAll && hiddenAllDayCounts.map((count, di) => count > 0 ? (
                <button type="button" className="tb-ad-more" key={`more-${di}`}
                  style={{ gridColumn: `${di + 1} / span 1`, gridRow: ALLDAY_COLLAPSED_LANES + 1 }}
                  onClick={() => setAllDayExpanded(true)} title="Toon alle hele-dag-items">
                  +{count}
                </button>
              ) : null)}
            </div>
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
                <div className={`tb-col${isToday ? ' tb-today-col' : ''}`} key={di} ref={el => { colRefs.current[di] = el; }} style={{ gridColumn: di + 2, gridRow: `1 / span ${TOTAL_SLOTS}` }}
                  onPointerDown={canSelect ? e => beginSelection(e, di) : undefined}>
                  {hourLabels.map((h, si) => {
                    const selected = isInSelection(di, si);
                    return (
                      <div
                        className={`tb-cell${h.minutes === 0 ? ' tb-cell-hour' : ' tb-cell-half'}${selected ? ' tb-cell-sel' : ''}${canSelect ? ' tb-cell-can' : ''}`}
                        key={si}
                        style={{ top: `calc(var(--tb-h) * ${si})`, height: 'var(--tb-h)' }}
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
                    // De blokhoogte bepaalt wat er past. Een half uur is maar één
                    // roosterrij (~26px) hoog: daar zetten titel en starttijd zich
                    // naast elkaar op één regel ("Titel, 10:00", zoals Google) i.p.v.
                    // twee regels die elkaar verdringen.
                    const densityClass = visibleDuration < 30 ? ' tb-ev-tight'
                      : visibleDuration < 45 ? ' tb-ev-compact'
                        : visibleDuration < 60 ? ' tb-ev-cozy'
                          : ' tb-ev-roomy';
                    const eventMeta = [providerLabel(ev.provider), ev.source_name, ev.location].filter(Boolean).join(' · ');
                    // In het rooster tonen we alleen de locatie (de kleur duidt de
                    // agenda/bron al aan) — "Google · Agenda" eronder was vooral ruis.
                    // De volledige bron blijft in de tooltip en het detailpaneel.
                    const eventLocation = ev.location?.trim() ?? '';
                    const trackedMin = trackedMinutesFor(ev);
                    const draggable = !readOnlyEvents && canDragEvent(ev) && !segment.startsBeforeDay && !segment.endsAfterDay;
                    const isGhosted = Boolean(interaction) && eventIdentityKey(interaction!.event) === eventIdentityKey(ev);
                    return (
                      <button type="button" className={`tb-ev${densityClass}${segment.isBackground ? ' tb-ev-bg' : ''}${ev.visibility === 'private' ? ' tb-ev-priv' : ''}${trackedMin != null ? ' tb-ev-tracked' : ''}${draggable ? ' tb-ev-draggable' : ''}${isGhosted ? ' tb-ev-ghosted' : ''}`} key={`${ev.provider}-${ev.provider_event_id}-${di}`}
                        onClick={() => { if (draggedRef.current) return; onOpenEvent(ev); }}
                        onPointerDown={draggable ? e => beginEventInteraction(e, ev, di, 'move') : undefined}
                        style={{
                          ...eventColorStyle(eventColor(ev)),
                          top: `${segment.top}%`,
                          height: `${segment.height}%`,
                          left: `calc((100% - ${EVENT_CLICK_STRIP}) * ${left / 100} + 2px)`,
                          right: `calc((100% - ${EVENT_CLICK_STRIP}) * ${right / 100} + ${EVENT_CLICK_STRIP} + 2px)`,
                        }}
                        title={`${visualTime}\n${ev.title}\n${eventMeta}${trackedMin != null ? `\n${formatMinutes(trackedMin)} geregistreerd` : ''}${draggable ? '\nSleep om te verplaatsen · sleep de randen om de duur te wijzigen' : ''}`}>
                        {trackedMin != null && <span className="tb-ev-track" title={`${formatMinutes(trackedMin)} geregistreerd`}><Clock size={10} />{formatMinutes(trackedMin)}</span>}
                        {ev.meeting_url && <span className="tb-ev-video" title="Videocall gekoppeld"><Video size={10} /></span>}
                        {draggable && <span className="tb-ev-handle tb-ev-handle-top" onPointerDown={e => beginEventInteraction(e, ev, di, 'resize-start')} title="Sleep om de starttijd te wijzigen" />}
                        <span className="tb-ev-time">{visualTime}</span>
                        <span className="tb-ev-title">{ev.title}</span>
                        {/* Korte starttijd: op een blok van een half uur past maar
                            één regel, dus zet de CSS titel + starttijd naast elkaar
                            ("Titel, 10:00", zoals Google) en verbergt hij de volle
                            tijdregel hierboven. */}
                        <span className="tb-ev-start">{formatTime(ev.starts_at)}</span>
                        {eventLocation && <span className="tb-ev-src">{eventLocation}</span>}
                        {draggable && <span className="tb-ev-handle tb-ev-handle-bottom" onPointerDown={e => beginEventInteraction(e, ev, di, 'resize-end')} title="Sleep om de eindtijd te wijzigen" />}
                      </button>
                    );
                  })}

                  {bookingSlots.filter(s => s.status !== 'cancelled' && isSameDay(new Date(s.starts_at), day)).map(s => {
                    const top = dateToVisibleDayFraction(day, new Date(s.starts_at)) * 100;
                    const bottom = dateToVisibleDayFraction(day, new Date(s.ends_at)) * 100;
                    const height = Math.max(bottom - top, 1.6);
                    const taken = s.status === 'booked' || s.status === 'pending';
                    const removable = !taken && s.removable === true;
                    return (
                      <button type="button" key={`bk-${s.id}`}
                        className="tb-booking-slot"
                        onClick={() => { if (removable && onRemoveBookingSlot) onRemoveBookingSlot(s.id); }}
                        title={taken ? 'Dit blok is geboekt' : removable ? 'Concept-optie — klik om te verwijderen' : 'Aangeboden optie aan de klant'}
                        style={{
                          position: 'absolute', top: `${top}%`, height: `${height}%`, left: '2px', right: '2px', zIndex: 6,
                          borderRadius: 6, border: `2px ${removable ? 'solid' : 'dashed'}`, borderColor: taken ? '#5865f2' : '#3ba55d',
                          background: taken ? 'rgba(88,101,242,.20)' : removable ? 'rgba(59,165,93,.24)' : 'rgba(59,165,93,.12)',
                          color: '#eafff0', fontWeight: 600, fontSize: 11, lineHeight: 1.2, cursor: removable ? 'pointer' : 'default',
                          // Alleen-lezen opties mogen het slepen/aanmaken van gewone afspraken eronder niet blokkeren.
                          pointerEvents: removable ? 'auto' : 'none',
                          display: 'flex', alignItems: 'flex-start', padding: '2px 5px', overflow: 'hidden',
                        }}>
                        {taken ? '🔒 ' : removable ? '✕ ' : '○ '}{formatTime(s.starts_at)}–{formatTime(s.ends_at)}
                      </button>
                    );
                  })}

                  {interaction && interaction.preview.dayIndex === di && (() => {
                    const pv = interaction.preview;
                    const top = (pv.startMin / DAY_MINUTES) * 100;
                    const height = Math.max(((pv.endMin - pv.startMin) / DAY_MINUTES) * 100, (100 / TOTAL_SLOTS) * MIN_EVENT_HEIGHT_SLOTS);
                    const fmt = (m: number) => formatHour(Math.floor(m / 60) % 24, Math.round(m % 60));
                    return (
                      <div className="tb-ev tb-ev-preview" style={{ ...eventColorStyle(eventColor(interaction.event)), top: `${top}%`, height: `${height}%`, left: '2px', right: `calc(${EVENT_CLICK_STRIP} + 2px)` }}>
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

    </div>
  );
}

/* ── Month view ───────────────────────────────────────────────────────── */

// Google-dichtheid: bovenin de cel het dagnummer, daaronder rijen ("lanes") van
// gelijke hoogte. De TSX rekent met deze pixels uit hoeveel lanes er in een
// weekrij passen; de CSS krijgt exact dezelfde waarden via custom properties,
// zodat er maar één bron van waarheid is.
const MONTH_DATE_ROW_PX = 26;
const MONTH_LANE_PX = 20;
const MONTH_LANE_GAP_PX = 2;
const MONTH_ROW_PAD_PX = 6;

// Deelt het maandrooster op in weken van 7 dagen (voor de weeknummer-kolom).
function weekChunks(days: Date[]): Date[][] {
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

const SHORT_MONTH_FMT = new Intl.DateTimeFormat('nl-NL', { month: 'short' });
function shortMonthNl(day: Date): string { return SHORT_MONTH_FMT.format(day).replace('.', ''); }

/**
 * Eén item in een weekrij van de maandweergave. `span` telt dagkolommen: een
 * meerdaagse afspraak is één doorlopende balk (Google) i.p.v. losse blokjes per
 * dag. Loopt hij door buiten deze week, dan staat dat in continuesLeft/Right.
 */
type MonthChip = {
  key: string;
  kind: 'bar' | 'timed' | 'task';
  event?: CalendarExternalEvent;
  task?: Task;
  startIdx: number;
  span: number;
  lane: number;
  continuesLeft: boolean;
  continuesRight: boolean;
  /** Starttijd op een meerdaagse getimede balk (Google toont "Titel, 15:30"). */
  timeLabel: string | null;
};

/** De lokale kalenderdagen die een afspraak beslaat (einde exclusief). */
function eventDayRange(event: CalendarExternalEvent): { startKey: string; endKeyExclusive: string } {
  if (event.all_day) return { startKey: allDayStartDateKey(event), endKeyExclusive: allDayEndDateKeyExclusive(event) };
  const startKey = formatISODate(new Date(event.starts_at));
  // Einde-min-1ms: een afspraak die om exact middernacht eindigt telt de
  // volgende dag niet mee.
  const endMs = Math.max(new Date(event.ends_at).getTime() - 1, new Date(event.starts_at).getTime());
  return { startKey, endKeyExclusive: addDateKeyDays(formatISODate(new Date(endMs)), 1) };
}

/**
 * Verdeelt de items van één weekrij over lanes (Google): meerdaagse en
 * hele-dag-afspraken zijn doorlopende balken die hun lane over álle dagen die
 * ze raken bezet houden; getimede afspraken van één dag vullen de gaten die
 * daaronder overblijven. Zo schuiven de losse items netjes onder de balk door
 * en blijft een meerdaagse afspraak visueel één geheel.
 */
function layoutMonthWeek(week: Date[], events: CalendarExternalEvent[], tasks: Task[]): MonthChip[] {
  const dayKeys = week.map(formatISODate);
  const firstKey = dayKeys[0];
  const lastKeyExclusive = addDateKeyDays(dayKeys[dayKeys.length - 1], 1);

  const bars: MonthChip[] = [];
  const singles: MonthChip[] = [];

  for (const event of events) {
    const { startKey, endKeyExclusive } = eventDayRange(event);
    if (endKeyExclusive <= firstKey || startKey >= lastKeyExclusive) continue;
    const clampedStart = startKey < firstKey ? firstKey : startKey;
    const clampedEndExclusive = endKeyExclusive > lastKeyExclusive ? lastKeyExclusive : endKeyExclusive;
    const startIdx = dayKeys.indexOf(clampedStart);
    const endIdx = dayKeys.indexOf(addDateKeyDays(clampedEndExclusive, -1));
    if (startIdx < 0 || endIdx < 0) continue;
    const multiDay = addDateKeyDays(startKey, 1) < endKeyExclusive;
    const chip: MonthChip = {
      key: `ev-${eventIdentityKey(event)}`,
      kind: event.all_day || multiDay ? 'bar' : 'timed',
      event,
      startIdx,
      span: endIdx - startIdx + 1,
      lane: 0,
      continuesLeft: startKey < firstKey,
      continuesRight: endKeyExclusive > lastKeyExclusive,
      timeLabel: !event.all_day && multiDay ? formatTime(event.starts_at) : null,
    };
    (chip.kind === 'bar' ? bars : singles).push(chip);
  }

  for (const task of tasks) {
    if (!task.end_date) continue;
    const idx = dayKeys.indexOf(dateKeyFromValue(task.end_date));
    if (idx < 0) continue;
    singles.push({ key: `task-${task.id}`, kind: 'task', task, startIdx: idx, span: 1, lane: 0, continuesLeft: false, continuesRight: false, timeLabel: null });
  }

  // Balken bovenaan (langste eerst, net als Google), daarna de getimede
  // afspraken op starttijd; taken sluiten de rij af.
  bars.sort((a, b) => a.startIdx - b.startIdx || b.span - a.span || (a.event?.title ?? '').localeCompare(b.event?.title ?? '', 'nl'));
  singles.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'task' ? 1 : -1;
    if (a.event && b.event) return a.event.starts_at.localeCompare(b.event.starts_at);
    return (a.task?.title ?? '').localeCompare(b.task?.title ?? '', 'nl');
  });

  const laneRows: boolean[][] = [];
  const ordered = [...bars, ...singles];
  for (const chip of ordered) {
    for (let lane = 0; ; lane++) {
      if (!laneRows[lane]) laneRows[lane] = new Array(week.length).fill(false);
      const row = laneRows[lane];
      let free = true;
      for (let i = chip.startIdx; i < chip.startIdx + chip.span; i++) { if (row[i]) { free = false; break; } }
      if (!free) continue;
      for (let i = chip.startIdx; i < chip.startIdx + chip.span; i++) row[i] = true;
      chip.lane = lane;
      break;
    }
  }
  return ordered;
}

/* ── Maand: het dagkaartje achter "+N meer" ──────────────────────────────
   Google kapt een volle dag af met "+3 meer" en laat de rest zien in een klein
   zwevend kaartje bóven het rooster — je blijft in de maand staan. Alleen op de
   telefoon is dat te krap; daar schuift de dag in het paneel onder het rooster. */
function MonthDayCard({ day, rect, items, sourceColors, onOpenDay, onOpenEvent, onEditTask, onClose }: {
  day: Date;
  rect: { left: number; top: number; width: number; height: number };
  items: MonthDayItem[];
  sourceColors: Map<string, string>;
  onOpenDay: (day: Date) => void;
  onOpenEvent: (event: CalendarExternalEvent) => void;
  onEditTask: (task: Task) => void;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPlaced({
      left: Math.round(Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 8)),
      top: Math.round(Math.min(Math.max(8, rect.top - 6), window.innerHeight - h - 8)),
    });
  }, [rect]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return <>
    <div className="cm-daycard-scrim" onClick={onClose} role="presentation" />
    <div className="cm-daycard" ref={cardRef} role="dialog" aria-label={formatDateKey(formatISODate(day))}
      style={{ left: placed?.left ?? rect.left, top: placed?.top ?? rect.top, visibility: placed ? 'visible' : 'hidden' }}>
      <div className="cm-daycard-head">
        <button type="button" className="cm-daycard-date" onClick={() => { onClose(); onOpenDay(day); }} title="Open dagweergave">
          <span className="cm-daycard-name">{dayNameNl(day)}</span>
          <span className="cm-daycard-num">{day.getDate()}</span>
        </button>
        <button type="button" className="cm-daycard-close" onClick={onClose} aria-label="Sluiten"><X size={15} /></button>
      </div>
      <MonthDayItemList items={items} sourceColors={sourceColors} onOpenEvent={ev => { onClose(); onOpenEvent(ev); }} onEditTask={task => { onClose(); onEditTask(task); }} />
    </div>
  </>;
}

/** Alles wat er op één dag staat, in de volgorde die Google aanhoudt. */
type MonthDayItem = { key: string; event?: CalendarExternalEvent; task?: Task };

function monthDayItems(day: Date, events: CalendarExternalEvent[], tasks: Task[]): MonthDayItem[] {
  const dayEvents = events
    .filter(ev => eventOverlapsDay(ev, day))
    // Hele dag en meerdaags bovenaan, daarna op tijd — precies zoals in het rooster.
    .sort((a, b) => Number(Boolean(b.all_day)) - Number(Boolean(a.all_day)) || a.starts_at.localeCompare(b.starts_at));
  const dayTasks = tasks.filter(t => t.end_date && isSameDay(new Date(`${t.end_date}T12:00:00`), day));
  return [
    ...dayEvents.map(ev => ({ key: `ev-${ev.provider}-${ev.source_id}-${ev.provider_event_id}-${ev.starts_at}`, event: ev })),
    ...dayTasks.map(t => ({ key: `task-${t.id}`, task: t })),
  ];
}

function MonthDayItemList({ items, sourceColors, onOpenEvent, onEditTask }: {
  items: MonthDayItem[];
  sourceColors: Map<string, string>;
  onOpenEvent: (event: CalendarExternalEvent) => void;
  onEditTask: (task: Task) => void;
}) {
  if (items.length === 0) return <p className="cm-daylist-empty">Niets gepland.</p>;
  return <div className="cm-daylist-items">
    {items.map(item => item.event ? (
      <button type="button" className={`cm-dayitem${item.event.visibility === 'private' ? ' is-private' : ''}`} key={item.key}
        style={eventColorStyle(sourceColors.get(item.event.source_id))} onClick={() => onOpenEvent(item.event!)}>
        <span className="cm-dayitem-dot" aria-hidden="true" />
        <span className="cm-dayitem-time">{item.event.all_day ? 'Hele dag' : formatTime(item.event.starts_at)}</span>
        <span className="cm-dayitem-title">{item.event.title}</span>
        {item.event.meeting_url && <Video size={12} className="cm-dayitem-video" />}
      </button>
    ) : item.task ? (
      <button type="button" className="cm-dayitem is-task" key={item.key} onClick={() => onEditTask(item.task!)}>
        <span className="cm-dayitem-dot" aria-hidden="true" />
        <span className="cm-dayitem-time">Taak</span>
        <span className="cm-dayitem-title">{item.task.title}</span>
      </button>
    ) : null)}
  </div>;
}

export function CalendarMonthView({ days, anchor, events, tasks, data, sourceColors, trackedMinutesFor, onEditTask, onOpenDay, onOpenEvent, isMobile = false, selectedDay = null, onSelectDay, onCreateOnDay }: {
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
  /** Telefoon: tikken kiest een dag en toont die onder het rooster (Google-werkwijze). */
  isMobile?: boolean;
  selectedDay?: Date | null;
  onSelectDay?: (day: Date) => void;
  /** Bureaublad: klikken op een lege plek maakt een afspraak op die dag. */
  onCreateOnDay?: (day: Date) => void;
}) {
  function eventColor(ev: CalendarExternalEvent): string { return sourceColors.get(ev.source_id) ?? '#FFD966'; }
  const weeks = useMemo(() => weekChunks(days), [days]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Het "+N meer"-kaartje: welke dag, en waar stond de knop die erom vroeg.
  const [moreDay, setMoreDay] = useState<{ day: Date; rect: { left: number; top: number; width: number; height: number } } | null>(null);
  useEffect(() => { setMoreDay(null); }, [anchor]);

  /** Klikken op een lege plek in een dag: telefoon kiest de dag, bureaublad maakt
   *  er een afspraak op (en valt terug op de dagweergave zonder schrijfrecht). */
  const pickDay = useCallback((day: Date) => {
    if (isMobile && onSelectDay) { onSelectDay(startOfDay(day)); return; }
    if (onCreateOnDay) { onCreateOnDay(startOfDay(day)); return; }
    onOpenDay(day);
  }, [isMobile, onSelectDay, onCreateOnDay, onOpenDay]);

  /** "+N meer": bureaublad opent het dagkaartje, telefoon kiest de dag. */
  const openDayCard = useCallback((day: Date, el: HTMLElement) => {
    if (isMobile && onSelectDay) { onSelectDay(startOfDay(day)); return; }
    const rect = el.getBoundingClientRect();
    setMoreDay({ day: startOfDay(day), rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
  }, [isMobile, onSelectDay]);

  // Hoeveel items er per dag passen volgt uit de werkelijke rijhoogte — net als
  // bij Google, dat in een maand met vijf weekrijen meer regels toont dan in een
  // maand met zes.
  const [maxLanes, setMaxLanes] = useState(3);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      // Nog geen hoogte (net gemonteerd, of in een verborgen tab)? Dan wachten we
      // op de observer i.p.v. één lane vast te leggen op een bogus 0-meting.
      if (el.clientHeight <= 0) return;
      const rowHeight = el.clientHeight / Math.max(1, weeks.length);
      const usable = rowHeight - MONTH_DATE_ROW_PX - MONTH_ROW_PAD_PX;
      setMaxLanes(Math.max(1, Math.floor((usable + MONTH_LANE_GAP_PX) / (MONTH_LANE_PX + MONTH_LANE_GAP_PX))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks.length]);

  const today = new Date();
  const gridStyle = {
    '--cm-date-h': `${MONTH_DATE_ROW_PX}px`,
    '--cm-lane': `${MONTH_LANE_PX}px`,
    '--cm-gap': `${MONTH_LANE_GAP_PX}px`,
    '--cm-pad': `${MONTH_ROW_PAD_PX}px`,
  } as CSSProperties;

  return (
    <div className="cm-view" style={gridStyle}>
      <div className="cm-head">
        <span className="cm-head-weekno" aria-hidden="true" />
        {DAY_NAMES_NL.map(name => <span className="cm-head-cell" key={name}>{name}</span>)}
      </div>
      <div className="cm-grid" ref={gridRef}>
        {weeks.map(week => {
          const chips = layoutMonthWeek(week, events, tasks);
          // Past niet alles? Dan houdt de laatste zichtbare lane ruimte vrij
          // voor "+N meer" — precies zoals Google een volle dag afkapt. Tel per
          // dag de hóógste lane, niet het aantal items: een balk van een andere
          // dag kan een lane bezet houden waardoor er gaten vallen.
          const lanesPerDay = week.map((_, i) => chips.reduce((m, c) => (i >= c.startIdx && i < c.startIdx + c.span ? Math.max(m, c.lane + 1) : m), 0));
          const cutoff = lanesPerDay.map(used => (used > maxLanes ? maxLanes - 1 : maxLanes));
          const visibleKeys = new Set<string>();
          for (const chip of chips) {
            let fits = true;
            for (let i = chip.startIdx; i < chip.startIdx + chip.span; i++) { if (chip.lane >= cutoff[i]) { fits = false; break; } }
            if (fits) visibleKeys.add(chip.key);
          }
          const hiddenPerDay = week.map((_, i) => chips.filter(c => i >= c.startIdx && i < c.startIdx + c.span && !visibleKeys.has(c.key)).length);
          const allOutside = week.every(d => !isSameMonth(d, anchor));

          return (
            <div className="cm-week" key={`wk-${formatISODate(week[0])}`}>
              <div className={`cm-weekno${allOutside ? ' is-outside' : ''}`} title={`Week ${isoWeekNumber(week[0])}`}>
                <span className="cm-weekno-label">Week </span>{isoWeekNumber(week[0])}
              </div>
              <div className="cm-week-body">
                <div className="cm-cells">
                  {week.map(day => (
                    <div
                      className={`cm-cell${isSameMonth(day, anchor) ? '' : ' is-outside'}${isSameDay(day, today) ? ' is-today' : ''}${selectedDay && isSameDay(day, selectedDay) ? ' is-selected' : ''}`}
                      key={formatISODate(day)}
                      role="presentation"
                      onClick={() => pickDay(day)}
                    />
                  ))}
                </div>
                <div className="cm-dates">
                  {week.map(day => {
                    const isToday = isSameDay(day, today);
                    const isPicked = Boolean(selectedDay && isSameDay(day, selectedDay));
                    return (
                      <button
                        type="button"
                        className={`cm-date${isSameMonth(day, anchor) ? '' : ' is-outside'}`}
                        key={formatISODate(day)}
                        onClick={() => (isMobile && onSelectDay ? onSelectDay(startOfDay(day)) : onOpenDay(day))}
                        title={`${formatDateKey(formatISODate(day))}${isMobile ? '' : ' — open dagweergave'}`}
                      >
                        <span className={`cm-date-num${isToday ? ' is-today' : ''}${isPicked && !isToday ? ' is-selected' : ''}`}>
                          {day.getDate() === 1 ? `${day.getDate()} ${shortMonthNl(day)}` : day.getDate()}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="cm-lanes">
                  {chips.filter(c => visibleKeys.has(c.key)).map(chip => {
                    const place: CSSProperties = { gridColumn: `${chip.startIdx + 1} / span ${chip.span}`, gridRow: chip.lane + 1 };
                    if (chip.kind === 'task' && chip.task) {
                      const task = chip.task;
                      return (
                        <button type="button" className="cm-chip is-task" key={chip.key} style={place}
                          onClick={() => onEditTask(task)}
                          title={`Taak · ${task.title} · ${data.projects.find(p => p.id === task.project_id)?.name ?? 'Project'}`}>
                          <span className="cm-chip-dot" aria-hidden="true" />
                          <span className="cm-chip-time">Taak</span>
                          <span className="cm-chip-title">{task.title}</span>
                        </button>
                      );
                    }
                    const event = chip.event!;
                    const tracked = trackedMinutesFor(event);
                    const outside = !isSameMonth(week[chip.startIdx], anchor);
                    if (chip.kind === 'bar') {
                      return (
                        <button type="button"
                          className={`cm-chip is-bar${chip.continuesLeft ? ' cont-l' : ''}${chip.continuesRight ? ' cont-r' : ''}${event.visibility === 'private' ? ' is-private' : ''}${outside ? ' is-outside' : ''}`}
                          key={chip.key} style={{ ...place, ...eventColorStyle(eventColor(event)) }}
                          onClick={() => onOpenEvent(event)}
                          title={`${event.title}\n${formatEventRange(event)}`}>
                          {chip.continuesLeft && <ChevronLeft size={11} className="cm-chip-cont" />}
                          <span className="cm-chip-title">{event.title}{chip.timeLabel ? `, ${chip.timeLabel}` : ''}</span>
                          {tracked != null && <em className="cm-chip-track"><Clock size={9} />{formatMinutes(tracked)}</em>}
                          {chip.continuesRight && <ChevronRight size={11} className="cm-chip-cont cm-chip-cont-r" />}
                        </button>
                      );
                    }
                    return (
                      <button type="button"
                        className={`cm-chip is-timed${event.visibility === 'private' ? ' is-private' : ''}${outside ? ' is-outside' : ''}`}
                        key={chip.key} style={{ ...place, ...eventColorStyle(eventColor(event)) }}
                        onClick={() => onOpenEvent(event)}
                        title={`${formatTime(event.starts_at)} – ${formatTime(event.ends_at)}\n${event.title}`}>
                        <span className="cm-chip-dot" aria-hidden="true" />
                        <span className="cm-chip-time">{formatTime(event.starts_at)}</span>
                        <span className="cm-chip-title">{event.title}</span>
                        {tracked != null && <em className="cm-chip-track"><Clock size={9} />{formatMinutes(tracked)}</em>}
                      </button>
                    );
                  })}
                  {hiddenPerDay.map((count, i) => count > 0 ? (
                    <button type="button" className="cm-more" key={`more-${i}`}
                      style={{ gridColumn: `${i + 1} / span 1`, gridRow: cutoff[i] + 1 }}
                      onClick={e => openDayCard(week[i], e.currentTarget)}
                      title={`Alles van ${formatDateKey(formatISODate(week[i]))} tonen`}>
                      +{count}<span className="cm-more-label"> meer</span>
                    </button>
                  ) : null)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Telefoon: de gekozen dag als lijstje onder het rooster (Google-werkwijze). */}
      {isMobile && selectedDay && (
        <section className="cm-daylist" aria-label={`Items op ${formatDateKey(formatISODate(selectedDay))}`}>
          <header className="cm-daylist-head">
            <div>
              <span className="cm-daylist-name">{dayNameNl(selectedDay)}</span>
              <strong className="cm-daylist-date">{formatDateKey(formatISODate(selectedDay))}</strong>
            </div>
            <Button onClick={() => onOpenDay(selectedDay)}>Open dag</Button>
          </header>
          <MonthDayItemList items={monthDayItems(selectedDay, events, tasks)} sourceColors={sourceColors}
            onOpenEvent={onOpenEvent} onEditTask={onEditTask} />
        </section>
      )}

      {moreDay && (
        <MonthDayCard day={moreDay.day} rect={moreDay.rect} items={monthDayItems(moreDay.day, events, tasks)}
          sourceColors={sourceColors} onOpenDay={onOpenDay} onOpenEvent={onOpenEvent} onEditTask={onEditTask}
          onClose={() => setMoreDay(null)} />
      )}
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

/* ── Genodigden: contact-zoeker (app-eigen + Google/Outlook) + handmatig ─── */

type AttendeeSuggestion = { name: string | null; email: string; source: 'client' | 'supplier' | 'google' | 'microsoft' };
const ATTENDEE_SOURCE_LABEL: Record<AttendeeSuggestion['source'], string> = { client: 'Klant', supplier: 'Leverancier', google: 'Google', microsoft: 'Outlook' };
const EMAIL_RE_FE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Zoekt in de app-eigen contacten (klanten + leveranciers, met contactpersoon).
function searchAppContacts(query: string, clients: Client[], suppliers: Supplier[]): AttendeeSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: AttendeeSuggestion[] = [];
  for (const c of clients) {
    if (!c.email) continue;
    const hay = `${c.name} ${c.contact_name ?? ''} ${c.email}`.toLowerCase();
    if (hay.includes(q)) out.push({ name: c.contact_name ? `${c.contact_name} · ${c.name}` : c.name, email: c.email, source: 'client' });
  }
  for (const s of suppliers) {
    if (!s.email) continue;
    const hay = `${s.name} ${s.contact_name ?? ''} ${s.email}`.toLowerCase();
    if (hay.includes(q)) out.push({ name: s.contact_name ? `${s.contact_name} · ${s.name}` : s.name, email: s.email, source: 'supplier' });
  }
  return out.slice(0, 6);
}

function AttendeePicker({ organizationId, sourceId, sourceProvider, clients, suppliers, attendees, onChange }: {
  organizationId: UUID;
  sourceId: string;
  sourceProvider: CalendarProvider | null;
  clients: Client[];
  suppliers: Supplier[];
  attendees: { email: string; name: string }[];
  onChange: (next: { email: string; name: string }[]) => void;
}) {
  const [input, setInput] = useState('');
  const [providerHits, setProviderHits] = useState<AttendeeSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<number | null>(null);
  const canSearchProvider = sourceProvider === 'google' || sourceProvider === 'microsoft';

  useEffect(() => {
    function onDocDown(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  // Provider-contacten (Google/Outlook) debounced ophalen; app-contacten gaan lokaal.
  useEffect(() => {
    setNeedsReconnect(false);
    const q = input.trim();
    if (!canSearchProvider || !sourceId || q.length < 2) { setProviderHits([]); setLoading(false); return; }
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    setLoading(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const { contacts, needsReconnect } = await searchCalendarContacts(organizationId, sourceId, q);
        setNeedsReconnect(needsReconnect);
        setProviderHits(contacts.map(c => ({ name: c.name, email: c.email, source: sourceProvider === 'google' ? 'google' : 'microsoft' })));
      } catch { setProviderHits([]); }
      finally { setLoading(false); }
    }, 300);
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current); };
  }, [input, canSearchProvider, sourceId, sourceProvider, organizationId]);

  const added = new Set(attendees.map(a => a.email.toLowerCase()));
  const suggestions = useMemo(() => {
    const merged = [...searchAppContacts(input, clients, suppliers), ...providerHits];
    const seen = new Set<string>();
    const out: AttendeeSuggestion[] = [];
    for (const s of merged) {
      const key = s.email.toLowerCase();
      if (seen.has(key) || added.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out.slice(0, 8);
  }, [input, clients, suppliers, providerHits, added]);

  function addAttendee(email: string, name: string) {
    const clean = email.trim().toLowerCase();
    if (!EMAIL_RE_FE.test(clean) || added.has(clean)) return;
    onChange([...attendees, { email: clean, name: name.trim() }]);
    setInput(''); setProviderHits([]); setOpen(false); setHighlight(-1);
  }
  function commitTyped() {
    if (highlight >= 0 && suggestions[highlight]) { const s = suggestions[highlight]; addAttendee(s.email, s.name ?? ''); return; }
    if (EMAIL_RE_FE.test(input.trim())) addAttendee(input, '');
  }

  return (
    <div className="event-attendees">
      <div className="tb-panel-section-label"><Users size={13} /> Genodigden</div>
      <div className="attendee-picker" ref={boxRef}>
        <div className="attendee-picker-row">
          <Input value={input} type="text" placeholder="Zoek een contact of typ een e-mailadres…"
            onChange={e => { setInput(e.target.value); setOpen(true); setHighlight(-1); }}
            onFocus={() => setOpen(true)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitTyped(); return; }
              if (!open || suggestions.length === 0) return;
              if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, suggestions.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
              else if (e.key === 'Escape') { setOpen(false); }
            }} />
          <Button type="button" onClick={commitTyped} disabled={!EMAIL_RE_FE.test(input.trim()) && highlight < 0}><UserPlus size={14} /> Toevoegen</Button>
        </div>
        {open && (loading || suggestions.length > 0) && (
          <ul className="location-suggestions attendee-suggestions">
            {loading && suggestions.length === 0 && <li className="location-suggestion-empty">Contacten zoeken…</li>}
            {suggestions.map((s, i) => (
              <li key={`${s.source}-${s.email}`}>
                <button type="button" className={`location-suggestion attendee-suggestion${i === highlight ? ' active' : ''}`}
                  onMouseDown={e => { e.preventDefault(); addAttendee(s.email, s.name ?? ''); }}>
                  <Mail size={13} />
                  <span className="attendee-suggestion-main">
                    <strong>{s.name || s.email}</strong>
                    {s.name && <small>{s.email}</small>}
                  </span>
                  <span className="attendee-suggestion-src">{ATTENDEE_SOURCE_LABEL[s.source]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {needsReconnect && (
        <p className="calendar-help calendar-help-warn">Koppel je {sourceProvider === 'google' ? 'Google' : 'Microsoft'}-agenda opnieuw om ook je {sourceProvider === 'google' ? 'Google' : 'Outlook'}-contacten te kunnen doorzoeken.</p>
      )}
      {attendees.length > 0 && (
        <div className="attendee-chips">
          {attendees.map(a => (
            <span key={a.email} className="attendee-chip">
              {a.name ? `${a.name} · ${a.email}` : a.email}
              <button type="button" aria-label={`Verwijder ${a.email}`} onClick={() => onChange(attendees.filter(x => x.email !== a.email))}><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
      <p className="calendar-help">Genodigden krijgen een uitnodiging per e-mail en kunnen accepteren of afwijzen.</p>
    </div>
  );
}

function EventCreationPanel({ newEvent, setNewEvent, writeableSources, clients, suppliers, projects, loading, canWrite, selectedSourceIsNative, selectedSourceProvider, organizationId, onSubmit, onClose }: {
  newEvent: NewEventState;
  setNewEvent: (fn: (prev: NewEventState) => NewEventState) => void;
  writeableSources: CalendarSource[];
  clients: Client[];
  suppliers: Supplier[];
  projects: Project[];
  loading: boolean;
  canWrite: boolean;
  selectedSourceIsNative: boolean;
  selectedSourceProvider: CalendarProvider | null;
  organizationId: UUID;
  onSubmit: (e: FormEvent) => void;
  onClose: () => void;
}) {
  const editing = Boolean(newEvent.editingEventId);
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
        <AttendeePicker organizationId={organizationId} sourceId={newEvent.sourceId} sourceProvider={selectedSourceProvider}
          clients={clients} suppliers={suppliers} attendees={newEvent.attendees}
          onChange={next => setNewEvent(p => ({ ...p, attendees: next }))} />
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


/** Formulier-state van het detailpaneel: bewerken gebeurt direct in het paneel
 *  (geen losse popup); "Opslaan" verschijnt zodra iets afwijkt van het event. */
export type EventDetailForm = {
  title: string; location: string; description: string;
  startLocal: string; endLocal: string; allDay: boolean;
  recurrenceFreq: '' | RecurrenceFrequency; recurrenceUntil: string;
  meetingUrl: string; addConference: boolean;
  attendees: { email: string; name: string }[];
};

function detailFormFromEvent(event: CalendarExternalEvent): EventDetailForm {
  const rec = parseRruleToForm(event.rrule ?? null);
  return {
    title: event.title === '(Geen titel)' ? '' : (event.title ?? ''),
    location: event.location ?? '',
    description: event.description ?? '',
    startLocal: toInputDateTime(new Date(event.starts_at)),
    endLocal: toInputDateTime(new Date(event.ends_at)),
    allDay: event.all_day,
    recurrenceFreq: rec.freq,
    recurrenceUntil: rec.until,
    meetingUrl: event.meeting_url ?? '',
    addConference: false,
    attendees: (event.attendees ?? []).map(a => ({ email: a.email, name: a.name ?? '' })),
  };
}

function CalendarEventDetailPanel({ event, organizationId, data, sourceColors, canWrite, editable, onNewNote, onNewDocument, onSetEventLink, onLogTime, onEditNote, onLinkExistingNote, onUnlinkNote, onSaveEvent, onDeleteEvent, onClose }: {
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
  onEditNote: (note: Note) => void;
  onLinkExistingNote: (noteId: UUID, event: CalendarExternalEvent) => void | Promise<void>;
  onUnlinkNote: (linkId: UUID) => void | Promise<void>;
  onSaveEvent: (event: CalendarExternalEvent, form: EventDetailForm) => Promise<void>;
  onDeleteEvent: (event: CalendarExternalEvent) => void | Promise<void>;
  onClose: () => void;
}) {
  const [selectedNoteId, setSelectedNoteId] = useState('');
  const [attendees, setAttendees] = useState<CalendarEventAttendee[]>([]);
  // Bewerkbare events staan meteen in bewerkmodus: één formulier, voorgevuld
  // vanuit het event; de basislijn bepaalt of er iets te "Opslaan" valt.
  const [form, setForm] = useState<EventDetailForm | null>(null);
  const [baseline, setBaseline] = useState<EventDetailForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedNoteId('');
    setSaveError(null);
    const f = event ? detailFormFromEvent(event) : null;
    setForm(f);
    setBaseline(f);
  }, [event]);

  const nativeEventId = event?.provider === 'native' ? event.native_event_id : undefined;
  useEffect(() => {
    setAttendees([]);
    if (!nativeEventId) return;
    let active = true;
    getCalendarEventAttendees(organizationId, nativeEventId).then(rows => {
      if (!active) return;
      setAttendees(rows);
      // Native genodigden zitten niet op het event zelf: vul formulier én
      // basislijn aan zodra ze binnen zijn (géén onbedoelde "wijziging").
      const mapped = rows.map(r => ({ email: r.email, name: r.display_name ?? '' }));
      setForm(prev => prev ? { ...prev, attendees: mapped } : prev);
      setBaseline(prev => prev ? { ...prev, attendees: mapped } : prev);
    }).catch(() => {});
    return () => { active = false; };
  }, [nativeEventId, organizationId]);

  const dirty = Boolean(editable && form && baseline && JSON.stringify(form) !== JSON.stringify(baseline));

  async function saveEdits() {
    if (!event || !form || !dirty || saving) return;
    setSaving(true); setSaveError(null);
    try { await onSaveEvent(event, form); }
    catch (err) { setSaveError(err instanceof Error ? err.message : 'Opslaan mislukt.'); }
    finally { setSaving(false); }
  }

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
  // Genodigden: native uit de opgehaalde rijen, extern (Google/Microsoft) uit het event zelf.
  const displayAttendees: { key: string; label: string; status: AttendeeStatus }[] = event.provider === 'native'
    ? attendees.map(a => ({ key: a.id, label: a.display_name || a.email, status: a.status }))
    : (event.attendees ?? []).map((a, i) => ({ key: `${a.email}-${i}`, label: a.name || a.email, status: a.status }));

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

  const editing = editable && form !== null;

  return (
    <div className="event-detail-overlay" onClick={onClose}>
      <aside className="event-detail-panel" onClick={e => e.stopPropagation()} style={eventColorStyle(color)}>
        <div className="event-detail-glow" />
        <div className="event-detail-head">
          <div className="event-detail-head-main">
            <span className="event-detail-kicker">{providerLabel(event.provider)} · {event.source_name}</span>
            {editing ? (
              <div className="event-detail-title-edit">
                <Input value={form!.title} placeholder="Titel van de afspraak" aria-label="Titel"
                  onChange={e => setForm(p => p ? { ...p, title: e.target.value } : p)} />
              </div>
            ) : (
              <h3>{event.title}</h3>
            )}
          </div>
          <div className="event-detail-head-actions">
            {editing && <Button type="button" variant="primary" disabled={!dirty || saving} onClick={saveEdits}>{saving ? 'Opslaan…' : 'Opslaan'}</Button>}
            <button type="button" className="tb-panel-close" onClick={onClose} aria-label="Sluit eventdetails"><X size={17} /></button>
          </div>
        </div>
        {saveError && <div className="event-detail-save-error">{saveError}</div>}

        <div className="event-detail-meta-grid">
          {editing ? (
            <div className="event-detail-meta-card event-detail-time-edit">
              <Clock size={15} />
              <div className="event-time-edit">
                <div className="event-time-edit-fields">
                  <Input type="datetime-local" value={form!.startLocal} onChange={e => setForm(p => p ? { ...p, startLocal: e.target.value } : p)} aria-label="Starttijd" />
                  <span className="event-time-edit-sep">tot</span>
                  <Input type="datetime-local" value={form!.endLocal} onChange={e => setForm(p => p ? { ...p, endLocal: e.target.value } : p)} aria-label="Eindtijd" />
                </div>
                <label className="check-row event-allday-row">
                  <input type="checkbox" checked={form!.allDay} onChange={e => setForm(p => p ? { ...p, allDay: e.target.checked } : p)} /> Hele dag
                </label>
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
          {editing && event.provider === 'native' ? (
            <div className="event-detail-meta-card event-detail-recur-edit">
              <Repeat size={15} />
              <div className="event-recur-edit">
                <Select value={form!.recurrenceFreq} onChange={e => setForm(p => p ? { ...p, recurrenceFreq: e.target.value as '' | RecurrenceFrequency } : p)} aria-label="Herhaling">
                  <option value="">Niet herhalen</option>
                  <option value="daily">Elke dag</option>
                  <option value="weekly">Elke week</option>
                  <option value="monthly">Elke maand</option>
                </Select>
                {form!.recurrenceFreq && <Input type="date" value={form!.recurrenceUntil} title="Herhalen tot en met" aria-label="Herhalen tot en met"
                  onChange={e => setForm(p => p ? { ...p, recurrenceUntil: e.target.value } : p)} />}
              </div>
            </div>
          ) : recurrenceLabel(event.rrule) ? (
            <div className="event-detail-meta-card">
              <Repeat size={15} />
              <span>{recurrenceLabel(event.rrule)}</span>
            </div>
          ) : null}
          {editing ? (
            <div className="event-detail-meta-card event-detail-loc-edit">
              <MapPin size={15} />
              <LocationField value={form!.location} placeholder="Locatie toevoegen…"
                onChange={next => setForm(p => p ? { ...p, location: next } : p)} />
            </div>
          ) : event.location ? (
            <a className="event-detail-meta-card event-detail-map-link" href={googleMapsSearchUrl(event.location)} target="_blank" rel="noreferrer" title="Open locatie in Google Maps">
              <MapPin size={15} />
              <span>{event.location}</span>
              <ExternalLink size={12} className="event-detail-map-ext" />
            </a>
          ) : null}
          {event.meeting_url && (
            <a className="event-detail-meta-card event-detail-join-link" href={event.meeting_url} target="_blank" rel="noreferrer" title="Deelnemen aan de videocall">
              <Video size={15} />
              <span>Deelnemen · {detectMeetingKind(event.meeting_url).label}</span>
              <ExternalLink size={12} className="event-detail-map-ext" />
            </a>
          )}
        </div>

        {editing ? (
          <div className="event-detail-description event-detail-desc-edit">
            <span>Omschrijving</span>
            <Textarea value={form!.description} placeholder="Omschrijving toevoegen…"
              onChange={e => setForm(p => p ? { ...p, description: e.target.value } : p)} />
          </div>
        ) : event.description ? (
          <div className="event-detail-description">
            <span>Omschrijving</span>
            <p>{event.description}</p>
          </div>
        ) : (
          <div className="event-detail-empty">Geen omschrijving toegevoegd.</div>
        )}

        {editing && (
          <div className="event-detail-meeting-edit">
            <MeetingFields provider={event.provider} meetingUrl={form!.meetingUrl} addConference={form!.addConference}
              onChange={patch => setForm(p => p ? { ...p, ...patch } : p)} />
          </div>
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

        {editing ? (
          <section className="event-link-panel event-attendees-panel">
            <div className="event-link-head">
              <span className="event-notes-kicker">Genodigden</span>
              <h4>Uitnodigingen</h4>
              <p>{displayAttendees.length > 0
                ? `${displayAttendees.filter(a => a.status === 'accepted').length} van ${displayAttendees.length} geaccepteerd`
                : 'Nodig contacten of e-mailadressen uit; wijzigingen worden bij het opslaan gemaild.'}</p>
            </div>
            <AttendeePicker organizationId={organizationId} sourceId={event.source_id} sourceProvider={event.provider}
              clients={data.clients} suppliers={data.suppliers} attendees={form!.attendees}
              onChange={next => setForm(p => p ? { ...p, attendees: next } : p)} />
            {displayAttendees.length > 0 && (
              <div className="attendee-status-list">
                {displayAttendees.map(a => (
                  <div key={a.key} className="attendee-status-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', gap: 8 }}>
                    <span>{a.label}</span>
                    <span className={`attendee-status attendee-status-${a.status}`}>{ATTENDEE_STATUS_LABELS[a.status]}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : displayAttendees.length > 0 ? (
          <section className="event-link-panel">
            <div className="event-link-head">
              <span className="event-notes-kicker">Genodigden</span>
              <h4>Uitnodigingen</h4>
              <p>{displayAttendees.filter(a => a.status === 'accepted').length} van {displayAttendees.length} geaccepteerd</p>
            </div>
            <div className="attendee-status-list">
              {displayAttendees.map(a => (
                <div key={a.key} className="attendee-status-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', gap: 8 }}>
                  <span>{a.label}</span>
                  <span className={`attendee-status attendee-status-${a.status}`}>{ATTENDEE_STATUS_LABELS[a.status]}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

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
            attendees: event.provider === 'native'
              ? attendees.map(a => ({ email: a.email, name: a.display_name ?? '' }))
              : (event.attendees ?? []).map(a => ({ email: a.email, name: a.name ?? '' })),
          }}
          onSaveAsNote={canAttachNotes ? saveSummaryAsNote : undefined}
        />

        <div className="event-detail-actions">
          {editing && <Button type="button" variant="primary" disabled={!dirty || saving} onClick={saveEdits}>{saving ? 'Opslaan…' : 'Opslaan'}</Button>}
          {event.html_link && <a className={`btn ${editing ? 'btn-ghost' : 'btn-primary'}`} href={event.html_link} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in agenda</a>}
          {editable && <button type="button" className="btn btn-danger" onClick={() => onDeleteEvent(event)}><Trash2 size={14} /> Verwijderen</button>}
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

/** Dialoog om getekende concept-blokken door te sturen: kies klant/agenda + opties,
 *  maak de boekingslink aan en koppel de blokken. */
function BookingSendDialog({ sources, clients, draftCount, onCancel, onSubmit }: {
  sources: CalendarSource[];
  clients: Client[];
  draftCount: number;
  onCancel: () => void;
  onSubmit: (p: { sourceId: string; clientId: string; title: string; maxTotalBookings: number; maxPerWeek: number; introText: string; inviteMessage: string; meetingUrl: string; autoConference: boolean }) => void;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [clientId, setClientId] = useState('');
  const [title, setTitle] = useState('Afspraak inplannen');
  const [maxTotal, setMaxTotal] = useState('1');
  const [maxWeek, setMaxWeek] = useState('1');
  const [introText, setIntroText] = useState('');
  const [inviteMessage, setInviteMessage] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [autoConference, setAutoConference] = useState(true);
  const provider = sources.find(s => s.id === sourceId)?.provider ?? null;
  const isExternal = provider === 'google' || provider === 'microsoft';
  const conferenceLabel = provider === 'microsoft' ? 'Teams-vergadering' : 'Google Meet';

  const submit = () => {
    if (!sourceId) return;
    onSubmit({
      sourceId, clientId, title: title.trim() || 'Afspraak inplannen',
      maxTotalBookings: Math.max(1, parseInt(maxTotal, 10) || 1),
      maxPerWeek: Math.max(1, parseInt(maxWeek, 10) || 1),
      introText: introText.trim(), inviteMessage: inviteMessage.trim(),
      meetingUrl: meetingUrl.trim(), autoConference,
    });
  };

  return (
    <Modal title={`Doorsturen naar klant (${draftCount} blok${draftCount === 1 ? '' : 'ken'})`} onClose={onCancel}
      footer={<><Button onClick={onCancel}>Annuleren</Button><Button variant="primary" onClick={submit} disabled={!sourceId}>Boekingslink aanmaken</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label>Titel<Input value={title} onChange={e => setTitle(e.target.value)} /></label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label>Agenda<Select value={sourceId} onChange={e => setSourceId(e.target.value)}>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
          <label>Klant<Select value={clientId} onChange={e => setClientId(e.target.value)}><option value="">Geen klant</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label>Hoeveel opties mag de klant boeken?<Input type="number" min={1} value={maxTotal} onChange={e => setMaxTotal(e.target.value)} /><span className="muted" style={{ fontSize: 12 }}>1 = de klant kiest precies één moment.</span></label>
          <label>Waarvan max. per week<Input type="number" min={1} value={maxWeek} onChange={e => setMaxWeek(e.target.value)} /></label>
        </div>
        <label>Intro-tekst op de boekingspagina (optioneel)<Textarea rows={2} value={introText} onChange={e => setIntroText(e.target.value)} /></label>
        <label>Begeleidende tekst bij de uitnodiging (optioneel)<Textarea rows={2} value={inviteMessage} onChange={e => setInviteMessage(e.target.value)} /></label>
        {isExternal && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={autoConference} onChange={e => setAutoConference(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Automatisch een {conferenceLabel} aanmaken bij het boeken. <span className="muted" style={{ fontSize: 12 }}>(Vul je hieronder een eigen link in, dan wordt die gebruikt.)</span></span>
          </label>
        )}
        <label>Vaste videocall-link (optioneel)<Input value={meetingUrl} onChange={e => setMeetingUrl(e.target.value)} placeholder="https://…" /></label>
      </div>
    </Modal>
  );
}

const MOBILE_BREAKPOINT_PX = 768;

/** Smalle daglabels ("M D W D V Z Z") voor de mobiele dagstrip, zoals Google. */
const NARROW_DAY_FMT = new Intl.DateTimeFormat('nl-NL', { weekday: 'narrow' });

/* ── Vloeiend bladeren tussen periodes ─────────────────────────────────────
   Een sprong van week naar week vertelt je niets; een verschuiving wel. De
   truc: vlak vóór de wissel maken we een stilstaande kopie (`cloneNode`) van
   wat er staat. Die kopie schuift eruit terwijl het nieuwe beeld er tegelijk
   in schuift — ze kruisen elkaar, dus er valt nooit een gat, en we hoeven de
   zware roostercomponent geen tweede keer op te tuigen (met alle waarnemers
   en scrolleffecten van dien).

   Op de telefoon volgt het beeld eerst je vinger (met weerstand, zodat je
   ziet dát je bladert) en neemt deze overgang het bij loslaten over vanaf de
   plek waar je losliet. Bij de systeemvoorkeur "minder beweging" wisselt de
   agenda gewoon direct. */
type SlideDirection = -1 | 0 | 1;

const SLIDE_MS = 300;
const SLIDE_FADE_MS = 200;
const SLIDE_EASE = 'cubic-bezier(.22,.61,.36,1)';
/** Interne scrollers waarvan de kopie de positie moet overnemen. */
const SLIDE_SCROLLERS = '.tb-scroll,.cm-grid,.cm-daylist';

function useCalendarStage() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<{ direction: SlideDirection; fromPx: number } | null>(null);
  const runningRef = useRef<Animation[]>([]);
  const [, setTick] = useState(0);

  const clearSlide = useCallback(() => {
    for (const animation of runningRef.current) animation.cancel();
    runningRef.current = [];
    ghostRef.current?.replaceChildren();
    const live = liveRef.current;
    if (live) { live.style.transform = ''; live.style.opacity = ''; }
  }, []);

  /** Wisselt van periode mét verschuiving. `fromPx` = waar een veeg ophield. */
  const slide = useCallback((direction: SlideDirection, commit: () => void, fromPx = 0) => {
    const live = liveRef.current;
    const ghost = ghostRef.current;
    if (!live || !ghost || prefersReducedMotion()) { clearSlide(); commit(); return; }
    clearSlide();
    const copy = live.cloneNode(true) as HTMLElement;
    ghost.replaceChildren(copy);
    // Een verse kopie staat bovenaan: zonder deze regel springt het
    // vertrekkende beeld terug naar middernacht.
    const source = live.querySelectorAll<HTMLElement>(SLIDE_SCROLLERS);
    const target = copy.querySelectorAll<HTMLElement>(SLIDE_SCROLLERS);
    for (let i = 0; i < target.length; i++) {
      target[i].scrollTop = source[i]?.scrollTop ?? 0;
      target[i].scrollLeft = source[i]?.scrollLeft ?? 0;
    }
    // Het nieuwe beeld wacht net buiten beeld tot React het heeft opgebouwd.
    live.style.transform = direction === 0 ? '' : `translateX(${direction * 100}%)`;
    live.style.opacity = direction === 0 ? '0' : '';
    pendingRef.current = { direction, fromPx };
    commit();
    setTick(tick => tick + 1);
  }, [clearSlide]);

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const live = liveRef.current;
    const ghost = ghostRef.current;
    const copy = ghost?.firstElementChild as HTMLElement | null;
    if (!live || !ghost || !copy) { clearSlide(); return; }
    const { direction, fromPx } = pending;
    const options: KeyframeAnimationOptions = { duration: SLIDE_MS, easing: SLIDE_EASE, fill: 'both' };
    const fade: KeyframeAnimationOptions = { duration: SLIDE_FADE_MS, easing: 'ease-out', fill: 'both' };
    // Wisselen van weergave (dag ↔ week ↔ maand) schuift niet opzij maar zoomt
    // zachtjes in — dat leest als "dichterbij kijken", niet als "verderop".
    const enter = direction === 0
      ? live.animate([{ opacity: 0, transform: 'scale(1.015)' }, { opacity: 1, transform: 'scale(1)' }], fade)
      : live.animate([{ transform: `translateX(${direction * 100}%)`, opacity: .55 }, { transform: 'translateX(0)', opacity: 1 }], options);
    const leave = direction === 0
      ? copy.animate([{ opacity: 1 }, { opacity: 0 }], fade)
      : copy.animate([{ transform: `translateX(${fromPx}px)`, opacity: 1 }, { transform: `translateX(${-direction * 100}%)`, opacity: .3 }], options);
    runningRef.current = [enter, leave];
    void Promise.allSettled([enter.finished, leave.finished]).then(() => {
      if (runningRef.current[0] !== enter) return; // een nieuwere overgang nam het over
      clearSlide();
    });
  });

  useEffect(() => clearSlide, [clearSlide]);
  return { stageRef, liveRef, ghostRef, slide, clearSlide };
}

/* Vegen op een aanraakscherm: het beeld volgt je vinger — met weerstand, zodat
   je ziet dát je bladert zonder het scherm helemaal leeg te trekken — en bij
   loslaten neemt de verschuiving hierboven het over vanaf díe plek. Te kort
   geveegd? Dan veert het terug. Een overwegend verticale veeg scrollt gewoon. */
const SWIPE_DECIDE_PX = 12;
const SWIPE_MIN_PX = 46;
const SWIPE_DAMPING = .55;
const SWIPE_MAX_FRACTION = .34;

function useCalendarSwipe({ stageRef, liveRef, isBlocked, onNavigate }: {
  stageRef: { current: HTMLDivElement | null };
  liveRef: { current: HTMLDivElement | null };
  /** Loopt er iets anders (paneel open, sleep- of knijpgebaar)? Dan niet bladeren. */
  isBlocked: () => boolean;
  onNavigate: (direction: -1 | 1, fromPx: number) => void;
}) {
  const isBlockedRef = useRef(isBlocked);
  isBlockedRef.current = isBlocked;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let startX = 0, startY = 0, offset = 0;
    let tracking = false;
    let axis: 'x' | 'y' | null = null;

    function reset(animate: boolean) {
      const el = liveRef.current;
      if (el) {
        if (animate && offset !== 0) el.animate([{ transform: `translateX(${offset}px)` }, { transform: 'translateX(0)' }], { duration: 200, easing: 'ease-out' });
        el.style.transform = '';
      }
      offset = 0; tracking = false; axis = null;
    }
    function springBack() { reset(true); }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1 || isBlockedRef.current()) { reset(false); return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      offset = 0; axis = null; tracking = true;
    }
    function onTouchMove(e: TouchEvent) {
      if (!tracking) return;
      if (e.touches.length !== 1 || isBlockedRef.current()) { springBack(); return; }
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (axis === null) {
        if (Math.hypot(dx, dy) < SWIPE_DECIDE_PX) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.25 ? 'x' : 'y';
        if (axis === 'y') { tracking = false; return; }
        // Kan het rooster zélf zijwaarts? Dan is dát het gebaar, niet bladeren.
        const scroller = stage!.querySelector<HTMLElement>('.tb-scroll');
        if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) { tracking = false; axis = null; return; }
      }
      if (e.cancelable) e.preventDefault();
      const max = stage!.clientWidth * SWIPE_MAX_FRACTION;
      offset = Math.max(-max, Math.min(max, dx * SWIPE_DAMPING));
      const el = liveRef.current;
      if (el) el.style.transform = `translateX(${offset}px)`;
    }
    function onTouchEnd() {
      if (!tracking || axis !== 'x') { springBack(); return; }
      if (Math.abs(offset) / SWIPE_DAMPING < SWIPE_MIN_PX) { springBack(); return; }
      const from = offset;
      offset = 0; tracking = false; axis = null;
      onNavigateRef.current(from < 0 ? 1 : -1, from);
    }

    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', onTouchEnd, { passive: true });
    stage.addEventListener('touchcancel', springBack, { passive: true });
    return () => {
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
      stage.removeEventListener('touchend', onTouchEnd);
      stage.removeEventListener('touchcancel', springBack);
    };
  }, [stageRef, liveRef]);
}

/** Eén periode vooruit of achteruit, passend bij de gekozen weergave. */
function shiftAnchorForView(view: CalendarView, anchor: Date, direction: -1 | 1): Date {
  if (view === 'day') return addDays(anchor, direction);
  if (view === '3day') return addDays(anchor, direction * THREE_DAY_COUNT);
  if (view === 'month') return addMonths(anchor, direction);
  return addDays(anchor, direction * 7);
}

/** Volgt of de viewport smal genoeg is voor de mobiele agenda-ergonomie. */
function useIsMobile(): boolean {
  const query = `(max-width:${MOBILE_BREAKPOINT_PX}px)`;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(query);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return isMobile;
}

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
  const isMobile = useIsMobile();
  // Op een telefoon is een 7-koloms weekraster onwerkbaar (horizontaal scrollen).
  // Start daarom in dagweergave — één kolom die het scherm vult, zoals Google/Apple.
  const [view, setView] = useState<CalendarView>(() =>
    (typeof window !== 'undefined' && window.matchMedia(`(max-width:${MOBILE_BREAKPOINT_PX}px)`).matches) ? 'day' : 'week');
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
  const [newIcsUrl, setNewIcsUrl] = useState('');
  const [newIcsName, setNewIcsName] = useState('');
  // Boekingstool: "beschikbaarheid voor klant"-modus in de agenda. Je zet de modus
  // aan, tekent opties (concept-blokken) op het rooster en kiest PAS bij "Doorsturen"
  // de klant/agenda. De opties van al je actieve boekingslinks blijven als aparte
  // laag zichtbaar in de agenda (persistent, ook ná versturen).
  const [bookingMode, setBookingMode] = useState(false);
  const [bookingLinks, setBookingLinks] = useState<MeetingBookingLinkListItem[]>([]);
  const [showBookingOptions, setShowBookingOptions] = useState(true);
  const [agendaOptions, setAgendaOptions] = useState<{ id: string; starts_at: string; ends_at: string; status: string }[]>([]);
  const [draftSlots, setDraftSlots] = useState<{ startsAt: string; endsAt: string }[]>([]);
  const [showBookingSend, setShowBookingSend] = useState(false);
  const [bookingCreated, setBookingCreated] = useState<{ url: string; token: string; linkId: string } | null>(null);
  // Zoomstand van het tijdrooster (knijpen / Ctrl+wiel / +−). Wordt onthouden.
  const [zoom, setZoom] = useState<number>(() => (typeof window === 'undefined' ? 1 : readStoredZoom()));
  // Bump = "scroll het rooster opnieuw naar nu". Bladeren doet dat bewust niet.
  const [autoScrollKey, setAutoScrollKey] = useState(0);
  // In de maandweergave: de dag waarvan je de items bekijkt (Google-gedrag).
  const [monthDay, setMonthDay] = useState<Date | null>(null);
  const { stageRef, liveRef, ghostRef, slide, clearSlide } = useCalendarStage();

  const applyZoom = useCallback((next: number) => {
    const value = clampZoom(next);
    setZoom(value);
    try { window.localStorage.setItem(ZOOM_STORAGE_KEY, String(value)); } catch { /* privémodus: dan onthouden we het niet */ }
  }, []);

  // De toets-, wiel- en veeggebaren hangen aan langlopende listeners die `anchor`
  // niet in hun dep-lijst hebben (anders koppelen ze bij élke navigatie opnieuw
  // aan, midden in een gebaar). Ze lezen de huidige stand daarom via deze ref.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  const days = useMemo(() => calendarDaysForView(view, anchor), [view, anchor]);
  // Mobiele dagstrip (Google): de week rond de gekozen dag; tikken = die dag openen.
  const stripDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)), [anchor]);
  const rangeStart = useMemo(() => days[0].toISOString(), [days]);
  const rangeEnd = useMemo(() => addDays(days[days.length - 1], 1).toISOString(), [days]);
  // Het zichtbare tijdvenster in een ref. Callbacks als opslaan/verslepen worden
  // gememoïseerd zónder het venster in hun deps; zonder deze ref ververste zo'n
  // callback het venster van een eerder bekeken week en zette die events terug —
  // waardoor de agenda na "Opslaan" leeg leek tot je de pagina handmatig ververste.
  const rangeRef = useRef({ start: rangeStart, end: rangeEnd });
  rangeRef.current = { start: rangeStart, end: rangeEnd };
  // Volgnummer per ophaalactie: alleen het antwoord van de láátste aanvraag mag de
  // lijst zetten, zodat een traag antwoord van een vorige week een nieuwere niet overschrijft.
  const eventsRequestRef = useRef(0);
  // Google-stijl titel: "juli 2026" (met korte maanden als de week over een
  // maandgrens valt); de dagweergave toont de volledige datum.
  const calendarRangeLabel = useMemo(() => {
    if (view === 'day') return new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }).format(anchor);
    if (view === 'month') return monthLabelNl(anchor);
    const first = days[0];
    const last = days[days.length - 1];
    const shortMonth = (d: Date) => new Intl.DateTimeFormat('nl-NL', { month: 'short' }).format(d).replace('.', '');
    // "3 dagen" toont het dagbereik zelf ("27 – 29 juli 2026"); week/lijst de maand.
    if (view === '3day') {
      if (isSameMonth(first, last)) return `${first.getDate()} – ${last.getDate()} ${monthLabelNl(first)}`;
      if (first.getFullYear() === last.getFullYear()) return `${first.getDate()} ${shortMonth(first)} – ${last.getDate()} ${shortMonth(last)} ${last.getFullYear()}`;
      return `${first.getDate()} ${shortMonth(first)} ${first.getFullYear()} – ${last.getDate()} ${shortMonth(last)} ${last.getFullYear()}`;
    }
    if (isSameMonth(first, last)) return monthLabelNl(first);
    if (first.getFullYear() === last.getFullYear()) return `${shortMonth(first)} – ${shortMonth(last)} ${last.getFullYear()}`;
    return `${shortMonth(first)} ${first.getFullYear()} – ${shortMonth(last)} ${last.getFullYear()}`;
  }, [anchor, days, view]);
  // Weeknummer-chip naast de titel (Google toont die in de weekweergave).
  const calendarWeekNumber = view === 'week' || view === 'list' ? isoWeekNumber(days[0]) : null;
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
  // Vooruit inladen: staat de huidige periode er eenmaal, dan halen we stilletjes
  // de vorige en de volgende op. Daardoor is bladeren meteen gevuld — geen
  // "laden…" en geen leeg rooster dat halverwege de verschuiving nog volloopt.
  useEffect(() => {
    if (mode !== 'agenda') return;
    const timer = window.setTimeout(() => {
      for (const direction of [1, -1] as const) {
        const neighbour = calendarDaysForView(view, shiftAnchorForView(view, anchor, direction));
        const start = neighbour[0].toISOString();
        const end = addDays(neighbour[neighbour.length - 1], 1).toISOString();
        if (getCachedCalendarEvents(organizationId, start, end)) continue;
        void listCalendarEventsCached(organizationId, start, end).catch(() => { /* stil: dit is alleen vooruitkijken */ });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [organizationId, mode, view, anchor]);
  useEffect(() => { if (mode === 'settings') setShowConnections(true); }, [mode]);
  // Zakt het scherm naar telefoonbreedte terwijl je in de (brede) weekweergave zit?
  // Schakel dan naar de dagweergave, die wél op een telefoon past.
  useEffect(() => { if (isMobile && view === 'week') changeView('day'); }, [isMobile]); // eslint-disable-line react-hooks/exhaustive-deps
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

  async function refreshAll(opts?: { fresh?: boolean }) {
    setLoading(true); setError(null); setMessage(null);
    try { const n = await loadCalendarIntegrations(organizationId); setIntegrations(n); if (mode === 'agenda') await refreshEventsOnly(opts); }
    catch (err) { setError(err instanceof Error ? err.message : 'Agenda-koppelingen laden mislukt.'); }
    finally { setLoading(false); }
  }
  // `fresh` = na een mutatie of handmatig verversen: cache leegmaken en live ophalen.
  // Zonder `fresh` (bij navigeren) tonen we een nog verse cache direct — geen spinner,
  // geen netwerk — en dedupliceert de laag eronder de dubbele fetch bij het openen.
  // `silent` = na een mutatie die al optimistisch in beeld staat: wel opnieuw
  // ophalen, maar zónder laadindicator, zodat het rooster niet zichtbaar
  // "knippert" nadat je net hebt opgeslagen.
  const refreshEventsOnly = useCallback(async (opts?: { fresh?: boolean; silent?: boolean }) => {
    // Altijd het venster dat NU in beeld staat (via de ref), nooit dat van de
    // render waarin een aanroepende callback toevallig gemaakt is.
    const { start, end } = rangeRef.current;
    const seq = ++eventsRequestRef.current;
    if (opts?.fresh) {
      invalidateCalendarEventsCache(organizationId);
    } else {
      // Ook de laadindicator vrijgeven: een nog lopende oudere aanvraag wordt
      // straks door de volgnummer-check genegeerd en zet 'm dus niet meer terug.
      const cached = getCachedCalendarEvents(organizationId, start, end);
      if (cached) { setEvents(cached); setError(null); setEventsLoading(false); return; }
    }
    if (!opts?.silent) setEventsLoading(true);
    setError(null);
    try {
      const rows = await listCalendarEventsCached(organizationId, start, end);
      if (seq !== eventsRequestRef.current) return; // een nieuwere aanvraag is leidend
      setEvents(rows);
    }
    catch (err) { if (seq === eventsRequestRef.current) setError(err instanceof Error ? err.message : 'Agenda-events laden mislukt.'); }
    finally { if (seq === eventsRequestRef.current && !opts?.silent) setEventsLoading(false); }
  }, [organizationId]);
  async function connect(provider: CalendarProvider) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try { window.location.assign(await getCalendarOAuthUrl(organizationId, provider, window.location.href.split('?')[0])); }
    catch (err) { setError(err instanceof Error ? err.message : 'OAuth starten mislukt.'); setLoading(false); }
  }
  async function refreshSources(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    setLoading(true); setError(null); setMessage(null);
    try { const n = await refreshCalendarSources(organizationId, connectionId); setIntegrations(n); setMessage("Agenda\u2019s opnieuw opgehaald."); if (mode === 'agenda') await refreshEventsOnly({ fresh: true }); }
    catch (err) { setError(err instanceof Error ? err.message : "Agenda\u2019s ophalen mislukt."); }
    finally { setLoading(false); }
  }
  async function disconnect(connectionId: string) {
    if (!canWrite) { setError('Je hebt alleen-lezen toegang tot deze organisatie.'); return; }
    if (!confirm('Deze persoonlijke agenda-koppeling loskoppelen?')) return;
    setLoading(true); setError(null); setMessage(null);
    try { await disconnectCalendarConnection(organizationId, connectionId); setIntegrations(await loadCalendarIntegrations(organizationId)); setMessage('Agenda-koppeling losgekoppeld.'); if (mode === 'agenda') await refreshEventsOnly({ fresh: true }); }
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
      if (mode === 'agenda' && (key === 'sync_enabled' || key === 'visibility')) await refreshEventsOnly({ fresh: true });
      if (key === 'visibility') setMessage(upd.visibility === 'organization' ? 'Agenda gedeeld met de organisatie.' : 'Agenda staat weer privé.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Instelling bijwerken mislukt.'); }
  }

  function makeDefaultTimes() {
    const s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    const e = new Date(s); e.setHours(e.getHours() + 1);
    return { startsAt: toInputDateTime(s), endsAt: toInputDateTime(e) };
  }

  useEffect(() => {
    if (mode !== 'agenda' || !canWrite) return;
    let alive = true;
    listBookingLinks(organizationId).then(rows => { if (alive) setBookingLinks(rows); }).catch(() => {});
    return () => { alive = false; };
  }, [organizationId, mode, canWrite]);

  // Persistente boekingsopties-laag: alle slots van actieve links in het zichtbare bereik.
  const reloadAgendaOptions = useCallback(async () => {
    if (mode !== 'agenda' || !canWrite) { setAgendaOptions([]); return; }
    try {
      const slots = await listBookingSlotsInRange(organizationId, rangeStart, rangeEnd);
      setAgendaOptions(slots.map(s => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status })));
    } catch { /* laat de laag leeg bij een fout */ }
  }, [organizationId, mode, canWrite, rangeStart, rangeEnd]);

  useEffect(() => { void reloadAgendaOptions(); }, [reloadAgendaOptions]);

  // Overlay = aangeboden opties (alleen-lezen, alle actieve links) + concept-blokken (verwijderbaar) tijdens tekenen.
  const bookingOverlay = useMemo<BookingOverlaySlot[]>(() => {
    const options: BookingOverlaySlot[] = showBookingOptions ? agendaOptions.map(s => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status, removable: false })) : [];
    const drafts: BookingOverlaySlot[] = bookingMode ? draftSlots.map(d => ({ id: d.startsAt, starts_at: d.startsAt, ends_at: d.endsAt, status: 'open', removable: true })) : [];
    return [...options, ...drafts];
  }, [showBookingOptions, agendaOptions, bookingMode, draftSlots]);

  const handleRemoveBookingSlot = useCallback((slotId: string) => {
    // In de agenda zijn alleen concept-blokken verwijderbaar (id = starttijd); aangeboden opties beheer je in de Boekingslinks-pagina.
    setDraftSlots(prev => prev.filter(d => d.startsAt !== slotId));
  }, []);

  const handleSlotSelect = useCallback((day: Date, startSlot: number, endSlot: number) => {
    const st = slotToTime(startSlot);
    const et = slotToTime(endSlot + 1);
    const sd = new Date(day); sd.setHours(st.hour, st.minutes, 0, 0);
    const ed = new Date(day); ed.setHours(et.hour, et.minutes, 0, 0);
    if (bookingMode) {
      // Concept-optie: bewaren tot je 'm doorstuurt naar de klant.
      setDraftSlots(prev => [...prev, { startsAt: sd.toISOString(), endsAt: ed.toISOString() }].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      return;
    }
    setEditingOriginal(null);
    setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: toInputDateTime(sd), endsAt: toInputDateTime(ed), clientId: '', projectId: '', trackTime: true, editingEventId: '', meetingUrl: '', addConference: false }));
    setShowCreatePanel(true);
  }, [bookingMode]);

  // Klikken op een lege plek in de maandweergave maakt een afspraak op die dag —
  // net als Google, dat daar een snelinvoer opent. Standaardduur: het eerstvolgende
  // hele uur (of 9:00 op een andere dag dan vandaag), één uur lang.
  const startCreateOnDay = useCallback((day: Date) => {
    const now = new Date();
    const start = new Date(day);
    if (isSameDay(day, now)) { start.setHours(now.getHours() + 1, 0, 0, 0); }
    else { start.setHours(9, 0, 0, 0); }
    const end = new Date(start); end.setHours(start.getHours() + 1);
    setEditingOriginal(null);
    setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: toInputDateTime(start), endsAt: toInputDateTime(end), clientId: '', projectId: '', trackTime: true, recurrenceFreq: '', recurrenceUntil: '', editingEventId: '', attendees: [], meetingUrl: '', addConference: false }));
    setShowCreatePanel(true);
  }, []);

  // Concept-opties doorsturen: link aanmaken + blokken koppelen, daarna deel-URL tonen.
  const submitBookingSend = useCallback(async (p: { sourceId: string; clientId: string; title: string; maxTotalBookings: number; maxPerWeek: number; introText: string; inviteMessage: string; meetingUrl: string; autoConference: boolean }) => {
    setError(null);
    try {
      const res = await createBookingLink(organizationId, {
        sourceId: p.sourceId, clientId: p.clientId || null, title: p.title,
        introText: p.introText || null, inviteMessage: p.inviteMessage || null, meetingUrl: p.meetingUrl || null,
        maxTotalBookings: p.maxTotalBookings, maxPerWeek: p.maxPerWeek, autoConference: p.autoConference,
      });
      if (draftSlots.length) await addBookingSlots(organizationId, res.link.id, draftSlots.map(d => ({ startsAt: d.startsAt, endsAt: d.endsAt })));
      setBookingCreated({ url: res.booking_url, token: res.token, linkId: res.link.id });
      setShowBookingSend(false);
      setDraftSlots([]);
      setBookingMode(false);
      setShowBookingOptions(true);
      listBookingLinks(organizationId).then(setBookingLinks).catch(() => {});
      await reloadAgendaOptions(); // opties blijven zichtbaar in de agenda
    } catch (e) { setError(e instanceof Error ? e.message : 'Boekingslink aanmaken mislukt.'); }
  }, [organizationId, draftSlots, reloadAgendaOptions]);

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
      // Genodigden op elke agenda: native via iMIP-mail, Google/Microsoft via de provider.
      attendees: newEvent.attendees.map(a => ({ email: a.email, name: a.name || null })),
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
      refreshEventsOnly({ fresh: true }).catch(() => {});
    } catch (err) { setError(err instanceof Error ? err.message : 'Opslaan mislukt.'); }
    finally { setLoading(false); }
  }

  // Slaat wijzigingen uit het detailpaneel op — bewerken gebeurt direct in het
  // paneel rechts (geen losse popup meer). Verhuist de klant/project-koppeling
  // mee als de starttijd wijzigt (die zit in de unieke sleutel).
  const saveEventEdits = useCallback(async (event: CalendarExternalEvent, form: EventDetailForm) => {
    if (!eventIsEditable(event)) return;
    const title = form.title.trim();
    if (!title) throw new Error('Geef de afspraak een titel.');
    const sIso = form.allDay ? `${form.startLocal.slice(0, 10)}T00:00:00.000Z` : inputDateTimeToIso(form.startLocal);
    const eIso = form.allDay ? `${form.endLocal.slice(0, 10)}T00:00:00.000Z` : inputDateTimeToIso(form.endLocal);
    if (!form.allDay && new Date(eIso).getTime() <= new Date(sIso).getTime()) throw new Error('Eindtijd moet na starttijd liggen.');
    if (form.allDay && dateKeyFromValue(eIso) < dateKeyFromValue(sIso)) throw new Error('Einddatum mag niet voor startdatum liggen.');
    const isNative = event.provider === 'native';
    const recurrence: EventRecurrence | null = isNative && form.recurrenceFreq
      ? { freq: form.recurrenceFreq, until: form.recurrenceUntil ? `${form.recurrenceUntil}T23:59:59.000Z` : null }
      : null;
    const input = {
      sourceId: event.source_id,
      title,
      description: form.description.trim() || null,
      location: form.location.trim() || null,
      startsAt: sIso, endsAt: eIso, allDay: form.allDay,
      recurrence,
      attendees: form.attendees.map(a => ({ email: a.email, name: a.name || null })),
      // Automatisch genereren kan alleen bij Google/Microsoft; native accepteert alleen een geplakte link.
      meetingUrl: form.addConference && !isNative ? null : (form.meetingUrl.trim() || null),
      addConference: !isNative && form.addConference,
    };
    const updated = await updateCalendarEvent(organizationId, eventRef(event), input);
    const startChanged = new Date(event.starts_at).getTime() !== new Date(updated.starts_at).getTime();
    if (startChanged) {
      const link = data.calendarEventLinks.find(l => calendarEventLinkMatchesEvent(l, event)) ?? null;
      if (link && (link.client_id || link.project_id)) {
        await onSetEventLink(event, null, null);
        await onSetEventLink(updated, link.client_id, link.project_id, link.track_time);
      }
    }
    // Het bijgewerkte item meteen in het rooster verwerken en terug naar de
    // agenda: opslaan is klaar, dus het paneel hoeft niet open te blijven.
    // Het verse ophalen loopt stil op de achtergrond door (geen spinner, geen
    // wachttijd) — wat je ziet staat al goed.
    const previousKey = eventIdentityKey(event);
    setEvents(prev => prev.map(e => eventIdentityKey(e) === previousKey ? updated : e));
    setSelectedEvent(null);
    setMessage('Afspraak bijgewerkt.');
    refreshEventsOnly({ fresh: true, silent: true }).catch(() => {});
  }, [eventIsEditable, organizationId, data.calendarEventLinks, onSetEventLink, refreshEventsOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  async function removeEvent(event: CalendarExternalEvent) {
    if (!eventIsEditable(event)) return;
    if (!confirm('Deze afspraak verwijderen?')) return;
    setLoading(true); setError(null); setMessage(null);
    try {
      await deleteCalendarEvent(organizationId, eventRef(event));
      const removedKey = eventIdentityKey(event);
      setEvents(prev => prev.filter(e => eventIdentityKey(e) !== removedKey));
      setSelectedEvent(null);
      setMessage('Afspraak verwijderd.');
      await refreshEventsOnly({ fresh: true });
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
    const originalKey = eventIdentityKey(event);
    setEvents(prev => prev.map(e => eventIdentityKey(e) === originalKey ? { ...e, starts_at: startIso, ends_at: endIso } : e));
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
    } else if (!isNative && event.attendees) {
      // Externe genodigden meesturen zodat ze niet gewist worden bij verplaatsen.
      attendees = event.attendees.map(a => ({ email: a.email, name: a.name }));
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
      // `events` staat al optimistisch goed; alleen het geopende detailpaneel moet
      // nog naar het bijgewerkte item wijzen (dat draagt nog de oude starttijd).
      setSelectedEvent(prev => (prev && eventIdentityKey(prev) === originalKey) ? updated : prev);
      // Stil bijwerken: het blok staat al op de nieuwe plek, dus een spinner of
      // wachttijd zou het slepen alleen maar stroef laten aanvoelen.
      refreshEventsOnly({ fresh: true, silent: true }).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verplaatsen mislukt.');
      await refreshEventsOnly({ fresh: true }); // draai de optimistische verschuiving terug
    }
  }, [eventIsEditable, organizationId, data.calendarEventLinks, onSetEventLink, refreshEventsOnly]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (mode === 'agenda') await refreshEventsOnly({ fresh: true });
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
      if (mode === 'agenda') await refreshEventsOnly({ fresh: true });
      setMessage('Agenda verwijderd.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Verwijderen mislukt.'); }
    finally { setLoading(false); }
  }

  // ── Agenda's via link (iCal/ICS-abonnementen) ─────────────────────────────
  async function addIcsSubscription(e: FormEvent) {
    e.preventDefault();
    if (!canWrite) { setError('Je hebt alleen-lezen toegang.'); return; }
    const url = newIcsUrl.trim();
    if (!url) { setError('Plak de agenda-link (iCal/ICS-URL).'); return; }
    setLoading(true); setError(null); setMessage(null);
    try {
      const { count, warning } = await createIcsSubscription(organizationId, { url, name: newIcsName.trim() || 'Externe agenda' });
      setNewIcsUrl(''); setNewIcsName('');
      setIntegrations(await loadCalendarIntegrations(organizationId));
      if (mode === 'agenda') await refreshEventsOnly({ fresh: true });
      setMessage(warning
        ? `Agenda toegevoegd, maar ophalen lukte nog niet: ${warning}`
        : `Agenda toegevoegd — ${count} afspra${count === 1 ? 'ak' : 'ken'} opgehaald.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Agenda-link toevoegen mislukt.'); }
    finally { setLoading(false); }
  }

  async function refreshIcs(source: CalendarSource) {
    setLoading(true); setError(null); setMessage(null);
    try {
      const { count } = await refreshIcsSubscription(organizationId, source.id);
      setIntegrations(await loadCalendarIntegrations(organizationId));
      if (mode === 'agenda') await refreshEventsOnly({ fresh: true });
      setMessage(`Ververst — ${count} afspra${count === 1 ? 'ak' : 'ken'}.`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Verversen mislukt.'); }
    finally { setLoading(false); }
  }

  async function removeIcs(source: CalendarSource) {
    if (!confirm(`Agenda "${source.name}" verwijderen? De afspraken verdwijnen uit ResoFly; de originele agenda blijft ongemoeid.`)) return;
    setLoading(true); setError(null); setMessage(null);
    try {
      await deleteIcsSubscription(organizationId, source.id);
      setIntegrations(await loadCalendarIntegrations(organizationId));
      if (mode === 'agenda') await refreshEventsOnly({ fresh: true });
      setMessage('Agenda verwijderd.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Verwijderen mislukt.'); }
    finally { setLoading(false); }
  }

  function tasksForDay(day: Date) { return data.tasks.filter(t => t.status !== 'done' && t.end_date && isSameDay(new Date(`${t.end_date}T12:00:00`), day)); }
  function eventsForDay(day: Date) { return events.filter(ev => eventOverlapsDay(ev, day)).sort((a, b) => a.starts_at.localeCompare(b.starts_at)); }

  function changeView(nextView: CalendarView) {
    if (nextView === view) return;
    slide(0, () => {
      setView(nextView);
      setMonthDay(nextView === 'month' && isMobile ? startOfDay(new Date()) : null);
      setAutoScrollKey(key => key + 1);
      setAnchor(prev => {
        if (nextView === 'month') return startOfMonth(prev);
        if (nextView === 'week' || nextView === 'list') return startOfWeek(prev);
        return startOfDay(prev);
      });
    });
  }

  /** `fromPx` = de plek waar een veeg ophield; van daar loopt de verschuiving door. */
  function movePeriod(direction: -1 | 1, fromPx = 0) {
    const next = shiftAnchorForView(view, anchorRef.current, direction);
    slide(direction, () => {
      setAnchor(next);
      // Op de telefoon houdt de maand altijd een gekozen dag (met zijn lijstje
      // eronder); anders zou het paneel bij elke maandwissel weg- en terugklappen.
      setMonthDay(view === 'month' && isMobile ? startOfMonth(next) : null);
    }, fromPx);
  }

  function openDay(day: Date) {
    slide(0, () => {
      setAnchor(startOfDay(day));
      setView('day');
      setMonthDay(null);
      setAutoScrollKey(key => key + 1);
    });
  }

  function goToday() {
    const today = startOfDay(new Date());
    // Staat vandaag al in beeld? Dan hoeft er niets te schuiven.
    const shown = calendarDaysForView(view, anchorRef.current);
    const direction: SlideDirection = shown.some(d => isSameDay(d, today)) ? 0 : today.getTime() > shown[0].getTime() ? 1 : -1;
    slide(direction, () => {
      setAnchor(today);
      setMonthDay(view === 'month' ? today : null);
      setAutoScrollKey(key => key + 1);
    });
  }

  // ↑/↓ zoomt in/uit langs dag → 3 dagen → week → maand (lijst blijft via 'l').
  function cycleView(direction: -1 | 1) {
    const order: CalendarView[] = ['day', '3day', 'week', 'month'];
    const current = order.indexOf(view);
    const base = current === -1 ? order.indexOf('week') : current;
    const next = order[Math.min(order.length - 1, Math.max(0, base + direction))];
    if (next !== view) changeView(next);
  }

  // Sneltoetsen voor snelle navigatie (Google-stijl): ←/→ vorige/volgende
  // periode, ↑/↓ zoomt dag↔week↔maand, T/V vandaag, D/W/M/L weergaven en
  // Escape sluit een openstaand paneel. Genegeerd tijdens typen in formulieren.
  useEffect(() => {
    if (mode !== 'agenda') return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (showBookingSend) { setShowBookingSend(false); return; }
        if (bookingCreated) { setBookingCreated(null); return; }
        if (logTimeEvent) { setLogTimeEvent(null); return; }
        if (showCreatePanel) { setShowCreatePanel(false); setEditingOriginal(null); return; }
        if (selectedEvent) { setSelectedEvent(null); return; }
        return;
      }
      if (showCreatePanel || selectedEvent || showBookingSend || bookingCreated || logTimeEvent) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); movePeriod(-1); break;
        case 'ArrowRight': e.preventDefault(); movePeriod(1); break;
        case 'ArrowUp': e.preventDefault(); cycleView(-1); break;
        case 'ArrowDown': e.preventDefault(); cycleView(1); break;
        case 't': case 'T': case 'v': case 'V': e.preventDefault(); goToday(); break;
        case 'd': case 'D': e.preventDefault(); changeView('day'); break;
        case '3': e.preventDefault(); changeView('3day'); break;
        case 'w': case 'W': e.preventDefault(); changeView('week'); break;
        case 'm': case 'M': e.preventDefault(); changeView('month'); break;
        case 'l': case 'L': e.preventDefault(); changeView('list'); break;
        // In-/uitzoomen op het tijdrooster, zoals in een kaart of tekenprogramma.
        case '+': case '=': if (isTimeGridView(view)) { e.preventDefault(); applyZoom(zoom * ZOOM_STEP); } break;
        case '-': case '_': if (isTimeGridView(view)) { e.preventDefault(); applyZoom(zoom / ZOOM_STEP); } break;
        case '0': if (isTimeGridView(view)) { e.preventDefault(); applyZoom(1); } break;
        default: break;
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, view, zoom, isMobile, showCreatePanel, selectedEvent, showBookingSend, bookingCreated, logTimeEvent]); // eslint-disable-line

  // Muiswiel navigeert door periodes (net als de pijltjes). In dag/week scrollt het
  // wiel eerst het tijdrooster; pas aan de boven-/onderrand springt het naar de
  // vorige/volgende periode ("blijf scrollen om naar de volgende week te gaan").
  // In de maandweergave (geen interne scroll) springt elk wieltje meteen een maand.
  // Een korte vergrendeling ontdubbelt trackpad-momentum tot één sprong per gebaar.
  const mainCardRef = useRef<HTMLDivElement | null>(null);
  const wheelLockRef = useRef(0);
  useEffect(() => {
    if (mode !== 'agenda') return;
    const el = mainCardRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (showCreatePanel || selectedEvent || bookingMode) return;
      // Ctrl/⌘ + wiel is zoomen; dat handelt het rooster zelf af.
      if (e.ctrlKey || e.metaKey) return;
      if (view === 'list') return; // de lijst scrollt gewoon verticaal
      // Horizontaal vegen op een trackpad bladert — maar alleen als het rooster
      // zelf niet zijwaarts te scrollen valt (breed weekcanvas op een klein scherm).
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const scroller = el!.querySelector<HTMLElement>('.tb-scroll');
        if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) return;
        if (Math.abs(e.deltaX) < 8) return;
        e.preventDefault();
        const now = Date.now();
        if (now < wheelLockRef.current) return;
        wheelLockRef.current = now + 450;
        movePeriod(e.deltaX > 0 ? 1 : -1);
        return;
      }
      if (e.deltaY === 0) return;
      const dir: -1 | 1 = e.deltaY > 0 ? 1 : -1;
      // Maand op mobiel is een natuurlijke scroll-lijst — die niet kapen.
      if (view === 'month' && window.innerWidth <= 900) return;
      // Dag/3 dagen/week: respecteer de interne tijdscroll; navigeer pas aan de rand.
      if (isTimeGridView(view)) {
        const scroller = el!.querySelector<HTMLElement>('.tb-scroll');
        if (scroller) {
          const atTop = scroller.scrollTop <= 1;
          const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
          if (dir === 1 && !atBottom) return; // laat het rooster naar beneden scrollen
          if (dir === -1 && !atTop) return;   // laat het rooster naar boven scrollen
        }
      }
      e.preventDefault();
      const now = Date.now();
      if (now < wheelLockRef.current) return; // binnen de ontdubbel-vergrendeling
      wheelLockRef.current = now + 450;
      movePeriod(dir);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode, view, isMobile, showCreatePanel, selectedEvent, bookingMode]); // eslint-disable-line

  // Vegen op een aanraakscherm bladert (zie `useCalendarSwipe`). Onthoud wannéér
  // er geveegd is: de tik die de browser daarna nog kan afvuren mag geen dag
  // openen of afspraak aanmaken.
  const swipedAtRef = useRef(0);
  useCalendarSwipe({
    stageRef, liveRef,
    isBlocked: () => Boolean(showCreatePanel || selectedEvent || bookingMode || stageRef.current?.querySelector('.tb-touch-gesture,.tb-pinching')),
    onNavigate: (direction, fromPx) => { swipedAtRef.current = Date.now(); movePeriod(direction, fromPx); },
  });

  const previousLabel = view === 'day' ? 'Vorige dag' : view === '3day' ? 'Vorige 3 dagen' : view === 'month' ? 'Vorige maand' : 'Vorige week';
  const nextLabel = view === 'day' ? 'Volgende dag' : view === '3day' ? 'Volgende 3 dagen' : view === 'month' ? 'Volgende maand' : 'Volgende week';

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

  const icsSources = integrations.sources.filter(s => s.provider === 'ics');
  const icsSourcesSection = (
    <section className="calendar-section connections-panel" id="calendar-ics">
      <div className="calendar-section-head">
        <div>
          <h3>Agenda's via link</h3>
          <p>Abonneer je read-only op een externe agenda met een iCal/ICS-link — bijvoorbeeld de "geheime" iCal-link uit Google Calendar (Instellingen → geheime adres in iCal-formaat) of een gepubliceerde .ics uit Outlook. De afspraken lopen automatisch mee en worden periodiek ververst.</p>
        </div>
      </div>
      {canWrite && (
        <form className="native-calendar-create" onSubmit={addIcsSubscription} style={{ display: 'flex', gap: 8, margin: '8px 0 12px', flexWrap: 'wrap' }}>
          <Input value={newIcsUrl} onChange={e => setNewIcsUrl(e.target.value)} placeholder="https://…/basic.ics of webcal://…" style={{ flex: '2 1 260px' }} />
          <Input value={newIcsName} onChange={e => setNewIcsName(e.target.value)} placeholder="Naam (optioneel)" style={{ flex: '1 1 140px' }} />
          <Button variant="primary" disabled={loading || !newIcsUrl.trim()}><ExternalLink size={14} /> Link toevoegen</Button>
        </form>
      )}
      {icsSources.length === 0 ? (
        <div className="calendar-empty">Nog geen agenda via link. Plak een iCal/ICS-URL om een externe agenda mee te laten lopen.</div>
      ) : (
        <div className="source-list">
          {icsSources.map(src => {
            const owns = canManageSource(src);
            return (
              <div className="source-row privacy" key={src.id}>
                <span className="source-dot" style={{ background: src.color || '#0891b2' }} />
                <div className="source-info">
                  <strong>{src.name} <span className="privacy-pill">alleen-lezen</span></strong>
                  <span>{src.feed_last_error
                    ? <span className="calendar-help">Laatste ophaal mislukte: {src.feed_last_error}</span>
                    : src.feed_last_synced_at ? `Laatst ververst: ${new Date(src.feed_last_synced_at).toLocaleString('nl-NL')}` : 'Nog niet ververst'}</span>
                  <span>{src.visibility === 'organization' ? 'Gedeeld met de organisatie' : 'Privé'}{owns ? '' : ' · van een teamlid'}</span>
                </div>
                {owns && (
                  <>
                    <label className="toggle-row"><input type="checkbox" checked={src.sync_enabled} onChange={() => toggleSource(src, 'sync_enabled')} /> Tonen</label>
                    <label className="toggle-row"><input type="checkbox" checked={src.visibility === 'organization'} onChange={() => toggleSource(src, 'visibility')} /> Delen met team</label>
                    <Button onClick={() => refreshIcs(src)} disabled={loading}><RefreshCcw size={13} /> Ververs nu</Button>
                    <Button variant="danger" onClick={() => removeIcs(src)} disabled={loading}><Trash2 size={13} /> Verwijder</Button>
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
          {/* Deze pagina hangt onder Instellingen (tabblad Agenda); die pagina
              draagt de h2 en de uitleg, dus hier een h3 zonder herhaling. */}
          <h3>Agenda's en koppelingen</h3>
          <p>Agenda's blijven standaard privé en worden alleen gedeeld als je dat expliciet aanzet.</p>
          {!canWrite && <p className="calendar-help">Je hebt alleen-lezen toegang.</p>}
        </div>
        <div className="calendar-actions">
          <Button variant="primary" onClick={() => connect('google')} disabled={loading || !canWrite}>Google koppelen</Button>
          <Button variant="primary" onClick={() => connect('microsoft')} disabled={loading || !canWrite}>Microsoft koppelen</Button>
          <Button onClick={() => refreshAll({ fresh: true })} disabled={loading}><RefreshCcw size={14} /> Ververs</Button>
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
      {icsSourcesSection}
      <PhoneCalendarCard organizationId={organizationId} />
      {connectionsSection}
    </div>;
  }

  return <div className="calendar-page calendar-agenda-page">
    {error && <div className="error">{error}</div>}
    {message && <div className="success">{message}</div>}

    {/* Calendar view */}
    <div className={`calendar-main-card calendar-main-card-${view}`} id="calendar-agenda" ref={mainCardRef}>
      <div className="calendar-toolbar calendar-toolbar-premium">
        <div className="calendar-period-controls">
          <Button onClick={goToday} title="Naar vandaag (T)">Vandaag</Button>
          <Button className="calendar-nav-btn" onClick={() => movePeriod(-1)} title={`${previousLabel} (←)`} aria-label={previousLabel}><ChevronLeft size={18} /></Button>
          <Button className="calendar-nav-btn" onClick={() => movePeriod(1)} title={`${nextLabel} (→)`} aria-label={nextLabel}><ChevronRight size={18} /></Button>
        </div>
        <div className="calendar-range-block">
          <div className="calendar-range">{calendarRangeLabel}</div>
          {calendarWeekNumber != null && <span className="calendar-week-chip">Week {calendarWeekNumber}</span>}
          {eventsLoading && <span className="calendar-loading-hint">laden…</span>}
        </div>
        <div className="calendar-toolbar-right">
          {isTimeGridView(view) && canWrite && writeableSources.length > 0 && !bookingMode && (
            <>
              <Button onClick={() => { setBookingMode(true); setDraftSlots([]); }} title="Beschikbaarheid voor klant — teken blokken en stuur ze als boekingsopties door">
                <CalendarPlus size={14} /> <span className="calendar-availability-label">Beschikbaarheid</span>
              </Button>
              {bookingLinks.some(l => l.status === 'active') && (
                <label className="calendar-options-toggle" title="Toon aangeboden boekingsopties in de agenda">
                  <input type="checkbox" checked={showBookingOptions} onChange={e => setShowBookingOptions(e.target.checked)} /> <span>Opties</span>
                </label>
              )}
            </>
          )}
          <Button className="calendar-link-btn" onClick={() => refreshAll({ fresh: true })} disabled={loading || eventsLoading} title="Ververs agenda's" aria-label="Ververs agenda's"><RefreshCcw size={14} /></Button>
          <div className="tb-view-tog calendar-view-tabs" aria-label="Agendaweergave">
            <button className={`tb-vbtn${view === 'day' ? ' active' : ''}`} onClick={() => changeView('day')} title="Dagweergave (D)"><CalendarDays size={14} /><span>Dag</span></button>
            <button className={`tb-vbtn${view === '3day' ? ' active' : ''}`} onClick={() => changeView('3day')} title="3-daagse weergave (3)"><Columns3 size={14} /><span>3 dagen</span></button>
            <button className={`tb-vbtn${view === 'week' ? ' active' : ''}`} onClick={() => changeView('week')} title="Weekweergave (W)"><Clock size={14} /><span>Week</span></button>
            <button className={`tb-vbtn${view === 'month' ? ' active' : ''}`} onClick={() => changeView('month')} title="Maandweergave (M)"><CalendarDays size={14} /><span>Maand</span></button>
            <button className={`tb-vbtn${view === 'list' ? ' active' : ''}`} onClick={() => changeView('list')} title="Lijstweergave (L)"><LayoutList size={14} /><span>Lijst</span></button>
          </div>
        </div>
      </div>

      {isTimeGridView(view) && bookingMode && (
        <div className="calendar-toolbar calendar-booking-toolbar">
          <span className="calendar-range-label">Opties tekenen</span>
          <span className="muted" style={{ fontSize: 13 }}>Sleep op het rooster om opties te maken ({draftSlots.length} gekozen) · klik een concept-blok om het te verwijderen.</span>
          <Button variant="primary" disabled={draftSlots.length === 0} onClick={() => setShowBookingSend(true)}>Doorsturen naar klant…</Button>
          {draftSlots.length > 0 && <Button onClick={() => setDraftSlots([])}>Wissen</Button>}
          <Button onClick={() => { setBookingMode(false); setDraftSlots([]); }}>Sluiten</Button>
        </div>
      )}

      {/* Mobiele dagstrip (Google): de weekdagen als tikbare rondjes boven het
          dagrooster — de gekozen dag is gevuld, vandaag kleurt goud. */}
      {isMobile && (view === 'day' || view === '3day') && !bookingMode && (
        <div className="cal-daystrip" aria-label="Dag kiezen">
          {stripDays.map(d => {
            // In "3 dagen" zijn alle zichtbare dagen actief; tikken zet de eerste dag.
            const active = days.some(shown => isSameDay(shown, d));
            const isToday = isSameDay(d, new Date());
            return (
              <button
                type="button"
                key={formatISODate(d)}
                className={`cal-daystrip-day${active ? ' is-active' : ''}${isToday ? ' is-today' : ''}`}
                onClick={() => setAnchor(startOfDay(d))}
                aria-current={active ? 'date' : undefined}
              >
                <span className="cds-name">{NARROW_DAY_FMT.format(d)}</span>
                <span className="cds-num">{d.getDate()}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Het "podium": hierbinnen schuift de oude periode eruit terwijl de nieuwe
          er inschuift. `.cal-stage-ghost` blijft leeg tot er een overgang loopt. */}
      <div className="cal-stage" ref={stageRef}
        onClickCapture={e => {
          // Na een veeg mag de tik eronder geen dag openen of afspraak aanmaken.
          if (Date.now() - swipedAtRef.current < 350) { e.preventDefault(); e.stopPropagation(); }
        }}>
        <div className="cal-stage-live" ref={liveRef}>
          {isTimeGridView(view) ? (
            <TimeBlockGrid days={days} events={events} tasks={data.tasks.filter(t => t.status !== 'done')}
              sourceColors={sourceColors} trackedMinutesFor={trackedMinutesFor} canWrite={canWrite} writeableSources={writeableSources} onSelectSlot={handleSlotSelect} onEditTask={onEditTask} onOpenEvent={setSelectedEvent} onMoveEvent={rescheduleEvent}
              onOpenDay={view === 'day' ? undefined : openDay}
              zoom={zoom} onZoomChange={applyZoom} autoScrollKey={autoScrollKey}
              bookingMode={bookingMode} bookingSlots={bookingOverlay} onRemoveBookingSlot={handleRemoveBookingSlot} />
          ) : view === 'month' ? (
            <CalendarMonthView days={days} anchor={anchor} events={events} tasks={data.tasks.filter(t => t.status !== 'done')} data={data}
              sourceColors={sourceColors} trackedMinutesFor={trackedMinutesFor} onEditTask={onEditTask} onOpenDay={openDay} onOpenEvent={setSelectedEvent}
              isMobile={isMobile} selectedDay={monthDay} onSelectDay={setMonthDay}
              onCreateOnDay={canWrite && writeableSources.length > 0 ? startCreateOnDay : undefined} />
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
        <div className="cal-stage-ghost" ref={ghostRef} aria-hidden="true" />
      </div>
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
        <AttendeePicker organizationId={organizationId} sourceId={newEvent.sourceId}
          sourceProvider={integrations.sources.find(s => s.id === newEvent.sourceId)?.provider ?? null}
          clients={data.clients} suppliers={data.suppliers} attendees={newEvent.attendees}
          onChange={next => setNewEvent(p => ({ ...p, attendees: next }))} />
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
    {isTimeGridView(view) && canWrite && writeableSources.length > 0 && !showCreatePanel && (
      <button className="tb-fab" onClick={() => { const d = makeDefaultTimes(); setEditingOriginal(null); setNewEvent(p => ({ ...p, title: '', description: '', location: '', allDay: false, startsAt: d.startsAt, endsAt: d.endsAt, clientId: '', projectId: '', trackTime: true, recurrenceFreq: '', recurrenceUntil: '', editingEventId: '', attendees: [], meetingUrl: '', addConference: false })); setShowCreatePanel(true); }} title="Nieuwe afspraak aanmaken">
        <Plus size={22} />
      </button>
    )}

    {/* Floating panel */}
    {showCreatePanel && <EventCreationPanel newEvent={newEvent} setNewEvent={setNewEvent} writeableSources={writeableSources}
      clients={data.clients} suppliers={data.suppliers} projects={data.projects} organizationId={organizationId}
      selectedSourceIsNative={integrations.sources.find(s => s.id === newEvent.sourceId)?.provider === 'native'}
      selectedSourceProvider={integrations.sources.find(s => s.id === newEvent.sourceId)?.provider ?? null}
      loading={loading} canWrite={canWrite} onSubmit={submitNewEvent} onClose={() => { setShowCreatePanel(false); setEditingOriginal(null); }} />}

    <CalendarEventDetailPanel event={selectedEvent} organizationId={organizationId} data={data} sourceColors={sourceColors} canWrite={canWrite} editable={selectedEvent ? eventIsEditable(selectedEvent) : false} onNewNote={onNewNoteForEvent} onNewDocument={onNewDocumentForEvent} onSetEventLink={onSetEventLink} onLogTime={openLogTimeForEvent} onEditNote={onEditNote} onLinkExistingNote={onLinkExistingNoteToEvent} onUnlinkNote={onUnlinkNoteFromEvent} onSaveEvent={saveEventEdits} onDeleteEvent={removeEvent} onClose={() => setSelectedEvent(null)} />

    {showBookingSend && (
      <BookingSendDialog sources={writeableSources} clients={data.clients} draftCount={draftSlots.length}
        onCancel={() => setShowBookingSend(false)} onSubmit={submitBookingSend} />
    )}

    {bookingCreated && (
      <Modal title="Boekingslink klaar om te delen" onClose={() => setBookingCreated(null)}>
        <p className="muted">Deel deze link met de klant. Om veiligheidsredenen tonen we hem hierna niet meer (alleen een versleutelde verwijzing wordt bewaard).</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <Input readOnly value={bookingCreated.url} onFocus={e => e.currentTarget.select()} style={{ flex: 1 }} />
          <Button onClick={() => navigator.clipboard?.writeText(bookingCreated!.url)}>Kopieer</Button>
        </div>
        <Button variant="primary" onClick={async () => {
          try { await sendBookingLinkMail(organizationId, bookingCreated!.linkId, bookingCreated!.token); setMessage('Boekingsmail verstuurd naar de klant.'); setBookingCreated(null); }
          catch (e) { setError(e instanceof Error ? e.message : 'Mailen mislukt (heeft de klant een e-mailadres?).'); }
        }}>Mailen naar klant</Button>
      </Modal>
    )}

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
