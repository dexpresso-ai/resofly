// ============================================================
// Gedeelde notulen-pijplijn voor een meeting_recordings-rij.
//
// Laadt het transcript, controleert het AI-budget van de eigenaar, vraagt Claude
// om gestructureerde notulen, slaat die op en logt het tokenverbruik in ai_usage.
// Hergebruikt door meeting-transcribe (synchroon + 'summarize') en de webhook.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { recordAiUsage, summarizeTranscript, userHasBudget } from './claudeSummary.ts';

export interface SummaryOutcome { summarized: boolean; reason?: 'no_transcript' | 'budget' | 'error'; message?: string }

export async function runSummaryForRecording(admin: SupabaseClient, recordingId: string): Promise<SummaryOutcome> {
  const { data: rec, error } = await admin.from('meeting_recordings')
    .select('id, organization_id, created_by, transcript_text, event_title_snapshot, client_id, project_id, language')
    .eq('id', recordingId).single();
  if (error || !rec) return { summarized: false, reason: 'error', message: error?.message };

  const transcript = String(rec.transcript_text ?? '').trim();
  if (!transcript) {
    await admin.from('meeting_recordings').update({ status: 'error', error_message: 'Geen transcript om samen te vatten.' }).eq('id', recordingId);
    return { summarized: false, reason: 'no_transcript' };
  }

  // Budget van de eigenaar (zelfde maandplafond als Gerrie).
  if (rec.created_by && !(await userHasBudget(admin, String(rec.created_by)))) {
    await admin.from('meeting_recordings').update({
      status: 'transcribed',
      error_message: 'AI-tegoed voor deze maand is op — transcript is klaar, notulen overgeslagen.',
    }).eq('id', recordingId);
    return { summarized: false, reason: 'budget' };
  }

  await admin.from('meeting_recordings').update({ status: 'summarizing', error_message: null }).eq('id', recordingId);

  // Klant/project-namen als context voor betere notulen.
  const [clientName, projectName] = await Promise.all([
    rec.client_id ? lookupName(admin, 'clients', String(rec.client_id)) : Promise.resolve(null),
    rec.project_id ? lookupName(admin, 'projects', String(rec.project_id)) : Promise.resolve(null),
  ]);

  try {
    const { summary, text, usage, model } = await summarizeTranscript(transcript, {
      title: rec.event_title_snapshot as string | null,
      clientName, projectName,
      language: rec.language as string | null,
    });
    await admin.from('meeting_recordings').update({
      summary_text: summary.samenvatting || text,
      summary_json: summary,
      status: 'done',
      error_message: null,
    }).eq('id', recordingId);
    await recordAiUsage(admin, String(rec.organization_id), rec.created_by ? String(rec.created_by) : null, model, usage);
    return { summarized: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Samenvatten mislukt.';
    await admin.from('meeting_recordings').update({ status: 'transcribed', error_message: message }).eq('id', recordingId);
    return { summarized: false, reason: 'error', message };
  }
}

async function lookupName(admin: SupabaseClient, table: 'clients' | 'projects', id: string): Promise<string | null> {
  const { data } = await admin.from(table).select('name').eq('id', id).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}
