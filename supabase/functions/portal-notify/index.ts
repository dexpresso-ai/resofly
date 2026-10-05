// ============================================================
// ResoFly — Klantportaal: e-mailmeldingen over tickets (portal-notify)
//
// pg_cron roept dit elke minuut aan: POST ?cron=drain met de header
// x-cron-secret = PORTAL_NOTIFY_CRON_SECRET. Geen Supabase-JWT (net als
// web-push en webhooks); zonder geldig secret doet hij niets.
//
// Wat hij doet:
//  1. Claimt de wachtende ticketactiviteit (claim_portal_ticket_activity):
//     nieuw ticket, statuswijziging, zichtbaar antwoord. Activiteit die vlak na
//     elkaar op één ticket gebeurde komt samen binnen.
//  2. Bepaalt per ticket wie een mail krijgt (_shared/portalNotify.ts): de
//     portaalgebruikers van de klant, volgens hun eigen keuzes in het portaal.
//  3. Controleert vlak voor het versturen opnieuw: staat de organisatie-
//     schakelaar nog aan, bestaat het antwoord nog en is het nog zichtbaar,
//     is het adres niet gebounced.
//  4. Verstuurt één mail per ontvanger per ticket, in de huisstijl van de
//     leverancier, met de eigen teksten van de organisatie als die er zijn
//     (email_templates, Instellingen → E-mail) en vanaf het verzenddomein van
//     de organisatie (resolveSenderIdentity).
//
// Mislukt een verzending, dan gaat de activiteit terug in de wachtrij; wie de
// mail al kreeg staat in notified_emails en krijgt hem niet nog eens. Na vijf
// pogingen geeft de claim het op. Activiteit die ouder is dan
// PORTAL_NOTIFY_MAX_AGE_HOURS (standaard 48) wordt niet meer gemaild: zet je de
// cron pas later aan, dan krijgen klanten geen stapel oude meldingen.
// ============================================================

import { createAdminClient, HttpError } from '../_shared/edgeAuth.ts';
import { BRANDING_COLUMNS, sanitizeBranding } from '../_shared/branding.ts';
import { renderEmailTemplate } from '../_shared/emailTemplates/index.ts';
import { PORTAL_TICKET_TEMPLATE_KEYS } from '../_shared/emailTemplates/portalTicketUpdate.ts';
import type { EmailTemplateContent, PortalTicketTemplateKey, PortalTicketUpdateEmailInput } from '../_shared/emailTemplates/types.ts';
import { sanitizeTagValue, sendViaResend } from '../_shared/resend.ts';
import { resolveSenderIdentity, type SenderIdentity } from '../_shared/sendingDomain.ts';
import {
  normalizeEmail,
  planTicketNotifications,
  portalPeople,
  portalSettingsUrl,
  portalStatusSentence,
  portalTicketStatusLabel,
  portalTicketUrl,
  type PlannedPortalMail,
  type PortalActivity,
  type PortalSettingsRow,
} from '../_shared/portalNotify.ts';

const admin = createAdminClient();

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const CRON_SECRET = Deno.env.get('PORTAL_NOTIFY_CRON_SECRET') || '';
const PORTAL_BASE_URL = (
  Deno.env.get('CLIENT_PORTAL_BASE_URL') ||
  Deno.env.get('APP_PUBLIC_URL') ||
  ''
).replace(/\/+$/, '');
const BATCH = envInt('PORTAL_NOTIFY_BATCH', 50, 1, 500);
// Een edge function heeft een maximale looptijd. Wat er na deze tijd nog ligt,
// gaat terug in de wachtrij voor de volgende minuut.
const TIME_BUDGET_MS = 90_000;
const MIN_AGE_SECONDS = envInt('PORTAL_NOTIFY_MIN_AGE_SECONDS', 30, 0, 600);
const MAX_AGE_HOURS = envInt('PORTAL_NOTIFY_MAX_AGE_HOURS', 48, 1, 24 * 14);
const SEND_PAUSE_MS = 550;

type ActivityRow = PortalActivity & { organization_id: string; attempts: number };

type TicketRow = {
  id: string;
  organization_id: string;
  client_id: string | null;
  title: string | null;
  status: string;
  created_by_contact_id: string | null;
  created_by_email: string | null;
  created_by_name: string | null;
};

type NoteRow = {
  id: string;
  body: string;
  author_type: string;
  author_name: string | null;
  is_internal: boolean;
  created_at: string;
};

type OrgContext = {
  enabled: boolean;
  companyName: string;
  accentColor: string;
  footerText: string | null;
  sender: SenderIdentity;
  replyTo: string | undefined;
  /** Eigen teksten per soort melding (Instellingen → E-mail); ontbreekt = standaardtekst. */
  texts: Partial<Record<PortalTicketTemplateKey, EmailTemplateContent>>;
};

Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    if (url.searchParams.get('cron') !== 'drain') {
      throw new HttpError('Deze functie draait alleen als cron: POST ?cron=drain met x-cron-secret.', 404);
    }
    if (req.method !== 'POST') return plainJson({ ok: false, error: 'Method not allowed.' }, 405);
    assertCronSecret(req);
    const result = await drain();
    return plainJson({ ok: true, ...result });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('portal-notify error', describe(error));
    return plainJson({ ok: false, error: error instanceof HttpError ? error.message : 'Meldingen versturen mislukt.' }, status);
  }
});

// ── Cron ─────────────────────────────────────────────────────────────────────

function assertCronSecret(req: Request): void {
  if (!CRON_SECRET) throw new HttpError('PORTAL_NOTIFY_CRON_SECRET ontbreekt in de Edge Function secrets.', 500);
  const provided = req.headers.get('x-cron-secret') || '';
  if (!timingSafeEqual(provided, CRON_SECRET)) throw new HttpError('Ongeldig of ontbrekend cron-secret.', 401);
}

async function drain(): Promise<Record<string, number>> {
  // Zonder mailconfiguratie claimen we niets: de activiteit blijft dan gewoon
  // wachten (en vervalt na MAX_AGE_HOURS), in plaats van vijf keer te mislukken.
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    throw new HttpError('RESEND_API_KEY of RESEND_FROM_EMAIL ontbreekt in de Edge Function secrets.', 500);
  }
  if (!PORTAL_BASE_URL) {
    throw new HttpError('APP_PUBLIC_URL (of CLIENT_PORTAL_BASE_URL) ontbreekt: zonder kan de mail niet naar het portaal linken.', 500);
  }

  const { data, error } = await admin.rpc('claim_portal_ticket_activity', {
    p_limit: BATCH,
    p_min_age_seconds: MIN_AGE_SECONDS,
  });
  if (error) throw new HttpError(`claim_portal_ticket_activity mislukt: ${error.message}`, 500);
  const rows = (data ?? []) as ActivityRow[];

  const byTicket = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    const list = byTicket.get(row.ticket_id) ?? [];
    list.push(row);
    byTicket.set(row.ticket_id, list);
  }

  const totals = { claimed: rows.length, tickets: byTicket.size, sent: 0, failed: 0, skipped: 0, deferred: 0 };
  const orgs = new Map<string, OrgContext>();
  const deadline = Date.now() + TIME_BUDGET_MS;
  for (const [ticketId, activity] of byTicket) {
    if (Date.now() > deadline) {
      // Niet geprobeerd, dus ook geen poging: de claim telde er al één bij.
      totals.deferred += activity.length;
      for (const row of activity) {
        await updateActivity([row.id], { notify_status: 'queued', attempts: Math.max(0, (row.attempts ?? 1) - 1) })
          .catch((markError) => console.error('portal-notify defer error', describe(markError)));
      }
      continue;
    }
    try {
      const outcome = await processTicket(ticketId, activity, orgs);
      totals.sent += outcome.sent;
      totals.failed += outcome.failed;
      totals.skipped += outcome.skipped;
    } catch (err) {
      // Eén ticket met een databasehik mag de rest niet tegenhouden. Terug in
      // de wachtrij; de claim telt de pogingen.
      totals.failed += activity.length;
      console.error('portal-notify ticket error', ticketId, describe(err));
      await updateActivity(activity.map((row) => row.id), { notify_status: 'queued', last_error: clip(describe(err)) })
        .catch((markError) => console.error('portal-notify requeue error', describe(markError)));
    }
  }
  return totals;
}

async function processTicket(
  ticketId: string,
  activity: ActivityRow[],
  orgs: Map<string, OrgContext>,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const now = Date.now();
  const maxAgeMs = MAX_AGE_HOURS * 3_600_000;
  const stale = activity.filter((row) => now - Date.parse(row.created_at) > maxAgeMs);
  const fresh = activity.filter((row) => !stale.includes(row));
  if (stale.length) {
    await skip(stale.map((row) => row.id), `Ouder dan ${MAX_AGE_HOURS} uur bij het versturen; niet meer gemaild.`);
  }
  if (!fresh.length) return { sent: 0, failed: 0, skipped: stale.length };

  const organizationId = fresh[0].organization_id;
  const org = await loadOrgContext(organizationId, orgs);
  if (!org.enabled) {
    await skip(fresh.map((row) => row.id), 'Klantmeldingen staan uit voor deze organisatie.');
    return { sent: 0, failed: 0, skipped: activity.length };
  }

  const ticket = await single<TicketRow>(admin
    .from('tickets')
    .select('id,organization_id,client_id,title,status,created_by_contact_id,created_by_email,created_by_name')
    .eq('id', ticketId)
    .eq('organization_id', organizationId)
    .maybeSingle());
  if (!ticket || !ticket.client_id) {
    await skip(fresh.map((row) => row.id), ticket ? 'Het ticket hangt niet (meer) aan een klant.' : 'Het ticket bestaat niet meer.');
    return { sent: 0, failed: 0, skipped: activity.length };
  }

  const client = await single<{ id: string; name: string | null; contact_name: string | null; email: string | null }>(admin
    .from('clients')
    .select('id,name,contact_name,email')
    .eq('id', ticket.client_id)
    .eq('organization_id', organizationId)
    .maybeSingle());
  if (!client) {
    await skip(fresh.map((row) => row.id), 'De klant bestaat niet meer.');
    return { sent: 0, failed: 0, skipped: activity.length };
  }

  const noteIds = [...new Set(fresh.map((row) => row.note_id).filter((id): id is string => Boolean(id)))];
  const [contacts, settings, notes] = await Promise.all([
    rowsOf<{ id: string; name: string | null; email: string | null }>(admin
      .from('client_contacts')
      .select('id,name,email')
      .eq('client_id', client.id)
      .eq('organization_id', organizationId)
      .eq('gives_portal_access', true)
      .eq('is_active', true)),
    rowsOf<PortalSettingsRow>(admin
      .from('portal_contact_settings')
      .select('email,notify_ticket_created,notify_ticket_status,notify_ticket_reply,notify_scope')
      .eq('client_id', client.id)),
    noteIds.length
      ? rowsOf<NoteRow>(admin
        .from('ticket_notes')
        .select('id,body,author_type,author_name,is_internal,created_at')
        .eq('organization_id', organizationId)
        .eq('ticket_id', ticket.id)
        .in('id', noteIds))
      : Promise.resolve([] as NoteRow[]),
  ]);

  const people = portalPeople(client, contacts);
  const suppressed = await loadSuppressed(organizationId, people.map((person) => person.email));
  const notesById = new Map(notes.map((note) => [note.id, note]));
  const visibleNoteIds = new Set(notes.filter((note) => !note.is_internal).map((note) => note.id));

  const plan = planTicketNotifications({
    ticket,
    activity: fresh,
    people,
    settings,
    visibleNoteIds,
    suppressed,
  });

  for (const item of plan.skipped) await skip([item.id], item.reason);

  // Wie elke gebeurtenis al kreeg. Meteen na elke verzending vastgelegd, niet
  // pas aan het eind: gaat er daarna iets mis (of valt de functie om), dan
  // weet de volgende poging nog steeds wie niet nog een mail moet krijgen.
  const notified = new Map(fresh.map((row) => [row.id, new Set(row.notified_emails ?? [])]));
  const failedIds = new Set<string>();
  let lastError: string | null = null;
  let sent = 0;
  let failed = 0;

  for (const mail of plan.mails) {
    const input = emailInput(mail, ticket, client, org, notesById);
    const rendered = renderEmailTemplate('portal.ticketUpdate', input);
    try {
      await paceSend();
      await sendViaResend(
        RESEND_API_KEY,
        {
          from: org.sender.from,
          to: [mail.person.email],
          reply_to: org.replyTo,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          tags: [
            { name: 'organization_id', value: sanitizeTagValue(organizationId) },
            { name: 'template_key', value: 'portal_ticket_update' },
          ],
        },
        // Zelfde mail aan dezelfde persoon = zelfde sleutel: een herhaalde
        // poging binnen 24 uur levert bij Resend geen tweede mail op.
        `portal-ticket-${await sha256Hex(`${mail.person.email}|${[...mail.activityIds].sort().join(',')}`)}`,
      );
      sent += 1;
      for (const id of mail.activityIds) notified.get(id)?.add(mail.person.email);
      await recordNotified(mail.activityIds, notified)
        .catch((recordError) => console.error('portal-notify notified_emails niet vastgelegd', ticketId, describe(recordError)));
    } catch (err) {
      failed += 1;
      lastError = clip(describe(err));
      for (const id of mail.activityIds) failedIds.add(id);
      console.error('portal-notify send error', ticketId, describe(err));
    }
  }

  // Afronden: per gebeurtenis wie hem nu (ook) kreeg; mislukt = opnieuw.
  const skippedIds = new Set(plan.skipped.map((item) => item.id));
  for (const row of fresh) {
    if (skippedIds.has(row.id)) continue;
    const emails = [...(notified.get(row.id) ?? [])];
    if (failedIds.has(row.id)) {
      await updateActivity([row.id], { notify_status: 'queued', notified_emails: emails, last_error: lastError });
    } else {
      await updateActivity([row.id], {
        notify_status: 'done',
        notified_emails: emails,
        last_error: null,
        processed_at: new Date().toISOString(),
      });
    }
  }

  return { sent, failed, skipped: stale.length + plan.skipped.length };
}

/** Van plan naar de invoer van de mailtemplate. */
function emailInput(
  mail: PlannedPortalMail,
  ticket: TicketRow,
  client: { id: string; name: string | null },
  org: OrgContext,
  notesById: Map<string, NoteRow>,
): PortalTicketUpdateEmailInput {
  const replies = mail.replies
    .map((reply) => (reply.note_id ? notesById.get(reply.note_id) : undefined))
    .filter((note): note is NoteRow => Boolean(note))
    .map((note) => {
      const fromTeam = note.author_type !== 'client';
      return {
        // Het team ondertekent met de bedrijfsnaam, zoals in het portaal: als
        // naam van een teamlid staat het e-mailadres in de notitie, en dat
        // hoort niet in de mail aan de klant.
        authorName: fromTeam ? org.companyName : (String(note.author_name ?? '').trim().slice(0, 80) || 'Je collega'),
        fromTeam,
        body: note.body,
        at: note.created_at,
      };
    });

  const createdBy = mail.created && mail.created.actor_type === 'client'
    ? (String(ticket.created_by_name ?? '').trim().slice(0, 80) || 'Een collega')
    : null;

  return {
    companyName: org.companyName,
    accentColor: org.accentColor,
    footerText: org.footerText,
    recipientName: mail.person.name && mail.person.name !== mail.person.email ? mail.person.name : null,
    ticket: { title: String(ticket.title ?? '').trim() || 'Ticket', statusLabel: portalTicketStatusLabel(ticket.status) },
    ownTicket: mail.ownTicket,
    confirmation: mail.confirmation,
    newTicket: Boolean(mail.created),
    createdBy,
    status: mail.status
      ? {
        fromLabel: mail.status.from ? portalTicketStatusLabel(mail.status.from) : null,
        toLabel: portalTicketStatusLabel(mail.status.to),
        sentence: portalStatusSentence(mail.status.to),
      }
      : null,
    replies,
    ticketUrl: portalTicketUrl(PORTAL_BASE_URL, client.id, ticket.id),
    settingsUrl: portalSettingsUrl(PORTAL_BASE_URL, client.id),
    clientName: String(client.name ?? '').trim() || null,
    content: org.texts,
  };
}

// ── Organisatie: schakelaar, huisstijl en afzender ──────────────────────────

async function loadOrgContext(organizationId: string, cache: Map<string, OrgContext>): Promise<OrgContext> {
  const cached = cache.get(organizationId);
  if (cached) return cached;

  // Kunnen we de schakelaar niet lezen, dan mailen we niet: liever een melding
  // te laat dan een klant mailen van een organisatie die het juist uitzette.
  const setting = await single<{ ticket_emails_enabled: boolean }>(admin
    .from('organization_portal_settings')
    .select('ticket_emails_enabled')
    .eq('organization_id', organizationId)
    .maybeSingle());

  const company = await loadCompany(organizationId);
  const branding = sanitizeBranding(company);
  let companyName = branding.companyName || '';
  if (!companyName) {
    const organization = await single<{ name: string | null }>(admin
      .from('organizations').select('name').eq('id', organizationId).maybeSingle());
    companyName = String(organization?.name ?? '').trim() || 'Je leverancier';
  }

  const sender = await resolveSenderIdentity(admin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  const texts = await loadTicketEmailTexts(organizationId);
  const context: OrgContext = {
    enabled: setting?.ticket_emails_enabled !== false,
    companyName,
    accentColor: branding.accentColor,
    footerText: branding.footerText ? String(branding.footerText).slice(0, 300) : null,
    sender,
    // Antwoordt de klant toch op de mail, dan komt dat bij het bedrijf uit.
    replyTo: normalizeEmail(company?.email) || sender.replyTo,
    texts,
  };
  cache.set(organizationId, context);
  return context;
}

/**
 * De eigen teksten van de organisatie voor deze meldingen (email_templates).
 * Een fout hier is niet fataal: dan gaat de melding met de standaardtekst.
 */
async function loadTicketEmailTexts(organizationId: string): Promise<Partial<Record<PortalTicketTemplateKey, EmailTemplateContent>>> {
  const { data, error } = await admin
    .from('email_templates')
    .select('template_key,enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId)
    .in('template_key', PORTAL_TICKET_TEMPLATE_KEYS);
  if (error) {
    console.warn('portal-notify email_templates overgeslagen', error.message);
    return {};
  }
  const texts: Partial<Record<PortalTicketTemplateKey, EmailTemplateContent>> = {};
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const key = String(row.template_key) as PortalTicketTemplateKey;
    if (!PORTAL_TICKET_TEMPLATE_KEYS.includes(key)) continue;
    texts[key] = {
      enabled: row.enabled as boolean | null,
      subject: row.subject as string | null,
      intro: row.intro as string | null,
      closing: row.closing as string | null,
      ctaLabel: row.cta_label as string | null,
    };
  }
  return texts;
}

async function loadCompany(organizationId: string): Promise<Record<string, unknown> | null> {
  const query = (columns: string) => admin
    .from('company_settings')
    .select(columns)
    .eq('organization_id', organizationId)
    .maybeSingle();
  let { data, error } = await query(`email,${BRANDING_COLUMNS}`);
  if (error) {
    // Een huisstijlkolom die nog niet bestaat mag de melding niet tegenhouden.
    console.warn('portal-notify company_settings zonder huisstijl', error.message);
    ({ data, error } = await query('email,company_name,trade_name'));
  }
  if (error) {
    console.warn('portal-notify company_settings overgeslagen', error.message);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

async function loadSuppressed(organizationId: string, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  // Alleen onbestelbaar of een spamklacht: een afmelding voor marketing is geen
  // afmelding voor een antwoord op je eigen ticket.
  const rows = await rowsOf<{ email: string }>(admin
    .from('email_suppressions')
    .select('email')
    .eq('organization_id', organizationId)
    .in('reason', ['bounced', 'complained'])
    .in('email', emails));
  return new Set(rows.map((row) => normalizeEmail(row.email)).filter((email): email is string => Boolean(email)));
}

// ── Database-helpers ─────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function single<T>(query: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<T | null> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as T | null) ?? null;
}

// deno-lint-ignore no-explicit-any
async function rowsOf<T>(query: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

async function updateActivity(ids: string[], patch: Record<string, unknown>): Promise<void> {
  if (!ids.length) return;
  const { error } = await admin.from('portal_ticket_activity').update(patch).in('id', ids);
  if (error) throw new Error(error.message);
}

/** Legt per gebeurtenis vast wie hem tot nu toe kreeg (status blijft 'sending'). */
async function recordNotified(ids: string[], notified: Map<string, Set<string>>): Promise<void> {
  for (const id of ids) {
    const emails = notified.get(id);
    if (emails) await updateActivity([id], { notified_emails: [...emails] });
  }
}

function skip(ids: string[], reason: string): Promise<void> {
  return updateActivity(ids, { notify_status: 'skipped', last_error: reason, processed_at: new Date().toISOString() });
}

// ── Kleine helpers ───────────────────────────────────────────────────────────

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = (Deno.env.get(name) ?? '').trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Resend staat standaard maar een paar verzoeken per seconde toe, voor alle functies samen. */
let lastSendAt = 0;
async function paceSend(): Promise<void> {
  const wait = lastSendAt + SEND_PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastSendAt = Date.now();
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let result = 0;
  for (let i = 0; i < ea.length; i += 1) result |= ea[i] ^ eb[i];
  return result === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function clip(value: string): string {
  return value.slice(0, 500);
}

function plainJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
