// ============================================================
// Inkoopfacturen per e-mail — de verwerking van één inbox-item.
//
// Een mail op het factuur-doorstuuradres is door mail-inbound al vastgelegd
// (purchase_invoice_inbox, status 'received') en de bijlagen staan op R2.
// Hier gebeurt de rest, in deze volgorde:
//
//   1. uitlezen      UBL-e-factuur exact (geen AI); PDF/foto via Claude
//   2. leverancier   herkennen (BTW-nr > IBAN > e-mail > naam), anders
//                    aanmaken (als de organisatie dat toestaat) of laten kiezen
//   3. dubbel?       zelfde factuurnummer bij dezelfde leverancier, of hetzelfde
//                    bestand al eerder verwerkt -> status 'duplicate', niets
//                    aangemaakt
//   4. klaarzetten   concept-inkoopfactuur + bijlagen als bewijsstuk
//   5. boeken        alleen als auto_book aanstaat én álle voorwaarden kloppen
//
// Twee aanroepers: mail-inbound (op de achtergrond, direct na ontvangst) en de
// invoice-inbox edge function (knoppen in het scherm: opnieuw verwerken,
// klaarzetten met een gekozen leverancier, toch klaarzetten bij een duplicaat).
//
// Principes:
// - Niets verdwijnt stil: elke uitkomst is een status met een reden op de rij.
// - AI-uitvoer is een kandidaat, geen waarheid: rekeningen en btw-codes worden
//   gevalideerd tegen de organisatie (invoiceProposal.ts), en geboekt wordt er
//   alleen onder de strengste voorwaarden.
// - De rij wordt eerst geclaimd (status 'processing'), zodat een tweede
//   verwerking van hetzelfde item nooit twee concepten oplevert.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { HttpError } from './edgeAuth.ts';
import { hasAnthropicKey, SUPPORTED_MIME_TYPES } from './claudeInvoice.ts';
import { userHasBudget } from './claudeSummary.ts';
import {
  buildAiProposal, buildAiProposalFromText, buildUblProposal, bytesToBase64, computePurchaseTotals,
  loadProposalContext,
  type InvoiceProposal, type ProposalContext, type ProposalResult, type SupplierMatchKind, type SupplierRow,
} from './invoiceProposal.ts';
import { looksLikeUblXml } from './ubl.ts';
import {
  autoBookEligible, isDocumentAttachment, isXmlFile, looksLikeInvoice, looksLikeInvoiceText, normEmail, normIban,
  normalizeDocumentMime, normNumber, purgeEligible, retryEligibility, safeFileName, sameInvoice,
  type InboxAttachmentKind,
} from './invoiceInboxRules.ts';

// De regels zelf staan in invoiceInboxRules.ts (import-vrij, met node-tests);
// hier opnieuw geëxporteerd zodat mail-inbound en invoice-inbox één ingang hebben.
export { autoBookEligible, isDocumentAttachment, looksLikeInvoice, looksLikeInvoiceText, normalizeDocumentMime, safeFileName, sameInvoice };
export type { InboxAttachmentKind };

// ── Types ───────────────────────────────────────────────────────────────────────

/**
 * Waarom een bijlage niet is uitgelezen. Bewust een apart veld naast `note`:
 * de routering las eerder de Nederlandse tekst van `note` ("bevat het woord
 * 'niet meegestuurd'"), en een bijlage die niet te decoderen viel werd dan
 * gemeld als "geen factuurbestand in de mail" — de gebruiker ging zijn
 * doorstuurregel nakijken terwijl het een transportfout was die een nieuwe
 * poging had opgelost. Tekst is om te lezen, dit veld is om op te beslissen.
 */
export type InboxAttachmentReason =
  | 'not_forwarded'   // de Email Worker stuurde de bytes niet mee
  | 'decode_failed'   // base64 kapot onderweg
  | 'upload_failed'   // R2 weigerde of was onbereikbaar
  | 'oversized'       // groter dan de limiet
  | 'too_many'        // meer bijlagen dan we uitlezen
  | 'unsupported'     // geen factuurbestandstype
  | 'copy';           // leesbare kopie naast een e-factuur

export interface InboxAttachment {
  name: string;
  mime_type: string;
  size_bytes: number;
  /** R2-sleutel; null als het bestand niet is opgeslagen (te groot, niet ondersteund). */
  storage_key: string | null;
  sha256: string | null;
  kind: InboxAttachmentKind;
  note?: string | null;
  /** Waarom deze bijlage niet is uitgelezen — voor de routering; `note` is voor de lezer. */
  reason?: InboxAttachmentReason | null;
}

export type InboxStatus =
  | 'received' | 'processing' | 'ready' | 'booked' | 'needs_review'
  | 'duplicate' | 'rejected' | 'failed' | 'dropped';

export interface InboxRow {
  id: string;
  organization_id: string;
  alias_id: string | null;
  parent_id: string | null;
  dedup_key: string;
  recipient: string;
  rfc_message_id: string | null;
  sender_email: string | null;
  sender_name: string | null;
  subject: string;
  body_excerpt: string | null;
  body_text: string | null;
  received_at: string;
  attachments: InboxAttachment[];
  status: InboxStatus;
  reason: string | null;
  error_message: string | null;
  method: 'ai' | 'ubl' | null;
  confidence: 'high' | 'medium' | 'low' | null;
  warnings: string[];
  proposal: InvoiceProposal | null;
  extraction_meta: Record<string, unknown> | null;
  supplier_id: string | null;
  supplier_match: string | null;
  supplier_created: boolean;
  purchase_invoice_id: string | null;
  duplicate_of_purchase_invoice_id: string | null;
  duplicate_of_inbox_id: string | null;
  auto_booked: boolean;
  attempts: number;
  processing_started_at: string | null;
  processed_at: string | null;
  handled_by: string | null;
  handled_at: string | null;
  purged_at: string | null;
  updated_at: string;
}

export interface InboxSettings {
  ai_enabled: boolean;
  auto_create_suppliers: boolean;
  auto_book: boolean;
}

export const DEFAULT_INBOX_SETTINGS: InboxSettings = { ai_enabled: true, auto_create_suppliers: true, auto_book: false };

export interface ProcessOptions {
  /** Dubbelcontrole overslaan ("Toch klaarzetten"); maakt ook een 'duplicate'-item opnieuw verwerkbaar. */
  allowDuplicate?: boolean;
  /** Het bewaarde voorstel hergebruiken in plaats van opnieuw uit te lezen. */
  useStoredProposal?: boolean;
  /** Leverancierkeuze uit het scherm. */
  supplierOverride?: { supplierId: string } | { createSupplier: true } | null;
  /** Wie de knop indrukte (null bij de automatische verwerking). */
  actorUserId?: string | null;
}

/** Fout met een machineleesbare reden, zodat de rij een zinnige status krijgt. */
export class InboxProcessingError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'InboxProcessingError';
    this.reason = reason;
  }
}

const MAX_DOCUMENTS_PER_MAIL = 5;
const STALE_PROCESSING_MINUTES = 10;

export const INBOX_COLUMNS =
  'id,organization_id,alias_id,parent_id,dedup_key,recipient,rfc_message_id,sender_email,sender_name,subject,body_excerpt,body_text,received_at,' +
  'attachments,status,reason,error_message,method,confidence,warnings,proposal,extraction_meta,supplier_id,supplier_match,supplier_created,' +
  'purchase_invoice_id,duplicate_of_purchase_invoice_id,duplicate_of_inbox_id,auto_booked,attempts,processing_started_at,processed_at,handled_by,handled_at,' +
  'purged_at,updated_at';

// ── Media-worker (R2) ───────────────────────────────────────────────────────────
// Zelfde terugval-namen als meeting-transcribe, zodat er meestal niets extra's
// geconfigureerd hoeft te worden.

export function mediaWorkerConfig(): { url: string; secret: string } | null {
  const url = (Deno.env.get('MEDIA_WORKER_URL') || Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') || Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') || '').replace(/\/$/, '');
  const secret = Deno.env.get('INTERNAL_UPLOAD_SECRET') || Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || Deno.env.get('QUOTE_PDF_STORAGE_SECRET') || '';
  if (!url || !secret) return null;
  return { url, secret };
}


export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Zet een bijlage op R2. Geeft de sleutel + hash terug; gooit bij een storingsfout. */
export async function storeInboxAttachment(
  organizationId: string,
  inboxId: string,
  file: { name: string; mimeType: string; bytes: Uint8Array },
): Promise<{ storage_key: string; sha256: string }> {
  const media = mediaWorkerConfig();
  if (!media) throw new InboxProcessingError('storage_unavailable', 'Media-worker niet geconfigureerd (MEDIA_WORKER_URL + INTERNAL_UPLOAD_SECRET).');
  const sha256 = await sha256Hex(file.bytes);
  const key = `${organizationId}/purchase_invoice_inbox/${inboxId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  const res = await fetch(`${media.url}/internal/media`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${media.secret}`,
      'Content-Type': file.mimeType || 'application/octet-stream',
      'X-Storage-Key': key,
      'X-SHA256': sha256,
      'X-Size-Bytes': String(file.bytes.byteLength),
    },
    body: file.bytes as unknown as BodyInit,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new InboxProcessingError('storage_failed', `Bijlage opslaan mislukt (${res.status}): ${detail.slice(0, 200)}`);
  }
  return { storage_key: key, sha256 };
}

export async function fetchStoredBytes(storageKey: string): Promise<Uint8Array> {
  const media = mediaWorkerConfig();
  if (!media) throw new InboxProcessingError('storage_unavailable', 'Media-worker niet geconfigureerd (MEDIA_WORKER_URL + INTERNAL_UPLOAD_SECRET).');
  const res = await fetch(`${media.url}/internal/media/${encodeURIComponent(storageKey)}`, {
    headers: { Authorization: `Bearer ${media.secret}` },
  });
  if (!res.ok) throw new InboxProcessingError('storage_failed', `Bijlage ophalen uit R2 mislukt (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Publieke download-URL zoals de frontend die ook op een bijlage zet (zelfde worker). */
function attachmentPublicUrl(storageKey: string): string | null {
  const media = mediaWorkerConfig();
  return media ? `${media.url}/file/${encodeURIComponent(storageKey)}` : null;
}

// ── Lezen ───────────────────────────────────────────────────────────────────────

export async function loadInboxRow(admin: SupabaseClient, inboxId: string): Promise<InboxRow | null> {
  const { data, error } = await admin.from('purchase_invoice_inbox').select(INBOX_COLUMNS).eq('id', inboxId).maybeSingle();
  if (error) throw new HttpError(`Inbox-item laden mislukt: ${error.message}`, 500);
  return data ? normalizeRow(data as unknown as Record<string, unknown>) : null;
}

export async function loadInboxSettings(admin: SupabaseClient, organizationId: string): Promise<InboxSettings> {
  const { data, error } = await admin.from('purchase_invoice_inbox_settings')
    .select('ai_enabled, auto_create_suppliers, auto_book')
    .eq('organization_id', organizationId).maybeSingle();
  if (error) {
    console.warn('inbox-instellingen laden mislukt, defaults gebruikt:', error.message);
    return { ...DEFAULT_INBOX_SETTINGS };
  }
  if (!data) return { ...DEFAULT_INBOX_SETTINGS };
  const row = data as Record<string, unknown>;
  return {
    ai_enabled: row.ai_enabled !== false,
    auto_create_suppliers: row.auto_create_suppliers !== false,
    auto_book: row.auto_book === true,
  };
}

function normalizeRow(raw: Record<string, unknown>): InboxRow {
  return {
    ...(raw as unknown as InboxRow),
    attachments: Array.isArray(raw.attachments) ? (raw.attachments as InboxAttachment[]) : [],
    warnings: Array.isArray(raw.warnings) ? (raw.warnings as string[]) : [],
    proposal: (raw.proposal && typeof raw.proposal === 'object') ? (raw.proposal as InvoiceProposal) : null,
    extraction_meta: (raw.extraction_meta && typeof raw.extraction_meta === 'object') ? (raw.extraction_meta as Record<string, unknown>) : null,
  };
}

async function updateRow(admin: SupabaseClient, inboxId: string, patch: Record<string, unknown>): Promise<InboxRow> {
  const { data, error } = await admin.from('purchase_invoice_inbox').update(patch).eq('id', inboxId).select(INBOX_COLUMNS).single();
  if (error) throw new HttpError(`Inbox-item bijwerken mislukt: ${error.message}`, 500);
  return normalizeRow(data as unknown as Record<string, unknown>);
}

// ── Verwerking ──────────────────────────────────────────────────────────────────

/**
 * Verwerkt één inbox-item van begin tot eind. Geeft de bijgewerkte rij terug;
 * een inhoudelijke uitkomst (dubbel, leverancier onbekend, mislukt) is een
 * STATUS op die rij, geen exception. Alleen "kan nu niet" (al bezig, bestaat
 * niet) gooit.
 */
export async function processInboxItem(admin: SupabaseClient, inboxId: string, opts: ProcessOptions = {}): Promise<InboxRow> {
  const row = await claimRow(admin, inboxId, opts);
  try {
    const result = await runPipeline(admin, row, opts);
    return result;
  } catch (err) {
    const reason = err instanceof InboxProcessingError ? err.reason : 'processing_error';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`invoice-inbox: verwerking van ${inboxId} mislukt (${reason}):`, message);
    return await updateRow(admin, inboxId, {
      status: 'failed', reason, error_message: message.slice(0, 1000), processed_at: new Date().toISOString(),
    });
  }
}

/** Claimt de rij atomair: wie 'processing' zet, verwerkt; de rest krijgt 409. */
async function claimRow(admin: SupabaseClient, inboxId: string, opts: ProcessOptions): Promise<InboxRow> {
  const current = await loadInboxRow(admin, inboxId);
  if (!current) throw new HttpError('Inbox-item niet gevonden.', 404);

  const claimable: InboxStatus[] = opts.allowDuplicate
    ? ['received', 'needs_review', 'duplicate', 'failed']
    : ['received', 'needs_review', 'failed'];
  // Een concept dat nog bestaat, verwerken we niet opnieuw: dat zou een tweede
  // concept opleveren. Is het concept weg (trigger zet dan needs_review), dan wel.
  if ((current.status === 'ready' || current.status === 'booked') && current.purchase_invoice_id) {
    throw new HttpError('Voor dit item is al een concept-inkoopfactuur klaargezet.', 409);
  }
  const stale = current.status === 'processing' && current.processing_started_at
    && (Date.now() - new Date(current.processing_started_at).getTime()) > STALE_PROCESSING_MINUTES * 60_000;
  if (!claimable.includes(current.status) && !stale && !(current.status === 'ready' && !current.purchase_invoice_id)) {
    if (current.status === 'processing') throw new HttpError('Dit item wordt op dit moment al verwerkt.', 409);
    throw new HttpError(`Dit item kan in status '${current.status}' niet (opnieuw) verwerkt worden.`, 409);
  }

  const { data, error } = await admin.from('purchase_invoice_inbox')
    .update({
      status: 'processing', processing_started_at: new Date().toISOString(),
      attempts: (current.attempts || 0) + 1, error_message: null,
      ...(opts.actorUserId ? { handled_by: opts.actorUserId, handled_at: new Date().toISOString() } : {}),
    })
    .eq('id', inboxId)
    .eq('status', current.status)
    .select(INBOX_COLUMNS);
  if (error) throw new HttpError(`Inbox-item claimen mislukt: ${error.message}`, 500);
  const claimed = Array.isArray(data) ? data[0] : null;
  if (!claimed) throw new HttpError('Dit item wordt op dit moment al verwerkt.', 409);
  return normalizeRow(claimed as unknown as Record<string, unknown>);
}

async function runPipeline(admin: SupabaseClient, row: InboxRow, opts: ProcessOptions): Promise<InboxRow> {
  const organizationId = row.organization_id;
  const [ctx, settings, budgetUserId] = await Promise.all([
    loadProposalContext(admin, organizationId),
    loadInboxSettings(admin, organizationId),
    resolveBudgetUser(admin, row, opts.actorUserId ?? null),
  ]);
  const env = { ctx, settings, budgetUserId, opts };

  // Klaarzetten op basis van het bewaarde voorstel (na een leverancierkeuze of
  // bij "Toch klaarzetten"): geen tweede AI-call.
  if (opts.useStoredProposal && row.proposal) {
    const stored: ProposalResult = {
      method: row.method ?? 'ai',
      proposal: row.proposal,
      extraction_meta: row.extraction_meta ?? {},
    };
    return await applyCandidate(admin, row, stored, env);
  }

  const documents = row.attachments.filter((a) => a.kind === 'document' && a.storage_key);
  if (documents.length === 0) return await processBodyText(admin, row, env);

  // Zit er een e-factuur (XML) bij, dan is die leidend; PDF's in dezelfde mail
  // zijn vrijwel altijd de leesbare kopie van diezelfde factuur en worden niet
  // apart (en dus niet dubbel) uitgelezen.
  const hasUbl = documents.some((a) => isXmlFile(a.name, a.mime_type));
  const toExtract = documents.filter((a) => !hasUbl || isXmlFile(a.name, a.mime_type)).slice(0, MAX_DOCUMENTS_PER_MAIL);
  const attachmentsPatch: InboxAttachment[] = row.attachments.map((a) => {
    if (a.kind !== 'document') return a;
    if (hasUbl && !isXmlFile(a.name, a.mime_type)) return { ...a, kind: 'copy', reason: 'copy', note: 'Kopie van de e-factuur; niet apart uitgelezen.' };
    if (!toExtract.includes(a)) return { ...a, kind: 'skipped', reason: 'too_many', note: 'Meer dan vijf bijlagen; deze is niet uitgelezen.' };
    return a;
  });

  const candidates: Array<{ attachment: InboxAttachment; result: ProposalResult }> = [];
  const errors: string[] = [];
  const skipped: Array<{ name: string; why: string }> = [];
  let aiBlocked: 'ai_disabled' | 'ai_unavailable' | 'budget_exhausted' | null = null;

  for (const att of toExtract) {
    const mime = normalizeDocumentMime(att.name, att.mime_type);
    let result: ProposalResult;
    try {
      // Bewust BINNEN de try: een hapering van R2 op bijlage twee mag de hele
      // mail niet afbreken. Deed hij dat wel, dan belandde het item op
      // 'failed/storage_failed' — en die reden staat niet in RETRYABLE_FAILED,
      // dus de opruimronde probeerde het nooit opnieuw en elke factuur uit die
      // mail was weg, terwijl de bytes gewoon in R2 stonden.
      const bytes = await fetchStoredBytes(att.storage_key!);
      if (isXmlFile(att.name, mime) || looksLikeUblXml(att.name, mime, decodeStart(bytes))) {
        result = await buildUblProposal(admin, organizationId, { fileName: att.name, xmlText: new TextDecoder('utf-8').decode(bytes) }, ctx);
      } else {
        if (!SUPPORTED_MIME_TYPES.includes(mime)) { skipped.push({ name: att.name, why: 'bestandstype niet ondersteund' }); continue; }
        if (!settings.ai_enabled) { aiBlocked = aiBlocked ?? 'ai_disabled'; continue; }
        if (!hasAnthropicKey()) { aiBlocked = aiBlocked ?? 'ai_unavailable'; continue; }
        if (budgetUserId && !(await userHasBudget(admin, budgetUserId))) { aiBlocked = aiBlocked ?? 'budget_exhausted'; continue; }
        result = await buildAiProposal(admin, organizationId, { fileName: att.name, mimeType: mime, dataBase64: bytesToBase64(bytes) }, ctx, { usageUserId: budgetUserId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`invoice-inbox: uitlezen van ${att.name} mislukt:`, message);
      errors.push(`${att.name}: ${message}`);
      continue;
    }
    if (!looksLikeInvoice(result.proposal)) {
      skipped.push({ name: att.name, why: 'geen factuurregels of bedrag herkend' });
      continue;
    }
    // Dezelfde factuur twee keer in één mail (bv. als PDF én foto): één keer.
    if (candidates.some((c) => sameInvoice(c.result.proposal, result.proposal))) {
      skipped.push({ name: att.name, why: 'zelfde factuur als een andere bijlage' });
      continue;
    }
    candidates.push({ attachment: att, result });
  }

  const log = { extracted: candidates.map((c) => c.attachment.name), skipped, errors, ai_blocked: aiBlocked };

  if (candidates.length === 0) {
    const status = errors.length && !aiBlocked ? 'failed' : 'needs_review';
    const reason = aiBlocked ?? (errors.length ? 'extraction_failed' : 'nothing_extracted');
    return await updateRow(admin, row.id, {
      status, reason,
      error_message: errors.length ? errors.join(' | ').slice(0, 1000) : null,
      attachments: attachmentsPatch,
      extraction_meta: { ...(row.extraction_meta ?? {}), inbox_log: log },
      processed_at: new Date().toISOString(),
    });
  }

  // Meerdere facturen in één mail: de eerste hoort bij deze rij, elke volgende
  // krijgt een eigen rij (met alleen haar eigen bijlage) zodat er per factuur
  // één concept ontstaat.
  const [first, ...rest] = candidates;
  const extraNames = new Set(rest.map((c) => c.attachment.name));
  const primaryAttachments = attachmentsPatch.filter((a) => !(a.kind === 'document' && extraNames.has(a.name)));
  const primary = await applyCandidate(admin, { ...row, attachments: primaryAttachments }, first.result, env, {
    attachments: primaryAttachments,
    extraction_meta_extra: { inbox_log: log, siblings: rest.length },
  });

  for (let i = 0; i < rest.length; i += 1) {
    const extra = rest[i];
    // De sleutel is bewust afleidbaar uit de mail zelf, zodat herverwerken
    // dezelfde rij terugvindt in plaats van een tweede aan te maken.
    const siblingKey = `${row.dedup_key}#${extra.attachment.sha256 ?? `n${i + 2}`}`;
    const { data, error } = await admin.from('purchase_invoice_inbox').insert({
      organization_id: organizationId, alias_id: row.alias_id, parent_id: row.id,
      dedup_key: siblingKey, recipient: row.recipient, rfc_message_id: row.rfc_message_id,
      sender_email: row.sender_email, sender_name: row.sender_name, subject: row.subject,
      body_excerpt: row.body_excerpt, received_at: row.received_at,
      attachments: [extra.attachment], status: 'processing', processing_started_at: new Date().toISOString(), attempts: 1,
    }).select(INBOX_COLUMNS).single();

    // Bestaat de rij al, dan is dit een HERVERWERKING van dezelfde mail (de
    // eerste ronde strandde bijvoorbeeld op een leeg AI-tegoed). Die rij
    // oppakken in plaats van hem overslaan: het oude gedrag logde de
    // unique-violation alleen naar de console en gaf de primaire factuur terug
    // alsof alles goed ging — factuur twee en drie bleven ondertussen op
    // 'processing' staan en niemand kreeg dat te zien.
    let sibling: InboxRow;
    if (error) {
      if (error.code !== '23505') {
        console.error('invoice-inbox: extra factuur uit dezelfde mail kon niet worden vastgelegd:', error.message);
        continue;
      }
      const { data: existing, error: findError } = await admin.from('purchase_invoice_inbox')
        .select(INBOX_COLUMNS)
        .eq('organization_id', organizationId).eq('dedup_key', siblingKey).maybeSingle();
      if (findError || !existing) {
        console.error('invoice-inbox: bestaande rij voor extra factuur niet gevonden:', findError?.message ?? siblingKey);
        continue;
      }
      sibling = normalizeRow(existing as unknown as Record<string, unknown>);
      await updateRow(admin, sibling.id, {
        status: 'processing', reason: null, error_message: null,
        processing_started_at: new Date().toISOString(), attempts: (sibling.attempts ?? 0) + 1,
      });
    } else {
      sibling = normalizeRow(data as unknown as Record<string, unknown>);
    }
    try {
      await applyCandidate(admin, sibling, extra.result, { ...env, opts: { ...opts, supplierOverride: null } }, { attachments: [extra.attachment] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateRow(admin, sibling.id, { status: 'failed', reason: 'processing_error', error_message: message.slice(0, 1000), processed_at: new Date().toISOString() });
    }
  }

  return primary;
}

interface PipelineEnv { ctx: ProposalContext; settings: InboxSettings; budgetUserId: string | null; opts: ProcessOptions }

/**
 * Van voorstel naar uitkomst: leverancier -> dubbelcontrole -> concept ->
 * eventueel boeken. Schrijft altijd een eindstatus op de rij.
 */
async function applyCandidate(
  admin: SupabaseClient,
  row: InboxRow,
  result: ProposalResult,
  env: PipelineEnv,
  extra: { attachments?: InboxAttachment[]; extraction_meta_extra?: Record<string, unknown> } = {},
): Promise<InboxRow> {
  const { ctx, settings, budgetUserId, opts } = env;
  const organizationId = row.organization_id;
  const proposal = result.proposal;
  const warnings = [...proposal.warnings];
  const now = new Date().toISOString();
  const base: Record<string, unknown> = {
    method: result.method, confidence: proposal.confidence, proposal,
    extraction_meta: { ...(result.extraction_meta ?? {}), ...(extra.extraction_meta_extra ?? {}) },
    ...(extra.attachments ? { attachments: extra.attachments } : {}),
  };

  // 1. Leverancier ─────────────────────────────────────────────────────────────
  const senderForMatch = await senderEmailForMatching(admin, organizationId, row.sender_email);
  let supplier: SupplierRow | null = null;
  let supplierMatch: SupplierMatchKind | 'manual' | 'created' | null = null;
  let supplierCreated = false;

  const override = opts.supplierOverride ?? null;
  if (override && 'supplierId' in override) {
    supplier = ctx.suppliers.find((s) => s.id === override.supplierId) ?? null;
    if (!supplier) throw new HttpError('De gekozen leverancier hoort niet bij deze organisatie.', 400);
    supplierMatch = 'manual';
  } else if (proposal.supplier.matchedId) {
    supplier = ctx.suppliers.find((s) => s.id === proposal.supplier.matchedId) ?? null;
    supplierMatch = supplier ? proposal.supplier.matchedBy : null;
  }
  if (!supplier && senderForMatch) {
    const hits = ctx.suppliers.filter((s) => normEmail(s.email) === senderForMatch);
    if (hits.length === 1) { supplier = hits[0]; supplierMatch = 'email'; }
  }
  if (!supplier) {
    const wantsCreate = (override && 'createSupplier' in override) || (settings.auto_create_suppliers && canAutoCreateSupplier(proposal));
    if (wantsCreate && proposal.supplier.name.trim()) {
      supplier = await createSupplier(admin, organizationId, proposal, senderForMatch, budgetUserId, row);
      ctx.suppliers.push(supplier);
      supplierMatch = 'created';
      supplierCreated = true;
    } else {
      return await updateRow(admin, row.id, {
        ...base, status: 'needs_review', reason: 'supplier_unknown', warnings,
        supplier_id: null, supplier_match: null, processed_at: now,
      });
    }
  }

  // Ander rekeningnummer dan we van deze leverancier kennen? Dan nooit vanzelf
  // boeken, en de controleur ziet het meteen.
  const invoiceIban = normIban(proposal.supplier.iban);
  const knownIban = normIban(supplier.iban);
  const ibanMismatch = Boolean(invoiceIban && knownIban && invoiceIban !== knownIban);
  if (ibanMismatch) {
    warnings.push(`Let op: het IBAN op deze factuur (${invoiceIban}) wijkt af van het IBAN dat bij ${supplier.name} bekend is (${knownIban}). Controleer dit bij de leverancier voordat je betaalt.`);
  }

  // 2. Dubbel? ─────────────────────────────────────────────────────────────────
  if (!opts.allowDuplicate) {
    const dup = await findDuplicate(admin, row, proposal, supplier.id, extra.attachments ?? row.attachments);
    if (dup) {
      return await updateRow(admin, row.id, {
        ...base, status: 'duplicate', reason: dup.reason, warnings,
        supplier_id: supplier.id, supplier_match: supplierMatch, supplier_created: supplierCreated,
        duplicate_of_purchase_invoice_id: dup.purchaseInvoiceId ?? null,
        duplicate_of_inbox_id: dup.inboxId ?? null,
        processed_at: now,
      });
    }
  }

  // 3. Concept klaarzetten ─────────────────────────────────────────────────────
  const fallbackAccountId = ctx.accounts.find((a) => a.code === '4500')?.id ?? null;
  const lines = proposal.lines
    .map((l) => ({
      id: crypto.randomUUID(),
      description: l.description || '',
      amount_cents: Math.round(Number(l.amount_cents) || 0),
      vat_code: l.vat_code,
      vat_rate: Number(l.vat_rate) || 0,
      account_id: l.account_id ?? supplier!.default_expense_account_id ?? null,
    }))
    .filter((l) => l.description.trim() || l.amount_cents);
  if (lines.length === 0) {
    return await updateRow(admin, row.id, {
      ...base, status: 'needs_review', reason: 'nothing_extracted', warnings,
      supplier_id: supplier.id, supplier_match: supplierMatch, supplier_created: supplierCreated, processed_at: now,
    });
  }
  const totals = computePurchaseTotals(lines, fallbackAccountId);
  const date = proposal.date ?? now.slice(0, 10);
  const { data: numberData, error: numberError } = await admin.rpc('next_purchase_invoice_number', {
    p_organization_id: organizationId, p_date: date,
  });
  if (numberError) throw new HttpError(`Intern nummer bepalen mislukt: ${numberError.message}`, 500);
  const internalNumber = String(numberData || '');

  const { data: created, error: insertError } = await admin.from('purchase_invoices').insert({
    organization_id: organizationId,
    created_by: budgetUserId,
    supplier_id: supplier.id,
    supplier_invoice_number: proposal.supplier_invoice_number || null,
    internal_number: internalNumber,
    date,
    due_date: proposal.due_date || null,
    lines,
    subtotal_cents: totals.subtotal_cents,
    vat_cents: totals.vat_cents,
    total_cents: totals.total_cents,
    currency: (proposal.currency || 'EUR').toUpperCase().slice(0, 3),
    status: 'draft',
    payment_status: 'unpaid',
    project_id: null,
    notes: proposal.notes || null,
    source: result.method === 'ubl' ? 'import' : 'ai_scan',
    extraction_meta: {
      ...(result.extraction_meta ?? {}),
      channel: 'email',
      inbox_id: row.id,
      sender_email: row.sender_email,
      subject: row.subject,
      received_at: row.received_at,
      warnings,
      confidence: proposal.confidence,
      supplier_match: supplierMatch,
    },
  }).select('id').single();
  if (insertError) throw new HttpError(`Concept-inkoopfactuur aanmaken mislukt: ${insertError.message}`, 500);
  const purchaseInvoiceId = String((created as { id: string }).id);

  // Bijlagen als bewijsstuk aan het concept hangen (best effort per bestand).
  for (const att of (extra.attachments ?? row.attachments)) {
    if (!att.storage_key) continue;
    const { error: attError } = await admin.from('attachments').insert({
      organization_id: organizationId, created_by: budgetUserId,
      entity_type: 'purchase_invoice', entity_id: purchaseInvoiceId, parent_task_id: null,
      name: att.name, mime_type: att.mime_type || 'application/octet-stream', size_bytes: att.size_bytes || 0,
      storage_key: att.storage_key, public_url: attachmentPublicUrl(att.storage_key),
    });
    if (attError) {
      console.warn('invoice-inbox: bijlage koppelen mislukt:', attError.message);
      warnings.push(`Bijlage ${att.name} kon niet aan het concept worden gekoppeld.`);
    }
  }

  // 4. Boeken? ─────────────────────────────────────────────────────────────────
  let status: InboxStatus = 'ready';
  let autoBooked = false;
  if (settings.auto_book) {
    const eligible = autoBookEligible({ supplierCreated, supplierMatch, confidence: proposal.confidence, warnings, lines, totals, ibanMismatch });
    if (eligible.ok) {
      const { error: bookError } = await admin.rpc('book_purchase_invoice', {
        p_organization_id: organizationId, p_purchase_invoice_id: purchaseInvoiceId, p_created_by: budgetUserId,
      });
      if (bookError) {
        warnings.push(`Automatisch boeken mislukt: ${bookError.message}. Het concept staat klaar om handmatig te boeken.`);
      } else {
        status = 'booked';
        autoBooked = true;
      }
    } else {
      warnings.push(`Niet automatisch geboekt: ${eligible.why}.`);
    }
  }

  return await updateRow(admin, row.id, {
    ...base, status, reason: null, error_message: null, warnings,
    supplier_id: supplier.id, supplier_match: supplierMatch, supplier_created: supplierCreated,
    purchase_invoice_id: purchaseInvoiceId, auto_booked: autoBooked,
    duplicate_of_purchase_invoice_id: null, duplicate_of_inbox_id: null,
    processed_at: now,
  });
}

/**
 * Geen factuurbestand in de mail: staat de factuur dan in de mailtekst zelf?
 * Alleen als de tekst er echt als een factuur uitziet (woorden én meerdere
 * bedragen) gaat hij naar de AI; de tekst wordt dan als bewijsstuk bewaard.
 */
async function processBodyText(admin: SupabaseClient, row: InboxRow, env: PipelineEnv): Promise<InboxRow> {
  const now = new Date().toISOString();
  const text = (row.body_text || row.body_excerpt || '').trim();
  if (!looksLikeInvoiceText(text)) {
    return await updateRow(admin, row.id, { status: 'needs_review', reason: 'no_attachment', processed_at: now });
  }
  const { ctx, settings, budgetUserId } = env;
  if (!settings.ai_enabled) return await updateRow(admin, row.id, { status: 'needs_review', reason: 'ai_disabled', processed_at: now });
  if (!hasAnthropicKey()) return await updateRow(admin, row.id, { status: 'needs_review', reason: 'ai_unavailable', processed_at: now });
  if (budgetUserId && !(await userHasBudget(admin, budgetUserId))) {
    return await updateRow(admin, row.id, { status: 'needs_review', reason: 'budget_exhausted', processed_at: now });
  }

  let result: ProposalResult;
  try {
    result = await buildAiProposalFromText(admin, row.organization_id, { text, label: 'mailtekst' }, ctx, { usageUserId: budgetUserId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await updateRow(admin, row.id, { status: 'failed', reason: 'extraction_failed', error_message: message.slice(0, 1000), processed_at: now });
  }
  if (!looksLikeInvoice(result.proposal)) {
    return await updateRow(admin, row.id, {
      status: 'needs_review', reason: 'nothing_extracted', proposal: result.proposal, method: 'ai',
      confidence: result.proposal.confidence, extraction_meta: { ...result.extraction_meta, inbox_log: { source: 'email_body' } },
      processed_at: now,
    });
  }

  // De mailtekst is hier het origineel: bewaren zoals een PDF (bewijsstuk).
  let attachments = row.attachments;
  try {
    const stored = await storeInboxAttachment(row.organization_id, row.id, {
      name: 'mailtekst.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode(text),
    });
    attachments = [...row.attachments, {
      name: 'mailtekst.txt', mime_type: 'text/plain', size_bytes: text.length,
      storage_key: stored.storage_key, sha256: stored.sha256, kind: 'body', note: 'De factuur stond in de mail zelf.',
    }];
  } catch (err) {
    console.warn('invoice-inbox: mailtekst als bewijsstuk opslaan mislukt:', err instanceof Error ? err.message : String(err));
  }

  return await applyCandidate(admin, { ...row, attachments }, result, env, {
    attachments, extraction_meta_extra: { inbox_log: { source: 'email_body' } },
  });
}

// ── De opruimronde (invoice-inbox?cron=sweep) ───────────────────────────────────

export interface SweepResult { checked: number; retried: Array<{ id: string; why: string; status: string }>; skipped: number; errors: string[] }

/**
 * Pakt items opnieuw op die door een STORING bleven liggen: nooit gestart,
 * blijven hangen, of mislukt terwijl de AI even niet beschikbaar was. Wat op
 * een mens wacht blijft liggen. Bewust een klein aantal per ronde: elke poging
 * kan seconden duren en de functie heeft een wandkloklimiet.
 */
export async function sweepInbox(admin: SupabaseClient, opts: { limit?: number } = {}): Promise<SweepResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const now = new Date();
  const { data, error } = await admin.from('purchase_invoice_inbox')
    .select('id, status, reason, attempts, processing_started_at, updated_at')
    .in('status', ['received', 'processing', 'failed', 'needs_review'])
    .order('updated_at', { ascending: true })
    .limit(200);
  if (error) throw new HttpError(`Opruimronde: items laden mislukt: ${error.message}`, 500);
  const rows = (data ?? []) as unknown as Array<{ id: string; status: string; reason: string | null; attempts: number; processing_started_at: string | null; updated_at: string }>;

  const result: SweepResult = { checked: rows.length, retried: [], skipped: 0, errors: [] };
  for (const row of rows) {
    if (result.retried.length >= limit) break;
    const verdict = retryEligibility(row, now);
    if (!verdict.retry) { result.skipped += 1; continue; }
    try {
      const done = await processInboxItem(admin, row.id, {});
      result.retried.push({ id: row.id, why: verdict.why, status: done.status });
    } catch (err) {
      result.errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

export interface PurgeResult { purged: number; deletedObjects: number; errors: string[] }

/**
 * Ruimt de R2-bestanden op van items die niets hebben opgeleverd (genegeerd,
 * weggegooid, dubbel) en dat al 30 resp. 90 dagen zijn. De rij blijft staan,
 * met de namen van de bijlagen; alleen de bytes gaan weg. Bewijsstukken van
 * een concept komen hier nooit langs (purchase_invoice_id is dan gevuld).
 */
export async function purgeInboxAttachments(admin: SupabaseClient, opts: { limit?: number } = {}): Promise<PurgeResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const now = new Date();
  const { data, error } = await admin.from('purchase_invoice_inbox')
    .select('id, status, purged_at, purchase_invoice_id, updated_at, attachments')
    .in('status', ['rejected', 'dropped', 'duplicate'])
    .is('purged_at', null)
    .is('purchase_invoice_id', null)
    .order('updated_at', { ascending: true })
    .limit(200);
  if (error) throw new HttpError(`Opruimronde: opruimkandidaten laden mislukt: ${error.message}`, 500);
  const rows = (data ?? []) as unknown as Array<{ id: string; status: string; purged_at: string | null; purchase_invoice_id: string | null; updated_at: string; attachments: InboxAttachment[] }>;

  const result: PurgeResult = { purged: 0, deletedObjects: 0, errors: [] };
  for (const row of rows) {
    if (result.purged >= limit) break;
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    if (!purgeEligible({ ...row, attachments }, now)) continue;
    try {
      const kept: InboxAttachment[] = [];
      for (const att of attachments) {
        if (att.storage_key) {
          await deleteStoredObject(att.storage_key);
          result.deletedObjects += 1;
          kept.push({ ...att, storage_key: null, note: `Opgeruimd op ${now.toISOString().slice(0, 10)}.` });
        } else {
          kept.push(att);
        }
      }
      await updateRow(admin, row.id, { attachments: kept, purged_at: now.toISOString() });
      result.purged += 1;
    } catch (err) {
      result.errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Verwijdert een object op R2 via de media-worker; een al verdwenen object telt als weg. */
async function deleteStoredObject(storageKey: string): Promise<void> {
  const media = mediaWorkerConfig();
  if (!media) throw new InboxProcessingError('storage_unavailable', 'Media-worker niet geconfigureerd (MEDIA_WORKER_URL + INTERNAL_UPLOAD_SECRET).');
  const res = await fetch(`${media.url}/internal/media/${encodeURIComponent(storageKey)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${media.secret}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new InboxProcessingError('storage_failed', `Bijlage verwijderen mislukt (${res.status}).`);
  }
}

// ── Bouwstenen ──────────────────────────────────────────────────────────────────

/** Wiens AI-tegoed draagt de automatische verwerking? De aanmaker van het adres. */
async function resolveBudgetUser(admin: SupabaseClient, row: InboxRow, actorUserId: string | null): Promise<string | null> {
  if (actorUserId) return actorUserId;
  if (!row.alias_id) return null;
  const { data } = await admin.from('organization_inbound_aliases').select('created_by').eq('id', row.alias_id).maybeSingle();
  const createdBy = (data as { created_by?: string | null } | null)?.created_by ?? null;
  return createdBy || null;
}

/**
 * Het afzenderadres is alleen bruikbaar voor leveranciersherkenning als het
 * niet van de organisatie zelf is: wie een factuur uit zijn eigen postvak
 * doorstuurt, is zelf de afzender.
 */
async function senderEmailForMatching(admin: SupabaseClient, organizationId: string, senderEmail: string | null): Promise<string | null> {
  const email = normEmail(senderEmail);
  if (!email.includes('@')) return null;
  const { data, error } = await admin.rpc('is_own_org_address', { p_organization_id: organizationId, p_email: email });
  if (error) { console.warn('is_own_org_address mislukt:', error.message); return null; }
  return data === true ? null : email;
}

function canAutoCreateSupplier(proposal: InvoiceProposal): boolean {
  if (!proposal.supplier.name.trim()) return false;
  if (proposal.confidence === 'low') return false;
  return true;
}

async function createSupplier(
  admin: SupabaseClient,
  organizationId: string,
  proposal: InvoiceProposal,
  senderEmail: string | null,
  createdBy: string | null,
  row: InboxRow,
): Promise<SupplierRow> {
  const s = proposal.supplier;
  const { data, error } = await admin.from('suppliers').insert({
    organization_id: organizationId,
    created_by: createdBy,
    name: s.name.trim().slice(0, 200),
    email: s.email || senderEmail || null,
    phone: s.phone,
    address_line1: s.address_line1,
    postal_code: s.postal_code,
    city: s.city,
    country: s.country,
    vat_number: s.vat_number,
    kvk_number: s.kvk_number,
    iban: s.iban,
    default_expense_account_id: s.default_expense_account_id,
    default_vat_code: s.default_vat_code,
    status: 'active',
    notes: `Automatisch aangemaakt uit een per e-mail ontvangen factuur (${new Date(row.received_at).toLocaleDateString('nl-NL')}${row.sender_email ? `, afzender ${row.sender_email}` : ''}).`,
  }).select('id, name, vat_number, iban, email, default_expense_account_id, default_vat_code').single();
  if (error) throw new HttpError(`Leverancier aanmaken mislukt: ${error.message}`, 500);
  return data as SupplierRow;
}

/**
 * Dubbel = zelfde leveranciersfactuurnummer bij dezelfde leverancier (niet
 * geannuleerd), of precies hetzelfde bestand dat al eerder tot een concept
 * leidde (iemand stuurt dezelfde mail nog eens door).
 */
async function findDuplicate(
  admin: SupabaseClient,
  row: InboxRow,
  proposal: InvoiceProposal,
  supplierId: string,
  attachments: InboxAttachment[],
): Promise<{ reason: 'duplicate_number' | 'duplicate_file'; purchaseInvoiceId?: string; inboxId?: string } | null> {
  const number = normNumber(proposal.supplier_invoice_number);
  if (number) {
    // Twee dingen die hier eerder misgingen, allebei met dezelfde uitkomst —
    // een tweede concept voor een factuur die al geboekt is, oftewel een
    // dubbele kostenboeking zonder waarschuwing:
    //
    // 1. Bij een queryfout werd de fout alleen gelogd en liep de code door
    //    alsof er geen duplicaat was. Een check die niet kán draaien, hoort
    //    NIET door te laten: hij gooit nu, en het item belandt op
    //    'processing_error' — een reden die de opruimronde wél opnieuw
    //    probeert.
    // 2. Er werd op de nieuwste 500 facturen gefilterd en pas daarna in de app
    //    vergeleken. Bij een leverancier met meer facturen viel het duplicaat
    //    stelselmatig buiten beeld. Vergelijken moet met genormaliseerde
    //    nummers (F-2026/0042 en F20260042 zijn hetzelfde), en dat kan
    //    PostgREST niet filteren — dus bladeren we erdoorheen.
    const PAGE = 500;
    const MAX_PAGES = 40; // 20.000 facturen van één leverancier
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const from = page * PAGE;
      const { data, error } = await admin.from('purchase_invoices')
        .select('id, supplier_invoice_number')
        .eq('organization_id', row.organization_id)
        .eq('supplier_id', supplierId)
        .neq('status', 'cancelled')
        .not('supplier_invoice_number', 'is', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        throw new InboxProcessingError('processing_error', `Duplicaatcontrole op factuurnummer kon niet draaien: ${error.message}`);
      }
      const rows = (data ?? []) as Array<{ id: string; supplier_invoice_number: string | null }>;
      const hit = rows.find((pi) => normNumber(pi.supplier_invoice_number) === number);
      if (hit) return { reason: 'duplicate_number', purchaseInvoiceId: String(hit.id) };
      if (rows.length < PAGE) break;
      if (page === MAX_PAGES - 1) {
        throw new InboxProcessingError('processing_error',
          'Deze leverancier heeft te veel facturen om de duplicaatcontrole af te maken; het item is niet automatisch klaargezet.');
      }
    }
  }

  const hashes = attachments.filter((a) => a.sha256 && a.kind !== 'other').map((a) => a.sha256!) ;
  for (const sha256 of hashes) {
    const { data, error } = await admin.from('purchase_invoice_inbox')
      .select('id, purchase_invoice_id')
      .eq('organization_id', row.organization_id)
      .neq('id', row.id)
      .in('status', ['ready', 'booked'])
      .contains('attachments', [{ sha256 }])
      .limit(1);
    if (error) {
      throw new InboxProcessingError('processing_error', `Duplicaatcontrole op bestand kon niet draaien: ${error.message}`);
    }
    const hit = (data ?? [])[0] as { id: string; purchase_invoice_id: string | null } | undefined;
    if (hit) return { reason: 'duplicate_file', inboxId: hit.id, purchaseInvoiceId: hit.purchase_invoice_id ?? undefined };
  }
  return null;
}




function decodeStart(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
  } catch {
    return '';
  }
}

// ── Schermacties ────────────────────────────────────────────────────────────────

const REJECTABLE: InboxStatus[] = ['received', 'needs_review', 'duplicate', 'failed'];

/** "Negeren": geen factuur, of niet van ons. De rij blijft bewaard. */
export async function rejectInboxItem(admin: SupabaseClient, row: InboxRow, actorUserId: string): Promise<InboxRow> {
  if (!REJECTABLE.includes(row.status)) {
    throw new HttpError(`Een item in status '${row.status}' kan niet genegeerd worden.`, 409);
  }
  return await updateRow(admin, row.id, {
    status: 'rejected', reason: 'dismissed_by_user', handled_by: actorUserId, handled_at: new Date().toISOString(),
  });
}

/** "Herstellen": terug op de werklijst en opnieuw verwerken. */
export async function restoreInboxItem(admin: SupabaseClient, row: InboxRow, actorUserId: string): Promise<InboxRow> {
  if (row.status !== 'rejected') throw new HttpError('Alleen een genegeerd item kan hersteld worden.', 409);
  await updateRow(admin, row.id, { status: 'received', reason: null, handled_by: actorUserId, handled_at: new Date().toISOString() });
  return await processInboxItem(admin, row.id, { actorUserId });
}

/** Verwerking op de achtergrond starten zonder het antwoord op te houden (Supabase EdgeRuntime). */
export function runInBackground(task: Promise<unknown>, label: string): Promise<void> {
  const wrapped = task.then(() => undefined, (err: unknown) => {
    console.error(`${label}: achtergrondverwerking mislukt`, err instanceof Error ? err.message : String(err));
  });
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === 'function') {
    runtime.waitUntil(wrapped);
    return Promise.resolve();
  }
  return wrapped;
}
