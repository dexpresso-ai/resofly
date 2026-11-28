// ============================================================
// De boom van het dossier, links naast de pagina (§4 "het pagina-scherm",
// docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md).
//
// Alle pagina's van het dossier (de klant of het eigen dossier, met de
// pagina's in zijn projecten), per plek gegroepeerd zoals in de drive. Een
// klik opent die pagina via de editor (PageEditor.close), zodat de huidige
// eerst is opgeslagen en de terugknop terug kan.
//
// Op een breed scherm een kolom die je kunt verbergen; op een smal scherm een
// lade, die de knop "Pagina's" in de balk opent.
// ============================================================

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, X } from 'lucide-react';
import { listDossierPages, type DossierPages } from '../lib/repository';
import { ancestorIds, buildPageTree, type TreeNode } from '../lib/pageTree';

type Entry = { data: DossierPages; expanded: Set<string>; scrollTop: number };

/** Smaller dan dit wordt de boom een lade: naast een kolom van 260px moet de pagina (760px) nog passen. */
const DRAWER_QUERY = '(max-width: 1099px)';
const PREFERENCE_KEY = 'resofly.paginaboom';

/** Of de boom een lade is (smal scherm). Volgt het scherm als het draait of smaller wordt. */
export function useTreeDrawer(): boolean {
  const [drawer, setDrawer] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(DRAWER_QUERY).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(DRAWER_QUERY);
    const update = () => setDrawer(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return drawer;
}

/** Op een breed scherm onthouden we of je de boom verborg; standaard staat hij er. */
export function treePreference(): boolean {
  try { return window.localStorage.getItem(PREFERENCE_KEY) !== 'dicht'; } catch { return true; }
}

export function saveTreePreference(open: boolean): void {
  try { window.localStorage.setItem(PREFERENCE_KEY, open ? 'open' : 'dicht'); } catch { /* privémodus: dan onthouden we het niet */ }
}

/**
 * Buiten de editor bewaard. main.tsx geeft de editor per pagina een eigen key,
 * dus elke klik in de boom maakt een nieuwe editor. Zonder deze opslag zou de
 * boom dan elke keer leeg beginnen: laden, bovenaan, en alles weer dicht.
 * Per dossier (organisatie en klant), en per pagina in welk dossier ze staat.
 */
const entries = new Map<string, Entry>();
const entryOfPage = new Map<string, string>();

function entryKey(organizationId: string, data: DossierPages): string {
  return `${organizationId}:${data.client ?? 'eigen'}`;
}

export function PageTree({ organizationId, pageId, place, currentTitle, ownDossierName, version, drawer, onOpen, onClose }: {
  organizationId: string;
  pageId: string;
  /** Waar de pagina staat; null zolang ze nog laadt. */
  place: { client_id: string | null; project_id: string | null } | null;
  /** De titel zoals hij nu in de editor staat, ook als hij nog niet is opgeslagen. */
  currentTitle: string;
  ownDossierName: string;
  /** Telt op als de editor een subpagina maakt: dan opnieuw ophalen. */
  version: number;
  /** Op een smal scherm: een lade over de pagina. */
  drawer: boolean;
  onOpen: (pageId: string) => void;
  onClose: () => void;
}) {
  const [entry, setEntry] = useState<Entry | null>(() => {
    const key = entryOfPage.get(`${organizationId}:${pageId}`);
    return key ? entries.get(key) ?? null : null;
  });
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const entryRef = useRef(entry);
  entryRef.current = entry;

  useEffect(() => {
    if (!place) return;
    let alive = true;
    listDossierPages(organizationId, place).then(data => {
      if (!alive) return;
      const key = entryKey(organizationId, data);
      const known = entries.get(key);
      // Wat je zelf open- of dichtklapte, blijft zo. De weg naar de open
      // pagina gaat altijd open, en de pagina zelf ook: zo zie je haar subpagina's.
      const expanded = new Set(known?.expanded ?? []);
      for (const id of [pageId, ...ancestorIds(data.pages, pageId)]) expanded.add(id);
      const next: Entry = { data, expanded, scrollTop: known?.scrollTop ?? entryRef.current?.scrollTop ?? 0 };
      entries.set(key, next);
      for (const page of data.pages) entryOfPage.set(`${organizationId}:${page.id}`, key);
      setEntry(next);
      setError(null);
    }, () => {
      if (alive) setError('De pagina\'s van dit dossier konden niet worden geladen.');
    });
    return () => { alive = false; };
  }, [organizationId, pageId, place, version]);

  const groups = useMemo(() => (entry ? buildPageTree(entry.data.pages, entry.data) : []), [entry]);

  // Terug waar je was, en de open pagina in beeld.
  const restored = useRef(false);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!entry || !scroller || restored.current) return;
    restored.current = true;
    scroller.scrollTop = entry.scrollTop;
    scroller.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
  }, [entry]);

  // In de lade: de open pagina krijgt één keer de focus, zodat je met het
  // toetsenbord verder kunt. Niet bij elke wijziging: dan zou de focus na het
  // openklappen van een tak terugspringen.
  const focused = useRef(false);
  useEffect(() => {
    if (!drawer || !entry || focused.current) return;
    const target = scrollRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!target) return;
    focused.current = true;
    target.focus({ preventScroll: true });
  }, [drawer, entry]);

  const toggle = useCallback((id: string) => {
    setEntry(current => {
      if (!current) return current;
      const expanded = new Set(current.expanded);
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      const next = { ...current, expanded };
      entries.set(entryKey(organizationId, current.data), next);
      return next;
    });
  }, [organizationId]);

  const name = !entry ? '' : entry.data.client ? entry.data.clientName?.trim() || 'Klant' : ownDossierName;

  const row = (node: TreeNode, depth: number): JSX.Element => {
    const id = node.page.id;
    const current = id === pageId;
    const title = (current ? currentTitle : node.page.title).trim() || 'Naamloze pagina';
    const open = node.children.length > 0 && Boolean(entry?.expanded.has(id));
    return <li key={id}>
      <div className={`page-tree-row${current ? ' is-current' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}>
        {node.children.length > 0
          ? <button
            type="button"
            className={`page-tree-toggle${open ? ' is-open' : ''}`}
            aria-expanded={open}
            aria-label={`${open ? 'Subpagina\'s verbergen' : 'Subpagina\'s tonen'}: ${title}`}
            onClick={() => toggle(id)}
          ><ChevronRight size={14} /></button>
          : <span className="page-tree-toggle is-empty" aria-hidden="true" />}
        <button
          type="button"
          className="page-tree-page"
          aria-current={current ? 'page' : undefined}
          title={title}
          onClick={() => { if (!current) onOpen(id); }}
        ><FileText size={14} aria-hidden="true" /><span>{title}</span></button>
      </div>
      {open && <ul className="page-tree-list">{node.children.map(child => row(child, depth + 1))}</ul>}
    </li>;
  };

  return (
    <nav
      id="page-tree"
      className={`page-tree${drawer ? ' is-drawer' : ''}`}
      aria-label="Pagina's in dit dossier"
      onKeyDown={event => { if (drawer && event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
    >
      <div className="page-tree-head">
        <span className="page-tree-name" title={name}>{name || 'Dossier'}</span>
        <button type="button" className="page-tree-close" onClick={onClose} aria-label={drawer ? 'Pagina\'s sluiten' : 'Boom verbergen'} title={drawer ? 'Sluiten' : 'Verbergen'}>
          <X size={16} />
        </button>
      </div>
      <div
        className="page-tree-scroll"
        ref={scrollRef}
        onScroll={event => {
          const current = entryRef.current;
          if (current) current.scrollTop = event.currentTarget.scrollTop;
        }}
      >
        {!entry && !error && <p className="page-tree-note">Laden…</p>}
        {error && <p className="page-tree-note">{error}</p>}
        {groups.map(group => <div key={group.key} className="page-tree-group">
          {group.label && <div className="page-tree-label" title={group.label}>{group.label}</div>}
          <ul className="page-tree-list">{group.roots.map(node => row(node, 0))}</ul>
        </div>)}
        {entry && !entry.data.complete && <p className="page-tree-note">Niet elke pagina staat hier. Zoek in de drive voor de rest.</p>}
      </div>
    </nav>
  );
}
