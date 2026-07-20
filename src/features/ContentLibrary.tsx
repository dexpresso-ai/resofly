import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Eye, EyeOff, File, FileText,
  Folder, FolderOpen, Home, Info, LayoutGrid, List, Plus, Search, StickyNote, X,
} from 'lucide-react';
import type { AppData, InternalDocument, Note, Project } from '../types';
import { dateNL } from '../lib/format';

export type ContentView = 'all' | 'notes' | 'documents';

/** Waar een nieuw item terechtkomt: klant en/of project worden vooringevuld in de editor. */
export type ContentCreateTarget = { client_id?: string | null; project_id?: string | null };

/** Sentinel voor de "Geen klant"-map (inhoud zonder gekoppelde klant). */
const NO_CLIENT = '__no_client__';

/** Gedeelde grid/lijst-voorkeur met de klantdossier-drive; hier is lijst (OneDrive-details) de standaard. */
const VIEW_KEY = 'resofly:driveView';
function readView(): 'grid' | 'list' {
  try { return window.localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
}
const DETAILS_KEY = 'resofly:contentDetails';
function readDetails(): boolean {
  try { return window.localStorage.getItem(DETAILS_KEY) === '1'; } catch { return false; }
}

type ContentItem = {
  kind: 'note' | 'document';
  id: string;
  title: string;
  content: string;
  modified: string;
  clientId: string | null;   // effectieve klant (afgeleid uit klant- én projectkoppeling)
  projectId: string | null;  // effectief project
  note?: Note;
  doc?: InternalDocument;
};

function itemColor(kind: 'note' | 'document'): string {
  return kind === 'note' ? 'var(--accent-v)' : 'var(--accent-g)';
}

type SortKey = 'name' | 'modified' | 'type';

/** Eén rij in de verkenner: klantmap, projectmap of los item, met de kolomwaarden erbij. */
type Row = {
  key: string;
  kind: 'client' | 'project' | 'note' | 'document';
  name: string;
  color?: string | null;
  archived?: boolean;
  modified: string | null;
  size: string;
  typeLabel: string;
  onOpen: () => void;
};
const isFolderRow = (r: Row) => r.kind === 'client' || r.kind === 'project';

function RowGlyph({ row, size }: { row: Row; size: number }) {
  if (isFolderRow(row)) return <Folder size={size} fill="currentColor" strokeWidth={1.4} />;
  return row.kind === 'note' ? <StickyNote size={size} /> : <FileText size={size} />;
}

/**
 * "Inhoud" als OneDrive-achtige verkenner: links een navigatiekolom met de "+ Nieuw"-knop
 * en alle klanten, in het midden één doorlopende lijst (mappen eerst) met de kolommen
 * Naam / Gewijzigd / Grootte / Type, sorteerbaar via de kolomkoppen of het Sorteren-menu,
 * plus een tegelweergave en een inklapbaar Details-paneel. De mappenstructuur blijft
 * rechtstreeks afgeleid uit de klant-/projectkoppeling op notes en documents — geen extra
 * opslag. Nieuwe items worden in de open map aangemaakt (klant/project vooringevuld); de
 * sidebar-ingangen Overzicht/Notities/Documenten deeplinken via `initialView`.
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
  onNewNote: (target?: ContentCreateTarget) => void;
  onEditNote: (n: Note) => void;
  onNewDocument: (target?: ContentCreateTarget) => void;
  onEditDocument: (d: InternalDocument) => void;
}) {
  const [showNotes, setShowNotes] = useState(initialView !== 'documents');
  const [showDocuments, setShowDocuments] = useState(initialView !== 'notes');
  const [clientId, setClientId] = useState<string | null>(null);   // null = wortel (alle klanten)
  const [projectId, setProjectId] = useState<string | null>(null); // null = klantwortel
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>(readView);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [detailsOpen, setDetailsOpen] = useState(readDetails);
  const [newOpen, setNewOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  useEffect(() => { try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);
  useEffect(() => { try { window.localStorage.setItem(DETAILS_KEY, detailsOpen ? '1' : '0'); } catch { /* ignore */ } }, [detailsOpen]);

  // Sluit de menu's ("+ Nieuw", Sorteren) bij een klik buitenom of Escape.
  useEffect(() => {
    if (!newOpen && !sortOpen) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.drive-pop, .drive-pop-trigger')) return;
      setNewOpen(false); setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setNewOpen(false); setSortOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [newOpen, sortOpen]);

  const projectsById = useMemo(() => new Map(data.projects.map(p => [p.id, p] as const)), [data.projects]);
  const clientsById = useMemo(() => new Map(data.clients.map(c => [c.id, c] as const)), [data.clients]);

  const noteCount = data.notes.length;
  const documentCount = data.documents.length;

  // Effectieve plaatsing: heeft een item een project, dan hoort het bij de klant van dat project.
  const items = useMemo<ContentItem[]>(() => {
    const place = (rawClient: string | null, rawProject: string | null) => {
      const proj = rawProject ? projectsById.get(rawProject) : undefined;
      if (proj) return { clientId: proj.client_id ?? null, projectId: proj.id };
      return { clientId: rawClient ?? null, projectId: null as string | null };
    };
    const out: ContentItem[] = [];
    if (showNotes) for (const n of data.notes) {
      const p = place(n.client_id, n.project_id);
      out.push({ kind: 'note', id: n.id, title: n.title, content: n.content, modified: n.updated_at || n.created_at, clientId: p.clientId, projectId: p.projectId, note: n });
    }
    if (showDocuments) for (const d of data.documents) {
      const p = place(d.client_id, d.project_id);
      out.push({ kind: 'document', id: d.id, title: d.title, content: d.content, modified: d.updated_at || d.created_at, clientId: p.clientId, projectId: p.projectId, doc: d });
    }
    return out;
  }, [data.notes, data.documents, showNotes, showDocuments, projectsById]);

  const countByClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) { const k = it.clientId ?? NO_CLIENT; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [items]);

  // "Gewijzigd" per map = het jongste item erin (ISO-strings vergelijken lexicografisch correct).
  const lastByClient = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) { const k = it.clientId ?? NO_CLIENT; if ((m.get(k) ?? '') < it.modified) m.set(k, it.modified); }
    return m;
  }, [items]);
  const lastByProject = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) { if (it.projectId && (m.get(it.projectId) ?? '') < it.modified) m.set(it.projectId, it.modified); }
    return m;
  }, [items]);

  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const noneSelected = !showNotes && !showDocuments;

  // ── Navigatiestatus ────────────────────────────────────────────────
  const atRoot = clientId === null;
  const currentClient = clientId && clientId !== NO_CLIENT ? clientsById.get(clientId) ?? null : null;
  const currentClientName = clientId === NO_CLIENT ? 'Geen klant' : currentClient?.name ?? '';
  const currentProject = projectId ? projectsById.get(projectId) ?? null : null;

  const clientItems = useMemo(
    () => clientId === null ? [] : items.filter(it => (it.clientId ?? NO_CLIENT) === clientId),
    [items, clientId],
  );

  // Projectmappen binnen de klant: alle niet-gearchiveerde projecten van de klant + projecten met inhoud.
  const projectFolders = useMemo(() => {
    if (clientId === null) return [];
    const referenced = new Set(clientItems.map(it => it.projectId).filter((x): x is string => Boolean(x)));
    const base = clientId === NO_CLIENT ? [] : data.projects.filter(p => p.client_id === clientId && (!p.archived || referenced.has(p.id)));
    const ids = new Set(base.map(p => p.id));
    const extra: Project[] = [];
    for (const id of referenced) if (!ids.has(id)) { const p = projectsById.get(id); if (p) extra.push(p); }
    return [...base, ...extra]
      .map(p => ({ id: p.id, name: p.name, color: p.color, archived: p.archived, count: clientItems.filter(it => it.projectId === p.id).length }));
  }, [clientId, clientItems, data.projects, projectsById]);

  const generalItems = useMemo(() => clientItems.filter(it => !it.projectId), [clientItems]);
  const projectItems = useMemo(() => projectId ? clientItems.filter(it => it.projectId === projectId) : [], [clientItems, projectId]);

  // Klantmappen op de wortel: elke klant (zodat je overal direct kunt aanmaken) + "Geen klant" als die inhoud heeft.
  const clientFolders = useMemo(() => {
    const list = data.clients.map(c => ({
      id: c.id,
      name: c.name,
      color: c.color,
      count: countByClient.get(c.id) ?? 0,
      projects: data.projects.filter(p => p.client_id === c.id && !p.archived).length,
    }));
    list.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
    const none = countByClient.get(NO_CLIENT) ?? 0;
    if (none > 0) list.push({ id: NO_CLIENT, name: 'Geen klant', color: '#94A3B8', count: none, projects: 0 });
    return list;
  }, [data.clients, data.projects, countByClient]);

  function openClient(id: string | null) { setClientId(id); setProjectId(null); setQuery(''); }
  function openProject(id: string | null) { setProjectId(id); setQuery(''); }

  // Create-context: nieuwe items belanden in de open map.
  const createTarget: ContentCreateTarget | undefined =
    projectId ? { client_id: currentClient?.id ?? null, project_id: projectId } :
    (clientId && clientId !== NO_CLIENT) ? { client_id: clientId } :
    undefined;

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  // ── Rijen voor de huidige map (mappen eerst, dan items; beide gesorteerd) ──
  const itemRow = (it: ContentItem): Row => ({
    key: `${it.kind}-${it.id}`,
    kind: it.kind,
    name: it.title || 'Naamloos',
    color: itemColor(it.kind),
    modified: it.modified,
    size: '',
    typeLabel: it.kind === 'note' ? 'Notitie' : 'Document',
    onOpen: () => it.kind === 'note' ? onEditNote(it.note!) : onEditDocument(it.doc!),
  });

  const rows = useMemo<Row[]>(() => {
    const folderRows: Row[] = [];
    const fileRows: Row[] = [];
    if (atRoot) {
      for (const f of clientFolders) folderRows.push({
        key: `c-${f.id}`, kind: 'client', name: f.name, color: f.color || 'var(--accent)',
        modified: lastByClient.get(f.id) ?? null, size: plural(f.count, 'item', 'items'), typeLabel: 'Klantmap',
        onOpen: () => openClient(f.id),
      });
    } else if (projectId === null) {
      for (const f of projectFolders) folderRows.push({
        key: `p-${f.id}`, kind: 'project', name: f.name, color: f.color || 'var(--accent)', archived: f.archived,
        modified: lastByProject.get(f.id) ?? null, size: plural(f.count, 'item', 'items'), typeLabel: 'Projectmap',
        onOpen: () => openProject(f.id),
      });
      for (const it of generalItems) fileRows.push(itemRow(it));
    } else {
      for (const it of projectItems) fileRows.push(itemRow(it));
    }
    const cmp = (a: Row, b: Row): number => {
      let r = 0;
      if (sortKey === 'name') r = a.name.localeCompare(b.name, 'nl', { numeric: true, sensitivity: 'base' });
      else if (sortKey === 'modified') r = (a.modified ?? '').localeCompare(b.modified ?? '');
      else r = a.typeLabel.localeCompare(b.typeLabel, 'nl') || a.name.localeCompare(b.name, 'nl', { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? r : -r;
    };
    const shown = (list: Row[]) => list.filter(r => hit(r.name)).sort(cmp);
    return [...shown(folderRows), ...shown(fileRows)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atRoot, projectId, clientFolders, projectFolders, generalItems, projectItems, lastByClient, lastByProject, sortKey, sortDir, q]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'modified' ? 'desc' : 'asc'); }
  }

  // ── Details-paneel: samenvatting van de open map ───────────────────
  const scopeItems = atRoot ? items : projectId ? projectItems : clientItems;
  const scopeNotes = scopeItems.filter(i => i.kind === 'note').length;
  const scopeDocs = scopeItems.filter(i => i.kind === 'document').length;
  const scopeModified = scopeItems.reduce<string | null>((acc, i) => !acc || acc < i.modified ? i.modified : acc, null);
  const scopeTitle = atRoot ? 'Inhoud' : currentProject ? currentProject.name : currentClientName;
  const scopeType = atRoot ? 'Alle klanten' : currentProject ? 'Projectmap' : 'Klantmap';
  const scopeColor = atRoot ? 'var(--accent)' : currentProject ? currentProject.color || 'var(--accent)' : currentClient?.color || (clientId === NO_CLIENT ? '#94A3B8' : 'var(--accent)');

  const companyName = data.companySettings?.company_name?.trim() || 'Inhoud';

  const SortCaret = ({ col }: { col: SortKey }) => sortKey === col
    ? (sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
    : <ChevronDown size={12} style={{ opacity: .45 }} />;

  const emptyState = () => {
    if (q) return <div className="drive-empty odrv-empty"><span className="drive-empty-ic"><Search size={24} /></span><strong>Geen resultaten</strong><span>Niets gevonden voor “{query.trim()}” in deze map.</span></div>;
    if (atRoot) return <div className="drive-empty odrv-empty"><span className="drive-empty-ic"><FolderOpen size={24} /></span><strong>Nog geen klanten</strong><span>Maak eerst een klant aan via de pagina Klanten; elke klant wordt hier automatisch een map.</span></div>;
    return <div className="drive-empty odrv-empty"><span className="drive-empty-ic"><FolderOpen size={24} /></span><strong>Deze map is leeg</strong><span>Gebruik de knop “+ Nieuw” links om hier een notitie of document aan te maken.</span></div>;
  };

  const renderList = () => <div className="odrv-table">
    <div className="odrv-tr odrv-thead">
      <span className="odrv-td-ic odrv-thead-ic"><File size={14} /></span>
      <button type="button" className={`odrv-th${sortKey === 'name' ? ' is-active' : ''}`} onClick={() => toggleSort('name')}>Naam <SortCaret col="name" /></button>
      <button type="button" className={`odrv-th odrv-td-mod${sortKey === 'modified' ? ' is-active' : ''}`} onClick={() => toggleSort('modified')}>Gewijzigd <SortCaret col="modified" /></button>
      <span className="odrv-th is-static odrv-td-size">Grootte</span>
      <button type="button" className={`odrv-th odrv-td-type${sortKey === 'type' ? ' is-active' : ''}`} onClick={() => toggleSort('type')}>Type <SortCaret col="type" /></button>
    </div>
    {rows.map(row => <button type="button" className="odrv-tr odrv-row" key={row.key} onClick={row.onOpen}>
      <span className="odrv-td-ic" style={{ color: row.color || 'var(--accent)' }}><RowGlyph row={row} size={20} /></span>
      <span className="odrv-td-name" title={row.name}>{row.name}{row.archived && <em className="odrv-arch">gearchiveerd</em>}</span>
      <span className="odrv-td-mod">{row.modified ? dateNL(row.modified) : '—'}</span>
      <span className="odrv-td-size">{row.size}</span>
      <span className="odrv-td-type">{row.typeLabel}</span>
    </button>)}
  </div>;

  const renderTiles = () => <div className="odrv-tiles">
    {rows.map(row => <button type="button" className="odrv-tile" key={row.key} onClick={row.onOpen}>
      <span className="odrv-tile-canvas" style={{ color: row.color || 'var(--accent)' }}><RowGlyph row={row} size={isFolderRow(row) ? 46 : 38} /></span>
      <span className="odrv-tile-foot">
        <span className="odrv-tile-name" title={row.name}>{row.name}</span>
        <span className="odrv-tile-meta">{isFolderRow(row) ? `${row.typeLabel} · ${row.size}` : `${row.typeLabel}${row.modified ? ` · ${dateNL(row.modified)}` : ''}`}</span>
      </span>
    </button>)}
  </div>;

  return <div className="odrv">
    <aside className="odrv-side">
      <div className="drive-new-wrap odrv-new-wrap">
        <button type="button" className="drive-new odrv-newbtn drive-pop-trigger" onClick={() => { setNewOpen(o => !o); setSortOpen(false); }} aria-haspopup="menu" aria-expanded={newOpen}>
          <Plus size={16} /> Nieuw <ChevronDown size={14} />
        </button>
        {newOpen && <div className="drive-pop" role="menu">
          {!atRoot && <div className="drive-pop-head">In {currentProject ? currentProject.name : currentClientName}</div>}
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewNote(createTarget); }}><StickyNote size={16} style={{ color: 'var(--accent-v)' }} /> Notitie</button>
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setNewOpen(false); onNewDocument(createTarget); }}><FileText size={16} style={{ color: 'var(--accent-g)' }} /> Document</button>
        </div>}
      </div>

      <div className="odrv-side-title">{companyName}</div>
      <nav className="odrv-nav">
        <button type="button" className={`odrv-nav-row${atRoot ? ' active' : ''}`} onClick={() => openClient(null)}>
          <Home size={16} aria-hidden="true" /><span>Alle klanten</span><strong>{items.length}</strong>
        </button>
      </nav>

      <div className="odrv-side-section">Bladeren op klant</div>
      <nav className="odrv-nav odrv-side-clients">
        {clientFolders.map(f => <button type="button" key={f.id} className={`odrv-nav-row${clientId === f.id ? ' active' : ''}`} onClick={() => openClient(f.id)}>
          <Folder size={16} fill="currentColor" strokeWidth={1.4} style={{ color: f.color || 'var(--accent)' }} aria-hidden="true" /><span>{f.name}</span><strong>{f.count}</strong>
        </button>)}
        {clientFolders.length === 0 && <div className="odrv-side-empty">Nog geen klanten.</div>}
      </nav>

      <div className="odrv-side-section">Weergeven</div>
      <nav className="odrv-nav">
        <button type="button" role="switch" aria-checked={showNotes} className={`odrv-nav-row odrv-toggle${showNotes ? '' : ' is-off'}`} onClick={() => setShowNotes(v => !v)}>
          {showNotes ? <Eye size={15} /> : <EyeOff size={15} />}<span>Notities</span><strong>{noteCount}</strong>
        </button>
        <button type="button" role="switch" aria-checked={showDocuments} className={`odrv-nav-row odrv-toggle${showDocuments ? '' : ' is-off'}`} onClick={() => setShowDocuments(v => !v)}>
          {showDocuments ? <Eye size={15} /> : <EyeOff size={15} />}<span>Documenten</span><strong>{documentCount}</strong>
        </button>
      </nav>
    </aside>

    <main className="odrv-main">
      <div className="odrv-head">
        <nav className="odrv-crumbs" aria-label="Locatie">
          {atRoot
            ? <span className="odrv-crumb-current">Inhoud</span>
            : <>
                <button type="button" onClick={() => openClient(null)}>Inhoud</button>
                <ChevronRight size={17} aria-hidden="true" />
                {projectId === null
                  ? <span className="odrv-crumb-current">{currentClientName}</span>
                  : <>
                      <button type="button" onClick={() => openProject(null)}>{currentClientName}</button>
                      <ChevronRight size={17} aria-hidden="true" />
                      <span className="odrv-crumb-current">{currentProject?.name ?? ''}</span>
                    </>}
              </>}
        </nav>
        <div className="odrv-headtools">
          <label className="drive-search odrv-search">
            <Search size={14} aria-hidden="true" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder={atRoot ? 'Zoek klant…' : 'Zoeken in deze map…'} autoComplete="off" aria-label="Zoeken in inhoud" />
            {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
          </label>
          <div className="drive-new-wrap">
            <button type="button" className="odrv-tool drive-pop-trigger" onClick={() => { setSortOpen(o => !o); setNewOpen(false); }} aria-haspopup="menu" aria-expanded={sortOpen}>
              <ArrowUpDown size={14} /> Sorteren <ChevronDown size={13} />
            </button>
            {sortOpen && <div className="drive-pop is-right" role="menu">
              {([['name', 'Naam'], ['modified', 'Gewijzigd'], ['type', 'Type']] as const).map(([k, label]) =>
                <button type="button" key={k} className="drive-pop-item" role="menuitemradio" aria-checked={sortKey === k} onClick={() => { if (sortKey !== k) { setSortKey(k); setSortDir(k === 'modified' ? 'desc' : 'asc'); } setSortOpen(false); }}>
                  {label}{sortKey === k && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
                </button>)}
              <div className="drive-pop-sep" />
              <button type="button" className="drive-pop-item" role="menuitemradio" aria-checked={sortDir === 'asc'} onClick={() => { setSortDir('asc'); setSortOpen(false); }}>
                Oplopend{sortDir === 'asc' && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
              </button>
              <button type="button" className="drive-pop-item" role="menuitemradio" aria-checked={sortDir === 'desc'} onClick={() => { setSortDir('desc'); setSortOpen(false); }}>
                Aflopend{sortDir === 'desc' && <Check size={14} style={{ marginLeft: 'auto', color: 'var(--accent)' }} />}
              </button>
            </div>}
          </div>
          <div className="drive-view" role="group" aria-label="Weergave">
            <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="Lijstweergave" aria-pressed={view === 'list'}><List size={16} /></button>
            <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Tegelweergave" aria-pressed={view === 'grid'}><LayoutGrid size={16} /></button>
          </div>
          <button type="button" className={`odrv-tool odrv-tool-details${detailsOpen ? ' is-active' : ''}`} onClick={() => setDetailsOpen(o => !o)} aria-pressed={detailsOpen}>
            <Info size={15} /> Details
          </button>
        </div>
      </div>

      {noneSelected
        ? <div className="odrv-scroll"><div className="drive-empty odrv-empty">
            <span className="drive-empty-ic"><EyeOff size={24} /></span>
            <strong>Geen filter actief</strong>
            <span>Zet links onder “Weergeven” Notities of Documenten aan om je inhoud te tonen.</span>
          </div></div>
        : <div className="odrv-body">
            <div className="odrv-scroll">
              {rows.length === 0 ? emptyState() : view === 'list' ? renderList() : renderTiles()}
            </div>
            {detailsOpen && <aside className="odrv-details">
              <div className="odrv-details-head">
                <span>Details</span>
                <button type="button" className="odrv-details-close" onClick={() => setDetailsOpen(false)} aria-label="Details sluiten"><X size={14} /></button>
              </div>
              <div className="odrv-details-hero" style={{ color: scopeColor }}>
                {atRoot ? <FolderOpen size={38} /> : <Folder size={38} fill="currentColor" strokeWidth={1.4} />}
              </div>
              <strong className="odrv-details-name">{scopeTitle}</strong>
              <span className="odrv-details-type">{scopeType}</span>
              <dl className="odrv-details-props">
                {atRoot && <div><dt>Klanten</dt><dd>{clientFolders.length}</dd></div>}
                {!atRoot && !currentProject && <div><dt>Projecten</dt><dd>{projectFolders.length}</dd></div>}
                {currentProject && <div><dt>Klant</dt><dd>{currentClientName || '—'}</dd></div>}
                <div><dt>Notities</dt><dd>{scopeNotes}</dd></div>
                <div><dt>Documenten</dt><dd>{scopeDocs}</dd></div>
                <div><dt>Gewijzigd</dt><dd>{scopeModified ? dateNL(scopeModified) : '—'}</dd></div>
              </dl>
            </aside>}
          </div>}
    </main>
  </div>;
}
