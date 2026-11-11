import { supabase } from './supabase';
import { throwFunctionError } from './functionErrors';
import type {
  ConferenceProvider,
  MeetingBooking,
  MeetingBookingLink,
  MeetingBookingLinkListItem,
  MeetingBookingLinkState,
  MeetingBookingSlot,
  UUID,
} from '../types';

type Ok<T> = { ok: true } & T;

async function invoke<T>(organizationId: UUID, body: Record<string, unknown>): Promise<Ok<T>> {
  const { data, error } = await supabase.functions.invoke('meeting-booking', { body: { ...body, organizationId } });
  // Bij een 4xx zit de uitleg van de server in de Response (error.context). Hier
  // las de code eerst error.context.body, dat bij supabase-js nooit bestaat: je
  // zag dan "Edge Function returned a non-2xx status code" in plaats van
  // bijvoorbeeld "Er staan geen vrije momenten op deze link".
  if (error) await throwFunctionError(error, 'De actie op de boekingslink is mislukt.');
  if (!data || data.ok !== true) throw new Error(data?.error ?? 'De boekingstool gaf geen geldig antwoord terug.');
  return data as Ok<T>;
}

export interface CreateBookingLinkInput {
  sourceId: UUID;
  clientId?: UUID | null;
  title?: string;
  introText?: string | null;
  inviteMessage?: string | null;
  meetingUrl?: string | null;
  maxTotalBookings: number;
  maxPerWeek: number;
  autoConference?: boolean;
  /** Bij autoConference: Meet/Teams van de agenda, of een eigen Jitsi-kamer per boeking. */
  conferenceProvider?: ConferenceProvider;
}

export interface BookingLinkPatch {
  title?: string;
  introText?: string | null;
  inviteMessage?: string | null;
  meetingUrl?: string | null;
  maxTotalBookings?: number;
  maxPerWeek?: number;
  autoConference?: boolean;
  conferenceProvider?: ConferenceProvider;
  status?: 'active' | 'closed';
  sourceId?: UUID;
  clientId?: UUID | null;
}

export interface BookingLinkDetail {
  link: MeetingBookingLink;
  slots: MeetingBookingSlot[];
  bookings: MeetingBooking[];
  source_name: string | null;
  source_provider: string | null;
  needs_reconnect: boolean;
  /** Kan de maker van de link nog boeken (actief, schrijfrecht op de Agenda)? */
  owner_can_book: boolean;
  /** Vrije momenten die nog moeten beginnen. */
  open_slot_count: number;
  state: MeetingBookingLinkState;
}

export interface AddSlotsResult {
  slots: MeetingBookingSlot[];
  warnings: Array<{ starts_at: string; conflict: string }>;
  /** Blokken die precies zo al op de link stonden en dus zijn overgeslagen. */
  skipped?: number;
  /**
   * Met `skipClashes`: de momenten die er niet op kwamen omdat je dan al een
   * afspraak hebt. Ontbreekt bij een oudere server; die geeft `warnings`.
   */
  clashes?: Array<{ starts_at: string; ends_at: string; conflict: string }>;
}

export interface TokenResult {
  link: MeetingBookingLink;
  token: string;
  booking_url: string;
}

/** Alle boekingslinks, of die van één klant (de klantpagina). Leesrecht op de Agenda is genoeg. */
export async function listBookingLinks(organizationId: UUID, options: { clientId?: UUID | null } = {}): Promise<MeetingBookingLinkListItem[]> {
  const data = await invoke<{ links: MeetingBookingLinkListItem[] }>(organizationId, { action: 'listLinks', ...(options.clientId ? { clientId: options.clientId } : {}) });
  return data.links;
}

export interface BookingSlotInRange {
  id: UUID;
  booking_link_id: UUID;
  link_title: string;
  starts_at: string;
  ends_at: string;
  status: 'open' | 'pending' | 'booked' | 'cancelled';
}

/** Alle slots van actieve boekingslinks binnen een datumbereik (voor de agenda-laag). */
export async function listBookingSlotsInRange(organizationId: UUID, start: string, end: string): Promise<BookingSlotInRange[]> {
  const data = await invoke<{ slots: BookingSlotInRange[] }>(organizationId, { action: 'listSlotsInRange', start, end });
  return data.slots;
}

export async function getBookingLink(organizationId: UUID, linkId: UUID): Promise<BookingLinkDetail> {
  return await invoke<BookingLinkDetail>(organizationId, { action: 'getLink', linkId });
}

export async function createBookingLink(organizationId: UUID, input: CreateBookingLinkInput): Promise<TokenResult> {
  return await invoke<TokenResult>(organizationId, { action: 'createLink', ...input });
}

export async function updateBookingLink(organizationId: UUID, linkId: UUID, patch: BookingLinkPatch): Promise<MeetingBookingLink> {
  const data = await invoke<{ link: MeetingBookingLink }>(organizationId, { action: 'updateLink', linkId, patch });
  return data.link;
}

/** Een nieuwe URL: de oude link (ook die in een eerder verstuurde mail) werkt daarna niet meer. */
export async function regenerateBookingToken(organizationId: UUID, linkId: UUID): Promise<TokenResult> {
  return await invoke<TokenResult>(organizationId, { action: 'regenerateToken', linkId });
}

/** Dezelfde URL langer laten werken (of weer, als hij verlopen is). */
export async function extendBookingLink(organizationId: UUID, linkId: UUID, ttlDays = 120): Promise<MeetingBookingLink> {
  const data = await invoke<{ link: MeetingBookingLink }>(organizationId, { action: 'extendLink', linkId, ttlDays });
  return data.link;
}

/** Verwijdert een volledige boekingslink; server weigert (409) als er al geboekt is. */
export async function deleteBookingLink(organizationId: UUID, linkId: UUID): Promise<void> {
  await invoke<Record<string, never>>(organizationId, { action: 'deleteLink', linkId });
}

/**
 * Momenten op een link zetten. `skipClashes`: een moment dat botst met een
 * afspraak in je agenda's komt er niet op (zie `clashes`). Zonder blijft het een
 * waarschuwing; dat is voor een moment dat iemand bewust met de hand koos.
 */
export async function addBookingSlots(organizationId: UUID, linkId: UUID, slots: Array<{ startsAt: string; endsAt: string }>, options: { skipClashes?: boolean } = {}): Promise<AddSlotsResult> {
  return await invoke<AddSlotsResult>(organizationId, { action: 'addSlots', linkId, slots, ...(options.skipClashes ? { skipClashes: true } : {}) });
}

export async function removeBookingSlot(organizationId: UUID, linkId: UUID, slotId: UUID): Promise<void> {
  await invoke<Record<string, never>>(organizationId, { action: 'removeSlot', linkId, slotId });
}

export async function sendBookingLinkMail(organizationId: UUID, linkId: UUID, token: string, recipient?: { email?: string; name?: string }): Promise<{ email_id: string }> {
  return await invoke<{ email_id: string }>(organizationId, {
    action: 'sendLinkMail', linkId, token,
    recipientEmail: recipient?.email, recipientName: recipient?.name,
  });
}

export async function cancelBooking(organizationId: UUID, bookingId: UUID): Promise<void> {
  await invoke<Record<string, never>>(organizationId, { action: 'cancelBooking', bookingId });
}
