/**
 * Slepen, selecteren en verplaatsen in de verkenner (Inhoud én het klantdossier).
 *
 * Drie dingen wonen hier: het doorgeven van wat je vastpakt (de sleeplading),
 * het bepalen waar een item nú ligt (`driveItemLocation`) en het bepalen wat er
 * mag landen (`planDriveMove`). Die laatste twee zijn bewust pure functies zonder
 * React of database: het is de plek waar "een map kan niet in zichzelf", "een
 * bestand moet in een map staan" en "een map hoort bij een klant" vastliggen —
 * precies het soort regel dat je wilt kunnen testen zonder een browser.
 */

export type DriveDragKind = 'folder' | 'note' | 'document' | 'attachment';

export type DriveDragItem = {
  kind: DriveDragKind;
  id: string;
  name: string;
};

/**
 * Een plek in de verkenner: klant → (project) → (map). Alles `null` is "Geen
 * klant": losse inhoud zonder dossier. `folderId` zonder `clientId` bestaat niet,
 * want mappen leven altijd onder een klant.
 */
export type DriveLocation = {
  clientId: string | null;
  projectId: string | null;
  folderId: string | null;
};

export function sameLocation(a: DriveLocation, b: DriveLocation): boolean {
  return (a.clientId ?? null) === (b.clientId ?? null)
    && (a.projectId ?? null) === (b.projectId ?? null)
    && (a.folderId ?? null) === (b.folderId ?? null);
}

/** Eigen mime-type, zodat een sleep uit de verkenner herkenbaar is naast bestanden uit de Verkenner van Windows. */
export const DRIVE_DRAG_MIME = 'application/x-resofly-drive';

/**
 * Tijdens `dragover` mag de browser de lading niet laten lezen (alleen de
 * type-lijst), maar we willen dán al weten of dit doel geldig is — je kunt een
 * map niet in zichzelf laten vallen. Daarom houden we de lopende sleep ook hier
 * vast; het gaat altijd om één sleep tegelijk binnen hetzelfde tabblad.
 */
let active: DriveDragItem[] | null = null;

export function beginDriveDrag(transfer: DataTransfer, items: DriveDragItem[]): void {
  active = items;
  try {
    transfer.setData(DRIVE_DRAG_MIME, JSON.stringify(items));
    // Sommige browsers slepen niets zonder een text/plain-variant.
    transfer.setData('text/plain', items.map(i => i.name).join(', '));
  } catch {
    // Lukt setData niet, dan draagt `active` hierboven de sleep alsnog.
  }
  transfer.effectAllowed = 'move';
}

export function endDriveDrag(): void {
  active = null;
}

/** De lopende sleep — beschikbaar tijdens dragover, waar de lading zelf nog op slot zit. */
export function activeDriveDrag(): DriveDragItem[] | null {
  return active;
}

/** De lading bij een drop. Valt terug op de lopende sleep als de browser niets teruggeeft. */
export function readDriveDrag(transfer: DataTransfer): DriveDragItem[] {
  try {
    const raw = transfer.getData(DRIVE_DRAG_MIME);
    if (raw) {
      const parsed = JSON.parse(raw) as DriveDragItem[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // Val terug op de lopende sleep.
  }
  return active ?? [];
}

/** Sleept iemand bestanden van zijn eigen computer hierheen? Dan is het een upload, geen verplaatsing. */
export function dragHasFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = Array.from(transfer.types ?? []);
  return types.includes('Files') && !types.includes(DRIVE_DRAG_MIME);
}

/** Sleept iemand iets uit de verkenner zelf? */
export function dragHasDriveItems(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  if (Array.from(transfer.types ?? []).includes(DRIVE_DRAG_MIME)) return true;
  return (active?.length ?? 0) > 0;
}

// ── Waar ligt een item nu? ──────────────────────────────────────────────────

/** Het stukje van `AppData` dat nodig is om een item te plaatsen. Zo blijft dit testbaar met verzonnen data. */
export type DriveLocationSource = {
  folders: ReadonlyArray<{ id: string; client_id: string | null; project_id?: string | null; parent_id: string | null }>;
  projects: ReadonlyArray<{ id: string; client_id: string | null }>;
  notes: ReadonlyArray<{ id: string; client_id: string | null; project_id: string | null; folder_id?: string | null }>;
  documents: ReadonlyArray<{ id: string; client_id: string | null; project_id: string | null; folder_id?: string | null }>;
  attachments: ReadonlyArray<{ id: string; entity_type: string; entity_id: string }>;
};

/**
 * Dezelfde plaatsingsregels als de verkenner zelf: een map ligt in zijn
 * bovenliggende map binnen zijn eigen klant/projectscope; een bestand ligt in de
 * map waar het aan hangt; een notitie of document ligt in zijn map als het er een
 * heeft, en anders bij zijn project (en dus bij de klant van dát project) of bij
 * zijn klant. `null` = het item is niet (meer) te vinden.
 */
export function driveItemLocation(source: DriveLocationSource, item: DriveDragItem): DriveLocation | null {
  const inFolder = (folderId: string): DriveLocation | null => {
    const folder = source.folders.find(f => f.id === folderId);
    return folder ? { clientId: folder.client_id ?? null, projectId: folder.project_id ?? null, folderId: folder.id } : null;
  };

  if (item.kind === 'folder') {
    const folder = source.folders.find(f => f.id === item.id);
    return folder ? { clientId: folder.client_id ?? null, projectId: folder.project_id ?? null, folderId: folder.parent_id ?? null } : null;
  }
  if (item.kind === 'attachment') {
    const att = source.attachments.find(a => a.id === item.id);
    return att && att.entity_type === 'folder' ? inFolder(att.entity_id) : null;
  }

  const row = item.kind === 'note'
    ? source.notes.find(n => n.id === item.id)
    : source.documents.find(d => d.id === item.id);
  if (!row) return null;
  if (row.folder_id) {
    const loc = inFolder(row.folder_id);
    if (loc) return loc;
  }
  const project = row.project_id ? source.projects.find(p => p.id === row.project_id) : undefined;
  if (project) return { clientId: project.client_id ?? null, projectId: project.id, folderId: null };
  return { clientId: row.client_id ?? null, projectId: null, folderId: null };
}

// ── Wat mag er landen? ──────────────────────────────────────────────────────

export type DriveMovePlan = {
  /** Wat er daadwerkelijk verplaatst wordt. */
  moves: DriveDragItem[];
  /** Wat hier niet heen kan, met de reden die de gebruiker te zien krijgt. */
  blocked: Array<{ item: DriveDragItem; reason: string }>;
  /** Wat hier al lag. Stil overslaan: er is niets misgegaan, er valt niets te doen. */
  unchanged: DriveDragItem[];
};

export type DriveMoveContext = {
  /** Waar ligt dit item nu? `null` = onbekend; dan gaan we ervan uit dat het verhuist. */
  locationOf: (item: DriveDragItem) => DriveLocation | null;
  /** Alle mappen ónder deze map, hoe diep ook. */
  descendantIds: (folderId: string) => string[];
};

/**
 * Bepaalt wat er gebeurt als je deze items op deze plek laat vallen — een map in
 * dezelfde klant, een andere klant, een projectmap of "Geen klant".
 */
export function planDriveMove(
  items: DriveDragItem[],
  target: DriveLocation,
  ctx: DriveMoveContext,
): DriveMovePlan {
  const plan: DriveMovePlan = { moves: [], blocked: [], unchanged: [] };

  for (const item of items) {
    if (item.kind === 'attachment' && !target.folderId) {
      // Een geüpload bestand hangt aan een map (attachments.entity_id); buiten een
      // map is er niets om het aan vast te maken.
      plan.blocked.push({ item, reason: `“${item.name}” moet in een map blijven staan.` });
      continue;
    }
    if (item.kind === 'folder') {
      if (!target.clientId) {
        // Mappen leven onder een klant; "Geen klant" kent geen mappenniveau.
        plan.blocked.push({ item, reason: `“${item.name}” moet bij een klant blijven.` });
        continue;
      }
      if (item.id === target.folderId) {
        plan.blocked.push({ item, reason: `“${item.name}” kan niet in zichzelf.` });
        continue;
      }
      if (target.folderId && ctx.descendantIds(item.id).includes(target.folderId)) {
        plan.blocked.push({ item, reason: `“${item.name}” kan niet in een van zijn eigen submappen.` });
        continue;
      }
    }
    const here = ctx.locationOf(item);
    if (here && sameLocation(here, target)) {
      plan.unchanged.push(item);
      continue;
    }
    plan.moves.push(item);
  }

  return plan;
}

/** "3 items" / "1 item" — één plek, zodat de teller overal hetzelfde leest. */
export function itemCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/** Wat er in de sleepschaduw en op de knoppen staat als je meerdere dingen vastpakt. */
export function dragLabel(items: DriveDragItem[]): string {
  if (items.length === 1) return items[0].name;
  return itemCountLabel(items.length);
}
