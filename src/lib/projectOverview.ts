/**
 * Het projectoverzicht: welke notities en documenten bovenaan staan.
 *
 * Notities en documenten staan samen in één lijst, het laatst bewerkte eerst,
 * zodat je ziet waar je gebleven was zonder eerst te kiezen in welk tabblad
 * het staat.
 *
 * Puur (alleen types), zodat `npm test` er rechtstreeks overheen draait.
 */
import type { InternalDocument, Note, NoteHandwritingSummary } from '../types';

/** Hoeveel notities en documenten het overzicht toont. */
export const RECENT_CONTENT_LIMIT = 5;

/** Een notitie of document op het projectoverzicht, met wanneer het het laatst veranderde (ms). */
export type RecentContentItem =
  | { kind: 'note'; id: string; modified: number; note: Note; handwritten: boolean }
  | { kind: 'document'; id: string; modified: number; doc: InternalDocument };

/** Het laatste moment uit een rij tijdstempels; lege of onleesbare tellen niet mee. */
export function latestMoment(...values: Array<string | null | undefined>): number {
  let best = 0;
  for (const value of values) {
    const time = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(time) && time > best) best = time;
  }
  return best;
}

/**
 * De notities en documenten van een project, het laatst bewerkte eerst.
 *
 * Wanneer iets "bewerkt" is, staat niet altijd op de rij zelf:
 *  - handschrift (pen op tablet) staat in note_handwriting, en het opslaan
 *    daarvan raakt `notes.updated_at` niet. Op alleen die kolom zou een
 *    notitie waarin je net hebt geschreven onder ouder typwerk wegzakken;
 *  - bij een Office-document zet de editor `last_edited_at`.
 * Het laatste van die momenten telt.
 */
export function recentProjectContent(
  notes: readonly Note[],
  documents: readonly InternalDocument[],
  handwriting: readonly Pick<NoteHandwritingSummary, 'note_id' | 'updated_at'>[],
  limit = RECENT_CONTENT_LIMIT,
): RecentContentItem[] {
  const inkByNote = new Map(handwriting.map(row => [row.note_id, row.updated_at] as const));
  const items: RecentContentItem[] = [
    ...notes.map(note => ({
      kind: 'note' as const, id: note.id, note, handwritten: inkByNote.has(note.id),
      modified: latestMoment(note.updated_at, note.created_at, inkByNote.get(note.id)),
    })),
    ...documents.map(doc => ({
      kind: 'document' as const, id: doc.id, doc,
      modified: latestMoment(doc.updated_at, doc.created_at, doc.last_edited_at),
    })),
  ];
  // Bij gelijke tijd op id: dezelfde volgorde bij elke render, ook na een ververs.
  return items.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id)).slice(0, limit);
}
