import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Download, File,
  FilePen, FileText, Folder, FolderOpen, FolderPlus, Image as ImageIcon, LayoutGrid, Link2, List,
  MoreVertical, Pencil, Plus, Presentation, Search, Share2, Sheet, StickyNote, Trash2, Upload, UploadCloud, Users, X,
} from 'lucide-react';
import type { AppData, Attachment, Client, ContentFolder, InternalDocument, Note } from '../types';
import { dateNL } from '../lib/format';
import { insertRow, updateRow, deleteContentFolder, deleteAttachment, moveDriveItem, renameAttachment } from '../lib/repository';
import { uploadToR2, downloadAttachment } from '../lib/r2';
import { createOfficeSession, createOfficeDocument, isOfficeEditable, NEW_OFFICE_LABEL, type NewOfficeType, type OfficeSession } from '../lib/office';
import { OfficeEditor } from './OfficeEditor';
import { DriveRenameInput } from '../components/DriveRename';
import { fileExtension, resolveRename } from '../lib/rename';
import { childFolders, folderDescendantIds, folderPath, scopedFolders } from '../lib/folders';
import { ShareDialog } from '../components/ShareDialog';
import { shareKey, sharedItemKeys, type ShareTarget } from '../lib/shares';
import {
  activeDriveDrag, beginDriveDrag, dragHasDriveItems, dragHasFiles, driveItemLocation, endDriveDrag, itemCountLabel,
  planDriveMove, readDriveDrag, type DriveDragItem, type DriveLocation,
} from '../lib/driveDnd';
import { useDriveSelection } from '../lib/useDriveSelection';
import { useMarqueeSelection } from '../lib/useMarqueeSelection';
import { MoveDialog } from '../components/MoveDialog';

/**
 * Klant-"Bestanden" in dezelfde OneDrive-verkennerlook als de Inhoud-pagina (odrv):
 * broodkruimels bovenin, één "+ Nieuw"-menu, zoeken, een Sorteren-menu en een
 * lijst- (kolommen Naam / Gewijzigd / Grootte / Type) of tegelweergave. Mappen,
 * notities, documenten en geüploade bestanden staan in één doorlopende lijst
 * (mappen eerst); acties per item zitten achter het ⋮-menu. Aanmaken gaat via de
 * centrale editor (folder_id-default), de rest rechtstreeks via de repository met
 * een onChanged-refresh. Slepen-om-te-uploaden blijft werken in een open map.
 */

/** Gedeelde grid/lijst-voorkeur met de Inhoud-pagina; lijst (OneDrive-details) is standaard. */
const VIEW_KEY = 'resofly:driveView';
function readView(): 'grid' | 'list' {
  try { return window.localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
}

export function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

type DriveFile =
  | { key: string; kind: 'note'; note: Note }
  | { key: string; kind: 'document'; doc: InternalDocument }
  | { key: string; kind: 'file'; att: Attachment };

function fileName(it: DriveFile): string {
  return it.kind === 'note' ? it.note.title : it.kind === 'document' ? it.doc.title : it.att.name;
}
function fileModified(it: DriveFile): string {
  if (it.kind === 'note') return it.note.updated_at || it.note.created_at;
  if (it.kind === 'document') return it.doc.updated_at || it.doc.created_at;
  return it.att.created_at;
}
function attExt(att: Attachment): string {
  return att.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}
/** Bestandscategorie — stuurt icoon én kleur, zodat die twee nooit uit de pas lopen. */
type AttCategory = 'word' | 'sheet' | 'slides' | 'image' | 'pdf' | 'other';
function attCategory(att: Attachment): AttCategory {
  const ext = attExt(att);
  if (['docx', 'doc', 'odt'].includes(ext)) return 'word';
  if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) return 'sheet';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'slides';
  const m = att.mime_type || '';
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  return 'other';
}
export function attTypeLabel(att: Attachment): string {
  switch (attCategory(att)) {
    case 'word': return 'Word-document';
    case 'sheet': return attExt(att) === 'csv' ? 'CSV-bestand' : 'Excel-werkblad';
    case 'slides': return 'PowerPoint';
    case 'image': return 'Afbeelding';
    case 'pdf': return 'PDF';
    default: return 'Bestand';
  }
}
/** Icoon voor een geüpload bestand op basis van het bestandstype. Gedeeld met de Inhoud-pagina. */
export function AttachmentGlyph({ att, size }: { att: Attachment; size: number }) {
  switch (attCategory(att)) {
    case 'image': return <ImageIcon size={size} />;
    case 'sheet': return <Sheet size={size} />;
    case 'slides': return <Presentation size={size} />;
    default: return <FileText size={size} />;
  }
}
/**
 * Bestandstype-kleur: Word/tekst blauw, Excel/csv groen, presentaties oranje, PDF rood
 * (conventie), overig neutraal — zodat oranje exclusief van presentaties blijft.
 * Notities blijven paars en mappen goud (zie de aanroepers). Gedeeld met de Inhoud-pagina.
 */
export function attAccentColor(att: Attachment): string {
  switch (attCategory(att)) {
    case 'word': return 'var(--accent-b)';
    case 'sheet': return 'var(--accent-g)';
    case 'slides': return 'var(--accent-o)';
    case 'pdf': return 'var(--accent-r)';
    default: return 'var(--muted2)';
  }
}
/** Zelfde kleurtaal voor interne Documents: Office-modus volgt het mime-type, rich-text = tekstdocument = blauw. */
export function documentAccentColor(doc?: Pick<InternalDocument, 'mime_type'> | null): string {
  const m = doc?.mime_type || '';
  if (m.includes('spreadsheet') || m.includes('ms-excel') || m === 'text/csv') return 'var(--accent-g)';
  if (m.includes('presentation') || m.includes('powerpoint')) return 'var(--accent-o)';
  return 'var(--accent-b)';
}
/** Icoon voor een intern Document — volgt in Office-modus het bestandstype (Sheet/Presentation). */
export function DocumentGlyph({ doc, size }: { doc?: Pick<InternalDocument, 'mime_type'> | null; size: number }) {
  const m = doc?.mime_type || '';
  if (m.includes('spreadsheet') || m.includes('ms-excel') || m === 'text/csv') return <Sheet size={size} />;
  if (m.includes('presentation') || m.includes('powerpoint')) return <Presentation size={size} />;
  return <FileText size={size} />;
}
function fileKindLabel(it: DriveFile): string {
  if (it.kind === 'note') return 'Notitie';
  if (it.kind === 'document') return 'Document';
  return attTypeLabel(it.att);
}
/** Kleur per rij: mappen goud, notities paars, documenten/bestanden per bestandstype. */
function fileColor(it: DriveFile): string {
  if (it.kind === 'note') return 'var(--accent-v)';
  if (it.kind === 'document') return documentAccentColor(it.doc);
  return attAccentColor(it.att);
}
function FileGlyph({ it, size }: { it: DriveFile; size: number }) {
  if (it.kind === 'note') return <StickyNote size={size} />;
  if (it.kind === 'document') return <DocumentGlyph doc={it.doc} size={size} />;
  return <AttachmentGlyph att={it.att} size={size} />;
}

type SortKey = 'name' | 'modified' | 'type';

/** Eén rij in de verkenner: map of item, met de kolomwaarden en het ⋮-menu erbij.
 *  `menu` krijgt de werkelijke kebab-key mee (lijst en tegels hebben elk hun eigen),
 *  zodat het "Verplaatsen naar"-submenu in beide weergaven blijft werken. */
type Row = {
  key: string;
  kind: 'folder' | 'note' | 'document' | 'file';
  name: string;
  /** Icoonkleur — per bestandstype (Word blauw, Excel groen, presentatie oranje, notitie paars, map goud). */
  color: string;
  modified: string | null;
  size: string;
  typeLabel: string;
  onOpen: () => void;
  glyph: (size: number) => ReactNode;
  menu: ((menuKey: string) => ReactNode) | null;
  /** Inline hernoemen (F2 of ⋮ → Naam wijzigen); null als je hier niet mag schrijven. */
  rename: ((typed: string) => void) | null;
  /** Bestanden houden hun extensie: alleen de naam ervóór staat geselecteerd. */
  keepExtension?: boolean;
  /** Staat er een lopende deling op dit item? Toont het personen-icoontje in de rij. */
  shared?: boolean;
  /** Wat deze rij is als je hem vastpakt. */
  drag?: DriveDragItem;
  /** Waar een sleep landt. Alleen gevuld op mappen. */
  dropTarget?: DriveLocation;
};

export function ClientFolders({
  data,
  client,
  canWrite,
  organizationId,
  onChanged,
  onNewNote,
  onEditNote,
  onNewDocument,
  onEditDocument,
}: {
  data: AppData;
  client: Client;
  canWrite: boolean;
  organizationId: string;
  onChanged: () => void;
  onNewNote: (folderId: string | null) => void;
  onEditNote: (note: Note) => void;
  onNewDocument: (folderId: string | null) => void;
  onEditDocument: (doc: InternalDocument) => void;
}) {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [view, setView] = useState<'grid' | 'list'>(readView);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortOpen, setSortOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<{ key: string } | null>(null);
  /** De rij waarvan de naam op dit moment wordt bewerkt (`Row.key`). */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [officeSession, setOfficeSession] = useState<OfficeSession | null>(null);
  /** Het bestand dat in de editor openstaat — drijft de "Downloaden"-knop (native formaat). */
  const [officeAtt, setOfficeAtt] = useState<Attachment | null>(null);
  const [opening, setOpening] = useState(false);
  /** Het item waarvoor het deelvenster openstaat. */
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  /** Waar de sleep op dit moment boven hangt — stuurt alleen de oplichting. */
  const [dropKey, setDropKey] = useState<string | null>(null);
  /** De items waarvoor het venster "Verplaatsen naar…" openstaat. */
  const [moving, setMoving] = useState<DriveDragItem[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Alleen de mappenboom op klantniveau; mappen ín een projectmap (project_id gevuld)
  // horen bij dat project en zijn daar te vinden via Inhoud → klant → project.
  const folders = scopedFolders(data.folders, client.id, null);
  const path = folderPath(folders, currentId);
  const subfolders = childFolders(folders, client.id, null, currentId);
  /** Waar je nu staat: de klantwortel of de open map. Startpunt van "Verplaatsen naar…" en doel van de broodkruimels. */
  const here: DriveLocation = { clientId: client.id, projectId: null, folderId: currentId };

  // Items van deze klant (direct of via een project), voor de wortel en het koppelen.
  const projectIds = new Set(data.projects.filter(p => p.client_id === client.id).map(p => p.id));
  const clientNotes = data.notes.filter(n => n.client_id === client.id || Boolean(n.project_id && projectIds.has(n.project_id)));
  const clientDocuments = data.documents.filter(d => d.client_id === client.id || Boolean(d.project_id && projectIds.has(d.project_id)));

  const notesHere = currentId === null ? clientNotes.filter(n => !n.folder_id) : data.notes.filter(n => n.folder_id === currentId);
  const docsHere = currentId === null ? clientDocuments.filter(d => !d.folder_id) : data.documents.filter(d => d.folder_id === currentId);
  const folderFiles = currentId ? data.attachments.filter(a => a.entity_type === 'folder' && a.entity_id === currentId) : [];
  const sharedKeys = useMemo(() => sharedItemKeys(data), [data]);

  const linkableNotes = currentId ? clientNotes.filter(n => n.folder_id !== currentId) : [];
  const linkableDocs = currentId ? clientDocuments.filter(d => d.folder_id !== currentId) : [];

  // Kolomwaarden per map: aantal directe items + het jongste item erin.
  const folderCount = (folderId: string) =>
    data.notes.filter(n => n.folder_id === folderId).length
    + data.documents.filter(d => d.folder_id === folderId).length
    + data.attachments.filter(a => a.entity_type === 'folder' && a.entity_id === folderId).length;
  const folderModified = (folderId: string): string | null => {
    let last: string | null = null;
    const bump = (m: string) => { if (!last || last < m) last = m; };
    for (const n of data.notes) if (n.folder_id === folderId) bump(n.updated_at || n.created_at);
    for (const d of data.documents) if (d.folder_id === folderId) bump(d.updated_at || d.created_at);
    for (const a of data.attachments) if (a.entity_type === 'folder' && a.entity_id === folderId) bump(a.created_at);
    return last;
  };

  const files: DriveFile[] = [
    ...notesHere.map(n => ({ key: `n-${n.id}`, kind: 'note', note: n } as DriveFile)),
    ...docsHere.map(d => ({ key: `d-${d.id}`, kind: 'document', doc: d } as DriveFile)),
    ...folderFiles.map(a => ({ key: `f-${a.id}`, kind: 'file', att: a } as DriveFile)),
  ];

  const q = query.trim().toLowerCase();
  const shownFolders = subfolders.filter(f => !q || f.name.toLowerCase().includes(q));
  const shownFiles = files.filter(it => !q || fileName(it).toLowerCase().includes(q));
  const isEmpty = shownFolders.length === 0 && shownFiles.length === 0;

  useEffect(() => { try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);

  // Sluit de menu's ("+ Nieuw", Sorteren, ⋮) bij een klik buitenom of Escape.
  useEffect(() => {
    if (!newOpen && !menu && !sortOpen) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.drive-pop, .drive-pop-trigger')) return;
      setNewOpen(false); setMenu(null); setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setNewOpen(false); setMenu(null); setSortOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [newOpen, menu, sortOpen]);

  function openFolder(id: string | null) { setCurrentId(id); setLinkOpen(false); setQuery(''); setMenu(null); setRenaming(null); }

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt'); }
    finally { setBusy(false); }
  }

  function createFolder() {
    setNewOpen(false);
    const name = window.prompt(currentId ? 'Naam van de nieuwe submap:' : 'Naam van de nieuwe map:');
    if (!name || !name.trim()) return;
    const position = subfolders.length;
    run(async () => {
      await insertRow<ContentFolder>('content_folders', organizationId, { client_id: client.id, project_id: null, parent_id: currentId, name: name.trim(), position });
    });
  }

  /** Start het inline naamveld op een rij (⋮ → Naam wijzigen, of F2 op de rij zelf). */
  function beginRename(key: string) { setMenu(null); setRenaming(key); }

  /** Opent het deelvenster voor één item. De klantregel bepaalt daar wie er in beeld komt. */
  function openShare(target: ShareTarget) { setMenu(null); setSharing(target); }

  /**
   * Bevestig een inline hernoeming. Verandert er niets, dan gaat er ook niets naar de
   * database; verandert de bestandsextensie, dan waarschuwen we eerst — net als de
   * Verkenner, want zonder de juiste extensie opent de online editor het bestand niet meer.
   */
  function commitRename(oldName: string, typed: string, keepExtension: boolean, save: (name: string) => Promise<void>) {
    setRenaming(null);
    const next = resolveRename(oldName, typed, keepExtension);
    if (!next.changed) return;
    if (next.extensionChanged) {
      const ext = fileExtension(next.name);
      const warning = `Je wijzigt de bestandsextensie van “${oldName}” naar “${ext || 'geen extensie'}”.\n\nHet bestand wordt daardoor mogelijk onbruikbaar. Weet je zeker dat je dit wilt?`;
      if (!window.confirm(warning)) return;
    }
    run(() => save(next.name));
  }

  function deleteFolder(folder: ContentFolder) {
    const descendants = folderDescendantIds(folders, folder.id);
    const sub = descendants.length ? ` en ${descendants.length} submap(pen)` : '';
    if (!window.confirm(`Map "${folder.name}"${sub} verwijderen? Notities en documenten blijven bestaan (ze worden ontkoppeld); geüploade bestanden in deze map(pen) worden verwijderd.`)) return;
    run(async () => {
      await deleteContentFolder(folder.id, descendants, organizationId);
      if (currentId === folder.id || descendants.includes(currentId ?? '')) setCurrentId(folder.parent_id);
    });
  }

  /** "Bestaande inhoud koppelen": een notitie of document van deze klant in de open map plaatsen. */
  function moveItem(kind: 'note' | 'document', id: string, folderId: string | null) {
    setMenu(null);
    run(async () => { await updateRow(kind === 'note' ? 'notes' : 'documents', id, { folder_id: folderId }, organizationId); });
  }

  /** Opent het venster "Verplaatsen naar…" — voor één rij (⋮) of voor de hele selectie. */
  function openMove(items: DriveDragItem[]) {
    if (items.length === 0) return;
    setMenu(null); setNewOpen(false);
    setMoving(items);
  }

  function deleteFile(att: Attachment) {
    if (!window.confirm(`"${att.name}" verwijderen?`)) return;
    run(async () => { await deleteAttachment({ id: att.id, storage_key: att.storage_key, organization_id: att.organization_id }); });
  }

  async function handleDownload(att: Attachment) {
    setError(null);
    try { await downloadAttachment(att); }
    catch (e) { setError(e instanceof Error ? e.message : 'Download mislukt'); }
  }

  /** Uploaden in een bepaalde map — die hoeft niet de open map te zijn: je kunt
   *  bestanden ook rechtstreeks op een maprij laten vallen. */
  async function uploadFilesTo(list: FileList | File[], targetFolderId: string) {
    setUploading(true); setError(null);
    try {
      for (const file of Array.from(list)) {
        await uploadToR2(file, organizationId, { entity_type: 'folder', entity_id: targetFolderId });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload mislukt');
    } finally {
      setUploading(false);
    }
  }

  async function uploadFiles(list: FileList | File[]) {
    if (!currentId) return;
    await uploadFilesTo(list, currentId);
  }

  async function openOffice(att: Attachment) {
    if (opening) return; // voorkom dubbele/racy sessies bij snel klikken
    setError(null); setOpening(true);
    try {
      setOfficeSession(await createOfficeSession(att));
      setOfficeAtt(att);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kon de editor niet openen');
    } finally {
      setOpening(false);
    }
  }

  function createNewOffice(docType: NewOfficeType) {
    setNewOpen(false);
    const folderId = currentId;
    if (!folderId) return;
    const name = window.prompt(`Naam van het nieuwe ${NEW_OFFICE_LABEL[docType]}:`, 'Nieuw document');
    if (!name || !name.trim()) return;
    setError(null); setOpening(true);
    void (async () => {
      try {
        const att = await createOfficeDocument(organizationId, folderId, docType, name.trim());
        onChanged();
        setOfficeSession(await createOfficeSession(att));
        setOfficeAtt(att);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Kon geen nieuw document aanmaken');
      } finally {
        setOpening(false);
      }
    })();
  }

  function fileOpen(it: DriveFile) {
    if (it.kind === 'note') onEditNote(it.note);
    else if (it.kind === 'document') onEditDocument(it.doc);
    else if (isOfficeEditable(it.att)) openOffice(it.att);
    else handleDownload(it.att);
  }

  const canDrop = Boolean(currentId) && canWrite;
  const plural = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

  // ── Rijen voor de open map (mappen eerst, dan items; beide gesorteerd) ──
  const folderRows: Row[] = shownFolders.map(folder => {
    const key = `fo-${folder.id}`;
    return {
      key,
      kind: 'folder',
      name: folder.name,
      color: 'var(--accent)',
      modified: folderModified(folder.id),
      size: plural(folderCount(folder.id)),
      typeLabel: currentId ? 'Submap' : 'Map',
      onOpen: () => openFolder(folder.id),
      glyph: size => <Folder size={size} fill="currentColor" strokeWidth={1.4} />,
      menu: canWrite ? () => folderMenu(folder, key) : null,
      shared: sharedKeys.has(shareKey('folder', folder.id)),
      drag: { kind: 'folder', id: folder.id, name: folder.name },
      dropTarget: { clientId: client.id, projectId: null, folderId: folder.id },
      rename: canWrite
        ? typed => commitRename(folder.name, typed, false, async name => {
            await updateRow('content_folders', folder.id, { name }, organizationId);
          })
        : null,
    };
  });
  const fileRows: Row[] = shownFiles.map(it => {
    const itemId = it.kind === 'note' ? it.note.id : it.kind === 'document' ? it.doc.id : it.att.id;
    const label = fileName(it) || 'Naamloos';
    const menu: Row['menu'] = it.kind === 'file'
      ? () => fileMenu(it.att, it.key)
      : canWrite
        ? () => contentMenu(it.key, it.kind as 'note' | 'document', itemId, label, () => fileOpen(it))
        : null;
    const rename: Row['rename'] = !canWrite ? null
      : it.kind === 'file'
        ? typed => commitRename(it.att.name, typed, true, async name => {
            await renameAttachment(it.att.id, name, it.att.organization_id);
          })
        : typed => commitRename(label, typed, false, async name => {
            await updateRow(it.kind === 'note' ? 'notes' : 'documents', itemId, { title: name }, organizationId);
          });
    return {
      key: it.key,
      kind: it.kind,
      name: label,
      color: fileColor(it),
      modified: fileModified(it),
      size: it.kind === 'file' ? fmtBytes(it.att.size_bytes) : '',
      typeLabel: fileKindLabel(it),
      onOpen: () => fileOpen(it),
      glyph: size => <FileGlyph it={it} size={size} />,
      menu,
      rename,
      keepExtension: it.kind === 'file',
      shared: sharedKeys.has(shareKey(it.kind === 'file' ? 'attachment' : it.kind, itemId)),
      drag: { kind: it.kind === 'file' ? 'attachment' : it.kind, id: itemId, name: label },
    };
  });
  const cmp = (a: Row, b: Row): number => {
    let r = 0;
    if (sortKey === 'name') r = a.name.localeCompare(b.name, 'nl', { numeric: true, sensitivity: 'base' });
    else if (sortKey === 'modified') r = (a.modified ?? '').localeCompare(b.modified ?? '');
    else r = a.typeLabel.localeCompare(b.typeLabel, 'nl') || a.name.localeCompare(b.name, 'nl', { numeric: true, sensitivity: 'base' });
    return sortDir === 'asc' ? r : -r;
  };
  const rows: Row[] = [...folderRows.sort(cmp), ...fileRows.sort(cmp)];

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'modified' ? 'desc' : 'asc'); }
  }

  // ── Selecteren en slepen ───────────────────────────────────────────
  // Zelfde gedrag als de Inhoud-verkenner: aanvinken met Ctrl/Shift, slepen naar
  // een map, en bestanden van je computer rechtstreeks op een maprij laten vallen.
  const selectable = useMemo(
    () => rows.map(row => ({ key: row.key, row, selectable: canWrite && Boolean(row.drag) })),
    [rows, canWrite],
  );
  const selection = useDriveSelection<Row>(selectable);
  const { clear: clearSelection } = selection;

  // Op lege ruimte drukken en slepen tekent een selectiekader, zoals in de Verkenner
  // van Windows; Ctrl+A pakt alles. Rijen en tegels doen mee via `data-selkey`.
  const marquee = useMarqueeSelection({ enabled: canWrite, getBase: selection.snapshot, apply: selection.replace, clear: clearSelection });
  const rootKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!canWrite || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'a') return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    selection.selectAll();
  };

  useEffect(() => { clearSelection(); setMoving(null); }, [currentId, clearSelection]);

  /** Waar ligt dit item nu? Bepaalt of een sleep of een keuze in het venster iets verandert. */
  const locationOf = useCallback((item: DriveDragItem) => driveItemLocation(data, item), [data]);

  const movePlanFor = useCallback((items: DriveDragItem[], target: DriveLocation) => planDriveMove(
    items,
    target,
    { locationOf, descendantIds: id => folderDescendantIds(data.folders, id) },
  ), [locationOf, data.folders]);

  /** Verplaatst naar één plek — ook een andere klant of een projectmap; een map neemt zijn boom mee. `true` = gelukt. */
  const moveTo = useCallback(async (items: DriveDragItem[], target: DriveLocation): Promise<boolean> => {
    if (items.length === 0) return false;
    const plan = movePlanFor(items, target);
    const blockedText = plan.blocked.length ? plan.blocked.map(b => b.reason).join(' ') : null;
    if (plan.moves.length === 0) { setError(blockedText); return false; }
    setBusy(true); setError(null);
    try {
      for (const item of plan.moves) await moveDriveItem(item, target, organizationId);
      setError(blockedText);
      clearSelection();
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verplaatsen mislukt');
      return false;
    } finally {
      setBusy(false);
    }
  }, [movePlanFor, organizationId, onChanged, clearSelection]);

  function startDrag(event: ReactDragEvent, row: Row) {
    if (!row.drag || !canWrite) return;
    const byKey = new Map(rows.map(r => [r.key, r] as const));
    const items = selection.dragKeys(row.key)
      .map(key => byKey.get(key)?.drag)
      .filter((item): item is DriveDragItem => Boolean(item));
    beginDriveDrag(event.dataTransfer, items.length > 0 ? items : [row.drag]);
  }

  /** Mag er hier iets landen? Bestanden van je computer alleen in een map; eigen items alleen als ze echt verhuizen. */
  function canDropAt(event: ReactDragEvent, target: DriveLocation): boolean {
    if (!canWrite) return false;
    if (dragHasFiles(event.dataTransfer)) return Boolean(target.folderId);
    if (!dragHasDriveItems(event.dataTransfer)) return false;
    const items = activeDriveDrag();
    if (!items) return true;
    return movePlanFor(items, target).moves.length > 0;
  }

  const leaveDrop = (key: string) => (event: ReactDragEvent) => {
    event.stopPropagation();
    setDropKey(current => (current === key ? null : current));
  };

  /** Een plek als doel. Maprijen nemen ook bestanden van je computer aan (uploaden); broodkruimels alleen eigen items. */
  const targetProps = (key: string, target: DriveLocation, acceptFiles: boolean) => ({
    onDragOver: (event: ReactDragEvent) => {
      if (!acceptFiles && dragHasFiles(event.dataTransfer)) return;
      if (!canDropAt(event, target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = dragHasFiles(event.dataTransfer) ? 'copy' : 'move';
      if (dropKey !== key) setDropKey(key);
    },
    onDragLeave: leaveDrop(key),
    onDrop: (event: ReactDragEvent) => {
      if (!acceptFiles && dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropKey(null);
      if (!canWrite) return;
      if (dragHasFiles(event.dataTransfer)) {
        if (target.folderId && event.dataTransfer.files?.length) void uploadFilesTo(event.dataTransfer.files, target.folderId);
        return;
      }
      const items = readDriveDrag(event.dataTransfer);
      endDriveDrag();
      void moveTo(items, target);
    },
  });
  const dropProps = (key: string, target: DriveLocation) => targetProps(key, target, true);
  /** Broodkruimels: zo sleep je iets weer naar boven. */
  const crumbDropProps = (key: string, target: DriveLocation) => ({
    ...targetProps(key, target, false),
    className: dropKey === key ? 'odrv-crumb-drop' : undefined,
  });

  const selectedItems = selection.items
    .map(row => row.drag)
    .filter((item): item is DriveDragItem => Boolean(item));
  const selectedAttachments = selection.items
    .filter(row => row.kind === 'file')
    .map(row => data.attachments.find(a => a.id === row.drag?.id))
    .filter((att): att is Attachment => Boolean(att));
  /** Notities en documenten verwijder je in de editor, net als elders in de app. */
  const selectionDeletable = selectedItems.length > 0 && selectedItems.every(i => i.kind === 'attachment' || i.kind === 'folder');

  async function deleteSelection() {
    const files = selectedAttachments;
    const folders = selection.items.filter(row => row.kind === 'folder');
    const what = [
      files.length ? `${files.length} ${files.length === 1 ? 'bestand' : 'bestanden'}` : null,
      folders.length ? `${folders.length} ${folders.length === 1 ? 'map' : 'mappen'}` : null,
    ].filter(Boolean).join(' en ');
    if (!window.confirm(`${what} verwijderen? Notities en documenten in verwijderde mappen blijven bestaan (ze worden ontkoppeld); geüploade bestanden erin gaan wel weg.`)) return;
    setBusy(true); setError(null);
    try {
      for (const att of files) {
        await deleteAttachment({ id: att.id, storage_key: att.storage_key, organization_id: att.organization_id });
      }
      for (const row of folders) {
        const id = row.drag!.id;
        await deleteContentFolder(id, folderDescendantIds(data.folders, id), organizationId);
        if (currentId === id) setCurrentId(null);
      }
      clearSelection();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt');
    } finally {
      setBusy(false);
    }
  }

  async function downloadSelection() {
    setError(null);
    for (const att of selectedAttachments) {
      try { await downloadAttachment(att); }
      catch (e) { setError(e instanceof Error ? e.message : 'Download mislukt'); return; }
    }
  }

  const SortCaret = ({ col }: { col: SortKey }) => sortKey === col
    ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
    : <ChevronDown size={12} style={{ opacity: .45 }} />;

  /** Enter/spatie opent, F2 hernoemt — dezelfde toetsen als in de Verkenner. */
  const rowKeyDown = (e: ReactKeyboardEvent, row: Row) => {
    if (e.key === 'F2' && row.rename) { e.preventDefault(); beginRename(row.key); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.onOpen(); }
  };

  return <div
    className={`odrv odrv-embed${dragOver ? ' is-dragging' : ''}`}
    onKeyDown={rootKeyDown}
    onDragOver={canDrop ? e => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setDragOver(true); } : undefined}
    onDragLeave={canDrop ? e => { if (e.currentTarget === e.target) setDragOver(false); } : undefined}
    onDrop={canDrop ? e => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files); } : undefined}
  >
    <input ref={fileInputRef} type="file" multiple hidden onChange={e => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }} />

    <div className="odrv-main">
      <div className="odrv-head">
        <nav className="odrv-crumbs" aria-label="Locatie">
          {currentId === null
            ? <span className="odrv-crumb-current">{client.name}</span>
            : <>
                <button type="button" onClick={() => openFolder(null)} {...crumbDropProps('crumb-root', { clientId: client.id, projectId: null, folderId: null })}>{client.name}</button>
                {path.map((folder, i) => <span key={folder.id} className="odrv-crumb-step">
                  <ChevronRight size={17} aria-hidden="true" />
                  {i === path.length - 1
                    ? <span className="odrv-crumb-current">{folder.name}</span>
                    : <button type="button" onClick={() => openFolder(folder.id)} {...crumbDropProps(`crumb-${folder.id}`, { clientId: client.id, projectId: null, folderId: folder.id })}>{folder.name}</button>}
                </span>)}
              </>}
        </nav>
        <div className="odrv-headtools">
          {canWrite && <div className="drive-new-wrap">
            <button type="button" className="drive-new drive-pop-trigger" disabled={busy} onClick={() => { setNewOpen(o => !o); setMenu(null); setSortOpen(false); }} aria-haspopup="menu" aria-expanded={newOpen}>
              <Plus size={16} /> Nieuw <ChevronDown size={14} />
            </button>
            {newOpen && <div className="drive-pop" role="menu" style={{ maxHeight: 'min(70vh, 460px)', overflowY: 'auto' }}>
              {(currentId || path.length > 0) && <div className="drive-pop-head">In {path[path.length - 1]?.name ?? client.name}</div>}
              <button type="button" className="drive-pop-item" role="menuitem" onClick={createFolder}><FolderPlus size={16} style={{ color: 'var(--accent)' }} /> {currentId ? 'Nieuwe submap' : 'Nieuwe map'}</button>
              <div className="drive-pop-sep" />
              <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewNote(currentId); }}><StickyNote size={16} style={{ color: 'var(--accent-v)' }} /> Notitie</button>
              <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewDocument(currentId); }}><FileText size={16} style={{ color: 'var(--accent-b)' }} /> Document</button>
              {currentId && <button type="button" className="drive-pop-item" role="menuitem" disabled={uploading} onClick={() => { setNewOpen(false); fileInputRef.current?.click(); }}><Upload size={16} /> {uploading ? 'Uploaden…' : 'Bestand uploaden'}</button>}
              {currentId && <>
                <div className="drive-pop-sep" />
                <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('docx')}><FileText size={16} style={{ color: 'var(--accent-b)' }} /> Word-document</button>
                <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('xlsx')}><Sheet size={16} style={{ color: 'var(--accent-g)' }} /> Excel-werkblad</button>
                <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('pptx')}><Presentation size={16} style={{ color: 'var(--accent-o)' }} /> PowerPoint</button>
              </>}
              {currentId && (linkableNotes.length > 0 || linkableDocs.length > 0) && <>
                <div className="drive-pop-sep" />
                <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); setLinkOpen(true); }}><Link2 size={16} /> Bestaande inhoud koppelen</button>
              </>}
            </div>}
          </div>}
          {uploading && <span className="drive-uploading"><UploadCloud size={14} /> Uploaden…</span>}
          <label className="drive-search odrv-search">
            <Search size={14} aria-hidden="true" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Zoeken in map…" autoComplete="off" aria-label="Zoeken in map" />
            {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
          </label>
          <div className="drive-new-wrap">
            <button type="button" className="odrv-tool drive-pop-trigger" onClick={() => { setSortOpen(o => !o); setNewOpen(false); setMenu(null); }} aria-haspopup="menu" aria-expanded={sortOpen}>
              <ArrowUpDown size={14} /> Sorteren <ChevronDown size={13} />
            </button>
            {sortOpen && <div className="drive-pop is-right" role="menu">
              {([['name', 'Naam'], ['modified', 'Gewijzigd'], ['type', 'Type']] as const).map(([k, label]) =>
                <button type="button" key={k} className="drive-pop-item" role="menuitemradio" aria-checked={sortKey === k} onClick={() => { if (sortKey !== k) { setSortKey(k); setSortDir(k === 'modified' ? 'desc' : 'asc'); } setSortOpen(false); }}>
                  {label}{sortKey === k && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
                </button>)}
              <div className="drive-pop-sep" />
              <button type="button" className="drive-pop-item" role="menuitemradio" aria-checked={sortDir === 'asc'} onClick={() => { setSortDir('asc'); setSortOpen(false); }}>
                Oplopend{sortDir === 'asc' && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
              </button>
              <button type="button" className="drive-pop-item" role="menuitemradio" aria-checked={sortDir === 'desc'} onClick={() => { setSortDir('desc'); setSortOpen(false); }}>
                Aflopend{sortDir === 'desc' && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
              </button>
            </div>}
          </div>
          <div className="drive-view" role="group" aria-label="Weergave">
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="Lijstweergave" aria-pressed={view === 'list'}><List size={16} /></button>
            <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Tegelweergave" aria-pressed={view === 'grid'}><LayoutGrid size={16} /></button>
          </div>
        </div>
      </div>

      {(error || (linkOpen && currentId)) && <div className="odrv-embed-band">
        {error && <div className="error">{error}</div>}
        {linkOpen && currentId && <div className="folder-link-panel">
          <div className="folder-link-head">
            <strong>Bestaande inhoud in deze map plaatsen</strong>
            <button type="button" className="folder-link-close" onClick={() => setLinkOpen(false)} aria-label="Sluiten"><X size={14} /></button>
          </div>
          {linkableNotes.length === 0 && linkableDocs.length === 0
            ? <div className="client-empty-line">Geen andere notities of documenten van deze klant beschikbaar.</div>
            : <div className="folder-link-list">
                {linkableNotes.map(n => <button type="button" key={`ln-${n.id}`} className="folder-link-row" onClick={() => moveItem('note', n.id, currentId)} disabled={busy}>
                  <StickyNote size={13} aria-hidden="true" /><span>{n.title}</span><em>Notitie</em>
                </button>)}
                {linkableDocs.map(d => <button type="button" key={`ld-${d.id}`} className="folder-link-row" onClick={() => moveItem('document', d.id, currentId)} disabled={busy}>
                  <FileText size={13} aria-hidden="true" /><span>{d.title}</span><em>Document</em>
                </button>)}
              </div>}
        </div>}
      </div>}

      <div className={`odrv-scroll${marquee.active ? ' is-marquee' : ''}`} ref={marquee.containerRef} tabIndex={-1} onMouseDown={marquee.onMouseDown}>
        {selection.count > 0 && <div className="odrv-selbar">
          <button type="button" className="odrv-selbar-clear" onClick={selection.clear} aria-label="Selectie wissen"><X size={14} /></button>
          <strong>{itemCountLabel(selection.count)} geselecteerd</strong>
          {selection.count < selectable.filter(e => e.selectable).length && <button type="button" className="odrv-selbar-link" onClick={selection.selectAll}>Alles selecteren</button>}
          <span className="odrv-selbar-spacer" />
          {canWrite && selectedItems.length > 0 && <button type="button" className="odrv-tool" disabled={busy} onClick={() => openMove(selectedItems)}>
            <Folder size={14} /> Verplaatsen naar…
          </button>}
          {selectedAttachments.length > 0 && <button type="button" className="odrv-tool" onClick={() => void downloadSelection()}>
            <Download size={14} /> Downloaden{selectedAttachments.length !== selection.count ? ` (${selectedAttachments.length})` : ''}
          </button>}
          {canWrite && selectionDeletable && <button type="button" className="odrv-tool odrv-tool-danger" disabled={busy} onClick={() => void deleteSelection()}>
            <Trash2 size={14} /> Verwijderen
          </button>}
        </div>}
        {isEmpty
          ? <div className="drive-empty odrv-empty">
              <span className="drive-empty-ic">{q ? <Search size={24} /> : <FolderOpen size={24} />}</span>
              {q
                ? <><strong>Geen resultaten</strong><span>Niets gevonden voor “{query.trim()}” in deze map.</span></>
                : <>
                    <strong>{currentId ? 'Deze map is leeg' : 'Nog geen mappen of bestanden'}</strong>
                    <span>{canWrite ? 'Gebruik “+ Nieuw” om een map te maken, een notitie of document toe te voegen of een bestand te uploaden.' : 'Er is hier nog geen inhoud geplaatst.'}</span>
                  </>}
            </div>
          : view === 'list' ? renderList() : renderTiles()}

        {canDrop && !isEmpty && <div className={`drive-dropzone odrv-dropzone${dragOver ? ' is-dragging' : ''}`}>
          <UploadCloud size={18} /> Sleep bestanden hierheen om ze te uploaden
        </div>}
        {marquee.rect && <div className="odrv-marquee" style={marquee.rect} aria-hidden="true" />}
      </div>
    </div>

    {opening && <span className="drive-uploading" style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1500 }}><UploadCloud size={14} /> Editor openen…</span>}
    {officeSession && <OfficeEditor session={officeSession} onClose={() => { setOfficeSession(null); setOfficeAtt(null); onChanged(); }} onDownload={officeAtt ? () => handleDownload(officeAtt) : undefined} />}
    {sharing && <ShareDialog data={data} organizationId={organizationId} target={sharing} onClose={() => setSharing(null)} onChanged={onChanged} />}
    {moving && <MoveDialog
      data={data}
      items={moving}
      start={here}
      companyName={data.companySettings?.company_name?.trim() || 'Inhoud'}
      onClose={() => setMoving(null)}
      onMove={target => moveTo(moving, target)}
    />}
  </div>;

  // ── Renderers ────────────────────────────────────────────────────────────
  function kebab(key: string, content: () => ReactNode) {
    return <div className="drive-kebab-wrap">
      <button
        type="button"
        className={`drive-kebab drive-pop-trigger${menu?.key === key ? ' is-open' : ''}`}
        aria-label="Acties"
        disabled={busy}
        onClick={e => { e.stopPropagation(); setMenu(menu?.key === key ? null : { key }); setNewOpen(false); setSortOpen(false); }}
      ><MoreVertical size={16} /></button>
      {menu?.key === key && <div className="drive-pop is-right" role="menu">{content()}</div>}
    </div>;
  }

  function folderMenu(folder: ContentFolder, rowKey: string) {
    return <>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openFolder(folder.id)}><FolderOpen size={16} /> Openen</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => beginRename(rowKey)}><Pencil size={16} /> Naam wijzigen</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openMove([{ kind: 'folder', id: folder.id, name: folder.name }])}><Folder size={16} /> Verplaatsen naar…</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openShare({ type: 'folder', id: folder.id, name: folder.name })}><Share2 size={16} /> Delen…</button>
      <div className="drive-pop-sep" />
      <button type="button" className="drive-pop-item danger" role="menuitem" onClick={() => { setMenu(null); deleteFolder(folder); }}><Trash2 size={16} /> Verwijderen</button>
    </>;
  }

  function contentMenu(rowKey: string, kind: 'note' | 'document', id: string, name: string, open: () => void) {
    return <>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); open(); }}><FilePen size={16} /> Openen</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => beginRename(rowKey)}><Pencil size={16} /> Naam wijzigen</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openMove([{ kind, id, name }])}><Folder size={16} /> Verplaatsen naar…</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openShare({ type: kind, id, name })}><Share2 size={16} /> Delen…</button>
    </>;
  }

  function fileMenu(att: Attachment, rowKey: string) {
    return <>
      {isOfficeEditable(att) && <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); openOffice(att); }}><FilePen size={16} style={{ color: 'var(--accent-o)' }} /> Openen in editor</button>}
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); handleDownload(att); }}><Download size={16} /> Downloaden</button>
      {canWrite && <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openShare({ type: 'attachment', id: att.id, name: att.name })}><Share2 size={16} /> Delen…</button>}
      {canWrite && <>
        <button type="button" className="drive-pop-item" role="menuitem" onClick={() => beginRename(rowKey)}><Pencil size={16} /> Naam wijzigen</button>
        <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openMove([{ kind: 'attachment', id: att.id, name: att.name }])}><Folder size={16} /> Verplaatsen naar…</button>
        <div className="drive-pop-sep" />
        <button type="button" className="drive-pop-item danger" role="menuitem" onClick={() => { setMenu(null); deleteFile(att); }}><Trash2 size={16} /> Verwijderen</button>
      </>}
    </>;
  }

  function renderList() {
    return <div className="odrv-table">
      <div className="odrv-tr odrv-thead has-act">
        <span className="odrv-td-ic odrv-thead-ic"><File size={14} /></span>
        <button type="button" className={`odrv-th${sortKey === 'name' ? ' is-active' : ''}`} onClick={() => toggleSort('name')}>Naam <SortCaret col="name" /></button>
        <button type="button" className={`odrv-th odrv-td-mod${sortKey === 'modified' ? ' is-active' : ''}`} onClick={() => toggleSort('modified')}>Gewijzigd <SortCaret col="modified" /></button>
        <span className="odrv-th is-static odrv-td-size">Grootte</span>
        <button type="button" className={`odrv-th odrv-td-type${sortKey === 'type' ? ' is-active' : ''}`} onClick={() => toggleSort('type')}>Type <SortCaret col="type" /></button>
        <span className="odrv-td-act" aria-hidden="true" />
      </div>
      {rows.map(row => {
        const isRenaming = renaming === row.key && Boolean(row.rename);
        const picked = selection.has(row.key);
        return <div
          className={`odrv-tr odrv-row has-act${picked ? ' is-picked' : ''}${dropKey === row.key ? ' is-drop-target' : ''}`}
          key={row.key}
          role="button"
          tabIndex={0}
          data-selkey={canWrite && row.drag ? row.key : undefined}
          draggable={canWrite && Boolean(row.drag) && !isRenaming}
          onDragStart={e => startDrag(e, row)}
          onDragEnd={() => { endDriveDrag(); setDropKey(null); }}
          {...(row.dropTarget ? dropProps(row.key, row.dropTarget) : {})}
          onClick={isRenaming ? undefined : e => { if (!selection.handleRowClick(e, row.key)) row.onOpen(); }}
          onKeyDown={e => rowKeyDown(e, row)}
        >
          <span className="odrv-td-ic" style={{ color: row.color }}>
            {canWrite && row.drag && <input
              type="checkbox"
              className="odrv-check"
              checked={picked}
              onClick={e => e.stopPropagation()}
              onChange={() => selection.toggle(row.key)}
              aria-label={`${row.name} selecteren`}
            />}
            {row.glyph(20)}
          </span>
          {isRenaming
            ? <DriveRenameInput value={row.name} keepExtension={row.keepExtension} onCommit={row.rename!} onCancel={() => setRenaming(null)} />
            : <span className="odrv-td-name" title={row.name}>{row.name}{row.shared && <span className="odrv-shared" role="img" aria-label="Gedeeld" title="Gedeeld met anderen"><Users size={13} /></span>}</span>}
          <span className="odrv-td-mod">{row.modified ? dateNL(row.modified) : '—'}</span>
          <span className="odrv-td-size">{row.size}</span>
          <span className="odrv-td-type">{row.typeLabel}</span>
          <span className="odrv-td-act" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            {row.menu ? kebab(row.key, () => row.menu!(row.key)) : null}
          </span>
        </div>;
      })}
    </div>;
  }

  function renderTiles() {
    return <div className="odrv-tiles">
      {rows.map(row => {
        const isRenaming = renaming === row.key && Boolean(row.rename);
        // Het naamveld mag niet ín de tegelknop staan (een input in een button is ongeldig),
        // dus tijdens het hernoemen dragen we dezelfde inhoud in een div.
        const body = <>
          <span className="odrv-tile-canvas" style={{ color: row.color }}>{row.glyph(row.kind === 'folder' ? 46 : 38)}</span>
          <span className="odrv-tile-foot">
            {isRenaming
              ? <DriveRenameInput value={row.name} keepExtension={row.keepExtension} onCommit={row.rename!} onCancel={() => setRenaming(null)} />
              : <span className="odrv-tile-name" title={row.name}>{row.name}{row.shared && <span className="odrv-shared" role="img" aria-label="Gedeeld" title="Gedeeld met anderen"><Users size={12} /></span>}</span>}
            <span className="odrv-tile-meta">{row.kind === 'folder' ? `${row.typeLabel} · ${row.size}` : `${row.typeLabel}${row.modified ? ` · ${dateNL(row.modified)}` : ''}`}</span>
          </span>
        </>;
        const picked = selection.has(row.key);
        return <div
          className={`odrv-tile odrv-tile-wrap${picked ? ' is-picked' : ''}${dropKey === row.key ? ' is-drop-target' : ''}`}
          key={`t-${row.key}`}
          data-selkey={canWrite && row.drag ? row.key : undefined}
          draggable={canWrite && Boolean(row.drag) && !isRenaming}
          onDragStart={e => startDrag(e, row)}
          onDragEnd={() => { endDriveDrag(); setDropKey(null); }}
          {...(row.dropTarget ? dropProps(row.key, row.dropTarget) : {})}
        >
          {canWrite && row.drag && <input
            type="checkbox"
            className="odrv-check odrv-tile-check"
            checked={picked}
            onClick={e => e.stopPropagation()}
            onChange={() => selection.toggle(row.key)}
            aria-label={`${row.name} selecteren`}
          />}
          {isRenaming
            ? <div className="odrv-tile-main">{body}</div>
            : <button type="button" className="odrv-tile-main" onClick={e => { if (!selection.handleRowClick(e, row.key)) row.onOpen(); }}>{body}</button>}
          {row.menu && kebab(`t-${row.key}`, () => row.menu!(`t-${row.key}`))}
        </div>;
      })}
    </div>;
  }
}
