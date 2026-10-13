import { useEffect, useMemo, useState } from 'react';
import { FileText, Folder, Send, StickyNote, Trash2, UserRound, Users } from 'lucide-react';
import type { AppData, DriveShare, DriveShareItemType, UUID } from '../types';
import { Modal } from './Modal';
import { Button } from './Ui';
import { TransferList } from './TransfersPanel';
import { dateNL } from '../lib/format';
import { supabaseAuth } from '../lib/supabase';
import { revokeDriveShare } from '../lib/repository';
import { SHARE_ITEM_LABEL, isShareActive, shareChannelLabel, shareRecipientLabel } from '../lib/shares';

/**
 * "Wat staat er buiten de deur?" — twee lijsten in één venster:
 *  - Gedeeld: lopende delingen (toegang tot een map of bestand, live), per item.
 *  - Verzonden: zendingen (een vaste set bestanden met een vervaldatum), met wie
 *    ze heeft geopend en gedownload.
 * Zonder dit venster kun je een deling alleen terugvinden door eerst het bestand
 * terug te vinden, en dat is precies wat je niet meer weet als je je afvraagt
 * of iets nog buiten de deur ligt.
 */
export function SharedOverview({
  data, organizationId, canWrite, onClose, onChanged, initialTab = 'shared', clientId = null, initialTransferId = null,
}: {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
  initialTab?: 'shared' | 'sent';
  /** Alleen de zendingen van deze klant (klantdossier). */
  clientId?: UUID | null;
  initialTransferId?: UUID | null;
}) {
  const [tab, setTab] = useState<'shared' | 'sent'>(initialTransferId ? 'sent' : initialTab);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<UUID | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabaseAuth.getUser().then(({ data: auth }) => { if (!cancelled) setCurrentUserId(auth.user?.id ?? null); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const groups = useMemo(() => {
    const byItem = new Map<string, { type: DriveShareItemType; id: string; name: string; clientName: string | null; shares: DriveShare[] }>();
    for (const share of data.driveShares) {
      if (!isShareActive(share)) continue;
      if (clientId && share.client_id !== clientId) continue;
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
  }, [data, clientId]);

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
    title="Gedeeld en verzonden"
    className="share-modal"
    onClose={onClose}
    footer={<Button onClick={onClose}>Sluiten</Button>}
  >
    <div className="xfer-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'shared'} className={tab === 'shared' ? 'active' : undefined} onClick={() => setTab('shared')}>
        <Users size={14} /> Gedeeld{total > 0 ? ` (${total})` : ''}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'sent'} className={tab === 'sent' ? 'active' : undefined} onClick={() => setTab('sent')}>
        <Send size={14} /> Verzonden
      </button>
    </div>

    {tab === 'sent'
      ? <TransferList data={data} organizationId={organizationId} clientId={clientId} currentUserId={currentUserId} canWrite={canWrite} onChanged={onChanged} initialTransferId={initialTransferId} />
      : <>
          <p className="share-lede">
            {total === 0
              ? 'Er staat op dit moment niets gedeeld.'
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
        </>}
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

/** Knop voor de drive-balk: opent het overzicht en toont hoeveel er gedeeld is. */
export function SharedOverviewButton({ data, onOpen }: { data: AppData; onOpen: () => void }) {
  const count = useMemo(() => data.driveShares.filter(share => isShareActive(share)).length, [data.driveShares]);
  return <button type="button" className="odrv-tool" onClick={onOpen} title="Bekijk wat er gedeeld en verzonden is">
    <Users size={14} /> <span className="odrv-tool-label">Gedeeld &amp; verzonden</span> {count > 0 && <span className="odrv-pop-count">{count}</span>}
  </button>;
}
