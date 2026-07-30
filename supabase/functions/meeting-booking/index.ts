// ============================================================
// ResoFly — Meeting Booking Tool: interne beheer-API
//
// Geauthenticeerde acties voor de gebruiker die boekingslinks beheert:
// links aanmaken/bewerken, beschikbare blokken toevoegen/verwijderen (met
// overlap-waarschuwing t.o.v. de bestaande agenda), de link mailen naar de
// klant, en boekingen inzien/annuleren.
//
// Ingebouwde Deno.serve (geen deno.land/std-import). Alle schrijfacties lopen
// via de service-role client (supabaseAdmin) na org-toegangscontrole.
// ============================================================

import {
  HttpError,
  requireUser,
  requireOrganizationAccess,
  assertModuleAccess,
  assertWriteRole,
  isUuid,
} from '../_shared/edgeAuth.ts';
import {
  supabaseAdmin,
  sanitizeMeetingUrl,
  assertIso,
  type CalendarSourceRow,
  type NativeEventRow,
} from '../_shared/calendarCore.ts';
import { listEvents } from '../_shared/calendarAvailability.ts';
import { getExternalWriteAccessToken, sendEventCancellations } from '../_shared/calendarEventWrite.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { renderMeetingBookingLinkEmail } from '../_shared/emailTemplates/meetingBookingLinkSent.ts';
import type { EmailTemplateContent } from '../_shared/emailTemplates/content.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const BOOKING_PUBLIC_BASE_URL = (Deno.env.get('BOOKING_PUBLIC_BASE_URL') || Deno.env.get('APP_PUBLIC_URL') || '').replace(/\/$/, '');
const DEFAULT_TOKEN_TTL_DAYS = 120;

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
    assertWriteRole(role);
    // Boekingslinks horen bij de Agenda-module.
    await assertModuleAccess(supabaseAdmin, user.id, organizationId, 'calendar', 'write');

    switch (action) {
      case 'listLinks': return json({ ok: true, links: await listLinks(organizationId) });
      case 'listSlotsInRange': return json({ ok: true, slots: await listSlotsInRange(organizationId, String(body.start || ''), String(body.end || '')) });
      case 'getLink': return json({ ok: true, ...(await getLink(organizationId, String(body.linkId || ''))) });
      case 'createLink': return json({ ok: true, ...(await createLink(organizationId, user.id, body)) });
      case 'updateLink': return json({ ok: true, link: await updateLink(organizationId, String(body.linkId || ''), body.patch || {}) });
      case 'deleteLink': await deleteLink(organizationId, String(body.linkId || '')); return json({ ok: true });
      case 'regenerateToken': return json({ ok: true, ...(await regenerateToken(organizationId, String(body.linkId || ''), Number(body.ttlDays) || DEFAULT_TOKEN_TTL_DAYS)) });
      case 'addSlots': return json({ ok: true, ...(await addSlots(organizationId, user.id, String(body.linkId || ''), body.slots || [])) });
      case 'removeSlot': await removeSlot(organizationId, String(body.linkId || ''), String(body.slotId || '')); return json({ ok: true });
      case 'sendLinkMail': return json({ ok: true, ...(await sendLinkMail(organizationId, String(body.linkId || ''), body)) });
      case 'cancelBooking': await cancelBooking(organizationId, String(body.bookingId || '')); return json({ ok: true });
      default: throw new HttpError(`Onbekende meeting-booking action: ${action}`, 400);
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('meeting-booking error', error);
    return json({ ok: false, error: error instanceof Error ? error.message : 'Onbekende meeting-booking fout.' }, status);
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

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function loadLink(organizationId: string, linkId: string): Promise<LinkRow> {
  if (!isUuid(linkId)) throw new HttpError('Ongeldige boekingslink.', 400);
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').select('*').eq('organization_id', organizationId).eq('id', linkId).single();
  if (error || !data) throw new HttpError('Boekingslink niet gevonden.', 404);
  return data as LinkRow;
}

/** Valideert dat de agenda-bron in de org bestaat en de gebruiker erbij mag. */
async function assertUsableSource(organizationId: string, userId: string, sourceId: string): Promise<CalendarSourceRow> {
  if (!isUuid(sourceId)) throw new HttpError('Kies een agenda voor deze boekingslink.', 422);
  const { data, error } = await supabaseAdmin.from('calendar_sources').select('*').eq('organization_id', organizationId).eq('id', sourceId).single();
  if (error || !data) throw new HttpError('Agenda-bron niet gevonden.', 404);
  const source = data as CalendarSourceRow;
  if (source.user_id !== userId && source.visibility !== 'organization') {
    throw new HttpError('Deze privé-agenda is niet met de organisatie gedeeld.', 403);
  }
  return source;
}

async function connectionNeedsReconnect(source: CalendarSourceRow | null): Promise<boolean> {
  if (!source || source.provider === 'native' || !source.connection_id) return false;
  const { data } = await supabaseAdmin.from('calendar_connections').select('status').eq('id', source.connection_id).maybeSingle();
  return !data || data.status !== 'active';
}

async function listLinks(organizationId: string) {
  const { data: links, error } = await supabaseAdmin.from('meeting_booking_links')
    .select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (error) throw new HttpError(error.message, 500);
  const rows = (links ?? []) as LinkRow[];
  if (rows.length === 0) return [];

  const clientIds = [...new Set(rows.map(r => r.client_id).filter(Boolean))] as string[];
  const sourceIds = [...new Set(rows.map(r => r.source_id).filter(Boolean))] as string[];
  const [clientsRes, sourcesRes, countsRes] = await Promise.all([
    clientIds.length ? supabaseAdmin.from('clients').select('id,name,contact_name,email').in('id', clientIds) : Promise.resolve({ data: [] }),
    sourceIds.length ? supabaseAdmin.from('calendar_sources').select('*').in('id', sourceIds) : Promise.resolve({ data: [] }),
    supabaseAdmin.from('meeting_bookings').select('booking_link_id,status').eq('organization_id', organizationId).in('status', ['pending', 'confirmed']),
  ]);
  const clientById = new Map((clientsRes.data ?? []).map((c: Record<string, unknown>) => [String(c.id), c]));
  const sourceById = new Map(((sourcesRes.data ?? []) as CalendarSourceRow[]).map(s => [s.id, s]));
  const bookingCount = new Map<string, number>();
  for (const b of (countsRes.data ?? []) as Record<string, unknown>[]) {
    bookingCount.set(String(b.booking_link_id), (bookingCount.get(String(b.booking_link_id)) || 0) + 1);
  }

  return Promise.all(rows.map(async (r) => {
    const source = r.source_id ? sourceById.get(r.source_id) ?? null : null;
    const client = r.client_id ? clientById.get(r.client_id) : null;
    return {
      ...r,
      client_name: client ? (client.name as string) : null,
      source_name: source ? source.name : null,
      source_provider: source ? source.provider : null,
      booking_count: bookingCount.get(r.id) || 0,
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
  const [slotsRes, bookingsRes, source] = await Promise.all([
    supabaseAdmin.from('meeting_booking_slots').select('*').eq('booking_link_id', linkId).order('starts_at', { ascending: true }),
    supabaseAdmin.from('meeting_bookings').select('*').eq('booking_link_id', linkId).order('created_at', { ascending: false }),
    link.source_id ? supabaseAdmin.from('calendar_sources').select('*').eq('id', link.source_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const sourceRow = (source.data ?? null) as CalendarSourceRow | null;
  return {
    link,
    slots: slotsRes.data ?? [],
    bookings: bookingsRes.data ?? [],
    source_name: sourceRow ? sourceRow.name : null,
    source_provider: sourceRow ? sourceRow.provider : null,
    needs_reconnect: await connectionNeedsReconnect(sourceRow),
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
  return patch;
}

async function createLink(organizationId: string, userId: string, body: Record<string, unknown>) {
  const source = await assertUsableSource(organizationId, userId, String(body.sourceId || ''));
  const clientId = body.clientId ? String(body.clientId) : null;
  if (clientId && !isUuid(clientId)) throw new HttpError('Ongeldige klant.', 422);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const ttlDays = Number(body.ttlDays) || DEFAULT_TOKEN_TTL_DAYS;
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000).toISOString();

  const insert = {
    organization_id: organizationId,
    user_id: userId,
    client_id: clientId,
    source_id: source.id,
    max_total_bookings: 1,
    max_per_week: 1,
    ...normalizeLinkInput(body),
    public_token_hash: tokenHash,
    public_token_created_at: new Date().toISOString(),
    public_token_expires_at: expiresAt,
  };
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').insert(insert).select('*').single();
  if (error) throw new HttpError(error.message, 500);
  return { link: data as LinkRow, token, booking_url: buildBookingUrl(token) };
}

async function updateLink(organizationId: string, linkId: string, patchBody: Record<string, unknown>): Promise<LinkRow> {
  const link = await loadLink(organizationId, linkId);
  const patch = normalizeLinkInput(patchBody);
  if (patchBody.sourceId !== undefined) {
    const source = await assertUsableSource(organizationId, link.user_id || '', String(patchBody.sourceId || ''));
    patch.source_id = source.id;
  }
  if (patchBody.clientId !== undefined) {
    const clientId = patchBody.clientId ? String(patchBody.clientId) : null;
    if (clientId && !isUuid(clientId)) throw new HttpError('Ongeldige klant.', 422);
    patch.client_id = clientId;
  }
  if (Object.keys(patch).length === 0) throw new HttpError('Geen geldige wijziging aangeleverd.', 422);
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').update(patch).eq('id', linkId).eq('organization_id', organizationId).select('*').single();
  if (error || !data) throw new HttpError('Boekingslink kon niet worden bijgewerkt.', 500);
  return data as LinkRow;
}

/**
 * Verwijdert een volledige boekingslink — maar alleen als er nog geen boeking op
 * staat (geen pending/confirmed boekingen), zodat er geen bevestigde afspraken in
 * iemands agenda verweesd achterblijven. Reeds geannuleerde/mislukte boekingen en
 * alle beschikbare blokken gaan via de foreign-key cascade automatisch mee.
 */
async function deleteLink(organizationId: string, linkId: string): Promise<void> {
  await loadLink(organizationId, linkId); // valideert org + bestaan (404 als onbekend)
  const { count, error: countError } = await supabaseAdmin
    .from('meeting_bookings')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('booking_link_id', linkId)
    .in('status', ['pending', 'confirmed']);
  if (countError) throw new HttpError(countError.message, 500);
  if ((count ?? 0) > 0) {
    throw new HttpError('Deze boekingslink is al (deels) geboekt. Annuleer eerst de boeking(en) voordat je de link verwijdert.', 409);
  }
  const { error } = await supabaseAdmin.from('meeting_booking_links')
    .delete().eq('id', linkId).eq('organization_id', organizationId);
  if (error) throw new HttpError(error.message, 500);
}

async function regenerateToken(organizationId: string, linkId: string, ttlDays: number) {
  await loadLink(organizationId, linkId);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').update({
    public_token_hash: tokenHash,
    public_token_created_at: new Date().toISOString(),
    public_token_expires_at: expiresAt,
  }).eq('id', linkId).eq('organization_id', organizationId).select('*').single();
  if (error || !data) throw new HttpError('Token kon niet worden vernieuwd.', 500);
  return { link: data as LinkRow, token, booking_url: buildBookingUrl(token) };
}

function buildBookingUrl(token: string): string {
  if (!BOOKING_PUBLIC_BASE_URL) return `/booking/${token}`;
  return `${BOOKING_PUBLIC_BASE_URL}/booking/${encodeURIComponent(token)}`;
}

async function addSlots(organizationId: string, userId: string, linkId: string, rawSlots: unknown) {
  const link = await loadLink(organizationId, linkId);
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) throw new HttpError('Geen tijdblokken aangeleverd.', 422);
  if (rawSlots.length > 200) throw new HttpError('Te veel blokken in één keer (max 200).', 422);

  const parsed = rawSlots.map((s) => {
    const rec = (s && typeof s === 'object') ? s as Record<string, unknown> : {};
    const startsAt = assertIso(String(rec.startsAt || ''), 'startsAt');
    const endsAt = assertIso(String(rec.endsAt || ''), 'endsAt');
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new HttpError('Eindtijd moet na starttijd liggen.', 422);
    return { starts_at: startsAt, ends_at: endsAt };
  }).sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  // Overlap-waarschuwing t.o.v. de bestaande agenda-items op de gekozen bron.
  const warnings: Array<{ starts_at: string; conflict: string }> = [];
  if (link.source_id) {
    const rangeStart = parsed[0].starts_at;
    const rangeEnd = parsed[parsed.length - 1].ends_at;
    try {
      const events = await listEvents(organizationId, userId, rangeStart, rangeEnd);
      const sameSource = events.filter(e => String(e.source_id) === link.source_id);
      for (const slot of parsed) {
        const s = new Date(slot.starts_at).getTime();
        const e = new Date(slot.ends_at).getTime();
        const clash = sameSource.find(ev => new Date(String(ev.starts_at)).getTime() < e && new Date(String(ev.ends_at)).getTime() > s);
        if (clash) warnings.push({ starts_at: slot.starts_at, conflict: String(clash.title || 'Bestaande afspraak') });
      }
    } catch (err) {
      console.warn('overlap check failed', err);
    }
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
  return { slots: data ?? [], warnings };
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

async function orgBrandName(organizationId: string): Promise<string> {
  const { data } = await supabaseAdmin.from('organizations').select('name').eq('id', organizationId).maybeSingle();
  return (data?.name as string) || 'ResoFly';
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

async function sendLinkMail(organizationId: string, linkId: string, body: Record<string, unknown>) {
  if (!RESEND_API_KEY) throw new HttpError('RESEND_API_KEY ontbreekt in de Edge Function secrets.', 500);
  const link = await loadLink(organizationId, linkId);
  if (!link.public_token_hash) throw new HttpError('Deze link heeft nog geen geldig token. Vernieuw de link.', 409);
  if (link.public_token_expires_at && new Date(link.public_token_expires_at).getTime() < Date.now()) {
    throw new HttpError('De link is verlopen. Vernieuw de link voordat je hem verstuurt.', 409);
  }

  // Ontvanger: expliciet meegegeven, anders het e-mailadres van de gekoppelde klant.
  let recipientEmail = String(body.recipientEmail || '').trim().toLowerCase();
  let recipientName = String(body.recipientName || '').trim();
  if ((!recipientEmail || !recipientName) && link.client_id) {
    const { data: client } = await supabaseAdmin.from('clients').select('name,contact_name,email').eq('id', link.client_id).maybeSingle();
    if (client) {
      recipientEmail = recipientEmail || String(client.email || '').trim().toLowerCase();
      recipientName = recipientName || String(client.contact_name || client.name || '').trim();
    }
  }
  if (!isEmail(recipientEmail)) throw new HttpError('Vul een geldig e-mailadres in voor de ontvanger.', 422);

  // De publieke link zelf kunnen we niet reconstrueren uit de hash; de UI stuurt
  // het plaintext token mee dat het bij aanmaken/regenereren teruggekregen heeft.
  const token = String(body.token || '').trim();
  if (!token) throw new HttpError('De boekingslink (token) ontbreekt. Vernieuw de link en probeer opnieuw.', 422);
  if (await sha256Hex(token) !== link.public_token_hash) throw new HttpError('Het meegestuurde token hoort niet bij deze link.', 422);
  const bookingUrl = buildBookingUrl(token);

  const brandName = await orgBrandName(organizationId);
  const content = await loadBookingEmailContent(organizationId, 'meetingBooking.linkSent');
  const rendered = renderMeetingBookingLinkEmail({
    brandName,
    recipientName: recipientName || null,
    title: link.title,
    introText: link.intro_text,
    bookingUrl,
    content,
  });

  const sender = await resolveSenderIdentity(supabaseAdmin, organizationId, RESEND_FROM_EMAIL);
  if (!sender.from) throw new HttpError('Er is geen afzender-e-mailadres geconfigureerd (RESEND_FROM_EMAIL of eigen domein).', 500);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: sender.from,
      to: [recipientEmail],
      reply_to: sender.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    }),
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
  const { data: refs, error } = await supabaseAdmin.rpc('cancel_meeting_booking', {
    p_organization_id: organizationId,
    p_booking_id: bookingId,
  });
  if (error) throw new HttpError(error.message, 500);
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
