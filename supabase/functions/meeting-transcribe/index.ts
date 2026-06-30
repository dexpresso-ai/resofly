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

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import {
  HttpError, assertWriteRole, createAdminClient, isUuid, makeCors,
  parseAllowedOrigins, requireOrganizationAccess, requireUser,
  type HttpStatus, type OrganizationRole,
} from '../_shared/edgeAuth.ts';
import { elevenlabsConfigured, requestTranscription } from '../_shared/elevenlabs.ts';
import { runSummaryForRecording } from '../_shared/meetingPipeline.ts';

const admin = createAdminClient();

const ALLOWED_ORIGINS = parseAllowedOrigins([
  Deno.env.get('MEETING_ALLOWED_ORIGINS'), Deno.env.get('GERRIE_ALLOWED_ORIGINS'), Deno.env.get('APP_PUBLIC_URL'),
  Deno.env.get('INVOICE_ALLOWED_ORIGINS'), Deno.env.get('QUOTE_ALLOWED_ORIGINS'), Deno.env.get('BANK_ALLOWED_ORIGINS'),
]);
const ALLOW_LOCAL_DEV = (Deno.env.get('MEETING_ALLOW_LOCAL_DEV') || Deno.env.get('GERRIE_ALLOW_LOCAL_DEV') || 'false').toLowerCase() === 'true';
const cors = makeCors(ALLOWED_ORIGINS, ALLOW_LOCAL_DEV);

// ElevenLabs ~$0.40/uur audio — aparte meter, los van het AI-tokenbudget.
const ELEVENLABS_USD_PER_HOUR = Number(Deno.env.get('ELEVENLABS_USD_PER_HOUR') || '0.40');

serve(async (req) => {
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

/** Haalt de audiobytes server-side uit R2 via het interne worker-pad. */
async function fetchAudioBytes(storageKey: string): Promise<Uint8Array> {
  const base = (Deno.env.get('MEDIA_WORKER_URL') || '').replace(/\/$/, '');
  const secret = Deno.env.get('INTERNAL_UPLOAD_SECRET') || '';
  if (!base || !secret) throw new HttpError('Media-worker niet geconfigureerd (MEDIA_WORKER_URL / INTERNAL_UPLOAD_SECRET).', 500);
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
