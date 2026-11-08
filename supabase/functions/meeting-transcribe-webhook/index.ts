// ============================================================
// meeting-transcribe-webhook — ontvangt het async transcript van ElevenLabs.
//
// ElevenLabs POST't hierheen wanneer een Scribe-transcriptie (gestart met
// webhook=true) klaar is. We verifiëren de HMAC-signatuur, koppelen op
// elevenlabs_request_id, slaan het transcript op, rekenen de transcriptie af
// in ai_usage (telt mee in het AI-budget) en laten Claude de notulen maken
// (_shared/meetingPipeline.ts, dezelfde weg als de synchrone route).
//
// Dit endpoint is PUBLIEK (geen Supabase JWT) — zet verify_jwt = false in
// supabase/config.toml. De enige beveiliging is de HMAC-signatuur met
// ELEVENLABS_WEBHOOK_SECRET.
// ============================================================

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createAdminClient } from '../_shared/edgeAuth.ts';
import { normalizeTranscript, verifyWebhookSignature } from '../_shared/elevenlabs.ts';
import { completeTranscription } from '../_shared/meetingPipeline.ts';
import { scribeFailed, scribeRequestId } from '../_shared/scribeTranscript.ts';

const admin = createAdminClient();

// meeting-transcribe slaat het request_id op zodra ElevenLabs de aanvraag
// aanneemt. Een korte opname kan klaar zijn voordat die regel er staat; dan
// vond de webhook niets en bleef de opname eeuwig op "Transcriberen…". Daarom
// even opnieuw kijken voordat we opgeven.
const LOOKUP_ATTEMPTS = 4;
const LOOKUP_PAUSE_MS = 1500;

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

  const requestId = scribeRequestId(payload);
  if (!requestId) return json({ ok: true, note: 'Geen request_id in payload — genegeerd.' }, 200);

  let rec: { id: string; status: string } | null = null;
  for (let attempt = 1; attempt <= LOOKUP_ATTEMPTS; attempt++) {
    const { data, error } = await admin.from('meeting_recordings')
      .select('id, status').eq('elevenlabs_request_id', requestId).maybeSingle();
    if (error) { console.error('webhook lookup mislukt:', error.message); return json({ ok: false }, 200); }
    rec = data as { id: string; status: string } | null;
    if (rec || attempt === LOOKUP_ATTEMPTS) break;
    await new Promise((resolve) => setTimeout(resolve, LOOKUP_PAUSE_MS));
  }
  if (!rec) return json({ ok: true, note: 'Geen opname voor dit request_id — genegeerd.' }, 200);
  // Alleen een opname die nog op haar transcript wacht. Een herhaalde of nagekomen
  // webhook mag een al verwerkt (en misschien door de gebruiker gecorrigeerd)
  // transcript niet overschrijven en geen tweede notulenronde starten.
  if (rec.status !== 'transcribing') return json({ ok: true, note: 'Opname wacht niet (meer) op een transcript — genegeerd.' }, 200);

  // Mislukte transcriptie afgehandeld door ElevenLabs? Dan is er niets af te rekenen.
  if (scribeFailed(payload)) {
    await admin.from('meeting_recordings').update({ status: 'error', error_message: 'ElevenLabs meldde een transcriptiefout.' })
      .eq('id', rec.id).eq('status', 'transcribing');
    return json({ ok: true }, 200);
  }

  try {
    // Opslaan, afrekenen en notulen; voorwaardelijk op 'transcribing', zodat bij
    // twee gelijktijdige leveringen er één wint.
    const outcome = await completeTranscription(admin, String(rec.id), normalizeTranscript(payload));
    if (!outcome.stored) return json({ ok: true, note: 'Opname is intussen al verwerkt — genegeerd.' }, 200);
  } catch (e) {
    console.error('webhook opslaan mislukt:', e instanceof Error ? e.message : e);
    return json({ ok: false }, 200);
  }

  return json({ ok: true }, 200);
});

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
