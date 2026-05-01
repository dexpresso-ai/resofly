import type { AppData, Ticket } from '../types';
import { Button } from '../components/Ui';
import { priorityLabel } from '../lib/format';

const convertibleStatuses = new Set<Ticket['status']>(['new', 'review', 'approved']);

export function Tickets({ data, onNew, onEdit, onConvert }: { data: AppData; onNew: () => void; onEdit: (t: Ticket) => void; onConvert: (t: Ticket) => void }) {
  return <><div className="ticket-stats">{['new','review','approved','rejected','converted'].map(st => <div className="ticket-stat" key={st}><div className="ts-label">{st}</div><div className="ts-val">{data.tickets.filter(t=>t.status===st).length}</div></div>)}</div><div className="crm-toolbar"><Button variant="primary" onClick={onNew}>+ Nieuw ticket</Button></div><div className="ticket-list">
    {data.tickets.map(ticket => { const client = data.clients.find(c => c.id === ticket.client_id); const canConvert = convertibleStatuses.has(ticket.status) && !ticket.converted_to_project_id; return <article className={`ticket-item pri-${ticket.priority}`} key={ticket.id} onClick={() => onEdit(ticket)}>
      <div className="tk-body"><div className="tk-title">{ticket.title}</div><div className="tk-meta"><span>{client?.name ?? 'Geen klant'}</span><span className={`tk-pri-label ${ticket.priority}`}>{priorityLabel(ticket.priority)}</span>{ticket.converted_to_project_id && <span>Project aangemaakt</span>}</div></div><span className={`tk-status ${ticket.status}`}>{ticket.status}</span><div className="tk-actions-btn">{canConvert ? <Button onClick={(e)=>{e.stopPropagation(); onConvert(ticket)}}>Project maken</Button> : <Button disabled>{ticket.status === 'converted' || ticket.converted_to_project_id ? 'Al omgezet' : 'Niet converteerbaar'}</Button>}</div>
    </article>})}
  </div></>;
}
