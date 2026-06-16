import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { AppData, Note, InternalDocument } from '../types';
import { Button } from '../components/Ui';
import { RichTextExcerpt } from '../components/RichTextEditor';
import { dateNL } from '../lib/format';
import { NoteCard, getNoteTypeLabel } from './Notes';
import { DocumentCard, getDocumentTypeLabel } from './Documents';

export type ContentView = 'all' | 'notes' | 'documents';

type ContentItem =
  | { kind: 'note'; id: string; created_at: string; note: Note }
  | { kind: 'document'; id: string; created_at: string; doc: InternalDocument };

/**
 * Gecombineerde "Inhoud"-weergave: notities en documenten staan bij elkaar in één
 * lijst, met een filter om elk type snel aan/uit te zetten. De sidebar-ingangen
 * Overzicht/Notities/Documenten deeplinken via `initialView` naar dezelfde pagina;
 * main.tsx hermount de component per pagina (key) zodat de juiste filter actief is.
 */
export function ContentLibrary({
  data,
  initialView = 'all',
  onNewNote,
  onEditNote,
  onNewDocument,
  onEditDocument,
}: {
  data: AppData;
  initialView?: ContentView;
  onNewNote: () => void;
  onEditNote: (n: Note) => void;
  onNewDocument: () => void;
  onEditDocument: (d: InternalDocument) => void;
}) {
  const [showNotes, setShowNotes] = useState(initialView !== 'documents');
  const [showDocuments, setShowDocuments] = useState(initialView !== 'notes');

  const noteCount = data.notes.length;
  const documentCount = data.documents.length;

  const items: ContentItem[] = [
    ...(showNotes ? data.notes.map(note => ({ kind: 'note' as const, id: note.id, created_at: note.created_at, note })) : []),
    ...(showDocuments ? data.documents.map(doc => ({ kind: 'document' as const, id: doc.id, created_at: doc.created_at, doc })) : []),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const visibleCount = items.length;
  const noneSelected = !showNotes && !showDocuments;

  return <div className="notes-layout enriched">
    <aside className="notes-sidebar">
      <div className="notes-sidebar-head"><span>Inhoud</span></div>
      <div className="notes-summary">
        <strong>{noteCount + documentCount}</strong>
        <span>notities &amp; documenten</span>
      </div>
      <div className="note-type-summary">
        <div className={`doc-filter-row content-toggle${showNotes ? ' active' : ''}`} role="switch" aria-checked={showNotes} onClick={() => setShowNotes(v => !v)}>
          <span>{showNotes ? <Eye size={13} /> : <EyeOff size={13} />}Notities</span><strong>{noteCount}</strong>
        </div>
        <div className={`doc-filter-row content-toggle${showDocuments ? ' active' : ''}`} role="switch" aria-checked={showDocuments} onClick={() => setShowDocuments(v => !v)}>
          <span>{showDocuments ? <Eye size={13} /> : <EyeOff size={13} />}Documenten</span><strong>{documentCount}</strong>
        </div>
      </div>
      <div className="notes-list">
        {items.map(item => item.kind === 'note'
          ? <div className="note-item" key={`note-${item.id}`} onClick={() => onEditNote(item.note)}>
              <div className="ni-row"><span className={`note-type note-type-${item.note.note_type ?? 'general'}`}>{getNoteTypeLabel(item.note.note_type)}</span><span>{dateNL(item.note.created_at)}</span></div>
              <div className="ni-title">{item.note.title}</div>
              <div className="ni-preview"><RichTextExcerpt content={item.note.content} emptyText="Geen inhoud" /></div>
            </div>
          : <div className="note-item" key={`doc-${item.id}`} onClick={() => onEditDocument(item.doc)}>
              <div className="ni-row"><span className={`note-type note-type-${item.doc.document_type ?? 'general'}`}>{getDocumentTypeLabel(item.doc.document_type)}</span><span>{dateNL(item.doc.created_at)}</span></div>
              <div className="ni-title">{item.doc.title}</div>
              <div className="ni-preview"><RichTextExcerpt content={item.doc.content} emptyText="Geen inhoud" /></div>
            </div>)}
      </div>
    </aside>
    <main className="notes-main">
      <div className="notes-main-head">
        <div>
          <h2>Inhoud</h2>
          <p>Notities en documenten op één plek. Zet links snel een type aan of uit om gericht te filteren.</p>
        </div>
        <div className="content-actions">
          <Button onClick={onNewNote}>+ Notitie</Button>
          <Button variant="primary" onClick={onNewDocument}>+ Document</Button>
        </div>
      </div>
      {noneSelected
        ? <div className="note-empty"><div className="ne-big">Geen filter actief</div><p>Zet links Notities of Documenten aan om je inhoud te tonen.</p></div>
        : visibleCount === 0
          ? <div className="note-empty"><div className="ne-big">Nog niets vastgelegd</div><p>Maak je eerste notitie of document en koppel het direct aan een klant of project.</p></div>
          : <div className="notes-card-grid">
              {items.map(item => item.kind === 'note'
                ? <NoteCard key={`note-${item.id}`} note={item.note} data={data} onEdit={onEditNote} />
                : <DocumentCard key={`doc-${item.id}`} doc={item.doc} data={data} onEdit={onEditDocument} />)}
            </div>}
    </main>
  </div>;
}
