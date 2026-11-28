// ============================================================
// De volgorde van pagina's in een boom (bouwplan pagina's, §4 en §9).
//
// Gedeeld door de app (src/lib/pageTree.ts: de boom, het deelvenster, de
// export) en de server (page-export: de subpagina's als hoofdstukken in de
// PDF). Eén volgorde, zodat de hoofdstukken in Word en in de PDF hetzelfde
// staan als in de drive.
//
// Puur, zodat `npm test` het kan nalopen.
// ============================================================

/** Wat de volgorde van een pagina nodig heeft. */
export type OrderedPage = { id: string; title: string; parent_id: string | null; position: number | null };

/** Zoals de drive subpagina's sorteert (ContentLibrary): eerst position, dan de titel. */
export function comparePages(a: OrderedPage, b: OrderedPage): number {
  return ((a.position ?? 0) - (b.position ?? 0))
    || (a.title || '').localeCompare(b.title || '', 'nl', { numeric: true })
    || a.id.localeCompare(b.id);
}

/**
 * Alle subpagina's onder een pagina, in de volgorde van de boom, met hun
 * diepte (1 is een directe subpagina). Voor het deelvenster (stap 1C-3): elke
 * subpagina vink je apart aan; en voor de export (stap 1B-4): de hoofdstukken.
 * Bestand tegen kringen, en nooit dieper dan 20.
 */
export function subpagesOf<T extends OrderedPage>(pages: T[], rootId: string): Array<{ page: T; depth: number }> {
  const children = new Map<string, T[]>();
  for (const page of pages) {
    if (!page.parent_id || page.id === rootId) continue;
    const list = children.get(page.parent_id) ?? [];
    list.push(page);
    children.set(page.parent_id, list);
  }
  const out: Array<{ page: T; depth: number }> = [];
  const seen = new Set<string>([rootId]);
  const walk = (parentId: string, depth: number) => {
    if (depth > 20) return;
    for (const page of [...(children.get(parentId) ?? [])].sort(comparePages)) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      out.push({ page, depth });
      walk(page.id, depth + 1);
    }
  };
  walk(rootId, 1);
  return out;
}
