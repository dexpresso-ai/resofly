import { getAccessToken, getWorkerBase, deleteR2Object } from './r2-api';
import { createAttachment } from './repository';
import type { Attachment, InternalDocument, UUID } from '../types';

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

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EXT_TO_MIME: Record<string, string> = {
  docx: DOCX_MIME,
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

/** Bestandskiezer-filter voor office-bestanden die de online editor aankan. */
export const OFFICE_UPLOAD_ACCEPT = '.docx,.xlsx,.pptx,.odt,.ods,.odp,.doc,.xls,.ppt';
/** Zelfde limiet als de PutFile-cap in de media-api Worker. */
export const OFFICE_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Office-mimetype voor een bestand, of null als het geen bewerkbaar office-bestand is. */
export function officeMimeForFile(name: string, type?: string): string | null {
  if (type && OFFICE_EDITABLE_MIME.has(type)) return type;
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? EXT_TO_MIME[ext] ?? null : null;
}

const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_TO_MIME).map(([ext, mime]) => [mime, ext]),
);

/** Downloadnaam voor een Office-modus document: actuele titel + extensie in het native formaat. */
export function officeFileNameForDocument(doc: Pick<InternalDocument, 'title' | 'mime_type'>): string {
  const ext = (doc.mime_type && MIME_TO_EXT[doc.mime_type]) || 'docx';
  const base = (doc.title || 'Document').replace(/[\\/]+/g, ' ').trim() || 'Document';
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/** Download de originele bytes van een Office-modus document (native .docx/.xlsx/.pptx). */
export async function downloadOfficeDocument(documentId: UUID, fileName: string): Promise<void> {
  const base = getWorkerBase();
  const token = await getAccessToken();
  const res = await fetch(`${base}/office/document-file/${documentId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(await errText(res, 'Download mislukt'));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/** Bouw een bewerksessie voor een intern Document dat in Word-modus staat (documents.storage_key gezet). */
export async function createOfficeSessionForDocument(documentId: UUID): Promise<OfficeSession> {
  const base = getWorkerBase();
  const token = await getAccessToken();
  const res = await fetch(`${base}/office/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ documentId }),
  });
  if (!res.ok) throw new Error(await errText(res, 'Kon de editor niet openen'));
  return (await res.json()) as OfficeSession;
}

type OfficeUploadResult = { key: string; size_bytes: number; mime_type: string; name: string };

async function postOfficeDocumentBytes(organizationId: UUID, fileName: string, mime: string, blob: Blob): Promise<OfficeUploadResult> {
  const base = getWorkerBase();
  const token = await getAccessToken();
  const res = await fetch(`${base}/office/document-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-organization-id': organizationId,
      'x-file-name': encodeURIComponent(fileName),
      'x-file-type': mime,
    },
    body: blob,
  });
  if (!res.ok) throw new Error(await errText(res, 'Kon het document niet opslaan'));
  return (await res.json()) as OfficeUploadResult;
}

/**
 * Schrijf de .docx-bytes van een Word-document naar R2 (nieuw of geconverteerd uit rich-text).
 * De documents-rij (met de teruggegeven storage_key) maakt/werkt de aanroeper zelf bij via de repository.
 */
export async function uploadDocumentDocx(organizationId: UUID, name: string, blob: Blob): Promise<OfficeUploadResult> {
  const fileName = name.toLowerCase().endsWith('.docx') ? name : `${name}.docx`;
  return postOfficeDocumentBytes(organizationId, fileName, DOCX_MIME, blob);
}

/** Upload een bestaand Word/Excel/PowerPoint-bestand als basis voor een nieuw (Office-modus) document. */
export async function uploadOfficeDocumentFile(organizationId: UUID, file: File): Promise<OfficeUploadResult> {
  const mime = officeMimeForFile(file.name, file.type);
  if (!mime) throw new Error('Alleen Word-, Excel- of PowerPoint-bestanden kunnen als document geüpload worden.');
  if (file.size > OFFICE_MAX_UPLOAD_BYTES) {
    throw new Error(`Bestand is te groot. Maximum is ${Math.round(OFFICE_MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
  }
  return postOfficeDocumentBytes(organizationId, file.name, mime, file);
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
