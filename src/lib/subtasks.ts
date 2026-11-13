import type { Subtask } from '../types.ts';
import { uid } from './format.ts';

/**
 * Subtaken in een vaste vorm, voor het taakvenster. De tekst blijft precies
 * zoals hij getypt is.
 *
 * Dit draait bij elke toetsaanslag in het taakvenster. Toen hier nog `trim()`
 * stond, haalde elke toetsaanslag de spatie aan het eind weg. "feedback
 * verwerken" typen lukte dus niet: na "feedback" en een spatie stond er weer
 * "feedback", en je kreeg "feedbackverwerken".
 */
export function normalizeSubtasks(value: unknown): Subtask[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = item as Partial<Subtask> | undefined;
    return {
      id: String(source?.id || uid()),
      label: typeof source?.label === 'string' ? source.label : String(source?.label ?? ''),
      done: Boolean(source?.done),
    };
  });
}

/**
 * Subtaken zoals ze worden opgeslagen: spaties voor en achter de tekst eraf,
 * lege regels weg. Spaties tussen de woorden blijven staan. Opruimen hoort
 * hier, bij het opslaan, en niet tijdens het typen (zie `normalizeSubtasks`).
 */
export function subtasksForSave(value: unknown): Subtask[] {
  return normalizeSubtasks(value)
    .map(subtask => ({ ...subtask, label: subtask.label.trim() }))
    .filter(subtask => subtask.label.length > 0);
}
