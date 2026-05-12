import { useEffect, useState } from 'react';
import { Archive, BarChart3, Calendar, ChevronDown, ChevronRight, FileText, FolderOpen, LayoutDashboard, Receipt, Settings, StickyNote, Ticket, Users } from 'lucide-react';
import type { Organization, OrganizationRole } from '../types';

type Page = 'dashboard'|'weekplanner'|'calendar'|'stats'|'notes'|'clients'|'client'|'projects'|'tickets'|'quotes'|'invoices'|'archive'|'settings'|'project';

const items = [
  ['dashboard', LayoutDashboard, 'Dashboard'],
  ['weekplanner', Calendar, 'Weekplanner'],
  ['calendar', Calendar, 'Kalender'],
  ['stats', BarChart3, 'Statistieken'],
  ['notes', StickyNote, 'Notities'],
  ['clients', Users, 'Klanten'],
  ['projects', FolderOpen, 'Projecten'],
  ['tickets', Ticket, 'Tickets'],
  ['finance', Receipt, 'Financiën'],
  ['archive', Archive, 'Archief'],
  ['settings', Settings, 'Instellingen'],
] as const;

const financePages: Page[] = ['quotes', 'invoices'];

export function Sidebar({
  page,
  organizations,
  activeOrganizationId,
  activeRole,
  onOrganization,
  onNewOrganization,
  onPage,
}: {
  page: Page;
  organizations: Organization[];
  activeOrganizationId: string | null;
  activeRole: OrganizationRole | null;
  onOrganization: (id: string) => void;
  onNewOrganization: () => void;
  onPage: (p: Page) => void;
}) {
  const [financeOpen, setFinanceOpen] = useState(() => financePages.includes(page));

  useEffect(() => {
    if (financePages.includes(page)) setFinanceOpen(true);
  }, [page]);

  function openCalendarAnchor(anchor: 'agenda' | 'connections') {
    onPage('calendar');
    const hash = `#calendar-${anchor}`;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('brandcore:calendar-anchor', { detail: { anchor } }));
    }, 80);
  }

  function openFinancePage(target: 'quotes' | 'invoices') {
    setFinanceOpen(true);
    onPage(target);
  }

  return <aside className="sidebar">
    <div className="sidebar-head">
      <div className="app-brand"><div className="brand-icon">B</div><span>BrandCore</span></div>
      <div className="org-switcher">
        <label>Organisatie</label>
        <select value={activeOrganizationId ?? ''} onChange={event => onOrganization(event.target.value)}>
          {organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
        </select>
        <div className="org-meta"><span>{activeRole ?? 'geen rol'}</span><button onClick={onNewOrganization}>+ organisatie</button></div>
      </div>
    </div>
    <nav className="sidebar-nav">
      <div className="nav-section"><span>Menu</span></div>
      {items.map(([key, Icon, label]) => {
        const isProjectsActive = key === 'projects' && page === 'project';
        const isFinanceActive = key === 'finance' && financePages.includes(page);
        const isActive = key === page || isProjectsActive || isFinanceActive;

        return <div className="nav-item-wrap" key={key}>
          {key === 'finance'
            ? <button
                type="button"
                className={`nav-item nav-item-parent ${isActive ? 'active' : ''}`}
                aria-expanded={financeOpen}
                onClick={() => setFinanceOpen(open => !open)}
              >
                <Icon size={16}/>
                <span className="ni-label">{label}</span>
                <span className="nav-chevron" aria-hidden="true">{financeOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span>
              </button>
            : <button className={`nav-item ${isActive ? 'active' : ''}`} onClick={() => onPage(key as Page)}><Icon size={16}/><span className="ni-label">{label}</span></button>}

          {key === 'calendar' && page === 'calendar' && <div className="nav-submenu">
            <button type="button" onClick={() => openCalendarAnchor('agenda')}>Agendaweergave</button>
            <button type="button" onClick={() => openCalendarAnchor('connections')}>Gekoppelde accounts</button>
          </div>}

          {key === 'finance' && financeOpen && <div className="nav-submenu nav-submenu-finance">
            <button type="button" className={page === 'quotes' ? 'active' : ''} onClick={() => openFinancePage('quotes')}><FileText size={13}/><span>Offertes</span></button>
            <button type="button" className={page === 'invoices' ? 'active' : ''} onClick={() => openFinancePage('invoices')}><Receipt size={13}/><span>Facturen</span></button>
          </div>}
        </div>;
      })}
    </nav>
  </aside>;
}
