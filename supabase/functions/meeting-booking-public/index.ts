// ============================================================
// ResoFly — Meeting Booking Tool: publieke (klant-facing) API
//
// Geen login. Toegang loopt via een onraadbaar token in de request-body, dat we
// gehasht vergelijken (zoals contract-public). Twee acties:
//  - getLink : link-info + beschikbare blokken tonen.
//  - bookSlots : blokken boeken via een twee-fasen-commit:
//      fase A = reserve_meeting_slot_by_token (DB, atomisch onder advisory lock)
//      fase B = agenda-item aanmaken bij de provider; bij succes finalize_*,
//               bij conflict/fout release_* (blok weer 'open').
//
// Ingebouwde Deno.serve (geen deno.land/std-import).
// ============================================================

import { supabaseAdmin } from '../_shared/calendarCore.ts';
import { listEvents } from '../_shared/calendarAvailability.ts';
import { createEvent } from '../_shared/calendarEventWrite.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import { renderMeetingBookingConfirmedEmail } from '../_shared/emailTemplates/meetingBookingConfirmed.ts';
import type { EmailTemplateContent } from '../_shared/emailTemplates/content.ts';

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
  status: 'active' | 'closed';
  public_token_hash: string | null;
  public_token_expires_at: string | null;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  try {
    if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const token = String(body.token || '').trim();
    if (!token || token.length < 16) return json({ ok: false, error: 'Boekingslink ontbreekt of is ongeldig.' }, 400);
    const tokenHash = await sha256Hex(token);

    switch (action) {
      case 'getLink': return json({ ok: true, ...(await getPublicLink(tokenHash)) });
      case 'bookSlots': return json({ ok: true, ...(await bookSlots(tokenHash, body)) });
      default: return json({ ok: false, error: `Onbekende actie: ${action}` }, 400);
    }
  } catch (error) {
    const status = error instanceof HttpErr ? error.status : 500;
    if (status >= 500) console.error('meeting-booking-public error', error);
    return json({ ok: false, error: error instanceof Error ? error.message : 'Onbekende fout.' }, status);
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const PENDING_GRACE_MS = 2 * 60 * 1000;

async function loadLinkByHash(tokenHash: string): Promise<LinkRow> {
  const { data, error } = await supabaseAdmin.from('meeting_booking_links').select('*').eq('public_token_hash', tokenHash).maybeSingle();
  if (error || !data) throw new HttpErr('Deze boekingslink is niet (meer) geldig.', 404);
  const link = data as LinkRow;
  if (link.status !== 'active') throw new HttpErr('Deze boekingslink is gesloten.', 410);
  if (!link.public_token_expires_at || new Date(link.public_token_expires_at).getTime() < Date.now()) {
    throw new HttpErr('Deze boekingslink is verlopen.', 410);
  }
  return link;
}

class HttpErr extends Error { status: number; constructor(m: string, s = 400) { super(m); this.status = s; } }

async function getPublicLink(tokenHash: string) {
  const link = await loadLinkByHash(tokenHash);

  const nowMinusGrace = new Date(Date.now() - PENDING_GRACE_MS).toISOString();
  // Beschikbaar = open, of pending maar vervallen (edge crash tussen fase A en B).
  const { data: slotRows } = await supabaseAdmin.from('meeting_booking_slots')
    .select('id,starts_at,ends_at,status,pending_at')
    .eq('booking_link_id', link.id)
    .in('status', ['open', 'pending'])
    .gte('ends_at', new Date().toISOString())
    .order('starts_at', { ascending: true });
  const available = (slotRows ?? []).filter((s: Record<string, unknown>) =>
    s.status === 'open' || (s.status === 'pending' && String(s.pending_at ?? '') < nowMinusGrace));

  // Bezette (pending/confirmed) boekingen → hun slot-starttijden, voor de
  // totaal-/weeklimiet-weergave op de pagina (server blijft leidend).
  const { data: takenRows } = await supabaseAdmin.from('meeting_bookings')
    .select('slot_id, meeting_booking_slots!inner(starts_at)')
    .eq('booking_link_id', link.id)
    .in('status', ['pending', 'confirmed']);
  const takenStarts = (takenRows ?? []).map((r: Record<string, unknown>) => {
    const s = r.meeting_booking_slots as { starts_at?: string } | { starts_at?: string }[] | null;
    const rec = Array.isArray(s) ? s[0] : s;
    return rec?.starts_at ?? null;
  }).filter(Boolean) as string[];

  let prefill: { name: string | null; email: string | null } | null = null;
  if (link.client_id) {
    const { data: client } = await supabaseAdmin.from('clients').select('name,contact_name,email').eq('id', link.client_id).maybeSingle();
    if (client) prefill = { name: (client.contact_name || client.name || null) as string | null, email: (client.email || null) as string | null };
  }

  return {
    link: {
      title: link.title,
      intro_text: link.intro_text,
      max_total_bookings: link.max_total_bookings,
      max_per_week: link.max_per_week,
    },
    slots: available.map((s: Record<string, unknown>) => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at })),
    taken_slot_starts: takenStarts,
    prefill,
  };
}

async function bookSlots(tokenHash: string, body: Record<string, unknown>) {
  const link = await loadLinkByHash(tokenHash);
  const name = String(body.name || '').trim().slice(0, 160);
  const email = String(body.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw new HttpErr('Vul een geldig e-mailadres in.', 422);
  const slotIds = Array.isArray(body.slotIds) ? body.slotIds.map(String).filter(Boolean) : [];
  if (slotIds.length === 0) throw new HttpErr('Kies minstens één tijdblok.', 422);
  if (slotIds.length > 20) throw new HttpErr('Te veel blokken in één keer.', 422);
  if (!link.source_id) throw new HttpErr('Deze boekingslink is niet meer gekoppeld aan een agenda. Neem contact op.', 409);
  if (!link.user_id) throw new HttpErr('Deze boekingslink is niet meer beschikbaar. Neem contact op.', 409);

  // Provider van de agenda bepalen: bij Google/Microsoft kan er automatisch een
  // videovergadering (Google Meet / Teams) worden aangemaakt. Een zelf geplakte
  // vaste videolink heeft voorrang; native heeft geen provider.
  const { data: srcRow } = await supabaseAdmin.from('calendar_sources').select('provider').eq('id', link.source_id).maybeSingle();
  const provider = srcRow ? String(srcRow.provider) : 'native';
  const addConference = link.auto_conference && provider !== 'native' && !link.meeting_url;

  const confirmed: Array<{ slot_id: string; starts_at: string; ends_at: string; meeting_url: string | null }> = [];
  const failed: Array<{ slot_id: string; reason: string }> = [];

  for (const slotId of slotIds) {
    let bookingId: string | null = null;
    let starts = '';
    let ends = '';
    try {
      // Fase A: atomisch reserveren (limieten + advisory lock in de RPC).
      const { data: reserved, error: reserveError } = await supabaseAdmin.rpc('reserve_meeting_slot_by_token', {
        p_token_hash: tokenHash, p_slot_id: slotId, p_name: name || null, p_email: email,
      });
      if (reserveError) throw new Error(reserveError.message);
      const row = (Array.isArray(reserved) ? reserved[0] : reserved) as { booking_id: string; starts_at: string; ends_at: string } | null;
      if (!row) throw new Error('Reserveren mislukt.');
      bookingId = row.booking_id; starts = row.starts_at; ends = row.ends_at;

      // Live-recheck: is er ondertussen handmatig een afspraak op deze bron gezet?
      await assertNoConflict(link.organization_id, link.user_id, link.source_id, starts, ends);

      // Fase B: agenda-item aanmaken bij de provider (klant als genodigde).
      const ev = await createEvent(link.organization_id, link.user_id, {
        sourceId: link.source_id,
        title: name ? `${link.title} — ${name}` : link.title,
        description: link.invite_message,
        startsAt: starts,
        endsAt: ends,
        meetingUrl: link.meeting_url,
        addConference,
        attendees: [{ email, name: name || undefined }],
      }) as Record<string, unknown>;

      const provider = String(ev.provider);
      const nativeEventId = provider === 'native' ? String(ev.native_event_id ?? '') : null;
      const externalEventId = provider !== 'native' ? String(ev.provider_event_id ?? '') : null;
      const externalProvider = provider !== 'native' ? provider : null;

      const { error: finalizeError } = await supabaseAdmin.rpc('finalize_meeting_booking', {
        p_booking_id: bookingId,
        p_native_event_id: nativeEventId || null,
        p_external_event_id: externalEventId || null,
        p_external_provider: externalProvider,
      });
      if (finalizeError) throw new Error(finalizeError.message);

      const evMeetingUrl = ev.meeting_url ? String(ev.meeting_url) : null;
      confirmed.push({ slot_id: slotId, starts_at: starts, ends_at: ends, meeting_url: evMeetingUrl });
    } catch (err) {
      if (bookingId) {
        try { await supabaseAdmin.rpc('release_meeting_booking', { p_booking_id: bookingId, p_reason: err instanceof Error ? err.message : 'error' }); } catch { /* best-effort */ }
      }
      failed.push({ slot_id: slotId, reason: err instanceof Error ? err.message : 'Dit moment is niet meer beschikbaar.' });
    }
  }

  // Toon één deelnamelink als die eenduidig is: de vaste link, of bij precies één
  // geboekt blok de zojuist gegenereerde Meet/Teams-link. Bij meerdere auto-links
  // verschilt de link per afspraak en staat hij in de losse agenda-uitnodigingen.
  const displayMeetingUrl = link.meeting_url || (confirmed.length === 1 ? confirmed[0].meeting_url : null);

  if (confirmed.length > 0) {
    await sendConfirmationEmails(link, name, email, confirmed, displayMeetingUrl).catch(err => console.error('confirmation mail failed', err));
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

async function sendConfirmationEmails(link: LinkRow, name: string, email: string, confirmed: Array<{ starts_at: string; ends_at: string }>, meetingUrl: string | null): Promise<void> {
  if (!RESEND_API_KEY) return;
  const sender = await resolveSenderIdentity(supabaseAdmin, link.organization_id, RESEND_FROM_EMAIL);
  if (!sender.from) return;
  const brandName = await orgBrandName(link.organization_id);
  const whenLines = confirmed.map(c => whenLine(c.starts_at, c.ends_at));
  const content = await loadBookingEmailContent(link.organization_id, 'meetingBooking.confirmed');

  // Bevestiging naar de klant.
  const rendered = renderMeetingBookingConfirmedEmail({
    brandName,
    recipientName: name || null,
    title: link.title,
    whenLines,
    meetingUrl,
    inviteMessage: link.invite_message,
    content,
  });
  await sendResend(sender.from, [email], sender.replyTo, rendered.subject, rendered.html, rendered.text).catch(err => console.error('client confirm mail', err));

  // Notificatie naar de eigenaar van de link.
  const ownerEmail = link.user_id ? await ownerEmailFor(link.user_id) : null;
  if (ownerEmail) {
    const subject = `Nieuwe boeking: ${link.title}`;
    const lines = [`${name || email} heeft geboekt:`, ...whenLines.map(w => `- ${w}`), '', `E-mail: ${email}`].join('\n');
    const html = `<p>${escapeHtml(name || email)} heeft geboekt:</p><ul>${whenLines.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul><p>E-mail: ${escapeHtml(email)}</p>`;
    await sendResend(sender.from, [ownerEmail], undefined, subject, html, lines).catch(err => console.error('owner notify mail', err));
  }
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

async function ownerEmailFor(userId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  } catch { return null; }
}

async function sendResend(from: string, to: string[], replyTo: string | undefined, subject: string, html: string, text: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, reply_to: replyTo, subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
