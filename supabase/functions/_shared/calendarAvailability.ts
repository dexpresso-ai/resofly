// ============================================================
// Gedeelde agenda-lees-/beschikbaarheidslaag
//
// Haalt agenda-items op over native + Google + Microsoft agenda's heen voor een
// tijdvenster. Hergebruikt door `calendar-integrations` (listEvents-actie), de
// meeting-booking-functies (overlap-/beschikbaarheidscontrole) en de Gerrie-agent
// (reistijd-bewuste tijdsvoorstellen).
// ============================================================

import {
  type CalendarSourceRow,
  type NativeEventRow,
  type Provider,
  supabaseAdmin,
  getConnection,
  getToken,
  refreshAccessToken,
  assertIso,
  mapGoogleAttendees,
  mapMicrosoftAttendees,
  stripMeetingLine,
  readMeetingUrl,
  googleConferenceUrl,
  normalizeAllDayEventRange,
  normalizeMicrosoftDateTime,
  parseSimpleRrule,
  advanceRecurrence,
} from './calendarCore.ts';

/**
 * Alle zichtbare agenda-items voor een gebruiker in [start, end). Bij een fout op
 * één bron wordt die bron overgeslagen (en de koppeling op 'error' gezet) zodat de
 * overige agenda's blijven werken.
 */
export async function listEvents(organizationId: string, requesterUserId: string, start: string, end: string) {
  const startIso = assertIso(start, 'start');
  const endIso = assertIso(end, 'end');
  const { data: sources, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('sync_enabled', true);
  if (error) throw error;
  const events: Record<string, unknown>[] = [];
  const visibleSources = ((sources ?? []) as CalendarSourceRow[]).filter(source => source.user_id === requesterUserId || source.visibility === 'organization');
  for (const source of visibleSources) {
    try {
      if (source.provider === 'native') {
        const nativeEvents = await fetchNativeEvents(organizationId, source, startIso, endIso);
        events.push(...nativeEvents.map((event: Record<string, unknown>) => maskPrivateEventForRequester(event, source, requesterUserId)));
        continue;
      }
      if (!source.connection_id) continue;
      const connection = await getConnection(organizationId, source.connection_id);
      const token = await getToken(organizationId, connection.id);
      const accessToken = await refreshAccessToken(token);
      const sourceEvents = source.provider === 'google'
        ? await fetchGoogleEvents(accessToken, source, startIso, endIso)
        : await fetchMicrosoftEvents(accessToken, source, startIso, endIso);
      events.push(...sourceEvents.map((event: Record<string, unknown>) => maskPrivateEventForRequester(event, source, requesterUserId)));
    } catch (err) {
      console.warn('Event sync failed for source', source.id, err);
      await supabaseAdmin.from('calendar_connections').update({ status: 'error', last_error: err instanceof Error ? err.message : 'Event sync mislukt' }).eq('id', source.connection_id);
    }
  }
  return dedupeCalendarEvents(events).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
}

export function dedupeCalendarEvents(events: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const deduped: Record<string, unknown>[] = [];
  for (const event of events) {
    const key = [event.provider, event.source_id, event.provider_event_id, event.starts_at].map(value => String(value || '')).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

export function maskPrivateEventForRequester(event: Record<string, unknown>, source: CalendarSourceRow, requesterUserId: string) {
  if (source.visibility !== 'private' || source.user_id === requesterUserId) return event;
  return {
    ...event,
    title: 'Bezet',
    description: null,
    location: null,
    meeting_url: null,
    attendees: [],
    html_link: null,
    is_private_masked: true,
  };
}

export async function fetchGoogleEvents(accessToken: string, source: CalendarSourceRow, start: string, end: string) {
  const params = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Google events ophalen mislukt.');
  return (payload.items ?? []).filter((item: Record<string, unknown>) => item.status !== 'cancelled').map((item: Record<string, unknown>) => {
    const startObj = (item.start ?? {}) as Record<string, string>;
    const endObj = (item.end ?? {}) as Record<string, string>;
    const allDay = Boolean(startObj.date && !startObj.dateTime);
    const allDayRange = allDay ? normalizeAllDayEventRange(startObj.date, endObj.date) : null;
    const rawDescription = item.description ? String(item.description) : null;
    const location = item.location ? String(item.location) : null;
    return {
      id: `${source.id}:${String(item.id)}`,
      provider: 'google' as Provider,
      source_id: source.id,
      source_name: source.name,
      provider_event_id: String(item.id),
      title: String(item.summary || '(Geen titel)'),
      description: stripMeetingLine(rawDescription),
      location,
      meeting_url: readMeetingUrl(googleConferenceUrl(item), rawDescription, location),
      attendees: mapGoogleAttendees(item),
      starts_at: allDayRange ? allDayRange.starts_at : String(startObj.dateTime),
      ends_at: allDayRange ? allDayRange.ends_at : String(endObj.dateTime),
      all_day: allDay,
      html_link: item.htmlLink ? String(item.htmlLink) : null,
      visibility: source.visibility,
      is_private_masked: false,
    };
  });
}

export async function fetchMicrosoftEvents(accessToken: string, source: CalendarSourceRow, start: string, end: string) {
  const params = new URLSearchParams({ startDateTime: start, endDateTime: end, '$top': '250', '$orderby': 'start/dateTime', '$select': 'id,subject,bodyPreview,location,start,end,isAllDay,webLink,isOnlineMeeting,onlineMeeting,attendees' });
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(source.provider_calendar_id)}/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft events ophalen mislukt.');
  return (payload.value ?? []).map((item: Record<string, unknown>) => {
    const startObj = (item.start ?? {}) as Record<string, string>;
    const endObj = (item.end ?? {}) as Record<string, string>;
    const location = (item.location ?? {}) as Record<string, string>;
    const onlineMeeting = (item.onlineMeeting ?? {}) as Record<string, string>;
    const allDay = Boolean(item.isAllDay);
    const allDayRange = allDay ? normalizeAllDayEventRange(startObj.dateTime, endObj.dateTime) : null;
    const rawDescription = item.bodyPreview ? String(item.bodyPreview) : null;
    const locationName = location.displayName ? String(location.displayName) : null;
    return {
      id: `${source.id}:${String(item.id)}`,
      provider: 'microsoft' as Provider,
      source_id: source.id,
      source_name: source.name,
      provider_event_id: String(item.id),
      title: String(item.subject || '(Geen titel)'),
      description: stripMeetingLine(rawDescription),
      location: locationName,
      meeting_url: readMeetingUrl(onlineMeeting.joinUrl ? String(onlineMeeting.joinUrl) : null, rawDescription, locationName),
      attendees: mapMicrosoftAttendees(item),
      starts_at: allDayRange ? allDayRange.starts_at : normalizeMicrosoftDateTime(startObj.dateTime),
      ends_at: allDayRange ? allDayRange.ends_at : normalizeMicrosoftDateTime(endObj.dateTime),
      all_day: allDay,
      html_link: item.webLink ? String(item.webLink) : null,
      visibility: source.visibility,
      is_private_masked: false,
    };
  });
}

export async function fetchNativeEvents(organizationId: string, source: CalendarSourceRow, startIso: string, endIso: string) {
  const [{ data: singles, error: singleError }, { data: recurringRows, error: recurringError }] = await Promise.all([
    supabaseAdmin.from('calendar_events').select('*')
      .eq('organization_id', organizationId).eq('source_id', source.id).is('deleted_at', null).eq('recurs', false)
      .lt('starts_at', endIso).gte('ends_at', startIso),
    supabaseAdmin.from('calendar_events').select('*')
      .eq('organization_id', organizationId).eq('source_id', source.id).is('deleted_at', null).eq('recurs', true),
  ]);
  if (singleError) throw singleError;
  if (recurringError) throw recurringError;
  const out: Record<string, unknown>[] = [];
  for (const row of (singles ?? []) as NativeEventRow[]) out.push(nativeRowToBaseEvent(row, source));
  for (const row of (recurringRows ?? []) as NativeEventRow[]) out.push(...expandRecurringNativeRow(row, source, startIso, endIso));
  return out;
}

export function nativeRowToBaseEvent(row: NativeEventRow, source: CalendarSourceRow): Record<string, unknown> {
  return {
    id: `${source.id}:${row.uid}`,
    provider: 'native' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: row.uid,
    native_event_id: row.id,
    title: row.title || '(Geen titel)',
    description: row.description ?? null,
    location: row.location ?? null,
    meeting_url: row.meeting_url ?? null,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    all_day: row.all_day,
    rrule: row.rrule ?? null,
    recurs: row.recurs,
    html_link: null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

// Eenvoudige herhaling-uitvouwing voor fase 0 (FREQ DAILY/WEEKLY/MONTHLY +
// INTERVAL/UNTIL/COUNT + EXDATE). Volledige RRULE-afhandeling (BYDAY etc.) volgt
// met ical.js in de CalDAV-Worker.
export function expandRecurringNativeRow(row: NativeEventRow, source: CalendarSourceRow, startIso: string, endIso: string): Record<string, unknown>[] {
  const base = nativeRowToBaseEvent(row, source);
  const rule = parseSimpleRrule(row.rrule);
  if (!rule) return [base];
  const durationMs = new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime();
  const winStart = new Date(startIso).getTime();
  const winEnd = new Date(endIso).getTime();
  const until = rule.until ? new Date(rule.until).getTime() : null;
  const exdates = new Set((row.exdate ?? []).map(value => new Date(value).getTime()));
  const out: Record<string, unknown>[] = [];
  let cursor = new Date(row.starts_at);
  let count = 0;
  for (let i = 0; i < 800; i++) {
    const startMs = cursor.getTime();
    if (until !== null && startMs > until) break;
    if (rule.count && count >= rule.count) break;
    if (startMs > winEnd) break;
    const endMs = startMs + durationMs;
    if (endMs >= winStart && !exdates.has(startMs)) {
      out.push({
        ...base,
        id: `${source.id}:${row.uid}:${startMs}`,
        starts_at: new Date(startMs).toISOString(),
        ends_at: new Date(endMs).toISOString(),
      });
    }
    count += 1;
    cursor = advanceRecurrence(cursor, rule.freq, rule.interval);
  }
  return out;
}
