import { createAttachment } from './repository';
import { deleteR2Object, getAccessToken, getWorkerBase } from './r2-api';
import type { Attachment, EntityType, UUID } from '../types';

const publicBase = import.meta.env.VITE_R2_PUBLIC_BASE_URL as string | undefined;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

type UploadResponse = { ok: true; key: string } | { error: string };

export { deleteR2Object };

/**
 * Download an attachment to the user's device. Uses the public URL when configured,
 * otherwise fetches via the authenticated Worker endpoint and forces a download via blob URL.
 */
export async function downloadAttachment(att: Attachment): Promise<void> {
  if (publicBase && att.public_url && att.public_url.startsWith(publicBase)) {
    // Public asset — open in a new tab and let the browser save it.
    window.open(att.public_url, '_blank', 'noopener,noreferrer');
    return;
  }
  const base = getWorkerBase();
  const token = await getAccessToken();
  const response = await fetch(`${base}/file/${encodeURIComponent(att.storage_key)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Download mislukt (${response.status})`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = att.name || 'bestand';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

export async function uploadToR2(file: File, organizationId: UUID, ref: { entity_type: EntityType; entity_id: UUID; parent_task_id?: UUID | null }) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Bestand is te groot. Maximum is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
  }
  const base = getWorkerBase();
  const accessToken = await getAccessToken();

  const response = await fetch(`${base}/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'x-file-name': encodeURIComponent(file.name),
      'x-file-type': file.type || 'application/octet-stream',
      'x-organization-id': organizationId,
      'x-entity-type': ref.entity_type,
      'x-entity-id': ref.entity_id,
      ...(ref.parent_task_id ? { 'x-parent-task-id': ref.parent_task_id } : {}),
    },
    body: file,
  });

  const uploadResult = await readJson<UploadResponse>(response);
  if (!response.ok || !('ok' in uploadResult)) {
    throw new Error('error' in uploadResult ? uploadResult.error : 'Upload naar R2 mislukt');
  }

  const key = uploadResult.key;
  const url = publicBase ? `${publicBase.replace(/\/$/, '')}/${key}` : `${base}/file/${encodeURIComponent(key)}`;

  try {
    return await createAttachment(organizationId, {
      ...ref,
      name: file.name,
      mime_type: file.type || 'application/octet-stream',
      size_bytes: file.size,
      storage_key: key,
      public_url: url,
    });
  } catch (error) {
    await deleteR2Object(key).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try { return JSON.parse(text) as T; }
  catch { return { error: text || response.statusText } as T; }
}
