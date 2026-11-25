import type { MeetingRecording, UUID } from '../types';
import { formatBytes } from './transfers.ts';

/**
 * Inhoud → Meetings (sinds 25 november): alle opnames in één tabel, met de
 * knop om de audio te wissen en transcript en notulen te houden.
 *
 * Hier staat wat de pagina beslist zonder scherm: wie welke meeting in het
 * overzicht ziet, wanneer de audio weg mag, zoeken en de teksten in de cellen.
 * Los van de pagina zodat de test het kan laden.
 */

/** Wat de tabel per meeting laadt. Het transcript niet: dat is per uur zo 60 KB, en komt pas als je een meeting opent. */
export type MeetingOverviewRow = Pick<MeetingRecording,
  | 'id' | 'organization_id' | 'created_at' | 'created_by' | 'provider' | 'source_id' | 'event_title_snapshot'
  | 'client_id' | 'project_id' | 'call_id' | 'note_id' | 'content_note_id' | 'meeting_date' | 'event_starts_at'
  | 'storage_key' | 'mime_type' | 'size_bytes' | 'duration_seconds' | 'status' | 'error_message'
  | 'summary_text' | 'summary_sent_at' | 'audio_deleted_at'>;

export const MEETING_OVERVIEW_COLUMNS = [
  'id', 'organization_id', 'created_at', 'created_by', 'provider', 'source_id', 'event_title_snapshot',
  'client_id', 'project_id', 'call_id', 'note_id', 'content_note_id', 'meeting_date', 'event_starts_at',
  'storage_key', 'mime_type', 'size_bytes', 'duration_seconds', 'status', 'error_message',
  'summary_text', 'summary_sent_at', 'audio_deleted_at',
].join(',');

export type MeetingKind = 'afspraak' | 'gesprek' | 'notitie';

export function meetingKind(rec: Pick<MeetingRecording, 'call_id' | 'note_id'>): MeetingKind {
  if (rec.note_id) return 'notitie';
  if (rec.call_id) return 'gesprek';
  return 'afspraak';
}

export const KIND_LABEL: Record<MeetingKind, string> = { afspraak: 'Afspraak', gesprek: 'Telefoongesprek', notitie: 'Notitie' };

/**
 * Staat deze meeting in het overzicht?
 *
 * De database laat wie Agenda kan lezen élke afspraakopname van de organisatie
 * lezen, ook die uit de privé-agenda van een collega. In de agenda zag je die
 * nooit: daar opent een opname alleen bij een afspraak die je kunt zien. Een
 * overzicht van alles zou die titels en transcripten wel tonen. Daarom hier
 * dezelfde grens als in de agenda: een afspraakopname uit een agenda die je
 * kunt lezen (je eigen agenda's en de gedeelde; RLS op calendar_sources), of
 * die je zelf maakte, of die al in de gedeelde Inhoud staat.
 *
 * Een gesprek hoort bij het klantdossier en een notitie-opname bij Inhoud:
 * die zijn er voor iedereen die ze mag lezen.
 */
export function visibleInOverview(
  rec: Pick<MeetingRecording, 'call_id' | 'note_id' | 'content_note_id' | 'created_by' | 'source_id'>,
  viewer: { userId: UUID | null; readableSourceIds: ReadonlySet<string> },
): boolean {
  if (rec.note_id || rec.call_id || rec.content_note_id) return true;
  if (viewer.userId && rec.created_by === viewer.userId) return true;
  return Boolean(rec.source_id && viewer.readableSourceIds.has(rec.source_id));
}

/** Is er een transcript? Op status: het transcript zelf laadt de tabel niet. */
export function hasTranscript(rec: Pick<MeetingRecording, 'status'>): boolean {
  return rec.status === 'transcribed' || rec.status === 'summarizing' || rec.status === 'done';
}

/** Staat de audio er nog? */
export function hasAudio(rec: Pick<MeetingRecording, 'storage_key'>): boolean {
  return Boolean(rec.storage_key);
}

/**
 * Mag de knop "Audio verwijderen" er staan? Alleen met audio én transcript:
 * zolang er geen transcript is, is de audio het enige wat er van de meeting
 * is. De server beslist met dezelfde regel (supabase/functions/_shared/
 * meetingAudio.ts); bij een mislukte opname ('error') kijkt die naar het
 * transcript zelf, de tabel toont de knop dan niet.
 */
export function canDeleteAudio(rec: Pick<MeetingRecording, 'storage_key' | 'status'>): boolean {
  return hasAudio(rec) && hasTranscript(rec);
}

/** De dag van de meeting (JJJJ-MM-DD): die van de afspraak, anders de opnamedag op Nederlandse tijd. */
export function meetingDay(rec: Pick<MeetingRecording, 'meeting_date' | 'created_at'>): string {
  if (rec.meeting_date && /^\d{4}-\d{2}-\d{2}$/.test(rec.meeting_date)) return rec.meeting_date;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(rec.created_at));
}

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

/** "24 nov 2026"; het jaar alleen als het niet dit jaar is. */
export function shortDay(day: string, today = new Date()): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const thisYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric' }).format(today));
  return y === thisYear ? `${d} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "45 min", "1 u 05", "< 1 min". Leeg als de duur niet bekend is. */
export function durationShort(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} u ${String(minutes % 60).padStart(2, '0')}`;
}

/** De naam van een meeting in de tabel. Een gesprek of notitie zonder titel krijgt zijn soort. */
export function meetingTitle(rec: Pick<MeetingRecording, 'event_title_snapshot' | 'call_id' | 'note_id'>): string {
  const title = rec.event_title_snapshot?.replace(/\s+/g, ' ').trim();
  if (title) return title;
  const kind = meetingKind(rec);
  return kind === 'afspraak' ? 'Meeting zonder titel' : KIND_LABEL[kind];
}

/** Wat er in de kolom Notulen staat. */
export function notulenState(rec: Pick<MeetingRecording, 'status' | 'error_message' | 'summary_text'>): { label: string; tone: 'ok' | 'busy' | 'warn' | 'muted' } {
  if (rec.status === 'done' && rec.summary_text?.trim()) return { label: 'Klaar', tone: 'ok' };
  if (rec.status === 'done') return { label: 'Transcript', tone: 'ok' };
  if (rec.status === 'summarizing' || (rec.status === 'transcribed' && !rec.error_message)) return { label: 'Notulen volgen', tone: 'busy' };
  if (rec.status === 'transcribed') return { label: 'Alleen transcript', tone: 'warn' };
  if (rec.status === 'transcribing') return { label: 'Uitschrijven…', tone: 'busy' };
  if (rec.status === 'uploaded') return { label: rec.error_message ? 'Wacht op tegoed' : 'Wacht', tone: 'warn' };
  return { label: 'Mislukt', tone: 'warn' };
}

/** Wat er in de kolom Audio staat: de grootte, "Verwijderd" of niets. */
export function audioLabel(rec: Pick<MeetingRecording, 'storage_key' | 'size_bytes' | 'audio_deleted_at'>): string {
  if (rec.storage_key) return rec.size_bytes ? formatBytes(rec.size_bytes) : 'Bewaard';
  if (rec.audio_deleted_at) return 'Verwijderd';
  return '—';
}

export { formatBytes };

/** Zoeken op titel, klant en de notulen (de samenvatting). Hoofdletters en accenten tellen niet. */
export function matchesQuery(rec: Pick<MeetingRecording, 'event_title_snapshot' | 'summary_text' | 'call_id' | 'note_id'>, clientName: string | null, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  const hay = fold([meetingTitle(rec), clientName ?? '', rec.summary_text ?? ''].join(' '));
  return q.split(/\s+/).every((part) => hay.includes(part));
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export type AudioFilter = 'all' | 'with-audio';

export interface MeetingFilter {
  query: string;
  audio: AudioFilter;
  kinds: ReadonlySet<MeetingKind>;
}

export function filterMeetings<T extends MeetingOverviewRow>(rows: readonly T[], filter: MeetingFilter, clientName: (id: UUID | null) => string | null): T[] {
  return rows.filter((rec) => {
    if (!filter.kinds.has(meetingKind(rec))) return false;
    if (filter.audio === 'with-audio' && !hasAudio(rec)) return false;
    return matchesQuery(rec, clientName(rec.client_id), filter.query);
  });
}

/** Nieuwste meeting bovenaan: op de dag van de meeting, dan op de opname. */
export function sortMeetings<T extends MeetingOverviewRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const day = meetingDay(b).localeCompare(meetingDay(a));
    return day !== 0 ? day : b.created_at.localeCompare(a.created_at);
  });
}

/** Hoeveel audio er staat, voor de regel boven de tabel en de selectie. */
export function audioTotals(rows: readonly Pick<MeetingRecording, 'storage_key' | 'size_bytes'>[]): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const rec of rows) {
    if (!rec.storage_key) continue;
    count += 1;
    bytes += Number(rec.size_bytes) || 0;
  }
  return { count, bytes };
}

/** "Audio van 3 meetings verwijderen?" — enkelvoud en meervoud. */
export function meetingCount(n: number): string {
  return n === 1 ? '1 meeting' : `${n} meetings`;
}
