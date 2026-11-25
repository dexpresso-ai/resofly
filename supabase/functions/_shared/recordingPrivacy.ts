/**
 * Wie mag een opname zien? (sinds 25 november)
 *
 * Een afspraakopname zie je als hij komt uit een agenda die je kunt lezen (je
 * eigen, of een met het team gedeelde), als je hem zelf maakte, of als hij al
 * in de gedeelde Inhoud staat (content_note_id). Een telefoongesprek en een
 * notitie-opname horen niet bij een agenda: die zijn er voor iedereen met de
 * module. Zonder agenda (de agenda is verwijderd) ziet alleen de maker hem.
 *
 * Dezelfde regel staat in de database (de policy "prive agenda select" en
 * meeting_recording_visible_to, 20261125110000_opname_prive_agenda.sql) en in
 * de app (visibleInOverview in src/lib/meetingsOverview.ts). Hier is hij voor
 * wat met de service-role leest en dus RLS overslaat: de handelingen van
 * Gerrie, de agents, MCP en de API, meeting-transcribe en gerrie-signals.
 *
 * Wat eerst misging: wie Agenda kon lezen, las via Gerrie of de API ook de
 * titel, het transcript en de notulen van een meeting uit de privé-agenda van
 * een collega, en kon die notulen mailen of de opname wissen.
 *
 * Los van index.ts zodat de test hem kan laden.
 */

export interface RecordingPrivacyFields {
  call_id?: string | null;
  note_id?: string | null;
  content_note_id?: string | null;
  created_by?: string | null;
  source_id?: string | null;
}

export interface CalendarSourceFields {
  user_id: string | null;
  visibility: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kan deze gebruiker de agenda lezen? Dezelfde regel als de policy op calendar_sources. */
export function sourceReadableBy(source: CalendarSourceFields | null, userId: string | null): boolean {
  if (!source) return false;
  if (source.visibility === 'organization') return true;
  return Boolean(userId && source.user_id === userId);
}

/**
 * Mag deze gebruiker de opname zien? `source` is de agenda van de opname
 * (`source_id`), of null als die er niet (meer) is. Zonder gebruiker: is hij
 * met het hele team gedeeld (voor de beslislijst, die van iedereen is).
 */
export function recordingVisibleTo(rec: RecordingPrivacyFields, userId: string | null, source: CalendarSourceFields | null): boolean {
  if (rec.note_id || rec.call_id || rec.content_note_id) return true;
  if (userId && rec.created_by === userId) return true;
  return Boolean(rec.source_id) && sourceReadableBy(source, userId);
}

/** Met het hele team gedeeld? Dan mag hij op de beslislijst. */
export function recordingSharedWithTeam(rec: RecordingPrivacyFields, source: CalendarSourceFields | null): boolean {
  return recordingVisibleTo(rec, null, source);
}

/**
 * Het PostgREST-filter (voor `.or(...)`) dat een lijst opnames beperkt tot wat
 * deze gebruiker mag zien. `readableSourceIds`: de agenda's die hij kan lezen
 * (readableSourceIds hieronder). Alleen uuid's komen erin: de rest valt weg,
 * zodat er nooit tekst in het filter belandt.
 */
export function visibleRecordingsFilter(userId: string, readableSourceIds: readonly string[]): string {
  const parts = ['note_id.not.is.null', 'call_id.not.is.null', 'content_note_id.not.is.null'];
  if (UUID.test(userId)) parts.push(`created_by.eq.${userId}`);
  const ids = readableSourceIds.filter((id) => UUID.test(id));
  if (ids.length) parts.push(`source_id.in.(${ids.join(',')})`);
  return parts.join(',');
}

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

/** De agenda's van deze organisatie die de gebruiker kan lezen: de eigen en de gedeelde. */
export async function readableSourceIds(db: Db, organizationId: string, userId: string): Promise<string[]> {
  if (!UUID.test(userId)) return [];
  const { data, error } = await db.from('calendar_sources').select('id')
    .eq('organization_id', organizationId)
    .or(`user_id.eq.${userId},visibility.eq.organization`);
  if (error) throw new Error(`Agenda's ophalen mislukt: ${error.message}`);
  return ((data ?? []) as { id: string }[]).map((row) => row.id);
}

/** De agenda van een opname (zichtbaarheid en eigenaar), of null. */
export async function recordingSource(db: Db, organizationId: string, sourceId: string | null | undefined): Promise<CalendarSourceFields | null> {
  if (!sourceId) return null;
  const { data, error } = await db.from('calendar_sources').select('user_id, visibility')
    .eq('organization_id', organizationId).eq('id', sourceId).maybeSingle();
  if (error) throw new Error(`Agenda ophalen mislukt: ${error.message}`);
  return (data as CalendarSourceFields | null) ?? null;
}

/** De velden die deze regel nodig heeft, om aan een select toe te voegen. */
export const RECORDING_PRIVACY_FIELDS = 'call_id, note_id, content_note_id, created_by, source_id';
