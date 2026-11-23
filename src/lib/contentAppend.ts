import { loadContentHtml, updateRow } from './repository';
import { sanitizeRichText } from '../components/RichTextEditor';
import type { ContentTarget } from './notulen';

/**
 * Zet opgemaakte tekst onder de bestaande tekst van een notitie of document.
 *
 * De tekst van NU wordt opnieuw uit de database gehaald, niet uit het scherm:
 * de lijst in de app kan verouderd zijn, en wie intussen iets typte raakt het
 * anders kwijt. Platte tekst van vóór de editor wordt eerst alinea's. Zonder
 * dat plakte de aanvulling aan de laatste regel vast, en bleven de
 * regeleinden eruit.
 *
 * Loopt langs `updateRow` met de organisatie van de sessie, dus de rechten en
 * de RLS van de gebruiker gelden. De knop wordt alleen getoond met schrijfrecht
 * op de module Inhoud, maar de database beslist.
 */
export async function appendToContent(target: Pick<ContentTarget, 'kind' | 'id'>, organizationId: string, html: string): Promise<void> {
  const addition = sanitizeRichText(html);
  if (!addition) throw new Error('Er is niets om toe te voegen.');
  const table = target.kind === 'note' ? 'notes' : 'documents';
  const current = sanitizeRichText(await loadContentHtml(table, target.id, organizationId));
  await updateRow(table, target.id, { content: sanitizeRichText(`${current}${addition}`) }, organizationId);
}
