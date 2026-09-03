import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Folder, Info, Search, X } from 'lucide-react';
import type { AppData } from '../types';
import { Modal } from './Modal';
import { Button } from './Ui';
import { childFolders, folderDescendantIds, folderPath } from '../lib/folders';
import {
  dragLabel, driveItemLocation, planDriveMove, type DriveDragItem, type DriveLocation, type DriveMovePlan,
} from '../lib/driveDnd';

/**
 * "Verplaatsen naar…": een kleine verkenner in een venster. Je loopt door
 * bedrijf → klant → project → map, precies zoals in de verkenner zelf, en zet
 * de selectie neer waar je staat. Het venster opent op de plek waar je nú bent,
 * zodat een buurmap één klik ver is en een andere klant twee.
 *
 * Wat er mag staat niet hier maar in `planDriveMove`: dit venster laat alleen
 * zien wat die regels zeggen (knop uit + de reden) in plaats van je in een
 * foutmelding te laten lopen.
 */
type Cursor = { root: true } | { root: false; loc: DriveLocation };

type PickRow = {
  key: string;
  kind: 'client' | 'noclient' | 'project' | 'folder';
  name: string;
  color: string;
  loc: DriveLocation;
  /** Een map die zelf meeverhuist kun je niet als doel kiezen. */
  disabled?: boolean;
};

const KIND_LABEL: Record<PickRow['kind'], string> = {
  client: 'Klantmap',
  noclient: 'Losse inhoud',
  project: 'Projectmap',
  folder: 'Map',
};
/** Dezelfde grijstint als de "Geen klant"-map in de verkenner. */
const NO_CLIENT_COLOR = '#94A3B8';

export function MoveDialog({
  data, items, start, companyName, onClose, onMove,
}: {
  data: AppData;
  items: DriveDragItem[];
  /** Waar de verkenner nu staat; hier opent de kiezer. `null` = de wortel (alle klanten). */
  start: DriveLocation | null;
  companyName: string;
  onClose: () => void;
  /** Voert de verplaatsing uit; `true` = gelukt, dan sluit het venster. */
  onMove: (target: DriveLocation) => Promise<boolean>;
}) {
  const [cursor, setCursor] = useState<Cursor>(() => (start ? { root: false, loc: start } : { root: true }));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const go = (next: Cursor) => { setCursor(next); setQuery(''); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const clientsById = useMemo(() => new Map(data.clients.map(c => [c.id, c] as const)), [data.clients]);
  const projectsById = useMemo(() => new Map(data.projects.map(p => [p.id, p] as const)), [data.projects]);

  // Een map die verhuist (of een van zijn submappen) is geen doel: daar zou hij
  // in zichzelf belanden. Uitgegrijsd in plaats van weggelaten, zodat de lijst
  // niet stiekem anders is dan de verkenner.
  const movingFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'folder') continue;
      ids.add(item.id);
      for (const id of folderDescendantIds(data.folders, item.id)) ids.add(id);
    }
    return ids;
  }, [items, data.folders]);

  // "Geen klant" is alleen een doel voor notities en documenten; mappen en
  // bestanden hebben een klant nodig, dus voor die selecties laten we het weg.
  const canLeaveClient = items.some(i => i.kind === 'note' || i.kind === 'document');

  const rows = useMemo<PickRow[]>(() => {
    if (cursor.root) {
      const list: PickRow[] = [...data.clients]
        .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
        .map(c => ({ key: `c-${c.id}`, kind: 'client', name: c.name, color: c.color || 'var(--accent)', loc: { clientId: c.id, projectId: null, folderId: null } }));
      if (canLeaveClient) list.push({ key: 'noclient', kind: 'noclient', name: 'Geen klant', color: NO_CLIENT_COLOR, loc: { clientId: null, projectId: null, folderId: null } });
      return list;
    }
    const { clientId, projectId, folderId } = cursor.loc;
    const out: PickRow[] = [];
    if (!projectId && !folderId) {
      const projects = data.projects
        .filter(p => (p.client_id ?? null) === clientId && !p.archived)
        .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
      for (const p of projects) out.push({ key: `p-${p.id}`, kind: 'project', name: p.name, color: p.color || 'var(--accent)', loc: { clientId, projectId: p.id, folderId: null } });
    }
    if (clientId) {
      for (const f of childFolders(data.folders, clientId, projectId, folderId)) {
        out.push({ key: `f-${f.id}`, kind: 'folder', name: f.name, color: 'var(--accent)', loc: { clientId, projectId, folderId: f.id }, disabled: movingFolderIds.has(f.id) });
      }
    }
    return out;
  }, [cursor, data.clients, data.projects, data.folders, movingFolderIds, canLeaveClient]);

  const q = query.trim().toLowerCase();
  const shown = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows;

  const crumbs = useMemo(() => {
    const list: Array<{ key: string; label: string; cursor: Cursor }> = [{ key: 'root', label: companyName, cursor: { root: true } }];
    if (cursor.root) return list;
    const { clientId, projectId, folderId } = cursor.loc;
    list.push({
      key: 'client',
      label: clientId ? clientsById.get(clientId)?.name ?? 'Klant' : 'Geen klant',
      cursor: { root: false, loc: { clientId, projectId: null, folderId: null } },
    });
    if (projectId) list.push({
      key: 'project',
      label: projectsById.get(projectId)?.name ?? 'Project',
      cursor: { root: false, loc: { clientId, projectId, folderId: null } },
    });
    if (folderId) for (const f of folderPath(data.folders, folderId)) list.push({
      key: `f-${f.id}`,
      label: f.name,
      cursor: { root: false, loc: { clientId, projectId, folderId: f.id } },
    });
    return list;
  }, [cursor, companyName, clientsById, projectsById, data.folders]);

  const target: DriveLocation | null = cursor.root ? null : cursor.loc;
  const plan: DriveMovePlan | null = useMemo(() => (
    target
      ? planDriveMove(items, target, {
          locationOf: item => driveItemLocation(data, item),
          descendantIds: id => folderDescendantIds(data.folders, id),
        })
      : null
  ), [target, items, data]);

  const targetLabel = crumbs[crumbs.length - 1].label;
  let hint: { tone: 'info' | 'blocked'; text: string };
  if (!plan) hint = { tone: 'info', text: 'Open een klant om een doel te kiezen.' };
  else if (plan.moves.length === 0 && plan.blocked.length > 0) hint = { tone: 'blocked', text: plan.blocked.map(b => b.reason).join(' ') };
  else if (plan.moves.length === 0) hint = { tone: 'info', text: items.length === 1 ? 'Staat hier al.' : 'Alles staat hier al.' };
  else if (plan.blocked.length > 0) hint = { tone: 'blocked', text: `${plan.moves.length} van ${items.length} gaan mee. ${plan.blocked.map(b => b.reason).join(' ')}` };
  else hint = { tone: 'info', text: `Verplaatsen naar “${targetLabel}”.` };
  const canMove = Boolean(plan && plan.moves.length > 0) && !busy;

  async function confirm() {
    if (!target || !canMove) return;
    setBusy(true);
    try {
      if (await onMove(target)) onClose();
    } finally {
      setBusy(false);
    }
  }

  const goUp = () => go(crumbs.length > 1 ? crumbs[crumbs.length - 2].cursor : { root: true });

  return <Modal
    title="Verplaatsen naar"
    className="move-modal"
    onClose={onClose}
    footer={<div className="mv-foot">
      <span className={`mv-hint${hint.tone === 'blocked' ? ' is-blocked' : ''}`} role="status">
        {hint.tone === 'blocked' ? <AlertTriangle size={14} /> : <Info size={14} />}
        <span>{hint.text}</span>
      </span>
      <span className="mv-foot-actions">
        <Button type="button" onClick={onClose}>Annuleren</Button>
        <Button type="button" variant="primary" disabled={!canMove} onClick={() => void confirm()}>{busy ? 'Verplaatsen…' : 'Hierheen verplaatsen'}</Button>
      </span>
    </div>}
  >
    <p className="mv-lede">Verplaats <strong>{dragLabel(items)}</strong> naar de plek waar je hieronder staat. Klik een map open om erin te gaan.</p>
    <nav className="mv-crumbs" aria-label="Doel">
      <button type="button" className="mv-back" onClick={goUp} disabled={cursor.root} aria-label="Eén niveau omhoog"><ChevronLeft size={15} /></button>
      {crumbs.map((c, i) => <span key={c.key} className="mv-crumb-step">
        {i > 0 && <ChevronRight size={14} aria-hidden="true" />}
        {i === crumbs.length - 1
          ? <span className="mv-crumb-current">{c.label}</span>
          : <button type="button" onClick={() => go(c.cursor)}>{c.label}</button>}
      </span>)}
    </nav>
    <label className="drive-search mv-search">
      <Search size={14} aria-hidden="true" />
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder={cursor.root ? 'Zoek klant…' : 'Zoeken in deze map…'} autoComplete="off" aria-label="Zoeken naar een doel" />
      {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
    </label>
    <div className="mv-list">
      {shown.length === 0
        ? <div className="mv-empty">
            {q ? `Niets gevonden voor “${query.trim()}”.` : cursor.root ? 'Nog geen klanten.' : 'Geen mappen hier. Je kunt de selectie wel op dit niveau neerzetten.'}
          </div>
        : shown.map(row => <button
            type="button"
            key={row.key}
            className="mv-row"
            disabled={row.disabled}
            title={row.disabled ? 'Deze map verhuist zelf mee' : undefined}
            onClick={() => go({ root: false, loc: row.loc })}
          >
            <span className="mv-row-ic" style={{ color: row.color }}><Folder size={18} fill="currentColor" strokeWidth={1.4} /></span>
            <span className="mv-row-name">{row.name}</span>
            <span className="mv-row-type">{KIND_LABEL[row.kind]}</span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>)}
    </div>
  </Modal>;
}
