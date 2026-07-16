import { getAccessToken, getWorkerBase, deleteR2Object } from './r2-api';
import { createAttachment } from './repository';
import type { Attachment, UUID } from '../types';

/**
 * Online Office-bewerken: opent office-bestanden uit R2 in een zelf-gehoste Collabora-editor
 * (WOPI). De media-api Worker is de WOPI-host; het bestand blijft canoniek op R2.
 */

const OFFICE_EDITABLE_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]);

const OFFICE_EDITABLE_EXT = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt']);

/** Is dit bestand online bewerkbaar (Word/Excel/PowerPoint/ODF)? */
export function isOfficeEditable(att: Attachment): boolean {
  if (OFFICE_EDITABLE_MIME.has(att.mime_type)) return true;
  const ext = att.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return Boolean(ext && OFFICE_EDITABLE_EXT.has(ext));
}

export type OfficeSession = {
  editorUrl: string;
  accessToken: string;
  accessTokenTtl: number;
  /** Absolute vervaltijd (epoch-ms) van het token, server-bepaald — gebruik dit i.p.v. Date.now()+ttl. */
  accessTokenExp: number;
  fileName: string;
  canWrite: boolean;
};

export type NewOfficeType = 'docx' | 'xlsx' | 'pptx';

export const NEW_OFFICE_LABEL: Record<NewOfficeType, string> = {
  docx: 'Word-document',
  xlsx: 'Excel-werkblad',
  pptx: 'PowerPoint-presentatie',
};

async function errText(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error || `${fallback} (${res.status})`;
  } catch {
    return `${fallback} (${res.status})`;
  }
}

/** Bouw een bewerksessie voor een bestaand office-bestand. */
export async function createOfficeSession(att: Attachment): Promise<OfficeSession> {
  const base = getWorkerBase();
  const token = await getAccessToken();
  const res = await fetch(`${base}/office/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ attachmentId: att.id }),
  });
  if (!res.ok) throw new Error(await errText(res, 'Kon de editor niet openen'));
  return (await res.json()) as OfficeSession;
}

/** Maak een nieuw, leeg office-bestand in een map en geef de aangemaakte bijlage terug. */
export async function createOfficeDocument(
  organizationId: UUID,
  folderId: UUID,
  docType: NewOfficeType,
  name: string,
): Promise<Attachment> {
  const base = getWorkerBase();
  const token = await getAccessToken();
  const res = await fetch(`${base}/office/new`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId, folderId, docType, name }),
  });
  if (!res.ok) throw new Error(await errText(res, 'Kon geen nieuw document aanmaken'));
  const created = (await res.json()) as { key: string; size_bytes: number; mime_type: string; name: string };

  // De attachments-rij maken we (RLS-conform, created_by = auth.uid()) net als bij een upload.
  try {
    return await createAttachment(organizationId, {
      entity_type: 'folder',
      entity_id: folderId,
      name: created.name,
      mime_type: created.mime_type,
      size_bytes: created.size_bytes,
      storage_key: created.key,
    });
  } catch (error) {
    await deleteR2Object(created.key).catch((cleanupErr) => {
      // Best-effort opruiming; log de sleutel zodat een eventueel weesbestand te reconciliëren is.
      console.warn('Office-sjabloon opruimen mislukt na createAttachment-fout (mogelijk weesbestand in R2):', created.key, cleanupErr);
    });
    throw error;
  }
}
