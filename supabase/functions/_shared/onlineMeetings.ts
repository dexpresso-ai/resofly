// ============================================================
// Losse Google Meet- en Teams-vergaderingen, buiten de agenda om.
//
// Voor een afspraak in de ResoFly-agenda, een boeking daarop, Teams op een
// Google-afspraak (of andersom) en "Nu vergaderen" in de teamchat: daar is geen
// Google- of Microsoft-afspraak om de vergadering aan te hangen. ResoFly maakt
// hem dan zelf:
//   Google    — Meet REST API, POST meet.googleapis.com/v2/spaces;
//   Microsoft — Graph, POST /me/onlineMeetings (alleen werk- of schoolaccounts).
//
// Altijd met een koppeling van wie erom vraagt, in deze organisatie: de
// database-vraag filtert op organization_id én user_id. Ook als een collega
// zijn agenda met het team deelt, maakt niemand een vergadering in diens
// Google- of Microsoft-account. En alleen met het recht dat iemand apart
// aanzette (calendarOAuth.ts: meetingScopes).
//
// De regels zelf (welke koppeling, wat een fout betekent) staan puur in
// conference.ts.
// ============================================================

import { supabaseAdmin, getToken, refreshAccessToken } from './calendarCore.ts';
import {
  type VideoService,
  type VideoServiceState,
  VideoUnavailableError,
  accountSupportsService,
  classifyMeetingFailure,
  createdMeetingUrl,
  meetingFailureMessage,
  pickMeetingConnection,
  serviceProvider,
  videoServiceStateMessage,
  VIDEO_SERVICES,
} from './conference.ts';

type ConnectionRow = {
  id: string;
  provider: string;
  status: string;
  scopes: string[] | null;
  created_at: string;
  provider_account_email: string | null;
};

/** De eigen koppelingen van deze gebruiker voor die dienst, met wat hun agenda's kunnen. */
async function ownConnections(organizationId: string, userId: string, service: VideoService) {
  const provider = serviceProvider(service);
  const [{ data: connections, error }, { data: sources }] = await Promise.all([
    supabaseAdmin.from('calendar_connections')
      .select('id, provider, status, scopes, created_at, provider_account_email')
      .eq('organization_id', organizationId).eq('user_id', userId).eq('provider', provider),
    supabaseAdmin.from('calendar_sources')
      .select('connection_id, conference_types')
      .eq('organization_id', organizationId).eq('user_id', userId).eq('provider', provider),
  ]);
  if (error) throw error;
  const types = new Map<string, Array<string[] | null>>();
  for (const row of (sources ?? []) as Array<{ connection_id: string | null; conference_types?: string[] | null }>) {
    if (!row.connection_id) continue;
    types.set(row.connection_id, [...(types.get(row.connection_id) ?? []), row.conference_types ?? null]);
  }
  const rows = (connections ?? []) as ConnectionRow[];
  return pickMeetingConnection(service, rows, (c) => accountSupportsService(service, types.get(c.id) ?? []));
}

export type VideoServiceStatus = {
  state: VideoServiceState;
  /** Het account dat gebruikt wordt (of waarvoor toestemming nodig is). Alleen van de gebruiker zelf. */
  account: string | null;
  connectionId: string | null;
};

/** Per dienst: kan deze gebruiker hier een losse vergadering maken, en zo niet, waarom niet. */
export async function videoServiceStatus(organizationId: string, userId: string): Promise<Record<VideoService, VideoServiceStatus>> {
  const entries = await Promise.all(VIDEO_SERVICES.map(async (service) => {
    const pick = await ownConnections(organizationId, userId, service);
    const connection = pick.connection as ConnectionRow | null;
    return [service, { state: pick.state, account: connection?.provider_account_email ?? null, connectionId: connection?.id ?? null }] as const;
  }));
  return Object.fromEntries(entries) as Record<VideoService, VideoServiceStatus>;
}

const MEETING_TIMEOUT_MS = 15_000;

/**
 * Maakt een losse Meet- of Teams-vergadering en geeft de deelnamelink.
 * `title`, `startsAt`, `endsAt` gaan alleen naar Microsoft (Teams toont ze bij
 * de vergadering); een Meet-ruimte heeft geen titel of tijd.
 */
export async function createStandaloneMeeting(
  organizationId: string,
  userId: string,
  service: VideoService,
  details: { title?: string | null; startsAt?: string | null; endsAt?: string | null } = {},
): Promise<{ url: string; account: string | null }> {
  const pick = await ownConnections(organizationId, userId, service);
  const connection = pick.connection as ConnectionRow | null;
  if (pick.state !== 'klaar' || !connection) {
    throw new VideoUnavailableError(videoServiceStateMessage(service, pick.state), pick.state === 'account' ? 403 : 409);
  }
  // Mislukt het vernieuwen, dan zet refreshAccessToken de koppeling zelf op
  // "verlopen" met uitleg, en komt die uitleg hier als fout mee.
  const accessToken = await refreshAccessToken(await getToken(organizationId, connection.id));

  const request = service === 'google_meet'
    ? { url: 'https://meet.googleapis.com/v2/spaces', body: {} }
    : { url: 'https://graph.microsoft.com/v1.0/me/onlineMeetings', body: teamsMeetingBody(details) };
  let status = 0;
  let payload: unknown = null;
  try {
    const res = await fetch(request.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(MEETING_TIMEOUT_MS),
    });
    status = res.status;
    payload = await res.json().catch(() => null);
  } catch (err) {
    console.warn('losse vergadering: netwerkfout', service, err);
  }
  if (status >= 200 && status < 300) {
    const url = createdMeetingUrl(service, payload);
    if (url) return { url, account: connection.provider_account_email };
    console.error('losse vergadering: geen bruikbare link in het antwoord', service, status);
    throw new VideoUnavailableError(meetingFailureMessage(service, 'mislukt'), 502);
  }
  const failure = classifyMeetingFailure(service, status, payload);
  // De tekst van Google of Microsoft blijft in het log; de gebruiker leest de onze.
  console.warn('losse vergadering mislukt', service, status, failure, JSON.stringify(payload)?.slice(0, 400));
  throw new VideoUnavailableError(meetingFailureMessage(service, failure), failure === 'tijdelijk' ? 503 : failure === 'mislukt' ? 502 : 409);
}

/** Onderwerp en tijden voor Graph; zonder tijden geldt nu tot over een uur. */
function teamsMeetingBody(details: { title?: string | null; startsAt?: string | null; endsAt?: string | null }): Record<string, unknown> {
  const start = details.startsAt && !Number.isNaN(Date.parse(details.startsAt)) ? new Date(details.startsAt) : new Date();
  const endRaw = details.endsAt && !Number.isNaN(Date.parse(details.endsAt)) ? new Date(details.endsAt) : null;
  const end = endRaw && endRaw.getTime() > start.getTime() ? endRaw : new Date(start.getTime() + 60 * 60_000);
  const subject = String(details.title || '').trim().slice(0, 255) || 'Vergadering';
  return { subject, startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}
