import type { ClientEmailFolder, UUID } from '../types';

/**
 * De mappen van klantmail op Berichten: per klant een eigen boom, waarin je
 * gesprekken ordent ("Offertes", "Project website/Feedback").
 *
 * Pure functies, zonder React en zonder Supabase, zodat `npm test` ze kan
 * controleren. De database bewaakt dezelfde regels nog een keer
 * (20261111210000_berichten_mappen.sql); hier staan ze zodat het scherm een
 * knop uit kan zetten met de reden erbij, in plaats van je in een foutmelding
 * te laten lopen.
 */

/** Zo diep mag een boom: Map › Submap › … vijf lagen. Gelijk aan de database. */
export const MAX_FOLDER_DEPTH = 5;
/** Langste mapnaam. Gelijk aan de check in de database. */
export const MAX_FOLDER_NAME = 80;

type FolderLike = Pick<ClientEmailFolder, 'id' | 'client_id' | 'parent_id' | 'name'>;

/** Witruimte aan de randen weg en dubbele spaties samen, net als de database. */
export function cleanFolderName(name: string | null | undefined): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

const collator = new Intl.Collator('nl', { numeric: true, sensitivity: 'base' });

/**
 * Op naam, met getallen als getallen: "2 Oplevering" vóór "10 Nazorg". Wie
 * een vaste volgorde wil, zet er een nummer voor; een sleepvolgorde zou per
 * teamlid anders onthouden worden en is daarom bewust niet gebouwd.
 */
export function compareFolders(a: Pick<FolderLike, 'name'>, b: Pick<FolderLike, 'name'>): number {
  return collator.compare(a.name, b.name);
}

/** Alle mappen van één klant. */
export function foldersOfClient<T extends FolderLike>(folders: readonly T[], clientId: UUID | null | undefined): T[] {
  if (!clientId) return [];
  return folders.filter(f => f.client_id === clientId);
}

/** De mappen direct onder een map (of bovenaan bij de klant, met `null`), op naam. */
export function childFolders<T extends FolderLike>(folders: readonly T[], parentId: UUID | null): T[] {
  return folders.filter(f => (f.parent_id ?? null) === parentId).sort(compareFolders);
}

/** Pad van boven naar de map zelf, voor "Offertes / 2025". Onbekend id → leeg. */
export function folderPath<T extends FolderLike>(folders: readonly T[], folderId: UUID | null | undefined): T[] {
  const byId = new Map(folders.map(f => [f.id, f] as const));
  const path: T[] = [];
  let cursor = folderId ?? null;
  // Een kring kan de database niet maken, maar een half geladen lijst mag de
  // app nooit in een oneindige lus laten lopen.
  for (let guard = 0; cursor && guard < 50; guard += 1) {
    const folder = byId.get(cursor);
    if (!folder) break;
    path.unshift(folder);
    cursor = folder.parent_id;
  }
  return path;
}

export function folderPathLabel(folders: readonly FolderLike[], folderId: UUID | null | undefined, separator = ' / '): string {
  return folderPath(folders, folderId).map(f => f.name).join(separator);
}

/** Op welke laag een map staat: bovenaan = 1. */
export function folderDepth(folders: readonly FolderLike[], folderId: UUID): number {
  return folderPath(folders, folderId).length;
}

/** Alle (klein)kinderen van een map, zonder de map zelf. */
export function descendantFolderIds(folders: readonly FolderLike[], folderId: UUID): Set<UUID> {
  const byParent = new Map<UUID, UUID[]>();
  for (const f of folders) {
    if (!f.parent_id) continue;
    const list = byParent.get(f.parent_id) ?? [];
    list.push(f.id);
    byParent.set(f.parent_id, list);
  }
  const out = new Set<UUID>();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop() as UUID;
    for (const child of byParent.get(id) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/** Hoeveel lagen een map zelf meeneemt: zonder submappen 1. */
export function subtreeHeight(folders: readonly FolderLike[], folderId: UUID): number {
  const walk = (id: UUID, guard: number): number => {
    if (guard > 50) return 1;
    let deepest = 0;
    for (const child of folders) if (child.parent_id === id) deepest = Math.max(deepest, walk(child.id, guard + 1));
    return 1 + deepest;
  };
  return walk(folderId, 0);
}

/**
 * Wat er mis is met een naam op deze plek, of null als hij kan. `siblings`
 * zijn de mappen die op dezelfde plek staan; `exceptId` is de map zelf bij
 * hernoemen (zijn oude naam is geen dubbele).
 */
export function folderNameProblem(
  name: string,
  siblings: readonly Pick<FolderLike, 'id' | 'name'>[],
  exceptId: UUID | null = null,
): string | null {
  const clean = cleanFolderName(name);
  if (!clean) return 'Geef de map een naam.';
  if (clean.length > MAX_FOLDER_NAME) return `Een mapnaam is hooguit ${MAX_FOLDER_NAME} tekens.`;
  const lower = clean.toLocaleLowerCase('nl');
  if (siblings.some(s => s.id !== exceptId && cleanFolderName(s.name).toLocaleLowerCase('nl') === lower)) {
    return `Er staat al een map "${clean}" op deze plek.`;
  }
  return null;
}

/** Kan er onder deze map (of bovenaan, met `null`) nog een map bij? */
export function canCreateFolderIn(folders: readonly FolderLike[], parentId: UUID | null): boolean {
  if (!parentId) return true;
  return folderDepth(folders, parentId) < MAX_FOLDER_DEPTH;
}

/**
 * Waarom een map niet naar deze plek kan (null = het mag). `targetParentId`
 * null is bovenaan bij de klant. Dezelfde plek als nu telt als "kan niet":
 * de knop doet dan niets, en dat hoort hij te zeggen.
 */
export function moveFolderProblem(folders: readonly FolderLike[], folderId: UUID, targetParentId: UUID | null): string | null {
  const folder = folders.find(f => f.id === folderId);
  if (!folder) return 'Deze map bestaat niet meer.';
  if ((folder.parent_id ?? null) === targetParentId) return 'De map staat hier al.';
  if (targetParentId === folderId) return 'Een map kan niet in zichzelf.';
  if (targetParentId && descendantFolderIds(folders, folderId).has(targetParentId)) return 'Een map kan niet in een van zijn eigen submappen.';
  if (targetParentId) {
    const target = folders.find(f => f.id === targetParentId);
    if (!target || target.client_id !== folder.client_id) return 'Een map blijft bij dezelfde klant.';
    if (folderDepth(folders, targetParentId) + subtreeHeight(folders, folderId) > MAX_FOLDER_DEPTH) {
      return `Dan wordt het dieper dan ${MAX_FOLDER_DEPTH} lagen.`;
    }
  }
  const siblings = folders.filter(f => (f.parent_id ?? null) === targetParentId && f.client_id === folder.client_id);
  const clash = folderNameProblem(folder.name, siblings, folder.id);
  return clash ? `Daar staat al een map "${cleanFolderName(folder.name)}".` : null;
}

/** Een gesprek in de boom: alleen wat de boom nodig heeft. */
export interface FolderItem {
  /** De map uit de database; een onbekende (net verwijderde) map telt als "Zonder map". */
  folderId: UUID | null;
  unread: number;
}

/** De map waar een gesprek écht in staat, gegeven de mappen die we kennen. */
export function effectiveFolderId(folderId: UUID | null | undefined, known: ReadonlySet<UUID> | ReadonlyMap<UUID, unknown>): UUID | null {
  return folderId && known.has(folderId) ? folderId : null;
}

export interface FolderCount {
  /** Gesprekken in deze map én alle submappen. */
  total: number;
  /** Ongelezen berichten in deze map én alle submappen. */
  unread: number;
}

/**
 * Tellers per map, inclusief alles wat eronder staat. Een dichtgeklapte map
 * met een ongelezen antwoord diep in een submap moet dat laten zien — anders
 * mis je het antwoord van de klant omdat het "opgeruimd" was.
 */
export function folderCounts(folders: readonly FolderLike[], items: readonly FolderItem[]): { byFolder: Map<UUID, FolderCount>; unfiled: FolderCount } {
  const byId = new Map(folders.map(f => [f.id, f] as const));
  const byFolder = new Map<UUID, FolderCount>(folders.map(f => [f.id, { total: 0, unread: 0 }]));
  const unfiled: FolderCount = { total: 0, unread: 0 };
  for (const item of items) {
    const unread = Math.max(0, item.unread);
    let cursor = effectiveFolderId(item.folderId, byId);
    if (!cursor) { unfiled.total += 1; unfiled.unread += unread; continue; }
    for (let guard = 0; cursor && guard < 50; guard += 1) {
      const count = byFolder.get(cursor);
      if (!count) break;
      count.total += 1;
      count.unread += unread;
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
  }
  return { byFolder, unfiled };
}

/** Eén regel in de boom: een map, of een gesprek op zijn plek. */
export type FolderTreeRow<T> =
  | { kind: 'folder'; folder: ClientEmailFolder; depth: number; expanded: boolean; hasChildren: boolean; count: FolderCount }
  | { kind: 'item'; item: T; depth: number; folderId: UUID | null };

/**
 * De mappenboom van één klant als platte lijst regels, in de volgorde waarin
 * ze op het scherm staan: per laag eerst de mappen (op naam), dan de
 * gesprekken (in de volgorde van `items`, dus nieuwste bovenaan). Gesprekken
 * zonder map staan onderaan, op de bovenste laag.
 *
 * Tijdens zoeken of filteren (`filtering`) gaan mappen zonder treffers uit
 * beeld en klappen mappen mét treffers vanzelf open: wie "factuur 2025" zoekt,
 * wil het gesprek zien, niet vijf dichte mappen waar het misschien in zit.
 * Zonder filter staat elke map er, ook een lege — die heb je net gemaakt.
 */
export function buildFolderRows<T extends FolderItem>(
  folders: readonly ClientEmailFolder[],
  items: readonly T[],
  options: { expanded: ReadonlySet<UUID>; filtering: boolean },
): FolderTreeRow<T>[] {
  const byId = new Map(folders.map(f => [f.id, f] as const));
  const { byFolder } = folderCounts(folders, items);
  const itemsByFolder = new Map<UUID | null, T[]>();
  for (const item of items) {
    const key = effectiveFolderId(item.folderId, byId);
    const list = itemsByFolder.get(key) ?? [];
    list.push(item);
    itemsByFolder.set(key, list);
  }
  const rows: FolderTreeRow<T>[] = [];
  const walk = (parentId: UUID | null, depth: number) => {
    for (const folder of childFolders(folders, parentId) as ClientEmailFolder[]) {
      const count = byFolder.get(folder.id) ?? { total: 0, unread: 0 };
      if (options.filtering && count.total === 0) continue;
      const hasChildren = folders.some(f => f.parent_id === folder.id) || (itemsByFolder.get(folder.id)?.length ?? 0) > 0;
      const expanded = options.filtering ? true : options.expanded.has(folder.id);
      rows.push({ kind: 'folder', folder, depth, expanded, hasChildren, count });
      if (expanded && depth < 50) walk(folder.id, depth + 1);
    }
    for (const item of itemsByFolder.get(parentId) ?? []) rows.push({ kind: 'item', item, depth, folderId: parentId });
  };
  walk(null, 0);
  return rows;
}

/**
 * Opties voor een keuzelijst ("Verplaatsen naar…"): de boom als lijst met de
 * laag erbij, zodat het venster kan inspringen. Mappen die je niet kunt kiezen
 * (de map zelf bij verplaatsen, of zijn submappen) staan er wel, uitgegrijsd
 * met de reden — een lijst die stiekem korter is dan de boom, verwart.
 */
export interface FolderOption {
  id: UUID;
  name: string;
  depth: number;
  disabledReason: string | null;
}

export function folderOptions(
  folders: readonly ClientEmailFolder[],
  disabled: (folder: ClientEmailFolder) => string | null = () => null,
): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (parentId: UUID | null, depth: number) => {
    for (const folder of childFolders(folders, parentId) as ClientEmailFolder[]) {
      out.push({ id: folder.id, name: folder.name, depth, disabledReason: disabled(folder) });
      if (depth < 50) walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * Wat er gebeurt als je deze map verwijdert, in gewone woorden voor het
 * bevestigingsvenster. Er gaat niets verloren: de inhoud schuift één laag
 * omhoog (zie delete_client_email_folder).
 */
export function deleteFolderSummary(
  folders: readonly FolderLike[],
  folderId: UUID,
  threadCount: number,
): string {
  const folder = folders.find(f => f.id === folderId);
  const parent = folder?.parent_id ? folders.find(f => f.id === folder.parent_id) : null;
  const destination = parent ? `de map "${parent.name}"` : '"Zonder map"';
  const subfolders = folders.filter(f => f.parent_id === folderId).length;
  const parts: string[] = [];
  if (threadCount > 0) parts.push(threadCount === 1 ? '1 gesprek' : `${threadCount} gesprekken`);
  if (subfolders > 0) parts.push(subfolders === 1 ? '1 submap' : `${subfolders} submappen`);
  if (parts.length === 0) return 'De map is leeg. Er verdwijnt alleen de map zelf.';
  return `${parts.join(' en ')} ${threadCount + subfolders === 1 ? 'gaat' : 'gaan'} naar ${destination}. Er gaat geen mail verloren.`;
}
