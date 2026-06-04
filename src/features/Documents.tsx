import { useState } from 'react';
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

export function Documents({ data, onNew, onEdit }: { data: AppData; onNew: () => void; onEdit: (d: InternalDocument) => void }) {
  const [filter, setFilter] = useState<DocumentType | 'all'>('all');
  const sorted = [...data.documents].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const byType = sorted.reduce<Record<string, number>>((acc, doc) => {
    const key = doc.document_type ?? 'general';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const visible = filter === 'all' ? sorted : sorted.filter(doc => (doc.document_type ?? 'general') === filter);

  return <div className="notes-layout enriched">
    <aside className="notes-sidebar">
      <div className="notes-sidebar-head"><span>Documenten</span><Button onClick={onNew}>+</Button></div>
      <div className="notes-summary">
        <strong>{sorted.length}</strong>
        <span>interne documenten</span>
      </div>
      <div className="note-type-summary">
        <div className={`doc-filter-row${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}><span>Alle categorie&euml;n</span><strong>{sorted.length}</strong></div>
        {Object.entries(documentTypeLabels).map(([key, label]) => <div key={key} className={`doc-filter-row${filter === key ? ' active' : ''}`} onClick={() => setFilter(key as DocumentType)}><span>{label}</span><strong>{byType[key] ?? 0}</strong></div>)}
      </div>
      <div className="notes-list">
        {visible.map(doc => <div className="note-item" key={doc.id} onClick={() => onEdit(doc)}>
          <div className="ni-row"><span className={`note-type note-type-${doc.document_type ?? 'general'}`}>{getDocumentTypeLabel(doc.document_type)}</span><span>{dateNL(doc.created_at)}</span></div>
          <div className="ni-title">{doc.title}</div>
          <div className="ni-preview"><RichTextExcerpt content={doc.content} emptyText="Geen inhoud" /></div>
        </div>)}
      </div>
    </aside>
    <main className="notes-main">
      <div className="notes-main-head">
        <div>
          <h2>Interne documenten</h2>
          <p>Centrale opslag van contracten, beleid en algemene documenten, gekoppeld aan klanten en projecten.</p>
        </div>
        <Button variant="primary" onClick={onNew}>+ Nieuw document</Button>
      </div>
      {visible.length === 0 ? <div className="note-empty"><div className="ne-big">Nog geen documenten</div><p>Maak je eerste interne document en koppel het direct aan een klant of project.</p></div> : <div className="notes-card-grid">
        {visible.map(doc => <DocumentCard key={doc.id} doc={doc} data={data} onEdit={onEdit} />)}
      </div>}
    </main>
  </div>;
}
