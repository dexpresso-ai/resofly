import type { AppData, Client } from '../types';
import { euro } from '../lib/format';
import { Button } from '../components/Ui';

export function Clients({ data, onNew, onEdit }: { data: AppData; onNew: () => void; onEdit: (c: Client) => void }) {
  const notesForClient = (client: Client) => data.notes.filter(note => note.client_id === client.id || data.projects.some(project => project.client_id === client.id && project.id === note.project_id));

  return <><div className="crm-toolbar"><Button variant="primary" onClick={onNew}>+ Nieuwe klant</Button></div><div className="clients-grid">
    {data.clients.map(client => {
      const noteCount = notesForClient(client).length;
      return <article className="client-card" key={client.id} onClick={() => onEdit(client)}>
        <div className="cc-avatar" style={{ background: client.color }}>{client.name.slice(0,2).toUpperCase()}</div>
        <div className="cc-name">{client.name}</div><div className="cc-id">{client.client_code ?? '—'}</div>
        <div className="cc-meta"><span>{client.contact_name ?? 'Geen contact'}</span><span>{euro(client.value_eur)}</span></div>
        <div className="cc-note-count">📝 {noteCount} notitie{noteCount === 1 ? '' : 's'}</div>
        <div className="cd-tags">{client.tags?.map(tag => <span className="cd-tag" key={tag}>{tag}</span>)}</div>
      </article>;
    })}
  </div></>;
}
