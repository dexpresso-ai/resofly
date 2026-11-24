/**
 * Onder welke module valt een opname (meeting_recordings)?
 *
 *   - bij een afspraak:        Agenda   (calendar)
 *   - bij een telefoongesprek: Klanten  (clients, sinds 18 september)
 *   - bij een notitie:         Inhoud   (content, sinds 23 november)
 *
 * Gebruikt door meeting-transcribe (resolveModuleKey) voor de poort op elke
 * actie. De database leest met dezelfde regel (de module gate in
 * 20261123150000_opname_bij_notitie.sql), zodat de app en de API hetzelfde
 * doorlaten.
 *
 * Los van index.ts zodat de test hem kan laden: index.ts start bij het laden
 * een server en een Supabase-client.
 */

export type RecordingModule = 'clients' | 'calendar' | 'content';

/** De module van een bestaande opname, uit de rij zelf. Een onbekende rij valt onder Agenda, zoals altijd. */
export function recordingModule(row: { call_id?: string | null; note_id?: string | null } | null): RecordingModule {
  if (row?.note_id) return 'content';
  if (row?.call_id) return 'clients';
  return 'calendar';
}

/**
 * Een opname die nog niet bestaat: alleen dan telt wat de aanvraag zegt, en
 * alleen bij 'create' (de enige actie zonder recordingId) en 'budget' (dat
 * vóór 'create' komt en alleen het eigen tegoed laat zien). Bij elke andere
 * actie beslist de rij; zou de aanvraag daar meetellen, dan kon iemand met
 * alleen Inhoud een `noteId` meesturen naast de `recordingId` van een
 * afspraakopname en zo andermans notulen mailen of wissen.
 *
 * Een nieuwe notitie heeft bij 'budget' nog geen id: `forNote` zegt dan waar
 * het om gaat. Bij 'create' is het id verplicht; createRecording controleert
 * dat de notitie van deze organisatie is. Een gesprek én een notitie tegelijk
 * weigert createRecording; hier valt dat terug op Agenda, de strengste poort
 * die al gold.
 */
export function newRecordingModule(action: string, body: Record<string, unknown>): RecordingModule {
  if (action !== 'create' && action !== 'budget') return 'calendar';
  if (body.callId && body.noteId) return 'calendar';
  if (body.noteId || (action === 'budget' && body.forNote === true)) return 'content';
  if (body.callId) return 'clients';
  return 'calendar';
}
