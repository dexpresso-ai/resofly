// ============================================================
// Gedeelde agenda-schrijf-/genodigdenlaag
//
// Maakt en wijzigt agenda-items op native + Google + Microsoft agenda's en
// verzorgt de genodigden + iMIP-uitnodigingen (native items) via de
// mail-infrastructuur. Hergebruikt door `calendar-integrations`
// (createEvent/updateEvent/deleteEvent) en de meeting-booking-functies
// (agenda-item aanmaken na een boeking).
//
// Videovergadering (conference.ts): Meet op een Google-agenda en Teams op een
// Microsoft-agenda maakt de agenda zelf; elders maakt onlineMeetings.ts hem los
// met de eigen koppeling van wie erom vraagt, en komt de link op de afspraak.
//
// Bewerken verandert alleen wat de aanroeper noemt. Wat hij weglaat
// (omschrijving, locatie, genodigden, herhaling, video) blijft zoals het is.
// Eerst werd een weggelaten veld leeg: een wijziging via Gerrie ("verplaats naar
// drie uur") wiste de omschrijving, de locatie en de videolink, en bij een
// ResoFly-afspraak kregen alle genodigden een afzegging.
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
  stripMeetingLine,
  readMeetingUrl,
  googleConferenceUrl,
  mapGoogleAttendees,
  mapMicrosoftAttendees,
  normalizeAllDayEventRange,
  normalizeMicrosoftDateTime,
  normalizeRrule,
  sourceCanWrite,
  ProviderHttpError,
  EMAIL_RE,
  UUID_RE,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  MAIL_INBOUND_DOMAIN,
} from './calendarCore.ts';
import { describeForProvider, googleEventBody, microsoftEventBody, needsCurrentDescription, type ExternalEventDraft } from './calendarEventBody.ts';
import {
  type VideoPlan,
  calendarConferenceBlockedReason,
  googleEventConference,
  microsoftEventConference,
  parseVideoRequest,
  planVideo,
  serviceOfUrl,
} from './conference.ts';
import { createStandaloneMeeting } from './onlineMeetings.ts';
import { nativeRowToBaseEvent } from './calendarAvailability.ts';
import { cancelConflictingBookingSlots, cancelConflictingBookingSlotsForNativeEvent } from './meetingBookingSync.ts';
import { takeEmailQuota } from './emailQuota.ts';
// emailBrand.ts heeft zelf alleen pure imports (de sjabloonmap), dus geen
// tweede keten zoals sendingDomain.ts die de boot van deze functie brak.
import { loadEmailBrand, withEmailBrand, type EmailBrand } from './emailBrand.ts';
// resendDomains.ts heeft helemaal geen imports.
import { formatFromHeader, isPlainEmailAddress } from './resendDomains.ts';
import { EMAIL_LOGO_SLOT_LIGHT } from './emailTemplates/layout.ts';

// ── Invoer normaliseren ─────────────────────────────────────────────────────

/** Meer deelnemers per afspraak gaat niet: elke uitnodiging is een mail met de
 *  afzender van het platform, en zonder grens was een afspraak met duizenden
 *  adressen een verzendlijst. */
export const MAX_EVENT_ATTENDEES = 50;

export function parseAttendeesInput(input: Record<string, unknown>): Array<{ email: string; name: string | null; role: 'req' | 'opt' }> {
  const raw = input.attendees;
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_EVENT_ATTENDEES) {
    throw new Error(`Een afspraak heeft maximaal ${MAX_EVENT_ATTENDEES} deelnemers.`);
  }
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

function mentioned(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
}

/** Titel en tijden, voor aanmaken én bewerken verplicht. */
function eventCore(input: Record<string, unknown>) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Eventtitel ontbreekt.');
  return {
    title,
    startsAt: assertIso(String(input.startsAt || ''), 'startsAt'),
    endsAt: assertIso(String(input.endsAt || ''), 'endsAt'),
  };
}

function assertEventTimes(startsAt: string, endsAt: string, allDay: boolean): void {
  // Een afspraak met tijden eindigt ná het begin; een hele dag mag op één dag vallen.
  if (!allDay && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    throw new Error('Eindtijd moet na starttijd liggen.');
  }
  if (allDay && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw new Error('Einddatum mag niet voor startdatum liggen.');
  }
}

export function normalizeNewEventInput(input: Record<string, unknown>) {
  const core = eventCore(input);
  const allDay = Boolean(input.allDay);
  assertEventTimes(core.startsAt, core.endsAt, allDay);
  return {
    ...core,
    allDay,
    description: input.description ? String(input.description) : null,
    location: input.location ? String(input.location) : null,
    video: parseVideoRequest(input),
    attendees: parseAttendeesInput(input),
  };
}

/**
 * Invoer voor een bewerking. Undefined = niet genoemd = blijft zoals het is.
 * `allDay` controleert pas de aanroeper (die kent bij een ResoFly-afspraak de
 * huidige stand).
 */
export function normalizeEventUpdate(input: Record<string, unknown>) {
  return {
    ...eventCore(input),
    allDay: mentioned(input, 'allDay') ? Boolean(input.allDay) : undefined,
    description: mentioned(input, 'description') ? (input.description ? String(input.description) : null) : undefined,
    location: mentioned(input, 'location') ? (input.location ? String(input.location) : null) : undefined,
    attendees: mentioned(input, 'attendees') ? parseAttendeesInput(input) : undefined,
    recurrenceMentioned: mentioned(input, 'recurrence') || mentioned(input, 'rrule'),
    video: parseVideoRequest(input),
  };
}

/**
 * De link die op de afspraak komt: een gewone link, of een losse Meet/Teams
 * die nu gemaakt wordt met de koppeling van de aanvrager. Null bij geen video
 * of als de agenda de vergadering zelf maakt.
 */
async function meetingLinkFor(
  organizationId: string,
  requesterUserId: string,
  plan: VideoPlan,
  event: { title: string; startsAt: string; endsAt: string },
): Promise<string | null> {
  if (plan.kind === 'link') return plan.url;
  if (plan.kind === 'standalone') {
    const meeting = await createStandaloneMeeting(organizationId, requesterUserId, plan.service, event);
    return meeting.url;
  }
  return null;
}

function withWarning<T extends Record<string, unknown>>(event: T, warnings: Array<string | null>): T & { video_warning?: string } {
  const text = warnings.filter(Boolean).join(' ');
  return text ? { ...event, video_warning: text } : event;
}

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
  // Dezelfde controles als bewerken en verwijderen (schrijven aan, mag bij de
  // provider, koppeling niet ingetrokken). Hier stond eerst een eigen kopie die
  // alleen "active" doorliet: met "error" door één verdwenen agenda kon je dan
  // geen enkele afspraak meer in je hoofdagenda zetten.
  const accessToken = await getExternalWriteAccessToken(organizationId, requesterUserId, calendarSource);
  const event = normalizeNewEventInput(input);
  const plan = planVideo(calendarSource.provider, calendarSource.conference_types, event.video, 'create');
  const link = await meetingLinkFor(organizationId, requesterUserId, plan, event);
  const draft: ExternalEventDraft = {
    title: event.title, startsAt: event.startsAt, endsAt: event.endsAt, allDay: event.allDay,
    description: describeForProvider(calendarSource.provider as 'google' | 'microsoft', event.description, link, null),
    location: event.location,
    attendees: event.attendees,
  };
  const ownConference = plan.kind === 'calendar';
  const result = calendarSource.provider === 'google'
    ? await createGoogleEvent(accessToken, calendarSource, draft, ownConference)
    : await createMicrosoftEvent(accessToken, calendarSource, draft, ownConference);
  // Deze nieuwe afspraak kan een tot nu toe openstaande boekingsoptie op dezelfde
  // agenda overlappen — die is dan niet meer daadwerkelijk beschikbaar voor de
  // klant. Google/Microsoft ondersteunen hier geen herhaling, dus één voorkomst volstaat.
  await cancelConflictingBookingSlots(organizationId, calendarSource.id, String(result.starts_at ?? ''), String(result.ends_at ?? ''));
  return result;
}

// ── Google ──────────────────────────────────────────────────────────────────

function googleEventUrl(source: CalendarSourceRow, eventId?: string): string {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

export function googleEventToBaseEvent(payload: Record<string, unknown>, source: CalendarSourceRow, fallback: ExternalEventDraft) {
  const start = (payload.start ?? {}) as Record<string, string>;
  const end = (payload.end ?? {}) as Record<string, string>;
  const allDay = Boolean(start.date && !start.dateTime);
  const allDayRange = allDay ? normalizeAllDayEventRange(start.date, end.date) : null;
  const rawDescription = payload.description ? String(payload.description) : (fallback.description ?? null);
  const location = payload.location ? String(payload.location) : (fallback.location ?? null);
  return {
    id: `${source.id}:${String(payload.id)}`,
    provider: 'google' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: String(payload.id),
    title: String(payload.summary || fallback.title),
    description: stripMeetingLine(rawDescription),
    location,
    meeting_url: readMeetingUrl(googleConferenceUrl(payload), rawDescription, location),
    conference: googleEventConference(payload),
    attendees: mapGoogleAttendees(payload),
    starts_at: allDayRange ? allDayRange.starts_at : String(start.dateTime),
    ends_at: allDayRange ? allDayRange.ends_at : String(end.dateTime),
    all_day: allDay,
    html_link: payload.htmlLink ? String(payload.htmlLink) : null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

async function googleJson(res: Response): Promise<Record<string, unknown>> {
  return await res.json().catch(() => ({})) as Record<string, unknown>;
}

function providerErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  const message = (payload.error as Record<string, unknown> | undefined)?.message;
  return typeof message === 'string' && message ? message : fallback;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Google maakt een Meet asynchroon. Meestal staat de link al in het antwoord;
 * staat hij nog op "pending", dan nog even vragen. Zonder dit kreeg een klant
 * die boekte soms een bevestiging zonder link.
 */
async function settleGoogleConference(accessToken: string, source: CalendarSourceRow, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  let current = payload;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (googleEventConference(current)?.status !== 'pending') break;
    await sleep(500 * attempt);
    const res = await fetch(googleEventUrl(source, String(payload.id)), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) break;
    current = await googleJson(res);
  }
  return current;
}

/** Wat de gebruiker hoort als er om een Meet gevraagd is en die er (nog) niet is. */
function googleMeetWarning(payload: Record<string, unknown>): string | null {
  const conference = googleEventConference(payload);
  if (conference?.service === 'google_meet' && conference.status === 'ready') return null;
  if (conference?.status === 'pending') return 'Google maakt de Meet-link nog aan; hij staat zo bij de afspraak.';
  if (conference?.status === 'failed') return 'Google kon geen Meet-vergadering maken. Probeer het opnieuw, of kies een andere videovergadering.';
  return `Google zette er geen Meet-vergadering bij. ${calendarConferenceBlockedReason('google')}`;
}

export async function createGoogleEvent(accessToken: string, source: CalendarSourceRow, draft: ExternalEventDraft, withMeet: boolean) {
  const body = googleEventBody(source.timezone, draft, withMeet ? crypto.randomUUID() : null);
  const params = new URLSearchParams();
  if (withMeet) params.set('conferenceDataVersion', '1');
  if (draft.attendees?.length) params.set('sendUpdates', 'all');
  const query = params.toString() ? `?${params}` : '';
  const res = await fetch(`${googleEventUrl(source)}${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await googleJson(res);
  if (!res.ok) throw new Error(providerErrorMessage(payload, 'Google event aanmaken mislukt.'));
  const settled = withMeet ? await settleGoogleConference(accessToken, source, payload) : payload;
  return withWarning(googleEventToBaseEvent(settled, source, draft), [withMeet ? googleMeetWarning(settled) : null]);
}

/** Eén Google-afspraak ophalen, met alleen de velden die nodig zijn. */
async function fetchGoogleEvent(accessToken: string, source: CalendarSourceRow, eventId: string, fields: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${googleEventUrl(source, eventId)}?fields=${encodeURIComponent(fields)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const payload = await googleJson(res);
  if (!res.ok) throw new ProviderHttpError(res.status, providerErrorMessage(payload, 'Google-afspraak ophalen mislukt.'));
  return payload;
}

/**
 * Haalt de Meet die Google zelf op de afspraak zette eraf (na overstappen naar
 * een andere videovergadering, of "Geen"). Lukt het niet, dan blijft de
 * afspraak zoals hij net is opgeslagen en hoort de gebruiker het.
 */
async function removeGoogleMeet(accessToken: string, source: CalendarSourceRow, eventId: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${googleEventUrl(source, eventId)}?conferenceDataVersion=1&sendUpdates=all`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conferenceData: null }),
    });
    const payload = await googleJson(res);
    if (!res.ok) {
      console.warn('Google Meet weghalen geweigerd', res.status, providerErrorMessage(payload, ''));
      return null;
    }
    return googleEventConference(payload)?.service === 'google_meet' ? null : payload;
  } catch (err) {
    console.warn('Google Meet weghalen mislukt', err);
    return null;
  }
}

async function updateGoogleEvent(accessToken: string, source: CalendarSourceRow, eventId: string, draft: ExternalEventDraft, plan: VideoPlan, removeConference: boolean) {
  // Een Meet die er al op staat, blijft: een nieuwe createRequest gaf de
  // afspraak een tweede, andere link, terwijl de genodigden de eerste hebben.
  let withMeet = false;
  if (plan.kind === 'calendar') {
    const conference = googleEventConference(await fetchGoogleEvent(accessToken, source, eventId, 'conferenceData,hangoutLink'));
    withMeet = !(conference?.service === 'google_meet' && conference.status !== 'failed');
  }
  const body = googleEventBody(source.timezone, draft, withMeet ? crypto.randomUUID() : null);
  // Altijd de genodigden laten weten wat er verandert: Google mailt alleen als
  // er genodigden zijn. Eerst alleen als de aanroeper ze meestuurde, en dan
  // hoorde bij een verplaatsing via Gerrie niemand van de nieuwe tijd.
  const params = new URLSearchParams({ sendUpdates: 'all' });
  if (withMeet) params.set('conferenceDataVersion', '1');
  const res = await fetch(`${googleEventUrl(source, eventId)}?${params}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = await googleJson(res);
  if (!res.ok) throw new Error(providerErrorMessage(payload, 'Google event bijwerken mislukt.'));
  const warnings: Array<string | null> = [];
  if (withMeet) {
    payload = await settleGoogleConference(accessToken, source, payload);
    warnings.push(googleMeetWarning(payload));
  }
  if (removeConference && plan.kind !== 'calendar' && googleEventConference(payload)?.service === 'google_meet') {
    const removed = await removeGoogleMeet(accessToken, source, eventId);
    if (removed) payload = removed;
    else warnings.push('De Google Meet-vergadering kon ResoFly niet van de afspraak halen. Haal hem weg in Google Agenda als je hem niet meer wilt.');
  }
  return withWarning(googleEventToBaseEvent(payload, source, draft), warnings);
}

// ── Microsoft ────────────────────────────────────────────────────────────────

export function microsoftEventToBaseEvent(payload: Record<string, unknown>, source: CalendarSourceRow, fallback: ExternalEventDraft) {
  const location = (payload.location ?? {}) as Record<string, string>;
  const start = (payload.start ?? {}) as Record<string, string>;
  const end = (payload.end ?? {}) as Record<string, string>;
  const onlineMeeting = (payload.onlineMeeting ?? {}) as Record<string, string>;
  const allDay = Boolean(payload.isAllDay);
  const allDayRange = allDay ? normalizeAllDayEventRange(start.dateTime || fallback.startsAt, end.dateTime || fallback.endsAt) : null;
  const rawDescription = payload.bodyPreview ? String(payload.bodyPreview) : (fallback.description ?? null);
  const locationName = location.displayName ? String(location.displayName) : (fallback.location ?? null);
  return {
    id: `${source.id}:${String(payload.id)}`,
    provider: 'microsoft' as Provider,
    source_id: source.id,
    source_name: source.name,
    provider_event_id: String(payload.id),
    title: String(payload.subject || fallback.title),
    description: stripMeetingLine(rawDescription),
    location: locationName,
    meeting_url: readMeetingUrl(onlineMeeting.joinUrl ? String(onlineMeeting.joinUrl) : null, rawDescription, locationName),
    conference: microsoftEventConference(payload),
    attendees: mapMicrosoftAttendees(payload),
    starts_at: allDayRange ? allDayRange.starts_at : normalizeMicrosoftDateTime(start.dateTime || fallback.startsAt),
    ends_at: allDayRange ? allDayRange.ends_at : normalizeMicrosoftDateTime(end.dateTime || fallback.endsAt),
    all_day: allDay,
    html_link: payload.webLink ? String(payload.webLink) : null,
    visibility: source.visibility,
    is_private_masked: false,
  };
}

/** Gevraagd om Teams, maar Microsoft zette er geen bij (een privé-account maakt er geen). */
function teamsWarning(payload: Record<string, unknown>): string | null {
  const conference = microsoftEventConference(payload);
  if (conference?.service === 'teams' && conference.url) return null;
  return `Microsoft zette er geen Teams-vergadering bij. ${calendarConferenceBlockedReason('microsoft')}`;
}

export async function createMicrosoftEvent(accessToken: string, source: CalendarSourceRow, draft: ExternalEventDraft, withTeams: boolean) {
  const body = microsoftEventBody(draft, withTeams);
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(source.provider_calendar_id)}/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft event aanmaken mislukt.');
  return withWarning(microsoftEventToBaseEvent(payload, source, draft), [withTeams ? teamsWarning(payload) : null]);
}

async function updateMicrosoftEvent(accessToken: string, source: CalendarSourceRow, eventId: string, draft: ExternalEventDraft, plan: VideoPlan, removeConference: boolean) {
  // isOnlineMeeting nog eens op true zetten verandert niets aan een bestaande
  // Teams-vergadering: Outlook houdt de vergadering die er al is.
  const withTeams = plan.kind === 'calendar';
  const body = microsoftEventBody(draft, withTeams);
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error?.message || 'Microsoft event bijwerken mislukt.');
  const warnings: Array<string | null> = [withTeams ? teamsWarning(payload) : null];
  // Microsoft laat een Teams-vergadering niet van een afspraak halen
  // (isOnlineMeeting terug op false negeert Outlook). Dan eerlijk zeggen.
  if (removeConference && !withTeams && microsoftEventConference(payload)?.service === 'teams') {
    warnings.push('De Teams-vergadering blijft in Outlook bij de afspraak staan: Microsoft laat die niet via een koppeling weghalen. Haal hem daar weg als je hem niet meer wilt.');
  }
  return withWarning(microsoftEventToBaseEvent(payload, source, draft), warnings);
}

/**
 * De omschrijving zoals hij nu bij Google of Microsoft staat, mét de
 * videocall-regel. Alleen nodig als een bewerking de omschrijving of de video
 * aanraakt zonder de ander te noemen. Bij Microsoft als platte tekst: de
 * preview in de lijst is maar 255 tekens.
 */
async function fetchExternalDescription(accessToken: string, source: CalendarSourceRow, eventId: string): Promise<string | null> {
  if (source.provider === 'google') {
    const payload = await fetchGoogleEvent(accessToken, source, eventId, 'description');
    return payload.description ? String(payload.description) : null;
  }
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}?$select=body`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.body-content-type="text"' },
  });
  const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new ProviderHttpError(res.status, providerErrorMessage(payload, 'Microsoft-afspraak ophalen mislukt.'));
  const content = (payload.body as Record<string, unknown> | undefined)?.content;
  return typeof content === 'string' && content.trim() ? content.trim() : null;
}

/** Bewerkt een Google- of Microsoft-afspraak; alleen wat genoemd is verandert. */
export async function updateExternalEvent(organizationId: string, requesterUserId: string, source: CalendarSourceRow, input: Record<string, unknown>) {
  const providerEventId = String(input.providerEventId || input.eventId || '');
  if (!providerEventId) throw new Error('Onbekend agenda-item.');
  const accessToken = await getExternalWriteAccessToken(organizationId, requesterUserId, source);
  const update = normalizeEventUpdate(input);
  // Bij Google en Microsoft weten we zonder extra vraag niet of het een hele dag
  // was; elke aanroeper (het scherm, Gerrie) stuurt het daarom mee. Zo niet,
  // dan geldt: met tijden, zoals altijd.
  const allDay = update.allDay ?? false;
  assertEventTimes(update.startsAt, update.endsAt, allDay);
  const provider = source.provider as 'google' | 'microsoft';
  const plan = planVideo(provider, source.conference_types, update.video, 'update');
  const line = plan.kind === 'keep' ? 'keep' as const : await meetingLinkFor(organizationId, requesterUserId, plan, update);
  const current = needsCurrentDescription(update.description, line) ? await fetchExternalDescription(accessToken, source, providerEventId) : null;
  const draft: ExternalEventDraft = {
    title: update.title, startsAt: update.startsAt, endsAt: update.endsAt, allDay,
    description: describeForProvider(provider, update.description, line, current),
    location: update.location,
    attendees: update.attendees,
  };
  return provider === 'google'
    ? await updateGoogleEvent(accessToken, source, providerEventId, draft, plan, update.video.removeConference)
    : await updateMicrosoftEvent(accessToken, source, providerEventId, draft, plan, update.video.removeConference);
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
  // Alleen "ingetrokken" houdt hier tegen: dan is er geen token meer. Eerst
  // blokkeerde elke status behalve "active", ook "error" door één andere agenda
  // die niet meer bestond. Zo kon je wekenlang geen afspraak in je hoofdagenda
  // zetten. Bij "verlopen" probeert de vernieuwing het; lukt dat niet, dan
  // zegt die in gewone woorden dat je opnieuw moet koppelen.
  if (connection.status === 'revoked') {
    throw new Error('Deze agenda-koppeling is ingetrokken. Koppel het account opnieuw in Instellingen → Agenda.');
  }
  const token = await getToken(organizationId, connection.id);
  return await refreshAccessToken(token);
}

// ── Native (eigen ResoFly) events ────────────────────────────────────────────

export async function createNativeEvent(organizationId: string, userId: string, source: CalendarSourceRow, input: Record<string, unknown>) {
  const event = normalizeNewEventInput(input);
  const rrule = normalizeRrule(input);
  // Een ResoFly-agenda maakt zelf geen vergadering; Meet/Teams komt hier los
  // (met de koppeling van wie de afspraak maakt) en dan als gewone link.
  const plan = planVideo('native', null, event.video, 'create');
  const meetingUrl = await meetingLinkFor(organizationId, userId, plan, event);
  const { data, error } = await supabaseAdmin.from('calendar_events').insert({
    organization_id: organizationId,
    source_id: source.id,
    created_by: userId,
    uid: `resofly-${crypto.randomUUID()}`,
    title: event.title,
    description: event.description,
    location: event.location,
    meeting_url: meetingUrl,
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

/** Een ResoFly-agenda waarin de aanvrager mag schrijven: zijn eigen, of een gedeelde. */
export async function getWritableNativeSource(organizationId: string, requesterUserId: string, sourceId: string): Promise<CalendarSourceRow> {
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
  if (error || !data) throw new Error('Agenda-bron niet gevonden.');
  const source = data as CalendarSourceRow;
  if (source.provider !== 'native') throw new Error('Alleen items in een ResoFly-agenda kunnen hier bewerkt worden.');
  if (source.user_id !== requesterUserId && source.visibility !== 'organization') {
    throw new Error('Deze privé-agenda is niet met de organisatie gedeeld.');
  }
  return source;
}

/** Bewerkt een ResoFly-afspraak; alleen wat genoemd is verandert. */
export async function updateNativeEvent(organizationId: string, requesterUserId: string, input: Record<string, unknown>) {
  const eventId = String(input.eventId || input.id || '');
  if (!UUID_RE.test(eventId)) throw new Error('Ongeldig agenda-item.');
  const { data: row, error } = await supabaseAdmin.from('calendar_events').select('*').eq('organization_id', organizationId).eq('id', eventId).is('deleted_at', null).single();
  if (error || !row) throw new Error('Agenda-item niet gevonden.');
  const current = row as NativeEventRow;
  const source = await getWritableNativeSource(organizationId, requesterUserId, current.source_id);
  const update = normalizeEventUpdate(input);
  const allDay = update.allDay ?? current.all_day;
  assertEventTimes(update.startsAt, update.endsAt, allDay);
  const rrule = update.recurrenceMentioned ? normalizeRrule(input) : current.rrule;

  const plan = planVideo('native', null, update.video, 'update');
  // Staat er al een vergadering van de gevraagde dienst op, dan blijft die:
  // opnieuw opslaan mag de genodigden geen nieuwe link geven.
  const meetingUrl = plan.kind === 'keep' ? current.meeting_url
    : plan.kind === 'standalone' && serviceOfUrl(current.meeting_url) === plan.service ? current.meeting_url
    : await meetingLinkFor(organizationId, requesterUserId, plan, update);

  // Weggelaten afspraken in een reeks (exdate) horen bij het oude begin en de
  // oude regel. Blijven die gelijk, dan blijven ze weg; eerst kwamen ze bij elke
  // bewerking terug.
  const sameSeries = update.startsAt === new Date(current.starts_at).toISOString() && rrule === current.rrule;
  const { data: updated, error: updateError } = await supabaseAdmin.from('calendar_events').update({
    title: update.title,
    description: update.description !== undefined ? update.description : current.description,
    location: update.location !== undefined ? update.location : current.location,
    meeting_url: meetingUrl,
    starts_at: update.startsAt,
    ends_at: update.endsAt,
    all_day: allDay,
    rrule,
    recurs: rrule !== null,
    exdate: sameSeries ? current.exdate : null,
    // Wis de canonieke iCalendar-tekst: een wijziging vanuit de app moet door de
    // CalDAV-Worker opnieuw gegenereerd worden uit de bijgewerkte velden.
    icalendar_raw: null,
    sequence: (current.sequence ?? 0) + 1,
  }).eq('id', current.id).select('*').single();
  if (updateError || !updated) throw new Error('Agenda-item kon niet worden bijgewerkt.');
  const updatedRow = updated as NativeEventRow;
  // Genodigden niet genoemd: dezelfde genodigden, met de bijgewerkte uitnodiging.
  // Zijn die niet te lezen, dan geen uitnodigingen: liever niets dan iedereen
  // een afzegging.
  const attendeeInput: Record<string, unknown> | null = update.attendees !== undefined
    ? input
    : await currentAttendeesInput(organizationId, current.id).then(attendees => ({ attendees })).catch((err) => {
      console.error('genodigden lezen mislukt; geen uitnodigingen verstuurd', err);
      return null;
    });
  if (attendeeInput) await applyAttendees(organizationId, source, updatedRow, attendeeInput).catch(err => console.error('invite (update) failed', err));
  // Verplaatsen/herschalen (slepen, tijd bewerken) kan een (mogelijk herhalende)
  // afspraak alsnog over een openstaande boekingsoptie leggen.
  await cancelConflictingBookingSlotsForNativeEvent(organizationId, source, updatedRow);
  return nativeRowToBaseEvent(updatedRow, source);
}

async function currentAttendeesInput(organizationId: string, eventId: string): Promise<Array<{ email: string; name: string | null; role: string }>> {
  const { data, error } = await supabaseAdmin.from('calendar_event_attendees').select('email, display_name, role')
    .eq('organization_id', organizationId).eq('event_id', eventId);
  if (error) throw error;
  return ((data ?? []) as Array<{ email: string; display_name: string | null; role: string }>)
    .map(a => ({ email: a.email, name: a.display_name, role: a.role }));
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
    .select('*').eq('organization_id', organizationId).eq('event_id', eventId).order('created_at', { ascending: true });
  return (data ?? []) as AttendeeRow[];
}

// Slaat de genodigden op (toevoegen/wijzigen/verwijderen) en verstuurt iMIP-mail:
// REQUEST naar de huidige genodigden, CANCEL naar wie eraf is.
export async function applyAttendees(organizationId: string, source: CalendarSourceRow, eventRow: NativeEventRow, input: Record<string, unknown>): Promise<void> {
  const desired = parseAttendeesInput(input);
  const { data: existingRows } = await supabaseAdmin.from('calendar_event_attendees').select('*').eq('organization_id', organizationId).eq('event_id', eventRow.id);
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

  const { data: currentRows } = await supabaseAdmin.from('calendar_event_attendees').select('*').eq('organization_id', organizationId).eq('event_id', eventRow.id);
  const current = (currentRows ?? []) as AttendeeRow[];

  if (!RESEND_API_KEY) return; // geen verzendconfiguratie: alleen opslaan
  const ctx = await buildOrganizerContext(organizationId, organizerToken);
  if (!ctx) return;

  if (current.length) {
    // Elke uitnodiging is een mail via het gedeelde Resend-account: tel mee in
    // het quotum van de organisatie (20261101050000).
    await takeEmailQuota(supabaseAdmin, organizationId, current.length, (message) => new Error(message));
    const ics = buildEventIcs(eventRow, current, ctx, 'REQUEST');
    for (const att of current) {
      await sendInviteEmail(ctx.from, att.email, `Uitnodiging: ${eventRow.title || 'Afspraak'}`, eventRow, ics, 'REQUEST', ctx.brand).catch(err => console.error('invite send', att.email, err));
      await supabaseAdmin.from('calendar_event_attendees').update({ invited_at: new Date().toISOString(), last_sequence_sent: eventRow.sequence ?? 0 }).eq('id', att.id);
    }
  }
  if (removed.length) {
    const ics = buildEventIcs(eventRow, removed, ctx, 'CANCEL');
    for (const att of removed) {
      await sendInviteEmail(ctx.from, att.email, `Geannuleerd: ${eventRow.title || 'Afspraak'}`, eventRow, ics, 'CANCEL', ctx.brand).catch(err => console.error('cancel send', att.email, err));
    }
  }
}

export async function sendEventCancellations(organizationId: string, _source: CalendarSourceRow, eventRow: NativeEventRow): Promise<void> {
  if (!eventRow.organizer_token || !RESEND_API_KEY) return;
  const { data: rows } = await supabaseAdmin.from('calendar_event_attendees').select('*').eq('organization_id', organizationId).eq('event_id', eventRow.id);
  const attendees = (rows ?? []) as AttendeeRow[];
  if (!attendees.length) return;
  const ctx = await buildOrganizerContext(organizationId, eventRow.organizer_token);
  if (!ctx) return;
  const ics = buildEventIcs(eventRow, attendees, ctx, 'CANCEL');
  for (const att of attendees) {
    await sendInviteEmail(ctx.from, att.email, `Geannuleerd: ${eventRow.title || 'Afspraak'}`, eventRow, ics, 'CANCEL', ctx.brand).catch(err => console.error('cancel send', att.email, err));
  }
}

interface OrganizerContext {
  from: string;
  organizerName: string;
  organizerEmail: string;
  /** Naam en logo bovenaan de uitnodiging; één keer geladen voor alle genodigden. */
  brand?: EmailBrand;
}

async function buildOrganizerContext(organizationId: string, organizerToken: string): Promise<OrganizerContext | null> {
  const sender = await resolveOrgSender(organizationId);
  if (!sender.from) return null;
  const organizerName = extractDisplayNameFromAddr(sender.from) || 'ResoFly';
  const organizerEmail = MAIL_INBOUND_DOMAIN
    ? `organizer+${organizerToken}@${MAIL_INBOUND_DOMAIN}`
    : (sender.fromEmail || extractEmailFromAddr(sender.from));
  return { from: sender.from, organizerName, organizerEmail, brand: await loadEmailBrand(supabaseAdmin, organizationId) };
}

// Inline afzender-resolutie (kopie van _shared/sendingDomain.ts) om een tweede
// _shared-import in deze functie te vermijden — die brak de boot van de functie.
async function resolveOrgSender(organizationId: string): Promise<{ from: string; fromEmail: string | null }> {
  const fallbackEmail = RESEND_FROM_EMAIL || '';
  const fallback = { from: fallbackEmail, fromEmail: fallbackEmail || null };
  try {
    const { data, error } = await supabaseAdmin
      .from('organization_email_domains')
      .select('domain,from_email,from_name,status,is_default,created_at')
      .eq('organization_id', organizationId)
      .eq('status', 'verified')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });
    if (error || !data) return fallback;
    // Dezelfde keuze als resolveSenderIdentity: het eerste domein met een kaal
    // adres op dat domein. De naam ging hier eerst ongefilterd de From-header
    // in, zodat een naam met komma's of hoekhaken de uitnodiging liet weigeren.
    for (const row of data as Array<{ domain: string; from_email: string | null; from_name: string | null }>) {
      const fromEmail = String(row.from_email || '').trim().toLowerCase();
      if (!isPlainEmailAddress(fromEmail) || !fromEmail.endsWith(`@${String(row.domain).toLowerCase()}`)) continue;
      return { from: formatFromHeader(row.from_name, fromEmail), fromEmail };
    }
    return fallback;
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

/**
 * `brand`: het logo bovenaan de uitnodiging (ingesloten, zie emailBrand.ts). De
 * .ics blijft een gewone bijlage ernaast; het logo verandert daar niets aan.
 */
export async function sendInviteEmail(from: string, to: string, subject: string, ev: NativeEventRow, ics: string, method: 'REQUEST' | 'CANCEL', brand?: EmailBrand): Promise<void> {
  const when = ev.all_day
    ? new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeZone: 'Europe/Amsterdam' }).format(new Date(ev.starts_at))
    : new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(ev.starts_at));
  const intro = method === 'CANCEL'
    ? `De afspraak "${ev.title || 'Afspraak'}" is geannuleerd.`
    : `Je bent uitgenodigd voor "${ev.title || 'Afspraak'}".`;
  const text = `${intro}\n\nWanneer: ${when}${ev.location ? `\nLocatie: ${ev.location}` : ''}${ev.meeting_url && method !== 'CANCEL' ? `\nVideocall: ${ev.meeting_url}` : ''}`;
  const html = `${EMAIL_LOGO_SLOT_LIGHT}<p>${escapeHtmlBasic(intro)}</p><p><strong>Wanneer:</strong> ${escapeHtmlBasic(when)}</p>${ev.location ? `<p><strong>Locatie:</strong> ${escapeHtmlBasic(ev.location)}</p>` : ''}${ev.meeting_url && method !== 'CANCEL' ? `<p><strong>Videocall:</strong> <a href="${escapeHtmlBasic(ev.meeting_url)}">${escapeHtmlBasic(ev.meeting_url)}</a></p>` : ''}`;
  const payload = {
    from, to: [to], subject, text, html,
    attachments: [{ filename: 'invite.ics', content: base64Utf8(ics), content_type: `text/calendar; method=${method}; charset=utf-8` }],
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(withEmailBrand(payload, brand)),
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
