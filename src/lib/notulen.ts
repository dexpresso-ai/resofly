import type { InternalDocument, MeetingSummary, Note } from '../types';

/**
 * Notulen toevoegen aan een bestaande notitie of een document.
 *
 * Alleen de vorm van de tekst en de keuzelijst staan hier, zonder DOM, zodat
 * ze los te testen zijn. Het wegschrijven staat in contentAppend.ts.
 */

export interface ContentTarget {
  kind: 'note' | 'document';
  id: string;
  title: string;
  /** Eén regel erbij in de lijst, zodat twee notities met dezelfde titel uit elkaar te houden zijn. */
  hint: string;
  updatedAt: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * De notulen als opgemaakte tekst voor in een notitie of document: een kopje
 * met de afspraak en de datum, de samenvatting, en per onderdeel een lijst.
 *
 * Een leeg onderdeel blijft weg. De tekst is bewust gewone HTML met alleen de
 * tags die de editor kent (h3, h4, p, ul, li): een andere tag zou bij het
 * opslaan stilletjes verdwijnen, en alles wat uit de opname komt is gegevens,
 * dus alles gaat door esc().
 */
export function notulenAsRichText(input: { title: string; date: string; summary: MeetingSummary | null; fallbackText?: string | null }): string {
  const { summary } = input;
  const heading = `<h3>Notulen — ${esc(input.title || 'afspraak')} (${esc(input.date)})</h3>`;
  if (!summary) {
    const plain = (input.fallbackText ?? '').trim();
    if (!plain) return '';
    return heading + plain.split(/\n{2,}/).map(par => `<p>${par.split('\n').map(esc).join('<br>')}</p>`).join('');
  }
  const parts = [heading];
  if (summary.samenvatting?.trim()) parts.push(`<p>${esc(summary.samenvatting.trim())}</p>`);
  const block = (title: string, items: string[] | undefined) => {
    const clean = (items ?? []).map(item => item.trim()).filter(Boolean);
    if (clean.length) parts.push(`<h4>${title}</h4><ul>${clean.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`);
  };
  block('Besproken', summary.besproken);
  block('Besluiten', summary.besluiten);
  block('Actiepunten', summary.actiepunten);
  block('Vervolgafspraken', summary.vervolgafspraken);
  return parts.join('');
}

/**
 * De notities en documenten waaraan notulen kunnen worden toegevoegd, laatst
 * bewerkt eerst. Een Word-document (`storage_key`) valt af: dat is een .docx
 * in Collabora en `content` is daar maar een tekstspiegel. Tekst die we daarin
 * zetten komt niet in het bestand en verdwijnt bij de volgende keer opslaan.
 */
export function contentTargetsFrom(
  notes: readonly Note[],
  documents: readonly InternalDocument[],
  clientName: (clientId: string) => string | null = () => null,
): ContentTarget[] {
  const hintOf = (kind: 'note' | 'document', clientId: string | null) => {
    const client = clientId ? clientName(clientId) : null;
    return client ? `${kind === 'note' ? 'Notitie' : 'Document'} · ${client}` : kind === 'note' ? 'Notitie' : 'Document';
  };
  const rows: ContentTarget[] = [
    ...notes.map(note => ({ kind: 'note' as const, id: note.id, title: note.title, hint: hintOf('note', note.client_id), updatedAt: note.updated_at })),
    ...documents
      .filter(doc => !doc.storage_key)
      .map(doc => ({ kind: 'document' as const, id: doc.id, title: doc.title, hint: hintOf('document', doc.client_id), updatedAt: doc.updated_at })),
  ];
  return rows
    .map(row => ({ ...row, title: row.title?.trim() || 'Zonder titel' }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** De zoekvraag tegen titel en hint; leeg = alles. Hoofdletters en accenten maken niet uit. */
export function filterContentTargets(targets: readonly ContentTarget[], query: string): ContentTarget[] {
  const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...targets];
  return targets.filter(target => {
    const haystack = fold(`${target.title} ${target.hint}`);
    return words.every(word => haystack.includes(word));
  });
}
