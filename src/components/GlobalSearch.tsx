import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, ChevronRight, FileText, FolderOpen, Receipt, Search, SearchX, StickyNote, Ticket, Truck, Users, X, type LucideIcon } from 'lucide-react';
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

const kindMeta: Record<SearchResultKind, { label: string; badge: string; icon: LucideIcon }> = {
  client: { label: 'Klanten', badge: 'Klant', icon: Users },
  project: { label: 'Projecten', badge: 'Project', icon: FolderOpen },
  task: { label: 'Taken', badge: 'Taak', icon: CheckSquare },
  ticket: { label: 'Tickets', badge: 'Ticket', icon: Ticket },
  note: { label: 'Notities', badge: 'Notitie', icon: StickyNote },
  document: { label: 'Documenten', badge: 'Document', icon: FileText },
  quote: { label: 'Offertes', badge: 'Offerte', icon: FileText },
  invoice: { label: 'Facturen', badge: 'Factuur', icon: Receipt },
  supplier: { label: 'Leveranciers', badge: 'Leverancier', icon: Truck },
};

// Volgorde waarin de groepen/filters in het paneel verschijnen.
const kindOrder: SearchResultKind[] = ['client', 'project', 'task', 'ticket', 'note', 'document', 'quote', 'invoice', 'supplier'];

type Filter = 'all' | SearchResultKind;

/** Verwijdert simpele HTML-tags uit rich-text-velden zodat de zoek-preview leesbaar blijft. */
function plain(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some(field => field != null && field.toLowerCase().includes(query));
}

/** Markeert het overeenkomende deel van de tekst. */
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
  const [filter, setFilter] = useState<Filter>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const countByKind = useMemo(() => {
    const counts = {} as Record<SearchResultKind, number>;
    for (const kind of kindOrder) counts[kind] = 0;
    for (const r of results) counts[r.kind] += 1;
    return counts;
  }, [results]);

  // Filters waarvoor daadwerkelijk hits bestaan, in vaste volgorde.
  const availableFilters = useMemo(() => kindOrder.filter(kind => countByKind[kind] > 0), [countByKind]);

  // Zichtbare resultaten respecteren het actieve filter; bij "alles" tonen we alles.
  const visible = useMemo(
    () => (filter === 'all' ? results : results.filter(r => r.kind === filter)),
    [results, filter],
  );

  // Bij "alles" groeperen we per type; bij een gekozen filter tonen we één platte lijst.
  const groups = useMemo(() => {
    if (filter !== 'all') return [{ kind: filter as SearchResultKind, items: visible }];
    return kindOrder
      .map(kind => ({ kind, items: results.filter(r => r.kind === kind) }))
      .filter(group => group.items.length > 0);
  }, [filter, results, visible]);

  // Reset de selectie/filter als de zoekterm verandert.
  useEffect(() => { setActiveIndex(0); }, [term, filter]);

  // Valt het actieve filter weg (geen hits meer voor dat type), terug naar "alles".
  useEffect(() => {
    if (filter !== 'all' && countByKind[filter] === 0) setFilter('all');
  }, [filter, countByKind]);

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

  // Houd het actieve item in beeld bij toetsenbordnavigatie.
  useEffect(() => {
    listRef.current?.querySelector('.gs-result.active')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function close() {
    setOpen(false);
    setQuery('');
    setFilter('all');
    inputRef.current?.blur();
  }

  function choose(result: SearchResult) {
    onNavigate(result);
    close();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { close(); return; }
    if (visible.length === 0) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(i => (i + 1) % visible.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(i => (i - 1 + visible.length) % visible.length); }
    else if (event.key === 'Enter') { event.preventDefault(); const pick = visible[activeIndex] ?? visible[0]; if (pick) choose(pick); }
  }

  const trimmed = query.trim();
  const showPanel = open && trimmed.length >= 1;
  const tooShort = trimmed.length > 0 && trimmed.length < 2;

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
      <div className="gs-panel" role="dialog" aria-label="Zoekresultaten">
        <div className="gs-panel-head">
          <div className="gs-panel-titles">
            <div className="gs-panel-title">Zoekresultaten</div>
            <div className="gs-panel-sub">
              {tooShort
                ? 'Typ minimaal 2 tekens…'
                : `${results.length} ${results.length === 1 ? 'resultaat' : 'resultaten'} voor “${trimmed}”`}
            </div>
          </div>
          <button type="button" className="gs-panel-close" onClick={close} aria-label="Sluiten"><X size={18} /></button>
        </div>

        {!tooShort && results.length > 0 && <div className="gs-filters">
          <button type="button" className={`gs-chip${filter === 'all' ? ' active' : ''}`} onClick={() => setFilter('all')}>
            Alles<span className="gs-chip-count">{results.length}</span>
          </button>
          {availableFilters.map(kind => {
            const Meta = kindMeta[kind];
            return <button type="button" key={kind} className={`gs-chip${filter === kind ? ' active' : ''}`} onClick={() => setFilter(kind)}>
              <Meta.icon size={13} />{Meta.label}<span className="gs-chip-count">{countByKind[kind]}</span>
            </button>;
          })}
        </div>}

        <div className="gs-body" ref={listRef}>
          {tooShort
            ? <div className="gs-state"><Search size={30} /><div className="gs-state-title">Blijf typen</div><div className="gs-state-text">Voer minimaal 2 tekens in om te zoeken in je werkruimte.</div></div>
            : results.length === 0
              ? <div className="gs-state"><SearchX size={30} /><div className="gs-state-title">Geen resultaten</div><div className="gs-state-text">Niets gevonden voor “{trimmed}”. Probeer een andere zoekterm of controleer de spelling.</div></div>
              : <div className="gs-groups">
                  {groups.map(group => {
                    const Meta = kindMeta[group.kind];
                    return <div className="gs-group" key={group.kind}>
                      {filter === 'all' && <div className="gs-group-head"><Meta.icon size={13} /><span>{Meta.label}</span><span className="gs-group-count">{group.items.length}</span></div>}
                      {group.items.map(result => {
                        const flatIndex = visible.indexOf(result);
                        return <button
                          type="button"
                          key={`${result.kind}-${result.id}`}
                          className={`gs-result${flatIndex === activeIndex ? ' active' : ''}`}
                          onClick={() => choose(result)}
                          onMouseEnter={() => setActiveIndex(flatIndex)}
                        >
                          <span className="gs-result-icon"><Meta.icon size={16} aria-hidden="true" /></span>
                          <span className="gs-result-text">
                            <span className="gs-result-title"><Highlight text={result.title} query={term} /></span>
                            {result.subtitle && <span className="gs-result-sub"><Highlight text={result.subtitle} query={term} /></span>}
                          </span>
                          <span className="gs-result-badge">{Meta.badge}</span>
                          <ChevronRight size={15} className="gs-result-chevron" aria-hidden="true" />
                        </button>;
                      })}
                    </div>;
                  })}
                </div>}
        </div>
      </div>
    </>}
  </div>;
}
