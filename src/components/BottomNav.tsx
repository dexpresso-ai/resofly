import { Calendar, FolderKanban, FolderOpen, LayoutDashboard, Receipt, Sunrise, Users, Wallet } from 'lucide-react';
import { FULL_PERMISSIONS, type Permissions } from '../lib/permissions';

type Page = 'dashboard'|'gerrie'|'weekplanner'|'calendar'|'meeting-booking'|'time'|'stats'|'content'|'notes'|'documents'|'clients'|'client'|'communication'|'projects'|'project-planning'|'tickets'|'chat'|'marketing'|'quotes'|'contracts'|'invoices'|'suppliers'|'purchase-invoices'|'ledger'|'bank'|'assets'|'pnl'|'vat-returns'|'corporate-tax'|'dga'|'shareholders'|'fiscal-years'|'annual-accounts'|'archive'|'settings'|'project'|'gallery';

// Welke pagina's onder welke onderbalk-knop vallen (voor de actief-markering).
// Zelfde groepering als de zijbalk, zodat bv. de Grootboek-pagina "Financiën" oplicht.
const financePages: Page[] = ['quotes', 'contracts', 'invoices', 'suppliers', 'purchase-invoices', 'ledger', 'bank', 'assets', 'pnl', 'vat-returns', 'corporate-tax', 'dga', 'shareholders', 'fiscal-years', 'annual-accounts'];
const projectPages: Page[] = ['projects', 'project', 'project-planning', 'weekplanner', 'archive'];
const calendarPages: Page[] = ['calendar', 'meeting-booking'];
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

// Stroom: de dock. Dezelfde plekken als de rail (Vandaag, Werk, Agenda, Geld)
// met in het midden het orbje van Gerrie.
const DOCK: { key: Page; Icon: typeof LayoutDashboard; label: string; group: Page[] }[] = [
  { key: 'dashboard', Icon: Sunrise, label: 'Vandaag', group: ['dashboard'] },
  { key: 'clients', Icon: FolderKanban, label: 'Werk', group: [...clientPages, ...projectPages, 'tickets'] },
  { key: 'calendar', Icon: Calendar, label: 'Agenda', group: [...calendarPages, 'time'] },
  { key: 'invoices', Icon: Wallet, label: 'Geld', group: financePages },
];

/** Vaste onderbalk (alleen mobiel, zie globals.css ≤760px). Duim-bereikbare
 *  navigatie naar de vijf kerndestinaties; de rest blijft in het hamburgermenu.
 *  In Stroom (`dock`) een zwevende glazen dock met Gerrie in het midden. */
export function BottomNav({ page, onNavigate, permissions = FULL_PERMISSIONS, dock = false, onAsk }: {
  page: Page;
  onNavigate: (p: Page) => void;
  permissions?: Permissions;
  dock?: boolean;
  /** Stroom: het orbje in het midden opent Gerrie. Zonder: geen orbje. */
  onAsk?: () => void;
}) {
  const list = dock ? DOCK : ITEMS;
  const activeKey = list.find(item => item.group.includes(page))?.key ?? null;
  // Modules die voor dit teamlid dichtstaan, verdwijnen ook uit de duimbalk.
  const items = list.filter(item => permissions.canOpenPage(item.key));
  const half = Math.ceil(items.length / 2);
  const button = ({ key, Icon, label }: (typeof list)[number]) => {
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
  };
  return (
    <nav className={`bottomnav${dock ? ' sl-dock' : ''}`} aria-label="Hoofdnavigatie">
      {dock && onAsk
        ? <>
            {items.slice(0, half).map(button)}
            <button type="button" className="bn-item bn-orb" onClick={onAsk} aria-label="Vraag Gerrie">
              <span className="zorb live" aria-hidden="true" />
              <span className="bn-label">Gerrie</span>
            </button>
            {items.slice(half).map(button)}
          </>
        : items.map(button)}
    </nav>
  );
}
