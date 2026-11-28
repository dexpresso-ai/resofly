import type { ContentFolder, UUID } from '../types';

export interface FolderOption { id: UUID; label: string; depth: number; }

function byPositionThenName(a: ContentFolder, b: ContentFolder): number {
  return a.position - b.position || a.name.localeCompare(b.name, 'nl');
}

/**
 * Eén "map-scope" = de plek waarin een mappenboom leeft: een klant (project null)
 * of een projectmap binnen die klant. Mappen uit verschillende scopes worden nooit
 * door elkaar getoond; binnen een scope mag onbeperkt genest worden.
 */
export function inFolderScope(
  folder: ContentFolder,
  clientId: UUID | null | undefined,
  projectId: UUID | null | undefined,
): boolean {
  return (folder.client_id ?? null) === (clientId ?? null)
    && (folder.project_id ?? null) === (projectId ?? null);
}

/** Alle mappen van één scope (klant + eventueel project). */
export function scopedFolders(
  folders: ContentFolder[],
  clientId: UUID | null | undefined,
  projectId: UUID | null | undefined,
): ContentFolder[] {
  return folders.filter(f => inFolderScope(f, clientId, projectId));
}

/**
 * Hiërarchisch geordende mapopties voor één scope, bedoeld voor dropdowns.
 * Diepere mappen krijgen een streepje-inspringing in het label.
 */
export function clientFolderOptions(
  folders: ContentFolder[],
  clientId: UUID | null | undefined,
  projectId: UUID | null | undefined = null,
): FolderOption[] {
  const scoped = scopedFolders(folders, clientId, projectId);
  const byParent = new Map<string | null, ContentFolder[]>();
  for (const folder of scoped) {
    const key = folder.parent_id ?? null;
    const list = byParent.get(key) ?? [];
    list.push(folder);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort(byPositionThenName);

  const out: FolderOption[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const folder of byParent.get(parentId) ?? []) {
      out.push({ id: folder.id, label: `${'— '.repeat(depth)}${folder.name}`, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * Directe submappen van een map (of van de wortel van de scope als parentId null is),
 * gesorteerd. `folders` mag de volledige lijst zijn of al op scope gefilterd.
 */
export function childFolders(
  folders: ContentFolder[],
  clientId: UUID | null | undefined,
  projectId: UUID | null | undefined,
  parentId: UUID | null,
): ContentFolder[] {
  return folders
    .filter(f => inFolderScope(f, clientId, projectId) && (f.parent_id ?? null) === parentId)
    .sort(byPositionThenName);
}

/** Alle (klein)kind-map-ids onder een map (exclusief de map zelf). */
export function folderDescendantIds(folders: ContentFolder[], folderId: UUID): UUID[] {
  const byParent = new Map<string, ContentFolder[]>();
  for (const folder of folders) {
    if (!folder.parent_id) continue;
    const list = byParent.get(folder.parent_id) ?? [];
    list.push(folder);
    byParent.set(folder.parent_id, list);
  }
  const out: UUID[] = [];
  const stack: UUID[] = [folderId];
  while (stack.length) {
    const id = stack.pop() as UUID;
    for (const child of byParent.get(id) ?? []) {
      out.push(child.id);
      stack.push(child.id);
    }
  }
  return out;
}

/** Pad van wortel naar de gegeven map, voor breadcrumbs. */
export function folderPath(folders: ContentFolder[], folderId: UUID | null): ContentFolder[] {
  const byId = new Map(folders.map(f => [f.id, f] as const));
  const path: ContentFolder[] = [];
  let cursor = folderId;
  let guard = 0;
  while (cursor && guard++ < 100) {
    const folder = byId.get(cursor);
    if (!folder) break;
    path.unshift(folder);
    cursor = folder.parent_id;
  }
  return path;
}

/**
 * Waar een notitie of document in de drive komt, voor het venster waarin je
 * het bewerkt. Zonder klant maar met een project van klant X staat het bij X
 * (zoals dossierClientOf in pageTree.ts); pas zonder beide is het het eigen
 * dossier. Eerst noemde het venster elke lege klantkeuze "Eigen dossier", ook
 * als het project bij een klant hoorde, en bood het dan geen mappen van dat
 * project aan.
 *
 * `folderClientId` is de klant van de mappen die je kunt kiezen; `emptyLabel`
 * is hoe de lege klantkeuze heet.
 */
export function contentPlace(
  form: { client_id?: string | null; project_id?: string | null },
  projects: Array<{ id: UUID; client_id: UUID | null }>,
  clients: Array<{ id: UUID; name: string }>,
): { folderClientId: UUID | null; emptyLabel: string } {
  const projectClient = form.project_id ? projects.find(p => p.id === form.project_id)?.client_id ?? null : null;
  const emptyLabel = projectClient
    ? `${clients.find(c => c.id === projectClient)?.name?.trim() || 'Klant'} (via het project)`
    : 'Eigen dossier';
  return { folderClientId: form.client_id || projectClient || null, emptyLabel };
}
