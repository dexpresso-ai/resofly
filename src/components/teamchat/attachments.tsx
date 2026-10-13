import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Download, File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation, Trash2, X,
} from 'lucide-react';
import { downloadAttachment } from '../../lib/r2';
import { getAccessToken, getWorkerBase } from '../../lib/r2-api';
import { deleteAttachment } from '../../lib/repository';
import type { Attachment } from '../../types';
import { formatBytes } from './model';

/**
 * Bijlagen in een bericht zoals Teams ze toont: afbeeldingen als voorbeeld in
 * het bericht, de rest als bestandskaart met een icoon per soort.
 */

const publicBase = import.meta.env.VITE_R2_PUBLIC_BASE_URL as string | undefined;
const imageCache = new Map<string, Promise<string>>();

/** Een afbeelding uit R2 als object-URL (via de beveiligde Worker, met je sessie). */
function loadImageUrl(att: Attachment): Promise<string> {
  const cached = imageCache.get(att.id);
  if (cached) return cached;
  const promise = (async () => {
    if (publicBase && att.public_url && att.public_url.startsWith(publicBase)) return att.public_url;
    const token = await getAccessToken();
    const res = await fetch(`${getWorkerBase()}/file/${encodeURIComponent(att.storage_key)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Afbeelding laden mislukt (${res.status})`);
    return URL.createObjectURL(await res.blob());
  })();
  imageCache.set(att.id, promise);
  promise.catch(() => imageCache.delete(att.id));
  return promise;
}

export function isPreviewableImage(att: Attachment): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(att.mime_type) && att.size_bytes <= 12 * 1024 * 1024;
}

export function FileIcon({ att, size = 22 }: { att: Pick<Attachment, 'mime_type' | 'name'>; size?: number }) {
  const mime = att.mime_type.toLowerCase();
  const ext = att.name.split('.').pop()?.toLowerCase() ?? '';
  let Icon = File;
  let tone = 'default';
  if (mime.startsWith('image/')) { Icon = FileImage; tone = 'image'; }
  else if (mime.startsWith('video/')) { Icon = FileVideo; tone = 'video'; }
  else if (mime.startsWith('audio/')) { Icon = FileAudio; tone = 'audio'; }
  else if (mime.includes('pdf') || ext === 'pdf') { Icon = FileText; tone = 'pdf'; }
  else if (/sheet|excel|csv/.test(mime) || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) { Icon = FileSpreadsheet; tone = 'sheet'; }
  else if (/presentation|powerpoint/.test(mime) || ['ppt', 'pptx', 'odp', 'key'].includes(ext)) { Icon = Presentation; tone = 'slides'; }
  else if (/word|document|text/.test(mime) || ['doc', 'docx', 'odt', 'txt', 'rtf', 'md'].includes(ext)) { Icon = FileText; tone = 'doc'; }
  else if (/zip|rar|7z|tar|gzip/.test(mime) || ['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) { Icon = FileArchive; tone = 'archive'; }
  return <span className={`tmc-file-icon is-${tone}`} aria-hidden="true"><Icon size={size} /></span>;
}

function ImageThumb({ att, onOpen }: { att: Attachment; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadImageUrl(att).then((u) => { if (alive) setUrl(u); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [att]);
  if (failed) return null;
  return (
    <button type="button" className="tmc-image" onClick={() => url && onOpen(url)} aria-label={`${att.name} bekijken`} title={att.name}>
      {url ? <img src={url} alt={att.name} loading="lazy" /> : <span className="tmc-image-skeleton" />}
    </button>
  );
}

export function AttachmentGrid({ attachments, canDelete, onChanged }: {
  attachments: Attachment[];
  canDelete: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ url: string; att: Attachment } | null>(null);
  if (attachments.length === 0) return null;
  const images = attachments.filter(isPreviewableImage);
  const files = attachments.filter((a) => !isPreviewableImage(a));

  async function download(att: Attachment) {
    setError(null); setBusy(att.id);
    try { await downloadAttachment(att); }
    catch (e) { setError(e instanceof Error ? e.message : 'Downloaden mislukt'); }
    finally { setBusy(null); }
  }

  async function remove(att: Attachment) {
    if (!confirm(`"${att.name}" verwijderen? Het bestand verdwijnt voor iedereen in dit gesprek.`)) return;
    setError(null); setBusy(att.id);
    try {
      await deleteAttachment({ id: att.id, storage_key: att.storage_key, organization_id: att.organization_id });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="tmc-atts">
      {images.length > 0 && (
        <div className={`tmc-images is-${Math.min(images.length, 3)}`}>
          {images.map((att) => <ImageThumb key={att.id} att={att} onOpen={(url) => setViewer({ url, att })} />)}
        </div>
      )}
      {files.map((att) => (
        <div key={att.id} className="tmc-file">
          <FileIcon att={att} />
          <button type="button" className="tmc-file-main" onClick={() => void download(att)} disabled={busy === att.id} title={`${att.name} downloaden`}>
            <span className="tmc-file-name">{att.name}</span>
            <span className="tmc-file-meta">{formatBytes(att.size_bytes)}</span>
          </button>
          <button type="button" className="tmc-icon-btn is-small" onClick={() => void download(att)} disabled={busy === att.id} aria-label="Downloaden" title="Downloaden"><Download size={15} /></button>
          {canDelete && <button type="button" className="tmc-icon-btn is-small is-danger" onClick={() => void remove(att)} disabled={busy === att.id} aria-label="Verwijderen" title="Verwijderen"><Trash2 size={15} /></button>}
        </div>
      ))}
      {error && <div className="tmc-inline-error">{error}</div>}
      {viewer && createPortal(
        <div className="tmc tmc-lightbox" role="dialog" aria-modal="true" aria-label={viewer.att.name} onPointerDown={(e) => { if (e.target === e.currentTarget) setViewer(null); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setViewer(null); }}>
          <div className="tmc-lightbox-bar">
            <span>{viewer.att.name}</span>
            <button type="button" className="tmc-icon-btn" onClick={() => void download(viewer.att)} aria-label="Downloaden" title="Downloaden"><Download size={18} /></button>
            <button type="button" className="tmc-icon-btn" autoFocus onClick={() => setViewer(null)} aria-label="Sluiten" title="Sluiten"><X size={20} /></button>
          </div>
          <img src={viewer.url} alt={viewer.att.name} />
        </div>,
        document.body,
      )}
    </div>
  );
}
