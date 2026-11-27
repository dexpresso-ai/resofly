import type { AppData, Attachment, DriveShare, DriveShareItemType, UUID } from '../types';

/**
 * Helpers rond "bestanden delen". De regel die telt — een klantgerelateerd item
 * mag alleen naar een geregistreerde contactpersoon van diezelfde klant — wordt
 * door de database afgedwongen (trigger `drive_shares_guard`). Wat hier staat is
 * de spiegel daarvan: precies dezelfde afleiding, maar dan zodat het scherm de
 * juiste ontvangers laat zien in plaats van de gebruiker in een foutmelding te
 * laten lopen.
 */

/** Waar een drive-item bij hoort. `clientId` gevuld = klantgerelateerd. */
export type ShareTargetContext = {
  clientId: UUID | null;
  projectId: UUID | null;
  clientName: string | null;
};

/** Het item dat op het punt staat gedeeld te worden. */
export type ShareTarget = {
  type: DriveShareItemType;
  id: UUID;
  name: string;
};

export const SHARE_ITEM_LABEL: Record<DriveShareItemType, string> = {
  folder: 'Map',
  attachment: 'Bestand',
  note: 'Notitie',
  document: 'Document',
};

/**
 * Leidt klant + project af uit een drive-item — dezelfde regels als
 * `public.drive_item_client()`: hangt er een project aan, dan telt de klant van
 * dát project, niet een eventueel afwijkende klantkoppeling op het item zelf.
 */
export function resolveShareContext(data: AppData, type: DriveShareItemType, id: UUID): ShareTargetContext {
  const raw = rawContext(data, type, id);
  let clientId = raw.clientId;
  const projectId = raw.projectId;
  if (projectId) {
    const project = data.projects.find(p => p.id === projectId);
    if (project) clientId = project.client_id ?? clientId;
  }
  const clientName = clientId ? data.clients.find(c => c.id === clientId)?.name ?? null : null;
  return { clientId: clientId ?? null, projectId: projectId ?? null, clientName };
}

function rawContext(data: AppData, type: DriveShareItemType, id: UUID): { clientId: UUID | null; projectId: UUID | null } {
  if (type === 'folder') {
    const folder = data.folders.find(f => f.id === id);
    return { clientId: folder?.client_id ?? null, projectId: folder?.project_id ?? null };
  }
  if (type === 'note') {
    const note = data.notes.find(n => n.id === id);
    return { clientId: note?.client_id ?? null, projectId: note?.project_id ?? null };
  }
  if (type === 'document') {
    const doc = data.documents.find(d => d.id === id);
    return { clientId: doc?.client_id ?? null, projectId: doc?.project_id ?? null };
  }
  const att = data.attachments.find(a => a.id === id);
  return att ? attachmentContext(data, att) : { clientId: null, projectId: null };
}

/** Een bijlage kent zelf geen klant; die hangt aan het ding waar hij aan vastzit. */
function attachmentContext(data: AppData, att: Attachment): { clientId: UUID | null; projectId: UUID | null } {
  switch (att.entity_type) {
    case 'folder': {
      const folder = data.folders.find(f => f.id === att.entity_id);
      return { clientId: folder?.client_id ?? null, projectId: folder?.project_id ?? null };
    }
    case 'client':
      return { clientId: att.entity_id, projectId: null };
    case 'project': {
      const project = data.projects.find(p => p.id === att.entity_id);
      return { clientId: project?.client_id ?? null, projectId: project?.id ?? null };
    }
    case 'note': {
      const note = data.notes.find(n => n.id === att.entity_id);
      return { clientId: note?.client_id ?? null, projectId: note?.project_id ?? null };
    }
    case 'document': {
      const doc = data.documents.find(d => d.id === att.entity_id);
      return { clientId: doc?.client_id ?? null, projectId: doc?.project_id ?? null };
    }
    case 'task': {
      const task = data.tasks.find(t => t.id === att.entity_id);
      return { clientId: task?.client_id ?? null, projectId: task?.project_id ?? null };
    }
    case 'ticket': {
      const ticket = data.tickets.find(t => t.id === att.entity_id);
      return { clientId: ticket?.client_id ?? null, projectId: null };
    }
    default:
      return { clientId: null, projectId: null };
  }
}

/** Een deling telt zolang hij niet is ingetrokken en niet is verlopen. */
export function isShareActive(share: DriveShare, now: number = Date.now()): boolean {
  if (share.revoked_at) return false;
  if (!share.expires_at) return true;
  const expires = new Date(share.expires_at).getTime();
  return Number.isNaN(expires) ? true : expires > now;
}

/** De lopende delingen van één item. */
export function activeSharesFor(data: AppData, type: DriveShareItemType, id: UUID): DriveShare[] {
  return data.driveShares.filter(s => s.item_type === type && s.item_id === id && isShareActive(s));
}

/**
 * Snelle index "welke items zijn gedeeld" voor de verkennerrijen. Eén Set met
 * sleutels `type:id`, zodat een rij niet de hele lijst hoeft af te lopen.
 */
export function sharedItemKeys(data: AppData): Set<string> {
  const keys = new Set<string>();
  const now = Date.now();
  for (const share of data.driveShares) {
    if (!isShareActive(share, now)) continue;
    keys.add(`${share.item_type}:${share.item_id}`);
  }
  return keys;
}

export function shareKey(type: DriveShareItemType, id: UUID): string {
  return `${type}:${id}`;
}

/** Menselijke omschrijving van de ontvanger, voor de lijst in het deelvenster. */
export function shareRecipientLabel(share: DriveShare): string {
  const name = share.recipient_name?.trim();
  const email = share.recipient_email?.trim();
  if (name && email) return `${name} · ${email}`;
  return name || email || 'Onbekende ontvanger';
}

/** Waar de ontvanger het item opent. */
export function shareChannelLabel(share: DriveShare): string {
  switch (share.recipient_kind) {
    case 'contact': return 'Klantportaal';
    case 'client': return 'Klantportaal · hoofdadres';
    case 'member': return 'Collega';
    default: return 'Deellink';
  }
}

/** Vervaldatum-keuzes in het deelvenster: de rustige standaardwaarden. */
export const SHARE_EXPIRY_OPTIONS: Array<{ value: string; label: string; days: number | null }> = [
  { value: 'none', label: 'Geen vervaldatum', days: null },
  { value: '7', label: 'Verloopt na 7 dagen', days: 7 },
  { value: '30', label: 'Verloopt na 30 dagen', days: 30 },
  { value: '90', label: 'Verloopt na 90 dagen', days: 90 },
];

export function expiryToIso(option: string): string | null {
  const found = SHARE_EXPIRY_OPTIONS.find(o => o.value === option);
  if (!found || found.days === null) return null;
  const date = new Date();
  date.setDate(date.getDate() + found.days);
  return date.toISOString();
}

// ── Gedeelde mappen vullen zich niet meer vanzelf (20261127120000) ──────────
// Een map delen legt vast wat er op dat moment in staat. Wat er later bij komt,
// ziet de ontvanger pas na "Ook delen". De database meldt per map wat er nog
// ontbreekt (drive_share_folder_gaps); dit maakt er een label en een zin van.

export type FolderShareGapItemType = 'attachment' | 'note' | 'document';

/** Eén item dat direct in de map staat en in een lopende mapdeling ontbreekt. */
export type FolderShareGap = { share_id: UUID; item_type: FolderShareGapItemType; item_id: UUID };

export type FolderShareGapSummary = {
  /** `type:id` van elk item dat in minstens één lopende mapdeling ontbreekt. */
  itemKeys: Set<string>;
  /** Per deling de items die er met "Ook delen" bij komen. */
  byShare: Map<UUID, Array<{ item_type: FolderShareGapItemType; item_id: UUID }>>;
  /** Wie die items nog niet ziet, leesbaar en zonder dubbelen. */
  recipients: string[];
  /** Hoeveel items van elke soort het zijn (elk item één keer geteld). */
  counts: Record<FolderShareGapItemType, number>;
};

export function summarizeFolderShareGaps(gaps: readonly FolderShareGap[], shares: readonly DriveShare[]): FolderShareGapSummary {
  const itemKeys = new Set<string>();
  const byShare = new Map<UUID, Array<{ item_type: FolderShareGapItemType; item_id: UUID }>>();
  const recipients: string[] = [];
  const counts: Record<FolderShareGapItemType, number> = { attachment: 0, note: 0, document: 0 };
  for (const gap of gaps) {
    const key = `${gap.item_type}:${gap.item_id}`;
    if (!itemKeys.has(key)) {
      itemKeys.add(key);
      counts[gap.item_type] += 1;
    }
    const list = byShare.get(gap.share_id) ?? [];
    if (!list.some(item => item.item_type === gap.item_type && item.item_id === gap.item_id)) {
      list.push({ item_type: gap.item_type, item_id: gap.item_id });
    }
    byShare.set(gap.share_id, list);
  }
  for (const shareId of byShare.keys()) {
    const share = shares.find(s => s.id === shareId);
    const label = share ? shareRecipientLabel(share) : 'een ontvanger';
    if (!recipients.includes(label)) recipients.push(label);
  }
  return { itemKeys, byShare, recipients, counts };
}

function joinDutch(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} en ${parts[parts.length - 1]}`;
}

const GAP_NOUNS: Record<FolderShareGapItemType, [string, string]> = {
  attachment: ['bestand', 'bestanden'],
  note: ['notitie', 'notities'],
  document: ['document', 'documenten'],
};

/** De zin boven de map: "2 bestanden en 1 notitie in deze map zijn nog niet gedeeld met …". */
export function folderShareGapText(summary: FolderShareGapSummary): string {
  const order: FolderShareGapItemType[] = ['attachment', 'note', 'document'];
  const parts = order
    .filter(type => summary.counts[type] > 0)
    .map(type => `${summary.counts[type]} ${GAP_NOUNS[type][summary.counts[type] === 1 ? 0 : 1]}`);
  const total = order.reduce((sum, type) => sum + summary.counts[type], 0);
  if (total === 0) return '';
  return `${joinDutch(parts)} in deze map ${total === 1 ? 'is' : 'zijn'} nog niet gedeeld met ${joinDutch(summary.recipients)}.`;
}
