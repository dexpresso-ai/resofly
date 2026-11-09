// ============================================================
// Wat er naar Google of Microsoft gaat bij het aanmaken of bewerken van een
// afspraak: de body, en de omschrijving met de videocall-regel.
//
// Bewerken stuurt alleen mee wat verandert. Een veld dat de aanroeper niet
// noemt (undefined) gaat niet mee, en blijft dan bij Google en Microsoft zoals
// het is: hun PATCH laat ontbrekende velden staan. Eerst ging altijd alles mee,
// ook leeg. Zo wiste een wijziging via Gerrie ("verplaats naar drie uur") de
// omschrijving, de locatie en de videocall-regel van de afspraak.
//
// Puur (geen Deno, geen database): calendarEventBody.test.ts legt het vast;
// calendarEventWrite.ts gebruikt het, calendarCore.ts geeft de datumhulpjes door.
// ============================================================

import { markedMeetingUrl, stripMeetingLine, withMeetingLine } from './meetingLinks.ts';

/** "YYYY-MM-DD" → de dag erna, als "YYYY-MM-DD". */
export function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z'); // 12:00 UTC: geen gedoe rond zomertijd
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Een ISO-tijd zoals Graph hem wil: zonder milliseconden en zonder Z (met timeZone 'UTC'). */
export function toMicrosoftDateTime(value: string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, '');
}

export type EventAttendeeInput = { email: string; name: string | null; role: 'req' | 'opt' };

export type ExternalEventDraft = {
  title: string;
  /** UTC ISO; bij een hele dag telt alleen de datum. */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  /** De omschrijving zoals hij weggaat, met een eventuele videocall-regel. Undefined = niet meesturen. */
  description?: string | null;
  /** Undefined = niet meesturen. */
  location?: string | null;
  /** Undefined = niet meesturen (de genodigden blijven zoals ze zijn). */
  attendees?: EventAttendeeInput[];
};

/** Begin en einde van een hele dag: de provider wil een exclusieve einddatum. */
function allDayRange(draft: ExternalEventDraft): { start: string; endExclusive: string } {
  const start = draft.startsAt.slice(0, 10);
  const end = draft.endsAt.slice(0, 10);
  return { start, endExclusive: end <= start ? nextDay(start) : nextDay(end) };
}

/**
 * De body voor Google (events.insert / events.patch). `conferenceRequestId`
 * gezet = Google maakt er een Meet bij (met conferenceDataVersion=1). Per
 * aanvraag een nieuwe id: Google negeert een aanvraag met dezelfde id als de
 * vorige.
 */
export function googleEventBody(timezone: string | null, draft: ExternalEventDraft, conferenceRequestId: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { summary: draft.title };
  if (draft.description !== undefined) body.description = draft.description;
  if (draft.location !== undefined) body.location = draft.location;
  if (draft.allDay) {
    // Google: end.date is exclusief. Een dag op 2026-05-08 is 08 tot 09.
    const { start, endExclusive } = allDayRange(draft);
    body.start = { date: start };
    body.end = { date: endExclusive };
  } else {
    const tz = timezone || undefined;
    body.start = { dateTime: draft.startsAt, timeZone: tz };
    body.end = { dateTime: draft.endsAt, timeZone: tz };
  }
  if (conferenceRequestId) {
    body.conferenceData = { createRequest: { requestId: conferenceRequestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }
  if (draft.attendees !== undefined && draft.attendees.length) {
    body.attendees = draft.attendees.map(a => ({ email: a.email, ...(a.name ? { displayName: a.name } : {}), optional: a.role === 'opt' }));
  }
  return body;
}

/** De body voor Microsoft Graph (POST/PATCH /events). `teams` = Outlook maakt er een Teams-vergadering bij. */
export function microsoftEventBody(draft: ExternalEventDraft, teams: boolean): Record<string, unknown> {
  let start: { dateTime: string; timeZone: string };
  let end: { dateTime: string; timeZone: string };
  if (draft.allDay) {
    // Graph: ook een exclusieve einddatum, middernacht in UTC.
    const range = allDayRange(draft);
    start = { dateTime: `${range.start}T00:00:00`, timeZone: 'UTC' };
    end = { dateTime: `${range.endExclusive}T00:00:00`, timeZone: 'UTC' };
  } else {
    start = { dateTime: toMicrosoftDateTime(draft.startsAt), timeZone: 'UTC' };
    end = { dateTime: toMicrosoftDateTime(draft.endsAt), timeZone: 'UTC' };
  }
  const body: Record<string, unknown> = { subject: draft.title, isAllDay: draft.allDay, start, end };
  if (draft.description !== undefined) body.body = { contentType: 'HTML', content: draft.description || '' };
  // Ook leeg meesturen als hij genoemd is: zo verdwijnt een gewiste locatie echt.
  if (draft.location !== undefined) body.location = { displayName: draft.location || '' };
  if (teams) {
    body.isOnlineMeeting = true;
    body.onlineMeetingProvider = 'teamsForBusiness';
  }
  if (draft.attendees !== undefined && draft.attendees.length) {
    body.attendees = draft.attendees.map(a => ({
      emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
      type: a.role === 'opt' ? 'optional' : 'required',
    }));
  }
  return body;
}

/**
 * De omschrijving die naar de provider gaat, met de videocall-regel.
 *
 * - `description`: wat de aanroeper meestuurde (undefined = niet genoemd).
 * - `line`: 'keep' = de bestaande regel blijven; een link = die regel; null = geen regel.
 * - `current`: de omschrijving zoals hij nu bij de provider staat, mét regel.
 *   Alleen nodig als niet alles bekend is (needsCurrentDescription).
 *
 * Google krijgt de regel onderaan, Microsoft bovenaan (Graph geeft bij het
 * ophalen alleen de eerste 255 tekens; zie meetingLinks.ts).
 */
export function describeForProvider(
  provider: 'google' | 'microsoft',
  description: string | null | undefined,
  line: string | null | 'keep',
  current: string | null,
): string | null | undefined {
  if (description === undefined && line === 'keep') return undefined;
  const base = description !== undefined ? description : stripMeetingLine(current);
  const url = line === 'keep' ? markedMeetingUrl(current) : line;
  return withMeetingLine(base, url, provider === 'microsoft' ? 'start' : 'end');
}

/** Moet de huidige omschrijving eerst bij de provider opgehaald worden? */
export function needsCurrentDescription(description: string | null | undefined, line: string | null | 'keep'): boolean {
  return (description === undefined) !== (line === 'keep');
}
