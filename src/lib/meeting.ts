// Herkent het type videovergadering aan de hand van de link, zodat de UI het
// juiste label (en straks icoon) kan tonen. Puur cosmetisch — de link zelf is
// leidend; we bewaren geen aparte "provider"-kolom.
//
// Daarnaast maakt deze module Jitsi Meet-links: een eigen vergaderruimte per
// afspraak, zonder Google of Microsoft ertussen. Standaard op de openbare server
// meet.jit.si; een organisatie kan in Instellingen → Agenda haar eigen
// Jitsi-server opgeven (company_settings.jitsi_base_url). De edge-functies
// hebben dezelfde regels in supabase/functions/_shared/jitsi.ts.

import {
  accountSupportsService,
  calendarConferenceService,
  calendarConferenceBlockedReason,
  serviceOfUrl,
  serviceProvider,
} from '../../supabase/functions/_shared/conference.ts';
import { hasMeetingScope } from '../../supabase/functions/_shared/calendarOAuth.ts';
import type { VideoService, VideoServices } from '../types';

export type MeetingKind = 'google_meet' | 'teams' | 'zoom' | 'jitsi' | 'other';

const HOSTS: { kind: MeetingKind; label: string; match: RegExp }[] = [
  { kind: 'google_meet', label: 'Google Meet', match: /(^|\.)meet\.google\.com$/i },
  { kind: 'teams', label: 'Microsoft Teams', match: /(^|\.)teams\.(microsoft|live)\.com$/i },
  { kind: 'zoom', label: 'Zoom', match: /(^|\.)(zoom\.us|zoom\.com|.*\.zoom\.us)$/i },
  // meet.jit.si is de openbare Jitsi-server, 8x8.vc de betaalde (JaaS) van 8x8.
  { kind: 'jitsi', label: 'Jitsi Meet', match: /(^|\.)(meet\.jit\.si|8x8\.vc)$/i },
];

const OTHER = { kind: 'other' as MeetingKind, label: 'Videocall' };
const JITSI = { kind: 'jitsi' as MeetingKind, label: 'Jitsi Meet' };

/** Kamernaam zoals ResoFly die maakt (zie jitsiRoomName) — op elke server herkenbaar. */
const RESOFLY_ROOM_RE = /\/ResoFly-[A-Za-z0-9]{14}\/?$/;

/**
 * Het soort videovergadering achter een link. `jitsiBaseUrl` is de eigen
 * Jitsi-server van de organisatie: links naar die server heten ook Jitsi Meet.
 */
export function detectMeetingKind(url: string | null | undefined, jitsiBaseUrl?: string | null): { kind: MeetingKind; label: string } {
  if (!url) return OTHER;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return OTHER; }
  for (const h of HOSTS) if (h.match.test(parsed.hostname)) return { kind: h.kind, label: h.label };
  const own = normalizeJitsiBaseUrl(jitsiBaseUrl);
  if (own && parsed.host === new URL(own).host) return JITSI;
  if (RESOFLY_ROOM_RE.test(parsed.pathname)) return JITSI;
  return OTHER;
}

/** Basisvalidatie voor een geplakte link: alleen http(s) toestaan. */
export function isValidMeetingUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try { const u = new URL(trimmed); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// ── Jitsi Meet ───────────────────────────────────────────────────────────────

export const DEFAULT_JITSI_BASE_URL = 'https://meet.jit.si';

/**
 * Maakt van wat iemand als Jitsi-server invult een nette basis-URL:
 * `meet.example.nl` → `https://meet.example.nl`. Alleen https (de browser geeft
 * camera en microfoon niet vrij op http), geen inloggegevens, query of #, en
 * hooguit één padstuk (een tenant of submap op de eigen server). Leeg of
 * ongeldig → null; dan geldt meet.jit.si.
 */
export function normalizeJitsiBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let raw = value.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || raw.includes('?') || raw.includes('#')) return null;
  if (!url.hostname.includes('.') || url.hostname.startsWith('.') || url.hostname.endsWith('.')) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.split('/').length > 2) return null;
  const out = `${url.origin}${path}`;
  return out.length <= 200 ? out : null;
}

/** De Jitsi-server die geldt: de ingestelde, of anders meet.jit.si. */
export function jitsiBaseUrl(configured: unknown): string {
  return normalizeJitsiBaseUrl(configured) ?? DEFAULT_JITSI_BASE_URL;
}

/** De openbare server meet.jit.si: daar logt wie de vergadering opent eerst even in. */
export function usesPublicJitsi(configured: unknown): boolean {
  return new URL(jitsiBaseUrl(configured)).host === 'meet.jit.si';
}

/** Alleen de servernaam, voor in de uitleg: "meet.jit.si", "meet.example.nl". */
export function jitsiServerLabel(configured: unknown): string {
  const url = new URL(jitsiBaseUrl(configured));
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

// Zonder tekens die op elkaar lijken (l/1/I, o/0/O): de link wordt ook wel eens
// overgetypt of voorgelezen.
const ROOM_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_LENGTH = 14;

/**
 * Een onraadbare kamernaam: `ResoFly-` plus 14 willekeurige tekens (ruim 80
 * bits). Een Jitsi-kamer is open voor iedereen die de naam kent; daarom geen
 * titel of klantnaam in de link — die belandt anders ook in serverlogboeken.
 */
export function jitsiRoomName(): string {
  // Bytes boven het hoogste veelvoud van de alfabetlengte vallen af, zodat
  // geen teken vaker voorkomt dan een ander.
  const limit = 256 - (256 % ROOM_ALPHABET.length);
  const out: string[] = [];
  while (out.length < ROOM_LENGTH) {
    const bytes = new Uint8Array(ROOM_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit && out.length < ROOM_LENGTH) out.push(ROOM_ALPHABET[b % ROOM_ALPHABET.length]);
    }
  }
  return `ResoFly-${out.join('')}`;
}

/** Een nieuwe vergaderlink op de Jitsi-server van de organisatie. */
export function jitsiMeetingUrl(configured?: unknown): string {
  return `${jitsiBaseUrl(configured)}/${jitsiRoomName()}`;
}

// ── Google Meet en Teams bij een afspraak ────────────────────────────────────
// De regels staan in supabase/functions/_shared/conference.ts (de server
// gebruikt dezelfde): Meet op een Google-agenda en Teams op een
// Microsoft-agenda maakt de agenda zelf; elders komt de vergadering los van je
// eigen koppeling, als je daar bij Instellingen → Agenda toestemming voor gaf.

/** De keuze in het blok "Videovergadering" bij een afspraak. */
export type MeetingMode = 'none' | 'jitsi' | 'google_meet' | 'teams' | 'link';

export type VideoServiceOption = {
  /** Kan het hier? */
  available: boolean;
  /** 'calendar' = de agenda maakt hem zelf; 'standalone' = los, met je eigen koppeling. */
  how: 'calendar' | 'standalone' | null;
  /** Waarom niet, als dat de moeite van het zeggen waard is (anders null). */
  hint: string | null;
};

/**
 * Welke Meet/Teams-keuzes er zijn bij een afspraak in deze agenda.
 * `videoServices` komt van de server (alleen over je eigen koppelingen); zonder
 * die gegevens (oudere server) alleen wat de agenda zelf kan, zoals eerst.
 */
export function videoServiceOptions(
  sourceProvider: string | null | undefined,
  sourceConferenceTypes: string[] | null | undefined,
  videoServices?: VideoServices | null,
): Record<VideoService, VideoServiceOption> {
  const option = (service: VideoService): VideoServiceOption => {
    if (calendarConferenceService(sourceProvider, sourceConferenceTypes) === service) return { available: true, how: 'calendar', hint: null };
    // Een agenda van dezelfde aanbieder die het niet kan (privé-Microsoft,
    // Workspace zonder Meet): dan ook niet los; dat zegt de server ook.
    if (sourceProvider === serviceProvider(service)) return { available: false, how: null, hint: calendarConferenceBlockedReason(sourceProvider) };
    const state = videoServices?.[service]?.state;
    if (state === 'klaar') return { available: true, how: 'standalone', hint: null };
    if (state === 'toestemming') {
      return {
        available: false, how: null,
        hint: `${service === 'google_meet' ? 'Google Meet' : 'Teams'} ook hier? Zet het aan bij Instellingen → Agenda, bij je ${service === 'google_meet' ? 'Google' : 'Microsoft'}-account.`,
      };
    }
    return { available: false, how: null, hint: null };
  };
  return { google_meet: option('google_meet'), teams: option('teams') };
}

/**
 * Meet/Teams buiten de agenda om, voor één gekoppeld account:
 * 'aan' · 'uit' (aan te zetten) · 'kan_niet' (een privé-Microsoftaccount, een
 * Workspace zonder Meet). Null bij een agenda die geen Google of Microsoft is.
 */
export function connectionMeetingState(provider: string, scopes: string[] | null | undefined, calendarTypes: Array<string[] | null | undefined>): 'aan' | 'uit' | 'kan_niet' | null {
  if (provider !== 'google' && provider !== 'microsoft') return null;
  if (!accountSupportsService(provider === 'google' ? 'google_meet' : 'teams', calendarTypes)) return 'kan_niet';
  return hasMeetingScope(provider, scopes) ? 'aan' : 'uit';
}

type ExistingConference = { service: VideoService | 'other'; url: string | null } | null | undefined;

/**
 * De keuze die bij een bestaande afspraak hoort. Meet/Teams alleen als die
 * keuze hier kan; anders "Eigen link". Een Meet die Google nog aan het maken is
 * (nog zonder link) telt al als Meet.
 */
export function meetingModeOf(meetingUrl: string | null | undefined, available: Record<VideoService, boolean>, jitsiBaseUrl?: string | null, conference?: ExistingConference): MeetingMode {
  const url = (meetingUrl ?? '').trim();
  if (!url) {
    const own = conference?.service;
    return (own === 'google_meet' || own === 'teams') && available[own] ? own : 'none';
  }
  const service = serviceOfUrl(url);
  if (service && available[service]) return service;
  if (detectMeetingKind(url, jitsiBaseUrl).kind === 'jitsi') return 'jitsi';
  return 'link';
}

/**
 * Wat er bij opslaan over de video meegaat.
 *
 * - De vergadering die Google of Outlook zelf op de afspraak zette, en die je
 *   laat staan: niets (geen link in de omschrijving, geen nieuwe vergadering).
 *   Eerst kwam de Meet-link bij elke bewerking als regel in de omschrijving.
 * - Een Meet- of Teams-link die er al staat: die blijft (de genodigden hebben hem).
 * - Nieuw gekozen Meet/Teams: `videoService`; de server maakt hem.
 * - Kies je iets anders dan de vergadering van de agenda, dan gaat die eraf
 *   (`removeConference`; Teams kan Microsoft niet weghalen, dat meldt de server).
 */
export function videoFieldsForSave(
  mode: MeetingMode,
  meetingUrl: string,
  conference?: ExistingConference,
): { meetingUrl: string | null; videoService?: VideoService; removeConference?: true } {
  const url = meetingUrl.trim();
  if (conference && (mode === conference.service || (mode === 'link' && conference.url && url === conference.url))) return { meetingUrl: null };
  const remove = conference ? { removeConference: true as const } : {};
  if (mode === 'google_meet' || mode === 'teams') {
    if (url && serviceOfUrl(url) === mode) return { meetingUrl: url, ...remove };
    return { meetingUrl: null, videoService: mode, ...remove };
  }
  if (mode === 'none') return { meetingUrl: null, ...remove };
  return { meetingUrl: url || null, ...remove };
}

/**
 * Bij verplaatsen of herschalen: alleen de link die in de omschrijving staat
 * gaat mee. De vergadering van de agenda zelf blijft gewoon staan.
 */
export function meetingUrlToKeep(meetingUrl: string | null | undefined, conference?: ExistingConference): string | null {
  if (!meetingUrl) return null;
  return conference?.url && conference.url === meetingUrl ? null : meetingUrl;
}

// ── Videovergadering bij een boekingslink ────────────────────────────────────
// meeting_booking_links bewaart twee velden (auto_conference, conference_provider);
// in een formulier is dat één keuze. Een vaste meeting_url gaat altijd voor.

/** De videokeuze van een boekingslink, als één waarde voor in een keuzelijst. */
export type BookingVideo = 'jitsi' | 'calendar' | 'google_meet' | 'teams' | 'none';

/** Maakt de agenda zelf een videovergadering (Google Meet / Teams)? */
export function calendarMakesConference(sourceProvider: string | null | undefined): boolean {
  return sourceProvider === 'google' || sourceProvider === 'microsoft';
}

/**
 * Van de opgeslagen velden naar één keuze. Een ResoFly-agenda maakt zelf geen
 * vergadering: 'calendar' betekent daar in de praktijk "geen".
 */
export function bookingVideoFromLink(autoConference: boolean | undefined, conferenceProvider: string | null | undefined, sourceProvider: string | null | undefined): BookingVideo {
  if (autoConference === false) return 'none';
  if (conferenceProvider === 'jitsi') return 'jitsi';
  if (conferenceProvider === 'google_meet' || conferenceProvider === 'teams') return effectiveBookingVideo(conferenceProvider, sourceProvider);
  return calendarMakesConference(sourceProvider) ? 'calendar' : 'none';
}

/** Standaard voor een nieuwe link: wat de agenda zelf kan, en anders Jitsi. */
export function defaultBookingVideo(sourceProvider: string | null | undefined): BookingVideo {
  return calendarMakesConference(sourceProvider) ? 'calendar' : 'jitsi';
}

/**
 * De keuze die echt geldt bij deze agenda:
 * - 'calendar' op een agenda die zelf niets maakt (je wisselde naar een
 *   ResoFly-agenda) wordt Jitsi;
 * - Meet op een Google-agenda of Teams op een Microsoft-agenda is gewoon "van
 *   de agenda" ('calendar').
 */
export function effectiveBookingVideo(choice: BookingVideo, sourceProvider: string | null | undefined): BookingVideo {
  if (choice === 'calendar' && !calendarMakesConference(sourceProvider)) return 'jitsi';
  if ((choice === 'google_meet' || choice === 'teams') && serviceProvider(choice) === sourceProvider) return 'calendar';
  return choice;
}

/** Terug naar de velden van meeting_booking_links. */
export function bookingVideoFields(choice: BookingVideo, sourceProvider: string | null | undefined): { autoConference: boolean; conferenceProvider: 'calendar' | 'jitsi' | VideoService } {
  const effective = effectiveBookingVideo(choice, sourceProvider);
  return {
    autoConference: effective !== 'none',
    conferenceProvider: effective === 'jitsi' || effective === 'google_meet' || effective === 'teams' ? effective : 'calendar',
  };
}
