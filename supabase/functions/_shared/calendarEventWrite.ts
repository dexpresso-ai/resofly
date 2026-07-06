// ============================================================
// Gedeelde agenda-schrijf-/genodigdenlaag
//
// Maakt agenda-items aan op native + Google + Microsoft agenda's en verzorgt de
// genodigden + iMIP-uitnodigingen (native items) via de mail-infrastructuur.
// Hergebruikt door `calendar-integrations` (createEvent/update/delete) en de
// meeting-booking-functies (agenda-item aanmaken na een boeking).
// ============================================================

import {
  type CalendarSourceRow,
  type NativeEventRow,
  type AttendeeRow,
  type Provider,
  supabaseAdmin,
  getConnection,
  getToken,
  refreshAccessToken,
  assertIso,
  sanitizeMeetingUrl,
  withMeetingLine,
  stripMeetingLine,
  readMeetingUrl,
  googleConferenceUrl,
  mapGoogleAttendees,
  mapMicrosoftAttendees,
  normalizeAllDayEventRange,
  normalizeMicrosoftDateTime,
  toMicrosoftDateTime,
  nextDay,
  normalizeRrule,
  sourceCanWrite,
  EMAIL_RE,
  UUID_RE,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  MAIL_INBOUND_DOMAIN,
} from './calendarCore.ts';
import { nativeRowToBaseEvent } from './calendarAvailability.ts';
import { cancelConflictingBookingSlots, cancelConflictingBookingSlotsForNativeEvent } from './meetingBookingSync.ts';

// ── Nieuwe-event-invoer normaliseren ────────────────────────────────────────

export function parseAttendeesInput(input: Record<string, unknown>): Array<{ email: string; name: string | null; role: 'req' | 'opt' }> {
  const raw = input.attendees;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ email: string; name: string | null; role: 'req' | 'opt' }> = [];
  const seen = new Set<string>();
  for (const a of raw) {
    const rec: Record<string, unknown> = (a && typeof a === 'object') ? a as Record<string, unknown> : { email: a };
    const email = String(rec.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: rec.name ? String(rec.name).trim() : null, role: rec.role === 'opt' ? 'opt' : 'req' });
  }
  return out;
}

export function normalizeNewEventInput(input: Record<string, unknown>) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Eventtitel ontbreekt.');
  const startsAt = assertIso(String(input.startsAt || ''), 'startsAt');
  const endsAt = assertIso(String(input.endsAt || ''), 'endsAt');
  const allDay = Boolean(input.allDay);
  // For timed events, end must be strictly after start.
  // For all-day events, start == end is valid (single day).
  if (!allDay && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('Eindtijd moet na starttijd liggen.');
  }
  if (allDay && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw new Error('Einddatum mag niet voor startdatum liggen.');
  }
  return {
    title,
    description: input.description ? String(input.description) : null,
    location: input.location ? String(input.location) : null,
    startsAt,
    endsAt,
    allDay,
    meetingUrl: sanitizeMeetingUrl(input.meetingUrl),
    addConference: Boolean(input.addConference),
    attendees: parseAttendeesInput(input),
  };
}

export type NormalizedEventInput = ReturnType<typeof normalizeNewEventInput>;

// ── Dispatcher: aanmaken op de juiste provider ──────────────────────────────

export async function createEvent(organizationId: string, requesterUserId: string, input: Record<string, unknown>) {
  const sourceId = String(input.sourceId || '');
  const { data: source, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
  if (error || !source) throw new Error('Agenda-bron niet gevonden.');
  const calendarSource = source as CalendarSourceRow;
  if (calendarSource.user_id !== requesterUserId && calendarSource.visibility !== 'organization') {
    throw new Error('Deze privé-agenda is niet met de organisatie gedeeld.');
  }
  if (calendarSource.provider === 'native') {
    // createNativeEvent regelt zelf de boekingsoptie-reconciliatie (incl. herhalingen).
    return await createNativeEvent(organizationId, requesterUserId, calendarSource, input);
  }
  if (!calendarSource.write_enabled) {
    throw new Error('Schrijfbare agenda-bron niet gevonden.');
  }
  if (!sourceCanWrite(calendarSource)) {
    throw new Error('Deze externe agenda is niet schrijfbaar volgens de provider.');
  }
  if (!calendarSource.connection_id) throw new Error('Externe agenda-bron mist een koppeling.');
  const connection = await getConnection(organizationId, calendarSource.connection_id);
  if (connection.status !== 'active') {
    throw new Error(`Agenda-koppeling is niet actief (status: ${connection.status}). Koppel het account opnieuw.`);
  }
  const token = await getToken(organizationId, connection.id);
  const accessToken = await refreshAccessToken(token);
  const event = normalizeNewEventInput(input);
  const result = calendarSource.provider === 'google'
    ? await createGoogleEvent(accessToken, calendarSource, event)
    : await createMicrosoftEvent(accessToken, calendarSource, event);
  // Deze nieuwe afspraak kan een tot nu toe openstaande boekingsoptie op dezelfde
  // agenda overlappen — die is dan niet meer daadwerkelijk beschikbaar voor de
  // klant. Google/Microsoft ondersteunen hier geen herhaling, dus één voorkomst volstaat.
  await cancelConflictingBookingSlots(organizationId, calendarSource.id, String(result.starts_at ?? ''), String(result.ends_at ?? ''));
  return result;
}

// ── Google ──────────────────────────────────────────────────────────────────

/** Bouwt de Google event-body (start/end + omschrijving/videovergadering). */
export function buildGoogleEventBody(source: CalendarSourceRow, event: NormalizedEventInput): Record<string, unknown> {
  // Geplakte link onderaan de omschrijving; automatisch gegenereerde Meet gaat via conferenceData.
  const description = event.addConference ? event.description : withMeetingLine(event.description, event.meetingUrl);
  let body: Record<string, unknown>;
  if (event.allDay) {
    // Google Calendar API: end.date is EXCLUSIVE. Voor een eendaags event op 2026-05-08
    // is start.date = "2026-05-08" en end.date = "2026-05-09".
    const startDate = event.startsAt.slice(0, 10);
    const endDateRaw = event.endsAt.slice(0, 10);
    const endExclusive = endDateRaw <= startDate ? nextDay(startDate) : nextDay(endDateRaw);
    body = { summary: event.title, description, location: event.location, start: { date: startDate }, end: { date: endExclusive } };
  } else {
    // Getimede events: startsAt/endsAt zijn al UTC ISO-strings (eindigen op Z).
    const tz = source.timezone || undefined;
    body = { summary: event.title, description, location: event.location, start: { dateTime: event.startsAt, timeZone: tz }, end: { dateTime: event.endsAt, timeZone: tz } };
  }
  if (event.addConference) {
    body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  if (event.attendees.length) {
    body.attendees = event.attendees.map(a => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}), optional: a.role === 'opt' }));
  }
  return body;
}

/** Query-parameters voor een Google create/update: conferentie + uitnodigingen mailen. */
export function googleWriteQuery(event: NormalizedEventInput): string {
  const params = new URLSearchParams();
  if (event.addConference) params.set('conferenceDataVersion', '1');
  if (event.attendees.length) params.set('sendUpdates', 'all');
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function googleEventToBaseEvent(payload: Record<string, unknown>, source: CalendarSourceRow, event: NormalizedEventInput) {
  const allDay = Boolean((payload.start as Record<string, string>)?.date && !(payload.start as Record<string, string>)?.dateTime);
  const allDayRange = allDay ? normalizeAllDayEventRange((payload.start as Record<string, string>)?.date, (payload.end as Record<string, string>)?.date) : null;
  const rawDescription = payload.description ? String(payload.description) : event.description;
  const location = payload.location ? String(payload.location) : event.location;
  return {
    id: `${source.id}:${String(payload.id)}`,
    provider: 'google' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: String(payload.id),
    title: String(payload.summary || event.title),
    description: stripMeetingLine(rawDescription),
    location,
    meeting_url: readMeetingUrl(googleConferenceUrl(payload), rawDescription, location),
    attendees: mapGoogleAttendees(payload),
    starts_at: allDayRange ? allDayRange.starts_at : String((payload.start as Record<string, string>).dateTime),
    ends_at: allDayRange ? allDayRange.ends_at : String((payload.end as Record<string, string>).dateTime),
    all_day: allDay,
    html_link: payload.htmlLink ? String(payload.htmlLink) : null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

export async function createGoogleEvent(accessToken: string, source: CalendarSourceRow, event: NormalizedEventInput) {
  const body = buildGoogleEventBody(source, event);
  const query = googleWriteQuery(event);
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Google event aanmaken mislukt.');
  return googleEventToBaseEvent(payload, source, event);
}

// ── Microsoft ────────────────────────────────────────────────────────────────

export function buildMicrosoftEventBody(event: NormalizedEventInput): Record<string, unknown> {
  let start: { dateTime: string; timeZone: string };
  let end: { dateTime: string; timeZone: string };
  if (event.allDay) {
    // Microsoft Graph: all-day events gebruiken ook exclusieve einddatums.
    // dateTime = middernacht UTC, timeZone: 'UTC'.
    const startDate = event.startsAt.slice(0, 10);
    const endDateRaw = event.endsAt.slice(0, 10);
    const endExclusive = endDateRaw <= startDate ? nextDay(startDate) : nextDay(endDateRaw);
    start = { dateTime: `${startDate}T00:00:00`, timeZone: 'UTC' };
    end = { dateTime: `${endExclusive}T00:00:00`, timeZone: 'UTC' };
  } else {
    start = { dateTime: toMicrosoftDateTime(event.startsAt), timeZone: 'UTC' };
    end = { dateTime: toMicrosoftDateTime(event.endsAt), timeZone: 'UTC' };
  }
  // Geplakte link onderaan de omschrijving; automatische Teams-vergadering via isOnlineMeeting.
  const content = event.addConference ? (event.description || '') : (withMeetingLine(event.description, event.meetingUrl) || '');
  const body: Record<string, unknown> = {
    subject: event.title,
    body: { contentType: 'HTML', content },
    // Altijd meesturen (ook leeg) zodat een gewiste locatie bij bewerken ook echt verdwijnt.
    location: { displayName: event.location || '' },
    isAllDay: event.allDay,
    start,
    end,
  };
  if (event.addConference) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = 'teamsForBusiness';
  }
  if (event.attendees.length) {
    body.attendees = event.attendees.map(a => ({
      emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
      type: a.role === 'opt' ? 'optional' : 'required',
    }));
  }
  return body;
}

export function microsoftEventToBaseEvent(payload: Record<string, unknown>, source: CalendarSourceRow, event: NormalizedEventInput) {
  const location = (payload.location ?? {}) as Record<string, string>;
  const start = (payload.start ?? {}) as Record<string, string>;
  const end = (payload.end ?? {}) as Record<string, string>;
  const onlineMeeting = (payload.onlineMeeting ?? {}) as Record<string, string>;
  const allDay = Boolean(payload.isAllDay);
  const allDayRange = allDay ? normalizeAllDayEventRange(start.dateTime || event.startsAt, end.dateTime || event.endsAt) : null;
  const rawDescription = payload.bodyPreview ? String(payload.bodyPreview) : event.description;
  const locationName = location.displayName ? String(location.displayName) : event.location;
  return {
    id: `${source.id}:${String(payload.id)}`,
    provider: 'microsoft' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: String(payload.id),
    title: String(payload.subject || event.title),
    description: stripMeetingLine(rawDescription),
    location: locationName,
    meeting_url: readMeetingUrl(onlineMeeting.joinUrl ? String(onlineMeeting.joinUrl) : null, rawDescription, locationName),
    attendees: mapMicrosoftAttendees(payload),
    starts_at: allDayRange ? allDayRange.starts_at : normalizeMicrosoftDateTime(start.dateTime || event.startsAt),
    ends_at: allDayRange ? allDayRange.ends_at : normalizeMicrosoftDateTime(end.dateTime || event.endsAt),
    all_day: allDay,
    html_link: payload.webLink ? String(payload.webLink) : null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

export async function createMicrosoftEvent(accessToken: string, source: CalendarSourceRow, event: NormalizedEventInput) {
  const body = buildMicrosoftEventBody(event);
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(source.provider_calendar_id)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft event aanmaken mislukt.');
  return microsoftEventToBaseEvent(payload, source, event);
}

/** Schrijfrechten + geldig access-token voor een externe agenda-bron. */
export async function getExternalWriteAccessToken(organizationId: string, requesterUserId: string, source: CalendarSourceRow): Promise<string> {
  if (source.user_id !== requesterUserId && source.visibility !== 'organization') {
    throw new Error('Deze privé-agenda is niet met de organisatie gedeeld.');
  }
  if (!source.write_enabled) throw new Error('Zet eerst "Schrijven" aan voor deze agenda.');
  if (!sourceCanWrite(source)) throw new Error('Deze externe agenda is niet schrijfbaar volgens de provider.');
  if (!source.connection_id) throw new Error('Externe agenda-bron mist een koppeling.');
  const connection = await getConnection(organizationId, source.connection_id);
  if (connection.status !== 'active') {
    throw new Error(`Agenda-koppeling is niet actief (status: ${connection.status}). Koppel het account opnieuw.`);
  }
  const token = await getToken(organizationId, connection.id);
  return await refreshAccessToken(token);
}

// ── Native (eigen ResoFly) events ────────────────────────────────────────────

export async function createNativeEvent(organizationId: string, userId: string, source: CalendarSourceRow, input: Record<string, unknown>) {
  const event = normalizeNewEventInput(input);
  const rrule = normalizeRrule(input);
  const { data, error } = await supabaseAdmin.from('calendar_events').insert({
    organization_id: organizationId,
    source_id: source.id,
    created_by: userId,
    uid: `resofly-${crypto.randomUUID()}`,
    title: event.title,
    description: event.description,
    location: event.location,
    meeting_url: event.meetingUrl,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    all_day: event.allDay,
    timezone: source.timezone,
    rrule,
    recurs: rrule !== null,
  }).select('*').single();
  if (error) throw error;
  const row = data as NativeEventRow;
  // Genodigden + uitnodigingen mogen het aanmaken nooit laten falen.
  await applyAttendees(organizationId, source, row, input).catch(err => console.error('invite (create) failed', err));
  // Boekingsopties die nu overlappen met deze (mogelijk herhalende) afspraak zijn
  // niet meer daadwerkelijk beschikbaar; best-effort, mag het aanmaken nooit blokkeren.
  await cancelConflictingBookingSlotsForNativeEvent(organizationId, source, row);
  return nativeRowToBaseEvent(row, source);
}

// ── Genodigden + uitnodigingen (iMIP) — hergebruikt de mail-infrastructuur ───

export async function getEventAttendees(organizationId: string, requesterUserId: string, eventId: string): Promise<AttendeeRow[]> {
  if (!UUID_RE.test(eventId)) throw new Error('Ongeldig agenda-item.');
  const { data: ev } = await supabaseAdmin.from('calendar_events').select('source_id').eq('organization_id', organizationId).eq('id', eventId).single();
  if (!ev) return [];
  const { data: src } = await supabaseAdmin.from('calendar_sources').select('user_id,visibility').eq('id', ev.source_id).single();
  if (!src) return [];
  if (src.user_id !== requesterUserId && src.visibility !== 'organization') throw new Error('Geen toegang tot deze afspraak.');
  const { data } = await supabaseAdmin.from('calendar_event_attendees')
    .select('*').eq('event_id', eventId).order('created_at', { ascending: true });
  return (data ?? []) as AttendeeRow[];
}

// Slaat de genodigden op (toevoegen/wijzigen/verwijderen) en verstuurt iMIP-mail:
// REQUEST naar de huidige genodigden, CANCEL naar wie eraf is.
export async function applyAttendees(organizationId: string, source: CalendarSourceRow, eventRow: NativeEventRow, input: Record<string, unknown>): Promise<void> {
  const desired = parseAttendeesInput(input);
  const { data: existingRows } = await supabaseAdmin.from('calendar_event_attendees').select('*').eq('event_id', eventRow.id);
  const existing = (existingRows ?? []) as AttendeeRow[];
  if (desired.length === 0 && existing.length === 0) return;

  let organizerToken = eventRow.organizer_token;
  if (!organizerToken) {
    organizerToken = crypto.randomUUID().replace(/-/g, '');
    await supabaseAdmin.from('calendar_events').update({ organizer_token: organizerToken }).eq('id', eventRow.id);
  }

  const desiredEmails = new Set(desired.map(d => d.email));
  const existingByEmail = new Map(existing.map(e => [String(e.email).toLowerCase(), e]));
  const removed = existing.filter(e => !desiredEmails.has(String(e.email).toLowerCase()));

  for (const d of desired) {
    const ex = existingByEmail.get(d.email);
    if (ex) {
      await supabaseAdmin.from('calendar_event_attendees').update({ display_name: d.name, role: d.role }).eq('id', ex.id);
    } else {
      await supabaseAdmin.from('calendar_event_attendees').insert({
        organization_id: organizationId, event_id: eventRow.id, email: d.email, display_name: d.name, role: d.role, status: 'needs-action',
      });
    }
  }
  if (removed.length) await supabaseAdmin.from('calendar_event_attendees').delete().in('id', removed.map(r => r.id));

  const { data: currentRows } = await supabaseAdmin.from('calendar_event_attendees').select('*').eq('event_id', eventRow.id);
  const current = (currentRows ?? []) as AttendeeRow[];

  if (!RESEND_API_KEY) return; // geen verzendconfiguratie: alleen opslaan
  const ctx = await buildOrganizerContext(organizationId, organizerToken);
  if (!ctx) return;

  if (current.length) {
    const ics = buildEventIcs(eventRow, current, ctx, 'REQUEST');
    for (const att of current) {
      await sendInviteEmail(ctx.from, att.email, `Uitnodiging: ${eventRow.title || 'Afspraak'}`, eventRow, ics, 'REQUEST').catch(err => console.error('invite send', att.email, err));
      await supabaseAdmin.from('calendar_event_attendees').update({ invited_at: new Date().toISOString(), last_sequence_sent: eventRow.sequence ?? 0 }).eq('id', att.id);
    }
  }
  if (removed.length) {
    const ics = buildEventIcs(eventRow, removed, ctx, 'CANCEL');
    for (const att of removed) {
      await sendInviteEmail(ctx.from, att.email, `Geannuleerd: ${eventRow.title || 'Afspraak'}`, eventRow, ics, 'CANCEL').catch(err => console.error('cancel send', att.email, err));
    }
  }
}

export async function sendEventCancellations(organizationId: string, _source: CalendarSourceRow, eventRow: NativeEventRow): Promise<void> {
  if (!eventRow.organizer_token || !RESEND_API_KEY) return;
  const { data: rows } = await supabaseAdmin.from('calendar_event_attendees').select('*').eq('event_id', eventRow.id);
  const attendees = (rows ?? []) as AttendeeRow[];
  if (!attendees.length) return;
  const ctx = await buildOrganizerContext(organizationId, eventRow.organizer_token);
  if (!ctx) return;
  const ics = buildEventIcs(eventRow, attendees, ctx, 'CANCEL');
  for (const att of attendees) {
    await sendInviteEmail(ctx.from, att.email, `Geannuleerd: ${eventRow.title || 'Afspraak'}`, eventRow, ics, 'CANCEL').catch(err => console.error('cancel send', att.email, err));
  }
}

interface OrganizerContext { from: string; organizerName: string; organizerEmail: string }

async function buildOrganizerContext(organizationId: string, organizerToken: string): Promise<OrganizerContext | null> {
  const sender = await resolveOrgSender(organizationId);
  if (!sender.from) return null;
  const organizerName = extractDisplayNameFromAddr(sender.from) || 'ResoFly';
  const organizerEmail = MAIL_INBOUND_DOMAIN
    ? `organizer+${organizerToken}@${MAIL_INBOUND_DOMAIN}`
    : (sender.fromEmail || extractEmailFromAddr(sender.from));
  return { from: sender.from, organizerName, organizerEmail };
}

// Inline afzender-resolutie (kopie van _shared/sendingDomain.ts) om een tweede
// _shared-import in deze functie te vermijden — die brak de boot van de functie.
async function resolveOrgSender(organizationId: string): Promise<{ from: string; fromEmail: string | null }> {
  const fallbackEmail = RESEND_FROM_EMAIL || '';
  const fallback = { from: fallbackEmail, fromEmail: fallbackEmail || null };
  try {
    const { data, error } = await supabaseAdmin
      .from('organization_email_domains')
      .select('from_email,from_name,status,is_default,created_at')
      .eq('organization_id', organizationId)
      .eq('status', 'verified')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data || !data.from_email) return fallback;
    const fromEmail = String(data.from_email);
    const fromName = String(data.from_name || '').trim();
    return { from: fromName ? `${fromName} <${fromEmail}>` : fromEmail, fromEmail };
  } catch {
    return fallback;
  }
}

export function buildEventIcs(ev: NativeEventRow, attendees: AttendeeRow[], ctx: OrganizerContext, method: 'REQUEST' | 'CANCEL'): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ResoFly//CalDAV//NL', `METHOD:${method}`, 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT'];
  lines.push(`UID:${icsEscape(ev.uid)}`);
  lines.push(`DTSTAMP:${icsStamp(new Date())}`);
  if (ev.all_day) {
    const start = new Date(ev.starts_at);
    let endEx = new Date(ev.ends_at);
    if (endEx.getTime() <= start.getTime()) { endEx = new Date(start.getTime()); endEx.setUTCDate(endEx.getUTCDate() + 1); }
    lines.push(`DTSTART;VALUE=DATE:${icsDateOnly(start)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDateOnly(endEx)}`);
  } else {
    lines.push(`DTSTART:${icsStamp(new Date(ev.starts_at))}`);
    lines.push(`DTEND:${icsStamp(new Date(ev.ends_at))}`);
  }
  lines.push(`SUMMARY:${icsEscape(ev.title || '(Geen titel)')}`);
  // Videocall-link ook in de omschrijving zetten zodat elke agenda-app hem toont,
  // plus de RFC 7986 CONFERENCE-property voor apps die een "deelnemen"-knop kennen.
  const description = ev.meeting_url ? `${ev.description ? `${ev.description}\n\n` : ''}Videocall: ${ev.meeting_url}` : ev.description;
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  if (ev.meeting_url) lines.push(`CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL=Videocall:${icsEscape(ev.meeting_url)}`);
  if (ev.rrule) lines.push(`RRULE:${ev.rrule}`);
  lines.push(`SEQUENCE:${ev.sequence ?? 0}`);
  lines.push(`ORGANIZER;CN=${icsParam(ctx.organizerName)}:mailto:${ctx.organizerEmail}`);
  for (const att of attendees) {
    const cn = att.display_name ? `;CN=${icsParam(att.display_name)}` : '';
    const partstat = method === 'CANCEL' ? 'DECLINED' : partstatToIcs(att.status);
    lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=${att.role === 'opt' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'};PARTSTAT=${partstat};RSVP=TRUE${cn}:mailto:${att.email}`);
  }
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

export async function sendInviteEmail(from: string, to: string, subject: string, ev: NativeEventRow, ics: string, method: 'REQUEST' | 'CANCEL'): Promise<void> {
  const when = ev.all_day
    ? new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeZone: 'Europe/Amsterdam' }).format(new Date(ev.starts_at))
    : new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(ev.starts_at));
  const intro = method === 'CANCEL'
    ? `De afspraak "${ev.title || 'Afspraak'}" is geannuleerd.`
    : `Je bent uitgenodigd voor "${ev.title || 'Afspraak'}".`;
  const text = `${intro}\n\nWanneer: ${when}${ev.location ? `\nLocatie: ${ev.location}` : ''}${ev.meeting_url && method !== 'CANCEL' ? `\nVideocall: ${ev.meeting_url}` : ''}`;
  const html = `<p>${escapeHtmlBasic(intro)}</p><p><strong>Wanneer:</strong> ${escapeHtmlBasic(when)}</p>${ev.location ? `<p><strong>Locatie:</strong> ${escapeHtmlBasic(ev.location)}</p>` : ''}${ev.meeting_url && method !== 'CANCEL' ? `<p><strong>Videocall:</strong> <a href="${escapeHtmlBasic(ev.meeting_url)}">${escapeHtmlBasic(ev.meeting_url)}</a></p>` : ''}`;
  const payload = {
    from, to: [to], subject, text, html,
    attachments: [{ filename: 'invite.ics', content: base64Utf8(ics), content_type: `text/calendar; method=${method}; charset=utf-8` }],
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

function partstatToIcs(status: string): string {
  switch (status) {
    case 'accepted': return 'ACCEPTED';
    case 'declined': return 'DECLINED';
    case 'tentative': return 'TENTATIVE';
    default: return 'NEEDS-ACTION';
  }
}

function icsStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}
function icsDateOnly(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`;
}
function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsParam(value: string): string {
  return `"${value.replace(/["\r\n]/g, '')}"`;
}
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) { parts.push(' ' + rest.slice(0, 74)); rest = rest.slice(74); }
  if (rest.length) parts.push(' ' + rest);
  return parts.join('\r\n');
}
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function extractDisplayNameFromAddr(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*</);
  return m ? m[1].trim() : '';
}
function extractEmailFromAddr(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}
function escapeHtmlBasic(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
