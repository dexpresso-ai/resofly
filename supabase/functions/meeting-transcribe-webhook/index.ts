// ============================================================
// meeting-transcribe-webhook — ontvangt het async transcript van ElevenLabs.
//
// ElevenLabs POST't hierheen wanneer een Scribe-transcriptie (gestart met
// webhook=true) klaar is. We verifiëren de HMAC-signatuur, koppelen op
// elevenlabs_request_id, slaan het transcript op en laten Claude de notulen maken.
//
// Dit endpoint is PUBLIEK (geen Supabase JWT) — zet verify_jwt = false in
// supabase/config.toml. De enige beveiliging is de HMAC-signatuur met
// ELEVENLABS_WEBHOOK_SECRET.
// ============================================================

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createAdminClient } from '../_shared/edgeAuth.ts';
import { normalizeTranscript, verifyWebhookSignature } from '../_shared/elevenlabs.ts';
import { runSummaryForRecording } from '../_shared/meetingPipeline.ts';

const admin = createAdminClient();

serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get('ElevenLabs-Signature') || req.headers.get('elevenlabs-signature');
  const valid = await verifyWebhookSignature(rawBody, signature);
  if (!valid) {
    console.warn('meeting-transcribe-webhook: ongeldige of ontbrekende signatuur.');
    return json({ ok: false, error: 'Ongeldige signatuur.' }, 401);
  }

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody) as Record<string, unknown>; }
  catch { return json({ ok: false, error: 'Ongeldige JSON.' }, 400); }

  const requestId = extractRequestId(payload);
  if (!requestId) return json({ ok: true, note: 'Geen request_id in payload — genegeerd.' }, 200);

  const { data: rec, error } = await admin.from('meeting_recordings')
    .select('id, status').eq('elevenlabs_request_id', requestId).maybeSingle();
  if (error) { console.error('webhook lookup mislukt:', error.message); return json({ ok: false }, 200); }
  if (!rec) return json({ ok: true, note: 'Geen opname voor dit request_id — genegeerd.' }, 200);

  // Mislukte transcriptie afgehandeld door ElevenLabs?
  const status = String(payload.status ?? (payload.data as Record<string, unknown> | undefined)?.status ?? 'ok');
  if (status === 'error' || status === 'failed') {
    await admin.from('meeting_recordings').update({ status: 'error', error_message: 'ElevenLabs meldde een transcriptiefout.' }).eq('id', rec.id);
    return json({ ok: true }, 200);
  }

  const transcript = normalizeTranscript(payload);
  await admin.from('meeting_recordings').update({
    transcript_text: transcript.text,
    transcript_json: transcript.segments,
    language: transcript.language,
    status: 'transcribed',
    error_message: null,
  }).eq('id', rec.id);

  // Notulen genereren (budget + opslag + usage-logging zit in de pijplijn).
  await runSummaryForRecording(admin, String(rec.id));

  return json({ ok: true }, 200);
});

function extractRequestId(payload: Record<string, unknown>): string {
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
  return String(payload.request_id ?? payload.requestId ?? data.request_id ?? data.requestId ?? '');
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
