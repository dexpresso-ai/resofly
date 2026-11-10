// ============================================================
// ResoFly — Meeting Booking Tool: publieke (klant-facing) API
//
// Geen login. Toegang loopt via een onraadbaar token in de request-body, dat we
// gehasht vergelijken (zoals contract-public). Twee acties:
//  - getLink : de stand van de link, de huisstijl en de vrije momenten.
//  - bookSlots : momenten boeken via een twee-fasen-commit:
//      fase A = reserve_meeting_slot_by_token (DB, atomisch onder advisory lock)
//      fase B = agenda-item aanmaken bij de provider; bij succes finalize_*,
//               bij conflict/fout release_* (blok weer 'open').
//
// Een link kan nooit meer dan wie hem maakte: de afspraak komt in de agenda
// namens die persoon. Is hij geen actief teamlid met schrijfrecht op de Agenda
// meer, dan boekt de link niets (ook de database controleert dat).
//
// Ingebouwde Deno.serve (geen deno.land/std-import).
// ============================================================

import { supabaseAdmin } from '../_shared/calendarCore.ts';
import { clientOriginMismatch, clientOriginOf, rememberClientOrigin } from '../_shared/clientLinks.ts';
import { emailQuotaAllows } from '../_shared/emailQuota.ts';
import { listEvents } from '../_shared/calendarAvailability.ts';
import { createEvent } from '../_shared/calendarEventWrite.ts';
import { jitsiMeetingUrl } from '../_shared/jitsi.ts';
import { VideoUnavailableError, isVideoService, serviceLabel, type VideoService } from '../_shared/conference.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { renderMeetingBookingConfirmedEmail } from '../_shared/emailTemplates/meetingBookingConfirmed.ts';
import type { EmailTemplateContent } from '../_shared/emailTemplates/content.ts';
import { loadSenderBrand, withEmailBrand, type EmailBrand } from '../_shared/emailBrand.ts';
import { loadBranding } from '../_shared/branding.ts';
import { INVALID_CHARACTER_MESSAGE, containsNulCharacter, dbErrorAnswer } from '../_shared/dbError.ts';
import { isWriterRole, memberModuleLevel } from '../_shared/roles.ts';
import {
  MAX_SLOTS_PER_BOOKING,
  bookingLinkState,
  bookingVideoLabel,
  cleanVisitorEmail,
  cleanVisitorName,
  isActiveBooking,
  isBookableSlot,
  parseSlotIds,
} from '../_shared/meetingBookingRules.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';

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
  /** Ontbreekt zolang migratie 20261014000000 er niet op staat; dan geldt 'calendar'. */
  conference_provider?: 'calendar' | 'jitsi' | 'google_meet' | 'teams';
  status: 'active' | 'closed';
  public_token_hash: string | null;
  public_token_expires_at: string | null;
};

const NOT_FOUND = 'Deze boekingslink is niet (meer) geldig.';
const TOO_MANY = 'Je hebt het even te vaak geprobeerd. Wacht een paar minuten en probeer het dan opnieuw.';

Deno.serve(async (req) => {
  // Van een klantadres (jansen.resofly.com, portaal.jansen.nl)? Eén keer
  // opzoeken; CORS en de controle of de link bij dat adres hoort, lezen het
  // daarna (_shared/clientLinks.ts).
  await rememberClientOrigin(supabaseAdmin, req);
  if (req.method === 'OPTIONS') return json({ ok: true });
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    // Een NUL-teken kan Postgres niet opslaan; dat gaf een 500 voor de bezoeker.
    if (containsNulCharacter(body)) throw new HttpErr(INVALID_CHARACTER_MESSAGE, 422);
    const action = String(body.action || '');
    const token = String(body.token || '').trim();
    if (!token || token.length < 16 || token.length > 256) return json({ ok: false, error: 'Boekingslink ontbreekt of is ongeldig.' }, 400);

    // Een rem per afzender. De token is niet te raden (256 bits), maar het
    // antwoord bevat de huisstijl met logo's (een paar honderd kB), en boeken
    // maakt afspraken en mails. Dat hoort niemand eindeloos te kunnen herhalen.
    const sender = senderAddress(req);
    if (action === 'getLink' && await throttled(`booking-view:ip:${sender}`, 600, 120, 600)) throw new HttpErr(TOO_MANY, 429);
    if (action === 'bookSlots' && await throttled(`booking-book:ip:${sender}`, 600, 20, 900)) throw new HttpErr(TOO_MANY, 429);

    const tokenHash = await sha256Hex(token);
    const link = await loadLinkByHash(tokenHash);
    // Een boekingslink van een andere organisatie opent niet op dit klantadres:
    // zelfde antwoord als een onbekende link.
    if (clientOriginOf(req) && clientOriginMismatch(req, link.organization_id)) throw new HttpErr(NOT_FOUND, 404);

    switch (action) {
      case 'getLink': return json({ ok: true, ...(await getPublicLink(link)) });
      case 'bookSlots': {
        // Ook per link: wie de link heeft, kan er niet eindeloos pogingen mee doen.
        if (await throttled(`booking-book:link:${tokenHash}`, 3600, 30, 3600)) throw new HttpErr(TOO_MANY, 429);
        return json({ ok: true, ...(await bookSlots(link, tokenHash, body)) });
      }
      default: return json({ ok: false, error: `Onbekende actie: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof HttpErr ? error.status : 500;
    if (status >= 500) console.error('meeting-booking-public error', error);
    // Alleen onze eigen meldingen gaan naar de bezoeker; de rest staat in de log.
    return json({ ok: false, error: error instanceof HttpErr ? error.message : 'Er ging iets mis. Probeer het later opnieuw.' }, status);
  }
});

function json(payload: unknown, status = 200): Response {
  // no-store: het antwoord hoort bij een geheime link en kan een naam en
  // e-mailadres bevatten; geen tussenliggende cache mag het bewaren.
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function senderAddress(req: Request): string {
  return (req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || 'onbekend')
    .trim().slice(0, 64);
}

/**
 * Telt één aanvraag op deze sleutel (gehasht) met de teller van de
 * portal-login (portal_login_hit, migratie 20261101080000). Die is algemeen:
 * een gehashte sleutel, een venster en een grens. De sleutels beginnen hier met
 * "booking-", dus ze tellen nooit mee voor het inloggen. Een kapotte teller
 * blokkeert het boeken niet.
 */
async function throttled(key: string, windowSeconds: number, max: number, blockSeconds: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc('portal_login_hit', {
    p_key: await sha256Hex(key), p_window_seconds: windowSeconds, p_max_attempts: max, p_block_seconds: blockSeconds,
  });
  if (error) { console.warn('boekingsrem mislukt', error.message); return false; }
  return (Number(data) || 0) > 0;
}

async function loadLinkByHash(tokenHash: string): Promise<LinkRow> {
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').select('*').eq('public_token_hash', tokenHash).maybeSingle();
  if (error || !data) throw new HttpErr(NOT_FOUND, 404);
  return data as LinkRow;
}

class HttpErr extends Error { status: number; constructor(m: string, s = 400) { super(m); this.status = s; } }

/**
 * Mag de maker van de link nog boeken? Actief teamlid, een rol met
 * schrijfrecht, en schrijfrecht op de Agenda. Dezelfde regel als
 * reserve_meeting_slot_by_token in de database (20261110030000).
 */
async function ownerCanBook(link: LinkRow): Promise<boolean> {
  if (!link.user_id) return false;
  const { data, error } = await supabaseAdmin.from('organization_members')
    .select('role, module_access')
    .eq('organization_id', link.organization_id).eq('user_id', link.user_id).eq('status', 'active').limit(1);
  if (error) throw new Error(`organization_members lookup mislukt: ${error.message}`);
  const row = data?.[0] as { role?: string; module_access?: Record<string, unknown> | null } | undefined;
  if (!row?.role || !isWriterRole(row.role)) return false;
  return memberModuleLevel(row.role, row.module_access, 'calendar') === 'write';
}

/** De contactgegevens die de organisatie ook op haar offertes zet. Nooit meer dan dat. */
async function loadCompanyContact(organizationId: string): Promise<{ name: string | null; email: string | null; phone: string | null; website: string | null } | null> {
  const { data, error } = await supabaseAdmin.from('company_settings')
    .select('company_name,trade_name,email,phone,website')
    .eq('organization_id', organizationId).maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return { name: text(row.trade_name) ?? text(row.company_name), email: text(row.email), phone: text(row.phone), website: text(row.website) };
}

type BookingRow = { status: string; created_at: string; slot_id: string; meeting_booking_slots: { starts_at?: string; ends_at?: string } | Array<{ starts_at?: string; ends_at?: string }> | null };

async function getPublicLink(link: LinkRow) {
  const now = Date.now();
  const [branding, company, canBook, sourceRes, bookingsRes] = await Promise.all([
    loadBranding(supabaseAdmin, link.organization_id),
    loadCompanyContact(link.organization_id),
    ownerCanBook(link),
    link.source_id
      ? supabaseAdmin.from('calendar_sources').select('provider').eq('organization_id', link.organization_id).eq('id', link.source_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabaseAdmin.from('meeting_bookings')
      .select('status, created_at, slot_id, meeting_booking_slots!inner(starts_at, ends_at)')
      .eq('booking_link_id', link.id)
      .in('status', ['pending', 'confirmed']),
  ]);
  const sourceProvider = sourceRes.data ? String((sourceRes.data as { provider: string }).provider) : null;

  // Een poging die al tien minuten hangt, telt niet meer (de functie viel om).
  const active = ((bookingsRes.data ?? []) as BookingRow[]).filter(b => isActiveBooking(b.status, b.created_at, now));
  const slotOf = (b: BookingRow) => (Array.isArray(b.meeting_booking_slots) ? b.meeting_booking_slots[0] : b.meeting_booking_slots) ?? {};
  const state = bookingLinkState({
    status: link.status,
    expiresAt: link.public_token_expires_at,
    ownerCanBook: canBook,
    hasSource: Boolean(sourceProvider),
    activeBookings: active.length,
    maxTotal: link.max_total_bookings,
    now,
  });

  // Wat er via deze link al vastligt en nog moet komen: alleen de tijden, nooit
  // wie er boekte. Wie de link later nog eens opent, ziet zo wanneer hij komt.
  const booked = active
    .filter(b => b.status === 'confirmed')
    .map(b => ({ starts_at: String(slotOf(b).starts_at ?? ''), ends_at: String(slotOf(b).ends_at ?? '') }))
    .filter(b => b.starts_at && Date.parse(b.ends_at) > now)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const base = {
    state,
    link: {
      title: link.title,
      intro_text: link.intro_text,
      max_total_bookings: link.max_total_bookings,
      max_per_week: link.max_per_week,
      expires_at: link.public_token_expires_at,
      video: bookingVideoLabel({ meetingUrl: link.meeting_url, autoConference: link.auto_conference, conferenceProvider: link.conference_provider, sourceProvider }),
    },
    branding,
    company,
    booked,
    taken_slot_starts: active.map(b => String(slotOf(b).starts_at ?? '')).filter(Boolean),
  };
  if (state !== 'open') return { ...base, slots: [], prefill: null };

  // Alleen momenten die nog moeten beginnen. Eerst stond een blok tot het eind
  // op de pagina, en reserveren keek niet naar de begintijd.
  const { data: slotRows } = await supabaseAdmin.from('meeting_booking_slots')
    .select('id,starts_at,ends_at,status,pending_at')
    .eq('booking_link_id', link.id)
    .in('status', ['open', 'pending'])
    .gt('starts_at', new Date(now).toISOString())
    .order('starts_at', { ascending: true })
    .limit(500);
  const slots = ((slotRows ?? []) as Array<{ id: string; starts_at: string; ends_at: string; status: string; pending_at: string | null }>)
    .filter(s => isBookableSlot(s, now))
    .map(s => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at }));

  let prefill: { name: string | null; email: string | null } | null = null;
  if (link.client_id) {
    const { data: client } = await supabaseAdmin.from('clients').select('name,contact_name,email')
      .eq('organization_id', link.organization_id).eq('id', link.client_id).maybeSingle();
    if (client) prefill = { name: (client.contact_name || client.name || null) as string | null, email: (client.email || null) as string | null };
  }

  return { ...base, slots, prefill };
}

/** De melding voor de bezoeker bij een mislukt moment: onze eigen zin, of een algemene. */
function visitorReason(err: unknown): string {
  if (err instanceof HttpErr) return err.message;
  const answer = dbErrorAnswer(err);
  return answer?.message ?? 'Dit moment kon niet worden geboekt. Kies een ander moment.';
}

async function bookSlots(link: LinkRow, tokenHash: string, body: Record<string, unknown>) {
  const name = cleanVisitorName(body.name);
  const email = cleanVisitorEmail(body.email);
  if (!email) throw new HttpErr('Vul een geldig e-mailadres in.', 422);
  const slotIds = parseSlotIds(body.slotIds);
  if (slotIds.length === 0) throw new HttpErr('Kies minstens één moment.', 422);
  if (slotIds.length > MAX_SLOTS_PER_BOOKING) throw new HttpErr('Te veel momenten in één keer.', 422);
  if (link.status !== 'active') throw new HttpErr('Deze boekingslink is gesloten.', 410);
  if (!link.public_token_expires_at || Date.parse(link.public_token_expires_at) < Date.now()) throw new HttpErr('Deze boekingslink is verlopen.', 410);
  if (!link.source_id) throw new HttpErr('Deze boekingslink is niet meer gekoppeld aan een agenda. Neem contact op met de afzender.', 409);
  if (!link.user_id || !(await ownerCanBook(link))) {
    throw new HttpErr('Deze boekingslink is niet meer beschikbaar. Neem contact op met de afzender.', 409);
  }

  // Welke videovergadering de boeking krijgt. Een zelf geplakte vaste videolink
  // heeft altijd voorrang. Anders, met auto_conference aan:
  //   jitsi       — per geboekt blok een eigen Jitsi-kamer op de server van de
  //                 organisatie; werkt op elke agenda, ook de eigen ResoFly-agenda;
  //   calendar    — Google Meet / Teams van de gekoppelde agenda (native: geen);
  //   google_meet — per geboekt blok een Google Meet, en teams een Teams-
  //   / teams       vergadering: van de agenda zelf als die dat kan, anders los
  //                 met de koppeling van de maker van de link (createEvent).
  const { data: srcRow } = await supabaseAdmin.from('calendar_sources').select('provider').eq('organization_id', link.organization_id).eq('id', link.source_id).maybeSingle();
  if (!srcRow) throw new HttpErr('Deze boekingslink is niet meer gekoppeld aan een agenda. Neem contact op met de afzender.', 409);
  const provider = String(srcRow.provider);
  const service: VideoService | null = isVideoService(link.conference_provider) ? link.conference_provider : null;
  const useJitsi = link.auto_conference && link.conference_provider === 'jitsi' && !link.meeting_url;
  const useService = link.auto_conference && service !== null && !link.meeting_url;
  const addConference = link.auto_conference && !useJitsi && !useService && provider !== 'native' && !link.meeting_url;
  const jitsiBase = useJitsi ? await loadJitsiBaseUrl(link.organization_id) : null;
  const ownerId = link.user_id;
  const sourceId = link.source_id;

  const confirmed: Array<{ slot_id: string; starts_at: string; ends_at: string; meeting_url: string | null }> = [];
  const failed: Array<{ slot_id: string; reason: string }> = [];
  // Wat er met de videovergadering misging; de eigenaar leest het in zijn melding.
  const videoNotes = new Set<string>();

  for (const slotId of slotIds) {
    let bookingId: string | null = null;
    let starts = '';
    let ends = '';
    try {
      // Fase A: atomisch reserveren (limieten, begintijd, maker en advisory
      // lock in de RPC). De fout zelf gooien, niet alleen zijn tekst: aan de
      // code ziet visitorReason() of het onze eigen zin voor de bezoeker is.
      const { data: reserved, error: reserveError } = await supabaseAdmin.rpc('reserve_meeting_slot_by_token', {
        p_token_hash: tokenHash, p_slot_id: slotId, p_name: name || null, p_email: email,
      });
      if (reserveError) throw reserveError;
      const row = (Array.isArray(reserved) ? reserved[0] : reserved) as { booking_id: string; starts_at: string; ends_at: string } | null;
      if (!row) throw new Error('Reserveren mislukt.');
      bookingId = row.booking_id; starts = row.starts_at; ends = row.ends_at;

      // Live-recheck: is er ondertussen handmatig een afspraak op deze bron gezet?
      await assertNoConflict(link.organization_id, ownerId, sourceId, starts, ends);

      // Fase B: agenda-item aanmaken bij de provider (klant als genodigde).
      const slotMeetingUrl = useJitsi ? jitsiMeetingUrl(jitsiBase) : link.meeting_url;
      const eventInput = {
        sourceId,
        title: name ? `${link.title} — ${name}` : link.title,
        description: link.invite_message,
        startsAt: starts,
        endsAt: ends,
        meetingUrl: slotMeetingUrl,
        addConference,
        ...(useService ? { videoService: service } : {}),
        attendees: [{ email, name: name || undefined }],
      };
      let ev: Record<string, unknown>;
      try {
        ev = await createEvent(link.organization_id, ownerId, eventInput) as Record<string, unknown>;
      } catch (err) {
        // Lukt alleen de videovergadering niet (de koppeling van de eigenaar
        // mist het recht, de Meet API staat uit, geen Teams op dit account),
        // dan gaat de boeking toch door: de klant heeft zijn moment, en de
        // eigenaar hoort dat hij zelf een link moet sturen.
        if (!(err instanceof VideoUnavailableError)) throw err;
        videoNotes.add(err.message);
        ev = await createEvent(link.organization_id, ownerId, { ...eventInput, meetingUrl: null, addConference: false, videoService: null }) as Record<string, unknown>;
      }
      if (typeof ev.video_warning === 'string' && ev.video_warning) videoNotes.add(ev.video_warning);

      const evProvider = String(ev.provider);
      const nativeEventId = evProvider === 'native' ? String(ev.native_event_id ?? '') : null;
      const externalEventId = evProvider !== 'native' ? String(ev.provider_event_id ?? '') : null;
      const externalProvider = evProvider !== 'native' ? evProvider : null;

      const { error: finalizeError } = await supabaseAdmin.rpc('finalize_meeting_booking', {
        p_booking_id: bookingId,
        p_native_event_id: nativeEventId || null,
        p_external_event_id: externalEventId || null,
        p_external_provider: externalProvider,
      });
      if (finalizeError) throw finalizeError;

      const evMeetingUrl = ev.meeting_url ? String(ev.meeting_url) : slotMeetingUrl;
      confirmed.push({ slot_id: slotId, starts_at: starts, ends_at: ends, meeting_url: evMeetingUrl });
    } catch (err) {
      if (bookingId) {
        try { await supabaseAdmin.rpc('release_meeting_booking', { p_booking_id: bookingId, p_reason: err instanceof Error ? err.message : 'error' }); } catch { /* best-effort */ }
        // Stond er intussen een afspraak op dat moment, dan is het blok echt
        // bezet. Eerst ging het na het vrijgeven weer open, en liep de volgende
        // bezoeker tegen dezelfde botsing aan.
        if (err instanceof HttpErr && err.status === 409) {
          await supabaseAdmin.from('meeting_booking_slots').update({ status: 'cancelled' })
            .eq('id', slotId).eq('organization_id', link.organization_id).eq('status', 'open');
        }
      }
      if (!(err instanceof HttpErr) && !dbErrorAnswer(err)) console.error('meeting-booking-public slot', slotId, err);
      failed.push({ slot_id: slotId, reason: visitorReason(err) });
    }
  }

  // Toon één deelnamelink als die eenduidig is: de vaste link, of bij precies één
  // geboekt blok de zojuist gegenereerde Meet/Teams/Jitsi-link. Bij meerdere
  // auto-links verschilt de link per afspraak en staat hij in de losse
  // agenda-uitnodigingen.
  const displayMeetingUrl = link.meeting_url || (confirmed.length === 1 ? confirmed[0].meeting_url : null);

  if (confirmed.length > 0) {
    const videoNote = videoNotes.size
      ? `${service ? serviceLabel(service) : 'De videovergadering'}: ${[...videoNotes].join(' ')} Stuur de klant zelf een videolink als dat nodig is.`
      : null;
    await sendConfirmationEmails(link, name, email, confirmed, displayMeetingUrl, videoNote).catch(err => console.error('confirmation mail failed', err));
  }

  return {
    confirmed,
    failed,
    meeting_url: displayMeetingUrl,
    invite_message: link.invite_message,
    title: link.title,
  };
}

/** Overlapt [starts, ends) met een bestaand item op deze agenda-bron? */
async function assertNoConflict(organizationId: string, userId: string, sourceId: string, starts: string, ends: string): Promise<void> {
  try {
    const events = await listEvents(organizationId, userId, starts, ends);
    const s = new Date(starts).getTime();
    const e = new Date(ends).getTime();
    const clash = events.find(ev => String(ev.source_id) === sourceId
      && new Date(String(ev.starts_at)).getTime() < e
      && new Date(String(ev.ends_at)).getTime() > s);
    if (clash) throw new HttpErr('Dit moment is net bezet geraakt. Kies een ander moment.', 409);
  } catch (err) {
    if (err instanceof HttpErr) throw err;
    // Kan de agenda niet lezen (bv. provider tijdelijk down): niet blokkeren op
    // de recheck; de reserve-RPC voorkomt al dubbele boekingen binnen het systeem.
    console.warn('conflict recheck skipped', err);
  }
}

function whenLine(starts: string, ends: string): string {
  const d = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(starts));
  const t = new Intl.DateTimeFormat('nl-NL', { timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(ends));
  return `${d} – ${t}`;
}

async function sendConfirmationEmails(link: LinkRow, name: string, email: string, confirmed: Array<{ starts_at: string; ends_at: string }>, meetingUrl: string | null, videoNote: string | null = null): Promise<void> {
  if (!RESEND_API_KEY) return;
  const sender = await resolveSenderIdentity(supabaseAdmin, link.organization_id, RESEND_FROM_EMAIL);
  if (!sender.from) return;
  // Naam, merkkleur en logo in één query (_shared/emailBrand.ts): de merknaam
  // of bedrijfsnaam, en pas daarna de naam van de werkruimte.
  const brand = await loadSenderBrand(supabaseAdmin, link.organization_id);
  const brandName = brand.name;
  const whenLines = confirmed.map(c => whenLine(c.starts_at, c.ends_at));
  const content = await loadBookingEmailContent(link.organization_id, 'meetingBooking.confirmed');

  // Bevestiging naar de klant.
  const rendered = renderMeetingBookingConfirmedEmail({
    brandName,
    accentColor: brand.accent,
    recipientName: name || null,
    title: link.title,
    whenLines,
    meetingUrl,
    inviteMessage: link.invite_message,
    content,
  });
  await sendResend(link.organization_id, sender.from, [email], sender.replyTo, rendered.subject, rendered.html, rendered.text, brand.email).catch(err => console.error('client confirm mail', err));

  // Notificatie naar de eigenaar van de link.
  const ownerEmail = link.user_id ? await ownerEmailFor(link.user_id) : null;
  if (ownerEmail) {
    const subject = `Nieuwe boeking: ${link.title}`;
    const lines = [`${name || email} heeft geboekt:`, ...whenLines.map(w => `- ${w}`), '', `E-mail: ${email}`, ...(videoNote ? ['', `Let op — ${videoNote}`] : [])].join('\n');
    const html = `<p>${escapeHtml(name || email)} heeft geboekt:</p><ul>${whenLines.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul><p>E-mail: ${escapeHtml(email)}</p>${videoNote ? `<p><strong>Let op</strong> — ${escapeHtml(videoNote)}</p>` : ''}`;
    await sendResend(link.organization_id, sender.from, [ownerEmail], undefined, subject, html, lines).catch(err => console.error('owner notify mail', err));
  }
}

/** De eigen Jitsi-server van de organisatie (Instellingen → Agenda); null = meet.jit.si. */
async function loadJitsiBaseUrl(organizationId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from('company_settings').select('jitsi_base_url').eq('organization_id', organizationId).maybeSingle();
  if (error || !data) return null;
  return (data.jitsi_base_url as string | null) ?? null;
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

async function ownerEmailFor(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  } catch { return null; }
}

/**
 * `brand`: naam en logo voor de plek bovenaan de klantmail. De melding aan de
 * eigenaar is een kaal intern bericht zonder die plek; daar hoeft het niet.
 */
async function sendResend(organizationId: string, from: string, to: string[], replyTo: string | undefined, subject: string, html: string, text: string, brand?: EmailBrand): Promise<void> {
  // Quotum per organisatie (20261101050000). De boeking staat al vast; is het
  // quotum op, dan blijft alleen deze mail achterwege (de aanroeper logt het).
  if (!(await emailQuotaAllows(supabaseAdmin, organizationId, to.length))) throw new Error('Mailquotum van de organisatie is op.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(withEmailBrand({ from, to, reply_to: replyTo, subject, html, text }, brand)),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

