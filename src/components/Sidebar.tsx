import { useEffect, useState } from 'react';
import { Archive, BarChart3, BookOpen, Boxes, Calendar, ChevronDown, ChevronRight, Clock, FileSignature, FileText, Files, FolderOpen, Landmark, LayoutDashboard, Library, Percent, Receipt, Settings, StickyNote, Ticket, TrendingUp, Truck, Users, X } from 'lucide-react';
import type { AppData, Organization, OrganizationRole } from '../types';
import { GlobalSearch, type SearchResult } from './GlobalSearch';
import { Select } from './Ui';

type Page = 'dashboard'|'weekplanner'|'calendar'|'calendar-settings'|'meeting-booking'|'time'|'stats'|'content'|'notes'|'documents'|'clients'|'client'|'projects'|'project-planning'|'tickets'|'quotes'|'contracts'|'invoices'|'suppliers'|'purchase-invoices'|'ledger'|'bank'|'assets'|'pnl'|'vat-returns'|'archive'|'settings'|'project';

const items = [
  ['dashboard', LayoutDashboard, 'Dashboard'],
  ['weekplanner', Calendar, 'Weekplanner'],
  ['calendar', Calendar, 'Kalender'],
  ['time', Clock, 'Uren'],
  ['stats', BarChart3, 'Statistieken'],
  ['content', Library, 'Inhoud'],
  ['clients', Users, 'Klanten'],
  ['projects', FolderOpen, 'Projecten'],
  ['tickets', Ticket, 'Tickets'],
  ['finance', Receipt, 'Financiën'],
  ['settings', Settings, 'Instellingen'],
] as const;

const financePages: Page[] = ['quotes', 'contracts', 'invoices', 'suppliers', 'purchase-invoices', 'ledger', 'bank', 'assets', 'pnl', 'vat-returns'];
const calendarPages: Page[] = ['calendar', 'calendar-settings', 'meeting-booking'];
const projectPages: Page[] = ['projects', 'project', 'project-planning', 'archive'];
const contentPages: Page[] = ['content', 'notes', 'documents'];

export function Sidebar({
  page,
  data,
  organizations,
  activeOrganizationId,
  activeRole,
  onOrganization,
  onNewOrganization,
  onPage,
  onSearchNavigate,
  clientEmailUnread = 0,
  ticketUnread = 0,
  mobileOpen = false,
  onCloseMobile,
}: {
  page: Page;
  data: AppData;
  organizations: Organization[];
  activeOrganizationId: string | null;
  activeRole: OrganizationRole | null;
  onOrganization: (id: string) => void;
  onNewOrganization: () => void;
  onPage: (p: Page) => void;
  onSearchNavigate: (result: SearchResult) => void;
  clientEmailUnread?: number;
  ticketUnread?: number;
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}) {
  const [financeOpen, setFinanceOpen] = useState(() => financePages.includes(page));
  const [projectsOpen, setProjectsOpen] = useState(() => projectPages.includes(page));

  useEffect(() => {
    if (financePages.includes(page)) setFinanceOpen(true);
    if (projectPages.includes(page)) setProjectsOpen(true);
  }, [page]);

  function openCalendarSubPage(target: 'agenda' | 'connections' | 'settings') {
    if (target === 'agenda') {
      onPage('calendar');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#calendar-agenda`);
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('brandcore:calendar-anchor', { detail: { anchor: 'agenda' } }));
      }, 80);
      return;
    }

    onPage('calendar-settings');
    const hash = target === 'connections' ? '#calendar-connections' : '#calendar-settings';
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('brandcore:calendar-anchor', { detail: { anchor: target } }));
    }, 80);
  }

  function openFinancePage(target: 'quotes' | 'contracts' | 'invoices' | 'suppliers' | 'purchase-invoices' | 'ledger' | 'bank' | 'assets' | 'pnl' | 'vat-returns') {
    setFinanceOpen(true);
    onPage(target);
  }

  function openProjectPage(target: 'projects' | 'project-planning' | 'archive') {
    setProjectsOpen(true);
    onPage(target);
  }

  return <aside className={`sidebar${mobileOpen ? ' is-open' : ''}`}>
    <div className="sidebar-head">
      <button type="button" className="sidebar-close" onClick={onCloseMobile} aria-label="Menu sluiten"><X size={20}/></button>
      <div className="app-brand"><div className="brand-icon">R</div><span>ResoFly</span></div>
      <div className="org-switcher">
        <label>Organisatie</label>
        <Select value={activeOrganizationId ?? ''} onChange={event => onOrganization(event.target.value)}>
          {organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
        </Select>
        <div className="org-meta"><span>{activeRole ?? 'geen rol'}</span><button onClick={onNewOrganization}>+ organisatie</button></div>
      </div>
    </div>
    <nav className="sidebar-nav">
      <GlobalSearch data={data} onNavigate={onSearchNavigate} />
      <div className="nav-section"><span>Menu</span></div>
      {items.map(([key, Icon, label]) => {
        const calendarHash = window.location.hash;
        const isProjectsActive = key === 'projects' && projectPages.includes(page);
        const isCalendarActive = key === 'calendar' && calendarPages.includes(page);
        const isFinanceActive = key === 'finance' && financePages.includes(page);
        const isContentActive = key === 'content' && contentPages.includes(page);
        const isActive = key === page || isProjectsActive || isCalendarActive || isFinanceActive || isContentActive;

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
            : key === 'projects'
              ? <button
                  type="button"
                  className={`nav-item nav-item-parent ${isActive ? 'active' : ''}`}
                  aria-expanded={projectsOpen}
                  onClick={() => setProjectsOpen(open => !open)}
                >
                  <Icon size={16}/>
                  <span className="ni-label">{label}</span>
                  <span className="nav-chevron" aria-hidden="true">{projectsOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</span>
                </button>
              : <button className={`nav-item ${isActive ? 'active' : ''}`} onClick={() => onPage(key as Page)}><Icon size={16}/><span className="ni-label">{label}</span>{key === 'clients' && clientEmailUnread > 0 && <span className="nav-badge" title={`${clientEmailUnread} ongelezen bericht${clientEmailUnread === 1 ? '' : 'en'}`}>{clientEmailUnread > 99 ? '99+' : clientEmailUnread}</span>}{key === 'tickets' && ticketUnread > 0 && <span className="nav-badge" title={`${ticketUnread} ticket${ticketUnread === 1 ? '' : 's'} met nieuwe klant-activiteit`}>{ticketUnread > 99 ? '99+' : ticketUnread}</span>}</button>}

          {key === 'calendar' && calendarPages.includes(page) && <div className="nav-submenu">
            <button type="button" className={page === 'calendar' ? 'active' : ''} onClick={() => openCalendarSubPage('agenda')}>Agendaweergave</button>
            <button type="button" className={page === 'calendar-settings' && calendarHash === '#calendar-connections' ? 'active' : ''} onClick={() => openCalendarSubPage('connections')}>Gekoppelde accounts</button>
            <button type="button" className={page === 'calendar-settings' && calendarHash !== '#calendar-connections' ? 'active' : ''} onClick={() => openCalendarSubPage('settings')}>Agenda-instellingen</button>
            <button type="button" className={page === 'meeting-booking' ? 'active' : ''} onClick={() => onPage('meeting-booking')}>Boekingslinks</button>
          </div>}

          {key === 'projects' && projectsOpen && <div className="nav-submenu nav-submenu-projects">
            <button type="button" className={page === 'projects' || page === 'project' ? 'active' : ''} onClick={() => openProjectPage('projects')}><FolderOpen size={13}/><span>Projectoverzicht</span></button>
            <button type="button" className={page === 'project-planning' ? 'active' : ''} onClick={() => openProjectPage('project-planning')}><Calendar size={13}/><span>Planningstimeline</span></button>
            <button type="button" className={page === 'archive' ? 'active' : ''} onClick={() => openProjectPage('archive')}><Archive size={13}/><span>Archief</span></button>
          </div>}

          {key === 'finance' && financeOpen && <div className="nav-submenu nav-submenu-finance">
            <button type="button" className={page === 'quotes' ? 'active' : ''} onClick={() => openFinancePage('quotes')}><FileText size={13}/><span>Offertes</span></button>
            <button type="button" className={page === 'contracts' ? 'active' : ''} onClick={() => openFinancePage('contracts')}><FileSignature size={13}/><span>Contracten</span></button>
            <button type="button" className={page === 'invoices' ? 'active' : ''} onClick={() => openFinancePage('invoices')}><Receipt size={13}/><span>Facturen</span></button>
            <button type="button" className={page === 'suppliers' ? 'active' : ''} onClick={() => openFinancePage('suppliers')}><Truck size={13}/><span>Leveranciers</span></button>
            <button type="button" className={page === 'purchase-invoices' ? 'active' : ''} onClick={() => openFinancePage('purchase-invoices')}><FileText size={13}/><span>Inkoopfacturen</span></button>
            <button type="button" className={page === 'ledger' ? 'active' : ''} onClick={() => openFinancePage('ledger')}><BookOpen size={13}/><span>Grootboek</span></button>
            <button type="button" className={page === 'bank' ? 'active' : ''} onClick={() => openFinancePage('bank')}><Landmark size={13}/><span>Bank</span></button>
            <button type="button" className={page === 'assets' ? 'active' : ''} onClick={() => openFinancePage('assets')}><Boxes size={13}/><span>Activa</span></button>
            <button type="button" className={page === 'pnl' ? 'active' : ''} onClick={() => openFinancePage('pnl')}><TrendingUp size={13}/><span>Winst &amp; verlies</span></button>
            <button type="button" className={page === 'vat-returns' ? 'active' : ''} onClick={() => openFinancePage('vat-returns')}><Percent size={13}/><span>Omzetbelasting</span></button>
          </div>}

          {key === 'content' && contentPages.includes(page) && <div className="nav-submenu nav-submenu-finance">
            <button type="button" className={page === 'content' ? 'active' : ''} onClick={() => onPage('content')}><Library size={13}/><span>Overzicht</span></button>
            <button type="button" className={page === 'notes' ? 'active' : ''} onClick={() => onPage('notes')}><StickyNote size={13}/><span>Notities</span></button>
            <button type="button" className={page === 'documents' ? 'active' : ''} onClick={() => onPage('documents')}><Files size={13}/><span>Documenten</span></button>
          </div>}
        </div>;
      })}
    </nav>
  </aside>;
}
