// ============================================================
// meeting-transcribe — opname -> ElevenLabs Scribe -> Claude-notulen.
//
// Acties (alle POST, Supabase JWT + org-toegang):
//  - create    : maak een opname-rij aan (AVG-toestemming verplicht) -> { id }
//  - start     : koppel de R2-audio, stuur naar Scribe. Webhook-modus -> status
//                'transcribing' (transcript volgt async); synchrone modus ->
//                transcript + notulen meteen -> status 'done'.
//  - summarize : (her)genereer de notulen uit het opgeslagen transcript.
//  - delete    : verwijder de opname-rij (de R2-audio wist de frontend zelf).
//
// Beveiliging: organization_id komt uit de body maar wordt altijd tegen het
// lidmaatschap van de geverifieerde gebruiker gecontroleerd. Schrijven loopt via
// de service-role (RLS staat alleen lezen toe).
// ============================================================

import {
  HttpError, assertWriteRole, createAdminClient, isUuid, makeCors,
  parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus, type OrganizationRole,
} from '../_shared/edgeAuth.ts';
import { elevenlabsConfigured, requestTranscription } from '../_shared/elevenlabs.ts';
import { runSummaryForRecording } from '../_shared/meetingPipeline.ts';
import { resolveSenderIdentity } from '../_shared/sendingDomain.ts';

const admin = createAdminClient();

// Resend-secrets zijn projectbreed al gezet (klant-mail/offerte/factuur). Deze
// functie hergebruikt ze om de notulen naar de genodigden te mailen.
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') || '';
const RESEND_FROM_EMAIL = Deno.env.get('RESEND_FROM_EMAIL') || '';
const RESEND_REPLY_TO = Deno.env.get('RESEND_REPLY_TO') || '';
const MAX_SUMMARY_RECIPIENTS = 50;

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('MEETING_ALLOWED_ORIGINS'), Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('MEETING_ALLOW_LOCAL_DEV') || Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

// ElevenLabs ~$0.40/uur audio — aparte meter, los van het AI-tokenbudget.
const ELEVENLABS_USD_PER_HOUR = Number(Deno.env.get('ELEVENLABS_USD_PER_HOUR') || '0.40');

// Supabase Edge Runtime heeft een ingebouwde `Deno.serve` — geen deno.land/std
// nodig, wat het bundelen niet meer laat afhangen van een externe fetch.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors.headers(req) });
  try {
    if (req.method !== 'POST') throw new HttpError('Method not allowed.', 405 as HttpStatus);
    cors.assert(req);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action || '');
    const organizationId = String(body.organizationId || '');

    const user = await requireUser(admin, req);
    const role = await requireOrganizationAccess(admin, user.id, organizationId);

    switch (action) {
      case 'create': return cors.json(req, await createRecording(organizationId, user.id, role, body));
      case 'start': return cors.json(req, await startTranscription(organizationId, role, body));
      case 'summarize': return cors.json(req, await summarize(organizationId, role, body));
      case 'update': return cors.json(req, await updateRecording(organizationId, role, body));
      case 'sendSummary': return cors.json(req, await sendSummary(organizationId, role, body));
      case 'delete': return cors.json(req, await deleteRecording(organizationId, role, body));
      default: throw new HttpError(`Onbekende actie: ${action}`, 400);
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : 'Onbekende fout.';
    if (status >= 500) console.error('meeting-transcribe error:', message);
    return cors.json(req, { ok: false, error: message }, status);
  }
});

// ── Acties ───────────────────────────────────────────────────────────────────

async function createRecording(organizationId: string, userId: string, role: OrganizationRole, body: Record<string, unknown>) {
  assertWriteRole(role);
  if (body.consentGiven !== true) throw new HttpError('Toestemming voor opname is vereist.', 400);

  const provider = body.provider ? String(body.provider) : null;
  if (provider && !['google', 'microsoft', 'native'].includes(provider)) throw new HttpError('Ongeldige provider.', 400);
  const clientId = body.clientId ? String(body.clientId) : null;
  const projectId = body.projectId ? String(body.projectId) : null;
  if (clientId && !isUuid(clientId)) throw new HttpError('Ongeldige klant-id.', 400);
  if (projectId && !isUuid(projectId)) throw new HttpError('Ongeldige project-id.', 400);

  const { data, error } = await admin.from('meeting_recordings').insert({
    organization_id: organizationId,
    created_by: userId,
    provider,
    source_id: body.sourceId && isUuid(String(body.sourceId)) ? String(body.sourceId) : null,
    event_ref: body.eventRef ? String(body.eventRef).slice(0, 512) : null,
    event_title_snapshot: body.eventTitle ? String(body.eventTitle).slice(0, 300) : null,
    client_id: clientId,
    project_id: projectId,
    consent_given: true,
    consent_at: new Date().toISOString(),
    status: 'uploaded',
  }).select('id').single();
  if (error) throw new HttpError(`Opname aanmaken mislukt: ${error.message}`, 500);
  return { ok: true, id: data.id as string };
}

async function startTranscription(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  if (!elevenlabsConfigured()) throw new HttpError('Transcriptie is nog niet geconfigureerd (ELEVENLABS_API_KEY ontbreekt).', 500);

  const recordingId = String(body.recordingId || '');
  const storageKey = String(body.storageKey || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  if (!storageKey || !storageKey.startsWith(`${organizationId}/`)) throw new HttpError('Ongeldige storageKey.', 400);

  await loadRecording(organizationId, recordingId); // org-check (gooit bij onbekende opname)
  const durationSeconds = numOrNull(body.durationSeconds);
  const sizeBytes = numOrNull(body.sizeBytes);
  const mimeType = body.mimeType ? String(body.mimeType) : 'audio/webm';

  await admin.from('meeting_recordings').update({
    storage_key: storageKey, mime_type: mimeType, size_bytes: sizeBytes, duration_seconds: durationSeconds,
    status: 'transcribing', error_message: null,
    transcription_cost_usd: durationSeconds ? round4((durationSeconds / 3600) * ELEVENLABS_USD_PER_HOUR) : 0,
  }).eq('id', recordingId).eq('organization_id', organizationId);

  try {
    const bytes = await fetchAudioBytes(storageKey);
    const filename = storageKey.split('/').pop() || 'meeting.webm';
    const { requestId, transcript } = await requestTranscription(bytes, mimeType, filename);

    if (requestId) {
      // Async: het transcript volgt via de webhook.
      await admin.from('meeting_recordings').update({ elevenlabs_request_id: requestId }).eq('id', recordingId);
      return { ok: true, status: 'transcribing' };
    }

    // Synchroon: transcript meteen opslaan en daarna samenvatten.
    await admin.from('meeting_recordings').update({
      transcript_text: transcript!.text, transcript_json: transcript!.segments,
      language: transcript!.language, status: 'transcribed',
    }).eq('id', recordingId);
    const outcome = await runSummaryForRecording(admin, recordingId);
    return { ok: true, status: outcome.summarized ? 'done' : 'transcribed', summary: outcome };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Transcriptie mislukt.';
    await admin.from('meeting_recordings').update({ status: 'error', error_message: message }).eq('id', recordingId);
    throw e instanceof HttpError ? e : new HttpError(message, 502);
  }
}

async function summarize(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  await loadRecording(organizationId, recordingId); // org-check
  const outcome = await runSummaryForRecording(admin, recordingId);
  return { ok: true, summary: outcome };
}

/**
 * Werkt de (door de gebruiker gecorrigeerde) transcriptie bij. Zo kan de
 * app-gebruiker de tekst nog aanpassen voordat er notulen van gemaakt/verstuurd
 * worden. Notulen zelf worden bij het versturen ter plekke bewerkt (sendSummary).
 */
async function updateRecording(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  await loadRecording(organizationId, recordingId); // org-check

  const patch: Record<string, unknown> = {};
  if (typeof body.transcriptText === 'string') patch.transcript_text = body.transcriptText.slice(0, 200_000);
  if (typeof body.summaryText === 'string') patch.summary_text = body.summaryText.slice(0, 100_000);
  if (Object.keys(patch).length === 0) throw new HttpError('Niets om bij te werken.', 400);

  const { error } = await admin.from('meeting_recordings').update(patch)
    .eq('id', recordingId).eq('organization_id', organizationId);
  if (error) throw new HttpError(`Bijwerken mislukt: ${error.message}`, 500);
  return { ok: true };
}

/**
 * Mailt de notulen naar de genodigden. De frontend geeft de (bewerkbare)
 * ontvangerslijst + het (bewerkbare) onderwerp en de tekst mee — zo kan de
 * gebruiker de inhoud nog aanpassen alvorens door te sturen. Elke genodigde
 * krijgt een eigen mail (privacy: ontvangers zien elkaar niet).
 */
async function sendSummary(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  if (!RESEND_API_KEY) throw new HttpError('E-mailversturen is niet geconfigureerd (RESEND_API_KEY ontbreekt).', 500);

  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);

  const rec = await loadRecordingForMail(organizationId, recordingId);

  const subject = String(body.subject || '').trim().slice(0, 250)
    || `Samenvatting — ${rec.event_title_snapshot || 'afspraak'}`.slice(0, 250);
  const bodyText = String(body.bodyText || '').trim();
  if (!bodyText) throw new HttpError('De samenvatting heeft geen inhoud om te versturen.', 422);

  const includeTranscript = body.includeTranscript === true;
  const transcript = includeTranscript ? String(rec.transcript_text || '').trim() : '';

  // Ontvangers valideren + ontdubbelen (op lowercase e-mail) + begrenzen.
  const seen = new Set<string>();
  const recipients: { email: string; name: string | null }[] = [];
  for (const raw of Array.isArray(body.recipients) ? body.recipients : []) {
    const email = String((raw as Record<string, unknown>)?.email || '').trim().toLowerCase();
    if (!isEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const name = String((raw as Record<string, unknown>)?.name || '').trim();
    recipients.push({ email, name: name || null });
    if (recipients.length >= MAX_SUMMARY_RECIPIENTS) break;
  }
  if (recipients.length === 0) throw new HttpError('Geen geldige genodigden om naar te versturen.', 422);

  const company = await loadCompanyName(organizationId);
  const sender = await resolveSenderIdentity(admin, organizationId, RESEND_FROM_EMAIL, RESEND_REPLY_TO);
  if (!sender.from) throw new HttpError('Er is geen afzenderadres geconfigureerd (koppel een verzenddomein of zet RESEND_FROM_EMAIL).', 422);

  const html = buildSummaryEmailHtml({ organizationName: company, title: rec.event_title_snapshot, bodyText, transcript });
  const text = buildSummaryEmailText({ organizationName: company, title: rec.event_title_snapshot, bodyText, transcript });

  const nonce = crypto.randomUUID();
  const sent: { email: string; name: string | null }[] = [];
  const failed: { email: string; error: string }[] = [];
  for (const r of recipients) {
    try {
      await sendViaResend({
        from: sender.from,
        to: [r.email],
        reply_to: sender.replyTo || sender.fromEmail || undefined,
        subject,
        html,
        text,
      }, `meeting-summary-${recordingId}-${sanitizeKey(r.email)}-${nonce}`);
      sent.push(r);
    } catch (e) {
      failed.push({ email: r.email, error: e instanceof Error ? e.message : 'Versturen mislukt.' });
    }
  }

  if (sent.length === 0) throw new HttpError(`De notulen konden niet verstuurd worden: ${failed[0]?.error ?? 'onbekende fout'}`, 502);

  await admin.from('meeting_recordings').update({
    summary_sent_at: new Date().toISOString(),
    summary_recipients: sent,
  }).eq('id', recordingId).eq('organization_id', organizationId);

  return { ok: true, sent: sent.length, failed };
}

async function deleteRecording(organizationId: string, role: Awaited<ReturnType<typeof requireOrganizationAccess>>, body: Record<string, unknown>) {
  assertWriteRole(role);
  const recordingId = String(body.recordingId || '');
  if (!isUuid(recordingId)) throw new HttpError('Ongeldige recordingId.', 400);
  const { error } = await admin.from('meeting_recordings').delete().eq('id', recordingId).eq('organization_id', organizationId);
  if (error) throw new HttpError(`Opname verwijderen mislukt: ${error.message}`, 500);
  return { ok: true };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadRecording(organizationId: string, recordingId: string) {
  const { data, error } = await admin.from('meeting_recordings')
    .select('id, organization_id, status').eq('id', recordingId).eq('organization_id', organizationId).single();
  if (error || !data) throw new HttpError('Opname niet gevonden in deze organisatie.', 404);
  return data;
}

async function loadRecordingForMail(organizationId: string, recordingId: string) {
  const { data, error } = await admin.from('meeting_recordings')
    .select('id, event_title_snapshot, transcript_text')
    .eq('id', recordingId).eq('organization_id', organizationId).single();
  if (error || !data) throw new HttpError('Opname niet gevonden in deze organisatie.', 404);
  return data as { id: string; event_title_snapshot: string | null; transcript_text: string | null };
}

async function loadCompanyName(organizationId: string): Promise<string> {
  const [{ data: company }, { data: org }] = await Promise.all([
    admin.from('company_settings').select('company_name, trade_name').eq('organization_id', organizationId).maybeSingle(),
    admin.from('organizations').select('name').eq('id', organizationId).maybeSingle(),
  ]);
  return String(company?.trade_name || company?.company_name || org?.name || 'ResoFly');
}

// ── E-mail (Resend) ────────────────────────────────────────────────────────────

async function sendViaResend(payload: Record<string, unknown>, idempotencyKey: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error(String(detail.message || detail.error || res.statusText || 'Resend send failed'));
  }
}

function buildSummaryEmailHtml(input: { organizationName: string; title: string | null; bodyText: string; transcript: string }): string {
  const org = escapeHtml(input.organizationName);
  const heading = escapeHtml(input.title ? `Samenvatting — ${input.title}` : 'Samenvatting van de afspraak');
  const bodyHtml = escapeHtml(input.bodyText).replace(/\n/g, '<br/>');
  const transcriptBlock = input.transcript
    ? `<div style="margin-top:22px;border-top:1px solid #e4e4e7;padding-top:16px;">
         <p style="margin:0 0 8px;font-size:13px;color:#71717a;text-transform:uppercase;letter-spacing:.06em;">Transcript</p>
         <div style="white-space:pre-wrap;font-size:13px;line-height:1.6;color:#3f3f46;">${escapeHtml(input.transcript)}</div>
       </div>`
    : '';
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
    <div style="max-width:640px;margin:0 auto;padding:28px 20px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:28px;line-height:1.6;font-size:15px;">
        <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827;">${heading}</h1>
        <div>${bodyHtml}</div>
        ${transcriptBlock}
      </div>
      <p style="margin:14px 4px 0;color:#8a8a92;font-size:12px;line-height:1.5;">Verstuurd door ${org} via ResoFly.</p>
    </div>
  </body>
</html>`;
}

function buildSummaryEmailText(input: { organizationName: string; title: string | null; bodyText: string; transcript: string }): string {
  const lines = [
    input.title ? `Samenvatting — ${input.title}` : 'Samenvatting van de afspraak',
    '',
    input.bodyText,
  ];
  if (input.transcript) lines.push('', '— Transcript —', '', input.transcript);
  lines.push('', `Verstuurd door ${input.organizationName} via ResoFly.`);
  return lines.join('\n');
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'x';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c] || c));
}

/**
 * Haalt de audiobytes server-side uit R2 via het interne worker-pad.
 * URL en secret vallen terug op de al-geconfigureerde PDF-storage-namen, zodat
 * deze functie dezelfde worker + hetzelfde gedeelde secret hergebruikt zonder
 * dat er een aparte INTERNAL_UPLOAD_SECRET op de edge-kant gezet hoeft te worden.
 */
async function fetchAudioBytes(storageKey: string): Promise<Uint8Array> {
  const base = (Deno.env.get('MEDIA_WORKER_URL') || Deno.env.get('INVOICE_PDF_STORAGE_WORKER_URL') || Deno.env.get('QUOTE_PDF_STORAGE_WORKER_URL') || '').replace(/\/$/, '');
  const secret = Deno.env.get('INTERNAL_UPLOAD_SECRET') || Deno.env.get('INVOICE_PDF_STORAGE_SECRET') || Deno.env.get('QUOTE_PDF_STORAGE_SECRET') || '';
  if (!base || !secret) throw new HttpError('Media-worker niet geconfigureerd (zet MEDIA_WORKER_URL + INTERNAL_UPLOAD_SECRET, of hergebruik de PDF-storage-secrets).', 500);
  const res = await fetch(`${base}/internal/media/${encodeURIComponent(storageKey)}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new HttpError(`Audio ophalen uit R2 mislukt (${res.status}).`, 502);
  return new Uint8Array(await res.arrayBuffer());
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
