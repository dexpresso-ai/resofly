// ============================================================
// Bestanden versturen — de serverkant die meerdere edge functions delen
// (file-transfer, file-transfer-public, client-portal, mail).
//
// Wat hier staat raakt de database (service-role), de media-worker (intern
// geheim) of Resend. De pure regels staan in fileTransfer.ts; die zijn los te
// testen.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { renderEmailTemplate } from './emailTemplates/index.ts';
import type { EmailTemplateContent } from './emailTemplates/types.ts';
import { escapeHtml } from './emailTemplates/layout.ts';
import type { SenderIdentity } from './sendingDomain.ts';
import {
  TRANSFER_DOWNLOAD_TTL_SECONDS,
  fileCountSentence,
  randomToken,
  sha256Hex,
} from './fileTransfer.ts';

// ── Rijen ────────────────────────────────────────────────────────────────────

export type TransferRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  client_id: string | null;
  project_id: string | null;
  subject: string;
  message: string | null;
  can_download: boolean;
  expires_at: string;
  status: 'draft' | 'sent' | 'revoked' | 'expired';
  origin: string;
  ticket_id: string | null;
  ticket_note_id: string | null;
  client_email_thread_id: string | null;
  sender_name: string | null;
  item_count: number;
  total_bytes: number;
  sent_at: string | null;
  revoked_at: string | null;
  purged_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TransferItemRow = {
  id: string;
  organization_id: string;
  transfer_id: string;
  source_type: 'attachment' | 'note' | 'document' | 'upload';
  source_id: string | null;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string | null;
  storage_key: string | null;
  html_snapshot?: string | null;
  path: string;
  position: number;
  purged_at: string | null;
  created_at: string;
};

export type TransferRecipientRow = {
  id: string;
  organization_id: string;
  transfer_id: string;
  kind: 'client' | 'contact' | 'email';
  client_contact_id: string | null;
  email: string;
  name: string | null;
  token_hash: string | null;
  client_email_id: string | null;
  notified_at: string | null;
  notify_error: string | null;
  delivery_status: string | null;
  first_opened_at: string | null;
  last_opened_at: string | null;
  open_count: number;
  first_downloaded_at: string | null;
  last_downloaded_at: string | null;
  download_count: number;
  revoked_at: string | null;
  created_at: string;
};

/** De kolommen die naar de browser van een teamlid mogen (geen html_snapshot, geen hashes). */
export const ITEM_COLUMNS = 'id,organization_id,transfer_id,source_type,source_id,name,mime_type,size_bytes,sha256,storage_key,path,position,purged_at,created_at';
export const RECIPIENT_COLUMNS = 'id,organization_id,transfer_id,kind,client_contact_id,email,name,client_email_id,notified_at,notify_error,delivery_status,first_opened_at,last_opened_at,open_count,first_downloaded_at,last_downloaded_at,download_count,revoked_at,code_blocked_at,created_at';

// ── Omgeving ─────────────────────────────────────────────────────────────────

export function appPublicUrl(): string {
  return (
    Deno.env.get('APP_PUBLIC_URL') ||
    Deno.env.get('CLIENT_PORTAL_BASE_URL') ||
    Deno.env.get('INVOICE_PUBLIC_BASE_URL') ||
    Deno.env.get('QUOTE_PUBLIC_BASE_URL') ||
    ''
  ).replace(/\/$/, '');
}

export function transferLinkUrl(token: string): string {
  return `${appPublicUrl()}/ontvang/${encodeURIComponent(token)}`;
}

function mediaWorker(): { url: string; secret: string } {
  const url = (
    Deno.env.get('MEDIA_WORKER_URL') ||
    Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') ||
    Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') ||
    ''
  ).replace(/\/$/, '');
  const secret =
    Deno.env.get('INTERNAL_UPLOAD_SECRET') ||
    Deno.env.get('INVOICE_PDF_STORAGE_SECRET') ||
    Deno.env.get('QUOTE_PDF_STORAGE_SECRET') ||
    '';
  return { url, secret };
}

export class TransferStorageError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

async function workerJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { url, secret } = mediaWorker();
  if (!url || !secret) throw new TransferStorageError('De bestandsopslag is niet gekoppeld (MEDIA_WORKER_URL / INTERNAL_UPLOAD_SECRET).', 503);
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* geen JSON */ }
  if (!response.ok) {
    const message = typeof json.error === 'string' && json.error ? json.error : `De bestandsopslag gaf een fout (${response.status}).`;
    throw new TransferStorageError(message, response.status === 413 ? 413 : response.status === 404 ? 404 : 502);
  }
  return json as T;
}

/** Kopieert een bestand uit Inhoud naar de zending (een eigen kopie, met SHA-256). */
export function copyIntoTransfer(input: { organizationId: string; transferId: string; sourceKey: string; fileName: string }) {
  return workerJson<{ ok: true; key: string; size: number; sha256: string | null; contentType: string }>('/internal/transfer/copy', input);
}

/** Kortlevende downloadlinks (en eventueel een zip-link) bij de media-worker. */
export async function signedDownloadUrls(input: {
  organizationId: string;
  files: Array<{ key: string; fileName: string }>;
  zip?: { transferId: string; fileName: string } | null;
  /**
   * Hoort de link bij een zending, geef die (en de ontvanger) mee: de worker
   * kijkt dan bij elke download of de zending nog loopt en de ontvanger niet is
   * ingetrokken, ook als het token zelf nog geldig is.
   */
  transfer?: { id: string; recipientId: string | null } | null;
  ttlSeconds?: number;
}): Promise<{ files: Array<{ key: string; url: string }>; zipUrl: string | null }> {
  const result = await workerJson<{ files?: Array<{ key: string; url: string }>; zipUrl?: string | null }>('/internal/signed-urls', {
    organizationId: input.organizationId,
    files: input.files,
    zip: input.zip ?? null,
    transfer: input.transfer ?? null,
    ttlSeconds: input.ttlSeconds ?? TRANSFER_DOWNLOAD_TTL_SECONDS,
  });
  return { files: Array.isArray(result.files) ? result.files : [], zipUrl: result.zipUrl ?? null };
}

/** Haalt een object uit R2. Al weg telt als gelukt. */
export async function deleteStorageObject(organizationId: string, key: string): Promise<void> {
  const { url, secret } = mediaWorker();
  if (!url || !secret) throw new TransferStorageError('De bestandsopslag is niet gekoppeld.', 503);
  if (!key.startsWith(`${organizationId}/`) || key.includes('..')) throw new TransferStorageError('Deze sleutel hoort niet bij de organisatie.', 403);
  const response = await fetch(`${url}/internal/media/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${secret}`, 'x-organization-id': organizationId },
  });
  // Alleen 2xx telt: de worker meldt een ontbrekend object zelf als gelukt, dus
  // een 404 betekent "route niet gevonden" (een sleutel die hij weigert) — en dan
  // is er niets verwijderd.
  if (!response.ok) {
    throw new TransferStorageError(`Verwijderen uit de opslag mislukte (${response.status}).`);
  }
}

/**
 * Uit welke delen van de opslag een bestand via versturen of delen naar buiten
 * mag: Inhoud en de dossiers. Nooit financiële stukken, galerijen, opnames of
 * chat — ook niet als een rij in Inhoud er (vervalst) naar wijst.
 */
export const OUTBOUND_KEY_SEGMENTS = new Set(['folder', 'client', 'project', 'task', 'subtask', 'ticket', 'note', 'document']);

/**
 * Hoort dit opslagobject bij precies dít ene item (één bijlage of één
 * document)? De sleutel van een bijlage of document schrijft een teamlid zelf;
 * de database toetst alleen het organisatieprefix. Wijst een tweede rij naar
 * hetzelfde object — bijvoorbeeld een bestand uit klantdossier X, "geleend" door
 * een rij in een map zonder klant — dan zou de klantregel op de verkeerde rij
 * worden getoetst. Dan dus niet naar buiten.
 */
export async function storageKeyBelongsOnlyTo(
  admin: SupabaseClient,
  organizationId: string,
  key: string,
  owner: { table: 'attachments' | 'documents'; id: string },
): Promise<boolean> {
  if (!key.startsWith(`${organizationId}/`) || key.includes('..')) return false;
  if (!OUTBOUND_KEY_SEGMENTS.has(key.split('/')[1] ?? '')) return false;
  const [attachments, documents] = await Promise.all([
    admin.from('attachments').select('id').eq('organization_id', organizationId).eq('storage_key', key).limit(2),
    admin.from('documents').select('id').eq('organization_id', organizationId).eq('storage_key', key).limit(2),
  ]);
  if (attachments.error) throw attachments.error;
  if (documents.error) throw documents.error;
  const rows = [
    ...((attachments.data ?? []) as Array<{ id: string }>).map((row) => ({ table: 'attachments', id: row.id })),
    ...((documents.data ?? []) as Array<{ id: string }>).map((row) => ({ table: 'documents', id: row.id })),
  ];
  return rows.length === 1 && rows[0].table === owner.table && rows[0].id === owner.id;
}

// ── Logboek ──────────────────────────────────────────────────────────────────

/** Eén regel in het logboek (+ de tellers op de ontvanger). Mag een actie nooit laten mislukken. */
export async function recordTransferEvent(
  admin: SupabaseClient,
  input: { transferId: string; recipientId?: string | null; kind: string; itemId?: string | null; detail?: string | null; actorUserId?: string | null },
): Promise<void> {
  try {
    const { error } = await admin.rpc('file_transfer_record', {
      p_transfer_id: input.transferId,
      p_recipient_id: input.recipientId ?? null,
      p_kind: input.kind,
      p_item_id: input.itemId ?? null,
      p_detail: input.detail ?? null,
      p_actor_user_id: input.actorUserId ?? null,
    });
    if (error) console.warn('file_transfer_record overgeslagen', error.message);
  } catch (error) {
    console.warn('file_transfer_record crashte', error instanceof Error ? error.message : error);
  }
}

// ── Links ────────────────────────────────────────────────────────────────────

/**
 * Een nieuwe persoonlijke link voor een ontvanger. Alleen de hash gaat de
 * database in; de platte token bestaat alleen in de mail. Een eerdere link van
 * dezelfde ontvanger werkt daarna niet meer.
 */
export async function issueRecipientLink(admin: SupabaseClient, recipientId: string): Promise<{ token: string; url: string }> {
  const token = randomToken();
  const { error } = await admin
    .from('file_transfer_recipients')
    .update({ token_hash: await sha256Hex(token), code_blocked_at: null })
    .eq('id', recipientId)
    .is('revoked_at', null);
  if (error) throw error;
  // Wie met de oude link al binnen was, moet opnieuw een code vragen. En een
  // nieuwe link begint met een schone lei: de tellers van foute codes horen bij
  // de oude link (de afzender verstuurt bewust opnieuw).
  await admin.from('file_transfer_sessions').delete().eq('recipient_id', recipientId);
  await admin.from('file_transfer_codes').delete().eq('recipient_id', recipientId);
  return { token, url: transferLinkUrl(token) };
}

// ── Afzender en huisstijl ────────────────────────────────────────────────────

export type CompanyForMail = {
  company_name?: string | null;
  trade_name?: string | null;
  invoice_accent_color?: string | null;
};

export async function loadCompanyForMail(admin: SupabaseClient, organizationId: string): Promise<CompanyForMail | null> {
  const { data, error } = await admin
    .from('company_settings')
    .select('company_name,trade_name,invoice_accent_color')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    console.warn('company_settings overgeslagen', error.message);
    return null;
  }
  return (data as CompanyForMail | null) ?? null;
}

export async function loadTransferEmailContent(admin: SupabaseClient, organizationId: string): Promise<EmailTemplateContent | null> {
  const { data, error } = await admin
    .from('email_templates')
    .select('enabled,subject,intro,closing,cta_label')
    .eq('organization_id', organizationId)
    .eq('template_key', 'file.transfer')
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    enabled: row.enabled as boolean | null,
    subject: row.subject as string | null,
    intro: row.intro as string | null,
    closing: row.closing as string | null,
    ctaLabel: row.cta_label as string | null,
  };
}

export function companyName(company: CompanyForMail | null): string {
  return company?.trade_name || company?.company_name || 'ResoFly';
}

export function prettyNameFromEmail(email: string): string {
  const local = email.split('@')[0] || email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase('nl-NL') + part.slice(1))
    .join(' ') || email;
}

export function extractDisplayName(value: string | null | undefined): string | null {
  const match = String(value ?? '').match(/^\s*"?([^"<]*?)"?\s*</);
  const name = match ? match[1].trim() : '';
  return name || null;
}

export function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1] : value).trim();
}

/** Wie het verstuurt: de naam van de persoonlijke afzender, anders afgeleid van het e-mailadres. */
export function senderNameFor(sender: SenderIdentity, user: { email?: string | null }, company: CompanyForMail | null): string {
  return extractDisplayName(sender.from) || (user.email ? prettyNameFromEmail(user.email) : companyName(company));
}

// ── Resend ───────────────────────────────────────────────────────────────────

export type ResendResult = { ok: true; id: string } | { ok: false; status: number; error: string };

export async function sendViaResend(payload: Record<string, unknown>, idempotencyKey: string): Promise<ResendResult> {
  const apiKey = Deno.env.get('RESEND_API_KEY') || '';
  if (!apiKey) return { ok: false, status: 503, error: 'E-mail is nog niet ingesteld (RESEND_API_KEY ontbreekt).' };
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200),
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      console.error('resend error', response.status, text.slice(0, 300));
      return { ok: false, status: response.status, error: `De mail kon niet worden verstuurd (${response.status}).` };
    }
    let id = '';
    try { id = String((JSON.parse(text) as { id?: string }).id || ''); } catch { /* geen JSON */ }
    return { ok: true, id };
  } catch (error) {
    console.error('resend crash', error instanceof Error ? error.message : error);
    return { ok: false, status: 502, error: 'De mail kon niet worden verstuurd.' };
  }
}

export function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) || 'unknown';
}

// ── De melding versturen ─────────────────────────────────────────────────────

export type NoticeOutcome = { notified: boolean; error: string | null; clientEmailId: string | null; threadId: string | null };

/**
 * Stuurt één ontvanger de melding "er staan bestanden voor je klaar", met een
 * verse persoonlijke link. Hoort de zending bij een klant, dan komt de mail ook
 * in het klantgesprek (client_emails): zo staat hij op Berichten, in het
 * klantdossier en — voor wie op het portaal kan — in het portaal, en komt een
 * antwoord van de klant in hetzelfde gesprek terug.
 *
 * Gooit niet: wat misgaat staat in `error`, de zending zelf blijft staan.
 */
export async function sendTransferNotice(admin: SupabaseClient, input: {
  transfer: TransferRow;
  recipient: TransferRecipientRow;
  userId: string | null;
  sender: SenderIdentity;
  senderName: string;
  company: CompanyForMail | null;
  content: EmailTemplateContent | null;
  clientName: string | null;
  /** Het gesprek waarin de mail komt; null = een nieuw gesprek (eenmalig per zending). */
  threadId: string | null;
  portalUser: boolean;
}): Promise<NoticeOutcome> {
  const { transfer, recipient } = input;
  if (!input.sender.from) {
    return { notified: false, error: 'Er is nog geen afzenderadres ingesteld (RESEND_FROM_EMAIL of een verzenddomein).', clientEmailId: null, threadId: input.threadId };
  }
  if (!appPublicUrl()) {
    return { notified: false, error: 'APP_PUBLIC_URL ontbreekt, dus er kan geen werkende link in de mail.', clientEmailId: null, threadId: input.threadId };
  }

  let link: { token: string; url: string };
  try {
    link = await issueRecipientLink(admin, recipient.id);
  } catch (error) {
    return { notified: false, error: error instanceof Error ? error.message : 'De link kon niet worden aangemaakt.', clientEmailId: null, threadId: input.threadId };
  }

  const rendered = renderEmailTemplate('file.transfer', {
    subject: transfer.subject,
    url: link.url,
    recipientName: recipient.name,
    senderName: input.senderName,
    clientName: input.clientName,
    personalMessage: transfer.message,
    fileCount: transfer.item_count,
    totalBytes: transfer.total_bytes,
    expiresAt: transfer.expires_at,
    portalUser: input.portalUser,
    company: input.company,
    content: input.content,
  });

  // ── Klantgesprek (alleen bij een zending voor een klant) ──────────────────
  let threadId = input.threadId;
  let clientEmailId: string | null = null;
  const fromEmail = input.sender.fromEmail || extractEmailAddress(input.sender.from);
  const fromName = extractDisplayName(input.sender.from);
  const bodyText = transfer.message || `${input.senderName} heeft je ${fileCountSentence(transfer.item_count)} gestuurd.`;
  if (transfer.client_id) {
    try {
      if (!threadId) {
        const { data: thread, error: threadError } = await admin
          .from('client_email_threads')
          .insert({
            organization_id: transfer.organization_id,
            client_id: transfer.client_id,
            created_by: input.userId,
            subject: rendered.subject.slice(0, 300),
            last_direction: 'outbound',
            last_message_at: new Date().toISOString(),
          })
          .select('id')
          .single();
        if (threadError) throw threadError;
        threadId = String(thread.id);
      }
      const { data: row, error: rowError } = await admin
        .from('client_emails')
        .insert({
          organization_id: transfer.organization_id,
          thread_id: threadId,
          client_id: transfer.client_id,
          created_by: input.userId,
          direction: 'outbound',
          provider: 'resend',
          from_email: fromEmail,
          from_name: fromName,
          to_email: recipient.email,
          subject: rendered.subject.slice(0, 300),
          body_html: escapeHtml(bodyText).replace(/\r?\n/g, '<br/>'),
          body_text: bodyText,
          status: 'queued',
          metadata: { source: 'file_transfer', transfer_id: transfer.id, transfer_recipient_id: recipient.id },
        })
        .select('id')
        .single();
      if (rowError) throw rowError;
      clientEmailId = String(row.id);
    } catch (error) {
      // Het klantgesprek is een extra; de bestanden moeten er wél komen.
      console.warn('file-transfer klantgesprek overgeslagen', error instanceof Error ? error.message : error);
    }
  }

  const inboundDomain = (Deno.env.get('MAIL_INBOUND_DOMAIN') || '').trim().toLowerCase();
  const replyTo = clientEmailId && inboundDomain
    ? `reply+${clientEmailId}@${inboundDomain}`
    : (input.sender.replyTo || fromEmail || undefined);

  const sent = await sendViaResend({
    from: input.sender.from,
    to: [recipient.email],
    reply_to: replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tags: [
      { name: 'organization_id', value: tagValue(transfer.organization_id) },
      { name: 'template_key', value: 'file_transfer' },
      { name: 'transfer_id', value: tagValue(transfer.id) },
      { name: 'transfer_recipient_id', value: tagValue(recipient.id) },
      ...(clientEmailId ? [{ name: 'client_email_id', value: tagValue(clientEmailId) }] : []),
    ],
  }, `file-transfer-${recipient.id}-${link.token.slice(0, 12)}`);

  const now = new Date().toISOString();
  if (!sent.ok) {
    if (clientEmailId) {
      await admin.from('client_emails')
        .update({ status: 'failed', failed_at: now, last_event_at: now, error_message: sent.error })
        .eq('id', clientEmailId);
    }
    await admin.from('file_transfer_recipients')
      .update({ notify_error: sent.error, client_email_id: clientEmailId })
      .eq('id', recipient.id);
    return { notified: false, error: sent.error, clientEmailId, threadId };
  }

  if (clientEmailId) {
    await admin.from('client_emails')
      .update({ status: 'sent', sent_at: now, last_event_at: now, provider_email_id: sent.id || null })
      .eq('id', clientEmailId);
    if (threadId) {
      await admin.from('client_email_threads')
        .update({ last_message_at: now, last_direction: 'outbound' })
        .eq('id', threadId);
    }
  }
  await admin.from('file_transfer_recipients')
    .update({ notified_at: now, notify_error: null, delivery_status: 'sent', delivery_updated_at: now, client_email_id: clientEmailId })
    .eq('id', recipient.id);

  return { notified: true, error: null, clientEmailId, threadId };
}

// ── Toegang ──────────────────────────────────────────────────────────────────

export type ResolvedLink = {
  transferId: string;
  recipientId: string;
  organizationId: string;
  clientId: string | null;
  state: 'active' | 'revoked' | 'expired' | 'invalid';
};

/** Een persoonlijke link oplossen (op hash). Null = bestaat niet. */
export async function resolveTransferLink(admin: SupabaseClient, tokenHash: string): Promise<ResolvedLink | null> {
  const { data, error } = await admin.rpc('file_transfer_resolve', { p_token_hash: tokenHash });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row || !row.transfer_id) return null;
  return {
    transferId: String(row.transfer_id),
    recipientId: String(row.recipient_id),
    organizationId: String(row.organization_id),
    clientId: row.client_id ? String(row.client_id) : null,
    state: (['active', 'revoked', 'expired', 'invalid'].includes(String(row.state)) ? String(row.state) : 'invalid') as ResolvedLink['state'],
  };
}

/** De bestanden zoals een ontvanger ze ziet: geen sleutels, geen hashes. */
export function itemForRecipient(item: TransferItemRow, canDownload: boolean) {
  const readable = !item.storage_key;
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mime_type,
    sizeBytes: item.size_bytes,
    path: item.path || null,
    kind: readable ? 'text' as const : 'file' as const,
    downloadable: canDownload && Boolean(item.storage_key) && !item.purged_at,
    readable: readable && !item.purged_at,
  };
}

export async function loadTransferItems(admin: SupabaseClient, transferId: string, withSnapshot = false): Promise<TransferItemRow[]> {
  const { data, error } = await admin
    .from('file_transfer_items')
    .select(withSnapshot ? `${ITEM_COLUMNS},html_snapshot` : ITEM_COLUMNS)
    .eq('transfer_id', transferId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []) as unknown as TransferItemRow[];
}

export async function loadTransfer(admin: SupabaseClient, transferId: string, organizationId?: string): Promise<TransferRow | null> {
  let query = admin.from('file_transfers').select('*').eq('id', transferId);
  if (organizationId) query = query.eq('organization_id', organizationId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as TransferRow | null) ?? null;
}

/** Is de zending (nog) te openen? Verstuurd, niet verlopen, niet opgeruimd. */
export function transferIsOpen(transfer: Pick<TransferRow, 'status' | 'expires_at' | 'purged_at'>, now = Date.now()): boolean {
  return transfer.status === 'sent' && !transfer.purged_at && Date.parse(transfer.expires_at) > now;
}
