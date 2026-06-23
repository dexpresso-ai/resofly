import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, FileText, FolderOpen, Receipt, Search, StickyNote, Ticket, Truck, Users, X, type LucideIcon } from 'lucide-react';
import type { AppData, Client, InternalDocument, Invoice, Note, Project, Quote, Supplier, Task, Ticket as TicketType } from '../types';
import { euro, total } from '../lib/format';

export type SearchResultKind = 'client' | 'project' | 'task' | 'ticket' | 'note' | 'document' | 'quote' | 'invoice' | 'supplier';

export type SearchResult =
  | { kind: 'client'; id: string; title: string; subtitle: string; item: Client }
  | { kind: 'project'; id: string; title: string; subtitle: string; item: Project }
  | { kind: 'task'; id: string; title: string; subtitle: string; item: Task }
  | { kind: 'ticket'; id: string; title: string; subtitle: string; item: TicketType }
  | { kind: 'note'; id: string; title: string; subtitle: string; item: Note }
  | { kind: 'document'; id: string; title: string; subtitle: string; item: InternalDocument }
  | { kind: 'quote'; id: string; title: string; subtitle: string; item: Quote }
  | { kind: 'invoice'; id: string; title: string; subtitle: string; item: Invoice }
  | { kind: 'supplier'; id: string; title: string; subtitle: string; item: Supplier };

const kindMeta: Record<SearchResultKind, { label: string; icon: LucideIcon }> = {
  client: { label: 'Klanten', icon: Users },
  project: { label: 'Projecten', icon: FolderOpen },
  task: { label: 'Taken', icon: CheckSquare },
  ticket: { label: 'Tickets', icon: Ticket },
  note: { label: 'Notities', icon: StickyNote },
  document: { label: 'Documenten', icon: FileText },
  quote: { label: 'Offertes', icon: FileText },
  invoice: { label: 'Facturen', icon: Receipt },
  supplier: { label: 'Leveranciers', icon: Truck },
};

// Volgorde waarin de groepen in het paneel verschijnen.
const kindOrder: SearchResultKind[] = ['client', 'project', 'task', 'ticket', 'note', 'document', 'quote', 'invoice', 'supplier'];

const PER_GROUP_LIMIT = 6;

/** Verwijdert simpele HTML-tags uit rich-text-velden zodat de zoek-preview leesbaar blijft. */
function plain(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some(field => field != null && field.toLowerCase().includes(query));
}

/** Markeert het overeenkomende deel van de titel. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const index = text.toLowerCase().indexOf(query);
  if (index < 0) return <>{text}</>;
  return <>
    {text.slice(0, index)}
    <mark className="gs-hl">{text.slice(index, index + query.length)}</mark>
    {text.slice(index + query.length)}
  </>;
}

export function GlobalSearch({ data, onNavigate }: { data: AppData; onNavigate: (result: SearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const clientById = useMemo(() => new Map(data.clients.map(c => [c.id, c])), [data.clients]);
  const projectById = useMemo(() => new Map(data.projects.map(p => [p.id, p])), [data.projects]);

  const term = query.trim().toLowerCase();

  const results = useMemo<SearchResult[]>(() => {
    if (term.length < 2) return [];
    const out: SearchResult[] = [];

    for (const c of data.clients) {
      if (matches(term, c.name, c.client_code, c.contact_name, c.email, c.phone, plain(c.notes), c.tags?.join(' '))) {
        out.push({ kind: 'client', id: c.id, title: c.name, subtitle: [c.client_code, c.email].filter(Boolean).join(' · ') || 'Klant', item: c });
      }
    }
    for (const p of data.projects) {
      if (matches(term, p.name, plain(p.description))) {
        const client = p.client_id ? clientById.get(p.client_id) : null;
        out.push({ kind: 'project', id: p.id, title: p.name, subtitle: client?.name ?? (p.archived ? 'Gearchiveerd' : 'Project'), item: p });
      }
    }
    for (const t of data.tasks) {
      if (matches(term, t.title, plain(t.description), t.tags?.join(' '))) {
        const project = projectById.get(t.project_id);
        out.push({ kind: 'task', id: t.id, title: t.title, subtitle: project?.name ?? 'Taak', item: t });
      }
    }
    for (const t of data.tickets) {
      if (matches(term, t.title, plain(t.description), plain(t.notes))) {
        const client = t.client_id ? clientById.get(t.client_id) : null;
        out.push({ kind: 'ticket', id: t.id, title: t.title, subtitle: client?.name ?? 'Ticket', item: t });
      }
    }
    for (const n of data.notes) {
      if (matches(term, n.title, plain(n.content), n.tags?.join(' '))) {
        const ctx = n.client_id ? clientById.get(n.client_id)?.name : n.project_id ? projectById.get(n.project_id)?.name : null;
        out.push({ kind: 'note', id: n.id, title: n.title || 'Notitie', subtitle: ctx ?? 'Notitie', item: n });
      }
    }
    for (const d of data.documents) {
      if (matches(term, d.title, plain(d.content))) {
        const ctx = d.client_id ? clientById.get(d.client_id)?.name : d.project_id ? projectById.get(d.project_id)?.name : null;
        out.push({ kind: 'document', id: d.id, title: d.title || 'Document', subtitle: ctx ?? 'Document', item: d });
      }
    }
    for (const q of data.quotes) {
      if (matches(term, q.number, plain(q.notes))) {
        const client = q.client_id ? clientById.get(q.client_id) : null;
        out.push({ kind: 'quote', id: q.id, title: `Offerte ${q.number}`, subtitle: [client?.name, euro(total(q.lines).total)].filter(Boolean).join(' · '), item: q });
      }
    }
    for (const inv of data.invoices) {
      if (matches(term, inv.number, plain(inv.notes))) {
        const client = inv.client_id ? clientById.get(inv.client_id) : null;
        out.push({ kind: 'invoice', id: inv.id, title: `Factuur ${inv.number}`, subtitle: [client?.name, euro(total(inv.lines).total)].filter(Boolean).join(' · '), item: inv });
      }
    }
    for (const s of data.suppliers) {
      if (matches(term, s.name, s.supplier_code, s.contact_name, s.email, s.city, s.vat_number)) {
        out.push({ kind: 'supplier', id: s.id, title: s.name, subtitle: [s.supplier_code, s.city].filter(Boolean).join(' · ') || 'Leverancier', item: s });
      }
    }

    return out;
  }, [term, data, clientById, projectById]);

  // Per type beperken voor een overzichtelijk paneel, maar het totaal per groep onthouden.
  const groups = useMemo(() => {
    return kindOrder
      .map(kind => {
        const all = results.filter(r => r.kind === kind);
        return { kind, total: all.length, items: all.slice(0, PER_GROUP_LIMIT) };
      })
      .filter(group => group.total > 0);
  }, [results]);

  // Platte lijst in weergavevolgorde voor toetsenbordnavigatie.
  const flat = useMemo(() => groups.flatMap(group => group.items), [groups]);

  useEffect(() => { setActiveIndex(0); }, [term]);

  // Ctrl/Cmd+K focust het zoekveld vanuit de hele app.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function close() {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }

  function choose(result: SearchResult) {
    onNavigate(result);
    close();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { close(); return; }
    if (flat.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(i => (i + 1) % flat.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(i => (i - 1 + flat.length) % flat.length); }
    else if (event.key === 'Enter') { event.preventDefault(); const pick = flat[activeIndex] ?? flat[0]; if (pick) choose(pick); }
  }

  const showPanel = open && term.length >= 2;

  return <div className="global-search">
    <div className="gs-field">
      <Search size={15} className="gs-field-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        className="gs-input"
        placeholder="Zoeken…"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onInputKeyDown}
        aria-label="Zoeken in werkruimte"
      />
      {query && <button type="button" className="gs-clear" onClick={close} aria-label="Zoeken sluiten"><X size={14} /></button>}
    </div>

    {showPanel && <>
      <div className="gs-backdrop" onClick={close} />
      <div className="gs-panel" role="listbox" aria-label="Zoekresultaten">
        <div className="gs-panel-head">
          <span>Resultaten voor “{query.trim()}”</span>
          <span className="gs-count">{results.length}</span>
        </div>
        {flat.length === 0
          ? <div className="gs-empty">Geen resultaten gevonden.</div>
          : <div className="gs-groups">
              {groups.map(group => {
                const Meta = kindMeta[group.kind];
                return <div className="gs-group" key={group.kind}>
                  <div className="gs-group-head"><Meta.icon size={13} /><span>{Meta.label}</span><span className="gs-group-count">{group.total}</span></div>
                  {group.items.map(result => {
                    const flatIndex = flat.indexOf(result);
                    return <button
                      type="button"
                      key={`${result.kind}-${result.id}`}
                      className={`gs-result${flatIndex === activeIndex ? ' active' : ''}`}
                      onClick={() => choose(result)}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      role="option"
                      aria-selected={flatIndex === activeIndex}
                    >
                      <Meta.icon size={15} className="gs-result-icon" aria-hidden="true" />
                      <span className="gs-result-text">
                        <span className="gs-result-title"><Highlight text={result.title} query={term} /></span>
                        {result.subtitle && <span className="gs-result-sub">{result.subtitle}</span>}
                      </span>
                    </button>;
                  })}
                  {group.total > group.items.length && <div className="gs-more">+{group.total - group.items.length} meer</div>}
                </div>;
              })}
            </div>}
      </div>
    </>}
  </div>;
}
