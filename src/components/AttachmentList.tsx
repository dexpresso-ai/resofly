import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import type { Attachment, EntityType, UUID } from '../types';
import { downloadAttachment } from '../lib/r2';
import { deleteAttachment } from '../lib/repository';

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function AttachmentList({
  attachments,
  entityType,
  entityId,
  onChanged,
  canDelete = true,
}: {
  attachments: Attachment[];
  entityType: EntityType;
  entityId: UUID;
  onChanged: () => void;
  canDelete?: boolean;
}) {
  const items = attachments.filter(a => a.entity_type === entityType && a.entity_id === entityId);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (items.length === 0) return null;

  async function handleDownload(att: Attachment) {
    setError(null); setBusyId(att.id);
    try { await downloadAttachment(att); }
    catch (e) { setError(e instanceof Error ? e.message : 'Download mislukt'); }
    finally { setBusyId(null); }
  }

  async function handleDelete(att: Attachment) {
    if (!confirm(`"${att.name}" verwijderen?`)) return;
    setError(null); setBusyId(att.id);
    try {
      await deleteAttachment({ id: att.id, storage_key: att.storage_key, organization_id: att.organization_id });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt');
    } finally {
      setBusyId(null);
    }
  }

  return <div className="att-list">
    <div className="att-list-head">Bijlagen ({items.length})</div>
    {items.map(att => <div className="att-item" key={att.id}>
      <div className="att-info">
        <div className="att-name" title={att.name}>{att.name}</div>
        <div className="att-meta">{fmtBytes(att.size_bytes)} · {att.mime_type}</div>
      </div>
      <button
        type="button"
        className="att-btn"
        onClick={() => handleDownload(att)}
        disabled={busyId === att.id}
        title="Downloaden"
      ><Download size={14}/></button>
      {canDelete && <button
        type="button"
        className="att-btn att-btn-danger"
        onClick={() => handleDelete(att)}
        disabled={busyId === att.id}
        title="Verwijderen"
      ><Trash2 size={14}/></button>}
    </div>)}
    {error && <div className="att-error">{error}</div>}
  </div>;
}
