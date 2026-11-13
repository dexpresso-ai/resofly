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
  type ConnectionRow,
  type NativeEventRow,
  type Provider,
  supabaseAdmin,
  getConnection,
  getToken,
  refreshAccessToken,
  CalendarTokenError,
  ProviderHttpError,
  assertIso,
  mapGoogleAttendees,
  mapMicrosoftAttendees,
  stripMeetingLine,
  readMeetingUrl,
  googleConferenceUrl,
  normalizeAllDayEventRange,
  normalizeMicrosoftDateTime,
  parseSimpleRrule,
  recurrenceTimeZone,
} from './calendarCore.ts';
import { recurrenceStarts } from './wallClock.ts';
import { googleEventConference, microsoftEventConference } from './conference.ts';

/**
 * Alle zichtbare agenda-items voor een gebruiker in [start, end). Bij een fout op
 * één bron wordt die bron overgeslagen zodat de overige agenda's blijven werken.
 */
export async function listEvents(organizationId: string, requesterUserId: string, start: string, end: string) {
  const startIso = assertIso(start, 'start');
  const endIso = assertIso(end, 'end');
  const { data: sources, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('sync_enabled', true);
  if (error) throw error;
  const visibleSources = ((sources ?? []) as CalendarSourceRow[]).filter(source => source.user_id === requesterUserId || source.visibility === 'organization');

  // Access tokens één keer per verbinding vernieuwen (niet per agenda) én parallel.
  // Meerdere agenda's onder hetzelfde account delen zo één refresh — dit voorkomt
  // dubbele refresh-calls en een refresh-race waarbij gelijktijdige refreshes elkaars
  // roterende refresh-token overschrijven.
  const connectionIds = [...new Set(
    visibleSources.filter(source => source.provider !== 'native' && source.provider !== 'ics' && source.connection_id).map(source => source.connection_id as string),
  )];
  const tokenByConnection = new Map<string, string>();
  const statusByConnection = new Map<string, ConnectionRow['status']>();
  await Promise.all(connectionIds.map(async (connectionId) => {
    let connection: ConnectionRow;
    try {
      connection = await getConnection(organizationId, connectionId);
    } catch {
      return;
    }
    statusByConnection.set(connectionId, connection.status);
    // Ingetrokken (het teamlid vertrok uit de organisatie): er is geen token
    // meer, en de status mét de reden moet blijven staan. Eerst overschreef
    // elke weergave van de agenda die met "error: Agenda-token niet gevonden".
    if (connection.status === 'revoked') return;
    try {
      const token = await getToken(organizationId, connection.id);
      tokenByConnection.set(connectionId, await refreshAccessToken(token));
    } catch (err) {
      console.warn('Token refresh failed for connection', connectionId, err);
      // refreshAccessToken zet zelf de status bij een blijvend probleem en laat
      // de koppeling met rust bij een storing. Over blijft: het token ontbreekt
      // of is niet te ontsleutelen. Dan helpt alleen opnieuw koppelen.
      if (!(err instanceof CalendarTokenError)) {
        await supabaseAdmin.from('calendar_connections')
          .update({ status: 'error', last_error: 'ResoFly kan het toegangstoken van deze koppeling niet lezen. Koppel het account opnieuw.' })
          .eq('id', connectionId).eq('organization_id', organizationId);
      }
    }
  }));

  // Welke koppelingen werkten (minstens één agenda opgehaald) en welke niet:
  // zo kan een oude foutstatus weg zodra alles weer werkt.
  const workingConnections = new Set<string>();
  const failingConnections = new Set<string>();

  // Alle bronnen parallel ophalen; een fout op één bron laat de overige agenda's intact.
  const perSource = await Promise.all(visibleSources.map(async (source) => {
    try {
      // Lokale bronnen (eigen ResoFly-agenda én ICS-abonnementen) staan als rijen
      // in calendar_events; ICS-items zijn read-only (door de sync-worker gevuld).
      if (source.provider === 'native' || source.provider === 'ics') {
        const nativeEvents = await fetchNativeEvents(organizationId, source, startIso, endIso);
        return nativeEvents.map((event: Record<string, unknown>) => maskPrivateEventForRequester(event, source, requesterUserId));
      }
      if (!source.connection_id) return [];
      const accessToken = tokenByConnection.get(source.connection_id);
      if (!accessToken) return []; // token-refresh voor deze verbinding is hierboven al mislukt
      const sourceEvents = source.provider === 'google'
        ? await fetchGoogleEvents(accessToken, source, startIso, endIso)
        : await fetchMicrosoftEvents(accessToken, source, startIso, endIso);
      workingConnections.add(source.connection_id);
      return sourceEvents.map((event: Record<string, unknown>) => maskPrivateEventForRequester(event, source, requesterUserId));
    } catch (err) {
      console.warn('Event sync failed for source', source.id, err);
      const status = err instanceof ProviderHttpError ? err.status : 0;
      if (status === 404 || status === 410) {
        // Deze agenda bestaat niet meer bij Google of Microsoft (opgezegd,
        // verwijderd, of de toegang is ingetrokken). Eerst zette dat de hele
        // koppeling op "error", en daarmee ook het schrijven in de hoofdagenda
        // op slot. Nu gaat alleen deze agenda uit; bij de volgende keer
        // "Agenda's ophalen" verdwijnt hij uit de lijst.
        await supabaseAdmin.from('calendar_sources').update({ sync_enabled: false })
          .eq('id', source.id).eq('organization_id', organizationId);
        return [];
      }
      if (status === 401 && source.connection_id) {
        // Het token werd geweigerd terwijl het volgens ons nog geldig was (net
        // ingetrokken). Laat het de volgende keer vernieuwen: die vernieuwing
        // ziet of de toegang echt weg is en zet dan "verlopen" met uitleg.
        await supabaseAdmin.from('calendar_connection_tokens').update({ expires_at: new Date(0).toISOString() })
          .eq('connection_id', source.connection_id).eq('organization_id', organizationId);
      }
      if (source.connection_id) {
        failingConnections.add(source.connection_id);
        const detail = err instanceof Error ? err.message : 'ophalen mislukt';
        await supabaseAdmin.from('calendar_connections')
          .update({ status: 'error', last_error: `Agenda "${source.name}": ${detail}` })
          .eq('id', source.connection_id).eq('organization_id', organizationId)
          .neq('status', 'revoked');
      }
      return [];
    }
  }));

  // Herstel: stond een koppeling op "error" maar werkte nu alles, dan weg met
  // de oude fout. Eerst bleef die staan tot het token toevallig vernieuwd
  // werd, en zolang weigerde ResoFly afspraken in die agenda te zetten.
  await Promise.all([...workingConnections]
    .filter(connectionId => statusByConnection.get(connectionId) === 'error' && !failingConnections.has(connectionId))
    .map(connectionId => supabaseAdmin.from('calendar_connections')
      .update({ status: 'active', last_error: null })
      .eq('id', connectionId).eq('organization_id', organizationId).eq('status', 'error')));

  return dedupeCalendarEvents(perSource.flat()).sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
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

/**
 * Wat een collega van een afspraak ziet. Uit een privé-agenda: alleen "Bezet".
 * Uit een gedeelde agenda: alles, behalve wat de eigenaar bij Google of
 * Microsoft zelf als privé markeerde. Dat kwam eerst volledig door (titel,
 * omschrijving, genodigden), terwijl Google en Outlook zulke afspraken voor
 * wie meekijkt juist afschermen.
 */
export function maskPrivateEventForRequester(event: Record<string, unknown>, source: CalendarSourceRow, requesterUserId: string) {
  if (source.user_id === requesterUserId) return event;
  if (source.visibility !== 'private' && !event.provider_private) return event;
  return {
    ...event,
    title: 'Bezet',
    description: null,
    location: null,
    meeting_url: null,
    conference: null,
    attendees: [],
    html_link: null,
    is_private_masked: true,
  };
}

/** Haalt pagina's op tot er geen volgende is (met een plafond). */
async function fetchPaged<T>(first: string, accessToken: string, headers: Record<string, string>, read: (payload: Record<string, unknown>) => { items: T[]; next: string | null }, fallbackError: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  for (let page = 0; url && page < 8; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, ...headers } });
    const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      const message = (payload.error as Record<string, unknown> | undefined)?.message;
      throw new ProviderHttpError(res.status, typeof message === 'string' && message ? message : fallbackError);
    }
    const { items, next } = read(payload);
    out.push(...items);
    url = next;
  }
  return out;
}

export async function fetchGoogleEvents(accessToken: string, source: CalendarSourceRow, start: string, end: string) {
  const params = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events?${params}`;
  // Meer dan 250 afspraken in beeld (een drukke maand, een gedeelde teamagenda)
  // werd eerst stil afgekapt; nu volgen we nextPageToken.
  const items = await fetchPaged<Record<string, unknown>>(base, accessToken, {}, (payload) => ({
    items: (payload.items ?? []) as Record<string, unknown>[],
    next: payload.nextPageToken ? `${base}&pageToken=${encodeURIComponent(String(payload.nextPageToken))}` : null,
  }), 'Google events ophalen mislukt.');
  return items.filter((item: Record<string, unknown>) => item.status !== 'cancelled').map((item: Record<string, unknown>) => {
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
      // De Meet die Google zelf op de afspraak zette: de app toont die als
      // "Google Meet" en schrijft hem bij bewerken niet in de omschrijving.
      conference: googleEventConference(item),
      attendees: mapGoogleAttendees(item),
      starts_at: allDayRange ? allDayRange.starts_at : String(startObj.dateTime),
      ends_at: allDayRange ? allDayRange.ends_at : String(endObj.dateTime),
      all_day: allDay,
      html_link: item.htmlLink ? String(item.htmlLink) : null,
      visibility: source.visibility,
      is_private_masked: false,
      provider_private: item.visibility === 'private' || item.visibility === 'confidential',
    };
  });
}

export async function fetchMicrosoftEvents(accessToken: string, source: CalendarSourceRow, start: string, end: string) {
  const params = new URLSearchParams({ startDateTime: start, endDateTime: end, '$top': '250', '$orderby': 'start/dateTime', '$select': 'id,subject,bodyPreview,location,start,end,isAllDay,webLink,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,attendees,sensitivity' });
  const first = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(source.provider_calendar_id)}/calendarView?${params}`;
  const items = await fetchPaged<Record<string, unknown>>(first, accessToken, { Prefer: 'outlook.timezone="UTC"' }, (payload) => {
    // Alleen een vervolglink bij Microsoft Graph zelf volgen, met ons token erbij.
    const next = typeof payload['@odata.nextLink'] === 'string' && payload['@odata.nextLink'].startsWith('https://graph.microsoft.com/')
      ? payload['@odata.nextLink']
      : null;
    return { items: (payload.value ?? []) as Record<string, unknown>[], next };
  }, 'Microsoft events ophalen mislukt.');
  return items.map((item: Record<string, unknown>) => {
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
      conference: microsoftEventConference(item),
      attendees: mapMicrosoftAttendees(item),
      starts_at: allDayRange ? allDayRange.starts_at : normalizeMicrosoftDateTime(startObj.dateTime),
      ends_at: allDayRange ? allDayRange.ends_at : normalizeMicrosoftDateTime(endObj.dateTime),
      all_day: allDay,
      html_link: item.webLink ? String(item.webLink) : null,
      visibility: source.visibility,
      is_private_masked: false,
      provider_private: item.sensitivity === 'private' || item.sensitivity === 'confidential',
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
    // 'native' (bewerkbaar) of 'ics' (read-only abonnement).
    provider: source.provider as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: row.uid,
    // Alleen native items zijn in-app bewerkbaar; ICS-items niet.
    native_event_id: source.provider === 'native' ? row.id : null,
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

// Herhaling uitvouwen (FREQ DAILY/WEEKLY/MONTHLY + INTERVAL/UNTIL/COUNT +
// EXDATE), op de wandklok van de afspraak: zie recurrenceStarts in
// wallClock.ts. Dezelfde regel gebruikt de agendaserver (workers/caldav) voor
// de telefoon en de deellinks.
export function expandRecurringNativeRow(row: NativeEventRow, source: CalendarSourceRow, startIso: string, endIso: string): Record<string, unknown>[] {
  const base = nativeRowToBaseEvent(row, source);
  const rule = parseSimpleRrule(row.rrule);
  if (!rule) return [base];
  const startMs = new Date(row.starts_at).getTime();
  const durationMs = new Date(row.ends_at).getTime() - startMs;
  const exdates = new Set((row.exdate ?? []).map(value => new Date(value).getTime()));
  const starts = recurrenceStarts(startMs, durationMs, rule, recurrenceTimeZone(row, source), new Date(startIso).getTime(), new Date(endIso).getTime(), exdates);
  return starts.map(ms => ({
    ...base,
    id: `${source.id}:${row.uid}:${ms}`,
    starts_at: new Date(ms).toISOString(),
    ends_at: new Date(ms + durationMs).toISOString(),
  }));
}
