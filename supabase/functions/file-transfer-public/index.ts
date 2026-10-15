import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { BRANDING_COLUMNS, sanitizeBranding, withoutNewestBrandingColumns } from '../_shared/branding.ts';
import { HttpError, createAdminClient, isUuid, makeCors, parseAllowedOrigins } from '../_shared/edgeAuth.ts';
import { renderEmailTemplate } from '../_shared/emailTemplates/index.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';
import {
  TRANSFER_CODE_TTL_SECONDS,
  TRANSFER_SESSION_TTL_SECONDS,
  codeHash,
  generateCode,
  isPlausibleToken,
  maskEmail,
  normalizeCode,
  randomToken,
  sha256Hex,
  transferStateMessage,
  transferZipName,
} from '../_shared/fileTransfer.ts';
import {
  RECIPIENT_COLUMNS,
  TransferStorageError,
  itemForRecipient,
  loadTransfer,
  loadTransferItems,
  recordTransferEvent,
  resolveTransferLink,
  sendViaResend,
  signedDownloadUrls,
  tagValue,
  transferIsOpen,
  type ResolvedLink,
  type TransferRecipientRow,
  type TransferRow,
} from '../_shared/fileTransferServer.ts';

// ============================================================
// ResoFly — Ontvangstpagina van een zending (file-transfer-public)
//
// Bedient /ontvang/<token>: de persoonlijke link uit de mail. Wie hem heeft,
// ziet eerst alleen van wie de bestanden komen en hoeveel het er zijn. Openen
// vraagt een code die naar het e-mailadres van de ontvanger gaat — zo werkt een
// doorgestuurde link niet voor een ander, en kan een linkscanner van een
// mailfilter niets openen (of als "geopend" laten tellen).
//
// Wie al op het klantportaal is ingelogd met hetzelfde adres, hoeft geen code:
// die sessie bewijst hetzelfde (actie `portalSession`).
//
// Beveiliging
// - De token staat niet in de database, alleen sha256(token). De link wordt bij
//   ELKE aanvraag opnieuw opgelost en getoetst (file_transfer_resolve): de
//   zending verstuurd en niet verlopen, de ontvanger niet ingetrokken en — bij
//   een klantzending — nog steeds het hoofdadres of een actieve contactpersoon
//   van díe klant.
// - De code: 6 cijfers, 10 minuten, één keer bruikbaar, 5 pogingen en dan een
//   kwartier dicht (file_transfer_check_code, met rij-lock); hooguit 5 codes per
//   uur per ontvanger (file_transfer_store_code).
// - Na de code een sessie van een uur, gebonden aan deze ontvanger (alleen de
//   hash in de database). Downloads gaan via kortlevende, getekende links van
//   de media-worker; de bytes komen nooit door deze functie.
// - Geen databaseteksten naar buiten: wat een bezoeker leest, staat hier.
// ============================================================

const admin = createAdminClient();
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';

const cors = makeCors(
  parseAllowedOrigins([
    Deno.env.get('FILE_TRANSFER_ALLOWED_ORIGINS'),
    Deno.env.get('FILE_SHARE_ALLOWED_ORIGINS'),
    Deno.env.get('APP_PUBLIC_URL'),
    Deno.env.get('CLIENT_PORTAL_ALLOWED_ORIGINS'),
  ]),
  // Net als de andere openbare functies: localhost alleen als je dat lokaal aanzet.
  (Deno.env.get('ALLOW_LOCAL_DEV') ?? '0') === '1',
);

class PublicError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });
  try {
    cors.assert(req);
    if (req.method !== 'POST') throw new PublicError('Alleen POST.', 405);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || 'get');
    const token = body.token;
    if (!isPlausibleToken(token)) throw new PublicError('Deze link is ongeldig.', 400);
    const tokenHash = await sha256Hex(token);

    switch (action) {
      case 'get': return cors.json(req, { ok: true, ...(await getTransfer(tokenHash, body)) });
      case 'requestCode': return cors.json(req, { ok: true, ...(await requestCode(tokenHash)) });
      case 'verifyCode': return cors.json(req, { ok: true, ...(await verifyCode(tokenHash, body)) });
      case 'portalSession': return cors.json(req, { ok: true, ...(await portalSession(tokenHash, body)) });
      case 'download': return cors.json(req, { ok: true, ...(await download(tokenHash, body)) });
      case 'read': return cors.json(req, { ok: true, ...(await readItem(tokenHash, body)) });
      case 'zip': return cors.json(req, { ok: true, ...(await zip(tokenHash, body)) });
      default: throw new PublicError(`Onbekende actie: ${action}`, 400);
    }
  } catch (error) {
    let status = 500;
    let message = 'De bestanden konden niet worden geopend. Probeer het later opnieuw.';
    if (error instanceof PublicError) { status = error.status; message = error.message; }
    else if (error instanceof HttpError) { status = error.status; message = error.message; }
    else if (error instanceof TransferStorageError) { status = error.status >= 500 ? 502 : error.status; message = error.status === 404 ? 'Dit bestand is niet meer beschikbaar.' : 'Het bestand kon niet worden klaargezet. Probeer het zo opnieuw.'; }
    if (status >= 500) console.error('file-transfer-public error', error instanceof Error ? error.message : error);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

// ── Gemeenschappelijk ─────────────────────────────────────────────────

type Opened = { link: ResolvedLink; transfer: TransferRow; recipient: TransferRecipientRow };

/** Lost de link op en eist dat hij nu te openen is. */
async function openLink(tokenHash: string): Promise<Opened> {
  const link = await resolveTransferLink(admin, tokenHash);
  if (!link) throw new PublicError(transferStateMessage('unknown'), 404);
  if (link.state !== 'active') throw new PublicError(transferStateMessage(link.state), 410);
  const transfer = await loadTransfer(admin, link.transferId, link.organizationId);
  if (!transfer || !transferIsOpen(transfer)) throw new PublicError(transferStateMessage('expired'), 410);
  const { data, error } = await admin
    .from('file_transfer_recipients')
    .select(RECIPIENT_COLUMNS)
    .eq('id', link.recipientId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PublicError(transferStateMessage('invalid'), 410);
  return { link, transfer, recipient: data as unknown as TransferRecipientRow };
}

/** Een geldige sessie voor precies deze ontvanger? */
async function hasSession(recipientId: string, raw: unknown): Promise<boolean> {
  if (!isPlausibleToken(raw)) return false;
  const { data, error } = await admin
    .from('file_transfer_sessions')
    .select('recipient_id,expires_at')
    .eq('token_hash', await sha256Hex(raw))
    .maybeSingle();
  if (error || !data) return false;
  const row = data as { recipient_id: string; expires_at: string };
  return row.recipient_id === recipientId && Date.parse(row.expires_at) > Date.now();
}

async function requireSession(opened: Opened, raw: unknown): Promise<void> {
  if (!(await hasSession(opened.recipient.id, raw))) {
    throw new PublicError('Je sessie is verlopen. Vraag een nieuwe code aan om de bestanden weer te openen.', 401);
  }
}

async function createSession(recipientId: string, organizationId: string): Promise<{ session: string; sessionExpiresAt: string }> {
  const session = randomToken();
  const expiresAt = new Date(Date.now() + TRANSFER_SESSION_TTL_SECONDS * 1000).toISOString();
  const { error } = await admin.from('file_transfer_sessions').insert({
    token_hash: await sha256Hex(session),
    recipient_id: recipientId,
    organization_id: organizationId,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return { session, sessionExpiresAt: expiresAt };
}

async function loadCompany(organizationId: string): Promise<Record<string, unknown> | null> {
  const query = (columns: string) => admin
    .from('company_settings')
    .select(columns)
    .eq('organization_id', organizationId)
    .maybeSingle();
  const columns = `email,phone,website,${BRANDING_COLUMNS},invoice_accent_color`;
  let { data, error } = await query(columns);
  // De nieuwste huisstijlkolommen bestaan pas na hun migratie; zonder blijft de
  // rest van de huisstijl staan.
  if (error) ({ data, error } = await query(withoutNewestBrandingColumns(columns)));
  if (error) {
    console.warn('file-transfer-public company_settings overgeslagen', error.message);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

function companyPayload(company: Record<string, unknown> | null) {
  return {
    name: (company?.trade_name as string | null) || (company?.company_name as string | null) || null,
    email: (company?.email as string | null) ?? null,
    phone: (company?.phone as string | null) ?? null,
    website: (company?.website as string | null) ?? null,
  };
}

// ── Acties ────────────────────────────────────────────────────────────

/**
 * Wat de pagina laat zien. Zonder geldige sessie: alleen afzender, aantal,
 * termijn en het gemaskeerde adres — geen onderwerp, geen bericht, geen
 * bestandsnamen. Met sessie: alles.
 */
async function getTransfer(tokenHash: string, body: Record<string, unknown>) {
  const link = await resolveTransferLink(admin, tokenHash);
  const company = link ? await loadCompany(link.organizationId) : null;
  if (!link || link.state !== 'active') {
    return {
      state: link?.state ?? 'unknown',
      message: transferStateMessage(link?.state ?? 'unknown'),
      company: companyPayload(company),
      branding: sanitizeBranding(company),
    };
  }
  const opened = await openLink(tokenHash);
  const verified = await hasSession(opened.recipient.id, body.session);
  const base = {
    state: 'active' as const,
    company: companyPayload(company),
    branding: sanitizeBranding(company),
    // De naam pas na de code: naam + domein maakt het adres vaak al te raden.
    recipient: { maskedEmail: maskEmail(opened.recipient.email), name: verified ? opened.recipient.name : null },
    fileCount: opened.transfer.item_count,
    totalBytes: opened.transfer.total_bytes,
    expiresAt: opened.transfer.expires_at,
    senderName: opened.transfer.sender_name,
    verified,
  };
  if (!verified) return base;
  const items = await loadTransferItems(admin, opened.transfer.id);
  return {
    ...base,
    subject: opened.transfer.subject,
    message: opened.transfer.message,
    canDownload: opened.transfer.can_download,
    sentAt: opened.transfer.sent_at,
    items: items.filter((item) => !item.purged_at).map((item) => itemForRecipient(item, opened.transfer.can_download)),
  };
}

const BLOCKED_MESSAGE = 'Er is te vaak een verkeerde code ingevuld, dus deze link is uit voorzorg dichtgezet. Vraag de afzender om de bestanden opnieuw te sturen.';

/** Hoe lang de link dicht is, in gewone woorden. */
function lockMessage(until: string | null): string {
  const minutes = Math.ceil(((Date.parse(String(until ?? '')) || 0) - Date.now()) / 60_000);
  if (minutes > 60) return 'Er is vandaag te vaak een verkeerde code ingevuld. Probeer het morgen opnieuw, of vraag de afzender om de bestanden opnieuw te sturen.';
  const wait = minutes <= 1 ? 'een minuut' : `${minutes} minuten`;
  return `Er is te vaak een verkeerde code ingevuld. Probeer het over ${wait} opnieuw met een nieuwe code.`;
}

async function lockedUntil(recipientId: string): Promise<string | null> {
  const { data } = await admin.from('file_transfer_codes').select('locked_until').eq('recipient_id', recipientId).maybeSingle();
  return ((data as { locked_until?: string | null } | null)?.locked_until) ?? null;
}

async function requestCode(tokenHash: string) {
  const opened = await openLink(tokenHash);
  const code = generateCode();
  const { data, error } = await admin.rpc('file_transfer_store_code', {
    p_recipient_id: opened.recipient.id,
    p_code_hash: await codeHash(opened.recipient.id, code),
    p_ttl_seconds: TRANSFER_CODE_TTL_SECONDS,
  });
  if (error) throw error;
  const status = String(data ?? '');
  if (status === 'blocked') throw new PublicError(BLOCKED_MESSAGE, 423);
  if (status === 'locked') throw new PublicError(lockMessage(await lockedUntil(opened.recipient.id)), 423);
  if (status === 'rate_limited') throw new PublicError('Je hebt het afgelopen uur al vijf codes aangevraagd. Gebruik de laatste code uit je mail, of probeer het later opnieuw.', 429);
  if (status !== 'ok') throw new PublicError(transferStateMessage('invalid'), 410);

  const company = await loadCompany(opened.transfer.organization_id);
  const sender = await resolveSenderIdentity(admin, opened.transfer.organization_id, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  if (!sender.from) throw new PublicError('De afzender kan op dit moment geen mail versturen. Neem contact op met de afzender.', 503);
  const rendered = renderEmailTemplate('file.transferCode', {
    code,
    companyName: companyPayload(company).name,
    accentColor: (company?.brand_accent_color as string | null) || (company?.invoice_accent_color as string | null) || null,
    validSeconds: TRANSFER_CODE_TTL_SECONDS,
  });
  const sent = await sendViaResend({
    from: sender.from,
    to: [opened.recipient.email],
    reply_to: sender.replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tags: [
      { name: 'organization_id', value: tagValue(opened.transfer.organization_id) },
      { name: 'template_key', value: 'file_transfer_code' },
      { name: 'transfer_id', value: tagValue(opened.transfer.id) },
    ],
  }, `file-transfer-code-${opened.recipient.id}-${Date.now()}`);
  if (!sent.ok) throw new PublicError('De code kon niet worden gemaild. Probeer het zo opnieuw.', 502);
  await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'code_sent' });
  return { sentTo: maskEmail(opened.recipient.email), validSeconds: TRANSFER_CODE_TTL_SECONDS };
}

async function verifyCode(tokenHash: string, body: Record<string, unknown>) {
  const opened = await openLink(tokenHash);
  const code = normalizeCode(body.code);
  if (!code) throw new PublicError('Vul de zes cijfers uit de mail in.', 400);
  const { data, error } = await admin.rpc('file_transfer_check_code', {
    p_recipient_id: opened.recipient.id,
    p_code_hash: await codeHash(opened.recipient.id, code),
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as { status?: string; attempts_left?: number; locked_until?: string | null } | undefined;
  switch (row?.status) {
    case 'ok': break;
    case 'wrong': {
      await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'code_failed' });
      const left = Number(row.attempts_left ?? 0);
      throw new PublicError(`Deze code klopt niet. Nog ${left} ${left === 1 ? 'poging' : 'pogingen'}.`, 400);
    }
    case 'locked': {
      const long = (Date.parse(String(row.locked_until ?? '')) || 0) - Date.now() > 60 * 60 * 1000;
      await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'code_locked', detail: long ? '24 uur dicht na te veel foute codes' : 'een kwartier dicht' });
      throw new PublicError(lockMessage(row.locked_until ?? null), 423);
    }
    case 'blocked':
      await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'code_locked', detail: 'link dicht na te veel foute codes; opnieuw versturen zet hem weer open' });
      throw new PublicError(BLOCKED_MESSAGE, 423);
    case 'expired':
      throw new PublicError('Deze code is verlopen. Vraag een nieuwe aan.', 400);
    default:
      throw new PublicError('Vraag eerst een code aan.', 400);
  }

  const session = await createSession(opened.recipient.id, opened.transfer.organization_id);
  await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'opened', detail: 'met e-mailcode' });
  return { ...session, ...(await getTransfer(tokenHash, { session: session.session })) };
}

/**
 * Al ingelogd op het klantportaal met hetzelfde adres? Dan is dat het bewijs:
 * geen code nodig. De portaalsessie wordt hier zelf geverifieerd, en het adres
 * moet exact dat van de ontvanger zijn.
 */
async function portalSession(tokenHash: string, body: Record<string, unknown>) {
  const opened = await openLink(tokenHash);
  if (opened.recipient.kind === 'email') throw new PublicError('Open de bestanden met een code.', 400);
  const accessToken = String(body.accessToken || '');
  if (!accessToken || accessToken.length > 4096) throw new PublicError('Geen portaalsessie.', 401);
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data.user?.email) throw new PublicError('Geen geldige portaalsessie.', 401);
  if (data.user.email.trim().toLowerCase() !== opened.recipient.email) {
    throw new PublicError('Je bent op het portaal ingelogd met een ander adres. Open de bestanden met een code.', 403);
  }
  const session = await createSession(opened.recipient.id, opened.transfer.organization_id);
  await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'opened', detail: 'via het klantportaal' });
  return { ...session, ...(await getTransfer(tokenHash, { session: session.session })) };
}

async function download(tokenHash: string, body: Record<string, unknown>) {
  const opened = await openLink(tokenHash);
  await requireSession(opened, body.session);
  if (!opened.transfer.can_download) throw new PublicError('De afzender heeft downloaden voor deze bestanden uitgezet.', 403);
  const itemId = String(body.itemId || '');
  if (!isUuid(itemId)) throw new PublicError('Ongeldig bestand.', 400);
  const items = await loadTransferItems(admin, opened.transfer.id);
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item || item.purged_at || !item.storage_key) throw new PublicError('Dit bestand hoort niet bij deze zending, of is niet meer beschikbaar.', 404);
  const inline = body.preview === true && /^image\/(jpeg|png|webp|gif|avif)$/i.test(item.mime_type);
  const urls = await signedDownloadUrls({
    organizationId: opened.transfer.organization_id,
    files: [{ key: item.storage_key, fileName: item.name }],
    transfer: { id: opened.transfer.id, recipientId: opened.recipient.id },
  });
  const url = urls.files[0]?.url;
  if (!url) throw new PublicError('Het bestand kon niet worden klaargezet.', 502);
  if (!inline) {
    await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'downloaded', itemId: item.id });
  }
  return { url: inline ? `${url}&inline=1` : url, fileName: item.name };
}

async function readItem(tokenHash: string, body: Record<string, unknown>) {
  const opened = await openLink(tokenHash);
  await requireSession(opened, body.session);
  const itemId = String(body.itemId || '');
  if (!isUuid(itemId)) throw new PublicError('Ongeldig item.', 400);
  const items = await loadTransferItems(admin, opened.transfer.id, true);
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item || item.purged_at || item.storage_key || item.html_snapshot == null) throw new PublicError('Dit item hoort niet bij deze zending.', 404);
  // Lezen is kijken, geen downloaden: dit telt als "geopend", niet als download.
  await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'opened', itemId: item.id, detail: 'gelezen' });
  return { title: item.name, html: item.html_snapshot };
}

async function zip(tokenHash: string, body: Record<string, unknown>) {
  const opened = await openLink(tokenHash);
  await requireSession(opened, body.session);
  if (!opened.transfer.can_download) throw new PublicError('De afzender heeft downloaden voor deze bestanden uitgezet.', 403);
  const urls = await signedDownloadUrls({
    organizationId: opened.transfer.organization_id,
    files: [],
    zip: { transferId: opened.transfer.id, fileName: transferZipName(opened.transfer.subject) },
    transfer: { id: opened.transfer.id, recipientId: opened.recipient.id },
  });
  if (!urls.zipUrl) throw new PublicError('De zip kon niet worden klaargezet.', 502);
  await recordTransferEvent(admin, { transferId: opened.transfer.id, recipientId: opened.recipient.id, kind: 'zip_downloaded' });
  return { url: urls.zipUrl };
}
