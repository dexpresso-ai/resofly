// ============================================================
// Gedeelde notulen-pijplijn voor een meeting_recordings-rij.
//
// completeTranscription(): slaat een binnengekomen transcript op, rekent de
// transcriptie af in ai_usage (transcriptionUsage.ts), zet een meeting uit de
// agenda in Inhoud (meetingInhoud.ts) en maakt de notulen.
// runSummaryForRecording(): laadt het transcript, controleert het AI-budget van
// de eigenaar, vraagt Claude om gestructureerde notulen, slaat die op en logt
// het tokenverbruik in ai_usage.
// Hergebruikt door meeting-transcribe (synchroon + 'summarize') en de webhook.
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { recordAiUsage, summarizeTranscript, userHasBudget } from './claudeSummary.ts';
import { autoSaveMeetingToContent, type AutoSaveOutcome } from './meetingInhoud.ts';
import { meetingNoteContent, NOTULEN_VOLGEN, type MeetingSummaryLike } from './meetingNote.ts';
import type { NormalizedTranscript } from './scribeTranscript.ts';
import { recordTranscriptionUsage, type RecordingForUsage } from './transcriptionUsage.ts';

export interface SummaryOutcome { summarized: boolean; reason?: 'no_transcript' | 'budget' | 'error' | 'busy'; message?: string }

export interface TranscriptionOutcome { stored: boolean; content?: AutoSaveOutcome; summary?: SummaryOutcome }

/**
 * Een transcript is binnen (synchroon of via de webhook): opslaan, afrekenen,
 * in Inhoud zetten, notulen maken. Alleen als de opname nog op haar transcript
 * wacht (status 'transcribing'): bij twee gelijktijdige leveringen wint er
 * één, en een nagekomen webhook overschrijft geen transcript dat al verwerkt
 * (en misschien al gecorrigeerd) is. De kosten gaan vóór de notulen in
 * ai_usage, zodat de budgetcontrole van de notulen ze al meetelt.
 *
 * Inhoud komt vóór de notulen: de meeting staat er dan zodra het transcript
 * er is, ook als de notulen moeten wachten (tegoed op) of de functie tijdens
 * het samenvatten stopt. De notitie zegt dan "De notulen zijn nog niet
 * gemaakt", en runSummaryForRecording vult ze in zodra ze er zijn.
 */
export async function completeTranscription(admin: SupabaseClient, recordingId: string, transcript: NormalizedTranscript): Promise<TranscriptionOutcome> {
  const { data: claimed, error } = await admin.from('meeting_recordings').update({
    transcript_text: transcript.text,
    transcript_json: transcript.segments,
    language: transcript.language,
    status: 'transcribed',
    error_message: null,
  }).eq('id', recordingId).eq('status', 'transcribing').select('id, organization_id, created_by, duration_seconds');
  if (error) throw new Error(`Transcript opslaan mislukt: ${error.message}`);
  const rec = (claimed ?? [])[0] as RecordingForUsage | undefined;
  if (!rec) return { stored: false };

  await recordTranscriptionUsage(admin, rec, transcript.segments);
  const content = await autoSaveMeetingToContent(admin, recordingId);
  return { stored: true, content, summary: await runSummaryForRecording(admin, recordingId) };
}

/**
 * `billTo`: wie de notulen betaalt. Na een transcriptie is dat de maker van de
 * opname (de standaard). Vraagt een collega later met de hand om nieuwe notulen
 * (meeting-transcribe 'summarize'), dan betaalt die collega: anders liep een
 * teamlid via de opnames van een ander diens maandtegoed leeg, en kwam hij zelf
 * om zijn eigen plafond heen.
 */
export async function runSummaryForRecording(
  admin: SupabaseClient, recordingId: string, { billTo }: { billTo?: string | null } = {},
): Promise<SummaryOutcome> {
  const { data: rec, error } = await admin.from('meeting_recordings')
    .select('id, organization_id, created_by, transcript_text, event_title_snapshot, client_id, project_id, language, summary_json, summary_text, content_note_id')
    .eq('id', recordingId).single();
  if (error || !rec) return { summarized: false, reason: 'error', message: error?.message };

  const transcript = String(rec.transcript_text ?? '').trim();
  if (!transcript) {
    await admin.from('meeting_recordings').update({ status: 'error', error_message: 'Geen transcript om samen te vatten.' }).eq('id', recordingId);
    return { summarized: false, reason: 'no_transcript' };
  }

  // Budget van wie betaalt (zelfde maandplafond als Gerrie).
  const payer = billTo !== undefined ? billTo : (rec.created_by ? String(rec.created_by) : null);
  if (!(await userHasBudget(admin, payer, String(rec.organization_id)))) {
    await admin.from('meeting_recordings').update({
      status: 'transcribed',
      error_message: 'AI-tegoed voor deze maand is op — transcript is klaar, notulen overgeslagen.',
    }).eq('id', recordingId);
    return { summarized: false, reason: 'budget' };
  }

  // Eén samenvatting tegelijk. Zonder deze voorwaarde startten parallelle
  // verzoeken elk een eigen Claude-aanroep, allemaal betaald. Een samenvatting
  // die al tien minuten "bezig" is, is nooit afgekomen (de functie werd
  // gestopt); die mag opnieuw, anders bleef de opname voorgoed op slot.
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: claimed } = await admin.from('meeting_recordings').update({ status: 'summarizing', error_message: null })
    .eq('id', recordingId).or(`status.neq.summarizing,updated_at.lt.${stale}`).select('id');
  if (!claimed?.length) return { summarized: false, reason: 'busy', message: 'Er wordt al een samenvatting gemaakt.' };

  // Klant/project-namen als context voor betere notulen.
  const [clientName, projectName] = await Promise.all([
    rec.client_id ? lookupName(admin, 'clients', String(rec.organization_id), String(rec.client_id)) : Promise.resolve(null),
    rec.project_id ? lookupName(admin, 'projects', String(rec.organization_id), String(rec.project_id)) : Promise.resolve(null),
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
    await recordAiUsage(admin, String(rec.organization_id), payer, model, usage);
    if (rec.content_note_id) {
      await refreshContentNote(admin, String(rec.organization_id), String(rec.content_note_id), [
        NOTULEN_VOLGEN,
        meetingNoteContent(rec.summary_json as MeetingSummaryLike | null, rec.summary_text as string | null),
      ], meetingNoteContent(summary));
    }
    return { summarized: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Samenvatten mislukt.';
    await admin.from('meeting_recordings').update({ status: 'transcribed', error_message: message }).eq('id', recordingId);
    return { summarized: false, reason: 'error', message };
  }
}

/**
 * Staat de meeting in Inhoud (content_note_id), dan krijgt die notitie de
 * nieuwe notulen. Maar alleen als er nog staat wat ResoFly er zelf in zette:
 * de tekst "notulen volgen" of de vorige notulen. Heeft iemand de notitie
 * bewerkt, dan is het zijn tekst en blijft die staan.
 *
 * Eerst lezen en vergelijken, dan schrijven op voorwaarde dat updated_at niet
 * veranderde: een filter op de hele tekst ging als query in de URL, en lange
 * notulen maakten die te lang. Mislukt het, dan blijven de notulen gewoon op
 * de opname staan; de notitie is een kopie.
 */
async function refreshContentNote(admin: SupabaseClient, organizationId: string, noteId: string, previous: string[], next: string): Promise<void> {
  const { data: note, error } = await admin.from('notes').select('content, updated_at')
    .eq('id', noteId).eq('organization_id', organizationId).maybeSingle();
  if (error || !note) return;
  const current = String(note.content ?? '');
  if (current === next || !previous.includes(current)) return;
  const { error: updateError } = await admin.from('notes').update({ content: next })
    .eq('id', noteId).eq('organization_id', organizationId).eq('updated_at', note.updated_at);
  if (updateError) console.warn('notulen in Inhoud bijwerken mislukt:', updateError.message);
}

async function lookupName(admin: SupabaseClient, table: 'clients' | 'projects', organizationId: string, id: string): Promise<string | null> {
  // Alleen namen uit de eigen organisatie als context naar Claude.
  const { data } = await admin.from(table).select('name').eq('id', id).eq('organization_id', organizationId).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}
