import { useMemo, useState } from 'react';
import { FileText, Folder, StickyNote, Trash2, UserRound, Users } from 'lucide-react';
import type { AppData, DriveShare, DriveShareItemType } from '../types';
import { Modal } from './Modal';
import { Button } from './Ui';
import { dateNL } from '../lib/format';
import { revokeDriveShare } from '../lib/repository';
import { SHARE_ITEM_LABEL, isShareActive, shareChannelLabel, shareRecipientLabel } from '../lib/shares';

/**
 * "Wat hebben we allemaal gedeeld?" — één lijst van alle lopende delingen in deze
 * organisatie, gegroepeerd per item. Zonder dit venster kun je een deling alleen
 * terugvinden door eerst het bestand terug te vinden, en dat is precies wat je
 * niet meer weet als je je afvraagt of iets nog buiten de deur ligt.
 */
export function SharedOverview({
  data, organizationId, canWrite, onClose, onChanged,
}: {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const byItem = new Map<string, { type: DriveShareItemType; id: string; name: string; clientName: string | null; shares: DriveShare[] }>();
    for (const share of data.driveShares) {
      if (!isShareActive(share)) continue;
      const key = `${share.item_type}:${share.item_id}`;
      const existing = byItem.get(key);
      if (existing) { existing.shares.push(share); continue; }
      byItem.set(key, {
        type: share.item_type,
        id: share.item_id,
        name: currentName(data, share.item_type, share.item_id) || share.item_name || 'Naamloos',
        clientName: share.client_id ? data.clients.find(c => c.id === share.client_id)?.name ?? null : null,
        shares: [share],
      });
    }
    return [...byItem.values()].sort((a, b) => a.name.localeCompare(b.name, 'nl', { numeric: true }));
  }, [data]);

  async function revoke(share: DriveShare) {
    if (!window.confirm(`Toegang van ${shareRecipientLabel(share)} intrekken?`)) return;
    setBusyId(share.id); setError(null);
    try {
      await revokeDriveShare(share.id, organizationId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Intrekken mislukt.');
    } finally {
      setBusyId(null);
    }
  }

  const total = groups.reduce((sum, group) => sum + group.shares.length, 0);

  return <Modal
    title="Gedeeld met mensen"
    className="share-modal"
    onClose={onClose}
    footer={<Button onClick={onClose}>Sluiten</Button>}
  >
    <p className="share-lede">
      {total === 0
        ? 'Er staat op dit moment niets buiten de deur.'
        : `${total} ${total === 1 ? 'lopende deling' : 'lopende delingen'} over ${groups.length} ${groups.length === 1 ? 'item' : 'items'}.`}
    </p>

    {error && <p className="error">{error}</p>}

    {groups.map(group => <section className="share-section" key={`${group.type}:${group.id}`}>
      <h4>
        <ItemGlyph type={group.type} />
        {group.name}
        <span className="share-tag">{SHARE_ITEM_LABEL[group.type]}</span>
        {group.clientName && <span className="share-tag"><UserRound size={11} /> {group.clientName}</span>}
      </h4>
      <ul className="share-current">
        {group.shares.map(share => <li key={share.id}>
          <div className="share-current-main">
            <strong>{shareRecipientLabel(share)}</strong>
            <span className="share-person-meta">
              {shareChannelLabel(share)}
              {share.can_download ? ' · mag downloaden' : ' · alleen bekijken'}
              {share.expires_at ? ` · tot ${dateNL(share.expires_at)}` : ''}
              {share.last_viewed_at ? ` · laatst bekeken ${dateNL(share.last_viewed_at)}` : ' · nog niet bekeken'}
            </span>
          </div>
          {canWrite && <div className="share-current-actions">
            <button type="button" className="danger" disabled={busyId === share.id} onClick={() => revoke(share)}>
              <Trash2 size={14} /> Intrekken
            </button>
          </div>}
        </li>)}
      </ul>
    </section>)}
  </Modal>;
}

function ItemGlyph({ type }: { type: DriveShareItemType }) {
  if (type === 'folder') return <Folder size={14} style={{ color: 'var(--accent)' }} />;
  if (type === 'note') return <StickyNote size={14} style={{ color: 'var(--accent-v)' }} />;
  return <FileText size={14} style={{ color: 'var(--accent-b)' }} />;
}

/** De naam zoals die nú is; de snapshot op de deling kan verouderd zijn na hernoemen. */
function currentName(data: AppData, type: DriveShareItemType, id: string): string | null {
  if (type === 'folder') return data.folders.find(f => f.id === id)?.name ?? null;
  if (type === 'note') return data.notes.find(n => n.id === id)?.title ?? null;
  if (type === 'document') return data.documents.find(d => d.id === id)?.title ?? null;
  return data.attachments.find(a => a.id === id)?.name ?? null;
}

/** Knop voor de drive-balk: opent het overzicht en toont hoeveel er loopt. */
export function SharedOverviewButton({ data, onOpen }: { data: AppData; onOpen: () => void }) {
  const count = useMemo(() => data.driveShares.filter(share => isShareActive(share)).length, [data.driveShares]);
  if (count === 0) return null;
  return <button type="button" className="odrv-tool" onClick={onOpen} title="Bekijk en trek delingen in">
    <Users size={14} /> <span className="odrv-tool-label">Gedeeld</span> <span className="odrv-pop-count">{count}</span>
  </button>;
}
