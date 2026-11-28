// ============================================================
// De prullenbak van pagina's (stap 1A-5b, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §4).
//
// Een weggegooide pagina is voor iedereen onzichtbaar (een restrictive policy,
// migratie 20261128100000); alleen hier staat ze nog, 30 dagen lang. Per keer
// weggooien één regel: de pagina die je weggooide, met hoeveel subpagina's er
// tegelijk mee gingen. Terugzetten zet ze samen terug. Na 30 dagen ruimt de
// database ze op, met hun bijlagen.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { deletePageForever, listPageTrash, restorePage, type PageTrashItem } from '../lib/repository';
import { useBackStep } from '../lib/useBackStep';

function dayLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysLeft(purgeOn: string): number {
  return Math.max(0, Math.ceil((new Date(purgeOn).getTime() - Date.now()) / 86_400_000));
}

export function PageTrashButton({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="odrv-tool" onClick={onOpen} title="Weggegooide pagina's, 30 dagen terug te zetten">
    <Trash2 size={14} /> <span className="odrv-tool-label">Prullenbak</span>
  </button>;
}

export function PageTrash({ organizationId, canWrite, clientId, onClose, onChanged }: {
  organizationId: string;
  canWrite: boolean;
  /** In een klantdossier alleen de pagina's van die klant. */
  clientId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<PageTrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useBackStep(true, onClose);

  const load = useCallback(() => {
    listPageTrash(organizationId)
      .then(rows => setItems(clientId ? rows.filter(row => row.client_id === clientId) : rows))
      .catch(e => setError(e instanceof Error ? e.message : 'De prullenbak kon niet worden geladen.'));
  }, [organizationId, clientId]);
  useEffect(load, [load]);

  const act = async (item: PageTrashItem, how: 'terug' | 'weg') => {
    if (how === 'weg' && !window.confirm(`"${item.title || 'Naamloze pagina'}"${item.subpages ? ` en ${item.subpages === 1 ? 'zijn subpagina' : `zijn ${item.subpages} subpagina's`}` : ''} definitief verwijderen? Dit kun je niet terugdraaien.`)) return;
    setBusy(item.id); setError(null);
    try {
      if (how === 'terug') await restorePage(item.id);
      else await deletePageForever(item.id);
      onChanged();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : how === 'terug' ? 'Terugzetten is niet gelukt.' : 'Verwijderen is niet gelukt.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-bg" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal page-trash" role="dialog" aria-modal="true" aria-label="Prullenbak">
        <div className="modal-head">
          <h3>Prullenbak</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Sluiten"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="page-trash-intro">Weggegooide pagina's blijven hier 30 dagen. Daarna zijn ze definitief weg, met hun subpagina's en bijlagen.</p>
          {error && <div className="error">{error}</div>}
          {!error && items === null && <p className="page-trash-empty">Laden…</p>}
          {items?.length === 0 && <p className="page-trash-empty">De prullenbak is leeg.</p>}
          {items && items.length > 0 && <ul className="page-trash-list">
            {items.map(item => {
              const left = daysLeft(item.purge_on);
              return <li key={item.id} className="page-trash-item">
                <div className="page-trash-text">
                  <strong>{item.title || 'Naamloze pagina'}</strong>
                  <span>
                    Weggegooid op {dayLabel(item.archived_at)}
                    {item.subpages > 0 && ` · met ${item.subpages === 1 ? '1 subpagina' : `${item.subpages} subpagina's`}`}
                    {` · nog ${left === 1 ? '1 dag' : `${left} dagen`}`}
                  </span>
                </div>
                {canWrite && <div className="page-trash-actions">
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => void act(item, 'terug')}><RotateCcw size={14} />Terugzetten</button>
                  <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void act(item, 'weg')}><Trash2 size={14} />Definitief verwijderen</button>
                </div>}
              </li>;
            })}
          </ul>}
        </div>
      </section>
    </div>
  );
}
