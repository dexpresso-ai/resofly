import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Eye, EyeOff, FileText, Folder, FolderOpen, LayoutGrid, List, Search, StickyNote, X } from 'lucide-react';
import type { AppData, InternalDocument, Note, Project } from '../types';
import { Button } from '../components/Ui';
import { RichTextExcerpt } from '../components/RichTextEditor';
import { dateNL } from '../lib/format';

export type ContentView = 'all' | 'notes' | 'documents';

/** Waar een nieuw item terechtkomt: klant en/of project worden vooringevuld in de editor. */
export type ContentCreateTarget = { client_id?: string | null; project_id?: string | null };

/** Sentinel voor de "Geen klant"-map (inhoud zonder gekoppelde klant). */
const NO_CLIENT = '__no_client__';

/** Gedeelde grid/lijst-voorkeur met de klantdossier-drive, zodat de weergave consistent is. */
const VIEW_KEY = 'resofly:driveView';
function readView(): 'grid' | 'list' {
  try { return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}

type ContentItem = {
  kind: 'note' | 'document';
  id: string;
  title: string;
  content: string;
  created_at: string;
  clientId: string | null;   // effectieve klant (afgeleid uit klant- én projectkoppeling)
  projectId: string | null;  // effectief project
  note?: Note;
  doc?: InternalDocument;
};

function itemColor(kind: 'note' | 'document'): string {
  return kind === 'note' ? 'var(--accent-v)' : 'var(--accent-g)';
}
function ItemGlyph({ kind, size }: { kind: 'note' | 'document'; size: number }) {
  return kind === 'note' ? <StickyNote size={size} /> : <FileText size={size} />;
}

/**
 * "Inhoud" als cloud-drive: elke klant is een hoofdmap, elk gekoppeld project een
 * submap binnen die klant, met daaronder de notities en documenten. De structuur
 * wordt rechtstreeks afgeleid uit de bestaande klant-/projectkoppeling op notes en
 * documents — geen extra opslag nodig. Padbalk, grid/lijst-schakelaar en kaarten zijn
 * dezelfde `.drive-*`-taal als de klantdossier-drive (`ClientFolders`). Nieuwe items
 * worden in de huidige map aangemaakt (klant/project vooringevuld). De type-schakelaar
 * Notities/Documenten blijft beschikbaar; de sidebar-ingangen Overzicht/Notities/
 * Documenten deeplinken via `initialView` (main.tsx hermount per pagina met `key`).
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

  useEffect(() => { try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);

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
      out.push({ kind: 'note', id: n.id, title: n.title, content: n.content, created_at: n.created_at, clientId: p.clientId, projectId: p.projectId, note: n });
    }
    if (showDocuments) for (const d of data.documents) {
      const p = place(d.client_id, d.project_id);
      out.push({ kind: 'document', id: d.id, title: d.title, content: d.content, created_at: d.created_at, clientId: p.clientId, projectId: p.projectId, doc: d });
    }
    return out.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [data.notes, data.documents, showNotes, showDocuments, projectsById]);

  const countByClient = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) { const k = it.clientId ?? NO_CLIENT; m.set(k, (m.get(k) ?? 0) + 1); }
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
      .map(p => ({ id: p.id, name: p.name, color: p.color, archived: p.archived, count: clientItems.filter(it => it.projectId === p.id).length }))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
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

  const filteredClientFolders = clientFolders.filter(f => hit(f.name));
  const filteredProjectFolders = projectFolders.filter(f => hit(f.name));
  const filteredGeneral = generalItems.filter(it => hit(it.title));
  const filteredProjectItems = projectItems.filter(it => hit(it.title));

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  type FolderCardData = { id: string; name: string; color?: string; meta: string; onOpen: () => void };

  const renderFolders = (list: FolderCardData[]) => view === 'grid'
    ? <div className="drive-grid">{list.map(f => <div className="drive-card is-folder" key={f.id}>
        <button type="button" className="drive-card-main" onClick={f.onOpen}>
          <span className="drive-ic" style={{ color: f.color || 'var(--accent)' }}><Folder size={22} /></span>
          <span className="drive-card-text"><span className="drive-card-name" title={f.name}>{f.name}</span><span className="drive-card-meta">{f.meta}</span></span>
        </button>
      </div>)}</div>
    : <div className="drive-list">{list.map(f => <div className="drive-row" key={f.id}>
        <button type="button" className="drive-row-main" onClick={f.onOpen}>
          <span className="drive-ic" style={{ color: f.color || 'var(--accent)' }}><Folder size={20} /></span>
          <span className="drive-row-text"><span className="drive-row-name" title={f.name}>{f.name}</span><span className="drive-row-sub">{f.meta}</span></span>
        </button>
      </div>)}</div>;

  const openItem = (it: ContentItem) => it.kind === 'note' ? onEditNote(it.note!) : onEditDocument(it.doc!);

  const renderItems = (list: ContentItem[], emptyText: string) => {
    if (list.length === 0) return <div className="client-empty-line">{emptyText}</div>;
    if (view === 'grid') return <div className="drive-grid">{list.map(it => <div className="drive-card" key={`${it.kind}-${it.id}`}>
      <button type="button" className="drive-card-main" onClick={() => openItem(it)}>
        <span className="drive-ic" style={{ color: itemColor(it.kind) }}><ItemGlyph kind={it.kind} size={24} /></span>
        <span className="drive-card-text">
          <span className="drive-card-name" title={it.title}>{it.title || 'Naamloos'}</span>
          <span className="drive-card-meta"><em style={{ color: itemColor(it.kind), fontStyle: 'normal' }}>{it.kind === 'note' ? 'Notitie' : 'Document'}</em> · {dateNL(it.created_at)}</span>
        </span>
      </button>
    </div>)}</div>;
    return <div className="drive-list">{list.map(it => <div className="drive-row" key={`${it.kind}-${it.id}`}>
      <button type="button" className="drive-row-main" onClick={() => openItem(it)}>
        <span className="drive-ic" style={{ color: itemColor(it.kind) }}><ItemGlyph kind={it.kind} size={20} /></span>
        <span className="drive-row-text">
          <span className="drive-row-name" title={it.title}>{it.title || 'Naamloos'}</span>
          <span className="drive-row-sub"><RichTextExcerpt content={it.content} emptyText="Geen inhoud" /></span>
        </span>
      </button>
      <span className="drive-row-meta">{dateNL(it.created_at)}</span>
    </div>)}</div>;
  };

  const clientFolderData: FolderCardData[] = filteredClientFolders.map(f => ({
    id: f.id, name: f.name, color: f.color,
    meta: plural(f.count, 'item', 'items') + (f.projects ? ` · ${plural(f.projects, 'project', 'projecten')}` : ''),
    onOpen: () => openClient(f.id),
  }));
  const projectFolderData: FolderCardData[] = filteredProjectFolders.map(f => ({
    id: f.id, name: f.name + (f.archived ? ' · gearchiveerd' : ''), color: f.color,
    meta: plural(f.count, 'item', 'items'),
    onOpen: () => openProject(f.id),
  }));

  const headTitle = atRoot ? 'Inhoud' : currentProject ? currentProject.name : currentClientName;
  const headDesc = atRoot
    ? 'Elke klant is een map. Open een klant om zijn projecten en losse inhoud te zien en gericht aan te maken.'
    : currentProject
      ? `Notities en documenten binnen project ${currentProject.name}.`
      : clientId === NO_CLIENT
        ? 'Notities en documenten zonder gekoppelde klant.'
        : `Projecten en losse inhoud van ${currentClientName}. Nieuwe items komen automatisch bij deze klant.`;

  return <div className="notes-layout enriched">
    <aside className="notes-sidebar">
      <div className="notes-sidebar-head"><span>Inhoud</span></div>
      <div className="notes-summary">
        <strong>{noteCount + documentCount}</strong>
        <span>notities &amp; documenten</span>
      </div>
      <div className="note-type-summary">
        <div className={`doc-filter-row content-toggle${showNotes ? ' active' : ''}`} role="switch" aria-checked={showNotes} onClick={() => setShowNotes(v => !v)}>
          <span>{showNotes ? <Eye size={13} /> : <EyeOff size={13} />}Notities</span><strong>{noteCount}</strong>
        </div>
        <div className={`doc-filter-row content-toggle${showDocuments ? ' active' : ''}`} role="switch" aria-checked={showDocuments} onClick={() => setShowDocuments(v => !v)}>
          <span>{showDocuments ? <Eye size={13} /> : <EyeOff size={13} />}Documenten</span><strong>{documentCount}</strong>
        </div>
      </div>
      <div className="notes-list content-nav">
        <button type="button" className={`content-nav-row${atRoot ? ' active' : ''}`} onClick={() => openClient(null)}>
          <Folder size={14} aria-hidden="true" /><span>Alle klanten</span><strong>{items.length}</strong>
        </button>
        {clientFolders.map(f => <button type="button" key={f.id} className={`content-nav-row${clientId === f.id ? ' active' : ''}`} onClick={() => openClient(f.id)}>
          <FolderOpen size={14} color={f.color} aria-hidden="true" /><span>{f.name}</span><strong>{f.count}</strong>
        </button>)}
      </div>
    </aside>

    <main className="notes-main">
      <div className="drive">
        <div className="notes-main-head">
          <div>
            <h2>{headTitle}</h2>
            <p>{headDesc}</p>
          </div>
          <div className="content-actions">
            <Button onClick={() => onNewNote(createTarget)}>+ Notitie</Button>
            <Button variant="primary" onClick={() => onNewDocument(createTarget)}>+ Document</Button>
          </div>
        </div>

        <div className="drive-bar">
          <div className="drive-crumbs">
            <button type="button" className={atRoot ? 'active' : ''} onClick={() => openClient(null)}>
              <FolderOpen size={15} aria-hidden="true" /> Alle klanten
            </button>
            {clientId !== null && <span className="drive-crumb">
              <ChevronRight size={14} aria-hidden="true" />
              <button type="button" className={projectId === null ? 'active' : ''} onClick={() => openProject(null)}>{currentClientName}</button>
            </span>}
            {currentProject && <span className="drive-crumb">
              <ChevronRight size={14} aria-hidden="true" />
              <button type="button" className="active">{currentProject.name}</button>
            </span>}
          </div>
          <div className="drive-bar-right">
            <label className="drive-search">
              <Search size={14} aria-hidden="true" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder={atRoot ? 'Zoek klant…' : 'Zoek in deze map…'} autoComplete="off" aria-label="Zoeken in inhoud" />
              {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
            </label>
            <div className="drive-view" role="group" aria-label="Weergave">
              <button type="button" className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="Rasterweergave" aria-pressed={view === 'grid'}><LayoutGrid size={16} /></button>
              <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="Lijstweergave" aria-pressed={view === 'list'}><List size={16} /></button>
            </div>
          </div>
        </div>

        {noneSelected
          ? <div className="drive-empty">
              <span className="drive-empty-ic"><EyeOff size={24} /></span>
              <strong>Geen filter actief</strong>
              <span>Zet links Notities of Documenten aan om je inhoud te tonen.</span>
            </div>
          : atRoot
            ? <section className="drive-group">
                <div className="drive-group-head"><span>Klanten</span><span className="drive-group-count">{clientFolderData.length}</span></div>
                {clientFolderData.length === 0
                  ? <div className="client-empty-line">{q ? 'Geen klanten gevonden.' : 'Nog geen klanten. Maak eerst een klant aan in Klanten.'}</div>
                  : renderFolders(clientFolderData)}
              </section>
            : projectId === null
              ? <>
                  <section className="drive-group">
                    <div className="drive-group-head"><span>Projecten</span><span className="drive-group-count">{projectFolderData.length}</span></div>
                    {projectFolderData.length === 0
                      ? <div className="client-empty-line">{q ? 'Geen projecten gevonden.' : clientId === NO_CLIENT ? 'Geen projecten.' : 'Deze klant heeft nog geen projecten.'}</div>
                      : renderFolders(projectFolderData)}
                  </section>
                  <section className="drive-group">
                    <div className="drive-group-head"><span>Losse inhoud</span><span className="drive-group-count">{filteredGeneral.length}</span></div>
                    {renderItems(filteredGeneral, q ? 'Geen inhoud gevonden.' : 'Nog geen losse notities of documenten bij deze klant. Maak er een aan met de knoppen rechtsboven.')}
                  </section>
                </>
              : <section className="drive-group">
                  <div className="drive-group-head"><span>Notities &amp; documenten</span><span className="drive-group-count">{filteredProjectItems.length}</span></div>
                  {renderItems(filteredProjectItems, q ? 'Geen inhoud gevonden.' : 'Dit project bevat nog geen notities of documenten. Maak er een aan met de knoppen rechtsboven.')}
                </section>}
      </div>
    </main>
  </div>;
}
