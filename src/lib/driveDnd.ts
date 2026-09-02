/**
 * Slepen en selecteren in de verkenner (Inhoud én het klantdossier).
 *
 * Twee dingen wonen hier: het doorgeven van wat je vastpakt (de sleeplading) en
 * het bepalen wat er mag landen (`planDriveMove`). Die tweede is bewust een pure
 * functie zonder React of database: het is de plek waar "een map kan niet in
 * zichzelf" en "een bestand moet in een map staan" vastliggen, en dat is precies
 * het soort regel dat je wilt kunnen testen zonder een browser.
 */

export type DriveDragKind = 'folder' | 'note' | 'document' | 'attachment';

export type DriveDragItem = {
  kind: DriveDragKind;
  id: string;
  name: string;
};

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

export type DriveMovePlan = {
  /** Wat er daadwerkelijk verplaatst wordt. */
  moves: DriveDragItem[];
  /** Wat hier niet heen kan, met de reden die de gebruiker te zien krijgt. */
  blocked: Array<{ item: DriveDragItem; reason: string }>;
  /** Wat hier al lag. Stil overslaan: er is niets misgegaan, er valt niets te doen. */
  unchanged: DriveDragItem[];
};

export type DriveMoveContext = {
  /** In welke map ligt dit item nu? `null` = op het niveau erboven (klant/project). */
  currentFolderId: (item: DriveDragItem) => string | null;
  /** Alle mappen ónder deze map, hoe diep ook. */
  descendantIds: (folderId: string) => string[];
};

/**
 * Bepaalt wat er gebeurt als je deze items in deze map laat vallen.
 * `targetFolderId === null` betekent: de wortel van waar je nu bent (de klant- of
 * projectmap zelf), niet "nergens".
 */
export function planDriveMove(
  items: DriveDragItem[],
  targetFolderId: string | null,
  ctx: DriveMoveContext,
): DriveMovePlan {
  const plan: DriveMovePlan = { moves: [], blocked: [], unchanged: [] };

  for (const item of items) {
    if (item.kind === 'attachment' && targetFolderId === null) {
      // Een geüpload bestand hangt aan een map (attachments.entity_id); buiten een
      // map is er niets om het aan vast te maken.
      plan.blocked.push({ item, reason: `“${item.name}” moet in een map blijven staan.` });
      continue;
    }
    if (item.kind === 'folder') {
      if (item.id === targetFolderId) {
        plan.blocked.push({ item, reason: `“${item.name}” kan niet in zichzelf.` });
        continue;
      }
      if (targetFolderId && ctx.descendantIds(item.id).includes(targetFolderId)) {
        plan.blocked.push({ item, reason: `“${item.name}” kan niet in een van zijn eigen submappen.` });
        continue;
      }
    }
    if (ctx.currentFolderId(item) === targetFolderId) {
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
