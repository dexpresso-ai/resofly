import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, isUuid,
  makeCors, parseAllowedOrigins, requireOrganizationAccess, requireUser,
} from '../_shared/edgeAuth.ts';
import { renderEmailTemplate } from '../_shared/emailTemplates/index.ts';
import type { EmailTemplateContent } from '../_shared/emailTemplates/types.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';

// ============================================================
// ResoFly — Bestanden delen (file-share)
//
// Deelt een drive-item (map, geüpload bestand, notitie of document) met:
//   'contact' — een geregistreerde contactpersoon van de klant → klantportaal
//   'member'  — een collega → melding met een link naar de app
//   'link'    — een los e-mailadres → geheime deellink /gedeeld/<token>
//
// Waarom een edge function en niet gewoon een insert vanuit de browser:
//  1. De deellink-token wordt hier gemunt. Alleen sha256(token) gaat de database
//     in; de platte token bestaat alleen in de verstuurde e-mail en in de URL die
//     de deler één keer te zien krijgt.
//  2. De meldingsmail loopt via Resend, met de RESEND_API_KEY die nooit in een
//     browser mag staan.
//
// De KERNREGEL — een klantgerelateerd bestand mag alleen naar een geregistreerde
// contactpersoon van diezelfde klant — staat NIET hier maar in de database
// (trigger drive_shares_guard). Deze functie draait op de service-role en zou die
// regel dus kunnen omzeilen als hij hem zelf moest bewaken. Wat hier gebeurt is
// alleen een vroege, vriendelijke controle zodat de gebruiker een nette melding
// krijgt in plaats van een databasefout.
// ============================================================

const admin = createAdminClient();

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';

const APP_PUBLIC_URL = (
  Deno.env.get('APP_PUBLIC_URL') ||
  Deno.env.get('CLIENT_PORTAL_BASE_URL') ||
  Deno.env.get('INVOICE_PUBLIC_BASE_URL') ||
  Deno.env.get('QUOTE_PUBLIC_BASE_URL') ||
  ''
).replace(/\/$/, '');

const cors = makeCors(
  parseAllowedOrigins([
    Deno.env.get('FILE_SHARE_ALLOWED_ORIGINS'),
    Deno.env.get('APP_ALLOWED_ORIGINS'),
    Deno.env.get('APP_PUBLIC_URL'),
    Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
    Deno.env.get('MAIL_ALLOWED_ORIGINS'),
  ]),
  (Deno.env.get('ALLOW_LOCAL_DEV') ?? '1') === '1',
);

const ITEM_TYPES = new Set(['folder', 'attachment', 'note', 'document']);
const ITEM_LABELS: Record<string, string> = {
  folder: 'Map',
  attachment: 'Bestand',
  note: 'Notitie',
  document: 'Document',
};
/** Maximaal aantal ontvangers per aanroep — houdt één deelactie behapbaar. */
const MAX_RECIPIENTS = 25;

type Recipient =
  | { kind: 'contact'; clientContactId: string }
  | { kind: 'member'; memberUserId: string }
  | { kind: 'link'; email: string; name?: string | null };

type ShareRow = {
  id: string;
  organization_id: string;
  item_type: string;
  item_id: string;
  item_name: string | null;
  client_id: string | null;
  recipient_kind: string;
  recipient_email: string | null;
  recipient_name: string | null;
  can_download: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  message: string | null;
  updated_at: string | null;
};

type SenderIdentity = Awaited<ReturnType<typeof resolveSenderIdentity>>;

type CompanyRow = {
  company_name?: string | null;
  trade_name?: string | null;
  invoice_accent_color?: string | null;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Alleen POST.', 400);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    if (!isUuid(organizationId)) throw new HttpError('organizationId is verplicht.', 400);

    const user = await requireUser(admin, req);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    assertWriteRole(role);
    await assertModuleAccess(admin, user.id, organizationId, 'content', 'write');

    switch (action) {
      case 'share':
        return cors.json(req, { ok: true, results: await shareItem(user, organizationId, body) });
      case 'resendNotice':
        return cors.json(req, { ok: true, result: await resendNotice(user, organizationId, body) });
      default:
        throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Onbekende fout';
    if (status >= 500) console.error('file-share error', message, err instanceof Error ? err.stack : undefined);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

// ── Acties ────────────────────────────────────────────────────────────

async function shareItem(
  user: { id: string; email?: string },
  organizationId: string,
  body: Record<string, unknown>,
) {
  const itemType = String(body.itemType || '');
  const itemId = String(body.itemId || '');
  if (!ITEM_TYPES.has(itemType)) throw new HttpError(`Onbekend itemtype: ${itemType}`, 400);
  if (!isUuid(itemId)) throw new HttpError('Ongeldig item.', 400);

  const recipients = parseRecipients(body.recipients);
  const canDownload = body.canDownload !== false;
  const notify = body.notify !== false;
  const message = trimOrNull(body.message, 2000);
  const expiresAt = parseExpiry(body.expiresAt);

  // De klantcontext komt van de database, niet van de browser. Dit is dezelfde
  // functie die de trigger straks gebruikt, dus wat hier "klantgerelateerd" heet
  // is precies wat de database ook zo noemt.
  const context = await resolveItemContext(organizationId, itemType, itemId);
  const itemName = trimOrNull(body.itemName, 300) || context.item_name || ITEM_LABELS[itemType];

  // Vroege, vriendelijke controle. Het echte slot zit in de database.
  if (context.client_id) {
    const offender = recipients.find((r) => r.kind === 'link');
    if (offender) {
      throw new HttpError(
        `Dit hoort bij klantdossier “${context.client_name ?? 'onbekend'}”. Klantgerelateerde bestanden mogen alleen worden gedeeld met de geregistreerde contactpersonen van die klant, niet via een deellink naar een los e-mailadres.`,
        403,
      );
    }
  } else if (recipients.some((r) => r.kind === 'contact')) {
    throw new HttpError('Dit item hoort niet bij een klantdossier, dus er is geen contactpersoon om mee te delen.', 400);
  }

  const company = await loadCompany(organizationId);
  const content = await loadShareEmailContent(organizationId);
  const senderName = await resolveSenderName(user, organizationId);
  // Eén keer oplossen voor de hele batch: de afzenderidentiteit hangt aan de
  // organisatie, niet aan de ontvanger.
  const sender = await resolveSenderIdentity(admin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);

  // Eén weigerende ontvanger mag de rest niet meesleuren. Delen met vier mensen
  // waarvan er één net op inactief is gezet, moet de andere drie gewoon
  // opleveren — met een nette melding bij die ene. Alles-of-niets zou hier
  // betekenen dat mensen wél een mail hebben gekregen terwijl het scherm zegt
  // dat het is mislukt.
  const results = [];
  for (const recipient of recipients) {
    try {
      results.push(await shareWithOne({
        user, organizationId, itemType, itemId, itemName, context,
        recipient, canDownload, expiresAt, message, notify, company, content, senderName, sender,
      }));
    } catch (error) {
      results.push({
        share: null,
        recipient,
        url: null,
        notified: false,
        error: error instanceof Error ? error.message : 'Delen met deze ontvanger is niet gelukt.',
        notifyError: null,
      });
    }
  }
  return results;
}

async function shareWithOne(input: {
  user: { id: string; email?: string };
  organizationId: string;
  itemType: string;
  itemId: string;
  itemName: string;
  context: ItemContext;
  recipient: Recipient;
  canDownload: boolean;
  expiresAt: string | null;
  message: string | null;
  notify: boolean;
  company: CompanyRow | null;
  content: EmailTemplateContent | null;
  senderName: string;
  sender: SenderIdentity;
}) {
  const { recipient } = input;

  // De platte token bestaat alleen hier en in de e-mail; de database krijgt de hash.
  const token = recipient.kind === 'link' ? randomToken() : null;
  const tokenHash = token ? await sha256Hex(token) : null;

  const values: Record<string, unknown> = {
    organization_id: input.organizationId,
    created_by: input.user.id,
    item_type: input.itemType,
    item_id: input.itemId,
    item_name: input.itemName,
    recipient_kind: recipient.kind,
    client_contact_id: recipient.kind === 'contact' ? recipient.clientContactId : null,
    member_user_id: recipient.kind === 'member' ? recipient.memberUserId : null,
    recipient_email: recipient.kind === 'link' ? recipient.email : null,
    recipient_name: recipient.kind === 'link' ? (recipient.name ?? null) : null,
    can_download: input.canDownload,
    expires_at: input.expiresAt,
    message: input.message,
    token_hash: tokenHash,
  };

  // Opnieuw delen met dezelfde persoon werkt als bijwerken: de bestaande lopende
  // deling wordt vernieuwd (nieuwe vervaldatum, nieuw bericht, nieuwe token) in
  // plaats van dat er een tweede rij ontstaat.
  const existing = await findActiveShare(input.organizationId, input.itemType, input.itemId, recipient);
  let share: ShareRow;
  if (existing) {
    const { data, error } = await admin
      .from('drive_shares')
      .update({ ...values, revoked_at: null, revoked_by: null, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('*')
      .single();
    if (error) throw shareError(error);
    share = data as ShareRow;
  } else {
    const { data, error } = await admin.from('drive_shares').insert(values).select('*').single();
    if (error) throw shareError(error);
    share = data as ShareRow;
  }

  const url = buildShareUrl(share, token);
  let notified = false;
  let notifyError: string | null = null;
  if (input.notify) {
    const outcome = await sendShareEmail({
      share, url, company: input.company, content: input.content, sender: input.sender,
      senderName: input.senderName, clientName: input.context.client_name,
      itemKindLabel: ITEM_LABELS[input.itemType] || 'Bestand',
      personalMessage: input.message,
    });
    notified = outcome.ok;
    notifyError = outcome.error;
    if (outcome.ok) {
      await admin.from('drive_shares').update({ notified_at: new Date().toISOString() }).eq('id', share.id);
    }
  }

  return { share, url: token ? url : null, notified, notifyError, error: null };
}

/** Verstuurt de melding voor een bestaande deling opnieuw. Een deellink krijgt daarbij een NIEUWE token: de oude is onherroepelijk kwijt zodra de eerste mail weg is. */
async function resendNotice(
  user: { id: string; email?: string },
  organizationId: string,
  body: Record<string, unknown>,
) {
  const shareId = String(body.shareId || '');
  if (!isUuid(shareId)) throw new HttpError('Ongeldige deling.', 400);

  const { data, error } = await admin
    .from('drive_shares')
    .select('*')
    .eq('id', shareId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError('Deze deling bestaat niet (meer).', 404);

  let share = data as ShareRow;
  if (share.revoked_at) throw new HttpError('Deze deling is ingetrokken. Deel opnieuw om weer toegang te geven.', 409);
  if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
    throw new HttpError('Deze deling is verlopen. Deel opnieuw met een nieuwe vervaldatum.', 409);
  }

  let token: string | null = null;
  if (share.recipient_kind === 'link') {
    token = randomToken();
    const { data: updated, error: updateError } = await admin
      .from('drive_shares')
      .update({ token_hash: await sha256Hex(token), updated_at: new Date().toISOString() })
      .eq('id', share.id)
      .select('*')
      .single();
    if (updateError) throw shareError(updateError);
    share = updated as ShareRow;
  }

  const context = await resolveItemContext(organizationId, share.item_type, share.item_id).catch(() => null);
  const url = buildShareUrl(share, token);
  const outcome = await sendShareEmail({
    share, url,
    company: await loadCompany(organizationId),
    content: await loadShareEmailContent(organizationId),
    sender: await resolveSenderIdentity(admin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO),
    senderName: await resolveSenderName(user, organizationId),
    clientName: context?.client_name ?? null,
    itemKindLabel: ITEM_LABELS[share.item_type] || 'Bestand',
    personalMessage: share.message,
  });
  if (outcome.ok) {
    await admin.from('drive_shares').update({ notified_at: new Date().toISOString() }).eq('id', share.id);
  }
  return { share, url: token ? url : null, notified: outcome.ok, notifyError: outcome.error, error: null };
}

// ── Helpers ───────────────────────────────────────────────────────────

type ItemContext = { client_id: string | null; project_id: string | null; item_name: string | null; client_name: string | null };

async function resolveItemContext(organizationId: string, itemType: string, itemId: string): Promise<ItemContext> {
  const { data, error } = await admin.rpc('drive_item_client', {
    p_organization_id: organizationId,
    p_item_type: itemType,
    p_item_id: itemId,
  });
  if (error) {
    // De RPC gebruikt dezelfde Nederlandse meldingen als de trigger; die zijn
    // bedoeld voor de gebruiker en gaan dus ongewijzigd terug.
    throw new HttpError(error.message || 'Dit item kan niet worden gedeeld.', 400);
  }
  const row = (Array.isArray(data) ? data[0] : data) as ItemContext | undefined;
  if (!row) throw new HttpError('Dit item bestaat niet (meer).', 404);
  return {
    client_id: row.client_id ?? null,
    project_id: row.project_id ?? null,
    item_name: row.item_name ?? null,
    client_name: row.client_name ?? null,
  };
}

async function findActiveShare(
  organizationId: string,
  itemType: string,
  itemId: string,
  recipient: Recipient,
): Promise<{ id: string } | null> {
  let query = admin
    .from('drive_shares')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('item_type', itemType)
    .eq('item_id', itemId)
    .is('revoked_at', null);

  if (recipient.kind === 'contact') query = query.eq('client_contact_id', recipient.clientContactId);
  else if (recipient.kind === 'member') query = query.eq('member_user_id', recipient.memberUserId);
  else query = query.eq('recipient_kind', 'link').eq('recipient_email', recipient.email);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null) ?? null;
}

/**
 * Waar de ontvanger het gedeelde item opent:
 *  - contactpersoon → het klantportaal (inloggen met de eigen e-maillink)
 *  - collega        → de app zelf
 *  - deellink       → de publieke pagina met de token in de URL
 */
function buildShareUrl(share: ShareRow, token: string | null): string {
  const base = APP_PUBLIC_URL;
  if (share.recipient_kind === 'link') {
    return token ? `${base}/gedeeld/${encodeURIComponent(token)}` : `${base}/gedeeld`;
  }
  if (share.recipient_kind === 'contact') return `${base}/portal`;
  return `${base}/`;
}

function parseRecipients(raw: unknown): Recipient[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError('Kies minstens één ontvanger.', 400);
  if (raw.length > MAX_RECIPIENTS) throw new HttpError(`Deel met maximaal ${MAX_RECIPIENTS} mensen tegelijk.`, 400);

  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = entry as Record<string, unknown>;
    const kind = String(item.kind || '');
    if (kind === 'contact') {
      const id = String(item.clientContactId || '');
      if (!isUuid(id)) throw new HttpError('Ongeldige contactpersoon.', 400);
      if (seen.has(`c:${id}`)) continue;
      seen.add(`c:${id}`);
      out.push({ kind: 'contact', clientContactId: id });
    } else if (kind === 'member') {
      const id = String(item.memberUserId || '');
      if (!isUuid(id)) throw new HttpError('Ongeldige collega.', 400);
      if (seen.has(`m:${id}`)) continue;
      seen.add(`m:${id}`);
      out.push({ kind: 'member', memberUserId: id });
    } else if (kind === 'link') {
      const email = String(item.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(`“${item.email}” is geen geldig e-mailadres.`, 400);
      if (seen.has(`l:${email}`)) continue;
      seen.add(`l:${email}`);
      out.push({ kind: 'link', email, name: trimOrNull(item.name, 200) });
    } else {
      throw new HttpError(`Onbekende ontvanger: ${kind}`, 400);
    }
  }
  if (out.length === 0) throw new HttpError('Kies minstens één ontvanger.', 400);
  return out;
}

function parseExpiry(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError('De vervaldatum is ongeldig.', 400);
  if (date.getTime() <= Date.now()) throw new HttpError('De vervaldatum ligt in het verleden.', 400);
  return date.toISOString();
}

function trimOrNull(raw: unknown, max: number): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (value.length > max) throw new HttpError(`Deze tekst mag maximaal ${max} tekens zijn.`, 400);
  return value;
}

/** Databasefouten uit de deel-trigger zijn geschreven als gebruikerstekst; die gaan ongewijzigd terug. */
function shareError(error: { message?: string; code?: string; details?: string }): HttpError {
  const message = `${error.message ?? ''} ${error.details ?? ''}`;
  if (/does not exist|schema cache|relation "drive_shares"/i.test(message)) {
    return new HttpError('De deelfunctie is nog niet geactiveerd. Voer de migratie 20260823000000_drive_shares.sql uit in Supabase.', 500);
  }
  if (error.code === '42501' || error.code === '23514' || error.code === '02000') {
    return new HttpError(error.message || 'Delen is niet toegestaan.', 403);
  }
  if (error.code === '23505') {
    return new HttpError('Dit item is al met deze persoon gedeeld.', 409);
  }
  return new HttpError(error.message || 'Delen is niet gelukt.', 400);
}

async function loadCompany(organizationId: string): Promise<CompanyRow | null> {
  const { data, error } = await admin
    .from('company_settings')
    .select('company_name,trade_name,invoice_accent_color')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    console.warn('file-share company_settings overgeslagen', error.message);
    return null;
  }
  return (data as CompanyRow | null) ?? null;
}

async function loadShareEmailContent(organizationId: string): Promise<EmailTemplateContent | null> {
  const { data, error } = await admin
    .from('email_templates')
    .select('enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId)
    .eq('template_key', 'file.shared')
    .maybeSingle();
  if (error || !data) {
    if (error) console.warn('file-share email_templates overgeslagen', error.message);
    return null;
  }
  const row = data as Record<string, unknown>;
  return {
    enabled: row.enabled as boolean | null,
    subject: row.subject as string | null,
    intro: row.intro as string | null,
    closing: row.closing as string | null,
    ctaLabel: row.cta_label as string | null,
  };
}

/** Wie deelt dit? De naam uit het teamlid-e-mailadres; anders het bedrijf. */
async function resolveSenderName(user: { id: string; email?: string }, organizationId: string): Promise<string> {
  if (user.email) return prettyNameFromEmail(user.email);
  const { data } = await admin
    .from('organization_members')
    .select('email')
    .eq('user_id', user.id)
    .eq('organization_id', organizationId)
    .maybeSingle();
  const email = (data as { email?: string } | null)?.email;
  return email ? prettyNameFromEmail(email) : 'Een collega';
}

function prettyNameFromEmail(email: string): string {
  const local = email.split('@')[0] || email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase('nl-NL') + part.slice(1))
    .join(' ') || email;
}

async function sendShareEmail(input: {
  share: ShareRow;
  url: string;
  company: CompanyRow | null;
  content: EmailTemplateContent | null;
  sender: SenderIdentity;
  senderName: string;
  clientName: string | null;
  itemKindLabel: string;
  personalMessage: string | null;
}): Promise<{ ok: boolean; error: string | null }> {
  const to = String(input.share.recipient_email || '').trim();
  if (!to) return { ok: false, error: 'Deze ontvanger heeft geen e-mailadres.' };
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return { ok: false, error: 'E-mail is nog niet ingesteld (RESEND_API_KEY/RESEND_FROM_EMAIL ontbreekt). De deling zelf staat wel klaar.' };
  }
  if (!APP_PUBLIC_URL) {
    return { ok: false, error: 'APP_PUBLIC_URL ontbreekt, dus er kon geen werkende link in de mail. De deling zelf staat wel klaar.' };
  }

  const accessHint = input.share.recipient_kind === 'contact'
    ? 'Log in op het klantportaal met dit e-mailadres; je krijgt dan een inloglink toegestuurd.'
    : input.share.recipient_kind === 'link'
      ? 'Deze link is persoonlijk. Deel hem niet door.'
      : null;

  const rendered = renderEmailTemplate('file.shared', {
    itemName: input.share.item_name || input.itemKindLabel,
    itemKindLabel: input.itemKindLabel,
    url: input.url,
    accessHint,
    recipientName: input.share.recipient_name,
    senderName: input.senderName,
    clientName: input.clientName,
    personalMessage: input.personalMessage,
    expiresAt: input.share.expires_at,
    company: input.company,
    content: input.content,
  });

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': sanitizeIdempotencyKey(`file-share-${input.share.id}-${input.share.updated_at ?? ''}`),
      },
      body: JSON.stringify({
        from: input.sender.from,
        to: [to],
        reply_to: input.sender.replyTo,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tags: [
          { name: 'organization_id', value: sanitizeTagValue(input.share.organization_id) },
          { name: 'template_key', value: 'file_shared' },
        ],
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error('file-share resend error', response.status, text.slice(0, 300));
      return { ok: false, error: `De melding kon niet worden verstuurd (${response.status}). De deling zelf staat wel klaar.` };
    }
    return { ok: true, error: null };
  } catch (error) {
    console.error('file-share mail error', error instanceof Error ? error.message : error);
    return { ok: false, error: 'De melding kon niet worden verstuurd. De deling zelf staat wel klaar.' };
  }
}

function sanitizeTagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'unknown';
}

function sanitizeIdempotencyKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
