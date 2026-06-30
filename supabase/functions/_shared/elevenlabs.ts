// ============================================================
// Gedeelde ElevenLabs Scribe-koppeling (spraak -> tekst).
//
// - requestTranscription(): stuurt audio naar Scribe. Als ELEVENLABS_WEBHOOK_SECRET
//   is gezet -> async (webhook=true, geeft request_id terug, ElevenLabs POST't het
//   resultaat later naar de in het dashboard ingestelde webhook). Anders -> synchroon
//   (parset het transcript direct; handig voor korte opnames / lokaal testen).
// - normalizeTranscript(): zet de Scribe-respons om naar { text, segments, language }
//   met sprekerlabels, voor opslag in meeting_recordings.
// ============================================================

import { HttpError } from './edgeAuth.ts';

const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY') || '';
const ELEVENLABS_STT_MODEL = Deno.env.get('ELEVENLABS_STT_MODEL') || 'scribe_v1';
const ELEVENLABS_LANGUAGE = Deno.env.get('ELEVENLABS_LANGUAGE') ?? 'nl'; // 'auto' of leeg = autodetectie
const ELEVENLABS_WEBHOOK_SECRET = Deno.env.get('ELEVENLABS_WEBHOOK_SECRET') || '';

export interface TranscriptSegment { speaker: string | null; text: string; start: number | null; end: number | null }
export interface NormalizedTranscript { text: string; segments: TranscriptSegment[]; language: string | null }

export function elevenlabsConfigured(): boolean {
  return Boolean(ELEVENLABS_API_KEY);
}
export function elevenlabsUsesWebhook(): boolean {
  return Boolean(ELEVENLABS_WEBHOOK_SECRET);
}

/**
 * Stuurt audio naar ElevenLabs Scribe.
 * - Webhook-modus: { requestId } (transcript volgt async via de webhook).
 * - Synchrone modus: { transcript } (direct geparset).
 */
export async function requestTranscription(
  bytes: Uint8Array,
  mime: string,
  filename: string,
): Promise<{ requestId: string | null; transcript: NormalizedTranscript | null }> {
  if (!ELEVENLABS_API_KEY) throw new HttpError('ELEVENLABS_API_KEY ontbreekt in de Edge Function secrets.', 500);

  const useWebhook = elevenlabsUsesWebhook();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime || 'audio/webm' }), filename || 'meeting.webm');
  form.append('model_id', ELEVENLABS_STT_MODEL);
  form.append('diarize', 'true');
  form.append('timestamps_granularity', 'word');
  if (ELEVENLABS_LANGUAGE && ELEVENLABS_LANGUAGE !== 'auto') form.append('language_code', ELEVENLABS_LANGUAGE);
  if (useWebhook) form.append('webhook', 'true');

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new HttpError(`ElevenLabs-transcriptie mislukt (${res.status}): ${detail.slice(0, 300)}`, 502);
  }

  const data = await res.json() as Record<string, unknown>;
  if (useWebhook) {
    const requestId = String(data.request_id ?? data.requestId ?? '');
    if (!requestId) throw new HttpError('ElevenLabs gaf geen request_id terug voor de webhook-modus.', 502);
    return { requestId, transcript: null };
  }
  return { requestId: null, transcript: normalizeTranscript(data) };
}

/**
 * Zet een Scribe-respons (synchroon óf uit de webhook) om naar onze vorm.
 * Accepteert zowel het kale transcript-object als een { data: {...} }-envelop.
 */
export function normalizeTranscript(payload: Record<string, unknown>): NormalizedTranscript {
  const body = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
  const language = (body.language_code ?? body.language ?? null) as string | null;
  const fullText = typeof body.text === 'string' ? body.text : '';

  const words = Array.isArray(body.words) ? body.words as Array<Record<string, unknown>> : [];
  const segments: TranscriptSegment[] = [];

  for (const w of words) {
    const type = String(w.type ?? 'word');
    if (type === 'spacing') continue; // pure spaties slaan we over voor de segmentopbouw
    const speakerRaw = w.speaker_id ?? w.speaker ?? null;
    const speaker = speakerRaw == null ? null : speakerLabel(String(speakerRaw));
    const token = String(w.text ?? '');
    const start = numOrNull(w.start);
    const end = numOrNull(w.end);

    const last = segments[segments.length - 1];
    if (last && last.speaker === speaker) {
      last.text += (token.startsWith(' ') || last.text.endsWith(' ') ? '' : ' ') + token.trim();
      last.end = end ?? last.end;
    } else {
      segments.push({ speaker, text: token.trim(), start, end });
    }
  }

  for (const s of segments) s.text = s.text.replace(/\s+/g, ' ').trim();
  const cleaned = segments.filter((s) => s.text.length > 0);

  // Tekstweergave: met sprekerlabels indien beschikbaar, anders de kale Scribe-tekst.
  const text = cleaned.length > 0 && cleaned.some((s) => s.speaker)
    ? cleaned.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n')
    : (fullText || cleaned.map((s) => s.text).join(' '));

  return { text: text.trim(), segments: cleaned, language };
}

/** "speaker_0" / "0" -> "Spreker 1" (1-gebaseerd, leesbaar in het Nederlands). */
function speakerLabel(raw: string): string {
  const m = raw.match(/(\d+)/);
  if (m) return `Spreker ${Number(m[1]) + 1}`;
  return raw;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Verifieert de HMAC-signatuur van een ElevenLabs-webhook (header `ElevenLabs-Signature`,
 * formaat `t=<unix>,v0=<hexhmac>` over `"<t>.<rawBody>"`). Geeft true bij een geldige match.
 */
export async function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!ELEVENLABS_WEBHOOK_SECRET) return false;
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(signatureHeader.split(',').map((p) => {
    const i = p.indexOf('=');
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const timestamp = parts['t'];
  const provided = parts['v0'];
  if (!timestamp || !provided) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(ELEVENLABS_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualHex(expected, provided);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
