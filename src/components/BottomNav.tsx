import { Calendar, FolderOpen, LayoutDashboard, Receipt, Users } from 'lucide-react';
import { FULL_PERMISSIONS, type Permissions } from '../lib/permissions';

type Page = 'dashboard'|'gerrie'|'weekplanner'|'calendar'|'calendar-settings'|'meeting-booking'|'time'|'stats'|'content'|'notes'|'documents'|'clients'|'client'|'projects'|'project-planning'|'tickets'|'chat'|'marketing'|'quotes'|'contracts'|'invoices'|'suppliers'|'purchase-invoices'|'ledger'|'bank'|'assets'|'pnl'|'vat-returns'|'corporate-tax'|'dga'|'shareholders'|'fiscal-years'|'annual-accounts'|'archive'|'settings'|'project'|'gallery';

// Welke pagina's onder welke onderbalk-knop vallen (voor de actief-markering).
// Zelfde groepering als de zijbalk, zodat bv. de Grootboek-pagina "Financiën" oplicht.
const financePages: Page[] = ['quotes', 'contracts', 'invoices', 'suppliers', 'purchase-invoices', 'ledger', 'bank', 'assets', 'pnl', 'vat-returns', 'corporate-tax', 'dga', 'shareholders', 'fiscal-years', 'annual-accounts'];
const projectPages: Page[] = ['projects', 'project', 'project-planning', 'archive'];
const calendarPages: Page[] = ['calendar', 'calendar-settings', 'meeting-booking'];
const clientPages: Page[] = ['clients', 'client'];

// De vijf duim-bereikbare kerndestinaties. Alle overige pagina's blijven via het
// hamburgermenu bereikbaar. "Financiën" opent de meest gebruikte financepagina.
const ITEMS: { key: Page; Icon: typeof LayoutDashboard; label: string; group: Page[] }[] = [
  { key: 'dashboard', Icon: LayoutDashboard, label: 'Dashboard', group: ['dashboard'] },
  { key: 'clients', Icon: Users, label: 'Klanten', group: clientPages },
  { key: 'projects', Icon: FolderOpen, label: 'Projecten', group: projectPages },
  { key: 'invoices', Icon: Receipt, label: 'Financiën', group: financePages },
  { key: 'calendar', Icon: Calendar, label: 'Agenda', group: calendarPages },
];

/** Vaste onderbalk (alleen mobiel, zie globals.css ≤760px). Duim-bereikbare
 *  navigatie naar de vijf kerndestinaties; de rest blijft in het hamburgermenu. */
export function BottomNav({ page, onNavigate, permissions = FULL_PERMISSIONS }: { page: Page; onNavigate: (p: Page) => void; permissions?: Permissions }) {
  const activeKey = ITEMS.find(item => item.group.includes(page))?.key ?? null;
  // Modules die voor dit teamlid dichtstaan, verdwijnen ook uit de duimbalk.
  const items = ITEMS.filter(item => permissions.canOpenPage(item.key));
  return (
    <nav className="bottomnav" aria-label="Hoofdnavigatie">
      {items.map(({ key, Icon, label }) => {
        const active = key === activeKey;
        return (
          <button
            key={key}
            type="button"
            className={`bn-item${active ? ' active' : ''}`}
            onClick={() => onNavigate(key)}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={20} strokeWidth={active ? 2.4 : 2} aria-hidden="true" />
            <span className="bn-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
