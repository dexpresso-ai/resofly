// ============================================================
// ResoFly — Meeting Booking Tool: interne beheer-API
//
// Geauthenticeerde acties voor de gebruiker die boekingslinks beheert:
// links aanmaken/bewerken, beschikbare blokken toevoegen/verwijderen (met
// overlap-waarschuwing t.o.v. de bestaande agenda), de link mailen naar de
// klant, en boekingen inzien/annuleren.
//
// Lezen (de lijst, één link, de blokken in de agenda) vraagt leesrecht op de
// Agenda; al het andere schrijfrecht. Eerst vroeg ook lezen schrijfrecht, en
// dan kon een teamlid dat de Agenda alleen mag lezen de boekingen van een
// klant niet zien, terwijl de database ze hem wel gaf (harde regel 3).
//
// Ingebouwde Deno.serve (geen deno.land/std-import). Alle schrijfacties lopen
// via de service-role client (supabaseAdmin) na org-toegangscontrole.
// ============================================================

import { takeEmailQuota } from '../_shared/emailQuota.ts';
import {
  HttpError,
  requireUser,
  requireOrganizationAccess,
  assertModuleAccess,
  assertWriteRole,
  isUuid,
  type HttpStatus,
} from '../_shared/edgeAuth.ts';
import { dbErrorAnswer } from '../_shared/dbError.ts';
import { isWriterRole, memberModuleLevel } from '../_shared/roles.ts';
import {
  BOOKING_VIDEO_NAMES,
  DEFAULT_TOKEN_TTL_DAYS,
  MAX_OPEN_SLOTS_PER_LINK,
  bookingLinkState,
  bookingVideoService,
  checkNewSlots,
  clampTtlDays,
  cleanVisitorEmail,
  cleanVisitorName,
  expiryAfter,
  isActiveBooking,
  isBookableSlot,
  slotClash,
  withoutDuplicateSlots,
} from '../_shared/meetingBookingRules.ts';
import {
  supabaseAdmin,
  sanitizeMeetingUrl,
  assertIso,
  type CalendarSourceRow,
  type NativeEventRow,
} from '../_shared/calendarCore.ts';
import { listEvents } from '../_shared/calendarAvailability.ts';
import { getExternalWriteAccessToken, sendEventCancellations } from '../_shared/calendarEventWrite.ts';
import { calendarConferenceBlockedReason, calendarConferenceService, isVideoService, serviceProvider, videoServiceStateMessage } from '../_shared/conference.ts';
import { videoServiceStatus } from '../_shared/onlineMeetings.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { clientBaseUrl } from '../_shared/clientLinks.ts';
import { renderMeetingBookingLinkEmail } from '../_shared/emailTemplates/meetingBookingLinkSent.ts';
import type { EmailTemplateContent } from '../_shared/emailTemplates/content.ts';
import { loadSenderBrand, withEmailBrand } from '../_shared/emailBrand.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const BOOKING_PUBLIC_BASE_URL = (Deno.env.get('BOOKING_PUBLIC_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '').replace(/\/$/, '');

/** Alleen lezen: daarvoor is leesrecht op de Agenda genoeg. */
const READ_ACTIONS = new Set(['listLinks', 'listSlotsInRange', 'getLink']);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type LinkRow = {
  id: string;
  organization_id: string;
  user_id: string | null;
  client_id: string | null;
  source_id: string | null;
  title: string;
  intro_text: string | null;
  invite_message: string | null;
  meeting_url: string | null;
  max_total_bookings: number;
  max_per_week: number;
  auto_conference: boolean;
  /**
   * Bij auto_conference: Meet/Teams van de agenda ('calendar'), een eigen
   * Jitsi-kamer per boeking, of per boeking een Google Meet of Teams via de
   * koppeling van de maker van de link.
   */
  conference_provider?: 'calendar' | 'jitsi' | 'google_meet' | 'teams';
  status: 'active' | 'closed';
  public_token_hash: string | null;
  public_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  try {
    if (req.method !== 'POST') throw new HttpError('Method not allowed', 400);
    const user = await requireUser(supabaseAdmin, req);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    const role = await requireOrganizationAccess(supabaseAdmin, user.id, organizationId);
    // Boekingslinks horen bij de Agenda-module.
    if (READ_ACTIONS.has(action)) {
      await assertModuleAccess(supabaseAdmin, user.id, organizationId, 'calendar', 'read');
    } else {
      assertWriteRole(role);
      await assertModuleAccess(supabaseAdmin, user.id, organizationId, 'calendar', 'write');
    }

    switch (action) {
      case 'listLinks': return json({ ok: true, links: await listLinks(organizationId, body.clientId ? String(body.clientId) : null) });
      case 'listSlotsInRange': return json({ ok: true, slots: await listSlotsInRange(organizationId, String(body.start || ''), String(body.end || '')) });
      case 'getLink': return json({ ok: true, ...(await getLink(organizationId, String(body.linkId || ''))) });
      case 'createLink': return json({ ok: true, ...(await createLink(organizationId, user.id, body)) });
      case 'updateLink': return json({ ok: true, link: await updateLink(organizationId, user.id, String(body.linkId || ''), body.patch || {}) });
      case 'deleteLink': await deleteLink(organizationId, String(body.linkId || '')); return json({ ok: true });
      case 'regenerateToken': return json({ ok: true, ...(await regenerateToken(organizationId, String(body.linkId || ''), clampTtlDays(body.ttlDays))) });
      case 'extendLink': return json({ ok: true, link: await extendLink(organizationId, String(body.linkId || ''), clampTtlDays(body.ttlDays)) });
      case 'addSlots': return json({ ok: true, ...(await addSlots(organizationId, user.id, String(body.linkId || ''), body.slots || [], { skipClashes: body.skipClashes === true })) });
      case 'removeSlot': await removeSlot(organizationId, String(body.linkId || ''), String(body.slotId || '')); return json({ ok: true });
      case 'sendLinkMail': return json({ ok: true, ...(await sendLinkMail(organizationId, String(body.linkId || ''), body)) });
      case 'cancelBooking': await cancelBooking(organizationId, String(body.bookingId || '')); return json({ ok: true });
      default: throw new HttpError(`Onbekende meeting-booking action: ${action}`, 400);
    }
  } catch (error) {
    // Een eigen melding uit de database (annuleren van een boeking die nog
    // loopt, een dubbele klik) is een 4xx met die zin, geen 500.
    const answer = error instanceof HttpError ? null : dbErrorAnswer(error);
    const status = error instanceof HttpError ? error.status : answer ? answer.status : 500;
    if (status >= 500) console.error('meeting-booking error', error);
    const message = error instanceof HttpError ? error.message
      : answer ? answer.message
      : 'Er ging iets mis bij de boekingslinks. Probeer het opnieuw.';
    return json({ ok: false, error: message }, status);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function loadLink(organizationId: string, linkId: string): Promise<LinkRow> {
  if (!isUuid(linkId)) throw new HttpError('Ongeldige boekingslink.', 400);
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').select('*').eq('organization_id', organizationId).eq('id', linkId).single();
  if (error || !data) throw new HttpError('Boekingslink niet gevonden.', 404);
  return data as LinkRow;
}

/**
 * Een link zoals de app hem krijgt: zonder de hash van de token. Die is niet
 * terug te rekenen naar de link, maar hij hoort ook niet in elk scherm en in
 * elke log van de browser te staan; `has_token` zegt genoeg.
 */
function publicLinkRow(link: LinkRow): Omit<LinkRow, 'public_token_hash'> & { has_token: boolean } {
  const { public_token_hash, ...rest } = link;
  return { ...rest, has_token: Boolean(public_token_hash) };
}

/**
 * Vastgelopen pogingen (de publieke functie viel om tussen reserveren en
 * afronden) op 'failed', zodat de lijst, de tellers en verwijderen kloppen.
 * Migratie 20261110030000; staat die er nog niet, dan gewoon door.
 */
async function releaseStaleBookings(organizationId: string, linkId: string | null = null): Promise<void> {
  const { error } = await supabaseAdmin.rpc('release_stale_meeting_bookings', { p_organization_id: organizationId, p_booking_link_id: linkId });
  if (error) console.warn('release_stale_meeting_bookings mislukt', error.message);
}

/**
 * Mogen deze teamleden nog boeken namens hun link? Actief, een rol met
 * schrijfrecht, en schrijfrecht op de Agenda: dezelfde regel als
 * reserve_meeting_slot_by_token. Eén opvraag voor de hele lijst.
 */
async function ownersWhoCanBook(organizationId: string, userIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const { data, error } = await supabaseAdmin.from('organization_members')
    .select('user_id, role, module_access')
    .eq('organization_id', organizationId).eq('status', 'active').in('user_id', ids);
  if (error) throw new HttpError(`organization_members lookup mislukt: ${error.message}`, 500);
  const ok = new Set<string>();
  for (const row of (data ?? []) as Array<{ user_id: string; role: string; module_access: Record<string, unknown> | null }>) {
    if (isWriterRole(row.role) && memberModuleLevel(row.role, row.module_access, 'calendar') === 'write') ok.add(String(row.user_id));
  }
  return ok;
}

/**
 * Valideert dat de agenda-bron in de org bestaat, dat de maker van de link erbij
 * mag, en dat er geschreven kan worden. Eerst kon een link op een alleen-lezen
 * agenda staan (een ICS-abonnement, of Google zonder schrijfrecht); dan faalde
 * pas de boeking van de klant.
 */
async function assertUsableSource(organizationId: string, userId: string, sourceId: string): Promise<CalendarSourceRow> {
  if (!isUuid(sourceId)) throw new HttpError('Kies een agenda voor deze boekingslink.', 422);
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
  if (error || !data) throw new HttpError('Agenda-bron niet gevonden.', 404);
  const source = data as CalendarSourceRow;
  if (source.user_id !== userId && source.visibility !== 'organization') {
    throw new HttpError('Deze privé-agenda is niet met de organisatie gedeeld.', 403);
  }
  if (source.provider === 'ics') {
    throw new HttpError(`"${source.name}" is een alleen-lezen agenda via een link; daar kan niet in geboekt worden.`, 422);
  }
  if (source.provider !== 'native' && !source.write_enabled) {
    throw new HttpError(`In "${source.name}" mag ResoFly niet schrijven. Zet schrijven eerst aan bij Instellingen → Agenda.`, 422);
  }
  return source;
}

/** Valideert dat de gekoppelde klant bij deze organisatie hoort. */
async function assertOrgClient(organizationId: string, clientId: string): Promise<void> {
  if (!isUuid(clientId)) throw new HttpError('Ongeldige klant.', 422);
  const { data, error } = await supabaseAdmin.from('clients').select('id').eq('organization_id', organizationId).eq('id', clientId).maybeSingle();
  if (error || !data) throw new HttpError('Klant niet gevonden.', 404);
}

async function connectionNeedsReconnect(source: CalendarSourceRow | null): Promise<boolean> {
  if (!source || source.provider === 'native' || !source.connection_id) return false;
  const { data } = await supabaseAdmin.from('calendar_connections').select('status').eq('id', source.connection_id).maybeSingle();
  return !data || data.status !== 'active';
}

type BookingRow = {
  id: string;
  booking_link_id: string;
  slot_id: string;
  status: string;
  created_at: string;
  booked_name: string | null;
  booked_email: string;
};

/**
 * Alle boekingslinks van de organisatie, of van één klant (de klantpagina).
 * Per link wat het scherm nodig heeft om in één oogopslag te zeggen hoe hij
 * ervoor staat: de stand (open, gesloten, verlopen, vol, niet beschikbaar),
 * hoeveel momenten er nog vrij zijn, en welke afspraken eraan komen.
 */
async function listLinks(organizationId: string, clientId: string | null) {
  if (clientId !== null && !isUuid(clientId)) throw new HttpError('Ongeldige klant.', 422);
  await releaseStaleBookings(organizationId);
  let query = supabaseAdmin.from('meeting_booking_links')
    .select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (clientId) query = query.eq('client_id', clientId);
  const { data: links, error } = await query;
  if (error) throw new HttpError(error.message, 500);
  const rows = (links ?? []) as LinkRow[];
  if (rows.length === 0) return [];

  const now = Date.now();
  const linkIds = rows.map(r => r.id);
  const clientIds = [...new Set(rows.map(r => r.client_id).filter(Boolean))] as string[];
  const sourceIds = [...new Set(rows.map(r => r.source_id).filter(Boolean))] as string[];
  const [clientsRes, sourcesRes, bookingsRes, slotsRes, owners] = await Promise.all([
    clientIds.length ? supabaseAdmin.from('clients').select('id,name,contact_name,email').eq('organization_id', organizationId).in('id', clientIds) : Promise.resolve({ data: [] }),
    sourceIds.length ? supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).in('id', sourceIds) : Promise.resolve({ data: [] }),
    supabaseAdmin.from('meeting_bookings').select('id,booking_link_id,slot_id,status,created_at,booked_name,booked_email')
      .eq('organization_id', organizationId).in('booking_link_id', linkIds).in('status', ['pending', 'confirmed']),
    supabaseAdmin.from('meeting_booking_slots').select('id,booking_link_id,starts_at,ends_at,status,pending_at')
      .eq('organization_id', organizationId).in('booking_link_id', linkIds).gte('ends_at', new Date(now).toISOString())
      .order('starts_at', { ascending: true }).limit(5000),
    ownersWhoCanBook(organizationId, rows.map(r => r.user_id ?? '')),
  ]);
  const clientById = new Map((clientsRes.data ?? []).map((c: Record<string, unknown>) => [String(c.id), c]));
  const sourceById = new Map(((sourcesRes.data ?? []) as CalendarSourceRow[]).map(s => [s.id, s]));
  const slots = (slotsRes.data ?? []) as Array<{ id: string; booking_link_id: string; starts_at: string; ends_at: string; status: string; pending_at: string | null }>;
  const slotById = new Map(slots.map(s => [s.id, s]));
  const activeBookings = ((bookingsRes.data ?? []) as BookingRow[]).filter(b => isActiveBooking(b.status, b.created_at, now));

  return Promise.all(rows.map(async (r) => {
    const source = r.source_id ? sourceById.get(r.source_id) ?? null : null;
    const client = r.client_id ? clientById.get(r.client_id) : null;
    const mine = activeBookings.filter(b => b.booking_link_id === r.id);
    const bookable = slots.filter(s => s.booking_link_id === r.id && isBookableSlot(s, now));
    // Wat eraan komt: bevestigde afspraken waarvan het blok nog niet voorbij is.
    const upcoming = mine
      .filter(b => b.status === 'confirmed' && slotById.has(b.slot_id))
      .map(b => ({ id: b.id, name: b.booked_name, email: b.booked_email, starts_at: slotById.get(b.slot_id)!.starts_at, ends_at: slotById.get(b.slot_id)!.ends_at }))
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const ownerCanBook = Boolean(r.user_id && owners.has(r.user_id));
    return {
      ...publicLinkRow(r),
      client_name: client ? (client.name as string) : null,
      source_name: source ? source.name : null,
      source_provider: source ? source.provider : null,
      booking_count: mine.length,
      open_slot_count: bookable.length,
      next_open_slot_at: bookable[0]?.starts_at ?? null,
      upcoming_bookings: upcoming.slice(0, 5),
      owner_can_book: ownerCanBook,
      state: bookingLinkState({
        status: r.status, expiresAt: r.public_token_expires_at, ownerCanBook,
        hasSource: Boolean(source), activeBookings: mine.length, maxTotal: r.max_total_bookings, now,
      }),
      needs_reconnect: await connectionNeedsReconnect(source),
    };
  }));
}

/** Alle slots van ACTIEVE links in [start, end) — voor de persistente opties-laag in de agenda. */
async function listSlotsInRange(organizationId: string, start: string, end: string) {
  const startIso = assertIso(start, 'start');
  const endIso = assertIso(end, 'end');
  const { data: links } = await supabaseAdmin.from('meeting_booking_links')
    .select('id,title').eq('organization_id', organizationId).eq('status', 'active');
  const rows = (links ?? []) as Array<{ id: string; title: string }>;
  if (rows.length === 0) return [];
  const titleById = new Map(rows.map(l => [l.id, l.title]));
  const { data: slots } = await supabaseAdmin.from('meeting_booking_slots')
    .select('id,booking_link_id,starts_at,ends_at,status')
    .eq('organization_id', organizationId)
    .in('booking_link_id', rows.map(l => l.id))
    // Alleen nog-openstaande opties tonen in de agenda-laag. Zodra een blok geboekt
    // is, verschijnt het al als echte agenda-afspraak; een aparte optie-overlay is
    // dan overbodig.
    .eq('status', 'open')
    .lt('starts_at', endIso).gte('ends_at', startIso)
    .order('starts_at', { ascending: true });
  return (slots ?? []).map((s: Record<string, unknown>) => ({
    id: s.id, booking_link_id: s.booking_link_id, link_title: titleById.get(String(s.booking_link_id)) ?? '',
    starts_at: s.starts_at, ends_at: s.ends_at, status: s.status,
  }));
}

async function getLink(organizationId: string, linkId: string) {
  const link = await loadLink(organizationId, linkId);
  await releaseStaleBookings(organizationId, link.id);
  const [slotsRes, bookingsRes, source, owners] = await Promise.all([
    supabaseAdmin.from('meeting_booking_slots').select('*').eq('organization_id', organizationId).eq('booking_link_id', linkId).order('starts_at', { ascending: true }),
    supabaseAdmin.from('meeting_bookings').select('*').eq('organization_id', organizationId).eq('booking_link_id', linkId).order('created_at', { ascending: false }),
    link.source_id ? supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', link.source_id).maybeSingle() : Promise.resolve({ data: null }),
    ownersWhoCanBook(organizationId, [link.user_id ?? '']),
  ]);
  const sourceRow = (source.data ?? null) as CalendarSourceRow | null;
  const bookings = (bookingsRes.data ?? []) as BookingRow[];
  const now = Date.now();
  const ownerCanBook = Boolean(link.user_id && owners.has(link.user_id));
  const slots = (slotsRes.data ?? []) as Array<{ status: string; starts_at: string; pending_at: string | null }>;
  return {
    link: publicLinkRow(link),
    slots,
    bookings,
    source_name: sourceRow ? sourceRow.name : null,
    source_provider: sourceRow ? sourceRow.provider : null,
    needs_reconnect: await connectionNeedsReconnect(sourceRow),
    owner_can_book: ownerCanBook,
    open_slot_count: slots.filter(s => isBookableSlot(s, now)).length,
    state: bookingLinkState({
      status: link.status, expiresAt: link.public_token_expires_at, ownerCanBook,
      hasSource: Boolean(sourceRow), activeBookings: bookings.filter(b => isActiveBooking(b.status, b.created_at, now)).length,
      maxTotal: link.max_total_bookings, now,
    }),
    // De publieke boekings-URL wordt alleen bij aanmaken/regenereren als plaintext
    // teruggegeven; uit de opgeslagen hash valt hij niet te reconstrueren.
  };
}

function normalizeLinkInput(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 160);
  if ('introText' in body) patch.intro_text = body.introText ? String(body.introText).slice(0, 4000) : null;
  if ('inviteMessage' in body) patch.invite_message = body.inviteMessage ? String(body.inviteMessage).slice(0, 4000) : null;
  if ('meetingUrl' in body) patch.meeting_url = sanitizeMeetingUrl(body.meetingUrl);
  if (body.maxTotalBookings !== undefined) {
    const n = Number(body.maxTotalBookings);
    if (!Number.isInteger(n) || n < 1 || n > 999) throw new HttpError('Ongeldig totaal aantal boekingen.', 422);
    patch.max_total_bookings = n;
  }
  if (body.maxPerWeek !== undefined) {
    const n = Number(body.maxPerWeek);
    if (!Number.isInteger(n) || n < 1 || n > 99) throw new HttpError('Ongeldig aantal per week.', 422);
    patch.max_per_week = n;
  }
  if (body.status === 'active' || body.status === 'closed') patch.status = body.status;
  if (typeof body.autoConference === 'boolean') patch.auto_conference = body.autoConference;
  if (body.conferenceProvider === 'calendar' || body.conferenceProvider === 'jitsi' || isVideoService(body.conferenceProvider)) {
    patch.conference_provider = body.conferenceProvider;
  }
  return patch;
}

/**
 * Kan de gekozen videovergadering bij deze agenda?
 *
 * - Meet op een Google-agenda, Teams op een Microsoft-agenda: de agenda maakt
 *   hem zelf, als die agenda dat kan.
 * - Elders (de ResoFly-agenda, Teams bij een Google-agenda) maakt
 *   meeting-booking-public bij elke boeking een losse vergadering met de
 *   koppeling van de maker van de link. Dus kiest alleen die maker dit zelf,
 *   en alleen als hij er het recht voor gaf: een collega zet zo nooit
 *   vergaderingen in andermans Google- of Microsoft-account.
 */
async function assertBookingVideo(
  organizationId: string,
  requesterUserId: string,
  ownerUserId: string | null,
  conferenceProvider: unknown,
  source: Pick<CalendarSourceRow, 'provider' | 'conference_types'>,
): Promise<void> {
  if (!isVideoService(conferenceProvider)) return;
  if (serviceProvider(conferenceProvider) === source.provider) {
    if (calendarConferenceService(source.provider, source.conference_types) !== conferenceProvider) {
      throw new HttpError(calendarConferenceBlockedReason(source.provider), 409);
    }
    return;
  }
  if (!ownerUserId || ownerUserId !== requesterUserId) {
    throw new HttpError('Alleen wie de boekingslink maakte, kan Google Meet of Teams van zijn eigen account kiezen.', 403);
  }
  const status = (await videoServiceStatus(organizationId, requesterUserId))[conferenceProvider];
  if (status.state !== 'klaar') throw new HttpError(videoServiceStateMessage(conferenceProvider, status.state), 409);
}

async function createLink(organizationId: string, userId: string, body: Record<string, unknown>) {
  const source = await assertUsableSource(organizationId, userId, String(body.sourceId || ''));
  const clientId = body.clientId ? String(body.clientId) : null;
  if (clientId) await assertOrgClient(organizationId, clientId);

  const fields = normalizeLinkInput(body);
  if (fields.auto_conference !== false) await assertBookingVideo(organizationId, userId, userId, fields.conference_provider, source);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = expiryAfter(clampTtlDays(body.ttlDays, DEFAULT_TOKEN_TTL_DAYS));

  const insert = {
    organization_id: organizationId,
    user_id: userId,
    client_id: clientId,
    source_id: source.id,
    max_total_bookings: 1,
    max_per_week: 1,
    ...fields,
    public_token_hash: tokenHash,
    public_token_created_at: new Date().toISOString(),
    public_token_expires_at: expiresAt,
  };
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').insert(insert).select('*').single();
  if (error) throw new HttpError(error.message, 500);
  return { link: publicLinkRow(data as LinkRow), token, booking_url: await buildBookingUrl(organizationId, token) };
}

async function updateLink(organizationId: string, requesterUserId: string, linkId: string, patchBody: Record<string, unknown>) {
  const link = await loadLink(organizationId, linkId);
  const patch = normalizeLinkInput(patchBody);
  let newSource: CalendarSourceRow | null = null;
  if (patchBody.sourceId !== undefined) {
    newSource = await assertUsableSource(organizationId, link.user_id || '', String(patchBody.sourceId || ''));
    patch.source_id = newSource.id;
  }
  // De videokeuze opnieuw toetsen als die, de agenda of het aanzetten verandert.
  const videoTouched = patch.conference_provider !== undefined || newSource !== null || patch.auto_conference === true;
  const autoConference = patch.auto_conference !== undefined ? patch.auto_conference : link.auto_conference;
  if (videoTouched && autoConference !== false) {
    const source = newSource ?? (link.source_id
      ? (await supabaseAdmin.from('calendar_sources').select('provider, conference_types').eq('organization_id', organizationId).eq('id', link.source_id).maybeSingle()).data as Pick<CalendarSourceRow, 'provider' | 'conference_types'> | null
      : null);
    if (source) await assertBookingVideo(organizationId, requesterUserId, link.user_id, patch.conference_provider ?? link.conference_provider, source);
  }
  if (patchBody.clientId !== undefined) {
    const clientId = patchBody.clientId ? String(patchBody.clientId) : null;
    if (clientId) await assertOrgClient(organizationId, clientId);
    patch.client_id = clientId;
  }
  if (Object.keys(patch).length === 0) throw new HttpError('Geen geldige wijziging aangeleverd.', 422);
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').update(patch).eq('id', linkId).eq('organization_id', organizationId).select('*').single();
  if (error || !data) throw new HttpError('Boekingslink kon niet worden bijgewerkt.', 500);
  return publicLinkRow(data as LinkRow);
}

/**
 * Verwijdert een volledige boekingslink — maar alleen als er nog geen boeking op
 * staat (geen pending/confirmed boekingen), zodat er geen bevestigde afspraken in
 * iemands agenda verweesd achterblijven. Reeds geannuleerde/mislukte boekingen en
 * alle beschikbare blokken gaan via de foreign-key cascade automatisch mee.
 */
async function deleteLink(organizationId: string, linkId: string): Promise<void> {
  await loadLink(organizationId, linkId); // valideert org + bestaan (404 als onbekend)
  // Een vastgelopen poging hield een link anders voorgoed vast.
  await releaseStaleBookings(organizationId, linkId);
  const { count, error: countError } = await supabaseAdmin
    .from('meeting_bookings')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('booking_link_id', linkId)
    .in('status', ['pending', 'confirmed']);
  if (countError) throw new HttpError(countError.message, 500);
  if ((count ?? 0) > 0) {
    throw new HttpError('Via deze link zijn afspraken gemaakt. Sluit de link liever: dan kan er niets meer geboekt worden en blijven de afspraken bewaard.', 409);
  }
  const { error } = await supabaseAdmin.from('meeting_booking_links')
    .delete().eq('id', linkId).eq('organization_id', organizationId);
  if (error) throw new HttpError(error.message, 500);
}

async function regenerateToken(organizationId: string, linkId: string, ttlDays: number) {
  await loadLink(organizationId, linkId);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = expiryAfter(ttlDays);
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').update({
    public_token_hash: tokenHash,
    public_token_created_at: new Date().toISOString(),
    public_token_expires_at: expiresAt,
  }).eq('id', linkId).eq('organization_id', organizationId).select('*').single();
  if (error || !data) throw new HttpError('Token kon niet worden vernieuwd.', 500);
  return { link: publicLinkRow(data as LinkRow), token, booking_url: await buildBookingUrl(organizationId, token) };
}

/**
 * Verlengt de link die de klant al heeft: dezelfde URL werkt langer (of weer).
 * Eerst kon dat alleen met een nieuwe link, en die maakte de link in de mail
 * van de klant ongeldig. Nooit korter dan hij al was.
 */
async function extendLink(organizationId: string, linkId: string, ttlDays: number) {
  const link = await loadLink(organizationId, linkId);
  if (!link.public_token_hash) throw new HttpError('Deze boekingslink heeft nog geen URL. Maak eerst een link aan.', 409);
  const proposed = expiryAfter(ttlDays);
  const current = link.public_token_expires_at && Date.parse(link.public_token_expires_at) > Date.parse(proposed) ? link.public_token_expires_at : proposed;
  const { data, error } = await supabaseAdmin.from('meeting_booking_links')
    .update({ public_token_expires_at: current })
    .eq('id', linkId).eq('organization_id', organizationId).select('*').single();
  if (error || !data) throw new HttpError('De boekingslink kon niet worden verlengd.', 500);
  return publicLinkRow(data as LinkRow);
}

/** De publieke boekingspagina, op het klantadres van díe organisatie als dat er is (_shared/clientLinks.ts). */
async function buildBookingUrl(organizationId: string, token: string): Promise<string> {
  const base = await clientBaseUrl(supabaseAdmin, organizationId, BOOKING_PUBLIC_BASE_URL);
  if (!base) return `/booking/${token}`;
  return `${base}/booking/${encodeURIComponent(token)}`;
}

/**
 * Momenten op een link zetten. Met `skipClashes` komt een moment dat botst met
 * een afspraak in je agenda's er niet op (tekenen in het rooster, het
 * weekpatroon); zonder blijft het een waarschuwing (één moment met de hand,
 * Gerrie): dan koos een mens dat moment bewust.
 */
async function addSlots(organizationId: string, userId: string, linkId: string, rawSlots: unknown, opts: { skipClashes?: boolean } = {}) {
  const link = await loadLink(organizationId, linkId);
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) throw new HttpError('Geen tijdblokken aangeleverd.', 422);
  if (rawSlots.length > 200) throw new HttpError('Te veel blokken in één keer (max 200).', 422);

  const requested = rawSlots.map((s) => {
    const rec = (s && typeof s === 'object') ? s as Record<string, unknown> : {};
    const startsAt = assertIso(String(rec.startsAt || ''), 'startsAt');
    const endsAt = assertIso(String(rec.endsAt || ''), 'endsAt');
    return { starts_at: startsAt, ends_at: endsAt };
  }).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  // Geen blok in het verleden (dat kon niemand boeken, maar het stond wel in de
  // lijst), geen einde voor het begin, niet langer dan twaalf uur.
  try { checkNewSlots(requested); } catch (err) { throw new HttpError(err instanceof Error ? err.message : 'Ongeldig blok.', 422); }

  // Wat er precies zo al op de link staat, slaan we over: twee keer slepen op
  // hetzelfde uur gaf de klant eerst twee keer hetzelfde moment.
  const { data: existingRows } = await supabaseAdmin.from('meeting_booking_slots')
    .select('starts_at,ends_at,status').eq('organization_id', organizationId).eq('booking_link_id', linkId);
  const existing = (existingRows ?? []) as Array<{ starts_at: string; ends_at: string; status: string }>;
  const { fresh, skipped } = withoutDuplicateSlots(requested, existing);
  if (fresh.length === 0) return { slots: [], warnings: [], clashes: [], skipped };

  // Botst een moment met een afspraak in de agenda's van wie de link maakte
  // (slotClash)? Eerst keken we alleen naar de agenda van de link zelf.
  // Lukt het lezen niet (Google even onbereikbaar), dan gaan de momenten er
  // gewoon op: de publieke pagina kijkt bij het boeken nog eens.
  const warnings: Array<{ starts_at: string; conflict: string }> = [];
  const clashes: Array<{ starts_at: string; ends_at: string; conflict: string }> = [];
  let parsed = fresh;
  if (link.source_id) {
    const rangeStart = fresh[0].starts_at;
    const rangeEnd = fresh.reduce((max, s) => (s.ends_at > max ? s.ends_at : max), fresh[0].ends_at);
    try {
      const [events, ownSourceIds] = await Promise.all([
        listEvents(organizationId, userId, rangeStart, rangeEnd),
        calendarIdsOf(organizationId, link.user_id ?? userId),
      ]);
      const keep: typeof fresh = [];
      for (const slot of fresh) {
        const clash = slotClash(slot, events, { linkSourceId: link.source_id, ownSourceIds });
        if (!clash) { keep.push(slot); continue; }
        const conflict = String(clash.title || 'Bestaande afspraak');
        if (opts.skipClashes) {
          clashes.push({ starts_at: slot.starts_at, ends_at: slot.ends_at, conflict });
        } else {
          warnings.push({ starts_at: slot.starts_at, conflict });
          keep.push(slot);
        }
      }
      parsed = keep;
    } catch (err) {
      console.warn('overlap check failed', err);
    }
  }
  if (parsed.length === 0) return { slots: [], warnings, clashes, skipped };

  // Hooguit 500 vrije momenten die nog moeten komen per link: meer toont de
  // klantpagina niet. Met het weekpatroon zet je er in één klik tientallen op;
  // een vergissing ("elke dag, een jaar lang") hoort een melding te geven en
  // geen pagina die halverwege ophoudt.
  const nowMs = Date.now();
  const openAhead = existing.filter(s => (s.status === 'open' || s.status === 'pending') && Date.parse(s.starts_at) > nowMs).length;
  if (openAhead + parsed.length > MAX_OPEN_SLOTS_PER_LINK) {
    const room = Math.max(0, MAX_OPEN_SLOTS_PER_LINK - openAhead);
    throw new HttpError(room === 0
      ? `Op deze link staan al ${openAhead} vrije momenten; meer dan ${MAX_OPEN_SLOTS_PER_LINK} kan niet. Haal er eerst een paar weg.`
      : `Op een link passen hooguit ${MAX_OPEN_SLOTS_PER_LINK} vrije momenten. Er kunnen er nog ${room} bij; je probeerde er ${parsed.length}.`, 422);
  }

  const insertRows = parsed.map(p => ({
    booking_link_id: linkId,
    organization_id: organizationId,
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    status: 'open' as const,
  }));
  const { data, error } = await supabaseAdmin.from('meeting_booking_slots').insert(insertRows).select('*');
  if (error) throw new HttpError(error.message, 500);
  return { slots: data ?? [], warnings, clashes, skipped };
}

/** De agenda's van één teamlid in deze organisatie: zijn ResoFly-agenda's, gekoppelde agenda's en abonnementen. */
async function calendarIdsOf(organizationId: string, userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('id')
    .eq('organization_id', organizationId).eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).map((row: { id: string }) => row.id);
}

async function removeSlot(organizationId: string, linkId: string, slotId: string): Promise<void> {
  if (!isUuid(slotId)) throw new HttpError('Ongeldig tijdblok.', 400);
  const { data: slot } = await supabaseAdmin.from('meeting_booking_slots').select('status').eq('id', slotId).eq('organization_id', organizationId).eq('booking_link_id', linkId).maybeSingle();
  if (!slot) throw new HttpError('Tijdblok niet gevonden.', 404);
  if (slot.status === 'booked' || slot.status === 'pending') {
    throw new HttpError('Dit blok is (bijna) geboekt. Annuleer eerst de boeking.', 409);
  }
  const { error } = await supabaseAdmin.from('meeting_booking_slots').delete().eq('id', slotId).eq('organization_id', organizationId);
  if (error) throw new HttpError(error.message, 500);
}

/** Aangepaste e-mailtekst (email_templates) voor een booking-template; null = defaults. */
async function loadBookingEmailContent(organizationId: string, templateKey: string): Promise<EmailTemplateContent | null> {
  const { data, error } = await supabaseAdmin.from('email_templates')
    .select('enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId).eq('template_key', templateKey).maybeSingle();
  if (error || !data) return null;
  const row = data as { enabled: boolean; subject: string | null; intro: string | null; closing: string | null; cta_label: string | null };
  return { enabled: row.enabled, subject: row.subject, intro: row.intro, closing: row.closing, ctaLabel: row.cta_label };
}

/**
 * Kan de klant met deze link nu echt iets boeken? Zo niet, dan sturen we hem
 * niet: een mail naar een gesloten link of een lege pagina is erger dan geen
 * mail. Dezelfde voorwaarden als `booking_link.send_mail` van Gerrie.
 */
async function assertMailable(organizationId: string, link: LinkRow): Promise<void> {
  if (link.status !== 'active') throw new HttpError('Deze boekingslink is gesloten. Heropen hem voordat je hem verstuurt.', 409);
  if (!link.public_token_hash) throw new HttpError('Deze link heeft nog geen geldig token. Vernieuw de link.', 409);
  if (!link.public_token_expires_at || Date.parse(link.public_token_expires_at) < Date.now()) {
    throw new HttpError('De link is verlopen. Verleng hem voordat je hem verstuurt.', 409);
  }
  const owners = await ownersWhoCanBook(organizationId, [link.user_id ?? '']);
  if (!link.user_id || !owners.has(link.user_id)) {
    throw new HttpError('Wie deze link maakte, mag niet meer in de Agenda schrijven (of is geen teamlid meer). Maak een nieuwe link.', 409);
  }
  const now = new Date().toISOString();
  const { data: slots } = await supabaseAdmin.from('meeting_booking_slots')
    .select('status,starts_at,pending_at')
    .eq('organization_id', organizationId).eq('booking_link_id', link.id)
    .in('status', ['open', 'pending']).gt('starts_at', now).limit(500);
  const bookable = ((slots ?? []) as Array<{ status: string; starts_at: string; pending_at: string | null }>).filter(s => isBookableSlot(s));
  if (bookable.length === 0) {
    throw new HttpError('Er staan geen vrije momenten op deze link. Voeg eerst een paar momenten toe, anders ziet de klant een lege pagina.', 409);
  }
}

async function sendLinkMail(organizationId: string, linkId: string, body: Record<string, unknown>) {
  if (!RESEND_API_KEY) throw new HttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  const link = await loadLink(organizationId, linkId);
  await assertMailable(organizationId, link);

  // Ontvanger: expliciet meegegeven, anders het e-mailadres van de gekoppelde klant.
  let recipientEmail = String(body.recipientEmail || '').trim().toLowerCase();
  let recipientName = cleanVisitorName(body.recipientName);
  if ((!recipientEmail || !recipientName) && link.client_id) {
    const { data: client } = await supabaseAdmin.from('clients').select('name,contact_name,email').eq('organization_id', organizationId).eq('id', link.client_id).maybeSingle();
    if (client) {
      recipientEmail = recipientEmail || String(client.email || '').trim().toLowerCase();
      recipientName = recipientName || cleanVisitorName(client.contact_name || client.name || '');
    }
  }
  const cleanEmail = cleanVisitorEmail(recipientEmail);
  if (!cleanEmail) throw new HttpError('Vul een geldig e-mailadres in voor de ontvanger.', 422);
  recipientEmail = cleanEmail;

  // De publieke link zelf kunnen we niet reconstrueren uit de hash; de UI stuurt
  // het plaintext token mee dat het bij aanmaken/regenereren teruggekregen heeft.
  const token = String(body.token || '').trim();
  if (!token) throw new HttpError('De boekingslink (token) ontbreekt. Vernieuw de link en probeer opnieuw.', 422);
  if (await sha256Hex(token) !== link.public_token_hash) throw new HttpError('Het meegestuurde token hoort niet bij deze link.', 422);
  const bookingUrl = await buildBookingUrl(organizationId, token);

  // Naam, merkkleur en logo in één query (_shared/emailBrand.ts): de merknaam
  // of bedrijfsnaam, en pas daarna de naam van de werkruimte.
  const brand = await loadSenderBrand(supabaseAdmin, organizationId);
  const brandName = brand.name;
  const content = await loadBookingEmailContent(organizationId, 'meetingBooking.linkSent');
  // Welk videogesprek het wordt, al in de uitnodiging (zoals op de boekingspagina).
  const { data: sourceRow } = link.source_id
    ? await supabaseAdmin.from('calendar_sources').select('provider').eq('organization_id', organizationId).eq('id', link.source_id).maybeSingle()
    : { data: null };
  const videoKind = bookingVideoService({
    meetingUrl: link.meeting_url,
    autoConference: link.auto_conference,
    conferenceProvider: link.conference_provider,
    sourceProvider: sourceRow ? String((sourceRow as { provider: string }).provider) : null,
  });
  const rendered = renderMeetingBookingLinkEmail({
    brandName,
    accentColor: brand.accent,
    recipientName: recipientName || null,
    title: link.title,
    introText: link.intro_text,
    bookingUrl,
    videoName: videoKind && videoKind !== 'link' ? BOOKING_VIDEO_NAMES[videoKind] : null,
    content,
  });

  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL);
  if (!sender.from) throw new HttpError('Er is geen afzender-e-mailadres geconfigureerd (RESEND_FROM_EMAIL of eigen domein).', 500);

  // Quotum per organisatie (20261101050000): één organisatie maakt het gedeelde Resend-account niet voor iedereen op.
  await takeEmailQuota(supabaseAdmin, organizationId, 1, (message, status) => new HttpError(message, status));
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(withEmailBrand({
      from: sender.from,
      to: [recipientEmail],
      reply_to: sender.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    }, brand.email)),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(payload.message || payload.error || res.statusText || 'Resend send failed');
    throw new HttpError(`Resend kon de boekingsmail niet versturen: ${msg}`, 502);
  }
  return { email_id: String(payload.id || payload.email_id || '') };
}

async function cancelBooking(organizationId: string, bookingId: string): Promise<void> {
  if (!isUuid(bookingId)) throw new HttpError('Ongeldige boeking.', 400);
  await releaseStaleBookings(organizationId);
  const { data: refs, error } = await supabaseAdmin.rpc('cancel_meeting_booking', {
    p_organization_id: organizationId,
    p_booking_id: bookingId,
  });
  if (error) {
    // "Wordt nog verwerkt" of "nooit doorgegaan": de zin uit de database.
    const answer = dbErrorAnswer(error);
    if (answer) throw new HttpError(answer.message, answer.status as HttpStatus);
    throw new HttpError(error.message, 500);
  }
  const ref = (Array.isArray(refs) ? refs[0] : refs) as { native_event_id: string | null; external_event_id: string | null; external_provider: string | null; source_id: string | null } | null;
  if (!ref) return;

  // Bijbehorend agenda-item verwijderen (best-effort; boeking is al geannuleerd).
  try {
    if (ref.native_event_id) {
      await cancelNativeEvent(organizationId, ref.native_event_id);
    } else if (ref.external_event_id && ref.external_provider && ref.source_id) {
      await cancelExternalEvent(organizationId, ref.source_id, ref.external_event_id);
    }
  } catch (err) {
    console.error('cancelBooking: agenda-item verwijderen mislukt', err);
  }
}

async function cancelNativeEvent(organizationId: string, eventId: string): Promise<void> {
  const { data: row } = await supabaseAdmin.from('calendar_events').select('*').eq('organization_id', organizationId).eq('id', eventId).maybeSingle();
  if (!row) return;
  const event = row as NativeEventRow;
  const { data: srcRow } = await supabaseAdmin.from('calendar_sources').select('*').eq('id', event.source_id).maybeSingle();
  await supabaseAdmin.from('calendar_events')
    .update({ deleted_at: new Date().toISOString(), sequence: (event.sequence ?? 0) + 1 })
    .eq('id', eventId);
  if (srcRow) await sendEventCancellations(organizationId, srcRow as CalendarSourceRow, event).catch(err => console.error('cancel invite', err));
}

async function cancelExternalEvent(organizationId: string, sourceId: string, providerEventId: string): Promise<void> {
  const { data: srcRow } = await supabaseAdmin.from('calendar_sources').select('*').eq('id', sourceId).eq('organization_id', organizationId).maybeSingle();
  if (!srcRow) return;
  const source = srcRow as CalendarSourceRow;
  if (!source.user_id) return;
  const accessToken = await getExternalWriteAccessToken(organizationId, source.user_id, source);
  const url = source.provider === 'google'
    ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(source.provider_calendar_id)}/events/${encodeURIComponent(providerEventId)}?sendUpdates=all`
    : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(providerEventId)}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error?.message || 'Agenda-item verwijderen mislukt.');
  }
}
