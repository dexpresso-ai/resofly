import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Eye, EyeOff,
  File, FilePen, FileText, Folder, FolderOpen, FolderPlus, Info, LayoutGrid, List, MoreVertical,
  Pencil, Plus, Presentation, Search, Sheet, SlidersHorizontal, StickyNote, Trash2, Upload, UploadCloud, X,
} from 'lucide-react';
import type { AppData, Attachment, ContentFolder, InternalDocument, Note, Project } from '../types';
import { dateNL } from '../lib/format';
import { insertRow, updateRow, deleteContentFolder, deleteAttachment } from '../lib/repository';
import { uploadToR2, downloadAttachment } from '../lib/r2';
import { createOfficeSession, createOfficeDocument, isOfficeEditable, NEW_OFFICE_LABEL, type NewOfficeType, type OfficeSession } from '../lib/office';
import { OfficeEditor } from './OfficeEditor';
import { childFolders, clientFolderOptions, folderDescendantIds, folderPath } from '../lib/folders';
import { AttachmentGlyph, attTypeLabel, fmtBytes } from './ClientFolders';

export type ContentView = 'all' | 'notes' | 'documents';

/** Waar een nieuw item terechtkomt: klant, project en/of map worden vooringevuld in de editor. */
export type ContentCreateTarget = { client_id?: string | null; project_id?: string | null; folder_id?: string | null };

/** Sentinel voor de "Geen klant"-map (inhoud zonder gekoppelde klant). */
const NO_CLIENT = '__no_client__';

/** Gedeelde grid/lijst-voorkeur met de klantdossier-drive; hier is lijst (OneDrive-details) de standaard. */
const VIEW_KEY = 'resofly:driveView';
function readView(): 'grid' | 'list' {
  try { return window.localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
}
const DETAILS_KEY = 'resofly:contentDetails';
function readDetails(): boolean {
  try { return window.localStorage.getItem(DETAILS_KEY) === '1'; } catch { return false; }
}

type ContentItem = {
  kind: 'note' | 'document';
  id: string;
  title: string;
  content: string;
  modified: string;
  clientId: string | null;   // effectieve klant (afgeleid uit klant- én projectkoppeling)
  projectId: string | null;  // effectief project
  folderId: string | null;   // dossiermap (content_folders) waarin het item is opgeborgen
  note?: Note;
  doc?: InternalDocument;
};

function itemColor(kind: 'note' | 'document' | 'file'): string {
  return kind === 'note' ? 'var(--accent-v)' : kind === 'document' ? 'var(--accent-g)' : 'var(--accent-o)';
}

type SortKey = 'name' | 'modified' | 'type';

/** Eén rij in de verkenner: klant-/project-/dossiermap of los item, met de kolomwaarden
 *  en (waar van toepassing) het ⋮-menu erbij. `menu` krijgt de werkelijke kebab-key mee
 *  (lijst en tegels hebben elk hun eigen) zodat submenu's in beide weergaven werken. */
type Row = {
  key: string;
  kind: 'client' | 'project' | 'folder' | 'note' | 'document' | 'file';
  name: string;
  color?: string | null;
  archived?: boolean;
  modified: string | null;
  size: string;
  typeLabel: string;
  onOpen: () => void;
  att?: Attachment;
  menu?: ((menuKey: string) => ReactNode) | null;
};
const isFolderRow = (r: Row) => r.kind === 'client' || r.kind === 'project' || r.kind === 'folder';

function RowGlyph({ row, size }: { row: Row; size: number }) {
  if (row.kind === 'file' && row.att) return <AttachmentGlyph att={row.att} size={size} />;
  if (isFolderRow(row)) return <Folder size={size} fill="currentColor" strokeWidth={1.4} />;
  return row.kind === 'note' ? <StickyNote size={size} /> : <FileText size={size} />;
}

/**
 * "Inhoud" als OneDrive-achtige verkenner: bovenin een broodkruimeltitel met zoekveld en
 * daaronder een commandobalk ("+ Nieuw", Weergeven-filter, Sorteren, lijst/tegels, Details),
 * daaronder één doorlopende lijst (mappen eerst) met de kolommen Naam / Gewijzigd /
 * Grootte / Type, sorteerbaar via de kolomkoppen of het Sorteren-menu, plus een
 * tegelweergave en een inklapbaar Details-paneel. Binnen een klant leven naast de
 * afgeleide projectmappen ook de échte dossiermappen (content_folders) — dezelfde mappen
 * als in het klantdossier-tabblad "Bestanden", incl. submappen, uploads en office-bestanden.
 * Nieuwe items worden in de open map aangemaakt (klant/project/map vooringevuld); de
 * sidebar-ingangen Overzicht/Notities/Documenten deeplinken via `initialView`.
 */
export function ContentLibrary({
  data,
  organizationId,
  canWrite,
  initialView = 'all',
  onChanged,
  onNewNote,
  onEditNote,
  onNewDocument,
  onEditDocument,
}: {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  initialView?: ContentView;
  onChanged: () => void;
  onNewNote: (target?: ContentCreateTarget) => void;
  onEditNote: (n: Note) => void;
  onNewDocument: (target?: ContentCreateTarget) => void;
  onEditDocument: (d: InternalDocument) => void;
}) {
  const [showNotes, setShowNotes] = useState(initialView !== 'documents');
  const [showDocuments, setShowDocuments] = useState(initialView !== 'notes');
  const [showFiles, setShowFiles] = useState(true);
  const [clientId, setClientId] = useState<string | null>(null);   // null = wortel (alle klanten)
  const [projectId, setProjectId] = useState<string | null>(null); // null = klantwortel
  const [folderId, setFolderId] = useState<string | null>(null);   // dossiermap binnen de klant
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>(readView);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [detailsOpen, setDetailsOpen] = useState(readDetails);
  const [newOpen, setNewOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [menu, setMenu] = useState<{ key: string; mode: 'main' | 'move'; up: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [officeSession, setOfficeSession] = useState<OfficeSession | null>(null);
  /** Het bestand dat in de editor openstaat — drijft de "Downloaden"-knop (native formaat). */
  const [officeAtt, setOfficeAtt] = useState<Attachment | null>(null);
  const [opening, setOpening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);
  useEffect(() => { try { window.localStorage.setItem(DETAILS_KEY, detailsOpen ? '1' : '0'); } catch { /* ignore */ } }, [detailsOpen]);

  // Sluit de menu's ("+ Nieuw", Weergeven, Sorteren, ⋮) bij een klik buitenom of Escape.
  useEffect(() => {
    if (!newOpen && !sortOpen && !filterOpen && !menu) return;
    const closeAll = () => { setNewOpen(false); setSortOpen(false); setFilterOpen(false); setMenu(null); };
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.drive-pop, .drive-pop-trigger')) return;
      closeAll();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [newOpen, sortOpen, filterOpen, menu]);

  const projectsById = useMemo(() => new Map(data.projects.map(p => [p.id, p] as const)), [data.projects]);
  const clientsById = useMemo(() => new Map(data.clients.map(c => [c.id, c] as const)), [data.clients]);
  const foldersById = useMemo(() => new Map(data.folders.map(f => [f.id, f] as const)), [data.folders]);

  const noteCount = data.notes.length;
  const documentCount = data.documents.length;

  // Effectieve plaatsing: heeft een item een project, dan hoort het bij de klant van dat project.
  const items = useMemo<ContentItem[]>(() => {
    const place = (rawClient: string | null, rawProject: string | null) => {
      const proj = rawProject ? projectsById.get(rawProject) : undefined;
      if (proj) return { clientId: proj.client_id ?? null, projectId: proj.id };
      return { clientId: rawClient ?? null, projectId: null as string | null };
    };
    const out: ContentItem[] = [];
    if (showNotes) for (const n of data.notes) {
      const p = place(n.client_id, n.project_id);
      out.push({ kind: 'note', id: n.id, title: n.title, content: n.content, modified: n.updated_at || n.created_at, clientId: p.clientId, projectId: p.projectId, folderId: n.folder_id ?? null, note: n });
    }
    if (showDocuments) for (const d of data.documents) {
      const p = place(d.client_id, d.project_id);
      out.push({ kind: 'document', id: d.id, title: d.title, content: d.content, modified: d.updated_at || d.created_at, clientId: p.clientId, projectId: p.projectId, folderId: d.folder_id ?? null, doc: d });
    }
    return out;
  }, [data.notes, data.documents, showNotes, showDocuments, projectsById]);

  // Geüploade bestanden leven in dossiermappen; tel ze mee bij de klant van die map.
  const folderAttachments = useMemo(
    () => data.attachments.filter(a => a.entity_type === 'folder' && foldersById.has(a.entity_id)),
    [data.attachments, foldersById],
  );
  const attCountByClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of folderAttachments) {
      const cid = foldersById.get(a.entity_id)?.client_id;
      if (cid) m.set(cid, (m.get(cid) ?? 0) + 1);
    }
    return m;
  }, [folderAttachments, foldersById]);
  const attLastByClient = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of folderAttachments) {
      const cid = foldersById.get(a.entity_id)?.client_id;
      if (cid && (m.get(cid) ?? '') < a.created_at) m.set(cid, a.created_at);
    }
    return m;
  }, [folderAttachments, foldersById]);

  const countByClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) { const k = it.clientId ?? NO_CLIENT; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [items]);

  // "Gewijzigd" per map = het jongste item erin (ISO-strings vergelijken lexicografisch correct).
  const lastByClient = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) { const k = it.clientId ?? NO_CLIENT; if ((m.get(k) ?? '') < it.modified) m.set(k, it.modified); }
    return m;
  }, [items]);
  const lastByProject = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) { if (it.projectId && (m.get(it.projectId) ?? '') < it.modified) m.set(it.projectId, it.modified); }
    return m;
  }, [items]);

  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const noneSelected = !showNotes && !showDocuments && !showFiles;

  // ── Navigatiestatus ────────────────────────────────────────────────
  const atRoot = clientId === null;
  const currentClient = clientId && clientId !== NO_CLIENT ? clientsById.get(clientId) ?? null : null;
  const realClient = currentClient !== null;
  const currentClientName = clientId === NO_CLIENT ? 'Geen klant' : currentClient?.name ?? '';
  const currentProject = projectId ? projectsById.get(projectId) ?? null : null;

  // Dossiermappen (content_folders) van de open klant — dezelfde mappen als in het
  // klantdossier-tabblad "Bestanden".
  const scopedFolders = useMemo(
    () => realClient ? data.folders.filter(f => f.client_id === clientId) : [],
    [data.folders, clientId, realClient],
  );
  const currentFolderPath = folderId ? folderPath(scopedFolders, folderId) : [];
  const currentFolder = currentFolderPath.length ? currentFolderPath[currentFolderPath.length - 1] : null;
  const subfolderList = realClient && clientId ? childFolders(scopedFolders, clientId, folderId) : [];
  const folderOptions = realClient ? clientFolderOptions(data.folders, clientId) : [];

  const folderCount = (id: string) =>
    data.notes.filter(n => n.folder_id === id).length
    + data.documents.filter(d => d.folder_id === id).length
    + data.attachments.filter(a => a.entity_type === 'folder' && a.entity_id === id).length;
  const folderModified = (id: string): string | null => {
    let last: string | null = null;
    const bump = (m: string) => { if (!last || last < m) last = m; };
    for (const n of data.notes) if (n.folder_id === id) bump(n.updated_at || n.created_at);
    for (const d of data.documents) if (d.folder_id === id) bump(d.updated_at || d.created_at);
    for (const a of data.attachments) if (a.entity_type === 'folder' && a.entity_id === id) bump(a.created_at);
    return last;
  };

  const clientItems = useMemo(
    () => clientId === null ? [] : items.filter(it => (it.clientId ?? NO_CLIENT) === clientId),
    [items, clientId],
  );

  // Projectmappen binnen de klant: alle niet-gearchiveerde projecten van de klant + projecten met inhoud.
  const projectFolders = useMemo(() => {
    if (clientId === null) return [];
    const referenced = new Set(clientItems.map(it => it.projectId).filter((x): x is string => Boolean(x)));
    const base = clientId === NO_CLIENT ? [] : data.projects.filter(p => p.client_id === clientId && (!p.archived || referenced.has(p.id)));
    const ids = new Set(base.map(p => p.id));
    const extra: Project[] = [];
    for (const id of referenced) if (!ids.has(id)) { const p = projectsById.get(id); if (p) extra.push(p); }
    return [...base, ...extra]
      .map(p => ({ id: p.id, name: p.name, color: p.color, archived: p.archived, count: clientItems.filter(it => it.projectId === p.id).length }));
  }, [clientId, clientItems, data.projects, projectsById]);

  // Losse items op klantniveau: geen project én niet opgeborgen in een dossiermap
  // (die verschijnen ín hun map). Voor "Geen klant" bestaat er geen mappenniveau,
  // dus daar blijft alles zichtbaar.
  const generalItems = useMemo(
    () => clientItems.filter(it => !it.projectId && (clientId === NO_CLIENT || !it.folderId)),
    [clientItems, clientId],
  );
  const projectItems = useMemo(() => projectId ? clientItems.filter(it => it.projectId === projectId) : [], [clientItems, projectId]);

  // Inhoud van de open dossiermap (notities/documenten op folder_id + uploads).
  const folderNotes = folderId && showNotes ? data.notes.filter(n => n.folder_id === folderId) : [];
  const folderDocs = folderId && showDocuments ? data.documents.filter(d => d.folder_id === folderId) : [];
  const folderAtts = folderId && showFiles ? data.attachments.filter(a => a.entity_type === 'folder' && a.entity_id === folderId) : [];

  // Klantmappen op de wortel: elke klant (zodat je overal direct kunt aanmaken) + "Geen klant" als die inhoud heeft.
  const clientFolders = useMemo(() => {
    const list = data.clients.map(c => ({
      id: c.id,
      name: c.name,
      color: c.color,
      count: (countByClient.get(c.id) ?? 0) + (showFiles ? attCountByClient.get(c.id) ?? 0 : 0),
      projects: data.projects.filter(p => p.client_id === c.id && !p.archived).length,
    }));
    list.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
    const none = countByClient.get(NO_CLIENT) ?? 0;
    if (none > 0) list.push({ id: NO_CLIENT, name: 'Geen klant', color: '#94A3B8', count: none, projects: 0 });
    return list;
  }, [data.clients, data.projects, countByClient, attCountByClient, showFiles]);

  function openClient(id: string | null) { setClientId(id); setProjectId(null); setFolderId(null); setQuery(''); setMenu(null); }
  function openProject(id: string | null) { setProjectId(id); setFolderId(null); setQuery(''); setMenu(null); }
  function openFolder(id: string | null) { setFolderId(id); setProjectId(null); setQuery(''); setMenu(null); }

  /** Eén niveau omhoog: submap → bovenliggende map → klantwortel → alle klanten. */
  function goUp() {
    if (folderId) { openFolder(currentFolder?.parent_id ?? null); return; }
    if (projectId) { openProject(null); return; }
    openClient(null);
  }

  const anyFilterOff = !showNotes || !showDocuments || !showFiles;

  // Create-context: nieuwe items belanden in de open map (klant/project/dossiermap).
  const createTarget: ContentCreateTarget | undefined =
    folderId && realClient ? { client_id: clientId, folder_id: folderId } :
    projectId ? { client_id: currentClient?.id ?? null, project_id: projectId } :
    realClient ? { client_id: clientId } :
    undefined;

  const plural = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

  // ── Dossiermap-acties (zelfde repository-flows als het klantdossier) ──
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt'); }
    finally { setBusy(false); }
  }

  function createFolder() {
    setNewOpen(false);
    if (!realClient || !clientId) return;
    const name = window.prompt(folderId ? 'Naam van de nieuwe submap:' : 'Naam van de nieuwe map:');
    if (!name || !name.trim()) return;
    const position = subfolderList.length;
    const parent = folderId;
    const cid = clientId;
    run(async () => {
      await insertRow<ContentFolder>('content_folders', organizationId, { client_id: cid, parent_id: parent, name: name.trim(), position });
    });
  }

  function renameFolder(folder: ContentFolder) {
    const name = window.prompt('Nieuwe naam voor de map:', folder.name);
    if (!name || !name.trim() || name.trim() === folder.name) return;
    run(async () => { await updateRow('content_folders', folder.id, { name: name.trim() }, organizationId); });
  }

  function deleteFolder(folder: ContentFolder) {
    const descendants = folderDescendantIds(scopedFolders, folder.id);
    const sub = descendants.length ? ` en ${descendants.length} submap(pen)` : '';
    if (!window.confirm(`Map "${folder.name}"${sub} verwijderen? Notities en documenten blijven bestaan (ze worden ontkoppeld); geüploade bestanden in deze map(pen) worden verwijderd.`)) return;
    run(async () => {
      await deleteContentFolder(folder.id, descendants, organizationId);
      if (folderId === folder.id || descendants.includes(folderId ?? '')) setFolderId(folder.parent_id);
    });
  }

  function moveItem(kind: 'note' | 'document', id: string, targetFolderId: string | null) {
    setMenu(null);
    run(async () => { await updateRow(kind === 'note' ? 'notes' : 'documents', id, { folder_id: targetFolderId }, organizationId); });
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

  async function uploadFiles(list: FileList | File[]) {
    if (!folderId) return;
    setUploading(true); setError(null);
    try {
      for (const file of Array.from(list)) {
        await uploadToR2(file, organizationId, { entity_type: 'folder', entity_id: folderId });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload mislukt');
    } finally {
      setUploading(false);
    }
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
    const fid = folderId;
    if (!fid) return;
    const name = window.prompt(`Naam van het nieuwe ${NEW_OFFICE_LABEL[docType]}:`, 'Nieuw document');
    if (!name || !name.trim()) return;
    setError(null); setOpening(true);
    void (async () => {
      try {
        const att = await createOfficeDocument(organizationId, fid, docType, name.trim());
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

  function attOpen(att: Attachment) {
    if (isOfficeEditable(att)) void openOffice(att);
    else void handleDownload(att);
  }

  const canDrop = Boolean(folderId) && canWrite;

  // ── Rijen voor de huidige map (mappen eerst, dan items; beide gesorteerd) ──
  const itemRow = (it: ContentItem): Row => ({
    key: `${it.kind}-${it.id}`,
    kind: it.kind,
    name: it.title || 'Naamloos',
    color: itemColor(it.kind),
    modified: it.modified,
    size: '',
    typeLabel: it.kind === 'note' ? 'Notitie' : 'Document',
    onOpen: () => it.kind === 'note' ? onEditNote(it.note!) : onEditDocument(it.doc!),
    menu: canWrite && realClient
      ? (menuKey: string) => contentMenu(menuKey, it.kind, it.id, () => it.kind === 'note' ? onEditNote(it.note!) : onEditDocument(it.doc!))
      : null,
  });
  const contentFolderRow = (folder: ContentFolder, typeLabel: 'Map' | 'Submap'): Row => ({
    key: `f-${folder.id}`,
    kind: 'folder',
    name: folder.name,
    color: 'var(--accent)',
    modified: folderModified(folder.id),
    size: plural(folderCount(folder.id)),
    typeLabel,
    onOpen: () => openFolder(folder.id),
    menu: canWrite ? () => folderMenu(folder) : null,
  });
  const attRow = (att: Attachment): Row => ({
    key: `a-${att.id}`,
    kind: 'file',
    name: att.name,
    color: itemColor('file'),
    modified: att.created_at,
    size: fmtBytes(att.size_bytes),
    typeLabel: attTypeLabel(att),
    onOpen: () => attOpen(att),
    att,
    menu: () => fileMenu(att),
  });

  const folderRows: Row[] = [];
  const fileRows: Row[] = [];
  if (atRoot) {
    for (const f of clientFolders) folderRows.push({
      key: `c-${f.id}`, kind: 'client', name: f.name, color: f.color || 'var(--accent)',
      modified: [lastByClient.get(f.id) ?? '', showFiles ? attLastByClient.get(f.id) ?? '' : ''].sort().pop() || null,
      size: plural(f.count), typeLabel: 'Klantmap',
      onOpen: () => openClient(f.id),
    });
  } else if (folderId) {
    for (const f of subfolderList) folderRows.push(contentFolderRow(f, 'Submap'));
    for (const n of folderNotes) fileRows.push(itemRow({ kind: 'note', id: n.id, title: n.title, content: n.content, modified: n.updated_at || n.created_at, clientId, projectId: null, folderId, note: n }));
    for (const d of folderDocs) fileRows.push(itemRow({ kind: 'document', id: d.id, title: d.title, content: d.content, modified: d.updated_at || d.created_at, clientId, projectId: null, folderId, doc: d }));
    for (const a of folderAtts) fileRows.push(attRow(a));
  } else if (projectId === null) {
    for (const f of projectFolders) folderRows.push({
      key: `p-${f.id}`, kind: 'project', name: f.name, color: f.color || 'var(--accent)', archived: f.archived,
      modified: lastByProject.get(f.id) ?? null, size: plural(f.count), typeLabel: 'Projectmap',
      onOpen: () => openProject(f.id),
    });
    for (const f of subfolderList) folderRows.push(contentFolderRow(f, 'Map'));
    for (const it of generalItems) fileRows.push(itemRow(it));
  } else {
    for (const it of projectItems) fileRows.push(itemRow(it));
  }
  const cmp = (a: Row, b: Row): number => {
    let r = 0;
    if (sortKey === 'name') r = a.name.localeCompare(b.name, 'nl', { numeric: true, sensitivity: 'base' });
    else if (sortKey === 'modified') r = (a.modified ?? '').localeCompare(b.modified ?? '');
    else r = a.typeLabel.localeCompare(b.typeLabel, 'nl') || a.name.localeCompare(b.name, 'nl', { numeric: true, sensitivity: 'base' });
    return sortDir === 'asc' ? r : -r;
  };
  const shown = (list: Row[]) => list.filter(r => hit(r.name)).sort(cmp);
  const rows: Row[] = [...shown(folderRows), ...shown(fileRows)];

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'modified' ? 'desc' : 'asc'); }
  }

  // ── Details-paneel: samenvatting van de open map ───────────────────
  const scopeItems = atRoot ? items : folderId ? [] : projectId ? projectItems : clientItems;
  const scopeNotes = folderId ? folderNotes.length : scopeItems.filter(i => i.kind === 'note').length;
  const scopeDocs = folderId ? folderDocs.length : scopeItems.filter(i => i.kind === 'document').length;
  const scopeFiles = folderId ? folderAtts.length
    : atRoot ? folderAttachments.length
    : realClient && clientId ? attCountByClient.get(clientId) ?? 0
    : 0;
  const scopeModified = folderId
    ? folderModified(folderId)
    : scopeItems.reduce<string | null>((acc, i) => !acc || acc < i.modified ? i.modified : acc, null);
  const scopeTitle = atRoot ? 'Inhoud' : currentFolder ? currentFolder.name : currentProject ? currentProject.name : currentClientName;
  const scopeType = atRoot ? 'Alle klanten' : currentFolder ? (currentFolder.parent_id ? 'Submap' : 'Map') : currentProject ? 'Projectmap' : 'Klantmap';
  const scopeColor = atRoot ? 'var(--accent)' : currentFolder ? 'var(--accent)' : currentProject ? currentProject.color || 'var(--accent)' : currentClient?.color || (clientId === NO_CLIENT ? '#94A3B8' : 'var(--accent)');

  const companyName = data.companySettings?.company_name?.trim() || 'Inhoud';

  const SortCaret = ({ col }: { col: SortKey }) => sortKey === col
    ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
    : <ChevronDown size={12} style={{ opacity: .45 }} />;

  const rowKeyDown = (e: ReactKeyboardEvent, open: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  };

  const emptyState = () => {
    if (q) return <div className="drive-empty odrv-empty"><span className="drive-empty-ic"><Search size={24} /></span><strong>Geen resultaten</strong><span>Niets gevonden voor “{query.trim()}” in deze map.</span></div>;
    if (atRoot) return <div className="drive-empty odrv-empty"><span className="drive-empty-ic"><FolderOpen size={24} /></span><strong>Nog geen klanten</strong><span>Maak eerst een klant aan via de pagina Klanten; elke klant wordt hier automatisch een map.</span></div>;
    return <div className="drive-empty odrv-empty"><span className="drive-empty-ic"><FolderOpen size={24} /></span><strong>Deze map is leeg</strong><span>Gebruik de knop “+ Nieuw” hierboven om hier {folderId ? 'een submap, notitie, document of bestand' : 'een map, notitie of document'} aan te maken.</span></div>;
  };

  // ── ⋮-menu's (zelfde acties als het klantdossier) ──────────────────
  function kebab(key: string, content: () => ReactNode) {
    return <div className="drive-kebab-wrap">
      <button
        type="button"
        className={`drive-kebab drive-pop-trigger${menu?.key === key ? ' is-open' : ''}`}
        aria-label="Acties"
        disabled={busy}
        onClick={e => {
          e.stopPropagation();
          if (menu?.key === key) { setMenu(null); return; }
          // De lijst scrolt intern: open het menu omhoog voor rijen onderin beeld.
          const scroller = (e.currentTarget as HTMLElement).closest('.odrv-scroll');
          let up = false;
          if (scroller) {
            const sr = scroller.getBoundingClientRect();
            const br = (e.currentTarget as HTMLElement).getBoundingClientRect();
            up = br.bottom > sr.top + sr.height * 0.55;
          }
          setMenu({ key, mode: 'main', up }); setNewOpen(false); setSortOpen(false);
        }}
      ><MoreVertical size={16} /></button>
      {menu?.key === key && <div className={`drive-pop is-right${menu.up ? ' is-up' : ''}`} role="menu">{content()}</div>}
    </div>;
  }

  function folderMenu(folder: ContentFolder) {
    return <>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => openFolder(folder.id)}><FolderOpen size={16} /> Openen</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); renameFolder(folder); }}><Pencil size={16} /> Hernoemen</button>
      <div className="drive-pop-sep" />
      <button type="button" className="drive-pop-item danger" role="menuitem" onClick={() => { setMenu(null); deleteFolder(folder); }}><Trash2 size={16} /> Verwijderen</button>
    </>;
  }

  function contentMenu(key: string, kind: 'note' | 'document', id: string, open: () => void) {
    if (menu?.key === key && menu.mode === 'move') {
      return <>
        <div className="drive-pop-head"><button type="button" className="drive-pop-back" onClick={() => setMenu({ key, mode: 'main', up: menu.up })} aria-label="Terug"><ChevronLeft size={14} /></button> Verplaatsen naar</div>
        <div className="drive-pop-scroll">
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => moveItem(kind, id, null)}><FolderOpen size={16} /> {currentClientName} (geen map)</button>
          {folderOptions.map(o => <button type="button" key={o.id} className="drive-pop-item" role="menuitem" onClick={() => moveItem(kind, id, o.id)}><Folder size={16} style={{ color: 'var(--accent)' }} /> {o.label}</button>)}
        </div>
      </>;
    }
    return <>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); open(); }}><Pencil size={16} /> Openen</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => setMenu(m => m ? { ...m, mode: 'move' } : m)}><Folder size={16} /> Verplaatsen naar… <ChevronRight size={14} style={{ marginLeft: 'auto' }} /></button>
    </>;
  }

  function fileMenu(att: Attachment) {
    return <>
      {isOfficeEditable(att) && <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); void openOffice(att); }}><FilePen size={16} style={{ color: 'var(--accent-o)' }} /> Openen in editor</button>}
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); void handleDownload(att); }}><Download size={16} /> Downloaden</button>
      {canWrite && <>
        <div className="drive-pop-sep" />
        <button type="button" className="drive-pop-item danger" role="menuitem" onClick={() => { setMenu(null); deleteFile(att); }}><Trash2 size={16} /> Verwijderen</button>
      </>}
    </>;
  }

  const renderList = () => <div className="odrv-table">
    <div className="odrv-tr odrv-thead has-act">
      <span className="odrv-td-ic odrv-thead-ic"><File size={14} /></span>
      <button type="button" className={`odrv-th${sortKey === 'name' ? ' is-active' : ''}`} onClick={() => toggleSort('name')}>Naam <SortCaret col="name" /></button>
      <button type="button" className={`odrv-th odrv-td-mod${sortKey === 'modified' ? ' is-active' : ''}`} onClick={() => toggleSort('modified')}>Gewijzigd <SortCaret col="modified" /></button>
      <span className="odrv-th is-static odrv-td-size">Grootte</span>
      <button type="button" className={`odrv-th odrv-td-type${sortKey === 'type' ? ' is-active' : ''}`} onClick={() => toggleSort('type')}>Type <SortCaret col="type" /></button>
      <span className="odrv-td-act" aria-hidden="true" />
    </div>
    {rows.map(row => <div
      className="odrv-tr odrv-row has-act"
      key={row.key}
      role="button"
      tabIndex={0}
      onClick={row.onOpen}
      onKeyDown={e => rowKeyDown(e, row.onOpen)}
    >
      <span className="odrv-td-ic" style={{ color: row.color || 'var(--accent)' }}><RowGlyph row={row} size={20} /></span>
      <span className="odrv-td-name" title={row.name}>{row.name}{row.archived && <em className="odrv-arch">gearchiveerd</em>}</span>
      <span className="odrv-td-mod">{row.modified ? dateNL(row.modified) : '—'}</span>
      <span className="odrv-td-size">{row.size}</span>
      <span className="odrv-td-type">{row.typeLabel}</span>
      <span className="odrv-td-act" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        {row.menu ? kebab(row.key, () => row.menu!(row.key)) : null}
      </span>
    </div>)}
  </div>;

  const renderTiles = () => <div className="odrv-tiles">
    {rows.map(row => <div className="odrv-tile odrv-tile-wrap" key={`t-${row.key}`}>
      <button type="button" className="odrv-tile-main" onClick={row.onOpen}>
        <span className="odrv-tile-canvas" style={{ color: row.color || 'var(--accent)' }}><RowGlyph row={row} size={isFolderRow(row) ? 46 : 38} /></span>
        <span className="odrv-tile-foot">
          <span className="odrv-tile-name" title={row.name}>{row.name}</span>
          <span className="odrv-tile-meta">{isFolderRow(row) ? `${row.typeLabel} · ${row.size}` : `${row.typeLabel}${row.modified ? ` · ${dateNL(row.modified)}` : ''}`}</span>
        </span>
      </button>
      {row.menu && kebab(`t-${row.key}`, () => row.menu!(`t-${row.key}`))}
    </div>)}
  </div>;

  return <div
    className={`odrv${dragOver ? ' is-dragging' : ''}`}
    onDragOver={canDrop ? e => { e.preventDefault(); setDragOver(true); } : undefined}
    onDragLeave={canDrop ? e => { if (e.currentTarget === e.target) setDragOver(false); } : undefined}
    onDrop={canDrop ? e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files); } : undefined}
  >
    <input ref={fileInputRef} type="file" multiple hidden onChange={e => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }} />

    <main className="odrv-main">
      <div className="odrv-head">
        <nav className="odrv-crumbs" aria-label="Locatie">
          {atRoot
            ? <span className="odrv-crumb-current">{companyName}</span>
            : <>
                <button type="button" onClick={() => openClient(null)}>{companyName}</button>
                <ChevronRight size={17} aria-hidden="true" />
                {projectId === null && folderId === null
                  ? <span className="odrv-crumb-current">{currentClientName}</span>
                  : <>
                      <button type="button" onClick={() => folderId ? openFolder(null) : openProject(null)}>{currentClientName}</button>
                      {folderId
                        ? currentFolderPath.map((folder, i) => <span key={folder.id} className="odrv-crumb-step">
                            <ChevronRight size={17} aria-hidden="true" />
                            {i === currentFolderPath.length - 1
                              ? <span className="odrv-crumb-current">{folder.name}</span>
                              : <button type="button" onClick={() => openFolder(folder.id)}>{folder.name}</button>}
                          </span>)
                        : <>
                            <ChevronRight size={17} aria-hidden="true" />
                            <span className="odrv-crumb-current">{currentProject?.name ?? ''}</span>
                          </>}
                    </>}
              </>}
        </nav>
        <label className="drive-search odrv-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder={atRoot ? 'Zoek klant…' : 'Zoeken in deze map…'} autoComplete="off" aria-label="Zoeken in inhoud" />
          {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
        </label>
      </div>

      {/* Commandobalk (OneDrive): aanmaken links, weergave-opties rechts. */}
      <div className="odrv-cmdbar">
        {canWrite && <div className="drive-new-wrap">
          <button type="button" className="drive-new drive-pop-trigger" disabled={busy} onClick={() => { setNewOpen(o => !o); setSortOpen(false); setFilterOpen(false); setMenu(null); }} aria-haspopup="menu" aria-expanded={newOpen}>
            <Plus size={16} /> Nieuw <ChevronDown size={14} />
          </button>
          {newOpen && <div className="drive-pop" role="menu" style={{ maxHeight: 'min(70vh, 460px)', overflowY: 'auto' }}>
            {!atRoot && <div className="drive-pop-head">In {currentFolder ? currentFolder.name : currentProject ? currentProject.name : currentClientName}</div>}
            {realClient && !projectId && <>
              <button type="button" className="drive-pop-item" role="menuitem" onClick={createFolder}><FolderPlus size={16} style={{ color: 'var(--accent)' }} /> {folderId ? 'Nieuwe submap' : 'Nieuwe map'}</button>
              <div className="drive-pop-sep" />
            </>}
            <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewNote(createTarget); }}><StickyNote size={16} style={{ color: 'var(--accent-v)' }} /> Notitie</button>
            <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewDocument(createTarget); }}><FileText size={16} style={{ color: 'var(--accent-g)' }} /> Document</button>
            {folderId && <>
              <button type="button" className="drive-pop-item" role="menuitem" disabled={uploading} onClick={() => { setNewOpen(false); fileInputRef.current?.click(); }}><Upload size={16} style={{ color: 'var(--accent-o)' }} /> {uploading ? 'Uploaden…' : 'Bestand uploaden'}</button>
              <div className="drive-pop-sep" />
              <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('docx')}><FileText size={16} style={{ color: 'var(--accent-o)' }} /> Word-document</button>
              <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('xlsx')}><Sheet size={16} style={{ color: 'var(--accent-o)' }} /> Excel-werkblad</button>
              <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('pptx')}><Presentation size={16} style={{ color: 'var(--accent-o)' }} /> PowerPoint</button>
            </>}
          </div>}
        </div>}
        {!atRoot && <button type="button" className="odrv-tool odrv-up" onClick={goUp} title="Eén niveau omhoog" aria-label="Eén niveau omhoog">
          <ChevronLeft size={15} /> <span className="odrv-tool-label">Terug</span>
        </button>}
        {uploading && <span className="drive-uploading"><UploadCloud size={14} /> Uploaden…</span>}

        <div className="odrv-cmdbar-right">
          <div className="drive-new-wrap">
            <button type="button" className={`odrv-tool drive-pop-trigger${anyFilterOff ? ' is-active' : ''}`} onClick={() => { setFilterOpen(o => !o); setNewOpen(false); setSortOpen(false); setMenu(null); }} aria-haspopup="menu" aria-expanded={filterOpen}>
              <SlidersHorizontal size={14} /> <span className="odrv-tool-label">Weergeven</span> <ChevronDown size={13} />
            </button>
            {filterOpen && <div className="drive-pop is-right" role="menu">
              <div className="drive-pop-head">Tonen in de lijst</div>
              <button type="button" className="drive-pop-item" role="menuitemcheckbox" aria-checked={showNotes} onClick={() => setShowNotes(v => !v)}>
                {showNotes ? <Eye size={16} style={{ color: 'var(--accent-v)' }} /> : <EyeOff size={16} />} Notities <span className="odrv-pop-count">{noteCount}</span>
              </button>
              <button type="button" className="drive-pop-item" role="menuitemcheckbox" aria-checked={showDocuments} onClick={() => setShowDocuments(v => !v)}>
                {showDocuments ? <Eye size={16} style={{ color: 'var(--accent-g)' }} /> : <EyeOff size={16} />} Documenten <span className="odrv-pop-count">{documentCount}</span>
              </button>
              <button type="button" className="drive-pop-item" role="menuitemcheckbox" aria-checked={showFiles} onClick={() => setShowFiles(v => !v)}>
                {showFiles ? <Eye size={16} style={{ color: 'var(--accent-o)' }} /> : <EyeOff size={16} />} Bestanden <span className="odrv-pop-count">{folderAttachments.length}</span>
              </button>
            </div>}
          </div>
          <div className="drive-new-wrap">
            <button type="button" className="odrv-tool drive-pop-trigger" onClick={() => { setSortOpen(o => !o); setNewOpen(false); setFilterOpen(false); setMenu(null); }} aria-haspopup="menu" aria-expanded={sortOpen} aria-label="Sorteren">
              <ArrowUpDown size={14} /> <span className="odrv-tool-label">Sorteren</span> <ChevronDown size={13} />
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
          <button type="button" className={`odrv-tool odrv-tool-details${detailsOpen ? ' is-active' : ''}`} onClick={() => setDetailsOpen(o => !o)} aria-pressed={detailsOpen}>
            <Info size={15} /> Details
          </button>
        </div>
      </div>

      {error && <div className="odrv-embed-band"><div className="error">{error}</div></div>}

      {noneSelected
        ? <div className="odrv-scroll"><div className="drive-empty odrv-empty">
            <span className="drive-empty-ic"><EyeOff size={24} /></span>
            <strong>Geen filter actief</strong>
            <span>Zet in het menu “Weergeven” Notities, Documenten of Bestanden aan om je inhoud te tonen.</span>
          </div></div>
        : <div className="odrv-body">
            <div className="odrv-scroll">
              {rows.length === 0 ? emptyState() : view === 'list' ? renderList() : renderTiles()}
              {canDrop && rows.length > 0 && <div className={`drive-dropzone odrv-dropzone${dragOver ? ' is-dragging' : ''}`}>
                <UploadCloud size={18} /> Sleep bestanden hierheen om ze te uploaden
              </div>}
            </div>
            {detailsOpen && <aside className="odrv-details">
              <div className="odrv-details-head">
                <span>Details</span>
                <button type="button" className="odrv-details-close" onClick={() => setDetailsOpen(false)} aria-label="Details sluiten"><X size={14} /></button>
              </div>
              <div className="odrv-details-hero" style={{ color: scopeColor }}>
                {atRoot ? <FolderOpen size={38} /> : <Folder size={38} fill="currentColor" strokeWidth={1.4} />}
              </div>
              <strong className="odrv-details-name">{scopeTitle}</strong>
              <span className="odrv-details-type">{scopeType}</span>
              <dl className="odrv-details-props">
                {atRoot && <div><dt>Klanten</dt><dd>{clientFolders.length}</dd></div>}
                {!atRoot && !currentProject && !folderId && <div><dt>Projecten</dt><dd>{projectFolders.length}</dd></div>}
                {!atRoot && !currentProject && realClient && <div><dt>{folderId ? 'Submappen' : 'Mappen'}</dt><dd>{subfolderList.length}</dd></div>}
                {(currentProject || folderId) && <div><dt>Klant</dt><dd>{currentClientName || '—'}</dd></div>}
                <div><dt>Notities</dt><dd>{scopeNotes}</dd></div>
                <div><dt>Documenten</dt><dd>{scopeDocs}</dd></div>
                {showFiles && <div><dt>Bestanden</dt><dd>{scopeFiles}</dd></div>}
                <div><dt>Gewijzigd</dt><dd>{scopeModified ? dateNL(scopeModified) : '—'}</dd></div>
              </dl>
            </aside>}
          </div>}
    </main>

    {opening && <span className="drive-uploading" style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1500 }}><UploadCloud size={14} /> Editor openen…</span>}
    {officeSession && <OfficeEditor session={officeSession} onClose={() => { setOfficeSession(null); setOfficeAtt(null); onChanged(); }} onDownload={officeAtt ? () => handleDownload(officeAtt) : undefined} />}
  </div>;
}
