import type { AppData } from '../types';
import { PAGE_TITLES, viewTitle } from './workspaceTabs';

/**
 * Kruimelpad — het spoor terug naar boven, op elke pagina dezelfde vorm:
 *
 *   Dashboard  ›  Werk  ›  Projecten  ›  WOW – Implementatie
 *   └ klikbaar    └ kop    └ klikbaar    └ waar je nu bent
 *
 * De kopjes ("Werk", "Financiën") komen letterlijk uit het menu in de zijbalk;
 * ze zijn géén pagina en dus geen knop. Op een telefoon verdwijnen ze — daar
 * telt alleen wat je met één tik kunt bereiken.
 *
 * `page` is bewust `string`: deze module hoort niets van de `Page`-union van
 * main.tsx te weten (zelfde reden als in workspaceTabs.ts — circulaire import).
 */

export type CrumbView = {
  page: string;
  projectId: string | null;
  clientId: string | null;
  galleryId?: string | null;
};

/** Waar een kruimel heen springt. `null` bij een kop of bij de huidige pagina. */
export type CrumbTarget = {
  page: string;
  projectId: string | null;
  clientId: string | null;
  galleryId: string | null;
};

export type Crumb = {
  key: string;
  label: string;
  /** `null` = niet klikbaar (menukop of de pagina waar je al staat). */
  target: CrumbTarget | null;
  kind: 'home' | 'section' | 'page' | 'current';
};

/** De menugroep waar een pagina onder hangt — één op één met navGroups in de zijbalk. */
const PAGE_SECTIONS: Record<string, string> = {
  dashboard: 'Overzicht', gerrie: 'Overzicht',
  calendar: 'Plannen', 'meeting-booking': 'Plannen', time: 'Plannen',
  clients: 'Werk', client: 'Werk',
  projects: 'Werk', project: 'Werk', 'project-planning': 'Werk', weekplanner: 'Werk',
  archive: 'Werk', gallery: 'Werk', tickets: 'Werk',
  quotes: 'Financiën', contracts: 'Financiën', invoices: 'Financiën',
  suppliers: 'Financiën', 'purchase-invoices': 'Financiën', ledger: 'Financiën',
  bank: 'Financiën', assets: 'Financiën', pnl: 'Financiën', 'vat-returns': 'Financiën',
  'corporate-tax': 'Financiën', dga: 'Financiën', shareholders: 'Financiën',
  'fiscal-years': 'Financiën', 'annual-accounts': 'Financiën',
  communication: 'Communicatie', chat: 'Communicatie', marketing: 'Communicatie',
  content: 'Kennis & inzicht', notes: 'Kennis & inzicht', documents: 'Kennis & inzicht',
  stats: 'Kennis & inzicht',
};

/** De pagina één niveau hoger. Wat hier niet in staat, hangt direct onder het dashboard. */
const PAGE_PARENT: Record<string, string> = {
  client: 'clients',
  project: 'projects',
  'project-planning': 'projects',
  weekplanner: 'projects',
  archive: 'projects',
  gallery: 'project',
  notes: 'content',
  documents: 'content',
  'meeting-booking': 'calendar',
};

/** Een ouderpagina bereik je met dezelfde context; alleen wat dieper zat valt weg. */
function parentTarget(parent: string, view: CrumbView): CrumbTarget {
  if (parent === 'project') return { page: 'project', projectId: view.projectId, clientId: null, galleryId: null };
  if (parent === 'client') return { page: 'client', projectId: null, clientId: view.clientId, galleryId: null };
  return { page: parent, projectId: null, clientId: null, galleryId: null };
}

/**
 * Het pad naar boven, van dashboard naar de pagina waar je staat. De laatste
 * kruimel is altijd de huidige pagina en dus nooit klikbaar.
 */
export function breadcrumbTrail(view: CrumbView, data: AppData): Crumb[] {
  const crumbs: Crumb[] = [];

  if (view.page !== 'dashboard') {
    crumbs.push({
      key: 'home',
      label: PAGE_TITLES.dashboard,
      target: { page: 'dashboard', projectId: null, clientId: null, galleryId: null },
      kind: 'home',
    });
  }

  const section = PAGE_SECTIONS[view.page];
  if (section) crumbs.push({ key: `section:${section}`, label: section, target: null, kind: 'section' });

  // Voorouders van boven naar beneden. De keten is kort en eindig (hooguit
  // gallery → project → projects), maar `seen` houdt een typefout in
  // PAGE_PARENT uit een oneindige lus.
  const ancestors: string[] = [];
  const seen = new Set<string>([view.page]);
  let cursor: string | undefined = PAGE_PARENT[view.page];
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.unshift(cursor);
    cursor = PAGE_PARENT[cursor];
  }
  for (const ancestor of ancestors) {
    // Een galerij zonder project heeft geen projectkruimel om op te klikken.
    if (ancestor === 'project' && !view.projectId) continue;
    if (ancestor === 'client' && !view.clientId) continue;
    const target = parentTarget(ancestor, view);
    crumbs.push({
      key: `page:${ancestor}`,
      label: viewTitle({ page: ancestor, projectId: target.projectId, clientId: target.clientId, galleryId: null }, data),
      target,
      kind: 'page',
    });
  }

  crumbs.push({ key: 'current', label: viewTitle(view, data), target: null, kind: 'current' });
  return crumbs;
}

/**
 * Pagina's die het scherm helemaal vullen en hun eigen kop meebrengen: agenda,
 * weekplanner, Gerrie, Berichten en de teamchat. Precies de pagina's die ook de
 * titelbalk overslaan — daar is een kruimelpad geen hulp maar verloren hoogte,
 * en terugnavigeren doe je er met het menu of de tabbalk.
 */
const CHROMELESS_PAGES = new Set(['calendar', 'weekplanner', 'gerrie', 'communication', 'chat']);

/** Heeft deze pagina een kruimelpad? Alleen als er iets te klikken valt. */
export function showsBreadcrumbs(page: string): boolean {
  return !CHROMELESS_PAGES.has(page);
}
