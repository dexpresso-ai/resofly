import type { AppData, Note } from '../types';
import { Button } from '../components/Ui';
export function Notes({ data, onNew, onEdit }: { data: AppData; onNew: () => void; onEdit: (n: Note) => void }) {
  return <div className="notes-layout"><aside className="notes-sidebar"><div className="notes-sidebar-head"><span>Notities</span><Button onClick={onNew}>+</Button></div><div className="notes-list">{data.notes.map(note => <div className="note-item" key={note.id} onClick={() => onEdit(note)}><div className="ni-title">{note.title}</div><div className="ni-preview">{note.content}</div></div>)}</div></aside><main className="note-empty"><div className="ne-big">Selecteer of maak een notitie</div></main></div>;
}
