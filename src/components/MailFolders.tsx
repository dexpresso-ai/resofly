import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  Check, ChevronDown, ChevronRight, CornerLeftUp, Folder, FolderInput, FolderOpen, FolderPlus, Inbox, ListChecks,
  MoreHorizontal, Pencil, Search, Trash2, Undo2, X,
} from 'lucide-react';
import type { ClientEmailFolder, UUID } from '../types';
import { Modal } from './Modal';
import { Button } from './Ui';
import {
  MAX_FOLDER_DEPTH, MAX_FOLDER_NAME, buildFolderRows, canCreateFolderIn, childFolders, cleanFolderName,
  deleteFolderSummary, folderNameProblem, folderOptions, folderPathLabel, foldersOfClient, moveFolderProblem, type FolderItem,
} from '../lib/mailFolders';
import {
  createClientEmailFolder, deleteClientEmailFolder, loadClientEmailFolders, moveClientEmailFolder, moveClientEmailThreads,
  renameClientEmailFolder,
} from '../lib/repository';
import { onMailFoldersChanged } from '../lib/mailFolderEvents';

/**
 * Mappen voor klantmail op Berichten. Drie onderdelen:
 *
 * - `useMailFolders` laadt de mappen van de organisatie (en weet of de tabel
 *   hier al bestaat; zo niet, dan blijft alles zoals het was);
 * - `MailFolderTree` is de verkenner in het mailvenster van één klant: mappen
 *   open- en dichtklappen, een map maken, hernoemen, verwijderen, gesprekken
 *   erin slepen of er meerdere tegelijk naartoe verplaatsen;
 * - `MoveToFolderDialog` is het venster "Verplaatsen naar map", voor één
 *   gesprek, een selectie, of een hele map;
 * - `useMailFolderActions` bundelt wat er gebeurt (verplaatsen mét Ongedaan
 *   maken, mappen maken, hernoemen, verwijderen) en de vensters erbij. Berichten
 *   en het klantdossier gebruiken hem allebei, zodat een map zich op beide
 *   plekken precies hetzelfde gedraagt.
 *
 * Wat mag (diepte, dubbele namen, kringen) staat in `lib/mailFolders.ts`; dit
 * bestand laat het zien en zet knoppen uit mét de reden.
 */

/** Het sleepformaat: alleen gesprekken uit dit scherm, geen bestanden of tekst. */
const DRAG_TYPE = 'application/x-resofly-mail-threads';

export function useMailFolders(organizationId: string, activity = 0) {
  /** null = nog niet geladen óf de tabel bestaat hier niet; `available` zegt welke. */
  const [folders, setFolders] = useState<ClientEmailFolder[]>([]);
  const [available, setAvailable] = useState(false);
  /**
   * Loopt op als de mappen buiten dit scherm om veranderden: een voorstel van
   * Gerrie dat net is goedgekeurd. Het scherm laadt dan ook zijn gesprekken opnieuw.
   */
  const [revision, setRevision] = useState(0);
  useEffect(() => onMailFoldersChanged(() => setRevision(r => r + 1)), []);

  const reload = useCallback(async () => {
    const rows = await loadClientEmailFolders(organizationId);
    setAvailable(rows !== null);
    setFolders(rows ?? []);
    return rows ?? [];
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    loadClientEmailFolders(organizationId)
      .then(rows => { if (!cancelled) { setAvailable(rows !== null); setFolders(rows ?? []); } })
      // Stil: zonder mappen werkt Berichten gewoon zoals vóór de mappen.
      .catch(() => { if (!cancelled) { setAvailable(false); setFolders([]); } });
    return () => { cancelled = true; };
  }, [organizationId, activity, revision]);

  return { folders, setFolders, available, reload, revision };
}

/** Wat er in het venster "Verplaatsen naar map" staat: gesprekken, of een hele map. */
type MoveRequest =
  | { kind: 'threads'; clientId: string; threadIds: string[]; lede: string; fromSelection: boolean }
  | { kind: 'folder'; clientId: string; folder: ClientEmailFolder };

export interface MailFolderHost {
  /** Waar een gesprek nu staat, volgens wat het scherm geladen heeft. */
  folderOfThread: (threadId: string) => string | null;
  /** De lijsten van het scherm bijwerken, vóór de server antwoordt. */
  setThreadFolders: (change: ReadonlyMap<string, string | null>) => void;
  /** Gesprekken die direct in deze map staan (niet in een submap). */
  threadIdsIn: (folderId: string) => string[];
  /** Alles opnieuw van de server, na een fout halverwege. */
  resync: () => void;
  clientName: (clientId: string) => string;
  /** Na verplaatsen vanuit Selecteren: de selectie is klaar. */
  onSelectionMoved?: () => void;
}

const failText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

/**
 * Alles wat er met mappen gebeurt, voor één scherm. Het scherm vertelt via
 * `host` waar zijn gesprekken staan en hoe het ze bijwerkt; de rest — de
 * server, Ongedaan maken, de meldingen en de vensters — zit hier.
 *
 * Verplaatsen is optimistisch: het gesprek staat meteen in de nieuwe map, en
 * gaat terug als de server weigert. Na elke verplaatsing staat er een melding
 * met Ongedaan maken: slepen gaat snel, en soms net naast de bedoelde map.
 */
export function useMailFolderActions(organizationId: string, canWrite: boolean, host: MailFolderHost, activity = 0) {
  const { folders, setFolders, available, reload, revision } = useMailFolders(organizationId, activity);
  const [moveRequest, setMoveRequest] = useState<MoveRequest | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<ClientEmailFolder | null>(null);
  const [notice, setNotice] = useState<FolderNotice | null>(null);
  // Het scherm geeft elke render nieuwe functies mee; de laatste telt.
  const hostRef = useRef(host);
  hostRef.current = host;
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  const folderName = (folderId: string | null) => (folderId ? `"${folderPathLabel(foldersRef.current, folderId) || 'de map'}"` : '"Zonder map"');
  const say = (tone: FolderNotice['tone'], text: string, undo?: () => Promise<void>) => setNotice({ id: Date.now() + Math.random(), tone, text, undo });

  /** Gesprekken naar een map (null = Zonder map). Gooit bij een fout, zodat een venster die kan tonen. */
  async function moveThreads(threadIds: string[], folderId: string | null): Promise<void> {
    const h = hostRef.current;
    const before = new Map(threadIds.map(id => [id, h.folderOfThread(id)] as const));
    const changed = threadIds.filter(id => before.get(id) !== folderId);
    if (changed.length === 0) {
      say('ok', `${threadIds.length === 1 ? 'Staat' : 'Staan'} al in ${folderName(folderId)}.`);
      return;
    }
    const back = new Map(changed.map(id => [id, before.get(id) ?? null] as const));
    h.setThreadFolders(new Map(changed.map(id => [id, folderId] as const)));
    try {
      await moveClientEmailThreads(organizationId, changed, folderId);
    } catch (err) {
      h.setThreadFolders(back);
      throw err;
    }
    say('ok', `${changed.length === 1 ? 'Gesprek' : `${changed.length} gesprekken`} verplaatst naar ${folderName(folderId)}.`, async () => {
      // Elk gesprek terug naar waar het vandaan kwam: een selectie kan uit
      // verschillende mappen komen.
      const groups = new Map<string | null, string[]>();
      for (const [id, from] of back) groups.set(from, [...(groups.get(from) ?? []), id]);
      hostRef.current.setThreadFolders(back);
      try {
        for (const [from, ids] of groups) await moveClientEmailThreads(organizationId, ids, from);
      } catch (err) {
        say('error', failText(err, 'Terugzetten is niet gelukt.'));
        hostRef.current.resync();
      }
    });
  }

  function dropThreads(threadIds: string[], folderId: string | null, fromSelection = false) {
    moveThreads(threadIds, folderId)
      .then(() => { if (fromSelection) hostRef.current.onSelectionMoved?.(); })
      .catch(err => say('error', failText(err, 'Verplaatsen is niet gelukt.')));
  }

  async function createFolder(clientId: string, parentId: string | null, name: string): Promise<ClientEmailFolder> {
    const folder = await createClientEmailFolder(organizationId, clientId, name, parentId);
    setFolders(prev => [...prev.filter(f => f.id !== folder.id), folder]);
    return folder;
  }

  async function renameFolder(folderId: string, name: string): Promise<void> {
    const folder = await renameClientEmailFolder(organizationId, folderId, name);
    setFolders(prev => prev.map(f => (f.id === folder.id ? folder : f)));
  }

  async function moveFolder(folder: ClientEmailFolder, parentId: string | null): Promise<boolean> {
    const moved = await moveClientEmailFolder(organizationId, folder.id, parentId);
    setFolders(prev => prev.map(f => (f.id === moved.id ? moved : f)));
    const from = folder.parent_id;
    say('ok', parentId ? `Map "${folder.name}" staat nu in ${folderName(parentId)}.` : `Map "${folder.name}" staat nu bovenaan.`, async () => {
      try {
        const back = await moveClientEmailFolder(organizationId, folder.id, from);
        setFolders(prev => prev.map(f => (f.id === back.id ? back : f)));
      } catch (err) {
        say('error', failText(err, 'Terugzetten is niet gelukt.'));
        hostRef.current.resync();
      }
    });
    return true;
  }

  async function deleteFolder(folder: ClientEmailFolder): Promise<void> {
    const h = hostRef.current;
    const inside = h.threadIdsIn(folder.id);
    const result = await deleteClientEmailFolder(organizationId, folder.id);
    // Net als in de database: de inhoud schuift één laag omhoog.
    h.setThreadFolders(new Map(inside.map(id => [id, folder.parent_id] as const)));
    setFolders(prev => prev.filter(f => f.id !== folder.id).map(f => (f.parent_id === folder.id ? { ...f, parent_id: folder.parent_id } : f)));
    // Een submap kan een andere naam hebben gekregen ("Offertes (2)").
    reload().catch(() => { /* best effort */ });
    const moved = (result?.threads_moved ?? inside.length) + (result?.folders_moved ?? 0);
    say('ok', moved > 0 ? `Map "${folder.name}" verwijderd. De inhoud staat nu in ${folderName(folder.parent_id)}.` : `Map "${folder.name}" verwijderd.`);
  }

  /** Bij een map verplaatsen: welke doelen kunnen niet, en waarom (de huidige plek kan wél: "nu hier"). */
  const folderMoveReason = useMemo(() => {
    if (moveRequest?.kind !== 'folder') return undefined;
    const id = moveRequest.folder.id;
    return (target: ClientEmailFolder) => {
      const problem = moveFolderProblem(folders, id, target.id);
      return problem === 'De map staat hier al.' ? null : problem;
    };
  }, [moveRequest, folders]);

  const requestMoveThreads = (clientId: string, threadIds: string[], lede: string, fromSelection = false) =>
    setMoveRequest({ kind: 'threads', clientId, threadIds, lede, fromSelection });
  const requestMoveFolder = (folder: ClientEmailFolder) => setMoveRequest({ kind: 'folder', clientId: folder.client_id, folder });

  let dialog: ReactNode = null;
  if (moveRequest) {
    const clientName = host.clientName(moveRequest.clientId);
    const own = foldersOfClient(folders, moveRequest.clientId);
    if (moveRequest.kind === 'folder') {
      const folder = moveRequest.folder;
      dialog = <MoveToFolderDialog
        title="Map verplaatsen"
        lede={<>Verplaats de map <strong>{folder.name}</strong>, met alle submappen en gesprekken erin.</>}
        clientName={clientName}
        folders={own}
        currentFolderId={folder.parent_id}
        rootLabel={`Bovenaan bij ${clientName}`}
        disabledReason={folderMoveReason}
        canWrite={canWrite}
        onCreate={(parentId, name) => createFolder(moveRequest.clientId, parentId, name)}
        onMove={target => moveFolder(folder, target)}
        onClose={() => setMoveRequest(null)}
      />;
    } else {
      const places = new Set(moveRequest.threadIds.map(id => host.folderOfThread(id)));
      dialog = <MoveToFolderDialog
        title="Verplaatsen naar map"
        lede={moveRequest.lede}
        clientName={clientName}
        folders={own}
        currentFolderId={places.size === 1 ? [...places][0] : undefined}
        rootLabel="Zonder map"
        canWrite={canWrite}
        onCreate={(parentId, name) => createFolder(moveRequest.clientId, parentId, name)}
        onMove={async target => {
          await moveThreads(moveRequest.threadIds, target);
          if (moveRequest.fromSelection) hostRef.current.onSelectionMoved?.();
          return true;
        }}
        onClose={() => setMoveRequest(null)}
      />;
    }
  }

  const dialogs = <>
    {dialog}
    {deleteRequest && <DeleteFolderDialog
      folder={deleteRequest}
      summary={deleteFolderSummary(folders, deleteRequest.id, host.threadIdsIn(deleteRequest.id).length)}
      onClose={() => setDeleteRequest(null)}
      onConfirm={() => deleteFolder(deleteRequest)}
    />}
    <FolderNoticeBar notice={notice} onDismiss={id => setNotice(current => (current?.id === id ? null : current))} />
  </>;

  return {
    folders, available, reloadFolders: reload,
    /** Loopt op na een wijziging buiten dit scherm om (een goedgekeurd voorstel): laad dan ook de gesprekken opnieuw. */
    revision,
    dropThreads, createFolder, renameFolder,
    requestMoveThreads, requestMoveFolder, requestDelete: setDeleteRequest,
    dialogs,
  };
}

/**
 * "Map verwijderen?" Zegt waar de inhoud heen gaat; er gaat nooit mail
 * verloren, en dat moet je lezen vóórdat je op de rode knop drukt.
 */
function DeleteFolderDialog({ folder, summary, onClose, onConfirm }: {
  folder: ClientEmailFolder;
  summary: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function confirm() {
    setBusy(true); setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(failText(err, 'Verwijderen is niet gelukt.'));
      setBusy(false);
    }
  }
  return <Modal
    title="Map verwijderen?"
    className="mf-delete-modal"
    onClose={onClose}
    footer={<div className="mv-foot">
      <span className="mv-foot-actions">
        <Button type="button" onClick={onClose} disabled={busy}>Annuleren</Button>
        <Button type="button" variant="danger" onClick={() => void confirm()} disabled={busy}>{busy ? 'Verwijderen…' : 'Map verwijderen'}</Button>
      </span>
    </div>}
  >
    <p className="mv-lede">De map <strong>{folder.name}</strong> verdwijnt. {summary}</p>
    {error && <div className="error">{error}</div>}
  </Modal>;
}

/** Een gesprek in de boom. `threadId` is wat er naar de database gaat. */
export interface MailTreeItem extends FolderItem {
  key: string;
  threadId: UUID;
}

/** Wat er onthouden wordt per klant: welke mappen open staan. Per browser, het is een gemak. */
function openStorageKey(clientId: string) {
  return `resofly.berichten.mappen-open.${clientId}`;
}
function readOpen(clientId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(openStorageKey(clientId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeOpen(clientId: string, open: Set<string>) {
  try { window.localStorage.setItem(openStorageKey(clientId), JSON.stringify([...open])); } catch { /* privévenster: dan niet onthouden */ }
}

type Editing =
  | { mode: 'create'; parentId: string | null }
  | { mode: 'rename'; folderId: string };

export interface MailFolderTreeProps<T extends MailTreeItem> {
  clientId: string;
  clientName: string;
  /** Alleen de mappen van deze klant. */
  folders: ClientEmailFolder[];
  /** De gesprekken die na zoeken en filters overblijven, nieuwste eerst. */
  items: T[];
  /** Zoeken of filteren actief: lege mappen weg, mappen met treffers open. */
  filtering: boolean;
  canWrite: boolean;
  /** Slepen alleen met een muis; op een aanraakscherm schuift de lijst anders niet meer. */
  dragEnabled: boolean;
  renderItem: (item: T, state: { selecting: boolean; selected: boolean; toggle: () => void }) => ReactNode;
  selecting: boolean;
  selected: ReadonlySet<UUID>;
  onSelectingChange: (on: boolean) => void;
  onSelectedChange: (ids: Set<UUID>) => void;
  onMoveSelected: () => void;
  onCreate: (parentId: string | null, name: string) => Promise<ClientEmailFolder>;
  onRename: (folderId: string, name: string) => Promise<void>;
  onRequestDelete: (folder: ClientEmailFolder) => void;
  onRequestMoveFolder: (folder: ClientEmailFolder) => void;
  onDropThreads: (threadIds: UUID[], folderId: string | null) => void;
  /** Wat er staat als er (na filters) geen enkel gesprek is. */
  emptyText: string;
}

/**
 * De verkenner in het mailvenster van één klant. Per laag eerst de mappen, dan
 * de gesprekken; wat in geen map staat, staat onderaan onder "Zonder map". Een
 * dichte map laat zien hoeveel er in zit en hoeveel daarvan ongelezen is —
 * een antwoord van de klant in een opgeruimd gesprek mag je niet missen.
 */
export function MailFolderTree<T extends MailTreeItem>({
  clientId, clientName, folders, items, filtering, canWrite, dragEnabled, renderItem,
  selecting, selected, onSelectingChange, onSelectedChange, onMoveSelected,
  onCreate, onRename, onRequestDelete, onRequestMoveFolder, onDropThreads, emptyText,
}: MailFolderTreeProps<T>) {
  const [open, setOpen] = useState<Set<string>>(() => readOpen(clientId));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const hoverTimer = useRef<number | null>(null);

  useEffect(() => { setOpen(readOpen(clientId)); setEditing(null); }, [clientId]);

  const setOpenAndRemember = useCallback((next: Set<string>) => {
    setOpen(next);
    writeOpen(clientId, next);
  }, [clientId]);

  const toggleFolder = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id); else next.add(id);
    setOpenAndRemember(next);
  };

  const rows = useMemo(() => buildFolderRows(folders, items, { expanded: open, filtering }), [folders, items, open, filtering]);
  const unfiledCount = useMemo(() => {
    const known = new Set(folders.map(f => f.id));
    let total = 0; let unread = 0;
    for (const item of items) if (!item.folderId || !known.has(item.folderId)) { total += 1; unread += Math.max(0, item.unread); }
    return { total, unread };
  }, [folders, items]);

  const hasFolders = folders.length > 0;
  const itemIds = useMemo(() => items.map(i => i.threadId), [items]);
  const allSelected = itemIds.length > 0 && itemIds.every(id => selected.has(id));

  function toggleSelected(threadId: UUID) {
    const next = new Set(selected);
    if (next.has(threadId)) next.delete(threadId); else next.add(threadId);
    onSelectedChange(next);
  }

  // ── Slepen ──────────────────────────────────────────────────────────────
  function startDrag(event: DragEvent, item: T) {
    // Sleep je een gesprek dat geselecteerd is, dan gaat de hele selectie mee.
    const ids = selecting && selected.has(item.threadId) ? [...selected] : [item.threadId];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
  }
  function clearHover() {
    if (hoverTimer.current) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
  }
  function dragOver(event: DragEvent, target: string | null, closedFolder = false) {
    if (!canWrite || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const key = target ?? '__root__';
    if (dropTarget !== key) {
      setDropTarget(key);
      clearHover();
      // Even boven een dichte map blijven hangen klapt hem open, zodat je ook
      // een submap kunt bereiken zonder eerst los te laten.
      if (closedFolder && target) hoverTimer.current = window.setTimeout(() => setOpenAndRemember(new Set([...open, target])), 700);
    }
  }
  function dragLeave(event: DragEvent) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTarget(null);
    clearHover();
  }
  function drop(event: DragEvent, target: string | null) {
    clearHover();
    setDropTarget(null);
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    try {
      const ids = (JSON.parse(raw) as unknown[]).filter((v): v is string => typeof v === 'string');
      if (ids.length > 0) onDropThreads(ids, target);
    } catch { /* geen gesprekken uit dit scherm */ }
  }
  useEffect(() => clearHover, []);

  // ── Maken en hernoemen ──────────────────────────────────────────────────
  function startCreate(parentId: string | null) {
    if (parentId) setOpenAndRemember(new Set([...open, parentId]));
    setEditing({ mode: 'create', parentId });
  }

  const editRow = (depth: number, siblings: ClientEmailFolder[], initial: string, exceptId: string | null, submit: (name: string) => Promise<void>) =>
    <FolderNameEditor
      key="__edit__"
      depth={depth}
      initial={initial}
      siblings={siblings}
      exceptId={exceptId}
      placeholder={editing?.mode === 'create' ? 'Naam van de nieuwe map' : 'Nieuwe naam'}
      submitLabel={editing?.mode === 'create' ? 'Map maken' : 'Naam opslaan'}
      onCancel={() => setEditing(null)}
      onSubmit={async name => { await submit(name); setEditing(null); }}
    />;

  const createEditor = (parentId: string | null, depth: number) => editRow(
    depth, childFolders(folders, parentId), '', null,
    async name => { await onCreate(parentId, name); },
  );

  // Waar de bewerkregel van een nieuwe map komt: bovenaan zijn laag, vóór de
  // bestaande mappen — daar kijk je, want daar klikte je.
  const out: ReactNode[] = [];
  if (editing?.mode === 'create' && editing.parentId === null) out.push(createEditor(null, 0));

  let unfiledHeaderDone = false;
  const unfiledHeader = () => {
    unfiledHeaderDone = true;
    return <div
      key="__unfiled__"
      className={`mf-unfiled${dropTarget === '__root__' ? ' is-drop' : ''}`}
      onDragOver={e => dragOver(e, null)}
      onDragLeave={dragLeave}
      onDrop={e => drop(e, null)}
    >
      <Inbox size={13} aria-hidden="true" />
      <span className="mf-unfiled-label">Zonder map</span>
      {unfiledCount.unread > 0
        ? <span className="comm-row-badge mf-unfiled-badge" title={`${unfiledCount.unread} ongelezen, ${unfiledCount.total} gesprek${unfiledCount.total === 1 ? '' : 'ken'}`}>{unfiledCount.unread}</span>
        : <span className="mf-count">{unfiledCount.total}</span>}
    </div>;
  };

  for (const row of rows) {
    if (row.kind === 'folder') {
      const { folder, depth, expanded, hasChildren, count } = row;
      if (editing?.mode === 'rename' && editing.folderId === folder.id) {
        out.push(editRow(depth, childFolders(folders, folder.parent_id), folder.name, folder.id, name => onRename(folder.id, name)));
      } else {
        const isDrop = dropTarget === folder.id;
        out.push(<div
          key={`f:${folder.id}`}
          className={`mf-folder${isDrop ? ' is-drop' : ''}${expanded ? ' is-open' : ''}`}
          style={{ '--mf-depth': depth } as CSSProperties}
          onDragOver={e => dragOver(e, folder.id, !expanded)}
          onDragLeave={dragLeave}
          onDrop={e => drop(e, folder.id)}
        >
          <button
            type="button"
            className="mf-folder-main"
            onClick={() => toggleFolder(folder.id)}
            aria-expanded={filtering ? undefined : expanded}
            title={folderPathLabel(folders, folder.id)}
          >
            <span className={`mf-caret${hasChildren ? '' : ' is-empty'}`} aria-hidden="true">
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <span className="mf-folder-ic" aria-hidden="true">{expanded ? <FolderOpen size={15} /> : <Folder size={15} />}</span>
            <span className="mf-folder-name">{folder.name}</span>
            {/* Eén getal, niet twee: ongelezen (goud) als er iets nieuw is,
                anders hoeveel gesprekken erin staan. "2" naast een gouden
                "1" las als een rekensom. */}
            {count.unread > 0
              ? <span className="comm-row-badge" title={`${count.unread} ongelezen, ${count.total} gesprek${count.total === 1 ? '' : 'ken'} in deze map`} aria-label={`${count.unread} ongelezen`}>{count.unread}</span>
              : <span className="mf-count" title={`${count.total} gesprek${count.total === 1 ? '' : 'ken'} in deze map`} aria-label={`${count.total} gesprek${count.total === 1 ? '' : 'ken'}`}>{count.total}</span>}
          </button>
          {canWrite && <FolderMenu
            folder={folder}
            canAddSub={canCreateFolderIn(folders, folder.id)}
            onAddSub={() => startCreate(folder.id)}
            onRename={() => setEditing({ mode: 'rename', folderId: folder.id })}
            onMove={() => onRequestMoveFolder(folder)}
            onDelete={() => onRequestDelete(folder)}
          />}
        </div>);
        if (editing?.mode === 'create' && editing.parentId === folder.id && (expanded || filtering)) {
          out.push(createEditor(folder.id, depth + 1));
        }
        // Een open map zonder inhoud: zeg dat, anders lijkt het openklappen niets te doen.
        if (expanded && !filtering && !hasChildren && !(editing?.mode === 'create' && editing.parentId === folder.id)) {
          out.push(<div key={`e:${folder.id}`} className="mf-empty" style={{ '--mf-depth': depth + 1 } as CSSProperties}>
            {canWrite ? (dragEnabled ? 'Leeg. Sleep een gesprek hierheen of kies Verplaatsen in een gesprek.' : 'Leeg. Kies Verplaatsen in een gesprek om het hier te zetten.') : 'Leeg.'}
          </div>);
        }
      }
      continue;
    }
    const { item, depth, folderId } = row;
    if (hasFolders && folderId === null && !unfiledHeaderDone) out.push(unfiledHeader());
    const isSelected = selected.has(item.threadId);
    out.push(<div
      key={item.key}
      className={`mf-item${isSelected ? ' is-selected' : ''}`}
      style={{ '--mf-depth': folderId === null ? 0 : depth } as CSSProperties}
      draggable={dragEnabled && canWrite}
      onDragStart={e => startDrag(e, item)}
      onDragEnd={() => { setDropTarget(null); clearHover(); }}
    >
      {renderItem(item, { selecting, selected: isSelected, toggle: () => toggleSelected(item.threadId) })}
    </div>);
  }
  // Alles opgeruimd: "Zonder map" blijft staan, als plek om een gesprek
  // naartoe terug te slepen, en met de reden waarom hij leeg is.
  if (hasFolders && !unfiledHeaderDone && !filtering && items.length > 0) {
    out.push(unfiledHeader());
    out.push(<div key="__unfiled-empty__" className="mf-empty" style={{ '--mf-depth': 0 } as CSSProperties}>Alle gesprekken staan in een map.</div>);
  }

  const toolbar = selecting
    ? <div className="mf-toolbar is-selecting" role="toolbar" aria-label="Selectie">
        <button type="button" className="mf-check-all" onClick={() => onSelectedChange(allSelected ? new Set() : new Set(itemIds))} aria-pressed={allSelected} title={allSelected ? 'Niets selecteren' : 'Alle zichtbare gesprekken selecteren'}>
          <span className={`mf-check${allSelected ? ' is-on' : ''}`} aria-hidden="true">{allSelected && <Check size={11} strokeWidth={3} />}</span>
          <span className="mf-sel-count">{selected.size === 0 ? 'Kies gesprekken' : `${selected.size} gekozen`}</span>
        </button>
        <span className="mf-toolbar-gap" />
        <Button variant="primary" className="mf-tool" onClick={onMoveSelected} disabled={selected.size === 0} title="De gekozen gesprekken naar een map verplaatsen">
          <FolderInput size={14} /> <span className="mf-tool-label">Verplaatsen</span>
        </Button>
        <Button className="mf-tool" onClick={() => { onSelectingChange(false); onSelectedChange(new Set()); }} title="Stoppen met selecteren">
          <span>Klaar</span>
        </Button>
      </div>
    : <div className="mf-toolbar" role="toolbar" aria-label={`Mappen van ${clientName}`}>
        <span className="mf-toolbar-title"><Folder size={13} aria-hidden="true" /> Mappen</span>
        <span className="mf-toolbar-gap" />
        {canWrite && <button type="button" className="mf-tool-btn" onClick={() => startCreate(null)} title={`Nieuwe map voor ${clientName}`}>
          <FolderPlus size={14} aria-hidden="true" /> <span className="mf-tool-label">Nieuwe map</span>
        </button>}
        {canWrite && items.length > 0 && <button type="button" className="mf-tool-btn" onClick={() => onSelectingChange(true)} title="Meerdere gesprekken tegelijk verplaatsen">
          <ListChecks size={14} aria-hidden="true" /> <span className="mf-tool-label">Selecteren</span>
        </button>}
      </div>;

  // Een lezer zonder mappen heeft aan een lege balk "Mappen" niets.
  return <div className="mf-tree">
    {(canWrite || hasFolders) && toolbar}
    {!hasFolders && !filtering && canWrite && !editing && <p className="mf-hint">
      Orden de mail van {clientName} in eigen mappen, zoals <em>Offertes</em> of een project. Maak een map en
      {dragEnabled ? ' sleep gesprekken erin, of kies' : ' kies dan'} <strong>Verplaatsen</strong> in een gesprek.
    </p>}
    <div className="comm-list-scroll mf-scroll">
      {out}
      {items.length === 0 && !editing && <div className="client-empty-line comm-col-empty">{emptyText}</div>}
    </div>
  </div>;
}

/** Het invoerveld voor een nieuwe map of een nieuwe naam, op de plek in de boom. */
function FolderNameEditor({ depth, initial, siblings, exceptId, placeholder, submitLabel, onCancel, onSubmit }: {
  depth: number;
  initial: string;
  siblings: ClientEmailFolder[];
  exceptId: string | null;
  placeholder: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  const clean = cleanFolderName(value);
  // Pas klagen over een lege naam als je iets probeert op te slaan; een
  // dubbele naam zie je meteen, dan hoef je niet eerst op Enter te drukken.
  const problem = clean ? folderNameProblem(clean, siblings, exceptId) : null;
  const unchanged = exceptId !== null && clean === cleanFolderName(initial);

  async function submit() {
    if (busy) return;
    if (unchanged) { onCancel(); return; }
    const reason = folderNameProblem(clean, siblings, exceptId);
    if (reason) { setError(reason); input.current?.focus(); return; }
    setBusy(true); setError(null);
    try {
      await onSubmit(clean);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan mislukt.');
      setBusy(false);
      input.current?.focus();
    }
  }

  function onKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') { event.preventDefault(); void submit(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
  }

  const shown = error ?? problem;
  return <div className="mf-edit" style={{ '--mf-depth': depth } as CSSProperties}>
    <div className="mf-edit-row">
      <span className="mf-folder-ic" aria-hidden="true"><Folder size={15} /></span>
      <input
        ref={input}
        className="mf-edit-input"
        value={value}
        maxLength={MAX_FOLDER_NAME + 20}
        onChange={e => { setValue(e.target.value); setError(null); }}
        onKeyDown={onKey}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-invalid={shown ? true : undefined}
        disabled={busy}
      />
      <button type="button" className="mf-edit-btn is-ok" onClick={() => void submit()} disabled={busy || !clean || Boolean(problem)} aria-label={submitLabel} title={`${submitLabel} (Enter)`}>
        <Check size={14} />
      </button>
      <button type="button" className="mf-edit-btn" onClick={onCancel} disabled={busy} aria-label="Annuleren" title="Annuleren (Esc)">
        <X size={14} />
      </button>
    </div>
    {shown && <div className="mf-edit-error" role="alert">{shown}</div>}
  </div>;
}

/**
 * Het menu achter "…" op een map. Vast gepositioneerd (position: fixed) ten
 * opzichte van de knop: in een scrollend venster zou een gewoon uitklapmenu
 * onderaan worden afgeknipt, precies bij de onderste map.
 */
function FolderMenu({ folder, canAddSub, onAddSub, onRename, onMove, onDelete }: {
  folder: ClientEmailFolder;
  canAddSub: boolean;
  onAddSub: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const rect = button.current.getBoundingClientRect();
    const width = 210;
    const height = menu.current?.offsetHeight ?? 170;
    const below = rect.bottom + 4 + height <= window.innerHeight - 8;
    setPos({
      top: below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height),
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (menu.current?.contains(event.target as Node) || button.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    window.addEventListener('mousedown', close);
    window.addEventListener('touchstart', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    // Scrollt de lijst, dan klopt de plek van het menu niet meer.
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('touchstart', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  useEffect(() => { if (open && pos) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [open, pos]);

  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  }

  return <>
    <button
      ref={button}
      type="button"
      className={`mf-folder-menu${open ? ' is-open' : ''}`}
      onClick={() => setOpen(o => !o)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Acties voor map ${folder.name}`}
      title="Map: submap maken, hernoemen, verplaatsen of verwijderen"
    >
      <MoreHorizontal size={15} />
    </button>
    {open && <div
      ref={menu}
      className="mf-menu"
      role="menu"
      aria-label={`Map ${folder.name}`}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      onKeyDown={onMenuKey}
    >
      <button type="button" role="menuitem" onClick={pick(onAddSub)} disabled={!canAddSub} title={canAddSub ? undefined : `Mappen gaan hooguit ${MAX_FOLDER_DEPTH} lagen diep.`}>
        <FolderPlus size={14} aria-hidden="true" /> Submap maken
      </button>
      <button type="button" role="menuitem" onClick={pick(onRename)}>
        <Pencil size={14} aria-hidden="true" /> Naam wijzigen
      </button>
      <button type="button" role="menuitem" onClick={pick(onMove)}>
        <CornerLeftUp size={14} aria-hidden="true" /> Map verplaatsen…
      </button>
      <span className="mf-menu-sep" role="separator" />
      <button type="button" role="menuitem" className="is-danger" onClick={pick(onDelete)}>
        <Trash2 size={14} aria-hidden="true" /> Map verwijderen…
      </button>
    </div>}
  </>;
}

/**
 * "Verplaatsen naar map": de boom van één klant als keuzelijst, met bovenaan
 * "Zonder map" (bij gesprekken) of "Bovenaan bij <klant>" (bij een map). Je
 * kunt hier ook meteen een nieuwe map maken; die wordt dan gekozen.
 *
 * Wat niet kan, staat er wél, uitgegrijsd met de reden: de map zelf, zijn
 * submappen, een plek die te diep wordt. Een lijst die stilletjes korter is
 * dan de boom, laat je zoeken naar een map die "weg" is.
 */
export function MoveToFolderDialog({
  title, lede, clientName, folders, currentFolderId, rootLabel, disabledReason, canWrite, onCreate, onMove, onClose,
}: {
  title: string;
  lede: ReactNode;
  clientName: string;
  /** Alleen de mappen van deze klant. */
  folders: ClientEmailFolder[];
  /** Waar het nu staat; `undefined` = verschillende plekken (een selectie). */
  currentFolderId: string | null | undefined;
  rootLabel: string;
  /** Kan het niet naar deze map? Geef de reden (bij een map: zichzelf, submap, diepte). */
  disabledReason?: (folder: ClientEmailFolder) => string | null;
  canWrite: boolean;
  onCreate: (parentId: string | null, name: string) => Promise<ClientEmailFolder>;
  /** `true` = gelukt, dan sluit het venster. */
  onMove: (folderId: string | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const newInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !creating) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, creating]);
  useEffect(() => { if (creating) newInput.current?.focus(); }, [creating]);

  const options = useMemo(() => folderOptions(folders, disabledReason), [folders, disabledReason]);
  const q = query.trim().toLocaleLowerCase('nl');
  const shown = q
    ? options.filter(o => folderPathLabel(folders, o.id).toLocaleLowerCase('nl').includes(q))
    : options;

  const chosenLabel = target === undefined ? null : target === null ? rootLabel : folderPathLabel(folders, target);
  const same = target !== undefined && currentFolderId !== undefined && target === currentFolderId;
  const canMove = canWrite && target !== undefined && !same && !busy;

  // Een nieuwe map komt in de map die je gekozen hebt, of bovenaan.
  const createParent = target ?? null;
  const createAllowed = canCreateFolderIn(folders, createParent)
    && !(createParent && disabledReason && (() => { const f = folders.find(x => x.id === createParent); return f ? disabledReason(f) : null; })());
  const createProblem = cleanFolderName(newName) ? folderNameProblem(newName, childFolders(folders, createParent)) : null;

  async function create() {
    const clean = cleanFolderName(newName);
    const problem = folderNameProblem(clean, childFolders(folders, createParent));
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const folder = await onCreate(createParent, clean);
      setTarget(folder.id);
      setCreating(false);
      setNewName('');
      setQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Map maken mislukt.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(next: string | null | undefined = target) {
    if (next === undefined || !canWrite || busy) return;
    if (currentFolderId !== undefined && next === currentFolderId) return;
    setBusy(true); setError(null);
    try {
      if (await onMove(next)) onClose();
      else setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verplaatsen mislukt.');
      setBusy(false);
    }
  }

  let hint: string;
  if (!canWrite) hint = 'Je hebt alleen leesrechten op Klanten.';
  else if (target === undefined) hint = 'Kies een map. Dubbelklikken verplaatst meteen.';
  else if (same) hint = 'Staat hier al.';
  else hint = `Naar "${chosenLabel}".`;

  const row = (id: string | null, name: string, depth: number, reason: string | null, isRoot = false) => {
    const isCurrent = currentFolderId !== undefined && currentFolderId === id;
    const isChosen = target === id;
    return <button
      type="button"
      key={id ?? '__root__'}
      className={`mv-row mf-pick${isChosen ? ' is-chosen' : ''}`}
      style={{ '--mf-depth': q ? 0 : depth } as CSSProperties}
      disabled={Boolean(reason) || busy}
      title={reason ?? undefined}
      aria-pressed={isChosen}
      onClick={() => { setTarget(id); setError(null); }}
      onDoubleClick={() => { if (!reason) void confirm(id); }}
    >
      <span className="mv-row-ic">{isRoot ? <Inbox size={17} /> : isChosen ? <FolderOpen size={17} /> : <Folder size={17} />}</span>
      <span className="mv-row-name">{q && id ? folderPathLabel(folders, id) : name}</span>
      <span className="mv-row-type">{isCurrent ? 'nu hier' : reason ? 'kan niet' : ''}</span>
      <span className="mf-pick-check" aria-hidden="true">{isChosen && <Check size={15} />}</span>
    </button>;
  };

  return <Modal
    title={title}
    className="move-modal mf-move-modal"
    onClose={onClose}
    footer={<div className="mv-foot">
      <span className={`mv-hint${error ? ' is-blocked' : ''}`} role="status">
        <span>{error ?? hint}</span>
      </span>
      <span className="mv-foot-actions">
        <Button type="button" onClick={onClose}>Annuleren</Button>
        <Button type="button" variant="primary" disabled={!canMove} onClick={() => void confirm()}>{busy ? 'Bezig…' : 'Verplaatsen'}</Button>
      </span>
    </div>}
  >
    <p className="mv-lede">{lede}</p>
    {options.length > 8 && <label className="drive-search mv-search">
      <Search size={14} aria-hidden="true" />
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder={`Zoek een map van ${clientName}…`} autoComplete="off" aria-label="Zoek een map" />
      {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
    </label>}
    <div className="mv-list mf-pick-list" role="group" aria-label={`Mappen van ${clientName}`}>
      {!q && row(null, rootLabel, 0, null, true)}
      {shown.map(o => row(o.id, o.name, o.depth, o.disabledReason))}
      {options.length === 0 && <div className="mv-empty">Nog geen mappen bij {clientName}. Maak hieronder de eerste.</div>}
      {q && shown.length === 0 && <div className="mv-empty">Geen map gevonden met "{query.trim()}".</div>}
    </div>
    {canWrite && (creating
      ? <div className="mf-pick-create">
          <div className="mf-edit-row">
            <span className="mf-folder-ic" aria-hidden="true"><FolderPlus size={15} /></span>
            <input
              ref={newInput}
              className="mf-edit-input"
              value={newName}
              onChange={e => { setNewName(e.target.value); setError(null); }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); void create(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCreating(false); setNewName(''); }
              }}
              placeholder="Naam van de nieuwe map"
              aria-label="Naam van de nieuwe map"
              maxLength={MAX_FOLDER_NAME + 20}
              disabled={busy}
            />
            <Button type="button" onClick={() => void create()} disabled={busy || !cleanFolderName(newName) || Boolean(createProblem)}>Maken</Button>
            <button type="button" className="mf-edit-btn" onClick={() => { setCreating(false); setNewName(''); }} aria-label="Annuleren"><X size={14} /></button>
          </div>
          <span className={`mf-pick-create-note${createProblem ? ' is-error' : ''}`}>
            {createProblem ?? `Komt in: ${createParent ? folderPathLabel(folders, createParent) : `bovenaan bij ${clientName}`}`}
          </span>
        </div>
      : <button
          type="button"
          className="mf-pick-new"
          onClick={() => setCreating(true)}
          disabled={!createAllowed || busy}
          title={createAllowed ? undefined : `Mappen gaan hooguit ${MAX_FOLDER_DEPTH} lagen diep.`}
        >
          <FolderPlus size={14} aria-hidden="true" />
          {createParent ? `Nieuwe map in "${folders.find(f => f.id === createParent)?.name ?? ''}"` : 'Nieuwe map'}
        </button>)}
  </Modal>;
}

/** De plek van een gesprek als klein label: "Offertes / 2025", of "Zonder map". */
export function FolderLabel({ folders, folderId, onClick, disabled }: {
  folders: ClientEmailFolder[];
  folderId: string | null | undefined;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const known = folderId && folders.some(f => f.id === folderId);
  const label = known ? folderPathLabel(folders, folderId) : 'Zonder map';
  const content = <>
    {known ? <Folder size={12} aria-hidden="true" /> : <Inbox size={12} aria-hidden="true" />}
    <span>{label}</span>
  </>;
  if (!onClick) return <span className={`mf-label${known ? '' : ' is-none'}`} title={known ? `In map ${label}` : 'Staat in geen map'}>{content}</span>;
  return <button type="button" className={`mf-label is-button${known ? '' : ' is-none'}`} onClick={onClick} disabled={disabled} title="Verplaatsen naar een andere map">
    {content}
  </button>;
}

/**
 * Melding na verplaatsen, met "Ongedaan maken". Slepen gaat snel en soms mis;
 * terugzetten moet dan één klik zijn, niet zoeken waar het gesprek bleef.
 */
export interface FolderNotice {
  id: number;
  text: string;
  tone: 'ok' | 'error';
  undo?: () => Promise<void>;
}

/**
 * `onDismiss` krijgt het id mee: mislukt Ongedaan maken, dan staat er al een
 * nieuwe melding (de fout), en die mag niet met de oude mee verdwijnen.
 */
export function FolderNoticeBar({ notice, onDismiss }: { notice: FolderNotice | null; onDismiss: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBusy(false);
    if (!notice) return;
    const id = notice.id;
    const timer = window.setTimeout(() => onDismiss(id), notice.tone === 'error' ? 9000 : 7000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notice?.id]);
  if (!notice) return null;
  return <div className={`mf-notice${notice.tone === 'error' ? ' is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
    <span className="mf-notice-text">{notice.text}</span>
    {notice.undo && <button
      type="button"
      className="mf-notice-undo"
      disabled={busy}
      onClick={async () => { const id = notice.id; setBusy(true); try { await notice.undo?.(); } finally { onDismiss(id); } }}
    >
      <Undo2 size={13} aria-hidden="true" /> Ongedaan maken
    </button>}
    <button type="button" className="mf-notice-close" onClick={() => onDismiss(notice.id)} aria-label="Melding sluiten"><X size={14} /></button>
  </div>;
}
