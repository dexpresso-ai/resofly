import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, Download, FilePen, FileText, Folder, FolderOpen, FolderPlus,
  Image as ImageIcon, LayoutGrid, Link2, List, MoreVertical, Pencil, Plus, Presentation, Search, Sheet,
  StickyNote, Trash2, Upload, UploadCloud, X,
} from 'lucide-react';
import type { AppData, Attachment, Client, ContentFolder, InternalDocument, Note } from '../types';
import { RichTextExcerpt } from '../components/RichTextEditor';
import { dateNL } from '../lib/format';
import { insertRow, updateRow, deleteContentFolder, deleteAttachment } from '../lib/repository';
import { uploadToR2, downloadAttachment } from '../lib/r2';
import { createOfficeSession, createOfficeDocument, isOfficeEditable, NEW_OFFICE_LABEL, type NewOfficeType, type OfficeSession } from '../lib/office';
import { OfficeEditor } from './OfficeEditor';
import { childFolders, clientFolderOptions, folderDescendantIds, folderPath } from '../lib/folders';

/**
 * Klant-"Bestanden": een cloud-drive voor het hele klantdossier. Mappen, notities,
 * documenten en geüploade bestanden leven in één navigeerbare ruimte met een padbalk,
 * één "+ Nieuw"-menu, een grid/lijst-schakelaar en slepen-om-te-uploaden. Aanmaken
 * gaat via de centrale editor (folder_id-default), de rest rechtstreeks via de
 * repository met een onChanged-refresh — net als TicketNotesTimeline en AttachmentList.
 */

const VIEW_KEY = 'resofly:driveView';
function readView(): 'grid' | 'list' {
  try { return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}

function fmtBytes(bytes: number): string {
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
function fileDate(it: DriveFile): string {
  return it.kind === 'note' ? it.note.created_at : it.kind === 'document' ? it.doc.created_at : it.att.created_at;
}
function fileKindLabel(it: DriveFile): string {
  if (it.kind === 'note') return 'Notitie';
  if (it.kind === 'document') return 'Document';
  const m = it.att.mime_type || '';
  if (m.startsWith('image/')) return 'Afbeelding';
  if (m === 'application/pdf') return 'PDF';
  return 'Bestand';
}
function kindColor(kind: 'folder' | 'note' | 'document' | 'file'): string {
  return kind === 'folder' ? 'var(--accent)'
    : kind === 'note' ? 'var(--accent-v)'
    : kind === 'document' ? 'var(--accent-g)'
    : 'var(--accent-o)';
}
function FileGlyph({ it, size }: { it: DriveFile; size: number }) {
  if (it.kind === 'note') return <StickyNote size={size} />;
  if (it.kind === 'document') return <FileText size={size} />;
  if ((it.att.mime_type || '').startsWith('image/')) return <ImageIcon size={size} />;
  return <FileText size={size} />;
}

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
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<{ key: string; mode: 'main' | 'move' } | null>(null);
  const [officeSession, setOfficeSession] = useState<OfficeSession | null>(null);
  const [opening, setOpening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const folders = data.folders.filter(f => f.client_id === client.id);
  const path = folderPath(folders, currentId);
  const subfolders = childFolders(folders, client.id, currentId);
  const folderOptions = clientFolderOptions(data.folders, client.id);

  // Items van deze klant (direct of via een project), voor de wortel en het koppelen.
  const projectIds = new Set(data.projects.filter(p => p.client_id === client.id).map(p => p.id));
  const clientNotes = data.notes.filter(n => n.client_id === client.id || Boolean(n.project_id && projectIds.has(n.project_id)));
  const clientDocuments = data.documents.filter(d => d.client_id === client.id || Boolean(d.project_id && projectIds.has(d.project_id)));

  const notesHere = currentId === null ? clientNotes.filter(n => !n.folder_id) : data.notes.filter(n => n.folder_id === currentId);
  const docsHere = currentId === null ? clientDocuments.filter(d => !d.folder_id) : data.documents.filter(d => d.folder_id === currentId);
  const folderFiles = currentId ? data.attachments.filter(a => a.entity_type === 'folder' && a.entity_id === currentId) : [];

  const linkableNotes = currentId ? clientNotes.filter(n => n.folder_id !== currentId) : [];
  const linkableDocs = currentId ? clientDocuments.filter(d => d.folder_id !== currentId) : [];

  const itemCount = (folderId: string) =>
    data.notes.filter(n => n.folder_id === folderId).length + data.documents.filter(d => d.folder_id === folderId).length;

  const files: DriveFile[] = [
    ...notesHere.map(n => ({ key: `n-${n.id}`, kind: 'note', note: n } as DriveFile)),
    ...docsHere.map(d => ({ key: `d-${d.id}`, kind: 'document', doc: d } as DriveFile)),
    ...folderFiles.map(a => ({ key: `f-${a.id}`, kind: 'file', att: a } as DriveFile)),
  ];

  const q = query.trim().toLowerCase();
  const shownFolders = subfolders.filter(f => !q || f.name.toLowerCase().includes(q));
  const shownFiles = files
    .filter(it => !q || fileName(it).toLowerCase().includes(q))
    .sort((a, b) => fileName(a).localeCompare(fileName(b), 'nl'));
  const isEmpty = shownFolders.length === 0 && shownFiles.length === 0;

  useEffect(() => { try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);

  // Sluit het "+ Nieuw"-menu en de item-menu's bij een klik buitenom of Escape.
  useEffect(() => {
    if (!newOpen && !menu) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.drive-pop, .drive-pop-trigger')) return;
      setNewOpen(false); setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setNewOpen(false); setMenu(null); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [newOpen, menu]);

  function openFolder(id: string | null) { setCurrentId(id); setLinkOpen(false); setQuery(''); setMenu(null); }

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
      await insertRow<ContentFolder>('content_folders', organizationId, { client_id: client.id, parent_id: currentId, name: name.trim(), position });
    });
  }

  function renameFolder(folder: ContentFolder) {
    const name = window.prompt('Nieuwe naam voor de map:', folder.name);
    if (!name || !name.trim() || name.trim() === folder.name) return;
    run(async () => { await updateRow('content_folders', folder.id, { name: name.trim() }, organizationId); });
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

  function moveItem(kind: 'note' | 'document', id: string, folderId: string | null) {
    setMenu(null);
    run(async () => { await updateRow(kind === 'note' ? 'notes' : 'documents', id, { folder_id: folderId }, organizationId); });
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
    if (!currentId) return;
    setUploading(true); setError(null);
    try {
      for (const file of Array.from(list)) {
        await uploadToR2(file, organizationId, { entity_type: 'folder', entity_id: currentId });
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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Kon geen nieuw document aanmaken');
      } finally {
        setOpening(false);
      }
    })();
  }

  const canDrop = Boolean(currentId) && canWrite;

  return <div
    className={`drive${dragOver ? ' is-dragging' : ''}`}
    onDragOver={canDrop ? e => { e.preventDefault(); setDragOver(true); } : undefined}
    onDragLeave={canDrop ? e => { if (e.currentTarget === e.target) setDragOver(false); } : undefined}
    onDrop={canDrop ? e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files); } : undefined}
  >
    <input ref={fileInputRef} type="file" multiple hidden onChange={e => { if (e.target.files?.length) uploadFiles(e.target.files); e.target.value = ''; }} />

    <div className="drive-bar">
      <div className="drive-crumbs">
        <button type="button" className={currentId === null ? 'active' : ''} onClick={() => openFolder(null)}>
          <FolderOpen size={15} aria-hidden="true" /> {client.name}
        </button>
        {path.map(folder => <span key={folder.id} className="drive-crumb">
          <ChevronRight size={14} aria-hidden="true" />
          <button type="button" className={folder.id === currentId ? 'active' : ''} onClick={() => openFolder(folder.id)}>{folder.name}</button>
        </span>)}
      </div>
      <div className="drive-bar-right">
        <label className="drive-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Zoeken in map…" autoComplete="off" aria-label="Zoeken in map" />
          {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
        </label>
        <div className="drive-view" role="group" aria-label="Weergave">
          <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Rasterweergave" aria-pressed={view === 'grid'}><LayoutGrid size={16} /></button>
          <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="Lijstweergave" aria-pressed={view === 'list'}><List size={16} /></button>
        </div>
      </div>
    </div>

    {canWrite && <div className="drive-tools">
      <div className="drive-new-wrap">
        <button type="button" className="drive-new drive-pop-trigger" disabled={busy} onClick={() => { setNewOpen(o => !o); setMenu(null); }} aria-haspopup="menu" aria-expanded={newOpen}>
          <Plus size={16} /> Nieuw <ChevronDown size={14} />
        </button>
        {newOpen && <div className="drive-pop" role="menu">
          <button type="button" className="drive-pop-item" role="menuitem" onClick={createFolder}><FolderPlus size={16} style={{ color: 'var(--accent)' }} /> {currentId ? 'Nieuwe submap' : 'Nieuwe map'}</button>
          <div className="drive-pop-sep" />
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewNote(currentId); }}><StickyNote size={16} style={{ color: 'var(--accent-v)' }} /> Notitie</button>
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewDocument(currentId); }}><FileText size={16} style={{ color: 'var(--accent-g)' }} /> Document</button>
          {currentId && <>
            <div className="drive-pop-sep" />
            <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('docx')}><FileText size={16} style={{ color: 'var(--accent-o)' }} /> Word-document</button>
            <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('xlsx')}><Sheet size={16} style={{ color: 'var(--accent-o)' }} /> Excel-werkblad</button>
            <button type="button" className="drive-pop-item" role="menuitem" disabled={opening} onClick={() => createNewOffice('pptx')}><Presentation size={16} style={{ color: 'var(--accent-o)' }} /> PowerPoint</button>
          </>}
          {currentId && <button type="button" className="drive-pop-item" role="menuitem" disabled={uploading} onClick={() => { setNewOpen(false); fileInputRef.current?.click(); }}><Upload size={16} style={{ color: 'var(--accent-o)' }} /> {uploading ? 'Uploaden…' : 'Bestand uploaden'}</button>}
          {currentId && (linkableNotes.length > 0 || linkableDocs.length > 0) && <>
            <div className="drive-pop-sep" />
            <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); setLinkOpen(true); }}><Link2 size={16} /> Bestaande inhoud koppelen</button>
          </>}
        </div>}
      </div>
      {uploading && <span className="drive-uploading"><UploadCloud size={14} /> Uploaden…</span>}
    </div>}

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

    {isEmpty
      ? <div className="drive-empty">
          <span className="drive-empty-ic">{q ? <Search size={24} /> : <FolderOpen size={24} />}</span>
          {q
            ? <><strong>Geen resultaten</strong><span>Niets gevonden voor “{query.trim()}” in deze map.</span></>
            : <>
                <strong>{currentId ? 'Deze map is leeg' : 'Nog geen mappen of bestanden'}</strong>
                <span>{canWrite ? 'Gebruik “+ Nieuw” om een map te maken, een notitie of document toe te voegen of een bestand te uploaden.' : 'Er is hier nog geen inhoud geplaatst.'}</span>
              </>}
        </div>
      : <>
          {shownFolders.length > 0 && <section className="drive-group">
            <div className="drive-group-head"><span>Mappen</span><span className="drive-group-count">{shownFolders.length}</span></div>
            {view === 'grid'
              ? <div className="drive-grid">{shownFolders.map(folder => renderFolderCard(folder))}</div>
              : <div className="drive-list">{shownFolders.map(folder => renderFolderRow(folder))}</div>}
          </section>}

          {shownFiles.length > 0 && <section className="drive-group">
            <div className="drive-group-head"><span>{currentId ? 'Bestanden' : 'Niet ingedeeld'}</span><span className="drive-group-count">{shownFiles.length}</span></div>
            {view === 'grid'
              ? <div className="drive-grid">{shownFiles.map(it => renderFileCard(it))}</div>
              : <div className="drive-list">{shownFiles.map(it => renderFileRow(it))}</div>}
          </section>}
        </>}

    {canDrop && !isEmpty && <div className={`drive-dropzone${dragOver ? ' is-dragging' : ''}`}>
      <UploadCloud size={18} /> Sleep bestanden hierheen om ze te uploaden
    </div>}

    {opening && <span className="drive-uploading" style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1500 }}><UploadCloud size={14} /> Editor openen…</span>}
    {officeSession && <OfficeEditor session={officeSession} onClose={() => { setOfficeSession(null); onChanged(); }} />}
  </div>;

  // ── Renderers ────────────────────────────────────────────────────────────
  function kebab(key: string, content: () => ReactNode, show: boolean) {
    if (!show) return null;
    return <div className="drive-kebab-wrap">
      <button
        type="button"
        className={`drive-kebab drive-pop-trigger${menu?.key === key ? ' is-open' : ''}`}
        aria-label="Acties"
        disabled={busy}
        onClick={e => { e.stopPropagation(); setMenu(menu?.key === key ? null : { key, mode: 'main' }); setNewOpen(false); }}
      ><MoreVertical size={16} /></button>
      {menu?.key === key && <div className="drive-pop is-right" role="menu">{content()}</div>}
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
        <div className="drive-pop-head"><button type="button" className="drive-pop-back" onClick={() => setMenu({ key, mode: 'main' })} aria-label="Terug"><ChevronLeft size={14} /></button> Verplaatsen naar</div>
        <div className="drive-pop-scroll">
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => moveItem(kind, id, null)}><FolderOpen size={16} /> {client.name} (geen map)</button>
          {folderOptions.map(o => <button type="button" key={o.id} className="drive-pop-item" role="menuitem" onClick={() => moveItem(kind, id, o.id)}><Folder size={16} style={{ color: 'var(--accent)' }} /> {o.label}</button>)}
        </div>
      </>;
    }
    return <>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); open(); }}><Pencil size={16} /> Openen</button>
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => setMenu({ key, mode: 'move' })}><Folder size={16} /> Verplaatsen naar… <ChevronRight size={14} style={{ marginLeft: 'auto' }} /></button>
    </>;
  }

  function fileMenu(att: Attachment) {
    return <>
      {isOfficeEditable(att) && <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); openOffice(att); }}><FilePen size={16} style={{ color: 'var(--accent-o)' }} /> Openen in editor</button>}
      <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); handleDownload(att); }}><Download size={16} /> Downloaden</button>
      {canWrite && <>
        <div className="drive-pop-sep" />
        <button type="button" className="drive-pop-item danger" role="menuitem" onClick={() => { setMenu(null); deleteFile(att); }}><Trash2 size={16} /> Verwijderen</button>
      </>}
    </>;
  }

  function renderFolderCard(folder: ContentFolder) {
    return <div className="drive-card is-folder" key={`fc-${folder.id}`}>
      <button type="button" className="drive-card-main" onClick={() => openFolder(folder.id)}>
        <span className="drive-ic" style={{ color: kindColor('folder') }}><Folder size={22} /></span>
        <span className="drive-card-text">
          <span className="drive-card-name">{folder.name}</span>
          <span className="drive-card-meta">{itemCount(folder.id)} item(s)</span>
        </span>
      </button>
      {kebab(`fc-${folder.id}`, () => folderMenu(folder), canWrite)}
    </div>;
  }

  function renderFolderRow(folder: ContentFolder) {
    return <div className="drive-row" key={`fr-${folder.id}`}>
      <button type="button" className="drive-row-main" onClick={() => openFolder(folder.id)}>
        <span className="drive-ic" style={{ color: kindColor('folder') }}><Folder size={20} /></span>
        <span className="drive-row-text"><span className="drive-row-name">{folder.name}</span><span className="drive-row-sub">{itemCount(folder.id)} item(s)</span></span>
      </button>
      {kebab(`fr-${folder.id}`, () => folderMenu(folder), canWrite)}
    </div>;
  }

  function fileOpen(it: DriveFile) {
    if (it.kind === 'note') onEditNote(it.note);
    else if (it.kind === 'document') onEditDocument(it.doc);
    else if (isOfficeEditable(it.att)) openOffice(it.att);
    else handleDownload(it.att);
  }

  function renderFileCard(it: DriveFile) {
    return <div className="drive-card" key={`c-${it.key}`}>
      <button type="button" className="drive-card-main" onClick={() => fileOpen(it)}>
        <span className="drive-ic" style={{ color: kindColor(it.kind) }}><FileGlyph it={it} size={24} /></span>
        <span className="drive-card-text">
          <span className="drive-card-name" title={fileName(it)}>{fileName(it)}</span>
          <span className="drive-card-meta"><em style={{ color: kindColor(it.kind), fontStyle: 'normal' }}>{fileKindLabel(it)}</em> · {dateNL(fileDate(it))}</span>
        </span>
      </button>
      {kebab(`c-${it.key}`, () => it.kind === 'file'
        ? fileMenu(it.att)
        : contentMenu(`c-${it.key}`, it.kind, it.kind === 'note' ? it.note.id : it.doc.id, () => fileOpen(it)), it.kind === 'file' || canWrite)}
    </div>;
  }

  function renderFileRow(it: DriveFile) {
    const sub = it.kind === 'file'
      ? <>{fmtBytes(it.att.size_bytes)} · {it.att.mime_type}</>
      : <RichTextExcerpt content={it.kind === 'note' ? it.note.content : it.doc.content} emptyText="Geen inhoud" />;
    return <div className="drive-row" key={`r-${it.key}`}>
      <button type="button" className="drive-row-main" onClick={() => fileOpen(it)}>
        <span className="drive-ic" style={{ color: kindColor(it.kind) }}><FileGlyph it={it} size={20} /></span>
        <span className="drive-row-text">
          <span className="drive-row-name" title={fileName(it)}>{fileName(it)}</span>
          <span className="drive-row-sub">{sub}</span>
        </span>
      </button>
      <span className="drive-row-meta">{dateNL(fileDate(it))}</span>
      {kebab(`r-${it.key}`, () => it.kind === 'file'
        ? fileMenu(it.att)
        : contentMenu(`r-${it.key}`, it.kind, it.kind === 'note' ? it.note.id : it.doc.id, () => fileOpen(it)), it.kind === 'file' || canWrite)}
    </div>;
  }
}
