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

import { isVideoService, serviceLabel, serviceOfProvider } from './conference.ts';

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
