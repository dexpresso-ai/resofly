// ============================================================
// "Genoemd in" bij een klant of project (stap 2-1c, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §18).
//
// De database houdt bij welke pagina wat noemt (page_mentions, stap 2-1a), en
// geeft alleen de rijen van pagina's die je mag lezen: Inhoud lezen, en niet
// in de prullenbak. Hier worden die ids pagina's met een titel en een plek,
// uit wat de app al geladen heeft.
//
// Een id die de app niet geladen heeft, valt weg: die pagina kun je hier ook
// niet openen. Ze verschijnt na de volgende ververs. De plek komt uit de
// geladen klanten en projecten (die de database al op rechten filtert); wat je
// niet mag zien, heet "Ander dossier", nooit een id.
//
// Zonder React, zodat pageMentionedIn.test.ts het in Node nakijkt.
// ============================================================

import type { InternalDocument } from '../types';

/** Zoveel rijen staan er meteen; de rest achter "meer". */
export const MENTIONED_IN_LIMIT = 6;

type Doc = Pick<InternalDocument, 'id' | 'title' | 'format' | 'client_id' | 'project_id' | 'updated_at' | 'archived_at'>;

export type MentionedInPlaces = {
  clients: ReadonlyArray<{ id: string; name: string }>;
  projects: ReadonlyArray<{ id: string; name: string }>;
  /** Hoe het eigen dossier heet: de naam van het bedrijf, zoals in de editor. */
  ownDossierName: string;
};

export type MentionedInRow<D extends Doc> = { doc: D; title: string; place: string };

/**
 * Waar een pagina staat, in een paar woorden: het project, anders de klant,
 * anders het eigen dossier. Een project of klant die je niet mag zien (of die
 * niet geladen is), heet "Ander dossier".
 */
export function mentionedInPlace(doc: Pick<Doc, 'client_id' | 'project_id'>, places: MentionedInPlaces): string {
  if (doc.project_id) {
    const project = places.projects.find(row => row.id === doc.project_id);
    return project?.name.trim() ? `Project · ${project.name.trim()}` : 'Ander dossier';
  }
  if (doc.client_id) {
    const client = places.clients.find(row => row.id === doc.client_id);
    return client?.name.trim() ? `Klant · ${client.name.trim()}` : 'Ander dossier';
  }
  return places.ownDossierName.trim() || 'Eigen dossier';
}

/**
 * Ontbreekt page_mentions nog? Dat is zo als de app eerder live staat dan
 * migratie 20261128160000. Dan geeft "Genoemd in" niets, en geen fout op elk
 * klant- en projectscherm.
 *
 * PostgREST zegt dan PGRST205 ("Could not find the table
 * 'public.page_mentions' in the schema cache"), Postgres zelf 42P01. Alleen
 * als de melding page_mentions noemt. Een andere fout, zoals geen rechten,
 * hoort het paneel te zeggen.
 */
export function isMissingMentionsTable(error: { code?: string | null; message?: string | null; details?: string | null } | null | undefined): boolean {
  if (!error) return false;
  const text = `${error.message ?? ''} ${error.details ?? ''}`;
  if (!/page_mentions\b/.test(text)) return false;
  return error.code === 'PGRST205' || error.code === '42P01' || /does not exist|schema cache/i.test(text);
}

/**
 * De pagina's achter de ids, het laatst bewerkt bovenaan. Alleen pagina's, en
 * niets uit de prullenbak: de database geeft die ook niet, maar zo blijft het
 * kloppen als de geladen lijst achterloopt op de database.
 */
export function mentionedInPages<D extends Doc>(ids: readonly string[], documents: readonly D[], places: MentionedInPlaces): MentionedInRow<D>[] {
  const wanted = new Set(ids);
  return documents
    .filter(doc => wanted.has(doc.id) && doc.format === 'page' && !doc.archived_at)
    .map(doc => ({ doc, title: doc.title?.trim() || 'Zonder titel', place: mentionedInPlace(doc, places) }))
    .sort((a, b) => (b.doc.updated_at ?? '').localeCompare(a.doc.updated_at ?? '') || a.title.localeCompare(b.title, 'nl'));
}
