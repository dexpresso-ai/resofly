// ============================================================
// Boekingslinks: de regels die de publieke boekingspagina
// (meeting-booking-public) en het beheer (meeting-booking) delen.
//
// Waarom een eigen bestand: tot november 2026 stond elke regel twee keer los
// in de twee functies, en liepen ze uit elkaar. De publieke pagina toonde een
// blok tot het eind ervan (ook als het al begonnen was), de database keek niet
// naar de begintijd, en "verlopen" betekende in het scherm iets anders dan op
// de server. Hier staat het één keer, zonder Deno en zonder database, zodat
// meetingBookingRules.test.ts het kan vastleggen.
// ============================================================

import { isVideoService, serviceLabel, serviceOfProvider, serviceOfUrl } from './conference.ts';

/**
 * Na zoveel minuten is een poging die nog op 'pending' staat dood: de edge
 * function die hem deed, draait hooguit 400 seconden. Dezelfde grens staat in
 * release_stale_meeting_bookings (migratie 20261110030000).
 */
export const BOOKING_STALE_MINUTES = 10;
export const BOOKING_STALE_MS = BOOKING_STALE_MINUTES * 60 * 1000;

/** Hoe lang een nieuwe of vernieuwde link standaard werkt, en hoe lang hooguit. */
export const DEFAULT_TOKEN_TTL_DAYS = 120;
export const MAX_TOKEN_TTL_DAYS = 365;

/** Hoeveel momenten een bezoeker in één keer mag kiezen. */
export const MAX_SLOTS_PER_BOOKING = 20;

/** Een blok langer dan dit is vrijwel zeker een vergissing (een week gesleept). */
export const MAX_SLOT_MINUTES = 12 * 60;

export const MAX_NAME_LENGTH = 160;
export const MAX_EMAIL_LENGTH = 254;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Het aantal dagen dat een link geldig is: een geheel getal van 1 tot en met
 * 365. Eerst stond er geen bovengrens: 1e9 dagen gaf een ongeldige datum en een
 * serverfout, en 100.000 dagen een link die nooit meer verliep.
 */
export function clampTtlDays(value: unknown, fallback = DEFAULT_TOKEN_TTL_DAYS): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TOKEN_TTL_DAYS, Math.max(1, Math.round(n)));
}

/** De vervaldatum `days` dagen na `from`. */
export function expiryAfter(days: number, from: number = Date.now()): string {
  return new Date(from + clampTtlDays(days) * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * De naam die een bezoeker invult. Komt in de titel van de afspraak, in de
 * melding aan de eigenaar en in de bevestiging; een regeleinde of ander
 * stuurteken wordt een spatie, en hij is hooguit 160 tekens.
 */
export function cleanVisitorName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/** Het e-mailadres van de bezoeker in kleine letters, of null als het niet klopt. */
export function cleanVisitorEmail(raw: unknown): string | null {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return null;
  return email;
}

/**
 * De gekozen momenten: alleen id's die een blok kunnen zijn, elk één keer.
 * Twee keer hetzelfde blok gaf eerst een tweede poging die altijd mislukte, en
 * dan stond er "niet gelukt" naast een moment dat wél geboekt was.
 */
export function parseSlotIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = String(item ?? '').trim().toLowerCase();
    if (UUID.test(id)) seen.add(id);
  }
  return [...seen];
}

export type BookingLinkState = 'open' | 'closed' | 'expired' | 'unavailable' | 'full';

/**
 * Wat een link op dit moment is, voor de klant en voor het beheer:
 *   closed      — gesloten door een teamlid;
 *   expired     — de geldigheid is voorbij;
 *   unavailable — de maker is geen actief teamlid met schrijfrecht op de
 *                 Agenda meer, of de agenda is weg;
 *   full        — alle afspraken die via de link kunnen, zijn gemaakt;
 *   open        — er kan geboekt worden (als er vrije momenten zijn).
 */
export function bookingLinkState(input: {
  status: string;
  expiresAt: string | null | undefined;
  ownerCanBook: boolean;
  hasSource: boolean;
  activeBookings: number;
  maxTotal: number;
  now?: number;
}): BookingLinkState {
  const now = input.now ?? Date.now();
  if (input.status !== 'active') return 'closed';
  const expires = input.expiresAt ? Date.parse(input.expiresAt) : NaN;
  if (!Number.isFinite(expires) || expires < now) return 'expired';
  if (!input.ownerCanBook || !input.hasSource) return 'unavailable';
  if (input.activeBookings >= Math.max(1, input.maxTotal)) return 'full';
  return 'open';
}

/** Een lopende poging die zo oud is, telt niet meer: de functie viel om. */
export function isStalePending(status: string, createdAt: string | null | undefined, now: number = Date.now()): boolean {
  if (status !== 'pending') return false;
  const at = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(at) && at < now - BOOKING_STALE_MS;
}

/** Telt deze boeking mee voor de limieten en de lijst? Bevestigd, of een poging die nog loopt. */
export function isActiveBooking(status: string, createdAt: string | null | undefined, now: number = Date.now()): boolean {
  if (status === 'confirmed') return true;
  return status === 'pending' && !isStalePending(status, createdAt, now);
}

/** Kan een bezoeker dit blok kiezen? Open (of een dode poging), en het is nog niet begonnen. */
export function isBookableSlot(
  slot: { status: string; starts_at: string; pending_at?: string | null },
  now: number = Date.now(),
): boolean {
  const starts = Date.parse(slot.starts_at);
  if (!Number.isFinite(starts) || starts <= now) return false;
  if (slot.status === 'open') return true;
  return slot.status === 'pending' && isStalePending('pending', slot.pending_at ?? null, now);
}

/**
 * Hoe het gesprek plaatsvindt, in woorden voor de klant. Een vaste link gaat
 * altijd voor; anders wat de link automatisch aanmaakt. Null: geen
 * videogesprek (dan zegt de pagina er niets over).
 */
export function bookingVideoLabel(input: {
  meetingUrl: string | null | undefined;
  autoConference: boolean | null | undefined;
  conferenceProvider: string | null | undefined;
  sourceProvider: string | null | undefined;
}): string | null {
  if (input.meetingUrl) return 'Videogesprek — de link staat in je bevestiging';
  if (input.autoConference === false) return null;
  const provider = input.conferenceProvider ?? 'calendar';
  if (provider === 'jitsi') return 'Videogesprek via Jitsi Meet';
  if (isVideoService(provider)) return `Videogesprek via ${serviceLabel(provider)}`;
  const service = serviceOfProvider(input.sourceProvider);
  return service ? `Videogesprek via ${serviceLabel(service)}` : null;
}

/**
 * Welk videogesprek, als één sleutel voor de klantpagina en het portaal. De
 * pagina zet er een eigen kaart bij (naam, hoe je deelneemt). Eerst kreeg de
 * klant alleen een zin ("Videogesprek via …") en bij een vaste link zelfs
 * alleen "de link staat in je bevestiging": of het Teams, Meet of Zoom was,
 * wist hij pas als de mail er was.
 */
export type BookingVideoKind = 'jitsi' | 'google_meet' | 'teams' | 'zoom' | 'link';

export const BOOKING_VIDEO_KINDS: readonly BookingVideoKind[] = ['jitsi', 'google_meet', 'teams', 'zoom', 'link'];

export const BOOKING_VIDEO_NAMES: Record<BookingVideoKind, string> = {
  jitsi: 'Jitsi Meet',
  google_meet: 'Google Meet',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  link: 'Videogesprek',
};

export function isBookingVideoKind(value: unknown): value is BookingVideoKind {
  return typeof value === 'string' && (BOOKING_VIDEO_KINDS as readonly string[]).includes(value);
}

/** De kamernaam die ResoFly voor Jitsi maakt (jitsi.ts): op elke server herkenbaar. */
const RESOFLY_JITSI_ROOM = /\/ResoFly-[A-Za-z0-9]{14}\/?$/;

/**
 * De dienst achter een videolink, of 'link' als we hem niet kennen. Alleen
 * http(s); al het andere (een `javascript:`-link, onzin) is null: dat hoort nooit
 * als videolink bij een klant te belanden.
 */
export function videoKindOfUrl(url: unknown): BookingVideoKind | null {
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) return null;
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  // Dezelfde herkenning als conference.ts (alleen https); een http-link naar
  // dezelfde dienst noemen we gewoon bij naam.
  const service = serviceOfUrl(`https://${parsed.host}${parsed.pathname}`);
  if (service) return service;
  const host = parsed.hostname.toLowerCase();
  if (host === 'zoom.us' || host === 'zoom.com' || host.endsWith('.zoom.us') || host.endsWith('.zoom.com')) return 'zoom';
  if (host === 'meet.jit.si' || host === '8x8.vc' || RESOFLY_JITSI_ROOM.test(parsed.pathname)) return 'jitsi';
  return 'link';
}

/**
 * Welk videogesprek een boeking via deze link krijgt. Dezelfde volgorde als
 * bookSlots: een vaste link gaat voor, anders wat de link zelf aanmaakt. Null:
 * geen videogesprek.
 */
export function bookingVideoService(input: {
  meetingUrl: string | null | undefined;
  autoConference: boolean | null | undefined;
  conferenceProvider: string | null | undefined;
  sourceProvider: string | null | undefined;
}): BookingVideoKind | null {
  if (input.meetingUrl) return videoKindOfUrl(input.meetingUrl) ?? 'link';
  if (input.autoConference === false) return null;
  const provider = input.conferenceProvider ?? 'calendar';
  if (provider === 'jitsi') return 'jitsi';
  if (isVideoService(provider)) return provider;
  return serviceOfProvider(input.sourceProvider);
}

/**
 * Hoeveel vrije momenten die nog moeten komen er hooguit op één link staan.
 * De publieke pagina toont er nooit meer dan dit (limit 500 in getLink); met
 * het weekpatroon in het beheer zet je er in één klik tientallen op, en een
 * vergissing ("elke dag, een jaar lang") gaf anders een pagina die halverwege
 * ophield.
 */
export const MAX_OPEN_SLOTS_PER_LINK = 500;

export type NewSlot = { starts_at: string; ends_at: string };

/**
 * Nieuwe blokken voor een link: geldige tijden, einde na begin, niet in het
 * verleden en niet langer dan twaalf uur. Gooit een Nederlandse melding; de
 * aanroeper maakt er zijn eigen foutsoort van.
 */
export function checkNewSlots(slots: NewSlot[], now: number = Date.now()): void {
  for (const slot of slots) {
    const starts = Date.parse(slot.starts_at);
    const ends = Date.parse(slot.ends_at);
    if (!Number.isFinite(starts) || !Number.isFinite(ends)) throw new Error('Ongeldige tijd voor een blok.');
    if (ends <= starts) throw new Error('De eindtijd van een blok moet na de begintijd liggen.');
    if (starts <= now) throw new Error('Een blok in het verleden kan niemand meer boeken. Kies een moment dat nog moet komen.');
    if (ends - starts > MAX_SLOT_MINUTES * 60 * 1000) throw new Error('Een blok mag hooguit twaalf uur duren.');
  }
}

/**
 * Blokken die precies zo al op de link staan (zelfde begin en einde), en niet
 * geannuleerd zijn, slaan we over. Twee keer slepen op hetzelfde uur gaf de
 * klant eerst twee keer hetzelfde moment.
 */
/** Een afspraak zoals listEvents (calendarAvailability.ts) hem geeft: een los record, dus alles optioneel. */
export type BusyEvent = { source_id?: unknown; starts_at?: unknown; ends_at?: unknown; all_day?: unknown; title?: unknown };

/**
 * De afspraak waar een nieuw moment mee botst, of null.
 *
 * Telt mee:
 * - alles in de agenda van de link, ook een hele dag. De publieke pagina
 *   weigert de boeking dan ook (assertNoConflict), dus zo'n moment kan de klant
 *   toch niet boeken;
 * - afspraken met een tijd in de andere agenda's van wie de link maakte: de
 *   ResoFly-agenda, Google, Microsoft en een ICS-abonnement. Een hele dag telt
 *   daar niet: een verjaardag of feestdag in een gekoppelde agenda maakt je niet
 *   bezet.
 *
 * Eerst telde alleen de agenda van de link. Een afspraak in je Google-agenda
 * stond niet in het rooster, en het weekpatroon zette er zonder waarschuwing
 * een moment overheen: een dubbele boeking zodra de klant dat moment koos.
 */
export function slotClash<T extends BusyEvent>(
  slot: NewSlot,
  events: readonly T[],
  scope: { linkSourceId: string | null | undefined; ownSourceIds: Iterable<string> },
): T | null {
  const starts = Date.parse(slot.starts_at);
  const ends = Date.parse(slot.ends_at);
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return null;
  const own = new Set(scope.ownSourceIds);
  for (const event of events) {
    const source = String(event.source_id ?? '');
    const onLink = Boolean(scope.linkSourceId) && source === scope.linkSourceId;
    if (!onLink && (!own.has(source) || event.all_day === true)) continue;
    const evStarts = Date.parse(String(event.starts_at ?? ''));
    const evEnds = Date.parse(String(event.ends_at ?? ''));
    if (!Number.isFinite(evStarts) || !Number.isFinite(evEnds)) continue;
    if (evStarts < ends && evEnds > starts) return event;
  }
  return null;
}

export function withoutDuplicateSlots(slots: NewSlot[], existing: Array<NewSlot & { status: string }>): { fresh: NewSlot[]; skipped: number } {
  const key = (s: NewSlot) => `${Date.parse(s.starts_at)}|${Date.parse(s.ends_at)}`;
  const taken = new Set(existing.filter(s => s.status !== 'cancelled').map(key));
  const fresh: NewSlot[] = [];
  let skipped = 0;
  for (const slot of slots) {
    const k = key(slot);
    if (taken.has(k)) { skipped += 1; continue; }
    taken.add(k);
    fresh.push(slot);
  }
  return { fresh, skipped };
}
