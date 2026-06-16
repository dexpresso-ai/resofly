import type { AppData, InternalDocument, DocumentType } from '../types';
import { Button } from '../components/Ui';
import { RichTextExcerpt, RichTextViewer } from '../components/RichTextEditor';
import { dateNL } from '../lib/format';

export const documentTypeLabels: Record<DocumentType, string> = {
  contract: 'Contract',
  general: 'Algemeen',
  policy: 'Beleid',
  procedure: 'Procedure',
  other: 'Overig',
};

export function getDocumentTypeLabel(type?: string | null) {
  return documentTypeLabels[(type || 'general') as DocumentType] ?? 'Algemeen';
}

export function DocumentCard({ doc, data, onEdit }: { doc: InternalDocument; data: AppData; onEdit: (d: InternalDocument) => void }) {
  const client = data.clients.find(c => c.id === doc.client_id);
  const project = data.projects.find(p => p.id === doc.project_id);

  return <article className="note-card" onClick={() => onEdit(doc)}>
    <div className="note-card-head">
      <span className={`note-type note-type-${doc.document_type ?? 'general'}`}>{getDocumentTypeLabel(doc.document_type)}</span>
      <span className="note-date">{dateNL(doc.created_at)}</span>
    </div>
    <h3>{doc.title}</h3>
    <div className="note-content-preview"><RichTextViewer content={doc.content} /></div>
    <div className="note-relations">
      <span>{client ? `Klant: ${client.name}` : 'Geen klant'}</span>
      <span>{project ? `Project: ${project.name}` : 'Geen project'}</span>
    </div>
  </article>;
}

export function RelatedDocuments({
  title = 'Documenten',
  documents,
  data,
  canWrite,
  onNew,
  onEdit,
  emptyText = 'Nog geen documenten gekoppeld.',
  hideHeader = false,
}: {
  title?: string;
  documents: InternalDocument[];
  data: AppData;
  canWrite: boolean;
  onNew: () => void;
  onEdit: (d: InternalDocument) => void;
  emptyText?: string;
  hideHeader?: boolean;
}) {
  const sorted = [...documents].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return <section className="related-notes-panel">
    {!hideHeader && <div className="related-notes-head">
      <div>
        <h3>{title}</h3>
        <span>{sorted.length} gekoppeld document{sorted.length === 1 ? '' : 'en'}</span>
      </div>
      {canWrite && <Button onClick={onNew}>+ Document</Button>}
    </div>}
    {sorted.length === 0 ? <div className="related-notes-empty">{emptyText}</div> : <div className="related-notes-list">
      {sorted.map(doc => <button type="button" className="related-note-item" key={doc.id} onClick={() => onEdit(doc)}>
        <div className="related-note-top"><span className={`note-type note-type-${doc.document_type ?? 'general'}`}>{getDocumentTypeLabel(doc.document_type)}</span><span>{dateNL(doc.created_at)}</span></div>
        <strong>{doc.title}</strong>
        <p><RichTextExcerpt content={doc.content} /></p>
      </button>)}
    </div>}
  </section>;
}
