import { supabase } from './supabase';
import type { CalendarAppPassword, CalendarConnection, CalendarExternalEvent, CalendarProvider, CalendarSource, CalendarVisibility, EventRecurrence, UUID } from '../types';

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

export async function createExternalCalendarEvent(organizationId: UUID, input: CalendarEventInput): Promise<CalendarExternalEvent> {
  const data = await invokeCalendar<{ event: CalendarExternalEvent }>(organizationId, { action: 'createEvent', event: input });
  return data.event;
}

/** Bewerkt een native ResoFly-agenda-item (eventId = native_event_id). */
export async function updateCalendarEvent(organizationId: UUID, eventId: UUID, input: CalendarEventInput): Promise<CalendarExternalEvent> {
  const data = await invokeCalendar<{ event: CalendarExternalEvent }>(organizationId, { action: 'updateEvent', event: { ...input, eventId } });
  return data.event;
}

/** Verwijdert (soft-delete) een native ResoFly-agenda-item. */
export async function deleteCalendarEvent(organizationId: UUID, eventId: UUID): Promise<void> {
  await invokeCalendar<Record<string, never>>(organizationId, { action: 'deleteEvent', eventId });
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
