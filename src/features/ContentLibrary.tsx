import { useMemo, useState } from 'react';
import { ChevronRight, Eye, EyeOff, Folder, FolderOpen, Search } from 'lucide-react';
import type { AppData, InternalDocument, Note, Project } from '../types';
import { Button } from '../components/Ui';
import { NoteCard } from './Notes';
import { DocumentCard } from './Documents';

export type ContentView = 'all' | 'notes' | 'documents';

/** Waar een nieuw item terechtkomt: klant en/of project worden vooringevuld in de editor. */
export type ContentCreateTarget = { client_id?: string | null; project_id?: string | null };

/** Sentinel voor de "Geen klant"-map (inhoud zonder gekoppelde klant). */
const NO_CLIENT = '__no_client__';

type ContentItem = {
  kind: 'note' | 'document';
  id: string;
  title: string;
  created_at: string;
  clientId: string | null;   // effectieve klant (afgeleid uit klant- én projectkoppeling)
  projectId: string | null;  // effectief project
  note?: Note;
  doc?: InternalDocument;
};

/**
 * "Inhoud" als mappenboom: elke klant is een hoofdmap, elk gekoppeld project een
 * submap binnen die klant, met daaronder de notities en documenten. De structuur
 * wordt rechtstreeks afgeleid uit de bestaande klant-/projectkoppeling op notes en
 * documents — geen extra opslag nodig. Nieuwe items worden in de huidige map
 * aangemaakt (klant/project vooringevuld). De type-schakelaar Notities/Documenten
 * blijft beschikbaar; de sidebar-ingangen Overzicht/Notities/Documenten deeplinken
 * via `initialView` (main.tsx hermount per pagina met `key`).
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
      out.push({ kind: 'note', id: n.id, title: n.title, created_at: n.created_at, clientId: p.clientId, projectId: p.projectId, note: n });
    }
    if (showDocuments) for (const d of data.documents) {
      const p = place(d.client_id, d.project_id);
      out.push({ kind: 'document', id: d.id, title: d.title, created_at: d.created_at, clientId: p.clientId, projectId: p.projectId, doc: d });
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

  const renderItems = (list: ContentItem[], emptyText: string) =>
    list.length === 0
      ? <div className="client-empty-line">{emptyText}</div>
      : <div className="notes-card-grid">
          {list.map(it => it.kind === 'note'
            ? <NoteCard key={`n-${it.id}`} note={it.note!} data={data} onEdit={onEditNote} />
            : <DocumentCard key={`d-${it.id}`} doc={it.doc!} data={data} onEdit={onEditDocument} />)}
        </div>;

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
      <div className="content-search">
        <Search size={13} aria-hidden="true" />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={atRoot ? 'Zoek klant…' : 'Zoek in deze map…'} aria-label="Zoeken in inhoud" />
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
      <div className="folders-view">
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

        <div className="folders-crumbs">
          <button type="button" className={atRoot ? 'active' : ''} onClick={() => openClient(null)}>Alle klanten</button>
          {clientId !== null && <span className="folders-crumb">
            <ChevronRight size={13} aria-hidden="true" />
            <button type="button" className={projectId === null ? 'active' : ''} onClick={() => openProject(null)}>{currentClientName}</button>
          </span>}
          {currentProject && <span className="folders-crumb">
            <ChevronRight size={13} aria-hidden="true" />
            <button type="button" className="active">{currentProject.name}</button>
          </span>}
        </div>

        {noneSelected
          ? <div className="note-empty"><div className="ne-big">Geen filter actief</div><p>Zet links Notities of Documenten aan om je inhoud te tonen.</p></div>
          : atRoot
            ? <section className="folder-section">
                <div className="folder-section-head"><span>Klanten</span><span className="folder-section-count">{filteredClientFolders.length}</span></div>
                {filteredClientFolders.length === 0
                  ? <div className="client-empty-line">{q ? 'Geen klanten gevonden.' : 'Nog geen klanten. Maak eerst een klant aan in Klanten.'}</div>
                  : <div className="folder-grid">
                      {filteredClientFolders.map(f => <div className="folder-card" key={f.id}>
                        <button type="button" className="folder-card-open" onClick={() => openClient(f.id)}>
                          <FolderOpen size={18} color={f.color} aria-hidden="true" />
                          <span className="folder-card-name">{f.name}</span>
                          <span className="folder-card-meta">{plural(f.count, 'item', 'items')}{f.projects ? ` · ${plural(f.projects, 'project', 'projecten')}` : ''}</span>
                        </button>
                      </div>)}
                    </div>}
              </section>
            : projectId === null
              ? <>
                  <section className="folder-section">
                    <div className="folder-section-head"><span>Projecten</span><span className="folder-section-count">{filteredProjectFolders.length}</span></div>
                    {filteredProjectFolders.length === 0
                      ? <div className="client-empty-line">{q ? 'Geen projecten gevonden.' : clientId === NO_CLIENT ? 'Geen projecten.' : 'Deze klant heeft nog geen projecten.'}</div>
                      : <div className="folder-grid">
                          {filteredProjectFolders.map(f => <div className="folder-card" key={f.id}>
                            <button type="button" className="folder-card-open" onClick={() => openProject(f.id)}>
                              <FolderOpen size={18} color={f.color} aria-hidden="true" />
                              <span className="folder-card-name">{f.name}{f.archived ? ' · gearchiveerd' : ''}</span>
                              <span className="folder-card-meta">{plural(f.count, 'item', 'items')}</span>
                            </button>
                          </div>)}
                        </div>}
                  </section>
                  <section className="folder-section">
                    <div className="folder-section-head"><span>Losse inhoud</span><span className="folder-section-count">{filteredGeneral.length}</span></div>
                    {renderItems(filteredGeneral, q ? 'Geen inhoud gevonden.' : 'Nog geen losse notities of documenten bij deze klant. Maak er een aan met de knoppen rechtsboven.')}
                  </section>
                </>
              : <section className="folder-section">
                  <div className="folder-section-head"><span>Notities &amp; documenten</span><span className="folder-section-count">{filteredProjectItems.length}</span></div>
                  {renderItems(filteredProjectItems, q ? 'Geen inhoud gevonden.' : 'Dit project bevat nog geen notities of documenten. Maak er een aan met de knoppen rechtsboven.')}
                </section>}
      </div>
    </main>
  </div>;
}
