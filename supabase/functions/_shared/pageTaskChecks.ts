// ============================================================
// Vinkjes volgens hun taak (stap 2-2c, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §18).
//
// Een regel die een taak werd (tasks.page_id en page_block_id, stap 2-2a),
// staat in een download aangevinkt als de taak Klaar is, en anders niet. De
// taak is de waarheid: een regel van een taak die weer open is, gaat uit.
//
// Alleen in een download. Een kopie voor het dossier (de Word-kopie, de
// vastgelegde PDF) kan iedereen met Inhoud openen, en de stand van een taak
// is gegevens van Projecten. Dat is dezelfde regel als bij de namen (2-1a).
// De taken komen met de rechten van wie exporteert; wat die niet mag lezen,
// blijft zoals het in de pagina staat.
//
// Per pagina en per regel. Een export met subpagina's als hoofdstukken heeft
// meer pagina's, en een gekopieerde pagina heeft dezelfde id's per regel als
// het origineel: een id alleen wijst dan naar twee taken.
//
// Gedeeld door de app (Word), page-export (PDF) en de editor ("lopen achter
// op hun taak").
// ============================================================

export type TaskCheckRow = { page_id?: string | null; page_block_id?: string | null; status?: string | null };

/** Per regel van deze pagina: of haar taak Klaar is. */
export function taskChecksFor(pageId: string, tasks: readonly TaskCheckRow[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const task of tasks) {
    if (task.page_id === pageId && task.page_block_id) out.set(task.page_block_id, task.status === 'done');
  }
  return out;
}

type JsonNode = { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };

/**
 * De body met de vinkjes volgens de taken, en hoeveel er aan en uit gingen.
 * Verandert er niets, dan dezelfde body: geen kopie.
 */
export function withTaskChecks(body: unknown, checks: ReadonlyMap<string, boolean>): { body: unknown; on: number; off: number } {
  let on = 0;
  let off = 0;
  if (checks.size === 0) return { body, on, off };
  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const current = node as JsonNode;
    let next: JsonNode = current;
    const id = current.attrs?.id;
    if (current.type === 'taskItem' && typeof id === 'string' && checks.has(id)) {
      const want = checks.get(id) === true;
      if ((current.attrs?.checked === true) !== want) {
        if (want) on += 1;
        else off += 1;
        next = { ...current, attrs: { ...current.attrs, checked: want } };
      }
    }
    if (Array.isArray(current.content)) {
      let changed = false;
      const content = current.content.map(child => {
        const out = walk(child);
        if (out !== child) changed = true;
        return out;
      });
      if (changed) next = { ...next, content };
    }
    return next;
  };
  return { body: walk(body), on, off };
}

/** "1 vinkje gaat aan, 2 gaan uit": wat achterloopt, in gewone woorden. */
export function taskCheckSummary(on: number, off: number): string {
  const part = (count: number, word: string) => `${count} ${count === 1 ? 'gaat' : 'gaan'} ${word}`;
  return [on ? part(on, 'aan') : null, off ? part(off, 'uit') : null].filter(Boolean).join(', ');
}
