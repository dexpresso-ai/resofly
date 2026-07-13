import { supabase } from './supabase';
import type { AttendeeInput, CalendarAppPassword, CalendarConnection, CalendarEventAttendee, CalendarExternalEvent, CalendarProvider, CalendarSource, CalendarVisibility, EventRecurrence, UUID } from '../types';

export interface CalendarIntegrationsPayload {
  connections: CalendarConnection[];
  sources: CalendarSource[];
}

export interface CalendarEventInput {
  sourceId: UUID;
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  /** Alleen voor native ResoFly-agenda's: optionele herhaling. */
  recurrence?: EventRecurrence | null;
  /** Alleen voor native ResoFly-agenda's: genodigden (krijgen een uitnodiging per e-mail). */
  attendees?: AttendeeInput[];
  /** Videocall-link die de gebruiker zelf plakt (Google Meet / Teams / Zoom / overig). */
  meetingUrl?: string | null;
  /** Genereer automatisch een videovergadering bij de provider (Google Meet op Google, Teams op Microsoft). */
  addConference?: boolean;
}

export interface NativeCalendarInput {
  name: string;
  color?: string | null;
  visibility?: CalendarVisibility;
}

type CalendarActionResponse<T> = { ok: true } & T;

async function invokeCalendar<T>(organizationId: UUID, body: Record<string, unknown>): Promise<CalendarActionResponse<T>> {
  const { data, error } = await supabase.functions.invoke('calendar-integrations', { body: { ...body, organizationId } });
  if (error) throw new Error(error.message || 'Agenda-koppeling mislukt.');
  if (!data || data.ok !== true) throw new Error(data?.error ?? 'Agenda-koppeling gaf geen geldig antwoord terug.');
  return data as CalendarActionResponse<T>;
}

export async function getCalendarOAuthUrl(organizationId: UUID, provider: CalendarProvider, returnTo: string): Promise<string> {
  const data = await invokeCalendar<{ authUrl: string }>(organizationId, { action: 'oauthStart', provider, returnTo });
  return data.authUrl;
}

export async function loadCalendarIntegrations(organizationId: UUID): Promise<CalendarIntegrationsPayload> {
  const data = await invokeCalendar<CalendarIntegrationsPayload>(organizationId, { action: 'listIntegrations' });
  return { connections: data.connections, sources: data.sources };
}

export async function refreshCalendarSources(organizationId: UUID, connectionId: UUID): Promise<CalendarIntegrationsPayload> {
  const data = await invokeCalendar<CalendarIntegrationsPayload>(organizationId, { action: 'refreshSources', connectionId });
  return { connections: data.connections, sources: data.sources };
}

export async function updateCalendarSource(organizationId: UUID, sourceId: UUID, patch: Pick<Partial<CalendarSource>, 'sync_enabled' | 'write_enabled' | 'visibility'>): Promise<CalendarSource> {
  const data = await invokeCalendar<{ source: CalendarSource }>(organizationId, { action: 'updateSource', sourceId, patch });
  return data.source;
}

export async function disconnectCalendarConnection(organizationId: UUID, connectionId: UUID): Promise<void> {
  await invokeCalendar<Record<string, never>>(organizationId, { action: 'disconnectConnection', connectionId });
}

export async function listExternalCalendarEvents(organizationId: UUID, start: string, end: string): Promise<CalendarExternalEvent[]> {
  const data = await invokeCalendar<{ events: CalendarExternalEvent[] }>(organizationId, { action: 'listEvents', start, end });
  return data.events;
}

// ── Korte client-cache voor de agendaweergave ──────────────────────────────
// Events ophalen gaat via een edge function die live Google/Microsoft bevraagt
// (traag). Voor de agendaweergave cachen we per (organisatie + tijdvenster) kort
// en dedupliceren we gelijktijdige identieke verzoeken. Zo kost heen-en-weer
// bladeren — en de dubbele fetch bij het openen van de pagina — niet elke keer de
// volle latency. Booking-/notitie-flows blijven de ongecachte functie hierboven
// gebruiken, zodat beschikbaarheid daar altijd vers is.
const EVENTS_CACHE_TTL_MS = 45_000;
type EventsCacheEntry = { events: CalendarExternalEvent[]; ts: number };
const eventsCache = new Map<string, EventsCacheEntry>();
const eventsInflight = new Map<string, Promise<CalendarExternalEvent[]>>();

function eventsCacheKey(organizationId: UUID, start: string, end: string): string {
  return `${organizationId}|${start}|${end}`;
}

/** Wist de agenda-event-cache na een mutatie; optioneel alleen voor één organisatie. */
export function invalidateCalendarEventsCache(organizationId?: UUID): void {
  if (!organizationId) { eventsCache.clear(); return; }
  const prefix = `${organizationId}|`;
  for (const key of [...eventsCache.keys()]) if (key.startsWith(prefix)) eventsCache.delete(key);
}

/** Direct beschikbare, nog verse gecachte events voor dit venster (voor instant paint), of null. */
export function getCachedCalendarEvents(organizationId: UUID, start: string, end: string): CalendarExternalEvent[] | null {
  const hit = eventsCache.get(eventsCacheKey(organizationId, start, end));
  if (!hit || Date.now() - hit.ts >= EVENTS_CACHE_TTL_MS) return null;
  return hit.events;
}

/** Als listExternalCalendarEvents, maar met korte cache + dedup van gelijktijdige identieke verzoeken. */
export async function listCalendarEventsCached(organizationId: UUID, start: string, end: string): Promise<CalendarExternalEvent[]> {
  const key = eventsCacheKey(organizationId, start, end);
  const cached = eventsCache.get(key);
  if (cached && Date.now() - cached.ts < EVENTS_CACHE_TTL_MS) return cached.events;
  const inflight = eventsInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    const events = await listExternalCalendarEvents(organizationId, start, end);
    eventsCache.set(key, { events, ts: Date.now() });
    return events;
  })();
  eventsInflight.set(key, promise);
  try { return await promise; }
  finally { eventsInflight.delete(key); }
}

export async function createExternalCalendarEvent(organizationId: UUID, input: CalendarEventInput): Promise<CalendarExternalEvent> {
  const data = await invokeCalendar<{ event: CalendarExternalEvent }>(organizationId, { action: 'createEvent', event: input });
  return data.event;
}

/**
 * Verwijst naar een agenda-item. Native items via `eventId` (= native_event_id);
 * externe (Google/Microsoft) items via `sourceId` + `providerEventId`.
 */
export interface CalendarEventRef {
  eventId?: UUID;
  sourceId?: UUID;
  providerEventId?: string;
}

/** Bewerkt een agenda-item (native ResoFly óf extern Google/Microsoft). */
export async function updateCalendarEvent(organizationId: UUID, ref: CalendarEventRef, input: CalendarEventInput): Promise<CalendarExternalEvent> {
  const data = await invokeCalendar<{ event: CalendarExternalEvent }>(organizationId, { action: 'updateEvent', event: { ...input, ...ref } });
  return data.event;
}

/** Verwijdert een agenda-item (native = soft-delete; extern = via de provider-API). */
export async function deleteCalendarEvent(organizationId: UUID, ref: CalendarEventRef): Promise<void> {
  await invokeCalendar<Record<string, never>>(organizationId, { action: 'deleteEvent', ...ref });
}

/** Haalt de genodigden (incl. RSVP-status) van een native agenda-item op. */
export async function getCalendarEventAttendees(organizationId: UUID, eventId: UUID): Promise<CalendarEventAttendee[]> {
  const data = await invokeCalendar<{ attendees: CalendarEventAttendee[] }>(organizationId, { action: 'getEventAttendees', eventId });
  return data.attendees;
}

export interface ProviderContact {
  name: string | null;
  email: string;
}

/**
 * Zoekt contacten in het adresboek van de agenda-provider (Google People /
 * Microsoft Graph) van de opgegeven bron. App-eigen contacten worden client-side
 * doorzocht. `needsReconnect` = de koppeling mist de contacten-scope (opnieuw koppelen).
 */
export async function searchCalendarContacts(organizationId: UUID, sourceId: UUID, query: string): Promise<{ contacts: ProviderContact[]; needsReconnect: boolean }> {
  const data = await invokeCalendar<{ contacts: ProviderContact[]; needsReconnect?: boolean }>(organizationId, { action: 'searchContacts', sourceId, query });
  return { contacts: data.contacts ?? [], needsReconnect: Boolean(data.needsReconnect) };
}

export async function createNativeCalendar(organizationId: UUID, input: NativeCalendarInput): Promise<CalendarSource> {
  const data = await invokeCalendar<{ source: CalendarSource }>(organizationId, { action: 'createNativeCalendar', ...input });
  return data.source;
}

export async function updateNativeCalendar(organizationId: UUID, sourceId: UUID, patch: Partial<NativeCalendarInput> & { sync_enabled?: boolean }): Promise<CalendarSource> {
  const data = await invokeCalendar<{ source: CalendarSource }>(organizationId, { action: 'updateNativeCalendar', sourceId, ...patch });
  return data.source;
}

export async function deleteNativeCalendar(organizationId: UUID, sourceId: UUID): Promise<void> {
  await invokeCalendar<Record<string, never>>(organizationId, { action: 'deleteNativeCalendar', sourceId });
}

// ── Agenda's via link (iCal/ICS-abonnementen) ──────────────────────────────
export interface IcsSubscriptionInput {
  url: string;
  name: string;
  color?: string | null;
  visibility?: CalendarVisibility;
}

/** Voegt een read-only agenda toe via een iCal/ICS-link; haalt de feed meteen op. */
export async function createIcsSubscription(organizationId: UUID, input: IcsSubscriptionInput): Promise<{ source: CalendarSource; count: number; warning?: string }> {
  const data = await invokeCalendar<{ source: CalendarSource; count: number; warning?: string }>(organizationId, { action: 'createIcsSubscription', ...input });
  return { source: data.source, count: data.count ?? 0, warning: data.warning };
}

/** Ververst één ICS-abonnement direct ("Ververs nu"). */
export async function refreshIcsSubscription(organizationId: UUID, sourceId: UUID): Promise<{ source: CalendarSource; count: number }> {
  const data = await invokeCalendar<{ source: CalendarSource; count: number }>(organizationId, { action: 'refreshIcsSubscription', sourceId });
  return { source: data.source, count: data.count ?? 0 };
}

export async function updateIcsSubscription(organizationId: UUID, sourceId: UUID, patch: Partial<IcsSubscriptionInput> & { sync_enabled?: boolean }): Promise<CalendarSource> {
  const data = await invokeCalendar<{ source: CalendarSource }>(organizationId, { action: 'updateIcsSubscription', sourceId, ...patch });
  return data.source;
}

export async function deleteIcsSubscription(organizationId: UUID, sourceId: UUID): Promise<void> {
  await invokeCalendar<Record<string, never>>(organizationId, { action: 'deleteIcsSubscription', sourceId });
}

/** Genereert een nieuw app-wachtwoord; `secret` wordt eenmalig teruggegeven. */
export async function createCalendarAppPassword(organizationId: UUID, label: string): Promise<{ appPassword: CalendarAppPassword; secret: string }> {
  const data = await invokeCalendar<{ appPassword: CalendarAppPassword; secret: string }>(organizationId, { action: 'createAppPassword', label });
  return { appPassword: data.appPassword, secret: data.secret };
}

export async function listCalendarAppPasswords(organizationId: UUID): Promise<CalendarAppPassword[]> {
  const data = await invokeCalendar<{ appPasswords: CalendarAppPassword[] }>(organizationId, { action: 'listAppPasswords' });
  return data.appPasswords;
}

export async function revokeCalendarAppPassword(organizationId: UUID, appPasswordId: UUID): Promise<void> {
  await invokeCalendar<Record<string, never>>(organizationId, { action: 'revokeAppPassword', appPasswordId });
}
