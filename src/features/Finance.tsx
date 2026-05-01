import { Download } from 'lucide-react';
import type { AppData, Invoice, Quote } from '../types';
import { Button } from '../components/Ui';
import { dateNL, euro, total } from '../lib/format';
import { exportFinancePDF } from '../lib/pdf';

export function Quotes({ data, onNew, onEdit }: { data: AppData; onNew: () => void; onEdit: (q: Quote) => void }) {
  return <FinanceList kind="quote" title="Offertes" docs={data.quotes} data={data} onNew={onNew} onEdit={onEdit}/>;
}
export function Invoices({ data, onNew, onEdit }: { data: AppData; onNew: () => void; onEdit: (i: Invoice) => void }) {
  return <FinanceList kind="invoice" title="Facturen" docs={data.invoices} data={data} onNew={onNew} onEdit={onEdit}/>;
}

function FinanceList<T extends Quote | Invoice>({
  kind, title, docs, data, onNew, onEdit,
}: { kind: 'quote' | 'invoice'; title: string; docs: T[]; data: AppData; onNew: () => void; onEdit: (doc: T) => void }) {
  return <>
    <div className="fin-header"><h2>{title}</h2><Button variant="primary" onClick={onNew}>+ Nieuw</Button></div>
    <div className="fin-list">
      {docs.map(doc => {
        const client = data.clients.find(c => c.id === doc.client_id) ?? null;
        const amount = total(doc.lines).total;
        return <article className={`fin-item st-${doc.status}`} key={doc.id} onClick={() => onEdit(doc)}>
          <div className="fin-num">{doc.number}</div>
          <div className="fin-body">
            <div className="fin-title">{client?.name ?? 'Geen klant'}</div>
            <div className="fin-meta">{dateNL(doc.date)}</div>
          </div>
          <div className="fin-date">{'due_date' in doc ? dateNL(doc.due_date) : dateNL((doc as Quote).valid_until)}</div>
          <div className="fin-amount">{euro(amount)}</div>
          <div className={`fin-status ${doc.status}`}>{doc.status}</div>
          <button
            type="button"
            className="att-btn"
            onClick={(e) => { e.stopPropagation(); void exportFinancePDF(doc, kind, client, { company: data.companySettings }).catch(error => alert(error instanceof Error ? error.message : 'PDF-export mislukt')); }}
            title="Download PDF"
          ><Download size={14}/></button>
        </article>;
      })}
    </div>
  </>;
}
