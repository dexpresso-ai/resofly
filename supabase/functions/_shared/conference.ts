// ============================================================
// Google Meet en Microsoft Teams bij een afspraak: de regels.
//
// Er zijn twee manieren om aan een Meet- of Teams-link te komen.
//
//   1. De agenda maakt hem zelf ("van de agenda"). Op een Google-afspraak zet
//      Google er Meet bij (conferenceData), op een Microsoft-afspraak Teams
//      (isOnlineMeeting). Daar is niets extra's voor nodig: de agendarechten
//      van de koppeling zijn genoeg. Of een agenda het kan, staat bij de agenda
//      zelf (calendar_sources.conference_types): een Workspace-beheerder kan
//      Meet uitzetten, en een privé-Microsoftaccount (outlook.com) maakt geen
//      Teams-vergaderingen. Microsoft maakte de afspraak dan gewoon zónder
//      Teams, en niemand merkte het tot de klant geen link had.
//   2. Los, buiten de agenda om. Een afspraak in de ResoFly-agenda, een boeking
//      daarop of de teamchat heeft geen Google- of Microsoft-afspraak om de
//      vergadering aan te hangen. Dan maakt ResoFly hem apart: de Google Meet
//      REST API (spaces.create) of Graph (/me/onlineMeetings), met de koppeling
//      van wie erom vraagt, nooit met die van een collega. Dat vraagt één extra
//      recht (calendarOAuth.ts: meetingScopes), dat iemand apart aanzet.
//
// Puur (geen Deno, geen database): conference.test.ts legt het vast.
// ============================================================

import { hasMeetingScope } from './calendarOAuth.ts';
import { googleConferenceUrl, sanitizeMeetingUrl } from './meetingLinks.ts';

export type VideoService = 'google_meet' | 'teams';
export const VIDEO_SERVICES: readonly VideoService[] = ['google_meet', 'teams'];

/**
 * De gevraagde videovergadering kan hier niet: de agenda maakt hem niet, of
 * een losse vergadering lukte niet. Een eigen soort fout, zodat een boeking
 * dan tóch doorgaat (zonder link, met een melding aan de eigenaar) en de app
 * de uitleg toont. `status` is de HTTP-status voor de app.
 */
export class VideoUnavailableError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'VideoUnavailableError';
    this.status = status;
  }
}

export function isVideoService(value: unknown): value is VideoService {
  return value === 'google_meet' || value === 'teams';
}

export function serviceProvider(service: VideoService): 'google' | 'microsoft' {
  return service === 'google_meet' ? 'google' : 'microsoft';
}

/** De dienst die bij een agenda-aanbieder hoort: Google Meet bij Google, Teams bij Microsoft. */
export function serviceOfProvider(provider: string | null | undefined): VideoService | null {
  return provider === 'google' ? 'google_meet' : provider === 'microsoft' ? 'teams' : null;
}

export function serviceLabel(service: VideoService): string {
  return service === 'google_meet' ? 'Google Meet' : 'Microsoft Teams';
}

// ── Links herkennen ─────────────────────────────────────────────────────────

function httpsHost(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function isGoogleMeetUrl(url: unknown): boolean {
  return httpsHost(url) === 'meet.google.com';
}

export function isTeamsUrl(url: unknown): boolean {
  const host = httpsHost(url);
  return host === 'teams.microsoft.com' || host === 'teams.live.com' || Boolean(host?.endsWith('.teams.microsoft.com'));
}

/** Welke dienst achter een link zit, als het Meet of Teams is. */
export function serviceOfUrl(url: unknown): VideoService | null {
  return isGoogleMeetUrl(url) ? 'google_meet' : isTeamsUrl(url) ? 'teams' : null;
}

/**
 * De link uit het antwoord van Google (spaces.create) of Graph
 * (/me/onlineMeetings), alleen als het echt een Meet- of Teams-link is. Wat er
 * terugkomt gaat in uitnodigingen naar klanten; een vreemde link (of een
 * `javascript:`) hoort daar nooit in te belanden, ook niet als de provider
 * zich vergist.
 */
export function createdMeetingUrl(service: VideoService, payload: unknown): string | null {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const raw = service === 'google_meet' ? body.meetingUri : (body.joinWebUrl ?? body.joinUrl);
  if (typeof raw !== 'string') return null;
  const url = sanitizeMeetingUrl(raw);
  return url && serviceOfUrl(url) === service ? url : null;
}

// ── Wat een agenda zelf kan ─────────────────────────────────────────────────

/** Alleen nette namen bewaren ("hangoutsMeet", "teamsForBusiness"). */
function cleanTypes(raw: unknown[]): string[] {
  return [...new Set(raw.filter((t): t is string => typeof t === 'string' && /^[A-Za-z]{1,40}$/.test(t)))];
}

/**
 * Wat een Google-agenda toelaat (calendarList: conferenceProperties).
 * null = Google zei er niets over; dan geldt het als "kan", zoals eerst. Liever
 * een keer proberen (en eerlijk melden als er geen Meet kwam) dan Meet
 * verbergen op een agenda die het wél kan.
 */
export function googleCalendarConferenceTypes(item: Record<string, unknown>): string[] | null {
  const raw = rec(item.conferenceProperties).allowedConferenceSolutionTypes;
  return Array.isArray(raw) ? cleanTypes(raw) : null;
}

/** Wat een Microsoft-agenda toelaat (allowedOnlineMeetingProviders). null = onbekend. */
export function microsoftCalendarConferenceTypes(item: Record<string, unknown>): string[] | null {
  const raw = item.allowedOnlineMeetingProviders;
  if (!Array.isArray(raw)) return null;
  return cleanTypes(raw).filter(t => t !== 'unknown');
}

const OWN_TYPE: Record<'google' | 'microsoft', string> = { google: 'hangoutsMeet', microsoft: 'teamsForBusiness' };

/**
 * Maakt deze agenda zelf een Meet- of Teams-vergadering? Onbekend (de agenda
 * is opgehaald vóór ResoFly dit bijhield) telt als ja: zo werkte het altijd,
 * en na "Agenda's ophalen" staat het er.
 */
export function calendarConferenceService(provider: string | null | undefined, conferenceTypes: string[] | null | undefined): VideoService | null {
  if (provider !== 'google' && provider !== 'microsoft') return null;
  if (conferenceTypes == null) return serviceOfProvider(provider);
  return conferenceTypes.includes(OWN_TYPE[provider]) ? serviceOfProvider(provider) : null;
}

/** Waarom deze agenda geen eigen vergadering maakt, in gewone woorden. */
export function calendarConferenceBlockedReason(provider: string | null | undefined): string {
  return provider === 'microsoft'
    ? 'Dit Microsoft-account maakt geen Teams-vergaderingen. Dat kan alleen met een werk- of schoolaccount van Microsoft 365 met Teams.'
    : 'Op deze Google-agenda staat Google Meet uit. Dat doet meestal de beheerder van een Google Workspace.';
}

/**
 * Kan dit account de dienst überhaupt? Ja, tenzij van álle agenda's van de
 * koppeling bekend is dat ze hem niet toelaten (een privé-Microsoftaccount,
 * een Workspace zonder Meet). Dan heeft het geen zin om toestemming te vragen.
 */
export function accountSupportsService(service: VideoService, calendarTypes: Array<string[] | null | undefined>): boolean {
  const provider = serviceProvider(service);
  if (calendarTypes.length === 0) return true;
  return calendarTypes.some(types => calendarConferenceService(provider, types) === service);
}

// ── De vergadering op een afspraak teruglezen ───────────────────────────────

export type EventConference = {
  /** 'other': een conferentie die geen Meet of Teams is (bv. een Zoom-add-on in Google). */
  service: VideoService | 'other';
  url: string | null;
  /** 'pending': Google maakt hem nog (dat gaat asynchroon); 'failed': het lukte niet. */
  status: 'ready' | 'pending' | 'failed';
};

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** De vergadering die Google zelf op een afspraak zette, of null. */
export function googleEventConference(item: Record<string, unknown>): EventConference | null {
  const conf = item.conferenceData && typeof item.conferenceData === 'object' ? rec(item.conferenceData) : null;
  const hangout = typeof item.hangoutLink === 'string' && item.hangoutLink ? item.hangoutLink : null;
  if (!conf && !hangout) return null;
  const request = rec(conf?.createRequest);
  const type = String(rec(rec(conf?.conferenceSolution).key).type ?? rec(request.conferenceSolutionKey).type ?? (hangout ? 'hangoutsMeet' : ''));
  const statusCode = rec(request.status).statusCode;
  const url = sanitizeMeetingUrl(googleConferenceUrl(item));
  const service: EventConference['service'] = type === 'hangoutsMeet' || isGoogleMeetUrl(url) ? 'google_meet' : 'other';
  if (url) return { service, url, status: 'ready' };
  if (statusCode === 'pending') return { service, url: null, status: 'pending' };
  if (statusCode === 'failure') return { service, url: null, status: 'failed' };
  return null;
}

/** De vergadering die Outlook zelf op een afspraak zette, of null. */
export function microsoftEventConference(item: Record<string, unknown>): EventConference | null {
  const url = sanitizeMeetingUrl(rec(item.onlineMeeting).joinUrl);
  if (!url && item.isOnlineMeeting !== true) return null;
  const provider = String(item.onlineMeetingProvider ?? '');
  const service: EventConference['service'] = provider === 'teamsForBusiness' || isTeamsUrl(url) ? 'teams' : 'other';
  return url ? { service, url, status: 'ready' } : { service, url: null, status: 'failed' };
}

// ── Wat er met de video van een afspraak moet gebeuren ──────────────────────

export type VideoRequest = {
  /** Stond er in de invoer iets over video? Zo niet, dan blijft bij bewerken alles staan. */
  present: boolean;
  /** Een gewone link (Jitsi, Zoom, een eerder gemaakte Meet/Teams-link), al gecontroleerd. */
  meetingUrl: string | null;
  /** Vraag om een Google Meet- of Teams-vergadering. */
  videoService: VideoService | null;
  /** De oude vorm: "de vergadering van de agenda" (Meet op Google, Teams op Microsoft). */
  addConference: boolean;
  /** Haal de Meet die Google zelf op de afspraak zette eraf (bij overstappen of "Geen"). */
  removeConference: boolean;
};

export function parseVideoRequest(input: Record<string, unknown>): VideoRequest {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  const raw = input.videoService;
  if (raw !== undefined && raw !== null && raw !== '' && !isVideoService(raw)) {
    throw new VideoUnavailableError('Onbekende videodienst. Kies Google Meet of Teams.', 400);
  }
  return {
    present: has('meetingUrl') || has('videoService') || has('addConference') || has('removeConference'),
    meetingUrl: sanitizeMeetingUrl(input.meetingUrl),
    videoService: isVideoService(raw) ? raw : null,
    addConference: input.addConference === true,
    removeConference: input.removeConference === true,
  };
}

export type VideoPlan =
  /** Bij bewerken: niets over video meegestuurd, dus alles laten zoals het is. */
  | { kind: 'keep' }
  | { kind: 'none' }
  /** Een link die er gewoon op komt (in meeting_url, of als regel in de omschrijving). */
  | { kind: 'link'; url: string }
  /** De agenda maakt de vergadering zelf (Meet op Google, Teams op Microsoft). */
  | { kind: 'calendar'; service: VideoService }
  /** Los gemaakt met de eigen koppeling, en dan als link op de afspraak. */
  | { kind: 'standalone'; service: VideoService };

/**
 * Wat er met de video gebeurt, gegeven de agenda en de vraag.
 *
 * - Meet op een Google-agenda en Teams op een Microsoft-agenda maakt de agenda
 *   zelf; kan die agenda het niet, dan een duidelijke fout in plaats van een
 *   afspraak zonder link.
 * - Elders (de ResoFly-agenda, Teams op een Google-agenda) wordt hij los
 *   gemaakt. Staat er al een link van díe dienst, dan blijft die: de genodigden
 *   hebben hem al, en opnieuw opslaan mag geen tweede vergadering maken.
 * - `addConference` (de oude vorm) op een agenda die zelf niets maakt, werd
 *   altijd genegeerd; dat blijft zo.
 */
export function planVideo(
  sourceProvider: string,
  conferenceTypes: string[] | null | undefined,
  req: VideoRequest,
  mode: 'create' | 'update',
): VideoPlan {
  if (!req.present) return mode === 'update' ? { kind: 'keep' } : { kind: 'none' };
  const service = req.videoService ?? (req.addConference ? serviceOfProvider(sourceProvider) : null);
  if (service && serviceProvider(service) === sourceProvider) {
    if (calendarConferenceService(sourceProvider, conferenceTypes) !== service) {
      throw new VideoUnavailableError(calendarConferenceBlockedReason(sourceProvider));
    }
    return { kind: 'calendar', service };
  }
  if (service && req.videoService) {
    if (req.meetingUrl && serviceOfUrl(req.meetingUrl) === service) return { kind: 'link', url: req.meetingUrl };
    return { kind: 'standalone', service };
  }
  if (req.meetingUrl) return { kind: 'link', url: req.meetingUrl };
  return { kind: 'none' };
}

/**
 * De videodienst als Gerrie (of een gekoppelde AI) "een videocall" plant zonder
 * te zeggen welke: wat de agenda zelf kan, anders Jitsi. Dezelfde regel als bij
 * een nieuwe boekingslink.
 */
export function defaultVideoService(sourceProvider: string | null | undefined, conferenceTypes: string[] | null | undefined): VideoService | 'jitsi' {
  return calendarConferenceService(sourceProvider, conferenceTypes) ?? 'jitsi';
}

// ── Losse vergaderingen: welke koppeling, en wat er misging ─────────────────

export type MeetingConnectionLike = {
  id: string;
  provider: string;
  status: string;
  scopes: string[] | null;
  created_at: string;
};

/**
 * klaar        — er is een koppeling met het recht; die wordt gebruikt.
 * toestemming  — gekoppeld, maar het recht is nog niet gegeven.
 * account      — dit account kan de dienst niet (privé-Microsoft, Workspace zonder Meet).
 * verlopen     — alleen een koppeling die opnieuw gekoppeld moet worden.
 * geen_koppeling
 */
export type VideoServiceState = 'klaar' | 'toestemming' | 'account' | 'verlopen' | 'geen_koppeling';

/**
 * Kiest de koppeling waarmee een losse vergadering wordt gemaakt. Alleen
 * koppelingen van de aanvrager zelf komen hier binnen (de database-vraag filtert
 * op organisatie én gebruiker); hier gaat het om welke van zijn eigen accounts.
 * De oudste werkende met het recht: zo is het bij twee Google-accounts elke
 * keer hetzelfde account.
 */
export function pickMeetingConnection<T extends MeetingConnectionLike>(
  service: VideoService,
  connections: T[],
  supports: (connection: T) => boolean = () => true,
): { state: VideoServiceState; connection: T | null } {
  const provider = serviceProvider(service);
  const byAge = (a: T, b: T) => String(a.created_at).localeCompare(String(b.created_at));
  const mine = connections.filter(c => c.provider === provider && c.status !== 'revoked').sort(byAge);
  const usable = mine.filter(c => c.status === 'active' || c.status === 'error');
  const ready = usable.find(c => hasMeetingScope(provider, c.scopes));
  if (ready) return { state: 'klaar', connection: ready };
  const capable = usable.filter(supports);
  if (capable.length) return { state: 'toestemming', connection: capable[0] };
  if (usable.length) return { state: 'account', connection: usable[0] };
  const expired = mine.find(c => c.status === 'expired');
  if (expired) return { state: 'verlopen', connection: expired };
  return { state: 'geen_koppeling', connection: null };
}

/** Wat de gebruiker leest als een losse vergadering niet kan, per toestand. */
export function videoServiceStateMessage(service: VideoService, state: VideoServiceState): string {
  const account = service === 'google_meet' ? 'Google' : 'Microsoft';
  switch (state) {
    case 'klaar': return '';
    case 'toestemming': return `Geef ResoFly eerst toestemming om ${serviceLabel(service)}-vergaderingen te maken: Instellingen → Agenda, bij je ${account}-account.`;
    case 'account': return service === 'google_meet'
      ? 'Google laat dit account geen Meet-vergaderingen maken. Misschien heeft de beheerder van je Google Workspace Meet uitgezet.'
      : 'Microsoft maakt met dit account geen Teams-vergaderingen. Dat kan alleen met een werk- of schoolaccount van Microsoft 365 met Teams.';
    case 'verlopen': return `Je ${account}-koppeling is verlopen. Koppel het account opnieuw bij Instellingen → Agenda.`;
    default: return `Koppel eerst je ${account}-account bij Instellingen → Agenda om ${serviceLabel(service)} te gebruiken.`;
  }
}

export type MeetingFailure = 'toestemming' | 'uitgeschakeld' | 'account' | 'tijdelijk' | 'mislukt';

/**
 * Wat een mislukte aanvraag bij de Meet API of Graph betekent. We vragen alleen
 * met een koppeling die het recht heeft; een weigering is dan meestal iets van
 * de omgeving (de Meet API staat in Google Cloud niet aan) of van het account
 * (geen Teams-licentie, een privé-Microsoftaccount).
 */
export function classifyMeetingFailure(service: VideoService, status: number, payload: unknown): MeetingFailure {
  if (status === 0 || status === 429 || status >= 500) return 'tijdelijk';
  const error = rec(rec(payload).error);
  const message = String(error.message ?? '');
  if (service === 'google_meet') {
    const reasons = (Array.isArray(error.details) ? error.details : []).map(d => String(rec(d).reason ?? ''));
    if (reasons.includes('SERVICE_DISABLED') || /has not been used in project|is disabled|accessNotConfigured/i.test(message)) return 'uitgeschakeld';
    if (status === 401 || reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient (authentication )?scopes?/i.test(message)) return 'toestemming';
    if (status === 403) return 'account';
    return 'mislukt';
  }
  const code = String(error.code ?? '');
  if (status === 401 || code === 'InvalidAuthenticationToken') return 'toestemming';
  if (status === 403) return 'account';
  if (/\bMSA\b|consumer|personal (microsoft )?account|not supported/i.test(`${code} ${message}`)) return 'account';
  return 'mislukt';
}

export function meetingFailureMessage(service: VideoService, failure: MeetingFailure): string {
  switch (failure) {
    case 'toestemming': return videoServiceStateMessage(service, 'toestemming');
    case 'account': return videoServiceStateMessage(service, 'account');
    case 'uitgeschakeld': return 'Google Meet staat voor deze ResoFly-omgeving nog niet aan. De beheerder van ResoFly zet de Google Meet REST API aan in Google Cloud.';
    case 'tijdelijk': return `${service === 'google_meet' ? 'Google' : 'Microsoft'} was even niet bereikbaar. Probeer het zo opnieuw.`;
    default: return `De ${serviceLabel(service)}-vergadering maken lukte niet. Probeer het opnieuw.`;
  }
}
