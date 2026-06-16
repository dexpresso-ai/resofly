import { useEffect, useState } from 'react';
import { Archive, BarChart3, Calendar, ChevronDown, ChevronRight, FileText, Files, FolderOpen, LayoutDashboard, Library, Receipt, Settings, StickyNote, Ticket, Users } from 'lucide-react';
import type { Organization, OrganizationRole } from '../types';
import { Select } from './Ui';

type Page = 'dashboard'|'weekplanner'|'calendar'|'calendar-settings'|'stats'|'content'|'notes'|'documents'|'clients'|'client'|'projects'|'project-planning'|'tickets'|'quotes'|'invoices'|'archive'|'settings'|'project';

const items = [
  ['dashboard', LayoutDashboard, 'Dashboard'],
  ['weekplanner', Calendar, 'Weekplanner'],
  ['calendar', Calendar, 'Kalender'],
  ['stats', BarChart3, 'Statistieken'],
  ['content', Library, 'Inhoud'],
  ['clients', Users, 'Klanten'],
  ['projects', FolderOpen, 'Projecten'],
  ['tickets', Ticket, 'Tickets'],
  ['finance', Receipt, 'Financiën'],
  ['settings', Settings, 'Instellingen'],
] as const;

const financePages: Page[] = ['quotes', 'invoices'];
const calendarPages: Page[] = ['calendar', 'calendar-settings'];
const projectPages: Page[] = ['projects', 'project', 'project-planning', 'archive'];
const contentPages: Page[] = ['content', 'notes', 'documents'];

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

  function openFinancePage(target: 'quotes' | 'invoices') {
    setFinanceOpen(true);
    onPage(target);
  }

  function openProjectPage(target: 'projects' | 'project-planning' | 'archive') {
    setProjectsOpen(true);
    onPage(target);
  }

  return <aside className="sidebar">
    <div className="sidebar-head">
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
              : <button className={`nav-item ${isActive ? 'active' : ''}`} onClick={() => onPage(key as Page)}><Icon size={16}/><span className="ni-label">{label}</span></button>}

          {key === 'calendar' && calendarPages.includes(page) && <div className="nav-submenu">
            <button type="button" className={page === 'calendar' ? 'active' : ''} onClick={() => openCalendarSubPage('agenda')}>Agendaweergave</button>
            <button type="button" className={page === 'calendar-settings' && calendarHash === '#calendar-connections' ? 'active' : ''} onClick={() => openCalendarSubPage('connections')}>Gekoppelde accounts</button>
            <button type="button" className={page === 'calendar-settings' && calendarHash !== '#calendar-connections' ? 'active' : ''} onClick={() => openCalendarSubPage('settings')}>Agenda-instellingen</button>
          </div>}

          {key === 'projects' && projectsOpen && <div className="nav-submenu nav-submenu-projects">
            <button type="button" className={page === 'projects' || page === 'project' ? 'active' : ''} onClick={() => openProjectPage('projects')}><FolderOpen size={13}/><span>Projectoverzicht</span></button>
            <button type="button" className={page === 'project-planning' ? 'active' : ''} onClick={() => openProjectPage('project-planning')}><Calendar size={13}/><span>Planningstimeline</span></button>
            <button type="button" className={page === 'archive' ? 'active' : ''} onClick={() => openProjectPage('archive')}><Archive size={13}/><span>Archief</span></button>
          </div>}

          {key === 'finance' && financeOpen && <div className="nav-submenu nav-submenu-finance">
            <button type="button" className={page === 'quotes' ? 'active' : ''} onClick={() => openFinancePage('quotes')}><FileText size={13}/><span>Offertes</span></button>
            <button type="button" className={page === 'invoices' ? 'active' : ''} onClick={() => openFinancePage('invoices')}><Receipt size={13}/><span>Facturen</span></button>
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
