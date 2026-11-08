// ============================================================
// Een antwoord van ElevenLabs Scribe omzetten naar onze vorm: tekst met
// sprekerlabels, segmenten met tijden, en de taal.
//
// Los van elevenlabs.ts (dat de API aanroept), zodat het zonder Deno en zonder
// netwerk te testen is (scribeTranscript.test.ts).
//
// Scribe levert een transcript op twee manieren af:
//   - synchroon, als antwoord op de aanvraag: { language_code, text, words, … };
//   - via de webhook: { type, data: { request_id, transcription: { … } } }.
// Tot 8 november las de webhook alleen `data` zelf. Volgens de documentatie
// van ElevenLabs zit het transcript daar een laag dieper, in
// `data.transcription`; dan bleef het transcript leeg en eindigde de opname in
// "Geen transcript om samen te vatten". Beide vormen werken nu.
// ============================================================

export interface TranscriptSegment { speaker: string | null; text: string; start: number | null; end: number | null }
export interface NormalizedTranscript { text: string; segments: TranscriptSegment[]; language: string | null }

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Het deel van het antwoord waar de tekst en de woorden in staan. */
function transcriptBody(payload: Json): Json {
  const data = isObject(payload.data) ? payload.data : null;
  if (data && isObject(data.transcription)) return data.transcription;
  if (isObject(payload.transcription)) return payload.transcription;
  return data ?? payload;
}

/**
 * Zet een Scribe-antwoord (synchroon óf uit de webhook) om naar onze vorm.
 * Opeenvolgende woorden van dezelfde spreker worden één segment.
 */
export function normalizeTranscript(payload: Json): NormalizedTranscript {
  const body = transcriptBody(payload);
  const language = (body.language_code ?? body.language ?? null) as string | null;
  const fullText = typeof body.text === 'string' ? body.text : '';

  const words = Array.isArray(body.words) ? body.words as Json[] : [];
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

/** Waar het laatste woord eindigt, in seconden (0 zonder tijden). */
export function transcriptEndSeconds(segments: readonly TranscriptSegment[] | null | undefined): number {
  let end = 0;
  for (const s of segments ?? []) {
    for (const t of [s.end, s.start]) {
      if (typeof t === 'number' && Number.isFinite(t) && t > end) end = t;
    }
  }
  return end;
}

/** Het request_id waaraan we een webhook koppelen, waar ElevenLabs het ook neerzet. */
export function scribeRequestId(payload: Json): string {
  const data = isObject(payload.data) ? payload.data : {};
  return String(payload.request_id ?? payload.requestId ?? data.request_id ?? data.requestId ?? '');
}

/**
 * Meldt deze webhook een mislukte transcriptie? Een fout komt als status, als
 * soort (`type`) of als foutmelding binnen. Zonder deze controle werd een
 * foutmelding als een leeg transcript opgeslagen.
 */
export function scribeFailed(payload: Json): boolean {
  const data = isObject(payload.data) ? payload.data : {};
  const status = String(payload.status ?? data.status ?? '').toLowerCase();
  if (status === 'error' || status === 'failed') return true;
  const type = String(payload.type ?? '').toLowerCase();
  if (type.includes('error') || type.includes('fail')) return true;
  const message = payload.error_message ?? data.error_message ?? payload.error ?? data.error;
  return typeof message === 'string' && message.trim().length > 0;
}

/** "speaker_0" / "0" -> "Spreker 1" (1-gebaseerd, leesbaar in het Nederlands). */
function speakerLabel(raw: string): string {
  const m = raw.match(/(\d+)/);
  if (m) return `Spreker ${Number(m[1]) + 1}`;
  return raw;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
