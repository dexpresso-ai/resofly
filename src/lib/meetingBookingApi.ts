import { supabase } from './supabase';
import type {
  MeetingBooking,
  MeetingBookingLink,
  MeetingBookingLinkListItem,
  MeetingBookingSlot,
  UUID,
} from '../types';

type Ok<T> = { ok: true } & T;

async function invoke<T>(organizationId: UUID, body: Record<string, unknown>): Promise<Ok<T>> {
  const { data, error } = await supabase.functions.invoke('meeting-booking', { body: { ...body, organizationId } });
  if (error) {
    // Edge function non-2xx: probeer de foutmelding uit de body te halen.
    const ctx = (error as { context?: { body?: unknown } }).context;
    const msg = typeof ctx?.body === 'string' ? tryParseError(ctx.body) : null;
    throw new Error(msg || error.message || 'Boekingstool-actie mislukt.');
  }
  if (!data || data.ok !== true) throw new Error(data?.error ?? 'De boekingstool gaf geen geldig antwoord terug.');
  return data as Ok<T>;
}

function tryParseError(body: string): string | null {
  try { const j = JSON.parse(body); return typeof j?.error === 'string' ? j.error : null; } catch { return null; }
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
}

export interface BookingLinkPatch {
  title?: string;
  introText?: string | null;
  inviteMessage?: string | null;
  meetingUrl?: string | null;
  maxTotalBookings?: number;
  maxPerWeek?: number;
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
}

export interface AddSlotsResult {
  slots: MeetingBookingSlot[];
  warnings: Array<{ starts_at: string; conflict: string }>;
}

export interface TokenResult {
  link: MeetingBookingLink;
  token: string;
  booking_url: string;
}

export async function listBookingLinks(organizationId: UUID): Promise<MeetingBookingLinkListItem[]> {
  const data = await invoke<{ links: MeetingBookingLinkListItem[] }>(organizationId, { action: 'listLinks' });
  return data.links;
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

export async function regenerateBookingToken(organizationId: UUID, linkId: UUID): Promise<TokenResult> {
  return await invoke<TokenResult>(organizationId, { action: 'regenerateToken', linkId });
}

export async function addBookingSlots(organizationId: UUID, linkId: UUID, slots: Array<{ startsAt: string; endsAt: string }>): Promise<AddSlotsResult> {
  return await invoke<AddSlotsResult>(organizationId, { action: 'addSlots', linkId, slots });
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
