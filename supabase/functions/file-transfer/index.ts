import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  HttpError, assertModuleAccess, assertWriteRole, createAdminClient, isUuid,
  makeCors, parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus,
} from '../_shared/edgeAuth.ts';
import { resolveSenderIdentity, type SenderIdentity } from '../_shared/sendingDomain.ts';
import { approvedRecipientChanged } from '../_shared/approvedRecipient.ts';
import {
  TRANSFER_MAX_FILE_BYTES,
  TRANSFER_MAX_ITEMS,
  TRANSFER_MAX_SNAPSHOT_BYTES,
  blockedExtension,
  blockedExtensionMessage,
  cleanFileName,
  parseTransferExpiry,
  parseTransferRecipients,
  type TransferRecipientInput,
} from '../_shared/fileTransfer.ts';
import {
  storageKeyBelongsOnlyTo,
  RECIPIENT_COLUMNS,
  TransferStorageError,
  companyName,
  copyIntoTransfer,
  deleteStorageObject,
  loadCompanyForMail,
  loadTransfer,
  loadTransferEmailContent,
  loadTransferItems,
  prettyNameFromEmail,
  recordTransferEvent,
  sendTransferNotice,
  senderNameFor,
  type CompanyForMail,
  type TransferRecipientRow,
  type TransferRow,
} from '../_shared/fileTransferServer.ts';

// ============================================================
// ResoFly — Bestanden versturen (file-transfer)
//
// Ingelogde acties rond een zending, plus de opruimtaak (?cron=purge).
//
//  prepare        — nieuw concept, eventueel meteen met bestanden uit Inhoud
//  addSources     — bestanden, notities, documenten of mappen uit Inhoud erbij
//  removeItem     — een bestand uit het concept halen
//  updateDraft    — onderwerp, bericht, termijn, downloaden (alleen concept)
//  send           — ontvangers vastleggen, versturen, mailen
//  discard        — concept weggooien
//  revoke         — intrekken: links dood, bestanden meteen weg
//  extend         — vervaldatum aanpassen
//  resend         — een ontvanger opnieuw mailen (nieuwe link)
//  addRecipients  — na versturen nog iemand toevoegen
//  revokeRecipient— één ontvanger de toegang ontnemen
//  delete         — zending met gegevens en al verwijderen
//  attachToTicket — het concept als bijlage bij een zichtbaar ticketantwoord
//
// DE KERNREGEL staat in de database (20261013100000): welke klant, welke
// ontvanger, wanneer iets vastligt. Wat hier gebeurt is een vroege, leesbare
// controle, plus het werk dat een database niet kan: bestanden kopiëren in de
// opslag, mailen en opruimen.
//
// Deze functie draait op de service-role. De modulerechten van het teamlid
// worden daarom hier gecontroleerd: Inhoud schrijven altijd, Klanten schrijven
// voor een zending aan een klant (het is klantcommunicatie), Tickets schrijven
// voor een bijlage bij een ticket.
// ============================================================

const admin = createAdminClient();

const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const CRON_SECRET = Deno.env.get('FILE_TRANSFER_CRON_SECRET') || '';

const cors = makeCors(
  parseAllowedOrigins([
    Deno.env.get('FILE_TRANSFER_ALLOWED_ORIGINS'),
    Deno.env.get('FILE_SHARE_ALLOWED_ORIGINS'),
    Deno.env.get('APP_ALLOWED_ORIGINS'),
    Deno.env.get('APP_PUBLIC_URL'),
    Deno.env.get('MAIL_ALLOWED_ORIGINS'),
  ]),
  (Deno.env.get('ALLOW_LOCAL_DEV') ?? '1') === '1',
);

type Ctx = { user: { id: string; email?: string }; organizationId: string; role: string };

serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('cron') === 'purge') return handleCron(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });

  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new HttpError('Alleen POST.', 400);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');
    if (!isUuid(organizationId)) throw new HttpError('organizationId is verplicht.', 400);

    const user = await requireUser(admin, req);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);
    assertWriteRole(role);
    await assertModuleAccess(admin, user.id, organizationId, 'content', 'write');
    const ctx: Ctx = { user, organizationId, role };

    switch (action) {
      case 'prepare': return cors.json(req, { ok: true, ...(await prepare(ctx, body)) });
      case 'addSources': return cors.json(req, { ok: true, ...(await addSources(ctx, body)) });
      case 'removeItem': return cors.json(req, { ok: true, ...(await removeItem(ctx, body)) });
      case 'updateDraft': return cors.json(req, { ok: true, ...(await updateDraft(ctx, body)) });
      case 'send': return cors.json(req, { ok: true, ...(await send(ctx, body)) });
      case 'discard': return cors.json(req, { ok: true, ...(await discard(ctx, body)) });
      case 'revoke': return cors.json(req, { ok: true, ...(await revoke(ctx, body)) });
      case 'extend': return cors.json(req, { ok: true, ...(await extend(ctx, body)) });
      case 'resend': return cors.json(req, { ok: true, ...(await resend(ctx, body)) });
      case 'addRecipients': return cors.json(req, { ok: true, ...(await addRecipients(ctx, body)) });
      case 'revokeRecipient': return cors.json(req, { ok: true, ...(await revokeRecipient(ctx, body)) });
      case 'delete': return cors.json(req, { ok: true, ...(await deleteTransfer(ctx, body)) });
      case 'attachToTicket': return cors.json(req, { ok: true, ...(await attachToTicket(ctx, body)) });
      default: throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
  } catch (err) {
    const { status, message } = toHttp(err);
    if (status >= 500) console.error('file-transfer error', message, err instanceof Error ? err.stack : undefined);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

// ── Fouten ────────────────────────────────────────────────────────────

function toHttp(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof TransferStorageError) return { status: err.status, message: err.message };
  const pg = err as { message?: string; code?: string; details?: string };
  if (pg && typeof pg === 'object' && typeof pg.code === 'string') {
    return dbError(pg);
  }
  return { status: 500, message: err instanceof Error ? err.message : 'Onbekende fout' };
}

/** Databasefouten uit de triggers zijn als gebruikerstekst geschreven; die gaan ongewijzigd terug. */
function dbError(error: { message?: string; code?: string; details?: string }): { status: number; message: string } {
  const text = `${error.message ?? ''} ${error.details ?? ''}`;
  if (/relation .*file_transfer|schema cache|could not find the (table|function)/i.test(text)) {
    return { status: 503, message: 'Bestanden versturen is nog niet geactiveerd. Voer de migratie 20261013100000_file_transfers.sql uit.' };
  }
  if (error.code === '42501' || error.code === '23514' || error.code === '02000') {
    return { status: error.code === '02000' ? 404 : 403, message: error.message || 'Dit mag niet.' };
  }
  if (error.code === '23505') return { status: 409, message: 'Deze ontvanger staat er al bij.' };
  return { status: 400, message: error.message || 'Dat lukte niet.' };
}

function fail(status: HttpStatus, message: string): never {
  throw new HttpError(message, status);
}

async function must<T>(promise: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw error;
  return data as T;
}

// ── Invoer ────────────────────────────────────────────────────────────

type SourceType = 'attachment' | 'note' | 'document' | 'folder';
type Source = { type: SourceType; id: string };

function parseSources(raw: unknown): Source[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(400, 'Ongeldige bestandenlijst.');
  if (raw.length > 200) fail(400, 'Kies hoogstens 200 items tegelijk.');
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const entry of raw) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const type = String(item.type ?? '');
    const id = String(item.id ?? '');
    if (!['attachment', 'note', 'document', 'folder'].includes(type)) fail(400, `Onbekend soort item: ${type}`);
    if (!isUuid(id)) fail(400, 'Ongeldig item.');
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: type as SourceType, id });
  }
  return out;
}

function optionalUuid(raw: unknown, label: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = String(raw);
  if (!isUuid(value)) fail(400, `Ongeldig ${label}.`);
  return value;
}

function cleanSubject(raw: unknown, fallback: string): string {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (value.length > 200) fail(400, 'Het onderwerp mag hoogstens 200 tekens zijn.');
  return value || fallback;
}

function cleanMessage(raw: unknown): string | null {
  const value = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (value.length > 5000) fail(400, 'Het bericht mag hoogstens 5000 tekens zijn.');
  return value || null;
}

// ── Laden en rechten ──────────────────────────────────────────────────

async function requireTransfer(ctx: Ctx, rawId: unknown): Promise<TransferRow> {
  const id = String(rawId ?? '');
  if (!isUuid(id)) fail(400, 'Ongeldige zending.');
  const transfer = await loadTransfer(admin, id, ctx.organizationId);
  if (!transfer) fail(404, 'Deze zending bestaat niet (meer).');
  return transfer;
}

/** Een concept is van wie het begon: alleen die vult en verstuurt het. */
async function requireOwnDraft(ctx: Ctx, rawId: unknown): Promise<TransferRow> {
  const transfer = await requireTransfer(ctx, rawId);
  if (transfer.status !== 'draft') fail(409, 'Deze zending is al verstuurd.');
  if (transfer.created_by !== ctx.user.id) fail(403, 'Alleen wie deze zending begon, kan hem aanpassen of versturen.');
  return transfer;
}

async function requireClientsWrite(ctx: Ctx, transfer: { client_id: string | null }): Promise<void> {
  if (transfer.client_id) await assertModuleAccess(admin, ctx.user.id, ctx.organizationId, 'clients', 'write');
}

async function loadRecipients(transferId: string): Promise<TransferRecipientRow[]> {
  return await must(admin
    .from('file_transfer_recipients')
    .select(RECIPIENT_COLUMNS)
    .eq('transfer_id', transferId)
    .order('created_at', { ascending: true })) as unknown as TransferRecipientRow[];
}

/** Het geheel zoals de browser het terugkrijgt. */
async function bundle(transferId: string) {
  const transfer = await loadTransfer(admin, transferId);
  if (!transfer) return { transfer: null, items: [], recipients: [] };
  const [items, recipients] = await Promise.all([loadTransferItems(admin, transferId), loadRecipients(transferId)]);
  return { transfer, items, recipients };
}

type ItemContext = { client_id: string | null; project_id: string | null; item_name: string | null; client_name: string | null };

async function itemContext(organizationId: string, type: string, id: string): Promise<ItemContext> {
  const { data, error } = await admin.rpc('drive_item_client', {
    p_organization_id: organizationId,
    p_item_type: type,
    p_item_id: id,
  });
  if (error) fail(400, error.message || 'Dit item kan niet worden verstuurd.');
  const row = (Array.isArray(data) ? data[0] : data) as ItemContext | undefined;
  if (!row) fail(404, 'Dit item bestaat niet (meer).');
  return row;
}

// ── prepare / addSources ──────────────────────────────────────────────

async function prepare(ctx: Ctx, body: Record<string, unknown>) {
  const origin = ['content', 'client', 'message', 'ticket', 'gerrie'].includes(String(body.origin)) ? String(body.origin) : 'content';
  const sources = parseSources(body.sources);
  const requestedClientId = optionalUuid(body.clientId, 'klant');
  const ticketId = optionalUuid(body.ticketId, 'ticket');
  const threadId = optionalUuid(body.threadId, 'gesprek');

  // De klant volgt uit de bestanden. Twee dossiers in één zending kan niet.
  let clientId: string | null = requestedClientId;
  let clientName: string | null = null;
  if (sources.length > 0) {
    const clients = new Map<string, string | null>();
    for (const source of sources) {
      const context = await itemContext(ctx.organizationId, source.type, source.id);
      clients.set(context.client_id ?? '', context.client_name);
    }
    if (clients.size > 1) {
      fail(400, 'Een zending hoort bij één klant, en deze bestanden komen uit verschillende dossiers. Verstuur ze per klant.');
    }
    const [[derived, derivedName]] = [...clients.entries()];
    const derivedClient = derived || null;
    if (requestedClientId !== null && requestedClientId !== derivedClient) {
      fail(400, derivedClient
        ? `Deze bestanden horen bij klantdossier “${derivedName ?? 'onbekend'}”, niet bij de gekozen klant.`
        : 'Deze bestanden horen bij geen klant. Kies geen klant, of upload de bestanden zelf in de zending.');
    }
    clientId = derivedClient;
    clientName = derivedName;
  } else if (clientId) {
    const client = await must(admin.from('clients').select('id,name').eq('id', clientId).eq('organization_id', ctx.organizationId).maybeSingle()) as { id: string; name: string } | null;
    if (!client) fail(404, 'Deze klant bestaat niet in deze organisatie.');
    clientName = client.name;
  }

  await requireClientsWrite(ctx, { client_id: clientId });
  if (origin === 'ticket' || ticketId) {
    if (!ticketId) fail(400, 'Kies het ticket waar de bestanden bij horen.');
    await assertModuleAccess(admin, ctx.user.id, ctx.organizationId, 'tickets', 'write');
  }

  const fallbackSubject = clientName ? `Bestanden voor ${clientName}` : 'Bestanden';
  const subject = cleanSubject(body.subject, sources.length === 1 ? (await sourceName(ctx, sources[0])) || fallbackSubject : fallbackSubject);
  const expiry = parseTransferExpiry(body.expiresAt);
  if (!expiry.ok) fail(400, expiry.error);

  const transfer = await must(admin
    .from('file_transfers')
    .insert({
      organization_id: ctx.organizationId,
      created_by: ctx.user.id,
      client_id: clientId,
      subject,
      message: cleanMessage(body.message),
      can_download: body.canDownload !== false,
      expires_at: expiry.iso,
      origin,
      ticket_id: ticketId,
      client_email_thread_id: threadId,
    })
    .select('*')
    .single()) as TransferRow;

  const outcome = sources.length > 0 ? await addSourcesTo(ctx, transfer, sources) : { added: 0, skipped: [] as Array<{ name: string; reason: string }> };
  return { ...(await bundle(transfer.id)), skipped: outcome.skipped };
}

async function sourceName(ctx: Ctx, source: Source): Promise<string | null> {
  const table = source.type === 'attachment' ? 'attachments' : source.type === 'note' ? 'notes' : source.type === 'document' ? 'documents' : 'content_folders';
  const column = source.type === 'attachment' || source.type === 'folder' ? 'name' : 'title';
  const row = await must(admin.from(table).select(column).eq('id', source.id).eq('organization_id', ctx.organizationId).maybeSingle()) as Record<string, string> | null;
  const value = String(row?.[column] ?? '').trim();
  return value ? value.slice(0, 200) : null;
}

async function addSources(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireOwnDraft(ctx, body.transferId);
  const sources = parseSources(body.sources);
  if (sources.length === 0) fail(400, 'Kies iets om toe te voegen.');
  // Vroege controle per bron; de trigger op file_transfer_items doet het nog eens.
  for (const source of sources) {
    const context = await itemContext(ctx.organizationId, source.type, source.id);
    if ((context.client_id ?? null) !== transfer.client_id) {
      fail(403, transfer.client_id
        ? `“${context.item_name ?? 'Dit item'}” hoort niet bij de klant van deze zending.`
        : `“${context.item_name ?? 'Dit item'}” hoort bij klantdossier “${context.client_name ?? 'onbekend'}”. Begin een zending voor die klant.`);
    }
  }
  const outcome = await addSourcesTo(ctx, transfer, sources);
  return { ...(await bundle(transfer.id)), skipped: outcome.skipped };
}

type Leaf = { type: 'attachment' | 'note' | 'document'; id: string; path: string };

/**
 * Zet bronnen uit Inhoud om in bestanden van de zending: mappen uitgeklapt,
 * bestanden gekopieerd (eigen kopie, met SHA-256), notities en tekstdocumenten
 * bevroren als HTML. Wat niet mee kan, komt terug in `skipped` met de reden.
 */
async function addSourcesTo(ctx: Ctx, transfer: TransferRow, sources: Source[]) {
  const leaves: Leaf[] = [];
  for (const source of sources) {
    if (source.type === 'folder') {
      const { data, error } = await admin.rpc('drive_folder_leaves', { p_organization_id: ctx.organizationId, p_folder_id: source.id });
      if (error) fail(400, error.message || 'Deze map kon niet worden uitgeklapt.');
      for (const row of (data || []) as Array<{ item_type: Leaf['type']; item_id: string; path: string | null }>) {
        leaves.push({ type: row.item_type, id: row.item_id, path: row.path || '' });
      }
    } else {
      leaves.push({ type: source.type, id: source.id, path: '' });
    }
  }

  const existing = await loadTransferItems(admin, transfer.id);
  const present = new Set(existing.map((item) => `${item.source_type}:${item.source_id}`));
  let count = existing.length;
  const skipped: Array<{ name: string; reason: string }> = [];
  let added = 0;

  for (const leaf of leaves) {
    if (present.has(`${leaf.type}:${leaf.id}`)) continue;
    if (count >= TRANSFER_MAX_ITEMS) {
      skipped.push({ name: '…', reason: `Een zending heeft hoogstens ${TRANSFER_MAX_ITEMS} bestanden.` });
      break;
    }
    try {
      const ok = await addLeaf(ctx, transfer, leaf, count);
      if (ok.added) {
        added += 1;
        count += 1;
        present.add(`${leaf.type}:${leaf.id}`);
      } else if (ok.skipped) {
        skipped.push(ok.skipped);
      }
    } catch (error) {
      const { message } = toHttp(error);
      skipped.push({ name: leaf.path || leaf.type, reason: message });
    }
  }
  return { added, skipped };
}

async function addLeaf(ctx: Ctx, transfer: TransferRow, leaf: Leaf, position: number): Promise<{ added: boolean; skipped?: { name: string; reason: string } }> {
  if (leaf.type === 'attachment') {
    const att = await must(admin
      .from('attachments')
      .select('id,name,mime_type,size_bytes,storage_key,entity_type')
      .eq('id', leaf.id)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle()) as { id: string; name: string; mime_type: string | null; size_bytes: number | null; storage_key: string | null; entity_type: string | null } | null;
    // Alleen bestanden uit Inhoud. Een bijlage van een taak, ticket of project
    // hoort bij een andere module, waar deze gebruiker misschien niet bij mag.
    if (!att || att.entity_type !== 'folder') {
      return { added: false, skipped: { name: att?.name ?? 'bestand', reason: 'Alleen bestanden uit Inhoud kunnen mee. Zet een bijlage eerst in een map.' } };
    }
    if (!att.storage_key) return { added: false, skipped: { name: att.name, reason: 'Er hoort geen bestand bij.' } };
    if (!(await storageKeyBelongsOnlyTo(admin, ctx.organizationId, att.storage_key, { table: 'attachments', id: att.id }))) {
      return { added: false, skipped: { name: att.name, reason: 'Dit bestand kan niet worden meegestuurd.' } };
    }
    return copyFile(ctx, transfer, leaf, position, att.name, att.storage_key, att.size_bytes);
  }

  if (leaf.type === 'document') {
    const doc = await must(admin
      .from('documents')
      .select('id,title,content,storage_key,size_bytes')
      .eq('id', leaf.id)
      .eq('organization_id', ctx.organizationId)
      .maybeSingle()) as { id: string; title: string | null; content: string | null; storage_key: string | null; size_bytes: number | null } | null;
    if (!doc) return { added: false, skipped: { name: 'document', reason: 'Dit document bestaat niet meer.' } };
    if (doc.storage_key) {
      if (!(await storageKeyBelongsOnlyTo(admin, ctx.organizationId, doc.storage_key, { table: 'documents', id: doc.id }))) {
        return { added: false, skipped: { name: cleanFileName(doc.title, 'Document'), reason: 'Dit document kan niet worden meegestuurd.' } };
      }
      const title = cleanFileName(doc.title, 'Document');
      const extension = (doc.storage_key.match(/\.([A-Za-z0-9]{2,5})$/)?.[1] ?? 'docx').toLowerCase();
      const name = title.toLowerCase().endsWith(`.${extension}`) ? title : `${title}.${extension}`;
      return copyFile(ctx, transfer, leaf, position, name, doc.storage_key, doc.size_bytes);
    }
    return snapshot(ctx, transfer, leaf, position, cleanFileName(doc.title, 'Document'), doc.content);
  }

  const note = await must(admin
    .from('notes')
    .select('id,title,content')
    .eq('id', leaf.id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()) as { id: string; title: string | null; content: string | null } | null;
  if (!note) return { added: false, skipped: { name: 'notitie', reason: 'Deze notitie bestaat niet meer.' } };
  return snapshot(ctx, transfer, leaf, position, cleanFileName(note.title, 'Notitie'), note.content);
}

async function copyFile(
  ctx: Ctx, transfer: TransferRow, leaf: Leaf, position: number,
  name: string, sourceKey: string, sizeBytes: number | null,
): Promise<{ added: boolean; skipped?: { name: string; reason: string } }> {
  const ext = blockedExtension(name);
  if (ext) return { added: false, skipped: { name, reason: blockedExtensionMessage(name, ext) } };
  if (typeof sizeBytes === 'number' && sizeBytes > TRANSFER_MAX_FILE_BYTES) {
    return { added: false, skipped: { name, reason: 'Groter dan 1 GB.' } };
  }
  const copy = await copyIntoTransfer({ organizationId: ctx.organizationId, transferId: transfer.id, sourceKey, fileName: name });
  const { error } = await admin.from('file_transfer_items').insert({
    organization_id: ctx.organizationId,
    transfer_id: transfer.id,
    source_type: leaf.type,
    source_id: leaf.id,
    name,
    mime_type: copy.contentType || 'application/octet-stream',
    size_bytes: copy.size,
    sha256: copy.sha256 || null,
    storage_key: copy.key,
    path: leaf.path,
    position,
  });
  if (error) {
    // De kopie staat er al; zonder rij hoort hij er niet te blijven. Lukt
    // verwijderen nu niet, dan doet de opruimtaak het (de worker zette hem al
    // in de wachtrij).
    await deleteStorageObject(ctx.organizationId, copy.key).catch(() => undefined);
    throw error;
  }
  // De rij is er: de kopie is niet langer "nog op te ruimen".
  await admin.from('storage_purge_queue').delete()
    .eq('organization_id', ctx.organizationId)
    .eq('storage_key', copy.key)
    .eq('reason', 'file_transfer_pending');
  return { added: true };
}

async function snapshot(
  ctx: Ctx, transfer: TransferRow, leaf: Leaf, position: number,
  name: string, html: string | null,
): Promise<{ added: boolean; skipped?: { name: string; reason: string } }> {
  const content = String(html ?? '');
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > TRANSFER_MAX_SNAPSHOT_BYTES) {
    return { added: false, skipped: { name, reason: 'Te groot om als tekst mee te sturen (meer dan 2 MB).' } };
  }
  const { error } = await admin.from('file_transfer_items').insert({
    organization_id: ctx.organizationId,
    transfer_id: transfer.id,
    source_type: leaf.type,
    source_id: leaf.id,
    name,
    mime_type: 'text/html',
    size_bytes: bytes,
    html_snapshot: content || '<p></p>',
    path: leaf.path,
    position,
  });
  if (error) throw error;
  return { added: true };
}

// ── removeItem / updateDraft / discard ────────────────────────────────

async function removeItem(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireOwnDraft(ctx, body.transferId);
  const itemId = String(body.itemId ?? '');
  if (!isUuid(itemId)) fail(400, 'Ongeldig bestand.');
  const item = await must(admin
    .from('file_transfer_items')
    .select('id,storage_key')
    .eq('id', itemId)
    .eq('transfer_id', transfer.id)
    .maybeSingle()) as { id: string; storage_key: string | null } | null;
  if (!item) fail(404, 'Dit bestand zit niet in deze zending.');
  const { error } = await admin.from('file_transfer_items').delete().eq('id', item.id);
  if (error) throw error;
  // De database zet de sleutel ook in de opruimwachtrij; meteen weghalen is netter.
  if (item.storage_key) await deleteStorageObject(ctx.organizationId, item.storage_key).catch(() => undefined);
  return await bundle(transfer.id);
}

async function updateDraft(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireOwnDraft(ctx, body.transferId);
  const patch: Record<string, unknown> = {};
  if (body.subject !== undefined) patch.subject = cleanSubject(body.subject, transfer.subject);
  if (body.message !== undefined) patch.message = cleanMessage(body.message);
  if (body.canDownload !== undefined) patch.can_download = body.canDownload !== false;
  if (body.expiresAt !== undefined) {
    const expiry = parseTransferExpiry(body.expiresAt);
    if (!expiry.ok) fail(400, expiry.error);
    patch.expires_at = expiry.iso;
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await admin.from('file_transfers').update(patch).eq('id', transfer.id);
    if (error) throw error;
  }
  return await bundle(transfer.id);
}

async function discard(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireOwnDraft(ctx, body.transferId);
  await purgeNow(ctx.organizationId, transfer.id, { deleteRow: true });
  return { discarded: true };
}

// ── send / addRecipients / resend ─────────────────────────────────────

type RecipientResult = {
  recipient: TransferRecipientRow | null;
  input: TransferRecipientInput;
  notified: boolean;
  error: string | null;
};

type MailContext = {
  sender: SenderIdentity;
  senderName: string;
  company: CompanyForMail | null;
  content: Awaited<ReturnType<typeof loadTransferEmailContent>>;
  clientName: string | null;
};

async function mailContext(ctx: Ctx, transfer: TransferRow): Promise<MailContext> {
  const [sender, company, content, client] = await Promise.all([
    resolveSenderIdentity(admin, ctx.organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO, ctx.user.id),
    loadCompanyForMail(admin, ctx.organizationId),
    loadTransferEmailContent(admin, ctx.organizationId),
    transfer.client_id
      ? admin.from('clients').select('name').eq('id', transfer.client_id).maybeSingle().then((r) => (r.data as { name?: string } | null)?.name ?? null)
      : Promise.resolve(null),
  ]);
  return { sender, senderName: senderNameFor(sender, ctx.user, company), company, content, clientName: client };
}

/** Kan deze ontvanger ook op het klantportaal? Alleen dan noemt de mail het portaal. */
async function isPortalUser(transfer: TransferRow, recipient: TransferRecipientRow): Promise<boolean> {
  if (!transfer.client_id) return false;
  if (recipient.kind === 'client') return true;
  if (recipient.kind !== 'contact' || !recipient.client_contact_id) return false;
  const { data } = await admin.from('client_contacts').select('gives_portal_access,is_active').eq('id', recipient.client_contact_id).maybeSingle();
  const row = data as { gives_portal_access?: boolean; is_active?: boolean } | null;
  return Boolean(row?.gives_portal_access && row?.is_active);
}

/** Voegt ontvangers toe (de trigger toetst ze) en geeft per persoon de uitkomst. */
async function insertRecipients(ctx: Ctx, transfer: TransferRow, inputs: TransferRecipientInput[], expected: Map<string, string>): Promise<RecipientResult[]> {
  const results: RecipientResult[] = [];
  for (const input of inputs) {
    const values: Record<string, unknown> = {
      organization_id: ctx.organizationId,
      transfer_id: transfer.id,
      kind: input.kind,
      client_contact_id: input.kind === 'contact' ? input.clientContactId : null,
      // Bij 'client' en 'contact' vult de database het adres zelf in.
      email: input.kind === 'email' ? input.email : 'pending@resofly.invalid',
      name: input.kind === 'email' ? input.name : null,
    };
    const { data, error } = await admin.from('file_transfer_recipients').insert(values).select(RECIPIENT_COLUMNS).single();
    if (error) {
      results.push({ recipient: null, input, notified: false, error: dbError(error as { message?: string; code?: string }).message });
      continue;
    }
    const row = data as unknown as TransferRecipientRow;
    // Het adres dat de afzender in beeld had, moet nog kloppen (bv. net gewijzigd op de klantkaart).
    const key = input.kind === 'client' ? 'client' : input.kind === 'contact' ? `contact:${input.clientContactId}` : `email:${input.email}`;
    if (expected.has(key) && approvedRecipientChanged(expected.get(key), row.email)) {
      await admin.from('file_transfer_recipients').delete().eq('id', row.id);
      results.push({ recipient: null, input, notified: false, error: `Het e-mailadres is intussen gewijzigd in ${row.email}. Controleer de ontvanger en verstuur opnieuw.` });
      continue;
    }
    results.push({ recipient: row, input, notified: false, error: null });
  }
  return results;
}

function expectedEmails(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(raw)) return map;
  for (const entry of raw) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const expected = String(item.expectedEmail ?? '').trim();
    if (!expected) continue;
    const kind = String(item.kind ?? '');
    if (kind === 'client') map.set('client', expected);
    else if (kind === 'contact') map.set(`contact:${String(item.clientContactId ?? '')}`, expected);
  }
  return map;
}

async function notifyAll(
  ctx: Ctx, transfer: TransferRow, results: RecipientResult[], threadId: string | null, known?: MailContext,
): Promise<string | null> {
  const mail = known ?? await mailContext(ctx, transfer);
  let thread = threadId;
  for (const result of results) {
    if (!result.recipient) continue;
    const outcome = await sendTransferNotice(admin, {
      transfer,
      recipient: result.recipient,
      userId: ctx.user.id,
      sender: mail.sender,
      senderName: mail.senderName,
      company: mail.company,
      content: mail.content,
      clientName: mail.clientName,
      threadId: thread,
      portalUser: await isPortalUser(transfer, result.recipient),
    });
    result.notified = outcome.notified;
    result.error = outcome.error;
    if (outcome.threadId) thread = outcome.threadId;
  }
  return thread;
}

async function send(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireOwnDraft(ctx, body.transferId);
  await requireClientsWrite(ctx, transfer);
  if (transfer.origin === 'ticket') fail(400, 'Bestanden bij een ticket verstuur je met het antwoord op het ticket.');

  const parsed = parseTransferRecipients(body.recipients, Boolean(transfer.client_id));
  if (!parsed.ok) fail(400, parsed.error);
  const expiry = parseTransferExpiry(body.expiresAt ?? null);
  if (!expiry.ok) fail(400, expiry.error);
  const threadId = optionalUuid(body.threadId, 'gesprek') ?? transfer.client_email_thread_id;

  const items = await loadTransferItems(admin, transfer.id);
  if (items.length === 0) fail(400, 'Voeg eerst bestanden toe.');

  // Onderwerp, bericht en termijn vastleggen — nog als concept.
  const { error: patchError } = await admin.from('file_transfers').update({
    subject: cleanSubject(body.subject, transfer.subject),
    message: body.message !== undefined ? cleanMessage(body.message) : transfer.message,
    expires_at: expiry.iso,
    can_download: body.canDownload !== false,
    client_email_thread_id: threadId,
  }).eq('id', transfer.id);
  if (patchError) throw patchError;

  const results = await insertRecipients(ctx, transfer, parsed.recipients, expectedEmails(body.recipients));
  if (!results.some((r) => r.recipient)) {
    fail(400, results.find((r) => r.error)?.error || 'Geen van de ontvangers kon worden toegevoegd.');
  }

  const mail = await mailContext(ctx, transfer);
  const { data: sentRow, error: sentError } = await admin
    .from('file_transfers')
    .update({ status: 'sent', sender_name: mail.senderName })
    .eq('id', transfer.id)
    .select('*')
    .single();
  if (sentError) throw sentError;
  const sent = sentRow as TransferRow;
  await recordTransferEvent(admin, { transferId: sent.id, kind: 'sent', actorUserId: ctx.user.id, detail: `${results.filter((r) => r.recipient).length} ontvanger(s)` });

  const thread = await notifyAll(ctx, sent, results, threadId, mail);
  if (thread && thread !== sent.client_email_thread_id) {
    await admin.from('file_transfers').update({ client_email_thread_id: thread }).eq('id', sent.id);
  }

  return { ...(await bundle(sent.id)), results: results.map(publicResult) };
}

/** De invoer die bij een bestaande ontvanger hoort (voor de uitkomstregel). */
function inputFor(recipient: TransferRecipientRow): TransferRecipientInput {
  if (recipient.kind === 'contact' && recipient.client_contact_id) return { kind: 'contact', clientContactId: recipient.client_contact_id };
  if (recipient.kind === 'email') return { kind: 'email', email: recipient.email, name: recipient.name };
  return { kind: 'client' };
}

function publicResult(result: RecipientResult) {
  return {
    recipientId: result.recipient?.id ?? null,
    email: result.recipient?.email ?? (result.input.kind === 'email' ? result.input.email : null),
    name: result.recipient?.name ?? null,
    kind: result.input.kind,
    notified: result.notified,
    error: result.error,
  };
}

async function addRecipients(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireTransfer(ctx, body.transferId);
  if (transfer.status !== 'sent' || Date.parse(transfer.expires_at) <= Date.now()) fail(409, 'Deze zending is niet meer actief.');
  await requireClientsWrite(ctx, transfer);
  const parsed = parseTransferRecipients(body.recipients, Boolean(transfer.client_id));
  if (!parsed.ok) fail(400, parsed.error);
  const results = await insertRecipients(ctx, transfer, parsed.recipients, expectedEmails(body.recipients));
  for (const result of results) {
    if (result.recipient) {
      await recordTransferEvent(admin, { transferId: transfer.id, recipientId: result.recipient.id, kind: 'recipient_added', actorUserId: ctx.user.id });
    }
  }
  await notifyAll(ctx, transfer, results, transfer.client_email_thread_id);
  return { ...(await bundle(transfer.id)), results: results.map(publicResult) };
}

async function resend(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireTransfer(ctx, body.transferId);
  if (transfer.status !== 'sent' || Date.parse(transfer.expires_at) <= Date.now()) fail(409, 'Deze zending is niet meer actief.');
  await requireClientsWrite(ctx, transfer);
  const recipientId = String(body.recipientId ?? '');
  if (!isUuid(recipientId)) fail(400, 'Ongeldige ontvanger.');
  const recipient = await must(admin
    .from('file_transfer_recipients')
    .select(RECIPIENT_COLUMNS)
    .eq('id', recipientId)
    .eq('transfer_id', transfer.id)
    .maybeSingle()) as unknown as TransferRecipientRow | null;
  if (!recipient) fail(404, 'Deze ontvanger hoort niet bij de zending.');
  if (recipient.revoked_at) fail(409, 'Deze ontvanger is ingetrokken.');
  // Ook de mail zelf (onderwerp, bericht, klantnaam) is klantinformatie: niet
  // opnieuw naar een adres dat niet meer op de klantkaart staat.
  const { data: stillValid, error: validError } = await admin.rpc('file_transfer_recipient_still_valid', { p_recipient_id: recipient.id });
  if (validError) throw validError;
  if (stillValid !== true) {
    fail(409, recipient.kind === 'email'
      ? 'Deze ontvanger kan niet meer worden gemaild.'
      : 'Dit adres klopt niet meer met de klantkaart, of de contactpersoon staat op inactief. Trek deze ontvanger in en voeg de juiste persoon toe.');
  }

  const results: RecipientResult[] = [{ recipient, input: inputFor(recipient), notified: false, error: null }];
  await notifyAll(ctx, transfer, results, transfer.client_email_thread_id);
  if (results[0].notified) {
    await recordTransferEvent(admin, { transferId: transfer.id, recipientId: recipient.id, kind: 'resent', actorUserId: ctx.user.id });
  }
  return { ...(await bundle(transfer.id)), results: results.map(publicResult) };
}

// ── revoke / extend / revokeRecipient / delete ────────────────────────

async function revoke(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireTransfer(ctx, body.transferId);
  if (transfer.status === 'draft') fail(409, 'Dit is nog een concept; gooi het weg in plaats van in te trekken.');
  if (transfer.status === 'sent') {
    const { error } = await admin.from('file_transfers')
      .update({ status: 'revoked', revoked_by: ctx.user.id, revoked_at: new Date().toISOString() })
      .eq('id', transfer.id);
    if (error) throw error;
    await admin.from('file_transfer_recipients').update({ token_hash: null }).eq('transfer_id', transfer.id);
    await recordTransferEvent(admin, { transferId: transfer.id, kind: 'revoked', actorUserId: ctx.user.id });
  }
  // Ingetrokken = de bestanden meteen weg, niet pas bij de volgende opruimronde.
  await purgeNow(ctx.organizationId, transfer.id, { deleteRow: false });
  return await bundle(transfer.id);
}

async function extend(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireTransfer(ctx, body.transferId);
  if (transfer.status !== 'sent' || Date.parse(transfer.expires_at) <= Date.now()) {
    fail(409, 'Alleen een verstuurde, nog lopende zending kun je verlengen. Is hij verlopen, stuur de bestanden dan opnieuw.');
  }
  await requireClientsWrite(ctx, transfer);
  const expiry = parseTransferExpiry(body.expiresAt);
  if (!expiry.ok) fail(400, expiry.error);
  const { error } = await admin.from('file_transfers').update({ expires_at: expiry.iso }).eq('id', transfer.id);
  if (error) throw error;
  await recordTransferEvent(admin, { transferId: transfer.id, kind: 'extended', actorUserId: ctx.user.id, detail: `tot ${expiry.iso.slice(0, 10)}` });
  return await bundle(transfer.id);
}

async function revokeRecipient(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireTransfer(ctx, body.transferId);
  const recipientId = String(body.recipientId ?? '');
  if (!isUuid(recipientId)) fail(400, 'Ongeldige ontvanger.');
  const { data, error } = await admin.from('file_transfer_recipients')
    .update({ revoked_at: new Date().toISOString(), token_hash: null })
    .eq('id', recipientId)
    .eq('transfer_id', transfer.id)
    .is('revoked_at', null)
    .select('id');
  if (error) throw error;
  if ((data as unknown[] | null)?.length) {
    await admin.from('file_transfer_sessions').delete().eq('recipient_id', recipientId);
    await recordTransferEvent(admin, { transferId: transfer.id, recipientId, kind: 'recipient_revoked', actorUserId: ctx.user.id });
  }
  return await bundle(transfer.id);
}

async function deleteTransfer(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireTransfer(ctx, body.transferId);
  if (transfer.status === 'draft' && transfer.created_by !== ctx.user.id) fail(403, 'Dit concept is van een collega.');
  await requireClientsWrite(ctx, transfer);
  // Verwijderen wist ook het bewijs (wie kreeg wat, wanneer): dat mag alleen
  // wie de zending verstuurde, of een eigenaar/beheerder.
  if (transfer.status !== 'draft' && transfer.created_by !== ctx.user.id && !['owner', 'admin'].includes(ctx.role)) {
    fail(403, 'Alleen wie deze zending verstuurde, of een beheerder, kan hem verwijderen. Intrekken kan wel.');
  }
  await purgeNow(ctx.organizationId, transfer.id, { deleteRow: true });
  return { deleted: true };
}

/**
 * Haalt de bestanden van één zending nu meteen uit de opslag en markeert ze
 * als opgeruimd; met `deleteRow` gaat de zending daarna helemaal weg.
 */
async function purgeNow(organizationId: string, transferId: string, opts: { deleteRow: boolean }): Promise<void> {
  const items = await loadTransferItems(admin, transferId);
  const purged: string[] = [];
  for (const item of items) {
    if (item.purged_at) continue;
    if (item.storage_key) {
      try {
        await deleteStorageObject(organizationId, item.storage_key);
      } catch (error) {
        console.warn('file-transfer purge: verwijderen uit R2 mislukte, de opruimtaak probeert het opnieuw', error instanceof Error ? error.message : error);
        continue;
      }
    }
    purged.push(item.id);
  }
  if (opts.deleteRow) {
    // Wat niet uit R2 kon, zet de database bij het verwijderen in de opruimwachtrij.
    if (purged.length > 0) await admin.rpc('file_transfer_mark_purged', { p_item_ids: purged });
    const { error } = await admin.from('file_transfers').delete().eq('id', transferId);
    if (error) throw error;
    return;
  }
  if (purged.length > 0) {
    const { error } = await admin.rpc('file_transfer_mark_purged', { p_item_ids: purged });
    if (error) console.warn('file_transfer_mark_purged', error.message);
  }
}

// ── attachToTicket ────────────────────────────────────────────────────

/**
 * Bestanden bij een ticketantwoord: het antwoord wordt een zichtbare notitie
 * op de tickettijdlijn, en de bestanden hangen eronder. De klant ziet ze in het
 * portaal bij het ticket (geen eigen link of code: het portaal is al de login),
 * en de gewone ticketmelding gaat de deur uit.
 */
async function attachToTicket(ctx: Ctx, body: Record<string, unknown>) {
  const transfer = await requireOwnDraft(ctx, body.transferId);
  if (!transfer.ticket_id) fail(400, 'Deze zending hoort bij geen ticket.');
  await assertModuleAccess(admin, ctx.user.id, ctx.organizationId, 'tickets', 'write');
  const text = String(body.body ?? '').trim();
  if (!text) fail(400, 'Schrijf een antwoord bij de bestanden.');
  if (text.length > 20000) fail(400, 'Het antwoord is te lang.');
  const items = await loadTransferItems(admin, transfer.id);
  if (items.length === 0) fail(400, 'Voeg eerst bestanden toe.');

  const ticket = await must(admin.from('tickets').select('id,title,client_id').eq('id', transfer.ticket_id).eq('organization_id', ctx.organizationId).maybeSingle()) as { id: string; title: string; client_id: string | null } | null;
  if (!ticket) fail(404, 'Dit ticket bestaat niet meer.');
  if (!ticket.client_id) fail(400, 'Dit ticket hangt aan geen klant; de klant kan de bestanden dan nergens zien.');
  if (ticket.client_id !== transfer.client_id) {
    fail(409, 'Dit ticket hoort intussen bij een andere klant dan de bestanden. Begin het antwoord opnieuw.');
  }

  const expiry = parseTransferExpiry(body.expiresAt ?? null);
  if (!expiry.ok) fail(400, expiry.error);

  // Eerst de gegevens van het concept vastleggen: faalt dat (bijvoorbeeld de
  // vervaldatum), dan staat er nog geen antwoord in de tijdlijn.
  const company = await loadCompanyForMail(admin, ctx.organizationId);
  const { error } = await admin.from('file_transfers').update({
    subject: cleanSubject(body.subject, `Bestanden bij ticket “${ticket.title}”`.slice(0, 200)),
    expires_at: expiry.iso,
    can_download: body.canDownload !== false,
    sender_name: ctx.user.email ? prettyNameFromEmail(ctx.user.email) : companyName(company),
  }).eq('id', transfer.id);
  if (error) throw error;

  const member = await must(admin.from('organization_members').select('email').eq('organization_id', ctx.organizationId).eq('user_id', ctx.user.id).maybeSingle()) as { email?: string } | null;
  const { data: note, error: noteError } = await admin.from('ticket_notes').insert({
    organization_id: ctx.organizationId,
    ticket_id: ticket.id,
    created_by: ctx.user.id,
    author_type: 'user',
    author_user_id: ctx.user.id,
    author_name: member?.email ?? ctx.user.email ?? null,
    body: text,
    is_internal: false,
  }).select('id').single();
  if (noteError) throw noteError;

  // Koppelen en versturen in één stap: lukt dat niet, dan gaat het antwoord weer weg.
  const { error: sentError } = await admin.from('file_transfers')
    .update({ ticket_note_id: (note as { id: string }).id, status: 'sent' })
    .eq('id', transfer.id);
  if (sentError) {
    await admin.from('ticket_notes').delete().eq('id', (note as { id: string }).id);
    throw sentError;
  }
  await recordTransferEvent(admin, { transferId: transfer.id, kind: 'sent', actorUserId: ctx.user.id, detail: 'bij ticketantwoord' });
  return { ...(await bundle(transfer.id)), noteId: (note as { id: string }).id };
}

// ── Opruimtaak (pg_cron → ?cron=purge) ────────────────────────────────

async function handleCron(req: Request): Promise<Response> {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ ok: false, error: 'Alleen POST.' }, 405);
  const secret = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || !timingSafeEqual(secret, CRON_SECRET)) return json({ ok: false, error: 'Geen toegang.' }, 401);

  try {
    const started = Date.now();
    let purged = 0;
    let failed = 0;
    // Een paar rondes per aanroep, binnen de tijd die een edge function heeft.
    for (let round = 0; round < 10 && Date.now() - started < 90_000; round += 1) {
      const { data, error } = await admin.rpc('file_transfer_purge_candidates', { p_limit: 200 });
      if (error) throw error;
      const rows = (data || []) as Array<{ item_id: string; organization_id: string; storage_key: string | null }>;
      if (rows.length === 0) break;
      const done: string[] = [];
      for (const row of rows) {
        if (row.storage_key) {
          try {
            await deleteStorageObject(row.organization_id, row.storage_key);
          } catch (err) {
            failed += 1;
            console.warn('file-transfer cron: verwijderen mislukte', err instanceof Error ? err.message : err);
            continue;
          }
        }
        done.push(row.item_id);
      }
      if (done.length === 0) break;
      const { data: count, error: markError } = await admin.rpc('file_transfer_mark_purged', { p_item_ids: done });
      if (markError) throw markError;
      purged += Number(count) || 0;
      if (rows.length < 200) break;
    }
    // Verwijzingen naar losse kopieën uit verwijderde rijen.
    const drained = await drainPurgeQueue(admin);
    return json({ ok: true, purged, failed, drained });
  } catch (error) {
    console.error('file-transfer cron error', error instanceof Error ? error.message : error);
    return json({ ok: false, error: 'Opruimen mislukte.' }, 500);
  }
}

async function drainPurgeQueue(client: SupabaseClient): Promise<number> {
  const { data, error } = await client
    .from('storage_purge_queue')
    .select('id,organization_id,storage_key,attempts,reason')
    .lt('attempts', 10)
    .lte('purge_after', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) {
    console.warn('storage_purge_queue overgeslagen', error.message);
    return 0;
  }
  let drained = 0;
  for (const row of (data || []) as Array<{ id: string; organization_id: string; storage_key: string; attempts: number; reason: string }>) {
    try {
      if (row.reason === 'file_transfer_pending') {
        // Een upload of kopie die "nog op te ruimen" stond: heeft hij intussen
        // toch een bestandsrij gekregen (en is het wegstrepen mislukt), dan
        // blijft het object staan en gaat alleen de regel weg.
        const { data: owner, error: ownerError } = await client
          .from('file_transfer_items')
          .select('id')
          .eq('organization_id', row.organization_id)
          .eq('storage_key', row.storage_key)
          .is('purged_at', null)
          .limit(1);
        if (ownerError) throw ownerError;
        if ((owner || []).length > 0) {
          await client.from('storage_purge_queue').delete().eq('id', row.id);
          continue;
        }
      }
      await deleteStorageObject(row.organization_id, row.storage_key);
      await client.from('storage_purge_queue').delete().eq('id', row.id);
      drained += 1;
    } catch (err) {
      await client.from('storage_purge_queue')
        .update({ attempts: row.attempts + 1, last_error: (err instanceof Error ? err.message : String(err)).slice(0, 300) })
        .eq('id', row.id);
    }
  }
  return drained;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

