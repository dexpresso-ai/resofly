// ============================================================
// Een meeting uit de agenda in Inhoud zetten: de map Meetings bij de klant
// (of onder Geen klant), de notitie "<titel> — <datum>" met de notulen, en de
// koppeling onder Notities bij de afspraak.
//
// Twee wegen komen hier samen:
//  - vanzelf, zodra het transcript binnen is (autoSaveMeetingToContent,
//    vanuit meetingPipeline.ts). Dat is de gewone weg sinds 24 november: tot
//    dan vroeg de opnamekaart erom, en die vraag kwam alleen als je de
//    afspraak open had toen het transcript binnenkwam. Liep het uitschrijven
//    op de achtergrond, dan stond de meeting nergens in Inhoud;
//  - met de knop "Opslaan in Inhoud" (meeting-transcribe, actie
//    saveToContent): voor een opname van vóór die tijd, of als iemand de
//    notitie in Inhoud heeft gewist.
//
// Alles loopt met de service-role, die RLS en de modulepoort overslaat. Dus
// staat overal de organisatie in de filter (CLAUDE.md, harde regel 1), en
// controleert de aanroeper de rechten: de knop die van wie klikt, de
// automatische weg die van wie de opname maakte (autoSaveRefusal).
//
// De tekst van de notitie, de titel en de regels voor "vanzelf" staan in
// meetingNote.ts (puur, met test).
// ============================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { HttpError } from './edgeAuth.ts';
import {
  autoSaveRefusal, MEETINGS_FOLDER_NAME, meetingDay, meetingNoteContent, meetingNoteTitle, validTime,
  type AutoSaveRefusal, type MeetingSummaryLike,
} from './meetingNote.ts';

export interface SavedMeeting { noteId: string; folderId: string | null; alreadySaved: boolean }

export type AutoSaveOutcome =
  | { saved: true; noteId: string; alreadySaved: boolean }
  | { saved: false; reason: AutoSaveRefusal | 'error'; message?: string };

interface RecordingForContent {
  id: string;
  created_by: string | null;
  call_id: string | null;
  note_id: string | null;
  client_id: string | null;
  provider: string | null;
  source_id: string | null;
  event_ref: string | null;
  event_title_snapshot: string | null;
  created_at: string;
  transcript_text: string | null;
  summary_json: MeetingSummaryLike | null;
  summary_text: string | null;
  content_note_id: string | null;
  save_to_content: boolean | null;
  meeting_date: string | null;
  event_starts_at: string | null;
  event_ends_at: string | null;
}

const RECORDING_COLUMNS = 'id, created_by, call_id, note_id, client_id, provider, source_id, event_ref, event_title_snapshot, created_at, '
  + 'transcript_text, summary_json, summary_text, content_note_id, save_to_content, meeting_date, event_starts_at, event_ends_at';

async function loadRecording(admin: SupabaseClient, organizationId: string, recordingId: string): Promise<RecordingForContent> {
  const { data, error } = await admin.from('meeting_recordings').select(RECORDING_COLUMNS)
    .eq('id', recordingId).eq('organization_id', organizationId).maybeSingle();
  if (error) throw new HttpError(`Opname laden mislukt: ${error.message}`, 500);
  if (!data) throw new HttpError('Opname niet gevonden in deze organisatie.', 404);
  return data as unknown as RecordingForContent;
}

/**
 * Zet de meeting in Inhoud, op naam van `userId`. De rechten van die persoon
 * heeft de aanroeper al gecontroleerd.
 *
 * `meetingDate`, `eventStartsAt` en `eventEndsAt` komen van de knop: een
 * opname van vóór 24 november kent de afspraak niet. Wat de opname zelf weet,
 * gaat voor; dat stond er toen de opname werd gemaakt.
 *
 * Twee keer vragen geeft geen tweede notitie: staat de meeting er al, dan
 * komt dezelfde notitie terug. Ook als de automatische weg en de knop
 * tegelijk lopen.
 */
export async function saveMeetingToContent(admin: SupabaseClient, input: {
  organizationId: string;
  recordingId: string;
  userId: string;
  meetingDate?: unknown;
  eventStartsAt?: unknown;
  eventEndsAt?: unknown;
}): Promise<SavedMeeting> {
  const { organizationId, recordingId, userId } = input;
  const rec = await loadRecording(admin, organizationId, recordingId);
  // Een notitie-opname staat al in Inhoud; een gesprek hoort bij het klantdossier.
  if (rec.note_id || rec.call_id) throw new HttpError('Alleen een meeting uit de agenda kan zo in Inhoud.', 400);
  if (!String(rec.transcript_text ?? '').trim()) throw new HttpError('Deze meeting is nog niet uitgeschreven.', 409);

  if (rec.content_note_id) {
    const existing = await noteInOrg(admin, organizationId, rec.content_note_id);
    if (existing) return { noteId: existing.id, folderId: existing.folder_id, alreadySaved: true };
  }

  const day = meetingDay(rec.meeting_date ?? input.meetingDate, rec.created_at);
  const folderId = await meetingsFolder(admin, organizationId, rec.client_id, userId);
  const { data: note, error: noteError } = await admin.from('notes').insert({
    organization_id: organizationId,
    created_by: userId,
    client_id: rec.client_id,
    // De map Meetings staat op klantniveau; een notitie met een project erin
    // viel in de verkenner onder die projectmap en niet in deze map.
    project_id: null,
    folder_id: folderId,
    title: meetingNoteTitle(rec.event_title_snapshot, day),
    content: meetingNoteContent(rec.summary_json, rec.summary_text),
    note_type: 'meeting',
    tags: [],
  }).select('id').single();
  if (noteError || !note) throw new HttpError(`Notitie aanmaken mislukt: ${noteError?.message ?? 'onbekende fout'}`, 500);

  // Voorwaardelijk op "nog niet opgeslagen": twee gelijktijdige pogingen maken
  // dan geen twee notities. Wie verliest, ruimt zijn notitie op en krijgt die
  // van de winnaar terug.
  const { data: claimed, error: claimError } = await admin.from('meeting_recordings')
    .update({ content_note_id: note.id })
    .eq('id', recordingId).eq('organization_id', organizationId).is('content_note_id', null)
    .select('id');
  if (claimError || !claimed?.length) {
    await admin.from('notes').delete().eq('id', note.id).eq('organization_id', organizationId);
    if (claimError) throw new HttpError(`Opslaan in Inhoud mislukt: ${claimError.message}`, 500);
    const { data: again } = await admin.from('meeting_recordings').select('content_note_id')
      .eq('id', recordingId).eq('organization_id', organizationId).maybeSingle();
    const winner = again?.content_note_id ? await noteInOrg(admin, organizationId, String(again.content_note_id)) : null;
    if (!winner) throw new HttpError('Opslaan in Inhoud mislukt. Probeer het opnieuw.', 409);
    return { noteId: winner.id, folderId: winner.folder_id, alreadySaved: true };
  }

  await linkNoteToEvent(admin, organizationId, String(note.id), userId, rec, {
    startsAt: rec.event_starts_at ?? validTime(input.eventStartsAt),
    endsAt: rec.event_ends_at ?? validTime(input.eventEndsAt),
  });
  return { noteId: String(note.id), folderId, alreadySaved: false };
}

/**
 * Het transcript is binnen: zet de meeting vanzelf in Inhoud, als dat bij het
 * opnemen is gevraagd (save_to_content) en de maker het nog mag
 * (autoSaveRefusal). Gooit nooit: het transcript en de notulen gaan voor, en
 * lukt dit niet, dan staat op de kaart de knop "Opslaan in Inhoud".
 */
export async function autoSaveMeetingToContent(admin: SupabaseClient, recordingId: string): Promise<AutoSaveOutcome> {
  try {
    const { data, error } = await admin.from('meeting_recordings')
      .select('organization_id, created_by, call_id, note_id, source_id, save_to_content')
      .eq('id', recordingId).maybeSingle();
    if (error || !data) return { saved: false, reason: 'error', message: error?.message ?? 'Opname niet gevonden.' };
    const organizationId = String(data.organization_id);
    const createdBy = data.created_by ? String(data.created_by) : null;
    if (!data.save_to_content) return { saved: false, reason: 'not_requested' };

    // Het lidmaatschap van de maker (actief) en de agenda van de afspraak.
    let member: { role?: string; module_access?: Record<string, unknown> } | null = null;
    if (createdBy) {
      const { data: rows, error: memberError } = await admin.from('organization_members').select('role, module_access')
        .eq('organization_id', organizationId).eq('user_id', createdBy).eq('status', 'active').limit(1);
      if (memberError) return { saved: false, reason: 'error', message: memberError.message };
      member = (rows?.[0] as { role?: string; module_access?: Record<string, unknown> } | undefined) ?? null;
    }
    let sourceVisibility: string | null = null;
    if (data.source_id) {
      const { data: source, error: sourceError } = await admin.from('calendar_sources').select('visibility')
        .eq('id', String(data.source_id)).eq('organization_id', organizationId).maybeSingle();
      if (sourceError) return { saved: false, reason: 'error', message: sourceError.message };
      sourceVisibility = (source as { visibility?: string } | null)?.visibility ?? null;
    }

    const refusal = autoSaveRefusal({
      saveToContent: data.save_to_content === true,
      callId: data.call_id ? String(data.call_id) : null,
      noteId: data.note_id ? String(data.note_id) : null,
      createdBy,
      member,
      sourceVisibility,
    });
    if (refusal) return { saved: false, reason: refusal };

    const saved = await saveMeetingToContent(admin, { organizationId, recordingId, userId: createdBy! });
    return { saved: true, noteId: saved.noteId, alreadySaved: saved.alreadySaved };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Opslaan in Inhoud mislukt.';
    console.warn('meeting vanzelf in Inhoud zetten mislukt:', message);
    return { saved: false, reason: 'error', message };
  }
}

async function noteInOrg(admin: SupabaseClient, organizationId: string, noteId: string): Promise<{ id: string; folder_id: string | null } | null> {
  const { data } = await admin.from('notes').select('id, folder_id').eq('id', noteId).eq('organization_id', organizationId).maybeSingle();
  return (data as { id: string; folder_id: string | null } | null) ?? null;
}

/**
 * De map Meetings bovenin bij de klant (of onder Geen klant). Bestaat hij al,
 * ook met een andere hoofdletter, dan die; anders een nieuwe, achteraan, zoals
 * de knop "Nieuwe map" hem zet.
 *
 * Sinds dit vanzelf gebeurt, kunnen twee meetings van dezelfde klant tegelijk
 * klaar zijn. Dan maakten ze elk een map Meetings. Daarom na het maken nog
 * eens kijken: de oudste map wint, en wie verloor, wist zijn eigen (nog lege)
 * map weer.
 */
async function meetingsFolder(admin: SupabaseClient, organizationId: string, clientId: string | null, userId: string): Promise<string> {
  const wanted = MEETINGS_FOLDER_NAME.toLowerCase();
  const oldest = async (): Promise<{ id: string; count: number }> => {
    let query = admin.from('content_folders').select('id, name')
      .eq('organization_id', organizationId).is('project_id', null).is('parent_id', null);
    query = clientId ? query.eq('client_id', clientId) : query.is('client_id', null);
    const { data: rows, error } = await query.order('created_at', { ascending: true }).order('id', { ascending: true });
    if (error) throw new HttpError(`Mappen laden mislukt: ${error.message}`, 500);
    const found = (rows ?? []).find((row) => String(row.name ?? '').trim().toLowerCase() === wanted);
    return { id: found ? String(found.id) : '', count: rows?.length ?? 0 };
  };
  const before = await oldest();
  if (before.id) return before.id;

  const { data: created, error: createError } = await admin.from('content_folders').insert({
    organization_id: organizationId,
    created_by: userId,
    client_id: clientId,
    project_id: null,
    parent_id: null,
    name: MEETINGS_FOLDER_NAME,
    position: before.count,
  }).select('id').single();
  if (createError || !created) throw new HttpError(`Map ${MEETINGS_FOLDER_NAME} aanmaken mislukt: ${createError?.message ?? 'onbekende fout'}`, 500);
  const mine = String(created.id);
  const after = await oldest();
  if (after.id && after.id !== mine) {
    await admin.from('content_folders').delete().eq('id', mine).eq('organization_id', organizationId);
    return after.id;
  }
  return mine;
}

/**
 * Hangt de notitie ook onder Notities bij de afspraak, zoals de oude knop
 * "Opslaan als notitie" deed. Een koppeling wijst een afspraak aan met zijn
 * agenda, id en begintijd; zonder begintijd (een oude opname via de knop
 * zonder afspraakgegevens) kan het niet.
 *
 * De database weigert een koppeling bij een privé-agenda of een afgeschermde
 * afspraak (enforce_note_calendar_links_integrity). Lukt het niet, dan staat
 * de meeting toch in Inhoud; de kaart bij de afspraak wijst er ook naartoe.
 */
async function linkNoteToEvent(
  admin: SupabaseClient, organizationId: string, noteId: string, userId: string,
  rec: RecordingForContent, event: { startsAt: string | null; endsAt: string | null },
): Promise<void> {
  if (!rec.provider || !rec.source_id || !rec.event_ref || !event.startsAt) return;
  const { error } = await admin.from('note_calendar_links').upsert({
    organization_id: organizationId,
    created_by: userId,
    note_id: noteId,
    provider: rec.provider,
    calendar_source_id: rec.source_id,
    provider_event_id: rec.event_ref,
    event_starts_at: event.startsAt,
    event_ends_at: event.endsAt,
    event_title_snapshot: rec.event_title_snapshot,
    visibility_snapshot: 'organization',
    is_private_masked_snapshot: false,
  }, { onConflict: 'organization_id,note_id,provider,calendar_source_id,provider_event_id,event_starts_at' });
  if (error) console.warn('meeting in Inhoud: koppelen aan de afspraak mislukt:', error.message);
}
