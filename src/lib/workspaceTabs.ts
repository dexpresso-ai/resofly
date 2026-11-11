import type { AppData } from '../types';
import { aiReportTitle } from './aiReportTitles.ts';

/** Menselijke titel per pagina — gedeeld door de topbar-titel én het tabblad-label
 *  in de tabbalk. `page` is bewust `string` zodat deze module geen `Page`-union hoeft
 *  te importeren (voorkomt een circulaire import met main.tsx). */
export const PAGE_TITLES: Record<string, string> = {
  dashboard: 'Dashboard', gerrie: 'Gerrie', weekplanner: 'Weekplanner', calendar: 'Agenda',
  'meeting-booking': 'Boekingslinks',
  time: 'Uren', stats: 'Rapportages', report: 'Rapportage', content: 'Inhoud', notes: 'Notities',
  documents: 'Documenten', clients: 'Klanten', client: 'Klant', communication: 'Berichten', projects: 'Projecten',
  'project-planning': 'Projectplanning', tickets: 'Tickets', chat: 'Teamchat',
  marketing: 'Marketing', quotes: 'Offertes', contracts: 'Contracten', invoices: 'Facturen',
  suppliers: 'Leveranciers', 'purchase-invoices': 'Inkoopfacturen', ledger: 'Grootboek',
  bank: 'Bank', assets: 'Activa', prepaid: 'Vooruitbetaald', pnl: 'Winst & verlies', 'vat-returns': 'Omzetbelasting', 'corporate-tax': 'Vennootschapsbelasting', dga: 'DGA', shareholders: 'Aandeelhouders', owners: 'Eigen vermogen',
  'fiscal-years': 'Boekjaren', 'annual-accounts': 'Jaarrekening',
  archive: 'Archief', settings: 'Instellingen', project: 'Project',
  gallery: 'Galerij',
};

/** Titel voor een view: projectnaam/klantnaam waar van toepassing, anders de paginanaam. */
export function viewTitle(
  view: { page: string; projectId: string | null; clientId: string | null; galleryId?: string | null; statsReportId?: string | null },
  data: AppData,
): string {
  // Een rapportage van Gerrie: zijn eigen titel, zodat twee open rapportages uit elkaar te houden zijn.
  if (view.page === 'report') return aiReportTitle(view.statsReportId) ?? 'Rapportage';
  if (view.page === 'project') return data.projects.find(p => p.id === view.projectId)?.name ?? 'Project';
  if (view.page === 'client') return data.clients.find(c => c.id === view.clientId)?.name ?? 'Klant';
  // De galerijtitel zegt méér dan "Galerij" zodra er twee openstaan.
  if (view.page === 'gallery') return data.galleries.find(g => g.id === view.galleryId)?.title ?? 'Galerij';
  // Bij een vof, maatschap of cv heet deze pagina in het menu en in de kop
  // "Vennoten"; het tabblad en het kruimelpad zeggen hetzelfde.
  if (view.page === 'owners' && ['vof', 'maatschap', 'cv'].includes(data.companySettings?.legal_form ?? 'eenmanszaak')) return 'Vennoten';
  return PAGE_TITLES[view.page] ?? view.page;
}

/** Het deel van een tabblad dat over herladen heen bewaard blijft (routes, geen
 *  transiënte editor-/formulierstaat). */
export type PersistedTab = {
  page: string;
  projectId: string | null;
  clientId: string | null;
  statsReportId: string | null;
  galleryId: string | null;
};

/** Open tabbladen worden per organisatie onthouden. */
function tabsStorageKey(organizationId: string): string {
  return `brandcore.tabs.${organizationId}`;
}

export function savePersistedTabs(organizationId: string, tabs: PersistedTab[], activeIndex: number): void {
  try {
    localStorage.setItem(tabsStorageKey(organizationId), JSON.stringify({ tabs, activeIndex }));
  } catch {
    /* private mode / storage geweigerd — dan simpelweg niet onthouden */
  }
}

export function loadPersistedTabs(organizationId: string): { tabs: PersistedTab[]; activeIndex: number } | null {
  try {
    const raw = localStorage.getItem(tabsStorageKey(organizationId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeIndex?: unknown };
    if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
    const tabs = parsed.tabs
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map(t => ({
        page: typeof t.page === 'string' ? t.page : 'dashboard',
        projectId: typeof t.projectId === 'string' ? t.projectId : null,
        clientId: typeof t.clientId === 'string' ? t.clientId : null,
        statsReportId: typeof t.statsReportId === 'string' ? t.statsReportId : null,
        galleryId: typeof t.galleryId === 'string' ? t.galleryId : null,
      }));
    if (!tabs.length) return null;
    const activeIndex = typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0;
    return { tabs, activeIndex };
  } catch {
    return null;
  }
}
