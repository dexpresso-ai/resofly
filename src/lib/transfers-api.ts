// ============================================================
// Bestanden versturen — de frontend-client.
//
// Schrijven gaat altijd via de edge function `file-transfer` (die kopieert in de
// opslag, mailt en houdt het logboek bij); lezen gaat rechtstreeks via RLS. Nieuwe
// bestanden gaan van de browser naar de media-worker (/transfer/upload, of in
// delen via /transfer/multipart/* boven 64 MB) — de worker schrijft de rij.
// ============================================================

import { supabase } from './supabase';
import { throwFunctionError } from './functionErrors';
import { isMissingRelation, NotMigratedError } from './postgrestErrors';
import { getAccessToken, getWorkerBase } from './r2-api';
import { downloadStoredFile } from './r2';
import { TRANSFER_MULTIPART_THRESHOLD_BYTES } from './transfers';
import type {
  FileTransfer, FileTransferBundle, FileTransferEvent, FileTransferItem, FileTransferRecipient, UUID,
} from '../types';

export type TransferSource = { type: 'attachment' | 'note' | 'document' | 'folder'; id: UUID };

export type TransferSkip = { name: string; reason: string };

export type TransferRecipientResult = {
  recipientId: UUID | null;
  email: string | null;
  name: string | null;
  kind: 'client' | 'contact' | 'email';
  notified: boolean;
  error: string | null;
};

type BundleResponse = {
  transfer: FileTransfer | null;
  items: FileTransferItem[];
  recipients: FileTransferRecipient[];
  skipped?: TransferSkip[];
  results?: TransferRecipientResult[];
};

async function call(action: string, organizationId: UUID, payload: Record<string, unknown>, fallback: string): Promise<BundleResponse & Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('file-transfer', {
    body: { action, organizationId, ...payload },
  });
  if (error) await throwFunctionError(error, fallback);
  if (!data?.ok) throw new Error(data?.error || fallback);
  return data as BundleResponse & Record<string, unknown>;
}

function toBundle(response: BundleResponse): FileTransferBundle {
  if (!response.transfer) throw new Error('De zending bestaat niet (meer).');
  return { transfer: response.transfer, items: response.items ?? [], recipients: response.recipients ?? [] };
}

// ── Concept ──────────────────────────────────────────────────────────────────

export async function prepareTransfer(organizationId: UUID, input: {
  clientId?: UUID | null;
  origin?: 'content' | 'client' | 'message' | 'ticket' | 'gerrie';
  sources?: TransferSource[];
  subject?: string;
  ticketId?: UUID | null;
  threadId?: UUID | null;
  expiresAt?: number | string | null;
}): Promise<{ bundle: FileTransferBundle; skipped: TransferSkip[] }> {
  const response = await call('prepare', organizationId, input, 'De zending kon niet worden aangemaakt.');
  return { bundle: toBundle(response), skipped: response.skipped ?? [] };
}

export async function addTransferSources(organizationId: UUID, transferId: UUID, sources: TransferSource[]) {
  const response = await call('addSources', organizationId, { transferId, sources }, 'Toevoegen is niet gelukt.');
  return { bundle: toBundle(response), skipped: response.skipped ?? [] };
}

export async function removeTransferItem(organizationId: UUID, transferId: UUID, itemId: UUID): Promise<FileTransferBundle> {
  return toBundle(await call('removeItem', organizationId, { transferId, itemId }, 'Weghalen is niet gelukt.'));
}

export async function updateTransferDraft(organizationId: UUID, transferId: UUID, patch: {
  subject?: string; message?: string | null; expiresAt?: number | string | null; canDownload?: boolean;
}): Promise<FileTransferBundle> {
  return toBundle(await call('updateDraft', organizationId, { transferId, ...patch }, 'Opslaan is niet gelukt.'));
}

export async function discardTransfer(organizationId: UUID, transferId: UUID): Promise<void> {
  await call('discard', organizationId, { transferId }, 'Weggooien is niet gelukt.');
}

// ── Versturen ────────────────────────────────────────────────────────────────

export async function sendTransfer(organizationId: UUID, input: {
  transferId: UUID;
  subject: string;
  message: string | null;
  expiresAt: number | string | null;
  canDownload: boolean;
  recipients: Array<Record<string, unknown>>;
  threadId?: UUID | null;
}): Promise<{ bundle: FileTransferBundle; results: TransferRecipientResult[] }> {
  const response = await call('send', organizationId, input, 'Versturen is niet gelukt.');
  return { bundle: toBundle(response), results: response.results ?? [] };
}

export async function addTransferRecipients(organizationId: UUID, transferId: UUID, recipients: Array<Record<string, unknown>>) {
  const response = await call('addRecipients', organizationId, { transferId, recipients }, 'Toevoegen is niet gelukt.');
  return { bundle: toBundle(response), results: response.results ?? [] };
}

export async function resendTransfer(organizationId: UUID, transferId: UUID, recipientId: UUID) {
  const response = await call('resend', organizationId, { transferId, recipientId }, 'Opnieuw sturen is niet gelukt.');
  return { bundle: toBundle(response), results: response.results ?? [] };
}

// ── Na versturen ─────────────────────────────────────────────────────────────

export async function revokeTransfer(organizationId: UUID, transferId: UUID): Promise<FileTransferBundle> {
  return toBundle(await call('revoke', organizationId, { transferId }, 'Intrekken is niet gelukt.'));
}

export async function extendTransfer(organizationId: UUID, transferId: UUID, expiresAt: number | string): Promise<FileTransferBundle> {
  return toBundle(await call('extend', organizationId, { transferId, expiresAt }, 'Verlengen is niet gelukt.'));
}

export async function revokeTransferRecipient(organizationId: UUID, transferId: UUID, recipientId: UUID): Promise<FileTransferBundle> {
  return toBundle(await call('revokeRecipient', organizationId, { transferId, recipientId }, 'Intrekken is niet gelukt.'));
}

export async function deleteTransfer(organizationId: UUID, transferId: UUID): Promise<void> {
  await call('delete', organizationId, { transferId }, 'Verwijderen is niet gelukt.');
}

/** Het concept als bijlage bij een zichtbaar antwoord op een ticket. */
export async function attachTransferToTicket(organizationId: UUID, input: {
  transferId: UUID; body: string; expiresAt: number | string | null; canDownload: boolean;
}): Promise<{ bundle: FileTransferBundle; noteId: UUID }> {
  const response = await call('attachToTicket', organizationId, input, 'Het antwoord met bestanden kon niet worden geplaatst.');
  return { bundle: toBundle(response), noteId: String(response.noteId ?? '') };
}

// ── Lezen (RLS) ──────────────────────────────────────────────────────────────

const ITEM_SELECT = 'id,organization_id,transfer_id,source_type,source_id,name,mime_type,size_bytes,sha256,storage_key,path,position,purged_at,created_at';
const RECIPIENT_SELECT = 'id,organization_id,transfer_id,kind,client_contact_id,email,name,client_email_id,notified_at,notify_error,delivery_status,first_opened_at,last_opened_at,open_count,first_downloaded_at,last_downloaded_at,download_count,revoked_at,code_blocked_at,created_at';
const MIGRATION_HINT = 'Bestanden versturen is in deze omgeving nog niet beschikbaar (migratie 20261013100000).';

async function bundlesFor(transfers: FileTransfer[]): Promise<FileTransferBundle[]> {
  if (transfers.length === 0) return [];
  const ids = transfers.map((t) => t.id);
  const [items, recipients] = await Promise.all([
    supabase.from('file_transfer_items').select(ITEM_SELECT).in('transfer_id', ids).order('position').order('created_at'),
    supabase.from('file_transfer_recipients').select(RECIPIENT_SELECT).in('transfer_id', ids).order('created_at'),
  ]);
  if (items.error) throw items.error;
  if (recipients.error) throw recipients.error;
  const itemsBy = new Map<string, FileTransferItem[]>();
  for (const item of (items.data ?? []) as FileTransferItem[]) itemsBy.set(item.transfer_id, [...(itemsBy.get(item.transfer_id) ?? []), item]);
  const recipientsBy = new Map<string, FileTransferRecipient[]>();
  for (const r of (recipients.data ?? []) as FileTransferRecipient[]) recipientsBy.set(r.transfer_id, [...(recipientsBy.get(r.transfer_id) ?? []), r]);
  return transfers.map((transfer) => ({ transfer, items: itemsBy.get(transfer.id) ?? [], recipients: recipientsBy.get(transfer.id) ?? [] }));
}

/** De zendingen van deze organisatie (of van één klant), nieuwste eerst. Concepten van collega's niet. */
export async function loadTransfers(organizationId: UUID, opts: { clientId?: UUID | null; limit?: number; userId?: UUID | null } = {}): Promise<FileTransferBundle[]> {
  let query = supabase.from('file_transfers').select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 200, 500));
  if (opts.clientId) query = query.eq('client_id', opts.clientId);
  const { data, error } = await query;
  if (error) {
    if (isMissingRelation(error)) throw new NotMigratedError(MIGRATION_HINT);
    throw error;
  }
  const transfers = ((data ?? []) as FileTransfer[])
    // Een concept is van wie het begon; in de lijst alleen je eigen concepten.
    .filter((t) => t.status !== 'draft' || (opts.userId ? t.created_by === opts.userId : false));
  return bundlesFor(transfers);
}

export async function loadTransferBundle(organizationId: UUID, transferId: UUID): Promise<FileTransferBundle | null> {
  const { data, error } = await supabase.from('file_transfers').select('*').eq('organization_id', organizationId).eq('id', transferId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [bundle] = await bundlesFor([data as FileTransfer]);
  return bundle ?? null;
}

export async function loadTransferEvents(organizationId: UUID, transferId: UUID): Promise<FileTransferEvent[]> {
  const { data, error } = await supabase.from('file_transfer_events').select('*')
    .eq('organization_id', organizationId).eq('transfer_id', transferId)
    .order('created_at', { ascending: false }).limit(300);
  if (error) throw error;
  return (data ?? []) as FileTransferEvent[];
}

/** Welke berichten (client_emails) een zending bij zich hebben, met die zending. */
export async function loadTransfersForEmails(organizationId: UUID, clientEmailIds: UUID[]): Promise<Map<UUID, { bundle: FileTransferBundle; recipient: FileTransferRecipient }>> {
  const map = new Map<UUID, { bundle: FileTransferBundle; recipient: FileTransferRecipient }>();
  const ids = [...new Set(clientEmailIds)].filter(Boolean);
  if (ids.length === 0) return map;
  const { data, error } = await supabase.from('file_transfer_recipients').select(RECIPIENT_SELECT)
    .eq('organization_id', organizationId).in('client_email_id', ids.slice(0, 300));
  if (error) {
    if (isMissingRelation(error)) return map;
    throw error;
  }
  const recipients = (data ?? []) as FileTransferRecipient[];
  if (recipients.length === 0) return map;
  const { data: transfers, error: transferError } = await supabase.from('file_transfers').select('*')
    .eq('organization_id', organizationId).in('id', [...new Set(recipients.map((r) => r.transfer_id))]);
  if (transferError) throw transferError;
  const bundles = await bundlesFor((transfers ?? []) as FileTransfer[]);
  for (const recipient of recipients) {
    const bundle = bundles.find((b) => b.transfer.id === recipient.transfer_id);
    if (bundle && recipient.client_email_id) map.set(recipient.client_email_id, { bundle, recipient });
  }
  return map;
}

/** De zendingen die als bijlage bij een ticketantwoord hangen, per antwoord. */
export async function loadTransfersForTicket(organizationId: UUID, ticketId: UUID): Promise<Map<UUID, FileTransferBundle>> {
  const map = new Map<UUID, FileTransferBundle>();
  const { data, error } = await supabase.from('file_transfers').select('*')
    .eq('organization_id', organizationId).eq('ticket_id', ticketId).not('ticket_note_id', 'is', null);
  if (error) {
    if (isMissingRelation(error)) return map;
    throw error;
  }
  for (const bundle of await bundlesFor((data ?? []) as FileTransfer[])) {
    if (bundle.transfer.ticket_note_id) map.set(bundle.transfer.ticket_note_id, bundle);
  }
  return map;
}

/** De bevroren tekst van een notitie of document in een zending (voor het team). */
export async function loadTransferItemText(organizationId: UUID, itemId: UUID): Promise<string> {
  const { data, error } = await supabase.from('file_transfer_items').select('html_snapshot')
    .eq('organization_id', organizationId).eq('id', itemId).maybeSingle();
  if (error) throw error;
  return String((data as { html_snapshot?: string | null } | null)?.html_snapshot ?? '');
}

/** Een bestand uit een zending downloaden als teamlid (gewone, ingelogde route van de worker). */
export async function downloadTransferItem(item: Pick<FileTransferItem, 'storage_key' | 'name'>): Promise<void> {
  if (!item.storage_key) throw new Error('Dit item is een tekst; lees het in het venster.');
  await downloadStoredFile(item.storage_key, item.name);
}

// ── Uploaden ─────────────────────────────────────────────────────────────────

async function errText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const json = JSON.parse(text) as { error?: string };
    if (json?.error) return json.error;
  } catch { /* geen JSON */ }
  return text || `Fout ${response.status}`;
}

async function workerJson<T>(path: string, json: unknown): Promise<T> {
  const response = await fetch(`${getWorkerBase()}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await getAccessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(json),
  });
  if (!response.ok) throw new Error(await errText(response));
  return (await response.json()) as T;
}

/**
 * Uploadt één bestand in een concept-zending. Tot 64 MB in één keer, daarboven
 * in delen van 64 MB met een paar pogingen per deel. De worker schrijft de
 * bestandsrij zelf en geeft die terug.
 */
export async function uploadTransferFile(
  file: File,
  organizationId: UUID,
  transferId: UUID,
  onProgress?: (uploaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<FileTransferItem> {
  const base = getWorkerBase();
  if (file.size <= TRANSFER_MULTIPART_THRESHOLD_BYTES) {
    const response = await fetch(`${base}/transfer/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await getAccessToken()}`,
        'x-organization-id': organizationId,
        'x-transfer-id': transferId,
        'x-file-name': encodeURIComponent(file.name),
        'x-file-type': file.type || 'application/octet-stream',
      },
      body: file,
      signal,
    });
    if (!response.ok) throw new Error(await errText(response));
    const result = (await response.json()) as { item: FileTransferItem };
    onProgress?.(file.size, file.size);
    return result.item;
  }

  const created = await workerJson<{ key: string; uploadId: string; partSize: number }>('/transfer/multipart/create', {
    organizationId, transferId, fileName: file.name, contentType: file.type || 'application/octet-stream', fileSize: file.size,
  });
  const partSize = created.partSize > 0 ? created.partSize : TRANSFER_MULTIPART_THRESHOLD_BYTES;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let uploaded = 0;
  try {
    for (let offset = 0, partNumber = 1; offset < file.size; offset += partSize, partNumber += 1) {
      if (signal?.aborted) throw new DOMException('Afgebroken', 'AbortError');
      const chunk = file.slice(offset, Math.min(offset + partSize, file.size));
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const response = await fetch(`${base}/transfer/multipart/part`, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${await getAccessToken()}`,
              'x-organization-id': organizationId,
              'x-transfer-id': transferId,
              'x-key': encodeURIComponent(created.key),
              'x-upload-id': encodeURIComponent(created.uploadId),
              'x-part-number': String(partNumber),
            },
            body: chunk,
            signal,
          });
          if (!response.ok) throw new Error(await errText(response));
          const result = (await response.json()) as { partNumber: number; etag: string };
          parts.push({ partNumber: result.partNumber, etag: result.etag });
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if ((e as { name?: string })?.name === 'AbortError') throw e;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
      if (lastError) throw lastError;
      uploaded += chunk.size;
      onProgress?.(uploaded, file.size);
    }
    const done = await workerJson<{ item: FileTransferItem }>('/transfer/multipart/complete', {
      organizationId, transferId, key: created.key, uploadId: created.uploadId, parts,
    });
    return done.item;
  } catch (e) {
    await workerJson('/transfer/multipart/abort', { organizationId, transferId, key: created.key, uploadId: created.uploadId }).catch(() => undefined);
    throw e;
  }
}
