// ============================================================
// Transcriptie (ElevenLabs Scribe) telt mee in het AI-budget.
//
// Tot 8 november stonden de kosten van een transcriptie alleen op de opname
// zelf (meeting_recordings.transcription_cost_usd). Het maandbudget telt alleen
// ai_usage op (ai_usage_month_totals), dus wie geen AI-tegoed meer had, kon
// gewoon blijven transcriberen. En Instellingen → AI-gebruik liet die kosten
// niet zien. Nu:
//   - vóór de audio naar ElevenLabs gaat dezelfde budgetcontrole als bij Gerrie
//     en de notulen (aiBudget.ts): het tegoed van wie de opname maakte én dat
//     van de organisatie;
//   - na een gelukt transcript één rij in ai_usage, op naam van die persoon en
//     met de opname erbij. Hoogstens één per opname (unieke index, migratie
//     20261108171500): een herhaalde webhook belast het tegoed niet twee keer.
//
// De duur waarover we rekenen komt niet alleen van de browser. Die stuurde tot
// 8 november een verouderde waarde mee (meestal 0, of de duur van de vorige
// opname). Daardoor stonden opnames van 40 seconden op staging op $0. Nu telt
// de langste van wat de browser meldt en waar het laatste woord eindigt. Wie
// een te lage duur meestuurt, betaalt zo toch voor wat er gezegd is.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { aiBudgetMessage, checkAiBudget, type AiBudget } from './aiBudget.ts';
import { transcriptEndSeconds, type TranscriptSegment } from './scribeTranscript.ts';

/** Wat ElevenLabs per uur audio rekent als ELEVENLABS_USD_PER_HOUR ontbreekt. */
export const DEFAULT_SCRIBE_USD_PER_HOUR = 0.40;

function env(name: string): string | undefined {
  return (globalThis as { Deno?: { env: { get(n: string): string | undefined } } }).Deno?.env.get(name);
}

/** Het uurtarief: leeg of ongeldig = de standaard; "0" = gratis (een bewuste keuze). */
export function scribeUsdPerHour(raw: string | null | undefined = env('ELEVENLABS_USD_PER_HOUR')): number {
  const text = String(raw ?? '').trim();
  if (!text) return DEFAULT_SCRIBE_USD_PER_HOUR;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SCRIBE_USD_PER_HOUR;
}

/** Zo staat een transcriptie in ai_usage.model, naast de Claude-modellen. */
export function scribeUsageModel(raw: string | null | undefined = env('ELEVENLABS_STT_MODEL')): string {
  return `elevenlabs/${String(raw ?? '').trim() || 'scribe_v1'}`;
}

/** De seconden waarover we rekenen: de langste van wat de browser meldde en waar het transcript eindigt, naar boven afgerond. */
export function billableSeconds(reportedSeconds: number | null | undefined, segments: readonly TranscriptSegment[] | null | undefined): number {
  const reported = Number(reportedSeconds);
  const fromBrowser = Number.isFinite(reported) && reported > 0 ? reported : 0;
  return Math.ceil(Math.max(fromBrowser, transcriptEndSeconds(segments)));
}

/** Kosten in USD, op vier decimalen zoals ai_usage ze bewaart. */
export function transcriptionCostUsd(seconds: number, usdPerHour: number = scribeUsdPerHour()): number {
  if (!(seconds > 0) || !(usdPerHour > 0)) return 0;
  return Math.round((seconds / 3600) * usdPerHour * 10000) / 10000;
}

/**
 * Mag er een opname naar ElevenLabs? Dezelfde regel als overal (aiBudget.ts):
 * zolang er tegoed is mag de volgende aanroep, ook als die de grens nog iets
 * overschrijdt. Zonder maker (vertrokken teamlid) telt alleen de organisatie.
 */
export function transcriptionBudget(admin: SupabaseClient, userId: string | null, organizationId: string): Promise<AiBudget> {
  return checkAiBudget(admin, userId, organizationId);
}

/** De zin als het tegoed op is. De audio blijft bewaard, dus dat zeggen we erbij. */
export function transcriptionRefusal(budget: AiBudget): string {
  return `${aiBudgetMessage(budget)} De opname is bewaard: je kunt hem laten uitschrijven zodra er weer tegoed is.`;
}

export interface RecordingForUsage {
  id: string;
  organization_id: string;
  created_by: string | null;
  duration_seconds: number | null;
}

/**
 * Legt de kosten van één transcriptie vast: een rij in ai_usage (die telt mee
 * in het maandbudget en in Instellingen → AI-gebruik), en de duur en de kosten
 * op de opname. Een tweede keer voor dezelfde opname botst op de unieke index
 * en telt niet nog eens.
 */
export async function recordTranscriptionUsage(
  admin: SupabaseClient,
  rec: RecordingForUsage,
  segments: readonly TranscriptSegment[],
): Promise<{ seconds: number; costUsd: number; recorded: boolean }> {
  const seconds = billableSeconds(rec.duration_seconds, segments);
  const costUsd = transcriptionCostUsd(seconds);
  const { error } = await admin.from('ai_usage').insert({
    organization_id: rec.organization_id,
    user_id: rec.created_by,
    model: scribeUsageModel(),
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: costUsd,
    transcribed_recording_id: rec.id,
  });
  // 23505 = deze opname staat er al: dan is er al betaald, en dat is goed zo.
  if (error && error.code !== '23505') console.error('transcriptiekosten vastleggen mislukt:', error.message);

  const { error: updateError } = await admin.from('meeting_recordings')
    .update({ duration_seconds: seconds, transcription_cost_usd: costUsd })
    .eq('id', rec.id).eq('organization_id', rec.organization_id);
  if (updateError) console.error('duur en kosten op de opname bijwerken mislukt:', updateError.message);

  return { seconds, costUsd, recorded: !error };
}
