// ============================================================
// De boom van het dossier naast een pagina (§4 "het pagina-scherm",
// docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md).
//
// Puur, zodat `npm test` het kan nalopen. De gegevens komen uit
// listDossierPages (repository.ts); hier alleen de vorm.
//
// - Een dossier is een klant of het eigen dossier, met de pagina's in de
//   projecten van die klant erbij. Dat is dezelfde regel als in de
//   bestandskiezer (listDossierFiles) en in de database
//   (page_attachment_dossier): de boom en de kiezer tonen zo hetzelfde dossier.
// - Bovenste pagina's staan per plek bij elkaar: los in het dossier, per map en
//   per project, zoals in de drive.
// - Een pagina waarvan de ouder niet in de lijst staat (niet te zien, of boven
//   de limiet), komt bovenaan in haar groep. Weglaten zou haar onvindbaar maken.
// ============================================================

export type TreePage = {
  id: string; title: string; parent_id: string | null;
  folder_id: string | null; client_id: string | null; project_id: string | null; position: number | null;
};
export type TreeFolder = { id: string; name: string; parent_id: string | null };
export type TreeNode = { page: TreePage; children: TreeNode[] };
export type TreeGroup = { key: string; label: string | null; roots: TreeNode[] };

/** Zoals de drive subpagina's sorteert (ContentLibrary): eerst position, dan de titel. */
export function comparePages(a: TreePage, b: TreePage): number {
  return ((a.position ?? 0) - (b.position ?? 0))
    || (a.title || '').localeCompare(b.title || '', 'nl', { numeric: true })
    || a.id.localeCompare(b.id);
}

/**
 * Bij welke klant hoort iets in de drive: de klant van zijn project, anders
 * zijn eigen klant; null is het eigen dossier.
 */
export function dossierClientOf(clientId: string | null, projectId: string | null, projectClient: Map<string, string | null>): string | null {
  return projectId && projectClient.has(projectId) ? (projectClient.get(projectId) ?? clientId) : clientId;
}

/** "Handboek / Archief". Hoogstens 20 stappen, zoals de mappenboom in de database. */
export function folderPath(folders: Map<string, TreeFolder>, id: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let next: string | null = id;
  while (next && !seen.has(next) && names.length < 20) {
    seen.add(next);
    const folder = folders.get(next);
    if (!folder) break;
    names.unshift(folder.name.trim() || 'Naamloze map');
    next = folder.parent_id;
  }
  return names.length > 0 ? names.join(' / ') : 'Map';
}

export function buildPageTree(
  pages: TreePage[],
  places: { folders: Map<string, TreeFolder>; projects: Map<string, string> },
): TreeGroup[] {
  const byId = new Map(pages.map(page => [page.id, page]));
  const children = new Map<string, TreePage[]>();
  const tops: TreePage[] = [];
  for (const page of pages) {
    if (page.parent_id && page.parent_id !== page.id && byId.has(page.parent_id)) {
      const list = children.get(page.parent_id) ?? [];
      list.push(page);
      children.set(page.parent_id, list);
    } else {
      tops.push(page);
    }
  }
  const placed = new Set<string>();
  const nodeOf = (page: TreePage, depth: number): TreeNode => {
    placed.add(page.id);
    const kids = depth >= 20 ? [] : (children.get(page.id) ?? []).filter(child => !placed.has(child.id)).sort(comparePages);
    return { page, children: kids.map(child => nodeOf(child, depth + 1)) };
  };
  const roots = [...tops].sort(comparePages).map(page => nodeOf(page, 0));
  // Wat in een kring zit, heeft geen bovenste pagina en zou nergens staan. De
  // database staat geen kring toe, maar de lijst kan uit twee momenten komen.
  for (const page of [...pages].sort(comparePages)) {
    if (!placed.has(page.id)) roots.push(nodeOf(page, 0));
  }

  const groups = new Map<string, TreeGroup & { rank: number }>();
  for (const node of roots) {
    const { project_id: project, folder_id: folder } = node.page;
    const key = `${project ?? ''}/${folder ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      const projectName = project ? places.projects.get(project)?.trim() || 'Project' : null;
      const folderName = folder ? folderPath(places.folders, folder) : null;
      const label = projectName && folderName ? `${projectName} / ${folderName}` : projectName ?? folderName;
      group = { key, label, roots: [], rank: project ? 2 : folder ? 1 : 0 };
      groups.set(key, group);
    }
    group.roots.push(node);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || (a.label ?? '').localeCompare(b.label ?? '', 'nl', { numeric: true }))
    .map(({ rank: _rank, ...group }) => group);
}

/** De bovenliggende pagina's in de lijst, van dichtbij naar ver: die klappen open. */
export function ancestorIds(pages: TreePage[], id: string): string[] {
  const byId = new Map(pages.map(page => [page.id, page]));
  const out: string[] = [];
  let next = byId.get(id)?.parent_id ?? null;
  while (next && byId.has(next) && next !== id && !out.includes(next) && out.length < 20) {
    out.push(next);
    next = byId.get(next)?.parent_id ?? null;
  }
  return out;
}

/**
 * Alle subpagina's onder een pagina, in de volgorde van de boom, met hun
 * diepte (1 is een directe subpagina). Voor het deelvenster (stap 1C-3): elke
 * subpagina vink je apart aan. Bestand tegen kringen, en nooit dieper dan 20.
 */
export function subpagesOf(pages: TreePage[], rootId: string): Array<{ page: TreePage; depth: number }> {
  const children = new Map<string, TreePage[]>();
  for (const page of pages) {
    if (!page.parent_id || page.id === rootId) continue;
    const list = children.get(page.parent_id) ?? [];
    list.push(page);
    children.set(page.parent_id, list);
  }
  const out: Array<{ page: TreePage; depth: number }> = [];
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
