import { supabase } from './supabase';
import { deleteR2Object, getAccessToken, getWorkerBase } from './r2-api';
import type { CalendarProvider, MeetingRecording, UUID } from '../types';

/**
 * Frontend-koppeling voor meeting-opnames: audio uploaden naar R2 (privé) en de
 * `meeting-transcribe` Edge Function aansturen (transcriptie + AI-notulen).
 */

export interface CreateRecordingInput {
  provider?: CalendarProvider | 'native' | null;
  sourceId?: UUID | null;
  eventRef?: string | null;
  eventTitle?: string | null;
  clientId?: UUID | null;
  projectId?: UUID | null;
}

async function invoke<T>(organizationId: UUID, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('meeting-transcribe', { body: { ...body, organizationId } });
  if (error) throw new Error(error.message || 'Opname-actie mislukt.');
  if (!data || data.ok !== true) throw new Error(data?.error ?? 'Opname-actie gaf geen geldig antwoord terug.');
  return data as T;
}

/** Maakt de opname-rij aan (legt AVG-toestemming vast). Geeft de recording-id terug. */
export async function createRecording(organizationId: UUID, input: CreateRecordingInput): Promise<UUID> {
  const data = await invoke<{ id: UUID }>(organizationId, { action: 'create', consentGiven: true, ...input });
  return data.id;
}

/** Uploadt het audiobestand privé naar R2 onder de meeting-opname en geeft de storage-key terug. */
export async function uploadMeetingAudio(file: File, organizationId: UUID, recordingId: UUID): Promise<string> {
  const base = getWorkerBase();
  const accessToken = await getAccessToken();
  const response = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'x-file-name': encodeURIComponent(file.name),
      'x-file-type': file.type || 'audio/webm',
      'x-organization-id': organizationId,
      'x-entity-type': 'meeting_recording',
      'x-entity-id': recordingId,
    },
    body: file,
  });
  const text = await response.text();
  let parsed: { ok?: boolean; key?: string; error?: string };
  try { parsed = JSON.parse(text); } catch { parsed = { error: text || response.statusText }; }
  if (!response.ok || !parsed.ok || !parsed.key) throw new Error(parsed.error || 'Audio-upload mislukt.');
  return parsed.key;
}

/** Start de transcriptie (en, in synchrone modus, meteen de notulen). */
export async function startTranscription(organizationId: UUID, params: {
  recordingId: UUID; storageKey: string; mimeType: string; sizeBytes: number; durationSeconds: number;
}): Promise<{ status: string }> {
  return invoke<{ status: string }>(organizationId, { action: 'start', ...params });
}

/** (Her)genereert de notulen uit het opgeslagen transcript. */
export async function summarizeRecording(organizationId: UUID, recordingId: UUID): Promise<void> {
  await invoke(organizationId, { action: 'summarize', recordingId });
}

/** Verwijdert opname + transcript + notulen (audio uit R2 én de databaserij). */
export async function deleteRecording(organizationId: UUID, recording: Pick<MeetingRecording, 'id' | 'storage_key'>): Promise<void> {
  if (recording.storage_key) await deleteR2Object(recording.storage_key).catch(() => undefined);
  await invoke(organizationId, { action: 'delete', recordingId: recording.id });
}

/** Haalt één opname op (RLS staat lezen toe aan org-leden). */
export async function getRecording(recordingId: UUID): Promise<MeetingRecording | null> {
  const { data, error } = await supabase.from('meeting_recordings').select('*').eq('id', recordingId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as MeetingRecording | null) ?? null;
}

/** Alle opnames die aan een agenda-item hangen (provider + event-referentie). */
export async function listRecordingsForEvent(organizationId: UUID, provider: string | null, eventRef: string | null): Promise<MeetingRecording[]> {
  let query = supabase.from('meeting_recordings').select('*')
    .eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (provider) query = query.eq('provider', provider);
  if (eventRef) query = query.eq('event_ref', eventRef);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as MeetingRecording[]) ?? [];
}

/**
 * True zodra er geen verdere statuswijziging meer komt. 'transcribed' is alleen
 * eindstatus als er een foutmelding bij staat (bv. AI-tegoed op) — anders volgt
 * de samenvatting nog (summarizing -> done).
 */
export function isTerminalStatus(rec: Pick<MeetingRecording, 'status' | 'error_message'>): boolean {
  if (rec.status === 'done' || rec.status === 'error') return true;
  if (rec.status === 'transcribed' && rec.error_message) return true;
  return false;
}
