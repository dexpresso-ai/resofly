// ============================================================
// Actiepunten worden taken (stap 2-2a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §18).
//
// Een regel in een takenlijst wordt met één klik een taak. De taak onthoudt
// uit welke pagina en regel ze komt (tasks.page_id en page_block_id); de
// pagina zelf verandert niet. Wie Projecten niet mag lezen, krijgt de taak
// niet geladen en ziet dus een gewone takenlijst (regel 3).
//
// Hier: welke regels een taak hebben, en wat de titel van een nieuwe taak
// wordt. Zonder Tiptap en React, zodat pageTasks.test.ts het in Node nakijkt.
// ============================================================

import type { TaskStatus } from '../types';
import { MENTION_KIND_WORDS, mentionOf, type MentionKind } from '../../supabase/functions/_shared/pageMentions.ts';

/** De stand van een taak op het label achter de regel. */
export const TASK_STATUS_WORDS: Readonly<Record<TaskStatus, string>> = {
  todo: 'Te doen',
  doing: 'Bezig',
  review: 'Review',
  done: 'Klaar',
};

/** Zo lang mag een titel zijn: dezelfde grens als de API (apiResourceSpecs.ts). */
export const TASK_TITLE_MAX = 500;

export type PageTaskLink = { id: string; title: string; status: TaskStatus };

type TaskRow = { id: string; title: string; status: TaskStatus; page_id?: string | null; page_block_id?: string | null };

/** De taken van deze pagina, per regel (het id van het blok). */
export function pageTaskLinks(tasks: readonly TaskRow[], pageId: string): Map<string, PageTaskLink> {
  const out = new Map<string, PageTaskLink>();
  for (const task of tasks) {
    if (task.page_id === pageId && task.page_block_id) out.set(task.page_block_id, { id: task.id, title: task.title, status: task.status });
  }
  return out;
}

type JsonNode = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: JsonNode[] };

/**
 * De titel van een nieuwe taak: de tekst van de regel zelf, zonder een lijst
 * die eronder hangt. Een vermelding krijgt de naam die jij ziet, anders de
 * soort, zoals op de chip. Je typt een taak ook zelf in; zo staat er wat je
 * in de pagina las. Witruimte samengevoegd, hoogstens TASK_TITLE_MAX tekens.
 */
export function taskTitleFromItem(item: JsonNode, nameOf: (kind: MentionKind, id: string) => string | null): string {
  const first = item.content?.find(child => child.type === 'paragraph');
  const parts: string[] = [];
  const walk = (node: JsonNode) => {
    if (node.type === 'text') { parts.push(node.text ?? ''); return; }
    if (node.type === 'hardBreak') { parts.push(' '); return; }
    if (node.type === 'mention') {
      const ref = mentionOf(node);
      if (ref) parts.push(nameOf(ref.kind, ref.id) ?? MENTION_KIND_WORDS[ref.kind]);
      return;
    }
    node.content?.forEach(walk);
  };
  if (first) walk(first);
  const title = parts.join('').replace(/\s+/g, ' ').trim();
  return title.length > TASK_TITLE_MAX ? `${title.slice(0, TASK_TITLE_MAX - 1).trimEnd()}…` : title;
}
