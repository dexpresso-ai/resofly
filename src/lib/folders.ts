import type { ContentFolder, UUID } from '../types';

export interface FolderOption { id: UUID; label: string; depth: number; }

function byPositionThenName(a: ContentFolder, b: ContentFolder): number {
  return a.position - b.position || a.name.localeCompare(b.name, 'nl');
}

/**
 * Hiërarchisch geordende mapopties voor één klant, bedoeld voor dropdowns.
 * Diepere mappen krijgen een streepje-inspringing in het label.
 */
export function clientFolderOptions(folders: ContentFolder[], clientId: UUID | null | undefined): FolderOption[] {
  const scoped = folders.filter(f => f.client_id === (clientId ?? null));
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

/** Directe submappen van een map (of van de wortel als parentId null is), gesorteerd. */
export function childFolders(folders: ContentFolder[], clientId: UUID, parentId: UUID | null): ContentFolder[] {
  return folders
    .filter(f => f.client_id === clientId && (f.parent_id ?? null) === parentId)
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
