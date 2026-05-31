import type { AppData, Note, NoteType } from '../types';
import { Button } from '../components/Ui';
import { RichTextExcerpt, RichTextViewer } from '../components/RichTextEditor';
import { dateNL } from '../lib/format';

export const noteTypeLabels: Record<NoteType, string> = {
  general: 'Algemeen',
  meeting: 'Meeting',
  action: 'Actiepunt',
  decision: 'Besluit',
  idea: 'Idee',
  support: 'Support',
};

export function getNoteTypeLabel(type?: string | null) {
  return noteTypeLabels[(type || 'general') as NoteType] ?? 'Algemeen';
}

export function NoteCard({ note, data, onEdit }: { note: Note; data: AppData; onEdit: (n: Note) => void }) {
  const client = data.clients.find(c => c.id === note.client_id);
  const project = data.projects.find(p => p.id === note.project_id);
  const tags = Array.isArray(note.tags) ? note.tags : [];

  return <article className="note-card" onClick={() => onEdit(note)}>
    <div className="note-card-head">
      <span className={`note-type note-type-${note.note_type ?? 'general'}`}>{getNoteTypeLabel(note.note_type)}</span>
      <span className="note-date">{dateNL(note.created_at)}</span>
    </div>
    <h3>{note.title}</h3>
    <div className="note-content-preview"><RichTextViewer content={note.content} /></div>
    <div className="note-relations">
      <span>{client ? `Klant: ${client.name}` : 'Geen klant'}</span>
      <span>{project ? `Project: ${project.name}` : 'Geen project'}</span>
    </div>
    {tags.length > 0 && <div className="note-tags">{tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
  </article>;
}

export function RelatedNotes({
  title = 'Notities',
  notes,
  data,
  canWrite,
  onNew,
  onEdit,
  emptyText = 'Nog geen notities gekoppeld.',
  hideHeader = false,
}: {
  title?: string;
  notes: Note[];
  data: AppData;
  canWrite: boolean;
  onNew: () => void;
  onEdit: (n: Note) => void;
  emptyText?: string;
  hideHeader?: boolean;
}) {
  const sorted = [...notes].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return <section className="related-notes-panel">
    {!hideHeader && <div className="related-notes-head">
      <div>
        <h3>{title}</h3>
        <span>{sorted.length} gekoppelde notitie{sorted.length === 1 ? '' : 's'}</span>
      </div>
      {canWrite && <Button onClick={onNew}>+ Notitie</Button>}
    </div>}
    {sorted.length === 0 ? <div className="related-notes-empty">{emptyText}</div> : <div className="related-notes-list">
      {sorted.map(note => <button type="button" className="related-note-item" key={note.id} onClick={() => onEdit(note)}>
        <div className="related-note-top"><span className={`note-type note-type-${note.note_type ?? 'general'}`}>{getNoteTypeLabel(note.note_type)}</span><span>{dateNL(note.created_at)}</span></div>
        <strong>{note.title}</strong>
        <p><RichTextExcerpt content={note.content} /></p>
        {Array.isArray(note.tags) && note.tags.length > 0 && <div className="note-tags compact">{note.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
      </button>)}
    </div>}
  </section>;
}

export function Notes({ data, onNew, onEdit }: { data: AppData; onNew: () => void; onEdit: (n: Note) => void }) {
  const sorted = [...data.notes].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const byType = sorted.reduce<Record<string, number>>((acc, note) => {
    const key = note.note_type ?? 'general';
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  return <div className="notes-layout enriched">
    <aside className="notes-sidebar">
      <div className="notes-sidebar-head"><span>Notities</span><Button onClick={onNew}>+</Button></div>
      <div className="notes-summary">
        <strong>{sorted.length}</strong>
        <span>totaal vastgelegd</span>
      </div>
      <div className="note-type-summary">
        {Object.entries(noteTypeLabels).map(([key, label]) => <div key={key}><span>{label}</span><strong>{byType[key] ?? 0}</strong></div>)}
      </div>
      <div className="notes-list">
        {sorted.map(note => <div className="note-item" key={note.id} onClick={() => onEdit(note)}>
          <div className="ni-row"><span className={`note-type note-type-${note.note_type ?? 'general'}`}>{getNoteTypeLabel(note.note_type)}</span><span>{dateNL(note.created_at)}</span></div>
          <div className="ni-title">{note.title}</div>
          <div className="ni-preview"><RichTextExcerpt content={note.content} emptyText="Geen inhoud" /></div>
        </div>)}
      </div>
    </aside>
    <main className="notes-main">
      <div className="notes-main-head">
        <div>
          <h2>Alle notities</h2>
          <p>Centraal overzicht van algemene, klant- en projectnotities.</p>
        </div>
        <Button variant="primary" onClick={onNew}>+ Nieuwe notitie</Button>
      </div>
      {sorted.length === 0 ? <div className="note-empty"><div className="ne-big">Nog geen notities</div><p>Maak je eerste notitie en koppel deze direct aan een klant of project.</p></div> : <div className="notes-card-grid">
        {sorted.map(note => <NoteCard key={note.id} note={note} data={data} onEdit={onEdit} />)}
      </div>}
    </main>
  </div>;
}
