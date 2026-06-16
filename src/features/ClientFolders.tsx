import { useState } from 'react';
import { ChevronRight, FileText, FolderOpen, FolderPlus, Link2, Pencil, StickyNote, Trash2, Upload, X } from 'lucide-react';
import type { AppData, Client, ContentFolder, InternalDocument, Note } from '../types';
import { Button, Select } from '../components/Ui';
import { AttachmentList } from '../components/AttachmentList';
import { RichTextExcerpt } from '../components/RichTextEditor';
import { dateNL } from '../lib/format';
import { insertRow, updateRow, deleteContentFolder } from '../lib/repository';
import { uploadToR2 } from '../lib/r2';
import { childFolders, clientFolderOptions, folderDescendantIds, folderPath, type FolderOption } from '../lib/folders';
import { getNoteTypeLabel } from './Notes';
import { getDocumentTypeLabel } from './Documents';

/**
 * Per-klant mappenstructuur: een hiërarchische map waarin notities en documenten
 * aangemaakt (via de centrale editor met folder_id-default), ingelezen (bestaande
 * items koppelen of bestanden uploaden) en verplaatst kunnen worden. Folder-CRUD,
 * verplaatsen en uploaden gaan rechtstreeks via de repository met een onChanged-
 * refresh, net als TicketNotesTimeline en AttachmentList.
 */
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
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const folders = data.folders.filter(f => f.client_id === client.id);
  const path = folderPath(folders, currentId);
  const subfolders = childFolders(folders, client.id, currentId);
  const folderOptions = clientFolderOptions(data.folders, client.id);

  // Items van deze klant (direct of via een project), voor "niet ingedeeld" en inlezen.
  const projectIds = new Set(data.projects.filter(p => p.client_id === client.id).map(p => p.id));
  const clientNotes = data.notes.filter(n => n.client_id === client.id || Boolean(n.project_id && projectIds.has(n.project_id)));
  const clientDocuments = data.documents.filter(d => d.client_id === client.id || Boolean(d.project_id && projectIds.has(d.project_id)));

  const notesHere = currentId === null ? clientNotes.filter(n => !n.folder_id) : data.notes.filter(n => n.folder_id === currentId);
  const docsHere = currentId === null ? clientDocuments.filter(d => !d.folder_id) : data.documents.filter(d => d.folder_id === currentId);

  const linkableNotes = currentId ? clientNotes.filter(n => n.folder_id !== currentId) : [];
  const linkableDocs = currentId ? clientDocuments.filter(d => d.folder_id !== currentId) : [];
  const folderFiles = currentId ? data.attachments.filter(a => a.entity_type === 'folder' && a.entity_id === currentId) : [];

  const itemCount = (folderId: string) =>
    data.notes.filter(n => n.folder_id === folderId).length + data.documents.filter(d => d.folder_id === folderId).length;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Actie mislukt');
    } finally {
      setBusy(false);
    }
  }

  function createFolder() {
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
    run(async () => { await updateRow(kind === 'note' ? 'notes' : 'documents', id, { folder_id: folderId }, organizationId); });
  }

  async function uploadFile(file: File) {
    if (!currentId) return;
    setUploading(true);
    setError(null);
    try {
      await uploadToR2(file, organizationId, { entity_type: 'folder', entity_id: currentId });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload mislukt');
    } finally {
      setUploading(false);
    }
  }

  return <div className="folders-view">
    <div className="folders-crumbs">
      <button type="button" className={currentId === null ? 'active' : ''} onClick={() => { setCurrentId(null); setLinkOpen(false); }}>{client.name}</button>
      {path.map(folder => <span key={folder.id} className="folders-crumb">
        <ChevronRight size={13} aria-hidden="true" />
        <button type="button" className={folder.id === currentId ? 'active' : ''} onClick={() => { setCurrentId(folder.id); setLinkOpen(false); }}>{folder.name}</button>
      </span>)}
    </div>

    {canWrite && <div className="folders-toolbar">
      <Button onClick={createFolder} disabled={busy}><FolderPlus size={14} /> {currentId ? 'Submap' : 'Nieuwe map'}</Button>
      <Button onClick={() => onNewNote(currentId)} disabled={busy}><StickyNote size={14} /> Notitie</Button>
      <Button onClick={() => onNewDocument(currentId)} disabled={busy}><FileText size={14} /> Document</Button>
      {currentId && <Button onClick={() => setLinkOpen(o => !o)} disabled={busy}><Link2 size={14} /> Inlezen</Button>}
      {currentId && <label className={`folders-upload-btn${uploading ? ' busy' : ''}`}>
        <Upload size={14} /> <span>{uploading ? 'Uploaden…' : 'Upload'}</span>
        <input type="file" disabled={uploading} onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }} />
      </label>}
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

    <section className="folder-section">
      <div className="folder-section-head"><span>Mappen</span><span className="folder-section-count">{subfolders.length}</span></div>
      {subfolders.length === 0
        ? <div className="client-empty-line">Nog geen {currentId ? 'submappen' : 'mappen'}.{canWrite ? ` Maak er een aan met "${currentId ? 'Submap' : 'Nieuwe map'}".` : ''}</div>
        : <div className="folder-grid">
            {subfolders.map(folder => <div className="folder-card" key={folder.id}>
              <button type="button" className="folder-card-open" onClick={() => { setCurrentId(folder.id); setLinkOpen(false); }}>
                <FolderOpen size={18} aria-hidden="true" />
                <span className="folder-card-name">{folder.name}</span>
                <span className="folder-card-meta">{itemCount(folder.id)} item(s)</span>
              </button>
              {canWrite && <div className="folder-card-actions">
                <button type="button" title="Hernoemen" onClick={() => renameFolder(folder)} disabled={busy}><Pencil size={13} /></button>
                <button type="button" title="Verwijderen" className="danger" onClick={() => deleteFolder(folder)} disabled={busy}><Trash2 size={13} /></button>
              </div>}
            </div>)}
          </div>}
    </section>

    <section className="folder-section">
      <div className="folder-section-head"><span>{currentId ? 'Notities & documenten' : 'Niet ingedeeld'}</span><span className="folder-section-count">{notesHere.length + docsHere.length}</span></div>
      {notesHere.length + docsHere.length === 0
        ? <div className="client-empty-line">{currentId ? 'Deze map bevat nog geen notities of documenten.' : 'Alle notities en documenten van deze klant zitten al in een map.'}</div>
        : <div className="folder-item-list">
            {notesHere.map(n => <FolderItemRow key={`n-${n.id}`} title={n.title} date={n.created_at} content={n.content} badge={getNoteTypeLabel(n.note_type)} badgeClass={`note-type-${n.note_type ?? 'general'}`} folderId={n.folder_id} canWrite={canWrite} busy={busy} folderOptions={folderOptions} onOpen={() => onEditNote(n)} onMove={id => moveItem('note', n.id, id)} />)}
            {docsHere.map(d => <FolderItemRow key={`d-${d.id}`} title={d.title} date={d.created_at} content={d.content} badge={getDocumentTypeLabel(d.document_type)} badgeClass={`note-type-${d.document_type ?? 'general'}`} folderId={d.folder_id} canWrite={canWrite} busy={busy} folderOptions={folderOptions} onOpen={() => onEditDocument(d)} onMove={id => moveItem('document', d.id, id)} />)}
          </div>}
    </section>

    {currentId && <section className="folder-section">
      <div className="folder-section-head"><span>Bestanden</span><span className="folder-section-count">{folderFiles.length}</span></div>
      {folderFiles.length === 0
        ? <div className="client-empty-line">Nog geen bestanden in deze map.{canWrite ? ' Gebruik "Upload" om een PDF, Word-bestand of afbeelding in te lezen.' : ''}</div>
        : <AttachmentList attachments={data.attachments} entityType="folder" entityId={currentId} onChanged={onChanged} canDelete={canWrite} />}
    </section>}
  </div>;
}

function FolderItemRow({
  title,
  date,
  content,
  badge,
  badgeClass,
  folderId,
  canWrite,
  busy,
  folderOptions,
  onOpen,
  onMove,
}: {
  title: string;
  date: string;
  content: string;
  badge: string;
  badgeClass: string;
  folderId: string | null;
  canWrite: boolean;
  busy: boolean;
  folderOptions: FolderOption[];
  onOpen: () => void;
  onMove: (folderId: string | null) => void;
}) {
  return <div className="folder-item">
    <button type="button" className="folder-item-main" onClick={onOpen}>
      <span className={`note-type ${badgeClass}`}>{badge}</span>
      <span className="folder-item-text">
        <span className="folder-item-title">{title}</span>
        <span className="folder-item-preview"><RichTextExcerpt content={content} emptyText="Geen inhoud" /></span>
      </span>
      <span className="folder-item-date">{dateNL(date)}</span>
    </button>
    {canWrite && <Select className="folder-move-select" value={folderId ?? ''} onChange={e => onMove(e.target.value || null)} disabled={busy}>
      <option value="">Geen map</option>
      {folderOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </Select>}
  </div>;
}
